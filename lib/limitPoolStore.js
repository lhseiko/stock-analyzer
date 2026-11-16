#!/usr/bin/env node
/**
 * limitPoolStore.js — 任务卡 #012：每日涨跌停池按交易日落库
 * ============================================================================
 * 定位：把「涨停池 / 跌停池 / 炸板池 / 昨日涨停股今日表现」按**交易日**结构化
 * 落到项目已有的 SQLite（data/stock_analyzer.db）新表 limit_pool_daily，供
 * marketEmotionWatch.js 的「赚钱效应」观察指标读取。
 *
 * 硬边界：
 *   1. 不重算任何数值：prevPool / ladder 的红盘率、平均涨幅、大面率、晋级率
 *      一律取 Python 侧（board_review_data.py）已算好的真实统计，Node 层只搬运。
 *   2. 幂等：同一交易日已有记录则跳过，不覆盖真实读数；只有显式 force 才重写。
 *   3. 交易日感知：非交易日落盘直接拒绝；数据日（as_of）= 交易日，绝不用运行日冒充。
 *   4. 诚实缺失：接口失败 / 复盘内无结构化块时返回 unavailable + 原因，不编 0。
 *   5. 五要素：数值 + 来源 + 口径（method）+ 真实数据日（as_of）+ 获取时间（fetched_at）。
 *   6. 不进 marketEmotionModel 的 factors / 总分 / 自学习；观察层仍只展示不打分。
 *
 * 两个入口（都只取真实已发生的数据）：
 *   - captureFromReview(date)：读 data/reviews/{date}.json 最新版本 context 内
 *     已落盘的 prevPool / ladder，**零联网**（复盘调度 15:35 主跑后直接复用）。
 *   - buildFromBoardReview(date, raw)：接 getBoardReviewData(date) 的原始返回，
 *     用于历史补录时按 --date 真实回查。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { isTradingDay } = require('./cnTradingCalendar');

const ROOT = path.join(__dirname, '..');
const TABLE = 'limit_pool_daily';
const REVIEWS_DIR = path.join(ROOT, 'data', 'reviews');
const SOURCE_REVIEW = 'reviewService.context（复盘文件内已落盘的 akshare 东财池统计）';
const SOURCE_BOARD = 'boardReviewData.js / board_review_data.py（akshare 东财涨停/跌停/炸板/昨涨停池）';

function nowIso() { return new Date().toISOString(); }
function r2(x) { return typeof x === 'number' && isFinite(x) ? Math.round(x * 100) / 100 : null; }
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

/** 建表（幂等）。只新建本模块自己的表，不动 db.js 既有三表。 */
function ensureTable() {
  const d = db.getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    trade_date TEXT PRIMARY KEY,
    as_of TEXT NOT NULL,
    source TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    method TEXT NOT NULL,
    status TEXT NOT NULL,
    backfilled INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_limit_pool_asof ON ${TABLE}(as_of);`);
  return d;
}

/**
 * 落盘一条交易日记录。
 * @returns {{action:'created'|'skipped'|'rejected', tradeDate, reason?, id?}}
 */
function saveDailyPool(input) {
  const o = input || {};
  const tradeDate = String(o.tradeDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    return { action: 'rejected', tradeDate, reason: '交易日格式应为 YYYY-MM-DD' };
  }
  if (!isTradingDay(tradeDate)) {
    return { action: 'rejected', tradeDate, reason: '非交易日不落盘（原则 A：不把休市日冒充数据日）' };
  }
  if (!o.payload || typeof o.payload !== 'object') {
    return { action: 'rejected', tradeDate, reason: 'payload 缺失或不是对象' };
  }
  const d = ensureTable();
  const exists = d.prepare(`SELECT 1 AS hit FROM ${TABLE} WHERE trade_date = ?`).get(tradeDate);
  if (exists && !o.force) {
    return { action: 'skipped', tradeDate, reason: '同交易日已有真实落盘记录，不覆盖' };
  }
  const fetchedAt = String(o.fetchedAt || '').trim() || nowIso();
  const status = String(o.status || (o.payload.redRate != null ? 'ready' : 'incomplete'));
  const json = JSON.stringify(Object.assign({}, o.payload, { tradeDate, asOf: tradeDate }));
  if (o.force) {
    d.prepare(`UPDATE ${TABLE} SET as_of=?, source=?, fetched_at=?, method=?, status=?, backfilled=?, payload=?, created_at=? WHERE trade_date=?`)
      .run(tradeDate, String(o.source || ''), fetchedAt, String(o.method || ''), status,
        o.backfilled ? 1 : 0, json, nowIso(), tradeDate);
  } else {
    d.prepare(`INSERT OR IGNORE INTO ${TABLE}
      (trade_date, as_of, source, fetched_at, method, status, backfilled, payload, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(tradeDate, tradeDate, String(o.source || ''), fetchedAt, String(o.method || ''),
        status, o.backfilled ? 1 : 0, json, nowIso());
  }
  const after = d.prepare(`SELECT 1 AS hit FROM ${TABLE} WHERE trade_date = ?`).get(tradeDate);
  return after
    ? { action: 'created', tradeDate, id: d.prepare(`SELECT rowid AS id FROM ${TABLE} WHERE trade_date = ?`).get(tradeDate).id }
    : { action: 'rejected', tradeDate, reason: '写入后未查到记录' };
}

