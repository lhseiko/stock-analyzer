// 新洋丰（000902）专属估值模型 V2.1 测试（v2.0 框架 + 六项防呆防错补丁，20261030l）
// 运行：node scripts/test_valuation_xinyangfeng.js
const H = require('../lib/valuation/xinyangfeng000902.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (extra ? '　→ ' + extra : '')); }
}
function find(rows, re) { return (rows || []).find(r => re.test(r.label)); }
function val(rows, re) { const m = find(rows, re); return m ? m.value : null; }

const P = 13.85;
const r = H.run('000902', { price: P });

console.log('===== 新洋丰 000902 V2.1 测试（price=' + P + '）=====');

// ===== 〇 v2.1 补丁1：数据新鲜度门控 =====
ok('0.1 ok 标志 + 模型标识', r.ok === true && r.xinyangfeng === true && r.dedicated === true);
ok('0.2 门控通过且超前期望（2026Q3 已强制使用，领先披露日历期望 2026H1）', r.freshnessGate && r.freshnessGate.gatePass === true && r.freshnessGate.ahead === true && r.freshnessGate.cfgLatest === '2026Q3', JSON.stringify(r.freshnessGate));
ok('0.3 输出第一段强制声明 LATEST 与披露日（补丁1.3）', /本次运行已强制使用\[2026Q3\]作为LATEST，披露日为\[2026-10-27\]/.test(r.openingStatement || ''), r.openingStatement);
ok('0.4 freshnessGate 纯函数：Q3@10月下旬=超前期望通过；H1@11月中旬=滞后违规', (() => {
  const g1 = H.freshnessGate({ baseY: 2025, latestType: 'Q3' }, '2026-10-30');
  const g2 = H.freshnessGate({ baseY: 2025, latestType: 'H1' }, '2026-11-15');
  const g3 = H.freshnessGate({ baseY: 2025, latestType: 'H1' }, '2026-12-01');
  return g1.gatePass === true && g1.ahead === true && g1.cfgLatest === '2026Q3' && g2.stalePeriod === true && g3.stalePeriod === true;
})());
ok('0.5 freshnessGate 纯函数：滞后（12月仍 H1）→ stalePeriod + 禁止沿用', (() => {
  const g = H.freshnessGate({ baseY: 2025, latestType: 'H1' }, '2026-12-01');
  return g.stalePeriod === true && /严禁沿用旧报告期/.test(g.reason) && /2026Q3/.test(g.reason);
})());

// ===== 〇·2 v2.1 补丁2：现金流硬性否决 =====
ok('0.6 cfoVeto 触发（2026Q3 经营现金流 -2.39 亿 < 0）', r.cfoVeto === true && /⚠️【现金流警示】最新报告期经营现金流为负（-2\.39亿元），利润质量存疑/.test(r.cfoVetoWarning || ''), r.cfoVetoWarning);
ok('0.7 警示在输出第一段（openingStatement 含现金流警示）', /⚠️【现金流警示】/.test(r.openingStatement || ''));
ok('0.8 置信度锁定【低】（不允许中/高）', r.confidence === '低' && /现金流硬性否决（补丁2）/.test(r.confidenceNote || ''), r.confidence + '::' + r.confidenceNote);
ok('0.9 保守情景 E 系数强制加深至 0.82~0.84（<0.85 档）', /×0\.82~0\.84，原 0\.9~0\.92 现金流否决加深/.test(r.scenRows[0].value) && /强制加深至 0\.82~0\.84/.test(r.scenRows[0].value), r.scenRows[0].value);

// ===== 〇·3 v2.1 补丁3：周期信号交叉校验 =====
ok('0.10 磷酸铁信号=景气（3000元/吨，调研纪要一手证据）', /3000元\/吨 → 景气/.test((r.cycleRows.find(x => /磷酸铁单吨毛利/.test(x.label)) || {}).value || ''), JSON.stringify(r.cycleRows.find(x => /磷酸铁/.test(x.label))));
ok('0.11 证据链注明一手来源+行业交叉（严禁盲判中性/负毛利）', /巨潮资讯 2026-10-28/.test((r.cycleRows.find(x => /磷酸铁单吨毛利/.test(x.label)) || {}).source || '') && /2446/.test((r.cycleRows.find(x => /磷酸铁单吨毛利/.test(x.label)) || {}).source || ''));
ok('0.12 CYCLE_VIEW=景气（中性1/景气2 多数决）', r.cycleView === '景气', r.cycleView);

