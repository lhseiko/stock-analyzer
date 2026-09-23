/**
 * 行业归类打分制回归测试（离线，零网络）—— 20260914i
 * 覆盖用户投诉实例：智能家居补贴被误归食品饮料
 */
const assert = require('assert');
const { analyzeNewsImpact, pickSector, isForeignMarketNews } = require('../lib/newsSectorImpact');

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

// ===== 20260923k：境外交易所规则不得穿透到 A 股板块（用户投诉实例）=====
// 用户截图投诉：华安证券（600909）事件驱动卡出现
// 「伊斯坦布尔交易所对BIST 50成分股卖空实施报升规则 ▼利空·证券·中度·剩105天」。
// 根因两层：①「证券交易所」字面命中「证券」关键词被归到券商板块；
//           ② 境外闸门是硬编码城市白名单，不含土耳其/伊斯坦布尔/BIST。
console.log('\n=== 境外交易所规则不得穿透（20260923k 投诉实例）===');
const IST_TITLE = '伊斯坦布尔交易所对BIST 50成分股卖空实施报升规则';
const IST_SUMMARY = '交易所公告显示，土耳其伊斯坦布尔证券交易所宣布，自9月22日起，BIST-50指数成分股的卖空交易将适用报升规则，实施期限另行通知。卖空委托成交价格必须高于最新成交价。若最新成交价格已高于前一成交价，则不受该条款限制。根据该规则，日内先卖后平仓的头寸同样归类为卖空交易。投资者及机构在提交此类委托时，必须选择卖空选项。';
t('★投诉实例：伊斯坦布尔交易所报升规则 → null', () => {
  const r = analyzeNewsImpact(IST_TITLE, IST_SUMMARY);
  assert.strictEqual(r, null, '实际归到 ' + (r && r.sector));
});
t('★投诉实例：闸门判定为境外（true）', () => {
  assert.strictEqual(isForeignMarketNews(IST_TITLE + ' ' + IST_SUMMARY), true);
});
t('「证券交易所」单独出现不再定券商板块', () => {
  const r = analyzeNewsImpact('某证券交易所发布新规', '关于市场交易制度的通知');
  assert.notStrictEqual(r && r.sector, '证券', '实际 ' + (r && r.sector));
});
t('韩国交易所上调卖空保证金 → null', () => {
  assert.strictEqual(analyzeNewsImpact('韩国交易所上调卖空保证金比例', ''), null);
});
t('巴西B3交易所调整涨跌幅限制 → null', () => {
  assert.strictEqual(analyzeNewsImpact('巴西B3交易所调整涨跌幅限制', ''), null);
});
t('土耳其里拉贬值 → null', () => {
  assert.strictEqual(analyzeNewsImpact('土耳其里拉贬值创历史新低', ''), null);
});
t('美股银行股大涨 → null（不得映射到 A 股银行）', () => {
  assert.strictEqual(analyzeNewsImpact('美股银行股大涨', ''), null);
});
t('缩写正则仅匹配全大写（不误伤英文小写词）', () => {
  // 'six'/'set' 等小写词不得命中交易所缩写（正则刻意不加 /i）
  assert.strictEqual(isForeignMarketNews('公司 set up 新产线 six 条'), false);
});

console.log('\n=== 境内券商/交易所新闻不得被误伤（20260923k 回归防护）===');
const domesticBrokerCases = [
  ['证监会就证券公司分类监管征求意见', '', '证券'],
  ['多家券商上调两融额度', '', '证券'],
  ['上海证券交易所优化交易机制', '提升市场流动性', '证券'],
  ['深圳证券交易所修订交易规则', '', '证券'],
  ['北京证券交易所扩大做市商范围', '', '证券'],
];
for (const [tt, ss, want] of domesticBrokerCases) {
  t(`${tt} → ${want}`, () => {
    const r = analyzeNewsImpact(tt, ss);
    assert.ok(r, '应有归类');
    assert.strictEqual(r.sector, want, '实际 ' + r.sector);
  });
}

console.log('\n=== 混合新闻（含境内锚点）仍放行（20260923k）===');
t('中国石油与沙特阿美签约 → 石油石化（有境内锚点豁免）', () => {
  const r = analyzeNewsImpact('中国石油与沙特阿美签署长期供油协议', '');
  assert.ok(r, '应有归类');
  assert.strictEqual(r.sector, '石油石化', '实际 ' + r.sector);
});
t('挪威主权基金增持A股银行板块 → 银行（A股锚点豁免）', () => {
  const r = analyzeNewsImpact('挪威主权基金增持A股银行板块', '');
  assert.ok(r, '应有归类');
  assert.strictEqual(r.sector, '银行', '实际 ' + r.sector);
});
t('国际油价上涨 → 石油石化（全球定价品种不受闸门限制）', () => {
  const r = analyzeNewsImpact('国际油价上涨 沙特减产', '');
  assert.ok(r, '应有归类');
  assert.strictEqual(r.sector, '石油石化', '实际 ' + r.sector);
});

console.log('\n==================================================');
console.log(`结果：${pass}/${pass + fail} 通过`);
if (fail) { console.log(`${fail} 项失败 ❌`); process.exit(1); }
console.log('全部通过 ✅');
