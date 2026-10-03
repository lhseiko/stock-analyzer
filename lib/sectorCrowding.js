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
 * 多周期统计（区间口径，与列头的日期范围严格一致）：
 *   - 当日：最新一个交易日各板块拥挤度排名前五（单日值）。
 *   - 本周：最近 5 个交易日（≈1 交易周）的区间聚合前五。
 *   - 本月：最近 21 个交易日（≈1 交易月）的区间聚合前五。
 *   区间聚合定义（三列内部自洽：拥挤度 × 区间全市场成交额 = 区间板块成交额）：
 *     成交额 = 区间内该板块各日成交额之和（累计，亿元）；
 *     拥挤度 = 区间板块成交额之和 ÷ 区间全市场成交额之和 × 100%（区间占比）；
 *     涨跌幅 = 区间内各交易日涨跌幅的复利累计。
 *   ⚠️ 20261002a 修正：旧实现把「成交额/涨跌幅」取成窗口最后一天的值（lastAmount/lastChange），
 *      导致今日/本周/本月三列成交额恒等（窗口末日相同）——不同时间长度累计成交额不可能一样。
 *   （历史不足时退化为可用天数并在 note 提示。）
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

// 存盘路径支持环境变量覆盖（仅用于回归测试隔离；生产不设置则用默认路径）
const DATA_FILE = process.env.SA_SECTOR_CROWDING_FILE
  ? path.resolve(process.env.SA_SECTOR_CROWDING_FILE)
  : path.join(__dirname, '..', 'data', 'sector_crowding_history.json');
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

// 取最近 N 个交易日的「区间聚合」前五（按区间拥挤度降序）
// 区间口径（与列头日期范围一致）：
//   成交额 = Σ 该板块各日成交额（累计）
//   拥挤度 = Σ 板块成交额 ÷ Σ 全市场成交额 × 100%
//   涨跌幅 = Π(1 + 各日涨跌幅/100) - 1（复利累计）
function _topByAvg(datesAsc, n) {
  const windowDates = datesAsc.slice(-n);
  const store = readAll();
  const acc = {}; // name -> { amountSum, days, chgFactor, chgCnt }
  let marketSum = 0;
  for (const d of windowDates) {
    const entry = store[d];
    if (!entry || !Array.isArray(entry.sectors)) continue;
    marketSum += Number(entry.marketTotal) || 0;
    for (const s of entry.sectors) {
      const key = s.name;
      if (!acc[key]) acc[key] = { amountSum: 0, days: 0, chgFactor: 1, chgCnt: 0 };
      acc[key].amountSum += Number(s.amount) || 0;
      acc[key].days += 1;
      if (typeof s.changePct === 'number' && Number.isFinite(s.changePct)) {
        acc[key].chgFactor *= (1 + s.changePct / 100);
        acc[key].chgCnt += 1;
      }
    }
  }
  const list = Object.entries(acc).map(([name, v]) => ({
    name,
    // 区间拥挤度 = 区间板块成交额之和 ÷ 区间全市场成交额之和
    crowding: marketSum > 0 ? Math.round((v.amountSum / marketSum) * 10000) / 100 : 0,
    days: v.days,
    amount: Math.round(v.amountSum * 100) / 100,          // 区间累计成交额（亿元）
    changePct: v.chgCnt > 0 ? Math.round((v.chgFactor - 1) * 10000) / 100 : null, // 区间复利累计涨跌幅
  })).sort((a, b) => b.crowding - a.crowding);
  return { dates: windowDates, list: list.slice(0, 5), marketTotal: Math.round(marketSum * 100) / 100 };
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

// store 是否已有指定日期的记录（供收盘补写守卫判断当日是否已落盘，读本地文件，极快）
function hasDate(date) {
  return Boolean(date && readAll()[date]);
}

// store 中最新一天的全市场成交额合计（用于「数据新鲜度指纹」判定：
// 交易日 15:30 后的成交额是新值，节假日/休市时数据源返回的是上一交易日的冻结值））
function latestMarketTotal() {
  const all = readAll();
  const dates = Object.keys(all).sort();
  if (!dates.length) return null;
  const entry = all[dates[dates.length - 1]];
  const v = entry && Number(entry.marketTotal);
  return Number.isFinite(v) ? v : null;
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

module.exports = { recordDaily, getCrowding, backfillHistory, needsBackfill, hasDate, latestMarketTotal, localDate };
