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

async function analyzeValuation({ symbol, stockName, industry, force, companyName }) {
  ensureDirs();
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
      const ruleDate = cachedDeep.cachedAt ? new Date(cachedDeep.cachedAt).toISOString().slice(0, 10) : '未知';
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

module.exports = { analyzeValuation };
