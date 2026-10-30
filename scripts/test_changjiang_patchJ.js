// 测试长江证券（000783）专属估值模型【补丁J · 全量数据一致性审计与文本强制对齐】
// 手法：构造三表直调 run（statements/balanceQuarterly 注入，零网络），断言四条一致性规则。
// 规则① 动态锚全局统一替换为封顶后 1.60（严禁「标签 1.83 / 结果 10.74」割裂）
// 规则② 计算等式强校验（拒绝睁眼瞎：公式值 ≠ 锁死值时如实描述，不强行画等号）
// 规则③ 情景设定逻辑校验（消除倒挂：中枢 > 长周期均值锚 → 乐观复苏失效转均值回归底线）
// 规则④ 熔断与状态说明清洗（无遗留「PB锚1.83倍」「以动态锚为准」；红灯/降级提示引用最新有效锚 1.60）
const cj = require('../lib/valuation/changjiang000783.js');

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); failures.push(name); }
}
const r2 = (x) => Math.round(Number(x) * 100) / 100;

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
  const dump = (r) => JSON.stringify(r);

  // ═══════════ 价格 8.6：基准态（不触发铁底锁死） ═══════════
  const r1 = await cj.run('000783', { price: 8.6, ...baseData() });
  ok(r1 && r1.ok === true, 'J0 基准运行应成功');
  if (!r1.ok) { console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`); failures.forEach(f => console.log('[FAIL] ' + f)); process.exit(1); }
  const center = r1.fairValueCenter;            // ≈ 10.73~10.74
  const blob1 = dump(r1);
  const fp1 = r1.fairPB;

  console.log('\n===== 补丁J·规则① 动态锚全局统一替换为 1.60 =====');
  ok(fp1.anchorRaw === 1.83, 'J1.1 原始动态PB锚 = 1.83（含牛市溢价，仅作背景参照）');
  ok(fp1.anchor === 1.60 && fp1.anchorCapped === true, 'J1.2 封顶后有效PB锚 = 1.60（理论PB锚，三位一体向下约束生效）');
  ok(r1.sensRows.some(x => String(x.label).indexOf('PB 动态锚（封顶后）') !== -1 && String(x.label).indexOf('1.60') !== -1), 'J1.3 敏感性看板使用封顶后 1.60（非 1.83）');
  ok(r1.coreRows.some(x => String(x.label).indexOf('理论PB') !== -1 && String(x.value).indexOf('1.60') !== -1), 'J1.4 理论PB核心行显示 1.60');
  ok(r1.coreRows.some(x => String(x.label).indexOf('市场快照') !== -1 && String(x.value).indexOf('1.60') !== -1), 'J1.5 市场快照使用 1.60');
  ok(blob1.indexOf('动态锚 1.83 倍突破上轨 → 估值体系重构警告（ROE质变，以动态锚为准）') === -1, 'J1.6 无「标签1.83/以动态锚为准」独立旧提示');
  ok(blob1.indexOf('当前模型有效锚 = 1.60') !== -1, 'J1.7 全文统一引用「当前模型有效锚 = 1.60」');

  console.log('\n===== 补丁J·规则② 计算等式强校验（拒绝睁眼瞎） =====');
  const rows1 = r1.matrixRows || [];
  const ep1 = rows1.find(x => String(x.method).indexOf('极端悲观') === 0);
  ok(!!ep1, 'J2.1 极端悲观行存在');
  const expLow = r2(center * 0.75);
  ok(new RegExp(`基准\\s*${center.toFixed(2)}\\s*[×x*]\\s*0\\.75\\s*=\\s*${expLow.toFixed(2)}`).test(String(ep1.note)), `J2.2 极端悲观公式值 = 基准 ${center.toFixed(2)} × 0.75 = ${expLow.toFixed(2)}（真实成立）`);
  ok(String(ep1.note).indexOf('铁底') === -1, 'J2.3 基准态（未锁铁底）说明不含「铁底价」强行等号');

  // 价格 6.62：触发补丁I 铁底锁死
  const r2b = await cj.run('000783', { price: 6.62, ...baseData() });
  ok(r2b && r2b.ok === true, 'J2.4 铁底场景运行应成功');
  const rows2 = r2b.matrixRows || [];
  const ep2 = rows2.find(x => String(x.method).indexOf('极端悲观') === 0);
  const expLow2 = r2(center * 0.75);
  ok(new RegExp(`基准\\s*${center.toFixed(2)}\\s*[×x*]\\s*0\\.75\\s*=\\s*${expLow2.toFixed(2)}`).test(String(ep2.note)), `J2.5 铁底场景仍如实写出公式值 = 基准 ${center.toFixed(2)} × 0.75 = ${expLow2.toFixed(2)}`);
  ok(String(ep2.note).indexOf('铁底价 ¥6.14') !== -1, 'J2.6 铁底场景如实声明「最终锁定为铁底价 ¥6.14」（≠ 强行 8.06）');
  ok(String(ep2.note).indexOf('最终锁定') !== -1, 'J2.7 铁底场景按最终锁死结果叙事（非强行画等号）');

  console.log('\n===== 补丁J·规则③ 情景设定逻辑校验（消除倒挂） =====');
  const g = r1.patchG || {};
  ok(g.recovery && g.recovery.inverted === true, 'J3.1 主模型中枢 > 长周期均值锚 → 复苏情景倒挂 inverted=true');
  ok(g.recovery && g.recovery.label === '均值回归底线', 'J3.2 标签转为「均值回归底线」（非乐观复苏）');
  ok(g.recovery && Math.abs(g.recovery.price - 8.92) < 0.02, 'J3.3 均值回归底线价 = BVPS 6.71 × 1.33 ≈ ¥8.92');
  const comp1 = rows1.find(x => String(x.method).indexOf('综合结论') === 0);
  ok(comp1 && String(comp1.note).indexOf('均值回归底线') !== -1, 'J3.4 综合结论行使用「均值回归底线」');
  ok(comp1 && String(comp1.note).indexOf('乐观复苏情景') === -1, 'J3.5 综合结论行无「乐观复苏情景」倒挂文案');
  ok(comp1 && String(comp1.note).indexOf('低于主模型中枢') !== -1, 'J3.6 综合结论行标注「低于主模型中枢，转为下行保护参考」');

  console.log('\n===== 补丁J·规则④ 熔断与状态说明清洗 =====');
  ok(blob1.indexOf('以动态锚为准') === -1, 'J4.1 全文无遗留「以动态锚为准」提示');
  const rl4 = (r1.riskLights || []).find(x => String(x.label).indexOf('第四法则') !== -1);
  ok(rl4 && String(rl4.light).indexOf('当前模型有效锚 = 1.60') !== -1, 'J4.2 红灯（第四法则双轨防御）引用最新有效锚 1.60');
  ok(r1.coreRows.some(x => String(x.label).indexOf('第四法则·动态PB锚') !== -1 && String(x.value).indexOf('1.60') !== -1 && String(x.value).indexOf('封顶') !== -1), 'J4.3 核心行「第四法则·动态PB锚」显示封顶后 1.60 并含封顶说明');
  const warnRow = rows1.find(x => String(x.method).indexOf('估值体系重构警告') !== -1);
  ok(warnRow && String(warnRow.note).indexOf('当前模型有效锚 = 1.60') !== -1, 'J4.4 重构警告行引用当前有效锚 1.60（非原始 1.83）');
  ok(blob1.indexOf('PB锚1.83倍') === -1, 'J4.5 无历史遗留「PB锚1.83倍」字眼');

  console.log(`\n===== 补丁J 汇总：${pass} 通过 / ${fail} 失败 =====`);
  if (fail) { failures.forEach(f => console.log('[FAIL] ' + f)); process.exit(1); }
})().catch(e => { console.error('测试运行异常:', e); process.exit(1); });