/** 取单个交易日记录（含五要素），无记录返回 null */
function getDailyPool(tradeDate) {
  const d = ensureTable();
  const row = d.prepare(`SELECT * FROM ${TABLE} WHERE trade_date = ?`).get(String(tradeDate || ''));
  if (!row) return null;
  let payload = null;
  try { payload = JSON.parse(row.payload); } catch (e) { payload = null; }
  if (!payload) return null;
  // 行级五要素优先于 payload 内的池级来源说明，避免被覆盖成子块来源
  return Object.assign({}, payload, {
    tradeDate: row.trade_date,
    asOf: row.as_of,
    source: row.source,
    fetchedAt: row.fetched_at,
    method: row.method,
    status: row.status,
    backfilled: !!row.backfilled,
    createdAt: row.created_at,
  });
}

/**
 * 取截至 asOf（含）的落盘序列，按交易日升序。
 * 原则 A：非交易日沿用最近交易日，不新增、不归零。
 */
function getSeries(asOf, opts) {
  const o = opts || {};
  const d = ensureTable();
  const max = String(asOf || '9999-12-31');
  const rows = d.prepare(`SELECT * FROM ${TABLE} WHERE trade_date <= ? ORDER BY trade_date ASC`).all(max);
  const out = [];
  for (const row of rows) {
    let payload = null;
    try { payload = JSON.parse(row.payload); } catch (e) { continue; }
    if (!payload) continue;
    out.push(Object.assign({}, payload, {
      tradeDate: row.trade_date,
      asOf: row.as_of,
      source: row.source,
      fetchedAt: row.fetched_at,
      method: row.method,
      status: row.status,
      backfilled: !!row.backfilled,
      createdAt: row.created_at,
      redRate: r2(payload.redRate),
      avgChgPct: r2(payload.avgChgPct),
      bigDropRate: r2(payload.bigDropRate),
      count: payload.count != null ? Number(payload.count) : null,
      promotion: payload.promotion || null,
    }));
  }
  if (o.status) return out.filter(x => x.status === o.status);
  return out;
}

/** 赚钱效应专用序列：只保留有真实红盘率读数的交易日 */
function getProfitEffectSeries(asOf) {
  return getSeries(asOf).filter(x => x.status === 'ready' && x.redRate != null);
}

/**
 * 从既有复盘文件构建落盘载荷（零联网）。
 * @returns {{ok:true, row:object}|{ok:false, reason:string}}
 */
