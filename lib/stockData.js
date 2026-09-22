/**
 * Stock Data Fetcher
 * Supports Chinese A-shares, HK stocks, US stocks
 * Uses Tencent API for real-time quotes, Eastmoney API for history & fundamentals
 */
const axios = require('axios');
const iconv = require('iconv-lite');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { localDate, localCompact, localDateFromTs } = require('./localDate');
const { REPORTS, fetchReport } = require('./emDataCenter');
const execFileAsync = promisify(execFile);

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ---- 申万行业层级解析（从名称后缀 Ⅰ/Ⅱ/Ⅲ 识别 + 常见无后缀名兜底）----
const SW_LEVEL_MAP = { 'Ⅰ': '一级', 'Ⅱ': '二级', 'Ⅲ': '三级' };
// 申万行业层级字典（行业名 → 一级/二级/三级）
// 数据来源：申万宏源 2021 版行业分类（乐咕乐股 legulegu 权威分类树，2026-09 抓取），
// 覆盖东财「行业板块」全部名称（含去 Ⅱ/Ⅲ 后缀的基础名兜底），共 553 条。
// 东财板块名先按 Ⅰ/Ⅱ/Ⅲ 后缀解析，再落到本字典兜底。
const SW_NAME_LEVEL = {
  // 申万一级（32）
  '交通运输': '一级', '传媒': '一级', '公用事业': '一级', '农林牧渔': '一级', '医药生物': '一级', '商贸零售': '一级', '国防军工': '一级', '基础化工': '一级',
  '家用电器': '一级', '建筑材料': '一级', '建筑装饰': '一级', '房地产': '一级', '有色金属': '一级', '机械设备': '一级', '汽车': '一级', '煤炭': '一级',
  '环保': '一级', '电力设备': '一级', '电子': '一级', '石油石化': '一级', '社会服务': '一级', '纺织服饰': '一级', '综合': '一级', '综合金融': '一级',
  '美容护理': '一级', '计算机': '一级', '轻工制造': '一级', '通信': '一级', '钢铁': '一级', '银行': '一级', '非银金融': '一级', '食品饮料': '一级',
  // 申万二级（172）
  'IT服务': '二级', 'IT服务Ⅱ': '二级', '一般零售': '二级', '专业工程': '二级', '专业服务': '二级', '专业连锁': '二级', '专业连锁Ⅱ': '二级', '专用设备': '二级',
  '个护用品': '二级', '中药': '二级', '中药Ⅱ': '二级', '乘用车': '二级', '互联网电商': '二级', '休闲食品': '二级', '体育': '二级', '体育Ⅱ': '二级',
  '保险': '二级', '保险Ⅱ': '二级', '元件': '二级', '光伏设备': '二级', '光学光电子': '二级', '其他家电': '二级', '其他家电Ⅱ': '二级', '其他电子': '二级',
  '其他电子Ⅱ': '二级', '其他电源设备': '二级', '其他电源设备Ⅱ': '二级', '养殖业': '二级', '军工电子': '二级', '军工电子Ⅱ': '二级', '农业综合': '二级', '农业综合Ⅱ': '二级',
  '农产品加工': '二级', '农化制品': '二级', '农商行': '二级', '农商行Ⅱ': '二级', '冶钢原料': '二级', '出版': '二级', '动物保健': '二级', '动物保健Ⅱ': '二级',
  '包装印刷': '二级', '化妆品': '二级', '化学制品': '二级', '化学制药': '二级', '化学原料': '二级', '化学纤维': '二级', '医疗器械': '二级', '医疗服务': '二级',
  '医疗美容': '二级', '医药商业': '二级', '半导体': '二级', '厨卫电器': '二级', '商用车': '二级', '国有大型银行': '二级', '国有大型银行Ⅱ': '二级', '地面兵装': '二级',
  '地面兵装Ⅱ': '二级', '城商行': '二级', '城商行Ⅱ': '二级', '基础建设': '二级', '塑料': '二级', '多元金融': '二级', '家居用品': '二级', '家电零部件': '二级',
  '家电零部件Ⅱ': '二级', '小家电': '二级', '小金属': '二级', '工业金属': '二级', '工程咨询服务': '二级', '工程咨询服务Ⅱ': '二级', '工程机械': '二级', '广告营销': '二级',
  '影视院线': '二级', '房地产开发': '二级', '房地产服务': '二级', '房屋建设': '二级', '房屋建设Ⅱ': '二级', '摩托车及其他': '二级', '教育': '二级', '数字媒体': '二级',
  '文娱用品': '二级', '旅游及景区': '二级', '旅游零售': '二级', '旅游零售Ⅱ': '二级', '普钢': '二级', '服装家纺': '二级', '林业': '二级', '林业Ⅱ': '二级',
  '橡胶': '二级', '水泥': '二级', '汽车服务': '二级', '汽车零部件': '二级', '油服工程': '二级', '油气开采': '二级', '油气开采Ⅱ': '二级', '消费电子': '二级',
  '渔业': '二级', '游戏': '二级', '游戏Ⅱ': '二级', '炼化及贸易': '二级', '焦炭': '二级', '焦炭Ⅱ': '二级', '煤炭开采': '二级', '照明设备': '二级',
  '照明设备Ⅱ': '二级', '燃气': '二级', '燃气Ⅱ': '二级', '物流': '二级', '特钢': '二级', '特钢Ⅱ': '二级', '环保设备': '二级', '环保设备Ⅱ': '二级',
  '环境治理': '二级', '玻璃玻纤': '二级', '生物制品': '二级', '电力': '二级', '电子化学品': '二级', '电子化学品Ⅱ': '二级', '电机': '二级', '电机Ⅱ': '二级',
  '电池': '二级', '电网设备': '二级', '电视广播': '二级', '电视广播Ⅱ': '二级', '白色家电': '二级', '白酒': '二级', '白酒Ⅱ': '二级', '种植业': '二级',
  '纺织制造': '二级', '综合Ⅱ': '二级', '股份制银行': '二级', '股份制银行Ⅱ': '二级', '能源金属': '二级', '自动化设备': '二级', '航天装备': '二级', '航天装备Ⅱ': '二级',
  '航海装备': '二级', '航海装备Ⅱ': '二级', '航空机场': '二级', '航空装备': '二级', '航空装备Ⅱ': '二级', '航运港口': '二级', '装修建材': '二级', '装修装饰': '二级',
  '装修装饰Ⅱ': '二级', '计算机设备': '二级', '证券': '二级', '证券Ⅱ': '二级', '调味发酵品': '二级', '调味发酵品Ⅱ': '二级', '贵金属': '二级', '贸易': '二级',
  '贸易Ⅱ': '二级', '轨交设备': '二级', '轨交设备Ⅱ': '二级', '软件开发': '二级', '通信服务': '二级', '通信设备': '二级', '通用设备': '二级', '造纸': '二级',
  '酒店餐饮': '二级', '金属新材料': '二级', '铁路公路': '二级', '非白酒': '二级', '非金属材料': '二级', '非金属材料Ⅱ': '二级', '风电设备': '二级', '食品加工': '二级',
  '饮料乳品': '二级', '饰品': '二级', '饲料': '二级', '黑色家电': '二级',
  // 申万三级（349）
  'IT服务Ⅲ': '三级', 'LED': '三级', '专业出版': '三级', '专业连锁Ⅲ': '三级', '个护小家电': '三级', '中药Ⅲ': '三级', '中间产品及消费品供应链服务': '三级', '乳制品': '三级',
  '乳品': '三级', '产业地产': '三级', '人力资源服务': '三级', '人工景区': '三级', '仓储物流': '三级', '仪器仪表': '三级', '会展服务': '三级', '住宅开发': '三级',
  '体外诊断': '三级', '体育Ⅲ': '三级', '保健品': '三级', '保险Ⅲ': '三级', '信托': '三级', '光伏主材': '三级', '光伏加工设备': '三级', '光伏发电': '三级',
  '光伏电池组件': '三级', '光伏辅材': '三级', '光学元件': '三级', '公交': '三级', '公路货运': '三级', '其他专业工程': '三级', '其他专业服务': '三级', '其他专用设备': '三级',
  '其他传媒': '三级', '其他养殖': '三级', '其他农产品加工': '三级', '其他化学制品': '三级', '其他化学原料': '三级', '其他化学纤维': '三级', '其他医疗服务': '三级', '其他塑料制品': '三级',
  '其他家居用品': '三级', '其他家电Ⅲ': '三级', '其他小金属': '三级', '其他建材': '三级', '其他数字媒体': '三级', '其他橡胶制品': '三级', '其他汽车零部件': '三级', '其他生物制品': '三级',
  '其他电子Ⅲ': '三级', '其他电源设备Ⅲ': '三级', '其他石化': '三级', '其他种植业': '三级', '其他纺织': '三级', '其他能源发电': '三级', '其他自动化设备': '三级', '其他计算机设备': '三级',
  '其他运输设备': '三级', '其他通信设备': '三级', '其他通用设备': '三级', '其他酒类': '三级', '其他金属新材料': '三级', '其他食品': '三级', '其他饰品': '三级', '其他黑色家电': '三级',
  '军工电子Ⅲ': '三级', '农业综合Ⅲ': '三级', '农商行Ⅲ': '三级', '农用机械': '三级', '农药': '三级', '冰洗': '三级', '冶钢辅料': '三级', '分立器件': '三级',
  '制冷空调设备': '三级', '动力煤': '三级', '动漫': '三级', '动物保健Ⅲ': '三级', '化妆品制造及其他': '三级', '化学制剂': '三级', '化学工程': '三级', '医疗研发外包': '三级',
  '医疗耗材': '三级', '医疗设备': '三级', '医美服务': '三级', '医美耗材': '三级', '医药流通': '三级', '医院': '三级', '半导体材料': '三级', '半导体设备': '三级',
  '卫浴制品': '三级', '卫浴电器': '三级', '印制电路板': '三级', '印刷': '三级', '印刷包装机械': '三级', '印染': '三级', '原料药': '三级', '原材料供应链服务': '三级',
  '厨房小家电': '三级', '厨房电器': '三级', '合成树脂': '三级', '品牌化妆品': '三级', '品牌消费电子': '三级', '商业地产': '三级', '商业物业经营': '三级', '商用载客车': '三级',
  '商用载货车': '三级', '啤酒': '三级', '园林工程': '三级', '固废治理': '三级', '国有大型银行Ⅲ': '三级', '国际工程': '三级', '图片媒体': '三级', '地面兵装Ⅲ': '三级',
  '垂直应用软件': '三级', '城商行Ⅲ': '三级', '培训教育': '三级', '基建市政工程': '三级', '基础软件': '三级', '塑料包装': '三级', '复合肥': '三级', '多业态零售': '三级',
  '大众出版': '三级', '大宗用纸': '三级', '大气治理': '三级', '娱乐用品': '三级', '学历教育': '三级', '安防设备': '三级', '定制家居': '三级', '宠物食品': '三级',
  '家电零部件Ⅲ': '三级', '家纺': '三级', '工控设备': '三级', '工程咨询服务Ⅲ': '三级', '工程机械器件': '三级', '工程机械整机': '三级', '广告媒体': '三级', '底盘与发动机系统': '三级',
  '彩电': '三级', '影视动漫制作': '三级', '快递': '三级', '成品家居': '三级', '房产租赁经纪': '三级', '房地产综合服务': '三级', '房屋建设Ⅲ': '三级', '摩托车': '三级',
  '改性塑料': '三级', '教育出版': '三级', '教育运营及其他': '三级', '数字芯片设计': '三级', '文化用品': '三级', '文字媒体': '三级', '旅游综合': '三级', '旅游零售Ⅲ': '三级',
  '无机盐': '三级', '有机硅': '三级', '期货': '三级', '机器人': '三级', '机场': '三级', '机床工具': '三级', '板材': '三级', '林业Ⅲ': '三级',
  '果蔬加工': '三级', '核力发电': '三级', '检测服务': '三级', '棉纺': '三级', '楼宇设备': '三级', '模拟芯片设计': '三级', '横向通用软件': '三级', '橡胶助剂': '三级',
  '民爆制品': '三级', '氟化工': '三级', '氨纶': '三级', '氮肥': '三级', '氯碱': '三级', '水产养殖': '三级', '水产饲料': '三级', '水力发电': '三级',
  '水务及水治理': '三级', '水泥制品': '三级', '水泥制造': '三级', '汽车电子电气系统': '三级', '汽车经销商': '三级', '汽车综合服务': '三级', '油品石化贸易': '三级', '油气及炼化工程': '三级',
  '油气开采Ⅲ': '三级', '油田服务': '三级', '洗护用品': '三级', '海洋捕捞': '三级', '涂料': '三级', '涂料油墨': '三级', '消费电子零部件及组装': '三级', '涤纶': '三级',
  '清洁小家电': '三级', '港口': '三级', '游戏Ⅲ': '三级', '激光设备': '三级', '火力发电': '三级', '火电设备': '三级', '炭黑': '三级', '炼油化工': '三级',
  '烘焙食品': '三级', '热力服务': '三级', '焦炭Ⅲ': '三级', '焦煤': '三级', '煤化工': '三级', '照明设备Ⅲ': '三级', '熟食': '三级', '燃料电池': '三级',
  '燃气Ⅲ': '三级', '物业管理': '三级', '特种纸': '三级', '环保设备Ⅲ': '三级', '玻璃制造': '三级', '玻纤制造': '三级', '瓷砖地板': '三级', '生活用纸': '三级',
  '生猪养殖': '三级', '电信运营商': '三级', '电动乘用车': '三级', '电商服务': '三级', '电子化学品Ⅲ': '三级', '电工仪器仪表': '三级', '电机Ⅲ': '三级', '电池化学品': '三级',
  '电网自动化设备': '三级', '电能综合服务': '三级', '电视广播Ⅲ': '三级', '畜养殖': '三级', '畜禽饲料': '三级', '疫苗': '三级', '白酒Ⅲ': '三级', '白银': '三级',
  '百货': '三级', '硅料硅片': '三级', '磁性材料': '三级', '磨具磨料': '三级', '磷肥及磷化工': '三级', '禽养殖': '三级', '种子': '三级', '租赁': '三级',
  '稀土': '三级', '空调': '三级', '端到端供应链服务': '三级', '管材': '三级', '粘胶': '三级', '粮油加工': '三级', '粮食种植': '三级', '纯碱': '三级',
  '纸包装': '三级', '纺织化学制品': '三级', '纺织服装设备': '三级', '纺织鞋类制造': '三级', '线下药店': '三级', '线缆部件及其他': '三级', '综合Ⅲ': '三级', '综合乘用车': '三级',
  '综合包装': '三级', '综合环境治理': '三级', '综合电力设备商': '三级', '综合电商': '三级', '网络优化运营': '三级', '网络规划建设运维': '三级', '耐火材料': '三级', '聚氨酯': '三级',
  '肉制品': '三级', '肉鸡养殖': '三级', '股份制银行Ⅲ': '三级', '胶黏剂及胶带': '三级', '能源及重型设备': '三级', '膜材料': '三级', '自然景区': '三级', '航天装备Ⅲ': '三级',
  '航海装备Ⅲ': '三级', '航空装备Ⅲ': '三级', '航空运输': '三级', '航运': '三级', '营销代理': '三级', '蓄电池及其他电池': '三级', '血液制品': '三级', '被动元件': '三级',
  '装修装饰Ⅲ': '三级', '视频媒体': '三级', '证券Ⅲ': '三级', '诊断服务': '三级', '调味发酵品Ⅲ': '三级', '贸易Ⅲ': '三级', '资产管理': '三级', '超市': '三级',
  '跨境物流': '三级', '跨境电商': '三级', '车身附件及饰件': '三级', '轨交设备Ⅲ': '三级', '轮胎轮毂': '三级', '软饮料': '三级', '辅料': '三级', '输变电设备': '三级',
  '运动服装': '三级', '逆变器': '三级', '通信工程及服务': '三级', '通信应用增值服务': '三级', '通信线缆及配套': '三级', '通信终端及配件': '三级', '通信网络设备及器件': '三级', '配电设备': '三级',
  '酒店': '三级', '金属制品': '三级', '金属包装': '三级', '金融信息服务': '三级', '金融控股': '三级', '金融租赁': '三级', '钛白粉': '三级', '钟表珠宝': '三级',
  '钢结构': '三级', '钢铁管材': '三级', '钨': '三级', '钴': '三级', '钼': '三级', '钾肥': '三级', '铁矿石': '三级', '铁路运输': '三级',
  '铅锌': '三级', '铜': '三级', '铝': '三级', '锂': '三级', '锂电专用设备': '三级', '锂电池': '三级', '锦纶': '三级', '镍': '三级',
  '长材': '三级', '门户网站': '三级', '防水材料': '三级', '院线': '三级', '集成电路制造': '三级', '集成电路封测': '三级', '零食': '三级', '非货币银行': '三级',
  '非运动服装': '三级', '非金属材料Ⅲ': '三级', '面板': '三级', '鞋帽及其他': '三级', '预加工食品': '三级', '风力发电': '三级', '风电整机': '三级', '风电零部件': '三级',
  '食品及饲料添加剂': '三级', '食用菌': '三级', '餐饮': '三级', '高速公路': '三级', '黄金': '三级',
};
// ---- 首页行业卡片统一分级口径（单一事实源）----
// 东财「行业板块」(fs=m:90+t:2) 是申万一/二/三级**混用池**（实测 448 个：一级 30 / 二级 92 / 三级 326）。
// 三档互相包含（半导体 ⊂ 电子、通信网络设备及器件 ⊂ 通信设备 ⊂ 通信），若混排会出现
// 「父行业与子行业同时上榜、同一笔资金被重复计入」，导致榜单不可比 —— 违反工作台「数据一致性」核心规则。
// 故首页全部行业榜单（涨跌幅前5 / 7日涨跌幅最大 / 主力·散户 资金净流入流出前五 / 近5日最大）
// 一律取此唯一层级口径。修改此常量即全局切换层级（联动 sectorCapitalFlow.js / sectorRankHistory.js）。
// 20260917：用户要求由「申万三级」改为「申万二级」（更聚合，如 元件/工业金属/半导体/光学光电子）。
const SW_LEVEL_UNIFIED = '二级';

