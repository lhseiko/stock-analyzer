/**
 * lib/stockReview.js — 个股每日复盘服务（20261110e · 替换原「策略」tab）
 * ==================================================================================
 * 用户 2026-11-10 规格（@skill:ui-new @skill:proactive-agent）：
 *   每日针对「自选股池」或「今日核心观察股」生成复盘卡片；严禁买卖建议；
 *   严格按「事实→判断→验证→不成立」四段式输出；与【大盘复盘模块】打通联动：
 *   大盘复盘的「明日核心观察池」自动带入跑个股复盘；历史追踪落盘，
 *   连续 3 天「放弃信号」后用历史记录反查 AI 漏看数据/环境变化。
 *
 * 架构（沿用每日复盘 20261110b 固化的样板，三规则齐备）：
 *   取数（quoteHub/stockData/capitalFlow/sectorLimitStats/newsSearch 全部既有单源）
 *     → 组装干净 JSON Context（不含任何文案）
 *     → System Prompt（prompts/stock-review-system.md）+ lib/ai/llm.js 生成 Markdown
 *     → 落盘 data/stock-reviews/{symbol}/{date}.json
 *   LLM 失败 / 未配置 → 降级为数据快照照常落盘（不拒绝发布）。
 *
 * 确定性代码职责（代码权威，LLM 仅叙事）：
 *   - parseWatchPool()      解析大盘复盘 markdown 的【明日核心观察池】表格
 *   - computeGiveupStreak() 连续放弃信号天数（读历史落盘 marks，不读 LLM 叙事）
 *   - extractMarks()        从 LLM 输出确定性抽取「评级判定/放弃信号判定」标记行
 *   - 落盘 / 缓存 / force 重跑
 */
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('./store'); // [20261110g P1-4] JSON 读写统一

// [20261110f] 结构变更按铁律升版：观察池解析新增「代码」列（layout code6/legacy5）+ 落盘记录新增
// poolCode 字段 + 缓存键改为「解析后代码」。旧版 stock-review-20261110a 文档不会与新结构混用。
const SCHEMA_VERSION = 'stock-review-20261111d';
const PROMPT_FILE = 'stock-review-system.md';
const TIMEOUT_MS = 300000;   // 与每日复盘一致（300s）：Context 含资金/消息采集，实测 180s 曾超时降级
// [20261110f B0-6] 整链路预算：单次已由 TIMEOUT_MS 给到 300s，再留 60s 给能力自学习重试一次；
// 超出即快速失败降级，避免「串行多次超时 → 用户白等 10 分钟」。
const OVERALL_BUDGET_MS = TIMEOUT_MS + 60000;
const NEWS_LIMIT = 10;

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.SA_STOCK_REVIEW_DIR
  ? path.resolve(process.env.SA_STOCK_REVIEW_DIR)
  : path.join(ROOT, 'data', 'stock-reviews');
// 大盘复盘落盘目录（与 lib/reviewService.js 同一环境变量，保证联动读到同一份数据）
const MARKET_REVIEW_DIR = process.env.SA_REVIEW_DIR
  ? path.resolve(process.env.SA_REVIEW_DIR)
  : path.join(ROOT, 'data', 'reviews');

/* ────────────────────────── 基础工具 ────────────────────────── */

function todayStr(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}
function nowIso() { return new Date().toISOString(); }
function ensureDirFor(symbol) {
  const dir = path.join(DATA_DIR, String(symbol));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
function reviewFile(symbol, date) { return path.join(DATA_DIR, String(symbol), date + '.json'); }
function round2(n) { return (n == null || isNaN(Number(n))) ? null : Math.round(Number(n) * 100) / 100; }

/* ────────────────────── 大盘复盘「明日核心观察池」解析 ────────────────────── */

/** 从单元格里提纯 6 位股票代码（兼容「600519」「600519.SH」「600519（贵州茅台）」）。 */
function normCode(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/\b(\d{6})\b/);
  return m ? m[1] : '';
}

/**
 * 从大盘复盘 markdown 中确定性解析【明日核心观察池】表格。
 * 【20261110f B0-2】表头新增「代码」列（6 列），旧落盘的 5 列复盘靠表头检测兼容解析，无需重跑。
 *
 * 6 列（当前）：| 股票名称 | 代码 | 入选原因 | 评级 | 明日观察什么 | 放弃跟踪的信号 |
 * 5 列（旧版）：| 股票名称 | 入选原因 | 评级 | 明日观察什么 | 放弃跟踪的信号 |
 *
 * @returns {{date:string|null, rows:Array<{name:string,code:string|null,reason:string,
 *            rating:string,watch:string,exitSignal:string}>, layout:string|null}}
 */
function parseWatchPool(markdown) {
  const md = String(markdown || '');
  const marker = md.indexOf('【明日核心观察池】');
  const rows = [];
  if (marker === -1) return { date: null, rows, layout: null };
  // 从标记行向后扫，收集含「|」的表格行，遇到表格结束（非表格行）即停
  const lines = md.slice(marker).split('\n');
  let started = false;
  let hasCodeCol = false;   // 表头是否含「代码」列
  let headerSeen = false;
  for (let i = 0; i < lines.length && rows.length < 20; i++) {
    const line = lines[i].replace(/^\s*>\s?/, '').trim(); // 剥 blockquote 前缀
    if (!line.includes('|')) {
      if (started) break;
      continue;
    }
    const cells = line.split('|').map(c => c.trim());
    // 去掉表格首尾因 `|` 产生的空单元：| a | b | → ['', 'a', 'b', '']
    if (cells.length && cells[0] === '') cells.shift();
    if (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (!cells.length) continue;
    // 表头行：据此决定列布局，随后整表沿用同一布局
    if (/^(股票名称|名称)$/.test(cells[0])) {
      hasCodeCol = cells.some(c => /^代码$/.test(c));
      headerSeen = true;
      started = true;
      continue;
    }
    // 分隔行 |---|---|
    if (cells.every(c => /^[-:\s]*$/.test(c))) { started = true; continue; }
    if (cells.length < 2) continue;
    if (hasCodeCol && cells.length >= 5) {
      rows.push({
        name: cells[0],
        code: normCode(cells[1]) || null,
        reason: cells[2] || '',
        rating: (cells[3] || '').toUpperCase(),
        watch: cells[4] || '',
        exitSignal: cells[5] || '',
      });
    } else {
      rows.push({
        name: cells[0],
        code: null,
        reason: cells[1] || '',
        rating: (cells[2] || '').toUpperCase(),
        watch: cells[3] || '',
        exitSignal: cells[4] || '',
      });
    }
    started = true;
  }
  return { date: null, rows, layout: headerSeen ? (hasCodeCol ? 'code6' : 'legacy5') : null };
}

/** 读取最新一份大盘复盘并解析观察池。 */
function getPool() {
  let files = [];
  try {
    files = fs.readdirSync(MARKET_REVIEW_DIR)
      .filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
      .sort().reverse();
  } catch (e) { /* 目录不存在 → 空池 */ }
  for (const n of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(MARKET_REVIEW_DIR, n), 'utf8'));
      const parsed = parseWatchPool(d && d.markdown);
      if (parsed.rows.length) return { date: n.replace('.json', ''), rows: parsed.rows, layout: parsed.layout };
    } catch (e) { /* 损坏文件跳过，不臆造 */ }
  }
  return { date: null, rows: [], layout: null };
}

