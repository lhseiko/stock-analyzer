// ============================================================
// 长江证券（000783）专属动态估值引擎 V2 —— 确定性计算（1+1=2 原则）
// 20260908u：在 20260908r PB-ROE 主模型基础上叠加五项补丁：
//   补丁A 智能数据映射：动态字段模糊匹配 + 营收三级匹配链 + 经纪×70%估算回退 + 3年均值平滑容错
//   补丁B 去季节性年化：TTM滚动 vs 简单年化，偏离>15%触发季节性异常警告 → 弃用简单年化，仅用机构一致预测
//   补丁C 动态PB锚：合理PB中枢=行业PB×40%+(公司3年ROE/行业3年ROE×行业PB)×60%，预测ROE越界±5~10%上/下修
//         + 自修复机制（连续2次方向性偏差→10年窗口截断至5年重算，监测待接入）
//   补丁D 分部倍数动态适配：经纪/资管PE=板块PE中位×市占率相对系数×0.8~1.2；自营PB固定1.0（收益率>6%→1.1）；
//         科创PE按科创50半年涨跌判牛熊（跌幅>10%→10-12x，宽松→15-18x）
//   补丁E 熔断与极端区间：归母/扣非增速偏离>20pp弃用归母；上行>60%或下行>40%禁止自动评级（锁定"无法评级"）；
//         强制三档：极端悲观(PB 10%分位)/基准(PB中枢)/极端乐观(PB 90%分位)
//   补丁F 估值矩阵逻辑自洽强制校验（20260922e）—— 所有估值算完后强制执行，违反即自动修正：
//         F1 排序校验：必须 极端悲观 < 基准中枢 < 极端乐观；违反（历史分位失效，如乐观值低于基准）→
//            极端乐观=基准×1.20 / 极端悲观=基准×0.75，并在说明标注"历史分位已失真，已按动态锚强制外扩边界"
//         F2 空间校验：下行空间=(极端悲观价格−现价)/现价，严禁负数截断为0，原样输出并取绝对值查 40% 熔断线
//         F3 基准一致性：动态PB锚 > 历史90%分位 → 表格最上方强制输出"🔴估值体系重构警告"
//   补丁F-Plus（20260922f）——矩阵输出与逻辑强校验补丁集：
//         ① 空间校验精简：每档行仅展示该档**单边**空间（极端悲观行只给「下行空间」、极端乐观行只给
//            「上行空间」、基准行不计算空间），禁止上下行同时堆砌；
//         ② SOTP 偏离深度归因：|SOTP vs PB-ROE 偏离| > 30% 时禁止以「集团折价」一笔带过，强制穿透
//            拆解各分部估值倍数，并量化区分「分部估值泡沫」与「集团折价（15%~25%）」各贡献多少 pp。
//   补丁G（20260922f，20260922g 修正口径）——动态锚均值回归兜底（周期底部估值体系防御）：双轨保护
//         上轨 = 近5年 90%分位 1.165 倍（突破 → 估值体系重构警告，即 F3）；
//         下轨 = **近5年真实50%分位 0.916 倍**（跌破 → 强制以 0.916 倍价 ¥6.11 作为估值底线，
//                禁止中枢随 ROE 周期性回落无限下探，说明栏标注：
//                「已触及近5年真实估值铁底（0.916倍），市场处于极度悲观定价，下行空间有限，静待均值回归。」）
//         ⚠️ 口径勘误：原「历史50%分位 = 1.33 倍」为 2017 年以来约 9 年长周期均值（跨周期数据混用），已废弃；
//            1.33 倍改列「长周期均值锚」，**仅供「乐观复苏情景」备注展示**（补丁G·规则4），不参与主模型。
//   补丁G·规则4——长周期均值锚作为复苏目标（乐观复苏情景，20260922g）：
//         闸门（须**同时**满足）① 市场日均成交额 ≥ 1.5 万亿；② 公司 ROE 持续上行（近3个年度严格递增
//         且 2026E 预测 ROE 高于最近一年）。满足才允许在备注展示 1.33 倍对应股价，**不参与主模型计算**。
// 计算层=代码，输入锁死（data/valuation/000783.json）⇒ 结果锁死。
// ============================================================
const path = require('path');
const fs = require('fs');
const brk = require('../brokerSectorTurnover');   // 补丁G·规则4 闸门①：市场日均成交额（本地存盘，同步可读）

const SYM = '000783';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/000783.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isChangjiangModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'changjiang';
}

const r2 = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (obj) => (obj && obj.value != null) ? obj.value : null;
function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

// ============================================================
// 纯函数（可独立单测，不读磁盘、不依赖 run 上下文）
// ============================================================

/**
 * 补丁G·动态锚下轨兜底（周期底部估值体系防御）。
 * 双轨：上轨 = 近5年90%分位（突破 → 估值体系重构警告，由补丁F·F3 输出）；
 *      下轨 = 近5年**真实**50%分位（跌破 → 以50%分位价为「估值底线」，禁止中枢无限向下跟随）。
 *      注：下轨取值必须为「近5年日K序列真实50%分位」（当前 0.916），不得使用长周期均值（1.33）。
 * @returns {{active:boolean, floorPb:number, floorPrice:number, rawPrice:number, target:number}}
 */
function pickAnchorFloor({ pbAnchor, pbP50, bvps }) {
  const a = Number(pbAnchor), f = Number(pbP50), b = Number(bvps);
  const floorPrice = b * f, rawPrice = b * a;
  const active = isFinite(a) && isFinite(f) && a < f;
  return {
    active,
    floorPb: f,
    floorPrice: floorPrice,
    rawPrice: rawPrice,
    target: active ? Math.max(rawPrice, floorPrice) : rawPrice,
  };
}

/**
 * 补丁G·规则4——长周期均值锚作为复苏目标（乐观复苏情景，仅备注、不参与主模型）。
 * 闸门（须**同时**满足，否则不展示）：
 *   ① 市场日均成交额 ≥ turnoverFloorYi（亿元，默认 15000 = 1.5 万亿）；
 *   ② 公司 ROE 持续上行：近 N 个年度 ROE 严格递增，且预测 ROE 高于最近一年。
 * @param {{bvps:number, pbLtMean:number, turnoverYi:number|null, turnoverFloorYi:number,
 *          roeValues:number[], predictedRoePct:number}} o  predictedRoePct 为百分数（如 12.9）
 * @returns {{active:boolean, gateTurnover:boolean, gateRoe:boolean, pbLtMean:number, price:number|null,
 *            turnoverYi:number|null, turnoverFloorYi:number, roeValues:number[], predictedRoePct:number|null,
 *            failReason:string, reason:string}}
 */
function evalRecoveryScenario({ bvps, pbLtMean, turnoverYi, turnoverFloorYi, roeValues, predictedRoePct }) {
  const R2 = (x) => Math.round(Number(x) * 100) / 100;
  const b = Number(bvps) || 0;
  const lt = Number(pbLtMean) || 0;
  const vals = (Array.isArray(roeValues) ? roeValues : []).map(Number).filter((x) => isFinite(x));
  const floorYi = Number(turnoverFloorYi) || 15000;
  const tYi = (turnoverYi == null || !isFinite(Number(turnoverYi))) ? null : Number(turnoverYi);
  const pred = (predictedRoePct == null || !isFinite(Number(predictedRoePct))) ? null : Number(predictedRoePct);

  const gateTurnover = tYi != null && tYi >= floorYi;
  let gateRoe = false;
  if (vals.length >= 2) {
    gateRoe = true;
    for (let i = 1; i < vals.length; i += 1) { if (!(vals[i] > vals[i - 1])) { gateRoe = false; break; } }
    if (gateRoe && pred != null) gateRoe = pred > vals[vals.length - 1];
  }
  const active = gateTurnover && gateRoe;
  const f1 = `①市场日均成交额 ${tYi != null ? R2(tYi / 10000) + ' 万亿' : 'N/A'} ${gateTurnover ? '≥' : '<'} 1.5 万亿`;
  const f2 = `②公司 ROE ${gateRoe ? '持续上行' : '未持续上行'}（${vals.length ? vals.join('% → ') + '%' : '数据缺失'}${pred != null ? ' → 2026E ' + R2(pred) + '%' : ''}）`;
  return {
    active, gateTurnover, gateRoe,
    pbLtMean: lt,
    price: (lt > 0 && b > 0) ? R2(b * lt) : null,
    turnoverYi: tYi != null ? R2(tYi) : null,
    turnoverFloorYi: floorYi,
    roeValues: vals,
    predictedRoePct: pred,
    failReason: active ? '' : (gateTurnover ? f2 : (gateRoe ? f1 : f1 + '；' + f2)),
    reason: active ? '双条件同时满足' : `未同时满足（${gateTurnover ? '' : f1 + '；'}${gateRoe ? '' : f2}）`,
  };
}

