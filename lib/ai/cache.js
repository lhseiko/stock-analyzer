/**
 * lib/ai/cache.js —— aiAugment 领域子模块：只读缓存层（拆分重构 202609）
 * ----------------------------------------------------------------
 * 循环依赖切割点：deepAnalysis 主流程对 readCache 的唯一依赖（原 L13 顶层 require('./aiAugment')）
 * 改为 lib/deep/pipeline.js 静态 require 本模块，加载期环消失。
 *
 * 版本常量随缓存函数迁入（版本号语义本就是「缓存门控」）：
 *   - EARNINGS_PROMPT_VERSION：readEarningsCache 门控（earnings.js 反向 require）
 *   - VALUATION_VER：readValuationCache 门控（valuation.js 反向 require）
 */
const fs = require('fs');
const path = require('path');
const { CACHE_DIR, SEMI_STATIC_TTL_MS } = require('./config');

// 只读接口读取已存缓存（不联网、不限 TTL），供前端打开个股页时自动展示
function readCache(symbol, suffix) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}${suffix || ''}.json`);
  if (!fs.existsSync(cacheFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch {
    return null;
  }
}

// 财报解读缓存读取（供短期判断因子复用）：不再因 promptVersion 不符直接丢弃——
// summary 文本仍可用，因子侧在缺 earningsSignal 时会按文本启发式兜底，确保旧缓存也能正确判定多空（任务 J）。
function readEarningsCache(symbol) {
  const cached = readCache(symbol, '_earnings');
  if (!cached) return null;
  if (cached.promptVersion !== EARNINGS_PROMPT_VERSION) cached.stale = true;
  return cached;
}

// 20260906：AI 估值 GET 只读缓存（版本+TTL 门控，不校验 factAnchor 以免打开页面拉取东财数据）。
// 供前端打开个股时自动展示已存结果；版本过期/无缓存返回 null——前端保持规则版，
// 用户点「✨ AI 估值」（force=true）才联网重算。此前 GET 走 analyzeValuation(force:false)
// 会在缓存 ver 过期时静默触发 LLM 重算：既违背单按钮口径（打开不消耗额度），失败时前端又无感知。
function readValuationCache(symbol) {
  const cacheFile = path.join(CACHE_DIR, `${symbol}_valuation.json`);
  if (!fs.existsSync(cacheFile)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (!cached || cached.ver !== VALUATION_VER) return null;
    if (Date.now() - new Date(cached.date).getTime() >= SEMI_STATIC_TTL_MS) return null;
    return {
      symbol: cached.symbol, stockName: cached.stockName, industry: cached.industry,
      content: cached.content, date: cached.date, model: cached.model, mode: cached.mode,
      localDataUsed: cached.localDataUsed, factAnchor: cached.factAnchor, ver: cached.ver,
    };
  } catch { return null; }
}

// ---------- 缓存版本常量（随对应 read*Cache 迁入，语义为「缓存门控」） ----------

// prompt 有变时递增此版本号，使旧缓存自动失效重拉（避免 7 天 TTL 内继续展示旧解读口径）
const EARNINGS_PROMPT_VERSION = '20260906c'; // 20260906c：恢复详细 8 维度输出（用户分工：深度分析卡=详细解读），保留 ≤1000 字精简提炼；行情判断小卡改为只引用 verdict 精简结论（sameDayJudgment 侧）。20260906b（4 行极简版）废弃。20260906a：取消 800 字上限。20260904c：修正 reportPeriod 提取 + summary 无条件剥离「报告期/标的」行；联网 AI 主路径 + 身份确认（防串公司）保持不变

// 缓存版本：v4=三表全注入+财报解读复用（旧缓存含 AI 自搜错误数据，强制失效重算）；v3=本地事实+规则模型交叉验证
const VALUATION_VER = 'v4';

module.exports = { EARNINGS_PROMPT_VERSION, VALUATION_VER, readCache, readEarningsCache, readValuationCache };
