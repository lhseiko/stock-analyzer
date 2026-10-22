/**
 * thsDailyCache.js — 同花顺日K原始响应本地缓存（20261022f，用户方案 C）
 * ==========================================================
 * 用户问题（2026-10-22）：
 *   「同花顺 all.js 高频请求会触发 502 限流的问题，能否通过一次获取本地保存的方法解决，
 *    保存需要的容量很大吗？」→ 实测后确认可行且容量可忽略，按「存原始文本」方案落地。
 *
 * 为什么存**原始响应文本**而不是解码后的数组（方案选择依据，实测 2026-10-22）：
 *   | 形态                          | 单股体积（实测 603288/601318/600519） |
 *   |-------------------------------|----------------------------------------|
 *   | last.js + all.js 原始文本     | 约 148 KB  ← 最小                     |
 *   | 解码后精简 {d,o,h,l,c,v} 全量 | 约 334 KB                             |
 *   | 解码后完整字段 全量           | 约 556 KB                             |
 *   | 只留引擎要的 320 根完整字段   | 约 35 KB                              |
 *   存原始文本的关键好处：读缓存后走的是**完全相同的解码/校验路径**
 *   （`_decodeThsAll` → `_mergeThsBars` 重叠段 close 闸门），只在「文本从哪来」这一步分叉，
 *   因此缓存结果与实时拉取**逐字节一致**，不会出现「解码逻辑改了、旧缓存却是按旧逻辑算的」这种口径漂移。
 *   另外原始文本是信息的超集，将来 all.js 若增字段无需重拉。
 *
 * 刷新节奏（三段式 slot：交易日 + 时段），把请求压到最低：
 *   - 交易日 09:30–15:05（phase=intraday）：当天首次抓取后整个盘中复用；
 *   - 交易日 ≥15:05（phase=closed）：盘中缓存作废，补抓一次拿当日完整收盘K，之后复用；
 *   - 非交易日（周末/节假日）：一律 phase=closed，锚定上一个交易日 → 全天复用同一份。
 *   结果：每只股票每个交易日**最多 2 次网络请求**（正常节奏 1 次），彻底脱离 502 限流区间。
 *
 * 为什么「盘中缓存可直接复用」是安全的：
 *   20261022c 已确立「所有有效突破/破位/打穿只认当日收盘价」，`zoneValidity.finalizedBars`
 *   会把当日未收盘的 K 线剔除，所以盘中那份当日数据本来就不参与任何判定；
 *   而展示层的当日价格由腾讯实时 quote 覆写（volumeEngine），不受日K快照影响。
 *
 * 容量结论（实测）：
 *   9 只自选 ≈ 1.3 MB；31 只 ≈ 4.6 MB；200 只 ≈ 30 MB。
 *   每只股票固定一个文件、**每日覆盖写**，不会随天数累积增长。
 *
 * 纯函数（resolveSlot / isFresh）零 IO，便于单测；读写函数各自 fail-open 到「未命中」，
 * 任何异常都只是退回联网，绝不让缓存问题阻塞行情分析。
 */
const fs = require('fs');
const path = require('path');
const { bjParts, localDate } = require('./localDate');
const { isTradingDay, previousTradingDay } = require('./cnTradingCalendar');

const DIR = path.join(__dirname, '..', 'data', 'cache', 'ths-daily');
const SCHEMA = 1;

/** 收盘定稿时刻（HHMM）：与 zoneValidity.finalizedBars 的 closeHhmm 同口径 */
const CLOSE_HHMM = 1505;

/**
 * 硬过期兜底：同一交易日的数据本应恒定，tradeDate+phase 匹配即足够；
 * 这里只为「系统时钟被回拨/篡改」留一道闸。15 天可覆盖最长假期（春节/国庆 9 天）。
 */
const MAX_AGE_MS = 15 * 24 * 3600 * 1000;

/** 缓存时间戳允许的「未来」上限（超此值视为时钟异常，不信该缓存） */
const MAX_FUTURE_MS = 3600 * 1000;

function normalizeSymbol(s) {
  const raw = String(s || '').trim();
  const m = raw.match(/(\d{6})/);
  return m ? m[1] : raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

function fileFor(sym) { return path.join(DIR, normalizeSymbol(sym) + '.json'); }

function ensureDir() {
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  } catch (e) {
    console.warn('[ThsDailyCache] 创建目录失败（落盘时再报错）:', e && e.message ? e.message : e);
  }
}

/**
 * 纯函数：算出此刻应锚定的「交易日 + 时段阶段」。
 * @param {Date|number|string} now
 * @param {{closeHhmm?:number}} [opts]  closeHhmm 仅供单测覆盖
 * @returns {{tradeDate:string, phase:'intraday'|'closed', isTradingDay:boolean, hhmm:number}}
 */
function resolveSlot(now, opts) {
  const d = now instanceof Date ? now : (now == null ? new Date() : new Date(now));
  const p = bjParts(isNaN(d.getTime()) ? new Date() : d);
  const today = p ? `${p.year}-${p.month}-${p.day}` : localDate();
  const hhmm = p ? Number(p.hour) * 100 + Number(p.minute) : 0;
  const limit = Number.isFinite(opts && opts.closeHhmm) ? opts.closeHhmm : CLOSE_HHMM;
  const trading = isTradingDay(today);
  if (!trading) {
    // 非交易日不存在盘中变化 → 一律按 closed 锚定上一个交易日（周末/长假全程复用同一份）
    return { tradeDate: previousTradingDay(today), phase: 'closed', isTradingDay: false, hhmm };
  }
  return { tradeDate: today, phase: hhmm >= limit ? 'closed' : 'intraday', isTradingDay: true, hhmm };
}

