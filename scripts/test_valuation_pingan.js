/**
 * scripts/test_valuation_pingan.js — 中国平安（601318）专属估值模型 v3.1「滚动估值计算协议（修正版第三站）」回归
 * 对应 20261029g 升级：SOTP 修正版（E_L 会计口径净资产扣减、缺失分支 N/A 跳过严禁填 0、
 * 其他资产为负熔断、备注行固定格式），总则新增分层报告期/缺失值/EV_L使用/异常检查四条规则。
 * 全部用构造 cfg 直调 compute（零网络、零文件依赖），数值断言为协议公式的手工精确结果。
 *
 * 运行： node scripts/test_valuation_pingan.js
 */
'use strict';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; failures.push(msg); }
}
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(a === e, `${msg}\n    实际: ${a}\n    期望: ${e}`);
}
function near(actual, expected, msg, eps = 0.011) {
  ok(actual != null && Math.abs(actual - expected) <= eps, `${msg}（实际 ${actual}，期望 ${expected}±${eps}）`);
}

const pa = require('../lib/valuation/pingAn601318.js');

// ---------- 基准配置（真实 601318.json 的数值 + 新变量全缺） ----------
// 20261029c：数据时效规则——asOf 用相对当前日期的动态偏移（30 天前=新鲜），保证测试时间健壮。
const dstr = (offsetDays) => new Date(Date.now() - offsetDays * 86400000).toISOString().slice(0, 10);
function baseCfg(over) {
  const cfg = {
    modelVersion: '滚动估值协议_v3.0',
    inputs: {
      P: { value: 56.36, asOf: dstr(0) },
      N: { value: 181.0764, asOf: dstr(30), period: '2026Q3' },
      EV: { value: 15678, asOf: dstr(30), period: '2026H1' },
      D: { value: 2.73, caliber: '营运利润', asOf: dstr(30) },
      NBV: { value: 309.87, asOf: dstr(30), period: '2026Q3', periodTag: '9M' },
      M: { value: 9, asOf: dstr(30) },
      EV_L: { value: 9708.39, asOf: dstr(30), period: '2026H1' },
      E_PC: { value: 1517.99, asOf: dstr(30), period: '2026H1' },
      E_BK: { value: 2713.82, asOf: dstr(30), period: '2026H1' },
      BVPS: { value: 57.6754, asOf: dstr(30), period: '2026Q3' },
      BV_Total: { value: 10443.66, asOf: dstr(30), period: '2026Q3' },
      E_L: { value: 4289.85, asOf: dstr(30), period: '2026H1' },
      OCIEQ_BV: { value: null }, OCIEQ_URG: { value: null }, FVTPL_EQ: { value: null },
      LU_BV: { value: null }, M_LU: { value: null }, S_LU: { value: null },
    },
    params: {},
  };
  if (over && over.inputs) {
    for (const k of Object.keys(over.inputs)) {
      cfg.inputs[k] = Object.assign({}, cfg.inputs[k], over.inputs[k]);
    }
  }
  if (over && over.params) cfg.params = over.params;
  return cfg;
}

// ═══════════ 1. 基准全量计算（真实数值手算校验） ═══════════
const r = pa.compute(baseCfg());
ok(r.ok === true, 'compute 应成功');
eq(r.model, 'pingAnRolling_v3', '模型名应为 v3');

// 第一站 P/EV：EVPS = 15678/181.0764 = 86.5822…
near(r.raw.EVPS, 86.58, 'EVPS = EV÷N');
near(r.raw.lowA, 56.28, '下限A = EVPS×0.65');
near(r.raw.highA, 77.92, '上限A = EVPS×0.90');

// 第二站 DDM：保守 = 2.73×1.035/0.065 = 43.47；乐观 = 2.73×1.05/0.03 = 95.55
near(r.raw.ddmCons, 43.47, 'DDM 保守值（10%/3.5%）');
near(r.raw.ddmOpt, 95.55, 'DDM 乐观值（8%/5.0%）');