function parseSwSectorName(rawName) {
  const full = String(rawName || '').trim();
  const m = full.match(/([ⅠⅡⅢ]+)$/);
  if (m) {
    const levelChar = m[1][0];
    return {
      name: full.replace(/[ⅠⅡⅢ]+$/, '').trim(),
      rawName: full,
      swLevel: SW_LEVEL_MAP[levelChar] || null,
    };
  }
  const mapped = SW_NAME_LEVEL[full] || null;
  return { name: full, rawName: full, swLevel: mapped };
}

// ---- 申万二级板块全名清单（20260921g）----
// 供给「实时大盘」通过东方财富妙想取数时的**实体枚举清单**（妙想必须给明确实体名，
// 不支持「排名前N」类问句，故榜单需本地排序）。
// 规则：取 SW_NAME_LEVEL 中层级=二级 的键，按基础名去重（去掉 Ⅱ/Ⅲ 后缀）；
// 若去后缀后的基础名本身属于其他层级（如「综合Ⅱ」→「综合」是一级），则保留带后缀原名，
// 避免把一级行业误当二级板块（否则会出现父子行业同榜、资金重复计入）。
let _sw2NamesCache = null;
function getSwSecondLevelNames() {
  if (_sw2NamesCache) return _sw2NamesCache.slice();
  const strip = (s) => String(s).replace(/[ⅠⅡⅢ]+$/g, '');
  // 冲突集＝「基础名本身」在字典里被登记为其他层级的那些名字（如「综合」是一级）。
  // 只认字典键本身，不能用「被别人 strip 后撞名」判断——否则三级名「IT服务Ⅲ」会误伤二级的「IT服务」，
  // 导致 IT服务 / IT服务Ⅱ 双双入选、清单出现成对重复。
  const conflict = new Set();
  for (const k of Object.keys(SW_NAME_LEVEL)) {
    if (SW_NAME_LEVEL[k] && SW_NAME_LEVEL[k] !== '二级') conflict.add(k);
  }
  const seen = new Set();
  const out = [];
  for (const k of Object.keys(SW_NAME_LEVEL)) {
    if (SW_NAME_LEVEL[k] !== '二级') continue;
    const base = strip(k);
    const name = conflict.has(base) ? k : base;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  _sw2NamesCache = out;
  return out.slice();
}

// ---- Get Eastmoney secid ----
function getEastmoneySecid(input) {
  const info = detectMarket(input);
  if (info.market === 'CN') {
    return info.exchange === 'SH' ? `1.${info.tencentCode.replace(/^(sh|sz)/, '')}` : `0.${info.tencentCode.replace(/^(sh|sz)/, '')}`;
  }
  if (info.market === 'HK') {
    return `116.${info.tencentCode.replace(/^hk/, '')}`;
  }
  // US stocks: try NASDAQ (105) first
  return `105.${input.toUpperCase()}`;
}

// ---- Eastmoney K-line history (works for ALL markets) ----
// period: 'day' | '60m' | 'week' | 'month'
//  - day    ：日K（klt=101，前复权 fqt=1）
//  - 60m    ：60分钟（klt=60，不复权 fqt=0，保证最后一根收盘价与实时价同口径，涨跌幅一致）
//  - week   ：周K（klt=102，前复权）
//  - month  ：月K（klt=103，前复权）
async function fetchEastmoneyHistory(input, count = 320, period = 'day') {
  const secid = getEastmoneySecid(input);
  const endDate = localCompact();
  const klt = period === '60m' ? 60 : period === 'week' ? 102 : period === 'month' ? 103 : 101;
  const fqt = period === '60m' ? 0 : 1;
  // 60分钟数据仅保留近端区间，beg 取最近 120 个自然日，避免起止区间过宽导致接口返回空
  let begDate = '20100101';
  if (period === '60m') {
    const d = new Date();
    d.setDate(d.getDate() - 120);
    begDate = localCompact(d);
  }
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=${klt}&fqt=${fqt}&beg=${begDate}&end=${endDate}&lmt=${count}`;

  try {
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://quote.eastmoney.com/',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeout: 15000,
    });
    const klines = resp.data?.data?.klines || [];
    if (klines.length === 0) return [];

    // kline format: date,open,close,high,low,volume,amount,amplitude,changePct,change,turnover
    return klines.map(k => {
      const parts = k.split(',');
      return {
        date: parts[0],
        open: parseFloat(parts[1]),
        close: parseFloat(parts[2]),
        high: parseFloat(parts[3]),
        low: parseFloat(parts[4]),
        volume: parseFloat(parts[5]) || 0,
        amount: parseFloat(parts[6]) || 0,
        turnover: parseFloat(parts[10]) || 0, // f61 换手率（%）
      };
    });
  } catch (e) {
    console.error('Eastmoney history failed:', e.message);
    return [];
  }
}

// ---- Stock type detection ----

/**
 * Detect stock market by symbol/code
 * Returns { market, type, tencentCode, yahooCode }
 */
function detectMarket(input) {
  const code = String(input).trim().toUpperCase();

  // Chinese A-shares with SH/SZ prefix (e.g., SH601318, SZ000001)
  if (/^(SH|SZ)\d{6}$/.test(code)) {
    const exchange = code.startsWith('SH') ? 'SH' : 'SZ';
    const pureCode = code.replace(/^(SH|SZ)/, '');
    return { market: 'CN', exchange, tencentCode: exchange.toLowerCase() + pureCode, yahooCode: pureCode + (exchange === 'SH' ? '.SS' : '.SZ') };
  }

  // Chinese A-shares: 6xxxxx (SH), 0xxxxx/3xxxxx (SZ)
  if (/^\d{6}$/.test(code)) {
    if (code.startsWith('6') || code.startsWith('9')) {
      return { market: 'CN', exchange: 'SH', tencentCode: 'sh' + code, yahooCode: code + '.SS' };
    }
    return { market: 'CN', exchange: 'SZ', tencentCode: 'sz' + code, yahooCode: code + '.SZ' };
  }

  // HK stocks: 5 digits
  if (/^\d{5}$/.test(code)) {
    return { market: 'HK', exchange: 'HK', tencentCode: 'hk' + code.padStart(5, '0'), yahooCode: code.padStart(5, '0') + '.HK' };
  }

  // US stocks: letter-based symbols
  if (/^[A-Z]{1,6}$/.test(code)) {
    return { market: 'US', exchange: 'US', tencentCode: 'us' + code, yahooCode: code };
  }

  // Yahoo-style codes with suffix
  if (code.includes('.')) {
    if (code.endsWith('.SS') || code.endsWith('.SZ')) return { market: 'CN', exchange: code.endsWith('.SS') ? 'SH' : 'SZ', tencentCode: (code.endsWith('.SS') ? 'sh' : 'sz') + code.replace(/\.(SS|SZ)$/, ''), yahooCode: code };
    if (code.endsWith('.HK')) return { market: 'HK', exchange: 'HK', tencentCode: 'hk' + code.replace('.HK', ''), yahooCode: code };
    return { market: 'US', exchange: 'US', tencentCode: 'us' + code.replace(/\..*$/, ''), yahooCode: code };
  }

  return { market: 'US', exchange: 'US', tencentCode: 'us' + code, yahooCode: code };
}

// ---- Tencent API (Chinese A-shares & HK) ----

async function fetchTencentQuote(tencentCode) {
  const url = `https://qt.gtimg.cn/q=${tencentCode}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 8000,
    responseType: 'arraybuffer'
  });
  // Tencent API returns GBK-encoded text, decode to UTF-8
  const text = iconv.decode(Buffer.from(resp.data), 'GBK');
  const match = text.match(/v_(\w+)\s*=\s*"([^"]+)"/);
  if (!match) return null;
  const fields = match[2].split('~');
  if (fields.length < 50) return null;

  const price = parseFloat(fields[3]) || 0;
  const prevClose = parseFloat(fields[4]) || 0;
  const change = parseFloat(fields[31]) || 0;
  const changePct = parseFloat(fields[32]) || 0;
  const volume = parseFloat(fields[36]) || 0; // 手
  const amount = parseFloat(fields[37]) || 0; // 万
  const turnover = parseFloat(fields[38]) || 0; // 换手率
  const pe = parseFloat(fields[39]) || 0;
  const amplitude = parseFloat(fields[43]) || 0;
  const circulationValue = parseFloat(fields[44]) || 0; // 流通市值(亿)
  const totalValue = parseFloat(fields[45]) || 0; // 总市值(亿)
  const pb = parseFloat(fields[46]) || 0;

  // 解析行情时间（fields[30] 形如 "2026-08-03 15:00:02" 或 "20260803 15:00:02"）
  const dtRaw = fields[30] || '';
  let qtDate = '', qtTime = '';
  const dm = dtRaw.match(/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/);
  if (dm) qtDate = `${dm[1]}-${dm[2]}-${dm[3]}`;
  const tm = dtRaw.match(/(\d{2}):(\d{2})/);
  if (tm) qtTime = `${tm[1]}:${tm[2]}`;
  if (!qtDate) {
    const now = new Date();
    qtDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  }

  return {
    name: fields[1],
    code: fields[2],
    price,
    prevClose,
    date: qtDate,
    time: qtTime,
    open: parseFloat(fields[5]) || 0,
    high: parseFloat(fields[33]) || 0,
    low: parseFloat(fields[34]) || 0,
    change,
    changePct,
    volume: volume * 100, // 转为股
    amount: amount * 10000,
    turnover,
    pe,
    pb,
    amplitude,
    circulationValue,
    totalValue,
    bid: parseFloat(fields[9]) || 0,
    ask: parseFloat(fields[19]) || 0,
    market: 'tencent'
  };
}

