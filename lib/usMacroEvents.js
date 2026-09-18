/**
 * 美国经济数据 / 事件（策划式事件卡片）
 * --------------------------------------------------------------
 * 设计：东方财富数据中心无美国宏观时间序列稳定报表，akshare 亦未安装；
 * 美国宏观（FOMC / CPI / 非农等）采用「策划式事件卡片」——人工维护近期
 * 高权重美国宏观事件及解读，随事件落地更新。
 *
 * 与「每日宏观 & 政策」卡片同源展示，并作为「市场情绪提醒」中
 * 「美国宏观事件情绪因子」的输入数据源（见 lib/macroSentimentFactors.js）。
 */
const EVENTS = [
  {
    id: 'us-fomc-2026-09-17',
    dateZh: '2026-09-17 凌晨 02:00（北京时间）',
    dateUs: '2026-09-16（美东）',
    title: '美联储 FOMC 利率决议 + 鲍威尔新闻发布会',
    category: '美联储',
    level: 'high',
    impact: 'bearish',
    summary: '本周全球市场最核心的风险事件。市场对加息路径的担忧仍在，部分资金已选择在议息会议前提前减仓避险。',
    note: '事件预告（非已公布数据）；决议落地后根据声明与点阵图更新解读。',
  },
  {
    id: 'us-cpi-2026-09',
    dateZh: '2026-09 月中旬（待官方确认）',
    dateUs: '约 2026-09 中旬',
    title: '美国 8 月 CPI / 核心 CPI',
    category: '通胀',
    level: 'high',
    impact: 'conditional',
    summary: '若 CPI 超预期反弹，将强化加息/鹰派路径担忧，短期偏空全球风险资产；若低于预期，则缓解担忧、偏多。',
    note: '事件预告（非已公布数据），以实际公布值为准。',
  },
  {
    id: 'us-nfp-2026-09',
    dateZh: '2026-09 初（已公布，数值待确认）',
    dateUs: '约 2026-09-04',
    title: '美国 8 月非农就业',
    category: '就业',
    level: 'medium',
    impact: 'conditional',
    summary: '就业强弱影响降息/加息预期：强就业支撑经济但也推迟降息，弱就业提升降息预期；对风险偏好的方向取决于市场叙事。',
    note: '事件预告（非已公布数据）。',
  },
];

function getUsMacroEvents() {
  return EVENTS.map(e => ({ ...e }));
}

module.exports = { getUsMacroEvents, US_MACRO_EVENTS: EVENTS };
