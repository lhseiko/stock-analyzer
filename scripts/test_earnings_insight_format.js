/**
 * scripts/test_earnings_insight_format.js —— 财报解读「洞察专家五段式」守卫（任务卡 #027）
 * ---------------------------------------------------------------------------
 *   node scripts/test_earnings_insight_format.js
 *
 * 覆盖：
 *  1) 提示词包含五段标题与机读四行、取数硬要求（累计同比 / 金融类营运利润）；
 *  2) 模拟五段式模型输出，机读字段仍能被现有解析函数正确提取；
 *  3) 后处理不会丢掉任何一段。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const E = require('../lib/ai/earnings');

let pass = 0;
const fail = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { fail.push(`✗ ${name}\n    ${e.message}`); }
}

const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai', 'earnings.js'), 'utf8');
const prompt = (src.match(/const EARNINGS_SYSTEM_PROMPT = `([\s\S]*?)`;/) || [])[1] || '';
const SECTIONS = ['一、一句话核心结论', '二、核心事实与数据盘点', '三、逻辑深度推演', '四、战略启示与推演', '五、极简大白话翻译'];

// ---------------- 1) 提示词 ----------------
SECTIONS.forEach(t => check(`提示词包含「${t}」`, () => {
  if (!prompt.includes(t)) throw new Error('缺少该小节');
}));

[['标的：{公司名}', '机读行·标的'], ['报告期：YYYY年X季报', '机读行·报告期'],
 ['综合信号：', '机读行·综合信号'], ['综合结论：', '机读行·综合结论']].forEach(([t, name]) => {
  check(`提示词保留${name}`, () => { if (!prompt.includes(t)) throw new Error(`缺少 ${t}`); });
});

check('取数硬要求：累计同比', () => { if (!prompt.includes('累计同比')) throw new Error('未要求累计同比'); });
check('取数硬要求：金融类营运利润', () => { if (!prompt.includes('营运利润')) throw new Error('未要求金融类经营性指标'); });
check('保留已核实/未核实标注', () => { if (!prompt.includes('已核实') || !prompt.includes('未核实')) throw new Error('标注纪律丢失'); });
check('保留环比口径铁律', () => { if (!prompt.includes('Q2单季 vs 当年Q1单季') && !prompt.includes('Q2单季 vs Q1单季')) throw new Error('环比口径铁律丢失'); });
check('保留身份确认（防串公司）', () => { if (!prompt.includes('身份确认')) throw new Error('身份确认丢失'); });
check('后处理上限放宽到 3200', () => { if (!src.includes('maxChars = 3200')) throw new Error('字数上限未调整'); });

// ---------------- 2) 模拟五段式输出解析 ----------------
const sample = `标的：中国平安（601318）
报告期：2026年三季报
综合信号：-2
综合结论：投资端拖累、主业稳增——归母净利同比-27.3%，营运利润同比+8.3%，新业务价值-13.3%需跟踪

### 一、一句话核心结论
投资账面波动把净利润砸下去，主业营运利润反而增长。
### 二、核心事实与数据盘点（多源交叉）
- 前三季度营收 7281.34 亿元，同比 -12.6%（已核实：公司公告，2026年三季报）。
### 三、逻辑深度推演
净利润含投资浮盈浮亏，去年基数高。
### 四、战略启示与推演
短期看投资端弹性，长期看新业务价值能否止跌。
### 五、极简大白话翻译
店面生意变好了，股票账户亏钱了。`;

check('报告期提取', () => {
  if (E._extractReportPeriod(sample) !== '2026年三季报') throw new Error('提取失败：' + E._extractReportPeriod(sample));
});
check('综合信号提取并归一化', () => {
  const s = E._extractEarningsSignal(sample);
  if (Math.abs(s - (-2 / 3)) > 1e-9) throw new Error('信号异常：' + s);
});
check('综合结论提取', () => {
  const v = E._extractEarningsVerdict(sample) || '';
  if (!v.startsWith('投资端拖累、主业稳增')) throw new Error('结论异常：' + v);
});
check('标的代码提取（供串公司比对）', () => {
  const t = E._extractEarningsTarget(sample);
  if (!t || t.code !== '601318') throw new Error('标的提取异常');
});

// ---------------- 3) 后处理不丢段 ----------------
check('后处理保留全部五段与机读结论', () => {
  const out = E._postProcessEarningsSummary(sample);
  SECTIONS.forEach(t => { if (!out.includes(t)) throw new Error('后处理丢段：' + t); });
  if (!out.includes('综合结论：')) throw new Error('综合结论行被误删');
  if (out.includes('###')) throw new Error('后处理未去掉 Markdown 井号');
});

console.log(`\n共 ${pass + fail.length} 项：通过 ${pass}，失败 ${fail.length}`);
if (fail.length) { fail.forEach(f => console.log(f)); process.exitCode = 1; } else { console.log('全部通过'); }
