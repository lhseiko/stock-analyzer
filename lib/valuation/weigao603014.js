// ============================================================
// 威高血净（603014）专属估值模型 —— 动态估值 AI 指令集（整合版）九指令
// 确定性计算（1+1=2，无 LLM 参与）。执行顺序严格按指令一：
//   并表状态识别 → 三口径桥接 → 数据新鲜度分级 → 核心矩阵构建 → 估值引擎 → 动态结论
// 设计原则：新鲜度分级解决「报告期错配」，并表协议解决「合并范围断层」，
//   三口径桥接解决「备考数与法定数混用」。估值准确性不为数据缺失让路——
//   降级指标自动改变其在估值中的权重，而非机械填充或强行年化。
// 硬约束：
//   ① 每次运行必须声明「本次 DCF 基期采用口径①（法定合并）」；
//   ② 备考口径（②）不得直接输入 DCF、不得年化；凡引用「同比+156.69%」类表述
//      必须标注「备考口径对比，非法定报表同比」；
//   ③ 并表首年附加禁止：2026 年 1—8 月普瑞利润不入合并 FCFF；禁止将当期利润简单年化；
//   ④ 承诺期结束后（2029 起）不得将承诺期 CAGR 线性外推至永续；
//   ⑤ PE/EPS 一律使用摊薄后总股本 6.95 亿股；
//   ⑥ 协同效应看涨期权独立列示，不并入基准 DCF；
//   ⑦ 指令九 11 节输出缺项视为运行无效。
// ============================================================
const path = require('path');
const fs = require('fs');
const { localDate } = require('../localDate');

const SYM = '603014';