// ---- Market overview (real-time indices) ----
// Curated index lists grouped by category. Codes verified against Tencent qt.gtimg.cn.
const MARKET_INDEX_GROUPS = {
  cn: [
    { code: 'sh000001', name: '上证指数' },
    { code: 'sz399001', name: '深证成指' },
    { code: 'sz399006', name: '创业板指' },
    { code: 'sh000300', name: '沪深300' },
    { code: 'sh000016', name: '上证50' },
    { code: 'sh000905', name: '中证500' },
    { code: 'sh000688', name: '科创50' }
  ],
  us: [
    { code: 'usDJI', name: '道琼斯' },
    { code: 'usIXIC', name: '纳斯达克' },
    { code: 'usINX', name: '标普500' }
  ],
  // 顶栏大盘行情状态栏：按用户指定顺序展示的 8 个核心指数（上证/深证/创业板/科创50/日经指数/恒生/纳斯达克/道琼斯）
  topbar: [
    { code: 'sh000001', name: '上证指数' },
    { code: 'sz399001', name: '深证成指' },
    { code: 'sz399006', name: '创业板指' },
    { code: 'sh000688', name: '科创50' },
    { code: '100.N225', name: '日经指数', source: 'eastmoney' },
    { code: 'hkHSI', name: '恒生指数' },
    { code: 'usIXIC', name: '纳斯达克' },
    { code: 'usDJI', name: '道琼斯' }
  ],
  sectors: [
    { code: 'sz399997', name: '中证白酒' },
    { code: 'sz399986', name: '中证银行' },
    { code: 'sz399989', name: '中证医疗' },
    { code: 'sz399975', name: '证券公司' },
    { code: 'sz399967', name: '中证军工' },
    { code: 'sz399971', name: '中证传媒' },
    { code: 'sz399998', name: '中证煤炭' },
    { code: 'sh000922', name: '中证红利' },
    { code: 'sz399808', name: '中证新能' },
    { code: 'sz399932', name: '中证消费' },
    { code: 'sz980017', name: '国证芯片' },
    { code: 'sh000827', name: '中证环保' }
  ]
};

async function getMarketOverview() {
  // 合并 cn / us / sectors / topbar 四组，按 code 去重
  const seen = new Set();
  const all = [...MARKET_INDEX_GROUPS.cn, ...MARKET_INDEX_GROUPS.us, ...MARKET_INDEX_GROUPS.sectors, ...MARKET_INDEX_GROUPS.topbar]
    .filter(i => (seen.has(i.code) ? false : (seen.add(i.code), true)));

  // 按数据源拆分：腾讯行情覆盖 A股/港股/美股指数；东方财富覆盖全球指数（如日经225）
  const tencentItems = all.filter(i => i.source !== 'eastmoney');
  const eastmoneyItems = all.filter(i => i.source === 'eastmoney');

  let text = '';
  if (tencentItems.length) {
    const url = `https://qt.gtimg.cn/q=${tencentItems.map(i => i.code).join(',')}`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeout: 10000,
      responseType: 'arraybuffer'
    });
    text = iconv.decode(Buffer.from(resp.data), 'GBK');
  }

  // 东方财富全球指数行情（腾讯 qt.gtimg.cn 不提供日经225等代码）
  const eastmoneyMap = new Map();
  if (eastmoneyItems.length) {
    for (const item of eastmoneyItems) {
      try {
        const secid = item.secid || item.code;
        const emUrl = `https://push2delay.eastmoney.com/api/qt/stock/get?secid=${encodeURIComponent(secid)}&fields=f43,f57,f58,f60,f170`;
        const emResp = await axios.get(emUrl, {
          headers: { 'User-Agent': UA },
          timeout: 10000
        });
        const d = emResp.data && emResp.data.data;
        if (d && d.f43 != null) {
          const price = (d.f43 || 0) / 100;
          const prevClose = (d.f60 || 0) / 100;
          eastmoneyMap.set(item.code, {
            code: d.f57 || item.code,
            name: item.name || d.f58 || '',
            price,
            prevClose,
            change: price - prevClose,
            changePct: (d.f170 || 0) / 100
          });
        }
      } catch (e) {
        console.warn('[MarketOverview] 东方财富指数行情获取失败:', item.code, e.message);
      }
    }
  }

  function parse(code) {
    if (eastmoneyMap.has(code)) return eastmoneyMap.get(code);
    const m = text.match(new RegExp('v_' + code + '\\s*=\\s*"([^"]+)"'));
    if (!m) return null;
    const f = m[1].split('~');
    if (f.length < 10) return null;
    return {
      code: f[2] || code,
      name: f[1] || '',
      price: parseFloat(f[3]) || 0,
      prevClose: parseFloat(f[4]) || 0,
      change: parseFloat(f[31]) || 0,
      changePct: parseFloat(f[32]) || 0
    };
  }

  function group(list) {
    return list.map(i => {
      const d = parse(i.code);
      if (d) return d;
      return { code: i.code, name: i.name, price: null, prevClose: null, change: 0, changePct: 0, unavailable: true };
    });
  }

  // 板块涨跌前5：优先用同花顺「行业板块」一览（本机网络稳定，与东方财富行情软件口径高度对应）；
  // 若同花顺失败，再尝试东方财富 push2（本机常被 TLS 重置/连接掐断，可用性低）；
  // 再回退到腾讯行情 54 个主要行业指数；最后才用 12 个固定样本。
  let sectorBlock = null;
  let thsSectorAll = null;   // 全量板块只采用同花顺单层级，东财多层级成交额重复计不适用于拥挤度
  let sectorError = null;
  try {
    sectorBlock = await getThsSectorRanking();
    thsSectorAll = sectorBlock && sectorBlock.allSectors ? sectorBlock.allSectors : null;
  } catch (e) {
    sectorError = e;
    console.warn('[MarketOverview] 同花顺行业板块获取失败:', e.message);
  }
  if (!sectorBlock) {
    try {
      sectorBlock = await getEastmoneySectorRanking();
    } catch (e) {
      sectorError = e;
      console.warn('[MarketOverview] 东方财富行业板块获取失败:', e.message);
    }
  }
  if (!sectorBlock) {
    try {
      sectorBlock = await getTencentSectorRanking();
    } catch (e) {
      sectorError = e;
      console.warn('[MarketOverview] 腾讯行业指数获取失败，回退到 12 指数样本:', e.message);
    }
  }
  if (!sectorBlock) {
    const sectorList = group(MARKET_INDEX_GROUPS.sectors);
    const availSectors = sectorList.filter(s => !s.unavailable);
    const upList = availSectors.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
    const downList = availSectors.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
    const flatList = availSectors.filter(s => s.changePct === 0);
    sectorBlock = {
      sectorsUp: upList.slice(0, 5),
      sectorsDown: downList.slice(0, 5),
      sectorSource: '腾讯行情·中证/国证指数(样本)',
      sectorIsEastmoney: false,
      sectorTotal: availSectors.length,
      sectorUpCount: upList.length,
      sectorDownCount: downList.length,
      sectorFlatCount: flatList.length,
      sectorDate: localDate(),
    };
  }
  // 20260911：面板「行业板块涨/跌幅前5 + 涨跌家数」以东方财富口径为准（申万细分行业，含地面兵装等细分板块，
  // 与用户在东财行情软件所见一致）；全量板块 sectorAll 仍沿用同花顺单层级源——东财为申万多层级，成交额跨层级重复计，
  // 仅适用榜单展示、不适用于行业拥挤度（拥挤度需单层级、不重复的成交额）。
  let panelBlock = null;
  try {
    panelBlock = await getEastmoneySectorRanking();
  } catch (e) {
    console.warn('[MarketOverview] 东方财富行业板块(面板口径)获取失败，沿用原源:', e.message);
  }
  const panel = panelBlock || sectorBlock;
  const panelSource = panel.sectorSource;
  const panelIsEastmoney = panelBlock ? true : !!sectorBlock.sectorIsEastmoney;

  // 面板口径提示：非东方财富口径时明确警示，避免用户拿不同分类口径去对比东财行情软件。
  let panelWarning = null, panelNote = null;
  if (panelIsEastmoney) {
    panelNote = panel.sectorChannel === 'datacenter'
      ? `东方财富·行业板块口径（东财数据中心报表，板块分类与东方财富行情软件「行业板块」同源），榜单按申万${SW_LEVEL_UNIFIED}口径统一分级；数据截至 ${panel.sectorDataDate || panel.sectorDate}`
      : '东方财富·行业板块口径（申万细分行业，含地面兵装等细分板块），与东方财富行情软件板块榜一致';
  } else if (panelSource === '同花顺·行业板块') {
    panelNote = '东方财富接口本机不可达，暂用同花顺行业板块备用源；已按申万二级口径统一分级（与 7 日提醒卡一致），分类细节与东方财富「行业板块」可能略有差异';
  } else {
    panelWarning = '东方财富实时板块接口受限，已回退其他数据源；其分类口径与东方财富「行业板块」不同，请勿直接对比东方财富数据';
  }

  // 20260921g：中国指数 / 美国指数两行的**真实数据源**（供「实时大盘」逐行标注数据源）。
  // 这两行的成分指数目前全部由腾讯行情供给；只有配置了 source:'eastmoney' 的指数才会走东方财富
  // （如顶栏日经225）。东财 push2 主机族在本机被对端重置，故此处按实际情况如实标注，不做美化。
  const indexList = [...MARKET_INDEX_GROUPS.cn, ...MARKET_INDEX_GROUPS.us];
  const indexEmCount = indexList.filter(i => i.source === 'eastmoney').length;
  const indexSource = indexEmCount === 0
    ? '腾讯行情'
    : (indexEmCount === indexList.length ? '东方财富·行情' : '腾讯行情 + 东方财富（部分）');
  const indexIsEastmoney = indexEmCount === indexList.length;

  return {
    cn: group(MARKET_INDEX_GROUPS.cn),
    us: group(MARKET_INDEX_GROUPS.us),
    topbar: group(MARKET_INDEX_GROUPS.topbar),
    indexSource,
    indexIsEastmoney,
    sectorsUp: panel.sectorsUp,
    sectorsDown: panel.sectorsDown,
    panelSource,                                   // 面板（涨跌幅前5）数据源
    panelIsEastmoney,
    sectorSource: sectorBlock.sectorSource,        // 全量板块(sectorAll)来源：供拥挤度/情绪模块标注，保持原语义
    sectorIsEastmoney: !!sectorBlock.sectorIsEastmoney,
    sectorWarning: panelWarning,
    sectorNote: panelNote,
    sectorTotal: panel.sectorTotal,
    sectorUpCount: panel.sectorUpCount,
    sectorDownCount: panel.sectorDownCount,
    sectorFlatCount: panel.sectorFlatCount,
    sectorDate: sectorBlock.sectorDate,
    sectorAll: thsSectorAll,   // 全量板块（含成交额），供行业拥挤度计算；固定使用同花顺单层级口径
    updatedAt: Date.now()
  };
}

