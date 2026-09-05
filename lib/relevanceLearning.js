/**
 * 关联度 / 弱关联持续性经验库（Part B 核心）
 * --------------------------------------------------------------
 * 解决"弱关联消息被当成强利好/利空打分"的根因：
 *   mRNA 疫苗作为创新药利好 → 对医疗器械股（如圣湘生物）影响有限，
 *   但原系统按【强关联 + 重大事件×1.3 加码】打分，方向还可能反了。
 *
 * 设计（用户要求的三步链路）：
 *   1) relevanceScore(industry, theme)：个股子行业 与 主题（mRNA/疫苗/创新药…）
 *      的关联度 0~1。同子行业=1.0，同域弱亲疏=0.3~0.6，跨域=0.1。
 *   2) getExperienceDiscount / effectiveRelevance：基于历史"弱关联主题是否持续误导"
 *      的经验折扣；历史上该主题对个股多次反向/噪音 → 折扣下调。
 *      最终有效衰减 = 关联度 × 经验折扣。
 *   3) recordOutcome：结算复盘时记录 (个股, 主题, 关联度, 主题信号方向, 实际方向)，
 *      若弱关联主题持续误导则经验折扣递减，下次再下调关联度评分。
 *
 * 被以下模块消费：
 *   - newsSearch.getSectorNewsSentiment（板块消息联动：按主题逐条关联度加权，
 *     且 ×1.3 重大事件加码只在高关联主题生效）
 *   - crossMarket.getCrossMarketSignal（跨市场传导：信号按对标主题关联度衰减）
 *   - sameDayJudgment.settleRecord（结算时记录持续性，驱动经验折扣）
 */

const fs = require('fs');
const path = require('path');

// ---- 子行业 → 大领域 ----
// 医疗器械、体外诊断、医药、生物制品、创新药、疫苗… 都属"医药"大领域，但子行业亲疏不同。
const DOMAIN = {
  '医疗器械': '医药', '体外诊断': '医药', 'IVD': '医药', '医药': '医药',
  '生物制品': '医药', '化学制药': '医药', '中药': '医药', '医疗服务': '医药',
  '疫苗': '医药', '创新药': '医药', '生物医药': '医药',
  '半导体': '电子科技', '芯片': '电子科技', '集成电路': '电子科技',
  '消费电子': '电子科技', '电子': '电子科技', '光模块': '电子科技',
  '人工智能': '电子科技', '算力': '电子科技',
  '通信': '电子科技', '5G': '电子科技', '6G': '电子科技',
  '计算机': '计算机', '软件': '计算机', '信创': '计算机', 'IT服务': '计算机',
  '新能源': '新能源', '光伏': '新能源', '锂电池': '新能源', '储能': '新能源', '风电': '新能源',
  '新能源汽车': '新能源', '汽车': '新能源',
  '保险': '金融', '证券': '金融', '券商': '金融', '银行': '金融',
  '食品饮料': '消费', '白酒': '消费', '消费': '消费', '零售': '消费',
  '有色': '周期', '钢铁': '周期', '煤炭': '周期', '石油石化': '周期', '化工': '周期', '建材': '周期',
  '军工': '军工', '国防': '军工',
  '房地产': '地产', '建筑装饰': '地产', '建筑': '地产',
  '传媒': '传媒', '游戏': '传媒',
  '环保': '环保', '农业': '农业', '物流': '物流',
};

