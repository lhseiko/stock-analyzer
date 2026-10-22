/**
 * 阻力 / 支撑区间口径（20261020i 建 → 20261020l 修正口径 → 20261020m 增侵蚀 → 20261022b 删标准2）
 * ==========================================================
 * 本文件负责两件事，**顺序不可颠倒**：
 *   ① `assessZone/assessZones` —— **有效性检验**：这个位还值不值得展示。
 *   ② `erodeZone/erodeZones`   —— **侵蚀收缩**：能展示的话，它还剩下多大（无放量侵入但未打穿 → 近端收紧）。
 * 先判有效性再收缩几何；侵蚀结果不回灌 ①，否则会形成「越侵蚀越有效」的自我强化。
 *
 * 用户 2026-10-20 给过两条标准；**2026-10-22 用户要求彻底删除标准2**（超过三天来回突破），
 * 只保留标准1（原话）：
 *   1）「如果股价不需要放量就轻松突破，则判定无效。」
 *   → 无效价格区间无需展示。
 * 注：2026-10-22 同步新增「放量有效突破 → 角色反转」规则（lib/zoneReversal.js）：
 *   放量突破不再由本文件判无效，而由反转模块翻成反方向区间并记录，
 *   直到本文件的标准1判无效才从记录删除。
 *
 * 【方向性】
 *   阻力只关心「向上穿越」；支撑只关心「向下穿越」。反方向穿越不计入突破——股价从上方掉下来
 *   穿过某个价位，对该价位作为「上方阻力」的身份不构成突破，不能拿它来判死。
 *   端点口径：close == high / low 视为区间内（穿越时用 > high / < low）。
 *
 * 【标准1 · 无放量轻松突破】（唯一有效性标准）
 *   取最近一次「真突破」（收盘越过区间**远端**：阻力 > high、支撑 < low）的交易日，
 *   量比 = 当日成交量 ÷ 前 5 日均量（不含当日）。
 *   量比 > 1.2 视为放量（与 volumeEngine `_volumeTier` 的「放量 >1.2」同源，不另立一套）。
 *   量比 ≤ 1.2 → 不需要放量就能穿过去 → 无效。
 *   量能缺失（前 5 日不足 / 成交量为 0）→ 本条不判定，也不臆造量比。
 *
 * 纯函数、零网络：入参为日K数组 + 区间列表，返回带 valid / invalidReasons / zoneCheck 的区间列表。
 */
const LOOKBACK_DAYS = 60;
const VOL_AVG_DAYS = 5;
const BREAK_VOL_MIN = 1.2;   // 放量阈值（与 volumeEngine._volumeTier 同源）

