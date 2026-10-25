/**
 * 「最新财报」报告期窗口回归（20261023h）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_latest_report_period.js
 *
 * 用户报障（2026-10-23，洲明科技 300232 截图）：
 *   「三季报已经出了，模块还在默认解读半年报，自动搜索最新财报的机制是死逻辑吗？」
 *
 * 根因（不是死逻辑，是「按月份猜报告期」晚了一个月）：
 *   lib/deep/financials.js getLatestPartialQuarterDates 原实现：
 *     5-7月 → q=1（只请求 03-31）
 *     8-10月 → q=2（只请求 03-31 / 06-30）   ← 10 月三季报已披露，仍不请求 09-30
 *     11月+ → q=3（才请求 09-30）
 *   三季报法定披露期是 10 月（截止 10-31），所以整个 10 月都读不到三季报。
 *
 * 现改为「直接请求最近两年全部季末报告期」，由 F10 返回实际已披露的那些：
 *   10 月请求 2026-09-30 → 实测 F10 返回「2026三季报」（营收 55.6 亿）。
 */
const fs = require('fs');
const path = require('path');
const { getLatestPartialQuarterDates } = require('../lib/deep/financials');
const { EARNINGS_PROMPT_VERSION } = require('../lib/ai/cache');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

const at = (s) => getLatestPartialQuarterDates(new Date(s));
const has = (arr, d) => arr.includes(d);

// ============================================================================
// [1] 10 月：必须请求当年三季报（用户报障场景）
// ============================================================================
console.log('\n[1] 2026-10-23（三季报披露期）');
{
  const d = at('2026-10-23');
  ok(has(d, '2026-09-30'), '包含 2026-09-30（2026三季报）');
  ok(has(d, '2025-09-30'), '包含 2025-09-30（去年同期三季报，供同比）');
  ok(has(d, '2026-06-30') && has(d, '2026-03-31'), '同时保留 06-30 / 03-31（供单季拆分）');
}

// ============================================================================
// [2] 其它披露窗口：4 月一季报 / 8 月中报 / 1 月跨年
// ============================================================================
console.log('\n[2] 其它披露窗口');
{
  const d = at('2026-04-15');
  ok(has(d, '2026-03-31'), '4 月（一季报披露期）包含 2026-03-31');
}
{
  const d = at('2026-08-15');
  ok(has(d, '2026-06-30'), '8 月（中报披露期）包含 2026-06-30');
}
{
  const d = at('2027-01-15');
  ok(has(d, '2026-09-30'), '次年 1 月仍包含 2026-09-30（年报未出前三季报仍是最新）');
}
{
  const d = at('2026-11-05');
  ok(has(d, '2026-09-30'), '11 月包含 2026-09-30');
}

// ============================================================================
// [3] 源码守卫：不再按月份猜 q
// ============================================================================
console.log('\n[3] 源码守卫');
const fsrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'deep', 'financials.js'), 'utf8');
ok(!/month >= 8 && month <= 10/.test(fsrc), '已删除「8-10月 = 中报」的月份硬编码');
ok(!/month >= 11/.test(fsrc), '已删除「11月起才是三季报」的月份硬编码');
ok(fsrc.includes('getLatestPartialQuarterDates'), '函数仍存在');
ok(fsrc.includes("['03-31', '06-30', '09-30', '12-31']"), '直接请求全部季末报告期');

// ============================================================================
// [4] 缓存失效：旧中报缓存必须被判 stale，深析页丢弃并自动重算
// ============================================================================
console.log('\n[4] 缓存失效链路');
{
  ok(EARNINGS_PROMPT_VERSION === '20261023h', `EARNINGS_PROMPT_VERSION=20261023h（实际 ${EARNINGS_PROMPT_VERSION}）`);
  const p = fs.readFileSync(path.join(__dirname, '..', 'lib', 'deep', 'pipeline.js'), 'utf8');
  ok(p.includes('readEarningsCache'), '深析管线改用 readEarningsCache');
  ok(/er && !er\.stale/.test(p), '深析管线丢弃 stale 财报缓存（前端自动触发重算）');
  const e = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai', 'earnings.js'), 'utf8');
  ok(e.includes('EARNINGS_PROMPT_VERSION'), 'earnings 生成侧仍以 promptVersion 门控');
}

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
