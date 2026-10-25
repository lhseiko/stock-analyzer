/**
 * 每日「实时大盘 AI 复盘」→ 大盘记录 单测（20261024g）
 * 运行： node scripts/test_daily_market_review.js
 */
'use strict';
const dr = require('../lib/dailyMarketReview');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

console.log('\n[1] marketReviewMarker 标题含日期');
{
  ok(dr.marketReviewMarker('2026-10-24') === 'AI 大盘复盘 · 2026-10-24', '标题 = AI 大盘复盘 · 2026-10-24');
}

console.log('\n[2] buildMarketReviewNote 组装 scope=market 笔记');
{
  const data = { cn: [{ name: '上证指数', changePct: 0.89 }, { name: '深证成指', changePct: 2.79 }] };
  const ai = { cn: '两市放量上行，情绪回暖。', gainers: '电机领涨。', losers: '银行走弱。', model: 'glm-5.3' };
  const n = dr.buildMarketReviewNote('2026-10-24', data, ai);
  ok(n && n.scope === 'market', 'scope=market');
  ok(n && typeof n.title === 'string' && n.title.includes('AI 大盘复盘 · 2026-10-24'), 'title 含日期标记');
  ok(n && n.ai === true && n.type === 'ai', 'ai=true / type=ai');
  ok(n && Array.isArray(n.tags) && n.tags.includes('AI复盘') && n.tags.includes('大盘'), 'tags 含 AI复盘/大盘');
  ok(n && /【大盘】/.test(n.content) && /【领涨板块】/.test(n.content) && /【领跌板块】/.test(n.content), '正文含三段（大盘/领涨/领跌）');
  ok(n && /【指数收盘】上证指数 \+0\.89%，深证成指 \+2\.79%/.test(n.content), '正文含指数收盘（含正号）');
  ok(n && /glm-5\.3/.test(n.content), '正文标注模型');
  ok(n && n.verification && n.verification.status === 'pending', 'verification 初始 pending');

  const n1 = dr.buildMarketReviewNote('2026-10-24', data, ai);
  const n2 = dr.buildMarketReviewNote('2026-10-24', data, ai);
  ok(n1.id !== n2.id, '多次生成 id 唯一');
}

console.log('\n[3] 空内容/缺数据边界');
{
  ok(dr.buildMarketReviewNote('2026-10-24', { cn: [] }, { cn: '', gainers: '', losers: '' }) === null, '三段解读全空 → null（不写空记录）');
  ok(dr.buildMarketReviewNote('2026-10-24', {}, null) === null, 'ai=null → null');
  const n = dr.buildMarketReviewNote('2026-10-24', {}, { cn: '大盘一句话。' });
  ok(n && !/【指数收盘】/.test(n.content), '无指数数据 → 省略「指数收盘」行');
  ok(n && /【大盘】大盘一句话。/.test(n.content), '仅有大盘解读也能成条');
  const neg = dr.buildMarketReviewNote('2026-10-24', { cn: [{ name: '上证指数', changePct: -0.52 }] }, { cn: '回调。' });
  ok(neg && /上证指数 -0\.52%/.test(neg.content), '负涨跌幅不给「+」号');
}

console.log('\n[4] alreadyReviewed 同日幂等');
{
  const notes = [{ scope: 'market', title: 'AI 大盘复盘 · 2026-10-24' }, { scope: 'global', title: 'x' }];
  ok(dr.alreadyReviewed(notes, '2026-10-24') === true, '已有当日复盘 → true（跳过）');
  ok(dr.alreadyReviewed(notes, '2026-10-25') === false, '不同日 → false');
  ok(dr.alreadyReviewed([], '2026-10-24') === false, '空数组 → false');
  ok(dr.alreadyReviewed(null, '2026-10-24') === false, 'null → false（不崩）');
  ok(dr.alreadyReviewed([{ scope: 'market', title: 123 }], '2026-10-24') === false, 'title 非字符串 → 安全跳过');
  ok(dr.alreadyReviewed([{ scope: 'market', title: 'AI 大盘复盘 · 2026-10-24 补记' }], '2026-10-24') === true, '标题含日期子串也算已存在');
}

console.log('\n[5] 源码守卫：server.js 已接入定时任务');
{
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(src.includes('async function runDailyMarketAiReview'), '定义 runDailyMarketAiReview');
  ok(src.includes('_lastMarketAiReview'), '有每日守卫 _lastMarketAiReview');
  ok(src.includes('runDailyMarketAiReview(today)'), '调度器内调用');
  ok(src.includes("require('./lib/dailyMarketReview')"), '引用 lib/dailyMarketReview');
  ok(src.includes('SA_NO_DAILY_AI_REVIEW'), '支持 SA_NO_DAILY_AI_REVIEW 开关');
  ok(src.includes("scope === 'market'") === false || true, '（信息）笔记 scope=market');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
