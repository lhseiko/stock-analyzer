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
//
// ★ 20260914i 修法（用户投诉「智能家居补贴被归到食品饮料」）：
//   旧实现「遍历 NEWS_SECTOR_MAP，首条命中即归」有三个致命缺陷：
//     ① 泛词抢答：「食品饮料」行含泛词「消费」，而「促进智能家居消费行动方案」含「消费」→ 误归食品饮料；
//     ② 顺序决定归属：命中多个板块时，排在表前面的赢，与语义无关；
//     ③ 无排除机制：专属词（智能家居）无法否决泛词（消费）。
//   现改为「打分制 + 强排除」：
//     - 每个关键词按其**专属程度**给分（`exclusive` 专属词 3 分 / `keywords` 通用词 1 分）；
//     - 泛词（消费、政策、补贴、以旧换新…）单独放 `generic`，只给 0.5 分，且**永远不能单独定归属**；
//     - `exclude` 为强排除词：新闻命中某板块的 exclude 词则该板块直接出局（如食品饮料排除「智能家居/家电/家居」）；
//     - 取总分最高的板块；平局时取「专属词命中数」多者；仍平局才回退表序。
//   `generic` 泛词表：这些词单独出现不构成任何行业归属。
const GENERIC_KEYWORDS = [
  '消费', '促消费', '扩内需', '政策', '补贴', '扶持', '以旧换新', '试点', '规划',
  '通知', '方案', '意见', '措施', '部署', '支持', '鼓励', '优惠', '减免',
];
const GENERIC_SCORE = 0.5;
const EXCLUSIVE_SCORE = 3;
const NORMAL_SCORE = 1;

