/**
 * lib/ai/companyDeep.js —— 公司深度分析（CFA 框架统一模块，20260914f 新建）
 * --------------------------------------------------------------------------
 * 背景：原「公司综合介绍（分析①）+ 供应链与成本（分析②）+ 主要产品&客户（分析③）」
 * 三个独立 AI 模块，合并为**单一**统一分析引擎，严格遵循用户投喂的
 * 「资深证券分析师（CFA）执行引擎」框架：
 *   一、公司一句话定位与投资摘要
 *   二、公司基本面画像（基础档案 / 产品服务与图片位 / 文化品牌 / 专利创新 / 实控人 / 近10年重大事件时间线）
 *   三、供应链与成本（产业链定位 / 主要原材料与供应商 / 成本传导与敏感性 / 成本控制方法 / 成本风险结论）
 *   四、客户与竞争（主要客户与集中度 / 竞争对手与格局图谱 / 对手价格变动影响模拟 / 竞争风险与定价权结论）
 *   五、跨模块联动结论
 *   六、风险提示
 *   七、数据来源、日期与缺失说明
 *
 * 全局规则（写进 prompt，由 LLM 遵守；确定性字段由代码兜底）：
 *   1) 数据优先级：年报/公告/ESG/交易所/监管 > 权威财经媒体/行业库/券商研报 > 第三方网站；关键结论标注来源与日期。
 *   2) 时间范围：财务取近5年、重大事件取近10年、实时数据标注抓取日期。
 *   3) 缺失写「未披露」/「未检索到」；无法确认写「待核实」；不得编造。
 *   4) 配图：有图片能力则插图；否则输出「图片位：…；检索关键词：…；建议来源：…」。
 *   5) 输出：先结论后论据、先定量后定性、风险单列、区分「事实」与「推断」。
 *   6) 超行业正常范围的指标须结合行业分位修正，不能只用绝对阈值。
 *
 * 架构原则（与项目一致）：
 *   - 代码权威：确定性阈值（成本敏感型 50%、传导弱 0.5、传导强 0.8、客户集中 30%、前五 50%）
 *     由代码在校验层判定并写入 flags，不交由 LLM 拍脑袋；
 *   - **主路径固定走联网模型（modelWeb）**：信息分析天生依赖大量 F10 之外的资料
 *     （成立/上市日期、企业文化、专利、实控人持股、近10年重大事件、前五大客户、竞争对手），
 *     本地 F10 事实作为**补充上下文**注入（确定的数字不必让模型猜）；
 *   - 联网失败且本地事实可用时降级为本地模型纯推理（保证不空白）；
 *   - **缓存永久有效**：简介类资料更新频率极低，仅当 force（用户点「重新搜索」）才重跑；
 *   - 图片走 ai/images.attachImage（AI 直链优先，Commons 兜底）。
 *   - 20260914h：由「本地优先双模式 + TTL 过期」改为「固定联网 + 永久缓存」。
 */
const fs = require('fs');
const path = require('path');
const { getCompanyProfile } = require('../shareholderData');
const factStore = require('../factStore');
const { CACHE_DIR, PROVIDERS, ensureDirs, loadConfig } = require('./config');
const { callLLM, pickModelFor, pickLocalSummaryModel, guardCtxBudget, extractJson } = require('./llm');
const { attachImage } = require('./images');

