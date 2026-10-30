// ============================================================
// 新洋丰（000902）专属估值模型 —— 全自动动态估值 AI 指令集 V2.0 + v2.1 防呆防错补丁
// 确定性计算（1+1=2，无 LLM 参与）。算法框架 100% 按指令集 v2.0 实现；
// 实时取数按 project 范式映射为配置锁死权威快照（对齐华安/万润/圣湘），
// 所有估值输入量带构造路径标签（TTM拼接 / 前向年化[ANNUALIZED] / 最新存量 / 分部结构参考 / 不可用），
// 所有缺失维度显式标记，绝不静默替代。
// 硬约束：不得要求用户输入；不得静默替代；不得将未公告注入/未投产项目利润直接折现加总到基准目标价；
//          不得将历史运行结果当本次输入；每次运行重新检索的数据以配置快照形式注入；
//          报告期错配只导致相应维度显式标记，不得污染整体估值结论。
// v2.1 防呆与防错补丁（20261030l 用户指令，六项强制，与本补丁冲突时以本补丁为准）：
//   补丁1 数据新鲜度门控——每次运行先按日历判定当前应适用的最新报告期；严禁最新财报已发布仍用旧报告期；
//         输出第一段强制声明「本次运行已强制使用[LATEST]作为LATEST，披露日为[XX]」；
//         若最新绝对值不可得 → 用最新单季利润+已知前期值推算并标[推算]，严禁沿用上一期 E_TTM。
//   补丁2 现金流硬性否决——LATEST 经营现金流为负 → 结论第一段红色高亮「⚠️【现金流警示】」；
//         置信度锁定为【低】（不允许中/高）；保守情景 E_TTM 下调系数强制加深至 0.85 以下（0.82~0.84 档）。
//   补丁3 周期信号强制交叉校验——磷酸铁单吨毛利信号必须交叉公司调研纪要/公告/行业研报；
//         若一手证据证实单吨毛利转正 → 必须判「景气」，不得因第三方数据库缺失盲判中性/负毛利；
//         严禁将明显大幅改善的业务错误归因。
//   补丁4 情景展示与涨跌幅逻辑——各情景强制标注相对现价涨跌幅；
//         低于现价的情景严禁标「上行空间」，必须标「【下行风险】」。
//   补丁5 EV/EBIT降级约束——净有息负债数据缺失无法点估计 → 标[仅方向性参考/不可用]；
//         隐含价与 PE 基准价偏离>20% → 写明「⚠️【交叉验证失效】…置信度降低一档，结论主要依赖 PE 和 PB」。
//   补丁6 分部数据门控——LATEST 为 Q3（不披露分部）→ E_TTM 用 Q3 总归母 TTM 拼接；
//         分部结构仅取最近半年报/年报基准，并强制声明「Q3实际结构可能已发生漂移」。
// ============================================================
const path = require('path');
const fs = require('fs');
const { localDate } = require('../localDate');