/** [20261110f B0-3] 读取指定日期的大盘复盘观察池（反向联动用：D-1 复盘的池即 D 日的观察名单）。 */
function getPoolForDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { date: null, rows: [], layout: null };
  try {
    const f = path.join(MARKET_REVIEW_DIR, date + '.json');
    if (!fs.existsSync(f)) return { date: null, rows: [], layout: null };
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    const parsed = parseWatchPool(d && d.markdown);
    return { date, rows: parsed.rows, layout: parsed.layout };
  } catch (e) { return { date: null, rows: [], layout: null }; }
}

/**
 * [20261110f B0-3] 反向联动数据块：某日大盘观察池个股的个股复盘标记汇总，
 * 供大盘复盘「昨日判断对照」使用（只给确定性数值/枚举，文案仍由 LLM 生成）。
 * @param {string} poolDate 大盘复盘日期（其观察池对应 poolDate 之后的交易日）
 * @param {string} [asOfDate] 取该日期及之前的个股复盘（默认不限）
 */
function poolMarksSummary(poolDate, asOfDate) {
  const pool = getPoolForDate(poolDate);
  if (!pool.rows.length) return { poolDate: pool.date, total: 0, reviewed: 0, giveupTriggered: 0, rows: [] };
  const out = [];
  let reviewed = 0, giveup = 0;
  for (const r of pool.rows.slice(0, 12)) {
    const sym = r.code || (r.name || '').match(/\d{6}/)?.[0] || null;
    let rec = null;
    if (sym) {
      rec = asOfDate ? (getReview(sym, asOfDate) || getLatestReview(sym)) : getLatestReview(sym);
    }
    const hasReview = !!rec;
    if (hasReview) reviewed++;
    if (hasReview && rec.marks && rec.marks.giveupTriggered === true) giveup++;
    out.push({
      name: r.name || null,
      code: r.code || (sym || null),
      rating: hasReview ? ((rec.marks && rec.marks.rating) || null) : null,
      giveupTriggered: hasReview ? !!(rec.marks && rec.marks.giveupTriggered) : null,
      reviewDate: hasReview ? (rec.date || null) : null,
      hasReview,
    });
  }
  return { poolDate: pool.date, total: out.length, reviewed, giveupTriggered: giveup, rows: out };
}

/* ────────────────────────── 数据采集 ────────────────────────── */

async function getQuoteData(symbol) {
  const { getQuote, fetchEastmoneyHistory } = require('./stockData');
  const quoteHub = require('./quoteHub');
  const out = { raw: null, hub: null, prev: null, error: null };
  try {
    const q = await getQuote(symbol);
    if (q && q.price) {
      // 字段实测（20261110e 修正）：实时行情换手率字段 = turnover(%)；amount 单位 = 元（须 /1e8 转亿）
      out.raw = {
        symbol: q.code || symbol, name: q.name || null, date: q.date || null, time: q.time || null,
        open: round2(q.open), high: round2(q.high), low: round2(q.low), price: round2(q.price),
        prevClose: round2(q.prevClose), changePct: round2(q.changePct),
        turnoverRate: round2(q.turnover), amountYi: round2(Number(q.amount) / 1e8), volume: q.volume || null,
      };
      // 前一交易日成交额/换手率：东财历史 bar 含 amount(元)/turnover(%)（getHistory 的 tencent 通道 bar 无 amount，实测踩坑）
      try {
        const bars = (await fetchEastmoneyHistory(symbol, 6)) || [];
        const dateStr = q.date || todayStr();
        const prevBar = bars.filter(b => b && b.date && b.date < dateStr).pop();
        if (prevBar && prevBar.amount > 0) {
          out.prev = { date: prevBar.date, amountYi: round2(prevBar.amount / 1e8), turnoverRate: round2(prevBar.turnover) };
        }
      } catch (e) { /* 前日成交额缺失不影响主行情 */ }
    } else {
      out.error = '未获取到行情数据';
    }
  } catch (e) { out.error = String(e.message || e).slice(0, 160); }
  // 行情规则合规包装（五要素/时效/边际），失败不影响 raw
  try { out.hub = await quoteHub.getQuoteHub(symbol); } catch (e) { /* 快照层降级 */ }
  return out;
}

async function getCapitalData(symbol, name, quote, history) {
  try {
    const { analyzeCapitalFlow } = require('./capitalFlow');
    const c = await analyzeCapitalFlow(symbol, name || '', quote, history || []);
    if (!c) return null;
    // moneyFlow.summary 实测为双层嵌套对象 { summary: { '5d': { mainNet, direction, ... } }, recent5: [...] }（单位已为亿）→ 代码拼成可读字符串
    const s0 = (c.moneyFlow && c.moneyFlow.summary) || null;
    const s = (s0 && s0.summary) ? s0.summary : s0;
    let summaryText = null;
    if (s && typeof s === 'object') {
      summaryText = ['5d', '10d', '20d']
        .filter(p => s[p] && typeof s[p].mainNet === 'number')
        .map(p => p.replace('d', '日') + '主力' + (s[p].direction || (s[p].mainNet >= 0 ? '净流入' : '净流出')) + ' ' + Math.abs(s[p].mainNet) + ' 亿')
        .join('；') || null;
    } else if (typeof s === 'string') {
      summaryText = s;
    }
    const daily = ((c.moneyFlow && c.moneyFlow.daily) || []).slice(-5).map(d => ({
      date: d.date || null,
      mainNetYi: (typeof d.mainNet === 'number') ? round2(d.mainNet / 1e8) : (d.mainNet || null),
    }));
    // [20261111c] 资金量能模块（volumeEngine）已由 analyzeCapitalFlow 内部算好，复用其结论透出量能/量价，
    // 供个股复盘 Context 的「量能/分时」栏目引用，根治此前量能数据缺失（避免重复跑引擎）。
    const ve = (c && c.volumeEngine) || null;
    let volume = null;
    if (ve) {
      const vs = ve.volumeState || null;
      volume = {
        ok: ve.ok !== false,
        volumeState: vs ? {
          level: (vs.level != null) ? vs.level : null,
          ratio5: (vs.ratio5 != null) ? vs.ratio5 : null,
          ratio10: (vs.ratio10 != null) ? vs.ratio10 : null,
          ratio20: (vs.ratio20 != null) ? vs.ratio20 : null,
          avg5: (vs.avg5 != null) ? vs.avg5 : null,
          avg10: (vs.avg10 != null) ? vs.avg10 : null,
          avg20: (vs.avg20 != null) ? vs.avg20 : null,
          turnoverToday: (vs.turnoverToday != null) ? vs.turnoverToday : null,
        } : null,
        volumeTier: (ve.volumeTier != null) ? ve.volumeTier : null,
        position: (ve.position && ve.position.label) ? { label: ve.position.label, pricePct12m: (ve.position.pricePct12m != null) ? ve.position.pricePct12m : null } : null,
        dataGaps: Array.isArray(ve.dataGaps) ? ve.dataGaps : null,
      };
    }
    return {
      conclusion: c.conclusion || null,
      moneyFlowSummary: summaryText,
      moneyFlowSource: (c.moneyFlow && c.moneyFlow.source) || null,
      recent5Flow: daily,
      floatMarketCapYi: c.floatMarketCapYi || null,
      volume,
    };
  } catch (e) { return { error: String(e.message || e).slice(0, 160) }; }
}