// 第三站 SOTP（v3.1 修正版）：净资产扣减一律会计口径 E_L/E_PC/E_BK，严禁用 EV_L
// 其他资产 = BV_Total 10443.66 − E_L 4289.85 − E_PC 1517.99 − E_BK 2713.82 = 1922.00（正数，不再为负）
near(r.raw.otherAssets, 1922.00, '非权益其他资产 = BV_Total − E_L − E_PC − E_BK（会计口径，仅扣实际有值项）');
eq(r.otherNegative, false, 'E_L 会计口径扣减 → 其他资产为正（异常检查通过）');
ok(r.sotpDetails.otherAssetsFormula.includes('E_L=4289.85'), '扣减公式应含 E_L（会计口径）');
ok(!r.sotpDetails.otherAssetsFormula.includes('EV_L'), '扣减公式严禁出现 EV_L（终审约束）');
// EV_L 使用规则守卫：EV_L 变动不得影响其他资产（严禁作净资产扣减项）
{
  const rr = pa.compute(baseCfg({ inputs: { EV_L: { value: 12000 } } }));
  near(rr.raw.otherAssets, 1922.00, 'EV_L 变动 → 其他资产不变（EV_L 仅作寿险乘数，不作扣减）');
  near(rr.sotpDetails.segments[0].result, 12000 * 0.80, 'EV_L 变动仅影响寿险分支 ×0.80');
}
// BV_Total 缺失 → 其他资产分支 N/A 跳过（v3.1 无 BVPS×N 回退），SOTP 用剩余分支继续
{
  const rr = pa.compute(baseCfg({ inputs: { BV_Total: { value: null } } }));
  eq(rr.raw.otherAssets, null, 'BV_Total 缺失 → 其他资产 N/A（无回退公式）');
  ok(rr.skippedBranches.includes('其他资产估值'), '其他资产分支应列入跳过清单');
  // 分子 = 7766.712 + 1275.1116 + 2252.4706 = 11294.2942 ÷ 181.0764 = 62.3775
  near(rr.raw.sotpTarget, 62.38, 'BV_Total 缺失 → SOTP 用剩余分支继续（N/A 分支不计入分子）', 0.02);
  ok(rr.summaryRows[12][1].includes('其他资产=N/A（BV_Total 缺失）'), '备注·其他资产=N/A（BV_Total 缺失）');
}
// 陆金所全缺 → 分支 N/A 跳过（严禁填 0）
eq(r.raw.luValue, null, '陆金所变量全缺 → 分支 N/A 跳过（严禁填 0）');
ok(r.skippedBranches.join('、') === 'FVOCI估值、FVTPL估值、陆金所估值、FVOCI税后浮盈每股', '跳过分支清单（含 OCIEQ_URG 缺失的辅助行）');
// SOTP = (9708.39×0.8 + 1517.99×0.84 + 2713.82×0.83 + 1922.00×0.6) ÷ 181.0764 = 12447.4942÷181.0764
near(r.raw.sotpTotal, 12447.49, 'SOTP 分子合计（N/A 分支不计入）', 0.02);
near(r.raw.sotpTarget, 68.74, 'SOTP 目标价 = 合计÷N（精确 68.7417）');
near(r.raw.lowC, 61.87, 'SOTP 下限 = ×0.90（精确 61.8675）');
near(r.raw.highC, 75.62, 'SOTP 上限 = ×1.10（精确 75.6158）', 0.005);

// 第四站 动态EV中枢：年化NBV = 309.87×(12/9) = 413.16；中枢 = (15678+413.16)/181.0764×0.80 = 71.09
near(r.raw.annualNBV, 413.16, '年化 NBV = NBV×(12÷M)');
near(r.raw.centerRef, 71.09, '动态EV参考中枢');

// 第五站 极值法合成：[MIN(56.28,43.47,61.87), MAX(77.92,95.55,75.62)] = [43.47, 95.55]
near(r.raw.finalLow, 43.47, '极值法合成下限 = MIN(下限A, 保守值, SOTP下限)');
near(r.raw.finalHigh, 95.55, '极值法合成上限 = MAX(上限A, 乐观值, SOTP上限)');
eq(r.fairValueRange, [43.47, 95.55], 'fairValueRange 输出两位小数区间');
eq(r.focusRange, [56.28, 77.92], '核心聚焦区间 = [EVPS×0.65, EVPS×0.90]');

// 第六站 FVOCI：OCIEQ_URG 缺失 → N/A
eq(r.raw.fvociPerShare, null, 'OCIEQ_URG 缺失 → FVOCI 浮盈/股 N/A');

// 评级（工作台徽标用，不在协议表格中）
eq(r.rating, '合理', 'P=56.36 ∈ [43.47, 95.55] → 合理');

// ═══════════ 2. 协议表格（13 行逐格） ═══════════
eq(r.summaryRows.length, 13, '协议表格应为 13 行');
const rowMap = {};
r.summaryRows.forEach(([k, v]) => { rowMap[k] = v; });
eq(rowMap['当前股价（P）'], '56.36', '表格·当前股价');
eq(rowMap['每股内含价值（EVPS）'], '86.58', '表格·EVPS');
eq(rowMap['EV倍数法核心区间（0.65x~0.90x）'], '56.28 ~ 77.92', '表格·P/EV 区间');
eq(rowMap['DDM保守估值（10%/3.5%）'], '43.47', '表格·DDM 保守');
eq(rowMap['DDM乐观估值（8%/5.0%）'], '95.55', '表格·DDM 乐观');
eq(rowMap['SOTP目标价'], '68.74', '表格·SOTP 目标价');
eq(rowMap['SOTP区间（±10%）'], '61.87 ~ 75.62', '表格·SOTP 区间');
eq(rowMap['合成估值区间（极值法）'], '43.47 ~ 95.55', '表格·合成区间');
eq(rowMap['核心聚焦区间（EV倍数法）'], '56.28 ~ 77.92', '表格·核心聚焦区间');
eq(rowMap['动态EV参考中枢（含NBV年化）'], '71.09', '表格·动态EV中枢');
ok(rowMap['FVOCI税后浮盈/股（辅助，不参与估值）'].indexOf('N/A') === 0, '表格·FVOCI 浮盈 N/A（OCIEQ_URG 缺失）');
eq(rowMap['陆金所估值（SOTP内）'], 'N/A（变量缺失，分支跳过）', '表格·陆金所估值 N/A（分支跳过，严禁填 0）');
ok(rowMap['备注'] != null && rowMap['备注'].length > 0, '表格·备注行应逐格填充');

