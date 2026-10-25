/**
 * AI 大盘解读：缓存（按交易日）+ 写入大盘记录（20261024l）
 * 运行： node scripts/test_market_ai_cache_notes.js
 *
 * 用户报障（2026-10-24 16:09 截图）：
 *   ① 点「AI 解读」得到的滚动文字没有同步进「大盘记录」；
 *   ② AI 解读没有缓存，每次系统更新/刷新都要重新解读一次。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'sa_notes_ai_test_' + process.pid + '.json');
process.env.SA_NOTES_FILE = TMP;
try { fs.unlinkSync(TMP); } catch (e) {}

const dr = require('../lib/dailyMarketReview');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };
const readNotes = () => { try { return JSON.parse(fs.readFileSync(TMP, 'utf8')); } catch (e) { return []; } };

const DATA = { cn: [{ name: '上证指数', changePct: 0.89 }, { name: '创业板指', changePct: 4.16 }] };
const AI = { cn: 'A股探底回升，沪指涨0.89%。', gainers: '电机涨5.18%居首。', losers: '银行走弱。', model: 'glm-5.3' };

console.log('\n[1] 生成成功后写入大盘记录（新建）');
{
  const r = dr.saveMarketReviewNote({ date: '2026-10-23', data: DATA, ai: AI });
  ok(r.saved === true && r.updated === false, '首次写入 → saved=true, updated=false');
  const notes = readNotes();
  ok(notes.length === 1, '大盘记录新增 1 条');
  ok(notes[0].scope === 'market', 'scope=market');
  ok(notes[0].title === 'AI 大盘复盘 · 2026-10-23', '标题为交易日标记');
  ok(/【大盘】/.test(notes[0].content) && /【指数收盘】上证指数 \+0\.89%/.test(notes[0].content), '正文含大盘与指数收盘');
  ok(notes[0].ai === true && notes[0].type === 'ai', 'ai/type 标记正确');
}

console.log('\n[2] 同一交易日重复生成 → 更新，不重复（不刷屏）');
{
  const r2 = dr.saveMarketReviewNote({ date: '2026-10-23', data: DATA, ai: { ...AI, cn: '收盘版：探底回升更明确。' } });
  ok(r2.saved === true && r2.updated === true, '同日再写 → updated=true');
  const notes = readNotes();
  ok(notes.length === 1, '记录仍为 1 条（未重复）');
  ok(/收盘版/.test(notes[0].content), '内容已更新为最新解读');
  ok(notes[0].updatedAt, '写入 updatedAt 时间戳');
}

console.log('\n[3] 不同交易日 → 各一条；空内容 → 不写');
{
  dr.saveMarketReviewNote({ date: '2026-10-22', data: DATA, ai: AI });
  ok(readNotes().length === 2, '不同交易日 → 新增为第 2 条');
  const rEmpty = dr.saveMarketReviewNote({ date: '2026-10-24', data: DATA, ai: { cn: '', gainers: '', losers: '' } });
  ok(rEmpty.saved === false && /空/.test(rEmpty.reason || ''), '三段全空 → 不写（返回原因）');
  const rNoDate = dr.saveMarketReviewNote({ data: DATA, ai: AI });
  ok(rNoDate.saved === false, '缺日期 → 不写');
}

console.log('\n[4] 源码守卫：按交易日缓存 + 手动解读也落盘 + 按钮复用缓存');
{
  const root = path.join(__dirname, '..');
  const mkt = fs.readFileSync(path.join(root, 'lib', 'ai', 'market.js'), 'utf8');
  ok(mkt.includes('asOfTradingDate(localDate())'), 'market.js 按 asOfTradingDate 判定缓存');
  ok(mkt.includes('sameSession'), '缓存有效期 = 同一交易日（不再 4 小时过期）');
  ok(mkt.includes('asOfTradingDate: asOf'), '缓存记录写入归属交易日');

  const ar = fs.readFileSync(path.join(root, 'routes', 'aiRoutes.js'), 'utf8');
  ok(ar.includes('saveMarketReviewNote'), 'POST /api/ai/market-overview 生成后写入大盘记录');
  ok(!ar.includes('result.cached !== true'), '不再因「命中缓存」跳过落盘（修复：缓存已存在但从未落盘的情况）');
  ok(/result\.success\)\s*\{/.test(ar), '只要 success 就 upsert（缓存命中也会补齐，幂等不重复）');

  const srv = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  ok(/runDailyMarketAiReview[\s\S]{0,1200}saveMarketReviewNote/.test(srv), '定时复盘改用 saveMarketReviewNote（upsert）');

  const app = fs.readFileSync(path.join(root, 'public', 'js', 'app.js'), 'utf8');
  ok(app.includes("loadMarketAI(e.altKey ? true : 'ensure')"), '按钮默认「确保有解读」（复用缓存），Alt+点击强制');
  ok(app.includes("force === 'ensure'") && /force: false/.test(app), 'ensure 分支 POST force:false（命中缓存不调 LLM）');
}

try { fs.unlinkSync(TMP); } catch (e) {}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
