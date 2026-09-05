/**
 * 行业板块拥挤度（首页新增模块）
 * --------------------------------------------------------------
 * 定义（用户给定口径）：
 *   板块拥挤度(原始) = 板块当日总成交额 ÷ A股全市场总成交额 × 100%
 *
 * 数据源与口径一致性：
 *   - 分子：同花顺「行业板块一览」中各板块当日总成交额（亿元）。
 *   - 分母：同花顺全行业板块成交额合计，作为「A股全市场总成交额」的口径一致近似
 *     （申万一级行业对全市场股票基本全覆盖，与各板块同源，避免跨源口径偏差）。
 *   - 因此本模块所有数值均来自同一数据源，满足「同一指标单一数据源」红线。
 *
 * 多周期统计：
 *   - 当日：最新一个交易日各板块拥挤度排名前五。
 *   - 本周：最近 5 个交易日（≈1 交易周）各板块拥挤度均值前五。
 *   - 本月：最近 21 个交易日（≈1 交易月）各板块拥挤度均值前五。
 *
 * 历史记录：
 *   - 仅在「数据日期 == 当天」时落盘（非交易日/盘前不覆盖历史，避免污染周/月统计）。
 *   - 历史不足时，本周/本月退化为已有天数，并在 note 中提示「数据累积中」。
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const DATA_FILE = path.join(__dirname, '..', 'data', 'sector_crowding_history.json');
const KEEP_DAYS = 60;
const WEEK_DAYS = 5;     // 近 5 个交易日 ≈ 1 周
const MONTH_DAYS = 21;   // 近 21 个交易日 ≈ 1 月

function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function readAll() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (e) {
    return {};
  }
}

function writeAll(obj) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { /* 忽略写入失败 */ }
}

/**
 * 按数据日期落盘当日板块拥挤度。
 * @param {Array} sectorAll 同花顺全量板块 [{name, amount(亿元), changePct}]
 * @param {string} dataDate 数据实际日期（来自同花顺，格式 YYYY-MM-DD）
 * @returns {object|null} 写入的当日记录；非交易日（dataDate≠今天）返回 null 不落盘
 */
function recordDaily(sectorAll, dataDate) {
  const today = localDate();
  // 仅当数据日期为当天才落盘；否则视为非交易日/盘前陈旧数据，不污染历史
  if (!dataDate || dataDate !== today) return null;
  if (!Array.isArray(sectorAll) || sectorAll.length === 0) return null;

  const marketTotal = sectorAll.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  if (marketTotal <= 0) return null;

  const sectors = sectorAll.map(x => {
    const amount = Number(x.amount) || 0;
    const crowding = Math.round((amount / marketTotal) * 10000) / 100; // 百分比，保留两位
    return {
      name: x.name,
      amount: Math.round(amount * 100) / 100,
      crowding,
      changePct: (typeof x.changePct === 'number') ? x.changePct : null,
    };
  });

  const all = readAll();
  all[dataDate] = {
    marketTotal: Math.round(marketTotal * 100) / 100,
    sectors,
    recordedAt: new Date().toISOString(),
  };
  // 只保留最近 KEEP_DAYS 天
  const dates = Object.keys(all).sort().slice(-KEEP_DAYS);
  const trimmed = {};
  for (const d of dates) trimmed[d] = all[d];
  writeAll(trimmed);
  return trimmed[dataDate];
}

// 取最近 N 个交易日的板块拥挤度均值，返回 top5（按均值降序）
function _topByAvg(datesAsc, n) {
  const windowDates = datesAsc.slice(-n);
  const store = readAll();
  const acc = {}; // name -> { sum, cnt, lastAmount, lastChange }
  for (const d of windowDates) {
    const entry = store[d];
    if (!entry || !Array.isArray(entry.sectors)) continue;
    for (const s of entry.sectors) {
      if (!acc[s.name]) acc[s.name] = { sum: 0, cnt: 0, lastAmount: 0, lastChange: null };
      acc[s.name].sum += s.crowding;
      acc[s.name].cnt += 1;
      acc[s.name].lastAmount = s.amount;
      acc[s.name].lastChange = s.changePct;
    }
  }
  const list = Object.entries(acc).map(([name, v]) => ({
    name,
    crowding: Math.round((v.sum / v.cnt) * 100) / 100, // 窗口内均值
    days: v.cnt,
    amount: v.lastAmount,
    changePct: v.lastChange,
  })).sort((a, b) => b.crowding - a.crowding);
  return { dates: windowDates, list: list.slice(0, 5) };
}

/**
 * 从实时板块数据计算「当日」拥挤度前五（无需落盘）。
 * 用于首次加载/无历史时兜底，保证「当日」始终有数据。
 * @returns {{date:string, marketTotal:number, list:Array}|null}
 */
function _liveToday(sectorAll, dataDate) {
  if (!Array.isArray(sectorAll) || sectorAll.length === 0) return null;
  const marketTotal = sectorAll.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  if (marketTotal <= 0) return null;
  const list = sectorAll.map(x => {
    const amount = Number(x.amount) || 0;
    return {
      name: x.name,
      amount: Math.round(amount * 100) / 100,
      crowding: Math.round((amount / marketTotal) * 10000) / 100,
      changePct: (typeof x.changePct === 'number') ? x.changePct : null,
    };
  }).sort((a, b) => b.crowding - a.crowding).slice(0, 5);
  return {
    date: dataDate || localDate(),
    marketTotal: Math.round(marketTotal * 100) / 100,
    list,
  };
}

