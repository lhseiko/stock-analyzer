/**
 * zoneResonance.js — 共振合并 + 强度分级（20261022g，用户新规范第三部分）
 * ==========================================================
 * 输入：lib/zoneMethods.js 产出的候选区间（10 种方法 + 周线层）
 * 输出：合并后的「共振支撑带 / 共振阻力带」，每条带带强度、确认信号、失效位。
 *
 * 用户规范原文要点（逐条对应实现）：
 *   - 「当多个方法落在相近价格带时，合并为共振支撑带/阻力带」→ clusterSide()
 *   - 「重合方法越多、周期越大、触碰次数越多，强度越高」
 *   - 「强区域要求至少两个大周期方法重合，并有量能或收盘确认」→ grade()
 *   - 「中区域要求两个方法重合」；「弱区域为单一方法」
 *   - 「对每个区域给出：下限、上限、中心价、来源、强度、适用周期、确认信号」
 *   - 「必须给出每个关键区域的失效位或失效条件」→ invalidationLevel
 *   - 「放量收盘跌破支撑区下沿并留有缓冲，视为支撑失效」→ 缓冲 = ATR×0.3
 *   - 「价格回到支撑区缩量企稳…支撑有效性提高」→ 缩量触碰计入 confirmSignals（提升强度，但不改有效性判定）
 *
 * 【与 zoneValidity 的分工·务必分清】
 *   zoneValidity = 结构资格（这个位**本来**有没有阻碍作用；缩量穿过 = 没有 → 本次不展示，不落永久黑名单）
 *   zoneResonance = 强度评分（既已确认结构存在，它有多强；缩量企稳 = 有承接 → 加分）
 *   两者统计口径独立，不得互相回灌。
 *
 * 【兼容性硬约束】输出数组排序必须保持「阻力按 low 升序 / 支撑按 low 降序」——
 *   calcFalsification 取 [0] 作为「最近的反转边界」，zoneLevelsHint 取「就近支撑/阻力」，
 *   排序一变，④卡文案与量能规则4 的引用位就会跟着变。强度只作为字段供前端分组，不参与排序。
 *
 * 【三阶段流水线】（顺序不可调换）
 *   ① 几何：聚类 + 定带宽 + 裁到现价对应一侧
 *   ② 消解：排序后切开相邻重叠，保证清单里区域互不重叠
 *   ③ 统计：触碰次数、60分钟确认、强度评分、失效位 —— 必须在几何定稿之后算，
 *      否则「先算触碰、后改带宽」会让统计口径与展示区域对不上。
 */
const { volRatioAt } = require('./zoneValidity');

const MERGE_ATR_RATIO = 1.05;     // 簇首判定：中心距 ≤ ATR×1.05 视为同一价格带
const BAND_MIN_ATR = 0.7;         // 单带最小宽度（ATR 倍数）：保证是「区域」而非「一条线」
const BAND_MAX_ATR = 1.0;         // 单带最大宽度（ATR 倍数）：防单一宽来源撑爆整条带
const MIN_KEEP_ATR = 0.3;         // 侵蚀后的最小保留宽度（20261022g 用户决策：不得压成单点）
const INVALID_BUFFER_ATR = 0.3;   // 失效缓冲：越过带沿 ATR×0.3 才算有效突破
const TOUCH_LOOKBACK = 60;        // 触碰统计窗口
const MAX_PER_SIDE = 6;           // 每侧最多输出条数

const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

/**
 * 统计某条带在近 N 日被触碰的情况（只用于强度，不做有效性判定）。
 * 触碰定义：当日收盘价落在 [low, high] 内（支撑/阻力同口径——都是「价格来到这个区域」）。
 * 放量触碰：触碰日量比 > 1.2（与 zoneValidity.BREAK_VOL_MIN 同源）。
 * 缩量触碰：触碰日量比 ≤ 1.2（用户规范：「缩量企稳 → 有效性提高」）。
 */
function touchStats(daily, band, opts) {
  const list = Array.isArray(daily) ? daily : [];
  const lookback = Number.isFinite(opts && opts.lookback) ? opts.lookback : TOUCH_LOOKBACK;
  const lo = Number(band && band.low);
  const hi = Number(band && band.high);
  const out = { touches: 0, volTouches: 0, shrinkTouches: 0, lastTouchDate: null };
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return out;
  const start = Math.max(0, list.length - lookback);
  for (let i = start; i < list.length; i++) {
    const c = Number(list[i] && list[i].close);
    if (!Number.isFinite(c)) continue;
    if (c < lo || c > hi) continue;
    out.touches += 1;
    out.lastTouchDate = list[i].date || out.lastTouchDate;
    const vr = volRatioAt(list, i);
    if (vr != null) {
      if (vr > 1.2) out.volTouches += 1;
      else out.shrinkTouches += 1;
    }
  }
  return out;
}

