/**
 * 阻力 / 支撑区间 · 放量突破反转（20261022b，用户新增规则）
 * ==========================================================
 * 用户原话（2026-10-22）：
 *   「如果上方阻力区间或下方支撑区间被放量有效突破，该区间将被记录下来
 *    （已收紧部分、被侵蚀规则排除部分不算），转换成反方向区间，
 *    例如下方支撑区间被有效放量打穿后，系统自动记录下来，然后转换为上方阻力区间
 *    （允许多次转换），直到被有效性检验判定为无效才从记录删除。」
 *
 * 落地口径（可核对，勿擅自放宽/收紧）：
 *   - 「有效放量突破」= 收盘越过区间**远端**（阻力 > high / 支撑 < low）且该日量比 > 1.2，
 *     并且**当前仍在外侧**（突破站住才算「有效」，当日冲高即回落不算）。
 *   - 反转 = 角色互换：上破阻力 → 该位变支撑；下破支撑 → 该位变阻力。
 *   - 区间几何：沿用**侵蚀后的当前区间**（已收紧/被侵蚀排除的部分不再纳入）——
 *     这与 zoneValidity 的「远端恒不变、只收紧近端」一致：反转记录的是当下的有效区间。
 *   - 允许多次反转：每次在新的当前方向上再次「放量有效突破」就再翻一次，累计 flipCount。
 *   - 终止：反转记录本身继续接受**标准1**（无放量轻松突破）检验——一旦被无放量穿越，
 *     即判定该区间无效，从记录中删除。
 *   - 量能缺失（量比 null）→ 不翻转也不删除（无法确认放量/无放量，绝不臆断）。
 *
 * 与模型的隔离：
 *   - 只从**模型生成的区间**（非手动、非反转）创建反转记录；手动区间不参与反转。
 *   - 反转记录落盘 `data/zone-reversals/<6位>.json`，不影响方向判断/概率/④卡/准确率
 *     （这些在 analyzePriceAction 内部、本模块之前已算完）。
 *
 * 纯函数（replayRecord / createRecordFromZone）零 IO，便于单测；attachReversedZones 负责读写。
 */
const fs = require('fs');
const path = require('path');
const { volRatioAt, BREAK_VOL_MIN } = require('./zoneValidity');

const DIR = path.join(__dirname, '..', 'data', 'zone-reversals');
const SCHEMA = 1;
const MAX_RECORDS = 40;   // 单股反转记录上限（防历史无限累积；超出丢弃最早评估的）

const r2 = (n) => Math.round(n * 100) / 100;
const _num = (v) => {
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
function normalizeSymbol(s) {
  const raw = String(s || '').trim();
  const m = raw.match(/(\d{6})/);
  return m ? m[1] : raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}
function fileFor(sym) { return path.join(DIR, normalizeSymbol(sym) + '.json'); }
function ensureDir() {
  try { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); } catch (e) {
    console.warn('[ZoneReversal] 创建目录失败（落盘时再报错）:', e && e.message ? e.message : e);
  }
}

function oppositeSide(side) { return side === 'resistance' ? 'support' : 'resistance'; }
function isBeyond(rec, close) { return rec.side === 'resistance' ? close > rec.high : close < rec.low; }
function rangesIntersect(a, b) {
  const al = _num(a && a.low), ah = _num(a && a.high), bl = _num(b && b.low), bh = _num(b && b.high);
  if (al == null || ah == null || bl == null || bh == null) return false;
  return al <= bh && bl <= ah;
}

/** 读盘（缺文件/坏 JSON → 空，不编造） */
function loadRecords(symbol) {
  const sym = normalizeSymbol(symbol);
  const base = { symbol: sym, schema: SCHEMA, records: [], updatedAt: null };
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(sym), 'utf8'));
    if (!raw || !Array.isArray(raw.records)) return base;
    const records = raw.records.filter(r => r
      && (r.side === 'resistance' || r.side === 'support')
      && (r.originSide === 'resistance' || r.originSide === 'support')
      && _num(r.low) > 0 && _num(r.high) > 0 && _num(r.low) <= _num(r.high))
      .map(r => ({
        id: String(r.id || ''),
        low: r2(_num(r.low)),
        high: r2(_num(r.high)),
        side: r.side,
        originSide: r.originSide,
        flipCount: Number(r.flipCount) || 0,
        history: Array.isArray(r.history) ? r.history.slice(-20) : [],
        lastEvalDate: r.lastEvalDate || null,
        wasBeyond: typeof r.wasBeyond === 'boolean' ? r.wasBeyond : null,
        active: r.active !== false,
        invalidReason: r.invalidReason || null,
        createdAt: r.createdAt || null,
      }));
    return { symbol: sym, schema: SCHEMA, records, updatedAt: raw.updatedAt || null };
  } catch (e) {
    return base;
  }
}

