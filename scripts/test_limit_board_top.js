/**
 * 当日最多涨停/跌停板块 · 聚合纯函数离线回归（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_limit_board_top.js
 * 覆盖：aggregateTopIndustry（lib/stockData.js，20261015l）——
 *       正常 top1 / 并列取先出现 / 空池 null / hybk 缺失跳过 / leader 取该行业池内首只。
 * 说明：网络取数（push2ex getTopicZTPool/DTPool）由服务端实测覆盖，本文件只测确定性聚合逻辑。
 */
const { aggregateTopIndustry } = require('../lib/stockData');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

console.log('[1] 正常聚合：取家数最多行业，leader 为该行业池内首只');
{
  const pool = [
    { n: '保隆科技', hybk: '汽车零部' }, { n: '甲股', hybk: '汽车零部' }, { n: '乙股', hybk: '汽车零部' },
    { n: '丙股', hybk: '通用设备' }, { n: '丁股', hybk: '通用设备' }, { n: '戊股', hybk: '出版' },
  ];
  const r = aggregateTopIndustry(pool);
  ok(r && r.name === '汽车零部', `top1 = 汽车零部（实际 ${r && r.name}）`);
  ok(r && r.count === 3, `count = 3（实际 ${r && r.count}）`);
  ok(r && r.leader === '保隆科技', `leader = 池内首只保隆科技（实际 ${r && r.leader}）`);
}

console.log('\n[2] 并列第一：取先出现者（pool 顺序即东财排序，确定性规则）');
{
  const r = aggregateTopIndustry([{ n: 'a', hybk: 'X' }, { n: 'b', hybk: 'Y' }]);
  ok(r && r.name === 'X' && r.count === 1 && r.leader === 'a', `并列取先出现 X/a（实际 ${JSON.stringify(r)}）`);
}

console.log('\n[3] 空池 / 全缺失行业 → null（不伪造）');
ok(aggregateTopIndustry([]) === null, '空数组 → null');
ok(aggregateTopIndustry(null) === null, 'null → null');
ok(aggregateTopIndustry([{ n: 'a' }, { n: 'b', hybk: '' }, { n: 'c', hybk: '  ' }]) === null, 'hybk 全缺失/空白 → null');

console.log('\n[4] 混合脏数据：有效行照常聚合，脏行跳过');
{
  const r = aggregateTopIndustry([
    { n: '脏行无行业' }, { n: '空白行业', hybk: '' },
    { n: '有效1', hybk: '元件' }, { n: '有效2', hybk: '元件' }, { n: '有效3', hybk: '物流' },
  ]);
  ok(r && r.name === '元件' && r.count === 2 && r.leader === '有效1', `脏行跳过，元件 2 家居首（实际 ${JSON.stringify(r)}）`);
}

console.log('\n[5] 单行池：家数 1 也能成为 top1（跌停池仅 1 家的场景）');
{
  const r = aggregateTopIndustry([{ n: '独苗', hybk: '饮料乳品' }]);
  ok(r && r.name === '饮料乳品' && r.count === 1 && r.leader === '独苗', `单行池 top1（实际 ${JSON.stringify(r)}）`);
}

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
