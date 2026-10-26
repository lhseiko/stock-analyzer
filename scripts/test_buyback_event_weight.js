/**
 * 股份回购迁入「事件驱动」+ 权重分级回归（20261023i）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_buyback_event_weight.js
 *
 * 用户要求（2026-10-23 截图）：
 *   「股份回购卡片转到突发事件，回购提议的时候权重给10%，回购进行中的时候权重给到30%。」
 *
 * 口径：
 *   回购提议（001 董事会预案 / 002 股东大会通过）→ 事件权重 10%
 *   回购实施中（004）→ 事件权重 30%
 *   完成(006)/停止(005)/否决(003)/历史方案 → 不构成事件
 * 信号沿用 buybackEmDc.gradeSignal：001=0.9 / 002=0.8 / 004=0.75×(1-进度%)
 */
const fs = require('fs');
const path = require('path');
const ev = require('../lib/eventEngine');
const { factorHoldings } = require('../lib/sameDayJudgment');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

function mkBuyback(code, extra) {
  const plan = Object.assign({
    progressCode: code,
    progress: code === '001' ? '董事会预案' : code === '002' ? '股东大会通过' : code === '004' ? '实施中' : '完成实施',
    stage: code === '001' ? '预案' : code === '002' ? '待实施' : code === '004' ? '实施中' : '已完成',
    signal: code === '001' ? 0.9 : code === '002' ? 0.8 : code === '004' ? 0.467 : 0,
    neutral: code === '006' || code === '005' || code === '003',
    noticeDate: '2026-10-09',
    historical: false,
  }, extra || {});
  return { ok: true, structured: true, plan, text: '数据日期 2026-10-09；已回购 2203.53万股 7.55亿元；承诺回购 10.00亿元~20.00亿元；进度 实施中（已达承诺上限的 37.7%）' };
}

// ============================================================================
// [1] 提议 → 10%
// ============================================================================
console.log('\n[1] 回购提议（001/002）→ 10%');
{
  const a = ev.buildBuybackEvent(mkBuyback('001'), '300232');
  ok(a && a.effWeight === 0.10, `001 董事会预案 → 权重 10%（实际 ${a && a.effWeight}）`);
  ok(a && a.signal === 0.9, '001 信号 0.9');
  ok(a && a.grade === 'moderate' && a.sector === '股份回购', '001 分级 moderate / 板块 股份回购');
  const b = ev.buildBuybackEvent(mkBuyback('002'), '300232');
  ok(b && b.effWeight === 0.10, `002 股东大会通过 → 权重 10%（实际 ${b && b.effWeight}）`);
  ok(b && b.signal === 0.8, '002 信号 0.8');
}

// ============================================================================
// [2] 实施中 → 30%
// ============================================================================
console.log('\n[2] 回购实施中（004）→ 30%');
{
  const c = ev.buildBuybackEvent(mkBuyback('004'), '300232');
  ok(c && c.effWeight === 0.30, `004 实施中 → 权重 30%（实际 ${c && c.effWeight}）`);
  ok(c && Math.abs(c.signal - 0.467) < 1e-6, `004 信号=0.75×(1-37.7%)≈0.467（实际 ${c && c.signal}）`);
  ok(c && c.grade === 'major', '004 分级 major');
  ok(c && c.isSynthetic === true, '合成事件（跳过内幕抢跑/市场反应核验）');
  ok(c && /已回购 2203.53万股/.test(c.detail || ''), 'detail 保留四要素（已回购数量/金额/承诺/进度）');
}

// ============================================================================
// [3] 完成/停止/否决/历史 → 不构成事件
// ============================================================================
console.log('\n[3] 不构成事件的进度');
['006', '005', '003'].forEach(code => {
  ok(ev.buildBuybackEvent(mkBuyback(code), '300232') === null, `${code} → null（不生成事件）`);
});
ok(ev.buildBuybackEvent(mkBuyback('001', { historical: true }), '300232') === null, '历史方案（historical）→ null');
ok(ev.buildBuybackEvent(null, '300232') === null, '无回购数据 → null');

// ============================================================================
// [4] 增持减持因子不再含「股份回购」子卡片
// ============================================================================
console.log('\n[4] 增持减持因子：股份回购子卡片已移除');
{
  const holders = new Array(10).fill(0).map((_, i) => ({ name: '股东' + i, holdAmount: 1e8, changeAmount: 5e6, endDate: '2026-06-30' }));
  const f = factorHoldings({ topShareholders: holders }, mkBuyback('004'));
  const names = (f.subFactors || []).map(s => s.name);
  ok(!names.some(n => /股份回购/.test(n)), `子卡片不含「股份回购」（实际：${names.join('、')}）`);
  ok(names.includes('十大股东净变动') && names.includes('增减持家数'), '保留 十大股东净变动 / 增减持家数');
}

// ============================================================================
// [5] 事件驱动因子：包含 evt_buyback_ 子因子 + 权重
// ============================================================================
console.log('\n[5] 事件驱动因子接入');
{
  const base = { sentiment: 0.2, capital: 0.2, futures: 0.1, holdings: 0.15, sectorLimit: 0.1, seesaw: 0.1, technicalShort: 0.15 };
  const keys = ['sentiment', 'capital', 'futures', 'holdings', 'sectorLimit', 'seesaw', 'technicalShort'];
  const r1 = ev.buildEventOverride({ symbol: '300232', baseWeights: base, factorKeys: keys, horizon: 'short', history: [], buyback: mkBuyback('001') });
  ok(!!r1, '提议事件 → 事件因子非空');
  const b1 = r1 && r1.events.find(e => e.id === 'buyback_300232');
  ok(b1 && b1.effWeight === 0.10, `提议事件 effWeight=0.10（实际 ${b1 && b1.effWeight}）`);
  ok(r1 && r1.eventFactor.subFactors.some(s => s.key === 'evt_buyback_300232'), '事件因子包含 evt_buyback_300232 子因子');

  const r2 = ev.buildEventOverride({ symbol: '300232', baseWeights: base, factorKeys: keys, horizon: 'short', history: [], buyback: mkBuyback('004') });
  const b2 = r2 && r2.events.find(e => e.id === 'buyback_300232');
  ok(b2 && b2.effWeight === 0.30, `实施中事件 effWeight=0.30（实际 ${b2 && b2.effWeight}）`);
  ok(r2 && r2.combinedWeight >= 0.30 - 1e-9, `事件合计权重 ≥30%（实际 ${r2 && r2.combinedWeight}）`);
}

// ============================================================================
// [6] 源码守卫
// ============================================================================
console.log('\n[6] 源码守卫');
const eSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'eventEngine.js'), 'utf8');
const sSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sameDayJudgment.js'), 'utf8');
ok(eSrc.includes('function buildBuybackEvent'), 'eventEngine 定义 buildBuybackEvent');
ok(eSrc.includes("code === '001' || code === '002'") && eSrc.includes("code === '004'"), '按进度分级 001/002/004');
ok(eSrc.includes('weight = 0.10') && eSrc.includes('weight = 0.30'), '权重 0.10 / 0.30');
ok(eSrc.includes('buildBuybackEvent, // 20261023i'), 'buildBuybackEvent 已导出');
ok(sSrc.includes('horizon: \'short\', history, buyback'), 'sameDayJudgment 把 buyback 传入事件引擎');
ok(!/subs\.push\(\{ name: buybackHistorical/.test(sSrc), '增持减持不再 push 回购子卡片');
ok(sSrc.includes("const LAYOUT_VERSION = '20261026b'"), 'LAYOUT_VERSION 已升 20261026b');

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
