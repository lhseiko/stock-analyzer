/**
 * Industry Analysis Module（行业分析）
 * 为「深度分析」之后的独立「行业分析」页提供数据：
 *   1. 期货指数分析（仅当公司产品与期货相关，复用 fetchFuturesCorrelation）
 *   2. 行业归属 + 国家发展规划政策前景（内置 INDUSTRY_POLICY 映射）
 *   3. 行业板块（分析师研报情绪：评级分布 / 月度趋势 / 目标价）
 *   4. 行业分析师研究报告列表（东方财富行业研报 qType=1）
 *
 * 所有外部接口均做 try/catch + withTimeout 兜底，任何异常只降级不抛错，
 * 保证页面不会整片空白。
 */
const axios = require('axios');
const { fetchFuturesCorrelation } = require('./futuresData');
const { resolveSectorIdentity, getSectorKeywords, INDUSTRY_BY_CODE } = require('./sectorIdentity');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- 通用工具 ----
function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---- 行业政策扶持映射（内置重点行业）----
// level: 扶持级别；plans: 国家发展规划相关条目；summary: 前景分析
const INDUSTRY_POLICY = [
  { keys: ['半导体', '芯片', '集成电路', 'EDA', '光刻'], level: '国家战略扶持', plans: ['《十四五规划纲要》：集成电路被列为科技前沿攻关首位', '国家集成电路产业投资基金（大基金）一/二期持续注资', '"强链补链"自主可控政策'], summary: '半导体国产化是科技自立与产业链安全的战略核心，政策与资金长期倾斜，国产替代空间巨大；但技术壁垒高、研发周期长，需甄别真正具备突破能力的环节。' },
  { keys: ['人工智能', 'AI', '算力', '大模型', '数据中心', '光模块'], level: '国家战略扶持', plans: ['"人工智能+"行动（2024）', '算力基础设施高质量发展行动计划', '新质生产力核心方向'], summary: 'AI 与算力被定位为新质生产力的核心引擎，政策与资本高度关注，处于高速成长期；但估值波动大、技术迭代快，需关注业绩兑现节奏。' },
  { keys: ['新能源', '光伏', '风电', '储能', '锂电', '电池'], level: '国家战略扶持', plans: ['"双碳"目标（2030 碳达峰 / 2060 碳中和）', '新能源汽车产业发展规划(2021-2035)', '新型储能装机目标'], summary: '双碳战略下新能源长期向上，但阶段性产能过剩与价格战压制盈利，需密切关注供需节奏与技术路线变化。' },
  { keys: ['新能源汽车', '汽车', '整车'], level: '国家战略扶持', plans: ['新能源汽车产业发展规划(2021-2035)', '汽车以旧换新补贴政策', '智能网联汽车准入与上路试点'], summary: '新能源车渗透率持续提升，政策支持与出口亮眼；但价格竞争激烈、盈利分化，智能化成为新一轮竞争焦点。' },
  { keys: ['创新药', '医药', '生物', '疫苗', 'CXO', '医疗器械', '制药'], level: '战略扶持（审慎）', plans: ['"十四五"生物医药产业发展规划', '创新药医保谈判与提速审批', '科创板第五套标准 / 港股 18A 支持未盈利生物科技'], summary: '创新药与医疗器械受政策鼓励，但集采与医保控费持续压制利润；研发风险高、周期长，需甄别管线质量与商业化能力。' },
  { keys: ['白酒', '酿酒', '食品饮料', '消费'], level: '中性（顺周期）', plans: ['扩大内需战略', '促消费政策（以旧换新外溢拉动）'], summary: '消费是扩大内需主力，白酒等具备强品牌护城河与充沛现金流；但受经济顺周期与消费意愿影响，高端化红利边际放缓。' },
  { keys: ['军工', '航天', '航空', '国防', '卫星'], level: '国家战略扶持', plans: ['国防和军队现代化（2027 / 2035 节点）', '军民融合深度发展', '装备放量列装'], summary: '军工受国防预算稳步增长与装备升级驱动，订单确定性强、逆周期属性突出；但信息不透明、估值往往偏高。' },
  { keys: ['银行', '保险', '证券', '金融', '期货'], level: '中性（强监管）', plans: ['金融供给侧结构性改革', '服务实体经济、防范化解风险'], summary: '金融业以服务实体与防风险为主线，低估值高股息具防御属性；但让利实体与地产风险压制盈利弹性。' },
  { keys: ['房地产', '地产'], level: '受限（托底）', plans: ['"房住不炒"基调', '因城施策托底（保交楼 / 限购优化）'], summary: '房地产处于去杠杆与转型期，政策以"托底防风险"为主，行业出清尚未完成，投资需极度审慎。' },
  { keys: ['煤炭', '钢铁', '有色', '化工', '石油', '石化', '电力', '能源'], level: '中性（周期）', plans: ['能源安全新战略', '煤炭清洁高效利用', '新型电力系统建设'], summary: '传统能源与周期品受供需与价格周期主导，高股息具配置价值；但长期面临新能源替代与碳约束。' },
  { keys: ['通信', '5G', '算力网络'], level: '国家战略扶持', plans: ['"双千兆"网络发展行动', '东数西算工程', '6G 前瞻布局'], summary: '通信基础设施承上启下，受益于数字中国与算力网络建设；运营商稳健，设备商看技术迭代节奏。' },
  { keys: ['计算机', '软件', '信创', '工业软件'], level: '国家战略扶持', plans: ['信创国产化替代', '"软件定义"与工业软件攻关'], summary: '信创与工业软件国产化空间广阔，政策驱动党政及行业替换；但短期业绩兑现与生态建设是关键。' },
  { keys: ['家电', '机械', '工程机械'], level: '中性（出海）', plans: ['家电以旧换新补贴', '设备更新改造政策'], summary: '家电与机械受益于以旧换新与设备更新，龙头出海打开第二曲线；但受地产与海外需求扰动。' },
  { keys: ['农业', '种业', '养殖', '化肥', '农化'], level: '战略扶持', plans: ['粮食安全党政同责', '种业振兴行动', '高标准农田建设'], summary: '农业关乎粮食安全，种业振兴与高标准农田受政策倾斜；但周期性强（猪周期 / 粮价），盈利波动大。' },
  { keys: ['环保', '水务', '绿化', '生态'], level: '战略扶持', plans: ['污染防治攻坚战', '碳达峰碳中和', 'EOD 模式'], summary: '环保受政策驱动但依赖政府付费，回款与订单节奏是主要矛盾，估值弹性有限。' },
  { keys: ['传媒', '游戏', '影视', '互联网'], level: '中性（监管）', plans: ['文化数字化战略', '游戏版号常态化'], summary: '传媒互联网受内容监管与消费景气影响；游戏版号常态化修复供给，但政策与流量红利见顶并存。' },
  { keys: ['建材', '水泥', '玻璃'], level: '中性（周期）', plans: ['基建稳增长', '产能置换与错峰生产'], summary: '建材与基建 / 地产强相关，需求承压下以成本与份额竞争为主，关注基建端边际改善。' },
  { keys: ['物流', '快递', '交运'], level: '中性', plans: ['现代物流体系规划', '全国统一大市场'], summary: '物流受益于统一大市场与电商渗透，价格战趋缓后盈利修复；但同质化竞争仍在。' },
  { keys: ['电力设备', '电网', '特高压'], level: '国家战略扶持', plans: ['新型电力系统建设', '特高压 / 配电网投资加速'], summary: '电力设备受益于新型电力系统与电网投资上行，结构机会突出；但需关注招标价格与交付节奏。' },
];

