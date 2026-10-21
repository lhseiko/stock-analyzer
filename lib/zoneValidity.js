/**
 * 阻力 / 支撑区间口径（20261020i 建立 → 20261020l 修正「来回」口径 → 20261020m 增侵蚀）
 * ==========================================================
 * 本文件负责两件事，**顺序不可颠倒**：
 *   ① `assessZone/assessZones` —— **有效性检验**：这个位还值不值得展示（用户两条标准，见下）。
 *   ② `erodeZone/erodeZones`   —— **侵蚀收缩**：能展示的话，它还剩下多大（无放量侵入但未打穿 → 近端收紧）。
 * 先判有效性再收缩几何；侵蚀结果不回灌 ①，否则会形成「越侵蚀越有效」的自我强化。
 * 用户 2026-10-20 给定两条标准（原话）：
 *   1）「如果股价不需要放量就轻松突破，则判定无效。」
 *   2）「如果股价超过三天在上方阻力和下方支撑股价处来回突破，则判定无效。」
 *   → 无效价格区间无需展示。
 *
 * **两个「越界」口径必须分开（20261020l，用户报障后修正）**：
 *   - 「真突破」= 收盘越过区间**远端**（阻力 > high / 支撑 < low）→ 用于标准1、breakCount、streakNow；
 *   - 「触及」  = 收盘到达区间**近端**（阻力 ≥ low / 支撑 ≤ high）→ 用于标准2 的来回次数。
 *   只用"真突破"会漏掉最常见的情形：603288 现价 34.09、阻力区间 34.33~34.67，
 *   近 60 日价格在该位置反复进出 7 次却从未收在 34.67 之上 → 一次都不计 → 永远判"有效"。
 *   用户原话「股价在阻力和支撑区间来回缩量震荡，为什么没有触发检验」即指此。
 *
 * 落地口径（全部可核对，勿擅自放宽/收紧）：
 *
 * 【方向性】
 *   阻力只关心「向上穿越」；支撑只关心「向下穿越」。反方向穿越不计入突破——股价从上方掉下来
 *   穿过某个价位，对该价位作为「上方阻力」的身份不构成突破，不能拿它来判死。
 *   端点口径与箱体计数同源：close == high / low 视为区间内（触及时用 ≥ low / ≤ high，含端点）。
 *
 * 【标准1 · 无放量轻松突破】
 *   取最近一次「真突破」的交易日，量比 = 当日成交量 ÷ 前 5 日均量（不含当日）。
 *   量比 > 1.2 视为放量（与 volumeEngine `_volumeTier` 的「放量 >1.2」同源，不另立一套）。
 *   量比 ≤ 1.2 → 不需要放量就能穿过去 → 无效。
 *   量能缺失（前 5 日不足 / 成交量为 0）→ 本条不判定，也不臆造量比。
 *
 * 【标准2 · 超过三天在该位置来回突破】
 *   分两种失效形态，任一命中即无效（都是「这个位置没有实际阻挡/支撑力」）：
 *   a) 当前已「真突破」且连续 > 3 天 —— 已突破并且站住了，不能再叫「上方阻力 / 下方支撑」；
 *   b) 检验窗内「触及口径反转」次数 > 3 次 —— 价格在本位置反复进出（约 2 个完整来回）。
 *   注：不统计「在区间外待了多少天」。若把窗口内所有外侧天数直接累加，一只从 9 元跌到 7 元
 *   的股票，其上方的每一个价位都会因为「7 月那 40 天在上方」而被误杀（本轮实测已复现）。
 *
 * 【未被测试 ≠ 无效】窗内价格从未到达该位置（touchTransitions === 0）且当前也不在外侧 → 保留展示。
 *
 * 纯函数、零网络：入参为日K数组 + 区间列表，返回带 valid / invalidReasons / zoneCheck 的区间列表。
 */
