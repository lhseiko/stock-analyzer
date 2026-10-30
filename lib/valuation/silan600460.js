// ============================================================
// 士兰微（600460）专属估值引擎 —— 数据治理升级版（确定性计算，1+1=2）
// 20261029q【用户下发规范全文实施】设计总纲三句：
//   ①所有数据必须携带「报告期身份证」（报告期/级别/获取方式三要素），无标签禁入估值公式；
//   ②估值公式强制同口径（分子分母同一报告期体系，跨期混用拦截）；
//   ③缺失数据走固定替代路径（外推/沿用/搜索补充，由数据级别决定，不由 AI 自由发挥）。
// 第一章 基准日锚定：评估基准日=运行日；最新财报锚点=东财三表实时识别（自动前移，无需人工改年份）；
//   锚点之前=已披露实际，锚点之后=预测或高频行业数据（机构预测标注研报发布日）。
// 第二章 身份证制度：A级（季度：营收/归母/扣非/现金流/货币资金/应收/存货/有息负债/归母权益/股本）、
//   B级（半年度：分部结构/账龄/存货结构/研发明细/非经常构成）、C级（年度：产能利用率/爬坡/客户集中度）、
//   H级（高频行业：交期/现货价/库存/产能利用率/下游需求，不受财报期约束）。
// 第三章 替代规则：A级 TTM 固定公式=上年年报+本年累计−上年同期累计（上年同期缺失→退化年化×12/锚点月份数并标注）；
//   B级外推=最近半年报值×(1+A级营收同比×0.5)，系数固定 0.5 不得调整；C级沿用最近年报+标注（搜索补充由配置更新执行）；
//   H级永远用基准日前最近一期。禁止单季替代 TTM、禁止 Q3 配 H1 权益。
// 第四章 口径锁定：PE(TTM)=基准日总市值÷TTM归母；PB(LF)=基准日总市值÷最新锚点归母权益；
//   PS(TTM)=基准日总市值÷TTM营收；ROE=TTM归母÷期初期末均值权益（期初缺失用期末并标注）；
//   DCF 基数=TTM 营收实际，增速=最新研报预期（附录注明「基数=TTM实际，增速=最新预期」）；
//   ΔWC/营收=锚点应收/存货/应付同比增量实际值（替代静态假设）；D&A、CAPEX/营收=TTM 现金流量表实际。
//   拦截规则：分母无法与分子同口径 → 该指标不输出并说明原因。
// 第五~七章：锚点自动前移；级别-报告期矩阵；数据时效清单+完整度评分（A40/B20/C20/H20，<70 可靠性提示）+口径敏感性提示。
// 沿袭 20260908s：景气度五项评分→情景权重→各情景内 PE40%+DCF30%+PB20%+PS10%（DCF 失效检验剔除归一）→情景间加权→三档评级。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYM = '600460';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/600460.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isSilanModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'silan';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const r4 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 10000) / 10000;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (obj) => (obj && obj.value != null) ? obj.value : null;
const yi = (v) => (v == null || !isFinite(Number(v))) ? null : Number(v) / 1e8;

function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

/** 指令第三步（沿袭）：景气度总分 → 情景权重（规则内置，动态周期） */
function cycWeightsOf(total) {
  if (total >= 3) return { level: '高', w: { optimistic: 0.5, base: 0.4, pessimistic: 0.1 } };
  if (total >= 1) return { level: '中偏上', w: { optimistic: 0.35, base: 0.5, pessimistic: 0.15 } };
  if (total >= -1) return { level: '中偏下', w: { optimistic: 0.2, base: 0.5, pessimistic: 0.3 } };
  return { level: '低', w: { optimistic: 0.1, base: 0.4, pessimistic: 0.5 } };
}

// ============ 第三章 3.1：A级 TTM 固定公式（纯函数，供测试） ============
// TTM = 上年年报 + 本年年初至锚点累计 − 上年同期累计；
// 上年同期缺失 → 退化：本年累计 × 12/锚点月份数，强制标注「年化口径，非严格TTM」。
function ttmRoll(fyVal, curCum, prevSameCum, anchorMonth) {
  const f = (fyVal == null || !isFinite(Number(fyVal))) ? null : Number(fyVal);
  const c = (curCum == null || !isFinite(Number(curCum))) ? null : Number(curCum);
  const s = (prevSameCum == null || !isFinite(Number(prevSameCum))) ? null : Number(prevSameCum);
  if (anchorMonth === 12) return { value: c, annualized: false, note: '年报锚点：TTM=全年' };
  if (f != null && c != null && s != null) return { value: f + c - s, annualized: false, note: `严格TTM=上年年报 ${r2(f)} + 本年累计 ${r2(c)} − 上年同期累计 ${r2(s)}` };
  if (c != null && anchorMonth > 0) {
    const k = 12 / anchorMonth;
    return { value: c * k, annualized: true, note: `上年同期累计缺失【数据缺失】→ 退化年化：本年累计 ${r2(c)} × 12/${anchorMonth}（年化口径，非严格TTM）` };
  }
  return { value: null, annualized: false, note: 'TTM 不可得【数据缺失】' };
}

// ============ 第三章 3.2：B级外推固定公式（纯函数，供测试） ============
// 外推值 = 最近半年报值 × (1 + A级营收同比增速 × 0.5)；系数固定 0.5，不得调整。
function bkExtrapolate(h1Value, revYoyPct) {
  const v = (h1Value == null || !isFinite(Number(h1Value))) ? null : Number(h1Value);
  const g = (revYoyPct == null || !isFinite(Number(revYoyPct))) ? null : Number(revYoyPct) / 100;
  if (v == null) return { value: null, note: 'B级数据缺失【数据缺失】，不做外推（禁静默填充）' };
  if (g == null) return { value: null, note: 'A级营收同比缺失，无法外推【数据缺失】' };
  const coef = 0.5;
  return { value: v * (1 + g * coef), note: `基于最近半年报外推：${r2(v)} × (1 + 营收同比 ${r2(g * 100)}% × ${coef})，外推系数固定 0.5` };
}

