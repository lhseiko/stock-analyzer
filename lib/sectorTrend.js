/**
 * 行业板块走势因子数据层（三期）
 * --------------------------------------------------------------
 * 调用 scripts/sector_trend.py（akshare 行业板块整体涨跌），
 * 返回 { ok, industryName, boardName, boardChange, upCount, downCount, leader, leaderChange, source, note }。
 * 复用 stockData 的 findPythonForScript；按 industry 键 60s 内存缓存，避免重复拉取。
 * 脚本失败（无 Python/缺依赖/全失败）则抛出异常，由上层 sameDayJudgment 捕获并转中性处理。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

// 按行业名缓存（同板块的多只股票共享一次拉取结果）
let _cache = {};
const CACHE_TTL = 60000; // 60s

function cacheKey(industry) {
  return `k:${industry || ''}`;
}

async function getSectorTrend(symbol, name, industry) {
  const key = cacheKey(industry);
  const now = Date.now();
  const hit = _cache[key];
  if (hit && now - hit.ts < CACHE_TTL) {
    return hit.data;
  }
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器，无法调用行业板块走势接口');
  const script = path.join(__dirname, '..', 'scripts', 'sector_trend.py');
  if (!fs.existsSync(script)) throw new Error('sector_trend.py 不存在: ' + script);

  const args = [script, '--symbol', String(symbol || ''), '--name', String(name || ''), '--industry', String(industry || '')];
  const out = await execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  _cache[key] = { ts: now, data: parsed };
  return parsed;
}

/**
 * 批量获取多个行业板块当日走势（一次 Python 调用，供板块跷跷板因子取科技/半导体多板块）。
 * @param {string[]} industries 行业名数组，如 ['半导体','电子','计算机','通信']
 * @returns {Promise<{ok:boolean, multi:boolean, boards:{[industry]:{ok,boardName,boardChange,upCount,downCount,leader,leaderChange,source,note}}}>}
 */
async function getBoardsTrend(industries) {
  if (!Array.isArray(industries) || !industries.length) {
    return { ok: false, multi: true, boards: {} };
  }
  const key = 'm:' + industries.join(',');
  const now = Date.now();
  const hit = _cache[key];
  if (hit && now - hit.ts < CACHE_TTL) {
    return hit.data;
  }
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器，无法调用行业板块走势接口');
  const script = path.join(__dirname, '..', 'scripts', 'sector_trend.py');
  if (!fs.existsSync(script)) throw new Error('sector_trend.py 不存在: ' + script);

  const args = [script, '--industries', industries.join(',')];
  const out = await execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  _cache[key] = { ts: now, data: parsed };
  return parsed;
}

module.exports = { getSectorTrend, getBoardsTrend };
