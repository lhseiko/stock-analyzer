/**
 * 个股行业身份解析（单一可信源）
 * ------------------------------------------------------------
 * 把「个股属于哪个行业板块」做成唯一、可测试、确定性的解析入口，
 * 供短期判断、长期判断、行业分析、板块趋势、板块涨跌停等模块统一调用。
 *
 * 设计原则：
 * 1. 代码优先：对已知易误判的股票用硬编码覆盖表，不再依赖外部 F10 名称解析。
 * 2. 多源校验：F10 sshy / 研报 indvInduName / 行情元数据 仅作为补源，结果必须自洽。
 * 3. symbol 强校验：缓存/返回全程以 symbol 为唯一 key，杜绝跨股污染。
 * 4. 简单可测：resolveSectorIdentity(symbol, name) 返回结构化对象，逻辑透明。
 */

const axios = require('axios');
const { detectMarket } = require('./stockData');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function normCode(symbol) {
  return String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim();
}

// ---- 确定性行业覆盖表（按代码）----
// 只放「外部数据源容易误判」或「用户持仓/关注」的股票。
// 未命中覆盖表的个股走下方多源解析，结果会被规范化。
const INDUSTRY_BY_CODE = {
  // 保险（东财 F10 常把综合金融集团误归为非银金融/证券）
  '601318': '保险', // 中国平安
  '601628': '保险', // 中国人寿
  '601336': '保险', // 新华保险
  '601319': '保险', // 中国人保
  '601601': '保险', // 中国太保
  '600291': '保险', // 西水股份（已退市，保留兼容）
  '000627': '保险', // 天茂集团

  // 证券
  '600909': '证券', // 华安证券
  '000783': '证券', // 长江证券
  '600030': '证券', // 中信证券
  '600837': '证券', // 海通证券
  '601688': '证券', // 华泰证券
  '300059': '证券', // 东方财富

  // 银行（护栏：避免带"平安"字样的银行被误归保险）
  '000001': '银行', // 平安银行
  '600036': '银行', // 招商银行
  '601398': '银行', // 工商银行
  '601288': '银行', // 农业银行
  '601939': '银行', // 建设银行
  '601988': '银行', // 中国银行

  // 食品饮料（酱油/乳业/白酒等）
  '603288': '食品饮料', // 海天味业
  '600887': '食品饮料', // 伊利股份
  '000858': '食品饮料', // 五粮液
  '600519': '食品饮料', // 贵州茅台
  '000568': '食品饮料', // 泸州老窖

  // 半导体 / 芯片
  '600460': '半导体', // 士兰微
  '688981': '半导体', // 中芯国际
  '603501': '半导体', // 韦尔股份
  '002371': '半导体', // 北方华创

  // 电子 / 元件
  '300319': '电子', // 麦捷科技

  // 医疗器械 / 医药
  '688289': '医疗器械', // 圣湘生物
  '300760': '医疗器械', // 迈瑞医疗
  '603259': '医药',     // 药明康德
  '600276': '医药',     // 恒瑞医药

  // 新能源 / 汽车
  '300750': '新能源', // 宁德时代
  '002594': '新能源汽车', // 比亚迪
  '601012': '新能源', // 隆基绿能
  '600438': '新能源', // 通威股份
};

// ---- 东方财富精确行业分类（F10 行业，比广义归一化行业更细，仅用于展示）----
// 当某股票广义行业（INDUSTRY_BY_CODE）与东方财富 F10 精确行业不一致时，
// 用它给出更贴合东方财富口径的展示标签。例：海天味业 广义=食品饮料，东财 F10=调味发酵品2。
// 注意：该字段仅供「东方财富行业分类」展示，不参与新闻/政策/情绪/判断等逻辑（逻辑仍用归一化 industry）。
const EM_INDUSTRY_BY_CODE = {
  '603288': '调味发酵品2', // 海天味业（东方财富 F10 行业）
  '600519': '白酒', // 贵州茅台
  '000858': '白酒', // 五粮液
  '000568': '白酒', // 泸州老窖
  '600887': '乳品', // 伊利股份
  '300319': '元件', // 麦捷科技（东方财富 F10 行业）
  '300750': '电池', // 宁德时代
  '600438': '光伏设备', // 通威股份
  '601012': '光伏设备', // 隆基绿能
  '600276': '化学制药', // 恒瑞医药
  '603259': '医疗服务', // 药明康德（CXO）
};

