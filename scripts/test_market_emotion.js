/**
 * 大盘量能情绪模型 · 离线回归测试（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_market_emotion.js
 * 覆盖：9 因子齐全 / 权重恒为 100% / 常驻权重边界 5%~30% / 降级因子权重归零并分摊 /
 *       非常驻休眠与激活 / 极端行情熔断 / 炸板率展示与封板质量修正 /
 *       量能活跃与量价配合合并（加权合成 / 降级 / 历史权重迁移）/ 量能方向修正 /
 *       月末缩量放宽 / T+1 准确率结算 /
 *       股吧热度时效校验（滞后打折、过期剔除）/ 分位样本交易日过滤。
 * 说明：用 SA_MARKET_EMOTION_DIR 与 SA_MSI_SERIES 指向临时目录，绝不读生产数据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'sa-emotion-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.SA_MARKET_EMOTION_DIR = TMP;
process.env.SA_MSI_SERIES = path.join(TMP, 'msi-series.json');

const { computeMarketEmotion, W_MIN, W_MAX, NON_RESIDENT } = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
const round2 = v => Math.round(v * 100) / 100;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

const END = '2026-09-17';   // 交易日（周四）
const MSI_DATES = [
  '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04',
  '2026-09-05', '2026-09-06',
  '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11',
  '2026-09-12', '2026-09-13',
  '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17',
];
const MSI_HEAT = {
  '2026-08-31': 0.080, '2026-09-01': 0.100, '2026-09-02': 0.062, '2026-09-03': 0.061, '2026-09-04': 0.084,
  '2026-09-05': 0.033, '2026-09-06': 0.031,
  '2026-09-07': 0.081, '2026-09-08': 0.103, '2026-09-09': 0.053, '2026-09-10': 0.077, '2026-09-11': 0.033,
  '2026-09-12': 0.041, '2026-09-13': -0.078,
  '2026-09-14': 0.060, '2026-09-15': 0.076, '2026-09-16': 0.102, '2026-09-17': 0.053,
};
// 14 个交易日 + 4 个周末 = 18 条；交易日过滤后应剩 14
const WEEKEND_N = 4;
const TRADING_N = MSI_DATES.length - WEEKEND_N;

function writeFakeMsiSeries() {
  const arr = MSI_DATES.map(d => ({
    date: d, index: 0.1,
    components: [{ key: 'breadth', label: '市场宽度', signal: 0.2, weight: 0.3 },
      { key: 'marketHeat', label: '股吧讨论热度', signal: MSI_HEAT[d], weight: 0.167,
        value: `热度 ${MSI_HEAT[d]}`, detail: `讨论综合得分 0.12、看多占比 55%（数据源：东财股吧，样本 1200 只，更新于 ${d} 15:05）` }],
    ts: 1,
  }));
  fs.writeFileSync(process.env.SA_MSI_SERIES, JSON.stringify(arr));
}

/** 生成 n 根「上证日线」，只含工作日（模拟真实交易日历），最后一根为 END */
function mkBars(n, { closeTrend = 0.0005, volBase = 5e8, lastVolMult = 1 } = {}) {
  const bars = [];
  let close = 3800;
  const endT = Date.parse(END + 'T00:00:00');
  // 注意：必须按「本地日期」格式化。用 toISOString() 会在 UTC+8 下把日期整体前移一天，
  // 导致生成的『交易日』集合与真实交易日错位（曾把 09-11 误判成非交易日）。
  const fmt = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  const dates = [];
  for (let t = endT; dates.length < n; t -= 86400000) {
    const d = new Date(t), dow = d.getDay();
    if (dow !== 0 && dow !== 6) dates.unshift(fmt(d));
  }
  for (let i = 0; i < n; i++) {
    close = close * (1 + closeTrend);
    let vol = volBase * (1 + Math.sin(i / 7) * 0.1);
    if (i === n - 1) vol = volBase * lastVolMult;
    bars.push({ date: dates[i], close: Math.round(close * 100) / 100, vol: Math.round(vol) });
  }
  return bars;
}

