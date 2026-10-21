/**
 * 单箱体模型（20261020j 彻底重写，取代 20261020f/g/h 的「固定多窗口」版本）
 * ==========================================================================
 * 用户 2026-10-20 第四轮口径（原话拆解）：
 *   1）「自最新日股价开始回溯20个交易日起，无固定时间长度」
 *      → 种子 = 最近 SEED_DAYS(20) 个交易日（含最新日）；长度不预设上限，向前（历史方向）延长。
 *   2）「只要连续时间段内的股价上下振幅距离中轴不超过10%就可判定并纳入箱体」
 *      → 判定用「中轴 ±tol」的带，不是「收盘 min/max 包络」。段内每个收盘都必须落在带内。
 *   3）「振幅可以随着时间段的延长而放宽」
 *      → tol 随天数增长：tol(len) = min(10% × √(len/20), 15%)
 *        取 √ 的依据：价格随机游走的位移幅度 ∝ √t，箱体越久、正常摆动自然越宽；
 *        上限 15% 是防呆（否则久箱体的带宽会宽到没有意义 —— 用户上次已批评「500日35%只能算宽幅箱体」）。
 *   4）「其他判定逻辑按照原模型」
 *      → 保留：收盘定界（close == 边界视为区间内）、越界段/假突破计数定义、只陈述价格事实。
 *   5）「只要最新的股票收盘价连续三日突破箱体，无论是否放量，即判定箱体失效，直到下一个箱体的形成」
 *      → 失效判据与成交量完全无关（严禁复用 zoneValidity 的放量/反转次数口径）；
 *        失效后状态清空，重新积累 SEED_DAYS 日才可能形成下一个箱体。
 *
 * 与「阻力/支撑区间有效性检验」（lib/zoneValidity.js）的关系：
 *   **完全独立**。zoneValidity 是阻力/支撑的另一套口径（放量 + 反转次数），本文件不 require 它、
 *   不复用其常量、不把箱体边界并进阻力/支撑列表。两者唯一共用的只有「收盘价」这一原始数据。
 *
 * 状态机（逐日推进，t 为「某天」的下标）：
 *   无活动箱体 → 尝试用 [t-19, t] 形成：中轴 = 段内收盘中位数，tol = tol(20)，段内收盘全在带内则成立
 *   有活动箱体 → 用当日 tol(当前长度) 求带，收盘在带内则延长（并更新容差）；
 *                在带外则连续在外天数 +1，累计满 3 天即失效（清空状态）
 */
const SEED_DAYS = 20;          // 形成箱体的最小交易日数（用户：自最新日回溯 20 日起）
const TOL_BASE_PCT = 10;       // 20 日基准容差：距中轴 ±10%
const TOL_CAP_PCT = 15;        // 容差上限（随长度放宽，但不无限放宽）
const OUT_BREAK_DAYS = 3;      // 连续在带外天数达到该值 → 箱体失效（用户：连续三日突破）
const MAX_BARS = 1000;         // 单次扫描最多回看的日K根数（性能保护，非箱体长度上限）