// ---- 同花顺行业指数 K 线专用板块映射 ----
// 当广义归一化行业名无法直接命中同花顺板块列表时，显式指定用于拉取 K 线的同花顺板块。
// 例：海天味业 广义=食品饮料（同花顺无此板块），映射到同花顺「食品加工制造」指数（代码 881134）。
// 东方财富 push2 本机被封，K 线只能走同花顺，故此处用可达的同花顺板块作为代表行业指数。
// 同花顺无「乳业」板块，伊利用「食品加工制造」（881134）代指；无「食品饮料」板块，白酒股用「白酒」（881273）。
const THS_BOARD_BY_CODE = {
  '603288': '食品加工制造', // 海天味业 → 同花顺 食品加工制造（代码 881134）
  '600519': '白酒', // 贵州茅台 → 同花顺 白酒（代码 881273）
  '000858': '白酒', // 五粮液
  '000568': '白酒', // 泸州老窖
  '600887': '食品加工制造', // 伊利股份（同花顺无"乳业"板块，用食品加工制造代指，代码 881134）
  '300319': '元件', // 麦捷科技 → 同花顺 元件（代码 881270；注意归一化"电子"会误命中"电子化学品"，故显式指定）
  // 新能源 / 新能源车（同花顺无"新能源"板块，按细分映射）
  '300750': '电池', // 宁德时代 → 同花顺 电池（代码 881281）
  '600438': '光伏设备', // 通威股份 → 同花顺 光伏设备（代码 881279）
  '601012': '光伏设备', // 隆基绿能 → 同花顺 光伏设备（代码 881279）
  '002594': '汽车整车', // 比亚迪 → 同花顺 汽车整车（代码 881125；同花顺无"新能源汽车"板块）
  // 医药（同花顺"医药"会误命中"医药商业"，按细分映射）
  '600276': '化学制药', // 恒瑞医药 → 同花顺 化学制药（代码 881140）
  '603259': '医疗服务', // 药明康德 → 同花顺 医疗服务（代码 881175；CXO）
};

// ---- 行业名规范化映射 ----
// 把外部数据源五花八门的行业名统一成内部规范名。
const INDUSTRY_NORM = [
  { keys: ['保险', '人身保险', '财产保险', '再保险'], name: '保险' },
  { keys: ['证券', '券商', '投资银行', '期货'], name: '证券' },
  { keys: ['银行', '商业银行', '城商行', '农商行', '股份制银行'], name: '银行' },
  { keys: ['白酒', '酿酒', '啤酒', '葡萄酒', '食品饮料', '食品制造', '调味发酵品', '乳品', '肉制品'], name: '食品饮料' },
  { keys: ['半导体', '集成电路', '芯片', '分立器件', 'EDA', '光刻'], name: '半导体' },
  { keys: ['医疗器械', '医疗器材', '体外诊断', 'IVD', '医用耗材'], name: '医疗器械' },
  { keys: ['制药', '生物制品', '化学制药', '中药', '创新药', '医药'], name: '医药' },
  { keys: ['新能源', '光伏', '风电', '储能', '锂电', '电池'], name: '新能源' },
  { keys: ['新能源汽车', '汽车整车', '乘用车', '商用车', '整车'], name: '新能源汽车' },
  { keys: ['人工智能', 'AI', '算力', '大模型', '光模块', '数据中心'], name: '人工智能' },
  { keys: ['计算机', '软件', '信创', 'IT服务', '工业软件'], name: '计算机' },
  { keys: ['通信', '5G', '6G', '通信设备', '算力网络'], name: '通信' },
  { keys: ['军工', '航天', '航空', '国防', '卫星'], name: '军工' },
  { keys: ['电力设备', '电网', '特高压', '电气设备'], name: '电力设备' },
  { keys: ['煤炭', '石油', '石化', '电力', '燃气', '能源'], name: '能源' },
  { keys: ['有色', '钢铁', '化工', '化纤', '基础化工', '化学制品'], name: '周期' },
  { keys: ['房地产', '地产', '房地产开发'], name: '房地产' },
  { keys: ['传媒', '游戏', '影视', '互联网', '广告'], name: '传媒' },
  { keys: ['家电', '机械', '工程机械', '专用设备'], name: '机械' },
  { keys: ['建筑', '建材', '水泥', '玻璃', '装饰'], name: '建材' },
  { keys: ['农业', '种业', '养殖', '化肥', '农化'], name: '农业' },
  { keys: ['物流', '快递', '交运', '航运', '港口'], name: '物流' },
  { keys: ['环保', '水务', '绿化', '生态'], name: '环保' },
  { keys: ['零售', '商贸', '餐饮', '旅游', '酒店'], name: '消费服务' },
  { keys: ['纺织服装', '纺织', '服装'], name: '纺织服装' },
  { keys: ['电子', '消费电子', '元件', '被动元件'], name: '电子' },
];

