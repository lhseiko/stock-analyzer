// lib/db.js — 工作台本地 SQLite 数据层（Node 22 内置 node:sqlite，零额外依赖）
//
// 设计目标：把工作台的三条底层铁律（一致性 / 最新性 / 边际分析）落到工程化存储。
//   规则一·五要素：每条数据都带 名称/数值/实际时间/来源/获取时间 → 落在 source + fetched_at + as_of 字段。
//   规则二·最新性：data_points 带 valid_until（按数据类型 TTL 推算），读取时校验 isFresh，过期即视为无效。
//   规则三·边际分析：series 表按 as_of 排序，helper 直接计算 变化率 + 边际变化（变化的变化）。
//   分析期数据锁定：analysis_snapshots 冻结每次分析的完整数据，可复现/审计。
//
// 注意：本层只做「缓存 + 结构化存储」，不替代任何外部实时取数逻辑。所有写操作失败都不抛给调用方。

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, '..', 'data', 'stock_analyzer.db');
let db = null;

// 规则二·按数据类型 TTL（毫秒）。与工作台既有约定一致：
// 实时行情 5 分钟 / 日线 24 小时 / 周线 7 天 / 财务 90 天 / 公司基本信息 30 天。
const TTL = {
  realtime: 5 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  financial: 90 * 24 * 60 * 60 * 1000,
  company: 30 * 24 * 60 * 60 * 1000,
};
function ttlMs(type) {
  return TTL[type] != null ? TTL[type] : TTL.financial;
}

function nowIso() {
  return new Date().toISOString();
}

