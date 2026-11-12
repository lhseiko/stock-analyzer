#!/usr/bin/env node
// ============================================================
// 威高血净（603014）专属估值模型守卫测试（20261110g）
// 零网络：纯 require + 配置读取 + run() 确定性计算断言。
// 覆盖：闸门 / 三口径桥接 / 新鲜度分级 / 业绩承诺（Q4门槛代码计算 1.13）/
//       DCF 三档与双轨交叉 / 协同期权独立 / PE 归因摊薄股本 / 对价检验 /
//       硬约束声明句 / 接线点 / 版本戳。
// ============================================================
const path = require('path');
const assert = require('assert');
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log('  ✅ ' + name); }
  catch (e) { fail++; console.log('  ❌ ' + name + ' → ' + e.message); }
};

const ROOT = path.join(__dirname, '..');
const M = require(path.join(ROOT, 'lib/valuation/weigao603014.js'));
const fs = require('fs');

console.log('\n== §1 闸门与配置 ==');
t('isWeigaoModel("603014") = true', () => assert.strictEqual(M.isWeigaoModel('603014'), true));
t('isWeigaoModel("sh603014") = true（前缀剥离）', () => assert.strictEqual(M.isWeigaoModel('sh603014'), true));
t('isWeigaoModel("000902") = false', () => assert.strictEqual(M.isWeigaoModel('000902'), false));
t('isWeigaoModel(null/undefined) = false', () => { assert.strictEqual(M.isWeigaoModel(null), false); assert.strictEqual(M.isWeigaoModel(undefined), false); });
const cfg = M.loadConfig();
t('配置存在且 kind=weigao、symbol=603014', () => { assert.ok(cfg); assert.strictEqual(cfg.kind, 'weigao'); assert.strictEqual(cfg.symbol, '603014'); });
t('并表状态 C / 购买日 2026-09 / 并表 1 个月', () => { assert.strictEqual(cfg.consolidation.status, 'C'); assert.strictEqual(cfg.consolidation.purchaseMonth, '2026-09'); assert.strictEqual(cfg.consolidation.consolidatedMonths2026, 1); });
t('股本 6.95 = 4.18 + 2.77（摊薄硬约束）', () => { const s = cfg.market.shares; assert.strictEqual(s.value, 6.95); assert.ok(Math.abs(s.preShares + s.newShares - s.value) < 1e-9); });
t('三口径桥接表锚点（8.64 = 3.37+5.27 / 43.68 = 26.96+16.72）', () => {
  const rows = cfg.bridge.rows;
  assert.ok(Math.abs(rows[1].standalone + rows[1].puri - rows[1].proforma) < 1e-9);
  assert.ok(Math.abs(rows[0].standalone + rows[0].puri - rows[0].proforma) < 1e-9);
});
t('业绩承诺 6.40/7.20/7.84 + 普瑞 2025 净利 6.01 + 对价 85.11 vs 净资产 26.95', () => {
  assert.deepStrictEqual(cfg.promises.annual, { '2026': 6.40, '2027': 7.20, '2028': 7.84 });
  assert.strictEqual(cfg.promises.actual9M2026, 5.27);
  assert.strictEqual(cfg.promises.puri2025Np, 6.01);
  assert.strictEqual(cfg.promises.consideration, 85.11);
  assert.strictEqual(cfg.promises.targetNetAsset, 26.95);
});
t('可比公司配置：宝莱特/天益/正川/力诺 剔除且带原因', () => {
  const excluded = [...cfg.comps.bloodPeers, ...cfg.comps.packPeers].filter(p => p.excluded).map(p => p.name);
  assert.ok(['宝莱特', '天益医疗', '正川股份', '力诺药包'].every(n => excluded.includes(n)));
  excluded.forEach(n => {
    const all = [...cfg.comps.bloodPeers, ...cfg.comps.packPeers];
    assert.ok(all.find(p => p.name === n).excludeReason && all.find(p => p.name === n).excludeReason.length > 5, n + ' 须带剔除原因');
  });
});

