/**
 * 事件权重分级 + 市场情绪提醒准确率 回归测试（离线，零网络）—— 20260914i
 * 覆盖用户 2026-09-14 投诉：
 *   ① 事件权重过高（轻微+中度反向却合计约 50%）
 *   ② 市场情绪提醒需要准确率记录
 */
const assert = require('assert');
const ee = require('../lib/eventEngine');
const sa = require('../lib/sentimentAccuracy');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

console.log('\n=== 事件权重分级（用户口径：三个中度叠加也不该有 50%）===');
const cfg = ee.loadConfig();
t('中度基准权重 = 0.12（原 0.30）', () => assert.strictEqual(cfg.gradeRanges.moderate.fixedWeightShort, 0.12));
t('重大基准权重 = 0.40（原 0.45）', () => assert.strictEqual(cfg.gradeRanges.major.fixedWeightShort, 0.40));
t('轻微基准权重 = 0.03（原 0.08）', () => assert.strictEqual(cfg.gradeRanges.minor.fixedWeightShort, 0.03));
t('合计封顶 = 0.40（原 0.50）', () => assert.strictEqual(cfg.maxCombinedEventWeight, 0.4));
t('三个中度叠加 0.36 < 封顶 0.40', () => {
  const three = cfg.gradeRanges.moderate.fixedWeightShort * 3;
  assert.ok(three < cfg.maxCombinedEventWeight, `3×中度=${three} 应 < ${cfg.maxCombinedEventWeight}`);
});
t('三个中度叠加远低于 50%', () => {
  const three = cfg.gradeRanges.moderate.fixedWeightShort * 3;
  assert.ok(three < 0.5, `3×中度=${three} 应 < 0.5`);
});
t('中度权重约为重大的 1/3（量级直觉）', () => {
  const r = cfg.gradeRanges.moderate.fixedWeightShort / cfg.gradeRanges.major.fixedWeightShort;
  assert.ok(r >= 0.25 && r <= 0.35, `ratio=${r}`);
});
t('宏观政策上限降为 moderate（产业政策≠战争级别）', () => {
  assert.strictEqual(cfg.severity.typeCeiling.macro_policy, 'moderate');
});
t('地缘/战争仍可到 major（保住重大通道）', () => {
  assert.strictEqual(cfg.severity.typeCeiling.geo_disaster, 'major');
  assert.strictEqual(cfg.severity.typeCeiling.industry_supply, 'major');
});
t('原油冲击上限降到 8%（原 20%）', () => assert.strictEqual(ee.OIL_MAX_WEIGHT, 0.08));
t('原油权重系数降到 0.01（原 0.02）', () => assert.strictEqual(ee.OIL_WEIGHT_PER_PCT, 0.01));
t('配置版本已升到 20260914i', () => assert.strictEqual(cfg.version, '20260914i'));
t('配置迁移：磁盘版本落后时代码会强制刷新（防「改了代码不生效」）', () => {
  // loadConfig 内部实现：version 不一致 → 用 defaultConfig 覆盖三组结构性配置
  const def = ee.defaultConfig();
  assert.strictEqual(def.version, '20260914i');
  assert.strictEqual(def.gradeRanges.moderate.fixedWeightShort, 0.12);
  assert.strictEqual(def.maxCombinedEventWeight, 0.4);
});
t('gradeLabel 三档文案不变', () => {
  assert.strictEqual(ee.gradeLabel('major'), '重大');
  assert.strictEqual(ee.gradeLabel('moderate'), '中度');
  assert.strictEqual(ee.gradeLabel('minor'), '轻微');
});

console.log('\n=== 情绪预警方向归一化 ===');
t('看涨 → 涨', () => assert.strictEqual(sa.normalizeDir('看涨'), '涨'));
t('看跌 → 跌', () => assert.strictEqual(sa.normalizeDir('看跌'), '跌'));
t('看涨(反弹机会) → 涨', () => assert.strictEqual(sa.normalizeDir('看涨(反弹机会)'), '涨'));
t('看跌(回调风险) → 跌', () => assert.strictEqual(sa.normalizeDir('看跌(回调风险)'), '跌'));
t('震荡 → 震荡', () => assert.strictEqual(sa.normalizeDir('震荡'), '震荡'));
t('空 → null', () => assert.strictEqual(sa.normalizeDir(''), null));

console.log('\n=== 情绪预警留档条件（仅「预警/强烈预警」+ 明确方向）===');
t('无 → 不留档', () => assert.strictEqual(sa.shouldRecord({ level: '无', impliedDir: '震荡' }), false));
t('关注+看涨 → 不留档', () => assert.strictEqual(sa.shouldRecord({ level: '关注', impliedDir: '看涨' }), false));
t('预警+看涨 → 留档', () => assert.strictEqual(sa.shouldRecord({ level: '预警', impliedDir: '看涨' }), true));
t('强烈预警+看跌 → 留档', () => assert.strictEqual(sa.shouldRecord({ level: '强烈预警', impliedDir: '看跌(回调风险)' }), true));
t('预警+震荡 → 不留档（无明确方向）', () => assert.strictEqual(sa.shouldRecord({ level: '预警', impliedDir: '震荡' }), false));
t('预警+看涨 → 留档', () => assert.strictEqual(sa.shouldRecord({ level: '预警', impliedDir: '看涨' }), true));

console.log('\n=== 情绪预警聚合统计 ===');
t('无样本 accuracy = null（不伪造 0%）', () => {
  assert.strictEqual(sa.computeAccuracy([]).accuracy, null);
});
t('2 条已结算 1 命中 → 50%', () => {
  const a = sa.computeAccuracy([
    { baseDate: '2026-01-01', targetDate: '2026-01-02', dir: '涨', level: '预警', settled: true, correct: true },
    { baseDate: '2026-01-02', targetDate: '2026-01-05', dir: '跌', level: '强烈预警', settled: true, correct: false },
  ]);
  assert.strictEqual(a.accuracy, 50);
  assert.strictEqual(a.settledCount, 2);
  assert.strictEqual(a.bullTotal, 1);
  assert.strictEqual(a.strongTotal, 1);
});
t('待验证不计入分母', () => {
  const a = sa.computeAccuracy([
    { baseDate: '2026-01-01', targetDate: '2026-01-02', dir: '涨', level: '预警', settled: true, correct: true },
    { baseDate: '2099-01-01', targetDate: '2099-01-02', dir: '跌', level: '预警', settled: false },
  ]);
  assert.strictEqual(a.accuracy, 100);
  assert.strictEqual(a.pendingCount, 1);
});
t('口径常量：次日上证 + 0.5% 容差', () => {
  const a = sa.computeAccuracy([]);
  assert.strictEqual(a.flatTolerance, 0.5);
  assert.strictEqual(a.benchmark.code, 'sh000001');
  assert.strictEqual(a.horizonLabel, '次日上证指数涨跌');
});
t('过期未结算检出', () => {
  const a = sa.computeAccuracy([
    { baseDate: '2020-01-01', targetDate: '2020-01-02', dir: '涨', level: '预警', settled: false },
  ]);
  assert.ok(a.overdueCount >= 1);
});

console.log('\n' + '='.repeat(50));
console.log(`结果：${pass}/${pass + fail} 通过`);
if (fail) { console.log(`${fail} 项失败 ❌`); process.exit(1); }
console.log('全部通过 ✅');
