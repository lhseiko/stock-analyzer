/**
 * lib/ai/deepSummary.js —— 深度分析页「全卡片总结」（任务卡 #028，方案 A：按需 AI + 磁盘缓存）
 * ---------------------------------------------------------------------------
 * 输入：前端在深度分析各卡片渲染完成后上送的「结论 + 关键数字」摘要（digest），
 *       本模块不重新取数、不联网搜索，只做归纳洞察，避免与深度分析主管线耦合。
 * 缓存：data/ai_cache/{裸6位码}_deep_summary.json；promptVersion + digestHash + 7 天 TTL 门控。
 * 额度：只在用户点击「生成全卡片总结」（force=true）或缓存失效重算时调用一次 LLM；
 *       打开页面走 GET 只读缓存，不消耗额度。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { CACHE_DIR, CACHE_TTL_MS, ensureDirs, loadConfig } = require('./config');
const { callLLM, pickModelFor } = require('./llm');
const { DEEP_SUMMARY_VERSION } = require('./cache');

const MAX_DIGEST_CHARS = 6000;   // 喂给模型的卡片摘要上限（防 Context 膨胀）
const MAX_SUMMARY_CHARS = 1600;  // 输出安全上限（目标 ≤600 字）

const DEEP_SUMMARY_SYSTEM_PROMPT = `你是顶级商业主编与资深数据分析师。用户会给你一只股票「深度分析页」各卡片的结论与关键数字（JSON 摘要），包括估值综合结论、最新财报解读、各财务图表小节结论、研报/公告摘要等。你的任务是把这些杂乱信息去噪、交叉印证后，写成一段直白、有概括性、全面、重点突出、层次分明的总览。

输出格式（严格，纯文本，不使用 Markdown 井号）：
第 1 行：总览：一句话概括这家公司当前的整体状态，点明最核心的矛盾（例如「主业稳增但投资端拖累、估值偏高」）。
随后：要点：3~5 条，每条单独一行并以「- 」开头，至少覆盖业绩趋势、估值水平、最新财报、风险/股东/资金等 4 个维度，保留关键数字与来源卡片名称。
随后：风险：1~2 条，每条单独一行并以「- 」开头。
最后：大白话：用两句普通人能懂的话总结，可用比喻。

纪律：
1) 只依据输入 JSON 里的信息，严禁编造数字或补充外部事实；某维度缺失就写「暂无数据」，不要硬凑。
2) 允许给出整体倾向定性（如主业稳/投资拖累/估值偏高/业绩恶化），但不得给任何买卖指令。
3) 卡片之间结论冲突时（例如财报说主业下滑、估值卡说低估），要并列表述并说明各自口径，不得擅自取舍。
4) 术语首次出现用大白话解释；总长不超过 600 字。`;

function normalizeSymbol(symbol) {
  return String(symbol == null ? '' : symbol).trim().replace(/^(sh|sz|bj)/i, '');
}

function cacheFile(symbol) {
  return path.join(CACHE_DIR, `${normalizeSymbol(symbol)}_deep_summary.json`);
}

// 稳定摘要哈希：卡片数据变化 → 哈希变化 → 旧总结视为过期，避免「卡片已更新、总结还是旧的」
function digestHash(digest) {
  const s = typeof digest === 'string' ? digest : JSON.stringify(digest || {});
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

function digestText(digest) {
  let s = '';
  try { s = typeof digest === 'string' ? digest : JSON.stringify(digest, null, 1); } catch { s = ''; }
  if (s.length > MAX_DIGEST_CHARS) s = s.slice(0, MAX_DIGEST_CHARS) + '\n…（摘要过长已截断）';
  return s;
}

function hasSubstance(digest) {
  const s = digestText(digest).replace(/[\s{}\[\]",:]/g, '');
  return s.length > 20; // 空对象/空壳不算有卡片数据
}

function postProcess(text) {
  let out = String(text || '').replace(/\r\n/g, '\n').trim();
  out = out.replace(/^#{1,6}\s+/gm, ''); // 前端按纯文本段落渲染，去掉 Markdown 井号
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1');
  if (out.length > MAX_SUMMARY_CHARS) {
    const cut = out.slice(0, MAX_SUMMARY_CHARS);
    const idx = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('。'));
    out = (idx > 200 ? cut.slice(0, idx + 1) : cut) + '\n…（内容过长已截断）';
  }
  return out;
}

function buildMessages(digest) {
  return [
    { role: 'system', content: DEEP_SUMMARY_SYSTEM_PROMPT },
    { role: 'user', content: '以下是该股票深度分析页各卡片的结论与关键数字摘要（JSON）：\n' + digestText(digest) },
  ];
}

function readCache(symbol) {
  const f = cacheFile(symbol);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

async function analyzeDeepSummary({ symbol, stockName, digest, force } = {}) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return { success: false, error: 'NO_SYMBOL', message: '缺少股票代码' };
  if (!hasSubstance(digest)) {
    return { success: false, error: 'NO_DIGEST', message: '缺少各卡片数据，请先让深度分析各卡片加载完成' };
  }
  const hash = digestHash(digest);
  const cached = readCache(sym);
  if (!force && cached && cached.summary && cached.promptVersion === DEEP_SUMMARY_VERSION && cached.digestHash === hash) {
    const t = cached.date ? new Date(cached.date).getTime() : 0;
    if (t && Date.now() - t < CACHE_TTL_MS) {
      return { success: true, cached: true, symbol: sym, stockName: cached.stockName || stockName, summary: cached.summary, date: cached.date, model: cached.model, promptVersion: cached.promptVersion };
    }
  }

  const cfg = loadConfig();
  if (!cfg || !cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const modelPick = pickModelFor(cfg, 'local'); // 纯推理：不联网搜索，只归纳已给定的卡片数据
  const messages = buildMessages(digest);
  const t0 = Date.now();
  const text = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, {
    webSearch: false, symbol: sym, task: 'deep_summary',
  });
  const summary = postProcess(text);
  if (!summary) return { success: false, error: 'EMPTY', message: 'AI 返回为空，请重试' };

  const record = {
    symbol: sym, stockName: stockName || (cached && cached.stockName) || '',
    summary, date: new Date().toISOString(), model: modelPick.model,
    promptVersion: DEEP_SUMMARY_VERSION, digestHash: hash,
  };
  try {
    ensureDirs();
    fs.writeFileSync(cacheFile(sym), JSON.stringify(record, null, 2), 'utf8');
  } catch (e) {
    return { success: false, error: 'CACHE_WRITE', message: '缓存写入失败：' + e.message };
  }
  console.log(`[AI 全卡片总结] ${sym} 生成完成（${Date.now() - t0}ms，model=${modelPick.model}）`);
  return { success: true, cached: false, ...record };
}

module.exports = {
  analyzeDeepSummary,
  // 以下为内部函数导出（供守卫脚本复用，避免测试真实调用 LLM）
  _postProcess: postProcess,
  _digestHash: digestHash,
  _digestText: digestText,
  _hasSubstance: hasSubstance,
  _buildMessages: buildMessages,
  _cacheFile: cacheFile,
  _readCache: readCache,
  DEEP_SUMMARY_SYSTEM_PROMPT,
};
