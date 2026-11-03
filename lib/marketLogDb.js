/**
 * lib/marketLogDb.js — 大盘记录数据库（20261103i）
 * ==========================================================
 * 用户指令（2026-11-03）：「把大盘记录做成一个简单的数据库，添加相应的检索功能，
 * 能够按日期、行业和涨跌等关键词进行搜索。」
 *
 * 大盘记录 = data/notes.json 中 scope='market' 的条目（AI 每日复盘自动写入 + 用户手写）。
 * 本模块把它们**派生**成一份结构化 SQLite 库（data/market-log.db，Node 22 内置 node:sqlite
 * 零额外依赖），提供按 日期 / 行业 / 涨跌 / 关键词 的检索。
 *
 * 设计口径：
 *   1. **派生库**：notes.json 仍是唯一权威源；本库是它的结构化镜像，可随时全量重建（幂等）。
 *      同步时机 = 检索请求时检测 notes.json mtime 变化 → 重建（记录量级为百条内，全量重建 <10ms）。
 *   2. **代码权威**：日期/指数涨跌幅/方向/行业候选全部由本机正则解析，不用 LLM；解析不到的
 *      字段如实置 null/空数组（诚实缺失），绝不臆造。
 *   3. **行业检索是关键词匹配**：AI 文案自由度高（"电机涨5.18%居首""银行受净息差压制"），
 *      行业名解析只取「分句开头 + 紧跟涨/跌」的高置信候选（供展示 chips 与检索建议）；
 *      检索本身对 sectors JSON + content 全文 LIKE，解析不完美不影响命中。
 *   4. **方向（涨/跌）**：按沪指（沪指/上证指数）当日涨跌幅符号判定，红涨绿跌语义由前端着色；
 *      解析不到 → direction=null（中性·未知，不硬猜）。
 *   5. 隔离：不改动 lib/db.js 与既有 notes 链路；库文件独立，测试可用环境变量重定向。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const NOTES_FILE = process.env.SA_NOTES_FILE
  ? path.resolve(process.env.SA_NOTES_FILE)
  : path.join(__dirname, '..', 'data', 'notes.json');
const DB_FILE = process.env.SA_MARKET_LOG_DB
  ? path.resolve(process.env.SA_MARKET_LOG_DB)
  : path.join(__dirname, '..', 'data', 'market-log.db');

let db = null;
let _lastSyncMtimeMs = null;

function nowIso() { return new Date().toISOString(); }

/** 本地时区 YYYY-MM-DD（手写条目没有交易日标记，用笔记时间兜底） */
function localDateOf(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 解析（纯函数） ----------

/** 从一段文本里提取「指数名 + 涨跌幅」对（如 沪指 +0.89%、创业板指 4.16%） */
function parseIndices(text) {
  const out = [];
  const re = /([\u4e00-\u9fa5A-Za-z0-9]{2,10}?)\s*([+-]?\d+(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const name = m[1].replace(/^[，。、；：,.;:()\[\]（）\s]+/, '');
    const pct = Number(m[2]);
    if (name && Number.isFinite(pct)) out.push({ name, changePct: Math.round(pct * 100) / 100 });
  }
  return out;
}

/**
 * 从「领涨/领跌板块」段提取行业名候选（高置信口径，20261103i）：
 * ① 按逗号/句号/分号切大句，大句必须含 涨/跌 动词（无动词的叙述句直接跳过，噪声控制）；
 * ② 大句内按顿号切分：a) 段内「前缀紧跟涨/跌」→ 取前缀（「电机涨5.18%」→ 电机）；
 *    b) 顿号链共享动词的无动词段（「软件开发、自动化设备涨近5%」的「软件开发」）→
 *       段为 2~8 字纯中文时取整段；
 * ③ 前缀尾部剥离复数/频度副词（「银行双双跌」→ 银行）与数字字母尾（「宇树科技20涨停」→ 宇树科技）。
 * 例：「电机涨5.18%居首，软件开发、自动化设备涨近5%」→ [电机, 软件开发, 自动化设备]。
 */
const SECTOR_TAIL_ADVERBS = ['双双', '纷纷', '同步', '集体', '携手', '合计', '共同', '连续', '再度', '继续'];
function parseSectors(text) {
  const out = [];
  const seen = new Set();
  const push = (name) => {
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  };
  const big = String(text || '').split(/[，,；;。\n]+/);
  for (const b of big) {
    if (!/[涨跌]/.test(b)) continue;   // 大句无涨跌动词 → 跳过（叙述句，不提行业候选）
    const parts = b.split('、');
    for (const seg of parts) {
      const s = seg.trim();
      if (!s) continue;
      const m = s.match(/^([\u4e00-\u9fa5A-Za-z0-9]{2,10}?)(?=涨|跌)/);
      if (m) {
        let name = m[1].replace(/[0-9A-Za-z]+$/, '').trim();   // 剥数字/字母尾
        let changed = true;
        while (changed) {
          changed = false;
          for (const adv of SECTOR_TAIL_ADVERBS) {
            if (name.length > adv.length && name.endsWith(adv)) { name = name.slice(0, -adv.length); changed = true; }
          }
        }
        push(name);
      } else if (parts.length > 1) {
        // 顿号链中无动词的段：整段为 2~8 字纯中文才作行业候选（长度/字符集双重噪声门槛）
        const m2 = s.match(/^([\u4e00-\u9fa5]{2,8})$/);
        if (m2) push(m2[1]);
      }
    }
  }
  return out;
}

/** 在指数列表里找主指数（沪指/上证指数）涨跌幅；找不到在【大盘】段兜底找「沪指涨/跌 x%」 */
function extractMarketPct(indices, wholeText) {
  const pri = indices.find(i => /^(沪指|上证指数|上证综指|沪)$/.test(i.name))
    || indices.find(i => /沪指|上证/.test(i.name));
  if (pri) return pri.changePct;
  const m = String(wholeText || '').match(/沪指(?:上涨|涨|下跌|跌)\s*([+-]?\d+(?:\.\d+)?)\s*%/);
  if (m) return Math.round(Number(m[1]) * 100) / 100;
  return null;
}

/**
 * 把一条 scope=market 笔记解析为结构化记录（纯函数）。
 * AI 复盘条目：交易日从 title「AI 大盘复盘 · YYYY-MM-DD」提取，段落标记解析；
 * 手写条目：无标记段落 → 结构字段如实置空，tradeDate 用笔记时间，全文参与关键词检索。
 */
function parseMarketNote(note) {
  const content = String((note && note.content) || '');
  const title = String((note && note.title) || '');
  const seg = (label) => {
    const m = content.match(new RegExp('【' + label + '】([^\\n]*)'));
    return m ? m[1].trim() : '';
  };
  const idxText = seg('指数收盘');
  const indices = idxText ? parseIndices(idxText) : [];
  const upText = seg('领涨板块');
  const downText = seg('领跌板块');
  const sectorsUp = upText ? parseSectors(upText) : [];
  const sectorsDown = downText ? parseSectors(downText) : [];
  const marketPct = extractMarketPct(indices, content);
  let direction = null;
  if (marketPct != null) direction = marketPct > 0 ? 'up' : marketPct < 0 ? 'down' : 'flat';
  const tm = title.match(/(\d{4}-\d{2}-\d{2})/);
  const tradeDate = tm ? tm[1] : localDateOf(note && note.date);
  const isAi = (note && note.ai === true) || (note && note.type === 'ai');
  return {
    noteId: String((note && note.id) || ''),
    tradeDate: tradeDate || null,
    direction,
    marketPct,
    indices,
    sectorsUp,
    sectorsDown,
    title,
    content,
    tags: Array.isArray(note && note.tags) ? note.tags.map(String) : [],
    source: isAi ? 'ai' : 'manual',
    createdAt: (note && note.date) || null,
    updatedAt: (note && note.updatedAt) || (note && note.date) || null,
  };
}

// ---------- SQLite（派生库） ----------

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(`CREATE TABLE IF NOT EXISTS market_log (
    note_id TEXT PRIMARY KEY,
    trade_date TEXT,
    direction TEXT,
    market_pct REAL,
    indices TEXT,
    sectors_up TEXT,
    sectors_down TEXT,
    title TEXT,
    content TEXT,
    tags TEXT,
    source TEXT,
    created_at TEXT,
    updated_at TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_mlog_date ON market_log(trade_date);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_mlog_dir ON market_log(direction);');
  return db;
}

function readMarketNotes() {
  try {
    const arr = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    return (Array.isArray(arr) ? arr : []).filter(n => n && n.scope === 'market');
  } catch (e) {
    return [];
  }
}

/**
 * 全量重建派生库（幂等）：notes.json 是权威源，库内多删少补。
 * @returns {{synced:number, rebuilt:boolean}}
 */
function syncMarketLog() {
  const notes = readMarketNotes();
  const records = notes.map(parseMarketNote).filter(r => r.noteId);
  const d = getDb();
  const tx = d.prepare('BEGIN');
  try {
    tx.run();
    d.prepare('DELETE FROM market_log').run();
    const ins = d.prepare(
      `INSERT INTO market_log (note_id, trade_date, direction, market_pct, indices, sectors_up, sectors_down, title, content, tags, source, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const r of records) {
      ins.run(
        r.noteId, r.tradeDate, r.direction, r.marketPct,
        JSON.stringify(r.indices), JSON.stringify(r.sectorsUp), JSON.stringify(r.sectorsDown),
        r.title, r.content, JSON.stringify(r.tags), r.source, r.createdAt, r.updatedAt
      );
    }
    d.prepare('COMMIT').run();
  } catch (e) {
    try { d.prepare('ROLLBACK').run(); } catch (e2) {}
    throw e;
  }
  try { _lastSyncMtimeMs = fs.statSync(NOTES_FILE).mtimeMs; } catch (e) { _lastSyncMtimeMs = null; }
  return { synced: records.length, rebuilt: true };
}

/** notes.json 变了才重建（mtime 检测；首次必建） */
function ensureSynced() {
  let mtime = null;
  try { mtime = fs.statSync(NOTES_FILE).mtimeMs; } catch (e) {}
  if (_lastSyncMtimeMs == null || mtime !== _lastSyncMtimeMs) return syncMarketLog();
  return { synced: count(), rebuilt: false };
}

function rowToRecord(r) {
  return {
    noteId: r.note_id,
    tradeDate: r.trade_date,
    direction: r.direction,
    marketPct: r.market_pct == null ? null : Number(r.market_pct),
    indices: JSON.parse(r.indices || '[]'),
    sectorsUp: JSON.parse(r.sectors_up || '[]'),
    sectorsDown: JSON.parse(r.sectors_down || '[]'),
    title: r.title,
    content: r.content,
    tags: JSON.parse(r.tags || '[]'),
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * 检索（全部条件 AND，可任意组合；一律先 ensureSynced）。
 * @param {object} p
 *   q        关键词（title/content/tags LIKE）
 *   sector   行业（sectors_up/sectors_down/indices/content LIKE —— 关键词匹配，非精确字段）
 *   direction 'up' | 'down' | 'flat'
 *   from/to  交易日范围（YYYY-MM-DD，闭区间）
 *   index    指数名（indices LIKE，如「创业板指」）
 *   limit    返回条数上限（默认 200）
 * @returns {{total:number, records:Array, facets:{sectors:Array}}}
 */
function searchMarketLog(p) {
  ensureSynced();
  const cond = [];
  const args = [];
  const q = String((p && p.q) || '').trim();
  if (q) { cond.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const sector = String((p && p.sector) || '').trim();
  if (sector) { cond.push('(sectors_up LIKE ? OR sectors_down LIKE ? OR content LIKE ?)'); args.push(`%${sector}%`, `%${sector}%`, `%${sector}%`); }
  const direction = String((p && p.direction) || '').trim();
  if (direction === 'up' || direction === 'down' || direction === 'flat') { cond.push('direction = ?'); args.push(direction); }
  const from = String((p && p.from) || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(from)) { cond.push('trade_date >= ?'); args.push(from); }
  const to = String((p && p.to) || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(to)) { cond.push('trade_date <= ?'); args.push(to); }
  const indexName = String((p && p.index) || '').trim();
  if (indexName) { cond.push('indices LIKE ?'); args.push(`%${indexName}%`); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const d = getDb();
  const total = d.prepare(`SELECT COUNT(*) AS n FROM market_log ${where}`).get(...args).n;
  const limit = Math.min(Math.max(Number(p && p.limit) || 200, 1), 1000);
  const rows = d.prepare(
    `SELECT * FROM market_log ${where} ORDER BY trade_date DESC, created_at DESC LIMIT ?`
  ).all(...args, limit);
  // facets：全库行业候选 top 20（供前端检索建议 datalist）
  const facetRows = d.prepare(`SELECT sectors_up, sectors_down FROM market_log`).all();
  const counter = new Map();
  for (const fr of facetRows) {
    for (const s of JSON.parse(fr.sectors_up || '[]')) counter.set(s, (counter.get(s) || 0) + 1);
    for (const s of JSON.parse(fr.sectors_down || '[]')) counter.set(s, (counter.get(s) || 0) + 1);
  }
  const facets = { sectors: Array.from(counter.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, count]) => ({ name, count })) };
  return { total, records: rows.map(rowToRecord), facets };
}

function count() {
  try { return getDb().prepare('SELECT COUNT(*) AS n FROM market_log').get().n; } catch (e) { return 0; }
}

/** 库概况（前端统计行）：条数 + 日期范围 */
function getStats() {
  ensureSynced();
  const d = getDb();
  const r = d.prepare('SELECT COUNT(*) AS n, MIN(trade_date) AS minD, MAX(trade_date) AS maxD FROM market_log').get();
  return { total: r.n, fromDate: r.minD || null, toDate: r.maxD || null, dbFile: DB_FILE };
}

/** 测试/重置辅助：关闭连接 */
function close() { try { if (db) { db.close(); db = null; _lastSyncMtimeMs = null; } } catch (e) { db = null; } }

module.exports = {
  parseMarketNote, parseIndices, parseSectors, extractMarketPct,
  syncMarketLog, ensureSynced, searchMarketLog, getStats, count, close,
  NOTES_FILE, DB_FILE,
};
