/**
 * Futures Correlation Module
 * 为产品型公司（如中国海油↔原油期货）提供期货指数与股价的关联分析。
 * 数据来源：新浪财经期货日线 (InnerFuturesNewService.getDailyKLine)
 * 股价来源：项目既有 getHistory（腾讯日线）
 */
const axios = require('axios');
const { getHistory, detectMarket } = require('./stockData');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 股票代码(6位) -> 关联期货
// symbol: 新浪期货连续合约代码; name: 中文名; note: 关联逻辑说明
const FUTURES_MAP = {
  // —— 原油/能源 ——
  '600938': { symbol: 'sc0', name: '原油(上海)', note: '中国海油主要从事上游油气勘探开发，原油价格是决定其销售收入与利润的核心变量。' },
  '601857': { symbol: 'sc0', name: '原油(上海)', note: '中国石油业务涵盖勘探开采与炼化，原油价格直接影响上游板块盈利。' },
  '600028': { symbol: 'sc0', name: '原油(上海)', note: '中国石化以炼化为主，油价通过炼油价差与库存收益间接影响业绩。' },
  '601808': { symbol: 'sc0', name: '原油(上海)', note: '中海油服为海上油田服务商，油价高低决定油公司资本开支意愿，进而影响其工作量。' },
  '600583': { symbol: 'sc0', name: '原油(上海)', note: '海油工程从事海上油气工程，与中海油资本开支及油价高度相关。' },
  '600256': { symbol: 'sc0', name: '原油(上海)', note: '广汇能源涉及LNG与煤化工，能源价格影响其产品盈利。' },
  '002493': { symbol: 'sc0', name: '原油(上海)', note: '荣盛石化主营炼化，原油成本与化工品价差决定其利润。' },
  '600346': { symbol: 'sc0', name: '原油(上海)', note: '恒力石化以炼化一体化为主，油价通过原料成本与库存收益影响盈利。' },
  // —— 铜 ——
  '601899': { symbol: 'cu0', name: '铜(沪铜)', note: '紫金矿业铜产量占比高，铜价是核心利润驱动。' },
  '600362': { symbol: 'cu0', name: '铜(沪铜)', note: '江西铜业为铜冶炼加工龙头，铜价影响加工费与库存收益。' },
  '000630': { symbol: 'cu0', name: '铜(沪铜)', note: '铜陵有色主营阴极铜，铜价直接决定产品收入。' },
  '000878': { symbol: 'cu0', name: '铜(沪铜)', note: '云南铜业为铜冶炼企业，铜价影响其营收与利润。' },
  '601168': { symbol: 'cu0', name: '铜(沪铜)', note: '西部矿业拥有铜铅锌矿，铜价贡献主要利润。' },
  '600362': { symbol: 'cu0', name: '铜(沪铜)', note: '江西铜业。' },
  // —— 黄金/白银 ——
  '600547': { symbol: 'au0', name: '黄金(沪金)', note: '山东黄金为纯黄金开采企业，金价直接决定其利润。' },
  '600489': { symbol: 'au0', name: '黄金(沪金)', note: '中金黄金黄金储量丰富，金价为核心驱动。' },
  '600988': { symbol: 'au0', name: '黄金(沪金)', note: '赤峰黄金以黄金开采为主，金价高度相关。' },
  '000975': { symbol: 'au0', name: '黄金(沪金)', note: '银泰黄金金矿资源为主，金价驱动盈利。' },
  '002155': { symbol: 'au0', name: '黄金(沪金)', note: '湖南黄金金锑并举，金价为主驱动。' },
  '601899b': { symbol: 'au0', name: '黄金(沪金)', note: '紫金矿业黄金产量同样可观，金价影响显著。' },
  // —— 螺纹钢/钢铁 ——
  '600019': { symbol: 'rb0', name: '螺纹钢', note: '宝钢股份为钢铁龙头，钢价与原料成本决定利润。' },
  '000898': { symbol: 'rb0', name: '螺纹钢', note: '鞍钢股份主营板材与长材，钢价为核心变量。' },
  '000932': { symbol: 'rb0', name: '螺纹钢', note: '华菱钢铁，钢价与需求影响其盈利。' },
  '000959': { symbol: 'rb0', name: '螺纹钢', note: '首钢股份，钢价驱动业绩。' },
  '000709': { symbol: 'rb0', name: '螺纹钢', note: '河钢股份，钢价为核心变量。' },
  // —— 铝 ——
  '601600': { symbol: 'al0', name: '铝(沪铝)', note: '中国铝业为氧化铝/电解铝龙头，铝价决定利润。' },
  '000807': { symbol: 'al0', name: '铝(沪铝)', note: '云铝股份水电铝企业，铝价为核心驱动。' },
  '600219': { symbol: 'al0', name: '铝(沪铝)', note: '南山铝业铝加工一体化，铝价影响盈利。' },
  // —— 锌/铅 ——
  '000060': { symbol: 'zn0', name: '锌(沪锌)', note: '中金岭南铅锌矿企，锌价为核心驱动。' },
  '600497': { symbol: 'zn0', name: '锌(沪锌)', note: '驰宏锌锗铅锌龙头，锌价决定利润。' },
  // —— 煤炭 ——
  '601088': { symbol: 'jm0', name: '焦煤', note: '中国神华以动力煤为主，焦煤价格是其煤价体系的重要参照。' },
  '601898': { symbol: 'jm0', name: '焦煤', note: '中煤能源煤炭巨头，煤价决定其盈利。' },
  '600188': { symbol: 'jm0', name: '焦煤', note: '兖矿能源，煤价为核心变量。' },
  '601225': { symbol: 'jm0', name: '焦煤', note: '陕西煤业，煤价驱动业绩。' },
  // —— 化工 ——
  '601233': { symbol: 'ta0', name: 'PTA', note: '桐昆股份聚酯龙头，PTA与原油价差决定利润。' },
  '600426': { symbol: 'ma0', name: '甲醇', note: '华鲁恒升煤化工，甲醇等化工品价格影响盈利。' },
  // —— 橡胶 ——
  '601118': { symbol: 'ru0', name: '橡胶(沪胶)', note: '海南橡胶天然橡胶种植加工，胶价为唯一核心变量。' },
  // —— 糖 ——
  '600737': { symbol: 'sr0', name: '白糖', note: '中粮糖业食糖产业龙头，糖价决定利润。' },
  '000911': { symbol: 'sr0', name: '白糖', note: '南宁糖业制糖企业，糖价核心驱动。' },
  // —— 农产品 ——
  '600598': { symbol: 'a0', name: '豆一', note: '北大荒土地发包与农产品，粮价影响其收益。' },
  // HK 代码
  '00883': { symbol: 'sc0', name: '原油(上海)', note: '中国海洋石油(港股)，原油价格为核心驱动。' },
  '00857': { symbol: 'sc0', name: '原油(上海)', note: '中国石油股份(港股)，油价影响上游盈利。' },
  '00386': { symbol: 'sc0', name: '原油(上海)', note: '中国石油化工(港股)，炼化价差受油价影响。' },
};