function getPolicySupport(industryName, induName) {
  const text = `${industryName || ''} ${induName || ''}`;
  for (const item of INDUSTRY_POLICY) {
    if (item.keys.some((k) => text.includes(k))) {
      return { matched: true, level: item.level, plans: item.plans, summary: item.summary };
    }
  }
  return {
    matched: false,
    level: '中性（需结合具体政策判断）',
    plans: ['行业具体扶持 / 限制政策需结合最新国家发展规划与部委文件判断。'],
    summary: `「${industryName || induName || '该行业'}」暂未纳入内置重点行业政策库，建议结合最新"十四五"规划、政府工作报告及行业主管部门文件综合判断其政策定位与发展前景。`,
  };
}

// 为了向后兼容，复用 sectorIdentity 的覆盖表与校正函数
const INDUSTRY_NAME_OVERRIDE = INDUSTRY_BY_CODE;
function correctIndustryName(symbol, name, rawName) {
  const code = String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '');
  if (INDUSTRY_BY_CODE[code]) return INDUSTRY_BY_CODE[code];
  return rawName;
}

// ---- 行业归属（申万/证监会行业 + 东方财富行业研报分类码）----
// 20260821c：委托 sectorIdentity 做统一、确定性的个股行业解析，
// 本模块只负责补齐研报列表等附加信息。
async function fetchIndustryInfo(symbol, name) {
  const identity = await resolveSectorIdentity(symbol, name);
  return {
    name: identity.industry || '未知',
    csrc: identity.f10Name || '',
    induCode: identity.induCode || '',
    // 东方财富行业分类：优先用东方财富精确分类（如海天味业=调味发酵品2），其次研报/F10/归一化兜底
    induName: identity.emIndustry || identity.reportName || identity.f10Name || identity.industry || '',
    // 同花顺 K 线专用板块（命中覆盖表时填充，前端用于拉取行业指数 K 线）
    boardName: identity.boardName || '',
  };
}