function normalizeIndustryName(raw) {
  const text = String(raw || '');
  if (!text) return '';
  for (const item of INDUSTRY_NORM) {
    if (item.keys.some((k) => text.includes(k))) return item.name;
  }
  return text;
}

// ---- 多源解析 ----

async function fetchEastmoneyF10Industry(symbol) {
  const code = normCode(symbol);
  const info = detectMarket(symbol);
  const emCode = `${info.exchange}${info.tencentCode.replace(/^(sh|sz)/, '')}`;
  try {
    const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/CompanySurveyAjax?code=${emCode}`;
    const r = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://emweb.securities.eastmoney.com/' },
      timeout: 10000,
    });
    const j = r.data?.Result || r.data?.result || r.data;
    const jbzl = j?.jbzl || {};
    return {
      sshy: jbzl.sshy || '',
      sszjhhy: jbzl.sszjhhy || '',
    };
  } catch (e) {
    console.error('[SectorIdentity] F10 failed:', code, e.message);
    return { sshy: '', sszjhhy: '' };
  }
}

async function fetchReportIndustry(symbol) {
  const code = normCode(symbol);
  try {
    const end = new Date();
    const begin = new Date(end.getTime() - 365 * 24 * 3600 * 1000);
    const url = `https://reportapi.eastmoney.com/report/list?qType=0&pageSize=5&pageNo=1&code=${code}&beginTime=${fmtDate(begin)}&endTime=${fmtDate(end)}&industryCode=*&rating=&ratingChange=`;
    const r = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://reportapi.eastmoney.com/' },
      timeout: 10000,
    });
    const rows = r.data?.data || [];
    if (rows.length) {
      return {
        induCode: rows[0].indvInduCode || '',
        induName: rows[0].indvInduName || '',
      };
    }
  } catch (e) {
    console.error('[SectorIdentity] report indu failed:', code, e.message);
  }
  return { induCode: '', induName: '' };
}

// ---- 缓存（按 symbol，TTL 30s）----
const _cache = new Map();
const CACHE_TTL_MS = 30 * 1000;
const MAX_CACHE_SIZE = 256;

function getCached(symbol) {
  const code = normCode(symbol);
  const hit = _cache.get(code);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    _cache.delete(code);
    return null;
  }
  return hit.data;
}

function setCached(symbol, data) {
  const code = normCode(symbol);
  if (_cache.size >= MAX_CACHE_SIZE) {
    const firstKey = _cache.keys().next().value;
    _cache.delete(firstKey);
  }
  _cache.set(code, { ts: Date.now(), data });
}

// ---- 主入口 ----

/**
 * 解析个股所属行业板块。
 * @param {string} symbol 股票代码（支持 SH/SZ 前缀或纯数字）
 * @param {string} [name] 股票名称（仅用于日志/展示，不参与解析）
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] 强制跳过缓存重新解析
 * @returns {Promise<{symbol:string, name:string, industry:string, industrySource:string, confidence:number, generatedAt:string, ok:boolean}>}
 */
