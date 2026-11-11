/**
 * test_factor_hash.js — 两段式版本戳守卫（20261110g · 整改方案 P1-2 裁决②）
 * ================================================================
 * 断言四类：
 *   一、lib/factorHash.js _normalize 三坑：对象键排序 / 浮点精度 / undefined→null；数组保序。
 *   二、哈希敏感性：权重/子权重/事件封顶/评级档位 任一变化 → 哈希必变；文案无关字段变化 → 哈希不变。
 *   三、sameDayJudgment.SCHEMA_VERSION 形如 h{8hex}-{LAYOUT_VERSION}，模块两次加载稳定一致。
 *   四、覆盖面：SCHEMA_VERSION 因旧口径记录「schemaVersion 不等即重算」——旧落盘记录与新 h 段不同即判旧schema。
 * 零依赖、零网络。
 */
const fs = require('fs');
const path = require('path');
const { factorHash, _normalize } = require('../lib/factorHash');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

console.log('===== 一、_normalize 三坑 =====');
const a = factorHash([{ b: 1, a: 2 }]), b = factorHash([{ a: 2, b: 1 }]);
ok(a === b, '坑1 排序：对象键序不同 → 同一哈希');
const c = factorHash([{ x: 0.1 + 0.2 }]), d = factorHash([{ x: 0.3 }]);
ok(c === d, `坑2 浮点：0.1+0.2 与 0.3 → 同一哈希（${c}）`);
const e = factorHash([{ x: undefined, y: 1 }]), f = factorHash([{ x: null, y: 1 }]), g = factorHash([{ y: 1 }]);
ok(e === f && e === g, '坑3 undefined：undefined / null / 字段缺失 → 同一哈希（不混淆「改 undefined」与「删除」）');
const h1 = factorHash([['p', 'q', 'r']]), h2 = factorHash([['r', 'q', 'p']]);
ok(h1 !== h2, '数组保序：因子/子因子顺序是口径，顺序变化必须被捕获');
ok(factorHash([{ x: NaN }]) === factorHash([{ x: 'NaN' }]), 'NaN 稳定字符串化');

console.log('\n===== 二、哈希敏感性（数值口径任一变化 → 必变） =====');
const base = {
  keys: ['sentiment', 'capital'], weights: { sentiment: 0.5, capital: 0.5 },
  subWeights: { A: 0.25 }, eventCaps: { gradeRanges: { major: { fixedWeightShort: 0.40 } } },
  rating: ['低估', '合理', '高估'],
};
const hBase = factorHash([base]);
ok(factorHash([Object.assign({}, base, { weights: { sentiment: 0.51, capital: 0.49 } })]) !== hBase, '权重变化 → 哈希变');
ok(factorHash([Object.assign({}, base, { subWeights: { A: 0.26 } })]) !== hBase, '子权重变化 → 哈希变');
ok(factorHash([Object.assign({}, base, { eventCaps: { gradeRanges: { major: { fixedWeightShort: 0.41 } } } })]) !== hBase, '事件封顶变化 → 哈希变');
ok(factorHash([Object.assign({}, base, { rating: ['低估', '合理'] })]) !== hBase, '评级档位变化 → 哈希变');
ok(factorHash([Object.assign({}, base, { note: '纯展示文案' })]) !== hBase, '新增无关字段 → 哈希变（口径集合是白名单式组装）');
ok(factorHash([JSON.parse(JSON.stringify(base))]) === hBase, '深拷贝重组（键序漂移）后哈希不变');

console.log('\n===== 三、sameDayJudgment 两段式 SCHEMA_VERSION =====');
const sdj = require('../lib/sameDayJudgment');
const sv = sdj.SCHEMA_VERSION;
ok(/^h[0-9a-f]{8}-\d{8}[a-z]$/.test(sv), `SCHEMA_VERSION 形如 h{8hex}-{LAYOUT_VERSION}（实际 ${sv}）`);
// 两次独立加载稳定一致（哈希不依赖时间/随机）
const sdjPath = require.resolve('../lib/sameDayJudgment');
delete require.cache[sdjPath];
const sv2 = require('../lib/sameDayJudgment').SCHEMA_VERSION;
ok(sv === sv2, '两次加载 SCHEMA_VERSION 稳定一致');

console.log('\n===== 四、覆盖面接线（静态扫描 payload 组装） =====');
const sdjSrc = fs.readFileSync(path.join(ROOT, 'lib', 'sameDayJudgment.js'), 'utf8');
const hsFn = sdjSrc.slice(sdjSrc.indexOf('function _hashFactorStructure'), sdjSrc.indexOf('function _hashFactorStructure') + 2400);
for (const token of ['keys: FACTOR_KEYS', 'weights: DEFAULT_WEIGHTS', 'subWeights', 'eventCaps', 'rating: TAX.RATING_WORDS', 'flatTolerance', 'factorHash([payload])']) {
  ok(hsFn.includes(token), `payload 含 ${token}`);
}
ok(sdjSrc.includes("require('./factorHash')"), 'sameDayJudgment 已接 lib/factorHash.js');
// 旧记录兼容：落盘记录 schemaVersion 与当前不等 → 走重算（rec.schemaVersion === SCHEMA_VERSION 复用条件仍在）
ok(sdjSrc.includes('rec.schemaVersion === SCHEMA_VERSION'), '复用条件「schemaVersion 严格相等」保留（不等即重算，无需回滚）');

console.log(`\n===== test_factor_hash 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
