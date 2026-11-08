/**
 * lib/tradeCalendar.js — 交易日历表（20261107 · 每日复盘模块）
 * ==============================================================
 * 用户指令：新建 trade_calendar 表，导入交易所交易日历；节假日/周末 is_trading_day=false，
 * 调休交易日=true；定时任务必须先查该表。
 *
 * 单一权威源约束（工作台三条底层规则之一）：
 *   判定逻辑 **不另起一套**，复用 lib/cnTradingCalendar.js 的 isTradingDay()（上交所休市安排
 *   区间 + 周末规则）。本模块只是把它持久化成 SQLite 表，供定时任务/API 查询与审计，
 *   避免「内存一份、表里一份」造成口径漂移。
 *
 * 表结构：trade_calendar(date TEXT PRIMARY KEY, is_trading_day INTEGER, day_type, source,
 *                       source_time, note, imported_at)
 *   - day_type: 'trading' | 'weekend' | 'holiday' | 'makeup'
 *   - makeup（调休交易日）：A 股一般没有「周末调休补交易日」，但交易所若公布特殊交易日，
 *     通过 overrides.json 显式登记 is_trading_day=true，优先级高于基础规则。
 *   - source / source_time：数据五要素之「来源 / 实际时间」，联网公告兜底时写明来源时间。
 *
 * 隔离原则：本模块为**纯新增**，不修改 cnTradingCalendar.js 及任何既有模块，
 * 未被 require 时对现有工作台零影响。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { localDate } = require('./localDate');
const cnCal = require('./cnTradingCalendar');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = process.env.SA_TRADE_CALENDAR_DB
  ? path.resolve(process.env.SA_TRADE_CALENDAR_DB)
  : path.join(DATA_DIR, 'trade_calendar.db');
const OVERRIDES_FILE = process.env.SA_TRADE_CALENDAR_OVERRIDES
  ? path.resolve(process.env.SA_TRADE_CALENDAR_OVERRIDES)
  : path.join(DATA_DIR, 'trade_calendar_overrides.json');

let db = null;

function nowIso() { return new Date().toISOString(); }

// ---------- 调休 / 特殊交易日 override ----------
/**
 * overrides.json 格式：
 * {
 *   "2026-10-10": { "is_trading_day": true,  "reason": "交易所公告：国庆调休补交易日",
 *                   "source": "上交所公告", "source_time": "2026-09-20" },
 *   "2026-10-11": { "is_trading_day": false, "reason": "...", "source": "...", "source_time": "..." }
 * }
 * 只允许显式布尔值；缺失/非法忽略，不臆造。
 */
function readOverrides() {
  try {
    if (!fs.existsSync(OVERRIDES_FILE)) return {};
    const obj = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
      if (!v || typeof v !== 'object' || typeof v.is_trading_day !== 'boolean') continue;
      out[k] = {
        is_trading_day: v.is_trading_day,
        reason: String(v.reason || '').slice(0, 200),
        source: String(v.source || '本地登记').slice(0, 120),
        source_time: String(v.source_time || '').slice(0, 40),
      };
    }
    return out;
  } catch (e) {
    return {};
  }
}

// ---------- 基础规则（单一权威源） ----------
function classifyByRule(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const dow = d.getDay();
  const holiday = !cnCal.isTradingDay(dateStr);
  let dayType;
  if (dow === 0 || dow === 6) dayType = 'weekend';
  else if (holiday) dayType = 'holiday';
  else dayType = 'trading';
  return {
    is_trading_day: cnCal.isTradingDay(dateStr),
    day_type: dayType,
    source: 'cnTradingCalendar.js（上交所休市安排区间 + 周末规则）',
    source_time: '静态规则表',
    note: '',
  };
}