function _topToday(store) {
  const dates = Object.keys(store).sort();
  if (dates.length === 0) return { date: null, list: [] };
  const latest = dates[dates.length - 1];
  const entry = store[latest];
  const list = (entry.sectors || []).slice().sort((a, b) => b.crowding - a.crowding).slice(0, 5)
    .map(s => ({ name: s.name, crowding: s.crowding, amount: s.amount, changePct: s.changePct }));
  return { date: latest, list };
}

/**
 * 历史回填：调用 Python 脚本（同花顺行业指数历史成交额）生成过去 nDays 个交易日
 * 的各板块拥挤度，合并写入 store。后续 getCrowding 即可直接算本周/本月均值。
 *
 * @param {number} nDays 回填交易日数（默认 21 ≈ 1 月）
 * @param {string} pythonPath Python 解释器路径（由调用方传入，复用 server.js 的 findPython 记忆化）
 * @returns {Promise<{ok:boolean, written:number, total:number, source?:string, error?:string}>}
 */
let _backfillRunning = false;
async function backfillHistory(nDays = MONTH_DAYS, pythonPath) {
  if (_backfillRunning) return { ok: false, written: 0, total: 0, error: 'backfill already running' };
  _backfillRunning = true;
  try {
    const script = path.join(__dirname, '..', 'scripts', 'ths_sector_history.py');
    const py = pythonPath || process.env.PYTHON_PATH || 'python3';
    let stdout = '';
    try {
      const res = await execFileAsync(py, [script, '--days', String(nDays)], {
        timeout: 300000,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, // Windows 下强制 Python stdout 用 utf-8，避免行业名乱码
      });
      stdout = (res && res.stdout) ? res.stdout : '';
    } catch (e) {
      return { ok: false, written: 0, total: 0, error: 'exec error: ' + (e && e.message) };
    }
    // 兼容 akshare tqdm 进度条可能混入 stdout：取最后一个合法 JSON 对象
    let data = null;
    try {
      data = JSON.parse(stdout.trim());
    } catch (e1) {
      const m = stdout.trim().match(/\{[\s\S]*\}$/);
      if (m) {
        try { data = JSON.parse(m[0]); } catch (e2) { /* ignore */ }
      }
    }
    if (!data || !data.ok || !data.days) {
      return { ok: false, written: 0, total: 0, error: (data && data.error) || 'no days in output' };
    }

    const all = readAll();
    let written = 0;
    for (const [d, dayObj] of Object.entries(data.days)) {
      if (!dayObj || !Array.isArray(dayObj.sectors) || dayObj.sectors.length === 0) continue;
      all[d] = {
        marketTotal: dayObj.marketTotal,
        sectors: dayObj.sectors.map(s => ({
          name: s.name,
          amount: s.amount,
          crowding: s.crowding,
          changePct: (typeof s.changePct === 'number') ? s.changePct : null,
        })),
        recordedAt: new Date().toISOString(),
      };
      written++;
    }
    // 只保留最近 KEEP_DAYS 天
    const dates = Object.keys(all).sort().slice(-KEEP_DAYS);
    const trimmed = {};
    for (const d of dates) trimmed[d] = all[d];
    writeAll(trimmed);
    return { ok: true, written, total: dates.length, source: data.source, failures: data.failures };
  } finally {
    _backfillRunning = false;
  }
}

// store 中已记录交易日是否不足 nDays（用于决定是否触发历史回填）
function needsBackfill(threshold = MONTH_DAYS) {
  return Object.keys(readAll()).sort().length < threshold;
}

/**
 * 汇总输出当日 / 本周 / 本月 行业拥挤度前五。
 * @param {Array} sectorAll 可选，同花顺全量板块（用于当日实时补充，无需落盘由调用方决定是否记录）
 * @param {string} dataDate 可选，sectorAll 的数据日期
 */
function getCrowding(sectorAll, dataDate) {
  const store = readAll();
  const dates = Object.keys(store).sort();

  // 当日：优先用 store 中「今天」的记录（与历史同源：均来自同花顺行业指数成交额）；
  // 仅当 store 无今日（首日/盘前）时回退实时板块数据兜底
  const storeToday = _topToday(store);
  const liveToday = _liveToday(sectorAll, dataDate);
  const today = (storeToday.date === localDate()) ? storeToday : (liveToday || storeToday);

  // 本周 / 本月 均值
  const week = _topByAvg(dates, WEEK_DAYS);
  const month = _topByAvg(dates, MONTH_DAYS);

  const marketTotal = (today && today.marketTotal)
    ? today.marketTotal
    : (storeToday.date ? store[storeToday.date].marketTotal : null);

  const noteParts = [];
  if (dates.length === 0) {
    noteParts.push('历史数据为空，仅显示当日（最新）排名；周/月统计将在交易日逐日累积后可用。');
  } else {
    if (week.dates.length < WEEK_DAYS) noteParts.push(`本周统计目前仅 ${week.dates.length} 个交易日（满 ${WEEK_DAYS} 后稳定）。`);
    if (month.dates.length < MONTH_DAYS) noteParts.push(`本月统计目前仅 ${month.dates.length} 个交易日（满 ${MONTH_DAYS} 后稳定）。`);
  }

  return {
    ok: true,
    date: today.date,
    marketTotal,                       // A股全市场总成交额近似（亿元），同花顺行业合计
    source: '同花顺·行业板块',
    denominatorNote: '分母=A股全市场总成交额（同花顺申万一级行业板块成交额合计，口径一致近似）',
    today: today.list,
    week: week.list,
    month: month.list,
    weekDates: week.dates,
    monthDates: month.dates,
    note: noteParts.join(' '),
    updatedAt: new Date().toISOString(),
  };
}

module.exports = { recordDaily, getCrowding, backfillHistory, needsBackfill, localDate };