// 建库 + 建表（幂等）。仅在首次调用时真正打开文件。
function initDb() {
  if (db) return db;
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    // WAL：提升并发读性能；busy_timeout：写冲突时短暂等待而非直接报错。
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');

    db.exec(`CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      metric TEXT NOT NULL,
      as_of TEXT NOT NULL,          -- 数据代表的真实时间（如报告期 2025-06-30 / 除权日）
      value REAL,
      source TEXT,                  -- 单一权威来源（如 eastmoney:RPT_SHAREBONUS_DET）
      fetched_at TEXT,              -- 获取时间（五要素之一）
      extra TEXT,                   -- JSON：stage/label/plan/progress 等附加字段
      UNIQUE(symbol, metric, as_of)
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_series_sym_metric ON series(symbol, metric, as_of);');

    db.exec(`CREATE TABLE IF NOT EXISTS data_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      key TEXT NOT NULL,             -- 标量指标标识（如 current_price / industry_pe_avg）
      value REAL,
      value_text TEXT,              -- 非数值型（如方案文字）落这里
      as_of TEXT,                   -- 数据实际时间
      source TEXT,                  -- 来源（五要素）
      fetched_at TEXT,              -- 获取时间（五要素）
      valid_until TEXT,             -- 有效期（规则二 TTL 推算）
      extra TEXT,
      UNIQUE(symbol, key)
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_dp_sym ON data_points(symbol, key);');

    db.exec(`CREATE TABLE IF NOT EXISTS analysis_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL,
      snapshot_id TEXT NOT NULL,
      range TEXT,
      created_at TEXT,
      payload TEXT,                 -- 冻结的完整分析数据（JSON）
      UNIQUE(symbol, snapshot_id)
    );`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_snap_sym ON analysis_snapshots(symbol, created_at);');

    console.log(`[DB] sqlite ready at ${DB_PATH}`);
  } catch (e) {
    console.error('[DB] init failed:', e.message);
    db = null; // 允许后续重试
    throw e;
  }
  return db;
}

function getDb() {
  if (!db) initDb();
  return db;
}

function isReady() {
  return db != null;
}

// ---------- series（时序 + 五要素 + 边际）----------

function upsertSeries({ symbol, metric, asOf, value, source, fetchedAt, extra }) {
  const d = getDb();
  const fa = fetchedAt || nowIso();
  d.prepare(
    `INSERT INTO series (symbol, metric, as_of, value, source, fetched_at, extra)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(symbol, metric, as_of) DO UPDATE SET
       value=excluded.value, source=excluded.source, fetched_at=excluded.fetched_at, extra=excluded.extra`
  ).run(symbol, metric, asOf, value, source, fa, extra != null ? JSON.stringify(extra) : null);
}

function getSeries(symbol, metric) {
  const d = getDb();
  const rows = d.prepare(
    `SELECT * FROM series WHERE symbol=? AND metric=? ORDER BY as_of ASC`
  ).all(symbol, metric);
  return rows.map((r) => ({ ...r, extra: r.extra ? JSON.parse(r.extra) : null }));
}

// 在 getSeries 基础上直接计算 变化率 与 边际变化（规则三：变化率 + 边际 + 方向）。
// 变化率 = (当前-前值)/|前值|×100%；边际变化 = 当期变化率 - 上期变化率。
function getSeriesWithMarginal(symbol, metric) {
  const rows = getSeries(symbol, metric);
  return rows.map((r, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const prev2 = i > 1 ? rows[i - 2] : null;
    let changePct = null;
    let marginal = null;
    let direction = null;
    if (prev && prev.value != null && r.value != null && prev.value !== 0) {
      const chg = ((r.value - prev.value) / Math.abs(prev.value)) * 100;
      changePct = Math.round(chg * 100) / 100;
      direction = chg > 0 ? 'up' : chg < 0 ? 'down' : 'flat';
      if (prev2 && prev2.value != null && prev2.value !== 0 && prev.value !== 0) {
        const prevChg = ((prev.value - prev2.value) / Math.abs(prev2.value)) * 100;
        marginal = Math.round((chg - prevChg) * 100) / 100;
      }
    }
    return { ...r, changePct, marginal, direction };
  });
}

// ---------- data_points（标量 + 五要素 + TTL）----------

function upsertDataPoint({ symbol, key, value, valueText, asOf, source, validUntil, fetchedAt, extra, ttlType }) {
  const d = getDb();
  const fa = fetchedAt || nowIso();
  const vu = validUntil || new Date(Date.now() + ttlMs(ttlType || 'financial')).toISOString();
  d.prepare(
    `INSERT INTO data_points (symbol, key, value, value_text, as_of, source, fetched_at, valid_until, extra)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(symbol, key) DO UPDATE SET
       value=excluded.value, value_text=excluded.value_text, as_of=excluded.as_of,
       source=excluded.source, fetched_at=excluded.fetched_at, valid_until=excluded.valid_until, extra=excluded.extra`
  ).run(symbol, key, value != null ? value : null, valueText != null ? valueText : null, asOf != null ? asOf : null, source != null ? source : null, fa, vu, extra != null ? JSON.stringify(extra) : null);
}

function getDataPoint(symbol, key) {
  const d = getDb();
  const r = d.prepare(`SELECT * FROM data_points WHERE symbol=? AND key=?`).get(symbol, key);
  if (!r) return null;
  const valid = r.valid_until ? new Date(r.valid_until).getTime() > Date.now() : true;
  return { ...r, extra: r.extra ? JSON.parse(r.extra) : null, isFresh: valid };
}

// 读取某股票全部标量数据点（供 /api/db/datapoints 使用），附 isFresh 新鲜度。
function getDataPoints(symbol) {
  const d = getDb();
  const rows = d.prepare(`SELECT * FROM data_points WHERE symbol=? ORDER BY key ASC`).all(symbol);
  return rows.map((r) => {
    const valid = r.valid_until ? new Date(r.valid_until).getTime() > Date.now() : true;
    return { ...r, extra: r.extra ? JSON.parse(r.extra) : null, isFresh: valid };
  });
}

// ---------- analysis_snapshots（分析期数据锁定）----------

function saveSnapshot({ symbol, snapshotId, range, payload }) {
  const d = getDb();
  d.prepare(
    `INSERT INTO analysis_snapshots (symbol, snapshot_id, range, created_at, payload)
     VALUES (?,?,?,?,?)
     ON CONFLICT(symbol, snapshot_id) DO UPDATE SET
       range=excluded.range, created_at=excluded.created_at, payload=excluded.payload`
  ).run(symbol, snapshotId, range || null, nowIso(), JSON.stringify(payload));
}

function getLatestSnapshot(symbol) {
  const d = getDb();
  const r = d.prepare(`SELECT * FROM analysis_snapshots WHERE symbol=? ORDER BY created_at DESC LIMIT 1`).get(symbol);
  if (!r) return null;
  return { ...r, payload: r.payload ? JSON.parse(r.payload) : null };
}

function getSnapshots(symbol, limit = 10) {
  const d = getDb();
  return d.prepare(`SELECT snapshot_id, range, created_at FROM analysis_snapshots WHERE symbol=? ORDER BY created_at DESC LIMIT ?`).all(symbol, limit);
}

// 健康检查：返回库状态 + 各表行数（供 /api/db/health 使用）
function getDbInfo() {
  const result = { path: DB_PATH, ready: isReady(), tables: {} };
  if (!db) return result;
  for (const t of ['series', 'data_points', 'analysis_snapshots']) {
    try {
      result.tables[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    } catch {
      result.tables[t] = -1;
    }
  }
  return result;
}

module.exports = {
  DB_PATH,
  initDb,
  getDb,
  isReady,
  ttlMs,
  // series
  upsertSeries,
  getSeries,
  getSeriesWithMarginal,
  // data_points
  upsertDataPoint,
  getDataPoint,
  getDataPoints,
  // snapshots
  saveSnapshot,
  getLatestSnapshot,
  getSnapshots,
  // meta
  getDbInfo,
};
