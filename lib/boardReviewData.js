/**
 * lib/boardReviewData.js — 连板梯队 / 龙虎榜取数桥接（20261107，20261108 扩展）
 * ==================================================================
 * 调 scripts/board_review_data.py（akshare 东财涨停池 + 昨日涨停池 + 强势股池 + 龙虎榜明细），
 * 数值全部由 Python 本机代码统计，Node 层只做桥接与缓存，不计算、不补齐、不臆造。
 *
 * 20261108 扩展：新增 prevPool / sectors / activity / historySeries 四块；
 * getBoardReviewData 第二参数 opts.histDates（ISO 日期数组）经 --hist-dates 传入 Python，
 * 缓存 key 含 histDates 避免不同对照日串数据；normalizeDateFields 同步归一化新块的日期字段。
 * 原有 ladder / lhb 字段与语义、以及单参数调用（ReviewService）完全不变。
 *
 * 隔离原则：取数失败抛异常，由 ReviewService 的 collect() 统一降级为「缺失」信封。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(cp.execFile);
const { findPython } = require('./pyRuntime');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'board_review_data.py');
const CACHE_TTL = 10 * 60 * 1000;
let _cache = new Map();

/** 上一交易日（Asia/Shanghai 口径，复用唯一权威交易日历） */
function prevTradingDate(dateStr) {
  const { previousTradingDay } = require('./cnTradingCalendar');
  return previousTradingDay(dateStr);
}

/**
 * 口径日统一：Python 侧为调用 akshare 使用紧凑 YYYYMMDD，
 * 但复盘的五要素 asOf 全站统一 YYYY-MM-DD（与 quote/breadth/sectorFlow 一致）。
 * 若不统一，integrity 段的「口径差异」自检会把同一天误判成两个日期。
 * 只做格式归一化，绝不改写数值、不推算日期。
 */
function isoDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s || null;
}
function normalizeDateFields(data) {
  data.date = isoDate(data.date) || data.date;
  data.prevDate = isoDate(data.prevDate);
  // 紧凑 YYYYMMDD → ISO YYYY-MM-DD；只做格式归一化，绝不改写数值、不推算日期。
  ['ladder', 'lhb', 'prevPool', 'sectors', 'activity'].forEach(k => {
    if (data[k] && typeof data[k] === 'object') data[k].asOf = isoDate(data[k].asOf) || data[k].asOf;
  });
  if (Array.isArray(data.historySeries)) {
    data.historySeries.forEach(row => {
      if (row && typeof row === 'object') row.date = isoDate(row.date) || row.date;
    });
  }
  // 20261108 扩展：sectors.industryHistory[].date 紧凑 YYYYMMDD → ISO（与 historySeries 同口径）
  if (data.sectors && Array.isArray(data.sectors.industryHistory)) {
    data.sectors.industryHistory.forEach(row => {
      if (row && typeof row === 'object') row.date = isoDate(row.date) || row.date;
    });
  }
  return data;
}

/**
 * @param {string} dateStr YYYY-MM-DD
 * @param {object} [opts] 可选：{ histDates: string[] } 复盘日之前的前 3-5 个交易日（ISO 日期数组）
 * @returns {Promise<object>} { ok, date, prevDate, fetchedAt, source, ladder, lhb,
 *                             prevPool, sectors, activity, historySeries, issues }
 */
async function getBoardReviewData(dateStr, opts) {
  const options = opts || {};
  const key = String(dateStr || '');
  const histDates = Array.isArray(options.histDates)
    ? options.histDates.filter(Boolean).map(x => String(x).trim()).filter(Boolean)
    : [];
  // 缓存 key 必须包含 histDates，否则不同对照日会串数据；排序使顺序无关也能命中同一缓存
  const cacheKey = key + '|' + histDates.slice().sort().join(',');
  const hit = _cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.data;

  const py = findPython();
  if (!py) throw new Error('未找到 Python 解释器');
  if (!fs.existsSync(SCRIPT)) throw new Error('board_review_data.py 不存在');

  const compact = key.replace(/-/g, '');
  const prev = prevTradingDate(key).replace(/-/g, '');
  const args = [SCRIPT, '--date', compact];
  if (prev && /^\d{8}$/.test(prev)) args.push('--prev-date', prev);
  if (histDates.length) args.push('--hist-dates', histDates.map(x => x.replace(/-/g, '')).join(','));

  const { stdout } = await execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  let data;
  try { data = JSON.parse(String(stdout).trim()); }
  catch (e) { throw new Error('取数脚本返回非 JSON：' + String(stdout).slice(0, 160)); }
  if (!data || data.ok === false) {
    const why = (data && data.issues && data.issues[0] && data.issues[0].msg) || '未知原因';
    throw new Error('连板/龙虎榜取数失败：' + why);
  }
  normalizeDateFields(data);
  _cache.set(cacheKey, { ts: Date.now(), data });
  return data;
}

/**
 * 龙虎榜晚间补录专用：只抓当日龙虎榜明细，不跑涨停池/多日序列（实测快很多）。
 * 20261110a / ERR-20261110-001：龙虎榜是盘后延迟发布数据，15:35 的空结果不能当失败快照；
 * 补录时必须绕开 10 分钟缓存并重新请求，否则会一直命中下午那次「尚未发布」。
 * 本方法刻意不写缓存，也不清全局缓存（由调用方在补录前显式 clearCache）。
 */
async function getLhbOnly(dateStr) {
  const py = findPython();
  if (!py) throw new Error('未找到 Python 解释器');
  if (!fs.existsSync(SCRIPT)) throw new Error('board_review_data.py 不存在');
  const compact = String(dateStr || '').replace(/-/g, '');
  const { stdout } = await execFileAsync(py, [SCRIPT, '--date', compact, '--lhb-only'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 90000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  let data;
  try { data = JSON.parse(String(stdout).trim()); }
  catch (e) { throw new Error('补录取数脚本返回非 JSON：' + String(stdout).slice(0, 160)); }
  if (!data || typeof data !== 'object') throw new Error('补录取数脚本返回空内容');
  normalizeDateFields(data);
  return data;
}

/**
 * [20261111d] 个股分钟级分时取数（AKShare 东财）：走脚本早退通道 --intraday-symbol。
 * 返回 build_intraday 的 block：{ ok, symbol, date, asOf, source, points, note, issues }。
 * 取数失败/无数据不伪造，由上层降级到项目现成的腾讯分时通道（多源降级链，来源如实标注）。
 */
async function getIntraday(symbol, dateStr) {
  const py = findPython();
  if (!py) throw new Error('未找到 Python 解释器');
  if (!fs.existsSync(SCRIPT)) throw new Error('board_review_data.py 不存在');
  const compact = String(dateStr || '').replace(/-/g, '');
  const { stdout } = await execFileAsync(py, [
    SCRIPT, '--date', compact,
    '--intraday-symbol', String(symbol || ''), '--intraday-date', compact,
  ], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 90000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  let data;
  try { data = JSON.parse(String(stdout).trim()); }
  catch (e) { throw new Error('分时取数脚本返回非 JSON：' + String(stdout).slice(0, 160)); }
  return (data && data.intraday) || null;
}

function clearCache() { _cache.clear(); }

module.exports = { getBoardReviewData, getLhbOnly, getIntraday, prevTradingDate, clearCache, normalizeDateFields };
