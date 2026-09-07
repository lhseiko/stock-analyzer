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
const { getHotNews } = require('./newsSearch');
const { annotateNewsImpact, NEWS_SECTOR_MAP } = require('./newsSectorImpact');
const { callLLM, pickModelFor } = require('./ai/llm');
const { loadConfig: loadAICfg, loadPromptFile } = require('./ai/config');

const EVENTS_DIR = path.join(__dirname, '..', 'data', 'events');
const CONFIG_FILE = path.join(EVENTS_DIR, 'config.json');
const ACTIVE_FILE = path.join(EVENTS_DIR, 'active.json');
const HISTORY_FILE = path.join(EVENTS_DIR, 'history.json');
const AUDIT_FILE = path.join(EVENTS_DIR, 'audit.json');
const STATE_FILE = path.join(EVENTS_DIR, 'state.json');
const WATCHLIST_FILE = path.join(__dirname, '..', 'data', 'watchlist.json');

const ENGINE_VERSION = 'v2';
const DAY = 86400000;

// 已知自选股的板块归属（NEWS_SECTOR_MAP 的 hotStocks 未覆盖时兜底）
const STOCK_SECTOR_OVERRIDE = {
  '中国平安': '保险', '华安证券': '证券', '长江证券': '证券',
  '士兰微': '半导体', '圣湘生物': '医药生物', '海天味业': '食品饮料',
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

// ===== 配置 =====
function defaultConfig() {
  return {
    version: '20260907c',
    engineVersion: ENGINE_VERSION,
    gradeRanges: {
      major: { fixedWeightShort: 0.45, fixedWeightLong: 0.45, decayShortDays: 225, decayLongDays: 730 },
      moderate: { fixedWeightShort: 0.30, fixedWeightLong: 0.30, decayShortDays: 105, decayLongDays: 548 },
      minor: { fixedWeightShort: 0.08, fixedWeightLong: 0.0, decayShortDays: 3, decayLongDays: 0 },
    },
    severity: {
      maxPerDim: 3,
      gradeThresholds: { major: 11, moderate: 7, minor: 3 },
      minConfidence: 0.6,
      // 类型硬上限：即使评分卡波动，也绝不允许越级（杜绝「研报观点=重大」）
      typeCeiling: {
        research_opinion: 'minor',
        company_event: 'moderate',
        routine_monetary_policy: 'moderate',
        industry_supply: 'major',
        macro_policy: 'major',
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
    maxCombinedEventWeight: 0.5,
  };
}
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return defaultConfig(); }
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
  const today = new Date().toISOString().slice(0, 10);
  return (st.webDate === today) ? (st.webCount || 0) : 0;
}
function bumpWebUsage() {
  const st = loadState();
  const today = new Date().toISOString().slice(0, 10);
  st.webDate = today;
  st.webCount = (st.webDate === today ? (st.webCount || 0) : 0) + 1;
  saveState(st);
}
function heatUsageToday() {
  const st = loadState();
  const today = new Date().toISOString().slice(0, 10);
  return (st.heatDate === today) ? (st.heatCount || 0) : 0;
}
function bumpHeatUsage() {
  const st = loadState();
  const today = new Date().toISOString().slice(0, 10);
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
  return { grade, total, confidence: conf, capped };
}

// ===== 扫描（T0→T4）=====
async function scanEvents(force) {
  const cfg = loadConfig();
  const watchlist = resolveWatchlist();
  const now = Date.now();
  const audit = {
    scannedAt: new Date().toISOString(),
    totalNews: 0, rejectedRecap: 0, rejectedNoMatch: 0,
    candidates: 0, llmNotEvent: 0, llmFailed: 0,
    gradeNone: 0, created: 0, updated: 0, expired: 0, pendingConfirm: 0, webChecks: 0,
    heatChecks: 0, heatAdjusted: 0,
  };

  let news = [];
  try { const d = await getHotNews(force); news = (d && d.items) || []; } catch (e) { news = []; }
  news = annotateNewsImpact(news);
  audit.totalNews = news.length;

  // T1 规则硬闸门 + 自选股匹配
  const candidates = [];
  for (const n of news) {
    const text = `${n.title || ''} ${n.summary || ''}`;
    const rule = classifyByRule(text);
    if (rule.reject) { audit.rejectedRecap++; continue; } // 「果」→ 拒收
    const imp = n.impact;
    if (!imp || !imp.sector || imp.signal === 0) continue;
    const affected = matchWatchlist(imp.sector, imp.hotStocks, n.title, n.summary, watchlist);
    if (!affected.length) { audit.rejectedNoMatch++; continue; }
    candidates.push({ title: n.title, summary: n.summary, sector: imp.sector, signal: imp.signal, affected, ruleKind: rule.kind, ruleCeiling: rule.ceiling || null, url: n.url });
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
    c.affected.forEach(s => g.affected.add(s));
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

function matchWatchlist(sector, hotStocks, title, summary, watchlist) {
  const out = new Set();
  for (const w of watchlist) {
    if (w.sector && w.sector === sector) out.add(w.symbol);
    else if (hotStocks && hotStocks.includes(w.name)) out.add(w.symbol);
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

// 构建权重覆盖 + 事件因子（无事件 → null → 权重 0，既有因子保持 100%）
function buildEventOverride({ symbol, baseWeights, factorKeys, horizon }) {
  const events = getEventsForSymbol(symbol, horizon);
  if (!events.length) return null;
  const cfg = loadConfig();
  const sumEff = events.reduce((a, e) => a + e.effWeight, 0);
  let combined = Math.min(sumEff, cfg.maxCombinedEventWeight || 0.5);
  if (combined <= 0) return null;
  const aggSignal = round(events.reduce((a, e) => a + e.signal * e.effWeight, 0) / sumEff, 3);
  const override = {};
  for (const k of factorKeys) {
    const base = baseWeights[k] != null ? baseWeights[k] : (1 / factorKeys.length);
    override[k] = round(base * (1 - combined), 4);
  }
  const nUp = events.filter(e => e.signal > 0).length;
  const nDown = events.filter(e => e.signal < 0).length;
  const mixed = nUp > 0 && nDown > 0;
  const eventFactor = {
    key: 'event', name: '事件驱动',
    weight: round(combined, 4), signal: aggSignal, applicable: true,
    value: summarizeEvents(events, combined, aggSignal),
    detail: `共 ${events.length} 起事件（利好${nUp}/利空${nDown}）影响本股（${horizon === 'long' ? '长期' : '短期'}口径），合计权重 ${(combined * 100).toFixed(1)}%${mixed ? '；多空并存，方向互相抵消为净' + dirLabel(aggSignal) : ''}`,
    subFactors: events.slice().sort((a, b) => b.signal - a.signal).map(e => ({
      key: 'evt_' + e.id,
      name: (e.title || '').slice(0, 26),
      signal: e.signal,
      value: `${dirArrow(e.signal)}${dirLabel(e.signal)}·${e.sector}·${gradeLabel(e.grade)}·剩${e.remainingDays}天`,
    })),
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
  scanEvents, getActiveEvents, getEventsForSymbol, buildEventOverride,
  confirmEvent, setEventPaused, setEventGrade,
  resolveWatchlist, loadAudit, classifyByRule, scoreToGrade,
  eventId, gradeLabel, dirLabel, dirArrow, effectiveWeight, summarizeEvents,
  ENGINE_VERSION, EVENTS_DIR,
};
