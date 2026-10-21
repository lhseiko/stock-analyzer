/**
 * 股份回购子卡片 · 时效与进度口径回归（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_buyback_plan.js
 * 背景（用户 2026-10-21 报障，截图 000902 新洋丰）：
 *   ① 「新洋丰根本没有回购行为」——卡片却把 **2021-07-23 完成实施**的老方案当成当前状态展示；
 *   ② 「显示回购未完成，却判定是中性按回购完成处理」——卡片同时写着「完成实施」和「已达承诺上限 24%」，
 *      而结论理由是「承诺买入力量已用尽」。1.44 亿 / 承诺 3~6 亿，钱显然没花完。
 *
 * 覆盖（20261021i）：
 *   [1] 历史闸门：完结超 730 天 → historical=true（不再当作当前回购）
 *   [2] 未足额结束：完成实施但只到 24% → stage「已结束（未足额）」，理由**不得**说"已用尽"
 *   [3] 足额完成：≥95% → 理由才允许说"已用尽"
 *   [4] 实施中：按剩余额度衰减给正分
 *   [5] 文案：历史前缀 + 「未足额买完」，且**不出现**「完成实施（已达承诺上限 24%）」这种自相矛盾组合
 *   [6] 接线守卫：sameDayJudgment 用 historical 把旧方案降为脚注；卡片值以「无进行中」为主语
 */
const fs = require('fs');
const path = require('path');
const bb = require('../lib/buybackEmDc');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

/** 造一行东财回购报表（字段名与真实报表一致） */
function mkRow(over) {
  return Object.assign({
    REPURPROGRESS: '006',
    REPURNUM: 12134600,
    REPURAMOUNT: 144000000,          // 1.44 亿
    REPURAMOUNTLOWER: 300000000,     // 承诺 3 亿
    REPURAMOUNTLIMIT: 600000000,     // 承诺上限 6 亿
    REPURPRICECAP: 10,
    REPURSTARTDATE: '2021-01-01 00:00:00',
    REPURENDDATE: '2021-07-22 00:00:00',
    FINISHDATE: '2021-07-23 00:00:00',
    NOTICEDATE: '2021-07-23 00:00:00',
    DIM_DATE: '2021-07-23 00:00:00',
  }, over || {});
}

console.log('\n[1] 历史闸门（用户报障①：新洋丰现在没有回购行为）');
{
  const p = bb.normalize(mkRow());
  eq(p.historical, true, '2021-07-23 完成实施（5 年前）→ 判为历史方案');
  ok(p.ageDays > 730, `已完结 ${p.ageDays} 天（> ${bb.HISTORICAL_DAYS}）`);
  ok(/历史方案/.test(bb.formatPlan(p)), '文案开头标「历史方案…与当前回购无关」');

  // 近期完成的方案（30 天前）不应判历史
  const recent = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10) + ' 00:00:00';
  const p2 = bb.normalize(mkRow({ FINISHDATE: recent, NOTICEDATE: recent, DIM_DATE: recent }));
  eq(p2.historical, false, '30 天前完成 → 仍算近期，不标历史');

  // 进行中的方案永远不是历史
  const p3 = bb.normalize(mkRow({ REPURPROGRESS: '004', FINISHDATE: null, NOTICEDATE: '2021-07-23 00:00:00' }));
  eq(p3.historical, false, '实施中方案不因日期久被判历史');
}

console.log('\n[2] 未足额结束（用户报障②：显示未完成却按"已用尽"处理）');
{
  const p = bb.normalize(mkRow());
  eq(p.progressPct, 24, '完成率 = 1.44 亿 / 上限 6 亿 = 24%');
  eq(p.signal, 0, '买盘已结束 → signal 0（中性，这部分没错）');
  eq(p.stage, '已结束（未足额）', '阶段明说是"已结束（未足额）"，不是"已完成"');
  ok(/未足额买完/.test(p.signalReason), '理由写明「未足额买完」');
  ok(!/已用尽/.test(p.signalReason), '理由**不得**再说「承诺买入力量已用尽」（钱没花完）');
  ok(/不构成增量利好/.test(p.signalReason), '仍给出"对后续股价不构成增量利好"的正确结论');
}

console.log('\n[3] 足额完成：只有 ≥95% 才允许说"已用尽"');
{
  const p = bb.normalize(mkRow({ REPURAMOUNT: 590000000 }));   // 5.9 亿 / 6 亿 ≈ 98.3%
  eq(p.progressPct, 98.3, '完成率 98.3%');
  eq(p.stage, '已完成', '阶段 = 已完成');
  ok(/已用尽/.test(p.signalReason), '足额完成才说「承诺买入力量已用尽」');
}

console.log('\n[4] 实施中：按剩余额度给正分（回归不受本次改动影响）');
{
  const p = bb.normalize(mkRow({ REPURPROGRESS: '004', REPURAMOUNT: 240000000, FINISHDATE: null }));
  eq(p.stage, '实施中', '阶段 = 实施中');
  ok(p.signal > 0 && p.signal <= 0.75, `signal=${p.signal} 落在 (0, 0.75]`);
  ok(/剩余额度约 60/.test(p.signalReason), `理由给剩余额度（${p.signalReason}）`);
  eq(p.historical, false, '实施中不算历史');
}

console.log('\n[5] 文案自洽：不允许「完成实施 + 已达承诺上限 24%」并存');
{
  const p = bb.normalize(mkRow());
  const txt = bb.formatPlan(p);
  ok(!/已达承诺上限 24/.test(txt), '不再出现「已达承诺上限 24%」（读起来像"正在推进"）');
  ok(/完成实施/.test(txt), '保留东财原进度词「完成实施」（事实不篡改）');
  ok(/实际回购为承诺上限的 24%/.test(txt), '改成「实际回购为承诺上限的 24%」');
  ok(/未达承诺下限 3\.00亿元/.test(txt), '并点明未达承诺下限');
  ok(/方案到期结束、未足额买完/.test(txt), '给出"为什么完成却没足额"的解释');

  // 足额完成的文案不应出现"未足额"
  const p2 = bb.normalize(mkRow({ REPURAMOUNT: 590000000 }));
  const txt2 = bb.formatPlan(p2);
  ok(!/未足额买完/.test(txt2), '足额完成文案不出现「未足额买完」');
  ok(/已达承诺上限的 98\.3%/.test(txt2), `足额文案：已达承诺上限的 98.3%（实际 ${txt2}）`);
}

console.log('\n[6] 接线守卫（卡片主语与降级处理）');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sameDayJudgment.js'), 'utf8');
  ok(/buybackHistorical/.test(src), 'sameDayJudgment 识别 historical');
  ok(/当前无进行中的回购/.test(src), '父级 detail 以「当前无进行中的回购」为主语');
  ok(/无进行中（最近一次/.test(src), '子卡片 value 以「无进行中」开头');
  ok(/股份回购（历史）/.test(src), '子卡片名标「（历史）」');
  ok(/与当前无关，按中性处理/.test(src), 'detail 明说"与当前无关，按中性处理"');

  const em = fs.readFileSync(path.join(__dirname, '..', 'lib', 'buybackEmDc.js'), 'utf8');
  ok(/HISTORICAL_DAYS = 730/.test(em), '历史阈值 730 天常量存在');
  ok(/CLOSED_CODES = \['003', '005', '006'\]/.test(em), '已结束进度码口径明确（完成/停止/否决）');
  ok(/未足额买完/.test(em), '未足额的措辞在数据层生成（不靠前端拼）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
