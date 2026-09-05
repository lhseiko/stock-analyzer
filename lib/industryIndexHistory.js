/**
 * 同花顺行业指数历史行情（K线数据）
 * --------------------------------
 * 封装 scripts/ths_industry_index_history.py，按行业名称拉取日线 OHLC，
 * 并提供单日缓存（按行业名 + 本地日期），供 /api/industry-index-history 使用。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'ths_industry_index_history.py');
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache', 'industry_index_history');
const DEFAULT_DAYS = 250; // 默认约 1 年
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 本地日期一致即命中，自然日 1 天

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
}

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function ensureDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch (e) { /* ignore */ }
}

function cacheFile(name) {
  ensureDir();
  return path.join(CACHE_DIR, `${safeName(name)}_${localDate()}.json`);
}

function readCache(name) {
  try {
    const f = cacheFile(name);
    if (!fs.existsSync(f)) return null;
    const stat = fs.statSync(f);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return null;
  }
}

function writeCache(name, data) {
  try {
    fs.writeFileSync(cacheFile(name), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { /* ignore */ }
}

function parseStdout(stdout) {
  const raw = String(stdout || '').trim();
  try {
    return JSON.parse(raw);
  } catch (e) {
    // 兼容 akshare tqdm 进度条混入 stdout：取最后一个 { ... }
    const m = raw.match(/\{[\s\S]*\}$/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (e2) { /* ignore */ }
    }
  }
  return null;
}

/**
 * 获取同花顺行业指数日线历史行情。
 * @param {string} industryName 行业名称（如"保险"）
 * @param {object} opts
 * @param {number} [opts.days=250] 取最近多少个交易日
 * @param {string} [opts.pythonPath] Python 解释器路径（由调用方传入，复用 server.js findPython）
 * @param {boolean} [opts.force=false] 是否忽略缓存强制重抓
 * @returns {Promise<{success:boolean, name?:string, code?:string, tradeDate?:string, data?:Array, source?:string, error?:string}>}
 */
async function getIndustryIndexHistory(industryName, opts = {}) {
  const { days = DEFAULT_DAYS, pythonPath, force = false } = opts;
  if (!industryName || !industryName.trim()) {
    return { success: false, error: '缺少行业名称' };
  }
  const name = industryName.trim();

  if (!force) {
    const cached = readCache(name);
    if (cached && cached.success && Array.isArray(cached.data) && cached.data.length > 0) {
      return { ...cached, cached: true };
    }
  }

  const py = pythonPath || process.env.PYTHON_BIN || process.env.PYTHON_PATH || 'python3';
  let stdout = '';
  try {
    const res = await execFileAsync(py, [SCRIPT, '--name', name, '--days', String(days)], {
      timeout: 120000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    stdout = (res && res.stdout) ? res.stdout : '';
  } catch (e) {
    return {
      success: false,
      error: '执行 Python 脚本失败: ' + (e && e.message),
      stderr: e && e.stderr ? String(e.stderr).slice(0, 500) : '',
    };
  }

  const data = parseStdout(stdout);
  if (!data) {
    return { success: false, error: '解析行情数据失败', raw: String(stdout).slice(0, 500) };
  }
  if (!data.ok) {
    return { success: false, error: data.error || '获取行情失败' };
  }
  if (!Array.isArray(data.data) || data.data.length === 0) {
    return { success: false, error: '无历史行情数据' };
  }

  const result = {
    success: true,
    name: data.name,
    code: data.code,
    tradeDate: data.tradeDate,
    data: data.data,
    source: data.source || '同花顺·行业板块',
    cached: false,
  };
  writeCache(name, result);
  return result;
}

module.exports = { getIndustryIndexHistory };
