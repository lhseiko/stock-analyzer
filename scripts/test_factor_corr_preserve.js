#!/usr/bin/env node
/**
 * scripts/test_factor_corr_preserve.js — backlog ⑤ 整改 1–4 守卫（零网络）
 * @test-scope: local
 * 守护点：
 *   1. buildReport() 模板状态同步：数据源标注、局限 1「已完成」、Backlog [x]（防重跑写回旧状态）；
 *   2. preserveBusinessBlocks() 重跑不丢【业务解读】块：逐字保留、占位符消失、数字区仍来自脚本重算；
 *   3. 保留边界：占位符不当业务结论、占位符多于块时不伪造、多簇按序回填、幂等；
 *   4. 报告整改结果：H1 方向订正、① 已验证、两处业务断言原文保留 + 复核存疑旁注、仍标 AI 草稿；
 *   5. 复核档案一字不改（md5 钉死历史记录）。
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
const REVIEW = fs.readFileSync(path.join(ROOT, 'docs', 'logic', 'factor-corr-20261112-review.md'), 'utf8');
const {
  buildReport, FACTOR_KEYS, BIZ_PLACEHOLDER,
  extractBusinessBlocks, preserveBusinessBlocks,
  REVIEW_SECTION_HEAD, REVIEW_PLACEHOLDER, extractReviewNotesBlock,
} = require('./analyze_factor_corr');
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
ok(blocks[0].includes('AI 草稿') && blocks[0].includes('补录'), '业务解读块含「AI 草稿」与「补录」');
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
ok(!!reviewBlock && reviewBlock.includes('非报告原文') && reviewBlock.includes('待领域人裁决'), '独立区块标注「非报告原文 / 待领域人裁决」');
ok(!!reviewBlock && reviewBlock.includes('9631f759114758ad214d34fc44b25a5f'), '独立区块标注复核档案来源与 md5');
ok(!!reviewBlock && reviewBlock.includes('复核存疑') && reviewBlock.includes('ITEM 3') && reviewBlock.includes('ITEM 4'), '独立区块含两处业务断言存疑理由与 ITEM 编号');
ok(!!reviewBlock && reviewBlock.includes('方差解释率 ≥ 70%') && reviewBlock.includes('供领域人定夺'), '独立区块含 H2 建议门槛且明确由领域人定夺');
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
ok(!!verbatim && verbatim.replace(/\s+$/, '') === REVIEW.replace(/\s+$/, ''), 'A 段与复核档案全文逐字相等（未改写、未浓缩，机器可验）');
ok(!!reviewBlock && reviewBlock.includes('结论：不放行') && reviewBlock.includes('VERDICT:') && reviewBlock.includes('ITEM 3 ·'), 'A 段含「不放行」结论原文与 8 项判定');
ok(!!reviewBlock && reviewBlock.includes('### B. agent 整改留痕与建议（非复核意见）'), 'B 段明确标注 agent 产出、与复核意见分离');
ok(!!reviewBlock && reviewBlock.includes('路径 A（接受「待补」可归档）') && reviewBlock.includes('路径 B（不接受，要求先补）'), 'N6 送审两分支已写入 B 段');

console.log('[test_factor_corr_preserve] 保留边界（不伪造业务结论）');
ok(extractBusinessBlocks(generated).length === 0, '模板占位符不被误判为业务解读块');
ok(preserveBusinessBlocks(generated, '') === generated, '既有报告为空 → 原样返回生成内容（首次生成）');
ok(preserveBusinessBlocks(generated, generated) === generated, '既有报告仅含占位符 → 不伪造业务结论');
const twoSlots = generated.replace(BIZ_PLACEHOLDER, BIZ_PLACEHOLDER + '\n\n### 簇 2：a · b\n' + BIZ_PLACEHOLDER);
const partial = preserveBusinessBlocks(twoSlots, REPORT);
ok(partial.includes(blocks[0]) && partial.includes(BIZ_PLACEHOLDER), '2 占位符 / 1 既有块 → 按序回填第 1 个，多余占位符保留');
const twoBlocks = blocks[0] + '\n\n### 簇 2：a · b\n' + blocks[0].replace('AI 草稿', 'AI 草稿（簇2）');
const both = preserveBusinessBlocks(twoSlots, twoBlocks);
ok(!both.includes(BIZ_PLACEHOLDER) && both.includes('AI 草稿（簇2）'), '2 占位符 / 2 既有块 → 按出现顺序一一回填');

console.log('[test_factor_corr_preserve] 报告整改结果（1–3 已改 / 5–6 原文保留）');
ok(BODY.length > 0 && BODY.includes('## 5. 结论与局限') && !BODY.includes('### A.'), 'BODY 界定为报告正文（不含末尾独立区块）');
ok(!!reviewBlock && reviewBlock.includes('回撤随上涨放大') && !BODY.includes('回撤随上涨放大'), 'A 段引用的历史错误原文不构成正文旧状态残留（扫描范围按语义隔离）');

ok(!BODY.includes('回撤随上涨放大'), 'H1 旧错误方向「回撤随上涨放大」已消除');
ok(BODY.includes('drawdown_20d 数值趋近 0（回撤幅度收窄'), 'H1 已订正为「数值趋近 0 / 回撤幅度收窄」');
ok(BODY.includes('与 §3 的 +0.602 / +0.737 正相关一致'), 'H1 订正附 §3 实证符号依据');
ok(BODY.includes('① **已验证**') && BODY.includes('簇数 1→1→1'), '待验证 ① 改为「已验证」并引用多窗口 §2');
ok(BODY.includes('局限 1（窗口敏感）') && BODY.includes('**已完成**') && !BODY.includes('本轮未实现'), '§5 局限 1 状态同步');
ok(BODY.includes('- [x] 多窗口对照') && !BODY.includes('- [ ] 多窗口对照'), 'Backlog 多窗口条勾 [x]');
ok(BODY.includes('取数源未记录，待补') && !BODY.includes('新浪日K(quotes.sina.cn) ×8'), '数据源如实写「未记录待补」，未冒充多窗口轮次的新浪源');
ok(BODY.includes('不构成独立信息增益'), '业务断言「不构成独立信息增益」原文保留（未擅自收敛）');
ok(BODY.includes('可压缩为单一「趋势强度」潜因子'), 'H2「可压缩为单一潜因子」原文保留（未擅自收敛）');
ok(REPORT.includes('复核存疑（待领域人裁决') && REPORT.includes('R²≈0.70') && REPORT.includes('30% 方差'), '两处业务断言加「复核存疑，待领域人裁决」旁注（附 R²/方差依据）');
ok(REPORT.includes('方差解释率 ≥ 70%') && REPORT.includes('agent 建议，供领域人定夺'), 'H2 门槛为 agent 建议、明确由领域人定夺');
ok(REPORT.includes('AI 草稿，待领域人复核') && REPORT.includes('待领域人确认/修正'), '仍标「AI 草稿，待领域人确认/修正」（未删、未转可归档）');
ok(REPORT.includes('整改留痕（2026-11-13') && REPORT.includes('非领域人签字'), '报告内留痕「谁改、改了什么、依据哪条复核意见」');

console.log('[test_factor_corr_preserve] 复核档案一字不改（历史记录钉死）');
const md5 = crypto.createHash('md5').update(REVIEW).digest('hex');
ok(md5 === '9631f759114758ad214d34fc44b25a5f', `复核档案 md5 = ${md5}（与复核时一致）`);
ok(REVIEW.includes('结论：不放行') && REVIEW.includes('ITEM 2') && REVIEW.includes('ITEM 8'), '复核档案仍为「不放行」且 8 项判定完整');

console.log(`\n=== ⑤ 整改守卫汇总：通过 ${pass} / 失败 ${fail} ===`);
process.exit(fail ? 1 : 0);