/**
 * 纯函数：判断一条已解析缓存是否命中当前 slot。
 * 返回 why 便于诊断（命中='ok'）。
 * @param {object|null} rec
 * @param {object} slot         resolveSlot 的结果
 * @param {number} [nowMs]
 * @returns {{hit:boolean, why:string}}
 */
function isFresh(rec, slot, nowMs) {
  if (!rec || typeof rec !== 'object') return { hit: false, why: 'no_cache' };
  if (Number(rec.schema) !== SCHEMA) return { hit: false, why: 'schema_mismatch' };
  if (typeof rec.lastRaw !== 'string' || !rec.lastRaw) return { hit: false, why: 'corrupt_last' };
  // all.js 缺失（当场拉取失败）不算有效缓存：否则一整天都会卡在「只有 140 根」的残缺态
  if (typeof rec.allRaw !== 'string' || !rec.allRaw) return { hit: false, why: 'incomplete_all' };
  if (!slot || !slot.tradeDate) return { hit: false, why: 'bad_slot' };
  if (rec.tradeDate !== slot.tradeDate) return { hit: false, why: 'trade_date_changed' };
  if (rec.phase !== slot.phase) return { hit: false, why: 'phase_changed' };
  const at = Number(rec.fetchedAt);
  if (!Number.isFinite(at)) return { hit: false, why: 'corrupt_fetchedAt' };
  const ts = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (ts - at > MAX_AGE_MS) return { hit: false, why: 'stale' };
  if (at - ts > MAX_FUTURE_MS) return { hit: false, why: 'clock_ahead' };
  return { hit: true, why: 'ok' };
}

/**
 * 读缓存。任何 IO / 解析异常一律降级为「未命中」，交由调用方联网。
 * @returns {{hit:boolean, why:string, rec:object|null}}
 */
function readCache(symbol, slot, nowMs) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return { hit: false, why: 'bad_symbol', rec: null };
  let text;
  try {
    text = fs.readFileSync(fileFor(sym), 'utf8');
  } catch (e) {
    // 文件不存在是最常见路径（首次访问），不告警；其它错误才提示
    if (e && e.code !== 'ENOENT') {
      console.warn('[ThsDailyCache] 读缓存失败，改走网络:', e.message);
      return { hit: false, why: 'read_error', rec: null };
    }
    return { hit: false, why: 'missing', rec: null };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    console.warn('[ThsDailyCache] 缓存 JSON 损坏，改走网络:', e.message);
    return { hit: false, why: 'corrupt', rec: null };
  }
  const verdict = isFresh(raw, slot, nowMs);
  return { hit: verdict.hit, why: verdict.why, rec: verdict.hit ? raw : null };
}

/**
 * 写缓存（原子写：先 .tmp 再 rename，避免读到半截文件）。
 * 写失败不抛给调用方判断逻辑——直接抛，由调用方 try/catch 记录并忽略（缓存不阻塞主流程）。
 */
function writeCache(symbol, slot, lastRaw, allRaw, nowMs) {
  const sym = normalizeSymbol(symbol);
  if (!sym || !slot || !slot.tradeDate) throw new Error('writeCache: 参数不完整');
  if (typeof lastRaw !== 'string' || !lastRaw) throw new Error('writeCache: lastRaw 为空');
  if (typeof allRaw !== 'string' || !allRaw) throw new Error('writeCache: allRaw 为空');
  ensureDir();
  const ts = Number.isFinite(nowMs) ? nowMs : Date.now();
  const payload = {
    schema: SCHEMA,
    symbol: sym,
    tradeDate: slot.tradeDate,
    phase: slot.phase,
    fetchedAt: ts,
    fetchedAtText: new Date(ts).toISOString(),
    bytes: { last: Buffer.byteLength(lastRaw, 'utf8'), all: Buffer.byteLength(allRaw, 'utf8') },
    lastRaw,
    allRaw,
  };
  const file = fileFor(sym);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (cleanErr) {
      console.warn('[ThsDailyCache] 临时文件清理失败（将被下次写入覆盖）:', cleanErr && cleanErr.message ? cleanErr.message : cleanErr);
    }
    throw e;
  }
  return payload;
}

/** 缓存的元信息（诊断用：体积 / 锚定日期 / 时段），不返回原始文本 */
function cacheMeta(symbol) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(fileFor(sym), 'utf8'));
  } catch (e) {
    if (e && e.code !== 'ENOENT') console.warn('[ThsDailyCache] 读元信息失败:', e.message);
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  return {
    symbol: raw.symbol || sym,
    schema: raw.schema,
    tradeDate: raw.tradeDate || null,
    phase: raw.phase || null,
    fetchedAt: Number(raw.fetchedAt) || null,
    fetchedAtText: raw.fetchedAtText || null,
    bytes: raw.bytes || {
      last: typeof raw.lastRaw === 'string' ? Buffer.byteLength(raw.lastRaw, 'utf8') : 0,
      all: typeof raw.allRaw === 'string' ? Buffer.byteLength(raw.allRaw, 'utf8') : 0,
    },
  };
}

module.exports = {
  DIR,
  SCHEMA,
  CLOSE_HHMM,
  MAX_AGE_MS,
  MAX_FUTURE_MS,
  normalizeSymbol,
  fileFor,
  resolveSlot,
  isFresh,
  readCache,
  writeCache,
  cacheMeta,
};
