/**
 * 人民银行宏观数据（社融，确定性数据，非 AI）Node 包装层。
 * 通过 async execFile 调用 scripts/pbc_social_financing.py（pandas 解析央行 xlsx）。
 * 失败时返回 {ok:false} 而非抛异常，由上层降级为占位卡片。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pbc_social_financing.py');
const CACHE_TTL = 6 * 3600 * 1000; // 6 小时内存缓存（社融为月度低频数据）
let _cache;
function _getCache() {
  if (_cache && Date.now() - _cache.ts < CACHE_TTL) return _cache.data;
  return undefined;
}
function _setCache(data) {
  _cache = { ts: Date.now(), data };
}

async function getSocialFinancing() {
  const cached = _getCache();
  if (cached) return cached;
  const py = await findPythonForScript();
  if (!py) return { ok: false, error: '未找到 Python 解释器' };
  if (!fs.existsSync(SCRIPT)) return { ok: false, error: 'pbc_social_financing.py 不存在' };
  try {
    const out = await execFileAsync(py, [SCRIPT], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 90000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const parsed = JSON.parse(out.stdout);
    const r = parsed && parsed.ok ? parsed : { ...(parsed || {}), ok: false };
    _setCache(r);
    return r;
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'PBC 调用失败' };
  }
}

module.exports = { getSocialFinancing };
