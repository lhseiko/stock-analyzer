#!/usr/bin/env node
/**
 * scripts/test_factor_corr_preserve.js — backlog ⑤ 整改 1–4 守卫（零网络）
 * @test-scope: local
 * 守护点：
 *   1. buildReport() 模板状态同步：数据源标注、局限 1「已完成」、Backlog [x]（防重跑写回旧状态）；
 *   2. preserveBusinessBlocks() 重跑不丢【业务解读】块：逐字保留、占位符消失、数字区仍来自脚本重算；
 *   3. 保留边界：占位符不当业务结论、占位符多于块时不伪造、多簇按序回填、幂等；
 *   4. 报告整改结果：H1 方向订正、① 已验证、两处业务断言按领域人裁决改写、删草稿标记转「可归档」；
 *   5. 复核档案一字不改（md5 钉死历史记录）；
 *   6. N6（2026-11-13）：truncateToAsOf 保留 .meta.source、buildReport 逐股写出实际取数源、
 *      数值计算零影响、历史报告「取数源未记录，待补」不被冒充。
 * 边界：零网络；只读本地文件，不写盘。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }

const ROOT = path.join(__dirname, '..');
const REPORT = fs.readFileSync(path.join(ROOT, 'docs', 'logic', 'factor-corr-20261112.md'), 'utf8');
const REVIEW = fs.readFileSync(path.join(ROOT, 'docs', 'logic', 'factor-corr-20261112-review-20261113.md'), 'utf8');
const REVIEW_ARCHIVE = fs.readFileSync(path.join(ROOT, 'docs', 'logic', 'factor-corr-20261112-review-20261112.md'), 'utf8');
const {
  buildReport, FACTOR_KEYS, BIZ_PLACEHOLDER,
  extractBusinessBlocks, preserveBusinessBlocks,
  REVIEW_SECTION_HEAD, REVIEW_PLACEHOLDER, extractReviewNotesBlock,
  truncateToAsOf, computeFactors,
} = require('./analyze_factor_corr');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'analyze_factor_corr.js'), 'utf8');
// 报告正文（§1–Backlog），不含末尾「附：复核意见摘要」独立区块；
// 逐字摘录 A 段引用了历史错误原文，正文状态类断言须按此范围扫描，避免语义误判。
// 须放在解构之后：REVIEW_SECTION_HEAD 为 const，提前引用会触发暂时性死区。
const BODY = REPORT.slice(0, REPORT.indexOf('\n' + REVIEW_SECTION_HEAD));

// ---- 构造 buildReport 的确定性输入（零网络，不取真实行情） ----
const n = FACTOR_KEYS.length;
const P = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
const S = P.map(r => r.slice());
const clusters = [{ members: ['mom_20d', 'ma_bias', 'drawdown_20d'], avgAbs: 0.725, minAbsW: 0.602 }];
const generated = buildReport({
  asOf: '2026-11-12', symbols: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'],
  rowsTotal: 1840, validSamples: 1840, P, S, clusters,
  perSymbolMissing: {}, lastDateStaleNote: '',
});

console.log('[test_factor_corr_preserve] 模板状态同步（防重跑写回旧状态）');
ok(generated.includes('实际数据源标注') && generated.includes('取数源未记录，待补'), '模板含数据源标注「取数源未记录，待补」');
ok(generated.includes('docs/logic/factor-corr-windows-20261112.md §1.1'), '模板数据源标注交叉引用多窗口 §1.1（asOf 动态拼接）');
ok(generated.includes('不可等同于本报告'), '模板明确多窗口降级源不可等同于单窗口源');
ok(generated.includes('局限 1（窗口敏感）') && generated.includes('**已完成**') && !generated.includes('本轮未实现'), '模板局限 1 已改「已完成」，无「本轮未实现」残留');
ok(generated.includes('- [x] 多窗口对照') && !generated.includes('- [ ] 多窗口对照'), '模板 Backlog 多窗口条已勾 [x]');
ok(generated.includes(BIZ_PLACEHOLDER), '模板 §4 输出业务解读占位符（供保留函数回填）');
ok((generated.split(BIZ_PLACEHOLDER).length - 1) === 1, '单簇场景恰好 1 个占位符');

console.log('[test_factor_corr_preserve] 重跑不丢业务解读块');
const blocks = extractBusinessBlocks(REPORT);
ok(blocks.length === 1, `从现行报告提取到 ${blocks.length} 个业务解读块（期望 1）`);
ok(blocks[0].includes('可归档') && blocks[0].includes('补录'), '业务解读块含「可归档」与「补录」');
ok(blocks[0].includes('H1') && blocks[0].includes('① **已验证**') && blocks[0].includes('补录'), '业务解读块含整改后的 H1 / ① 已验证 / 补录');
ok(!blocks[0].includes('复核存疑') && !blocks[0].includes('H2 门槛') && !blocks[0].includes('整改留痕'), '业务解读块内无 agent 旁注（领域人判断独立性不受影响）');
const merged = preserveBusinessBlocks(generated, REPORT);
ok(!merged.includes(BIZ_PLACEHOLDER), '回填后占位符消失（1 簇 1 块）');
ok(merged.includes(blocks[0]), '业务解读块逐字保留（重跑不擦除）');
ok(merged.includes('## 3. 相关矩阵摘要') && merged.includes('## 5. 结论与局限') && merged.includes('## Backlog'), '回填后报告章节结构完整');
// 数字区仍来自 buildReport 重算：generated 中从 §3 到 §4 之间的表格片段原样存在
const numericPart = generated.slice(generated.indexOf('## 3.'), generated.indexOf('## 4.'));
ok(merged.includes(numericPart), '§3 数字区与脚本重算逐字一致（业务文字未污染数值段）');
ok(merged.includes('簇内平均 |Pearson|：0.725') && merged.includes('簇内最小 |Pearson|（最弱边）：0.602'), '§4 簇表数值由脚本重算（0.725 / 0.602）');
ok(preserveBusinessBlocks(generated, merged) === merged, '幂等：以回填结果作既有报告再重跑一次，输出不变');

console.log('[test_factor_corr_preserve] 复核意见摘要独立区块（10:4x 旁注移出正文）');
ok(generated.includes(REVIEW_PLACEHOLDER), '模板末尾输出复核意见区块占位符');
const reviewBlock = extractReviewNotesBlock(REPORT);
ok(!!reviewBlock && reviewBlock.startsWith(REVIEW_SECTION_HEAD), `现行报告末尾存在独立区块（${reviewBlock ? reviewBlock.length : 0} 字符）`);
ok(!!reviewBlock && reviewBlock.includes('非报告原文') && reviewBlock.includes('领域人书面裁决「有条件通过」') && reviewBlock.includes('已转「可归档」'), '独立区块标注「非报告原文 / 领域人裁决有条件通过 / 已转可归档」');
ok(!!reviewBlock && reviewBlock.includes('5ee90458db899209bf09033ce4a8e8d9'), '独立区块标注最新复核档案来源与 md5（Trea 2026-11-13）');
ok(crypto.createHash('md5').update(REVIEW_ARCHIVE).digest('hex') === '9631f759114758ad214d34fc44b25a5f', '凌霄渡原档归档 md5 不变（9631f759…，审计材料）');
ok(!!reviewBlock && reviewBlock.includes('领域人裁决（2026-11-13，书面）') && reviewBlock.includes('ITEM 3') && reviewBlock.includes('ITEM 4'), '独立区块含领域人书面裁决与 ITEM 3/4 逐字依据');
ok(!!reviewBlock && reviewBlock.includes('不设 70% 门槛') && reviewBlock.includes('未采纳'), '独立区块载明裁决不设门槛、agent 建议未采纳');
ok(!!reviewBlock && reviewBlock.includes('整改留痕') && reviewBlock.includes('移至本独立区块'), '独立区块含整改留痕与旁注移出说明');
ok(!merged.includes(REVIEW_PLACEHOLDER) && !!reviewBlock && merged.includes(reviewBlock), '重跑回填复核意见区块全文，占位符消失');
ok(merged.indexOf('## 4.') < merged.indexOf(REVIEW_SECTION_HEAD), '独立区块位于 §4 之后（正文与批注物理分离）');
ok(preserveBusinessBlocks(generated, merged) === merged, '幂等：含复核意见区块再重跑一次输出不变');
ok(extractReviewNotesBlock(generated) === null, '模板占位符不被误判为既有复核意见区块');

console.log('[test_factor_corr_preserve] 复核意见 A 段逐字摘录（11:1x 去二次概括）');
ok(!!reviewBlock && reviewBlock.includes('<!-- REVIEW_VERBATIM_BEGIN -->') && reviewBlock.includes('<!-- REVIEW_VERBATIM_END -->'), 'A 段带逐字摘录起止标记');
// 隔离说明位于 BEGIN 之后、围栏之前，故按 ~~~markdown 围栏定位逐字区，不按 BEGIN 拼接。
const vbRaw = (reviewBlock || '').split('~~~markdown\n')[1];
const verbatim = vbRaw ? vbRaw.split('\n~~~\n<!-- REVIEW_VERBATIM_END -->')[0] : null;
ok(!!verbatim && verbatim.replace(/^\s+|\s+$/g, '') === REVIEW.replace(/^\s+|\s+$/g, ''), 'A 段与最新复核档案(Trea)全文逐字相等（首尾空白归一化，未改写、未浓缩，机器可验）');
ok(!!reviewBlock && reviewBlock.includes('结论：有条件通过') && reviewBlock.includes('VERDICT:') && reviewBlock.includes('ITEM 3 ·'), 'A 段含「有条件通过」结论原文与 14 项 ITEM 判定');
ok(!!reviewBlock && reviewBlock.includes('### B. agent 整改留痕与建议（非复核意见）'), 'B 段明确标注 agent 产出、与复核意见分离');
ok(!!reviewBlock && reviewBlock.includes('路径 A（接受「待补」可归档）') && reviewBlock.includes('路径 B（不接受，要求先补）'), 'N6 送审两分支已写入 B 段');

console.log('[test_factor_corr_preserve] 保留边界（不伪造业务结论）');
ok(extractBusinessBlocks(generated).length === 0, '模板占位符不被误判为业务解读块');
ok(preserveBusinessBlocks(generated, '') === generated, '既有报告为空 → 原样返回生成内容（首次生成）');
ok(preserveBusinessBlocks(generated, generated) === generated, '既有报告仅含占位符 → 不伪造业务结论');
const twoSlots = generated.replace(BIZ_PLACEHOLDER, BIZ_PLACEHOLDER + '\n\n### 簇 2：a · b\n' + BIZ_PLACEHOLDER);
const partial = preserveBusinessBlocks(twoSlots, REPORT);
ok(partial.includes(blocks[0]) && partial.includes(BIZ_PLACEHOLDER), '2 占位符 / 1 既有块 → 按序回填第 1 个，多余占位符保留');
const twoBlocks = blocks[0] + '\n\n### 簇 2：a · b\n' + blocks[0].replace('可归档', '可归档（簇2）');
const both = preserveBusinessBlocks(twoSlots, twoBlocks);
ok(!both.includes(BIZ_PLACEHOLDER) && both.includes('可归档（簇2）'), '2 占位符 / 2 既有块 → 按出现顺序一一回填');

console.log('[test_factor_corr_preserve] 报告整改结果（1–3 已改 / 5–6 原文保留）');
ok(BODY.length > 0 && BODY.includes('## 5. 结论与局限') && !BODY.includes('### A.'), 'BODY 界定为报告正文（不含末尾独立区块）');
ok(!!reviewBlock && reviewBlock.includes('回撤随上涨放大') && !BODY.includes('回撤随上涨放大'), 'A 段引用的历史错误原文不构成正文旧状态残留（扫描范围按语义隔离）');

ok(!BODY.includes('回撤随上涨放大'), 'H1 旧错误方向「回撤随上涨放大」已消除');
ok(BODY.includes('drawdown_20d 数值趋近 0（回撤幅度收窄'), 'H1 已订正为「数值趋近 0 / 回撤幅度收窄」');
ok(BODY.includes('与 §3 的 +0.602 / +0.737 正相关一致'), 'H1 订正附 §3 实证符号依据');
ok(BODY.includes('① **已验证**') && BODY.includes('簇数 1→1→1'), '待验证 ① 改为「已验证」并引用多窗口 §2');
ok(BODY.includes('局限 1（窗口敏感）') && BODY.includes('**已完成**') && !BODY.includes('本轮未实现'), '§5 局限 1 状态同步');
ok(BODY.includes('- [x] 多窗口对照') && !BODY.includes('- [ ] 多窗口对照'), 'Backlog 多窗口条勾 [x]');
ok(BODY.includes('实际数据源标注') && BODY.includes('腾讯日K(ifzq.gtimg.cn) ×8') && BODY.includes('截断末根核验'), '数据源如实写腾讯日K ×8（N6 重跑自动补全，非待补、非冒充）');
ok(BODY.includes('相关性高，是否独立待验证') && !BODY.includes('不构成独立信息增益'), '第5项按领域人裁决改为「相关性高，是否独立待验证」');
ok(BODY.includes('是否可压缩为单一潜因子待验证') && !BODY.includes('该簇可压缩为单一'), '第6项 H2 按裁决改为「是否可压缩为单一潜因子待验证」');
ok(REPORT.includes('领域人裁决（2026-11-13，书面）') && REPORT.includes('有条件通过') && REPORT.includes('R²≈0.70'), 'B 段留痕领域人书面裁决、有条件通过结论与逐字依据');
ok(REPORT.includes('不设 70% 门槛') && REPORT.includes('未采纳'), 'H2 门槛按裁决不设 70%、agent 建议未采纳');
ok(!BODY.includes('AI 草稿') && BODY.includes('可归档') && !BODY.includes('待领域人确认/修正'), '正文已删草稿标记、转「可归档」（A 段历史摘录不在 BODY 内）');
ok(REPORT.includes('整改留痕（2026-11-13') && REPORT.includes('非领域人签字') && REPORT.includes('路径 A') && REPORT.includes('归档后补项'), '报告内留痕「谁改、依据哪条复核意见」+ 领域人取 N6 路径 A');

console.log('[test_factor_corr_preserve] N6 · 取数源可追溯（2026-11-13）');
// 构造带 .meta 的桩 bars（模拟 getHistory 返回），验证纯函数不再丢数据源标注
const bars = [
  { date: '2026-11-10', open: 9, close: 10, volume: 100 },
  { date: '2026-11-11', open: 10, close: 11, volume: 120 },
  { date: '2026-11-12', open: 11, close: 12, volume: 130 },
  { date: '2026-11-13', open: 12, close: 13, volume: 140 },
];
bars.meta = { source: '腾讯日K(ifzq.gtimg.cn)', volumeUnit: '手' };
const truncBars = truncateToAsOf(bars, '2026-11-12');
const plainBars = bars.slice(0, 3);
ok(truncBars.length === 3 && truncBars[2].date === '2026-11-12', 'truncateToAsOf 截断口径不变（元素与顺序不变）');
ok(!!truncBars.meta && truncBars.meta === bars.meta && truncBars.meta.source === '腾讯日K(ifzq.gtimg.cn)', 'N6 根因修复：截断后仍带原 .meta.source（逐股取数源不丢）');
ok(truncateToAsOf(plainBars, '2026-11-12').meta === undefined, '无 .meta 输入时不伪造数据源（诚实兜底）');
ok(JSON.stringify(computeFactors(truncBars)) === JSON.stringify(computeFactors(plainBars)), '带 .meta 与不带 .meta 的因子计算逐字相同（数值零影响）');

const baseArgs = {
  asOf: '2026-11-12', symbols: ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'],
  rowsTotal: 1840, validSamples: 1840, P, S, clusters,
  perSymbolMissing: {}, lastDateStaleNote: '',
};
const notes = [
  { symbol: 'S1', source: '腾讯日K(ifzq.gtimg.cn)', lastDate: '2026-11-12' },
  { symbol: 'S2', source: '腾讯日K(ifzq.gtimg.cn)', lastDate: '2026-11-12' },
  { symbol: 'S3', source: '腾讯日K(ifzq.gtimg.cn)', lastDate: '2026-11-12' },
  { symbol: 'S4', source: '新浪日K(quotes.sina.cn)', lastDate: '2026-11-12' },
  { symbol: 'S5', source: '新浪日K(quotes.sina.cn)', lastDate: '2026-11-12' },
  { symbol: 'S6', source: '新浪日K(quotes.sina.cn)', lastDate: '2026-11-12' },
  { symbol: 'S7', source: '新浪日K(quotes.sina.cn)', lastDate: '2026-11-12' },
  { symbol: 'S8', source: '新浪日K(quotes.sina.cn)', lastDate: '2026-11-12' },
];
const withSources = buildReport({ ...baseArgs, fetchNotes: notes });
ok(withSources.includes('腾讯日K(ifzq.gtimg.cn) ×3') && withSources.includes('新浪日K(quotes.sina.cn) ×5'), '有 fetchNotes → 逐股实际源按源计数如实写出（腾讯 ×3；新浪 ×5）');
ok(!withSources.includes('取数源未记录，待补') && !withSources.includes('未知 ×'), '有 fetchNotes → 不再写「待补」、不写「未知」占位');
ok(withSources.includes('**截断末根核验**') && withSources.includes('8/8 只末根 = asOf，无滞后'), '有 fetchNotes → 截断末根核验行（8/8 无滞后）');
const withStale = buildReport({ ...baseArgs, fetchNotes: [...notes.slice(0, 7), { symbol: 'S8', source: '新浪日K(quotes.sina.cn)', lastDate: '2026-11-11' }] });
ok(withStale.includes('S8 末根 2026-11-11 ≠ asOf（滞后）') && !withStale.includes('8/8 只末根'), '存在滞后 → 逐股如实标注、不掩盖');
ok(generated.includes('取数源未记录，待补') && !generated.includes('腾讯日K(ifzq.gtimg.cn) ×'), '无 fetchNotes（守卫直调）→ 保留历史「待补」兜底分支');
ok(SRC.includes('fetchNotes.push(') && SRC.includes('lastDateStaleNote, fetchNotes') && SRC.includes('if (bars && bars.meta !== undefined) trunc.meta = bars.meta;'), '源码接线：main() 采集逐股源并传入 buildReport，纯函数统一补挂 .meta');
ok(!SRC.includes('trunc.meta = hist.meta;') && SRC.includes('const outPath = parseOutArg() || canonicalPath') && SRC.includes('fs.readFileSync(canonicalPath'), '源码接线：多窗口不再手动补挂；单窗口支持 --out 且既有报告仍从正式路径读取');
ok(BODY.includes('腾讯日K(ifzq.gtimg.cn) ×8') && !BODY.includes('取数源未记录，待补'), '重跑后已归档报告采用实际取数源标注，不再残留「待补」');

console.log('[test_factor_corr_preserve] 复核档案一字不改（历史记录钉死）');
const md5 = crypto.createHash('md5').update(REVIEW).digest('hex');
ok(md5 === '5ee90458db899209bf09033ce4a8e8d9', `最新复核档案(Trea) md5 = ${md5}（与复核时一致）`);
ok(REVIEW.includes('结论：有条件通过') && REVIEW.includes('ITEM 2') && REVIEW.includes('ITEM 8'), '复核档案(Trea)为「有条件通过」且 14 项 ITEM 完整');

console.log(`\n=== ⑤ 整改守卫汇总：通过 ${pass} / 失败 ${fail} ===`);
process.exit(fail ? 1 : 0);
