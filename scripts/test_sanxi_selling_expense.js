/**
 * 离线单测（20260913g 升级 20261030g）：圣湘生物（688289）专属估值模型
 *   · 销售费用显性调整模块（原有五步）
 *   · 20261030g 两条指令：①图1↔图2坐标轴对齐（secAxis）②SOTP海济集采防高估（PE封顶+商誉减值扣减）
 * 无网络依赖：模型由 data/valuation/688289.json 锁死输入，结果确定性可复现。
 * 注：run 为 async，须 await。
 */
const m = require('../lib/valuation/sanxi688289.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('[PASS]', name); }
  else { fail++; console.log('[FAIL]', name, extra); }
};

(async () => {
  const r = await m.run('688289', { price: 30 });
  check('模型运行成功（ok=true，无异常）', r.ok === true, r.error || r.detail || '');
  check('版本标识 = V3.0_三轨并行（销售费用显性调整已并入）', /V3\.0/.test(String(r.version)) && /三轨并行/.test(String(r.version)), r.version);

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
    sc.length === 3 && /释放销售费用 0\.91/.test(sc[0].note) && /\+/.test(String(sc[0].note)));
  check('恶化情景销售费用增加、净利减少、较基准为负',
    sc.length === 3 && /销售费用增加 0\.55 亿/.test(sc[2].note) && /净利减少/.test(sc[2].note));

  console.log('\n===== 20261030g 指令1 · 图1↔图2 坐标轴对齐（secAxis）=====');
  check('secAxis 字段存在', !!r.secAxis, JSON.stringify(r.secAxis));
  check('secAxis.note 含「前瞻性（2026E）敏感性测试」高亮提示', /前瞻性（2026E）敏感性测试/.test(String(r.secAxis && r.secAxis.note)), r.secAxis && r.secAxis.note);
  check('secAxis.note 含「未包含历史极端PE的悲观折价」', /未包含历史极端PE的悲观折价/.test(String(r.secAxis && r.secAxis.note)));
  check('secAxis.note 含「基准情景对应中枢应平移至 X 元」动态复算', /基准情景对应中枢应平移至 [\d.]+ 元。/.test(String(r.secAxis && r.secAxis.note)), r.secAxis && r.secAxis.note);
  check('secAxis.postDiscCenter === 图1 中枢 fairValueCenter（口径一致）', r.secAxis && r.secAxis.postDiscCenter === r.fairValueCenter, `${r.secAxis && r.secAxis.postDiscCenter} vs ${r.fairValueCenter}`);
  check('secAxis.preDiscRange 为 [下,上] 两元有限数组', Array.isArray(r.secAxis && r.secAxis.preDiscRange) && r.secAxis.preDiscRange.length === 2 && r.secAxis.preDiscRange.every(Number.isFinite), r.secAxis && r.secAxis.preDiscRange);
  check('折价前中枢 > 折价后中枢（风险折价仅下调，已施加）', r.secAxis && r.secAxis.preDiscCenter > r.secAxis.postDiscCenter, `${r.secAxis && r.secAxis.preDiscCenter} vs ${r.secAxis && r.secAxis.postDiscCenter}`);
  check('secAxis.anchorLine 含「图1折价前每股区间」锚定基准', /图1折价前每股区间/.test(String(r.secAxis && r.secAxis.anchorLine)), r.secAxis && r.secAxis.anchorLine);

  console.log('\n===== 20261030g 指令2 · SOTP 海济集采防高估 =====');
  const allAlerts = (r.alerts || []).join('\n');
  check('触发器：海济集采预期触发 SOTP 防高估警报', /海济集采预期触发 SOTP 防高估/.test(allAlerts), allAlerts.slice(0, 200));
  check('警报含「PE封顶至可比中位数×0.7」', /PE封顶至可比中位数×0\.7/.test(allAlerts));
  check('警报含「商誉减值准备扣减项」', /商誉减值准备扣减项/.test(allAlerts));
  const trackTxt = (r.threeTrackRows || []).map(x => x.value).join('\n');
  check('轨道II·B 行体现集采封顶（原生物制品PE 35.6x → 封顶后）', /集采封顶·原35\.6x/.test(trackTxt) || /× 24\.92x/.test(trackTxt), trackTxt.slice(0, 400));
  check('轨道II·B 行体现商誉减值扣减 (1−7%商誉减值)', /1−7%商誉减值/.test(trackTxt), trackTxt.slice(0, 400));
  const sotpBTxt = (r.sotpRows || []).filter(x => /生物药品（圣湘海济/.test(x.label)).map(x => x.value).join('\n');
  check('SOTP明细 B 行体现集采封顶 + 商誉减值', /集采封顶·原35\.6x/.test(sotpBTxt) && /商誉减值/.test(sotpBTxt), sotpBTxt);
  check('coreRows 行业倍数提示海济适用PE封顶', (r.coreRows || []).some(x => /海济·集采预期适用PE封顶至/.test(x.value)), (r.coreRows || []).map(x => x.value).join(' | '));

  console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(2); });
