/**
 * PDF 文本提取（本地资料库财报正文）
 * --------------------------------
 * 通过 scripts/pdf_extract_text.py（pdfplumber）提取财报 PDF 前 N 页正文，
 * 供财报解读本地上下文使用。结果按「文件路径 + mtime + 参数」缓存到
 * data/cache/pdf_text/，避免重复解析大文件（年报 PDF 通常 3-8MB）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawnSync } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'pdf_extract_text.py');
const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache', 'pdf_text');

let _pyCache = null;
let _pyChecked = false;

// 探测可用且带 pdfplumber 的 Python 解释器（候选顺序与 server.js findPython 一致，
// 但以 import pdfplumber 成功为准——本功能强依赖该库）
function findPdfPython() {
  if (_pyChecked) return _pyCache;
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-c', 'import pdfplumber'], { timeout: 15000, windowsHide: true });
      if (r && !r.error && r.status === 0) {
        _pyCache = c;
        _pyChecked = true;
        return c;
      }
    } catch (e) { /* 尝试下一个候选 */ }
  }
  _pyCache = null;
  _pyChecked = true;
  return null;
}

function cacheKeyOf(pdfPath, maxPages, charCap) {
  let mtime = 0;
  try { mtime = fs.statSync(pdfPath).mtimeMs; } catch (e) { /* ignore */ }
  const raw = `${pdfPath}|${mtime}|${maxPages}|${charCap}`;
  return crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
}

/**
 * 提取 PDF 前若干页正文。
 * @param {string} pdfPath 绝对路径
 * @param {object} opts { maxPages=40, charCap=28000, timeoutMs=150000 }
 * @returns {Promise<{ok:boolean, text?:string, pages?:number, total_pages?:number, truncated?:boolean, cached?:boolean, error?:string}>}
 */
async function extractPdfText(pdfPath, opts = {}) {
  const { maxPages = 40, charCap = 28000, timeoutMs = 150000 } = opts;
  if (!pdfPath || !fs.existsSync(pdfPath)) return { ok: false, error: '文件不存在' };

  const key = cacheKeyOf(pdfPath, maxPages, charCap);
  const cacheFile = path.join(CACHE_DIR, `${key}.json`);
  try {
    if (fs.existsSync(cacheFile)) {
      const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (c && c.ok) return { ...c, cached: true };
    }
  } catch (e) { /* 缓存损坏则重新提取 */ }

  const py = findPdfPython();
  if (!py) return { ok: false, error: '无可用的 Python（pdfplumber）环境' };

  try {
    const res = await execFileAsync(py, [
      SCRIPT, '--file', pdfPath,
      '--max-pages', String(maxPages),
      '--char-cap', String(charCap),
    ], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const data = JSON.parse(String(res.stdout || '').trim());
    if (data && data.ok) {
      try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(data), 'utf8');
      } catch (e) { /* 写缓存失败不影响本次结果 */ }
      return { ...data, cached: false };
    }
    return { ok: false, error: (data && data.error) || 'PDF 提取失败' };
  } catch (e) {
    return { ok: false, error: 'PDF 提取执行失败: ' + (e.message || e) };
  }
}

module.exports = { extractPdfText };
