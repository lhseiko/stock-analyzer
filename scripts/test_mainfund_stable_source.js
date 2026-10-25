/**
 * 主力资金因子（图二 mainFund）稳定数据源回归测试
 * --------------------------------------------------------------
 * 背景：原主链 push2delay 实时通道本机常年 TLS 重置、备链数据中心行业资金流求和又因
 * `fb.date === today` 硬门槛拒收 T-1 → 因子长期「缺失」。20261024a 重构为
 * fetchMarketMainFund() 稳定源链路（S1 行业资金流求和 + S2 板块资金流汇总兜底），
 * 接受「最新已收盘交易日」并如实标注口径日/T-lag。
 *
 * 运行： node scripts/test_mainfund_stable_source.js
 * 覆盖：
 *  [A] S1（行业资金流求和）返回有效值且 source 含口径日 + T-lag 标注
 *  [B] S1 抛错时降级 S2（板块资金流汇总）仍返回有效值，source 标注兜底
 *  [C] getMarketEmotionData 放松 ===today 门槛：T-1 也能注入，issues 不再报 mainFund 缺失
 *  [D] 模型 calcMainCapital 对 T-1 数据如实标注口径日、lagged=true、快照护栏（mainNet 不挂今日）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'sa-mainfund-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.SA_MARKET_EMOTION_DIR = TMP;

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// ---- 桩数据 ----
// RPT_INDUSTRY_FUNDFLOW：单位=元。2026-10-23 主力净额 -10 亿；2026-10-22 +10 亿
const INDUSTRY_ROWS = [
  { TRADE_DATE: '2026-10-23 00:00:00', SUPERDEAL_NET: 5e8, BIGDEAL_NET: -1e9 },
  { TRADE_DATE: '2026-10-23 00:00:00', SUPERDEAL_NET: 5e8, BIGDEAL_NET: -1e9 },
  { TRADE_DATE: '2026-10-22 00:00:00', SUPERDEAL_NET: 3e8, BIGDEAL_NET: 2e8 },
  { TRADE_DATE: '2026-10-22 00:00:00', SUPERDEAL_NET: 3e8, BIGDEAL_NET: 2e8 },
];
// RPT_FUNDFLOW_BOARD：单位=万元。2026-10-23 主力净额 ≈ -9.82 亿；2026-10-22 +20 亿
const BOARD_ROWS = [
  { TRADE_DATE: '2026-10-23 00:00:00', SUPERDEAL_AMOUNT: -26229.57, BIGDEAL_AMOUNT: -22854.70 },
  { TRADE_DATE: '2026-10-23 00:00:00', SUPERDEAL_AMOUNT: -26229.57, BIGDEAL_AMOUNT: -22854.70 },
  { TRADE_DATE: '2026-10-22 00:00:00', SUPERDEAL_AMOUNT: 50000, BIGDEAL_AMOUNT: 50000 },
  { TRADE_DATE: '2026-10-22 00:00:00', SUPERDEAL_AMOUNT: 50000, BIGDEAL_AMOUNT: 50000 },
];

const ED = require.resolve('../lib/emDataCenter');
const SD = require.resolve('../lib/stockData');
const MT = require.resolve('../lib/marketTechnical');
const MED = require.resolve('../lib/marketEmotionData');

function setStubs({ fetchReport, findPython, fetchIdx }) {
  delete require.cache[ED]; delete require.cache[SD]; delete require.cache[MT]; delete require.cache[MED];
  require.cache[ED] = { id: ED, filename: ED, loaded: true, exports: { fetchReport, REPORTS: {}, HOST: 'x', latestTradeDate: async () => '2026-10-23' } };
  require.cache[SD] = { id: SD, filename: SD, loaded: true, exports: { findPythonForScript: findPython } };
  require.cache[MT] = { id: MT, filename: MT, loaded: true, exports: { fetchIndexDailyBars: fetchIdx } };
}

(async () => {
  console.log('[A] S1 行业资金流求和（全市场稳定源）');
  setStubs({
    fetchReport: async (name) => (name === 'RPT_INDUSTRY_FUNDFLOW' ? INDUSTRY_ROWS : []),
    findPython: async () => null,          // runScript 抛错 → raw.mainFund 留空，走 fetchMarketMainFund
    fetchIdx: async () => [],
  });
  const { fetchMarketMainFund } = require('../lib/marketEmotionData');
  const sysYmd = new Date().toISOString().slice(0, 10);
  const expLag = Math.round((Date.parse(sysYmd) - Date.parse('2026-10-23')) / 86400000);
  const fb1 = await fetchMarketMainFund();
  ok(fb1 && fb1.mainNetToday !== null, `S1 返回有效主力净额（mainNetToday=${fb1 && fb1.mainNetToday}）`);
  ok(fb1 && fb1.date === '2026-10-23', `口径日 = 最新已收盘交易日 2026-10-23（实际 ${fb1 && fb1.date}）`);
  ok(fb1 && /口径日 2026-10-23/.test(fb1.source), `source 含口径日标注：${fb1 && fb1.source}`);
  if (expLag > 0) ok(/T-\d+ 收盘/.test(fb1.source), `source 含 T-${expLag} 收盘标注（非实时当日）`);
  else console.log('  · 系统日期即 2026-10-23，跳过 T-lag 断言');

  console.log('\n[B] S1 抛错 → 降级 S2 板块资金流汇总兜底');
  setStubs({
    fetchReport: async (name) => {
      if (name === 'RPT_INDUSTRY_FUNDFLOW') throw new Error('S1 boom');
      if (name === 'RPT_FUNDFLOW_BOARD') return BOARD_ROWS;
      return [];
    },
    findPython: async () => null,
    fetchIdx: async () => [],
  });
  const { fetchMarketMainFund: f2 } = require('../lib/marketEmotionData');
  const fb2 = await f2();
  ok(fb2 && fb2.mainNetToday !== null, `S1 失败降级 S2 仍返回有效值（mainNetToday=${fb2 && fb2.mainNetToday}）`);
  ok(fb2 && /板块资金流汇总/.test(fb2.source), `S2 source 标注板块资金流兜底：${fb2 && fb2.source}`);

  console.log('\n[C] resolveMainFund 放松 ===today 门槛（核心修复，离线可测、不依赖 python）');
  setStubs({
    fetchReport: async (name) => (name === 'RPT_INDUSTRY_FUNDFLOW' ? INDUSTRY_ROWS : []),
    findPython: async () => null,
    fetchIdx: async () => [],
  });
  const { resolveMainFund } = require('../lib/marketEmotionData');
  // 模拟 getMarketEmotionData：runScript 成功但 raw.mainFund 为空（push2delay 死链），应被稳定源补上
  const raw = { mainFund: null };
  const note = await resolveMainFund(raw, '2026-10-24');
  ok(raw.mainFund && raw.mainFund.mainNetToday != null, `T-1 主力资金已注入 raw.mainFund（mainNetToday=${raw.mainFund && raw.mainFund.mainNetToday}）`);
  ok(note === null, '注入成功时返回 null（无失败说明）');
  // 反向：两源都取不到 → 返回说明文案，raw.mainFund 仍为空
  setStubs({
    fetchReport: async () => { throw new Error('all dead'); },
    findPython: async () => null,
    fetchIdx: async () => [],
  });
  const { resolveMainFund: resolveMainFund2 } = require('../lib/marketEmotionData'); // 重新解构以绑定新桩
  const raw2 = { mainFund: null };
  const note2 = await resolveMainFund2(raw2, '2026-10-24');
  ok(raw2.mainFund == null && typeof note2 === 'string' && /未取到有效数据|均不可达/.test(note2), `两源皆失败 → 返回说明文案、不注入：${note2}`);

  console.log('\n[D] 模型 T-1 诚实标注 + 快照护栏');
  // 清桩，加载真实模型（不依赖网络）
  delete require.cache[MED]; delete require.cache[ED]; delete require.cache[SD]; delete require.cache[MT];
  const { computeMarketEmotion } = require('../lib/marketEmotionModel');
  const d = {
    ok: true,
    date: '2026-10-24',
    index: { code: 'sh000001', name: '上证指数', bars: (() => { const a = []; let c = 3800; for (let i = 0; i < 260; i++) { const dt = new Date(Date.parse('2026-10-24') - (260 - i) * 86400000); const dow = dt.getUTCDay(); if (dow === 0 || dow === 6) continue; a.push({ date: dt.toISOString().slice(0, 10), close: Math.round(c * 100) / 100, vol: 5e8 }); c *= 1.0005; } return a; })() },
    breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 },
    margin: { latest: 18000, changePct: 0.3, change5Pct: 1.2 },
    // T-1 收盘口径：date 为 2026-10-23，≠ 模型基准日 2026-10-24
    mainFund: { date: '2026-10-23', mainNetToday: -10, history: [] },
    capital: { totalAmount: 15000, turnoverAvg: 3, topDecileShare: 45 },
    fx: { usdcnh: 7.0, usdcnhChgPct: -0.3, usdcny: 7.0, usdcnyChgPct: -0.3 },
    bond: { cn10y: 2.0, chgBp5: 5 },
    discussionHeat: { marketHeat: 0.2, date: '2026-10-24', value: '热度 0.2', detail: 'd' },
    issues: [], warnings: [],
  };
  const r = await computeMarketEmotion({ data: d });
  const mc = r.factors.find(f => f.key === 'mainCapital');
  ok(mc && mc.lagged === true, `mainCapital lagged=true（T-1 收盘口径，lagDays=${mc && mc.lagDays}）`);
  ok(mc && mc.lagDays === 1, 'lagDays = 1');
  // 样本不足走 early-return 时仅填 value（含口径日标注），detail 不保证存在 → 断言以 value 为准
  ok(mc && /截至 2026-10-23/.test(mc.value), `value 标注口径日 2026-10-23：value="${mc && mc.value}"`);
  ok(mc && /口径日 2026-10-23/.test(mc.value) && /非实时当日|收盘口径/.test(mc.value), `value 含「口径日/T-lag 收盘」说明：${mc && mc.value}`);
  // 快照护栏：2026-10-24 的 mainNet 必须为 null（T-1 值不得挂今日）
  const snapFile = path.join(TMP, 'snapshots.json');
  const snaps = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  const snap = snaps.find(s => s.date === '2026-10-24');
  ok(snap && snap.mainNet === null, `快照 2026-10-24 的 mainNet = null（T-1 值未污染历史样本，实际 ${snap && snap.mainNet}）`);

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('测试异常:', e); process.exit(1); });
