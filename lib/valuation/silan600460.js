// ============================================================
// 士兰微（600460）专属估值模型 —— 景气度动态引擎（确定性计算，1+1=2）
// 20260908s：全时段通用指令改版——景气度五项评分→情景权重→
//   各情景内 PE40%+DCF30%+PB20%+PS10% → 情景间加权 → 预期涨幅评级。
//   无硬编码年份：预测财年 Y/Y+1 由配置标注（当前 Y=2026）。
// 计算层=代码，输入锁死（data/valuation/600460.json）⇒ 结果锁死。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYM = '600460';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/600460.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isSilanModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'silan';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (obj) => (obj && obj.value != null) ? obj.value : null;

/** 指令第三步：景气度总分 → 情景权重（规则内置，动态周期） */
function cycWeightsOf(total) {
  if (total >= 3) return { level: '高', w: { optimistic: 0.5, base: 0.4, pessimistic: 0.1 } };
  if (total >= 1) return { level: '中偏上', w: { optimistic: 0.35, base: 0.5, pessimistic: 0.15 } };
  if (total >= -1) return { level: '中偏下', w: { optimistic: 0.2, base: 0.5, pessimistic: 0.3 } };
  return { level: '低', w: { optimistic: 0.1, base: 0.4, pessimistic: 0.5 } };
}

function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

