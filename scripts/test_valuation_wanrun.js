// ============================================================
// 万润股份（002643）v2.0 数据频率自适应版 —— 零网络单元测试
// 20261029s：TTM拼接/累计转单季/总和校验/置信度权重/置信度区间/趋势偏离/run集成(mock 9M)/DCF再平衡/NOT_WANRUN
// 运行：node scripts/test_valuation_wanrun.js
// ============================================================
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const m = require('../lib/valuation/wanrun002643.js');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } };
const near = (a, b, eps) => a != null && Math.abs(a - b) <= (eps || 0.01);

// 2026-09-30 三季报（9M）锚点实测数（2026-10-29 东财F10三表拉取，单位亿）
const mock9M = {
  asOf: '2026-09-30', stageLabel: '三季报(9M)',
  inc: { revCum: 29.5755, npCum: 2.6851, npDedCum: 2.5513, costCum: 18.2518, finExpCum: 0.3801, rdExpCum: 3.0 },
  fy: { rev: 37.1663, np: 2.8448, npDed: 2.6222, cost: 22.4631, finExp: 0.0778, rdExp: 4.3855 },
  prevSame: { rev: 28.2632, np: 3.0564, npDed: 2.9193, cost: 17.1851, finExp: -0.0466, rdExp: 3.1059 },
  cf: { cfoCum: 6.1837, capexCum: 4.8147, cfoFy: 10.8989, capexFy: 6.9352, cfoPrevSame: 9.8167, capexPrevSame: 5.3624 },
  bal: { equity: 71.7410, cip: 11.5672, fixed: 43.3702, cash: 14.5667, stLoan: 4.0369, ltLoan: 13.3209, balAsOf: '2026-09-30' },
};

console.log('===== 1. TTM 拼接（纯函数 ttmSplice） =====');
{
  const t1 = m.ttmSplice(37.1663, 29.5755, 28.2632);
  ok('1.1 TTM 营收 = 37.1663+29.5755−28.2632 = 38.4786', near(t1.value, 38.4786, 0.001) && !t1.gap);
  const t2 = m.ttmSplice(2.8448, 2.6851, 3.0564);
  ok('1.2 TTM 归母 = 2.4735（9M 归母同比下滑 12.2% 如实入 TTM）', near(t2.value, 2.4735, 0.001));
  const t3 = m.ttmSplice(0.0778, 0.3801, -0.0466);
  ok('1.3 TTM 财务费用 = 0.5045（负值同期正确处理）', near(t3.value, 0.5045, 0.001));
  const t4 = m.ttmSplice(2.8448, 2.6851, null);
  ok('1.4 上年同期缺失 → gap:true value:null（不编造）', t4.gap === true && t4.value === null);
}

console.log('===== 2. 累计转单季（纯函数 cumToQuarters） =====');
{
  const q = m.cumToQuarters({ q1: 10.1527, h1: 19.8341, q3: 29.5755, fy: 37.1663 });
  ok('2.1 Q1 = 10.1527', near(q.Q1, 10.1527));
  ok('2.2 Q2 = 19.8341−10.1527 = 9.6814', near(q.Q2, 9.6814, 0.001));
  ok('2.3 Q3 = 29.5755−19.8341 = 9.7414', near(q.Q3, 9.7414, 0.001));
  ok('2.4 Q4 = 37.1663−29.5755 = 7.5908', near(q.Q4, 7.5908, 0.001));
  ok('2.5 四单季之和 = 年报累计', near(q.Q1 + q.Q2 + q.Q3 + q.Q4, 37.1663, 0.001));
}

console.log('===== 3. 总和校验（纯函数 sumCheckSegs） =====');
{
  const s1 = m.sumCheckSegs([{ name: 'A', rev: 29.7 }, { name: 'B', rev: 8.8 }], 38.4786, 0.02);
  ok('3.1 偏差 0.06% ≤ 2% → 通过不缩放', s1.ok === true && s1.scaled === false);
  const s2 = m.sumCheckSegs([{ name: 'A', rev: 30 }, { name: 'B', rev: 12 }], 38.4786, 0.02);
  ok('3.2 偏差 9.1% > 2% → 缩放使加总=总营收', s2.ok === false && s2.scaled === true && near(s2.after.reduce((a, s) => a + s.rev, 0), 38.4786, 0.01));
}