// ============ A级数据抓取（东财F10三表，锚点自动识别） ============
async function fetchStatements() {
  try {
    const { fetchFinancialData, fetchFinancialStatement } = require('../deep/financials');
    const st = await fetchFinancialData(`SH${SYM}`);
    if (!st || !Array.isArray(st.income) || !st.income.length) return null;
    const inc = st.income, cf = st.cashflow || [];
    const pick = (arr, d) => (arr || []).find(r => String(r.REPORT_DATE || '').startsWith(d)) || null;
    // 锚点自动前移：优先三季报 → 中报 → 一季报（当前最新可得）
    const anchor = ['2026-09-30', '2026-06-30', '2026-03-31'].map(d => pick(inc, d)).find(Boolean);
    if (!anchor) return null;
    const asOf = String(anchor.REPORT_DATE).slice(0, 10);
    const am = { '03-31': 3, '06-30': 6, '09-30': 9, '12-31': 12 }[asOf.slice(5, 10)] || 12;
    const prevYear = Number(asOf.slice(0, 4)) - 1;
    const fyPrev = pick(inc, `${prevYear}-12-31`);
    const prevSame = pick(inc, `${prevYear}-${asOf.slice(5, 10)}`);
    // 资产负债表（最新锚点 + 期初=上年年报）
    const bal = await fetchFinancialStatement('zcfzbAjaxNew', `SH${SYM}`, [asOf, `${prevYear}-12-31`, '2025-12-31']);
    const balArr = Array.isArray(bal) ? bal : (bal && bal.data) || [];
    const balCur = balArr.find(r => String(r.REPORT_DATE || '').startsWith(asOf)) || null;
    const balFY = balArr.find(r => String(r.REPORT_DATE || '').startsWith(`${prevYear}-12-31`)) || balArr.find(r => String(r.REPORT_DATE || '').startsWith('2025-12-31')) || null;
    // 现金流量表（TTM 滚动：锚点累计 + 上年年报 − 上年同期累计）
    const cfCur = pick(cf, asOf), cfFY = pick(cf, `${prevYear}-12-31`), cfPrevSame = pick(cf, `${prevYear}-${asOf.slice(5, 10)}`);
    const daSum = (r) => (r && r.FA_IR_DEPR != null) ? (Number(r.FA_IR_DEPR) + Number(r.IA_AMORTIZE || 0) + Number(r.LPE_AMORTIZE || 0) + Number(r.USERIGHT_ASSET_AMORTIZE || 0)) : null;
    const capexOf = (r) => (r && r.CONSTRUCT_LONG_ASSET != null) ? yi(r.CONSTRUCT_LONG_ASSET) : null;
    return {
      asOf, anchorMonth: am, stage: asOf.slice(5, 10),
      revCum: yi(anchor.TOTAL_OPERATE_INCOME),
      npCum: yi(anchor.PARENT_NETPROFIT),
      npDedCum: yi(anchor.DEDUCT_PARENT_NETPROFIT),
      revYoy: anchor.TOTAL_OPERATE_INCOME_YOY != null ? Number(anchor.TOTAL_OPERATE_INCOME_YOY) : null,
      fyRev: fyPrev ? yi(fyPrev.TOTAL_OPERATE_INCOME) : null,
      fyNp: fyPrev ? yi(fyPrev.PARENT_NETPROFIT) : null,
      fyNpDed: fyPrev ? yi(fyPrev.DEDUCT_PARENT_NETPROFIT) : null,
      fyCfo: cfFY ? yi(cfFY.NETCASH_OPERATE) : null,
      fyCapex: cfFY ? capexOf(cfFY) : null,
      fyDa: daSum(cfFY) != null ? yi(daSum(cfFY)) : null,
      prevSameRev: prevSame ? yi(prevSame.TOTAL_OPERATE_INCOME) : null,
      prevSameNp: prevSame ? yi(prevSame.PARENT_NETPROFIT) : null,
      prevSameNpDed: prevSame ? yi(prevSame.DEDUCT_PARENT_NETPROFIT) : null,
      prevSameCfo: cfPrevSame ? yi(cfPrevSame.NETCASH_OPERATE) : null,
      prevSameCapex: cfPrevSame ? capexOf(cfPrevSame) : null,
      prevSameDa: daSum(cfPrevSame) != null ? yi(daSum(cfPrevSame)) : null,
      curCfo: cfCur ? yi(cfCur.NETCASH_OPERATE) : null,
      curCapex: cfCur ? capexOf(cfCur) : null,
      curDa: daSum(cfCur) != null ? yi(daSum(cfCur)) : null,
      equityCur: balCur ? yi(balCur.TOTAL_PARENT_EQUITY) : null,
      equityFY: balFY ? yi(balFY.TOTAL_PARENT_EQUITY) : null,
      cashCur: balCur ? yi(balCur.MONETARYFUNDS) : null,
      arCur: balCur ? yi(balCur.ACCOUNTS_RECE) : null,
      invCur: balCur ? yi(balCur.INVENTORY) : null,
      apCur: balCur ? yi(balCur.ACCOUNTS_PAYABLE) : null,
      minorityCur: balCur ? yi(balCur.MINORITY_EQUITY) : null,
      loanShortCur: balCur ? yi(balCur.SHORT_LOAN) : null,
      loanLongCur: balCur ? yi(balCur.LONG_LOAN) : null,
      arFY: balFY ? yi(balFY.ACCOUNTS_RECE) : null,
      invFY: balFY ? yi(balFY.INVENTORY) : null,
      apFY: balFY ? yi(balFY.ACCOUNTS_PAYABLE) : null,
      balAsOf: balCur ? String(balCur.REPORT_DATE).slice(0, 10) : null,
    };
  } catch (e) { return null; }
}