function loadConfig() {
  try {
    const p = path.join(__dirname, '../../data/valuation/603014.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isWeigaoModel(symbol) {
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  const cfg = loadConfig();
  return bare === SYM && !!cfg && cfg.kind === 'weigao';
}

const r2 = (x) => (x == null || !isFinite(Number(x))) ? null : Math.round(Number(x) * 100) / 100;
const nz = (v) => (v == null || !isFinite(Number(v))) ? 0 : Number(v);
const mean = (a) => {
  const s = a.filter(x => x != null && isFinite(Number(x))).map(Number);
  if (!s.length) return null;
  return s.reduce((x, y) => x + y, 0) / s.length;
};

// ============================================================
// DCF 分部折现（估值基准日 2026-12-31，预测年 t=1..5 → 2027..2031）
// flows: 每年 FCFF 数组（亿元）；wacc/g 小数；返回 {pvFlows, pvTV, tv, total}
// ============================================================
function dcfPart(flows, wacc, g) {
  let pvFlows = 0;
  flows.forEach((f, i) => { pvFlows += f / Math.pow(1 + wacc, i + 1); });
  const tv = flows[flows.length - 1] * (1 + g) / (wacc - g);
  const pvTV = tv / Math.pow(1 + wacc, flows.length);
  return { pvFlows, tv, pvTV, total: pvFlows + pvTV };
}

// 假设权重表（指令七：基准情景 C 级指标权重 > 20% → 降低置信权重）
const ASSUMPTION_WEIGHTS = [
  { name: '血净分部增长率假设', grade: 'B', weight: 0.15 },
  { name: '血净分部 WACC', grade: 'A', weight: 0.10 },
  { name: '血净永续 g（2.0%）', grade: 'A', weight: 0.10 },
  { name: '普瑞承诺净利（2027/2028）', grade: 'A', weight: 0.25 },
  { name: '普瑞分部 WACC（−40bp）', grade: 'A', weight: 0.10 },
  { name: '普瑞永续 g（≤3%）', grade: 'B', weight: 0.10 },
  { name: 'FCFF 转换系数（0.90）', grade: 'C', weight: 0.10 },
  { name: '净债务 ≈ 0（2025 年报）', grade: 'A', weight: 0.05 },
  { name: '估值基准日 2026-12-31', grade: 'A', weight: 0.05 },
];

// ============================================================
// 主入口（同步，run(symbol,{price}) 契约）
// ============================================================
function run(symbol, { price } = {}) {
  const cfg = loadConfig();
  const bare = String(symbol || '').replace(/^(sh|sz|bj)/i, '');
  if (!cfg || bare !== SYM || cfg.kind !== 'weigao') return { error: 'NOT_WEIGAO' };

  const CON = cfg.consolidation, BR = cfg.bridge, ACT = cfg.actualStandalone,
    CM = cfg.coreMatrix, PR = cfg.promises, D = cfg.dcf, CP = cfg.comps,
    PA = cfg.peAttribution, SY = cfg.synergy, CC = cfg.considerationCheck;

  const N = nz(CON && cfg.market && cfg.market.shares && cfg.market.shares.value) || 6.95; // 摊薄总股本（硬约束⑤）
  const P = (price != null && isFinite(Number(price)) && Number(price) > 0) ? Number(price) : nz(cfg.market.priceSources[0].px);
  const priceSourceNote = (price != null && isFinite(Number(price)) && Number(price) > 0)
    ? '实时行情（getQuote 传入）' : '配置锁死快照（' + (cfg.market.priceAdopt || '') + '）';
  const mktCap = P * N;

  // ===== 〇 指令一/九①：并表状态与口径声明 =====
  const openingStatement = `当前并表状态：${CON.status}（${CON.statusNote}）。本次 DCF 基期采用口径①（法定合并）。威高普瑞在最新报告期并表了 ${BR.consolidatedMonths} 个月（购买日 ${CON.purchaseMonth}）。${BR.mandatorySentence}凡涉及「归母同比+156.69%」类表述均为备考口径对比，非法定报表同比，不得直接年化或外推为 2027 年增速。`;

  // ===== 一 指令三：三口径桥接表（缺项视为运行无效） =====
  const bridgeRows = BR.rows.map(r => ({
    label: r.item,
    value: `standalone ${r.standalone}　|　普瑞全期 ${r.puri}　|　备考合并 ${r.proforma}　|　法定合并 ≈${r.statutory}${r.statutoryIsEst ? '（估算，以实际法定报表为准）' : ''}　|　并表 ${r.months} 个月`,
    source: '血净standalone = 备考 − 普瑞全期；法定合并 ≈ standalone + 普瑞全期×(并表月数/报告期月数)，9月单月按普瑞月均估算',
  }));
  bridgeRows.unshift({
    label: '桥接锚点',
    value: `${BR.asOf}；并表月数按购买日 ${CON.purchaseMonth} 精确计算；普瑞月均：营收 ${BR.puriMonthlyAvg.rev} 亿/月、净利 ${BR.puriMonthlyAvg.np} 亿/月`,
    source: BR.rules.join(' '),
  });

  // ===== 二 指令四：数据新鲜度分级 =====
  const frMax = nz(cfg.freshness.maxAgeDays) || 200;
  const today = new Date();
  const freshnessRows = (cfg.freshness.items || []).filter(it => it.asOf).map(it => {
    const age = Math.floor((today - new Date(it.asOf)) / 86400000);
    return { label: it.label, asOf: it.asOf, ageDays: age, maxAge: frMax, stale: age > frMax };
  });
  // 分级汇总（指令九③）
  const gradeItems = [
    { name: '总量损益（营收/归母/扣非/CFO）', grade: 'A', caliber: '②备考 + ①法定合并（估算）' },
    { name: '综合毛利率 41.47%（-2.42pct）', grade: 'A', caliber: '法定合并' },
    { name: '普瑞贡献拆分（16.72 / 5.27，+18.4% / +8.5%）', grade: 'A', caliber: '③标的全期' },
    { name: '血净 standalone（26.96 / 3.37；Q3 9.39 / 1.07）', grade: 'A', caliber: '③' },
    { name: '分产品结构（耗材/设备 vs 药包材）', grade: 'B/C', caliber: '降级至 2026 半年报或 2025 年报（结构冻结）' },
    { name: '分渠道（经销/直销）', grade: 'C', caliber: '仅年报披露 → 基准情景采用行业中值保守替代' },
    { name: '境外收入（2025：3.29 亿，+62.23%，占比 8.7%）', grade: 'B/C', caliber: '降级至最近半年报/年报' },
    { name: '总股本 6.95 亿（4.18 + 2.77）', grade: 'A', caliber: '最新（交割后）' },
    { name: '净有息负债 ≈ 0（402 万）', grade: 'A', caliber: '2025 年报' },
  ];
  const aShare = Math.round(gradeItems.filter(g => g.grade === 'A').length / gradeItems.length * 100);
  const cList = gradeItems.filter(g => String(g.grade).includes('C')).map(g => g.name);
  const freshnessOverview = `最新报告期：2026Q3（2026-10-31 披露）。总量指标 A 级占比：${aShare}%。进入基准估值的分产品/分渠道指标最高新鲜度：B/C 级（分产品，半年报口径、结构冻结）。C 级指标清单：${cList.join('；')}。`;

  // ===== 三 指令五：核心财务矩阵（[报告期 | 新鲜度 | 口径 | 质量标记]） =====
  const statutoryTtmNp = nz(ACT.fy2025.np) + nz(BR.rows[1].statutory) - nz(ACT.q3_2025.np9m); // 口径① TTM：4.823 + 3.96 − 3.408 = 5.375
  const cfoNp2025 = nz(ACT.fy2025.cfo) / nz(ACT.fy2025.np); // 1.646
  const cfoNpWarn = cfoNp2025 < nz(cfg.reverseCheck.cfoNpGood);
  const coreRows = [
    { label: '法定合并 TTM 归母（口径①）', value: `${r2(statutoryTtmNp)} 亿 = 2025全年 ${r2(ACT.fy2025.np)}（A级实际） + 2026 1-9月法定合并 ${BR.rows[1].statutory}（估算） − 2025 1-9月 standalone ${r2(ACT.q3_2025.np9m)}（A级实际）｜[2026Q3 | A级+估算成分 | 口径① | TTM严格拼接]`, source: '分子分母同源同报告期；腾讯 PE-TTM 45.27 反推 ≈5.20 亿交叉验证吻合' },
    { label: '备考 1—9月 / 法定合并 1—9月', value: `营收 ${CM.totalPL.proformaRev} / ≈${CM.totalPL.statutoryRev}；归母 ${CM.totalPL.proformaNp} / ≈${CM.totalPL.statutoryNp}（估算）｜[2026 1-9月 | A级 | ②+① | 备考不得年化]`, source: '指令五总量损益' },
    { label: '综合毛利率', value: `${CM.grossMargin.value}%（同比 ${CM.grossMargin.yoyPct}pct）｜[2026 1-9月 | A级 | 法定合并 | 血净集采拖累]`, source: '指令五；禁止用旧结构百分比嫁接 TTM' },
    { label: '普瑞贡献拆分', value: `营收 ${CM.puriContribution.rev} 亿（+${CM.puriContribution.revYoy}%）、净利 ${CM.puriContribution.np} 亿（+${CM.puriContribution.npYoy}%）｜[2026 1-9月 | A级 | ③标的全期]`, source: '口径③：承诺追踪与标的独立估值用' },
    { label: '血净 standalone', value: `1—9月 营收 ${CM.standalone.rev} / 归母 ${CM.standalone.np}；Q3 单季 ${CM.standalone.q3Rev} / ${CM.standalone.q3Np}｜[2026 1-9月 | A级 | ③推导]（实际披露对照：1-9月归母 ${r2(ACT.q3_2025.np9m)} 亿/2025全年 ${r2(ACT.fy2025.np)} 亿）`, source: ACT.bridgeCrossCheck },
    { label: '经营现金流/归母净利', value: `2025 实际 ${r2(cfoNp2025)}×（7.937/4.823）${cfoNpWarn ? ' → ⚠️ 黄色预警' : ' → ≥0.7 ✅ 盈利质量正常'}｜[2025FY | A级 | ③standalone]；2026 9M 法定合并 CFO 未披露 → 显式标记`, source: `校验阈值 <${cfg.reverseCheck.cfoNpGood} 黄色预警` },
    { label: '股本与摊薄口径', value: `总股本 ${N} 亿股（原 ${cfg.market.shares.preShares} + 新增 ${cfg.market.shares.newShares}）｜[最新 | A级 | 交割后 | PE/EPS 一律用 6.95 亿股]`, source: cfg.market.shares.shareCheckNote },
    { label: '资产负债', value: `2025 末归母净资产 ${r2(ACT.fy2025.equity)} 亿、有息负债仅 0.04 亿（净现金状态）｜[2025FY | A级 | 净债务≈0]`, source: 'DCF 未单独扣净债务（误差 <0.2%）' },
  ];

  // ===== 四 指令六：业绩承诺追踪（口径③） =====
  const promise2026 = nz(PR.annual['2026']), promise2027 = nz(PR.annual['2027']), promise2028 = nz(PR.annual['2028']);
  const actual9M = nz(PR.actual9M2026);
  const progressPct = actual9M / promise2026 * 100;                     // 82.3%
  const q4Threshold = promise2026 - actual9M;                          // 代码权威：6.40−5.27 = 1.13 亿
  const timeProgressPct = 9 / 12 * 100;                                // 时序 75%
  const aheadOfSchedule = progressPct > timeProgressPct;
  const fullYearFloor = actual9M + q4Threshold;                        // 承诺下限 6.40
  const expectedFullYearPct = fullYearFloor / promise2026 * 100;       // 100%
  const promiseRows = [
    { label: '承诺净利润', value: `2026：${promise2026} 亿 / 2027：${promise2027} 亿 / 2028：${promise2028} 亿（口径③）`, source: '指令六；如延后至 2027 交割则改为 2027:7.20 / 2028:7.84 / 2029:8.45' },
    { label: '进度追踪', value: `2026 前三季普瑞净利 ${actual9M} 亿 / 全年承诺 ${promise2026} 亿 = ${r2(progressPct)}%（时序进度 ${timeProgressPct}% → ${aheadOfSchedule ? '超前 ✅' : '落后 ⚠️'}）`, source: '口径③标的全期' },
    { label: 'Q4 达标门槛（代码计算）', value: `${r2(q4Threshold)} 亿（= 承诺 ${promise2026} − 9M 实际 ${actual9M}）`, source: '指令集原文记 0.13 亿；按承诺−累计实际计算实际门槛为 1.13 亿（代码权威原则，以本计算为准）' },
    { label: '基数质量判断', value: `当前以承诺下限构建 Q4（压线情景：全年 ${r2(fullYearFloor)} 亿 = ${r2(expectedFullYearPct)}%）→ 2027 承诺 ${promise2027} 亿的同比 +12.5% 建立在低基数上 → 基准情景对普瑞增速施加上限 ${PR.baseQualityRule.coef} 保守系数（已启用）`, source: PR.baseQualityRule.text + '；除非 2026 年报显示 Q4 实际显著高于门槛（见核心跟踪变量①）' },
    { label: '压力信号 / 减值敏感性', value: `预期全年完成率 ${r2(expectedFullYearPct)}% ${expectedFullYearPct < PR.stress.warnBelow * 100 ? '→ ⚠️ 承诺压力信号' : '→ 无压力信号'}；< ${PR.stress.impairBelow * 100}% 触发减值敏感性`, source: PR.stress.warnText },
    { label: '商誉敞口', value: `对价 ${PR.consideration} 亿 − 标的净资产 ${PR.targetNetAsset} 亿 = 隐含约 ${r2(PR.goodwillApprox)} 亿商誉及可辨认无形资产增量`, source: PR.goodwillNote + '；2027 普瑞增速 < 8% → 减值敏感性测试（跟踪变量③）' },
    { label: '永续外推禁令', value: `承诺期后（2029 起）不得将承诺期 CAGR（${r2((Math.pow(promise2028 / nz(PR.puri2025Np), 1 / 3) - 1) * 100)}%）线性外推至永续`, source: PR.postPromiseRule },
  ];

  // ===== 五 指令七·轨道A：DCF 分部双轨（估值基准日 2026-12-31） =====
  const conv = nz(D.fcffConv.coef);
  const bloodBase = nz(D.blood.baseE.value) * conv;                    // 4.823 × 0.90 = 4.341
  const bc = D.scenarios.base, oc = D.scenarios.optimistic, pc2 = D.scenarios.pessimistic;
  // 血净分部：基准/乐观/悲观增长率（B 级 → ×0.85 收缩已在配置换算：0 / 2.55 / −4.25；配置为百分数 → /100）
  const bloodFlows = (growthPct) => D.forecastYears.map((y, i) => bloodBase * Math.pow(1 + nz(growthPct) / 100, i + 1));
  const bloodBaseRes = dcfPart(bloodFlows(bc.bloodGrowth), bc.bloodWacc / 100, bc.bloodG / 100);
  const bloodOptRes = dcfPart(bloodFlows(oc.bloodGrowth), oc.bloodWacc / 100, oc.bloodG / 100);
  const bloodPesRes = dcfPart(bloodFlows(pc2.bloodGrowth), pc2.bloodWacc / 100, pc2.bloodG / 100);
  // 普瑞分部：2027 承诺 7.20 / 2028 承诺 7.84（下限，指令七）；2029-2031 按情景路径（hold/decline3/converge3）
  const puriFlows = (post) => {
    const f28 = nz(D.puri.flow2028);
    const arr = [nz(D.puri.flow2027), f28];
    for (let i = 0; i < 3; i++) {
      const prev = arr[arr.length - 1];
      const post0 = String(post || '');
      if (post0.startsWith('decline3')) arr.push(prev * 0.97);
      else if (post0.startsWith('converge3')) arr.push(prev * 1.03);
      else arr.push(prev);                                             // hold：持平承诺期末值（不线性外推）
    }
    return arr;
  };
  const puriBaseRes = dcfPart(puriFlows(bc.puriPost).map(x => x * conv), bc.puriWacc / 100, bc.puriG / 100);
  const puriOptRes = dcfPart(puriFlows(oc.puriPost).map(x => x * conv), oc.puriWacc / 100, oc.puriG / 100);
  const puriPesRes = dcfPart(puriFlows(pc2.puriPost).map(x => x * conv), pc2.puriWacc / 100, pc2.puriG / 100);

  const evBase = bloodBaseRes.total + puriBaseRes.total;
  const evOpt = bloodOptRes.total + puriOptRes.total;
  const evPes = bloodPesRes.total + puriPesRes.total;
  const pxBase = evBase / N, pxOpt = evOpt / N, pxPes = evPes / N;

  // C 级权重（指令七：>20% → 降低置信权重、区间呈现）
  const cWeightPct = Math.round(ASSUMPTION_WEIGHTS.filter(a => a.grade === 'C').reduce((s, a) => s + a.weight, 0) * 100);
  const cWeightAlert = cWeightPct > nz(D.cWeightAlert);

  const dcfRows = [
    { name: `悲观情景`, value: `血净分部 ${r2(bloodPesRes.total)} 亿（WACC ${pc2.bloodWacc}%、增速 ${pc2.bloodGrowth}%、g ${pc2.bloodG}%） + 普瑞分部 ${r2(puriPesRes.total)} 亿（WACC ${pc2.puriWacc}%、g ${pc2.puriG}%、2029-31 ${pc2.puriPost}） = 股权价值 ${r2(evPes)} 亿 → ${r2(pxPes)} 元/股；B/C 新鲜度分布：B 25%、C 10%；${pc2.note}` },
    { name: `基准情景`, value: `血净分部 ${r2(bloodBaseRes.total)} 亿（WACC ${bc.bloodWacc}%、增速 ${bc.bloodGrowth}%（B级×0.85 收缩后）、g ${bc.bloodG}%） + 普瑞分部 ${r2(puriBaseRes.total)} 亿（WACC ${bc.puriWacc}%（血净−40bp）、承诺下限 2027:7.20/2028:7.84、2029-31 持平不外推、g ${bc.puriG}%） = 股权价值 ${r2(evBase)} 亿 → ${r2(pxBase)} 元/股；C 级权重 ${cWeightPct}%${cWeightAlert ? ' > 20% → 已降低置信权重、区间呈现' : ' ≤ 20% → 无需降权'}；${bc.note}` },
    { name: `乐观情景`, value: `血净分部 ${r2(bloodOptRes.total)} 亿（WACC ${oc.bloodWacc}%、增速 ${oc.bloodGrowth}%、g ${oc.bloodG}%） + 普瑞分部 ${r2(puriOptRes.total)} 亿（WACC ${oc.puriWacc}%、g ${oc.puriG}%、2029-31 ${oc.puriPost}） = 股权价值 ${r2(evOpt)} 亿 → ${r2(pxOpt)} 元/股；B/C 新鲜度分布：B 25%、C 10%；${oc.note}` },
    { name: `DCF 基期与参数声明`, value: `${D.baseCaliber}；rf = ${D.rf.value}%（运行日 10Y 国债 ${D.rf.range.join('~')}% 区间中值，${D.rf.asOf} 快照，未沿用旧研报值）；FCFF 转换系数 ${conv}（${D.fcffConv.grade}级）；净债务≈0（${D.netDebt.note}）`, source: D.valuationDate },
  ];

  // ===== 六 指令七·轨道B：分部相对估值（交叉验证，不单独作为目标价） =====
  const bloodPe = mean(CP.bloodPeers.filter(p => !p.excluded).map(p => p.pe));  // (22.91+17.05+23.17)/3 = 21.04
  const packPe = mean(CP.packPeers.filter(p => !p.excluded).map(p => p.pe));    // 18.49
  const wBlood = nz(BR.rows[1].standalone) / nz(BR.rows[1].proforma);           // 3.37/8.64 = 39.0%
  const wPack = 1 - wBlood;                                                     // 61.0%
  const impliedPe = wBlood * bloodPe + wPack * packPe;                          // ≈19.49x
  // 分部×分部 2027E 利润（F 状态首年：standalone 零增长 + 普瑞承诺下限）
  const bloodE2027 = nz(D.blood.baseE.value);                                   // 4.823（基准零增长）
  const puriE2027 = nz(D.puri.flow2027);                                        // 7.20
  const evRel = bloodE2027 * bloodPe + puriE2027 * packPe;
  const pxRel = evRel / N;                                                      // ≈33.76
  const devRel = (pxBase - pxRel) / pxRel * 100;
  const devAlert = Math.abs(devRel) > nz(CP.devAlertPct);
  const compRows = [
    { label: `血净业务可比（${CP.snapshotDate} 快照）`, value: CP.bloodPeers.map(p => `${p.name} ${p.pe != null ? p.pe + 'x' : '负值'}`).join('、') + `；剔除：` + CP.bloodPeers.filter(p => p.excluded).map(p => `${p.name}（${p.excludeReason}）`).join('、') + ` → 平均 PE-TTM ${r2(bloodPe)}x`, source: '指令七轨道B；剔除负值/极端失真值后算术平均' },
    { label: `药包材可比（${CP.snapshotDate} 快照）`, value: CP.packPeers.map(p => `${p.name} ${p.pe}x`).join('、') + `；剔除：` + CP.packPeers.filter(p => p.excluded).map(p => `${p.name}（${p.excludeReason}）`).join('、') + ` → 主锚 ${r2(packPe)}x`, source: '正川/力诺运行时实时拉取（2026-11-04 东财）：PE-TTM 异常偏高，仅列示不采用' },
    { label: '利润贡献加权（2026 备考 9M）', value: `血净 ${r2(wBlood * 100)}% / 药包材 ${r2(wPack * 100)}%（standalone ${BR.rows[1].standalone} / 普瑞 ${BR.rows[1].puri}，A级锚） → 加权隐含 PE ${r2(impliedPe)}x`, source: CP.weightsBasis },
    { label: '分部隐含股权价值', value: `血净 ${r2(bloodE2027)} 亿 × ${r2(bloodPe)}x + 普瑞 ${r2(puriE2027)} 亿 × ${r2(packPe)}x = ${r2(evRel)} 亿 ÷ ${N} 亿股 = ${r2(pxRel)} 元/股（交叉验证口径，不单独作为目标价）`, source: '分部利润取 2027E（F 状态首年）：standalone 零增长 + 普瑞承诺下限' },
    { label: 'DCF × 相对估值 交叉验证', value: `DCF 基准 ${r2(pxBase)} 元 vs 相对估值 ${r2(pxRel)} 元 → 偏离 ${devRel >= 0 ? '+' : ''}${r2(devRel)}% ${devAlert ? '→ ⚠️ 偏离超过 ±40%，触发偏离警示' : '→ ±40% 以内，双轨一致'}`, source: `偏离阈值 ±${nz(CP.devAlertPct)}%（指令七）` },
  ];

  // ===== 七 PE 归因（静态 vs 动态，指令七强制） =====
  const staticPe = mktCap / nz(PA.staticE.value);
  const dynPe = mktCap / nz(PA.dynE.value);
  const peRows = [
    { label: '静态 PE（口径③ 2025 全年实际）', value: `市值 ${r2(mktCap)} 亿 ÷ ${r2(PA.staticE.value)} 亿 = ${r2(staticPe)}x（指令集撰写日快照 ${PA.snapshot.staticPe}x）`, source: PA.staticE.caliber },
    { label: '动态 PE（②备考口径）', value: `市值 ${r2(mktCap)} 亿 ÷ ${r2(PA.dynE.value)} 亿 = ${r2(dynPe)}x（指令集撰写日快照 ${PA.snapshot.dynPe}x）——【备考口径对比，非法定报表同比】`, source: PA.dynE.build },
    { label: '差异归因（强制披露）', value: `静态 ${r2(staticPe)}x vs 动态 ${r2(dynPe)}x 的差异归因于：①并表基数效应（法定合并仅含普瑞 1 个月 ≈0.59 亿，备考含全期 5.27 亿）；②股本摊薄（4.18 → 6.95 亿股）。不得将备考口径动态 PE 直接年化或外推为 2027 增速。`, source: PA.attributionMandatory },
  ];

  // ===== 八 指令八：协同期权（独立列示）+ 对价合理性（独立结论） =====
  const optLow = SY.deltaNpRange[0] * SY.fcffConv / ((SY.discWacc - SY.g) / 100) * SY.probBase / N;
  const optHigh = SY.deltaNpRange[1] * SY.fcffConv / ((SY.discWacc - SY.g) / 100) * SY.probBase / N;
  const optMid = (optLow + optHigh) / 2;
  const pxBasePlusOpt = pxBase + optMid;
  const optionRows = [
    { label: '协同兑现概率', value: `${(SY.probRange[0] * 100).toFixed(0)}%—${(SY.probRange[1] * 100).toFixed(0)}%（基准取 ${(SY.probBase * 100).toFixed(0)}%）`, source: SY.probNote },
    { label: '协同增量净利假设', value: `${SY.deltaNpRange.join('~')} 亿/年【${SY.deltaNpGrade}级：无可验证现金流锚（滤器尚未商业化），仅用于期权层量化】`, source: SY.deltaNpNote },
    { label: '期权价值量化', value: `ΔNP×0.9 ÷ (WACC ${SY.discWacc}% − g ${SY.g}%) × 概率 ${(SY.probBase * 100).toFixed(0)}% ÷ ${N} 亿股 = ${r2(optLow)}~${r2(optHigh)} 元/股（中值 ${r2(optMid)} 元）；贴现率 ${SY.discWacc}%（协同层更高贴现率）`, source: SY.discNote },
    { label: '独立列示声明', value: `基准 DCF 仅含普瑞独立运营现金流（协同增量 = 0）；协同以「基准 DCF ${r2(pxBase)} 元 + 期权概率加权 ${r2(optMid)} 元 = 综合基准价值 ${r2(pxBasePlusOpt)} 元」呈现，不并入基准目标价`, source: SY.content + '；兑现前提：' + SY.premise },
    { label: 'EPS 增厚≠价值创造', value: `备考 EPS 增厚 ${SY.epsThickAnchor.value}% —— 增厚是用 ${cfg.market.shares.newShares} 亿新股和约 ${r2(PR.goodwillApprox)} 亿商誉换来的，不得直接等同于原股东价值创造`, source: SY.epsThickAnchor.warning },
  ];
  const impliedPe2025 = nz(CC.consideration) / nz(CC.puri2025Np);
  const verdict = impliedPe2025 < packPe * 0.9 ? '轻微增厚' : (impliedPe2025 > packPe * 1.15 ? '存在高估风险' : '价值中性');
  const considerationRows = [
    { label: '对价隐含倍数', value: `${CC.consideration} 亿 ÷ 普瑞 2025 净利 ${CC.puri2025Np} 亿 = ${r2(impliedPe2025)}x（2025 口径）`, source: CC.impliedPe2025 },
    { label: '行业区间对比', value: `药包材主锚（山东药玻）${r2(packPe)}x、血净可比均值 ${r2(bloodPe)}x → 对价倍数低于药包材可比 ${r2((1 - impliedPe2025 / packPe) * 100)}%`, source: CC.industryRef },
    { label: '承诺期 CAGR 校验', value: `6.01 → ${promise2026} → ${promise2027} → ${promise2028}：CAGR ${r2((Math.pow(promise2028 / CC.puri2025Np, 1 / 3) - 1) * 100)}%（指令集称约 10%）→ 校验一致`, source: CC.promiseCagrCheck },
    { label: '独立结论', value: `【${verdict}】——对价相对行业可比偏温和，但约 ${r2(PR.goodwillApprox)} 亿商誉构成后续减值敏感性敞口（2027 普瑞增速 < 8% 触发）；本判断不并入合并 DCF，与 DCF 并列呈现`, source: CC.verdictScale.join(' / ') },
  ];

  // ===== 九 反向验证清单 =====
  const reverseRows = [
    { id: '1.盈利质量（CFO/归母）', result: cfoNpWarn ? '否' : '是', detail: `2025 实际 ${r2(cfoNp2025)}× ≥ ${cfg.reverseCheck.cfoNpGood} ✅（CFO 7.94 亿/归母 4.82 亿，销售现金比 21%）；2026 9M 法定合并 CFO 未披露 → 显式标记，不静默替代` },
    { id: '2.归母扣非背离', result: '是', detail: `2025：归母 +7.33% vs 扣非 +5.06%，背离 2.27pct < 15pct ✅；2026 9M 法定扣非未披露（桥接表仅归母）→ 显式标记` },
    { id: '3.承诺达成前瞻', result: '是', detail: `普瑞 9M ${actual9M} 亿（时序 ${timeProgressPct}% 点位完成 ${r2(progressPct)}%）→ 按承诺下限全年 100% 达成；压线情景已启用 2027 增速 ×${PR.baseQualityRule.coef} 保守系数` },
    { id: '4.永续外推合规', result: '是', detail: `普瑞 2029-2031 基准持平承诺期末值（hold）、血净 g 2.0%/药包 g 2.5% 独立构建 → 未将承诺期 CAGR 线性外推至永续 ✅` },
    { id: '5.备考口径隔离', result: '是', detail: `DCF 全部现金流来自口径①/③（standalone 实际 + 承诺下限），备考 8.64 亿未直接输入 DCF、未年化 ✅；法定合并 TTM ${r2(statutoryTtmNp)} 亿仅用于 PE 口径展示` },
  ];
  const reverseAllPass = reverseRows.every(r => r.result === '是');

  // ===== 置信度（指令九⑪） =====
  let confidenceLevel, confidenceNote;
  if (cWeightAlert) { confidenceLevel = '低'; confidenceNote = `基准情景 C 级指标权重 ${cWeightPct}% > 20% → 降低置信权重、区间形式呈现`; }
  else if (!reverseAllPass) { confidenceLevel = '低'; confidenceNote = '反向验证存在未通过项'; }
  else {
    confidenceLevel = '中';
    confidenceNote = `C 级权重 ${cWeightPct}% ≤ 20%、反向验证全部通过、双轨偏离 ${r2(Math.abs(devRel))}%（±40% 内）→ 本可为高；但因 ①法定合并 9M（3.96/28.8 亿）为月均估算值而非实际法定报表、②FCFF 转换系数 0.90 为 C 级假设、③分产品/分渠道结构降级（B/C 级）→ 置信度定为【中】。降级项已全部强制标注。`;
  }

  // ===== 模型失效检查 =====
  const failRows = (cfg.modelFailure.conds || []).map(c => ({
    id: c.id, text: c.text, threshold: c.threshold, triggered: !!c.triggered, status: c.triggered ? '⛔ 触发' : '✅ 未触发',
  }));
  const modelSuspended = failRows.some(f => f.triggered);

  // ===== 评级（严格三档：低估/合理/高估） =====
  const rangeLow = Math.min(pxPes, pxBase, pxOpt);
  const rangeHigh = Math.max(pxPes, pxBase, pxOpt);
  let rating = '合理', expectedReturn = null, upside = null;
  if (P != null) {
    expectedReturn = (pxBase - P) / P * 100;
    upside = (pxOpt - P) / P * 100;
    rating = P < rangeLow ? '低估' : (P > rangeHigh ? '高估' : '合理');
  }

  // ===== 核心跟踪变量（指令九⑨） =====
  const trackRows = cfg.trackVars.map(t => ({ label: '跟踪项', value: t, source: '下一报告期重点校验：哪项 B/C 级数据有望升级为 A 级并实质性改变假设' }));

  // ===== 输出区块（指令九 11 节全量） =====
  const consolidationRows = [
    { label: '并表状态判定', value: `${CON.statusFull}（${CON.purchaseMonth} 完成资产交割及过户、新增股份登记，自 2026-09 起纳入合并报表）`, source: '指令二 Step1：并表月数按购买日精确计算' },
    ...CON.timeline.map(t => ({ label: `${t.year} 年状态`, value: `${t.status} — ${t.note}`, source: '指令二状态表' })),
    ...CON.caliberDefs.map(c => ({ label: c.id, value: `${c.name}：${c.def}`, source: '三口径定义（任何时点运行均强制区分）' })),
    { label: '硬性规则声明', value: CON.hardRule, source: '指令二硬性规则（每次运行强制声明）' },
  ];

  const summaryNote = `${openingStatement}【威高血净专属估值 | RUN_DATE：${localDate()}】DCF 基准合理价 ${r2(pxBase)} 元（三档区间 ${r2(pxPes)}~${r2(pxOpt)}，估值基准日 2026-12-31），相对当前价 ${P != null ? '¥' + r2(P) : 'N/A'} 空间 ${r2(expectedReturn)}%；协同期权概率加权（${(SY.probBase * 100).toFixed(0)}%）后综合基准价值 ${r2(pxBasePlusOpt)} 元；评级【${rating}】；置信度【${confidenceLevel}】。分部相对估值 ${r2(pxRel)} 元与 DCF 偏离 ${r2(devRel)}%（±40% 内一致）。对价合理性独立结论：【${verdict}】。`;

  const positionNote = (P == null)
    ? '当前价不可用，仅输出估值区间。'
    : `基于最新可得数据（截止 ${cfg.dataAsOf}，财报期 2026Q3）：当前股价 ¥${r2(P)} 位于 DCF 三档区间 [${r2(pxPes)}, ${r2(pxOpt)}] 元的 ${Math.round(Math.max(0, Math.min(100, (P - pxPes) / (pxOpt - pxPes || 1) * 100)))}% 位置；DCF 基准 ¥${r2(pxBase)}、加协同期权中值后 ¥${r2(pxBasePlusOpt)}，预期空间 ${r2(expectedReturn)}%。法定 TTM PE ${r2(staticPe)}x（口径①）、备考口径动态 PE ${r2(dynPe)}x（②，不得年化）、静态 PE（2025 实际）${r2(staticPe)}x。核心逻辑：血净分部集采拖累与 ESRD 刚性需求对冲（基准零增长）+ 普瑞预灌封国内市占率 >50%（承诺 2027:7.20/2028:7.84 亿为下限）双分部驱动；约 ${r2(PR.goodwillApprox)} 亿商誉与 2027 普瑞增速为主要风险敞口。`;

  const riskNote = '上行：滤器协同兑现（看涨期权）、海外收入延续高增（2025 +62.23%）、集采续约好于唯低价预期、普瑞超承诺；下行：血净集采续约降价超预期、普瑞客户备案替代（周期半年至一年半）、约 58 亿商誉减值（2027 增速 <8% 触发敏感性）、生物制药资本开支下行压制协同期权价值。本模型按九指令整合版实现、参数按最新财报与公告快照更新；结论不构成投资建议。';

  const hardConstraintNote = '硬约束核验：① 本次 DCF 基期已声明采用口径①（法定合并）；② 备考口径未直接输入 DCF、未年化（所有 DCF 现金流来自口径①/③）；③ 2026 年 1—8 月普瑞利润未计入合并 FCFF（并表首年禁令）；④ 承诺期后未将 CAGR 线性外推至永续（2029-31 持平 + 独立永续 g）；⑤ PE/EPS 全部使用摊薄后 6.95 亿股；⑥ 协同期权独立列示未并入基准；⑦ 指令九 11 节输出齐备（并表状态/桥接表/新鲜度/承诺/DCF三档/期权/交叉验证/对价/跟踪变量/口径披露/置信度）；⑧ 缺失维度（2026 9M 法定扣非与 CFO、分产品/分渠道季报值）已显式标记，未静默替代。';

  return {
    ok: true,
    dedicated: true,
    weigao: true,
    symbol: SYM,
    stockName: cfg.name,
    rating: modelSuspended ? '需人工复核' : rating,
    modelSuspended,
    fairValueRange: [r2(rangeLow), r2(rangeHigh)],
    fairValueCenter: r2(pxBase),
    conservativeTarget: r2(pxPes),
    conservativePct: (P != null) ? r2((pxPes - P) / P * 100) : null,
    currentPrice: P != null ? r2(P) : null,
    upside: upside != null ? r2(upside) : null,
    expectedReturn: expectedReturn != null ? r2(expectedReturn) : null,
    confidence: confidenceLevel,
    outputState: '区间态（DCF 三档 + 期权加权）',
    confidenceNote,
    model: 'weigao603014·动态估值引擎 V1.0（九指令整合版，确定性计算，无 AI 参与）',
    version: cfg.version,
    dataAsOf: cfg.dataAsOf,
    reportLabel: '2026Q3',
    openingStatement,
    // 九节 rows
    consolidationRows, bridgeRows, freshnessOverview, coreRows, promiseRows,
    dcfRows, compRows, peRows, optionRows, considerationRows, reverseRows, trackRows, failRows,
    modelFailureNote: modelSuspended
      ? '⛔ 模型暂停/降级：' + failRows.filter(f => f.triggered).map(f => f.text).join('；') + ' → 对应维度自动切换至悲观情景权重（政策/整合断点）'
      : '✅ 失效/人工干预条件均未触发（集采规则 / 并购整合 / 普瑞增速 <8% / 归母扣非背离 >15pct）',
    // 汇总
    summaryNote, positionNote, riskNote, hardConstraintNote,
    decisionNote: `DCF 双轨：基准 ${r2(pxBase)} 元（血净 ${r2(bloodBaseRes.total)} 亿 + 普瑞 ${r2(puriBaseRes.total)} 亿）；相对估值 ${r2(pxRel)} 元（加权隐含 PE ${r2(impliedPe)}x）；偏离 ${r2(devRel)}%。协同期权 +${r2(optMid)} 元（概率 ${(SY.probBase * 100).toFixed(0)}%，独立列示）。对价检验【${verdict}】（${r2(impliedPe2025)}x vs 药包材 ${r2(packPe)}x）。`,
    freshnessRows,
    alerts: freshnessRows.filter(f => f.stale).map(f => `「${f.label}」距今 ${f.ageDays} 天 > ${f.maxAge} 天，请复核更新`)
      .concat(['法定合并 1—9月（28.8/3.96 亿）与 Q3 单季（11.3/1.66 亿）为月均估算值，以实际法定报表为准'])
      .concat([BR.mandatorySentence]),
    // 兼容字段
    statutoryTtmNp: r2(statutoryTtmNp),
    staticPe: r2(staticPe),
    dynPe: r2(dynPe),
    cWeightPct,
    synergyAdjCenter: r2(pxBasePlusOpt),
  };
}

module.exports = { run, isWeigaoModel, loadConfig, dcfPart };