async function resolveSectorIdentity(symbol, name, opts = {}) {
  const code = normCode(symbol);
  const displayName = name || '';

  if (!code) {
    return { symbol: '', name: displayName, industry: '', industrySource: 'invalid', confidence: 0, generatedAt: new Date().toISOString(), ok: false };
  }

  if (!opts.force) {
    const cached = getCached(code);
    if (cached && cached.symbol === code) return cached;
  }

  // 1) 硬编码覆盖表（最高优先级，确定性最强）
  let industry = INDUSTRY_BY_CODE[code] || '';
  let source = industry ? 'code-override' : '';
  let confidence = industry ? 1.0 : 0;

  // 2) 外部数据源交叉校验/补充
  let f10Name = '';
  let reportName = '';
  let induCode = '';

  if (!industry) {
    const [f10, report] = await Promise.all([
      withTimeout(fetchEastmoneyF10Industry(symbol), 12000, { sshy: '', sszjhhy: '' }),
      withTimeout(fetchReportIndustry(symbol), 12000, { induCode: '', induName: '' }),
    ]);
    f10Name = f10.sshy || f10.sszjhhy || '';
    reportName = report.induName || '';
    induCode = report.induCode || '';

    // 优先使用 F10 所属行业，其次研报分类
    const raw = f10Name || reportName || '';
    if (raw) {
      industry = normalizeIndustryName(raw);
      source = f10Name ? 'f10-sshy' : 'report-induName';
      confidence = 0.75;
    }
  } else {
    // 命中覆盖表时，仍异步拉一次外部数据做一致性校验（不阻塞返回）
    Promise.all([
      withTimeout(fetchEastmoneyF10Industry(symbol), 12000, { sshy: '', sszjhhy: '' }),
      withTimeout(fetchReportIndustry(symbol), 12000, { induCode: '', induName: '' }),
    ]).then(([f10, report]) => {
      const external = normalizeIndustryName(f10.sshy || f10.sszjhhy || report.induName || '');
      if (external && external !== industry) {
        console.warn(`[SectorIdentity] 覆盖表与外部数据源不一致: ${code} 覆盖=${industry} 外部=${external}`);
      }
    }).catch(() => {});
  }

  // 3) 最终规范化
  industry = normalizeIndustryName(industry);

  const result = {
    symbol: code,
    name: displayName,
    industry,
    // 东方财富精确行业分类（仅展示用，命中代码覆盖表时取 EM_INDUSTRY_BY_CODE）
    emIndustry: industry ? (EM_INDUSTRY_BY_CODE[code] || '') : '',
    // 同花顺 K 线专用板块（命中代码覆盖表时取 THS_BOARD_BY_CODE，否则为空，前端回退到 industry）
    boardName: industry ? (THS_BOARD_BY_CODE[code] || '') : '',
    induCode,
    industrySource: source || 'unknown',
    confidence,
    f10Name,
    reportName,
    generatedAt: new Date().toISOString(),
    ok: !!industry,
  };

  // 4) 防御性断言：返回的 symbol 必须与请求一致
  if (result.symbol !== code) {
    throw new Error(`[SectorIdentity] symbol 不一致: input=${code} output=${result.symbol}`);
  }

  setCached(code, result);
  console.log(`[SectorIdentity] ${code} ${displayName} → ${industry || '未知'} (source=${source}, conf=${confidence})`);
  return result;
}

/**
 * 仅读取覆盖表（不联网），用于需要确定性映射的场景。
 */
function getIndustryOverride(symbol) {
  return INDUSTRY_BY_CODE[normCode(symbol)] || '';
}

/**
 * 把规范行业名映射到搜索/分析用的广义赛道关键词。
 */
function getSectorKeywords(industryName) {
  const norm = String(industryName || '').replace(/行业/g, '').replace(/业/g, '').trim();
  if (!norm) return [];
  // 与 newsSearch.SECTOR_KEYWORDS 保持一致语义
  const map = {
    '保险': ['保险', '人身险', '财产险', '中国平安', '中国人寿'],
    '证券': ['证券', '券商', '投行', '资本市场'],
    '银行': ['银行', '商业银行', '信贷', 'LPR'],
    '食品饮料': ['食品饮料', '白酒', '酱油', '调味品', '乳业', '消费'],
    '半导体': ['半导体', '芯片', '集成电路', '晶圆', 'IDM'],
    '医疗器械': ['医疗器械', '体外诊断', 'IVD', '医疗耗材'],
    '医药': ['医药', '创新药', '生物制药', '中药'],
    '新能源': ['新能源', '光伏', '储能', '锂电池', '风电'],
    '新能源汽车': ['新能源汽车', '电动车', '比亚迪', '动力电池'],
    '人工智能': ['人工智能', 'AI', '算力', '大模型', '光模块'],
    '计算机': ['计算机', '软件', '信创', 'IT服务'],
    '通信': ['通信', '5G', '6G', '通信设备'],
    '军工': ['军工', '国防', '航天', '航空'],
    '电力设备': ['电力设备', '电网', '特高压'],
    '能源': ['能源', '煤炭', '石油', '电力'],
    '周期': ['有色', '化工', '钢铁', '周期'],
    '房地产': ['房地产', '地产', '房地产开发'],
    '传媒': ['传媒', '游戏', '影视', '互联网'],
    '机械': ['机械', '工程机械', '家电'],
    '建材': ['建材', '水泥', '玻璃', '建筑'],
    '农业': ['农业', '种业', '养殖', '化肥'],
    '物流': ['物流', '快递', '交运'],
    '环保': ['环保', '水务', '生态'],
    '消费服务': ['零售', '商贸', '餐饮', '旅游', '酒店'],
    '纺织服装': ['纺织', '服装'],
    '电子': ['电子', '消费电子', '元件'],
  };
  for (const [k, v] of Object.entries(map)) {
    if (norm.includes(k) || k.includes(norm)) return v;
  }
  return [industryName].filter(Boolean);
}

module.exports = {
  resolveSectorIdentity,
  getIndustryOverride,
  getSectorKeywords,
  normalizeIndustryName,
  INDUSTRY_BY_CODE,
  EM_INDUSTRY_BY_CODE,
  THS_BOARD_BY_CODE,
};