/**
 * 单侧聚类：按**锚定簇首中心**方式合并（防链式漂移，与 analysis.clusterLevels 同思路）。
 * @param {Array} cands 同一 side 的候选
 * @param {number} atrV
 * @param {number} price
 */
function clusterSide(cands, atrV, price) {
  const list = (Array.isArray(cands) ? cands : [])
    .filter(z => z && Number.isFinite(z.low) && Number.isFinite(z.high) && z.high >= z.low)
    .slice()
    .sort((a, b) => (a.low + a.high) - (b.low + b.high));
  if (list.length === 0) return [];

  const anchorTol = (atrV || price * 0.01) * MERGE_ATR_RATIO;
  const clusters = [];
  for (const z of list) {
    const zc = (z.low + z.high) / 2;
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(zc - last.anchorCenter) <= anchorTol) {
      last.members.push(z);
      last.unionLow = Math.min(last.unionLow, z.low);
      last.unionHigh = Math.max(last.unionHigh, z.high);
      continue;
    }
    clusters.push({
      anchorCenter: zc,
      unionLow: z.low,
      unionHigh: z.high,
      members: [z],
    });
  }
  return clusters;
}

/**
 * 强度分级（用户规范第三部分）。
 *   强 = 大周期方法 ≥2 且（放量触碰 ≥1 或 缩量触碰 ≥2 或 60分钟确认）
 *   中 = 不同方法 ≥2
 *   弱 = 单一方法
 * @returns {{strength:'强'|'中'|'弱', score:number, reasons:string[]}}
 */
function grade(m) {
  const reasons = [];
  let score = 0;
  score += Math.min(m.methodCount, 4) * 10;
  score += Math.min(m.majorCount, 3) * 12;
  score += Math.min(m.touches, 4) * 4;
  if (m.volConfirmed) score += 8;
  if (m.shrinkConfirmed) score += 5;
  if (m.hourlyConfirmed) score += 6;

  const volOrClose = m.volConfirmed || m.shrinkConfirmed || m.hourlyConfirmed;
  let strength;
  if (m.majorCount >= 2 && volOrClose) {
    strength = '强';
    reasons.push(`大周期方法 ${m.majorCount} 个重合`);
    reasons.push(m.volConfirmed ? '有放量触碰确认' : m.shrinkConfirmed ? '有缩量触碰（承接/抛压确认）' : '60分钟级别确认');
  } else if (m.methodCount >= 2) {
    strength = '中';
    reasons.push(`方法 ${m.methodCount} 个重合`);
    if (m.majorCount >= 2 && !volOrClose) reasons.push('大周期方法够但暂无量能/收盘确认，故记「中」');
  } else {
    strength = '弱';
    reasons.push('单一方法');
  }
  return { strength, score, reasons };
}

/**
 * 60 分钟级别确认（用户规范「大周期定区域，小周期找确认」）。
 * 判定：最近 40 根 60 分钟K中，收盘价进入过该带，且没有一次收盘越过带沿+缓冲（穿破）。
 * @param {Array} h60 60分钟K（升序）
 * @param {object} band
 * @param {'resistance'|'support'} side
 * @param {number} atrV
 */
function hourlyConfirm(h60, band, side, atrV) {
  const list = Array.isArray(h60) ? h60 : [];
  if (list.length < 10 || !band) return { confirmed: false, note: '' };
  const lo = Number(band.low);
  const hi = Number(band.high);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { confirmed: false, note: '' };
  const buf = (atrV || 0) * INVALID_BUFFER_ATR;
  const start = Math.max(0, list.length - 40);
  let entered = 0;
  let brokeOut = 0;
  for (let i = start; i < list.length; i++) {
    const c = Number(list[i] && list[i].close);
    if (!Number.isFinite(c)) continue;
    if (c >= lo && c <= hi) entered += 1;
    if (side === 'support' && c < lo - buf) brokeOut += 1;
    if (side === 'resistance' && c > hi + buf) brokeOut += 1;
  }
  if (entered > 0 && brokeOut === 0) {
    return { confirmed: true, note: `60分钟级别 ${entered} 次进入该带且未收盘穿破，小周期确认有效` };
  }
  return { confirmed: false, note: entered > 0 ? `60分钟级别进入 ${entered} 次、收盘穿破 ${brokeOut} 次` : '' };
}

/**
 * 主入口：候选 → 共振带。
 * @param {Array}  candidates zoneMethods.buildCandidates 的结果
 * @param {object} opts { daily, h60, atr, price, maxPerSide }
 * @returns {{resistanceBands:Array, supportBands:Array, atr:number, price:number, stats:object}}
 */
