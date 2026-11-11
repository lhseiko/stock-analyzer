/**
 * test_single_source_taxonomy.js — 跨模块常量单源守卫（20261110g · 整改方案 P1-3）
 * ================================================================
 * 断言四类：
 *   一、taxonomy.js 单源定义：震荡容差只有 0.5 / 1.0 两值（禁止第三种取值）。
 *   二、消费方迁移：四条结算链 + baselines + sameDayJudgment 不再写死容差字面量定义
 *       （全部改为引用 taxonomy）；三处 LEARN_MIN_SAMPLE 引用具名常量。
 *   三、评级文案口径：RATING_WORDS 严格三档、FORBIDDEN_ADVICE_WORDS 齐备。
 *   四、全站合规词扫描（评审 P3-8 吸收项）：lib/ + prompts/ 中禁止出现主动建议类
 *       词句（建议买入/目标价等），否定语境（不构成买卖建议等合规声明）豁免。
 * 零依赖、零网络。
 */
const fs = require('fs');
const path = require('path');
const TAX = require('../lib/taxonomy');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }

console.log('===== 一、taxonomy 单源定义 =====');
ok(TAX.FLAT_TOLERANCE_STOCK === 1.0 && TAX.FLAT_TOLERANCE_INDEX === 0.5, '震荡容差显式两常量：个股 1.0 / 指数 0.5');
const taxSrc = read('lib/taxonomy.js');
const tolDefs = taxSrc.match(/FLAT_TOLERANCE_(?:STOCK|INDEX)\s*=\s*[\d.]+/g) || [];
ok(tolDefs.length === 2, `taxonomy 内容差字面量定义恰好 2 处（实际 ${tolDefs.length}，禁止第三种取值）`);
ok(!/FLAT_TOLERANCE_\w+\s*=\s*(?!(1\.0|0\.5)\b)[\d.]/.test(taxSrc), 'taxonomy 内不存在第三种容差取值');

console.log('\n===== 二、消费方迁移（禁止写死字面量定义） =====');
const MIGRATIONS = [
  ['lib/marketTechJudgment.js', 'FLAT_TOLERANCE_INDEX'],
  ['lib/sentimentAccuracy.js', 'FLAT_TOLERANCE_INDEX'],
  ['lib/baselines.js', 'FLAT_TOLERANCE_INDEX'],
  ['lib/techFaceJudgment.js', 'FLAT_TOLERANCE_STOCK'],
  ['lib/sameDayJudgment.js', 'FLAT_TOLERANCE_STOCK'],
];
for (const [f, sym] of MIGRATIONS) {
  const src = read(f);
  ok(src.includes("require('./taxonomy')" ) && src.includes(sym), `${f} 容差已引用 taxonomy.${sym}`);
}
// 消费方不得再写死容差定义（const FLAT_TOLERANCE = 数字）
for (const [f] of MIGRATIONS) {
  const src = read(f);
  ok(!/const\s+FLAT_TOLERANCE\s*=\s*[\d.]+/.test(src), `${f} 无写死容差定义残留`);
}
ok(read('lib/sameDayJudgment.js').includes('LEARN_MIN_SAMPLE_FACTOR'), 'sameDayJudgment LEARN_MIN_SAMPLE 已单源');
ok(read('lib/marketEmotionModel.js').includes('LEARN_MIN_SAMPLE_EMO_WEIGHT'), 'marketEmotionModel LEARN_MIN_SAMPLE 已单源');
ok(read('lib/sentimentTurningPoint.js').includes('LEARN_MIN_SAMPLE_TURNING'), 'sentimentTurningPoint LEARN_MIN_SAMPLE 已单源');

console.log('\n===== 三、评级文案口径 =====');
ok(TAX.RATING_WORDS.length === 3 && TAX.RATING_WORDS.join(',') === '低估,合理,高估', '评级文案严格三档：低估/合理/高估');
ok(TAX.FORBIDDEN_ADVICE_WORDS.length >= 5 && !TAX.FORBIDDEN_ADVICE_WORDS.includes('目标价'), '合规禁用词清单齐备（主动建议类）；「目标价」单列估值语境');
ok(Array.isArray(TAX.PRICE_TARGET_EXEMPT_PREFIXES) && TAX.PRICE_TARGET_EXEMPT_PREFIXES.includes('lib/valuation/'), '「目标价」豁免清单已登记（专属估值模型=估值计算，非建议）');

console.log('\n===== 四、全站合规词扫描（禁用=fail；需审查=warn；否定语境豁免） =====');
// [P1-3 清单] 两级分级：禁用词出现即 fail；需审查词（看好/看空等估值模块必然使用）只告警不计失败。
const REVIEW_WORDS = ['看好', '看空', '低估', '高估'];
const NEGATIVE_CTX = ['不构成', '不作为', '不提供', '不包含', '不含', '严禁', '禁止', '不得', '绝不', '反对', '而不是', '而非', '拒绝'];
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('#');
}
function inExemptScope(rel) {
  return TAX.PRICE_TARGET_EXEMPT_PREFIXES.some(p => rel === p || rel.startsWith(p));
}
function scanDir(dir, exts, out) {
  for (const ent of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir + '/' + ent.name;
    if (ent.isDirectory()) { if (ent.name !== 'node_modules') scanDir(rel, exts, out); }
    else if (exts.some(e => ent.name.endsWith(e))) out.push(rel);
  }
}
const targets = [];
scanDir('lib', ['.js'], targets);
scanDir('prompts', ['.md'], targets);
let violations = [];
let reviewHits = 0;
for (const rel of targets) {
  if (TAX.ADVICE_SCAN_FILE_EXEMPT.includes(rel)) continue; // 研报转述/分类语境 + 禁词表定义处
  const src = read(rel);
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    if (isCommentLine(line)) return; // [P1-3 清单] 注释行不参与合规扫描（防误报）
    for (const w of TAX.FORBIDDEN_ADVICE_WORDS) {
      if (!line.includes(w)) continue;
      if (NEGATIVE_CTX.some(n => line.includes(n))) continue; // 否定语境豁免（合规声明）
      violations.push(`${rel}:${i + 1} 命中「${w}」：${line.trim().slice(0, 80)}`);
    }
    // 「目标价」：估值语境外出现即违规（否定语境同样豁免）
    if (line.includes(TAX.PRICE_TARGET_WORD) && !inExemptScope(rel) && !NEGATIVE_CTX.some(n => line.includes(n))) {
      violations.push(`${rel}:${i + 1} 命中「${TAX.PRICE_TARGET_WORD}」（非估值语境）：${line.trim().slice(0, 80)}`);
    }
    // 需审查词：只告警（计数），不打 fail
    for (const w of REVIEW_WORDS) {
      if (line.includes(w) && !NEGATIVE_CTX.some(n => line.includes(n))) reviewHits++;
    }
  });
}
if (violations.length) {
  console.log('  —— 命中主动建议类词句（违反评级三档/合规口径）：');
  violations.forEach(v => console.log('     · ' + v));
} else {
  console.log('  （lib/ 与 prompts/ 无主动建议类词句，否定语境已豁免）');
}
console.log(`  ℹ 需审查词（看好/看空/低估/高估）出现 ${reviewHits} 处——仅告警，估值/判断模块必然使用，不拦截`);
ok(violations.length === 0, '全站合规词扫描通过（禁用级）');

console.log(`\n===== test_single_source_taxonomy 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
