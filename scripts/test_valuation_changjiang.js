/**
 * scripts/test_valuation_changjiang.js — 长江证券（000783）专属估值引擎 V3-五法则回归
 * 对应 20261029o：按用户下发五法则重构——①数据分层与时间戳对齐（刚性实时层［最新报告期］/
 * 柔性平滑层［推算估算值］）②TTM重构（TTM归母÷平均归母净资产）③主辅模型休眠机制
 * ④历史分位双轨防御 ⑤逻辑自洽与极值熔断；全量重算接入最新报告期三表。
 * 全部用构造三表直调 run（statements/balanceQuarterly 注入，零网络），数值断言为手工精确结果。
 *
 * 运行： node scripts/test_valuation_changjiang.js
 */
'use strict';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
function near(actual, expected, msg, eps = 0.011) {
  ok(actual != null && Math.abs(actual - expected) <= eps, `${msg}（实际 ${actual}，期望 ${expected}±${eps}）`);
}
function eq1(actual, expected, msg) {
  ok(String(actual) === String(expected), `${msg}（实际 ${actual}，期望 ${expected}）`);
}

const cj = require('../lib/valuation/changjiang000783.js');

// ---------- 构造三表（元；2026Q3/2025Q3 累计值取自 2026-10-29 东财F10 实测） ----------
function baseData() {
  return {
    statements: {
      income: [
        { REPORT_DATE: '2025-12-31 00:00:00', TOTAL_OPERATE_INCOME: 10548000000, PARENT_NETPROFIT: 3696410000, DEDUCT_PARENT_NETPROFIT: 3777000000, FEE_COMMISSION_NI: 5500000000, INTEREST_NI: 2100000000, INVEST_INCOME: 3800000000, FAIRVALUE_CHANGE_INCOME: -400000000 },
        { REPORT_DATE: '2025-09-30 00:00:00', TOTAL_OPERATE_INCOME: 6100000000, PARENT_NETPROFIT: 3372614462.45, DEDUCT_PARENT_NETPROFIT: 3401140000, FEE_COMMISSION_NI: 4200000000, INTEREST_NI: 1600000000, INVEST_INCOME: 3500000000, FAIRVALUE_CHANGE_INCOME: -300000000 },
        { REPORT_DATE: '2026-06-30 00:00:00', TOTAL_OPERATE_INCOME: 7426000000, PARENT_NETPROFIT: 3192490000, DEDUCT_PARENT_NETPROFIT: 3163630000, FEE_COMMISSION_NI: 3900000000, INTEREST_NI: 1300000000, INVEST_INCOME: 3350000000, FAIRVALUE_CHANGE_INCOME: -162000000 },
        { REPORT_DATE: '2026-09-30 00:00:00', TOTAL_OPERATE_INCOME: 8874644121.68, PARENT_NETPROFIT: 3655102399.16, DEDUCT_PARENT_NETPROFIT: 3585418056.21, FEE_COMMISSION_NI: 4423127051.05, INTEREST_NI: 1815976084.59, INVEST_INCOME: 3361302760.29, FAIRVALUE_CHANGE_INCOME: -835505220.27 },
      ],
      balance: [
        { REPORT_DATE: '2025-12-31 00:00:00', TOTAL_PARENT_EQUITY: 41916000000, OTHER_EQUITY_TOOL: 6000000000, TOTAL_ASSETS: 200000000000, TRADE_FINASSET_NOTFVTPL: 30000000000, OTHER_CREDITOR_INVEST: 25000000000, OTHER_EQUITY_INVEST: 600000000, DERIVE_FINASSET: 300000000 },
      ],
      cashflow: [
        { REPORT_DATE: '2026-09-30 00:00:00', NETCASH_OPERATE: 5000000000 },
      ],
    },
    balanceQuarterly: [
      { REPORT_DATE: '2025-12-31 00:00:00', TOTAL_PARENT_EQUITY: 41916000000, OTHER_EQUITY_TOOL: 6000000000, TOTAL_ASSETS: 200000000000, TRADE_FINASSET_NOTFVTPL: 30000000000, OTHER_CREDITOR_INVEST: 25000000000, OTHER_EQUITY_INVEST: 600000000, DERIVE_FINASSET: 300000000 },
      { REPORT_DATE: '2026-06-30 00:00:00', TOTAL_PARENT_EQUITY: 42904000000, OTHER_EQUITY_TOOL: 6000000000, TOTAL_ASSETS: 210000000000, TRADE_FINASSET_NOTFVTPL: 34000000000, OTHER_CREDITOR_INVEST: 26000000000, OTHER_EQUITY_INVEST: 600000000, DERIVE_FINASSET: 300000000 },
      { REPORT_DATE: '2026-09-30 00:00:00', TOTAL_PARENT_EQUITY: 43092483620.13, OTHER_EQUITY_TOOL: 6000000000, TOTAL_ASSETS: 216804674676.85, TRADE_FINASSET_NOTFVTPL: 38016024522.11, OTHER_CREDITOR_INVEST: 27638810226.73, OTHER_EQUITY_INVEST: 58829417.41, DERIVE_FINASSET: 351941334.29 },
    ],
  };
}

