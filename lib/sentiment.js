/**
 * 市场情绪因子数据层（一期）
 * --------------------------------------------------------------
 * 调用 scripts/sentiment.py（akshare 量化 + snownlp 文本舆情 + 多平台股吧热度），
 * 返回 { symbol, breadth, margin, newsSentiment, marketSentiment, discussionHeat, signal, date, source }。
 * 复用 stockData 的 findPythonForScript；按 symbol 分别做极短内存缓存（5s），
 * 既避免同一页面反复拉取，又最大限度降低切换股票时的跨股污染窗口。
 * 任一子模块失败由 Python 侧降级；整个脚本失败（无 Python/缺依赖）
 * 则抛出异常，由上层 sameDayJudgment 捕获并转中性处理。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

// 按 symbol 分别缓存（修复：此前是全局单键缓存，60s 内连续分析多只股票时，
// 后分析的股票会复用第一只的股票情绪数据，造成严重的跨股污染——
// 例如 长江证券/海天味业 的市场情绪因子误用了华安证券(600909)的新闻情感）。
// 20260821a：TTL 从 30s 进一步缩短到 5s，并在返回数据中强制携带 symbol 供上层校验。
const _cache = new Map(); // symbol -> { ts, data }
const CACHE_TTL = 5000; // 5s：个股情绪缓存尽可能短，切换股票后几乎立即刷新
const CACHE_MAX = 128;

async function getMarketSentiment(symbol, name) {
  const key = String(symbol || '');
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.ts < CACHE_TTL) {
    return hit.data;
  }
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器，无法调用情绪数据接口');
  const script = path.join(__dirname, '..', 'scripts', 'sentiment.py');
  if (!fs.existsSync(script)) throw new Error('sentiment.py 不存在: ' + script);

  const args = [script, '--symbol', String(symbol || ''), '--name', String(name || '')];
  const out = await execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
    // SA_NO_FIN_MODEL=1：跳过 HuggingFace 金融情感模型下载（本机网络 WinError 10060 会卡死整脚本），
    // 直接走 snownlp + 金融词库兜底（本机可用），确保涨跌停比/融资余额/文本舆情/讨论热度子信号稳定产出。
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', SA_NO_FIN_MODEL: '1' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  // 强制携带 symbol，便于上层校验是否发生跨股污染
  const data = { ...parsed, symbol: key };
  _cache.set(key, { ts: now, data });
  // 轻量清理过期项，避免长期运行内存膨胀；过期项不足时清理最旧的
  if (_cache.size > CACHE_MAX) {
    for (const [k, v] of _cache) {
      if (now - v.ts >= CACHE_TTL) _cache.delete(k);
    }
    if (_cache.size > CACHE_MAX) {
      let oldestKey = null;
      let oldestTs = Infinity;
      for (const [k, v] of _cache) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
      }
      if (oldestKey) _cache.delete(oldestKey);
    }
  }
  return data;
}

module.exports = { getMarketSentiment };
