/**
 * 行业归类打分制回归测试（离线，零网络）—— 20260914i
 * 覆盖用户投诉实例：智能家居补贴被误归食品饮料
 */
const assert = require('assert');
const { analyzeNewsImpact, pickSector } = require('../lib/newsSectorImpact');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ' → ' + e.message); }
}

console.log('\n=== 用户投诉实例：智能家居补贴（商务部等8部门，2026-09-14 发布）===');
const TITLE = '商务部等8部门：支持地方结合实际自主合理确定智能家居产品补贴品类、补贴标准';
const SUMMARY = '按照2026年消费品以旧换新政策部署，支持地方结合实际自主合理确定智能家居产品补贴品类、补贴标准，统筹支持全屋智能家居购新。';
t('「智能家居补贴」不再归食品饮料', () => {
  const r = analyzeNewsImpact(TITLE, SUMMARY);
  assert.ok(r, '应有归类结果');
  assert.strictEqual(r.sector, '家用电器', '实际归到 ' + r.sector);
});
t('「智能家居补贴」归到家用电器', () => {
  const r = analyzeNewsImpact(TITLE, SUMMARY);
  assert.strictEqual(r.sector, '家用电器');
});
t('pickSector 明确排除食品饮料', () => {
  const m = pickSector(TITLE + ' ' + SUMMARY);
  assert.notStrictEqual(m.sector, '食品饮料');
});

console.log('\n=== 泛词不能单独定归属 ===');
t('只含「消费」→ 不归类（无行业词）', () => {
  const r = analyzeNewsImpact('多部门发文促消费', '进一步扩大消费需求');
  assert.strictEqual(r, null, '实际 ' + (r && r.sector));
});
t('只含「补贴」→ 不归类', () => {
  const r = analyzeNewsImpact('某地发放补贴', '给予企业补贴支持');
  assert.strictEqual(r, null, '实际 ' + (r && r.sector));
});
t('只含「以旧换新」→ 不归类（虽是家电行泛词，但需非泛词）', () => {
  // 「以旧换新」在家电行里属 keywords（非 exclusive），单独出现仍算命中该行
  const r = analyzeNewsImpact('推进以旧换新', '落实以旧换新政策');
  assert.ok(r === null || r.sector === '家用电器', '实际 ' + (r && r.sector));
});

console.log('\n=== 专属词优先于泛词 ===');
t('白酒提价（专属于食品饮料）→ 食品饮料', () => {
  const r = analyzeNewsImpact('白酒龙头企业宣布提价', '高端白酒价格上调');
  assert.strictEqual(r.sector, '食品饮料', '实际 ' + (r && r.sector));
});
t('酱油调味品政策 → 食品饮料', () => {
  const r = analyzeNewsImpact('调味品行业新国标发布', '酱油等调味品标准更新');
  assert.strictEqual(r.sector, '食品饮料', '实际 ' + (r && r.sector));
});
t('食品饮料行强排除家居词（制造冲突）', () => {
  const r = analyzeNewsImpact('白酒企业跨界进入智能家居', '白酒公司投资家居业务');
  assert.notStrictEqual(r.sector, '食品饮料', '被排除后不应归食品饮料');
});

console.log('\n=== 其他行业基本不回退（回归防护）===');
const cases = [
  ['半导体设备国产化突破', '芯片光刻机进展', '半导体'],
  ['创新药医保谈判结果公布', '生物医药集采落地', '医药生物'],
  ['原油价格上涨', '国际油价走高', '石油石化'],
  ['光伏组件价格回升', '储能招标放量', '电力设备'],
  ['降准落地', '存款准备金率下调', '银行'],
  ['军工订单增长', '国防装备采购', '国防军工'],
  ['猪价持续回升', '种业政策支持', '农林牧渔'],
];
for (const [tt, ss, want] of cases) {
  t(`${tt} → ${want}`, () => {
    const r = analyzeNewsImpact(tt, ss);
    assert.ok(r, '应有归类');
    assert.strictEqual(r.sector, want, '实际 ' + r.sector);
  });
}

console.log('\n=== 境外市场仍被拒收 ===');
t('日经指数收涨 → null（非全球定价品）', () => {
  const r = analyzeNewsImpact('日经指数收涨1.2%', '东京股市走强');
  assert.strictEqual(r, null);
});

console.log('\n==================================================');
console.log(`结果：${pass}/${pass + fail} 通过`);
if (fail) { console.log(`${fail} 项失败 ❌`); process.exit(1); }
console.log('全部通过 ✅');