// ============ 统一 system prompt（联网模式）============
const DEEP_SYSTEM_PROMPT = `你是一名资深证券分析师，具备 CFA 资质，有 10 年以上 A 股全行业公司研究经验，擅长公司基本面、产业链、成本传导、竞争格局和重大事件研究。你现在是「股票投资分析 AI 工作台」的执行引擎，需按固定框架完成分析。

【全局规则 · 必须严格遵守】
1) 数据优先级：公司年报、公告、ESG 报告、交易所披露、监管文件优先；其次权威财经媒体、行业数据库、券商研报；最后第三方网站。每个关键结论必须标注来源与日期。
2) 时间范围：财务数据优先取近 5 年，重大事件取近 10 年，实时数据必须标注抓取日期。
3) 数据缺失时明确写「未披露」或「未检索到」，不得编造。无法确认的内容标注「待核实」。
4) 配图：你不具备直接插图能力，因此每个需要配图的位置输出「图片位：图片主题；检索关键词：…；建议来源：公司官网、年报、ESG报告、行业数据库、财经网站」。产品/服务与竞争对手可额外给出 imageUrl（图片直链，找不到填 ""）与 imageQuery（搜图关键词）。
5) 输出规则：先结论后论据，先定量后定性，风险提示单独列出。所有判断要区分「事实」与「推断」（用「【事实】」「【推断】」前缀标注）。
6) 若某项指标超过行业正常范围，要结合行业分位修正，不能只用绝对阈值。

【只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记】
{
 "oneLiner":"公司一句话定位",
 "investmentSummary":"投资摘要（3-5句，含多空要点与核心结论，先结论后论据）",
 "profile":{
   "basicInfo":{
     "fullName":"公司全称","officeLocation":"办公地点(城市+区/具体地址)",
     "registeredAddress":"注册地址","foundedDate":"成立日期(YYYY-MM-DD)","listedDate":"上市日期(YYYY-MM-DD)",
     "industry":"所属行业","employeeCount":"员工人数(最新年报)","execCount":"高管人数",
     "execAvgSalary":"高管平均薪酬(按高管薪酬总额÷高管人数；若总额未披露则用前三名高管薪酬均值替代)",
     "execSalaryBasis":"薪酬口径说明(如'高管薪酬总额÷高管人数'或'前三名高管均值替代')"
   },
   "productsServices":[{"name":"主营产品/服务名","content":"服务内容","revenueShare":"收入占比(如'35.5%'或'未披露')","scenario":"应用场景","customerType":"主要客户类型","imageUrl":"图片直链(找不到填\"\")","imageQuery":"搜图关键词","imageNote":"图片位：图片主题；检索关键词：…；建议来源：…"}],
   "culture":{"mission":"经营宗旨","culture":"企业文化","vision":"公司愿景","values":"核心价值观","brands":["旗下知名品牌"],"trademarks":"商标情况"},
   "patents":{"total":"专利总数","inventionRatio":"发明专利占比","yoy3y":"近3年专利年均增速","industryPercentile":"行业分位数(无法获取则填'行业分位未获取')"},
   "controller":{"hasController":"有/无","name":"实控人姓名或'国有控股'/'股权分散'/'无实际控制人'","holdingPct":"持股比例","controlPath":"控制路径","concertParties":["一致行动人"],"background":"背景","pledge":"质押情况","governanceRisk":"潜在治理风险","equityStructure":"若无实控人则说明股权结构特征"},
   "majorEvents":[{"date":"YYYY-MM 或 YYYY","category":"公司治理/经营/资本/风险/行业政策(五类之一)","title":"事件标题","desc":"事件简述","impactLevel":"高/中/低","impactOn":"对业绩/估值/股价的可能影响"}]
 },
 "supplyChain":{
   "chainPosition":"上游/中游/下游(可括号说明,如'中游(电池制造)')",
   "positionBasis":"判断依据(原材料依赖度/产品用途/客户类型/毛利率特征/议价能力)",
   "materials":[{"name":"主要原材料/服务名","desc":"在经营中的作用","supplierTop5":"前五大供应商名称(各+采购占比,无则'未披露')","procureShare":"采购占比","supplyContent":"供应内容","stability":"合作稳定性","imageUrl":"","imageQuery":"","imageNote":"图片位：…"}],
   "directMaterialRatio":"直接材料占营业成本比例(如'58%')",
   "conductionCoef":0.0,
   "grossMarginSensitivity":0.0,
   "sensitivityMatrix":[{"priceChange":"+5%","grossMargin":"对毛利率影响","netProfit":"对净利润影响","cashFlow":"对现金流影响"},{"priceChange":"-5%"},{"priceChange":"+10%"},{"priceChange":"-10%"},{"priceChange":"+20%"},{"priceChange":"-20%"},{"priceChange":"+30%"},{"priceChange":"-30%"}],
   "sensitivityNote":"敏感性假设说明",
   "costControl":[{"type":"纵向整合/集中采购/供应商结构优化/替代材料/套期保值/工艺改进/规模效应/废料回收(八类之一)","practice":"具体做法","costImpact":"对成本的影响"}],
   "costRiskLevel":"高/中/低",
   "costRiskReason":"成本风险等级理由"
 },
 "competition":{
   "customers":[{"name":"前五大客户名或客户类型","revenueShare":"收入占比(如'32%')","concentration":"客户集中度","industryPercentile":"行业分位数(无则'行业分位未获取')","imageUrl":"","imageQuery":"","imageNote":"图片位：…"}],
   "competitors":[{"name":"竞争对手名","marketShare":"市场份额","productOverlap":"产品重叠度","customerOverlap":"客户重叠度","regionOverlap":"区域重叠度","priceStrategy":"价格策略标签(成本领先/差异化/聚焦细分)","imageUrl":"","imageQuery":"","imageNote":"图片位：…"}],
   "landscapeGraph":"竞争格局图谱文字描述(以本公司为核心节点，展示主要竞争对手、产品重叠关系、客户重叠关系、价格策略标签)",
   "priceWarSimulation":{
     "homogeneity":"产品同质化程度(高/中/低)",
     "switchingCost":"客户转换成本(高/中/低)",
     "brandPremium":"品牌溢价(高/中/低)",
     "channelStickiness":"渠道粘性(高/中/低)",
     "scenarios":[{"strategy":"维持原价","revenue":"收入变化","grossMargin":"毛利率变化","netProfit":"净利润变化","marketShare":"市场份额变化"},{"strategy":"跟随降价"},{"strategy":"部分降价"}]
   },
   "competitionRiskLevel":"高/中/低",
   "pricingPower":"公司定价权判断(强/中/弱+理由)",
   "riskSignals":["建议关注的风险信号"]
 },
 "linkage":"跨模块联动结论(核心原材料→供应链；成本传导弱→价格战风险；对手扩产/降价/并购/技术突破→本公司竞争预警；监管处罚/实控人变更/重大诉讼/退市风险→置顶提示)",
 "topWarning":"需置顶提示的重大风险(若无则填'无')",
 "riskNotes":["风险提示（单独列出，含触发条件）"],
 "dataSources":[{"item":"结论/数据项","source":"来源(年报/公告/ESG/交易所/研报/财经网站等)","date":"日期"}],
 "missingNotes":["数据来源、日期与缺失说明：逐项说明哪些字段未披露/未检索到/待核实"]
}

【框架要求】
第一，公司基本面画像：抓取基础档案（全称/办公地点/注册地址/成立日期/上市日期/所属行业/员工人数/高管人数/高管平均薪酬）；介绍产品服务（主营产品、服务内容、收入占比、应用场景、主要客户类型）并给图片位；介绍经营宗旨、企业文化、愿景、核心价值观、知名品牌与商标；抓取专利信息（总数/发明专利占比/近3年增速/行业分位）；分析实控人（有无、姓名、持股比例、控制路径、一致行动人、背景、质押、治理风险）；建立近10年重大事件雷达（按公司治理/经营/资本/风险/行业政策五类，每条标时间、类型、影响程度高/中/低及对业绩估值股价的影响）。
第二，供应链与成本：先判断产业链上/中/下游（依据原材料依赖度、产品用途、客户类型、毛利率特征、议价能力）；找出主要原材料/服务对应供应商（前五大名称、采购占比、供应内容、合作稳定性）并给图片位；分析原材料价格变动对营业成本的影响（直接材料占营业成本比例→成本传导系数→毛利率敏感系数→敏感性矩阵，至少覆盖价格变动 ±5%/±10%/±20%/±30% 情景，说明对毛利率、净利润、现金流的影响）；分析成本控制方法（纵向整合/集中采购/供应商结构优化/替代材料/套期保值/工艺改进/规模效应/废料回收）；输出成本风险等级高/中/低及理由。
第三，客户与竞争格局：找出主要客户（前五大名称、收入占比、客户集中度、行业分位）并给图片位；找出主要竞争对手（按市场份额/产品重叠度/客户重叠度/区域重叠度识别）并给配图介绍；给出竞争格局图谱（以本公司为核心节点）；分析竞争对手产品价格变动对公司营业收入的影响（先判断同质化程度、客户转换成本、品牌溢价、渠道粘性，再模拟维持原价/跟随降价/部分降价三种策略下的收入、毛利率、净利润、市场份额变化）；输出竞争风险等级、公司定价权判断、建议关注的风险信号。
跨模块联动：画像中识别出的核心原材料自动进入供应链分析；成本传导弱的公司在竞争分析中重点检查价格战风险；竞争对手出现扩产/降价/并购/技术突破等事件时自动触发竞争风险预警；近10年重大事件中若出现监管处罚/实控人变更/重大诉讼/退市风险，必须在最终摘要中置顶提示。

补充要求：
- 敏感性矩阵的 8 个情景（±5%/±10%/±20%/±30%）必须齐全，priceChange 字段写如 "+5%"、"-10%"。
- costControl.type 必须从八类中选，priceWarSimulation.scenarios 的三种策略必须齐全。
- 若为金融/服务类公司（银行、保险、证券、信托等）：materials 改为关键成本项（资金成本/付息压力/人力成本/风控合规成本/赔付成本），suppliers 改为业务合作渠道或机构；chainPosition 按「资金端—金融中介—客户端」定位；此类公司高负债属经营常态，不要描述为风险。
- 不确定的数字一律写「未披露」「未检索到」或「待核实」，严禁编造。`;