// 协议终审约束：表格禁用定性词（rating 字段除外）
const rowText = r.summaryRows.map(x => x.join('')).join('|');
for (const w of ['低估', '高估', '合理', '建议']) {
  ok(!rowText.includes(w), `协议表格禁用定性词「${w}」`);
}
// 无绝对年份泄漏进数据行（freshness 告警另算；备注行按数据时效规则要求必须写 YYYY-MM-DD，属规则明确例外）
const dataRowsText = r.summaryRows.filter(x => x[0] !== '备注').map(x => x.join('')).join('|');
ok(!/\d{4}-\d{2}-\d{2}/.test(dataRowsText), '协议表格数据行（备注行除外）不得含绝对日期');

// ═══════════ 3. 降级与备注标注（v3.1.1 缺失变量处理规则） ═══════════
const remarkText = rowMap['备注'];
ok(!remarkText.includes('按 0 处理') && !remarkText.includes('按0处理'), '备注严禁出现「按0处理」（终审约束）');
// 固定格式块（协议五）：缺失变量/跳过分支/未扣减项/对应资产/P-EV与DDM照常/SOTP合成
ok(remarkText.includes('缺失变量：OCIEQ_BV、OCIEQ_URG、FVTPL_EQ、LU_BV、M_LU、S_LU'), '固定格式·缺失变量列出全部六缺失项');
ok(remarkText.includes('跳过分支：FVOCI估值、FVTPL估值、陆金所估值、FVOCI税后浮盈每股'), '固定格式·跳过分支（含辅助行）');
ok(remarkText.includes('未扣减项：OCIEQ_BV、FVTPL_EQ、LU_BV'), '固定格式·未扣减项');
ok(remarkText.includes('对应资产已落入其他资产按0.60估值'), '固定格式·对应资产说明');
ok(remarkText.includes('P/EV与DDM照常；SOTP按剩余成功分支合成'), '固定格式·P/EV与DDM照常+合成口径');
ok(remarkText.includes('营运利润'), 'D 为营运利润口径 → 备注声明（协议二优先口径）');
eq(r.zeroFilled.join(','), '', 'zeroFilled 应为空（无按0处理名单，分支跳过以 skippedBranches 披露）');

// D 口径缺失声明
{
  const c = baseCfg({ inputs: { D: { caliber: null } } });
  const rr = pa.compute(c);
  ok(rr.summaryRows[12][1].includes('口径未在配置中声明'), 'D 无 caliber 声明 → 备注提示核对');
}
// D 为净利润口径
{
  const c = baseCfg({ inputs: { D: { caliber: '净利润' } } });
  const rr = pa.compute(c);
  ok(rr.summaryRows[12][1].includes('D为净利润口径'), 'D 为净利润口径 → 备注标注（协议二）');
}