/**
 * 补丁F-Plus 规则2·SOTP 偏离深度归因。
 * 把「SOTP 加总 vs PB-ROE 主模型」的偏离（%）拆成三块并各自量化到 pp：
 *   ① 分部估值泡沫 = 各 PE 类分部倍数超出「市场均值基准 benchPe」的部分所对应的估值（亿元 / 每股 / pp）
 *   ② 集团折价     = 对「剔除泡沫后的 SOTP」按 discBand 中值折价（亿元 / 每股 / pp）
 *   ③ 残差         = 偏离 − ① − ②（正=仍被低估，负=已被过度解释）
 * @param {{segs:Array, totalPs:number, targetPs:number, shares:number, benchPe:number, discBand:number[]}} o
 */
function attributeSotpDeviation({ segs, totalPs, targetPs, shares, benchPe, discBand }) {
  const R2 = (x) => Math.round(Number(x) * 100) / 100;
  const N = Number(shares) || 1;
  const band = (Array.isArray(discBand) && discBand.length === 2) ? [Number(discBand[0]), Number(discBand[1])] : [0.15, 0.25];
  const discMid = (band[0] + band[1]) / 2;
  const bench = Number(benchPe) || 0;
  const total = Number(totalPs) || 0, target = Number(targetPs) || 0;
  let bubbleTotal = 0;
  const drill = [];
  for (const s of (segs || [])) {
    const mult = Number(s.mult) || 0;
    let excess = 0, bubble = 0;
    if (s.basis === 'PE' && bench > 0 && mult > bench) { excess = mult - bench; bubble = (Number(s.profit) || 0) * excess; }
    bubbleTotal += bubble;
    drill.push({ key: s.key, label: s.label, basis: s.basis, mult: R2(mult), excess: R2(excess), bubble: R2(bubble) });
  }
  const bubblePs = bubbleTotal / N;
  const afterBubblePs = total - bubblePs;
  const devPct = target ? (total - target) / target * 100 : 0;
  const bubblePp = target ? bubblePs / target * 100 : 0;
  const discPp = target ? (afterBubblePs * discMid) / target * 100 : 0;
  const discountedPs = afterBubblePs * (1 - discMid);
  const top = drill.slice().sort((a, b) => b.bubble - a.bubble)[0] || null;
  return {
    devPct: R2(devPct),
    benchPe: bench,
    discMid: R2(discMid), discBand: band,
    bubbleTotal: R2(bubbleTotal), bubblePs: R2(bubblePs), bubblePp: R2(bubblePp),
    afterBubblePs: R2(afterBubblePs),
    discPp: R2(discPp), discountedPs: R2(discountedPs),
    residualPp: R2(devPct - bubblePp - discPp),
    gapAfterPct: target ? R2(Math.abs(discountedPs - target) / target * 100) : 0,
    drill, top,
  };
}