// ============ 统一 system prompt（本地模式，不联网、零联网费）============
const DEEP_LOCAL_SYSTEM_PROMPT = `你是一名资深证券分析师（CFA 资质，10 年以上 A 股研究经验）。你没有联网能力，也不需要联网。下方「本地事实」由系统从东方财富 F10 预先下载（公司概况、主营业务、主要产品、主营构成明细含营收占比/毛利率/成本占比），是本轮分析唯一允许引用的事实来源。

【全局规则】先结论后论据，先定量后定性，风险单列；区分「事实」与「推断」；凡本地事实未提供的字段一律填「未披露」或「未检索到」，严禁用训练记忆编造（尤其专利数、重大事件、高管薪酬、前五大供应商/客户、竞争对手、价格、行业分位）。

【只输出一段严格 JSON，不要任何额外说明或 Markdown 代码块标记】，结构与联网模式完全一致的以下字段（未提供的用「未披露」/空数组，但结构必须在）：
{"oneLiner":"","investmentSummary":"","profile":{"basicInfo":{"fullName":"","officeLocation":"","registeredAddress":"未披露","foundedDate":"未披露","listedDate":"未披露","industry":"","employeeCount":"","execCount":"未披露","execAvgSalary":"未披露","execSalaryBasis":"未披露"},"productsServices":[{"name":"来自主营构成","content":"","revenueShare":"引用真实占比","scenario":"未披露","customerType":"未披露","imageUrl":"","imageQuery":"搜图关键词(品牌+产品)","imageNote":"图片位：…"}],"culture":{"mission":"未披露","culture":"未披露","vision":"未披露","values":"未披露","brands":[],"trademarks":"未披露"},"patents":{"total":"未披露","inventionRatio":"未披露","yoy3y":"未披露","industryPercentile":"行业分位未获取"},"controller":{"hasController":"未披露","name":"控股股东(本地事实提供才填)","holdingPct":"未披露","controlPath":"未披露","concertParties":[],"background":"未披露","pledge":"未披露","governanceRisk":"未披露","equityStructure":""},"majorEvents":[]},"supplyChain":{"chainPosition":"上/中/下游(据行业与业务性质判断并给理由)","positionBasis":"基于毛利率与主营构成的推断","materials":[{"name":"成本占比最高的业务/成本项","desc":"","supplierTop5":"未披露","procureShare":"未披露","supplyContent":"","stability":"未披露","imageUrl":"","imageQuery":"","imageNote":"图片位：…"}],"directMaterialRatio":"未披露","conductionCoef":0,"grossMarginSensitivity":0,"sensitivityMatrix":[],"sensitivityNote":"本地事实不含原材料价格，无法构建敏感性矩阵；建议联网分析","costControl":[{"type":"从八类中选","practice":"","costImpact":""}],"costRiskLevel":"中","costRiskReason":""},"competition":{"customers":[],"competitors":[],"landscapeGraph":"未披露","priceWarSimulation":{"homogeneity":"未披露","switchingCost":"未披露","brandPremium":"未披露","channelStickiness":"未披露","scenarios":[]},"competitionRiskLevel":"中","pricingPower":"未披露","riskSignals":[]},"linkage":"","topWarning":"","riskNotes":[],"dataSources":[{"item":"公司概况/主营构成","source":"东方财富 F10","date":""}],"missingNotes":[]}

要求：productsServices 从主营构成选 3-6 个核心业务，revenueShare 必须引用真实占比数字；financial/服务类公司按金融服务框架；只输出 JSON。`;