// ---- 同花顺 行业板块 实时涨跌排名（本机网络最稳定）----
// 东方财富 push2 在本机常被 TLS 重置/连接掐断，返回的数据既不及时也不完整。
// 同花顺行业板块一览（90 个行业）与东方财富行情软件「行业板块」高度对应，且本机可稳定访问。
// 20260921f：层级改为按 parseSwSectorName 解析真实申万层级，榜单统一取二级（SW_LEVEL_UNIFIED）口径，
// 修正此前硬编码「一级」导致与东财口径 / 7日提醒卡分级不一致的问题。
let _thsSectorCache = { ts: 0, data: null };
async function getThsSectorRanking() {
  const now = Date.now();
  if (_thsSectorCache.data && now - _thsSectorCache.ts < 30000) {
    return _thsSectorCache.data;
  }
  const script = path.join(__dirname, '..', 'scripts', 'ths_sector_summary.py');
  const py = await findPythonForScript();
  if (!py) throw new Error('未找到 Python 解释器，无法调用同花顺板块接口');
  const out = await execFileAsync(py, [script], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 25000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const parsed = JSON.parse(out.stdout);
  if (parsed.error) throw new Error(parsed.error);
  const list = (parsed.sectors || []).map(s => ({
    code: s.code || '',
    name: s.name,
    swLevel: parseSwSectorName(s.name).swLevel,  // 真实申万层级（化学制药/半导体/电池…=二级，房地产/银行=一级）
    changePct: s.changePct || 0,
    amount: s.amount || 0,        // 板块当日总成交额（亿元）
    netInflow: s.netInflow || 0,  // 板块当日主力净流入（亿元），供板块资金流向备用源
    upCount: s.upCount || 0,
    downCount: s.downCount || 0,
    leader: s.leader || '',
    unavailable: false,
  }));
  if (list.length < 30) throw new Error('同花顺板块数据不足: ' + list.length);
  // 统一分级（对齐 getEastmoneySectorRanking）：榜单只取 SW_LEVEL_UNIFIED（二级）层级，
  // 保证「板块涨跌幅前5」与东财口径、7日提醒卡分级一致，父子行业不混排。
  const lvList = list.filter(s => s.swLevel === SW_LEVEL_UNIFIED);
  const upList = lvList.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
  const downList = lvList.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
  const flatList = lvList.filter(s => s.changePct === 0);
  const result = {
    sectorsUp: upList.slice(0, 5),
    sectorsDown: downList.slice(0, 5),
    allSectors: list,             // 全量板块（含成交额，未过滤层级）→ 供行业拥挤度计算与资金流名称→层级映射；勿按层级过滤
    sectorSource: '同花顺·行业板块',
    sectorIsEastmoney: false,
    sectorTotal: lvList.length,
    sectorUpCount: upList.length,
    sectorDownCount: downList.length,
    sectorFlatCount: flatList.length,
    sectorDate: parsed.date || localDate(),
  };
  _thsSectorCache = { ts: now, data: result };
  return result;
}

// 探测 Python 解释器：结果记忆化，整个进程只探测一次；且改为异步，
// 不再用同步 execFileSync 阻塞事件循环（避免分析期间服务端冻结、其他请求排队）。
let _pyBinChecked = false;
let _pyBinCache = null;
async function findPythonForScript() {
  if (_pyBinChecked) return _pyBinCache;
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      await execFileAsync(c, ['--version'], { timeout: 5000, windowsHide: true });
      _pyBinCache = c;
      _pyBinChecked = true;
      return c;
    } catch (e) {
      // try next
    }
  }
  _pyBinCache = null;
  _pyBinChecked = true;
  return null;
}

// ---- 东方财富 行业板块 实时涨跌排名（真正的"板块涨跌幅榜"）----
// 替代原先仅 12 个中证/国证指数的做法（样本太小、不具代表性，今日全样本下跌时
// 会错误地把"跌幅最小的板块"当成"涨幅前五"）
let _sectorRankingCache = { ts: 0, data: null };
// push2 族「行情推送」通道的静默期：本机对该族的请求常被对端在 TLS 握手后重置
// （HTTPS 与纯 HTTP(80) 一样），连续失败后短时间内不再重试（直接走数据中心报表通道），
// 避免每次刷新都白等数秒（20260921i 实测：静默期内 363ms vs 首轮 3637ms）。
let _emPush2DownUntil = 0;
const EM_PUSH2_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * 通道 A：东财「行情推送」clist（push2 族镜像）—— 真·盘中实时，但本机常被对端掐断。
 * 东方财富「行业板块」实时排名：fs=m:90+t:2（BK 行业板块，与东方财富官网板块榜一致）。
 * 任一镜像可达即采用；全部失败则抛错，由 getEastmoneySectorRanking 改走通道 B。
 */