function _num(v) {
  // 注意：Number(null) === 0、Number('') === 0 —— 必须先挡掉空值，否则「缺字段」会被当成价格为 0，
  // 导致 close > 0 恒成立、整个区间被判成「当前站在外侧」而误杀（测试 [9] 已锁定）。
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// 第 i 日相对「前 5 日均量」的量比；数据不足返回 null（不臆断）
function volRatioAt(bars, i) {
  if (i < VOL_AVG_DAYS) return null;
  const cur = _num(bars[i] && bars[i].volume);
  if (cur == null || cur <= 0) return null;
  let sum = 0;
  for (let k = i - VOL_AVG_DAYS; k < i; k++) {
    const v = _num(bars[k] && bars[k].volume);
    if (v == null || v <= 0) return null;
    sum += v;
  }
  const avg = sum / VOL_AVG_DAYS;
  if (!(avg > 0)) return null;
  return Math.round((cur / avg) * 100) / 100;
}

/**
 * 单区间检验
 * @param {Array} bars   日K（升序，含 date/open/high/low/close/volume）
 * @param {Object} zone  { low, high, source }
 * @param {'resistance'|'support'} side
 */
function assessZone(bars, zone, side) {
  const lo = _num(zone && zone.low);
  const hi = _num(zone && zone.high);
  const base = { valid: true, invalidReasons: [], zoneCheck: null };
  if (lo == null || hi == null || !(hi >= lo)) return base;   // 脏数据不判死，按有效透传

  const list = Array.isArray(bars) ? bars : [];
  const n = list.length;
  const start = Math.max(0, n - LOOKBACK_DAYS);
  const isRes = side === 'resistance';
  // 「真突破」：收盘越过区间**远端**（阻力 > high、支撑 < low）。标准1 只看这一种穿越。
  const beyondOf = (c) => (isRes ? c > hi : c < lo);

  let breakCount = 0;          // 从内→外 的次数（真正"突破/跌破"的次数）
  let lastBreakIdx = -1;
  let prevBeyond = null;
  for (let i = start; i < n; i++) {
    const c = _num(list[i] && list[i].close);
    if (c == null) continue;
    const beyond = beyondOf(c);
    if (prevBeyond === false && beyond === true) { breakCount += 1; lastBreakIdx = i; }
    prevBeyond = beyond;
  }

  const vr = lastBreakIdx >= 0 ? volRatioAt(list, lastBreakIdx) : null;
  const lastBreakDate = lastBreakIdx >= 0 ? (list[lastBreakIdx].date || null) : null;
  const dirTxt = isRes ? '向上突破' : '向下跌破';
  const reasons = [];

  // 唯一有效性标准：最近一次真突破是「无放量轻松穿越」→ 无效。
  if (lastBreakIdx >= 0 && vr != null && vr <= BREAK_VOL_MIN) {
    reasons.push(`最近一次${dirTxt}（${lastBreakDate}）量比 ${vr} ≤ ${BREAK_VOL_MIN}，属无放量轻松穿越`);
  }

  return {
    valid: reasons.length === 0,
    invalidReasons: reasons,
    zoneCheck: {
      lookbackDays: Math.min(LOOKBACK_DAYS, n),
      side,
      breakCount,
      lastBreakDate,
      lastBreakVr: vr,
      breakVolMin: BREAK_VOL_MIN,
      volUnknown: lastBreakIdx >= 0 && vr == null,
    },
  };
}

/**
 * 20261022c（用户口径）：突破 / 破位 / 打穿一律以**当日收盘价**为准，不认分时价。
 * 数据源（Sina 日K）盘中实测不含当日这根（最后一根 = 上一交易日收盘）；
 * 但为防任何来源塞入「未收盘的当日K线」用盘中最新价冒充收盘价，这里统一过滤：
 *   末根 date == 今天 且 现在未到收盘（默认 15:05）→ 丢弃该根，只用已收盘的日K。
 * @param {Array} bars
 * @param {Date} [now]
 * @param {number} [closeHhmm] 收盘时刻 HHMM（A股 15:00 + 5 分钟落定）
 */
function finalizedBars(bars, now, closeHhmm) {
  const list = Array.isArray(bars) ? bars : [];
  if (list.length === 0) return list;
  const n = now instanceof Date ? now : new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const today = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
  const last = list[list.length - 1];
  const lastDate = String((last && last.date) || '').slice(0, 10);
  if (lastDate !== today) return list;                 // 末根不是今天 → 已是收盘价
  const limit = Number.isFinite(closeHhmm) ? closeHhmm : 1505;
  const hhmm = n.getHours() * 100 + n.getMinutes();
  if (hhmm >= limit) return list;                      // 已收盘 → 当日收盘价可用
  return list.slice(0, -1);                            // 未收盘 → 丢弃当日K线
}

/**
 * 批量检验（阻力 / 支撑分别按各自方向判）
 * @returns {{resistances:Array, supports:Array, summary:Object}}
 */
function assessZones(bars, shortTerm) {
  const st = shortTerm || {};
  const mapList = (arr, side) => (Array.isArray(arr) ? arr : []).map(z => {
    const r = assessZone(bars, z, side);
    return Object.assign({}, z, { valid: r.valid, invalidReasons: r.invalidReasons, zoneCheck: r.zoneCheck });
  });
  const resistances = mapList(st.resistances, 'resistance');
  const supports = mapList(st.supports, 'support');
  const all = resistances.concat(supports);
  return {
    resistances,
    supports,
    summary: {
      total: all.length,
      valid: all.filter(z => z.valid).length,
      invalid: all.filter(z => !z.valid).length,
      lookbackDays: LOOKBACK_DAYS,
      breakVolMin: BREAK_VOL_MIN,
    },
  };
}

/**
 * 单区间侵蚀（20261020m，用户口径）
 * ==========================================================
 * 用户原话：「只要收盘价在无放量的情况下侵入阻力或者支撑区间，但无法完整突破整个区间，
 *   则把区间范围缩小，远端值不变，但近端的值改为突破近端值的那一次收盘价。」
 *   例：阻力 34.53~34.87，之后某日无放量收在 34.7 → 调整为 34.7~34.87；
 *       支撑 32.25~32.57，之后某日无放量收在 32.5 → 调整为 32.25~32.5。
 *
 * 三个必要条件（缺一不侵蚀）：
 *   1) **侵入区间内部**：`low < close < high`。只到近端或越过远端都不算——
 *      越到远端之外属「突破」，交给 assessZone 的标准1 判有效性，不在这里改几何。
 *   2) **无放量**：该日量比 ≤ BREAK_VOL_MIN(1.2)，量比 = 当日量 ÷ 前 5 日均量（与标准1 同一公式）。
 *      量能缺失 → 不侵蚀（无法确认"无放量"就不动区间，绝不臆造）。
 *   3) **没有完整突破**：即条件 1 的 `close < high`（阻力）/ `close > low`（支撑）。
 *
 * **单调侵蚀**：区间内所有合规侵入日里，阻力取**最高**收盘、支撑取**最低**收盘作为新近端。
 * 取极值而非"最后一次"，是因为价格到过的位置就已经被消耗过——若取最后一次，价格回落会让
 * 区间又"长回去"，那就不是侵蚀了。
 *
 * **远端恒不变**：阻力的 high、支撑的 low 永远保持原值。
 *
 * @returns {{low:number, high:number, eroded:boolean, erosion:object|null}}
 */
function erodeZone(bars, zone, side) {
  const lo = _num(zone && zone.low);
  const hi = _num(zone && zone.high);
  const base = { low: zone ? zone.low : null, high: zone ? zone.high : null, eroded: false, erosion: null };
  if (lo == null || hi == null || !(hi > lo)) return base;   // 单点/脏数据：无可侵蚀空间

  const list = Array.isArray(bars) ? bars : [];
  const n = list.length;
  const start = Math.max(0, n - LOOKBACK_DAYS);
  const isRes = side === 'resistance';
  const nearFrom = isRes ? lo : hi;   // 近端：阻力=下沿 low，支撑=上沿 high

  let best = null;
  for (let i = start; i < n; i++) {
    const c = _num(list[i] && list[i].close);
    if (c == null) continue;
    if (!(c > lo && c < hi)) continue;              // 必须落在区间内部（条件1、2、3 合并）
    const vr = volRatioAt(list, i);
    if (vr == null || vr > BREAK_VOL_MIN) continue; // 有放量 / 量能缺失 → 不侵蚀
    if (!best
      || (isRes && c > best.close)
      || (!isRes && c < best.close)) {
      best = { close: c, date: list[i].date || null, vr };
    }
  }
  if (!best) return base;

  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    low: isRes ? r2(best.close) : r2(lo),
    high: isRes ? r2(hi) : r2(best.close),
    eroded: true,
    erosion: {
      side,
      from: r2(nearFrom),
      to: r2(best.close),
      close: r2(best.close),
      date: best.date,
      vr: best.vr,
      volRatioMax: BREAK_VOL_MIN,
      rangeFrom: `${r2(lo)} ~ ${r2(hi)}`,
      rangeTo: isRes ? `${r2(best.close)} ~ ${r2(hi)}` : `${r2(lo)} ~ ${r2(best.close)}`,
    },
  };
}