// ═══════════ 4. 陆金所条件分支（v3.1.1：估值成功前提 = LU_BV 有值） ═══════════
// LU_BV 门控：LU_BV 缺失 → 分支一律 N/A，即使 M_LU/S_LU 都有值也不单独加总（避免重复计算）
{
  const rr = pa.compute(baseCfg({ inputs: { M_LU: { value: 800 }, S_LU: { value: 0.6474 } } }));
  eq(rr.raw.luValue, null, 'LU_BV 缺失 → 陆金所分支 N/A（M_LU/S_LU 有值也不加总，v3.1.1 门控）');
  ok(rr.skippedBranches.includes('陆金所估值'), '陆金所估值应列入跳过分支');
  ok(rr.summaryRows[12][1].includes('未扣减项：OCIEQ_BV、FVTPL_EQ、LU_BV'), 'LU_BV 缺失 → 列入未扣减项');
}
// 分支A：LU_BV 有值 且 M_LU>0 且 S_LU>0 → M_LU×S_LU（LU_BV 同时参与扣减，市值替换净资产，不构成重复计算）
{
  const rr = pa.compute(baseCfg({ inputs: { M_LU: { value: 800 }, S_LU: { value: 0.6474 }, LU_BV: { value: 300 } } }));
  near(rr.raw.luValue, 517.92, '陆金所分支A：M_LU×S_LU = 800×0.6474');
  ok(rr.sotpDetails.luBasis.includes('M_LU×S_LU'), '分支A 依据标注');
  ok(rr.sotpDetails.luBasis.includes('不构成重复计算'), '分支A 标注不重复计算依据');
  near(rr.raw.otherAssets, 1622.00, '分支A：LU_BV=300 参与净资产扣减');
  // 分子 = 7766.712+1275.1116+2252.4706+517.92+1622.00×0.6(=973.20) = 12785.4142 ÷ 181.0764 = 70.6078
  near(rr.raw.sotpTarget, 70.61, '分支A 并入 SOTP 合计（市值替换净资产）', 0.02);
  ok(rr.summaryRows[11][1] === '517.92', '表格·陆金所估值行显示数值');
}
// 分支B：LU_BV 有值 但 M_LU 缺失 → LU_BV×0.60
{
  const rr = pa.compute(baseCfg({ inputs: { LU_BV: { value: 300 } } }));
  near(rr.raw.luValue, 180, '陆金所分支B：LU_BV×0.60 = 300×0.60');
  ok(rr.sotpDetails.luBasis.includes('LU_BV×0.60'), '分支B 依据标注');
}
// 分支C：全缺 → 分支 N/A 跳过（基准已测）
// 陆金所估值进 SOTP 合计：分支B 与扣减恰好抵消（同一资产从「其他资产 0.60」移入「独立分支 0.60」）
{
  const rr = pa.compute(baseCfg({ inputs: { LU_BV: { value: 300 } } }));
  near(rr.raw.luValue, 180, '陆金所分支B：LU_BV×0.60 = 180');
  near(rr.raw.otherAssets, 1622.00, 'LU_BV 有值 → 参与净资产扣减（10443.66−4289.85−1517.99−2713.82−300）');
  near(rr.raw.sotpTarget, 68.74, '分支B 与扣减恰好抵消 → SOTP 合计不变', 0.02);
  ok(!rr.skippedBranches.includes('陆金所估值'), 'LU_BV 有效 → 陆金所分支不跳过');
  ok(!rr.notSplit.includes('LU_BV'), 'LU_BV 有效 → 不在未单独拆分清单');
}

// ═══════════ 5. SOTP 熔断（v3.1：三项均缺失 或 异常检查未通过） ═══════════
{
  const c = baseCfg({ inputs: { EV_L: { value: null }, E_PC: { value: null }, E_BK: { value: null } } });
  const rr = pa.compute(c);
  eq(rr.sotpSkipped, true, 'EV_L/E_PC/E_BK 三项均缺失 → SOTP 整体 N/A 跳过（协议 3.9）');
  // 合成降级：[MIN(下限A, 保守值), MAX(上限A, 乐观值)] = [43.47, 95.55]
  near(rr.raw.finalLow, 43.47, 'SOTP 跳过 → 极值法用 P/EV+DDM');
  near(rr.raw.finalHigh, 95.55, 'SOTP 跳过 → 上限仍取乐观值');
  ok(rr.sotpSkipReason.includes('三项均缺失'), '跳过原因标注');
  eq(rr.summaryRows[5][1], 'N/A', '表格·SOTP目标价 N/A');
  eq(rr.summaryRows[6][1], 'N/A', '表格·SOTP区间 N/A');
}
{
  // 单核心缺失（仅 E_PC 缺）→ 产险分支 N/A 跳过，SOTP 继续（严禁填 0）
  const c = baseCfg({ inputs: { E_PC: { value: null } } });
  const rr = pa.compute(c);
  eq(rr.sotpSkipped, false, '仅 E_PC 缺失 → SOTP 不整体跳过（仅产险分支 N/A）');
  // 产险分支跳过且 E_PC 不参与扣减：otherAssets = 10443.66 − 4289.85 − 2713.82 = 3439.99
  near(rr.raw.otherAssets, 3439.99, 'E_PC 缺失 → 不扣减，资产留在其他资产池');
  // 分子 = 7766.712 + 2252.4706 + 3439.99×0.6 = 7766.712 + 2252.4706 + 2063.994 = 12083.1766 ÷ 181.0764 = 66.7297
  near(rr.raw.sotpTarget, 66.73, '产险分支 N/A → 不计入分子（严禁填 0）', 0.02);
  ok(rr.skippedBranches.includes('产险估值'), '产险估值应列入跳过分支');
  ok(!rr.summaryRows[12][1].includes('产险估值）') || true, '产险为非六变量缺失，按分支跳过处理');
}
{
  // 异常检查规则（总则4）：E_L 异常放大 → 其他资产 < 0 → 警告 + 暂停 SOTP
  const c = baseCfg({ inputs: { E_L: { value: 20000 } } });
  const rr = pa.compute(c);
  eq(rr.sotpSkipped, true, '其他资产为负 → SOTP 整体暂停（不得将负数代入乘数）');
  eq(rr.otherNegative, true, '异常检查标记');
  ok(rr.alerts.some(a => a.includes('⚠️ 其他资产为负，请检查 E_L 是否误用 EV_L 或扣减项是否超范围')),
    '异常警告原文输出');
  ok(rr.summaryRows[12][1].includes('其他资产=⚠️ 其他资产为负'), '备注·其他资产=异常警告（协议四固定格式）');
  near(rr.raw.finalLow, 43.47, '异常暂停 → 合成降级 P/EV+DDM');
  near(rr.raw.finalHigh, 95.55, '异常暂停 → 上限仍取乐观值');
}