async function getSectorData(symbol, name) {
  try {
    const { getSectorLimitStats } = require('./sectorLimitStats');
    const { resolveSectorIdentity } = require('./sectorIdentity');
    // [20261111c] 先由行业分析模块（sectorIdentity）解析该股真实行业，
    // 再带着 industry 入参去查板块涨跌停，根治此前「行业识别失败」导致整块板块数据缺失。
    let industry = '';
    try {
      const idn = await resolveSectorIdentity(symbol, name || '');
      industry = (idn && idn.industry) || '';
    } catch (e) {
      console.warn('[StockReview] 行业识别失败，板块涨跌停按原口径降级：' + String((e && e.message) || e).slice(0, 120));
    }
    const s = await getSectorLimitStats(symbol, name || '', industry);
    const resolvedIndustry = industry || (s && s.industryName) || null;
    // 实测返回 ok:false 时其余字段全为 null → 不得 raw dump，代码判定后如实标注数据缺失
    if (!s || s.ok === false || (s.limitUp == null && s.industryName == null)) {
      // 即便涨跌停统计取不到，只要行业识别成功，也要把行业名透出，避免「行业识别失败」空白
      if (resolvedIndustry) {
        return {
          industryName: resolvedIndustry, industrySource: (s && s.industrySource) || 'sectorIdentity',
          limitUp: s ? s.limitUp : null, limitDown: s ? s.limitDown : null, total: s ? s.total : null,
          date: s ? s.date || null : null, missing: true,
          note: '已识别行业（' + resolvedIndustry + '），但板块涨跌停统计暂不可用（数据源无该板块或脚本未覆盖）',
        };
      }
      return { missing: true, note: '板块涨跌停数据不可用（行业识别失败或数据源无该股板块）' };
    }
    return {
      industryName: s.industryName || resolvedIndustry,
      boardName: s.boardName || null,
      industrySource: (s && s.industrySource) || (industry ? 'sectorIdentity' : null),
      limitUp: s.limitUp, limitDown: s.limitDown, total: s.total,
      date: s.date || null,
    };
  } catch (e) { return { missing: true, note: '板块涨跌停数据获取失败：' + String(e.message || e).slice(0, 120) }; }
}

async function getNewsData(symbol, name) {
  try {
    const { getNews } = require('./newsSearch');
    const list = await getNews(symbol, name || '');
    return (list || []).slice(0, NEWS_LIMIT).map(n => ({
      title: n.title || '',
      date: n.date || '',
      source: n.source || '',
      sentiment: n.sentiment || '',
    }));
  } catch (e) { return [{ title: '消息面获取失败：' + String(e.message || e).slice(0, 120), date: '', source: '', sentiment: '' }]; }
}

const _lhbCache = new Map();
async function getLhbData(symbol, date) {
  // [20261111c] 个股复盘补龙虎榜：轻量走 --lhb-only（不跑全量连板池，省时）。
  // 按代码精确匹配全量上榜明细 byCode → 真实判定「上榜 / 未上榜」，不臆造、不留白。
  const cacheKey = String(date);
  try {
    const { getLhbOnly } = require('./boardReviewData');
    let data;
    if (_lhbCache.has(cacheKey)) data = _lhbCache.get(cacheKey);
    else {
      data = await getLhbOnly(date);
      _lhbCache.set(cacheKey, data);
      setTimeout(() => { if (_lhbCache.get(cacheKey) === data) _lhbCache.delete(cacheKey); }, 5 * 60 * 1000);
    }
    const lhb = data && data.lhb;
    if (!lhb || lhb.ok === false) {
      return { available: false, note: (lhb && lhb.note) || '龙虎榜数据源暂不可用' };
    }
    const out = {
      available: true,
      asOf: lhb.asOf || date,
      marketCount: (lhb.count != null) ? lhb.count : null,
      netBuyTotalYi: (lhb.netBuyTotal != null) ? lhb.netBuyTotal : null,
      buyTotalYi: (lhb.buyTotal != null) ? lhb.buyTotal : null,
      sellTotalYi: (lhb.sellTotal != null) ? lhb.sellTotal : null,
      institutionBuyMentions: (lhb.institutionBuyMentions != null) ? lhb.institutionBuyMentions : null,
      institutionSellMentions: (lhb.institutionSellMentions != null) ? lhb.institutionSellMentions : null,
      reasonStats: Array.isArray(lhb.reasonStats) ? lhb.reasonStats.slice(0, 5) : [],
      topNetBuy: Array.isArray(lhb.topNetBuy) ? lhb.topNetBuy.slice(0, 3) : [],
      topNetSell: Array.isArray(lhb.topNetSell) ? lhb.topNetSell.slice(0, 3) : [],
      source: lhb.source || null,
    };
    const byCode = (lhb.byCode && typeof lhb.byCode === 'object') ? lhb.byCode : null;
    const mine = byCode ? byCode[String(symbol)] : null;
    if (mine) {
      out.listed = true;
      out.netBuyYi = (mine.netBuyYi != null) ? mine.netBuyYi : null;
      out.buyYi = (mine.buyYi != null) ? mine.buyYi : null;
      out.sellYi = (mine.sellYi != null) ? mine.sellYi : null;
      out.reason = mine.reason || null;
      out.changePct = (mine.changePct != null) ? mine.changePct : null;
      out.note = '该股今日上榜龙虎榜（按代码精确匹配全量明细）';
    } else if (byCode) {
      out.listed = false;
      out.note = '今日未上龙虎榜（当日全市场共 ' + ((lhb.count != null) ? lhb.count : '?') + ' 只上榜，按代码精确核对）';
    } else {
      // 兼容旧版数据层（无 byCode）：仅有净买卖前5，未命中时不可判定，如实标注覆盖口径
      const top = [].concat(lhb.topNetBuy || [], lhb.topNetSell || []);
      const hit = top.find(x => x && String(x.code) === String(symbol));
      out.coverage = 'top5-only';
      if (hit) {
        out.listed = true;
        out.netBuyYi = (hit.netBuyYi != null) ? hit.netBuyYi : null;
        out.reason = hit.reason || null;
        out.note = '该股进入当日龙虎榜净买卖前5（旧版数据层仅有前5名单）';
      } else {
        out.listed = null;
        out.note = '数据层仅保留净买卖前5，该股是否上榜不可精确判定（不臆断为未上榜）';
      }
    }
    return out;
  } catch (e) { return { available: false, note: '龙虎榜取数失败：' + String(e.message || e).slice(0, 120) }; }
}

