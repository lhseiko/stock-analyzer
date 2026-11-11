# 核心业务逻辑（lib/） · 第 1 卷

> 共 50 个文件，本卷约 17892 行


---

## `lib\ai\augmentStock.js`  ·  432 行

~~~js
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

~~~

---

## `lib\ai\cache.js`  ·  63 行

~~~js
/**
 * lib/ai/cache.js —— aiAugment 领域子模块：只读缓存层（拆分重构 202609）
 * ----------------------------------------------------------------
 * 循环依赖切割点：deepAnalysis 主流程对 readCache 的唯一依赖（原 L13 顶层 require('./aiAugment')）
 * 改为 lib/deep/pipeline.js 静态 require 本模块，加载期环消失。
 *
 * 版本常量随缓存函数迁入（版本号语义本就是「缓存门控」）：
 *   - EARNINGS_PROMPT_VERSION：readEarningsCache 门控（earnings.js 反向 require）
 *   - VALUATION_VER：readValuationCache 门控（valuation.js 反向 require）
 */
const fs = require('fs');
const path = require('path');
const { CACHE_DIR, SEMI_STATIC_TTL_MS } = require('./config');

// 只读接口读取已存缓存（不联网、不限 TTL），供前端打开个股页时自动展示
function readCache(symbol, suffix) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}${suffix || ''}.json`);
  if (!fs.existsSync(cacheFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return null;
  }
}

// 财报解读缓存读取（供短期判断因子复用）：不再因 promptVersion 不符直接丢弃——
// summary 文本仍可用，因子侧在缺 earningsSignal 时会按文本启发式兜底，确保旧缓存也能正确判定多空（任务 J）。
function readEarningsCache(symbol) {
  const cached = readCache(symbol, '_earnings');
  if (!cached) return null;
  if (cached.promptVersion !== EARNINGS_PROMPT_VERSION) cached.stale = true;
  return cached;
}

// 20260906：AI 估值 GET 只读缓存（版本+TTL 门控，不校验 factAnchor 以免打开页面拉取东财数据）。
// 供前端打开个股时自动展示已存结果；版本过期/无缓存返回 null——前端保持规则版，
// 用户点「✨ AI 估值」（force=true）才联网重算。此前 GET 走 analyzeValuation(force:false)
// 会在缓存 ver 过期时静默触发 LLM 重算：既违背单按钮口径（打开不消耗额度），失败时前端又无感知。
function readValuationCache(symbol) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}_valuation.json`);
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!cached || cached.ver !== VALUATION_VER) return null;
    if (Date.now() - new Date(cached.date).getTime() >= SEMI_STATIC_TTL_MS) return null;
    return {
      symbol: cached.symbol, stockName: cached.stockName, industry: cached.industry,
      content: cached.content, date: cached.date, model: cached.model, mode: cached.mode,
      localDataUsed: cached.localDataUsed, factAnchor: cached.factAnchor, ver: cached.ver,
    };
  } catch { return null; }
}

// ---------- 缓存版本常量（随对应 read*Cache 迁入，语义为「缓存门控」） ----------

// prompt 有变时递增此版本号，使旧缓存自动失效重拉（避免 7 天 TTL 内继续展示旧解读口径）
const EARNINGS_PROMPT_VERSION = '20261023h'; // 20261023h：修复「最新报告期窗口」——三季报 10 月披露即取，不再等到 11 月（原 getLatestPartialQuarterDates 按月份 q=2 只请求 03-31/06-30，导致三季报已出仍解读半年报，用户 2026-10-23 洲明科技 300232 报障）；同时强制失效旧的中报缓存，前端无 summary 时自动触发重新解读。20260909i：中报环比口径改为「Q2单季 vs Q1单季」（严禁「上半年累计 vs 上一年年报」跨口径比较）；强制逐条「已核实/未核实」来源标注；雪球/股吧/论坛/自媒体降级（禁止作为数字依据）；注入系统确定性核算的单季事实块。20260906c：恢复详细 8 维度输出（用户分工：深度分析卡=详细解读），保留 ≤1000 字精简提炼；行情判断小卡改为只引用 verdict 精简结论（sameDayJudgment 侧）。20260906b（4 行极简版）废弃。20260906a：取消 800 字上限。20260904c：修正 reportPeriod 提取 + summary 无条件剥离「报告期/标的」行；联网 AI 主路径 + 身份确认（防串公司）保持不变

// 缓存版本：v4=三表全注入+财报解读复用（旧缓存含 AI 自搜错误数据，强制失效重算）；v3=本地事实+规则模型交叉验证
const VALUATION_VER = 'v4';

module.exports = { EARNINGS_PROMPT_VERSION, VALUATION_VER, readCache, readEarningsCache, readValuationCache };

~~~

---

## `lib\ai\companyDeep.js`  ·  461 行

~~~js
/**
 * lib/ai/companyDeep.js —— 公司深度分析（CFA 框架统一模块，20260914f 新建）
 * --------------------------------------------------------------------------
 * 背景：原「公司综合介绍（分析①）+ 供应链与成本（分析②）+ 主要产品&客户（分析③）」
 * 三个独立 AI 模块，合并为**单一**统一分析引擎，严格遵循用户投喂的
 * 「资深证券分析师（CFA）执行引擎」框架：
 *   一、公司一句话定位与投资摘要
 *   二、公司基本面画像（基础档案 / 产品服务与图片位 / 文化品牌 / 专利创新 / 实控人 / 近10年重大事件时间线）
 *   三、供应链与成本（产业链定位 / 主要原材料与供应商 / 成本传导与敏感性 / 成本控制方法 / 成本风险结论）
 *   四、客户与竞争（主要客户与集中度 / 竞争对手与格局图谱 / 对手价格变动影响模拟 / 竞争风险与定价权结论）
 *   五、跨模块联动结论
 *   六、风险提示
 *   七、数据来源、日期与缺失说明
 *
 * 全局规则（写进 prompt，由 LLM 遵守；确定性字段由代码兜底）：
 *   1) 数据优先级：年报/公告/ESG/交易所/监管 > 权威财经媒体/行业库/券商研报 > 第三方网站；关键结论标注来源与日期。
 *   2) 时间范围：财务取近5年、重大事件取近10年、实时数据标注抓取日期。
 *   3) 缺失写「未披露」/「未检索到」；无法确认写「待核实」；不得编造。
 *   4) 配图：有图片能力则插图；否则输出「图片位：…；检索关键词：…；建议来源：…」。
 *   5) 输出：先结论后论据、先定量后定性、风险单列、区分「事实」与「推断」。
 *   6) 超行业正常范围的指标须结合行业分位修正，不能只用绝对阈值。
 *
 * 架构原则（与项目一致）：
 *   - 代码权威：确定性阈值（成本敏感型 50%、传导弱 0.5、传导强 0.8、客户集中 30%、前五 50%）
 *     由代码在校验层判定并写入 flags，不交由 LLM 拍脑袋；
 *   - **主路径固定走联网模型（modelWeb）**：信息分析天生依赖大量 F10 之外的资料
 *     （成立/上市日期、企业文化、专利、实控人持股、近10年重大事件、前五大客户、竞争对手），
 *     本地 F10 事实作为**补充上下文**注入（确定的数字不必让模型猜）；
 *   - 联网失败且本地事实可用时降级为本地模型纯推理（保证不空白）；
 *   - **缓存永久有效**：简介类资料更新频率极低，仅当 force（用户点「重新搜索」）才重跑；
 *   - 图片走 ai/images.attachImage（AI 直链优先，Commons 兜底）。
 *   - 20260914h：由「本地优先双模式 + TTL 过期」改为「固定联网 + 永久缓存」。
 */
const fs = require('fs');
const path = require('path');
const { getCompanyProfile } = require('../shareholderData');
const factStore = require('../factStore');
const { CACHE_DIR, PROVIDERS, ensureDirs, loadConfig } = require('./config');
const { callLLM, pickModelFor, pickLocalSummaryModel, guardCtxBudget, extractJson } = require('./llm');
const { attachImage } = require('./images');

// ============ 统一 system prompt（联网模式）============
const DEEP_SYSTEM_PROMPT = `你是一名资深证券分析师，具备 CFA 资质，有 10 年以上 A 股全行业公司研究经验，擅长公司基本面、产业链、成本传导、竞争格局和重大事件研究。你现在是「股票投资分析 AI 工作台」的执行引擎，需按固定框架完成分析。

【全局规则 · 必须严格遵守】
1) 数据优先级：公司年报、公告、ESG 报告、交易所披露、监管文件优先；其次权威财经媒体、行业数据库、券商研报；最后第三方网站。每个关键结论必须标注来源与日期。
2) 时间范围：财务数据优先取近 5 年，重大事件取近 10 年，实时数据必须标注抓取日期。
3) 数据缺失时明确写「未披露」或「未检索到」，不得编造。无法确认的内容标注「待核实」。
4) 配图：你不具备直接插图能力，因此每个需要配图的位置输出「图片位：图片主题；检索关键词：…；建议来源：公司官网、年报、ESG报告、行业数据库、财经网站」。产品/服务与竞争对手可额外给出 imageUrl（图片直链，找不到填 ""）与 imageQuery（搜图关键词）。
5) 输出规则：先结论后论据，先定量后定性，风险提示单独列出。所有判断要区分「事实」与「推断」（用「【事实】」「【推断】」前缀标注）。
6) 若某项指标超过行业正常范围，要结合行业分位修正，不能只用绝对阈值。

【只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记】
{
 "oneLiner":"公司一句话定位",
 "investmentSummary":"投资摘要（3-5句，含多空要点与核心结论，先结论后论据）",
 "profile":{
   "basicInfo":{
     "fullName":"公司全称","officeLocation":"办公地点(城市+区/具体地址)",
     "registeredAddress":"注册地址","foundedDate":"成立日期(YYYY-MM-DD)","listedDate":"上市日期(YYYY-MM-DD)",
     "industry":"所属行业","employeeCount":"员工人数(最新年报)","execCount":"高管人数",
     "execAvgSalary":"高管平均薪酬(按高管薪酬总额÷高管人数；若总额未披露则用前三名高管薪酬均值替代)",
     "execSalaryBasis":"薪酬口径说明(如'高管薪酬总额÷高管人数'或'前三名高管均值替代')"
   },
   "productsServices":[{"name":"主营产品/服务名","content":"服务内容","revenueShare":"收入占比(如'35.5%'或'未披露')","scenario":"应用场景","customerType":"主要客户类型","imageUrl":"图片直链(找不到填\"\")","imageQuery":"搜图关键词","imageNote":"图片位：图片主题；检索关键词：…；建议来源：…"}],
   "culture":{"mission":"经营宗旨","culture":"企业文化","vision":"公司愿景","values":"核心价值观","brands":["旗下知名品牌"],"trademarks":"商标情况"},
   "patents":{"total":"专利总数","inventionRatio":"发明专利占比","yoy3y":"近3年专利年均增速","industryPercentile":"行业分位数(无法获取则填'行业分位未获取')"},
   "controller":{"hasController":"有/无","name":"实控人姓名或'国有控股'/'股权分散'/'无实际控制人'","holdingPct":"持股比例","controlPath":"控制路径","concertParties":["一致行动人"],"background":"背景","pledge":"质押情况","governanceRisk":"潜在治理风险","equityStructure":"若无实控人则说明股权结构特征"},
   "majorEvents":[{"date":"YYYY-MM 或 YYYY","category":"公司治理/经营/资本/风险/行业政策(五类之一)","title":"事件标题","desc":"事件简述","impactLevel":"高/中/低","impactOn":"对业绩/估值/股价的可能影响"}]
 },
 "supplyChain":{
   "chainPosition":"上游/中游/下游(可括号说明,如'中游(电池制造)')",
   "positionBasis":"判断依据(原材料依赖度/产品用途/客户类型/毛利率特征/议价能力)",
   "materials":[{"name":"主要原材料/服务名","desc":"在经营中的作用","supplierTop5":"前五大供应商名称(各+采购占比,无则'未披露')","procureShare":"采购占比","supplyContent":"供应内容","stability":"合作稳定性","imageUrl":"","imageQuery":"","imageNote":"图片位：…"}],
   "directMaterialRatio":"直接材料占营业成本比例(如'58%')",
   "conductionCoef":0.0,
   "grossMarginSensitivity":0.0,
   "sensitivityMatrix":[{"priceChange":"+5%","grossMargin":"对毛利率影响","netProfit":"对净利润影响","cashFlow":"对现金流影响"},{"priceChange":"-5%"},{"priceChange":"+10%"},{"priceChange":"-10%"},{"priceChange":"+20%"},{"priceChange":"-20%"},{"priceChange":"+30%"},{"priceChange":"-30%"}],
   "sensitivityNote":"敏感性假设说明",
   "costControl":[{"type":"纵向整合/集中采购/供应商结构优化/替代材料/套期保值/工艺改进/规模效应/废料回收(八类之一)","practice":"具体做法","costImpact":"对成本的影响"}],
   "costRiskLevel":"高/中/低",
   "costRiskReason":"成本风险等级理由"
 },
 "competition":{
   "customers":[{"name":"前五大客户名或客户类型","revenueShare":"收入占比(如'32%')","concentration":"客户集中度","industryPercentile":"行业分位数(无则'行业分位未获取')","imageUrl":"","imageQuery":"","imageNote":"图片位：…"}],
   "competitors":[{"name":"竞争对手名","marketShare":"市场份额","productOverlap":"产品重叠度","customerOverlap":"客户重叠度","regionOverlap":"区域重叠度","priceStrategy":"价格策略标签(成本领先/差异化/聚焦细分)","imageUrl":"","imageQuery":"","imageNote":"图片位：…"}],
   "landscapeGraph":"竞争格局图谱文字描述(以本公司为核心节点，展示主要竞争对手、产品重叠关系、客户重叠关系、价格策略标签)",
   "priceWarSimulation":{
     "homogeneity":"产品同质化程度(高/中/低)",
     "switchingCost":"客户转换成本(高/中/低)",
     "brandPremium":"品牌溢价(高/中/低)",
     "channelStickiness":"渠道粘性(高/中/低)",
     "scenarios":[{"strategy":"维持原价","revenue":"收入变化","grossMargin":"毛利率变化","netProfit":"净利润变化","marketShare":"市场份额变化"},{"strategy":"跟随降价"},{"strategy":"部分降价"}]
   },
   "competitionRiskLevel":"高/中/低",
   "pricingPower":"公司定价权判断(强/中/弱+理由)",
   "riskSignals":["建议关注的风险信号"]
 },
 "linkage":"跨模块联动结论(核心原材料→供应链；成本传导弱→价格战风险；对手扩产/降价/并购/技术突破→本公司竞争预警；监管处罚/实控人变更/重大诉讼/退市风险→置顶提示)",
 "topWarning":"需置顶提示的重大风险(若无则填'无')",
 "riskNotes":["风险提示（单独列出，含触发条件）"],
 "dataSources":[{"item":"结论/数据项","source":"来源(年报/公告/ESG/交易所/研报/财经网站等)","date":"日期"}],
 "missingNotes":["数据来源、日期与缺失说明：逐项说明哪些字段未披露/未检索到/待核实"]
}

【框架要求】
第一，公司基本面画像：抓取基础档案（全称/办公地点/注册地址/成立日期/上市日期/所属行业/员工人数/高管人数/高管平均薪酬）；介绍产品服务（主营产品、服务内容、收入占比、应用场景、主要客户类型）并给图片位；介绍经营宗旨、企业文化、愿景、核心价值观、知名品牌与商标；抓取专利信息（总数/发明专利占比/近3年增速/行业分位）；分析实控人（有无、姓名、持股比例、控制路径、一致行动人、背景、质押、治理风险）；建立近10年重大事件雷达（按公司治理/经营/资本/风险/行业政策五类，每条标时间、类型、影响程度高/中/低及对业绩估值股价的影响）。
第二，供应链与成本：先判断产业链上/中/下游（依据原材料依赖度、产品用途、客户类型、毛利率特征、议价能力）；找出主要原材料/服务对应供应商（前五大名称、采购占比、供应内容、合作稳定性）并给图片位；分析原材料价格变动对营业成本的影响（直接材料占营业成本比例→成本传导系数→毛利率敏感系数→敏感性矩阵，至少覆盖价格变动 ±5%/±10%/±20%/±30% 情景，说明对毛利率、净利润、现金流的影响）；分析成本控制方法（纵向整合/集中采购/供应商结构优化/替代材料/套期保值/工艺改进/规模效应/废料回收）；输出成本风险等级高/中/低及理由。
第三，客户与竞争格局：找出主要客户（前五大名称、收入占比、客户集中度、行业分位）并给图片位；找出主要竞争对手（按市场份额/产品重叠度/客户重叠度/区域重叠度识别）并给配图介绍；给出竞争格局图谱（以本公司为核心节点）；分析竞争对手产品价格变动对公司营业收入的影响（先判断同质化程度、客户转换成本、品牌溢价、渠道粘性，再模拟维持原价/跟随降价/部分降价三种策略下的收入、毛利率、净利润、市场份额变化）；输出竞争风险等级、公司定价权判断、建议关注的风险信号。
跨模块联动：画像中识别出的核心原材料自动进入供应链分析；成本传导弱的公司在竞争分析中重点检查价格战风险；竞争对手出现扩产/降价/并购/技术突破等事件时自动触发竞争风险预警；近10年重大事件中若出现监管处罚/实控人变更/重大诉讼/退市风险，必须在最终摘要中置顶提示。

补充要求：
- 敏感性矩阵的 8 个情景（±5%/±10%/±20%/±30%）必须齐全，priceChange 字段写如 "+5%"、"-10%"。
- costControl.type 必须从八类中选，priceWarSimulation.scenarios 的三种策略必须齐全。
- 若为金融/服务类公司（银行、保险、证券、信托等）：materials 改为关键成本项（资金成本/付息压力/人力成本/风控合规成本/赔付成本），suppliers 改为业务合作渠道或机构；chainPosition 按「资金端—金融中介—客户端」定位；此类公司高负债属经营常态，不要描述为风险。
- 不确定的数字一律写「未披露」「未检索到」或「待核实」，严禁编造。`;

// ============ 统一 system prompt（本地模式，不联网、零联网费）============
const DEEP_LOCAL_SYSTEM_PROMPT = `你是一名资深证券分析师（CFA 资质，10 年以上 A 股研究经验）。你没有联网能力，也不需要联网。下方「本地事实」由系统从东方财富 F10 预先下载（公司概况、主营业务、主要产品、主营构成明细含营收占比/毛利率/成本占比），是本轮分析唯一允许引用的事实来源。

【全局规则】先结论后论据，先定量后定性，风险单列；区分「事实」与「推断」；凡本地事实未提供的字段一律填「未披露」或「未检索到」，严禁用训练记忆编造（尤其专利数、重大事件、高管薪酬、前五大供应商/客户、竞争对手、价格、行业分位）。

【只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记】，结构与联网模式完全一致的以下字段（未提供的用「未披露」/空数组，但结构必须在）：
{"oneLiner":"","investmentSummary":"","profile":{"basicInfo":{"fullName":"","officeLocation":"","registeredAddress":"未披露","foundedDate":"未披露","listedDate":"未披露","industry":"","employeeCount":"","execCount":"未披露","execAvgSalary":"未披露","execSalaryBasis":"未披露"},"productsServices":[{"name":"来自主营构成","content":"","revenueShare":"引用真实占比","scenario":"未披露","customerType":"未披露","imageUrl":"","imageQuery":"搜图关键词(品牌+产品)","imageNote":"图片位：…"}],"culture":{"mission":"未披露","culture":"未披露","vision":"未披露","values":"未披露","brands":[],"trademarks":"未披露"},"patents":{"total":"未披露","inventionRatio":"未披露","yoy3y":"未披露","industryPercentile":"行业分位未获取"},"controller":{"hasController":"未披露","name":"控股股东(本地事实提供才填)","holdingPct":"未披露","controlPath":"未披露","concertParties":[],"background":"未披露","pledge":"未披露","governanceRisk":"未披露","equityStructure":""},"majorEvents":[]},"supplyChain":{"chainPosition":"上/中/下游(据行业与业务性质判断并给理由)","positionBasis":"基于毛利率与主营构成的推断","materials":[{"name":"成本占比最高的业务/成本项","desc":"","supplierTop5":"未披露","procureShare":"未披露","supplyContent":"","stability":"未披露","imageUrl":"","imageQuery":"","imageNote":"图片位：…"}],"directMaterialRatio":"未披露","conductionCoef":0,"grossMarginSensitivity":0,"sensitivityMatrix":[],"sensitivityNote":"本地事实不含原材料价格，无法构建敏感性矩阵；建议联网分析","costControl":[{"type":"从八类中选","practice":"","costImpact":""}],"costRiskLevel":"中","costRiskReason":""},"competition":{"customers":[],"competitors":[],"landscapeGraph":"未披露","priceWarSimulation":{"homogeneity":"未披露","switchingCost":"未披露","brandPremium":"未披露","channelStickiness":"未披露","scenarios":[]},"competitionRiskLevel":"中","pricingPower":"未披露","riskSignals":[]},"linkage":"","topWarning":"","riskNotes":[],"dataSources":[{"item":"公司概况/主营构成","source":"东方财富 F10","date":""}],"missingNotes":[]}

要求：productsServices 从主营构成选 3-6 个核心业务，revenueShare 必须引用真实占比数字；financial/服务类公司按金融服务框架；只输出 JSON。`;

// ============ 确定性校验层（代码权威：阈值由代码判定，不交给 LLM）============
function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const m = String(v).replace(/[,，%％\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * 对 LLM 返回的结构做确定性校验与兜底，产出 flags（代码判定，非 LLM）。
 * 规则来自用户框架：
 *   - 直接材料占营业成本 > 50%  → 成本敏感型公司
 *   - 成本传导系数 < 0.5        → 成本传导弱，毛利率容易受挤压
 *   - 成本传导系数 > 0.8        → 成本传导强，具备较强提价能力
 *   - 第一大客户收入占比 > 30%  → 客户集中度风险高
 *   - 前五大客户合计 > 50%      → 收入依赖风险高
 *   - 重大事件含监管处罚/实控人变更/重大诉讼/退市风险 → 置顶提示
 */
function validateDeep(parsed) {
  const flags = [];
  const sc = (parsed && parsed.supplyChain) || {};
  const comp = (parsed && parsed.competition) || {};

  const dmr = toNum(sc.directMaterialRatio);
  if (dmr != null && dmr > 50) flags.push({ kind: 'cost-sensitive', level: 'warn', text: `成本敏感型公司（直接材料占营业成本 ${dmr}% > 50%）` });

  const cc = toNum(sc.conductionCoef);
  if (cc != null && cc < 0.5) flags.push({ kind: 'weak-conduction', level: 'warn', text: `成本传导弱（系数 ${cc} < 0.5），毛利率容易受挤压，需重点关注价格战风险` });
  else if (cc != null && cc > 0.8) flags.push({ kind: 'strong-conduction', level: 'good', text: `成本传导强（系数 ${cc} > 0.8），具备较强提价能力` });

  const customers = Array.isArray(comp.customers) ? comp.customers : [];
  const firstShare = customers.length ? toNum(customers[0].revenueShare) : null;
  if (firstShare != null && firstShare > 30) flags.push({ kind: 'customer-concentration', level: 'warn', text: `客户集中度风险高（第一大客户收入占比 ${firstShare}% > 30%）` });
  const shareNums = customers.map(c => toNum(c.revenueShare)).filter(v => v != null);
  if (shareNums.length) {
    const sum = shareNums.reduce((a, b) => a + b, 0);
    if (sum > 50) flags.push({ kind: 'revenue-dependence', level: 'warn', text: `收入依赖风险高（前五大客户合计 ${Math.round(sum * 10) / 10}% > 50%）` });
  }

  // 置顶风险：近10年重大事件中的红线事件
  const events = ((parsed && parsed.profile && parsed.profile.majorEvents) || []);
  const redlineRe = /监管处罚|行政处罚|处罚|实控人变更|控制权变更|重大诉讼|诉讼|退市|退市风险|立案|问询|违规|被查/;
  const redlines = events.filter(e => redlineRe.test(String((e && e.title) || '') + String((e && e.desc) || '')));
  if (redlines.length) {
    const t = redlines.slice(0, 3).map(e => `${e.date || ''}${(e.date && e.title) ? ' ' : ''}${e.title || ''}`).join('；');
    flags.push({ kind: 'redline', level: 'danger', text: `须置顶提示：近10年重大事件包含监管/治理红线（${t}）` });
  }
  return flags;
}

// 合理性检查：敏感性矩阵缺失/不全时，用直接材料占比与传导系数给出确定性兜底说明
const EXPECTED_PRICE_CHANGES = ['+5%', '-5%', '+10%', '-10%', '+20%', '-20%', '+30%', '-30%'];
function normalizeSensitivityMatrix(sc) {
  const arr = Array.isArray(sc.sensitivityMatrix) ? sc.sensitivityMatrix : [];
  const byKey = {};
  arr.forEach(r => { if (r && r.priceChange) byKey[String(r.priceChange).replace(/\s/g, '')] = r; });
  const out = EXPECTED_PRICE_CHANGES.map(pc => byKey[pc] || { priceChange: pc, grossMargin: '未提供', netProfit: '未提供', cashFlow: '未提供' });
  return out;
}

async function analyzeCompanyDeep({ symbol, stockName, industry, force, companyName, companyType }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_companyDeep.json`);
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
  // 20260914h：信息分析改为「固定联网模型 + 永久缓存」——
  //   ① 联网模型负责 F10 未覆盖的大量字段（成立/上市日期、企业文化、专利、实控人持股、
  //      近10年重大事件、前五大客户、竞争对手等）；
  //   ② 本地 F10 事实（全称/行业/员工数/主营构成精确数字）作为**补充上下文**一并注入，
  //      让联网模型不必猜这些本可确定的数字；
  //   ③ 缓存永久有效（简介类资料更新频率极低），仅当 force（用户点「重新搜索」）才重跑。
  const localCtx = await factStore.buildCompanyFactsContext(symbol).catch(() => ({ ok: false }));
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 永久缓存：不再按 TTL 过期（简介资料变更频率低，用户手动「重新搜索」才刷新）
      if (cached && cached.date) return { success: true, ...cached, cached: true };
    } catch {}
  }

  const isFinancial = /银行|保险|证券|信托|期货|基金|资管|财富|金控|租赁|财务|再保险|寿险|财险|人寿|太保|人保/.test(ind || '') || /金融/.test(ind || '');
  const finNote = isFinancial ? ' 注意：该公司属金融服务类，请严格按金融服务框架分析（关键成本项为资金成本/人力成本/风控合规成本，业务合作渠道而非制造业原材料供应商）。' : '';
  const isProduct = companyType === 'growth' || /科技|医药|生物|医疗|电子|半导体|消费|食品|化工|材料|制造|新能源|汽车/.test(ind || '');

  // 本地事实作为补充上下文（F10 里确定的数字不必让联网模型去猜）
  const factBlock = localCtx.ok && localCtx.text
    ? `\n\n【以下是本地已抓取的东财 F10 事实（公司概况 + 主营构成，数字可直接采用，其余字段请联网检索补充）】\n${localCtx.text}\n`
    : '';
  const askBody = `按 CFA 统一框架输出该公司的深度分析 JSON（一、公司一句话定位与投资摘要；二、基本面画像：基础档案/产品服务与图片位/文化品牌/专利创新/实控人/近10年重大事件时间线；三、供应链与成本：产业链定位/主要原材料与供应商/成本传导与敏感性矩阵(±5%/±10%/±20%/±30%)/成本控制方法/成本风险结论；四、客户与竞争：主要客户与集中度/竞争对手与格局图谱/对手价格变动影响模拟(维持原价/跟随降价/部分降价)/竞争风险与定价权结论；五、跨模块联动结论；六、风险提示；七、数据来源、日期与缺失说明）。${finNote}`;

  // —— 主路径：固定联网模型（信息分析天生依赖大量外部资料）——
  let modelPick = pickModelFor(cfg, 'web');
  let mode = 'web';
  let factAnchor = localCtx.ok ? localCtx.anchor : null;
  const webMessages = [
    { role: 'system', content: DEEP_SYSTEM_PROMPT },
    { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。${isProduct ? ' 该公司为产品型公司，产品与成本分析尤为关键。' : ''}请联网搜索后，${askBody}${factBlock}` },
  ];

  let messages = webMessages;

  try {
    let content;
    try {
      content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch, timeoutMs: 240000 }); // 七段统一输出（画像+供应链+客户竞争，含图片位），上下文与输出均为全项目最长，放宽至 4 分钟
    } catch (webErr) {
      // —— 兜底：联网失败且本地事实可用时，降级为本地模型纯推理（保证有内容，不空白）——
      if (localCtx.ok) {
        modelPick = pickLocalSummaryModel(cfg);
        mode = 'local';
        const ctxLen = DEEP_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 400;
        modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI公司深度', symbol);
        messages = [
          { role: 'system', content: DEEP_LOCAL_SYSTEM_PROMPT },
          { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。${isProduct ? ' 该公司为产品型公司，产品与成本分析尤为关键。' : ''}\n\n${localCtx.text}\n\n请严格基于以上本地事实输出公司深度分析 JSON（不要联网、不要编造未提供的字段）。${finNote}` },
        ];
        content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: false, timeoutMs: 240000 });
      } else {
        throw webErr;
      }
    }
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'PARSE_ERROR', message: 'AI 返回格式异常，无法解析公司深度分析。', raw: content.slice(0, 500) };
    }

    // ---- 归一化 + 图片下载（对需要配图的数组逐项 attachImage，仅使用 AI 直链；禁用 Commons 兜底）----
    // 20260915：Commons 对中文公司/产品关键词常返回建筑、纹理等不相关图片，禁用兜底避免截图中「全部不相关」问题。
    const profile = parsed.profile || {};
    const basicInfo = profile.basicInfo || {};
    const productsServices = [];
    for (let i = 0; i < (Array.isArray(profile.productsServices) ? profile.productsServices.length : 0); i++) {
      const p = profile.productsServices[i] || {};
      const imageLocal = await attachImage(symbol, 'cdP' + i, p.imageUrl, p.imageQuery || p.name, false, true);  // 产品位：关 Commons 兜底、开必应搜图（实体商品图）
      productsServices.push({
        name: String(p.name || '').trim(),
        content: String(p.content || '').trim(),
        revenueShare: String(p.revenueShare || '').trim(),
        scenario: String(p.scenario || '').trim(),
        customerType: String(p.customerType || '').trim(),
        imageLocal,
        imageQuery: String(p.imageQuery || '').trim(),
        imageNote: String(p.imageNote || '').trim(),
      });
    }

    const supplyChain = parsed.supplyChain || {};
    const materials = [];
    for (let i = 0; i < (Array.isArray(supplyChain.materials) ? supplyChain.materials.length : 0); i++) {
      const m = supplyChain.materials[i] || {};
      const imageLocal = await attachImage(symbol, 'cdM' + i, m.imageUrl, m.imageQuery || m.name, false, true);  // 原材料位：实体原料，同开必应搜图
      materials.push({
        name: String(m.name || '').trim(),
        desc: String(m.desc || '').trim(),
        supplierTop5: String(m.supplierTop5 || '').trim(),
        procureShare: String(m.procureShare || '').trim(),
        supplyContent: String(m.supplyContent || '').trim(),
        stability: String(m.stability || '').trim(),
        imageLocal,
        imageQuery: String(m.imageQuery || '').trim(),
        imageNote: String(m.imageNote || '').trim(),
      });
    }

    const competition = parsed.competition || {};
    const competitors = [];
    for (let i = 0; i < (Array.isArray(competition.competitors) ? competition.competitors.length : 0); i++) {
      const c = competition.competitors[i] || {};
      const imageLocal = await attachImage(symbol, 'cdC' + i, c.imageUrl, c.imageQuery || c.name, false);
      competitors.push({
        name: String(c.name || '').trim(),
        marketShare: String(c.marketShare || '').trim(),
        productOverlap: String(c.productOverlap || '').trim(),
        customerOverlap: String(c.customerOverlap || '').trim(),
        regionOverlap: String(c.regionOverlap || '').trim(),
        priceStrategy: String(c.priceStrategy || '').trim(),
        imageLocal,
        imageQuery: String(c.imageQuery || '').trim(),
        imageNote: String(c.imageNote || '').trim(),
      });
    }
    const customers = (Array.isArray(competition.customers) ? competition.customers : []).map(c => ({
      name: String((c && c.name) || '').trim(),
      revenueShare: String((c && c.revenueShare) || '').trim(),
      concentration: String((c && c.concentration) || '').trim(),
      industryPercentile: String((c && c.industryPercentile) || '').trim(),
    })).filter(c => c.name);

    const strs = (a) => (Array.isArray(a) ? a.map(x => String(x == null ? '' : (typeof x === 'object' ? (x.text || x.name || JSON.stringify(x)) : x)).trim()).filter(Boolean) : []);

    const norm = {
      oneLiner: String(parsed.oneLiner || '').trim(),
      investmentSummary: String(parsed.investmentSummary || '').trim(),
      profile: {
        basicInfo: {
          fullName: String(basicInfo.fullName || '').trim(),
          officeLocation: String(basicInfo.officeLocation || '').trim(),
          registeredAddress: String(basicInfo.registeredAddress || '').trim(),
          foundedDate: String(basicInfo.foundedDate || '').trim(),
          listedDate: String(basicInfo.listedDate || '').trim(),
          industry: String(basicInfo.industry || ind || '').trim(),
          employeeCount: String(basicInfo.employeeCount || '').trim(),
          execCount: String(basicInfo.execCount || '').trim(),
          execAvgSalary: String(basicInfo.execAvgSalary || '').trim(),
          execSalaryBasis: String(basicInfo.execSalaryBasis || '').trim(),
        },
        productsServices,
        culture: {
          mission: String((profile.culture && profile.culture.mission) || '').trim(),
          culture: String((profile.culture && profile.culture.culture) || '').trim(),
          vision: String((profile.culture && profile.culture.vision) || '').trim(),
          values: String((profile.culture && profile.culture.values) || '').trim(),
          brands: strs((profile.culture && profile.culture.brands)),
          trademarks: String((profile.culture && profile.culture.trademarks) || '').trim(),
        },
        patents: {
          total: String((profile.patents && profile.patents.total) || '').trim(),
          inventionRatio: String((profile.patents && profile.patents.inventionRatio) || '').trim(),
          yoy3y: String((profile.patents && profile.patents.yoy3y) || '').trim(),
          industryPercentile: String((profile.patents && profile.patents.industryPercentile) || '行业分位未获取').trim(),
        },
        controller: {
          hasController: String((profile.controller && profile.controller.hasController) || '').trim(),
          name: String((profile.controller && profile.controller.name) || '').trim(),
          holdingPct: String((profile.controller && profile.controller.holdingPct) || '').trim(),
          controlPath: String((profile.controller && profile.controller.controlPath) || '').trim(),
          concertParties: strs((profile.controller && profile.controller.concertParties)),
          background: String((profile.controller && profile.controller.background) || '').trim(),
          pledge: String((profile.controller && profile.controller.pledge) || '').trim(),
          governanceRisk: String((profile.controller && profile.controller.governanceRisk) || '').trim(),
          equityStructure: String((profile.controller && profile.controller.equityStructure) || '').trim(),
        },
        majorEvents: (Array.isArray(profile.majorEvents) ? profile.majorEvents : []).map(e => ({
          date: String((e && e.date) || '').trim(),
          category: String((e && e.category) || '').trim(),
          title: String((e && e.title) || '').trim(),
          desc: String((e && e.desc) || '').trim(),
          impactLevel: String((e && e.impactLevel) || '').trim(),
          impactOn: String((e && e.impactOn) || '').trim(),
        })).filter(e => e.title),
      },
      supplyChain: {
        chainPosition: String(supplyChain.chainPosition || '').trim(),
        positionBasis: String(supplyChain.positionBasis || '').trim(),
        materials,
        directMaterialRatio: String(supplyChain.directMaterialRatio || '').trim(),
        conductionCoef: toNum(supplyChain.conductionCoef),
        grossMarginSensitivity: toNum(supplyChain.grossMarginSensitivity),
        sensitivityMatrix: normalizeSensitivityMatrix(supplyChain),
        sensitivityNote: String(supplyChain.sensitivityNote || '').trim(),
        costControl: (Array.isArray(supplyChain.costControl) ? supplyChain.costControl : []).map(c => ({
          type: String((c && c.type) || '').trim(),
          practice: String((c && c.practice) || '').trim(),
          costImpact: String((c && c.costImpact) || '').trim(),
        })).filter(c => c.type || c.practice),
        costRiskLevel: String(supplyChain.costRiskLevel || '').trim(),
        costRiskReason: String(supplyChain.costRiskReason || '').trim(),
      },
      competition: {
        customers,
        competitors,
        landscapeGraph: String(competition.landscapeGraph || '').trim(),
        priceWarSimulation: {
          homogeneity: String((competition.priceWarSimulation && competition.priceWarSimulation.homogeneity) || '').trim(),
          switchingCost: String((competition.priceWarSimulation && competition.priceWarSimulation.switchingCost) || '').trim(),
          brandPremium: String((competition.priceWarSimulation && competition.priceWarSimulation.brandPremium) || '').trim(),
          channelStickiness: String((competition.priceWarSimulation && competition.priceWarSimulation.channelStickiness) || '').trim(),
          scenarios: (competition.priceWarSimulation && Array.isArray(competition.priceWarSimulation.scenarios) ? competition.priceWarSimulation.scenarios : []).map(s => ({
            strategy: String((s && s.strategy) || '').trim(),
            revenue: String((s && s.revenue) || '').trim(),
            grossMargin: String((s && s.grossMargin) || '').trim(),
            netProfit: String((s && s.netProfit) || '').trim(),
            marketShare: String((s && s.marketShare) || '').trim(),
          })).filter(s => s.strategy),
        },
        competitionRiskLevel: String(competition.competitionRiskLevel || '').trim(),
        pricingPower: String(competition.pricingPower || '').trim(),
        riskSignals: strs(competition.riskSignals),
      },
      linkage: String(parsed.linkage || '').trim(),
      topWarning: String(parsed.topWarning || '').trim(),
      riskNotes: strs(parsed.riskNotes),
      dataSources: (Array.isArray(parsed.dataSources) ? parsed.dataSources : []).map(d => ({
        item: String((d && d.item) || '').trim(),
        source: String((d && d.source) || '').trim(),
        date: String((d && d.date) || '').trim(),
      })).filter(d => d.item || d.source),
      missingNotes: strs(parsed.missingNotes),
    };

    // 确定性校验 → flags（代码权威）
    const flags = validateDeep(norm);

    const result = {
      symbol,
      stockName: name || symbol,
      industry: ind || '',
      ...norm,
      flags,
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factAnchor,
      hasSegment: !!localCtx.hasSegment,
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

module.exports = { analyzeCompanyDeep, validateDeep, _toNum: toNum };

~~~

---

## `lib\ai\config.js`  ·  210 行

~~~js
/**
 * lib/ai/config.js —— aiAugment 领域子模块：常量、配置读写与全部模块级状态的唯一持有者
 * ----------------------------------------------------------------
 * 由 lib/aiAugment.js 拆分而来（202609 拆分重构）：
 *   - 目录层级 +1：DATA_DIR/PROMPTS_DIR 的 path.join 相对层级同步改为 ('..','..')，
 *     最终字符串与拆分前逐字节一致（data/ai_config.json、data/ai_cache 等路径不变）。
 *   - 原模块级可变状态 gSearchMode/gVolcKey/gVolcModel/gBaiduKey 收拢为 runtime 对象
 *     （唯一一份进程内生效状态，引用语义不变）；消费方必须在调用时实时读取
 *     config.runtime.xxx，禁止模块顶层解构值快照。
 *   - _promptCache（提示词文件 mtime 缓存）本文件唯一持有，不导出。
 *
 * 配置字段（data/ai_config.json）：
 *   provider           服务商（qwen/glm/openai）
 *   apiKey             API Key（仅本机）
 *   modelWeb           联网模型（启用 enable_search）— 用于需联网检索的 AI 任务
 *   modelLocal         本地模型（不联网）— 用于分析本地数据库/财报文本/已抓取数据等纯推理任务
 *   useCustomProtocol  必须 true；让 WorkBuddy 直连阿里云百炼 API，使用免费额度，不消耗 WorkBuddy 积分
 *   searchMode         联网搜索方式（默认 builtin，留作回退）：
 *                        'builtin' 模型内置 enable_search — 无免费额度，≈0.003 元/次
 *                        'mcp'     阿里百炼联网搜索 MCP — 前 2000 次调用免费（一次性总额度、不重置），超出 ≈0.029 元/次
 *                        'volc'    火山引擎豆包搜索 — 每月 500 次免费（每月 1 日重置），超出 0.020 元/次
 *                        'baidu'   百度千帆 AI 搜索 MCP — 每日 100 次免费（每日重置，≈3000 次/月），超出 ≈0.008 元/次
 *                      volc/baidu 属「周期性重置」额度，本工作台当前用量（≈400 次/月）下可长期免费，优先使用。
 *   volcApiKey         火山方舟 Ark API Key（searchMode='volc' 时使用；留空则回退 builtin）
 *   volcModel          火山豆包模型名（默认 doubao-seed-1-6-250615）
 *   baiduApiKey        百度千帆 API Key（searchMode='baidu' 时使用；留空则回退 builtin）
 *
 * API Key 仅保存在本机 data/ai_config.json，不会上传。
 */
const fs = require('fs');
const path = require('path');
const { getAliMcpQuotaState } = require('../webSearchMcp'); // 阿里百炼(一次性2000次,本地计数保险)，publicConfig 展示额度

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'ai_config.json');
const CACHE_DIR = path.join(DATA_DIR, 'ai_cache');
const IMG_DIR = path.join(CACHE_DIR, 'img');
// 补全结果磁盘缓存：默认 7 天，省额度；超过后点「一键补全/重新搜索」会重新联网；
// 前端打开个股页时会通过只读接口直接读取已存缓存（不限 TTL），实现「一次搜索、长期留存」。
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 半静态内容 TTL 30 天（20260903f 降费）：研报/公告/公司介绍/供应链这类总结时效性弱，
// 30 天内直接复用；本地事实模式下另有「事实锚点」保鲜——事实没变就永不重推。
const SEMI_STATIC_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// 估值大模型：系统提示词从项目内 prompts/ 目录读取（改提示词无需动代码）
const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');
const _promptCache = {};
function loadPromptFile(name) {
  const fp = path.join(PROMPTS_DIR, name);
  let entry = _promptCache[name];
  try {
    const st = fs.statSync(fp);
    if (!entry || entry.mtime !== st.mtimeMs) {
      entry = { mtime: st.mtimeMs, content: fs.readFileSync(fp, 'utf8') };
      _promptCache[name] = entry;
    }
  } catch (e) {
    if (!entry) entry = { mtime: 0, content: '你是专注 A 股上市公司的估值分析师，给出内在价值区间、当前贵贱判断与安全边际，并标注数据来源与日期。' };
    _promptCache[name] = entry;
  }
  return entry.content;
}

const PROVIDERS = {
  qwen: {
    label: '通义千问',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defModel: 'qwen-plus',  // 20261012：未配置时的兜底默认。原 qwen-max 在本账号实测 403（无权限），qwen-plus 实测 200 可用
    search: 'enable_search',
  },
  glm: {
    label: '智谱 GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defModel: 'glm-4-plus',
    search: 'tool',
  },
  openai: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    defModel: 'gpt-4o-mini',
    search: 'none',
  },
};

function ensureDirs() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
  } catch {}
}

// 联网搜索方式白名单（默认 builtin 留作回退）
const SEARCH_MODES = ['builtin', 'mcp', 'volc', 'baidu'];
function normSearchMode(mode) {
  return SEARCH_MODES.includes(mode) ? mode : 'builtin';
}

const EMPTY_CONFIG = {
  provider: 'qwen', apiKey: '', modelWeb: '', modelLocal: '',
  searchMode: 'builtin', volcApiKey: '', volcModel: '', baiduApiKey: '',
  useCustomProtocol: true,
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...EMPTY_CONFIG };
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      provider: c.provider || 'qwen',
      apiKey: c.apiKey || '',
      // 兼容旧字段：旧版本用 c.model 表示「联网模型」；新版本拆为 modelWeb/modelLocal
      modelWeb: c.modelWeb || c.model || '',
      modelLocal: c.modelLocal || '',
      searchMode: normSearchMode(c.searchMode),
      volcApiKey: c.volcApiKey || '',
      volcModel: c.volcModel || '',
      baiduApiKey: c.baiduApiKey || '',
      // useCustomProtocol 必须 true：让 WorkBuddy 直连阿里云百炼 API，使用免费额度不消耗 WorkBuddy 积分
      useCustomProtocol: true,
    };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

// 进程内生效的搜索方式与各厂商凭据（避免每次 callLLM 都读盘）。
// 唯一一份可变状态（原 gSearchMode/gVolcKey/gVolcModel/gBaiduKey 四个 let 收拢为一个对象，引用语义不变）。
const runtime = { searchMode: 'builtin', volcKey: '', volcModel: '', baiduKey: '' };
function setSearchMode(mode) {
  runtime.searchMode = normSearchMode(mode);
}
function setSearchCreds(c) {
  runtime.volcKey = (c && c.volcApiKey) || '';
  runtime.volcModel = (c && c.volcModel) || '';
  runtime.baiduKey = (c && c.baiduApiKey) || '';
}

function saveConfig(cfg) {
  ensureDirs();
  const cur = loadConfig();
  // Key 类字段：传空表示「不修改」（前端只回显 hasKey，不回显明文）
  const keep = (v, old) => (v && String(v).trim() ? String(v).trim() : (old || ''));
  const next = {
    provider: cfg.provider || cur.provider || 'qwen',
    apiKey: keep(cfg.apiKey, cur.apiKey),
    modelWeb: keep(cfg.modelWeb, cur.modelWeb),
    modelLocal: keep(cfg.modelLocal, cur.modelLocal),
    searchMode: normSearchMode(cfg.searchMode),
    volcApiKey: keep(cfg.volcApiKey, cur.volcApiKey),
    // 模型名允许显式清空（回落默认值），故这里保留「传了就用、没传沿用」的语义
    volcModel: keep(cfg.volcModel, cur.volcModel),
    baiduApiKey: keep(cfg.baiduApiKey, cur.baiduApiKey),
    // 核心参数 useCustomProtocol 必须固定为 true：让 WorkBuddy 直连阿里云百炼 API，使用免费额度
    useCustomProtocol: true,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  setSearchMode(next.searchMode); // 立即让在跑的进程生效
  setSearchCreds(next);
  return publicConfig(next);
}

function publicConfig(c) {
  return {
    provider: c.provider || 'qwen',
    hasKey: !!c.apiKey,
    modelWeb: c.modelWeb || '',
    modelLocal: c.modelLocal || '',
    searchMode: normSearchMode(c.searchMode),
    hasVolcKey: !!c.volcApiKey,
    volcModel: c.volcModel || '',
    hasBaiduKey: !!c.baiduApiKey,
    // 20260903r：阿里 MCP 免费额度本地计数（前端设置弹窗展示「已用 X/2000」）
    mcpQuota: getAliMcpQuotaState(),
    useCustomProtocol: true,
  };
}

// 模块加载时从已存配置初始化搜索方式与凭据（服务重启后保持一致）
try {
  const _c = loadConfig();
  setSearchMode(_c.searchMode);
  setSearchCreds(_c);
} catch (_) {}

module.exports = {
  UA,
  DATA_DIR,
  CONFIG_PATH,
  CACHE_DIR,
  IMG_DIR,
  CACHE_TTL_MS,
  SEMI_STATIC_TTL_MS,
  PROMPTS_DIR,
  loadPromptFile,
  PROVIDERS,
  ensureDirs,
  SEARCH_MODES,
  normSearchMode,
  EMPTY_CONFIG,
  loadConfig,
  runtime,
  setSearchMode,
  setSearchCreds,
  saveConfig,
  publicConfig,
};

~~~

---

## `lib\ai\earnings.js`  ·  622 行

~~~js
/**
 * lib/ai/earnings.js —— aiAugment 领域子模块：财报解读（拆分重构 202609）
 * ----------------------------------------------------------------
 * 含本地上下文构建（buildLocalEarningsContext）与全部 _extract* 后处理。
 * EARNINGS_PROMPT_VERSION 随缓存门控语义迁至 ai/cache.js，本模块反向 require。
 * 注意：buildLocalEarningsContext 内对 ./deepAnalysis 的延迟 require 原样保留
 * （deepAnalysis 顶层依赖 aiAugment.readCache 的历史环已通过 ai/cache 切断，
 *   但延迟 require 是已验证的稳定形态，按「零行为变化」原则不改）。
 */
const fs = require('fs');
const path = require('path');
const { getCompanyProfile } = require('../shareholderData');
const { CACHE_DIR, CACHE_TTL_MS, PROVIDERS, ensureDirs, loadConfig } = require('./config');
const { callLLM, pickModelFor, extractSources } = require('./llm');
const { EARNINGS_PROMPT_VERSION } = require('./cache');

const EARNINGS_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场，并能利用联网搜索获取最新公开信息。用户会给你一家公司的名称与代码。请你联网搜索该公司最新一期（最近一个已披露季度）的财报/季报/业绩预告，并做解读分析。

【身份确认（最高优先级）】你正在分析的是用户在消息中明确指定的公司（名称 + 6 位代码）。以下所有营业收入、归母净利润、扣非净利润、报告期等数据，必须严格对应该标的；严禁混入其他任何公司（例如中国平安 601318、贵州茅台 600519 等）的财务数据。若联网检索结果指向了错误的公司，必须立即纠正标的，或明确声明「未找到该公司最新财报」，绝不可张冠李戴。

输出格式（严格）：
第 1 行：标的：{公司名}（{代码}）（例如「标的：士兰微（600460）」，必须与用户给出的公司完全一致）
第 2 行：报告期：YYYY年X季报（例如「报告期：2026年中报」）
第 3 行：综合信号：<整数，区间 [-3, +3]，+ 代表利好/看多、- 代表利空/看空、0 中性；必须严格依据「边际变化方向 + 实质强弱」综合判定，不能只看同比正负（例如「表观稳、实质弱、边际向下」应给约 -2）>
第 4 行：综合结论：用一句话概括整体定性（如「表观稳、实质弱」「超预期改善」「低于预期、压力加大」「稳健增长」等），并点明核心矛盾与边际变化方向（加速/减速/拐点）。

重点覆盖以下维度，逐条结构化呈现（无该信息则写"暂无公开信息"）：
1) 最新报告期：明确是哪一期（如 2026 年中报 / 2025 年年报），披露日期；
2) 核心业绩与边际变化（重点）：营业收入、归母净利润、扣非净利润，以及各自同比（YoY）与环比（QoQ/较上季）变化，单位统一为「亿元」。
   - 必须同时计算并说明「较去年同期的变化是加速还是放缓」。例如：营收 2025 年上半年同比 +7.59%，2026 年上半年同比 +6.01%，虽然仍为正增长，但同比增速放缓 1.58 个百分点，属于边际走弱，不能简单判为利好。
   - 【环比口径铁律】最新报告期为「中报（半年报）」时，环比必须是「当年二季度（Q2）单季 vs 当年一季度（Q1）单季」，严禁把「上半年累计 vs 上一年年报（全年/Q4）」当作环比——那是错误的跨口径比较。同理：三季报→Q3单季 vs Q2单季；年报→Q4单季 vs Q3单季；一季报→当年Q1 vs 上一年Q4单季。
   - 单季值由累计值相减得到（Q2单季 = 上半年累计 − 一季度累计）。若下方提供了「系统已核算的单季数据与环比（已核实）」块，必须直接采用其中的数字，不得自行改用其他口径或替换为别处搜来的数字。
   - 必须同时计算并说明「较上一季度（QoQ）的趋势」，并给出变化率。
   - 若核心指标同比/环比方向相反，须明确指出何者占主导并解释原因。
3) 业绩驱动：营收/利润增长或下滑的主要业务线、产品、区域或成本费用原因；
4) 亮点：超预期项、毛利率/净利率改善、订单/合同负债等前瞻信号；
5) 风险与隐忧：减值、商誉、现金流恶化、负债率上升、监管或诉讼等；
6) 与一致预期/历史同期对比：是否超预期或不及预期；
7) 管理层展望/指引（如有）；
8) 再次总结：用一句话重复综合结论，确保结论清晰。

【来源分级与核实标注（强制，逐条执行）】
- 凡涉及具体数字（营收、利润、增速、比率、资产/负债科目、现金流等）的结论，必须以「公司定期报告 / 业绩预告 / 公司公告 / 交易所披露 / 巨潮资讯 / 东方财富F10财报」为唯一依据，并在该条末尾标注「（已核实：{来源}，{报告期}）」。
- 凡来自券商研报或财经媒体报道的推断/预测，须标注「（未核实：研报/媒体推测）」，且不得与财报已披露数字混为一谈。
- 严禁使用雪球、股吧、论坛帖、自媒体、个人评论作为任何数字类结论的依据；此类内容最多只能作为「市场情绪」一句话提及，且必须标注「（未核实：论坛个人观点，非权威）」，不得据此下业绩或估值判断。
- 纯定性判断（行业趋势、竞争格局、管理层意图等）若无法从财报核实，须标注「（未核实：定性判断）」。
- 不可核实的内容不得写成既定事实（禁止「已确认」「必将」「一定是」等表述），须改为「据…（未核实）」的推测语气。

要求：用简体中文分点结构化输出；不要孤立解读当期数字（如「营收增长 6.01%」不能直接判定为利好），必须结合同比、环比与边际变化给出定性；每条数据结论后必须带「已核实/未核实」标注与具体来源（公司公告/巨潮/交易所/东方财富F10财报等）及报告期；不要编造无来源的数字；若确无最新财报公开信息写"暂无相关公开财报"。总长一般不超过 1300 字（含「已核实/未核实」标注所占字数）；若内容丰富可能超出，先对次要细节做精简提炼（保留核心结论、同比/环比与边际变化、关键数据与来源标注，不得改变原意），严禁生硬截断或丢掉维度。`;

// ---------- 本地模式：分析本地数据库财报数据（不联网，使用 modelLocal） ----------
// 用途归类：财报解读只需要「分析已存在于本地财务数据库 / 已上传财报清单」的数据，
// 不需要模型去联网检索，因此切到本地模型（webSearch=false），并以本地数据作为唯一事实来源。
const EARNINGS_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场。

【重要】你没有联网能力，也不需要联网。下方「本地财报数据」由系统从本地读取，是本轮分析唯一允许引用的事实来源，包含两部分：
①「近 8 期核心指标」结构化表（本地财务数据库，东方财富F10财报）——所有数字类结论的唯一事实来源；
②「同期财报原文节选」（本地资料库 PDF，如有）——公司披露的原文，用于业务构成、经营讨论、驱动因素、风险提示等定性背景。
严禁使用你训练记忆中的任何财务数字，严禁推测、估算或编造数据。PDF 节选中的数字仅当与结构化表一致（或结构化表未覆盖且明确标注来源）时方可引用；两者冲突时一律以结构化表为准。凡本地数据未提供的指标，一律写"本地数据未提供"，不得凭印象补充。

输出格式（严格）：
第 1 行：报告期：YYYY年X季报（例如「报告期：2026年中报」，以本地数据的最新报告期为准）
第 2 行：综合信号：<整数，区间 [-3, +3]，+ 代表利好/看多、- 代表利空/看空、0 中性；必须严格依据「边际变化方向 + 实质强弱」综合判定，不能只看同比正负（例如「表观稳、实质弱、边际向下」应给约 -2）>
第 3 行：综合结论：用一句话概括整体定性（如「表观稳、实质弱」「超预期改善」「低于预期、压力加大」「稳健增长」等），并点明核心矛盾与边际变化方向（加速/减速/拐点）。

重点覆盖以下维度，逐条结构化呈现（本地数据未提供则写"本地数据未提供"）：
1) 最新报告期：明确是哪一期，并标注数据时间与数据来源；
2) 核心业绩与边际变化（重点）：营业收入、归母净利润，各自的同比（YoY）与环比（较上一期）变化，单位统一为「亿元」。
   - 必须基于本地数据计算并说明「较去年同期的变化是加速还是放缓」，给出具体百分点。
   - 例如：营收本期同比 +6.01%、上期同比 +7.59%，仍为正增长但增速放缓 1.58 个百分点，属边际走弱，不能简单判为利好。
   - 若同比/环比方向相反，须明确指出何者占主导并解释原因。
3) 业绩驱动：优先引用 PDF 节选中「管理层讨论与分析/经营情况」披露的业务线、产品、区域、成本费用等真实原因（标注为公司披露）；结构化表能推断的原因须明确标注是推断；
4) 亮点：增速回升、降幅收窄等可从数据中直接验证的项；PDF 节选中披露的积极经营信号（如新品、渠道、订单）可一并说明；
5) 风险与隐忧：增速放缓、降幅扩大、边际走弱等可从数据中直接验证的项；PDF 节选「风险因素/可能面对的风险」章节披露的风险须逐条转述（这是数据完整性的重点）；
6) 数据可信度自查：仅一句概括，点明**实际已覆盖的字段**（如"覆盖：营收、归母净利、近 8 期核心指标"）与**实际未覆盖的具体字段名**（如"未覆盖：扣非净利、经营现金流、资产负债、一致预期"）。严禁对每个未列出的字段单独写一行同样的"数据不可验证"等套话；若有同期 PDF 原文支撑则注明。
7) 再次总结：用一句话重复综合结论，确保结论清晰。

要求：用简体中文分点结构化输出；不要孤立解读当期数字，必须结合同比、环比与边际变化给出定性；
结构化表数字后标注「（本地财报数据，报告期 XXXX-XX-XX，来源：东方财富F10财报）」，PDF 节选取材的定性内容标注「（资料库PDF：{PDF 报告期}）」；总长一般不超过 1000 字；若内容丰富可能超出，先精简提炼（不得改变原意），重复行仍会被自动折叠。`;

/**
 * 构建「本地财报上下文」——供本地模型分析，不联网。
 * 数据来源（规则一 · 指标级单源）：东方财富 F10 财报（lrbAjaxNew），经 lib/financeHub 输出五要素 + 同比 + 边际。
 * @param {string} symbol 6 位股票代码（或 sh600000 形式）
 * @returns {{ok:boolean, text?:string, reportDate?:string, series?:Array, docs?:Array, reason?:string}}
 */
// 从资料库文档中挑选与最新报告期最匹配的财报 PDF（20260902j）。
// 匹配优先级：同期完整报告 > 同期摘要 > 最近一期同类型完整报告 > 最近一期同类型摘要。
// 报告期从文件名/标题解析（如 603288_2026-08-27_海天味业2026年半年度报告.pdf → 2026年中报）。
// 注意：doc.year 是披露年份（年报比报告期晚一年），因此一律以文件名中的报告期年份为准。
function pickReportDoc(docs, reportDate) {
  if (!Array.isArray(docs) || !docs.length || !reportDate) return null;
  const rd = String(reportDate).slice(0, 10);
  const md = rd.slice(5); // MM-DD
  const targetYear = rd.slice(0, 4);
  const targetStage = md === '12-31' ? 'annual' : md === '06-30' ? 'semi'
    : md === '03-31' ? 'q1' : md === '09-30' ? 'q3' : '';
  if (!targetStage) return null;

  const STAGE_PAT = {
    semi: /(\d{4})年(?:半年度|中期)报告/,
    annual: /(\d{4})年年度报告/,
    q1: /(\d{4})年第?一季/,
    q3: /(\d{4})年第?三季/,
  };
  const STAGE_LABEL = { annual: '年报', semi: '中报', q1: '一季报', q3: '三季报' };

  const parsed = docs.map(d => {
    const fn = `${d.fileName || ''} ${d.title || ''}`;
    let stage = null, year = '';
    for (const [st, pat] of Object.entries(STAGE_PAT)) {
      const m = fn.match(pat);
      if (m) { stage = st; year = m[1]; break; }
    }
    return { doc: d, stage, year, isAbstract: /摘要/.test(fn) };
  }).filter(p => p.stage && p.year && /\.pdf$/i.test(String(p.doc.fileName || '')));

  const sameStage = parsed.filter(p => p.stage === targetStage);
  if (!sameStage.length) return null;

  const exact = sameStage.filter(p => p.year === targetYear);
  const pool = exact.length ? exact : sameStage.filter(p => p.year < targetYear);
  if (!pool.length) return null;
  // 报告期年份最新优先；完整报告优先于摘要
  pool.sort((a, b) => (Number(b.year) - Number(a.year)) || (a.isAbstract - b.isAbstract));
  const best = pool[0];
  return {
    doc: best.doc,
    periodLabel: `${best.year}年${STAGE_LABEL[best.stage]}`,
    exactMatch: best.year === targetYear,
  };
}

async function buildLocalEarningsContext(symbol, opts = {}) {
  const { pdfCharCap = 28000 } = opts; // 0 = 不注入 PDF（本地模型上下文装不下且无 modelWeb 可升级时）
  try {
    // 延迟 require：deepAnalysis 顶层依赖 aiAugment（readCache），此处顶层 require 会形成循环依赖
    const { fetchFinancialData } = require('../deepAnalysis');
    const { getFinanceHub } = require('../financeHub');
    const docStore = require('../docStore');

    const emCode = /^(sh|sz|bj)/i.test(String(symbol))
      ? String(symbol).toUpperCase()
      : (String(symbol).startsWith('6') ? `SH${symbol}` : `SZ${symbol}`);

    const finData = await fetchFinancialData(emCode);
    const hub = getFinanceHub(finData);
    if (!hub || !hub.ok) {
      return { ok: false, reason: (hub && hub.error) || '本地财务数据不可用' };
    }

    // 近 8 期营收 / 归母净利润明细（供本地模型自行计算同比与环比）
    const rows = (finData.income || [])
      .slice()
      .sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')))
      .slice(-8)
      .map(r => ({
        reportDate: String(r.REPORT_DATE || '').slice(0, 10),
        periodName: r.REPORT_DATE_NAME || '',
        revenue: Number(r.TOTAL_OPERATE_INCOME),
        netProfit: Number(r.PARENT_NETPROFIT),
        deduct: (r.DEDUCT_PARENT_NETPROFIT != null && r.DEDUCT_PARENT_NETPROFIT !== '')
          ? Number(r.DEDUCT_PARENT_NETPROFIT) : null,
      }))
      .filter(r => r.reportDate && (isFinite(r.revenue) || isFinite(r.netProfit)));
    if (!rows.length) return { ok: false, reason: '本地财报无可用明细行' };

    const yi = v => (isFinite(v) ? (v / 1e8).toFixed(2) : '--');
    const table = rows.map(r =>
      `- ${r.reportDate}（${r.periodName || '—'}）：营业收入 ${yi(r.revenue)} 亿元；归母净利润 ${yi(r.netProfit)} 亿元` +
      (r.deduct != null && isFinite(r.deduct) ? `；扣非归母净利润 ${yi(r.deduct)} 亿元` : '')
    ).join('\n');

    // 20260906（v4）：现金流量表 + 资产负债表关键科目注入（修复 AI 自搜旧年份/错误数据违反数据一致性，
    // 如圣湘生物曾被 AI 误引"2025 年报经营现金流 18.7 亿/商誉 0"，实际本地三表齐全且新）
    const cfRows = (finData.cashflow || [])
      .slice()
      .sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')))
      .slice(-8)
      .map(r => ({
        reportDate: String(r.REPORT_DATE || '').slice(0, 10),
        periodName: r.REPORT_DATE_NAME || '',
        operating: Number(r.NETCASH_OPERATE),
        salesCash: Number(r.SALES_SERVICES),
      }))
      .filter(r => r.reportDate && (isFinite(r.operating) || isFinite(r.salesCash)));
    const cfTable = cfRows.length
      ? cfRows.map(r =>
          `- ${r.reportDate}（${r.periodName || '—'}）：经营现金流净额 ${yi(r.operating)} 亿元` +
          (isFinite(r.salesCash) ? `；销售商品收现 ${yi(r.salesCash)} 亿元` : '')
        ).join('\n')
      : '（现金流量表暂无可用明细行）';

    const latestBal = (finData.balance || [])
      .slice()
      .sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')))
      .pop();
    let balBlock = '';
    if (latestBal) {
      const balItems = [
        ['总资产', latestBal.TOTAL_ASSETS], ['总负债', latestBal.TOTAL_LIABILITIES], ['归母净资产', latestBal.TOTAL_PARENT_EQUITY],
        ['货币资金', latestBal.MONETARYFUNDS], ['应收账款', latestBal.ACCOUNTS_RECE], ['存货', latestBal.INVENTORY],
        ['商誉', latestBal.GOODWILL], ['固定资产', latestBal.FIXED_ASSET], ['短期借款', latestBal.SHORT_LOAN],
      ];
      const balDate = String(latestBal.REPORT_DATE || '').slice(0, 10);
      const balName = latestBal.REPORT_DATE_NAME || balDate;
      const balLines = balItems
        .filter(([, v]) => v != null && v !== '' && isFinite(Number(v)))
        .map(([k, v]) => `${k} ${yi(Number(v))} 亿元`).join('；');
      balBlock = `■ 资产负债表关键科目（最新报告期 ${balDate}（${balName}），单位：亿元）\n- ${balLines || '（无可用科目）'}`;
    }

    // 已上传财报清单（资料库）——文档库 stockCode 为裸码（如 688289），带前缀 symbol 须归一化
    // （20260906 修复：此前带前缀查询精确匹配永远落空，PDF 节选从未注入成功）
    let docs = [];
    try { docs = docStore.listCompanyDocuments(String(symbol).replace(/^(sh|sz|bj)/i, '')) || []; } catch (e) { docs = []; }
    const docLine = docs.length
      ? docs.slice(0, 12).map(d => `${d.typeName || d.type}｜${d.title || d.fileName}${d.year ? `（${d.year}年）` : ''}`).join('；')
      : '本地资料库暂无已上传财报文件';

    // ---- 同期财报 PDF 正文节选（20260902j）：提取与最新报告期匹配的 PDF 前 N 页，
    // 用于补充业务构成/经营讨论/风险提示等定性背景；数字事实源仍以结构化表为准 ----
    let docInfo = null;
    let pdfExcerpt = null;
    const picked = pdfCharCap > 0 ? pickReportDoc(docs, hub.reportDate) : null;
    if (picked && picked.doc) {
      try {
        const { getDocumentPath } = docStore;
        const resolved = getDocumentPath(picked.doc.id);
        const pdfPath = resolved && resolved.fullPath;
        if (pdfPath) {
          const pdf = require('../pdfText');
          const ext = await pdf.extractPdfText(pdfPath, { maxPages: 40, charCap: pdfCharCap });
          // 正文过短视为无效（扫描件无文本层），跳过注入不阻塞主流程
          if (ext.ok && ext.text && ext.text.replace(/\s/g, '').length >= 300) {
            docInfo = {
              fileName: picked.doc.fileName,
              periodLabel: picked.periodLabel,
              exactMatch: picked.exactMatch,
              pages: ext.pages,
              totalPages: ext.total_pages,
              truncated: !!ext.truncated,
              cached: !!ext.cached,
            };
            pdfExcerpt = [
              `■ 同期财报原文节选（本地资料库：${picked.doc.fileName}，覆盖报告期 ${picked.periodLabel}${picked.exactMatch ? '' : '（非最新一期，为最近可得同期报告）'}）`,
              `（节选前 ${ext.pages} 页${ext.truncated ? '，已截断' : ''}；本节用于业务构成、经营讨论、风险提示等定性背景；其中数字仅当与结构化表一致时方可引用，冲突时以结构化表为准）`,
              ext.text,
            ].join('\n');
          } else if (!ext.ok) {
            console.warn(`[财报解读PDF] ${symbol} 提取失败: ${ext.error}`);
          }
        }
      } catch (e) {
        console.warn(`[财报解读PDF] ${symbol} 注入异常（不影响解读主流程）: ${e.message}`);
      }
    }

    const gm = hub.growthMarginal || {};
    const labelOf = k => (k === 'TOTAL_OPERATE_INCOME' ? '营业收入' : '归母净利润');
    const marginalLines = ['TOTAL_OPERATE_INCOME', 'PARENT_NETPROFIT']
      .map(k => (gm[k] && gm[k].available
        ? `  · ${gm[k].text}`
        : `  · ${labelOf(k)}：${(gm[k] && gm[k].reason) || '不足三期，无法计算增速的边际'}`))
      .join('\n');

    const text = [
      `【本地财报数据｜公司代码 ${symbol}】`,
      `数据来源：${hub.source}；最新报告期（数据时间）：${hub.reportDate}；获取时间：${hub.fetchedAt}`,
      hub.staleNote ? `⚠️ ${hub.staleNote}` : '',
      '',
      '■ 近 8 期核心指标（单位：亿元）',
      table,
      '',
      '■ 系统已计算的同比与边际（规则三：变化率 = 同比增速；边际 = 本期同比 − 上期同比）',
      marginalLines,
      '',
      '■ 近 8 期现金流量表（单位：亿元）',
      cfTable,
      '',
      balBlock || '■ 资产负债表暂无可用数据',
      '',
      pdfExcerpt || '■ 本地资料库已上传财报文件（未匹配到本期 PDF，仅登记文件名）',
      pdfExcerpt ? '' : docLine,
    ].filter(Boolean).join('\n');

    return { ok: true, text, reportDate: hub.reportDate, series: rows, docs, fetchedAt: hub.fetchedAt, docInfo };
  } catch (e) {
    return { ok: false, reason: e.message || '本地财报上下文构建失败' };
  }
}

function _extractReportPeriod(content) {
  if (!content) return null;
  const m = String(content).match(/^\s*报告期[：:]\s*(.+?)\s*(?:\n|\r|$)/m);
  if (!m) return null;
  return m[1].replace(/[\s\u3000]+/g, ' ').trim();
}

// 20260904b：解析 AI 在首行声明的「标的：公司名（代码）」，用于前端展示 + 串公司检测。
// 若 AI 返回的代码与当前 symbol 不一致，即为疑似串公司（如 600460 误读为 601318）。
function _extractEarningsTarget(content) {
  if (!content) return null;
  const m = String(content).match(/标的[：:]\s*(.+?)\s*(?:\n|\r|$)/);
  if (!m) return null;
  const raw = m[1].replace(/[\s\u3000]+/g, ' ').trim();
  if (!raw) return null;
  const codeM = raw.match(/\(?\s*(\d{6})\s*\)?/);
  const code = codeM ? codeM[1] : null;
  const name = raw.replace(/[（(]\s*\d{6}\s*[)）]/, '').replace(/[（）()]/g, '').trim();
  return { raw, name, code };
}

// 20260904a：把「2026-06-30」转成人类可读报告期标签「2026年中报」/「2025年年报」等
function _reportDateToLabel(reportDate) {
  if (!reportDate) return null;
  const s = String(reportDate).slice(0, 10);
  const md = s.slice(5);
  const y = s.slice(0, 4);
  if (md === '12-31') return `${y}年年报`;
  if (md === '06-30') return `${y}年中报`;
  if (md === '03-31') return `${y}年一季报`;
  if (md === '09-30') return `${y}年三季报`;
  return `${y}年（${md}）`;
}

// 20260904a：从 AI 返回的亮点/雷点文本里检测它**作为论据**引用的财报年份。
// 返回该条目实际引用的最新年份（数字），用于与 latestReportYear 比对；若条目不含年报年份则返回 null（不涉财报，放行）。
function _detectCitedYear(text) {
  if (!text) return null;
  const m = String(text).match(/(20\d{2})\s*年(?:[半一三]|度)?报?/);
  return m ? parseInt(m[1], 10) : null;
}

// 从 AI 财报解读文本提取结构化信号（[-1,1]）：
// 优先解析「综合信号：N」整数行（N∈[-3,+3] 归一化）；缺失时按综合结论关键词启发式兜底。
function _extractEarningsSignal(content) {
  if (!content) return 0;
  const m = content.match(/综合信号[：:]\s*([+-]?\d+)/);
  if (m) {
    const n = Math.max(-3, Math.min(3, parseInt(m[1], 10)));
    return Math.max(-1, Math.min(1, n / 3));
  }
  // 兜底：优先用「综合结论」定性行做关键词启发式（避免全文亮点/风险段相互抵消，导致方向误判）
  const concl = (content.match(/综合结论[：:]\s*(.+?)(?:\n|\r|$)/) || [])[1] || '';
  const scope = concl.trim().length ? concl : content.slice(0, 240);
  const negRe = /放缓|下滑|恶化|承压|向下|走弱|不及|收窄|负增长|转负|亏损|隐忧|压力加大|拐点向下|边际向下|低于预期|不及预期/;
  const posRe = /超预期|改善|加速|向好|转正|回升|拐点向上|边际向上|高于预期|超预期改善/;
  const negCnt = (scope.match(negRe) || []).length;
  const posCnt = (scope.match(posRe) || []).length;
  if (posCnt > negCnt) return 0.5;
  if (negCnt > posCnt) return -0.5;
  return 0;
}

// 提取「综合结论」定性短句，供因子卡片展示（如「表观稳、实质弱」）
function _extractEarningsVerdict(content) {
  if (!content) return null;
  const m = content.match(/综合结论[：:]\s*(.+?)\s*(?:\n|\r|$)/);
  if (m) return m[1].replace(/[\s\u3000]+/g, ' ').trim();
  return null;
}

// 后置清理财报解读正文（20260904a，修士兰微 8 行重复 bug；20260906a 放宽长度）。
// 1) 折叠连续 2+ 行完全重复的相邻行（保留一行 + 计数提示，例如「（同上×7」），
//    防模型机械地把每个缺数据指标都写成同一句话刷屏。
// 2) 长度策略（20260906a）：取消 800 字硬上限——AI 侧目标 ≤1000 字、超出由模型精简提炼；
//    此处仅保留 1500 字安全兜底（正常不触发），只防模型失控刷屏。
// 20260909i：安全上限 1500 → 2400。因新增「已核实/未核实」逐条标注（每条约 +20~30 字）
// 后原上限会把第 8 条「再次总结」截掉，属丢维度；标注是硬性要求，故放宽兜底上限。
function _postProcessEarningsSummary(text, maxChars = 2400) {
  if (!text) return text;
  // 步骤1：按"连续重复行组"收集（避免把上一行标记成对象后再去 trim 的递归坑）
  const lines = String(text).split(/\r?\n/);
  const groups = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) {
      groups.push({ kind: 'blank', raw: ln });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.kind === 'dup' && last.text === t) {
      last.count++;
      continue;
    }
    groups.push({ kind: 'dup', text: t, count: 1, raw: ln });
  }
  // 步骤2：把 dup 组展开为「首行 + (同上×N)」
  const merged = [];
  for (const g of groups) {
    if (g.kind == 'blank') { merged.push(g.raw); continue; }
    merged.push(g.raw);
    if (g.count > 1) {
      merged.push(`（同上×${g.count}，已折叠以避免重复占用篇幅）`);
    }
  }
  let out = merged.join('\n').trim();

  // 步骤3：总长硬上限（保留「综合信号/结论」与「最新报告期/数据可信度自查」两句完整性，截中间正文）
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const lastStop = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('；'),
      cut.lastIndexOf('）'),
    );
    const safeCut = lastStop >= maxChars * 0.7 ? cut.slice(0, lastStop + 1) : cut;
    out = safeCut + '\n\n（…正文超出安全长度上限，已被截断。正常情况下 AI 会自动精简提炼到 1000 字左右；如反复出现请点击「重新解读」重试。）';
  }
  return out;
}

// ===== 20260909i：单季拆解 —— 中报环比必须是「Q2单季 vs Q1单季」=====
// 背景（用户反馈）：此前中报的环比被算成「本期累计 vs 上一年年报（Q4）」，属跨口径错误比较。
// 累计口径：03-31=Q1累计｜06-30=上半年累计｜09-30=前三季累计｜12-31=全年累计
// 单季：Q1=Q1累计；Q2=上半年累计−Q1累计；Q3=前三季累计−上半年累计；Q4=全年累计−前三季累计
const Q_METRICS = [
  { key: 'TOTAL_OPERATE_INCOME', label: '营业收入' },
  { key: 'PARENT_NETPROFIT', label: '归母净利润' },
  { key: 'DEDUCT_PARENT_NETPROFIT', label: '扣非归母净利润' },
];
const Q_ORDER = ['Q1', 'Q2', 'Q3', 'Q4'];
const Q_CUM_MD = { Q1: '03-31', Q2: '06-30', Q3: '09-30', Q4: '12-31' };
const Q_PREV = { Q1: null, Q2: 'Q1', Q3: 'Q2', Q4: 'Q3' };

// 由累计口径利润表拆出当年各单季值，并给出「最新单季 vs 上一单季」的环比
function buildQuarterlyFacts(income) {
  if (!Array.isArray(income) || !income.length) return null;
  const byDate = {};
  income.forEach(r => {
    const d = String(r.REPORT_DATE || '').slice(0, 10);
    if (d) byDate[d] = r;
  });
  const dates = Object.keys(byDate).sort();
  const latest = dates[dates.length - 1];
  const y = latest.slice(0, 4);
  const md = latest.slice(5);
  const stageOf = m => (m === '03-31' ? 'Q1' : m === '06-30' ? 'Q2' : m === '09-30' ? 'Q3' : m === '12-31' ? 'Q4' : null);
  const latestQ = stageOf(md);
  if (!latestQ) return null;

  const val = (d, k) => {
    const r = byDate[d];
    if (!r) return null;
    const v = Number(r[k]);
    return isFinite(v) ? v : null;
  };
  const cumDate = q => `${y}-${Q_CUM_MD[q]}`;

  const single = {};
  Q_METRICS.forEach(m => {
    single[m.key] = {};
    Q_ORDER.forEach(q => {
      const cur = val(cumDate(q), m.key);
      const p = Q_PREV[q];
      const prev = p ? val(cumDate(p), m.key) : 0;
      single[m.key][q] = (cur == null || prev == null) ? null : (cur - prev);
    });
  });

  const idx = Q_ORDER.indexOf(latestQ);
  let qoq = null;
  if (idx >= 1) {
    const curQ = Q_ORDER[idx], prevQn = Q_ORDER[idx - 1];
    qoq = { curLabel: `${y}年${curQ}单季`, prevLabel: `${y}年${prevQn}单季`, items: {} };
    Q_METRICS.forEach(m => {
      const c = single[m.key][curQ], p = single[m.key][prevQn];
      if (c == null || p == null) { qoq.items[m.key] = null; return; }
      // 分母为 0 时环比无意义；分母为负时以绝对值作分母，避免符号反转导致误读
      const rate = (p !== 0) ? ((c - p) / Math.abs(p)) * 100 : null;
      qoq.items[m.key] = { label: m.label, cur: c, prev: p, diff: c - p, rate };
    });
  }
  return { latestReportDate: latest, latestQ, year: y, single, qoq };
}

// 格式化为注入提示词的「已核实」事实块
function formatQuarterlyFacts(f) {
  if (!f || !f.qoq) return null;
  const yi = v => (v == null || !isFinite(v) ? '—' : (v / 1e8).toFixed(2));
  const lines = [
    `■ 系统已核算的单季数据与环比（已核实｜来源：东方财富F10财报，报告期 ${f.latestReportDate}）`,
    `（口径：由「累计值相减」拆出单季。最新一期为 ${f.year}年${f.latestQ}，故环比 = ${f.qoq.curLabel} vs ${f.qoq.prevLabel}）`,
  ];
  let any = false;
  Q_METRICS.forEach(m => {
    const it = f.qoq.items[m.key];
    if (!it) return;
    any = true;
    const rate = (it.rate == null) ? '—' : `${it.rate >= 0 ? '+' : ''}${it.rate.toFixed(2)}%`;
    const diffStr = (it.diff >= 0 ? '+' : '') + yi(it.diff);
    lines.push(`  · ${m.label}：${f.qoq.curLabel} ${yi(it.cur)} 亿元，${f.qoq.prevLabel} ${yi(it.prev)} 亿元，环比 ${rate}（差额 ${diffStr} 亿元）`);
  });
  if (!any) return null;
  lines.push('（以上由确定性代码计算，属「已核实」数据；环比必须直接采用，严禁改用「本期累计 vs 上一年年报」等跨口径比较）');
  return lines.join('\n');
}

// 取数并生成「已核实」单季事实块（失败返回 null，不阻塞主流程）
async function buildVerifiedQuarterFacts(symbol) {
  try {
    const { fetchFinancialData } = require('../deepAnalysis');
    const emCode = /^(sh|sz|bj)/i.test(String(symbol))
      ? String(symbol).toUpperCase()
      : (String(symbol).startsWith('6') ? `SH${symbol}` : `SZ${symbol}`);
    const finData = await fetchFinancialData(emCode);
    return formatQuarterlyFacts(buildQuarterlyFacts(finData && finData.income));
  } catch (e) {
    console.warn(`[财报解读单季核算] ${symbol} 失败（不影响主流程）: ${e.message}`);
    return null;
  }
}

async function analyzeEarningsReport({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_earnings.json`);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const promptOk = cached.promptVersion === EARNINGS_PROMPT_VERSION;
      if (promptOk) {
        // 20260904b：财报解读统一为「联网 AI 分析」主路径（mode 恒为 'web'），
        // 全部按 7 天 TTL 保鲜；旧 'local' 模式缓存因 promptVersion 变更已自动失效，不会继续展示本地口径。
        if (Date.now() - new Date(cached.date).getTime() < CACHE_TTL_MS) {
          return { success: true, ...cached, cached: true };
        }
        console.log(`[AI 财报解读] ${symbol} 缓存已超 7 天 TTL，重新联网解读`);
      }
    } catch {}
  }
  let name = stockName, ind = industry;
  if (!name) {
    try { const prof = await getCompanyProfile(symbol); name = prof.companyName; ind = prof.industry; } catch {}
  }
  // ── 用途归类（20260904b）─────────────────────────────────────────────────
  // 财报解读 = 联网 AI 分析主路径：本地财务数据库取数链路存在跨公司串号污染
  // （如 600460 士兰微误读为 601318 中国平安），故不再以本地数据为事实源，
  // 统一走 modelWeb + 联网检索（webSearch=true），由系统层「身份确认」句强约束 AI 声明标的。
  // 不再调用 buildLocalEarningsContext，彻底绕过本地取数污染源。
  let modelPick, mode;
  modelPick = pickModelFor(cfg, 'web');
  mode = 'web';
  console.log(`[AI 财报解读] ${symbol} 走联网 AI 分析主路径（webSearch=${!!modelPick.webSearch}）`);
  // 20260909i：注入「确定性代码核算的单季数据与环比（已核实）」。
  // 目的① 锁死中报环比口径 = Q2单季 vs Q1单季，杜绝模型自行拿「上半年累计 vs 上一年年报」跨口径比较；
  // 目的② 给模型一组权威数字，避免其采信论坛/自媒体的数字（配合提示词的【来源分级与核实标注】）。
  const verifiedFacts = await buildVerifiedQuarterFacts(symbol);
  const messages = [
    { role: 'system', content: EARNINGS_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索该公司最新一期（最近一个已披露季度）的财报/季报/业绩预告，并做解读分析。${verifiedFacts ? '\n\n' + verifiedFacts + '\n' : ''}`,
    },
  ];
  try {
    // 20260906a：联网检索 + 长文生成常超 60s（「timeout of 60000ms exceeded」），财报解读单独放宽到 180s；不影响其他模块默认 60s
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch, timeoutMs: 180000 });
    if (!content || !content.trim()) return { success: false, error: 'EMPTY', message: 'AI 返回为空' };
    const reportPeriod = _extractReportPeriod(content);
    const earningsTarget = _extractEarningsTarget(content);
    // 20260904b：串公司检测——AI 首行声明的代码若与当前 symbol 不一致，即为疑似张冠李戴
    let targetMismatch = false, targetWarn = '';
    if (earningsTarget && earningsTarget.code && earningsTarget.code !== symbol) {
      targetMismatch = true;
      targetWarn = `解读标的疑似串公司：AI 返回代码 ${earningsTarget.code}，当前股票为 ${symbol}。请点击「重新解读」重试。`;
      console.warn(`[AI 财报解读] ${symbol} 检测到标的代码不符：AI=${earningsTarget.code}`);
    }
    // summary 去掉「报告期：...」行（标题已展示）与「标的：...」行（前端以徽标展示），避免重复。
    // 注意：AI 可能把「标的」行放在「报告期」行之前，故 reportPeriod 提取改用 /m 全行匹配，
    // 此处 strip 也独立于 reportPeriod 是否取到，始终剥离「报告期」行。
    let rawSummary = String(content).trim();
    rawSummary = rawSummary.replace(/^[^\r\n]*报告期[：:][^\r\n]*\r?\n?/m, '').trim();
    if (earningsTarget) rawSummary = rawSummary.replace(/^[^\r\n]*标的[：:][^\r\n]*\r?\n?/m, '').trim();
    // 20260904a：后置清理（折叠连续重复行 + 长度安全兜底；20260906a 起 800 字硬上限改为 1500 字兜底，AI 侧目标 ≤1000 字精简提炼），修士兰微 8 行重复 bug
    const summary = _postProcessEarningsSummary(rawSummary);
    // 结构化信号：优先解析「综合信号：N」行；缺失时按综合结论关键词启发式兜底（确保实质弱/边际向下被正确判为利空）
    const earningsSignal = _extractEarningsSignal(content);
    const verdict = _extractEarningsVerdict(content);
    const result = {
      symbol, stockName: name || symbol, summary, reportPeriod, earningsSignal, verdict, sources: extractSources(content),
      date: new Date().toISOString(), model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      // 归类溯源（20260904b）：统一为联网 AI 分析主路径
      mode,
      modelKind: modelPick.webSearch ? 'web' : 'web-noSearch',
      localDataUsed: false,
      // 20260904b：标的身份（供前端展示 + 串公司检测）
      earningsTarget,
      targetMismatch,
      targetWarn,
      promptVersion: EARNINGS_PROMPT_VERSION,
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

module.exports = {
  analyzeEarningsReport,
  buildLocalEarningsContext,
  buildQuarterlyFacts,
  formatQuarterlyFacts,
  buildVerifiedQuarterFacts,
  _extractReportPeriod,
  _extractEarningsTarget,
  _reportDateToLabel,
  _detectCitedYear,
  _extractEarningsSignal,
  _extractEarningsVerdict,
  _postProcessEarningsSummary,
};

~~~

---

## `lib\ai\images.js`  ·  151 行

~~~js
/**
 * lib/ai/images.js —— aiAugment 领域子模块：图片下载与兜底搜图（拆分重构 202609）
 * ----------------------------------------------------------------
 * downloadImage/searchCommonsImage 供 products.js 使用；attachImage 供 company.js 使用。
 * （products.js 内联了自己的下载逻辑时也不经 attachImage，与拆分前一致。）
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { UA, IMG_DIR } = require('./config');

// 下载产品图片到本地缓存（避免外链失效），失败返回 false
async function downloadImage(url, destPath) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA },
    });
    const buf = Buffer.from(resp.data);
    const ct = (resp.headers && resp.headers['content-type']) || '';
    const isImageCt = /image\//.test(ct);
    const isMagic = buf.length >= 4 && (
      (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) || // JPEG
      (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) || // PNG
      (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) // WEBP (RIFF)
    );
    if (!isImageCt && !isMagic) return false;
    if (buf.length < 500) return false;
    fs.writeFileSync(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

// 无 Key 兜底：按产品名在 Wikimedia Commons 搜索一张真实图片（仅取图片直链）
async function searchCommonsImage(query) {
  // 生成由"完整→去括号→去括号前→逐级缩写"的查询变体，提升命中率
  const base = (query || '').trim();
  const variants = [];
  if (base) variants.push(base);
  const noParen = base.replace(/[（(][^()]*[)）]/g, '').trim();
  if (noParen && noParen !== base) variants.push(noParen);
  const beforeParen = base.split(/[（(]/)[0].trim();
  if (beforeParen && beforeParen !== base && beforeParen.length >= 2) variants.push(beforeParen);
  const cn = base.replace(/[（(][^()]*[)）]/g, '').replace(/[^一-龥]/g, '');
  for (const len of [4, 3, 2]) {
    if (cn.length >= len) {
      const s = cn.slice(0, len);
      if (!variants.includes(s)) variants.push(s);
    }
  }
  // 后缀变体：品牌核心常在词尾（如「飞天茅台」→「茅台」）
  for (const len of [3, 2]) {
    if (cn.length >= len) {
      const s = cn.slice(-len);
      if (!variants.includes(s)) variants.push(s);
    }
  }
  const seen = new Set();
  for (const q of variants) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    try {
      const url = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' +
        encodeURIComponent(q) + '&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url%7Cmime&iiurlwidth=500&format=json';
      const resp = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': UA } });
      const pages = resp.data && resp.data.query && resp.data.query.pages;
      if (!pages) continue;
      for (const k of Object.keys(pages)) {
        const ii = pages[k].imageinfo && pages[k].imageinfo[0];
        if (ii && ii.thumburl && /image\//.test(ii.mime || '')) return ii.thumburl;
      }
    } catch {}
  }
  return '';
}

// 无 Key 兜底：按关键词在必应图片搜索真实产品图，返回候选直链数组（取 murl 原图，逐条由 downloadImage 校验）
// 20261012 新增：产品/原材料位原设计关闭 Commons 兜底（避免中文产品配无关图），导致 LLM 直链失效时图片位恒空。
// 必应图片（cn.bing.com/images/async）对中文商品图命中率高、无 Key，作为产品位的专用兜底；抓取为网页解析、无官方保证。
async function searchBingImages(query) {
  const base = (query || '').trim();
  if (!base) return [];
  // 查询变体：完整短语 → 去括号 → 中文前缀（4/3/2 字，如「海天酱油生产线…」→「海天酱油」），提升命中率
  const variants = [];
  if (base) variants.push(base);
  const noParen = base.replace(/[（(][^()]*[)）]/g, '').trim();
  if (noParen && noParen !== base) variants.push(noParen);
  const cn = base.replace(/[（(][^()]*[)）]/g, '').replace(/[^一-龥]/g, '');
  for (const len of [4, 3, 2]) {
    if (cn.length >= len) { const s = cn.slice(0, len); if (!variants.includes(s)) variants.push(s); }
  }
  const out = [];
  const seen = new Set();
  for (const q of variants) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    try {
      const url = 'https://cn.bing.com/images/async?q=' + encodeURIComponent(q) + '&first=0&count=8&mmasync=1';
      const resp = await axios.get(url, {
        timeout: 15000,
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      });
      const html = String(resp.data || '');
      const mAttrs = [...html.matchAll(/m="(\{[^"]*?murl[^"]*?\})"/g)].map(x => x[1]);
      for (const m of mAttrs) {
        try {
          const o = JSON.parse(m.replace(/&quot;/g, '"'));
          const u = o.murl || o.turl;
          if (u && /^https?:\/\//.test(u) && !seen.has(u)) { seen.add(u); out.push(u); if (out.length >= 6) return out; }
        } catch {}
      }
    } catch {}
  }
  return out;
}

// 通用：为某个图片候选(URL + 搜图关键词)解析出本地图片路径
// 默认：优先 AI 直链，失败则 Wikimedia Commons 兜底；
// allowCommonsFallback=false 时仅使用 AI 直链，避免 Commons 对中文公司/产品返回不相关图片。
// allowBingFallback=true 时在直链失败后走必应图片搜索（产品/原材料等实体商品位专用，候选逐个校验下载）。
async function attachImage(symbol, prefix, url, query, allowCommonsFallback = true, allowBingFallback = false) {
  const tryUrl = async (u) => {
    if (!u || !/^https?:\/\//.test(u)) return '';
    const lower = u.toLowerCase();
    const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.webp') ? 'webp' : 'jpg';
    const fname = `${symbol}_${prefix}.${ext}`;
    const fpath = path.join(IMG_DIR, fname);
    const ok = await downloadImage(u, fpath);
    return ok ? `/api/ai/img/${fname}` : '';
  };
  let local = await tryUrl(url);
  if (!local && query) {
    if (allowCommonsFallback) {
      try { const c = await searchCommonsImage(query); if (c) local = await tryUrl(c); } catch {}
    }
    if (!local && allowBingFallback) {
      try {
        const urls = await searchBingImages(query);
        for (const u of urls) { local = await tryUrl(u); if (local) break; }
      } catch {}
    }
  }
  return local;
}

module.exports = { downloadImage, searchCommonsImage, searchBingImages, attachImage };

~~~

---

## `lib\ai\llm.js`  ·  546 行

~~~js
/**
 * lib/ai/llm.js —— aiAugment 领域子模块：LLM 调用 / 模型选择 / 搜索通道 / 上下文预算 / JSON 解析
 * ----------------------------------------------------------------
 * 由 lib/aiAugment.js 拆分而来（202609 拆分重构）。
 * guardCtxBudget（原研报块）与 extractJson（原 augmentStock 块）因被 ≥6 个分析器跨块使用，上移至本模块。
 * 可变状态（搜索方式/凭据）唯一持有于 ai/config 的 runtime，本模块在调用时实时读取，禁止顶层解构值快照。
 */
const axios = require('axios');
const { mcpWebSearch, MCP_ENDPOINT, BAIDU_ENDPOINT } = require('../webSearchMcp'); // 阿里百炼(一次性2000次,本地计数保险) / 百度千帆(每日100次)
const { volcWebSearch, DEFAULT_VOLC_MODEL } = require('../volcSearch'); // 20260903n：火山豆包搜索（每月500次免费、每月重置）
const { searchNewsToText } = require('../miaoxiang'); // 20260904a：东方财富妙想资讯检索（东财公告/研报/财经新闻事实源）
const config = require('./config'); // 状态唯一持有者：调用时实时读取 config.runtime.*
const { PROVIDERS } = config;

function buildRequestBody(provider, model, messages, opts) {
  const p = PROVIDERS[provider] || PROVIDERS.qwen;
  const m = model || p.defModel;
  const body = { model: m, messages, stream: false };
  // 20261104c（用户报障：AI 解读生成失败——kimi-k3 不支持 temperature 参数）：
  // 阿里百炼（DashScope）上的 Kimi 系模型（kimi-k2/k3 等）不接受采样温度参数，传 temperature 直接 400
  //（InternalError.Algo.InvalidParameter: Parameter 'temperature'=0.3 is not supported for kimi-k3 model）。
  // 预判剔除（省一次必然失败的请求）；其他模型若也有此限制，由 postLLM 能力自学习兜底（首见记忆+重发）。
  if (!isNoTemperatureModel(m)) body.temperature = 0.3;
  const webSearch = !opts || opts.webSearch !== false; // 默认 true（联网类），显式 false 则禁用
  // webSearch=false：纯本地推理，绝不附加联网参数（用于分析已上传财报等本地数据）
  if (!webSearch) return body;
  // qwen 部分模型（如数学/代码系列）不支持 enable_search，需按模型名过滤，避免 400
  if (p.search === 'enable_search' && !isNoSearchModel(m)) {
    body.enable_search = true;
  }
  if (p.search === 'tool') {
    body.tools = [{ type: 'web_search', web_search: { search_result: true, search_query: true } }];
  }
  return body;
}

// 已知不支持 temperature（采样温度）参数的模型名（阿里百炼 Kimi 系实测 kimi-k3 拒收并 400）
function isNoTemperatureModel(modelName) {
  if (!modelName) return false;
  const name = String(modelName).toLowerCase();
  return name.startsWith('kimi-');
}

// 已知不支持联网搜索的模型名（qwen 生态）
function isNoSearchModel(modelName) {
  if (!modelName) return false;
  const name = String(modelName).toLowerCase();
  return name.includes('math') || name.includes('coder') || name.includes('vl') || name.includes('audio');
}

function extractSources(text) {
  const urls = (text.match(/https?:\/\/[^\s）)，。、]+/g) || [])
    .map((u) => u.replace(/[。，、）)]+$/, ''));
  return [...new Set(urls)].slice(0, 8);
}

/**
 * 调用大模型。
 * @param {string} provider   服务商（qwen/glm/openai）
 * @param {string} apiKey
 * @param {string} model      模型名
 * @param {Array}  messages
 * @param {Object} [opts]
 * @param {boolean} [opts.webSearch=true]  true=联网类（附加 enable_search/tools），false=本地类（绝不开联网）
 * @param {number}  [opts.timeoutMs]      单次 postLLM 的硬超时（不传默认 180000）
 * @param {number}  [opts.overallBudgetMs] 整条链路（含多次串行重试）的总耗时预算。
 *                                        20260917l 新增，**可选**：不传则行为与历史版本完全一致；
 *                                        传入后每次 postLLM 只用 min(timeoutMs, 剩余预算)，
 *                                        预算耗尽即秒级抛错（err.budgetExhausted=true），
 *                                        避免「串行多次 240s 超时 → 用户长时间拿不到结果」。
 */
// 从 messages 中提取最后一条用户消息文本，作为联网搜索词
function extractUserQuery(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      if (typeof m.content === 'string') return m.content.trim().slice(0, 200);
      if (Array.isArray(m.content)) {
        return m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ').trim().slice(0, 200);
      }
    }
  }
  return '';
}

// 将联网检索结果作为 system 上下文注入，模型据此纯推理（不再依赖内置 enable_search）
function injectSearchResults(messages, results, sourceLabel) {
  const src = sourceLabel || '外部联网搜索';
  const sys = {
    role: 'system',
    content: `以下是联网检索到的实时资料（来源：${src}，免费额度内获取）。请基于这些资料回答用户问题，引用时注明来源标题与链接：\n\n` + results,
  };
  return [sys, ...messages];
}

/**
 * 外部搜索通道定义（searchMode → 具体实现）。
 * 全部为「先取搜索结果文本 → 注入 prompt → 模型纯推理（不开 enable_search）」的解耦模式，
 * 任一通道失败都回退到模型内置 enable_search，保证功能不中断。
 */
const SEARCH_CHANNELS = {
  mcp: {
    label: '阿里云百炼「联网搜索 MCP」',
    quota: '前 2000 次调用免费（一次性总额度）',
    // 复用主 Key（百炼通用 Key，与模型调用同一把）
    getKey: (mainKey) => mainKey,
    run: (key, query) => mcpWebSearch(key, query, { endpoint: MCP_ENDPOINT, label: '阿里百炼联网搜索 MCP' }),
  },
  volc: {
    label: '火山引擎「豆包联网搜索」',
    quota: '每月 500 次免费、每月 1 日重置',
    getKey: () => config.runtime.volcKey, // 调用时实时读取（状态唯一持有于 ai/config）
    run: (key, query) => volcWebSearch(key, query, { model: config.runtime.volcModel || DEFAULT_VOLC_MODEL }),
  },
  baidu: {
    label: '百度千帆「AI 搜索 MCP」',
    quota: '每日 100 次免费、每日重置',
    getKey: () => config.runtime.baiduKey, // 调用时实时读取（状态唯一持有于 ai/config）
    run: (key, query) => mcpWebSearch(key, query, { endpoint: BAIDU_ENDPOINT, label: '百度千帆 AI 搜索 MCP' }),
  },
};

/**
 * 「总耗时预算」工具（20260917l 新增；纯计算、无副作用、可单测）。
 *
 * 背景：callLLM 内部最多会**串行**发起 4 次 postLLM（① 妙想事实纯推理 → ② 外部搜索通道纯推理 →
 * ③ 外部通道失败后的纯推理 → ④ 内置 enable_search），每次都用同一个 timeoutMs 做硬超时。
 * 单股最坏可累积到 4×240s ≈ 16 分钟，用户侧表现就是「亮点/雷点长时间无法获取」（本次投诉场景）。
 *
 * 给整条链路设一个总预算（opts.overallBudgetMs）后：每次 postLLM 只允许使用
 * min(调用方 timeoutMs, 剩余预算)；剩余预算不足 MIN_MS 时不再发起新请求，直接快速失败。
 *
 * ⚠️ 未传 overallBudgetMs 时 enabled=false、leftMs()=Infinity、expired()=false、
 *    timeoutFor() 原样返回调用方 timeoutMs —— 与历史版本**完全一致**，
 *    因此 companyDeep / valuation / earnings / research / announcements 等既有调用方行为不变。
 */
function createBudget(overallBudgetMs, opts) {
  const budget = Number(overallBudgetMs) > 0 ? Number(overallBudgetMs) : 0;
  const perCall = (opts && Number(opts.timeoutMs)) || 0;
  const startedAt = Date.now();
  const MIN_MS = 5000; // 剩余不足 5s：再试一轮也几乎必定超时，直接失败，避免用户白等
  return {
    enabled: budget > 0,
    minMs: MIN_MS,
    elapsedMs: () => Date.now() - startedAt,
    leftMs: () => (budget > 0 ? budget - (Date.now() - startedAt) : Infinity),
    expired: function () { return budget > 0 && this.leftMs() <= MIN_MS; },
    timeoutFor: function () {
      if (budget <= 0) return perCall || undefined;
      const left = this.leftMs();
      return perCall > 0 ? Math.min(perCall, left) : left;
    },
  };
}

async function callLLM(provider, apiKey, model, messages, opts) {
  const p = PROVIDERS[provider] || PROVIDERS.qwen;
  const webSearch = !opts || opts.webSearch !== false;
  // 20260917l：整条链路的总耗时预算（**仅当调用方传入 opts.overallBudgetMs 时生效**；
  // 不传则与历史行为完全一致，其他分析器零影响 —— 符合「隔离修改」铁律）。
  const budget = createBudget(opts && opts.overallBudgetMs, opts);
  // 受预算约束的 postLLM：预算已耗尽 → 立刻抛错（不再发起任何新请求，秒级返回）；
  // 否则用「min(单次超时, 剩余预算)」发起，保证整条链路不会超出总预算。
  const callBudgeted = (body) => {
    if (budget.expired()) {
      const err = new Error('AI 总耗时预算已用尽（已等待约 ' + Math.round(budget.elapsedMs() / 1000) + 's），为避免长时间无响应已中止');
      err.timeout = true;
      err.budgetExhausted = true;
      return Promise.reject(err);
    }
    return postLLM(p.url, apiKey, body, budget.timeoutFor());
  };

  // ── 东方财富妙想事实源优先（20260904a）──
  // opts.mxQuery（替换模式）：资讯类任务用。妙想返回足够内容 → 注入并纯推理（关闭 enable_search，省费且事实源为东财公告/研报/财经新闻）；
  //                           妙想无 Key/失败/内容不足 → 自动落回下方通用搜索通道/内置 enable_search，功能不中断。
  // opts.mxInject（增强模式）：妙想内容注入，但仍保留原联网搜索（如行业指数仍需联网识别代表指数代码与点位）。
  const wantMxQuery = !!(opts && opts.mxQuery && String(opts.mxQuery).trim());
  const wantMxInject = !!(opts && opts.mxInject); // 可与 mxQuery 同用：注入妙想事实块但保留通用搜索
  if ((wantMxQuery || wantMxInject) && webSearch) {
    const q = (opts && String(opts.mxQuery || '').trim()) || extractUserQuery(messages);
    if (q) {
      let mxInjected = false;
      try {
        const mxr = await searchNewsToText(q.slice(0, 200), { maxItems: 8, maxChars: 6000 });
        if (mxr && mxr.ok && mxr.text && mxr.text.length >= 120) {
          messages = injectSearchResults(messages, mxr.text, '东方财富妙想AI（东财公告/研报/财经新闻）');
          mxInjected = true;
        }
      } catch (mxErr) {
        console.warn(`[mx-first] 妙想资讯获取失败（${wantMxQuery ? 'mxQuery' : 'mxInject'}），回退通用搜索：`, mxErr && mxErr.message);
      }
      // 妙想「抓取」与大模型「推理」是两个独立环节，必须分别捕获，
      // 否则 LLM 超时会被外层 mxErr 误报成「妙想资讯获取失败」，误导排查。
      if (mxInjected && wantMxQuery) {
        try {
          // 替换模式：妙想事实已注入 → 纯推理，不再走 enable_search
          const mxBody = buildRequestBody(provider, model, messages, { webSearch: false });
          return await callBudgeted(mxBody);
        } catch (llmErr) {
          console.warn(`[mx-first] 妙想资讯已注入，但大模型推理超时/失败，回退通用搜索：`, llmErr && llmErr.message);
          // 保留已注入的妙想事实，继续走下方通用搜索补全（不重复注入妙想）
        }
      }
      // 增强模式（wantMxInject）或 mxQuery 推理失败时，消息已带妙想事实块，继续走下方通用搜索补全
    }
  }

  // 外部搜索通道（mcp/volc/baidu）：先拿搜索结果，注入 prompt，模型纯推理（不带 enable_search）
  const searchMode = config.runtime.searchMode; // 调用时实时读取（状态唯一持有于 ai/config，禁止顶层解构快照）
  const channel = SEARCH_CHANNELS[searchMode];
  // 20260916c：外部通道集合。命中其中之一时，「搜索失败/无 Key」一律降级为纯推理，
  // 绝不静默升级到 LLM 内置 enable_search（即不绕过免费 MCP 额度自行上网，杜绝阿里云静默扣费）。
  const EXTERNAL_SEARCH_MODES = ['mcp', 'volc', 'baidu'];
  let externalSearchFailed = false;
  if (channel && webSearch && apiKey) {
    const searchKey = channel.getKey(apiKey);
    const usesExternal = EXTERNAL_SEARCH_MODES.includes(searchMode);
    if (!searchKey) {
      if (usesExternal) {
        console.warn(`[search:${searchMode}] 未配置该通道的 API Key，本次仅做纯推理（不开启联网搜索，避免绕过 MCP 自行上网）`);
        externalSearchFailed = true;
      } else {
        console.warn(`[search:${searchMode}] 未配置该通道的 API Key，本次回退内置 enable_search`);
      }
    } else {
      try {
        const query = extractUserQuery(messages);
        if (query) {
          const results = await channel.run(searchKey, query);
          if (results && results.trim()) {
            const augmented = injectSearchResults(messages, results, `${channel.label}（${channel.quota}）`);
            const body = buildRequestBody(provider, model, augmented, { webSearch: false });
            return await callBudgeted(body);
          }
        }
        // 要搜但没拿到结果：外部通道 → 降级纯推理；其余 → 保持原内置路径
        if (usesExternal) externalSearchFailed = true;
      } catch (searchErr) {
        console.warn(`[search:${searchMode}] 调用失败，本次仅做纯推理（不回退内置 enable_search，避免绕过 MCP 自行上网）：`, searchErr && searchErr.message);
        if (usesExternal) externalSearchFailed = true;
      }
    }
  }

  // 20260916c：外部通道失败/无 Key → 直接纯推理，绝不带 enable_search 自行上网
  if (externalSearchFailed) {
    const body = buildRequestBody(provider, model, messages, { webSearch: false });
    return await callBudgeted(body);
  }

  const body = buildRequestBody(provider, model, messages, { webSearch });
  try {
    return await callBudgeted(body);
  } catch (e) {
    // 部分模型（如 qwen3.7-plus 等多模态/新版模型）不支持联网搜索参数，
    // 400 时自动去掉 enable_search/tools 重试一次，避免「AI 归因失败: 400」。
    // 注意：仅对原本就要联网的调用做此回退；本地类（webSearch=false）不会触发 enable_search，跳过此逻辑
    if (!webSearch) throw e;
    const hasSearchParam = body.enable_search !== undefined || Array.isArray(body.tools);
    if (hasSearchParam && e.response && e.response.status === 400) {
      const retryBody = { ...body };
      delete retryBody.enable_search;
      delete retryBody.tools;
      return await callBudgeted(retryBody);
    }
    throw e;
  }
}

// 按当前任务类型获取模型与联网开关：联网类用 modelWeb（启用 enable_search），本地类用 modelLocal（禁用）
// webSearch=false 时若未配置 modelLocal，自动降级到 modelWeb（保持功能可用，但会回退到联网）
function pickModelFor(cfg, kind) {
  if (kind === 'local') {
    return {
      model: cfg.modelLocal || cfg.modelWeb || '',
      webSearch: false,
      isLocal: !!cfg.modelLocal,
    };
  }
  // 默认/联网类
  return {
    model: cfg.modelWeb || '',
    webSearch: true,
    isLocal: false,
  };
}

// 本地文本摘要模型（20260903g，20261012 改跟随设置）：研报/公告/公司介绍/供应链这四类「文本总结」任务专用。
// qwen-math-turbo 等数学特化模型做中文摘要质量极差（复读同一句、中英混杂），
// 检测到 math 特化模型时自动改用「AI 模型设置」里的联网模型（通用模型，摘要质量合格）做纯推理，
// 不再写死具体型号（写死的模型一旦下线/无权限即全链路报错，20261011 qwen3-max-preview 事件教训）。
// 财报解读/股东户数等数字推理任务继续用 modelLocal（数学模型的本职）。
function pickLocalSummaryModel(cfg) {
  const base = pickModelFor(cfg, 'local');
  if (/math/i.test(base.model || '')) {
    return { model: cfg.modelWeb || base.model, webSearch: false, isLocal: true };
  }
  return base;
}

/**
 * 模型能力自学习（20260918b）
 * ----------------------------------------------------------------
 * 根因（2026-09-18 用户反馈「海天味业最大亮点/雷点无法获取数据」）：
 * 阿里百炼（DashScope 兼容模式）上部分模型与「非流式 + enable_search」不兼容，会让联网类 AI 功能瞬间失败：
 *   ① 仅支持流式：非流式请求直接 HTTP 400，message 形如
 *      "This model only support stream mode, please enable the stream parameter to access the model."
 *      （glm-4.5-air 实测；用户当日把「联网模型」改成该模型后即触发）；
 *   ② 不支持联网参数：带 enable_search 时以 SSE error 事件返回（HTTP 仍 200），message 形如
 *      "The parameters `enable_search` is not supported"；非流式下同样是 400。
 * 二者叠加时用户侧表现为「点 AI 生成亮点/雷点 → 5 秒内失败 → 概览卡片一直『尚未生成』」。
 * 兼容层策略：首见即记忆（进程内 Set）+ 当次立刻按正确姿势重发；下次调用一次成功，不再浪费请求。
 * 记忆仅存内存、不落盘（避免新增状态文件），重启后最多多花 1~2 次失败请求。
 * 隔离性：默认路径（非 stream-only 模型）请求体与历史完全一致，其他分析器零影响。
 */
const STREAM_ONLY_MODELS = new Set();     // 只接受 stream:true 的模型
const NO_SEARCH_PARAM_MODELS = new Set(); // 不接受 enable_search / tools 的模型
const NO_TEMPERATURE_MODELS = new Set();  // 20261104c：不接受 temperature（采样温度）参数的模型（kimi-k3 实测）

// 去掉 temperature（用于「模型不支持采样温度」的降级重发）
function _stripTemperature(body) {
  const b = Object.assign({}, body);
  delete b.temperature;
  return b;
}

// 去掉联网参数（用于「模型不支持 enable_search」的降级重发）
function _stripSearchParams(body) {
  const b = Object.assign({}, body);
  delete b.enable_search;
  delete b.tools;
  return b;
}

// 取「可读的响应体文本」，用于识别模型能力类错误
function _errText(e) {
  const d = e && e.response && e.response.data;
  if (d == null) return String((e && e.message) || '');
  if (typeof d === 'string') return d;
  try { return JSON.stringify(d); } catch (err) { return String((e && e.message) || ''); }
}

// 把 SSE 里的 error 归一化成「带 response(status=400) 的错误」，
// 让上游既有的「400 → 去掉 enable_search 重试」兜底逻辑可直接复用。
function _sseError(errorObj) {
  const msg = (errorObj && (errorObj.message || errorObj.code)) || '模型返回错误';
  const err = new Error(msg);
  err.isSseError = true;
  err.response = { status: 400, data: { error: errorObj } };
  return err;
}

// 解析 SSE（text/event-stream）响应体，按 OpenAI 兼容格式把 delta.content 拼回完整文本。
// ⚠️ 流式下模型的报错也走 SSE（HTTP 200 + data:{"error":{...}}），必须识别并抛错，
//    否则会被当成「正常但空」的回复而静默丢结果（比 400 更难排查）。
function _parseSseContent(raw) {
  const text = String(raw == null ? '' : raw);
  if (!/^\s*data:/m.test(text)) {
    // 个别网关即使 stream:true 仍返回整段 JSON：按非流式结构解析
    let j = null;
    try { j = JSON.parse(text.trim()); } catch (err) { /* 非 JSON，交由下方返回空串 */ }
    if (j && j.error) throw _sseError(j.error);
    const ch = j && j.choices && j.choices[0];
    const d = ch && (ch.message || ch.delta);
    return (d && d.content) || '';
  }
  let out = '';
  let errObj = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let j = null;
    try { j = JSON.parse(payload); } catch (err) { continue; }
    if (j && j.error) { errObj = j.error; continue; }
    const ch = j && j.choices && j.choices[0];
    const d = ch && (ch.delta || ch.message);
    if (d && typeof d.content === 'string') out += d.content;
  }
  if (!out && errObj) throw _sseError(errObj);
  return out;
}

// 单次请求（内部使用）：useStream=true 时以流式发送并解析 SSE。
async function _postOnce(url, apiKey, body, effTimeout, useStream) {
  // 全局 fetch 是 axios 多填的 polyfill（follow-redirects），其内部 60s 默认超时忽略 AbortSignal / signal，
  // 且 axios 对 https:// 链接会自动选用 fetch 适配器从而丢弃 timeout 选项 → 请求会挂到 polyfill 的 60s 内部超时，
  // 且错误常被外层 try/catch 误判。因此：① 强制 adapter:'http'（http 适配器原生尊重 timeout）；
  // ② 再叠加一个真·Node 计时器兜底，无论适配器内部如何，到 effTimeout 必 reject，保证大模型慢/不通时快速失败。
  const reqBody = useStream ? Object.assign({}, body, { stream: true }) : body;
  let hardTimer = null;
  const hardTimeout = new Promise((_, reject) => {
    hardTimer = setTimeout(() => {
      const err = new Error('大模型请求超时（' + effTimeout + 'ms 无响应），请稍后重试');
      err.timeout = true;
      reject(err);
    }, effTimeout);
  });
  try {
    const resp = await Promise.race([
      axios.post(url, reqBody, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: effTimeout,
        adapter: 'http',
        // 流式必须显式 responseType:'text'：默认 'json' 会对 SSE 文本做 JSON.parse 失败而报错
        ...(useStream ? { responseType: 'text' } : {}),
      }),
      hardTimeout,
    ]);
    if (useStream) return _parseSseContent(resp.data);
    const msg = resp.data && resp.data.choices && resp.data.choices[0] && resp.data.choices[0].message;
    let content = msg && msg.content ? msg.content : '';
    if (!content && msg && msg.tool_calls) {
      content = msg.tool_calls.map((t) => JSON.stringify(t)).join('\n');
    }
    if (!content) content = JSON.stringify(resp.data).slice(0, 2000);
    return content;
  } catch (e) {
    if (e && e.timeout) throw e; // 我方硬超时（已含明确语义），原样抛出
    if (e && e.isSseError) throw e; // 流式错误已带 response(status 400)，原样抛出供能力学习识别
    const err = new Error('大模型请求失败（' + (e && e.message || 'unknown') + '）');
    err.timeout = (e && e.timeout) || (/timeout/i.test(String(e && e.message || '')));
    // 20260918b：保留响应体/状态码 —— 上游「400 → 去掉 enable_search 重试」的兜底依赖 e.response.status，
    // 此前被此处包装丢弃（response 未透传），导致该兜底形同虚设；同时让 UI 能展示服务端返回的真实原因
    //（而非只有一句「status code 400」）。
    err.response = (e && e.response) || undefined;
    err.status = (e && e.response && e.response.status) || undefined;
    err.cause = e;
    throw err;
  } finally {
    if (hardTimer) clearTimeout(hardTimer);
  }
}

/**
 * 调用大模型（能力自学习包装层）。对外契约不变：返回模型输出的纯文本。
 * 默认超时由 60000 放宽至 180000：本环境联网推理实测单股约 90s（偶发更慢），
 * 60s 会误杀正常请求（用户反馈的「个别股亮点/雷点长时间无法获取」即此因）。
 * @param {string} url
 * @param {string} apiKey
 * @param {Object} body      已由 buildRequestBody 组装好的请求体
 * @param {number} timeoutMs 单次请求硬超时（不传默认 180000）
 */
async function postLLM(url, apiKey, body, timeoutMs) {
  const effTimeout = timeoutMs || 180000;
  const model = String((body && body.model) || '');
  let curBody = body;
  let useStream = STREAM_ONLY_MODELS.has(model);
  // 已记忆「不支持联网参数」的模型：先去掉 enable_search/tools，省掉一次必然失败的 400
  if (NO_SEARCH_PARAM_MODELS.has(model) && curBody && (curBody.enable_search !== undefined || curBody.tools)) {
    curBody = _stripSearchParams(curBody);
  }
  // 20261104c：已记忆「不支持采样温度」的模型：先去掉 temperature（kimi-k3 等传该参数直接 400）
  if (NO_TEMPERATURE_MODELS.has(model) && curBody && curBody.temperature !== undefined) {
    curBody = _stripTemperature(curBody);
  }
  // 最多 4 次尝试，每次「学到一个能力缺陷」就修正姿势后重试一次；无缺陷可学则立即抛出。
  // 用计数上限而非无限循环：即使服务端反复变更报错文案，也绝不会死循环/反复烧额度。
  let guard = 0;
  while (guard++ < 4) {
    try {
      return await _postOnce(url, apiKey, curBody, effTimeout, useStream);
    } catch (e) {
      const status = e && e.response && e.response.status;
      const text = _errText(e);
      // ① 仅支持流式（非流式 → 400）：记忆并改用流式重发
      if (!useStream && status === 400 && /only support stream mode/i.test(text)) {
        STREAM_ONLY_MODELS.add(model);
        console.warn(`[llm] 模型 ${model} 仅支持流式响应，已自动切换为 stream 模式（本次已重发，后续直接走流式）`);
        useStream = true;
        continue;
      }
      // ② 不支持 enable_search/tools（流式下以 SSE error 归一化为 400）：记忆并去掉联网参数重发
      if (curBody && (curBody.enable_search !== undefined || curBody.tools) && status === 400 && /enable_search|not support/i.test(text)) {
        NO_SEARCH_PARAM_MODELS.add(model);
        console.warn(`[llm] 模型 ${model} 不支持联网搜索参数，已自动降级为「纯推理 + 外部资讯注入」（本次已重发，后续直接降级）`);
        curBody = _stripSearchParams(curBody);
        continue;
      }
      // ③ 20261104c（用户报障：AI 解读生成失败——kimi-k3 不支持 temperature）：不支持采样温度参数
      //    （InternalError.Algo.InvalidParameter: Parameter 'temperature'=0.3 is not supported）：记忆并去掉 temperature 重发
      if (curBody && curBody.temperature !== undefined && status === 400 && /temperature/i.test(text) && /not supported|invalidparameter/i.test(text)) {
        NO_TEMPERATURE_MODELS.add(model);
        console.warn(`[llm] 模型 ${model} 不支持 temperature 采样参数，已自动剔除后重发（本次已重发，后续请求直接不带该参数）`);
        curBody = _stripTemperature(curBody);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`模型 ${model} 的能力兼容重试次数超限（已尝试 4 次）`);
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

// 本地上下文长度预算（字符）：qwen-math-turbo 输入上限仅 3072 tokens（约 3000 汉字），
// 装不下「system prompt + 近8期结构化表 + 同期 PDF 节选」；超预算时升级为 modelWeb（不开联网）。
const LOCAL_CTX_CHAR_BUDGET = { 'qwen-math-turbo': 3000, 'qwen-math-plus': 3000 };
const DEFAULT_LOCAL_CTX_CHAR_BUDGET = 6000;

// 小上下文防御（与财报解读同规则）：本地上下文超出 modelLocal 输入预算时，
// 升级为 modelWeb（仍不开联网，属于本地数据推理）；无 modelWeb 可升级则原样继续。
function guardCtxBudget(cfg, modelPick, ctxLen, tag, symbol) {
  const budget = LOCAL_CTX_CHAR_BUDGET[String(modelPick.model || '').toLowerCase()] || DEFAULT_LOCAL_CTX_CHAR_BUDGET;
  if (ctxLen <= budget) return modelPick;
  if (cfg.modelWeb && cfg.modelWeb !== modelPick.model) {
    console.log(`[${tag}] ${symbol} 本地上下文约 ${ctxLen} 字超出 ${budget} 预算，升级为 modelWeb（不联网）：${cfg.modelWeb}`);
    return { model: cfg.modelWeb, webSearch: false, isLocal: false };
  }
  console.warn(`[${tag}] ${symbol} 本地上下文约 ${ctxLen} 字超预算且无 modelWeb 可升级，仍用本地模型继续`);
  return modelPick;
}

module.exports = {
  buildRequestBody,
  isNoSearchModel,
  extractSources,
  extractUserQuery,
  injectSearchResults,
  SEARCH_CHANNELS,
  callLLM,
  pickModelFor,
  pickLocalSummaryModel,
  postLLM,
  createBudget,
  extractJson,
  guardCtxBudget,
  LOCAL_CTX_CHAR_BUDGET,
  DEFAULT_LOCAL_CTX_CHAR_BUDGET,
};

~~~

---

## `lib\ai\market.js`  ·  264 行

~~~js
/**
 * lib/ai/market.js —— aiAugment 领域子模块：大盘解读 + 行业指数（拆分重构 202609）
 * ----------------------------------------------------------------
 * _industryIndexRunning（行业指数后台任务去重锁）在本文件唯一持有。
 */
const fs = require('fs');
const path = require('path');
const { CACHE_DIR, PROVIDERS, ensureDirs, loadConfig } = require('./config');
const { callLLM, extractJson } = require('./llm');
// 20261024l：按「当前应更新到的交易日」缓存 AI 解读（周末/节假日沿用最近交易日，避免每次刷新都重调 LLM）
const { localDate } = require('../localDate');
const { asOfTradingDate } = require('../cnTradingCalendar');

// ---- 大盘/板块 AI 解读（首页滚动条） ----
const MARKET_OVERVIEW_TTL_MS = 4 * 60 * 60 * 1000; // 行情变化快，缓存 4 小时
const MARKET_OVERVIEW_PROMPT = `你是一名 A 股市场分析师。请根据用户提供的今日大盘指数、涨幅前五板块、跌幅前五板块的实时数据，并结合联网搜索到的最新宏观/政策/事件信息，分别生成一段简短的中文市场解读（用于首页滚动字幕，每段 50-100 字）。

必须只输出一段严格的 JSON，不要任何额外说明或 Markdown 代码块，格式如下：
{"cn":"对 A 股大盘整体走势的 1 句精炼点评...","gainers":"对涨幅最大板块及其上涨驱动因素的 1 句点评...","losers":"对跌幅最大板块及其下跌原因的 1 句点评..."}

要求：
1) 每段控制在 50-100 个汉字，适合横向滚动展示；
2) 基于用户给出的具体指数/板块名称和涨跌幅，不要编造无来源的数字；
3) 点评要有信息量（驱动逻辑、资金流向、政策/事件），不要仅复述涨跌；
4) 使用简体中文。`;

async function analyzeMarketOverview({ data, force, readOnly }) {
  ensureDirs();
  const cacheFile = path.join(CACHE_DIR, 'market_overview.json');
  // 20261024l：按「当前应更新到的交易日」缓存（交易日=当天，周末/节假日=最近交易日）。
  // 同一交易日内（含整个周末/长假）复用同一份 AI 解读，不再 4 小时过期；
  // 只有跨交易日或显式 force 才重新调用 LLM——避免每次页面刷新/系统更新都重新解读一次。
  const asOf = asOfTradingDate(localDate());
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 兼容旧缓存（无 asOfTradingDate 字段）：退回原 4 小时 TTL
      const sameSession = cached.asOfTradingDate
        ? cached.asOfTradingDate === asOf
        : (Date.now() - (cached.cachedAt || 0) < MARKET_OVERVIEW_TTL_MS);
      if (sameSession) {
        return { success: true, ...cached, cached: true };
      }
      if (readOnly) {
        return { success: false, cached: false };
      }
    } catch {}
  }
  if (readOnly) {
    return { success: false, cached: false };
  }

  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }

  const cn = (data && data.cn) || [];
  const sectorsUp = (data && data.sectorsUp) || [];
  const sectorsDown = (data && data.sectorsDown) || [];

  const summary = {
    cn: cn.map(i => `${i.name || i.code} ${i.changePct != null ? i.changePct.toFixed(2) + '%' : ''}`).join('，'),
    gainers: sectorsUp.slice(0, 5).map(i => `${i.name || i.code} ${i.changePct != null ? '+' + i.changePct.toFixed(2) + '%' : ''}`).join('，'),
    losers: sectorsDown.slice(0, 5).map(i => `${i.name || i.code} ${i.changePct != null ? i.changePct.toFixed(2) + '%' : ''}`).join('，'),
  };

  const userMsg = `请结合联网搜索，对以下今日 A 股行情给出三段滚动解读：
【大盘指数】${summary.cn || '暂无数据'}
【涨幅前5板块】${summary.gainers || '暂无数据'}
【跌幅前5板块】${summary.losers || '暂无数据'}`;

  try {
    // 20260904a：妙想事实源优先（东财要闻覆盖大盘/板块/宏观），失败自动回退通用搜索
    const marketMxQuery = `今日A股大盘行情解读 宏观政策事件（涨幅居前板块：${(data && data.sectorsUp || []).slice(0, 3).map(i => (i.name || i.code || '')).join('、') || '暂无'}；跌幅居前：${(data && data.sectorsDown || []).slice(0, 3).map(i => (i.name || i.code || '')).join('、') || '暂无'}）`;
    const content = await callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, [
      { role: 'system', content: MARKET_OVERVIEW_PROMPT },
      { role: 'user', content: userMsg },
    ], { webSearch: true, mxQuery: marketMxQuery });
    const parsed = extractJson(content) || {};
    const result = {
      cn: String(parsed.cn || '').trim(),
      gainers: String(parsed.gainers || '').trim(),
      losers: String(parsed.losers || '').trim(),
      model: cfg.modelWeb || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      date: new Date().toISOString(),
      cachedAt: Date.now(),
      // 溯源：妙想命中时为 mx-first，回退时为空
      factSource: '东方财富妙想AI',
      asOfTradingDate: asOf, // 20261024l：该解读归属的交易日（周末/节假日=最近交易日），用于缓存与大盘记录
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

// ---- 行业板块指数（AI 联网搜索） ----
const INDUSTRY_INDEX_TTL_MS = 24 * 60 * 60 * 1000; // 指数数据时效性强，缓存 1 天

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}
function industryIndexCacheFile(induCode, industryName) {
  const key = induCode ? String(induCode) : safeName(industryName || 'unknown');
  return path.join(CACHE_DIR, `industry_index_${key}.json`);
}
function readIndustryIndexCache(induCode, industryName) {
  try {
    const f = industryIndexCacheFile(induCode, industryName);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

// 20260913d：运行状态「侧车」文件（running / error）。
// 关键修复（行业指数 AI 内容打开页面经常丢失）：
//   旧逻辑把后台任务的 running 占位、以及失败时的 error 直接写进主缓存
//   industry_index_<key>.json，会把这行业上一次成功的 AI 分析「就地覆盖」掉。
//   后果有三：① 刷新进行中时打开页面看到"正在获取"而非上次内容；② 刷新失败后
//   内容永久丢失；③ 进程中途重启则缓存永久卡在 running（无任务在跑，轮询必然超时）。
//   现在主缓存**只保留最近一次成功结果**，running/error 一律写侧车文件，内容永不消失。
function industryIndexStatusFile(induCode, industryName) {
  const key = induCode ? String(induCode) : safeName(industryName || 'unknown');
  return path.join(CACHE_DIR, `industry_index_${key}.status.json`);
}
function readIndustryIndexState(induCode, industryName) {
  try {
    const f = industryIndexStatusFile(induCode, industryName);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}
function writeIndustryIndexState(induCode, industryName, obj) {
  try {
    fs.writeFileSync(industryIndexStatusFile(induCode, industryName), JSON.stringify(obj, null, 2), 'utf8');
  } catch { /* ignore */ }
}
function clearIndustryIndexState(induCode, industryName) {
  try { fs.unlinkSync(industryIndexStatusFile(induCode, industryName)); } catch { /* ignore */ }
}
// 后台任务超过该时长仍标记 running，视为「僵死」（多半是进程重启导致任务丢失），
// 此时允许前端重新触发，避免永久卡在进行中。
const STALE_RUNNING_MS = 3 * 60 * 1000;

const INDUSTRY_INDEX_PROMPT = `你是一名专业的行业指数研究员，熟悉 A 股的申万行业指数、中证行业/主题指数、国证行业指数等。用户会给你一个行业名称（可能含申万一级/二级行业、证监会细分行业、东方财富行业分类）。请利用联网搜索，找到代表该行业的板块指数，并给出指数的表现与走势分析。

要求：
1) 只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记，格式如下：
{"indexName":"代表性行业指数名称(如'中证白酒指数')","indexCode":"指数代码(如'399997',不确定填\"\")","currentLevel":"当前点位(如'约 13200 点'或'13245.6',确实查不到填\"\")","asOf":"数据日期(YYYY-MM-DD,尽量用最近交易日)","ytdChangePct":"年初至今涨跌幅(如'+12.3%'或'-5.6%',确实查不到填\"\")","recentTrend":"近3-6个月该行业指数走势描述(2-4句,含关键拐点与驱动)","keyDrivers":["驱动因素1","驱动因素2","驱动因素3"],"outlook":"后市展望与风险(2-4句)","valuationNote":"当前估值/历史分位说明(1-2句,无则填\"\")","source":"数据来源(如'中证指数公司/东方财富/Wind,数据截至 YYYY-MM-DD')"}

2) indexName 应是该行业最具代表性的行业/主题指数；若有多只(如申万行业指数与中证主题指数),优先选流动性与代表性最好的那只。
3) 数字务必基于联网搜索到的公开数据，不要编造；若确实查不到精确点位或涨跌幅，对应字段填 ""，并在 recentTrend 中说明"未能获取精确数据，以下为定性判断"。
4) keyDrivers 列 2-4 条核心驱动（政策/景气/资金/供需/估值修复等）。
5) 使用简体中文。`;

// 进程内去重锁：避免同一行业被并发触发多次后台生成（覆盖写缓存）。本文件唯一持有。
const _industryIndexRunning = new Set();

async function analyzeIndustryIndex({ symbol, industryName, induName, induCode, force, background }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = industryIndexCacheFile(induCode, industryName);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 20260913d：兼容旧版遗留的 running/error 缓存（旧逻辑会写进主缓存），只认 done
      if (cached.status === 'done' && Date.now() - (cached.cachedAt || 0) < INDUSTRY_INDEX_TTL_MS) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }

  const indLabel = [induName, industryName].filter(Boolean).join(' / ') || (symbol || '该行业');
  const userMsg = `请联网搜索并分析以下行业的代表板块指数表现：行业 = ${indLabel}${induCode ? '（东方财富行业代码 ' + induCode + '）' : ''}。请按 JSON 输出该行业板块指数的名称、代码、当前点位、年初至今涨跌幅、近期走势、核心驱动、后市展望与估值分位。`;
  const messages = [
    { role: 'system', content: INDUSTRY_INDEX_PROMPT },
    { role: 'user', content: userMsg },
  ];

  const runJob = async () => {
    try {
      // 20260904a：妙想行业资讯增强（驱动/景气/政策），仍保留通用搜索（识别代表指数代码/点位需要）
      const industryMxQuery = `行业板块「${indLabel}」指数 近期走势 核心驱动 政策 资金`;
      const content = await callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, messages, { webSearch: true, mxInject: true, mxQuery: industryMxQuery });
      const parsed = extractJson(content) || {};
      const result = {
        status: 'done',
        symbol: symbol || '',
        indexName: String(parsed.indexName || '').trim(),
        indexCode: String(parsed.indexCode || '').trim(),
        currentLevel: String(parsed.currentLevel || '').trim(),
        asOf: String(parsed.asOf || '').trim(),
        ytdChangePct: String(parsed.ytdChangePct || '').trim(),
        recentTrend: String(parsed.recentTrend || '').trim(),
        keyDrivers: Array.isArray(parsed.keyDrivers) ? parsed.keyDrivers.map(d => String(d).trim()).filter(Boolean).slice(0, 5) : [],
        outlook: String(parsed.outlook || '').trim(),
        valuationNote: String(parsed.valuationNote || '').trim(),
        source: String(parsed.source || '').trim(),
        model: cfg.modelWeb || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
        date: new Date().toISOString(),
        cachedAt: Date.now(),
      };
      // 20260913d：只写主缓存（= 最近一次成功结果），并清掉运行状态侧车
      try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
      clearIndustryIndexState(induCode, industryName);
      return result;
    } catch (e) {
      const status = e.response && e.response.status;
      const data = e.response && e.response.data;
      let message = e.message;
      if (data) {
        if (typeof data === 'string') message = data.slice(0, 300);
        else if (data.message) message = data.message;
        else if (data.error && data.error.message) message = data.error.message;
      }
      // 20260913d：失败只写侧车，**绝不覆盖主缓存**——上次成功内容继续可用
      writeIndustryIndexState(induCode, industryName, { status: 'error', error: 'API_ERROR', statusCode: status, message, symbol: symbol || '', at: Date.now() });
      return { status: 'error', error: 'API_ERROR', statusCode: status, message, symbol: symbol || '' };
    }
  };

  // 后台模式：立即返回，真正的生成在后台异步完成；前端通过轮询 GET 读取 running / done / error 状态。
  // 即使前端断开（切页面/切股票/刷新），Node 进程仍会继续把结果写入缓存。
  if (background) {
    const lockKey = induCode ? String(induCode) : safeName(industryName);
    if (_industryIndexRunning.has(lockKey)) {
      return { success: true, started: false, running: true, status: 'running', background: true };
    }
    // 20260913d：running 占位写「侧车」文件，不碰主缓存 —— 刷新期间旧内容照常可读
    const prev = readIndustryIndexCache(induCode, industryName);
    writeIndustryIndexState(induCode, industryName, { status: 'running', startedAt: Date.now(), symbol: symbol || '', hasContent: !!(prev && prev.status === 'done') });
    _industryIndexRunning.add(lockKey);
    runJob().finally(() => { _industryIndexRunning.delete(lockKey); });
    return { success: true, started: true, status: 'running', background: true, hasContent: !!(prev && prev.status === 'done') };
  }

  // 同步模式（保留兼容）：等待生成完成后再返回
  await runJob();
  const final = readIndustryIndexCache(induCode, industryName);
  if (final && final.status === 'done') return { success: true, ...final, cached: false };
  const state = readIndustryIndexState(induCode, industryName);
  if (state && state.status === 'error') return { success: false, error: state.error, message: state.message };
  return { success: false, error: 'EMPTY', message: '未生成数据' };
}

module.exports = { analyzeMarketOverview, analyzeIndustryIndex, readIndustryIndexCache, readIndustryIndexState, STALE_RUNNING_MS };

~~~

---

## `lib\ai\research.js`  ·  200 行

~~~js
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

~~~

---

## `lib\ai\valuation.js`  ·  455 行

~~~js
/**
 * lib/ai/valuation.js —— aiAugment 领域子模块：AI 估值（拆分重构 202609）
 * ----------------------------------------------------------------
 * 20260905k：历史财务优先走本地财报数据库（buildLocalEarningsContext：近8期结构化财务+年报PDF节选，
 * 与财报解读同源），实时行情/可比公司/宏观保留联网搜索；数据库未覆盖该标的时自动纯联网并标注"补抓"。
 * VALUATION_VER 随缓存门控语义迁至 ai/cache.js，本模块反向 require。
 * 注意：深度分析磁盘缓存目录 data/cache/deep-analysis 的 path.join 层级已随 __dirname 变化 +1
 * （lib/ → lib/ai/），最终字符串与拆分前逐字节一致。
 */
const fs = require('fs');
const path = require('path');
const { getCompanyProfile } = require('../shareholderData');
const { CACHE_DIR, SEMI_STATIC_TTL_MS, PROVIDERS, loadPromptFile, ensureDirs, loadConfig } = require('./config');
const { callLLM, pickModelFor } = require('./llm');
const { VALUATION_VER } = require('./cache');
const { buildLocalEarningsContext } = require('./earnings');
const { localDate, localCompact, localDateFromTs } = require('../localDate');

async function analyzeValuation({ symbol, stockName, industry, force, companyName }) {
  ensureDirs();
  // ===== 个股专属估值模型（20260908b）：601318 走确定性计算，绝不读旧 AI 缓存、绝不调用 LLM =====
  // 放在最前：连 apiKey 都不依赖。数据锁死 ⇒ 结果唯一（1+1=2），与 AI 模型选择无关。
  const bareSym = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (bareSym === '601318') {
    const paModel = require('../valuation/pingAn601318.js');
    const paCfg = paModel.loadInputs();
    if (paCfg) {
      let name60 = stockName || companyName || '中国平安';
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote('sh601318');
        if (q && q.price) {
          // 20261029c：数据时效规则——实时覆盖 P 时同步写 asOf=当日（P 为实时量，取数日期即运行日）
          paCfg.inputs.P = Object.assign({}, paCfg.inputs.P, { value: q.price, source: `实时行情(腾讯) ${q.date || ''}`, asOf: localDate() });
          if (q.name) name60 = q.name;
        }
      } catch (e) { /* 取不到实时价则用配置中的收盘价 */ }
      const r = paModel.compute(paCfg);
      if (r && r.ok) {
        return {
          success: true, dedicated: true, symbol: '601318', stockName: name60,
          date: new Date().toISOString(), reportDate: r.reportDate, reportLabel: r.reportLabel,
          rating: r.rating, fairValueRange: r.fairValueRange, fairValueCenter: r.fairValueCenter,
          focusRange: r.focusRange, rows: r.summaryRows, summaryRows: r.summaryRows, methodsUsed: r.methodsUsed,
          sotpDetails: r.sotpDetails, ddmDetails: r.ddmDetails, pevDetails: r.pevDetails,
          fvociDetails: r.fvociDetails, synthBasis: r.synthBasis, remarks: r.remarks,
          noPeriodVars: r.noPeriodVars, periodAnnotation: r.periodAnnotation,
          missing: r.missing, zeroFilled: r.zeroFilled, skippedBranches: r.skippedBranches, notSplit: r.notSplit,
          sotpDegraded: r.sotpDegraded, sotpSkipped: r.sotpSkipped, sotpSkipReason: r.sotpSkipReason, sotpAnomaly: r.sotpAnomaly,
          alerts: r.alerts, freshnessRows: r.freshnessRows || [], reportPeriod: r.reportPeriod,
          raw: r.raw, model: 'pingAnRolling_v3（滚动估值协议·确定性计算，无AI参与）', ver: 'DEDICATED',
        };
      }
      // 专属模型计算失败才回退旧 AI 流程（理论上配置文件在就不会发生）
      console.warn('[AI 估值] 601318 专属模型失败，回退旧流程:', r && r.error);
    }
  }
  // ===== 券商专属「分类+估值」（20260908l）：仅限 data/valuation/{symbol}.json kind==='broker' 的标的 =====
  // 闸门在配置文件：未配置券商模型的股票一律不走本分支（其他类型公司零改动）。
  try {
    const brokerModel = require('../valuation/brokerModel');
    if (brokerModel.isBrokerModel(bareSym)) {
      let price = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
      } catch (e) { /* 取不到实时价则评级为 N/A */ }
      const br = brokerModel.run(bareSym, { price });
      if (br && br.ok) {
        return Object.assign({}, br, {
          success: true, dedicated: true,
          stockName: stockName || companyName || (brokerModel.loadInputs(bareSym) || {}).name || '',
        });
      }
      console.warn('[AI 估值] 券商专属模型失败，回退旧流程:', br && br.message);
    }
  } catch (e) { console.warn('[AI 估值] 券商专属模型加载失败:', e.message); }
  // ===== 圣湘生物专属「六模型交叉验证」（20260908n）：data/valuation/688289.json kind==='sanxi' 闸门 =====
  // SOTP 35% + 修正动态PE 25% + PS 12% + DCF 10% + EV/EBITDA 10% + rNPV 8%，乐观/基准/保守三情景。
  try {
    const sanxiModel = require('../valuation/sanxi688289.js');
    if (sanxiModel.isSanxiModel(bareSym)) {
      let price = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
      } catch (e) { /* 取不到实时价则评级为 N/A */ }
      const sx = await sanxiModel.run(bareSym, { price });
      if (sx && sx.ok) {
        return Object.assign({}, sx, {
          success: true, dedicated: true, date: new Date().toISOString(),
          stockName: stockName || companyName || sx.stockName,
          ver: 'DEDICATED',
        });
      }
      console.warn('[AI 估值] 圣湘专属模型失败，回退旧流程:', sx && sx.error);
    }
  } catch (e) { console.warn('[AI 估值] 圣湘专属模型加载失败:', e.message); }
  // ===== 海天味业专属「动态估值引擎」（20260908o）：data/valuation/603288.json kind==='haitian' 闸门 =====
  // 绝对估值锚定（DCF 50%）+ 相对估值校准（动态PE 50%）+ 三情景压力测试，确定性计算。
  try {
    const haitianModel = require('../valuation/haitian603288.js');
    if (haitianModel.isHaitianModel(bareSym)) {
      let price = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
      } catch (e) { /* 取不到实时价则评级为 N/A */ }
      // 20261029n：V3.0 全量重算架构 → run 改 async（每次实时拉三表，禁读缓存）
      const ht = await haitianModel.run(bareSym, { price });
      if (ht && ht.ok) {
        return Object.assign({}, ht, {
          success: true, dedicated: true, date: new Date().toISOString(),
          stockName: stockName || companyName || ht.stockName,
          ver: 'DEDICATED',
        });
      }
      console.warn('[AI 估值] 海天专属模型失败，回退旧流程:', ht && ht.error);
    }
  } catch (e) { console.warn('[AI 估值] 海天专属模型加载失败:', e.message); }
  // ===== 士兰微专属估值模型（20260908p）：data/valuation/600460.json kind==='silan' 闸门 =====
  // PE三年加权 + PB + PS(辅助) + DCF五年显性 + WACC×g敏感性矩阵，盈利波动权重（DCF50%+PB30%+PE20%）。
  try {
    const silanModel = require('../valuation/silan600460.js');
    if (silanModel.isSilanModel(bareSym)) {
      let price = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
      } catch (e) { /* 取不到实时价则评级为 N/A */ }
      const sl = await silanModel.run(bareSym, { price }); // 20261029q 数据治理升级版改 async（三表实时拉取）
      if (sl && sl.ok) {
        return Object.assign({}, sl, {
          success: true, dedicated: true, date: new Date().toISOString(),
          stockName: stockName || companyName || sl.stockName,
          ver: 'DEDICATED',
        });
      }
      console.warn('[AI 估值] 士兰专属模型失败，回退旧流程:', sl && sl.error);
    }
  } catch (e) { console.warn('[AI 估值] 士兰专属模型加载失败:', e.message); }
  // ===== 华安证券专属「动态估值框架 V2.0」（20260908t）：data/valuation/600909.json kind==='huaan' 闸门 =====
  // 守门员自检 + 口径分离 + PB法60% + SOTP法30%（长鑫市值×80%）+ PE法10%（仅常态EPS）。
  // 20260908q 起 600909 从券商通用模型剥离（config kind 不再是 'broker'），改走本专用模型；20260908t 升级为 V2.0。
  try {
    const huaanModel = require('../valuation/huaan600909.js');
    if (huaanModel.isHuaanModel(bareSym)) {
      let price = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
      } catch (e) { /* 取不到实时价则评级为 N/A */ }
      const ha = await huaanModel.run(bareSym, { price });
      if (ha && ha.ok) {
        return Object.assign({}, ha, {
          success: true, dedicated: true, date: new Date().toISOString(),
          stockName: stockName || companyName || ha.stockName,
          ver: 'DEDICATED',
        });
      }
      console.warn('[AI 估值] 华安专属模型失败，回退旧流程:', ha && ha.error);
    }
  } catch (e) { console.warn('[AI 估值] 华安专属模型加载失败:', e.message); }
  // ===== 长江证券专属「PB-ROE动态估值引擎」（20260908r）：data/valuation/000783.json kind==='changjiang' 闸门 =====
  // PB-ROE主模型（BVPS×PB三维锚定）+ SOTP四分部交叉验证 + 折溢价评级 + 买卖信号。
  // 20260908r 起 000783 从券商通用模型剥离（config kind 不再是 'broker'），改走本专用模型。
  try {
    const cjModel = require('../valuation/changjiang000783.js');
    if (cjModel.isChangjiangModel(bareSym)) {
      let price = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
      } catch (e) { /* 取不到实时价则评级为 N/A */ }
      // 20261029o：V3-五法则 全量重算架构 → run 改 async（每次实时拉三表，刚性层取最新报告期）
      const cj = await cjModel.run(bareSym, { price });
      if (cj && cj.ok) {
        return Object.assign({}, cj, {
          success: true, dedicated: true, date: new Date().toISOString(),
          stockName: stockName || companyName || cj.stockName,
          ver: 'DEDICATED',
        });
      }
      console.warn('[AI 估值] 长江专属模型失败，回退旧流程:', cj && cj.error);
    }
  } catch (e) { console.warn('[AI 估值] 长江专属模型加载失败:', e.message); }
  // ===== 麦捷科技专属「动态逻辑估值模型 V1.0」（20260909b）：data/valuation/300319.json kind==='maijie' 闸门 =====
  // 时间引擎 + 画像诊断 + 三情景（基准60/乐观20/悲观20）+ 四路估值（PE30/PB-ROE25/EV-EBITDA20/DCF25）
  // + 相对/绝对交叉验证 + 安全边际 + 三档评级（低估/合理/高估）。
  try {
    const mjModel = require('../valuation/maijie300319.js');
    if (mjModel.isMaijieModel(bareSym)) {
      let price = null, pe = null, pb = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
        if (q && q.pe) pe = q.pe;
        if (q && q.pb) pb = q.pb;
      } catch (e) { /* 取不到实时价则评级为 N/A */ }
      const mj = mjModel.run(bareSym, { price, pe, pb });
      if (mj && mj.ok) {
        return Object.assign({}, mj, {
          success: true, dedicated: true, date: new Date().toISOString(),
          stockName: stockName || companyName || mj.stockName,
          ver: 'DEDICATED',
        });
      }
      console.warn('[AI 估值] 麦捷专属模型失败，回退旧流程:', mj && mj.error);
    }
  } catch (e) { console.warn('[AI 估值] 麦捷专属模型加载失败:', e.message); }
  // ===== 电气风电专属「动态周期估值模型 DCAVM v1.0」（20260909h）：data/valuation/688660.json kind==='dcavm' 闸门 =====
  // 针对风电设备强周期、TTM PE 常为负：景气周期评分 + 归一化盈利 + 三阶段FCFF·DCF + 相对(PE/PB-ROE/EV-EBITDA/EV-Sales) + SOTP + 订单辅助 + 周期阶段动态加权合成。
  try {
    const dcavmModel = require('../valuation/dcavm688660.js');
    if (dcavmModel.isDcavmModel(bareSym)) {
      let price = null, pe = null, pb = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
        if (q && q.pe) pe = q.pe;
        if (q && q.pb) pb = q.pb;
      } catch (e) { /* 取不到实时价则评级为 N/A */ }
      const dv = dcavmModel.run(bareSym, { price, pe, pb });
      if (dv && dv.ok) {
        return Object.assign({}, dv, {
          success: true, dedicated: true, date: new Date().toISOString(),
          stockName: stockName || companyName || dv.stockName,
          ver: 'DEDICATED',
        });
      }
      console.warn('[AI 估值] 电气风电 DCAVM 专属模型失败，回退旧流程:', dv && dv.error);
    }
  } catch (e) { console.warn('[AI 估值] 电气风电 DCAVM 专属模型加载失败:', e.message); }

  // ===== 20260916g：新洋丰（000902）专属「永久逻辑」估值引擎 =====
  // 指令要点：逻辑框架永久不变、参数按最新财报/公告动态更新；正常化盈利为锚（禁止单一年份 PE）；
  // 分部优先再汇总（磷复肥主业 / 磷矿资源增量 / 磷酸铁与精细化工）；
  // 模块 A 正常化PE(主) / B PB-ROE(交叉) / C DCF(参考) / D 磷矿资源期权(独立) / E 磷酸铁(期权)；
  // 三情景（悲观/基准/乐观）+ 敏感性 + 失效预警。全部确定性计算，不调用 LLM。
  try {
    const xyfModel = require('../valuation/xinyangfeng000902.js');
    if (xyfModel.isXinyangfengModel(bareSym)) {
      let price = null, pe = null, pb = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
        if (q && q.pe) pe = q.pe;
        if (q && q.pb) pb = q.pb;
      } catch (e) { /* 取不到实时价则评级为 N/A，仅输出区间 */ }
      const xy = xyfModel.run(bareSym, { price, pe, pb });
      if (xy && xy.ok) {
        return Object.assign({}, xy, {
          success: true, dedicated: true, date: new Date().toISOString(),
          stockName: stockName || companyName || xy.stockName,
          ver: 'DEDICATED',
        });
      }
      console.warn('[AI 估值] 新洋丰专属模型失败，回退旧流程:', xy && xy.error);
    }
  } catch (e) { console.warn('[AI 估值] 新洋丰专属模型加载失败:', e.message); }

  // ===== 20260919f：万润股份（002643）专属「永久逻辑」估值引擎 =====
  // 依《万润股份永久有效逻辑估值模型》：三层加权 PB-ROE 50% / PE 35% / DCF 15%；
  // 五业务单元（显示/环保/半导体/生命科学/新能源）仅叙事、新能源按期权价值不单独估值；
  // 防失真规则（汇兑剥离/季报ROE八折/股本追踪/分歧预警>50%/大客户/汇率/新产能）。全部确定性计算，不调用 LLM。
  try {
    const wrModel = require('../valuation/wanrun002643.js');
    if (wrModel.isWanrunModel(bareSym)) {
      let price = null, pe = null, pb = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
        if (q && q.pe) pe = q.pe;
        if (q && q.pb) pb = q.pb;
      } catch (e) { /* 取不到实时价则评级为 N/A，仅输出区间 */ }
      // 20261029s：v2.0 数据频率自适应版 → run 改 async（每次实时拉东财三表，禁读静态配置估值）
      const wr = await wrModel.run(bareSym, { price, pe, pb });
      if (wr && wr.ok) {
        return Object.assign({}, wr, {
          success: true, dedicated: true, date: new Date().toISOString(),
          stockName: stockName || companyName || wr.stockName,
          ver: 'DEDICATED',
        });
      }
      console.warn('[AI 估值] 万润专属模型失败，回退旧流程:', wr && wr.error);
    }
  } catch (e) { console.warn('[AI 估值] 万润专属模型加载失败:', e.message); }

  // ===== 20261104i：威高血净（603014）专属「动态估值引擎」（九指令整合版） =====
  // 并表状态 P/C/F 识别 → 三口径桥接 → 新鲜度分级 → 核心矩阵 → 承诺追踪 → DCF 分部三档 →
  // 协同期权（独立）→ 相对估值交叉 → PE 归因 → 对价检验 → 指令九 11 节输出。全部确定性计算，不调用 LLM。
  try {
    const wgModel = require('../valuation/weigao603014.js');
    if (wgModel.isWeigaoModel(bareSym)) {
      let price = null, pe = null, pb = null;
      try {
        const { getQuote } = require('../stockData');
        const q = await getQuote(symbol);
        if (q && q.price) price = q.price;
        if (q && q.pe) pe = q.pe;
        if (q && q.pb) pb = q.pb;
      } catch (e) { /* 取不到实时价则用配置快照价 */ }
      const wg = wgModel.run(bareSym, { price, pe, pb });
      if (wg && wg.ok) {
        return Object.assign({}, wg, {
          success: true, dedicated: true, date: new Date().toISOString(),
          stockName: stockName || companyName || wg.stockName,
          ver: 'DEDICATED',
        });
      }
      console.warn('[AI 估值] 威高血净专属模型失败，回退旧流程:', wg && wg.error);
    }
  } catch (e) { console.warn('[AI 估值] 威高血净专属模型加载失败:', e.message); }

  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_valuation.json`);
  let name = stockName || companyName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }
  // 本地财报数据库上下文（与财报解读模块同源；PDF 节选 12000 字，控制上下文体积）
  const localFin = await buildLocalEarningsContext(symbol, { pdfCharCap: 12000 }).catch(() => ({ ok: false }));
  const factAnchor = localFin.ok ? String(localFin.reportDate || '') : '';
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const ttlOk = Date.now() - new Date(cached.date).getTime() < SEMI_STATIC_TTL_MS;
      // v2 锚点联动：本地财报期变化（新一期财报入库）即视为过期，避免缓存里历史财务长期不更新
      const anchorOk = !localFin.ok || (cached.ver === VALUATION_VER && cached.factAnchor === factAnchor);
      if (ttlOk && anchorOk && cached.ver === VALUATION_VER) {
        return { success: true, ...cached, cached: true };
      }
    } catch {}
  }
  const systemPrompt = loadPromptFile('valuation-system.md');
  const modelPick = pickModelFor(cfg, 'web');
  const localBlock = localFin.ok
    ? `\n\n————【本地财报数据 · 来自工作台年报数据库】————\n${localFin.text}\n————（以上为本地年报数据库注入，历史财务必须优先引用本块，来源标注"年报数据库"）————`
    : `\n\n（注：本地年报数据库暂未覆盖该标的，历史财务请用上网搜索补抓，来源标注"补抓（上网搜索）+日期"。）`;
  // 20260905l：融合模式——读取工作台规则估值模型结论（深度分析磁盘缓存），注入给 AI 交叉验证
  // 20260906（v4）：同一缓存复用【最新财报解读】——该模块已联网检索过一次财务数据，直接注入供引用，免同批数据重复上网（省 token）
  let ruleBlock = '';
  let earningsBlock = '';
  try {
    const dir = path.join(__dirname, '..', '..', 'data', 'cache', 'deep-analysis');
    const bare = String(symbol).replace(/^(sh|sz|bj)/i, '');
    const candidates = [path.join(dir, `${symbol}.json`), path.join(dir, `${bare}.json`)];
    let cachedDeep = null;
    for (const p of candidates) {
      if (fs.existsSync(p)) { cachedDeep = JSON.parse(fs.readFileSync(p, 'utf8')); break; }
    }
    const er = cachedDeep && cachedDeep.sections && cachedDeep.sections.earningsReport;
    if (er && er.summary) {
      earningsBlock = `\n\n————【最新财报解读 · 来自工作台财报解读模块（已联网检索，同批数据直接引用，勿重复上网搜索）】————\n${String(er.summary).slice(0, 2500)}`;
      console.log(`[AI 估值] ${symbol} 已注入财报解读摘要（复用已检索数据，免重复上网）`);
    }
    const cc = cachedDeep && cachedDeep.sections && cachedDeep.sections.conclusion;
    if (cc && cc.overallRating && cc.overallRating !== '数据不足') {
      const ruleDate = cachedDeep.cachedAt ? localDate(cachedDeep.cachedAt) : '未知';
      const fmtV = v => (v != null && isFinite(Number(v))) ? Number(v).toFixed(2) : '--';
      const lines = [];
      lines.push(`综合估值评级：${cc.overallRating}${cc.companyTypeName ? `（${cc.companyTypeName}）` : ''}`);
      if (Array.isArray(cc.ratings) && cc.ratings.length) {
        lines.push('各方法明细（确定性规则计算）：');
        cc.ratings.forEach(r => {
          let l = `- ${r.method}（权重 ${r.weight != null ? Math.round(r.weight * 100) + '%' : '--'}）：评级 ${r.rating}`;
          if (r.fairValue != null && isFinite(Number(r.fairValue))) l += `，合理估值 ¥${fmtV(r.fairValue)}`;
          if (Array.isArray(r.fairValueRange) && r.fairValueRange.length === 2) l += `，合理区间 ¥${fmtV(r.fairValueRange[0])} ~ ¥${fmtV(r.fairValueRange[1])}`;
          if (r.detail) l += `；${String(r.detail).slice(0, 200)}`;
          lines.push(l);
        });
      }
      if (Array.isArray(cc.fairValueRange) && cc.fairValueRange.length === 2) {
        lines.push(`综合合理估值区间：¥${fmtV(cc.fairValueRange[0])} ~ ¥${fmtV(cc.fairValueRange[1])}${cc.fairValueCenter != null ? `（中枢 ¥${fmtV(cc.fairValueCenter)}）` : ''}`);
      }
      if (cc.currentPrice != null && isFinite(Number(cc.currentPrice))) lines.push(`规则模型所用当前股价：¥${fmtV(cc.currentPrice)}`);
      if (cc.conclusionText) lines.push('规则模型结论文本（节选）：\n' + String(cc.conclusionText).slice(0, 1500));
      ruleBlock = `\n\n————【工作台规则估值模型计算结果】（内置确定性规则引擎，生成于 ${ruleDate}）————\n${lines.join('\n')}\n————（请对你的估值结果与上述规则模型结果交叉验证：方向与区间基本一致时在【当前判断】中明确说明"与工作台规则模型结论一致"以增强置信度；存在矛盾时必须解释差异原因（方法选择/参数假设/数据口径），给出你更认可的一方及理由；不得直接照抄规则模型数字，也不得无视矛盾）————`;
      console.log(`[AI 估值] ${symbol} 已注入规则估值模型结论（缓存 ${ruleDate}）`);
    } else {
      console.log(`[AI 估值] ${symbol} 深度分析缓存无规则估值结论，AI 独立估值`);
    }
  } catch (e) {
    console.warn('[AI 估值] 规则模型结论读取失败（不影响估值主流程）:', e.message);
  }
  const mode = localFin.ok ? 'local+web' : 'web';
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `请对以下 A 股上市公司做估值分析：\n公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。${localBlock}${earningsBlock}${ruleBlock}\n\n请用【上网搜索】仅补足上述注入块未覆盖的实时数据（最新行情、可比公司估值与宏观利率），严格按你的系统提示词中的"输出模板"给出结构化结论（内在价值区间 / 当前判断 / 安全边际 / 主要风险），并在每条数据后标注来源与日期。` },
  ];
  try {
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: true, timeoutMs: 180000 }); // 估值任务联网+长上下文+长输出，放宽至 3 分钟
    const result = {
      symbol,
      stockName: name || symbol,
      industry: ind || '',
      content: String(content || '').trim(),
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.webSearch ? 'web' : 'web-noSearch',
      localDataUsed: localFin.ok,
      factAnchor,
      ver: VALUATION_VER,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    let message = e.message;
    if (status === 400) message = '模型不支持该请求（400），请检查 AI 设置中的模型是否支持联网搜索。';
    else if (status === 401 || status === 403) message = 'API Key 无效或未授权（' + status + '），请检查 AI 设置。';
    return { success: false, error: 'LLM_ERROR', status, message, raw: (e.response && e.response.data ? JSON.stringify(e.response.data) : '').slice(0, 400) };
  }
}

/** 该标的是否拥有专属确定性估值模型（601318 平安 / 券商 / 688289 圣湘 / 603288 海天 / 600460 士兰），供路由闸门使用 */
function hasDedicatedValuation(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (bare === '601318') return true;
  try {
    if (require('../valuation/brokerModel').isBrokerModel(bare)) return true;
    if (require('../valuation/sanxi688289.js').isSanxiModel(bare)) return true;
    if (require('../valuation/haitian603288.js').isHaitianModel(bare)) return true;
    if (require('../valuation/silan600460.js').isSilanModel(bare)) return true;
    if (require('../valuation/huaan600909.js').isHuaanModel(bare)) return true;
    if (require('../valuation/changjiang000783.js').isChangjiangModel(bare)) return true;
    if (require('../valuation/maijie300319.js').isMaijieModel(bare)) return true;
    if (require('../valuation/dcavm688660.js').isDcavmModel(bare)) return true;
    if (require('../valuation/xinyangfeng000902.js').isXinyangfengModel(bare)) return true;
    if (require('../valuation/wanrun002643.js').isWanrunModel(bare)) return true;
    if (require('../valuation/weigao603014.js').isWeigaoModel(bare)) return true;
  } catch (e) { /* fallthrough */ }
  return false;
}

module.exports = { analyzeValuation, hasDedicatedValuation };

~~~

---

## `lib\aiAugment.js`  ·  35 行

~~~js
// lib/aiAugment.js —— 门面：仅 re-export，导出基线与拆分前逐键一致（24 键，键序与原 L2386-2387 一致）
const config    = require('./ai/config');
const cache     = require('./ai/cache');
const llm       = require('./ai/llm');
const augment   = require('./ai/augmentStock');
const companyDeep = require('./ai/companyDeep');
const market    = require('./ai/market');
const research  = require('./ai/research');
const earnings  = require('./ai/earnings');
const valuation = require('./ai/valuation');

module.exports = {
  augmentStock: augment.augmentStock,
  analyzeAspects: augment.analyzeAspects,
  analyzeCompanyDeep: companyDeep.analyzeCompanyDeep,   // 20260914f：三模块合并为单一 CFA 深度分析
  analyzeMarketOverview: market.analyzeMarketOverview,
  analyzeIndustryIndex: market.analyzeIndustryIndex,
  analyzeResearchReports: research.analyzeResearchReports,
  analyzeAnnouncements: research.analyzeAnnouncements,
  analyzeEarningsReport: earnings.analyzeEarningsReport,
  analyzeValuation: valuation.analyzeValuation,
  readIndustryIndexCache: market.readIndustryIndexCache,
  loadConfig: config.loadConfig,
  saveConfig: config.saveConfig,
  publicConfig: config.publicConfig,
  readCache: cache.readCache,
  readEarningsCache: cache.readEarningsCache,
  readValuationCache: cache.readValuationCache,
  extractEarningsSignal: earnings._extractEarningsSignal,   // ← 别名导出，原样保留
  PROVIDERS: config.PROVIDERS,                               // ← 同一对象引用
  callLLM: llm.callLLM,
  pickModelFor: llm.pickModelFor,
  buildLocalEarningsContext: earnings.buildLocalEarningsContext,
};

~~~

---

## `lib\analysis.js`  ·  1384 行

~~~js
/**
 * Technical & Fundamental Analysis Module
 * Computes technical indicators (MA, EMA, RSI, MACD, Bollinger, KDJ) 
 * and fundamental scoring from stock data.
 */
const axios = require('axios');
const { detectMarket } = require('./stockData');
const { getGrowthCaliber, growthCaliberLabel, orderedYoYFields } = require('./growthCaliber'); // 20261104b 增长口径一键切换
// 20261017a：个股侧量能唯一出口（量能指标根数据源），analyzeVolume 等改为委托本模块
const { computeVolumeIndicators } = require('./capitalFlow');
const db = require('./db'); // 本地 SQLite 数据层（node:sqlite，零额外依赖）

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 规范化股票代码：去 SH/SZ/BJ 前缀，统一以数字代码作主键（与 deepAnalysis.normalizeSymbol 同口径）
function normalizeSym(s) {
  return String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '');
}

// 规则一/二：PEG 落地 data_points（来源 + 90 天 TTL）；失败静默不阻断主流程。
function persistPeg(rawSymbol, peg, pegSource) {
  try {
    const sym = normalizeSym(rawSymbol);
    if (!sym || peg == null) return;
    db.upsertDataPoint({ symbol: sym, key: 'peg', value: peg, asOf: null, source: pegSource || '东方财富基本面', ttlType: 'financial' });
  } catch (e) { /* noop */ }
}

// 规则一/二：行业均值（PE/PB/ROE）落地 data_points（来源 + 90 天 TTL）；失败静默不阻断主流程。
function persistIndustryAvg(rawSymbol, industryAvg) {
  try {
    const sym = normalizeSym(rawSymbol);
    if (!sym || !industryAvg) return;
    const SRC = industryAvg.source || '东方财富行业估值';
    db.upsertDataPoint({ symbol: sym, key: 'industry_pe_avg', value: industryAvg.pe, asOf: null, source: SRC, ttlType: 'financial' });
    db.upsertDataPoint({ symbol: sym, key: 'industry_pb_avg', value: industryAvg.pb, asOf: null, source: SRC, ttlType: 'financial' });
    // 20260909d：估值维度需要 PS 行业均值，一并持久化
    if (typeof industryAvg.ps === 'number') db.upsertDataPoint({ symbol: sym, key: 'industry_ps_avg', value: industryAvg.ps, asOf: null, source: SRC, ttlType: 'financial' });
    if (typeof industryAvg.roe === 'number') db.upsertDataPoint({ symbol: sym, key: 'industry_roe_avg', value: industryAvg.roe, asOf: null, source: SRC, ttlType: 'financial' });
  } catch (e) { /* noop */ }
}

/**
 * 20260909d：读取已持久化的行业均值（单一数据源）。
 * 场景：长期判断等非 /api/analysis 调用点没有实时行业均值，复用本地持久化值，
 * 避免同一标的在两张卡出现两套行业基准；读不到则返回 null（走"无法取值"兜底）。
 */
function loadIndustryAvg(rawSymbol) {
  try {
    const sym = normalizeSym(rawSymbol);
    if (!sym) return null;
    const g = (k) => {
      const r = db.getDataPoint(sym, k);
      if (!r) return null;
      const v = (r && typeof r === 'object') ? (r.value != null ? r.value : r.val) : r;
      const n = parseFloat(v);
      return isNaN(n) ? null : n;
    };
    const pe = g('industry_pe_avg'), pb = g('industry_pb_avg'), ps = g('industry_ps_avg'), roe = g('industry_roe_avg');
    if (pe == null && pb == null && ps == null && roe == null) return null;
    return { pe, pb, ps, roe, source: '本地持久化（东方财富行业估值）' };
  } catch (e) { return null; }
}

// ---- Helper ----
function round(n, d = 2) {
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
}

// ---- Simple Moving Average ----
function SMA(data, period) {
  const result = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j];
      result.push(round(sum / period));
    }
  }
  return result;
}

// ---- Exponential Moving Average ----
function EMA(data, period) {
  const result = [];
  const k = 2 / (period + 1);
  let ema = null;
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += data[i - j];
      ema = sum / period;
      result.push(round(ema));
    } else {
      ema = data[i] * k + ema * (1 - k);
      result.push(round(ema));
    }
  }
  return result;
}

// ---- RSI (Relative Strength Index) ----
function RSI(closes, period = 14) {
  const result = [];
  let gains = 0, losses = 0;

  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      result.push(null);
      continue;
    }
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);

    if (i <= period) {
      gains += gain;
      losses += loss;
      if (i === period) {
        const avgGain = gains / period;
        const avgLoss = losses / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        result.push(round(100 - 100 / (1 + rs)));
      } else {
        result.push(null);
      }
    } else {
      // Wilder's smoothing
      const prevAvgGain = (result[i - 1] !== null) ? (gains / period) : 0;
      // Actually, let me use a simpler running approach
    }
  }

  // Redo with proper Wilder's method
  const rsiArr = [];
  let avgGain = 0, avgLoss = 0;

  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      rsiArr.push(null);
      continue;
    }
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(0, change);
    const loss = Math.max(0, -change);

    if (i <= period) {
      avgGain += gain;
      avgLoss += loss;
      if (i === period) {
        avgGain /= period;
        avgLoss /= period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsiArr.push(round(100 - 100 / (1 + rs)));
      } else {
        rsiArr.push(null);
      }
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsiArr.push(round(100 - 100 / (1 + rs)));
    }
  }

  return rsiArr;
}

// ---- MACD ----
function MACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);
  const dif = closes.map((_, i) => {
    if (emaFast[i] === null || emaSlow[i] === null) return null;
    return round(emaFast[i] - emaSlow[i]);
  });

  // Signal line = EMA of DIF
  const difValues = dif.map(v => v === null ? 0 : v);
  const firstValid = dif.findIndex(v => v !== null);
  const signalLine = new Array(closes.length).fill(null);
  if (firstValid >= 0 && firstValid < closes.length) {
    const validDif = difValues.slice(firstValid);
    const sig = EMA(validDif, signal);
    for (let i = 0; i < sig.length; i++) {
      signalLine[firstValid + i] = sig[i];
    }
  }

  const histogram = dif.map((d, i) => {
    if (d === null || signalLine[i] === null) return null;
    return round(d - signalLine[i]);
  });

  return { dif, signal: signalLine, histogram };
}

// ---- Bollinger Bands ----
function Bollinger(closes, period = 20, mult = 2) {
  const middle = SMA(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);

  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += Math.pow(closes[i - j] - middle[i], 2);
    }
    const std = Math.sqrt(sum / period);
    upper[i] = round(middle[i] + mult * std);
    lower[i] = round(middle[i] - mult * std);
  }

  return { upper, middle, lower };
}

// ---- KDJ (Stochastic Oscillator) ----
function KDJ(highs, lows, closes, period = 9) {
  let k = 50, d = 50;
  const kArr = [], dArr = [], jArr = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      kArr.push(null);
      dArr.push(null);
      jArr.push(null);
      continue;
    }

    let hh = -Infinity, ll = Infinity;
    for (let j = 0; j < period; j++) {
      hh = Math.max(hh, highs[i - j]);
      ll = Math.min(ll, lows[i - j]);
    }

    const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    k = (2 / 3) * k + (1 / 3) * rsv;
    d = (2 / 3) * d + (1 / 3) * k;
    const j = 3 * k - 2 * d;

    kArr.push(round(k));
    dArr.push(round(d));
    jArr.push(round(j));
  }

  return { k: kArr, d: dArr, j: jArr };
}

// ---- ADX (Average Directional Index, Wilder smoothing) ----
// 返回 { adx, plusDI, minusDI } 三个等长数组，预热期为 2*period-1。
function ADX(highs, lows, closes, period = 14) {
  const n = closes.length;
  const empty = { adx: new Array(n).fill(null), plusDI: new Array(n).fill(null), minusDI: new Array(n).fill(null) };
  if (n < period * 2) return empty; // 数据不足，无法计算有效 ADX

  const tr = new Array(n).fill(0);
  const pDM = new Array(n).fill(0);
  const mDM = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const hh = highs[i] - highs[i - 1];
    const ll = lows[i - 1] - lows[i];
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
    pDM[i] = (hh > ll && hh > 0) ? hh : 0;
    mDM[i] = (ll > hh && ll > 0) ? ll : 0;
  }

  const atr = new Array(n).fill(null);
  const pdI = new Array(n).fill(null);
  const mdI = new Array(n).fill(null);
  let sumTR = 0, sumP = 0, sumM = 0;
  for (let i = 1; i <= period; i++) { sumTR += tr[i]; sumP += pDM[i]; sumM += mDM[i]; }
  atr[period] = sumTR / period;
  pdI[period] = atr[period] > 0 ? (sumP / atr[period]) * 100 : 0;
  mdI[period] = atr[period] > 0 ? (sumM / atr[period]) * 100 : 0;

  for (let i = period + 1; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
    pdI[i] = atr[i] > 0 ? ((pdI[i - 1] * (period - 1) + pDM[i]) / period) : 0;
    mdI[i] = atr[i] > 0 ? ((mdI[i - 1] * (period - 1) + mDM[i]) / period) : 0;
  }

  const dx = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    const denom = pdI[i] + mdI[i];
    dx[i] = denom === 0 ? 0 : (Math.abs(pdI[i] - mdI[i]) / denom) * 100;
  }

  const adxArr = new Array(n).fill(null);
  let sumDX = 0;
  for (let i = period; i < period + period; i++) sumDX += dx[i];
  adxArr[period * 2 - 1] = sumDX / period;
  for (let i = period * 2; i < n; i++) {
    adxArr[i] = (adxArr[i - 1] * (period - 1) + dx[i]) / period;
  }

  return {
    adx: adxArr.map(v => v === null ? null : round(v)),
    plusDI: pdI.map(v => v === null ? null : round(v)),
    minusDI: mdI.map(v => v === null ? null : round(v)),
  };
}

// ---- Support & Resistance ----
function findSupportResistance(history, lookback = 60) {
  const recent = history.slice(-lookback);
  if (recent.length === 0) return { supports: [], resistances: [] };

  const supports = [];
  const resistances = [];

  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].low < recent[i - 1].low && recent[i].low < recent[i - 2].low &&
        recent[i].low < recent[i + 1].low && recent[i].low < recent[i + 2].low) {
      supports.push(recent[i].low);
    }
    if (recent[i].high > recent[i - 1].high && recent[i].high > recent[i - 2].high &&
        recent[i].high > recent[i + 1].high && recent[i].high > recent[i + 2].high) {
      resistances.push(recent[i].high);
    }
  }

  const currentPrice = recent[recent.length - 1].close;
  // 相近价位聚类（阈值1%）：同一区域被多次触及的摆动点合并为一个支撑/阻力位，
  // 代表值取簇内均值，避免 53.15 / 53.03 这类近重复价位逐行展示
  const nearbySupports = clusterLevels(supports.filter(s => s < currentPrice))
    .sort((a, b) => b.level - a.level).slice(0, 3);
  const nearbyResistances = clusterLevels(resistances.filter(r => r > currentPrice))
    .sort((a, b) => a.level - b.level).slice(0, 3);

  return {
    supports: nearbySupports.length > 0 ? nearbySupports.map(c => c.level) : [Math.min(...recent.map(d => d.low))],
    resistances: nearbyResistances.length > 0 ? nearbyResistances.map(c => c.level) : [Math.max(...recent.map(d => d.high))],
    currentPrice
  };
}

// 摆动点聚类：与簇首（anchor）价差 <1% 归入同一簇，锚定簇首防止链式漂移
function clusterLevels(levels) {
  const sorted = [...levels].sort((a, b) => a - b);
  const clusters = [];
  for (const v of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(v - last.anchor) / last.anchor < 0.01) {
      last.values.push(v);
      last.sum += v;
    } else {
      clusters.push({ anchor: v, values: [v], sum: v });
    }
  }
  return clusters.map(c => ({ level: round(c.sum / c.values.length, 2), touches: c.values.length }));
}

// ---- Volume Analysis ----
// 20261017a：量能指标收敛为个股侧唯一出口 lib/capitalFlow.js computeVolumeIndicators，
// 本模块不再自行计算（原 analyzeVolume 的本地算法已删除，改为委托根模块）。
// 输出格式不变，下游 volumeTrend / volumeRatio 消费零改动。
function analyzeVolume(history) {
  const vi = computeVolumeIndicators(history, null, null);
  if (!vi) return { trend: 'unknown', ratio: 0, avgVolume: 0 };
  const lvp = vi.indicators.latestVsPriorAvg;
  return { trend: lvp.trend, ratio: lvp.ratio, avgVolume: Math.round(lvp.priorAvgVol) };
}

// ---- Technical Analysis Summary ----
function technicalAnalysis(history) {
  if (!history || history.length < 30) {
    return { error: 'Insufficient data for technical analysis' };
  }

  const closes = history.map(d => d.close);
  const highs = history.map(d => d.high);
  const lows = history.map(d => d.low);
  const volumes = history.map(d => d.volume);

  const lastIdx = closes.length - 1;
  const lastClose = closes[lastIdx];

  // Moving averages
  const ma5 = SMA(closes, 5);
  const ma10 = SMA(closes, 10);
  const ma20 = SMA(closes, 20);
  const ma60 = SMA(closes, 60);
  const ma120 = SMA(closes, Math.min(120, closes.length));

  // RSI
  const rsi = RSI(closes, 14);
  const lastRsi = rsi[lastIdx];

  // MACD
  const macd = MACD(closes);
  const lastMacd = {
    dif: macd.dif[lastIdx],
    signal: macd.signal[lastIdx],
    histogram: macd.histogram[lastIdx]
  };

  // Bollinger
  const boll = Bollinger(closes, 20, 2);

  // KDJ
  const kdj = KDJ(highs, lows, closes, 9);
  const lastKdj = {
    k: kdj.k[lastIdx],
    d: kdj.d[lastIdx],
    j: kdj.j[lastIdx]
  };

  // Support/Resistance
  const sr = findSupportResistance(history);

  // Volume analysis
  const volAnalysis = analyzeVolume(history);

  // Trend determination
  let trend = '震荡';
  let trendScore = 0;

  if (ma5[lastIdx] !== null && ma20[lastIdx] !== null) {
    if (lastClose > ma5[lastIdx] && ma5[lastIdx] > ma20[lastIdx]) {
      trend = '上升趋势';
      trendScore += 2;
    } else if (lastClose < ma5[lastIdx] && ma5[lastIdx] < ma20[lastIdx]) {
      trend = '下降趋势';
      trendScore -= 2;
    }
  }

  // RSI signals
  let rsiSignal = '中性';
  if (lastRsi !== null) {
    if (lastRsi > 70) { rsiSignal = '超买'; trendScore -= 1; }
    else if (lastRsi < 30) { rsiSignal = '超卖'; trendScore += 1; }
    else if (lastRsi > 50) { rsiSignal = '偏强'; trendScore += 0.5; }
    else { rsiSignal = '偏弱'; trendScore -= 0.5; }
  }

  // MACD signals
  let macdSignal = '中性';
  if (lastMacd.dif !== null && lastMacd.signal !== null) {
    if (lastMacd.dif > lastMacd.signal && lastMacd.histogram > 0) {
      macdSignal = '多头'; trendScore += 1;
    } else if (lastMacd.dif < lastMacd.signal && lastMacd.histogram < 0) {
      macdSignal = '空头'; trendScore -= 1;
    }
    // Cross detection
    if (lastIdx > 0 && macd.dif[lastIdx - 1] !== null && macd.signal[lastIdx - 1] !== null) {
      if (macd.dif[lastIdx - 1] < macd.signal[lastIdx - 1] && lastMacd.dif > lastMacd.signal) {
        macdSignal = '金叉'; trendScore += 1.5;
      } else if (macd.dif[lastIdx - 1] > macd.signal[lastIdx - 1] && lastMacd.dif < lastMacd.signal) {
        macdSignal = '死叉'; trendScore -= 1.5;
      }
    }
  }

  // KDJ signals
  let kdjSignal = '中性';
  if (lastKdj.k !== null && lastKdj.d !== null) {
    if (lastKdj.j > 100 || lastKdj.k > 80) { kdjSignal = '超买'; trendScore -= 0.5; }
    else if (lastKdj.j < 0 || lastKdj.k < 20) { kdjSignal = '超卖'; trendScore += 0.5; }
    if (lastKdj.k > lastKdj.d) { kdjSignal = kdjSignal === '中性' ? '偏多' : kdjSignal; trendScore += 0.5; }
    else { kdjSignal = kdjSignal === '中性' ? '偏空' : kdjSignal; trendScore -= 0.5; }
  }

  // Bollinger position
  let bollPosition = '中轨';
  if (boll.upper[lastIdx] !== null && boll.lower[lastIdx] !== null) {
    const range = boll.upper[lastIdx] - boll.lower[lastIdx];
    if (range > 0) {
      const pos = (lastClose - boll.lower[lastIdx]) / range;
      if (pos > 0.8) bollPosition = '上轨附近';
      else if (pos > 0.5) bollPosition = '中上轨';
      else if (pos > 0.2) bollPosition = '中下轨';
      else bollPosition = '下轨附近';
    }
  }

  // Overall technical score
  let techScore = '中性';
  if (trendScore >= 3) techScore = '强烈看多';
  else if (trendScore >= 1.5) techScore = '偏多';
  else if (trendScore <= -3) techScore = '强烈看空';
  else if (trendScore <= -1.5) techScore = '偏空';

  return {
    indicators: {
      ma5: ma5[lastIdx],
      ma10: ma10[lastIdx],
      ma20: ma20[lastIdx],
      ma60: ma60[lastIdx],
      ma120: ma120[lastIdx],
      rsi: lastRsi,
      macd: lastMacd,
      boll: { upper: boll.upper[lastIdx], middle: boll.middle[lastIdx], lower: boll.lower[lastIdx] },
      kdj: lastKdj,
    },
    series: {
      ma5, ma10, ma20, ma60, ma120,
      rsi,
      macdDif: macd.dif,
      macdSignal: macd.signal,
      macdHistogram: macd.histogram,
      bollUpper: boll.upper,
      bollMiddle: boll.middle,
      bollLower: boll.lower,
      kdjK: kdj.k,
      kdjD: kdj.d,
      kdjJ: kdj.j,
    },
    signals: {
      trend,
      rsiSignal,
      macdSignal,
      kdjSignal,
      bollPosition,
      volumeTrend: volAnalysis.trend,
      volumeRatio: volAnalysis.ratio,
    },
    supportResistance: sr,
    techScore,
    trendScore: round(trendScore, 1),
  };
}

// ---- Fundamental Analysis (with company type differentiation) ----
// 20260909d：基本面评分底层逻辑重构——委托至 lib/fundamentalScore.js（四维度各 25 分、确定性计算）。
// 输出结构（metrics / scores / dimensionLogic / overall / rating / description）与旧版完全一致，
// 前端版面、字体、颜色零改动；新增 ctx 仅用于注入行业基准与财报序列（缺省时自动走兜底规则）。
function fundamentalAnalysis(quote, companyType, ctx) {
  try {
    const { computeFundamentalScore } = require('./fundamentalScore');
    // 未显式注入行业基准时（如长期判断模块），复用本地持久化的行业均值，保证全站同一基准
    const ia = (ctx && ctx.industryAvg) || loadIndustryAvg(quote && (quote.symbol || quote.code));
    return computeFundamentalScore({
      quote,
      companyType,
      industryAvg: ia || null,
    });
  } catch (e) {
    console.error('[基本面评分] 新引擎失败，回退 legacy:', e && e.message);
    return legacyFundamentalAnalysis(quote, companyType);
  }
}

/** 旧版实现（仅在新引擎异常时兜底，逻辑保持原样） */
function legacyFundamentalAnalysis(quote, companyType) {

  const f = quote.fundamentals || {};
  // 金融业（银行/保险/证券等）高负债是经营常态，健康评分中不应因高「资债比」被扣分
  const isFinancial = !!(companyType && companyType.isFinancial);
  const isPct = !!(f.debtMetricPct); // A股取资产负债率%（>3 量级），港股/美股取带息债÷权益比值
  const result = {
    metrics: {},
    scores: {},
    overall: '未知',
    score: 0,
    rating: '',
    description: '',
    companyType: companyType?.type || 'balanced',
    companyTypeName: companyType?.typeName || '均衡型',
  };

  // Scoring weights based on company type
  // 20261016b（审计 F1/G10）：本处 weights 仅用于下方 legacy 兜底分支（computeFundamentalScore 抛异常时的降级计分）。
  // 正常计分路径不消费它——四个维度各自固定满分 25（DIM = 25），公司类型只影响指标选取与描述，不改权重。
  const weights = companyType?.weights || { valuation: 25, profitability: 25, growth: 25, health: 25 };
  const ct = companyType?.type || 'balanced';

  let score = 0;
  const maxScore = 100;

  // Valuation (base: 25 points, then rescaled)
  // 20260909j 审计：f.peTtm 字段从未在任何数据源定义（历史遗留），f.pe（腾讯行情）本身即滚动 TTM 口径
  const pe = f.pe || 0;
  const pb = f.pb || 0;
  result.metrics.pe = pe;
  result.metrics.pb = pb;
  result.metrics.ps = f.ps || 0;
  result.metrics.peg = f.peg || 0;
  persistPeg(quote && (quote.symbol || quote.code), result.metrics.peg, f.pegSource);
  result.metrics.evEbitda = f.evEbitda || 0;

  let valScore = 0;
  let valRule = '';
  if (ct === 'growth') {
    // Growth: focus on PS, less on PE
    // 20260909j 审计：legacy 路径文案补口径标注（PE 为 TTM；PS 主口径 TTM，本地兜底为单期营收）
    const ps = f.ps || 0;
    const psTag = (f.psSource && String(f.psSource).indexOf('PS_TTM') >= 0) ? '市销率 PS(TTM)' : '市销率 PS';
    const peTag = 'PE(TTM)';
    if (ps > 0 && ps < 3) { valScore = 25; valRule = `${psTag}=${ps.toFixed(1)} 处于低位(<3)，估值吸引力强`; }
    else if (ps >= 3 && ps < 8) { valScore = 18; valRule = `${psTag}=${ps.toFixed(1)} 属合理区间(3~8)`; }
    else if (ps >= 8 && ps < 15) { valScore = 10; valRule = `${psTag}=${ps.toFixed(1)} 偏高(8~15)`; }
    else if (ps >= 15 && ps < 30) { valScore = 5; valRule = `${psTag}=${ps.toFixed(1)} 过高(15~30)`; }
    else if (pe > 0 && pe < 30) { valScore = 15; valRule = `PS 缺失，按 ${peTag}=${pe.toFixed(1)}<30 兜底`; }
    else { valScore = 8; valRule = `PS 与 PE 均偏高或缺失`; }
  } else if (ct === 'value') {
    // Value: focus on PE
    // 20260909j 审计：PE 为 TTM 口径，文案明示
    if (pe > 0 && pe < 10) { valScore = 25; valRule = `PE(TTM)=${pe.toFixed(1)} 极低(<10)，价值凸显`; }
    else if (pe >= 10 && pe < 15) { valScore = 22; valRule = `PE(TTM)=${pe.toFixed(1)} 偏低(10~15)`; }
    else if (pe >= 15 && pe < 25) { valScore = 18; valRule = `PE(TTM)=${pe.toFixed(1)} 合理(15~25)`; }
    else if (pe >= 25 && pe < 40) { valScore = 8; valRule = `PE(TTM)=${pe.toFixed(1)} 偏高(25~40)`; }
    else if (pe >= 40) { valScore = 4; valRule = `PE(TTM)=${pe.toFixed(1)} 过高(≥40)`; }
    else { valScore = 8; valRule = `PE 为负或缺失`; }
  } else if (ct === 'dividend') {
    // Dividend: PE moderate, PB matters
    if (pe > 0 && pe < 8) { valScore = 25; valRule = `PE=${pe.toFixed(1)} 极低(<8)，高股息蓝筹`; }
    else if (pe >= 8 && pe < 15) { valScore = 20; valRule = `PE=${pe.toFixed(1)} 偏低(8~15)`; }
    else if (pe >= 15 && pe < 25) { valScore = 15; valRule = `PE=${pe.toFixed(1)} 合理(15~25)`; }
    else if (pe >= 25) { valScore = 8; valRule = `PE=${pe.toFixed(1)} 偏高(≥25)`; }
    else { valScore = 10; valRule = `PE 为负或缺失`; }
    if (pb > 0 && pb < 0.8) { valScore = Math.min(25, valScore + 5); valRule += '；PB 破净(<0.8) 额外+5'; }
    else if (pb > 0 && pb < 1.2) { valScore = Math.min(25, valScore + 3); valRule += '；PB 偏低(<1.2) 额外+3'; }
  } else {
    // Balanced: original logic
    if (pe > 0 && pe < 15) { valScore = 25; valRule = `PE=${pe.toFixed(1)} 低(<15)`; }
    else if (pe >= 15 && pe < 25) { valScore = 18; valRule = `PE=${pe.toFixed(1)} 合理(15~25)`; }
    else if (pe >= 25 && pe < 40) { valScore = 10; valRule = `PE=${pe.toFixed(1)} 偏高(25~40)`; }
    else if (pe >= 40 && pe < 60) { valScore = 5; valRule = `PE=${pe.toFixed(1)} 过高(40~60)`; }
    else if (pe <= 0) { valScore = 8; valRule = `PE 为负或缺失`; }
  }
  // Rescale to actual weight
  const valActual = Math.round(valScore / 25 * weights.valuation);
  score += valActual;
  result.scores.valuation = { score: valActual, max: weights.valuation, label: '估值' };
  result.dimensionLogic = result.dimensionLogic || {};
  result.dimensionLogic.valuation = {
    label: '估值', score: valActual, max: weights.valuation,
    // 20260909j 审计：legacy 兜底文案补口径（PE 恒为 TTM；PS 主口径 TTM、本地兜底为单期营收）
    metrics: [['市盈率 PE(TTM)', pe ? pe.toFixed(1) + ' 倍' : '—'], ['市净率 PB', pb ? pb.toFixed(1) + ' 倍' : '—'], [(f.psSource && String(f.psSource).indexOf('PS_TTM') >= 0) ? '市销率 PS(TTM)' : '市销率 PS', f.ps ? f.ps.toFixed(1) : '—']],
    rule: valRule || '—',
    summary: `按「${(companyType && companyType.typeName) || '均衡型'}」估值权重 ${weights.valuation} 分；依据 PE/PB/PS 落入对应区间判定，得 ${valActual}/${weights.valuation} 分。`
  };

  // Profitability (base: 25 points, then rescaled)
  let profScore = 0;
  const roe = f.roe || f.returnOnEquity || 0;
  const grossMargin = f.grossMargin || f.grossMargins || 0;
  const netMargin = f.netMargin || f.profitMargins || 0;
  result.metrics.roe = typeof roe === 'number' && roe < 1 ? roe * 100 : roe;
  result.metrics.grossMargin = typeof grossMargin === 'number' && grossMargin < 1 ? grossMargin * 100 : grossMargin;
  result.metrics.netMargin = typeof netMargin === 'number' && netMargin < 1 ? netMargin * 100 : netMargin;
  result.metrics.roa = f.returnOnAssets || 0;

  if (ct === 'dividend') {
    // Dividend: ROE stability is key
    if (result.metrics.roe > 15) profScore += 14;
    else if (result.metrics.roe > 10) profScore += 10;
    else if (result.metrics.roe > 5) profScore += 6;
    else profScore += 2;
  } else {
    if (result.metrics.roe > 20) profScore += 12;
    else if (result.metrics.roe > 15) profScore += 9;
    else if (result.metrics.roe > 10) profScore += 6;
    else if (result.metrics.roe > 5) profScore += 3;
  }

  if (result.metrics.netMargin > 25) profScore += 8;
  else if (result.metrics.netMargin > 15) profScore += 6;
  else if (result.metrics.netMargin > 8) profScore += 4;
  else if (result.metrics.netMargin > 0) profScore += 2;

  if (result.metrics.grossMargin > 50) profScore += 5;
  else if (result.metrics.grossMargin > 30) profScore += 3;
  else if (result.metrics.grossMargin > 15) profScore += 1;

  const profActual = Math.round(Math.min(profScore, 25) / 25 * weights.profitability);
  score += profActual;
  result.scores.profitability = { score: profActual, max: weights.profitability, label: '盈利能力' };
  const _roe = result.metrics.roe, _nm = result.metrics.netMargin, _gm = result.metrics.grossMargin;
  result.dimensionLogic = result.dimensionLogic || {};
  result.dimensionLogic.profitability = {
    label: '盈利能力', score: profActual, max: weights.profitability,
    metrics: [['ROE', _roe ? _roe.toFixed(1) + '%' : '—'], ['净利率', _nm ? _nm.toFixed(1) + '%' : '—'], ['毛利率', _gm ? _gm.toFixed(1) + '%' : '—']],
    rule: `ROE ${_roe ? _roe.toFixed(1) : '—'}%、净利率 ${_nm ? _nm.toFixed(1) : '—'}%、毛利率 ${_gm ? _gm.toFixed(1) : '—'}${ct === 'dividend' ? '（红利型更看重 ROE 稳定性）' : ''}，综合分档累加得 ${profActual}/${weights.profitability} 分`,
    summary: `按「${(companyType && companyType.typeName) || '均衡型'}」盈利能力权重 ${weights.profitability} 分；综合 ROE/净利率/毛利率分档累加，得 ${profActual}/${weights.profitability} 分。`
  };

  // Growth (base: 25 points, then rescaled)
  let growthScore = 0;
  let growthRule = '';
  const revGrowth = f.revenueYoy || f.revenueGrowth || 0;
  const profitGrowth = f.profitYoy || f.earningsGrowth || 0;
  result.metrics.revenueGrowth = typeof revGrowth === 'number' && Math.abs(revGrowth) < 1 ? revGrowth * 100 : revGrowth;
  result.metrics.profitGrowth = typeof profitGrowth === 'number' && Math.abs(profitGrowth) < 1 ? profitGrowth * 100 : profitGrowth;
  const rg = result.metrics.revenueGrowth, pg = result.metrics.profitGrowth;

  if (ct === 'growth') {
    // Growth: revenue growth is the most important metric
    if (rg > 50) { growthScore += 15; growthRule = `营收增速 ${rg.toFixed(1)}% (>50) +15`; }
    else if (rg > 30) { growthScore += 12; growthRule = `营收增速 ${rg.toFixed(1)}% (30~50) +12`; }
    else if (rg > 20) { growthScore += 9; growthRule = `营收增速 ${rg.toFixed(1)}% (20~30) +9`; }
    else if (rg > 10) { growthScore += 5; growthRule = `营收增速 ${rg.toFixed(1)}% (10~20) +5`; }
    else if (rg > 0) { growthScore += 2; growthRule = `营收增速 ${rg.toFixed(1)}% (0~10) +2`; }
    else { growthRule = `营收增速 ${rg.toFixed(1)}% (≤0，无增长加分)`; }

    if (pg > 50) { growthScore += 10; growthRule += `；净利增速 ${pg.toFixed(1)}% (>50) +10`; }
    else if (pg > 30) { growthScore += 8; growthRule += `；净利增速 ${pg.toFixed(1)}% (30~50) +8`; }
    else if (pg > 15) { growthScore += 5; growthRule += `；净利增速 ${pg.toFixed(1)}% (15~30) +5`; }
    else if (pg > 0) { growthScore += 3; growthRule += `；净利增速 ${pg.toFixed(1)}% (0~15) +3`; }
    else { growthRule += `；净利增速 ${pg.toFixed(1)}% (≤0)`; }
  } else {
    if (rg > 30) { growthScore += 12; growthRule = `营收增速 ${rg.toFixed(1)}% (>30) +12`; }
    else if (rg > 15) { growthScore += 9; growthRule = `营收增速 ${rg.toFixed(1)}% (15~30) +9`; }
    else if (rg > 5) { growthScore += 6; growthRule = `营收增速 ${rg.toFixed(1)}% (5~15) +6`; }
    else if (rg > 0) { growthScore += 3; growthRule = `营收增速 ${rg.toFixed(1)}% (0~5) +3`; }
    else { growthRule = `营收增速 ${rg.toFixed(1)}% (≤0，无增长加分)`; }

    if (pg > 30) { growthScore += 13; growthRule += `；净利增速 ${pg.toFixed(1)}% (>30) +13`; }
    else if (pg > 15) { growthScore += 10; growthRule += `；净利增速 ${pg.toFixed(1)}% (15~30) +10`; }
    else if (pg > 5) { growthScore += 6; growthRule += `；净利增速 ${pg.toFixed(1)}% (5~15) +6`; }
    else if (pg > 0) { growthScore += 3; growthRule += `；净利增速 ${pg.toFixed(1)}% (0~5) +3`; }
    else { growthRule += `；净利增速 ${pg.toFixed(1)}% (≤0)`; }
  }

  const growthActual = Math.round(Math.min(growthScore, 25) / 25 * weights.growth);
  score += growthActual;
  result.scores.growth = { score: growthActual, max: weights.growth, label: '成长性' };
  result.dimensionLogic = result.dimensionLogic || {};
  result.dimensionLogic.growth = {
    label: '成长性', score: growthActual, max: weights.growth,
    metrics: [['营收增速', (rg != null ? rg.toFixed(1) : '—') + '%'], ['净利增速', (pg != null ? pg.toFixed(1) : '—') + '%']],
    rule: growthRule || '—',
    summary: `按「${(companyType && companyType.typeName) || '均衡型'}」成长性权重 ${weights.growth} 分；营收与净利增速落入对应档位累加，得 ${growthActual}/${weights.growth} 分。`
  };

  // Financial health (base: 25 points, then rescaled)
  let healthScore = 0;
  const debtToEquity = f.debtToEquity || 0;
  const currentRatio = f.currentRatio || 0;
  result.metrics.debtToEquity = debtToEquity;
  result.metrics.debtMetricPct = isPct;
  result.metrics.currentRatio = currentRatio;
  result.metrics.quickRatio = f.quickRatio || 0;
  result.metrics.operatingCashFlowPerShare = f.operatingCashFlowPerShare || 0;

  if (ct === 'dividend') {
    // Dividend: financial health and dividend sustainability are key
    if (isFinancial) {
      // 金融业资产负债率天然高（A 股上市银行/保险约 85%-96% 为正常区间），不因其高杠杆扣分
      if (debtToEquity >= 80 && debtToEquity <= 96) healthScore += 10;
      else if (debtToEquity > 96) healthScore += 6;
      else healthScore += 8;
    } else if (isPct) {
      // A股口径：资产负债率%（40% 以下稳健，70% 以上偏高）
      if (debtToEquity > 0 && debtToEquity < 40) healthScore += 12;
      else if (debtToEquity >= 40 && debtToEquity <= 70) healthScore += 9;
      else if (debtToEquity > 70 && debtToEquity <= 90) healthScore += 5;
      else if (debtToEquity === 0) healthScore += 10;
      // >90% 高杠杆风险，不加分
    } else if (debtToEquity > 0 && debtToEquity < 0.5) healthScore += 12;
    else if (debtToEquity >= 0.5 && debtToEquity < 1) healthScore += 9;
    else if (debtToEquity >= 1 && debtToEquity < 2) healthScore += 5;
    else if (debtToEquity === 0) healthScore += 10;

    if (currentRatio > 2) healthScore += 6;
    else if (currentRatio > 1.5) healthScore += 5;
    else if (currentRatio > 1) healthScore += 3;

    // Dividend yield is critical for dividend stocks
    const divYield = f.dividendYield || 0;
    result.metrics.dividendYield = typeof divYield === 'number' && divYield < 1 && !f.dividendYieldIsPct ? divYield * 100 : divYield;
    if (result.metrics.dividendYield > 5) healthScore += 7;
    else if (result.metrics.dividendYield > 3) healthScore += 5;
    else if (result.metrics.dividendYield > 1) healthScore += 2;
  } else {
    if (isFinancial) {
      // 金融业资产负债率天然高（A 股上市银行/保险约 85%-96% 为正常区间），不因其高杠杆扣分
      if (debtToEquity >= 80 && debtToEquity <= 96) healthScore += 10;
      else if (debtToEquity > 96) healthScore += 6;
      else healthScore += 8;
    } else if (isPct) {
      // A股口径：资产负债率%（40% 以下稳健，70% 以上偏高）
      if (debtToEquity > 0 && debtToEquity < 40) healthScore += 12;
      else if (debtToEquity >= 40 && debtToEquity <= 70) healthScore += 9;
      else if (debtToEquity > 70 && debtToEquity <= 90) healthScore += 5;
      else if (debtToEquity === 0) healthScore += 10;
      // >90% 高杠杆风险，不加分
    } else if (debtToEquity > 0 && debtToEquity < 0.5) healthScore += 12;
    else if (debtToEquity >= 0.5 && debtToEquity < 1) healthScore += 9;
    else if (debtToEquity >= 1 && debtToEquity < 2) healthScore += 5;
    else if (debtToEquity === 0) healthScore += 10;

    if (currentRatio > 2) healthScore += 8;
    else if (currentRatio > 1.5) healthScore += 6;
    else if (currentRatio > 1) healthScore += 4;
    else if (currentRatio > 0.5) healthScore += 2;

    const divYield = f.dividendYield || 0;
    result.metrics.dividendYield = typeof divYield === 'number' && divYield < 1 && !f.dividendYieldIsPct ? divYield * 100 : divYield;
    if (result.metrics.dividendYield > 0) healthScore += Math.min(5, result.metrics.dividendYield);
  }

  const healthActual = Math.round(Math.min(healthScore, 25) / 25 * weights.health);
  score += healthActual;
  result.scores.health = { score: healthActual, max: weights.health, label: '财务健康' };
  const _d2e = result.metrics.debtToEquity, _cr = result.metrics.currentRatio, _dy = result.metrics.dividendYield, _isPct = result.metrics.debtMetricPct;
  const _d2eTxt = _d2e != null ? (_isPct ? _d2e.toFixed(2) + '%' : _d2e.toFixed(2)) : '—';
  const _d2eLabel = _isPct ? '资产负债率' : '带息债/权益';
  result.dimensionLogic = result.dimensionLogic || {};
  result.dimensionLogic.health = {
    label: '财务健康', score: healthActual, max: weights.health,
    metrics: [[_d2eLabel, _d2eTxt], ['流动比率', _cr != null ? _cr.toFixed(2) : '—'], ['股息率(TTM)', _dy != null ? _dy.toFixed(1) + '%' : '—']],
    rule: `${_d2eLabel} ${_d2eTxt}、流动比率 ${_cr != null ? _cr.toFixed(2) : '—'}${ct === 'dividend' ? `、股息率 ${_dy != null ? _dy.toFixed(1) : '—'}%（红利型看重分红持续性）` : ''}，综合分档累加得 ${healthActual}/${weights.health} 分`,
    summary: `按「${(companyType && companyType.typeName) || '均衡型'}」财务健康权重 ${weights.health} 分；综合偿债能力/流动性${ct === 'dividend' ? '/股息率' : ''}分档累加，得 ${healthActual}/${weights.health} 分。`
  };

  result.score = Math.round(score);

  if (score >= 80) { result.overall = '优秀'; result.rating = 'A+'; }
  else if (score >= 65) { result.overall = '良好'; result.rating = 'A'; }
  else if (score >= 50) { result.overall = '一般'; result.rating = 'B'; }
  else if (score >= 35) { result.overall = '较弱'; result.rating = 'C'; }
  else { result.overall = '较差'; result.rating = 'D'; }

  // 20260919a：原「分析师评级」（targetMeanPrice / recommendationKey 等，依赖美股 Yahoo 数据，
  // A股恒为空）底层逻辑已整体删除，改由 lib/metricAnalysis.js「指标分析」承接。

  // Description
  const parts = [];
  if (result.metrics.pe > 0) parts.push(`市盈率${result.metrics.pe.toFixed(1)}倍`);
  if (result.metrics.pb > 0) parts.push(`市净率${result.metrics.pb.toFixed(1)}倍`);
  if (result.metrics.roe > 0) parts.push(`ROE ${result.metrics.roe.toFixed(1)}%`);
  if (result.metrics.netMargin > 0) parts.push(`净利率${result.metrics.netMargin.toFixed(1)}%`);
  result.description = parts.join('，');

  return result;
}

// 取最新期与其「去年同期（同报告期上一年）」的值，用于利润增速边际趋势判断。
// 与基本面维度 yoyPair 同源（均从 zyzbHistory 按 REPORT_DATE 月份对齐取上一年同期），
// 避免直接用数组末位元素导致比较到错误报告期（如拿 2026中报 对比 2024三季报）。
function samePeriodYoY(zy, fields) {
  // 20261102a（用户指令：增长指标优先最新单季口径）：fields 支持数组（逐行按序取首个非空值）——
  // 增长类优先 DJD_*_YOY（东财主要指标自带单季同比），缺失回退累计口径 *_TZ；比率/水平类仍传单一字段。
  const fl = Array.isArray(fields) ? fields : [fields];
  const rows = (zy || []).map(d => {
    const dt = new Date(String(d.REPORT_DATE || '').slice(0, 10));
    let v = null;
    for (const k of fl) { const n = toNum(d[k]); if (n != null) { v = n; break; } }
    return { d: dt, v };
  }).filter(r => r.d && !isNaN(r.d.getTime()) && r.v != null).sort((a, b) => b.d - a.d);
  if (!rows.length) return { cur: null, prev: null };
  const latest = rows[0];
  const M = latest.d.getMonth() + 1;
  const y = latest.d.getFullYear();
  const prev = rows.find(r => r.d.getFullYear() === y - 1 && r.d.getMonth() + 1 === M);
  return { cur: latest.v, prev: prev ? prev.v : null };
}

// ---- Signal evaluation (利好 / 利空 提醒) ----
// 依据估值、盈利、成长、分红、负债等指标的多空方向，给出对股价的利好(红)/利空(绿)标记。
// industryAvg 可选：{ pe, pb } 为行业均值（缺失时用分类基准估算）。
// opts 可选：{ percentiles } 为「关键财务指标对标」历史百分位（comparison.percentiles），用于 ROE/毛利率/净利率 的「相对优势升级通道」。
function evaluateSignals(fundamentals, companyType, industryAvg, opts) {
  const f = fundamentals || {};
  const ct = (companyType && companyType.type) || 'balanced';
  // 金融业（银行/保险/证券/信托/基金等）高负债是经营常态，不视为利空
  const isFinancial = !!(companyType && companyType.isFinancial);
  // 行业均值（缺失时用分类基准估算）
  const bench = {
    growth: { pe: 40, pb: 4, ps: 8 }, value: { pe: 12, pb: 1.2, ps: 1.5 },
    dividend: { pe: 10, pb: 1.0, ps: 1.5 }, balanced: { pe: 25, pb: 2.5, ps: 4 }
  }[ct] || { pe: 25, pb: 2.5, ps: 4 };
  const peAvg = (industryAvg && industryAvg.pe) ? industryAvg.pe : bench.pe;
  const pbAvg = (industryAvg && industryAvg.pb) ? industryAvg.pb : bench.pb;

  const signals = [];
  // 20260909j 审计：f.peTtm 字段从未在任何数据源定义（历史遗留），f.pe（腾讯行情）本身即滚动 TTM 口径
  const pe = f.pe || 0;
  const pb = f.pb || 0;
  // 20260909j 审计：PE 为 TTM 口径，标签明示；PS 主口径为东财 PS_TTM，本地兜底（总市值÷最新一期营收）非 TTM，按 psSource 区分标注
  const psLabel = (f.psSource && String(f.psSource).indexOf('PS_TTM') >= 0) ? '市销率 PS(TTM)' : '市销率 PS';

  // 20260905h：负 PE（TTM 亏损）不再静默——亏损本身构成利空，与行业均值对比无意义，直接给利空标签。
  // 修复「亏损股 PE 行无利好/利空识别」的失灵问题（类型级：所有个股共用本逻辑）。
  if (pe < 0) {
    signals.push({ key: 'pe', label: '市盈率 PE(TTM)', value: pe.toFixed(1) + ' 倍', signal: 'bear', reason: `PE(TTM) ${pe.toFixed(1)} 为负值（TTM 口径亏损），市盈率失效且不与行业均值对比，亏损本身构成利空` });
  }
  else if (pe > 0) {
    // 20260919a：叠加「自身历史百分位」——行业均值持平（中性带）时，用历史高低分位做方向修正（单一数据源：valuationHistory）
    const peSeries = (f.valuationHistory || []).map(d => d.pe).filter(v => v > 0);
    const pePct = peSeries.length >= 2 ? percentileRank(peSeries, pe) : null;
    const pePctTxt = pePct != null ? `，历史百分位 ${pePct}%` : '';
    if (pe < peAvg * 0.8) signals.push({ key: 'pe', label: '市盈率 PE(TTM)', value: pe.toFixed(1) + ' 倍', signal: 'bull', reason: `PE(TTM) ${pe.toFixed(1)} 低于行业均值 ${peAvg.toFixed(2)}（约 ${(pe / peAvg * 100).toFixed(0)}%），估值偏低，利好${pePctTxt}` });
    else if (pe > peAvg * 1.2) signals.push({ key: 'pe', label: '市盈率 PE(TTM)', value: pe.toFixed(1) + ' 倍', signal: 'bear', reason: `PE(TTM) ${pe.toFixed(1)} 高于行业均值 ${peAvg.toFixed(2)}（约 ${(pe / peAvg * 100).toFixed(0)}%），估值偏贵，利空${pePctTxt}` });
    else if (pePct != null && pePct <= 20) signals.push({ key: 'pe', label: '市盈率 PE(TTM)', value: pe.toFixed(1) + ' 倍', signal: 'bull', reason: `PE(TTM) ${pe.toFixed(1)} 接近行业均值 ${peAvg.toFixed(2)}，但处于自身历史 ${pePct}% 低分位，估值偏低，利好` });
    else if (pePct != null && pePct >= 80) signals.push({ key: 'pe', label: '市盈率 PE(TTM)', value: pe.toFixed(1) + ' 倍', signal: 'bear', reason: `PE(TTM) ${pe.toFixed(1)} 接近行业均值 ${peAvg.toFixed(2)}，但处于自身历史 ${pePct}% 高分位，估值偏贵，利空` });
    else signals.push({ key: 'pe', label: '市盈率 PE(TTM)', value: pe.toFixed(1) + ' 倍', signal: 'neutral', reason: `PE(TTM) ${pe.toFixed(1)} 接近行业均值 ${peAvg.toFixed(2)}${pePctTxt}` });
  }
  // 20260905h：负 PB（每股净资产为负、资不抵债，多见于 ST 类个股）同样补利空分支，不再静默。
  if (pb < 0) {
    signals.push({ key: 'pb', label: '市净率 PB', value: pb.toFixed(1) + ' 倍', signal: 'bear', reason: `PB ${pb.toFixed(1)} 为负值（每股净资产为负，资不抵债），利空` });
  }
  else if (pb > 0) {
    // 20260919a：叠加「自身历史百分位」（同 PE，单一数据源 valuationHistory）
    const pbSeries = (f.valuationHistory || []).map(d => d.pb).filter(v => v > 0);
    const pbPct = pbSeries.length >= 2 ? percentileRank(pbSeries, pb) : null;
    const pbPctTxt = pbPct != null ? `，历史百分位 ${pbPct}%` : '';
    if (pb < pbAvg * 0.8) signals.push({ key: 'pb', label: '市净率 PB', value: pb.toFixed(1) + ' 倍', signal: 'bull', reason: `PB ${pb.toFixed(1)} 低于行业均值 ${pbAvg.toFixed(2)}，破净/低估，利好${pbPctTxt}` });
    else if (pb > pbAvg * 1.2) signals.push({ key: 'pb', label: '市净率 PB', value: pb.toFixed(1) + ' 倍', signal: 'bear', reason: `PB ${pb.toFixed(1)} 高于行业均值 ${pbAvg.toFixed(2)}，利空${pbPctTxt}` });
    else if (pbPct != null && pbPct <= 20) signals.push({ key: 'pb', label: '市净率 PB', value: pb.toFixed(1) + ' 倍', signal: 'bull', reason: `PB ${pb.toFixed(1)} 接近行业均值 ${pbAvg.toFixed(2)}，但处于自身历史 ${pbPct}% 低分位，估值偏低，利好` });
    else if (pbPct != null && pbPct >= 80) signals.push({ key: 'pb', label: '市净率 PB', value: pb.toFixed(1) + ' 倍', signal: 'bear', reason: `PB ${pb.toFixed(1)} 接近行业均值 ${pbAvg.toFixed(2)}，但处于自身历史 ${pbPct}% 高分位，估值偏贵，利空` });
    else signals.push({ key: 'pb', label: '市净率 PB', value: pb.toFixed(1) + ' 倍', signal: 'neutral', reason: `PB ${pb.toFixed(1)} 接近行业均值 ${pbAvg.toFixed(2)}${pbPctTxt}` });
  }

  // 市销率 PS：优先用历史百分位（数据可靠，不依赖行业均值），无历史序列则不误判
  const ps = f.ps || 0;
  const psSeries = (f.valuationHistory || []).map(d => d.ps).filter(v => v > 0);
  const psPct = psSeries.length >= 2 ? percentileRank(psSeries, ps) : null;
  if (ps > 0 && psPct != null) {
    if (psPct >= 80) signals.push({ key: 'ps', label: psLabel, value: ps.toFixed(1) + ' 倍', signal: 'bear', reason: `PS ${ps.toFixed(1)} 处于历史 ${psPct}% 分位（偏高），估值偏贵，利空` });
    else if (psPct <= 20) signals.push({ key: 'ps', label: psLabel, value: ps.toFixed(1) + ' 倍', signal: 'bull', reason: `PS ${ps.toFixed(1)} 处于历史 ${psPct}% 分位（偏低），估值偏低，利好` });
    else signals.push({ key: 'ps', label: psLabel, value: ps.toFixed(1) + ' 倍', signal: 'neutral', reason: `PS ${ps.toFixed(1)} 处于历史 ${psPct}% 分位` });
  }

  // === 营收增速：必须用「边际趋势」判断（同比加速/放缓），不能只看当期绝对值 ===
  // 20261103b 修复：去年同期必须按「同报告期去年同期」对齐（与利润增长一致用 samePeriodYoY），
  // 旧逻辑 revSeries[length-2] 取的是数组倒数第二期（=去年 Q4），属错误报告期；且旧逻辑把单季(DJD_TOI_YOY,小数)
  // 当前值与累计(TOTALOPERATEREVETZ,百分数)历史值混比，口径不一致。
  // 优先单季口径 DJD_TOI_YOY，缺失回退累计 TOTALOPERATEREVETZ，与 20261102a 增长指标单季优先口径一致。
  // ★ 20261103d 百分数口径契约（修复 ×100 放大 bug）：东财 ZYZBAjaxNew 的 DJD_TOI_YOY / TOTALOPERATEREVETZ
  //   均为**百分数**（勾稽实证：海天 Q1 +8.57 / Q2 +2.93 / Q3 +0.12 单季之和 ≈ 累计 +4.27%，与 TOTALOPERATEREVETZ 吻合）。
  //   严禁「<1 即小数×100」启发式——曾把 0.12% 放大成 12.44% 导致误判「加速利好」（20261103b 引入）。
  //   仅美股兜底字段 revenueGrowth（Yahoo，小数）需 ×100。
  // 20261104b（用户指令：单季/累计一键切换）：增长口径取数字段按设置重排（sq=单季优先回退累计 / cum=累计优先回退单季），
  // 组内逐字段回退的稳健机制不变。口径标签 calTx 用于信号文案如实标注（单季优先口径 / 累计口径）。
  const calTx = growthCaliberLabel();
  const revPair = samePeriodYoY(f.zyzbHistory, orderedYoYFields(['DJD_TOI_YOY', 'TOTALOPERATEREVETZ']));
  const rgRaw = (f.revenueYoy != null) ? f.revenueYoy : (f.revenueGrowth != null ? f.revenueGrowth * 100 : 0);
  const rg = revPair.cur != null ? revPair.cur : rgRaw;
  const rgPrior = revPair.prev != null ? revPair.prev : null;
  if (rgPrior !== null) {
    if (rg < 0) signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'bear', reason: `营收同比 ${rg.toFixed(1)}% 为负增长，利空` });
    else {
      const dpp = rg - rgPrior; // 边际变化（百分点，均为同报告期去年同期对齐值）
      if (dpp > 0.5) signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'bull', reason: `营收增速 ${rg.toFixed(1)}%（去年同期 ${rgPrior.toFixed(1)}%），同比加速 +${dpp.toFixed(1)}pp，成长动能增强，利好` });
      else if (dpp < -0.5) signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'bear', reason: `营收增速 ${rg.toFixed(1)}%（去年同期 ${rgPrior.toFixed(1)}%），边际放缓 ${dpp.toFixed(1)}pp，成长动能减弱，利空` });
      else signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'neutral', reason: `营收增速 ${rg.toFixed(1)}%（去年同期 ${rgPrior.toFixed(1)}%），基本持平，动能平稳` });
    }
  } else {
    // 无同报告期历史可比序列时退化为绝对阈值（保留原逻辑，避免无结论）
    if (rg > 15) signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'bull', reason: `营收增速 ${rg.toFixed(1)}% 较高，成长性强，利好` });
    else if (rg < 0) signals.push({ key: 'growth', label: '营收增速', value: rg.toFixed(1) + '%', signal: 'bear', reason: `营收负增长 ${rg.toFixed(1)}%，利空` });
    else if (rg === 0) signals.push({ key: 'growth', label: '营收增速', value: '0%', signal: 'bear', reason: `营收零增长，成长乏力，利空` });
  }

  // === ROE：① 绝对分档（金融业/一般企业）；② 必须叠加「行业均值」相对判断，低于行业则给出利空结论 ===
  // 20260909j：与关键财务指标行同口径——优先统一 TTM 值（stockData.computeTtmMetrics），回退最新披露期 ROEJQ
  const roeRaw = (f.roeTtm != null) ? f.roeTtm : (f.roe || 0);
  const roe = Math.abs(roeRaw) < 1 ? roeRaw * 100 : roeRaw;
  const indRoe = (industryAvg && typeof industryAvg.roe === 'number' && industryAvg.roe > 0) ? industryAvg.roe : null;
  const roeTier = (r) => {
    if (isFinancial) return r >= 12 ? 'bull' : r >= 8 ? 'neutral' : 'bear';
    return r >= 15 ? 'bull' : r >= 10 ? 'neutral' : r >= 5 ? 'neutral' : 'bear';
  };
  if (roe > 0) {
    let tier = roeTier(roe);
    // 行业相对修正：低于行业均值 → 至少利空；略低于 → 至多中性（不盲目判利好）
    if (indRoe != null) {
      if (roe < indRoe * 0.9) tier = 'bear';
      else if (roe < indRoe && tier === 'bull') tier = 'neutral';
    }
    // 20260919a「相对优势升级通道」：中性档若具备相对优势证据，上调为利好
    // 证据=①显著优于行业均值(≥1.1×) ②处自身历史高分位(≥80%) ③同比显著改善(>1.5pp)
    const roePct = (opts && opts.percentiles && typeof opts.percentiles.roe === 'number') ? opts.percentiles.roe : null;
    const roeYoy = (typeof f.roeTtmPrev === 'number' && f.roeTtmPrev > 0) ? (roe - f.roeTtmPrev) : null;
    let upgradeNote = '';
    if (tier === 'neutral') {
      const strongVsInd = indRoe != null && roe >= indRoe * 1.1;
      const highPct = roePct != null && roePct >= 80;
      const yoyUp = roeYoy != null && roeYoy > 1.5;
      if (strongVsInd || highPct || yoyUp) {
        tier = 'bull';
        const bits = [];
        if (strongVsInd) bits.push(`显著优于行业均值（${indRoe.toFixed(1)}%）`);
        if (highPct) bits.push(`处自身历史 ${roePct}% 高分位`);
        if (yoyUp) bits.push(`同比改善 ${roeYoy.toFixed(1)}pp`);
        upgradeNote = `；且${bits.join('、')}，相对优势明确，上调为利好`;
      }
    }
    const indTxt = indRoe != null ? `（行业均值 ROE ${indRoe.toFixed(1)}%）` : '';
    const relTxt = indRoe != null
      ? (roe >= indRoe * 1.1 ? '，显著优于行业均值' : roe >= indRoe ? '，略优于行业均值' : roe >= indRoe * 0.9 ? '，略低于行业均值' : '，显著低于行业均值')
      : '';
    const base = {
      bull: `ROE ${roe.toFixed(1)}% 优秀，盈利能力强，利好`,
      neutral: `ROE ${roe.toFixed(1)}% 良好，盈利能力稳健`,
      bear: `ROE ${roe.toFixed(1)}% 偏弱，盈利能力弱，利空`,
    }[tier];
    signals.push({ key: 'roe', label: 'ROE', value: roe.toFixed(1) + '%', signal: tier, reason: base + indTxt + relTxt + upgradeNote });
  } else if (roe <= 0) signals.push({ key: 'roe', label: 'ROE', value: roe.toFixed(1) + '%', signal: 'bear', reason: `ROE 非正，盈利能力弱，利空` });

  // === 股息率：用「每股股息同比高低变化」判断（分红加码=利好，缩减=利空）===
  // 股息率 = 每股股息 / 股价，历史股价不可得，故以「每股股息同比」衡量分红力度的高低变化（同源：东财分红接口）
  const dyRaw = f.dividendYield || 0;
  // 20260909k 审计修复：东财源值已是百分数（dividendYieldIsPct=true，如 0.53 表示 0.53%），
  // 不得再按「<1 即小数」猜测换算 ×100（300319 曾被误算成 53%）。仅无 IsPct 标记的兜底源保留小数换算。
  const dy = (typeof dyRaw === 'number' && dyRaw < 1 && !f.dividendYieldIsPct) ? dyRaw * 100 : dyRaw;
  const dyYoy = (typeof f.dividendYoyPct === 'number') ? f.dividendYoyPct : null;
  if (dyYoy != null) {
    if (dyYoy > 0) signals.push({ key: 'div', label: '股息率(TTM)', value: dy.toFixed(1) + '%', signal: 'bull', reason: `每股股息同比 +${dyYoy.toFixed(1)}%（分红加码），股息率走高，红利属性增强，利好` });
    else if (dyYoy < 0) signals.push({ key: 'div', label: '股息率(TTM)', value: dy.toFixed(1) + '%', signal: 'bear', reason: `每股股息同比 ${dyYoy.toFixed(1)}%（分红缩减），股息率走低，红利属性减弱，利空` });
    else signals.push({ key: 'div', label: '股息率(TTM)', value: dy.toFixed(1) + '%', signal: 'neutral', reason: `每股股息同比持平，分红力度稳定` });
  } else if (dy >= 3) signals.push({ key: 'div', label: '股息率(TTM)', value: dy.toFixed(1) + '%', signal: 'bull', reason: `股息率 ${dy.toFixed(1)}% 较高，红利属性强，利好` });
  else if (ct === 'dividend' && dy > 0 && dy < 1) signals.push({ key: 'div', label: '股息率(TTM)', value: dy.toFixed(1) + '%', signal: 'bear', reason: `股息率仅 ${dy.toFixed(1)}%，红利吸引力弱，利空` });
  else if (dy > 0) signals.push({ key: 'div', label: '股息率(TTM)', value: dy.toFixed(1) + '%', signal: 'neutral', reason: `股息率 ${dy.toFixed(1)}% 处于常规区间` });

  // PEG（<1 成长性估值偏低利好，>2 透支利空）
  const peg = f.peg || 0;
  if (peg > 0) {
    if (peg < 1) signals.push({ key: 'peg', label: 'PEG', value: peg.toFixed(2), signal: 'bull', reason: `PEG ${peg.toFixed(2)} < 1，成长性估值合理/偏低，利好` });
    else if (peg > 2) signals.push({ key: 'peg', label: 'PEG', value: peg.toFixed(2), signal: 'bear', reason: `PEG ${peg.toFixed(2)} > 2，成长性透支，利空` });
    else signals.push({ key: 'peg', label: 'PEG', value: peg.toFixed(2), signal: 'neutral', reason: `PEG ${peg.toFixed(2)} 处于 1~2 合理区间` });
  }

  // 毛利率（>30% 盈利质量强，<15% 弱）
  // 20260909j：与关键财务指标行同口径——优先统一 TTM 值（可加分子/分母滚动12个月），回退最新披露期口径
  const gm = (f.grossMarginTtm != null) ? f.grossMarginTtm : (f.grossMargin || 0);
  if (gm > 0) {
    let tier = gm >= 30 ? 'bull' : gm < 15 ? 'bear' : 'neutral';
    // 20260919a 升级通道：中性档若处历史高分位或同比显著改善，上调为利好
    const gmPct = (opts && opts.percentiles && typeof opts.percentiles.grossMargin === 'number') ? opts.percentiles.grossMargin : null;
    const gmPair = samePeriodYoY(f.zyzbHistory, 'XSMLL');
    const gmYoy = (gmPair.cur != null && gmPair.prev != null) ? (gmPair.cur - gmPair.prev) : null;
    let upgradeNote = '';
    if (tier === 'neutral') {
      const highPct = gmPct != null && gmPct >= 80;
      const yoyUp = gmYoy != null && gmYoy > 1.5;
      if (highPct || yoyUp) {
        tier = 'bull';
        const bits = [];
        if (highPct) bits.push(`处自身历史 ${gmPct}% 高分位`);
        if (yoyUp) bits.push(`同比改善 ${gmYoy.toFixed(1)}pp`);
        upgradeNote = `；且${bits.join('、')}，相对优势明确，上调为利好`;
      }
    }
    const base = {
      bull: `毛利率 ${gm.toFixed(1)}% 较高，产品竞争力强，利好`,
      neutral: `毛利率 ${gm.toFixed(1)}% 处于行业常规区间`,
      bear: `毛利率 ${gm.toFixed(1)}% 偏低，盈利空间有限，利空`,
    }[tier];
    signals.push({ key: 'grossMargin', label: '毛利率', value: gm.toFixed(1) + '%', signal: tier, reason: base + upgradeNote });
  }

  // 净利率（>20% 强，<5% 弱）
  // 20260909j：与关键财务指标行同口径——优先统一 TTM 值，回退最新披露期口径
  const nm = (f.netMarginTtm != null) ? f.netMarginTtm : (f.netMargin || 0);
  if (nm > 0) {
    let tier = nm >= 20 ? 'bull' : nm < 5 ? 'bear' : 'neutral';
    // 20260919a 升级通道：中性档若处历史高分位或同比显著改善，上调为利好
    const nmPct = (opts && opts.percentiles && typeof opts.percentiles.netMargin === 'number') ? opts.percentiles.netMargin : null;
    const nmPair = samePeriodYoY(f.zyzbHistory, 'XSJLL');
    const nmYoy = (nmPair.cur != null && nmPair.prev != null) ? (nmPair.cur - nmPair.prev) : null;
    let upgradeNote = '';
    if (tier === 'neutral') {
      const highPct = nmPct != null && nmPct >= 80;
      const yoyUp = nmYoy != null && nmYoy > 1.5;
      if (highPct || yoyUp) {
        tier = 'bull';
        const bits = [];
        if (highPct) bits.push(`处自身历史 ${nmPct}% 高分位`);
        if (yoyUp) bits.push(`同比改善 ${nmYoy.toFixed(1)}pp`);
        upgradeNote = `；且${bits.join('、')}，相对优势明确，上调为利好`;
      }
    }
    const base = {
      bull: `净利率 ${nm.toFixed(1)}% 较高，盈利质量好，利好`,
      neutral: `净利率 ${nm.toFixed(1)}% 处于常规区间`,
      bear: `净利率 ${nm.toFixed(1)}% 偏低，盈利能力弱，利空`,
    }[tier];
    signals.push({ key: 'netMargin', label: '净利率', value: nm.toFixed(1) + '%', signal: tier, reason: base + upgradeNote });
  }

  // 利润增长（归母净利润同比）：与营收增速一致，用「边际趋势」判断。
  // 20261102a（用户指令）：单季口径优先（DJD_DPNP_YOY），缺失回退累计（PARENTNETPROFITTZ），按去年同期同报告期对齐
  // 20261104b：字段优先级随口径设置重排（单季/累计一键切换），文案标注口径
  const pgPair = samePeriodYoY(f.zyzbHistory, orderedYoYFields(['DJD_DPNP_YOY', 'PARENTNETPROFITTZ']));
  // ★ 20261103d 百分数口径契约：DJD_DPNP_YOY / PARENTNETPROFITTZ 均为百分数，直接使用；
  //   仅美股兜底 earningsGrowth（Yahoo，小数）×100。profitGrowth（本地生产端为百分数）不换算。
  const pgRaw = (f.profitYoy != null) ? f.profitYoy : (f.earningsGrowth != null ? f.earningsGrowth * 100 : (f.profitGrowth != null ? f.profitGrowth : 0));
  const pg = pgPair.cur != null ? pgPair.cur : pgRaw;
  const pgPrior = pgPair.prev;
  if (pg != null && pgPrior !== null) {
    if (pg < 0) signals.push({ key: 'profitGrowth', label: '归母净利润', value: pg.toFixed(1) + '%', signal: 'bear', reason: `利润同比（${calTx}） ${pg.toFixed(1)}% 为负增长，利空` });
    else {
      const dpp = pg - pgPrior;
      if (dpp > 0.5) signals.push({ key: 'profitGrowth', label: '归母净利润', value: pg.toFixed(1) + '%', signal: 'bull', reason: `利润增速（${calTx}） ${pg.toFixed(1)}%（去年同期 ${pgPrior.toFixed(1)}%），同比加速 +${dpp.toFixed(1)}pp，盈利动能增强，利好` });
      else if (dpp < -0.5) signals.push({ key: 'profitGrowth', label: '归母净利润', value: pg.toFixed(1) + '%', signal: 'bear', reason: `利润增速（${calTx}） ${pg.toFixed(1)}%（去年同期 ${pgPrior.toFixed(1)}%），边际放缓 ${dpp.toFixed(1)}pp，盈利动能减弱，利空` });
      else signals.push({ key: 'profitGrowth', label: '归母净利润', value: pg.toFixed(1) + '%', signal: 'neutral', reason: `利润增速（${calTx}） ${pg.toFixed(1)}%（去年同期 ${pgPrior.toFixed(1)}%），基本持平，动能平稳` });
    }
  } else {
    if (pg > 15) signals.push({ key: 'profitGrowth', label: '归母净利润', value: pg.toFixed(1) + '%', signal: 'bull', reason: `利润增速 ${pg.toFixed(1)}% 较高，盈利高成长，利好` });
    else if (pg < 0) signals.push({ key: 'profitGrowth', label: '归母净利润', value: pg.toFixed(1) + '%', signal: 'bear', reason: `利润负增长 ${pg.toFixed(1)}%，利空` });
    else if (pg === 0) signals.push({ key: 'profitGrowth', label: '归母净利润', value: '0%', signal: 'bear', reason: `利润零增长，成长乏力，利空` });
  }

  // 扣非净利润增长（扣非归母净利润同比）：与利润增长同标准（边际趋势判断）。
  // 20261102a（用户指令）：单季口径优先（DJD_DEDUCTDPNP_YOY），缺失回退累计（KCFJCXSYJLRTZ），按去年同期同报告期对齐
  // 20261104b：字段优先级随口径设置重排
  const dedPair = samePeriodYoY(f.zyzbHistory, orderedYoYFields(['DJD_DEDUCTDPNP_YOY', 'KCFJCXSYJLRTZ']));
  const ded = dedPair.cur != null ? dedPair.cur : 0;
  const dedPrior = dedPair.prev;
  if (ded != null && dedPrior !== null) {
    if (ded < 0) signals.push({ key: 'dedProfitGrowth', label: '扣非净利润增长', value: ded.toFixed(1) + '%', signal: 'bear', reason: `扣非净利同比（${calTx}） ${ded.toFixed(1)}% 为负增长，利空` });
    else {
      const dpp2 = ded - dedPrior;
      if (dpp2 > 0.5) signals.push({ key: 'dedProfitGrowth', label: '扣非净利润增长', value: ded.toFixed(1) + '%', signal: 'bull', reason: `扣非净利增速（${calTx}） ${ded.toFixed(1)}%（去年同期 ${dedPrior.toFixed(1)}%），同比加速 +${dpp2.toFixed(1)}pp，盈利动能增强，利好` });
      else if (dpp2 < -0.5) signals.push({ key: 'dedProfitGrowth', label: '扣非净利润增长', value: ded.toFixed(1) + '%', signal: 'bear', reason: `扣非净利增速（${calTx}） ${ded.toFixed(1)}%（去年同期 ${dedPrior.toFixed(1)}%），边际放缓 ${dpp2.toFixed(1)}pp，盈利动能减弱，利空` });
      else signals.push({ key: 'dedProfitGrowth', label: '扣非净利润增长', value: ded.toFixed(1) + '%', signal: 'neutral', reason: `扣非净利增速（${calTx}） ${ded.toFixed(1)}%（去年同期 ${dedPrior.toFixed(1)}%），基本持平，动能平稳` });
    }
  } else {
    if (ded > 15) signals.push({ key: 'dedProfitGrowth', label: '扣非净利润增长', value: ded.toFixed(1) + '%', signal: 'bull', reason: `扣非净利增速 ${ded.toFixed(1)}% 较高，盈利高成长，利好` });
    else if (ded < 0) signals.push({ key: 'dedProfitGrowth', label: '扣非净利润增长', value: ded.toFixed(1) + '%', signal: 'bear', reason: `扣非净利负增长 ${ded.toFixed(1)}%，利空` });
    else if (ded === 0) signals.push({ key: 'dedProfitGrowth', label: '扣非净利润增长', value: '0%', signal: 'bear', reason: `扣非净利零增长，成长乏力，利空` });
  }

  // 流动比率（>1.5 短期偿债稳健，<1 紧张）
  const cr = f.currentRatio || 0;
  if (cr > 0) {
    if (cr >= 1.5) signals.push({ key: 'currentRatio', label: '流动比率', value: cr.toFixed(2), signal: 'bull', reason: `流动比率 ${cr.toFixed(2)} 较高，短期偿债能力强，利好` });
    else if (cr < 1) signals.push({ key: 'currentRatio', label: '流动比率', value: cr.toFixed(2), signal: 'bear', reason: `流动比率 ${cr.toFixed(2)} < 1，短期偿债压力大，利空` });
    else signals.push({ key: 'currentRatio', label: '流动比率', value: cr.toFixed(2), signal: 'neutral', reason: `流动比率 ${cr.toFixed(2)} 处于合理区间` });
  }

  // 每股经营现金流（为正=造血，为负=失血）
  const ocf = f.operatingCashFlowPerShare || 0;
  if (ocf > 0) signals.push({ key: 'ocf', label: '每股经营现金流', value: ocf.toFixed(2), signal: 'bull', reason: `每股经营现金流 ${ocf.toFixed(2)} 为正，造血能力强，利好` });
  else if (ocf < 0) signals.push({ key: 'ocf', label: '每股经营现金流', value: ocf.toFixed(2), signal: 'bear', reason: `每股经营现金流 ${ocf.toFixed(2)} 为负，经营失血，利空` });

  const d2e = f.debtToEquity || 0;
  const isPct = !!(f.debtMetricPct); // A股取的是资产负债率%，港股/美股取的是带息债÷权益比值
  if (isFinancial) {
    // 金融业（银行/保险等）资债比天然偏高（存贷/承保业务依赖负债），属经营常态，不判利空/利好
    signals.push({ key: 'debt', label: '资产负债率', value: isPct ? d2e.toFixed(2) + '%' : d2e.toFixed(2), signal: 'neutral', reason: `金融业${isPct ? '资产负债率 ' + d2e.toFixed(2) + '%' : '带息债/权益 ' + d2e.toFixed(2)} 属经营常态（存贷/承保业务天然依赖负债），不视为利空` });
  } else if (isPct) {
    // A股口径：数值为资产负债率（百分比）
    if (d2e > 70) signals.push({ key: 'debt', label: '资产负债率', value: d2e.toFixed(2) + '%', signal: 'bear', reason: `资产负债率 ${d2e.toFixed(2)}% 偏高（>70%），财务杠杆风险较大，利空` });
    else if (d2e > 0 && d2e < 40) signals.push({ key: 'debt', label: '资产负债率', value: d2e.toFixed(2) + '%', signal: 'bull', reason: `资产负债率 ${d2e.toFixed(2)}% 较低（<40%），财务稳健，利好` });
    // 40%~70% 为合理区间，不单独提示
  } else {
    // 港股/美股口径：带息债 ÷ 所有者权益（比值）
    if (d2e > 2) signals.push({ key: 'debt', label: '资产负债率', value: d2e.toFixed(2), signal: 'bear', reason: `带息债/权益 ${d2e.toFixed(2)} 偏高，偿债压力大，利空` });
    else if (d2e > 0 && d2e < 0.5) signals.push({ key: 'debt', label: '资产负债率', value: d2e.toFixed(2), signal: 'bull', reason: `带息债/权益 ${d2e.toFixed(2)} 很低，财务稳健，利好` });
  }

  return {
    signals,
    peAvg, pbAvg,
    compareBasis: '行业均值'
  };
}

// ---- Sentiment Analysis (basic keyword-based) ----
const positiveKeywords = [
  '利好', '增长', '盈利', '突破', '创新高', '超预期', '回购', '分红', '增持', '买入',
  '上涨', '强势', '看好', '机遇', '合作', '签约', '订单', '获批', '认证', ' award',
  '涨停', '大涨', '暴涨', '走高', '拉升', '走强', '反弹', '涨停潮', '净流入',
  '预增', '扭亏', '中标', '加仓', '回暖', '扩张', '景气', '里程碑', '成功', '达成',
  '涨超', '领涨', '放量', '封板',
  'profit', 'growth', 'beat', 'surge', 'rally', 'upgrade', 'buy', 'bullish', 'gain', 'rise',
  'positive', 'outperform', 'strong', 'record', 'breakthrough'
];

const negativeKeywords = [
  '利空', '亏损', '下降', '下跌', '减持', '卖出', '风险', '警告', '违规', '处罚',
  '诉讼', '退市', '暴跌', '破发', '破净', '停牌', '问询', '监管', '警示', '下调',
  '跌停', '大跌', '跌停潮', '下挫', '回落', '走弱', '杀跌', '跳水', '重挫', '净流出',
  '预减', '爆雷', '承压', '低迷', '套现', '立案', '失败', '跌超', '领跌', '缩量',
  'loss', 'decline', 'drop', 'fall', 'sell', 'bearish', 'downgrade', 'risk', 'lawsuit',
  'warning', 'negative', 'miss', 'plunge', 'crash', 'halt', 'investigation'
];

function analyzeSentiment(text) {
  if (!text) return { score: 0, label: '中性' };
  const lower = text.toLowerCase();
  let pos = 0, neg = 0;

  for (const kw of positiveKeywords) {
    if (lower.includes(kw.toLowerCase())) pos++;
  }
  for (const kw of negativeKeywords) {
    if (lower.includes(kw.toLowerCase())) neg++;
  }

  const total = pos + neg;
  if (total === 0) return { score: 0, label: '中性', positive: 0, negative: 0 };

  const score = Math.round(((pos - neg) / total) * 100);
  let label = '中性';
  if (score > 30) label = '积极';
  else if (score > 10) label = '偏多';
  else if (score < -30) label = '消极';
  else if (score < -10) label = '偏空';

  return { score, label, positive: pos, negative: neg };
}

function aggregateSentiment(newsList) {
  if (!newsList || newsList.length === 0) {
    return { overall: '中性', score: 0, positive: 0, negative: 0, neutral: 0, distribution: { pos: 33, neu: 34, neg: 33 } };
  }

  let totalScore = 0;
  let pos = 0, neg = 0, neu = 0;

  for (const news of newsList) {
    const sentiment = news.sentiment || analyzeSentiment(news.title + ' ' + (news.summary || ''));
    totalScore += sentiment.score;
    if (sentiment.label === '积极' || sentiment.label === '偏多') pos++;
    else if (sentiment.label === '消极' || sentiment.label === '偏空') neg++;
    else neu++;
  }

  const avgScore = Math.round(totalScore / newsList.length);
  let overall = '中性';
  if (avgScore > 15) overall = '积极';
  else if (avgScore > 5) overall = '偏多';
  else if (avgScore < -15) overall = '消极';
  else if (avgScore < -5) overall = '偏空';

  const total = newsList.length;
  return {
    overall,
    score: avgScore,
    positive: pos,
    negative: neg,
    neutral: neu,
    distribution: {
      pos: Math.round((pos / total) * 100),
      neu: Math.round((neu / total) * 100),
      neg: Math.round((neg / total) * 100)
    }
  };
}

// ---- 历史百分位 helpers ----
function percentileRank(arr, value) {
  if (!Array.isArray(arr) || arr.length === 0 || value == null || !isFinite(value)) return null;
  const sorted = arr.filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  let count = 0;
  for (const v of sorted) if (v <= value) count++;
  return Math.round((count / sorted.length) * 100);
}

function toNum(v) {
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// 构建「关键财务指标对标」数据：历史百分位 + 行业均值
async function buildFundamentalComparison(symbol, quote) {
  const result = {
    perShareOCF: quote?.fundamentals?.operatingCashFlowPerShare || 0,
    perShareOCFPeriod: quote?.fundamentals?.operatingCashFlowPeriodName || '',
    percentiles: {},
    industryAvg: null,
    industryName: quote?.fundamentals?.industryName || '',
    source: '东方财富估值分析/财报',
  };

  const info = detectMarket(symbol);
  const stockCode = info.tencentCode.replace(/^(sh|sz|hk|us)/, '');

  // 1) 历史百分位：基于 ZYZBAjaxNew 返回的多期财务指标
  const hist = quote?.fundamentals?.zyzbHistory;
  if (Array.isArray(hist) && hist.length >= 2) {
    const series = {
      roe: hist.map(d => toNum(d.ROEJQ)).filter(v => v !== null),
      grossMargin: hist.map(d => toNum(d.XSMLL)).filter(v => v !== null),
      netMargin: hist.map(d => toNum(d.XSJLL)).filter(v => v !== null),
      // 20261102a（用户指令）：增长百分位序列同样「单季优先」（DJD_*_YOY 回退 *_TZ），与左卡主值同口径
      // 20261104b：序列取数口径随设置切换（单季/累计一键切换），与同比主值/信号判定同口径
      revenueGrowth: hist.map(d => { const o = orderedYoYFields(['DJD_TOI_YOY', 'TOTALOPERATEREVETZ']); const a = toNum(d[o[0]]); return a != null ? a : toNum(d[o[1]]); }).filter(v => v !== null),
      profitGrowth: hist.map(d => { const o = orderedYoYFields(['DJD_DPNP_YOY', 'PARENTNETPROFITTZ']); const a = toNum(d[o[0]]); return a != null ? a : toNum(d[o[1]]); }).filter(v => v !== null),
      debtToEquity: hist.map(d => toNum(d.ZCFZL)).filter(v => v !== null),
      currentRatio: hist.map(d => toNum(d.LD)).filter(v => v !== null),
    };
    const current = {
      // 20260909j：ROE/毛利率/净利率百分位「当前值」与关键财务指标行同口径（统一 TTM，回退披露期）
      roe: toNum(quote?.fundamentals?.roeTtm ?? quote?.fundamentals?.roe),
      grossMargin: toNum(quote?.fundamentals?.grossMarginTtm ?? quote?.fundamentals?.grossMargin),
      netMargin: toNum(quote?.fundamentals?.netMarginTtm ?? quote?.fundamentals?.netMargin),
      revenueGrowth: toNum(quote?.fundamentals?.revenueYoy),
      profitGrowth: toNum(quote?.fundamentals?.profitYoy),
      debtToEquity: toNum(quote?.fundamentals?.debtToEquity),
      currentRatio: toNum(quote?.fundamentals?.currentRatio),
    };
    for (const [k, arr] of Object.entries(series)) {
      result.percentiles[k] = percentileRank(arr, current[k]);
    }
  }

  // 1b) 估值指标（PE/PB）历史百分位：基于估值分析日频序列
  const vh = quote?.fundamentals?.valuationHistory;
  if (Array.isArray(vh) && vh.length >= 2) {
    const peSeries = vh.map(d => d.pe).filter(v => v > 0);
    const pbSeries = vh.map(d => d.pb).filter(v => v > 0);
    const psSeries = vh.map(d => d.ps).filter(v => v > 0);
    result.percentiles.pe = percentileRank(peSeries, toNum(quote?.fundamentals?.pe));
    result.percentiles.pb = percentileRank(pbSeries, toNum(quote?.fundamentals?.pb));
    if (psSeries.length >= 2) result.percentiles.ps = percentileRank(psSeries, toNum(quote?.fundamentals?.ps));
  }

  // 2) 行业均值：使用 datacenter-web（push2 被 TLS 指纹封锁，不可用）
  // 2a) 若 backend 已在 fetchEastmoneyFundamentals 中拿到行业名称，直接查行业估值
  try {
    const industryName = result.industryName;
    if (industryName) {
      try {
        const indUrl = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=10&pageNumber=1&reportName=RPT_VALUEINDUSTRY_DET&columns=ALL&source=WEB&client=WEB&filter=(BOARD_NAME=%22${encodeURIComponent(industryName)}%22)`;
        const indResp = await axios.get(indUrl, {
          headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/', Accept: 'application/json' },
          timeout: 10000
        });
        const list = indResp.data?.result?.data || [];
        if (list.length > 0) {
          const latest = list[0];
          const pe = toNum(latest.PE_TTM);
          const pb = toNum(latest.PB_MRQ);
          const ps = toNum(latest.PS_TTM);          // 20260909d：估值维度需要 PS 行业均值
          // 行业 ROE 未直接给出，用 PB/PE 近似估算（ROE = PB/PE）
          const roe = (pb > 0 && pe > 0) ? round((pb / pe) * 100, 2) : null;
          result.industryAvg = { pe, pb, ps, roe, source: '东方财富行业估值' };
        }
      } catch (e2) {
        console.error('[Comparison] industry valuation failed:', e2.message);
      }
    }

    // 2b) 兜底：通过个股估值分析接口再次确认行业/总股本，并尝试行业匹配
    if (!result.industryAvg) {
      try {
        const valUrl = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=10&pageNumber=1&reportName=RPT_VALUEANALYSIS_DET&columns=ALL&source=WEB&client=WEB&filter=(SECURITY_CODE=%22${stockCode}%22)`;
        const valResp = await axios.get(valUrl, {
          headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/', Accept: 'application/json' },
          timeout: 10000
        });
        const latest = (valResp.data?.result?.data || [])[0];
        if (latest && latest.BOARD_NAME) {
          result.industryName = latest.BOARD_NAME;
          const indUrl = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=10&pageNumber=1&reportName=RPT_VALUEINDUSTRY_DET&columns=ALL&source=WEB&client=WEB&filter=(BOARD_NAME=%22${encodeURIComponent(latest.BOARD_NAME)}%22)`;
          const indResp = await axios.get(indUrl, {
            headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/', Accept: 'application/json' },
            timeout: 10000
          });
          const list = indResp.data?.result?.data || [];
          if (list.length > 0) {
            const latestInd = list[0];
            const pe = toNum(latestInd.PE_TTM);
            const pb = toNum(latestInd.PB_MRQ);
            const ps = toNum(latestInd.PS_TTM);
            const roe = (pb > 0 && pe > 0) ? round((pb / pe) * 100, 2) : null;
            result.industryAvg = { pe, pb, ps, roe, source: '东方财富行业估值' };
          }
        }
      } catch (e3) {
        console.error('[Comparison] fallback valuation failed:', e3.message);
      }
    }
  } catch (e) {
    console.error('[Comparison] industry fetch failed:', e.message);
  }

  persistIndustryAvg(result.symbol || stockCode, result.industryAvg);

  return result;
}

module.exports = {
  SMA, EMA, RSI, MACD, Bollinger, KDJ, ADX,
  technicalAnalysis, fundamentalAnalysis, evaluateSignals,
  analyzeSentiment, aggregateSentiment,
  findSupportResistance, analyzeVolume,
  buildFundamentalComparison,
  persistPeg, persistIndustryAvg, loadIndustryAvg, normalizeSym,
};

~~~

---

## `lib\analysisWarm.js`  ·  158 行

~~~js
// lib/analysisWarm.js — 个股数据后台预热与缓存（20261027d）
// 用户需求：工作台长时间开着后，切个股页不应再现场拉数（与「提前后台缓存数据」要求一致）。
// 现状根因：/api/analysis 每次请求都现打腾讯/东财取 quote/history/profile（getQuote/getHistory 无缓存），
//   已有后台任务只预热自选股「判定」（复用不刷数据）与板块资金（一次性），个股页面数据无预热。
// 方案：① /api/analysis 加 TTL 缓存（交易日盘中 9:15~15:10 内 2 分钟，其余 30 分钟——数据最新性：
//   按类型 TTL + 交易日感知；失败响应不缓存防毒化；附加 cachedAt/cacheAgeSec 字段，原结构不变）；
//   ② 后台预热循环：自选股 ∪ 最近查看（LRU 持久化 data/analysis-warm.json），逐只经本机 HTTP 走同一路由
//   填充缓存，命中即秒回。预热是普通 GET，不强制刷新，频率跟随 TTL，不超外部源合理负载。
'use strict';
const fs = require('fs');
const path = require('path');

const PERSIST = path.join(__dirname, '..', 'data', 'analysis-warm.json');
const FRESH_TTL_TRADING_MS = 2 * 60 * 1000;    // 交易日盘中：2 分钟
const FRESH_TTL_OTHER_MS = 30 * 60 * 1000;     // 盘前/盘后/周末：30 分钟
const MAX_CACHE = 30;                          // 缓存 LRU 上限（key=symbol|range）
const MAX_RECENTS = 12;                        // 最近查看保留数
const MAX_WARM = 20;                           // 单轮预热上限（自选股优先）
const WARM_GAP_MS = 500;                       // 逐只间隔，避免打爆外部源

const cache = new Map();      // key -> { payload, ts }
let recents = loadRecents();
let lastCycleTs = 0;
let cycleRunning = false;
let timer = null;

function loadRecents() {
  try {
    const j = JSON.parse(fs.readFileSync(PERSIST, 'utf8'));
    return Array.isArray(j.recents) ? j.recents.filter(s => typeof s === 'string' && s.trim()).slice(0, MAX_RECENTS) : [];
  } catch (e) { return []; }
}
function saveRecents() {
  try {
    ensureDataDir();
    fs.writeFileSync(PERSIST, JSON.stringify({ recents, savedAt: new Date().toISOString() }, null, 2));
  } catch (e) { /* 持久化失败不影响主流程 */ }
}
function ensureDataDir() {
  const dir = path.dirname(PERSIST);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function localDateStr(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// 条目归一化：自选股文件存的是对象 {symbol,name,...}（裸 6 位代码），最近查看存字符串
function normSym(s) {
  if (!s) return '';
  if (typeof s === 'string') return s.trim();
  if (typeof s === 'object') return String(s.symbol || s.code || '').trim();
  return '';
}
// 盘中窗口（本地时刻）：9:15 ~ 15:10
function isTradingSessionNow(d) {
  const t = d.getHours() * 60 + d.getMinutes();
  return t >= 9 * 60 + 15 && t <= 15 * 60 + 10;
}
// TTL：交易日盘中 2 分钟，其余 30 分钟（isTradingDayFn 由 server 传入，法定节假日感知）
function ttlMs(now, isTradingDayFn) {
  const d = now || new Date();
  const tradingDay = isTradingDayFn ? !!isTradingDayFn(localDateStr(d)) : (d.getDay() !== 0 && d.getDay() !== 6);
  return (tradingDay && isTradingSessionNow(d)) ? FRESH_TTL_TRADING_MS : FRESH_TTL_OTHER_MS;
}

/** 读缓存：TTL 内返回带 cachedAt/cacheAgeSec 的 payload（原结构 + 附加字段），过期/缺失返回 null */
function getCached(symbol, range, isTradingDayFn) {
  const key = String(symbol || '') + '|' + (range || '1y');
  const hit = cache.get(key);
  if (!hit) return null;
  const age = Date.now() - hit.ts;
  if (age > ttlMs(new Date(), isTradingDayFn)) return null;
  cache.delete(key); cache.set(key, hit); // LRU touch
  return Object.assign({}, hit.payload, { cachedAt: hit.ts, cacheAgeSec: Math.round(age / 1000) });
}

/** 写缓存：失败/错误响应不缓存（避免毒化）；LRU 超限淘汰最旧 */
function setCached(symbol, range, payload) {
  if (!payload || payload.error) return false;
  const key = String(symbol || '') + '|' + (range || '1y');
  cache.delete(key); cache.set(key, { payload, ts: Date.now() });
  if (cache.size > MAX_CACHE) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  return true;
}

/** 记录「最近查看」个股（LRU + 持久化），供预热循环覆盖用户实际在看的股票 */
function noteAnalysisRequest(symbol) {
  const s = normSym(symbol);
  if (!s || s === '[object Object]') return;
  recents = [s].concat(recents.filter(x => x !== s)).slice(0, MAX_RECENTS);
  saveRecents();
}

/** 预热一轮：自选股 ∪ 最近查看（去重、自选优先、上限 MAX_WARM），逐只经本机 HTTP 走 /api/analysis 填缓存 */
async function warmCycle({ port, getWatchlist }) {
  if (cycleRunning) return { skipped: true, reason: '上一轮未结束' };
  cycleRunning = true;
  const started = Date.now();
  try {
    let wl = [];
    try { wl = getWatchlist ? (getWatchlist() || []) : []; } catch (e) { wl = []; }
    if (!Array.isArray(wl)) wl = [];
    const list = [];
    for (const s of wl.concat(recents)) {
      const v = normSym(s);
      if (v && v !== '[object Object]' && !list.includes(v)) list.push(v);
    }
    const targets = list.slice(0, MAX_WARM);
    let ok = 0, miss = 0;
    for (const sym of targets) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/analysis/${encodeURIComponent(sym)}?range=1y`);
        if (r.ok) ok++; else miss++;
      } catch (e) { miss++; }
      await new Promise(res => setTimeout(res, WARM_GAP_MS));
    }
    lastCycleTs = Date.now();
    const line = `  [分析预热] ${targets.length} 只（自选 ${wl.length} + 最近 ${recents.length}，去重后）：成功 ${ok} · 失败 ${miss} · 耗时 ${((lastCycleTs - started) / 1000).toFixed(1)}s`;
    console.log(line);
    return { ok, miss, total: targets.length };
  } finally {
    cycleRunning = false;
    if (!lastCycleTs) lastCycleTs = Date.now();
  }
}

/** 预热调度：每分钟 tick，盘中按 2 分钟间隔、其余按 30 分钟间隔触发一轮（首泡延迟 20 秒） */
function startAnalysisWarmScheduler({ port, getWatchlist, isTradingDayFn, intervalMs, firstDelayMs }) {
  if (timer) return;
  const due = () => {
    const d = new Date();
    const tradingDay = isTradingDayFn ? !!isTradingDayFn(localDateStr(d)) : (d.getDay() !== 0 && d.getDay() !== 6);
    const gap = (tradingDay && isTradingSessionNow(d)) ? FRESH_TTL_TRADING_MS : FRESH_TTL_OTHER_MS;
    return Date.now() - lastCycleTs >= gap;
  };
  timer = setInterval(() => {
    if (due()) warmCycle({ port, getWatchlist }).catch(() => {});
  }, intervalMs || 60 * 1000);
  if (timer.unref) try { timer.unref(); } catch (e) { /* 保持进程行为不变 */ }
  setTimeout(() => { warmCycle({ port, getWatchlist }).catch(() => {}); }, firstDelayMs || 20000);
}

function stopAnalysisWarmScheduler() { if (timer) { clearInterval(timer); timer = null; } }
function warmListSnapshot() { return { recents: recents.slice(), cacheKeys: Array.from(cache.keys()), lastCycleTs }; }
// 20261104b：正式缓存清除导出（增长口径切换后立即失效全部分析缓存，确保切换即时生效）
function clearAllCache() { cache.clear(); }

module.exports = {
  getCached, setCached, noteAnalysisRequest,
  startAnalysisWarmScheduler, stopAnalysisWarmScheduler, warmCycle, warmListSnapshot,
  clearAllCache,
  // 单测钩子（不对外承诺）
  __test: { ttlMs, isTradingSessionNow, cache, clearAll: () => { cache.clear(); }, PERSIST, FRESH_TTL_TRADING_MS, FRESH_TTL_OTHER_MS },
};

~~~

---

## `lib\backtestValidator.js`  ·  1460 行

~~~js
'use strict';
/**
 * lib/backtestValidator.js
 * 个股量化策略虚拟盘风控校验模块（纯 JS 实现，无外部依赖）
 *
 * 设计：输入锁死 + 确定性计算（与项目其他模块一致：数值一律代码计算，LLM 不参与估值/统计）。
 * 统计检验为本机 JS 移植首版（ADF/KPSS/ACF/PACF/OLS/Engle-Granger 协整），
 * 临界值采用标准近似常数并标注 TODO，后续可替换为 statsmodels 级精度。
 *
 * 6 阶段流水线：
 *   1) 取数（复用 lib/stockData.getHistory 前复权日线）
 *   2) DSL 解析（JSON 或 行式文本）
 *   3) 表达式求值（指标 + 信号函数）
 *   4) 虚拟盘 T+1 回测（次日开盘成交，0.55%/笔成本）
 *   5) 统计检验（平稳性 / 协整 / 自相关 / 趋势）
 *   6) 五大胜率修正 + 操作建议（结构化 JSON 输出）
 */

const { getHistory } = require('./stockData');
const strategyNL = require('./strategyNL');
const f10Status = require('./f10Status');

// =====================================================================
//  数学基础（无依赖）
// =====================================================================
function mean(a) {
  if (!a || a.length === 0) return 0;
  let s = 0;
  for (const v of a) s += (isFinite(v) ? v : 0);
  return s / a.length;
}
function variance(a) {
  if (!a || a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (const v of a) { const d = (isFinite(v) ? v : 0) - m; s += d * d; }
  return s / (a.length - 1);
}
function std(a) { return Math.sqrt(variance(a)); }
function covariance(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const mx = mean(x), my = mean(y);
  let s = 0;
  for (let i = 0; i < n; i++) s += ((isFinite(x[i]) ? x[i] : 0) - mx) * ((isFinite(y[i]) ? y[i] : 0) - my);
  return s / (n - 1);
}
function diff(a) {
  const out = [0];
  for (let i = 1; i < a.length; i++) out.push((a[i] || 0) - (a[i - 1] || 0));
  return out;
}
function corr(x, y) { return covariance(x, y) / (std(x) * std(y) || 1); }

// 高斯消元解线性系统 Ax=b（A 为 n×n，b 为长度 n）
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.slice().concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) continue;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = col; j <= n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row[n]);
}
// 矩阵求逆（n×n）
function matInverse(A) {
  const n = A.length;
  const M = A.map((row, i) => row.slice().concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row.slice(n));
}
// 通用 OLS：X（行=观测，列=特征），y。返回系数 / t 值 / R² / 残差
function olsGeneral(X, y) {
  const n = X.length, k = X[0].length;
  const Xt = Array.from({ length: k }, (_, j) => X.map(row => row[j]));
  const XtX = Array.from({ length: k }, (_, i) => Array.from({ length: k }, (_, j) => {
    let s = 0; for (let r = 0; r < n; r++) s += Xt[i][r] * Xt[j][r]; return s;
  }));
  const Xty = Xt.map(col => { let s = 0; for (let r = 0; r < n; r++) s += col[r] * y[r]; return s; });
  const beta = solveLinear(XtX, Xty);
  const yhat = X.map(row => row.reduce((acc, v, j) => acc + v * beta[j], 0));
  const resid = y.map((v, i) => v - yhat[i]);
  const sse = resid.reduce((acc, v) => acc + v * v, 0);
  const my = mean(y);
  const sst = y.reduce((acc, v) => acc + (v - my) * (v - my), 0);
  const r2 = sst > 0 ? 1 - sse / sst : 0;
  const dof = Math.max(n - k, 1);
  const sigma2 = sse / dof;
  let XtXInv;
  try { XtXInv = matInverse(XtX); } catch (e) { XtXInv = null; }
  const tStats = beta.map((b, j) => {
    if (!XtXInv) return 0;
    const se = Math.sqrt(Math.max(sigma2 * XtXInv[j][j], 0));
    return se > 0 ? b / se : 0;
  });
  return { beta, tStats, r2, resid, n, k };
}

// =====================================================================
//  统计检验（首版 JS 移植，临界值近似，标注 TODO）
// =====================================================================
// ACF（自相关函数）
function acf(series, lag) {
  const n = series.length;
  if (n <= lag + 1) return 0;
  const sub = series.slice(lag);
  const base = series.slice(0, n - lag);
  const c0 = covariance(series, series);
  const cl = covariance(base, sub);
  return c0 > 0 ? cl / c0 : 0;
}
// PACF（偏自相关）—— Levinson-Durbin 递推取最后系数
function pacf(series, maxLag) {
  const r = [];
  for (let k = 0; k <= maxLag; k++) r.push(acf(series, k));
  const out = [1];
  let a = [], prevErr = r[0];
  for (let k = 1; k <= maxLag; k++) {
    let num = r[k];
    for (let j = 1; j < k; j++) num += a[j - 1] * r[k - j];
    const kcoef = prevErr > 0 ? -num / prevErr : 0;
    const newA = a.map(v => v);
    newA.unshift(kcoef);
    for (let j = 0; j < a.length; j++) newA[j + 1] += kcoef * a[a.length - 1 - j];
    const err = (1 - kcoef * kcoef) * prevErr;
    out.push(newA[0]);
    a = newA; prevErr = err;
  }
  return out; // [lag0, lag1, ...]
}

// ADF 核心：给定滞后阶 lags 计算 t 统计量 + AIC
function adfCore(series, lags) {
  const n = series.length;
  if (n < lags + 4) return { stat: 0, pValueApprox: 1, stationary: false, critical: { p10: -2.57, p5: -2.86, p1: -3.43 }, aic: Infinity, note: '样本不足' };
  const dy = diff(series);
  const ylag = series.slice(0, n - 1); // y[t-1]
  const rows = [];
  for (let t = lags + 1; t < n; t++) {
    const row = [1, ylag[t - 1]];
    for (let l = 1; l <= lags; l++) row.push(dy[t - l]);
    rows.push(row);
  }
  const yv = dy.slice(lags + 1);
  const fit = olsGeneral(rows, yv);
  const tStat = fit.tStats[1]; // y[t-1] 系数 t 值
  const cv = { p10: -2.57, p5: -2.86, p1: -3.43 }; // 含常数项近似
  // p 值近似：在临界值间线性插值（粗略）
  let p = 1;
  if (tStat <= cv.p1) p = 0.01;
  else if (tStat <= cv.p5) p = 0.01 + (tStat - cv.p1) / (cv.p5 - cv.p1) * 0.04;
  else if (tStat <= cv.p10) p = 0.05 + (tStat - cv.p5) / (cv.p10 - cv.p5) * 0.05;
  else p = 0.10 + (tStat - cv.p10) / (1.0 - cv.p10) * 0.9;
  // AIC = n·ln(SSE/n) + 2k（k = 常数项 + ylag + lags 个差分项）
  const nObs = yv.length;
  const sse = fit.resid.reduce((a, v) => a + v * v, 0);
  const k = 2 + lags;
  const aic = (nObs > 0 && sse > 0) ? nObs * Math.log(sse / nObs) + 2 * k : Infinity;
  return { stat: tStat, pValueApprox: Math.max(0, Math.min(1, p)), stationary: tStat < cv.p5, critical: cv, aic, nObs, note: 'ADF(含常数项) 近似，临界值为标准值' };
}

// ADF 检验（含常数项 + 滞后项）。lags 未显式给出 → 按 AIC 自动定阶（Ng-Perron 经验上限）。
function adf(series, lags) {
  const n = series.length;
  let chosen, selection;
  if (lags == null) {
    const maxLag = Math.max(1, Math.min(Math.floor(12 * Math.pow(n / 100, 0.25)), Math.floor((n - 1) / 4)));
    let bestAIC = Infinity, bestLag = 1;
    for (let L = 1; L <= maxLag; L++) {
      const r = adfCore(series, L);
      if (isFinite(r.aic) && r.aic < bestAIC) { bestAIC = r.aic; bestLag = L; }
    }
    chosen = bestLag; selection = 'aic';
  } else {
    chosen = Math.max(1, Math.round(lags)); selection = 'fixed';
  }
  const out = adfCore(series, chosen);
  out.lag = chosen;
  out.lagSelection = selection;
  out.note = 'ADF(含常数项) 近似，临界值为标准值；滞后阶=' + chosen + '（' + (selection === 'aic' ? 'AIC 自动定阶' : '固定') + '）';
  return out;
}

// KPSS 检验（原假设：平稳）。统计量 = (1/n²)·Σ S_t² / σ²_lr，
// 其中 S_t 为去均值序列的部分和，σ²_lr 为长程方差（Newey-West / Bartlett 权估计）。
function kpss(series) {
  const n = series.length;
  if (n < 8) return { stat: 0, stationary: true, critical: { p10: 0.347, p5: 0.463, p1: 0.739 }, note: '样本不足' };
  const m = mean(series);
  const e = series.map(v => v - m);            // 去均值序列
  const S = [];                                // 部分和 S_t = Σ e_i
  let cum = 0;
  for (let t = 0; t < n; t++) { cum += e[t]; S.push(cum); }
  // 长程方差 σ²_lr = γ0 + 2·Σ_{j=1..L} (1 - j/(L+1))·γ_j  （Bartlett 权，带宽 L = floor(4·(n/100)^0.25)）
  const L = Math.max(1, Math.floor(4 * Math.pow(n / 100, 0.25)));
  const gamma0 = e.reduce((a, v) => a + v * v, 0) / n;
  let lr = gamma0;
  for (let j = 1; j <= L; j++) {
    let gj = 0;
    for (let t = j; t < n; t++) gj += e[t] * e[t - j];
    gj /= n;
    lr += 2 * (1 - j / (L + 1)) * gj;
  }
  if (!(lr > 0)) lr = gamma0 > 0 ? gamma0 : 1e-12;   // 退化保护
  let sumS2 = 0;
  for (let t = 0; t < n; t++) sumS2 += S[t] * S[t];
  const stat = sumS2 / (n * n * lr);
  const cv = { p10: 0.347, p5: 0.463, p1: 0.739 };
  return { stat, stationary: stat < cv.p5, critical: cv, bandwidth: L, note: 'KPSS(常数) 长程方差=Newey-West(Bartlett)' };
}

// Engle-Granger 协整检验：y ~ x 回归残差做 ADF
function engleGranger(y, x) {
  const n = Math.min(y.length, x.length);
  if (n < 12) return { stat: 0, cointegrated: false, pValueApprox: 1, note: '样本不足' };
  const X = x.slice(0, n).map(v => [1, v]);
  const fit = olsGeneral(X, y.slice(0, n));
  const resid = fit.resid;
  const adfRes = adf(resid);
  // EG 临界值（大样本 5% ≈ -3.37）
  const cv = { p5: -3.37, p1: -3.90 };
  return { stat: adfRes.stat, pValueApprox: adfRes.pValueApprox, cointegrated: adfRes.stat < cv.p5, critical: cv, note: 'Engle-Granger 残差 ADF' };
}

// =====================================================================
//  线性代数小工具（Johansen 需要特征值分解）
// =====================================================================
// 实对称矩阵特征值分解：Jacobi 旋转法（数值稳定、无依赖，适合 k ≤ 6 的小矩阵）
function jacobiEigen(A, maxIter = 100, tol = 1e-10) {
  const k = A.length;
  if (k === 0) return { values: [], vectors: [] };
  const a = A.map(r => r.slice());
  let v = [];
  for (let i = 0; i < k; i++) { v.push(new Array(k).fill(0)); v[i][i] = 1; }
  for (let iter = 0; iter < maxIter; iter++) {
    // 找最大非对角元素
    let p = 0, q = 1, maxOff = 0;
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        if (Math.abs(a[i][j]) > maxOff) { maxOff = Math.abs(a[i][j]); p = i; q = j; }
      }
    }
    if (maxOff < tol) break;
    // 计算旋转角
    const theta = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(theta), s = Math.sin(theta);
    // 相似变换 A' = Jᵀ A J
    for (let i = 0; i < k; i++) {
      const aip = a[i][p], aiq = a[i][q];
      a[i][p] = c * aip - s * aiq;
      a[i][q] = s * aip + c * aiq;
    }
    for (let i = 0; i < k; i++) {
      const api = a[p][i], aqi = a[q][i];
      a[p][i] = c * api - s * aqi;
      a[q][i] = s * api + c * aqi;
    }
    // 累积特征向量
    for (let i = 0; i < k; i++) {
      const vip = v[i][p], viq = v[i][q];
      v[i][p] = c * vip - s * viq;
      v[i][q] = s * vip + c * viq;
    }
  }
  const values = [];
  for (let i = 0; i < k; i++) values.push(a[i][i]);
  return { values, vectors: v };
}

// 按列求逆（Gauss-Jordan，含部分主元），用于 Σ00⁻¹ / Σ11⁻¹
function matInverse(M) {
  const k = M.length;
  const a = M.map((row, i) => row.concat(Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))));
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;   // 奇异
    if (piv !== col) { const t = a[piv]; a[piv] = a[col]; a[col] = t; }
    const d = a[col][col];
    for (let j = 0; j < 2 * k; j++) a[col][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = a[r][col];
      if (f === 0) continue;
      for (let j = 0; j < 2 * k; j++) a[r][j] -= f * a[col][j];
    }
  }
  return a.map(row => row.slice(k));
}

// 矩阵乘法 A(m×n) · B(n×p)
function matMul(A, B) {
  const m = A.length, n = B.length, p = B[0].length;
  const out = [];
  for (let i = 0; i < m; i++) {
    out.push(new Array(p).fill(0));
    for (let j = 0; j < p; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += A[i][t] * B[t][j];
      out[i][j] = s;
    }
  }
  return out;
}

// 矩阵转置
function matT(A) { return A[0].map((_, j) => A.map(r => r[j])); }

// Johansen 协整检验（迹统计量 + 最大特征值统计量）
// 输入：vars = [series1, series2, ...]（各变量等长）；opts.lags = VECM 差分滞后阶（默认 1）
// 实现：① 各变量差分 ΔY_t；② 辅助回归 ΔY_t ~ ΔY_{t-1..t-k} 取残差 R0；
//       Y_{t-1} ~ ΔY_{t-1..t-k} 取残差 R1；③ 计算 S00/S01/S10/S11；
//       ④ 解广义特征值问题 |λS11 - S10·S00⁻¹·S01| = 0（实对称化后 Jacobi 分解）
//       ⑤ 迹统计量 λ_trace(r) = -T·Σ_{i>r} ln(1-λ_i)
// 返回结构对调用方保持不变（stat/cointegrated/pValueApprox/critical/note），
// 额外附加 additive 字段：traceStats / maxEigStats / eigenvalues / lags / method。
function johansen(vars, opts) {
  const opt = opts || {};
  const k = vars.length;
  if (k < 2) return { stat: 0, cointegrated: false, pValueApprox: 1, note: 'Johansen 需要至少 2 个变量', method: 'johansen(rejected)' };
  const n = Math.min(...vars.map(v => v.length));
  const lag = Math.max(1, Math.min(opt.lags != null ? opt.lags : 1, Math.floor((n - 4) / (k + 1))));
  if (n < 20 || lag < 1) {
    // 样本不足 → 降级回 Engle-Granger（保持接口可用）
    const eg = engleGranger(vars[0], vars[1]);
    eg.note = 'Johansen 样本不足（n=' + n + '），已降级为 ' + eg.note;
    eg.method = 'engle-granger(fallback)';
    return eg;
  }
  // 差分序列
  const dY = vars.map(s => diff(s.slice(0, n)));     // 长度 n-1，索引 0 对应 t=1
  const T = n - 1 - lag;                             // 有效观测数
  if (T < 10) {
    const eg = engleGranger(vars[0], vars[1]);
    eg.note = 'Johansen 有效样本不足（T=' + T + '），已降级为 ' + eg.note;
    eg.method = 'engle-granger(fallback)';
    return eg;
  }
  const rowsD = [];   // 右侧：ΔY_{t-1} ... ΔY_{t-lag}（含常数项）
  const rowsY = [];   // 右侧目标：ΔY_t
  const rowsL = [];   // 左侧：Y_{t-1}
  for (let t = lag; t < n - 1; t++) {
    const rd = [1];
    for (let l = 1; l <= lag; l++) for (let j = 0; j < k; j++) rd.push(dY[j][t - l]);
    rowsD.push(rd);
    rowsY.push(dY.map(d => d[t]));
    rowsL.push(vars.map(s => s[t]));       // Y_{t-1}（未差分水平项）
  }
  const p = rowsD[0].length;
  // R0：ΔY_t ~ 右侧的残差
  const R0 = [];
  for (let j = 0; j < k; j++) {
    const fit = olsGeneral(rowsD, rowsY.map(r => r[j]));
    R0.push(fit.resid);
  }
  // R1：Y_{t-1} ~ 右侧的残差
  const R1 = [];
  for (let j = 0; j < k; j++) {
    const fit = olsGeneral(rowsD, rowsL.map(r => r[j]));
    R1.push(fit.resid);
  }
  // 矩矩阵 S_ij = (1/T)·Σ Rᵢ Rⱼᵀ
  const mkS = (A, B) => {
    const out = [];
    for (let i = 0; i < A.length; i++) {
      out.push([]);
      for (let j = 0; j < B.length; j++) {
        let s = 0;
        for (let t = 0; t < T; t++) s += A[i][t] * B[j][t];
        out[i].push(s / T);
      }
    }
    return out;
  };
  const S00 = mkS(R0, R0), S01 = mkS(R0, R1), S10 = mkS(R1, R0), S11 = mkS(R1, R1);
  const inv00 = matInverse(S00);
  if (!inv00) {
    const eg = engleGranger(vars[0], vars[1]);
    eg.note = 'Johansen 矩矩阵奇异，已降级为 ' + eg.note;
    eg.method = 'engle-granger(fallback)';
    return eg;
  }
  // M = S11⁻¹ · S10 · S00⁻¹ · S01（非对称）→ 对称化：S11^{-1/2} 变换不可行时，用
  // |λS11 - S10 S00⁻¹ S01| = 0 求解更稳健——这里对 M = S11⁻¹·(S10·S00⁻¹·S01) 做特征分解，
  // 并把 M 对称化（(M+Mᵀ)/2），因特征值在广义问题上对实对称化保持数值稳定。
  const Mraw = matMul(inv00 ? matMul(S10, inv00) : S10, S01);
  const inv11 = matInverse(S11);
  const M = inv11 ? matMul(inv11, Mraw) : Mraw;
  const Msym = M.map((row, i) => row.map((v, j) => (v + M[j][i]) / 2));
  const eig = jacobiEigen(Msym);
  // 特征值降序（理论上 ∈ [0,1)），并夹紧到 [0, 0.999]
  const lambdas = eig.values
    .map(v => Math.max(0, Math.min(0.999, v)))
    .sort((a, b) => b - a);
  // 迹统计量：λ_trace(r) = -T·Σ_{i=r+1..k} ln(1-λ_i)
  const traceStats = [];
  for (let r = 0; r < k; r++) {
    let s = 0;
    for (let i = r; i < k; i++) s += Math.log(1 - lambdas[i]);
    traceStats.push(-T * s);
  }
  // 最大特征值统计量：λ_max(r) = -T·ln(1-λ_{r+1})
  const maxEigStats = lambdas.map(l => -T * Math.log(1 - l));
  // Osterwald-Lenum 临界值（含常数项、无趋势，5% 与 1%）
  // 维度 k=2: [r=0] 15.41 / 20.04 ; [r≤1] 3.76 / 6.65
  // 维度 k=3: [r=0] 29.68 / 35.65 ; [r≤1] 15.41 / 20.04 ; [r≤2] 3.76 / 6.65
  const CV_TABLE = {
    2: [{ p5: 15.41, p1: 20.04 }, { p5: 3.76, p1: 6.65 }],
    3: [{ p5: 29.68, p1: 35.65 }, { p5: 15.41, p1: 20.04 }, { p5: 3.76, p1: 6.65 }],
    4: [{ p5: 47.21, p1: 54.46 }, { p5: 29.68, p1: 35.65 }, { p5: 15.41, p1: 20.04 }, { p5: 3.76, p1: 6.65 }],
  };
  const cvSet = CV_TABLE[k] || CV_TABLE[3].slice(0, k);
  // r=0 的检验：迹统计量 vs 临界值 → 是否存在协整关系
  const t0 = traceStats[0];
  const cv0 = cvSet[0] || { p5: 15.41, p1: 20.04 };
  const cointegrated = t0 > cv0.p5;
  // p 值近似：按 5%/1% 两档 + 与临界值距离线性插值
  let pApprox;
  if (t0 <= cv0.p5) pApprox = 0.05 + Math.min(0.9, (cv0.p5 - t0) / Math.max(1, cv0.p5) * 0.9);
  else if (t0 <= cv0.p1) pApprox = 0.01 + (cv0.p1 - t0) / (cv0.p1 - cv0.p5) * 0.04;
  else pApprox = 0.01;
  pApprox = Math.max(0.001, Math.min(1, pApprox));
  // 协整秩：迹统计量首次不超过临界值的 r
  let rank = 0;
  for (let r = 0; r < k; r++) {
    const cv = cvSet[r] || { p5: 3.76 };
    if (traceStats[r] > cv.p5) rank = r + 1; else break;
  }
  return {
    stat: t0,
    cointegrated,
    pValueApprox: pApprox,
    critical: { p5: cv0.p5, p1: cv0.p1 },
    note: 'Johansen 迹检验（含常数项、无趋势，滞后阶=' + lag + '，Osterwald-Lenum 临界值）',
    method: 'johansen',
    // ---- 以下为 additive 字段（不破坏既有调用方）----
    eigenvalues: lambdas.map(v => +v.toFixed(6)),
    traceStats: traceStats.map(v => +v.toFixed(4)),
    maxEigStats: maxEigStats.map(v => +v.toFixed(4)),
    rank,
    lags: lag,
    nObs: T,
    criticalTable: cvSet,
  };
}

// 线性趋势（用于趋势贡献系数）
function linearTrend(series) {
  const n = series.length;
  if (n < 4) return { slope: 0, tStat: 0, r2: 0, direction: 'flat' };
  const t = series.map((_, i) => i);
  const fit = olsGeneral(t.map(v => [1, v]), series);
  const direction = fit.beta[1] > 0 ? 'up' : (fit.beta[1] < 0 ? 'down' : 'flat');
  return { slope: fit.beta[1], tStat: fit.tStats[1], r2: fit.r2, direction };
}

// =====================================================================
//  技术指标（首版 JS 实现）
// =====================================================================
function MA(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += (arr[i] || 0);
    if (i >= n) sum -= (arr[i - n] || 0);
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function EMA(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i] || 0;
    if (i === 0) { prev = v; out[i] = NaN; continue; }
    prev = (isNaN(prev) ? v : (v * k + prev * (1 - k)));
    out[i] = prev;
  }
  return out;
}
function RSI(arr, n = 14) {
  const out = new Array(arr.length).fill(NaN);
  if (arr.length < 2) return out;
  n = Math.min(n, arr.length - 1); // 窗口不得超出数据长度
  let gain = 0, loss = 0;
  for (let i = 1; i < arr.length; i++) {
    const d = (arr[i] || 0) - (arr[i - 1] || 0);
    if (i <= n) {
      if (d >= 0) gain += d; else loss -= d;
      if (i === n) { gain /= n; loss /= n; out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss); }
    } else {
      const g = d >= 0 ? d : 0, l = d < 0 ? -d : 0;
      gain = (gain * (n - 1) + g) / n;
      loss = (loss * (n - 1) + l) / n;
      out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
  }
  return out;
}
function BOLL(arr, n = 20, k = 2) {
  const mid = MA(arr, n);
  const upper = new Array(arr.length).fill(NaN);
  const lower = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0; for (let j = i - n + 1; j <= i; j++) { const d = (arr[j] || 0) - mid[i]; s += d * d; }
    const sd = Math.sqrt(s / n);
    upper[i] = mid[i] + k * sd;
    lower[i] = mid[i] - k * sd;
  }
  return { upper, mid, lower };
}
function MACD(arr, fast = 12, slow = 26, signal = 9) {
  const ef = EMA(arr, fast), es = EMA(arr, slow);
  const dif = arr.map((_, i) => (isNaN(ef[i]) || isNaN(es[i]) ? NaN : ef[i] - es[i]));
  // DEA = EMA of DIF
  const valid = dif.map(v => (isNaN(v) ? 0 : v));
  const deaArr = EMA(valid, signal);
  const dea = dif.map((v, i) => (isNaN(v) ? NaN : deaArr[i]));
  const bar = dif.map((v, i) => (isNaN(v) || isNaN(dea[i]) ? NaN : (v - dea[i]) * 2));
  return { dif, dea, bar };
}

// —— 收益率 / 滚动统计（非平稳价格 → 差分取收益率 → 重新检验平稳性）——
function rollingMean(arr, n) {
  const out = new Array(arr.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += (arr[i] || 0);
    if (i >= n) sum -= (arr[i - n] || 0);
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}
function rollingStd(arr, n) {
  const m = rollingMean(arr, n);
  const out = new Array(arr.length).fill(NaN);
  for (let i = n - 1; i < arr.length; i++) {
    let s = 0; for (let j = i - n + 1; j <= i; j++) { const d = (arr[j] || 0) - m[i]; s += d * d; }
    out[i] = Math.sqrt(s / n);
  }
  return out;
}
// 百分比收益率序列（用于均值回归的平稳化路径）
function returnsPct(arr) {
  const out = new Array(arr.length).fill(NaN);
  for (let i = 1; i < arr.length; i++) out[i] = (arr[i - 1] || 0) ? (arr[i] - arr[i - 1]) / arr[i - 1] : NaN;
  return out;
}
function zscore(arr, n) {
  const m = rollingMean(arr, n);
  const s = rollingStd(arr, n);
  const out = new Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    if (isNaN(s[i]) || s[i] === 0) out[i] = NaN;
    else out[i] = (arr[i] - m[i]) / s[i];
  }
  return out;
}

// =====================================================================
//  DSL 解析
// =====================================================================
// 支持两种输入：
//   A) JSON 对象：{ strategy_type, name, buy_condition, sell_condition, range, symbols, params, train_ratio, cost_per_side, survivorship }
//   B) 行式文本：
//      STRATEGY_TYPE: single
//      NAME: 双均线金叉
//      BUY: CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))
//      SELL: CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))
//      RANGE: 3y
function parseDSL(raw) {
  if (typeof raw === 'object' && raw !== null) return normalizeDSL(raw);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('{')) {
      try { return normalizeDSL(JSON.parse(trimmed)); } catch (e) { throw new Error('JSON 解析失败: ' + e.message); }
    }
    return normalizeDSL(parseTextDSL(trimmed));
  }
  throw new Error('DSL 必须是对象或字符串');
}
function parseTextDSL(text) {
  const obj = {};
  for (const line of text.split(/\n+/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key && val) obj[key] = val;
  }
  return obj;
}
function normalizeDSL(o) {
  const buy = o.buy_condition || o.buy || o.buy_signal;
  const sell = o.sell_condition || o.sell || o.sell_signal;
  if (!buy || !sell) throw new Error('DSL 必须包含买/卖条件（buy_condition / sell_condition）');
  // 风控出场 & 分批建仓（全部可选，默认关闭 → 与历史行为逐位一致）
  // 接受两种键名：下划线（DSL 风格）与驼峰（JS 风格）
  const numOpt = (...keys) => {
    for (const k of keys) {
      if (o[k] != null && o[k] !== '') {
        const v = Number(o[k]);
        if (isFinite(v)) return v;
      }
    }
    return null;
  };
  const risk = {
    stopLoss: numOpt('stop_loss', 'stopLoss'),
    takeProfit: numOpt('take_profit', 'takeProfit'),
    trailing: numOpt('trailing', 'trailing_stop', 'trailingStop'),
    tranches: numOpt('tranches', 'position_tranches', 'positionTranches'),
    trancheGap: numOpt('tranche_gap', 'trancheGap'),
  };
  const hasRisk = Object.values(risk).some(v => v != null && v > 0);
  return {
    strategyType: (o.strategy_type || o.strategyType || 'single').toLowerCase(),
    name: o.name || '未命名策略',
    buy: String(buy),
    sell: String(sell),
    range: o.range || o.period || '3y',
    symbols: Array.isArray(o.symbols) ? o.symbols : (o.symbols ? String(o.symbols).split(/[,，\s]+/) : []),
    trainRatio: Number(o.train_ratio || o.trainRatio || 0.7),
    costPerSide: o.cost_per_side != null ? Number(o.cost_per_side) : 0.0055,
    costModel: o.cost_model || o.costModel || null,
    survivorship: o.survivorship != null ? Number(o.survivorship) : null,
    // 仅在有实际值时挂载，避免默认路径多出字段
    risk: hasRisk ? risk : null,
  };
}

// =====================================================================
//  表达式求值器（指标 + 信号函数）
// =====================================================================
const SERIES_NAMES = { CLOSE: 'close', OPEN: 'open', HIGH: 'high', LOW: 'low', VOLUME: 'volume', VOL: 'volume' };

function tokenize(expr) {
  const tokens = [];
  const s = expr;
  let i = 0;
  const isDigit = c => c >= '0' && c <= '9';
  const isAlpha = c => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
      let j = i + 1;
      while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++;
      tokens.push({ t: 'num', v: parseFloat(s.slice(i, j)) }); i = j; continue;
    }
    if (isAlpha(c)) {
      let j = i + 1;
      while (j < s.length && (isAlpha(s[j]) || isDigit(s[j]))) j++;
      tokens.push({ t: 'id', v: s.slice(i, j) }); i = j; continue;
    }
    const two = s.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==' || two === '!=') { tokens.push({ t: 'op', v: two }); i += 2; continue; }
    if (c === '>' || c === '<' || c === '+' || c === '-' || c === '*' || c === '/' || c === '(' || c === ')' || c === ',') {
      tokens.push({ t: c === '(' ? 'lp' : c === ')' ? 'rp' : c === ',' ? 'com' : 'op', v: c }); i++; continue;
    }
    throw new Error('无法识别的字符: ' + c);
  }
  return tokens;
}

// 递归下降解析 → AST
function parseExpr(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function parseOr() {
    let left = parseAnd();
    while (peek() && peek().t === 'id' && peek().v.toUpperCase() === 'OR') { next(); const right = parseAnd(); left = { type: 'or', left, right }; }
    return left;
  }
  function parseAnd() {
    let left = parseCmp();
    while (peek() && peek().t === 'id' && peek().v.toUpperCase() === 'AND') { next(); const right = parseCmp(); left = { type: 'and', left, right }; }
    return left;
  }
  function parseCmp() {
    let left = parseAdd();
    while (peek() && peek().t === 'op' && ['>', '<', '>=', '<=', '==', '!='].includes(peek().v)) {
      const op = next().v; const right = parseAdd(); left = { type: 'cmp', op, left, right };
    }
    return left;
  }
  function parseAdd() {
    let left = parseMul();
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v; const right = parseMul(); left = { type: 'bin', op, left, right };
    }
    return left;
  }
  function parseMul() {
    let left = parseUnary();
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = next().v; const right = parseUnary(); left = { type: 'bin', op, left, right };
    }
    return left;
  }
  function parseUnary() {
    if (peek() && peek().t === 'op' && peek().v === '-') { next(); return { type: 'neg', operand: parseUnary() }; }
    if (peek() && peek().t === 'id' && peek().v.toUpperCase() === 'NOT') { next(); return { type: 'not', operand: parseUnary() }; }
    return parsePostfix();
  }
  function parsePostfix() {
    let node = parsePrimary();
    while (peek() && peek().t === 'lp') {
      next();
      const args = [];
      if (!(peek() && peek().t === 'rp')) {
        args.push(parseOr());
        while (peek() && peek().t === 'com') { next(); args.push(parseOr()); }
      }
      if (!(peek() && peek().t === 'rp')) throw new Error('函数缺少右括号');
      next();
      node = { type: 'call', name: node.value, args };
    }
    return node;
  }
  function parsePrimary() {
    const tk = next();
    if (!tk) throw new Error('表达式意外结束');
    if (tk.t === 'num') return { type: 'num', value: tk.v };
    if (tk.t === 'lp') { const e = parseOr(); if (!(peek() && peek().t === 'rp')) throw new Error('缺少右括号'); next(); return e; }
    if (tk.t === 'id') return { type: 'var', value: tk.v };
    throw new Error('无法解析 token: ' + JSON.stringify(tk));
  }
  const ast = parseOr();
  if (pos < tokens.length) throw new Error('多余 token: ' + JSON.stringify(tokens[pos]));
  return ast;
}

// 类型广播
function isArr(x) { return Array.isArray(x); }
function numOrArrOp(a, b, fn) {
  if (isArr(a) && isArr(b)) return a.map((v, i) => fn(v, b[i]));
  if (isArr(a)) return a.map(v => fn(v, b));
  if (isArr(b)) return b.map(v => fn(a, v));
  return fn(a, b);
}

function evalNode(node, ctx) {
  switch (node.type) {
    case 'num': return node.value;
    case 'var': {
      const name = node.value.toUpperCase();
      if (SERIES_NAMES[name]) return ctx[SERIES_NAMES[name]];
      if (ctx.extra && ctx.extra[name] != null) return ctx.extra[name];
      throw new Error('未知变量: ' + node.value);
    }
    case 'call': return evalCall(node, ctx);
    case 'neg': { const v = evalNode(node.operand, ctx); return isArr(v) ? v.map(x => -x) : -v; }
    case 'not': { const v = evalNode(node.operand, ctx); return v.map(x => !x); }
    case 'bin': {
      const a = evalNode(node.left, ctx), b = evalNode(node.right, ctx);
      const fn = { '+': (x, y) => x + y, '-': (x, y) => x - y, '*': (x, y) => x * y, '/': (x, y) => (y === 0 ? NaN : x / y) }[node.op];
      return numOrArrOp(a, b, fn);
    }
    case 'cmp': {
      const a = evalNode(node.left, ctx), b = evalNode(node.right, ctx);
      const fn = { '>': (x, y) => x > y, '<': (x, y) => x < y, '>=': (x, y) => x >= y, '<=': (x, y) => x <= y, '==': (x, y) => x === y, '!=': (x, y) => x !== y }[node.op];
      return numOrArrOp(a, b, (x, y) => !!fn(x, y));
    }
    case 'and': {
      const a = evalNode(node.left, ctx), b = evalNode(node.right, ctx);
      return numOrArrOp(a, b, (x, y) => !!x && !!y);
    }
    case 'or': {
      const a = evalNode(node.left, ctx), b = evalNode(node.right, ctx);
      return numOrArrOp(a, b, (x, y) => !!x || !!y);
    }
    default: throw new Error('未知节点类型: ' + node.type);
  }
}

function evalCall(node, ctx) {
  const name = node.name.toUpperCase();
  const args = node.args.map(a => evalNode(a, ctx));
  const L = ctx.close.length;
  const toArr = v => (isArr(v) ? v : new Array(L).fill(v));
  switch (name) {
    case 'MA': return MA(toArr(args[0]), Math.max(1, Math.round(args[1] || 20)));
    case 'EMA': return EMA(toArr(args[0]), Math.max(1, Math.round(args[1] || 20)));
    case 'RSI': return RSI(toArr(args[0]), Math.max(2, Math.round(args[1] || 14)));
    case 'BOLL_UPPER': { const b = BOLL(toArr(args[0]), Math.round(args[1] || 20), args[2] != null ? args[2] : 2); return b.upper; }
    case 'BOLL_MID': { const b = BOLL(toArr(args[0]), Math.round(args[1] || 20), args[2] != null ? args[2] : 2); return b.mid; }
    case 'BOLL_LOWER': { const b = BOLL(toArr(args[0]), Math.round(args[1] || 20), args[2] != null ? args[2] : 2); return b.lower; }
    case 'MACD_DIF': { const m = MACD(toArr(args[0]), args[1] || 12, args[2] || 26, args[3] || 9); return m.dif; }
    case 'MACD_DEA': { const m = MACD(toArr(args[0]), args[1] || 12, args[2] || 26, args[3] || 9); return m.dea; }
    case 'MACD_BAR': { const m = MACD(toArr(args[0]), args[1] || 12, args[2] || 26, args[3] || 9); return m.bar; }
    case 'SPREAD': { const a = toArr(args[0]), b = toArr(args[1]); return a.map((v, i) => v - b[i]); }
    case 'RET': return returnsPct(toArr(args[0]));
    case 'MEAN': return rollingMean(toArr(args[0]), Math.max(1, Math.round(args[1] || 20)));
    case 'STD': return rollingStd(toArr(args[0]), Math.max(1, Math.round(args[1] || 20)));
    case 'ZSCORE': return zscore(toArr(args[0]), Math.max(2, Math.round(args[1] || 20)));
    case 'CROSS_UP': {
      const a = toArr(args[0]), b = toArr(args[1]);
      return a.map((v, i) => i > 0 ? (v > b[i] && a[i - 1] <= b[i - 1]) : false);
    }
    case 'CROSS_DOWN': {
      const a = toArr(args[0]), b = toArr(args[1]);
      return a.map((v, i) => i > 0 ? (v < b[i] && a[i - 1] >= b[i - 1]) : false);
    }
    default: throw new Error('未知函数: ' + node.name);
  }
}

function evaluateCondition(expr, ctx) {
  const ast = parseExpr(tokenize(expr));
  const res = evalNode(ast, ctx);
  if (!isArr(res)) throw new Error('条件表达式必须返回序列: ' + expr);
  return res.map(v => !!v);
}

// =====================================================================
//  虚拟盘 T+1 回测引擎
// =====================================================================
// 信号在 day i 触发，次日（i+1）开盘成交；单边成本 costPerSide。
//
// 【风控出场 & 分批建仓】（可选，默认全关 → 输出与历史版本逐位一致）
//   opts.stopLoss      : 0.08  → 从建仓均价回撤 8% 触发止损（按当日 low 触价，成交价取触发价）
//   opts.takeProfit    : 0.20  → 从建仓均价上涨 20% 触发止盈（按当日 high 触价）
//   opts.trailing      : 0.10  → 移动止盈：自持仓期最高价回撤 10% 触发（与 takeProfit 可并用，先到先出）
//   opts.tranches      : 3     → 等批建仓：把资金等分 3 批，在连续 3 个买入信号日依次建仓
//   opts.trancheGap    : 1     → 每批之间至少间隔的交易日数（默认 1 = 连续信号日即建）
// 触发优先级（同一根 K 线内）：止损 > 止盈/移动止盈 > 信号平仓（保守口径，避免高估收益）
// 返回结构完全向后兼容；仅在启用新功能时附加 stopEvents / trancheInfo（additive）。
function runBacktest(series, buySig, sellSig, opts) {
  opts = opts || {};
  const baseCost = opts.costPerSide != null ? opts.costPerSide : 0.0055;
  // 可选非对称成本：买/卖分开（用于建模 A 股印花税仅卖出等）；未提供则回退对称 costPerSide
  const buyCost = opts.buyCost != null ? opts.buyCost : baseCost;
  const sellCost = opts.sellCost != null ? opts.sellCost : baseCost;
  const capPerDay = !!opts.maxOneTradePerDay;
  // ---- 风控出场参数（默认关闭）----
  const stopLoss = (opts.stopLoss != null && opts.stopLoss > 0) ? opts.stopLoss : null;
  const takeProfit = (opts.takeProfit != null && opts.takeProfit > 0) ? opts.takeProfit : null;
  const trailing = (opts.trailing != null && opts.trailing > 0) ? opts.trailing : null;
  const riskExitEnabled = !!(stopLoss || takeProfit || trailing);
  // ---- 分批建仓参数（默认关闭 = 一次性满仓）----
  const tranches = (opts.tranches != null && opts.tranches > 1) ? Math.min(10, Math.round(opts.tranches)) : 1;
  const trancheGap = (opts.trancheGap != null && opts.trancheGap > 0) ? Math.round(opts.trancheGap) : 1;
  const trancheEnabled = tranches > 1;

  const N = series.length;
  const dayOf = (b) => String(b.date).slice(0, 10);
  let inPos = false, entryOpen = 0, entryDay = -1, lastTradeDay = null;
  // 持仓状态：加权均价 / 已建批次 / 持仓期最高价 / 最近一次建仓日
  let posAvg = 0, posFilled = 0, posHigh = 0, lastEntryIdx = -Infinity;
  const equity = [1];
  const dailyRet = [];
  const trades = [];
  const stopEvents = [];   // 风控出场明细（仅在启用时填充）

  for (let i = 1; i < N; i++) {
    const sigBuy = buySig[i - 1];
    const sigSell = sellSig[i - 1];
    const day = dayOf(series[i]);
    let ret = 0;
    const bar = series[i];

    // ---------- 1) 持仓中风控出场检查（优先于信号平仓）----------
    let exitedByRisk = false;
    if (inPos && riskExitEnabled) {
      const stopPrice = stopLoss != null ? posAvg * (1 - stopLoss) : -Infinity;
      const tpPrice = takeProfit != null ? posAvg * (1 + takeProfit) : Infinity;
      const trailPrice = trailing != null ? posHigh * (1 - trailing) : -Infinity;
      const hitStop = stopLoss != null && bar.low <= stopPrice;
      const hitTP = takeProfit != null && bar.high >= tpPrice;
      const hitTrail = trailing != null && bar.low <= trailPrice;
      // 保守口径：止损优先（同一根内若既触止损又触止盈，按更不利者成交）
      if (hitStop || hitTrail) {
        const trigPrice = hitStop ? stopPrice : trailPrice;
        const exitPx = trigPrice * (1 - sellCost);
        ret = (exitPx - posAvg) / posAvg;
        trades.push({ entry: series[entryDay].date, exit: bar.date, pnl: ret, side: 'long', exitReason: hitStop ? 'stopLoss' : 'trailing' });
        stopEvents.push({ date: bar.date, reason: hitStop ? 'stopLoss' : 'trailing', pnl: +ret.toFixed(6) });
        exitedByRisk = true;
      } else if (hitTP) {
        const exitPx = tpPrice * (1 - sellCost);
        ret = (exitPx - posAvg) / posAvg;
        trades.push({ entry: series[entryDay].date, exit: bar.date, pnl: ret, side: 'long', exitReason: 'takeProfit' });
        stopEvents.push({ date: bar.date, reason: 'takeProfit', pnl: +ret.toFixed(6) });
        exitedByRisk = true;
      }
      if (exitedByRisk) {
        inPos = false; entryOpen = 0; posAvg = 0; posFilled = 0; posHigh = 0; lastTradeDay = day;
      }
    }

    if (!exitedByRisk) {
      if (sigSell && inPos && !(capPerDay && lastTradeDay === day)) {
        // ---------- 2) 信号平仓（一次全平，即便分批建仓未建满也全部了结）----------
        const exitOpen = bar.open * (1 - sellCost);
        ret = (exitOpen - posAvg) / posAvg;
        trades.push({ entry: series[entryDay].date, exit: bar.date, pnl: ret, side: 'long', exitReason: 'signal' });
        inPos = false; entryOpen = 0; posAvg = 0; posFilled = 0; posHigh = 0; lastTradeDay = day;
      } else if (sigSell && capPerDay && lastTradeDay === day) {
        /* 当天已达交易上限，跳过平仓 */
      } else if (!inPos && sigBuy) {
        // ---------- 3) 建仓（支持分批）----------
        if (capPerDay && lastTradeDay === day) { /* 当天已达交易上限，跳过建仓 */ }
        else {
          const fillNow = trancheEnabled ? (i - lastEntryIdx >= trancheGap) : true;
          if (fillNow) {
            const w = trancheEnabled ? 1 / tranches : 1;
            const newAvg = inPos ? (posAvg * posFilled + bar.open * (1 + buyCost) * w) / (posFilled + w) : bar.open * (1 + buyCost);
            posAvg = newAvg;
            posFilled = Math.min(1, posFilled + w);
            if (!inPos) { inPos = true; entryDay = i; entryOpen = posAvg; posHigh = bar.open; }
            lastEntryIdx = i;
            lastTradeDay = day;
            if (posFilled > 1 - 1e-9) posFilled = 1;   // 浮点归整
            ret = (bar.close - posAvg) / posAvg * posFilled;
          } else { ret = 0; }
        }
      } else if (inPos) {
        // ---------- 4) 持仓中：按持仓权重计浮动盈亏 ----------
        ret = (bar.close / series[i - 1].close - 1) * (trancheEnabled ? posFilled : 1);
      } else {
        ret = 0;
      }
      if (inPos) posHigh = Math.max(posHigh, bar.high);
    }

    const prevEq = equity[equity.length - 1];
    equity.push(prevEq * (1 + ret));
    dailyRet.push(ret);
  }
  if (inPos) {
    const last = N - 1;
    const day = dayOf(series[last]);
    // 样本末笔强制平仓仍遵守「每天≤1笔」：若末日已交易则不重复计入交易笔数（权益已含当日浮动盈亏）
    if (!(capPerDay && lastTradeDay === day)) {
      const pnl = (series[last].close - posAvg) / posAvg;
      trades.push({ entry: series[entryDay].date, exit: series[last].date, pnl, side: 'long', openAtEnd: true });
    }
  }
  // 指标
  const wins = trades.filter(t => t.pnl > 0).length;
  const totalTrades = trades.length;
  const winRate = totalTrades > 0 ? wins / totalTrades : 0;
  const totalReturn = equity[equity.length - 1] - 1;
  const buyHold = N > 1 ? series[N - 1].close / series[0].close - 1 : 0;
  const avgPnl = totalTrades > 0 ? mean(trades.map(t => t.pnl)) : 0;
  const gains = trades.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const losses = Math.abs(trades.filter(t => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = losses > 0 ? gains / losses : (gains > 0 ? Infinity : 0);
  // 最大回撤
  let peak = equity[0], maxDD = 0;
  for (const e of equity) { peak = Math.max(peak, e); maxDD = Math.max(maxDD, (peak - e) / peak); }
  // 年化（按 252 交易日）
  const tradingDays = dailyRet.length;
  const mu = mean(dailyRet), sd = std(dailyRet);
  const annReturn = Math.pow(equity[equity.length - 1], 252 / Math.max(tradingDays, 1)) - 1;
  const sharpe = sd > 0 ? (mu / sd) * Math.sqrt(252) : 0;
  const out = {
    totalTrades, wins, winRate, totalReturn, buyHold, avgPnl, profitFactor,
    maxDrawdown: maxDD, annReturn, sharpe,
    trades: trades.slice(-30) // 仅保留最近 30 笔明细，避免体积过大
  };
  // additive：仅在启用新功能时附加，未启用时输出与历史版本逐位一致
  if (riskExitEnabled) {
    out.stopEvents = stopEvents.slice(-30);
    out.riskExit = {
      stopLoss, takeProfit, trailing,
      stopLossCount: stopEvents.filter(e => e.reason === 'stopLoss').length,
      takeProfitCount: stopEvents.filter(e => e.reason === 'takeProfit').length,
      trailingCount: stopEvents.filter(e => e.reason === 'trailing').length,
    };
  }
  if (trancheEnabled) out.trancheInfo = { tranches, trancheGap };
  return out;
}

// A 股分层成本模型（可选）：佣金(双边) + 印花税(仅卖出) + 过户费(双边) + 滑点(双边)
// 返回 { buyCost, sellCost, avgCost, components }；仅在显式启用时生效（默认仍是对称 0.55%/边）。
function aShareCostModel(cfg) {
  cfg = cfg || {};
  const commission = cfg.commission != null ? cfg.commission : 0.00025;    // 佣金 万2.5（双边）
  const stampDuty = cfg.stampDuty != null ? cfg.stampDuty : 0.0005;        // 印花税 0.05%（仅卖出）
  const transferFee = cfg.transferFee != null ? cfg.transferFee : 0.00001; // 过户费 0.001%（双边）
  const slippage = cfg.slippage != null ? cfg.slippage : 0.001;            // 滑点（可调）
  const buyCost = commission + transferFee + slippage;
  const sellCost = commission + transferFee + slippage + stampDuty;
  return { buyCost, sellCost, avgCost: (buyCost + sellCost) / 2, components: { commission, stampDuty, transferFee, slippage } };
}

// =====================================================================
//  风险分析辅助函数（平稳性闸门 + 四类回测偏差校验扩展）
// =====================================================================

// 策略分类：均值回归 / 趋势跟踪 / 收益率均值回归（平稳化路径）
function classifyStrategy(buyStr, sellStr) {
  const b = (buyStr || '').toUpperCase(), s = (sellStr || '').toUpperCase();
  const both = b + ' ' + s;
  if (both.includes('ZSCORE(') && both.includes('RET(')) return 'return-reversion';
  if (b.includes('BOLL_LOWER') || s.includes('BOLL_UPPER')) {
    return b.includes('BOLL_LOWER') ? 'reversion' : 'trend';
  }
  if ((b.includes('RSI') && b.includes('<')) || (s.includes('RSI') && s.includes('>'))) return 'reversion';
  if (both.includes('MACD_DIF') || both.includes('MACD_DEA')) return 'trend';
  if (both.includes('CROSS_UP(MA(') || both.includes('CROSS_DOWN(MA(')) return 'trend';
  return 'mixed';
}

// 前视偏差扫描（偏差校验①）：检测 DSL 是否引用未来数据
function lookaheadScan(buyStr, sellStr) {
  const txt = (buyStr || '') + ' ' + (sellStr || '');
  const forbidden = [/\bNEXT\s*\(/i, /\bLEAD\s*\(/i, /\[\s*\+\s*\d+\s*\]/, /\+1\s*\]/];
  for (const re of forbidden) if (re.test(txt)) return { detected: true, reason: 'DSL 含未来函数（' + re + '）' };
  return { detected: false, reason: '信号仅引用当前/历史 bar，成交于次日开盘，结构上无前视偏差' };
}

// 平稳性闸门系数（铁律：非平稳价格上的均值回归 = 伪回归陷阱）
function stationarityFactorFor(cls, adfPriceStat, adfReturnStat) {
  if (cls === 'reversion' && adfPriceStat === false) return 0.5;   // 陷阱，折算
  if (cls === 'return-reversion' && adfReturnStat === true) return 1.0; // 方法论成立
  if (cls === 'trend' && adfPriceStat === false) return 1.0;       // 趋势即非平稳性的一种表现
  return 1.0;
}

// 滚动前向（walk-forward）：把样本切成 folds 段，逐段样本外回测，检验一致性（过拟合校验扩展）
function walkForward(series, buySig, sellSig, opts, folds) {
  folds = folds || 3;
  const N = series.length;
  const size = Math.floor(N / folds);
  // purge/embargo：各折起始跳过 embargo 根 bar，消除指标回看窗跨折的信息泄漏（不传则 0=旧行为）
  const embargo = opts && opts.embargo != null ? Math.max(0, Math.floor(opts.embargo)) : 0;
  const results = [];
  for (let k = 0; k < folds; k++) {
    const start = k * size + (k > 0 ? embargo : 0);
    const end = (k === folds - 1) ? N : (k + 1) * size;
    const sub = series.slice(start, end);
    if (sub.length < 30) { results.push({ start, end, winRate: 0, trades: 0, skipped: true }); continue; }
    const r = runBacktest(sub, buySig.slice(start, end), sellSig.slice(start, end), opts);
    results.push({ start, end, winRate: +r.winRate.toFixed(3), trades: r.totalTrades, totalReturn: +r.totalReturn.toFixed(4) });
  }
  const valid = results.filter(r => !r.skipped && r.trades > 0);
  const meanWR = valid.length ? mean(valid.map(r => r.winRate)) : 0;
  const minWR = valid.length ? Math.min.apply(null, valid.map(r => r.winRate)) : 0;
  const consistency = meanWR > 0 ? Math.max(0, minWR / meanWR) : 0;
  return { folds: results, meanWinRate: +meanWR.toFixed(3), minWinRate: +minWR.toFixed(3), consistency: +consistency.toFixed(3), validFolds: valid.length, embargo };
}

// 结构性突变（结构性断点）：前后半段胜率差异
function structuralBreak(series, buySig, sellSig, opts) {
  const N = series.length;
  const mid = Math.floor(N / 2);
  const first = runBacktest(series.slice(0, mid), buySig.slice(0, mid), sellSig.slice(0, mid), opts);
  const second = runBacktest(series.slice(mid), buySig.slice(mid), sellSig.slice(mid), opts);
  const delta = second.winRate - first.winRate;
  return {
    firstHalfWinRate: +first.winRate.toFixed(3),
    secondHalfWinRate: +second.winRate.toFixed(3),
    delta: +delta.toFixed(3),
    significant: Math.abs(delta) >= 0.15,
    firstTrades: first.totalTrades,
    secondTrades: second.totalTrades
  };
}

// 季节性/周期性：收益率序列 ACF 在月(20)/季(60)滞后
function seasonalityScan(retSeries) {
  const lag20 = acf(retSeries, 20);
  const lag60 = acf(retSeries, 60);
  return { lag20: +lag20.toFixed(3), lag60: +lag60.toFixed(3), hasSeasonality: Math.abs(lag20) > 0.12 || Math.abs(lag60) > 0.12 };
}

// =====================================================================
//  五大胜率修正（A 项：接入平稳性闸门）
// =====================================================================
function applyCorrections(raw, stats, ctx, risk) {
  const steps = [];
  let winRate = raw.winRate;
  const trainWR = ctx.trainWinRate, testWR = ctx.testWinRate;
  risk = risk || {};

  // 0) 平稳性闸门（铁律：非平稳价格上的均值回归 = 伪回归陷阱）
  const stationarityFactor = risk.stationarityFactor != null ? risk.stationarityFactor : 1;
  let stNote;
  if (risk.strategyClass === 'reversion' && risk.adfPriceStationary === false) {
    stNote = '均值回归作用于非平稳价格序列（ADF 显示单位根）→ 伪回归陷阱，胜率 ×0.5 折算；建议改用平稳收益率 z-score 回归（RET/ZSCORE 函数）';
  } else if (risk.strategyClass === 'return-reversion' && risk.adfReturnStationary === true) {
    stNote = '回归作用于平稳收益率序列（ADF 通过）→ 方法论成立，无折算';
  } else if (risk.strategyClass === 'trend' && risk.adfPriceStationary === false) {
    stNote = '趋势跟踪作用于含趋势的非平稳序列，方法论成立（趋势即非平稳性的一种表现）';
  } else {
    stNote = '平稳性闸门未触发额外折算';
  }
  steps.push({ name: '平稳性闸门', factor: +stationarityFactor.toFixed(3), note: stNote });
  let wr = winRate * stationarityFactor;

  // 1) 前视偏差（偏差校验①）
  const lookahead = ctx.lookaheadDetected ? 1 : 0;
  const f1 = lookahead ? 0 : 1;
  steps.push({ name: '前视偏差', factor: f1, note: lookahead ? '检测到前视信号，胜率归零' : '未检出（信号次日开盘成交，结构上无前视）' });
  wr *= f1;

  // 2) 交易成本（已由 runBacktest 在成交价中计提；此处不再二次折扣胜率，仅作信息展示，避免重复计入）
  const costRate = ctx.costPerSide != null ? ctx.costPerSide : 0.0055;
  const costDrag = raw.totalTrades * 2 * costRate; // 往返粗略拖累
  const f2 = 1;
  steps.push({ name: '交易成本', factor: 1, note: `单边成本 ${(costRate * 100).toFixed(2)}%，已在回测成交价中计提（往返估算拖累 ≈${(costDrag * 100).toFixed(2)}%），不重复折算` });
  wr *= f2;

  // 3) 趋势贡献（策略收益多大程度由市场趋势贡献）
  const trend = ctx.trend || { r2: 0, direction: 'flat' };
  let f3 = 1;
  if (trend.r2 > 0.7) f3 = 0.3; else if (trend.r2 > 0.3) f3 = 0.7; else f3 = 1;
  steps.push({ name: '趋势贡献', factor: f3, note: `价格线性趋势 R²=${trend.r2.toFixed(2)}（${trend.direction}）→ 系数 ${f3}` });
  wr *= f3;

  // 4) 过拟合（测试集 vs 训练集，偏差校验③）
  let f4 = 1;
  if (trainWR > 0 && testWR >= 0) {
    f4 = testWR / Math.max(trainWR, 1e-9);
    if (f4 > 1) f4 = 1; // 测试更好不惩罚
  }
  steps.push({ name: '过拟合', factor: +f4.toFixed(3), note: `训练胜率 ${(trainWR * 100).toFixed(1)}% / 测试胜率 ${(testWR * 100).toFixed(1)}% → 系数 ${f4.toFixed(2)}` });
  wr *= f4;

  // 5) 幸存者偏差（偏差校验④）
  // 系数来源优先级：① 调用方显式指定 → ② 真实 F10 证据（曾用名链含 ST/*ST）→ ③ 保底默认 0.9
  // 说明：只有拿到 F10 证据时才用证据值；取不到时保持 0.9 并**如实标注未获证据**，不臆造。
  let f5, f5note, f5basis;
  if (ctx.survivorship != null) {
    f5 = ctx.survivorship;
    f5basis = 'caller';
    f5note = risk.survivorshipBasis || '用户/指定倍数';
  } else if (ctx.f10 && ctx.f10.ok && ctx.f10.survivorship != null) {
    f5 = ctx.f10.survivorship;
    f5basis = 'f10_evidence';
    f5note = `${ctx.f10.evidence}（来源：${ctx.f10.source}）→ 系数 ${f5}`;
  } else {
    f5 = 0.9;
    f5basis = 'default';
    f5note = '单只 A 股默认 0.9（F10 上市状态不可得'
      + (ctx.f10 && ctx.f10.detail ? '：' + ctx.f10.detail : '')
      + '，未获证据支撑）';
  }
  steps.push({ name: '幸存者偏差', factor: f5, note: f5note });
  wr *= f5;
  // additive：暴露证据明细，供报告与前端展示（不改变既有字段语义）
  const survivorshipEvidence = {
    basis: f5basis,
    factor: f5,
    note: f5note,
    stHistory: (ctx.f10 && ctx.f10.stHistory) ? ctx.f10.stHistory.map(h => h.name) : null,
    listingDate: (ctx.f10 && ctx.f10.listingDate) || null,
    listingYears: (ctx.f10 && ctx.f10.listingYears) != null ? ctx.f10.listingYears : null,
    isNewListing: !!(ctx.f10 && ctx.f10.isNewListing),
    source: (ctx.f10 && ctx.f10.ok) ? ctx.f10.source : null,
  };

  wr = Math.max(0, Math.min(1, wr));
  // 修正后总收益：与胜率同口径，纳入全部修正系数（前视/成本/趋势/过拟合/幸存者）
  const adjReturn = raw.totalReturn * f1 * f2 * f3 * f4 * f5;

  // 结构性突变（E 项）计入警示
  const sb = risk.structuralBreak;
  const sbFlag = sb && sb.significant;

  // 样本量闸门：交易笔数不足时，不给 PASS/WARNING/REJECT，直接标「样本不足」（缺失即视为无门槛）
  const minTrades = risk.minTrades != null ? risk.minTrades : 0;
  let verdict = 'REJECT';
  let advice = '策略未通过校验，不建议实盘';
  if (lookahead) { verdict = 'REJECT'; advice = '检出前视偏差，策略逻辑存在未来函数，直接否决'; }
  else if (minTrades > 0 && raw.totalTrades < minTrades) {
    verdict = 'INSUFFICIENT_SAMPLE';
    advice = `样本内交易仅 ${raw.totalTrades} 笔（< ${minTrades} 笔门槛），统计置信度不足，无法给出 PASS/WARNING/REJECT 裁决；建议拉长回测区间或改用更高频数据以增加样本，再行判定。`;
  }
  else if (stationarityFactor < 0.9) { verdict = 'WARNING'; advice = '策略基于非平稳价格的均值回归（伪回归陷阱），修正后胜率不足以保证实盘；建议改用收益率 z-score 回归或趋势跟踪类策略。'; }
  else if (wr >= 0.55 && f4 >= 0.85 && !sbFlag) { verdict = 'PASS'; advice = '校验通过（平稳性/前视/成本/过拟合/幸存者均达标），可小仓位实盘验证，并持续跟踪样本外表现'; }
  else if (wr >= 0.45) { verdict = 'WARNING'; advice = (sbFlag ? '前后半段胜率差异显著（存在结构性突变），' : '') + '边际通过，建议缩小仓位并加强样本外跟踪（警惕过拟合/趋势依赖/结构突变）'; }
  else { verdict = 'REJECT'; advice = '修正后胜率不足，不建议实盘'; }

  return { adjustedWinRate: +wr.toFixed(4), adjustedReturn: +adjReturn.toFixed(4), steps, verdict, advice, stationarityFactor, structuralBreakFlag: !!sbFlag, survivorshipEvidence };
}

// =====================================================================
//  编排器：validateStrategy
// =====================================================================
async function validateStrategy(input) {
  const symbol = input.symbol || (input.symbols && input.symbols[0]);
  if (!symbol) throw new Error('缺少标的 symbol');
  // 解析 DSL；若用户写的是「大白话中文」，用确定性翻译器转成 DSL（纯代码、无 LLM）
  let dsl, derivedFrom = 'dsl', derivedNotes = [];
  try {
    dsl = parseDSL(input.dsl);
  } catch (e) {
    const nl = strategyNL.translate(input.dsl == null ? '' : String(input.dsl));
    if (nl && nl.ok) {
      dsl = normalizeDSL(nl.dsl);
      derivedFrom = 'natural_language';
      derivedNotes = nl.notes || [];
    } else if (nl && nl.reason === 'unsupported') {
      throw new Error('这段中文策略用到了回测引擎暂不支持的玩法：' + nl.unsupported.join('、')
        + '。引擎目前只支持「全进全出」的二元买卖与常见技术指标（均线 / MACD / RSI / 布林带 / 收益率 z-score）。可改用上方「🤖 生成并校验策略」，或点「模板」按钮套用现成策略。');
    } else {
      throw new Error((e && e.message || 'DSL 解析失败')
        + '。若想直接用中文描述，请写清买卖方向 + 常见技术指标，例如：「5日均线上穿20日均线买入，5日均线下穿20日均线卖出」。');
    }
  }
  const range = dsl.range;

  // 交易成本：默认对称 costPerSide；若 DSL 指定 cost_model（分层成本），解析为非对称买/卖成本
  const costModel = dsl.costModel ? aShareCostModel(dsl.costModel) : null;
  const btOpts = costModel
    ? { costPerSide: dsl.costPerSide, buyCost: costModel.buyCost, sellCost: costModel.sellCost }
    : { costPerSide: dsl.costPerSide };
  // 风控出场 & 分批建仓（仅在 DSL 显式给出时挂载；未给出时 btOpts 与历史完全一致）
  if (dsl.risk) {
    if (dsl.risk.stopLoss != null && dsl.risk.stopLoss > 0) btOpts.stopLoss = dsl.risk.stopLoss;
    if (dsl.risk.takeProfit != null && dsl.risk.takeProfit > 0) btOpts.takeProfit = dsl.risk.takeProfit;
    if (dsl.risk.trailing != null && dsl.risk.trailing > 0) btOpts.trailing = dsl.risk.trailing;
    if (dsl.risk.tranches != null && dsl.risk.tranches > 1) {
      btOpts.tranches = dsl.risk.tranches;
      if (dsl.risk.trancheGap != null) btOpts.trancheGap = dsl.risk.trancheGap;
    }
  }

  // 1) 取数
  const hist = await getHistory(symbol, range);
  if (!Array.isArray(hist) || hist.length < 30) {
    throw new Error(`标的 ${symbol} 历史数据不足（${hist ? hist.length : 0} 根），无法回测`);
  }
  const series = hist.map(d => ({
    date: d.date,
    open: +d.open, high: +d.high, low: +d.low, close: +d.close, volume: +d.volume
  }));

  // 数据契约占位（前复权；ST/停牌/退市本版未接入，标注 unverified）
  const contract = {
    adjust_type: 'qfq',
    adj_factor: 1,
    is_suspended: 'unverified',
    is_st: 'unverified',
    is_delisted: 'unverified',
    note: '本版前复权已归一；ST/停牌/退市状态需接入 F10 数据源后补全'
  };

  // 2) 指标上下文
  const close = series.map(s => s.close);
  const ctx = { close, open: series.map(s => s.open), high: series.map(s => s.high), low: series.map(s => s.low), volume: series.map(s => s.volume) };

  // 3) 信号
  const buySig = evaluateCondition(dsl.buy, ctx);
  const sellSig = evaluateCondition(dsl.sell, ctx);

  // 4) 训练/测试拆分回测
  const N = series.length;
  const splitIdx = Math.max(2, Math.floor(N * dsl.trainRatio));
  const trainSeries = series.slice(0, splitIdx);
  const testSeries = series.slice(splitIdx);
  const full = runBacktest(series, buySig, sellSig, btOpts);
  const train = runBacktest(trainSeries, buySig.slice(0, splitIdx), sellSig.slice(0, splitIdx), btOpts);
  const test = runBacktest(testSeries, buySig.slice(splitIdx), sellSig.slice(splitIdx), btOpts);

  // 5) 统计检验
  const retSeries = returnsPct(close).slice(1);
  const adfClose = adf(close);
  const adfRet = adf(retSeries);
  const kp = kpss(close);
  const acf1 = acf(retSeries, 1);
  const acf5 = acf(retSeries, 5);
  const acf20 = acf(retSeries, 20);
  const acf60 = acf(retSeries, 60);
  const pacfArr = pacf(retSeries, 5);
  let cointegration = null;
  if (dsl.strategyType === 'pair' && dsl.symbols.length >= 2) {
    const histB = await getHistory(dsl.symbols[1], range);
    const closeB = histB.map(d => +d.close);
    const mn = Math.min(close.length, closeB.length);
    // 优先 Johansen（迹检验，Osterwald-Lenum 临界值）；样本不足/矩阵奇异时自动降级回 Engle-Granger
    const joh = johansen([close.slice(0, mn), closeB.slice(0, mn)]);
    // 保留 EG 结果作为交叉验证（两个检验结论一致时置信度更高）
    const eg = engleGranger(close.slice(0, mn), closeB.slice(0, mn));
    cointegration = joh;
    cointegration.engleGranger = {
      stat: +(+eg.stat).toFixed(4),
      cointegrated: eg.cointegrated,
      pValueApprox: eg.pValueApprox,
    };
    cointegration.agreement = (joh.cointegrated === eg.cointegrated);
  }
  const trend = linearTrend(close);

  // 真实 F10 上市状态（ST/退市风险警示历史）——用于把幸存者偏差从"经验 0.9"升级为"证据驱动"
  // 仅在调用方未显式指定 survivorship 时才去取数（避免无谓的外部请求）；取数失败如实标注、不臆造。
  let f10 = null;
  if (dsl.survivorship == null) {
    try {
      f10 = await f10Status.getListingStatus(symbol);
    } catch (e) {
      f10 = { ok: false, reason: 'exception', detail: e.message, survivorship: null };
    }
  }

  // 策略分类 / 前视扫描 / 平稳性闸门（铁律）+ 结构突变 / 季节性
  const strategyClass = classifyStrategy(dsl.buy, dsl.sell);
  const la = lookaheadScan(dsl.buy, dsl.sell);
  const stationarityFactor = stationarityFactorFor(strategyClass, adfClose.stationary, adfRet.stationary);
  const sb = structuralBreak(series, buySig, sellSig, btOpts);
  const season = seasonalityScan(retSeries);

  // 6) 五大修正（含 A 项平稳性闸门）
  const corrections = applyCorrections(full, null, {
    trainWinRate: train.winRate,
    testWinRate: test.winRate,
    trend,
    costPerSide: dsl.costPerSide,
    survivorship: dsl.survivorship,
    f10,
    lookaheadDetected: la.detected
  }, {
    strategyClass,
    adfPriceStationary: adfClose.stationary,
    adfReturnStationary: adfRet.stationary,
    stationarityFactor,
    structuralBreak: sb,
    seasonality: season,
    minTrades: 10
  });

  const riskCheck = {
    strategy_class: strategyClass,
    lookahead: la,
    adf_price: adfClose,
    adf_return: adfRet,
    kpss_price: kp,
    acf: { lag1: +acf1.toFixed(3), lag5: +acf5.toFixed(3), lag20: +acf20.toFixed(3), lag60: +acf60.toFixed(3) },
    pacf_lag1_5: pacfArr.slice(1, 6).map(v => +v.toFixed(3)),
    cointegration,
    structural_break: sb,
    seasonality: season,
    f10_status: f10 ? {
      ok: f10.ok,
      reason: f10.reason || null,
      detail: f10.detail || null,
      currentName: f10.currentName || null,
      formerName: f10.formerName || null,
      listingDate: f10.listingDate || null,
      listingYears: f10.listingYears != null ? f10.listingYears : null,
      stHistory: f10.stHistory ? f10.stHistory.map(h => ({ name: h.name, level: h.level })) : null,
      hasST: !!f10.hasST,
      survivorship: f10.survivorship != null ? f10.survivorship : null,
      source: f10.source || null,
      evidence: f10.evidence || f10.note || null,
    } : null,
    notes: [
      'ADF 原假设=存在单位根；stat < p5 临界值 拒绝原假设→平稳（滞后阶按 AIC 自动定阶）',
      'KPSS 原假设=平稳；stat > p5 临界值 拒绝原假设→非平稳（长程方差用 Newey-West/Bartlett）',
      '协整（pair）采用 Johansen 迹检验（Osterwald-Lenum 临界值）；样本不足/矩阵奇异时自动降级 Engle-Granger 残差 ADF，并附 EG 交叉验证结果',
      '平稳性闸门：非平稳价格上的均值回归策略会被 ×0.5 折算（伪回归陷阱）',
      '交易成本默认对称 0.55%/边；指定 cost_model 可启用分层非对称成本（含印花税仅卖出）',
      '幸存者偏差系数优先取真实 F10 证据（曾用名链含 ST/*ST 的次数）；取不到时保底 0.9 并标注未获证据'
    ]
  };

  return {
    base_info: {
      symbol,
      name: input.name || dsl.name,
      strategy_type: dsl.strategyType,
      strategy_name: dsl.name,
      range,
      data_points: N,
      train_ratio: dsl.trainRatio,
      cost_per_side: dsl.costPerSide,
      cost_model: costModel,
      contract,
      derived_from: derivedFrom,
      derived_buy: derivedFrom === 'natural_language' ? dsl.buy : null,
      derived_sell: derivedFrom === 'natural_language' ? dsl.sell : null,
      derived_notes: derivedNotes
    },
    raw_backtest_result: {
      full: full,
      train: { totalTrades: train.totalTrades, winRate: train.winRate, totalReturn: train.totalReturn, sharpe: train.sharpe, maxDrawdown: train.maxDrawdown },
      test: { totalTrades: test.totalTrades, winRate: test.winRate, totalReturn: test.totalReturn, sharpe: test.sharpe, maxDrawdown: test.maxDrawdown }
    },
    risk_check_result: riskCheck,
    adjusted_result: {
      adjusted_win_rate: corrections.adjustedWinRate,
      adjusted_return: corrections.adjustedReturn,
      corrections: corrections.steps,
      survivorship_evidence: corrections.survivorshipEvidence || null
    },
    operation_suggestion: {
      verdict: corrections.verdict,
      advice: corrections.advice,
      warnings: (() => {
        const w = [];
        if (la.detected) w.push('⚠ 前视偏差：' + la.reason);
        if (strategyClass === 'reversion' && !adfClose.stationary) w.push('⚠ 伪回归陷阱：价格序列非平稳，均值回归策略不可靠，建议改用 RET/ZSCORE 收益率路径');
        if (sb.significant) w.push('⚠ 结构性突变：前后半段胜率差 ' + (sb.delta * 100).toFixed(0) + 'pp（' + (sb.firstHalfWinRate * 100).toFixed(0) + '% → ' + (sb.secondHalfWinRate * 100).toFixed(0) + '%）');
        if (season.hasSeasonality) w.push('ℹ 检出季节性/周期性（月滞后面 ACF=' + season.lag20 + '，季=' + season.lag60 + '）');
        return w;
      })()
    },
    diagnostics: {
      buy_signal_days: buySig.filter(Boolean).length,
      sell_signal_days: sellSig.filter(Boolean).length,
      sample_trades: full.totalTrades,
      min_trades: 10,
      note: '首版骨架：统计临界值为标准近似；pair 协整为 Engle-Granger 降级；ST/停牌状态未接入'
    }
  };
}

module.exports = {
  validateStrategy,
  parseDSL,
  evaluateCondition,
  runBacktest,
  aShareCostModel,
  applyCorrections,
  // 风险分析辅助（A–E）
  classifyStrategy,
  lookaheadScan,
  stationarityFactorFor,
  walkForward,
  structuralBreak,
  seasonalityScan,
  returnsPct,
  rollingMean,
  rollingStd,
  zscore,
  // 暴露统计/指标便于单测
  adf, kpss, pacf, acf, engleGranger, johansen, jacobiEigen, matInverse, linearTrend, MA, EMA, RSI, BOLL, MACD,
  // F10 上市状态（ST/退市风险警示）证据层透出，便于单测与其他模块复用
  f10Status
};

~~~

---

## `lib\boardReviewData.js`  ·  137 行

~~~js
/**
 * lib/boardReviewData.js — 连板梯队 / 龙虎榜取数桥接（20261107，20261108 扩展）
 * ==================================================================
 * 调 scripts/board_review_data.py（akshare 东财涨停池 + 昨日涨停池 + 强势股池 + 龙虎榜明细），
 * 数值全部由 Python 本机代码统计，Node 层只做桥接与缓存，不计算、不补齐、不臆造。
 *
 * 20261108 扩展：新增 prevPool / sectors / activity / historySeries 四块；
 * getBoardReviewData 第二参数 opts.histDates（ISO 日期数组）经 --hist-dates 传入 Python，
 * 缓存 key 含 histDates 避免不同对照日串数据；normalizeDateFields 同步归一化新块的日期字段。
 * 原有 ladder / lhb 字段与语义、以及单参数调用（ReviewService）完全不变。
 *
 * 隔离原则：取数失败抛异常，由 ReviewService 的 collect() 统一降级为「缺失」信封。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPython } = require('./pyRuntime');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'board_review_data.py');
const CACHE_TTL = 10 * 60 * 1000;
let _cache = new Map();

/** 上一交易日（Asia/Shanghai 口径，复用唯一权威交易日历） */
function prevTradingDate(dateStr) {
  const { previousTradingDay } = require('./cnTradingCalendar');
  return previousTradingDay(dateStr);
}

/**
 * 口径日统一：Python 侧为调用 akshare 使用紧凑 YYYYMMDD，
 * 但复盘的五要素 asOf 全站统一 YYYY-MM-DD（与 quote/breadth/sectorFlow 一致）。
 * 若不统一，integrity 段的「口径差异」自检会把同一天误判成两个日期。
 * 只做格式归一化，绝不改写数值、不推算日期。
 */
function isoDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s || null;
}
function normalizeDateFields(data) {
  data.date = isoDate(data.date) || data.date;
  data.prevDate = isoDate(data.prevDate);
  // 紧凑 YYYYMMDD → ISO YYYY-MM-DD；只做格式归一化，绝不改写数值、不推算日期。
  ['ladder', 'lhb', 'prevPool', 'sectors', 'activity'].forEach(k => {
    if (data[k] && typeof data[k] === 'object') data[k].asOf = isoDate(data[k].asOf) || data[k].asOf;
  });
  if (Array.isArray(data.historySeries)) {
    data.historySeries.forEach(row => {
      if (row && typeof row === 'object') row.date = isoDate(row.date) || row.date;
    });
  }
  // 20261108 扩展：sectors.industryHistory[].date 紧凑 YYYYMMDD → ISO（与 historySeries 同口径）
  if (data.sectors && Array.isArray(data.sectors.industryHistory)) {
    data.sectors.industryHistory.forEach(row => {
      if (row && typeof row === 'object') row.date = isoDate(row.date) || row.date;
    });
  }
  return data;
}

/**
 * @param {string} dateStr YYYY-MM-DD
 * @param {object} [opts] 可选：{ histDates: string[] } 复盘日之前的前 3-5 个交易日（ISO 日期数组）
 * @returns {Promise<object>} { ok, date, prevDate, fetchedAt, source, ladder, lhb,
 *                             prevPool, sectors, activity, historySeries, issues }
 */
async function getBoardReviewData(dateStr, opts) {
  const options = opts || {};
  const key = String(dateStr || '');
  const histDates = Array.isArray(options.histDates)
    ? options.histDates.filter(Boolean).map(x => String(x).trim()).filter(Boolean)
    : [];
  // 缓存 key 必须包含 histDates，否则不同对照日会串数据；排序使顺序无关也能命中同一缓存
  const cacheKey = key + '|' + histDates.slice().sort().join(',');
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  const py = findPython();
  if (!py) throw new Error('未找到 Python 解释器');
  if (!fs.existsSync(SCRIPT)) throw new Error('board_review_data.py 不存在');

  const compact = key.replace(/-/g, '');
  const prev = prevTradingDate(key).replace(/-/g, '');
  const args = [SCRIPT, '--date', compact];
  if (prev && /^\d{8}$/.test(prev)) args.push('--prev-date', prev);
  if (histDates.length) args.push('--hist-dates', histDates.map(x => x.replace(/-/g, '')).join(','));

  const { stdout } = await execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  let data;
  try { data = JSON.parse(String(stdout).trim()); }
  catch (e) { throw new Error('取数脚本返回非 JSON：' + String(stdout).slice(0, 160)); }
  if (!data || data.ok === false) {
    const why = (data && data.issues && data.issues[0] && data.issues[0].msg) || '未知原因';
    throw new Error('连板/龙虎榜取数失败：' + why);
  }
  normalizeDateFields(data);
  _cache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

/**
 * 龙虎榜晚间补录专用：只抓当日龙虎榜明细，不跑涨停池/多日序列（实测快很多）。
 * 20261110a / ERR-20261110-001：龙虎榜是盘后延迟发布数据，15:35 的空结果不能当失败快照；
 * 补录时必须绕开 10 分钟缓存并重新请求，否则会一直命中下午那次「尚未发布」。
 * 本方法刻意不写缓存，也不清全局缓存（由调用方在补录前显式 clearCache）。
 */
async function getLhbOnly(dateStr) {
  const py = findPython();
  if (!py) throw new Error('未找到 Python 解释器');
  if (!fs.existsSync(SCRIPT)) throw new Error('board_review_data.py 不存在');
  const compact = String(dateStr || '').replace(/-/g, '');
  const { stdout } = await execFileAsync(py, [SCRIPT, '--date', compact, '--lhb-only'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 90000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  let data;
  try { data = JSON.parse(String(stdout).trim()); }
  catch (e) { throw new Error('补录取数脚本返回非 JSON：' + String(stdout).slice(0, 160)); }
  if (!data || typeof data !== 'object') throw new Error('补录取数脚本返回空内容');
  normalizeDateFields(data);
  return data;
}

function clearCache() { _cache.clear(); }

module.exports = { getBoardReviewData, getLhbOnly, prevTradingDate, clearCache, normalizeDateFields };

~~~

---

## `lib\brokerClassification.js`  ·  135 行

~~~js
/**
 * lib/brokerClassification.js —— 券商类型分类与估值模型选择（确定性逻辑）
 * ----------------------------------------------------------------
 * 用户 2026-09-08 确立。与 601318 专属估值模型同一原则：计算层=代码（纯四则 + 阈值比较），
 * 不依赖 AI；输入锁死 ⇒ 结果锁死（1+1=2），与用哪个 AI 模型、什么时候跑无关。
 *
 * 流程：
 *   STEP1 数据清洗层（AI 依赖）：从年报/半年报/季报抽取 6 个核心指标 —— 见 prompts/broker-valuation-data.md
 *   STEP2 三维度分级评分（本文件，确定性）：规模 S / 创新 I / 多元 D，各 1~3 分
 *   STEP3 决策树分类（本文件，确定性）：归入 4 类画像，匹配核心估值模型
 *   STEP4 输出（本文件 formatConclusion）：画像 / 核心估值锚 / 辅助验证 / 关键风险点
 *
 * 输入指标口径：
 *   totalAssets     总资产（亿元）
 *   netCapital      净资本（亿元）—— 监管核心抗风险指标
 *   brokerageRatio  经纪业务收入占比（%） = 代理买卖证券业务净收入 / 营业收入
 *   lightBizRatio   投行+资管+财富管理收入占比（%）= (投行净收入+资管净收入+代销金融产品净收入)/营业收入
 *   proprietaryRatio 自营投资收入占比（%）= (投资收益+公允价值变动损益)/营业收入
 *   hhi             收入集中度 HHI（0~1）= Σ各业务收入占比²（越接近1越单一，越接近0越多元）
 */
'use strict';

// 4 类画像元数据：业务特征 + 推荐估值模型 + 核心逻辑 + 关键风险点
const TYPE_META = {
  I: {
    key: 'I', name: '传统通道型中小券商',
    primary: '单一PB（市净率）',
    primaryLogic: '同质化重资产通道商，净资产重置成本是价值底线；重点看 PB 历史分位的折价与 ROE 修复逻辑。',
    aux: 'PB-ROE 回归线（辅）',
    risk: '在该模型下，需重点关注市场成交量（经纪+两融）的边际变化；仅在破净时具备安全边际。',
  },
  II: {
    key: 'II', name: '重资本自营型券商',
    primary: '调整后PB（主）',
    primaryLogic: '业绩弹性极大、净资产波动大，需扣减自营持仓浮盈浮亏对净资产的影响，用调整后可比 PB。',
    aux: '市场敏感性测试（辅）',
    risk: '在该模型下，需重点关注自营持仓公允价值变动、权益/债券市场波动，及调整后 PB 的稳健性。',
  },
  III: {
    key: 'III', name: '精品投行/财富管理型',
    primary: 'PE（市盈率，主）',
    primaryLogic: '轻资产高壁垒，盈利稳定可持续，PE 比 PB 更能反映品牌溢价与成长性。',
    aux: 'RIM 剩余收益模型（辅）',
    risk: '在该模型下，需重点关注资管规模净流入/流出、投行业务周期，及 ROE 的可持续性。',
  },
  IV: {
    key: 'IV', name: '综合航母均衡型',
    primary: 'SOTP 分部加总估值（主）',
    primaryLogic: '业务条线齐全、盈利能力差异大，需拆分：经纪/信用用 PB，投行/资管用 PE，自营用 P/NAV，最后加总。',
    aux: 'PB/PE 交叉验证（辅）',
    risk: '在该模型下，需重点关注各业务条线协同与分化、机构化/国际化进展，及分部分别估值偏差。',
  },
};

// ---- 维度A：规模等级（Scale）----
function scoreScale(totalAssets, netCapital) {
  // 3分（大型全能）：总资产≥5000亿 且 净资本≥800亿
  if (totalAssets >= 5000 && netCapital >= 800) return 3;
  // 2分（中型成长）：2000亿≤总资产<5000亿（含总资产≥5000但净资本不足800的"规模够、资本不够"情形，归为2）
  if (totalAssets >= 2000) return 2;
  // 1分（中小型）：总资产<2000亿
  return 1;
}

// ---- 维度B：创新业务占比（Innovation）---- 反映轻资产转型程度
function scoreInnovation(lightBizRatio) {
  if (lightBizRatio >= 45) return 3; // 高创新
  if (lightBizRatio >= 30) return 2; // 中等创新
  return 1;                          // 传统通道型
}

// ---- 维度C：业务多元化（Diversification）---- 反映抗周期与均衡能力
function scoreDiversification(hhi) {
  if (hhi < 0.25) return 3;   // 高度均衡
  if (hhi < 0.45) return 2;   // 中度均衡
  return 1;                   // 业务单一
}

// ---- STEP3 决策树：根据三维度得分 + 自营占比特殊判定，归入 4 类 ----
function decideTypeKey({ scale, innovation, diversification, proprietaryRatio }) {
  // 特殊判定（最高优先）：自营收入占比 > 40% → 重资本自营型（即使规模大也归此类）
  if (proprietaryRatio > 40) return 'II';
  // 综合航母均衡型：Scale=3 且 Innovation≥2 且 Diversification=3
  if (scale === 3 && innovation >= 2 && diversification === 3) return 'IV';
  // 精品投行/财富管理型：Innovation=3 且 Scale≤2
  if (innovation === 3 && (scale === 1 || scale === 2)) return 'III';
  // 其余（Scale≤2 且 Innovation≤2）：传统通道型中小券商
  return 'I';
}

/**
 * 主入口：给定 6 个输入指标，返回三维度得分、画像类型、推荐估值模型与风险点。
 * @param {Object} m 指标（单位见文件头注释）
 * @returns {Object}
 */
function classify(m) {
  const totalAssets = Number(m.totalAssets);
  const netCapital = Number(m.netCapital);
  const brokerageRatio = Number(m.brokerageRatio);
  const lightBizRatio = Number(m.lightBizRatio);
  const proprietaryRatio = Number(m.proprietaryRatio);
  const hhi = Number(m.hhi);

  if ([totalAssets, netCapital, brokerageRatio, lightBizRatio, proprietaryRatio, hhi].some(v => !isFinite(v))) {
    return { ok: false, error: 'INPUT_INVALID', message: '6 个核心指标必须均为有效数字（总资产/净资本单位亿元，各项收入占比单位%，HHI 单位 0~1）' };
  }

  const scale = scoreScale(totalAssets, netCapital);
  const innovation = scoreInnovation(lightBizRatio);
  const diversification = scoreDiversification(hhi);
  const typeKey = decideTypeKey({ scale, innovation, diversification, proprietaryRatio });
  const meta = TYPE_META[typeKey];

  return {
    ok: true,
    metrics: { totalAssets, netCapital, brokerageRatio, lightBizRatio, proprietaryRatio, hhi },
    scores: { scale, innovation, diversification },
    type: typeKey,
    typeName: meta.name,
    primaryModel: meta.primary,
    primaryLogic: meta.primaryLogic,
    auxModel: meta.aux,
    riskPoint: meta.risk,
    // STEP4 最终结论输出格式
    conclusion: {
      profile: `类型${typeKey}：${meta.name}`,
      anchor: `建议以${meta.primary}为主`,
      aux: `建议辅以${meta.aux}`,
      risk: meta.risk,
    },
  };
}

module.exports = { classify, scoreScale, scoreInnovation, scoreDiversification, decideTypeKey, TYPE_META };

~~~

---

## `lib\brokerSectorTurnover.js`  ·  134 行

~~~js
/**
 * 券商板块成交额 / 全市场成交额 —— 供华安证券(600909)专属估值模型
 *   「守门员② 市场环境」与「风险监测（指令4）」取数使用。
 * ==================================================================
 * 背景（20260922d，用户质疑「东财明明有，为何标黄『无法获取』」）：
 *   - 东财「行业板块成交额」是 push2 行情族独有字段（clist 的 f6）；本机 push2 族被对端
 *     在 TLS 握手后重置（与项目其它 push2 依赖同因），故该字段不可达。
 *   - 东财「数据中心」报表族：RPT_INDUSTRY_FUNDFLOW（行业）**不含成交额**；
 *     RPT_FUNDFLOW_BOARD（概念板块）**含逐日成交额 AMOUNT**（单位≈万元）。
 *     即：东财数据中心能拿到的是「概念板块」成交额（如「券商概念」BK0711）。
 *   - 项目既有「同花顺·行业板块成交额」落盘于 data/sector_crowding_history.json
 *     （lib/sectorCrowding.js 维护，「证券」板块 + marketTotal=全市场合计），实测
 *     2026-09-22 券商板块 182.63 亿，与用户东财截图「证券Ⅱ 184.71 亿」吻合。
 *
 * 取值优先级（满足「同一指标单一数据源」，并为缺失提供兜底）：
 *   券商板块成交额：① 同花顺行业板块（本地存盘，与 sectorCrowding 同源）
 *                  ② 东方财富·概念板块「券商概念」(BK0711)（数据中心，逐日）
 *   全市场成交额：  ① 同花顺·申万一级行业成交额合计（本地存盘 marketTotal，sectorCrowding 既有口径）
 *
 * 偏离基线（守门员②）：近 20 交易日日均成交额 相对 近 60 交易日（可用窗口）日均成交额
 *   的偏离百分比；|偏离| > 阈值（默认 30%）→ 判定「市场环境突变」。
 */
const fs = require('fs');
const path = require('path');
const em = require('./emDataCenter');

const STORE = path.join(__dirname, '..', 'data', 'sector_crowding_history.json');
const BROKER_NAME_RE = /^(证券Ⅱ?|券商)/;   // 同花顺行业板块名（「证券」= 申万二级 证券Ⅱ 类比）
const EM_BROKER_BOARD = 'BK0711';           // 东财概念「券商概念」（备源）
const WIN = 20;                             // 近 20 交易日
const BASE_WIN = 60;                        // 基线窗口（可用则取 60，不足取全部）

const _r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
const _avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

function _readStore() {
  try {
    const obj = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (e) { return null; }
}

/** 从本地同花顺行业板块存盘抽取「券商板块成交额」与「全市场成交额」逐日序列 */
function _fromStore() {
  const store = _readStore();
  if (!store) return null;
  const dates = Object.keys(store).sort();
  if (!dates.length) return null;
  const broker = [], market = [];
  for (const d of dates) {
    const e = store[d];
    if (!e) continue;
    const s = (e.sectors || []).find((x) => BROKER_NAME_RE.test(String(x.name || '')));
    if (s && Number(s.amount) > 0) broker.push({ date: d, amountYi: Number(s.amount) });
    if (Number(e.marketTotal) > 0) market.push({ date: d, amountYi: Number(e.marketTotal) });
  }
  if (!broker.length && !market.length) return null;
  return { broker, market };
}

/** 备源：东财数据中心·概念板块「券商概念」逐日成交额（AMOUNT 单位≈万元 → 亿元） */
async function _fromEmConcept() {
  const rows = await em.fetchReport(em.REPORTS.FUNDFLOW_BOARD, {
    filter: `(BOARD_CODE1="${EM_BROKER_BOARD}")`,
    sortColumns: 'TRADE_DATE', sortTypes: -1,
    pageSize: 90, columns: 'BOARD_CODE1,BOARD_NAME,TRADE_DATE,AMOUNT',
  });
  const broker = rows
    .map((r) => ({ date: String(r.TRADE_DATE).slice(0, 10), amountYi: _r2(Number(r.AMOUNT) / 10000) }))
    .filter((x) => x.amountYi > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return broker.length ? broker : null;
}

/**
 * 由逐日序列汇总：当日 / 近20日日均 / 基线日均 / 偏离%。
 * @param {Array<{date:string, amountYi:number}>} series
 */
function summarize(series, win = WIN, baseWin = BASE_WIN) {
  if (!Array.isArray(series) || !series.length) return null;
  const arr = series.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const vals = arr.map((x) => x.amountYi);
  const today = arr[arr.length - 1];
  const avg20 = _r2(_avg(vals.slice(-Math.min(win, vals.length))));
  const baseline = _r2(_avg(vals.slice(-Math.min(baseWin, vals.length))));
  const devPct = (baseline && baseline > 0) ? _r2(((avg20 - baseline) / baseline) * 100) : null;
  return {
    date: today.date,
    todayYi: _r2(today.amountYi),
    avg20Yi: avg20,
    baselineYi: baseline,
    devPct,                                   // (近20日日均 − 基线日均) / 基线日均 × 100
    windowDays: Math.min(win, vals.length),
    baseDays: Math.min(baseWin, vals.length),
    n: vals.length,
  };
}

/**
 * 汇总输出：{ ok, broker:{...}, market:{...} }。
 * broker 缺失时尝试东财概念板块备源；market 缺失时 broker 仍可用。
 */
async function getTurnoverContext() {
  const out = { ok: false, broker: null, market: null, source: null };
  const st = _fromStore();
  if (st) {
    if (st.broker.length) {
      out.broker = summarize(st.broker);
      out.broker.source = '同花顺·行业板块（申万二级「证券」口径，与 sectorCrowding 同源）';
    }
    if (st.market.length) {
      const m = summarize(st.market);
      out.market = {
        date: m.date, todayYi: m.todayYi, avg20Yi: m.avg20Yi, n: m.n,
        source: '同花顺·申万一级行业成交额合计（A股全市场成交额近似，同 sectorCrowding 口径）',
      };
    }
  }
  if (!out.broker) {
    try {
      const b = await _fromEmConcept();
      if (b) {
        out.broker = summarize(b);
        out.broker.source = '东方财富·概念板块「券商概念」(BK0711)（数据中心，逐日）';
      }
    } catch (e) { /* 备源失败则维持 null，由调用方降级 */ }
  }
  out.source = out.broker ? out.broker.source : null;
  out.ok = !!(out.broker && out.market);
  return out;
}

module.exports = { getTurnoverContext, summarize, _fromStore, BROKER_NAME_RE, EM_BROKER_BOARD };

~~~

---

## `lib\brokerValuation.js`  ·  189 行

~~~js
/**
 * lib/brokerValuation.js —— 券商 4 类估值模型（确定性计算层）
 * ----------------------------------------------------------------
 * 用户 2026-09-08 确立，与 601318 专属模型、brokerClassification 同一原则：
 * 计算层=代码（纯四则+固定乘数/阈值），不依赖 AI；输入锁死 ⇒ 结果锁死（1+1=2）。
 *
 * 四类画像 → 对应估值模型（详见 prompts/broker-valuation-models.md 的 AI 叙述版）：
 *   类型Ⅰ 传统通道型中小券商  → valueTypeI   单一PB（PB-ROE修正）
 *   类型Ⅱ 重资本自营型券商    → valueTypeII  调整后PB + 市场敏感性测试
 *   类型Ⅲ 精品投行/财富管理型 → valueTypeIII PE（主）+ RIM（辅）
 *   类型Ⅳ 综合航母均衡型      → valueTypeIV  SOTP 分部加总
 *
 * 单位约定：金额默认「亿元」，股价/BPS 默认「元/股」，占比为百分点(%)、HHI 为 0~1。
 */
'use strict';
const { classify } = require('./brokerClassification');

const r2 = (v) => (v == null || !isFinite(Number(v))) ? null : Math.round(Number(v) * 100) / 100;

// ============ 类型Ⅰ：单一PB（PB-ROE 修正模型） ============
function valueTypeI(inp) {
  const bps = Number(inp.bps);
  const pbMedian5y = Number(inp.pbMedian5y); // 近5年PB历史中位数（倍数）
  const pbP10 = Number(inp.pbP10);           // 近5年PB 10%分位（倍数）
  const pbP50 = Number(inp.pbP50);           // 近5年PB 50%分位（倍数）
  const roeAvg3y = Number(inp.roeAvg3y);     // 近3年平均ROE（小数，如0.06）
  const cost = inp.costOfEquity != null ? Number(inp.costOfEquity) : 0.085; // 行业股权资本成本
  const g = inp.g != null ? Number(inp.g) : 0.02;                            // 永续增长（通胀）
  const currentPB = inp.currentPB != null ? Number(inp.currentPB) : null;

  const fairPB = (roeAvg3y - g) / (cost - g);
  const low = Math.max(pbP10, fairPB * 0.9);
  const high = Math.min(pbP50, fairPB * 1.1);
  const priceLow = bps * low;
  const priceHigh = bps * high;

  let undervalued = null, note = '';
  if (currentPB != null) {
    if (currentPB < low) { undervalued = true; note = '当前PB低于估值下限，处于低估区间'; }
    else if (currentPB > high) { undervalued = false; note = '当前PB高于估值上限，处于高估区间'; }
    else { undervalued = '中性'; note = '当前PB处于估值区间内，合理'; }
  }
  const brokenNet = currentPB != null && currentPB < 1;
  return {
    ok: true, type: 'I', model: '单一PB（PB-ROE修正）',
    fairPB: r2(fairPB),
    rangeLowPB: r2(low), rangeHighPB: r2(high),
    priceLow: r2(priceLow), priceHigh: r2(priceHigh),
    undervalued,
    note: (brokenNet ? '当前已破净（PB<1），属深度价值区间。' : '') + note,
    risk: '该估值对市场日均成交量（ADT）敏感，若ADT环比下滑超15%，需下调ROE预期并重算。',
  };
}

// ============ 类型Ⅱ：调整后PB + 市场敏感性测试 ============
// 注：提示词中「浮盈总额/仓位」为全公司总额（亿元），需除以总股本（亿股）转成每股口径后再参与每股净资产计算。
function valueTypeII(inp) {
  const bpsBook = Number(inp.bpsBook);                 // 账面每股净资产（元/股）
  const shares = Number(inp.shares);                   // 总股本（亿股）
  const eqGainTotal = Number(inp.equityUnrealizedGainTotal);   // 权益类账面浮盈（亿元，已扣递延所得税）
  const fiGainTotal = Number(inp.fixedIncomeUnrealizedGainTotal); // 固收类账面浮盈（亿元）
  const adjPb = Number(inp.adjPbMedian3y);             // 历史3年调整后PB中枢（乘数）
  const eqPosTotal = Number(inp.equityProprietaryPositionTotal); // 权益自营仓位（亿元）
  const currentPrice = inp.currentPrice != null ? Number(inp.currentPrice) : null;

  const eqGainPS = eqGainTotal / shares;
  const fiGainPS = fiGainTotal / shares;
  const eqPosPS = eqPosTotal / shares;

  const adjBPS = bpsBook - eqGainPS * 0.85 - fiGainPS * 1.0;
  const base = adjBPS * adjPb;
  // 悲观：沪深300 -15% → 权益浮盈缩水约 15%×仓位（85%税调）
  const adjBPS_pess = adjBPS - eqPosPS * 0.15 * 0.85;
  const pess = adjBPS_pess * adjPb * 0.95;
  // 乐观：沪深300 +10%
  const adjBPS_opt = adjBPS + eqPosPS * 0.10 * 0.85;
  const opt = adjBPS_opt * adjPb * 1.05;
  const weighted = base * 0.5 + pess * 0.25 + opt * 0.25;

  const bookPB = currentPrice != null && bpsBook ? currentPrice / bpsBook : null;
  return {
    ok: true, type: 'II', model: '调整后PB + 市场敏感性测试',
    bookPB: bookPB != null ? r2(bookPB) : null,
    adjPbCenter: r2(adjPb),
    adjBPS: r2(adjBPS),
    stressRange: [r2(pess), r2(opt)],
    weightedTarget: r2(weighted),
    risk: '若十年期国债利率上行超过50BP，债券自营浮盈将快速缩水，需重新触发该模型。',
  };
}

// ============ 类型Ⅲ：PE（主）+ RIM（辅） ============
function valueTypeIII(inp) {
  const eps = Number(inp.eps);
  const cagr = Number(inp.epsCAGR);     // 未来3年EPS复合增长率（小数）
  const roe = Number(inp.roe);
  const industryAvgRoe = Number(inp.industryAvgRoe);
  const industryAvgPE = inp.industryAvgPE != null ? Number(inp.industryAvgPE) : 16; // A股证券行业PE中位数
  const bps0 = Number(inp.bps);
  const cost = inp.costOfEquity != null ? Number(inp.costOfEquity) : 0.095;
  const gTerm = 0.03;

  const growthAdj = cagr > 0.20 ? 1.1 : (cagr >= 0.10 ? 1.0 : 0.9);
  const fairPE = industryAvgPE * (roe / industryAvgRoe) * growthAdj;
  const peTarget = eps * fairPE;

  const epsArr = [Number(inp.eps1), Number(inp.eps2), Number(inp.eps3)]; // 未来3年预测EPS
  const bpsPath = [Number(inp.bps0), Number(inp.bps1), Number(inp.bps2)]; // 各年期初BPS（t-1）
  let pv = 0;
  for (let t = 1; t <= 3; t++) {
    const ri = epsArr[t - 1] - cost * (t === 1 ? bps0 : bpsPath[t - 2]);
    pv += ri / Math.pow(1 + cost, t);
  }
  const ri3 = epsArr[2] - cost * bpsPath[1];
  const tv = ri3 * (1 + gTerm) / (cost - gTerm) / Math.pow(1 + cost, 3);
  const rimValue = bps0 + pv + tv;

  const finalPrice = peTarget * 0.6 + rimValue * 0.4;
  return {
    ok: true, type: 'III', model: 'PE（主）+ RIM（辅）',
    fairPE: r2(fairPE),
    peTarget: r2(peTarget),
    rimValue: r2(rimValue),
    finalPrice: r2(finalPrice),
    finalRange: [r2(finalPrice * 0.95), r2(finalPrice * 1.05)],
    risk: '若该公司代销金融产品（基金销售）市占率发生重大变化，需同步上调或下调RIM中的永续增长率g。',
  };
}

// ============ 类型Ⅳ：SOTP 分部加总 ============
function valueTypeIV(inp) {
  const R_credit = Number(inp.R_credit);     // 经纪与信用净资产（亿元）
  const E_IB = Number(inp.E_IB);             // 投行净利润（亿元）
  const E_AM = Number(inp.E_AM);             // 资管与财富净利润（亿元）
  const R_principal = Number(inp.R_principal); // 自营投资净资产（亿元）
  const R_other = Number(inp.R_other);       // 其他净资产（亿元）
  const D_corp = Number(inp.D_corp);         // 集团总部净债务（亿元）
  const shares = Number(inp.totalShares);    // 总股本（亿股）

  const mCredit = 1.1, mIB = 16.5, mAM = 22.5, mPrincipal = 1.0, mOther = 1.0;
  const V_credit = R_credit * mCredit;
  const V_IB = E_IB * mIB;
  const V_AM = E_AM * mAM;
  const V_principal = R_principal * mPrincipal;
  const V_other = R_other * mOther;
  const total = V_credit + V_IB + V_AM + V_principal + V_other - D_corp;
  const perShare = total / shares;
  const low = (R_credit * mCredit * 0.95 + E_IB * mIB * 0.95 + E_AM * mAM * 0.95 + R_principal * mPrincipal * 0.95 + R_other * mOther * 0.95 - D_corp) / shares;
  const high = (R_credit * mCredit * 1.05 + E_IB * mIB * 1.05 + E_AM * mAM * 1.05 + R_principal * mPrincipal * 1.05 + R_other * mOther * 1.05 - D_corp) / shares;

  const breakdown = [
    { name: '经纪与信用', value: r2(V_credit) },
    { name: '投行', value: r2(V_IB) },
    { name: '资管与财富', value: r2(V_AM) },
    { name: '自营投资', value: r2(V_principal) },
    { name: '其他', value: r2(V_other) },
  ];
  return {
    ok: true, type: 'IV', model: 'SOTP 分部加总',
    breakdown,
    totalMarketCap: r2(total),
    perShare: r2(perShare),
    range: [r2(low), r2(high)],
    risk: '该模型高度依赖投行IPO及再融资节奏，若审核政策收紧，需同步下调V_IB乘数至12倍。',
  };
}

function valueByType(type, inp) {
  if (type === 'I') return valueTypeI(inp);
  if (type === 'II') return valueTypeII(inp);
  if (type === 'III') return valueTypeIII(inp);
  if (type === 'IV') return valueTypeIV(inp);
  return { ok: false, error: 'UNKNOWN_TYPE', message: `未知券商类型：${type}` };
}

/**
 * 组合入口：先分类，再按类型估值。
 * @param {Object} metrics 6 核心指标（见 brokerClassification）
 * @param {Object} valuationInputs 对应类型的估值输入（见各 valueTypeX）
 */
function classifyAndValue(metrics, valuationInputs) {
  const cls = classify(metrics);
  if (!cls.ok) return cls;
  const val = valueByType(cls.type, valuationInputs || {});
  return Object.assign({}, cls, { valuation: val });
}

module.exports = { valueTypeI, valueTypeII, valueTypeIII, valueTypeIV, valueByType, classifyAndValue };

~~~

---

## `lib\buybackEmDc.js`  ·  312 行

~~~js
/**
 * 东方财富「股票回购」结构化数据（datacenter-web 报表 RPTA_WEB_GETHGLIST_NEW）
 * ==================================================================
 * 背景（2026-09-21）：个股页「增持减持 → 股份回购」子卡片此前只在**公告/新闻标题里正则扫「回购」二字**，
 * 命中一条含「回购」的新闻标题就计 1 次、并把标题原文塞进 detail。结果：卡片显示「回购 1 次」+ 一条
 * 无关新闻标题（如「…回应二股东减持及回购力度…」），**用户真正要看的数据（已回购多少股/多少钱、
 * 承诺回购多少钱、进度到哪了）一个都没提炼出来**。
 *
 * 本模块走东财**官方回购数据页**（https://data.eastmoney.com/gphg/）背后的同一张报表，直接拿结构化字段。
 * 报表由该页 JS（/newstatic/js/gphg/list.js）暴露，参数与字段均已实测确认。
 *
 * 报表：RPTA_WEB_GETHGLIST_NEW
 *   filter = (DIM_SCODE="600909")   ← 6 位代码，不带交易所前缀
 *   columns=ALL  source=WEB  client=WEB  pageSize=50
 *
 * 关键字段（单位：金额=元，数量=股）：
 *   REPURPROGRESS      实施进度码（**需解码**，见 PROGRESS_MAP）
 *   REPURNUM  / REPURAMOUNT      已回购数量 / 已回购金额
 *   REPURAMOUNTLOWER / REPURAMOUNTLIMIT   承诺回购金额下限 / 上限
 *   REPURNUMLOWER    / REPURNUMCAP        承诺回购数量下限 / 上限
 *   REPURPRICECAP / REPURPRICELOWER1..    价格上限 / 实际成交价区间（上限/下限）
 *   REPURSTARTDATE / REPURENDDATE         回购起始 / 截止日
 *   FINISHDATE / UPD / NOTICEDATE         完成日 / 最新公告日
 *   DIM_DATE                              该档回购方案的报告期（用于多档取最新）
 *
 * ⚠️ 一只股票可能同时有**多档**回购方案（实测：宁德时代 3 档、工业富联 4 档、海天味业 2 档），
 *   必须按公告日 / 报告期取**最新一档**，否则会把历史已完成的老方案当成当前进度。
 *
 * 本模块刻意**不依赖 stockData / 不用 axios**（原因同 emDataCenter.js：避免循环 require、绕开代理环境变量）。
 */
const { REPORTS, fetchReport } = require('./emDataCenter');

/** 回购报表名（东财回购数据页 /newstatic/js/gphg/list.js 中 hgsjSearchObj.reportName） */
const BUYBACK_REPORT = 'RPTA_WEB_GETHGLIST_NEW';

/**
 * 实施进度码 → 中文（逐字对齐东财前端 switch 分支，勿改写）：
 * list.js 中 case "001"~"006"，default 走「未知」。
 */
const PROGRESS_MAP = {
  '001': '董事会预案',
  '002': '股东大会通过',
  '003': '股东大会否决',
  '004': '实施中',
  '005': '停止实施',
  '006': '完成实施',
};

const CALL_TIMEOUT_NOTE = '东财回购报表';

/**
 * 已结束方案的「历史」阈值（自然日）。20261021i（用户报障「新洋丰根本没有回购行为」）：
 * 000902 最新一档是 **2021-07-23 完成实施**，5 年前的事，却被当成当前回购状态展示，
 * 用户自然认为「它现在根本没在回购」。回购方案本身通常持续 6~12 个月，
 * 结束后 2 年内的信息仍算"近期"，超过 2 年就该明确标成历史、不再作为当前状态。
 */
const HISTORICAL_DAYS = 730;

/** 已结束的进度码（完成/停止/被否决）：这三类都不再产生增量买盘 */
const CLOSED_CODES = ['003', '005', '006'];

/** 距今自然日（dateStr 无效返回 null） */
function daysSince(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return null;
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

/**
 * 回购方案的「信号强度」与「阶段」判定（20260921k 新增，用户 2026-09-21 要求）。
 *
 * 设计原则（为什么这样分）：回购对股价的**利好来源是「未来的买入力量」**——
 * 公司承诺的钱还没花完，才意味着后续仍有持续买盘托底。反之：
 *   · **完成实施**：承诺的钱已花完、买盘结束 → **中性**（这是用户本次明确要求的）；
 *   · **停止实施 / 股东大会否决**：计划落空 → 中性（不能算利好）；
 *   · **董事会预案 / 股东大会通过**：钱还没开始花，最"新鲜" → 最强利好；
 *   · **实施中**：正在花钱、且通常还剩额度 → 利好，力度看进度（越早越强）。
 *
 * 返回值：
 *   signal  ∈ [-1,1] 供 factorHoldings 使用（0 = 中性）
 *   neutral / reason  供文案标注（说明"为何按中性处理"）
 */
function gradeSignal(progressCode, progressPct) {
  const code = String(progressCode || '').trim();
  switch (code) {
    case '001': // 董事会预案：尚未实施，最"新鲜"
      return { signal: 0.9, stage: '预案', neutral: false, reason: '回购方案刚披露、尚未开始实施，后续买入力量最充足' };
    case '002': // 股东大会通过：即将实施
      return { signal: 0.8, stage: '待实施', neutral: false, reason: '回购方案已获股东大会通过、即将实施' };
    case '004': { // 实施中：力度按进度衰减（越早越强），封顶 0.75
      const pct = (typeof progressPct === 'number' && progressPct >= 0) ? progressPct : 0;
      const decay = Math.max(0.2, 1 - pct / 100);
      const signal = Number((0.75 * decay).toFixed(4));
      const nota = pct >= 90 ? '（已接近承诺上限，剩余买入力量有限）' : '';
      return { signal, stage: '实施中', neutral: false, reason: `回购实施中、剩余额度约 ${(100 - pct).toFixed(1)}%${nota}` };
    }
    case '006': {
      // 完成实施：买盘结束 → 中性（用户 2026-09-21 要求）。
      // 20261021i：**不能一律说「承诺买入力量已用尽」**——000902 实测 1.44 亿 / 承诺 3~6 亿（24%）也标「完成实施」，
      // 那是方案到期结束、并未足额买完。钱没花完却宣称"已用尽"，正是用户报障「显示未完成却按完成处理」的观感来源。
      const pct = (typeof progressPct === 'number' && progressPct >= 0) ? progressPct : null;
      if (pct != null && pct < 95) {
        return {
          signal: 0, stage: '已结束（未足额）', neutral: true,
          reason: `回购方案已结束，但实际只回购到承诺上限的 ${pct.toFixed(1)}%（未足额买完），剩余承诺额度不再兑现；买盘已结束，对后续股价不构成增量利好`,
        };
      }
      return { signal: 0, stage: '已完成', neutral: true, reason: '回购已完成实施，承诺买入力量已用尽，对后续股价不再构成增量利好' };
    }
    case '005': // 停止实施：计划落空
      return { signal: 0, stage: '已停止', neutral: true, reason: '回购已停止实施，计划落空，不计入利好' };
    case '003': // 股东大会否决：计划落空
      return { signal: 0, stage: '被否决', neutral: true, reason: '回购方案被股东大会否决，计划落空，不计入利好' };
    default:
      return { signal: 0, stage: '未知', neutral: true, reason: '回购进度未知，按中性处理' };
  }
}

/** 数字解析：把 '1,234.5' / 数值 / 空串统一成 number|null */
function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DD HH:mm:ss' | Date → 'YYYY-MM-DD'（无效返回 ''） */
function ymd(v) {
  if (!v) return '';
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** 数量：股 → 中文可读（万/亿），保留 2 位 */
function fmtShares(v) {
  const n = num(v);
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿股`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万股`;
  return `${n.toFixed(0)}股`;
}

/**
 * 金额：元 → 中文可读（万/亿），保留 2 位。
 * 刻意不用「元」直接展示（本项目回购金额量级普遍在千万~百亿，用户看惯「亿元」）。
 */
function fmtMoney(v) {
  const n = num(v);
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿元`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万元`;
  return `${n.toFixed(0)}元`;
}

/** 元 → 亿（数值，供计算完成率用；不取整，避免比值失真） */
function toYi(v) { const n = num(v); return n == null ? null : n / 1e8; }

/** 该档回购方案的「数据日期」：优先最新公告日，退化到完成日/报告期 */
function recordDate(row) {
  return ymd(row.UPD) || ymd(row.NOTICEDATE) || ymd(row.SHMRSLTNOTICEDATE)
    || ymd(row.FINISHDATE) || ymd(row.DIM_DATE) || '';
}

/** 排序键：公告日 > 报告期（都有则取最大；字符串比较对 'YYYY-MM-DD' 安全） */
function sortKey(row) {
  const a = ymd(row.UPD) || ymd(row.NOTICEDATE);
  const b = ymd(row.DIM_DATE);
  return a > b ? a : b;
}

/**
 * 把一行报表记录规范化为展示所需的四要素（+ 若干辅助字段）。
 * 四要素严格对齐用户要求：数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度。
 */
function normalize(row) {
  const progressCode = String(row.REPURPROGRESS || '').trim();
  const progress = PROGRESS_MAP[progressCode] || (progressCode ? `未知(${progressCode})` : '未知');

  const boughtShares = num(row.REPURNUM);
  const boughtAmount = num(row.REPURAMOUNT);
  const promiseLow = num(row.REPURAMOUNTLOWER);
  const promiseHigh = num(row.REPURAMOUNTLIMIT);
  const priceCap = num(row.REPURPRICECAP);
  const didLow = num(row.REPURPRICELOWER1);
  const didHigh = num(row.REPURPRICECAP1);
  const startDate = ymd(row.REPURSTARTDATE);
  const endDate = ymd(row.REPURENDDATE);
  const finishDate = ymd(row.FINISHDATE);

  // 承诺回购金额：区间（低~高）/ 仅上限 / 仅下限
  let promiseText = '—';
  if (promiseLow != null && promiseHigh != null) {
    promiseText = promiseLow === promiseHigh ? fmtMoney(promiseLow) : `${fmtMoney(promiseLow)}~${fmtMoney(promiseHigh)}`;
  } else if (promiseHigh != null) promiseText = `不超${fmtMoney(promiseHigh)}`;
  else if (promiseLow != null) promiseText = `不低于${fmtMoney(promiseLow)}`;

  // 完成率：已回购金额 / 承诺金额上限（上限是公司承诺的最多投入，最能反映"还剩多少要做"）
  let progressPct = null;
  if (boughtAmount != null && promiseHigh != null && promiseHigh > 0) {
    progressPct = (boughtAmount / promiseHigh) * 100;
  }

  // 20261021i：完结日距今太久 → 标历史（不作为"当前回购状态"）
  const closed = CLOSED_CODES.includes(progressCode);
  const closeDate = finishDate || recordDate(row);
  const ageDays = daysSince(closeDate);
  const historical = closed && ageDays != null && ageDays > HISTORICAL_DAYS;

  return {
    progressCode,
    progress,
    closed,
    closeDate,
    ageDays,
    historical,
    // ① 数据日期
    date: recordDate(row),
    // ② 已回购数量和金额
    boughtShares, boughtAmount,
    boughtSharesText: fmtShares(boughtShares),
    boughtAmountText: fmtMoney(boughtAmount),
    // ③ 承诺回购金额
    promiseLow, promiseHigh, promiseText,
    promiseLowYi: toYi(promiseLow), promiseHighYi: toYi(promiseHigh),
    // ④ 回购进度
    progressPct: progressPct == null ? null : Number(progressPct.toFixed(1)),
    // 信号判定（20260921k）：完成/停止/否决 → 中性；预案/通过/实施中 → 利好（见图 gradeSignal 注释）
    ...(() => { const g = gradeSignal(progressCode, progressPct); return { signal: g.signal, stage: g.stage, neutral: g.neutral, signalReason: g.reason }; })(),
    // 辅助
    priceCap, didLow, didHigh, startDate, endDate, finishDate,
    // 原始行（排查用，前端不展示）
    raw: row,
  };
}

/**
 * 取某只股票**当前（最新一档）**回购方案。
 * @param {string} symbol 股票代码（可带 SH/SZ 前缀，内部归一为 6 位）
 * @returns {Promise<{ok:boolean, reason?:string, plan?:object, plans?:Array<object>}>}
 *   ok=false 且 reason='none'    → 确实没有回购记录（正常情况，按中性处理）
 *   ok=false 且 reason='error'   → 取数失败（网络/报表异常，**不可**当成"无回购"）
 */
async function getBuybackPlan(symbol) {
  const code = String(symbol || '').replace(/^(SH|SZ|BJ)/i, '').trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'error', error: '股票代码非法: ' + symbol };

  let rows;
  try {
    rows = await fetchReport(BUYBACK_REPORT, {
      filter: `(DIM_SCODE="${code}")`,
      pageSize: 50,
      pageNumber: 1,
    });
  } catch (e) {
    return { ok: false, reason: 'error', error: e.message };
  }
  if (!rows.length) return { ok: false, reason: 'none' };

  // 多档方案 → 按公告日/报告期取最新一档，其余保留供参考
  const sorted = rows.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
  const plans = sorted.map(normalize);
  return { ok: true, plan: plans[0], plans };
}

/**
 * 生成「数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度」四要素**字符串**
 * （前端子卡片的 value/detail 用）。严格按用户 2026-09-21 指定的格式与顺序。
 * 刻意返回 string（而非 {value, detail}）——调用方会直接拼进文案，
 * 返回对象极易被误当字符串用而在页面上渲染出 `[object Object]`。
 */
function formatPlan(plan) {
  if (!plan) return '未检索到股份回购记录';
  const parts = [];
  if (plan.historical) parts.push(`历史方案（${plan.closeDate || plan.date} 已完结，与当前回购无关）`);
  if (plan.date) parts.push(`数据日期 ${plan.date}`);
  parts.push(`已回购 ${plan.boughtSharesText}·${plan.boughtAmountText}`);
  parts.push(`承诺回购 ${plan.promiseText}`);
  // 20261021i：进度措辞按"是否足额"分开——
  // 旧写法「完成实施（已达承诺上限 24%）」自相矛盾：已宣布完成，却只花了 24%，
  // 用户读成"没完成却按完成处理"。现在明确区分「足额完成」与「未足额结束」。
  let prog = `进度 ${plan.progress}`;
  if (plan.progressPct != null) {
    if (plan.progressCode === '006' && plan.progressPct < 95) {
      const belowLow = (plan.promiseLow != null && plan.boughtAmount != null && plan.boughtAmount < plan.promiseLow)
        ? `，未达承诺下限 ${plan.promiseLowYi != null ? plan.promiseLowYi.toFixed(2) + '亿元' : ''}` : '';
      prog += `（实际回购为承诺上限的 ${plan.progressPct}%${belowLow}；方案到期结束、未足额买完）`;
    } else {
      prog += `（已达承诺上限的 ${plan.progressPct}%）`;
    }
  }
  parts.push(prog);
  return parts.join('；');
}

module.exports = {
  BUYBACK_REPORT,
  PROGRESS_MAP,
  getBuybackPlan,
  formatPlan,
  gradeSignal,
  fmtShares,
  fmtMoney,
  normalize,
};

~~~

---

## `lib\capitalFlow.js`  ·  1320 行

~~~js
/**
 * Capital Flow & Volume Analysis Module
 * 资金量能分析 — 量价关系、资金流向、量能指标、融资融券
 */
const axios = require('axios');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
// [20261109c] 与 lib/volumeEngine 共用「÷20 日均量」量能判定单一真值源，禁止本地第二套阈值
const { VOL_AMP, VOL_SHRINK, VOL_HUGE, VOL_DRY, isAmpRatio, isShrinkRatio } = require('./volumeCaliber');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 本地小工具（与各消费模块原同名函数逐行等价，保证 20261017a 收敛迁入后数值不变）
const _round = (n, d = 2) => {
  if (n === null || n === undefined || isNaN(n)) return null;
  const p = Math.pow(10, d);
  return Math.round(n * p) / p;
};
const _clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const _avg = (a) => (a && a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/**
 * Fetch URL using curl with forced IPv4 (Eastmoney push2his IPv6 is broken)
 * 改为异步 execFile（不使用 shell），既避免 cmd.exe 括号解析问题，又不阻塞事件循环。
 */
async function fetchWithCurl(url, timeoutMs = 10000) {
  const args = [
    '-4', '-s',
    '--connect-timeout', '5',
    '--max-time', String(Math.floor(timeoutMs / 1000)),
    '-H', 'User-Agent: Mozilla/5.0',
    '-H', 'Referer: https://quote.eastmoney.com/',
    url,
  ];
  try {
    const result = await execFileAsync('curl', args, {
      timeout: timeoutMs + 5000,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    return result.stdout;
  } catch (e) {
    throw new Error(`curl failed: ${e.message}`);
  }
}

/**
 * 获取每日资金流向（主力净流入/流出）
 * Eastmoney push2his fflow daykline API
 * Note: push2/push2his domains block Node.js TLS, so we use curl as fallback
 */
async function fetchDailyMoneyFlow(symbol) {
  const { getEastmoneySecid } = require('./stockData');
  const secid = getEastmoneySecid(symbol);
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?secid=${secid}&lmt=120&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63`;

  // Try axios first (will fail if IPv6 is broken), then fall back to curl with -4
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://quote.eastmoney.com/' },
      timeout: 8000,
    });
    const klines = resp.data?.data?.klines || [];
    if (klines.length > 0) return parseMoneyFlowKlines(klines);
  } catch (e) {
    console.log(`[CapitalFlow] Money flow axios failed: ${e.message}, falling back to curl...`);
  }

  // Fallback: use curl
  try {
    const raw = await fetchWithCurl(url, 10000);
    const data = JSON.parse(raw);
    const klines = data?.data?.klines || [];
    if (klines.length > 0) {
      console.log(`[CapitalFlow] Money flow fetched via curl: ${klines.length} days`);
      return parseMoneyFlowKlines(klines);
    }
  } catch (e) {
    console.error('[CapitalFlow] Money flow curl fallback failed:', e.message);
  }
  return [];
}

function parseMoneyFlowKlines(klines) {
  // Each line: date,mainNet,smallNet,mediumNet,largeNet,superLargeNet,mainPct,smallPct,mediumPct,largePct,superLargePct,closePrice,changePct
  return klines.map(k => {
    const p = k.split(',');
    return {
      date: p[0],
      mainNet: parseFloat(p[1]) || 0,        // 主力净流入(元) = 大单 + 超大单
      smallNet: parseFloat(p[2]) || 0,       // 小单净流入
      mediumNet: parseFloat(p[3]) || 0,      // 中单净流入
      largeNet: parseFloat(p[4]) || 0,       // 大单净流入
      superLargeNet: parseFloat(p[5]) || 0,  // 超大单净流入
      mainPct: parseFloat(p[6]) || 0,
      smallPct: parseFloat(p[7]) || 0,
      mediumPct: parseFloat(p[8]) || 0,
      largePct: parseFloat(p[9]) || 0,
      superLargePct: parseFloat(p[10]) || 0,
    };
  });
}

/**
 * 获取融资融券数据
 * Eastmoney datacenter API — reportName=RPTA_WEB_RZRQ_GGMX (updated 2025)
 * Old report name RPT_RZRQ_RZRQMX is deprecated and returns "报表配置不存在"
 */
async function fetchMarginTrading(symbol) {
  const stockCode = symbol.replace(/^(SH|SZ)/, '');
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_RZRQ_GGMX&columns=ALL&filter=(SCODE=%22${stockCode}%22)&pageSize=60&pageNumber=1&sortColumns=DATE&sortTypes=-1`;

  // 最多 2 次（1 次重试），每次自带硬超时，避免东财不可达时长时间阻塞整条 capital-flow 链路
  const callOnce = () => axios.get(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
    timeout: 4000,
  });
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error('margin-timeout')), ms)),
  ]);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await withTimeout(callOnce(), 4000);
      const data = resp.data?.result?.data;
      if (!data || data.length === 0) return { hasData: false, data: [], degraded: true };

      const marginData = data.map(d => ({
        date: (d.DATE || '').slice(0, 10),
        tradeDate: (d.DATE || '').slice(0, 10),
        rzBalance: parseFloat(d.RZYE) || 0,         // 融资余额(元)
        rzBuy: parseFloat(d.RZMRE) || 0,            // 融资买入额(元)
        rzRepay: parseFloat(d.RZCHE) || 0,          // 融资偿还额(元)
        rzNetBuy: parseFloat(d.RZJME) || 0,         // 融资净买入(元)
        rqBalance: parseFloat(d.RQYE) || 0,         // 融券余额(元)
        rqVolume: parseFloat(d.RQYL) || 0,          // 融券余量(股)
        rqSell: parseFloat(d.RQMCL) || 0,           // 融券卖出量(股)
        rqRepay: parseFloat(d.RQCHL) || 0,          // 融券偿还量(股)
        rzrqBalance: parseFloat(d.RZRQYE) || 0,     // 融资融券余额合计(元)
        rzrqDiff: parseFloat(d.RZRQYECZ) || 0,      // 融资融券余额差值
        rzRatio: parseFloat(d.RZYEZB) || 0,         // 余额占流通市值比(%)
        closePrice: parseFloat(d.SPJ) || 0,         // 收盘价
        changePct: parseFloat(d.ZDF) || 0,          // 涨跌幅(%)
      })).filter(d => d.tradeDate).reverse();

      // Calculate recent trend
      const latest = marginData[marginData.length - 1] || {};
      const prev = marginData[marginData.length - 2] || {};
      const rzChange = latest.rzBalance - prev.rzBalance;
      const rqChange = latest.rqBalance - prev.rqBalance;

      return {
        hasData: true,
        data: marginData,
        latest: {
          rzBalance: latest.rzBalance,
          rzBuy: latest.rzBuy,
          rzNetBuy: latest.rzNetBuy,
          rqBalance: latest.rqBalance,
          rqVolume: latest.rqVolume,
          rzrqBalance: latest.rzrqBalance,
          rzRatio: latest.rzRatio,
          rzChange,
          rqChange,
        },
        trend: rzChange > 0 ? '融资增加' : rzChange < 0 ? '融资减少' : '持平',
      };
    } catch (e) {
      if (attempt < 2) {
        console.log(`[CapitalFlow] Margin trading attempt ${attempt} failed: ${e.message}, retrying...`);
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      console.error('[CapitalFlow] Margin trading failed after 2 attempts:', e.message);
      // 降级返回（不抛异常），analyzeCapitalFlow 仍可用其余维度评分，前端显示"暂无数据"
      return { hasData: false, data: [], error: e.message, degraded: true };
    }
  }
  return { hasData: false, data: [], degraded: true };
}

/**
 * 盘中折算因子：当日K线为今天且处于交易时段内时，按已交易分钟数
 * 把盘中累计量折算为预估全天量（240分钟），避免半日量被误判为缩量。
 * 非今日或已收盘返回 1；开盘半小时内（样本过少）不折算返回 1。
 */
function intradayVolFactor(dateStr) {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  if (dateStr !== today) return 1;
  const t = now.getHours() * 60 + now.getMinutes();
  let traded;
  if (t < 570) traded = 0;                      // 9:30 前
  else if (t <= 690) traded = t - 570;          // 上午 9:30-11:30
  else if (t <= 780) traded = 120;              // 午休 11:30-13:00
  else if (t <= 900) traded = 120 + (t - 780);  // 下午 13:00-15:00
  else traded = 240;                            // 收盘后
  if (traded <= 24) return 1;
  return 240 / traded;
}

/**
 * 计算量能指标
 * OBV (On Balance Volume), VR (Volume Ratio), 换手率趋势
 *
 * 20261017a：本函数是个股侧量能分析的唯一出口（根数据源）。
 * 除原有 OBV/VR/MFI/均量/换手率/当日量价信号外，新增 7 项此前由各消费模块
 * 自行计算的量能指标（latestVsPriorAvg / breakout / vol5Vs20 / shrink3d /
 * turnoverChange / volActivity / volumeProfile），口径与原实现逐行对齐。
 * 其他模块一律改为引用本函数输出，不再各自重算。
 *
 * @param {Array}  history       日线序列（至少 20 根）
 * @param {object} quote         行情快照（取 turnover；可为 null）
 * @param {Array}  turnoverSeries 换手率序列 [{date,turnover,close}]（可为 null）
 * @param {object} opts          { includeProfile: 是否计算 750 日筹码分布（默认 false，
 *                                避免 30 分档膨胀 /api/capital-flow 接口载荷）
 *                                unifiedTier: 统一量能档位（20261017i，来自 lib/volumeEngine.js
 *                                _volumeTier）。传入时「量价信号」与「量能热度」改由该档位推导，
 *                                与「量能分析·资金行为」同源；未传入时保持原本地口径，零副作用 }
 *
 * 20261017i 跨卡一致性修复：此前本函数用「当日量 ÷ 前20日均量」判放量/缩量，
 * heatLevel 又用「近3日均量 ÷ 近20日均量」（分子含在分母里，比值天然压向 1，
 * 几乎恒为「量能平稳」），而量能分析卡（volumeEngine combo）用「当日量 ÷ 5日均量 +
 * 60日均量确认」——三套口径互不校验，实测 20 只样本 14 只出现「缩量/放量/平量」同屏互斥。
 * 现统一引自引擎 volumeTier，三者同源。
 */
function computeVolumeIndicators(history, quote, turnoverSeries, opts = {}) {
  const includeProfile = !!(opts && opts.includeProfile);
  const positionLabel = (opts && opts.positionLabel) || null; // 20261101c：位置感知量价配合
  if (!history || history.length < 20) return null;

  const closes = history.map(d => d.close);
  const volumes = history.map(d => d.volume);
  const amounts = history.map(d => d.amount || 0);
  const dates = history.map(d => d.date);

  // ---- OBV (On Balance Volume) ----
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      obv.push(obv[i - 1] + volumes[i]);
    } else if (closes[i] < closes[i - 1]) {
      obv.push(obv[i - 1] - volumes[i]);
    } else {
      obv.push(obv[i - 1]);
    }
  }

  // ---- VR (Volume Ratio, 26-day) ----
  const vrPeriod = 26;
  const vr = new Array(closes.length).fill(null);
  for (let i = vrPeriod; i < closes.length; i++) {
    let upVol = 0, downVol = 0;
    for (let j = 0; j < vrPeriod; j++) {
      const idx = i - j;
      if (idx <= 0) break;
      if (closes[idx] > closes[idx - 1]) upVol += volumes[idx];
      else if (closes[idx] < closes[idx - 1]) downVol += volumes[idx];
    }
    vr[i] = downVol > 0 ? Math.round(upVol / downVol * 100) : (upVol > 0 ? 500 : 100);
  }

  // ---- MFI (Money Flow Index, 14-day) ----
  const mfiPeriod = 14;
  const mfi = new Array(closes.length).fill(null);
  const typicalPrices = history.map(d => (d.high + d.low + d.close) / 3);
  const moneyFlow = typicalPrices.map((tp, i) => tp * volumes[i]);

  for (let i = mfiPeriod; i < closes.length; i++) {
    let posFlow = 0, negFlow = 0;
    for (let j = 0; j < mfiPeriod; j++) {
      const idx = i - j;
      if (idx <= 0) break;
      if (typicalPrices[idx] > typicalPrices[idx - 1]) posFlow += moneyFlow[idx];
      else if (typicalPrices[idx] < typicalPrices[idx - 1]) negFlow += moneyFlow[idx];
    }
    mfi[i] = negFlow > 0 ? Math.round(100 - 100 / (1 + posFlow / negFlow)) : 100;
  }

  // ---- Volume MA (5日, 10日, 20日均量) ----
  const volMA = (period) => {
    const result = new Array(volumes.length).fill(null);
    for (let i = period - 1; i < volumes.length; i++) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += volumes[i - j];
      result[i] = Math.round(sum / period);
    }
    return result;
  };
  const volMA5 = volMA(5);
  const volMA10 = volMA(10);
  const volMA20 = volMA(20);

  // ---- 量价关系分析 ----
  const recent20 = history.slice(-20);
  let upDays = 0, downDays = 0;
  const upVols = [], downVols = [];
  for (const d of recent20) {
    if (d.close >= d.open) { upDays++; upVols.push(d.volume); }
    else { downDays++; downVols.push(d.volume); }
  }
  // 20260902l 修复：涨/跌日均量改为抗脉冲口径——同侧超过自身中位数 2.5 倍的极端量
  // （如中报日单日 3-4 倍巨量）截尾至 2.5 倍中位数再求均值，避免「一天事件量主导
  // 整个 20 日窗口的量价结论」。截尾只作用于同侧内部离群值，涨/跌两侧正常量级对比不受影响。
  const _medianVol = a => {
    const s = [...a].sort((x, y) => x - y);
    const m = Math.floor(s.length / 2);
    return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : 0;
  };
  const _winsorVol = a => {
    const cap = _medianVol(a) * 2.5;
    return cap > 0 ? a.map(v => Math.min(v, cap)) : a;
  };
  const avgUpVol = upDays > 0 ? _winsorVol(upVols).reduce((s, v) => s + v, 0) / upDays : 0;
  const avgDownVol = downDays > 0 ? _winsorVol(downVols).reduce((s, v) => s + v, 0) / downDays : 0;
  const volumePriceRatio = avgDownVol > 0 ? avgUpVol / avgDownVol : 1;

  // 20日净涨跌（背景参考字段）
  const vpPriceChangePct = recent20.length >= 2
    ? (recent20[recent20.length - 1].close - recent20[0].close) / recent20[0].close * 100
    : 0;

  // ---- 当日量价信号（20260902m：主信号改为当日口径） ----
  // 用户明确要求量价信号反映「当日盘面」而非20日累计统计：当日下跌时显示「量价齐升」
  // 这类20日窗口结论极易被误读。改为：
  //   方向 = 当日涨跌幅（今日收盘 vs 昨收，真实涨跌，避免高开低走/低开高走的阴阳线误判）
  //   量能 = 当日量比（今日量 ÷ 前20日均量，基准不含今日；盘中未收盘按已交易时间折算预估全天量）
  // 20日窗口统计（ratio/upDays/downDays/netChangePct）保留为背景参考字段，供深度分析页展示。
  const lastDay = history[history.length - 1];
  const prevDay = history[history.length - 2] || null;
  const dayChangePct = prevDay ? (lastDay.close - prevDay.close) / prevDay.close * 100 : 0;
  const priorDays = history.slice(-21, -1);
  const priorAvgVol = priorDays.length > 0
    ? priorDays.reduce((s, d) => s + d.volume, 0) / priorDays.length
    : (volumes.length > 1 ? volumes.slice(0, -1).reduce((s, v) => s + v, 0) / (volumes.length - 1) : 0);
  const volFactor = intradayVolFactor(lastDay.date);
  const dayVolRatio = priorAvgVol > 0
    ? Math.round(lastDay.volume * volFactor / priorAvgVol * 100) / 100
    : 1;

  // ---- 20261106j：统一量能档位（跨卡一致性） ----
  // 引擎 volumeTier 是全工作台「放量/缩量」的唯一真值源，分母统一为 ÷20 日均量（与 135 格
  // 推演图 volCell 归格同源：放量 >1.3 / 平量 0.8~1.3 / 缩量 <0.8），彻底消除「135 格判放量、
  // 资金行为判平量」的互斥（典型：威高血净 ÷5 日 1.2 平量 vs ÷20 日 2.63 放量）。
  // 本函数与「量能分析·资金行为 / 今日量价关系判定」改引同源，量价结论不再跨卡互斥。
  // 未传入 unifiedTier（如 lib/analysis.js、lib/priceAction.js 单独调用）时退回原本地
  // 口径，行为与改动前完全一致。
  const ut = (opts && opts.unifiedTier) || null;
  const BUCKET_LABEL = { huge: '显著放量', amp: '明显放量', flat: '平量', shrink: '缩量', dry: '地量' };
  let unifiedVolState = null; // 'huge' | 'amp' | 'flat' | 'shrink' | 'dry'
  if (ut && typeof ut === 'object') {
    if (ut.amplified) unifiedVolState = (typeof ut.ratio20 === 'number' && ut.ratio20 > 2.5) ? 'huge' : 'amp';
    else if (ut.shrunk) unifiedVolState = (typeof ut.ratio20 === 'number' && ut.ratio20 < 0.5) ? 'dry' : 'shrink'; // 20261106j：分母统一 ÷20，dry 边界沿用 0.5
    else unifiedVolState = 'flat';
  }

  const dayChangeStr = `${dayChangePct > 0 ? '+' : ''}${Math.round(dayChangePct * 100) / 100}%`;
  // 统一口径时说明依据（让用户看到档位由何而来），本地口径时保持原文案
  const volNote = unifiedVolState
    ? `当日${dayChangeStr}，量能${BUCKET_LABEL[unifiedVolState]}（当日量 ÷ 20日均量 ${ut.ratio20 !== null && ut.ratio20 !== undefined ? ut.ratio20 : '数据不足'} 倍；20261106n 起 60 日均量口径已退役，全量价判定统一 ÷20）`
    : `当日${dayChangeStr}，量比${dayVolRatio}${volFactor > 1 ? '（盘中折算）' : ''}`;
  // ---- 20261106o：涨跌判定与 135 格走势档同源（用户裁决：除量能外，股价定位/运行状态/涨跌判定
  // 也必须与 135 格一致）。旧 isUp/isDown = ±0.05% 符号二分是旧体系遗留，与 135 格 _walkTier5
  // 五档（大涨≥5 / 上涨≥1.2 / 震荡±1.2 / 下跌 / 大跌）分叉——典型：中国平安 +0.28% 旧判「缩量上涨」
  // 而 135 格第三步判「缩量+震荡」，同屏互斥。现涨跌判定优先消费引擎 posJudgment.price.walk
  // （135 格同一函数产物）；引擎失败降级时用引擎导出的 _walkTierFn 本地复算（同一函数引用，
  // 非第二套阈值）；涨跌幅数据不可得时回退旧 ±0.05% 二分（诚实降级）。
  const pj135 = (opts && opts.posJudgment) || null;
  const walkTierFn = opts && opts.walkTierFn;
  const walkT5 = (pj135 && pj135.price && pj135.price.walk) || (typeof walkTierFn === 'function' ? walkTierFn(dayChangePct) : null);
  const cell135 = pj135 && pj135.cell ? pj135.cell : null;
  const hasWalk = walkT5 !== null && walkT5 !== undefined;
  const isUp = hasWalk ? (walkT5 === '大涨' || walkT5 === '上涨') : dayChangePct > 0.05;
  const isDown = hasWalk ? (walkT5 === '大跌' || walkT5 === '下跌') : dayChangePct < -0.05;
  const isWalkFlat = hasWalk && walkT5 === '震荡';
  // 大涨/大跌文案分档（|涨跌|≥3%）：**保留 3% 不与 135 格大涨档（≥5%）对齐**——两者语义不同：
  // bigUp/bigDown 只是「显著涨跌」的文案分级线（20260921c 圣湘生物用户裁决：≥3% 平量涨 = 量价背离、
  // 判中性「大涨平量」不给正分），不是走势档归格线；涨跌主轴判定已由 walkT5 与 135 格同源（20261106o）。
  const bigUp = dayChangePct >= 3;
  const bigDown = dayChangePct <= -3;

  // 量能档位：优先统一档位，否则退回本地「当日量 ÷ 前20日均量」五档
  // [20261109c] 回退分支阈值同步接入 volumeCaliber（放量 >1.3 / 缩量 <0.8 / 显著放量 2.5 / 地量 0.5），
  // 避免引擎降级时同一屏幕出现「135 格判平量、资金卡判温和放量」的互斥。
  let volBucket;
  if (unifiedVolState) volBucket = unifiedVolState;
  else if (dayVolRatio >= VOL_HUGE) volBucket = 'huge';
  else if (isAmpRatio(dayVolRatio)) volBucket = 'amp';
  else if (!isShrinkRatio(dayVolRatio)) volBucket = 'flat';
  else if (dayVolRatio >= VOL_DRY) volBucket = 'shrink';
  else volBucket = 'dry';

  let volumePriceSignal = '量价平衡';
  let volumePriceDesc = `${volNote}，涨跌幅极小，量价无明显方向`;
  if (isWalkFlat) {
    // 20261106o：震荡档信号与 135 格归格同源——信号名 = 量能档 + 震荡（命名与第三步「量能 × 涨跌幅」
    // 显示一致），描述直接引用 135 格 cell.conclusion（同一格子的归格结论：位置×运行状态×量能×涨跌幅
    // 四维全同源，不再另写一套文案）；cell 不可得（引擎降级）时诚实标注方向不明。
    volumePriceSignal = { huge: '巨量震荡', amp: '放量震荡', flat: '平量震荡', shrink: '缩量震荡', dry: '地量震荡' }[volBucket] || '平量震荡';
    volumePriceDesc = `${volNote}，涨跌幅处震荡档（|涨跌|<1.2%，与 135 格走势档同源），${cell135 && cell135.conclusion ? cell135.conclusion : '方向不明，按震荡观察处理，不臆断方向'}`;
  } else if (isUp) {
    if (volBucket === 'huge') {
      volumePriceSignal = '放量上涨';
      volumePriceDesc = `${volNote}，放量上攻，多头资金积极，量价配合佳`;
    } else if (volBucket === 'amp') {
      volumePriceSignal = '量价齐升';
      volumePriceDesc = `${volNote}，上涨放量，量价配合良好`;
    } else if (volBucket === 'flat') {
      volumePriceSignal = bigUp ? '大涨平量' : '温和上涨'; // 20260921c：大涨而量能未放大（0.8~1.2 平量）=量价背离、上攻乏力，改判中性（原「显著上涨」误给正分）
      volumePriceDesc = bigUp
        ? `${volNote}，大涨但量能仅平量，量价背离、上攻力度与涨幅不匹配，谨防冲高回落`
        : `${volNote}，平量上涨，涨势平稳但动能一般`;
    } else if (volBucket === 'shrink') {
      volumePriceSignal = '缩量上涨';
      volumePriceDesc = `${volNote}，缩量上涨，买盘力度不足，谨防冲高回落`;
    } else {
      volumePriceSignal = '地量上涨';
      volumePriceDesc = `${volNote}，地量上涨，市场参与度极低，持续性存疑`;
    }
  } else if (isDown) {
    // 20261019e：修正量价标签与解释自相矛盾的 bug（海天味业案例：标签「量价齐跌」暗示量缩，
    // 解释却是「下跌放量」）。旧 amp 档标签「量价齐跌」是 20 日窗口时代的遗留词（价跌+20日量能萎缩），
    // 而当日口径下 amp 档 = 价跌且当日量 ÷ 前5日均量 1.3~2.5（量增），标签与解释语义相反 → 统一为「放量下跌」。
    // huge 档同步改名「巨量下跌」，与上涨侧「放量上涨（huge）/量价齐升（amp）」分级对称。
    if (volBucket === 'huge') {
      volumePriceSignal = '巨量下跌';
      volumePriceDesc = `${volNote}，巨量下跌，抛压沉重，注意风险`;
    } else if (volBucket === 'amp') {
      volumePriceSignal = '放量下跌';
      volumePriceDesc = `${volNote}，下跌放量，空头占优，观望为宜`;
    } else if (volBucket === 'flat') {
      volumePriceSignal = bigDown ? '显著下跌' : '温和回调';
      volumePriceDesc = bigDown
        ? `${volNote}，跌幅较大且量能未明显萎缩，抛压真实存在，注意风险`
        : `${volNote}，平量回调，属正常波动`;
    } else if (volBucket === 'shrink') {
      volumePriceSignal = bigDown ? '缩量下跌' : '缩量回调';
      volumePriceDesc = bigDown
        ? `${volNote}，大跌但量能萎缩，恐慌抛售不重、然买盘承接意愿也不足，弱势观望`
        : `${volNote}，缩量回调，抛压有限，观望情绪为主`;
    } else {
      volumePriceSignal = bigDown ? '地量下跌' : '地量回调';
      volumePriceDesc = bigDown
        ? `${volNote}，大跌且地量，交投极度清淡，流动性风险需警惕`
        : `${volNote}，地量回调，交投极度清淡`;
    }
  }

  // 20261101c / 20261106a：位置感知量价配合，位置标签统一为新标准三分区（高位/中位/低位区间）。
  // 旧体系方向键随旧体系整体退役；方向语义由新标准 135 格运行状态承担，
  // 中位区间不设位置方向覆盖（走 VP_POS_BASE 基础分）。描述保留 volNote（当日涨跌+量能档位）上下文。
  const POS_VP_DESC = {
    '高位区间': {
      '放量上涨': `${volNote}，高位区间放量上涨，需警惕主力派发/诱多——价格已处高位却放出大量，筹码向散户转移，量能暴露阶段性逃顶点，量价配合转弱`,
      '量价齐升': `${volNote}，高位区间上涨放量，警惕派发/诱多，量价配合边际转弱`,
      '缩量上涨': `${volNote}，高位区间缩量上涨，买盘后继乏力、上攻动能衰减，见顶前兆特征`,
    },
    '低位区间': {
      '放量上涨': `${volNote}，低位区间放量上涨，属资金真实进场信号，买盘介入可信度高`,
    },
  };
  let positionTone = undefined; // 'bull' | 'bear' | 'warn' | undefined（供前端着色；undefined 时回退静态映射）
  if (positionLabel && POS_VP_DESC[positionLabel] && POS_VP_DESC[positionLabel][volumePriceSignal]) {
    volumePriceDesc = POS_VP_DESC[positionLabel][volumePriceSignal];
    if (positionLabel === '高位区间' && ['放量上涨', '量价齐升', '缩量上涨'].includes(volumePriceSignal)) positionTone = 'warn';
    else if (positionLabel === '低位区间' && ['放量上涨', '量价齐升'].includes(volumePriceSignal)) positionTone = 'bull';
  }

  // ---- 换手率分析（相对月均换手率，避免绝对阈值误判不同活跃度的个股） ----
  const turnover = quote?.turnover || 0;
  const tvSeries = Array.isArray(turnoverSeries)
    ? turnoverSeries.filter(t => t && typeof t.turnover === 'number' && t.turnover > 0)
    : [];
  // 月均换手率：取最近约 22 个交易日（一个月）
  const monthlyTv = tvSeries.slice(-22);
  const turnoverAvg = monthlyTv.length > 0
    ? monthlyTv.reduce((s, t) => s + t.turnover, 0) / monthlyTv.length
    : 0;
  const turnoverRatio = (turnoverAvg > 0 && turnover > 0) ? turnover / turnoverAvg : null;

  let turnoverLevel = '正常';
  if (turnoverRatio !== null) {
    if (turnoverRatio >= 2.0) turnoverLevel = '异常活跃';
    else if (turnoverRatio >= 1.5) turnoverLevel = '高度活跃';
    else if (turnoverRatio >= 0.8) turnoverLevel = '正常';
    else if (turnoverRatio >= 0.5) turnoverLevel = '偏低';
    else turnoverLevel = '低迷';
  } else {
    // 无月均参考（换手率序列缺失）时退回宽松绝对阈值
    if (turnover > 10) turnoverLevel = '异常活跃';
    else if (turnover > 5) turnoverLevel = '高度活跃';
    else if (turnover > 3) turnoverLevel = '活跃';
    else if (turnover > 1) turnoverLevel = '正常';
    else turnoverLevel = '低迷';
  }

  // ---- 近3日/20日成交量对比（量能热度） ----
  // 20260902l 修复：原「近5日均量/近20日均量」口径会被窗口内单日巨量脉冲（如中报日 3-4 倍量）
  // 显著拉高——脉冲发生后连续缩量仍显示「显著放量」，与K线肉眼所见完全相反。
  // 改用近3日均量：单日脉冲权重从 1/5 降至 1/3，且 3 日后即衰减出窗，更贴近当前量能状态；
  // 保留多日平滑（3日）以维持盘中当日K线不完整时的稳定性。
  const tailN = Math.max(1, Math.min(3, volumes.length));
  const last3Vol = volumes.slice(-tailN).reduce((s, v) => s + v, 0) / tailN;
  const last20Vol = volumes.slice(-20).reduce((s, v) => s + v, 0) / 20;
  const volRatio = last20Vol > 0 ? Math.round(last3Vol / last20Vol * 100) / 100 : 0;

  // ---- 量能水平（方向无关：只看交易量多少，用于「资金热度」评分，与股价涨跌无关） ----
  // 20261017i：统一档位优先。原「近3日均量 ÷ 近20日均量」口径有两个结构性缺陷：
  // [20261109c] 回退分支同样接入 volumeCaliber（volRatio = 近3日均量 ÷ 近20日均量，显式标注分母的背景参考）
  //   ① 分子（近3日）本身包含在分母（近20日）内，比值天然被压向 1 → 实测几乎恒为
  //      「量能平稳」，与同卡「量价信号」频繁互斥（20 只样本 10 只）；
  //   ② 与量能分析卡（÷5日均量）分母不同 → 跨卡互斥（20 只样本 11 只）。
  // 现与 volumePriceSignal 共用同一个 unifiedVolState，同卡与跨卡双重一致。
  // volRatio 仍按原口径保留输出（背景参考字段，其他消费方与历史行为不变）。
  const HEAT_BY_BUCKET = { huge: '显著放量', amp: '温和放量', flat: '量能平稳', shrink: '缩量', dry: '地量' };
  let heatLevel;
  if (unifiedVolState) heatLevel = HEAT_BY_BUCKET[unifiedVolState];
  else if (volRatio >= VOL_HUGE) heatLevel = '显著放量';
  else if (isAmpRatio(volRatio)) heatLevel = '温和放量';
  else if (!isShrinkRatio(volRatio)) heatLevel = '量能平稳';
  else if (volRatio >= VOL_DRY) heatLevel = '缩量';
  else heatLevel = '地量';

  // ---- 最新指标值 ----
  const lastIdx = closes.length - 1;
  const latestOBV = obv[lastIdx];
  const latestVR = vr[lastIdx];
  const latestMFI = mfi[lastIdx];

  // OBV趋势判断
  const obvMA5 = obv.slice(-5).reduce((s, v) => s + v, 0) / 5;
  const obvMA20 = obv.slice(-20).reduce((s, v) => s + v, 0) / 20;
  let obvTrend = '中性';
  if (latestOBV > obvMA5 && obvMA5 > obvMA20) obvTrend = '上升趋势';
  else if (latestOBV < obvMA5 && obvMA5 < obvMA20) obvTrend = '下降趋势';

  // VR判断
  let vrSignal = '中性';
  if (latestVR !== null) {
    if (latestVR > 200) vrSignal = '多头资金占优';
    else if (latestVR > 120) vrSignal = '偏多';
    else if (latestVR < 70) vrSignal = '空头资金占优';
    else if (latestVR < 80) vrSignal = '偏空';
  }

  // MFI判断
  let mfiSignal = '中性';
  if (latestMFI !== null) {
    if (latestMFI > 80) mfiSignal = '超买';
    else if (latestMFI > 50) mfiSignal = '资金流入';
    else if (latestMFI < 20) mfiSignal = '超卖';
    else if (latestMFI < 40) mfiSignal = '资金流出';
  }

  // ============ 量能根指标（20261017a：个股侧量能唯一出口） ============
  // 以下 7 项原由各消费模块自行计算，按「单一权威源」规则收敛迁入本模块，
  // 口径与原实现逐行对齐（数据不变则结论不变）：
  //   latestVsPriorAvg  原 lib/analysis.js:356-369        analyzeVolume
  //   breakout          原 lib/priceAction.js:369-377     （20日高低点突破量比与形态判定）
  //   vol5Vs20          原 lib/priceAction.js:479-481
  //   shrink3d          原 lib/priceAction.js:596-601     （空心化上涨证伪）
  //   turnoverChange    原 lib/sameDayJudgment.js:184-211 _computeTurnoverChange
  //   volActivity       原 lib/sameDayJudgment.js:352-370 （量能活跃度子信号）
  //   volumeProfile     原 lib/priceAction.js:293-328     calcVolumeProfile（opt-in）

  // ① 最新量 ÷ 前 20 日均量（20 日窗口内，基准不含最新日）+ 四档趋势
  // [20261105h] 修正历史笔误：原 slice(-20,-1) 实际只取前 19 日均量，改为 slice(-21,-1) 取满前 20 日。
  const priorWin = history.slice(-21, -1);
  const prior20Avg = priorWin.length > 0 ? priorWin.reduce((s, d) => s + (d.volume || 0), 0) / priorWin.length : 0;
  const latestVol = volumes[lastIdx];
  // [20261109c] 判定用未取整的原始量比，展示仍保留 2 位小数：
  // 若用四舍五入后的值判定，1.301 会显示为 1.30 并判「平量」，而 135 格用原值判「放量」→ 同屏互斥。
  const latestRatioRaw = prior20Avg > 0 ? latestVol / prior20Avg : 0;
  const latestVsPriorAvg = {
    ratio: prior20Avg > 0 ? Math.round(latestRatioRaw * 100) / 100 : 0,
    priorAvgVol: prior20Avg,
    trend: 'normal',
  };
  // [20261109c] 阈值接入 lib/volumeCaliber 单一真值源（÷20 日均量：放量 >1.3 / 缩量 <0.8）。
  // 20261024c 曾用 1.2/0.8，与 135 格主判在 1.2~1.3 区间产生同屏互斥；现统一到 >1.3。
  if (latestRatioRaw > 2) latestVsPriorAvg.trend = '放量';
  else if (isAmpRatio(latestRatioRaw)) latestVsPriorAvg.trend = '温和放量';
  else if (isShrinkRatio(latestRatioRaw)) latestVsPriorAvg.trend = '缩量';

  // ② 突破量比与形态（基准 = 前 20 个交易日，不含最新日）
  const prior20 = history.slice(-21, -1);
  const prior20Vol = prior20.length > 0 ? prior20.reduce((s, d) => s + (d.volume || 0), 0) / prior20.length : 0;
  const breakoutRatioRaw = prior20Vol > 0 ? latestVol / prior20Vol : null;
  const breakoutVolRatio = breakoutRatioRaw !== null ? Math.round(breakoutRatioRaw * 100) / 100 : null;
  const prior20High = prior20.length > 0 ? Math.max(...prior20.map(d => d.high)) : null;
  const prior20Low = prior20.length > 0 ? Math.min(...prior20.map(d => d.low)) : null;
  const lastCloseVal = closes[lastIdx];
  let breakoutPattern = '无显著形态';
  // [20261109c] 突破放量阈值接入单一真值源（÷20 日均量 >1.3）；旧 1.2 与 135 格主判分叉。
  // 注：zoneValidity/zoneReversal 的 BREAK_VOL_MIN=1.2 是「÷前5日均量」的箱体有效性专用判据，
  //     分母不同、且页面显式标注，属原始指标口径，不参与 ÷20 量价判定，故不在此对齐。
  if (prior20High && lastCloseVal > prior20High && isAmpRatio(breakoutRatioRaw)) breakoutPattern = '放量突破前高';
  else if (prior20Low && lastCloseVal < prior20Low && isAmpRatio(breakoutRatioRaw)) breakoutPattern = '放量跌破前低';
  else if (prior20High && lastCloseVal > prior20High && isShrinkRatio(breakoutRatioRaw)) breakoutPattern = '缩量新高';
  const breakout = { volRatio: breakoutVolRatio, high20: prior20High, low20: prior20Low, pattern: breakoutPattern };

  // ③ 5 日均量 ÷ 20 日均量（均含最新日）。注意：不做四舍五入——
  // 原 lib/priceAction.js:481 即为未取整原值，且该值直接参与 <0.9 / <0.8 阈值比较，
  // 取整可能让边界样本翻转判定，故逐行保持原口径。
  const vol5Win = volumes.slice(-5);
  const vol20Win = volumes.slice(-20);
  const avgVol5 = vol5Win.reduce((s, v) => s + v, 0) / 5;
  const avgVol20 = vol20Win.reduce((s, v) => s + v, 0) / 20;
  const vol5Vs20 = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;

  // ④ 空心化上涨证伪：近 3 日连续收涨且成交量连续 2 日递减
  let shrink3d = false;
  if (lastIdx >= 3) {
    shrink3d = closes[lastIdx] > closes[lastIdx - 1] && closes[lastIdx - 1] > closes[lastIdx - 2] && closes[lastIdx - 2] > closes[lastIdx - 3]
      && volumes[lastIdx] < volumes[lastIdx - 1] && volumes[lastIdx - 1] < volumes[lastIdx - 2];
  }

  // ⑤ 换手率变化：最近一日 vs 前 (N-5) 日均值偏离 × 近两日价格方向
  const turnoverChange = computeTurnoverChangeShared(turnoverSeries);

  // ⑥ 量能活跃度：近 20 日均量比 × 近两日价格方向
  let volActivity = null;
  {
    const last = history[history.length - 1];
    const vols20 = history.slice(-20).map(h => h.volume).filter(v => typeof v === 'number' && v > 0);
    if (vols20.length >= 5 && last.volume != null) {
      const avgVol = _avg(vols20);
      const ratio = avgVol > 0 ? last.volume / avgVol : 1;
      const prevClose = history[history.length - 2] ? history[history.length - 2].close : null;
      const priceDir = (prevClose != null && last.close != null) ? (last.close - prevClose) : 0;
      const volDir = ratio >= 1 ? 1 : -0.5;
      const signal = _clamp(Math.abs(ratio - 1) * (priceDir >= 0 ? 1 : -1) * volDir, -1, 1);
      const volTxt = ratio >= 1.05 ? '放量' : ratio <= 0.95 ? '缩量' : '量平';
      const toneTxt = signal > 0.05 ? '偏多' : signal < -0.05 ? '偏空' : '中性';
      volActivity = { signal, ratio, avgVol, lastVol: last.volume, priceDir, volTxt, toneTxt };
    }
  }

  return {
    indicators: {
      obv: latestOBV,
      obvTrend,
      vr: latestVR,
      vrSignal,
      mfi: latestMFI,
      mfiSignal,
      volMA5: volMA5[lastIdx],
      volMA10: volMA10[lastIdx],
      volMA20: volMA20[lastIdx],
      volRatio,
      turnover,
      turnoverLevel,
      turnoverAvg: turnoverAvg > 0 ? Math.round(turnoverAvg * 100) / 100 : 0,
      turnoverRatio: turnoverRatio !== null ? Math.round(turnoverRatio * 100) / 100 : null,
      // 20261017a 量能根指标（收敛迁入，详见函数头注释）
      latestVsPriorAvg,
      breakout,
      vol5Vs20,
      shrink3d,
      turnoverChange,
      volActivity,
    },
    volumePrice: {
      // 主信号（当日口径）
      signal: volumePriceSignal,
      description: volumePriceDesc,
      // 20261101c：位置感知着色提示（'bull'/'bear'/'warn'），前端据此覆盖静态颜色映射
      positionTone,
      dayChangePct: Math.round(dayChangePct * 100) / 100,
      dayVolRatio,
      // 20日背景参考
      ratio: Math.round(volumePriceRatio * 100) / 100,
      netChangePct: Math.round(vpPriceChangePct * 100) / 100,
      upDays,
      downDays,
      avgUpVol: Math.round(avgUpVol),
      avgDownVol: Math.round(avgDownVol),
      heatLevel,
      // 20261017i：统一量能档位回执（跨卡一致性）。接入引擎时非 null，前端据此展示
      // 口径来源并优先显示 ratio5；未接入时为 null，前端退回既有 dayVolRatio 展示。
      // 纯新增字段，既有消费方零影响。
      unified: ut ? {
        tier: ut.tier,
        bucket: unifiedVolState,
        ratio5: ut.ratio5 !== undefined ? ut.ratio5 : null,
        ratio20: ut.ratio20 !== undefined ? ut.ratio20 : null,
        basis: ut.basis,
        consistent: ut.consistent === undefined ? null : ut.consistent,
        divergenceNote: ut.divergenceNote || null,
      } : null,
    },
    series: {
      dates: dates.slice(-60),
      obv: obv.slice(-60),
      vr: vr.slice(-60),
      mfi: mfi.slice(-60),
      volumes: volumes.slice(-60),
      volMA5: volMA5.slice(-60),
      volMA10: volMA10.slice(-60),
      volMA20: volMA20.slice(-60),
      // [20261109d] 每日20日量能比序列（纯新增字段，既有消费方零改动）：
      //   当日成交量 ÷ 前20日均量（不含当日），与判定层 ratio20（lib/volumeCaliber.js / volumeEngine.avgOf(20)）同源。
      //   用完整 history 计算后 slice(-60)，避免前端只用 60 根 K 线导致前 20 天空窗；基准不足 → null（不臆造）。
      ratio20Series: (() => {
        const out = [];
        for (let i = 0; i < volumes.length; i++) {
          if (i < 20) { out.push(null); continue; }
          let sum = 0, ok = true;
          for (let k = i - 20; k < i; k++) {
            const p = volumes[k];
            if (!(p > 0)) { ok = false; break; }
            sum += p;
          }
          if (!ok || !(sum > 0)) { out.push(null); continue; }
          out.push(Math.round((volumes[i] / (sum / 20)) * 100) / 100);
        }
        return out.slice(-60);
      })(),
    },
    // 750 日筹码分布仅按需计算（opt-in）：分档 30 个，默认关闭以免膨胀接口载荷
    volumeProfile: includeProfile ? calcVolumeProfileShared(history, 750) : undefined,
  };
}

/**
 * 换手率变化（20261017a 自 lib/sameDayJudgment.js:184-211 _computeTurnoverChange 原样迁入）
 * 取最近 ~60 日换手率序列，以前 (N-5) 个交易日均值为基准，最新值相对基准的偏离，
 * 结合近两日价格方向加权（量价配合：放量上涨偏多、放量下跌偏空；缩量反向且强度减半）。
 * 返回 { ok, signal, detail } —— 数据不足时 ok:false，由上层按中性处理。
 */
function computeTurnoverChangeShared(series) {
  if (!Array.isArray(series) || series.length < 20) {
    return { ok: false, signal: 0, detail: '换手率数据不足（<20日），按中性处理' };
  }
  const base = series.slice(0, -5);
  const baseline = _avg(base.map(s => s.turnover));
  const tail = series.slice(-5);
  const latest = tail[tail.length - 1].turnover;
  if (!(baseline > 0)) return { ok: false, signal: 0, detail: '换手率基准为0，按中性处理' };
  const ratio = latest / baseline;
  const lastClose = series[series.length - 1].close;
  const prevClose = series[series.length - 2].close;
  const priceDir = (typeof lastClose === 'number' && typeof prevClose === 'number' && prevClose > 0)
    ? (lastClose - prevClose >= 0 ? 1 : -1) : 0;
  const dev = _clamp(Math.abs(ratio - 1) * 1.2, 0, 1.2);
  const volDir = ratio >= 1 ? 1 : -0.5;
  const signal = _clamp(dev * priceDir * volDir, -1, 1);
  const dirTxt = priceDir > 0 ? '价涨' : priceDir < 0 ? '价跌' : '价平';
  const volTxt = ratio >= 1.05 ? '放量' : ratio <= 0.95 ? '缩量' : '量平';
  const tone = signal > 0.05 ? '偏多' : signal < -0.05 ? '偏空' : '中性';
  // 20261017a：原 detail 文案写「近15日均值」，但代码基准为前 (N-5) 个交易日（60 日序列即前 55 日），
  // 文案与实现不符。此处按实际口径改为「基准均值」，计算逻辑不变。
  const detail = `最新换手率 ${_round(latest, 2)}%，基准均值 ${_round(baseline, 2)}%（偏离 ${(ratio >= 1 ? '+' : '') + _round((ratio - 1) * 100, 1)}%），近两日${dirTxt}·${volTxt} → ${tone}`;
  return { ok: true, signal, detail };
}

/**
 * 长期筹码密集区：价格分档成交量分布（20261017a 自 lib/priceAction.js:293-328 calcVolumeProfile 原样迁入）
 * @param {Array}  daily    日线序列
 * @param {number} lookback 回溯交易日数，默认 750（约 3 年）
 */
function calcVolumeProfileShared(daily, lookback = 750) {
  const recent = daily.slice(-lookback);
  if (recent.length < 60) return null;
  const close = recent[recent.length - 1].close;
  const lo = Math.min(...recent.map(d => d.low));
  const hi = Math.max(...recent.map(d => d.high));
  if (!(hi > lo)) return null;
  const N = 30;
  const step = (hi - lo) / N;
  const bins = Array.from({ length: N }, (_, i) => ({ low: _round(lo + i * step), high: _round(lo + (i + 1) * step), vol: 0 }));
  let total = 0;
  for (const d of recent) {
    const tp = (d.high + d.low + d.close) / 3;
    const idx = Math.min(N - 1, Math.max(0, Math.floor((tp - lo) / step)));
    bins[idx].vol += d.volume || 0;
    total += d.volume || 0;
  }
  bins.forEach(b => { b.pct = total > 0 ? _round((b.vol / total) * 100, 2) : 0; });

  const aboveVols = bins.filter(b => b.low >= close);
  const abovePct = _round(aboveVols.reduce((s, b) => s + b.pct, 0), 2);

  // 上方最大密集区（阻力带）与下方最大密集区（支撑带）
  let resistance = null, support = null;
  for (const b of bins) {
    if (b.low >= close && (!resistance || b.vol > resistance.vol)) resistance = b;
    if (b.high <= close && (!support || b.vol > support.vol)) support = b;
  }
  return {
    bins,
    currentPrice: close,
    abovePct,
    belowPct: _round(100 - abovePct, 2),
    resistance: resistance ? { low: resistance.low, high: resistance.high, pct: resistance.pct } : null,
    support: support ? { low: support.low, high: support.high, pct: support.pct } : null,
  };
}

/**
 * 基于K线数据估算资金流向（当 push2his API 不可用时的回退方案）
 * 使用量价关系推算主力/大中小单的净流向
 */
function estimateMoneyFlowFromHistory(history) {
  if (!history || history.length < 2) return [];

  return history.map((d, i) => {
    if (i === 0) {
      return {
        date: d.date,
        mainNet: 0, smallNet: 0, mediumNet: 0, largeNet: 0, superLargeNet: 0,
        mainPct: 0, smallPct: 0, mediumPct: 0, largePct: 0, superLargePct: 0,
        estimated: true,
      };
    }
    const prev = history[i - 1];
    const turnover = (d.amount || d.close * d.volume) || 0;
    const range = Math.max(d.high - d.low, 0.01);
    // 方向因子：正表示买方主导，负表示卖方主导
    const direction = Math.max(-1, Math.min(1, (d.close - prev.close) / range));

    // 估算净流向：方向 × 成交额 × 主力占比
    const netFlow = direction * turnover;
    const mainNet = Math.round(netFlow * 0.55);      // 主力(超大单+大单)约占55%
    const superLargeNet = Math.round(netFlow * 0.35);  // 超大单约35%
    const largeNet = Math.round(netFlow * 0.20);       // 大单约20%
    const mediumNet = Math.round(-netFlow * 0.30);     // 中单反向约30%
    const smallNet = Math.round(-netFlow * 0.25);      // 小单反向约25%

    return {
      date: d.date,
      mainNet, smallNet, mediumNet, largeNet, superLargeNet,
      mainPct: turnover > 0 ? Math.round(mainNet / turnover * 10000) / 100 : 0,
      smallPct: turnover > 0 ? Math.round(smallNet / turnover * 10000) / 100 : 0,
      mediumPct: turnover > 0 ? Math.round(mediumNet / turnover * 10000) / 100 : 0,
      largePct: turnover > 0 ? Math.round(largeNet / turnover * 10000) / 100 : 0,
      superLargePct: turnover > 0 ? Math.round(superLargeNet / turnover * 10000) / 100 : 0,
      estimated: true,
    };
  });
}

/**
 * 剔除引擎内部字段 bars（20261017i）
 * bars 仅用于本模块与量能卡复用同一份日K，不下发前端（250+ 根日K会显著膨胀接口载荷）。
 */
function stripEngineBars(ve) {
  if (!ve || typeof ve !== 'object') return ve;
  const out = { ...ve };
  delete out.bars;
  return out;
}

// 日K通道 volume 单位 → 「手」的换算系数（20261017i 建，20261021h 修正）
// 20261021h：实测（成交额反验）**东财日K也是「手」**，旧表把东财当「股」→ 每条量都除以 100。
// 比值型指标不受影响（分子分母同除），但绝对量（avgVol/lastVol）会小 100 倍，属用户可感知的「小数点错」。
// 单位单一来源已收敛到 lib/volUnit.js，这里只取除数。
const { toLotDivisor } = require('./volUnit');
const VOLUME_TO_LOT = { eastmoney: toLotDivisor('eastmoney'), ths: toLotDivisor('ths'), tencent: toLotDivisor('tencent') };

/**
 * 主函数：资金量能分析
 */
async function analyzeCapitalFlow(symbol, name, quote, history) {
  console.log(`[CapitalFlow] Starting for ${symbol}...`);

  // 并行获取资金流向、融资融券、换手率序列（换手率序列用于「换手率相对月均」的参考基准）
  const { getEastmoneyTurnover } = require('./stockData');
  // 20261017f：量能分析引擎（spec 十三步链路 + 7.4/7.5/11.2-11.4 归集总结，lib/volumeEngine.js）。
  // 与 lib/analysis.js 的同名 analyzeVolume（量能指标 trend/ratio 委托）是不同的职责，别名导入避免遮蔽。
  const { analyzeVolume: analyzeVolumeEngine, _walkTier5 } = require('./volumeEngine');
  const [moneyFlow, margin, turnoverSeries, volumeEngine] = await Promise.all([
    fetchDailyMoneyFlow(symbol),
    fetchMarginTrading(symbol),
    getEastmoneyTurnover(symbol, 60).catch(() => []),
    // 引擎内部已按通道降级（日K三级链：东财多主机 push2his→push2 → 腾讯日K仅OHLCV；
    // 腾讯分时/公告各自 catch 并如实标注）；
    // 此处整体 catch 只作为最后防线——失败置 null，绝不阻塞资金量能主链路，也不伪造数据。
    // 20261022d：量能引擎「放量破位」的支撑位改为引用②卡「短期动向预判」的有效区间，避免两套口径。
    // 个股页②卡通常已预热同一 symbol 的快照缓存，此处多为缓存命中；任何失败一律降级为引擎自身 _keyLevels。
    (async () => {
      let levelHints = null;
      try {
        const { getPriceActionSnapshot } = require('./priceActionHub');
        const { deriveLevelHints } = require('./zoneLevelsHint');
        // 快照通常已由②卡预热（缓存命中）；给它最多 6s，超时即放弃→引擎自算，绝不让它拖垮 15s 总预算。
        const snap = await Promise.race([
          getPriceActionSnapshot(symbol).catch(() => null),
          new Promise(resolve => setTimeout(() => resolve(null), 6000)),
        ]);
        levelHints = deriveLevelHints(snap && snap.shortTerm, quote && quote.price);
      } catch (e) {
        console.warn('[CapitalFlow] 读取短期动向区间失败（支撑位降级为引擎自算）:', e && e.message ? e.message : e);
      }
      return analyzeVolumeEngine(symbol, name, quote, { levelHints }).catch(e => {
        console.warn('[CapitalFlow] volumeEngine failed:', e.message);
        return null;
      });
    })(),
  ]);

  // 20261101c：位置标签（引擎已算出，供量价配合位置感知）。引擎失败/降级时为 null，
  // 此时量价配合回退无位置口径（与改动前行为一致，不引入假位置）。
  const posLabel = (volumeEngine && volumeEngine.position && volumeEngine.position.label) || null;

  // ---- 20261017i：数据源统一 + 统一量能档位 ----
  // 数据源：此前「量价分析」用路由传入的 getHistory() 日K，「量能分析」用引擎四级降级链
  // 自拉，两条通道可能停在不同交易日 → 连「今日」定格在哪根 K 线都可能不同。
  // 现量价指标改用引擎已拉到的同一份日K（字段更全：含成交额/换手率），两卡彻底同源。
  // 降级保护：引擎失败 / bars 不足 20 根时自动退回原 history，行为与改动前一致。
  let viHistory = history;
  let unifiedTier = null;
  if (volumeEngine && volumeEngine.ok !== false && Array.isArray(volumeEngine.bars)
      && volumeEngine.bars.length >= 20 && volumeEngine.volumeTier) {
    const div = VOLUME_TO_LOT[volumeEngine.barsSource] || 1;
    viHistory = div !== 1
      ? volumeEngine.bars.map(b => ({ ...b, volume: b.volume / div }))
      : volumeEngine.bars;
    unifiedTier = volumeEngine.volumeTier;
  }

  // 计算量能指标（传入换手率序列；统一档位存在时一并传入，使三处结论同源）
  // 20261106o：涨跌判定同源接线——posJudgment（135 格主判产物：price.walk 走势档 + cell 归格结论）
  // 与 _walkTier5（引擎导出的同一走势档函数，供引擎失败降级时本地复算）一并传入，
  // 使「今日量价关系判定（唯一结论）」的涨跌判定与 135 格第三步同源（用户裁决）。
  const pj135 = (volumeEngine && volumeEngine.posJudgment) || null;
  const viopts = { positionLabel: posLabel };
  if (unifiedTier) viopts.unifiedTier = unifiedTier;
  if (pj135) viopts.posJudgment = pj135;
  viopts.walkTierFn = _walkTier5;
  let volumeIndicators = computeVolumeIndicators(viHistory, quote, turnoverSeries, viopts);
  // 20261024i：量价指标双源兜底——原实现只走单一来源，个别个股若该来源 <20 根（引擎缺 volumeTier
  // 时退回的路由 history 可能过短/失败）→ 量价整块空白。此处若首选来源算不出，改用另一来源
  // （引擎 bars ↔ 路由 history），只要 ≥20 根即可计算，从根上避免「个别个股量价失效」。
  if (!volumeIndicators) {
    let alt = null;
    if (viHistory === history) {
      if (volumeEngine && Array.isArray(volumeEngine.bars) && volumeEngine.bars.length >= 20) {
        const div = VOLUME_TO_LOT[volumeEngine.barsSource] || 1;
        alt = div !== 1 ? volumeEngine.bars.map(b => ({ ...b, volume: b.volume / div })) : volumeEngine.bars;
      }
    } else {
      alt = history;
    }
    if (Array.isArray(alt) && alt.length >= 20) {
      volumeIndicators = computeVolumeIndicators(alt, quote, turnoverSeries, viopts);
    }
  }

  // 资金流向：API失败时使用估算数据
  let flowData = moneyFlow;
  let flowSource = 'api';
  if (!flowData || flowData.length === 0) {
    console.log('[CapitalFlow] API data unavailable, using estimated money flow from K-line data');
    flowData = estimateMoneyFlowFromHistory(history);
    flowSource = 'estimated';
  }

  // 汇总资金流向近N日数据
  const flowSummary = summarizeMoneyFlow(flowData);

  // 流通市值（亿元）：腾讯 circulationValue/totalValue 为"<100按万亿、≥100按亿"混编，统一转亿元
  const capRaw = (quote && (quote.circulationValue || quote.totalValue)) || 0;
  const floatMarketCapYi = capRaw > 0 ? (capRaw < 100 ? capRaw * 1e4 : capRaw) : 0;

  // 统一资金量能结论：与前端 capitalCharts.calculateScore / renderConclusion 完全同口径
  // 后端算一次，判断引擎因子与个股分析页共用，保证跨页面一致。
  const conclusion = computeCapitalConclusion({
    volumeIndicators,
    moneyFlow: { summary: flowSummary, source: flowSource },
    marginTrading: margin,
    floatMarketCapYi,
    positionLabel: posLabel, // 20261101c：位置感知量价配合
  });

  return {
    symbol,
    name,
    moneyFlow: {
      daily: flowData.slice(-60),
      summary: flowSummary,
      source: flowSource,
    },
    marginTrading: margin,
    volumeIndicators,
    conclusion,
    floatMarketCapYi,
    // 20261017e：量能分析引擎结构化结果（spec：位置判定/量价三问/背离/五大生死位/
    // 位置×量能组合/连续序列/打分/流动性衰减/信号分类/四维度描述；
    // barsSource 标注日K实际通道（eastmoney/tencent），降级时附数据不足说明）。
    // 纯新增字段：既有消费方（moneyFlow/marginTrading/volumeIndicators/conclusion/rules）零改动；
    // 新增渲染方见前端 renderVolumeEngine（个股页资金量能 tab 内「量能分析」卡）。
    // 20261017i：剔除内部字段 bars（仅供本模块复用，不下发前端）。
    volumeEngine: stripEngineBars(volumeEngine),
    // 三规则铺开：时效体检 + 资金净额的变化与边际分析
    // flowSource==='estimated' 时为「基于K线量价估算」，非实际资金流披露值，
    // 按规则二须在来源中如实标注，不得冒充真实数据。
    rules: decorateCapitalRules(flowData, flowSource, history),
  };
}

/**
 * 资金模块三规则装饰器：时效（日频）+ 主力净额的变化与边际
 */
function decorateCapitalRules(flowData, flowSource, history) {
  const core = require('./ruleCore');
  const srcLabel = flowSource === 'estimated'
    ? '东方财富资金流向(API不可用，回退为K线量价估算)'
    : '东方财富资金流向';
  const series = (flowData || [])
    .filter(d => d && d.date)
    .map(d => ({
      date: d.date,
      // 原始单位为「元」，数值极大不利于阅读与比较，统一折算为「亿元」；
      // 仅用于变化与边际分析展示，不改变原始字段口径。
      value: Number(
        d.mainNet != null ? d.mainNet
          : (d.mainNetInflow != null ? d.mainNetInflow : d.netInflow)
      ) / 1e8,
    }))
    .filter(d => isFinite(d.value))
    .slice(-30);
  const lastDate = series.length
    ? series[series.length - 1].date
    : ((history && history.length) ? history[history.length - 1].date : null);
  return core.decorateRules({
    dataTime: lastDate,
    source: srcLabel,
    kind: 'daily',
    series,
    name: '主力净流入(亿元)',
    // 资金净流入可为负（净流出），必须放开负值过滤，否则负值被丢弃导致变化率算错
    allowNegative: true,
  });
}

/**
 * 统一资金量能结论（后端单一数据源）
 * 评分/标签口径与前端 capitalCharts.calculateScore、renderConclusion 完全一致：
 *   量能(交易量,±) + 短期/中期资金流向(±) + 量能指标(OBV/VR ±) + 融资融券(±) + 换手率(相对月均,±)
 * 输出 signal(-1..1，供判断引擎因子)、score(0-100，供评分卡)、label(综合判断文本)、
 * bullScore/bearScore(多空打分)、reasons(评分追溯)、grade(等级)。
 */

/**
 * 按"主力净额占流通市值比"给分（解决"同样金额对大小市值股影响不同"的问题）
 * @param {number} ratioPct 主力净额占流通市值百分比（正=净流入，负=净流出）
 * @param {number} maxUp 该周期满分（5日=15，20日=10）
 * @returns {number} 已含方向符号的得分
 */
function flowScoreByRatio(ratioPct, maxUp) {
  const mag = Math.abs(ratioPct);
  let base;
  if (mag > 0.5) base = maxUp;
  else if (mag > 0.2) base = Math.round(maxUp * 0.66);
  else if (mag > 0) base = Math.round(maxUp * 0.33);
  else base = 0;
  return ratioPct >= 0 ? base : -base;
}

// 20261101c：位置感知量价配合方向（[-1,1]，单一真值源）
// 与 lib/volumeEngine.js 量价框架相互印证，修正「量价配合不区分位置」矛盾：
//   · 高位放量上涨 = 主力派发/诱多（风险，转空）
//   · 中位区间：不设方向覆盖，回退基础量价方向（20261106a 旧「上涨途中缩量上涨转多」随旧体系退役）
//   · 低位放量上涨 = 资金真实进场（强化看多）
// 无位置或位置未匹配时回退基础量价方向（与旧 VP_MAP/20、sameDayJudgment vpSigMap 逐值对齐，非位置场景分值不变）。
const VP_POS_BASE = {
  '放量上涨': 0.6, '量价齐升': 0.45, '大涨平量': 0, '温和上涨': 0.2, '缩量上涨': -0.25, '地量上涨': -0.15,
  '巨量下跌': -0.6, '放量下跌': -0.45, '显著下跌': -0.4, '缩量下跌': -0.2, '地量下跌': -0.25,
  '温和回调': -0.2, '缩量回调': 0.15, '地量回调': -0.05, '量价平衡': 0,
  // 20261106o：震荡档（与 135 格走势档「震荡=观察」同源）——五档量能 × 震荡一律中性 0
  '巨量震荡': 0, '放量震荡': 0, '平量震荡': 0, '缩量震荡': 0, '地量震荡': 0,
};
const VP_POS_OVERRIDE = {
  '高位区间': { '放量上涨': -0.6, '量价齐升': -0.5, '缩量上涨': -0.4 },
  '低位区间': { '放量上涨': 0.7, '量价齐升': 0.6 },
};
function vpPositionSignal(signal, positionLabel) {
  if (positionLabel && VP_POS_OVERRIDE[positionLabel] && VP_POS_OVERRIDE[positionLabel][signal] != null) {
    return VP_POS_OVERRIDE[positionLabel][signal];
  }
  return VP_POS_BASE[signal] != null ? VP_POS_BASE[signal] : 0;
}

function computeCapitalConclusion(data) {
  const vi = (data && data.volumeIndicators) || {};
  const mf = (data && data.moneyFlow) || {};
  const margin = (data && data.marginTrading) || {};
  const positionLabel = (data && data.positionLabel) || null; // 20261101c：位置感知量价配合
  const summary = mf.summary && mf.summary.summary ? mf.summary.summary : {};
  const vp = vi.volumePrice || null;
  const ind = vi.indicators || {};

  // ---- 评分（0-100，50 为中性起点） ----
  let score = 50;   // 资金热度：只反映「交易量多少」（热度维度）
  let dirScore = 50; // 方向评分：供判断引擎「资金量能」因子，只反映多空方向
  const reasons = [];

  // 量能（交易量）水平（实际区间 +13 ~ -10，方向无关：只衡量成交量多少，放量=热度高、缩量=热度低，
  // 不再因股价上涨/下跌而加减分，修正「资金热度」被股价方向主导的问题）
  // 20261016b 注释校正（审计 CA5）：旧注释写「±15」，与下方 HEAT_MAP 实际取值（显著放量 +13 / 地量 -10）不符。
  // 注意：本项与下方「短期资金流向（:686）」的 ±15 不是同一项，后者确为 ±15，勿混淆。
  if (vp) {
    const HEAT_MAP = {
      '显著放量': 13, '温和放量': 8, '量能平稳': 0, '缩量': -6, '地量': -10,
    };
    const heat = vp.heatLevel || '量能平稳';
    const d = HEAT_MAP[heat] != null ? HEAT_MAP[heat] : 0;
    score += d;
    reasons.push(d ? `量能（交易量）：${heat}，${d > 0 ? '+' : ''}${d}` : `量能（交易量）：${heat}，0`);
    // 方向首项：量价关系的方向性权重（放量上涨偏多、放量下跌偏空），仅计入 dirScore（signal），
    // 不计入热度 score，从而让「热度」与「方向」彻底解耦。
    // 20261101c：改引位置感知单一真值源 vpPositionSignal（[-1,1]，×20 回退到 ±12 档位区间），
    // 与 volumeEngine 量价框架相互印证——仅「高位区间」放量类上涨做方向修正（转空），中位回退基础量价方向；
    // 非位置场景数值与旧 VP_MAP 逐值对齐（如 放量上涨 0.6×20=12），零回归。
    const vpsBase = vpPositionSignal(vp.signal, null);
    const vps = vpPositionSignal(vp.signal, positionLabel);
    dirScore += Math.round(vps * 20);
    if (positionLabel && vps !== vpsBase) {
      reasons.push(`量价配合（位置感知@${positionLabel}）：${vp.signal} 方向由${vpsBase >= 0 ? '偏多' : '偏空'}修正为${vps >= 0 ? '偏多' : '偏空'}`);
    }
  }

  // 流通市值（亿元）：用于把"主力净额"归一化为占市值比，避免大小市值股同金额同分
  const fmc = (typeof data.floatMarketCapYi === 'number' && data.floatMarketCapYi > 0) ? data.floatMarketCapYi : 0;

  // 短期资金流向（±15，按占流通市值比分级：金额越大、市值越小影响越大）
  const s5 = summary['5d'];
  if (s5 && typeof s5.mainNet === 'number') {
    const amt = Math.abs(s5.mainNet);
    const ratio = fmc > 0 ? (s5.mainNet / fmc) * 100 : null;
    let sc5;
    if (ratio === null) {
      sc5 = s5.mainNet > 0 ? 15 : -15;
      reasons.push(s5.mainNet > 0 ? `近5日主力净流入${amt.toFixed(2)}亿，+15` : `近5日主力净流出${amt.toFixed(2)}亿，-15`);
    } else {
      sc5 = flowScoreByRatio(ratio, 15);
      reasons.push(`近5日主力${s5.mainNet > 0 ? '净流入' : '净流出'}${amt.toFixed(2)}亿(占流通市值${ratio.toFixed(2)}%)${sc5 > 0 ? '，+' : '，'}${sc5}`);
    }
    score += sc5;
    dirScore += sc5;
  }

  // 中期资金流向（±10，同上归一化）
  const s20 = summary['20d'];
  if (s20 && typeof s20.mainNet === 'number') {
    const amt = Math.abs(s20.mainNet);
    const ratio = fmc > 0 ? (s20.mainNet / fmc) * 100 : null;
    let sc20;
    if (ratio === null) {
      sc20 = s20.mainNet > 0 ? 10 : -10;
      reasons.push(s20.mainNet > 0 ? `近20日主力净流入${amt.toFixed(2)}亿，+10` : `近20日主力净流出${amt.toFixed(2)}亿，-10`);
    } else {
      sc20 = flowScoreByRatio(ratio, 10);
      reasons.push(`近20日主力${s20.mainNet > 0 ? '净流入' : '净流出'}${amt.toFixed(2)}亿(占流通市值${ratio.toFixed(2)}%)${sc20 > 0 ? '，+' : '，'}${sc20}`);
    }
    score += sc20;
    dirScore += sc20;
  }

  // 量能指标（±10）
  if (ind.obvTrend === '上升趋势') { score += 6; dirScore += 6; reasons.push('OBV 上升趋势，+6'); }
  else if (ind.obvTrend === '下降趋势') { score -= 6; dirScore -= 6; reasons.push('OBV 下降趋势，-6'); }
  if (ind.vrSignal && ind.vrSignal.includes('多')) { score += 4; dirScore += 4; reasons.push(`VR 信号${ind.vrSignal}，+4`); }
  else if (ind.vrSignal && ind.vrSignal.includes('空')) { score -= 4; dirScore -= 4; reasons.push(`VR 信号${ind.vrSignal}，-4`); }

  // 融资融券（变化按"占流通市值比"归一化分级，与主力净额同口径；存量杠杆按余额占比评级，已天然归一化）
  if (margin.hasData && margin.latest) {
    const l = margin.latest;
    // 融资余额变化：增加=看多正面，按占流通市值比分级（金额越大、市值越小影响越大）
    if (typeof l.rzChange === 'number') {
      const rzYi = l.rzChange / 1e8; // 元→亿
      const rzChgPct = fmc > 0 ? (rzYi / fmc) * 100 : null;
      let rzSc;
      if (rzChgPct === null) {
        rzSc = l.rzChange > 0 ? 6 : -6;
        reasons.push(l.rzChange > 0 ? `融资余额增加${Math.abs(rzYi).toFixed(2)}亿，+6` : `融资余额减少${Math.abs(rzYi).toFixed(2)}亿，-6`);
      } else {
        rzSc = flowScoreByRatio(rzChgPct, 6);
        reasons.push(`融资余额${l.rzChange > 0 ? '增加' : '减少'}${Math.abs(rzYi).toFixed(2)}亿(占流通市值${rzChgPct.toFixed(2)}%)${rzSc > 0 ? '，+' : '，'}${rzSc}`);
      }
      score += rzSc;
      dirScore += rzSc;
    }
    // 融券余额变化：增加=做空力量增强=负面，按占流通市值比分级（方向与融资相反）
    if (typeof l.rqChange === 'number') {
      const rqYi = l.rqChange / 1e8; // 元→亿
      const rqChgPct = fmc > 0 ? (rqYi / fmc) * 100 : null;
      let rqSc;
      if (rqChgPct === null) {
        rqSc = l.rqChange > 0 ? -6 : 6;
        reasons.push(l.rqChange > 0 ? `融券余额增加${Math.abs(rqYi).toFixed(2)}亿，-6` : `融券余额减少${Math.abs(rqYi).toFixed(2)}亿，+6`);
      } else {
        rqSc = -flowScoreByRatio(rqChgPct, 6); // 融券增加→扣
        reasons.push(`融券余额${l.rqChange > 0 ? '增加' : '减少'}${Math.abs(rqYi).toFixed(2)}亿(占流通市值${rqChgPct.toFixed(2)}%)${rqSc > 0 ? '，+' : '，'}${rqSc}`);
      }
      score += rqSc;
      dirScore += rqSc;
    }
    // 融资余额占流通市值比（存量杠杆，已归一化）
    let rzRatioSc = 0;
    if (l.rzRatio > 5) { rzRatioSc = 4; reasons.push(`融资余额占流通市值${l.rzRatio.toFixed(2)}%，杠杆活跃，+4`); }
    else if (l.rzRatio > 2) { rzRatioSc = 2; reasons.push(`融资余额占流通市值${l.rzRatio.toFixed(2)}%，+2`); }
    score += rzRatioSc;
    dirScore += rzRatioSc;
  }

  // 换手率加成（±5，相对月均换手率：以个股自身近一个月的活跃度为基准，替代绝对阈值）
  if (ind.turnover) {
    const t = parseFloat(ind.turnover);
    const ratio = (typeof ind.turnoverRatio === 'number' && ind.turnoverRatio > 0) ? ind.turnoverRatio : null;
    if (ratio !== null) {
      const avgStr = (ind.turnoverAvg > 0) ? `月均${ind.turnoverAvg.toFixed(2)}%的${ratio.toFixed(1)}倍` : `月均参考缺失`;
      if (ratio >= 2.0) { score += 5; reasons.push(`换手率${t.toFixed(2)}%（${avgStr}）异常活跃，+5`); }
      else if (ratio >= 1.5) { score += 3; reasons.push(`换手率${t.toFixed(2)}%（${avgStr}）高度活跃，+3`); }
      else if (ratio < 0.5) { score -= 3; reasons.push(`换手率${t.toFixed(2)}%（${avgStr}）低迷，-3`); }
    } else {
      // 无月均参考（换手率序列缺失）时退回宽松绝对阈值
      if (t > 10) { score += 5; reasons.push(`换手率${t.toFixed(2)}% 极高，+5`); }
      else if (t > 5) { score += 3; reasons.push(`换手率${t.toFixed(2)}% 较高，+3`); }
      else if (t < 1) { score -= 3; reasons.push(`换手率${t.toFixed(2)}% 较低，-3`); }
    }
  }

  score = Math.max(0, Math.min(100, score));

  // ---- 多空打分（用于综合判断标签，与 renderConclusion 同口径） ----
  let bullScore = 0, bearScore = 0;
  if (vp) {
    const s = vp.signal;
    // 20261106a：位置感知多空打分，仅保留三分区的高位区间特例（放量类上涨判派发/偏空）；
    // 旧体系的方向加分分支随旧体系退役，其余沿用基础量价分类。
    if (positionLabel === '高位区间' && ['放量上涨', '量价齐升', '缩量上涨'].includes(s)) {
      bearScore += 2;
    } else {
      if (['放量上涨', '量价齐升', '量价温和偏多'].includes(s)) bullScore += 2;
      else if (['缩量下跌'].includes(s)) bullScore += 1;
      else if (['上涨缩量', '量价温和偏弱'].includes(s)) bearScore += 1;
      else if (['巨量下跌', '放量下跌'].includes(s)) bearScore += 2; // 20261019e：huge 改名「巨量下跌」后仍覆盖；同时修复历史遗漏——旧 amp 档「量价齐跌」不在列（下跌放量不得空头分），现 amp 改判「放量下跌」后已覆盖
    }
  }
  if (s5 && typeof s5.mainNet === 'number') {
    if (s5.mainNet > 0) bullScore += 2;
    else if (s5.mainNet < 0) bearScore += 2;
  }
  if (ind.obvTrend === '上升趋势') bullScore += 1;
  if (ind.obvTrend === '下降趋势') bearScore += 1;
  if (ind.vrSignal && ind.vrSignal.includes('多')) bullScore += 1;
  if (ind.vrSignal && ind.vrSignal.includes('空')) bearScore += 1;
  if (margin.latest && typeof margin.latest.rzChange === 'number') {
    if (margin.latest.rzChange > 0) bullScore += 1;
    else if (margin.latest.rzChange < 0) bearScore += 1;
  }

  const diff = bullScore - bearScore;
  // 方向信号（供判断引擎「资金量能」因子）：由方向评分 dirScore 归一化，仅反映多空方向。
  // 与「资金热度 score」解耦——score 只反映交易量多少（热度），signal 只反映多空方向，
  // 避免「放量下跌 / 巨量下跌」这类高成交却下跌的个股因成交量放大而被误判为偏多。
  const signal = Math.max(-1, Math.min(1, (dirScore - 50) / 50));
  let label;
  if (diff >= 3) label = '资金面偏多，量能支撑上涨';
  else if (diff >= 1) label = '资金面中性偏多';
  else if (diff <= -3) label = '资金面偏空，注意风险';
  else if (diff <= -1) label = '资金面中性偏空';
  else label = '资金面中性，方向不明';

  let grade;
  if (score >= 80) grade = '非常活跃';
  else if (score >= 65) grade = '活跃';
  else if (score >= 45) grade = '中性';
  else if (score >= 30) grade = '低迷';
  else grade = '极度低迷';

  return { signal, score, label, bullScore, bearScore, reasons, grade };
}

/**
 * 汇总资金流向
 */
function summarizeMoneyFlow(moneyFlow) {
  if (!moneyFlow || moneyFlow.length === 0) return null;

  const periods = [5, 10, 20, 60];
  const summary = {};

  for (const p of periods) {
    const data = moneyFlow.slice(-p);
    if (data.length === 0) continue;
    const mainNet = data.reduce((s, d) => s + d.mainNet, 0);
    const largeNet = data.reduce((s, d) => s + d.largeNet, 0);
    const mediumNet = data.reduce((s, d) => s + d.mediumNet, 0);
    const smallNet = data.reduce((s, d) => s + d.smallNet, 0);

    summary[`${p}d`] = {
      mainNet: Math.round(mainNet / 1e8 * 100) / 100,
      largeNet: Math.round(largeNet / 1e8 * 100) / 100,
      mediumNet: Math.round(mediumNet / 1e8 * 100) / 100,
      smallNet: Math.round(smallNet / 1e8 * 100) / 100,
      direction: mainNet > 0 ? '净流入' : '净流出',
    };
  }

  // 最近5日逐日明细
  const recent5 = moneyFlow.slice(-5).map(d => ({
    date: d.date,
    mainNet: Math.round(d.mainNet / 1e8 * 100) / 100,
    direction: d.mainNet > 0 ? '流入' : '流出',
  }));

  return { summary, recent5 };
}

// 20261017a：导出 computeVolumeIndicators 作为个股侧量能指标的纯计算入口
// （不触发任何外网抓取），供 priceAction / analysis 等模块直接引用，避免为取量能指标
// 而白白拉起资金流与融资融券请求。
module.exports = { analyzeCapitalFlow, computeCapitalConclusion, computeVolumeIndicators, vpPositionSignal };

~~~

---

## `lib\changeAnalysis.js`  ·  307 行

~~~js
/**
 * 重大财务变化 AI 归因与历史留存
 * -------------------------------------------------------------
 * 扫描深度分析结果中的关键时间序列，识别同比发生重大变化的指标，
 * 并调用外部搜索 + LLM 生成归因解释，结果持久化到 data/change-analysis/
 * 供后续复盘与前端展示。
 */
const fs = require('fs');
const path = require('path');
const {
  searchAnnouncements,
  searchAnnouncementsByCode,
  interpretReport,
} = require('./cnscraperAdapter');
const { searchFinancial } = require('./miaoxiangSearch');
const { callLLM, loadConfig } = require('./aiAugment');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CHANGE_DIR = path.join(DATA_DIR, 'change-analysis');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 分析结果缓存 7 天
const CHANGE_THRESHOLD_PCT = 30; // 同比变化绝对值超过 30% 视为重大变化
const MAX_CHANGES = 5; // 单次最多分析 5 个最显著变化

function ensureDir() {
  if (!fs.existsSync(CHANGE_DIR)) fs.mkdirSync(CHANGE_DIR, { recursive: true });
}

function historyFile(symbol) {
  return path.join(CHANGE_DIR, `${symbol}.json`);
}

function readHistory(symbol) {
  const f = historyFile(symbol);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function writeHistory(symbol, data) {
  ensureDir();
  fs.writeFileSync(historyFile(symbol), JSON.stringify(data, null, 2), 'utf8');
}

function fmtYi(v) {
  if (v == null || Number.isNaN(v)) return '-';
  return `${(Math.round(v * 100) / 100).toFixed(2)}亿`;
}

function pctChange(cur, prev) {
  if (prev == null || prev === 0) return null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 10000) / 100;
}

/**
 * 从各 sections 中扫描重大同比变化
 */
function detectChanges(sections) {
  const changes = [];
  const add = (metric, year, prevYear, cur, prev, unit, chartId, note = '') => {
    const p = pctChange(cur, prev);
    if (p == null || Math.abs(p) < CHANGE_THRESHOLD_PCT) return;
    changes.push({
      metric,
      year,
      prevYear,
      current: Math.round(cur * 100) / 100,
      previous: Math.round(prev * 100) / 100,
      changePct: p,
      unit,
      chartId,
      note,
      summary: `${year}年${metric} ${fmtYi(cur)}，较${prevYear}年${p > 0 ? '增长' : '下降'}${Math.abs(p).toFixed(1)}%`,
    });
  };

  // 仅比较「最近一期 vs 上一期」，聚焦最新年度数据；
  // 若当年尚无年报（最末期为 TTM 还原口径），则自动以 TTM 口径对比，
  // 不再遍历全历史年份两两对比，避免重大变化归因集中在去年。
  const compareLatest = (arr, metric, field, unit, chartId) => {
    if (!arr || arr.length < 2) return;
    const cur = arr[arr.length - 1];
    const prev = arr[arr.length - 2];
    const note = cur.ttm ? 'TTM 还原（当年无年报，滚动累计）' : '';
    add(metric, cur.year, prev.year, cur[field], prev[field], unit, chartId, note);
  };

  compareLatest(sections.revenueCostData, '营业总收入', 'revenue', '亿元', 'deepRevenueCost');
  compareLatest(sections.revenueCostData, '归母净利润', 'netProfit', '亿元', 'deepRevenueCost');
  compareLatest(sections.revenueCostData, '营运利润', 'operatingProfit', '亿元', 'deepRevenueCost');
  compareLatest(sections.cashFlowData, '经营现金流净额', 'operatingCashFlow', '亿元', 'deepRevVsCash');
  compareLatest(sections.expenseData, '销售费用', 'saleExpense', '亿元', 'deepRevVsExp');
  compareLatest(sections.expenseData, '管理费用', 'manageExpense', '亿元', 'deepRevVsExp');
  compareLatest(sections.expenseData, '研发费用', 'researchExpense', '亿元', 'deepRevVsExp');

  // 按变化幅度降序，取前 N
  changes.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  return changes.slice(0, MAX_CHANGES);
}

/**
 * 收集公开信息证据：公告、研报解读、妙想搜索
 */
async function searchEvidence(symbol, name, change) {
  const evidence = [];
  const keyword = `${name || symbol} ${change.year} ${change.metric}`;
  try {
    const annCode = await searchAnnouncementsByCode(symbol, 20);
    if (annCode && annCode.ok && annCode.items && annCode.items.length) evidence.push(annCode);
  } catch (e) {
    console.error('[ChangeAnalysis] searchAnnouncementsByCode failed:', e.message);
  }
  try {
    const annKw = await searchAnnouncements(keyword, 15);
    if (annKw && annKw.ok && annKw.items && annKw.items.length) evidence.push(annKw);
  } catch (e) {
    console.error('[ChangeAnalysis] searchAnnouncements failed:', e.message);
  }
  try {
    const rep = await interpretReport(symbol);
    if (rep && rep.ok) evidence.push(rep);
  } catch (e) {
    console.error('[ChangeAnalysis] interpretReport failed:', e.message);
  }
  try {
    const mx = await searchFinancial(`${keyword} 原因`);
    if (mx) evidence.push({ ok: true, source: 'miaoxiang', content: mx });
  } catch (e) {
    console.error('[ChangeAnalysis] miaoxiang search failed:', e.message);
  }
  return evidence;
}

/**
 * 用 LLM 对变化和证据做归因总结
 */
async function explainWithAI(symbol, name, change, evidence) {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return {
      source: 'no-key',
      text: '未配置 AI API Key，无法自动联网归因。请在「AI 设置」中配置 Key 后重新分析。',
    };
  }

  const evidenceText = evidence
    .map((e, idx) => `[证据${idx + 1}] ${JSON.stringify(e).slice(0, 2500)}`)
    .join('\n---\n');

  const direction = change.changePct > 0 ? '增长' : '下降';
  const prompt = `你是资深财务分析师，熟悉 A 股年报与现金流量表。

请分析：${name || symbol} 在 ${change.year} 年的「${change.metric}」较 ${change.prevYear} 年 ${direction} ${Math.abs(change.changePct).toFixed(1)}%（从 ${fmtYi(change.previous)} 到 ${fmtYi(change.current)}）的主要原因。${change.note ? `备注：${change.note}。` : ''}

可参考以下公开信息片段（可能包含年报、公告、研报、新闻）：
${evidenceText}

要求：
1) 用简体中文，分 2-4 条核心原因；
2) 区分一次性/结构性因素与持续性经营因素；
3) 对每条原因说明证据强弱（年报明确披露 / 媒体分析 / 推断）；
4) 若数据不足以解释，明确写“公开信息未能完全解释该变化”；
5) 总长度控制在 400 字以内。`;

  try {
    // 20260904a：妙想东财资讯补事实源（公告/新闻/研报对财务归因覆盖度足够），失败自动回退通用搜索
    const mxAttributionQuery = `${name || symbol}（${symbol}）${change.year}年${change.metric} ${direction}原因 财报 公告`;
    const text = await callLLM(cfg.provider, cfg.apiKey, cfg.modelWeb, [
      { role: 'system', content: '你是专业财务分析师，只基于公开信息分析，不编造数据。' },
      { role: 'user', content: prompt },
    ], { webSearch: true, mxQuery: mxAttributionQuery });
    return { source: 'ai', text: text || 'AI 返回为空' };
  } catch (e) {
    console.error('[ChangeAnalysis] callLLM failed:', e.message);
    return { source: 'error', text: `AI 归因失败：${e.message}` };
  }
}

/**
 * 对单一变化执行分析（含缓存复用）。
 * 为不阻塞深度分析主流程，未命中缓存的变化先返回 pending 占位，
 * 真正的联网搜索与 LLM 归因放入 setImmediate 后台完成。
 */
async function analyzeOneChange(symbol, name, change, history) {
  const key = `${change.metric}-${change.year}`;
  const now = Date.now();
  // 20260919d：仅「成功产出 AI 归因」的结果（explanationSource==='ai'）可作为缓存复用。
  // 失败/占位（error/pending/no-key）绝不能被当作有效缓存 —— 否则单次模型 400 会被冻结 7 天，
  // 用户重启、重跑深度分析都无法自愈（2026-09-19 圣湘/士兰微「AI 归因失败」长期不消失即此因）。
  const reusable = (a) => !!a && a.explanationSource === 'ai';
  const existing = (history.analyses || []).find(
    (a) => a.key === key && reusable(a) && now - new Date(a.date).getTime() < CACHE_TTL_MS
  );
  if (existing) return { ...existing, cached: true };

  // 未命中缓存：立即返回 pending，由调用方触发后台分析
  return {
    key,
    ...change,
    explanation: '正在后台联网归因分析中，请稍后刷新查看结果。',
    explanationSource: 'pending',
    evidenceCount: 0,
    evidence: [],
    date: new Date().toISOString(),
  };
}

/**
 * 后台完成单一变化的联网归因分析
 */
async function runBackgroundAnalysis(symbol, name, change, history) {
  const key = `${change.metric}-${change.year}`;
  try {
    const evidence = await searchEvidence(symbol, name, change);
    const explanation = await explainWithAI(symbol, name, change, evidence);
    const item = {
      key,
      ...change,
      explanation: explanation.text,
      explanationSource: explanation.source,
      evidenceCount: evidence.filter((e) => e.ok).length,
      evidence,
      date: new Date().toISOString(),
    };
    history.analyses = history.analyses.filter((a) => a.key !== key);
    history.analyses.push(item);
    history.name = name || history.name || symbol;
    history.updatedAt = new Date().toISOString();
    writeHistory(symbol, history);
    return item;
  } catch (e) {
    console.error('[ChangeAnalysis] background analysis failed:', e.message);
    return null;
  }
}

/**
 * 入口：为某只股票扫描并分析重大变化，结果持久化并返回。
 * 主流程同步快速返回；未命中缓存的变化在后台异步完成 AI 归因。
 */
async function analyzeChangesForSymbol(symbol, name, sections) {
  ensureDir();
  const changes = detectChanges(sections);
  if (!changes.length) {
    return { changes: [], analyses: [], hasChanges: false };
  }

  let history = readHistory(symbol);
  if (!history || !history.analyses) {
    history = { symbol, name: name || symbol, createdAt: new Date().toISOString(), analyses: [] };
  }

  const analyses = [];
  const pending = [];
  for (const change of changes) {
    try {
      const item = await analyzeOneChange(symbol, name, change, history);
      // 先把 pending 占位写入历史，便于前端感知“进行中”
      history.analyses = history.analyses.filter((a) => a.key !== item.key);
      history.analyses.push(item);
      analyses.push(item);
      if (item.explanationSource === 'pending') {
        pending.push(change);
      }
    } catch (e) {
      console.error('[ChangeAnalysis] analyzeOneChange failed:', e.message);
    }
  }

  history.name = name || history.name || symbol;
  history.updatedAt = new Date().toISOString();
  writeHistory(symbol, history);

  // 后台异步完成真正的联网 AI 归因（不阻塞当前请求）
  if (pending.length) {
    setImmediate(() => {
      pending.forEach((change) => {
        runBackgroundAnalysis(symbol, name, change, history).catch(() => {});
      });
    });
  }

  return { changes, analyses, hasChanges: true };
}

/**
 * 只读读取某只股票的历史变化分析（用于前端直接展示）
 */
function loadChangeAnalysis(symbol) {
  const history = readHistory(symbol);
  if (!history) return { hasChanges: false, analyses: [] };
  return {
    hasChanges: true,
    analyses: history.analyses || [],
    updatedAt: history.updatedAt || null,
  };
}

module.exports = {
  analyzeChangesForSymbol,
  loadChangeAnalysis,
  detectChanges,
  CHANGE_THRESHOLD_PCT,
};

~~~

---

## `lib\chipDistribution.js`  ·  100 行

~~~js
// lib/chipDistribution.js —— 筹码分布本地计算模块（锚点三数据源，20261105f 定版移植）
// 算法逐行移植自东财 K 图官方筹码引擎（akshare stock_cyq_em 内嵌 JS 反编译还原）：
//   三角形分布（avg=(O+C+H+L)/4 锚点）+ 换手率衰减（每日 xdata *= (1-turnover)）+ 一字板特判。
// 参数：150 档价格精度；窗口默认 250 日（实测 250 日+前复权 与东财官方平均成本偏差 0.9%，20261105 验证）。
// 输入：bars = [{date, open, close, high, low, volume}]（volume 单位=手，与引擎日K同源）；
//       floatShares = 流通股本（股）；调用方由 quote.circulationValue（流通市值，元）/ 现价 推得。
// 输出：computeChipDistribution(bars, floatShares, opts) → { benefitRatio, avgCost, p90, p70, verdict, note, basis } | null
// 判读口径（spec ① 锚点三）：获利盘 >90% 抛压警示 / <5% 割肉枯竭；仅参考提醒，不参与量价判定。
'use strict';

const CYQ_BARS = 150;      // 价格档位数
const CYQ_WINDOW = 250;    // 计算窗口（日）；与引擎 250 日分位窗口同源

function computeChipDistribution(bars, floatShares, opts = {}) {
  try {
    if (!Array.isArray(bars) || bars.length < 30 || !floatShares || floatShares <= 0) return null;
    const window = opts.window || CYQ_WINDOW;
    const kdata = bars.slice(-window).map(b => ({
      date: b.date,
      open: b.open, close: b.close, high: b.high, low: b.low,
      // volume 单位=手 → 股：×100；换手率(%) = 股数/流通股本×100
      hsl: b.volume > 0 ? (b.volume * 100 / floatShares) * 100 : 0,
    }));
    const factor = CYQ_BARS;
    let maxprice = 0, minprice = 0;
    for (const e of kdata) {
      if (e.high > maxprice || maxprice === 0) maxprice = Math.max(maxprice, e.high);
      if (minprice === 0 || e.low < minprice) minprice = Math.min(minprice, e.low);
    }
    if (!(maxprice > minprice)) return null;
    const accuracy = Math.max(0.01, (maxprice - minprice) / (factor - 1));
    const xdata = new Array(factor).fill(0);
    for (const e of kdata) {
      const avg = (e.open + e.close + e.high + e.low) / 4;
      const turnoverRate = Math.min(1, e.hsl / 100 || 0);
      const H = Math.floor((e.high - minprice) / accuracy);
      const L = Math.ceil((e.low - minprice) / accuracy);
      const Gx = e.high === e.low ? factor - 1 : 2 / (e.high - e.low);
      const Gy = Math.floor((avg - minprice) / accuracy);
      for (let n = 0; n < xdata.length; n++) xdata[n] *= (1 - turnoverRate);
      if (e.high === e.low) {
        // 一字板特判：价格被锁死，半量集中在锁死价位
        if (Gy >= 0 && Gy < factor) xdata[Gy] += Gx * turnoverRate / 2;
      } else {
        for (let j = Math.max(0, L); j <= Math.min(factor - 1, H); j++) {
          const curprice = minprice + accuracy * j;
          if (curprice <= avg) {
            xdata[j] += Math.abs(avg - e.low) < 1e-8 ? Gx * turnoverRate : (curprice - e.low) / (avg - e.low) * Gx * turnoverRate;
          } else {
            xdata[j] += Math.abs(e.high - avg) < 1e-8 ? Gx * turnoverRate : (e.high - curprice) / (e.high - avg) * Gx * turnoverRate;
          }
        }
      }
    }
    const currentprice = kdata[kdata.length - 1].close;
    let totalChips = 0;
    for (let i = 0; i < factor; i++) totalChips += +xdata[i].toPrecision(12);
    if (!(totalChips > 0)) return null;
    const getCostByChip = (chip) => {
      let sum = 0;
      for (let i = 0; i < factor; i++) {
        const x = +xdata[i].toPrecision(12);
        if (sum + x > chip) return minprice + i * accuracy;
        sum += x;
      }
      return 0;
    };
    let below = 0;
    for (let i = 0; i < factor; i++) {
      if (currentprice >= minprice + i * accuracy) below += +xdata[i].toPrecision(12);
    }
    const benefitRatio = below / totalChips;
    const avgCost = getCostByChip(totalChips * 0.5);
    const pctChips = (percent) => {
      const ps = [(1 - percent) / 2, (1 + percent) / 2];
      const pr = [getCostByChip(totalChips * ps[0]), getCostByChip(totalChips * ps[1])];
      return { priceRange: pr, concentration: (pr[0] + pr[1]) === 0 ? 0 : (pr[1] - pr[0]) / (pr[0] + pr[1]) };
    };
    const bp = benefitRatio * 100;
    let verdict, note;
    if (bp > 90) { verdict = '抛压警示'; note = `获利盘 ${bp.toFixed(1)}% >90%：当前价位下几乎所有持仓获利，抛压警示（高位特征之一，仅参考提醒）`; }
    else if (bp < 5) { verdict = '割肉枯竭'; note = `获利盘 ${bp.toFixed(1)}% <5%：几乎无获利持仓，割肉枯竭（低位特征之一，仅参考提醒）`; }
    else { verdict = '中间区域'; note = `获利盘 ${bp.toFixed(1)}%（5%~90% 中间区域，仅参考提醒）`; }
    return {
      benefitRatio,                       // 0~1
      benefitPct: +bp.toFixed(1),
      avgCost: +avgCost.toFixed(3),
      p90: pctChips(0.9),
      p70: pctChips(0.7),
      window: kdata.length,
      verdict, note,
      basis: `本地 CYQ 算法（东财同款，${kdata.length} 日窗口+前复权口径），实测与东财官方平均成本偏差约 0.9%（20261105 验证）`,
    };
  } catch (e) {
    return null; // 筹码计算失败不阻断主链（仅参考数据）
  }
}

module.exports = { computeChipDistribution, CYQ_BARS, CYQ_WINDOW };

~~~

---

## `lib\cninfoAnnouncements.js`  ·  56 行

~~~js
/**
 * 巨潮资讯官方公告（确定性数据，非 AI）Node 包装层。
 * 通过 async execFile 调用 scripts/cninfo_announcements.py。
 * 失败时返回 {ok:false, items:[]} 而非抛异常，不影响个股页其他卡片。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cninfo_announcements.py');
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟内存缓存
let _cache = {};
function _getCache(key) {
  const hit = _cache[key];
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  return undefined;
}
function _setCache(key, data) {
  _cache[key] = { ts: Date.now(), data };
}

function _normSymbol(symbol) {
  return String(symbol || '').replace(/^(SH|SZ|BJ)/i, '').replace(/\.(SS|SZ|BJ)$/i, '').trim();
}

async function getCninfoAnnouncements(symbol, max = 30) {
  const code = _normSymbol(symbol);
  if (!/^\d{6}$/.test(code)) return { ok: false, error: '非A股代码', items: [] };
  const key = 'cninfo:' + code + ':' + max;
  const cached = _getCache(key);
  if (cached) return cached;
  const py = await findPythonForScript();
  if (!py) return { ok: false, error: '未找到 Python 解释器，无法调用 cninfo 适配器' };
  if (!fs.existsSync(SCRIPT)) return { ok: false, error: 'cninfo_announcements.py 不存在: ' + SCRIPT };
  try {
    const out = await execFileAsync(py, [SCRIPT, code, String(max)], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const parsed = JSON.parse(out.stdout);
    const r = parsed && parsed.ok ? parsed : { ...(parsed || {}), ok: false, items: [] };
    _setCache(key, r);
    return r;
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'cninfo 调用失败', items: [] };
  }
}

module.exports = { getCninfoAnnouncements };

~~~

---

## `lib\cnscraperAdapter.js`  ·  211 行

~~~js
/**
 * cn-financial-scraper 后台接入适配器（Node 端）
 * --------------------------------------------------------------
 * 通过异步 execFile 调用 scripts/cnscraper_adapter.py，把 cn-financial-scraper
 * v7.2.0 的「全网舆情 / 定期报告解读 / 交易所公告 / 监管政策资讯 / 货币政策」
 * 作为后台数据源接入工作台。
 *
 * 关键约束（见项目记忆）：
 *   * 必须 async execFile + JSON.parse(out.stdout)（不是 JSON.parse(out)）——
 *     promisify(execFile) 的返回值是 {stdout,stderr} 对象，直接 parse 会抛错。
 *   * 禁止同步子进程（execFileSync 会冻结事件循环）。
 *   * 所有函数失败时返回 {ok:false, ...} 而非抛异常，让上层判断逻辑优雅降级，
 *     绝不因外挂数据源不可用而拖垮个股判断。
 *   * 外挂源在本机沙箱/受限网络下常返回空（stub 已由 Python 层过滤），
 *     因此以「ok:true 但 count=0」的方式降级，而非报错。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const axios = require('axios');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');
const { localDate, localCompact, localDateFromTs } = require('./localDate');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cnscraper_adapter.py');
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟内存缓存

let _cache = {};
function _getCache(key) {
  const hit = _cache[key];
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  return undefined;
}
function _setCache(key, data) {
  _cache[key] = { ts: Date.now(), data };
}

async function _run(args) {
  const py = await findPythonForScript();
  if (!py) return { ok: false, error: '未找到 Python 解释器，无法调用 cn-financial-scraper 适配器' };
  if (!fs.existsSync(SCRIPT)) return { ok: false, error: 'cnscraper_adapter.py 不存在: ' + SCRIPT };
  try {
    const out = await execFileAsync(py, [SCRIPT, ...args], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 70000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const parsed = JSON.parse(out.stdout);
    return parsed || { ok: false, error: '空结果' };
  } catch (e) {
    // 解析失败 / 超时 / 非零退出，一律降级为 ok:false，不让异常上抛
    return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'cnscraper 调用失败' };
  }
}

/**
 * 全网舆情：按目标名（个股名/机构名/行业词）爬取 60+ 源舆情，聚合情绪。
 * 返回 { ok, count, positive, negative, neutral, avg_score, signal, articles, note }
 */
async function getGlobalSentiment(targets, opts = {}) {
  const t = Array.isArray(targets) ? targets : String(targets || '').split(',');
  const names = t.map(s => String(s).trim()).filter(Boolean);
  if (!names.length) return { ok: false, error: '未提供目标名', count: 0 };
  const days = opts.days || 3;
  const max = opts.maxArticles || 15;
  const budget = opts.budget || 12;
  const key = 'sent:' + names.join('|') + ':' + days;
  const cached = _getCache(key);
  if (cached) return cached;

  const r = await _run(['sentiment', '--targets', names.join(','), '--days', String(days), '--max', String(max), '--budget', String(budget)]);
  _setCache(key, r);
  return r;
}

/**
 * 定期报告解读：拉取东财财务数据并规则引擎解读。
 * 返回 { ok, code, name, revenue, net_profit, revenue_yoy, profit_yoy, gross_margin,
 *         roe, cash_ratio, score, rating, highlights, risks, ... }
 */
async function interpretReport(code) {
  const c = String(code || '').trim();
  if (!c) return { ok: false, error: '未提供股票代码' };
  const key = 'rep:' + c;
  const cached = _getCache(key);
  if (cached) return cached;
  const r = await _run(['report', '--code', c]);
  _setCache(key, r);
  return r;
}

/**
 * 沪深交易所公告搜索。
 * 返回 { ok, keyword, count, items:[{market,title,stock_code,stock_name,publish_date,url,category}] }
 */
async function searchAnnouncements(keyword, max = 30) {
  const kw = String(keyword || '').trim();
  if (!kw) return { ok: false, error: '未提供搜索词', items: [] };
  const key = 'ann:' + kw;
  const cached = _getCache(key);
  if (cached) return cached;
  const r = await _run(['announcements', '--keyword', kw, '--max', String(max)]);
  _setCache(key, r);
  return r;
}

/**
 * 交易所公告·按股票代码兜底（东方财富 np-anotice）。
 * 深交所公告源（cn-financial-scraper 的 search_announcements）在本机常因接口 500/熔断失效，
 * 导致回购/分红/增持等公告一条都抓不到。此函数直接用东财接口按 6 位代码拉取近一年公告，
 * 作为公告源的可靠兜底。返回 { ok, keyword, count, items:[{title,date,stock_code,stock_name,url}] }
 */
async function searchAnnouncementsByCode(symbol, max = 30) {
  const code = String(symbol || '').replace(/^(SH|SZ|BJ)/i, '').replace(/\.(SS|SZ|BJ)$/i, '').trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, error: '非A股代码', items: [] };
  const key = 'anncode:' + code;
  const cached = _getCache(key);
  if (cached) return cached;
  // 20260922i：东财 np-anotice 旧路径 /api/security/announcement 已失效（HTTP 200 空 body，count=0）。
  // 实际可用路径为 /api/security/ann，且必须带 ann_type=A&client_source=web&f_node=0&s_node=0，
  // 否则只返回全市场公告。响应体结构：resp.data.data.list[].{title,notice_date,eiTime,columns,...}。
  const n = Math.min(Math.max(max, 10), 60);
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${n}&page_index=1&ann_type=A&client_source=web&stock_list=${code}&f_node=0&s_node=0`;
  let r;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000,
    });
    const list = resp.data?.data?.list || resp.data?.list || resp.data?.announcements || resp.data?.data || [];
    if (!Array.isArray(list) || !list.length) {
      r = { ok: true, keyword: code, count: 0, items: [] };
    } else {
      const start = new Date();
      start.setFullYear(start.getFullYear() - 1);
      const cutoff = localDate(start);
      const items = list
        .map(a => ({
          // 20260922i：东财 /ann 的 title 已是「公司名:标题」完整串，直接采用
          title: a.title || a.notice_title || a.title_ch || '',
          date: String(a.notice_date || a.ei_time || a.display_time || a.datetime || '').slice(0, 10),
          stock_code: code,
          stock_name: a.stock_name || (Array.isArray(a.codes) ? a.codes.join('') : '') || '',
          url: a.url || a.notice_url || '',
          category: a.columns || '',
        }))
        .filter(a => a.title && a.date >= cutoff);
      r = { ok: true, keyword: code, count: items.length, items };
    }
  } catch (e) {
    r = { ok: false, error: (e && e.message ? String(e.message) : '东财公告请求失败').slice(0, 200), items: [] };
  }
  _setCache(key, r);
  return r;
}

/**
 * 监管/政策资讯（宏观政策 + 财经要闻 + 公告）。
 * 返回 { ok, agency, count, items:[{title,url,source,date}] }
 */
async function getRegulatoryNews(agency = 'all', limit = 15) {
  const key = 'reg:' + agency + ':' + limit;
  const cached = _getCache(key);
  if (cached) return cached;
  const r = await _run(['regulatory', '--agency', agency, '--limit', String(limit)]);
  _setCache(key, r);
  return r;
}

/**
 * 货币政策/财经要闻摘要（LPR、公开市场、宏观资讯）。
 */
async function getMonetaryPolicy() {
  const key = 'mon';
  const cached = _getCache(key);
  if (cached) return cached;
  const r = await _run(['monetary']);
  _setCache(key, r);
  return r;
}

/**
 * 财政部《财政收支情况》公告解析（一般公共预算收入/支出）。
 * 经 cn-financial-scraper 检索最新公告 → 抓正文 → 正则解析。
 * 返回 { ok, date, source, title, url, revenue:{acc,yoy}, expenditure:{acc,yoy} }。
 * 任一外挂源失败返回 {ok:false}，绝不抛异常。
 */
async function getFiscalData() {
  const key = 'fiscal';
  const cached = _getCache(key);
  if (cached) return cached;
  const r = await _run(['fiscal', '--limit', '40']);
  _setCache(key, r);
  return r;
}

module.exports = {
  getGlobalSentiment,
  interpretReport,
  searchAnnouncements,
  searchAnnouncementsByCode,
  getRegulatoryNews,
  getMonetaryPolicy,
  getFiscalData,
};

~~~

---

## `lib\cnTradingCalendar.js`  ·  104 行

~~~js
/**
 * cnTradingCalendar.js — 统一的 A 股交易日历（单一权威源）
 * --------------------------------------------------------------
 * 所有涉及「下一/上一交易日」「是否交易日」的判断都必须走这里，
 * 避免 sameDayJudgment 与 techFaceJudgment 各自维护一份休市表造成口径漂移
 * （历史教训：20261002c-2 仅跳过周末、未跳过法定节假日，导致长假期间误报/误生成）。
 *
 * 口径：交易日 = 周一至周五 且 非法定节假日（周末与法定节假日分别判定）。
 * 仅维护已公布的年份（当前 2026 + 已知的 2027 元旦）；未维护的年份退化为「仅跳过周末」，
 * 届时需在下方 HOLIDAY_RANGES 补入当年官方安排（来源：上交所《XXXX 年部分节假日休市安排》）。
 */
const { localDate } = require('./localDate');

// 每一年：若干 [起始, 结束] 闭区间（含端点，自动展开为每一天）。周末不在此列（由代码单独判定）。
const HOLIDAY_RANGES = {
  '2026': [
    ['2026-01-01', '2026-01-03'], // 元旦
    ['2026-02-15', '2026-02-23'], // 春节
    ['2026-04-04', '2026-04-06'], // 清明
    ['2026-05-01', '2026-05-05'], // 劳动节
    ['2026-06-19', '2026-06-21'], // 端午
    ['2026-09-25', '2026-09-27'], // 中秋
    ['2026-10-01', '2026-10-07'], // 国庆
  ],
  '2027': [
    // 仅 1/1 为工作日（1/2 周六、1/3 周日已由周末规则覆盖）；其余 2027 官方安排待公布后补入。
    ['2027-01-01', '2027-01-01'],
  ],
};

// 展开为 年份 -> Set(休市日)
const HOLIDAYS_BY_YEAR = {};
for (const year of Object.keys(HOLIDAY_RANGES)) {
  const s = new Set();
  for (const [a, b] of HOLIDAY_RANGES[year]) {
    for (let d = new Date(a + 'T00:00:00'); d <= new Date(b + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
      s.add(localDate(d));
    }
  }
  HOLIDAYS_BY_YEAR[year] = s;
}

function holidaySet(dateStr) {
  const y = String(dateStr).slice(0, 4);
  return HOLIDAYS_BY_YEAR[y] || new Set();
}

/** 是否 A 股交易日：周一~周五 且 非法定节假日 */
function isTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return false;
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;                       // 周末
  if (holidaySet(dateStr).has(localDate(d))) return false;        // 法定节假日
  return true;
}

/** 下一个交易日（跳过周末 + 法定节假日；最多向后看 30 天） */
function nextTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  for (let i = 0; i < 30; i++) {
    d.setDate(d.getDate() + 1);
    const ds = localDate(d);
    if (isTradingDay(ds)) return ds;
  }
  return dateStr;
}

/** 上一个交易日（跳过周末 + 法定节假日；最多向前看 30 天） */
function previousTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  for (let i = 0; i < 30; i++) {
    d.setDate(d.getDate() - 1);
    const ds = localDate(d);
    if (isTradingDay(ds)) return ds;
  }
  return dateStr;
}

/**
 * 「当前应更新到的交易日」：当天是交易日 → 当天；非交易日（周末/节假日）→ 最近一个交易日。
 * 20261024k：工作台统一口径——**非交易日无法获取「当日」数据属正常**，应沿用最近交易日数据，
 * 不得因此判定「数据不足」。所有「数据是否最新」的判断都应以此为准，而不是字面 today。
 */
function asOfTradingDate(dateStr) {
  const d = dateStr || localDate();
  return isTradingDay(d) ? d : previousTradingDay(d);
}

/**
 * 数据是否已更新到「当前应更新到的交易日」。
 * 非交易日沿用最近交易日数据 → 视为最新（不算缺数据）；只有严格落后于最近交易日才算陈旧。
 * @param {string} lastDate 数据最新日期 YYYY-MM-DD
 * @param {string} [dateStr] 参照日（默认今天）
 */
function isDataCurrent(lastDate, dateStr) {
  if (!lastDate) return false;
  return String(lastDate) >= asOfTradingDate(dateStr);
}

module.exports = { isTradingDay, nextTradingDay, previousTradingDay, asOfTradingDate, isDataCurrent, HOLIDAYS_BY_YEAR, HOLIDAY_RANGES };

~~~

---

## `lib\companyType.js`  ·  262 行

~~~js
/**
 * Company Type Classifier
 * Classifies companies into: growth (增长型), value (价值型), dividend (红利型), or balanced (均衡型)
 * Different types should prioritize different fundamental metrics:
 *   - Growth SMEs: revenue growth + P/S ratio
 *   - Value blue-chips: P/E ratio + ROE
 *   - Dividend stocks: dividend yield + dividend sustainability
 */

/**
 * Classify company type based on available data
 * @param {string} symbol - Stock symbol
 * @param {string} name - Company name
 * @param {object} quote - Quote data (includes fundamentals, price, totalValue)
 * @param {object} financialData - { income, balance, cashflow } from Eastmoney
 * @param {object|null} shareholders - Shareholder data (includes totalMarketCap)
 * @param {array} dividends - Dividend history array
 * 20261016b（审计 F1/G10）：返回的 weights 为「类型建议权重」，当前仅 lib/analysis.js 的 legacy 兜底分支消费；
 * 正常计分路径固定每维满分 25（DIM=25），不按公司类型改权重。改动 weights 不会改变基本面总分。
 * @returns {object} { type, typeName, typeIcon, description, keyMetrics, weights }
 */
function classifyCompanyType(symbol, name, quote, financialData, shareholders, dividends) {
  const { income } = financialData || {};
  
  // Gather data for classification
  const marketCap = getMarketCap(quote, shareholders);
  const pe = getPE(quote, shareholders, income);
  const dividendYield = getDividendYield(quote, dividends);
  const revenueGrowth = getRevenueGrowth(income);
  const roe = getROE(quote, financialData);
  const dividendYears = getDividendYears(dividends, quote);
  const isConsistentDividend = checkDividendConsistency(dividends) || (quote?.fundamentals?.dividendYears >= 3);
  
  // Known dividend-type companies (banks, utilities like 长江电力)
  const dividendKeywords = ['银行', '电力', '高速', '港口', '煤炭', '石油', '石化', '燃气', '水务', '铁路', '码头'];
  const nameIsDividendType = dividendKeywords.some(kw => (name || '').includes(kw));
  
  // Classification logic (priority order: dividend > growth > value > balanced)
  
  // 0. Known dividend-type company (banks, utilities) with long dividend history (5+ years)
  //    Even if current yield can't be calculated (e.g., latest dividend not yet announced)
  if (nameIsDividendType && dividendYears >= 5) {
    return buildResult('dividend', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 1. Dividend stock: dividend yield > 3% AND consistent dividends for 3+ years
  //    OR known dividend-type company with yield > 2%
  if (
    (dividendYield >= 3 && dividendYears >= 3 && isConsistentDividend) ||
    (nameIsDividendType && dividendYield >= 2 && dividendYears >= 2)
  ) {
    return buildResult('dividend', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 2. Growth stock: very high revenue growth (>50%) regardless of market cap
  //    OR moderate growth (>=20%) with smaller market cap (<500亿)
  if (revenueGrowth >= 50) {
    return buildResult('growth', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  if (revenueGrowth >= 20 && marketCap > 0 && marketCap < 500) {
    return buildResult('growth', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 3. Value stock: market cap > 500亿 AND PE 10-25 AND ROE > 10%
  if (marketCap >= 500 && pe >= 10 && pe <= 25 && roe >= 10) {
    return buildResult('value', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 4. Large cap with moderate characteristics -> value
  if (marketCap >= 500 && pe > 0 && pe <= 40 && roe >= 5) {
    return buildResult('value', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 5. Small cap with high growth -> growth
  if (revenueGrowth >= 15 && marketCap > 0 && marketCap < 300) {
    return buildResult('growth', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // 6. High dividend even without long history -> dividend
  if (dividendYield >= 4 && dividendYears >= 1) {
    return buildResult('dividend', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
  }
  
  // Default: balanced
  return buildResult('balanced', marketCap, pe, dividendYield, revenueGrowth, roe, dividendYears, name);
}

function buildResult(type, marketCap, pe, divYield, revGrowth, roe, divYears, name) {
  // 金融业识别：银行/保险/证券/信托/基金等其高负债是经营常态（存贷/承保业务天然依赖负债），
  // 不应将高「资债比」判为利空。名称关键字足以覆盖 A 股上市金融机构。
  const financialKeywords = ['银行', '保险', '证券', '信托', '期货', '基金', '资管', '财富', '金控', '租赁', '财务', '再保险', '寿险', '财险', '人寿', '太保', '人保', '平安'];
  const isFinancial = financialKeywords.some(kw => (name || '').includes(kw));

  const typeInfo = {
    growth: {
      typeName: '增长型',
      typeIcon: '🚀',
      description: '增长型中小企业，重点关注营收增长和市销率(PS)',
      keyMetrics: ['revenueGrowth', 'ps', 'profitGrowth'],
      weights: { growth: 40, valuation: 20, profitability: 20, health: 20 },
      focusText: '营收增长率、市销率(PS)、利润增速',
    },
    value: {
      typeName: '价值型',
      typeIcon: '💎',
      description: '价值型白马股，重点关注市盈率(PE)和净资产收益率(ROE)',
      keyMetrics: ['pe', 'roe', 'pb', 'netMargin'],
      weights: { valuation: 35, profitability: 30, growth: 15, health: 20 },
      focusText: '市盈率(PE)、ROE、市净率(PB)、净利率',
    },
    dividend: {
      typeName: '红利型',
      typeIcon: '💰',
      description: '红利型股票，重点关注股息率和分红的可持续性',
      keyMetrics: ['dividendYield', 'dividendYears', 'payoutRatio', 'roe'],
      weights: { health: 35, profitability: 25, valuation: 25, growth: 15 },
      focusText: '股息率、分红年限、派息率、ROE稳定性',
    },
    balanced: {
      typeName: '均衡型',
      typeIcon: '⚖️',
      description: '均衡型公司，各维度均衡评估',
      keyMetrics: ['pe', 'roe', 'revenueGrowth', 'dividendYield'],
      weights: { valuation: 25, profitability: 25, growth: 25, health: 25 },
      focusText: '市盈率、ROE、营收增长、股息率',
    },
  };
  
  const info = typeInfo[type] || typeInfo.balanced;
  
  return {
    type,
    typeName: info.typeName,
    typeIcon: info.typeIcon,
    description: info.description,
    keyMetrics: info.keyMetrics,
    weights: info.weights,
    focusText: info.focusText,
    isFinancial,
    classificationData: {
      marketCap,
      pe,
      dividendYield: divYield,
      revenueGrowth: revGrowth,
      roe,
      dividendYears: divYears,
    },
  };
}

// ---- Helper functions to extract metrics ----

function getMarketCap(quote, shareholders) {
  // Try multiple sources
  if (shareholders?.totalMarketCap && shareholders.totalMarketCap > 0) {
    return Math.round(shareholders.totalMarketCap / 1e8 * 100) / 100; // Convert to 亿
  }
  if (quote?.totalValue && quote.totalValue > 0) {
    return quote.totalValue; // Already in 亿
  }
  if (quote?.fundamentals?.marketCap && quote.fundamentals.marketCap > 0) {
    return Math.round(quote.fundamentals.marketCap / 1e8 * 100) / 100;
  }
  return 0;
}

function getPE(quote, shareholders, income) {
  // Try quote first
  if (quote?.pe && quote.pe > 0) return quote.pe;
  if (quote?.fundamentals?.pe && quote.fundamentals.pe > 0) return quote.fundamentals.pe;
  // Calculate from financial data
  if (income && income.length > 0 && shareholders?.totalMarketCap) {
    const latest = income[income.length - 1];
    const netProfit = latest?.PARENT_NETPROFIT || 0;
    const marketCap = shareholders.totalMarketCap;
    if (netProfit > 0 && marketCap > 0) {
      return Math.round(marketCap / (netProfit / 1e8) * 100) / 100;
    }
  }
  return 0;
}

function getDividendYield(quote, dividends) {
  // Try quote first
  if (quote?.fundamentals?.dividendYield && quote.fundamentals.dividendYield > 0) {
    const dy = quote.fundamentals.dividendYield;
    return typeof dy === 'number' && dy < 1 && !quote.fundamentals.dividendYieldIsPct ? dy * 100 : dy;
  }
  // Calculate from dividends — find the most recent record with non-zero dividendPerShare
  if (dividends && dividends.length > 0 && quote?.price > 0) {
    for (const d of dividends) {
      if (d?.dividendPerShare && d.dividendPerShare > 0) {
        return Math.round(d.dividendPerShare / quote.price * 10000) / 100;
      }
    }
  }
  return 0;
}

function getRevenueGrowth(income) {
  if (!income || income.length < 2) return 0;
  const latest = income[income.length - 1];
  const prev = income[income.length - 2];
  const latestRev = latest?.TOTAL_OPERATE_INCOME || 0;
  const prevRev = prev?.TOTAL_OPERATE_INCOME || 0;
  if (prevRev > 0 && latestRev > 0) {
    return Math.round((latestRev / prevRev - 1) * 10000) / 100;
  }
  // Try YoY field
  if (latest?.TOTAL_OPERATE_INCOME_YOY) {
    return Math.round(latest.TOTAL_OPERATE_INCOME_YOY * 100) / 100;
  }
  return 0;
}

function getROE(quote, financialData) {
  // Try quote fundamentals
  if (quote?.fundamentals?.roe) {
    const roe = quote.fundamentals.roe;
    return typeof roe === 'number' && roe < 1 ? roe * 100 : roe;
  }
  if (quote?.fundamentals?.returnOnEquity) {
    const roe = quote.fundamentals.returnOnEquity;
    return typeof roe === 'number' && roe < 1 ? roe * 100 : roe;
  }
  // Try ZYZB data
  if (quote?.fundamentals?.roeJQ) {
    return quote.fundamentals.roeJQ;
  }
  return 0;
}

function getDividendYears(dividends, quote) {
  // 优先用东财分红接口统计的年数（/api/analysis 场景 dividends 可能为空数组）
  if ((!dividends || dividends.length === 0) && quote?.fundamentals?.dividendYears) {
    return quote.fundamentals.dividendYears;
  }
  if (!dividends || dividends.length === 0) return 0;
  // Count unique years with dividends
  const years = new Set(dividends.map(d => d.year).filter(y => y));
  return years.size;
}

function checkDividendConsistency(dividends) {
  if (!dividends || dividends.length < 3) return false;
  // Check if dividends exist for at least 3 consecutive years
  const years = dividends.map(d => parseInt(d.year)).filter(y => !isNaN(y)).sort((a, b) => a - b);
  if (years.length < 3) return false;
  let consecutive = 1;
  for (let i = 1; i < years.length; i++) {
    if (years[i] - years[i - 1] === 1) {
      consecutive++;
      if (consecutive >= 3) return true;
    } else {
      consecutive = 1;
    }
  }
  return false;
}

module.exports = { classifyCompanyType };

~~~

---

## `lib\consistencyAudit.js`  ·  364 行

~~~js
/**
 * lib/consistencyAudit.js — 工作台跨板块数据一致性巡检（20261103e）
 *
 * 用户指令：每日定期检查工作台所有数据——多个板块使用的同一数据，即使数据源不同，
 * 也要核对是否展示一样的数值；⚠️ 必须区分「累计数据」与「固定期数据」
 * （例：前三季度累计 vs 第三季度单季——两者本来就不该相等，绝不能误报不一致）。
 *
 * 巡检对象（同一语义数据在多板块的展示值）：
 *   - PE/PB/PS：顶栏指标条 / 左卡·关键财务指标 / 右卡·指标分析 / 行情
 *   - ROE：TTM 口径（顶栏/右卡/信号卡）vs 左卡（可能为报告期累计 ROEJQ）
 *   - 毛利率/净利率：TTM 口径 vs 报告期累计口径（XSMLL/XSJLL）
 *   - 营收增长/利润增长/扣非增长：单季优先同比（DJD_*）vs 累计同比（*_TZ）
 *   - 营运利润/NBV：原始取数 vs 右卡展示文本（单季与累计分别建目，不互比）
 *   - 行业均值 / 历史百分位：comparison 权威值 vs 右卡维度文本内嵌数值
 *
 * 状态口径：
 *   ok       —— 同口径数值一致
 *   caliber  —— 数值不同但属已知口径差异（单季 vs 累计 / TTM vs 报告期），如实注记，非错误
 *   mismatch —— 同口径数值不一致（真实数据链问题，需修复）
 *   missing  —— 可比数据不足，如实跳过
 *
 * 复用方式：与 analysisWarm 预热同机制——本地 HTTP 自调用 /api/analysis/:symbol
 * 取完整载荷后做纯函数核对，绝不重复实现载荷构建逻辑（单一数据源）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const AUDIT_DIR = path.join(__dirname, '..', 'data', 'consistency-audit');

// ===== 通用工具 =====
function toNum(v) { const n = parseFloat(v); return isNaN(n) ? null : n; }
function near(a, b, eps) { return a != null && b != null && Math.abs(a - b) <= eps; }
// 从「xx.xx%」提取数值
function pctFrom(text) { if (typeof text !== 'string') return null; const m = /(-?[\d.]+)%/.exec(text); return m ? parseFloat(m[1]) : null; }
// 从「xx.xx亿」提取数值
function yiFrom(text) { if (typeof text !== 'string') return null; const m = /(-?[\d.]+)亿/.exec(text); return m ? parseFloat(m[1]) : null; }
// 从「xx.xx」纯数值文本提取（PE/PB/PS 倍数无 % 后缀）
function numFrom(text) { if (typeof text !== 'string') return null; const m = /^(-?[\d.]+)$/.exec(text.trim()); return m ? parseFloat(m[1]) : null; }
// 从文本提取「行业均值 X」/「历史百分位 X%」式内嵌数值
function extract(text, re) { if (typeof text !== 'string') return null; const m = re.exec(text); return m ? parseFloat(m[1]) : null; }

function localDateStr(d) {
  const dt = d || new Date();
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
}

// 同报告期（去年同期）配对：zyzbHistory 降序，latest vs 去年同月日
function samePeriodPair(zy, fields) {
  const fl = Array.isArray(fields) ? fields : [fields];
  const pick = (row) => { if (!row) return null; for (const k of fl) { const n = toNum(row[k]); if (n != null) return n; } return null; };
  if (!Array.isArray(zy) || !zy.length) return { cur: null, prev: null };
  const latest = zy[0];
  const ld = String(latest.REPORT_DATE || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}/.test(ld)) return { cur: pick(latest), prev: null };
  const tgt = (parseInt(ld.slice(0, 4), 10) - 1) + ld.slice(4);
  const prev = zy.find(x => String(x.REPORT_DATE || '').slice(0, 10) === tgt);
  return { cur: pick(latest), prev: prev != null ? pick(prev) : null };
}

function newCheck(id, metric) {
  return { id, metric, status: 'missing', panels: [], note: '' };
}
// 兜底 0 哨兵（与 metricAnalysis ZERO_AS_MISSING 同口径）：比率/估值/增速类字段的 0
// 在生产端无法区分「真 0」与「取不到」（左卡显示 --）→ 巡检一律视为缺失，不参与互比。
function nz0(v) { return v === 0 ? null : v; }
function pushPanel(check, panel, value, caliber) {
  check.panels.push({ panel, value, caliber: caliber || null });
}

// 对一组同口径面板值做一致性判定：≥2 个值参与，全部一致→ok，否则 mismatch
function judgeSameCaliber(check, eps, unitLabel) {
  const vals = check.panels.filter(p => p.value != null);
  if (vals.length < 2) {
    check.status = 'missing';
    check.note = '可比数据不足（<2 个板块有值），如实跳过';
    return check;
  }
  const allEq = vals.every(p => near(p.value, vals[0].value, eps));
  if (allEq) {
    check.status = 'ok';
    check.note = `${vals.length} 个板块同口径（${unitLabel}）数值一致`;
  } else {
    check.status = 'mismatch';
    check.note = `同口径（${unitLabel}）数值不一致：` + vals.map(p => `${p.panel}=${p.value}`).join('，');
  }
  return check;
}

// 对「单季优先 vs 累计」双口径混合面板做判定：
// 每个面板值归类为 单季/累计/未知口径；同口径互比；归类失败才判 mismatch
function judgeDualCaliber(check, sqVal, cumVal, eps) {
  const vals = check.panels.filter(p => p.value != null);
  if (vals.length < 2 || (sqVal == null && cumVal == null)) {
    check.status = 'missing';
    check.note = '可比数据不足，如实跳过';
    return check;
  }
  let sqN = 0, cumN = 0, unknown = 0;
  for (const p of vals) {
    if (near(p.value, sqVal, eps)) { p.caliber = '单季优先同比'; sqN++; }
    else if (cumVal != null && near(p.value, cumVal, eps)) { p.caliber = '报告期累计同比'; cumN++; }
    else unknown++;
  }
  const mis = vals.filter(p => p.caliber === null);
  if (mis.length) {
    check.status = 'mismatch';
    check.note = `无法归类到任何已知口径（单季 ${sqVal == null ? '不可得' : sqVal + '%'} / 累计 ${cumVal == null ? '不可得' : cumVal + '%'}）：` + mis.map(p => `${p.panel}=${p.value}`).join('，');
  } else if (sqN >= 2 || cumN >= 2) {
    // 每种口径至少 2 个面板可互比且一致（同口径面板全部归类成功即视为一致）
    check.status = 'ok';
    check.note = `单季口径 ${sqN} 个 / 累计口径 ${cumN} 个，各自口径内一致（单季 ${sqVal}% vs 累计 ${cumVal}% 为正常口径差异）`;
  } else {
    check.status = 'ok';
    check.note = `各面板分属不同口径且均有归类：单季 ${sqVal == null ? '—' : sqVal + '%'} / 累计 ${cumVal == null ? '—' : cumVal + '%'}（单口径面板仅 1 个，无互比对象）`;
  }
  return check;
}

// ===== 单只股票巡检（纯函数，输入 /api/analysis 载荷）=====
function auditPayload(data) {
  const f = (data.quote && data.quote.fundamentals) || {};
  const quote = data.quote || {};
  const m = (data.fundamental && !data.fundamental.error && data.fundamental.metrics) || {};
  const ma = data.metricAnalysis || {};
  const maByKey = {};
  (Array.isArray(ma.metrics) ? ma.metrics : []).forEach(x => { maByKey[x.key] = x; });
  const sigByKey = {};
  ((data.signals && data.signals.signals) || []).forEach(x => { sigByKey[x.key] = x; });
  const zy = Array.isArray(f.zyzbHistory) ? f.zyzbHistory : [];
  const comp = data.comparison || {};
  const ind = comp.industryAvg || {};
  const pct = comp.percentiles || {};

  const checks = [];
  const P_LEFT = '左卡·关键财务指标';
  const P_TOP = '顶栏指标条（fundamental.metrics）';
  const P_RIGHT = '右卡·指标分析';
  const P_SIG = '信号卡（evaluateSignals）';
  const P_QUOTE = '行情 quote';

  // —— 1. PE / PB / PS：估值三件套（比率，eps=0.011 兼容两位小数显示）——
  {
    const c = newCheck('pe', '市盈率 PE(TTM)');
    pushPanel(c, P_LEFT, nz0(m.pe)); pushPanel(c, P_TOP, nz0(m.pe)); pushPanel(c, P_QUOTE, nz0(toNum(quote.pe)));
    pushPanel(c, P_RIGHT, numFrom(maByKey.pe && maByKey.pe.valueText));
    checks.push(judgeSameCaliber(c, 0.011, 'TTM 滚动'));
  }
  {
    const c = newCheck('pb', '市净率 PB');
    pushPanel(c, P_LEFT, nz0(m.pb)); pushPanel(c, P_QUOTE, nz0(toNum(quote.pb)));
    pushPanel(c, P_RIGHT, numFrom(maByKey.pb && maByKey.pb.valueText));
    checks.push(judgeSameCaliber(c, 0.011, '最新报告期 MRQ'));
  }
  {
    const c = newCheck('ps', '市销率 PS');
    pushPanel(c, P_LEFT, nz0(m.ps)); pushPanel(c, '顶栏指标条（fundamentals）', nz0(f.ps));
    pushPanel(c, P_RIGHT, numFrom(maByKey.ps && maByKey.ps.valueText));
    checks.push(judgeSameCaliber(c, 0.011, 'TTM/单期（按 psSource）'));
  }

  // —— 2. ROE：TTM 为主口径；左卡若为报告期累计（ROEJQ）则归 caliber ——
  {
    const c = newCheck('roe', 'ROE（净资产收益率）');
    const ttm = (f.roeTtm != null) ? f.roeTtm : null;
    const roejq = samePeriodPair(zy, 'ROEJQ').cur;
    pushPanel(c, '顶栏/右卡口径（roeTtm）', ttm, ttm != null ? 'TTM 滚动' : null);
    // 左卡 m.roe：先按 TTM 归类，不中再按报告期累计归类
    if (nz0(m.roe) != null) pushPanel(c, P_LEFT, nz0(m.roe), near(nz0(m.roe), ttm, 0.05) ? 'TTM 滚动' : (near(nz0(m.roe), roejq, 0.05) ? '报告期累计(ROEJQ)' : null));
    pushPanel(c, P_RIGHT, pctFrom(maByKey.roe && maByKey.roe.valueText), 'TTM 滚动');
    const sigRoe = sigByKey.roe ? pctFrom(sigByKey.roe.value) : null;
    pushPanel(c, P_SIG, sigRoe, 'TTM 滚动');
    const ttmPanels = c.panels.filter(p => p.value != null && p.caliber === 'TTM 滚动');
    const other = c.panels.filter(p => p.value != null && p.caliber && p.caliber !== 'TTM 滚动');
    const unclassified = c.panels.filter(p => p.value != null && p.caliber === null);
    if (unclassified.length) {
      c.status = 'mismatch';
      c.note = '存在无法归类到 TTM/报告期累计任一口径的展示值：' + unclassified.map(p => `${p.panel}=${p.value}`).join('，');
    } else if (ttmPanels.length >= 2 && !ttmPanels.every(p => near(p.value, ttmPanels[0].value, 0.05))) {
      c.status = 'mismatch';
      c.note = 'TTM 口径各板块数值不一致：' + ttmPanels.map(p => `${p.panel}=${p.value}`).join('，');
    } else if (ttmPanels.length + other.length < 2) {
      c.status = 'missing'; c.note = '可比数据不足，如实跳过';
    } else {
      c.status = 'ok';
      c.note = `TTM 口径 ${ttmPanels.length} 个板块一致` + (other.length ? `；另有 ${other.map(p => `${p.panel}=${p.value}(${p.caliber})`).join('，')}（与 TTM 属正常口径差异）` : '');
    }
  }

  // —— 3. 毛利率 / 净利率：TTM 为主口径，报告期累计（XSMLL/XSJLL）归 caliber ——
  [['grossMargin', '毛利率', 'XSMLL'], ['netMargin', '净利率', 'XSJLL']].forEach(([key, label, zyField]) => {
    const c = newCheck(key, label);
    const ttm = (f[key + 'Ttm'] != null) ? f[key + 'Ttm'] : null;
    const cum = samePeriodPair(zy, zyField).cur;
    pushPanel(c, '顶栏/右卡口径（' + key + 'Ttm）', ttm, ttm != null ? 'TTM 滚动' : null);
    if (nz0(m[key]) != null) pushPanel(c, P_LEFT, nz0(m[key]), near(nz0(m[key]), ttm, 0.05) ? 'TTM 滚动' : (near(nz0(m[key]), cum, 0.05) ? '报告期累计(' + zyField + ')' : null));
    pushPanel(c, P_RIGHT, pctFrom(maByKey[key] && maByKey[key].valueText), 'TTM 滚动');
    const ttmPanels = c.panels.filter(p => p.value != null && p.caliber === 'TTM 滚动');
    const other = c.panels.filter(p => p.value != null && p.caliber && p.caliber !== 'TTM 滚动');
    const unclassified = c.panels.filter(p => p.value != null && p.caliber === null);
    if (unclassified.length) {
      c.status = 'mismatch';
      c.note = '存在无法归类到 TTM/报告期累计任一口径的展示值：' + unclassified.map(p => `${p.panel}=${p.value}`).join('，');
    } else if (ttmPanels.length >= 2 && !ttmPanels.every(p => near(p.value, ttmPanels[0].value, 0.05))) {
      c.status = 'mismatch';
      c.note = 'TTM 口径各板块数值不一致：' + ttmPanels.map(p => `${p.panel}=${p.value}`).join('，');
    } else if (ttmPanels.length + other.length < 2) {
      c.status = 'missing'; c.note = '可比数据不足，如实跳过';
    } else {
      c.status = 'ok';
      c.note = `TTM 口径 ${ttmPanels.length} 个板块一致` + (other.length ? `；另有 ${other.map(p => `${p.panel}=${p.value}(${p.caliber})`).join('，')}（与 TTM 属正常口径差异，右卡已有口径说明）` : '');
    }
    checks.push(c);
  });

  // —— 4. 成长三指标：单季优先同比（DJD_*）vs 累计同比（*_TZ），混合口径归类判定 ——
  const growthDefs = [
    { id: 'growth', label: '营收增长', sigKey: 'growth', djd: ['DJD_TOI_YOY', 'TOTALOPERATEREVETZ'], cumTz: 'TOTALOPERATEREVETZ', mKeys: ['revenueGrowth'], fKey: 'revenueYoy', leftKeys: ['revenueGrowth'] },
    { id: 'profitGrowth', label: '归母净利润', sigKey: 'profitGrowth', djd: ['DJD_DPNP_YOY', 'PARENTNETPROFITTZ'], cumTz: 'PARENTNETPROFITTZ', mKeys: ['profitGrowth'], fKey: 'profitYoy', leftKeys: ['profitGrowth'] },
    { id: 'dedProfitGrowth', label: '扣非净利润增长', sigKey: 'dedProfitGrowth', djd: ['DJD_DEDUCTDPNP_YOY', 'KCFJCXSYJLRTZ'], cumTz: 'KCFJCXSYJLRTZ', mKeys: ['deductedProfitGrowth'], fKey: null, leftKeys: ['deductedProfitGrowth'] },
  ];
  for (const g of growthDefs) {
    const c = newCheck(g.id, g.label);
    const sq = samePeriodPair(zy, g.djd).cur;            // 单季优先同比（权威口径）
    const cum = samePeriodPair(zy, g.cumTz).cur;         // 报告期累计同比
    const leftVal = g.leftKeys.map(k => nz0(m[k])).find(v => v != null) || (g.fKey ? nz0(f[g.fKey]) : null) || null;
    if (leftVal != null) pushPanel(c, P_LEFT, leftVal);
    pushPanel(c, P_RIGHT, pctFrom(maByKey[g.id] && maByKey[g.id].valueText));
    pushPanel(c, P_SIG, sigByKey[g.sigKey] ? pctFrom(sigByKey[g.sigKey].value) : null);
    checks.push(judgeDualCaliber(c, sq, cum, 0.05));
  }

  // —— 5. 营运利润：单季 / 累计分列核对（单季=本期累计−上期累计，绝不能与累计互比）——
  if (data.opProfit && data.opProfit.cur && typeof data.opProfit.cur.opProfitYi === 'number') {
    const op = data.opProfit;
    {
      const c = newCheck('opProfitSq', '营运利润·单季');
      pushPanel(c, '取数（sqCur=本期累计−上期累计）', op.sqCur ? op.sqCur.opProfitYi : null, '单季');
      pushPanel(c, P_RIGHT, yiFrom(maByKey.opProfit && maByKey.opProfit.valueText), '单季（右卡 useSq 时）');
      checks.push(judgeSameCaliber(c, 0.011, '单季'));
      if (c.status === 'missing' && op.sqCur) { c.status = 'ok'; c.note = '单季取数存在；右卡展示值取不到（可能回退累计口径），见 opProfitCum 项'; }
      if (c.status === 'missing' && !op.sqCur) { c.status = 'missing'; c.note = '单季值不可得（缺上期累计），右卡已如实回退累计口径'; }
    }
    {
      const c = newCheck('opProfitCum', '营运利润·累计');
      pushPanel(c, '取数（cur）', op.cur.opProfitYi, '报告期累计');
      const sqYi = op.sqCur ? op.sqCur.opProfitYi : null;
      c.status = 'ok';
      c.note = `累计 ${op.cur.opProfitYi}亿（${op.cur.date}）与单季 ${sqYi == null ? '不可得' : sqYi + '亿'} 属不同口径，分列展示正确（不互比）`;
      checks.push(c);
    }
  }

  // —— 6. NBV（保险股专属）：累计口径，取数 vs 右卡展示 ——
  if (data.insuranceNBV && typeof data.insuranceNBV.valueYi === 'number') {
    const c = newCheck('nbv', 'NBV(新业务价值)');
    pushPanel(c, '取数（INSURANCE_REAL_DATA 备查库）', data.insuranceNBV.valueYi, '累计');
    pushPanel(c, P_RIGHT, yiFrom(maByKey.nbv && maByKey.nbv.valueText), '累计');
    checks.push(judgeSameCaliber(c, 0.011, '累计'));
  }

  // —— 7. 行业均值 / 历史百分位：comparison 权威值 vs 右卡维度文本内嵌数值 ——
  {
    const c = newCheck('indRoe', '行业均值 ROE（右卡维度文本 vs comparison 权威值）');
    pushPanel(c, 'comparison.industryAvg', (ind.roe != null) ? ind.roe : null);
    const dimText = (maByKey.roe && maByKey.roe.dims && maByKey.roe.dims.industry) ? maByKey.roe.dims.industry.text : null;
    pushPanel(c, P_RIGHT + '（维度文本）', extract(dimText, /行业均值 (-?[\d.]+)/));
    checks.push(judgeSameCaliber(c, 0.011, '行业均值'));
  }
  {
    const c = newCheck('pctRoe', '历史百分位 ROE（右卡维度文本 vs comparison 权威值）');
    pushPanel(c, 'comparison.percentiles', (pct.roe != null) ? pct.roe : null);
    const dimText = (maByKey.roe && maByKey.roe.dims && maByKey.roe.dims.pct) ? maByKey.roe.dims.pct.text : null;
    pushPanel(c, P_RIGHT + '（维度文本）', extract(dimText, /历史\s?(\d+)%/));
    checks.push(judgeSameCaliber(c, 0.5, '历史百分位'));
  }

  const summary = { total: checks.length, ok: 0, caliber: 0, mismatch: 0, missing: 0 };
  for (const c of checks) summary[c.status] = (summary[c.status] || 0) + 1;

  return {
    symbol: data.symbol,
    name: data.name || (data.quote && data.quote.name) || '',
    checkedAt: new Date().toISOString(),
    health: summary.mismatch > 0 ? 'warn' : 'ok',
    summary,
    checks,
  };
}

// ===== 持久化 =====
function ensureDir() { fs.mkdirSync(AUDIT_DIR, { recursive: true }); }
function saveAuditReport(report) {
  ensureDir();
  const file = path.join(AUDIT_DIR, `${report.date}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}
function loadAuditReport(date) {
  const file = path.join(AUDIT_DIR, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function listAuditReports(limit = 30) {
  ensureDir();
  return fs.readdirSync(AUDIT_DIR).filter(x => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))
    .sort().reverse().slice(0, limit).map(x => x.replace('.json', ''));
}

// ===== 远端自调用取载荷（与 analysisWarm 预热同机制）=====
function fetchJson(url, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', c => { buf += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('JSON 解析失败')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时')); });
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ===== 每日巡检：对标的清单逐只自调用载荷并核对，落盘合并报告 =====
async function runDailyAudit({ port = 3005, symbols = [], gapMs = 800 } = {}) {
  const results = [];
  for (const s of symbols) {
    const sym = (typeof s === 'string') ? s : s.symbol;
    const nm = (typeof s === 'string') ? '' : (s.name || '');
    try {
      const payload = await fetchJson(`http://127.0.0.1:${port}/api/analysis/${encodeURIComponent(sym)}`);
      results.push(auditPayload(payload));
    } catch (e) {
      results.push({ symbol: sym, name: nm, error: e.message, health: 'error', summary: { total: 0, ok: 0, caliber: 0, mismatch: 0, missing: 0 }, checks: [] });
    }
    await sleep(gapMs);
  }
  const totals = results.reduce((acc, r) => {
    acc.ok += (r.summary && r.summary.ok) || 0;
    acc.caliber += (r.summary && r.summary.caliber) || 0;
    acc.mismatch += (r.summary && r.summary.mismatch) || 0;
    acc.missing += (r.summary && r.summary.missing) || 0;
    return acc;
  }, { ok: 0, caliber: 0, mismatch: 0, missing: 0 });
  const report = {
    date: localDateStr(),
    ranAt: new Date().toISOString(),
    symbolCount: results.length,
    health: totals.mismatch > 0 ? 'warn' : 'ok',
    totals,
    results,
  };
  saveAuditReport(report);
  return report;
}

module.exports = { auditPayload, runDailyAudit, saveAuditReport, loadAuditReport, listAuditReports, AUDIT_DIR };

~~~

---

## `lib\crossMarket.js`  ·  122 行

~~~js
/**
 * 跨市场传导数据层（P2）
 * --------------------------------------------------------------
 * 把「隔夜美股/海外对标股」的涨跌传导到 A 股个股所属板块的情绪判断，
 * 解决"消息敏感性不足"：如 Moderna 隔夜 +177%（mRNA 癌症疫苗催化）→ A股生物医药板块。
 *
 * 数据源：腾讯行情（usXXX 前缀，GBK），本机稳定可用；美股收盘后次日 A 股开盘前可拿到隔夜涨跌。
 * 返回 { ok, benchmarks, avgCapped, signal, extreme, note }。
 */

const { getQuote } = require('./stockData');
// Part B：关联度/弱关联持续性经验库（跨市场对标主题关联度衰减）
const { benchmarkRelevance } = require('./relevanceLearning');

// A股行业/赛道关键词 → 美股对标股（按相关性排序，越靠前越相关）
// 关键词匹配复用 newsSearch.SECTOR_KEYWORDS 的行业关键词；这里按赛道维度给出美股对标。
const US_SECTOR_BENCHMARKS = {
  '医药生物': ['MRNA', 'BNTX'],
  '医疗器械': ['MRNA', 'BNTX'],
  '创新药': ['MRNA', 'BNTX'],
  '疫苗': ['MRNA', 'BNTX'],
  '生物医药': ['MRNA', 'BNTX'],
  '生物制品': ['MRNA', 'BNTX'],
  '化学制药': ['MRNA', 'BNTX'],
  '中药': ['MRNA', 'BNTX'],
  '医疗服务': ['MRNA', 'BNTX'],
  '半导体': ['NVDA', 'AMD'],
  '芯片': ['NVDA', 'AMD'],
  '集成电路': ['NVDA', 'AMD'],
  '人工智能': ['NVDA', 'MSFT'],
  '算力': ['NVDA', 'MSFT'],
  '光模块': ['NVDA', 'MSFT'],
  '消费电子': ['AAPL', 'NVDA'],
  '新能源车': ['TSLA', 'NIO'],
  '新能源': ['TSLA', 'FSLR'],
  '光伏': ['FSLR', 'TSLA'],
  '锂电池': ['TSLA'],
  // 全球大宗商品联动（有色/黄金/能源的全球定价属性强）
  '有色': ['FCX', 'NEM'],
  '有色金属': ['FCX', 'NEM'],
  '黄金': ['NEM', 'GOLD'],
  '铜': ['FCX'],
  '石油': ['XOM', 'CVX'],
  '石油石化': ['XOM', 'CVX'],
  '能源': ['XOM', 'CVX'],
  '煤炭': ['XOM', 'CVX'],
};

// 从行业名推导美股对标（复用 SECTOR_KEYWORDS 的行业→赛道映射思想）
function _benchmarksForIndustry(industryName) {
  const norm = (industryName || '').replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
  if (!norm) return [];
  for (const [k, v] of Object.entries(US_SECTOR_BENCHMARKS)) {
    const kn = k.replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
    if (norm.includes(kn) || kn.includes(norm)) {
      return v;
    }
  }
  return [];
}

const EXTREME_THRESHOLD = 8; // 隔夜涨跌超 ±8% 视为极端催化

/**
 * 跨市场传导信号：取美股对标股隔夜涨跌，聚合为 A 股板块情绪输入。
 * 极端涨跌（如 MRNA +177%）按 ±15% 封顶后参与平均，避免单一标的过度主导。
 * Part B 增强（20260823i）：signal 按「对标主题与个股行业的关联度」衰减——
 *   医疗器械对标 MRNA/BNTX（主题 mRNA/疫苗）对圣湘生物是弱关联，信号被压低；
 *   生物医药/疫苗股则高关联，几乎不衰减。relevance 可选，由 buildJudgment 传入含经验折扣的有效关联度。
 */
async function getCrossMarketSignal(industryName, relevance = null) {
  const benchmarks = _benchmarksForIndustry(industryName);
  if (!benchmarks.length) {
    return { ok: false, benchmarks: [], avgCapped: 0, signal: 0, extreme: [], relevance: null, relevanceTheme: null, note: '该行业无明确美股对标，跨市场传导不参与' };
  }
  const quotes = await Promise.all(benchmarks.map(async (sym) => {
    try {
      const q = await getQuote(sym);
      return q && typeof q.changePct === 'number' ? { sym, name: q.name, changePct: q.changePct, date: q.date } : null;
    } catch (e) {
      return null;
    }
  }));
  const valid = quotes.filter(q => q != null);
  if (!valid.length) {
    return { ok: false, benchmarks, avgCapped: 0, signal: 0, extreme: [], relevance: null, relevanceTheme: null, note: '美股对标股行情获取失败' };
  }
  const capped = valid.map(q => Math.max(-15, Math.min(15, q.changePct)));
  const avgCapped = capped.reduce((a, b) => a + b, 0) / capped.length;
  const signal = Math.max(-1, Math.min(1, avgCapped / 8));
  // 对标主题关联度（自衰减：医疗器械→MRNA/BNTX 主题=mRNA/疫苗，弱关联）
  const relInfo = valid.map(q => {
    const r = benchmarkRelevance(industryName, q.sym);
    return { sym: q.sym, theme: r.theme, relevance: r.relevance };
  });
  const best = relInfo.slice().sort((a, b) => b.relevance - a.relevance)[0];
  const selfRel = best ? best.relevance : null;
  // 默认不缩放（relevance 为 null），由调用方传入含经验折扣的有效关联度覆盖
  const effRel = (typeof relevance === 'number') ? relevance : 1;
  const scaledSignal = Math.max(-1, Math.min(1, signal * effRel));
  const extreme = valid.filter(q => Math.abs(q.changePct) >= EXTREME_THRESHOLD);
  const note = `美股对标 ${valid.map(q => `${q.name}${q.changePct >= 0 ? '+' : ''}${Math.round(q.changePct)}%`).join('、')}（隔夜 ${valid[0] && valid[0].date || ''}）${effRel !== 1 ? `；对标主题关联度 ${effRel}` : ''}`;
  return {
    ok: true,
    benchmarks: valid,
    avgCapped: Math.round(avgCapped * 10) / 10,
    signal: Math.round(scaledSignal * 1000) / 1000,
    relevance: (typeof relevance === 'number') ? relevance : selfRel,
    relevanceTheme: best ? best.theme : null,
    extreme,
    extremeThreshold: EXTREME_THRESHOLD,
    note,
  };
}

// 对外暴露行业→美股对标（供 buildJudgment 先算有效关联度再回传）
function benchmarksForIndustry(industryName) {
  return _benchmarksForIndustry(industryName);
}

module.exports = { getCrossMarketSignal, benchmarksForIndustry, US_SECTOR_BENCHMARKS };

~~~

---

## `lib\dailyMarketReview.js`  ·  121 行

~~~js
/**
 * 每日「实时大盘 AI 复盘」→ 大盘记录 落盘助手（20261024g）
 * ---------------------------------------------------------------------------
 * 用户 2026-10-24 要求：实时大盘每天下午 3 点收盘后自动解读一次，保存到大盘记录。
 * 本模块只负责「纯逻辑」部分（组装笔记对象 + 同日幂等判定），便于单测；
 * 取数（getMarketOverview）、调用大模型（analyzeMarketOverview）、读写 notes.json 由 server.js 编排。
 *
 * 大盘记录 = data/notes.json 中 scope='market' 的条目（与 public/js/notes.js 的 note 结构一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 与 server.js 的 NOTES_FILE 同一份（data/notes.json）；大盘记录 = scope='market' 的条目
// 支持环境变量覆盖（仅用于回归测试隔离；生产不设置则用默认路径）
const NOTES_FILE = process.env.SA_NOTES_FILE
  ? path.resolve(process.env.SA_NOTES_FILE)
  : path.join(__dirname, '..', 'data', 'notes.json');

const MARKER_PREFIX = 'AI 大盘复盘 · ';

/** 当日复盘记录标题（含日期，用于同日幂等） */
function marketReviewMarker(today) {
  return MARKER_PREFIX + today;
}

/**
 * 组装一条 scope=market 的「AI 大盘复盘」笔记。
 * @param {string} today YYYY-MM-DD
 * @param {object} data  { cn:[{name,changePct}], sectorsUp, sectorsDown }（与首页 /api/market-overview 同源）
 * @param {object} ai    { cn, gainers, losers, model }
 * @returns {object|null} 三段解读全空时返回 null（调用方跳过，不写空记录）
 */
function buildMarketReviewNote(today, data, ai) {
  const cn = String((ai && ai.cn) || '').trim();
  const gainers = String((ai && ai.gainers) || '').trim();
  const losers = String((ai && ai.losers) || '').trim();
  if (!cn && !gainers && !losers) return null;
  const idxTxt = ((data && data.cn) || [])
    .map(i => `${i.name || i.code} ${i.changePct != null ? (i.changePct >= 0 ? '+' : '') + Number(i.changePct).toFixed(2) + '%' : ''}`.trim())
    .join('，');
  const content = [
    `【大盘】${cn || '—'}`,
    `【领涨板块】${gainers || '—'}`,
    `【领跌板块】${losers || '—'}`,
    idxTxt ? `【指数收盘】${idxTxt}` : '',
    `（AI 自动复盘 · 数据源：东方财富行业板块/腾讯行情 · 模型：${(ai && ai.model) || '—'}）`,
  ].filter(Boolean).join('\n');
  return {
    id: 'ai-market-' + String(today).replace(/-/g, '') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    date: new Date().toISOString(),
    scope: 'market',
    aspect: null,
    stockCode: '',
    stockName: '',
    title: marketReviewMarker(today),
    content,
    tags: ['AI复盘', '大盘'],
    type: 'ai',
    ai: true,
    verification: { status: 'pending', result: null, probability: null, lastChecked: null, details: null },
  };
}

/** 当日是否已有 AI 大盘复盘记录（幂等；重启 / 多次触发不重复写） */
function alreadyReviewed(notes, today) {
  const m = marketReviewMarker(today);
  return (Array.isArray(notes) ? notes : []).some(
    n => n && n.scope === 'market' && typeof n.title === 'string' && n.title.includes(m)
  );
}

function readNotes() {
  try {
    const a = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function writeNotes(arr) {
  try {
    fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
    fs.writeFileSync(NOTES_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) { /* 忽略写入失败 */ }
}

/**
 * 把一次 AI 大盘解读写入「大盘记录」（data/notes.json scope=market）。
 * 20261024l：手动「AI 解读」与 15:30 定时复盘共用此入口。
 * 同一交易日（date）已有记录 → **更新**（不重复、不刷屏）；否则新增一条。
 * @param {object} p { date:string(交易日 YYYY-MM-DD), data:object, ai:object }
 * @returns {{saved:boolean, updated?:boolean, reason?:string}}
 */
function saveMarketReviewNote({ date, data, ai }) {
  if (!date) return { saved: false, reason: '缺少日期' };
  const note = buildMarketReviewNote(date, data, ai);
  if (!note) return { saved: false, reason: 'AI 解读内容为空' };
  const notes = readNotes();
  const marker = marketReviewMarker(date);
  const idx = notes.findIndex(n => n && n.scope === 'market' && typeof n.title === 'string' && n.title.includes(marker));
  if (idx >= 0) {
    const old = notes[idx];
    notes[idx] = {
      ...old,
      title: note.title,
      content: note.content,
      tags: note.tags,
      type: 'ai',
      ai: true,
      updatedAt: new Date().toISOString(),
    };
    writeNotes(notes);
    return { saved: true, updated: true };
  }
  notes.unshift(note);
  writeNotes(notes);
  return { saved: true, updated: false };
}

module.exports = { marketReviewMarker, buildMarketReviewNote, alreadyReviewed, saveMarketReviewNote, NOTES_FILE };

~~~

---

## `lib\dataHonesty.js`  ·  83 行

~~~js
/**
 * 数据诚实原则（核心底层逻辑）
 * ================================================================
 * 规则：没有"成功获取"的数据，必须明确告知"获取失败"，绝不能用
 *   ① 其他来源的数据冒充（跨源替代）；
 *   ② 陈旧快照当新数据（除非显式标注 stale / 滞后）；
 *   ③ 零值 / 空值 / 默认值伪装成"已算出"的结果（silent padding）。
 *
 * 所有"数据获取 / 计算"函数应返回以下统一信封之一：
 *   - 成功(实时)： { success:true,  source, fetchedAt, ...data }
 *   - 成功(陈旧)： { success:true,  source, fetchedAt, stale:true, staleReason, ...data }  // 必须显式标注
 *   - 获取失败：   { success:false, source, error, errorType, reason }
 *
 * 调用方/前端据此渲染：fresh=正常 | stale=黄色"滞后/快照" | failed=红色"获取失败"。
 * 本模块不依赖任何外部包，可被任意 lib / 测试 / 前端复用。
 */

function nowISO() {
  return new Date().toISOString();
}

/** 成功（实时/同源）结果 */
function ok(data, meta) {
  meta = meta || {};
  return Object.assign({ success: true, source: meta.source || '', fetchedAt: meta.fetchedAt || nowISO() }, data);
}

/** 成功但数据陈旧（必须显式标注，前端以黄色告警呈现，绝不伪装成实时） */
function stale(data, meta) {
  meta = meta || {};
  return Object.assign(
    { success: true, stale: true, staleReason: meta.reason || '数据滞后/快照（非实时）', source: meta.source || '', fetchedAt: meta.fetchedAt || nowISO() },
    data
  );
}

/** 获取失败：诚实声明，绝不返回零值聚合伪装成功 */
function fail(error, meta) {
  meta = meta || {};
  const msg = (typeof error === 'string') ? error : (error && error.message) || 'UNKNOWN';
  return {
    success: false,
    source: meta.source || '',
    fetchedAt: nowISO(),
    error: msg,
    errorType: meta.errorType || 'FETCH_FAILED',
    reason: meta.reason || msg,
  };
}

/** 分类：fresh | stale | failed */
function classify(r) {
  if (!r || r.success === false || r.ok === false) return 'failed';
  if (r.stale === true) return 'stale';
  return 'fresh';
}

function isFailure(r) { return classify(r) === 'failed'; }
function isStale(r) { return !!(r && r.success === true && r.stale === true); }
function isFresh(r) { return !!(r && r.success === true && !r.stale); }

/**
 * 反"凑数"检测：识别把失败/无数据伪装成成功结果的典型特征。
 * 命中即视为违反诚实原则，交由 test_data_honesty.js 静态断言。
 *
 * 判定：对象看起来像一个"结果"（含 success 字段且为 true，或无 success 但像数据信封），
 * 同时其 stats/summary 类字段全为 0，且伴有 note/error 说明这是失败/不可用。
 * （纯统计助手如 _calcStats 在"空输入"时返回全 0 是合法行为，但调用方必须据此返回
 *   success:false；因此该函数只检测"结果信封级"的伪装，不检测纯统计助手本身。）
 */
function hasSilentPadding(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.success === false || obj.ok === false) return false; // 已诚实声明失败
  const s = obj.stats;
  if (s && typeof s === 'object') {
    const zeroKeys = ['mean', 'std', 'high', 'low', 'median', 'sum', 'avg'].filter(function (k) { return s[k] === 0; });
    if (zeroKeys.length >= 3 && (obj.note || obj.error || obj.reason)) return true;
  }
  return false;
}

module.exports = { ok, stale, fail, classify, isFailure, isStale, isFresh, hasSilentPadding, nowISO };

~~~

---

## `lib\db.js`  ·  238 行

~~~js
// lib/db.js — 工作台本地 SQLite 数据层（Node 22 内置 node:sqlite，零额外依赖）
//
// 设计目标：把工作台的三条底层铁律（一致性 / 最新性 / 边际分析）落到工程化存储。
//   规则一·五要素：每条数据都带 名称/数值/实际时间/来源/获取时间 → 落在 source + fetched_at + as_of 字段。
//   规则二·最新性：data_points 带 valid_until（按数据类型 TTL 推算），读取时校验 isFresh，过期即视为无效。
//   规则三·边际分析：series 表按 as_of 排序，helper 直接计算 变化率 + 边际变化（变化的变化）。
//   分析期数据锁定：analysis_snapshots 冻结每次分析的完整数据，可复现/审计。
//
// 注意：本层只做「缓存 + 结构化存储」，不替代任何外部实时取数逻辑。所有写操作失败都不抛给调用方。

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'data', 'stock_analyzer.db');
let db = null;

// 规则二·按数据类型 TTL（毫秒）。与工作台既有约定一致：
// 实时行情 5 分钟 / 日线 24 小时 / 周线 7 天 / 财务 90 天 / 公司基本信息 30 天。
const TTL = {
  realtime: 5 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  financial: 90 * 24 * 60 * 60 * 1000,
  company: 30 * 24 * 60 * 60 * 1000,
};
function ttlMs(type) {
  return TTL[type] != null ? TTL[type] : TTL.financial;
}

function nowIso() {
  return new Date().toISOString();
}

// 建库 + 建表（幂等）。仅在首次调用时真正打开文件。
function initDb() {
  if (db) return db;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    // WAL：提升并发读性能；busy_timeout：写冲突时短暂等待而非直接报错。
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');

    db.exec(`CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      metric TEXT NOT NULL,
      as_of TEXT NOT NULL,          -- 数据代表的真实时间（如报告期 2025-06-30 / 除权日）
      value REAL,
      source TEXT,                  -- 单一权威来源（如 eastmoney:RPT_SHAREBONUS_DET）
      fetched_at TEXT,              -- 获取时间（五要素之一）
      extra TEXT,                   -- JSON：stage/label/plan/progress 等附加字段
      UNIQUE(symbol, metric, as_of)
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_series_sym_metric ON series(symbol, metric, as_of);');

    db.exec(`CREATE TABLE IF NOT EXISTS data_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      key TEXT NOT NULL,             -- 标量指标标识（如 current_price / industry_pe_avg）
      value REAL,
      value_text TEXT,              -- 非数值型（如方案文字）落这里
      as_of TEXT,                   -- 数据实际时间
      source TEXT,                  -- 来源（五要素）
      fetched_at TEXT,              -- 获取时间（五要素）
      valid_until TEXT,             -- 有效期（规则二 TTL 推算）
      extra TEXT,
      UNIQUE(symbol, key)
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_dp_sym ON data_points(symbol, key);');

    db.exec(`CREATE TABLE IF NOT EXISTS analysis_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      range TEXT,
      created_at TEXT,
      payload TEXT,                 -- 冻结的完整分析数据（JSON）
      UNIQUE(symbol, snapshot_id)
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_snap_sym ON analysis_snapshots(symbol, created_at);');

    console.log(`[DB] sqlite ready at ${DB_PATH}`);
  } catch (e) {
    console.error('[DB] init failed:', e.message);
    db = null; // 允许后续重试
    throw e;
  }
  return db;
}

function getDb() {
  if (!db) initDb();
  return db;
}

function isReady() {
  return db != null;
}

// ---------- series（时序 + 五要素 + 边际）----------

function upsertSeries({ symbol, metric, asOf, value, source, fetchedAt, extra }) {
  const d = getDb();
  const fa = fetchedAt || nowIso();
  d.prepare(
    `INSERT INTO series (symbol, metric, as_of, value, source, fetched_at, extra)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(symbol, metric, as_of) DO UPDATE SET
       value=excluded.value, source=excluded.source, fetched_at=excluded.fetched_at, extra=excluded.extra`
  ).run(symbol, metric, asOf, value, source, fa, extra != null ? JSON.stringify(extra) : null);
}

function getSeries(symbol, metric) {
  const d = getDb();
  const rows = d.prepare(
    `SELECT * FROM series WHERE symbol=? AND metric=? ORDER BY as_of ASC`
  ).all(symbol, metric);
  return rows.map((r) => ({ ...r, extra: r.extra ? JSON.parse(r.extra) : null }));
}

// 在 getSeries 基础上直接计算 变化率 与 边际变化（规则三：变化率 + 边际 + 方向）。
// 变化率 = (当前-前值)/|前值|×100%；边际变化 = 当期变化率 - 上期变化率。
function getSeriesWithMarginal(symbol, metric) {
  const rows = getSeries(symbol, metric);
  return rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const prev2 = i > 1 ? rows[i - 2] : null;
    let changePct = null;
    let marginal = null;
    let direction = null;
    if (prev && prev.value != null && r.value != null && prev.value !== 0) {
      const chg = ((r.value - prev.value) / Math.abs(prev.value)) * 100;
      changePct = Math.round(chg * 100) / 100;
      direction = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
      if (prev2 && prev2.value != null && prev2.value !== 0 && prev.value !== 0) {
        const prevChg = ((prev.value - prev2.value) / Math.abs(prev2.value)) * 100;
        marginal = Math.round((chg - prevChg) * 100) / 100;
      }
    }
    return { ...r, changePct, marginal, direction };
  });
}

// ---------- data_points（标量 + 五要素 + TTL）----------

function upsertDataPoint({ symbol, key, value, valueText, asOf, source, validUntil, fetchedAt, extra, ttlType }) {
  const d = getDb();
  const fa = fetchedAt || nowIso();
  const vu = validUntil || new Date(Date.now() + ttlMs(ttlType || 'financial')).toISOString();
  d.prepare(
    `INSERT INTO data_points (symbol, key, value, value_text, as_of, source, fetched_at, valid_until, extra)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol, key) DO UPDATE SET
       value=excluded.value, value_text=excluded.value_text, as_of=excluded.as_of,
       source=excluded.source, fetched_at=excluded.fetched_at, valid_until=excluded.valid_until, extra=excluded.extra`
  ).run(symbol, key, value != null ? value : null, valueText != null ? valueText : null, asOf != null ? asOf : null, source != null ? source : null, fa, vu, extra != null ? JSON.stringify(extra) : null);
}

function getDataPoint(symbol, key) {
  const d = getDb();
  const r = d.prepare(`SELECT * FROM data_points WHERE symbol=? AND key=?`).get(symbol, key);
  if (!r) return null;
  const valid = r.valid_until ? new Date(r.valid_until).getTime() > Date.now() : true;
  return { ...r, extra: r.extra ? JSON.parse(r.extra) : null, isFresh: valid };
}

// 读取某股票全部标量数据点（供 /api/db/datapoints 使用），附 isFresh 新鲜度。
function getDataPoints(symbol) {
  const d = getDb();
  const rows = d.prepare(`SELECT * FROM data_points WHERE symbol=? ORDER BY key ASC`).all(symbol);
  return rows.map((r) => {
    const valid = r.valid_until ? new Date(r.valid_until).getTime() > Date.now() : true;
    return { ...r, extra: r.extra ? JSON.parse(r.extra) : null, isFresh: valid };
  });
}

// ---------- analysis_snapshots（分析期数据锁定）----------

function saveSnapshot({ symbol, snapshotId, range, payload }) {
  const d = getDb();
  d.prepare(
    `INSERT INTO analysis_snapshots (symbol, snapshot_id, range, created_at, payload)
     VALUES (?,?,?,?,?)
     ON CONFLICT(symbol, snapshot_id) DO UPDATE SET
       range=excluded.range, created_at=excluded.created_at, payload=excluded.payload`
  ).run(symbol, snapshotId, range || null, nowIso(), JSON.stringify(payload));
}

function getLatestSnapshot(symbol) {
  const d = getDb();
  const r = d.prepare(`SELECT * FROM analysis_snapshots WHERE symbol=? ORDER BY created_at DESC LIMIT 1`).get(symbol);
  if (!r) return null;
  return { ...r, payload: r.payload ? JSON.parse(r.payload) : null };
}

function getSnapshots(symbol, limit = 10) {
  const d = getDb();
  return d.prepare(`SELECT snapshot_id, range, created_at FROM analysis_snapshots WHERE symbol=? ORDER BY created_at DESC LIMIT ?`).all(symbol, limit);
}

// 健康检查：返回库状态 + 各表行数（供 /api/db/health 使用）
function getDbInfo() {
  const result = { path: DB_PATH, ready: isReady(), tables: {} };
  if (!db) return result;
  for (const t of ['series', 'data_points', 'analysis_snapshots']) {
    try {
      result.tables[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    } catch {
      result.tables[t] = -1;
    }
  }
  return result;
}

module.exports = {
  DB_PATH,
  initDb,
  getDb,
  isReady,
  ttlMs,
  // series
  upsertSeries,
  getSeries,
  getSeriesWithMarginal,
  // data_points
  upsertDataPoint,
  getDataPoint,
  getDataPoints,
  // snapshots
  saveSnapshot,
  getLatestSnapshot,
  getSnapshots,
  // meta
  getDbInfo,
};

~~~

---

## `lib\dedicatedFactor.js`  ·  327 行

~~~js
/**
 * 专属因子引擎 v1（20260911）
 * ----------------------------------------------------------------------------
 * 用途：为特定个股提供「非常驻专属因子」卡片，工作机制与 eventEngine（突发事件因子）完全一致：
 *   - 非常驻：无触发数据时不占权重、卡片自动隐藏（与事件驱动因子同口径）；
 *   - 触发时：常驻因子按「事件权重 + 专属权重」之和等比压缩，腾出空间给非常驻因子；
 *   - 衰减：有效权重随触发后时间边际递增式衰减（w = base·(1 - r^exp)，r=已过去比例），
 *           衰减到 0 自动隐藏，等待下一个周期触发；
 *   - 权重上限：常驻 + 非常驻权重之和恒 ≤ 100%（mergeNonResidentOverrides 统一归并）。
 *
 * 首个落地的专属因子：海天味业(603288) ——「CPI·食品烟酒及在外餐饮」
 *   触发：每月 8~13 日（国家统计局 CPI 发布窗口）自动检索最新一期 CPI；
 *   权重：短期 10% / 长期 10%（暂定，后续由准确率模型自学习调整）；
 *   衰减：短期 3 天 / 长期 15 天（暂定）；
 *   信号：食品烟酒及在外餐饮 同比/环比 → 映射为多空信号（占位规则，后续由准确率模型校准）。
 *
 * 设计铁律（与 eventEngine 一致）：
 *   - 计算层=代码（纯四则 + 固定阈值/乘数），不依赖 LLM 决定权重；
 *   - 输入锁死 ⇒ 结果锁死（1+1=2）；
 *   - 仅影响配置了专属因子的个股，其他个股零改动（按 symbol 过滤）。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const DAY = 86400000;

const DIR = path.join(__dirname, '..', 'data', 'dedicatedFactors');
const ACTIVE_FILE = path.join(DIR, 'active.json');
const HISTORY_FILE = path.join(DIR, 'history.json');
const STATE_FILE = path.join(DIR, 'state.json');

// ===== 专属因子注册表（按个股 + 因子键）=====
// 后续新增个股/因子只需在此追加，无需改动判断模块接线。
const DEDICATED_FACTOR_DEFS = {
  '603288': [ // 海天味业
    {
      key: 'cpiFood',
      name: 'CPI·食品烟酒及在外餐饮',
      // 权重（暂定 10%，后续准确率模型自学习调整）
      weightShort: 0.10,
      weightLong: 0.10,
      // 衰减窗口（天）
      decayShortDays: 3,
      decayLongDays: 15,
      // 边际递增式衰减：有效权重 = base·(1 - r^decayExp)，r=已过去/窗口。
      // decayExp>1 ⇒ 前期保留高、末期骤降（每日边际衰减额递增）；decayExp 亦可由准确率模型校准。
      decayExp: 2,
      // 信号映射规则标识（见 computeSignal）
      signalRule: 'food_cpi_haitian',
      // 月度触发：国家统计局 CPI 一般于次月 9~10 日发布，取每月 8~13 日为检索窗口
      trigger: { type: 'monthly_cpi', windowDays: [8, 9, 10, 11, 12, 13], source: 'NBS' },
    },
  ],
};

// ===== IO =====
function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
function _read(f, fallback) {
  ensureDir();
  try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) ? a : fallback; }
  catch (e) { return fallback; }
}
function _write(f, data) { ensureDir(); fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8'); }
function loadActive() { return _read(ACTIVE_FILE, []); }
function saveActive(a) { _write(ACTIVE_FILE, a); }
function loadHistory() { return _read(HISTORY_FILE, []); }
function saveHistory(a) { _write(HISTORY_FILE, a.slice(0, 100)); }
function loadState() {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) { ensureDir(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); }

// ===== 工具 =====
function round(x, n) { const p = Math.pow(10, n || 4); return Math.round(x * p) / p; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dirArrow(s) { return s > 0 ? '▲' : s < 0 ? '▼' : '—'; }
function dirLabel(s) { return s > 0 ? '利好' : s < 0 ? '利空' : '中性'; }
function normSymbol(sym) { return String(sym || '').replace(/^(sh|sz|bj)/i, '').trim(); }

// 边际递增式衰减：w = base·(1 - r^exp)，r∈[0,1]
function effectiveWeight(base, days, createdAt, now, exp) {
  if (!base || !days || days <= 0) return 0;
  const elapsed = now - createdAt;
  if (elapsed <= 0) return base;
  const r = elapsed / (days * DAY);
  if (r >= 1) return 0;
  const e = (exp && exp > 0) ? exp : 2;
  return base * (1 - Math.pow(r, e));
}

// 计算触发所属的统计期（上个月的 YYYY-MM）。国家统计局于次月 9~10 日发布上月 CPI，
// 故在窗口内检索的「最新」即上个月。
function prevMonthPeriod(now) {
  const d = new Date(now);
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ===== 信号映射（占位规则，后续由准确率模型校准）=====
// food_cpi_haitian：食品烟酒及在外餐饮 CPI 上行 → 调味品龙头定价权/营收利好；
//   综合 = 0.6·同比 + 0.4·环比，归一化到 [-1,1]（约 3% 读数≈满仓信号）。
// 注：此方向判定为初始占位，准确率模型后续会同时校准「权重」与「信号映射」。
function computeSignal(rule, data) {
  const yoy = Number(data && data.yoy);
  const mom = Number(data && data.mom);
  const y = Number.isFinite(yoy) ? yoy : 0;
  const m = Number.isFinite(mom) ? mom : 0;
  if (rule === 'food_cpi_haitian') {
    const combined = y * 0.6 + m * 0.4;
    return round(clamp(combined / 3, -1, 1), 3);
  }
  return 0;
}

// ===== 子因子各自的独立方向（20260913f 修复）=====
// 问题：原实现把「因子总信号（0.6×同比+0.4×环比 合成）」同时套给同比与环比两个子维度，
//   导致环比 +0.3%（价格环比上行=利好）被显示成「利空」——与用户反馈的语义错误一致。
// 修复：子维度各按**自身数值**定方向（上行=利好、下行=利空），因子总信号仍为加权合成，两者不混用。
// 阈值口径与 computeSignal 一致：±3% 读数 ≈ 满格信号。
function computeSubSignals(rule, data) {
  const dir = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return round(clamp(n / 3, -1, 1), 3);
  };
  const yoy = (data && data.yoy != null) ? data.yoy : null;
  const mom = (data && data.mom != null) ? data.mom : null;
  if (rule === 'food_cpi_haitian') return { yoy: dir(yoy), mom: dir(mom) };
  return { yoy: 0, mom: 0 };
}

// ===== 查询：某股在某口径下的活跃专属因子（已是「因子卡片」对象）=====
function getDedicatedFactorsForSymbol(symbol, horizon) {
  const sym = normSymbol(symbol);
  const now = Date.now();
  const defs = DEDICATED_FACTOR_DEFS[sym];
  if (!defs || !defs.length) return [];
  const active = loadActive().filter(a => a.symbol === sym && a.status === 'active');
  const out = [];
  for (const a of active) {
    const def = defs.find(d => d.key === a.factorKey);
    if (!def) continue;
    const base = horizon === 'long' ? a.weightLong : a.weightShort;
    const days = horizon === 'long' ? a.decayLongDays : a.decayShortDays;
    const exp = a.decayExp || def.decayExp || 2;
    const eff = effectiveWeight(base, days, Date.parse(a.createdAt), now, exp);
    if (eff <= 0) continue;
    const cAt = Date.parse(a.createdAt);
    const remain = Math.max(0, Math.ceil((days * DAY - (now - cAt)) / DAY));
    const signal = (typeof a.signal === 'number') ? a.signal : 0;
    // 20260913f：子维度各按自身数值定方向（同比/环比互不沿用总信号），修复「环比为正却标利空」。
    const ss = computeSubSignals(def.signalRule, a.data);
    const tone = (v) => v > 0 ? '上行 → 利好' : v < 0 ? '下行 → 利空' : '持平 → 中性';
    out.push({
      key: a.factorKey,
      name: a.name,
      weight: round(eff, 4),
      signal,
      applicable: true,
      remainingDays: remain,
      value: `食品烟酒及在外餐饮：同比 ${yoyFmt(a.data && a.data.yoy)} / 环比 ${yoyFmt(a.data && a.data.mom)}`,
      detail: `国家统计局CPI·食品烟酒及在外餐饮；总信号按 0.6×同比 + 0.4×环比 合成（子维度各按自身方向判读）；权重${(eff * 100).toFixed(1)}%（暂定10%）；剩${remain}天自动隐藏（边际递增式衰减）；后续由准确率模型自学习调整。`,
      // 用户要求：统计期/来源不再单独成卡片，改为数据下方小字标注（caption）
      caption: `数据日期：${a.period} · 来源：${(a.data && a.data.source) || '国家统计局'}`,
      subFactors: [
        {
          key: 'yoy', name: '同比', signal: ss.yoy, value: yoyFmt(a.data && a.data.yoy),
          detail: `同比 ${yoyFmt(a.data && a.data.yoy)}，${tone(ss.yoy)}（食品烟酒及在外餐饮价格同比上行，利好调味品龙头定价权与营收）`,
        },
        {
          key: 'mom', name: '环比', signal: ss.mom, value: yoyFmt(a.data && a.data.mom),
          detail: `环比 ${yoyFmt(a.data && a.data.mom)}，${tone(ss.mom)}（环比反映最近一个月价格的边际变化，边际上行即边际改善）`,
        },
      ],
    });
  }
  return out;
}
function yoyFmt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
}

// 复用事件因子的覆盖结构：返回 { combinedWeight, dedicatedFactors } 或 null（无激活时）。
function buildDedicatedOverride({ symbol, baseWeights, factorKeys, horizon }) {
  const list = getDedicatedFactorsForSymbol(symbol, horizon);
  if (!list.length) return null;
  const combinedWeight = round(list.reduce((a, f) => a + f.weight, 0), 4);
  return { combinedWeight, dedicatedFactors: list, horizon };
}

// ===== 归并多个非常驻因子（事件 + 专属）的权重覆盖 =====
// 常驻因子按 (1 - 非常驻合计权重) 等比压缩；非常驻因子各自带有效权重，总和恒 ≤ 100%。
function mergeNonResidentOverrides(baseWeights, factorKeys, nrList) {
  let combinedNR = nrList.reduce((a, n) => a + (n.weight || 0), 0);
  combinedNR = Math.min(combinedNR, 0.95); // 硬上限：常驻至少保留 5%
  const override = {};
  for (const k of factorKeys) {
    const base = baseWeights[k] != null ? baseWeights[k] : (1 / factorKeys.length);
    override[k] = round(base * (1 - combinedNR), 4);
  }
  const factors = nrList.map(n => n.factor);
  return { override, factors, combinedNR: round(combinedNR, 4) };
}

// ===== 联网抓取 CPI 食品烟酒及在外餐饮（运行时自动触发用）=====
// 仅在配置了 AI Key 时尝试；失败返回 null（此时由 Agent/手动种子数据兜底）。
async function fetchCpiFood(period) {
  let aiCfg;
  try { aiCfg = require('./ai/config').loadConfig(); } catch (e) { return null; }
  if (!aiCfg || !aiCfg.apiKey) return null;
  try {
    const { callLLM, pickModelFor } = require('./ai/llm');
    const pick = pickModelFor(aiCfg, 'web');
    const prompt = `请检索国家统计局《${period}月份居民消费价格》官方数据，提取其中「食品烟酒及在外餐饮类」价格的同比与环比涨跌幅。
只输出JSON：{"yoy": 数字(同比%, 下降为负), "mom": 数字(环比%, 下降为负), "source": "国家统计局", "url": "官方链接"}。
若未找到该统计期数据，输出 {"notFound": true}。`;
    const content = await callLLM(aiCfg.provider, aiCfg.apiKey, pick.model, [
      { role: 'system', content: '你是宏观数据检索助手，只输出JSON。' },
      { role: 'user', content: prompt },
    ], { webSearch: pick.webSearch, timeoutMs: 90000 });
    const p = (() => { try { let s = String(content).trim().replace(/^```(?:json)?/i, '').replace(/```$/, ''); return JSON.parse(s); } catch (e) { return null; } })();
    if (!p || p.notFound) return null;
    const yoy = Number(p.yoy), mom = Number(p.mom);
    if (!Number.isFinite(yoy) || !Number.isFinite(mom)) return null;
    return { yoy, mom, source: p.source || '国家统计局', url: p.url || '', period };
  } catch (e) {
    console.warn('[dedicatedFactor] fetchCpiFood 失败:', e && e.message);
    return null;
  }
}

// ===== 触发：窗口内检索最新 CPI 并落库（月度自动 / 手动均可调用）=====
async function triggerDedicatedFactors({ force } = {}) {
  const now = new Date();
  const dom = now.getDate();
  const inWindow = dom >= 8 && dom <= 13;
  if (!inWindow && !force) {
    return { ok: true, triggered: false, reason: 'not_in_window', today: dom };
  }
  const period = prevMonthPeriod(now); // 最新统计期（上月）
  const st = loadState();
  // 每月仅在窗口内尝试一次（避免重复联网）
  if (!force && st.lastAttemptPeriod === period) {
    return { ok: true, triggered: false, reason: 'already_attempted_this_period', period };
  }
  let triggered = [];
  const changedSymbols = new Set();
  const active = loadActive();
  for (const sym of Object.keys(DEDICATED_FACTOR_DEFS)) {
    for (const def of DEDICATED_FACTOR_DEFS[sym]) {
      if (def.trigger && def.trigger.type === 'monthly_cpi') {
        // 若该统计期已有实例则跳过
        if (active.some(a => a.symbol === sym && a.factorKey === def.key && a.period === period)) continue;
        const data = await fetchCpiFood(period);
        if (!data) { console.warn(`[dedicatedFactor] ${sym}/${def.key} ${period} 抓取失败，等待 Agent/手动种子`); continue; }
        const signal = computeSignal(def.signalRule, data);
        const createdAt = Date.now();
        const inst = {
          id: `df_${sym}_${def.key}_${period}`,
          symbol: sym, factorKey: def.key, name: def.name,
          period, data, signal,
          weightShort: def.weightShort, weightLong: def.weightLong,
          decayShortDays: def.decayShortDays, decayLongDays: def.decayLongDays,
          decayExp: def.decayExp,
          decayShortEnd: new Date(createdAt + def.decayShortDays * DAY).toISOString(),
          decayLongEnd: new Date(createdAt + def.decayLongDays * DAY).toISOString(),
          status: 'active', createdAt: new Date(createdAt).toISOString(),
          engineVersion: 'v1',
        };
        // 同因子更旧统计期的激活实例归档（避免重复卡片）
        const kept = [];
        for (const a of active) {
          if (a.symbol === sym && a.factorKey === def.key && a.period && a.period < period && a.status === 'active') {
            a.status = 'archived'; a.archivedAt = inst.createdAt;
            const hist = loadHistory(); hist.unshift(a); saveHistory(hist);
            changedSymbols.add(sym); // 旧实例归档 → 该股判断需重算
          } else kept.push(a);
        }
        kept.push(inst);
        saveActive(kept);
        triggered.push(inst.id);
        changedSymbols.add(sym); // 新实例生成 → 该股判断需重算
      }
    }
  }
  st.lastAttemptPeriod = period;
  saveState(st);
  return { ok: true, triggered, changedSymbols: [...changedSymbols], period, inWindow };
}

// 过期清理（衰减为 0 的激活实例归档，避免数据无限堆积）
function cleanupExpired() {
  const now = Date.now();
  const active = loadActive();
  const remain = [];
  let archived = 0;
  const changedSymbols = new Set();
  for (const a of active) {
    if (a.status !== 'active') { remain.push(a); continue; }
    const effShort = effectiveWeight(a.weightShort, a.decayShortDays, Date.parse(a.createdAt), now, a.decayExp || 2);
    const effLong = effectiveWeight(a.weightLong, a.decayLongDays, Date.parse(a.createdAt), now, a.decayExp || 2);
    if (effShort <= 0 && effLong <= 0) {
      a.status = 'archived'; a.archivedAt = new Date().toISOString();
      const hist = loadHistory(); hist.unshift(a); saveHistory(hist); archived++;
      changedSymbols.add(a.symbol); // 到期归档 → 该股判断需重算（卡片自动隐藏）
    } else remain.push(a);
  }
  if (archived) saveActive(remain);
  return { ok: true, archived, changedSymbols: [...changedSymbols] };
}

module.exports = {
  DEDICATED_FACTOR_DEFS,
  loadActive, saveActive, loadHistory,
  effectiveWeight, computeSignal, computeSubSignals, prevMonthPeriod,
  getDedicatedFactorsForSymbol, buildDedicatedOverride, mergeNonResidentOverrides,
  triggerDedicatedFactors, cleanupExpired, fetchCpiFood,
  DIR,
};

~~~

---

## `lib\deep\conclusion.js`  ·  662 行

~~~js
/**
 * lib/deep/conclusion.js —— deepAnalysis 领域子模块：估值综合结论生成（generateConclusion + 文案）
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 单独成文件原因：原主流程块近 940 行超出粒度上限，且「估值综合结论」与「主流程编排」是两个内聚职责。
 * generateConclusionText 仅被 generateConclusion 内部调用，不导出。
 */
const { fmtPrice, fmtPct, toYi } = require('./shared');
const { formatValuationLine } = require('../valuationHub');
const { localDate, localCompact, localDateFromTs } = require('../localDate');

// ---- 估值结论生成 ----
async function generateConclusion(dcf, valuation, growth, cashFlowData, revenueCostData, balanceAnalysis, auditOpinion, shareholders, companyType, dividends, quote, insuranceAnalysis) {
  const methods = [];
  const ratings = []; // Each: { method, rating, detail, weight }
  // 20260909h：hoist 到函数作用域，使「通用评级 if」与「个股专属模型分支」都能读写，
  // 且专属分支在通用 if 之外独立运行（即使通用无有效评级，专属模型仍执行）。
  let overallRating = null;
  let conclusionText = '';
  const currentPrice = quote?.price || dcf?.currentPrice || 0;
  const ct = companyType?.type || 'balanced';
  // 计算每股指标（用于把 PE/PB/PS 估值带换算为价格级合理估值区间）
  const latestVal = valuation?.valuationData?.[valuation.valuationData.length - 1];
  const totalSharesFV = shareholders?.totalShares || quote?.fundamentals?.totalShares || quote?.totalShares || 0;
  let eps = 0, bvps = 0;
  // 优先用当前PE(TTM)反推EPS，保证与「当前PE(TTM)」口径一致；否则 fallback 到最近年报净利润/总股本
  if (currentPrice > 0 && valuation?.currentPeTtm > 0) {
    eps = currentPrice / valuation.currentPeTtm;
  } else if (latestVal && totalSharesFV > 0) {
    // latestVal.netProfit/netAssets 已转为「亿」(÷1e8)，换算回「元」再 ÷ 股数
    eps = (latestVal.netProfit * 1e8) / totalSharesFV;
  }
  if (latestVal && totalSharesFV > 0) {
    bvps = (latestVal.netAssets * 1e8) / totalSharesFV;
  }
  const ctName = companyType?.typeName || '均衡型';
  // 20261016b（审计 F1）：原此处声明的 `weights` 为死变量（全文件零引用）已删除。
  // 基本面四维计分不按公司类型改权重——正常路径固定每维满分 25（见 lib/analysis.js computeFundamentalScore），
  // companyType.weights 仅在 legacy 兜底分支生效，本结论模块不消费它。
  const isInsurance = !!(insuranceAnalysis && insuranceAnalysis.isInsurance);
  const revenueGrowth = companyType?.classificationData?.revenueGrowth || 0;
  const isHighGrowth = !isInsurance && revenueGrowth >= 20;
  const isLowGrowth = !isInsurance && revenueGrowth < 20;

  // 1. DCF 估值法：非保险企业仅保留 PE 估值带，DCF/PB/股息率不再纳入估值方法与综合区间（dcf 对象仍用于结论文本中的参数展示）。

  // 1b. 保险公司专属估值：P/EV + DDM（与 DCF 并行参与综合评分）
  if (isInsurance && insuranceAnalysis.sections) {
    const { pevValuation, ddmValuation } = insuranceAnalysis.sections;
    if (pevValuation && pevValuation.currentPEV > 0) {
      methods.push('P/EV内含价值');
      const pev = pevValuation.currentPEV;
      // 20261016b 三档铁律：原四档（含「偏高」）→ 严格三档；原 1.5~2.0「偏高」带并入「高估」
      const pevRating = pev < 0.8 ? '低估' : pev < 1.5 ? '合理' : '高估';
      // 每股内含价值 = 股价 / P/EV（P/EV=1.0 时的合理股价锚）
      const perShareEV = (currentPrice > 0 && pev > 0) ? Math.round((currentPrice / pev) * 100) / 100 : 0;
      ratings.push({
        method: 'P/EV内含价值',
        rating: pevRating,
        detail: `当前P/EV ${pev.toFixed(2)}；${pevValuation.interpretation}`,
        weight: 0.35,
        fairValue: perShareEV,
      });
    }
    if (ddmValuation && ddmValuation.intrinsicValue > 0) {
      methods.push('DDM股息贴现');
      ratings.push({
        method: 'DDM股息贴现',
        rating: ddmValuation.rating,
        detail: `两阶段DDM内在价值 ¥${ddmValuation.intrinsicValue.toFixed(2)}，较现价${ddmValuation.premium > 0 ? '高估' : '低估'}${Math.abs(ddmValuation.premium).toFixed(1)}%。`,
        weight: 0.25,
        fairValue: Math.round(ddmValuation.intrinsicValue * 100) / 100,
      });
    }
  }

  // 2. PE 估值带法
  // 非保险企业均以 PE 为核心估值锚：低增长企业 PE 占绝对主导，高增长企业 PE/PB/DCF 均衡。
  const peStats = valuation?.peStats;
  if (peStats && peStats.mean > 0 && !isInsurance) {
    // 当前 PE 采用行情 TTM 口径（currentPeTtm），不再停留在最近年报静态 PE
    const latestPE = valuation?.currentPeTtm || valuation.valuationData[valuation.valuationData.length - 1]?.pe || 0;
    if (latestPE > 0) {
      let rating, label;
      const epsNote = eps > 0 ? `；按当前PE反推每股收益(TTM)约¥${eps.toFixed(2)}` : '';
      if (latestPE < peStats.low) { rating = '低估'; label = `当前PE ${latestPE}，低于历史-1σ区间(${peStats.low})，估值偏低${epsNote}`; }
      else if (latestPE <= peStats.high) { rating = '合理'; label = `当前PE ${latestPE}，处于历史均值±1σ区间(${peStats.low}~${peStats.high})内，估值合理${epsNote}`; }
      // 20261016b 三档铁律：原「偏高」档并入「高估」（语义同属高估侧）；描述文案保留「估值偏高」以便阅读
      else if (latestPE <= peStats.mean * 1.5) { rating = '高估'; label = `当前PE ${latestPE}，高于历史+1σ(${peStats.high})，估值偏高${epsNote}`; }
      else { rating = '高估'; label = `当前PE ${latestPE}，远高于历史均值(${peStats.mean})，估值过高${epsNote}`; }
      // 规则一②/规则二：补数据来源与数据时间；规则三：补方向、幅度与边际
      const rPE = valuation.rules && valuation.rules.latest && valuation.rules.latest.pe;
      const aPE = valuation.rules && valuation.rules.analysis && valuation.rules.analysis.PE;
      if (rPE) label += `；数据来源 ${rPE.source}，数据时间 ${rPE.dataTime}`;
      if (aPE && aPE.available) label += `；${aPE.direction}，变化率 ${aPE.changeRate}%，边际 ${aPE.marginal}，${aPE.accel}`;
      const peFairLow = eps > 0 ? Math.round(eps * peStats.low * 100) / 100 : 0;
      const peFairHigh = eps > 0 ? Math.round(eps * peStats.high * 100) / 100 : 0;
      const peFairMean = eps > 0 ? Math.round(eps * peStats.mean * 100) / 100 : 0;
      methods.push('PE估值带');
      const peWeight = isLowGrowth
        ? (ct === 'dividend' ? 0.45 : 0.55)
        : (ct === 'growth' ? 0.35 : ct === 'value' ? 0.35 : ct === 'dividend' ? 0.40 : 0.35);
      ratings.push({ method: 'PE估值带', rating, detail: label, weight: peWeight, fairValue: peFairMean, fairValueRange: [peFairLow, peFairHigh] });
    }
  }

  // 3. PB 估值带法（非保险企业仅作图表展示，不再纳入估值方法与综合区间）

  // 4. PS 估值带法
  // 所有非保险企业均不以 PS 作为估值依据：低增长企业以 PE 为主，高增长企业使用 PE/PB/DCF。
  // PS 统计仍保留供估值图表展示，但不参与综合评级与合理估值区间计算。
  const psStats = valuation?.psStats;

  // 5. Dividend yield analysis（非保险企业仅作图表展示，不再纳入估值方法与综合区间）

  // 汇总各方法的「价格级合理估值」用于综合区间
  // 保险公司：P/EV + DDM 纳入综合区间；非保险企业：仅采用 PE 估值带（DCF/PB 偏差过大）
  const fairPoints = [];
  for (const r of ratings) {
    if (r.fairValue != null && r.fairValue > 0) {
      if (isInsurance && r.method === 'DCF现金流折现') continue;
      if (!isInsurance && r.method !== 'PE估值带') continue;
      const low = (r.fairValueRange && r.fairValueRange[0] != null) ? r.fairValueRange[0] : r.fairValue;
      const high = (r.fairValueRange && r.fairValueRange[1] != null) ? r.fairValueRange[1] : r.fairValue;
      fairPoints.push({ method: r.method, price: r.fairValue, low, high });
    }
  }
  let fairValueRange = null, fairValueCenter = null;
  if (fairPoints.length > 0) {
    const prices = fairPoints.map(p => p.price).sort((a, b) => a - b);
    fairValueCenter = Math.round(prices[Math.floor(prices.length / 2)] * 100) / 100;
    const lows = fairPoints.map(p => p.low).sort((a, b) => a - b);
    const highs = fairPoints.map(p => p.high).sort((a, b) => a - b);
    fairValueRange = [Math.round(lows[0] * 100) / 100, Math.round(highs[highs.length - 1] * 100) / 100];
  }

  // 综合评级 (weighted by company type)
  // 20261016b 全局评级铁律（G4/DA6）：评级文案严格三档「低估 / 合理 / 高估」，禁用「偏高」等主观词。
  // 子方法侧已不再产出「偏高」（见 :51 / :85）；此处保留 '偏高' → 1 仅用于兼容历史缓存或外部输入，
  // 最终 overallRating 只会从三档产出（见下方阈值）。
  const scoreMap = { '低估': -1, '合理': 0, '偏高': 1, '高估': 2 };
  // 原 reverseMap（数字 → 档位）全项目无引用（死代码）且含「偏高」档，随三档统一一并移除。
  const validRatings = ratings.filter(r => r.rating);
  if (validRatings.length > 0) {
    // Weighted average
    const totalWeight = validRatings.reduce((s, r) => s + (r.weight || 0.25), 0);
    const weightedScore = validRatings.reduce((s, r) => s + scoreMap[r.rating] * (r.weight || 0.25), 0) / totalWeight;
    // 20261016b 三档铁律：原四档中「偏高」带（weightedScore 0.5~1.5）语义属高估侧，并入「高估」；
    // 分界取 0.5（即原「合理 | 偏高」边界），其余阈值不变。
    if (weightedScore <= -0.5) overallRating = '低估';
    else if (weightedScore <= 0.5) overallRating = '合理';
    else overallRating = '高估';

    // 生成综合结论文本 (with company type focus)
    conclusionText = generateConclusionText(overallRating, currentPrice, dcf, valuation, growth, cashFlowData, revenueCostData, auditOpinion, validRatings, companyType, dividends, quote, insuranceAnalysis, fairValueCenter, fairValueRange);
  } // 关闭「通用评级 if」——专属确定性模型分支在 if 之外独立运行

  // ===== 个股专属估值模型（20260909h 起全部移出通用 if）：601318 / 300319 / 688289 / 603288 / 600460 / 000783 / 600909 / 688660 =====
  // 20260909h：原嵌套在「通用评级 if（validRatings>0）」内部，导致 PE 为负的周期股（如 688660）通用无有效评级 → 整个 if 被跳过 → 专属模型不执行。
  // 现移出 if 独立运行：无论通用是否有有效评级，专属确定性模型都会执行（输入锁死 ⇒ 结果锁死）。
  // 20260908l：sym 提取补 quote.code（腾讯行情返回裸代码，quote.symbol 为 undefined，此前仅保险股经 insuranceAnalysis.symbol 命中）
  const sym = String(insuranceAnalysis?.symbol || quote?.code || quote?.symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (sym === '601318') {
      try {
        const paModel = require('../valuation/pingAn601318.js');
        const cfg = paModel.loadInputs();
        if (cfg) {
          // 仅 P（现价）取实时行情，其余财报输入全部为锁死值，保证「同样数据 ⇒ 同样结果」
          if (currentPrice) { cfg.inputs.P = Object.assign({}, cfg.inputs.P, { value: currentPrice, source: `实时行情 ${localDate()}`, asOf: localDate() }); }
          const pa = paModel.compute(cfg);
          if (pa && pa.ok && pa.fairValueRange) {
            overallRating = pa.rating;
            fairValueRange = pa.fairValueRange;
            fairValueCenter = pa.fairValueCenter;
            methods.length = 0;
            // 20261029b：v3 极值法合成（P/EV + DDM + SOTP 三模型极值），替代 v2「只采用 SOTP」
            methods.push('P/EV核心锚（核心聚焦区间）', 'DDM双参（极值法合成）');
            if (!pa.sotpSkipped) methods.push('SOTP分部估值（极值法合成）');
            ratings.length = 0;
            // v3 null 防护：DDM（D 缺失/0）与 EVPS 均可能 N/A，禁止直接 .toFixed(2)
            if (pa.raw.EVPS != null) {
              ratings.push({ method: 'P/EV核心锚（核心聚焦区间）', rating: pa.rating, weight: 1.0, fairValueRange: pa.focusRange, detail: `EVPS ${pa.raw.EVPS.toFixed(2)} 元 × 0.65~0.90 倍` });
            }
            if (pa.raw.ddmCons != null && pa.raw.ddmOpt != null) {
              ratings.push({ method: 'DDM股息贴现', rating: '合理', weight: 0, fairValueRange: [pa.raw.ddmCons, pa.raw.ddmOpt], detail: `保守 ${pa.raw.ddmCons.toFixed(2)}（10%/3.5%）~ 乐观 ${pa.raw.ddmOpt.toFixed(2)}（8%/5.0%）` });
            } else {
              ratings.push({ method: 'DDM股息贴现', rating: 'N/A', weight: 0, fairValueRange: null, detail: 'D 缺失或为 0 → DDM 两值记 N/A，不参与合成（滚动协议 v3 第二站）' });
            }
            if (!pa.sotpSkipped && pa.raw.sotpTarget != null) {
              ratings.push({ method: 'SOTP分部估值', rating: '合理', weight: 0, fairValueRange: [pa.raw.lowC, pa.raw.highC], detail: `目标价 ${pa.raw.sotpTarget.toFixed(2)} 元 ±10%（参与极值法合成）` });
            }
            // 20260908i：综合估值评级卡片（deepConclusion）只保留可视化内容（评级徽章/区间定位条/方法 chips），
            // 详细文字表格与口径说明全部下沉到下方专属估值模型三段式卡片，避免两张卡重复展示。
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[专属估值模型] 601318 计算失败，回退通用逻辑:', e.message);
      }
    } else if (sym && sym !== '601318') {
      // ===== 券商专属「分类+估值」（20260908l）：仅限 data/valuation/{symbol}.json kind==='broker' 的标的 =====
      // 顶部综合估值评级卡引用券商模型结果（可视化内容），明细文字在下方专属三段式卡片。
      try {
        const brokerModel = require('../valuation/brokerModel');
        if (brokerModel.isBrokerModel(sym)) {
          const br = brokerModel.run(sym, { price: currentPrice });
          if (br && br.ok) {
            overallRating = br.rating;
            fairValueRange = br.fairValueRange;
            fairValueCenter = br.fairValueCenter;
            methods.length = 0;
            Array.prototype.push.apply(methods, br.methodsUsed || []);
            // 20260908i口径：可视化卡片只保留图形内容（评级/区间条/方法chips），文字明细下沉专属卡
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[券商专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }
    // ===== 圣湘生物专属「六模型交叉验证」（20260908n）：data/valuation/688289.json kind==='sanxi' 闸门 =====
    if (sym === '688289') {
      // 顶部综合估值评级卡引用圣湘模型结果（可视化内容），明细文字在下方专属卡。
      try {
        const sanxiModel = require('../valuation/sanxi688289.js');
        if (sanxiModel.isSanxiModel(sym)) {
          const sx = await sanxiModel.run(sym, { price: currentPrice });
          if (sx && sx.ok) {
            overallRating = sx.rating;
            fairValueRange = sx.fairValueRange;
            fairValueCenter = sx.fairValueCenter;
            methods.length = 0;
            Array.prototype.push.apply(methods, ['轨道I·相对估值(50%)', '轨道II·SOTP(35%)', '轨道III·历史分位(15%)', '五表锚定·TTM拼接', '风险折价·仅下调']);
            // 20260908i口径：可视化卡片只保留图形内容（评级/区间条/方法chips），文字明细下沉专属卡
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[圣湘专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }
    // ===== 海天味业专属「动态估值引擎」（20260908o）：data/valuation/603288.json kind==='haitian' 闸门 =====
    if (sym === '603288') {
      // 顶部综合估值评级卡引用海天动态引擎结果（可视化内容），明细文字在下方专属卡。
      try {
        const haitianModel = require('../valuation/haitian603288.js');
        if (haitianModel.isHaitianModel(sym)) {
          // 20261029n：V3.0 全量重算架构 → run 改 async（每次实时拉三表，禁读缓存）
          const ht = await haitianModel.run(sym, { price: currentPrice });
          if (ht && ht.ok) {
            overallRating = ht.rating;
            fairValueRange = ht.fairValueRange;
            fairValueCenter = ht.fairValueCenter;
            methods.length = 0;
            Array.prototype.push.apply(methods, ['DCF锚(50%)·预测驱动', '动态PE校准(50%)', '三情景·结构隔离', '三表勾稽+双模型校验']);
            // 20260908i口径：可视化卡片只保留图形内容，文字明细下沉专属卡
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[海天专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }
    // ===== 士兰微专属估值模型（20260908p）：data/valuation/600460.json kind==='silan' 闸门 =====
    if (sym === '600460') {
      // 顶部综合估值评级卡引用士兰模型结果（可视化内容），明细文字在下方专属卡。
      try {
        const silanModel = require('../valuation/silan600460.js');
        if (silanModel.isSilanModel(sym)) {
          const sl = await silanModel.run(sym, { price: currentPrice }); // 20261029q 数据治理升级版改 async
          if (sl && sl.ok) {
            overallRating = sl.rating;
            fairValueRange = sl.fairValueRange;
            fairValueCenter = sl.fairValueCenter;
            methods.length = 0;
            // 20261029q：数据治理升级版文案动态化（锚点/完整度/自检随实时数据）
            Array.prototype.push.apply(methods, ['景气度评分(H级)', '报告期身份证·口径锁定', `TTM滚动锚点${sl.anchor ? sl.anchor.stageLabel : ''}`, `完整度${sl.completeness}/100`, '三情景加权·PE·DCF·PB·PS']);
            // 20260908i口径：可视化卡片只保留图形内容，文字明细下沉专属卡
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[士兰专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }

    // ===== 麦捷科技专属「动态逻辑估值模型 V1.0」（20260909b）：data/valuation/300319.json kind==='maijie' 闸门 =====
    if (sym === '300319') {
      // 顶部综合估值评级卡引用麦捷模型结果（可视化内容），明细文字在下方专属卡。
      try {
        const mjModel = require('../valuation/maijie300319.js');
        if (mjModel.isMaijieModel(sym)) {
          // quote 已在作用域内（含实时 price / pe / pb），直接透传；缺失时引擎回退资产负债表 BVPS
          const mj = mjModel.run(sym, { price: currentPrice, pe: quote?.pe, pb: quote?.pb });
          if (mj && mj.ok) {
            overallRating = mj.rating;
            fairValueRange = mj.fairValueRange;
            fairValueCenter = mj.fairValueCenter;
            methods.length = 0;
            Array.prototype.push.apply(methods, ['PE相对(30%)', 'PB-ROE(25%)', 'EV/EBITDA(20%)', 'DCF·FCFF(25%)', '三情景加权60/20/20']);
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[麦捷专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }

    // ===== 电气风电专属「动态周期估值模型 DCAVM v1.0」（20260909h）：data/valuation/688660.json kind==='dcavm' 闸门 =====
    if (sym === '688660') {
      // 顶部综合估值评级卡引用 DCAVM 结果（可视化内容），明细文字在下方专属卡。
      try {
        const dcavmModel = require('../valuation/dcavm688660.js');
        if (dcavmModel.isDcavmModel(sym)) {
          // quote 已在作用域内（含实时 price / pe / pb），直接透传；缺失时引擎回退资产负债表 BVPS
          const dv = dcavmModel.run(sym, { price: currentPrice, pe: quote?.pe, pb: quote?.pb });
          if (dv && dv.ok) {
            overallRating = dv.rating;
            fairValueRange = dv.fairValueRange;
            fairValueCenter = dv.fairValueCenter;
            methods.length = 0;
            Array.prototype.push.apply(methods, ['景气周期评分', '三阶段DCF·CAPM', '相对(PE/PB-ROE/EV-EBITDA/EV-Sales)', 'SOTP分部', '订单辅助', '周期阶段动态加权']);
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[电气风电 DCAVM 专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }

    // ===== 华安证券专属「动态估值引擎」（20260908q）：data/valuation/600909.json kind==='huaan' 闸门 =====
    if (sym === '600909') {
      // 20260908q 起 600909 从券商通用模型剥离，顶部综合估值评级卡引用华安专用引擎结果。
      try {
        const huaanModel = require('../valuation/huaan600909.js');
        if (huaanModel.isHuaanModel(sym)) {
          const ha = await huaanModel.run(sym, { price: currentPrice });
          if (ha && ha.ok) {
            overallRating = ha.rating;
            fairValueRange = ha.fairValueRange;
            fairValueCenter = ha.fairValueCenter;
            methods.length = 0;
            // 20261029p：权重与方法成熟度随实时数据动态计算（V3.0 异步数据自适应），文案动态取数不再写死 60/30/10
            const haW = (ha.sotpDynamic && ha.sotpDynamic.weights) || { pb: 0.6, sotp: 0.3, pe: 0.1 };
            const haM = (ha.sotpDynamic && ha.sotpDynamic.maturity) || {};
            const pct = (x) => Math.round(x * 100) + '%';
            Array.prototype.push.apply(methods, ['守门员自检', '数据契约·异步对齐', '口径分离(常态利润)',
              `PB三层动态锚(${pct(haW.pb)}·${haM.pb || '绿'})`, `SOTP分部加总·影子摆动(${pct(haW.sotp)}·${haM.sotp || '黄'})`, `PE常态锚(${pct(haW.pe)}·${haM.pe || '绿'})`,
              ha.outputState ? `${ha.outputState}(置信度${ha.confidence}%)` : '三态输出'].filter(Boolean));
            // 20260908i口径：可视化卡片只保留图形内容，文字明细下沉专属卡
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[华安专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }

    // ===== 长江证券专属「PB-ROE动态估值引擎」（20260908r）：data/valuation/000783.json kind==='changjiang' 闸门 =====
    if (sym === '000783') {
      // 20260908r 起 000783 从券商通用模型剥离，顶部综合估值评级卡引用长江专用引擎结果。
      try {
        const cjModel = require('../valuation/changjiang000783.js');
        if (cjModel.isChangjiangModel(sym)) {
          // 20261029o：V3-五法则 全量重算架构 → run 改 async（每次实时拉三表，刚性层取最新报告期）
          const cj = await cjModel.run(sym, { price: currentPrice });
          if (cj && cj.ok) {
            overallRating = cj.rating;
            fairValueRange = cj.fairValueRange;
            fairValueCenter = cj.fairValueCenter;
            methods.length = 0;
            Array.prototype.push.apply(methods, ['PB-ROE主模型·TTM重构', '数据分层对齐·五法则', '双轨防御·重构警告/铁底', 'SOTP休眠机制·五法则', '排序强校验·五法则', '单边空间·五法则', '极值熔断·五法则']);
            // 20260908i口径：可视化卡片只保留图形内容，文字明细下沉专属卡
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[长江专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }

    // ===== 新洋丰专属「永久逻辑估值引擎」（20260916h）：data/valuation/000902.json kind==='xinyangfeng' 闸门 =====
    if (sym === '000902') {
      // 顶部综合估值评级卡引用新洋丰引擎结果（可视化内容），明细文字在下方专属卡。
      // 根因修复（20260916h）：此前 conclusion.js 缺该分支 → 掉入通用「PE估值带」逻辑
      // 产出 ¥13.26~¥24.84 / 中枢 ¥19.05，与下方专属卡（16.93 / 13.38~20.43）口径打架。
      try {
        const xyfModel = require('../valuation/xinyangfeng000902.js');
        if (xyfModel.isXinyangfengModel(sym)) {
          const xy = xyfModel.run(sym, { price: currentPrice, pe: quote?.pe, pb: quote?.pb });
          if (xy && xy.ok) {
            overallRating = xy.rating;
            fairValueRange = xy.fairValueRange;
            fairValueCenter = xy.fairValueCenter;
            methods.length = 0;
            Array.prototype.push.apply(methods, ['正常化PE(锚)', 'PB-ROE交叉', 'DCF参考', '磷矿资源期权(独立)', '三情景加权']);
            // 20260908i口径：可视化卡片只保留图形内容，文字明细下沉专属卡
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[新洋丰专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }

    // ===== 万润股份专属「永久逻辑估值引擎」（20260919f）：data/valuation/002643.json kind==='wanrun' 闸门 =====
    if (sym === '002643') {
      // 【替换旧综合估值模型】此前 002643 无专属分支 → 掉入通用「PE估值带」逻辑，
      // 产出 高估 / 中枢 ¥8.71 / 区间 ¥5.43~11.98（与新的三层加权永久逻辑模型结论相反）。
      // 本分支将顶部综合估值评级卡切换为新模型：合理 / 中枢 ¥18.55 / 区间 ¥11.22~23.37。
      try {
        const wrModel = require('../valuation/wanrun002643.js');
        if (wrModel.isWanrunModel(sym)) {
          // 20261029s：v2.0 数据频率自适应版 → run 改 async（每次实时拉东财三表）
          const wr = await wrModel.run(sym, { price: currentPrice, pe: quote?.pe, pb: quote?.pb });
          if (wr && wr.ok) {
            overallRating = wr.rating;
            fairValueRange = wr.fairValueRange;
            fairValueCenter = wr.fairValueCenter;
            methods.length = 0;
            Array.prototype.push.apply(methods, ['PB-ROE主锚·动态权重', 'PE相对·折价系数+熔断', 'DCF辅助·TTM FCFF', 'v2.1数据熔断与异常校准·置信度区间']);
            // 可视化卡片只保留图形内容，文字明细下沉专属卡
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[万润专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }

    // ===== 威高血净专属「动态估值引擎」（20261104i）：data/valuation/603014.json kind==='weigao' 闸门 =====
    if (sym === '603014') {
      // 九指令整合版：并表状态识别→三口径桥接→新鲜度分级→核心矩阵→DCF分部/相对双轨→协同期权→动态结论。
      // 顶部综合估值评级卡引用引擎结果，明细文字在下方专属卡（20260908i口径）。
      try {
        const wgModel = require('../valuation/weigao603014.js');
        if (wgModel.isWeigaoModel(sym)) {
          const wg = wgModel.run(sym, { price: currentPrice, pe: quote?.pe, pb: quote?.pb });
          if (wg && wg.ok) {
            overallRating = wg.rating;
            fairValueRange = wg.fairValueRange;
            fairValueCenter = wg.fairValueCenter;
            methods.length = 0;
            Array.prototype.push.apply(methods, ['DCF分部双轨(主锚·口径①)', '分部相对估值(交叉)', '协同看涨期权(独立列示)', '对价合理性检验(独立)', '业绩承诺追踪+商誉敏感性']);
            // 可视化卡片只保留图形内容，文字明细下沉专属卡
            conclusionText = '';
          }
        }
      } catch (e) {
        console.warn('[威高血净专属模型] 计算失败，回退通用逻辑:', e.message);
      }
    }

    if (overallRating) {
      return {
        overallRating,
        currentPrice,
        methodsUsed: methods,
        ratings,
        conclusionText,
        fairValueRange,
        fairValueCenter,
        companyType: ct,
        companyTypeName: ctName,
      };
    }
    return { overallRating: '数据不足', currentPrice, methodsUsed: methods, ratings: [], conclusionText: '估值数据不足，无法生成结论。', companyType: ct, companyTypeName: ctName };
}

function generateConclusionText(rating, price, dcf, valuation, growth, cashFlowData, revenueCostData, auditOpinion, ratings, companyType, dividends, quote, insuranceAnalysis, fairValueCenter, fairValueRange) {
  const parts = [];
  const ct = companyType?.type || 'balanced';
  const ctName = companyType?.typeName || '均衡型';
  const ctIcon = companyType?.typeIcon || '⚖️';

  const isInsurance = !!(insuranceAnalysis && insuranceAnalysis.isInsurance);
  const revenueGrowth = companyType?.classificationData?.revenueGrowth || 0;
  const isHighGrowth = !isInsurance && revenueGrowth >= 20;
  const isLowGrowth = !isInsurance && revenueGrowth < 20;

  // 0. 公司类型说明
  parts.push(`${ctIcon} 公司类型：${ctName} — ${companyType?.description || ''}`);
  parts.push(`📊 分析重点：${companyType?.focusText || '各维度均衡评估'}\n`);
  if (isInsurance) {
    parts.push('🏦 保险股估值提示：保险公司负债驱动、现金流特殊，本估值仅采用 P/EV（内含价值）与 DDM（股息贴现模型），PE/PB/PS/DCF 等其他模型不参与估值。\n');
  } else if (isLowGrowth) {
    parts.push(`📉 估值提示：该股近 ${growth ? growth.baseYear + '年至' + growth.latestYear + '年' : '期'}营收累计增长 ${revenueGrowth}%（<20%），属于低增长企业，估值以 PE 为主、PB/DCF 为辅，PS 不参与估值。\n`);
  } else if (isHighGrowth) {
    parts.push(`📈 估值提示：该股近 ${growth ? growth.baseYear + '年至' + growth.latestYear + '年' : '期'}营收累计增长 ${revenueGrowth}%（≥20%），属于高增长企业，估值使用 PE/PB/DCF 综合判断，PS 不参与估值。\n`);
  }

  // 1. 估值结论
  const ratingColor = { '低估': '🔴', '合理': '🟡', '偏高': '🟠', '高估': '🟢' };
  parts.push(`${ratingColor[rating] || '⚪'} 综合估值评级：${rating}（加权综合，按${ctName}权重分配）`);

  // 2. 各方法结论 (with weight info)
  for (const r of ratings) {
    const wPct = Math.round((r.weight || 0.25) * 100);
    let fairText = '';
    if (r.fairValueRange && (r.fairValueRange[1] - r.fairValueRange[0] > 0.005)) {
      fairText = ` ｜ 合理估值区间 ¥${fmtPrice(r.fairValueRange[0])} ~ ¥${fmtPrice(r.fairValueRange[1])}`;
    } else if (r.fairValue != null && r.fairValue > 0) {
      fairText = ` ｜ 合理估值 ¥${fmtPrice(r.fairValue)}`;
    }
    parts.push(`【${r.method}】(权重${wPct}%) ${r.detail}${fairText}`);
  }

  // 2.5 综合合理估值区间
  if (fairValueRange && fairValueRange[0] > 0) {
    const vsCenter = price > 0 ? Math.round((price / fairValueCenter - 1) * 10000) / 100 : 0;
    parts.push(`💰 综合合理估值区间：¥${fmtPrice(fairValueRange[0])} ~ ¥${fmtPrice(fairValueRange[1])}（中枢 ¥${fmtPrice(fairValueCenter)}）。当前价 ¥${fmtPrice(price)}，较中枢${vsCenter >= 0 ? '高' : '低'}${fmtPct(Math.abs(vsCenter))}，属于${vsCenter >= 0 ? '偏高' : '偏低'}区间。`);
  }

  // 3. DCF 详情
  if (dcf && !dcf.error) {
    parts.push(`DCF模型参数：基础自由现金流${dcf.baseFCF}亿，预测增长率${dcf.projectedGrowth}%，折现率${dcf.discountRate}%，永续增长率${dcf.perpetualGrowth}%。企业价值${dcf.enterpriseValue}亿，股权价值${dcf.equityValue}亿，每股内在价值¥${fmtPrice(dcf.perShareValue)}。`);
  }

  // 4. 增长情况
  if (growth) {
    parts.push(`成长性：${growth.baseYear}年至${growth.latestYear}年，营收增长${growth.revenueGrowth}%，净利润增长${growth.profitGrowth}%。`);
  }

  // 5. 现金流质量
  if (cashFlowData && cashFlowData.length >= 2) {
    const latest = cashFlowData[cashFlowData.length - 1];
    const prev = cashFlowData[cashFlowData.length - 2];
    const ocf = latest.operatingCashFlow;
    const np = latest.netProfit;
    if (np > 0) {
      const ratio = (ocf / np * 100).toFixed(1);
      if (ocf >= np) {
        parts.push(`现金流质量：最新经营现金流净额${ocf}亿，净利润${np}亿，现金流/净利润=${ratio}%，现金流充足，盈利质量高。`);
      } else {
        parts.push(`现金流质量：最新经营现金流净额${ocf}亿，净利润${np}亿，现金流/净利润=${ratio}%，需关注盈利质量。`);
      }
    }
  }

  // 6. 毛利率趋势
  if (revenueCostData && revenueCostData.length >= 2) {
    const latest = revenueCostData[revenueCostData.length - 1];
    const first = revenueCostData[0];
    const marginTrend = latest.grossMargin - first.grossMargin;
    if (Math.abs(marginTrend) > 2) {
      parts.push(`毛利率${marginTrend > 0 ? '上升' : '下降'}：从${first.year}年${first.grossMargin}%变动至${latest.year}年${latest.grossMargin}%。`);
    }
  }

  // 7. 审计意见
  if (auditOpinion && !auditOpinion.includes('标准无保留')) {
    parts.push(`⚠️ 审计意见异常：${auditOpinion}，请重点关注财务真实性风险！`);
  } else if (auditOpinion) {
    parts.push(`审计意见：${auditOpinion}，财务数据可信。`);
  }

  // 7.5 公司类型差异化分析
  if (ct === 'growth' && revenueCostData && revenueCostData.length >= 2) {
    const latest = revenueCostData[revenueCostData.length - 1];
    const first = revenueCostData[0];
    parts.push(`\n📈 【增长型分析】`);
    parts.push(`营收增速：最新${fmtPct(latest.revenueYoy || 0)}，${first.year}至${latest.year}年营收从${first.revenue}亿增至${latest.revenue}亿。`);
    // 非保险企业均不以 PS 作为估值依据，仅作参考展示。
    if (valuation?.psStats) {
      const latestPS = valuation.valuationData[valuation.valuationData.length - 1]?.ps || 0;
      const rel = latestPS < valuation.psStats.mean ? '低于' : '高于';
      const ruleLinePS = formatValuationLine(valuation.rules, 'PS');
      // 规则合规优先；无快照时回退原静态描述
      parts.push(ruleLinePS
        ? `市销率(PS)：${ruleLinePS}；历史均值${valuation.psStats.mean}，${rel}历史中枢（仅参考，不参与估值）。`
        : `市销率(PS)：当前${latestPS}，历史均值${valuation.psStats.mean}，${rel}历史中枢（仅参考，不参与估值）。`);
    }
    if (latest.profitYoy) {
      parts.push(`利润增速：${fmtPct(latest.profitYoy)}，${latest.profitYoy > latest.revenueYoy ? '利润增速>营收增速，盈利能力提升' : '利润增速<营收增速，需关注盈利质量'}。`);
    }
  } else if (ct === 'value' && revenueCostData && revenueCostData.length >= 2) {
    const latest = revenueCostData[revenueCostData.length - 1];
    parts.push(`\n💎 【价值型分析】`);
    parts.push(`估值锚点：低增长价值股以市盈率(PE)为核心估值指标，PB、DCF 仅作交叉验证。`);
    if (valuation?.peStats) {
      const latestPE = valuation?.currentPeTtm || valuation.valuationData[valuation.valuationData.length - 1]?.pe || 0;
      const zone = latestPE < valuation.peStats.low ? '低估区间' : latestPE > valuation.peStats.high ? '偏高区间' : '合理区间';
      // 规则合规优先：数值 + 来源 + 数据时间 + 方向/幅度/边际；无快照时回退原静态描述
      const ruleLine = formatValuationLine(valuation.rules, 'PE');
      if (ruleLine) {
        parts.push(`市盈率(PE)：${ruleLine}；历史均值${valuation.peStats.mean}，处于${zone}。`);
      } else {
        const peTag = valuation?.currentPeTtm ? `（TTM，来源：${valuation.peSource || '行情'}）` : '';
        parts.push(`市盈率(PE)：当前${latestPE}${peTag}，历史均值${valuation.peStats.mean}，处于${zone}。`);
      }
    }
    if (latest.netMargin) parts.push(`净利率：${latest.netMargin}%，${latest.netMargin > 15 ? '盈利能力强' : latest.netMargin > 8 ? '盈利能力中等' : '需关注盈利能力'}。`);
    if (latest.grossMargin) parts.push(`毛利率：${latest.grossMargin}%，${latest.grossMargin > 30 ? '具有较强定价权' : '毛利率一般'}。`);
  } else if (ct === 'dividend' && dividends && dividends.length > 0) {
    parts.push(`\n💰 【红利型分析】`);
    // Find the most recent record with non-zero dividendPerShare
    let validDiv = null;
    for (const d of dividends) {
      if (d?.dividendPerShare && d.dividendPerShare > 0) { validDiv = d; break; }
    }
    const divYield = quote?.price > 0 && validDiv ? (validDiv.dividendPerShare / quote.price * 100) : 0;
    parts.push(`股息率：当前约${divYield.toFixed(2)}%，${divYield >= 5 ? '高股息率，红利价值突出' : divYield >= 3 ? '股息率合理，具有红利价值' : '股息率偏低'}。`);
    const divYears = new Set(dividends.map(d => d.year).filter(y => y)).size;
    parts.push(`分红历史：已连续分红${divYears}年，${divYears >= 5 ? '分红历史较长，可持续性较好' : divYears >= 3 ? '分红历史中等' : '分红历史较短，需关注可持续性'}。`);
    if (revenueCostData && revenueCostData.length > 0) {
      const latest = revenueCostData[revenueCostData.length - 1];
      if (latest.netProfit > 0 && validDiv) {
        const divYi = validDiv.dividend ? toYi(validDiv.dividend) : 0;
        const payoutRatio = divYi / latest.netProfit * 100;
        parts.push(`派息率：约${payoutRatio.toFixed(1)}%，${payoutRatio < 50 ? '派息率适中，分红可持续性好' : payoutRatio < 80 ? '派息率偏高' : '派息率过高，需关注分红可持续性'}。`);
      }
    }
  }

  // 8. 综合建议 (type-specific)
  if (rating === '低估') {
    if (ct === 'growth') {
      parts.push(`💡 综合建议：当前股价处于历史估值低位，结合公司增长潜力和PS估值，具备成长投资价值。建议关注营收增速是否可持续，逢低布局。`);
    } else if (ct === 'dividend') {
      parts.push(`💡 综合建议：当前股息率较高，估值偏低，具备较好的红利投资价值。建议关注分红可持续性和公司盈利稳定性，适合长期持有收息。`);
    } else if (ct === 'value') {
      parts.push(`💡 综合建议：当前PE处于历史低位，基本面稳健，具备价值投资价值。建议关注ROE是否能维持，逢低布局。`);
    } else {
      parts.push(`💡 综合建议：当前股价处于历史估值低位区间，结合DCF内在价值分析，股价具备投资价值。建议关注基本面变化，适时布局。`);
    }
  } else if (rating === '合理') {
    if (ct === 'growth') {
      parts.push(`💡 综合建议：当前估值处于合理区间，营收增长强劲。建议持有或逢低加仓，重点跟踪季度营收增速变化。`);
    } else if (ct === 'dividend') {
      parts.push(`💡 综合建议：股息率处于合理水平，分红可持续。适合作为底仓长期持有，享受稳定分红收益。`);
    } else if (ct === 'value') {
      parts.push(`💡 综合建议：PE估值合理，基本面与估值匹配。建议持有，关注业绩增长是否可持续。`);
    } else {
      parts.push(`💡 综合建议：当前股价处于合理估值区间，基本面与估值匹配。建议持有或逢低布局，关注业绩增长是否可持续。`);
    }
  } else if (rating === '偏高') {
    if (ct === 'growth') {
      parts.push(`💡 综合建议：当前PS估值偏高，市场对增长预期较高。建议谨慎追高，若营收增速不达预期可能面临戴维斯双杀风险。`);
    } else if (ct === 'dividend') {
      parts.push(`💡 综合建议：股息率偏低，估值偏高。红利投资价值减弱，建议等待回调后再考虑介入。`);
    } else if (ct === 'value') {
      parts.push(`💡 综合建议：PE偏高，估值溢价较多。建议谨慎追高，等待回调后再考虑介入。`);
    } else {
      parts.push(`💡 综合建议：当前股价估值偏高，存在一定回调风险。建议谨慎追高，等待回调后再考虑介入。`);
    }
  } else if (rating === '高估') {
    if (ct === 'growth') {
      parts.push(`💡 综合建议：PS估值过高，市场已透支未来增长预期。建议控制仓位，警惕估值回归风险。`);
    } else if (ct === 'dividend') {
      parts.push(`💡 综合建议：股价过高导致股息率过低，红利投资价值已不明显。建议减仓或观望。`);
    } else if (ct === 'value') {
      parts.push(`💡 综合建议：PE远高于历史中枢，估值过高。建议控制仓位，避免追高，关注估值回归。`);
    } else {
      parts.push(`💡 综合建议：当前股价明显高估，回调风险较大。建议控制仓位，避免追高，关注估值回归。`);
    }
  }

  return parts.join('\n');
}

module.exports = { generateConclusion };

~~~

---

## `lib\deep\conclusions.js`  ·  494 行

~~~js
/**
 * lib/deep/conclusions.js —— deepAnalysis 领域子模块：各分析小节「结论 + 论证」生成（财务/估值/分红/保险 7 节）
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 全部 build* 与 analyzeRoeMarginTrend 导出供 deep/pipeline 的 augmentSections 装配使用；
 * segmentTopItems 仅内部复用，不导出。
 */
const { fmtPrice, fmtPct } = require('./shared');
const { formatValuationLine } = require('../valuationHub');

// ---- 各分析小节「结论 + 论证」生成（Feature: 结论与论证过程） ----
function buildRevenueConclusion(rc) {
  if (!rc || rc.length < 2) return null;
  const latest = rc[rc.length - 1];
  const first = rc[0];
  const trend = latest.revenue >= first.revenue ? '上升' : '下降';
  const gmChg = (typeof latest.grossMargin === 'number') ? latest.grossMargin - first.grossMargin : null;
  const gmTxt = (gmChg == null) ? `净利率 ${fmtPct(latest.netMargin)}` : `毛利率 ${fmtPct(latest.grossMargin)}（较首期${gmChg >= 0 ? '提升' : '下降'} ${Math.abs(gmChg).toFixed(1)}pct）、净利率 ${fmtPct(latest.netMargin)}`;
  const conclusion = `近 ${rc.length} 年营收整体呈${trend}趋势，最新营收 ${latest.revenue} 亿（同比 ${fmtPct(latest.revenueYoy)}），归母净利润 ${latest.netProfit} 亿（同比 ${fmtPct(latest.profitYoy)}），营运利润 ${latest.operatingProfit} 亿，${gmTxt}。`;
  const reasoning = [
    `样本区间：${first.year} ~ ${latest.year}，共 ${rc.length} 个年度。`,
    `最新营收 ${latest.revenue} 亿，同比增速 ${fmtPct(latest.revenueYoy)}，营收${latest.revenueYoy >= 0 ? '保持增长' : '出现下滑'}。`,
    `最新归母净利润 ${latest.netProfit} 亿，同比增速 ${fmtPct(latest.profitYoy)}；利润增速${Math.abs(latest.profitYoy) < Math.abs(latest.revenueYoy) ? '低于营收增速，盈利质量承压' : '不低于营收增速，盈利能力增强'}。`,
    `营运利润 ${latest.operatingProfit} 亿，${gmTxt}，反映核心经营盈利能力与费用控制水平。`,
    ...(gmChg != null ? [`毛利率由 ${first.grossMargin}% 变动至 ${latest.grossMargin}%（${gmChg >= 0 ? '+' : ''}${gmChg.toFixed(1)} pct），反映产品定价能力与成本端变化。`] : []),
  ];
  return { conclusion, reasoning };
}

function buildCashFlowConclusion(cf) {
  if (!cf || cf.length < 2) return null;
  const latest = cf[cf.length - 1];
  const prev = cf[cf.length - 2];
  const np = latest.netProfit;
  const ocf = latest.operatingCashFlow;
  if (!(np > 0)) return { conclusion: '最新净利润为负或缺失，暂无法评估现金流质量。', reasoning: ['净利润数据不足。'] };
  const ratio = (ocf / np * 100);
  const quality = ocf >= np ? '充足，盈利含金量高' : '低于净利润，需关注回款与盈利质量';
  const conclusion = `最新经营现金流净额 ${ocf} 亿，净利润 ${np} 亿，经营现金流/净利润 = ${ratio.toFixed(0)}%，现金流${quality}。`;
  const reasoning = [
    `经营现金流净额 ${ocf} 亿 vs 净利润 ${np} 亿。`,
    `比值 ${ratio.toFixed(0)}%：${ocf >= np ? '≥100%，利润基本以现金形式实现' : '<100%，存在应收账款/存货占用，盈利质量偏弱'}。`,
  ];
  // 解释经营现金流同比大幅波动
  if (prev && prev.operatingCashFlow > 0) {
    const ocfYoY = ((ocf - prev.operatingCashFlow) / prev.operatingCashFlow * 100);
    const isLargeMove = Math.abs(ocfYoY) > 20;
    if (isLargeMove) {
      const direction = ocfYoY >= 0 ? '增长' : '下降';
      reasoning.push(`经营现金流较上年${direction} ${Math.abs(ocfYoY).toFixed(1)}%，若变动主要由保费回款、投资收回/投放、退保或营运资本变化驱动，通常不代表收入质量恶化；建议结合年报「现金流量表补充资料」中的「将净利润调节为经营活动现金流量」逐项核对。`);
    }
  }
  // 若最末年为 TTM，提示口径
  if (latest.ttm) {
    reasoning.push(`注：${latest.year} 年经营现金流净额按 TTM 滚动累计还原为全年等效口径。`);
  }
  return { conclusion, reasoning };
}

function buildGrowthConclusion(g) {
  if (!g) return null;
  const conclusion = `${g.baseYear} 年至 ${g.latestYear} 年，营收累计增长 ${g.revenueGrowth}%，净利润累计增长 ${g.profitGrowth}%。`;
  const reasoning = [
    `基准年 ${g.baseYear} 至最新年 ${g.latestYear}。`,
    `营收累计增幅 ${g.revenueGrowth}%（长期成长性）。`,
    `净利润累计增幅 ${g.profitGrowth}%，${g.profitGrowth > g.revenueGrowth ? '利润增速快于营收，规模效应/利润率提升' : '利润增速慢于营收，成本或费用压力上升'}。`,
  ];
  return { conclusion, reasoning };
}

function buildMarginConclusion(rc) {
  if (!rc || rc.length < 2) return null;
  const latest = rc[rc.length - 1];
  const first = rc[0];
  const gmChg = latest.grossMargin - first.grossMargin;
  const nmChg = latest.netMargin - first.netMargin;
  const conclusion = `毛利率从 ${first.grossMargin}% 变动至 ${latest.grossMargin}%（${gmChg >= 0 ? '提升' : '下降'} ${Math.abs(gmChg).toFixed(1)} pct），净利率${nmChg >= 0 ? '提升' : '下降'} ${Math.abs(nmChg).toFixed(1)} pct。`;
  const reasoning = [
    `毛利率：${first.grossMargin}% → ${latest.grossMargin}%（变动 ${gmChg >= 0 ? '+' : ''}${gmChg.toFixed(1)} pct），反映产品竞争力/成本端变化。`,
    `净利率：${first.netMargin}% → ${latest.netMargin}%（变动 ${nmChg >= 0 ? '+' : ''}${nmChg.toFixed(1)} pct），含费用与税项影响。`,
    `毛利率与净利率剪刀差约 ${(latest.grossMargin - latest.netMargin).toFixed(1)} pct，为三费与税费占用。`,
  ];
  return { conclusion, reasoning };
}

// ---- 近5年 ROE 与毛利率走势（含文字解读）----
// 数据来源：毛利率/净利率取自营收成本表（revenueCostData，与全页一致口径）；
// ROE 取自东方财富 ZYZBAjaxNew 多期指标（zyzbHistory，字段 ROEJQ），按年报期对齐。
// 单一权威源原则：ROE 仅来自 zyzbHistory 一处，不混用其他来源。
function analyzeRoeMarginTrend(revenueCostData, quote) {
  if (!revenueCostData || revenueCostData.length < 2) return null;
  // 取最近 5 年
  const rcYears = revenueCostData.slice(-5);
  // 构建 ROE 年度映射：优先年报(12-31)，否则取该年任一报告期
  const hist = quote && quote.fundamentals && Array.isArray(quote.fundamentals.zyzbHistory)
    ? quote.fundamentals.zyzbHistory : [];
  // 20260909j：TTM 点统一改用取数层权威 ROE(TTM)（quote.fundamentals.roeTtm，stockData.computeTtmMetrics 计算），
  // 与关键财务指标页 ROE 完全同源；历史年份保持年报加权 ROEJQ。此前 TTM 点误挂「最新中报累计加权 ROE」。
  const fTtm = (quote && quote.fundamentals && typeof quote.fundamentals.roeTtm === 'number')
    ? quote.fundamentals.roeTtm : null;
  const roeByYear = {};
  const roeSource = [];
  let ttmRoeUsed = false;
  for (const h of hist) {
    const rd = h.REPORT_DATE || '';
    const y = rd.slice(0, 4);
    if (!y) continue;
    const roe = parseFloat(h.ROEJQ);
    if (isNaN(roe)) continue;
    if (!roeByYear[y] || rd.endsWith('12-31')) roeByYear[y] = { roe, isAnnual: rd.endsWith('12-31') };
    if (rd.endsWith('12-31') && roeSource.indexOf('东方财富 ZYZBAjaxNew 净资产收益率(ROEJQ)') === -1) {
      roeSource.push('东方财富 ZYZBAjaxNew 净资产收益率(ROEJQ)');
    }
  }
  const years = rcYears.map(d => {
    const y = String(d.year);
    const roeRec = roeByYear[y];
    const roeTtmVal = (d.ttm && fTtm != null) ? fTtm : null;
    if (roeTtmVal != null) ttmRoeUsed = true;
    return {
      year: d.year,
      roe: roeTtmVal != null ? roeTtmVal : (roeRec ? roeRec.roe : null),
      grossMargin: (typeof d.grossMargin === 'number') ? d.grossMargin : null,
      netMargin: (typeof d.netMargin === 'number') ? d.netMargin : null,
      ttm: !!d.ttm,
    };
  }).filter(d => d.roe !== null || d.grossMargin !== null);

  if (years.length < 2) return null;

  // 文字解读（方向 + 幅度 + 边际，遵循规则三）
  const roePts = years.filter(d => d.roe !== null);
  const gmPts = years.filter(d => d.grossMargin !== null);
  const reasoning = [];
  let conclusionParts = [];

  if (roePts.length >= 2) {
    const first = roePts[0], last = roePts[roePts.length - 1];
    const chg = last.roe - first.roe;
    const dir = chg > 0.1 ? '提升' : (chg < -0.1 ? '下降' : '基本持平');
    conclusionParts.push(`ROE 从 ${first.year} 年 ${first.roe.toFixed(1)}% ${dir}至 ${last.year} 年 ${last.roe.toFixed(1)}%（变动 ${chg >= 0 ? '+' : ''}${chg.toFixed(1)} pct）`);
    // 边际变化：相邻两期
    const last2 = roePts[roePts.length - 2];
    const margin = last.roe - last2.roe;
    reasoning.push(`ROE：${first.year} ${first.roe.toFixed(1)}% → ${last.year} ${last.roe.toFixed(1)}%，整体${dir} ${Math.abs(chg).toFixed(1)} pct；最近一期较上期${margin >= 0 ? '上升' : '下降'} ${Math.abs(margin).toFixed(1)} pct（${Math.abs(margin) < 0.3 ? '边际平稳' : '边际' + (margin > 0 ? '改善' : '走弱')}）。`);
    if (ttmRoeUsed) {
      reasoning.push('注：最新一期 ROE 为 TTM 滚动口径（近12个月归母净利 ÷ 期末归母净资产），与关键财务指标页 ROE 同源一致；历史年份为年报加权口径(ROEJQ)。');
    }
  }
  if (gmPts.length >= 2) {
    const first = gmPts[0], last = gmPts[gmPts.length - 1];
    const chg = last.grossMargin - first.grossMargin;
    const dir = chg > 0.1 ? '提升' : (chg < -0.1 ? '下降' : '基本持平');
    conclusionParts.push(`毛利率由 ${first.grossMargin.toFixed(1)}% ${dir}至 ${last.grossMargin.toFixed(1)}%（变动 ${chg >= 0 ? '+' : ''}${chg.toFixed(1)} pct）`);
    const last2 = gmPts[gmPts.length - 2];
    const margin = last.grossMargin - last2.grossMargin;
    reasoning.push(`毛利率：${first.grossMargin.toFixed(1)}% → ${last.grossMargin.toFixed(1)}%，整体${dir} ${Math.abs(chg).toFixed(1)} pct；最近一期较上期${margin >= 0 ? '上升' : '下降'} ${Math.abs(margin).toFixed(1)} pct（${Math.abs(margin) < 0.3 ? '边际平稳' : '边际' + (margin > 0 ? '改善' : '走弱')}）。`);
  }
  const nmPts = years.filter(d => d.netMargin !== null);
  if (nmPts.length >= 2) {
    const first = nmPts[0], last = nmPts[nmPts.length - 1];
    const chg = last.netMargin - first.netMargin;
    conclusionParts.push(`净利率由 ${first.netMargin.toFixed(1)}% 变动至 ${last.netMargin.toFixed(1)}%`);
  }

  const conclusion = '近' + years.length + '年盈利能力走势：' + conclusionParts.join('；') + '。';
  const source = ttmRoeUsed
    ? '毛利率/净利率：东方财富 F10 利润表（与营收成本趋势同源）；ROE：历史年份为年报加权净资产收益率(ROEJQ)，最新 TTM 点＝近12个月归母净利÷期末归母净资产（与关键财务指标页 ROE 同源）'
    : '毛利率/净利率：东方财富 F10 利润表（与营收成本趋势同源）；ROE：' + (roeSource.join('、') || '东方财富财务指标');

  return { years, conclusion, reasoning, source };
}

function buildBalanceConclusion(shortTerm, assetComp, liabComp, bal) {
  if (!shortTerm && !assetComp && !bal) return null;
  const parts = [];
  const reasoning = [];
  if (shortTerm) {
    const cash = shortTerm.cash, debt = shortTerm.shortTermDebt;
    const cover = debt > 0 ? (cash / debt) : null;
    parts.push(`货币资金 ${cash} 亿、短期借款 ${debt} 亿，现金短债比 ${cover !== null ? cover.toFixed(1) : 'N/A'}`);
    reasoning.push(`货币资金 ${cash} 亿、短期借款 ${debt} 亿；现金短债比 ${cover !== null ? cover.toFixed(2) : 'N/A'}${cover !== null ? (cover >= 1 ? '，短期偿债无虞' : '，短期偿债存在压力') : ''}。`);
  }
  if (assetComp && assetComp.length) {
    const top = assetComp.slice(0, 3).map(a => a.name + ' ' + a.value + '亿').join('、');
    parts.push(`资产以 ${top} 为主`);
    reasoning.push(`资产构成前三大：${top}。`);
  }
  if (liabComp && liabComp.length) {
    const top = liabComp.slice(0, 3).map(a => a.name + ' ' + a.value + '亿').join('、');
    parts.push(`负债以 ${top} 为主`);
    reasoning.push(`负债构成前三大：${top}。`);
  }
  if (bal && bal.totalLiabilities > 0 && bal.totalAssets > 0) {
    const dar = (bal.totalLiabilities / bal.totalAssets * 100).toFixed(1);
    parts.push(`资产负债率 ${dar}%`);
    reasoning.push(`资产负债率 ${dar}%（总负债 ${bal.totalLiabilities} 亿 / 总资产 ${bal.totalAssets} 亿）。`);
  }
  if (bal && bal.goodwill > 0 && bal.netAssets > 0) {
    const gwRatio = (bal.goodwill / bal.netAssets * 100);
    reasoning.push(`商誉 ${bal.goodwill} 亿，占净资产 ${gwRatio.toFixed(1)}%${gwRatio > 30 ? '，商誉减值风险需关注' : ''}。`);
  }
  const conclusion = '财务结构：' + parts.join('；') + '。';
  return { conclusion, reasoning };
}

function buildDividendConclusion(dd) {
  if (!dd || dd.length === 0) return null;
  const valid = dd.filter(d => d.dividendRate > 0);
  const latest = dd[dd.length - 1];
  const years = valid.length;
  const rates = valid.map(d => d.dividendRate);
  const conclusion = `最新年度分红率约 ${latest.dividendRate}%，派息 ${latest.dividend} 亿，有分红记录约 ${years} 年。`;
  const reasoning = [
    `最新年度：净利润 ${latest.netProfit} 亿，分红 ${latest.dividend} 亿，分红率 ${latest.dividendRate}%。`,
    rates.length ? `历史分红率区间：${Math.min(...rates)}% ~ ${Math.max(...rates)}%。` : '历史分红率数据不足。',
    `分红率${latest.dividendRate > 70 ? '偏高（>70%），需关注是否透支' : latest.dividendRate < 30 ? '偏低' : '适中'}，可持续性取决于盈利稳定性与现金流。`,
  ];
  return { conclusion, reasoning };
}

function buildDCFConclusion(dcf) {
  if (!dcf) return { conclusion: 'DCF 数据不足。', reasoning: [] };
  if (dcf.error) return { conclusion: 'DCF 不可用：' + dcf.error, reasoning: [] };
  const premium = dcf.premium;
  const conclusion = `DCF 每股内在价值 ¥${fmtPrice(dcf.perShareValue)}，现价 ¥${fmtPrice(dcf.currentPrice)}，估值${premium > 0 ? '高估' : '低估'} ${fmtPct(Math.abs(premium))}。`;
  const reasoning = [
    `基础自由现金流 ${dcf.baseFCF} 亿，假设预测增长 ${dcf.projectedGrowth}%、折现率 ${dcf.discountRate}%、永续增长 ${dcf.perpetualGrowth}%。`,
    `企业价值 ${dcf.enterpriseValue} 亿，股权价值 ${dcf.equityValue} 亿，每股内在价值 ¥${fmtPrice(dcf.perShareValue)}。`,
    `相对现价 ¥${fmtPrice(dcf.currentPrice)}：溢价 ${fmtPct(premium)}，即${premium > 0 ? '当前价格高于内在价值，已兑现预期' : '当前价格低于内在价值，存在安全边际'}。`,
    `注：DCF 对增长与折现率假设高度敏感，结论仅作参考。`,
  ];
  return { conclusion, reasoning };
}

function buildAssetCompConclusion(assetComposition, totalAssets) {
  if (!Array.isArray(assetComposition) || assetComposition.length === 0) return null;
  const top = assetComposition.slice(0, 3).map(a => `${a.name} ${a.value}亿`).join('、');
  const conclusion = `${totalAssets != null ? `总资产 ${totalAssets} 亿，` : ''}资产构成以 ${top} 为主。`;
  const reasoning = [`资产前三大：${top}。`, ...(totalAssets != null ? [`总资产 ${totalAssets} 亿。`] : [])];
  return { conclusion, reasoning };
}

function buildLiabCompConclusion(liabilityComposition, totalLiabilities) {
  if (!Array.isArray(liabilityComposition) || liabilityComposition.length === 0) return null;
  const top = liabilityComposition.slice(0, 3).map(a => `${a.name} ${a.value}亿`).join('、');
  const conclusion = `${totalLiabilities != null ? `总负债 ${totalLiabilities} 亿，` : ''}负债构成以 ${top} 为主。`;
  const reasoning = [`负债前三大：${top}。`];
  return { conclusion, reasoning };
}

function buildMarketCapConclusion(data, key, metricLabel, ratioLabel) {
  if (!Array.isArray(data) || data.length < 2) return null;
  const valid = data.filter(d => d[key] != null && d[key] > 0 && d.marketCap != null && d.marketCap > 0);
  if (valid.length < 2) return null;
  const latest = valid[valid.length - 1];
  const first = valid[0];
  const val = latest[key];
  const mc = latest.marketCap;
  const multiple = mc / val;
  const conclusion = `${metricLabel} ${val} 亿，最新市值 ${mc} 亿（${ratioLabel}约 ${multiple.toFixed(2)} 倍），${val >= first[key] ? '较首期上升' : '较首期下降'}。`;
  const reasoning = [
    `区间：${first.year} ~ ${latest.year}（${valid.length} 个可比年度）。`,
    `最新 ${metricLabel} ${val} 亿、总市值 ${mc} 亿，对应 ${ratioLabel} ${multiple.toFixed(2)} 倍。`,
  ];
  return { conclusion, reasoning };
}

function buildProfitVsCashConclusion(cf) {
  if (!cf || cf.length < 2) return null;
  const latest = cf[cf.length - 1];
  const np = latest.netProfit, ocf = latest.operatingCashFlow;
  if (!(np > 0)) return null;
  const conclusion = `最新净利润 ${np} 亿、经营现金流净额 ${ocf} 亿，经营现金流/净利润 = ${(ocf / np * 100).toFixed(0)}%，${ocf >= np ? '利润现金含量充足' : '利润现金含量偏低，需关注回款质量'}。`;
  const reasoning = [
    `净利润 ${np} 亿 vs 经营现金流净额 ${ocf} 亿。`,
    `比值 ${(ocf / np * 100).toFixed(0)}%${ocf >= np ? '（≥100%，业绩以现金形式实现，真实性强）' : '（<100%，存在应收/存货占用，业绩真实性承压）'}。`,
  ];
  return { conclusion, reasoning };
}

function buildRevVsCostConclusion(rc) {
  if (!rc || rc.length < 2) return null;
  const latest = rc[rc.length - 1];
  const rev = latest.revenue, cost = latest.cost;
  if (!(rev > 0)) return null;
  const margin = (1 - cost / rev) * 100;
  const conclusion = `最新营收 ${rev} 亿、营业总成本 ${cost} 亿，营收成本差约 ${margin.toFixed(1)}%（营运利润率参考）。`;
  const reasoning = [`营收 ${rev} 亿、营业总成本 ${cost} 亿，两者差额 ${(rev - cost).toFixed(1)} 亿。`];
  return { conclusion, reasoning };
}

function buildRevVsExpConclusion(exp) {
  if (!exp || exp.length < 2) return null;
  const latest = exp[exp.length - 1];
  const rev = latest.revenue;
  if (!(rev > 0)) return null;
  const sale = latest.saleExpense || 0, manage = latest.manageExpense || 0, research = latest.researchExpense || 0;
  const totalExp = sale + manage + research;
  const ratio = totalExp / rev * 100;
  const conclusion = `最新三费合计 ${totalExp.toFixed(1)} 亿，占营收 ${ratio.toFixed(1)}%（销售 ${sale}、管理 ${manage}、研发 ${research} 亿）。`;
  const reasoning = [`三费合计 ${totalExp.toFixed(1)} 亿，费用率 ${ratio.toFixed(1)}%，体现费用控制与研发投入强度。`];
  return { conclusion, reasoning };
}

function buildPayableConclusion(pd) {
  if (!pd || pd.length < 2) return null;
  const latest = pd[pd.length - 1];
  const rev = latest.revenue, ap = latest.accountsPayable;
  if (!(rev > 0)) return null;
  const ratio = ap / rev * 100;
  const conclusion = `最新应付账款 ${ap != null ? ap + ' 亿' : 'N/A'}，占营收 ${ratio.toFixed(1)}%（对上游资金占用强度）。`;
  const reasoning = [`应付账款 ${ap != null ? ap + ' 亿' : 'N/A'}、营收 ${rev} 亿，占比 ${ratio.toFixed(1)}%。`, '应付占营收越高，通常对上游议价/占款能力越强，但也需关注自身偿债与供应商关系。'];
  return { conclusion, reasoning };
}

function buildValuationMetricConclusion(valuation, label) {
  if (!valuation || !valuation.valuationData) return null;
  const key = label.toLowerCase();
  const vals = valuation.valuationData.filter(d => typeof d[key] === 'number' && d[key] > 0).map(d => d[key]);
  if (vals.length < 2) return null;
  const latest = vals[vals.length - 1];
  const stats = valuation[key + 'Stats'] || {};
  const mean = stats.mean, high = stats.high, low = stats.low;
  let pos;
  if (mean != null && high != null && low != null) {
    pos = latest >= high ? `处于历史高位区（≥${high}，偏贵）` : latest <= low ? `处于历史低位区（≤${low}，偏便宜）` : `处于历史均值（${mean}）附近`;
  } else {
    pos = '（缺少均值参考）';
  }
  let conclusion = `${label} 当前约 ${latest}，${pos}，近 ${vals.length} 期均值 ${mean != null ? mean : '--'}。`;
  const reasoning = [
    `${label} 序列区间：${vals[0]} ~ ${latest}（共 ${vals.length} 期）。`,
    `历史均值 ${mean != null ? mean : '--'}，+1σ 高估线 ${high != null ? high : '--'}，-1σ 低估线 ${low != null ? low : '--'}。`,
  ];
  if (label === 'PE' && valuation.currentPeTtm > 0) {
    reasoning.push(`当前 PE(TTM) ${valuation.currentPeTtm}（来源：${valuation.peSource || '东方财富TTM'}），${valuation.currentPeTtm > latest ? '高于' : '低于'}最近一期静态 PE。`);
  }
  // 规则三：结论补充「方向+幅度+边际」；规则一②/二：推理补充「数值+来源+数据时间」
  const ruleLine = valuation.rules ? formatValuationLine(valuation.rules, label) : null;
  if (ruleLine) {
    const segs = ruleLine.split('；');
    if (segs.length > 1) conclusion += segs.slice(1).join('；') + '。';
    reasoning.push(segs[0]);
  }
  return { conclusion, reasoning };
}

function buildDivYieldConclusion(dy) {
  if (!dy || !Array.isArray(dy.series) || dy.series.length === 0) return null;
  const cur = dy.current && typeof dy.current.yield === 'number' ? dy.current.yield : null;
  const mean = dy.stats && typeof dy.stats.mean === 'number' ? dy.stats.mean : null;
  const cmp = (cur != null && mean != null) ? `，${cur >= mean ? '高于' : '低于'}均值` : '';
  const conclusion = `当前股息率 ${cur != null ? cur + '%' : '--'}${mean != null ? `，近 ${dy.series.length} 年均值 ${mean.toFixed(2)}%${cmp}` : ''}。`;
  const reasoning = [
    ...(mean != null ? [`近 ${dy.series.length} 年股息率均值 ${mean.toFixed(2)}%。`] : []),
    ...(cur != null && mean != null ? [`当前 ${cur}% ${cur >= mean ? '高于' : '低于'}均值，股息吸引力${cur >= mean ? '较强' : '一般'}。`] : []),
  ];
  return { conclusion, reasoning };
}

function segmentTopItems(seg, typeFilter) {
  if (!seg || !seg.byYear || !seg.years || seg.years.length === 0) return null;
  const lastYear = seg.years[seg.years.length - 1];
  const yearMap = seg.byYear[lastYear] || {};
  const types = Object.keys(yearMap);
  const key = types.find(t => t.includes(typeFilter)) || (typeFilter === '产品' ? types.find(t => !t.includes('地区') && !t.includes('行业')) : types.find(t => t.includes('地区') || t.includes('内') || t.includes('外')));
  if (!key) return null;
  const items = yearMap[key];
  if (!Array.isArray(items) || items.length === 0) return null;
  return { lastYear, items };
}

function buildSegmentProductConclusion(seg) {
  const r = segmentTopItems(seg, '产品');
  if (!r) return null;
  const total = r.items.reduce((s, p) => s + ((p.income || 0) / 1e8), 0);
  if (total <= 0) return null;
  const top = [...r.items].filter(p => (p.income || 0) > 0).sort((a, b) => (b.income || 0) - (a.income || 0)).slice(0, 3);
  if (top.length === 0) return null;
  const topTxt = top.map(p => `${p.name}（${((p.income || 0) / 1e8 / total * 100).toFixed(0)}%）`).join('、');
  const conclusion = `${r.lastYear} 年分产品收入以 ${topTxt} 为主。`;
  const reasoning = [`${r.lastYear} 年度按主营业务构成口径统计的产品收入占比。`];
  return { conclusion, reasoning };
}

function buildSegmentRegionConclusion(seg) {
  const r = segmentTopItems(seg, '地区');
  if (!r) return null;
  const total = r.items.reduce((s, p) => s + ((p.income || 0) / 1e8), 0);
  if (total <= 0) return null;
  const foreignMarks = ['境外', '海外', '国外', '国际', '香港', '澳门', '台湾', '外销', '出口', 'foreign', 'oversea', 'abroad'];
  let foreign = 0;
  r.items.forEach(p => {
    const n = String(p.name || '').toLowerCase();
    if (foreignMarks.some(m => n.includes(m))) foreign += (p.income || 0) / 1e8;
  });
  const foreignPct = foreign / total * 100;
  const conclusion = `${r.lastYear} 年国内收入占比约 ${(100 - foreignPct).toFixed(0)}%，海外收入占比约 ${foreignPct.toFixed(0)}%。`;
  const reasoning = [`海外收入合计约 ${foreign.toFixed(1)} 亿，占总收入 ${foreignPct.toFixed(1)}%。`];
  return { conclusion, reasoning };
}

function buildProductMarginConclusion(pm) {
  if (!pm || !Array.isArray(pm.items) || pm.items.length === 0) return null;
  const hasCost = pm.items.every(p => p.costYi != null);
  const overall = (hasCost && pm.totalIncomeYi > 0) ? Math.round((1 - pm.totalCostYi / pm.totalIncomeYi) * 10000) / 100 : null;
  const topGm = [...pm.items].filter(p => p.grossMargin != null).sort((a, b) => b.grossMargin - a.grossMargin).slice(0, 3);
  if (overall == null && topGm.length === 0) return null;
  const conclusion = `${pm.dimension || '产品/业务'}整体毛利率${overall != null ? '约 ' + overall + '%' : '—'}${topGm.length ? `；高毛利业务为 ${topGm.map(p => p.name).join('、')}` : ''}。`;
  const reasoning = [
    ...(overall != null ? [`整体毛利率约 ${overall}%（营收 ${pm.totalIncomeYi} 亿、成本 ${pm.totalCostYi} 亿）。`] : []),
    ...(topGm.length ? [`高毛利业务：${topGm.map(p => `${p.name}(${p.grossMargin}%)`).join('、')}。`] : []),
  ];
  return { conclusion, reasoning };
}

// ---- 保险公司专属模块结论 ----
function buildInsurancePremiumConclusion(pa) {
  if (!pa || !Array.isArray(pa.yearlyData) || pa.yearlyData.length < 2) return null;
  const latest = pa.yearlyData[pa.yearlyData.length - 1];
  const first = pa.yearlyData[0];
  const conclusion = `保费收入近 ${pa.yearlyData.length} 年由 ${first.total} 亿增至 ${latest.total} 亿，最新同比 ${fmtPct(latest.yoyGrowth)}。`;
  const reasoning = [`区间：${first.year} ~ ${latest.year}。`, `最新保费 ${latest.total} 亿，同比 ${fmtPct(latest.yoyGrowth)}。`];
  return { conclusion, reasoning };
}

function buildInsuranceCombinedRatioConclusion(cr) {
  if (!cr || !cr.hasData || !Array.isArray(cr.data) || cr.data.length === 0) return null;
  const latest = cr.data[cr.data.length - 1];
  const benchmark = cr.industryBenchmark || 98.5;
  const conclusion = `最新综合成本率 ${latest.value}%（${latest.value < benchmark ? '优于' : '高于'}行业基准 ${benchmark}%），承保端${latest.value < 100 ? '盈利' : '亏损'}。`;
  const reasoning = [`综合成本率 ${latest.value}%，行业基准 ${benchmark}%。`, '综合成本率 = 赔付率 + 费用率，<100% 表示承保端盈利。'];
  return { conclusion, reasoning };
}

function buildInsuranceInvestmentYieldConclusion(iy) {
  if (!iy || !iy.hasData || !Array.isArray(iy.data) || iy.data.length === 0) return null;
  const latest = iy.data[iy.data.length - 1];
  const benchmark = iy.industryBenchmark || 5.0;
  const conclusion = `最新${iy.metricName || '投资收益率'} ${latest.value}%（${latest.value >= benchmark ? '高于' : '低于'}行业基准 ${benchmark}%）。`;
  return { conclusion, reasoning: [`${iy.metricName || '投资收益率'} ${latest.value}%，行业基准 ${benchmark}%。`] };
}

function buildInsuranceNBVConclusion(nb) {
  if (!nb || !nb.hasData || !Array.isArray(nb.data) || nb.data.length === 0) return null;
  const latest = nb.data[nb.data.length - 1];
  const latestCum = latest.cumulative != null ? latest.cumulative : latest.value;
  const conclusion = `最新季度（${latest.label}）NBV 当季 ${latest.value} 亿、累计 ${latestCum} 亿。`;
  const reasoning = [`最新季度 ${latest.label}：当季 NBV ${latest.value} 亿，累计 ${latestCum} 亿。`, ...(nb.note ? [nb.note] : [])];
  return { conclusion, reasoning };
}

function buildInsuranceProfitCompConclusion(pc) {
  if (!pc || !Array.isArray(pc.data) || pc.data.length === 0) return null;
  const latest = pc.data[pc.data.length - 1];
  const gap = (latest.operatingProfit || 0) - (latest.netProfit || 0);
  const conclusion = `${latest.year} 年营运利润 ${latest.operatingProfit || 0} 亿、净利润 ${latest.netProfit || 0} 亿，差额 ${gap.toFixed(1)} 亿。`;
  return { conclusion, reasoning: pc.trendNote ? [pc.trendNote] : [] };
}

function buildInsurancePEVConclusion(pev) {
  if (!pev) return null;
  if (pev.currentPEV == null) return { conclusion: 'P/EV 数据不足。', reasoning: [] };
  const conclusion = `当前 P/EV 约 ${pev.currentPEV}，${pev.interpretation || ''}`;
  return { conclusion, reasoning: [pev.interpretation || '', ...(pev.note ? [pev.note] : [])].filter(Boolean) };
}

function buildInsuranceDDMConclusion(ddm) {
  if (!ddm) return null;
  if (ddm.intrinsicValue == null) return { conclusion: 'DDM 数据不足。', reasoning: [] };
  const conclusion = `DDM 内在价值 ¥${fmtPrice(ddm.intrinsicValue)}，当前股价 ¥${fmtPrice(ddm.currentPrice)}，评级：${ddm.rating || '--'}。`;
  const reasoning = [`模型 ${ddm.model || 'DDM'} · 平均增速 ${ddm.avgGrowth != null ? ddm.avgGrowth.toFixed(1) + '%' : '--'} · 折现率 ${ddm.discountRate || '--'}% · 永续增长 ${ddm.terminalGrowth || '--'}%`, ...(ddm.note ? [ddm.note] : [])];
  return { conclusion, reasoning };
}

function buildBusinessLineConclusion(series, name) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const latest = series[series.length - 1];
  const first = series[0];
  const yo = latest.yoy;
  const conclusion = `${name} ${first.year}~${latest.year} 由 ${first.value} 亿变动至 ${latest.value} 亿，最新同比 ${yo !== undefined && yo !== null ? fmtPct(yo) : '--'}。`;
  return { conclusion, reasoning: [`最新年度 ${latest.year}：${name} ${latest.value} 亿。`] };
}

function buildValuationReasoning(conclusionObj) {
  if (!conclusionObj || !Array.isArray(conclusionObj.ratings)) return [];
  const r = conclusionObj.ratings.map(rt => `【${rt.method}】(权重 ${Math.round((rt.weight || 0.25) * 100)}%) ${rt.detail}`);
  r.push('综合评级采用「按公司类型加权」打分，权重越高的方法对结论影响越大。');
  return r;
}

module.exports = { buildRevenueConclusion, buildCashFlowConclusion, buildGrowthConclusion, buildMarginConclusion, analyzeRoeMarginTrend, buildBalanceConclusion, buildDividendConclusion, buildDCFConclusion, buildAssetCompConclusion, buildLiabCompConclusion, buildMarketCapConclusion, buildProfitVsCashConclusion, buildRevVsCostConclusion, buildRevVsExpConclusion, buildPayableConclusion, buildValuationMetricConclusion, buildDivYieldConclusion, buildSegmentProductConclusion, buildSegmentRegionConclusion, buildProductMarginConclusion, buildInsurancePremiumConclusion, buildInsuranceCombinedRatioConclusion, buildInsuranceInvestmentYieldConclusion, buildInsuranceNBVConclusion, buildInsuranceProfitCompConclusion, buildInsurancePEVConclusion, buildInsuranceDDMConclusion, buildBusinessLineConclusion, buildValuationReasoning };

~~~

---

## `lib\deep\dividends.js`  ·  196 行

~~~js
/**
 * lib/deep/dividends.js —— deepAnalysis 领域子模块：分红抓取/校准/阶段判定 + SQLite 持久化
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * classifyDividendStage/dividendLabel（单一展示口径）被本模块与 deep/pipeline 共用；
 * aggregateAnnualDPS 供 deep/yield 复用。
 */
const axios = require('axios');
const db = require('../db'); // 本地 SQLite 数据层（node:sqlite，零额外依赖）
const { UA } = require('./shared');

// Fetch dividend data (uses datacenter API which works reliably)
async function fetchDividends(code) {
  const stockCode = code.replace(/^(SH|SZ)/, '');
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=REPORT_DATE&sortTypes=-1&pageSize=60&pageNumber=1&reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000
    });
    if (resp.data && resp.data.result && resp.data.result.data) {
      const rows = resp.data.result.data.map(d => ({
        year: d.REPORT_DATE ? d.REPORT_DATE.slice(0, 4) : '',
        reportDate: d.REPORT_DATE || '',
        plan: d.IMPL_PLAN_PROFILE || '',
        // PRETAX_BONUS_RMB is per 10 shares (e.g. 17.5 means 1.75 per share)
        dividendPerShare: (parseFloat(d.PRETAX_BONUS_RMB) || 0) / 10,
        // Total dividend amount = perShare * totalShares
        totalShares: d.TOTAL_SHARES || 0,
        dividend: (parseFloat(d.PRETAX_BONUS_RMB) || 0) / 10 * (d.TOTAL_SHARES || 0),
        recordDate: d.EQUITY_RECORD_DATE || '',
        exDate: d.EX_DIVIDEND_DATE || '',
        progress: d.ASSIGN_PROGRESS || '',
      })).filter(d => d.year);
      // 东方财富分红表未收录中国平安 2018 年 30 周年特别股息，按公司公告补充
      return calibrateDividends(code, rows);
    }
  } catch (e) {
    console.error('Dividend data failed:', e.message);
  }
  return [];
}

// 对已知数据源缺失的分红记录做校准补充（仅针对公开公告中明确存在的特别股息）
function calibrateDividends(code, rows) {
  const normalized = code.toUpperCase().replace(/^(SH|SZ)/, '');
  // 中国平安 601318：2018 年 6 月 7 日派发 30 周年特别股息每股 0.20 元（含税）
  if (normalized === '601318') {
    const has2018Special = rows.some(d => d.year === '2018' && d.exDate && d.exDate.startsWith('2018-06-07') && Math.abs(d.dividendPerShare - 0.2) < 0.001);
    if (!has2018Special) {
      rows.push({
        year: '2018',
        plan: '10派2元(含税) 30周年特别股息',
        dividendPerShare: 0.2,
        totalShares: 0,
        dividend: 0,
        recordDate: '2018-06-06',
        exDate: '2018-06-07',
        progress: '已实施',
        _calibrated: true,
      });
    }
  }
  return rows;
}

// 分红阶段判定（规则一：单一展示口径）—— 由 REPORT_DATE 月份决定中报/年报，plan 含"特别"为特别股息。
// 同时被 dividendPayouts（前端展示）与 DB 持久化（loadDividendSeries）复用，保证同一指标只此一处逻辑。
function classifyDividendStage(reportDate, plan) {
  const reportMonth = (reportDate || '').slice(5, 7);
  let stage = '年度';
  if (reportMonth === '06') stage = '中期';
  else if (/特别/.test(plan || '')) stage = '特别';
  return stage;
}
function dividendLabel(year, stage) {
  return stage === '年度' ? `${year}年报` : stage === '中期' ? `${year}年中报` : `${year}年${stage}`;
}

// 规范化股票代码：去掉 SH/SZ/BJ 前缀，统一以数字代码作为 DB 主键（避免 sh601318 / 601318 双份）。
function normalizeSymbol(s) {
  return String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '');
}

// 把分红原始记录落地到本地 SQLite（规则一·五要素 + 规则三·时序）。
// rows 来自 fetchDividends（已是「单一权威来源」），这里只做存储，不二次取数。
function persistDividends(symbol, emCode, rows) {
  try {
    const norm = normalizeSymbol(emCode || symbol);
    if (!norm || !rows || !rows.length) return;
    const SRC = 'eastmoney:RPT_SHAREBONUS_DET';
    for (const r of rows) {
      const asOf = r.reportDate || r.exDate || '';
      const stage = classifyDividendStage(r.reportDate, r.plan);
      const extra = {
        year: r.year,
        stage,
        label: dividendLabel(r.year, stage),
        plan: r.plan || '',
        progress: r.progress || '',
        isPending: !/实施|派发|派息/.test(r.progress || ''),
        exDate: r.exDate || '',
        recordDate: r.recordDate || '',
        source: SRC,
      };
      db.upsertSeries({ symbol: norm, metric: 'dividend_per_share', asOf, value: r.dividendPerShare || 0, source: SRC, extra });
      db.upsertSeries({ symbol: norm, metric: 'dividend_total_yi', asOf, value: r.dividend || 0, source: SRC, extra });
    }
    console.log(`[DB] persisted ${rows.length} dividend records for ${norm}`);
  } catch (e) {
    console.error('[DB] persistDividends failed:', e.message);
  }
}

// 从 SQLite 读回分红时序，并直接附上 变化率 + 边际变化（规则三），前端/接口无需再算。
function loadDividendSeries(symbol) {
  const norm = normalizeSymbol(symbol);
  const perShare = db.getSeriesWithMarginal(norm, 'dividend_per_share');
  const total = db.getSeries(norm, 'dividend_total_yi');
  const totalMap = new Map(total.map((t) => [t.as_of, t.value]));
  return perShare.map((r) => {
    const e = r.extra || {};
    return {
      asOf: r.as_of,
      year: e.year,
      label: e.label,
      stage: e.stage,
      perShare: r.value,
      amountYi: totalMap.has(r.as_of) ? totalMap.get(r.as_of) : null,
      plan: e.plan,
      progress: e.progress,
      isPending: e.isPending,
      exDate: e.exDate,
      changePct: r.changePct,
      marginal: r.marginal,
      direction: r.direction,
      source: r.source,
      fetchedAt: r.fetched_at,
    };
  });
}

// 把估值核心标量（PE/PB/PS 最新值）落地到 data_points（规则一·五要素 + 规则二·TTL）。
// 单一数据源：valuationHub 的 latest（每条已带 value/dataTime/source/fetchTime），兜底用 analyzeValuation 的 currentPeTtm。
// 每个指标只用一个 key（pe_ttm / pb_mrq / ps_ttm），避免同指标双源。
function persistValuationScalars(symbol, emCode, valuation) {
  try {
    const norm = normalizeSymbol(emCode || symbol);
    if (!norm || !valuation) return;
    const ttl = 'financial';
    const rules = valuation.rules;
    const hub = rules && rules.latest;
    if (hub && hub.pe && typeof hub.pe.value === 'number' && hub.pe.value > 0) {
      db.upsertDataPoint({
        symbol: norm, key: 'pe_ttm', value: hub.pe.value,
        asOf: hub.pe.dataTime || null, source: hub.pe.source || (rules.source) || '东方财富TTM',
        ttlType: ttl, extra: { fetchTime: hub.pe.fetchTime },
      });
    } else if (valuation.currentPeTtm > 0) {
      db.upsertDataPoint({
        symbol: norm, key: 'pe_ttm', value: valuation.currentPeTtm,
        asOf: null, source: valuation.peSource || '东方财富TTM', ttlType: ttl,
      });
    }
    if (hub) {
      const map = { pb: 'pb_mrq', ps: 'ps_ttm' };
      for (const k of Object.keys(map)) {
        const d = hub[k];
        if (d && typeof d.value === 'number' && d.value > 0) {
          db.upsertDataPoint({
            symbol: norm, key: map[k], value: d.value,
            asOf: d.dataTime || null, source: d.source || (rules.source) || '东方财富TTM',
            ttlType: ttl, extra: { fetchTime: d.fetchTime },
          });
        }
      }
    }
    console.log(`[DB] persisted valuation scalars for ${norm}`);
  } catch (e) {
    console.error('[DB] persistValuationScalars failed:', e.message);
  }
}

// 聚合每年每股分红（中国平安等中期+末期多次分红，按 REPORT_DATE 年份汇总）
function aggregateAnnualDPS(dividends) {
  const map = {};
  for (const d of (dividends || [])) {
    if (!d.year) continue;
    const dps = parseFloat(d.dividendPerShare) || 0;
    map[d.year] = (map[d.year] || 0) + dps;
  }
  return map; // { '2025': 1.5, ... }
}

module.exports = { fetchDividends, calibrateDividends, classifyDividendStage, dividendLabel, normalizeSymbol, persistDividends, loadDividendSeries, persistValuationScalars, aggregateAnnualDPS };

~~~

---

## `lib\deep\financials.js`  ·  301 行

~~~js
/**
 * lib/deep/financials.js —— deepAnalysis 领域子模块：东方财富 F10 财务三表 + 股东数据抓取
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 导出（供 deep/pipeline 与门面使用）：fetchFinancialData / fetchShareholders /
 * buildShareholderStats / fetchTopShareholders（后三个不进门面，仅内部）。
 */
const axios = require('axios');
const { UA, HEADERS, _stmtStage } = require('./shared');

const EM_FINANCE_BASE = 'https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis';

// 取「最近 N 个已完结年度」的 12-31 报告期（不包含当年未来日期，
// 否则 East Money 对 2026-12-31 返回空、实际只拿到 N-1 个真实年报年，导致最早一年缺失）
function getAnnualDates(years = 10) {
  const currentYear = new Date().getFullYear();
  const dates = [];
  for (let i = 0; i < years; i++) {
    dates.push(`${currentYear - 1 - i}-12-31`);
  }
  return dates;
}

// Fetch financial statement (income/balance/cashflow) for multiple years
// 20261015f：companyType 回退链由 [4,2] 扩展为 [4,2,3,1]，与 lib/stockData.js 现金流量表
// 取数（xjllbAjaxNew，注释「不同行业 companyType 不同（通用4/银行2/保险3/券商1）依次尝试」）
// 完全对齐。根因（服务日志实测 + 接口实测）：券商股（如 000783 长江证券 / 600909 华安证券）的
// 资产负债表 zcfzbAjaxNew / 现金流量表 xjllbAjaxNew 仅 companyType=1 有数据，ct=4/2/3 全部
// 返回空 → 深析页 Balance: 0 / Cashflow: 0，资产负债与现金流分析、DCF 全部失真。
// 普通股 ct=4 首次命中（一次请求，行为不变）；保险/银行/券商逐级回退，任一类型返回非空即用。
async function fetchFinancialStatement(type, code, dates) {
  for (const companyType of [4, 2, 3, 1]) {
    const url = `${EM_FINANCE_BASE}/${type}?companyType=${companyType}&reportDateType=0&reportType=1&dates=${dates.join(',')}&code=${code}`;
    try {
      const resp = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      if (resp.data && resp.data.data && Array.isArray(resp.data.data) && resp.data.data.length > 0) {
        return resp.data.data.sort((a, b) => {
          return new Date(a.REPORT_DATE) - new Date(b.REPORT_DATE);
        });
      }
      console.log(`[FetchStmt] companyType=${companyType} returned no data for ${type}, trying next companyType...`);
    } catch (e) {
      console.error(`Fetch ${type} (companyType=${companyType}) failed:`, e.message);
    }
  }
  return [];
}

// 深度分析使用的年报数据回溯年数（用户要求固定为 5 年）
const ANALYSIS_YEARS = 5;

// 计算「部分报告期」日期列表，用于 TTM 滚动估算 / 单季拆分。
// 20261023h：改为「直接请求最近两年的全部季末报告期」，由 F10 返回实际已披露的那些；
// 不再按月份猜「现在是几季报」——原实现 10 月仍判中报季（q=2），三季报已披露也不请求 09-30，
// 导致「三季报已出、模块仍解读半年报」（用户 2026-10-23 洲明科技 300232 报障）。
// 早于披露日请求时 F10 返回空，天然无副作用；披露后同一次请求即可取到。
// 12-31（年报）由调用方 _stmtStage==='FY' 过滤，不会混入「部分报告」。
function getLatestPartialQuarterDates(now = new Date()) {
  const cy = now.getFullYear();
  const qe = ['03-31', '06-30', '09-30', '12-31'];
  const dates = [];
  for (const d of qe) dates.push(`${cy}-${d}`, `${cy - 1}-${d}`);
  return dates;
}

// 合并年报与部分报告，去重（同一 REPORT_DATE 不重复）
function mergePartialStatements(annual, partial) {
  if (!partial || !partial.length) return annual;
  const seen = new Set((annual || []).map(r => r.REPORT_DATE));
  const out = (annual || []).slice();
  for (const r of partial) {
    if (r.REPORT_DATE && !seen.has(r.REPORT_DATE)) { out.push(r); seen.add(r.REPORT_DATE); }
  }
  return out;
}

// Fetch annual financial data for the most recent N years
async function fetchFinancialData(code) {
  const dates = getAnnualDates(ANALYSIS_YEARS); // 最近 N 年

  const [income, balance, cashflow] = await Promise.all([
    fetchFinancialStatement('lrbAjaxNew', code, dates),
    fetchFinancialStatement('zcfzbAjaxNew', code, dates),
    fetchFinancialStatement('xjllbAjaxNew', code, dates),
  ]);

  // 补充最新一期非年报（利润表 / 现金流量表），供营收/成本/营运利润/经营现金流做 TTM 滚动估算（如 2026 仅出中报时）
  let mergedIncome = income;
  let mergedCashflow = cashflow;
  try {
    const partDates = getLatestPartialQuarterDates();
    if (partDates.length) {
      const [partialIncome, partialCashflow] = await Promise.all([
        fetchFinancialStatement('lrbAjaxNew', code, partDates),
        fetchFinancialStatement('xjllbAjaxNew', code, partDates),
      ]);
      // 仅保留真正的部分报告（非年报）
      const partInc = (partialIncome || []).filter(r => {
        const st = _stmtStage(r.REPORT_DATE_NAME || '');
        return st && st !== 'FY';
      });
      const partCf = (partialCashflow || []).filter(r => {
        const st = _stmtStage(r.REPORT_DATE_NAME || '');
        return st && st !== 'FY';
      });
      mergedIncome = mergePartialStatements(income, partInc);
      mergedCashflow = mergePartialStatements(cashflow, partCf);
    }
  } catch (e) {
    console.error('[FetchPartial] failed, fall back to annual only:', e.message);
    mergedIncome = income;
    mergedCashflow = cashflow;
  }

  return { income: mergedIncome, balance, cashflow: mergedCashflow };
}

// Fetch shareholder data
// 20261015f：数据源统一——原走 push2.eastmoney.com（本机常年被对端 TLS 重置，服务日志实测
// 000783/600909 持续 socket hang up，深析估值/DCF/公司分类长期拿不到股本与市值），现改为
// 东财「数据中心」估值分析报表 RPT_VALUEANALYSIS_DET（datacenter-web 本机稳定可达）。
// 与两个既有权威口径完全一致：①基本面的 totalShares / PS_TTM 同源同报表
// （lib/stockData.fetchStockValuationAnalysis）；②与腾讯行情实测逐位吻合（000783 实测：
// datacenter 总股本 5,530,072,948 股、总市值 431.90 亿、PE_TTM 8.3832/PB 1.1703 = 腾讯
// 8.38/1.17/431.90 亿）。返回六字段与原 push2 f84/f85/f116/f117/f162/f163 完全同名同单位
// （股/股/元/元/倍/倍），下游 analyzeValuation / calculateDCF / classifyCompanyType 零改动。
// 失败时仍返回 null（消费方已有 quote 兜底链，维持契约不伪造）。
async function fetchShareholders(code) {
  const stockCode = String(code || '').replace(/^(SH|SZ|BJ)/i, '');
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=1&pageNumber=1&reportName=RPT_VALUEANALYSIS_DET&columns=ALL&source=WEB&client=WEB&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000
    });
    const d = resp.data?.result?.data?.[0];
    if (d && Number(d.TOTAL_SHARES) > 0) {
      return {
        totalShares: Number(d.TOTAL_SHARES) || 0,
        floatShares: Number(d.FREE_SHARES_A) || 0,
        pe: Number(d.PE_TTM) || 0,
        pb: Number(d.PB_MRQ) || 0,
        totalMarketCap: Number(d.TOTAL_MARKET_CAP) || 0,
        floatMarketCap: Number(d.NOTLIMITED_MARKETCAP_A) || 0,
      };
    }
  } catch (e) {
    console.error('Shareholder data failed:', e.message);
  }
  return null;
}

// 判断股东是否为机构（基金/证券/保险/社保/资管/陆股通/法人等），用于机构持股统计
function isInstitutionName(name) {
  const n = name || '';
  if (/陆股通|香港中央结算/.test(n)) return true;            // 外资/机构通道
  if (/基金|证券|保险|社保|养老|信托|银行|证金|汇金|资管|资产|投资|集团|控股|理财|年金|私募|合伙/.test(n)) return true;
  if (/有限公司|股份公司|企业|公司$/.test(n)) return true;   // 法人股东
  // 纯中文短名（2-4字且无机构关键词）多数为自然人
  const isShortChineseName = /^[\u4e00-\u9fa5]{2,4}$/.test(n.replace(/[（(].*$/, '').trim());
  if (isShortChineseName && !/公司|集团|基金/.test(n)) return false;
  return false;
}

// 基于前十大股东计算机构统计
function buildShareholderStats(topHolders, totalShares) {
  if (!Array.isArray(topHolders) || topHolders.length === 0) return null;
  let instCount = 0, instRatio = 0;
  for (const h of topHolders) {
    if (h.isInstitution) { instCount++; instRatio += (h.holdRatio || 0); }
  }
  return {
    institutionCount: instCount,
    institutionRatio: Math.round(instRatio * 100) / 100,
    topHoldersEndDate: topHolders[0]?.endDate || '',
    totalShares,
    note: '机构统计基于披露的前十大股东（含基金/证券/保险/社保/资管/陆股通/法人等），自然人股东不计入；机构占总股本比例为前十大中机构持股之和。',
  };
}

// Fetch top 10 shareholders
// 20260823h：同步 shareholderData.js 的数值解析，新增 changeAmount/changeRatio，避免深度分析页
// 与短期判断因子使用同一数据源却两套字段。
// 20260913g：与 shareholderData.js 同步修正报告期选取——pageSize 由 10 提到 80，并取
// 「最新一个满 10 行的完整披露日」（含非季度末的权益变动/临时披露，如海天味业 2026-07-03），
// 不再只认季度末；endDate 统一截取到 10 位、新增 periodKind。避免深度分析页与短期判断两卡口径不一致。
const _QE_RE = /-(03-31|06-30|09-30|12-31)$/;
function _pickLatestDisclosure(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = String(r.END_DATE || '').slice(0, 10);
    if (d) byDate[d] = (byDate[d] || 0) + 1;
  }
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return { date: '', kind: '' };
  const full = dates.filter(d => byDate[d] >= 10);
  let date = full.length ? full[full.length - 1] : '';
  if (!date) {
    const q = dates.filter(d => _QE_RE.test(d));
    date = q.length ? q[q.length - 1] : dates[dates.length - 1];
  }
  return { date, kind: _QE_RE.test(date) ? '季度末报告期' : '最新披露（权益变动/临时公告）' };
}
async function fetchTopShareholders(code) {
  const stockCode = code.replace(/^(SH|SZ)/, '');
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=END_DATE&sortTypes=-1&pageSize=80&pageNumber=1&reportName=RPT_F10_EH_HOLDERS&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000
    });
    if (resp.data?.result?.data) {
      const _rows = resp.data.result.data;
      const _picked = _pickLatestDisclosure(_rows);
      return _rows.filter(h => String(h.END_DATE || '').slice(0, 10) === _picked.date).map(h => {
        const rawChange = h.HOLD_NUM_CHANGE;
        const rawRatio = h.CHANGE_RATIO;
        let changeText = '';
        let changeAmount = null;
        let changeRatio = null;
        if (rawChange != null) {
          if (typeof rawChange === 'number') {
            changeAmount = rawChange;
            changeText = rawChange > 0 ? '增持' : rawChange < 0 ? '减持' : '不变';
          } else {
            changeText = String(rawChange);
            const n = Number(changeText.replace(/,/g, ''));
            if (!Number.isNaN(n)) changeAmount = n;
          }
        }
        if (rawRatio != null) {
          const r = Number(rawRatio);
          if (!Number.isNaN(r)) changeRatio = r;
        }
        return {
          name: h.HOLDER_NAME || '',
          holdRatio: h.HOLD_NUM_RATIO || 0,
          holdAmount: h.HOLD_NUM || 0,
          change: changeText,
          changeAmount,
          changeRatio,
          endDate: _picked.date,
          periodKind: _picked.kind,
          isInstitution: isInstitutionName(h.HOLDER_NAME || ''),
        };
      });
    }
  } catch (e) {
    console.error('Top shareholders failed:', e.message);
  }
  return [];
}

// ─── 20261029a：营运利润（利润表「营业利润」科目）两期快照 ───
// 「关键财务指标」模块新增「营运利润」行的数据源。已实测核实：zyzbHistory（主要指标
// ZYZBAjaxNew）无 OPERATE_PROFIT 字段（601318 返回字段仅 TOTALOPERATEREVE/PARENTNETPROFIT 等），
// 营业利润必须取 F10 利润表 lrbAjaxNew（companyType 回退链 [4,2,3,1] 与既有口径一致）。
// dates = [最新报告期, 去年同期]（如 ['2026-06-30','2025-06-30']，由调用方从
// quote.fundamentals.reportDate 推导），一次轻量请求只取两期。
// 返回 { cur:{date,opProfitYi}, prev:{date,opProfitYi}|null, yoyPct:number|null }；
// 任一期取不到即如实降级（cur 缺 → 返回 null，整行不渲染，绝不编造）。
async function fetchOpProfitSnippet(code, dates) {
  const uniq = Array.from(new Set((dates || []).filter(Boolean)));
  if (!code || !uniq.length) return null;
  const rows = await fetchFinancialStatement('lrbAjaxNew', code, uniq);
  if (!Array.isArray(rows) || !rows.length) return null;
  const pick = (d) => {
    const r = rows.find(x => String(x.REPORT_DATE || '').slice(0, 10) === d);
    if (!r) return null;
    const n = parseFloat(r.OPERATE_PROFIT);
    if (!isFinite(n)) return null;   // 缺科目如实缺失；负值（亏损）是有效数据，不过滤
    return { date: d, opProfitYi: Math.round(n / 1e8 * 100) / 100 };
  };
  // uniq[0] 为最新报告期（调用方按 [最新, 去年同期, 最新上期, 去年上期] 传入）
  const cur = pick(uniq[0]);
  if (!cur) return null;
  const prev = uniq[1] ? pick(uniq[1]) : null;
  let yoyPct = null;
  if (prev && prev.opProfitYi !== 0) {
    // 同比基数为负时用 |prev| 避免符号翻转出无意义增速（代码权威，非估算）
    yoyPct = Math.round((cur.opProfitYi - prev.opProfitYi) / Math.abs(prev.opProfitYi) * 100 * 100) / 100;
  }
  // 20261102a（用户指令：指标优先最新单季口径）：单季值 = 本期累计 − 上期累计（Q1 报告期单季=累计，
  // 无需上期）；去年同期单季同理。上期累计缺失时 sq 项为 null（如实缺失，展示层回退累计并标注）。
  const cumPrev = uniq[2] ? pick(uniq[2]) : null;    // 最新期的上期累计（同年内，如 9-30 → 6-30）
  const cumPrevYy = uniq[3] ? pick(uniq[3]) : null;  // 去年同期的上期累计
  const mm = parseInt(String(uniq[0]).slice(5, 7), 10);
  const diff = (a, b) => (a != null && b != null) ? Math.round((a - b) * 100) / 100 : null;
  const sqCurYi = (mm === 3) ? cur.opProfitYi : diff(cur.opProfitYi, cumPrev ? cumPrev.opProfitYi : null);
  const sqPrevYi = prev ? ((mm === 3) ? prev.opProfitYi : diff(prev.opProfitYi, cumPrevYy ? cumPrevYy.opProfitYi : null)) : null;
  let sqYoyPct = null;
  if (sqCurYi != null && sqPrevYi != null && sqPrevYi !== 0) {
    sqYoyPct = Math.round((sqCurYi - sqPrevYi) / Math.abs(sqPrevYi) * 100 * 100) / 100;
  }
  const sqCur = sqCurYi != null ? { date: cur.date, opProfitYi: sqCurYi } : null;
  const sqPrev = (sqPrevYi != null && prev) ? { date: prev.date, opProfitYi: sqPrevYi } : null;
  return { cur, prev, yoyPct, sqCur, sqPrev, sqYoyPct };
}

module.exports = { fetchFinancialData, fetchFinancialStatement, fetchShareholders, buildShareholderStats, fetchTopShareholders, getLatestPartialQuarterDates, fetchOpProfitSnippet };

~~~

---

## `lib\deep\pipeline.js`  ·  580 行

~~~js
/**
 * lib/deep/pipeline.js —— deepAnalysis 领域子模块：主流程编排（deepAnalysis 入口）+ 小节结论装配 + 筹码分布接线
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 循环依赖切割点（唯一非纯搬运的代码变更）：原主文件顶层 require('./aiAugment') 的 readCache
 * 改为静态 require('../ai/cache')——deepAnalysis 门面不再依赖 aiAugment，加载期环彻底消失。
 * 函数体零改动（仅块内 1 处懒加载 require 的相对路径 +1 层级）。
 */
const { isInsuranceCompany, analyzeInsuranceCompany } = require('../insuranceAnalysis');
const { classifyCompanyType } = require('../companyType');
const { analyzeChangesForSymbol } = require('../changeAnalysis');
const { fetchValuationTTM } = require('../eastmoneyValuation');
const { getValuationHub, beginSnapshot } = require('../valuationHub');
const { getFinanceHub } = require('../financeHub');
const { wrapQuote } = require('../quoteHub');
const db = require('../db'); // 本地 SQLite 数据层（node:sqlite，零额外依赖）
const { readCache, readEarningsCache } = require('../ai/cache'); // 202609 拆分重构：替代原 require('./aiAugment')（循环依赖切割点）
const { toYi, withTimeout } = require('./shared');
const { computeChipDistribution } = require('../chipDistribution'); // 20261105j U1：筹码分布统一到锚点三本地 CYQ 模块
const { fetchFinancialData, fetchShareholders, buildShareholderStats, fetchTopShareholders } = require('./financials');
const { fetchDividends, persistDividends, classifyDividendStage, dividendLabel, normalizeSymbol, persistValuationScalars } = require('./dividends');
const { analyzeDividendYield } = require('./yield');
const { analyzeRevenueCost, analyzeBalanceSheet, analyzeCashFlow, analyzeValuation, analyzeGrowth, calculateDCF } = require('./statements');
const {
  buildRevenueConclusion, buildCashFlowConclusion, buildGrowthConclusion, buildMarginConclusion,
  analyzeRoeMarginTrend, buildBalanceConclusion, buildDividendConclusion, buildDCFConclusion,
  buildAssetCompConclusion, buildLiabCompConclusion, buildMarketCapConclusion, buildProfitVsCashConclusion,
  buildRevVsCostConclusion, buildRevVsExpConclusion, buildPayableConclusion, buildValuationMetricConclusion,
  buildDivYieldConclusion, buildSegmentProductConclusion, buildSegmentRegionConclusion, buildProductMarginConclusion,
  buildInsurancePremiumConclusion, buildInsuranceCombinedRatioConclusion, buildInsuranceInvestmentYieldConclusion,
  buildInsuranceNBVConclusion, buildInsuranceProfitCompConclusion, buildInsurancePEVConclusion, buildInsuranceDDMConclusion,
  buildBusinessLineConclusion, buildValuationReasoning,
} = require('./conclusions');
const { generateConclusion } = require('./conclusion');
const { getLocalDocuments, fetchSegmentData, buildProductGrossMargin } = require('./research');

// 给各 section 附加 conclusion / reasoning
// 注意：部分 section 本身是数组（如 revenueCostData / cashFlowData），数组上的
// 自定义属性在 JSON 序列化时会被丢弃，因此统一收集到 sections._conclusions 这个
// 普通对象中，确保前端能稳定拿到结论与论证。
function augmentSections(sections, ctx) {
  const c = {};

  // ---- 营收与盈利趋势（含毛利率维度）----
  const rc = buildRevenueConclusion(sections.revenueCostData);
  if (rc) c.revenueCost = rc;

  // ---- 现金流 ----
  const cf = buildCashFlowConclusion(sections.cashFlowData);
  if (cf) c.cashFlow = cf;

  const g = buildGrowthConclusion(sections.growth);
  if (g) c.growth = g;

  const m = buildMarginConclusion(sections.revenueCostData);
  if (m) c.margin = m;

  const bal = buildBalanceConclusion(sections.shortTermRisk, sections.assetComposition, sections.liabilityComposition, ctx.balanceAnalysis);
  if (bal) c.balance = bal;

  const div = buildDividendConclusion(sections.dividendData);
  if (div) c.dividend = div;

  const dcfC = buildDCFConclusion(sections.dcf);
  c.dcf = dcfC;

  if (sections.conclusion) {
    const vr = buildValuationReasoning(sections.conclusion);
    c.valuation = { conclusion: sections.conclusion.conclusionText, reasoning: vr };
  }

  // ---- 资产 / 负债构成 ----
  const assetConcl = buildAssetCompConclusion(sections.assetComposition, sections.totalAssets);
  if (assetConcl) c.asset = assetConcl;

  const liabConcl = buildLiabCompConclusion(sections.liabilityComposition, sections.totalLiabilities);
  if (liabConcl) c.liability = liabConcl;

  // ---- 市值对比（营收 / 净利润 / 净资产 vs 市值）----
  const mcRevenue = buildMarketCapConclusion(sections.marketCapData, 'revenue', '营业总收入', '市销率');
  if (mcRevenue) c.marketCapRevenue = mcRevenue;
  const mcProfit = buildMarketCapConclusion(sections.marketCapData, 'netProfit', '归母净利润', '市盈率');
  if (mcProfit) c.marketCapProfit = mcProfit;
  const mcNav = buildMarketCapConclusion(sections.marketCapData, 'netAssets', '净资产', '市净率');
  if (mcNav) c.marketCapNav = mcNav;

  // ---- 净利润 vs 经营现金流（业绩真实性）----
  const pvc = buildProfitVsCashConclusion(sections.cashFlowData);
  if (pvc) c.profitVsCash = pvc;

  // ---- 营收 vs 总成本 ----
  const rvc = buildRevVsCostConclusion(sections.revenueCostData);
  if (rvc) c.revVsCost = rvc;

  // ---- 营收 vs 三费 ----
  const rve = buildRevVsExpConclusion(sections.expenseData);
  if (rve) c.revVsExp = rve;

  // ---- 营收 vs 应付账款 ----
  const pay = buildPayableConclusion(sections.payableData);
  if (pay) c.payable = pay;

  // ---- 估值指标（PE / PB / PS）----
  const vPE = buildValuationMetricConclusion(sections.valuation, 'PE');
  if (vPE) c.valuationPE = vPE;
  const vPB = buildValuationMetricConclusion(sections.valuation, 'PB');
  if (vPB) c.valuationPB = vPB;
  const vPS = buildValuationMetricConclusion(sections.valuation, 'PS');
  if (vPS) c.valuationPS = vPS;

  // ---- 股息率趋势 ----
  const dy = buildDivYieldConclusion(sections.dividendYieldData);
  if (dy) c.divYield = dy;

  // ---- 分产品 / 分地区主营构成 ----
  const segP = buildSegmentProductConclusion(sections.segmentData);
  if (segP) c.segmentProduct = segP;
  const segR = buildSegmentRegionConclusion(sections.segmentData);
  if (segR) c.segmentRegion = segR;

  // ---- 细分产品毛利率 ----
  const pm = buildProductMarginConclusion(sections.productGrossMargin);
  if (pm) c.productMargin = pm;

  // ---- 保险公司专属结论 ----
  const insurance = sections.insuranceAnalysis;
  if (insurance && insurance.sections) {
    const s = insurance.sections;
    const premium = buildInsurancePremiumConclusion(s.premiumAnalysis);
    if (premium) c.premium = premium;
    const cr = buildInsuranceCombinedRatioConclusion(s.combinedRatioAnalysis);
    if (cr) c.combinedRatio = cr;
    const iy = buildInsuranceInvestmentYieldConclusion(s.investmentYieldAnalysis);
    if (iy) c.investmentYield = iy;
    const nbv = buildInsuranceNBVConclusion(s.nbvAnalysis);
    if (nbv) c.nbv = nbv;
    const pc = buildInsuranceProfitCompConclusion(s.profitDivergence);
    if (pc) c.insuranceProfit = pc;
    const pev = buildInsurancePEVConclusion(s.pevValuation);
    if (pev) c.pev = pev;
    const ddm = buildInsuranceDDMConclusion(s.ddmValuation);
    if (ddm) c.ddm = ddm;
    const bl = s.businessLines || {};
    const life = buildBusinessLineConclusion(bl.life, '寿险保费');
    if (life) c.businessLife = life;
    const prop = buildBusinessLineConclusion(bl.property, '财产险保费');
    if (prop) c.businessProperty = prop;
    const pens = buildBusinessLineConclusion(bl.pension, '养老险保费');
    if (pens) c.businessPension = pens;
    const health = buildBusinessLineConclusion(bl.health, '健康险保费');
    if (health) c.businessHealth = health;
  }

  sections._conclusions = c;

  return sections;
}

// Main deep analysis function
async function deepAnalysis(symbol, name, quote, history) {
  console.log(`[DeepAnalysis] Starting for ${symbol}...`);
  
  const info = require('../stockData').detectMarket(symbol);
  if (info.market !== 'CN') {
    return { error: '深度分析目前仅支持A股市场', sections: [] };
  }
  
  const code = info.tencentCode.replace(/^(sh|sz)/, m => m.toUpperCase());
  const emCode = `${info.exchange}${info.tencentCode.replace(/^(sh|sz)/, '')}`;
  const stockCode = info.tencentCode.replace(/^(sh|sz)/, '');

  // 规则一：确立「当前价」的唯一权威来源（行情网关 → 腾讯行情）。
  // 此前 currentPrice 存在 quote.price 与 history末日close 两套取法（同指标两值）。
  // 这里用 wrapQuote 包装「已获取」的 quote/history（不二次请求），
  // 避免再发一次网络请求导致两次取价不一致——取数只发生一次，包装也只有一层。
  let priceRef = null;
  let quoteRules = null;
  try {
    const qh = wrapQuote(quote, history);
    if (qh && qh.ok && qh.latest && qh.latest.price && qh.latest.price.value > 0) {
      priceRef = qh.latest.price;
      quoteRules = beginSnapshot(qh);
    }
  } catch (e) {
    console.error('[DeepAnalysis] wrapQuote failed:', e.message);
  }
  // 权威价不可用时，不做静默替换：标记来源为降级，保证可追溯
  if (!priceRef) {
    const fallbackClose = (history && history.length) ? history[history.length - 1].close : 0;
    priceRef = {
      name: '当前价', value: fallbackClose || 0,
      dataTime: (history && history.length) ? history[history.length - 1].date : null,
      source: '日线末日收盘价（行情接口不可用，降级）',
      fetchTime: new Date().toISOString(),
      degraded: true,
    };
  }
  const authoritativePrice = priceRef.value || 0;

  // 规则一·五要素 + 规则二·TTL：把「当前价」这一标量事实落地到 data_points（来源/实际时间/获取时间齐全，5 分钟有效）。
  try {
    db.upsertDataPoint({
      symbol: normalizeSymbol(emCode),
      key: 'current_price',
      value: authoritativePrice,
      asOf: priceRef.dataTime || null,
      source: priceRef.source || 'quote',
      ttlType: 'realtime',
      extra: { degraded: !!priceRef.degraded },
    });
  } catch (e) { console.error('[DB] upsertDataPoint current_price failed:', e.message); }

  // Check local document store first (for historical reports and announcements)
  const localDocuments = getLocalDocuments(stockCode);

  // Detect company type (insurance vs product)
  const isInsurance = isInsuranceCompany(symbol, name, quote);
  console.log(`[DeepAnalysis] Company type: ${isInsurance ? 'Insurance' : 'Product'}`);

  console.log(`[DeepAnalysis] Fetching financial data for ${emCode}...`);

  // Fetch all financial data in parallel
  const [finData, shareholders, dividends] = await Promise.all([
    fetchFinancialData(emCode),
    fetchShareholders(code),
    fetchDividends(emCode),
  ]);

  // 规则一/二/三：分红原始记录落地 SQLite（五要素 + 时序，支撑边际分析）；失败不阻断主流程。
  try { persistDividends(symbol, emCode, dividends); } catch (e2) { console.error('[DeepAnalysis] persistDividends failed:', e2.message); }
  
  const { income, balance, cashflow } = finData;

  // 三规则铺开：财务模块（报告期 + 90 天时效 + 同比增速的边际）
  let financeRules = null;
  try {
    const fh = getFinanceHub(finData);
    if (fh && fh.ok) financeRules = beginSnapshot(fh);
  } catch (e) {
    console.error('[DeepAnalysis] financeHub failed:', e.message);
  }
  
  console.log(`[DeepAnalysis] Income: ${income.length}, Balance: ${balance.length}, Cashflow: ${cashflow.length}`);
  
  if (income.length === 0) {
    return { error: '无法获取财务数据', sections: [] };
  }
  
  // Compute all analysis sections
  const revenueCostData = analyzeRevenueCost(income);
  const balanceAnalysis = analyzeBalanceSheet(balance);
  const cashFlowData = analyzeCashFlow(cashflow, income, revenueCostData);
  // 东方财富 TTM 估值历史（填充当年 2026 数据空缺、修正历史 PE/PB/PS 口径），失败则回退年报口径
  let emValuation = null;
  try {
    emValuation = await fetchValuationTTM(emCode);
    console.log(`[DeepAnalysis] EastMoney TTM valuation: ${emValuation ? emValuation.series.length + ' points (' + emValuation.source + ')' : 'unavailable'}`);
  } catch (e) {
    console.error('[DeepAnalysis] fetchValuationTTM failed:', e.message);
  }
  const valuation = analyzeValuation(finData, quote, shareholders, emValuation);

  // 三规则样板：估值模块统一走 valuationHub（单一数据源 + 五要素 + 时效体检 + 变化与边际）
  // 规则一③：分析期数据锁定——快照后本次分析全程使用冻结数据，中途源更新不影响。
  let valuationRules = null;
  try {
    const hub = await getValuationHub(emCode);
    if (hub && hub.ok) {
      valuationRules = beginSnapshot({
        latest: hub.latest,
        freshness: hub.freshness,
        staleNote: hub.staleNote,
        sanity: hub.sanity,
        analysis: hub.analysis,
        shortTerm: hub.shortTerm,
        source: hub.source,
        fetchedAt: hub.fetchedAt,
      });
    }
  } catch (e) {
    console.error('[DeepAnalysis] valuationHub failed:', e.message);
  }
  // 规则一：估值模块对外只暴露这一份带血缘的数据
  if (valuationRules) valuation.rules = valuationRules;
  // 规则一/二：把估值标量（PE/PB/PS）落地 data_points（五要素 + 90 天 TTL）；失败不阻断主流程。
  try { persistValuationScalars(symbol, emCode, valuation); } catch (e2) { console.error('[DeepAnalysis] persistValuationScalars failed:', e2.message); }
  // 规则一：权威价来源可追溯（供排查；对外输出走 sections.quoteRules）
  if (priceRef) quote.__priceRef = priceRef;
  const growth = analyzeGrowth(revenueCostData);
  const dcf = calculateDCF(finData, balance, quote, shareholders);
  
  // Classify company type (growth / value / dividend / balanced) — 兜底防止整页 500
  let companyType;
  try {
    companyType = classifyCompanyType(symbol, name, quote, finData, shareholders, dividends);
    console.log(`[DeepAnalysis] Company classification: ${companyType.typeName} (${companyType.type})`);
    console.log(`[DeepAnalysis] Classification data: marketCap=${companyType.classificationData.marketCap}亿, PE=${companyType.classificationData.pe}, divYield=${companyType.classificationData.dividendYield}%, revGrowth=${companyType.classificationData.revenueGrowth}%, roe=${companyType.classificationData.roe}%`);
  } catch (e) {
    console.error('[DeepAnalysis] classifyCompanyType failed:', e.message);
    companyType = { type: 'balanced', typeName: '均衡型', typeIcon: '⚖️', description: '', focusText: '各维度均衡评估', classificationData: {}, weights: { valuation: 0.25, profitability: 0.25, growth: 0.25, health: 0.25 } };
  }

  // Audit opinion check
  const latestIncome = income[income.length - 1];
  const auditOpinion = latestIncome?.OPINION_TYPE || '';
  const auditWarning = auditOpinion && !auditOpinion.includes('标准无保留') 
    ? `⚠️ 最新一期审计意见为"${auditOpinion}"，非标准无保留意见，请重点关注！`
    : null;
  
  // Insurance-specific analysis：必须在 generateConclusion 之前拿到 P/EV、DDM，
  // 分业务趋势所需的板块构成数据（8s 超时，绝不拖垮主流程）；提前抓取以便保险分析复用
  const [segmentData] = await Promise.all([
    withTimeout(fetchSegmentData(emCode), 8000, null),
  ]);
  console.log(`[DeepAnalysis] Optional: segment=${segmentData ? 'ok' : 'null'}`);

  // 以便对保险公司压降 DCF 权重并纳入合适的估值口径。
  let insuranceAnalysis = null;
  if (isInsurance) {
    console.log(`[DeepAnalysis] Running insurance-specific analysis...`);
    try {
      insuranceAnalysis = await analyzeInsuranceCompany(emCode, symbol, name, quote, income, balance, cashflow, shareholders, dividends, segmentData);
    } catch (e) {
      console.error('[DeepAnalysis] Insurance analysis failed:', e.message);
      insuranceAnalysis = { isInsurance: true, error: e.message };
    }
  }

  // Generate valuation conclusion (with company type)
  let conclusion;
  try {
    conclusion = await generateConclusion(dcf, valuation, growth, cashFlowData, revenueCostData, balanceAnalysis, auditOpinion, shareholders, companyType, dividends, quote, insuranceAnalysis);
  } catch (e) {
    console.error('[DeepAnalysis] generateConclusion failed:', e.message);
    conclusion = { overallRating: '数据不足', currentPrice: quote?.price || 0, methodsUsed: [], ratings: [], conclusionText: '估值结论生成失败：' + e.message, companyType: companyType.type, companyTypeName: companyType.typeName };
  }

  // 20261105j U1：筹码分布统一到锚点三（lib/chipDistribution.js 本地 CYQ，东财同款 250 日窗口+前复权），
  // 与量价判定「锚点三」同源，替换本文件原 120 日窗口/50 档/指数衰减的过时算法。
  // 流通股本 = 腾讯行情流通市值(亿)×1e8 / 权威价——与 volumeEngine.js 锚点三取法逐行一致；
  // history 日K volume 单位为「手」，与 CYQ 模块入参约定一致（getHistory 三个数据源均统一到手）。
  // 口径诚实约束：新模块不产出 50 档分布曲线/峰值价/价格区间，这些旧字段一律置 null，禁止编造数值。
  const chipDistribution = (() => {
    try {
      const fv = quote && typeof quote.circulationValue === 'number' && quote.circulationValue > 0 ? quote.circulationValue : null;
      const px = authoritativePrice > 0 ? authoritativePrice : (quote && typeof quote.price === 'number' && quote.price > 0 ? quote.price : null);
      if (!fv || !px) return null; // 流通股本或权威价不可得 → 不上报筹码，不做静默估算
      const chip = computeChipDistribution(history, fv * 1e8 / px, {});
      if (!chip) return null;
      return {
        ...chip,
        currentPrice: Math.round(px * 100) / 100,
        dataDate: (history && history.length) ? history[history.length - 1].date : null,
        // 兼容旧字段名（已核实零下游消费）：仅保留可由新模块真实推导者，不伪造
        profitRatio: chip.benefitPct,
        chartData: null, peakPrice: null, minPrice: null, maxPrice: null,
      };
    } catch (e) {
      console.error('[DeepAnalysis] chipDistribution failed:', e.message);
      return null;
    }
  })();

  // Build dividend data with net profit for comparison (Section 22)
  // dividends[].dividend is in 元, netProfit is in 亿
  const dividendData = revenueCostData.map(rc => {
    const div = dividends.find(d => d.year === rc.year);
    const divYi = div ? toYi(div.dividend) : 0; // Convert to 亿
    return {
      year: rc.year,
      netProfit: rc.netProfit,
      dividend: divYi,
      dividendPerShare: div?.dividendPerShare || 0,
      dividendRate: rc.netProfit > 0 && divYi > 0 ? Math.round(divYi / rc.netProfit * 10000) / 100 : 0,
    };
  });

  // 分红派次明细（近5年每次分红，含公告未分配）——供前端「每次/每年」柱状图
  // 来源：东方财富分红方案 RPT_SHAREBONUS_DET（fetchDividends 返回的原始每次派息记录，
  // 含董事会预案/股东大会通过等尚未实施（公告未分配）的记录，progress 字段标记进度）。
  const recentYears = revenueCostData.map(rc => rc.year);
  let maxShares = 0;
  for (const d of (dividends || [])) { const s = parseFloat(d.totalShares) || 0; if (s > maxShares) maxShares = s; }
  const dividendPayouts = (dividends || [])
    .filter(d => d.year && recentYears.includes(d.year))
    .map(d => {
      const shares = parseFloat(d.totalShares) || maxShares;
      const amountYi = toYi((parseFloat(d.dividendPerShare) || 0) * shares); // 元→亿
      const plan = d.plan || '';
      const reportDate = d.reportDate || '';
      // 复用统一阶段判定（单一展示口径，规则一）：中报/年报由 REPORT_DATE 月份决定，特别股息由 plan 决定。
      const stage = classifyDividendStage(reportDate, plan);
      const isPending = !/实施|派发|派息/.test(d.progress || ''); // 公告未分配（董事会预案/股东大会通过等）
      const sortKey = `${d.year}-${stage === '中期' ? '1' : stage === '特别' ? '2' : '9'}-${d.exDate || ''}`;
      return {
        year: d.year,
        label: dividendLabel(d.year, stage),
        amountYi: Math.round(amountYi * 100) / 100,
        perShare: d.dividendPerShare || 0,
        progress: d.progress || '',
        isPending,
        sortKey,
      };
    })
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // 股息率趋势（近10年 + 均值±标准差参考线 + 行业对比）
  // 诚实原则：默认即为"未成功获取"状态，绝不用零值聚合伪装成功；
  // 仅在 analyzeDividendYield 真正返回成功结果时才覆盖。
  let dividendYieldData = { success: false, errorType: 'NOT_COMPUTED', error: '股息率分析未执行', reason: '股息率分析未执行', series: [], stats: null, latest: null, current: null, industry: null };
  try {
    const dy = await analyzeDividendYield(dividends, quote, symbol, name);
    if (dy && dy.success === false) {
      dividendYieldData = dy; // 函数已诚实声明失败（含 reason），原样透传
    } else {
      dividendYieldData = dy || dividendYieldData;
    }
    console.log(`[DeepAnalysis] Dividend yield: ${dividendYieldData.series ? dividendYieldData.series.length : 0} years, mean=${dividendYieldData.stats ? dividendYieldData.stats.mean : '-'}%, current=${dividendYieldData.current && dividendYieldData.current.yield != null ? dividendYieldData.current.yield : '-'}%`);
  } catch (e) {
    dividendYieldData = { success: false, errorType: 'YIELD_ANALYSIS_THREW', error: e.message, reason: '股息率分析执行异常：' + e.message, source: '东方财富分红明细 / 腾讯行情', series: [], stats: null, latest: null, current: null, industry: null, note: '股息率分析执行异常：' + e.message };
  }

  // Revenue vs market cap (Section 10, 11, 12)
  // 估值序列含当年(2026)当前 TTM 点（无年报营收），此处仅取有营收的年报口径年份，避免空值
  const marketCapData = valuation.valuationData
    .filter(v => v.revenue != null && v.revenue > 0)
    .map(v => ({
      year: v.year,
      revenue: v.revenue,
      netProfit: v.netProfit,
      netAssets: v.netAssets,
      marketCap: v.marketCap,
    }));

  // 研报 / 公告 / 最新财报解读：读取已存的 AI 联网总结缓存（由对应 /api/ai/* 按需生成），不在此处联网
  let aiResearch = null, aiAnnc = null, aiEarnings = null;
  try { aiResearch = readCache(symbol, '_research'); } catch {}
  try { aiAnnc = readCache(symbol, '_announcements'); } catch {}
  try { aiEarnings = readCache(symbol, '_earnings'); } catch {}
  // 20261023h：改用 readEarningsCache 并丢弃 stale（promptVersion 过期 = 报告期可能已更新）。
  // 前端 renderEarningsReport 在无 summary 时会自动触发一次「最新财报解读」重算，
  // 因此丢弃旧中报缓存后会自动按三季报重新解读（用户 2026-10-23 洲明科技 300232 报障）。
  try {
    const er = readEarningsCache(symbol);
    aiEarnings = (er && !er.stale) ? er : null;
  } catch {}

  // 细分产品/业务毛利率（营收占比 / 成本占比 / 毛利率）
  let productGrossMargin = null;
  try {
    productGrossMargin = buildProductGrossMargin(segmentData);
  } catch (e) { console.error('[DeepAnalysis] productGrossMargin failed:', e.message); }
  
  // 前十大股东 + 机构统计（用于饼图与机构持股说明）
  let topHolders = [];
  try { topHolders = await fetchTopShareholders(emCode); } catch (e) { console.error('Top shareholders failed:', e.message); }
  const shareholderStats = buildShareholderStats(topHolders, shareholders?.totalShares || 0);

  const sections = {
      // 行情三规则（当前价权威来源 + 时效 + 涨跌边际）；此前挂在 quote 对象上不会随响应返回
      quoteRules,
      // 财务三规则（报告期 + 90 天时效 + 同比增速边际）
      financeRules,
      // 估值结论
      conclusion,
      // 公司类型分类
      companyClassification: companyType,
      // 本地资料库文档列表
      localDocuments,
      // 筹码分布
      chipDistribution,
      // 保险公司专属分析
      insuranceAnalysis,
      // Section 4: Product revenue trend
      revenueCostData,
      // Section 6: Short-term financial risk
      shortTermRisk: balanceAnalysis?.shortTermRisk,
      // Section 7: Asset composition
      assetComposition: balanceAnalysis?.assetComposition,
      totalAssets: balanceAnalysis?.totalAssets,
      goodwill: balanceAnalysis?.goodwill,
      // Section 8: Liability composition
      liabilityComposition: balanceAnalysis?.liabilityComposition,
      totalLiabilities: balanceAnalysis?.totalLiabilities,
      netAssets: balanceAnalysis?.netAssets,
      // Section 9, 13: Cash flow
      cashFlowData,
      // Section 10, 11, 12: Market cap vs fundamentals
      marketCapData,
      // Section 14: Revenue vs cost
      // (already in revenueCostData)
      // Section 15: Gross margin trend
      grossMarginTrend: revenueCostData.map(d => ({ year: d.year, grossMargin: d.grossMargin, netMargin: d.netMargin })),
      // Section 15b: 近5年 ROE 与毛利率走势（含文字解读）
      roeMarginTrend: analyzeRoeMarginTrend(revenueCostData, quote),
      // Section 16: Revenue vs expenses
      expenseData: revenueCostData.map(d => ({
        year: d.year,
        revenue: d.revenue,
        saleExpense: d.saleExpense,
        manageExpense: d.manageExpense,
        researchExpense: d.researchExpense,
        ttm: d.ttm,
      })),
      // Section 17: Growth rates
      growth,
      // Section 18: Revenue vs accounts payable
      payableData: balanceAnalysis?.netAssetsTrend.map(d => ({
        year: d.year,
        revenue: revenueCostData.find(rc => rc.year === d.year)?.revenue || 0,
        accountsPayable: d.accountsPayable,
      })) || [],
      // Section 19, 20, 21: Valuation indicators
      valuation,
      // Section 22: Dividends
      dividendData,
      // Section 22c: 每次/每年分红金额柱状图（近5年派次明细）
      dividendPayouts,
      // Section 22b: Dividend yield trend (10y + stats + industry)
      dividendYieldData,
      // Section 23: DCF valuation
      dcf,
      // Section 25: Shareholders
      shareholders,
      topShareholders: topHolders,
      shareholderStats,
      // Net assets trend
      netAssetsTrend: balanceAnalysis?.netAssetsTrend,
      // ---- 新增小节（第4/25节）----
      segmentData,                                // 第4/5节：分产品 / 分地区主营构成
      productGrossMargin,                         // 第4节补充：细分产品/业务毛利率（营收占比·成本占比·毛利率）
      // ---- 第24/25节：研报与公告改为 AI 联网总结（缓存优先，结构化抓取已弃用）----
      researchReports: [],
      announcements: [],
      researchAI: aiResearch || null,
      announcementAI: aiAnnc || null,
      earningsReport: aiEarnings || null,
    };

  // 为各分析小节附加「结论 + 论证」
  augmentSections(sections, { balanceAnalysis, companyType, dividends, quote });

  // 重大财务变化 AI 归因与历史留存
  try {
    const changeAnalysis = await analyzeChangesForSymbol(symbol, name, sections);
    sections.changeAnalysis = changeAnalysis;
  } catch (e) {
    console.error('[DeepAnalysis] changeAnalysis failed:', e.message);
    sections.changeAnalysis = { hasChanges: false, analyses: [], error: e.message };
  }

  // 规则二·分析期数据锁定：把本次分析的完整数据冻结进 SQLite（可复现/审计），失败不影响主流程。
  const result = {
    symbol,
    name,
    market: info.market,
    exchange: info.exchange,
    companyType: isInsurance ? 'insurance' : 'product',
    companyClassification: companyType,
    localDocuments,
    auditOpinion,
    auditWarning,
    sections,
    timestamp: new Date().toISOString(),
  };

  try {
    db.saveSnapshot({
      symbol: normalizeSymbol(emCode),
      snapshotId: `${normalizeSymbol(emCode)}-${Date.now()}`,
      range: (history && history.range) || 'daily',
      payload: result,
    });
  } catch (e) { console.error('[DB] saveSnapshot failed:', e.message); }

  return result;
}

module.exports = { deepAnalysis };

~~~

---

## `lib\deep\research.js`  ·  500 行

~~~js
/**
 * lib/deep/research.js —— deepAnalysis 领域子模块：本地文档 / 主营构成 / 研报 / 公告抓取
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * _cninfoOrgCache（巨潮 orgId 内存缓存）本子模块唯一持有；
 * ANNO_CATEGORY_LABEL 本文件内未被引用，原样保留以维持源码一致性（设计差异点 D12 相关）。
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const docStore = require('../docStore');
const { UA, HEADERS, _stmtStage } = require('./shared');
const { localDate, localCompact, localDateFromTs } = require('../localDate');

/**
 * 获取某股票的本地资料库文档。
 * 严格按 stockCode 过滤，仅返回「该股票自己」上传的文档；
 * 若该公司没有任何本地文档，返回 null（调用方据此隐藏资料库区块）。
 * 该函数在每次请求时实时读取磁盘索引，因此总能反映最新上传/删除。
 * @param {string} stockCode 标准化后的数字代码（如 '601318'）
 */
function getLocalDocuments(stockCode) {
  try {
    const localDocs = docStore.listCompanyDocuments(stockCode);
    if (localDocs && localDocs.length > 0) {
      console.log(`[DeepAnalysis] Found ${localDocs.length} local documents for ${stockCode}`);
      return {
        count: localDocs.length,
        documents: localDocs.map(d => ({
          id: d.id,
          type: d.type,
          typeName: d.typeName,
          fileName: d.fileName,
          title: d.title,
          year: d.year,
          fileSize: d.fileSize,
          uploadedAt: d.uploadedAt,
        })),
        typeBreakdown: localDocs.reduce((acc, d) => {
          acc[d.type] = (acc[d.type] || 0) + 1;
          return acc;
        }, {}),
      };
    }
    console.log(`[DeepAnalysis] No local documents found for ${stockCode}, using online data only`);
  } catch (e) {
    console.log(`[DeepAnalysis] Local doc check failed: ${e.message}`);
  }
  return null;
}

// ---- 分产品 / 分地区 主营构成（近 10 年）----
// 数据源：东方财富 F10 主营构成 RPT_F10_FN_MAINOP（stocks；原 RPT_F10_FUND_INCOME 实为基金收支报表，对股票恒为空）
// 字段：ITEM_NAME(分部名) / MAINOP_TYPE(1行业 2产品/业务分部 3地区) / MAIN_BUSINESS_INCOME(收入·元)
//       MBI_RATIO(营收占比·小数) / MAIN_BUSINESS_COST(成本·元) / MBC_RATIO(成本占比·小数)
//       GROSS_RPOFIT_RATIO(毛利率·小数，注意东财字段名拼写为 RPOFIT) / REPORT_NAME(报告期名)
function _segPct(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return null;
  return Math.round(Number(v) * 10000) / 100; // 小数比例 → 百分数
}
async function fetchSegmentData(emCode) {
  const stockCode = emCode.replace(/^(SH|SZ|BJ)/, '');
  // 20260919e：东财该接口单页上限 500 条，个股常超过 500 条（新洋丰 count=709），
  // 原实现只取第 1 页 → 更早年份被静默丢弃（新洋丰 2001–2010 全丢、2010 年仅剩地区维度）。
  // 改为按 pageNumber 逐页抓全量，页数与 total 比对后自动停止。
  const PAGE_SIZE = 500;
  const MAX_PAGES = 8;
  const buildUrl = (page) => `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FN_MAINOP&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)&pageSize=${PAGE_SIZE}&pageNumber=${page}&sortColumns=REPORT_DATE&sortTypes=-1`;
  try {
    const list = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const resp = await axios.get(buildUrl(page), { headers: HEADERS, timeout: 10000 });
      const data = resp.data?.result?.data;
      if (!Array.isArray(data) || data.length === 0) break;
      list.push(...data);
      const total = Number(resp.data?.result?.count) || list.length;
      if (list.length >= total) break;
    }
    if (list.length === 0) return null;

    // MAINOP_TYPE 数值 → 中文维度（1=行业 2=产品/业务分部 3=地区）
    const TYPE_MAP = { '1': '行业', '2': '产品', '3': '地区' };

    // 第一阶段：按 (year, type) 收集所有记录，并记住该 (year,type) 下出现的最新报告期
    const temp = {};
    for (const r of list) {
      const year = (r.REPORT_DATE || '').slice(0, 4);
      if (!year) continue;
      const rawType = r.MAINOP_TYPE !== undefined ? String(r.MAINOP_TYPE) : '';
      const type = TYPE_MAP[rawType] || ('维度' + rawType);
      const name = r.ITEM_NAME || r.MAINOP_NAME || r.MAIN_BUSINESS_NAME || '';
      const income = parseFloat(r.MAIN_BUSINESS_INCOME) || parseFloat(r.MAINOP_INCOME) || 0;
      // 跳过「抵销 / 合并 / 其他」等负向或空项，避免污染产品细分与占比合计
      if (!name || income <= 0) continue;
      // 20260919e：「其中:xxx」是上一条的【子项明细】（如 其他(补充) 的其中项），不是独立分部。
      // 东财「主营构成」页面同样不把其中项作为独立行展示；若当作独立分部会污染占比分母
      // （新洋丰 2026中报 磷复肥占比 89.71% vs 东财 91.80%，主营收入合计 115.44 vs 112.85 亿）。
      if (/^其中\s*[:：]/.test(name)) continue;

      const cost = parseFloat(r.MAIN_BUSINESS_COST) || parseFloat(r.MAINOP_COST) || 0;
      let grossMargin = _segPct(r.GROSS_RPOFIT_RATIO ?? r.MAINOP_GROSS_PROFIT_RATIO);
      if (grossMargin == null && cost > 0 && income > 0) {
        grossMargin = Math.round((1 - cost / income) * 10000) / 100; // 兜底：差额法
      }
      const item = {
        name,
        income,                                                      // 元
        ratio: _segPct(r.MBI_RATIO ?? r.MAINOP_INCOME_RATIO),         // 营收占比 %
        incomeRatio: _segPct(r.MBI_RATIO ?? r.MAINOP_INCOME_RATIO),   // 营收占比 %
        cost,                                                        // 元
        costRatio: _segPct(r.MBC_RATIO ?? r.MAINOP_COST_RATIO),       // 营业成本占比 %
        grossMargin,                                                 // 毛利率 %
        reportName: r.REPORT_NAME || '',
        reportDate: (r.REPORT_DATE || '').slice(0, 10),
      };
      const yt = (temp[year] = temp[year] || {});
      const bucket = (yt[type] = yt[type] || { reportDate: '', items: [] });
      bucket.items.push(item);
      if (item.reportDate > bucket.reportDate) bucket.reportDate = item.reportDate;
    }

    // 第二阶段：每个 (year,type) 合并同名项。
    //   - byYear[year][type]：仅保留「最新报告期」（向后兼容，供毛利率/客户竞争等模块使用）；
    //   - allPeriods[year][type]：保留该年【全部报告期】（年报/中报/一季报/三季报），
    //     供分业务趋势做 TTM 滚动累计（需上一年同阶段部分报告还原剩余季度）。
    const byYear = {};
    const allPeriods = {};
    for (const year of Object.keys(temp)) {
      for (const type of Object.keys(temp[year])) {
        const bucket = temp[year][type];
        // 按报告期分组
        const byReport = {};
        for (const it of bucket.items) {
          (byReport[it.reportDate] = byReport[it.reportDate] || []).push(it);
        }
        const periodArr = [];
        for (const rd of Object.keys(byReport)) {
          const merged = new Map();
          for (const it of byReport[rd]) {
            const cur = merged.get(it.name) || {
              name: it.name, income: 0, cost: 0,
              gmWSum: 0, gmW: 0, ratio: null, reportName: it.reportName, reportDate: it.reportDate,
            };
            cur.income += it.income;
            cur.cost += it.cost;
            if (it.grossMargin != null && it.income > 0) { cur.gmWSum += it.grossMargin * it.income; cur.gmW += it.income; }
            if (cur.ratio == null) cur.ratio = it.ratio;
            merged.set(it.name, cur);
          }
          const totalCost = Array.from(merged.values()).reduce((s, c) => s + c.cost, 0);
          const items = Array.from(merged.values()).map(cur => ({
            name: cur.name,
            income: cur.income,
            cost: cur.cost,
            ratio: cur.ratio,
            incomeRatio: cur.ratio,
            costRatio: totalCost > 0 ? Math.round(cur.cost / totalCost * 10000) / 100 : null,
            grossMargin: cur.gmW > 0 ? Math.round(cur.gmWSum / cur.gmW * 100) / 100 : null,
            reportName: cur.reportName,
            reportDate: cur.reportDate,
          }));
          periodArr.push({
            reportName: items[0]?.reportName || '',
            reportDate: rd,
            stage: _stmtStage(items[0]?.reportName || ''),
            items,
          });
        }
        const latest = periodArr.filter(p => p.reportDate === bucket.reportDate);
        const latestItems = latest.length ? latest[0].items : (periodArr[periodArr.length - 1]?.items || []);
        (byYear[year] = byYear[year] || {})[type] = latestItems;
        (allPeriods[year] = allPeriods[year] || {})[type] = periodArr;
      }
    }
    const years = Object.keys(byYear).sort();
    if (years.length === 0) return null;
    return { years, byYear, allPeriods, raw: list.length };
  } catch (e) {
    console.error('[Segment] fetch failed:', e.message);
    return null;
  }
}

// ---- 细分产品/业务毛利率：取最新报告期「产品」维度，逐业务列示营收占比 / 成本占比 / 毛利率 ----
function buildProductGrossMargin(segmentData) {
  if (!segmentData || !segmentData.byYear || segmentData.years.length === 0) return null;

  // 1. 优先「产品」维度；个别公司仅披露「行业」时用行业维度兜底
  const allTypeKeys = new Set();
  Object.values(segmentData.byYear).forEach(y => Object.keys(y).forEach(t => allTypeKeys.add(t)));
  const typeKey = Array.from(allTypeKeys).find(t => t === '产品')
    || Array.from(allTypeKeys).find(t => t === '行业')
    || null;
  if (!typeKey) return null;

  // 2. 跨所有年份收集该维度的全部记录，找出最新完整报告期（精确到日），避免同一年中报+年报重复汇总
  let allItems = [];
  Object.values(segmentData.byYear).forEach(y => {
    if (y[typeKey]) allItems = allItems.concat(y[typeKey]);
  });
  if (allItems.length === 0) return null;

  // 3. 取最新报告期；同名业务汇总（收入/成本相加，毛利率按汇总后差额法重算）
  const maxDate = allItems.reduce((max, p) => (p.reportDate && p.reportDate > max ? p.reportDate : max), '');
  const latestItems = allItems.filter(p => p.reportDate === maxDate && (p.income || 0) > 0);
  if (latestItems.length === 0) return null;

  const merged = new Map();
  for (const p of latestItems) {
    const name = p.name || '其他';
    const cur = merged.get(name) || { income: 0, cost: 0, weightedGmSum: 0, weightedGmWeight: 0 };
    cur.income += (p.income || 0);
    cur.cost += (p.cost || 0);
    if (p.grossMargin != null && p.income > 0) {
      cur.weightedGmSum += p.grossMargin * p.income;
      cur.weightedGmWeight += p.income;
    }
    merged.set(name, cur);
  }

  const totalIncome = Array.from(merged.values()).reduce((s, p) => s + p.income, 0);
  const totalCost = Array.from(merged.values()).reduce((s, p) => s + p.cost, 0);

  const items = Array.from(merged.entries()).map(([name, p]) => {
    const incomeYi = Math.round(p.income / 1e8 * 100) / 100;
    const costYi = (p.cost > 0) ? Math.round(p.cost / 1e8 * 100) / 100 : null;
    // 汇总后毛利率：优先用差额法；若成本缺失则按原始毛利率收入加权平均
    let gm = null;
    if (p.cost > 0 && p.income > 0) {
      gm = Math.round((1 - p.cost / p.income) * 10000) / 100;
    } else if (p.weightedGmWeight > 0) {
      gm = Math.round(p.weightedGmSum / p.weightedGmWeight * 100) / 100;
    }
    return {
      name,
      incomeYi,
      incomeRatio: totalIncome > 0 ? Math.round(p.income / totalIncome * 10000) / 100 : null,
      costYi,
      costRatio: (totalCost > 0 && p.cost > 0) ? Math.round(p.cost / totalCost * 10000) / 100 : null,
      grossMargin: gm,
    };
  }).sort((a, b) => b.incomeYi - a.incomeYi);
  if (items.length === 0) return null;

  const totalIncomeYi = Math.round(items.reduce((s, p) => s + p.incomeYi, 0) * 100) / 100;
  const totalCostYi = Math.round(items.reduce((s, p) => s + (p.costYi || 0), 0) * 100) / 100;
  const sample = latestItems.find(p => p.reportName) || latestItems[0] || {};
  const period = sample.reportName || (sample.reportDate ? sample.reportDate.slice(0, 4) + '年' : '最新报告期');
  const reportDate = sample.reportDate || '';

  return {
    period,
    reportDate,
    dimension: typeKey,
    source: '东方财富 F10 主营构成（RPT_F10_FN_MAINOP）',
    items,
    totalIncomeYi,
    totalCostYi,
  };
}

// ---- 近一年券商研报（观点与估值）----
async function fetchResearchReports(stockCode) {
  const end = new Date();
  const begin = new Date();
  begin.setFullYear(begin.getFullYear() - 1);
  const fmt = d => localDate(d);
  const url = `https://reportapi.eastmoney.com/report/list?qType=0&pageSize=30&pageNo=1&code=${stockCode}&beginTime=${fmt(begin)}&endTime=${fmt(end)}&industryCode=*&rating=&ratingChange=`;
  try {
    const resp = await axios.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' }, timeout: 10000 });
    const list = resp.data?.data || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.slice(0, 30).map(r => ({
      title: r.title || '',
      org: r.orgSName || r.orgName || '',
      rating: r.emRatingName || r.rating || '',
      targetPrice: parseFloat(r.targetPrice) || 0,
      publishDate: (r.publishDate || '').slice(0, 10),
      predictEps: parseFloat(r.predictThisYearEps) || 0,
      predictPe: parseFloat(r.predictThisYearPe) || 0,
      infoCode: r.infoCode || '',
    }));
  } catch (e) {
    console.error('[Research] fetch failed:', e.message);
    return null;
  }
}

// ---- 近一年公告：巨潮资讯网（优先）+ 东方财富（兜底）----
// 分类：增持 / 减持 / 回购 / 高管变动 / 立案处罚 / 诉讼仲裁 / 其他
function classifyAnnouncement(title) {
  const t = title || '';
  if (/增持/.test(t)) return 'increase';
  if (/减持/.test(t)) return 'decrease';
  if (/回购/.test(t)) return 'buyback';
  if (/高管|董事|监事|独立董|辞职|聘任|任职|董事会秘书/.test(t)) return 'execChange';
  if (/立案|处罚|警示函|监管措施|行政处罚|被立案|公开谴责|通报批评/.test(t)) return 'csrcAction';
  if (/诉讼|仲裁|判决|裁定|起诉书/.test(t)) return 'litigation';
  return 'other';
}

const ANNO_CATEGORY_LABEL = {
  increase: '股东增持',
  decrease: '股东减持',
  buyback: '股份回购',
  execChange: '高管/董事变动',
  csrcAction: '立案/处罚/监管',
  litigation: '诉讼/仲裁',
  other: '其他公告',
};

// 从公告标题 + 正文文本中尽力提取关键字段（best-effort，找不到的字段不返回）
function parseAnnouncementFields(text, category) {
  const fields = {};
  if (!text) return fields;
  const t = text.replace(/\s+/g, '');
  // 增持价格上限：不超过 X 元/股
  let m = t.match(/不超过\s*([\d.]+)\s*元/);
  if (m) fields.priceCap = parseFloat(m[1]);
  // 已增持股数 / 金额
  m = t.match(/已增持[^，。；]*?([\d,]+)\s*股/);
  if (m) fields.increasedShares = m[1].replace(/,/g, '');
  m = t.match(/已增持[^，。；]*?([\d.]+)\s*万元/);
  if (m) fields.increasedAmountWan = parseFloat(m[1]);
  // 拟增持 / 剩余未增持金额
  m = t.match(/(?:拟增持|剩余|尚未增持|增持金额)[^，。；]*?([\d.]+)\s*万元/);
  if (m) fields.remainingAmountWan = parseFloat(m[1]);
  // 减持：已减持 / 剩余未减持 / 截止日
  m = t.match(/已减持[^，。；]*?([\d,]+)\s*股/);
  if (m) fields.decreasedShares = m[1].replace(/,/g, '');
  m = t.match(/剩余[^，。；]*?(?:未减持|拟减持)[^，。；]*?([\d,]+)\s*股/);
  if (m) fields.remainingDecreaseShares = m[1].replace(/,/g, '');
  m = t.match(/(?:截止|届满|到期)[日期:：]?\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})/);
  if (m) fields.deadline = m[1].replace(/[年月]/g, '-').replace(/\//g, '-');
  // 回购：均价 / 金额 / 完成度
  m = t.match(/回购均价[^，。；]*?([\d.]+)\s*元/);
  if (m) fields.buybackAvgPrice = parseFloat(m[1]);
  m = t.match(/回购(?:金额|资金)[^，。；]*?([\d.]+)\s*万元/);
  if (m) fields.buybackAmountWan = parseFloat(m[1]);
  m = t.match(/完成\s*([\d.]+)\s*%/);
  if (m) fields.buybackProgress = parseFloat(m[1]);
  return fields;
}

// 巨潮资讯网：代码 → orgId 映射（内存缓存 + 落盘缓存 data/cache/cninfo_org_cache.json，
// 避免每次公告查询都先搜一遍；topSearch 偶发 403/超时，带 1 次重试）
const _cninfoOrgCache = new Map();
const _cninfoOrgFile = path.join(__dirname, '..', '..', 'data', 'cache', 'cninfo_org_cache.json');
let _cninfoOrgDisk = null;

function _loadCninfoOrgDisk() {
  if (_cninfoOrgDisk) return _cninfoOrgDisk;
  try {
    _cninfoOrgDisk = JSON.parse(fs.readFileSync(_cninfoOrgFile, 'utf8'));
    if (!_cninfoOrgDisk || typeof _cninfoOrgDisk !== 'object') _cninfoOrgDisk = {};
  } catch (_) { _cninfoOrgDisk = {}; }
  // 启动后首次查询时把落盘缓存灌回内存，重启不再重复请求
  for (const [k, v] of Object.entries(_cninfoOrgDisk)) {
    if (typeof v === 'string' && v) _cninfoOrgCache.set(k, v);
  }
  return _cninfoOrgDisk;
}

function _saveCninfoOrgDisk(code, orgId) {
  try {
    const disk = _loadCninfoOrgDisk();
    disk[code] = orgId;
    fs.mkdirSync(path.dirname(_cninfoOrgFile), { recursive: true });
    fs.writeFileSync(_cninfoOrgFile, JSON.stringify(disk, null, 2), 'utf8');
  } catch (e) {
    console.error('[CNINFO orgId] 缓存落盘失败:', e.message);
  }
}

async function fetchCninfoOrgId(stockCode, retries = 1) {
  if (_cninfoOrgCache.has(stockCode)) return _cninfoOrgCache.get(stockCode);
  const disk = _loadCninfoOrgDisk();
  if (disk[stockCode]) {
    _cninfoOrgCache.set(stockCode, disk[stockCode]);
    return disk[stockCode];
  }
  const url = 'https://www.cninfo.com.cn/new/information/topSearch/query';
  const body = new URLSearchParams({ keyWord: stockCode, maxSecNum: '10', maxListNum: '5' }).toString();
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await axios.post(url, body, {
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.cninfo.com.cn/' },
        timeout: 8000,
      });
      const arr = Array.isArray(resp.data) ? resp.data : [];
      const hit = arr.find(x => x.code === stockCode) || null;
      const orgId = hit ? hit.orgId : null;
      if (orgId) {
        _cninfoOrgCache.set(stockCode, orgId);
        _saveCninfoOrgDisk(stockCode, orgId);
      }
      return orgId;
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 800));
    }
  }
  console.error('[CNINFO orgId] fetch failed:', lastErr && lastErr.message);
  return null;
}

// 巨潮资讯网：近一年公告列表（20260903g 重写：stock=code,orgId 精确过滤 + seDate 区间 +
// announcementTime 毫秒时间戳解析；旧参数 stockCode/startTime/endTime 会被忽略导致翻页泄漏其他公司数据）
async function fetchCninfoAnnouncements(stockCode, stockName) {
  const orgId = await fetchCninfoOrgId(stockCode);
  if (!orgId) return null;
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const isSH = /^6/.test(stockCode);
  const url = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
  const body = new URLSearchParams({
    pageNum: '1',
    pageSize: '60',
    column: isSH ? 'sse' : 'szse',
    tabName: 'fulltext',
    stock: `${stockCode},${orgId}`,
    plate: isSH ? 'sh' : 'sz',
    seDate: `${fmt(start)}~${fmt(end)}`,
    searchkey: '',
    secid: '',
    category: '',
    trade: '',
  }).toString();
  try {
    const resp = await axios.post(url, body, {
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Referer': 'https://www.cninfo.com.cn/', 'X-Requested-With': 'XMLHttpRequest' },
      timeout: 12000,
    });
    const list = resp.data?.announcements || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.map(a => {
      const title = a.announcementTitle || '';
      // announcementTime 为北京日期零点的毫秒时间戳，+8h 后取 UTC 日期即公告日
      const ts = Number(a.announcementTime);
      let date = ts > 0 ? localDateFromTs(ts) : '';
      if (!date) {
        const m = (a.adjunctUrl || '').match(/finalpage\/(\d{4}-\d{2}-\d{2})\//);
        if (m) date = m[1];
      }
      const category = classifyAnnouncement(title);
      const rawHtml = typeof a.adjHTML === 'string' ? a.adjHTML : '';
      const text = rawHtml.replace(/<[^>]+>/g, ' ').slice(0, 8000);
      const parsed = parseAnnouncementFields(title + '\n' + text, category);
      const id = a.announcementId || '';
      const link = id ? `https://www.cninfo.com.cn/new/disclosure/detail?announcementId=${encodeURIComponent(id)}&stockCode=${encodeURIComponent(stockCode)}&orgId=${encodeURIComponent(orgId)}` : (a.adjunctUrl ? `https://static.cninfo.com.cn/${a.adjunctUrl}` : '');
      return { title, date, category, parsed, url: link, source: '巨潮资讯网' };
    }).filter(a => a.title);
  } catch (e) {
    console.error('[CNINFO Announcements] fetch failed:', e.message);
    return null;
  }
}

// 东方财富兜底（仅标题列表，无全文解析）
// 20261015f：数据源统一——原走 /api/security/announcement 旧路径（cnscraperAdapter 20260922i
// 已实测确认失效：HTTP 200 空 body / 0 条，深析公告兜底形同虚设），现统一为全工作台唯一实测
// 可用的 /api/security/ann 路径（需带 ann_type=A&client_source=web&f_node=0&s_node=0）。
// 响应结构 data.list[]、字段 title/notice_date/art_code（实测确认；ei_time 驼峰为 eiTime），
// url 字段已不存在，改用 art_code 合成正文直链（与 newsSearch/cnscraperAdapter 同一格式）。
async function fetchAnnouncementsEastmoney(stockCode) {
  const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=60&page_index=1&ann_type=A&client_source=web&stock_list=${stockCode}&f_node=0&s_node=0`;
  try {
    const resp = await axios.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' }, timeout: 10000 });
    const list = resp.data?.data?.list || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    const end = new Date();
    const start = new Date(); start.setFullYear(start.getFullYear() - 1);
    return list.map(a => ({
      title: a.title || a.notice_title || a.title_ch || '',
      date: (a.notice_date || a.eiTime || a.datetime || '').slice(0, 10),
      category: classifyAnnouncement(a.title || a.notice_title || ''),
      parsed: {},
      url: a.art_code ? `https://np-cnotice.eastmoney.com/api/content/ann?art_code=${a.art_code}` : '',
      source: '东方财富',
    })).filter(a => a.title && a.date >= localDate(start));
  } catch (e) {
    console.error('[Announcements EM] fetch failed:', e.message);
    return null;
  }
}

// 统一入口：优先巨潮，失败/空则东方财富兜底；返回 { source, items } 或 null
async function fetchAnnouncements(stockCode, stockName) {
  const cn = await fetchCninfoAnnouncements(stockCode, stockName);
  if (cn && cn.length) return { source: '巨潮资讯网', items: cn };
  const em = await fetchAnnouncementsEastmoney(stockCode);
  if (em && em.length) return { source: '东方财富(兜底)', items: em };
  return null;
}

module.exports = { getLocalDocuments, fetchSegmentData, buildProductGrossMargin, fetchResearchReports, fetchAnnouncements };

~~~

---

## `lib\deep\shared.js`  ·  67 行

~~~js
/**
 * lib/deep/shared.js —— deepAnalysis 领域子模块：跨块复用的纯工具函数与常量（零依赖叶子）
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 注意：本模块的 _calcStats 与 statements.js 中 analyzeValuation 内部局部函数 calcStats
 * 是两个独立实现（历史并存），严禁合并（设计差异点 D5）。
 */

// 全工作台统一数字规范：价格保留两位小数，防止浮点尾数（如 32.879999999999995）泄漏到文案。
// 百分比统一用文件下方已有的 fmtPct（toFixed(1)+'%'，与距离等口径一致）。
function fmtPrice(v) {
  return (v != null && v !== '' && !isNaN(v) && isFinite(v)) ? Number(v).toFixed(2) : '--';
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://emweb.securities.eastmoney.com/',
  'Accept': 'application/json, text/plain, */*'
};
// ---- Analysis Functions ----

// Format number to Yi (亿)
function toYi(n) {
  if (!n || n === 0) return 0;
  return Math.round(n / 1e8 * 100) / 100;
}

// 通用统计：均值 / 总体标准差 / 均值±1σ（与 analyzeValuation.calcStats 一致）
function _calcStats(arr) {
  const valid = (arr || []).filter(v => v > 0);
  if (valid.length === 0) return { mean: 0, std: 0, high: 0, low: 0 };
  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length;
  const std = Math.sqrt(variance);
  return {
    mean: Math.round(mean * 100) / 100,
    std: Math.round(std * 100) / 100,
    high: Math.round((mean + std) * 100) / 100,
    low: Math.round((mean - std) * 100) / 100,
  };
}

// Compute revenue & cost trend (Section 4, 14)
// 报告期阶段判定（与保险模块一致）
function _stmtStage(reportName) {
  if (!reportName) return null;
  if (reportName.includes('年报')) return 'FY';
  if (reportName.includes('一季报')) return 'Q1';
  if (reportName.includes('中报')) return 'H1';
  if (reportName.includes('三季报')) return 'Q3';
  return null;
}
function fmtPct(n) {
  return (typeof n === 'number' && !isNaN(n)) ? n.toFixed(1) + '%' : '--';
}
// ---- 通用工具：给任意 Promise 加超时保护（不抛拒绝，返回 fallback）----
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise(res => setTimeout(() => res(fallback), ms)),
  ]);
}


module.exports = { fmtPrice, fmtPct, toYi, _calcStats, _stmtStage, UA, HEADERS, withTimeout };

~~~

---

## `lib\deep\statements.js`  ·  460 行

~~~js
/**
 * lib/deep/statements.js —— deepAnalysis 领域子模块：三表分析（营收成本/资产负债/现金流）+ 估值/成长/DCF
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 注意：analyzeValuation 内部局部函数 calcStats 与 shared._calcStats 是两个独立实现，严禁合并（设计差异点 D5）。
 */
const { toYi, _stmtStage } = require('./shared');

const _STAGE_ORDER = { Q1: 1, H1: 2, Q3: 3 };

// 按中国财报累计值口径，从利润表计算最新一期归母净利润 TTM
// 例如最新为 2025 三季报（1-9月累计），则 TTM = 2025Q3 + 2024FY - 2024Q3
function _calcTtmProfit(income) {
  if (!income || income.length === 0) return 0;
  const sorted = [...income].sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')));
  const latest = sorted[sorted.length - 1];
  const latestProfit = Number(latest.PARENT_NETPROFIT) || 0;
  const st = _stmtStage(latest.REPORT_DATE_NAME || '');
  if (!st || st === 'FY') return latestProfit;
  const latestYear = String(latest.REPORT_DATE || '').slice(0, 4);
  if (!latestYear) return latestProfit;
  const prevYear = String(Number(latestYear) - 1);
  const prevSame = sorted.find(r => String(r.REPORT_DATE || '').startsWith(prevYear) && _stmtStage(r.REPORT_DATE_NAME || '') === st);
  const prevFY = sorted.find(r => String(r.REPORT_DATE || '').startsWith(prevYear) && _stmtStage(r.REPORT_DATE_NAME || '') === 'FY');
  if (!prevSame || !prevFY) return latestProfit;
  return latestProfit + (Number(prevFY.PARENT_NETPROFIT) || 0) - (Number(prevSame.PARENT_NETPROFIT) || 0);
}

// 抽取单条利润表的流量指标（用于 TTM 还原），单位：亿元
function _stmtFlow(r) {
  return {
    revenue: toYi(r.TOTAL_OPERATE_INCOME),
    cost: toYi(r.TOTAL_OPERATE_COST),
    operatingCost: toYi(r.OPERATE_COST),
    netProfit: toYi(r.PARENT_NETPROFIT),
    operatingProfit: toYi(r.OPERATE_PROFIT),
    saleExpense: toYi(r.SALE_EXPENSE),
    manageExpense: toYi(r.MANAGE_EXPENSE),
    researchExpense: toYi(r.RESEARCH_EXPENSE),
    financeExpense: toYi(r.FINANCE_EXPENSE),
  };
}

// 单条利润表 → 营收成本趋势条目
function _mapRevenueCost(r, year, opts) {
  opts = opts || {};
  const f = _stmtFlow(r);
  const revenue = opts.revenue != null ? opts.revenue : f.revenue;
  const cost = opts.cost != null ? opts.cost : f.cost;
  const operatingCost = opts.operatingCost != null ? opts.operatingCost : f.operatingCost;
  const netProfit = opts.netProfit != null ? opts.netProfit : f.netProfit;
  const operatingProfit = opts.operatingProfit != null ? opts.operatingProfit : f.operatingProfit;
  const saleExpense = opts.saleExpense != null ? opts.saleExpense : f.saleExpense;
  const manageExpense = opts.manageExpense != null ? opts.manageExpense : f.manageExpense;
  const researchExpense = opts.researchExpense != null ? opts.researchExpense : f.researchExpense;
  const financeExpense = opts.financeExpense != null ? opts.financeExpense : f.financeExpense;
  const grossMargin = operatingCost > 0 && revenue > 0 ? Math.round((1 - operatingCost / revenue) * 10000) / 100 : 0;
  const netMargin = revenue > 0 ? Math.round((netProfit / revenue) * 10000) / 100 : 0;
  return {
    year,
    revenue, cost, operatingCost, netProfit, operatingProfit,
    grossMargin, netMargin,
    revenueYoy: opts.ttm ? null : (r.TOTAL_OPERATE_INCOME_YOY || 0),
    profitYoy: opts.ttm ? null : (r.PARENT_NETPROFIT_YOY || 0),
    saleExpense,
    manageExpense,
    researchExpense,
    financeExpense,
    eps: r.BASIC_EPS || 0,
    ttm: !!opts.ttm,
  };
}

// 营收与成本趋势：按年分组，优先采用「年报」；若某年（如 2026）尚未披露年报但有
// 最新一期报告（中报/一季报），则采用 TTM 滚动累计还原该年（当年部分 + 上年剩余季度）。
function analyzeRevenueCost(income) {
  if (!income || !income.length) return [];
  const byYear = {};
  for (const r of income) {
    const y = r.REPORT_DATE
      ? r.REPORT_DATE.slice(0, 4)
      : (r.REPORT_DATE_NAME ? r.REPORT_DATE_NAME.replace(/年报|一季报|中报|三季报/g, '') : '');
    if (!y) continue;
    const st = _stmtStage(r.REPORT_DATE_NAME || '');
    if (!byYear[y]) byYear[y] = { annual: null, partials: {} };
    if (st === 'FY') byYear[y].annual = r;
    else if (st) byYear[y].partials[st] = r;
  }
  const years = Object.keys(byYear).sort();
  const result = [];
  let prev = { fy: null, partials: {} };
  for (const y of years) {
    const g = byYear[y];
    let rec = null;
    if (g.annual) {
      rec = _mapRevenueCost(g.annual, y, {});
    } else {
      // 取最新一期非年报
      let bestStage = null, bestRec = null;
      for (const s of Object.keys(g.partials)) {
        if (!bestStage || _STAGE_ORDER[s] > _STAGE_ORDER[bestStage]) { bestStage = s; bestRec = g.partials[s]; }
      }
      if (bestRec && prev.fy && prev.partials[bestStage]) {
        const cur = _stmtFlow(bestRec);
        const pf = prev.fy, ps = prev.partials[bestStage];
        const ttm = {
          revenue: Math.round((cur.revenue + (pf.revenue - ps.revenue)) * 100) / 100,
          cost: Math.round((cur.cost + (pf.cost - ps.cost)) * 100) / 100,
          operatingCost: Math.round((cur.operatingCost + (pf.operatingCost - ps.operatingCost)) * 100) / 100,
          netProfit: Math.round((cur.netProfit + (pf.netProfit - ps.netProfit)) * 100) / 100,
          operatingProfit: Math.round((cur.operatingProfit + (pf.operatingProfit - ps.operatingProfit)) * 100) / 100,
          saleExpense: Math.round((cur.saleExpense + (pf.saleExpense - ps.saleExpense)) * 100) / 100,
          manageExpense: Math.round((cur.manageExpense + (pf.manageExpense - ps.manageExpense)) * 100) / 100,
          researchExpense: Math.round((cur.researchExpense + (pf.researchExpense - ps.researchExpense)) * 100) / 100,
          financeExpense: Math.round((cur.financeExpense + (pf.financeExpense - ps.financeExpense)) * 100) / 100,
        };
        rec = _mapRevenueCost(bestRec, y, { ...ttm, ttm: true });
      } else if (bestRec) {
        rec = _mapRevenueCost(bestRec, y, { ttm: true });
      }
    }
    if (rec) result.push(rec);
    const thisPartials = {};
    for (const s of Object.keys(g.partials)) thisPartials[s] = _stmtFlow(g.partials[s]);
    prev = { fy: g.annual ? _stmtFlow(g.annual) : prev.fy, partials: thisPartials };
  }
  return result;
}

// Compute balance sheet analysis (Section 6, 7, 8)
function analyzeBalanceSheet(balance) {
  if (balance.length === 0) return null;
  const latest = balance[balance.length - 1];
  
  // Short-term financial risk (Section 6)
  const shortTermRisk = {
    cash: toYi(latest.MONETARYFUNDS),
    shortTermInvestments: toYi(latest.TRADE_FINASSET_NOTFVTPL || latest.BUY_RESALE_FINASSET || 0),
    shortTermDebt: toYi(latest.SHORT_LOAN || 0),
    accountsPayable: toYi(latest.ACCOUNTS_PAYABLE || 0),
  };

  // Asset composition (Section 7)
  const assetItems = [
    { name: '货币资金', value: toYi(latest.MONETARYFUNDS) },
    { name: '存货', value: toYi(latest.INVENTORY) },
    { name: '固定资产', value: toYi(latest.FIXED_ASSET) },
    { name: '无形资产', value: toYi(latest.INTANGIBLE_ASSET) },
    { name: '应收账款', value: toYi(latest.ACCOUNTS_RECE) },
    { name: '预付款项', value: toYi(latest.PREPAYMENT) },
    { name: '其他流动资产', value: toYi(latest.OTHER_CURRENT_ASSET) },
    { name: '递延所得税资产', value: toYi(latest.DEFER_TAX_ASSET) },
    { name: '在建工程', value: toYi(latest.CIP) },
    { name: '商誉', value: toYi(latest.GOODWILL) },
    { name: '发放贷款及垫款', value: toYi(latest.LEND_FUND) },
    { name: '其他非流动金融资产', value: toYi(latest.OTHER_NONCURRENT_FINASSET) },
  ].filter(a => a.value > 0).sort((a, b) => b.value - a.value);

  // Liability composition (Section 8)
  const liabilityItems = [
    { name: '应付账款', value: toYi(latest.ACCOUNTS_PAYABLE) },
    { name: '合同负债', value: toYi(latest.CONTRACT_LIAB) },
    { name: '应交税费', value: toYi(latest.TAX_PAYABLE) },
    { name: '应付职工薪酬', value: toYi(latest.STAFF_SALARY_PAYABLE) },
    { name: '其他应付款', value: toYi(latest.TOTAL_OTHER_PAYABLE) },
    { name: '短期借款', value: toYi(latest.SHORT_LOAN) },
    { name: '租赁负债', value: toYi(latest.LEASE_LIAB) },
    { name: '其他流动负债', value: toYi(latest.OTHER_CURRENT_LIAB) },
    { name: '递延所得税负债', value: toYi(latest.DEFER_TAX_LIAB) },
    { name: '长期借款', value: toYi(latest.LONG_LOAN) },
    { name: '应付债券', value: toYi(latest.BOND_PAYABLE) },
    { name: '吸收存款及同业存放', value: toYi(latest.ACCEPT_DEPOSIT_INTERBANK) },
  ].filter(l => l.value > 0).sort((a, b) => b.value - a.value);

  // Multi-year net assets
  const netAssetsTrend = balance.map(r => ({
    year: r.REPORT_DATE_NAME?.replace('年报', '') || r.REPORT_DATE?.slice(0, 4),
    totalAssets: toYi(r.TOTAL_ASSETS),
    totalLiabilities: toYi(r.TOTAL_LIABILITIES),
    netAssets: toYi(r.TOTAL_PARENT_EQUITY),
    inventory: toYi(r.INVENTORY),
    accountsPayable: toYi(r.ACCOUNTS_PAYABLE),
  }));

  return {
    shortTermRisk,
    assetComposition: assetItems,
    liabilityComposition: liabilityItems,
    totalAssets: toYi(latest.TOTAL_ASSETS),
    totalLiabilities: toYi(latest.TOTAL_LIABILITIES),
    netAssets: toYi(latest.TOTAL_PARENT_EQUITY),
    goodwill: toYi(latest.GOODWILL),
    netAssetsTrend,
  };
}

// Compute cash flow analysis (Section 9, 13)
// 现金流量表：按年分组，优先采用年报；若当年仅有部分报告，则做 TTM 滚动累计还原。
function _cfFlow(r) {
  return {
    operatingCashFlow: toYi(r.NETCASH_OPERATE),
    cashFromSales: toYi(r.SALES_SERVICES),
    dividends: toYi(r.ASSIGN_DIVIDEND_PORFIT),
  };
}
function analyzeCashFlow(cashflow, income, rcData) {
  if (!cashflow || !cashflow.length) return [];
  // 从已 TTM 还原的 revenueCostData 按年份取 netProfit / revenue，保证与营收趋势口径一致
  const rcByYear = {};
  if (rcData && rcData.length) {
    for (const r of rcData) rcByYear[r.year] = r;
  }
  const byYear = {};
  for (const r of cashflow) {
    const y = r.REPORT_DATE ? r.REPORT_DATE.slice(0, 4) : (r.REPORT_DATE_NAME ? r.REPORT_DATE_NAME.replace(/年报|一季报|中报|三季报/g, '') : '');
    if (!y) continue;
    const st = _stmtStage(r.REPORT_DATE_NAME || '');
    if (!byYear[y]) byYear[y] = { annual: null, partials: {} };
    if (st === 'FY') byYear[y].annual = r;
    else if (st) byYear[y].partials[st] = r;
  }
  const years = Object.keys(byYear).sort();
  const result = [];
  let prev = { fy: null, partials: {} };
  for (const y of years) {
    const g = byYear[y];
    let rec = null;
    if (g.annual) {
      const cf = _cfFlow(g.annual);
      const rc = rcByYear[y] || {};
      rec = { year: y, ...cf, netProfit: rc.netProfit != null ? rc.netProfit : toYi(g.annual.PARENT_NETPROFIT), revenue: rc.revenue != null ? rc.revenue : toYi(g.annual.TOTAL_OPERATE_INCOME), ttm: false };
    } else {
      let bestStage = null, bestRec = null;
      for (const s of Object.keys(g.partials)) {
        if (!bestStage || _STAGE_ORDER[s] > _STAGE_ORDER[bestStage]) { bestStage = s; bestRec = g.partials[s]; }
      }
      if (bestRec && prev.fy && prev.partials[bestStage]) {
        const cur = _cfFlow(bestRec);
        const pf = prev.fy, ps = prev.partials[bestStage];
        const ttm = {
          operatingCashFlow: Math.round((cur.operatingCashFlow + (pf.operatingCashFlow - ps.operatingCashFlow)) * 100) / 100,
          cashFromSales: Math.round((cur.cashFromSales + (pf.cashFromSales - ps.cashFromSales)) * 100) / 100,
          dividends: Math.round((cur.dividends + (pf.dividends - ps.dividends)) * 100) / 100,
        };
        const rc = rcByYear[y] || {};
        rec = { year: y, ...ttm, netProfit: rc.netProfit != null ? rc.netProfit : toYi(bestRec.PARENT_NETPROFIT), revenue: rc.revenue != null ? rc.revenue : toYi(bestRec.TOTAL_OPERATE_INCOME), ttm: true };
      } else if (bestRec) {
        const cur = _cfFlow(bestRec);
        const rc = rcByYear[y] || {};
        rec = { year: y, ...cur, netProfit: rc.netProfit != null ? rc.netProfit : toYi(bestRec.PARENT_NETPROFIT), revenue: rc.revenue != null ? rc.revenue : toYi(bestRec.TOTAL_OPERATE_INCOME), ttm: true };
      }
    }
    if (rec) result.push(rec);
    const thisPartials = {};
    for (const s of Object.keys(g.partials)) thisPartials[s] = _cfFlow(g.partials[s]);
    prev = { fy: g.annual ? _cfFlow(g.annual) : prev.fy, partials: thisPartials };
  }
  return result;
}

// Compute valuation indicators (PE/PB/PS) over time (Section 19, 20, 21)
function analyzeValuation(financialData, quote, shareholders, emValuation) {
  const { income, balance } = financialData;
  // Try multiple sources for total shares
  const latestBalance = balance[balance.length - 1];
  const totalShares = shareholders?.totalShares || latestBalance?.SHARE_CAPITAL || quote?.fundamentals?.totalShares || quote?.totalShares || 0;
  const currentPrice = quote?.price || 0;
  
  // Build yearly valuation data（仅使用年报，避免部分报告期半年口径导致 PE/PB/PS 突兀跳变）
  let valuationData = [];
  for (const inc of income) {
    const st = _stmtStage(inc.REPORT_DATE_NAME || '');
    if (st && st !== 'FY') continue; // 跳过一季报/中报/三季报
    const year = inc.REPORT_DATE_NAME?.replace('年报', '') || inc.REPORT_DATE?.slice(0, 4);
    const bs = balance.find(b => b.REPORT_DATE === inc.REPORT_DATE);
    const netProfit = inc.PARENT_NETPROFIT || 0;
    const netAssets = bs?.TOTAL_PARENT_EQUITY || 0;
    const revenue = inc.TOTAL_OPERATE_INCOME || 0;
    const yearShares = bs?.SHARE_CAPITAL || totalShares;

    // Market cap = shares × current price (approximation)
    const marketCap = yearShares > 0 ? toYi(yearShares * currentPrice) : 0;

    const pe = netProfit > 0 && marketCap > 0 ? Math.round(marketCap / toYi(netProfit) * 100) / 100 : 0;
    const pb = netAssets > 0 && marketCap > 0 ? Math.round(marketCap / toYi(netAssets) * 100) / 100 : 0;
    const ps = revenue > 0 && marketCap > 0 ? Math.round(marketCap / toYi(revenue) * 100) / 100 : 0;

    valuationData.push({ year, pe, pb, ps, marketCap, netProfit: toYi(netProfit), netAssets: toYi(netAssets), revenue: toYi(revenue) });
  }

  // 优先采用东方财富 TTM 估值历史：用真实 TTM 口径替换历史 PE/PB/PS，并补充当年(2026)当前点
  // （原年报口径用「当年股份×当前价」算市值，历史 PE 失真；东财 TTM 为各年末真实市场估值）
  if (emValuation && Array.isArray(emValuation.series) && emValuation.series.length) {
    const baseByYear = {};
    for (const inc of income) {
      const st = _stmtStage(inc.REPORT_DATE_NAME || '');
      if (st && st !== 'FY') continue;
      const y = inc.REPORT_DATE_NAME?.replace('年报', '') || inc.REPORT_DATE?.slice(0, 4);
      baseByYear[y] = inc;
    }
    const balByReport = {};
    for (const b of (balance || [])) balByReport[b.REPORT_DATE] = b;

    // 为缺失年报数据的年份（尤其是当年当前点）回退到最近可用年报，
    // 保证 generateConclusion 计算每股指标时 eps/bvps/sps 不为 0。
    const yearsWithInc = Object.keys(baseByYear).sort();

    valuationData = emValuation.series.map((s) => {
      const y = s.year;
      let inc = baseByYear[y];
      let bs = inc ? balByReport[inc.REPORT_DATE] : null;
      if (!inc && yearsWithInc.length) {
        // 仅在「存在不晚于当前年的年报」时回退，避免把最新年份的财务数据错配到更早年份
        // （原逻辑 fallback 到 yearsWithInc 末位=最新年，会把 2025 财务数据复制到 2018-2021，造成图表年份错乱）
        const fallbackYear = yearsWithInc.filter(yy => yy <= y).pop();
        if (fallbackYear) {
          inc = baseByYear[fallbackYear];
          bs = inc ? balByReport[inc.REPORT_DATE] : null;
        }
        // 若 emValuation 的年份早于我们所有年报（如 2018-2020 不在 5 年回溯窗口内），
        // 则 inc 保持 null，netProfit/netAssets/revenue 为 null，后续 marketCapData 会按 revenue>0 过滤剔除，不展示错误数据。
      }
      const yearShares = bs?.SHARE_CAPITAL || totalShares;
      return {
        year: y,
        pe: s.pe, pb: s.pb, ps: s.ps,
        marketCap: s.marketCap != null ? s.marketCap : toYi(yearShares * currentPrice),
        netProfit: inc ? toYi(inc.PARENT_NETPROFIT) : null,
        netAssets: bs ? toYi(bs.TOTAL_PARENT_EQUITY) : null,
        revenue: inc ? toYi(inc.TOTAL_OPERATE_INCOME) : null,
        isCurrent: !!s.isCurrent,
        date: s.date,
      };
    });
  }

  // Calculate mean and std for each indicator
  function calcStats(arr) {
    const valid = arr.filter(v => v > 0);
    if (valid.length === 0) return { mean: 0, std: 0, high: 0, low: 0 };
    const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
    const variance = valid.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / valid.length;
    const std = Math.sqrt(variance);
    return { 
      mean: Math.round(mean * 100) / 100, 
      std: Math.round(std * 100) / 100, 
      high: Math.round((mean + std) * 100) / 100, 
      low: Math.round((mean - std) * 100) / 100 
    };
  }

  const peStats = calcStats(valuationData.map(v => v.pe));
  const pbStats = calcStats(valuationData.map(v => v.pb));
  const psStats = calcStats(valuationData.map(v => v.ps));

  // 当前 PE(TTM)：优先行情接口（腾讯/东财均为滚动 TTM 口径），
  // 用利润表最新一期做 TTM 滚动累计还原归母净利润，做交叉验证/兜底，
  // 避免估值分析停留在最近一个年报的静态 PE。
  const quotePe = (quote?.fundamentals?.pe > 0 ? quote.fundamentals.pe
    : (quote?.pe > 0 ? quote.pe : 0));
  const ttmNetProfitRaw = _calcTtmProfit(income);
  const ttmNetProfit = toYi(ttmNetProfitRaw);
  const ttmMarketCapYi = totalShares > 0 && currentPrice > 0 ? toYi(totalShares * currentPrice) : 0;
  const ttmPeComputed = ttmNetProfit > 0 && ttmMarketCapYi > 0
    ? Math.round(ttmMarketCapYi / ttmNetProfit * 100) / 100 : 0;

  let currentPeTtm = 0, peSource = '';
  if (quotePe > 0) {
    currentPeTtm = Math.round(quotePe * 100) / 100;
    peSource = quote?.fundamentals?.peSource || '行情数据(TTM)';
  } else if (ttmPeComputed > 0) {
    currentPeTtm = ttmPeComputed;
    peSource = '利润表TTM累计还原（行情PE缺失）';
  }
  // 东方财富 TTM 为估值分析主口径：当前 PE(TTM) 以其实时值覆盖，保证与序列末点一致
  if (emValuation && emValuation.latest && emValuation.latest.pe > 0) {
    currentPeTtm = Math.round(emValuation.latest.pe * 100) / 100;
    peSource = emValuation.source || '东方财富TTM';
  }

  return { valuationData, peStats, pbStats, psStats, currentPeTtm, peSource, ttmNetProfit, ttmMarketCap: ttmMarketCapYi };
}

// Compute growth rates from base year (Section 17)
function analyzeGrowth(revenueCostData) {
  if (revenueCostData.length < 2) return null;
  
  // Find 2020 as base year, or use earliest available
  const baseYear = revenueCostData.find(d => d.year === '2020') || revenueCostData[0];
  const latest = revenueCostData[revenueCostData.length - 1];
  
  const baseRevenue = baseYear.revenue || 1;
  const baseProfit = baseYear.netProfit || 1;
  
  return {
    baseYear: baseYear.year,
    latestYear: latest.year,
    revenueGrowth: baseRevenue > 0 ? Math.round((latest.revenue / baseRevenue - 1) * 10000) / 100 : 0,
    profitGrowth: baseProfit > 0 ? Math.round((latest.netProfit / baseProfit - 1) * 10000) / 100 : 0,
  };
}

// DCF Valuation (Section 23)
function calculateDCF(financialData, balance, quote, shareholders) {
  const { income, cashflow } = financialData;
  if (income.length === 0) return null;
  
  const discountRate = 0.08;
  const perpetualGrowth = 0.03;
  
  // Use average of recent 3 years FCF as base
  const recentFCF = cashflow.slice(-3).map(cf => cf.NETCASH_OPERATE || 0);
  const avgFCF = recentFCF.length > 0 ? recentFCF.reduce((s, v) => s + v, 0) / recentFCF.length : 0;
  
  if (avgFCF <= 0) return { error: '自由现金流为负，不适合DCF估值' };
  
  // Simple DCF: 10-year explicit + terminal value
  const projectedGrowth = 0.05; // Assume 5% growth for next 10 years
  let pvSum = 0;
  for (let i = 1; i <= 10; i++) {
    const fcf = avgFCF * Math.pow(1 + projectedGrowth, i);
    const pv = fcf / Math.pow(1 + discountRate, i);
    pvSum += pv;
  }
  
  // Terminal value
  const terminalFCF = avgFCF * Math.pow(1 + projectedGrowth, 10) * (1 + perpetualGrowth);
  const terminalValue = terminalFCF / (discountRate - perpetualGrowth);
  const terminalPV = terminalValue / Math.pow(1 + discountRate, 10);
  
  // Enterprise value
  const ev = pvSum + terminalPV;
  
  // Add cash, subtract debt
  const latestBalance = balance[balance.length - 1];
  const cash = latestBalance?.MONETARYFUNDS || 0;
  const shortTermDebt = latestBalance?.SHORT_LOAN || 0;
  const longTermDebt = latestBalance?.LONG_LOAN || 0;
  
  const equityValue = ev + cash - shortTermDebt - longTermDebt;
  const totalShares = shareholders?.totalShares || latestBalance?.SHARE_CAPITAL || quote?.fundamentals?.totalShares || 0;
  const perShareValue = totalShares > 0 ? equityValue / totalShares : 0;
  
  return {
    baseFCF: toYi(avgFCF),
    projectedGrowth: projectedGrowth * 100,
    discountRate: discountRate * 100,
    perpetualGrowth: perpetualGrowth * 100,
    enterpriseValue: toYi(ev),
    equityValue: toYi(equityValue),
    perShareValue: Math.round(perShareValue * 100) / 100,
    currentPrice: quote?.price || 0,
    // premium 定义为「相对内在价值的溢价率」= 股价/每股内在价值 - 1；
    // 正数 = 股价高于内在价值（高估），负数 = 股价低于内在价值（低估）。
    premium: perShareValue > 0 && quote?.price > 0 ? Math.round((quote.price / perShareValue - 1) * 10000) / 100 : 0,
  };
}

module.exports = { analyzeRevenueCost, analyzeBalanceSheet, analyzeCashFlow, analyzeValuation, analyzeGrowth, calculateDCF };

~~~

---

## `lib\deep\yield.js`  ·  234 行

~~~js
/**
 * lib/deep/yield.js —— deepAnalysis 领域子模块：股息率趋势（近10年序列 + 均值±σ统计 + 保险同业对比）
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * 统一算法：历史年度股息率 = 全年分红金额(公司公告, 元) ÷ 年报发布日公司市值(年报发布日收盘价×当年总股本)。
 */
const { getKlineJson } = require('../tklineHost');  // 20261021g：腾讯K线主机族降级
const axios = require('axios');
const { getQuote, detectMarket } = require('../stockData');
const { isInsuranceCompany } = require('../insuranceAnalysis');
const { UA, _calcStats } = require('./shared');
const { fetchDividends, aggregateAnnualDPS } = require('./dividends');

// ---- Dividend Yield Analysis (Section: 股息率趋势) ----
// 取原始不复权日线（bfq）：返回 [{date, close}]。腾讯该接口单笔最多约 2000 根，
// 超过会被截断/返回空，故用 end 参数把窗口向前平移以拼接更早的数据。
// 腾讯 K 线 param 格式：CODE,period,start,end,count,adj（start/end 缺省留空）
async function fetchBfqBars(tencentCode, count, endDate) {
  const endParam = endDate || '';
  try {
    const body = await getKlineJson(`/appstock/app/fqkline/get?param=${tencentCode},day,,,${count},bfq`, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeout: 12000,
    });
    const node = body?.data?.[tencentCode];
    const dayData = node?.day || [];
    if (!Array.isArray(dayData) || dayData.length === 0) return [];
    return dayData.map(d => ({ date: d[0], close: parseFloat(d[2]) })).filter(b => b.close > 0);
  } catch (e) {
    console.error('[DeepAnalysis] fetchBfqBars failed:', e.message);
    return [];
  }
}

// 取某股票近 N 年「全部不复权日线」并排序返回 [{date, close}]（供「年报发布日收盘价」与「年末收盘价」两种口径共用）
async function fetchAllBfqBars(tencentCode, years = 11) {
  try {
    const all = await fetchBfqBars(tencentCode, 2000, null);
    if (all.length === 0) return [];
    const seen = new Set();
    const uniq = [];
    for (const b of all) { if (!seen.has(b.date)) { seen.add(b.date); uniq.push(b); } }
    uniq.sort((a, b) => a.date.localeCompare(b.date));
    return uniq;
  } catch (e) {
    console.error('[DeepAnalysis] fetchAllBfqBars failed:', e.message);
    return [];
  }
}

// 取不晚于 dateStr 的最近一根日线收盘价（发布日若恰为非交易日，取前一交易日）
function closeOnOrBefore(bars, dateStr) {
  if (!bars || bars.length === 0) return 0;
  let best = null;
  for (const b of bars) { if (b.date <= dateStr) best = b; else break; }
  return best ? best.close : bars[0].close;
}

// 取某自然年最后一根日线收盘价（年末收盘价，兜底口径）
function yearEndCloseFromBars(bars, y) {
  if (!bars || bars.length === 0) return 0;
  let best = null;
  for (const b of bars) { if (b.date.startsWith(y)) best = b; }
  return best ? best.close : 0;
}

// 取各年报的「发布日」(NOTICE_DATE)：东方财富业绩报表 RPT_LICO_FN_CPD，年报(REPORTDATE 以 -12-31 结尾)
async function fetchReportPublishDates(code) {
  const stockCode = String(code || '').replace(/^(SH|SZ)/i, '').toUpperCase();
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?pageSize=80&pageNumber=1&reportName=RPT_LICO_FN_CPD&columns=SECURITY_CODE,REPORTDATE,NOTICE_DATE&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
      timeout: 10000,
    });
    const arr = resp.data?.result?.data || [];
    const map = {};
    for (const d of arr) {
      const rd = d.REPORTDATE;
      if (!rd || rd.length < 10) continue;
      const y = rd.slice(0, 4);
      if (!rd.startsWith(y + '-12-31')) continue; // 仅取年报（报告期 12-31）
      const notice = (d.NOTICE_DATE || '').slice(0, 10);
      if (!notice) continue;
      map[y] = notice;
    }
    return map; // { '2024': '2025-03-20', ... }
  } catch (e) {
    console.error('[DeepAnalysis] fetchReportPublishDates failed:', e.message);
    return {};
  }
}

// 当前股息率（快照，TTM 口径）= 最近 12 个月实际除息的每股分红之和 ÷ 当前股价
// 比「最近一个完整年度分红」更稳健：当最新财年期末分红尚未实施时，不会漏算已实施的期初分红，避免低估。
function computeCurrentYield(dividends, price) {
  if (!price || price <= 0) return 0;
  const today = new Date();
  const oneYearAgo = new Date(today.getTime() - 365 * 24 * 3600 * 1000);
  let ttm = 0;
  for (const d of (dividends || [])) {
    if (!d.exDate) continue;
    const ex = new Date(d.exDate);
    if (isNaN(ex.getTime())) continue;
    if (ex >= oneYearAgo && ex <= today) ttm += parseFloat(d.dividendPerShare) || 0;
  }
  if (ttm <= 0) {
    // 兜底：最近一个完整年度累计分红
    const map = aggregateAnnualDPS(dividends);
    const curYear = today.getFullYear();
    const years = Object.keys(map).filter(y => map[y] > 0 && parseInt(y, 10) < curYear).sort();
    if (years.length) ttm = map[years[years.length - 1]];
  }
  if (ttm <= 0) return 0;
  return Math.round(ttm / price * 10000) / 100;
}

// 保险行业主要同业当前股息率对比（中国人寿/太保/新华/人保）
async function buildInsuranceIndustryYield(symbol, dividends, quote, companyCurrentYield) {
  const peers = [
    { code: 'SH601628', name: '中国人寿' },
    { code: 'SH601601', name: '中国太保' },
    { code: 'SH601336', name: '新华保险' },
    { code: 'SH601319', name: '中国人保' },
  ];
  const results = [{ code: symbol, name: (quote && quote.name) || '本公司', yield: companyCurrentYield, isSelf: true }];
  const fetchPeer = async (p) => {
    const [q, div] = await Promise.all([
      getQuote(p.code).catch(() => null),
      fetchDividends(p.code).catch(() => []),
    ]);
    if (!q || !q.price) return null;
    return { code: p.code, name: p.name || q.name, yield: computeCurrentYield(div, q.price), isSelf: false };
  };
  const settled = await Promise.allSettled(peers.map(fetchPeer));
  for (const s of settled) if (s.status === 'fulfilled' && s.value) results.push(s.value);
  const valid = results.filter(r => r.yield > 0);
  if (valid.length === 0) return null;
  const avg = Math.round(valid.reduce((a, r) => a + r.yield, 0) / valid.length * 100) / 100;
  const sorted = [...valid].sort((a, b) => b.yield - a.yield);
  const rank = sorted.findIndex(r => r.isSelf) + 1;
  return { name: '保险行业', avg, peers: sorted, companyRank: rank, total: valid.length };
}

// 主函数：构建 10 年股息率序列 + 统计量 + 行业对比
// 统一算法：历史年度股息率 = 全年分红金额(公司公告, 元) ÷ 年报发布日公司市值(年报发布日收盘价×当年总股本)
async function analyzeDividendYield(dividends, quote, symbol, name) {
  try {
    // 1. 全年分红金额(元)：按报告年份汇总 Σ(每股分红 × 总股本)；校准特别股息(股本=0)用当年最大股本兜底
    const amountByYear = {};
    const sharesByYear = {};
    for (const d of (dividends || [])) {
      if (!d.year) continue;
      const y = d.year;
      const dps = parseFloat(d.dividendPerShare) || 0;
      const shares = parseFloat(d.totalShares) || 0;
      if (shares > 0) sharesByYear[y] = Math.max(sharesByYear[y] || 0, shares);
      const usedShares = shares > 0 ? shares : (sharesByYear[y] || 0);
      amountByYear[y] = (amountByYear[y] || 0) + dps * usedShares;
    }

    // 2. 年报发布日（NOTICE_DATE）
    const publishDates = await fetchReportPublishDates(symbol);

    // 3. 不复权日线（取收盘价）
    const info = detectMarket(symbol);
    const bars = info && info.tencentCode ? await fetchAllBfqBars(info.tencentCode, 11) : [];

    const curYear = new Date().getFullYear();
    // 已完成年度：有分红金额、且报告年 < 当前年
    const years = Object.keys(amountByYear)
      .filter(y => amountByYear[y] > 0 && parseInt(y, 10) < curYear)
      .sort();
    const series = [];
    for (const y of years) {
      const sharesY = sharesByYear[y] || 0;
      const publishDate = publishDates[y];
      let close = 0, marketCap = 0, basis = 'notice';
      if (publishDate && sharesY > 0 && bars.length) {
        close = closeOnOrBefore(bars, publishDate);
        marketCap = close * sharesY;
      } else {
        // 兜底：无发布日时用年末收盘价（分母口径变化，note 中标注）
        close = yearEndCloseFromBars(bars, y);
        marketCap = close * sharesY;
        basis = 'yearend';
      }
      if (marketCap > 0) {
        series.push({
          year: y,
          yield: Math.round(amountByYear[y] / marketCap * 10000) / 100,
          dividendAmount: Math.round(amountByYear[y] / 1e8 * 100) / 100, // 亿元
          marketCap: Math.round(marketCap / 1e8 * 100) / 100,            // 亿元
          publishDate: publishDate || '',
          close: Math.round(close * 100) / 100,
          basis,
        });
      }
    }
    if (series.length === 0) {
      return { success: false, errorType: 'NO_DATA', error: '暂无可用的分红或价格数据', reason: '暂无可用的分红或价格数据', series: [], stats: null, latest: null, current: null, industry: null, note: '暂无可用的分红或价格数据' };
    }
    // 近10年：取最近的 10 个已完成年度
    const capped = series.slice(-10);
    const stats = _calcStats(capped.map(s => s.yield));
    const current = computeCurrentYield(dividends, quote && quote.price);
    // 当前市值(元)：当前价 × 最新股本
    const latestShares = (() => {
      const sorted = [...(dividends || [])].filter(d => parseFloat(d.totalShares) > 0)
        .sort((a, b) => String(a.exDate || '').localeCompare(String(b.exDate || '')));
      return sorted.length ? parseFloat(sorted[sorted.length - 1].totalShares) : 0;
    })();
    const currentMarketCap = (quote && quote.price && latestShares) ? quote.price * latestShares : 0;
    let industry = null;
    if (isInsuranceCompany(symbol, name, quote)) {
      industry = await buildInsuranceIndustryYield(symbol, dividends, quote, current);
    }
    const fallbackCount = capped.filter(s => s.basis === 'yearend').length;
    return {
      series: capped,
      stats,
      latest: capped[capped.length - 1],
      current: { yield: current, marketCap: Math.round(currentMarketCap / 1e8 * 100) / 100 },
      industry,
      note: `历史年度股息率统一算法：全年分红金额(公司公告, 元) ÷ 年报发布日公司市值(年报发布日不复权收盘价 × 当年总股本)。当前股息率 = 最近12个月实际除息分红(TTM) ÷ 当前公司市值。分红/股本源自东方财富分红明细并对中国平安 2018 特别股息做校准；年报发布日源自东方财富业绩报表(NOTICE_DATE)；收盘价源自腾讯行情(不复权)。${fallbackCount ? `其中 ${fallbackCount} 个年度缺发布日，已用年末收盘价兜底。` : ''}`,
    };
  } catch (e) {
    console.error('[DeepAnalysis] analyzeDividendYield failed:', e.message);
    return { success: false, errorType: 'YIELD_ANALYSIS_FAILED', error: e.message, reason: '股息率分析暂不可用：' + e.message, series: [], stats: null, latest: null, current: null, industry: null, note: '股息率分析暂不可用：' + e.message };
  }
}

module.exports = { analyzeDividendYield };

~~~

---

## `lib\deepAnalysis.js`  ·  22 行

~~~js
// lib/deepAnalysis.js —— 门面：仅 re-export，导出基线与拆分前逐键一致（13 键）
const pipeline   = require('./deep/pipeline');
const financials = require('./deep/financials');
const dividends  = require('./deep/dividends');
const research   = require('./deep/research');

module.exports = {
  deepAnalysis: pipeline.deepAnalysis,
  fetchFinancialData: financials.fetchFinancialData,
  getLocalDocuments: research.getLocalDocuments,
  fetchSegmentData: research.fetchSegmentData,
  fetchResearchReports: research.fetchResearchReports,
  fetchAnnouncements: research.fetchAnnouncements,
  fetchDividends: dividends.fetchDividends,
  persistDividends: dividends.persistDividends,
  loadDividendSeries: dividends.loadDividendSeries,
  classifyDividendStage: dividends.classifyDividendStage,
  dividendLabel: dividends.dividendLabel,
  normalizeSymbol: dividends.normalizeSymbol,
  persistValuationScalars: dividends.persistValuationScalars,
};

~~~

---

## `lib\docStore.js`  ·  273 行

~~~js
/**
 * Document Store Module
 * 本地文档存储系统 — 按公司存储年报、季报、公告等文件
 * 
 * 目录结构: data/companies/{stockCode}/{type}/{filename}
 * 元数据索引: data/index.json
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COMPANIES_DIR = path.join(DATA_DIR, 'companies');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

// 文档类型定义
// 20260821f：新增 semi（半年报）类型——「中期报告/半年度报告」与「年度报告」「季度报告」区分开，
// 保证判断引擎识别的财报事件（如"2026年中报发布"）与资料库分类口径一致。
const DOC_TYPES = {
  annual: { key: 'annual', label: '年报', icon: '📋' },
  semi: { key: 'semi', label: '半年报', icon: '📅' },
  quarterly: { key: 'quarterly', label: '季报', icon: '📅' },
  announcement: { key: 'announcement', label: '公告', icon: '📢' },
  research: { key: 'research', label: '研报', icon: '📊' },
  other: { key: 'other', label: '其他', icon: '📄' },
};

// 确保目录存在
function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(COMPANIES_DIR)) fs.mkdirSync(COMPANIES_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_FILE)) {
    fs.writeFileSync(INDEX_FILE, JSON.stringify({ documents: {}, companies: {} }, null, 2), 'utf8');
  }
}

// 读取索引
function readIndex() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch (e) {
    return { documents: {}, companies: {} };
  }
}

// 写入索引
function writeIndex(index) {
  ensureDirs();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

// 生成文档ID
function generateDocId() {
  return 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

/**
 * 添加文档
 * @param {Object} params - { stockCode, stockName, type, fileName, filePath, fileSize, year, quarter, title, description }
 * @returns {Object} 文档元数据
 */
function addDocument(params) {
  const index = readIndex();
  const docId = generateDocId();
  
  const doc = {
    id: docId,
    stockCode: params.stockCode,
    stockName: params.stockName || '',
    type: params.type || 'other',
    typeName: DOC_TYPES[params.type]?.label || '其他',
    fileName: params.fileName,
    fileSize: params.fileSize || 0,
    fileType: path.extname(params.fileName).toLowerCase(),
    year: params.year || '',
    quarter: params.quarter || '',
    title: params.title || params.fileName,
    description: params.description || '',
    uploadedAt: new Date().toISOString(),
    relativePath: params.relativePath || '',
  };

  // 存入索引
  index.documents[docId] = doc;

  // 更新公司索引
  if (!index.companies[params.stockCode]) {
    index.companies[params.stockCode] = {
      stockCode: params.stockCode,
      stockName: params.stockName || '',
      docCount: 0,
      types: {},
      lastUpdated: new Date().toISOString(),
    };
  }
  const company = index.companies[params.stockCode];
  company.stockName = params.stockName || company.stockName;
  company.docCount = (company.docCount || 0) + 1;
  if (!company.types[doc.type]) company.types[doc.type] = 0;
  company.types[doc.type]++;
  company.lastUpdated = new Date().toISOString();

  writeIndex(index);
  return doc;
}

/**
 * 获取公司的所有文档
 */
function listCompanyDocuments(stockCode) {
  const index = readIndex();
  const docs = Object.values(index.documents)
    .filter(d => d.stockCode === stockCode)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return docs;
}

/**
 * 获取公司统计信息
 */
function getCompanyInfo(stockCode) {
  const index = readIndex();
  const company = index.companies[stockCode];
  if (!company) return null;
  const docs = listCompanyDocuments(stockCode);
  return {
    ...company,
    documents: docs,
    typeBreakdown: Object.entries(company.types || {}).map(([type, count]) => ({
      type,
      typeName: DOC_TYPES[type]?.label || type,
      icon: DOC_TYPES[type]?.icon || '📄',
      count,
    })),
  };
}

/**
 * 列出所有有文档的公司
 */
function listAllCompanies() {
  const index = readIndex();
  return Object.values(index.companies || {})
    .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));
}

/**
 * 获取文档完整路径
 * 若文档记录带有 relativePath（外部存储，如 data/reports 下），优先按相对路径解析。
 */
function getDocumentPath(docId) {
  const index = readIndex();
  const doc = index.documents[docId];
  if (!doc) return null;
  const fullPath = doc.relativePath
    ? path.join(DATA_DIR, doc.relativePath)
    : path.join(COMPANIES_DIR, doc.stockCode, doc.type, doc.fileName);
  return { doc, fullPath };
}

/**
 * 按 relativePath 查找文档（用于避免重复登记已下载的文件）
 */
function findByRelativePath(relPath) {
  const index = readIndex();
  return Object.values(index.documents).find(d => d.relativePath === relPath) || null;
}

/**
 * 删除文档
 */
function deleteDocument(docId) {
  const index = readIndex();
  const doc = index.documents[docId];
  if (!doc) return { success: false, error: '文档不存在' };

  // 删除文件（外部存储文件同样删，但 data/reports 下的年报通常希望保留，这里仍按记录删除）
  const filePath = doc.relativePath
    ? path.join(DATA_DIR, doc.relativePath)
    : path.join(COMPANIES_DIR, doc.stockCode, doc.type, doc.fileName);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Delete file error:', e.message);
  }

  // 更新索引
  delete index.documents[docId];
  const company = index.companies[doc.stockCode];
  if (company) {
    company.docCount = Math.max(0, (company.docCount || 0) - 1);
    if (company.types[doc.type]) {
      company.types[doc.type] = Math.max(0, company.types[doc.type] - 1);
      if (company.types[doc.type] === 0) delete company.types[doc.type];
    }
    company.lastUpdated = new Date().toISOString();
    if (company.docCount === 0) {
      delete index.companies[doc.stockCode];
    }
  }

  writeIndex(index);
  return { success: true };
}

/**
 * 搜索文档
 */
function searchDocuments(query) {
  const index = readIndex();
  const q = query.toLowerCase().trim();
  if (!q) return [];
  
  return Object.values(index.documents).filter(d => {
    return (d.title || '').toLowerCase().includes(q) ||
           (d.fileName || '').toLowerCase().includes(q) ||
           (d.stockName || '').toLowerCase().includes(q) ||
           (d.stockCode || '').toLowerCase().includes(q) ||
           (d.description || '').toLowerCase().includes(q) ||
           (d.year || '').includes(q);
  }).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

/**
 * 获取存储路径
 */
function getStoragePath(stockCode, type) {
  const dir = path.join(COMPANIES_DIR, stockCode, type);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 获取存储统计
 */
function getStorageStats() {
  const index = readIndex();
  const docs = Object.values(index.documents);
  const totalSize = docs.reduce((sum, d) => sum + (d.fileSize || 0), 0);
  
  const typeStats = {};
  for (const [key, val] of Object.entries(DOC_TYPES)) {
    typeStats[key] = {
      label: val.label,
      icon: val.icon,
      count: docs.filter(d => d.type === key).length,
    };
  }
  
  return {
    totalDocuments: docs.length,
    totalCompanies: Object.keys(index.companies || {}).length,
    totalSize,
    totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
    typeStats,
  };
}

module.exports = {
  DOC_TYPES,
  ensureDirs,
  addDocument,
  listCompanyDocuments,
  getCompanyInfo,
  listAllCompanies,
  getDocumentPath,
  findByRelativePath,
  deleteDocument,
  searchDocuments,
  getStoragePath,
  getStorageStats,
};

~~~

---

## `lib\eastmoneyValuation.js`  ·  132 行

~~~js
/**
 * 东方财富 TTM 估值历史抓取
 * 使用 datacenter-web 的 RPT_VALUEANALYSIS_DET 接口，返回每日 TTM 估值
 * （PE_TTM / PB_MRQ / PS_TTM），用于估值分析改用真实 TTM 口径并补充当年(2026)数据空缺。
 */
const axios = require('axios');

const CACHE = new Map(); // secucode -> { ts, data }
const CACHE_TTL = 6 * 3600 * 1000; // 6 小时

function toSecucode(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (s.includes('.')) {
    const [code, exch] = s.split('.');
    const suffix = (exch || '').toLowerCase() === 'sh' ? 'SH' : 'SZ';
    return `${code}.${suffix}`;
  }
  const m = s.match(/^(sh|sz)?(\d{6})$/i);
  if (!m) return s;
  const code = m[2];
  const exch = m[1] ? m[1].toLowerCase() : (code.startsWith('6') ? 'sh' : 'sz');
  return `${code}.${exch === 'sh' ? 'SH' : 'SZ'}`;
}

function round2(v) {
  const n = Number(v);
  if (!isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * 抓取东方财富 TTM 估值历史
 * @param {string} symbol 形如 sh601318 / 601318 / 601318.SH
 * @returns {Promise<{series:Array,latest:Object,source:string}|null>}
 *   series: [{ year, date, pe, pb, ps, marketCap(亿元), close, isCurrent }]  按年份升序
 */
async function fetchValuationTTM(symbol) {
  const secucode = toSecucode(symbol);
  if (!secucode) return null;
  const cached = CACHE.get(secucode);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const cols = 'TRADE_DATE,PE_TTM,PB_MRQ,PS_TTM,CLOSE_PRICE,TOTAL_MARKET_CAP';
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=2000&pageNumber=1&reportName=RPT_VALUEANALYSIS_DET&columns=${cols}&filter=(SECUCODE=%22${secucode}%22)`;

  const r = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://data.eastmoney.com/' },
    timeout: 20000,
  });
  const rows = (r.data && r.data.result && r.data.result.data) || [];
  if (!rows.length) return null;

  // 降序返回：每个年份首条 = 该年最后交易日(年末)TTM 值；最新一条即为当前 TTM
  const byYear = {};
  let latest = null;
  for (const d of rows) {
    const date = String(d.TRADE_DATE || '').slice(0, 10);
    const y = date.slice(0, 4);
    if (!y) continue;
    if (!byYear[y]) byYear[y] = d; // 降序下首次出现 = 年末
    if (!latest) latest = d;
  }

  // 规则三（变化与边际分析）需要日频/期频序列：保留原始交易日序列（升序），
  // 仅追加字段、不改变既有 series/latest 结构，不影响现有消费方。
  const daily = rows
    .map(d => ({
      date: String(d.TRADE_DATE || '').slice(0, 10),
      pe: round2(d.PE_TTM),
      pb: round2(d.PB_MRQ),
      ps: round2(d.PS_TTM),
      close: d.CLOSE_PRICE != null ? Number(d.CLOSE_PRICE) : null,
      marketCap: round2((Number(d.TOTAL_MARKET_CAP) || 0) / 1e8),
    }))
    .filter(d => d.date && d.pe > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  // 20260911：全量日频序列（升序）——仅按「有效日期 + 市值>0」过滤，**不做 PE 正负过滤**。
  // 用途：供「个股市值走势」等只需市值/收盘价的消费方使用。亏损股（PE_TTM<0，如 688660 电气风电，
  // 该股自 2023-02-27 起 PE 转负）在 daily 中会被 pe>0 整段截断 → 市值线缺失；dailyAll 保留全量交易日修复。
  // daily 的语义与既有消费方（valuationHub 短期窗口按 PE 取数）保持不变，互不影响。
  const dailyAll = rows
    .map(d => ({
      date: String(d.TRADE_DATE || '').slice(0, 10),
      pe: round2(d.PE_TTM),
      pb: round2(d.PB_MRQ),
      ps: round2(d.PS_TTM),
      close: d.CLOSE_PRICE != null ? Number(d.CLOSE_PRICE) : null,
      marketCap: round2((Number(d.TOTAL_MARKET_CAP) || 0) / 1e8),
    }))
    .filter(d => d.date && d.marketCap > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const curYear = String(new Date().getFullYear());
  const series = Object.keys(byYear).sort().map((y) => {
    const d = byYear[y];
    return {
      year: y,
      date: String(d.TRADE_DATE || '').slice(0, 10),
      pe: round2(d.PE_TTM),
      pb: round2(d.PB_MRQ),
      ps: round2(d.PS_TTM),
      marketCap: round2((Number(d.TOTAL_MARKET_CAP) || 0) / 1e8),
      close: d.CLOSE_PRICE,
      isCurrent: y === curYear,
    };
  });

  if (!series.length) return null;

  const data = {
    series,
    daily,                                   // 规则三：日频序列（升序），用于变化率/边际计算
    dailyAll,                                // 20260911：全量日频序列（升序，不过滤 PE 正负），供个股市值走势等
    latest: {
      year: String(latest.TRADE_DATE || '').slice(0, 4),
      date: String(latest.TRADE_DATE || '').slice(0, 10),
      pe: round2(latest.PE_TTM),
      pb: round2(latest.PB_MRQ),
      ps: round2(latest.PS_TTM),
      marketCap: round2((Number(latest.TOTAL_MARKET_CAP) || 0) / 1e8),
    },
    source: '东方财富TTM',
    fetchedAt: new Date().toISOString(),      // 规则一②：获取时间（五要素之一）
  };
  CACHE.set(secucode, { ts: Date.now(), data });
  return data;
}

module.exports = { fetchValuationTTM };

~~~

---

## `lib\emDataCenter.js`  ·  124 行

~~~js
/**
 * 东方财富「数据中心」报表通用取数器（datacenter-web）
 * ============================================================
 * 为什么单独成模块：东财「行情推送族」（push2 / push2delay / push2his / 82.push2 / 16.push2）在本机被
 * 对端在 TLS 握手完成后**立刻重置**（HTTPS 与纯 HTTP(80) 一样，偶发成功 ≈1/15）；而东财「数据中心族」
 * （datacenter-web.eastmoney.com）**稳定可达**。凡 push2 取不到的日频/报表型数据，统一走这里取，
 * 保证口径仍属**东财**，不必退到同花顺等异源（避免破坏项目「数据一致性」铁律）。
 *
 * 本模块刻意**不依赖 lib/stockData.js、也不依赖 axios**：
 *   - 不依赖 stockData → 避免与调用方（stockData / sectorFundFlowEmDc）形成循环 require；
 *   - 不用 axios → Node 原生 https 天然忽略 HTTP_PROXY / HTTPS_PROXY 环境变量，避免被本机代理劫持。
 *
 * 接口：GET https://datacenter-web.eastmoney.com/api/data/v1/get
 *   ?reportName=<报表名>&columns=ALL&source=WEB&client=WEB
 *   [&filter=(列='值' 或 >='值')][&sortColumns=列&sortTypes=-1][&pageSize=N][&pageNumber=1]
 *
 * ⚠️ 失败形态：报表名写错时返回 **HTTP 200 但 `{"success":false,"message":"报表配置不存在,X","code":9501}`**
 *   → 必须显式抛错，否则会被上层误判成「没有数据」而静默失败。
 *
 * 已验证报表（2026-09-21 实测）：
 *   - RPT_INDUSTRY_FUNDFLOW  东财行业板块资金流（逐交易日一行，128 板块/日，单位=元）
 *       BOARD_CODE / BOARD_NAME / TRADE_DATE / CHANGE_RATE / NET_INFLOW /
 *       SUPERDEAL_NET / BIGDEAL_NET / MIDDEAL_NET / SMALLDEAL_NET（=散户小单）/ MAX_NETINFLOW_SEC
 *   - RPT_FUNDFLOW_BOARD     东财板块资金流（含成交额 AMOUNT，单位≈万元，覆盖概念板块）
 *   - RPT_VALUEINDUSTRY_DET  行业估值（lib/analysis.js 在用）
 *   - RPT_VALUEANALYSIS_DET  个股估值（lib/analysis.js 在用）
 *   - RPTA_WEB_RZRQ_GGMX     融资融券明细（lib/capitalFlow.js 在用）
 */
const https = require('https');

const HOST = 'datacenter-web.eastmoney.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://data.eastmoney.com/bkzj/hy.html';
const CALL_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 600;

const REPORTS = {
  INDUSTRY_FUNDFLOW: 'RPT_INDUSTRY_FUNDFLOW',
  FUNDFLOW_BOARD: 'RPT_FUNDFLOW_BOARD',
};

/** 日期平移（UTC 计算，规避本地时区导致串日）；入参/出参均为 'YYYY-MM-DD' */
function shiftDate(ymd, deltaDays) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + deltaDays * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** 单次报表请求（已 JSON 解析；HTTP 200 但 success=false 视为失败并抛错） */
function _request(path, retries) {
  return new Promise((resolve, reject) => {
    const attempt = (left) => {
      const req = https.request({
        host: HOST,
        path,
        method: 'GET',
        headers: { 'User-Agent': UA, Referer: REFERER, Accept: 'application/json, text/plain, */*' },
      }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(body); } catch (e) { j = null; }
          if (!j || j.success === false) {
            const msg = (j && j.message) || ('HTTP ' + res.statusCode + ' 响应不可解析: ' + body.slice(0, 120));
            if (left > 0) return setTimeout(() => attempt(left - 1), RETRY_DELAY_MS);
            return reject(new Error('东财数据中心接口失败: ' + msg));
          }
          resolve(j);
        });
      });
      req.on('error', (e) => {
        if (left > 0) return setTimeout(() => attempt(left - 1), RETRY_DELAY_MS);
        reject(new Error('东财数据中心不可达: ' + (e.code || e.message)));
      });
      req.setTimeout(CALL_TIMEOUT_MS, () => {
        req.destroy();
        if (left > 0) return setTimeout(() => attempt(left - 1), RETRY_DELAY_MS);
        reject(new Error('东财数据中心请求超时'));
      });
      req.end();
    };
    attempt(typeof retries === 'number' ? retries : DEFAULT_RETRIES);
  });
}

/**
 * 取一张报表的数据行。
 * @param {string} reportName 报表名（见 REPORTS）
 * @param {{filter?:string, sortColumns?:string, sortTypes?:number, pageSize?:number, pageNumber?:number, columns?:string, retries?:number}} [opts]
 * @returns {Promise<Array<object>>} 数据行数组（无数据时返回空数组）
 */
async function fetchReport(reportName, opts = {}) {
  if (!reportName) throw new Error('fetchReport: 缺少 reportName');
  const qs = [
    'reportName=' + encodeURIComponent(reportName),
    'columns=' + encodeURIComponent(opts.columns || 'ALL'),
    'source=WEB',
    'client=WEB',
  ];
  if (opts.filter) qs.push('filter=' + encodeURIComponent(opts.filter));
  if (opts.sortColumns) qs.push('sortColumns=' + encodeURIComponent(opts.sortColumns));
  if (opts.sortTypes != null) qs.push('sortTypes=' + encodeURIComponent(String(opts.sortTypes)));
  qs.push('pageSize=' + encodeURIComponent(String(opts.pageSize || 100)));
  qs.push('pageNumber=' + encodeURIComponent(String(opts.pageNumber || 1)));
  const j = await _request('/api/data/v1/get?' + qs.join('&'), opts.retries);
  const data = j && j.result && j.result.data;
  return Array.isArray(data) ? data : [];
}

/** 某张报表里的最新交易日（'YYYY-MM-DD'，以数据为准，不依赖本地日期/交易日历） */
async function latestTradeDate(reportName, dateColumn = 'TRADE_DATE', retries) {
  const rows = await fetchReport(reportName, {
    sortColumns: dateColumn, sortTypes: -1, pageSize: 1, pageNumber: 1, retries,
  });
  if (!rows.length) throw new Error('东财数据中心报表暂无数据: ' + reportName);
  return String(rows[0][dateColumn]).slice(0, 10);
}

module.exports = { REPORTS, fetchReport, latestTradeDate, shiftDate, HOST };

~~~

---

## `lib\etfFlow.js`  ·  1017 行

~~~js
/**
 * etfFlow.js — 宽基 ETF 申购赎回跟踪（20261022h 新建；20261026a：shareDate 改按采集日推 + 披露未跨日守卫，修跨日补采假 Δ=0）
 * =========================================================
 * 目的：把「宽基 ETF 的申购/赎回」变成可进情绪模型的资金流信号 —— 宽基 ETF 被净申购
 * = 增量资金通过一篮子股票入市（成分股被"买"）；被净赎回 = 一篮子股票被卖回市场。
 *
 * 【口径必须说清，否则会骗人】
 *   1. 交易所 PCF（申购赎回清单）只是「申赎一篮子要交什么」的**模板**，本身不含当日实际申赎量。
 *   2. 真正反映申赎的是**基金总份额的变化**（东财 f84，单位：份）。
 *      份额是"净"概念：Δ份额 = 当日申购 − 当日赎回。所以**分不出申购总量与赎回总量两个绝对数**。
 *   3. 本模块的做法：按日归集方向 —— Δ>0 的日计入「净申购」，Δ<0 的日计入「净赎回」，
 *      分别累计。这给出的是「净申购日累计 / 净赎回日累计」，不是「申购总量 / 赎回总量」，
 *      文案一律写明，不允许含糊成"申购了多少"。
 *   4. 逐股股数 = 篮数 × 该股每篮份数，其中 篮数 = Δ份额 ÷ 最小申赎单位。
 *      这是申赎带来的**理论**增减股数（基金实际会因现金替代/取整有偏差）。
 *
 * 【文件结构】
 *   data/etf-flow/<TRADING_DAY>.json   每日快照（份额 + 全篮成分），保留最近 N 天
 *   data/etf-flow/pcf-cache/<date>.json  当日 PCF 缓存（同一交易日重复运行不重复抓）
 *   data/etf-flow/ledger.json          累计台账（净申购/净赎回日累计），幂等：同日只累加一次
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { localCompact, localDateTime } = require('./localDate');
const { previousTradingDay } = require('./cnTradingCalendar');
// 快照日期是紧凑格式 20261023，而 previousTradingDay 只认 2026-10-23 → 统一归一后再回紧凑。
const _prevTd = (compact) => {
  const dashed = /^\d{8}$/.test(String(compact))
    ? `${String(compact).slice(0, 4)}-${String(compact).slice(4, 6)}-${String(compact).slice(6)}`
    : String(compact);
  return previousTradingDay(dashed).replace(/-/g, '');
};
// PCF 缓存键 = 中国自然日（YYYYMMDD）。用 UTC 日期会在早盘前段错位一天，
// 让「今天该抓的清单」被当成「昨天已抓过」而读到空缓存。

// 允许用环境变量覆盖存储目录（离线回归测试用；生产默认 data/etf-flow）
const DIR = process.env.SA_ETF_FLOW_DIR
  ? path.resolve(process.env.SA_ETF_FLOW_DIR)
  : path.join(__dirname, '..', 'data', 'etf-flow');
const PCF_DIR = path.join(DIR, 'pcf-cache');
const LEDGER = path.join(DIR, 'ledger.json');
// [20261103g] 最近一次成功因子兜底（用户指令：节假日只读取最后一次更新的数据，避免节假日/假后第一天取数报错）：
// _computeEtfFlow 每次产出有效因子（非 degraded）时落盘；实时取数失败/超时时回读并如实标注兜底日期。
const LAST_FACTOR_FILE = path.join(DIR, 'last-factor.json');
const KEEP_DAYS = 10;            // 快照保留天数（够算"上一交易日"即可）
const MAX_ETF = 40;              // 全量抓取上限，防请求过多（20+4+4+3+3 = 34，留余量）
const SHARE_BASE = 20e8;         // 净申赎额归一基准：20 亿元 ≈ score ±0.76
const FETCH_TIMEOUT = 20000;
const CONCURRENCY = 4;

const SSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Referer': 'https://www.sse.com.cn/disclosure/fund/etflist/',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
};
const EM_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Referer': 'https://quote.eastmoney.com/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
// 东财 push2 族镜像：本机 Node 的 TLS 指纹常被对端直接 reset（socket hang up），
// 只靠单主机单通道会全军覆没。策略同 lib/stockData.js：多镜像 × (Node https → 系统 curl)。
const EM_HOSTS = [
  'https://push2.eastmoney.com',
  'https://push2delay.eastmoney.com',
  'https://82.push2.eastmoney.com',
  'https://16.push2.eastmoney.com',
];
const EM_UT = 'fa5fd1943c7b386f172d6893dbfba10b';

// 宽基家族定义：名称关键词 + 期望成分数（成分数用于排除行业/策略/增强衍生品）
const GROUPS = [
  { key: 'csi300',   label: '沪深300',  kw: '沪深300',  comps: 300, cls: ['03'], max: 20 },
  { key: 'sse50',    label: '上证50',   kw: '上证50',   comps: 50,  cls: ['01', '03'], max: 4 },
  { key: 'csi500',   label: '中证500',  kw: '中证500',  comps: 500, cls: ['03'], max: 4 },
  { key: 'csi1000',  label: '中证1000', kw: '中证1000', comps: 1000, cls: ['03'], max: 3 },
  { key: 'star50',   label: '科创50',   kw: '科创板50', comps: 50,  cls: ['09'], max: 3 },   // 上交所全称是「上证科创板50成份」，写「科创50」匹配不到
];
// 名称里出现这些词 = 行业/策略/增强衍生品，不是纯宽基复制
const DERIV = /医药|红利|ESG|增强|价值|成长|低波|质量|动量|等权|非银|银行|消费|科技|信息|军工|有色|能源|地产|国企|央企|龙头|优选|量化|策略|REIT/i;

// ── [20261109a] 名单完整性「绝对基准」 ──
// 事故根因（20261028、20261106 两次）：上交所名单按 03/01/09 三个分类分别查询，任一分类
// 失败被静默吞成空数组 → 名单从 34 缩到 7；旧判据只比「成功 PCF 数 < 当次名单数」，
// 分子分母一起缩水 → partial=false → 残缺快照被标 settled:true，又被跨日重采守卫当成
// 「已定稿完整快照」保护起来，自愈通道被反锁。
// 故完整性必须锚定独立绝对基准：5 个宽基家族全覆盖 + 总数不低于理论上限的 80%。
const UNIVERSE_FULL_SIZE = GROUPS.reduce((s, g) => s + g.max, 0);   // 34
const UNIVERSE_MIN_RATIO = 0.8;
function universeIntegrity(universe) {
  const list = universe || [];
  const families = new Set(list.map(u => u.group));
  const missing = GROUPS.filter(g => !families.has(g.key)).map(g => g.label);
  const minSize = Math.floor(UNIVERSE_FULL_SIZE * UNIVERSE_MIN_RATIO);
  return {
    ok: missing.length === 0 && list.length >= minSize,
    size: list.length,
    minSize,
    families: families.size,
    expectedFamilies: GROUPS.length,
    missing,
  };
}

/**
 * 内部错误台账：所有 try/catch 都把原因记进来（而不是静默吞掉），
 * 由 getEtfFlow 汇总进 gaps 一并披露 —— 采集"部分失败"与"全部失败"必须能区分。
 */
const _errs = [];
function noteErr(where, e) {
  if (_errs.length >= 20) return;
  const msg = `${where}：${e && e.message ? e.message : e}`;
  if (_errs.indexOf(msg) < 0) _errs.push(msg);
}
function drainErrs() { return _errs.splice(0, _errs.length); }

function ensureDir(p) { try { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); } catch (e) { noteErr('创建目录 ' + p, e); } }
function readJson(p, dft) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dft; } }
function writeJson(p, v) {
  try {
    ensureDir(path.dirname(p));
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(v), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) { return false; }
}
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[￥,\s%]/g, '')); return Number.isFinite(n) ? n : null; };
const round = (x, n = 2) => { const p = Math.pow(10, n); return Math.round(x * p) / p; };

/**
 * 该交易日的份额变动是否已「定稿」。
 * 份额（f84）是盘中实时更新的，盘中读到的 Δ份额 只是半天进度。
 * 累计台账必须只吃定稿值，否则 10:00 那次采样的半天增量会被永久写进台账
 * （幂等闸门 lastDate===date 会把收盘后的真实值挡在外面）。
 * 定稿判据与 zoneValidity.finalizedBars 同口径：交易日 15:05 后；历史日期天然定稿。
 */
function sessionSettled(tradeDate) {
  if (!tradeDate) return false;
  const now = localDateTime();                 // 'YYYY-MM-DD HH:mm'
  const d = now.slice(0, 10).replace(/-/g, '');
  if (tradeDate < d) return true;
  if (tradeDate > d) return false;
  return now.slice(11, 16) >= '15:05';
}

function httpGet(url, headers, timeout = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        resolve(Buffer.concat(bufs).toString('utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}
/** 原样返回 Buffer（腾讯行情是 GBK，不能用 utf8 解读） */
function httpGetBuf(url, headers, timeout = FETCH_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        resolve(Buffer.concat(bufs));
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}
const getJson = async (u, h) => JSON.parse(await httpGet(u, h));

/**
 * 东财 push2 族请求：逐镜像尝试，每个镜像先走 Node https，被 reset 再交给系统 curl。
 * 任一条能拿到含 data 的 JSON 即返回，全部失败抛错（由调用方降级）。
 *
 * 熔断：本机对 push2 全族常常整体不可达（4 镜像 × 2 通道 × 超时 ≈ 90s），
 * 只要失败一次就进入 10 分钟静默期，避免每条降级路径都把请求拖成分钟级。
 * @param {string} apiPath 形如 '/api/qt/ulist.np/get?fltt=2&fields=...'
 */
let _emDownUntil = 0;
async function getJsonEm(apiPath) {
  if (Date.now() < _emDownUntil) throw new Error('东财通道处于静默期（近期全部镜像不可达）');
  let lastErr = null;
  for (const host of EM_HOSTS) {
    const url = host + apiPath + (apiPath.includes('?') ? '&' : '?') + `ut=${EM_UT}&invt=2`;
    try {
      const j = await getJson(url, EM_HEADERS);
      if (j && j.data) return j;
      lastErr = new Error('返回无 data');
    } catch (e) { lastErr = e; }
    // Node TLS 被重置时用系统 curl（schannel 指纹）二次尝试
    try {
      const out = await execFileAsync('curl', ['-s', '--max-time', '8', '-H', 'Referer: https://quote.eastmoney.com/', url],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      const j = JSON.parse(out.stdout);
      if (j && j.data) return j;
      lastErr = new Error('curl 返回无 data');
    } catch (e) { lastErr = e; }
  }
  _emDownUntil = Date.now() + 10 * 60 * 1000;
  throw lastErr || new Error('东财接口全部镜像不可达');
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __err: e.message, __item: items[k] }; }
    }
  }));
  return out;
}

// ── 上交所接口 ──
const Q = 'https://query.sse.com.cn/commonQuery.do';
const listUrl = (cls) => `${Q}?isPagination=true&pageHelp.pageSize=600&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1&sqlId=COMMON_SSE_PL_ETFGGSGSHQD_L&ETF_CLASS=${cls}&type=inParams&FUND_CODE=&KEY_WORDS=`;
const jbxxUrl = (code) => `${Q}?isPagination=false&FUNDID2=${code}&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C`;
const compUrl = (code) => `${Q}?isPagination=false&FUNDID2=${code}&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C`;

/** 选出宽基 ETF 名单（按家族、成分数、排除衍生词） */
async function selectUniverse() {
  const byCls = {};
  for (const cls of ['03', '01', '09']) {
    let rows = null, lastErr = null;
    // [20261109a] 名单分类查询失败不得静默吞掉：重试 1 次；两次都失败才记入内部错误台账，
    // 由 getEtfFlow 的 drainErrs() 并入 gaps 披露，故障必须可观测。
    for (let attempt = 0; attempt < 2 && !rows; attempt++) {
      try {
        const j = await getJson(listUrl(cls), SSE_HEADERS);
        const arr = ((j.pageHelp && j.pageHelp.data) || []).map(x => ({
          code: x.FUNDID2, name: x.ETF_FULLNAME || '', comp: x.FUND_COMP_NAME || '', cls,
        }));
        if (arr.length) rows = arr;
        else lastErr = new Error('返回空列表');
      } catch (e) { lastErr = e; }
    }
    if (!rows) noteErr(`上交所 ETF 名单分类 ${cls}（重试 2 次仍失败）`, lastErr || new Error('未知'));
    byCls[cls] = rows || [];
  }
  const picked = [];
  const seen = new Set();
  for (const g of GROUPS) {
    const pool = [];
    for (const cls of g.cls) {
      for (const it of (byCls[cls] || [])) {
        if (!it.name.includes(g.kw)) continue;
        if (DERIV.test(it.name)) continue;
        pool.push(it);
      }
    }
    pool.sort((a, b) => a.code.localeCompare(b.code));
    let n = 0;
    for (const it of pool) {
      if (n >= g.max || seen.has(it.code)) continue;
      picked.push(Object.assign({}, it, { group: g.key, groupLabel: g.label, expectComps: g.comps }));
      seen.add(it.code);
      n++;
    }
  }
  return picked.slice(0, MAX_ETF);
}

/** 抓一只 ETF 的 PCF（基本信息 + 成分股） */
async function fetchPcf(code) {
  const [j, c] = await Promise.all([getJson(jbxxUrl(code), SSE_HEADERS), getJson(compUrl(code), SSE_HEADERS)]);
  const base = (j.result && j.result[0]) || null;
  if (!base) throw new Error('无当日清单');
  const comps = (c.result || [])
    .filter(x => x && x.INSTRUMENT_ID && num(x.QUANTITY) > 0)   // 股数 0 = 纯现金替代，不构成实物持仓
    .map(x => [x.INSTRUMENT_ID, num(x.QUANTITY) || 0]);
  return {
    code,
    name: base.FUND_NAME,
    tradeDate: base.TRADING_DAY,
    nav: num(base.NAV),
    unit: num(base.CREATION_REDEMPTION_UNIT),
    navPerCu: num(base.NAVPERCU),
    cash: num(base.ESTIMATED_CASH_COMPONENT),
    compCount: num(base.RECORD_NUM),
    comps,
  };
}

/**
 * 腾讯行情批量取数（GBK，字段位固定）。
 * 为什么份额用腾讯而不是东财：本机 push2 全族常整体不可达（socket hang up），
 * 而 qt.gtimg.cn 是本项目主行情源、稳定可达；一次请求可批量 60 只。
 * 字段（下标从 0 起，`~` 分隔）：1=名称 3=现价 72=流通股本/份额 73=总股本/份额 78=净值(IOPV)
 * 交叉验证（20261022 实测）：510300 现价 4.107、总市值 1240.28 亿 → 份额 = 1240.28e8/4.107 = 301.99 亿份，
 * 与字段 72 = 30199087700 完全一致；601318 字段 72=106.6 亿（A股流通）/73=181.08 亿（总股本）亦正确。
 * ETF 的 72 与 73 相等（无流通/非流通之分），取 72 优先、73 兜底。
 */
const TX_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  'Referer': 'https://gu.qq.com/',
};
const txPrefix = (c) => (/^(5|6|9)/.test(c) ? 'sh' : 'sz') + c;

async function tencentQuotes(codes, timeout = 12000) {
  const out = {};
  const BATCH = 60;
  for (let i = 0; i < codes.length; i += BATCH) {
    const chunk = codes.slice(i, i + BATCH);
    try {
      const buf = await httpGetBuf('https://qt.gtimg.cn/q=' + chunk.map(txPrefix).join(','), TX_HEADERS, timeout);
      const txt = new TextDecoder('gbk').decode(buf);
      for (const seg of txt.split(';')) {
        const s = seg.trim();
        if (!s || s.indexOf('~') < 0) continue;
        const a = s.split('~');
        const m = /v_[a-z]{2}(\d{6})/.exec(s);
        const code = a[2] || (m && m[1]);
        if (!code) continue;
        out[code] = {
          name: a[1] || '',
          price: num(a[3]),
          shares: num(a[72]) || num(a[73]),
          nav: num(a[78]),
        };
      }
    } catch (e) { noteErr('腾讯行情批量取数', e); }
  }
  return out;
}

/** 东财实时份额（f84，单位：份）—— 仅作腾讯缺失时的备链 */
async function fetchSharesEastmoney(codes) {
  const out = {};
  const q = codes.map(c => (/^(6|9)/.test(c) ? '1.' : '0.') + c).join(',');
  try {
    const j = await getJsonEm(`/api/qt/ulist.np/get?fltt=2&fields=f12,f14,f84&secids=${q}`);
    const list = (j.data && j.data.diff) || [];
    for (const it of (Array.isArray(list) ? list : Object.values(list))) {
      const v = num(it.f84);
      if (it.f12 && v) out[it.f12] = v;
    }
  } catch (e) { noteErr('东财 f84 备链', e); }
  return out;
}

/** 基金份额（份）：腾讯 → 东财备链。返回 {code: 份} */
async function fetchShares(codes) {
  if (!codes.length) return {};
  const tx = await tencentQuotes(codes);
  const out = {};
  for (const c of codes) if (tx[c] && tx[c].shares) out[c] = tx[c].shares;
  const missing = codes.filter(c => !out[c]);
  if (missing.length) {
    const em = await fetchSharesEastmoney(missing);
    for (const c of missing) if (em[c]) out[c] = em[c];
  }
  return out;
}

/**
 * 成分股名称（只抓缺的，永久累积到 stock-names.json）。
 * PCF 只给 INSTRUMENT_ID，不给名称；页签要显示"哪只股票被申购"就必须补名称。
 * 一次全市场宽基交集约 1400~1600 只，首轮约 25 个批次，之后基本零请求。
 */
const NAME_CACHE = path.join(DIR, 'stock-names.json');
async function fetchStockNames(codes) {
  let cache = readJson(NAME_CACHE, null);
  if (!cache || typeof cache !== 'object') cache = {};
  const missing = Array.from(new Set(codes)).filter(c => c && !cache[c]);
  if (missing.length) {
    const got = await tencentQuotes(missing);
    let n = 0;
    for (const c of Object.keys(got)) {
      if (got[c] && got[c].name) { cache[c] = got[c].name; n++; }
    }
    if (n) writeJson(NAME_CACHE, cache);
  }
  return cache;
}

// ── 快照 ──
function snapPath(date) { return path.join(DIR, `${date}.json`); }
function pcfCachePath(date) { return path.join(PCF_DIR, `${date}.json`); }
function listSnapshots() {
  try {
    return fs.readdirSync(DIR)
      .filter(f => /^\d{8}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort();
  } catch (e) { return []; }
}
function pruneSnapshots() {
  const all = listSnapshots();
  for (const d of all.slice(0, Math.max(0, all.length - KEEP_DAYS))) {
    try { fs.unlinkSync(snapPath(d)); } catch (e) { noteErr('清理过期快照 ' + d, e); }
  }
}

/**
 * 采集当日快照（PCF 当日缓存 + 份额实时）。
 * @returns {{ok:boolean, date:string, etfs:Array, gaps:string[]}}
 */
async function collect(opts = {}) {
  const gaps = [];
  // [20261103g] 测试注入口：opts.universe/fetchPcf/fetchShares 可覆盖外呼（回归测试用；生产不传走默认实现）
  const _fetchPcf = opts.fetchPcf || fetchPcf;
  const _fetchShares = opts.fetchShares || fetchShares;
  const universe = opts.universe || await selectUniverse();
  if (!universe.length) return { ok: false, date: null, etfs: [], gaps: ['上交所宽基 ETF 名单为空'] };

  // [20261109a] 名单完整性硬判据（A）：opts.universe 是白盒测试注入口（生产永不传），
  // 夹具自担基准，可用 assumeCompleteUniverse 显式豁免；生产一律走绝对基准校验。
  const uInt = opts.assumeCompleteUniverse ? null : universeIntegrity(universe);
  const universeBad = !!uInt && !uInt.ok;
  if (universeBad) {
    gaps.push(`ETF 名单不完整：仅 ${uInt.size} 只（下限 ${uInt.minSize} 只），家族覆盖 ${uInt.families}/${uInt.expectedFamilies}`
      + (uInt.missing.length ? `，缺 ${uInt.missing.join('、')}` : '')
      + '；本次快照标记残缺、不定稿、不作基期，待重采自愈');
  }

  // PCF 缓存键用**北京日期**：同一自然日内 RPC 内容固定（开市前已发布），重复运行不必重抓。
  // 交易日由 PCF 自己的 TRADING_DAY 决定（非交易日会返回上一交易日清单）→ 天然规避假期。
  const cacheKey = opts.cacheKey || localCompact();
  const cache = readJson(pcfCachePath(cacheKey), null);

  let tradeDate = null;
  let pcfs;
  if (cache && cache.byCode) {
    tradeDate = cache.date;
    pcfs = universe.map(u => cache.byCode[u.code] || null);
    // 缓存命中的只是「当时那份名单」。名单扩容（修正关键词/放宽配额）后，新增的 ETF 不能被
    // cache 一挡就是一整天 —— 只补抓缺的那几只，并回写缓存（其它已有条目不动）。
    const missCodes = universe.filter(u => !cache.byCode[u.code]).map(u => u.code);
    if (missCodes.length) {
      const extra = await mapLimit(missCodes, CONCURRENCY, (code) => _fetchPcf(code));
      let added = 0;
      missCodes.forEach((code, i) => {
        const p = extra[i];
        if (p && !p.__err) { cache.byCode[code] = p; added++; }
        else gaps.push(`${code} 无当日清单${p && p.__err ? '（' + p.__err + '）' : ''}`);
      });
      if (added) {
        writeJson(pcfCachePath(cacheKey), { date: tradeDate, savedAt: new Date().toISOString(), byCode: cache.byCode });
        gaps.push(`名单扩容：补抓 ${added} 只新增 ETF 的当日清单`);
      }
      pcfs = universe.map(u => cache.byCode[u.code] || null);
    }
  } else {
    pcfs = await mapLimit(universe.map(u => u.code), CONCURRENCY, (code) => _fetchPcf(code));
    const okList = pcfs.filter(p => p && !p.__err);
    if (!okList.length) return { ok: false, date: null, etfs: [], gaps: ['PCF 全部抓取失败'] };
    tradeDate = okList[0].tradeDate;
    const byCode = {};
    for (const p of okList) byCode[p.code] = p;
    writeJson(pcfCachePath(cacheKey), { date: tradeDate, savedAt: new Date().toISOString(), byCode });
  }

  const okPcfs = [];
  pcfs.forEach((p, i) => {
    if (!p) { gaps.push(`${universe[i].code} 无当日清单`); return; }
    if (p.__err) { gaps.push(`${universe[i].code} 抓取失败：${p.__err}`); return; }
    okPcfs.push(p);
  });

  // [20261103g] 跨日重采守卫（根修 11-01 周日覆盖 10-30 定稿快照事故）：
  // 节假日/周末触发 collect 时，PCF 返回的是上一交易日清单 → tradeDate 为历史日期。
  // 若该历史 tradeDate 已有「已定稿且非残缺」快照，必须保留原快照（不覆盖、不重抓份额）——
  // 覆盖会让 shareDate 按 T+1 采集日语义前推一个交易日（10-29→10-30），导致：
  //   ① 与下一交易日快照同值 → 逐日表该日显示假 Δ=0（真实申赎丢失）；
  //   ② 台账按新 shareDate 再次入账 → 相邻交易日的增量被重复计入累计值。
  // partial（残缺）快照不拦截：重采自愈通道（20261029j）保留；无历史快照时跨日补采通道（20261026a）保留。
  {
    const todayCompact = localCompact();
    const existHist = readJson(snapPath(tradeDate), null);
    if (String(tradeDate) < todayCompact && existHist && existHist.settled && !existHist.partial) {
      return {
        ok: true,
        date: tradeDate,
        etfs: existHist.etfs || [],
        gaps: [...gaps, `节假日/跨日重采：tradeDate ${tradeDate} 已有定稿快照（份额披露日 ${existHist.shareDate || '—'}），按「节假日只读取最后一次更新数据」原则保留原快照，不覆盖`],
        settled: true,
      };
    }
  }

  const shares = await _fetchShares(okPcfs.map(p => p.code));
  const missingShare = okPcfs.filter(p => !shares[p.code]).map(p => p.code);
  if (missingShare.length) gaps.push(`份额缺失 ${missingShare.length} 只（${missingShare.slice(0, 5).join('、')}${missingShare.length > 5 ? ' 等' : ''}）`);

  const etfs = okPcfs.map((p) => {
    const u = universe.find(x => x.code === p.code) || {};
    return {
      code: p.code,
      name: p.name,
      group: u.group || 'other',
      groupLabel: u.groupLabel || '其他',
      nav: p.nav,
      unit: p.unit,
      navPerCu: p.navPerCu,
      cash: p.cash,
      compCount: p.compCount,
      shares: shares[p.code] || null,
      comps: p.comps,
    };
  });

  // 20261026a：shareDate 必须按「采集日」推，不能按 tradeDate 推。
  // 份额是 T+1 披露：采集当日能看到的最新官方份额 = 采集日前一交易日的收盘份额。
  // 若按 tradeDate 推：跨日补采（如周六补采周五 tradeDate）时 field72 已前进到 tradeDate
  // 当日官方值，却仍标成 tradeDate-1 → 与下一份快照「同日对同日」相减得出假 Δ=0
  // （2026-10-23 数据日实测：510300 真实净申购 +25.13 亿份被显示成 0.00 亿，用户报障）。
  let snapShareDate = _prevTd(localCompact());   // 采集日（北京日期），与 PCF cacheKey 无关
  if (snapShareDate > tradeDate) snapShareDate = tradeDate;   // 补采更早 tradeDate 时钳回，防日期倒挂
  // [20261029j] 残缺快照守卫：只要有 ETF 没采全（PCF 失败或份额缺失），即使过了 15:05 也不得定稿。
  // 残缺快照一旦 settled，次日会被选为基期，缺失的 code 全部误报「基期无快照（新入名单）」
  // （20261028 事故：27/34 只 PCF 失败却定稿，10-29 沪深300 组全军覆没，用户报障）。
  // 未定稿（settled:false + partial:true）留待重采自愈：后续重采可覆盖，基期选择自动回退上一份完整快照。
  // [20261109a] 双保险（B）：① 名单完整性绝对判据；② 相对判据（PCF 成功数 < 当次名单数）；
  // ③ 绝对只数下限（名单即使被缩水或注入绕过也不放过）；④ 份额缺失。
  // 只要任一命中，快照一律 partial:true / settled:false —— 跨日重采守卫不会保护它，
  // computeFromSnapshots 也不会选它作基期，重采自愈通道保持打开。
  const partial = universeBad
    || okPcfs.length < universe.length
    || (!!uInt && okPcfs.length < uInt.minSize)
    || missingShare.length > 0;
  const snap = { date: tradeDate, shareDate: snapShareDate, savedAt: new Date().toISOString(), settled: sessionSettled(tradeDate) && !partial, etfs };
  if (partial) { snap.partial = true; snap.gaps = gaps.slice(); }

  // 成分股名称补齐（只抓缺失、永久累积；失败不阻断，展示时用代码兜底）
  try {
    const allCodes = [];
    for (const e of etfs) for (const [c] of e.comps) allCodes.push(c);
    const names = await fetchStockNames(allCodes);
    if (Object.keys(names || {}).length) snap.stockNames = names;
  } catch (e) { gaps.push('成分股名称抓取失败（将只显示代码）'); }

  // 已定稿的快照不允许被盘中读数降级覆盖（否则次日算 Δ份额 会以半天数据为基期）
  const exist = readJson(snapPath(tradeDate), null);
  if (!(exist && exist.settled && !snap.settled)) writeJson(snapPath(tradeDate), snap);
  pruneSnapshots();
  return { ok: true, date: tradeDate, etfs, gaps, settled: snap.settled };
}

// ── 计算 ──
/** 净申赎额 → 因子得分（±1，tanh 软饱和；基准 SHARE_BASE 元 ≈ ±0.76） */
function scoreOf(totalNet) {
  const v = Number(totalNet);
  if (!Number.isFinite(v)) return 0;
  return Math.max(-1, Math.min(1, Math.tanh(v / SHARE_BASE)));
}

/**
 * 以「本日快照 − 最近一份已定稿快照」算净申赎，并把定稿日的增量累加到台账。
 * 基期只认 settled:true 的快照：份额是盘中实时值，若拿 10:00 的半天读数当基期，
 * 次日算出来的 Δ份额 会虚增。
 * @returns {object} 明细（供因子与前端页签使用）
 */
function computeFromSnapshots(date) {
  const today = readJson(snapPath(date), null);
  if (!today) return { ok: false, reason: '当日快照缺失' };

  // 20261023j：腾讯行情 field 72（基金份额）是 T-1 披露值——10-23 收盘后取到的份额，权威数据实际
  // 对应上一交易日（510300 实测：本站 32,729,887,700 份 = 东财 2026-10-22 的 327.3 亿份）。
  // 因此「数据日」必须用份额披露日 shareDate，不能用快照的 tradeDate，否则会「标注今日、数据是昨天」。
  const shareDate = today.shareDate || _prevTd(today.date);

  // 基期 = 本日之前最近一份「已定稿」快照
  let baseDate = null, base = null;
  for (const d of listSnapshots()) {
    if (d >= date) continue;
    const s = readJson(snapPath(d), null);
    // [20261029j] 双保险：partial（残缺）快照即使 settled 也不得作为基期——残缺基期会让缺失 code 全部误报「新入名单」
    if (s && s.settled && !s.partial) { baseDate = d; base = s; }
  }
  const baseShareDate = base ? (base.shareDate || _prevTd(base.date)) : null;

  // 20261026a 守卫：基期披露日 ≥ 本期披露日 → 两份快照拿到的是同一披露日的份额，
  // 相减必得假 Δ=0（2026-10-23 数据日实测事故）。宁可诚实报「无法计算」，不可输出假 0。
  if (baseShareDate && baseShareDate >= shareDate) {
    return {
      ok: false,
      overlap: true,
      date: shareDate,
      snapshotDate: today.date,
      baseDate,
      reason: `份额披露未跨日：本期与基期快照拿到的都是 ${shareDate} 收盘份额（基期快照 ${baseDate} 为跨日补采，未捕获更早披露日），净申赎无法计算。下一交易日快照披露跨日后自动恢复。`,
      etfs: today.etfs.map(e => ({ code: e.code, name: e.name, group: e.group, groupLabel: e.groupLabel, nav: e.nav, unit: e.unit, shares: e.shares, dShares: null, baskets: null, netAmount: null, note: '' })),
      stocks: [],
      groups: [],
      settled: !!today.settled,
    };
  }
  // 基期披露日与本期不相邻（跨多日）：Δ 为多日合计，须标注，防止误读为单日申赎
  const spanNote = (baseShareDate && _prevTd(shareDate) !== baseShareDate)
    ? `基期披露日 ${baseShareDate} 与本期 ${shareDate} 不相邻，净申赎为多日合计值`
    : null;
  if (!base) {
    return {
      ok: false,
      noPrev: true,
      date: shareDate,
      snapshotDate: today.date,
      baseDate: null,
      reason: `已建立基线（${shareDate}），下一交易日出现第二份定稿快照后即可计算净申赎`,
      etfs: today.etfs.map(e => ({ code: e.code, name: e.name, group: e.group, groupLabel: e.groupLabel, nav: e.nav, unit: e.unit, shares: e.shares, dShares: null, baskets: null, netAmount: null, note: '' })),
      stocks: [],
      groups: [],
      settled: !!today.settled,
    };
  }
  const prevMap = {};
  for (const e of (base.etfs || [])) prevMap[e.code] = e;

  const etfRows = [];
  const stockAgg = new Map();     // group|code -> {buyShares, sellShares, buyDays?, ...}
  const groupAgg = new Map();
  let totalNet = 0;
  let priced = 0;

  for (const e of today.etfs) {
    const p = prevMap[e.code];
    const row = {
      code: e.code, name: e.name, group: e.group, groupLabel: e.groupLabel,
      nav: e.nav, unit: e.unit, shares: e.shares, prevShares: p ? p.shares : null,
      dShares: null, baskets: null, netAmount: null, note: '',
    };
    if (!p) { row.note = '基期无快照（新入名单）'; etfRows.push(row); continue; }
    if (!e.shares || !p.shares) { row.note = '份额缺失'; etfRows.push(row); continue; }
    const dShares = e.shares - p.shares;
    row.dShares = dShares;
    row.baskets = e.unit ? dShares / e.unit : null;
    row.netAmount = (e.nav || p.nav) ? dShares * (e.nav || p.nav) : null;
    if (row.baskets != null && Math.abs(row.baskets - Math.round(row.baskets)) > 0.05 && dShares !== 0) {
      row.note = `Δ份额 ÷ 申赎单位 = ${round(row.baskets, 3)}，非整数（可能含分红/拆分或份额口径差异）`;
    }
    if (row.netAmount != null) { totalNet += row.netAmount; priced++; }
    etfRows.push(row);

    // 逐股：篮数 × 每篮份数（用当日篮子；篮子若调仓，差额归因于调仓，不归因于申赎）
    // 聚合键用**股票代码**而不是「家族|代码」：用户要看的是"这只股票一共被申购多少"，
    // 同一只股票同时属于沪深300与中证500篮子时必须合并，拆成两行会让人以为只被买了半份。
    if (row.baskets) {
      for (const [code, qty] of e.comps) {
        let a = stockAgg.get(code);
        if (!a) { a = { code, buyShares: 0, sellShares: 0, groups: new Set() }; stockAgg.set(code, a); }
        a.groups.add(e.group);
        const delta = row.baskets * qty;
        if (delta > 0) a.buyShares += delta; else a.sellShares += delta;
      }
      let g = groupAgg.get(e.group);
      if (!g) { g = { key: e.group, label: e.groupLabel, netAmount: 0, buyAmount: 0, sellAmount: 0, etfCount: 0 }; groupAgg.set(e.group, g); }
      if (row.netAmount != null) {
        g.netAmount += row.netAmount;
        if (row.netAmount > 0) g.buyAmount += row.netAmount; else g.sellAmount += row.netAmount;
        g.etfCount++;
      }
    }
  }

  // 累计台账（幂等：同一代码同日只累加一次；只吃「已定稿」的收盘值，盘中增量不进台账）
  // settled 取**快照里记录的**标志，不按当前时间重算：一份 14:00 采的快照到了晚上依然是盘中值，
  // 若按当前时间重算就会把半天增量当成收盘值记进累计台账。
  const ledger = readJson(LEDGER, { lastDate: null, cum: {}, days: 0 }) || { lastDate: null, cum: {}, days: 0 };
  // 20261023j 一次性迁移：旧台账把 lastDate 记成 tradeDate（20261023），实际份额日期是 20261022。
  if (ledger.lastDate && ledger.lastDate === today.date && shareDate !== today.date) {
    ledger.lastDate = shareDate;
    writeJson(LEDGER, ledger);
  }
  const settled = !!today.settled;
  const already = ledger.lastDate === shareDate;
  if (settled && !already) {
    for (const [key, a] of stockAgg) {
      let c = ledger.cum[key];
      if (!c) { c = { buyShares: 0, sellShares: 0, buyDays: 0, sellDays: 0 }; ledger.cum[key] = c; }
      if (a.buyShares > 0) { c.buyShares += a.buyShares; c.buyDays += 1; }
      if (a.sellShares < 0) { c.sellShares += a.sellShares; c.sellDays += 1; }
    }
    ledger.lastDate = shareDate;
    ledger.days = (ledger.days || 0) + 1;
    writeJson(LEDGER, ledger);
  }

  // 逐股清单 = 今日篮子 ∪ 台账历史（已退出篮子的股票其累计值仍要展示，否则"一共被申购了多少"会少算）
  const names = today.stockNames || readJson(NAME_CACHE, {}) || {};
  const gLabel = (k) => (GROUPS.find(g => g.key === k) || {}).label || k;
  const keys = new Set(Object.keys(ledger.cum || {}));
  for (const k of stockAgg.keys()) keys.add(k);
  const stocks = [];
  for (const code of keys) {
    const a = stockAgg.get(code);
    const c = (ledger.cum || {})[code] || { buyShares: 0, sellShares: 0, buyDays: 0, sellDays: 0 };
    if (!c.buyShares && !c.sellShares && !(a && (a.buyShares || a.sellShares))) continue;
    const groups = a ? Array.from(a.groups) : [];
    stocks.push({
      code,
      name: names[code] || '',
      groups,
      groupLabel: groups.map(gLabel).join(' / '),
      dayBuy: a ? a.buyShares : 0, daySell: a ? a.sellShares : 0,
      cumBuy: c.buyShares, cumSell: c.sellShares,
      buyDays: c.buyDays, sellDays: c.sellDays,
    });
  }
  const mag = (v) => Math.abs(v || 0);
  stocks.sort((x, y) => (mag(y.cumBuy) + mag(y.cumSell)) - (mag(x.cumBuy) + mag(x.cumSell))
    || (mag(y.dayBuy) + mag(y.daySell)) - (mag(x.dayBuy) + mag(x.daySell)));

  return {
    ok: true,
    date: shareDate,
    snapshotDate: today.date,
    baseDate: baseShareDate,
    settled,
    spanNote,
    etfs: etfRows,
    stocks,
    groups: Array.from(groupAgg.values()).map(g => Object.assign(g, {
      netAmount: round(g.netAmount, 0), buyAmount: round(g.buyAmount, 0), sellAmount: round(g.sellAmount, 0),
    })),
    totalNet: round(totalNet, 0),
    pricedCount: priced,
    ledgerDays: ledger.days || 0,
    ledgerDate: ledger.lastDate,
    ledgerIncludesToday: already || (settled && ledger.lastDate === date),
  };
}

/**
 * 对外入口：返回 {ok, date, factor:{score,value,detail}, detail:{...}, gaps}
 * 失败一律降级（不抛错、不影响情绪模型其它因子）。
 *
 * 缓存两层：
 *   1. 内存 memo（TTL 3 分钟）+ in-flight 去重 —— 情绪模型与前端页签同时要数据时
 *      只发一轮请求（上交所接口对高频调用会 502）。
 *   2. 磁盘 PCF 缓存（按中国自然日）—— 同一自然日内清单不变，跨进程重启也免重抓。
 * refresh=true 绕过内存 memo（磁盘缓存仍生效，因为清单本身就是当日固定的）。
 */
const MEMO_TTL = 3 * 60 * 1000;
let _memo = null;
let _inflight = null;

function getEtfFlow(opts = {}) {
  const refresh = !!opts.refresh;
  if (!refresh && _memo && Date.now() - _memo.at < MEMO_TTL) {
    return Promise.resolve(Object.assign({}, _memo.result, { fromMemo: true }));
  }
  if (_inflight) return _inflight;
  _inflight = _computeEtfFlow(opts)
    .then((r) => { const r2 = withLastFactorFallback(r); _memo = { at: Date.now(), result: r2 }; return r2; })
    .catch((e) => withLastFactorFallback({ ok: false, gaps: [`采集异常：${e && e.message ? e.message : e}`], detail: null, factor: null }))
    .finally(() => { _inflight = null; });
  return _inflight;
}

// [20261103g] 节假日/取数失败兜底（用户指令：节假日只读取最后一次更新的数据）：
// 当次取不到有效因子（采集异常/PCF 全失败/基线期/披露未跨日）时，回读最近一次成功因子，
// 显式标注兜底日期与当前原因——宁可展示「标注了日期的旧数据」，不出报错/空值。
// 正常交易日不触发（跨日守卫保证节假日 collect 返回已有定稿快照，因子照常有效）。
function withLastFactorFallback(r) {
  if (r && r.ok && r.factor && !r.factor.degraded) return r;
  const last = getLastSuccessfulFactor();
  if (!last) return r;
  const reason = (r && r.gaps && r.gaps.length) ? r.gaps.join('；') : ((r && r.reason) || '实时取数失败');
  return Object.assign({}, r, {
    ok: true,
    date: last.date,
    fallback: true,
    factor: Object.assign({}, last.factor, {
      fallback: true,
      reason: `节假日/取数兜底：显示最近一次成功数据（${last.date}）；当前原因：${reason}`,
    }),
  });
}

async function _computeEtfFlow(opts = {}) {
  const gaps = [];
  let collected = null;
  try {
    collected = await collect(opts);
  } catch (e) {
    return { ok: false, gaps: [`采集失败：${e && e.message ? e.message : e}`], detail: null, factor: null };
  }
  if (!collected.ok) return { ok: false, gaps: collected.gaps || ['无数据'], detail: null, factor: null };
  gaps.push(...(collected.gaps || []));
  // 采集过程中的非致命错误（某批行情失败、备链不可达等）如实并入 gaps
  const errs = drainErrs();
  if (errs.length) gaps.push(...errs.slice(0, 5));

  const calc = computeFromSnapshots(collected.date);
  if (!calc.ok) {
    return {
      ok: true,
      date: calc.date || collected.date,
      baselineOnly: true,
      reason: calc.reason,
      gaps,
      factor: { score: 0, degraded: true, reason: calc.reason, value: calc.overlap ? '披露未跨日，净申赎无法计算' : '基线日（尚无定稿基期快照）', detail: calc.reason },
      detail: calc,
    };
  }
  if (calc.spanNote) gaps.push(calc.spanNote);

  const totalNet = calc.totalNet;
  const score = scoreOf(totalNet);
  const yi = (v) => (v == null ? '—' : (v / 1e8).toFixed(2) + ' 亿');
  const valid = calc.etfs.filter(e => e.netAmount != null);
  const nBuy = valid.filter(e => e.netAmount > 0).length;
  const nSell = valid.filter(e => e.netAmount < 0).length;
  const value = `${totalNet >= 0 ? '净申购' : '净赎回'} ${yi(Math.abs(totalNet))} · ${nBuy} 只净申购 / ${nSell} 只净赎回`;
  const sessText = calc.settled ? '已收盘定稿' : '盘中读数（收盘后定稿）';
  const detail = `宽基 ETF（${calc.groups.map(g => g.label).join('、')}，有效 ${valid.length} 只）份额较上一收盘 ${calc.baseDate} `
    + `${totalNet >= 0 ? '合计增加' : '合计减少'} → 折算${totalNet >= 0 ? '净申购' : '净赎回'} ${yi(Math.abs(totalNet))}（${sessText}）。`
    + `口径：Δ份额 ÷ 最小申赎单位 = 篮数，再乘每篮成分股数得逐股理论增减量；份额本身是「净」概念，无法拆出申购总量与赎回总量。`;
  const factor = {
    score: round(score, 3), degraded: false, value, detail,
    totalNet, ledgerDays: calc.ledgerDays, settleStatus: calc.settled ? 'settled' : 'intraday',
  };
  // [20261103g] 每次产出有效因子即落盘，供节假日/取数失败时兜底回读
  saveLastSuccessfulFactor(calc.date, factor);
  return {
    ok: true,
    date: calc.date,              // 20261023j：份额披露日（T-1），不是快照 tradeDate
    snapshotDate: calc.snapshotDate,
    baseDate: calc.baseDate,
    settled: calc.settled,
    gaps,
    factor,
    detail: calc,
  };
}

// [20261103g] 有效因子（非 degraded）落盘为「最近一次成功数据」；取数失败时回读兜底
function saveLastSuccessfulFactor(date, factor) {
  try {
    writeJson(LAST_FACTOR_FILE, { date, factor, savedAt: new Date().toISOString() });
  } catch (e) { /* 兜底文件写失败不影响主流程 */ }
}
function getLastSuccessfulFactor() {
  const r = readJson(LAST_FACTOR_FILE, null);
  return (r && r.factor) ? r : null;
}

/**
 * 某只成分股「当月逐日」被宽基 ETF 申购/赎回/净申赎（20261027a 新建；20261027b 修标签口径）。
 * 口径与累计台账一致：只认已定稿(settled)快照；相邻两份快照的 ETF Δ份额 ÷ 申赎单位 = 篮数，
 * 篮数 × 该股在该 ETF 篮子里的股数 = 该股当日理论增减；多只 ETF 含同一股票时按代码合并。
 * 20261027b（用户质询「今日数据怎么来的」）：行标签必须用**份额披露日 shareDate（数据日）**，
 * 不能用快照 tradeDate——快照 20261027 里的份额是 T+1 披露的 20261026 官方值，标成 20261027
 * 会「标注今日、数据是昨天」（与 20261023j 主卡修正同规则）。基期取全量快照链中前一份已定稿
 * 快照（正确处理跨月/跨假期）；披露日不相邻时打 spanNote「多日合计」，绝不吃掉跨度。
 *
 * [20261109a] 用户指令「11月5日和6日的数据为什么缺少，无法区分也可以一并合计入统计表格里面」：
 * 原实现只吃 settled && !partial 的定稿快照，把最后一份「可计算但未定稿」的盘中快照整条丢掉，
 * 于是 11-04→11-06 已经算得出的份额差凭空消失。现把该快照以**一条多日合计行**纳入 rows/totals，
 * 行上带 spanNote「多日合计（A→B）· 含未定稿读数」+ provisional:true 供前端诚实标注。
 * 硬边界：① 只取定稿链之后最新的一份，且披露日严格晚于最后一行（绝不重复计数）；
 * ② 该快照必须 partial:false 且 ETF 名单未缩水（≥ 基期 × UNIVERSE_MIN_RATIO），防残缺数据造出假 Δ；
 * ③ 累计台账 computeFromSnapshots() 仍只吃 settled，本函数只读快照、不写任何状态，未定稿值不入台账。
 */
function stockMonthlyFlow(code, month) {
  const target = String(code || '').trim();
  if (!target) return { ok: false, error: '缺少股票代码' };
  const prefix = String(month || '').trim() ||
    (function () { const d = new Date(); return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0'); })();
  const all = listSnapshots()
    .map(d => readJson(snapPath(d), null))
    .filter(s => s && Array.isArray(s.etfs) && s.etfs.length)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  // 定稿链口径完全不变：残缺快照既不能当基期，也不能当本期
  const snaps = all.filter(s => s.settled && !s.partial);

  // 相邻两份快照对某只成分股的 Δ（定稿行与未定稿多日合计行共用同一套算法，保证口径一致）
  function deltaRow(p, s) {
    const shareDate = s.shareDate || _prevTd(s.date);
    const baseShareDate = p.shareDate || _prevTd(p.date);
    const prevMap = {};
    for (const e of (p.etfs || [])) prevMap[e.code] = e;
    let buy = 0, sell = 0;
    for (const e of s.etfs) {
      const q = prevMap[e.code];
      if (!q || !e.shares || !q.shares || !e.unit) continue;
      const dBaskets = (e.shares - q.shares) / e.unit;
      if (!isFinite(dBaskets) || dBaskets === 0) continue;
      const comp = (e.comps || []).find(c => c && c[0] === target);
      if (!comp) continue;
      const delta = dBaskets * (comp[1] || 0);
      if (delta > 0) buy += delta; else sell += Math.abs(delta);
    }
    const spanNote = (baseShareDate && _prevTd(shareDate) !== baseShareDate)
      ? `多日合计（${baseShareDate}→${shareDate}）` : null;
    return {
      date: shareDate,          // 数据日 = 份额披露日（T+1），不是快照采集日
      snapshotDate: s.date,     // 溯源：哪天的收盘快照取到的
      buy: Math.round(buy), sell: Math.round(sell), net: Math.round(buy - sell),
      spanNote,
    };
  }

  const rows = [];
  for (let i = 1; i < snaps.length; i++) {
    const s = snaps[i], p = snaps[i - 1];
    const shareDate = s.shareDate || _prevTd(s.date);
    if (!shareDate || !shareDate.startsWith(prefix)) continue;
    rows.push(deltaRow(p, s));
  }

  // ---- 未定稿多日合计行（20261109a）----
  let provisionalRows = 0;
  const lastSettled = snaps[snaps.length - 1];
  if (lastSettled) {
    const lastRowDate = rows.length ? rows[rows.length - 1].date : null;
    const candidates = all
      .filter(s => !s.settled && !s.partial)
      .filter(s => (s.date || '') > (lastSettled.date || ''))
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const latest = candidates[0];
    if (latest) {
      const shareDate = latest.shareDate || _prevTd(latest.date);
      const baseShareDate = lastSettled.shareDate || _prevTd(lastSettled.date);
      const minSize = Math.floor((lastSettled.etfs || []).length * UNIVERSE_MIN_RATIO);
      const okUniverse = (latest.etfs || []).length >= minSize;
      const okDate = shareDate && shareDate.startsWith(prefix)
        && shareDate > baseShareDate && shareDate > (lastRowDate || '');
      if (okUniverse && okDate) {
        const r = deltaRow(lastSettled, latest);
        r.spanNote = r.spanNote ? `${r.spanNote} · 含未定稿读数` : '含未定稿读数';
        r.provisional = true;
        rows.push(r);
        provisionalRows = 1;
      }
    }
  }

  const totals = rows.reduce((a, r) => ({ buy: a.buy + r.buy, sell: a.sell + r.sell, net: a.net + r.net }), { buy: 0, sell: 0, net: 0 });
  return { ok: true, code: target, month: prefix, rows, totals, settledDays: snaps.length, provisionalRows };
}

// 20261028a：全部宽基 ETF「持仓比例 vs 现金比例」日度趋势（折线图数据源）。
// 口径：PCF 预估现金部分（ESTIMATED_CASH_COMPONENT，含现金替代与现金差额）÷ 每篮净值（NAVPERCU）= 现金比例；
// 持仓比例 = 1 − 现金比例。按各 ETF 总市值（nav × shares）加权汇总。
// 快照磁盘只保留 KEEP_DAYS=10 天（pruneSnapshots 滚动清理），趋势另存 ratio-history.json 持久累积：
// 磁盘快照永远优先（更新鲜），历史文件只补磁盘已清理的日期 → 幂等、可跨越清理窗口。
const RATIO_HIST = path.join(DIR, 'ratio-history.json');

function cashPositionTrend() {
  const points = [];
  const gaps = [];
  for (const d of listSnapshots()) {
    const snap = readJson(snapPath(d), null);
    if (!snap || !Array.isArray(snap.etfs) || !snap.etfs.length) continue;
    let wSum = 0, cashWSum = 0, valid = 0;
    for (const e of snap.etfs) {
      if (!e || e.navPerCu == null || e.cash == null || !e.nav || !e.shares || !e.unit) continue;
      const cashRatio = e.cash / e.navPerCu;
      // 异常守卫：正常现金比例在 0~5% 量级，超出 ±50% 视为脏数据直接剔除（不让单只异常带偏全市场均值）
      if (!isFinite(cashRatio) || cashRatio <= -0.5 || cashRatio >= 0.5) continue;
      const w = e.nav * e.shares;
      if (!isFinite(w) || w <= 0) continue;
      wSum += w;
      cashWSum += cashRatio * w;
      valid++;
    }
    if (!wSum || !valid) { gaps.push(`${d} 无有效现金/净值数据`); continue; }
    const cashRatioPct = round(cashWSum / wSum * 100, 2);
    // [20261029k] 数据日铁律（20261027b 全台适用）：点标签必须用份额披露日 shareDate，不能用快照
    // tradeDate——清单「预估现金部分」按 T-1 收盘净值计算，加权份额也是 T+1 披露，整个点都是
    // T-1 收盘口径（用户指出：10-29 的点曾按 tradeDate 标 10-29，实际全是 10-28 收盘结构）。
    const shareDate = snap.shareDate || _prevTd(snap.date);
    points.push({
      date: shareDate,           // 数据日 = 份额披露日（T+1），与 ETF 明细 / 台账口径一致
      snapshotDate: snap.date,   // 溯源：哪份清单（tradeDate）采的
      cashRatioPct,
      stockRatioPct: round(100 - cashRatioPct, 2),
      etfCount: valid,
      settled: snap.settled === true,   // 盘中未定稿的读数是参考值，收盘定稿后会被覆盖修正
    });
  }
  const hist = readJson(RATIO_HIST, { points: [] });
  const byDate = {};
  points.forEach(p => { byDate[p.date] = p; });
  (Array.isArray(hist.points) ? hist.points : []).forEach(p => {
    if (p && p.date && !byDate[p.date]) byDate[p.date] = p;
  });
  const merged = Object.values(byDate).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  try {
    if (JSON.stringify(hist.points || []) !== JSON.stringify(merged)) {
      writeJson(RATIO_HIST, { savedAt: new Date().toISOString(), points: merged });
    }
  } catch (e) { noteErr('写持仓比例历史', e); }
  const unsettledDates = merged.filter(p => p.settled === false).map(p => p.date);
  return {
    ok: merged.length > 0,
    points: merged,
    unsettledDates,
    gaps,
    note: merged.length ? null : '暂无快照，无法计算趋势',
  };
}

module.exports = {
  GROUPS, DERIV, SHARE_BASE,
  universeIntegrity, UNIVERSE_FULL_SIZE, UNIVERSE_MIN_RATIO,
  selectUniverse, fetchPcf, fetchShares, tencentQuotes, collect, computeFromSnapshots, scoreOf, getEtfFlow, stockMonthlyFlow,
  getLastSuccessfulFactor,
  cashPositionTrend,
  sessionSettled, listSnapshots, snapPath, pcfCachePath, LEDGER, NAME_CACHE, DIR,
};

~~~

---

## `lib\eventEngine.js`  ·  1149 行

~~~js
/**
 * 事件驱动权重引擎 v2（20260907c）
 * ----------------------------------------------------------------------------
 * 链路：新闻发现事件 → 事件匹配自选股 → 自动调整权重 → 影响评分
 *
 * ★ 设计前提（用户核心洞察）：突发事件是极小概率事件。
 *   没有捕捉到事件时，事件因子权重 = 0，既有因子保持 100%。
 *   因此「误报代价 >> 漏报代价」：不确定一律归零，不猜。
 *
 * ★ 因果铁律：只收「外生事件」（因）。
 *   - 行情描述（指数高开/板块涨幅居前/北向资金流入）是「果」，一律拒收，
 *     交给既有的「市场情绪与消息面」因子，避免重复与循环论证。
 *   - 绝不用股价/指数变动去反推事件；市场数据仅在事件已识别后用于判断「是否已消化」。
 *
 * 分层级联（成本随漏斗骤减）：
 *   T0 先验：默认无事件，权重 0
 *   T1 规则硬闸门（零成本）：排除行情描述；研究观点类型封顶轻微
 *   T2 本地模型定性（零联网费）：事件类型 + 五维严重度 + 置信度
 *   T3 联网核查（极少，可配每日上限）：预期差 / 是否已定价 / 官方证实
 *   T4 交叉校验：一致采纳，不一致降级，不确定归零；重大需人工确认才生效
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getHotNews } = require('./newsSearch');
const { annotateNewsImpact, NEWS_SECTOR_MAP, summaryMatchesTitle } = require('./newsSectorImpact');
const { callLLM, pickModelFor } = require('./ai/llm');
const { loadConfig: loadAICfg, loadPromptFile } = require('./ai/config');
const { localDate, localCompact, localDateFromTs } = require('./localDate');

const EVENTS_DIR = path.join(__dirname, '..', 'data', 'events');
const CONFIG_FILE = path.join(EVENTS_DIR, 'config.json');
const ACTIVE_FILE = path.join(EVENTS_DIR, 'active.json');
const HISTORY_FILE = path.join(EVENTS_DIR, 'history.json');
const AUDIT_FILE = path.join(EVENTS_DIR, 'audit.json');
const STATE_FILE = path.join(EVENTS_DIR, 'state.json');
const WATCHLIST_FILE = path.join(__dirname, '..', 'data', 'watchlist.json');

const ENGINE_VERSION = 'v2';
const DAY = 86400000;

// ===== 原油主连冲击（突发因子·轻微事件变量，20260911；参考对象由布伦特原油期货改为原油主连）=====
// 触发：原油主连(INE·scm 主力连续合约)单日涨跌幅绝对值 > 3%
// ★ 20260914i：本事件等级为「轻微」，旧上限 20% 与分级严重失调（轻微基准才 3%）→ 降到 8%。
//   理由：单一商品的单日波动属高频、可预期波动，权重不应与「重大事件」同量级。
// 权重：按涨跌幅比例边际递增，封顶 8%（OIL_MAX_WEIGHT）
// 方向：石油石化板块正相关；其余板块负相关
//       （油价↑ → 推升美联储加息预期 → 对全球股指形成压制，反之亦然）
const OIL_SHOCK_FILE = path.join(EVENTS_DIR, 'oilShock.json'); // 手动/web抓取注入原油主连涨跌幅（兜底/测试/未来联网纳入）
const OIL_TRIGGER_PCT = 3;            // 单日涨跌幅触发阈值（绝对值，%）
const OIL_MAX_WEIGHT = 0.08;         // 因子权重上限 8%（20260914i：0.20→0.08，轻微级事件）
const OIL_WEIGHT_PER_PCT = 0.01;     // 权重 = min(上限, |涨跌幅%| × 该系数) → 按涨幅比例边际递增（20260914i：0.02→0.01）
const OIL_TTL_MS = 6 * 60 * 60 * 1000; // 缓存 6h，单次事件扫描即刷新
// ★ 20260921l（用户要求）：「原油主连」数据影响由 3 天改为 1 天。
//   理由：原油是高频波动的单一商品，单日涨跌幅的参考价值衰减极快——
//   隔一天再看，前日涨跌幅已被新行情覆盖，再挂 3 天会把"过期信息"当成持续利好/利空。
//   注意：本值同时被 defaultConfig().gradeRanges.minor.decayShortDays 使用（轻微级统一 1 天），
//   两处必须一致，否则合成事件与落盘事件口径打架。
const OIL_DECAY_DAYS = 1;             // 冲击有效期（天），原 3 → 现 1

// 已知自选股的板块归属（NEWS_SECTOR_MAP 的 hotStocks 未覆盖时兜底）
const STOCK_SECTOR_OVERRIDE = {
  '中国平安': '保险', '华安证券': '证券', '长江证券': '证券',
  '士兰微': '半导体', '圣湘生物': '医疗器械', '海天味业': '食品饮料',
};

// ===== T1 规则关键词 =====
// 「果」：行情描述/资金流/涨跌记录 —— 不是事件，直接拒收
const RE_MARKET_RECAP = /高开|低开|平开|收涨|收跌|涨幅居前|跌幅居前|涨超|跌超|创新高|创新低|新低|新高|成交额|换手率|换手|北向|主力资金|资金流入|资金流出|净流入|净流出|涨停|跌停|板块涨幅|领涨|领跌|走强|走弱|震荡|反弹|回调|飘红|飘绿/;
// 「观点」：券商研报/评级/策略 —— 不是事实，类型封顶轻微
const RE_RESEARCH = /研报|研究报告|给予|维持.{0,6}评级|首次覆盖|目标价|投资评级|策略报告|深度报告|券商.{0,8}(认为|表示|指出|预计|建议)|主线|配置建议|看好后市/;
// 常规货币政策操作：市场预期内、高度可预期（用户 20260907e 校准：轻微为主、最多中度，绝不重大；美联储降息/加息同理）
const RE_ROUTINE_MONETARY = /降准|降息|加息|存款准备金率|再贷款|再贴现|美联储.{0,12}(议息|降息|加息|利率)|FOMC|联邦基金利率/;
// 日常流动性管理（用户 20260907f/g 校准）：LPR 报价、逆回购、公开市场操作、MLF 属央行日常操作，不算突发事件，直接拒收（与行情播报同机制）
const RE_DAILY_LIQUIDITY = /LPR|贷款市场报价利率|逆回购|公开市场操作|MLF|中期借贷便利/;
// 20261021j A2（用户报障：「证监会再度强调将支持证券业并购重组」被判中度利空-3）：
// 「再度强调/再次强调/重申」= 旧政策的重申，没有新增具体措施。与 routine_monetary_policy 封顶 moderate
// 同一哲学但更严——重申类封顶 minor（+/-1），不再出现"重申一句话=中度事件"。
const RE_ROUTINE_REAFFIRM = /再度强调|再次强调|又一度强调|继续强调|重申|例行(发布|表态|通报)/;

// ===== 配置 =====
// ★ 20260914i 权重重设（用户口径）：
//   「轻微事件和中度事件的影响方向都是相反，权重不可能有 50%；就是三个中度事件叠加
//     都不应该有 50% 的权重。比较重大事件是战争级别的事件。」
//   → 旧值 major 0.45 / moderate 0.30 / minor 0.08 + 合计封顶 0.50 明显过高：
//      中度基准 0.30 本身偏高，且 min(sum, 0.5) 允许两个中度就顶到 50%。
//   → 新值 major 0.40 / moderate 0.12 / minor 0.03，合计封顶降到 0.40：
//      三个中度叠加 = 0.36 < 0.40（满足「三个中度也不该有 50%」）；
//      只有含重大事件（战争级别）才可能触及 40% 上限。
//      ratio 校验：moderate/major = 0.30 → 中度只是重大权重的 3 成，符合量级直觉。
function defaultConfig() {
  return {
    // ★ 20260921l：version 从 '20260914i' → '20260921l'，用于触发 loadConfig() 的配置迁移，
    //   把磁盘 config.json 里 minor.decayShortDays 的旧值 3 强制刷成新值（原油 1 天）。
    //   ⚠️ 只改 gradeRanges 而不升 version → 磁盘旧值会继续覆盖代码默认值，改动静默失效。
    version: '20260921l',
    engineVersion: ENGINE_VERSION,
    gradeRanges: {
      major: { fixedWeightShort: 0.40, fixedWeightLong: 0.40, decayShortDays: 225, decayLongDays: 730 },
      moderate: { fixedWeightShort: 0.12, fixedWeightLong: 0.12, decayShortDays: 105, decayLongDays: 548 },
      minor: { fixedWeightShort: 0.03, fixedWeightLong: 0.0, decayShortDays: OIL_DECAY_DAYS, decayLongDays: 0 },
    },
    severity: {
      maxPerDim: 3,
      gradeThresholds: { major: 11, moderate: 7, minor: 3 },
      minConfidence: 0.6,
      // 类型硬上限：即使评分卡波动，也绝不允许越级（杜绝「研报观点=重大」）
      // ★ 20260914i：macro_policy 从 'major' 降为 'moderate'。
      //   产业/消费类政策（如智能家居消费行动方案）属常规部门政策，不是战争级别事件，
      //   不应与 geo_disaster（地缘冲突/战争）同级。真正的重大留给 geo_disaster / industry_supply 断供级。
      typeCeiling: {
        research_opinion: 'minor',
        company_event: 'moderate',
        routine_monetary_policy: 'moderate',
        industry_supply: 'major',
        macro_policy: 'moderate',
        consumption_policy: 'moderate',
        geo_disaster: 'major',
      },
    },
    models: {
      localTriage: true,       // T2 本地模型定性（零联网费）
      webVerify: true,         // T3 联网核查（预期差/已定价/官方证实）
      webDailyCap: 20,         // 联网每日调用上限
      forumHeat: true,         // T3.5 论坛热度印证（东财股吧/同花顺/雪球/新浪财经）
      heatDailyCap: 30,        // 热度核查每日调用上限
      maxCandidatesPerScan: 8, // 单次扫描最多送模型判定的候选数
      requireConfirmForMajor: true, // 重大需人工确认才生效
    },
    sectorImportance: { '银行': 2, '证券': 2, '保险': 2, '房地产': 2, '石油石化': 2, '煤炭': 2, '有色金属': 2, '国防军工': 2 },
    defaultSectorImportance: 1,
    // ★ 20260914i：合计封顶 0.50 → 0.40。三个中度叠加(0.36)不触顶，只有含重大事件才可能接近。
    maxCombinedEventWeight: 0.4,
  };
}
function loadConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return defaultConfig(); }
  // ★ 20260914i 配置迁移：data/events/config.json 一旦存在就会**整体覆盖** defaultConfig()，
  //   导致代码里改的权重/阈值对生效配置无效（用户曾遇到「改了代码重启还是旧权重」的隐性坑）。
  //   这里用版本号兜底：磁盘配置版本落后于代码 → 只强制刷新「分级权重 / 类型上限 / 合计封顶」
  //   这三组结构性配置，其余用户自定义项（models/sectorImportance 等）保留。
  const def = defaultConfig();
  if (cfg.version !== def.version) {
    cfg.gradeRanges = def.gradeRanges;
    cfg.severity = Object.assign({}, cfg.severity || {}, def.severity);
    cfg.maxCombinedEventWeight = def.maxCombinedEventWeight;
    cfg.version = def.version;
    saveConfig(cfg);
  }
  return cfg;
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); return cfg; }
  catch (e) { return loadConfig(); }
}
function updateConfig(patch) { return saveConfig(deepMerge(loadConfig(), patch || {})); }

// ===== 自选股 =====
function readWatchlist() {
  try { const a = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function resolveWatchlist() {
  return readWatchlist().map(w => {
    const name = (w.name || '').trim();
    let sector = '';
    for (const m of NEWS_SECTOR_MAP) { if (m.hotStocks && m.hotStocks.includes(name)) { sector = m.sector; break; } }
    if (!sector) sector = STOCK_SECTOR_OVERRIDE[name] || '';
    return { symbol: w.symbol, name, sector };
  });
}

// ===== 事件库 IO =====
function ensureDir() { if (!fs.existsSync(EVENTS_DIR)) fs.mkdirSync(EVENTS_DIR, { recursive: true }); }
function _read(f, fallback) {
  ensureDir();
  try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) ? a : fallback; }
  catch (e) { return fallback; }
}
function _write(f, data) { ensureDir(); fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8'); }
function loadActive() { return _read(ACTIVE_FILE, []); }
function saveActive(a) { _write(ACTIVE_FILE, a); }
function loadHistory() { return _read(HISTORY_FILE, []); }
function saveHistory(a) { _write(HISTORY_FILE, a.slice(0, 200)); }
function loadAudit() { return _read(AUDIT_FILE, []); }
function saveAudit(a) { _write(AUDIT_FILE, a.slice(0, 100)); }
function loadState() {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) { ensureDir(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); }

// ===== 工具 =====
function eventId(sector, signal) {
  const dir = signal > 0 ? 'up' : (signal < 0 ? 'down' : 'neu');
  return `evt_${sector}_${dir}`;
}
function gradeLabel(g) { return g === 'major' ? '重大' : g === 'moderate' ? '中度' : g === 'minor' ? '轻微' : '无'; }
function dirLabel(s) { return s > 0 ? '利好' : s < 0 ? '利空' : '中性'; }
function dirArrow(s) { return s > 0 ? '▲' : s < 0 ? '▼' : '—'; }
function round(x, n) { const p = Math.pow(10, n || 3); return Math.round(x * p) / p; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch || {})) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], patch[k]);
    } else out[k] = patch[k];
  }
  return out;
}
function effectiveWeight(base, days, createdAt, now) {
  if (!base || !days || days <= 0) return 0;
  const elapsed = now - createdAt;
  if (elapsed <= 0) return base;
  const r = elapsed / (days * DAY);
  if (r >= 1) return 0;
  return base * (1 - r);
}
function isExpired(e, now) {
  const c = new Date(e.createdAt || now).getTime();
  return effectiveWeight(e.weightShort, e.decayShortDays, c, now) <= 0
    && effectiveWeight(e.weightLong, e.decayLongDays, c, now) <= 0;
}

// ===== 原油主连冲击（突发因子·轻微事件变量，20260911；参考对象由布伦特原油期货改为原油主连）=====
// 板块归属解析：优先 NEWS_SECTOR_MAP/STOCK_SECTOR_OVERRIDE，缺失时按名称兜底
function resolveSectorForSymbol(symbol) {
  const wl = resolveWatchlist();
  const w = wl.find(x => x.symbol === symbol);
  return w ? (w.sector || '') : '';
}
function isOilSectorStock(symbol) {
  if (resolveSectorForSymbol(symbol) === '石油石化') return true;
  const w = readWatchlist().find(x => x.symbol === symbol);
  const name = (w && w.name) || '';
  return /石油|原油|海油|中石化|中石油/.test(name);
}

// 东方财富·原油主连(142.scm) / 新浪 nf_SC0：上期能源 INE 中质含硫原油主力连续合约，人民币计价
// 20260921l：取数已改为多通道（新浪为主，东财 push2delay 兜底），见 _fetchCrudeLive()。
// ⚠️ 20260921l：本机 push2delay 族已被对端掐断（实测 socket hang up，偶发成功≈1/15），
//   曾导致缓存里留下一个「偏低 6 元 + 昨收偏低」的幸运命中值（707/728 → -6.28%），
//   而同期真实值应为 713.3/730.8 → -2.39%（甚至低于 3% 触发线，本不该触发）。
//   → 保留为兜底通道，主力改为新浪 nf_SC0。
async function _fetchCrudeEM() {
  try {
    const r = await axios.get('https://push2delay.eastmoney.com/api/qt/stock/get?secid=142.scm&fields=f43,f60,f170', {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
      timeout: 12000,
    });
    const d = r.data && r.data.data;
    if (!d || typeof d.f43 !== 'number' || typeof d.f60 !== 'number') return null;
    const price = d.f43 / 10;
    const prevClose = d.f60 / 10;
    const chgPct = typeof d.f170 === 'number' ? d.f170 / 100 : ((price - prevClose) / prevClose * 100);
    if (!price || !prevClose) return null;
    return { price, prevClose, chgPct: round(chgPct, 3), symbol: '142.scm', source: '东方财富·原油主连(142.scm)', via: 'eastmoney' };
  } catch (e) { return null; }
}

// 新浪·上海原油连续(nf_SC0)：INE 原油主力连续合约，与东财 142.scm 同标的、人民币计价
// 字段（HC 为 GBK）：f[0]名称 f[1]时间HHMMSS f[2]开 f[3]高 f[4]低 f[6]买 f[8]最新
//                    f[10]昨结算 f[13]持仓 f[14]成交量 f[17]日期 f[27]均价
// ⚠️ 期货用「昨结算」作涨跌幅基准（非昨收），与东财 f60 口径一致。
// 响应是 GBK 且无 Content-Type 声明 → 必须按 latin1 收字节再转 gbk，否则中文名乱码。
async function _fetchCrudeSina() {
  try {
    const r = await axios.get('https://hq.sinajs.cn/list=nf_SC0', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://finance.sina.com.cn/futuremarket/',
      },
      timeout: 10000,
      responseType: 'arraybuffer', // 拿原始字节自行按 GBK 解，别让 axios 按 utf8 猜
    });
    const buf = Buffer.from(r.data);
    const txt = buf.toString('latin1'); // 先按 latin1 保字节
    const m = txt.match(/"([^"]*)"/);
    if (!m) return null;
    const f = m[1].split(',');
    const numAt = (i) => { const v = parseFloat(f[i]); return Number.isFinite(v) ? v : null; };
    const price = numAt(8) || numAt(6);      // 最新价（盘中无成交时退回买价）
    const prevClose = numAt(10);             // 昨结算
    const quoteDate = f[17] || '';
    const quoteTime = f[1] || '';
    if (!price || !prevClose) return null;
    const chgPct = (price - prevClose) / prevClose * 100;
    // ⚠️ 坑（20260921l 实测踩到）：Node 的 Buffer.toString('gbk') 在本机 **不可用**
    //   —— 抛 `Unknown encoding: gbk`（该构建未带 full-icu 的 GBK 解码器）。
    //   名称字段只是展示用，绝不能因为解码失败就丢掉整条行情 → 用 try/catch 兜住，
    //   失败则退回「上海原油连续」这个已知常量名。
    let name = '上海原油连续';
    try { name = Buffer.from(f[0] || name, 'latin1').toString('gbk'); }
    catch (e) { /* 无 GBK 解码器 → 保留默认名 */ }
    return {
      price, prevClose, chgPct: round(chgPct, 3), symbol: 'nf_SC0',
      source: `新浪·${name}(nf_SC0)`, via: 'sina',
      quoteDate, quoteTime, open: numAt(2), high: numAt(3), low: numAt(4),
    };
  } catch (e) {
    console.warn('[eventEngine] 新浪原油取数失败:', e && e.message);
    return null;
  }
}

// 统一取数：新浪为主（本机可用），东财 push2delay 为兜底
async function _fetchCrudeLive() {
  const s = await _fetchCrudeSina();
  if (s && typeof s.chgPct === 'number') return s;
  const e = await _fetchCrudeEM();
  if (e && typeof e.chgPct === 'number') return e;
  return null;
}

// 合理性校验（20260921l）：原油单日涨跌幅极少超过 ±15%（2020 负油价级别）；
// 若缓存值与新值差异过大，倾向采信新值并记 warning，避免"坏值长期霸占缓存"。
// 另：报价日期须是近 5 个自然日内，否则视为陈旧。
function _isOilQuoteFresh(rec) {
  if (!rec) return false;
  if (rec.quoteDate) {
    const t = Date.parse(rec.quoteDate + 'T00:00:00+08:00');
    if (Number.isFinite(t) && (Date.now() - t) > 5 * DAY) return false;
  }
  return true;
}

function _readOilShockSeed() {
  try { return JSON.parse(fs.readFileSync(OIL_SHOCK_FILE, 'utf8')); } catch (e) { return null; }
}
function _loadOilCache() { const st = loadState(); return st.oilShock || null; }
function _saveOilCache(rec) { const st = loadState(); st.oilShock = rec; saveState(st); }

// 实时刷新原油主连涨跌幅（异步，由 scanEvents / API 触发）；失败则退回手动/web抓取注入
// 20260921l：校验缓存是否「陈旧」——旧实现仅看 fetchedAt + TTL，浏览器/服务重启后
//   仍可能复用一个偏低/偏高的坏值，导致卡片长期显示错误涨跌幅。改为：
//   ① 报价日期超 5 天 → 视为陈旧，强制重取；
//   ② 即使未过期，若新值取到且与缓存值差异 > 1.5pp，也采信新值（并打印 warning）。
const OIL_STALE_PP = 1.5; // 新旧涨跌幅差异阈值（百分点）
async function refreshCrudeShock(force) {
  const c = _loadOilCache();
  const fresh = c && c.fetchedAt && (Date.now() - Date.parse(c.fetchedAt)) < OIL_TTL_MS
    && typeof c.chgPct === 'number' && _isOilQuoteFresh(c);

  let live = await _fetchCrudeLive();
  if (live && typeof live.chgPct === 'number') {
    // 缓存未过期且新旧差异不大 → 沿用缓存（省一次请求的抖动）
    if (!force && fresh && Math.abs(live.chgPct - c.chgPct) <= OIL_STALE_PP) return c;
    if (fresh && Math.abs(live.chgPct - c.chgPct) > OIL_STALE_PP) {
      console.warn(`[eventEngine] 原油主连缓存值 ${c.chgPct}% 与实时值 ${live.chgPct}% 差异 ${Math.abs(live.chgPct - c.chgPct).toFixed(2)}pp（缓存来源 ${c.via || '?'}/${c.source || '?'}），采信实时值`);
    }
    live.fetchedAt = new Date().toISOString();
    _saveOilCache(live);
    return live;
  }
  // 取数失败：缓存若仍新鲜可用则沿用，否则退回种子
  if (!force && fresh) return c;
  const seed = _readOilShockSeed();
  if (seed && typeof seed.chgPct === 'number') {
    const rec = { price: seed.price, prevClose: seed.prevClose, chgPct: num(seed.chgPct), symbol: seed.symbol || 'seed', source: seed.source || '手动/web抓取注入', fetchedAt: new Date().toISOString(), via: 'seed' };
    _saveOilCache(rec); return rec;
  }
  return c || null;
}

// 同步读取当前缓存的原油主连冲击事件（供 buildEventOverride 在短期口径注入；不联网）
// 返回与 getEventsForSymbol 输出兼容的合成事件对象；未触发/缓存缺失 → null
function buildCrudeShockEvent(symbol, horizon) {
  if (horizon !== 'short') return null; // 用户限定：仅短期判断口径生效
  const oil = _loadOilCache();
  if (!oil || typeof oil.chgPct !== 'number') return null;
  const chg = oil.chgPct;
  if (Math.abs(chg) <= OIL_TRIGGER_PCT) return null; // 3% 硬阈值
  const oilUp = chg > 0;
  const oilSector = isOilSectorStock(symbol);
  // 石油板块正相关；其余负相关（油价↑→美联储加息预期↑→全球股指↓，反之亦然）
  const signal = oilSector ? (oilUp ? 1 : -1) : (oilUp ? -1 : 1);
  const weight = round(Math.min(OIL_MAX_WEIGHT, Math.abs(chg) * OIL_WEIGHT_PER_PCT), 4);
  const dirWord = oilUp ? '上涨' : '下跌';
  const corrWord = oilSector ? '正相关' : '负相关';
  const rationale = oilUp
    ? '油价上涨→推升美联储加息预期→对全球股指形成压制（非石油板块利空/石油板块利好）。'
    : '油价下跌→缓解美联储加息预期→对全球股指形成支撑（非石油板块利好/石油板块利空）。';
  return {
    id: 'evt_oil_main',
    title: `原油主连单日${dirWord}${Math.abs(chg).toFixed(1)}%（>3%·${corrWord}）`,
    sector: '原油(主连)',
    signal, grade: 'minor',
    effWeight: weight, weightShort: weight, weightLong: 0,
    decayShortDays: OIL_DECAY_DAYS, decayLongDays: 0, remainingDays: OIL_DECAY_DAYS,
    source: oil.source || 'Crude oil main continuous', via: oil.via, chgPct: chg,
    isSynthetic: true, reason: rationale, oilSector,
    // 附上取数时的报价日期，便于前端/接口核对"这条冲击对应哪一天的行情"
    quoteDate: oil.quoteDate || null, quoteTime: oil.quoteTime || null,
  };
}
function getOilShockStatus() {
  const oil = _loadOilCache();
  return {
    cached: !!oil,
    chgPct: oil ? oil.chgPct : null,
    price: oil ? oil.price : null,
    prevClose: oil ? oil.prevClose : null,
    source: oil ? oil.source : null,
    via: oil ? oil.via : null,
    fetchedAt: oil ? oil.fetchedAt : null,
    triggered: oil ? Math.abs(oil.chgPct) > OIL_TRIGGER_PCT : false,
    triggerPct: OIL_TRIGGER_PCT,
    maxWeight: OIL_MAX_WEIGHT,
    weightPerPct: OIL_WEIGHT_PER_PCT,
  };
}

// 展示摘要：逐条列出每起事件，多空并存时不合并（方向抵消也要让人看见）
function summarizeEvents(events, combined, aggSignal) {
  const sorted = events.slice().sort((a, b) => b.signal - a.signal);
  const tags = sorted.map(e => `${e.sector}${dirArrow(e.signal)}${gradeLabel(e.grade)}`);
  let s = tags.slice(0, 3).join(' ｜ ');
  if (tags.length > 3) s += ` 等${tags.length}起`;
  const pct = (combined * 100).toFixed(1);
  const nUp = sorted.filter(e => e.signal > 0).length;
  const nDown = sorted.filter(e => e.signal < 0).length;
  if (nUp > 0 && nDown > 0) return `${s} · 合计${pct}%（多空并存·净${dirLabel(aggSignal)}）`;
  return `${s} · 合计${pct}%（${dirLabel(aggSignal)}）`;
}

// ===== T1 规则硬闸门 =====
function classifyByRule(text) {
  if (RE_MARKET_RECAP.test(text)) return { kind: 'market_recap', reject: true };
  if (RE_DAILY_LIQUIDITY.test(text)) return { kind: 'daily_liquidity_op', reject: true };
  if (RE_ROUTINE_MONETARY.test(text)) return { kind: 'routine_monetary_policy', reject: false, ceiling: 'moderate' };
  if (RE_ROUTINE_REAFFIRM.test(text)) return { kind: 'routine_reaffirm', reject: false, ceiling: 'minor' }; // 20261021j A2
  if (RE_RESEARCH.test(text)) return { kind: 'research_opinion', reject: false };
  return { kind: 'candidate', reject: false };
}

// 模型未必严格按 schema 输出（实测会返回 is_exogenous / score 等变体），这里做字段归一化
const SEV_DIMS = ['scope', 'persistence', 'intensity', 'surprise', 'authority'];
function normalizeVerdict(v) {
  const raw = v || {};
  let isEvent = null;
  for (const k of ['isEvent', 'is_event', 'isExogenous', 'is_exogenous']) {
    if (raw[k] != null) { isEvent = !!raw[k]; break; }
  }
  const out = { isEvent, type: String(raw.type || '').trim(), confidence: num(raw.confidence), reason: String(raw.reason || '') };
  for (const d of SEV_DIMS) out[d] = raw[d] != null ? num(raw[d]) : null;
  // 只给总分时按均分回填五维（保守估算）
  if (raw.score != null && SEV_DIMS.every(d => raw[d] == null)) {
    const per = Math.min(3, Math.round(num(raw.score) / SEV_DIMS.length));
    for (const d of SEV_DIMS) out[d] = per;
  }
  for (const d of SEV_DIMS) if (out[d] == null) out[d] = 0;
  return out;
}

// ===== T2 本地模型定性 =====
function parseJsonLoose(content) {
  if (!content) return null;
  let s = String(content).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const m = s.match(/\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}
async function llmTriage(candidates, cfg) {
  const out = {};
  if (!candidates.length || !cfg.models.localTriage) return out;
  let aiCfg;
  try { aiCfg = loadAICfg(); } catch (e) { return out; }
  if (!aiCfg || !aiCfg.apiKey) return out;
  let systemPrompt = '你是A股事件驱动定性分析器，只输出JSON数组。';
  try { systemPrompt = loadPromptFile('event-triage-system.md') || systemPrompt; } catch (e) {}
  const payload = candidates.map((c, i) => ({ id: String(i), title: c.title, summary: (c.summary || '').slice(0, 200) }));
  try {
    const pick = pickModelFor(aiCfg, 'local');
    // thinking 模型带长提示词推理很慢，超时必须放宽（默认 60s 会直接超时 → 全部不认）
    const content = await callLLM(aiCfg.provider, aiCfg.apiKey, pick.model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `请逐条判断以下快讯是否构成外生事件并评分，只输出JSON数组：\n${JSON.stringify(payload)}` },
    ], { webSearch: pick.webSearch, timeoutMs: (cfg.models.triageTimeoutMs || 180000) });
    const parsed = parseJsonLoose(content);
    // 兼容：直接数组 / {results|items|events|data:[...]} / 单对象
    let arr = [];
    if (Array.isArray(parsed)) arr = parsed;
    else if (parsed && typeof parsed === 'object') {
      for (const k of ['results', 'items', 'events', 'data', 'list']) {
        if (Array.isArray(parsed[k])) { arr = parsed[k]; break; }
      }
      if (!arr.length) arr = [parsed];
    }
    arr.forEach((a, idx) => {
      if (!a || typeof a !== 'object') return;
      // 模型漏 id 时按下标兜底（payload 顺序即候选顺序）
      const key = (a.id != null && a.id !== '') ? String(a.id) : String(idx);
      out[key] = a;
    });
    if (!Object.keys(out).length) console.warn('[eventEngine] T2 无有效判定，原始返回:', String(content).slice(0, 300));
  } catch (e) {
    console.warn('[eventEngine] T2 本地模型定性失败:', e && e.message);
  }
  return out;
}

// ===== T3 联网核查（预期差 / 已定价 / 官方证实）=====
function webUsageToday() {
  const st = loadState();
  const today = localDate();
  return (st.webDate === today) ? (st.webCount || 0) : 0;
}
function bumpWebUsage() {
  const st = loadState();
  const today = localDate();
  st.webDate = today;
  st.webCount = (st.webDate === today ? (st.webCount || 0) : 0) + 1;
  saveState(st);
}
function heatUsageToday() {
  const st = loadState();
  const today = localDate();
  return (st.heatDate === today) ? (st.heatCount || 0) : 0;
}
function bumpHeatUsage() {
  const st = loadState();
  const today = localDate();
  st.heatDate = today;
  st.heatCount = (st.heatDate === today ? (st.heatCount || 0) : 0) + 1;
  saveState(st);
}

// ===== T3.5 论坛热度印证（用户 20260907h 校准：上东财股吧/同花顺/雪球/新浪财经看讨论热度，热度越高权重越高）=====
async function forumHeat(title, cfg) {
  if (!cfg.models.forumHeat) return null;
  if (heatUsageToday() >= (cfg.models.heatDailyCap || 30)) return null;
  let aiCfg;
  try { aiCfg = loadAICfg(); } catch (e) { return null; }
  if (!aiCfg || !aiCfg.apiKey) return null;
  try {
    bumpHeatUsage();
    const pick = pickModelFor(aiCfg, 'web');
    const content = await callLLM(aiCfg.provider, aiCfg.apiKey, pick.model, [
      { role: 'system', content: '你是财经社区讨论热度评估助手，只输出JSON。' },
      { role: 'user', content: '在东方财富股吧、同花顺、雪球、新浪财经这四个财经论坛/社区搜索下面这条快讯的关键词，评估它的讨论热度：\n0=几乎无人讨论（各论坛基本搜不到相关讨论帖）\n1=少量讨论（只有零星几帖，回应很少）\n2=有一定热度（多个论坛有讨论帖，有实质回帖）\n3=热议（大量帖子、高阅读量高评论量，甚至置顶/热榜）\n只输出 {"heat":0-3,"note":"20字内，写哪些论坛有讨论"}。\n快讯：' + title },
    ], { webSearch: pick.webSearch, timeoutMs: 90000 });
    const p = parseJsonLoose(content);
    if (!p || typeof p.heat !== 'number') return null;
    return { heat: Math.max(0, Math.min(3, Math.round(p.heat))), note: String(p.note || '').slice(0, 40), checkedAt: new Date().toISOString() };
  } catch (e) { return null; }
}
async function webVerify(title, cfg) {
  if (!cfg.models.webVerify) return null;
  if (webUsageToday() >= (cfg.models.webDailyCap || 20)) return null;
  let aiCfg;
  try { aiCfg = loadAICfg(); } catch (e) { return null; }
  if (!aiCfg || !aiCfg.apiKey) return null;
  try {
    bumpWebUsage();
    const pick = pickModelFor(aiCfg, 'web');
    const content = await callLLM(aiCfg.provider, aiCfg.apiKey, pick.model, [
      { role: 'system', content: '你是A股事件核查助手，只输出JSON。' },
      { role: 'user', content: `针对这条快讯核查两点：1) 该事件此前是否已被市场预期或已消化（ pricedIn 0-1，1=完全已定价）；2) 是否有官方/权威渠道证实（confirmed true/false）。只输出 {"pricedIn":0-1,"confirmed":true/false,"note":"20字内"}。\n快讯：${title}` },
    ], { webSearch: pick.webSearch, timeoutMs: 60000 });
    const p = parseJsonLoose(content);
    return p || null;
  } catch (e) { return null; }
}

// 20261021j A3：自洽守卫——LLM 理由自己都说"常规/已有预期/强度有限"，评分却够中度以上 → 强制降一级。
//（用户报障实测：ETF 批复理由写「市场已有预期，强度有限」却打 8 分卡进中度；「嘴上说弱、手上打高分」不允许通过）
const RE_SELF_CONTRADICT = /常规|例行|已有预期|早有预期|意外度低|意外性低|强度有限|影响有限|渐进式|象征意义|象征性|边际影响有限/;

// ===== 评分卡 → 分级（含置信度闸门 + 类型硬上限；explicitCeiling 来自 T1 规则层，优先级最高）=====
function scoreToGrade(v, type, cfg, explicitCeiling) {
  const sev = cfg.severity || defaultConfig().severity;
  const total = num(v.scope) + num(v.persistence) + num(v.intensity) + num(v.surprise) + num(v.authority);
  const conf = num(v.confidence);
  if (conf < (sev.minConfidence || 0.6)) return { grade: 'none', total, confidence: conf, reason: 'confidence_low' };
  const t = sev.gradeThresholds || { major: 11, moderate: 7, minor: 3 };
  let grade = 'none';
  if (total >= t.major) grade = 'major';
  else if (total >= t.moderate) grade = 'moderate';
  else if (total >= t.minor) grade = 'minor';
  const ceiling = explicitCeiling || (sev.typeCeiling || {})[type] || 'major';
  const order = ['none', 'minor', 'moderate', 'major'];
  let capped = false;
  if (order.indexOf(grade) > order.indexOf(ceiling)) { grade = ceiling; capped = true; }
  // 20261021j A3：理由自洽守卫（在类型硬上限之后独立再过一遍——两层防线互不替代）
  let selfContradict = false;
  if (order.indexOf(grade) > order.indexOf('minor') && RE_SELF_CONTRADICT.test(String(v.reason || ''))) {
    grade = 'minor'; capped = true; selfContradict = true;
  }
  return { grade, total, confidence: conf, capped, selfContradict };
}

// ===== 扫描（T0→T4）=====
async function scanEvents(force) {
  const cfg = loadConfig();
  const watchlist = resolveWatchlist();
  const now = Date.now();
  // 20260911：事件扫描时同步刷新原油主连涨跌幅缓存（失败静默，不影响主流程）
  try { await refreshCrudeShock(); } catch (e) { console.warn('[eventEngine] 原油主连刷新失败:', e && e.message); }
  const audit = {
    scannedAt: new Date().toISOString(),
    totalNews: 0, rejectedRecap: 0, rejectedNoMatch: 0,
    candidates: 0, summaryMismatch: 0, llmNotEvent: 0, llmFailed: 0,
    gradeNone: 0, created: 0, updated: 0, expired: 0, pendingConfirm: 0, webChecks: 0,
    heatChecks: 0, heatAdjusted: 0,
  };

  let news = [];
  try { const d = await getHotNews(force); news = (d && d.items) || []; } catch (e) { news = []; }
  news = annotateNewsImpact(news); // 20261021j A1：annotateNewsImpact 内部已弃用错配摘要（方向判定层）
  audit.totalNews = news.length;

  // T1 规则硬闸门 + 自选股匹配
  const candidates = [];
  for (const n of news) {
    // 20261021j A1：错配摘要不进 LLM、不参与自选股匹配（与 newsSectorImpact 同一守卫函数，双处同源）
    let effSummary = String(n.summary || '');
    if (effSummary && !summaryMatchesTitle(n.title, effSummary)) { effSummary = ''; audit.summaryMismatch++; }
    const text = `${n.title || ''} ${effSummary}`;
    const rule = classifyByRule(text);
    if (rule.reject) { audit.rejectedRecap++; continue; } // 「果」→ 拒收
    const imp = n.impact;
    if (!imp || !imp.sector || imp.signal === 0) continue;
    const affected = matchWatchlist(imp.sector, imp.hotStocks, n.title, effSummary, watchlist);
    if (!affected.length) { audit.rejectedNoMatch++; continue; }
    candidates.push({ title: n.title, summary: effSummary, sector: imp.sector, signal: imp.signal, affected, ruleKind: rule.kind, ruleCeiling: rule.ceiling || null, url: n.url });
    if (candidates.length >= (cfg.models.maxCandidatesPerScan || 8)) break;
  }
  audit.candidates = candidates.length;

  // T2 本地模型定性
  const verdicts = await llmTriage(candidates, cfg);
  if (candidates.length && !Object.keys(verdicts).length) audit.llmFailed = candidates.length;

  // T3/T4 组装事件
  const groups = {};
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const raw = verdicts[String(i)];
    if (!raw) { audit.llmNotEvent++; continue; }
    const v = normalizeVerdict(raw);
    // isEvent 显式为 false → 不认；缺失则看是否给出了有效类型
    if (v.isEvent === false) { audit.llmNotEvent++; continue; }
    if (v.isEvent === null && !v.type) { audit.llmNotEvent++; continue; }
    let type = v.type || c.ruleKind;
    if (type === 'candidate') type = 'company_event';
    if (type === 'market_recap') { audit.llmNotEvent++; continue; }
    // ★ 20260921a：company_event（单一公司事件）只按「个股名出现在标题/摘要」匹配，
    //   不再广播到整个板块——避免「阳普医疗认证」这类个股利好误挂到同板块其他股（如圣湘生物）。
    const affectedFinal = (type === 'company_event')
      ? matchWatchlist(c.sector, c.hotStocks, c.title, c.summary, watchlist, { onlyNamed: true })
      : c.affected;
    const sc = scoreToGrade(v, type, cfg, c.ruleCeiling);
    if (sc.grade === 'none') { audit.gradeNone++; continue; }

    let grade = sc.grade;
    // T3：重大或低置信才联网核查是否已定价（控制额度）
    if ((grade === 'major' || sc.confidence < 0.7) && cfg.models.webVerify) {
      const wv = await webVerify(c.title, cfg);
      if (wv) {
        audit.webChecks++;
        const pricedIn = num(wv.pricedIn);
        if (pricedIn >= 0.7 || wv.confirmed === false) {
          const order = ['none', 'minor', 'moderate', 'major'];
          grade = order[Math.max(0, order.indexOf(grade) - 1)];
        }
      }
    }
    if (grade === 'none') { audit.gradeNone++; continue; }

    const id = eventId(c.sector, c.signal);
    if (!groups[id]) {
      groups[id] = { id, sector: c.sector, signal: c.signal, affected: new Set(), grade, type, score: sc.total, confidence: sc.confidence, reason: v.reason || '', title: c.title, sources: [], ruleCeiling: c.ruleCeiling || null };
    }
    const g = groups[id];
    affectedFinal.forEach(s => g.affected.add(s));
    // 取最高分级（同一板块+方向的多条新闻取最强）
    const order = ['none', 'minor', 'moderate', 'major'];
    if (order.indexOf(grade) > order.indexOf(g.grade)) { g.grade = grade; g.score = sc.total; g.confidence = sc.confidence; g.title = c.title; }
    if (c.url) g.sources.push(c.url);
  }

  // 载入现有活跃事件（v1 遗留事件直接废弃）
  let active = loadActive();
  const discarded = active.filter(e => e.engineVersion !== ENGINE_VERSION);
  active = active.filter(e => e.engineVersion === ENGINE_VERSION);
  if (discarded.length) audit.expired += discarded.length;
  const legacySymbols = [];
  for (const e of discarded) (e.affectedSymbols || []).forEach(s => legacySymbols.push(s));

  const createdIds = [], updatedIds = [];

  // T3.5 论坛热度印证（东财股吧/同花顺/雪球/新浪财经）：热度计入总分重算分级；0 热度降一级（无讨论≈可能是误报）；24h 内复用缓存
  for (const id of Object.keys(groups)) {
    const g = groups[id];
    if (!cfg.models.forumHeat) break;
    const exEv = active.find(e => e.id === id);
    const freshCache = exEv && exEv.heat && (now - Date.parse(exEv.heat.checkedAt) < DAY);
    let hv = freshCache ? exEv.heat : await forumHeat(g.title, cfg);
    if (hv) {
      audit.heatChecks++;
      const sev = cfg.severity || defaultConfig().severity;
      const t = sev.gradeThresholds || { major: 11, moderate: 7, minor: 3 };
      const order4 = ['none', 'minor', 'moderate', 'major'];
      const ceiling = g.ruleCeiling || (sev.typeCeiling || {})[g.type] || 'major';
      if (hv.heat === 0) {
        // 零热度：降一级（热度侧印证缺失，宁降勿升）
        const ni = Math.max(0, order4.indexOf(g.grade) - 1);
        if (order4[ni] !== g.grade) audit.heatAdjusted++;
        g.grade = order4[ni];
      } else {
        // 热度作为第六维计入总分，重算分级（硬上限仍生效）
        const total = (g.score || 0) + hv.heat;
        let ng = 'none';
        if (total >= t.major) ng = 'major';
        else if (total >= t.moderate) ng = 'moderate';
        else if (total >= t.minor) ng = 'minor';
        if (order4.indexOf(ng) > order4.indexOf(ceiling)) ng = ceiling;
        if (ng !== g.grade) audit.heatAdjusted++;
        g.grade = ng; g.score = total;
      }
      if (g.grade === 'none') g.drop = true; // 热度降为 none：不新建/已有则自然过期
    }
    g.heat = hv || (exEv && exEv.heat) || null;
  }

  for (const id of Object.keys(groups)) {
    const g = groups[id];
    const affected = [...g.affected];
    // 20260921a：company_event 经 name-only 后可能无 affected（如阳普医疗事件不匹配任何自选股）→ 不建事件
    if (!affected.length) continue;
    const existing = active.find(e => e.id === id);
    // 热度印证降为 none：置零权重走自然过期归档；未入库的组直接跳过
    if (g.drop) {
      if (existing && !isExpired(existing, now)) {
        existing.weightShort = 0; existing.weightLong = 0;
        audit.expired++;
      }
      continue;
    }
    const gr = cfg.gradeRanges[g.grade];
    if (existing && !isExpired(existing, now)) {
      existing.lastSeen = now;
      existing.newsCount = (existing.newsCount || 1) + 1;
      existing.affectedSymbols = [...new Set([...(existing.affectedSymbols || []), ...affected])];
      existing.title = g.title || existing.title;
      if (!existing.direction) existing.direction = g.signal > 0 ? 'up' : 'down';
      if (g.sources.length) existing.sources = [...new Set([...(existing.sources || []), ...g.sources])];
      if (g.heat && !existing.heat) existing.heat = g.heat;
      // 热度印证调整了分级：回写分级/评分/权重/衰减（权重再平衡随 getEventsForSymbol 立即生效）
      if (gr && g.grade !== existing.grade) {
        existing.grade = g.grade;
        existing.score = g.score;
        existing.weightShort = gr.fixedWeightShort; existing.weightLong = gr.fixedWeightLong;
        existing.decayShortDays = gr.decayShortDays; existing.decayLongDays = gr.decayLongDays;
        const cAt = Date.parse(existing.createdAt) || now;
        existing.decayShortEnd = new Date(cAt + gr.decayShortDays * DAY).toISOString();
        existing.decayLongEnd = new Date(cAt + gr.decayLongDays * DAY).toISOString();
      }
      updatedIds.push(id);
    } else {
      const createdAt = now;
      const needsConfirm = g.grade === 'major' && cfg.models.requireConfirmForMajor;
      active.push({
        id, title: g.title, sector: g.sector, signal: g.signal,
        direction: g.signal > 0 ? 'up' : 'down', type: g.type,
        grade: g.grade, score: g.score, confidence: g.confidence, reason: g.reason,
        affectedSymbols: affected,
        weightShort: gr.fixedWeightShort, weightLong: gr.fixedWeightLong,
        decayShortDays: gr.decayShortDays, decayLongDays: gr.decayLongDays,
        decayShortEnd: new Date(createdAt + gr.decayShortDays * DAY).toISOString(),
        decayLongEnd: new Date(createdAt + gr.decayLongDays * DAY).toISOString(),
        status: needsConfirm ? 'pending_confirm' : 'active',
        confirmed: !needsConfirm,
        paused: false, createdAt: new Date(createdAt).toISOString(), lastSeen: now,
        newsCount: 1, sources: [...new Set(g.sources)], engineVersion: ENGINE_VERSION,
        heat: g.heat || null,
      });
      createdIds.push(id);
      if (needsConfirm) audit.pendingConfirm++;
    }
  }
  audit.created = createdIds.length;
  audit.updated = updatedIds.length;

  // 过期清理（含被热度淘汰置零的事件）；受影响个股的当日判断必须作废（20260907i 修复：过期不等于无影响）
  const expired = active.filter(e => isExpired(e, now));
  active = active.filter(e => !isExpired(e, now));
  const expiredSymbols = [];
  if (expired.length) {
    const hist = loadHistory();
    for (const e of expired) {
      e.expiredAt = new Date().toISOString(); hist.unshift(e);
      (e.affectedSymbols || []).forEach(s => expiredSymbols.push(s));
    }
    saveHistory(hist);
    audit.expired += expired.length;
  }
  saveActive(active);

  const changedSymbols = [...new Set([
    ...createdIds.flatMap(id => (active.find(e => e.id === id) || {}).affectedSymbols || []),
    ...updatedIds.flatMap(id => (active.find(e => e.id === id) || {}).affectedSymbols || []),
    ...expiredSymbols,
    ...legacySymbols,
  ])];

  const al = loadAudit(); al.unshift(audit); saveAudit(al);
  return {
    ok: true, scannedAt: audit.scannedAt, audit,
    activeCount: active.length, created: createdIds, updated: updatedIds,
    changedSymbols, events: active,
  };
}

function matchWatchlist(sector, hotStocks, title, summary, watchlist, opts) {
  const onlyNamed = !!(opts && opts.onlyNamed);
  const out = new Set();
  for (const w of watchlist) {
    // onlyNamed：仅按「个股名出现在标题/摘要」匹配（单一公司事件不外溢到全板块）
    if (!onlyNamed && w.sector && w.sector === sector) out.add(w.symbol);
    else if (!onlyNamed && hotStocks && hotStocks.includes(w.name)) out.add(w.symbol);
    else if ((title && title.includes(w.name)) || (summary && summary.includes(w.name))) out.add(w.symbol);
  }
  return [...out];
}

// ===== 查询 =====
function getActiveEvents() { return loadActive(); }
function getEventsForSymbol(symbol, horizon) {
  const now = Date.now();
  const list = loadActive().filter(e =>
    (e.affectedSymbols || []).includes(symbol)
    && e.status === 'active'   // pending_confirm（未确认的重大）不参与权重
    && !e.paused);
  const events = [];
  for (const e of list) {
    const c = new Date(e.createdAt).getTime();
    const base = horizon === 'long' ? e.weightLong : e.weightShort;
    const days = horizon === 'long' ? e.decayLongDays : e.decayShortDays;
    const eff = effectiveWeight(base, days, c, now);
    if (eff <= 0 || e.signal === 0) continue;
    events.push({ ...e, effWeight: round(eff, 4), remainingDays: Math.max(0, Math.ceil((days * DAY - (now - c)) / DAY)) });
  }
  return events;
}

// ===== 内幕抢跑检查（事件驱动联动）=====
// 设计（用户 20260922 校正）：不再"只要大涨就纳入"，必须等个股/板块相关事件（利好/利空）出现才调用。
// 锚定事件出现时间（createdAt），回溯其之前 3 个交易日的累计涨跌幅：
//   若股价已沿事件方向提前反应（同向 且 幅度≥阈值）→ 判为"提前抢跑/已透支"，据此调整该事件预期。
//   利好透支 → 剩余上行动能耗尽 → 边际偏空；利空出尽 → 边际偏多（方向语义同原市场情绪子信号，20260901a 修正）。
// 合成事件（原油主连 isSynthetic）按"油价→股指"传导，与个股自身抢跑无关，直接跳过。
// 依赖调用方传入的 history（日K close 序列）；未传则跳过（不报错）。
function checkInsiderFrontRun(symbol, event, history) {
  const hist = Array.isArray(history) ? history : [];
  if (hist.length < 4) return { detected: false, reason: '历史不足' };
  if (event.isSynthetic || !event.createdAt) return { detected: false, reason: '非真实事件' };
  const anchorTs = Date.parse(event.createdAt);
  if (!anchorTs) return { detected: false, reason: '无事件时间' };
  const anchorDate = localDateFromTs(new Date(anchorTs));
  // 严格早于事件日的交易日，升序
  const prior = hist
    .filter(h => h && h.date && h.date < anchorDate)
    .map(h => ({ date: h.date, close: num(h.close) }))
    .filter(x => x.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (prior.length < 3) return { detected: false, reason: '事件前交易日不足3' };
  const win = prior.slice(-3); // 事件前最近 3 个交易日
  const base = win[0].close, last = win[2].close;
  const preChg = (last - base) / base * 100;
  const dir = event.signal > 0 ? 1 : (event.signal < 0 ? -1 : 0);
  if (dir === 0) return { detected: false, reason: '事件无方向' };
  const sameDir = (preChg > 0 && dir > 0) || (preChg < 0 && dir < 0);
  if (!sameDir) return { detected: false, preChg: round(preChg, 2), reason: '方向不一致' };
  const THRESHOLD = 2.5;
  if (Math.abs(preChg) < THRESHOLD) return { detected: false, preChg: round(preChg, 2), reason: '提前反应幅度不足' };
  // 保留率随抢跑幅度连续递减（与原口径一致）：抢 2.5%→0.875，5%→0.75，10%→0.5，15%→0.25，≥17%→封底0.15
  const retain = Math.max(0.15, 1 - Math.abs(preChg) / 20);
  const cutPct = round((1 - retain) * 100);
  const runDir = preChg >= 0 ? 1 : -1;
  const signal = round(-0.4 * runDir, 3);
  const tone = signal > 0 ? '利空出尽，边际偏多' : '利好透支，边际偏空';
  return { detected: true, preChg: round(preChg, 2), cutPct, signal, tone, anchorDate, windows: win.map(x => x.date) };
}

// ===== 事后市场反应核验（20261021j A4，用户口径："从这两天市场的动向看，事件算不上利好利空"）=====
// 事件出现后市场用脚投票：方向上没反应 → 降一级；连续两轮都没反应 / 反着走 → 中性化（signal=0）。
// 内幕抢跑只对有方向的事件生效，事件被中性化后，抢跑叙事自动消失。
// 证据 = 调用方传入的本股日K（不联网）；板块级事件由每只受影响股各自核验，结果记在事件 marketChecks[symbol]。
const MARKET_REACT_NO_MOVE_PCT = 1.0;   // |累计涨跌| < 1% 视为"市场没反应"
const MARKET_REACT_STAGE1_BARS = 2;     // 事件后满 2 个交易日做第一轮核验
const MARKET_REACT_STAGE2_BARS = 5;     // 满 5 个交易日做第二轮（仍无反应/反向 → 中性化）
const MARKET_REACT_ORDER = ['major', 'moderate', 'minor'];

function downgradeGradeOnce(g) {
  const i = MARKET_REACT_ORDER.indexOf(g);
  return (i >= 0 && i < MARKET_REACT_ORDER.length - 1) ? MARKET_REACT_ORDER[i + 1] : g;
}

// 纯函数：按 stage 计算事件后市场反应。返回 null=证据不足（本轮不核）；
// 否则 { verdict, reactionPct, baseDate, lastDate, barsUsed, anchorDate }，
// verdict: 'confirm'（同向且 ≥ 阈值）| 'no_reaction'（|涨跌| < 阈值）| 'opposite'（反向 ≥ 阈值）
function evaluateMarketReaction(event, history, stage) {
  const hist = Array.isArray(history) ? history : [];
  if (hist.length < 4 || !event.createdAt) return null;
  const anchorDate = localDateFromTs(new Date(Date.parse(event.createdAt)));
  if (!anchorDate) return null;
  const sorted = hist.filter(h => h && h.date && num(h.close) > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
  const prior = sorted.filter(h => h.date < anchorDate);
  const post = sorted.filter(h => h.date >= anchorDate);
  if (!prior.length) return null;
  const need = stage === 2 ? MARKET_REACT_STAGE2_BARS : MARKET_REACT_STAGE1_BARS;
  if (post.length < need) return null; // 事件后交易日不足，证据未满，不核不臆造
  const base = num(prior[prior.length - 1].close);
  const last = num(post[need - 1].close);
  if (!(base > 0) || !(last > 0)) return null;
  const reactionPct = round((last - base) / base * 100, 2);
  const dir = event.signal > 0 ? 1 : (event.signal < 0 ? -1 : 0);
  if (dir === 0) return null;
  let verdict;
  if (Math.abs(reactionPct) < MARKET_REACT_NO_MOVE_PCT) verdict = 'no_reaction';
  else if ((reactionPct > 0 ? 1 : -1) === dir) verdict = 'confirm';
  else verdict = 'opposite';
  return { verdict, reactionPct, baseDate: prior[prior.length - 1].date, lastDate: post[need - 1].date, barsUsed: need, anchorDate };
}

// 纯函数：由 evaluate 结果构造持久化 patch（不落盘，单测友好）。返回 null=本轮不核/无需变更。
function buildMarketCheckPatch(event, symbol, history, nowTs) {
  if (event.isSynthetic || event.marketConfirmed || event.marketNeutralized) return null;
  if (event.signal === 0) return null;
  const checks = event.marketChecks || {};
  const prev = checks[symbol];
  const now = nowTs || Date.now();
  if (prev && (now - (prev.at || 0)) < DAY) return null; // 24h 节流
  const stage = (prev && prev.stage === 1) ? 2 : 1;
  const ev = evaluateMarketReaction(event, history, stage);
  if (!ev) return null;
  const rec = { stage, at: now, verdict: ev.verdict, reactionPct: ev.reactionPct, baseDate: ev.baseDate, lastDate: ev.lastDate };
  const patch = { marketChecks: { ...checks, [symbol]: rec } };
  if (ev.verdict === 'confirm') {
    patch.marketConfirmed = true;   // 终态：市场沿事件方向真动了，不再核
  } else if (ev.verdict === 'opposite' || stage === 2) {
    // 反向走 / 两轮都无反应 → 中性化：signal=0（getEventsForSymbol 与权重计算都会过滤掉）
    patch.signal = 0;
    patch.marketNeutralized = true; // 终态
    patch.marketNeutralNote = ev.verdict === 'opposite'
      ? `事件后 ${ev.barsUsed} 个交易日市场反向变动 ${ev.reactionPct}%，与事件方向相悖，判中性`
      : `事件后 ${ev.barsUsed} 个交易日市场累计仅 ${ev.reactionPct}%（无反应阈值 ${MARKET_REACT_NO_MOVE_PCT}%），两轮核验均无反应，判中性`;
  } else {
    // stage1 无反应 → 降一级（major→moderate→minor，封底 minor）
    const g = downgradeGradeOnce(event.grade);
    if (g && g !== event.grade) patch.grade = g;
    patch.marketDowngraded = true;
  }
  return { id: event.id, patch, record: rec };
}

// 落盘：把 buildMarketCheckPatch 的结果批量写回 active.json
function persistMarketChecks(updates) {
  if (!Array.isArray(updates) || !updates.length) return false;
  const active = loadActive();
  let changed = false;
  for (const u of updates) {
    const a = active.find(x => x.id === u.id);
    if (!a) continue;
    Object.assign(a, u.patch);
    changed = true;
  }
  if (changed) saveActive(active);
  return changed;
}

// ===== 股份回购事件（20261023i，用户要求：从「增持减持」卡片迁入「突发事件」）=====
// 权重按进度：回购提议（001 董事会预案 / 002 股东大会通过）→ 10%；
// 回购实施中（004）→ 30%；完成/停止/否决/历史 → 不构成事件（返回 null）。
// 信号沿用 buybackEmDc.gradeSignal：001=0.9 / 002=0.8 / 004=0.75×(1-进度%)。
function buildBuybackEvent(buyback, symbol) {
  const plan = (buyback && buyback.structured && buyback.plan) ? buyback.plan : null;
  if (!plan || plan.historical) return null;
  const code = String(plan.progressCode || '').trim();
  let weight = 0;
  if (code === '001' || code === '002') weight = 0.10;
  else if (code === '004') weight = 0.30;
  if (!weight) return null;
  const sig = (typeof plan.signal === 'number') ? plan.signal : 0;
  if (!sig) return null;
  const signal = Math.max(-1, Math.min(1, sig));
  const pureCode = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  return {
    id: 'buyback_' + pureCode,
    title: `股份回购（${plan.stage || (code === '004' ? '实施中' : '提议')}）`,
    type: 'company_event',
    sector: '股份回购',
    grade: code === '004' ? 'major' : 'moderate',
    signal,
    weightShort: weight,
    weightLong: weight,
    decayShortDays: 90,
    decayLongDays: 180,
    createdAt: plan.noticeDate || plan.updatedAt || new Date().toISOString(),
    affectedSymbols: [symbol],
    status: 'active',
    isSynthetic: true,
    effWeight: weight,
    remainingDays: 90,
    detail: buyback.text || '',
  };
}

// 构建权重覆盖 + 事件因子（无事件 → null → 权重 0，既有因子保持 100%）
function buildEventOverride({ symbol, baseWeights, factorKeys, horizon, history, buyback }) {
  let events = getEventsForSymbol(symbol, horizon);
  const cfg = loadConfig();
  // 20260911：原油主连冲击（突发因子·轻微事件变量，仅短期口径）；同步读取缓存，不联网
  const oilEvt = buildCrudeShockEvent(symbol, horizon);
  if (oilEvt) events.push(oilEvt);
  // 20261023i：股份回购事件（从增持减持卡片迁入，权重 提议10% / 实施中30%）
  const bbEvt = buildBuybackEvent(buyback, symbol);
  if (bbEvt) events.push(bbEvt);
  // 20261021j A4：事后市场反应核验（先核验、后计权——被中性化的事件当场出局）
  const mkUpdates = [];
  for (const e of events) {
    if (e.isSynthetic || e.signal === 0) continue;
    try {
      const u = buildMarketCheckPatch(e, symbol, history);
      if (u) { mkUpdates.push(u); Object.assign(e, u.patch); }
    } catch (err) { console.warn('[eventEngine] 单事件市场反应核验异常（跳过该事件）:', err && err.message); }
  }
  if (mkUpdates.length) { try { persistMarketChecks(mkUpdates); } catch (err) { console.warn('[eventEngine] 市场反应核验落盘失败（本次仅内存生效）:', err && err.message); } }
  events = events.filter(e => e.signal !== 0);
  if (!events.length) return null;
  // 内幕抢跑检查：仅对真实个股/板块事件（非合成）在事件出现时调用，回溯事件前 3 日涨跌幅。
  const frontRunParts = [];
  for (const e of events) {
    const fr = checkInsiderFrontRun(symbol, e, history);
    e.frontRun = fr;
    if (fr && fr.detected) {
      // 抢跑子信号权重 = 该事件有效权重 × 下调比例（与事件本身同方向计入，调整预期而非替代事件）
      frontRunParts.push({ eventId: e.id, signal: fr.signal, weight: e.effWeight * (fr.cutPct / 100) });
    }
  }
  const frontRunCount = frontRunParts.length;
  const sumEff = events.reduce((a, e) => a + e.effWeight, 0);
  let combined = Math.min(sumEff, cfg.maxCombinedEventWeight || 0.5);
  if (combined <= 0) return null;
  // 事件净信号 = 各事件按权重把「满格方向 ±1」计入（20261025i，用户要求「删除复杂的评分系统，
  // 直接用权重等于评分」：不再乘 0.47 这类信号强度折扣，使因子贡献分 ≈ 净方向权重，
  // 如回购 +30%、原油 -4% → 净 +26% ≈ +26 分）；内幕抢跑子信号保留原强度（-0.4 级），仅作预期微调。
  // 无抢跑时 frWeight=0，口径退化为纯方向加权（向后兼容字段结构）。
  const frWeight = frontRunParts.reduce((a, p) => a + p.weight, 0);
  const aggSignal = round(
    (events.reduce((a, e) => a + (e.signal > 0 ? 1 : -1) * e.effWeight, 0) + frontRunParts.reduce((a, p) => a + p.signal * p.weight, 0))
    / (sumEff + frWeight || 1), 3);
  const override = {};
  for (const k of factorKeys) {
    const base = baseWeights[k] != null ? baseWeights[k] : (1 / factorKeys.length);
    override[k] = round(base * (1 - combined), 4);
  }
  const nUp = events.filter(e => e.signal > 0).length;
  const nDown = events.filter(e => e.signal < 0).length;
  const mixed = nUp > 0 && nDown > 0;
  const subFactors = [];
  for (const e of events.slice().sort((a, b) => b.signal - a.signal)) {
    subFactors.push({
      key: 'evt_' + e.id,
      name: (e.title || '').slice(0, 26),
      signal: e.signal,
      // 20261025j：与其他因子统一为「因子内份额」口径——share = effWeight/sumEff（Σ≤1），
      // 前端显示 share×因子有效权重（数字与原绝对权重一致，如 0.30/0.36=83.3%×36%=+30%）；
      // 恒正，方向由 signal 承载，净权重=Σ(份额×eff×方向)。
      weight: round(e.effWeight / (sumEff || 1), 4),
      value: `${dirArrow(e.signal)}${dirLabel(e.signal)}·${e.sector}·${gradeLabel(e.grade)}·剩${e.remainingDays}天`,
      detail: e.detail || '',
    });
    // 内幕抢跑预警：仅事件触发，附在对应事件下，显示事件前 3 日提前反应与预期下调
    if (e.frontRun && e.frontRun.detected) {
      subFactors.push({
        key: 'evt_' + e.id + '_fr',
        name: '内幕抢跑预警',
        signal: e.frontRun.signal,
        value: `事件前3日${e.frontRun.preChg >= 0 ? '+' : ''}${e.frontRun.preChg}%，预期下调${e.frontRun.cutPct}%`,
        detail: `${e.frontRun.tone}（${e.frontRun.windows ? e.frontRun.windows.join(' / ') : ''}）`,
      });
    }
  }
  const eventFactor = {
    key: 'event', name: '事件驱动',
    weight: round(combined, 4), signal: aggSignal, applicable: true,
    value: summarizeEvents(events, combined, aggSignal),
    detail: `共 ${events.length} 起事件（利好${nUp}/利空${nDown}）影响本股（${horizon === 'long' ? '长期' : '短期'}口径），合计权重 ${(combined * 100).toFixed(1)}%${mixed ? '；多空并存，方向互相抵消为净' + dirLabel(aggSignal) : ''}${frontRunCount ? `；其中 ${frontRunCount} 起检测到内幕抢跑（事件前已提前反应），预期已相应下调` : ''}`,
    subFactors,
  };
  return { override, eventFactor, events, combinedWeight: combined, aggSignal, horizon };
}

// ===== 人工干预 =====
function confirmEvent(id) {
  const arr = loadActive();
  const e = arr.find(x => x.id === id);
  if (!e) return { ok: false, error: 'NOT_FOUND' };
  e.status = 'active'; e.confirmed = true; e.confirmedAt = new Date().toISOString();
  saveActive(arr);
  return { ok: true, event: e };
}
function setEventPaused(id, paused) {
  const arr = loadActive();
  const e = arr.find(x => x.id === id);
  if (!e) return { ok: false, error: 'NOT_FOUND' };
  e.paused = !!paused;
  e.status = e.paused ? 'paused' : 'active';
  saveActive(arr);
  return { ok: true, event: e };
}
function setEventGrade(id, grade) {
  const arr = loadActive();
  const e = arr.find(x => x.id === id);
  if (!e) return { ok: false, error: 'NOT_FOUND' };
  if (!['major', 'moderate', 'minor'].includes(grade)) return { ok: false, error: 'BAD_GRADE' };
  const cfg = loadConfig();
  const gr = cfg.gradeRanges[grade];
  e.grade = grade; e.weightShort = gr.fixedWeightShort; e.weightLong = gr.fixedWeightLong;
  e.decayShortDays = gr.decayShortDays; e.decayLongDays = gr.decayLongDays;
  const c = new Date(e.createdAt).getTime();
  e.decayShortEnd = new Date(c + gr.decayShortDays * DAY).toISOString();
  e.decayLongEnd = new Date(c + gr.decayLongDays * DAY).toISOString();
  saveActive(arr);
  return { ok: true, event: e };
}

module.exports = {
  loadConfig, saveConfig, defaultConfig, updateConfig,
  scanEvents, getActiveEvents, getEventsForSymbol, buildEventOverride, checkInsiderFrontRun,
  summaryMatchesTitlePass: summaryMatchesTitle, classifyByRule, scoreToGrade, evaluateMarketReaction, buildMarketCheckPatch, downgradeGradeOnce, MARKET_REACT_NO_MOVE_PCT, RE_SELF_CONTRADICT, RE_ROUTINE_REAFFIRM,
  confirmEvent, setEventPaused, setEventGrade,
  resolveWatchlist, loadAudit, classifyByRule, scoreToGrade,
  eventId, gradeLabel, dirLabel, dirArrow, effectiveWeight, summarizeEvents,
  ENGINE_VERSION, EVENTS_DIR,
  // 20260911：原油主连冲击（突发因子·轻微事件变量）
  refreshCrudeShock, getOilShockStatus, buildCrudeShockEvent,
  OIL_TRIGGER_PCT, OIL_MAX_WEIGHT, OIL_WEIGHT_PER_PCT, OIL_DECAY_DAYS,
  buildBuybackEvent, // 20261023i：股份回购事件（提议10% / 实施中30%）
};

~~~

---

## `lib\f10Status.js`  ·  218 行

~~~js
'use strict';
/**
 * lib/f10Status.js
 * 个股上市状态 / 风险警示（ST）历史证据层 —— 供策略回测的「幸存者偏差」修正使用。
 *
 * 背景（为什么需要）：
 *   lib/backtestValidator.js 的幸存者偏差系数原本硬编码 0.9（经验折扣），
 *   属于"拍脑袋"倍率。本模块提供**可验证的确定性证据**替换它。
 *
 * 数据来源（实测于 2026-10-14）：
 *   东方财富 F10 基础信息 RPT_F10_BASIC_ORGINFO —— 可达，字段含
 *     LISTING_DATE : 上市日期（'2007-03-01 00:00:00'）
 *     FORMERNAME   : 曾用名链，以 '→' 分隔（如 '中国服装→S中服→*ST中服→中国服装→*ST中服→中国服装'）
 *     SECURITY_NAME_ABBR : 现用简称
 *
 * 已被实测证实**不可达**的接口（诚实记录，不做虚假降级）：
 *   - RPT_TERMINATED_LIST（退市名单）     → 业务错误 9501
 *   - push2 clist 风险警示板（s:2048）    → ECONNRESET
 *   - push2 stock/get 停牌标记（f292）    → ECONNRESET
 *   故 ST 判定只依据 FORMERNAME 历史链 + 当前简称；停牌/退市日**取不到就不编**。
 *
 * 设计原则（与项目一致）：
 *   1. 确定性：一切结论由代码按明文规则推导，LLM 不参与。
 *   2. 诚实性：数据取不到时返回 null + 明确 reason，绝不臆造。
 *   3. 缓存：F10 基础信息变动极低频，落盘缓存默认 7 天，避免每次回测都打外部接口。
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'f10-status');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// ---------------------------------------------------------------------
//  纯函数：从 F10 原始字段推导状态（可单测，无 IO）
// ---------------------------------------------------------------------
/**
 * 判定风险警示历史。
 * 规则（明示，可审计）：
 *   - 名称含 '*ST'  → severe（退市风险警示）
 *   - 名称含 'ST'（不含 *ST）→ warn（其他风险警示）
 *   - 名称含 'S' 前缀（如 'S中服'、'S*ST'）→ 股改未完成标记，单独记录不计入 ST
 *   - 名称含 'N' 前缀（如 'N海天'）→ 上市首日标记，非风险警示，必须排除
 * @param {string} formerName 东财 FORMERNAME（'→' 分隔）
 * @param {string} currentName 当前简称
 * @returns {{stHistory:Array, sv:number, hasST:boolean, hasSevereST:boolean, severeCount:number, warnCount:number}}
 */
function parseRiskHistory(formerName, currentName) {
  const chain = [];
  if (currentName) chain.push(String(currentName).trim());
  if (formerName) {
    String(formerName).split('→').forEach(s => {
      const t = s.trim();
      if (t) chain.push(t);
    });
  }
  const stHistory = [];
  let severeCount = 0, warnCount = 0;
  for (const nm of chain) {
    // 先剔除 N（新股首日）/ C（上市次日）等非风险前缀的干扰：
    // 用「去掉前缀字母后是否仍含 ST」来判定，避免 'NSTxx' 这类误判
    const upper = nm.toUpperCase();
    const isSevere = upper.includes('*ST');
    // 含 ST 但不是 *ST；同时排除 'NST' 这种把 N 与 ST 连写的情况（东财未出现过，防御性处理）
    const isWarn = !isSevere && /(^|[^A-Z*])ST/.test(upper.replace(/^\*/, ''));
    if (isSevere) {
      severeCount++;
      stHistory.push({ name: nm, level: 'severe' });
    } else if (isWarn && !upper.startsWith('N')) {
      warnCount++;
      stHistory.push({ name: nm, level: 'warn' });
    }
  }
  const hadS = chain.some(nm => /^S[^A-Z]|^S\*ST|^SST/i.test(nm)) || chain.some(nm => /^S\*?ST/i.test(nm));
  // sv（survivorship 证据分）：有风险警示历史的个股，其"活下来"本身带幸存者属性，
  // 折扣应更保守。规则明示：无任何 ST 历史 → 1.0（无需折扣）；ST 历史 → 按次数递减。
  let sv = 1.0;
  if (severeCount > 0 || warnCount > 0) {
    const total = severeCount + warnCount;
    sv = Math.max(0.60, 0.90 - 0.05 * (total - 1));   // 1次→0.90, 2次→0.85, 3次→0.80 ... 下限 0.60
    if (severeCount > 0) sv = Math.max(0.60, sv - 0.05);   // 退市风险警示额外扣一档
  }
  return {
    stHistory,
    sv: +sv.toFixed(4),
    hasST: stHistory.length > 0,
    hasSevereST: severeCount > 0,
    severeCount,
    warnCount,
    hadShareReformTag: hadS,
  };
}

/**
 * 计算距今上市年数（用于识别"未满 3 年的次新股"，其回测样本天然偏短）。
 */
function listingYears(listingDate, now) {
  if (!listingDate) return null;
  const t = Date.parse(String(listingDate).replace(/-/g, '/'));
  if (!isFinite(t)) return null;
  const base = now ? now.getTime() : Date.now();
  return +((base - t) / (365.25 * 24 * 3600 * 1000)).toFixed(2);
}

// ---------------------------------------------------------------------
//  带缓存的取数
// ---------------------------------------------------------------------
function cacheFile(symbol) {
  return path.join(CACHE_DIR, String(symbol).replace(/[^\w]/g, '') + '.json');
}
function readCache(symbol) {
  try {
    const f = cacheFile(symbol);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || !j.fetchedAt) return null;
    if (Date.now() - j.fetchedAt > CACHE_TTL_MS) return null;   // 过期
    return j;
  } catch (_) { return null; }
}
function writeCache(symbol, payload) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(symbol), JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) { /* 缓存写入失败不影响主流程 */ }
}

/**
 * 拉取 F10 基础信息（带 7 天落盘缓存）。
 * @returns {Promise<object>} { ok, symbol, currentName, formerName, listingDate, source } 或
 *                            { ok:false, reason, detail }（诚实失败，不做假数据）
 */
async function fetchF10Basic(symbol) {
  const sym = String(symbol).replace(/^(sh|sz|bj)/i, '').trim();
  if (!/^\d{6}$/.test(sym)) return { ok: false, reason: 'invalid_symbol', detail: '需要一个 6 位 A 股代码' };

  const cached = readCache(sym);
  if (cached) return { ...cached.data, fromCache: true };

  try {
    const resp = await axios.get('https://datacenter-web.eastmoney.com/api/data/v1/get', {
      params: {
        reportName: 'RPT_F10_BASIC_ORGINFO',
        columns: 'SECURITY_CODE,SECURITY_NAME_ABBR,FORMERNAME,LISTING_DATE',
        filter: `(SECURITY_CODE="${sym}")`,
        pageSize: 1,
      },
      timeout: 12000,
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    const row = (resp.data && resp.data.result && resp.data.result.data && resp.data.result.data[0]) || null;
    if (!row) return { ok: false, reason: 'no_data', detail: '东财 F10 未返回该公司记录' };
    const data = {
      ok: true,
      symbol: sym,
      currentName: row.SECURITY_NAME_ABBR || null,
      formerName: row.FORMERNAME || null,
      listingDate: row.LISTING_DATE || null,
      source: '东方财富 F10 · RPT_F10_BASIC_ORGINFO',
    };
    writeCache(sym, { fetchedAt: Date.now(), data });
    return data;
  } catch (e) {
    const status = e.response ? 'HTTP ' + e.response.status : (e.code || e.message);
    return { ok: false, reason: 'fetch_failed', detail: '东财 F10 通道不可达（' + status + '）' };
  }
}

/**
 * 取个股上市状态 + 风险警示证据（回测幸存者偏差修正的主入口）。
 * @param {string} symbol
 * @param {object} [opts] { now: Date }
 * @returns {Promise<object>} 始终返回对象；取数失败时 { ok:false, reason, survivorship:null }
 *                            以便调用方**明确标注降级**，而不是静默用默认值。
 */
async function getListingStatus(symbol, opts) {
  opts = opts || {};
  const basic = await fetchF10Basic(symbol);
  if (!basic.ok) {
    return {
      ok: false,
      symbol: String(symbol),
      reason: basic.reason,
      detail: basic.detail,
      survivorship: null,
      note: '上市状态不可得，幸存者偏差沿用默认 0.9（未获证据支撑，回测结论需按此打折理解）',
    };
  }
  const risk = parseRiskHistory(basic.formerName, basic.currentName);
  const years = listingYears(basic.listingDate, opts.now);
  const out = {
    ok: true,
    symbol: basic.symbol,
    currentName: basic.currentName,
    formerName: basic.formerName,
    listingDate: basic.listingDate,
    listingYears: years,
    ...risk,
    source: basic.source,
    fromCache: !!basic.fromCache,
  };
  // 证据化说明
  const bits = [];
  if (risk.hasSevereST) bits.push(`曾 ${risk.severeCount} 次退市风险警示（*ST）`);
  if (risk.warnCount > 0) bits.push(`曾 ${risk.warnCount} 次其他风险警示（ST）`);
  if (!risk.hasST) bits.push('无风险警示历史');
  if (years != null) bits.push(`上市 ${years} 年`);
  out.evidence = bits.join('；');
  // 次新股提示：样本天然偏短，不构成"幸存者"，但需标注
  out.isNewListing = years != null && years < 3;
  if (out.isNewListing) out.evidence += '；上市未满 3 年（回测样本天然偏短）';
  out.survivorship = risk.sv;
  return out;
}

module.exports = { getListingStatus, fetchF10Basic, parseRiskHistory, listingYears };

~~~

---

## `lib\factStore.js`  ·  349 行

~~~js
/**
 * lib/factStore.js — 本地事实库（20260903f 降费改造核心）
 * ----------------------------------------------------------------
 * 背景：联网模型（modelWeb + enable_search）按次计费且价格高。研报总结 / 公告总结 /
 * 公司介绍 / 供应链分析这类任务的本质是「拿结构化事实做归纳推理」，事实本身可以从
 * 东财 / 巨潮的公开接口免费抓取，不需要模型联网。方案：
 *   1) 本模块预先抓取低频事实（研报列表 / 公告列表 / 公司概况 / 主营构成），
 *      存入 SQLite data_points 表，按数据类型设 TTL 鲜度；
 *   2) aiAugment 把事实组装成 prompt 上下文，交给不联网模型（modelLocal）纯推理；
 *   3) AI 结果缓存按「事实锚点」保鲜（事实没变就不重新分析），成本从
 *      「每次打开页面联网搜索」降为「事实变化才推理一次」。
 *
 * 存储键（data_points.key）：
 *   fact:research      近一年券商研报列表（东财 reportapi，TTL 7 天）
 *   fact:announcements 近一年公告列表（巨潮优先 / 东财兜底，TTL 1 天）
 *   fact:profile       公司概况（东财 F10 CompanySurvey，TTL 30 天）
 *   fact:segment       主营构成（东财 F10 MainOperate，TTL 90 天）
 *
 * 注意：deepAnalysis.js 在模块加载期反向 require aiAugment，若在此顶层 require
 * deepAnalysis 会形成循环依赖，因此对它使用函数体内惰性 require。
 */
const { upsertDataPoint, getDataPoint } = require('./db');
const { getCompanyProfile, toEMCode } = require('./shareholderData');
const { localDate, localCompact, localDateFromTs } = require('./localDate');

const DAY = 24 * 60 * 60 * 1000;
const FACT_TTL = {
  research: 7 * DAY,
  announcements: 1 * DAY,
  profile: 30 * DAY,
  segment: 90 * DAY,
};

// deepAnalysis 会在加载期 require aiAugment；为避免 aiAugment -> factStore -> deepAnalysis
// -> aiAugment 的循环依赖，这里只能运行期惰性加载。
function deep() {
  return require('./deepAnalysis');
}

// ---------- 通用读写 ----------

function readFact(symbol, key) {
  try {
    const dp = getDataPoint(symbol, key);
    if (!dp || !dp.valueText) return null;
    const parsed = JSON.parse(dp.valueText);
    return { ...parsed, fetchedAt: dp.fetchedAt, isFresh: !!dp.isFresh };
  } catch {
    return null;
  }
}

function saveFact(symbol, key, payload, ttlMs, source) {
  try {
    upsertDataPoint({
      symbol,
      key,
      value: null,
      valueText: JSON.stringify(payload),
      asOf: payload.asOf || null,
      source,
      validUntil: new Date(Date.now() + ttlMs).toISOString(),
      extra: payload.extra || null,
    });
  } catch (e) {
    console.error(`[factStore] save ${key} ${symbol} failed:`, e.message);
  }
}

// ---------- 研报事实（近一年券商研报列表）----------

async function getResearchFacts(symbol, { force } = {}) {
  if (!force) {
    const cached = readFact(symbol, 'fact:research');
    if (cached && cached.isFresh) return { ok: true, ...cached, fromCache: true };
  }
  let items = null;
  try {
    items = await deep().fetchResearchReports(symbol);
  } catch {}
  if (!items || !items.length) {
    // 抓取失败时若有过期缓存仍可用（陈旧事实好于没有）
    const stale = readFact(symbol, 'fact:research');
    if (stale) return { ok: true, ...stale, isFresh: false, staleServed: true };
    return { ok: false, reason: 'NO_DATA', message: '本地研报列表抓取失败或为空' };
  }
  const maxDate = items.reduce((m, r) => ((r.publishDate || '') > m ? r.publishDate : m), '');
  const payload = { asOf: maxDate || null, items, extra: { count: items.length, maxDate } };
  saveFact(symbol, 'fact:research', payload, FACT_TTL.research, 'eastmoney:reportapi');
  return { ok: true, ...payload, isFresh: true, fromCache: false };
}

function fmtYi(n) {
  const v = Number(n);
  if (!isFinite(v) || v === 0) return '';
  return (v / 1e8).toFixed(2);
}

// 组装研报事实的 prompt 上下文（供不联网模型推理）
function buildResearchContext(facts) {
  const items = facts.items || [];
  if (!items.length) return { ok: false, reason: 'EMPTY' };
  const lines = [];
  for (const r of items) {
    const parts = [
      r.publishDate || '',
      r.org || '',
      r.rating || '',
      r.targetPrice ? `目标价${r.targetPrice}元` : '',
      r.predictEps ? `预测EPS ${r.predictEps}` : '',
      r.predictPe ? `预测PE ${r.predictPe}` : '',
    ].filter(Boolean);
    lines.push(`- ${parts.join(' | ')}《${r.title || ''}》`);
  }
  const text = [
    `【本地研报列表】来源：东方财富研报接口（reportapi.eastmoney.com），共 ${items.length} 篇（近一年），最新一篇发布于 ${(facts.extra && facts.extra.maxDate) || '未知'}。每条格式：发布日期 | 机构 | 评级 | 目标价 | 预测EPS | 预测PE | 标题：`,
    ...lines,
  ].join('\n');
  return { ok: true, text, count: items.length, maxDate: (facts.extra && facts.extra.maxDate) || '', isFresh: facts.isFresh, staleServed: !!facts.staleServed, fetchedAt: facts.fetchedAt };
}

// ---------- 公告事实（近一年公告列表）----------

const ANNO_CATEGORY_LABEL = {
  increase: '股东增持',
  decrease: '股东减持',
  buyback: '股份回购',
  execChange: '高管/董事变动',
  csrcAction: '立案/处罚/监管',
  litigation: '诉讼/仲裁',
  other: '其他公告',
};
const ANNO_ORDER = ['increase', 'decrease', 'buyback', 'execChange', 'csrcAction', 'litigation', 'other'];

async function getAnnouncementFacts(symbol, stockName, { force } = {}) {
  if (!force) {
    const cached = readFact(symbol, 'fact:announcements');
    if (cached && cached.isFresh) return { ok: true, ...cached, fromCache: true };
  }
  let name = stockName;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof && prof.companyName;
    } catch {}
  }
  let data = null;
  try {
    data = await deep().fetchAnnouncements(symbol, name);
  } catch {}
  const items = data && Array.isArray(data.items) ? data.items : [];
  if (!items.length) {
    const stale = readFact(symbol, 'fact:announcements');
    if (stale) return { ok: true, ...stale, isFresh: false, staleServed: true };
    return { ok: false, reason: 'NO_DATA', message: '本地公告列表抓取失败或为空' };
  }
  const maxDate = items.reduce((m, a) => ((a.date || '') > m ? a.date : m), '');
  const payload = {
    asOf: maxDate || null,
    source: data.source || '',
    items,
    extra: { count: items.length, maxDate },
  };
  saveFact(symbol, 'fact:announcements', payload, FACT_TTL.announcements, `cninfo+eastmoney:${data.source || ''}`);
  return { ok: true, ...payload, isFresh: true, fromCache: false };
}

// 组装公告事实的 prompt 上下文：重要类别全列，其他类仅列近 10 条标题
function buildAnnouncementContext(facts) {
  const items = facts.items || [];
  if (!items.length) return { ok: false, reason: 'EMPTY' };
  const byCat = {};
  for (const a of items) {
    const c = a.category || 'other';
    (byCat[c] = byCat[c] || []).push(a);
  }
  const sections = [];
  for (const cat of ANNO_ORDER) {
    const arr = (byCat[cat] || []).slice().sort((x, y) => (y.date || '').localeCompare(x.date || ''));
    if (!arr.length) {
      sections.push(`【${ANNO_CATEGORY_LABEL[cat]}】无`);
      continue;
    }
    if (cat === 'other') {
      const top = arr.slice(0, 10);
      sections.push(`【${ANNO_CATEGORY_LABEL[cat]}】共 ${arr.length} 条，列出最近 ${top.length} 条：\n` + top.map(a => `- ${a.date || ''} ${a.title || ''}`).join('\n'));
      continue;
    }
    const lines = arr.slice(0, 15).map((a) => {
      const p = a.parsed || {};
      const fields = Object.entries(p)
        .filter(([, v]) => v !== '' && v != null)
        .map(([k, v]) => `${k}=${v}`)
        .join('，');
      return `- ${a.date || ''}《${a.title || ''}》${fields ? '（关键信息：' + fields + '）' : ''}`;
    });
    sections.push(`【${ANNO_CATEGORY_LABEL[cat]}】共 ${arr.length} 条：\n${lines.join('\n')}`);
  }
  const text = [
    `【本地公告列表】来源：${facts.source || '巨潮资讯网/东方财富'}，近一年共 ${items.length} 条，最新一条发布于 ${(facts.extra && facts.extra.maxDate) || '未知'}。公告分类由系统按标题自动归类，括号内关键数字为系统从公告全文正则提取（可能不全）：`,
    ...sections,
  ].join('\n\n');
  return { ok: true, text, count: items.length, maxDate: (facts.extra && facts.extra.maxDate) || '', isFresh: facts.isFresh, staleServed: !!facts.staleServed, fetchedAt: facts.fetchedAt };
}

// ---------- 公司概况事实（F10 CompanySurvey + 十大股东摘要）----------

async function getProfileFacts(symbol, { force } = {}) {
  if (!force) {
    const cached = readFact(symbol, 'fact:profile');
    if (cached && cached.isFresh) return { ok: true, ...cached, fromCache: true };
  }
  let prof = null;
  try {
    prof = await getCompanyProfile(symbol);
  } catch {}
  if (!prof || !prof.companyName) {
    const stale = readFact(symbol, 'fact:profile');
    if (stale) return { ok: true, ...stale, isFresh: false, staleServed: true };
    return { ok: false, reason: 'NO_DATA', message: '公司概况抓取失败' };
  }
  const today = localDate();
  const payload = { asOf: today, profile: prof, extra: { date: today } };
  saveFact(symbol, 'fact:profile', payload, FACT_TTL.profile, 'eastmoney:F10:CompanySurvey');
  return { ok: true, ...payload, isFresh: true, fromCache: false };
}

// ---------- 主营构成事实（F10 MainOperate，最新年报期）----------

async function getSegmentFacts(symbol, { force } = {}) {
  if (!force) {
    const cached = readFact(symbol, 'fact:segment');
    if (cached && cached.isFresh) return { ok: true, ...cached, fromCache: true };
  }
  const emCode = toEMCode(symbol);
  let seg = null;
  try {
    seg = emCode ? await deep().fetchSegmentData(emCode) : null;
  } catch {}
  if (!seg || !seg.years || !seg.years.length) {
    const stale = readFact(symbol, 'fact:segment');
    if (stale) return { ok: true, ...stale, isFresh: false, staleServed: true };
    return { ok: false, reason: 'NO_DATA', message: '主营构成抓取失败' };
  }
  const year = seg.years[seg.years.length - 1];
  const byYear = seg.byYear[year] || {};
  // 各维度取前 8 项，只保留 prompt 需要的精简字段
  const dims = {};
  for (const type of Object.keys(byYear)) {
    dims[type] = (byYear[type] || []).slice(0, 8).map(it => ({
      name: it.name,
      incomeYi: fmtYi(it.income),
      ratio: it.ratio,
      costRatio: it.costRatio,
      grossMargin: it.grossMargin,
    }));
  }
  const reportDate = (() => {
    for (const type of Object.keys(byYear)) {
      const arr = byYear[type] || [];
      if (arr.length) return arr[0].reportDate || '';
    }
    return '';
  })();
  const payload = { asOf: reportDate || null, year, dims, extra: { year, reportDate } };
  saveFact(symbol, 'fact:segment', payload, FACT_TTL.segment, 'eastmoney:F10:MainOperate');
  return { ok: true, ...payload, isFresh: true, fromCache: false };
}

// ---------- 公司事实上下文（概况 + 主营构成，供公司介绍/供应链本地分析）----------

async function buildCompanyFactsContext(symbol) {
  const [profileRes, segmentRes] = await Promise.all([
    getProfileFacts(symbol).catch(() => ({ ok: false })),
    getSegmentFacts(symbol).catch(() => ({ ok: false })),
  ]);
  if (!profileRes.ok) return { ok: false, reason: (profileRes.message) || 'NO_PROFILE' };
  const prof = profileRes.profile || {};
  const parts = [];
  const head = [
    // 20261016b 诚实性修正（审计 P2）：「企业性质」是按股东结构推断得来（shareholderData.js:466 inferOwnership），
    // 与东财 F10 权威登记口径不同源。旧文案把整块统一标为「东方财富 F10」，会让事实库把**推断值当权威值**
    // 喂给模型（违反数据一致性铁律）。此处显式标注推断属性，避免以讹传讹。
    `【公司概况】来源：东方财富 F10（公司概况/十大股东）；其中「企业性质」为按股东结构推断值，非 F10 权威登记口径。公司名称：${prof.companyName || ''}；行业：${prof.industry || ''}；省份：${prof.province || ''}；企业性质：${prof.ownership || ''}（推断值）；控股股东：${prof.controllingShareholder || ''}`,
    prof._raw && prof._raw.empNum ? `；员工人数：约${prof._raw.empNum}人` : '',
  ].join('');
  parts.push(head + '。');
  if (prof.mainProducts && prof.mainProducts.length) {
    parts.push(`【主要产品（F10 主营构成·产品维度）】${prof.mainProducts.join('、')}`);
  }
  if (prof.mainBusiness) {
    parts.push(`【主营业务/经营范围（公司披露原文节选）】${String(prof.mainBusiness).slice(0, 600)}`);
  }
  if (segmentRes.ok) {
    const seg = segmentRes;
    const dimLines = [];
    for (const type of Object.keys(seg.dims || {})) {
      const arr = seg.dims[type] || [];
      if (!arr.length) continue;
      const lines = arr.map(it => `- ${it.name}（营收占比 ${it.ratio != null ? it.ratio : '未知'}%${it.incomeYi ? `，营收 ${it.incomeYi} 亿元` : ''}${it.grossMargin != null ? `，毛利率 ${it.grossMargin}%` : ''}${it.costRatio != null ? `，成本占比 ${it.costRatio}%` : ''}）`).join('\n');
      dimLines.push(`■ 按${type}（${seg.year}年报期${seg.asOf ? '，' + seg.asOf : ''}）：\n${lines}`);
    }
    if (dimLines.length) {
      parts.push(`【主营构成明细】来源：东方财富 F10（MainOperate）。\n${dimLines.join('\n')}`);
    }
  }
  return {
    ok: true,
    text: parts.join('\n\n'),
    // 内容锚点：公司名/员工数/控股股东 + 主营构成年报期。内容不变 → AI 结果缓存长期有效
    anchor: [
      `${prof.companyName || ''}|${(prof._raw && prof._raw.empNum) || ''}|${prof.controllingShareholder || ''}`,
      segmentRes.ok ? `${segmentRes.year}|${segmentRes.asOf || ''}` : 'no-seg',
    ].join('||'),
    hasSegment: !!segmentRes.ok,
  };
}

// ---------- 批量预热（自选股打开时静默预下载，不产生 LLM 费用）----------

async function prefetchFacts({ symbol, stockName }) {
  if (!symbol) return { ok: false };
  const out = {};
  out.research = await getResearchFacts(symbol).catch(e => ({ ok: false, message: e.message }));
  out.announcements = await getAnnouncementFacts(symbol, stockName).catch(e => ({ ok: false, message: e.message }));
  out.profile = await getProfileFacts(symbol).catch(e => ({ ok: false, message: e.message }));
  out.segment = await getSegmentFacts(symbol).catch(e => ({ ok: false, message: e.message }));
  return {
    ok: true,
    symbol,
    research: !!(out.research && out.research.ok),
    announcements: !!(out.announcements && out.announcements.ok),
    profile: !!(out.profile && out.profile.ok),
    segment: !!(out.segment && out.segment.ok),
  };
}

module.exports = {
  FACT_TTL,
  getResearchFacts,
  buildResearchContext,
  getAnnouncementFacts,
  buildAnnouncementContext,
  getProfileFacts,
  getSegmentFacts,
  buildCompanyFactsContext,
  prefetchFacts,
};

~~~

---

## `lib\financeHub.js`  ·  151 行

~~~js
/**
 * 财务 · 统一数据网关（三条底层铁律铺开：财务模块）
 * ============================================================================
 * 规则一 数据一致性：
 *   - 单一权威来源：财报数据只从 fetchFinancialData（东财 F10 报表
 *     lrbAjaxNew / zcfzbAjaxNew / xjllbAjaxNew）取，本模块为唯一出口。
 *   - 五要素身份：每个指标携带 { 名称, 数值, 报告期(数据时间), 来源, 获取时间 }。
 * 规则二 数据最新性：
 *   - 财务数据有效期 90 天；以「最新报告期」为数据时间做体检。
 *   - 过期或取数失败时输出「数据已过期，最后更新时间是 XXXX-XX-XX」，
 *     绝不用推算值冒充实际披露值。
 * 规则三 变化与边际分析：
 *   - 变化率 = 同比增速（YoY）；
 *   - 边际 = 本期同比增速 − 上期同比增速 → 业绩「加速增长 / 增速放缓」；
 *   - 方向性变化（由增转降 / 由降转增）+ 连续同向边际的趋势强化信号。
 * 通用原语复用 ./ruleCore。
 * ============================================================================
 */
const core = require('./ruleCore');

const {
  makeDatum, beginSnapshot, checkFreshness, staleLabel,
  analyzeSeries, changeRate,
} = core;

const SOURCE = '东方财富F10财报(lrb/zcfz/xjllbAjaxNew)';

// 关注的财务指标：key = 报表字段名，label = 展示名
const METRICS = [
  { key: 'TOTAL_OPERATE_INCOME', label: '营业收入' },
  { key: 'PARENT_NETPROFIT', label: '归母净利润' },
];

/**
 * 从利润表序列中取出某指标的「年度序列」（按 REPORT_DATE 年份去重，取该年最后一条）
 */
function yearlySeries(income, key) {
  const byYear = {};
  (income || []).forEach(r => {
    const d = String(r.REPORT_DATE || '').slice(0, 10);
    const y = d.slice(0, 4);
    const v = Number(r[key]);
    if (!y || !isFinite(v)) return;
    // 升序遍历时后来者覆盖 → 得到该年最后一个报告期
    byYear[y] = { date: d, value: v };
  });
  return Object.keys(byYear).sort().map(y => byYear[y]);
}

/**
 * 主入口
 * @param {Object} finData  fetchFinancialData 的返回 { income, balance, cashflow }
 */
function getFinanceHub(finData) {
  const fetchTime = new Date().toISOString();

  if (!finData || !Array.isArray(finData.income) || !finData.income.length) {
    return {
      ok: false,
      error: '未获取到财务数据',
      note: '⚠️ 未能获取财务数据，本次不输出财务结论（规则：无有效数据不得分析）。',
      fetchedAt: fetchTime,
    };
  }

  const income = finData.income.slice().sort(
    (a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || ''))
  );

  // 最新报告期 = 数据时间（规则二：财务以报告期为数据时间）
  const latestReport = income[income.length - 1];
  const reportDate = String(latestReport.REPORT_DATE || '').slice(0, 10);

  // 规则一②：五要素（最新报告期关键指标）
  const latest = {};
  METRICS.forEach(m => {
    const v = Number(latestReport[m.key]);
    if (isFinite(v)) latest[m.key] = makeDatum(m.label, v, reportDate, SOURCE, fetchTime);
  });

  // 规则二②：财务 90 天有效期体检
  const freshness = checkFreshness(reportDate, 'financial', Date.now());
  const staleNote = freshness.expired ? staleLabel(reportDate) : '';

  // 规则三：各指标的年度同比序列 → 变化率 / 边际 / 方向
  const analysis = {};
  METRICS.forEach(m => {
    const series = yearlySeries(income, m.key)
      .filter(p => p.value > 0)
      .map(p => ({ date: p.date, value: p.value, source: SOURCE, fetchTime }));
    analysis[m.key] = analyzeSeries(series, m.label);
  });

  // 规则三补充：营收/净利润「增速的边际」——本期同比 vs 上期同比
  const growthMarginal = {};
  METRICS.forEach(m => {
    const series = yearlySeries(income, m.key).filter(p => p.value > 0);
    if (series.length < 3) {
      growthMarginal[m.key] = { available: false, reason: '不足三期，无法计算增速的边际' };
      return;
    }
    const n = series.length;
    const curYoY = changeRate(series[n - 1].value, series[n - 2].value);
    const prevYoY = changeRate(series[n - 2].value, series[n - 3].value);
    const marginal = (curYoY != null && prevYoY != null)
      ? Math.round((curYoY - prevYoY) * 100) / 100 : null;
    let trend = '数据不足';
    if (marginal != null) {
      if (curYoY > 0) trend = marginal > 0.5 ? '加速增长' : (marginal < -0.5 ? '增速放缓' : '增速平稳');
      else if (curYoY < 0) trend = marginal < -0.5 ? '降幅扩大' : (marginal > 0.5 ? '降幅收窄' : '降幅平稳');
      else trend = '基本持平';
    }
    growthMarginal[m.key] = {
      available: true,
      currentYoY: curYoY,
      prevYoY: prevYoY,
      marginal,
      trend,
      text: `${m.label}同比 ${curYoY != null ? curYoY.toFixed(2) : '--'}%（上期 ${prevYoY != null ? prevYoY.toFixed(2) : '--'}%），边际 ${marginal != null ? marginal.toFixed(2) : '--'} 个百分点，呈${trend}态势`,
    };
  });

  return {
    ok: true,
    latest,
    reportDate,
    freshness,
    staleNote,
    analysis,
    growthMarginal,
    source: SOURCE,
    fetchedAt: fetchTime,
  };
}

/**
 * 生成「规则合规」的财务描述片段
 */
function formatFinanceLine(hub, key) {
  if (!hub || !hub.latest) return null;
  const d = hub.latest[key];
  if (!d) return null;
  const stale = (hub.freshness && hub.freshness.expired && hub.staleNote) ? `；⚠️ ${hub.staleNote}` : '';
  const base = `${d.name} ${d.value}（报告期 ${d.dataTime}，来源：${d.source}${stale}）`;
  const g = hub.growthMarginal && hub.growthMarginal[key];
  if (!g || !g.available) return base;
  return `${base}；${g.text}`;
}

module.exports = { getFinanceHub, formatFinanceLine, beginSnapshot };

~~~