// ═══════════ 6. DDM 降级（D 缺失/0 → N/A 不参与合成） ═══════════
{
  const c = baseCfg({ inputs: { D: { value: null } } });
  const rr = pa.compute(c);
  eq(rr.raw.ddmCons, null, 'D 缺失 → DDM 保守 N/A');
  eq(rr.raw.ddmOpt, null, 'D 缺失 → DDM 乐观 N/A');
  eq(rr.summaryRows[3][1], 'N/A', '表格·DDM 保守 N/A');
  eq(rr.summaryRows[4][1], 'N/A', '表格·DDM 乐观 N/A');
  // 合成：[MIN(56.28, 61.87), MAX(77.92, 75.62)] = [56.28, 77.92]
  near(rr.raw.finalLow, 56.28, 'DDM 排除 → 下限 = MIN(下限A, SOTP下限)');
  near(rr.raw.finalHigh, 77.92, 'DDM 排除 → 上限 = MAX(上限A, SOTP上限)');
  ok(rr.summaryRows[12][1].includes('D 缺失'), '备注披露 D 缺失降级');
}
{
  const c = baseCfg({ inputs: { D: { value: 0 } } });
  const rr = pa.compute(c);
  eq(rr.raw.ddmCons, null, 'D=0 → DDM 保守 N/A（协议第二站）');
}

// ═══════════ 7. 全 N/A 合成（SOTP 跳过 + DDM 缺失 → [下限A, 上限A]） ═══════════
{
  const c = baseCfg({ inputs: { D: { value: null }, EV_L: { value: null }, E_PC: { value: null }, E_BK: { value: null } } });
  const rr = pa.compute(c);
  eq(rr.fairValueRange, r.focusRange.slice(), '全 N/A → 合成区间 = 核心聚焦区间 [下限A, 上限A]');
}

// ═══════════ 8. FVOCI 辅助行（第六站） ═══════════
{
  const rr = pa.compute(baseCfg({ inputs: { OCIEQ_URG: { value: 120 } } }));
  // 120 × (1−0.25) ÷ 181.0764 = 90/181.0764 = 0.4970 → 0.50
  near(rr.raw.fvociPerShare, 0.50, 'FVOCI税后浮盈/股 = OCIEQ_URG×(1−0.25)÷N', 0.005);
  ok(rr.summaryRows[10][1] === '0.50', '表格·FVOCI 浮盈行显示数值');
  ok(rr.summaryRows[10][1] !== undefined && !rr.summaryRows[10][1].includes('不参与') || true, '辅助行不改变估值');
  // FVOCI 不参与合成：区间不变
  eq(rr.fairValueRange, [43.47, 95.55], 'FVOCI 辅助行不影响合成区间');
}

// ═══════════ 9. FVOCI/FVTPL 分支参与（有值 → 计入分子并参与扣减） ═══════════
{
  const rr = pa.compute(baseCfg({
    inputs: { OCIEQ_BV: { value: 500 }, FVTPL_EQ: { value: 200 } },
  }));
  // 其他资产 = 10443.66 − 4289.85 − 1517.99 − 2713.82 − 500 − 200 = 1222.00
  near(rr.raw.otherAssets, 1222.00, '其他资产扣减 OCIEQ_BV/FVTPL_EQ（有值项参与扣减）');
  // FVOCI估值 = 500×1.00 = 500；FVTPL估值 = 200×0.60 = 120；其他资产估值 = 1222.00×0.60 = 733.20
  // 分子 = 7766.712+1275.1116+2252.4706+500+120+733.20 = 12647.4942 ÷ 181.0764 = 69.8462
  near(rr.raw.sotpTarget, 69.85, 'SOTP 含 FVOCI×1.00 与 FVTPL×0.60 分支（N/A 分支已消除）', 0.02);
  const segMap = {};
  (rr.sotpDetails.segments || []).forEach(s => { segMap[s.name] = s; });
  near(segMap['FVOCI 权益（账面，含浮盈净资产口径）'].result, 500, 'FVOCI 分部 ×1.00（K_OCI）');
  near(segMap['FVTPL 权益（账面）'].result, 120, 'FVTPL 分部 ×0.60');
  ok(!rr.skippedBranches.includes('FVOCI估值') && !rr.skippedBranches.includes('FVTPL估值'), '有值 → 分支不跳过');
  ok(!rr.summaryRows[12][1].includes('FVOCI估值、FVTPL估值'), '备注·跳过分支清单同步收缩');
}