// ---- 行业分析师研究报告（东方财富行业研报 qType=1）----
async function fetchIndustryReports(induCode) {
  if (!induCode) return [];
  const end = new Date();
  const begin = new Date(end.getTime() - 365 * 24 * 3600 * 1000);
  const url = `https://reportapi.eastmoney.com/report/list?qType=1&pageSize=60&pageNo=1&beginTime=${fmtDate(begin)}&endTime=${fmtDate(end)}&industryCode=${induCode}&rating=&ratingChange=`;
  const r = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://reportapi.eastmoney.com/' },
    timeout: 15000,
  });
  const rows = r.data?.data || [];
  return rows
    .map((x) => ({
      title: x.title || '',
      org: x.orgSName || x.orgName || '',
      rating: x.emRatingName || x.sRatingName || '',
      targetPrice: x.indvAimPriceT ? parseFloat(x.indvAimPriceT) : (x.indvAimPriceL ? parseFloat(x.indvAimPriceL) : null),
      publishDate: (x.publishDate || '').slice(0, 10),
      induName: x.indvInduName || '',
      infoCode: x.infoCode || '',
    }))
    .filter((r) => r.title);
}

// ---- 研报聚合统计：评级分布 / 月度趋势 / 平均目标价 ----
function buildReportStats(reports) {
  const ratingMap = {
    买入: '买入', 强推: '买入', 强烈推荐: '买入',
    增持: '增持', 推荐: '增持', 审慎推荐: '增持',
    中性: '中性', 谨慎推荐: '中性', 观望: '中性',
    减持: '减持', 回避: '减持',
    卖出: '卖出',
  };
  const dist = { 买入: 0, 增持: 0, 中性: 0, 减持: 0, 卖出: 0, 其他: 0 };
  const monthMap = {};
  let tpSum = 0;
  let tpN = 0;
  for (const r of reports) {
    const rt = ratingMap[r.rating] || '其他';
    dist[rt] = (dist[rt] || 0) + 1;
    if (r.publishDate && r.publishDate.length >= 7) {
      const m = r.publishDate.slice(0, 7);
      monthMap[m] = (monthMap[m] || 0) + 1;
    }
    if (r.targetPrice && r.targetPrice > 0) {
      tpSum += r.targetPrice;
      tpN += 1;
    }
  }
  const months = Object.keys(monthMap).sort();
  const avgTarget = tpN ? Math.round((tpSum / tpN) * 100) / 100 : null;
  return {
    total: reports.length,
    ratingDist: dist,
    monthly: { months, counts: months.map((m) => monthMap[m]) },
    avgTargetPrice: avgTarget,
  };
}

// ---- 主流程 ----
async function industryAnalysis(symbol, name) {
  const out = {
    symbol,
    name: name || '',
    generatedAt: Date.now(),
    industry: null,
    futures: { hasFutures: false },
    policy: null,
    industryReports: [],
    reportStats: null,
    error: null,
  };

  try {
    const [futures, industry] = await Promise.all([
      withTimeout(fetchFuturesCorrelation(symbol, name), 12000, { hasFutures: false }),
      withTimeout(fetchIndustryInfo(symbol, name), 13000, null),
    ]);

    if (name && !out.name) out.name = name;
    out.futures = futures || { hasFutures: false };
    out.industry = industry;

    if (industry) {
      out.policy = getPolicySupport(industry.name, industry.induName);
      const reports = await withTimeout(fetchIndustryReports(industry.induCode), 15000, []);
      out.industryReports = reports;
      out.reportStats = buildReportStats(reports);
    }
  } catch (e) {
    console.error('[Industry] analysis error:', e.message);
    out.error = e.message;
  }

  return out;
}

module.exports = { industryAnalysis, getPolicySupport, correctIndustryName, INDUSTRY_NAME_OVERRIDE };
