// ============================================================
// 士兰微（600460）数据治理升级版 —— 零网络单元测试
// 20261029q：TTM滚动/年化退化/B级外推/锚点识别/口径锁定/完整度评分/自检清单/L4待更新
// 运行：node scripts/test_valuation_silan.js
// ============================================================
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const m = require('../lib/valuation/silan600460.js');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } };
const near = (a, b, eps) => a != null && Math.abs(a - b) <= (eps || 0.01);

// 2026H1 锚点实测数（2026-10-29 东财F10三表拉取，单位亿；fyDa 为合理 mock 值）
const mockS = {
  asOf: '2026-06-30', anchorMonth: 6, stage: '06-30',
  revCum: 72.62, npCum: 5.16, npDedCum: 2.71, revYoy: 14.62,
  fyRev: 130.52, fyNp: 3.99, fyNpDed: 3.72, fyCfo: 14.98, fyCapex: 16.32, fyDa: 13.0,
  prevSameRev: 63.36, prevSameNp: 2.65, prevSameNpDed: 2.69, prevSameCfo: 3.32, prevSameCapex: 6.80, prevSameDa: 6.92,
  curCfo: 2.92, curCapex: 6.40, curDa: 7.79,
  equityCur: 123.50, equityFY: 119.69, cashCur: 41.74, arCur: 37.57, invCur: 37.92, apCur: 35.05,
  minorityCur: 9.10, loanShortCur: 16.79, loanLongCur: 65.81,
  arFY: 31.79, invFY: 38.82, apFY: 33.34,
  balAsOf: '2026-06-30',
};

console.log('===== 1. 第三章 3.1：TTM 滚动固定公式 =====');
{
  const t1 = m.ttmRoll(130.52, 72.62, 63.36, 6);
  ok('1.1 严格 TTM 营收 = 130.52+72.62−63.36 = 139.78（非年化）', near(t1.value, 139.78, 0.001) && !t1.annualized);
  const t2 = m.ttmRoll(3.99, 5.16, 2.65, 6);
  ok('1.2 严格 TTM 归母 = 6.50', near(t2.value, 6.50, 0.001));
  const t3 = m.ttmRoll(3.72, 2.71, 2.69, 6);
  ok('1.3 严格 TTM 扣非 = 3.74', near(t3.value, 3.74, 0.001));
  const t4 = m.ttmRoll(130.52, 72.62, null, 6);
  ok('1.4 上年同期缺失 → 退化年化 ×2（标注 annualized）', near(t4.value, 145.24, 0.001) && t4.annualized && /年化口径/.test(t4.note));
  const t5 = m.ttmRoll(null, 72.62, null, 6);
  ok('1.5 上年年报也缺失 → 年化（72.62×2=145.24）', near(t5.value, 145.24, 0.001) && t5.annualized);
  const t6 = m.ttmRoll(130.52, 130.52, null, 12);
  ok('1.6 年报锚点 → TTM=全年（不走拼接）', near(t6.value, 130.52, 0.001) && !t6.annualized);
  const t7 = m.ttmRoll(null, null, null, 6);
  ok('1.7 全缺失 → null（禁静默填充）', t7.value === null);
  const t8 = m.ttmRoll(14.98, 2.92, 3.32, 6);
  ok('1.8 TTM 经营现金流 = 14.58', near(t8.value, 14.58, 0.001));
  const t9 = m.ttmRoll(16.32, 6.40, 6.80, 6);
  ok('1.9 TTM CAPEX = 15.92', near(t9.value, 15.92, 0.001));
}

console.log('===== 2. 第三章 3.2：B级外推固定公式（系数 0.5 不得调整） =====');
{
  const b1 = m.bkExtrapolate(100, 10);
  ok('2.1 外推 = 100×(1+10%×0.5) = 105', near(b1.value, 105, 0.001) && /0\.5/.test(b1.note));
  const b2 = m.bkExtrapolate(50, 14.62);
  ok('2.2 营收同比 14.62% → 50×1.0731 = 53.66', near(b2.value, 53.66, 0.01));
  const b3 = m.bkExtrapolate(null, 10);
  ok('2.3 B级缺失 → null（禁静默填充）', b3.value === null);
  const b4 = m.bkExtrapolate(100, null);
  ok('2.4 营收同比缺失 → null', b4.value === null);
}