function buildFromReview(tradeDate, opts) {
  const o = opts || {};
  const date = String(tradeDate || '').trim();
  const dir = o.reviewsDir || REVIEWS_DIR;
  const file = path.join(dir, `${date}.json`);
  const doc = readJson(file);
  if (!doc) return { ok: false, reason: `复盘文件缺失或不可读：${path.basename(file)}` };
  const versions = Array.isArray(doc.versions) ? doc.versions : [];
  if (!versions.length) return { ok: false, reason: '复盘文件无 versions 版本记录' };
  const v = versions.find(x => x && x.version === doc.currentVersion) || versions[versions.length - 1];
  const ctx = v && v.context;
  const prev = ctx && ctx.prevPool;
  if (!prev || prev.ok === false || prev.redRate == null) {
    return { ok: false, reason: '复盘 context 内无可用「昨日涨停股今日表现」统计（ok=false 或红盘率缺失）' };
  }
  const ladder = ctx.ladder || null;
  return {
    ok: true,
    row: {
      source: `${SOURCE_REVIEW}（data/reviews/${date}.json v${v.version}）`,
      fetchedAt: v.generatedAt || doc.updatedAt || null,
      method: '复用复盘已落盘的 akshare 东财池统计；Node 层不重算任何数值',
      status: 'ready',
      backfilled: !!o.backfilled,
      payload: {
        redRate: r2(prev.redRate),
        avgChgPct: r2(prev.avgChgPct),
        bigDropRate: r2(prev.bigDropRate),
        count: prev.count != null ? Number(prev.count) : null,
        redCount: prev.redCount != null ? Number(prev.redCount) : null,
        bigDropCount: prev.bigDropCount != null ? Number(prev.bigDropCount) : null,
        promotion: prev.promotion || null,
        prevPool: prev,
        ladder,
        source: prev.source || SOURCE_REVIEW,
        note: String(prev.note || ''),
        completeness: prev.count != null
          ? `${prev.count} 只昨日涨停股样本；红盘率/大面率分母为涨跌幅有效样本`
          : '样本数缺失，不推算',
      },
    },
  };
}

/** 从 getBoardReviewData() 原始返回构建落盘载荷（联网回查专用） */
function buildFromBoardReview(tradeDate, raw, opts) {
  const o = opts || {};
  const date = String(tradeDate || '').trim();
  if (!raw || raw.ok === false) {
    return { ok: false, reason: '取数返回 ok=false，不落失败快照' };
  }
  const prev = raw.prevPool;
  if (!prev || prev.ok === false || prev.redRate == null) {
    return { ok: false, reason: '昨日涨停今日表现池不可用（ok=false 或红盘率缺失），不编 0' };
  }
  return {
    ok: true,
    row: {
      source: String(raw.source || SOURCE_BOARD),
      fetchedAt: String(raw.fetchedAt || '').trim() || null,
      method: 'board_review_data.py 代码统计；Node 层不重算任何数值',
      status: 'ready',
      backfilled: !!o.backfilled,
      payload: {
        redRate: r2(prev.redRate),
        avgChgPct: r2(prev.avgChgPct),
        bigDropRate: r2(prev.bigDropRate),
        count: prev.count != null ? Number(prev.count) : null,
        redCount: prev.redCount != null ? Number(prev.redCount) : null,
        bigDropCount: prev.bigDropCount != null ? Number(prev.bigDropCount) : null,
        promotion: prev.promotion || null,
        prevPool: prev,
        ladder: raw.ladder || null,
        source: prev.source || String(raw.source || ''),
        note: String(prev.note || ''),
        completeness: prev.count != null
          ? `${prev.count} 只昨日涨停股样本；红盘率/大面率分母为涨跌幅有效样本`
          : '样本数缺失，不推算',
      },
    },
  };
}

/** 便捷入口：从复盘文件落一天（调度器用，零联网） */
function captureFromReview(tradeDate, opts) {
  const o = opts || {};
  const built = buildFromReview(tradeDate, o);
  if (!built.ok) return { action: 'unavailable', tradeDate, reason: built.reason };
  return saveDailyPool(Object.assign({ tradeDate }, built.row, {
    backfilled: o.backfilled, force: o.force,
  }));
}

function getDbInfo() {
  const d = ensureTable();
  const n = d.prepare(`SELECT COUNT(*) AS n FROM ${TABLE}`).get().n;
  const mm = d.prepare(`SELECT MIN(trade_date) AS lo, MAX(trade_date) AS hi FROM ${TABLE}`).get();
  return { table: TABLE, rows: n, from: mm.lo || null, to: mm.hi || null, dbPath: db.DB_PATH };
}

module.exports = {
  TABLE, SOURCE_REVIEW, SOURCE_BOARD,
  ensureTable, saveDailyPool, getDailyPool, getSeries, getProfitEffectSeries,
  buildFromReview, buildFromBoardReview, captureFromReview, getDbInfo,
};