/* ────────────────────── 分时特征（代码权威 · 20261111d） ────────────────────── */

/**
 * 分钟点 → 结构化分时特征（纯函数，导出供单测）。
 * 原始 240+ 条分钟点不进 LLM Context（体积控制）；分段涨跌 / 量能占比 / 形态全部由代码算，
 * LLM 只负责把特征写成人话，符合「确定性逻辑必须由代码执行，LLM 仅叙事」。
 * volume 可为累计量（腾讯 cumVol，单调递增）或当分钟量（AKShare），按单调性自动识别。
 */
function summarizeIntraday(points, prevClose, date, source, extra) {
  const pts = (Array.isArray(points) ? points : [])
    .filter(p => p && isFinite(Number(p.price)) && Number(p.price) > 0);
  if (pts.length < 30) return null;
  const n = pts.length;
  const prices = pts.map(p => Number(p.price));
  const first = prices[0], last = prices[n - 1];
  let hi = -Infinity, lo = Infinity, hiI = 0, loI = 0;
  for (let i = 0; i < n; i++) {
    if (prices[i] > hi) { hi = prices[i]; hiI = i; }
    if (prices[i] < lo) { lo = prices[i]; loI = i; }
  }
  const pc = (prevClose != null && isFinite(Number(prevClose)) && Number(prevClose) > 0) ? Number(prevClose) : null;
  const avgVals = pts.map(p => (p.avg != null && isFinite(Number(p.avg)) && Number(p.avg) > 0) ? Number(p.avg) : null);
  const avgLast = avgVals.filter(v => v != null).pop() || null;

  const rawVol = pts.map(p => {
    const v = Number(p.volume);
    return (isFinite(v) && v >= 0) ? v : null;
  });
  const known = rawVol.filter(v => v != null).length;
  let cumulative = false;
  if (known >= n * 0.8) {
    cumulative = true;
    for (let i = 1; i < n; i++) {
      if (rawVol[i] == null || rawVol[i - 1] == null) continue;
      if (rawVol[i] < rawVol[i - 1]) { cumulative = false; break; }
    }
  }
  const perVol = rawVol.map((v, i) => {
    if (v == null) return 0;
    if (!cumulative) return v;
    return i === 0 ? v : Math.max(0, v - (rawVol[i - 1] || 0));
  });
  const volTotal = perVol.reduce((a, b) => a + b, 0);
  let peakI = 0;
  for (let i = 1; i < n; i++) if (perVol[i] > perVol[peakI]) peakI = i;

  // 按时间戳分段，不按数组下标（避免盘后 15:01-15:30 零量条目污染「尾盘」）
  // 半开区间 [from, to)：每个分钟点恰好归入一段，且 0930 开盘、1130/1300/1500 边界点均不丢；
  // 尾盘 to=1501 覆盖 15:00 收盘，同时把腾讯 15:01-15:30 的盘后零量条目排除在外。
  const SEGS = [
    { name: '早盘', from: '0930', to: '1000' },
    { name: '上午', from: '1000', to: '1131' },
    { name: '午后', from: '1300', to: '1430' },
    { name: '尾盘', from: '1430', to: '1501' },
  ];
  const segments = SEGS.map(s => {
    const idx = [];
    for (let i = 0; i < n; i++) {
      const t = String(pts[i].time || '');
      if (t >= s.from && t < s.to) idx.push(i);
    }
    if (!idx.length) return { name: s.name, chgPct: null, volPct: null };
    const a = prices[idx[0]], b = prices[idx[idx.length - 1]];
    const segVol = idx.reduce((sum, i) => sum + perVol[i], 0);
    return {
      name: s.name,
      from: String(pts[idx[0]].time || ''), to: String(pts[idx[idx.length - 1]].time || ''),
      chgPct: a > 0 ? round2((b - a) / a * 100) : null,
      volPct: volTotal > 0 ? round2(segVol / volTotal * 100) : null,
    };
  });
  const tail = segments.find(s => s.name === '尾盘') || {};
  const chgFromPrev = pc ? round2((last - pc) / pc * 100) : null;
  const amplitudePct = (pc && pc > 0) ? round2((hi - lo) / pc * 100) : (lo > 0 ? round2((hi - lo) / lo * 100) : null);
  const tailChgPct = (tail.chgPct != null) ? tail.chgPct : null;

  // 形态为确定性判定，LLM 不得自行改判。
  // roseFromOpen：确有「冲高」过程（高点高于开盘 0.3%），否则开在最高一路下行应判「单边下行」而非「冲高回落」。
  const roseFromOpen = hi > first * 1.003;
  const fellFromOpen = lo < first * 0.997;
  let pattern;
  if (amplitudePct != null && amplitudePct < 1.0 && chgFromPrev != null && Math.abs(chgFromPrev) < 0.5) pattern = '窄幅横盘';
  else if (!roseFromOpen && loI > n * 0.75 && chgFromPrev != null && chgFromPrev < -0.8) pattern = '单边下行';
  else if (roseFromOpen && hiI < n * 0.25 && chgFromPrev != null && chgFromPrev < -0.3) pattern = '冲高回落';
  else if (fellFromOpen && loI < n * 0.25 && chgFromPrev != null && chgFromPrev > 0.3) pattern = '探底回升';
  else if (tailChgPct != null && tailChgPct >= 0.4) pattern = '尾盘拉升';
  else if (tailChgPct != null && tailChgPct <= -0.4) pattern = '尾盘跳水';
  else pattern = '震荡反复';

  return {
    available: true,
    source: source || null,
    date: date || null,
    dateMatches: (extra && extra.dateMatches != null) ? !!extra.dateMatches : null,
    degradedFrom: (extra && extra.degradedFrom) || null,
    points: n,
    prevClose: pc,
    open: round2(first), close: round2(last), high: round2(hi), low: round2(lo),
    highTime: String(pts[hiI].time || ''), lowTime: String(pts[loI].time || ''),
    changePctFromPrev: chgFromPrev,
    amplitudePct,
    avgPriceLast: avgLast != null ? round2(avgLast) : null,
    closeVsAvgPct: avgLast ? round2((last - avgLast) / avgLast * 100) : null,
    peakVolTime: String(pts[peakI].time || ''),
    tailChgPct,
    tailVolPct: (tail.volPct != null) ? tail.volPct : null,
    segments,
    pattern,
  };
}