console.log('===== 4. 置信度层权重（纯函数 confRebalance） =====');
{
  // 情形A：DCF 偏离 >80% → DCF 再平衡 60/35/5，再置信度调整
  const r1x = m.confRebalance({ pbRoe: 0.5, pe: 0.35, dcf: 0.15 }, { pbRoe: 1.0, pe: 0.95, dcf: 1.0 }, 2.5, 5.4, 40.4);
  ok('4.1 DCF 再平衡触发（偏离 >80%）→ 60/35/5', r1x.dcfRebalanced === true && near(r1x.weights.pbRoe, 0.6) && near(r1x.weights.pe, 0.35) && near(r1x.weights.dcf, 0.05));
  // 情形B：DCF 正常 + PE 层置信度 0.6 <0.7 → 权重×0.857 释放给其余层
  const r2x = m.confRebalance({ pbRoe: 0.5, pe: 0.35, dcf: 0.15 }, { pbRoe: 1.0, pe: 0.6, dcf: 1.0 }, 5.4, 5.4, 40.4);
  ok('4.2 置信度调整触发：PE 权重 0.35×(0.6/0.7)=0.30', r2x.confAdjusted === true && near(r2x.weights.pe, 0.30, 0.001));
  ok('4.3 释放权重按剩余层置信度比例分配（1:1）→ PB-ROE 与 DCF 各 +0.025', near(r2x.weights.pbRoe, 0.525, 0.001) && near(r2x.weights.dcf, 0.175, 0.001));
  ok('4.4 调整后权重和 = 100%', near(r2x.weights.pbRoe + r2x.weights.pe + r2x.weights.dcf, 1.0, 0.001));
  ok('4.5 DCF 未再平衡', r2x.dcfRebalanced === false);
}

console.log('===== 5. 置信度区间（纯函数 intervalRange） =====');
{
  const iv1 = m.intervalRange(17.51, 0.9825, 0.15);
  ok('5.1 半宽 = 15%÷0.9825 = 15.27% → 区间 [14.84, 20.18]', near(iv1.halfPct, 15.27, 0.01) && near(iv1.range[0], 14.84, 0.01) && near(iv1.range[1], 20.18, 0.01));
  const iv2 = m.intervalRange(10, 0.6, 0.15);
  ok('5.2 置信度越低区间越宽：C=0.6 → 半宽 25%', near(iv2.halfPct, 25, 0.01));
}

console.log('===== 6. 趋势偏离（纯函数 deviationPct） =====');
{
  ok('6.1 TTM ROE 3.45 vs 近三年均值 6.36 → 偏离 45.79%（>30% 触发）', near(m.deviationPct(3.45, 6.36), 45.79, 0.05));
  ok('6.2 TTM 毛利率 38.85 vs 40.62 → 偏离 4.36%（<30% 通过）', near(m.deviationPct(38.85, 40.62), 4.36, 0.05));
}

console.log('===== 6.5 v2.1 熔断纯函数（peCircuitBreaker / marketImpliedNpCheck / layerVetoMerge / tradingDaysBetween） =====');
{
  // 熔断1：行业PE极值熔断
  const cb1a = m.peCircuitBreaker(103.39, 100, 60);
  ok('6.5.1 熔断1：中位数 103.39>60 且分位 100%≥80% → 触发，基准PE=min=60', cb1a.triggered === true && near(cb1a.basePe, 60, 0.001));
  const cb1b = m.peCircuitBreaker(45, 60, 60);
  ok('6.5.2 熔断1：中位数 45≤60 且分位 60%<80% → 不触发，基准PE=45', cb1b.triggered === false && near(cb1b.basePe, 45, 0.001));
  const cb1c = m.peCircuitBreaker(45, 85, 60);
  ok('6.5.3 熔断1：中位数 45≤60 但分位 85%≥80% → 触发（分位条件独立生效），基准PE=45', cb1c.triggered === true && near(cb1c.basePe, 45, 0.001));
  // 熔断2：市场隐含定价反向约束
  const cb2a = m.marketImpliedNpCheck(15.5 * 9.16, 51, 4.2078, 30);
  ok('6.5.4 熔断2：隐含 2.7839 vs 一致 4.2078 偏差 33.84% >30% → 触发，取均值 3.4959', cb2a.triggered === true && near(cb2a.impliedNp, 2.7839, 0.001) && near(cb2a.npUsed, 3.4959, 0.001));
  const cb2b = m.marketImpliedNpCheck(25.0 * 9.16, 51, 4.2078, 30);
  ok('6.5.5 熔断2：隐含 4.49 vs 一致 4.2078 偏差 6.71% ≤30% → 不触发，用一致预期', cb2b.triggered === false && near(cb2b.npUsed, 4.2078, 0.001));
  // 熔断4：层间背离一票否决
  const cb4a = m.layerVetoMerge(5, 40, 0.5, 0.35, 0.15, 100);
  ok('6.5.6 熔断4：PB 5 vs PE 40 差异 155.6% >100% → 触发，合并值取较低 5，PE 权重 35% 释放转 DCF（0.15→0.50）', cb4a.triggered === true && near(cb4a.mergedPrice, 5, 0.001) && near(cb4a.weights.pbRoe, 0.5, 0.001) && near(cb4a.weights.pe, 0, 0.001) && near(cb4a.weights.dcf, 0.5, 0.001));
  const cb4b = m.layerVetoMerge(40, 5, 0.5, 0.35, 0.15, 100);
  ok('6.5.7 熔断4：PB 40 vs PE 5（反向）→ 合并值仍取较低 5，PB 权重 50% 释放转 DCF（0.15→0.65）', cb4b.triggered === true && near(cb4b.mergedPrice, 5, 0.001) && cb4b.lowerIsPbr === false && near(cb4b.weights.pbRoe, 0, 0.001) && near(cb4b.weights.pe, 0.35, 0.001) && near(cb4b.weights.dcf, 0.65, 0.001));
  const cb4c = m.layerVetoMerge(5, 12, 0.5, 0.35, 0.15, 100);
  ok('6.5.8 熔断4：PB 5 vs PE 12 差异 82.4% ≤100% → 不触发，权重不变', cb4c.triggered === false && near(cb4c.weights.pbRoe, 0.5, 0.001) && near(cb4c.weights.pe, 0.35, 0.001));
  // 熔断3：交易日计数（工作日近似）
  ok('6.5.9 tradingDaysBetween(2026-10-23 → 2026-10-30) = 5（跳过周末 24/25）', m.tradingDaysBetween('2026-10-23', '2026-10-30') === 5);
  ok('6.5.10 同日差 = 0', m.tradingDaysBetween('2026-10-30', '2026-10-30') === 0);
  ok('6.5.11 非法日期 → null（不编造）', m.tradingDaysBetween('bad', '2026-10-30') === null);
}