// 备用别名（避免重复键）
FUTURES_MAP['601899_au'] = { symbol: 'au0', name: '黄金(沪金)', note: '紫金矿业黄金产量同样可观，金价影响显著。' };

function getFuturesMeta(symbol) {
  const info = detectMarket(symbol);
  const code = info.tencentCode.replace(/^(sh|sz|hk)/, '');
  return FUTURES_MAP[code] || null;
}

// 抓取新浪期货日线
async function fetchSinaFutures(symbol) {
  const url = 'https://stock2.finance.sina.com.cn/futures/api/json.php/InnerFuturesNewService.getDailyKLine?symbol=' + symbol;
  try {
    const r = await axios.get(url, { headers: { 'User-Agent': UA, Referer: 'https://finance.sina.com.cn/' }, timeout: 15000 });
    const arr = Array.isArray(r.data) ? r.data : [];
    return arr
      .map(k => ({ date: k.d, close: parseFloat(k.c) }))
      .filter(x => x.close > 0 && x.date);
  } catch (e) {
    console.error('[Futures] Sina fetch failed for', symbol, e.message);
    return [];
  }
}

// 皮尔逊相关系数
function pearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

/**
 * 计算股票与关联期货的走势关联。
 * 返回 { hasFutures, futuresName, note, correlation, dates, stockNorm, futuresNorm, stockClose, futuresClose, conclusion, reasoning }
 */