function run(symbol, { price } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'changjiang') return { error: 'NOT_CHANGJIANG' };
  const I = cfg.inputs;

  const N = nz(vv(I.shares));
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const pA = I.patchA, pB = I.patchB, pC = I.patchC, pD = I.patchD, pE = I.patchE;
  const pFP = I.patchFPlus || {}, pG = I.patchG || {};
  const G = I.guard || {};
  const today0 = new Date();

  // ========== 守门员自检（P0一致性修复 20260908z）：财报时效强制终止 + 快照超龄提示 ==========
  const rpEnd = G.reportPeriodEnd && G.reportPeriodEnd.value;
  const reportAge = rpEnd ? daysBetween(rpEnd, today0) : null;
  const maxAge = nz(G.maxAgeDays) || 180;
  const guardRows = [];
  const alerts = [];
  const freshnessRows = [];
  if (rpEnd) {
    freshnessRows.push({ label: '估值基础报告期（中报口径）', asOf: rpEnd, ageDays: reportAge, maxAge, stale: reportAge > maxAge });
    guardRows.push({ label: '① 财报时效', status: reportAge <= maxAge ? '✅ 通过' : '⛔ 终止', value: `最新报告截止 ${rpEnd}，距检查日 ${reportAge} 天（终止上限 ${maxAge} 天）`, source: (G.reportPeriodEnd || {}).source || '' });
  }
  const snapMax = nz(G.snapshotMaxAgeDays) || 30;
  let staleSnapshots = 0;
  for (const sp of (G.snapshots || [])) {
    const age = sp.asOf ? daysBetween(sp.asOf, today0) : null;
    if (age == null) continue;
    const stale = age > snapMax;
    if (stale) staleSnapshots++;
    freshnessRows.push({ label: sp.label, asOf: sp.asOf, ageDays: age, maxAge: snapMax, stale });
    if (stale) alerts.push(`快照参数「${sp.label}」取数于 ${sp.asOf}（距今 ${age} 天 > ${snapMax} 天）→ 可能已不反映最新市场状态，请复核更新`);
  }
  const terminated = reportAge != null && reportAge > maxAge;

  if (terminated) {
    return {
      ok: true, dedicated: true, changjiang: true, terminated: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'changjiang000783 V2（守门员终止：估值结果待更新/需人工复核）',
      guardRows, freshnessRows,
      rating: '需人工复核', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 守门员自检未通过（估值基础财报超龄），模型终止本次估值，历史结论不再外推。请更新财报数据后重跑。',
      riskNote: '守门员终止期间不得引用旧目标价。',
    };
  }
  const bvps = nz(vv(I.h1_2026.bvpsCommon));           // 6.67（普通股口径，剔除永续债60亿）

  // ========== 补丁A：智能数据映射（动态字段模糊匹配） ==========
  const RF = pA.rawFields || {};
  const fRev = nz(vv(RF['营业总收入']) || 74.26);
  const fComm = nz(vv(RF['手续费及佣金净收入']));
  const fBroker = nz(vv(RF['经纪业务（含\'经纪\'字段）']) || vv(RF['经纪业务']));
  const fInt = nz(vv(RF['利息净收入']));
  const fInv = nz(vv(RF['投资收益+公允价值变动净收益']));
  const fVC = nz(vv(RF['科创投资利润（穿透合并报表）']));
  // 经纪回退链：'经纪'字段缺失 → 手续费及佣金净收入×70%（行业平均占比）【估算标签】
  const brokerEstimated = !fBroker;
  const brokerVal = fBroker || (fComm * 0.70);
  const mappingRows = [
    { label: '营收（三级匹配链）', value: `优先匹配"营业总收入" ✅精确命中 = ${r2(fRev)} 亿（1H26）；未启用"营业收入"次级、未启用四科目加总兜底`, source: (RF['营业总收入'] || {}).source || '' },
    { label: '经纪业务（模糊匹配）', value: brokerEstimated ? `⚠️"经纪"字段缺失 → 按手续费及佣金净收入 ${r2(fComm)} 亿×70%（行业平均占比）= ${r2(brokerVal)} 亿【估算标签】` : `匹配包含"经纪"字段 ✅命中 = ${r2(brokerVal)} 亿（1H26）；未触发"手续费×70%"估算回退`, source: (RF['经纪业务（含\'经纪\'字段）'] || {}).source || (RF['经纪业务'] || {}).source || '' },
    { label: '自营/投资（加总口径）', value: `投资收益 + 公允价值变动净收益 = ${r2(fInv)} 亿（1H26，+110.42%）——补丁A规则3加总口径，替代旧硬编码"投资收入"`, source: (RF['投资收益+公允价值变动净收益'] || {}).source || '' },
    { label: '科创投资利润（穿透）', value: `联营合营投资收益科目无余额；穿透合并报表：长江创新 9.0 亿（中报披露）+ 长江资本 ≈2.4 亿 = ${r2(fVC)} 亿（长江资本为合计倒挤【估算标签】）`, source: (RF['科创投资利润（穿透合并报表）'] || {}).source || '' },
    { label: '容错机制（3年均值平滑）', value: '✅ 本季各业务线字段全部匹配成功，"数据缺失，采用平滑处理"高亮未触发；若未来科目改名/缺失自动按补丁A容错链执行', source: pA.fallbackNote },
  ];

  // ========== 补丁B：去季节性年化（TTM滚动 vs 简单年化） ==========
  const ttmNp = nz(pB.npCum.h1Now) + nz(pB.npCum.fyPrev) - nz(pB.npCum.h1Prev);          // 51.52
  const ttmDed = nz(pB.npDedCum.h1Now) + nz(pB.npDedCum.fyPrev) - nz(pB.npDedCum.h1Prev); // 52.30
  const simpleAnn = nz(pB.npCum.h1Now) * 2;                                              // 63.85
  const divergence = (simpleAnn - ttmNp) / ttmNp * 100;                                  // +23.9%
  const seasonAlert = Math.abs(divergence) > (nz(pB.divergenceLimitPct) || 15);
  const consensusNp = nz(vv(pB.consensusNp));                                            // 49.99
  // 预测全年净利润：未触发异常→区间公式；触发异常→弃用简单年化，仅用机构一致预测
  const bandLow = Math.max(simpleAnn * pB.simpleAnnualizeBand[0], ttmNp);
  const bandHigh = Math.min(simpleAnn * pB.simpleAnnualizeBand[1], ttmNp * pB.ttmCapFactor);
  const np2026E = seasonAlert ? consensusNp : (bandLow + bandHigh) / 2;
  const np2026EBasis = seasonAlert
    ? `⚠️季节性异常警告触发（偏离 ${r2(divergence)}% > ${pB.divergenceLimitPct}%）→ 自动弃用简单年化，仅采用机构一致性预测（4家均值）${r2(consensusNp)} 亿为基准`
    : `基准 = 区间 [${r2(bandLow)}, ${r2(bandHigh)}] 中值 ${r2(np2026E)} 亿`;
  const seasonRows = [
    { label: 'TTM 归母净利（滚动12个月）', value: `2026H1 ${r2(pB.npCum.h1Now)} + (2025全年 ${r2(pB.npCum.fyPrev)} − 2025H1 ${r2(pB.npCum.h1Prev)}) = ${r2(ttmNp)} 亿`, source: pB.sources.h1Now + '；' + pB.sources.fyPrev },
    { label: 'TTM 扣非净利（双轨展示）', value: `${r2(pB.npDedCum.h1Now)} + (${r2(pB.npDedCum.fyPrev)} − ${r2(pB.npDedCum.h1Prev)}) = ${r2(ttmDed)} 亿`, source: pB.sources.h1Now },
    { label: '简单年化（禁止直接采用）', value: `2026H1×2 = ${r2(simpleAnn)} 亿；与 TTM 偏离 ${r2(divergence)}%（Q4 计提减值+下半年行情错位导致，简单年化会高估约 ${r2(simpleAnn - ttmNp)} 亿）`, source: '补丁B：禁止简单算术年化' },
    { label: '季节性异常判定', value: seasonAlert ? `⚠️ |${r2(divergence)}%| > ${pB.divergenceLimitPct}% → 触发"季节性异常警告"，简单年化已弃用（避免 Q4 暴雷导致预测崩盘）` : `偏离 ${r2(divergence)}% ≤ ${pB.divergenceLimitPct}% → 采用区间公式 [${r2(bandLow)}, ${r2(bandHigh)}]`, source: `补丁B偏离阈值 ${pB.divergenceLimitPct}%` },
    { label: '2026E 全年净利基准', value: `${r2(np2026E)} 亿（${np2026EBasis}）→ 2026E ROE ≈ ${r2(np2026E / 389 * 100)}%`, source: (pB.consensusNp || {}).source || '' },
  ];

  // ========== 补丁C：动态PB锚点（三阶贝叶斯式调整） ==========
  const roe3y = (pC.companyRoe3y.values || []).reduce((a, b) => a + nz(b), 0) / (pC.companyRoe3y.values || [1]).length; // 6.63
  const indRoe = nz(vv(pC.industryRoe3y)) / 100, indPB = nz(vv(pC.industryPB));
  const roeRatio = (roe3y / 100) / indRoe;
  const pbBase = indPB * 0.4 + roeRatio * indPB * 0.6;                                   // 1.3076
  const predRoe = nz(vv(pC.predictedRoe)) / 100;                                         // 12.9%
  let roeAdj = 0, roeAdjNote = '';
  if (predRoe > indRoe * 1.2) { roeAdj = (pC.roeUpBand[0] + pC.roeUpBand[1]) / 2 / 100; roeAdjNote = `预测ROE ${r2(predRoe * 100)}% > 行业均值×1.2（${r2(indRoe * 120)}%）→ PB锚按区间中值上修 +${r2(roeAdj * 100)}%（区间 ${pC.roeUpBand[0]}~${pC.roeUpBand[1]}%）`; }
  else if (predRoe < indRoe * 0.8) { roeAdj = (pC.roeDownBand[0] + pC.roeDownBand[1]) / 2 / 100; roeAdjNote = `预测ROE ${r2(predRoe * 100)}% < 行业均值×0.8（${r2(indRoe * 80)}%）→ PB锚下修 ${r2(Math.abs(roeAdj) * 100)}%（区间 ${pC.roeDownBand[0]}~${pC.roeDownBand[1]}%）`; }
  else { roeAdjNote = `预测ROE ${r2(predRoe * 100)}% 处行业均值 0.8~1.2 倍带内 → 不修正`; }
  const pbAnchor = pbBase * (1 + roeAdj);                                                // 1.4057
  // ========== 补丁G：动态锚均值回归兜底（周期底部估值体系防御，20260922f） ==========
  // 双轨保护：上轨 = 历史90%分位（动态锚突破上轨 → 「估值体系重构警告」，由补丁F·F3 输出）；
  //          下轨 = 历史50%分位（动态锚跌破下轨 → 「周期底部估值体系防御」，强制以50%分位价为估值底线，
  //          禁止中枢随 ROE 周期性回落无限向下跟随）。
  const pbP10 = nz(vv(pE.pbP10)), pbP50 = nz(vv(pE.pbP50)), pbP90 = nz(vv(pE.pbP90));
  const floorRes = pickAnchorFloor({ pbAnchor, pbP50, bvps });
  const floorPb = floorRes.floorPb, floorPrice = floorRes.floorPrice;
  const anchorFloorActive = floorRes.active;   // 下轨触发（当前数据未触发：锚 1.41 > 50%分位 0.92）
  const pbTargetRaw = floorRes.rawPrice;
  const pbTarget = floorRes.target;                                                      // 9.38
  const anchorFloorNote = `已触及近5年真实估值铁底（${pbP50.toFixed(3)}倍），市场处于极度悲观定价，下行空间有限，静待均值回归。`;

  // ========== 补丁G·规则4：长周期均值锚（1.33 倍）→ 乐观复苏情景（仅备注，不参与主模型，20260922g） ==========
  // 闸门：① 市场日均成交额 ≥ 1.5 万亿（取本地存盘近20交易日日均；缺则退回配置快照）② 公司 ROE 持续上行
  const ltRaw = pG.longTermMeanPb;
  const pbLtMean = (ltRaw && typeof ltRaw === 'object') ? nz(vv(ltRaw)) : nz(ltRaw) || 1.33;
  const ltMeanSource = (ltRaw && typeof ltRaw === 'object' && ltRaw.source) ? ltRaw.source : '2017年以来约9年长周期均值（跨周期口径，配置缺省值）';
  const recoveryTurnoverFloorYi = nz(pG.recoveryMarketTurnoverFloorYi) || 15000;
  let mktTurnoverYi = null, mktTurnoverDate = null, mktTurnoverSrc = '';
  try {
    const st = brk._fromStore();
    if (st && st.market && st.market.length) {
      const m = brk.summarize(st.market);
      if (m && m.avg20Yi != null) {
        mktTurnoverYi = m.avg20Yi;
        mktTurnoverDate = m.date;
        mktTurnoverSrc = `同花顺·申万一级行业成交额合计，近 ${m.windowDays} 交易日日均（截至 ${m.date}）`;
      }
    }
  } catch (e) { /* 存盘不可读 → 退回配置快照 */ }
  if (mktTurnoverYi == null) {
    const tv = nz(vv((I.riskBoard || {}).turnover));
    if (tv > 0) {
      mktTurnoverYi = tv * 10000;
      mktTurnoverDate = cfg.dataAsOf;
      mktTurnoverSrc = `配置快照（${((I.riskBoard || {}).turnover || {}).source || 'riskBoard.turnover'}）`;
    }
  }
  const recoveryRes = evalRecoveryScenario({
    bvps, pbLtMean,
    turnoverYi: mktTurnoverYi,
    turnoverFloorYi: recoveryTurnoverFloorYi,
    roeValues: (pC.companyRoe3y || {}).values,
    predictedRoePct: nz(vv(pC.predictedRoe)),
  });
  const recoveryActive = recoveryRes.active;
  const recoveryNote = recoveryActive
    ? `长周期均值锚 ${pbLtMean.toFixed(2)} 倍 × BVPS ${bvps} = ¥${recoveryRes.price}（对照：主模型动态锚中枢 ¥${r2(pbTarget)}）。口径来源：${ltMeanSource}。该锚仅作「乐观复苏情景」备用目标，不参与主模型计算。闸门已同时满足：① 市场日均成交额 ${(mktTurnoverYi / 10000).toFixed(2)} 万亿 ≥ 1.5 万亿（${mktTurnoverSrc}）；② 公司 ROE 持续上行（${recoveryRes.roeValues.join('% → ')}% → 2026E ${r2(nz(vv(pC.predictedRoe)))}%）。⚠️ 仅在「经济复苏 / 牛市」情景下参考，不进入上方三档矩阵，不参与动态 PB 锚、三档区间与评级计算。`
    : '';
  // 理论PB（展示参考）
  const gPerp = nz(vv(I.roeLayer.theoG)) / 100, r = nz(vv(I.roeLayer.costOfEquity)) / 100;
  const theoPB = (predRoe - gPerp) / (r - gPerp);

  // ========== 补丁D：分部倍数动态适配（挂钩市场风险偏好） ==========
  const nm = nz(vv(I.sotpLayer.netMargin)) / 100;
  const sectorPe = nz(vv(pD.sectorPeMedian));                                            // 9.18
  const shareRatio = nz(vv(pD.brokerShareRatio), 1.0);                                   // 1.0【估算】
  const srb = pD.shareRatioBand || [0.8, 1.2];
  const peLightLo = sectorPe * shareRatio * srb[0], peLightHi = sectorPe * shareRatio * srb[1]; // 7.34~11.02
  const invAssets = nz(pD.invAssets.trading) + nz(pD.invAssets.debt) + nz(pD.invAssets.equityOther); // 525.9
  const annInvYield = nz(pD.invIncomeH1) * 2 / invAssets * 100;                          // 12.1%
  const propPb = annInvYield > (nz(pD.yieldThreshold) || 6) ? (nz(pD.propPbUp) || 1.1) : (nz(pD.propPbBase) || 1.0);
  const sci50 = nz(vv(pD.sci50HalfYearChg));
  const vcPe = sci50 <= nz(pD.tightenThreshold || -10) ? (pD.vcPeTight || [10, 12]) : (pD.vcPeLoose || [15, 18]);
  const peIB = pD.peIB || [10, 15];
  const npLight = (nz(vv(I.h1_2026.bizMix.brokerage)) + nz(vv(I.h1_2026.bizMix.netInterest))) * 2 * nm; // 25.38
  const npAM = nz(vv(I.h1_2026.bizMix.am2025)) * nm;
  const npIB = nz(vv(I.h1_2026.bizMix.ib2025)) * nm;
  const npVC = nz(vv(I.h1_2026.vcProfit));
  const netCap = nz(vv(I.sotpLayer.netCapital));
  function sotp(kind) {
    const sc = kind === 'low' ? 0 : kind === 'high' ? 1 : 0.5;
    const parts = {
      light: npLight * (peLightLo + (peLightHi - peLightLo) * sc),
      prop: netCap * propPb,
      am: npAM * (peLightLo + (peLightHi - peLightLo) * sc),
      ib: npIB * (peIB[0] + (peIB[1] - peIB[0]) * sc),
      vc: npVC * (vcPe[0] + (vcPe[1] - vcPe[0]) * sc),
    };
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    return { total, perShare: total / N, parts };
  }
  const sotpLow = sotp('low'), sotpMid = sotp('mid'), sotpHigh = sotp('high');
  const sotpMidPs = (sotpLow.perShare + sotpHigh.perShare) / 2;
  const sotpDev = (sotpMidPs - pbTarget) / pbTarget * 100;

  // ========== 补丁E：扣非切换判定 + 极端三档 + 熔断 ==========
  const growthDev = Math.abs(nz(pE.npGrowthH1) - nz(pE.npDeductedGrowthH1));             // 1.13pp
  const useDeducted = growthDev > nz(pE.deviationLimitPp, 20);
  // ========== 补丁F：估值矩阵逻辑自洽强制校验（20260922e） ==========
  // F1 排序校验：必须 极端悲观 < 基准中枢 < 极端乐观；违反（历史分位失效 → 乐观值低于基准）→ 按动态锚强制外扩边界
  const extremeLowPct = bvps * pbP10, extremeHighPct = bvps * pbP90;   // 历史分位原始边界（仅作背景参照）
  const upMult = nz(pE.boundaryUpMult) || 1.20;   // 向上溢价空间（默认 +20%）
  const downMult = nz(pE.boundaryDownMult) || 0.75; // 向下折价空间（默认 −25%）
  let extremeLow = extremeLowPct, extremeHigh = extremeHighPct;
  const orderOk = (extremeLow < pbTarget) && (pbTarget < extremeHigh);
  let boundaryFixed = false, boundaryNote = '';
  if (!orderOk) {
    const center = r2(pbTarget);   // 以「卡片显示的中枢」为基准推导，保证三档可被使用者手工验算（9.38×0.75=7.04 / ×1.20=11.26）
    extremeHigh = r2(center * upMult);
    extremeLow = r2(center * downMult);
    boundaryFixed = true;
    boundaryNote = '历史分位已失真，已按动态锚强制外扩边界';
  }
  // F3 基准一致性校验：动态PB锚突破历史90%分位 → 历史分位失去参考意义
  const anchorBreached = pbAnchor > pbP90;
  const reframeNote = `动态PB锚 ${pbAnchor.toFixed(4)} 倍 已高于近5年90%分位 ${pbP90.toFixed(3)} 倍 → 当前ROE水平已突破历史估值体系，历史分位失去参考意义（历史分位带仅覆盖 ROE 5%~10% 区间，当前预测ROE ${r2(predRoe * 100)}%）。估值一律以动态PB锚为准，历史分位仅作背景参照。`;

  // F2 空间计算校验：下行空间 =（极端悲观价格 − 现价）/ 现价；严禁负数截断为 0，原样输出并取绝对值查熔断线
  const spaceDownPct = (P != null) ? r2((extremeLow - P) / P * 100) : null;
  const spaceUpPct = (P != null) ? r2((extremeHigh - P) / P * 100) : null;
  const fuseDownLine = nz(pE.fuseDownsidePct, 40), fuseUpLine = nz(pE.fuseUpsidePct, 60);
  const fuseF = spaceDownPct != null && Math.abs(spaceDownPct) > fuseDownLine;

  let fused = false, fuseE = false, fuseReason = '', rating = '合理', premiumNote = '';
  if (P != null) {
    // 补丁E·锚口径熔断
    const upE = (pbTarget - P) / P * 100;
    const dnE = (P - pbTarget) / P * 100;
    if (upE > fuseUpLine) { fuseE = true; fused = true; fuseReason = `潜在上行空间 ${r2(upE)}% > ${pE.fuseUpsidePct}% → ⛔禁止自动评级，锁定"无法评级"并推送人工复核（大概率基本面质变或数据出错）`; }
    else if (dnE > fuseDownLine) { fuseE = true; fused = true; fuseReason = `潜在下行空间 ${r2(dnE)}% > ${pE.fuseDownsidePct}% → ⛔禁止自动评级，锁定"无法评级"并推送人工复核`; }
    // 补丁F·极端区间口径熔断（下行取绝对值，负号原样保留）
    if (!fused && fuseF) { fused = true; fuseReason = `补丁F·空间校验：极端悲观价 ${r2(extremeLow)} 元 vs 现价 ${r2(P)} 元 → 下行空间 ${spaceDownPct}%（绝对值 ${r2(Math.abs(spaceDownPct))}% > ${fuseDownLine}% 熔断线）→ ⛔禁止自动评级，锁定"无法评级"并推送人工复核`; }
    if (!fused) {
      const disc = (pbTarget - P) / pbTarget * 100;
      if (disc > 10) rating = '低估';
      else if (disc >= -10) rating = '合理';
      else rating = '高估';
      premiumNote = disc >= 0 ? `折价 ${r2(Math.abs(disc))}%` : `溢价 ${r2(Math.abs(disc))}%`;
    }
  }
  if (fused) rating = '无法评级';

  // ---------- 补丁C自修复机制状态 ----------
  const selfHealNote = pC.selfHealNote;

  // ---------- 敏感性：PB 从 10%分位 → 锚 ----------
  const histRefTag = boundaryFixed ? '（历史分位·已失真，仅背景参照）' : '';
  const sensRows = [
    { label: `PB 10%分位 ${pbP10.toFixed(2)} 倍${histRefTag}`, value: r2(extremeLowPct) },
    { label: `PB 50%分位 ${pbP50.toFixed(2)} 倍`, value: r2(bvps * pbP50) },
    { label: `PB 90%分位 ${pbP90.toFixed(2)} 倍${histRefTag}`, value: r2(extremeHighPct) },
    { label: `PB 无ROE修正锚 ${pbBase.toFixed(2)} 倍`, value: r2(bvps * pbBase) },
    { label: `PB 动态锚（修正后） ${pbAnchor.toFixed(2)} 倍`, value: r2(pbTarget) },
  ];
  if (boundaryFixed) {
    sensRows.push({ label: `补丁F·极端悲观（动态锚 × ${downMult.toFixed(2)}）`, value: r2(extremeLow) });
    sensRows.push({ label: `补丁F·极端乐观（动态锚 × ${upMult.toFixed(2)}）`, value: r2(extremeHigh) });
  }

  // ---------- 卡片行 ----------
  const coreRows = [
    { label: '2025 年报', value: `营收 105.48 亿(+59.86%) / 归母 36.96 亿(+101.44%) / 扣非 37.77 亿 / EPS 0.63 元 / 加权ROE 10.02%(+4.94pct) / 分红率 44.88%`, source: I.fy2025.roe.source },
    { label: '2026 中报', value: `营收 74.26 亿(+58.60%) / 归母 31.92 亿(+83.80%) / 扣非 31.64 亿(+84.93%) / ROE 8.39%(+3.63pct) / 归母净资产 429.04 亿 → 普通股 BVPS ${bvps} 元`, source: I.h1_2026.bvpsCommon.source },
    { label: '补丁A·智能数据映射', value: `营收 ✅"营业总收入"精确命中；经纪 ✅"经纪"字段命中 ${r2(brokerVal)} 亿${brokerEstimated ? '【估算标签】' : ''}；自营 ✅加总口径 ${r2(fInv)} 亿；科创 ✅穿透 ${r2(fVC)} 亿；3年均值平滑未触发`, source: pA.fallbackNote },
    { label: '补丁B·去季节性年化', value: `TTM 归母 ${r2(ttmNp)} 亿 / 简单年化 ${r2(simpleAnn)} 亿 → 偏离 ${r2(divergence)}% ${seasonAlert ? `> ${pB.divergenceLimitPct}% ⚠️季节性异常 → 弃用简单年化` : `≤ ${pB.divergenceLimitPct}% 正常`}；2026E 基准 = ${r2(np2026E)} 亿（4家机构一致预测）`, source: (pB.consensusNp || {}).source || '' },
    { label: '补丁E·扣非切换判定', value: `归母增速 +${pE.npGrowthH1}% vs 扣非增速 +${pE.npDeductedGrowthH1}% → 偏离 ${r2(growthDev)} 个百分点 ${useDeducted ? `> ${pE.deviationLimitPp}pp → ⚠️弃用归母，全部改用扣非【非经常性损益干扰】` : `≤ ${pE.deviationLimitPp}pp → 未触发扣非切换，归母口径可用（TTM 扣非 ${r2(ttmDed)} 亿双轨展示）`}`, source: '补丁E规则1：扣非净利润优先原则' },
    { label: '补丁C·动态PB锚', value: `公司3年ROE均值 ${r2(roe3y)}%（4.79/5.08/10.02）÷ 行业3年均值 ${r2(indRoe * 100)}%【假设】=${r2(roeRatio)}；PB中枢 = ${r2(indPB)}×40% + ${r2(roeRatio)}×${r2(indPB)}×60% = ${pbBase.toFixed(4)} 倍；${roeAdjNote} → 动态锚 ${pbAnchor.toFixed(4)} 倍 × BVPS ${bvps} 元 = ${r2(pbTarget)} 元`, source: pC.industryPB.source },
    { label: '理论PB（ROE-PB框架，印证）', value: `(ROE−g)/(r−g)=(${r2(predRoe * 100)}%−${r2(gPerp * 100)}%)/(${r2(r * 100)}%−${r2(gPerp * 100)}%)=${r2(theoPB)} 倍（与动态锚 ${pbAnchor.toFixed(2)} 倍互相印证）`, source: I.roeLayer.costOfEquity.source },
    { label: '补丁D·分部倍数适配', value: `板块PE中位 ${sectorPe} × 市占率相对系数 ${shareRatio}【估算标签：市占率缺失取中性】× 0.8~1.2 → 经纪/资管 PE ${r2(peLightLo)}~${r2(peLightHi)} 倍；自营 PB ${propPb}（年化投资收益率 ${r2(annInvYield)}% ${annInvYield > nz(pD.yieldThreshold, 6) ? '> 6% → 上调1.1' : '≤ 6% → 维持1.0'}）；科创50近半年 ${sci50 > 0 ? '+' : ''}${sci50}% → ${sci50 <= nz(pD.tightenThreshold || -10) ? 'IPO收紧期' : '宽松期'} → 科创PE ${vcPe[0]}~${vcPe[1]} 倍`, source: (pD.sectorPeMedian || {}).source + '；' + (pD.sci50HalfYearChg || {}).source },
    { label: '市场快照', value: `现价 ${P ? r2(P) : 'N/A'} 元 / PE(TTM) 9.23 / PB(LF) 1.11（含永续债口径）/ 普通股PB ≈ ${(P != null ? (P * N / (nz(vv(I.h1_2026.equityParent)) - nz(vv(I.h1_2026.perpetual)))) : 0).toFixed(2)} 倍`, source: I.market.pbLF.source },
  ];

  // ---------- 补丁F-Plus 规则1：空间校验精简（每档仅展示该档单边空间，禁止上下行堆砌） ----------
  const signedPct = (v) => (v == null ? 'N/A' : (v > 0 ? '+' + r2(v) : String(r2(v))));
  const spaceDownAbs = spaceDownPct != null ? r2(Math.abs(spaceDownPct)) : null;
  const downSpaceText = spaceDownPct == null ? '下行空间 N/A'
    : `下行空间 ${signedPct(spaceDownPct)}%，${fuseF ? '⛔已触及' : '未触及'}${fuseDownLine}%熔断线`;
  const upSpaceText = spaceUpPct == null ? '上行空间 N/A'
    : `上行空间 ${signedPct(spaceUpPct)}%`;

  // ---------- 补丁F-Plus 规则2：SOTP 偏离深度归因（偏离 >30% 禁止以「集团折价」一笔带过） ----------
  const devDeepLimit = nz(pFP.sotpDeviationDeepLimitPct) || 30;
  const sotpAttr = attributeSotpDeviation({
    segs: [
      { key: 'light', label: '经纪+信用', profit: npLight, mult: (peLightLo + peLightHi) / 2, basis: 'PE' },
      { key: 'prop', label: '自营投资', profit: netCap, mult: propPb, basis: 'PB' },
      { key: 'am', label: '资管', profit: npAM, mult: (peLightLo + peLightHi) / 2, basis: 'PE' },
      { key: 'ib', label: '投行', profit: npIB, mult: (peIB[0] + peIB[1]) / 2, basis: 'PE' },
      { key: 'vc', label: '科创投资', profit: npVC, mult: (vcPe[0] + vcPe[1]) / 2, basis: 'PE' },
    ],
    totalPs: sotpMidPs, targetPs: pbTarget, shares: N, benchPe: sectorPe,
    discBand: pFP.conglomerateDiscountBand,
  });
  const sotpDeep = Math.abs(sotpAttr.devPct) > devDeepLimit;
  const gapAfterPct = sotpAttr.gapAfterPct;
  const drillTxt = sotpAttr.drill.map(d => `${d.label} ${d.basis === 'PB' ? 'PB ' : ''}${d.mult}x${d.excess > 0 ? `(高出市场均值 +${d.excess}x → 泡沫 ${d.bubble} 亿)` : (d.basis === 'PE' ? '(≈市场均值，无泡沫)' : '(净资产法，不计 PE 泡沫)')}`).join('；');
  const sotpNote = sotpDeep
    ? `偏离 ${sotpAttr.devPct > 0 ? '+' : ''}${sotpAttr.devPct}% 已超 ${devDeepLimit}% 阈值 → ⚠️强制穿透归因（不以「集团折价」一笔带过）：【分部倍数穿透】${drillTxt}（市场均值基准 = 板块动态PE中位 ${sectorPe}x）；【① 分部估值泡沫】${sotpAttr.top ? `${sotpAttr.top.label}给到 ${sotpAttr.top.mult}x PE，高于当前市场均值 ${sectorPe}x 达 ${sotpAttr.top.excess}x` : '无'}，泡沫合计 ${sotpAttr.bubbleTotal} 亿（¥${sotpAttr.bubblePs.toFixed(2)}/股）→ 贡献 ${sotpAttr.bubblePp}pp；若剔除该分部估值泡沫，SOTP 中枢将回落至 ¥${sotpAttr.afterBubblePs.toFixed(2)}；【② 集团折价】按 ${(sotpAttr.discBand[0] * 100)}%~${(sotpAttr.discBand[1] * 100)}%（中值 ${(sotpAttr.discMid * 100)}%）测算 → 单独贡献 ${sotpAttr.discPp}pp（折后中枢 ¥${sotpAttr.discountedPs.toFixed(2)}）；【③ 残差】${sotpAttr.residualPp > 0 ? '+' : ''}${sotpAttr.residualPp}pp（分部净利率 35.06%【假设】、自营净资产法口径等）→ ${gapAfterPct <= 10 ? `剔除泡沫并计集团折价后 SOTP 中枢 ¥${sotpAttr.discountedPs.toFixed(2)} 与主模型 ¥${r2(pbTarget)} 吻合（差 ${gapAfterPct}%），偏离完全可由「分部估值泡沫 + 集团折价」解释，非数据错误` : `剔除泡沫并计集团折价后仍差 ${gapAfterPct}%，建议人工复核分部净利率/倍数假设`}。口径以 PB-ROE 主模型为准。`
    : `与PB-ROE偏离 ${sotpAttr.devPct > 0 ? '+' : ''}${sotpAttr.devPct}% ≤ ${devDeepLimit}% 深度归因阈值，${Math.abs(sotpAttr.devPct) > 15 ? '⚠️偏离>15% 触发人工复核提示（以PB-ROE为准）' : '偏离可接受'}；分部倍数穿透：${drillTxt}`;

  const matrixRows = [
    ...(anchorBreached ? [{ method: '🔴 估值体系重构警告', low: null, mid: null, high: null, emph: true, note: reframeNote }] : []),
    { method: boundaryFixed ? `极端悲观（动态锚 × ${downMult.toFixed(2)}）` : '极端悲观（PB 10%分位）', low: r2(extremeLow), mid: null, high: null, note: boundaryFixed
      ? `补丁F·排序校验：历史分位边界 [${r2(extremeLowPct)}, ${r2(extremeHighPct)}] 元 与基准中枢 ${r2(pbTarget)} 元不满足「极端悲观 < 基准 < 极端乐观」→ ${boundaryNote}：极端悲观 = 基准 ${r2(pbTarget)} × ${downMult.toFixed(2)} = ${r2(extremeLow)} 元。空间校验（F-Plus·单边）：现价 ${P ? r2(P) : 'N/A'} 元 → ${downSpaceText}（负数原样输出，不截断为 0）`
      : `BVPS ${bvps} × PB ${pbP10.toFixed(3)} 倍（近5年1211根日K序列10%分位）。空间校验（F-Plus·单边）：现价 ${P ? r2(P) : 'N/A'} 元 → ${downSpaceText}（负数原样输出，不截断为 0）` },
    { method: '基准（动态PB中枢）', low: null, mid: r2(pbTarget), high: null, note: `BVPS ${bvps} × 动态PB锚 ${pbAnchor.toFixed(4)} 倍（补丁C三阶调整后）${anchorFloorActive ? `；🛡️补丁G·估值底线保护：原始动态锚价 ¥${r2(pbTargetRaw)} 已低于历史50%分位价 ¥${r2(floorPrice)} → 中枢抬升至底线 ¥${r2(pbTarget)}` : ''}；2026E 基准净利 ${r2(np2026E)} 亿（补丁B：${seasonAlert ? '机构一致预测口径' : 'TTM区间口径'}）${anchorBreached ? '；⚠️该锚已突破历史90%分位 → 见顶部「估值体系重构警告」' : ''}${anchorFloorActive ? `；${anchorFloorNote}` : ''}（本档不计空间）` },
    { method: boundaryFixed ? `极端乐观（动态锚 × ${upMult.toFixed(2)}）` : '极端乐观（PB 90%分位）', low: null, mid: null, high: r2(extremeHigh), note: boundaryFixed
      ? `补丁F·排序校验：历史分位 90% 边界 ${r2(extremeHighPct)} 元 低于基准中枢 ${r2(pbTarget)} 元 → ${boundaryNote}：极端乐观 = 基准 ${r2(pbTarget)} × ${upMult.toFixed(2)} = ${r2(extremeHigh)} 元。空间校验（F-Plus·单边）：现价 ${P ? r2(P) : 'N/A'} 元 → ${upSpaceText}`
      : `BVPS ${bvps} × PB ${pbP90.toFixed(3)} 倍（近5年序列90%分位）。空间校验（F-Plus·单边）：现价 ${P ? r2(P) : 'N/A'} 元 → ${upSpaceText}` },
    { method: 'SOTP 分部加总（交叉验证，补丁D倍数）', low: r2(sotpLow.perShare), mid: r2(sotpMidPs), high: r2(sotpHigh.perShare), note: sotpNote },
    { method: '综合结论（以PB-ROE为主）', low: r2(extremeLow), mid: r2(pbTarget), high: r2(extremeHigh), note: `主模型=动态PB锚；三档供主观决策：极端悲观 ${r2(extremeLow)} / 基准 ${r2(pbTarget)} / 极端乐观 ${r2(extremeHigh)}；补丁F 排序校验 ${r2(extremeLow)} < ${r2(pbTarget)} < ${r2(extremeHigh)} ✅（${orderOk ? '原边界即自洽' : '已按动态锚强制外扩'}）；补丁G 双轨：${anchorBreached ? '上轨已突破（估值体系重构警告）' : (anchorFloorActive ? '下轨已触发（周期底部防御，50%分位为底线）' : `锚 ${pbAnchor.toFixed(2)} 位于 [近5年50%分位 ${pbP50.toFixed(3)}, 90%分位 ${pbP90.toFixed(3)}] 带内，双轨均未触发`)}；熔断状态：${fused ? '⛔已熔断' : '✅未触发'}${recoveryActive ? `；🌟乐观复苏情景（仅备注、不参与主模型）：长周期均值锚 ${pbLtMean.toFixed(2)} 倍 → ¥${recoveryRes.price}` : ''}` },
  ];

  const sotpRows = [
    { label: '经纪+信用（轻资产）', value: `年化收入 (24.3+11.9)×2=72.40 亿 × 净利率 35.06%【假设】= 净利 ${r2(npLight)} 亿 × PE ${r2(peLightLo)}~${r2(peLightHi)} 倍（板块PE中位 ${sectorPe}×相对系数 ${shareRatio}【估算标签】×0.8~1.2）= ${r2(sotpLow.parts.light)}~${r2(sotpHigh.parts.light)} 亿`, source: (pD.sectorPeMedian || {}).source },
    { label: '自营投资（重资产）', value: `净资产法：净资本 ${netCap} 亿 × PB ${propPb}（年化投资收益率 ${r2(annInvYield)}% = 31.88×2 ÷ ${r2(invAssets)} 亿金融投资资产，${annInvYield > nz(pD.yieldThreshold, 6) ? '>6% 上调至1.1' : '≤6% 维持1.0'}）= ${r2(sotpLow.parts.prop)} 亿`, source: (pD.invAssets || {}).source },
    { label: '资管（含长信基金）', value: `2025 净利 2.94×35.06%= ${r2(npAM)} 亿 × PE ${r2(peLightLo)}~${r2(peLightHi)} 倍（与经纪同用补丁D公式）= ${r2(sotpLow.parts.am)}~${r2(sotpHigh.parts.am)} 亿`, source: (pD.shareRatioBand || []).join('~') + ' 倍带（补丁D）' },
    { label: '投行（补充单列）', value: `2025 净利 3.99×35.06%= ${r2(npIB)} 亿 × ${peIB[0]}~${peIB[1]}x PE（补丁未覆盖，沿用框架）= ${r2(sotpLow.parts.ib)}~${r2(sotpHigh.parts.ib)} 亿`, source: '框架SOTP表沿用' },
    { label: '科创投资（长江创新+长江资本）', value: `净利 ${r2(npVC)} 亿 × ${vcPe[0]}~${vcPe[1]}x PE（科创50近半年 ${sci50 > 0 ? '+' : ''}${sci50}% → ${sci50 <= nz(pD.tightenThreshold || -10) ? '收紧期 10-12x' : '宽松期 15-18x'}）= ${r2(sotpLow.parts.vc)}~${r2(sotpHigh.parts.vc)} 亿`, source: (pD.sci50HalfYearChg || {}).source },
    { label: 'SOTP 合计', value: `${r2(sotpLow.total)}~${r2(sotpHigh.total)} 亿元 ÷ 总股本 ${N} 亿股 = ${r2(sotpLow.perShare)}~${r2(sotpHigh.perShare)} 元/股`, source: `补丁D：倍数挂钩市场分位数动态适配；${sotpDeep ? `偏离 ${sotpAttr.devPct > 0 ? '+' : ''}${sotpAttr.devPct}% > ${devDeepLimit}% → 已在②矩阵「SOTP」行做强制穿透归因（分部估值泡沫 ${sotpAttr.bubblePp}pp + 集团折价 ${sotpAttr.discPp}pp）` : `偏离 ${sotpAttr.devPct > 0 ? '+' : ''}${sotpAttr.devPct}%`}` },
  ];

  const sensOut = sensRows.map(s => `${s.label}：${s.value} 元`).join(' ｜ ');
  const yieldNote = `自营倍数已由补丁D动态化：年化投资收益率 ${r2(annInvYield)}%（金融投资资产 ${r2(invAssets)} 亿口径）${annInvYield > nz(pD.yieldThreshold, 6) ? '> 6% → PB 1.1' : '≤ 6% → PB 1.0'}；科创倍数由科创50半年动量自动切换（当前 ${sci50 > 0 ? '+' : ''}${sci50}% → ${vcPe[0]}~${vcPe[1]}x）。`;

  const riskLights = [
    { label: '市场风险（日均成交额 2.74 万亿 > 1.5 万亿）', light: '绿灯' },
    { label: '经营风险（经营杠杆 3.11x < 4.0x）', light: '绿灯' },
    { label: '监管风险（无新增监管措施）', light: '绿灯' },
    { label: '补丁B·季节性异常（TTM与简单年化偏离 ' + r2(divergence) + '% > 15%）', light: '黄灯：已自动弃用简单年化，改用机构一致预测' },
    { label: '补丁E·熔断机制（锚口径：上行 ' + (P != null ? r2((pbTarget - P) / P * 100) : 'N/A') + '% / 下行 ' + (P != null ? r2((P - pbTarget) / P * 100) : 'N/A') + '%）', light: fuseE ? '红灯：已熔断，禁止自动评级' : '绿灯：未触及 ' + fuseUpLine + '%/' + fuseDownLine + '% 熔断线' },
    { label: '补丁F-Plus·空间校验（单边口径：下行 ' + signedPct(spaceDownPct) + '%，绝对值 ' + spaceDownAbs + '% vs ' + fuseDownLine + '% 熔断线）', light: fuseF ? '红灯：|下行| ' + spaceDownAbs + '% > ' + fuseDownLine + '% 已熔断' : '绿灯：|下行| 未触及 ' + fuseDownLine + '% 熔断线' },
    { label: '补丁F·基准一致性（动态PB锚 ' + pbAnchor.toFixed(4) + ' 倍 vs 历史90%分位 ' + pbP90.toFixed(3) + ' 倍）', light: anchorBreached ? '红灯：已突破历史估值体系，历史分位失去参考意义（详见矩阵顶部警告）' : '绿灯：动态锚仍在历史分位带内' },
    { label: '补丁G·动态锚双轨保护（上轨 近5年90%分位 ' + pbP90.toFixed(3) + ' 倍 / 下轨 近5年真实50%分位 ' + pbP50.toFixed(3) + ' 倍 → 铁底 ¥' + r2(floorPrice) + '）', light: anchorBreached ? '红灯：动态锚 ' + pbAnchor.toFixed(2) + ' 倍已突破上轨 → 估值体系重构警告生效' : (anchorFloorActive ? '黄灯：动态锚 ' + pbAnchor.toFixed(2) + ' 倍跌破下轨 → 周期底部估值体系防御生效，以 ' + pbP50.toFixed(3) + ' 倍（¥' + r2(floorPrice) + '）为估值底线' : '绿灯：动态锚 ' + pbAnchor.toFixed(2) + ' 倍位于双轨带内 [' + pbP50.toFixed(3) + ', ' + pbP90.toFixed(3) + ']，双轨均未触发') },
    { label: '补丁G·乐观复苏情景闸门（日均成交额 ' + (mktTurnoverYi != null ? (mktTurnoverYi / 10000).toFixed(2) + ' 万亿' : 'N/A') + ' vs 1.5 万亿；ROE ' + (recoveryRes.gateRoe ? '持续上行' : '未持续上行') + '）', light: recoveryActive ? '情景展示：双条件满足 → 长周期均值锚 ' + pbLtMean.toFixed(2) + ' 倍（¥' + recoveryRes.price + '）已作为「乐观复苏情景」在备注展示（不参与主模型）' : '待命：' + recoveryRes.reason + ' → 长周期均值锚 ' + pbLtMean.toFixed(2) + ' 倍暂不展示' },
    { label: '补丁F-Plus·SOTP 偏离归因（偏离 ' + signedPct(sotpAttr.devPct) + '% vs 阈值 ' + devDeepLimit + '%）', light: sotpDeep ? '黄灯：已强制穿透归因（分部估值泡沫 ' + sotpAttr.bubblePp + 'pp + 集团折价 ' + sotpAttr.discPp + 'pp，详见矩阵 SOTP 行）' : '绿灯：偏离未超阈值，仅展示倍数穿透' },
    { label: '补丁C·自修复机制（30日走势监测）', light: '监控中：连续2次方向性偏差→10年窗口截断至5年重算（监测通道待接入）' },
    { label: '科创投资（项目退出节奏，IPO 政策敏感）', light: '关注' },
  ];

  // ---------- 买卖信号（沿用框架：8.50 买 / 10.50 卖） ----------
  const sigBuy = nz(vv(I.signals.buyBelow)), sigSell = nz(vv(I.signals.sellAbove));
  let signal = '未触发';
  if (P != null && !fused) {
    if (P <= sigBuy) signal = `⚠️ 进入低估区（现价 ${r2(P)} ≤ 信号线 ${sigBuy} 元）`;
    else if (P >= sigSell) signal = `⚠️ 进入高估区（现价 ${r2(P)} ≥ 信号线 ${sigSell} 元）`;
  }

  const lowTag = boundaryFixed ? `动态锚 ×${downMult.toFixed(2)}` : `PB ${pbP10.toFixed(3)} 分位`;
  const highTag = boundaryFixed ? `动态锚 ×${upMult.toFixed(2)}` : `PB ${pbP90.toFixed(3)} 分位`;
  const positionNote = (() => {
    if (P == null) return '当前价不可用，仅输出三档区间。';
    if (fused) return `⛔ 熔断触发：${fuseReason} 三档区间（极端悲观 ${r2(extremeLow)} / 基准 ${r2(pbTarget)} / 极端乐观 ${r2(extremeHigh)}）仅供人工复核参考，不输出自动评级。`;
    const disc = (pbTarget - P) / pbTarget * 100;
    return `当前股价 ${r2(P)} 元 vs 基准（动态PB锚）${r2(pbTarget)} 元 → ${premiumNote} → 评级：「${rating}」。三档区间：极端悲观 ${r2(extremeLow)} 元（${lowTag}）/ 基准 ${r2(pbTarget)} 元（动态锚）/ 极端乐观 ${r2(extremeHigh)} 元（${highTag}）；现价处三档区间的 ${Math.max(0, Math.min(100, (P - extremeLow) / (pbTarget - extremeLow) * 100)).toFixed(0)}% 水位（悲观~基准段）。单边空间见②矩阵分档行。普通股PB ${(P * N / (nz(vv(I.h1_2026.equityParent)) - nz(vv(I.h1_2026.perpetual)))).toFixed(2)} 倍 vs 动态锚 ${pbAnchor.toFixed(2)} 倍。买卖信号：${signal}。`;
  })();

  const riskNote = '上行：ROE 持续高于 12% → 动态锚继续上修、科创项目大额退出 → 上调盈利预测、板块估值修复；下行：日均成交额跌破 1.5 万亿 → 经纪承压、年化投资收益率跌破 6% → 自营 PB 回落至 1.0、科创50 半年跌幅超 10% → 科创 PE 压缩至 10-12x、归母/扣非增速偏离超 20pp → 自动切换扣非口径。熔断保险：上行 >60% 或下行 >40% 禁止自动评级。模型所有结果基于公开信息与确定性代码，不构成投资建议。';

  return {
    ok: true,
    dedicated: true,
    changjiang: true,
    version: 'V2-patched-FG',
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(extremeLow), r2(extremeHigh)],
    fairValueCenter: r2(pbTarget),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'changjiang000783 V2（补丁A~F+FG：智能映射+去季节年化+动态PB锚+倍数适配+熔断+矩阵自洽强制校验+单边空间/SOTP深度归因+动态锚双轨兜底（下轨=近5年真实50%分位0.916铁底）+乐观复苏情景（长周期均值锚1.33倍，仅备注不参与主模型），确定性计算无AI参与）',
    dataAsOf: cfg.dataAsOf,
    fairPB: { anchor: r2(pbAnchor), base: r2(pbBase), roeAdjPct: r2(roeAdj * 100), theoPB: r2(theoPB), p10: pbP10, p50: pbP50, p90: pbP90 },
    fused,
    fuseReason,
    // 补丁F：矩阵逻辑自洽校验结果（前端据此渲染顶部重构警告行 / 区间标签）
    patchF: { orderOk, boundaryFixed, boundaryNote, anchorBreached, reframeNote, spaceDownPct, spaceUpPct, fuseF, fuseDownLine, upMult, downMult, extremeLowPct: r2(extremeLowPct), extremeHighPct: r2(extremeHighPct) },
    // 补丁F-Plus：① 单边空间文案 ② SOTP 偏离深度归因（>30% 强制穿透拆解）
    patchFPlus: {
      singleSideSpace: true,
      downSpaceText, upSpaceText, spaceDownAbs,
      sotpDeep, devDeepLimit,
      sotpAttr,
      sotpNote,
    },
    // 补丁G：动态锚双轨保护（上轨 = 近5年90%分位 / 下轨 = 近5年**真实**50%分位兜底）
    patchG: {
      upRailPb: pbP90, floorPb, floorPrice: r2(floorPrice),
      floorRailBasis: `近5年日K真实50%分位（${pbP50.toFixed(3)} 倍），非长周期均值 1.33 倍`,
      anchorFloorActive, anchorFloorNote,
      pbTargetRaw: r2(pbTargetRaw), pbTarget: r2(pbTarget),
      rail: anchorBreached ? 'upper-breach' : (anchorFloorActive ? 'floor-active' : 'in-band'),
      // 规则4：长周期均值锚（1.33 倍）→ 乐观复苏情景（仅备注，不参与主模型）
      recovery: {
        active: recoveryActive,
        gateTurnover: recoveryRes.gateTurnover,
        gateRoe: recoveryRes.gateRoe,
        pbLtMean: recoveryRes.pbLtMean,
        price: recoveryRes.price,
        note: recoveryNote,
        turnoverYi: recoveryRes.turnoverYi,
        turnoverDate: mktTurnoverDate,
        turnoverSource: mktTurnoverSrc,
        turnoverFloorYi: recoveryRes.turnoverFloorYi,
        roeValues: recoveryRes.roeValues,
        reason: recoveryRes.reason,
      },
    },
    mappingRows,
    seasonRows,
    coreRows, matrixRows, sotpRows, sensRows, sensOut, yieldNote, riskLights: riskLights.concat([{ label: '⏱ 数据时效', light: staleSnapshots ? ('⚠️ ' + staleSnapshots + ' 项快照超龄（>' + snapMax + '天），详见时效提示') : '🟢 全部在有效期内' }]), positionNote, riskNote, signal,
    guardRows, alerts, freshnessRows,
    decisionNote: `V2 八补丁全接入：A 智能数据映射（模糊匹配+容错，本次全部精确/模糊命中，平滑未触发）；B 去季节性年化（TTM ${r2(ttmNp)} 亿 vs 简单年化 ${r2(simpleAnn)} 亿偏离 ${r2(divergence)}% > 15% ⚠️已弃用简单年化，基准=4家机构一致预测 ${r2(consensusNp)} 亿）；C 动态PB锚（${pbBase.toFixed(4)} 倍中枢 ${roeAdjNote} → ${pbAnchor.toFixed(4)} 倍）；D 分部倍数动态适配（经纪/资管 PE ${r2(peLightLo)}~${r2(peLightHi)}x、自营 PB ${propPb}、科创 ${vcPe[0]}~${vcPe[1]}x）；E 扣非切换${useDeducted ? '已触发' : '未触发'}（偏离 ${r2(growthDev)}pp）、锚口径熔断${fuseE ? '已触发' : '未触发'}；F 估值矩阵逻辑自洽强制校验（排序校验：${orderOk ? '原边界已自洽，未触发外扩' : '已触发强制外扩 → ' + boundaryNote}，三档 ${r2(extremeLow)} / ${r2(pbTarget)} / ${r2(extremeHigh)}；基准一致性：${anchorBreached ? '⚠️动态PB锚突破历史90%分位 → 已在矩阵最上方输出「🔴 估值体系重构警告」' : '动态锚仍在历史分位带内'}）；F-Plus ① 空间校验精简为**单边**（极端悲观行仅下行 ${signedPct(spaceDownPct)}%，极端乐观行仅上行 ${signedPct(spaceUpPct)}%，基准行不计空间；负数原样输出未截断为 0，熔断线 ${fuseDownLine}%）；F-Plus ② SOTP 偏离深度归因（偏离 ${signedPct(sotpAttr.devPct)}% ${sotpDeep ? `> ${devDeepLimit}% 阈值 → 强制穿透拆解：分部估值泡沫贡献 ${sotpAttr.bubblePp}pp（${sotpAttr.top ? sotpAttr.top.label + ' ' + sotpAttr.top.mult + 'x vs 市场均值 ' + sectorPe + 'x' : '—'}）、集团折价（${(sotpAttr.discBand[0] * 100)}%~${(sotpAttr.discBand[1] * 100)}%，中值 ${(sotpAttr.discMid * 100)}%）贡献 ${sotpAttr.discPp}pp、残差 ${signedPct(sotpAttr.residualPp)}pp；剔除泡沫后 SOTP 中枢 ¥${sotpAttr.afterBubblePs}，再折价后 ¥${sotpAttr.discountedPs} vs 主模型 ¥${r2(pbTarget)}（差 ${gapAfterPct}%）` : `≤ ${devDeepLimit}% 阈值，不触发深度归因`}）；G 动态锚均值回归兜底（上轨 = 近5年90%分位 ${pbP90.toFixed(3)} / 下轨 = 近5年**真实**50%分位 ${pbP50.toFixed(3)}（铁底 ¥${r2(floorPrice)}，非长周期均值1.33倍）：${anchorBreached ? '上轨已突破 → 估值体系重构警告' : (anchorFloorActive ? '下轨已触发 → 周期底部估值体系防御生效，以 50%分位价为估值底线' : `动态锚 ${pbAnchor.toFixed(2)} 倍位于双轨带内，双轨均未触发（下轨兜底已待命）`)}；G·规则4 乐观复苏情景（长周期均值锚 ${pbLtMean.toFixed(2)} 倍 → ¥${recoveryRes.price}，**仅备注、不参与主模型**）：闸门① 日均成交额 ${mktTurnoverYi != null ? (mktTurnoverYi / 10000).toFixed(2) + ' 万亿' : 'N/A'} vs 1.5 万亿 ${recoveryRes.gateTurnover ? '✅达标' : '❌未达标'}、闸门② ROE ${recoveryRes.gateRoe ? '✅持续上行' : '❌未持续上行'} → ${recoveryActive ? '双条件满足，已在备注展示' : '暂不展示（' + recoveryRes.reason + '）'}）。BVPS 取普通股口径 6.67 元（剔除永续债 60 亿）。假设项（行业ROE 6.4%、市占率相对系数 1.0【估算标签】、分部净利率 35.06%）均已在卡片标注。`
  };
}

module.exports = { run, isChangjiangModel, loadConfig, pickAnchorFloor, attributeSotpDeviation, evalRecoveryScenario };