async function _fetchEmPush2SectorRows() {
  const hosts = [
    'https://push2.eastmoney.com',
    'https://push2delay.eastmoney.com',
    'https://82.push2.eastmoney.com',
    'https://16.push2.eastmoney.com',
  ];
  // 东财 clist 单页上限 100 条；需分页取全量（约 5 页，覆盖约 500 个细分板块），
  // 否则只拿到「按涨跌幅降序的前 100 条」，跌幅榜会误取"跌得最少"的板块（真正的重挫板块被截断）。
  const pagePath = (pn) => `/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields=f12,f14,f2,f3,f62,f6,f104,f105,f128`;
  async function fetchPage(host, pn) {
    const url = host + pagePath(pn);
    try {
      const resp = await axios.get(url, {
        headers: {
          'User-Agent': UA,
          'Referer': 'https://quote.eastmoney.com/',
          'Accept': 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        timeout: 10000,
      });
      const dd = resp.data && resp.data.data;
      if (dd && Array.isArray(dd.diff)) return { rows: dd.diff, total: Number(dd.total) || dd.diff.length };
    } catch (e) {
      // Node 的 TLS 指纹被中间设备重置时，用系统 curl（schannel）二次尝试
      try {
        const out = await execFileAsync('curl', ['-s', '--max-time', '10', url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        const json = JSON.parse(out.stdout);
        const dd = json && json.data;
        if (dd && Array.isArray(dd.diff)) return { rows: dd.diff, total: Number(dd.total) || dd.diff.length };
      } catch (e2) { /* 忽略，返回 null 由上层处理 */ }
    }
    return null;
  }
  // 先用第 1 页探测可用镜像，再在该镜像上分页取全量
  let rows = [], total = 0, hostUsed = null, lastErr = null;
  for (const host of hosts) {
    const r = await fetchPage(host, 1);
    if (r && r.rows.length) { rows = r.rows; total = r.total; hostUsed = host; break; }
    lastErr = new Error('镜像不可达: ' + host);
  }
  if (!rows.length) {
    throw new Error('东方财富行业板块获取失败(全部镜像不可达): ' + (lastErr && lastErr.message));
  }
  const maxPages = Math.min(10, Math.ceil((total || rows.length) / 100));
  for (let pn = 2; pn <= maxPages; pn++) {
    // 东财镜像偶发抖动：单页失败重试一次，避免分页只取到第 1 页
    // （只取到第 1 页时全为上涨板块，跌幅榜会为空、涨跌家数失真，违反「数据一致性」）。
    let r = await fetchPage(hostUsed, pn);
    if (!r || !r.rows.length) r = await fetchPage(hostUsed, pn);
    if (!r || !r.rows.length) break;
    rows = rows.concat(r.rows);
    if (rows.length >= (total || Infinity)) break;
  }
  return rows.map(d => {
    const parsed = parseSwSectorName(d.f14);
    return {
      code: d.f12,
      name: parsed.name,
      rawName: parsed.rawName,
      swLevel: parsed.swLevel,
      price: parseFloat(d.f2) || 0,
      changePct: parseFloat(d.f3) || 0,
      mainFlow: parseFloat(d.f62) || 0,
      amount: (parseFloat(d.f6) || 0) / 1e8,   // 成交额：元 → 亿元
      upCount: parseInt(d.f104, 10) || 0,
      downCount: parseInt(d.f105, 10) || 0,
      leader: d.f128 || '',
      unavailable: false,
    };
  });
}

/**
 * 通道 B：东财「数据中心」报表 RPT_INDUSTRY_FUNDFLOW —— datacenter-web 稳定可达。
 * 与通道 A **同为东财口径、同源板块分类**（BOARD_CODE 即东财行业板块代码），字段对应：
 *   BOARD_NAME↔f14 / CHANGE_RATE↔f3 / NET_INFLOW↔f62 / MAX_NETINFLOW_SEC↔f204
 * 该报表逐交易日一行，取「最新交易日」的全部板块即为当日板块榜（单次请求 1 页 ≈130ms）。
 */
async function _fetchEmDcSectorRows() {
  const all = await fetchReport(REPORTS.INDUSTRY_FUNDFLOW, {
    sortColumns: 'TRADE_DATE', sortTypes: -1, pageSize: 300, pageNumber: 1,
  });
  if (!all.length) throw new Error('东财数据中心行业资金流报表无数据');
  const d0 = String(all[0].TRADE_DATE).slice(0, 10);
  const today = all.filter(r => String(r.TRADE_DATE).slice(0, 10) === d0);
  if (!today.length) throw new Error('东财数据中心行业资金流报表当日无数据');
  return today.map(r => {
    const parsed = parseSwSectorName(r.BOARD_NAME);
    return {
      code: r.BOARD_CODE || '',
      name: parsed.name,
      rawName: parsed.rawName,
      swLevel: parsed.swLevel,
      price: 0,                                   // 该报表不提供指数点位
      changePct: Number(r.CHANGE_RATE) || 0,
      mainFlow: Number(r.NET_INFLOW) || 0,
      amount: 0,                                  // 该报表不含成交额（全量成交额见 RPT_FUNDFLOW_BOARD）
      upCount: 0,
      downCount: 0,
      leader: r.MAX_NETINFLOW_SEC ? String(r.MAX_NETINFLOW_SEC).trim() : '',
      unavailable: false,
      dataDate: d0,
    };
  });
}

async function getEastmoneySectorRanking() {
  const now = Date.now();
  if (_sectorRankingCache.data && now - _sectorRankingCache.ts < 30000) {
    return _sectorRankingCache.data;
  }
  // 东财双通道：A 行情推送族（实时 tick，本机常被对端重置）→ B 数据中心报表（同为东财口径，稳定可达）。
  // 两者都是东财口径，故无论走哪条，对外都标注为东方财富；仅「实时 tick / 报表快照」不同（sectorChannel）。
  let rawList = null, channel = null, lastErr = null;
  if (Date.now() >= _emPush2DownUntil) {
    try {
      rawList = await _fetchEmPush2SectorRows();
      channel = 'push2';
      _emPush2DownUntil = 0;
    } catch (e) {
      lastErr = e;
      _emPush2DownUntil = Date.now() + EM_PUSH2_COOLDOWN_MS;
      console.warn('[EastmoneySector] 行情推送族不可达，转东财数据中心报表通道:', e.message);
    }
  } else {
    lastErr = new Error('push2 族处于静默期（近期连续失败），本次直接走数据中心报表');
  }
  if (!rawList) {
    try {
      rawList = await _fetchEmDcSectorRows();
      channel = 'datacenter';
    } catch (e) {
      lastErr = new Error((lastErr ? lastErr.message + '；' : '') + e.message);
    }
  }
  if (!rawList || !rawList.length) {
    throw new Error('东方财富行业板块获取失败(行情族与数据中心报表均不可达): ' + (lastErr && lastErr.message));
  }
  // 统一分级（20260916）：先按 SW_LEVEL_UNIFIED 过滤掉其他层级，再做基础名去重 ——
  // 保证首页榜单只含同一申万层级，父子行业不再同时上榜、资金不再重复计入。
  const lvList = rawList.filter(s => s.swLevel === SW_LEVEL_UNIFIED);
  // 同一主题可能同时存在「XXⅡ / XXⅢ」两条（数值相同），按基础名去重（保留绝对值较大的那条，统一用基础名展示）。
  const seen = new Map();
  for (const s of lvList) {
    const base = String(s.name || '').trim();
    const ex = seen.get(base);
    if (!ex || Math.abs(s.changePct) > Math.abs(ex.changePct)) seen.set(base, s);
  }
  const list = [...seen.values()];
  // 涨幅前五：只从实际上涨的板块中取；跌幅前五：只从实际下跌的板块中取。
  // 普涨/普跌时，避免把“涨幅最小的板块”误标为跌幅前五，或反之。
  const upList = list.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
  const downList = list.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
  const flatList = list.filter(s => s.changePct === 0);
  const result = {
    sectorsUp: upList.slice(0, 5),
    sectorsDown: downList.slice(0, 5),
    allSectors: rawList,          // 全量（含各层级）：仅供板块资金流向做「名称→申万层级」兜底映射；榜单请用 sectorsUp/Down
    sectorSource: channel === 'push2' ? '东方财富·行业板块' : '东方财富·行业板块（数据中心）',
    sectorIsEastmoney: true,
    sectorChannel: channel,                                                          // 'push2'(实时 tick) | 'datacenter'(数据中心报表)
    sectorDataDate: (rawList.find(s => s.dataDate) || {}).dataDate || null,           // 数据中心通道的数据日期，供面板如实标注
    sectorTotal: list.length,
    sectorUpCount: upList.length,
    sectorDownCount: downList.length,
    sectorFlatCount: flatList.length,
    sectorDate: localDate(),
  };
  _sectorRankingCache = { ts: now, data: result };
  return result;
}

// ---- 腾讯行情 行业指数 备选排名（东方财富 push2 被屏蔽时使用）----
// 覆盖 54 个主要中证/国证行业主题指数，远比原先 12 个样本有代表性。
const TENCENT_SECTOR_CODES = [
  { code: 'sz399997', name: '中证白酒' }, { code: 'sz399986', name: '中证银行' },
  { code: 'sz399989', name: '中证医疗' }, { code: 'sz399975', name: '证券公司' },
  { code: 'sz399967', name: '中证军工' }, { code: 'sz399971', name: '中证传媒' },
  { code: 'sz399998', name: '中证煤炭' }, { code: 'sh000922', name: '中证红利' },
  { code: 'sz399808', name: '中证新能' }, { code: 'sz399932', name: '中证消费' },
  { code: 'sz980017', name: '国证芯片' }, { code: 'sh000827', name: '中证环保' },
  { code: 'sh000928', name: '中证能源' }, { code: 'sh000929', name: '800材料' },
  { code: 'sh000930', name: '800工业' }, { code: 'sh000931', name: '800可选' },
  { code: 'sh000932', name: '中证消费' }, { code: 'sh000933', name: '中证医药' },
  { code: 'sh000934', name: '中证金融' }, { code: 'sh000935', name: '中证信息' },
  { code: 'sh000936', name: '800通信' }, { code: 'sh000937', name: '800公用' },
  { code: 'sh000941', name: '新能源' }, { code: 'sh000944', name: '内地资源' },
  { code: 'sh000945', name: '内地运输' }, { code: 'sh000949', name: '中证农业' },
  { code: 'sz399395', name: '国证有色' }, { code: 'sz399396', name: '国证食品' },
  { code: 'sz399397', name: '国证文化' }, { code: 'sz399398', name: '绩效指数' },
  { code: 'sz399399', name: '中经GDP' }, { code: 'sz399431', name: '国证银行' },
  { code: 'sz399432', name: '智能汽车' }, { code: 'sz399433', name: '国证交运' },
  { code: 'sz399434', name: '数字传媒' }, { code: 'sz399435', name: '国证农牧' },
  { code: 'sz399436', name: '绿色煤炭' }, { code: 'sz399437', name: '证券龙头' },
  { code: 'sz399438', name: '绿色电力' }, { code: 'sz399439', name: '国证油气' },
  { code: 'sz399440', name: '国证钢铁' }, { code: 'sz399803', name: '工业4.0' },
  { code: 'sz399804', name: '中证体育' }, { code: 'sz399805', name: '互联金融' },
  { code: 'sz399806', name: '环境治理' }, { code: 'sz399807', name: '高铁产业' },
  { code: 'sz399809', name: '保险主题' }, { code: 'sz399810', name: 'CSSW传媒' },
  { code: 'sz399811', name: 'CSSW电子' }, { code: 'sz399812', name: '养老产业' },
  { code: 'sz399813', name: '中证国安' }, { code: 'sz399814', name: '大农业' },
  { code: 'sz399815', name: '5G' }, { code: 'sz399816', name: '新材料' },
  { code: 'sz399817', name: '生物医药' }, { code: 'sz399818', name: '医疗器械' },
  { code: 'sz399959', name: '军工指数' }
];

let _tencentSectorCache = { ts: 0, data: null };
async function getTencentSectorRanking() {
  const now = Date.now();
  if (_tencentSectorCache.data && now - _tencentSectorCache.ts < 30000) {
    return _tencentSectorCache.data;
  }
  const codes = TENCENT_SECTOR_CODES.map(s => s.code).join(',');
  const url = `https://qt.gtimg.cn/q=${codes}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 12000,
    responseType: 'arraybuffer'
  });
  const text = iconv.decode(Buffer.from(resp.data), 'GBK');
  const list = [];
  const regex = /v_(\w+)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = regex.exec(text)) !== null) {
    const code = m[1];
    const fields = m[2].split('~');
    if (fields.length < 45) continue;
    const meta = TENCENT_SECTOR_CODES.find(s => s.code === code);
    if (!meta) continue;
    const price = parseFloat(fields[3]) || 0;
    const prevClose = parseFloat(fields[4]) || 0;
    const changePct = parseFloat(fields[32]) || 0;
    if (price <= 0 || prevClose <= 0) continue; // 过滤停牌/无数据指数
    list.push({
      code,
      name: meta.name,
      price,
      changePct,
      unavailable: false,
    });
  }
  if (list.length < 15) throw new Error('腾讯行业指数有效数据不足');
  const upList = list.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
  const downList = list.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
  const flatList = list.filter(s => s.changePct === 0);
  const result = {
    sectorsUp: upList.slice(0, 5),
    sectorsDown: downList.slice(0, 5),
    sectorSource: '腾讯行情·行业指数',
    sectorTotal: list.length,
    sectorUpCount: upList.length,
    sectorDownCount: downList.length,
    sectorFlatCount: flatList.length,
    sectorDate: localDate(),
  };
  _tencentSectorCache = { ts: now, data: result };
  return result;
}

async function fetchTencentHistory(tencentCode, count = 320) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentCode},day,,,${count},qfq`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 8000
  });
  const data = resp.data;
  let dayData = data?.data?.[tencentCode]?.qfqday || data?.data?.[tencentCode]?.day || [];
  if (!Array.isArray(dayData) || dayData.length === 0) return [];

  return dayData.map(d => ({
    date: d[0],
    open: parseFloat(d[1]),
    close: parseFloat(d[2]),
    high: parseFloat(d[3]),
    low: parseFloat(d[4]),
    volume: parseFloat(d[5]) || 0
  }));
}

// 腾讯日K按结束日期分段（单段上限约800根，count>800 会返回空）
async function fetchTencentHistoryEndingAt(tencentCode, endDate, count = 800) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${tencentCode},day,,${endDate},${count},qfq`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 10000
  });
  const data = resp.data;
  let dayData = data?.data?.[tencentCode]?.qfqday || data?.data?.[tencentCode]?.day || [];
  if (!Array.isArray(dayData) || dayData.length === 0) return [];
  return dayData.map(d => ({
    date: d[0],
    open: parseFloat(d[1]),
    close: parseFloat(d[2]),
    high: parseFloat(d[3]),
    low: parseFloat(d[4]),
    volume: parseFloat(d[5]) || 0
  }));
}

// 长历史日K（约10年）：腾讯单次上限约800根，向前分段拼接（供价格行为趋势推演使用）
async function getHistoryDeep(input, totalBars = 2400) {
  const info = detectMarket(input);
  if (info.market !== 'CN' && info.market !== 'HK') {
    return getHistory(input, '5y'); // 美股/其他市场沿用原通道
  }
  const SEG = 800;
  const seen = new Set();
  const all = [];
  let endDate = ''; // 空 = 最新
  for (let seg = 0; seg < Math.ceil(totalBars / SEG); seg++) {
    let bars;
    try {
      bars = await fetchTencentHistoryEndingAt(info.tencentCode, endDate, SEG);
    } catch (e) {
      console.error(`Tencent history segment ${seg + 1} failed:`, e.message);
      break;
    }
    if (!Array.isArray(bars) || bars.length === 0) break;
    let newOnes = 0;
    for (const b of bars) {
      if (!seen.has(b.date)) { seen.add(b.date); all.push(b); newOnes++; }
    }
    const firstDate = bars[0].date;
    if (newOnes === 0) break; // 无新数据
    if (endDate !== '' && firstDate >= endDate) break; // API 忽略结束日期，无法继续回溯
    endDate = firstDate; // 下一段以本段最早日期为结束日（该日会去重）
  }
  all.sort((a, b) => (a.date < b.date ? -1 : 1));
  return all;
}

// 腾讯 60分钟 K线（东财 push2his 在本机被 TLS 阻断，腾讯 mkline 稳定可用）
// 返回结构与日K一致：{ date:'YYYY-MM-DD HH:mm', open, close, high, low, volume(手), amount(元), turnover }
async function fetchTencentKline60m(tencentCode, count = 320) {
  const url = `https://ifzq.gtimg.cn/appstock/app/kline/mkline?param=${tencentCode},m60,,${count}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
    timeout: 10000,
  });
  const data = resp.data?.data?.[tencentCode];
  const bars = data?.m60 || [];
  if (!Array.isArray(bars) || bars.length === 0) return [];
  return bars.map(b => {
    const raw = String(b[0]);
    const date = /^\d{12}$/.test(raw)
      ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)} ${raw.slice(8, 10)}:${raw.slice(10, 12)}`
      : raw;
    const close = parseFloat(b[2]);
    const volume = parseFloat(b[5]) || 0; // 手
    const amount = parseFloat(b[6]) || (close * volume * 100); // 元（b[6] 缺省时按收盘价×股数兜底）
    return {
      date,
      open: parseFloat(b[1]),
      close,
      high: parseFloat(b[3]),
      low: parseFloat(b[4]),
      volume,
      amount,
      turnover: 0,
    };
  }).filter(d => d.close > 0);
}

// Tencent minute data
async function fetchTencentMinutes(tencentCode) {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${tencentCode}`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeout: 8000
    });
    const data = resp.data?.data?.[tencentCode];
    if (!data) return { minutes: [], prevClose: 0 };
    const entries = data.data?.data || [];
    // 昨收：与 fetchTencentQuote 同一口径，腾讯 qt 数组 index[4] 为昨收
    let prevClose = 0;
    const qtArr = data.qt?.[tencentCode];
    if (Array.isArray(qtArr) && qtArr.length > 4) {
      const v = parseFloat(qtArr[4]);
      if (!isNaN(v) && v > 0) prevClose = v;
    }
    const minutes = entries.map(e => {
      const parts = e.split(' ');
      const price = parseFloat(parts[1]);
      const cumVol = parseFloat(parts[2]) || 0; // 累计成交量（手）
      const cumAmt = parseFloat(parts[3]) || 0; // 累计成交额（元）
      const avg = cumVol > 0 ? cumAmt / (cumVol * 100) : price; // 均价 = 累计成交额 / 累计成交股数
      return { time: parts[0], price, avg };
    });
    return { minutes, prevClose };
  } catch {
    return { minutes: [], prevClose: 0 };
  }
}

