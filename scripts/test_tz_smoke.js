/**
 * 时区统一改造 · 冒烟测试（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_tz_smoke.js
 * 为什么需要它：`node --check` 只做语法检查，抓不到「require 别名错误 / _localDate 未定义」
 * 这类运行时问题（20260917g 改造时曾出现 4 个重名冲突，就是靠它发现的）。
 * 因此这里真实 require 每个被改模块，并验证委托后的 localDate 行为。
 */
const path = require('path');
const { localDate } = require('../lib/localDate');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }

console.log('\n[1] 被改模块可正常 require（能抓出 require 路径/别名错误）');
const MODS = [
  'lib/eventEngine.js', 'lib/factStore.js', 'lib/hotTopics.js', 'lib/marketTechnical.js',
  'lib/sectorCapitalFlow.js', 'lib/stockData.js', 'lib/sentimentTurningPoint.js',
  'lib/deep/conclusion.js', 'lib/deep/research.js', 'lib/cnscraperAdapter.js',
  'lib/ai/valuation.js', 'lib/macroNews.js', 'lib/marketSentimentIndex.js',
  'lib/marketEmotionModel.js', 'lib/sameDayJudgment.js',
  'lib/valuation/haitian603288.js', 'lib/valuation/huaan600909.js', 'lib/valuation/xinyangfeng000902.js',
];
for (const m of MODS) {
  try { require(path.join(ROOT, m)); ok(true, 'require OK  ' + m); }
  catch (e) { ok(false, 'require 失败 ' + m + ' → ' + (e && e.message)); }
}

console.log('\n[2] 委托后的 localDate 与 lib/localDate 完全一致');
const expectToday = localDate();
const bjMidnight = new Date('2026-09-17T00:30:00+08:00');   // UTC 会算成 09-16 的时刻

const sdj = require('../lib/sameDayJudgment');
ok(typeof sdj.localDate === 'function', 'sameDayJudgment 导出 localDate');
ok(sdj.localDate() === expectToday, `sameDayJudgment.localDate() = ${sdj.localDate()}（期望 ${expectToday}）`);
ok(sdj.localDate(bjMidnight) === '2026-09-17', `sameDayJudgment.localDate(北京00:30) = ${sdj.localDate(bjMidnight)}（期望 2026-09-17；旧写法会给 2026-09-16）`);

const msi = require('../lib/marketSentimentIndex');
ok(msi.readSeries() != null, 'marketSentimentIndex.readSeries() 可调用');

console.log('\n[3] server.js 的 require 链关键模块可加载');
let rtOk = false;
try { require(path.join(ROOT, 'lib/pyRuntime')); rtOk = true; } catch (e) { rtOk = false; }
ok(rtOk, 'lib/pyRuntime 可加载（server.js 无重名冲突的前提）');

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