console.log('===== 3. run 集成（零网络注入 2026H1 锚点 + 现价 24.18） =====');
(async () => {
  const r = await m.run('600460', { price: 24.18, statements: mockS });
  ok('3.1 正常输出（非终止）', r.ok && !r.terminated && r.dedicated && r.silan);
  ok('3.2 锚点自动识别 = 2026-06-30 半年报', r.anchor && r.anchor.asOf === '2026-06-30' && r.anchor.stageLabel === '半年报');
  ok('3.3 完整度 80/100（A40+B20+C0+H20）', r.completeness === 80);
  ok('3.4 完整度≥70 → 无可靠性提示', !r.reliabilityHint);
  ok('3.5 身份证台账 25 项', r.dataLedgerRows && r.dataLedgerRows.length === 25);
  ok('3.6 台账全带三要素（报告期/级别/获取方式）', r.dataLedgerRows.every(x => x.value.includes('报告期') && x.label.includes('级]') && x.value.includes('获取方式')));
  ok('3.7 级别矩阵 4 行且 A 同步 / B 同步（半年报锚）/ C 滞后', r.levelMatrixRows.length === 4 && r.levelMatrixRows[0].synced === true && r.levelMatrixRows[1].synced === true && r.levelMatrixRows[2].synced === false);
  ok('3.8 口径锁定 PE(TTM) = 24.18×16.63÷6.50 = 61.86 倍', r.caliberRows[0].value.includes('61.86'));
  ok('3.9 口径锁定 PB(LF) = 402.32÷123.50 = 3.26 倍', r.caliberRows[1].value.includes('3.26'));
  ok('3.10 口径锁定 PS(TTM) = 402.32÷139.78 = 2.88 倍', r.caliberRows[2].value.includes('2.88'));
  ok('3.11 ROE(TTM) = 6.50÷121.595 = 5.34%', r.caliberRows[3].value.includes('5.34'));
  ok('3.12 CAPEX/营收 TTM 实际 = 11.389%', /11\.389/.test(r.caliberRows[4].value));
  ok('3.13 净债务实时 = 16.79+65.81−41.74 = 40.86 亿', r.coreRows.some(x => /净债务/.test(x.value) && x.value.includes('40.86')));
  ok('3.14 ΔWC 实际 = (5.78)+(−0.90)−(1.71) = 3.17 亿', r.coreRows.some(x => /ΔWC/.test(x.value) && x.value.includes('3.17')));
  ok('3.15 自检 10/10 全过', r.checklistRows.length === 10 && r.checklistRows.every(x => x.pass));
  ok('3.16 DCF 基数 TTM 提示（sensHints）', (r.sensHints || []).some(h => /基数=TTM实际/.test(h)));
  ok('3.17 景气度总分 5 → 情景权重 50/40/10（沿袭）', r.cyc.total === 5 && r.cyc.weights.optimistic === 0.5);
  ok('3.18 评级三档铁律', ['低估', '合理', '高估'].includes(r.rating));
  ok('3.19 现价 24.18 在区间内 → 合理', r.rating === '合理' && r.fairValueRange[0] < 24.18 && 24.18 < r.fairValueRange[1]);
  ok('3.20 DCF 基数 TTM 化生效（确定性：两次运行中枢一致）', r.fairValueCenter != null && near(r.fairValueCenter, 27.57, 0.01));
  ok('3.21 兼容字段保留（assumpRows 7 项/scenRows/matrixRows/freshnessRows）', r.assumpRows.length === 7 && r.scenRows.length === 3 && r.matrixRows.length === 5 && r.freshnessRows.length > 0);
  ok('3.22 summaryNote 含锚点+TTM+完整度', /锚点 2026-06-30/.test(r.summaryNote) && /139\.78/.test(r.summaryNote) && /80\/100/.test(r.summaryNote));

  console.log('===== 4. 治理边界与诚实中止 =====');
  const rAnn = await m.run('600460', { price: 24.18, statements: { ...mockS, prevSameRev: null, prevSameNp: null } });
  ok('4.1 上年同期缺失 → TTM 年化退化 + 敏感性提示', (rAnn.sensHints || []).some(h => /年化口径/.test(h)) && /年化/.test(rAnn.dataLedgerRows.find(x => /TTM 营收/.test(x.label)).source));
  const rL4 = await m.run('600460', { price: 24.18, statements: { ...mockS, revCum: null, npCum: null } });
  ok('4.2 三表核心缺失 → L4 待更新态（禁用旧值静默填充）', rL4.pendingUpdate === true && rL4.rating === '待更新态');
  const rErr = await m.run('000783', { price: 10 });
  ok('4.3 非士兰微标的 → NOT_SILAN', rErr.error === 'NOT_SILAN');

  console.log(`===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