const LOOKBACK_DAYS = 60;
const VOL_AVG_DAYS = 5;
const BREAK_VOL_MIN = 1.2;   // 放量阈值（与 volumeEngine._volumeTier 同源）
const OUT_STREAK_MAX = 3;    // 当前连续站在区间外侧的允许天数（用户「超过三天」→ >3 失效）
const CROSS_MAX = 3;         // 检验窗内「在本位置往返」次数上限（触及口径，>3 视为来回突破）

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
  // 两种「越界」口径，用途不同（20261020l，用户报障后修正）：
  //   beyondOf —— **真突破**：收盘越过区间**远端**（阻力=高于 high、支撑=低于 low）。
  //               用于标准1（穿越时有没有放量）与 breakCount / streakNow（突破后是否站住）。
  //   touchOf  —— **触及该位置**：收盘到达/越过区间**近端**（阻力= ≥ low、支撑= ≤ high），
  //               即价格已经进入或越过这个价位区。用于标准2「在本位置来回」的次数统计。
  // 为什么必须分开：603288（现价 34.09，阻力区间 34.33~34.67）近 60 日收盘在该位置反复进出 **7 次**，
  // 但从未收在 34.67 之上——若只用 beyondOf，这些"来回"一次都不计，区间永远判"有效"，
  // 正是用户报障「股价在阻力/支撑区间来回缩量震荡，为什么不触发检验」的根因。
  const beyondOf = (c) => (isRes ? c > hi : c < lo);
  const touchOf = (c) => (isRes ? c >= lo : c <= hi);

  let touchTransitions = 0;    // 触及口径的内外反转次数（在该位置来回的程度）
  let breakCount = 0;          // 从内→外 的次数（真正的"突破/跌破"次数，远端口径）
  let lastBreakIdx = -1;
  let prevTouch = null;
  let prevBeyond = null;
  for (let i = start; i < n; i++) {
    const c = _num(list[i] && list[i].close);
    if (c == null) continue;
    const touch = touchOf(c);
    const beyond = beyondOf(c);
    if (prevTouch !== null && touch !== prevTouch) touchTransitions += 1;
    if (prevBeyond === false && beyond === true) { breakCount += 1; lastBreakIdx = i; }
    prevTouch = touch;
    prevBeyond = beyond;
  }
  // 当前连续站在外侧的天数（从末根往前数）——用「真突破」口径，判「突破后是否站住」
  let streakNow = 0;
  for (let i = n - 1; i >= start; i--) {
    const c = _num(list[i] && list[i].close);
    if (c == null) continue;
    if (!beyondOf(c)) break;
    streakNow += 1;
  }

  const vr = lastBreakIdx >= 0 ? volRatioAt(list, lastBreakIdx) : null;
  const lastBreakDate = lastBreakIdx >= 0 ? (list[lastBreakIdx].date || null) : null;
  const dirTxt = isRes ? '向上突破' : '向下跌破';
  const reasons = [];

  if (streakNow > OUT_STREAK_MAX) {
    reasons.push(`当前已${isRes ? '站上' : '跌破'}区间 ${streakNow} 天（> ${OUT_STREAK_MAX} 天），该位已被${isRes ? '突破并站住' : '跌破未收回'}`);
  }
  if (touchTransitions > CROSS_MAX) {
    reasons.push(`近${Math.min(LOOKBACK_DAYS, n)}日价格在本位置反复往返 ${touchTransitions} 次（> ${CROSS_MAX} 次），该位置已被反复穿越`);
  }
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
      touchTransitions,
      streakNow,
      lastBreakDate,
      lastBreakVr: vr,
      breakVolMin: BREAK_VOL_MIN,
      outStreakMax: OUT_STREAK_MAX,
      crossMax: CROSS_MAX,
      volUnknown: lastBreakIdx >= 0 && vr == null,
    },
  };
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
      outStreakMax: OUT_STREAK_MAX,
      crossMax: CROSS_MAX,
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
 *      越到远端之外属「突破」，交给 assessZone 的标准1/标准2 判有效性，不在这里改几何。
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
  assessZone, assessZones, erodeZone, erodeZones, volRatioAt,
  LOOKBACK_DAYS, VOL_AVG_DAYS, BREAK_VOL_MIN, OUT_STREAK_MAX, CROSS_MAX,
};