// ============ 确定性校验层（代码权威：阈值由代码判定，不交给 LLM）============
function toNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const m = String(v).replace(/[,，%％\s]/g, '').match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
}

/**
 * 对 LLM 返回的结构做确定性校验与兜底，产出 flags（代码判定，非 LLM）。
 * 规则来自用户框架：
 *   - 直接材料占营业成本 > 50%  → 成本敏感型公司
 *   - 成本传导系数 < 0.5        → 成本传导弱，毛利率容易受挤压
 *   - 成本传导系数 > 0.8        → 成本传导强，具备较强提价能力
 *   - 第一大客户收入占比 > 30%  → 客户集中度风险高
 *   - 前五大客户合计 > 50%      → 收入依赖风险高
 *   - 重大事件含监管处罚/实控人变更/重大诉讼/退市风险 → 置顶提示
 */
function validateDeep(parsed) {
  const flags = [];
  const sc = (parsed && parsed.supplyChain) || {};
  const comp = (parsed && parsed.competition) || {};

  const dmr = toNum(sc.directMaterialRatio);
  if (dmr != null && dmr > 50) flags.push({ kind: 'cost-sensitive', level: 'warn', text: `成本敏感型公司（直接材料占营业成本 ${dmr}% > 50%）` });

  const cc = toNum(sc.conductionCoef);
  if (cc != null && cc < 0.5) flags.push({ kind: 'weak-conduction', level: 'warn', text: `成本传导弱（系数 ${cc} < 0.5），毛利率容易受挤压，需重点关注价格战风险` });
  else if (cc != null && cc > 0.8) flags.push({ kind: 'strong-conduction', level: 'good', text: `成本传导强（系数 ${cc} > 0.8），具备较强提价能力` });

  const customers = Array.isArray(comp.customers) ? comp.customers : [];
  const firstShare = customers.length ? toNum(customers[0].revenueShare) : null;
  if (firstShare != null && firstShare > 30) flags.push({ kind: 'customer-concentration', level: 'warn', text: `客户集中度风险高（第一大客户收入占比 ${firstShare}% > 30%）` });
  const shareNums = customers.map(c => toNum(c.revenueShare)).filter(v => v != null);
  if (shareNums.length) {
    const sum = shareNums.reduce((a, b) => a + b, 0);
    if (sum > 50) flags.push({ kind: 'revenue-dependence', level: 'warn', text: `收入依赖风险高（前五大客户合计 ${Math.round(sum * 10) / 10}% > 50%）` });
  }

  // 置顶风险：近10年重大事件中的红线事件
  const events = ((parsed && parsed.profile && parsed.profile.majorEvents) || []);
  const redlineRe = /监管处罚|行政处罚|处罚|实控人变更|控制权变更|重大诉讼|诉讼|退市|退市风险|立案|问询|违规|被查/;
  const redlines = events.filter(e => redlineRe.test(String((e && e.title) || '') + String((e && e.desc) || '')));
  if (redlines.length) {
    const t = redlines.slice(0, 3).map(e => `${e.date || ''}${(e.date && e.title) ? ' ' : ''}${e.title || ''}`).join('；');
    flags.push({ kind: 'redline', level: 'danger', text: `须置顶提示：近10年重大事件包含监管/治理红线（${t}）` });
  }
  return flags;
}

