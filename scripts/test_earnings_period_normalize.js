/**
 * scripts/test_earnings_period_normalize.js —— 财报解读「报告期文本规范化」守卫（任务卡 #026）
 * ---------------------------------------------------------------------------
 *   node scripts/test_earnings_period_normalize.js
 *
 * 背景：AI 首行「报告期：…」常带括号长尾（如「2026年中报（即2026年半年度报告）」），
 * 会被前端直接拼进卡片标题。规范化只作用于 reportPeriod 字段，不动 summary 正文。
 */
'use strict';

const { _normalizeReportPeriod } = require('../lib/ai/earnings');

let pass = 0;
const fail = [];
function check(name, input, expect) {
  try {
    const got = _normalizeReportPeriod(input);
    if (got !== expect) throw new Error(`输入「${input}」应得「${expect}」，实际「${got}」`);
    pass++;
  } catch (e) { fail.push(`✗ ${name}\n    ${e.message}`); }
}

// 历史真实问题样本（data/ai_cache 中出现过）
check('中报带解释性括号', '2026年中报（即2026年半年度报告）', '2026年中报');
check('中报带日期括号', '2026年中报（2026年6月30日）', '2026年中报');
// 半年度表述必须判为中报，不能被「年度」二字误导成年报
check('半年度报告 → 中报', '2026年半年度报告', '2026年中报');
check('半年报 → 中报', '2025年半年报', '2025年中报');
check('中期报告 → 中报', '2026年中期报告', '2026年中报');

// 正常四种写法原样通过
check('三季报', '2026年三季报', '2026年三季报');
check('年报', '2025年年报', '2025年年报');
check('一季报', '2026年一季报', '2026年一季报');
check('中报', '2026年中报', '2026年中报');

// 变体
check('第三季度报告 → 三季报', '2026年第三季度报告', '2026年三季报');
check('第一季度报告 → 一季报', '2026年第一季度报告', '2026年一季报');
check('年度报告 → 年报', '2025年年度报告', '2025年年报');
check('带空格的年份', '2026 年三季报', '2026年三季报');
check('尾部空白被清理', '  2026年三季报  ', '2026年三季报');

// 无法识别 → 保留原文，不丢信息
check('无法识别时保留原文', '2026年1-9月累计', '2026年1-9月累计');
check('无年份时保留原文', '最新一期财报', '最新一期财报');

// 空值
check('null 输入', null, null);
check('空字符串输入', '', null);
check('undefined 输入', undefined, null);

console.log(`\n共 ${pass + fail.length} 项：通过 ${pass}，失败 ${fail.length}`);
if (fail.length) { fail.forEach(f => console.log(f)); process.exitCode = 1; } else { console.log('全部通过'); }
