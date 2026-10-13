// 交易日历回归测试：验证法定节假日不再被当作交易日（修复 2026 国庆长假误生成判定）。
// 纯本地、零依赖（仅 require 本项目 lib）。纳入 npm test 防线。
const { isTradingDay, nextTradingDay, previousTradingDay } = require('../lib/cnTradingCalendar');
const { marketClosed, nextTradingDay: sdNext } = require('../lib/sameDayJudgment');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; } else { fail++; console.log('  FAIL: ' + m); } }
function eq(a, b, m) { ok(a === b, m + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

// 1) 是否交易日：周末 + 法定节假日均应为 false
eq(isTradingDay('2026-10-01'), false, '国庆首日非交易日');
eq(isTradingDay('2026-10-07'), false, '国庆末日非交易日');
eq(isTradingDay('2026-10-03'), false, '周六非交易日');
eq(isTradingDay('2026-10-08'), true, '10-08 节后首开为交易日');
eq(isTradingDay('2026-09-30'), true, '9-30 为交易日');
eq(isTradingDay('2026-02-18'), false, '春节连休内(周三)非交易日');

// 2) 跨节假日下一/上一交易日
eq(nextTradingDay('2026-09-30'), '2026-10-08', '9-30 收盘后下一交易日=10-08(跳过国庆)');
eq(nextTradingDay('2026-10-07'), '2026-10-08', '10-07 下一交易日=10-08');
eq(previousTradingDay('2026-10-08'), '2026-09-30', '10-08 上一交易日=9-30(跳过国庆)');
eq(nextTradingDay('2026-02-13'), '2026-02-24', '春节前一交易日=2-24(跳过春节)');

// 3) 2027 元旦（已知固定节假日，其余 2027 退化为周末）
eq(isTradingDay('2027-01-01'), false, '2027 元旦非交易日');
eq(nextTradingDay('2026-12-31'), '2027-01-04', '跨年下一交易日=1-04(跳过元旦+周末)');

// 4) sameDayJudgment 已委托日历 + 节假日盘中视为已收盘
eq(sdNext('2026-09-30'), '2026-10-08', 'sameDayJudgment.nextTradingDay 委托日历');
ok(marketClosed(new Date('2026-10-05T10:00:00')) === true, '节假日盘中(10-05 10:00) marketClosed=true');
ok(marketClosed(new Date('2026-10-08T10:00:00')) === false, '交易日盘中(10-08 10:00) marketClosed=false');

console.log('trading-calendar verify: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
