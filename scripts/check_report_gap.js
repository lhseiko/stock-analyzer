// check_report_gap.js — 三季报披露缺口筛查（20261025，用户要求）
// 对自选股池逐一比对：网上公告是否已发布《2026 年第三季度报告》 vs 本地资料库（docStore）是否已持有。
// 可重复执行：node scripts/check_report_gap.js
'use strict';
const { searchAnnouncementsByCode } = require('../lib/cnscraperAdapter');
const { hasReportDoc, normSymbol } = require('../lib/reportSync');

const POOL = [
  ['sh600909', '华安证券'], ['sz000783', '长江证券'], ['sh688289', '圣湘生物'], ['sh603288', '海天味业'],
  ['sz000902', '新洋丰'], ['sz002643', '万润股份'], ['sz300232', '洲明科技'], ['sh601318', '中国平安'],
];
const YEAR = '2026';
// 三季报标题识别（20261025 修正）：仅认本公司正式季报——
// ① 东财公告标题格式「公司名:2026年第三季度报告」，冒号后直接接年份；
// ② 兜底：含「2026年第三季度报告」但排除「关于…」转述类（如「关于披露平安银行2026年
//    第三季度报告的公告」是子公司季报转述，不是本公司季报）与业绩说明会/预告类。
const Q3_MAIN_RE = new RegExp('[:：]\\s*' + YEAR + '\\s*年第三季度报告');
const Q3_LOOSE_RE = new RegExp(YEAR + '\\s*年?(第三季度报告|三季度报告|三季报)');
const Q3_EXCLUDE_RE = /关于|业绩说明会|业绩预告|摘要$|英译|英文版/;

(async () => {
  const gaps = [], synced = [], nodisc = [], errors = [];
  const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [sym, name] of POOL) {
    try {
      const ann = await searchAnnouncementsByCode(sym, 40);
      const items = (ann && ann.ok && Array.isArray(ann.items)) ? ann.items : [];
      const q3 = items.filter(x => {
        if (!x || !x.title) return false;
        const t = String(x.title).replace(/\s+/g, '');
        if (!Q3_LOOSE_RE.test(t)) return false;
        // 本公司季报判定：冒号后正文以「2026年三季度报告」（兼容 第三季度/三季度/三季报）开头，
        // 或以本公司名开头紧跟年份报告；「平安银行股份有限公司2026年第三季度报告」这类
        // 子公司/兄弟公司季报转述正文另带公司名 → 排除
        const body = t.split(/[:：]/).slice(1).join(':');
        const bodyQ3 = new RegExp('^' + YEAR + '\\s*年(第三季度报告|三季度报告|三季报)');
        const selfQ3 = new RegExp('^' + escRe(name) + '\\s*' + YEAR + '\\s*年(第三季度报告|三季度报告|三季报)');
        return bodyQ3.test(body) || selfQ3.test(body);
      });
      if (!q3.length) {
        nodisc.push(`${name}（${sym}）：公告前 40 条未见 ${YEAR} 三季报`);
        continue;
      }
      const latest = q3[0];
      const held = hasReportDoc(normSymbol(sym), 'quarterly', YEAR);
      if (held) synced.push(`${name}（${sym}）：已披露（${latest.date || '日期未知'}）且资料库已持有`);
      else gaps.push(`${name}（${sym}）：已披露「${String(latest.title).slice(0, 40)}」${latest.date ? '· ' + latest.date : ''}，本地资料库未持有`);
    } catch (e) {
      errors.push(`${name}（${sym}）：公告源获取失败 — ${e.message}`);
    }
  }
  console.log('\n===== 三季报缺口（网上已披露、本地未持有）=====');
  gaps.length ? gaps.forEach(x => console.log('  ⚠ ' + x)) : console.log('  （无）');
  console.log('\n===== 已披露且本地已持有 =====');
  synced.length ? synced.forEach(x => console.log('  ✓ ' + x)) : console.log('  （无）');
  console.log('\n===== 未见三季报披露 =====');
  nodisc.forEach(x => console.log('  · ' + x));
  if (errors.length) {
    console.log('\n===== 公告源获取失败（网络/通道）=====');
    errors.forEach(x => console.log('  ✗ ' + x));
  }
})();