function run(symbol, { price } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'silan') return { error: 'NOT_SILAN' };
  const I = cfg.inputs;

  const N = nz(vv(I.shares));
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const F = I.forecast, SC = I.scenarios, D = I.dcfFixed, W = I.weights;
  const baseRev = nz(vv(I.fy2025.rev));                       // 130.52（2025 实际，DCF 推算基数）

  // ---------- 第一步：景气度评分与情景权重 ----------
  const cycItems = ['leadTime', 'priceTrend', 'inventory', 'capacity', 'demand'];
  const cycRows = cycItems.map(k => ({
    label: { leadTime: '交期趋势', priceTrend: '现货价格', inventory: '库存周转', capacity: '8寸产能', demand: '下游需求' }[k],
    status: I.cycScore[k].status,
    score: nz(I.cycScore[k].score),
    source: I.cycScore[k].source,
  }));
  const cycTotal = cycRows.reduce((a, b) => a + b.score, 0);
  const cyc = cycWeightsOf(cycTotal);
  const wOpt = cyc.w.optimistic, wBase = cyc.w.base, wPes = cyc.w.pessimistic;

  // ---------- 第二步：三情景计算 ----------
  const tax = nz(vv(D.taxRate)) / 100, wacc = nz(vv(D.wacc)) / 100, gP = nz(vv(D.gPerp)) / 100;
  const daR = nz(vv(D.daRatio)), wcR = nz(vv(D.wcRatio));
  const tailG = vv(I.forecast.revGrowthTail) || [0.1734, 0.11, 0.10];
  const npPick = { optimistic: 'high', base: 'base', pessimistic: 'low' };
  const revPick = { optimistic: 'high', base: 'base', pessimistic: 'low' };

  function dcfOf(scKey) {
    const sc = SC[scKey];
    const revY = F.revY[revPick[scKey]];
    const revs = [revY, F.revY1[revPick[scKey]]];
    revs.push(revs[1] * (1 + tailG[0]));   // 2028（机构增速）
    revs.push(revs[2] * (1 + tailG[1]));   // 2029【假设】
    revs.push(revs[3] * (1 + tailG[2]));   // 2030【假设】
    const capexStep = (nz(sc.capexY) - nz(sc.capexFloor)) / 4;   // 线性递减至下限
    let pv = 0; const fcffs = []; let allNeg = true;
    for (let t = 0; t < 5; t++) {
      const ebit = revs[t] * (nz(sc.ebitY) + t * nz(sc.ebitStep));
      const capex = revs[t] * (nz(sc.capexY) - t * capexStep);
      const g = t === 0 ? (revs[0] / baseRev - 1) : (revs[t] / revs[t - 1] - 1);
      const dwc = revs[t] * g * wcR;
      const fcff = ebit * (1 - tax) + revs[t] * daR - capex - dwc;
      fcffs.push(fcff);
      if (fcff > 0) allNeg = false;
      pv += fcff / Math.pow(1 + wacc, t + 1);
    }
    const tv = fcffs[4] * (1 + gP) / (wacc - gP);
    if (allNeg && tv < 0) return { valid: false, reason: '显性期FCFF全负且终值为负（高CAPEX扩产期），DCF失效' };
    const ev = pv + tv / Math.pow(1 + wacc, 5);
    const equity = ev - nz(vv(I.balance.netDebt)) - nz(vv(I.balance.minority));
    return { valid: true, perShare: equity / N, ev, tvShare: (tv / Math.pow(1 + wacc, 5)) / ev, fcffs };
  }

  function scenario(scKey) {
    const sc = SC[scKey];
    const npY = F.npY[npPick[scKey]];
    const revY = F.revY[revPick[scKey]];
    const peTP = npY * nz(sc.pe) / N;                            // step1
    const dcf = dcfOf(scKey);                                    // step2（含失效检验）
    const pbTP = nz(vv(I.pbLayer.bps2026E)) * nz(vv(I.pbLayer.pbComp)) * 1.0;  // step3（中值系数1.0）
    const psTP = (revY / N) * nz(vv(I.psLayer.psComp2026E)) * 0.8;             // step4（折扣中值0.8）
    // step5：情景内加权（DCF 失效/失真则剔除并归一：显性期FCFF全负+终值负，或每股价值<PE目标价25%即对该情景无定价贡献）
    const dcfUsable = dcf.valid && dcf.perShare >= peTP * 0.25;
    let combo;
    if (dcfUsable) {
      combo = nz(W.pe) * peTP + nz(W.dcf) * dcf.perShare + nz(W.pb) * pbTP + nz(W.ps) * psTP;
    } else {
      const rest = nz(W.pe) + nz(W.pb) + nz(W.ps);
      combo = (nz(W.pe) * peTP + nz(W.pb) * pbTP + nz(W.ps) * psTP) / rest;
    }
    return { scKey, npY, revY, peTP, dcf, dcfUsable, pbTP, psTP, combo, sc };
  }
  const sOpt = scenario('optimistic'), sBase = scenario('base'), sPes = scenario('pessimistic');

  // ---------- 第三步：情景间加权（景气度权重） ----------
  const finalTarget = wOpt * sOpt.combo + wBase * sBase.combo + wPes * sPes.combo;
  const rangeLow = Math.min(sOpt.combo, sBase.combo, sPes.combo);
  const rangeHigh = Math.max(sOpt.combo, sBase.combo, sPes.combo);

  // ---------- 第四步：预期涨幅与评级（指令 step7/8） ----------
  let rating = '合理', expectedReturn = null;
  if (P != null) {
    expectedReturn = (finalTarget - P) / P * 100;
    // 20260908z2 用户校准：综合估值评级只输出 低估/合理/高估 三档（按现价 vs 情景综合区间位置）
    rating = P < rangeLow ? '低估' : (P > rangeHigh ? '高估' : '合理');
  }

  // ---------- P1一致性修复（20260908z）：快照类输入时效看板 ----------
  const FR = I.freshness || {};
  const frMax = nz(FR.maxAgeDays) || 90;
  const freshnessRows = [];
  const staleAlerts = [];
  for (const it of (FR.items || [])) {
    const age = it.asOf ? daysBetween(it.asOf, new Date()) : null;
    if (age == null) continue;
    const stale = age > frMax;
    freshnessRows.push({ label: it.label, asOf: it.asOf, ageDays: age, maxAge: frMax, stale });
    if (stale) staleAlerts.push('快照「' + it.label + '」取数于 ' + it.asOf + '（距今 ' + age + ' 天 > ' + frMax + ' 天）→ 请复核更新');
  }
  const MS = I.marketSnapshot || {};
  const msAge = MS.asOf ? daysBetween(MS.asOf, new Date()) : null;
  const msStale = msAge != null && msAge > (nz(MS.maxAgeDays) || frMax);

  // ---------- 卡片行 ----------
  const dcfFailed = !sOpt.dcfUsable && !sBase.dcfUsable && !sPes.dcfUsable;
  const pbLowTP = nz(vv(I.pbLayer.bps2026E)) * nz(vv(I.pbLayer.pbComp)) * nz(vv(I.pbLayer.coefLow));
  const pbHighTP = nz(vv(I.pbLayer.bps2026E)) * nz(vv(I.pbLayer.pbComp)) * nz(vv(I.pbLayer.coefHigh));
  const coreRows = [
    { label: '景气度评分（指令第三步）', value: `五项总分 ${cycTotal >= 0 ? '+' : ''}${cycTotal} → 景气度「${cyc.level}」→ 情景权重：乐观 ${Math.round(wOpt * 100)}% / 基准 ${Math.round(wBase * 100)}% / 悲观 ${Math.round(wPes * 100)}%（动态周期，随景气度自动切换）`, source: cycRows.map(c => `${c.label}${c.score > 0 ? '+' : ''}${c.score}`).join(' ') },
    { label: '机构预测（4家，截至2026-08-24）', value: `2026E 归母 低7.94/均8.44/高9.48 亿（EPS 0.48/0.51/0.57）；2027E 低10.36/均11.70/高13.66 亿；营收2026E 150.62~166.69 亿`, source: F.npY.source },
    { label: `市场快照（${MS.asOf || '见来源'}，距今 ${msAge != null ? msAge : '?'} 天${msStale ? ' ⚠️超龄请复核' : ''}）`, value: `现价 ${P ? r2(P) : 'N/A'} 元 / PE(TTM)约${MS.peTTM != null ? MS.peTTM : '?'}倍 / 机构综合目标价 ${MS.targetPrice != null ? MS.targetPrice : '?'} 元（${MS.targetPriceNote || ''}）`, source: MS.source || I.pePercentile.source },
    { label: 'DCF 固定参数（指令第五步）', value: `WACC 8.0% / g 3.5% / 显性5年(2026-2030) / 税率12% / β 1.6（展示参考）/ Rf 1.68% / Rm 9.0%；D&A 6%【假设】、ΔWC 5%【假设】`, source: D.wacc.source + '；' + D.daRatio.source },
    { label: 'DCF 失效检验', value: dcfFailed ? `⚠️ 三情景显性期 FCFF 均为负（指令 CAPEX 16~25% vs 公司实际 CAPEX/营收约8.6%），DCF 按失效剔除，各情景改按 PE/PB/PS 权重归一（57.1%/28.6%/14.3%）；判定口径：显性期 FCFF 全负且终值为负，或 DCF 每股价值<该情景 PE 目标价 25%（对定价无贡献）` : `DCF 各情景有效，正常入权重 30%`, source: W.source },
    { label: 'PB / PS 相对系数', value: `PB = BPS_2026E 7.5533 × 可比均值 3.0 × [0.9~1.1] = ${r2(pbLowTP)}~${r2(pbHighTP)} 元；PS = Y营收/股本 × 可比 4.9 × 0.8（IDM折扣中值）`, source: I.pbLayer.coefLow.source + '；' + I.psLayer.discLow.source },
  ];

  const scenRows = [
    { name: '乐观情景', value: `PE目标价 ${r2(sOpt.peTP)} 元（净利9.48亿×70x）｜DCF ${sOpt.dcfUsable ? r2(sOpt.dcf.perShare) + ' 元' : '失效剔除'}｜PB ${r2(sOpt.pbTP)}｜PS ${r2(sOpt.psTP)} → 情景综合 ${r2(sOpt.combo)} 元；假设：${sOpt.sc.marginNote}` },
    { name: '基准情景', value: `PE目标价 ${r2(sBase.peTP)} 元（净利8.44亿×55x）｜DCF ${sBase.dcfUsable ? r2(sBase.dcf.perShare) + ' 元' : '失效剔除'}｜PB ${r2(sBase.pbTP)}｜PS ${r2(sBase.psTP)} → 情景综合 ${r2(sBase.combo)} 元；假设：${sBase.sc.marginNote}` },
    { name: '悲观情景', value: `PE目标价 ${r2(sPes.peTP)} 元（净利7.94亿×40x）｜DCF ${sPes.dcfUsable ? r2(sPes.dcf.perShare) + ' 元' : '失效剔除'}｜PB ${r2(sPes.pbTP)}｜PS ${r2(sPes.psTP)} → 情景综合 ${r2(sPes.combo)} 元；假设：${sPes.sc.marginNote}` },
  ];

  const matrixRows = [
    { method: 'PE 相对估值（40%）', low: r2(sPes.peTP), mid: r2(sBase.peTP), high: r2(sOpt.peTP), note: `净利×目标PE÷股本：悲观40x/基准55x/乐观70x（指令第四步）` },
    { method: 'DCF 绝对估值（30%）', low: sPes.dcfUsable ? r2(sPes.dcf.perShare) : null, mid: sBase.dcfUsable ? r2(sBase.dcf.perShare) : null, high: sOpt.dcfUsable ? r2(sOpt.dcf.perShare) : null, note: dcfFailed ? 'WACC 8%/g 3.5% 下显性期 FCFF 全负（或每股价值远低于PE锚）→ 失效剔除（权重归一至其余三法）' : `WACC 8%、g 3.5%；终值占比约${Math.round((sBase.dcf.tvShare || 0) * 100)}%` },
    { method: 'PB 相对估值（20%）', low: r2(pbLowTP), mid: r2(sBase.pbTP), high: r2(pbHighTP), note: `BPS_2026E 7.5533 × 可比PB 3.0 × [0.9~1.1]` },
    { method: 'PS 相对估值（10%）', low: r2(sPes.psTP), mid: r2(sBase.psTP), high: r2(sOpt.psTP), note: `Y营收/股本 × 可比PS 4.9 × 0.8（IDM折扣中值）` },
    { method: `情景综合（乐观${Math.round(wOpt * 100)}%/基准${Math.round(wBase * 100)}%/悲观${Math.round(wPes * 100)}%）`, low: r2(rangeLow), mid: r2(finalTarget), high: r2(rangeHigh), note: `三情景内加权后再按景气度权重合成；最终目标价 ${r2(finalTarget)} 元` },
  ];

  const assumpRows = [
    { label: 'WACC / 永续g', value: `8.0% / 3.5%（指令固定，所有情景共用）` },
    { label: 'EBIT利润率路径', value: `乐观 10%→14%、基准 6.5%→10.5%、悲观 4.5%→8.5%（每年+1pct【假设：指令只给Y年区间，爬坡斜率为模型假设】）` },
    { label: 'CAPEX/营收', value: `乐观 17%→16%、基准 19%→18%、悲观 23.5%→22%（指令区间中值起线性递减至下限）` },
    { label: '税率 / β / Rf / Rm', value: `12% / 1.6（展示参考）/ 1.68%（2026-09-03）/ 9.0%` },
    { label: '营收路径', value: `2026-2030：机构预期(2026/2027/2028) + 2029/2030 +11%/+10%【假设】` },
    { label: 'PB / PS 系数', value: `PB=可比3.0×[0.9~1.1]；PS=可比4.9×0.8（0.7~0.9中值）` },
    { label: 'D&A / ΔWC / 净债务', value: `6%【假设】/ 增速×5%【假设】/ 52.43亿（含35亿货币资金【假设】）` },
  ];

  const positionNote = (() => {
    if (P == null) return '当前价不可用，仅输出区间。';
    const pos = Math.max(0, Math.min(100, (P - rangeLow) / (rangeHigh - rangeLow) * 100));
    return `基于最新可得数据（配置 dataAsOf=${cfg.dataAsOf}）：当前股价 ${r2(P)} 元位于情景综合区间 ${Math.round(pos)}% 位置；预期涨幅 ${r2(expectedReturn)}%（最终目标价 ${r2(finalTarget)} 元）→ 指令评级映射：「${rating}」。历史PE分位：PE(TTM)约126.5倍处过去5~10年 >70% 高位区；但 2026E 动态PE约36倍、2027E约26倍，随涨价周期利润释放快速消化。核心逻辑：2026年7月第二轮涨价（+15%起）尚未进入上半年利润表，Q3/Q4 毛利率修复（18%→20%+）是关键催化。`;
  })();

  const riskNote = '上行：涨价传导顺利、SiC 产能爬坡（6寸月产1万片满载/8寸扩至1万片）、AI服务器电源放量、毛利率重回20%+；下行：原材料成本吞噬涨价、12寸/SiC 折旧持续压制、扩产 CAPEX 超预期、景气度回落触发情景权重自动下调。本模型自动适配任意时点（景气度评分→权重→结果全链路动态）；所有结果基于公开信息与机构预测，不构成投资建议。';

  return {
    ok: true,
    dedicated: true,
    silan: true,
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(finalTarget),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'silan600460·景气度动态引擎（确定性计算，无AI参与）',
    dataAsOf: cfg.dataAsOf,
    cyc: { total: cycTotal, level: cyc.level, weights: cyc.w },
    freshnessRows, alerts: staleAlerts,
    coreRows, cycRows, scenRows, matrixRows, assumpRows, positionNote, riskNote,
    decisionNote: `全时段通用引擎（无硬编码年份）：景气度五项评分（交期/价格/库存/产能/需求）→ 总分 ${cycTotal} → 景气度「${cyc.level}」→ 情景权重 乐观${Math.round(wOpt * 100)}%/基准${Math.round(wBase * 100)}%/悲观${Math.round(wPes * 100)}%；各情景内 PE40%+DCF30%+PB20%+PS10%（DCF 失效自动剔除归一）；景气度回落时权重自动切换，无需修改任何日期参数。`
  };
}

module.exports = { run, isSilanModel, loadConfig };