function mergeResonance(candidates, opts) {
  const o = opts || {};
  const daily = Array.isArray(o.daily) ? o.daily : [];
  const h60 = Array.isArray(o.h60) ? o.h60 : [];
  const price = Number(o.price);
  const atrV = Number(o.atr) || null;
  const all = Array.isArray(candidates) ? candidates : [];
  const base = atrV || (Number.isFinite(price) ? price * 0.01 : 0.01);

  const stat = { input: all.length, droppedWeakOnly: 0, droppedWrongSide: 0, merged: 0, overlapCut: 0 };

  const buildOneSide = (side) => {
    const raw = all.filter(z => z && z.side === side);
    const clusters = clusterSide(raw, base, price);

    // ─────────── 阶段 1：几何（只定位，不做统计）───────────
    const drafts = [];
    for (const cl of clusters) {
      const members = cl.members;
      // 整数关口等「必须与其他方法重合才用」的来源：单独成簇则丢弃（用户规范明确要求）
      const nonWeak = members.filter(m => !m.weakOnly);
      if (nonWeak.length === 0) { stat.droppedWeakOnly += 1; continue; }
      const majorMembers = members.filter(m => m.tier === 'major');

      // center = 各来源中心的中位数（抗极值）；带宽钳在 [0.7, 1.0]×ATR。
      // 为什么不用「参与者区间的并集」当带宽：单个宽来源（筹码峰、均线粘合带）会把整条带撑到
      // 跨越上方一大片（实测 603288 曾出现 33.50~35.35 即 ATR 的 2.6 倍，并与下一条重叠）。
      const centers = members
        .map(m => (Number(m.low) + Number(m.high)) / 2)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const center = centers.length ? centers[Math.floor(centers.length / 2)] : (cl.unionLow + cl.unionHigh) / 2;
      const unionW = cl.unionHigh - cl.unionLow;
      const bw = Math.min(Math.max(unionW, base * BAND_MIN_ATR), base * BAND_MAX_ATR);
      let low = center - bw / 2;
      let high = center + bw / 2;

      // 裁剪到现价的对应一侧（避免阻力带跨到现价下方、支撑带跨到现价上方）
      if (Number.isFinite(price)) {
        if (side === 'resistance' && low <= price) low = price * 1.001;
        if (side === 'support' && high >= price) high = price * 0.999;
        if (!(high >= low)) { stat.droppedWrongSide += 1; continue; }
      }
      drafts.push({
        members, nonWeak, majorMembers,
        center: r2(center), low: r2(low), high: r2(high),
      });
    }

    // ─────────── 阶段 2：排序 + 重叠消解 ───────────
    // 保持「阻力按 low 升序 / 支撑按 low 降序」（下游 ④卡反转边界、量能规则4 取就近位依赖此序）。
    // 消解方式：以两带中心的中点为界切开重叠区 → 清单里的区域绝不互相重叠。
    // ⚠ 两种 side 的数组方向相反，切口作用在**哪一端**也必须相反，否则会出现 low>high 的畸形带：
    //     阻力（升序）：a 在下、b 在上，重叠区在 a.high ~ b.low → 收 a.high、抬 b.low
    //     支撑（降序）：a 在上、b 在下，重叠区在 b.high ~ a.low → 抬 a.low、收 b.high
    drafts.sort((a, b) => (side === 'resistance' ? a.low - b.low : b.low - a.low));
    for (let i = 0; i < drafts.length - 1; i++) {
      const a = drafts[i];
      const b = drafts[i + 1];
      if (side === 'resistance') {
        if (!(a.high > b.low)) continue;
        const cut = r2((a.center + b.center) / 2);
        a.high = r2(Math.max(a.low, Math.min(a.high, cut)));
        b.low = r2(Math.min(b.high, Math.max(b.low, cut)));
        a.center = r2((a.low + a.high) / 2);
        b.center = r2((b.low + b.high) / 2);
      } else {
        if (!(b.high > a.low)) continue;
        const cut = r2((a.center + b.center) / 2);
        a.low = r2(Math.min(a.high, Math.max(a.low, cut)));
        b.high = r2(Math.max(b.low, Math.min(b.high, cut)));
        a.center = r2((a.low + a.high) / 2);
        b.center = r2((b.low + b.high) / 2);
      }
      stat.overlapCut += 1;
    }
    // 消解后自检：任何一条带必须满足 low <= high（防御性，正常路径不会触发）
    for (let i = drafts.length - 1; i >= 0; i--) {
      const d = drafts[i];
      if (!(d.high >= d.low) || !(d.high > 0)) {
        drafts.splice(i, 1);
        stat.droppedWrongSide += 1;
      }
    }

    // ─────────── 阶段 3：统计 + 评分 + 输出（几何定稿后才算）───────────
    const bands = [];
    for (const d of drafts) {
      const { members, nonWeak, majorMembers } = d;
      const band = { low: d.low, high: d.high, center: d.center };
      const ts = touchStats(daily, band, {});
      const hc = hourlyConfirm(h60, band, side, base);
      const methodCount = new Set(nonWeak.map(m => m.method)).size;
      const majorCount = new Set(majorMembers.filter(m => !m.weakOnly).map(m => m.method)).size;
      const g = grade({
        methodCount,
        majorCount,
        touches: ts.touches,
        volConfirmed: ts.volTouches > 0,
        shrinkConfirmed: ts.shrinkTouches >= 2,
        hourlyConfirmed: hc.confirmed,
      });
      if (members.length > 1) stat.merged += 1;

      // 来源名：大周期优先，最多列 3 个，其余折叠为「等 N 项」
      const ordered = members.slice().sort((a, b) => (b.tier === 'major' ? 1 : 0) - (a.tier === 'major' ? 1 : 0));
      const names = [];
      for (const mem of ordered) {
        const nm = mem.source || mem.method;
        if (!names.includes(nm)) names.push(nm);
      }
      const sourceText = names.length <= 3 ? names.join(' + ') : `${names.slice(0, 3).join(' + ')} 等 ${names.length} 项`;

      const confirmSignals = [];
      if (ts.volTouches > 0) confirmSignals.push(`近${TOUCH_LOOKBACK}日有 ${ts.volTouches} 次放量触碰`);
      if (ts.shrinkTouches >= 2) confirmSignals.push(`近${TOUCH_LOOKBACK}日有 ${ts.shrinkTouches} 次缩量触碰（${side === 'support' ? '缩量企稳，承接确认' : '缩量滞涨，抛压确认'}）`);
      if (ts.touches === 0) confirmSignals.push(`近${TOUCH_LOOKBACK}日尚未被触碰，属未被测试的位置`);
      if (hc.note) confirmSignals.push(hc.note);
      for (const r of g.reasons) if (!confirmSignals.includes(r)) confirmSignals.push(r);

      // 失效位：支撑破下沿减缓冲；阻力破上沿加缓冲（用户规范「留有缓冲」）
      const buf = base * INVALID_BUFFER_ATR;
      const invalidationLevel = side === 'support' ? r2(band.low - buf) : r2(band.high + buf);
      const invalidationText = side === 'support'
        ? `放量收盘跌破 ${invalidationLevel}（下沿 ${band.low} 再减 ${r2(buf)} 缓冲）→ 支撑失效，可能转为阻力`
        : `放量收盘站上 ${invalidationLevel}（上沿 ${band.high} 再加 ${r2(buf)} 缓冲）→ 阻力失效，可能转为支撑`;

      bands.push({
        low: band.low,
        high: band.high,
        center: band.center,
        side,
        source: sourceText,
        sources: members.map(mem => ({
          method: mem.method, source: mem.source, tier: mem.tier,
          low: mem.low, high: mem.high, weakOnly: !!mem.weakOnly, note: mem.note || '',
        })),
        strength: g.strength,
        strengthScore: g.score,
        strengthReasons: g.reasons,
        methodCount,
        majorCount,
        touches: ts.touches,
        lastTouchDate: ts.lastTouchDate,
        volConfirmed: ts.volTouches > 0,
        shrinkConfirmed: ts.shrinkTouches >= 2,
        hourlyConfirmed: hc.confirmed,
        confirmSignals,
        invalidationLevel,
        invalidationText,
        validityHint: `以当日收盘价判定：${invalidationText.split('→')[0].trim()}`,
        note: ordered.filter(x => x.note).slice(0, 2).map(x => x.note).join('；'),
      });
    }

    const cap = Number.isFinite(o.maxPerSide) ? o.maxPerSide : MAX_PER_SIDE;
    return bands.slice(0, cap);
  };

  const resistanceBands = buildOneSide('resistance');
  const supportBands = buildOneSide('support');
  return {
    resistanceBands,
    supportBands,
    atr: r2(base),
    price: r2(price),
    stats: stat,
  };
}

module.exports = {
  MERGE_ATR_RATIO,
  BAND_MIN_ATR,
  BAND_MAX_ATR,
  MIN_KEEP_ATR,
  INVALID_BUFFER_ATR,
  TOUCH_LOOKBACK,
  MAX_PER_SIDE,
  touchStats,
  clusterSide,
  grade,
  hourlyConfirm,
  mergeResonance,
};