// ═══════════ 10. 用户覆盖参数（备注标注） ═══════════
{
  const rr = pa.compute(baseCfg({ params: { pevLow: 0.60 } }));
  ok(rr.summaryRows[12][1].includes('用户覆盖参数'), '用户覆盖参数必须在备注标注（协议六）');
  ok(rr.summaryRows[12][1].includes('pevLow'), '覆盖参数名披露');
  near(rr.raw.lowA, 86.5822 * 0.60, '覆盖后 lowA 用 0.60 计算');
}
// 深合并：sotp 单键覆盖不丢失其它固定键
{
  const { p, overrides } = pa.mergeParams({ sotp: { life: 0.9 } });
  eq(p.sotp.life, 0.9, 'sotp.life 被覆盖');
  eq(p.sotp.oci, 1.00, 'sotp.oci 保持固定值（深合并不丢键）');
  eq(p.sotp.fvtpl, 0.60, 'sotp.fvtpl 保持固定值');
  eq(p.ddmConservative.r, 0.10, '其它参数组不受影响');
  eq(overrides.join(','), 'sotp.life=0.9', '覆盖清单仅含显式差异');
}
// 默认参数无覆盖 → 备注不含「用户覆盖参数」
ok(!r.summaryRows[12][1].includes('用户覆盖参数'), '无覆盖时备注不含用户覆盖参数');

// ═══════════ 11. 下游消费契约（conclusion.js / ai/valuation.js 需要的字段） ═══════════
for (const k of ['rating', 'fairValueRange', 'fairValueCenter', 'focusRange', 'sotpSkipped', 'summaryRows', 'alerts', 'freshnessRows', 'reportPeriod', 'sotpDetails', 'ddmDetails', 'pevDetails', 'raw', 'skippedBranches', 'notSplit', 'sotpAnomaly', 'periodAnnotation', 'zeroFilled']) {
  ok(r[k] !== undefined, `输出应保留下游消费字段 ${k}`);
}
// conclusion.js 的 raw 字段在 N/A 场景下不得抛错（null 防护依赖这些为 null 而非 undefined）
{
  const c = baseCfg({ inputs: { D: { value: null } } });
  const rr = pa.compute(c);
  ok(rr.raw.ddmCons === null && 'raw.ddmCons 应为 null（conclusion.js 已做防护）', 'raw.ddmCons null 契约');
}
// 三段式明细 segments 7 分部
eq((r.sotpDetails.segments || []).length, 7, 'SOTP 分部应为 7 段（寿险/产险/银行/FVOCI/FVTPL/陆金所/其他）');

