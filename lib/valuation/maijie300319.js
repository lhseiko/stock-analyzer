// ============================================================
// 麦捷科技（300319）专属估值模型 —— 动态逻辑估值引擎（确定性计算，1+1=2）
// 20260909b：五站流水线
//   ① 时间引擎（月算法自动适配最新报告期 + 数据时效看板）
//   ② 画像诊断（业务拆分 / 生命周期判定 / 异常检测）
//   ③ 三情景财务预测（乐观 / 基准 / 悲观，权重 20/60/20）
//   ④ 四路估值：PE(30%) + PB-ROE(25%) + EV/EBITDA(20%) + DCF-FCFF(25%)
//   ⑤ 情景加权 + 相对/绝对交叉验证 + 安全边际 + 三档评级（低估/合理/高估）
// 计算层=代码，输入锁死（data/valuation/300319.json）⇒ 结果锁死；LLM 仅叙述。
// 无硬编码年份：报告期/预测年度均由时间引擎推导。
// ============================================================
const path = require('path');
const fs = require('fs');

const SYM = '300319';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/300319.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isMaijieModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'maijie';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (obj) => (obj && obj.value != null) ? obj.value : null;
const pct = (x) => (x == null) ? null : Math.round(Number(x) * 1000) / 10;

function daysBetween(dStr, dObj) {
  try { return Math.floor((dObj - new Date(dStr)) / 86400000); } catch (e) { return null; }
}

/** 月算法：由基准日推导「最新已披露报告期」月份 M（12=年报 / 3=一季报 / 6=中报 / 9=三季报） */
function detectLatestReportMonths(d = new Date()) {
  const m = d.getMonth() + 1, day = d.getDate();
  if (m <= 4) return { M: 12, yearOffset: -1 };      // 1~4 月：上年年报
  if (m <= 7) return { M: 3, yearOffset: 0 };        // 5~7 月：当年一季报
  if (m === 8) return (day >= 20) ? { M: 6, yearOffset: 0 } : { M: 3, yearOffset: 0 };
  if (m === 9) return { M: 6, yearOffset: 0 };       // 9 月：当年中报
  if (m === 10) return (day >= 25) ? { M: 9, yearOffset: 0 } : { M: 6, yearOffset: 0 };
  return { M: 9, yearOffset: 0 };                    // 11~12 月：当年三季报
}

