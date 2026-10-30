// ============================================================
// 长江证券（000783）专属动态估值引擎 V3-五法则 —— 确定性计算（1+1=2 原则）
// 20261029o：按用户下发《长江证券专属估值模型更新》五法则重构，并全量重算接入 2026 三季报：
//   第一法则 数据分层与时间戳对齐：刚性实时层（BVPS/总资产/归母/扣非/经营现金流/投资资产规模）
//            一律取最新报告期三表科目，标 [最新报告期]；柔性平滑层（经纪/投行/资管/自营细分营收、
//            AUM、市占率、净资本）在三季报期严禁「最新总营收×上次占比」估算，改用
//            「上次已知分部 × 全市场相关指标增幅」自上而下推演，标 [推算估算值]。
//   第二法则 TTM重构：动态PB锚的 ROE = TTM归母（或熔断后扣非TTM）÷ 最新报告期平均归母净资产
//            （期初/期末普通股口径均值，剔除永续债），严禁单季非年化或简单×4；
//            机构预测 2026E 一律标 [预测口径]。目标价 P = 最新 BVPS × 动态PB倍数。
//   第三法则 主辅模型动态权重与休眠：主模型 PB-ROE 永远在线（唯一核心基准）；
//            辅模型 SOTP 动态睡眠——年报/中报期正常运作（偏离>30% 深度拆解）；
//            一季报/三季报期强制休眠降级，结果仅作参考上限，标注
//            「因财报披露颗粒度不足，SOTP暂不作为决策依据」（不再提示人工复核）。
//   第四法则 历史分位与动态锚双轨防御：上轨 = 近5年90%分位（动态锚突破 → 估值体系重构警告，
//            说明 ROE 质变已打破历史规律，当前估值以动态锚为准）；下轨 = 近5年真实50%分位
//            （周期底部估值铁底，跌破禁止无限看空）。
//   第五法则 逻辑自洽与极值熔断：三档排序强校验（悲观<基准<乐观，违反强制外扩）；
//            空间单边展示（悲观行只下行、乐观行只上行，负值严禁截断为0）；
//            熔断：归母与扣非同比偏离>20pp 弃用归母改用扣非；上行>60% 或下行>40% 禁止自动评级。
//   输出模板：① 数据新鲜度仪表盘 ② 核心估值结论矩阵（三档+计算依据）③ ≤200字核心逻辑摘要。
//   继承 V2 补丁A~G 中仍适用的机制：扣非切换/熔断（E）、矩阵自洽（F）、单边空间/SOTP归因（F-Plus，
//   休眠期豁免深度归因）、动态锚双轨（G）、乐观复苏情景（G·规则4，长周期均值锚仅备注）。
//   补丁A/B 的「配置锁死财报数据」被全量重算取代（V2 数据层升级为三表实时拉取）；
//   补丁C 动态PB锚保留（ROE 输入按第二法则改为 TTM 口径）；补丁D 倍数适配保留（SOTP 休眠期用）。
// 计算层=代码，输入=每次全量重算的三表 + data/valuation/000783.json 锁死假设 ⇒ 结果锁死。
//   补丁I（20261030e）·极值纠偏、逻辑闭环与动态数据强同步：①运行时态现价强同步（严禁历史残留现价，
//     强制当日行情快照现价）；②估值锚「三位一体」向下约束（主模型PB锚 ≤ 理论PB锚，中枢封顶）；
//     ③悲观/乐观边界常识校验（现价破极端悲观价则锁铁底、禁报正下行空间，乐观复苏价须 > 极端悲观价）；
//     ④周期股戴维斯双杀预警 + 熔断降级（价格大幅低于中枢时不红灯禁止评级，降级为绿色「绝对低估/重大机会」并输出买入区间）。
// ============================================================
const path = require('path');
const fs = require('fs');
const brk = require('../brokerSectorTurnover');   // 市场日均成交额（本地存盘，同步可读）

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
const yi = (x) => (x == null || !isFinite(Number(x))) ? null : Number(x) / 1e8; // 元 → 亿

// ============================================================
// 纯函数（可独立单测，不读磁盘、不依赖 run 上下文）—— 继承 V2
// ============================================================

/** 第四法则·下轨铁底：动态锚低于近5年真实50%分位 → 以50%分位价为估值底线 */
function pickAnchorFloor({ pbAnchor, pbP50, bvps }) {
  const a = Number(pbAnchor), f = Number(pbP50), b = Number(bvps);
  const floorPrice = b * f, rawPrice = b * a;
  const active = isFinite(a) && isFinite(f) && a < f;
  return { active, floorPb: f, floorPrice, rawPrice, target: active ? Math.max(rawPrice, floorPrice) : rawPrice };
}

/** 第四法则·G规则4：长周期均值锚 → 乐观复苏情景（双闸门，仅备注不参与主模型） */
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
    active, gateTurnover, gateRoe, pbLtMean: lt,
    price: (lt > 0 && b > 0) ? R2(b * lt) : null,
    turnoverYi: tYi != null ? R2(tYi) : null, turnoverFloorYi: floorYi,
    roeValues: vals, predictedRoePct: pred,
    failReason: active ? '' : (gateTurnover ? f2 : (gateRoe ? f1 : f1 + '；' + f2)),
    reason: active ? '双条件同时满足' : `未同时满足（${gateTurnover ? '' : f1 + '；'}${gateRoe ? '' : f2}）`,
  };
}

/** F-Plus·SOTP 偏离深度归因（年报/中报期启用；休眠期不调用） */
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
    devPct: R2(devPct), benchPe: bench, discMid: R2(discMid), discBand: band,
    bubbleTotal: R2(bubbleTotal), bubblePs: R2(bubblePs), bubblePp: R2(bubblePp),
    afterBubblePs: R2(afterBubblePs), discPp: R2(discPp), discountedPs: R2(discountedPs),
    residualPp: R2(devPct - bubblePp - discPp),
    gapAfterPct: target ? R2(Math.abs(discountedPs - target) / target * 100) : 0,
    drill, top,
  };
}

/**
 * 补丁I·规则④：周期股「戴维斯双杀」预警（确定性文案，非 AI 生成）
 * 券商为强周期行业，TTM ROE 含牛市溢价；若宏观交投活跃度回落，ROE 向中枢回归、PB 锚压缩。
 */
function buildDavisNote({ q3Turnover, predRoe, roeMidLo, roeMidHi, pbTarget, centerLabel }) {
  const R2 = (x) => Math.round(Number(x) * 100) / 100;
  const tq = (q3Turnover != null ? (q3Turnover / 10000) : null);
  return `⚠️ 周期股「戴维斯双杀」预警：券商为强周期行业，当前 TTM ROE（${R2(predRoe)}%）含牛市溢价。若宏观交投活跃度（Q3 日均 ${tq != null ? R2(tq) + ' 万亿' : 'N/A'}）回落，ROE 存在向中枢（${roeMidLo}%~${roeMidHi}%）回归风险，届时 PB 锚将压缩。因此，当前${centerLabel}给出的 ¥${R2(pbTarget)} 中枢不可作为无脑看多目标，仅作牛市延续情景下的理论值。`;
}

// ============================================================
// 全量重算入口（async）
// ============================================================
async function run(symbol, { price, statements, balanceQuarterly } = {}) {
  const cfg0 = loadConfig();
  const bare0 = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg0 || bare0 !== SYM || cfg0.kind !== 'changjiang') return { error: 'NOT_CHANGJIANG' };
  const runId = `${Date.now()}_${Math.floor(Math.random() * 9000 + 1000)}`;
  const startedAt = new Date().toISOString();
  try {
    let stmts = statements || null;
    let balQ = balanceQuarterly || null;
    if (!stmts || !balQ) {
      const { fetchFinancialData, fetchFinancialStatement } = require('../deep/financials');
      if (!stmts) stmts = await fetchFinancialData(`SZ${SYM}`);
      if (!balQ) {
        // 最新报告期资产负债表（fetchFinancialData 仅合并利润表/现金流量表的部分报告期，资产负债表需自取）
        const cy = new Date().getFullYear();
        const qe = ['03-31', '06-30', '09-30', '12-31'];
        const dates = [];
        for (const d of qe) dates.push(`${cy}-${d}`, `${cy - 1}-${d}`);
        balQ = await fetchFinancialStatement('zcfzbAjaxNew', `SZ${SYM}`, dates);
      }
    }
    return compute(symbol, { price }, { statements: stmts, balanceQuarterly: balQ }, runId, startedAt);
  } catch (err) {
    appendRunLog({ run_id: runId, model_version: 'V3-五法则', run_time: startedAt, error_stack: String(err && err.stack || err) });
    return { ok: false, success: false, message: `估值引擎运行失败：${err && err.message}（已记录运行日志 ${runId}，可回溯排查）` };
  }
}

function appendRunLog(record) {
  try {
    const dir = path.join(__dirname, '../../data/logs/valuation_logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, '000783.jsonl');
    let lines = [];
    if (fs.existsSync(p)) lines = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim());
    lines.push(JSON.stringify(record));
    if (lines.length > 100) lines = lines.slice(-100);
    fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8');
  } catch (e) { /* 日志失败不阻断估值 */ }
}

// 报表行工具
function rowOf(rows, period) {
  if (!Array.isArray(rows)) return null;
  return rows.find((r) => String(r.REPORT_DATE || '').slice(0, 10) === period) || null;
}