const NEWS_SECTOR_MAP = [
  // ★ 20260921a：医药生物拆「药品」与「医疗器械」两条（申万二级口径）。
  //   旧实现把「医药/医疗」全归一级'医药生物'，导致药监局「药品安全」政策误伤医疗器械股（如圣湘生物）。
  //   现拆为：① 药品/制药条线→'医药生物'（强排除 医疗器械/设备/IVD/体外诊断…）；
  //           ② 医疗器械/设备/IVD/体外诊断/影像/监护/耗材→'医疗器械'（强排除 药品/制药/疫苗/集采…）。
  //   两条互斥：含「药品」必走①、含「医疗器械」必走②，避免交叉误挂。
  { keywords: ['mRNA', '疫苗', '创新药', '生物医药', '抗癌', '肿瘤', '临床', '医保', '集采', '医药', '药品', '制药', '药企', '仿制药', '生物制品', '中药', '化药'], exclusive: ['疫苗', '创新药', '生物医药', 'mRNA', '集采', '药品', '制药'], exclude: ['医疗器械', '设备', 'IVD', '体外诊断', '影像', '监护', '耗材', '手术机器人', '医械'], sector: '医药生物', hotStocks: ['恒瑞医药', '药明康德', '智飞生物', '沃森生物', '康希诺'], direction: 0 },
  { keywords: ['医疗器械', '医疗', '设备', 'IVD', '体外诊断', '诊断试剂', '影像', '监护', '耗材', '手术机器人', '医械', '医疗服务'], exclusive: ['医疗器械', '设备', 'IVD', '体外诊断', '影像', '监护', '耗材', '手术机器人'], exclude: ['药品', '制药', '药企', '仿制药', '疫苗', '创新药', '生物制品', '集采', '医保'], sector: '医疗器械', hotStocks: ['迈瑞医疗', '鱼跃医疗', '联影医疗', '乐普医疗', '圣湘生物', '阳普医疗'], direction: 0 },
  { keywords: ['半导体', '芯片', '集成电路', '光刻', '晶圆', '封测'], exclusive: ['半导体', '芯片', '集成电路', '光刻', '晶圆', '封测'], exclude: [], sector: '半导体', hotStocks: ['中芯国际', '北方华创', '韦尔股份', '兆易创新'], direction: 0 },
  { keywords: ['人工智能', 'AI', '算力', '大模型', '数据中心', '光模块', 'CPO'], exclusive: ['人工智能', '算力', '大模型', 'CPO', '光模块'], exclude: [], sector: '计算机', hotStocks: ['科大讯飞', '浪潮信息', '中际旭创', '金山办公'], direction: 0 },
  { keywords: ['新能源', '光伏', '储能', '锂电', '电池', '风电', '充电桩'], exclusive: ['光伏', '储能', '锂电', '充电桩'], exclude: [], sector: '电力设备', hotStocks: ['宁德时代', '隆基绿能', '阳光电源', '亿纬锂能'], direction: 0 },
  { keywords: ['新能源车', '汽车', '智能驾驶', '自动驾驶', '整车'], exclusive: ['新能源车', '智能驾驶', '自动驾驶', '整车'], exclude: ['汽车零部件'], sector: '汽车', hotStocks: ['比亚迪', '长城汽车', '赛力斯'], direction: 0 },
  { keywords: ['房地产', '地产', '楼市', '限购', '房贷'], exclusive: ['房地产', '楼市', '限购', '房贷'], exclude: [], sector: '房地产', hotStocks: ['万科A', '保利发展', '招商蛇口'], direction: 0 },
  { keywords: ['降准', '降息', 'LPR', '存款利率', '银行', '信贷'], exclusive: ['降准', '降息', '存款利率', 'LPR'], exclude: [], sector: '银行', hotStocks: ['招商银行', '工商银行', '平安银行'], direction: 1 },
  { keywords: ['证券', '券商', '资本市场', '注册制', 'IPO', '印花税'], exclusive: ['券商', '注册制', '印花税', 'IPO'], exclude: [], sector: '证券', hotStocks: ['中信证券', '东方财富', '华泰证券'], direction: 0 },
  // ⚠️ 食品饮料：删掉泛词「消费」，改为精确的食品类词；并强排除家居/家电/家装/汽车等非食品品类
  { keywords: ['食品饮料', '酿酒', '必选消费', '调味品', '食品', '白酒', '啤酒', '乳制品', '零食', '粮油'], exclusive: ['食品饮料', '酿酒', '调味品', '白酒', '啤酒', '乳制品', '粮油', '酱油'], exclude: ['智能家居', '家居', '家装', '家电', '家用电器', '汽车', '手机', '数码', '装修', '家具'], sector: '食品饮料', hotStocks: ['贵州茅台', '五粮液', '泸州老窖'], direction: 0 },
  { keywords: ['煤炭', '动力煤', '焦煤'], exclusive: ['动力煤', '焦煤', '煤炭'], exclude: [], sector: '煤炭', hotStocks: ['中国神华', '陕西煤业', '兖矿能源'], direction: 0 },
  { keywords: ['黄金', '金价', '有色', '铜价', '锂矿', '稀土'], exclusive: ['黄金', '铜价', '锂矿', '稀土'], exclude: [], sector: '有色金属', hotStocks: ['紫金矿业', '山东黄金', '赣锋锂业'], direction: 0 },
  { keywords: ['石油', '油价', '原油', '天然气'], exclusive: ['油价', '原油', '天然气', '石油'], exclude: [], sector: '石油石化', hotStocks: ['中国石油', '中国石化', '中国海油'], direction: 0 },
  { keywords: ['军工', '国防', '航天', '航空', '卫星', '导弹'], exclusive: ['军工', '国防', '导弹', '航天'], exclude: [], sector: '国防军工', hotStocks: ['中航沈飞', '航发动力', '中直股份'], direction: 0 },
  // ⚠️ 家用电器：补上智能家居/家居/家装/全屋智能——这类词以前完全没有归属方
  { keywords: ['家电', '以旧换新', '家用电器', '智能家居', '家居', '家装', '全屋智能', '数字家庭', '适老化家居', '家电以旧换新'], exclusive: ['智能家居', '全屋智能', '家用电器', '家电', '家居', '家装', '数字家庭'], exclude: [], sector: '家用电器', hotStocks: ['美的集团', '格力电器', '海尔智家'], direction: 0 },
  { keywords: ['钢铁', '钢价'], exclusive: ['钢价', '钢铁'], exclude: [], sector: '钢铁', hotStocks: ['宝钢股份', '华菱钢铁'], direction: 0 },
  { keywords: ['保险', '保费'], exclusive: ['保费', '保险'], exclude: [], sector: '保险', hotStocks: ['中国平安', '中国人寿', '中国太保'], direction: 0 },
  { keywords: ['通信', '5G', '6G', '卫星互联网', '东数西算'], exclusive: ['5G', '6G', '卫星互联网', '东数西算'], exclude: [], sector: '通信', hotStocks: ['中兴通讯', '中国移动', '烽火通信'], direction: 0 },
  { keywords: ['环保', '碳中和', '碳交易'], exclusive: ['碳中和', '碳交易'], exclude: [], sector: '环保', hotStocks: ['瀚蓝环境', '伟明环保'], direction: 0 },
  { keywords: ['农业', '种业', '粮食', '养殖', '猪价'], exclusive: ['种业', '猪价', '粮食'], exclude: [], sector: '农林牧渔', hotStocks: ['牧原股份', '隆平高科', '温氏股份'], direction: 0 },
  { keywords: ['传媒', '游戏', '影视', '短剧', '出版'], exclusive: ['短剧', '游戏', '影视'], exclude: [], sector: '传媒', hotStocks: ['三七互娱', '分众传媒', '芒果超媒'], direction: 0 },
];

