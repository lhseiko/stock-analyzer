/**
 * 大盘估值趋势：上证50 / 沪深300 / 科创50 近5年市盈率(TTM)趋势
 * -------------------------------------------------------------
 * 数据源：
 * - 上证50、沪深300：乐咕乐股(legulegu.com) 月度滚动市盈率(TTM)
 * - 科创50：东方财富·市场估值 (RPT_VALUEMARKET) 日频平均市盈率(TTM)，按月采样
 *
 * 注意：不同指数/不同数据源在口径上存在天然差异。
 * 上证50/沪深300为指数成份股加权PE；科创50为东方财富“科创板50”板块的平均PE，
 * 因此与指数详情页中显示的加权PE数值不完全一致，仅用于观察趋势与相对位置。
 */
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const fs = require('fs');
const path = require('path');
const { decorateRules } = require('./ruleCore');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'index-pe-trend.json');
const CACHE_TTL = 6 * 3600 * 1000; // 6 小时

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.updatedAt) return null;
    const age = Date.now() - new Date(parsed.updatedAt).getTime();
    if (age > CACHE_TTL) return null;
    return parsed;
  } catch (e) {
    console.error('[IndexPETrend] cache read error:', e.message);
    return null;
  }
}

function writeCache(payload) {
  try {
    ensureDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (e) {
    console.error('[IndexPETrend] cache write error:', e.message);
  }
}

async function findPythonForScript() {
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

async function fetchFromScript() {
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到可用的 Python 解释器');
  const script = path.join(__dirname, '..', 'scripts', 'index_pe_trend.py');
  if (!fs.existsSync(script)) throw new Error('脚本不存在: ' + script);

  const { stdout, stderr } = await execFileAsync(py, [script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (stderr) console.error('[IndexPETrend] python stderr:', stderr.slice(0, 500));

  const parsed = JSON.parse(stdout);
  if (!parsed || !parsed.success) {
    throw new Error(parsed && parsed.error ? parsed.error : '脚本返回失败');
  }
  return parsed;
}

function emptyFallback(name) {
  return {
    name,
    source: '—',
    peField: '—',
    series: [],
    latest: null,
    quantile: null,
  };
}

function calcQuantile(pe, series) {
  // 计算当前PE在近5年序列中的历史百分位
  if (!series || !series.length || pe == null || !isFinite(pe)) return null;
  const pes = series.map(d => d.pe).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  if (!pes.length) return null;
  let lower = 0;
  for (const v of pes) if (v < pe) lower++;
  const same = pes.filter(v => v === pe).length;
  const rank = lower + same / 2;
  return Math.round((rank / pes.length) * 100);
}

async function getIndexPETrend({ force = false } = {}) {
  let raw = null;
  let fromCache = false;

  if (!force) {
    const cached = readCache();
    if (cached) {
      raw = cached;
      fromCache = true;
    }
  }

  if (!raw) {
    try {
      raw = await fetchFromScript();
      writeCache(raw);
    } catch (e) {
      console.error('[IndexPETrend] fetch failed:', e.message);
      const cached = readCache();
      if (cached) {
        raw = cached;
        fromCache = true;
      } else {
        return {
          success: false,
          error: e.message,
          data: {
            '上证50': emptyFallback('上证50'),
            '沪深300': emptyFallback('沪深300'),
            '科创50': emptyFallback('科创50'),
          },
        };
      }
    }
  }

  const result = {};
  const names = ['上证50', '沪深300', '科创50'];
  for (const name of names) {
    const item = (raw.data && raw.data[name]) || { series: [] };
    const series = (item.series || []).map(d => ({
      date: d.date,
      pe: d.pe != null ? +d.pe.toFixed(2) : null,
      close: d.close != null ? +d.close.toFixed(2) : null,
    })).filter(d => d.pe != null && isFinite(d.pe));
    const latest = series.length ? series[series.length - 1] : null;
    result[name] = {
      name,
      source: item.source || '—',
      peField: item.peField || '市盈率(TTM)',
      series,
      latest,
      quantile: latest ? calcQuantile(latest.pe, series) : null,
      // 三规则铺开：时效（日频）+ PE 的变化与边际
      rules: decorateRules({
        dataTime: latest ? latest.date : null,
        source: item.source || '—',
        kind: 'daily',
        series: series.map(d => ({ date: d.date, value: d.pe })),
        name: `${name} PE(TTM)`,
      }),
    };
  }

  return {
    success: true,
    updatedAt: raw.updatedAt || new Date().toISOString(),
    cached: fromCache,
    note: '上证50/沪深300为指数加权滚动PE；科创50为东方财富“科创板50”板块平均滚动PE。不同口径不可直接比较数值，仅用于趋势观察。',
    data: result,
  };
}

module.exports = { getIndexPETrend };