// ---- 主题（关键词）→ 核心 / 弱相关子行业 ----
// 同一条新闻主题，对"核心子行业"强相关，对"弱相关子行业"只是沾边（设备/诊断 ≠ 做药）。
// 例：mRNA 主题核心是生物制品/创新药/疫苗，医疗器械只是设备/诊断，弱相关 → 0.3。
//     泛主题（医药生物/医药）对医疗器械是核心 → 0.85（器械公司本就是医药板块成员）。
const THEME_PROFILE = {
  'mRNA':      { core: ['生物制品', '创新药', '疫苗', '医药', '生物医药'], weak: ['医疗器械', '体外诊断', '医疗服务', '中药', '化学制药'] },
  '疫苗':      { core: ['疫苗', '生物制品', '创新药', '医药', '生物医药'], weak: ['医疗器械', '体外诊断', '中药', '化学制药', '医疗服务'] },
  '创新药':    { core: ['创新药', '医药', '生物制品', '化学制药', '生物医药'], weak: ['医疗器械', '体外诊断', '中药', '医疗服务'] },
  '生物医药':  { core: ['生物制品', '创新药', '疫苗', '医药', '生物医药'], weak: ['医疗器械', '体外诊断', '中药', '化学制药', '医疗服务'] },
  '医药生物':  { core: ['医药', '生物制品', '化学制药', '中药', '医疗器械', '体外诊断', '创新药', '疫苗', '医疗服务', '生物医药'], weak: [] },
  '医药':      { core: ['医药', '生物制品', '化学制药', '中药', '医疗器械', '体外诊断', '创新药', '医疗服务'], weak: [] },
  '半导体':    { core: ['半导体', '芯片', '集成电路', '电子'], weak: ['消费电子', '光模块', '通信'] },
  '芯片':      { core: ['芯片', '半导体', '集成电路', '电子'], weak: ['消费电子', '光模块', '通信'] },
  '人工智能':  { core: ['人工智能', '算力', '计算机', '软件'], weak: ['通信', '光模块', '消费电子'] },
  '算力':      { core: ['算力', '人工智能', '通信', '光模块'], weak: ['计算机', '消费电子'] },
  '新能源':    { core: ['新能源', '光伏', '锂电池', '储能', '风电'], weak: ['新能源汽车'] },
  '光伏':      { core: ['光伏', '新能源', '储能'], weak: ['风电', '锂电池'] },
  '锂电池':    { core: ['锂电池', '新能源', '储能'], weak: ['光伏', '新能源汽车'] },
  '新能源汽车': { core: ['新能源汽车', '汽车'], weak: ['锂电池', '新能源'] },
};

// 美股对标 → 主题（用于跨市场传导关联度）
const BENCHMARK_THEME = { 'MRNA': 'mRNA', 'BNTX': '疫苗', 'NVDA': '人工智能', 'AMD': '半导体', 'MSFT': '人工智能', 'AAPL': '消费电子', 'TSLA': '新能源汽车', 'NIO': '新能源汽车', 'FSLR': '光伏', 'FCX': '有色', 'NEM': '有色', 'GOLD': '黄金', 'XOM': '石油石化', 'CVX': '石油石化' };

const WEAK_THRESHOLD = 0.6; // 关联度 < 0.6 视为弱关联（不享受重大事件×1.3 加码）

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'relevance_learning.json');

function _norm(s) {
  return String(s || '').replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
}
function _domainOf(industry) {
  const n = _norm(industry);
  if (!n) return '';
  for (const [k, v] of Object.entries(DOMAIN)) {
    if (n.includes(k) || k.includes(n)) return v;
  }
  return n; // 未知归到自身
}
function round(x, n = 3) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
function localDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 关联度 0~1：个股子行业(industry) 与 主题(theme) 的相关强度。
 *  - 完全同子行业 → 1.0
 *  - 同大领域但不同子行业 → 看 THEME_PROFILE（核心 0.85，弱相关 0.30）
 *  - 跨大领域 → 0.1
 * 主题越具体（mRNA）越敏感；泛主题（医药）对同域股都较高。
 * 例：relevanceScore('医疗器械','mRNA') ≈ 0.30（弱相关）
 *    relevanceScore('医疗器械','医药生物') ≈ 0.85（核心）
 *    relevanceScore('生物制品','mRNA') ≈ 0.85（核心）
 */
function relevanceScore(industry, theme) {
  const ind = _norm(industry);
  const th = _norm(theme);
  if (!ind || !th) return 0.5; // 缺信息按中性
  // 直接同子行业 / 包含关系
  if (ind === th || ind.includes(th) || th.includes(ind)) return 1.0;

  const profile = THEME_PROFILE[th];
  const dom = _domainOf(ind);
  const themeDom = _domainOf(th);

  if (profile) {
    const inList = (arr) => arr.some(s => {
      const ns = _norm(s);
      return ind === ns || ind.includes(ns) || ns.includes(ind);
    });
    if (inList(profile.core)) return 0.85;
    if (inList(profile.weak)) return 0.30;
  }
  // 无精确 profile：同域给 0.6，跨域给 0.1
  if (dom && themeDom && dom === themeDom) return 0.6;
  return 0.1;
}