const _intradayCache = new Map();
async function getIntradayData(symbol, date, quote) {
  const prevClose = (quote && quote.prevClose != null) ? quote.prevClose : null;
  const key = String(symbol) + '|' + String(date);
  if (_intradayCache.has(key)) return _intradayCache.get(key);
  const put = (v) => {
    _intradayCache.set(key, v);
    setTimeout(() => { if (_intradayCache.get(key) === v) _intradayCache.delete(key); }, 5 * 60 * 1000);
    return v;
  };

  // ① 首选 AKShare（用户指定；脚本 --intraday-symbol 早退通道）
  let akshareNote = null;
  try {
    const { getIntraday } = require('./boardReviewData');
    const a = await getIntraday(symbol, date);
    if (a && a.ok && Array.isArray(a.points) && a.points.length >= 30) {
      const asOf = a.asOf || a.date || date;
      const s = summarizeIntraday(a.points, prevClose, asOf, 'AKShare ' + (a.source || ''), { dateMatches: asOf === date });
      if (s) return put(s);
    }
    akshareNote = a ? (a.note || ('分时点不足 30（' + ((a.points && a.points.length) || 0) + '）')) : '无返回';
  } catch (e) { akshareNote = String((e && e.message) || e).slice(0, 120); }

  // ② 降级：项目现成的腾讯分时（同源、零新增依赖；AKShare 不可达时保证数据真实可用）
  try {
    const sd = require('./stockData');
    const info = (typeof sd.detectMarket === 'function') ? (sd.detectMarket(symbol) || {}) : {};
    const tc = info.tencentCode || (/^6/.test(String(symbol)) ? 'sh' + symbol : 'sz' + symbol);
    const m = await sd.fetchTencentMinutes(tc);
    if (m && Array.isArray(m.minutes) && m.minutes.length >= 30) {
      // 只留连续竞价时段：腾讯分钟数组常带 15:01-15:30 盘后零量条目，
      // 不过滤会稀释四段量能占比、并把 15:30 当成末点（与 volumeEngine 既有教训同口径）。
      const pts = m.minutes
        .filter(p => {
          const t = String((p && p.time) || '');
          return /^\d{4}$/.test(t) && ((t >= '0930' && t <= '1130') || (t >= '1300' && t <= '1500'));
        })
        .map(p => ({ time: String(p.time), price: Number(p.price), avg: Number(p.avg), volume: Number(p.cumVol) }));
      const asOf = m.date || date;
      const s = summarizeIntraday(pts, m.prevClose || prevClose, asOf, '腾讯分时 ifzq.gtimg.cn', {
        dateMatches: asOf === date,
        degradedFrom: 'AKShare 分时不可用：' + String(akshareNote || '').slice(0, 100),
      });
      if (s) return put(s);
    }
  } catch (e) {
    // 降级链最后一层：如实打日志并标注不可用，绝不静默吞错、更不臆造分时数值（R17 anti-swallow-catch）
    console.warn('[StockReview] 腾讯分时降级失败：' + String((e && e.message) || e).slice(0, 120));
  }

  return put({
    available: false, source: null, date, dateMatches: null, points: 0,
    note: '分时数据不可用：AKShare（' + String(akshareNote || '无返回') + '）；腾讯分时降级亦无有效数据',
  });
}

/* ────────────────────────── 历史追踪 ────────────────────────── */

/** 某只股票全部已落盘复盘记录（按日期倒序）。 */
function listReviews(symbol) {
  const dir = path.join(DATA_DIR, String(symbol));
  let files = [];
  try {
    files = fs.readdirSync(dir).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse();
  } catch (e) { return []; }
  const out = [];
  for (const n of files) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      out.push({
        date: r.date || n.replace('.json', ''),
        name: r.name || null,
        rating: (r.marks && r.marks.rating) || null,
        giveupTriggered: !!(r.marks && r.marks.giveupTriggered),
        giveupStreak: r.giveupStreak || 0,
        llm: r.llm ? { degraded: !!r.llm.degraded, model: r.llm.model || null } : null,
      });
    } catch (e) { /* 损坏文件跳过，不臆造 */ }
  }
  return out;
}

/**
 * 截至给定位点（不含当日）的连续放弃信号天数。
 * 从最近一天往回数，连续 giveupTriggered===true 才累计，遇 false/无记录即停。
 */
function computeGiveupStreak(symbol, beforeDate) {
  const list = listReviews(symbol).filter(r => !beforeDate || r.date < beforeDate);
  let streak = 0;
  for (const r of list) {
    if (r.giveupTriggered) streak++;
    else break;
  }
  return streak;
}

/**
 * [20261111 升级] 捞取该股过去 1-3 日已落盘复盘，作为「历史自省」原料喂给大模型。
 * 返回每条：日期、评级、放弃信号、以及当日的「明日剧本推演与验证」原文（彼时的预判），
 * 供大模型在第 4 节对照今日实际数据做「往日判断核查 / 错误归因」。
 * 仅在 beforeDate 之前的记录里取（不含当日），按日期倒序最多 limit 条。
 */
function getPastReviews(symbol, beforeDate, limit) {
  const list = listReviews(symbol)
    .filter(r => !beforeDate || r.date < beforeDate)
    .slice(0, limit || 3);
  return list.map(r => {
    let script = '';
    // [20261111] 改用 store.readJsonSafe：损坏/缺失文件由 store 留痕 warn + 返回 fallback，杜绝静默空 catch
    const full = store.readJsonSafe(reviewFile(symbol, r.date), null).data;
    if (full && full.markdown) {
      script = extractScriptSection(full.markdown);
      if (!script) script = String(full.markdown).slice(0, 1200);
    }
    return {
      date: r.date,
      rating: r.rating,
      giveupTriggered: !!r.giveupTriggered,
      script,
    };
  });
}

/**
 * 从复盘 markdown 中确定性抽取「明日剧本推演与验证」整节（供反查 Context 与新版历史自省）。
 * 兼容旧格式（#### 三、）与新格式（**3. / ### 三、 明日剧本推演与验证），按关键词定位，
 * 截到下一个同级标题 / 分隔线 / 第四节之前或文件结尾。
 */