// ---- Yahoo Finance API (US/HK/international) ----

async function fetchYahooQuote(yahooCode) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooCode)}?range=1d&interval=1m`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA },
    timeout: 8000
  });
  const result = resp.data?.chart?.result?.[0];
  if (!result) return null;

  const meta = result.meta;
  const indicators = result.indicators?.quote?.[0];
  const timestamps = result.timestamp || [];
  const price = meta.regularMarketPrice;
  const prevClose = meta.chartPreviousClose || meta.previousClose || price;
  const change = price - prevClose;
  const changePct = prevClose ? (change / prevClose) * 100 : 0;

  const lastTs = (timestamps.length ? timestamps[timestamps.length - 1] : Math.floor(Date.now() / 1000)) * 1000;
  const dd = new Date(lastTs);
  const yDate = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, '0')}-${String(dd.getDate()).padStart(2, '0')}`;

  return {
    name: meta.shortName || meta.longName || yahooCode,
    code: yahooCode,
    price,
    prevClose,
    date: yDate,
    open: meta.regularMarketPrice ? meta.regularMarketPrice : 0,
    high: meta.regularMarketDayHigh || price,
    low: meta.regularMarketDayLow || price,
    change: parseFloat(change.toFixed(4)),
    changePct: parseFloat(changePct.toFixed(2)),
    volume: meta.regularMarketVolume || 0,
    amount: 0,
    currency: meta.currency || 'USD',
    market: 'yahoo'
  };
}

async function fetchYahooHistory(yahooCode, range = '1y') {
  const interval = '1d';
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooCode)}?range=${range}&interval=${interval}`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA },
    timeout: 8000
  });
  const result = resp.data?.chart?.result?.[0];
  if (!result) return [];

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0];
  if (!q) return [];

  return timestamps.map((ts, i) => {
    const d = new Date(ts * 1000);
    return {
      date: d.toISOString().slice(0, 10),
      open: q.open?.[i] ? parseFloat(q.open[i].toFixed(2)) : 0,
      close: q.close?.[i] ? parseFloat(q.close[i].toFixed(2)) : 0,
      high: q.high?.[i] ? parseFloat(q.high[i].toFixed(2)) : 0,
      low: q.low?.[i] ? parseFloat(q.low[i].toFixed(2)) : 0,
      volume: q.volume?.[i] ? Math.round(q.volume[i]) : 0
    };
  }).filter(d => d.close > 0);
}

// Yahoo quote summary (fundamentals)
async function fetchYahooSummary(yahooCode) {
  const modules = ['summaryDetail', 'financialData', 'defaultKeyStatistics', 'price', 'calendarEvents'];
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooCode)}?modules=${modules.join(',')}`;
  try {
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA },
      timeout: 8000
    });
    const result = resp.data?.quoteSummary?.result?.[0];
    if (!result) return null;

    const sd = result.summaryDetail || {};
    const fd = result.financialData || {};
    const ks = result.defaultKeyStatistics || {};
    const price = result.price || {};

    return {
      name: price.shortName || price.longName || yahooCode,
      sector: price.sectorId || '',
      industry: price.industryId || '',
      marketCap: price.marketCap?.raw || sd.marketCap?.raw || 0,
      pe: sd.trailingPE?.raw || ks.trailingPE?.raw || 0,
      forwardPe: sd.forwardPE?.raw || 0,
      pb: sd.priceToBook?.raw || 0,
      ps: sd.priceToSalesTrailing12Months?.raw || 0,
      peg: sd.pegRatio?.raw || 0,
      evEbitda: sd.enterpriseToEbitda?.raw || ks.enterpriseToEbitda?.raw || 0,
      dividendYield: sd.dividendYield?.raw || 0,
      payoutRatio: sd.payoutRatio?.raw || 0,
      beta: sd.beta?.raw || 0,
      fiftyTwoWeekHigh: sd.fiftyTwoWeekHigh?.raw || 0,
      fiftyTwoWeekLow: sd.fiftyTwoWeekLow?.raw || 0,
      profitMargins: fd.profitMargins?.raw || 0,
      grossMargins: fd.grossMargins?.raw || 0,
      operatingMargins: fd.operatingMargins?.raw || 0,
      returnOnEquity: fd.returnOnEquity?.raw || 0,
      returnOnAssets: fd.returnOnAssets?.raw || 0,
      revenueGrowth: fd.revenueGrowth?.raw || 0,
      earningsGrowth: fd.earningsGrowth?.raw || 0,
      totalCash: fd.totalCash?.raw || 0,
      totalDebt: fd.totalDebt?.raw || 0,
      debtToEquity: fd.debtToEquity?.raw || 0,
      debtMetricPct: false, // 港股/美股：该值为带息债÷权益（无单位比值）
      currentRatio: fd.currentRatio?.raw || 0,
      quickRatio: fd.quickRatio?.raw || 0,
      revenuePerShare: fd.revenuePerShare?.raw || 0,
      earningsGrowthQuarterly: fd.earningsGrowth?.raw || 0,
      targetMeanPrice: ks.targetMeanPrice?.raw || 0,
      targetHighPrice: ks.targetHighPrice?.raw || 0,
      targetLowPrice: ks.targetLowPrice?.raw || 0,
      targetMedianPrice: ks.targetMedianPrice?.raw || 0,
      recommendationMean: ks.recommendationMean?.raw || 0,
      recommendationKey: ks.recommendationKey || '',
      numberOfAnalystOpinions: ks.numberOfAnalystOpinions?.raw || 0,
    };
  } catch (err) {
    return null;
  }
}

// ---- Eastmoney API for A-share fundamentals ----