function saveRecords(symbol, records) {
  ensureDir();
  const sym = normalizeSymbol(symbol);
  const list = Array.isArray(records) ? records.slice(-MAX_RECORDS) : [];
  const payload = { symbol: sym, schema: SCHEMA, records: list, updatedAt: new Date().toISOString() };
  fs.writeFileSync(fileFor(sym), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * 把一条反转记录推进到最新日K（纯函数，不改入参）。
 * 只在 lastEvalDate 之后的新交易日上判断：
 *   - 出现「放量」（量比 > 1.2）的有效突破 → 翻转角色（可多次）
 *   - 出现「无放量」（量比 ≤ 1.2）的突破 → 标准1 判无效 → active=false（删除）
 *   - 量能缺失 → 不翻转、不删除
 * @returns {object} 新记录（可能 active=false）
 */
function replayRecord(rec, bars) {
  const out = Object.assign({}, rec, { history: Array.isArray(rec.history) ? rec.history.slice() : [] });
  if (!Array.isArray(bars) || bars.length === 0) return out;
  if (out.active === false) return out;
  const lastEval = out.lastEvalDate || null;
  let prevBeyond = (out.wasBeyond === true) ? true : (out.wasBeyond === false ? false : null);
  // 只处理日期严格晚于 lastEvalDate 的K线（避免同一事件反复翻转）
  let i0 = 0;
  if (lastEval) {
    i0 = bars.length;
    for (let k = 0; k < bars.length; k++) {
      if (String((bars[k] && bars[k].date) || '') > lastEval) { i0 = k; break; }
    }
  }
  for (let i = i0; i < bars.length; i++) {
    const c = _num(bars[i] && bars[i].close);
    if (c == null) continue;
    let beyond = isBeyond(out, c);
    if (prevBeyond === false && beyond === true) {
      const vr = volRatioAt(bars, i);
      if (vr != null && vr > BREAK_VOL_MIN) {
        const from = out.side;
        out.side = oppositeSide(from);
        out.flipCount = (Number(out.flipCount) || 0) + 1;
        out.history.push({ date: (bars[i] && bars[i].date) || null, from, to: out.side, vr, close: r2(c) });
        beyond = isBeyond(out, c);   // 翻转后按新方向重算是否在外侧
      } else if (vr != null && vr <= BREAK_VOL_MIN) {
        // 无放量轻松穿越 → 标准1 判无效 → 删除记录
        out.active = false;
        out.invalidReason = `反转记录被无放量穿越（量比 ${vr} ≤ ${BREAK_VOL_MIN}），按标准1 失效`;
        out.lastEvalDate = (bars[i] && bars[i].date) || lastEval;
        return out;
      }
      // vr == null → 量能缺失，不翻转也不删除
    }
    prevBeyond = beyond;
  }
  out.wasBeyond = prevBeyond;
  out.lastEvalDate = (bars[bars.length - 1] && bars[bars.length - 1].date) || lastEval;
  return out;
}

/**
 * 由一条「已被放量有效突破」的模型区间创建反转记录（纯函数）。
 * 条件：最近一次突破为放量（量比 > 1.2）且**当前仍在外侧**（有效突破，非当日冲高即回落）。
 * @returns {object|null}
 */
function createRecordFromZone(zone, side, bars) {
  if (!zone || !Array.isArray(bars) || bars.length === 0) return null;
  const lo = _num(zone.low), hi = _num(zone.high);
  if (lo == null || hi == null || !(hi >= lo)) return null;
  const ck = zone.zoneCheck || {};
  const vr = _num(ck.lastBreakVr);
  if (!(vr != null && vr > BREAK_VOL_MIN)) return null;
  if (!(Number(ck.breakCount) > 0)) return null;
  const lastBar = bars[bars.length - 1];
  const lastClose = _num(lastBar && lastBar.close);
  if (lastClose == null) return null;
  const stillBeyond = side === 'resistance' ? lastClose > hi : lastClose < lo;
  if (!stillBeyond) return null;   // 有效突破才算：突破后仍在外侧
  const newSide = oppositeSide(side);
  const rec = {
    id: 'zr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    low: r2(lo), high: r2(hi),
    originSide: side,
    side: newSide,
    flipCount: 1,
    history: [{ date: ck.lastBreakDate || null, from: side, to: newSide, vr, close: r2(lastClose) }],
    lastEvalDate: (lastBar && lastBar.date) || null,
    wasBeyond: null,
    active: true,
    invalidReason: null,
    createdAt: new Date().toISOString(),
  };
  rec.wasBeyond = isBeyond(rec, lastClose);
  return rec;
}

function _findDuplicate(records, zone, side) {
  return (records || []).find(r => r.originSide === side && rangesIntersect(r, zone));
}

function _buildZone(rec) {
  return {
    low: rec.low,
    high: rec.high,
    source: '放量突破反转',
    isReversed: true,
    reversedFrom: rec.originSide,
    flipCount: rec.flipCount || 1,
    reversalHistory: rec.history || [],
    valid: true,
    invalidReasons: [],
    zoneCheck: { side: rec.side, breakVolMin: BREAK_VOL_MIN, reversed: true, flipCount: rec.flipCount || 1 },
  };
}

/**
 * 快照接线：读出反转记录 → 推进（翻转/失效）→ 从模型区间补充新记录 →
 * 把有效记录注入对应阻力/支撑清单（并移除被反转取代的原始区间）→ 落盘。
 * 失败一律降级（不改动 data 其它部分），不阻塞②卡。
 * @param {object} data  analyzePriceAction 结果（含 shortTerm）
 * @param {Array}  daily 日K
 * @param {string} symbol
 */
function attachReversedZones(data, daily, symbol) {
  if (!data || !data.shortTerm || !Array.isArray(daily) || daily.length < 2) return data;
  let store;
  try { store = loadRecords(symbol); } catch (e) { return data; }
  let records = (store.records || []).slice();

  // 1) 推进既有记录
  try {
    records = records.map(r => replayRecord(r, daily)).filter(r => r.active !== false);
  } catch (e) {
    console.warn('[ZoneReversal] 反转记录推进失败（按原样保留）:', e && e.message ? e.message : e);
  }

  // 2) 从模型区间补充新反转记录（手动/反转来源不参与）
  const suppress = [];
  try {
    const groups = [
      ['resistance', data.shortTerm.resistances],
      ['support', data.shortTerm.supports],
    ];
    for (const [side, arr] of groups) {
      if (!Array.isArray(arr)) continue;
      for (const z of arr) {
        if (!z || z.isManual || z.isReversed) continue;
        if (!z.zoneCheck) continue;
        const vr = _num(z.zoneCheck.lastBreakVr);
        if (!(vr != null && vr > BREAK_VOL_MIN)) continue;
        if (!(Number(z.zoneCheck.breakCount) > 0)) continue;
        if (_findDuplicate(records, z, side)) { suppress.push({ side, z }); continue; }
        const rec = createRecordFromZone(z, side, daily);
        if (rec) { records.push(rec); suppress.push({ side, z }); }
      }
    }
  } catch (e) {
    console.warn('[ZoneReversal] 新反转记录生成失败（本次不新增）:', e && e.message ? e.message : e);
  }

  // 3) 移除被反转取代的原始模型区间（同一位置只保留反转后的方向）
  for (const { side, z } of suppress) {
    const arr = side === 'resistance' ? data.shortTerm.resistances : data.shortTerm.supports;
    const idx = Array.isArray(arr) ? arr.indexOf(z) : -1;
    if (idx >= 0) arr.splice(idx, 1);
  }

  // 4) 注入有效反转区间
  const active = records.filter(r => r.active !== false);
  for (const rec of active) {
    const zone = _buildZone(rec);
    const arr = rec.side === 'resistance' ? data.shortTerm.resistances : data.shortTerm.supports;
    if (Array.isArray(arr)) arr.push(zone);
  }

  // 5) 落盘（含刚失效的记录会被 filter 掉，不再写回）。
  //    没有活动记录且此前也没有落盘文件 → 不创建空文件（避免为每只股票都生成一个空 json）。
  try {
    if (active.length > 0 || fs.existsSync(fileFor(symbol))) saveRecords(symbol, active);
  } catch (e) {
    console.warn('[ZoneReversal] 反转记录落盘失败:', e && e.message ? e.message : e);
  }

  data.zoneReversalMeta = {
    total: active.length,
    note: '放量有效突破 → 反方向区间（可多次反转）；被标准1（无放量轻松突破）判无效时自动移除。',
  };
  return data;
}

module.exports = {
  attachReversedZones, replayRecord, createRecordFromZone,
  loadRecords, saveRecords, oppositeSide, rangesIntersect,
  normalizeSymbol, DIR, MAX_RECORDS, SCHEMA,
};
