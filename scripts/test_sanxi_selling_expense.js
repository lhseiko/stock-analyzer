/**
 * 离线单测（20260913g）：圣湘生物（688289）专属估值模型 · 销售费用显性调整模块
 * ------------------------------------------------------------------
 * 锁定「追加指令」五步的确定性输出：
 *   步骤1 销售费用性质拆解（并购并表 vs 内生，算内生销售费用率）
 *   步骤2 SOTP 板块差异化（A 额外折价 / B PE系数 / C 不调整）
 *   步骤3 Forward PE 费用效率惩罚系数（Δ = TTM费率 − IVD行业均值）
 *   步骤4 EV/EBITDA 天然口径单列（EBITDA 利润率受销售费用率压制）
 *   步骤5 销售费用情景（优化 / 基准 / 恶化）
 * 无网络依赖：模型由 data/valuation/688289.json 锁死输入，结果确定性可复现。
 */
const m = require('../lib/valuation/sanxi688289.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('[PASS]', name); }
  else { fail++; console.log('[FAIL]', name, extra); }
};

const r = m.run('688289', { price: 30 });
check('模型运行成功（ok=true，无异常）', r.ok === true, r.error || r.detail || '');
check('版本标识 = V2.1_销售费用显性调整', /V2\.1/.test(String(r.version)) && /销售费用显性调整/.test(String(r.version)), r.version);

console.log('\n===== 系数判定（步骤2/3）=====');
const se = r.sellingExpense || {};
check('IVD 行业均值销售费用率 = 28.79%', se.benchmark === 28.79, se.benchmark);
check('TTM 销售费用率 = 39.18%', se.ttmRate === 39.18, se.ttmRate);
check('FY2025 销售费用率 = 36.65%', se.fyRate === 36.65, se.fyRate);
check('内生（剔除海济）销售费用率 = 37%', se.organicRate === 37, se.organicRate);
check('Δ = 39.18 − 28.79 = 10.39pp', se.deltaPP === 10.39, se.deltaPP);
check('Δ>10pp → 费用效率惩罚系数 0.85', se.effCoef === 0.85, se.effCoef);
check('板块A 额外 PS 折价 = 0.10（费用刚性，取下沿）', se.aExtraDisc === 0.1, se.aExtraDisc);
check('板块B PE 系数 = 1（海济费用增速 −17% < 营收 +9.22%，未触发）', se.bPeCoef === 1, se.bPeCoef);

console.log('\n===== 步骤1-5 明细行 =====');
const rows = r.sellExpRows || [];
check('sellExpRows 非空且含步骤①~⑤（≥7 行）', rows.length >= 7, rows.length);
const txt = rows.map(x => `${x.label}｜${x.value}`).join('\n');
check('① 拆解：合并销售费用 6.017 亿 / 占营收 36.65%', /合并销售费用 6\.017 亿/.test(txt) && /36\.65%/.test(txt));
check('① 拆解：咨询费及销售佣金 1.7399 亿，海济 1.7172 亿 / 内生 0.1498 亿', /1\.7399 亿/.test(txt) && /1\.7172 亿/.test(txt) && /0\.1498 亿/.test(txt));
check('① 内生销售费用率行存在且无重复文案（同比基本持平）', /内生（剔除海济）销售费用率约 37%（同比基本持平）/.test(txt));
check('无「同比同比」等重复文案', !/同比同比/.test(txt));
check('② 板块A：0.55 − 0.10 = 0.45（额外下调 0.10）', /0\.55 − 0\.10 = 0\.45/.test(txt) && /额外下调 0\.10/.test(txt));
check('② 板块B：未触发 PE 下调（费用增速未跑赢营收）', /未触发 PE 下调/.test(txt) && /PE 系数 1/.test(txt));
check('② 板块C：新兴业务不调整', /基因测序处放量期/.test(txt));
check('③ Forward PE × 0.85，与业绩惩罚 0.85 叠乘', /Forward PE × 0\.85/.test(txt) && /叠乘/.test(txt));
check('④ EV/EBITDA 天然口径：EBITDA 利润率 FY2025 17.73% / 2026E 20.76%', /17\.73%/.test(txt) && /20\.76%/.test(txt));
check('④ 相对行业均值多支出约 1.29 亿', /1\.29 亿/.test(txt));
check('⑤ 情景行（优化 −5pp / 恶化 +3pp）', /−5pp/.test(txt) && /\+3pp/.test(txt));

console.log('\n===== 步骤2/3 已传导进六模型明细 =====');
check('SOTP 行 A 使用最终折价 0.45',
  (r.sotpRows || []).some(x => String(x.label).startsWith('A 分子诊断') && /× 0\.45/.test(x.value)));
check('xvalRows Forward PE 说明含费用效率系数',
  (r.xvalRows || []).some(x => /Forward PE/.test(x.model) && /费用效率/.test(x.note)));
check('xvalRows EV/EBITDA 说明标注天然口径',
  (r.xvalRows || []).some(x => /EV\/EBITDA/.test(x.model) && /天然口径/.test(x.note)));
check('coreRows 含销售费用率行（FY2025 / TTM）',
  (r.coreRows || []).some(x => /销售费用率（FY2025 \/ TTM）/.test(x.label)));
check('riskNote 含销售费用刚性风险', /销售费用刚性/.test(String(r.riskNote)));
check('decisionNote 含销售费用显性调整小结', /【销售费用显性调整】/.test(String(r.decisionNote)));

console.log('\n===== 步骤5 销售费用情景 =====');
const sc = r.sellExpScenRows || [];
check('情景表 3 行（费用优化 / 基准 / 费用恶化）', sc.length === 3, sc.length);
check('情景序列单调：优化 > 基准 > 恶化',
  sc.length === 3 && sc[0].value > sc[1].value && sc[1].value > sc[2].value,
  sc.map(x => `${x.name}:${x.value}`).join(' > '));
check('优化情景释放销售费用 0.91 亿、较基准为正',
  sc.length === 3 && /释放销售费用 0\.91/.test(sc[0].note) && /\+/.test(String(sc[0].note).match(/较基准\s*([+\-]?[\d.]+)/)?.[1] || ''));
check('恶化情景销售费用增加、净利减少、较基准为负',
  sc.length === 3 && /销售费用增加 0\.55 亿/.test(sc[2].note) && /净利减少/.test(sc[2].note));

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
