/**
 * 新闻 → 行业板块影响识别（自学习数据层）
 * --------------------------------------------------------------
 * 对首页财经热点新闻，识别其可能影响的行业板块与热门个股，并给出涨跌方向。
 *
 * 方向规则：利好/看涨 → 红（A股惯例），利空/看跌 → 绿。
 * 识别方式：
 *   1) 关键词 → 板块映射（NEWS_SECTOR_MAP，含板块名 + 热门个股候选）
 *   2) 用 analyzeSentiment 判断利好/利空方向
 *   3) 部分关键词带方向偏置（如"降准/降息"利好银行、"减持"利空）
 *
 * 自学习：识别结果持久化，支持人工更正（见 server.js /api/news-impact/correct），
 * 通过学习库统计「关键词→板块」命中情况，为后续判断提供置信度。
 */

const { analyzeSentiment } = require('./analysis');

// 新闻关键词 → 板块 + 热门个股。keywords 命中即关联该板块；direction 为方向偏置（1 利好 / -1 利空 / 0 由情绪判断）
const NEWS_SECTOR_MAP = [
  { keywords: ['mRNA', '疫苗', '创新药', '生物医药', '抗癌', '肿瘤', '临床', '医保', '集采', '医药', '医疗'], sector: '医药生物', hotStocks: ['恒瑞医药', '药明康德', '智飞生物', '沃森生物', '康希诺'], direction: 0 },
  { keywords: ['半导体', '芯片', '集成电路', '光刻', '晶圆', '封测'], sector: '半导体', hotStocks: ['中芯国际', '北方华创', '韦尔股份', '兆易创新'], direction: 0 },
  { keywords: ['人工智能', 'AI', '算力', '大模型', '数据中心', '光模块', 'CPO'], sector: '计算机', hotStocks: ['科大讯飞', '浪潮信息', '中际旭创', '金山办公'], direction: 0 },
  { keywords: ['新能源', '光伏', '储能', '锂电', '电池', '风电', '充电桩'], sector: '电力设备', hotStocks: ['宁德时代', '隆基绿能', '阳光电源', '亿纬锂能'], direction: 0 },
  { keywords: ['新能源车', '汽车', '智能驾驶', '自动驾驶', '整车'], sector: '汽车', hotStocks: ['比亚迪', '长城汽车', '赛力斯'], direction: 0 },
  { keywords: ['房地产', '地产', '楼市', '限购', '房贷'], sector: '房地产', hotStocks: ['万科A', '保利发展', '招商蛇口'], direction: 0 },
  { keywords: ['降准', '降息', 'LPR', '存款利率', '银行', '信贷'], sector: '银行', hotStocks: ['招商银行', '工商银行', '平安银行'], direction: 1 },
  { keywords: ['证券', '券商', '资本市场', '注册制', 'IPO', '印花税'], sector: '证券', hotStocks: ['中信证券', '东方财富', '华泰证券'], direction: 0 },
  { keywords: ['食品饮料', '消费', '酿酒', '必选消费', '调味品'], sector: '食品饮料', hotStocks: ['贵州茅台', '五粮液', '泸州老窖'], direction: 0 },
  { keywords: ['煤炭', '动力煤', '焦煤'], sector: '煤炭', hotStocks: ['中国神华', '陕西煤业', '兖矿能源'], direction: 0 },
  { keywords: ['黄金', '金价', '有色', '铜价', '锂矿', '稀土'], sector: '有色金属', hotStocks: ['紫金矿业', '山东黄金', '赣锋锂业'], direction: 0 },
  { keywords: ['石油', '油价', '原油', '天然气'], sector: '石油石化', hotStocks: ['中国石油', '中国石化', '中国海油'], direction: 0 },
  { keywords: ['军工', '国防', '航天', '航空', '卫星', '导弹'], sector: '国防军工', hotStocks: ['中航沈飞', '航发动力', '中直股份'], direction: 0 },
  { keywords: ['家电', '以旧换新', '家用电器'], sector: '家用电器', hotStocks: ['美的集团', '格力电器', '海尔智家'], direction: 0 },
  { keywords: ['钢铁', '钢价'], sector: '钢铁', hotStocks: ['宝钢股份', '华菱钢铁'], direction: 0 },
  { keywords: ['保险', '保费'], sector: '保险', hotStocks: ['中国平安', '中国人寿', '中国太保'], direction: 0 },
  { keywords: ['通信', '5G', '6G', '卫星互联网', '东数西算'], sector: '通信', hotStocks: ['中兴通讯', '中国移动', '烽火通信'], direction: 0 },
  { keywords: ['环保', '碳中和', '碳交易'], sector: '环保', hotStocks: ['瀚蓝环境', '伟明环保'], direction: 0 },
  { keywords: ['农业', '种业', '粮食', '养殖', '猪价'], sector: '农林牧渔', hotStocks: ['牧原股份', '隆平高科', '温氏股份'], direction: 0 },
  { keywords: ['传媒', '游戏', '影视', '短剧', '出版'], sector: '传媒', hotStocks: ['三七互娱', '分众传媒', '芒果超媒'], direction: 0 },
];

