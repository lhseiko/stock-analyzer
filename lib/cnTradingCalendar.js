/**
 * cnTradingCalendar.js — 统一的 A 股交易日历（单一权威源）
 * --------------------------------------------------------------
 * 所有涉及「下一/上一交易日」「是否交易日」的判断都必须走这里，
 * 避免 sameDayJudgment 与 techFaceJudgment 各自维护一份休市表造成口径漂移
 * （历史教训：20261002c-2 仅跳过周末、未跳过法定节假日，导致长假期间误报/误生成）。
 *
 * 口径：交易日 = 周一至周五 且 非法定节假日（周末与法定节假日分别判定）。
 * 仅维护已公布的年份（当前 2026 + 已知的 2027 元旦）；未维护的年份退化为「仅跳过周末」，
 * 届时需在下方 HOLIDAY_RANGES 补入当年官方安排（来源：上交所《XXXX 年部分节假日休市安排》）。
 */
const { localDate } = require('./localDate');

// 每一年：若干 [起始, 结束] 闭区间（含端点，自动展开为每一天）。周末不在此列（由代码单独判定）。
const HOLIDAY_RANGES = {
  '2026': [
    ['2026-01-01', '2026-01-03'], // 元旦
    ['2026-02-15', '2026-02-23'], // 春节
    ['2026-04-04', '2026-04-06'], // 清明
    ['2026-05-01', '2026-05-05'], // 劳动节
    ['2026-06-19', '2026-06-21'], // 端午
    ['2026-09-25', '2026-09-27'], // 中秋
    ['2026-10-01', '2026-10-07'], // 国庆
  ],
  '2027': [
    // 仅 1/1 为工作日（1/2 周六、1/3 周日已由周末规则覆盖）；其余 2027 官方安排待公布后补入。
    ['2027-01-01', '2027-01-01'],
  ],
};

// 展开为 年份 -> Set(休市日)
const HOLIDAYS_BY_YEAR = {};
for (const year of Object.keys(HOLIDAY_RANGES)) {
  const s = new Set();
  for (const [a, b] of HOLIDAY_RANGES[year]) {
    for (let d = new Date(a + 'T00:00:00'); d <= new Date(b + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
      s.add(localDate(d));
    }
  }
  HOLIDAYS_BY_YEAR[year] = s;
}

function holidaySet(dateStr) {
  const y = String(dateStr).slice(0, 4);
  return HOLIDAYS_BY_YEAR[y] || new Set();
}

/** 是否 A 股交易日：周一~周五 且 非法定节假日 */
function isTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return false;
  const dow = d.getDay();
  if (dow === 0 || dow === 6) return false;                       // 周末
  if (holidaySet(dateStr).has(localDate(d))) return false;        // 法定节假日
  return true;
}

/** 下一个交易日（跳过周末 + 法定节假日；最多向后看 30 天） */
function nextTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  for (let i = 0; i < 30; i++) {
    d.setDate(d.getDate() + 1);
    const ds = localDate(d);
    if (isTradingDay(ds)) return ds;
  }
  return dateStr;
}

/** 上一个交易日（跳过周末 + 法定节假日；最多向前看 30 天） */
function previousTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  for (let i = 0; i < 30; i++) {
    d.setDate(d.getDate() - 1);
    const ds = localDate(d);
    if (isTradingDay(ds)) return ds;
  }
  return dateStr;
}

/**
 * 「当前应更新到的交易日」：当天是交易日 → 当天；非交易日（周末/节假日）→ 最近一个交易日。
 * 20261024k：工作台统一口径——**非交易日无法获取「当日」数据属正常**，应沿用最近交易日数据，
 * 不得因此判定「数据不足」。所有「数据是否最新」的判断都应以此为准，而不是字面 today。
 */
function asOfTradingDate(dateStr) {
  const d = dateStr || localDate();
  return isTradingDay(d) ? d : previousTradingDay(d);
}

/**
 * 数据是否已更新到「当前应更新到的交易日」。
 * 非交易日沿用最近交易日数据 → 视为最新（不算缺数据）；只有严格落后于最近交易日才算陈旧。
 * @param {string} lastDate 数据最新日期 YYYY-MM-DD
 * @param {string} [dateStr] 参照日（默认今天）
 */
function isDataCurrent(lastDate, dateStr) {
  if (!lastDate) return false;
  return String(lastDate) >= asOfTradingDate(dateStr);
}

module.exports = { isTradingDay, nextTradingDay, previousTradingDay, asOfTradingDate, isDataCurrent, HOLIDAYS_BY_YEAR, HOLIDAY_RANGES };