console.log('===== 7. run 集成（mock 9M 注入 · 零网络 · v2.1 熔断口径） =====');
const t7 = (async () => {
  const r = await m.run('002643', { price: 15.5, statements: mock9M });
  ok('7.1 ok:true + version v2.1_数据熔断与异常校准', r && r.ok === true && r.version === 'v2.1_数据熔断与异常校准');
  ok('7.2 锚点 = 2026-09-30 三季报(9M)', r.anchor2 && r.anchor2.asOf === '2026-09-30' && r.anchor2.stageLabel === '三季报(9M)');
  ok('7.3 TTM 归母 2.47 亿（Q3 暴跌如实入 TTM）', r.anchor2 && near(r.anchor2.ttm.np, 2.47, 0.01));
  ok('7.4 TTM ROE = 2.4735÷71.741 = 3.45%', r.anchor2 && near(r.anchor2.ttm.roe, 3.45, 0.01));
  ok('7.5 BPS = 71.741÷9.16 = 7.83（存量时点）', r.anchor2 && near(r.anchor2.bps, 7.83, 0.01));
  ok('7.6 FCFF = CFO 7.27 − capex 6.39 = 0.88（OCF>capex 规则）', r.anchor2 && near(r.anchor2.ttm.fcff, 0.88, 0.01));
  ok('7.7 净债务 = 4.04+13.32−14.57 = 2.79（存量实时）', r.anchor2 && near(r.anchor2.netDebt, 2.79, 0.01));
  // v2.1：熔断1 基准PE封顶 60×0.85=51 → 隐含利润 15.5×9.16÷51=2.7839 vs 一致预期 4.2078 偏差 33.84%>30% → 熔断2 取均值 3.4959
  //       → PE股价 3.4959×51÷9.16=19.47 vs PB-ROE 5.43 差异 112.76%>100% → 熔断4 一票否决：合并值取较低 5.4295，释放 35% 转 DCF
  ok('7.8 DCF 再平衡触发 + 熔断4 否决后最终权重 60/0/40（PE 层 35% 释放转 DCF）', r.weights && r.weights.dcfRebalanced === true && near(r.weights.final.pbRoe, 0.6, 0.001) && near(r.weights.final.pe, 0, 0.001) && near(r.weights.final.dcf, 0.4, 0.001));
  ok('7.9 层均置信度 avg = 1.0（被否决 PE 层权重 0）', r.confLayers && near(r.confLayers.avg, 1.0, 0.001) && near(r.confLayers.effAvg, 1.0, 0.001) && near(r.confLayers.halfPct, 15, 0.01));
  ok('7.10 中枢 = 0.6×5.4295 + 0.4×2.46 ≈ 4.24（熔断4 合并口径）', near(r.fairValueCenter, 4.24, 0.05));
  ok('7.11 置信度区间 [3.61, 4.88]', near(r.fairValueRange[0], 3.61, 0.02) && near(r.fairValueRange[1], 4.88, 0.02));
  ok('7.12 现价 15.5 → 信号比 3.65 > 1.30 → 高估（熔断压缩估值中枢后如实判高估）', r.rating === '高估' && near(r.signalRatio, 3.65, 0.01));
  ok('7.13 拼接表 12+ 项逐项标注', (r.spliceRows || []).length >= 10);
  ok('7.14 校验四条结构齐备（校验二/四按规范触发）', (r.checkRows || []).length === 4 && r.checkRows[1].pass === false && r.checkRows[0].pass === true);
  ok('7.15 敏感性网格由参数生成（5×4 两矩阵）', (r.sensRows || []).length === 10 && (r.sensColsPe || []).length === 4);
  ok('7.16 versionNote 含 FCFF/净债务实时化说明', /FCFF 基期/.test(r.versionNote || '') && /净债务/.test(r.versionNote || ''));
  ok('7.19 v2.1 熔断状态表 cbRows 4 项齐备', (r.cbRows || []).length === 4);
  // 现价远高于区间 → 高估（信号比 >1.30）
  const rHigh = await m.run('002643', { price: 25.0, statements: mock9M });
  ok('7.17 现价 25.0 → 信号比 5.89 > 1.30 → 高估', rHigh.rating === '高估');
  // 现价远低于区间 → 低估（信号比 <0.75；v2.1 熔断2 向市场妥协后需更低价格触发）
  const rLow = await m.run('002643', { price: 5.5, statements: mock9M });
  ok('7.18 现价 5.5 → 信号比 0.68 < 0.75 → 低估', rLow.rating === '低估');
  ok('7.20 现价 25.0 → 熔断2 未触发（隐含 4.49 vs 一致 4.2078 偏差 6.71% ≤30% → 用一致预期）', rHigh.circuitBreakers.marketImplied.triggered === false && near(rHigh.circuitBreakers.marketImplied.npUsed, 4.2078, 0.001));
  ok('7.21 现价 5.5 → 熔断4 未触发（PB-ROE vs PE 差异 90.83% ≤100%）', rLow.circuitBreakers.layerVeto.triggered === false && near(rLow.weights.final.pe, 0.35, 0.001));
  ok('7.22 注入实时价 → 熔断3 未触发（D层时效 0 交易日）', r.circuitBreakers.quoteLag.tradingDays === 0 && r.circuitBreakers.quoteLag.tagged === false && r.circuitBreakers.quoteLag.signalBlocked === false);
  // 无价格 → D层回退配置快照 2026-09-18，距今 >15 交易日 → 熔断3 拦截方向信号
  const r0 = await m.run('002643', { statements: mock9M });
  ok('7.23 无实时价 + D层快照滞后 >15 交易日 → 熔断3：禁止方向信号，评级=仅区间参考', r0.circuitBreakers.quoteLag.signalBlocked === true && /仅区间参考/.test(r0.rating) && !['低估', '高估', '合理'].includes(r0.rating));
  ok('7.24 熔断3 触发后置信度封顶 0.6 → 区间放宽（半宽 15%÷0.6 = 25%）', r0.circuitBreakers.quoteLag.conf === 0.6 && near(r0.confLayers.effAvg, 0.6, 0.001) && near(r0.confLayers.halfPct, 25, 0.01));
})();