// ---- 经验折扣持久化 ----
let cache = null;
function _load() {
  if (cache) return cache;
  let obj = null;
  try { obj = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { obj = null; }
  cache = {
    entries: (obj && Array.isArray(obj.entries)) ? obj.entries : [],
    themeStats: (obj && obj.themeStats) ? obj.themeStats : {},
  };
  return cache;
}
function _save() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) { /* 忽略写入失败 */ }
}

// 经验折扣：基于历史"弱关联主题是否持续误导"。默认 1.0。
// 当某主题对个股反复反向/噪音（实际方向与主题信号相反），折扣递减（下限 0.5）。
function getExperienceDiscount(symbol, theme) {
  const st = _load();
  const key = `${symbol || ''}|${_norm(theme) || theme}`;
  const ts = st.themeStats[key];
  return ts && ts.discount != null ? ts.discount : 1.0;
}

// 有效关联度 = 关联度 × 经验折扣（弱关联 + 历史误导 → 进一步衰减）
function effectiveRelevance(industry, theme, symbol) {
  const r = relevanceScore(industry, theme);
  const d = getExperienceDiscount(symbol, theme);
  return round(r * d, 3);
}

// 跨市场对标股的关联度（给定美股代码，查其主题再算关联度）
function benchmarkRelevance(industry, ticker, symbol) {
  const theme = BENCHMARK_THEME[String(ticker || '').toUpperCase()];
  if (!theme) return { theme: null, relevance: 0.5 };
  return { theme, relevance: effectiveRelevance(industry, theme, symbol) };
}

/**
 * 结算复盘：记录一条 (个股, 主题, 关联度, 主题信号方向, 实际方向)。
 * predictedSign: +1/-1（主题信号方向）；actualDir: '涨'/'跌'/'震荡'。
 * 弱关联(relevance<0.6) 且 主题信号方向与真实方向相反 → 记为"误导"，经验折扣递减。
 */
function recordOutcome({ symbol, industry, theme, predictedSign, actualDir, relevance, date }) {
  const st = _load();
  const rel = relevance != null ? relevance : relevanceScore(industry, theme);
  const sign = Math.sign(predictedSign || 0);
  const actualSign = actualDir === '涨' ? 1 : actualDir === '跌' ? -1 : 0;
  const misleading = rel < WEAK_THRESHOLD && sign !== 0 && sign === -actualSign;
  st.entries.push({
    symbol, theme: _norm(theme) || theme, relevance: rel,
    predictedSign: sign, actualDir, misleading,
    date: date || localDateStr(),
  });
  if (st.entries.length > 500) st.entries = st.entries.slice(-500);

  if (symbol) {
    const key = `${symbol}|${_norm(theme) || theme}`;
    if (!st.themeStats[key]) st.themeStats[key] = { weakSamples: 0, misleadCount: 0, discount: 1.0, lastUpdated: null };
    const ts = st.themeStats[key];
    if (rel < WEAK_THRESHOLD) {
      ts.weakSamples = (ts.weakSamples || 0) + 1;
      if (misleading) ts.misleadCount = (ts.misleadCount || 0) + 1;
      ts.discount = round(Math.max(0.5, 1 - 0.1 * (ts.misleadCount || 0)), 3);
    }
    ts.lastUpdated = new Date().toISOString();
  }
  _save();
  return st;
}

// 调试用：返回当前经验库快照
function getState() {
  const st = _load();
  return {
    weakThreshold: WEAK_THRESHOLD,
    entries: st.entries.slice(-50),
    totalEntries: st.entries.length,
    themeStats: st.themeStats,
  };
}

module.exports = {
  relevanceScore,
  getExperienceDiscount,
  effectiveRelevance,
  benchmarkRelevance,
  recordOutcome,
  getState,
  WEAK_THRESHOLD,
  BENCHMARK_THEME,
};
