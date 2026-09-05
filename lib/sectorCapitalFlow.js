/**
 * 行业板块资金流向（主力净流入/流出前五 + 近5日最大流入/流出板块）
 * 数据源：优先东方财富板块资金流向（超大单+大单，含暗盘性质机构资金）；
 *         东方财富不可达时回退同花顺「净流入」近似口径。
 */
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

let _cache = { ts: 0, data: null };
const CACHE_TTL = 30000; // 30 秒缓存，与板块涨跌排名一致

async function findPythonForScript() {
  // 复用 stockData.js 中的探测结果，避免重复启动子进程
  try {
    const { findPythonForScript: finder } = require('./stockData');
    const py = await finder();
    if (py) return py;
  } catch (e) {
    // ignore, fallback below
  }
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      await execFileAsync(c, ['--version'], { timeout: 5000, windowsHide: true });
      return c;
    } catch (e) {
      // try next
    }
  }
  return null;
}

async function getSectorCapitalFlow(refresh = false) {
  const now = Date.now();
  if (!refresh && _cache.data && now - _cache.ts < CACHE_TTL) {
    return _cache.data;
  }

  const py = await findPythonForScript();
  if (!py) {
    return {
      ok: false,
      error: '未找到 Python 解释器，无法获取板块资金流向',
      todayInflowTop5: [],
      todayOutflowTop5: [],
      fiveDayMaxInflow: null,
      fiveDayMaxOutflow: null,
    };
  }

  try {
    const script = path.join(__dirname, '..', 'scripts', 'em_sector_capital_flow.py');
    const out = await execFileAsync(py, [script], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 35000,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    const parsed = JSON.parse(out.stdout);
    if (parsed.error) throw new Error(parsed.error);

    const result = {
      ok: true,
      date: parsed.date || new Date().toISOString().slice(0, 10),
      source: parsed.source || '东方财富·板块资金流向',
      note: parsed.note || '主力净流入 = 超大单净流入 + 大单净流入（含暗盘性质机构资金）',
      todayInflowTop5: parsed.todayInflowTop5 || [],
      todayOutflowTop5: parsed.todayOutflowTop5 || [],
      fiveDayMaxInflow: parsed.fiveDayMaxInflow || null,
      fiveDayMaxOutflow: parsed.fiveDayMaxOutflow || null,
      fallbackWarning: parsed.fallbackWarning || null,
      fiveDayWarning: parsed.fiveDayWarning || null,
    };
    _cache = { ts: now, data: result };
    return result;
  } catch (e) {
    console.error('[SectorCapitalFlow] error:', e.message);
    return {
      ok: false,
      error: e.message,
      date: new Date().toISOString().slice(0, 10),
      source: '获取失败',
      note: '',
      todayInflowTop5: [],
      todayOutflowTop5: [],
      fiveDayMaxInflow: null,
      fiveDayMaxOutflow: null,
    };
  }
}

module.exports = { getSectorCapitalFlow };