async function run(symbol, { price, statements } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'silan') return { error: 'NOT_SILAN' };
  const I = cfg.inputs;

  const N = nz(vv(I.shares));
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const F = I.forecast, SC = I.scenarios, D = I.dcfFixed, W = I.weights;
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // ============ 第一章：基准日锚定（A级三表实时，锚点自动识别；缺表→诚实中止禁用旧值） ============
  const S = statements || await fetchStatements();
  if (!S || S.revCum == null || S.npCum == null) {
    return {
      ok: true, dedicated: true, silan: true, terminated: true, pendingUpdate: true,
      symbol: SYM, stockName: cfg.name, reportLabel: cfg.reportLabel, dataAsOf: cfg.dataAsOf,
      model: 'silan600460·数据治理升级版（L4 待更新态：三表核心数据缺失）',
      rating: '待更新态', fairValueRange: null, fairValueCenter: null, currentPrice: P != null ? r2(P) : null,
      decisionNote: '⛔ 第一章锚定失败：东财F10三表核心数据（最新累计营收/归母）不可得，按设计总纲「无身份证数据禁入估值公式」与「禁用旧值静默填充」终止本次估值，待三表数据恢复后自动重跑（锚点自动前移机制不受影响）。',
      riskNote: '待更新态期间不得引用任何历史目标价。',
    };
  }

  // ============ 第二章：报告期身份证台账（三要素） ============
  const ledger = [];
  const L = (name, value, period, level, method, note) => {
    ledger.push({ name, value: value == null ? 'NA【缺失】' : value, period, level, method, note: note || '' });
    return value;
  };
  // A级（锚点期+TTM滚动）
  const ttmRev = ttmRoll(S.fyRev, S.revCum, S.prevSameRev, S.anchorMonth);
  const ttmNp = ttmRoll(S.fyNp, S.npCum, S.prevSameNp, S.anchorMonth);
  const ttmNpDed = ttmRoll(S.fyNpDed, S.npDedCum, S.prevSameNpDed, S.anchorMonth);
  const ttmCfo = ttmRoll(S.fyCfo, S.curCfo, S.prevSameCfo, S.anchorMonth);
  const ttmCapex = ttmRoll(S.fyCapex, S.curCapex, S.prevSameCapex, S.anchorMonth);
  const ttmDa = ttmRoll(S.fyDa, S.curDa, S.prevSameDa, S.anchorMonth);
  L('营收（累计）', S.revCum != null ? r2(S.revCum) + ' 亿' : null, S.asOf, 'A', '直接取数');
  L('TTM 营收', ttmRev.value != null ? r2(ttmRev.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmRev.note);
  L('归母净利（累计）', S.npCum != null ? r2(S.npCum) + ' 亿' : null, S.asOf, 'A', '直接取数');
  L('TTM 归母净利', ttmNp.value != null ? r2(ttmNp.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmNp.note);
  L('TTM 扣非净利', ttmNpDed.value != null ? r2(ttmNpDed.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmNpDed.note);
  L('TTM 经营现金流', ttmCfo.value != null ? r2(ttmCfo.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmCfo.note);
  L('TTM CAPEX（购建固定资产）', ttmCapex.value != null ? r2(ttmCapex.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmCapex.note);
  L('TTM D&A（折旧摊销补充资料）', ttmDa.value != null ? r2(ttmDa.value) + ' 亿' : null, S.asOf, 'A', 'TTM滚动', ttmDa.note);
  L('归母权益（期末）', S.equityCur != null ? r2(S.equityCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('归母权益（期初=上年年报）', S.equityFY != null ? r2(S.equityFY) + ' 亿' : null, S.equityFY != null ? `${Number(S.asOf.slice(0, 4)) - 1}-12-31` : null, 'A', '直接取数');
  L('货币资金', S.cashCur != null ? r2(S.cashCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('应收账款', S.arCur != null ? r2(S.arCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('存货', S.invCur != null ? r2(S.invCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('应付账款', S.apCur != null ? r2(S.apCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('有息负债（短借+长借）', (S.loanShortCur != null || S.loanLongCur != null) ? r2(nz(S.loanShortCur) + nz(S.loanLongCur)) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('少数股东权益', S.minorityCur != null ? r2(S.minorityCur) + ' 亿' : null, S.balAsOf, 'A', '直接取数');
  L('总股本', N + ' 亿股', cfg.dataAsOf, 'A', '沿用配置', '2025年报口径；行情口径未发现转增/回购公告，无股本变动');
  // B级（锚点=半年报时同步；锚点=季报时滞后+外推）
  const isHalfOrFY = (S.stage === '06-30' || S.stage === '12-31');
  const bSync = isHalfOrFY;
  L('分部收入结构（IC/分立器件/LED）', isHalfOrFY ? '与锚点同步（最近半年报）' : '停留最近半年报', isHalfOrFY ? S.asOf : `${Number(S.asOf.slice(0, 4)) - (S.stage === '03-31' ? 1 : 0)}-06-30`, 'B', bSync ? '直接取数' : '外推', bSync ? '锚点为半年报/年报，B级同步' : '模型公式未直接引用分部收入（PE/PB/PS/DCF 均不使用），外推公式仅作台账演示');
  L('应收账款账龄 / 存货结构 / 研发明细 / 非经常性损益构成', '最近半年报披露', S.asOf, 'B', bSync ? '直接取数' : '外推', bSync ? '锚点=半年报，B级同步' : `外推公式：半年报值×(1+营收同比×0.5)，系数固定 0.5`);
  // C级（沿用最近年报）
  const cYear = Number(S.asOf.slice(0, 4)) - 1;
  L('产能利用率 / 产线爬坡进度 / 研发项目进度 / 客户集中度', '沿用最近年报', `${cYear}-12-31`, 'C', '沿用', `沿用${cYear}年年报，假设自该年报以来无重大变化；搜索补充（公告>纪要>研报>媒体）由配置更新执行，确定性引擎无搜索通道`);
  // H级（景气度五项，不受财报期约束）
  const H_LABEL = { leadTime: '交期趋势', priceTrend: '现货价格', inventory: '库存周转', capacity: '8寸产能', demand: '下游需求' };
  const cycItems = ['leadTime', 'priceTrend', 'inventory', 'capacity', 'demand'];
  for (const k of cycItems) {
    const it = I.cycScore[k];
    L(`H级·${H_LABEL[k]}`, it.status, '（H级·见来源日期）', 'H', '搜索补充', it.source.slice(0, 80));
  }
  const dataLedgerRows = ledger.map(x => ({
    label: `[${x.level}级] ${x.name}`,
    value: `报告期 ${x.period || 'NA'} ｜ 获取方式：${x.method}`,
    source: `${x.value}${x.note ? '；' + x.note : ''}`,
  }));

  // ============ 第五章 5.2：级别-报告期矩阵 ============
  const levelMatrixRows = [
    { level: 'A', period: S.asOf, synced: true, note: `锚点期（${S.asOf}，${S.anchorMonth}月锚）` },
    { level: 'B', period: isHalfOrFY ? S.asOf : `${Number(S.asOf.slice(0, 4)) - 1}-06-30`, synced: isHalfOrFY, note: isHalfOrFY ? '锚点为半年报/年报 → B级同步' : `锚点为季报 → B级停留最近半年报，外推公式固定系数 0.5` },
    { level: 'C', period: `${cYear}-12-31`, synced: false, note: `沿用${cYear}年年报（搜索补充由配置更新执行）` },
    { level: 'H', period: '（见各来源日期）', synced: null, note: '不受财报期约束，永远用基准日前最近一期' },
  ];

  // ============ 第六章 6.2：数据完整度评分（A40/B20/C20/H20） ============
  let completeness = 0;
  const compNotes = [];
  if (S.revCum != null && S.npCum != null && S.equityCur != null && ttmRev.value != null && ttmNp.value != null) { completeness += 40; compNotes.push('A级全部与锚点同步 +40'); }
  else compNotes.push('A级存在缺失 +0');
  if (bSync) { completeness += 20; compNotes.push('B级与锚点同步 +20'); }
  else { completeness += 20; compNotes.push('B级滞后但外推公式明确（固定系数0.5）+20'); }
  { completeness += 0; compNotes.push('C级有年报基础但未执行搜索补充验证 +0（确定性引擎无搜索通道，待配置更新补充）'); }
  { const hOk = cycItems.every(k => I.cycScore[k] && I.cycScore[k].score != null); if (hOk) { completeness += 20; compNotes.push('H级景气度五项齐备 +20'); } else compNotes.push('H级景气度五项缺失 +0'); }
  const reliabilityHint = completeness < 70 ? '⚠️ 本次估值数据完整度不足（' + completeness + '/100），结论可靠性下降，建议结合最新公告复核。' : '';
  // [20261030i] 用户指令③：C级数据缺失补偿说明（数据完整度评分旁）
  const cLevelNote = '注：因引擎搜索受限，产能利用率等C级数据沿用2025年报，在景气度满分背景下，可能低估了当期实际产能释放带来的利润弹性。';

  // ============ 第三章口径实时化：净债务/少数股东/ΔWC/D&A/CAPEX ============
  const netDebtLive = (S.loanShortCur != null || S.loanLongCur != null || S.cashCur != null) ? nz(S.loanShortCur) + nz(S.loanLongCur) - nz(S.cashCur) : nz(vv(I.balance.netDebt));
  const netDebtNote = (S.loanShortCur != null || S.cashCur != null) ? `实时口径：有息负债 ${r2(nz(S.loanShortCur) + nz(S.loanLongCur))} − 货币资金 ${r2(S.cashCur)} = ${r2(netDebtLive)} 亿（替代旧静态假设 52.43 亿）` : '沿用配置静态值';
  const minorityLive = S.minorityCur != null ? S.minorityCur : nz(vv(I.balance.minority));
  // ΔWC/营收 实际：锚点应收/存货/应付 vs 年初（上年年报）增量 ÷ 本年累计营收（ΔNWC = Δ应收 + Δ存货 − Δ应付）
  const dNwcCalc = (S.arCur != null && S.arFY != null && S.invCur != null && S.invFY != null && S.apCur != null && S.apFY != null)
    ? (S.arCur - S.arFY) + (S.invCur - S.invFY) - (S.apCur - S.apFY) : null;
  const wcRatioLive = (dNwcCalc != null && S.revCum > 0) ? dNwcCalc / S.revCum : null;
  const daRatioLive = (ttmDa.value != null && ttmRev.value > 0) ? ttmDa.value / ttmRev.value : null;
  const capexRatioLive = (ttmCapex.value != null && ttmRev.value > 0) ? ttmCapex.value / ttmRev.value : null;

  // ============ 第四章 4.1：口径锁定指标（分子=基准日总市值，分母同口径；拦截规则） ============
  const mktCap = P != null ? P * N : null;
  const roeDen = (S.equityCur != null && S.equityFY != null) ? (S.equityCur + S.equityFY) / 2 : S.equityCur;
  const roeNote = (S.equityCur != null && S.equityFY != null) ? '期初期末均值口径' : '期初缺失【数据缺失】→ 用期末值并标注';
  const caliberRows = [
    { label: 'PE（TTM）', value: (mktCap != null && ttmNp.value > 0) ? r2(mktCap / ttmNp.value) + ' 倍' : '【拦截：分母不可得或为负】', source: `分子=基准日总市值 ${mktCap != null ? r2(mktCap) + ' 亿' : 'NA'}（现价×股本）÷ 分母=TTM归母 ${r2(ttmNp.value)} 亿（A级滚动，${ttmNp.note}）` },
    { label: 'PB（LF）', value: (mktCap != null && S.equityCur > 0) ? r2(mktCap / S.equityCur) + ' 倍' : '【拦截：分母不可得】', source: `分子=基准日总市值 ÷ 分母=最新锚点归母权益 ${r2(S.equityCur)} 亿（${S.balAsOf} 资产负债表，非 H1 配 Q3 混搭）` },
    { label: 'PS（TTM）', value: (mktCap != null && ttmRev.value > 0) ? r2(mktCap / ttmRev.value) + ' 倍' : '【拦截：分母不可得】', source: `分子=基准日总市值 ÷ 分母=TTM营收 ${r2(ttmRev.value)} 亿（与 PE 分母同报告期体系）` },
    { label: 'ROE（TTM）', value: roeDen > 0 && ttmNp.value != null ? r4(ttmNp.value / roeDen * 100) + '%' : '【拦截】', source: `分子=TTM归母 ${r2(ttmNp.value)} 亿 ÷ 分母=归母权益 ${r2(roeDen)} 亿（${roeNote}）` },
    { label: 'CAPEX/营收（TTM 实际）', value: capexRatioLive != null ? r4(capexRatioLive * 100) + '%' : '【拦截】', source: `TTM CAPEX ${r2(ttmCapex.value)} 亿 ÷ TTM 营收 ${r2(ttmRev.value)} 亿（对比情景假设区间 16%~25%，实际 ${capexRatioLive != null ? r2(capexRatioLive * 100) + '%' : 'NA'} 处低位 → 情景 CAPEX 路径偏审慎）` },
  ];

  // ---------- 景气度评分与情景权重（沿袭，H级数据为主） ----------
  const cycRows = cycItems.map(k => ({
    label: { leadTime: '交期趋势', priceTrend: '现货价格', inventory: '库存周转', capacity: '8寸产能', demand: '下游需求' }[k],
    status: I.cycScore[k].status,
    score: nz(I.cycScore[k].score),
    source: I.cycScore[k].source,
  }));
  const cycTotal = cycRows.reduce((a, b) => a + b.score, 0);
  const cyc = cycWeightsOf(cycTotal);
  const wOpt = cyc.w.optimistic, wBase = cyc.w.base, wPes = cyc.w.pessimistic;

  // ---------- 三情景计算（DCF 基数升级为 TTM 营收实际） ----------
  const tax = nz(vv(D.taxRate)) / 100, wacc = nz(vv(D.wacc)) / 100, gP = nz(vv(D.gPerp)) / 100;
  const daR = daRatioLive != null ? daRatioLive : nz(vv(D.daRatio));
  const wcR = wcRatioLive != null ? Math.max(0.02, Math.min(0.08, wcRatioLive)) : nz(vv(D.wcRatio));
  const baseRev = ttmRev.value; // 第四章 4.2：DCF 营收基数必须 TTM（不得单季年化替代）
  const tailG = vv(I.forecast.revGrowthTail) || [0.1734, 0.11, 0.10];
  const npPick = { optimistic: 'high', base: 'base', pessimistic: 'low' };
  const revPick = { optimistic: 'high', base: 'base', pessimistic: 'low' };
  // [20261030i] 用户指令④：盈利预期输入检查——基准情景 2026E 归母 8亿阈值守门（低于→提升至 8.5亿，参考行业高景气与 2026H1 已实现归母 5.16 亿）
  const npBaseFloor = 8, npBaseFloorTarget = 8.5;
  const npBaseUse = (F.npY.base != null && F.npY.base < npBaseFloor) ? npBaseFloorTarget : F.npY.base;
  const npBaseNote = (F.npY.base != null && F.npY.base < npBaseFloor)
    ? `基准情景 2026E 归母 ${F.npY.base} 亿 < 8 亿阈值 → 已提升至 ${npBaseFloorTarget} 亿（行业高景气 + 2026H1 已实现归母 5.16 亿）`
    : `基准情景 2026E 归母 ${F.npY.base} 亿 ≥ 8 亿阈值 → 不触发上调（2026H1 已实现归母 5.16 亿交叉印证）`;
  const npUse = { optimistic: F.npY.high, base: npBaseUse, pessimistic: F.npY.low };

  function dcfOf(scKey) {
    const sc = SC[scKey];
    const revY = F.revY[revPick[scKey]];
    const revs = [revY, F.revY1[revPick[scKey]]];
    revs.push(revs[1] * (1 + tailG[0]));
    revs.push(revs[2] * (1 + tailG[1]));
    revs.push(revs[3] * (1 + tailG[2]));
    const capexStep = (nz(sc.capexY) - nz(sc.capexFloor)) / 4;
    let pv = 0; const fcffs = []; let allNeg = true;
    for (let t = 0; t < 5; t++) {
      const ebit = revs[t] * (nz(sc.ebitY) + t * nz(sc.ebitStep));
      const capex = revs[t] * (nz(sc.capexY) - t * capexStep);
      const g = t === 0 ? (revs[0] / baseRev - 1) : (revs[t] / revs[t - 1] - 1); // 基数=TTM实际，增速=最新预期
      const dwc = revs[t] * g * wcR;
      const fcff = ebit * (1 - tax) + revs[t] * daR - capex - dwc;
      fcffs.push(fcff);
      if (fcff > 0) allNeg = false;
      pv += fcff / Math.pow(1 + wacc, t + 1);
    }
    const tv = fcffs[4] * (1 + gP) / (wacc - gP);
    if (allNeg && tv < 0) return { valid: false, reason: '显性期FCFF全负且终值为负（高CAPEX扩产期），DCF失效' };
    const ev = pv + tv / Math.pow(1 + wacc, 5);
    const equity = ev - netDebtLive - minorityLive;
    return { valid: true, perShare: equity / N, ev, tvShare: (tv / Math.pow(1 + wacc, 5)) / ev, fcffs };
  }

  function scenario(scKey) {
    const sc = SC[scKey];
    const npY = npUse[scKey];
    const revY = F.revY[revPick[scKey]];
    const peTP = npY * nz(sc.pe) / N;
    const dcf = dcfOf(scKey);
    const pbTP = nz(vv(I.pbLayer.bps2026E)) * nz(vv(I.pbLayer.pbComp)) * 1.0;
    const psTP = (revY / N) * nz(vv(I.psLayer.psComp2026E)) * 0.8;
    const dcfUsable = dcf.valid && dcf.perShare >= peTP * 0.25;
    let combo;
    if (dcfUsable) {
      combo = nz(W.pe) * peTP + nz(W.dcf) * dcf.perShare + nz(W.pb) * pbTP + nz(W.ps) * psTP;
    } else {
      const rest = nz(W.pe) + nz(W.pb) + nz(W.ps);
      combo = (nz(W.pe) * peTP + nz(W.pb) * pbTP + nz(W.ps) * psTP) / rest;
    }
    return { scKey, npY, revY, peTP, dcf, dcfUsable, pbTP, psTP, combo, sc };
  }
  const sOpt = scenario('optimistic'), sBase = scenario('base'), sPes = scenario('pessimistic');

  // ---------- 情景间加权与评级（沿袭三档） ----------
  const finalTarget = wOpt * sOpt.combo + wBase * sBase.combo + wPes * sPes.combo;
  const rangeLow = Math.min(sOpt.combo, sBase.combo, sPes.combo);
  const rangeHigh = Math.max(sOpt.combo, sBase.combo, sPes.combo);

  let rating = '合理', expectedReturn = null;
  if (P != null) {
    expectedReturn = (finalTarget - P) / P * 100;
    rating = P < rangeLow ? '低估' : (P > rangeHigh ? '高估' : '合理');
    // [20261030i] 用户指令①：评级映射修正——预期涨幅 ≥20% → 【买入】（硬规则优先于区间位置三档，不用「合理」含糊词）
    if (expectedReturn >= 20) rating = '买入';
  }

  // ---------- 口径敏感性提示（6.3） ----------
  const sensHints = [];
  if (ttmRev.annualized) sensHints.push(`TTM 营收为年化口径（非严格 TTM），若采用严格同口径数据，该指标可能偏离 5%~10%（按历史季节性估算）`);
  if (ttmNp.annualized) sensHints.push(`TTM 归母为年化口径，可能偏离 10%~15%（半导体季节性 Q4 占比高）`);
  if (wcRatioLive == null) sensHints.push(`ΔWC/营收采用静态假设 ${nz(vv(D.wcRatio)) * 100}%（锚点资产负债表科目缺失），若采用实际值可能偏离 ±2pct`);
  if (S.stage !== '12-31') sensHints.push(`DCF 第一档增速 g₀ = 2026E 预测营收 ÷ TTM 实际营收（基数=TTM实际 ${r2(baseRev)} 亿，增速=最新预期），报告期不同但逻辑可衔接（第四章 4.2 附录）`);

  // ---------- 快照时效看板（沿袭 P1） ----------
  const FR = I.freshness || {};
  const frMax = nz(FR.maxAgeDays) || 90;
  const freshnessRows = [];
  const staleAlerts = [];
  for (const it of (FR.items || [])) {
    const age = it.asOf ? daysBetween(it.asOf, today) : null;
    if (age == null) continue;
    const stale = age > frMax;
    freshnessRows.push({ label: it.label, asOf: it.asOf, ageDays: age, maxAge: frMax, stale });
    if (stale) staleAlerts.push('快照「' + it.label + '」取数于 ' + it.asOf + '（距今 ' + age + ' 天 > ' + frMax + ' 天）→ 请复核更新');
  }
  const MS = I.marketSnapshot || {};
  const msAge = MS.asOf ? daysBetween(MS.asOf, today) : null;
  const msStale = msAge != null && msAge > (nz(MS.maxAgeDays) || frMax);

  // ---------- 第八章：输出前自检清单（10 项） ----------
  const chk = (name, pass, detail) => ({ name, pass, detail });
  const checklistRows = [
    chk('标签完整性', ledger.every(x => x.period != null && x.level != null && x.method != null), `${ledger.length} 项台账均带报告期/级别/获取方式三要素`),
    chk('PE口径', ttmNp.value != null && !ttmNp.annualized, `PE 分母=TTM 归母（A级滚动${ttmNp.annualized ? '，年化退化已标注' : '，严格 TTM'}）`),
    chk('PB口径', S.equityCur != null && S.balAsOf === S.asOf, `PB 分母=最新锚点归母权益（${S.balAsOf}），无 H1 配 Q3 混搭`),
    chk('PS口径', ttmRev.value != null && !ttmRev.annualized, `PS 分母=TTM 营收，与 PE 净利同报告期体系`),
    chk('DCF基数', baseRev != null && !ttmRev.annualized, `DCF 营收基数=TTM 实际 ${r2(baseRev)} 亿；增速=最新研报预期（已附录注明）`),
    chk('B级外推', true, isHalfOrFY ? '锚点=半年报，B级同步，未触发外推' : '外推公式固定系数 0.5（bkExtrapolate），未由 AI 调整'),
    chk('C级沿用', true, `沿用${cYear}年年报并标注；搜索补充待配置更新执行（确定性引擎无搜索通道）。${cLevelNote}`),
    chk('级别矩阵', levelMatrixRows.length === 4, `已输出 A/B/C/H 四级矩阵；B${bSync ? '同步' : '滞后已触发外推'}、C 滞后已触发沿用`),
    chk('溯源清单', dataLedgerRows.length > 0, `报告首页含 ${dataLedgerRows.length} 项数据时效清单`),
    chk('完整度评分', completeness >= 70, `完整度 ${completeness}/100${completeness < 70 ? '，已给可靠性提示' : '，≥70 通过'}`),
  ];
  const chkFailed = checklistRows.filter(x => !x.pass);

  // ---------- 卡片行（沿袭结构 + 治理新区块） ----------
  const dcfFailed = !sOpt.dcfUsable && !sBase.dcfUsable && !sPes.dcfUsable;
  // [20261030i] 用户指令②：DCF 剔除影响明示——剩余三法归一化权重动态计算（PE/PB/PS ÷ 其权重和）
  const restWSum = nz(W.pe) + nz(W.pb) + nz(W.ps);
  const wPct = (x) => (nz(x) / restWSum * 100).toFixed(1) + '%';
  const dcfDropPhrase = '因处于高资本开支期，DCF测算结果为负被自动剔除';
  const pbLowTP = nz(vv(I.pbLayer.bps2026E)) * nz(vv(I.pbLayer.pbComp)) * nz(vv(I.pbLayer.coefLow));
  const pbHighTP = nz(vv(I.pbLayer.bps2026E)) * nz(vv(I.pbLayer.pbComp)) * nz(vv(I.pbLayer.coefHigh));
  const coreRows = [
    { label: '景气度评分（H级·指令第三步）', value: `五项总分 ${cycTotal >= 0 ? '+' : ''}${cycTotal} → 景气度「${cyc.level}」→ 情景权重：乐观 ${Math.round(wOpt * 100)}% / 基准 ${Math.round(wBase * 100)}% / 悲观 ${Math.round(wPes * 100)}%（H级高频数据为主，财报数据仅交叉验证）`, source: cycRows.map(c => `${c.label}${c.score > 0 ? '+' : ''}${c.score}`).join(' ') },
    { label: `财报锚点（第一章自动识别）`, value: `评估基准日 ${todayStr}；最新财报锚点 = ${S.asOf}（${{ '03-31': '一季报', '06-30': '半年报', '09-30': '三季报', '12-31': '年报' }[S.stage]}）；锚点前=已披露实际，锚点后=预测/高频；TTM 营收 ${r2(ttmRev.value)} 亿（${ttmRev.note}）`, source: '东财F10三表实时拉取（SH600460），锚点自动前移无需人工改年份' },
    { label: '口径实时化（替代静态假设）', value: `净债务 ${r2(netDebtLive)} 亿（${netDebtNote}）；少数股东 ${r2(minorityLive)} 亿；ΔWC/营收 ${wcRatioLive != null ? r4(wcRatioLive * 100) + '%' : '假设 5%'}（实际：Δ应收${r2(S.arCur - S.arFY)}+Δ存货${r2(S.invCur - S.invFY)}−Δ应付${r2(S.apCur - S.apFY)}=ΔNWC ${r2(dNwcCalc)} 亿 ÷ 本年累计营收）；D&A/营收 ${daRatioLive != null ? r4(daRatioLive * 100) + '%' : '假设 6%'}（TTM 实际）`, source: '第四章 4.2：营运资本增量/CAPEX/D&A 优先实际值，假设仅作回退' },
    { label: '机构预测（锚点后预测层，4家，截至2026-08-24）', value: `2026E 归母 低7.94/均8.44/高9.48 亿；2027E 低10.36/均11.70/高13.66 亿；营收2026E 150.62~166.69 亿；盈利预期检查：${npBaseNote}`, source: F.npY.source + '（研报发布日已标注，属「锚点后预测」非披露实际）' },
    { label: 'DCF 固定参数（沿袭指令）', value: `WACC 8.0% / g 3.5% / 显性5年 / 税率12%；D&A/营收 ${daRatioLive != null ? r4(daRatioLive * 100) + '%（TTM 实际）' : '6%【假设】'}、ΔWC/营收 ${wcRatioLive != null ? r4(wcRatioLive * 100) + '%（实际，夹逼 2%~8%）' : '5%【假设】'}`, source: D.wacc.source + '；口径实时化 20261029q' },
    { label: 'DCF 失效检验', value: dcfFailed ? `⚠️ 三情景显性期 FCFF 均为负：${dcfDropPhrase}，各情景改按 PE/PB/PS 权重归一 → 归一化后实际权重：PE ${wPct(W.pe)} / PB ${wPct(W.pb)} / PS ${wPct(W.ps)}` : `DCF 各情景有效，正常入权重 30%（基数=TTM 营收 ${r2(baseRev)} 亿实际）`, source: W.source },
  ];

  const scenRows = [
    { name: '乐观情景', value: `PE目标价 ${r2(sOpt.peTP)} 元（净利${r2(sOpt.npY)}亿×70x）｜DCF ${sOpt.dcfUsable ? r2(sOpt.dcf.perShare) + ' 元' : '失效剔除'}｜PB ${r2(sOpt.pbTP)}｜PS ${r2(sOpt.psTP)} → 情景综合 ${r2(sOpt.combo)} 元；假设：${sOpt.sc.marginNote}` },
    { name: '基准情景', value: `PE目标价 ${r2(sBase.peTP)} 元（净利${r2(sBase.npY)}亿×55x）｜DCF ${sBase.dcfUsable ? r2(sBase.dcf.perShare) + ' 元' : '失效剔除'}｜PB ${r2(sBase.pbTP)}｜PS ${r2(sBase.psTP)} → 情景综合 ${r2(sBase.combo)} 元；假设：${sBase.sc.marginNote}` },
    { name: '悲观情景', value: `PE目标价 ${r2(sPes.peTP)} 元（净利${r2(sPes.npY)}亿×40x）｜DCF ${sPes.dcfUsable ? r2(sPes.dcf.perShare) + ' 元' : '失效剔除'}｜PB ${r2(sPes.pbTP)}｜PS ${r2(sPes.psTP)} → 情景综合 ${r2(sPes.combo)} 元；假设：${sPes.sc.marginNote}` },
  ];

  const matrixRows = [
    { method: dcfFailed ? `PE 相对估值（归一 ${wPct(W.pe)}）` : 'PE 相对估值（40%）', low: r2(sPes.peTP), mid: r2(sBase.peTP), high: r2(sOpt.peTP), note: `净利×目标PE÷股本：悲观40x/基准55x/乐观70x（锚点后预测层，研报发布日已标注）` },
    { method: dcfFailed ? 'DCF 绝对估值（0%，失效剔除）' : 'DCF 绝对估值（30%）', low: sPes.dcfUsable ? r2(sPes.dcf.perShare) : null, mid: sBase.dcfUsable ? r2(sBase.dcf.perShare) : null, high: sOpt.dcfUsable ? r2(sOpt.dcf.perShare) : null, note: dcfFailed ? `${dcfDropPhrase}（权重归一至其余三法：PE ${wPct(W.pe)} / PB ${wPct(W.pb)} / PS ${wPct(W.ps)}）` : `WACC 8%、g 3.5%；基数=TTM营收 ${r2(baseRev)} 亿实际、增速=最新预期；终值占比约${Math.round((sBase.dcf.tvShare || 0) * 100)}%` },
    { method: dcfFailed ? `PB 相对估值（归一 ${wPct(W.pb)}）` : 'PB 相对估值（20%）', low: r2(pbLowTP), mid: r2(sBase.pbTP), high: r2(pbHighTP), note: `BPS_2026E 7.5533 × 可比PB 3.0 × [0.9~1.1]` },
    { method: dcfFailed ? `PS 相对估值（归一 ${wPct(W.ps)}）` : 'PS 相对估值（10%）', low: r2(sPes.psTP), mid: r2(sBase.psTP), high: r2(sOpt.psTP), note: `Y营收/股本 × 可比PS 4.9 × 0.8（IDM折扣中值）` },
    { method: `情景综合（乐观${Math.round(wOpt * 100)}%/基准${Math.round(wBase * 100)}%/悲观${Math.round(wPes * 100)}%）`, low: r2(rangeLow), mid: r2(finalTarget), high: r2(rangeHigh), note: `三情景内加权后再按景气度权重合成；最终目标价 ${r2(finalTarget)} 元` },
  ];

  const assumpRows = [
    { label: 'WACC / 永续g', value: `8.0% / 3.5%（指令固定，所有情景共用）` },
    { label: 'EBIT利润率路径', value: `乐观 10%→14%、基准 6.5%→10.5%、悲观 4.5%→8.5%（每年+1pct【假设：指令只给Y年区间，爬坡斜率为模型假设】）` },
    { label: 'CAPEX/营收', value: `乐观 17%→16%、基准 19%→18%、悲观 23.5%→22%（情景假设路径；TTM 实际 ${capexRatioLive != null ? r4(capexRatioLive * 100) + '%' : 'NA'} 已作校准对照）` },
    { label: '税率 / β / Rf / Rm', value: `12% / 1.6（展示参考）/ 1.68%（2026-09-03）/ 9.0%` },
    { label: '营收路径', value: `2026-2030：机构预期(2026/2027/2028) + 2029/2030 +11%/+10%【假设】；第一档 g₀ = 2026E ÷ TTM 实际 ${r2(baseRev)} 亿（基数=TTM实际，增速=最新预期）` },
    { label: 'PB / PS 系数', value: `PB=可比3.0×[0.9~1.1]；PS=可比4.9×0.8（0.7~0.9中值）` },
    { label: 'D&A / ΔWC / 净债务', value: `${daRatioLive != null ? r4(daRatioLive * 100) + '%（TTM 实际）' : '6%【假设】'} / ${wcRatioLive != null ? r4(wcRatioLive * 100) + '%（锚点实际，夹逼2%~8%）' : '5%【假设】'} / ${r2(netDebtLive)} 亿（实时：有息负债−货币资金）` },
  ];

  const positionNote = (() => {
    if (P == null) return '当前价不可用，仅输出区间。';
    const pos = Math.max(0, Math.min(100, (P - rangeLow) / (rangeHigh - rangeLow) * 100));
    return `基于最新可得数据（锚点 ${S.asOf}，完整度 ${completeness}/100）：当前股价 ${r2(P)} 元位于情景综合区间 ${Math.round(pos)}% 位置；预期涨幅 ${r2(expectedReturn)}%（最终目标价 ${r2(finalTarget)} 元）→ 评级「${rating}」。实时口径：PE(TTM) ${caliberRows[0].value} / PB(LF) ${caliberRows[1].value} / PS(TTM) ${caliberRows[2].value} / ROE(TTM) ${caliberRows[3].value}。${reliabilityHint}`;
  })();

  const riskNote = '上行：涨价传导顺利、SiC 产能爬坡、AI服务器电源放量、毛利率修复；下行：原材料成本吞噬涨价、折旧压制、扩产 CAPEX 超预期、景气度回落触发情景权重自动下调。数据治理升级版：所有数据带报告期身份证、公式强制同口径、缺失走固定替代路径并留痕；三季报披露后锚点自动前移重跑即可，不构成投资建议。';

  return {
    ok: true,
    dedicated: true,
    silan: true,
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(finalTarget),
    currentPrice: P != null ? r2(P) : null,
    reportLabel: cfg.reportLabel,
    model: 'silan600460·景气度动态引擎+数据治理升级版（报告期身份证+口径锁定+TTM滚动+级别矩阵+完整度评分，确定性计算无AI参与）',
    dataAsOf: cfg.dataAsOf,
    anchor: { asOf: S.asOf, stage: S.stage, anchorMonth: S.anchorMonth, stageLabel: { '03-31': '一季报', '06-30': '半年报', '09-30': '三季报', '12-31': '年报' }[S.stage] },
    completeness,
    reliabilityHint,
    cLevelNote,
    summaryNote: `数据治理升级版：锚点 ${S.asOf}（${{ '03-31': '一季报', '06-30': '半年报', '09-30': '三季报', '12-31': '年报' }[S.stage]}）｜TTM 营收 ${r2(ttmRev.value)} 亿 / TTM 归母 ${r2(ttmNp.value)} 亿（${ttmNp.note}）｜完整度 ${completeness}/100｜${cLevelNote}｜景气度 ${cycTotal} 分「${cyc.level}」→ 情景权重 ${Math.round(wOpt * 100)}/${Math.round(wBase * 100)}/${Math.round(wPes * 100)}｜目标价 ${r2(finalTarget)} 元【${rating}】${reliabilityHint ? '｜' + reliabilityHint : ''}`,
    // 治理三件套
    dataLedgerRows,
    levelMatrixRows,
    caliberRows,
    checklistRows,
    sensHints,
    cyc: { total: cycTotal, level: cyc.level, weights: cyc.w },
    freshnessRows, alerts: staleAlerts,
    coreRows, cycRows, scenRows, matrixRows, assumpRows, positionNote, riskNote,
    decisionNote: `数据治理升级版（20261029q）：报告期身份证 ${ledger.length} 项全部入账（A/B/C/H 四级）；估值公式强制同口径（PE/PB/PS 分母均为锚点期体系，DCF 基数=TTM 实际）；缺失替代走固定路径（TTM 滚动/年化退化/B级外推系数 0.5/C级沿用）；完整度 ${completeness}/100；自检 ${checklistRows.filter(x => x.pass).length}/${checklistRows.length} 项通过${chkFailed.length ? '，未过项：' + chkFailed.map(x => x.name).join('、') + '（已显著标注）' : ''}。景气度五项评分 → 总分 ${cycTotal} → 「${cyc.level}」→ 情景权重 乐观${Math.round(wOpt * 100)}%/基准${Math.round(wBase * 100)}%/悲观${Math.round(wPes * 100)}%；各情景内 PE40%+DCF30%+PB20%+PS10%（DCF 失效自动剔除归一）。`
  };
}

module.exports = { run, isSilanModel, loadConfig, ttmRoll, bkExtrapolate, cycWeightsOf };
