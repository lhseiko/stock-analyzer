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
  // ★ 20260923k：新增「证券」。它是**市场基础设施名词**的子串（证券交易所／证券公司／
  //   证券时报／证券市场／证券业协会），本身不指向券商行业。
  //   实证：东财快讯「土耳其伊斯坦布尔**证券交易所**宣布 BIST-50 卖空适用报升规则」
  //   → 旧实现因「证券」是普通关键词（1 分）而整条归到「证券（券商）」板块
  //   → 经 matchWatchlist 按 sector 广播到自选股里的华安证券/长江证券
  //   → 变成国内券商的中度利空（误报，用户 2026-09-23 投诉）。
  //   降为泛词后：0.5 分且**不能单独定归属**（须有非泛词命中），「证券交易所」再也定不了板块。
  //   券商行业的归属改由 `exclusive: ['券商','证券公司','注册制','印花税','IPO']` 承担。
  '证券',
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
  // ★ 20260923k：「证券」已从本行 keywords **移除**（改入 GENERIC_KEYWORDS 泛词表），
  //   避免「证券交易所」这类**市场基础设施名词**把境外交易所的本地规则误归到券商板块。
  //   ⚠️ 但**境内**交易所的规则变更确实通过交易量/流动性传导到券商经纪业务，是合法事件 →
  //      补入**境内专属**交易所名（上交所/深交所/北交所/全国股转/新三板），它们绝不可能出现在境外新闻里，
  //      所以既能救回境内覆盖，又不会重新打开误配口子（伊斯坦布尔证券交易所→ 0 命中）。
  //      补入「证券公司」（= 券商同义词）与「证券业」同理。
  { keywords: ['券商', '证券公司', '证券业', '资本市场', '注册制', 'IPO', '印花税', '上交所', '深交所', '北交所', '上海证券交易所', '深圳证券交易所', '北京证券交易所', '全国股转', '新三板'], exclusive: ['券商', '证券公司', '注册制', '印花税', 'IPO', '上交所', '深交所', '北交所', '上海证券交易所', '深圳证券交易所', '北京证券交易所', '全国股转', '新三板'], exclude: [], sector: '证券', hotStocks: ['中信证券', '东方财富', '华泰证券'], direction: 0 },
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

