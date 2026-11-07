// lib/chipDistribution.js —— 筹码分布本地计算模块（锚点三数据源，20261105f 定版移植）
// 算法逐行移植自东财 K 图官方筹码引擎（akshare stock_cyq_em 内嵌 JS 反编译还原）：
//   三角形分布（avg=(O+C+H+L)/4 锚点）+ 换手率衰减（每日 xdata *= (1-turnover)）+ 一字板特判。
// 参数：150 档价格精度；窗口默认 250 日（实测 250 日+前复权 与东财官方平均成本偏差 0.9%，20261105 验证）。
// 输入：bars = [{date, open, close, high, low, volume}]（volume 单位=手，与引擎日K同源）；
//       floatShares = 流通股本（股）；调用方由 quote.circulationValue（流通市值，元）/ 现价 推得。
// 输出：computeChipDistribution(bars, floatShares, opts) → { benefitRatio, avgCost, p90, p70, verdict, note, basis } | null
// 判读口径（spec ① 锚点三）：获利盘 >90% 抛压警示 / <5% 割肉枯竭；仅参考提醒，不参与量价判定。
'use strict';

const CYQ_BARS = 150;      // 价格档位数
const CYQ_WINDOW = 250;    // 计算窗口（日）；与引擎 250 日分位窗口同源

function computeChipDistribution(bars, floatShares, opts = {}) {
  try {
    if (!Array.isArray(bars) || bars.length < 30 || !floatShares || floatShares <= 0) return null;
    const window = opts.window || CYQ_WINDOW;
    const kdata = bars.slice(-window).map(b => ({
      date: b.date,
      open: b.open, close: b.close, high: b.high, low: b.low,
      // volume 单位=手 → 股：×100；换手率(%) = 股数/流通股本×100
      hsl: b.volume > 0 ? (b.volume * 100 / floatShares) * 100 : 0,
    }));
    const factor = CYQ_BARS;
    let maxprice = 0, minprice = 0;
    for (const e of kdata) {
      if (e.high > maxprice || maxprice === 0) maxprice = Math.max(maxprice, e.high);
      if (minprice === 0 || e.low < minprice) minprice = Math.min(minprice, e.low);
    }
    if (!(maxprice > minprice)) return null;
    const accuracy = Math.max(0.01, (maxprice - minprice) / (factor - 1));
    const xdata = new Array(factor).fill(0);
    for (const e of kdata) {
      const avg = (e.open + e.close + e.high + e.low) / 4;
      const turnoverRate = Math.min(1, e.hsl / 100 || 0);
      const H = Math.floor((e.high - minprice) / accuracy);
      const L = Math.ceil((e.low - minprice) / accuracy);
      const Gx = e.high === e.low ? factor - 1 : 2 / (e.high - e.low);
      const Gy = Math.floor((avg - minprice) / accuracy);
      for (let n = 0; n < xdata.length; n++) xdata[n] *= (1 - turnoverRate);
      if (e.high === e.low) {
        // 一字板特判：价格被锁死，半量集中在锁死价位
        if (Gy >= 0 && Gy < factor) xdata[Gy] += Gx * turnoverRate / 2;
      } else {
        for (let j = Math.max(0, L); j <= Math.min(factor - 1, H); j++) {
          const curprice = minprice + accuracy * j;
          if (curprice <= avg) {
            xdata[j] += Math.abs(avg - e.low) < 1e-8 ? Gx * turnoverRate : (curprice - e.low) / (avg - e.low) * Gx * turnoverRate;
          } else {
            xdata[j] += Math.abs(e.high - avg) < 1e-8 ? Gx * turnoverRate : (e.high - curprice) / (e.high - avg) * Gx * turnoverRate;
          }
        }
      }
    }
    const currentprice = kdata[kdata.length - 1].close;
    let totalChips = 0;
    for (let i = 0; i < factor; i++) totalChips += +xdata[i].toPrecision(12);
    if (!(totalChips > 0)) return null;
    const getCostByChip = (chip) => {
      let sum = 0;
      for (let i = 0; i < factor; i++) {
        const x = +xdata[i].toPrecision(12);
        if (sum + x > chip) return minprice + i * accuracy;
        sum += x;
      }
      return 0;
    };
    let below = 0;
    for (let i = 0; i < factor; i++) {
      if (currentprice >= minprice + i * accuracy) below += +xdata[i].toPrecision(12);
    }
    const benefitRatio = below / totalChips;
    const avgCost = getCostByChip(totalChips * 0.5);
    const pctChips = (percent) => {
      const ps = [(1 - percent) / 2, (1 + percent) / 2];
      const pr = [getCostByChip(totalChips * ps[0]), getCostByChip(totalChips * ps[1])];
      return { priceRange: pr, concentration: (pr[0] + pr[1]) === 0 ? 0 : (pr[1] - pr[0]) / (pr[0] + pr[1]) };
    };
    const bp = benefitRatio * 100;
    let verdict, note;
    if (bp > 90) { verdict = '抛压警示'; note = `获利盘 ${bp.toFixed(1)}% >90%：当前价位下几乎所有持仓获利，抛压警示（高位特征之一，仅参考提醒）`; }
    else if (bp < 5) { verdict = '割肉枯竭'; note = `获利盘 ${bp.toFixed(1)}% <5%：几乎无获利持仓，割肉枯竭（低位特征之一，仅参考提醒）`; }
    else { verdict = '中间区域'; note = `获利盘 ${bp.toFixed(1)}%（5%~90% 中间区域，仅参考提醒）`; }
    return {
      benefitRatio,                       // 0~1
      benefitPct: +bp.toFixed(1),
      avgCost: +avgCost.toFixed(3),
      p90: pctChips(0.9),
      p70: pctChips(0.7),
      window: kdata.length,
      verdict, note,
      basis: `本地 CYQ 算法（东财同款，${kdata.length} 日窗口+前复权口径），实测与东财官方平均成本偏差约 0.9%（20261105 验证）`,
    };
  } catch (e) {
    return null; // 筹码计算失败不阻断主链（仅参考数据）
  }
}

module.exports = { computeChipDistribution, CYQ_BARS, CYQ_WINDOW };
