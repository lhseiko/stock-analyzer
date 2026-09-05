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
  const today = new Date().toISOString().slice(0, 10);
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
    `【公司概况】来源：东方财富 F10（公司概况/十大股东）。公司名称：${prof.companyName || ''}；行业：${prof.industry || ''}；省份：${prof.province || ''}；企业性质：${prof.ownership || ''}；控股股东：${prof.controllingShareholder || ''}`,
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