// ============================================================
// compute：V3-五法则 主流程
// ============================================================
async function compute(symbol, { price }, data, runId, startedAt) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'changjiang') return { error: 'NOT_CHANGJIANG' };
  const I = cfg.inputs;
  const pE = I.patchE, pC = I.patchC, pD = I.patchD, pFP = I.patchFPlus || {}, pG = I.patchG || {}, G = I.guard || {};
  const pI = I.patchI || {};   // 补丁I·极值纠偏、逻辑闭环与动态数据强同步
  const LAW = I.lawData || {};
  const today0 = new Date();

  // ===== ① 全量重算：三表 → 最新报告期（as-of）=====
  const incRows = (data.statements && Array.isArray(data.statements.income)) ? data.statements.income : [];
  const balRowsA = (data.statements && Array.isArray(data.statements.balance)) ? data.statements.balance : [];
  const cfRows = (data.statements && Array.isArray(data.statements.cashflow)) ? data.statements.cashflow : [];
  const balQRows = Array.isArray(data.balanceQuarterly) ? data.balanceQuarterly : [];
  if (!incRows.length || !balQRows.length) {
    appendRunLog({ run_id: runId, model_version: 'V3-五法则', run_time: startedAt, error_stack: '全量重算中止：三表/最新报告期资产负债表不可得' });
    return { ok: false, success: false, message: '全量重算中止：本次三表数据不可得（刚性实时层禁用旧值），请稍后重试或检查数据链' };
  }
  const incSorted = incRows.slice().sort((a, b) => String(a.REPORT_DATE).localeCompare(String(b.REPORT_DATE)));
  const asOf = String(incSorted[incSorted.length - 1].REPORT_DATE).slice(0, 10);           // 如 2026-09-30
  const asOfStage = asOf.slice(5);                                                          // '09-30'
  const prevYearSame = `${Number(asOf.slice(0, 4)) - 1}${asOf.slice(4)}`;
  const incCur = rowOf(incSorted, asOf), incPrev = rowOf(incSorted, prevYearSame), incFY = rowOf(incSorted, `${Number(asOf.slice(0, 4)) - 1}-12-31`) || rowOf(incSorted, `${asOf.slice(0, 4)}-12-31`);
  const incH1 = rowOf(incSorted, `${asOf.slice(0, 4)}-06-30`);                              // 同年中报（刚性层已披露过）
  const cfCur = rowOf(cfRows, asOf);
  const balQ3 = rowOf(balQRows, asOf) || balQRows[balQRows.length - 1];
  const balFY25 = rowOf(balQRows, `${Number(asOf.slice(0, 4)) - 1}-12-31`) || rowOf(balRowsA, `${Number(asOf.slice(0, 4)) - 1}-12-31`) || balRowsA[balRowsA.length - 1];
  const asOfPeriodTag = '［最新报告期］';
  if (!incCur || !balQ3 || !incFY || !incPrev) {
    appendRunLog({ run_id: runId, model_version: 'V3-五法则', run_time: startedAt, error_stack: `全量重算中止：TTM 合成所需报告期缺失（asOf=${asOf}，上年同期=${prevYearSame}），禁止跨期混算` });
    return { ok: false, success: false, message: `全量重算中止：TTM 合成所需的上年同期累计数据不可得（${prevYearSame}），按数据分层铁律中止计算，绝不跨期混算` };
  }

  // ===== ② 刚性实时层（第一法则：一律最新报告期，标 [最新报告期]）=====
  const N = nz(vv(I.shares));
  // 补丁I·规则①：运行时态数据强同步 —— 强制使用当日行情快照现价，严禁任何历史残留现价（如 8.51）。
  // 优先使用调用方注入的实时价；若未注入，则回退当日行情快照（仍属当日实时价），绝不沿用旧目标价/硬编码值。
  let priceSource = (price != null && isFinite(Number(price)) && Number(price) > 0) ? 'caller-injected-live' : null;
  if (priceSource == null) {
    try {
      const { getQuote } = require('../stockData');
      const q = await getQuote(`SZ${SYM}`);
      if (q && q.price) { price = q.price; priceSource = 'live-quote-fallback'; }
    } catch (e) { /* 取不到实时价则 P=null，诚实标注，绝不静默替代 */ }
  }
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const rigid = [];
  const R = (key, label, value, period, source, unit) => {
    const item = { key, label, value: r2(value), period, tag: '［最新报告期］', source, unit: unit || '亿元' };
    rigid.push(item);
    return item;
  };
  const npTtm = yi(incFY.PARENT_NETPROFIT) - yi(incPrev.PARENT_NETPROFIT) + yi(incCur.PARENT_NETPROFIT);
  const npDedTtm = yi(incFY.DEDUCT_PARENT_NETPROFIT) - yi(incPrev.DEDUCT_PARENT_NETPROFIT) + yi(incCur.DEDUCT_PARENT_NETPROFIT);
  const npYoy = (yi(incPrev.PARENT_NETPROFIT) ? (yi(incCur.PARENT_NETPROFIT) / yi(incPrev.PARENT_NETPROFIT) - 1) * 100 : null);
  const npDedYoy = (yi(incPrev.DEDUCT_PARENT_NETPROFIT) ? (yi(incCur.DEDUCT_PARENT_NETPROFIT) / yi(incPrev.DEDUCT_PARENT_NETPROFIT) - 1) * 100 : null);
  R('np_ttm', '归母净利润（TTM）', npTtm, asOf, `三表勾稽：${Number(asOf.slice(0, 4)) - 1}年报 − ${prevYearSame}累计 + ${asOf}累计`);
  R('np_ded_ttm', '扣非净利润（TTM）', npDedTtm, asOf, '三表勾稽（DEDUCT_PARENT_NETPROFIT 同口径）');
  const perpQ3 = yi(balQ3.OTHER_EQUITY_TOOL) != null ? yi(balQ3.OTHER_EQUITY_TOOL) : nz(vv(I.h1_2026.perpetual));
  const perpFY = yi(balFY25.OTHER_EQUITY_TOOL) != null ? yi(balFY25.OTHER_EQUITY_TOOL) : perpQ3;
  const equityQ3 = yi(balQ3.TOTAL_PARENT_EQUITY), equityFY = yi(balFY25.TOTAL_PARENT_EQUITY);
  const bvps = (equityQ3 - perpQ3) / N;
  R('bvps', 'BVPS（普通股，剔除永续债）', bvps, asOf, `资产负债表：(归母净资产 ${r2(equityQ3)} − 其他权益工具 ${r2(perpQ3)}) ÷ 总股本 ${N} 亿股`, '元/股');
  R('equity_parent', '归母净资产（期末）', equityQ3, asOf, '资产负债表直接科目 TOTAL_PARENT_EQUITY');
  R('total_assets', '总资产', yi(balQ3.TOTAL_ASSETS), asOf, '资产负债表直接科目 TOTAL_ASSETS');
  const cfoCum = cfCur ? yi(cfCur.NETCASH_OPERATE) : null;
  if (cfoCum != null) R('cfo_cum', '经营现金流（年初至报告期末）', cfoCum, asOf, '现金流量表直接科目 NETCASH_OPERATE');
  const invAssets = (yi(balQ3.TRADE_FINASSET_NOTFVTPL) || 0) + (yi(balQ3.OTHER_CREDITOR_INVEST) || 0) + (yi(balQ3.OTHER_EQUITY_INVEST) || 0) + (yi(balQ3.DERIVE_FINASSET) || 0);
  R('inv_assets', '投资资产总规模', invAssets, asOf, `交易性金融资产 ${r2(yi(balQ3.TRADE_FINASSET_NOTFVTPL))} + 其他债权投资 ${r2(yi(balQ3.OTHER_CREDITOR_INVEST))} + 其他权益工具投资 ${r2(yi(balQ3.OTHER_EQUITY_INVEST))} + 衍生金融资产 ${r2(yi(balQ3.DERIVE_FINASSET))}`);
  // 东财券商利润表无净额字段（FEE_COMMISSION_NI/INTEREST_NI 不存在，直接取会假 0）：
  // 手续费只有收入侧 FEE_COMMISSION_INCOME（支出侧三季报未披露 → 净额不可得，诚实标注收入侧口径）；
  // 利息净收入可由收入−支出诚实勾稽：INTEREST_INCOME − INTEREST_EXPENSE。
  const feeInc = yi(incCur.FEE_COMMISSION_INCOME);
  const intInc = yi(incCur.INTEREST_INCOME), intExp = yi(incCur.INTEREST_EXPENSE);
  const intNI = (intInc != null && intExp != null) ? intInc - intExp : null;
  R('fee_inc', '手续费及佣金收入（累计，收入侧口径）', feeInc, asOf, '利润表直接科目 FEE_COMMISSION_INCOME（支出侧未披露，净额不可得）');
  R('int_ni', '利息净收入（累计，收入−支出勾稽）', intNI, asOf, `利息收入 ${r2(intInc)} − 利息支出 ${r2(intExp)}（INTEREST_INCOME − INTEREST_EXPENSE）`);
  const invIncCum = (yi(incCur.INVEST_INCOME) || 0) + (yi(incCur.FAIRVALUE_CHANGE_INCOME) || 0);
  R('inv_inc_cum', '投资净收益（投资收益+公允价值变动，累计）', invIncCum, asOf, '利润表加总口径：INVEST_INCOME + FAIRVALUE_CHANGE_INCOME');
  const invIncH1 = incH1 ? (yi(incH1.INVEST_INCOME) || 0) + (yi(incH1.FAIRVALUE_CHANGE_INCOME) || 0) : null;
  const invIncQ3Single = invIncH1 != null ? invIncCum - invIncH1 : null;

  // ===== 第五法则·熔断1：归母 vs 扣非同比偏离 >20pp → 弃用归母改用扣非 =====
  const growthDev = (npYoy != null && npDedYoy != null) ? Math.abs(npYoy - npDedYoy) : null;
  const devLimitPp = nz(pE.deviationLimitPp, 20);
  const useDeducted = growthDev != null && growthDev > devLimitPp;
  const coreNpTtm = useDeducted ? npDedTtm : npTtm;
  const coreNpLabel = useDeducted ? '扣非TTM（熔断切换）' : '归母TTM';

  // ===== ③ 第二法则：TTM 重构（动态PB锚的 ROE）=====
  const equityAvg = ((equityFY - perpFY) + (equityQ3 - perpQ3)) / 2;    // 平均普通股净资产（期初/期末均值）
  const roeTtm = coreNpTtm / equityAvg * 100;
  // 预测 ROE（2026E，[预测口径]：机构一致预期净利 ÷ 估算平均净资产）
  const consensusNp = nz(vv(I.patchB.consensusNp));
  const predRoe = consensusNp / equityAvg * 100;

  // ===== ④ 补丁C：动态PB锚（行业PB × (40% + 60%×ROE相对系数) + 预测ROE越界修正）=====
  const indRoe = nz(vv(pC.industryRoe3y)) / 100, indPB = nz(vv(pC.industryPB));
  const roeRatio = (roeTtm / 100) / indRoe;
  const pbBase = indPB * 0.4 + roeRatio * indPB * 0.6;
  let roeAdj = 0, roeAdjNote = '';
  if (predRoe / 100 > indRoe * 1.2) { roeAdj = (pC.roeUpBand[0] + pC.roeUpBand[1]) / 2 / 100; roeAdjNote = `预测ROE ${r2(predRoe)}%［预测口径］ > 行业均值×1.2（${r2(indRoe * 120)}%）→ PB锚按区间中值上修 +${r2(roeAdj * 100)}%`; }
  else if (predRoe / 100 < indRoe * 0.8) { roeAdj = (pC.roeDownBand[0] + pC.roeDownBand[1]) / 2 / 100; roeAdjNote = `预测ROE ${r2(predRoe)}%［预测口径］ < 行业均值×0.8（${r2(indRoe * 80)}%）→ PB锚下修 ${r2(Math.abs(roeAdj) * 100)}%`; }
  else { roeAdjNote = `预测ROE ${r2(predRoe)}%［预测口径］ 处行业均值 0.8~1.2 倍带内 → 不修正`; }
  const pbAnchor = pbBase * (1 + roeAdj);

  // ===== 补丁I·规则②：估值锚「三位一体」向下约束（防悬空）=====
  // 理论PB（ROE-PB框架）作为主模型PB锚的硬上限：动态PB锚（含牛市溢价）不得超过理论PB锚。
  const gPerp = nz(vv(I.roeLayer.theoG)) / 100, rEq = nz(vv(I.roeLayer.costOfEquity)) / 100;
  const theoPB = (predRoe / 100 - gPerp) / (rEq - gPerp);
  const anchorCapEnabled = pI.enableAnchorCap !== false;   // 默认启用（仅当显式 false 才关闭）
  const pbAnchorRaw = pbAnchor;                                   // 原始动态PB锚（含牛市溢价）
  const pbAnchorEff = (anchorCapEnabled && pbAnchorRaw > theoPB) ? theoPB : pbAnchorRaw;  // 封顶后的主模型PB锚
  const anchorCapped = anchorCapEnabled && pbAnchorRaw > theoPB + 1e-9;

  // ===== ⑤ 第四法则：历史分位双轨防御 =====
  const pbP10 = nz(vv(pE.pbP10)), pbP50 = nz(vv(pE.pbP50)), pbP90 = nz(vv(pE.pbP90));
  const floorRes = pickAnchorFloor({ pbAnchor: pbAnchorEff, pbP50, bvps });
  const anchorFloorActive = floorRes.active;
  const pbTargetRaw = floorRes.rawPrice;
  const pbTarget = floorRes.target;
  // 上轨突破判定基于「原始动态锚」（反映 ROE 质变本质），与封顶后中枢解耦，保证警告语义准确
  const anchorBreached = pbAnchorRaw > pbP90;
  const reframeNote = `原始动态PB锚 ${pbAnchorRaw.toFixed(4)} 倍 已高于近5年90%分位 ${pbP90.toFixed(3)} 倍 → ROE 质变已打破历史规律（TTM ROE ${r2(roeTtm)}% vs 历史分位带覆盖的 ROE 5%~10% 区间），当前模型有效锚 = ${pbAnchorEff.toFixed(4)} 倍（理论PB封顶已生效），历史分位仅作背景参照。${anchorCapped ? `（补丁I·三位一体向下约束已生效：主模型PB锚由 ${pbAnchorRaw.toFixed(4)} 倍封顶至理论PB锚 ${theoPB.toFixed(4)} 倍，中枢 ≤ ¥${r2(pbTarget)}）` : ''}`;
  const anchorFloorNote = `已触及近5年真实估值铁底（${pbP50.toFixed(3)}倍），市场处于极度悲观定价，下行空间有限，静待均值回归。`;

  // ===== 第三法则：SOTP 休眠判定 =====
  const sotpDormant = !(asOfStage === '12-31' || asOfStage === '06-30');   // 一季报/三季报期 → 休眠降级
  const sotpStageLabel = asOfStage === '12-31' ? '年报期' : (asOfStage === '06-30' ? '中报期' : (asOfStage === '09-30' ? '三季报期' : '一季报期'));

  // ===== ⑥ 柔性平滑层（第一法则：三季报期严禁「总营收×上次占比」，按市场指标增幅推演，标 [推算估算值]）=====
  const soft = [];
  const S = (key, label, value, basisPeriod, method) => {
    const item = { key, label, value: r2(value), period: basisPeriod, tag: '［推算估算值］', method };
    soft.push(item);
    return item;
  };
  const h1Broker = nz(vv(I.h1_2026.bizMix.brokerage));                     // 上次已知分部（2026中报披露）
  const h1Turnover = nz(LAW.h1TurnoverAvgYi, 27400);                       // 2026H1 全市场日均成交额（亿）
  const q3Turnover = nz(LAW.q3TurnoverAvgYi, 23163);                       // 2026Q3 全市场日均成交额（亿）
  const turnoverFactor = q3Turnover / h1Turnover;                          // 0.8454（Q3 单季成交额因子）
  const broker3q = h1Broker + h1Broker / 2 * turnoverFactor;               // 前三季经纪 = H1实际 + Q3推算
  S('broker_3q', '经纪业务收入（前三季）', broker3q, '2026中报（上次已知）', `上次已知 ${r2(h1Broker)}亿（中报）+ Q3推算 ${r2(h1Broker / 2)}×${r2(turnoverFactor)}（Q3日均成交额 ${q3Turnover} 亿 ÷ H1日均 ${h1Turnover} 亿，Wind口径）= ${r2(broker3q)} 亿`);
  const am2025 = nz(vv(I.h1_2026.bizMix.am2025));
  const am3q = am2025 * (9 / 12);
  S('am_3q', '资管业务收入（前三季）', am3q, '2025年报（上次已知）', `上次已知 ${am2025}亿（年报）× 9/12（中性景气，三季报无分部披露）= ${r2(am3q)} 亿`);
  const ib2025 = nz(vv(I.h1_2026.bizMix.ib2025));
  const ipoFactor = 1 + nz(LAW.ipoCount3qYoyPct, 67.11) / 100;
  const ib3q = ib2025 * (9 / 12) * ipoFactor;
  S('ib_3q', '投行业务收入（前三季）', ib3q, '2025年报（上次已知）', `上次已知 ${ib2025}亿 × 9/12 × ${r2(ipoFactor)}（前三季A股IPO 127家，同比 +${nz(LAW.ipoCount3qYoyPct, 67.11)}%，Wind口径）= ${r2(ib3q)} 亿`);
  const vcH1 = nz(vv(I.h1_2026.vcProfit));
  const sciH1 = nz(LAW.sci50H1Pct, 64.25), sci9m = nz(LAW.sci50NineMPct, 13.82);
  const sciQ3Single = (1 + sci9m / 100) / (1 + sciH1 / 100) - 1;           // Q3 单季科创50 ≈ −30.7%
  const vc3q = vcH1 + vcH1 / 2 * sciQ3Single;
  S('vc_3q', '科创投资利润（前三季，穿透）', vc3q, '2026中报（上次已知）', `上次已知 ${vcH1}亿（中报穿透）+ Q3推算 ${r2(vcH1 / 2)}×${r2(sciQ3Single * 100)}%（科创50 Q3单季 = (1+${sci9m}%)/(1+${sciH1}%)+${r2(sciQ3Single * 100)}%）= ${r2(vc3q)} 亿`);
  const netCapital = nz(vv(I.sotpLayer.netCapital));                       // 2025 风控报告（上次已知，柔性）
  S('net_capital', '净资本（自营资本占用代理）', netCapital, '2025年度风控指标报告（上次已知）', '三季报不披露净资本 → 沿用上次已知值，待年报更新');

  // ===== ⑦ SOTP（休眠降级：结果仅作参考上限）=====
  const nm = nz(vv(I.sotpLayer.netMargin)) / 100;
  const sectorPe = nz(vv(pD.sectorPeMedian));
  const shareRatio = nz(vv(pD.brokerShareRatio), 1.0);
  const srb = pD.shareRatioBand || [0.8, 1.2];
  const peLightLo = sectorPe * shareRatio * srb[0], peLightHi = sectorPe * shareRatio * srb[1];
  const annInvYield = invIncCum * (4 / 3) / invAssets * 100;               // 年化（Q3累计×4/3，休眠期推算口径）
  const propPb = annInvYield > (nz(pD.yieldThreshold) || 6) ? (nz(pD.propPbUp) || 1.1) : (nz(pD.propPbBase) || 1.0);
  const sci50 = sci9m;
  const vcPe = sci50 <= nz(pD.tightenThreshold || -10) ? (pD.vcPeTight || [10, 12]) : (pD.vcPeLoose || [15, 18]);
  const peIB = pD.peIB || [10, 15];
  const npLight = (broker3q + nz(intNI)) * (4 / 3) * nm;
  const npAM = am3q * nm;
  const npIB = ib3q * nm;
  const npVC = vc3q;
  function sotp(kind) {
    const sc = kind === 'low' ? 0 : kind === 'high' ? 1 : 0.5;
    const parts = {
      light: npLight * (peLightLo + (peLightHi - peLightLo) * sc),
      prop: netCapital * propPb,
      am: npAM * (peLightLo + (peLightHi - peLightLo) * sc),
      ib: npIB * (peIB[0] + (peIB[1] - peIB[0]) * sc),
      vc: npVC * (vcPe[0] + (vcPe[1] - vcPe[0]) * sc),
    };
    const total = Object.values(parts).reduce((a, b) => a + b, 0);
    return { total, perShare: total / N, parts };
  }
  const sotpLow = sotp('low'), sotpHigh = sotp('high');
  const sotpMidPs = (sotpLow.perShare + sotpHigh.perShare) / 2;
  const sotpDev = (sotpMidPs - pbTarget) / pbTarget * 100;
  const sotpDormantNote = `⏸️ SOTP 休眠降级（${sotpStageLabel}）：因财报披露颗粒度不足，SOTP暂不作为决策依据。分部数据全部为柔性平滑层推算（标［推算估算值］），其估值结果 ${r2(sotpMidPs)} 元仅作为参考上限列示，不参与主模型与评级；待年报/中报分部数据齐全后自动恢复运作。`;

  // ===== ⑧ 守门员自检（财报时效）=====
  const reportAge = daysBetween(asOf, today0);
  const maxAge = nz(G.maxAgeDays) || 180;
  const guardRows = [];
  const alerts = [];
  const freshnessRows = [];
  guardRows.push({ label: '① 财报时效', status: reportAge <= maxAge ? '✅ 通过' : '⛔ 终止', value: `最新报告截止 ${asOf}（${sotpStageLabel}），距检查日 ${reportAge} 天（终止上限 ${maxAge} 天）`, source: '全量重算：东财F10三表' });
  freshnessRows.push({ label: `估值基础报告期（${sotpStageLabel}）`, asOf, ageDays: reportAge, maxAge, stale: reportAge > maxAge });
  const terminated = reportAge > maxAge;
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
  if (terminated) {
    return {
      ok: true, dedicated: true, changjiang: true, terminated: true,
      version: 'V3-五法则', symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: asOf,
      model: 'changjiang000783 V3-五法则（守门员终止：估值结果待更新/需人工复核）',
      guardRows, freshnessRows,
      rating: '需人工复核', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 守门员自检未通过（估值基础财报超龄），模型终止本次估值，历史结论不再外推。请更新财报数据后重跑。',
      riskNote: '守门员终止期间不得引用旧目标价。',
    };
  }

  // ===== ⑨ 市场成交活跃度（柔性层景气度 + G规则4闸门数据）=====
  let mktTurnoverYi = null, mktTurnoverDate = null, mktTurnoverSrc = '';
  try {
    const st = brk._fromStore();
    if (st && st.market && st.market.length) {
      const m = brk.summarize(st.market);
      if (m && m.avg20Yi != null) { mktTurnoverYi = m.avg20Yi; mktTurnoverDate = m.date; mktTurnoverSrc = `同花顺·申万一级行业成交额合计，近 ${m.windowDays} 交易日日均（截至 ${m.date}）`; }
    }
  } catch (e) { /* 存盘不可读 → 退回配置快照 */ }
  if (mktTurnoverYi == null) { mktTurnoverYi = q3Turnover; mktTurnoverDate = asOf; mktTurnoverSrc = `2026Q3 全市场日均成交额（Wind口径，配置 lawData）`; }
  const recoveryRes = evalRecoveryScenario({
    bvps, pbLtMean: nz(vv(pG.longTermMeanPb), 1.33),
    turnoverYi: mktTurnoverYi, turnoverFloorYi: nz(pG.recoveryMarketTurnoverFloorYi) || 15000,
    roeValues: (pC.companyRoe3y || {}).values, predictedRoePct: predRoe,
  });
  const recoveryActive = recoveryRes.active;
  const pbLtMean = nz(vv(pG.longTermMeanPb), 1.33);
  // 补丁J·规则③：情景设定逻辑校验（消除倒挂）—— 若主模型基准中枢 > 长周期均值锚，则「乐观复苏情景」价格低于基准价格，
  // 构成反常识倒挂，自动失效并转为「均值回归底线」（下行保护参考），严禁输出「乐观情景价格低于基准价格」。
  const recoveryPrice = recoveryRes.price;
  const recoveryInverted = recoveryPrice != null && pbTarget > recoveryPrice + 1e-9;
  const recoveryLabel = recoveryInverted ? '均值回归底线' : '乐观复苏情景';
  const recoveryNote = recoveryActive
    ? `长周期均值锚 ${pbLtMean.toFixed(2)} 倍 × BVPS ${r2(bvps)} = ¥${recoveryPrice}（对照：主模型动态锚中枢 ¥${r2(pbTarget)}）。${recoveryInverted ? `该锚 ¥${recoveryPrice} 已低于主模型中枢 ¥${r2(pbTarget)}，「乐观复苏情景」倒挂失效，自动转为「均值回归底线」（下行保护参考，仅备注不参与主模型）。` : `该锚仅作「乐观复苏情景」备用目标，不参与主模型计算。`}闸门${recoveryActive ? '已' : '未'}同时满足：① ${mktTurnoverSrc}（日均 ${(mktTurnoverYi / 10000).toFixed(2)} 万亿 ≥ 1.5 万亿）；② 公司 ROE 持续上行（${recoveryRes.roeValues.join('% → ')}% → 2026E ${r2(predRoe)}%［预测口径］）。`
    : '';

  // ===== ⑩ 第五法则：三档区间 + 排序强校验 + 单边空间 + 熔断2 =====
  const extremeLowPct = bvps * pbP10, extremeHighPct = bvps * pbP90;
  const upMult = nz(pE.boundaryUpMult) || 1.20, downMult = nz(pE.boundaryDownMult) || 0.75;
  let extremeLow = extremeLowPct, extremeHigh = extremeHighPct;
  const orderOk = (extremeLow < pbTarget) && (pbTarget < extremeHigh);
  let boundaryFixed = false, boundaryNote = '';
  if (!orderOk) {
    const center = r2(pbTarget);
    extremeHigh = r2(center * upMult);
    extremeLow = r2(center * downMult);
    boundaryFixed = true;
    boundaryNote = '历史分位已失真，已按动态锚强制外扩边界';
  }
  const extremeLowFormula = (boundaryFixed ? pbTarget * downMult : extremeLowPct);  // 补丁J·规则②：极端悲观「公式值」（补丁I历史铁底锁死前）
  // ===== 补丁I·规则②/③：历史分位铁底 + 边界常识校验 =====
  const floorPriceStatic = bvps * pbP50;                  // 近5年真实50%分位铁底价
  const curPb = P != null ? P / bvps : null;
  const floorBreached = curPb != null && curPb < pbP50 - 1e-9;  // 现价PB已跌破50%分位
  let boundaryFloorLock = false;
  // 规则③：现价低于极端悲观价 → 锁定极端悲观价为历史铁底，禁止报正数下行空间
  if (P != null && extremeLow > P) { extremeLow = floorPriceStatic; boundaryFloorLock = true; }
  const spaceDownPct = (P != null) ? r2((extremeLow - P) / P * 100) : null;
  const spaceUpPct = (P != null) ? r2((extremeHigh - P) / P * 100) : null;
  // 下行空间常识校验：已击穿铁底（P<floor）时下行空间无意义（严禁做空），不报正数
  let maxDownsidePct = null, floorBreachWarn = '';
  if (floorBreached) {
    floorBreachWarn = `现价已击穿历史铁底（现价 ¥${r2(P)} / 当前PB ${r2(curPb)} 倍 < 近5年50%分位 ${pbP50.toFixed(3)} 倍 → 铁底价 ¥${r2(floorPriceStatic)}），极度低估，严禁做空`;
    maxDownsidePct = null;
  } else if (boundaryFloorLock) {
    maxDownsidePct = (floorPriceStatic - P) / P * 100;     // 例：(6.14-6.62)/6.62 = -7.2%（即下行有限）
  }
  const fuseDownLine = nz(pE.fuseDownsidePct, 40), fuseUpLine = nz(pE.fuseUpsidePct, 60);
  // 补丁I 配置默认值（nz 不支持默认值，统一用显式缺省）
  const ratingDowngradeEnabled = pI.enableRatingDowngrade !== false;       // 默认启用
  const ratingDowngradeTo = pI.ratingDowngradeTo || '绝对低估';
  const buyRangeMultHigh = (pI.buyRangeMultHigh != null && isFinite(Number(pI.buyRangeMultHigh))) ? Number(pI.buyRangeMultHigh) : 0.85;
  const davisRoeMidLo = (pI.davisRoeMidLo != null && isFinite(Number(pI.davisRoeMidLo))) ? Number(pI.davisRoeMidLo) : 6;
  const davisRoeMidHi = (pI.davisRoeMidHi != null && isFinite(Number(pI.davisRoeMidHi))) ? Number(pI.davisRoeMidHi) : 8;
  const q3TurnoverYi = (LAW.q3TurnoverAvgYi != null && isFinite(Number(LAW.q3TurnoverAvgYi))) ? Number(LAW.q3TurnoverAvgYi) : 23163;
  const fuseF = spaceDownPct != null && Math.abs(spaceDownPct) > fuseDownLine;
  let fused = false, fuseE = false, fuseReason = '', rating = '合理', premiumNote = '';
  let ratingDowngraded = false, buyRange = null, davisNote = '';
  if (P != null) {
    const upE = (pbTarget - P) / P * 100;     // 现价低于中枢的幅度（越大 = 越低估）
    const dnE = (P - pbTarget) / P * 100;      // 现价高于中枢的幅度（越大 = 越泡沫）
    if (upE > fuseUpLine) {
      // 补丁I·规则④：周期股价格大幅低于中枢 = 绝对低估/重大机会（非数据错误）→ 降级绿色提示，不触发红灯
      if (ratingDowngradeEnabled) {
        ratingDowngraded = true; fused = false; fuseE = false;
        rating = ratingDowngradeTo;
        premiumNote = '现价大幅低于中枢（周期股深度低估）';
        const buyLow = floorPriceStatic;
        const buyHigh = (extremeLow != null && extremeLow > floorPriceStatic) ? extremeLow : (pbTarget * buyRangeMultHigh);
        buyRange = [r2(buyLow), r2(buyHigh)];
        davisNote = buildDavisNote({ q3Turnover: q3TurnoverYi, predRoe, roeMidLo: davisRoeMidLo, roeMidHi: davisRoeMidHi, pbTarget, centerLabel: '主模型' });
      } else {
        fuseE = true; fused = true; fuseReason = `潜在上行空间 ${r2(upE)}% > ${fuseUpLine}% → ⛔禁止自动评级（红色警报，大概率基本面质变或数据出错）`;
      }
    } else if (dnE > fuseDownLine) {
      // 价格远高于中枢（泡沫/数据错误）→ 保留红灯
      fuseE = true; fused = true; fuseReason = `潜在下行空间 ${r2(dnE)}% > ${fuseDownLine}% → ⛔禁止自动评级（红色警报，大概率数据出错或估值泡沫）`;
    }
    if (!fused && !ratingDowngraded && fuseF) { fused = true; fuseReason = `第五法则·空间校验：极端悲观价 ${r2(extremeLow)} 元 vs 现价 ${r2(P)} 元 → 下行空间 ${spaceDownPct}%（绝对值 > ${fuseDownLine}% 熔断线）→ ⛔禁止自动评级`; }
    if (!fused && !ratingDowngraded) {
      const disc = (pbTarget - P) / pbTarget * 100;
      if (disc > 10) rating = '低估';
      else if (disc >= -10) rating = '合理';
      else rating = '高估';
      premiumNote = disc >= 0 ? `折价 ${r2(Math.abs(disc))}%` : `溢价 ${r2(Math.abs(disc))}%`;
    }
  }
  if (fused) rating = '无法评级';

  // ===== ⑪ 输出模板①：数据新鲜度仪表盘 =====
  const dashboardRows = [
    ...rigid.map((x) => ({ label: `刚性实时层 ${x.label} ${x.tag}`, value: `${x.value} ${x.unit}`, period: x.period, source: x.source })),
    ...soft.map((x) => ({ label: `柔性平滑层 ${x.label} ${x.tag}`, value: `${x.value} 亿元`, period: x.period, source: x.method })),
    { label: '柔性平滑层 市场景气度基准', value: `H1日均成交 ${h1Turnover} 亿 / Q3日均 ${q3Turnover} 亿（因子 ${r2(turnoverFactor)}）/ IPO家数同比 +${nz(LAW.ipoCount3qYoyPct, 67.11)}% / 科创50 H1 +${sciH1}%·前三季 +${sci9m}%`, period: 'Wind（2026-10-01 全景扫描）', source: (LAW.source || 'Wind 2026年前三季度A股大数据全景扫描') },
  ];
  // freshnessRows 兼容格式（仪表盘 = 刚性层 + 守门员 + 快照）
  for (const x of rigid) freshnessRows.push({ label: `刚性 ${x.label}`, asOf: x.period, ageDays: daysBetween(x.period, today0), maxAge, stale: false });
  for (const x of soft) freshnessRows.push({ label: `柔性 ${x.label}${x.tag}`, asOf: x.period, ageDays: x.period.indexOf('2026-09-08') === 0 ? null : null, maxAge: snapMax, stale: false });

  // ===== ⑫ 核心估值结论矩阵（输出模板②）=====
  const signedPct = (v) => (v == null ? 'N/A' : (v > 0 ? '+' + r2(v) : String(r2(v))));
  const downSpaceText = spaceDownPct == null ? '下行空间 N/A' : (floorBreached
    ? `下行空间 N/A（现价已击穿历史铁底 ¥${r2(floorPriceStatic)}，模型无更低估值锚，严禁做空）`
    : `下行空间 ${signedPct(spaceDownPct)}%（负值原样输出，不截断为0）${ratingDowngraded ? '；补丁I·熔断降级：现价大幅低于中枢 → 不触发红灯' : `，${fuseF ? '⛔已触及' : '未触及'}${fuseDownLine}%熔断线`}`);
  const upSpaceText = spaceUpPct == null ? '上行空间 N/A' : `上行空间 ${signedPct(spaceUpPct)}%`;
  const matrixRows = [
    ...(anchorBreached ? [{ method: '🔴 估值体系重构警告', low: null, mid: null, high: null, emph: true, note: reframeNote }] : []),
    { method: boundaryFixed ? `极端悲观（动态锚 × ${downMult.toFixed(2)}）` : '极端悲观（PB 10%分位）', low: r2(extremeLow), mid: null, high: null, note: boundaryFixed
      ? `第五法则·排序强校验：历史分位边界 [${r2(extremeLowPct)}, ${r2(extremeHighPct)}] 元与基准中枢 ${r2(pbTarget)} 元不自洽 → ${boundaryNote}：极端悲观公式值 = 基准 ${r2(pbTarget)} × ${downMult.toFixed(2)} = ${r2(extremeLowFormula)} 元。${boundaryFloorLock ? `但受补丁I「历史铁底」约束（现价 ¥${r2(P)} < 公式悲观价 ¥${r2(extremeLowFormula)}），最终锁定为铁底价 ¥${r2(floorPriceStatic)}。` : ''}${downSpaceText}`
      : `BVPS ${r2(bvps)}［最新报告期］× PB ${pbP10.toFixed(3)} 倍（近5年日K序列10%分位）= ${r2(extremeLowPct)} 元${boundaryFloorLock ? `；但受补丁I「历史铁底」约束，最终锁定为铁底价 ¥${r2(floorPriceStatic)}` : ''}。${downSpaceText}` },
    { method: '基准（动态PB中枢·PB-ROE主模型）', low: null, mid: r2(pbTarget), high: null, note: `第二法则：P = 最新 BVPS ${r2(bvps)} × 动态PB锚 ${pbAnchorEff.toFixed(4)} 倍${anchorCapped ? `（封顶：原动态锚 ${pbAnchorRaw.toFixed(4)} > 理论PB锚 ${theoPB.toFixed(4)} → 封顶）` : ''}。TTM ROE = ${coreNpLabel} ${r2(coreNpTtm)} 亿 ÷ 平均普通股净资产 ${r2(equityAvg)} 亿（期初 ${r2(equityFY - perpFY)} + 期末 ${r2(equityQ3 - perpQ3)} ÷2）= ${r2(roeTtm)}%；PB中枢 = ${r2(indPB)}×40% + ${r2(roeRatio)}×${r2(indPB)}×60% = ${pbBase.toFixed(4)} 倍；${roeAdjNote} → 锚 ${pbAnchorEff.toFixed(4)} 倍${anchorFloorActive ? `；🛡️下轨铁底保护：原始锚价 ¥${r2(pbTargetRaw)} 已低于50%分位价 ¥${r2(floorRes.floorPrice)} → 中枢抬升至铁底 ¥${r2(pbTarget)}` : ''}${anchorBreached ? '；⚠️该锚已突破历史90%分位 → 见顶部重构警告' : ''}（本档不计空间）` },
    { method: boundaryFixed ? `极端乐观（动态锚 × ${upMult.toFixed(2)}）` : '极端乐观（PB 90%分位）', low: null, mid: null, high: r2(extremeHigh), note: boundaryFixed
      ? `第五法则·排序强校验：历史分位 90% 边界 ${r2(extremeHighPct)} 元低于基准中枢 ${r2(pbTarget)} 元 → ${boundaryNote}：极端乐观 = 基准 ${r2(pbTarget)} × ${upMult.toFixed(2)} = ${r2(extremeHigh)} 元。${upSpaceText}`
      : `BVPS ${r2(bvps)} × PB ${pbP90.toFixed(3)} 倍（近5年序列90%分位）${anchorBreached ? '（已突破，仅背景参照）' : ''}。${upSpaceText}` },
    { method: `SOTP 分部加总（${sotpDormant ? '休眠降级·仅参考上限' : '交叉验证'}）`, low: r2(sotpLow.perShare), mid: r2(sotpMidPs), high: r2(sotpHigh.perShare), note: sotpDormant ? sotpDormantNote : `与PB-ROE偏离 ${signedPct(sotpDev)}%${Math.abs(sotpDev) > (nz(pFP.sotpDeviationDeepLimitPct) || 30) ? ' → 强制穿透归因（详见 SOTP 行）' : ''}` },
    { method: '综合结论（以PB-ROE主模型为准）', low: r2(extremeLow), mid: r2(pbTarget), high: r2(extremeHigh), note: `排序强校验：${r2(extremeLow)} < ${r2(pbTarget)} < ${r2(extremeHigh)} ✅（${orderOk ? '原边界自洽' : '已强制外扩'}）；第四法则双轨：${anchorBreached ? `上轨已突破（ROE质变 → 估值体系重构警告：原始动态锚 ${pbAnchorRaw.toFixed(2)} 倍，已封顶至理论PB锚 ${theoPB.toFixed(2)} 倍，当前模型有效锚 = ${pbAnchorEff.toFixed(2)} 倍）` : (anchorFloorActive ? '下轨已触发（周期底部铁底，50%分位为底线，禁止无限看空）' : `锚 ${pbAnchorEff.toFixed(2)} 位于 [50%分位 ${pbP50.toFixed(3)}, 90%分位 ${pbP90.toFixed(3)}] 带内`)}；熔断：${fused ? '⛔已触发（红色警报，禁止自动评级）' : (ratingDowngraded ? '🟢补丁I降级：现价大幅低于中枢 → 绝对低估/重大机会（绿色提示，非数据错误）' : '✅未触发')}${floorBreached ? `；⚠️现价已击穿历史铁底 ¥${r2(floorPriceStatic)}，极度低估，严禁做空` : ''}${maxDownsidePct != null ? `；极端悲观锁铁底 ¥${r2(floorPriceStatic)} → 潜在最大下行风险仅 ${r2(maxDownsidePct)}%` : ''}${useDeducted ? `；⚠️扣非切换已触发（归母/扣非同比偏离 ${r2(growthDev)}pp > ${devLimitPp}pp → 全部改用扣非）` : `；扣非切换未触发（偏离 ${r2(growthDev)}pp ≤ ${devLimitPp}pp）`}${recoveryActive ? `；🌟${recoveryLabel}（仅备注）：长周期均值锚 1.33×BVPS → ¥${recoveryRes.price}${recoveryInverted ? `（低于主模型中枢 ¥${r2(pbTarget)}，不作乐观目标，转为下行保护参考）` : ''}` : ''}` },
  ];

  // SOTP 明细行（休眠标注）
  const sotpRows = [
    { label: `经纪+信用（轻资产）${sotpDormant ? '［推算估算值］' : ''}`, value: `前三季经纪 ${r2(broker3q)}（推演）+ 利息净收入 ${r2(intNI)}［最新报告期］年化 ×4/3 × 净利率 ${r2(nm * 100)}%［假设］= 净利 ${r2(npLight)} 亿 × PE ${r2(peLightLo)}~${r2(peLightHi)} 倍 = ${r2(sotpLow.parts.light)}~${r2(sotpHigh.parts.light)} 亿`, source: '第一法则柔性推演 + 三表直接科目' },
    { label: `自营投资（重资产）`, value: `净资本 ${netCapital} 亿［推算估算值·上次已知］× PB ${propPb}（年化投资收益率 ${r2(annInvYield)}% = Q3累计投资净收益 ${r2(invIncCum)}×4/3 ÷ 投资资产 ${r2(invAssets)}［最新报告期］，${annInvYield > nz(pD.yieldThreshold, 6) ? '>6% 上调1.1' : '≤6% 维持1.0'}）= ${r2(sotpLow.parts.prop)} 亿`, source: '2025年度风控指标报告 + 资产负债表' },
    { label: `资管（含长信基金）${sotpDormant ? '［推算估算值］' : ''}`, value: `前三季收入 ${r2(am3q)}（推演）× 净利率 ${r2(nm * 100)}% = ${r2(npAM)} 亿 × PE ${r2(peLightLo)}~${r2(peLightHi)} 倍 = ${r2(sotpLow.parts.am)}~${r2(sotpHigh.parts.am)} 亿`, source: '第一法则柔性推演' },
    { label: `投行${sotpDormant ? '［推算估算值］' : ''}`, value: `前三季收入 ${r2(ib3q)}（推演）× 净利率 ${r2(nm * 100)}% = ${r2(npIB)} 亿 × ${peIB[0]}~${peIB[1]}x = ${r2(sotpLow.parts.ib)}~${r2(sotpHigh.parts.ib)} 亿`, source: '第一法则柔性推演（IPO家数同比景气因子）' },
    { label: `科创投资${sotpDormant ? '［推算估算值］' : ''}`, value: `前三季利润 ${r2(npVC)}（推演）× ${vcPe[0]}~${vcPe[1]}x（科创50前三季 +${sci50}% → ${sci50 <= nz(pD.tightenThreshold || -10) ? '收紧期' : '宽松期'}；Q3单季 ${r2(sciQ3Single * 100)}% 回撤已计入）= ${r2(sotpLow.parts.vc)}~${r2(sotpHigh.parts.vc)} 亿`, source: '第一法则柔性推演（科创50动量因子）' },
    { label: 'SOTP 合计', value: `${r2(sotpLow.total)}~${r2(sotpHigh.total)} 亿元 ÷ 总股本 ${N} 亿股 = ${r2(sotpLow.perShare)}~${r2(sotpHigh.perShare)} 元/股${sotpDormant ? `；${sotpDormantNote}` : `；与主模型偏离 ${signedPct(sotpDev)}%`}`, source: `第三法则：${sotpStageLabel} → ${sotpDormant ? '强制休眠降级' : '正常运作'}` },
  ];

  const sensRows = [
    { label: `PB 10%分位 ${pbP10.toFixed(2)} 倍`, value: r2(extremeLowPct) },
    { label: `PB 50%分位 ${pbP50.toFixed(2)} 倍（下轨铁底）`, value: r2(bvps * pbP50) },
    { label: `PB 90%分位 ${pbP90.toFixed(2)} 倍${anchorBreached ? '（已突破·背景参照）' : ''}`, value: r2(extremeHighPct) },
    { label: `PB 无ROE修正锚 ${pbBase.toFixed(2)} 倍`, value: r2(bvps * pbBase) },
    { label: `PB 动态锚（封顶后） ${pbAnchorEff.toFixed(2)} 倍${anchorCapped ? `（原 ${pbAnchorRaw.toFixed(2)} 倍封顶至理论 ${theoPB.toFixed(2)} 倍）` : ''}`, value: r2(pbTarget) },
  ];
  if (boundaryFixed) {
    sensRows.push({ label: `第五法则·极端悲观（动态锚 × ${downMult.toFixed(2)}）`, value: r2(extremeLow) });
    sensRows.push({ label: `第五法则·极端乐观（动态锚 × ${upMult.toFixed(2)}）`, value: r2(extremeHigh) });
  }

  // ===== ⑬ 输出模板③：核心逻辑摘要（≤200字）=====
  const q3TurnoverYoy = nz(LAW.q3TurnoverYoyPct, 10.22);
  const summaryParts = [
    `市场成交活跃度：Q3日均成交 ${r2(q3Turnover / 10000)} 万亿（同比+${q3TurnoverYoy}%、环比−20.5%），近期20日日均 ${(mktTurnoverYi / 10000).toFixed(2)} 万亿，交投仍处高位但边际降温；`,
    `自营投资：前三季投资净收益 ${r2(invIncCum)} 亿，其中Q3单季 ${invIncQ3Single != null ? r2(invIncQ3Single) + ' 亿（市场回调拖累，系Q3单季利润下滑主因）' : 'N/A'}；`,
    `ROE质变：TTM ROE ${r2(roeTtm)}%（${coreNpLabel} ${r2(coreNpTtm)} 亿÷平均净资产 ${r2(equityAvg)} 亿）${anchorBreached ? `原始动态锚 ${pbAnchorRaw.toFixed(2)} 倍突破近5年90%分位 ${pbP90} → 触发估值体系重构警告；但理论PB封顶已生效，当前模型有效锚 = ${pbAnchorEff.toFixed(2)} 倍（封顶至理论PB锚 ${theoPB.toFixed(2)} 倍）` : `仍处历史分位带内`}`,
  ];
  let summaryNote = summaryParts.join('');
  if (summaryNote.length > 200) summaryNote = summaryNote.slice(0, 197) + '...';

  // ===== ⑭ 卡片行（继承 V2 契约）=====
  const coreRows = [
    { label: `第一法则·刚性实时层（${sotpStageLabel}，全量重算）`, value: `归母TTM ${r2(npTtm)} 亿 / 扣非TTM ${r2(npDedTtm)} 亿 / BVPS ${r2(bvps)} 元 / 归母净资产 ${r2(equityQ3)} 亿（永续债 ${r2(perpQ3)} 亿剔除）/ 总资产 ${r2(yi(balQ3.TOTAL_ASSETS))} 亿 / 投资资产 ${r2(invAssets)} 亿 / 手续费收入 ${r2(feeInc)} 亿（收入侧）/ 利息净收入 ${r2(intNI)} 亿 / 投资净收益 ${r2(invIncCum)} 亿 —— 全部标［最新报告期］`, source: '东财F10三表（lrb/zcfzb/xjllbAjaxNew，SZ000783）' },
    { label: '第二法则·TTM重构', value: `TTM ${coreNpLabel} = ${r2(coreNpTtm)} 亿（归母/扣非同比 ${r2(npYoy)}% vs ${r2(npDedYoy)}%，偏离 ${r2(growthDev)}pp ${useDeducted ? `> ${devLimitPp}pp → ⚠️弃用归母` : `≤ ${devLimitPp}pp → 归母口径可用`}）；ROE = ÷ 平均普通股净资产 ${r2(equityAvg)} 亿 = ${r2(roeTtm)}%（严禁单季×4，已按 TTM÷平均净资产 口径）；2026E 预测ROE ${r2(predRoe)}%［预测口径：机构一致预期 ${r2(consensusNp)} 亿 ÷ 平均净资产］`, source: '第二法则 + 机构一致预期（4家）' },
    { label: '第四法则·动态PB锚', value: `公司 TTM ROE ${r2(roeTtm)}% ÷ 行业均值 ${r2(indRoe * 100)}%［假设］=${r2(roeRatio)}；PB中枢 = ${r2(indPB)}×40% + ${r2(roeRatio)}×${r2(indPB)}×60% = ${pbBase.toFixed(4)} 倍；${roeAdjNote} → 动态锚 ${pbAnchorEff.toFixed(4)} 倍${anchorCapped ? `（封顶：原 ${pbAnchorRaw.toFixed(4)} > 理论PB锚 ${theoPB.toFixed(4)}，中枢 ≤ ¥${r2(pbTarget)}）` : ''} × BVPS ${r2(bvps)} 元 = ${r2(pbTarget)} 元${anchorFloorActive ? `（下轨铁底保护生效）` : ''}`, source: (pC.industryPB || {}).source },
    { label: '理论PB（ROE-PB框架，印证）', value: `(ROE−g)/(r−g)=(${r2(predRoe)}%−${r2(gPerp * 100)}%)/(${r2(rEq * 100)}%−${r2(gPerp * 100)}%)=${r2(theoPB)} 倍${anchorCapped ? `，即为主模型封顶后动态锚（原动态锚 ${pbAnchorRaw.toFixed(2)} 倍 → 封顶至理论PB锚 ${theoPB.toFixed(2)} 倍）` : `，与动态锚 ${pbAnchorEff.toFixed(2)} 倍互相印证`}`, source: (I.roeLayer.costOfEquity || {}).source },
    { label: '市场快照', value: `现价 ${P ? r2(P) : 'N/A'} 元 / 普通股PB ≈ ${(P != null ? P / bvps : 0).toFixed(2)} 倍 vs 主模型动态锚 ${pbAnchorEff.toFixed(2)} 倍${anchorCapped ? `（原始动态锚 ${pbAnchorRaw.toFixed(2)} 倍已封顶至理论 ${theoPB.toFixed(2)} 倍）` : ''}；板块PB ${r2(indPB)}（近10年约7%分位）`, source: (I.market.pbLF || {}).source + '；' + (pC.industryPB || {}).source },
  ];

  const mappingRows = [
    { label: '数据分层（第一法则）', value: `刚性实时层 ${rigid.length} 项全部取自三表最新报告期（${asOf}）标［最新报告期］；柔性平滑层 ${soft.length} 项全部按「上次已知 × 全市场指标增幅」推演标［推算估算值］——本次${sotpStageLabel}严禁「总营收×上次占比」估算，已按经纪=成交额因子、投行=IPO家数因子、科创=科创50动量因子分别推演`, source: LAW.source || 'Wind 2026年前三季度A股大数据全景扫描' },
    ...soft.map((x) => ({ label: `柔性·${x.label}`, value: `${x.value} 亿｜${x.method}`, source: x.period })),
  ];

  const seasonRows = [
    { label: 'TTM 归母净利（第二法则口径）', value: `${Number(asOf.slice(0, 4)) - 1}年报 ${r2(yi(incFY.PARENT_NETPROFIT))} − ${prevYearSame}累计 ${r2(yi(incPrev.PARENT_NETPROFIT))} + ${asOf}累计 ${r2(yi(incCur.PARENT_NETPROFIT))} = ${r2(npTtm)} 亿［最新报告期］`, source: '三表勾稽，禁止简单×4' },
    { label: 'TTM 扣非净利（熔断备用口径）', value: `${r2(npDedTtm)} 亿（同口径勾稽）；归母/扣非同比 ${r2(npYoy)}% vs ${r2(npDedYoy)}%，偏离 ${r2(growthDev)}pp（阈值 ${devLimitPp}pp）`, source: '第五法则熔断1' },
    { label: '2026E 预测口径', value: `机构一致预期归母 ${r2(consensusNp)} 亿 → 预测ROE ${r2(predRoe)}%［预测口径，仅用于PB锚越界修正，不替代TTM］`, source: (I.patchB.consensusNp || {}).source },
  ];

  const riskLights = [
    { label: `第一法则·数据分层（刚性 ${rigid.length} 项最新报告期 / 柔性 ${soft.length} 项推演）`, light: '绿灯：全部带时间戳标签，无跨层混用' },
    { label: `第三法则·SOTP 状态（${sotpStageLabel}）`, light: sotpDormant ? `黄灯：休眠降级 → 因财报披露颗粒度不足，SOTP暂不作为决策依据（仅参考上限 ${r2(sotpMidPs)} 元）` : '绿灯：分部数据齐全，正常运作' },
    { label: '第五法则·扣非切换', light: useDeducted ? `红灯：归母/扣非同比偏离 ${r2(growthDev)}pp > ${devLimitPp}pp → 已切换扣非` : `绿灯：偏离 ${r2(growthDev)}pp ≤ ${devLimitPp}pp` },
    { label: '第五法则·熔断2（上行/下行空间）', light: fused ? `红灯：${fuseReason}` : (ratingDowngraded ? `🟢 绿色提示：现价大幅低于中枢 → 绝对低估/重大机会（补丁I·熔断降级，非数据错误）；买入区间 ¥${buyRange ? buyRange[0] + '~' + buyRange[1] : 'N/A'}` : `绿灯：未触及 ${fuseUpLine}%/${fuseDownLine}% 熔断线`) },
    { label: `第四法则·双轨防御（上轨 ${pbP90.toFixed(3)} / 下轨 ${pbP50.toFixed(3)}）`, light: anchorBreached ? `红灯：原始动态锚 ${pbAnchorRaw.toFixed(2)} 突破上轨（估值体系重构警告，ROE质变）→ 已封顶至理论PB锚 ${theoPB.toFixed(2)} 倍，当前模型有效锚 = ${pbAnchorEff.toFixed(2)} 倍` : (anchorFloorActive ? `黄灯：动态锚跌破下轨 → 周期底部铁底 ¥${r2(floorRes.floorPrice)}，禁止无限看空` : `绿灯：锚 ${pbAnchorEff.toFixed(2)} 位于双轨带内`) },
    { label: '第五法则·排序强校验', light: orderOk ? `绿灯：${r2(extremeLow)} < ${r2(pbTarget)} < ${r2(extremeHigh)} 原边界自洽` : `黄灯：历史分位失真 → 已按动态锚强制外扩（${boundaryNote}）` },
    { label: '市场快照超龄提示', light: staleSnapshots ? `⚠️ ${staleSnapshots} 项快照超龄（>${snapMax}天）` : '🟢 全部在有效期内' },
  ];

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
    if (fused) return `⛔ 熔断触发（红色警报）：${fuseReason} 三档区间仅供人工复核参考，不输出自动评级。`;
    const disc = (pbTarget - P) / pbTarget * 100;
    let note = `当前股价 ${r2(P)} 元 vs 基准（动态PB锚${anchorCapped ? '封顶' : ''}）${r2(pbTarget)} 元 → ${premiumNote} → 评级：「${rating}」。三档区间：极端悲观 ${r2(extremeLow)} 元（${lowTag}）/ 基准 ${r2(pbTarget)} 元（动态锚）/ 极端乐观 ${r2(extremeHigh)} 元（${highTag}）；单边空间见②矩阵分档行。普通股PB ${(P / bvps).toFixed(2)} 倍 vs 动态锚 ${pbAnchorEff.toFixed(2)} 倍。买卖信号：${signal}。`;
    if (ratingDowngraded) {
      note += ` ${davisNote}`;
      if (buyRange) note += ` 💡 买入区间建议：¥${buyRange[0]} ~ ¥${buyRange[1]}（历史铁底至悲观情景上沿）。`;
    }
    if (floorBreached) note += ` ⚠️ ${floorBreachWarn}`;
    else if (maxDownsidePct != null) note += ` 极端悲观已锁铁底 ¥${r2(floorPriceStatic)} → 潜在最大下行风险仅 ${r2(maxDownsidePct)}%。`;
    return note;
  })();

  const riskNote = '上行：ROE 持续高于 12% → 动态锚继续上修、科创项目大额退出、板块估值修复；下行：日均成交额跌破 1.5 万亿 → 经纪承压、年化投资收益率跌破 6% → 自营 PB 回落、科创50 半年跌幅超 10% → 科创 PE 压缩、归母/扣非增速偏离超 20pp → 自动切换扣非。第四法则铁底：近5年真实50%分位为周期底部估值底线，禁止无限看空。模型所有结果基于公开信息与确定性代码，不构成投资建议。';

  const result = {
    ok: true, dedicated: true, changjiang: true,
    version: 'V3-五法则',
    symbol: SYM, stockName: cfg.name,
    rating, fused, fuseReason,
    fairValueRange: [r2(extremeLow), r2(extremeHigh)],
    fairValueCenter: r2(pbTarget),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'changjiang000783 V3-五法则（数据分层对齐+TTM重构+主辅模型休眠机制+历史分位双轨防御+逻辑自洽与极值熔断；全量重算接入最新报告期三表，确定性计算无AI参与）',
    dataAsOf: asOf,
    asOfDate: asOf, asOfStage: sotpStageLabel,
    // 输出模板三件套
    dashboardRows, summaryNote, matrixRows,
    // 新增结构化字段
    layers: { rigid, soft, sotpDormant, sotpStageLabel, sotpDormantNote },
    fairPB: { anchor: r2(pbAnchorEff), anchorRaw: r2(pbAnchorRaw), anchorCapped, theoPB: r2(theoPB), base: r2(pbBase), roeAdjPct: r2(roeAdj * 100), p10: pbP10, p50: pbP50, p90: pbP90, roeTtm: r2(roeTtm), roeTtmBasis: `${coreNpLabel} ÷ 平均普通股净资产` },
    patchF: { orderOk, boundaryFixed, boundaryNote, anchorBreached, reframeNote, spaceDownPct, spaceUpPct, fuseF, fuseDownLine, upMult, downMult, extremeLowPct: r2(extremeLowPct), extremeHighPct: r2(extremeHighPct) },
    patchFPlus: { singleSideSpace: true, downSpaceText, upSpaceText, sotpDeep: false, sotpNote: sotpDormantNote, dormancy: true },
    patchG: {
      upRailPb: pbP90, floorPb: floorRes.floorPb, floorPrice: r2(floorRes.floorPrice),
      floorRailBasis: `近5年日K真实50%分位（${pbP50.toFixed(3)} 倍），非长周期均值`,
      anchorFloorActive, anchorFloorNote, pbTargetRaw: r2(pbTargetRaw), pbTarget: r2(pbTarget),
      rail: anchorBreached ? 'upper-breach' : (anchorFloorActive ? 'floor-active' : 'in-band'),
      recovery: { active: recoveryActive, inverted: recoveryInverted, label: recoveryLabel, gateTurnover: recoveryRes.gateTurnover, gateRoe: recoveryRes.gateRoe, pbLtMean: recoveryRes.pbLtMean, price: recoveryRes.price, note: recoveryNote, turnoverYi: recoveryRes.turnoverYi, turnoverDate: mktTurnoverDate, turnoverSource: mktTurnoverSrc, turnoverFloorYi: recoveryRes.turnoverFloorYi, roeValues: recoveryRes.roeValues, reason: recoveryRes.reason },
    },
    patchI: {
      rule1: { priceSource, enforced: true, note: '运行时态现价强同步：强制使用当日行情快照现价，严禁历史残留现价（如 8.51）' },
      rule2: { pbAnchorRaw: r2(pbAnchorRaw), theoPB: r2(theoPB), pbAnchorEff: r2(pbAnchorEff), anchorCapped, centerCapped: r2(pbTarget), cappedNote: anchorCapped ? `主模型PB锚由 ${pbAnchorRaw.toFixed(4)} 倍封顶至理论PB锚 ${theoPB.toFixed(4)} 倍，中枢 ≤ ¥${r2(pbTarget)}` : '未触发：动态PB锚 ≤ 理论PB锚' },
      rule2b: { floorBreached, floorPrice: r2(floorPriceStatic), floorBreachWarn },
      rule3: { extremeLowLocked: r2(extremeLow), maxDownsidePct: maxDownsidePct != null ? r2(maxDownsidePct) : null, boundaryFloorLock, recoveryPrice: r2(recoveryRes.price), recoveryGtExtremeLow: recoveryRes.price != null && recoveryRes.price > floorPriceStatic },
      rule4: { ratingDowngraded, from: '无法评级', to: rating, davisNote, buyRange, fuseSuppressed: ratingDowngraded },
    },
    priceSource,
    coreRows, mappingRows, seasonRows, sotpRows, sensRows, yieldNote: `自营倍数：年化投资收益率 ${r2(annInvYield)}%（Q3累计 ${r2(invIncCum)}×4/3 ÷ 投资资产 ${r2(invAssets)}［最新报告期］）${annInvYield > nz(pD.yieldThreshold, 6) ? '> 6% → PB 1.1' : '≤ 6% → PB 1.0'}；科创倍数：科创50前三季 +${sci50}%（Q3单季 ${r2(sciQ3Single * 100)}%）→ ${vcPe[0]}~${vcPe[1]}x。`, sensOut: sensRows.map(s => `${s.label}：${s.value} 元`).join(' ｜ '),
    riskLights, positionNote, riskNote, signal,
    guardRows, alerts, freshnessRows,
    decisionNote: `V3-五法则全接入：①数据分层（刚性 ${rigid.length} 项［最新报告期 ${asOf}］+ 柔性 ${soft.length} 项［推算估算值］，严禁「总营收×上次占比」）；②TTM重构（${coreNpLabel} ${r2(coreNpTtm)} 亿 ÷ 平均普通股净资产 ${r2(equityAvg)} 亿 = TTM ROE ${r2(roeTtm)}%，目标价 = BVPS ${r2(bvps)} × 动态锚 ${pbAnchorEff.toFixed(4)}${anchorCapped ? `(封顶：≤理论PB锚 ${theoPB.toFixed(4)})` : ''}；预测ROE ${r2(predRoe)}%［预测口径］）；③主辅模型（PB-ROE 永远在线为唯一基准；SOTP ${sotpStageLabel}${sotpDormant ? '强制休眠降级 → 因财报披露颗粒度不足，SOTP暂不作为决策依据，仅作参考上限' : '正常运作'}）；④双轨防御（${anchorBreached ? `上轨突破 → 🔴估值体系重构警告（ROE质变）${anchorCapped ? '；补丁I·三位一体向下约束已封顶至理论PB锚' : ''}` : (anchorFloorActive ? '下轨触发 → 周期底部铁底' : `锚 ${pbAnchorEff.toFixed(2)} 位于 [${pbP50}, ${pbP90}] 带内`)}）；⑤逻辑自洽与熔断（排序 ${r2(extremeLow)} < ${r2(pbTarget)} < ${r2(extremeHigh)} ${orderOk ? '✅' : '→已强制外扩'}；单边空间：下行 ${signedPct(spaceDownPct)}% / 上行 ${signedPct(spaceUpPct)}%；扣非切换${useDeducted ? '已触发' : '未触发'}（偏离 ${r2(growthDev)}pp）；空间熔断${fused ? '⛔已触发' : (ratingDowngraded ? '🟢补丁I降级：现价大幅低于中枢 → 绝对低估/重大机会（非数据错误）' : '未触发')}）。补丁I：①实时价强同步（${priceSource}）②三位一体向下约束${anchorCapped ? `已封顶（中枢≤¥${r2(pbTarget)}）` : '未触发'}③边界常识校验${floorBreached ? '（击穿铁底）' : (maxDownsidePct != null ? `（锁铁底，最大下行${r2(maxDownsidePct)}%）` : '（通过）')}④戴维斯双杀预警${ratingDowngraded ? ' + 熔断降级绿色提示' : ''}。`,
    runId,
  };

  appendRunLog({
    run_id: runId, model_version: 'V3-五法则', run_time: startedAt,
    valuation_base_date: asOf, as_of_date: asOf,
    data_source_status: { rigid: rigid.length, soft: soft.length, sotp_dormant: sotpDormant },
    parameter_values: { pbAnchor: r2(pbAnchor), pbBase: r2(pbBase), roeTtm: r2(roeTtm), predRoe: r2(predRoe), bvps: r2(bvps), coreNpTtm: r2(coreNpTtm), useDeducted, indPB, roeAdj: r2(roeAdj * 100) },
    output_results: { threeTier: [r2(extremeLow), r2(pbTarget), r2(extremeHigh)], rating, sotp_dormant_ps: r2(sotpMidPs), fused, anchorBreached, anchorFloorActive },
  });
  return result;
}

module.exports = { run, isChangjiangModel, loadConfig, pickAnchorFloor, attributeSotpDeviation, evalRecoveryScenario };
