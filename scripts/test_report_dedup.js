/**
 * scripts/test_report_dedup.js —— 资料库去重键（[20261117a]）回归测试
 * ---------------------------------------------------------------
 * 只测纯函数，不读写 data/index.json，可随时运行：
 *   node scripts/test_report_dedup.js
 *
 * 覆盖三件事：
 *  1) 同一份公告、两个通道不同命名的文件 → 必须判为同一键（会去重）
 *  2) 同一报告期的「全文 / 摘要 / 英文版 / 港股版」→ 必须判为不同键（不能误删）
 *  3) Q1 与 Q3 同一年 → 必须判为不同键（不能合并季度）
 */
'use strict';

const assert = require('assert');
const rs = require('../lib/reportSync');

let pass = 0;
const fail = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { fail.push(`✗ ${name}\n    ${e.message}`); }
}

const key = (code, file) => `${code}|${rs.reportPeriodKeyOf(file)}|${rs.docVariantOf(file)}`;

// ---------------- 1) 应当合并（同键） ----------------
const shouldMerge = [
  ['600909', '600909_2026-03-27_华安证券股份有限公司2025年度报告.pdf',
             '600909_2026-03-27_华安证券_华安证券股份有限公司2025年度报告.pdf'],
  ['600909', '600909_2022-03-31_华安证券股份有限公司2021年年度报告.pdf',
             '600909_2022-03-31_600909_华安证券股份有限公司2021年年度报告.pdf'],
  ['603288', '603288_2023-04-26_海天味业2022年年度报告.pdf',
             '603288_2023-04-26_海天味业_海天味业2022年年度报告.pdf'],
  ['600460', '600460_2024-04-09_杭州士兰微电子股份有限公司2023年年度报告.pdf',
             '600460_2024-04-09_士兰微_杭州士兰微电子股份有限公司2023年年度报告.pdf'],
  ['000783', '000783_2023-10-31_2023年三季度报告.pdf',
             '000783_2023-10-31_长江证券_2023年三季度报告.pdf'],
];
shouldMerge.forEach(([code, a, b], i) => check(`合并用例${i + 1}`, () => {
  assert.strictEqual(key(code, a), key(code, b), `应同键:\n  A=${key(code, a)}\n  B=${key(code, b)}`);
}));

// ---------------- 2) 不应合并（不同键） ----------------
const shouldSplit = [
  ['603288', '603288_2026-03-27_海天味业2025年年度报告摘要.pdf',
             '603288_2026-03-27_海天味业2025年年度报告.pdf', '摘要 vs 全文'],
  ['002415', '002415_2024-04-27_2023年年度报告_英文版.pdf',
             '002415_2024-04-27_2023年年度报告.pdf', '英文版 vs 中文版'],
  ['688981', '688981_2024-04-10_港股公告_2023年报.pdf',
             '688981_2024-04-10_中芯国际2023年年度报告.pdf', '港股公告 vs A股年报'],
  ['603288', '603288_2026-04-28_海天味业2026年第一季度报告.pdf',
             '603288_2026-10-29_海天味业2026年第三季度报告.pdf', 'Q1 vs Q3'],
  ['603288', '603288_2026-03-27_海天味业2025年年度报告.pdf',
             '603288_2026-08-27_海天味业2026年半年度报告.pdf', '年报 vs 半年报'],
  ['601318', '2023H1.pdf', '2023Q1.pdf', '同股 H1 vs Q1'],
  ['601318', '2023Q1.pdf', '2023Q3.pdf', '同股 Q1 vs Q3'],
  ['601318', '2023H1.pdf', '2024H1.pdf', 'H1 跨年'],
];
shouldSplit.forEach(([code, a, b, why], i) => check(`拆分用例${i + 1}（${why}）`, () => {
  assert.notStrictEqual(key(code, a), key(code, b), `不应同键（${why}）:\n  A=${key(code, a)}\n  B=${key(code, b)}`);
}));

// ---------------- 3) 报告期解析 ----------
check('「2025年度报告」缺「年」字也能解析为 annual:2025', () => {
  assert.strictEqual(rs.reportPeriodKeyOf('600909_2026-03-27_华安证券股份有限公司2025年度报告.pdf'), 'annual:2025');
});
check('「2025年年度报告」解析为 annual:2025', () => {
  assert.strictEqual(rs.reportPeriodKeyOf('603288_2026-03-27_海天味业2025年年度报告.pdf'), 'annual:2025');
});
check('「2026年中期报告」解析为 semi:2026', () => {
  assert.strictEqual(rs.reportPeriodKeyOf('601318_2026-08-15_中国平安2026年中期报告.pdf'), 'semi:2026');
});
check('「2023年三季度报告」解析为 q3:2023', () => {
  assert.strictEqual(rs.reportPeriodKeyOf('000783_2023-10-31_2023年三季度报告.pdf'), 'q3:2023');
});
check('无法解析报告期时回落公告年', () => {
  assert.strictEqual(rs.reportPeriodKeyOf('600909_2026-03-27_临时公告.pdf'), 'undated:2026');
});
check('官方原文命名 2023H1 → semi:2023', () => {
  assert.strictEqual(rs.reportPeriodKeyOf('2023H1.pdf'), 'semi:2023');
});
check('官方原文命名 2023Q1 → q1:2023', () => {
  assert.strictEqual(rs.reportPeriodKeyOf('2023Q1.pdf'), 'q1:2023');
});
check('官方原文命名 2023Q3 → q3:2023', () => {
  assert.strictEqual(rs.reportPeriodKeyOf('2023Q3.pdf'), 'q3:2023');
});

// ---------------- 4) 变体判定 ----------
check('摘要变体', () => assert.strictEqual(rs.docVariantOf('2025年年度报告摘要.pdf'), 'summary'));
check('英文版变体', () => assert.strictEqual(rs.docVariantOf('2022年年度报告_英文版.pdf'), 'en'));
check('港股公告变体', () => assert.strictEqual(rs.docVariantOf('港股公告_2023年报.pdf'), 'hk'));
check('H股公告变体', () => assert.strictEqual(rs.docVariantOf('H股公告-2024年年度报告.pdf'), 'hk'));
check('普通全文变体', () => assert.strictEqual(rs.docVariantOf('华安证券股份有限公司2025年度报告.pdf'), 'full'));

// ---------------- 5) docDedupKeyOf 与直接拼键一致 ----------
check('docDedupKeyOf 与拼键口径一致', () => {
  const doc = { stockCode: '603288', fileName: '603288_2023-04-26_海天味业_海天味业2022年年度报告.pdf', title: '603288_2023-04-26_海天味业_海天味业2022年年度报告' };
  assert.strictEqual(rs.docDedupKeyOf(doc), key('603288', doc.fileName));
});

// ---------------- 汇总 --------------
const total = pass + fail.length;
console.log(`\n共 ${total} 项：通过 ${pass}，失败 ${fail.length}`);
if (fail.length) {
  for (const f of fail) console.log(f);
  process.exit(1);
}
console.log('全部通过');