console.log('\n== §2 run() 确定性输出（price=33.85） ==');
const r = M.run('603014', { price: 33.85 });
t('run ok / dedicated / weigao 闸门字段', () => { assert.strictEqual(r.ok, true); assert.strictEqual(r.dedicated, true); assert.strictEqual(r.weigao, true); assert.strictEqual(r.symbol, '603014'); });
t('当前价 33.85 → 评级【合理】（33.85 ∈ [悲观, 乐观]）', () => { assert.strictEqual(r.rating, '合理'); assert.strictEqual(r.currentPrice, 33.85); });
t('DCF 基准中枢 33.83（±0.3 容差）', () => assert.ok(Math.abs(r.fairValueCenter - 33.83) < 0.3, 'center=' + r.fairValueCenter));
t('三档区间 [23.5, 43] 容差内（悲观 ~23.81 / 乐观 ~42.43）', () => { assert.ok(r.fairValueRange[0] > 23 && r.fairValueRange[0] < 24.5, 'low=' + r.fairValueRange[0]); assert.ok(r.fairValueRange[1] > 41 && r.fairValueRange[1] < 43.5, 'high=' + r.fairValueRange[1]); });
t('DCF × 相对估值偏离 < 5%（双轨一致）', () => { const dev = Math.abs(r.decisionNote.match(/偏离 (-?[\d.]+)%/)[1]); assert.ok(dev < 5, 'dev=' + dev); });
t('法定合并 TTM 归母 ≈ 5.375（4.823+3.96−3.408）', () => assert.ok(Math.abs(r.statutoryTtmNp - 5.375) < 0.02, 'ttm=' + r.statutoryTtmNp));
t('静态 PE ≈ 48.78 / 动态 PE ≈ 21.03（市值 235.19 亿口径）', () => { assert.ok(Math.abs(r.staticPe - 48.78) < 0.3, 'static=' + r.staticPe); assert.ok(Math.abs(r.dynPe - 21.03) < 0.3, 'dyn=' + r.dynPe); });

