/**
 * 美国宏观数据 · 落地复盘（公布值 / 预期值 / 前值 → 超预期 / 不及预期 → 影响分析）
 * ----------------------------------------------------------------------
 * 数据源：华尔街见闻宏观日历 API（api-one-wscn.awtmt.com）—— 国内站、单源三值齐全，
 * 其 forecast 为彭博/路透等机构共识口径（用户要求参考的「预期值」）。
 *
 * 接口约束：单次只允许一周（code 60502），须按 7 天切片；条目字段：
 *   id / public_date(秒) / country / title / calendar_type(FD=数据,FE=事件) /
 *   importance(1-4) / actual / forecast / previous / revised / unit / period
 *
 * 设计（确定性代码，不编造数值）：
 *   - 只收录美国 FD（数据类）且 importance≥3 的高权重指标，按标题关键词分类；
 *   - 三值字符串解析为数值，按类型容差判定 超预期(above)/符合(inline)/不及预期(below)；
 *   - 按「类型 × 超/不及」给方向影响（涨跌语义同项目红涨绿跌，此处 impact 为对风险资产方向）；
 *   - 结果落盘缓存 data/us_macro_results_cache.json，TTL 12h，失败回退陈旧缓存。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const WSCN_URL = 'https://api-one-wscn.awtmt.com/apiv1/finance/macrodatas';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'us_macro_results_cache.json');
const CACHE_TTL_MS = 12 * 3600 * 1000;
// 判定逻辑版本：缓存事件里的 direction/summary 是按某版逻辑算出的，逻辑改动必须升级此版本，
// 旧缓存自动失效重抓（沿用 SCHEMA_VERSION 铁律——只改代码不升版本，旧缓存会被永久复用）。
const LOGIC_VERSION = '20261013e';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 标题 → 类型/方向语义。CPI/PPI/非农/失业率/FOMC/零售/ISM 为高权重可判方向指标；
// 黑名单排除「首次申请失业救济」等周频低意义条目。
const FOCUS_RULES = [
  { type: 'cpi',          re: /CPI同比/,             exclude: null, category: '通胀',   level: 'high',   tol: 0.1,  absTol: true },
  { type: 'coreCpi',      re: /核心CPI同比/,          exclude: null, category: '通胀',   level: 'high',   tol: 0.1,  absTol: true },
  { type: 'ppi',          re: /PPI同比/,             exclude: null, category: '通胀',   level: 'medium', tol: 0.2,  absTol: true },
  { type: 'payrolls',     re: /非农就业人口变动/,      exclude: null, category: '就业',   level: 'high',   tol: 0.10, absTol: false },
  { type: 'adp',          re: /ADP就业人数变动/,       exclude: null, category: '就业',   level: 'medium', tol: 0.10, absTol: false },
  { type: 'unemployment', re: /失业率/,               exclude: /首次申请|当周/, category: '就业', level: 'high', tol: 0.1, absTol: true },
  { type: 'fomc',         re: /FOMC利率决策/,          exclude: null, category: '美联储', level: 'high',   tol: 0,    absTol: true },
  { type: 'retail',       re: /零售销售环比/,          exclude: null, category: '消费',   level: 'medium', tol: 0.2,  absTol: true },
  { type: 'ism',          re: /ISM(制造业|非制造业)指数/, exclude: null, category: '景气', level: 'medium', tol: 0.5, absTol: true },
];

// 20261013e 双维度判定（用户要求：失业率/非农要分别标注「对经济的影响」和「对股市的偏好」，避免单一判定造成误读）：
//   数值大小只用于第一步判定超/符合/不及预期（judgeDeviation），不参与方向映射。
//
// 维度一「经济影响」（基本面框架）：
//   就业类（非农/ADP）：强于预期=经济动能向上=偏多；弱于预期=经济走弱=偏空；
//   失业率：高于预期=就业恶化=偏空；低于预期=就业改善=偏多；
//   通胀类（CPI/PPI）：高于预期=通胀上行/经济承压=偏空；低于预期=偏多；
//   FOMC：利率上调=融资成本上升=偏空；下调=偏多；
//   消费/景气（零售/ISM）：强于预期=偏多；弱于预期=偏空。
function ecoDirection(type, deviate) {
  if (!deviate || deviate === 'inline') return 'neutral';
  const above = deviate === 'above';
  switch (type) {
    case 'cpi': case 'coreCpi': case 'ppi':
      return above ? 'bearish' : 'bullish';
    case 'payrolls': case 'adp':
      return above ? 'bullish' : 'bearish';
    case 'unemployment':
      return above ? 'bearish' : 'bullish';
    case 'fomc':
      return above ? 'bearish' : 'bullish';
    case 'retail': case 'ism':
      return above ? 'bullish' : 'bearish';
    default:
      return 'neutral';
  }
}
// 维度二「股市偏好」（宽松/紧缩交易框架——数据强弱改变美联储政策预期，进而影响风险资产）：
//   非农/ADP：强于预期=宽松预期降温/紧缩担忧=偏空；弱于预期=宽松预期升温=偏多；
//   失业率：高于预期=宽松预期升温=偏多；低于预期=宽松预期降温=偏空；
//   通胀类：高于预期=紧缩预期升温=偏空；低于预期=偏多；
//   FOMC：上调=流动性收紧=偏空；下调=偏多；
//   零售/ISM：强于预期=盈利预期改善=偏多；弱于预期=偏空。
// 说明：就业类两维度方向相反属正常（数据弱→经济偏空，但同时宽松预期偏多股市），
// 20261013c 的用户困惑正源于把「股市偏好」单维度当成了唯一结论，故拆开标注。
function mktDirection(type, deviate) {
  if (!deviate || deviate === 'inline') return 'neutral';
  const above = deviate === 'above';
  switch (type) {
    case 'cpi': case 'coreCpi': case 'ppi':
      return above ? 'bearish' : 'bullish';
    case 'payrolls': case 'adp':
      return above ? 'bearish' : 'bullish';
    case 'unemployment':
      return above ? 'bullish' : 'bearish';
    case 'fomc':
      return above ? 'bearish' : 'bullish';
    case 'retail': case 'ism':
      return above ? 'bullish' : 'bearish';
    default:
      return 'neutral';
  }
}
// 兼容导出：direction = 股市偏好（情绪因子 macroSentimentFactors 锚定 FOMC 的 usSignal
// 及前端卡片左边框配色沿用此口径；FOMC 两维度方向一致，无兼容风险）。
function directionOf(type, deviate) {
  return mktDirection(type, deviate);
}

const TYPE_CN = { cpi: 'CPI 同比', coreCpi: '核心 CPI 同比', ppi: 'PPI 同比', payrolls: '非农就业', adp: 'ADP 就业', unemployment: '失业率', fomc: 'FOMC 利率', retail: '零售销售', ism: 'ISM 指数' };

// 20261013e：双维度语义文案（经济影响 / 股市偏好分开表述，修复"失业率上升=缓解压力"式矛盾文案）
const ECO_TEXT = {
  payrolls:     { bullish: '偏多（就业强劲 / 经济动能向上）', bearish: '偏空（就业走弱 / 经济动能放缓）' },
  adp:          { bullish: '偏多（就业强劲 / 经济动能向上）', bearish: '偏空（就业走弱 / 经济动能放缓）' },
  unemployment: { bullish: '偏多（失业回落 / 就业市场改善）', bearish: '偏空（失业加重 / 就业市场走弱）' },
  cpi:          { bullish: '偏多（通胀回落 / 经济成本压力缓解）', bearish: '偏空（通胀上行 / 经济承压）' },
  coreCpi:      { bullish: '偏多（通胀回落 / 经济成本压力缓解）', bearish: '偏空（通胀上行 / 经济承压）' },
  ppi:          { bullish: '偏多（通胀回落 / 经济成本压力缓解）', bearish: '偏空（通胀上行 / 经济承压）' },
  fomc:         { bullish: '偏多（利率下调 / 融资成本回落）',   bearish: '偏空（利率上调 / 融资成本上升）' },
  retail:       { bullish: '偏多（消费强劲 / 经济动能向上）', bearish: '偏空（消费走弱 / 经济动能放缓）' },
  ism:          { bullish: '偏多（景气扩张 / 经济动能向上）', bearish: '偏空（景气走弱 / 经济动能放缓）' },
};
const MKT_TEXT = {
  payrolls:     { bullish: '偏多（宽松预期升温）', bearish: '偏空（紧缩预期升温）' },
  adp:          { bullish: '偏多（宽松预期升温）', bearish: '偏空（紧缩预期升温）' },
  unemployment: { bullish: '偏多（宽松预期升温）', bearish: '偏空（宽松预期降温）' },
  cpi:          { bullish: '偏多（紧缩压力缓解）', bearish: '偏空（紧缩预期升温）' },
  coreCpi:      { bullish: '偏多（紧缩压力缓解）', bearish: '偏空（紧缩预期升温）' },
  ppi:          { bullish: '偏多（紧缩压力缓解）', bearish: '偏空（紧缩预期升温）' },
  fomc:         { bullish: '偏多（流动性宽松）',   bearish: '偏空（流动性收紧）' },
  retail:       { bullish: '偏多（盈利预期改善）', bearish: '偏空（盈利预期走弱）' },
  ism:          { bullish: '偏多（盈利预期改善）', bearish: '偏空（盈利预期走弱）' },
};

function ecoText(type, direction) {
  const m = ECO_TEXT[type];
  if (m && m[direction]) return m[direction];
  if (direction === 'bearish') return '偏空（经济承压）';
  if (direction === 'bullish') return '偏多（经济动能向上）';
  return '中性（影响有限）';
}
function mktText(type, direction) {
  const m = MKT_TEXT[type];
  if (m && m[direction]) return m[direction];
  if (direction === 'bearish') return '偏空（压制风险偏好）';
  if (direction === 'bullish') return '偏多（提振风险偏好）';
  return '中性（方向影响有限）';
}

function num(v) {
  if (v == null) return null;
  const s = String(v).replace(/[%＋+]/g, '').trim();
  if (s === '' || s === '-' || s === '—') return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// 判定超/符合/不及（absTol：绝对容差；否则相对容差）
function judgeDeviation(actual, forecast, tol, absTol) {
  const a = num(actual), f = num(forecast);
  if (a == null || f == null) return null;
  if (f === 0) return a > 0 ? 'above' : (a < 0 ? 'below' : 'inline');
  const diff = a - f;
  const gap = absTol ? tol : Math.abs(f) * tol;
  if (diff > gap) return 'above';
  if (diff < -gap) return 'below';
  return 'inline';
}

// 北京时间 epoch 秒（代码计算，不依赖宿主机时区）
function bjEpoch(y, m, d, hh = 0, mi = 0) {
  return Math.floor(Date.UTC(y, m - 1, d, hh, mi) / 1000) - 8 * 3600;
}
function bjDateStr(epochSec) {
  const d = new Date((epochSec + 8 * 3600) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
function bjTimeStr(epochSec) {
  const d = new Date((epochSec + 8 * 3600) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

async function fetchWeek(startEpoch, endEpoch) {
  const resp = await axios.get(WSCN_URL, {
    params: { start: startEpoch, end: endEpoch },
    timeout: 15000,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    adapter: 'http',
  });
  const payload = resp.data;
  if (!payload || payload.code !== 20000) {
    throw new Error(`华尔街见闻返回错误: ${(payload && payload.message) || payload.code || '未知'}`);
  }
  return (payload.data && payload.data.items) || [];
}

// 抓取 过去 daysBefore 天 ~ 未来 daysAfter 天（按 7 天切片，合并去重）
async function fetchWscnWindow(daysBefore, daysAfter) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(today.getTime() - daysBefore * 86400000);
  const end = new Date(today.getTime() + daysAfter * 86400000);
  const seen = new Set();
  const items = [];
  for (let cursor = new Date(start); cursor <= end; cursor = new Date(cursor.getTime() + 7 * 86400000)) {
    const s = bjEpoch(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate());
    const stop = new Date(Math.min(cursor.getTime() + 6 * 86400000, end.getTime()));
    const e = bjEpoch(stop.getUTCFullYear(), stop.getUTCMonth() + 1, stop.getUTCDate(), 23, 59);
    const batch = await fetchWeek(s, e);
    for (const it of batch) {
      if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
    }
  }
  return items;
}

// 合并 FOMC 上下限两条为一条
function mergeFomc(items) {
  const fomc = items.filter(i => i.type === 'fomc');
  if (fomc.length >= 2) {
    const lo = fomc.find(i => /下限/.test(i.rawTitle));
    const hi = fomc.find(i => /上限/.test(i.rawTitle));
    if (lo && hi) {
      const actual = (lo.actual != null && hi.actual != null) ? `${lo.actual}-${hi.actual}` : (lo.actual != null ? lo.actual : (hi.actual != null ? hi.actual : null));
      const forecast = (lo.forecast != null && hi.forecast != null) ? `${lo.forecast}-${hi.forecast}` : (lo.forecast != null ? lo.forecast : (hi.forecast != null ? hi.forecast : null));
      const previous = (lo.previous != null && hi.previous != null) ? `${lo.previous}-${hi.previous}` : (lo.previous != null ? lo.previous : (hi.previous != null ? hi.previous : null));
      const merged = {
        ...lo,
        id: 'us-fomc-' + lo.date,
        type: 'fomc',
        title: '美联储 FOMC 利率决议（目标区间）',
        actual, forecast, previous, unit: '%',
      };
      merged.deviate = judgeDeviation(lo.actual, lo.forecast, 0, true);
      merged.eco = ecoDirection('fomc', merged.deviate);
      merged.direction = mktDirection('fomc', merged.deviate);
      merged.impact = merged.direction;
      merged.summary = buildSummary(merged);
      return [merged, ...items.filter(i => i.type !== 'fomc')];
    }
  }
  return items;
}

function buildSummary(ev) {
  const t = ev.title;
  const f = ev.forecast, p = ev.previous;
  if (ev.status === 'upcoming' || ev.deviate == null) {
    return `${t} 将于 ${ev.date} ${ev.timeZh} 公布（预期 ${f != null ? f : '待定'}${ev.unit ? ev.unit : ''}${p != null ? '，前值 ' + p : ''}）。`;
  }
  const verdict = ev.deviate === 'above' ? '超预期' : ev.deviate === 'below' ? '不及预期' : '符合预期';
  return `${t} 公布 ${ev.actual}${ev.unit ? ev.unit : ''}，${verdict}（预期 ${f != null ? f : '—'}${ev.unit ? ev.unit : ''}，前值 ${p != null ? p : '—'}）→ 经济影响：${ecoText(ev.type, ev.eco)}；股市偏好：${mktText(ev.type, ev.direction)}。`;
}

// 将华尔街见闻 items 转为聚焦事件
function transform(items) {
  const out = [];
  for (const it of items) {
    if ((it.country || '').indexOf('美国') < 0) continue;
    if (it.calendar_type !== 'FD') continue;
    if (!(it.importance >= 3)) continue;
    const rule = FOCUS_RULES.find(r => r.re.test(it.title || '') && (!r.exclude || !r.exclude.test(it.title || '')));
    if (!rule) continue;
    const date = bjDateStr(it.public_date);
    const actual = it.actual;
    const hasActual = num(actual) != null;
    const deviate = hasActual ? judgeDeviation(actual, it.forecast, rule.tol, rule.absTol) : null;
    const direction = mktDirection(rule.type, deviate);
    const eco = ecoDirection(rule.type, deviate);
    out.push({
      id: it.id,
      type: rule.type,
      rawTitle: it.title,
      title: it.title,
      date,
      timeZh: bjTimeStr(it.public_date),
      dateZh: `${date} ${bjTimeStr(it.public_date)}（北京时间）`,
      category: rule.category,
      level: rule.level,
      impact: direction === 'bearish' ? 'bearish' : direction === 'bullish' ? 'bullish' : 'neutral',
      eco,
      actual: actual || null,
      forecast: it.forecast || null,
      previous: it.previous || null,
      revised: it.revised || null,
      unit: it.unit || '',
      deviate,
      direction,
      status: hasActual ? 'released' : 'upcoming',
      summary: '',
    });
  }
  for (const ev of out) ev.summary = buildSummary(ev);
  return mergeFomc(out);
}

function readCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (j && Array.isArray(j.events) && j.logicVersion === LOGIC_VERSION) return j;
  } catch (e) {}
  return null;
}
function writeCache(events) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), logicVersion: LOGIC_VERSION, source: '华尔街见闻宏观日历', events }, null, 2));
    return true;
  } catch (e) { console.error('[usMacroResults] 写缓存失败:', e.message); return false; }
}

async function refreshUsMacroResults({ force = false, daysBefore = 14, daysAfter = 21 } = {}) {
  const cached = readCache();
  const freshEnough = cached && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < CACHE_TTL_MS;
  if (!force && freshEnough) return { ok: true, events: cached.events, fromCache: true, stale: false, source: cached.source };
  try {
    const items = await fetchWscnWindow(daysBefore, daysAfter);
    const events = transform(items);
    if (!events.length) throw new Error('解析后无聚焦事件（美国高权重宏观数据）');
    writeCache(events);
    return { ok: true, events, fromCache: false, stale: false, source: '华尔街见闻宏观日历' };
  } catch (e) {
    console.error('[usMacroResults] 抓取失败:', e.message);
    if (cached && Array.isArray(cached.events) && cached.events.length) {
      return { ok: true, events: cached.events, fromCache: true, stale: true, source: cached.source, warn: e.message };
    }
    return { ok: false, events: [], fromCache: false, stale: false, source: '', warn: e.message };
  }
}

module.exports = { refreshUsMacroResults, transform, judgeDeviation, directionOf, ecoDirection, mktDirection, num, _CACHE_FILE: CACHE_FILE };