function extractScriptSection(markdown) {
  const md = String(markdown || '');
  const kw = md.search(/明日剧本推演与验证/);
  if (kw === -1) return '';
  const lineStart = md.lastIndexOf('\n', kw) + 1;
  const rest = md.slice(lineStart);
  const m = rest.match(/[\s\S]*?(?=\n#{2,4}\s|\n\*\*[1-4][\.、]\s|\n---|\n###\s四|\n####\s四|$)/);
  return (m ? m[0] : rest).trim().slice(0, 2200);
}

/**
 * 连续放弃信号反查：连续 ≥3 天触发时激活，携带最近 3 天的剧本推演原文。
 */
function buildBackcheck(symbol, beforeDate, streak) {
  if (!streak || streak < 3) return { active: false, days: 0, days_detail: [] };
  const list = listReviews(symbol).filter(r => (!beforeDate || r.date < beforeDate) && r.giveupTriggered).slice(0, streak);
  const days_detail = list.slice(0, 3).map(r => {
    let script = '';
    try {
      const full = JSON.parse(fs.readFileSync(reviewFile(symbol, r.date), 'utf8'));
      script = extractScriptSection(full.markdown);
    } catch (e) { /* 损坏文件降级 */ }
    return { date: r.date, rating: r.rating, script };
  });
  return { active: true, days: streak, days_detail };
}

/* ────────────────────────── Context 组装 ────────────────────────── */

async function buildContext(symbolInput, opts) {
  const o = opts || {};
  const date = o.date || todayStr();
  const quoteData = await getQuoteData(symbolInput);
  const raw = quoteData.raw;
  const symbol = (raw && raw.symbol) || symbolInput;
  const name = (raw && raw.name) || o.name || null;

  // 名称 → 代码解析结果由 generateReview 传入（B0-1：解析只做一次，查缓存与落盘共用同一键）。
  // 兼容旧调用（直接以名称调用 buildContext 时）仍走一次确定性解析。
  let resolved = (o.resolved && o.resolved.resolved)
    ? { symbol: o.resolved.symbol, name: o.resolved.name || null, ambiguous: !!o.resolved.ambiguous }
    : null;
  if (!raw && !resolved && /^\D/.test(String(symbolInput)) && !/^\d{5,6}$/.test(String(symbolInput))) {
    const rs = await resolveSymbol(symbolInput, o.name);
    if (rs && rs.resolved) resolved = { symbol: rs.symbol, name: rs.name || null, ambiguous: !!rs.ambiguous };
  }

  const capital = await getCapitalData(symbol, name, raw, null);
  const [sector, news, lhb, intraday] = await Promise.all([
    getSectorData(symbol, name),
    getNewsData(symbol, name),
    getLhbData(symbol, date),
    getIntradayData(symbol, date, raw),
  ]);

  const streak = computeGiveupStreak(symbol, date);
  const backcheck = buildBackcheck(symbol, date, streak);
  // [20261111 升级] 过去 1-3 日复盘记录（供大模型第 4 节历史自省；含当日预判原文 + 评级）
  const pastReviews = getPastReviews(symbol, date, 3);

  // 大盘复盘观察池联动：优先按代码精确匹配（B0-2 起表格带代码列），无代码时回退名称匹配
  const pool = getPool();
  const poolEntry = (pool.rows.find(r => r.code && symbol && r.code === symbol))
    || (name && pool.rows.find(r => r.name === name))
    || null;

  return {
    schema: SCHEMA_VERSION,
    meta: { reviewDate: date, generatedAt: nowIso() },
    stock: { symbol, name, resolvedFromName: resolved },
    pool: { marketReviewDate: pool.date, entry: poolEntry },
    quote: { raw, hub: quoteData.hub && quoteData.hub.ok ? {
      // 仅保留五要素 latest（瘦身防 LLM 超时：analysis/shortTerm 的序列统计由 raw OHLC + 资金流承担）
      latest: quoteData.hub.latest, dataTime: quoteData.hub.dataTime,
    } : null, prev: quoteData.prev, fetchError: quoteData.error },
    capital,
    sector,
    news,
    volume: (capital && capital.volume) || null,
    lhb,
    intraday,
    history: { giveupStreak: streak, backcheck, pastReviews },
  };
}

/* ────────────────────── 标记抽取（代码权威） ────────────────────── */

/** 确定性抽取「> 评级判定：X」与「> 放弃信号判定：触发/未触发」。 */
function extractMarks(markdown) {
  const md = String(markdown || '');
  const rm = md.match(/>\s*评级判定[:：]\s*([SABC])\b/);
  const gm = md.match(/>\s*放弃信号判定[:：]\s*(触发|未触发)/);
  return {
    rating: rm ? rm[1] : null,
    giveupTriggered: gm ? gm[1] === '触发' : null,
    ratingMarkFound: !!rm,
    giveupMarkFound: !!gm,
  };
}

/* ────────────────────────── LLM 生成 ────────────────────────── */

function cleanMarkdown(s) {
  let t = String(s == null ? '' : s).trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i;
  const m = t.match(fence);
  if (m) t = m[1].trim();
  return t;
}

/** LLM 失败时的确定性数据快照（照常发布，不拒绝）。 */
function toSnapshotMarkdown(context, reason) {
  const s = context || {};
  const q = (s.quote && s.quote.raw) || {};
  const prev = (s.quote && s.quote.prev) || null;
  const cap = s.capital || {};
  const L = [];
  L.push('### 🔍 ' + (q.name || s.stock.symbol || '未知') + '（' + (s.stock.symbol || '-') + '）复盘卡片 · ' + (s.meta.reviewDate || ''));
  L.push('');
  L.push('> ⚠️ AI 生成暂不可用（' + String(reason || '').slice(0, 120) + '），以下为数据快照，不输出判断结论。');
  L.push('');
  L.push('| 项目 | 值 |');
  L.push('|---|---|');
  L.push('| 开盘/最高/最低 | ' + [q.open, q.high, q.low].map(v => v == null ? '-' : v).join(' / ') + ' |');
  L.push('| 收盘/涨跌幅 | ' + (q.price == null ? '-' : q.price) + ' / ' + (q.changePct == null ? '-' : q.changePct + '%') + ' |');
  L.push('| 换手率 | ' + (q.turnoverRate == null ? '数据缺失' : q.turnoverRate + '%') + ' |');
  L.push('| 成交额(亿) | ' + (q.amountYi == null ? '数据缺失' : q.amountYi) + (prev && prev.amountYi != null ? '（前一日 ' + prev.amountYi + '）' : '') + ' |');
  if (cap.moneyFlowSummary) L.push('| 资金摘要 | ' + String(cap.moneyFlowSummary).slice(0, 160) + ' |');
  if (s.sector && !s.sector.missing) L.push('| 板块联动 | ' + [s.sector.industryName, s.sector.limitUp != null ? '涨停 ' + s.sector.limitUp + ' 家' : null, s.sector.limitDown != null ? '跌停 ' + s.sector.limitDown + ' 家' : null].filter(Boolean).join(' · ') + ' |');
  else if (s.sector && s.sector.note) L.push('| 板块联动 | 数据缺失（' + String(s.sector.note).slice(0, 100) + '） |');
  if (s.lhb && s.lhb.available) {
    if (s.lhb.listed) L.push('| 龙虎榜 | 今日上榜：净买额 ' + (s.lhb.netBuyYi != null ? s.lhb.netBuyYi + ' 亿' : '-') + (s.lhb.reason ? '（' + s.lhb.reason + '）' : '') + (s.lhb.marketCount != null ? '；全市场上榜 ' + s.lhb.marketCount + ' 只' : '') + ' |');
    else L.push('| 龙虎榜 | ' + String(s.lhb.note || '今日未上龙虎榜') + ' |');
  } else if (s.lhb && s.lhb.note) L.push('| 龙虎榜 | 数据源暂不可用（' + String(s.lhb.note).slice(0, 100) + '） |');
  if (s.volume && s.volume.ok) {
    const v = s.volume;
    // volumeTier 是对象（{tier, ratio20, ...}），只取档位文本，禁止拼接整个对象产生 [object Object]
    const vt = v.volumeTier;
    const tier = (vt && typeof vt === 'object') ? (vt.tier || vt.level || vt.label || '-') : (vt != null ? vt : '-');
    L.push('| 量能 | 量比(÷5日) ' + ((v.volumeState && v.volumeState.ratio5 != null) ? v.volumeState.ratio5 : '-') + '；量能档位 ' + tier + '；位置 ' + ((v.position && v.position.label) ? v.position.label : '-') + ' |');
  }
  if (s.intraday && s.intraday.available) {
    const it = s.intraday;
    L.push('| 分时 | ' + [it.pattern, '开 ' + it.open + ' / 收 ' + it.close,
      '最高 ' + it.high + '@' + it.highTime, '最低 ' + it.low + '@' + it.lowTime,
      '尾盘 ' + (it.tailChgPct != null ? it.tailChgPct + '%' : '-'),
      '分钟点 ' + it.points].filter(Boolean).join(' · ') + ' |');
  } else if (s.intraday && s.intraday.note) {
    L.push('| 分时 | 数据源暂不可用（' + String(s.intraday.note).slice(0, 100) + '） |');
  }
  if (s.news && s.news.length) L.push('| 消息面 | ' + s.news.slice(0, 5).map(n => n.title).join('；').slice(0, 220) + ' |');
  L.push('');
  L.push('---');
  L.push('*本文为盘后观察记录，不构成任何投资建议。*');
  return L.join('\n');
}

async function llmGenerate(context, opts) {
  const o = opts || {};
  const started = Date.now();
  const { loadConfig, loadPromptFile } = require('./ai/config');
  const { callLLM, pickModelFor } = require('./ai/llm');
  // 20261110g P1-2：prompt 文件哈希进元信息（与 reviewLlm.js 同口径，提示词变更可追溯）
  let promptSha1 = null;
  try {
    promptSha1 = require('crypto').createHash('sha1')
      .update(fs.readFileSync(path.join(__dirname, '..', 'prompts', PROMPT_FILE), 'utf8'), 'utf8')
      .digest('hex').slice(0, 8);
  } catch (e) { /* prompt 文件缺失时 degraded 已拦截，此处保守置 null */ }
  const degraded = (reason, extra) => ({
    ok: false, degraded: true,
    markdown: toSnapshotMarkdown(context, reason),
    model: (extra && extra.model) || null, promptFile: PROMPT_FILE, promptSha1,
    error: String(reason || '').slice(0, 300), elapsedMs: (extra && extra.elapsedMs) || 0, contentChars: 0,
  });

  let cfg;
  try { cfg = loadConfig(); } catch (e) { return degraded('AI 配置读取失败：' + e.message); }
  if (!cfg || !cfg.apiKey) return degraded('未配置 AI 模型密钥（本机 AI 设置）');

  let systemPrompt;
  try { systemPrompt = loadPromptFile(PROMPT_FILE); } catch (e) { systemPrompt = ''; }
  if (!systemPrompt || systemPrompt.indexOf('个股每日复盘') === -1) {
    return degraded('复盘提示词 ' + PROMPT_FILE + ' 未加载成功');
  }

  const pick = pickModelFor(cfg, 'web');
  const model = pick.model || cfg.modelLocal || '';
  if (!model) return degraded('未配置可用模型（本机 AI 设置）');

  const date = (context && context.meta && context.meta.reviewDate) || '';
  const userText = [
    '以下是工作台代码采集并计算好的个股当日原始数据，JSON 是唯一事实来源。',
    '复盘日：' + date + '。请严格按你的系统提示词，生成这只股票的每日复盘 Markdown 卡片。',
    '',
    '```json',
    JSON.stringify(context),
    '```',
  ].join('\n');

  try {
    const raw = await callLLM(cfg.provider, cfg.apiKey, model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userText },
    ], { webSearch: false, timeoutMs: TIMEOUT_MS, overallBudgetMs: OVERALL_BUDGET_MS, force: !!o.force });
    const markdown = cleanMarkdown(raw);
    if (!markdown) return degraded('模型返回空内容', { model, elapsedMs: Date.now() - started });
    return {
      ok: true, degraded: false, markdown, model, promptFile: PROMPT_FILE, promptSha1, error: null,
      elapsedMs: Date.now() - started, contentChars: markdown.length,
    };
  } catch (e) {
    return degraded('LLM 调用失败：' + String((e && e.message) || e), { model, elapsedMs: Date.now() - started });
  }
}

