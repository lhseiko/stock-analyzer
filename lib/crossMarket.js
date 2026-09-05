/**
 * 跨市场传导数据层（P2）
 * --------------------------------------------------------------
 * 把「隔夜美股/海外对标股」的涨跌传导到 A 股个股所属板块的情绪判断，
 * 解决"消息敏感性不足"：如 Moderna 隔夜 +177%（mRNA 癌症疫苗催化）→ A股生物医药板块。
 *
 * 数据源：腾讯行情（usXXX 前缀，GBK），本机稳定可用；美股收盘后次日 A 股开盘前可拿到隔夜涨跌。
 * 返回 { ok, benchmarks, avgCapped, signal, extreme, note }。
 */

const { getQuote } = require('./stockData');
// Part B：关联度/弱关联持续性经验库（跨市场对标主题关联度衰减）
const { benchmarkRelevance } = require('./relevanceLearning');

// A股行业/赛道关键词 → 美股对标股（按相关性排序，越靠前越相关）
// 关键词匹配复用 newsSearch.SECTOR_KEYWORDS 的行业关键词；这里按赛道维度给出美股对标。
const US_SECTOR_BENCHMARKS = {
  '医药生物': ['MRNA', 'BNTX'],
  '医疗器械': ['MRNA', 'BNTX'],
  '创新药': ['MRNA', 'BNTX'],
  '疫苗': ['MRNA', 'BNTX'],
  '生物医药': ['MRNA', 'BNTX'],
  '生物制品': ['MRNA', 'BNTX'],
  '化学制药': ['MRNA', 'BNTX'],
  '中药': ['MRNA', 'BNTX'],
  '医疗服务': ['MRNA', 'BNTX'],
  '半导体': ['NVDA', 'AMD'],
  '芯片': ['NVDA', 'AMD'],
  '集成电路': ['NVDA', 'AMD'],
  '人工智能': ['NVDA', 'MSFT'],
  '算力': ['NVDA', 'MSFT'],
  '光模块': ['NVDA', 'MSFT'],
  '消费电子': ['AAPL', 'NVDA'],
  '新能源车': ['TSLA', 'NIO'],
  '新能源': ['TSLA', 'FSLR'],
  '光伏': ['FSLR', 'TSLA'],
  '锂电池': ['TSLA'],
  // 全球大宗商品联动（有色/黄金/能源的全球定价属性强）
  '有色': ['FCX', 'NEM'],
  '有色金属': ['FCX', 'NEM'],
  '黄金': ['NEM', 'GOLD'],
  '铜': ['FCX'],
  '石油': ['XOM', 'CVX'],
  '石油石化': ['XOM', 'CVX'],
  '能源': ['XOM', 'CVX'],
  '煤炭': ['XOM', 'CVX'],
};

// 从行业名推导美股对标（复用 SECTOR_KEYWORDS 的行业→赛道映射思想）
function _benchmarksForIndustry(industryName) {
  const norm = (industryName || '').replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
  if (!norm) return [];
  for (const [k, v] of Object.entries(US_SECTOR_BENCHMARKS)) {
    const kn = k.replace(/行业/g, '').replace(/业/g, '').replace(/[ⅠⅡⅢⅣⅤ]/g, '').trim();
    if (norm.includes(kn) || kn.includes(norm)) {
      return v;
    }
  }
  return [];
}

const EXTREME_THRESHOLD = 8; // 隔夜涨跌超 ±8% 视为极端催化

/**
 * 跨市场传导信号：取美股对标股隔夜涨跌，聚合为 A 股板块情绪输入。
 * 极端涨跌（如 MRNA +177%）按 ±15% 封顶后参与平均，避免单一标的过度主导。
 * Part B 增强（20260823i）：signal 按「对标主题与个股行业的关联度」衰减——
 *   医疗器械对标 MRNA/BNTX（主题 mRNA/疫苗）对圣湘生物是弱关联，信号被压低；
 *   生物医药/疫苗股则高关联，几乎不衰减。relevance 可选，由 buildJudgment 传入含经验折扣的有效关联度。
 */
async function getCrossMarketSignal(industryName, relevance = null) {
  const benchmarks = _benchmarksForIndustry(industryName);
  if (!benchmarks.length) {
    return { ok: false, benchmarks: [], avgCapped: 0, signal: 0, extreme: [], relevance: null, relevanceTheme: null, note: '该行业无明确美股对标，跨市场传导不参与' };
  }
  const quotes = await Promise.all(benchmarks.map(async (sym) => {
    try {
      const q = await getQuote(sym);
      return q && typeof q.changePct === 'number' ? { sym, name: q.name, changePct: q.changePct, date: q.date } : null;
    } catch (e) {
      return null;
    }
  }));
  const valid = quotes.filter(q => q != null);
  if (!valid.length) {
    return { ok: false, benchmarks, avgCapped: 0, signal: 0, extreme: [], relevance: null, relevanceTheme: null, note: '美股对标股行情获取失败' };
  }
  const capped = valid.map(q => Math.max(-15, Math.min(15, q.changePct)));
  const avgCapped = capped.reduce((a, b) => a + b, 0) / capped.length;
  const signal = Math.max(-1, Math.min(1, avgCapped / 8));
  // 对标主题关联度（自衰减：医疗器械→MRNA/BNTX 主题=mRNA/疫苗，弱关联）
  const relInfo = valid.map(q => {
    const r = benchmarkRelevance(industryName, q.sym);
    return { sym: q.sym, theme: r.theme, relevance: r.relevance };
  });
  const best = relInfo.slice().sort((a, b) => b.relevance - a.relevance)[0];
  const selfRel = best ? best.relevance : null;
  // 默认不缩放（relevance 为 null），由调用方传入含经验折扣的有效关联度覆盖
  const effRel = (typeof relevance === 'number') ? relevance : 1;
  const scaledSignal = Math.max(-1, Math.min(1, signal * effRel));
  const extreme = valid.filter(q => Math.abs(q.changePct) >= EXTREME_THRESHOLD);
  const note = `美股对标 ${valid.map(q => `${q.name}${q.changePct >= 0 ? '+' : ''}${Math.round(q.changePct)}%`).join('、')}（隔夜 ${valid[0] && valid[0].date || ''}）${effRel !== 1 ? `；对标主题关联度 ${effRel}` : ''}`;
  return {
    ok: true,
    benchmarks: valid,
    avgCapped: Math.round(avgCapped * 10) / 10,
    signal: Math.round(scaledSignal * 1000) / 1000,
    relevance: (typeof relevance === 'number') ? relevance : selfRel,
    relevanceTheme: best ? best.theme : null,
    extreme,
    extremeThreshold: EXTREME_THRESHOLD,
    note,
  };
}

// 对外暴露行业→美股对标（供 buildJudgment 先算有效关联度再回传）
function benchmarksForIndustry(industryName) {
  return _benchmarksForIndustry(industryName);
}

module.exports = { getCrossMarketSignal, benchmarksForIndustry, US_SECTOR_BENCHMARKS };
