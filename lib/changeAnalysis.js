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
  const existing = (history.analyses || []).find(
    (a) => a.key === key && now - new Date(a.date).getTime() < CACHE_TTL_MS
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
