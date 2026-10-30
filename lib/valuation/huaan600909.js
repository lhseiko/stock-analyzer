// ============================================================
// 华安证券（600909）专属动态估值引擎 V3.0 —— 异步数据自适应架构
// 20261029p【用户下发规范全文实施】十四规则 / 七层架构：
//   【总则·第一性原理】模型永不假设所有指标处于同一报告期；任何指标进入估值公式前必须携带
//   「数据契约」（指标名/数值/报告期截止日/披露频率/来源/期差天数/最大容忍期差/成熟度/是否结转/结转来源期）；
//   无契约裸数据一律拒收；禁止硬编码/默认值/上年旧值静默填充；点估值只在全绿时给出，
//   存在黄/红时输出区间+置信度；方法权重由所依赖数据的成熟度动态决定。
//   【第一层·数据分层】A层日频行情（容忍1交易日，滞后沿用+标注）/ B层季频财报（容忍150天）/
//   C层低频非必披露（分业务结构200天、持股比例180天、限售状态365天）。
//   【第二层·报告期对齐引擎】期差自动计算与成熟度分级（绿≤60%容忍/黄60–100%/红>100%或缺失）；
//   流量指标TTM拼接（三季报后=2026前三季累计+2025Q4单季，禁用×4/3粗年化）；
//   存量指标期末值+股本同步检测（股本未同步→BPS区间化）；C层结构结转+±10%~15%敏感性；
//   可比公司「各自最新」原则；事件数据「公告优先」原则（持股比例>180天→红+±5%区间）。
//   【第三层·方法成熟度加权】基准 PB60%/SOTP30%/PE10%；绿×1.0、黄×0.7、红×0.3
//   （红且基准<15%→直接停用）；PB法红→整体待更新态；权重归一化+列示调整原因。
//   【影子股阈值】占比跨越30%时 SOTP 权重按其数据成熟度在40%–50%摆动（绿50/黄45/红40），
//   并同时输出两套权重下的目标价供参考；联动强度仅用A层日频数据。
//   【第四层·四级降级】L0正常→L1结转+标注→L2区间化→L3降权/停用→L4待更新停估；强制留痕。
//   【第五层·三态输出】精确态（全绿单点）/区间态（任一黄/红但PB非红）/待更新态（PB红或L4）。
//   【评级区间判定】现价<下限×0.9→低估（规范「买入」映射项目三档铁律）；下限×0.9≤现价≤上限×1.05→合理
//   （「持有/中性」映射）；>上限×1.05→高估（「减持/观望」映射）；阈值边界±3%→标注「方向性不明」。
//   【第六层·自检】运行前自检清单（契约完整性/B层应披露/股本同步/持股比例期差/可比报告期/行情时效/权重归一化）。
// 历史沿袭：20260908t V2.0 守门员+口径分离；20260922b 指令9 长鑫联动；20260922d 实时板块成交额接线。
// 计算层=代码，输入=实时三表+配置锁死；长鑫市值/华安市值/三表为实时抓取（带快照回退）。
// ============================================================
const path = require('path');
const fs = require('fs');
const { localDate } = require('../localDate');
const { getTurnoverContext } = require('../brokerSectorTurnover');

const SYM = '600909';
const CXMT = '688825';
const CXMT_STAKE_PCT = 0.4391; // 华安间接持股占长鑫科技比例（%，公告口径：长鑫招股书披露 2.64 亿股）

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/600909.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isHuaanModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (bare !== SYM) return false;
  const cfg = loadConfig();
  return !!cfg && cfg.kind === 'huaan';
}

const r2 = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);
const r4 = (x) => (isFinite(Number(x)) ? Math.round(Number(x) * 10000) / 10000 : null);
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const nzd = (v, d) => (v == null || !isFinite(Number(v))) ? d : Number(v);
const yi = (v) => (v == null || !isFinite(Number(v))) ? null : Number(v) / 1e8;

function daysBetween(d1, d2) {
  const a = new Date(String(d1).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(d2).slice(0, 10) + 'T00:00:00');
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return null;
  return Math.round((b - a) / 86400000);
}

// ============ 第二层·规则1：期差自动计算与成熟度分级（纯函数，供测试） ============
// 绿：期差 ≤ 60%×容忍期差 且为最新应披露期；黄：60%–100%容忍之间；红：>容忍或缺失。
function maturityGrade(ageDays, tolDays) {
  if (ageDays == null || tolDays == null) return '红';
  if (ageDays > tolDays) return '红';
  if (ageDays <= tolDays * 0.6) return '绿';
  return '黄';
}

// ============ 第二层·规则2：流量指标 TTM 拼接（纯函数，供测试） ============
// 禁止「上年同期×4/3」粗年化；按 asOfStage 拼接：
//   三季报后：TTM = 2026前三季累计 + (2025全年 − 2025前三季累计)（=2025Q4单季）
//   年报后：TTM = 2026全年；一季报后：TTM = 2026Q1 + 2025全年 − 2025Q1；
//   中报后：TTM = 2026H1累计 + 2025全年 − 2025H1累计。
function ttmSplice(curCum, prevFY, prevSameCum, stage) {
  const c = (curCum == null || !isFinite(curCum)) ? null : Number(curCum);
  const f = (prevFY == null || !isFinite(prevFY)) ? null : Number(prevFY);
  const s = (prevSameCum == null || !isFinite(prevSameCum)) ? null : Number(prevSameCum);
  if (stage === '12-31') return c; // 年报后 TTM = 全年
  if (c == null || f == null || s == null) return null; // 缺任一项 → NA 降级，禁静默填充
  return c + (f - s);
}

// ============ 第二层·规则3：存量指标 BPS 股本同步检测（纯函数，供测试） ============
// 净资产与股本不同报告期 → BPS 区间化：下限=最新净资产/陈旧股本；上限=最新净资产/调整后股本估计
// （无转增/回购/增发公告 → 上限=下限并标注「股本未同步，区间未展开」）。
function bpsWithSyncCheck(equityNew, sharesNew, sharesOld, adjustNote) {
  const e = (equityNew == null || !isFinite(equityNew) || equityNew <= 0) ? null : Number(equityNew);
  const sN = (sharesNew == null || !isFinite(sharesNew) || sharesNew <= 0) ? null : Number(sharesNew);
  const sO = (sharesOld == null || !isFinite(sharesOld) || sharesOld <= 0) ? null : Number(sharesOld);
  if (e == null) return { synced: false, bps: null, bpsLow: null, bpsHigh: null, note: '净资产缺失【NA】' };
  if (sN != null && (sO == null || Math.abs(sN - sO) / sN < 0.005)) {
    return { synced: true, bps: e / sN, bpsLow: e / sN, bpsHigh: e / sN, note: '股本与净资产同报告期（或偏差<0.5%），BPS 单点值' };
  }
  const low = sO != null ? e / sO : null;
  const hasAdjust = !!adjustNote; // 有转增/回购/增发公告 → 上限=调整后股本测算
  const high = hasAdjust ? (sN != null ? e / sN : low) : low;
  return {
    synced: false, bps: null, bpsLow: low, bpsHigh: high,
    note: hasAdjust
      ? `股本未同步 → BPS 区间化：下限=净资产/陈旧股本，上限=净资产/公告调整股本（${adjustNote}）`
      : '股本未同步，无转增/回购/增发公告 → 区间未展开（上限=下限）并标注',
  };
}

// ============ 第三层·规则7-8：方法成熟度 → 动态权重（纯函数，供测试） ============
// 方法成熟度=所依赖指标成熟度的最低档；绿×1.0/黄×0.7/红×0.3；红且基准<15%→停用（0）；
// PB红→待更新态；权重归一化。shadow 模式下 SOTP 权重按规则9摆动（绿50/黄45/红40）。
function dynWeights({ pb = '绿', sotp = '绿', pe = '绿', shadow = false } = {}) {
  const mult = { '绿': 1.0, '黄': 0.7, '红': 0.3 };
  const base = { pb: 0.6, sotp: 0.3, pe: 0.1 };
  if (pb === '红') return { pending: true, wPB: null, wSOTP: null, wPE: null, reason: 'PB法核心数据（净资产/股本）为红 → 估值整体进入「待更新态」，不输出目标价（规则8/规则10）' };
  let wPB = base.pb * mult[pb];
  let wPE;
  if (pe === '红') wPE = 0; // PE 基准 10% < 15% → 红即停用
  else wPE = base.pe * mult[pe];
  let wSOTP, reason = [];
  if (shadow) {
    // 规则9：影子股模式特例——SOTP 权重按其数据成熟度摆动（绿50/黄45/红40），PB 承接其余（PE 维持基准）
    wSOTP = sotp === '绿' ? 0.5 : (sotp === '黄' ? 0.45 : 0.40);
    wPB = 1 - wSOTP - wPE;
    reason.push(`影子股模式（占比>30%阈值）：SOTP 权重按其数据成熟度【${sotp}】摆动至 ${Math.round(wSOTP * 100)}%，PB 承接其余（规则9）`);
  } else {
    wSOTP = base.sotp * mult[sotp];
    if (sotp === '红') reason.push('SOTP法为红 → 权重×0.3');
    else if (sotp === '黄') reason.push('SOTP法为黄 → 权重×0.7');
  }
  if (pb === '黄') reason.push('PB法为黄 → 权重×0.7');
  if (pe === '红') reason.push('PE法基准 10%<15% 且为红 → 停用（权重归 0，规则8）');
  else if (pe === '黄') reason.push('PE法为黄 → 权重×0.7');
  const sum = wPB + wSOTP + wPE;
  if (sum <= 0) return { pending: true, wPB: null, wSOTP: null, wPE: null, reason: '全部方法停用（异常）→ 待更新态' };
  const adj = sum < 0.999 || sum > 1.001;
  wPB /= sum; wSOTP /= sum; wPE /= sum;
  if (adj) reason.push(`权重已归一化（调整前合计 ${(sum * 100).toFixed(1)}%）`);
  return { pending: false, wPB, wSOTP, wPE, adjusted: adj, reason: reason.join('；') || '全部方法为绿，维持基准权重' };
}