console.log('\n== §3 硬约束与强制声明句 ==');
t('openingStatement 声明「DCF 基期采用口径①」', () => assert.ok(r.openingStatement.includes('DCF 基期采用口径①')));
t('openingStatement 含并表状态 C 与并表 1 个月', () => { assert.ok(r.openingStatement.includes('C')); assert.ok(r.openingStatement.includes('1 个月')); });
t('openingStatement 含强制句「备考归母 8.64 亿中普瑞贡献 5.27 亿（占 61.0%）…仅约 0.59 亿进入 2026 年法定合并报表」', () => assert.ok(r.openingStatement.includes('备考归母 8.64 亿中普瑞贡献 5.27 亿（占 61.0%）') && r.openingStatement.includes('仅约 0.59 亿进入 2026 年法定合并报表')));
t('openingStatement 标注「备考口径对比，非法定报表同比」', () => assert.ok(r.openingStatement.includes('备考口径对比，非法定报表同比')));
t('Q4 达标门槛由代码计算 = 1.13 亿（承诺 6.40 − 9M 5.27），非指令集原文 0.13', () => {
  const row = r.promiseRows.find(x => x.label.includes('Q4 达标门槛'));
  assert.ok(row && row.value.includes('1.13'), row && row.value);
  assert.ok(row.value.includes('6.4') && row.value.includes('5.27'));
});
t('基数质量系数 0.90 已启用（压线情景）', () => { const row = r.promiseRows.find(x => x.label.includes('基数质量')); assert.ok(row && row.value.includes('0.9')); });
t('完成率 82.3%（5.27/6.40）', () => { const row = r.promiseRows.find(x => x.label.includes('进度追踪')); assert.ok(row.value.includes('82.3') || row.value.includes('82.34')); });
t('商誉 ≈ 58.16 亿（85.11 − 26.95）', () => { assert.ok(Math.abs(cfg.promises.goodwillApprox - 58.16) < 0.01); const row = r.promiseRows.find(x => x.label.includes('商誉')); assert.ok(row.value.includes('58.16') || row.value.includes('58.2')); });
t('协同期权独立列示：概率 35% + 区间 0.6~1.1 元/股 + 「不并入基准」', () => {
  const row = r.optionRows.find(x => x.label.includes('独立列示声明'));
  assert.ok(row && row.value.includes('不并入基准目标价'));
  const q = r.optionRows.find(x => x.label.includes('期权价值量化'));
  assert.ok(q && q.value.includes('35%'));
});
t('协同加权综合价值 = 基准 + 期权中值（34.65 ± 0.3）', () => assert.ok(Math.abs(r.synergyAdjCenter - 34.65) < 0.3, 'v=' + r.synergyAdjCenter));
t('PE 归因句：并表基数效应 + 股本摊薄（4.18 → 6.95）', () => { const row = r.peRows.find(x => x.label.includes('差异归因')); assert.ok(row.value.includes('并表基数效应') && row.value.includes('6.95')); });
t('EPS 增厚 32.79% ≠ 价值创造 警示句', () => { const row = r.optionRows.find(x => x.label.includes('EPS 增厚')); assert.ok(row.value.includes('32.79') && row.value.includes('商誉')); });
t('对价检验结论 = 轻微增厚（14.16x < 山东药玻 18.49x）', () => { const row = r.considerationRows.find(x => x.label.includes('独立结论')); assert.ok(row.value.includes('轻微增厚')); });
t('硬约束核验 8 条全列（含并表首年禁令/永续禁令/摊薄股本/期权独立）', () => {
  assert.ok(r.hardConstraintNote.includes('口径①'));
  assert.ok(r.hardConstraintNote.includes('1—8 月普瑞利润未计入'));
  assert.ok(r.hardConstraintNote.includes('未将 CAGR 线性外推至永续'));
  assert.ok(r.hardConstraintNote.includes('6.95 亿股'));
  assert.ok(r.hardConstraintNote.includes('独立列示'));
});
t('C 级权重 10% ≤ 20% → 置信度「中」且注明估算成分', () => { assert.strictEqual(r.cWeightPct, 10); assert.strictEqual(r.confidence, '中'); assert.ok(r.confidenceNote.includes('估算')); });

console.log('\n== §4 行结构与降级显式标记 ==');
const rowKeys = ['consolidationRows', 'bridgeRows', 'coreRows', 'promiseRows', 'dcfRows', 'compRows', 'peRows', 'optionRows', 'considerationRows', 'reverseRows', 'trackRows', 'failRows', 'freshnessRows'];
t('指令九 11 节 rows 全量齐备（缺项视为运行无效）', () => rowKeys.forEach(k => { assert.ok(Array.isArray(r[k]) && r[k].length > 0, k + ' 为空'); }));
t('freshnessOverview 含 A 级占比与 C 级清单', () => { assert.ok(r.freshnessOverview.includes('A 级占比')); assert.ok(r.freshnessOverview.includes('C 级指标清单')); });
t('三档 DCF rows 均含 WACC 与 B/C 新鲜度分布标注', () => r.dcfRows.slice(0, 3).forEach(x => { assert.ok(x.value.includes('WACC'), x.name); assert.ok(x.value.includes('新鲜度分布') || x.value.includes('C 级权重'), x.name); }));
t('反向验证 5 项全部通过', () => { assert.strictEqual(r.reverseRows.length, 5); r.reverseRows.forEach(x => assert.strictEqual(x.result, '是', x.id)); });
t('跟踪变量 3 项（Q4 基数质量 / standalone Q4 / 商誉减值）', () => { assert.strictEqual(r.trackRows.length, 3); assert.ok(r.trackRows[0].value.includes('Q4')); });
t('alerts 含估算标注与桥接强制句', () => { assert.ok(r.alerts.some(a => a.includes('估算值') || a.includes('估算'))); assert.ok(r.alerts.some(a => a.includes('仅约 0.59 亿进入 2026 年法定合并报表'))); });
t('模型失效条件 4 条未触发', () => { assert.strictEqual(r.failRows.length, 4); assert.strictEqual(r.modelSuspended, false); });
t('dcfPart 纯函数：普通现金流手算一致（10/10/10, 10%, 2% → PV 27.63 + TV PV 67.75）', () => {
  const res = M.dcfPart([10, 10, 10], 0.10, 0.02);
  const pvFlows = 10 / 1.1 + 10 / 1.21 + 10 / 1.331;
  const tv = 10 * 1.02 / 0.08;
  assert.ok(Math.abs(res.pvFlows - pvFlows) < 1e-9);
  assert.ok(Math.abs(res.tv - tv) < 1e-9);
  assert.ok(Math.abs(res.total - (pvFlows + tv / 1.331)) < 1e-9);
});
t('dcfPart 恒增长零现金流安全（g < wacc 边界不炸）', () => { const res = M.dcfPart([1, 1], 0.07, 0.02); assert.ok(isFinite(res.total) && res.total > 0); });