/**
 * 批量侵蚀：**只处理通过有效性检验的区间**（valid !== false）。
 * 顺序铁律：先判有效性（决定展示与否）→ 再按侵蚀收缩几何（决定展示成多大）。
 * 侵蚀结果**绝不回灌** assessZone 的计数，否则「收缩后的近端」会让原先算到的往返次数消失，
 * 变成"越侵蚀越有效"的自我强化循环。
 * @returns {{resistances:Array, supports:Array, summary:Object}}
 */
function erodeZones(bars, checked) {
  const src = checked || {};
  const mapList = (arr, side) => (Array.isArray(arr) ? arr : []).map(z => {
    if (z && z.valid === false) return z;   // 无效区间不展示，无需收缩
    const r = erodeZone(bars, z, side);
    return Object.assign({}, z, { low: r.low, high: r.high, eroded: r.eroded, erosion: r.erosion });
  });
  const resistances = mapList(src.resistances, 'resistance');
  const supports = mapList(src.supports, 'support');
  const all = resistances.concat(supports).filter(z => z && z.valid !== false);
  return {
    resistances,
    supports,
    summary: {
      total: all.length,
      eroded: all.filter(z => z.eroded).length,
      breakVolMin: BREAK_VOL_MIN,
      lookbackDays: LOOKBACK_DAYS,
    },
  };
}

module.exports = {
  assessZone, assessZones, erodeZone, erodeZones, volRatioAt, finalizedBars,
  LOOKBACK_DAYS, VOL_AVG_DAYS, BREAK_VOL_MIN,
};