// ---- 指令9沿袭：SOTP 权重自适应（旧三档，兼容保留；新架构主路径为 dynWeights 规则9摆动） ----
function pickSotpWeights(ratio) {
  if (ratio > 0.30) return { wPB: 0.4, wST: 0.5, wPE: 0.1, mode: 'shadow', note: '影子股模式：参股资产占华安总市值 > 30%，SOTP 权重自动上调至 50%，PB 法压缩至 40%、PE 法维持 10%。' };
  if (ratio >= 0.10) return { wPB: 0.5, wST: 0.4, wPE: 0.1, mode: 'elevated', note: '公司价值显著受参股资产影响（占比 10%~30%），SOTP 权重上调至 40%。' };
  return { wPB: 0.6, wST: 0.3, wPE: 0.1, mode: 'normal', note: '' };
}

// ---- 指令9沿袭：流动性折扣 ----
function liquidityDiscount(cfg) {
  const st = (cfg.sotpLayer && cfg.sotpLayer.cxmtLockStatus) || 'unknown';
  if (st === 'free') return { discount: 0, retain: 1, label: '无限售（折扣 0%）' };
  if (st === 'restricted') {
    const d = nz(cfg.sotpLayer.cxmtLiquidityDiscount) || 0.25;
    return { discount: d, retain: 1 - d, label: `限售（折扣 ${Math.round(d * 100)}%）` };
  }
  return { discount: 0.3, retain: 0.7, label: '限售状态未知（保守折扣 30%）' };
}

// ---- 指令9沿袭：Pearson 相关系数（纯函数，供测试） ----
function pearson(a, b) {
  const n = a.length;
  if (n < 5) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return null;
  return num / Math.sqrt(da * db);
}

// ---- 指令9沿袭：长鑫科技总市值抓取（实时，失败回退锁定快照） ----
async function fetchCxmt() {
  try {
    const stockData = require('../stockData');
    const q = await stockData.getQuote(CXMT);
    if (q && q.fundamentals && q.fundamentals.totalValue) {
      return { totalValue: nz(q.fundamentals.totalValue), price: nz(q.price), asOf: q.date || localDate(), source: '腾讯行情（实时）', ok: true };
    }
  } catch (e) { /* ignore */ }
  const cfg = loadConfig();
  const mv = nz(cfg.sotpLayer.cxmtShares) * nz(cfg.sotpLayer.cxmtPrice) / (CXMT_STAKE_PCT / 100);
  return { totalValue: mv, price: nz(cfg.sotpLayer.cxmtPrice), asOf: cfg.dataAsOf, source: '锁定快照（2.64亿股÷0.4391% 推导长鑫总市值，实时不可得）', ok: false };
}

// ---- 指令9沿袭：华安证券总市值抓取（实时，失败回退传入价/快照价×股本） ----
async function fetchHuaanTotal(price) {
  try {
    const stockData = require('../stockData');
    const q = await stockData.getQuote(SYM);
    if (q && q.fundamentals && q.fundamentals.totalValue) {
      return { totalValue: nz(q.fundamentals.totalValue), price: nz(q.price), sharesImplied: nz(q.price) > 0 ? nz(q.fundamentals.totalValue) / nz(q.price) : null, source: '腾讯行情（实时）', ok: true };
    }
  } catch (e) { /* ignore */ }
  const cfg = loadConfig();
  const p = (price != null && price > 0) ? price : nz(cfg.huaanPriceSnapshot);
  return { totalValue: p * nz(cfg.shares), price: p, sharesImplied: nz(cfg.shares), source: (price != null && price > 0) ? '传入价×股本' : '锁定快照价×股本', ok: (price != null && price > 0) };
}