/* ────────────────────────── 对外主流程 ────────────────────────── */

/**
 * [20261110f B0-1] 名称/代码 → 代码的确定性解析（零网络：已是 6 位代码即刻返回）。
 * 关键用途：让「查缓存」和「写缓存」使用同一个键（解析后的代码），
 * 否则从名称入口进入时永远 miss、每次都重跑一次 LLM（实测 1-3 分钟/次）。
 * @returns {Promise<{symbol:string,name:string|null,resolved:boolean,ambiguous:boolean}|null>}
 */
async function resolveSymbol(symbolInput, name) {
  const s = String(symbolInput == null ? '' : symbolInput).trim();
  if (/^\d{5,6}$/.test(s)) return { symbol: s, name: name || null, resolved: false, ambiguous: false };
  const embedded = s.match(/\b(\d{6})\b/);
  if (embedded) return { symbol: embedded[1], name: name || null, resolved: false, ambiguous: false };
  const q = name || s;
  if (!q) return null;
  try {
    const { searchStocks } = require('./stockData');
    const hits = (await searchStocks(q)) || [];
    if (!hits.length) return null;
    const exact = hits.find(h => (h.name || '') === q);
    const pick = exact || hits[0];
    return {
      symbol: pick.symbol, name: pick.name || q, resolved: true,
      // 同名词多条且无完全匹配 → 标记歧义，落盘如实标注（不假装确定）
      ambiguous: !exact && hits.length > 1,
    };
  } catch (e) { return null; }
}

/**
 * 生成（或读取缓存）某只股票某日的复盘。
 * @param {string} symbolInput 代码或名称（名称走 searchStocks 确定性解析）
 * @param {{date?:string, force?:boolean, name?:string}} opts
 */