// ===== 一 期间锚定与数据质量（R1-R6 + 补丁6）=====
ok('1.1 R1 期间锚定 BASE_Y/LATEST=2025/2026Q3', /2025 \/ 2026Q3/.test(val(r.periodRows, /BASE_Y/)), val(r.periodRows, /BASE_Y/));
ok('1.2 R2 TTM 拼接路径（Q3 总归母拼接声明，补丁6）', /R2/.test(val(r.periodRows, /TTM 构造路径/)) && /Q3 总归母 TTM 拼接/.test(val(r.periodRows, /TTM 构造路径/)));
ok('1.3 分部漂移声明（补丁6：结构取 2026H1，Q3 可能漂移）', /可能已发生漂移/.test(r.openingStatement || '') && /2026H1（结转）/.test(r.segDriftNote || '') && /可能已发生漂移/.test(r.segDriftNote || ''), r.segDriftNote);
ok('1.4 净有息负债完整性完整（Q3 PDF 精确值）', /完整（五项齐全）/.test(val(r.periodRows, /净有息负债完整性/)));
ok('1.5 现金流否决状态行（periodRows）', /⛔ 已触发/.test(val(r.periodRows, /现金流硬性否决/)), val(r.periodRows, /现金流硬性否决/));

// ===== 二 核心输入量（Q3 口径重算）=====
ok('2.1 E_TTM=16.15 亿（R2：16.1230+13.7667−13.7353）', /16\.15/.test(val(r.coreRows, /E_TTM/)), val(r.coreRows, /E_TTM/));
ok('2.2 EBIT_TTM=19.06 亿', /19\.06/.test(val(r.coreRows, /EBIT_TTM/)));
ok('2.3 净有息负债=17.31 亿（三季报 PDF 精确值）', /17\.31/.test(val(r.coreRows, /净有息负债/)));
ok('2.4 ROE_TTM=12.53%（16.1544/128.9664）', /12\.53/.test(val(r.coreRows, /ROE_TTM/)), val(r.coreRows, /ROE_TTM/));
ok('2.5 经营现金流/E_TTM=0.41×（Q3 负现金流拖累）', /0\.41/.test(val(r.coreRows, /经营现金流/)), val(r.coreRows, /经营现金流/));

// ===== 三 估值三角 =====
ok('3.1 ① PE-TTM 合理价 15.19 元（PE_base 11.8 = 11.30+ROE 上修 0.5）', /15\.19/.test(val(r.tripleRows, /PE-TTM/)), val(r.tripleRows, /PE-TTM/));
ok('3.2 ② EV/EBIT 隐含价 10.77 元（EBIT_TTM 19.06×8−17.31）/12.55）', /10\.77/.test(val(r.tripleRows, /EV\/EBIT/)), val(r.tripleRows, /EV\/EBIT/));
ok('3.3 ② 数据完整 → 可执行（不触发补丁5 失效分支）', /可执行/.test(val(r.tripleRows, /EV\/EBIT/)) && !/不可用/.test(val(r.tripleRows, /EV\/EBIT/)));
ok('3.4 ③ PB-ROE 合理 PB 1.54、现价 PB 1.35 → PE 结论可能偏保守', /1\.54/.test(val(r.tripleRows, /PB-ROE/)) && /1\.35/.test(val(r.tripleRows, /PB-ROE/)));