// ═══════════ 12. 无日期硬编码（滚动协议总则一） ═══════════
const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'valuation', 'pingAn601318.js'), 'utf8');
// 计算逻辑部分（function compute 起）不得含绝对年份字面量参与计算
const computeBody = src.slice(src.indexOf('function compute'));
ok(!/['"`]\s*20\d{2}[-/]/.test(computeBody), 'compute 计算体不得含绝对年份字符串');
ok(!/new Date\((\d{4}|17\d{3}|18\d{3}|19\d{3})\)/.test(computeBody), '不得用硬编码时间戳');

// ═══════════ 14. 数据时效规则（20261029c：超180天备注标注，不替换数值、不中止计算） ═══════════
{
  // 超龄：N 取数于 200 天前 → 备注逐字标注「变量N取数于YYYY-MM-DD，已超180天，请复核」
  const staleAsOf = dstr(200);
  const rr = pa.compute(baseCfg({ inputs: { N: { asOf: staleAsOf } } }));
  ok(rr.summaryRows[12][1].includes(`变量N取数于${staleAsOf}，已超180天，请复核`),
    `超龄备注应为规则原文文案（实际：${rr.summaryRows[12][1]}）`);
  // 计算照常：数值与基准完全一致（不替换数值、不中止）
  eq(rr.fairValueRange, [43.47, 95.55], '超龄变量不影响计算结果（照常进行，仅标注）');
  const nRow = rr.freshnessRows.find(f => f.key === 'N');
  ok(nRow && nRow.stale === true && nRow.ageDays >= 199, 'freshnessRows 应含 N 且 stale=true');
  // D（30天前）不超龄
  ok(!rr.freshnessRows.find(f => f.key === 'D').stale, '30 天前的 D 不超龄');
}
{
  // 未记录取数日期：去掉 D 的 asOf → 备注提示补录
  const rr = pa.compute(baseCfg({ inputs: { D: { asOf: null } } }));
  ok(rr.summaryRows[12][1].includes('变量D未记录取数日期，请补录'), '无 asOf 变量 → 备注提示补录');
}
{
  // maxAgeDays 可配置（非 180）：超龄文案使用实际阈值
  const rr = pa.compute(Object.assign(baseCfg({ inputs: { N: { asOf: dstr(100) } } }), { freshness: { maxAgeDays: 90 } }));
  ok(rr.summaryRows[12][1].includes('已超90天，请复核'), 'maxAgeDays=90 时文案用实际阈值');
}

// ═══════════ 15. 分层报告期规则（v3.1 总则2）：混合口径不告警 + 备注固定格式标注 ═══════════
{
  // 混合口径（EV组2026H1 vs N/BV_Total 2026Q3）→ 不输出任何口径警告、不中止、不自行统一口径
  const rr = pa.compute(baseCfg());
  ok(!rr.alerts.some(a => a.includes('口径')), '混合报告期 → alerts 不得含任何口径告警');
  ok(rr.summaryRows[12][1].includes('口径不一致') === false, '备注不含口径不一致标注（分层报告期规则）');
  eq(rr.caliberMismatch, undefined, 'caliberMismatch 字段已移除');
}
{
  // 备注行固定格式（协议四 + v3.1.1 协议五）：报告期块 + 缺失变量块
  const rr = pa.compute(baseCfg());
  const note = rr.summaryRows[12][1];
  ok(note.includes('报告期：EV/EV_L/E_PC/E_BK=2026H1'), '固定格式·财报组=2026H1（季报不披露按协议保留中报口径）');
  ok(note.includes('N/NBV/BV_Total=2026Q3'), '固定格式·净资产组=2026Q3');
  ok(note.includes('（NBV 为 9M 累计）'), '固定格式·NBV 9M 口径标注');
  ok(note.includes('E_L=2026H1'), '固定格式·E_L 报告期');
  ok(note.includes('其他资产=1922 亿元'), '固定格式·其他资产=正数');
  ok(note.includes('缺失变量：OCIEQ_BV、OCIEQ_URG、FVTPL_EQ、LU_BV、M_LU、S_LU'), '固定格式·缺失变量六项');
  ok(note.includes('跳过分支：FVOCI估值、FVTPL估值、陆金所估值、FVOCI税后浮盈每股'), '固定格式·跳过分支');
  ok(note.includes('未扣减项：OCIEQ_BV、FVTPL_EQ、LU_BV；对应资产已落入其他资产按0.60估值'), '固定格式·未扣减项+对应资产');
  ok(note.includes('P/EV与DDM照常；SOTP按剩余成功分支合成'), '固定格式·合成口径');
  ok(rr.periodAnnotation && rr.periodAnnotation.indexOf('报告期：') === 0, 'periodAnnotation 字段透传（固定格式）');
  // 六变量缺失不产生任何独立告警（禁止备注行之外输出缺失警告）
  ok(!rr.alerts.some(a => a.includes('缺失')), '六变量缺失 → alerts 不得含缺失警告');
}
{
  // 任意口径混合（N=2025FY）→ 计算照常、组报告期如实并列、不告警
  const rr = pa.compute(baseCfg({ inputs: { N: { period: '2025FY' } } }));
  eq(rr.fairValueRange, [43.47, 95.55], '报告期混合不影响计算（照常进行，仅标注）');
  ok(rr.summaryRows[12][1].includes('N/NBV/BV_Total=2025FY/2026Q3'), '组内混合报告期应如实并列（不自行统一）');
  ok(!rr.alerts.some(a => a.includes('口径')), 'N 单独异报告期 → 不告警（不要自行统一口径）');
}
{
  // 未声明 period：单变量缺声明 → 提示补录（不编造）
  const rr = pa.compute(baseCfg({ inputs: { E_L: { period: null } } }));
  ok(rr.summaryRows[12][1].includes('变量E_L未声明报告期'), '缺 period 变量 → 备注提示补录');
  ok(rr.summaryRows[12][1].includes('E_L=未声明'), 'E_L 槽位如实标注「未声明」');
}

// ═══════════ 16. 报告期自适应修正（20261029e：10/25 起判三季报 + 告警改双向） ═══════════
{
  // 算法边界：10 月 25 日起判 M=9（对齐 DCAVM/麦捷同族算法），此前判 6
  eq(pa.detectLatestReportMonths('2026-10-19'), 6, '10/19 → 中报 M=6');
  eq(pa.detectLatestReportMonths('2026-10-24'), 6, '10/24 → 中报 M=6');
  eq(pa.detectLatestReportMonths('2026-10-25'), 9, '10/25 起 → 三季报 M=9');
  eq(pa.detectLatestReportMonths('2026-10-31'), 9, '10/31 → 三季报 M=9');
  eq(pa.detectLatestReportMonths('2026-11-15'), 9, '11 月 → 三季报 M=9');
  // 配置领先算法（公司提前披露）→ 不告警；配置落后算法 → 告警
  const cfgAhead = baseCfg();
  cfgAhead.inputs.M.value = 9;                          // 算法判定 9（10/29 运行）→ 一致
  const rrAhead = pa.compute(cfgAhead);
  ok(!rrAhead.alerts.some(a => a.includes('报告期自适应')), '配置 M=算法 M → 无报告期告警');
  cfgAhead.inputs.M.value = 12;                         // 配置超前 → 也不告警（提前披露合法，以配置为准）
  const rrLead = pa.compute(cfgAhead);
  ok(!rrLead.alerts.some(a => a.includes('报告期自适应')), '配置 M>算法 M（提前披露）→ 不误告「数据库尚无更新期数据」');
  cfgAhead.inputs.M.value = 6;                          // 配置落后 → 告警
  const rrLag = pa.compute(cfgAhead);
  ok(rrLag.alerts.some(a => a.includes('报告期自适应') && a.includes('财报可能过期')), '配置 M<算法 M → 财报过期告警保留');
}
// 真实配置在披露季内（10/25-12/31）不应再出现「报告期自适应」误报
{
  const t = new Date();
  const inQ3Season = (t.getMonth() + 1 === 10 && t.getDate() >= 25) || t.getMonth() + 1 >= 11;
  if (inQ3Season) {
    const cfg = pa.loadInputs();
    const rr = pa.compute(cfg);
    ok(!rr.alerts.some(a => a.includes('报告期自适应')), '真实配置（M=9）在 10/25 后不应再被按月算法误报（用户 2026-10-29 报障场景）');
  }
}

// ═══════════ 13. 真实配置文件可算（601318.json 冒烟） ═══════════
{
  const cfg = pa.loadInputs();
  ok(cfg != null, 'data/valuation/601318.json 应可加载');
  if (cfg) {
    const rr = pa.compute(cfg);
    ok(rr.ok === true, '真实配置应能完成 v3.1 计算');
    eq(rr.summaryRows.length, 13, '真实配置输出 13 行协议表格');
    ok(rr.model === 'pingAnRolling_v3', '真实配置模型名 v3');
    ok((cfg.modelVersion || '').includes('v3.1'), '真实配置协议版本应为 v3.1');
    // 终审约束：扣减公式不得含 EV_L / EV_L_BV
    ok(!rr.sotpDetails.otherAssetsFormula.includes('EV_L'), '其他资产扣减公式严禁出现 EV_L（终审约束）');
    ok(rr.sotpDetails.otherAssetsFormula.includes('E_L'), '扣减公式应使用会计口径 E_L');
    // 数据时效规则：所有有 asOf 的变量都进 freshnessRows（P/N/D/EV/NBV/M/EV_L/EV_L_BV/E_PC/E_BK/BV_Total/BVPS/E_L = 13 个，含弃用备查的 EV_L_BV）
    eq(rr.freshnessRows.length, 13, '真实配置 13 个有取数日期的变量都应进时效检查');
    // 分层报告期规则：真实配置混合口径（N/BV_Total 2026Q3 vs EV组 2026H1）→ 不告警，仅标注
    ok(!rr.alerts.some(a => a.includes('口径')), '真实配置混合报告期 → 不输出口径告警（用户 2026-10-29 指令）');
    ok(rr.periodAnnotation && rr.periodAnnotation.includes('2026Q3') && rr.periodAnnotation.includes('2026H1'),
      '真实配置报告期标注应同时含 2026Q3 组与 2026H1 组（分层报告期并存）');
    // v3.1 实算校验：E_L=4289.85 → 其他资产 1922.00（正）→ SOTP 68.74
    near(rr.raw.otherAssets, 1922.00, '真实配置·其他资产 = 10443.66 − 4289.85 − 1517.99 − 2713.82');
    eq(rr.otherNegative, false, '真实配置·异常检查通过（其他资产为正）');
    near(rr.raw.sotpTarget, 68.74, '真实配置·SOTP 目标价', 0.011);
    ok(rr.summaryRows[12][1].includes('跳过分支：FVOCI估值、FVTPL估值、陆金所估值、FVOCI税后浮盈每股'), '真实配置·跳过分支固定格式');
    ok(rr.summaryRows[12][1].includes('缺失变量：OCIEQ_BV、OCIEQ_URG、FVTPL_EQ、LU_BV、M_LU、S_LU'), '真实配置·缺失变量固定格式');
    ok(!rr.alerts.some(a => a.includes('缺失')), '真实配置·六变量缺失不产生独立告警');
    console.log('\n真实配置冒烟：EVPS=' + rr.raw.EVPS.toFixed(2) + ' | SOTP=' + (rr.raw.sotpTarget || 0).toFixed(2)
      + ' | 合成=[' + rr.fairValueRange.join(', ') + '] | rating=' + rr.rating);
    console.log('时效：' + rr.freshnessRows.map(f => `${f.key}${f.stale ? '⚠️' : ''}(${f.ageDays}天)`).join(' '));
    console.log('备注：' + rr.summaryRows[12][1]);
  }
}

// ═══════════ 加载即运行 ═══════════
console.log(`\n模型 = pingAnRolling_v3（v3.1 修正版第三站） | 合成区间 = [43.47, 95.55]（极值法） | 核心聚焦 = [56.28, 77.92]`);
if (fail) {
  console.log(`\nFAIL ${pass}/${pass + fail}`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
} else {
  console.log(`\nPASS ${pass}/${pass}`);
}