async function generateReview(symbolInput, opts) {
  const o = opts || {};
  const date = o.date || todayStr();

  // [20261110f B0-1] 先解析、再用**落盘键**查缓存：修「名称入口永 miss → 每次重跑 LLM」。
  const resolved = await resolveSymbol(symbolInput, o.name);
  const symbol = (resolved && resolved.symbol) || symbolInput;
  const name = (resolved && resolved.name) || o.name || null;

  // 命中缓存直接返回（force 强制重生成；损坏 / 结构版本过期则走重生成路径）
  // [20261111c] SCHEMA_VERSION 升级铁律的「复用侧」：只升版本号、命中缓存时不比版本，
  // 旧记录会被永久复用——实测 601318 在 18:13 落的 20261110b 卡片，代码升到 20261111c 后
  // 打开页面 / 点「生成今日复盘」仍原样返回旧「缺失」文案（用户 19:16 截图）。
  // 旧 schema 记录一律视为过期，自动重生成，无需手动清缓存或强制刷新。
  if (!o.force && fs.existsSync(reviewFile(symbol, date))) {
    const cached = store.readJsonSafe(reviewFile(symbol, date), null).data;
    if (cached && cached.schemaVersion === SCHEMA_VERSION) return cached;
    if (cached) {
      console.warn('[StockReview] 复盘结构版本过期，自动重生成：' + symbol + ' ' + date + ' ' + cached.schemaVersion + ' → ' + SCHEMA_VERSION);
    }
  }

  const context = await buildContext(symbol, { date, name, resolved });
  const outSymbol = (context.stock && context.stock.symbol) || symbol;
  const gen = await llmGenerate(context, { force: !!o.force }); // [P1-1 裁决①] force 绕过 LLM 在途合并
  const marks = extractMarks(gen.markdown);
  const streak = computeGiveupStreak(outSymbol, date);

  const rec = {
    schemaVersion: SCHEMA_VERSION,
    symbol: outSymbol, name: (context.stock && context.stock.name) || null,
    date, createdAt: nowIso(),
    poolEntry: (context.pool && context.pool.entry) || null,
    poolDate: (context.pool && context.pool.marketReviewDate) || null,
    // [20261110f B0-1/B0-2] 名称解析留痕：从名称进入时记录解析结果与歧义，便于事后核对是否配错股
    resolve: {
      input: String(symbolInput == null ? '' : symbolInput),
      resolved: !!(resolved && resolved.resolved),
      ambiguous: !!(resolved && resolved.ambiguous),
    },
    giveupStreak: streak,
    marks, llm: {
      degraded: gen.degraded, model: gen.model, error: gen.error,
      elapsedMs: gen.elapsedMs, contentChars: gen.contentChars,
    },
    markdown: gen.markdown,
  };

  ensureDirFor(outSymbol);
  store.writeJsonAtomic(reviewFile(outSymbol, date), rec);
  return rec;
}

function getReview(symbol, date) {
  const f = reviewFile(symbol, date || todayStr());
  if (!fs.existsSync(f)) return null;
  return store.readJsonSafe(f, null).data;
}

function getLatestReview(symbol) {
  const list = listReviews(symbol);
  if (!list.length) return null;
  return getReview(symbol, list[0].date);
}

/**
 * [20261110f B0-4] 批量生成「当日大盘复盘观察池」个股复盘（20:35 定时槽 / 手动批次调用）。
 * 幂等：当日已有记录直接跳过（不调 LLM）；串行执行，单只失败不阻塞其余；LLM 降级如实计入 degraded。
 * @param {string} date 复盘日
 * @param {{force?:boolean, max?:number}} [opts]
 */
async function runPoolBatch(date, opts) {
  const o = opts || {};
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : todayStr();
  const typed = getPoolForDate(d);
  const pool = (typed.rows && typed.rows.length) ? typed : getPool();
  const rows = (pool.rows || []).slice(0, o.max || 12);
  const summary = {
    date: d, poolDate: pool.date || null, total: rows.length,
    generated: 0, skipped: 0, degraded: 0, failed: 0, errors: [],
  };
  for (const r of rows) {
    try {
      const rs = await resolveSymbol(r.code || r.name, r.name);
      if (!rs) { summary.failed++; summary.errors.push({ name: r.name || null, error: '名称解析失败' }); continue; }
      // [20261111c] 与 generateReview 同口径：结构版本过期的当日记录不算「已有」，交给生成链重算
      if (!o.force && fs.existsSync(reviewFile(rs.symbol, d))) {
        const cached = store.readJsonSafe(reviewFile(rs.symbol, d), null).data;
        if (cached && cached.schemaVersion === SCHEMA_VERSION) { summary.skipped++; continue; }
      }
      const rec = await generateReview(rs.symbol, { date: d, name: rs.name, force: !!o.force });
      if (rec && rec.llm && rec.llm.degraded) summary.degraded++; else summary.generated++;
    } catch (e) {
      summary.failed++;
      summary.errors.push({ name: r.name || null, error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  return summary;
}

/**
 * [20261112h] 批量生成「自选股池」个股复盘（15:30 定时槽 / 手动批次调用）。
 * 覆盖集合 = data/watchlist.json 全部标的（与 20:45 观察池批量并存、互不覆盖，二者来源不同）。
 * 幂等：当日已有且结构版本未过期的记录直接跳过（不调 LLM）；串行执行，单只失败不阻塞其余；LLM 降级如实计入 degraded。
 * @param {string} date 复盘日
 * @param {{force?:boolean}} [opts]
 */
async function runWatchlistBatch(date, opts) {
  const o = opts || {};
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : todayStr();
  let list = [];
  try {
    const WATCHLIST_FILE = path.join(__dirname, '..', 'data', 'watchlist.json');
    list = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')) || [];
  } catch (e) {
    console.warn('[StockReview] 读取自选股池失败，跳过 15:30 批次：', (e && e.message) || e);
    return { date: d, total: 0, generated: 0, skipped: 0, degraded: 0, failed: 0, errors: [{ error: 'watchlist 读取失败' }] };
  }
  const summary = {
    date: d, total: list.length,
    generated: 0, skipped: 0, degraded: 0, failed: 0, errors: [],
  };
  for (const w of list) {
    try {
      const rs = await resolveSymbol(w.symbol || w.name, w.name);
      if (!rs) { summary.failed++; summary.errors.push({ name: w.name || w.symbol || null, error: '代码解析失败' }); continue; }
      // [20261111c] 与 generateReview 同口径：结构版本过期的当日记录不算「已有」，交给生成链重算
      if (!o.force && fs.existsSync(reviewFile(rs.symbol, d))) {
        const cached = store.readJsonSafe(reviewFile(rs.symbol, d), null).data;
        if (cached && cached.schemaVersion === SCHEMA_VERSION) { summary.skipped++; continue; }
      }
      const rec = await generateReview(rs.symbol, { date: d, name: rs.name, force: !!o.force });
      if (rec && rec.llm && rec.llm.degraded) summary.degraded++; else summary.generated++;
    } catch (e) {
      summary.failed++;
      summary.errors.push({ name: w.name || w.symbol || null, error: String((e && e.message) || e).slice(0, 120) });
    }
  }
  return summary;
}

module.exports = {
  SCHEMA_VERSION, PROMPT_FILE, DATA_DIR, MARKET_REVIEW_DIR, TIMEOUT_MS, OVERALL_BUDGET_MS,
  parseWatchPool, normCode, getPool, getPoolForDate, poolMarksSummary,
  resolveSymbol, buildContext, generateReview, runPoolBatch, runWatchlistBatch,
  getReview, getLatestReview, listReviews, computeGiveupStreak, getPastReviews,
  extractMarks, extractScriptSection, buildBackcheck, toSnapshotMarkdown, todayStr,
  summarizeIntraday, // 20261111d 分时特征纯函数（导出供单测）
};