// ===== 境外市场闸门（20260923k 重写）=====
// 旧实现是一串**硬编码城市/国家名**，覆盖不到土耳其/伊斯坦布尔/BIST 等，导致
//   「伊斯坦布尔证券交易所对BIST 50成分股卖空实施报升规则」被当作境内新闻放行 →
//   又因「证券交易所」字面命中「证券」→ 误归券商板块 → 变成国内券商的中度利空（用户投诉）。
// 白名单法天生漏（全球交易所上百家、国别两百多个），现改为**三层闸门**：
//
//   ① 境外主体词（国别/城市/机构/区域）—— 原名单 + 大幅扩充；
//   ② 境外交易所/指数**缩写正则**（BIST/NSE/B3/MOEX/Tadawul… 这类不会出现在中文 A 股新闻里）；
//   ③ 结构规则：命中 ①② 之一 **且** 谈论的是「交易所/市场交易制度」 **且** 全文无境内锚点
//      （A股/中国/证监会/沪深北交所/央行/人民币…）→ 直接拒收。
//
// ⚠️ 例外（必须保留）：**全球定价品种**（原油/黄金/铜/半导体/存储…）的境外信息**仍要进**——
//    它们的价格是全球同源的，对 A 股相关板块有真实传导路径（见 GLOBAL_PRICE_KEYWORDS）。
//
// 判定口径（可复用）：境外事件要进 A 股事件池，须至少有一条传导路径
//   ① 全球定价品种；② 直接作用于境内上市公司/监管/税费；③ 可比公司映射（中概股/跨境业务）。
//   只有「境外某交易所的本地交易规则」→ 无路径 → 拒收。
const FOREIGN_MARKET_HINTS = [
  // —— 原名单（保留）——
  '日经', '东京', '伦敦', '纽约', '美股', '纳斯达克', '道琼斯', '标普', '韩国', '欧洲',
  '港股', '恒生', '美元', '欧元', '英镑', '外汇', '汇率',
  // —— 20260923k 扩充：国别 ——
  '土耳其', '日本', '德国', '法国', '英国', '美国', '加拿大', '澳大利亚', '新西兰',
  '巴西', '墨西哥', '阿根廷', '智利', '秘鲁', '哥伦比亚', '俄罗斯', '南非', '尼日利亚',
  '肯尼亚', '埃及', '摩洛哥', '沙特', '阿联酋', '卡塔尔', '科威特', '以色列', '伊朗', '伊拉克',
  '印度', '巴基斯坦', '孟加拉', '斯里兰卡', '越南', '泰国', '印尼', '马来西亚', '新加坡',
  '菲律宾', '哈萨克斯坦', '乌兹别克斯坦', '瑞士', '瑞典', '挪威', '丹麦', '芬兰', '荷兰',
  '比利时', '奥地利', '爱尔兰', '葡萄牙', '西班牙', '意大利', '希腊', '波兰', '捷克',
  '匈牙利', '罗马尼亚', '乌克兰', '蒙古', '缅甸', '柬埔寨', '老挝',
  // —— 20260923k 扩充：境内外主要金融城市 ——
  '伊斯坦布尔', '安卡拉', '首尔', '大阪', '名古屋', '法兰克福', '慕尼黑', '巴黎', '米兰',
  '马德里', '阿姆斯特丹', '苏黎世', '日内瓦', '斯德哥尔摩', '奥斯陆', '哥本哈根', '赫尔辛基',
  '都柏林', '布鲁塞尔', '维也纳', '里斯本', '雅典', '华沙', '布拉格', '布达佩斯', '莫斯科',
  '圣保罗', '里约', '墨西哥城', '布宜诺斯艾利斯', '圣地亚哥', '利马', '波哥大',
  '约翰内斯堡', '开普敦', '开罗', '内罗毕', '拉各斯', '利雅得', '迪拜', '阿布扎比', '多哈',
  '孟买', '新德里', '胡志明', '河内', '雅加达', '曼谷', '吉隆坡', '马尼拉', '卡拉奇',
  '悉尼', '墨尔本', '多伦多', '温哥华', '奥克兰',
  // —— 20260923k 扩充：境外监管/机构/区域概念 ——
  // ⚠️ 只用**无歧义全称**，不放 SEC/CFTC/FCA/MAS/SFC 这类短英文缩写：
  //    它们是 `text.includes()` 子串匹配，会误伤普通英文词（如 SECTION 含 SEC）。
  '土耳其里拉', '新兴市场', '美联储', '欧洲央行', '英国央行', '日本央行', '澳洲联储', '韩国央行',
];
// 境外交易所/指数缩写。⚠️ 刻意**不加 `/i`**：全大写才匹配，
// 否则 'SIX'/'SET'/'PSI'/'STI' 会命中普通英文小写词（six/set/psi/sti）→ 大面积误拒。
// ⚠️ 已剔除 'SET'（与英文 set 同形）与 'PX'、'IPC'（歧义高）。
const FOREIGN_EXCHANGE_RE = /\b(BIST|NSE|BSE|IDX|MOEX|Tadawul|DFM|ADX|JSE|B3|BMV|KRX|KOSPI|KOSDAQ|TWSE|TAIEX|JPX|TOPIX|NIKKEI|SGX|STI|KLSE|PSE|ASX|TSX|SIX|LSE|FTSE|DAX|CAC|FTSEMIB|IBEX|AEX|OMXS|OBX|OMXC|OMXH|WIG|BUX|ATX|PSI|RTS|MICEX|ISX|NZ50|Bovespa|Merval|IPSA|IGBVL|COLCAP)\b/;
// 全球定价品种：境外信息**仍要进**——价格全球同源，对 A 股相关板块有真实传导路径
const GLOBAL_PRICE_KEYWORDS = ['原油', '油价', '黄金', '金价', '铜', '锂', '稀土', '石油', '天然气', '芯片', '半导体', '存储'];
// 境内锚点：命中任一 → 认为是「境内为主的混合新闻」，不适用境外闸门（豁免）
const DOMESTIC_ANCHORS = ['A股', '中国', '我国', '国内', '境内', '证监会', '沪深', '上交所', '深交所', '北交所', '央行', '人民币', '中证', '国务院', '国资委', '银保监', '国家金融监督管理总局'];
/**
 * 境外闸门判定（20260923k）—— 返回 true 表示「应拒收，不映射 A 股板块」。
 * 顺序（每一步都有明确理由，勿随意调换）：
 *   ① 全球定价品种（原油/黄金/铜/半导体/存储…）→ 放行。价格全球同源，有真实传导路径。
 *   ② 无境外主体（国别/城市/机构词 或 境外交易所缩写）→ 放行。不是境外新闻，闸门不适用。
 *   ③ 有境内锚点（A股/中国/证监会/沪深北交所/央行/人民币…）→ 放行。属境内为主的混合新闻。
 *   ④ 其余（境外主体 + 无境内锚点）→ 拒收。
 * 口径保守取「宁拒勿错」：误报（把境外事件算成 A 股利空）代价远高于漏报（用户既定原则）。
 * 反例（本函数要拦的）：伊斯坦布尔证券交易所对 BIST-50 卖空实施报升规则 → 与国内券商无因果链。
 * 正例（本函数必须放过的）：中国石化与沙特阿美签约 / 挪威主权基金增持A股 / 全球油价上涨。
 */
function isForeignMarketNews(text) {
  if (GLOBAL_PRICE_KEYWORDS.some(k => text.includes(k))) return false;   // ①
  const hitEntity = FOREIGN_MARKET_HINTS.some(k => text.includes(k)) || FOREIGN_EXCHANGE_RE.test(text);
  if (!hitEntity) return false;                                          // ②
  if (DOMESTIC_ANCHORS.some(k => text.includes(k))) return false;        // ③
  return true;                                                           // ④
}
// 兼容旧名（其他模块若引用）：只按主体词判断
const FOREIGN_MARKET_ENTITIES = FOREIGN_MARKET_HINTS;

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
  // 境外闸门（20260923k 重写）：境外主体 + 市场交易制度 + 无境内锚点 → 与 A 股无因果链，拒收。
  // 例外：全球定价品种（原油/黄金/半导体…）不受拦，见 isForeignMarketNews。
  if (isForeignMarketNews(text)) return null;
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

module.exports = { analyzeNewsImpact, annotateNewsImpact, NEWS_SECTOR_MAP, pickSector, GENERIC_KEYWORDS, isForeignMarketNews, FOREIGN_MARKET_HINTS, GLOBAL_PRICE_KEYWORDS };
