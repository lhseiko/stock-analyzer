/**
 * 每日宏观 & 政策采集
 * --------------------------------------------------------------
 * 基于东方财富 7×24 快讯，过滤出「宏观经济 / 货币政策 / 财政监管 / 数据发布 /
 * 国际宏观」相关条目，按类别分组，供首页「每日宏观 & 政策」卡片展示。
 * 按自然日缓存（每日自动采集一次），进入页面时加载，可手动刷新。
 *
 * 说明：实时抓取宏观指标精确数值（如统计局 CPI/PMI）需官网结构化解析，
 * 本环境以「宏观/政策类快讯」为主来源，覆盖绝大多数每日宏观与政策动态，
 * 每条均标注来源与时间；如需精确数值指标可后续接入官网解析（见 macro-monitor）。
 */
const { fetchKuaixunNews, fetchEastmoneyContentNews } = require('./newsSearch');
const { analyzeSentiment } = require('./analysis');
const { getRegulatoryNews } = require('./cnscraperAdapter');

// 按类别的关键词（命中任一即归入该类）
const MACRO_CATS = {
  货币政策: /(央行|降准|降息|LPR|MLF|逆回购|货币|流动性|信贷|社融|存款准备金|公开市场|基础货币|宽货币|紧货币|汇率|人民币)/,
  财政监管: /(财政|财政收入|财政支出|财政收支|一般公共预算|预算收支|财政赤字|减税|专项债|国债|国务院|发改委|证监会|资管|监管|国常会|政治局|两会|税收|补贴|社保|公积金|财政部|货币.*政策报告|央行.*报告)/,
  数据发布: /(CPI|PPI|PMI|GDP|工业增加|社零|固定资产投资|进出口|失业率|M2|外汇储备|物价|经济数据|宏观数据|财政.*数据|社融.*数据|信贷.*数据)/,
  国际宏观: /(美联储|加息|非农|FOMC|欧央行|日央|地缘|俄乌|中东|美元|美债|特朗普|拜登|关税|贸易战|IMF|世行|国际经济)/,
};

function macroCategory(title = '', summary = '') {
  const t = title + ' ' + (summary || '');
  for (const [cat, re] of Object.entries(MACRO_CATS)) {
    if (re.test(t)) return cat;
  }
  return null;
}

// 本地自然日（GMT+8），避免 toISOString() 的 UTC 跨日导致缓存过早/过晚失效
function localToday() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 内存缓存：以自然日为单位，跨自然日自动失效（每日自动采集）
let macroCache = { date: '', data: null };

async function getMacroNews(force = false) {
  const today = localToday();
  if (!force && macroCache.date === today && macroCache.data) return macroCache.data;

  const result = await collectMacro(today);
  macroCache = { date: today, data: result };
  return result;
}

async function collectMacro(today) {
  // 主源：东方财富 7×24 快讯（宏观/政策过滤）
  let items = [];
  try {
    items = await fetchKuaixunNews(60);
  } catch (e) {
    items = [];
  }
  let macro = items.filter(n => macroCategory(n.title, n.summary));

  // 兜底：主源受限或过滤后过少时，用内容搜索补宏观/政策动态（与「今日热点」同源兜底）
  let usedFallback = false;
  if (macro.length < 6) {
    try {
      const fbRaw = await fetchEastmoneyContentNews('宏观 政策 央行 货币 财政 经济数据 GDP CPI 降准 降息', 30);
      const fb = (fbRaw || []).filter(n => macroCategory(n.title, n.summary || ''));
      const have = new Set(macro.map(n => n.title));
      for (const n of fb) {
        if (!have.has(n.title)) { macro.push(n); have.add(n.title); }
      }
      if (fb.length) usedFallback = true;
    } catch (e) { /* 兜底失败则保留主源结果 */ }
  }

  // 仍过少：放宽到含经济/市场/股市关键词且尚未包含的条目
  if (macro.length < 6) {
    const extra = items.filter(n =>
      /(经济|市场|股市|A股|债市|基金|外汇|人民币|金融|产业)/.test(n.title) && !macro.includes(n));
    macro = macro.concat(extra).slice(0, 40);
  }

  // 兜底（增强）：主源 + 内容搜索仍偏薄时，用 cn-financial-scraper 监管/政策源补「财政部发布 /
  // 财政收支 / 预算」类动态——7×24 快讯偶尔漏抓财政部数据发布，此兜底让首页「财政监管」分类
  // 能主动进化捕获（本机沙箱常返回空，属正常降级；联网环境生效）。
  if (macro.length < 8) {
    try {
      const reg = await getRegulatoryNews('all', 20);
      if (reg && reg.ok && Array.isArray(reg.items) && reg.items.length) {
        const have = new Set(macro.map(n => n.title));
        const fiscalOrPolicy = /(财政|预算|税收|减税|专项债|国债|政策|央行|货币|经济|监管|国常会|政治局)/;
        for (const it of reg.items) {
          const title = it.title || '';
          if (!title || have.has(title)) continue;
          if (macroCategory(title, it.summary || '') || fiscalOrPolicy.test(title)) {
            macro.push({
              title,
              summary: it.summary || '',
              url: it.url || '',
              date: it.date || '',
              source: it.source || '监管政策源',
            });
            have.add(title);
          }
        }
      }
    } catch (e) { /* 兜底失败则保留主源结果，绝不抛异常 */ }
  }

  macro = macro.map(n => ({
    ...n,
    category: macroCategory(n.title, n.summary) || '市场',
    sentiment: analyzeSentiment(n.title + ' ' + (n.summary || '')),
  }));
  macro.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  macro = macro.slice(0, 24);

  const byCategory = {};
  for (const m of macro) {
    const cat = m.category || '市场';
    (byCategory[cat] = byCategory[cat] || []).push(m);
  }
  const order = ['货币政策', '财政监管', '数据发布', '国际宏观', '市场'];

  const fromKuaixun = items.length > 0;
  const source = fromKuaixun
    ? (usedFallback ? '东方财富 7×24 快讯 + 内容搜索兜底（宏观/政策）' : '东方财富 7×24 快讯（宏观/政策过滤）')
    : '东方财富内容搜索（宏观/政策 · kuaixun 不可用时兜底）';

  return {
    source,
    updated: new Date().toISOString(),
    date: today,
    total: macro.length,
    items: macro,
    byCategory,
    order,
  };
}

module.exports = { getMacroNews, macroCategory };
