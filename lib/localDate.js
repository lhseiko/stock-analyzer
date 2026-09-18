/**
 * 中国自然日 / 交易日日期工具（lib/localDate.js）
 * --------------------------------------------------------------
 * 背景（为什么需要它）：
 *   `new Date().toISOString().slice(0, 10)` 取的是 **UTC 日期**。在 UTC+8 下，
 *   每天北京时间 00:00–07:59 这段时间里，UTC 日期比北京日期晚一天，于是：
 *     - 交易台账/事件/缓存 的「今天」会写成昨天 → 记录错位、幂等判断失效；
 *     - 估值基准日、板块快照日期、新闻日期 也会整体前移一天。
 *   白天（08:00 之后）两者一致，所以这个 bug 长期隐蔽、只在早盘前段暴露。
 *
 * 设计要点：
 *   1. 时区固定为 Asia/Shanghai（UTC+8，无夏令时），**不依赖宿主机时区设置**；
 *      即使机器时区被改成 UTC 或别的时区，取到的仍是正确的中国自然日。
 *   2. 用 Intl.DateTimeFormat + formatToParts（缓存实例），避免自算偏移出错。
 *   3. hour 用 hourCycle 'h23'，保证午夜是 00:00 而不是 24:00。
 *
 * 用法：
 *   const { localDate, localDateTime, localCompact, localDateFromTs } = require('./localDate');
 *   localDate()                      // '2026-09-17'（此刻的中国自然日）
 *   localDate(new Date('...'))       // 指定时刻的中国自然日
 *   localDateTime(msOrDate)          // '2026-09-17 18:39'
 *   localCompact(msOrDate)           // '20260917'（东财等接口的 beg/end 参数）
 *   localDateFromTs(1758100000)      // 秒级时间戳 → '2026-09-17'（自动识别秒/毫秒）
 */
const TZ = 'Asia/Shanghai';

const _fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit',
  hour12: false, hourCycle: 'h23',
});

/** 归一化为 Date；无法解析时返回 null */
function _toDate(input) {
  if (input === undefined || input === null) return new Date();
  if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
  const d = new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

/** 拆出中国时区的年月日时分：{ year, month, day, hour, minute }；不可解析返回 null */
function bjParts(input) {
  const d = _toDate(input);
  if (!d) return null;
  const out = {};
  for (const p of _fmt.formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = p.value;
  }
  return out;
}

/** 'YYYY-MM-DD'（中国自然日） */
function localDate(input) {
  const p = bjParts(input);
  return p ? `${p.year}-${p.month}-${p.day}` : '';
}

/** 'YYYY-MM-DD HH:mm'（中国本地时间，用于展示） */
function localDateTime(input) {
  const p = bjParts(input);
  return p ? `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` : '';
}

/** 'YYYYMMDD'（东财等接口的日期参数格式） */
function localCompact(input) {
  const p = bjParts(input);
  return p ? `${p.year}${p.month}${p.day}` : '';
}

/** 时间戳 → 中国自然日；自动兼容秒级（<1e12）与毫秒级 */
function localDateFromTs(ts) {
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  return localDate(n < 1e12 ? n * 1000 : n);
}

/** 时间戳 → 'YYYY-MM-DD HH:mm'；自动兼容秒级与毫秒级 */
function localDateTimeFromTs(ts) {
  const n = Number(ts);
  if (!isFinite(n) || n <= 0) return '';
  return localDateTime(n < 1e12 ? n * 1000 : n);
}

module.exports = {
  TZ,
  bjParts,
  localDate,
  localDateTime,
  localCompact,
  localDateFromTs,
  localDateTimeFromTs,
};
