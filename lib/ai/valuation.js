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
          paCfg.inputs.P = Object.assign({}, paCfg.inputs.P, { value: q.price, source: `实时行情(腾讯) ${q.date || ''}` });
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
          missing: r.missing, sotpDegraded: r.sotpDegraded, sotpSkipped: r.sotpSkipped, sotpSkipReason: r.sotpSkipReason,
          alerts: r.alerts, freshnessRows: r.freshnessRows || [], reportPeriod: r.reportPeriod,
          raw: r.raw, model: 'pingAnRolling_v2（滚动估值协议·确定性计算，无AI参与）', ver: 'DEDICATED',
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
      const sx = sanxiModel.run(bareSym, { price });
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
      const ht = haitianModel.run(bareSym, { price });
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
      const sl = silanModel.run(bareSym, { price });
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
      const ha = huaanModel.run(bareSym, { price });
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
      const cj = cjModel.run(bareSym, { price });
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
  } catch (e) { /* fallthrough */ }
  return false;
}

module.exports = { analyzeValuation, hasDedicatedValuation };