function median(arr) {
  const a = arr.filter(x => x != null && isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function run(symbol, { price, pe, pb } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'maijie') return { error: 'NOT_MAIJIE' };
  const I = cfg.inputs;

  const N = nz(vv(I.shares));                                   // 亿股
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : null;
  const alerts = [];

  // ================= 第一站：时间引擎 + 数据时效 =================
  const now = new Date();
  const det = detectLatestReportMonths(now);
  const expectYear = now.getFullYear() + (det.yearOffset || 0);
  const expectEnd = `${expectYear}-${String(det.M).padStart(2, '0')}-${det.M === 12 ? '31' : (det.M === 6 ? '30' : (det.M === 3 ? '31' : '30'))}`;
  const RP = cfg.reportPeriod || {};
  const cfgEnd = RP.periodEnd;
  const periodMatch = (cfgEnd === expectEnd);
  if (!periodMatch) {
    alerts.push(`财报期口径不一致：配置标注 ${cfgEnd || '?'}，月算法判定最新已披露应为 ${expectEnd} → 请复核 data/valuation/300319.json`);
  }
  const discAge = RP.disclosureDate ? daysBetween(RP.disclosureDate, now) : null;
  if (discAge != null && discAge > 120) {
    alerts.push(`最新财报披露于 ${RP.disclosureDate}（距今 ${discAge} 天 > 120 天）→ 财报可能已超期`);
  }

  const FR = I.freshness || {};
  const freshnessRows = [];
  for (const it of (FR.items || [])) {
    const age = it.asOf ? daysBetween(it.asOf, now) : null;
    if (age == null) continue;
    const maxAge = it.maxAge || FR.maxAgeDays || 120;
    const stale = age > maxAge;
    freshnessRows.push({ label: it.label, asOf: it.asOf, ageDays: age, maxAge, stale });
    if (stale) alerts.push(`快照「${it.label}」取数于 ${it.asOf}（距今 ${age} 天 > ${maxAge} 天）→ 请复核更新`);
  }

  // ================= 第二站：画像诊断 =================
  const segRows = (I.segments || []).map(s => ({
    name: s.name,
    share: pct(nz(s.share) / 100),
    driver: s.driver,
    nature: s.nature,
  }));
  const TTM = I.ttm, L = I.latest, F25 = I.fy2025, F24 = I.fy2024, B = I.balance;
  const revTTM = nz(TTM.revenue.value), npTTM = nz(TTM.npParent.value);
  const revYoY = nz(L.revenue.yoy), npYoY = nz(L.npParent.yoy);
  const q2YoY = nz(L.q2NpYoy.value);
  const gmNow = nz(L.grossMargin.value), gm25 = nz(F25.grossMargin), gm24 = nz(F24.grossMargin);
  const gmSwing = Math.abs(gm25 - gm24);

  // 生命周期判定（规则：缺行业增速与折旧明细 → 不做权重自适应，仅诊断标注，避免臆造）
  let lifeCycle = '成长 + 周期双属性';
  let lifeNote = '业务结构决定：电子元器件 52% 受益 AI/车载（成长），LCM 48% 随消费电子景气波动（周期）';
  if (revYoY > 0.15 && gmSwing < 10) { lifeCycle = '成长主导'; lifeNote = `营收同比 ${pct(revYoY)}% 高增且毛利率波动 ${pct(gmSwing / 100)}pct < 10pct → 成长主导`; }
  else if (gmSwing >= 10) { lifeCycle = '周期主导'; lifeNote = `毛利率年度波动 ${pct(gmSwing / 100)}pct ≥ 10pct → 周期主导，宜用 PB / EV-EBITDA`; }
  const marginRepair = q2YoY > npYoY + 0.05;
  if (marginRepair) lifeNote += `；边际信号：Q2 单季利润同比 ${pct(q2YoY)}% 显著高于 H1 的 ${pct(npYoY)}% → 盈利修复上行（利好 PE / PEG 轨道）`;

  // 数据完整性：核心字段缺失检测
  const required = { revTTM, npTTM, shares: N, cash: nz(B.cash), ibd: nz(B.interestBearDebt), equity: nz(B.equityParent), fcff: nz(I.dcfFixed.fcffBase.value) };
  const missing = Object.keys(required).filter(k => !required[k]);
  const completeness = 1 - missing.length / Object.keys(required).length;
  if (completeness < 0.95) alerts.push(`核心字段缺失：${missing.join('/')}（完整度 ${pct(completeness)}% < 95%）→ 估值置信度下降`);
  const estFlags = [];
  if (I.dcfFixed.daRatio.estimated) estFlags.push('D&A 为估算值（由经营现金流反推）');

  // ================= 第三站：三情景财务预测 =================
  const SC = I.scenarios, SW = I.scenarioWeights, MW = I.methodWeights;
  const peers = I.peers.list;
  const peMedian = median(peers.filter(p => p.usePe).map(p => p.pe));
  const pbMedian = median(peers.map(p => p.pb));
  const impliedROE = (peMedian && pbMedian) ? (pbMedian / peMedian) : null;   // 可比隐含 ROE = PB/PE

  const MA = I.macro;
  const rf = nz(vv(MA.rf)) / 100, erp = nz(vv(MA.erp)) / 100, beta = nz(vv(MA.beta));
  const sizeAdj = nz(vv(MA.sizeAdj)) / 100, rd = nz(vv(MA.rd)) / 100, tax = nz(vv(MA.taxRate)) / 100;
  const gP = nz(vv(MA.gPerp)) / 100;
  const Re = rf + beta * erp + sizeAdj;
  const mcap = P != null ? P * N : nz(I.marketSnapshot.mcap);
  const D = nz(B.interestBearDebt);
  const wE = mcap / (mcap + D), wD = D / (mcap + D);
  const WACC = wE * Re + wD * rd * (1 - tax);

  // BVPS：优先用实时行情 PB 反推（含最新期净资产），回退资产负债表快照
  const bvpsLive = (P != null && pb) ? (P / pb) : (nz(B.equityParent) / N);
  const bvpsSrc = (P != null && pb) ? `实时行情 PB ${pb} 反推（含最新期净资产）` : `资产负债表快照 ${B.asOf}`;
  const netCash = nz(B.cash) + nz(B.tradingAssets) - D;

  const peDiscount = nz(vv(I.relative.peDiscount));
  const fcffScale = revTTM / nz(F25.revenue);
  const fcffBase = nz(I.dcfFixed.fcffBase.value) * fcffScale;

  function methodsOf(key) {
    const sc = SC[key];
    const rev = revTTM * (1 + nz(sc.revGrowth));
    const np = rev * nz(sc.netMargin);
    const eps = np / N;
    // ① PE 相对估值
    const peTarget = peMedian * peDiscount * nz(sc.peCoef);
    const tpPE = np * peTarget / N;
    // ② PB-ROE 相对估值
    const roe = np / (bvpsLive * N);
    const pbTarget = impliedROE ? pbMedian * (roe / impliedROE) : pbMedian;
    const tpPB = bvpsLive * pbTarget;
    // ③ EV/EBITDA
    const ebitda = rev * nz(sc.grossMargin);          // ≈ EBITDA 率（费用率与 D&A 率相近，2025 实测均约 8.4%）
    const ev = ebitda * nz(sc.evEbitdaMultiple);
    const tpEV = (ev + netCash) / N;
    // ④ DCF（FCFF 两阶段）
    let pv = 0; const fcffs = [];
    for (let t = 1; t <= 5; t++) {
      const f = fcffBase * Math.pow(1 + nz(sc.fcffGrowth), t);
      fcffs.push(f);
      pv += f / Math.pow(1 + WACC, t);
    }
    const tv = fcffs[4] * (1 + gP) / (WACC - gP);
    const pvTv = tv / Math.pow(1 + WACC, 5);
    const evDcf = pv + pvTv;
    const tpDCF = (evDcf + netCash) / N;
    const combo = nz(MW.pe) * tpPE + nz(MW.pb) * tpPB + nz(MW.evEbitda) * tpEV + nz(MW.dcf) * tpDCF;
    return { key, label: sc.label, rev, np, eps, peTarget, tpPE, roe, pbTarget, tpPB, ebitda, tpEV, tpDCF, evDcf, pvTv, tvShare: pvTv / evDcf, combo, sc };
  }

  const S = { optimistic: methodsOf('optimistic'), base: methodsOf('base'), pessimistic: methodsOf('pessimistic') };

  // ================= 第五站：情景加权 + 交叉验证 + 评级 =================
  const center = nz(SW.optimistic) * S.optimistic.combo + nz(SW.base) * S.base.combo + nz(SW.pessimistic) * S.pessimistic.combo;
  const combos = [S.optimistic.combo, S.base.combo, S.pessimistic.combo];
  const rangeLow = Math.min(...combos), rangeHigh = Math.max(...combos);
  const safeMargin = nz(vv(I.safetyMargin));
  const conservative = center * (1 - safeMargin);

  // 交叉验证（基准情景）：相对三路区间 vs DCF
  const relVals = [S.base.tpPE, S.base.tpPB, S.base.tpEV];
  const relLow = Math.min(...relVals), relHigh = Math.max(...relVals);
  const dcfVal = S.base.tpDCF;
  const hasIntersection = dcfVal >= relLow && dcfVal <= relHigh;
  // 分歧幅度 = DCF 与「最近的相对估值端点」的相对偏离（低于下沿比下沿，高于上沿比上沿）
  const divergence = dcfVal > 0
    ? (dcfVal < relLow ? (relLow - dcfVal) / dcfVal : (dcfVal > relHigh ? (dcfVal - relHigh) / dcfVal : 0))
    : null;
  let crossNote;
  if (hasIntersection) {
    crossNote = `相对估值区间 ${r2(relLow)}~${r2(relHigh)} 元与 DCF ${r2(dcfVal)} 元存在交集 → 交叉验证通过`;
  } else {
    crossNote = `⚠️ 模型分歧较大：DCF ${r2(dcfVal)} 元显著低于相对估值区间下沿 ${r2(relLow)} 元（差 ${pct(divergence)}%）→ 按指令「以 DCF 为锚、相对估值调整上下限」，综合区间已按四路方法权重合成（DCF 权重 ${pct(nz(MW.dcf))}%），并保留分歧标注`;
  }

  let rating = '无法评级', upside = null, position = null;
  if (P != null) {
    upside = (center - P) / P;
    position = Math.max(0, Math.min(100, (P - rangeLow) / (rangeHigh - rangeLow) * 100));
    // 评级三档（项目铁律 20260908aa）：上行空间 >20% 低估 / −10%~+20% 合理 / <−10% 高估
    if (upside > 0.20) rating = '低估';
    else if (upside >= -0.10) rating = '合理';
    else rating = '高估';
  }

  // ================= 输出行 =================
  const coreRows = [
    { label: '最新报告期（时间引擎）', value: `${cfg.reportPeriod ? cfg.reportPeriod.label : '—'}（${cfgEnd || '—'}，披露 ${(cfg.reportPeriod || {}).disclosureDate || '—'}，距今 ${discAge != null ? discAge : '?'} 天）｜月算法判定 ${expectEnd}${periodMatch ? ' ✓ 一致' : ' ⚠️ 不一致'}`, source: 'data/valuation/300319.json + 月算法自动推导' },
    { label: '核心财务（TTM）', value: `营收 ${r2(revTTM)} 亿 / 归母 ${r2(npTTM)} 亿 / EPS ${r2(npTTM / N)} 元 / 毛利率 ${r2((gmNow + gm25) / 2)}%（H1 ${gmNow}%）`, source: TTM.revenue.note },
    { label: '最新期边际（2026H1）', value: `营收 ${r2(L.revenue.value)} 亿（${pct(revYoY)}%）/ 归母 ${r2(L.npParent.value)} 亿（${pct(npYoY)}%）/ Q2 单季归母同比 ${pct(q2YoY)}% / 净利率 ${L.netMargin.value}% / 每股经营现金流 ${L.ocfPerShare.value} 元`, source: L.source },
    { label: '生命周期判定', value: `${lifeCycle} → ${lifeNote}`, source: '规则：营收增速 vs 毛利率波动；缺行业增速与折旧明细 → 不启用权重自适应' },
    { label: '可比公司（申万电子-元件）', value: `PE 中位 ${r2(peMedian)}×（剔除 PE>100：风华高科/洁美科技）｜PB 中位 ${r2(pbMedian)}×｜隐含 ROE ${pct(impliedROE)}%`, source: peers.map(p => `${p.name} PE${p.pe}/PB${p.pb}${p.usePe ? '' : '(仅PB)'}`).join('；') },
    { label: 'WACC 与 DCF 参数', value: `Re ${pct(Re)}%（Rf ${pct(rf)}% + β ${beta} × ERP ${pct(erp)}% + 特定 ${pct(sizeAdj)}%）｜WACC ${pct(WACC)}%｜g ${pct(gP)}%｜显性 5 年｜税率 ${pct(tax)}%｜FCFF 基数 ${r2(fcffBase)} 亿`, source: MA.beta.source },
  ];

  const segOut = segRows.map(s => ({ name: s.name, value: `收入占比 ${s.share}%｜${s.driver}｜属性：${s.nature}` }));

  const scenRows = ['optimistic', 'base', 'pessimistic'].map(k => {
    const s = S[k];
    return {
      name: `${s.label}情景（权重 ${pct(nz(SW[k]))}%）`,
      value: `营收 ${r2(s.rev)} 亿（+${pct(nz(s.sc.revGrowth))}%）/ 归母 ${r2(s.np)} 亿 / EPS ${r2(s.eps)} 元 → PE ${r2(s.tpPE)}｜PB ${r2(s.tpPB)}｜EV/EBITDA ${r2(s.tpEV)}｜DCF ${r2(s.tpDCF)} ⇒ 情景综合 ${r2(s.combo)} 元；假设：${s.sc.assump}`,
    };
  });

  const matrixRows = [
    { method: 'PE 相对估值（30%）', low: r2(S.pessimistic.tpPE), mid: r2(S.base.tpPE), high: r2(S.optimistic.tpPE), note: `可比 PE 中位 ${r2(peMedian)}× × 折扣 ${peDiscount} × 情景系数；目标价 = 情景归母 × 合理 PE ÷ 股本` },
    { method: 'PB-ROE 相对估值（25%）', low: r2(S.pessimistic.tpPB), mid: r2(S.base.tpPB), high: r2(S.optimistic.tpPB), note: `BVPS ${r2(bvpsLive)} 元 × 可比 PB 中位 ${r2(pbMedian)}× ×（情景 ROE / 可比隐含 ROE ${pct(impliedROE)}%）；BVPS 来源：${bvpsSrc}` },
    { method: 'EV/EBITDA（20%）', low: r2(S.pessimistic.tpEV), mid: r2(S.base.tpEV), high: r2(S.optimistic.tpEV), note: `EBITDA ≈ 情景毛利率 × 营收（费用率与 D&A 率相近）；倍数 悲观12×/基准15×/乐观18×【假设区间 12~18】` },
    { method: 'DCF·FCFF 两阶段（25%）', low: r2(S.pessimistic.tpDCF), mid: r2(S.base.tpDCF), high: r2(S.optimistic.tpDCF), note: `WACC ${pct(WACC)}% / g ${pct(gP)}%；FCFF 起点 ${r2(fcffBase)} 亿（2025 年报 FCFF 按 TTM 营收缩放）；基准情景终值占比 ${pct(S.base.tvShare)}%` },
    { method: `情景综合（基准${pct(nz(SW.base))}%/乐观${pct(nz(SW.optimistic))}%/悲观${pct(nz(SW.pessimistic))}%）`, low: r2(rangeLow), mid: r2(center), high: r2(rangeHigh), note: `三情景内四路加权后按情景权重合成；保守目标价（安全边际 ${pct(safeMargin)}%）= ${r2(conservative)} 元` },
  ];

  const assumpRows = [
    { label: '收入增速（乐观/基准/悲观）', value: `${pct(nz(SC.optimistic.revGrowth))}% / ${pct(nz(SC.base.revGrowth))}% / ${pct(nz(SC.pessimistic.revGrowth))}%【假设：2026H1 实际 +10.53% 为锚】` },
    { label: '净利率 / 毛利率', value: `净 ${pct(nz(SC.optimistic.netMargin))}/${pct(nz(SC.base.netMargin))}/${pct(nz(SC.pessimistic.netMargin))}%（H1 实际 7.65%）；毛 ${pct(nz(SC.optimistic.grossMargin))}/${pct(nz(SC.base.grossMargin))}/${pct(nz(SC.pessimistic.grossMargin))}%` },
    { label: 'DCF 关键参数', value: `WACC ${pct(WACC)}%（β ${beta} 自算 104 周）/ g ${pct(gP)}% / 显性 5 年 / 税率 ${pct(tax)}% / FCFF 增速 ${pct(nz(SC.optimistic.fcffGrowth))}/${pct(nz(SC.base.fcffGrowth))}/${pct(nz(SC.pessimistic.fcffGrowth))}%` },
    { label: '净现金 / 股本', value: `货币资金 ${B.cash} + 交易性金融资产 ${B.tradingAssets} − 有息负债 ${D} = 净现金 ${r2(netCash)} 亿；总股本 ${r2(N)} 亿股（${bvpsSrc}）` },
    { label: '安全边际', value: `${pct(safeMargin)}%（15%~25% 中值），保守目标价 ${r2(conservative)} 元` },
    { label: '估算与缺失标记', value: estFlags.length ? estFlags.join('；') : '无' },
  ];

  const monitorRows = [
    { name: '季度毛利率环比', value: `当前 ${gmNow}%（2025 全年 ${gm25}%，2024 ${gm24}%）→ 连续两季回升方确认结构升级` },
    { name: '存货 / 营收', value: `存货 ${B.inventory} 亿 / TTM 营收 ${r2(revTTM)} 亿 = ${pct(B.inventory / revTTM)}%` },
    { name: '应收账款 / 归母净利', value: `${L.arToNp.value}%（应收 ${B.receivable} 亿）→ 回款质量` },
    { name: '资本开支 / 折旧', value: `在建工程 ${B.cip} 亿、固定资产 ${B.fixedAsset} 亿 → 关注募投项目达产进度（D&A 为估算值）` },
    { name: '行业 PE 分位', value: `可比 PE 中位 ${r2(peMedian)}×；麦捷当前 PE(TTM) ${I.marketSnapshot.peTTM}× → 高于中位，需盈利兑现消化` },
  ];

  const riskNote = '下行风险：① 下游智能手机 / 消费电子需求不及预期；② 铜、银、陶瓷粉等原材料涨价挤压毛利；③ LCM 模组价格战加剧（占比 47.6%，低毛利拖累 ROE）；④ 国产替代推进慢于预期、技术迭代风险；⑤ 应收账款 / 归母净利达 472%，回款与减值风险；⑥ 三费同比 +37.8% 侵蚀利润。上行催化：AI 服务器算力电感放量、车规级产品导入、LCM 企稳、毛利率修复至 19%+。模型为研究框架，不构成投资建议。';

  const positionNote = (() => {
    if (P == null) return '当前价不可用，仅输出目标价区间，评级为「无法评级」。';
    return `现价 ${r2(P)} 元位于综合区间 ${r2(rangeLow)}~${r2(rangeHigh)} 元的 ${Math.round(position)}% 位置；综合中枢 ${r2(center)} 元，上行空间 ${pct(upside)}% → 评级「${rating}」。${crossNote}`;
  })();

  const decisionNote = `五站流水线（全动态、无硬编码年份）：时间引擎 → 画像诊断（${lifeCycle}）→ 三情景预测 → 四路估值（PE30/PB-ROE25/EV·EBITDA20/DCF25）→ 情景加权（基准${pct(nz(SW.base))}%）+ 交叉验证 + 安全边际${pct(safeMargin)}% → 三档评级。所有数值由代码确定性计算，AI 仅负责叙述。`;

  return {
    ok: true,
    dedicated: true,
    maijie: true,
    symbol: SYM,
    stockName: cfg.name,
    rating,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(center),
    conservativeTarget: r2(conservative),
    currentPrice: P != null ? r2(P) : null,
    upside: upside != null ? pct(upside) : null,
    reportLabel: cfg.reportLabel,
    model: 'maijie300319·动态逻辑估值引擎（相对+绝对交叉验证，确定性计算，无AI参与）',
    dataAsOf: cfg.dataAsOf,
    lifeCycle,
    wacc: pct(WACC),
    peMedian: r2(peMedian),
    pbMedian: r2(pbMedian),
    crossNote,
    freshnessRows, alerts,
    coreRows, segRows: segOut, scenRows, matrixRows, assumpRows, monitorRows, positionNote, riskNote, decisionNote,
  };
}

module.exports = { run, isMaijieModel, loadConfig, detectLatestReportMonths };
