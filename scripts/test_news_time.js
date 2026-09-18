/**
 * 回归测试：lib/newsSearch.js 快讯时间归一化 normalizeNewsTime()（20260917h）
 * --------------------------------------------------------------
 * 目的：钉死「东财 7×24 快讯时间一律按北京时间渲染」这一口径，防止回归到
 *       `new Date(ts).toISOString()`（UTC）导致的 8 小时提前 bug。
 *
 * 事实依据（2026-09-17 抓真实响应核对）：
 *   https://np-listapi.eastmoney.com/comm/web/getFastNewsList
 *   → data.fastNewsList[]，条目字段：
 *        showTime = "2026-09-17 18:47:28"（北京墙钟字符串）
 *        realSort = 1789642048033848     （微秒级真 epoch）
 *   实测 realSort/1e6 后按 Asia/Shanghai 渲染 == showTime，逐条一致。
 *
 * 运行：node scripts/test_news_time.js
 */
const assert = require('assert');
const { normalizeNewsTime } = require('../lib/newsSearch');
const { localDateTime } = require('../lib/localDate');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, actual, expected) {
  ok(name, actual === expected, `实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`);
}

console.log('=== normalizeNewsTime 回归测试 ===');

// --- 1. 北京墙钟字符串直通 ---
eq('[1] showTime 北京字符串直通', normalizeNewsTime('2026-09-17 18:47:28'), '2026-09-17 18:47');
eq('[2] ISO-T 字符串归一化', normalizeNewsTime('2026-09-17T18:47:28'), '2026-09-17 18:47');

// --- 2. 真 epoch 三精度（核心：必须按北京渲染） ---
const MS = 1789642048033;            // 毫秒
const SEC = 1789642048;              // 秒
const US = 1789642048033848;         // 微秒（真实 realSort）
eq('[3] 毫秒 epoch → 北京', normalizeNewsTime(MS), '2026-09-17 18:47');
eq('[4] 秒级 epoch → 北京', normalizeNewsTime(SEC), '2026-09-17 18:47');
eq('[5] 微秒 epoch → 北京（真实 realSort）', normalizeNewsTime(US), '2026-09-17 18:47');
eq('[6] 纯数字字符串按 epoch 处理', normalizeNewsTime(String(US)), '2026-09-17 18:47');

// --- 3. 与旧 UTC 渲染的对照（证明差异 = 8 小时，bug 真实存在） ---
const oldBuggy = new Date(US / 1000).toISOString().slice(0, 16).replace('T', ' ');
ok('[7] 旧 UTC 渲染会提前 8 小时（bug 复现）', oldBuggy === '2026-09-17 10:47', 'oldBuggy=' + oldBuggy);
ok('[8] 新实现 != 旧实现（确有修复）', normalizeNewsTime(US) !== oldBuggy,
  `new=${normalizeNewsTime(US)} old=${oldBuggy}`);

// --- 4. 中国自然日边界（北京 00:30，UTC 仍在昨日 16:30） ---
const bj0030 = Date.UTC(2026, 8, 16, 16, 30, 0); // 北京 2026-09-17 00:30
eq('[9] 北京 00:30 边界 → 保留当日 00:30', normalizeNewsTime(bj0030), '2026-09-17 00:30');
ok('[10] 边界处旧 UTC 渲染落到前一天', new Date(bj0030).toISOString().slice(0, 16).replace('T', ' ') === '2026-09-16 16:30');

// --- 5. 异常输入不抛错、返回空串 ---
for (const [name, v] of [
  ['null', null], ['undefined', undefined], ['空串', ''],
  ['空白串', '   '], ['0', 0], ['负数', -1], ['非数字串', 'abc'], ['NaN', NaN],
]) {
  ok(`[11] 异常输入(${name}) → ''`, normalizeNewsTime(v) === '', JSON.stringify(normalizeNewsTime(v)));
}

// --- 6. 与 localDateTime 一致性（同一 epoch 两处渲染应相同） ---
ok('[12] 与 localDateTime 口径一致', normalizeNewsTime(US) === localDateTime(US / 1000));

console.log('');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