// 合理性检查：敏感性矩阵缺失/不全时，用直接材料占比与传导系数给出确定性兜底说明
const EXPECTED_PRICE_CHANGES = ['+5%', '-5%', '+10%', '-10%', '+20%', '-20%', '+30%', '-30%'];
function normalizeSensitivityMatrix(sc) {
  const arr = Array.isArray(sc.sensitivityMatrix) ? sc.sensitivityMatrix : [];
  const byKey = {};
  arr.forEach(r => { if (r && r.priceChange) byKey[String(r.priceChange).replace(/\s/g, '')] = r; });
  const out = EXPECTED_PRICE_CHANGES.map(pc => byKey[pc] || { priceChange: pc, grossMargin: '未提供', netProfit: '未提供', cashFlow: '未提供' });
  return out;
}

async function analyzeCompanyDeep({ symbol, stockName, industry, force, companyName, companyType }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_companyDeep.json`);
  let name = stockName || companyName;
  let ind = industry;
  if (!name) {
    try {
      const prof = await getCompanyProfile(symbol);
      name = prof.companyName;
      ind = prof.industry;
    } catch {}
  }
  // 本地事实：F10 概况 + 主营构成免费预下载（20260903f 降费）
  // 20260914h：信息分析改为「固定联网模型 + 永久缓存」——
  //   ① 联网模型负责 F10 未覆盖的大量字段（成立/上市日期、企业文化、专利、实控人持股、
  //      近10年重大事件、前五大客户、竞争对手等）；
  //   ② 本地 F10 事实（全称/行业/员工数/主营构成精确数字）作为**补充上下文**一并注入，
  //      让联网模型不必猜这些本可确定的数字；
  //   ③ 缓存永久有效（简介类资料更新频率极低），仅当 force（用户点「重新搜索」）才重跑。
  const localCtx = await factStore.buildCompanyFactsContext(symbol).catch(() => ({ ok: false }));
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      // 永久缓存：不再按 TTL 过期（简介资料变更频率低，用户手动「重新搜索」才刷新）
      if (cached && cached.date) return { success: true, ...cached, cached: true };
    } catch {}
  }

  const isFinancial = /银行|保险|证券|信托|期货|基金|资管|财富|金控|租赁|财务|再保险|寿险|财险|人寿|太保|人保/.test(ind || '') || /金融/.test(ind || '');
  const finNote = isFinancial ? ' 注意：该公司属金融服务类，请严格按金融服务框架分析（关键成本项为资金成本/人力成本/风控合规成本，业务合作渠道而非制造业原材料供应商）。' : '';
  const isProduct = companyType === 'growth' || /科技|医药|生物|医疗|电子|半导体|消费|食品|化工|材料|制造|新能源|汽车/.test(ind || '');

  // 本地事实作为补充上下文（F10 里确定的数字不必让联网模型去猜）
  const factBlock = localCtx.ok && localCtx.text
    ? `\n\n【以下是本地已抓取的东财 F10 事实（公司概况 + 主营构成，数字可直接采用，其余字段请联网检索补充）】\n${localCtx.text}\n`
    : '';
  const askBody = `按 CFA 统一框架输出该公司的深度分析 JSON（一、公司一句话定位与投资摘要；二、基本面画像：基础档案/产品服务与图片位/文化品牌/专利创新/实控人/近10年重大事件时间线；三、供应链与成本：产业链定位/主要原材料与供应商/成本传导与敏感性矩阵(±5%/±10%/±20%/±30%)/成本控制方法/成本风险结论；四、客户与竞争：主要客户与集中度/竞争对手与格局图谱/对手价格变动影响模拟(维持原价/跟随降价/部分降价)/竞争风险与定价权结论；五、跨模块联动结论；六、风险提示；七、数据来源、日期与缺失说明）。${finNote}`;

  // —— 主路径：固定联网模型（信息分析天生依赖大量外部资料）——
  let modelPick = pickModelFor(cfg, 'web');
  let mode = 'web';
  let factAnchor = localCtx.ok ? localCtx.anchor : null;
  const webMessages = [
    { role: 'system', content: DEEP_SYSTEM_PROMPT },
    { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。${isProduct ? ' 该公司为产品型公司，产品与成本分析尤为关键。' : ''}请联网搜索后，${askBody}${factBlock}` },
  ];

  let messages = webMessages;

  try {
    let content;
    try {
      content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch, timeoutMs: 240000 }); // 七段统一输出（画像+供应链+客户竞争，含图片位），上下文与输出均为全项目最长，放宽至 4 分钟
    } catch (webErr) {
      // —— 兜底：联网失败且本地事实可用时，降级为本地模型纯推理（保证有内容，不空白）——
      if (localCtx.ok) {
        modelPick = pickLocalSummaryModel(cfg);
        mode = 'local';
        const ctxLen = DEEP_LOCAL_SYSTEM_PROMPT.length + String(localCtx.text || '').length + 400;
        modelPick = guardCtxBudget(cfg, modelPick, ctxLen, 'AI公司深度', symbol);
        messages = [
          { role: 'system', content: DEEP_LOCAL_SYSTEM_PROMPT },
          { role: 'user', content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。${isProduct ? ' 该公司为产品型公司，产品与成本分析尤为关键。' : ''}\n\n${localCtx.text}\n\n请严格基于以上本地事实输出公司深度分析 JSON（不要联网、不要编造未提供的字段）。${finNote}` },
        ];
        content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: false, timeoutMs: 240000 });
      } else {
        throw webErr;
      }
    }
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') {
      return { success: false, error: 'PARSE_ERROR', message: 'AI 返回格式异常，无法解析公司深度分析。', raw: content.slice(0, 500) };
    }

    // ---- 归一化 + 图片下载（对需要配图的数组逐项 attachImage，仅使用 AI 直链；禁用 Commons 兜底）----
    // 20260915：Commons 对中文公司/产品关键词常返回建筑、纹理等不相关图片，禁用兜底避免截图中「全部不相关」问题。
    const profile = parsed.profile || {};
    const basicInfo = profile.basicInfo || {};
    const productsServices = [];
    for (let i = 0; i < (Array.isArray(profile.productsServices) ? profile.productsServices.length : 0); i++) {
      const p = profile.productsServices[i] || {};
      const imageLocal = await attachImage(symbol, 'cdP' + i, p.imageUrl, p.imageQuery || p.name, false);
      productsServices.push({
        name: String(p.name || '').trim(),
        content: String(p.content || '').trim(),
        revenueShare: String(p.revenueShare || '').trim(),
        scenario: String(p.scenario || '').trim(),
        customerType: String(p.customerType || '').trim(),
        imageLocal,
        imageQuery: String(p.imageQuery || '').trim(),
        imageNote: String(p.imageNote || '').trim(),
      });
    }

    const supplyChain = parsed.supplyChain || {};
    const materials = [];
    for (let i = 0; i < (Array.isArray(supplyChain.materials) ? supplyChain.materials.length : 0); i++) {
      const m = supplyChain.materials[i] || {};
      const imageLocal = await attachImage(symbol, 'cdM' + i, m.imageUrl, m.imageQuery || m.name, false);
      materials.push({
        name: String(m.name || '').trim(),
        desc: String(m.desc || '').trim(),
        supplierTop5: String(m.supplierTop5 || '').trim(),
        procureShare: String(m.procureShare || '').trim(),
        supplyContent: String(m.supplyContent || '').trim(),
        stability: String(m.stability || '').trim(),
        imageLocal,
        imageQuery: String(m.imageQuery || '').trim(),
        imageNote: String(m.imageNote || '').trim(),
      });
    }

    const competition = parsed.competition || {};
    const competitors = [];
    for (let i = 0; i < (Array.isArray(competition.competitors) ? competition.competitors.length : 0); i++) {
      const c = competition.competitors[i] || {};
      const imageLocal = await attachImage(symbol, 'cdC' + i, c.imageUrl, c.imageQuery || c.name, false);
      competitors.push({
        name: String(c.name || '').trim(),
        marketShare: String(c.marketShare || '').trim(),
        productOverlap: String(c.productOverlap || '').trim(),
        customerOverlap: String(c.customerOverlap || '').trim(),
        regionOverlap: String(c.regionOverlap || '').trim(),
        priceStrategy: String(c.priceStrategy || '').trim(),
        imageLocal,
        imageQuery: String(c.imageQuery || '').trim(),
        imageNote: String(c.imageNote || '').trim(),
      });
    }
    const customers = (Array.isArray(competition.customers) ? competition.customers : []).map(c => ({
      name: String((c && c.name) || '').trim(),
      revenueShare: String((c && c.revenueShare) || '').trim(),
      concentration: String((c && c.concentration) || '').trim(),
      industryPercentile: String((c && c.industryPercentile) || '').trim(),
    })).filter(c => c.name);

    const strs = (a) => (Array.isArray(a) ? a.map(x => String(x == null ? '' : (typeof x === 'object' ? (x.text || x.name || JSON.stringify(x)) : x)).trim()).filter(Boolean) : []);

    const norm = {
      oneLiner: String(parsed.oneLiner || '').trim(),
      investmentSummary: String(parsed.investmentSummary || '').trim(),
      profile: {
        basicInfo: {
          fullName: String(basicInfo.fullName || '').trim(),
          officeLocation: String(basicInfo.officeLocation || '').trim(),
          registeredAddress: String(basicInfo.registeredAddress || '').trim(),
          foundedDate: String(basicInfo.foundedDate || '').trim(),
          listedDate: String(basicInfo.listedDate || '').trim(),
          industry: String(basicInfo.industry || ind || '').trim(),
          employeeCount: String(basicInfo.employeeCount || '').trim(),
          execCount: String(basicInfo.execCount || '').trim(),
          execAvgSalary: String(basicInfo.execAvgSalary || '').trim(),
          execSalaryBasis: String(basicInfo.execSalaryBasis || '').trim(),
        },
        productsServices,
        culture: {
          mission: String((profile.culture && profile.culture.mission) || '').trim(),
          culture: String((profile.culture && profile.culture.culture) || '').trim(),
          vision: String((profile.culture && profile.culture.vision) || '').trim(),
          values: String((profile.culture && profile.culture.values) || '').trim(),
          brands: strs((profile.culture && profile.culture.brands)),
          trademarks: String((profile.culture && profile.culture.trademarks) || '').trim(),
        },
        patents: {
          total: String((profile.patents && profile.patents.total) || '').trim(),
          inventionRatio: String((profile.patents && profile.patents.inventionRatio) || '').trim(),
          yoy3y: String((profile.patents && profile.patents.yoy3y) || '').trim(),
          industryPercentile: String((profile.patents && profile.patents.industryPercentile) || '行业分位未获取').trim(),
        },
        controller: {
          hasController: String((profile.controller && profile.controller.hasController) || '').trim(),
          name: String((profile.controller && profile.controller.name) || '').trim(),
          holdingPct: String((profile.controller && profile.controller.holdingPct) || '').trim(),
          controlPath: String((profile.controller && profile.controller.controlPath) || '').trim(),
          concertParties: strs((profile.controller && profile.controller.concertParties)),
          background: String((profile.controller && profile.controller.background) || '').trim(),
          pledge: String((profile.controller && profile.controller.pledge) || '').trim(),
          governanceRisk: String((profile.controller && profile.controller.governanceRisk) || '').trim(),
          equityStructure: String((profile.controller && profile.controller.equityStructure) || '').trim(),
        },
        majorEvents: (Array.isArray(profile.majorEvents) ? profile.majorEvents : []).map(e => ({
          date: String((e && e.date) || '').trim(),
          category: String((e && e.category) || '').trim(),
          title: String((e && e.title) || '').trim(),
          desc: String((e && e.desc) || '').trim(),
          impactLevel: String((e && e.impactLevel) || '').trim(),
          impactOn: String((e && e.impactOn) || '').trim(),
        })).filter(e => e.title),
      },
      supplyChain: {
        chainPosition: String(supplyChain.chainPosition || '').trim(),
        positionBasis: String(supplyChain.positionBasis || '').trim(),
        materials,
        directMaterialRatio: String(supplyChain.directMaterialRatio || '').trim(),
        conductionCoef: toNum(supplyChain.conductionCoef),
        grossMarginSensitivity: toNum(supplyChain.grossMarginSensitivity),
        sensitivityMatrix: normalizeSensitivityMatrix(supplyChain),
        sensitivityNote: String(supplyChain.sensitivityNote || '').trim(),
        costControl: (Array.isArray(supplyChain.costControl) ? supplyChain.costControl : []).map(c => ({
          type: String((c && c.type) || '').trim(),
          practice: String((c && c.practice) || '').trim(),
          costImpact: String((c && c.costImpact) || '').trim(),
        })).filter(c => c.type || c.practice),
        costRiskLevel: String(supplyChain.costRiskLevel || '').trim(),
        costRiskReason: String(supplyChain.costRiskReason || '').trim(),
      },
      competition: {
        customers,
        competitors,
        landscapeGraph: String(competition.landscapeGraph || '').trim(),
        priceWarSimulation: {
          homogeneity: String((competition.priceWarSimulation && competition.priceWarSimulation.homogeneity) || '').trim(),
          switchingCost: String((competition.priceWarSimulation && competition.priceWarSimulation.switchingCost) || '').trim(),
          brandPremium: String((competition.priceWarSimulation && competition.priceWarSimulation.brandPremium) || '').trim(),
          channelStickiness: String((competition.priceWarSimulation && competition.priceWarSimulation.channelStickiness) || '').trim(),
          scenarios: (competition.priceWarSimulation && Array.isArray(competition.priceWarSimulation.scenarios) ? competition.priceWarSimulation.scenarios : []).map(s => ({
            strategy: String((s && s.strategy) || '').trim(),
            revenue: String((s && s.revenue) || '').trim(),
            grossMargin: String((s && s.grossMargin) || '').trim(),
            netProfit: String((s && s.netProfit) || '').trim(),
            marketShare: String((s && s.marketShare) || '').trim(),
          })).filter(s => s.strategy),
        },
        competitionRiskLevel: String(competition.competitionRiskLevel || '').trim(),
        pricingPower: String(competition.pricingPower || '').trim(),
        riskSignals: strs(competition.riskSignals),
      },
      linkage: String(parsed.linkage || '').trim(),
      topWarning: String(parsed.topWarning || '').trim(),
      riskNotes: strs(parsed.riskNotes),
      dataSources: (Array.isArray(parsed.dataSources) ? parsed.dataSources : []).map(d => ({
        item: String((d && d.item) || '').trim(),
        source: String((d && d.source) || '').trim(),
        date: String((d && d.date) || '').trim(),
      })).filter(d => d.item || d.source),
      missingNotes: strs(parsed.missingNotes),
    };

    // 确定性校验 → flags（代码权威）
    const flags = validateDeep(norm);

    const result = {
      symbol,
      stockName: name || symbol,
      industry: ind || '',
      ...norm,
      flags,
      date: new Date().toISOString(),
      model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      mode, modelKind: modelPick.isLocal ? 'local' : (modelPick.webSearch ? 'web' : 'web-noSearch'),
      localDataUsed: mode === 'local', factAnchor,
      hasSegment: !!localCtx.hasSegment,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) {
      if (typeof data === 'string') message = data.slice(0, 300);
      else if (data.message) message = data.message;
      else if (data.error && data.error.message) message = data.error.message;
    }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

module.exports = { analyzeCompanyDeep, validateDeep, _toNum: toNum };