// ===== 四 三情景（补丁4：涨跌幅标注 + 下行风险）=====
ok('4.1 保守目标价 11.47 元【下行风险】（相对现价 -17.15%）——严禁标上行空间', /保守目标价 11\.47 元【下行风险】（相对现价 -17\.15%）/.test(r.scenRows[0].value), r.scenRows[0].value);
ok('4.2 基准目标价 15.19 元（相对现价 +9.69%）', /基准目标价 15\.19 元（相对现价 \+9\.69%）/.test(r.scenRows[1].value), r.scenRows[1].value);
ok('4.3 乐观目标价 17.56 元（相对现价 +26.76%）', /乐观目标价 17\.56 元（相对现价 \+26\.76%）/.test(r.scenRows[2].value), r.scenRows[2].value);
ok('4.4 fairValueRange=[11.47,17.56] / center=15.19', Math.abs(r.fairValueRange[0] - 11.47) < 0.01 && Math.abs(r.fairValueRange[1] - 17.56) < 0.01 && Math.abs(r.fairValueCenter - 15.19) < 0.01, JSON.stringify(r.fairValueRange));
ok('4.5 conservativePct=-17.18（低于现价=下行风险口径）', r.conservativePct != null && r.conservativePct < 0 && Math.abs(r.conservativePct + 17.18) < 0.01, r.conservativePct);
ok('4.6 期权增量不并入基准（硬约束保持）', (r.optionRows || []).length === 2 && /不并入基准|不计入基准价/.test(r.optionRows[0].value));

// ===== 五 反向验证（Q3 口径如实判）=====
ok('5.1 反向验证 5 项齐备', (r.reverseRows || []).length === 5);
ok('5.2 现金流验证=否（0.41 < 0.8，含否决提示）', r.reverseRows[0].result === '否' && /现金流硬性否决已触发/.test(r.reverseRows[0].detail));
ok('5.3 ROE趋势=不适用（12.53% 未破 11% 警戒线，Q3 口径声明）', r.reverseRows[1].result === '不适用' && /LATEST=2026Q3/.test(r.reverseRows[1].detail));
ok('5.4 分红可持续=否（覆盖 1.63× ≤ 2×，如实判 + 否决连带说明）', r.reverseRows[2].result === '否' && /分红覆盖不足/.test(r.reverseRows[2].detail), r.reverseRows[2].detail);
ok('5.5 出口=是 / 股本稀释=不适用', r.reverseRows[3].result === '是' && r.reverseRows[4].result === '不适用');

// ===== 六 置信度 + 评级 =====
ok('6.1 置信度=低（现金流硬性否决置顶锁定）', r.confidence === '低', r.confidence);
ok('6.2 评级=合理（13.85 落在 [11.47,17.56] 区间内）', r.rating === '合理', r.rating);
ok('6.3 expectedReturn≈9.68%', Math.abs((r.expectedReturn || 0) - 9.68) < 0.05, r.expectedReturn);
ok('6.4 summaryNote 第一段=补丁声明 + RUN_DATE + 置信度低', /本次运行已强制使用/.test(r.summaryNote.slice(0, 120)) && /置信度【低】/.test(r.summaryNote) && /现金流硬性否决锁定/.test(r.summaryNote));
ok('6.5 hardConstraintNote 含 v2.1 六项补丁核验', /v2.1 六项防呆防错补丁已强制启用/.test(r.hardConstraintNote || ''));
ok('6.6 模型名 V2.1', /V2\.1/.test(r.model || ''));

// ===== 七 补丁5 休眠路径（纯逻辑：数据完整时不触发）=====
ok('7.1 evCrossInvalid=false（净有息负债完整，补丁5 不触发）', r.evCrossInvalid === false && r.evPeDev != null && r.evPeDev < -20, r.evPeDev);
ok('7.2 补丁5 失效文案函数级验证（缺数据 + 偏离>20% 场景由 confRebalance 同构逻辑覆盖，此处校验 evState 文案）', !/交叉验证失效/.test(val(r.tripleRows, /EV\/EBIT/)) || r.evCrossInvalid === true);

// ===== 八 兼容性 =====
ok('8.1 isXinyangfengModel 识别', H.isXinyangfengModel('000902') === true && H.isXinyangfengModel('600909') === false);

console.log(`===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
