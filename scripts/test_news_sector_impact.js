/**
 * 首页「今日财经热点」新闻 → 行业板块影响识别 回归守卫
 * ------------------------------------------------------------
 * 覆盖历史三类「泛词抢答」事故 + 本次 20260930a「设备→医疗器械」事故：
 *   ① 20260914i「消费」抢答食品饮料
 *   ② 20260923k「证券」抢答券商（证券交易所=市场基础设施名词）
 *   ③ 20260930a「设备」抢答医疗器械（风电设备 → 误归医疗器械）
 * 及境外闸门、全球定价品种放行、裸通用词防护。
 *
 * 无网络依赖，纯函数级断言。
 */
const assert = require('assert');
const {
  analyzeNewsImpact, NEWS_SECTOR_MAP, GENERIC_TOKENS,
} = require('../lib/newsSectorImpact');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('[PASS]', name); }
  catch (e) { fail++; console.log('[FAIL]', name, '→', e.message); }
}
const sectorOf = (t, s = '') => { const r = analyzeNewsImpact(t, s); return r ? r.sector : null; };

console.log('===== §1 事故回归：泛词不得抢答 =====');
check('风电设备新闻 → 电力设备（不得为医疗器械）', () => {
  const s = sectorOf('风电设备板块表现活跃 威力传动涨超10%',
    '风电设备板块表现活跃，威力传动涨超10%，大金重工、泰胜风能、海力风电、振宏股份跟涨。');
  assert.strictEqual(s, '电力设备', `实际=${s}`);
});
check('光伏/储能新闻 → 电力设备', () => {
  assert.strictEqual(sectorOf('光伏组件价格上涨'), '电力设备');
  assert.strictEqual(sectorOf('储能招标放量'), '电力设备');
});
check('智能家居补贴 → 家用电器（不得为食品饮料）', () => {
  assert.strictEqual(sectorOf('促进智能家居消费行动方案发布'), '家用电器');
});
check('促消费泛政策 → 无板块归属（null）', () => {
  assert.strictEqual(sectorOf('出台促消费政策 扩大内需'), null);
});
check('伊斯坦布尔证券交易所 → null（境外闸门）', () => {
  assert.strictEqual(sectorOf('土耳其伊斯坦布尔证券交易所宣布BIST-50卖空适用报升规则'), null);
});

console.log('\n===== §2 正常归属不被本次改动破坏 =====');
check('医疗器械新闻 → 医疗器械', () => {
  assert.strictEqual(sectorOf('医疗器械板块走高', '迈瑞医疗、鱼跃医疗领涨'), '医疗器械');
});
check('医疗设备新闻 → 医疗器械（专属词仍有效）', () => {
  assert.strictEqual(sectorOf('医疗设备采购放量'), '医疗器械');
});
check('药品集采 → 医药生物', () => {
  assert.strictEqual(sectorOf('药品集采落地', '国家组织药品集中采购，仿制药承压'), '医药生物');
});
check('创新药/疫苗 → 医药生物', () => {
  assert.strictEqual(sectorOf('创新药获批上市'), '医药生物');
});
check('白酒 → 食品饮料', () => {
  assert.strictEqual(sectorOf('白酒板块走强'), '食品饮料');
});
check('半导体/芯片 → 半导体', () => {
  assert.strictEqual(sectorOf('芯片价格上调'), '半导体');
});
check('全球定价品种放行：油价上涨 → 石油石化', () => {
  assert.strictEqual(sectorOf('国际油价上涨'), '石油石化');
});

console.log('\n===== §3 裸通用词防护（结构性守卫）=====');
check('GENERIC_TOKENS 含「设备」', () => {
  assert.ok(GENERIC_TOKENS.has('设备'), 'GENERIC_TOKENS 应包含「设备」');
});
check('NEWS_SECTOR_MAP 任意字段不得含裸通用词', () => {
  const bad = [];
  for (const m of NEWS_SECTOR_MAP) {
    for (const field of ['keywords', 'exclusive', 'exclude']) {
      for (const k of (m[field] || [])) {
        if (GENERIC_TOKENS.has(k)) bad.push(`${m.sector}.${field}=${k}`);
      }
    }
  }
  assert.strictEqual(bad.length, 0, `仍存在裸通用词: ${bad.join(', ')}`);
});
check('复合词不受误伤：医疗设备/医疗服务 仍在医疗器械词表', () => {
  const m = NEWS_SECTOR_MAP.find(x => x.sector === '医疗器械');
  assert.ok(m.keywords.includes('医疗设备'), '应含「医疗设备」');
  assert.ok(m.keywords.includes('医疗服务'), '应含「医疗服务」');
  assert.ok(!m.exclusive.includes('设备'), '不应含裸词「设备」');
});

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
