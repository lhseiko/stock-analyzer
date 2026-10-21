/**
 * 手动阻力 / 支撑区间（用户自填，20261021d）
 * ==========================================================
 * 需求（用户 2026-10-21）：「模块添加一条 tab：可以自行手动添加上方阻力区间和下方支撑区间。」
 *
 * 定位：②「短期动向预判」卡新增一个「手动添加」页签，用户可自己标注模型没识别到的关键位。
 *
 * 三条口径纪律（与模型区间**严格隔离**，否则会污染准确率归因）：
 *   1. 手动区间**不参与** `lib/zoneValidity.js` 的有效性检验、**不参与**侵蚀收缩——
 *      它是用户的主观标注，模型无权判定它"无效"或"已被吃掉"。
 *   2. 手动区间**不参与**方向判断、概率、④卡反转边界、任何准确率统计，只做展示。
 *   3. 落盘在 `data/manual-zones/<symbol>.json`，与模型的 `data/judgments`、`data/market-tech` 互不相干。
 *
 * 存储结构：
 *   { symbol: '600909', zones: [ { id, side, low, high, note, createdAt } ], updatedAt }
 *
 * 校验：side 必须 resistance/support；low/high 必须 >0 且 low<=high；同侧同区间去重；
 *       每侧最多 MAX_PER_SIDE 条（防误点刷屏）；备注截断到 40 字。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'manual-zones');
const MAX_PER_SIDE = 20;
const NOTE_MAX = 40;
const ROUND = 2;

function ensureDir() { try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) {} }
function fileFor(symbol) { return path.join(DIR, normalizeSymbol(symbol) + '.json'); }

/** 统一代码：允许 sh600909 / 600909.SH / 600909，一律归一为 6 位数字 */
function normalizeSymbol(s) {
  const raw = String(s || '').trim();
  const m = raw.match(/(\d{6})/);
  return m ? m[1] : raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

const r2 = (n) => Math.round(n * 100) / 100;
const _num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : null;
};

function readStore(symbol) {
  const sym = normalizeSymbol(symbol);
  const base = { symbol: sym, zones: [], updatedAt: null };
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(sym), 'utf8'));
    if (!raw || !Array.isArray(raw.zones)) return base;
    // 读侧也做一次净化：脏数据（写坏的区间/非法 side）不进入展示
    const zones = raw.zones.filter(z => z && (z.side === 'resistance' || z.side === 'support')
      && _num(z.low) > 0 && _num(z.high) > 0 && _num(z.low) <= _num(z.high))
      .map(z => ({
        id: String(z.id || ''),
        side: z.side,
        low: r2(_num(z.low)),
        high: r2(_num(z.high)),
        note: String(z.note || '').slice(0, NOTE_MAX),
        createdAt: z.createdAt || null,
      }));
    return { symbol: sym, zones, updatedAt: raw.updatedAt || null };
  } catch (e) {
    return base;   // 文件不存在 / 解析失败 → 空，不编造
  }
}

function writeStore(symbol, store) {
  ensureDir();
  const sym = normalizeSymbol(symbol);
  const payload = { symbol: sym, zones: store.zones, updatedAt: new Date().toISOString() };
  fs.writeFileSync(fileFor(sym), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/** 列表（按价格降序返回，前端直接渲染即可） */
function listZones(symbol) {
  const s = readStore(symbol);
  const byPriceDesc = (a, b) => (b.high - a.high) || (b.low - a.low);
  return {
    symbol: s.symbol,
    resistances: s.zones.filter(z => z.side === 'resistance').sort(byPriceDesc),
    supports: s.zones.filter(z => z.side === 'support').sort(byPriceDesc),
    total: s.zones.length,
    updatedAt: s.updatedAt,
    limits: { maxPerSide: MAX_PER_SIDE, noteMax: NOTE_MAX },
  };
}

/**
 * 新增一条手动区间。
 * @returns {{ok:boolean, zone?:object, data?:object, error?:string}}
 */
function addZone(symbol, input) {
  const sym = normalizeSymbol(symbol);
  if (!sym) return { ok: false, error: '股票代码无效' };
  const side = String((input && input.side) || '').trim();
  if (side !== 'resistance' && side !== 'support') return { ok: false, error: '方向必须是阻力或支撑' };
  const low = _num(input && input.low);
  let high = _num(input && input.high);
  if (low == null) return { ok: false, error: '请填写有效价格' };
  // 只填一个价位 = 单点区间（前端也这么传，接口层再兜一次，避免调用方漏传 high 就被判非法）
  if (high == null && String((input && input.high) || '').trim() === '') high = low;
  if (high == null) return { ok: false, error: '请填写有效价格' };
  if (!(low > 0) || !(high > 0)) return { ok: false, error: '价格必须大于 0' };
  if (low > high) return { ok: false, error: '下沿不能高于上沿' };

  const store = readStore(sym);
  const l = r2(low), h = r2(high);
  const same = store.zones.filter(z => z.side === side);
  if (same.some(z => z.low === l && z.high === h)) {
    return { ok: false, error: '该区间已存在' };
  }
  if (same.length >= MAX_PER_SIDE) {
    return { ok: false, error: `每侧最多 ${MAX_PER_SIDE} 条，请先删除旧条目` };
  }
  const zone = {
    id: 'mz_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    side,
    low: l,
    high: h,
    note: String((input && input.note) || '').trim().slice(0, NOTE_MAX),
    createdAt: new Date().toISOString(),
  };
  store.zones.push(zone);
  const data = writeStore(sym, store);
  return { ok: true, zone, data: listZones(sym) };
}

/** 删除一条（按 id） */
function removeZone(symbol, id) {
  const sym = normalizeSymbol(symbol);
  const store = readStore(sym);
  const idx = store.zones.findIndex(z => z.id === String(id || ''));
  if (idx < 0) return { ok: false, error: '未找到该条目' };
  const [removed] = store.zones.splice(idx, 1);
  writeStore(sym, store);
  return { ok: true, removed, data: listZones(sym) };
}

module.exports = { listZones, addZone, removeZone, normalizeSymbol, DIR, MAX_PER_SIDE, NOTE_MAX };