// ---- 指令9沿袭：股价联动强度（近 60 交易日日收益相关系数，仅A层数据） ----
async function computeLinkCorr() {
  try {
    const stockData = require('../stockData');
    const [h1, h2] = await Promise.all([stockData.getHistory(SYM, '1y'), stockData.getHistory(CXMT, '1y')]);
    if (!Array.isArray(h1) || !Array.isArray(h2) || h1.length < 5 || h2.length < 5) return { ok: false, reason: '历史不足' };
    const map1 = new Map(h1.filter(x => x && x.date && x.close > 0).map(x => [x.date, x.close]));
    const map2 = new Map(h2.filter(x => x && x.date && x.close > 0).map(x => [x.date, x.close]));
    const dates = [...map1.keys()].filter(d => map2.has(d)).sort();
    if (dates.length < 20) return { ok: false, reason: `对齐交易日 ${dates.length} < 20` };
    const win = dates.slice(-Math.min(60, dates.length));
    const r1 = [], r2 = [];
    for (let i = 1; i < win.length; i++) {
      const c1a = map1.get(win[i - 1]), c1b = map1.get(win[i]);
      const c2a = map2.get(win[i - 1]), c2b = map2.get(win[i]);
      if (c1a > 0 && c1b > 0 && c2a > 0 && c2b > 0) { r1.push(c1b / c1a - 1); r2.push(c2b / c2a - 1); }
    }
    const r = pearson(r1, r2);
    return { ok: true, r: (r == null ? null : Math.round(r * 1000) / 1000), n: r1.length, limited: win.length < 60, asOf: win[win.length - 1], source: win.length < 60 ? `腾讯/东财日K（仅 ${win.length} 日，未满 60 日）` : '腾讯/东财日K（近 60 交易日）' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// ============ B层数据抓取（东财F10三表，实时；失败→诚实中止，禁用旧值） ============
async function fetchStatements() {
  try {
    const { fetchFinancialData, fetchFinancialStatement } = require('../deep/financials');
    const st = await fetchFinancialData(`SH${SYM}`);
    if (!st || !Array.isArray(st.income) || !st.income.length) return null;
    const inc = st.income;
    const pick = (d) => inc.find(r => String(r.REPORT_DATE || '').startsWith(d)) || null;
    const cur = pick('2026-09-30') || pick('2026-06-30') || pick('2026-03-31');
    const prevFY = pick('2025-12-31');
    const prevSame = cur ? pick(String(cur.REPORT_DATE).slice(0, 4) === '2026' ? `2025-${String(cur.REPORT_DATE).slice(5, 10)}` : `2024-${String(cur.REPORT_DATE).slice(5, 10)}`) : null;
    if (!cur || !prevFY || !prevSame) return null;
    // 最新报告期资产负债表（fetchFinancialData 资产负债表仅年报，需自取）
    const dates = ['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31'];
    let balQ = null;
    const bal = await fetchFinancialStatement('zcfzbAjaxNew', `SH${SYM}`, dates);
    const balArr = Array.isArray(bal) ? bal : (bal && bal.data) || [];
    balQ = balArr.find(r => String(r.REPORT_DATE || '').startsWith(String(cur.REPORT_DATE).slice(0, 10)))
      || balArr.find(r => String(r.REPORT_DATE || '').startsWith('2026-09-30'))
      || balArr.find(r => String(r.REPORT_DATE || '').startsWith('2026-06-30')) || null;
    return {
      asOf: String(cur.REPORT_DATE).slice(0, 10),
      stage: String(cur.REPORT_DATE).slice(5, 10),
      npCum: yi(cur.PARENT_NETPROFIT),
      npDedCum: yi(cur.DEDUCT_PARENT_NETPROFIT),
      revCum: yi(cur.TOTAL_OPERATE_INCOME),
      npYoy: cur.PARENT_NETPROFIT_YOY != null ? Number(cur.PARENT_NETPROFIT_YOY) : null,
      npDedYoy: cur.DEDUCT_PARENT_NETPROFIT_YOY != null ? Number(cur.DEDUCT_PARENT_NETPROFIT_YOY) : null,
      prevFYNp: yi(prevFY.PARENT_NETPROFIT),
      prevFYNpDed: yi(prevFY.DEDUCT_PARENT_NETPROFIT),
      prevSameNp: yi(prevSame.PARENT_NETPROFIT),
      prevSameNpDed: yi(prevSame.DEDUCT_PARENT_NETPROFIT),
      equityNew: balQ ? yi(balQ.TOTAL_PARENT_EQUITY) : null,
      totalAssets: balQ ? yi(balQ.TOTAL_ASSETS) : null,
      // 20261030a：其他权益工具（永续债）字段链修正——券商模板 OTHER_EQUITY_TOOL 为空，实际值在 OTHER_EQUITY_INVEST
      perp: balQ ? (yi(balQ.OTHER_EQUITY_TOOL) != null ? yi(balQ.OTHER_EQUITY_TOOL) : yi(balQ.OTHER_EQUITY_INVEST)) : null,
      balAsOf: balQ ? String(balQ.REPORT_DATE).slice(0, 10) : null,
    };
  } catch (e) { return null; }
}

async function run(symbol, { price, statements } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'huaan') return { error: 'NOT_HUAAN' };

  const G = cfg.guard || {}, Q = cfg.quarterly || {}, NL = cfg.npLatest || {};
  const PB = cfg.pbLayer || {}, ST = cfg.sotpLayer || {}, PE = cfg.peLayer || {};
  const RT = cfg.ratingThresholds || {}, LV = cfg.lastVersion || {}, NT = cfg.notes || {};
  const AL = cfg.asyncLayer || {};
  const TOL = AL.tolerances || {};
  const N_CFG = nz(cfg.shares);

  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const today = localDate();

  // ============ B层抓取（缺三表→诚实中止，禁静默填充） ============
  const S = statements || await fetchStatements();
  if (!S || S.npCum == null || S.prevFYNp == null || S.prevSameNp == null) {
    return {
      ok: true, dedicated: true, huaan: true, terminated: true, pendingUpdate: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'huaan600909 V3.0 异步数据自适应（L4 待更新态：三表核心数据缺失）',
      rating: '待更新态', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 第四层 L4 降级：定期报告核心数据（归母净利润累计序列/净资产）不可得，按规则14禁止静默填充、禁止用旧值外推，估值整体进入「待更新态」。需等待东财F10三表数据恢复后重跑。',
      riskNote: '待更新态期间不得引用任何历史目标价。',
    };
  }

  const asOfStage = S.stage; // '09-30' / '12-31' / '03-31' / '06-30'
  const bAsOf = S.asOf;
  const bAge = daysBetween(bAsOf, today);

  // ============ 指令0：守门员自检（沿袭）+ 规则13 自检清单 ============
  const reportAge = bAge;
  const g1Pass = reportAge <= nz(G.maxAgeDays, 150);
  const turnover = await getTurnoverContext();
  const tBroker = turnover.broker, tMarket = turnover.market;
  const g2Limit = nz(G.sectorTurnoverDeviationLimitPct, 30);
  let g2Status, g2Value, g2Source;
  if (tBroker) {
    const devOk = (tBroker.devPct == null) || (Math.abs(tBroker.devPct) <= g2Limit);
    g2Status = devOk ? 'PASS' : 'TERMINATE';
    g2Value = `券商板块近 ${tBroker.windowDays} 交易日日均成交额 ${tBroker.avg20Yi} 亿元（当日 ${tBroker.todayYi} 亿元，截至 ${tBroker.date}），较近 ${tBroker.baseDays} 日基线 ${tBroker.baselineYi} 亿元偏离 ${tBroker.devPct >= 0 ? '+' : ''}${tBroker.devPct}%（阈值 ±${g2Limit}%）→ ${devOk ? '未触发市场环境突变' : '⚠️ 偏离超阈值，按规则终止本次估值'}`;
    g2Source = tBroker.source;
  } else {
    g2Status = 'DEGRADED';
    g2Value = '券商板块近20日日均成交额数据源暂不可得（双源均未取到）→ 本次降级不终止，仅建立标注；下次运行自动重试';
    g2Source = '双源暂不可得（已接线）';
  }
  const cxmtWindowDays = nz(G.cxmtWindowDays, 30);
  const cxmtDays = daysBetween(G.cxmtListDate, today);
  const g3Pass = !(G.cxmtStatus !== 'listed' && cxmtDays <= cxmtWindowDays);
  const cxmtNoteLive = `长鑫科技 ${G.cxmtListDate} 已登陆科创板(${G.cxmtCode})；本次检查(${today})距上市 ${cxmtDays} 天，无新质变动态，自检通过；SOTP 采用长鑫市值×${CXMT_STAKE_PCT}%×(1−流动性折扣)`;

  const guardRows = [
    { label: '① 财报时效', status: g1Pass ? '✅ 通过' : '⛔ 终止', value: `最新报告截止 ${bAsOf}，距检查日 ${reportAge} 天（B层容忍上限 ${G.maxAgeDays} 天）`, source: `东财F10三表实时拉取（${bAsOf}）` },
    { label: '② 市场环境', status: g2Status === 'PASS' ? '✅ 通过' : (g2Status === 'TERMINATE' ? '⛔ 终止' : '🟡 降级'), value: g2Value, source: g2Source },
    { label: '③ 核心资产（长鑫科技 688825）', status: g3Pass ? '✅ 通过' : '⛔ 终止', value: cxmtNoteLive, source: `上市日 ${G.cxmtListDate}；检查日 ${today}` },
  ];
  const terminated = !g1Pass || !g3Pass || (g2Status === 'TERMINATE');

  // P2通用时效看板（沿袭）
  const freshnessRows = [];
  freshnessRows.push({ label: 'B层·最新财报报告期', asOf: bAsOf, ageDays: reportAge, maxAge: nz(G.maxAgeDays, 150), stale: !g1Pass });
  {
    const cxAge = daysBetween(G.cxmtListDate, today);
    freshnessRows.push({ label: '长鑫科技上市核查日', asOf: today, ageDays: cxAge, maxAge: 9999, stale: false });
  }
  if (tBroker && tBroker.date) {
    const tAge = daysBetween(tBroker.date, today);
    freshnessRows.push({ label: '券商板块成交额', asOf: tBroker.date, ageDays: tAge, maxAge: 5, stale: tAge > 5 });
  }

  if (terminated) {
    return {
      ok: true, dedicated: true, huaan: true, terminated: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'huaan600909 V3.0 异步数据自适应（守门员终止：估值结果待更新/需人工复核）',
      guardRows, freshnessRows,
      rating: '需人工复核', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 守门员自检未通过（财报超龄/市场环境突变/核心资产质变），模型按指令0终止本次估值，历史结论不再外推。请更新数据后重跑。',
      riskNote: '守门员终止期间不得引用旧目标价。',
    };
  }

  // ============ 第一层：数据契约表（规则13 自检①：无契约裸数据一律拒收） ============
  const contracts = [];
  const C = (name, value, periodEnd, freq, source, tolDays, opts = {}) => {
    const age = daysBetween(periodEnd, today);
    const grade = opts.grade || maturityGrade(age, tolDays);
    const row = {
      name, value: (value == null ? 'NA【缺失】' : value), periodEnd, freq, source,
      ageDays: age, tolDays, grade,
      carried: !!opts.carried, carriedFrom: opts.carriedFrom || null,
      note: opts.note || '', tier: opts.tier || 'C',
    };
    contracts.push(row);
    return row;
  };
  // A层（日频，容忍1交易日）
  const cxmt = await fetchCxmt();
  const huaan = await fetchHuaanTotal(P);
  const aRows = {
    price: C('华安证券收盘价', P != null ? r2(P) + ' 元' : (huaan.price ? r2(huaan.price) + ' 元' : null), today, '日频', huaan.source, nz(TOL.aTier, 1), { tier: 'A', note: P == null && huaan.price ? '传入价缺失，沿用实时行情' : '' }),
    cxmtMv: C('长鑫科技总市值', r2(cxmt.totalValue) + ' 亿元', cxmt.asOf, '日频', cxmt.source, nz(TOL.aTier, 1), { tier: 'A', note: cxmt.ok ? '' : '实时不可得，沿用锁定快照（±5%自动重算口径）' }),
    huaanMv: C('华安证券总市值', r2(huaan.totalValue) + ' 亿元', today, '日频', huaan.source, nz(TOL.aTier, 1), { tier: 'A' }),
  };
  // B层（季频，容忍150天）
  const bRows = {
    npCum: C('归母净利润（最新累计）', S.npCum == null ? null : r2(S.npCum) + ' 亿元', bAsOf, '季频', '东财F10利润表 PARENT_NETPROFIT', nz(TOL.bTier, 150), { tier: 'B' }),
    npDedCum: C('扣非归母净利润（最新累计）', S.npDedCum == null ? null : r2(S.npDedCum) + ' 亿元', bAsOf, '季频', '东财F10利润表 DEDUCT_PARENT_NETPROFIT', nz(TOL.bTier, 150), { tier: 'B' }),
    equity: C('归母净资产（期末）', S.equityNew == null ? null : r2(S.equityNew) + ' 亿元', S.balAsOf || bAsOf, '季频', '东财F10资产负债表 TOTAL_PARENT_EQUITY', nz(TOL.bTier, 150), { tier: 'B' }),
    revCum: C('营业收入（最新累计）', S.revCum == null ? null : r2(S.revCum) + ' 亿元', bAsOf, '季频', '东财F10利润表 TOTAL_OPERATE_INCOME', nz(TOL.bTier, 150), { tier: 'B' }),
  };
  // C层（低频/非必披露，分项容忍）
  const stakeAsOf = AL.stakePctAsOf || '2026-06-30';
  const cRows = {
    bizStructure: C('分业务条线收入结构', '常规业务净利（扣非年化）' + nz(ST.normalAnnualNp) + ' 亿', AL.structureAsOf || '2026-06-30', '半年频', '2026 中报分部数据（结转口径）', nz(TOL.bizStructure, 200), { tier: 'C', carried: true, carriedFrom: AL.structureAsOf || '2026-06-30', note: '三季报不披露分业务收入 → 按最近完整披露期结转（规则4），禁用总营收×占比' }),
    stakePct: C('长鑫科技穿透持股比例', CXMT_STAKE_PCT + '%', stakeAsOf, '公告驱动', '长鑫科技招股书穿透披露（2.64 亿股）', nz(TOL.stakePct, 180), { tier: 'C', note: '公告优先原则（规则6）：不随华安季报强制更新；若期间长鑫增发/回购须人工确认' }),
    lockStatus: C('限售状态与流动性折扣', ST.cxmtLockStatus === 'restricted' ? `限售（折扣 ${Math.round(nz(ST.cxmtLiquidityDiscount, 0.25) * 100)}%）` : ST.cxmtLockStatus, G.cxmtListDate || '2026-07-27', '公告驱动', '长鑫科技上市公告（4个月后解禁）', nz(TOL.lockStatus, 365), { tier: 'C' }),
    sectorPB: C('券商板块 PB 快照', PB.sectorPB + ' 倍', AL.paramSnapshotAsOf || '2026-09-08', '参数快照', NT.sectorPB || '板块快照', nz(TOL.paramSnapshot, 60), { tier: 'C', note: '模型参数快照（非日频行情）：超容忍期差时对 PB 锚2 做±10%敏感性' }),
    sectorPE: C('可比券商 PE 中位', PE.sectorPeMedian + ' 倍', AL.paramSnapshotAsOf || '2026-09-08', '参数快照', NT.peNormal || '可比快照', nz(TOL.paramSnapshot, 60), { tier: 'C', note: '可比公司各自最新原则（规则5）：中信 10.76/国泰海通 7.59 等快照取中位' }),
  };
  const contractRows = contracts.map(c => ({
    label: `${c.tier}层·${c.name}`,
    value: `期差 ${c.ageDays} 天 / 容忍 ${c.tolDays} 天 → 【${c.grade}】${c.carried ? '（结转自 ' + c.carriedFrom + '）' : ''}${c.note ? '；' + c.note : ''}`,
    source: `${c.value} ｜ ${c.freq} ｜ ${c.source} ｜ 报告期 ${c.periodEnd}`,
  }));

  // ============ 第二层·规则2：TTM 拼接 ============
  const npTtm = ttmSplice(S.npCum, S.prevFYNp, S.prevSameNp, asOfStage);
  const npDedTtm = ttmSplice(S.npDedCum, S.prevFYNpDed, S.prevSameNpDed, asOfStage);
  const prevQ4Np = (S.prevFYNp != null && S.prevSameNp != null) ? S.prevFYNp - S.prevSameNp : null; // 2025Q4 单季
  const ttmStageLabel = asOfStage === '12-31' ? '年报后 TTM=全年'
    : asOfStage === '09-30' ? `三季报后 TTM=${bAsOf.slice(0, 4)}前三季累计 ${r2(S.npCum)} + ${Number(bAsOf.slice(0, 4)) - 1}Q4 单季 ${r2(prevQ4Np)}`
    : asOfStage === '06-30' ? '中报后 TTM=H1累计+上年H2'
    : '一季报后 TTM=Q1+上年Q2-Q4';
  if (npTtm == null) {
    return {
      ok: true, dedicated: true, huaan: true, terminated: true, pendingUpdate: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'huaan600909 V3.0 异步数据自适应（L4：TTM 拼接数据缺失）',
      rating: '待更新态', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      guardRows, freshnessRows, contractRows,
      decisionNote: '⛔ TTM 拼接所需报告期数据缺失（规则2：禁用×4/3粗年化、禁静默填充）→ 待更新态。',
      riskNote: '待更新态期间不得引用任何历史目标价。',
    };
  }

  // ============ 第二层·规则3：BPS 股本同步检测 ============
  // 财报口径股本：三季报不披露股本变动表 → 用回购公告口径 50.24 亿股（2026-08-21 注销后）；
  // 行情口径隐含股本（总市值/现价）交叉检测，偏差<0.5% 视为同步。
  const sharesImplied = huaan.sharesImplied;
  const syncChk = bpsWithSyncCheck(S.equityNew, sharesImplied, N_CFG, AL.sharesAdjustNote || null);
  const bpsUsed = syncChk.synced ? syncChk.bps : (syncChk.bpsLow + syncChk.bpsHigh) / 2;
  const bpsGrade = syncChk.synced ? '绿' : '黄';
  const bpsNote = syncChk.synced
    ? `BPS = 归母净资产 ${r2(S.equityNew)} 亿 ÷ 股本 ${r2(sharesImplied)} 亿股 = ${syncChk.bps.toFixed(4)} 元（行情口径与回购公告口径偏差<0.5%，同步）`
    : `BPS 区间 ${syncChk.bpsLow && syncChk.bpsLow.toFixed ? syncChk.bpsLow.toFixed(4) : 'NA'} ~ ${syncChk.bpsHigh && syncChk.bpsHigh.toFixed ? syncChk.bpsHigh.toFixed(4) : 'NA'} 元；${syncChk.note}`;

  // ============ 指令1沿袭：口径分离（常态化利润剥离，单季异常检测） ============
  const npSeries = Q.npSeries || [];
  const avgNp = npSeries.reduce((a, b) => a + nz(b), 0) / Math.max(1, npSeries.length);
  const peakIdx = npSeries.indexOf(Math.max(...npSeries));
  const peakQ = (Q.labels || [])[peakIdx] || `第${peakIdx + 1}季`;
  const peakNp = nz(npSeries[peakIdx]);
  const anomalyRatio = avgNp > 0 ? peakNp / avgNp : 0;
  const anomaly = anomalyRatio > nz(Q.anomalyThreshold, 1.5);
  const epsReport = N_CFG > 0 ? npTtm / N_CFG : null;          // TTM EPS（最新拼接）
  const epsNormal = N_CFG > 0 ? npDedTtm / N_CFG : null;       // 常态 EPS（TTM 扣非口径）
  const npDedDev = (S.npYoy != null && S.npDedYoy != null) ? Math.abs(S.npYoy - S.npDedYoy) : null;

  // ============ 修订版口径（20261030a · 规范修订版六条）：正常化 EPS + 长鑫收益确认状态 ============
  // ③ 扣非质量校验：归母/扣非同比偏离 <20pp 说明非经常性损益同比影响不显著；但券商扣非仍可能含
  //    自营公允价值变动及长鑫上市重估收益 → 长鑫收益确认状态由配置 v3.caliber.lcxInNonRecurring 控制
  //    （true=已计入非经常性→扣非干净 / false=未计入→扣非被污染 / null=未确认→保守口径）。
  // ④ 正常化处理：正常化 EPS = min(TTM扣非EPS, 可持续ROE × 普通股BPS)；普通股 BPS =（归母净资产 − 其他权益工具）÷ 股本。
  //    点估值：未确认 → 取区间中值（1.048 为上限不得作中枢）；确认长鑫收益已在扣非外 → 上修至常态 EPS。
  const CAL = (cfg.v3 && cfg.v3.caliber) || {};
  const perpVal = (S.perp != null && S.perp > 0) ? S.perp : nzd(CAL.otherEquityToolsSnap, null);
  const bpsOrdinary = (perpVal != null && S.equityNew != null && N_CFG > 0) ? (S.equityNew - perpVal) / N_CFG : bpsUsed;
  const sustainRoePe = nzd(CAL.sustainRoePct, 12.5) / 100;
  const epsNormCap = sustainRoePe * bpsOrdinary;                 // 正常化上限 = 可持续ROE × 普通股BPS
  const epsNormLo = Math.min(epsNormal, epsNormCap);
  const epsNormHi = Math.max(epsNormal, epsNormCap);
  const lcxState = CAL.lcxInNonRecurring;                        // true/false/null
  const lcxConfirmed = lcxState === true;
  const epsPoint = lcxConfirmed ? epsNormal : (epsNormLo + epsNormHi) / 2;
  const caliberNote = `【一次性损益剔除口径 · 报告首页强制披露（修订版）】`
    + `① 异常检测：${peakQ} 单季归母净利 ${r2(peakNp)} 亿元为近 ${npSeries.length} 季均值（${r2(avgNp)} 亿元）的 ${Math.round(anomalyRatio * 100)}%${anomaly ? ' > 150% 阈值，触发异常口径分离' : '，未触发口径分离'}。`
    + `② 口径选择：PE 法不采用报告 EPS，采用常态 EPS = TTM 扣非 ${r2(npDedTtm)} 亿 ÷ ${r2(N_CFG)} 亿股 = ${r4(epsNormal)} 元（三季报后 TTM 扣非口径，替代原中报扣非年化）。`
    + `③ 扣非质量校验：归母/扣非同比增速偏离 ${npDedDev != null ? r2(npDedDev) + 'pp' : 'NA'} < 20pp，非经常性损益同比影响不显著；但券商扣非仍可能包含自营公允价值变动及长鑫科技上市重估收益 → 确定性引擎无三季报非经常性损益明细通道 → 长鑫相关收益确认状态【${lcxState === true ? '已计入非经常性损益（扣非干净）' : lcxState === false ? '未计入非经常性损益（扣非受污染）' : '未确认'}】${lcxConfirmed ? '' : ' → 保守处理：常态 EPS 为上限，不得作为中枢'}。`
    + `④ 正常化处理：正常化 EPS = min（TTM 扣非 EPS ${r4(epsNormal)}，可持续 ROE ${r2(sustainRoePe * 100)}% × 普通股 BPS ${r2(bpsOrdinary)} 元【=（归母净资产 ${r2(S.equityNew)} − 其他权益工具 ${perpVal != null ? r2(perpVal) : 'NA'}）÷ ${r2(N_CFG)} 亿股；实时字段 OTHER_EQUITY_INVEST，规范测算 5.62 基于扣减口径略有差异】）= ${r4(epsNormCap)} 元 → PE 法取 [${r4(epsNormLo)}, ${r4(epsNormHi)}] 区间，点估值${lcxConfirmed ? `上修至常态 EPS ${r4(epsNormal)} 元（长鑫收益确认在扣非外）` : `取中值 ${r4(epsPoint)} 元（长鑫收益未确认，保守口径）`}。`
    + `⑤ 权重约束：PE 法权重 10%，仅作底部安全边际参考，不参与向上弹性定价；SOTP 与 PB 法仍为主锚。`
    + `⑥ 数据同步说明：TTM 扣非截至 ${S.asOf}；总股本 ${r2(N_CFG)} 亿股截至 ${S.asOf}；普通股 BPS 截至 ${S.balAsOf || S.asOf}；长鑫科技持股比例截至最近公告日（敏感性区间随契约成熟度黄/红档 ±3%~5%）；限售折扣按保守假设。`;

  // ============ 三法计算 ============
  // ① PB 法（核心）：三层动态锚 = 历史40% + 板块×ROE溢价30% + 理论30%
  const roe = nz(PB.sustainableRoe) / 100, gPerp = nz(PB.g) / 100;
  const r = nz(PB.rf) / 100 + nz(PB.beta) * nz(PB.erp) / 100;
  const theoPB = (roe - gPerp) / (r - gPerp);
  const aSector = nz(PB.sectorPB) * nz(PB.premiumCoef);
  const aHist = nz(PB.histPbMedian);
  const fairPB = nz(PB.wHist) * aHist + nz(PB.wSector) * aSector + nz(PB.wTheo) * theoPB;
  // 板块 PB 快照黄/红 → 锚2 ±10% 敏感性（L2 区间化）
  const pbAnchor2Low = cRows.sectorPB.grade !== '绿' ? fairPB - nz(PB.wSector, 0.3) * aSector * 0.10 : fairPB;
  const pbAnchor2High = cRows.sectorPB.grade !== '绿' ? fairPB + nz(PB.wSector, 0.3) * aSector * 0.10 : fairPB;
  // 20261030b：PB 层切换普通股口径 BPS（规范《本次估值权重与输出形态》第6条：PB法目标价=普通股BPS×合理PB）
  // 普通股 BPS =（归母净资产 − 其他权益工具/永续债）÷ 股本；归母口径 BPS（bpsUsed）保留供参照
  const pbTarget = bpsOrdinary * fairPB;
  const pbTargetLow = bpsOrdinary * pbAnchor2Low, pbTargetHigh = bpsOrdinary * pbAnchor2High;

  // ② SOTP 法：常规业务（结转净利×可比PE，±15% 敏感性）+ 长鑫持股价值×流动性折扣（±5% 持股比例区间）
  const liq = liquidityDiscount(cfg);
  const cxmtMv = nz(cxmt.totalValue), huaanMv = nz(huaan.totalValue);
  const sotpBase = nz(ST.normalAnnualNp) * nz(ST.peNormal);
  const stakeGross = cxmtMv * (CXMT_STAKE_PCT / 100);
  const stakeValue = stakeGross * liq.retain;
  const sotpTarget = N_CFG > 0 ? (sotpBase + stakeValue) / N_CFG : null;
  const sotpSensPct = nz(ST.sensPct, 0.15);
  const stakeSensPct = cRows.stakePct.grade === '红' ? 0.05 : (cRows.stakePct.grade === '黄' ? 0.03 : 0);
  const sotpLow = N_CFG > 0 ? (sotpBase * (1 - sotpSensPct) + stakeValue * (1 - stakeSensPct)) / N_CFG : null;
  const sotpHigh = N_CFG > 0 ? (sotpBase * (1 + sotpSensPct) + stakeValue * (1 + stakeSensPct)) / N_CFG : null;

  // ③ PE 法（修订版口径：正常化 EPS 区间 [可持续ROE×普通股BPS, TTM扣非EPS]，点估值=中值/确认后上修）
  const histPe = PE.histPeMedian == null ? null : nz(PE.histPeMedian);
  const sectorPe = nz(PE.sectorPeMedian);
  const peMult = (histPe != null && histPe > 0) ? Math.min(histPe, sectorPe) : sectorPe;
  const peTarget = epsPoint * peMult;          // 点估值（未确认→中值口径；确认→常态 EPS）
  const peTargetLow = epsNormLo * peMult;      // 正常化下限
  const peTargetHigh = epsNormHi * peMult;     // 上限（常态 EPS）

  // ============ 第三层·规则7：方法成熟度 ============
  // PB 依赖：净资产（B）+股本（B/A）+可持续ROE（B历史）→ 最低档
  const mPB = [bRows.equity.grade, bpsGrade, '绿'].includes('红') ? '红' : ([bRows.equity.grade, bpsGrade].includes('黄') ? '黄' : '绿');
  // PE 依赖：TTM扣非（B）+股本（B）→ 最低档（B层绿则绿）
  const mPE = bRows.npDedCum.grade === '红' || bpsGrade === '红' ? '红' : (bRows.npDedCum.grade === '黄' || bpsGrade === '黄' ? '黄' : '绿');
  // SOTP 依赖：分业务结构（C）+长鑫市值（A）+持股比例（C）+限售（C）→ 最低档
  const mSOTP = [cRows.bizStructure.grade, aRows.cxmtMv.grade, cRows.stakePct.grade, cRows.lockStatus.grade].includes('红') ? '红'
    : [cRows.bizStructure.grade, cRows.stakePct.grade].includes('黄') ? '黄' : '绿';

  // ============ 指令9沿袭+规则9：影子股判定与两套权重 ============
  const stakeRatioGross = huaanMv > 0 ? stakeGross / huaanMv : 0;
  const stakeRatioDisc = huaanMv > 0 ? stakeValue / huaanMv : 0;
  const shadow = stakeRatioGross > 0.30;

  const wMain = dynWeights({ pb: mPB, sotp: mSOTP, pe: mPE, shadow });
  if (wMain.pending) {
    return {
      ok: true, dedicated: true, huaan: true, terminated: true, pendingUpdate: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'huaan600909 V3.0 异步数据自适应（待更新态：' + (wMain.reason || 'PB法为红') + '）',
      rating: '待更新态', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      guardRows, freshnessRows, contractRows,
      decisionNote: '⛔ ' + (wMain.reason || 'PB 法为红 → 待更新态（规则8/10）。'),
      riskNote: '待更新态期间不得引用任何历史目标价。',
    };
  }
  // 两套权重（影子股模式时）：主权重 vs 参考权重（相邻成熟度档位）
  let refW = null;
  if (shadow) {
    const refGrade = mSOTP === '绿' ? '黄' : (mSOTP === '黄' ? '绿' : '黄');
    const wRef = dynWeights({ pb: mPB, sotp: refGrade, pe: mPE, shadow: true });
    refW = { grade: refGrade, wPB: wRef.wPB, wSOTP: wRef.wSOTP, wPE: wRef.wPE, reason: wRef.reason };
  }
  const wts = { wPB: wMain.wPB, wSOTP: wMain.wSOTP, wPE: wMain.wPE };
  const wLabelMain = `PB ${Math.round(wts.wPB * 100)}% / SOTP ${Math.round(wts.wSOTP * 100)}% / PE ${Math.round(wts.wPE * 100)}%`;

  // ============ 综合目标价（三态输出·规则10） ============
  const anyYellow = mPB === '黄' || mPE === '黄' || mSOTP === '黄' || bpsGrade === '黄';
  const anyRed = mPB === '红' || mPE === '红' || mSOTP === '红';
  // 区间化：SOTP 敏感性区间 + PB 锚2敏感性区间（快照非绿时）+ PE 正常化区间（修订版口径）参与加权
  const pbLow = pbTargetLow, pbHigh = pbTargetHigh;
  const center = wts.wPB * pbTarget + wts.wSOTP * sotpTarget + wts.wPE * peTarget;
  const centerLow = wts.wPB * pbLow + wts.wSOTP * sotpLow + wts.wPE * peTargetLow;
  const centerHigh = wts.wPB * pbHigh + wts.wSOTP * sotpHigh + wts.wPE * peTargetHigh;
  const refCenter = refW ? (refW.wPB * pbTarget + refW.wSOTP * sotpTarget + refW.wPE * peTarget) : null;
  const outputState = anyRed ? '区间态（含红项）' : (anyYellow ? '区间态' : '精确态');
  // 20261030b 规范第7条：区间态置信度按「绿色方法权重占比」近似（附定性描述：≥70%高 / ≥50%中等偏高 / ≥35%中等 / 其余一般）；精确态保持 90
  const greenW = (mPB === '绿' ? wts.wPB : 0) + (mSOTP === '绿' ? wts.wSOTP : 0) + (mPE === '绿' ? wts.wPE : 0);
  const confQual = greenW >= 0.7 ? '高' : (greenW >= 0.5 ? '中等偏高' : (greenW >= 0.35 ? '中等' : '一般'));
  const confidence = (anyRed || anyYellow) ? Math.round(greenW * 100) : 90;
  const fairValueRange = (anyYellow || anyRed) ? [r2(Math.min(centerLow, centerHigh)), r2(Math.max(centerLow, centerHigh))] : [r2(center * nz(RT.buyBelow, 0.9)), r2(center * nz(RT.reduceAbove, 1.05))];

  // ============ 规则12：评级区间判定（映射项目三档铁律） ============
  let rating = '合理', ratingNote = '', ratingBoundary = '';
  if (P != null && fairValueRange) {
    const lo = fairValueRange[0], hi = fairValueRange[1];
    if (P < lo * nz(RT.buyBelow, 0.9)) {
      rating = '低估';
      ratingNote = `现价 ${r2(P)} < 区间下限 ${lo} × 0.9 = ${r2(lo * nz(RT.buyBelow, 0.9))} → 低估（规范「买入」档，映射项目三档评级铁律）`;
    } else if (P > hi * nz(RT.reduceAbove, 1.05)) {
      rating = '高估';
      ratingNote = `现价 ${r2(P)} > 区间上限 ${hi} × 1.05 = ${r2(hi * nz(RT.reduceAbove, 1.05))} → 高估（规范「减持/观望」档，映射项目三档评级铁律）`;
    } else {
      rating = '合理';
      ratingNote = `现价 ${r2(P)} 处 [下限×0.9, 上限×1.05] = [${r2(lo * nz(RT.buyBelow, 0.9))}, ${r2(hi * nz(RT.reduceAbove, 1.05))}] 区间内 → 合理（规范「持有/中性」档）`;
      const nearLow = Math.abs(P - lo * nz(RT.buyBelow, 0.9)) <= lo * nz(RT.buyBelow, 0.9) * 0.03;
      const nearHigh = Math.abs(P - hi * nz(RT.reduceAbove, 1.05)) <= hi * nz(RT.reduceAbove, 1.05) * 0.03;
      if (nearLow || nearHigh) ratingBoundary = '⚠️ 现价接近评级阈值边界（±3%）→ 方向性不明，等待数据同步后再判定';
    }
  } else {
    ratingNote = '实时价不可用，仅输出目标价区间。';
  }

  // ============ 第四层：四级降级留痕 ============
  const downgradeLog = [];
  const dlog = (item, why, level, impact) => { downgradeLog.push({ item, why, level, impact }); };
  if (cRows.bizStructure.grade !== '绿') dlog('分业务收入结构', `三季报不披露分业务收入，沿用 ${cRows.carriedFrom || '2026-06-30'} 结转（规则4）`, 'L1', 'SOTP 常规业务净利为结转口径，±15% 敏感性 → SOTP 输出区间');
  if (cRows.stakePct.grade !== '绿') dlog('长鑫穿透持股比例', `公告基准 ${stakeAsOf}，期差 ${cRows.stakePct.ageDays} 天（${cRows.stakePct.grade}）`, cRows.stakePct.grade === '红' ? 'L2' : 'L1', cRows.stakePct.grade === '红' ? '持股比例设±5%区间 → 长鑫持股价值区间化' : '持股比例±3%敏感性并入 SOTP 区间');
  if (cRows.sectorPB.grade !== '绿') dlog('券商板块 PB 快照', `参数快照 ${cRows.sectorPB.periodEnd}，期差 ${cRows.sectorPB.ageDays} 天超 60% 容忍（${cRows.sectorPB.grade}）`, 'L2', 'PB 锚2 ±10% 敏感性 → PB 目标价区间化');
  if (!syncChk.synced) dlog('总股本', '净资产与股本不同报告期（规则3）', 'L2', 'BPS 区间化：' + syncChk.note);
  if (mPE === '红') dlog('PE 法', 'TTM 扣非或股本为红', 'L3', 'PE 法停用（基准 10%<15%），权重转移');
  if (aRows.cxmtMv.grade === '红' || !cxmt.ok) dlog('长鑫科技总市值', '实时不可得，沿用锁定快照', 'L1', '持股价值按快照计算，下次运行实时重算');
  if (!downgradeLog.length) downgradeLog.push({ item: '（无）', why: '全部指标为绿，L0 正常路径', level: 'L0', impact: '点估值可用（若全绿则精确态）' });

  // ============ 输出行（兼容字段 + 新增） ============
  const dualEpsRows = [
    { label: '报告 EPS（TTM 拼接）', value: `${r4(epsReport)} 元`, source: `TTM 归母 ${r2(npTtm)} 亿 ÷ ${N_CFG} 亿股（${ttmStageLabel}）` },
    { label: '常态 EPS（TTM 扣非）', value: `${r4(epsNormal)} 元`, source: `TTM 扣非 ${r2(npDedTtm)} 亿 ÷ ${r2(N_CFG)} 亿股；PE 法上限口径（长鑫收益未确认期间不得作中枢）` },
    { label: '正常化 EPS（修订版口径）', value: `min（TTM扣非 ${r4(epsNormal)}，可持续ROE ${r2(sustainRoePe * 100)}% × 普通股BPS ${r2(bpsOrdinary)}）= ${r4(epsNormCap)} 元 → PE 法区间 [${r4(epsNormLo)}, ${r4(epsNormHi)}]，点估值 ${r4(epsPoint)} 元${lcxConfirmed ? '（长鑫收益确认在扣非外 → 上修至常态 EPS）' : '（长鑫收益未确认 → 保守中值）'}`, source: `规范修订版④；普通股BPS=（归母净资产 ${r2(S.equityNew)} − 其他权益工具 ${perpVal != null ? r2(perpVal) : 'NA'}）÷ ${r2(N_CFG)} 亿股` },
    { label: 'TTM 拼接口径', value: ttmStageLabel, source: '规则2：禁用×4/3粗年化，TTM=最新累计+上年同期后单季' },
    { label: '异常触发判定', value: `${peakQ} 单季 ${r2(peakNp)} 亿 = 均值 ${r2(avgNp)} 亿 × ${Math.round(anomalyRatio * 100)}% ${anomaly ? '> 150% → 已触发口径分离' : '未触发'}`, source: `单季序列（${(Q.labels || []).join(' ')}）${Q.seriesNote ? '；' + Q.seriesNote : ''}` },
  ];

  // 20261030b 规范《本次估值权重与输出形态》：weightsNote 重写为八条结构（权重分配/成熟度/调整依据/主情景/参考情景/分项结果/输出形态/数据同步）
  const weightsNote = [
    `① 权重分配：${wLabelMain}（合计100%，归一化通过）`,
    `② 方法成熟度：PB【${mPB}】/ SOTP【${mSOTP}】/ PE【${mPE}】`,
    `③ 权重调整依据：${wMain.reason}${shadow ? `（影子股模式触发：长鑫持股价值占华安市值 ${(stakeRatioGross * 100).toFixed(2)}% > 30% 阈值）。规则9优先于规则8的通用降权，特此说明` : ''}`,
    `④ 主情景（当前${mSOTP}口径）：${wLabelMain} → 综合目标价区间【${r2(Math.min(centerLow, centerHigh))}–${r2(Math.max(centerLow, centerHigh))}】元，中枢 ${r2(center)} 元`,
    refW ? `⑤ 参考情景（SOTP数据转${refW.grade}）：PB ${Math.round(refW.wPB * 100)}% / SOTP ${Math.round(refW.wSOTP * 100)}% / PE ${Math.round(refW.wPE * 100)}% → 目标价 ${r2(refCenter)} 元，仅作参考，不作为本次主结论` : '⑤ 参考情景：非影子股模式，无摆动参考权重',
    `⑥ 分项结果（供验证）：PB法目标价 ${r2(pbTarget)} 元（普通股BPS ${r2(bpsOrdinary)} 元 × 合理PB ${fairPB.toFixed(4)} 倍）；SOTP法目标价 ${r2(sotpTarget)} 元（含长鑫持股贡献 ${r2(stakeValue)} 亿元，折扣 ${Math.round(liq.discount * 100)}%）；PE法目标价 ${r2(peTarget)} 元（正常化EPS ${r4(epsPoint)} 元 × 合理PE ${peMult} 倍）`,
    `⑦ 输出形态：${outputState}，不输出单一点值。置信度：${confQual}（绿色方法权重占比 ${Math.round(greenW * 100)}%，黄色方法权重 ${Math.round((1 - greenW) * 100)}%；置信度按绿色权重占比近似）${anyRed || anyYellow ? '' : '（全绿精确态，置信度 90）'}`,
    `⑧ 数据同步说明：TTM扣非 ${r2(npDedTtm)} 亿/总股本 ${r2(N_CFG)} 亿股/普通股BPS ${r2(bpsOrdinary)} 元截至 ${bAsOf}；长鑫持股比例截至 ${stakeAsOf}，期差 ${cRows.stakePct.ageDays} 天，成熟度【${cRows.stakePct.grade}】，敏感性±${stakeSensPct ? Math.round(stakeSensPct * 100) : 5}%；限售折扣按 ${Math.round(liq.discount * 100)}% 保守假设`,
  ].join('。') + '。';

  const detailRows = [
    { label: 'PB层·锚1 历史中枢', value: `PB 中位 ${aHist} 倍 × 权重 ${PB.wHist} = ${(nz(PB.wHist) * aHist).toFixed(4)}`, source: NT.histPb },
    { label: 'PB层·锚2 板块×ROE溢价', value: `板块 PB ${PB.sectorPB} × 溢价系数 ${PB.premiumCoef}（=ROE ${PB.sustainableRoe}% ÷ 行业均值假设 ${PB.sectorAvgRoeAssumed}%）= ${r2(aSector)} 倍 × 权重 ${PB.wSector}${cRows.sectorPB.grade !== '绿' ? `（快照【${cRows.sectorPB.grade}】→ ±10% 敏感性）` : ''}`, source: NT.sectorPB + '；' + NT.premiumCoef },
    { label: 'PB层·锚3 理论PB', value: `(ROE−g)/(r−g) = (${PB.sustainableRoe}%−${PB.g}%)/(r−${PB.g}%)，r = Rf ${PB.rf}% + β ${PB.beta} × ERP ${PB.erp}% = ${r2(r * 100)}% → 理论 PB ${theoPB.toFixed(4)} 倍 × 权重 ${PB.wTheo}`, source: NT.sustainableRoe + '；' + NT.beta },
    { label: 'PB层·三层加权目标价', value: `加权 PB ${fairPB.toFixed(4)} 倍 × 普通股BPS ${bpsOrdinary.toFixed(4)} 元 = ${r2(pbTarget)} 元/股（20261030b 规范⑥：PB法=普通股BPS×合理PB；归母口径 BPS ${bpsUsed.toFixed(2)} 元仅作参照）${(anyYellow || anyRed) && cRows.sectorPB.grade !== '绿' ? `（区间 ${r2(pbTargetLow)} ~ ${r2(pbTargetHigh)}）` : ''}`, source: NT.equity + '；' + bpsNote },
    { label: 'SOTP层·常规业务（结转）', value: `常态净利 ${ST.normalAnnualNp} 亿（2026H1 扣非×2 结转，结构基准期 ${AL.structureAsOf || '2026H1'}）× 可比 PE ${ST.peNormal} 倍 = ${r2(sotpBase)} 亿元；敏感性 ±${Math.round(sotpSensPct * 100)}% → [${r2(sotpBase * (1 - sotpSensPct))}, ${r2(sotpBase * (1 + sotpSensPct))}] 亿`, source: '规则4 结构结转+敏感性；结转口径避免与长鑫持股市值双重计价（TTM 含长鑫 Q3 上市增值）' },
    { label: '指令9·长鑫科技(688825)总市值', value: `${r2(cxmtMv)} 亿元（${cxmt.source}，${cxmt.asOf}）${!cxmt.ok ? '【实时不可得，回退快照】' : ''}`, source: `持股比 ${CXMT_STAKE_PCT}%（${cRows.stakePct.grade}，基准 ${stakeAsOf}）` },
    { label: '指令9·间接持股价值', value: `长鑫市值 ${r2(cxmtMv)} 亿 × ${CXMT_STAKE_PCT}% × (1 − 折扣 ${Math.round(liq.discount * 100)}%) = ${r2(stakeValue)} 亿元（${liq.label}）${stakeSensPct ? `；持股比例 ±${Math.round(stakeSensPct * 100)}% 敏感性` : ''}`, source: `华安总市值 ${r2(huaanMv)} 亿（${huaan.source}）` },
    { label: '指令9·参股资产占比', value: `未折现占比 ${(stakeRatioGross * 100).toFixed(2)}%${shadow ? ' > 30% → 影子股模式（SOTP 权重按成熟度摆动，规则9）' : '（未跨越 30% 影子股阈值）'}；折现持股价值占华安 ${(stakeRatioDisc * 100).toFixed(2)}%`, source: '规则9：占比分子=长鑫最新市值×持股比例区间×(1−折扣)，分母=华安最新市值' },
    { label: 'SOTP层·合计（区间）', value: `中枢 ${r2(sotpTarget)} 元/股（常规业务 ${r2(sotpBase)} 亿 + 持股价值 ${r2(stakeValue)} 亿 ÷ ${N_CFG} 亿股）；区间 ${r2(sotpLow)} ~ ${r2(sotpHigh)} 元`, source: `SOTP 依赖 C 层数据 → 成熟度【${mSOTP}】，输出区间而非点值（规则10）` },
  ];
  if (shadow) {
    const corr = await computeLinkCorr();
    const linkFlag = (corr && corr.ok && corr.r != null && corr.r > 0.5);
    detailRows.push({ label: '★ 长鑫科技持股贡献（单独列示）', value: `${r2(stakeValue)} 亿元 ÷ ${N_CFG} 亿股 = ${r2(stakeValue / N_CFG)} 元/股，占综合目标价中枢 ${(wts.wSOTP * (stakeValue / (sotpBase + stakeValue)) * 100).toFixed(1)}%`, source: '影子股模式：综合目标价中单独披露参股资产贡献' });
    detailRows.push({ label: '指令9·股价联动强度', value: (corr && corr.ok && corr.r != null) ? `近 60 交易日华安日收益 vs 长鑫日收益相关系数 r = ${corr.r}（n=${corr.n}，${corr.asOf}）${linkFlag ? ' → 走势主要由长鑫驱动，券商基本面解释力减弱' : ''}` : `不可得（${corr && corr.reason ? corr.reason : '数据缺失'}）`, source: (corr && corr.ok ? corr.source : '腾讯/东财日K（待接入）') + '；联动强度仅用A层日频数据（规则9），不受财报异步影响' });
  }
  detailRows.push(
    { label: 'PE层（正常化口径·修订版）', value: `正常化 EPS 点估值 ${r4(epsPoint)} 元（区间 [${r4(epsNormLo)}, ${r4(epsNormHi)}]，长鑫收益确认状态【${lcxState === true ? '已计入非经常性' : lcxState === false ? '未计入非经常性' : '未确认·保守中值'}】）× PE 乘数 ${peMult} 倍${histPe == null ? '（5年PE中位缺失【数据缺失】→ 取行业PE中位）' : '（=min(5年中位,行业中位)）'} → 点估值 ${r2(peTarget)} 元/股，区间 [${r2(peTargetLow)}, ${r2(peTargetHigh)}] 元`, source: `PE 依赖 B 层 TTM 扣非 + 股本 → 成熟度【${mPE}】；权重 10% 仅作底部安全边际参考，不参与向上弹性定价（修订版⑤）` },
    { label: '综合目标价（' + outputState + '）', value: `${outputState === '精确态' ? '点值 ' + r2(center) : `区间 ${fairValueRange[0]} ~ ${fairValueRange[1]} 元，中枢 ${r2(center)}`} 元/股，置信度 ${confidence}%（${confQual}，按绿色方法权重占比 ${Math.round(greenW * 100)}% 近似）`, source: `低估触发线 ${r2(fairValueRange[0] * nz(RT.buyBelow, 0.9))} 元｜高估触发线 ${r2(fairValueRange[1] * nz(RT.reduceAbove, 1.05))} 元` },
  );

  // ============ 20261030c 规范《估值结构拆解 · 强制披露》五条（全动态值） ============
  const structureRows = [];
  // 第1条：分项目标价拆解 + 结构贡献
  const pbGapPct = P != null ? (P - pbTarget) / pbTarget * 100 : null;
  structureRows.push({ label: '① 分项目标价拆解', value: `PB法 ${r2(pbTarget)} 元（普通股BPS ${r2(bpsOrdinary)} × 合理PB ${fairPB.toFixed(2)} 倍）${pbGapPct != null ? ` → 现价 ${r2(P)} 相对PB法${pbGapPct >= 0 ? '高估' : '低估'} ${Math.abs(pbGapPct).toFixed(1)}%` : ''}；SOTP法 ${r2(sotpTarget)} 元（含长鑫持股贡献 ${r2(stakeValue / N_CFG)} 元/股，折扣 ${Math.round(liq.discount * 100)}% 保守口径）；PE法 ${r2(peTarget)} 元（正常化EPS ${r4(epsPoint)} × 合理PE ${peMult} 倍，仅作底部参考）`, source: '《估值结构拆解·强制披露》第1条：三法分项必须列示供验证' });
  structureRows.push({ label: '① 结构贡献', value: `综合中枢 ${r2(center)} 元主要由 SOTP 贡献（权重 ${Math.round(wts.wSOTP * 100)}%），PB法仅提供 ${r2(pbTarget)} 元的价值底`, source: `权重结构：${wLabelMain}` });
  // 第2条：评级口径说明（现价低于下限但高于买入触发线 → 持有/中性，不判低估）
  let ratingCaliber = '实时价不可用。';
  if (P != null && fairValueRange) {
    const lo = fairValueRange[0], buyLine = lo * nz(RT.buyBelow, 0.9);
    ratingCaliber = P < lo
      ? `现价 ${r2(P)} 低于区间下限 ${r2(lo)}，但高于买入触发线 ${r2(buyLine)}（下限×0.9）→ 按规则判「持有/中性」（合理档），不判低估；若现价回落至 ${r2(buyLine)} 附近，将进入买入观察区`
      : `现价 ${r2(P)} 处于区间 [${r2(lo)}, ${r2(fairValueRange[1])}] 内 → 按规则判「持有/中性」（合理档）；买入触发线 ${r2(buyLine)}（下限×0.9），回落至该线附近将进入买入观察区`;
  }
  structureRows.push({ label: '② 评级口径说明', value: ratingCaliber, source: '《估值结构拆解·强制披露》第2条：下限与买入触发线（下限×0.9）之间为持有/中性观察带' });
  // 第3条：影子股溢价提示 + 长鑫市值 -20% 敏感性（确定性传导）
  const cxmtPremium = P != null ? P - pbTarget : null;
  const cxmtDown20 = stakeValue * 0.2;
  const perShare20 = cxmtDown20 / N_CFG;
  const centerAfter20 = center - perShare20 * wts.wSOTP;
  structureRows.push({ label: '③ 影子股溢价提示', value: `${cxmtPremium != null ? `现价 ${r2(P)} 中约 ${r2(cxmtPremium)} 元/股为长鑫科技持股溢价（现价 − PB法目标价 ${r2(pbTarget)}）；` : ''}敏感性：长鑫市值 −20% → 持股价值 −${r2(cxmtDown20)} 亿（−${r2(perShare20)} 元/股），经 SOTP 权重 ${Math.round(wts.wSOTP * 100)}% 传导 → 综合中枢 ${r2(center)} → 约 ${r2(centerAfter20)} 元，现价安全边际将显著收窄`, source: '《估值结构拆解·强制披露》第3条：长鑫市值波动是本标的最大边际变量' });
  // 第4条：置信度说明（构成 + 红档降级路径）
  structureRows.push({ label: '④ 置信度说明', value: `置信度 ${confidence}%（${confQual}）按绿色方法权重占比近似（PB【${mPB}】${Math.round(wts.wPB * 100)}% + PE【${mPE}】${Math.round(wts.wPE * 100)}% = ${Math.round(greenW * 100)}%），SOTP 权重 ${Math.round(wts.wSOTP * 100)}% 计【${mSOTP}】不计入；若长鑫持股比例或限售状态更新为红档，置信度将下调至 60% 以下`, source: '《估值结构拆解·强制披露》第4条：置信度构成+红档降级路径强制披露' });
  // 第5条：PB口径提示（现值双口径 + 合理PB口径无关）
  const pbLfGross = P != null && bpsUsed ? P / bpsUsed : null;
  const pbLfNet = P != null ? P / bpsOrdinary : null;
  structureRows.push({ label: '⑤ PB口径提示', value: `PB(LF) 现值 ${pbLfGross != null ? pbLfGross.toFixed(2) : 'N/A'} 倍（含其他权益工具口径，÷归母BPS ${r2(bpsUsed)}）vs 合理PB ${fairPB.toFixed(2)} 倍；若统一扣减其他权益工具（÷普通股BPS ${r2(bpsOrdinary)}），PB(LF) 现值上修至 ${pbLfNet != null ? pbLfNet.toFixed(2) : 'N/A'} 倍（合理PB为三层加权乘数，不随BPS口径变化），现值高于合理PB 的相对关系不变，结论稳健`, source: '《估值结构拆解·强制披露》第5条：PB 比较口径差异强制披露' });

  const compareRows = [
    { label: `上次：${LV.version}`, value: `区间 ${LV.range ? LV.range[0] + '~' + LV.range[1] : 'N/A'} 元，中枢 ${LV.center} 元，评级「${LV.rating}」` },
    { label: '本次：V3.0 异步数据自适应（20261029p）', value: `${outputState === '精确态' ? '中枢' : '区间 ' + fairValueRange[0] + '~' + fairValueRange[1] + '，中枢'} ${r2(center)} 元，评级「${rating}」，置信度 ${confidence}%`, source: `权重 ${wLabelMain}${refW ? '（影子摆动两套权重并列）' : ''}` },
    { label: '差异原因', value: LV.diffNote || '' },
  ];

  const mktFloorYi = nz((cfg.riskMonitor && cfg.riskMonitor.marketTurnoverFloorYi), 12000);
  const mktRow = tMarket
    ? (tMarket.todayYi >= mktFloorYi
      ? { label: '市场成交额（全市场）', light: `🟢 当日 ${tMarket.todayYi} 亿 ≥ 预警线 ${mktFloorYi / 10000} 万亿（近20日日均 ${tMarket.avg20Yi} 亿，截至 ${tMarket.date}）` }
      : { label: '市场成交额（全市场）', light: `🔴 预警：当日 ${tMarket.todayYi} 亿 < ${mktFloorYi / 10000} 万亿 → 经纪/自营景气度承压（截至 ${tMarket.date}）` })
    : { label: '市场成交额（全市场）', light: '🟡 全市场成交额数据源暂不可得' };
  const riskMonitorRows = [
    mktRow,
    { label: '长鑫科技（688825）舆情', light: `🟢 ${(cfg.riskMonitor && cfg.riskMonitor.cxmtNegative) || '未发现负面'}` },
    { label: '监管处罚', light: `🟢 ${(cfg.riskMonitor && cfg.riskMonitor.regulatory) || '无新增'}` },
  ];

  const positionNote = P != null
    ? `当前股价 ${r2(P)} 元 vs ${outputState === '精确态' ? '综合目标价' : '目标价区间（中枢）'} ${r2(center)} 元（低估线 ${r2(fairValueRange[0] * nz(RT.buyBelow, 0.9))} / 高估线 ${r2(fairValueRange[1] * nz(RT.reduceAbove, 1.05))}）；${ratingNote}${ratingBoundary ? '；' + ratingBoundary : ''}。PB(LF) 现值约 ${(P / bpsUsed).toFixed(2)} 倍 vs 三层加权合理 PB ${fairPB.toFixed(2)} 倍。`
    : '实时价不可用。';

  const riskNote = '上行：市场成交额维持高位、长鑫科技股价贡献持股市值弹性；下行：全市场成交额跌破预警线、长鑫股价回撤（SOTP 直接受损）、监管处罚。数据异步架构下所有黄项均已区间化并留痕，不构成投资建议。';

  const modeLabel = shadow ? '影子股模式' : (stakeRatioGross >= 0.10 ? '显著参股模式' : '常规模式');
  const decisionNote = `框架 V3.0 异步数据自适应【十四规则】：三表实时拉取（${bAsOf}，${ttmStageLabel}）；数据契约 ${contracts.length} 项（绿 ${contracts.filter(c => c.grade === '绿').length}/黄 ${contracts.filter(c => c.grade === '黄').length}/红 ${contracts.filter(c => c.grade === '红').length}）；${modeLabel}（长鑫占比 ${(stakeRatioGross * 100).toFixed(2)}%）→ 权重 ${wLabelMain}；${outputState}（置信度 ${confidence}%）。${downgradeLog.filter(d => d.level !== 'L0').length ? '降级留痕：' + downgradeLog.filter(d => d.level !== 'L0').map(d => `${d.item}→${d.level}`).join('、') : '全部指标 L0 正常。'}`;

  return {
    ok: true,
    dedicated: true,
    huaan: true,
    version: 'V3.0_异步数据自适应',
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange,
    fairValueCenter: r2(center),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'huaan600909 V3.0 异步数据自适应架构（数据契约+成熟度分级+TTM拼接+股本同步+动态权重+影子股摆动+四级降级+三态输出，确定性计算无AI参与）',
    dataAsOf: cfg.dataAsOf,
    outputState,
    confidence,
    summaryNote: `${outputState}：目标价${outputState === '精确态' ? '' : '区间 ' + fairValueRange[0] + '~' + fairValueRange[1] + '，'}中枢 ${r2(center)} 元，置信度 ${confidence}%（${confQual}）；评级【${rating}】。三季报后 TTM 归母 ${r2(npTtm)} 亿（+${r2(S.npYoy)}%），普通股BPS ${bpsOrdinary.toFixed(2)} 元（归母口径 ${bpsUsed.toFixed(2)}）；长鑫占比 ${(stakeRatioGross * 100).toFixed(2)}% 影子股模式；权重 ${wLabelMain}。${ratingBoundary || ''}`,
    // 数据契约三件套
    contractRows,
    weightsNote,
    downgradeLog,
    // 沿袭字段
    guardRows, freshnessRows,
    caliberNote,
    dualEpsRows,
    detailRows,
    structureRows,
    compareRows,
    riskMonitorRows,
    positionNote,
    riskNote,
    decisionNote,
    ttmStage: { stage: asOfStage, label: ttmStageLabel, npTtm: r2(npTtm), npDedTtm: r2(npDedTtm), prevQ4Np: r2(prevQ4Np) },
    // 20261030a 修订版口径：正常化 EPS 区间 + 长鑫收益确认状态
    caliber2: {
      epsNormal: r4(epsNormal), epsNormCap: r4(epsNormCap), epsNormLo: r4(epsNormLo), epsNormHi: r4(epsNormHi),
      epsPoint: r4(epsPoint), sustainRoePe: r2(sustainRoePe * 100), bpsOrdinary: r2(bpsOrdinary),
      otherEquityTools: perpVal != null ? r2(perpVal) : null, npDedDev: npDedDev != null ? r2(npDedDev) : null,
      lcxState: lcxState === true ? 'confirmed_out' : lcxState === false ? 'in_deducted' : 'unconfirmed',
      peTarget: r2(peTarget), peTargetLow: r2(peTargetLow), peTargetHigh: r2(peTargetHigh),
    },
    sotpDynamic: {
      mode: shadow ? 'shadow' : (stakeRatioGross >= 0.10 ? 'elevated' : 'normal'),
      cxmtMarketCap: r2(cxmtMv),
      cxmtAsOf: cxmt.asOf,
      cxmtSource: cxmt.source,
      cxmtLive: !!cxmt.ok,
      huaanMarketCap: r2(huaanMv),
      huaanSource: huaan.source,
      stakePct: CXMT_STAKE_PCT,
      stakeGross: r2(stakeGross),
      stakeValue: r2(stakeValue),
      stakeRatio: Math.round(stakeRatioGross * 10000) / 10000,
      stakeRatioDiscounted: Math.round(stakeRatioDisc * 10000) / 10000,
      discountLabel: liq.label,
      liquidityDiscount: liq.discount,
      weights: { pb: wts.wPB, sotp: wts.wSOTP, pe: wts.wPE },
      refWeights: refW ? { pb: refW.wPB, sotp: refW.wSOTP, pe: refW.wPE, grade: refW.grade, center: r2(refCenter) } : null,
      maturity: { pb: mPB, sotp: mSOTP, pe: mPE, bps: bpsGrade },
      methodMaturityNote: weightsNote,
      linkCorr: null,
      linkFlag: false,
      linkNote: null,
    },
  };
}

module.exports = { run, isHuaanModel, loadConfig, pickSotpWeights, maturityGrade, ttmSplice, bpsWithSyncCheck, dynWeights, liquidityDiscount, pearson, CXMT_STAKE_PCT };