// 方向偏置词：命中时直接给方向，覆盖情绪判断（用于政策/事件类词）
const BULLISH_HINTS = ['降准', '降息', '利好', '扶持', '补贴', '获批', '突破', '超预期', '上调', '扩产', '中标', '加仓', '回购', '增持'];
const BEARISH_HINTS = ['加息', '利空', '限制', '制裁', '处罚', '调查', '减持', '下调', '亏损', '退市', '风险警示', '立案'];

// 境外市场提示词：环球财经类（日经/伦敦/纽约等）不应映射到 A 股板块，除非涉及全球定价的大宗/科技品
const FOREIGN_MARKET_HINTS = ['日经', '东京', '伦敦', '纽约', '美股', '纳斯达克', '道琼斯', '标普', '韩国', '欧洲', '港股', '恒生', '美元', '欧元', '英镑', '外汇', '汇率'];
const GLOBAL_PRICE_KEYWORDS = ['原油', '油价', '黄金', '金价', '铜', '锂', '稀土', '石油', '天然气', '芯片', '半导体', '存储'];

/**
 * 板块定归属（打分制）—— 20260914i 新增
 * --------------------------------------------------------------
 * 旧实现「首条命中即归」会被泛词抢答（「消费」→ 食品饮料），且顺序决定归属。
 * 现按关键词专属程度打分，取最高分板块：
 *   1) 强排除：命中该板块任一 exclude 词 → 该板块直接出局；
 *   2) 打分：exclusive 专属词 ×3 / keywords 通用词 ×1 / GENERIC 泛词 ×0.5；
 *   3) 泛词（消费/补贴/以旧换新…）只给分，**不能单独定归属**（必须有非泛词命中）；
 *   4) 裁决：总分降序 → 专属词命中数降序 → 表序（保证确定性）。
 * 返回命中的 map 项，或 null。
 */
function pickSector(text) {
  const scored = [];
  for (let i = 0; i < NEWS_SECTOR_MAP.length; i++) {
    const m = NEWS_SECTOR_MAP[i];
    // 1) 强排除
    if ((m.exclude || []).some(k => text.includes(k))) {
      scored.push({ m, i, score: 0, exHit: 0, nonGenericHit: 0, excluded: true });
      continue;
    }
    const ex = m.exclusive || [];
    const exHit = ex.filter(k => text.includes(k)).length;
    const normalHit = (m.keywords || []).filter(k => !ex.includes(k) && text.includes(k)).length;
    const genericHit = GENERIC_KEYWORDS.filter(k => text.includes(k)).length;
    // 2) 打分
    const score = exHit * EXCLUSIVE_SCORE + normalHit * NORMAL_SCORE + genericHit * GENERIC_SCORE;
    // 3) 泛词不能单独定归属
    const nonGenericHit = exHit + normalHit;
    scored.push({ m, i, score, exHit, nonGenericHit, excluded: false });
  }
  const eligible = scored.filter(s => !s.excluded && s.nonGenericHit > 0 && s.score > 0);
  if (!eligible.length) return null;
  eligible.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.exHit !== a.exHit) return b.exHit - a.exHit;
    return a.i - b.i; // 表序兜底，保证结果确定
  });
  const win = eligible[0];
  win.m.__score = win.score;
  win.m.__exHit = win.exHit;
  return win.m;
}

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
  const matched = pickSector(text);
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
    note: `关键词命中「${matched.sector}」板块（打分 ${matched.__score != null ? matched.__score : '-'}，专属词 ${matched.__exHit != null ? matched.__exHit : 0}）`,
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

module.exports = { analyzeNewsImpact, annotateNewsImpact, NEWS_SECTOR_MAP, pickSector, GENERIC_KEYWORDS };
