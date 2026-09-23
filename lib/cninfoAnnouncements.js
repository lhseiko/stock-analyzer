/**
 * 巨潮资讯官方公告（确定性数据，非 AI）Node 包装层。
 * 通过 async execFile 调用 scripts/cninfo_announcements.py。
 * 失败时返回 {ok:false, items:[]} 而非抛异常，不影响个股页其他卡片。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPythonForScript } = require('./stockData');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'cninfo_announcements.py');
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟内存缓存
let _cache = {};
function _getCache(key) {
  const hit = _cache[key];
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;
  return undefined;
}
function _setCache(key, data) {
  _cache[key] = { ts: Date.now(), data };
}

function _normSymbol(symbol) {
  return String(symbol || '').replace(/^(SH|SZ|BJ)/i, '').replace(/\.(SS|SZ|BJ)$/i, '').trim();
}

async function getCninfoAnnouncements(symbol, max = 30) {
  const code = _normSymbol(symbol);
  if (!/^\d{6}$/.test(code)) return { ok: false, error: '非A股代码', items: [] };
  const key = 'cninfo:' + code + ':' + max;
  const cached = _getCache(key);
  if (cached) return cached;
  const py = await findPythonForScript();
  if (!py) return { ok: false, error: '未找到 Python 解释器，无法调用 cninfo 适配器' };
  if (!fs.existsSync(SCRIPT)) return { ok: false, error: 'cninfo_announcements.py 不存在: ' + SCRIPT };
  try {
    const out = await execFileAsync(py, [SCRIPT, code, String(max)], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60000,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const parsed = JSON.parse(out.stdout);
    const r = parsed && parsed.ok ? parsed : { ...(parsed || {}), ok: false, items: [] };
    _setCache(key, r);
    return r;
  } catch (e) {
    return { ok: false, error: (e && e.message) ? String(e.message).slice(0, 200) : 'cninfo 调用失败', items: [] };
  }
}

module.exports = { getCninfoAnnouncements };