console.log('\n== §5 三处接线点 ==');
t('lib/ai/valuation.js hasDedicatedValuation 含 weigao603014 接线', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/ai/valuation.js'), 'utf8');
  assert.ok(src.includes("require('../valuation/weigao603014.js').isWeigaoModel"));
});
t('hasDedicatedValuation("603014") = true（实际调用）', () => {
  const { hasDedicatedValuation } = require(path.join(ROOT, 'lib/ai/valuation.js'));
  assert.strictEqual(hasDedicatedValuation('603014'), true);
  assert.strictEqual(hasDedicatedValuation('sh603014'), true);
});
t('lib/deep/conclusion.js 含 603014 专属分支', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/deep/conclusion.js'), 'utf8');
  assert.ok(src.includes("sym === '603014'"));
  assert.ok(src.includes('[威高血净专属模型]'));
});
t('lib/ai/valuation.js analyzeValuation 主体含威高内联分支（第四处接线：不掉 LLM 流程）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/ai/valuation.js'), 'utf8');
  assert.ok(src.includes('[AI 估值] 威高血净专属模型失败'), '内联分支缺失 → analyzeValuation 会掉进通用 LLM 流程');
  assert.ok(src.includes('wgModel.run(bareSym'));
});
t('public/js/app.js 含 weigao 渲染分支（j.dedicated && j.weigao）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert.ok(src.includes('j.dedicated && j.weigao'));
  assert.ok(src.includes('20261104i：威高血净（603014）专属'));
});
t('app.js 渲染卡十一节标题齐备（〇~十一）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  ['〇 并表状态与口径声明', '一 三口径桥接表', '二 数据新鲜度总览', '三 核心财务矩阵', '四 业绩承诺追踪', '五 DCF 三档估值', '六 相对估值分部交叉验证', '七 协同效应看涨期权', '八 对价合理性检验', '九 反向验证清单', '十 结论与置信度', '十一 当前估值水位'].forEach(s => assert.ok(src.includes(s), '缺少节：' + s));
});
t('server.js VALUATION_MODEL_HASH 自动扫描 lib/valuation/*.js（新模型自动纳入缓存失效）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes("'lib', 'valuation'"), '需确认目录扫描逻辑存在');
  assert.ok(src.includes('readdirSync'), '需确认目录扫描逻辑存在');
});

console.log('\n== §6 版本戳 ==');
t('server.js APP_VERSION = 20261112a 且注释含威高血净条目', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(src.includes("const APP_VERSION = '20261112a'"));
  assert.ok(src.includes('[20261104i] 威高血净（603014）专属估值模型'));
});
t('配置 version = 20261104i（历史落盘条目不随全局升版）', () => assert.strictEqual(cfg.version, '20261104i'));

console.log('\n========================================');
console.log(`威高血净专属估值模型守卫：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
