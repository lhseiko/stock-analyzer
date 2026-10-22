/**
 * 由「短期动向预判」区间 → 量能引擎关键支撑/阻力（20261022d）
 * ==========================================================
 * 目的：量能引擎「4. 放量破位」原先用 `_keyLevels` 自算一套支撑位（平台沿/阶段高低/MA20/MA60 取最近），
 * 与②卡「短期动向预判」的阻力/支撑区间是两套口径，可能给出不同价位。
 * 现在改为：优先引用②卡的有效区间（同一套 swing + 有效性检验 + 侵蚀 + 反转结果），
 * 引擎只在拿不到区间时才回退自算（`_keyLevels` 兜底）。
 *
 * 选取规则（纯函数，零网络）：
 *   - 支撑：只在「区间上沿 ≤ 现价 ×1.02」的**有效支撑**里，取上沿最高者（离现价最近，含刚被跌破的）。
 *   - 阻力：只在「区间下沿 ≥ 现价 ×0.98」的**有效阻力**里，取下沿最低者（离现价最近）。
 *   - 无有效区间 → 返回 null（调用方回退引擎自算，不臆造）。
 *
 * @param {object} shortTerm 价格行为快照的 shortTerm（含 resistances/supports，每条带 low/high/valid/source）
 * @param {number} price     现价（quote.price）
 * @returns {{support?:{low:number,high:number,kind:string}, resistance?:{low:number,high:number,kind:string}}|null}
 */
function _zones(arr) {
  return (Array.isArray(arr) ? arr : [])
    .filter(z => {
      if (!z || z.valid === false) return false;
      const lo = Number(z.low), hi = Number(z.high);
      return isFinite(lo) && isFinite(hi) && lo > 0 && hi >= lo;
    })
    .map(z => ({ low: Number(z.low), high: Number(z.high), source: String(z.source || '') }));
}

function deriveLevelHints(shortTerm, price) {
  const p = Number(price);
  if (!shortTerm || !isFinite(p) || p <= 0) return null;
  const sups = _zones(shortTerm.supports);
  const ress = _zones(shortTerm.resistances);

  const sup = sups.filter(z => z.high <= p * 1.02).sort((a, b) => b.high - a.high)[0] || null;
  const res = ress.filter(z => z.low >= p * 0.98).sort((a, b) => a.low - b.low)[0] || null;

  const mk = (z, side) => (z
    ? {
        low: z.low,
        high: z.high,
        kind: `${z.source || '短期动向'}·${side === 'support' ? '支撑区间' : '阻力区间'}`,
      }
    : null);

  const out = { support: mk(sup, 'support'), resistance: mk(res, 'resistance') };
  return (out.support || out.resistance) ? out : null;
}

module.exports = { deriveLevelHints };