// ---------- 建表 / 导入 ----------
function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS trade_calendar (
    date TEXT PRIMARY KEY,
    is_trading_day INTEGER NOT NULL,
    day_type TEXT NOT NULL,
    source TEXT,
    source_time TEXT,
    note TEXT,
    imported_at TEXT
  );`);
  return db;
}

/** YYYY-MM-DD 加一天（本地字符串运算，避免 UTC 偏移） */
function addDay(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/**
 * 导入 [fromDate, toDate] 全量日历（幂等：同日重复导入按主键覆盖）。
 * 覆盖 cnTradingCalendar 已维护年份 + 前后各一年（未维护年份按「仅跳过周末」规则，
 * 并在 note 中如实标注「官方节假日安排未公布，按周末规则推定」，不伪装成交易所公告）。
 */
function importRange(fromDate, toDate) {
  const d = getDb();
  const overrides = readOverrides();
  const maintainedYears = new Set(Object.keys(cnCal.HOLIDAY_RANGES || {}));
  const stmt = d.prepare(
    `INSERT INTO trade_calendar (date, is_trading_day, day_type, source, source_time, note, imported_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(date) DO UPDATE SET
       is_trading_day=excluded.is_trading_day, day_type=excluded.day_type,
       source=excluded.source, source_time=excluded.source_time,
       note=excluded.note, imported_at=excluded.imported_at`
  );
  let cur = fromDate;
  let n = 0;
  const at = nowIso();
  const run = d.prepare('BEGIN');
  const done = d.prepare('COMMIT');
  try {
    run.run();
    while (cur <= toDate) {
      const base = classifyByRule(cur);
      if (base) {
        let row = { ...base };
        const yr = cur.slice(0, 4);
        if (!maintainedYears.has(yr)) {
          row.note = '该年份官方节假日休市安排未公布，按「仅跳过周末」规则推定，非交易所公告';
        }
        const ov = overrides[cur];
        if (ov) {
          row = {
            is_trading_day: ov.is_trading_day,
            day_type: ov.is_trading_day ? 'makeup' : 'holiday',
            source: ov.source,
            source_time: ov.source_time,
            note: ov.reason || '',
          };
        }
        stmt.run(cur, row.is_trading_day ? 1 : 0, row.day_type,
          row.source, row.source_time, row.note, at);
        n++;
      }
      cur = addDay(cur, 1);
    }
    done.run();
  } catch (e) {
    try { d.prepare('ROLLBACK').run(); } catch (_) { /* ignore */ }
    throw e;
  }
  return { imported: n, from: fromDate, to: toDate, dbFile: DB_FILE };
}

/** 首次初始化：导入 2025-01-01 ~ 2027-12-31（覆盖当前已维护年份 + 缓冲） */
function ensureImported() {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) AS n FROM trade_calendar').get();
  if (row && row.n > 0) return { imported: 0, already: row.n };
  return importRange('2025-01-01', '2027-12-31');
}

// ---------- 查询 ----------
/**
 * 查表（定时任务必须先调这个，不许绕过直接调 cnCal.isTradingDay）。
 * @param {string} dateStr YYYY-MM-DD
 * @returns {{ok:boolean, date:string, is_trading_day:boolean, day_type:string,
 *            source:string, source_time:string, note:string, from_table:boolean}}
 */
function isTradingDay(dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? dateStr : localDate();
  const d = getDb();
  let row = d.prepare('SELECT * FROM trade_calendar WHERE date=?').get(date);
  if (!row) {
    // 表未覆盖该日期 → 现场补导入该日期所在整年，再查一次（保持「先查表」语义）
    const yr = date.slice(0, 4);
    try { importRange(`${yr}-01-01`, `${yr}-12-31`); } catch (e) { /* fallthrough */ }
    row = d.prepare('SELECT * FROM trade_calendar WHERE date=?').get(date);
  }
  if (!row) {
    const base = classifyByRule(date) || { is_trading_day: false, day_type: 'weekend', source: '缺失', source_time: '', note: '规则无法判定' };
    return {
      ok: false, date, is_trading_day: !!base.is_trading_day, day_type: base.day_type,
      source: base.source, source_time: base.source_time, note: base.note,
      from_table: false, reason: '交易日历表无此日期且补导入失败',
    };
  }
  return {
    ok: true, date,
    is_trading_day: !!row.is_trading_day,
    day_type: row.day_type,
    source: row.source,
    source_time: row.source_time,
    note: row.note,
    from_table: true,
  };
}

function getRange(fromDate, toDate) {
  const d = getDb();
  return d.prepare('SELECT * FROM trade_calendar WHERE date>=? AND date<=? ORDER BY date ASC')
    .all(fromDate, toDate)
    .map(r => ({ ...r, is_trading_day: !!r.is_trading_day }));
}

function stats() {
  const d = getDb();
  const r = d.prepare('SELECT COUNT(*) AS n, MIN(date) AS minD, MAX(date) AS maxD FROM trade_calendar').get();
  const t = d.prepare('SELECT COUNT(*) AS n FROM trade_calendar WHERE is_trading_day=1').get();
  return { total: r.n, tradingDays: t.n, fromDate: r.minD, toDate: r.maxD, dbFile: DB_FILE };
}

/** 测试用：关闭句柄 */
function close() { if (db) { try { db.close(); } catch (_) { /* ignore */ } db = null; } }

module.exports = {
  isTradingDay, getRange, importRange, ensureImported, stats,
  readOverrides, classifyByRule, close, DB_FILE, OVERRIDES_FILE,
};
