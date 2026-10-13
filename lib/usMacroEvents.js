/**
 * 美国经济数据 / 事件（三级数据源：三值复盘 → 排期预告 → 内置兜底）
 * --------------------------------------------------------------
 * 20261013c：升级为「预告 + 落地复盘（超预期/不及预期 → 影响分析）」——
 *   ① 主源 lib/usMacroResults.js：华尔街见闻宏观日历，三值（公布/预期/前值）齐全，
 *      覆盖 CPI/PPI/非农/失业率/FOMC/零售/ISM，落地后判定超/不及预期并给方向影响；
 *   ② 排期兜底 lib/usMacroCalendar.js：FedRateCalc 汇总表（BLS/美联储官方排期），
 *      仅日期无三值，华尔街见闻不可达时保证至少能显示排期；
 *   ③ 最终兜底：内置策划清单（FALLBACK_EVENTS）。
 *   统一过滤：released 事件公布后保留 7 天、upcoming 事件按北京自然日过期剔除。
 *
 * 与「每日宏观 & 政策」卡片同源展示，并作为「市场情绪提醒」中
 * 「美国宏观事件情绪因子」的输入数据源（见 lib/macroSentimentFactors.js）。
 */
const fs = require('fs');
const path = require('path');
const { localDate } = require('./localDate');
const { refreshUsMacroCalendar } = require('./usMacroCalendar');
const { refreshUsMacroResults } = require('./usMacroResults');

// ---- 内置策划清单（双源都抓取失败时的最终兜底；日期来源：BLS 官方排期 + 美联储官网 2026 FOMC 日历）----
const FALLBACK_EVENTS = [
  { id: 'us-cpi-202609', date: '2026-10-14', dateZh: '2026-10-14 20:30（北京时间）', dateUs: '2026-10-14 08:30（美东）', title: '美国 9 月 CPI / 核心 CPI', category: '通胀', level: 'high', impact: 'neutral', summary: '美国通胀已连续数月明显高于 2% 目标（8 月 CPI 同比 3.4%）。若 9 月 CPI 继续超预期，将强化「更高更久」利率路径担忧、偏空；低于预期则缓解、偏多。', note: '事件预告（内置清单兜底），以 BLS 官方公布值为准。' },
  { id: 'us-fomc-20261028', date: '2026-10-29', dateZh: '2026-10-29 凌晨 02:00（北京时间）', dateUs: '2026-10-28 14:00（美东）', title: '美联储 FOMC 利率决议（10月会议，无点阵图）', category: '美联储', level: 'high', impact: 'neutral', summary: '9 月会议已加息 25bp 至 3.75%-4.00%。本次会议无点阵图，市场关注声明是否暗示继续加息。', note: '事件预告（内置清单兜底），决议落地后根据声明更新解读。' },
  { id: 'us-nfp-202610', date: '2026-11-06', dateZh: '2026-11-06 21:30（北京时间）', dateUs: '2026-11-06 08:30（美东）', title: '美国 10 月非农就业', category: '就业', level: 'medium', impact: 'neutral', summary: '9 月非农仅 +29k、失业率 4.2%。就业强弱直接影响利率路径。', note: '事件预告（内置清单兜底）。' },
  { id: 'us-cpi-202610', date: '2026-11-10', dateZh: '2026-11-10 21:30（北京时间）', dateUs: '2026-11-10 08:30（美东）', title: '美国 10 月 CPI / 核心 CPI', category: '通胀', level: 'high', impact: 'neutral', summary: '10 月通胀读数是 12 月 FOMC（含点阵图）前的关键输入。', note: '事件预告（内置清单兜底）。' },
  { id: 'us-fomc-20261209', date: '2026-12-10', dateZh: '2026-12-10 凌晨 02:00（北京时间）', dateUs: '2026-12-09 14:00（美东）', title: '美联储 FOMC 利率决议（12月会议，含点阵图）', category: '美联储', level: 'high', impact: 'neutral', summary: '年末最重要会议：公布经济预测摘要（SEP）与点阵图。', note: '事件预告（内置清单兜底）。' },
];

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', p), 'utf8'));
  } catch (e) { return null; }
}

function readResultsCache() { return readJson('us_macro_results_cache.json'); }
function readCalendarCache() { return readJson('us_macro_calendar_cache.json'); }

function dayDiff(a, b) { // a,b: 'YYYY-MM-DD'
  return Math.round((new Date(a + 'T00:00:00+08:00') - new Date(b + 'T00:00:00+08:00')) / 86400000);
}

// 统一过滤 + 排序 + 状态补充：
//  - released（已公布）：公布后 14 天内保留（超预期/不及预期复盘窗口），更早剔除；
//  - upcoming（预告）：事件日 >= 今天保留。
//  - 排期/内置事件无 status，按 date 判定（date>=today 视为 upcoming）。
function applyFilter(events) {
  const today = localDate();
  const kept = (events || []).filter(e => {
    if (e.status === 'released') {
      const since = dayDiff(today, e.date); // 今天距公布日的天数（正数=已公布 N 天）
      return since >= 0 && since <= 14;
    }
    return e.date >= today;
  });
  kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return kept.map(e => {
    const o = { ...e };
    if (o.status === 'released') {
      o.daysSince = dayDiff(today, e.date);
    } else {
      o.status = 'upcoming';
      o.daysLeft = dayDiff(e.date, today);
    }
    return o;
  });
}

/**
 * 同步读取事件清单（情绪因子同步调用，必须保持同步）：
 *   华尔街见闻三值缓存 → FedRateCalc 排期缓存 → 内置清单；统一过滤。
 */
function getUsMacroEvents() {
  const results = readResultsCache();
  const calendar = readCalendarCache();
  let source;
  if (results && Array.isArray(results.events) && results.events.length) {
    source = results.events;
  } else if (calendar && Array.isArray(calendar.events) && calendar.events.length) {
    source = calendar.events;
  } else {
    source = FALLBACK_EVENTS;
  }
  return applyFilter(source);
}

/**
 * 路由调用前触发自动刷新（12h TTL，失败静默回退缓存/内置清单）。
 * 并行抓两源；返回 { ok, stale, source, hasResults } 供路由标注。
 */
async function refreshUsMacroEvents(opts) {
  const [r, c] = await Promise.all([
    refreshUsMacroResults(opts || {}).catch(e => ({ ok: false, stale: false, source: '', warn: e.message })),
    refreshUsMacroCalendar(opts || {}).catch(e => ({ ok: false, stale: false, source: '', warn: e.message })),
  ]);
  const resultsOk = r && r.ok && Array.isArray(r.events) && r.events.length;
  if (resultsOk) {
    return { ok: true, stale: !!r.stale, source: r.source, hasResults: true, warn: r.warn };
  }
  if (c && c.ok && Array.isArray(c.events) && c.events.length) {
    return { ok: true, stale: !!c.stale, source: c.source, hasResults: false, warn: c.warn };
  }
  return { ok: false, stale: false, source: '', hasResults: false, warn: (r.warn || c.warn || '') };
}

module.exports = { getUsMacroEvents, refreshUsMacroEvents, US_MACRO_EVENTS: FALLBACK_EVENTS };