async function fetchFuturesCorrelation(symbol, name) {
  const meta = getFuturesMeta(symbol);
  if (!meta) return { hasFutures: false };

  const [stockHist, futHist] = await Promise.all([
    getHistory(symbol, 'daily').catch(() => []),
    fetchSinaFutures(meta.symbol),
  ]);

  if (stockHist.length < 30 || futHist.length < 30) {
    return { hasFutures: true, futuresName: meta.name, note: meta.note, correlation: null,
      conclusion: '股价或期货历史数据不足，暂无法进行关联分析。', reasoning: ['样本不足（需至少30个交易日）。'] };
  }

  // 建日期索引
  const futByDate = {};
  for (const f of futHist) futByDate[f.date] = f.close;

  const dates = [];
  const stockClose = [];
  const futuresClose = [];
  for (const d of stockHist) {
    const fc = futByDate[d.date];
    if (fc && d.close > 0) {
      dates.push(d.date);
      stockClose.push(d.close);
      futuresClose.push(fc);
    }
  }

  if (dates.length < 30) {
    return { hasFutures: true, futuresName: meta.name, note: meta.note, correlation: null,
      conclusion: '股价与期货的可比交易日不足，暂无法进行关联分析。', reasoning: ['对齐后的共同交易日少于30天。'] };
  }

  // 归一化（基准日=100）
  const sBase = stockClose[0], fBase = futuresClose[0];
  const stockNorm = stockClose.map(v => Math.round(v / sBase * 1000) / 10);
  const futuresNorm = futuresClose.map(v => Math.round(v / fBase * 1000) / 10);

  const corr = Math.round(pearson(stockNorm, futuresNorm) * 1000) / 1000;

  // 区间涨跌幅
  const stockChg = Math.round((stockClose[stockClose.length - 1] / sBase - 1) * 1000) / 10;
  const futChg = Math.round((futuresClose[futuresClose.length - 1] / fBase - 1) * 1000) / 10;

  // 结论与推导
  let level, conclusion;
  const absC = Math.abs(corr);
  if (absC >= 0.6) level = '高度';
  else if (absC >= 0.35) level = '中度';
  else if (absC >= 0.15) level = '弱';
  else level = '基本无';

  const dir = corr >= 0 ? '正' : '负';
  conclusion = `股价与${meta.name}期货走势呈现${level}${dir}相关（相关系数 ${corr.toFixed(2)}）。` +
    `统计区间内，股价${stockChg >= 0 ? '上涨' : '下跌'}${Math.abs(stockChg)}%，${meta.name}期货${futChg >= 0 ? '上涨' : '下跌'}${Math.abs(futChg)}%。` +
    (absC >= 0.6
      ? `两者联动紧密，研判${meta.name}后市对判断该公司股价方向具有重要参考意义。`
      : absC >= 0.35
      ? `两者存在一定联动，可结合${meta.name}走势辅助判断，但需关注公司自身基本面与事件因素。`
      : `两者联动较弱，公司股价更多受自身经营、估值或市场风格驱动，期货走势仅作弱参考。`);

  const reasoning = [
    `关联期货：${meta.name}（新浪代码 ${meta.symbol}）。${meta.note}`,
    `样本区间：共同交易日 ${dates.length} 天（${dates[0]} ~ ${dates[dates.length - 1]}）。`,
    `归一化方法：以区间首日收盘价为基准 100，分别标准化股价与期货价格后计算皮尔逊相关系数。`,
    `股价区间涨跌幅：${stockChg}%；${meta.name}期货区间涨跌幅：${futChg}%。`,
    `相关系数 ${corr.toFixed(2)} → 判定为「${level}${dir}相关」。`,
    absC >= 0.6 ? '相关系数≥0.6，属于强联动，期货方向对股价有较强指示性。'
      : absC >= 0.35 ? '相关系数 0.35~0.6，属于中等联动。'
      : absC >= 0.15 ? '相关系数 0.15~0.35，联动偏弱。'
      : '相关系数<0.15，几乎独立。',
  ];

  return {
    hasFutures: true,
    futuresName: meta.name,
    futuresSymbol: meta.symbol,
    note: meta.note,
    correlation: corr,
    level,
    direction: dir,
    dates,
    stockNorm,
    futuresNorm,
    stockClose,
    futuresClose,
    stockChg,
    futuresChg: futChg,
    conclusion,
    reasoning,
  };
}

module.exports = { fetchFuturesCorrelation, getFuturesMeta, FUTURES_MAP };
