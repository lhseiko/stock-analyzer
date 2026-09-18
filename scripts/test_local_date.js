/**
 * lib/localDate.js 回归测试（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_local_date.js
 * 1) 边界正确性：UTC 日期与北京日期不一致的时段（北京 00:00–07:59）必须取北京日。
 * 2) 等价性：在 UTC+8 宿主机上，新工具与旧实现（getFullYear/getMonth/getDate）
 *    对任意时刻必须完全一致 —— 这是「把既有 localDate 改为委托」不改变行为的前提证明。
 * 3) 派生格式：localCompact / localDateTime / localDateFromTs（秒与毫秒）。
 */
const { localDate, localDateTime, localCompact, localDateFromTs, localDateTimeFromTs, TZ } = require('../lib/localDate');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

console.log('\n[1] 时区固定为中国（不依赖宿主机时区）');
ok(TZ === 'Asia/Shanghai', `时区常量 = ${TZ}`);

console.log('\n[2] 边界：北京 00:00–07:59 必须取「北京日」而不是 UTC 的「前一天」');
const boundary = [
  ['2026-09-17T00:00:00+08:00', '2026-09-17'],
  ['2026-09-17T00:30:00+08:00', '2026-09-17'],
  ['2026-09-17T07:59:59+08:00', '2026-09-17'],
  ['2026-09-17T08:00:00+08:00', '2026-09-17'],
  ['2026-09-17T18:39:00+08:00', '2026-09-17'],
  ['2026-09-17T23:59:59+08:00', '2026-09-17'],
  ['2026-09-18T00:00:01+08:00', '2026-09-18'],
];
let bOk = 0;
for (const [iso, expect] of boundary) {
  const got = localDate(new Date(iso));
  const utc = new Date(iso).toISOString().slice(0, 10);
  const flag = got === expect;
  if (flag) bOk++;
  console.log(`  ${flag ? '✓' : '✗'} ${iso} → 本地 ${got}（期望 ${expect}）| 旧 UTC 写法会给出 ${utc}${utc !== expect ? ' ← 错位' : ''}`);
}
ok(bOk === boundary.length, `全部 ${boundary.length} 个边界点正确（${bOk}/${boundary.length}）`);

console.log('\n[3] 等价性：与旧实现（宿主机本地）在 UTC+8 下逐点一致');
const legacy = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
let diff = 0, checked = 0;
const base = Date.parse('2026-01-01T00:00:00+08:00');
for (let i = 0; i < 2000; i++) {
  const d = new Date(base + i * 3600000 * 7 + (i % 13) * 777777);   // 每 7 小时 + 抖动，覆盖全时段
  checked++;
  if (legacy(d) !== localDate(d)) { diff++; if (diff <= 3) console.log(`     差异样本: ${d.toISOString()} legacy=${legacy(d)} new=${localDate(d)}`); }
}
ok(diff === 0, `${checked} 个采样点与旧实现完全一致（差异 ${diff} 个）→ 委托改造不改变现有行为`);

console.log('\n[4] 派生格式');
ok(localCompact(new Date('2026-09-17T00:30:00+08:00')) === '20260917', `localCompact = ${localCompact(new Date('2026-09-17T00:30:00+08:00'))}（东财 beg/end 用）`);
ok(localDateTime(new Date('2026-09-17T18:39:00+08:00')) === '2026-09-17 18:39', `localDateTime = ${localDateTime(new Date('2026-09-17T18:39:00+08:00'))}`);
ok(localDateTime(new Date('2026-09-17T00:05:00+08:00')) === '2026-09-17 00:05', `午夜用 h23 不出现 24:xx（${localDateTime(new Date('2026-09-17T00:05:00+08:00'))}）`);

console.log('\n[5] 时间戳（秒 / 毫秒自动识别）');
const ms = Date.parse('2026-09-17T00:30:00+08:00');
ok(localDateFromTs(ms) === '2026-09-17', `毫秒时间戳 → ${localDateFromTs(ms)}`);
ok(localDateFromTs(Math.floor(ms / 1000)) === '2026-09-17', `秒级时间戳 → ${localDateFromTs(Math.floor(ms / 1000))}`);
ok(localDateTimeFromTs(Math.floor(ms / 1000)) === '2026-09-17 00:30', `秒级时间戳 → 日期时间 ${localDateTimeFromTs(Math.floor(ms / 1000))}`);

console.log('\n[6] 异常输入不抛错');
ok(localDate('not-a-date') === '', '无法解析的字符串 → 空串');
ok(localDateFromTs(0) === '', '时间戳 0 → 空串');
ok(localDateFromTs(NaN) === '', 'NaN → 空串');

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