console.log('===== 8. 回退链：TTM 缺口 → 配置锚插补（置信度 0.6） =====');
const t8 = (async () => {
  const mockGap = Object.assign({}, mock9M, { prevSame: null, cf: Object.assign({}, mock9M.cf, { cfoPrevSame: null, capexPrevSame: null }) });
  const r = await m.run('002643', { price: 15.5, statements: mockGap });
  ok('8.1 缺口仍 ok:true（回退配置锚，不编造）', r && r.ok === true);
  ok('8.2 fallbackFlags 标注回退', (r.fallbackFlags || []).length > 0);
  ok('8.3 拼接表置信度降为 0.6', (r.spliceRows || []).some(s => s.conf === 0.6));
  ok('8.4 PB-ROE 层置信度降为 0.6 → 若 <0.7 触发权重调整标记', r.confLayers && r.confLayers.pbRoe === 0.6 && r.weights.confAdjusted === true);
})();

console.log('===== 9. 闸门 =====');
const t9 = (async () => {
  const r1x = await m.run('600909', { price: 10 });
  ok('9.1 非万润标的 → NOT_WANRUN', r1x && r1x.error === 'NOT_WANRUN');
  const cfg = m.loadConfig();
  ok('9.2 配置 v2 块 + v2.1 块 + 版本 20261030k', cfg && cfg.v2 && cfg.v21 && cfg.version === '20261030k');
  ok('9.3 lastVersion 存档（V1.0 合理 18.56）', cfg.lastVersion && cfg.lastVersion.e2e.rating === '合理' && cfg.lastVersion.e2e.center === 18.56);
})();

Promise.all([t7, t8, t9]).then(() => {
  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('TEST_ERR', e); process.exit(1); });