// 将东方财富返回的财报日期规范为 YYYY-MM-DD（兼容 "2026/03/31"、"2026-03-31 00:00:00" 等）
function normalizeReportDate(raw) {
  if (!raw) return '';
  const s = String(raw).replace(/\//g, '-').trim();
  const m = s.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

// 根据财报日期生成易读报告期标签（如 2026年一季报 / 2026年年报）；东方财富自带 REPORT_DATE_NAME 时优先使用
function reportPeriodLabel(raw) {
  const d = normalizeReportDate(raw);
  if (!d) return '';
  const [y, m] = d.split('-');
  const map = { '03': '一季报', '06': '中报', '09': '三季报', '12': '年报' };
  const label = map[m];
  return label ? `${y}年${label}` : d;
}

// 生成最近 N 个报告期日期（季报），用于 xjllbAjaxNew 等接口
function getRecentReportDates(count = 4) {
  const dates = [];
  const now = new Date();
  let year = now.getFullYear();
  // 根据当前月份推断最新可得季报：Q1 5月、Q2 8月、Q3 11月、年报次年4月
  const month = now.getMonth() + 1;
  let q;
  if (month >= 5 && month <= 7) q = 1;
  else if (month >= 8 && month <= 10) q = 2;
  else if (month >= 11) q = 3;
  else if (month >= 1 && month <= 4) { q = 4; year -= 1; }
  else q = 4; // 5月之前但年报已出，取年报
  const quarterEnds = ['03-31', '06-30', '09-30', '12-31'];
  for (let i = 0; i < count; i++) {
    const idx = q - 1 - i;
    const y = year + Math.floor(idx / 4);
    const qq = ((idx % 4) + 4) % 4;
    dates.push(`${y}-${quarterEnds[qq]}`);
  }
  return dates;
}

// 由总市值(亿)和股价反推总股本（股）
function computeTotalShares(quote) {
  if (!quote || !quote.price || !quote.totalValue) return 0;
  const marketCapYuan = quote.totalValue < 100 ? quote.totalValue * 1e12 : quote.totalValue * 1e8;
  return marketCapYuan / quote.price;
}

// 从东方财富估值分析接口取总股本、行业名称及历史估值序列（datacenter-web 可用，push2 被 TLS 封锁）
async function fetchStockValuationAnalysis(stockCode) {
  try {
    const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=TRADE_DATE&sortTypes=-1&pageSize=500&pageNumber=1&reportName=RPT_VALUEANALYSIS_DET&columns=ALL&source=WEB&client=WEB&filter=(SECURITY_CODE=%22${stockCode}%22)`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://data.eastmoney.com/', Accept: 'application/json' },
      timeout: 10000
    });
    const data = resp.data?.result?.data || [];
    if (data.length === 0) return null;
    const latest = data[0];
    return {
      totalShares: parseFloat(latest.TOTAL_SHARES) || 0,
      boardName: latest.BOARD_NAME || '',
      boardCode: latest.BOARD_CODE || '',
      psTTM: parseFloat(latest.PS_TTM) || 0,
      history: data.map(d => ({
        date: normalizeReportDate(d.TRADE_DATE),
        pe: parseFloat(d.PE_TTM) || 0,
        pb: parseFloat(d.PB_MRQ) || 0,
        ps: parseFloat(d.PS_TTM) || 0,
      })).filter(d => d.pe || d.pb)
    };
  } catch (e) {
    console.error('[ValuationAnalysis] failed:', e.message);
    return null;
  }
}

// Fetch dividend info from Eastmoney datacenter (RPT_SHAREBONUS_DET, same source as deep analysis).
// PRETAX_BONUS_RMB is per 10 shares (e.g. 9.8 means 0.98 per share). Yield = perShare / price.
async function fetchDividendInfo(stockCode, price) {
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=REPORT_DATE&sortTypes=-1&pageSize=30&pageNumber=1&reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  const resp = await axios.get(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' },
    timeout: 10000
  });
  const data = resp.data?.result?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  // Data sorted by REPORT_DATE desc — collect records with non-zero cash dividend (latest first)
  const paid = data.filter(d => parseFloat(d.PRETAX_BONUS_RMB) > 0);
  const latest = paid[0] || null;
  if (!latest) return null;
  const dividendPerShare = (parseFloat(latest.PRETAX_BONUS_RMB) || 0) / 10;
  const yieldPct = price > 0 ? Math.round(dividendPerShare / price * 10000) / 100 : 0;
  const years = new Set(data.map(d => (d.REPORT_DATE || '').slice(0, 4)).filter(y => y)).size;
  // 每股股息同比：最新一期 vs 上一期（用于股息率同比高低变化判断，同源：东财分红接口）
  let dividendPerSharePrev = 0, dividendYoyPct = null;
  if (paid.length >= 2) {
    dividendPerSharePrev = (parseFloat(paid[1].PRETAX_BONUS_RMB) || 0) / 10;
    if (dividendPerSharePrev > 0) dividendYoyPct = Math.round((dividendPerShare / dividendPerSharePrev - 1) * 10000) / 100;
  }
  return {
    dividendYield: yieldPct,
    dividendPerShare,
    dividendPerSharePrev,
    dividendYoyPct,
    dividendYears: years,
    latestPlan: latest.IMPL_PLAN_PROFILE || '',
    latestReportDate: latest.REPORT_DATE || '',
  };
}

async function fetchEastmoneyFundamentals(stockCode, exchange, quote) {
  const result = {};

  // 从估值分析接口取总股本与行业（优先于由总市值反推，更准确）
  const valuationInfo = await fetchStockValuationAnalysis(stockCode);
  if (valuationInfo) {
    result.totalShares = valuationInfo.totalShares;
    result.industryName = valuationInfo.boardName;
    result.valuationHistory = valuationInfo.history;
    // 直接用东财 PS_TTM（TTM 口径，正确），避免本地用单季营收算 PS 导致虚高
    if (valuationInfo.psTTM > 0) result.ps = valuationInfo.psTTM;
  }

  // Use the new financial analysis API (ZYZBAjaxNew)
  try {
    const code = `${exchange}${stockCode}`;
    const url = `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${code}`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://emweb.securities.eastmoney.com/', Accept: 'application/json' },
      timeout: 15000
    });

    if (resp.data?.data && resp.data.data.length > 0) {
      const d = resp.data.data[0]; // Most recent quarter
      const d2 = resp.data.data[1] || {}; // Previous quarter for fallback
      result.roe = d.ROEJQ || d2.ROEJQ || 0;              // 净资产收益率
      result.grossMargin = d.XSMLL || d2.XSMLL || 0;       // 销售毛利率
      result.netMargin = d.XSJLL || d2.XSJLL || 0;          // 销售净利率
      result.revenueYoy = d.TOTALOPERATEREVETZ || d.DJD_TOI_YOY || d2.TOTALOPERATEREVETZ || 0; // 营收同比增长率
      result.profitYoy = d.PARENTNETPROFITTZ || d.DJD_DPNP_YOY || d2.PARENTNETPROFITTZ || 0;   // 归母净利润同比增长率
      result.eps = d.EPSJB || 0;                // 每股基本收益
      result.bps = d.BPS || 0;                  // 每股净资产
      result.debtToEquity = d.ZCFZL || 0;       // 资产负债率（百分比）
      result.debtMetricPct = true;              // A股：该值为资产负债率%，非债务/权益比
      result.currentRatio = d.LD || 0;          // 流动比率
      result.quickRatio = d.SD || 0;            // 速动比率
      result.totalAssets = d.JZC || 0;          // 净资产
      result.revenue = d.TOTALOPERATEREVE || 0; // 营业总收入
      result.netProfit = d.PARENTNETPROFIT || 0; // 归母净利润
      // 财报报告期：PE/PB 等估值指标所用的每股收益、每股净资产来自该披露期
      const repRaw = d.REPORT_DATE || d.REPORTDATE || d.BBDATE || '';
      result.reportDate = normalizeReportDate(repRaw);
      result.reportPeriod = d.REPORT_DATE_NAME || reportPeriodLabel(repRaw);
      // 保留原始多期数据，供历史百分位计算使用
      result.zyzbHistory = resp.data.data;
      // 20260909j：统一 TTM 指标（单一权威源）——关键财务指标行 / 基本面评分 / 利好利空信号 / 历史百分位 /
      // 深度分析 ROE 走势图全部共用本处计算的字段，禁止各消费方自行对 ROEJQ/XSMLL/XSJLL 等比率跨期加减。
      const ttm = computeTtmMetrics(resp.data.data, result.totalShares);
      if (ttm) {
        result.roeTtm = ttm.roe;               // ROE(TTM) = TTM归母净利 ÷ 期末归母净资产（摊薄）
        result.roeTtmBasis = ttm.roeBasis;     // 计算口径说明（含窗口三期名称）
        result.roeTtmPrev = ttm.roePrev;       // 截至上年同期的同口径 TTM ROE（「去年同期」用）
        result.grossMarginTtm = ttm.grossMargin;
        result.netMarginTtm = ttm.netMargin;
        result.ttmBasis = ttm.windowNote;
      }
    }
  } catch (e) {
    console.error('Eastmoney financial API failed:', e.message);
  }

  // 现金流量表：取最新一期经营活动现金流净额，并计算每股经营现金流
  // 不同行业 companyType 不同（通用4/银行2/保险3/券商1），依次尝试
  try {
    const code = `${exchange}${stockCode}`;
    const dates = getRecentReportDates(4);
    let list = null;
    for (const companyType of [4, 2, 3, 1]) {
      try {
        const url = `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/xjllbAjaxNew?companyType=${companyType}&reportDateType=0&reportType=1&dates=${dates.join(',')}&code=${code}`;
        const resp = await axios.get(url, {
          headers: { 'User-Agent': UA, Referer: 'https://emweb.securities.eastmoney.com/', Accept: 'application/json' },
          timeout: 10000
        });
        const arr = resp.data?.data;
        if (Array.isArray(arr) && arr.length > 0) {
          list = arr;
          break;
        }
      } catch (e2) {
        // try next companyType
      }
    }
    if (Array.isArray(list) && list.length > 0) {
      const sorted = [...list].sort((a, b) => new Date(b.REPORT_DATE) - new Date(a.REPORT_DATE));
      const latest = sorted[0];
      const ocf = parseFloat(latest.NETCASH_OPERATE) || 0;
      if (ocf) {
        result.operatingCashFlow = ocf;
        const totalShares = result.totalShares || computeTotalShares(quote);
        if (totalShares > 0) {
          result.operatingCashFlowPerShare = ocf / totalShares;
          result.operatingCashFlowSource = '东方财富财报';
          const repRaw = latest.REPORT_DATE || '';
          result.operatingCashFlowPeriod = normalizeReportDate(repRaw);
          result.operatingCashFlowPeriodName = reportPeriodLabel(repRaw);
        }
      }
    }
  } catch (e) {
    console.error('[OCF] fetch failed:', e.message);
  }

  // 股息率：复用东财 datacenter 分红接口(与深度分析同源,已实测可用)
  try {
    const divInfo = await fetchDividendInfo(stockCode, quote?.price);
    if (divInfo) {
      result.dividendYield = divInfo.dividendYield;        // 百分数，如 1.84
      result.dividendPerShare = divInfo.dividendPerShare;  // 元
      result.dividendPerSharePrev = divInfo.dividendPerSharePrev; // 元（上一期）
      result.dividendYoyPct = divInfo.dividendYoyPct;      // 每股股息同比 %
      result.dividendYears = divInfo.dividendYears;        // 有分红记录的年数
      result.dividendPlan = divInfo.latestPlan;            // 如「10派9.80元(含税)」
      result.dividendYieldSource = '东财分红数据';
      result.dividendYieldIsPct = true;                    // A股东财口径：dividendYield 已是百分数（避免 <1 时被误判为小数翻倍）
    }
  } catch (e) {
    console.error('[Dividend] fetch failed:', e.message);
  }

  return result;
}

// Compute price-to-sales from total market cap (Tencent quote) and revenue (Eastmoney financials)
// Tencent totalValue: <100 means 万亿，>=100 means 亿；Eastmoney revenue is in yuan.
function computePS(totalValue, revenue) {
  if (!totalValue || !revenue) return 0;
  const marketCapYuan = totalValue < 100 ? totalValue * 1e12 : totalValue * 1e8;
  return marketCapYuan / revenue;
}

// ---- 20260909j：统一 TTM 指标计算（单一权威源）----
// 背景：ROEJQ / XSMLL / XSJLL 是「比率」，各期分母（加权净资产/营收）不同，对比率跨期直接加减
//（最新期 + 上年报 − 上年同期）在数学上不成立。正确做法：可加分子（归母净利、毛利额、净利额）
// 与可加分母（营收、归母净资产）先各自滚动 12 个月，再相除。
// 口径定义：
//   ROE(TTM)    = TTM归母净利 ÷ 期末归母净资产（BPS × 总股本，摊薄口径）
//   毛利率(TTM)  = TTM毛利额（MLR，缺失时按 XSMLL×营收重构） ÷ TTM营收
//   净利率(TTM)  = TTM净利额（按 XSJLL×营收重构） ÷ TTM营收
//   roePrev      = 截至上年同期的同口径 TTM ROE（供「去年同期」同口径对比）
// 锚点期本身为年报（12-31）时无需滚动，直接取年报值；窗口缺上一年报或上年同期时对应值返回 null。
function computeTtmMetrics(rows, totalShares) {
  const toN = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const shares = toN(totalShares);
  const rs = rows
    .map(d => ({
      date: String(d.REPORT_DATE || '').slice(0, 10),
      name: d.REPORT_DATE_NAME || '',
      np: toN(d.PARENTNETPROFIT),
      rev: toN(d.TOTALOPERATEREVE),
      mlr: toN(d.MLR),
      gm: toN(d.XSMLL),
      nm: toN(d.XSJLL),
      bps: toN(d.BPS),
    }))
    .filter(r => r.date && !isNaN(new Date(r.date).getTime()))
    .sort((a, b) => (a.date < b.date ? 1 : -1)); // 降序：最新在前
  if (!rs.length) return null;
  // 滚动12个月：窗口 = [锚点期, 上一年报(12-31), 上年同期]；list[0] 为锚点期
  const roll = (list, pick) => {
    const a0 = list[0];
    if (!a0) return null;
    if (a0.date.slice(5) === '12-31') {
      const v = pick(a0);
      return v == null ? null : { v, label: `${a0.name}（年报直取）` };
    }
    const py = String(Number(a0.date.slice(0, 4)) - 1);
    const fy = list.find(r => r.date.slice(0, 4) === py && r.date.slice(5) === '12-31');
    const sm = list.find(r => r.date.slice(0, 4) === py && r.date.slice(5) === a0.date.slice(5));
    if (!fy || !sm) return null;
    const v0 = pick(a0), v1 = pick(fy), v2 = pick(sm);
    if (v0 == null || v1 == null || v2 == null) return null;
    return { v: v0 + v1 - v2, label: `${a0.name}+${fy.name}−${sm.name}` };
  };
  const eqOf = (r) => {
    const eq = (r && r.bps != null && shares > 0) ? r.bps * shares : null;
    return (eq != null && eq > 0) ? eq : null;
  };
  const out = {
    windowNote: rs[0].date.slice(5) === '12-31'
      ? `${rs[0].name}（年报直取，无需滚动）`
      : `滚动12个月＝${rs[0].name}＋上一年报−上年同期`,
    roe: null, roeBasis: '', roePrev: null, grossMargin: null, netMargin: null,
  };
  // ROE(TTM) 与「去年同期」同口径值
  const npT = roll(rs, r => r.np);
  const eqNow = eqOf(rs[0]);
  if (npT != null && eqNow) {
    out.roe = npT.v / eqNow * 100;
    out.roeBasis = `TTM归母净利（${npT.label}） ÷ 期末归母净资产（BPS ${rs[0].bps.toFixed(2)} × 总股本，摊薄）`;
  }
  const py = String(Number(rs[0].date.slice(0, 4)) - 1);
  const smAnchor = rs.find(r => r.date.slice(0, 4) === py && r.date.slice(5) === rs[0].date.slice(5));
  if (smAnchor) {
    const sub = rs.filter(r => r.date <= smAnchor.date);
    const npP = roll(sub, r => r.np);
    const eqP = eqOf(smAnchor);
    if (npP != null && eqP) out.roePrev = npP.v / eqP * 100;
  }
  // 毛利率 / 净利率 TTM：分子分母均可加
  const revT = roll(rs, r => r.rev);
  if (revT != null && revT.v > 0) {
    const mlrT = roll(rs, r => r.mlr);
    if (mlrT != null) {
      out.grossMargin = mlrT.v / revT.v * 100;
    } else {
      const gmN = roll(rs, r => (r.gm != null && r.rev != null ? r.gm / 100 * r.rev : null));
      if (gmN != null) out.grossMargin = gmN.v / revT.v * 100;
    }
    const nmN = roll(rs, r => (r.nm != null && r.rev != null ? r.nm / 100 * r.rev : null));
    if (nmN != null) out.netMargin = nmN.v / revT.v * 100;
  }
  return out;
}

// ---- Unified API ----

async function getQuote(input) {
  const info = detectMarket(input);

  // Use Tencent API for ALL markets (CN, HK, US)
  try {
    const quote = await fetchTencentQuote(info.tencentCode);
    if (quote) {
      // Build fundamentals from Tencent quote data (available for all markets)
      quote.fundamentals = {
        pe: quote.pe || 0,
        pb: quote.pb || 0,
        totalValue: quote.totalValue || 0,
        circulationValue: quote.circulationValue || 0,
      };

      // Try to add more fundamentals from Eastmoney for CN stocks
      if (info.market === 'CN') {
        try {
          const fund = await fetchEastmoneyFundamentals(info.tencentCode.replace(/^(sh|sz)/, ''), info.exchange, quote);
          if (fund) {
            // Merge all fields from Eastmoney, overwriting Tencent defaults
            Object.assign(quote.fundamentals, fund);
            // Data provenance labels for the frontend
            quote.fundamentals.peSource = '腾讯行情';
            quote.fundamentals.pbSource = '腾讯行情';
            quote.fundamentals.roeSource = '东方财富财报';
            quote.fundamentals.reportSource = '东方财富财报';
            quote.fundamentals.psSource = fund.ps ? '东方财富估值(PS_TTM)' : '本地计算（总市值/营业收入）';
          }
        } catch {}
        // Compute PS if not present and revenue is available
        if (!quote.fundamentals.ps && quote.fundamentals.revenue) {
          quote.fundamentals.ps = computePS(quote.totalValue, quote.fundamentals.revenue);
        }
        // Tencent A-share PE is rolling TTM by convention
        quote.fundamentals.peType = 'TTM';
      } else {
        quote.fundamentals.peSource = quote.pe ? '行情数据' : '';
        quote.fundamentals.pbSource = quote.pb ? '行情数据' : '';
      }
      return { ...quote, marketType: info.market, exchange: info.exchange };
    }
  } catch (e) {
    console.error('Tencent quote failed:', e.message);
  }

  // Fallback to Yahoo (may be blocked in some regions)
  try {
    const quote = await fetchYahooQuote(info.yahooCode);
    if (quote) {
      try {
        const summary = await fetchYahooSummary(info.yahooCode);
        if (summary) quote.fundamentals = summary;
      } catch {}
      return { ...quote, marketType: info.market, exchange: info.exchange };
    }
  } catch (e) {
    console.error('Yahoo quote failed:', e.message);
  }

  return null;
}

async function fetchEastmoneyHistoryRetry(input, count = 320, retries = 2, period = 'day') {
  for (let i = 0; i <= retries; i++) {
    try {
      const history = await fetchEastmoneyHistory(input, count, period);
      if (history.length > 5) return history;
    } catch (e) {
      console.error(`Eastmoney history attempt ${i + 1} failed:`, e.message);
      if (i < retries) await new Promise(r => setTimeout(r, 1000));
    }
  }
  return [];
}

// 按周期（日/60分钟/周/月）取 K 线，主要供 60分钟周期切换使用
async function getHistoryPeriod(input, period = 'day', count = 320) {
  if (period === '60m') {
    const info = detectMarket(input);
    try {
      const bars = await fetchTencentKline60m(info.tencentCode, count);
      if (bars.length > 5) return bars;
    } catch (e) {
      console.error('Tencent 60m history failed:', e.message);
    }
  }
  return fetchEastmoneyHistoryRetry(input, count, 2, period);
}

// 个股换手率序列（用于短期判断「换手率变化」信号）。
// 腾讯日K线不含换手率，故直接走东财 kline（含 f61 换手率），失败返回空数组（上层按中性处理）。
async function getEastmoneyTurnover(symbol, count = 60) {
  const em = await fetchEastmoneyHistoryRetry(symbol, count);
  if (!Array.isArray(em) || em.length < 6) return [];
  return em
    .map(h => ({ date: h.date, turnover: (typeof h.turnover === 'number' ? h.turnover : 0), close: h.close }))
    .filter(h => h.turnover > 0 && typeof h.close === 'number');
}

async function getHistory(input, range = '1y') {
  const info = detectMarket(input);
  const count = range === '10y' ? 2500 : range === '5y' ? 1200 : range === '3y' ? 720 : range === '2y' ? 480 : range === '6m' ? 130 : range === '3m' ? 65 : 320;

  // For CN and HK stocks: Tencent API is most reliable
  if (info.market === 'CN' || info.market === 'HK') {
    try {
      const history = await fetchTencentHistory(info.tencentCode, count);
      if (history.length > 5) return history;
    } catch (e) {
      console.error('Tencent history failed:', e.message);
    }
    // Fallback to Eastmoney with retries
    const emHistory = await fetchEastmoneyHistoryRetry(input, count);
    if (emHistory.length > 0) return emHistory;
  }

  // For US stocks: try Eastmoney with retries first
  if (info.market === 'US') {
    const emHistory = await fetchEastmoneyHistoryRetry(input, count, 3);
    if (emHistory.length > 5) return emHistory;

    // Fallback to Tencent (may only have 1-2 bars)
    try {
      const history = await fetchTencentHistory(info.tencentCode, count);
      if (history.length > 0) return history;
    } catch (e) {
      console.error('Tencent US history failed:', e.message);
    }

    // Last resort: Yahoo
    try {
      const history = await fetchYahooHistory(info.yahooCode, range);
      if (history.length > 0) return history;
    } catch (e) {
      console.error('Yahoo history failed:', e.message);
    }
  }

  return [];
}

// ---- Search stocks ----

// 解析腾讯 smartbox 返回的 v_hint 字符串：条目用 ^ 分隔，字段用 ~ 分隔（market~code~name~pinyin~type）
// 非 ASCII 字符（中文名）以 \uXXXX 转义返回，需还原。
function parseTencentSmartbox(body) {
  if (!body) return [];
  const m = /v_hint="([^"]*)"/.exec(String(body));
  if (!m || !m[1]) return [];
  const decode = (s) => String(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return m[1].split('^').map(seg => {
    const p = seg.split('~');
    if (p.length < 4) return null;
    return { tag: p[0], code: p[1], name: decode(p[2] || ''), pinyin: p[3] || '', type: p[4] || '' };
  }).filter(Boolean);
}

// 将 smartbox 条目映射为统一搜索结构；仅保留个股/基金，剔除无效类型
function mapSmartboxItem(it) {
  const tag = (it.tag || '').toLowerCase();
  let market, exchange, symbol = it.code;
  if (tag === 'sh') { market = 'CN'; exchange = 'SH'; }
  else if (tag === 'sz') { market = 'CN'; exchange = 'SZ'; }
  else if (tag === 'hk') { market = 'HK'; exchange = 'HK'; }
  else if (tag === 'us') { market = 'US'; exchange = 'US'; symbol = (it.code || '').split('.')[0].toUpperCase(); }
  else return null;
  const okType = ['GP-A', 'GP', 'FJ', 'LOF', 'ETF', ''];
  if (!symbol || !okType.includes(it.type)) return null;
  return {
    code: it.code,
    name: it.name || it.code,
    symbol,
    market,
    exchange,
    pinyin: it.pinyin || '',
  };
}

async function searchStocks(keyword) {
  const kw = String(keyword || '').trim();
  if (!kw) return [];
  const results = [];
  const seen = new Set();
  const push = (r) => {
    if (r && r.symbol && !seen.has(r.symbol)) { seen.add(r.symbol); results.push(r); }
  };

  // 1) 腾讯 smartbox：代码 / 名称 / 拼音首字母 均可匹配，本机稳定可用
  try {
    const url = `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(kw)}&t=all&c=1`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://gu.qq.com/' },
      timeout: 6000,
      responseType: 'text',
    });
    for (const it of parseTencentSmartbox(resp.data)) push(mapSmartboxItem(it));
  } catch (e) {
    console.error('Tencent smartbox failed:', e.message);
  }

  // 2) 东财搜索兜底（searchapi 在本机可能被 TLS 阻断）
  try {
    const url = `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(kw)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10`;
    const resp = await axios.get(url, {
      headers: { 'User-Agent': UA, Referer: 'https://www.eastmoney.com/' },
      timeout: 6000
    });
    for (const item of (resp.data?.QuotationCodeTable?.Data || [])) {
      const code = item.Code || '';
      const info = detectMarket(code);
      let market = info.market, exchange = info.exchange;
      if (item.MarketNum === 0) { market = 'CN'; exchange = 'SZ'; }
      else if (item.MarketNum === 1) { market = 'CN'; exchange = 'SH'; }
      else if (item.MarketNum === 116) { market = 'HK'; exchange = 'HK'; }
      push({ code, name: item.Name || '', symbol: market === 'HK' ? code.replace(/^hk/i, '') : code, market, exchange, pinyin: item.Pinyin || '' });
    }
  } catch (e) {
    console.error('Eastmoney search failed:', e.message);
  }

  // 3) 最后兜底：直接按代码识别
  if (results.length === 0) {
    const info = detectMarket(kw);
    push({ code: kw, name: kw, symbol: kw, market: info.market, exchange: info.exchange, pinyin: '' });
  }

  return results;
}

module.exports = { detectMarket, getQuote, getHistory, getHistoryPeriod, getHistoryDeep, getEastmoneyTurnover, searchStocks, fetchTencentMinutes, fetchEastmoneyHistory, getEastmoneySecid, getMarketOverview, getEastmoneySectorRanking, getThsSectorRanking, parseSwSectorName, getSwSecondLevelNames, findPythonForScript, SW_LEVEL_UNIFIED };