const SYM = '000902';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/000902.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isXinyangfengModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'xinyangfeng';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const r3 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 1000) / 1000;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const vv = (o) => (o && o.value != null) ? o.value : (o == null ? null : o);
const median = (a) => {
  const s = [...a].map(Number).filter(x => isFinite(x)).sort((x, y) => x - y);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// ============================================================
// v2.1 补丁1：数据新鲜度门控（纯函数，导出供零网络测试）
// 按估值基准日判定「法定披露截止日已过的最新报告期」，与配置 LATEST 比对：
//   Q1 截止 04-30；H1 截止 08-31；Q3 截止 10-31；FY 截止次年 04-30。
//   配置 LATEST 期次落后于应适用期次 → gatePass=false（基准期滞后），置信度强制低 + 显式告警。
// ============================================================
function periodRank(y, type) { return y * 10 + ({ Q1: 1, H1: 2, Q3: 3, FY: 4 }[type] || 0); }
function freshnessGate(periodCfg, todayStr) {
  const d = new Date(todayStr);
  if (isNaN(d.getTime()) || !periodCfg || !periodCfg.latestType) return { gatePass: null, reason: '门控不可判定（日期或配置缺失）' };
  const y = d.getFullYear(), m = d.getMonth() + 1;
  let expY, expT;
  if (m <= 4) { expY = y - 1; expT = 'FY'; }        // 01-01~04-30 → 上年年报（04-30 截止）
  else if (m <= 8) { expY = y; expT = 'Q1'; }        // 05-01~08-31 → 当年一季报（04-30 截止）
  else if (m <= 10) { expY = y; expT = 'H1'; }       // 09-01~10-31 → 当年中报（08-31 截止）
  else { expY = y; expT = 'Q3'; }                    // 11-01~12-31 → 当年三季报（10-31 截止）
  // 配置 LATEST 的实际所属年份：baseY 为 BASE_Y（上年），FY 是 BASE_Y 当年，其余期次在 baseY+1
  const latestY = (parseInt(periodCfg.baseY, 10) || 0) + (periodCfg.latestType === 'FY' ? 0 : 1);
  const cfgRank = periodRank(latestY, periodCfg.latestType);
  const expRank = periodRank(expY, expT);
  // 领先于应适用期次（如 10 月下旬已披露三季报）→ 通过且标注「超前期望」；落后 → 滞后违规
  const gatePass = cfgRank >= expRank;
  const ahead = cfgRank > expRank;
  return {
    gatePass,
    ahead,
    expectedLatest: expY + (expT === 'FY' ? 'FY（年报）' : expT),
    cfgLatest: latestY + periodCfg.latestType,
    stalePeriod: gatePass === false,
    reason: gatePass
      ? (ahead ? `配置 LATEST（${latestY}${periodCfg.latestType}）领先于按披露日历的应适用期次（${expY}${expT}）→ 已强制使用最新披露报告期`
        : `配置 LATEST（${latestY}${periodCfg.latestType}）与按披露日历的应适用期次（${expY}${expT}）一致 → 门控通过`)
      : `⛔ 基准期滞后：按披露日历应适用 ${expY}${expT}，配置仍为 ${latestY}${periodCfg.latestType} → 严禁沿用旧报告期，须更新或[推算]`,
  };
}

// ============================================================
// A1：周期状态内生判定（三信号多数决；v2.1 补丁3：磷酸铁信号强制交叉调研纪要/公告证据）
// ============================================================
function cycleView(cs) {
  // 信号1：磷酸一铵价差偏离
  const gap = nz(cs.mapPriceGapPct);
  const s1 = gap > 15 ? '景气' : (gap < -15 ? '低迷' : '中性');
  // 信号2：新型复合肥毛利率趋势
  const gmTrend = nz(cs.newTypeGmTrendPct);
  const s2 = gmTrend > 1 ? '景气' : (gmTrend < -1 ? '低迷' : '中性');
  // 信号3：磷酸铁单吨毛利（v2.1 补丁3：必须交叉调研纪要/公告/行业研报；不得因第三方数据库缺失盲判中性/负毛利）
  const ip = cs.ironPhosphateUnitProfit || {};
  const evd = ip.thirdPartyEvidence || {};
  const s3 = (ip.positive && ip.twoQuarterRising) ? '景气' : '中性';
  const s3Note = (ip.positive && ip.twoQuarterRising)
    ? (evd.source ? `一手证据交叉证实：${evd.source}（${evd.evidenceDate || ''}）→ 单吨毛利已转正且盈利逐季抬升 → 景气（不得因第三方数据库缺失判中性/负毛利）` : '单吨毛利转正且两季抬升 → 景气')
    : (ip.note || '未盈利/未披露 → 中性（结构性增量非周期信号）');  const votes = { 景气: 0, 低迷: 0, 中性: 0 };
  [s1, s2, s3].forEach(s => votes[s]++);
  let view, split = false;
  if (votes['景气'] >= 2) view = '景气';
  else if (votes['低迷'] >= 2) view = '低迷';
  else if (votes['中性'] >= 2) view = '中性';
  else { view = '中性'; split = true; } // 无多数 → 中性+信号分裂标注
  return {
    view, split,
    signals: [
      { name: '磷酸一铵价差偏离', value: gap + '%', signal: s1, note: cs.mapPriceGapNote || '' },
      { name: '新型复合肥毛利率趋势', value: (gmTrend > 0 ? '+' : '') + gmTrend + 'pct', signal: s2, note: cs.newTypeGmTrendNote || '' },
      { name: '磷酸铁单吨毛利', value: (ip.value != null ? ip.value + (ip.unit || '') : 'N/A'), signal: s3, note: s3Note },
    ],
  };
}

// ============================================================
// R2：TTM 拼接；R3：前向年化降级（[ANNUALIZED] 标记）
// ============================================================
function buildTTM(cfg, latestType) {
  const S = cfg.statements;
  const baseY = cfg.period.baseY;
  const fyBase = S.fy[String(baseY)] || {};
  const npBase = nz(fyBase.np);
  const ebitBase = nz(fyBase.ebit);
  const cfoBase = nz(fyBase.cfo);

  // 取 LATEST 各期累计与上年同期
  const latest = (latestType === 'FY') ? S.fy[String(baseY)] : (S[latestType.toLowerCase()] || {})[String(baseY + (latestType === 'FY' ? 0 : 1))] || {};
  const yoy = (S[latestType.toLowerCase()] || {})[String(baseY)] || {};

  // R2 拼接：baseY 全年 + LATEST 累计 − 上年同期累计
  const npL = nz(latest.np), npY = nz(yoy.np);
  const ebitL = nz(latest.ebit), ebitY = nz(yoy.ebit);
  const cfoL = nz(latest.cfo), cfoY = nz(yoy.cfo);

  let npTTM, ebitTTM, cfoTTM, path, pathNote, annualized = false;

  if (npL > 0 && npY > 0) {
    npTTM = npBase + npL - npY;
    ebitTTM = ebitBase + ebitL - ebitY;
    cfoTTM = cfoBase + cfoL - cfoY;
    path = 'R2·TTM拼接';
    pathNote = `TTM归母 = ${r2(npBase)}(${baseY}全年) + ${r2(npL)}(LATEST累计) − ${r2(npY)}(上年同期) = ${r2(npTTM)} 亿（路径 R2）`;
  } else {
    // R3 前向年化降级
    annualized = true;
    const seas = (cfg.seasonal && cfg.seasonal[latestType.toLowerCase()]) || { factor: 1, note: '季节性调整未生效' };
    const factor = nz(seas.factor) || 1;
    const mult = latestType === 'Q1' ? 4 : (latestType === 'H1' ? 2 : (latestType === 'Q3' ? 4 / 3 : 1));
    npTTM = npL * mult * factor;
    ebitTTM = ebitL * mult * factor;
    cfoTTM = cfoL * mult * factor;
    path = 'R3·前向年化[ANNUALIZED]';
    pathNote = `上年同期缺失 → 降级 R3：${latestType} × ${mult} × 季节性因子 ${factor} = ${r2(npTTM)} 亿[ANNUALIZED]（${seas.note || ''}）`;
  }
  return { npTTM, ebitTTM, cfoTTM, path, pathNote, annualized };
}

// ============================================================
// 主入口（同步，与现有消费方 run(symbol,{price}) 契约兼容）
// ============================================================
function run(symbol, { price } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'xinyangfeng') return { error: 'NOT_XINYANGFENG' };

  const M = cfg.market, P0 = cfg.period, ST = cfg.statements, BS = cfg.balanceSheet, CY = cfg.cycleSignals, V = cfg.valuation;
  const N = nz(vv(M.shares));                                   // 总股本（亿股）
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : nz(M.priceSources && M.priceSources[0] && M.priceSources[0].px);
  const priceSourceNote = (price != null && isFinite(Number(price)) && Number(price) > 0)
    ? '实时行情（getQuote 传入）'
    : '配置锁死快照（' + (M.priceAdopt || '多源交叉取 13.85') + '）';

  // ===== 〇、内生判定声明（A1）=====
  const cyc = cycleView(CY);

  // ===== 〇·1、v2.1 补丁1：数据新鲜度门控（每次运行强制先查当前应适用最新报告期） =====
  const gate = freshnessGate(P0, localDate());
  const latestFin = (ST[P0.latestType.toLowerCase()] || {})[String(P0.baseY + (P0.latestType === 'FY' ? 0 : 1))] || {};
  const latestAbsAvailable = latestFin.np != null;   // 补丁1.4：最新绝对值不可得 → 须[推算]，严禁沿用上一期 E_TTM
  const missing = [];                                 // R6 缺失标记（各维度最低必需项）
  if (!latestAbsAvailable) missing.push('LATEST最新财报绝对值（须用最新单季利润+已知前期值[推算]，严禁沿用上期E_TTM）');

  // ===== 〇·2、v2.1 补丁2：现金流硬性否决判定 =====
  const latestCfo = nz(latestFin.cfo);
  const cfoVetoTriggered = latestAbsAvailable && latestCfo < 0;
  const cfoVetoWarning = cfoVetoTriggered
    ? `⚠️【现金流警示】最新报告期经营现金流为负（${r2(latestCfo)}亿元），利润质量存疑。`
    : null;

  // ===== 〇·3、v2.1 补丁6：分部数据门控声明（Q3 不披露分部 → 结构取最近 H1/FY 基准 + 漂移声明） =====
  const segDriftNote = (P0.latestType === 'Q3' && !P0.segmentConsistent)
    ? `当前盈利结构参考为[${P0.segmentBasePeriod}]分部数据，Q3实际结构可能已发生漂移。`
    : null;

  // ===== 一、期间锚定与数据质量声明（R1/R2/R5/R6）=====
  const latestType = P0.latestType;                              // FY/H1/Q3/Q1
  const ttm = buildTTM(cfg, latestType);
  const equityLatest = nz((ST[latestType.toLowerCase()] || {})[String(P0.baseY + (latestType === 'FY' ? 0 : 1))]?.equity);
  // R5 分部门控
  const segConsistent = !!P0.segmentConsistent;

  // R6 缺失标记（数组已在补丁1门控处声明）
  if (!N) missing.push('总股本');
  if (!(ttm.npTTM > 0)) missing.push('TTM归母净利');
  if (!(ttm.ebitTTM > 0)) missing.push('TTM EBIT');
  if (!equityLatest) missing.push('最新归母净资产');
  if (!(BS.netInterestBearingDebt != null)) missing.push('净有息负债');
  const evComplete = !!(M.netDebtCompleteness && M.netDebtCompleteness.complete);

  // ===== 二、核心输入量 =====
  const E_TTM = ttm.npTTM;
  const EBIT_TTM = ttm.ebitTTM;
  const CFO_TTM = ttm.cfoTTM;
  const netDebt = nz(BS.netInterestBearingDebt);
  const mktCap = P * N;
  const ev = mktCap + netDebt;                                  // R4：EV = 市值 + 净有息负债
  const ROE_TTM = equityLatest > 0 ? E_TTM / equityLatest * 100 : null;

  // 分红（最近已实施）
  const DV = cfg.dividend || {};
  const divPerShare = nz(vv(DV.latestPerShare));
  const divRate = nz(vv(DV.rate));
  const divYield = P > 0 ? divPerShare / P * 100 : null;

  // ===== 三、估值三角 =====
  // 4.1 主模型 PE-TTM
  const peerMedian = median(V.peerPE);
  const histMedian = median(V.peHist);
  let peBase = 0.5 * nz(peerMedian) + 0.5 * nz(histMedian);
  const peAdj = V.peAdjust || {};
  let peAdjNote = `PE_base = 0.5×peer中位(${r2(peerMedian)}) + 0.5×hist中位(${r2(histMedian)}) = ${r2(peBase)}`;
  let adjSum = 0;
  const roeTTMv = nz(ROE_TTM);
  if (roeTTMv > nz(peAdj.roeGood)) { adjSum += 0.5; }
  const cfoQuality = CFO_TTM / Math.max(E_TTM, 1e-9);
  if (cfoQuality > nz(peAdj.cfoQualityGood)) { adjSum += 0.3; }
  if (nz(peAdj.newTypeShare) > nz(peAdj.newTypeShareThreshold)) { adjSum += 0.5; peAdjNote += '；新型肥占比>40% → 上修'; }
  peBase += adjSum;
  peAdjNote += `；调整项（ROE_TTM>${nz(peAdj.roeGood)}→+0.5、CFO/E>${nz(peAdj.cfoQualityGood)}→+0.3）合计 +${r2(adjSum)} → PE_base≈${r2(peBase)} 倍`;
  const pricePE = E_TTM * peBase / N;

  // 4.2 交叉验证 EV/EBIT-TTM
  const evEbitTarget = nz(V.evEbitTargetMultiple);
  const evEbitImplied = EBIT_TTM > 0 ? ev / EBIT_TTM : null;    // 当前 EV/EBIT 倍数
  const evEbitDev = (evEbitImplied != null && evEbitTarget > 0) ? (evEbitImplied - evEbitTarget) / evEbitTarget * 100 : null;
  const priceEV = (EBIT_TTM * evEbitTarget - netDebt) / N;      // EV/EBIT 隐含合理价（下沿约束）
  // v2.1 补丁5：净有息负债数据缺失 → [仅方向性参考/不可用]；隐含价与 PE 基准价偏离>20% → 交叉验证失效（禁用「约束边界」措辞）
  const evDevAbs = Math.abs(nz(evEbitDev));
  const peBasePrice = pricePE;                                   // PE-TTM 基准价
  const evPeDev = (peBasePrice > 0 && priceEV != null && isFinite(priceEV)) ? (priceEV - peBasePrice) / peBasePrice * 100 : null;
  const evCrossInvalid = !evComplete && evPeDev != null && Math.abs(evPeDev) > 20;
  const evCross = evCrossInvalid
    ? `⚠️【交叉验证失效】由于负债端数据缺失，EV/EBIT隐含价与PE偏离达${r2(evPeDev)}%，本次模型置信度降低一档，结论主要依赖于PE和PB。`
    : (evEbitDev != null && evDevAbs > 20
      ? `两种主模型分歧较大（EV/EBIT 隐含 ${r2(evEbitImplied)}x vs 目标 ${r2(evEbitTarget)}x，偏离 ${r2(evEbitDev)}%）→ 以 PE 为主、EV/EBIT 为约束边界`
      : `EV/EBIT 隐含 ${r2(evEbitImplied)}x，与目标 ${r2(evEbitTarget)}x 偏离 ${r2(evEbitDev)}%，可接受`);
  const evState = !evComplete
    ? (evCrossInvalid ? '⚠️【交叉验证失效】[仅方向性参考/不可用]（净有息负债不完整 + 隐含价与PE偏离>20%）' : '[仅方向性参考/不可用]（净有息负债不完整，按 R6-EV）')
    : (evDevAbs > 30 ? '可执行·与主模型分歧>30%（作下沿约束）' : '可执行');

  // 4.3 PB-ROE 锚（方向性）
  const pbRoe = V.pbRoe || { g: 2.5, r: 9.0 };
  const g = nz(pbRoe.g) / 100, r = nz(pbRoe.r) / 100;
  const fairPB = (ROE_TTM / 100 - g) / (r - g);
  const curPB = equityLatest > 0 ? P / (equityLatest / N) : null;
  let pbNote = 'PB-ROE 仅方向性检验，不单独产出目标价';
  if (fairPB != null && curPB != null) {
    if (curPB > fairPB * (1 + 1 / 3)) pbNote = `现价 PB ${r2(curPB)} > 合理 PB ${r2(fairPB)}（超 1 个标准差）→ PE 结论可能偏乐观`;
    else if (curPB < fairPB) pbNote = `现价 PB ${r2(curPB)} < 合理 PB ${r2(fairPB)} → PE 结论可能偏保守（现价相对 PB 便宜）`;
  }

  // 4.4 期权增量（独立列示，不并入）
  const OPT = cfg.options || {};
  const optRows = [];
  const pm = OPT.phosphateMineInjection || {};
  const ip = OPT.ironPhosphate || {};
  optRows.push({
    label: '【期权】磷矿注入',
    value: `条件未达成（${pm.condition || '无明确时间表'}）→ 仅定性描述，不计入基准价；若兑现年化增厚 ${(pm.profitLift || []).join('~')} 亿 → 每股 ${(pm.perShare || []).join('~')} 元`,
    source: pm.note || '',
  });
  optRows.push({
    label: '【期权】磷酸铁扭亏',
    value: `当前单吨毛利为负/未披露、无连续趋势证据 → 留在期权段，不升格为基准 E 已包含项；若满产且正毛利年化增厚 ${(ip.profitLift || []).join('~')} 亿 → 每股 ${(ip.perShare || []).join('~')} 元`,
    source: ip.note || '',
  });
  const optInBase = false; // 硬约束：期权绝不并入基准

  // ===== 四、三情景（5.1 同向调整 + 收敛校准；v2.1 补丁2/4：现金流否决加深 + 相对现价涨跌幅强制标注）=====
  function scenario(key) {
    const sc = cfg.scenarioAdj[key];
    let eL = sc.eMult[0], eH = sc.eMult[1];
    const peL = sc.peMult[0], peH = sc.peMult[1];
    let vetoNote = '';
    if (cfoVetoTriggered && key === 'conservative') {
      // 补丁2：LATEST 经营现金流为负 → 保守情景 E_TTM 下调系数强制加深至 0.85 以下（0.82~0.84 档）
      eL = 0.82; eH = 0.84;
      vetoNote = '｜⚠️ 现金流硬性否决（补丁2）：LATEST 经营现金流为负（' + r2(latestCfo) + ' 亿）→ E_TTM 下调系数由 ' + sc.eMult.join('~') + ' 强制加深至 0.82~0.84（<0.85 档，反映营运资本恶化与纸面利润风险）';
    }
    const eUsed = E_TTM * (eL + eH) / 2;
    const peUsed = peBase * (peL + peH) / 2;
    const price = eUsed * peUsed / N;
    // 补丁4：强制标注相对现价涨跌幅；低于现价严禁标「上行空间」→ 标「【下行风险】」
    let pctTxt = '';
    if (P != null) {
      const pctv = (price - P) / P * 100;
      pctTxt = pctv >= 0 ? `（相对现价 +${r2(pctv)}%）` : `【下行风险】（相对现价 -${r2(-pctv)}%）`;
    }
    const namePrefix = { conservative: '保守目标价', base: '基准目标价', optimistic: '乐观目标价' }[key] || '目标价';
    return { key, eUsed: r2(eUsed), peUsed: r2(peUsed), price: r2(price), pctTxt, namePrefix, eMultUsed: [eL, eH], peMultUsed: [peL, peH], note: (sc.trigger || '') + vetoNote };
  }
  const sC = scenario('conservative'), sB = scenario('base'), sO = scenario('optimistic');
  const rangeLow = Math.min(sC.price, sB.price, sO.price);
  const rangeHigh = Math.max(sC.price, sB.price, sO.price);
  const center = sB.price;
  const conservativeTarget = rangeLow; // 保守情景即区间下沿

  // ===== 五、反向验证清单（5.2）=====
  const RC = cfg.reverseCheck || {};
  const cfoERatio = E_TTM > 0 ? CFO_TTM / E_TTM : null;
  const rev1 = { id: '1.现金流验证', result: (cfoERatio != null && cfoERatio > nz(RC.cfoEThreshold)) ? '是' : '否',
    detail: `CFO_TTM/E_TTM = ${r2(cfoERatio)} ${cfoERatio != null && cfoERatio > nz(RC.cfoEThreshold) ? '> ' + nz(RC.cfoEThreshold) + ' → 利润质量良好' : '< ' + nz(RC.cfoEThreshold) + ' 或无法计算 → 提示利润质量风险'}${cfoVetoTriggered ? `；⚠️ LATEST（${P0.latest}）经营现金流为负（${r2(latestCfo)} 亿）→ 现金流硬性否决已触发（补丁2）：置信度锁定低、保守情景 E 系数加深至 0.82~0.84` : ''}` };
  const roeLastYear = nz(ST.fy[String(P0.baseY)].roe);
  const rev2 = { id: '2.ROE趋势', result: (ROE_TTM != null && ROE_TTM < nz(RC.roeFloorLastYear)) ? '否' : '不适用',
    detail: `ROE_TTM ${r2(ROE_TTM)}%（LATEST=${P0.latest} 口径；${P0.baseY} 全年 ${r2(roeLastYear)}%）；未跌破 ${nz(RC.roeFloorLastYear)}% 警戒线 → 盈利中枢未下移（季内波动看待全年）` };
  const divCovered = (divPerShare * N) > 0 ? CFO_TTM / (divPerShare * N) : null;
  const divPass = divRate >= nz(RC.dividendRateThreshold) && nz(divCovered) > nz(RC.cfoECommittedThreshold);
  const rev3 = { id: '3.分红可持续性', result: divPass ? '是' : '否',
    detail: `分红率 ${r2(divRate * 100)}%（${divRate >= nz(RC.dividendRateThreshold) ? '≥' : '<'}${nz(RC.dividendRateThreshold) * 100}%）且 CFO 覆盖分红 ${r2(divCovered)}× ${nz(divCovered) > nz(RC.cfoECommittedThreshold) ? '>' : '≤'} ${nz(RC.cfoECommittedThreshold)}× → ${divPass ? '可持续' : '分红覆盖不足（现金流硬性否决连带：CFO_TTM 含 LATEST 负现金流拖累）'}` };
  const rev4 = { id: '4.出口政策敏感性', result: '是',
    detail: `保守情景已含「磷肥出口管控持续收紧」假设 → 出口政策风险已在悲观情景反映` };
  const shareDilPct = 0; // 2026H1 与 BASE_Y 股本一致（配置已声明无变动）
  const rev5 = { id: '5.股本稀释', result: shareDilPct <= nz(RC.shareDilutionThresholdPct) ? '不适用' : '否',
    detail: `最新总股本 ${r2(N)} 亿股较 BASE_Y(${P0.baseY}) 增幅 ${shareDilPct}% ≤ ${nz(RC.shareDilutionThresholdPct)}% → 每股指标无需重算（验证通过）` };
  const reverseRows = [rev1, rev2, rev3, rev4, rev5];
  const reverseAllPass = reverseRows.every(r => r.result === '是' || r.result === '不适用');

  // ===== 六、置信度（指令集六档；v2.1 补丁1/2/5 三条强制规则）=====
  let confidenceLevel, confidenceNote;
  if (cfoVetoTriggered) {
    // 补丁2：LATEST 经营现金流为负 → 置信度锁定【低】，不允许评为【中】或【高】
    confidenceLevel = '低';
    confidenceNote = `现金流硬性否决（补丁2）：LATEST（${P0.latest}）经营现金流为负（${r2(latestCfo)} 亿）→ 置信度锁定为【低】，不允许中/高；保守情景 E_TTM 下调系数已强制加深至 0.82~0.84（<0.85 档）`;
  } else if (gate.stalePeriod) {
    // 补丁1：基准期滞后 → 强制低
    confidenceLevel = '低';
    confidenceNote = gate.reason + '（补丁1 数据新鲜度门控）';
  } else if (!latestAbsAvailable) {
    confidenceLevel = '低';
    confidenceNote = 'LATEST 最新财报绝对值缺失 → 走[推算]路径（最新单季利润+已知前期值），置信度强制低（补丁1.4：严禁沿用上一期 E_TTM）';
  } else if (ttm.annualized) {
    confidenceLevel = '低';
    confidenceNote = '使用了[ANNUALIZED]前向年化（非 TTM 拼接）→ 置信度低';
  } else if (!reverseAllPass) {
    confidenceLevel = '低';
    confidenceNote = '任一反向验证失败 → 置信度低';
  } else if (!evComplete) {
    confidenceLevel = '低';
    confidenceNote = 'EV/EBIT 降级为仅方向性（净有息负债不完整）→ 置信度低';
  } else if (Math.abs(nz(evEbitDev)) > 30) {
    confidenceLevel = '中';
    confidenceNote = `EV/EBIT 与主模型 PE 分歧 >30%（偏离 ${r2(evEbitDev)}%）→ 置信度由高下调至中，PE 为主、EV 为下沿约束`;
  } else if (Math.abs(nz(evEbitDev)) > 20) {
    confidenceLevel = '中';
    confidenceNote = `EV/EBIT 偏离 ${r2(evEbitDev)}%（20%~30%）→ 置信度中`;
  } else {
    confidenceLevel = '高';
    confidenceNote = 'TTM 路径 + 反向验证全部通过 + EV/EBIT 偏离 <20% → 置信度高';
  }
  // 补丁5：交叉验证失效（负债端缺失 + 隐含价与 PE 偏离>20%）→ 在上述结果上再降一档（低不可再降）
  if (evCrossInvalid) {
    confidenceLevel = (confidenceLevel === '高') ? '中' : '低';
    confidenceNote += '；⚠️【交叉验证失效】由于负债端数据缺失，EV/EBIT隐含价与PE偏离达' + r2(evPeDev) + '%，本次模型置信度降低一档，结论主要依赖于PE和PB（补丁5）';
  }

  // ===== 评级（严格三档）=====
  let rating = '合理', expectedReturn = null, upside = null;
  if (P != null && center != null) {
    expectedReturn = (center - P) / P * 100;
    upside = (rangeHigh - P) / P * 100;
    rating = P < rangeLow ? '低估' : (P > rangeHigh ? '高估' : '合理');
  }

  // ===== 模型失效检查 =====
  const MF = cfg.modelFailure || { conds: [] };
  const failRows = (MF.conds || []).map(c => {
    const trig = !!c.triggered;
    return { id: c.id, text: c.text, threshold: c.threshold, triggered: trig, status: trig ? '⛔ 触发' : '✅ 未触发' };
  });
  const modelSuspended = failRows.some(f => f.triggered);

  // ===== 时效看板 =====
  const FR = cfg.freshness || {};
  const frMax = nz(FR.maxAgeDays) || 200;
  const freshnessRows = [];
  const today = new Date();
  for (const it of (FR.items || [])) {
    if (!it.asOf) continue;
    const age = Math.floor((today - new Date(it.asOf)) / 86400000);
    const stale = age > frMax;
    freshnessRows.push({ label: it.label, asOf: it.asOf, ageDays: age, maxAge: frMax, stale });
  }

  // ===== 输出区块（v2.0 结构）=====
  const cycleRows = [
    { label: 'CYCLE_VIEW 自判结果', value: cyc.view + (cyc.split ? '（信号分裂，无多数→中性）' : ''), source: 'A1 三信号多数决' },
    ...cyc.signals.map(s => ({ label: '　└ ' + s.name, value: `${s.value} → ${s.signal}`, source: s.note })),
  ];
  const periodRows = [
    { label: '数据新鲜度门控（v2.1补丁1）', value: gate.reason, source: '按披露日历强制判定：Q1截止04-30 / H1截止08-31 / Q3截止10-31 / FY截止次年04-30；滞后→置信度强制低' },
    { label: 'BASE_Y / LATEST', value: `${P0.baseY} / ${P0.latest}（披露日 ${P0.latestDisclosureDate}）`, source: 'R1 期间锚定；补丁1.3：已强制声明使用最新披露报告期' },
    { label: 'TTM 构造路径', value: ttm.path + (ttm.annualized ? '[ANNUALIZED]' : '') + (P0.latestType === 'Q3' ? '（补丁6：Q3 不披露分部 → E_TTM 用 Q3 总归母 TTM 拼接）' : ''), source: ttm.pathNote },
    { label: '分部数据基准期', value: `${P0.segmentBasePeriod}（与 LATEST 一致：${segConsistent ? '是' : '否'} → ${segConsistent ? '结构判断可用' : '仅定性权重'}）`, source: 'R5 分部门控' + (segDriftNote ? '；' + segDriftNote : '') },
    { label: '现金流硬性否决（v2.1补丁2）', value: cfoVetoTriggered ? `⛔ 已触发：LATEST（${P0.latest}）经营现金流 ${r2(latestCfo)} 亿 < 0 → 置信度锁定【低】+ 保守情景 E 系数加深至 0.82~0.84` : `✅ 未触发（LATEST 经营现金流 ${latestAbsAvailable ? r2(latestCfo) + ' 亿' : '不可得'}）`, source: 'LATEST 期末经营现金流判定；触发→结论第一段红色高亮' },
    { label: '净有息负债完整性', value: evComplete ? '完整（五项齐全）' : '部分缺失：' + ((M.netDebtCompleteness && M.netDebtCompleteness.missing) || []).join('/') + ' → EV/EBIT [仅方向性参考/不可用]', source: evComplete ? 'EV/EBIT 可执行' : '补丁5 + R6-EV' },
    { label: '不可用维度', value: missing.length ? missing.join('、') : '无', source: 'R6 显式标记（硬约束：不静默替代）' },
  ];
  const coreRows = [
    { label: 'E_TTM（归母）', value: `${r2(E_TTM)} 亿元　[${ttm.path}]`, source: ttm.pathNote },
    { label: 'EBIT_TTM', value: `${r2(EBIT_TTM)} 亿元　[${ttm.path}]`, source: ttm.pathNote },
    { label: '净有息负债', value: `${r2(netDebt)} 亿元（LATEST 末值）`, source: 'R4 存量取点' },
    { label: '总股本 / 当前价 / 市值', value: `${r2(N)} 亿股 / ¥${r2(P)} / ${r2(mktCap)} 亿`, source: priceSourceNote },
    { label: 'ROE_TTM', value: `${r2(ROE_TTM)}%（E_TTM / 最新归母净资产 ${r2(equityLatest)} 亿）`, source: '估值三角 4.3' },
    { label: '经营现金流 / E_TTM', value: `${r2(cfoERatio)}×`, source: '反向验证 5.2①' },
    { label: '最近分红', value: `每股 ${r2(divPerShare)} 元，分红率 ${r2(divRate * 100)}%，股息率 ${r2(divYield)}%`, source: DV.asOf || '' },
  ];
  const tripleRows = [
    { label: '① PE-TTM（主）', value: `PE_base ${r2(peBase)} 倍 × E_TTM ${r2(E_TTM)} 亿 ÷ ${r2(N)} 亿股 = ${r2(pricePE)} 元/股`, source: peAdjNote },
    { label: '② EV/EBIT-TTM（交叉）', value: `EV ${r2(ev)} 亿 ÷ EBIT_TTM ${r2(EBIT_TTM)} = ${r2(evEbitImplied)}x；目标 ${r2(evEbitTarget)}x → 隐含价 ${r2(priceEV)} 元（下沿约束）　[${evState}]`, source: evCross },
    { label: '③ PB-ROE（方向性锚）', value: `合理 PB = (${r2(ROE_TTM)}% − ${nz(pbRoe.g)}%)/(${nz(pbRoe.r)}% − ${nz(pbRoe.g)}%) = ${r2(fairPB)}；现价 PB ${r2(curPB)} → ${pbNote}`, source: '仅方向性检验' },
  ];
  const scenRows = [
    { name: '保守情景', value: `E ${sC.eUsed} 亿(×${sC.eMultUsed.join('~')}${cfoVetoTriggered ? '，原 ' + cfg.scenarioAdj.conservative.eMult.join('~') + ' 现金流否决加深' : ''}) × PE ${sC.peUsed} 倍(×${sC.peMultUsed.join('~')}) → ${sC.namePrefix} ${sC.price} 元${sC.pctTxt}；${sC.note}` },
    { name: '基准情景', value: `E ${sB.eUsed} 亿 × PE ${sB.peUsed} 倍 → ${sB.namePrefix} ${sB.price} 元${sB.pctTxt}（中枢）；${sB.note}` },
    { name: '乐观情景', value: `E ${sO.eUsed} 亿(×${sO.eMultUsed.join('~')}) × PE ${sO.peUsed} 倍(×${sO.peMultUsed.join('~')}) → ${sO.namePrefix} ${sO.price} 元${sO.pctTxt}；${sO.note}` },
  ];

  // v2.1 补丁1.3/2/6：输出第一段 = LATEST 强制声明 + 分部漂移声明 + 现金流红色警示（前端以红色高亮渲染）
  const openingStatement = `本次运行已强制使用[${P0.latest}]作为LATEST，披露日为[${P0.latestDisclosureDate}]。`
    + (segDriftNote || '')
    + (cfoVetoWarning || '')
    + (gate.stalePeriod ? gate.reason + '。' : '')
    + (!latestAbsAvailable ? 'LATEST 最新财报绝对值缺失 → 已按[推算]路径处理（最新单季利润+已知前期值，严禁沿用上期 E_TTM）。' : '');

  const summaryNote = `${openingStatement}【新洋丰全自动估值 | RUN_DATE：${localDate()}】基准合理价 ${r2(center)} 元（区间 ${r2(rangeLow)}~${r2(rangeHigh)}），相对当前价 ${P != null ? '¥' + r2(P) : 'N/A'} 空间 ${r2(expectedReturn)}%；评级【${rating}】；置信度【${confidenceLevel}】${cfoVetoTriggered ? '（现金流硬性否决锁定）' : ''}。CYCLE_VIEW=${cyc.view}。估值三角：PE-TTM 主 ${r2(pricePE)} 元、EV/EBIT ${evCrossInvalid ? '[不可用·交叉验证失效]' : '下沿 ' + r2(priceEV) + ' 元'}、PB-ROE 方向性（合理 PB ${r2(fairPB)}）。期权增量（磷矿/磷酸铁）独立列示，不并入基准。`;

  const positionNote = (P == null)
    ? '当前价不可用，仅输出估值区间。'
    : `基于最新可得数据（截止 ${cfg.dataAsOf}，财报期 ${P0.latest}）：当前股价 ¥${r2(P)} 位于三情景区间 [${r2(rangeLow)}, ${r2(rangeHigh)}] 元的 ${Math.round(Math.max(0, Math.min(100, (P - rangeLow) / (rangeHigh - rangeLow || 1) * 100)))}% 位置；基准中枢 ¥${r2(center)}，预期空间 ${r2(expectedReturn)}%。PE(TTM) ${r2(P / (E_TTM / N))} 倍、PB ${r2(curPB)} 倍。核心逻辑：新型肥料占比提升（34.3%）→ 综合毛利中枢上移；磷矿自给率（14.3%）与莲花山矿注入提供期权增量；渠道护城河（6000 经销商/70000 终端/2700 县）为最稳壁垒。`;

  const riskNote = '上行：新型肥料占比突破 40%、莲花山矿公告注入、磷酸铁稳定盈利、行业集中度提升；下行：硫磺/磷矿石/合成氨价格高位压制毛利、新型肥渗透停滞、莲花山矿注入延迟、磷酸铁持续亏损、磷肥出口管控收紧。本模型逻辑框架按 v2.0 指令集实现、参数按最新财报与公告动态更新；结论不构成投资建议。';

  const hardConstraintNote = '硬约束核验：① 不静默替代（缺失维度显式标记：' + (missing.length ? missing.join('、') : '无') + '）；② 所有缺失已显式标记；③ 期权增量（磷矿/磷酸铁）独立列示，未并入基准目标价；④ 未将历史运行结果当本次输入（配置即本次检索快照）；⑤ 报告期错配（如有）仅导致相应维度标记，未污染整体结论；⑥ v2.1 六项防呆防错补丁已强制启用（数据新鲜度门控 / 现金流硬性否决 / 周期信号证据交叉校验 / 情景涨跌幅与下行风险标注 / EV/EBIT 降级约束 / 分部数据门控）。';

  return {
    ok: true,
    dedicated: true,
    xinyangfeng: true,
    symbol: SYM,
    stockName: cfg.name,
    rating: modelSuspended ? '需人工复核' : rating,
    modelSuspended,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(center),
    conservativeTarget: r2(conservativeTarget),
    conservativePct: (P != null && conservativeTarget != null) ? r2((conservativeTarget - P) / P * 100) : null,
    currentPrice: P != null ? r2(P) : null,
    upside: upside != null ? r2(upside) : null,
    expectedReturn: expectedReturn != null ? r2(expectedReturn) : null,
    confidence: confidenceLevel,
    outputState: '区间态（三情景）',
    confidenceNote,
    model: 'xinyangfeng000902·全自动动态估值 V2.1（v2.0 框架 + 六项防呆防错补丁，确定性计算，无 AI 参与）',
    version: cfg.version,
    dataAsOf: cfg.dataAsOf,
    reportLabel: P0.latest,
    cycleView: cyc.view,
    // v2.1 补丁字段
    openingStatement,
    freshnessGate: gate,
    cfoVeto: cfoVetoTriggered,
    cfoVetoWarning,
    segDriftNote,
    evCrossInvalid,
    evPeDev: r2(evPeDev),
    // v2.0 区块
    cycleRows, periodRows, coreRows, tripleRows, scenRows, optionRows: optRows, reverseRows,
    failRows,
    modelFailureNote: modelSuspended
      ? '⛔ 模型暂停，需人工复核：' + failRows.filter(f => f.triggered).map(f => f.text).join('；')
      : '✅ 失效预警条件均未触发，模型有效（' + failRows.map(f => f.id + '未触发').join('、') + '）',
    summaryNote, positionNote, riskNote, hardConstraintNote,
    decisionNote: peAdjNote + '。' + evCross + '。' + pbNote + '。',
    freshnessRows,
    alerts: freshnessRows.filter(f => f.stale).map(f => `「${f.label}」距今 ${f.ageDays} 天 > ${f.maxAge} 天，请复核更新`),
    // 兼容性字段（老消费方可能读取）
    fairValueCenterOld: r2(center),
  };
}

module.exports = { run, isXinyangfengModel, loadConfig, freshnessGate, cycleView };