function baseBundle(over = {}) {
  return {
    ok: true,
    date: END,
    index: { code: 'sh000001', name: '上证指数', bars: mkBars(260) },
    breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 },
    margin: { latest: 18000, changePct: 0.3, change5Pct: 1.2 },
    mainFund: { mainNetToday: 150, history: [] },
    capital: { totalAmount: 15000, turnoverAvg: 3, topDecileShare: 45 },
    fx: { usdcnh: 7.0, usdcnhChgPct: -0.3, usdcny: 7.0, usdcnyChgPct: -0.3 },
    bond: { cn10y: 2.0, chgBp5: 5 },
    discussionHeat: { marketHeat: 0.2, date: END, value: '热度 0.2', detail: '讨论综合得分 0.12、看多占比 55%（数据源：东财股吧，样本 1200 只，更新于 2026-09-17 15:05）' },
    issues: [], warnings: [],
    ...over,
  };
}
const withBars = (bars, over = {}) => baseBundle({ index: { code: 'sh000001', name: '上证指数', bars }, ...over });

(async () => {
  writeFakeMsiSeries();

  console.log('\n[1] 基线：数据齐备时的结构与权重');
  let r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  ok(r.factors.length === 9, `因子数 = 9（实际 ${r.factors.length}）`);
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '因子权重合计 = 100%');
  ok(r.model === 'volume-emotion-v2', '模型标识正确（v2 = 量能两因子合并）');
  ok(['看涨', '看跌', '中性'].includes(r.tendency), `短期倾向合法（${r.tendency}）`);
  ok(typeof r.coreDriver === 'string' && r.coreDriver.length > 0, '核心驱动非空');
  ok(typeof r.advice === 'string' && r.advice.length > 0, '操作建议非空');

  console.log('\n[2] 常驻权重边界 5%~30%（人为塞入越界权重后仍被夹紧）');
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({
    weights: { volumePrice: 99, breadthExtreme: 0.1, indexMomentum: 10, margin: 10, mainCapital: 10, discussionHeat: 10, riskAversion: 10, domesticMacro: 5, usMacro: 5 },
    factorAcc: {}, events: {},
  }));
  r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  const vw = r.factors.find(f => f.key === 'volumePrice').weight;
  const bw = r.factors.find(f => f.key === 'breadthExtreme').weight;
  ok(vw <= W_MAX + 0.01 && vw > 0, `越界上限被夹紧（volumePrice=${vw}% ≤ ${W_MAX}%）`);
  ok(bw >= W_MIN - 0.01, `越界下限被夹紧（breadthExtreme=${bw}% ≥ ${W_MIN}%）`);
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '夹紧后权重合计仍 = 100%');

  console.log('\n[3] 数据缺失 → 该因子权重归零并按比例分摊，其余因子权重之和仍为 100%');
  fs.rmSync(path.join(TMP, 'state.json'), { force: true });
  r = await computeMarketEmotion({ data: baseBundle({ breadth: null }), macroFactors: [] });
  const be = r.factors.find(f => f.key === 'breadthExtreme');
  ok(be.degraded === true && be.weight === 0, '缺失因子已降级且权重 = 0');
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '降级后权重合计仍 = 100%');
  ok(!!r.dataNote, '数据缺口说明已输出');

  console.log('\n[4] 非常驻因子休眠 → 其权重按比例分摊给常驻因子');
  r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  const domW = r.factors.find(f => f.key === 'domesticMacro').weight;
  ok(domW === 0, `休眠时非常驻权重 = 0（domesticMacro=${domW}%）`);
  ok(Math.abs(r.factors.filter(f => !NON_RESIDENT.includes(f.key)).reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '休眠时常驻权重合计 = 100%');

  console.log('\n[5] 非常驻因子激活 → 常驻权重被等比例压缩，总和仍 100%');
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({
    weights: {}, factorAcc: {},
    events: { domesticMacro: { status: 'dormant', weight: 0, lastTrigger: null }, usMacro: { status: 'dormant', weight: 0, lastTrigger: null } },
  }));
  r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [{ key: 'DOMESTIC_MACRO', name: '国内宏观', status: 'active', signal: -0.8 }] });
  const dw = r.factors.find(f => f.key === 'domesticMacro').weight;
  ok(dw > 0, `休眠残留 weight=0 时激活仍能拿到权重（domesticMacro=${dw}%）`);
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '激活后权重合计 = 100%');
  const resSum = r.factors.filter(f => !NON_RESIDENT.includes(f.key)).reduce((a, f) => a + f.weight, 0);
  ok(resSum < 100, `常驻权重被压缩（合计 ${round2(resSum)}% < 100%）`);

  console.log('\n[6] 极端行情熔断（千股跌停 / 单日 ±5%）');
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 50, down: 5000, flat: 10, limitUp: 2, limitDown: 1200, activePct: 5 } }), macroFactors: [] });
  ok(r.circuit === true, '千股跌停触发熔断');
  ok(/观望/.test(r.advice), `熔断时输出观望建议（${r.advice.slice(0, 20)}…）`);

  console.log('\n[6b] 炸板率（20261015j）：统计展示 + 方向分>0 时封板质量修正');
  // ① 炸板率 40%（<50%）：进入 value 展示、字段透出、不修正
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60, zbgcCount: 40, zbgcBreaks: 90, zbgcRate: 0.4 } }), macroFactors: [] });
  const be40 = r.factors.find(f => f.key === 'breadthExtreme');
  ok(/炸板率 40%（40\/100）/.test(be40.value), `炸板率进入 value 展示（${be40.value}）`);
  ok(be40.zbgcRate === 0.4 && be40.zbgcCount === 40 && be40.zbgcBreaks === 90, '炸板三字段透出（zbgcRate/zbgcCount/zbgcBreaks）');
  ok(be40.score === 1, `炸板率 40% < 50% 不修正（score=${be40.score}）`);
  ok(/封板质量正常/.test(be40.detail), '低炸板率文案为「封板质量正常」');
  // ② 炸板率 60%：打 7 折
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 3000, down: 1800, flat: 100, limitUp: 40, limitDown: 3, activePct: 60, zbgcCount: 60, zbgcBreaks: 120, zbgcRate: 0.6 } }), macroFactors: [] });
  const be60 = r.factors.find(f => f.key === 'breadthExtreme');
  ok(be60.score === 0.7, `炸板率 60% ≥ 50% → 打 7 折（score=${be60.score}）`);
  ok(/打7折/.test(be60.detail), '7 折修正文案可见');
  // ③ 炸板率 80%：打 5 折，且风险提示出现封板质量条目
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 3000, down: 1800, flat: 100, limitUp: 20, limitDown: 3, activePct: 60, zbgcCount: 80, zbgcBreaks: 200, zbgcRate: 0.8 } }), macroFactors: [] });
  const be80 = r.factors.find(f => f.key === 'breadthExtreme');
  ok(be80.score === 0.5, `炸板率 80% ≥ 70% → 打 5 折（score=${be80.score}）`);
  ok(/封板质量极差/.test(r.riskTip || ''), `风险提示含封板质量条目（${(r.riskTip || '').slice(0, 30)}…）`);
  // ④ 炸板率缺失：不修正、不 crash、如实标注暂缺
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60, zbgcCount: null, zbgcBreaks: null, zbgcRate: null } }), macroFactors: [] });
  const beNull = r.factors.find(f => f.key === 'breadthExtreme');
  ok(beNull.score === 1 && beNull.zbgcRate === null, '炸板率缺失时不修正（score 维持 1）');
  ok(/暂缺/.test(beNull.detail), '缺失时 detail 如实标注「暂缺」');
  ok(!/炸板率 \d/.test(beNull.value), '缺失时 value 不显示炸板率段');
  // ⑤ 普跌场景（score=-1）：炸板率不参与修正（不削弱负面信号）
  r = await computeMarketEmotion({ data: baseBundle({ breadth: { up: 800, down: 4000, flat: 50, limitUp: 10, limitDown: 30, activePct: 20, zbgcCount: 60, zbgcBreaks: 120, zbgcRate: 0.6 } }), macroFactors: [] });
  const beDown = r.factors.find(f => f.key === 'breadthExtreme');
  ok(beDown.score === -1, `普跌场景炸板率不修正（score=${beDown.score}）`);
  ok(/非普涨场景，不参与修正/.test(beDown.detail), '普跌场景文案说明不参与修正');
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '炸板率场景权重合计仍 = 100%');

  console.log('\n[6c] 量能活跃与量价配合合并（20261015k）：加权合成 / 降级 / 历史权重迁移');
  // ① 基线场景合成数值：恒定成交量日线（价5日涨、量能持平 → 量缩价升 -0.5；量比 1 → 平量 0）
  //    → (0×15 + -0.5×10)/25 = -0.2
  const flatVolBars = mkBars(260).map(b => ({ ...b, vol: 5e8 }));
  r = await computeMarketEmotion({ data: withBars(flatVolBars, { breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 } }), macroFactors: [] });
  const vp0 = r.factors.find(f => f.key === 'volumePrice');
  ok(vp0.score === -0.2, `加权合成数值正确（score=${vp0.score}，期望 -0.2）`);
  ok(vp0.pvScore === -0.5, `量价分透出（pvScore=${vp0.pvScore}）`);
  ok(/合成得分 =（量能活跃度 0 × 15 \+ 量价配合度 -0\.5 × 10）÷ 25 = -0\.2/.test(vp0.detail), '合成算式写入 detail（可解释）');
  ok(/量比 1（平量）/.test(vp0.value) && /价格5日/.test(vp0.value), 'value 合并两边统计');
  // ② 放量普涨 + 量价齐升：量能分 0.5（1年分位过高封顶）+ 量价分 1 → (0.5×15+1×10)/25 = 0.7
  r = await computeMarketEmotion({ data: withBars(mkBars(260, { lastVolMult: 1.6 }), { breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 } }), macroFactors: [] });
  const vp1 = r.factors.find(f => f.key === 'volumePrice');
  ok(vp1.score === 0.7, `放量齐升场景加权合成（score=${vp1.score}，期望 0.7）`);
  ok(vp1.pvScore === 1, `量价齐升判满分（pvScore=${vp1.pvScore}）`);
  ok(vp1.volState === '放量', `量能状态保留（volState=${vp1.volState}）`);
  // ③ 单边/双边数据缺失 → 整体降级归零，reason 说明是哪一半
  r = await computeMarketEmotion({ data: baseBundle({ index: { code: 'sh000001', name: '上证指数', bars: [] } }), macroFactors: [] });
  const vpD = r.factors.find(f => f.key === 'volumePrice');
  ok(vpD.degraded === true && vpD.weight === 0, '日线缺失 → 合并因子整体降级且权重 = 0');
  ok(/量能活跃度/.test(vpD.reason) && /量价配合度/.test(vpD.reason), `降级 reason 指明两半（${vpD.reason}）`);
  ok(/量能活跃与量价配合/.test(r.dataNote || ''), '数据缺口说明点名合并因子');
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '降级后权重合计仍 = 100%');
  // ④ 历史 state.json 权重迁移：旧 volumeActivity:12 + priceVolume:8 → volumePrice:20（幂等，旧 key 删除）
  fs.writeFileSync(path.join(TMP, 'state.json'), JSON.stringify({
    weights: { volumeActivity: 12, priceVolume: 8, breadthExtreme: 15, indexMomentum: 10, margin: 10, mainCapital: 10, discussionHeat: 10, riskAversion: 10, domesticMacro: 5, usMacro: 5 },
    factorAcc: { volumeActivity: { samples: [true], total: 1, correct: 1 } }, events: {},
  }));
  await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  const st = JSON.parse(fs.readFileSync(path.join(TMP, 'state.json'), 'utf8'));
  ok(st.weights.volumePrice === 20, `旧两 key 权重合并迁移（volumePrice=${st.weights.volumePrice}，期望 20）`);
  ok(st.weights.volumeActivity === undefined && st.weights.priceVolume === undefined, '旧权重 key 已删除（迁移幂等）');
  ok(st.factorAcc && st.factorAcc.volumeActivity, '历史准确率台账旧 key 保留可追溯');
  fs.rmSync(path.join(TMP, 'state.json'), { force: true });

  console.log('\n[7] 量能活跃与量价配合方向修正：放量 + 普跌 → 恐慌抛售（负分）');
  r = await computeMarketEmotion({ data: withBars(mkBars(260, { lastVolMult: 2.0 }), { breadth: { up: 800, down: 4000, flat: 50, limitUp: 10, limitDown: 30, activePct: 20 } }), macroFactors: [] });
  const vp7 = r.factors.find(f => f.key === 'volumePrice');
  ok(vp7.score < 0, `放量普跌判为负分（score=${vp7.score}）`);

  console.log('\n[8] T+1 准确率结算：构造一条历史预测并核验命中判定');
  fs.rmSync(path.join(TMP, 'records.json'), { force: true });
  const hb = mkBars(260);
  const base = hb[hb.length - 2].date;
  fs.writeFileSync(path.join(TMP, 'records.json'), JSON.stringify([{ date: base, baselineDate: base, tendency: '看涨', score: 0.3, factorDirs: { volumePrice: 1 } }]));
  r = await computeMarketEmotion({ data: withBars(hb), macroFactors: [] });
  const rec = JSON.parse(fs.readFileSync(path.join(TMP, 'records.json'), 'utf8')).find(x => x.date === base);
  ok(rec && rec.settledT1 === true, 'T+1 已结算');
  ok(rec && rec.correctT1 === false, '预测看涨但实际下跌 → 记为未命中');

  console.log('\n[9] 股吧热度时效：滞后 1~2 个交易日 → 打 8 折且不剔除');
  const bars9 = mkBars(260);
  const dayIdx = bars9.length - 1;                     // 今日
  const lag2 = bars9[dayIdx - 2].date;                 // 往前 2 个交易日
  r = await computeMarketEmotion({ data: withBars(bars9, { discussionHeat: { marketHeat: 0.2, date: lag2, detail: 'd' } }), macroFactors: [] });
  const dh9 = r.factors.find(f => f.key === 'discussionHeat');
  ok(dh9.lagDays === 2, `滞后天数识别正确（lagDays=${dh9.lagDays}，热度日期 ${lag2}）`);
  ok(dh9.lagged === true && dh9.degraded === false, `滞后按 §九 打 8 折（lagged=${dh9.lagged}，degraded=${dh9.degraded}，weight=${dh9.weight}%）`);

  console.log('\n[10] 股吧热度时效：滞后 ≥ 3 个交易日 → 剔除归零并分摊');
  const lag4 = bars9[dayIdx - 4].date;
  r = await computeMarketEmotion({ data: withBars(bars9, { discussionHeat: { marketHeat: 0.2, date: lag4, detail: 'd' } }), macroFactors: [] });
  const dh10 = r.factors.find(f => f.key === 'discussionHeat');
  ok(dh10.degraded === true && dh10.weight === 0, `过期热度已剔除（lagDays=${dh10.lagDays}，weight=${dh10.weight}%）`);
  ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '剔除后权重合计仍 = 100%');
  ok(/过期|滞后/.test(r.dataNote || ''), `数据缺口说明已如实标注（${(r.dataNote || '').slice(0, 40)}…）`);

  console.log('\n[11] 股吧热度时效：日期缺失 → 无法判定时效，按剔除处理（不静默当今日）');
  r = await computeMarketEmotion({ data: withBars(bars9, { discussionHeat: { marketHeat: 0.2 } }), macroFactors: [] });
  const dh11 = r.factors.find(f => f.key === 'discussionHeat');
  ok(dh11.degraded === true && dh11.weight === 0, `日期未知 → 剔除（weight=${dh11.weight}%）`);

  console.log('\n[12] 分位样本交易日过滤：18 条里 4 条是周末，应只留 14 条');
  r = await computeMarketEmotion({ data: baseBundle(), macroFactors: [] });
  const dh12 = r.factors.find(f => f.key === 'discussionHeat');
  ok(dh12.heatSamples === TRADING_N, `分位样本已滤除周末（样本 ${dh12.heatSamples}/${TRADING_N}，原始 ${MSI_DATES.length} 条）`);
  ok(dh12.heatPct != null, `分位仍可计算（热度 0.2 → 分位 ${dh12.heatPct != null ? Math.round(dh12.heatPct * 100) + '%' : '—'}）`);

  console.log('\n[13] 来源标注透传：热度 detail 里的数据源/样本数/更新时间进入因子明细');
  ok(/东财股吧/.test(dh12.detail) && /样本 1200 只/.test(dh12.detail), `来源标注已还原（${(dh12.detail || '').slice(0, 80)}…）`);

  console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack || e); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {} process.exit(1); });