// 方向偏置词：命中时直接给方向，覆盖情绪判断（用于政策/事件类词）
const BULLISH_HINTS = ['降准', '降息', '利好', '扶持', '补贴', '获批', '突破', '超预期', '上调', '扩产', '中标', '加仓', '回购', '增持'];
const BEARISH_HINTS = ['加息', '利空', '限制', '制裁', '处罚', '调查', '减持', '下调', '亏损', '退市', '风险警示', '立案'];

// 境外市场提示词：环球财经类（日经/伦敦/纽约等）不应映射到 A 股板块，除非涉及全球定价的大宗/科技品
const FOREIGN_MARKET_HINTS = ['日经', '东京', '伦敦', '纽约', '美股', '纳斯达克', '道琼斯', '标普', '韩国', '欧洲', '港股', '恒生', '美元', '欧元', '英镑', '外汇', '汇率'];
const GLOBAL_PRICE_KEYWORDS = ['原油', '油价', '黄金', '金价', '铜', '锂', '稀土', '石油', '天然气', '芯片', '半导体', '存储'];

/**
 * 对单条新闻识别板块影响。
 * 返回 { sector, hotStocks, direction, signal, note } 或 null（无关联板块）。
 * direction: 'up'=看涨(红) / 'down'=看跌(绿) / 'neutral'=中性
 */
function analyzeNewsImpact(title, summary) {
  const text = (title || '') + ' ' + (summary || '');
  if (!text.trim()) return null;
  // 境外市场新闻（日经/伦敦/纽约等）不映射 A 股板块，除非涉及全球定价的大宗/科技品
  const isForeign = FOREIGN_MARKET_HINTS.some(k => text.includes(k));
  const isGlobal = GLOBAL_PRICE_KEYWORDS.some(k => text.includes(k));
  if (isForeign && !isGlobal) return null;
  let matched = null;
  for (const m of NEWS_SECTOR_MAP) {
    if (m.keywords.some(k => text.includes(k))) {
      matched = m;
      break;
    }
  }
  if (!matched) return null;

  // 方向：先看方向偏置词，再看整体情绪
  let direction = 'neutral';
  let signal = 0;
  const hasBull = BULLISH_HINTS.some(k => text.includes(k));
  const hasBear = BEARISH_HINTS.some(k => text.includes(k));
  if (matched.direction === 1) { direction = 'up'; signal = 1; }
  else if (matched.direction === -1) { direction = 'down'; signal = -1; }
  else if (hasBull && !hasBear) { direction = 'up'; signal = 1; }
  else if (hasBear && !hasBull) { direction = 'down'; signal = -1; }
  else {
    const s = analyzeSentiment(text);
    if (s.score > 15) { direction = 'up'; signal = 1; }
    else if (s.score < -15) { direction = 'down'; signal = -1; }
    else { direction = 'neutral'; signal = 0; }
  }

  return {
    sector: matched.sector,
    hotStocks: matched.hotStocks,
    direction,
    signal,
    note: `关键词命中「${matched.sector}」板块`,
  };
}

/**
 * 批量识别新闻列表的板块影响，返回带 impact 字段的新数组（仅给命中的新闻加 impact）。
 */
function annotateNewsImpact(items) {
  return (items || []).map(n => {
    const impact = analyzeNewsImpact(n.title, n.summary);
    return impact ? { ...n, impact } : n;
  });
}

module.exports = { analyzeNewsImpact, annotateNewsImpact, NEWS_SECTOR_MAP };