(async () => {
  // ═══════════ 1. 基准全量计算（三季报期，price 8.60） ═══════════
  const r1 = await cj.run('000783', { price: 8.6, ...baseData() });
  ok(r1 && r1.ok === true, '1.0 基准运行应成功');
  if (!r1.ok) { console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`); failures.forEach(f => console.log('[FAIL] ' + f)); process.exit(1); }

  eq1(r1.version, 'V3-五法则', '1.1 版本应为 V3-五法则');
  eq1(r1.asOfDate, '2026-09-30', '1.2 as-of 应为最新报告期 2026-09-30（三季报）');
  eq1(r1.asOfStage, '三季报期', '1.3 阶段标签应为三季报期');
  eq1(r1.rating, '低估', '1.4 现价 8.60 vs 中枢 10.73 → 折价>10% 应为【低估】');
  near(r1.fairValueCenter, 10.73, '1.5 中枢 = BVPS 6.7062 × 封顶后动态锚 1.60（理论PB锚，补丁I·规则②三位一体向下约束）≈ 10.73', 0.03);

  const fp = r1.fairPB;
  near(fp.roeTtm, 10.90, '1.6 TTM ROE = 归母TTM 39.789 ÷ 平均普通股净资产 365.042 = 10.90%（第二法则，非单季×4）', 0.02);
  const rigid0 = Object.fromEntries(r1.layers.rigid.map(x => [x.key, x]));
  near(rigid0.np_ttm.value, 39.79, '1.7 归母TTM = 36.9641 − 33.7261 + 36.5510 = 39.79', 0.01);
  near(rigid0.np_ded_ttm.value, 39.61, '1.8 扣非TTM = 37.77 − 34.0114 + 35.8542 = 39.61', 0.01);
  near(rigid0.bvps.value, 6.71, '1.9 BVPS = (430.9248 − 60) ÷ 55.3 = 6.71（普通股口径）', 0.005);
  near(rigid0.inv_assets.value, 660.66, '1.10 投资资产总规模 = 380.16+276.39+0.59+3.52 = 660.66', 0.02);
  near(rigid0.inv_inc_cum.value, 25.26, '1.11 投资净收益累计 = 33.6130 − 8.3551 = 25.26', 0.01);
  near(fp.anchorRaw, 1.83, '1.12a 动态PB锚原始值（含牛市溢价）= 1.2×(0.4+0.6×1.703)×1.075 = 1.834', 0.02);
  near(fp.anchor, 1.60, '1.12b 三位一体封顶后有效PB锚 = 理论PB锚 (predRoe-g)/(r-g) = 1.60', 0.02);
  eq1(fp.anchorCapped, true, '1.12c 补丁I·规则②三位一体向下约束已封顶（动态PB锚 1.83 > 理论PB锚 1.60）');

  // 第一法则：分层标签
  ok(r1.layers.rigid.length >= 10 && r1.layers.rigid.every(x => x.tag === '［最新报告期］' && x.period === '2026-09-30'),
    '1.13 刚性实时层全部标［最新报告期］且报告期=2026-09-30');
  ok(r1.layers.soft.length >= 5 && r1.layers.soft.every(x => x.tag === '［推算估算值］'),
    '1.14 柔性平滑层全部标［推算估算值］');
  ok(r1.dashboardRows.some(d => d.label.indexOf('刚性实时层') !== -1) && r1.dashboardRows.some(d => d.label.indexOf('柔性平滑层') !== -1),
    '1.15 数据新鲜度仪表盘同时包含刚性/柔性层（输出模板①）');

  // 第三法则：SOTP 休眠
  eq1(r1.layers.sotpDormant, true, '1.16 三季报期 → SOTP 强制休眠降级');
  ok(r1.layers.sotpDormantNote.indexOf('因财报披露颗粒度不足，SOTP暂不作为决策依据') !== -1,
    '1.17 休眠标注含指定文案「因财报披露颗粒度不足，SOTP暂不作为决策依据」');

  // 第四法则：双轨
  eq1(r1.patchF.anchorBreached, true, '1.18 动态锚 1.83 > 近5年90%分位 1.165 → 估值体系重构警告');
  ok(r1.matrixRows[0].method.indexOf('估值体系重构警告') !== -1, '1.19 矩阵最上方输出重构警告行');
  eq1(r1.patchF.boundaryFixed, true, '1.20 历史分位 90% 边界（7.81元）低于中枢 → 排序强校验触发强制外扩');
  near(r1.fairValueRange[0], 8.05, '1.21 极端悲观 = 封顶后中枢 10.73×0.75 = 8.05（强制外扩）', 0.02);
  near(r1.fairValueRange[1], 12.88, '1.22 极端乐观 = 封顶后中枢 10.73×1.20 = 12.88（强制外扩）', 0.02);

  // ── 补丁I（20261030e）：规则①②③④ 结构化断言 ──
  const pI1 = r1.patchI || {};
  eq1(pI1.rule1.priceSource, 'caller-injected-live', '1.23 规则①：调用方注入实时价（强同步生效，无历史残留现价 8.51）');
  eq1(pI1.rule2.anchorCapped, true, '1.24 规则②：动态PB锚 1.83 > 理论PB锚 1.60 → 三位一体封顶');
  near(Number(pI1.rule2.theoPB), 1.60, '1.25 规则②：理论PB锚 = 1.60', 0.02);
  near(Number(pI1.rule2.pbAnchorEff), 1.60, '1.26 规则②：有效PB锚被封顶至 1.60', 0.02);
  eq1(pI1.rule2b.floorBreached, false, '1.27 规则②b：现价 8.60 未击穿近5年50%分位铁底');
  eq1(pI1.rule3.boundaryFloorLock, false, '1.28 规则③：现价 8.60 高于极端悲观价 → 不锁铁底');

  // 第五法则：熔断
  ok(String(r1.decisionNote).indexOf('扣非切换未触发') !== -1, '1.23 归母/扣非同比偏离约 2.9pp ≤ 20pp → 扣非切换未触发');
  eq1(r1.fused, false, '1.24 现价 8.60：上行 43% < 60%、|下行| < 40% → 熔断未触发');
  ok(r1.summaryNote && r1.summaryNote.length <= 203, `1.25 核心逻辑摘要 ≤200字（实际 ${r1.summaryNote ? r1.summaryNote.length : 'N/A'}）`);
  ok(r1.summaryNote.indexOf('成交') !== -1 && r1.summaryNote.indexOf('自营') !== -1 && r1.summaryNote.indexOf('ROE') !== -1,
    '1.26 摘要涵盖成交活跃度/自营表现/ROE质变三要素');

  // ═══════════ 2. 补丁I·规则④：深度低估 → 熔断降级（绿色提示，非红灯） ═══════════
  const r2 = await cj.run('000783', { price: 4.0, ...baseData() });
  ok(r2.ok === true, '2.1 深度低估场景应成功');
  if (r2.ok) {
    eq1(r2.fused, false, '2.2 补丁I·规则④：现价 4.00 上行 168% > 60% → 熔断降级（fused=false，非红灯）');
    eq1(r2.rating, '绝对低估', '2.3 补丁I·规则④：降级触发「绝对低估/重大机会」绿色提示（不再锁定无法评级）');
    const pI2 = r2.patchI || {};
    eq1(pI2.rule4.ratingDowngraded, true, '2.4 规则④：ratingDowngraded=true（来自 无法评级 → 绝对低估）');
    eq1(pI2.rule2b.floorBreached, true, '2.5 规则②b/③：现价 4.00 击穿 50%分位铁底 → floorBreached=true（极度低估，严禁做空）');
    ok(pI2.rule4.buyRange && Math.abs(Number(pI2.rule4.buyRange[0]) - 6.14) < 0.03 && Math.abs(Number(pI2.rule4.buyRange[1]) - 9.12) < 0.05, '2.6 规则④：买入区间建议 ≈ [6.14, 9.12]（铁底至悲观情景上沿）');
    ok(String(pI2.rule4.davisNote).indexOf('戴维斯双杀') !== -1, '2.7 规则④：戴维斯双杀预警声明已生成');
  }

  // ═══════════ 3. 熔断1：归母/扣非偏离>20pp → 切换扣非 ═══════════
  const d3 = baseData();
  d3.statements.income.find(x => x.REPORT_DATE.startsWith('2025-09-30')).DEDUCT_PARENT_NETPROFIT = 2700000000; // 扣非同比暴涨
  const r3 = await cj.run('000783', { price: 8.6, ...d3 });
  ok(r3.ok === true, '3.1 扣非切换场景应成功');
  if (r3.ok) {
    ok(String(r3.decisionNote).indexOf('弃用归母') !== -1 || String(r3.decisionNote).indexOf('已触发') !== -1,
      '3.2 偏离>20pp → 弃用归母改用扣非');
    ok(String(r3.fairPB.roeTtmBasis).indexOf('扣非TTM') !== -1, '3.3 TTM ROE 改用扣非TTM口径');
    near(r3.fairPB.roeTtm, (37.77 - 27 + 35.8541805621) / 365.0424181007 * 100, '3.4 TTM ROE = 扣非TTM 46.62 ÷ 365.04 = 12.77%', 0.02);
  }

  // ═══════════ 4. 中报期：SOTP 正常运作（休眠自动解除） ═══════════
  const d4 = baseData();
  d4.statements.income = d4.statements.income.filter(x => !String(x.REPORT_DATE).startsWith('2026-09-30'));
  d4.statements.income.push({ REPORT_DATE: '2025-06-30 00:00:00', PARENT_NETPROFIT: 1736940000, DEDUCT_PARENT_NETPROFIT: 1710730000, INVEST_INCOME: 1500000000, FAIRVALUE_CHANGE_INCOME: 0 });
  d4.balanceQuarterly = d4.balanceQuarterly.filter(x => !String(x.REPORT_DATE).startsWith('2026-09-30'));
  const r4 = await cj.run('000783', { price: 8.6, ...d4 });
  ok(r4.ok === true, '4.1 中报期场景应成功');
  if (r4.ok) {
    eq1(r4.asOfStage, '中报期', '4.2 as-of 2026-06-30 → 中报期');
    eq1(r4.layers.sotpDormant, false, '4.3 中报期分部数据齐全 → SOTP 正常运作（休眠解除）');
    ok(r4.sotpRows[5].source.indexOf('正常运作') !== -1, '4.4 SOTP 合计行标注正常运作');
  }

  // ═══════════ 5. isChangjiangModel 闸门 ═══════════
  ok(cj.isChangjiangModel('000783') === true, '5.1 isChangjiangModel(000783) = true');
  ok(cj.isChangjiangModel('SZ000783') === true, '5.2 isChangjiangModel(SZ000783) = true（前缀兼容）');
  ok(cj.isChangjiangModel('603288') === false, '5.3 isChangjiangModel(603288) = false');

  // ═══════════ 6. 三表缺失 → 全量重算诚实中止 ═══════════
  const r6 = await cj.run('000783', { price: 8.6, statements: { income: [], balance: [], cashflow: [] }, balanceQuarterly: [] });
  ok(r6 && r6.ok === false && String(r6.message).indexOf('全量重算中止') !== -1, '6.1 三表缺失应诚实中止（刚性层禁用旧值）');

  // ═══════════ 7. 补丁I 头条场景：price 6.62（熔断降级 + 边界常识校验 + 戴维斯预警） ═══════════
  const r7 = await cj.run('000783', { price: 6.62, ...baseData() });
  ok(r7.ok === true, '7.1 补丁I 头条场景应成功');
  if (r7.ok) {
    const pI7 = r7.patchI || {};
    eq1(r7.rating, '绝对低估', '7.2 现价 6.62 大幅低于中枢 10.73 → 绝对低估（熔断降级，非无法评级）');
    near(r7.fairValueCenter, 10.73, '7.3 中枢 = BVPS 6.7062 × 理论PB锚 1.60 = 10.73（三位一体封顶）', 0.03);
    eq1(pI7.rule2.anchorCapped, true, '7.4 规则②：PB锚封顶生效');
    eq1(pI7.rule2b.floorBreached, false, '7.5 规则②b：6.62 未击穿铁底（PB 0.987 > 0.916）');
    eq1(pI7.rule3.boundaryFloorLock, true, '7.6 规则③：现价低于极端悲观价 → 锁铁底 6.14');
    ok(pI7.rule3.maxDownsidePct != null && Math.abs(Number(pI7.rule3.maxDownsidePct) - (-7.2)) < 0.4, '7.7 规则③：潜在最大下行风险 ≈ -7.2%（锁铁底后，下行有限）');
    eq1(pI7.rule4.ratingDowngraded, true, '7.8 规则④：熔断降级触发');
    ok(pI7.rule4.buyRange && Math.abs(Number(pI7.rule4.buyRange[0]) - 6.14) < 0.03 && Math.abs(Number(pI7.rule4.buyRange[1]) - 9.13) < 0.05, '7.9 规则④：买入区间 ≈ [6.14, 9.13]');
    ok(String(pI7.rule4.davisNote).indexOf('戴维斯双杀') !== -1 && String(pI7.rule4.davisNote).indexOf('2.32') !== -1, '7.10 规则④：戴维斯声明含「戴维斯双杀」与 Q3 日均 2.32 万亿');
    eq1(pI7.rule1.priceSource, 'caller-injected-live', '7.11 规则①：强同步使用注入实时价 6.62（无残留 8.51）');
  }

  // ═══════════ 8. 补丁I 红线保留：price 20.0（高估泡沫 → 仍 无法评级 红灯） ═══════════
  const r8 = await cj.run('000783', { price: 20.0, ...baseData() });
  ok(r8.ok === true, '8.1 高估场景应成功');
  if (r8.ok) {
    eq1(r8.fused, true, '8.2 现价 20.00 远高于中枢 → 熔断红灯保留（补丁I 仅降级低估，不豁免高估）');
    eq1(r8.rating, '无法评级', '8.3 高估泡沫仍锁定无法评级（红灯正确）');
  }

  console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
  if (fail) { failures.forEach(f => console.log('[FAIL] ' + f)); process.exit(1); }
})().catch(e => { console.error('测试运行异常:', e); process.exit(1); });
