/**
 * 板块涨跌停占比数据层（短期情绪核心因子）
 * --------------------------------------------------------------
 * 调用 scripts/sector_limit_stats.py，返回：
 *   { ok, industryName, boardName, limitUp, limitDown, total,
 *     limitUpRatio, limitDownRatio, signal, note, threshold }
 * 复用 stockData 的 findPythonForScript；按 industry 键 60s 内存缓存。
 * 脚本失败（无 Python/缺依赖/全失败）则抛出异常，由上层捕获转中性处理。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

let _cache = {};
const CACHE_TTL = 60000; // 60s

function cacheKey(industry) {
  return `k:${industry || ''}`;
}

async function getSectorLimitStats(symbol, name, industry) {
  const key = cacheKey(industry);
  const now = Date.now();
  const hit = _cache[key];
  if (hit && now - hit.ts < CACHE_TTL) {
    return hit.data;
  }
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器，无法调用板块涨跌停占比接口');
  const script = path.join(__dirname, '..', 'scripts', 'sector_limit_stats.py');
  if (!fs.existsSync(script)) throw new Error('sector_limit_stats.py 不存在: ' + script);

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

module.exports = { getSectorLimitStats };