const _r = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? Number(v.toFixed(d)) : null);
const _num = (v) => {
  // 注意：Number(null) === 0 —— 必须挡掉空值，否则缺字段会被当成价格为 0
  if (v == null || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function median(arr) {
  const a = arr.slice().sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** 容差（%）：20 日 ±10%，按 √(天数/20) 放宽，上限 ±15% */
function tolPctFor(days) {
  const len = Math.max(SEED_DAYS, Number(days) || SEED_DAYS);
  return _r(Math.min(TOL_BASE_PCT * Math.sqrt(len / SEED_DAYS), TOL_CAP_PCT), 2);
}

/** 由中轴与容差求上下边界 */
function bandOf(mid, tolPct) {
  const t = tolPct / 100;
  return { L: _r(mid * (1 - t)), U: _r(mid * (1 + t)) };
}

/**
 * 箱体上下限 → ②卡「上方关键阻力区间 / 下方关键支撑区间」条目（20261020k，用户要求合并展示）
 *
 * **用哪一个上下限（关键取舍）**：
 *   用「实际收盘区间」envU/envL（如 600909 的 8.54 / 7.03），**不是**中轴±容差的失效线（9.35 / 6.91）。
 *   理由：失效线是纯判定阈值，通常离现价很远、且从未被价格触碰过，摆在「阻力/支撑」清单里没有交易含义；
 *   用户核对形态用的也是实际高低点（「最高 8.54，最低今日 7.03」）。失效线仍留在箱体行与 tooltip 里。
 *
 * **不参与 zoneValidity 过滤**：返回条目带 `isBox:true`，前端必须原样展示、不交给阻力/支撑有效性检验；
 * 箱体是否失效只由本文件「连续 3 日突破」判定（用户第六条：两套检验必须独立）。
 *
 * @param {object} sr detectSingleRange 结果
 * @returns {{upper:object|null, lower:object|null, label:string}|null}
 */
function boxEdges(sr) {
  if (!sr || sr.state !== 'active' || !sr.box) return null;
  const b = sr.box;
  const lastC = _num(sr.lastClose);
  const dur = `（${b.days} 日）`;
  // 已被突破的一侧不再当作阻力/支撑（现价已在其外侧），避免把「刚破的上沿」挂在阻力里误导
  const upper = (lastC == null || lastC <= b.envU + 1e-9)
    ? {
      price: b.envU,
      source: `箱体上沿${dur}`,
      isBox: true,
      kind: 'box-upper',
      note: `箱体 ${b.startDate} 起 ${b.days} 个交易日内的收盘最高；越过失效线 ${b.bandU}（中轴 ${b.mid}×(${1 + b.tolPct / 100})）连续 3 日才判箱体失效`,
    }
    : null;
  const lower = (lastC == null || lastC >= b.envL - 1e-9)
    ? {
      price: b.envL,
      source: `箱体下沿${dur}`,
      isBox: true,
      kind: 'box-lower',
      note: `箱体 ${b.startDate} 起 ${b.days} 个交易日内的收盘最低；跌破失效线 ${b.bandL}（中轴 ${b.mid}×(${1 - b.tolPct / 100})）连续 3 日才判箱体失效`,
    }
    : null;
  return { upper, lower, label: `箱体 ${b.startDate} 起 ${b.days} 个交易日` };
}


function cleanBars(bars) {
  return (Array.isArray(bars) ? bars : [])
    .filter(b => b && _num(b.close) != null && _num(b.close) > 0)
    .slice(-MAX_BARS);
}

/**
 * 单箱体检测
 * @param {Array} bars 日K（升序：date/high/low/close/volume）
 * @param {Object} opts { seedDays }
 */
function detectSingleRange(bars, opts = {}) {
  const list = cleanBars(bars);
  const n = list.length;
  const seedDays = opts.seedDays || SEED_DAYS;

  if (n < seedDays) {
    return {
      ok: false,
      state: 'insufficient',
      error: `日K不足 ${seedDays} 根（现有 ${n} 根），无法回溯 ${seedDays} 个交易日形成箱体`,
      need: seedDays,
      barsUsed: n,
      seedDays,
      date: n ? list[n - 1].date : null,
    };
  }

  let active = null;        // 活动箱体
  let lastClosed = null;    // 最近一个失效的箱体
  let pendingSince = null;  // 失效后的起点下标（用于计算「新箱体还差几天」）
  let lastSeedFail = null;  // 最近一次「种子不合格」的原因（用于 noBox 结论）

  for (let t = seedDays - 1; t < n; t++) {
    if (!active) {
      // --- 尝试形成 ---
      const startIdx = t - seedDays + 1;
      const closes = list.slice(startIdx, t + 1).map(b => _num(b.close));
      const mid = median(closes);
      const tol = tolPctFor(seedDays);
      const maxDev = Math.max(...closes.map(c => Math.abs(c - mid) / mid));
      if (maxDev <= tol / 100 + 1e-9) {
        active = {
          startIdx,
          startDate: list[startIdx].date,
          endIdx: t,
          endDate: list[t].date,
          days: seedDays,
          mid,
          tolPct: tol,
          bandL: bandOf(mid, tol).L,
          bandU: bandOf(mid, tol).U,
          outStreak: 0,
          maxOutStreak: 0,
          outSegments: 0,        // 在带外的段数
          fakeBreaks: 0,         // 在带外但未满 3 日即收回的段数
          intraOutDays: 0,       // 盘中（high/low）出带的天数（仅披露）
        };
      } else {
        lastSeedFail = { date: list[t].date, maxDevPct: _r(maxDev * 100), tolPct: tol };
      }
      continue;
    }

    // --- 已有箱体：当日判定 ---
    const days = t - active.startIdx + 1;
    const tol = tolPctFor(days);
    const { L, U } = bandOf(active.mid, tol);
    const c = _num(list[t].close);
    const hi = _num(list[t].high);
    const lo = _num(list[t].low);
    if ((hi != null && hi > U) || (lo != null && lo < L)) active.intraOutDays += 1;

    if (c >= L && c <= U) {
      if (active.outStreak > 0) { active.fakeBreaks += 1; active.outStreak = 0; }  // 未满 3 日收回 → 假突破
      active.endIdx = t;
      active.endDate = list[t].date;
      active.days = days;
      active.tolPct = tol;
      active.bandL = L;
      active.bandU = U;
    } else {
      if (active.outStreak === 0) active.outSegments += 1;
      active.outStreak += 1;
      active.maxOutStreak = Math.max(active.maxOutStreak, active.outStreak);
      if (active.outStreak >= OUT_BREAK_DAYS) {
        const lastInIdx = t - active.outStreak;      // 最后一个仍在带内的交易日
        lastClosed = {
          startDate: active.startDate,
          endDate: list[Math.max(0, lastInIdx)].date,
          days: active.days,
          mid: _r(active.mid),
          tolPct: active.tolPct,
          bandL: active.bandL,
          bandU: active.bandU,
          fakeBreaks: active.fakeBreaks,
          intraOutDays: active.intraOutDays,
          invalidDate: list[t].date,
          invalidDir: c > U ? '向上' : '向下',
          invalidClose: _r(c),
          invalidStreak: active.outStreak,
          invalidLevel: c > U ? active.bandU : active.bandL,
        };
        active = null;
        pendingSince = t;   // 基准 = 失效当日（「已过 N 日」指失效之后经过的交易日数）
      }
    }
    if (!active && pendingSince == null) pendingSince = t;
  }

  const lastDate = list[n - 1].date;
  const lastClose = _r(_num(list[n - 1].close));

  if (!active) {
    // elapsed = 失效日之后的交易日数（失效当日记 0）
    const elapsed = pendingSince == null ? 0 : Math.max(0, (n - 1) - pendingSince);
    const remaining = Math.max(0, seedDays - elapsed);
    const parts = [];
    if (lastClosed) {
      parts.push(`上一个箱体（${lastClosed.startDate} 起 ${lastClosed.days} 个交易日，中轴 ${lastClosed.mid}）已于 ${lastClosed.invalidDate} 失效：连续 ${lastClosed.invalidStreak} 日收盘${lastClosed.invalidDir}突破 ${lastClosed.invalidLevel}`);
    } else {
      parts.push(`近 ${n} 个交易日内未形成过箱体${lastSeedFail ? `：最近一次 20 日种子（截至 ${lastSeedFail.date}）距中轴最大偏离 ${lastSeedFail.maxDevPct}% > 允许 ${lastSeedFail.tolPct}%` : ''}`);
    }
    parts.push(remaining > 0
      ? `新箱体需在失效后重新积累 ${seedDays} 个交易日（已过 ${elapsed} 日，还差 ${remaining} 日）`
      : `已满足 ${seedDays} 日种子长度，但区间振幅仍未收窄到容差内`);
    return {
      ok: true,
      state: 'noBox',
      date: lastDate,
      barsUsed: n,
      seedDays,
      lastClose,
      lastInvalid: lastClosed,
      nextFormation: { seedDays, elapsed, remaining },
      conclusion: parts.join('；'),
    };
  }

  // --- 活动箱体：包络（展示用）+ 盘中统计 ---
  const seg = list.slice(active.startIdx, active.endIdx + 1);
  const envL = _r(Math.min(...seg.map(b => _num(b.close))));
  const envU = _r(Math.max(...seg.map(b => _num(b.close))));
  const tolNow = tolPctFor(active.days);
  const bandNow = bandOf(active.mid, tolNow);
  // 20261020l：**倒计时只在真的越界时才存在**。收盘还在箱体内（或在带内）时，
  // 失效条件根本没被触发，`remainDays` 必须为 null——否则前端会渲染成「距失效还需 3 日」，
  // 让人误以为模型在倒数、三日后自动失效（用户实测报障：股价在箱体里震荡却显示还剩 3 日）。
  const remainToInvalid = active.outStreak > 0 ? Math.max(0, OUT_BREAK_DAYS - active.outStreak) : null;

  const ret = {
    ok: true,
    state: 'active',
    date: lastDate,
    barsUsed: n,
    seedDays,
    lastClose,
    box: {
      startDate: active.startDate,
      endDate: active.endDate,
      days: active.days,
      mid: _r(active.mid),
      tolPct: tolNow,
      bandL: bandNow.L,
      bandU: bandNow.U,
      envL,
      envU,
      ampEnvPct: _r((envU - envL) / active.mid * 100),                       // 实际包络宽度 ÷ 中轴（披露）
      halfDevPct: _r(Math.max(Math.abs(envU - active.mid), Math.abs(active.mid - envL)) / active.mid * 100),
      fakeBreaks: active.fakeBreaks,
      outSegments: active.outSegments,
      maxOutStreak: active.maxOutStreak,
      intraOutDays: active.intraOutDays,
    },
    invalidation: {
      rule: `最新收盘连续 ${OUT_BREAK_DAYS} 日突破箱体边界即失效（与是否放量无关）`,
      needDays: OUT_BREAK_DAYS,
      currentStreak: active.outStreak,
      remainDays: remainToInvalid,
      upLevel: bandNow.U,
      downLevel: bandNow.L,
      note: active.outStreak > 0
        ? `当前已连续 ${active.outStreak} 日在箱体边界外，再有 ${remainToInvalid} 日即失效`
        : '当前收盘在箱体内，未触发失效',
    },
    tolerance: {
      basePct: TOL_BASE_PCT,
      capPct: TOL_CAP_PCT,
      basis: `20 日基准 ±${TOL_BASE_PCT}%，按 √(天数/20) 放宽、上限 ±${TOL_CAP_PCT}%（当前 ${active.days} 日 → ±${tolNow}%）`,
    },
    conclusion: `箱体自 ${active.startDate} 起延续 ${active.days} 个交易日（中轴 ${_r(active.mid)}，收盘包络 ${envL} ~ ${envU}，容差 ±${tolNow}%）；${active.outStreak > 0 ? `当前已连续 ${active.outStreak} 日在边界外，再有 ${remainToInvalid} 日即失效` : '当前收盘在箱体内，箱体有效'}`,
  };
  // 上下限并入②卡阻力/支撑清单（20261020k）；单独挂字段，前端不得交给 zoneValidity 过滤
  ret.edges = boxEdges(ret);
  return ret;
}

module.exports = {
  detectSingleRange,
  boxEdges,
  tolPctFor,
  bandOf,
  median,
  SEED_DAYS,
  TOL_BASE_PCT,
  TOL_CAP_PCT,
  OUT_BREAK_DAYS,
};
