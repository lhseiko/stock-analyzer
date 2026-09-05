/**
 * 短期行情判断引擎（预测下一开盘日涨跌）
 * --------------------------------------------------------------
 * 结合短期信号做透明加权打分，输出可解释的「短期行情判断」：
 *   1) 市场情绪与消息面（网络讨论热度 + 个股/板块新闻情感 + 财报是否符合预期 + 内幕抢跑 + 板块消息联动 + 跨市场传导 + 全网舆情 + 量能活跃度）
 *      —— 20260823i 起，原「公司近期重大利好/利空」因子已并入本因子（权重由 0.16 提升至 0.38）
 *   2) 资金量能          (capitalFlow 主力净流入 + 量价 + 融资余额变化)
 *   3) 对标期货短期走势  (futuresData 相关性 + 期货近5日涨跌幅)
 *   4) 大盘及行业板块指数短期走势 (marketOverview 大盘平均涨跌幅 + 所属行业板块整体涨跌)
 *   5) 股票增持减持      (前十大股东增持/减持方向)
 *   6) 板块涨跌停占比    (所属板块涨停/跌停家数占比)
 *   7) 板块跷跷板(科技/半导体负相关)  (科技/半导体板块当日整体涨跌 → 非科技个股反向信号；
 *      科技/半导体行业个股本身即被参照板块，因子不适用)
 *
 * 每个因子都给出：方向(+1/-1/0)、权重、贡献分、取值、判断依据文字，
 * 因此「判断逻辑」完全可查看。判断按「每只股票每个交易日一次」持久化，
 * 每日 15:30 盘后按次日 K 线收盘价结算命中，累计统计准确率。
 * 长期走势判断请见 lib/longTermJudgment.js（不核算准确率）。
 */

const fs = require('fs');
const path = require('path');

// ---- 复用现有数据层 ----
const { getQuote, getHistory, getHistoryDeep, getHistoryPeriod, getMarketOverview, getEastmoneyTurnover } = require('./stockData');
const { analyzeSentiment } = require('./analysis');
const { getNews, fetchEastmoneyContentNews, getSectorNewsSentiment, SECTOR_KEYWORDS } = require('./newsSearch');
const { analyzeCapitalFlow } = require('./capitalFlow');
const { fetchFuturesCorrelation, getFuturesMeta } = require('./futuresData');
const { industryAnalysis } = require('./industryAnalysis');
const { resolveSectorIdentity, getSectorKeywords } = require('./sectorIdentity');
const { getCompanyProfile, getShareholdersData } = require('./shareholderData');
const { getMarketSentiment } = require('./sentiment');
// 20260821f：财报事件 → 资料库自动同步（一致性原则：判断引擎识别到最新定期报告发布时，
// 自动补齐资料库缺失的 PDF；仅作事件检测与异步同步，不阻塞判断生成）
const reportSync = require('./reportSync');
const { getSectorTrend, getBoardsTrend } = require('./sectorTrend');
const { getSectorLimitStats } = require('./sectorLimitStats');
const { getCrossMarketSignal, benchmarksForIndustry } = require('./crossMarket');
// Part B：关联度 / 弱关联持续性经验库（relevanceScore / effectiveRelevance / benchmarkRelevance / recordOutcome）
const { relevanceScore, effectiveRelevance, benchmarkRelevance, recordOutcome } = require('./relevanceLearning');
const { getGlobalSentiment, interpretReport, searchAnnouncements, searchAnnouncementsByCode, getRegulatoryNews } = require('./cnscraperAdapter');
const { readEarningsCache, extractEarningsSignal } = require('./aiAugment');
const { analyzePriceAction } = require('./priceAction'); // 20260903o：技术面短期动向因子引用其 shortTerm
const { decorateRules, changeRate, withImpact } = require('./ruleCore');

/**
 * 判断模块三规则装饰器：时效（日频）+ 当日涨跌的边际说明
 * 判断引擎输出的是「结论」而非时间序列，故重点落在：
 *   - 规则二：标明依据行情的数据时间，过期须标注；
 *   - 规则三：给出当日涨跌幅，并说明该涨跌与判断方向是否同向（方向一致性）。
 *
 * ★ 20260902a 修复口径冲突（用户反馈"偏空却显示红色"根因）：
 *   原实现 `bullish = score > 50` 与 dir 判定阈值（|total|>0.12，即 score>12 才"涨"）
 *   严重不一致。当 score 落在 (12,50] 时 dir="涨"→verdict 红色"看涨"，但 consistency
 *   文字却因 score<50 硬判"偏空"，形成"偏空配红字"的视觉矛盾。现直接用 dir 字段
 *   （与 combineFactors 同源）决定方向词，杜绝二次阈值分叉。
 */
function decorateJudgmentRules({ dataTime, source, price, prevClose, score, dir }) {
  const rules = decorateRules({
    dataTime,
    source,
    kind: 'daily',
    series: (prevClose > 0 && price > 0)
      ? [{ date: '昨收', value: prevClose }, { date: '当前', value: price }]
      : [],
    name: '价格',
  });
  const dayChange = (prevClose > 0 && price > 0) ? changeRate(price, prevClose) : null;
  let consistency = '无价格数据';
  if (dayChange != null && score != null) {
    // 与 dir 同源：dir='涨'→偏多 / dir='跌'→偏空 / dir='震荡'→中性，不再二次开阈值
    const bullish = dir === '涨';
    const bearish = dir === '跌';
    const dirWord = bullish ? '偏多' : bearish ? '偏空' : '中性';
    const up = dayChange > 0;
    if (bullish || bearish) {
      const sameDir = (bullish && up) || (bearish && !up);
      consistency = sameDir
        ? `判断方向（${dirWord}）与当日涨跌（${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%）同向`
        : `⚠️ 判断方向（${dirWord}）与当日涨跌（${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%）背离`;
    } else {
      // 中性区间不再被硬判"偏空"，避免 verdict 灰色却文字说偏空的口径错位
      consistency = `判断方向为中性，当日${up ? '涨' : '跌'} ${Math.abs(dayChange).toFixed(2)}%`;
    }
  }
  return { ...rules, dayChange, consistency };
}

const JUDGE_DIR = path.join(__dirname, '..', 'data', 'judgments');

// 判断记录的 schema 版本：当修复了因子取数/匹配逻辑后，旧版本记录需要重新生成，
// 否则会一直复用脏缓存（如 20260819a 之前行业因子把原始异常文本写进 detail）。
// 20260820a：短期行情六因子重构（删技术面、合并大盘+行业、新增增持减持与财报/抢跑）。
// 20260820b：新增第七因子「板块涨跌停占比」（板块内涨停/跌停家数占比）。
// 20260820c：市场情绪因子新增「板块消息联动」子信号；修复 HF 模型卡死。
// 20260820d：板块消息联动加「重大事件精匹配」+ 新增「跨市场传导」子信号（美股对标）。
// 20260820e：补强 analyzeSentiment 金融词库（涨停/大涨/跌停/走强/回落等）+ 跨市场对标扩展有色/黄金/能源。
// 20260820g：接入 cn-financial-scraper 后台数据源——市场情绪因子新增「全网舆情」子信号；
//            近期重大利好/利空因子用「定期报告解读」增强财报是否符合预期。
// 20260820h：近期重大利好/利空因子再接入「交易所公告 + 监管/宏观政策」（公告按公司名搜索、
//            政策按行业/赛道相关性过滤），消息面覆盖 个股新闻+行业+公告+政策。
// 20260820i：① 增持减持因子新增「股份回购」利好识别（数据来自名称+代码双源公告，代码源走东财兜底
//            以修复深交所接口 500 失效）；② 资金量能因子新增「个股换手率变化」子信号
//            （对比近15日均值的偏离，按近两日价格方向加权），弥补此前只有静态阈值换手率的缺口。
// 20260821a：加固跨股/跨行业污染防御：市场情绪缓存 TTL 缩至 5s、返回数据强制携带 symbol；
//            板块消息联动增加 symbol/industryName 回显与 keywords 一致性校验；
//            判断记录复用前校验 schemaVersion，并在 buildJudgment 内做 symbol/industry 一致性断言。
// 20260821b：内幕抢跑衰减升级——三窗口（3/5/10 日）回溯股价方向，按最大同向幅度
//            对消息信号做连续衰减（保留率 1-|chg|/20，下限 0.15），明示下调比例；
//            同步修复前端资源 ?v= 与 APP_VERSION 错位（之前 app.js ?v= 落后于 server APP_VERSION
//            一个版本，导致用户浏览器长期命中旧版 JS，前端校验失效）。
// 20260821c：彻底重写「个股行业识别」因子：新增 lib/sectorIdentity.js 作为唯一可信源，
//            按代码硬编码覆盖 + 多源交叉校验 + symbol 强一致性断言；sameDayJudgment 与
//            longTermJudgment 统一调用，杜绝行业误归与跨股污染。
// 20260823f：短期行情七因子统一输出 subFactors（资金量能/对标期货/大盘行业/消息面/增持减持/板块涨跌停），
//            前端「判断逻辑」对各因子详情统一采用分段卡片网格（与「市场情绪」子信号一致），告别密集长文本；
//            子指标全部由因子已计算值派生，不另行取数，严守数据一致性。
// 20260823g：将「融资余额（杠杆情绪）」子信号由 市场情绪 因子迁移至 资金量能 因子（杠杆资金属资金面，归类更合理）；
//            因子各自的 aggregate 权重同步调整：市场情绪去除该 0.20 子权重，资金量能主结论/换手率/融资余额按
//            0.78/0.12/0.10（同时有换手率）或 0.86/0.14（仅融资余额）融合；展示卡片迁移但数值与来源不变。
// 20260823h：修复增持减持因子 bug——东财返回的股东变动为数值股数，原代码只做文本正则匹配导致
//            全部误判为「不变」；现按 changeAmount 符号定量判定，新增十大股东净变动股数/占比
//            作为信号强度，并在文案中标注数据报告期。
// 20260823i：① 将「近期重大利好/利空」因子并入「市场情绪」因子（消息情绪+财报解读+内幕抢跑
//            成为市场情绪因子的子信号），市场情绪因子权重由 0.16 提升至 0.38，其余因子等比缩放到总权重=1；
//            ② Part B 弱关联学习进化：新增 lib/relevanceLearning.js（关联度 0~1 + 持续性经验折扣），
//            板块消息联动按主题关联度逐条加权、×1.3 重大事件加码仅限高关联主题，跨市场传导信号按对标主题关联度衰减，
//            结算复盘记录弱关联主题是否持续误导并下调经验折扣。
// 20260827d：新增第 7 因子「板块跷跷板(科技/半导体负相关)」——
//            当市场出现「科技/半导体涨、其余板块跌」的明显跷跷板行情时，非科技半导体个股与科技板块呈反向运动：
//              科技板块当日上涨 → 该股（属其他板块）倾向下跌 → 偏空；
//              科技板块当日下跌 → 该股倾向上涨 → 偏多。
//            科技/半导体行业个股本身即被参照板块，不参与此反向逻辑（因子 applicable:false，避免自相关）。
const SCHEMA_VERSION = '20260901a';

// ============ 影响程度评分（利好/利空方向语义）============
// 唯一出口在 ruleCore.js（withImpact / toImpactScore / impactLabel），短期与长期判断共用同一映射，
// 禁止在别处各自重算（规则一·指标级单源）。口径：signal ∈ [-1,1] → impactScore ∈ [-3,3]，
// 展示为 红「利好 +n」/ 绿「利空 -n」/ 灰「中性 0」。

// ============ 板块跷跷板因子相关常量 ============
// 用于衡量「科技/半导体」整体表现的板块集合（取各板块当日涨跌幅均值作为科技 composite）。
// 选"行业板块"口径（同花顺/东财行业板），避开概念板命名差异。
const TECH_BOARDS = ['半导体', '电子', '计算机', '通信'];
// 个股若本身属于以下行业，则视为"科技/半导体"被参照方，跷跷板因子不适用。
const TECH_EXCLUDE_INDUSTRIES = ['半导体', '电子', '人工智能', '计算机', '通信'];
// 科技板块当日整体涨跌幅达到该阈值(%)即视为跷跷板效应"明显"，映射为满格反向信号；
// 低于阈值按比例衰减，低于死区则视为当日跷跷板效应不显著、按中性处理。
const SEESAW_FULL_PCT = 3.0;
const SEESAW_DEADBAND_PCT = 0.3;

// ============ 工具函数 ============
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function round(x, n = 1) { const p = Math.pow(10, n); return Math.round(x * p) / p; }
// 将股数格式化为「万/亿」中文单位，保留 2 位小数
function formatWan(n) {
  const x = Number(n) || 0;
  if (Math.abs(x) >= 1e8) return (x / 1e8).toFixed(2) + '亿';
  if (Math.abs(x) >= 1e4) return (x / 1e4).toFixed(2) + '万';
  return x.toLocaleString();
}
// 个股换手率变化：取最近 ~60 日换手率，以前 15 日均值为基准，最新值相对基准的偏离
// 结合近两日价格方向加权（量价配合：放量上涨偏多、放量下跌偏空；缩量则反向弱化）。
// 返回 { ok, signal, detail } —— 数据不足时 ok:false，由上层按中性处理。
function _computeTurnoverChange(series) {
  if (!Array.isArray(series) || series.length < 20) {
    return { ok: false, signal: 0, detail: '换手率数据不足（<20日），按中性处理' };
  }
  const base = series.slice(0, -5);          // 前 ~55 日作为基准样本
  const baseline = avg(base.map(s => s.turnover));
  const tail = series.slice(-5);             // 最近 5 日
  const latest = tail[tail.length - 1].turnover;
  if (!(baseline > 0)) return { ok: false, signal: 0, detail: '换手率基准为0，按中性处理' };
  const ratio = latest / baseline;           // >1 放大，<1 萎缩
  // 近两日价格方向（最新 vs 前一日）
  const lastClose = series[series.length - 1].close;
  const prevClose = series[series.length - 2].close;
  const priceDir = (typeof lastClose === 'number' && typeof prevClose === 'number' && prevClose > 0)
    ? (lastClose - prevClose >= 0 ? 1 : -1) : 0;
  // 偏离幅度取绝对值（放量/缩量都算异常），再按「量价配合」口径加权：
  //   放量上涨→偏多、放量下跌→偏空；缩量则动能不足，方向与价格相反且强度减半
  //   （缩量上涨=上涨乏力→偏空；缩量下跌=抛压衰竭→偏多）。
  //   与 factorCapital 的 vpSigMap（上涨缩量 -0.2 / 缩量下跌 +0.2）口径一致，避免同指标不同向。
  //   偏离映射：ratio=2.0(翻倍) 或 0.5(腰斩) 视为满格。
  const dev = clamp(Math.abs(ratio - 1) * 1.2, 0, 1.2);
  const volDir = ratio >= 1 ? 1 : -0.5; // 放量随价向、缩量反价向且减半
  const signal = clamp(dev * priceDir * volDir, -1, 1);
  const dirTxt = priceDir > 0 ? '价涨' : priceDir < 0 ? '价跌' : '价平';
  const volTxt = ratio >= 1.05 ? '放量' : ratio <= 0.95 ? '缩量' : '量平';
  const tone = signal > 0.05 ? '偏多' : signal < -0.05 ? '偏空' : '中性';
  const detail = `最新换手率 ${round(latest, 2)}%，近15日均值 ${round(baseline, 2)}%（偏离 ${(ratio >= 1 ? '+' : '') + round((ratio - 1) * 100)}%），近两日${dirTxt}·${volTxt} → ${tone}`;
  return { ok: true, signal, detail };
}
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function ensureDir() { if (!fs.existsSync(JUDGE_DIR)) fs.mkdirSync(JUDGE_DIR, { recursive: true }); }
// 按「判断目标交易日」分文件，确保同一 targetDate 下每只股票只有一条判断
function fileForDate(date) { return path.join(JUDGE_DIR, `${date}.json`); }
function fileForTargetDate(targetDate) { return path.join(JUDGE_DIR, `${targetDate}.json`); }

// 归一化行业名 → 广义赛道关键词（复用 newsSearch 的 SECTOR_KEYWORDS 体系），
// 用于把「监管/宏观政策」按行业相关性过滤进消息面因子，避免无关宏观新闻稀释个股消息。

// 判断目标口径（按 A 股交易时段）：
//   未收盘（盘中/午休/盘前，且为交易日）→ 预测「今日后续行情」(intraday)
//   已收盘（15:00 后或周末/非交易日）  → 预测「下一开盘日行情」(nextday)
// 注：午休与盘前仍视为“未收盘”，因为当日后续还有交易时段。
function marketClosed(now = new Date()) {
  const dow = now.getDay(); // 0=周日, 6=周六
  if (dow === 0 || dow === 6) return true; // 周末无交易
  return now.getHours() >= 15; // 15:00 后视为已收盘
}

// 计算下一个交易日（跳过周六周日；不含法定节假日，必要时可后续补充）
function nextTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  for (let i = 0; i < 8; i++) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) return localDate(d);
  }
  return dateStr;
}

// 计算上一个交易日（跳过周六周日）
function previousTradingDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  for (let i = 0; i < 8; i++) {
    d.setDate(d.getDate() - 1);
    const dow = d.getDay();
    if (dow !== 0 && dow !== 6) return localDate(d);
  }
  return dateStr;
}

// 计算「最近一次已收盘的交易日」：
//   - 盘中/盘前/午休：参考基准为上一交易日收盘
//   - 15:00 后或周末：参考基准为最近一个已收盘的交易日（周五/节假日前最后一个交易日）
// 判断在「收盘后 ~ 下一开盘前」无论刷新多少次，都应以该 referenceDate 为键，
// 保证同一 targetDate 仅保留开盘前最后一次判断。
function referenceCloseDate(now = new Date()) {
  const today = localDate(now);
  const dow = now.getDay();
  if (dow === 0 || dow === 6) {
    // 周末：最近一次有效收盘为上一交易日
    return previousTradingDay(today);
  }
  if (now.getHours() >= 15) {
    // 已收盘（当日 K 线已完成）：今天自身的收盘即为最近一次有效收盘，
    // 作为下一交易日预判的基准价（此前回退到上一交易日会使收盘后预判的基准价偏离一天）
    return today;
  }
  // 盘中/盘前：最近一次有效收盘是上一交易日
  return previousTradingDay(today);
}

const VERdict_LABEL = { 涨: '看涨', 跌: '看跌', 震荡: '震荡' };
const SIGNAL_ARROW = { 1: '▲ 偏多', '-1': '▼ 偏空', 0: '— 中性' };

// ============ 单因子计算 ============

// 防御：Python 层可能把原始异常（HTTPSConnectionPool / ProxyError 等）塞进 note，
// 这里做最后一道过滤，避免把主机名/堆栈泄漏到「判断逻辑」UI。
function _sanitizeSectorNote(note) {
  if (!note) return '行业板块走势数据不可用，按中性处理';
  if (/HTTPSConnectionPool|ProxyError|Connection aborted|RemoteDisconnected|ConnectionError|TimeoutError|HTTPError|SSLError|URLError|socket\.|host=|port=/i.test(note)) {
    return '行业走势数据暂不可用，按中性处理';
  }
  return note;
}
// 检测旧缓存是否把原始网络异常（HTTPSConnectionPool / ProxyError 等）写进了因子 detail。
function _judgmentHasRawException(rec) {
  if (!rec || !Array.isArray(rec.factors)) return false;
  const re = /HTTPSConnectionPool|ProxyError|Connection aborted|RemoteDisconnected|ConnectionError|TimeoutError|HTTPError|SSLError|URLError|socket\.|host=|port=/i;
  return rec.factors.some(f => f && typeof f.detail === 'string' && re.test(f.detail));
}

// 1) 市场情绪与消息面：量化广度(涨跌停比) + 消息情绪(大盘) + 财报解读 + 内幕抢跑 + 舆情与讨论热度(个股)
//    + 板块消息联动 + 跨市场传导 + 全网舆情 + 量能活跃度
//    子信号在 scripts/sentiment.py 中产出。口径分工（用户 20260831 明确）：
//      · 消息情绪（大盘）——用 marketSentiment 的全市场聚合（marketHeat/上升家数占比），看大盘情绪与消息；
//      · 舆情与讨论热度（个股）——用 newsSentiment(个股新闻) + discussionHeat(股吧/热榜/关注)，看当前个股。
//    融资余额（杠杆情绪）属资金面，已归集至 factorCapital（资金量能），详见其注释。
function factorSentiment(sentiment, quote, history, sectorNews, crossMarket, globalSentiment, newsParts, symbol) {
  const parts = [];
  // 20260823i：把「近期重大利好/利空」因子的子信号（消息情绪/财报解读/内幕抢跑）并入市场情绪，
  // 使其成为市场情绪因子的组成部分（权重随之提升至 0.38）。
  for (const np of (newsParts || [])) {
    parts.push({ name: np.name, w: np.w, signal: clamp(np.signal, -1, 1), value: np.value, detail: np.detail });
  }
  // 1) 市场广度（涨跌停比）
  if (sentiment && sentiment.breadth && sentiment.breadth.ok) {
    const b = sentiment.breadth;
    parts.push({
      name: '涨跌停比', w: 0.25, signal: clamp(b.signal, -1, 1),
      value: `涨停 ${b.limitUp}/跌停 ${b.limitDown}`,
      detail: `全市场涨停 ${b.limitUp} 家、跌停 ${b.limitDown} 家，多空比 ${b.limitUpDownRatio}（${b.note || ''}）`,
    });
  }
  // 注：融资余额（杠杆情绪）已由 factorCapital（资金量能）因子归集打分与展示，详见 factorCapital。
  // 3) 舆情与讨论热度（个股）：个股新闻情绪 + 东方财富/同花顺/雪球三平台股吧热度
  //    与「消息情绪（大盘）」明确分工——本项只看当前个股，后者只看大盘。
  //    discussionHeat 内已聚合东财股吧、同花顺热榜、雪球关注榜数据。
  const hasNews = sentiment && sentiment.newsSentiment && sentiment.newsSentiment.ok;
  const hasHeat = sentiment && sentiment.discussionHeat && sentiment.discussionHeat.ok;
  if (hasNews || hasHeat) {
    const ns = sentiment.newsSentiment;
    const dh = sentiment.discussionHeat;
    const eng = ns && ns.engine === 'finance-model' ? '金融微调模型' : 'snownlp+词库';
    const score = ns ? (ns.weightedAvgScore != null ? ns.weightedAvgScore : ns.avgScore) : null;
    let heatValue = '';
    let heatDetail = '';
    let heatSignal = 0;
    if (dh) {
      heatSignal = clamp(dh.signal || 0, -1, 1);
      const em = dh.eastmoney || {};
      const th = dh.tonghuashun || {};
      const xq = dh.xueqiu || {};
      const emTxt = em.symbolScore != null
        ? `东财个股${em.symbolScore}` + (em.symbolRise != null ? (em.symbolRise > 0 ? '↑' : '↓') : '')
        : (em.marketHeat != null ? `东财市场热度${em.marketHeat >= 0 ? '+' : ''}${round(em.marketHeat, 2)}` : '');
      const thTxt = th.inHotList ? `同花顺第${th.rank}名(热度${th.heatRate})` : (th.ok ? `同花顺未入热榜` : '');
      const xqTxt = xq.inTop ? `雪球第${xq.rank}名(关注${xq.follow})` : (xq.ok ? `雪球未入关注榜` : '');
      heatValue = [emTxt, thTxt, xqTxt].filter(Boolean).join(' / ');
      const emDetail = em.symbolScore != null
        ? `东财股吧综合得分 ${em.symbolScore}、${em.symbolRise != null ? (em.symbolRise > 0 ? '热度上升' : '热度下降') : ''}`
        : `东财市场热度 ${em.marketHeat != null ? (em.marketHeat >= 0 ? '+' : '') + round(em.marketHeat, 2) : '—'}`;
      const thDetail = th.inHotList
        ? `同花顺热榜第${th.rank}名、热度值${th.heatRate}${th.risePct != null ? '、涨跌' + (th.risePct >= 0 ? '+' : '') + round(th.risePct, 2) + '%' : ''}`
        : th.note || '';
      const xqDetail = xq.inTop
        ? `雪球关注榜第${xq.rank}名、关注人数${xq.follow}${xq.pct != null ? '、今日' + (xq.pct >= 0 ? '+' : '') + round(xq.pct, 2) + '%' : ''}`
        : xq.note || '';
      heatDetail = [emDetail, thDetail, xqDetail].filter(Boolean).join('；');
    }
    const newsValue = ns ? `利好 ${ns.positive}/中性 ${ns.neutral}/利空 ${ns.negative}` : '';
    const newsDetail = ns
      ? `近 ${ns.count} 条个股新闻（${eng}），积极 ${ns.positive}/中性 ${ns.neutral}/消极 ${ns.negative}，加权情感均值 ${score != null ? round(score * 100) : '—'}（${ns.note || ''}）`
      : '';
    const subSignal = (hasNews && hasHeat)
      ? clamp(0.5 * clamp(ns.signal, -1, 1) + 0.5 * heatSignal, -1, 1)
      : (hasNews ? clamp(ns.signal, -1, 1) : heatSignal);
    parts.push({
      name: '舆情与讨论热度（个股）', w: 0.30, signal: subSignal,
      value: [newsValue, heatValue].filter(Boolean).join(' | '),
      detail: [newsDetail, heatDetail].filter(Boolean).join('；'),
    });
  }
  // 5) 板块消息联动（板块/赛道级新闻情绪 → 个股传导；解决"个股新闻源抓不到板块级催化"）
  if (sectorNews && sectorNews.ok && typeof sectorNews.signal === 'number') {
    const sn = sectorNews;
    const evtTxt = (sn.eventBoosted && sn.events && sn.events.length)
      ? `；重大事件：${sn.events.slice(0, 2).map(e => e.title).join('、')}`
      : '';
    parts.push({
      name: '板块消息联动', w: 0.20, signal: clamp(sn.signal, -1, 1),
      value: `利好 ${sn.positive}/利空 ${sn.negative}${sn.eventBoosted ? ' · 重大事件' : ''}`,
      detail: `板块/赛道消息 ${sn.count} 条（关键词：${(sn.keywords || []).slice(0, 3).join('、')}），利好 ${sn.positive}/利空 ${sn.negative}，情绪均值 ${sn.avgScore != null ? (sn.avgScore >= 0 ? '+' : '') + sn.avgScore : '—'}${evtTxt}`,
    });
  }
  // 6) 跨市场传导（隔夜美股对标股 → A股板块情绪；解决"对海外重大催化不敏感"）
  if (crossMarket && crossMarket.ok && typeof crossMarket.signal === 'number') {
    const cm = crossMarket;
    const extremeTxt = (cm.extreme && cm.extreme.length)
      ? `；极端催化：${cm.extreme.map(q => `${q.name}${q.changePct >= 0 ? '+' : ''}${Math.round(q.changePct)}%`).join('、')}`
      : '';
    parts.push({
      name: '跨市场传导', w: 0.15, signal: clamp(cm.signal, -1, 1),
      value: `${cm.avgCapped >= 0 ? '+' : ''}${cm.avgCapped}%（封顶）`,
      detail: `${cm.note}${extremeTxt}`,
    });
  }
  // 7) 全网舆情（cn-financial-scraper：60+ 商业财经媒体源 + RSS + 搜索，与东财个股/板块新闻互补）
  if (globalSentiment && globalSentiment.ok && typeof globalSentiment.signal === 'number' && globalSentiment.count > 0) {
    const gs = globalSentiment;
    const top = (gs.articles || []).slice(0, 3).map(a => a.title).join('、');
    parts.push({
      name: '全网舆情', w: 0.10, signal: clamp(gs.signal, -1, 1),
      value: `利好 ${gs.positive}/利空 ${gs.negative}`,
      detail: `全网舆情（cn-financial-scraper）${gs.count} 条，利好 ${gs.positive}/中性 ${gs.neutral}/利空 ${gs.negative}，情感均值 ${gs.avg_score != null ? (gs.avg_score >= 0 ? '+' : '') + round(gs.avg_score, 2) : '—'}${top ? `；样例：${top}` : ''}`,
    });
  }
  // 8) 量能活跃度（换手率/成交量异常，来自历史量比，方向随近两日价格）
  if (history && history.length >= 2) {
    const last = history[history.length - 1];
    const vols = history.slice(-20).map(h => h.volume).filter(v => typeof v === 'number' && v > 0);
    if (vols.length >= 5 && last.volume != null) {
      const avgVol = avg(vols);
      const ratio = avgVol > 0 ? last.volume / avgVol : 1;
      const prevClose = history[history.length - 2].close;
      const priceDir = (prevClose != null && last.close != null) ? (last.close - prevClose) : 0;
      // 口径与 factorCapital 的 vpSigMap、_computeTurnoverChange 保持一致：
      //   放量随价向（放量涨→偏多 / 放量跌→偏空）；缩量反价向且减半（缩量涨→偏空 / 缩量跌→偏多）。
      const volDir = ratio >= 1 ? 1 : -0.5;
      const volSignal = clamp(Math.abs(ratio - 1) * (priceDir >= 0 ? 1 : -1) * volDir, -1, 1);
      const volTxt = ratio >= 1.05 ? '放量' : ratio <= 0.95 ? '缩量' : '量平';
      const toneTxt = volSignal > 0.05 ? '偏多' : volSignal < -0.05 ? '偏空' : '中性';
      parts.push({
        name: '量能活跃度', w: 0.15, signal: volSignal,
        value: `量比≈${round(ratio, 2)}`,
        detail: `近20日均量 ${round(avgVol, 0)}，最新 ${round(last.volume, 0)}，量比≈${round(ratio, 2)}（近两日价格${priceDir >= 0 ? '走强' : '走弱'}·${volTxt} → ${toneTxt}）`,
      });
    }
  }

  if (!parts.length) {
    return { key: 'sentiment', name: '市场情绪与消息面', weight: 0.272, signal: 0, applicable: true,
      value: '—', detail: '情绪/讨论热度数据获取失败（涨跌停池/股吧接口均不可用），按中性处理' };
  }
  const wsum = parts.reduce((a, p) => a + p.w, 0) || 1;
  let s = 0;
  for (const p of parts) s += (p.w / wsum) * p.signal;
  s = clamp(s, -1, 1);
  const detail = parts.map(p => p.detail).join('；');
  const value = parts.map(p => p.value).join(' | ');
  return { key: 'sentiment', name: '市场情绪与消息面', weight: 0.272, signal: s, applicable: true, value, detail, subFactors: parts };
}

// 2) 资金量能
// 复用 analyzeCapitalFlow 统一结论（与个股分析页「资金量能」同款），保证跨页面一致。
// turnoverChange：个股换手率变化子信号（对比近15日均值的偏离，按近两日价格方向加权），
//   为本次新增——此前资金量能只有「换手率当前水平」静态阈值，缺少「变化/趋势」维度。
// margin（融资余额变化）：20260823g 起由「市场情绪」因子迁移至此——杠杆资金属资金面范畴，归类更合理；
//   与主结论、换手率变化一并融合（权重 0.10），数值与来源完全沿用 sentiment.margin（与个股分析页一致）。
function factorCapital(capital, turnoverChange, sentiment, quote) {
  const c = capital && capital.conclusion;
  if (c && typeof c.signal === 'number') {
    const vp = capital && capital.volumeIndicators && capital.volumeIndicators.volumePrice;
    const mf = capital && capital.moneyFlow && capital.moneyFlow.summary && capital.moneyFlow.summary.summary;
    const estNote = (capital.moneyFlow && capital.moneyFlow.source === 'estimated') ? '（资金流向为接口估算）' : '';
    let detail = '';
    const subs = [];
    if (vp) {
      detail += `量价：${vp.signal}`;
      // 20260902m：量价主信号已改为当日口径（当日涨跌 × 当日量比），映射同步更新
      const vpSigMap = { '放量上涨': 0.6, '量价齐升': 0.5, '显著上涨': 0.4, '温和上涨': 0.2, '缩量上涨': -0.2, '地量上涨': -0.1, '放量下跌': -0.6, '量价齐跌': -0.5, '显著下跌': -0.4, '缩量下跌': -0.2, '地量下跌': -0.3, '温和回调': -0.2, '缩量回调': 0.1, '地量回调': 0, '量价平衡': 0 };
      const vpSig = vpSigMap[vp.signal] != null ? vpSigMap[vp.signal] : 0;
      subs.push({ name: '量价配合', signal: vpSig, value: vp.signal, detail: vp.description || vp.signal });
    }
    if (mf && mf['5d']) {
      const mn = mf['5d'].mainNet;
      detail += `；近5日主力${mf['5d'].direction}${Math.abs(mn)}亿${estNote}`;
      // 方向语义修正（20260901a）：原为 mn>=0?1:-1 二值化，0.36 亿的微弱净流入也被打成满格「利好 +3」，
      // 夸大影响程度。改为按流通市值规模归一化：满格阈值 = 流通市值 × 0.1%（0.5 亿 ~ 20 亿之间）。
      const capYi = (quote && typeof quote.circulationValue === 'number' && quote.circulationValue > 0)
        ? quote.circulationValue : null;
      const thr = capYi ? clamp(capYi * 0.001, 0.5, 20) : 2;
      const mnSignal = clamp(mn / thr, -1, 1);
      const scaleTxt = capYi ? `（满格阈值 ${round(thr, 1)} 亿 = 流通市值 ${round(capYi, 0)} 亿 × 0.1%）` : '（流通市值缺失，按 2 亿满格）';
      subs.push({ name: '主力净流入(近5日)', signal: mnSignal, value: `${mf['5d'].direction} ${Math.abs(mn)}亿`, detail: `近5日主力${mf['5d'].direction}${Math.abs(mn)}亿${estNote}；按流通规模归一化 ${scaleTxt}` });
    }
    detail += `；综合：${c.label}`;
    // 杠杆资金（融资余额变化）：20260823g 由市场情绪迁移而来，与主结论、换手率变化三者融合。
    const margin = (sentiment && sentiment.margin && sentiment.margin.ok) ? sentiment.margin : null;
    const tcOk = !!(turnoverChange && turnoverChange.ok && typeof turnoverChange.signal === 'number');
    let signal = c.signal;
    if (tcOk && margin) {
      signal = clamp(0.78 * c.signal + 0.12 * turnoverChange.signal + 0.10 * clamp(margin.signal, -1, 1), -1, 1);
    } else if (tcOk) {
      signal = clamp(0.85 * c.signal + 0.15 * turnoverChange.signal, -1, 1); // 仅换手率：维持原 0.85/0.15 权重
    } else if (margin) {
      signal = clamp(0.86 * c.signal + 0.14 * clamp(margin.signal, -1, 1), -1, 1);
    }
    if (tcOk) {
      detail += `；换手率变化：${turnoverChange.detail}`;
      const tcLabel = turnoverChange.signal > 0.05 ? '放量偏多' : turnoverChange.signal < -0.05 ? '放量偏空' : '量价平稳';
      subs.push({ name: '换手率变化', signal: turnoverChange.signal, value: tcLabel, detail: turnoverChange.detail });
    }
    if (margin) {
      detail += `；融资余额：${margin.changePct >= 0 ? '+' : ''}${round(margin.changePct, 2)}%`;
      subs.push({ name: '融资余额', signal: clamp(margin.signal, -1, 1), value: `${margin.changePct >= 0 ? '+' : ''}${round(margin.changePct, 2)}%`, detail: `沪深融资余额最新 ${round(margin.latest, 0)} 亿，较前值 ${margin.changePct >= 0 ? '+' : ''}${round(margin.changePct, 2)}%（${margin.note || ''}）` });
    }
    return { key: 'capital', name: '资金量能', weight: 0.158, signal, applicable: true, value: c.label, detail, subFactors: subs };
  }
  return { key: 'capital', name: '资金量能', weight: 0.158, signal: 0, applicable: true,
    value: '—', detail: '无资金量能数据，按中性处理' };
}

// 3) 对标期货短期走势：期货近 5 个交易日涨跌幅 × 相关性强度
function factorFuturesShort(futures) {
  if (futures && futures.hasFutures) {
    const corr = typeof futures.correlation === 'number' ? futures.correlation : 0;
    // 方向语义修正（20260901a）：corr 是皮尔逊相关系数，可为负。
    // 原实现只用 |corr| 作强度系数，导致「负相关」个股被判反方向：
    //   期货涨 → 相关系数为负的个股实际承压（偏空），旧逻辑却给了偏多（红），方向与语义相反。
    // 现按 corr 的符号做传导：正相关 → 同向；负相关 → 反向。
    const corrStrength = Math.abs(corr) >= 0.6 ? 1 : (Math.abs(corr) >= 0.35 ? 0.7 : (Math.abs(corr) >= 0.15 ? 0.4 : 0.2));
    const corrSigned = corrStrength * (corr >= 0 ? 1 : -1);
    const fc = (futures.futuresClose && Array.isArray(futures.futuresClose)) ? futures.futuresClose : [];
    let shortChg = 0;
    if (fc.length >= 5) {
      const base = fc[fc.length - 5];
      const last = fc[fc.length - 1];
      shortChg = base > 0 ? (last - base) / base * 100 : 0;
    } else if (typeof futures.futuresChg === 'number') {
      shortChg = futures.futuresChg;
    }
    const signal = clamp(shortChg / 4, -1, 1) * corrSigned; // 短期 ±4% 视为满格，再按相关性符号传导
    const detail = `对标 ${futures.futuresName || '期货'} 近5日 ${shortChg >= 0 ? '+' : ''}${round(shortChg)}%（相关性 ${round(corr, 2)}，${futures.level || '—'}${futures.direction || ''}相关）→ ${signal > 0.05 ? '该股偏多' : signal < -0.05 ? '该股偏空' : '该股中性'}`;
    const value = `${shortChg >= 0 ? '+' : ''}${round(shortChg)}%`;
    const subs = [
      { name: '近5日走势', signal: clamp(shortChg / 4, -1, 1), value: `${shortChg >= 0 ? '+' : ''}${round(shortChg)}%`, detail: `对标 ${futures.futuresName || '期货'} 近5个交易日涨跌幅 ${shortChg >= 0 ? '+' : ''}${round(shortChg)}%` },
      // 「相关性方向/强度」是统计属性，本身无利好利空属性 → signal 记 0（中性），
      // 避免把"负相关"误显示成绿色利空；传导方向已在父因子 signal 中按符号计入。
      { name: '相关性方向', signal: 0, value: `${futures.direction || (corr >= 0 ? '正' : '负')}相关 ${round(corr, 2)}`, detail: `与个股相关性 ${round(corr, 2)}（${futures.level || '—'}${futures.direction || ''}相关），强度系数 ${round(corrStrength, 2)}，传导${corr >= 0 ? '同向（期货涨→股价偏多）' : '反向（期货涨→股价偏空）'}；该项为统计属性，不计利好/利空` },
    ];
    return { key: 'futures', name: '对标期货短期走势', weight: 0.086, signal, applicable: true, value, detail, subFactors: subs };
  }
  return { key: 'futures', name: '对标期货短期走势', weight: 0.086, signal: 0, applicable: false,
    value: '不适用', detail: '该公司无直接对标期货，本因子不参与打分' };
}

// 4) 大盘及行业板块指数短期走势：大盘平均涨跌幅 + 所属行业板块整体涨跌
function factorMarketShort(market, sector) {
  const cn = (market && market.cn) || [];
  const cnAvg = cn.length ? avg(cn.map(c => (c.changePct != null ? c.changePct : 0))) : 0;
  const marketSignal = clamp(cnAvg / 2, -1, 1);
  const secOk = sector && sector.ok && typeof sector.boardChange === 'number';
  const secChg = secOk ? sector.boardChange : 0;
  const up = secOk ? sector.upCount : null;
  const down = secOk ? sector.downCount : null;
  const secSignal = secOk ? clamp(secChg / 2, -1, 1) : 0;
  // 20260831g：个股短期走势受所属行业板块影响通常大于宽基大盘，故因子内部采用「行业 0.65 / 大盘 0.35」加权。
  const signal = clamp(0.35 * marketSignal + 0.65 * secSignal, -1, 1);
  let detail = `大盘：上证/深成指/创业板/沪深300 平均 ${cnAvg >= 0 ? '+' : ''}${round(cnAvg)}%（${cnAvg > 0.3 ? '偏强' : cnAvg < -0.3 ? '偏弱' : '中性'}）`;
  const subs = [
    { name: '大盘指数', signal: marketSignal, value: `平均 ${cnAvg >= 0 ? '+' : ''}${round(cnAvg)}%`, detail: `上证/深成指/创业板/沪深300 平均 ${cnAvg >= 0 ? '+' : ''}${round(cnAvg)}%（${cnAvg > 0.3 ? '偏强' : cnAvg < -0.3 ? '偏弱' : '中性'}）` },
  ];
  if (secOk) {
    detail += `；行业：${sector.boardName || sector.industryName} ${secChg >= 0 ? '+' : ''}${round(secChg)}%（涨 ${up}/跌 ${down}）`;
    subs.push({ name: '行业板块', signal: secSignal, value: `${secChg >= 0 ? '+' : ''}${round(secChg)}%`, detail: `${sector.boardName || sector.industryName} ${secChg >= 0 ? '+' : ''}${round(secChg)}%（涨 ${up}/跌 ${down}）` });
  } else {
    detail += '；行业板块数据暂缺';
    subs.push({ name: '行业板块', signal: 0, value: '—', detail: '行业板块走势数据暂缺，按中性处理' });
  }
  const value = `大盘 ${cnAvg >= 0 ? '+' : ''}${round(cnAvg)}% / 行业 ${secOk ? (secChg >= 0 ? '+' : '') + round(secChg) + '%' : '—'}`;
  return { key: 'market', name: '大盘及行业板块短期走势', weight: 0.114, signal, applicable: true, value, detail, subFactors: subs };
}

// 5) 公司近期重大利好/利空（20260823i 起并入「市场情绪」因子，作为其三个子信号）：
//    消息情绪（大盘）+ 财报解读 + A股内幕抢跑提前反应。
//    返回可被 factorSentiment 直接并入的 parts（含子权重 w），而非独立因子。
//    财报判断优先用 cn-financial-scraper 的「定期报告解读」（interpret_stock），缺失时回退 quote.fundamentals 增速。
function computeNewsFactor(news, quote, history, report, symbol, marketSentiment) {
  const list = Array.isArray(news) ? news : [];
  const scored = list.filter(n => n.sentiment && typeof n.sentiment.score === 'number');
  const parts = [];
  let value = '—';
  // 个股消息方向（仅供 5.3 内幕抢跑衰减判断，不直接作为「消息情绪」展示——
  // 「消息情绪」改由大盘情绪 marketSentiment 驱动，详见 5.1；个股消息舆情见「舆情与讨论热度（个股）」）
  let rawMsg = 0;
  if (scored.length) {
    const avgScore = avg(scored.map(n => n.sentiment.score));
    rawMsg = clamp(avgScore / 50, -1, 1);
  }

  // 5.1 消息情绪（大盘）：聚焦全市场情绪与消息，使用东财股吧全市场聚合（marketHeat / 上升家数占比 / 全市场得分均值），
  //     与「舆情与讨论热度（个股）」明确分工——本项看大盘，后者看个股。
  const mk = (marketSentiment && marketSentiment.ok) ? marketSentiment : null;
  if (mk && typeof mk.marketHeat === 'number') {
    const mHeat = clamp(mk.marketHeat, -1, 1);
    const upRatio = (mk.marketUpRatio != null) ? mk.marketUpRatio : 0.5;
    const avgScore = mk.marketAvgScore != null ? mk.marketAvgScore : null;
    const tone = mHeat > 0.1 ? '偏多' : mHeat < -0.1 ? '偏空' : '中性';
    const detail = `大盘情绪（东财股吧全市场聚合）：全市场综合得分均值 ${avgScore != null ? avgScore : '—'}，上升家数占比 ${(upRatio * 100).toFixed(0)}%（${tone}）`;
    parts.push({ name: '消息情绪（大盘）', w: 0.14, signal: mHeat, value: `市场热度 ${mHeat >= 0 ? '+' : ''}${round(mHeat * 100)}`, detail });
    value = `市场热度 ${mHeat >= 0 ? '+' : ''}${round(mHeat * 100)}`;
  } else {
    // 大盘情绪数据不可用：按中性处理（不回退个股消息，避免与「舆情与讨论热度（个股）」口径混淆）
    parts.push({ name: '消息情绪（大盘）', w: 0.14, signal: 0, value: '—', detail: '大盘情绪数据（东财股吧全市场聚合）暂不可用，按中性处理' });
  }

  // 5.2 财报解读（联动深度分析「最新财报解读」：优先消费同一份 AI 联网缓存，确保规则一·数据一致性；
  //     缺失时回退 cn-financial-scraper 评级 + 披露增速。量化信号始终以披露同比增速为准（规则三）。）
  const f = quote && quote.fundamentals;
  const norm = (v) => (v != null && Math.abs(v) < 1 ? v * 100 : v);
  const pgN = norm(f && (f.profitYoy != null ? f.profitYoy : f.earningsGrowth));
  const rgN = norm(f && (f.revenueYoy != null ? f.revenueYoy : f.revenueGrowth));
  const repOk = report && report.ok && typeof report.score === 'number' && report.score > 0
    && report.rating && report.rating !== '数据不足';
  // 联动：读取与个股深度分析同源的「最新财报解读」缓存（单一权威源，避免双源各说各话）
  let deepEarnings = null;
  try { deepEarnings = readEarningsCache(symbol); } catch {}
  const deepSummaryOk = !!(deepEarnings && typeof deepEarnings.summary === 'string' && deepEarnings.summary.trim().length > 0);
  if (deepSummaryOk) {
    // 修复（任务 J）：信号以 AI 深度解读的实质结论为准，而非仅看同比增速。
    // 优先用结构化 earningsSignal；缺失时按综合结论关键词启发式兜底（避免「+7.1% 即利好」误判）。
    const earnSignal = (typeof deepEarnings.earningsSignal === 'number')
      ? deepEarnings.earningsSignal
      : extractEarningsSignal(deepEarnings.summary);
    const earnLabel = earnSignal > 0.15 ? '向好' : earnSignal < -0.15 ? '承压' : '中性';
    const verdictTxt = (deepEarnings.verdict && deepEarnings.verdict.trim()) ? `（${deepEarnings.verdict.trim()}）` : '';
    const yoyTxt = (pgN != null) ? '；净利同比 ' + (pgN >= 0 ? '+' : '') + round(pgN) + '%' : (rgN != null ? '；营收同比 ' + (rgN >= 0 ? '+' : '') + round(rgN) + '%' : '');
    const head = `最新财报解读（联动深度分析）${verdictTxt}：${earnLabel}${yoyTxt}`;
    const deepBody = deepEarnings.summary.length > 200 ? deepEarnings.summary.slice(0, 200) + '…' : deepEarnings.summary;
    const earnPart = head + '；【深度分析·最新财报解读】' + deepBody;
    parts.push({ name: '财报解读', w: 0.10, signal: earnSignal, value: '联动深度解读', detail: earnPart });
  } else if (repOk) {
    const ratingSig = { '积极': 0.6, '中性偏积极': 0.3, '中性': 0.0, '谨慎': -0.5 }[report.rating] || 0;
    const rpProfitYoy = norm(report.profit_yoy);
    const rpRevenueYoy = norm(report.revenue_yoy);
    const yoy = (rpProfitYoy != null) ? rpProfitYoy : rpRevenueYoy;
    const yoySig = yoy != null ? clamp(yoy / 30, -1, 1) : 0;
    const earnSignal = (yoy != null) ? 0.5 * ratingSig + 0.5 * yoySig : ratingSig;
    const highlightTxt = (report.highlights && report.highlights.length) ? `；亮点：${report.highlights[0]}` : '';
    const riskTxt = (report.risks && report.risks.length) ? `；风险：${report.risks[0]}` : '';
    const earnLabel = earnSignal > 0.15 ? '向好' : earnSignal < -0.15 ? '承压' : '中性';
    const earnPart = `最新财报（回退·定期报告评级）：评级 ${report.rating}${yoy != null ? '，净利/营收同比 ' + (yoy >= 0 ? '+' : '') + round(yoy) + '%' : ''}（${earnLabel}）${highlightTxt}${riskTxt}`;
    parts.push({ name: '财报解读', w: 0.10, signal: earnSignal, value: `评级 ${report.rating}`, detail: earnPart });
  } else if (pgN != null || rgN != null) {
    const earnSignal = (pgN != null) ? clamp(pgN / 30, -1, 1) : clamp(rgN / 30, -1, 1);
    const earnTxt = pgN != null ? `净利增速 ${pgN >= 0 ? '+' : ''}${round(pgN)}%` : `营收增速 ${rgN >= 0 ? '+' : ''}${round(rgN)}%`;
    const earnLabel = earnSignal > 0.15 ? '增长/超预期' : earnSignal < -0.15 ? '下滑/低于预期' : '符合预期';
    const earnPart = `最新财报：${earnTxt}（${earnLabel}）`;
    parts.push({ name: '财报解读', w: 0.10, signal: earnSignal, value: earnTxt, detail: earnPart });
  }

  // 5.3 A股内幕抢跑：回溯近 N 日（3/5/10）股价方向，按抢跑幅度对「消息情绪」子信号做连续衰减。
  if (history && history.length >= 11 && rawMsg !== 0) {
    const windows = [3, 5, 10];
    const probeParts = [];
    let maxChg = 0;
    for (const w of windows) {
      if (history.length < w + 1) continue;
      const slice = history.slice(-(w + 1));
      const base = slice[0].close;
      const last = slice[slice.length - 1].close;
      if (!base) continue;
      const chg = (last - base) / base * 100;
      const sameDir = (chg > 0 && rawMsg > 0) || (chg < 0 && rawMsg < 0);
      if (sameDir && Math.abs(chg) >= 2.5) {
        if (Math.abs(chg) > Math.abs(maxChg)) maxChg = chg;
        probeParts.push(`${w}日 ${chg >= 0 ? '+' : ''}${round(chg)}%`);
      }
    }
    if (Math.abs(maxChg) >= 2.5) {
      // 保留率随抢跑幅度连续递减：抢 2.5% → 0.875；抢 5% → 0.75；抢 10% → 0.5；抢 15% → 0.25；最高扣至 0.15
      const retain = Math.max(0.15, 1 - Math.abs(maxChg) / 20);
      // 注：「消息情绪」现已改为大盘情绪（marketSentiment），不再代表个股新闻，
      // 故内幕抢跑的"提前反应衰减"不再作用到该子信号；仅保留下方「内幕抢跑预警」子信号本身。
      const cutPct = round((1 - retain) * 100);
      // 方向语义修正（20260901a）：抢跑本身不含方向，"已透支"才有方向。
      //   股价已涨（利好被提前兑现）→ 剩余上行动能被透支 → 边际偏空（负）；
      //   股价已跌（利空已被提前消化）→ 利空出尽 → 边际偏多（正）。
      //   此前无论抢跑方向一律记 -0.4（利空），导致"利空已跌透"被二次计空，方向与语义相反。
      const runDir = maxChg >= 0 ? 1 : -1;
      const insSignal = -0.4 * runDir;
      const insTone = insSignal > 0 ? '利空出尽，边际偏多' : '利好透支，边际偏空';
      const insPart = `内幕抢跑预警：近 ${probeParts.join(' / ')}股价已与消息方向一致（最大 ${maxChg >= 0 ? '+' : ''}${round(maxChg)}%），消息影响预期下调 ${cutPct}% → ${insTone}`;
      parts.push({ name: '内幕抢跑预警', w: 0.05, signal: insSignal, value: `预期下调 ${cutPct}%`, detail: insPart });
    }
  }

  if (!parts.length) {
    // 无消息/财报数据：给一个中性占位，保证市场情绪"消息面"子卡可见
    parts.push({ name: '消息面', w: 0.05, signal: 0, value: '—', detail: '未检索到近期重大消息与财报信号，按中性处理' });
  }
  return { parts, value };
}

// 6) 股票增持减持：前十大股东实际持股变动 + 股份回购。
// 20260823h 修复：东财对实际变动股东返回数值股数（仅「不变」返回文本），原代码只做
// 文本正则导致所有数值变动被误判为「不变」。现按 changeAmount 符号定量判定，并引入
// 净变动股数/净变动占比作为信号强度；同时在文案中标注数据报告期。
function factorHoldings(shareholders, buyback) {
  const top = (shareholders && Array.isArray(shareholders.topShareholders)) ? shareholders.topShareholders : [];
  const reportDate = top[0]?.endDate || '';
  let inc = 0, dec = 0, flat = 0;
  const incNames = [], decNames = [];
  let totalIncreaseShares = 0;
  let totalDecreaseShares = 0;
  let totalHeldShares = 0;

  for (const h of top) {
    totalHeldShares += Math.abs(Number(h.holdAmount) || 0);
    // 优先用数值 changeAmount；缺失时回退文本解析
    let amount = null;
    if (typeof h.changeAmount === 'number') {
      amount = h.changeAmount;
    } else if (h.change != null) {
      const s = String(h.change).trim();
      if (/增持|新进/.test(s)) amount = 1;
      else if (/减持/.test(s)) amount = -1;
      else if (s === '不变') amount = 0;
      else {
        const n = Number(s.replace(/,/g, ''));
        if (!Number.isNaN(n)) amount = n;
      }
    }

    if (amount > 0) {
      inc++; incNames.push(h.name);
      totalIncreaseShares += amount;
    } else if (amount < 0) {
      dec++; decNames.push(h.name);
      totalDecreaseShares += Math.abs(amount);
    } else {
      flat++;
    }
  }

  // 净变动股数（正=净增持，负=净减持）及其相对十大股东合计持股的比例
  const netChangeShares = totalIncreaseShares - totalDecreaseShares;
  const netChangeRatio = totalHeldShares > 0 ? netChangeShares / totalHeldShares : 0;
  // 将净变动占比映射到 [-1,1]：±3% 达到极值；同时用家数方向做修正
  const magnitudeSignal = clamp(netChangeRatio / 0.03, -1, 1);

  // 股份回购：合并进利好侧（等价 +1 家增持），并在卡片中明确标注
  const buybackOk = buyback && buyback.ok && buyback.count > 0;
  const buybackExtra = buybackOk ? 1 : 0;
  const buybackTxt = buybackOk
    ? `；股份回购 ${buyback.count} 次${buyback.latest ? `（最近：${buyback.latest}）` : ''}${buyback.titles && buyback.titles.length ? `：${buyback.titles.slice(0, 2).join('、')}` : ''}`
    : '';

  const total = inc + dec + flat + buybackExtra;
  // 若无任何股东数据但有回购，给出独立偏多信号；否则融合家数方向与净变动幅度
  let signal;
  if (total === 0) {
    signal = 0;
  } else if (top.length === 0 && buybackOk) {
    signal = clamp(0.6, -1, 1); // 仅回购、无股东数据时给明确偏多
  } else {
    const directionSignal = clamp((inc - dec + buybackExtra) / total, -1, 1);
    signal = clamp(0.55 * directionSignal + 0.45 * magnitudeSignal, -1, 1);
  }

  const dateNote = reportDate ? `（数据报告期：${reportDate}）` : '';
  const netChangeText = `${netChangeShares >= 0 ? '+' : ''}${formatWan(netChangeShares)}股`;
  const netChangePct = (netChangeRatio * 100).toFixed(2);
  const detail = `前十大股东中，增持/新进 ${inc} 家${incNames.length ? `（${incNames.slice(0, 3).join('、')}${incNames.length > 3 ? '等' : ''}）` : ''}、减持 ${dec} 家${decNames.length ? `（${decNames.slice(0, 3).join('、')}${decNames.length > 3 ? '等' : ''}）` : ''}、其余 ${flat} 家不变；十大股东合计净变动 ${netChangeText}（占其持股 ${netChangePct}%）${dateNote}` + buybackTxt;
  const value = `增持 ${inc}/减持 ${dec}/净变动 ${netChangeText}${buybackOk ? '/回购 ' + buyback.count : ''}`;

  const countSignal = top.length ? clamp((inc - dec) / top.length, -1, 1) : 0;
  const subs = [
    { name: '十大股东净变动', signal: magnitudeSignal, value: netChangeText, detail: `最新报告期 ${reportDate || '—'}，前十大股东合计净变动 ${netChangeText}，占其合计持股 ${netChangePct}%；其中增持 ${formatWan(totalIncreaseShares)}股、减持 ${formatWan(totalDecreaseShares)}股` },
    { name: '增减持家数', signal: countSignal, value: `增持 ${inc}/减持 ${dec}`, detail: `前十大股东增持/新进 ${inc} 家、减持 ${dec} 家、不变 ${flat} 家${incNames.length ? `（增持：${incNames.slice(0, 3).join('、')}${incNames.length > 3 ? '等' : ''}）` : ''}${decNames.length ? `（减持：${decNames.slice(0, 3).join('、')}${decNames.length > 3 ? '等' : ''}）` : ''}` },
  ];
  if (buybackOk) {
    subs.push({ name: '股份回购', signal: clamp(0.6, -1, 1), value: `回购 ${buyback.count} 次`, detail: `股份回购 ${buyback.count} 次${buyback.latest ? `（最近：${buyback.latest}）` : ''}${buyback.titles && buyback.titles.length ? `：${buyback.titles.slice(0, 2).join('、')}` : ''}` });
  } else {
    subs.push({ name: '股份回购', signal: 0, value: '无', detail: '未检索到股份回购记录，按中性处理' });
  }
  return { key: 'holdings', name: '增持减持', weight: 0.043, signal, applicable: true, value, detail, subFactors: subs };
}

// 7) 板块涨跌停占比：个股所属板块内涨停/跌停家数占板块成分股总数的比例。
//    作为短期情绪强弱的量化输入（板块情绪热度），与市场情绪/技术面信号结合用于方向判断。
//    数据来自 lib/sectorLimitStats（东财涨停池/跌停池权威判定阈值 + 同花顺板块成分总数）。
function factorSectorLimit(stats) {
  if (stats && stats.ok && typeof stats.limitUpRatio === 'number' && typeof stats.limitDownRatio === 'number') {
    const upR = stats.limitUpRatio;
    const downR = stats.limitDownRatio;
    const upPct = (upR * 100).toFixed(1);
    const downPct = (downR * 100).toFixed(1);
    // 涨停占比与跌停占比的差值（×20 放大到 [-1,1]），板块出现涨停潮为强多、跌停潮为强空
    const signal = clamp((upR - downR) * 20, -1, 1);
    const board = stats.boardName || stats.industryName || '行业板块';
    const detail = `所属「${board}」板块：涨停 ${stats.limitUp} 家（${upPct}%）、跌停 ${stats.limitDown} 家（${downPct}%）、成分 ${stats.total} 家` +
      (signal > 0.15 ? ' → 板块情绪偏热（涨停潮）' : signal < -0.15 ? ' → 板块情绪偏冷（跌停潮）' : ' → 板块情绪平稳');
    const value = `涨停 ${upPct}% / 跌停 ${downPct}%`;
    const subs = [
      { name: '涨停占比', signal: clamp(upR * 20, -1, 1), value: `${upPct}%`, detail: `所属「${board}」板块涨停 ${stats.limitUp} 家，占成分股 ${upPct}%` },
      { name: '跌停占比', signal: clamp(-downR * 20, -1, 1), value: `${downPct}%`, detail: `所属「${board}」板块跌停 ${stats.limitDown} 家，占成分股 ${downPct}%` },
      { name: '板块成分', signal: 0, value: `${stats.total} 家`, detail: `板块成分股共 ${stats.total} 家（${board}）` },
    ];
    return { key: 'sectorLimit', name: '板块涨跌停占比', weight: 0.071, signal, applicable: true, value, detail, subFactors: subs };
  }
  return { key: 'sectorLimit', name: '板块涨跌停占比', weight: 0.071, signal: 0, applicable: true,
    value: '—', detail: (stats && stats.note) ? stats.note : '板块涨跌停数据不可用，按中性处理' };
}

// 7) 板块跷跷板（科技/半导体负相关）：仅对非科技/半导体个股生效。
//    取科技/半导体板块当日整体涨跌幅（多板块均值）作为 composite，
//    按"反向"映射为个股信号：科技涨 → 其他板块(含该股)跌 → 偏空；科技跌 → 偏多。
//    个股本身属于科技/半导体行业时，即跷跷板中被参照的一方，因子不适用（applicable:false）。
function factorSeesaw(seesaw, isTechStock) {
  if (isTechStock) {
    return {
      key: 'seesaw', name: '板块跷跷板(科技/半导体负相关)', weight: 0.056, signal: 0, applicable: false,
      value: '不适用',
      detail: '个股本身属于科技/半导体板块，即跷跷板效应中被参照的一方，本因子不适用（避免自相关）',
    };
  }
  const composite = (seesaw && typeof seesaw.compositeChange === 'number') ? seesaw.compositeChange : 0;
  const boards = (seesaw && seesaw.boards) ? seesaw.boards : {};
  const subs = Object.keys(boards).map((k) => {
    const b = boards[k];
    const chg = (b && typeof b.boardChange === 'number') ? b.boardChange : null;
    return {
      name: `科技板块·${k}`, w: 0, signal: 0,
      value: chg != null ? `${chg >= 0 ? '+' : ''}${round(chg, 2)}%` : '—',
      detail: chg != null
        ? `${k}板块当日${chg >= 0 ? '上涨' : '下跌'}${Math.abs(chg).toFixed(2)}%（${b.boardName || k}）`
        : `${k}板块数据不可用`,
    };
  });
  if (!seesaw || !seesaw.ok) {
    return {
      key: 'seesaw', name: '板块跷跷板(科技/半导体负相关)', weight: 0.056, signal: 0, applicable: true,
      value: '—',
      detail: (seesaw && seesaw.note) ? seesaw.note : '科技/半导体板块走势数据不可用，按中性处理',
      subFactors: subs,
    };
  }
  let signal = 0;
  if (Math.abs(composite) < SEESAW_DEADBAND_PCT) {
    signal = 0;
  } else {
    signal = -clamp(composite / SEESAW_FULL_PCT, -1, 1);
  }
  const dirTxt = composite > 0 ? '上涨' : composite < 0 ? '下跌' : '持平';
  const verdict = signal > 0.05 ? '偏多' : signal < -0.05 ? '偏空' : '中性';
  const detail = `科技/半导体板块当日整体${dirTxt} ${composite >= 0 ? '+' : ''}${round(composite, 2)}%，与"其他板块"（含该股）呈明显负相关` +
    ` → 该股倾向${signal > 0.05 ? '上涨' : signal < -0.05 ? '下跌' : '震荡'}（${verdict}）` +
    `；阈值：满格 ±${SEESAW_FULL_PCT}%，死区 ±${SEESAW_DEADBAND_PCT}%`;
  return {
    key: 'seesaw', name: '板块跷跷板(科技/半导体负相关)', weight: 0.056,
    signal: round(signal, 3), applicable: true,
    value: `${composite >= 0 ? '+' : ''}${round(composite, 2)}%`,
    detail, subFactors: subs,
  };
}

// ============ 第 8 因子：技术面短期动向 ============
// 引用价格行为趋势推演（lib/priceAction.analyzePriceAction）的 shortTerm 输出，
// 与「技术面分析」页同源，保证数据一致性（规则一·指标级单源）。
// 权重暂定 0.200（DEFAULT_WEIGHTS.technicalShort），后续由 self-learning 层按准确率自动进化。
function factorTechnicalShort(pa) {
  const stx = pa && pa.shortTerm ? pa.shortTerm : null;
  if (!stx || typeof stx.dirScore !== 'number') {
    return {
      key: 'technicalShort', name: '技术面短期动向', weight: 0.200,
      signal: 0, applicable: true, value: '—',
      detail: '技术面短期数据不足（K线<60 或价格行为推演未返回短期动向），按中性处理。来源：价格行为趋势推演（日/60分钟级别）',
    };
  }
  const signal = clamp(round(stx.dirScore, 3) / 3, -1, 1); // dirScore 量级约 ±3.5，/3 限幅到 ±1
  const dirTxt = stx.direction || '震荡';
  const bias = (stx.bias5 != null) ? `${stx.bias5 >= 0 ? '+' : ''}${stx.bias5}%` : '—';
  const biasZ = (stx.biasZ != null) ? stx.biasZ : '—';
  const slope = (stx.slopeSpread != null) ? `${stx.slopeSpread >= 0 ? '+' : ''}${stx.slopeSpread}%` : '—';
  const detail =
    `技术面短期动向：${dirTxt}（概率 ${stx.probability || '—'}）。` +
    `短期乖离率 MA5 ${bias}（标准化Z=${biasZ}）${stx.overbought ? '，短期超买、均值回归压力' : stx.oversold ? '，短期超卖、修复预期' : '，乖离稳定'}；` +
    `MA5/MA60斜率差 ${slope}；K线形态「${stx.pattern || '—'}」` +
    (stx.h60ma ? `；60分钟MA60(${stx.h60ma.value})价格运行于其${stx.h60ma.position}` : '') +
    `。来源：价格行为趋势推演（日/60分钟级别），与「技术面分析」页同源。`;
  // 子信号（展示用，不影响打分；方向语义与父因子同源）
  const subs = [
    { name: '短期乖离率(MA5)', signal: clamp(-(stx.biasZ || 0) / 2, -0.6, 0.6),
      value: bias, detail: `价格偏离MA5 ${bias}（标准化Z=${biasZ}），${stx.overbought ? '超买' : stx.oversold ? '超卖' : '稳定'}·来源：价格行为趋势推演` },
    { name: 'K线组合形态', signal: stx.pattern === '放量突破前高' ? 0.4 : (stx.pattern === '放量跌破前低' ? -0.4 : (stx.pattern === '缩量新高' ? -0.1 : 0)),
      value: stx.pattern || '—', detail: `近20日形态「${stx.pattern || '—'}」${stx.volRatio != null ? `，量比${stx.volRatio}` : ''}·来源：价格行为趋势推演` },
    { name: 'MA5/MA60斜率差', signal: clamp((stx.slopeSpread || 0) / 20, -0.5, 0.5),
      value: slope, detail: `短期动能与中期动能斜率差 ${slope}·来源：价格行为趋势推演` },
  ];
  if (stx.h60ma) {
    subs.push({ name: '60分钟MA60', signal: stx.h60ma.position === '上方' ? 0.25 : (stx.h60ma.position === '下方' ? -0.25 : 0),
      value: stx.h60ma.position, detail: `价格运行于60分钟MA60(${stx.h60ma.value})其${stx.h60ma.position}·来源：价格行为趋势推演` });
  }
  return {
    key: 'technicalShort', name: '技术面短期动向', weight: 0.200,
    signal: round(signal, 3), applicable: true,
    value: `${dirTxt}${stx.probability ? ' · 概率' + stx.probability : ''}`,
    detail, subFactors: subs,
  };
}

// ============ 汇总（支持自适应权重覆盖）============
function combineFactors(factors, weightOverride) {
  const used = factors.filter(f => f.applicable);
  const wsum = used.reduce((a, f) => a + (weightOverride && weightOverride[f.key] != null ? weightOverride[f.key] : f.weight), 0) || 1;
  let total = 0;
  const out = factors.map(f => {
    const w = (weightOverride && weightOverride[f.key] != null) ? weightOverride[f.key] : f.weight;
    const eff = f.applicable ? w / wsum : 0;
    const contribution = round(eff * f.signal, 3);
    total += contribution;
    // 影响程度评分：因子与子因子统一由 withImpact 计算，保证展示与语义同源
    const subFactors = (f.subFactors || []).map(sf => withImpact(sf));
    return withImpact({ ...f, weight: w, effectiveWeight: round(eff, 3), contribution, subFactors });
  });
  total = round(total, 3);
  let dir = '震荡';
  if (total > 0.12) dir = '涨';
  else if (total < -0.12) dir = '跌';
  const agree = used.filter(f => f.signal !== 0 && Math.sign(f.signal) === Math.sign(total)).length;
  const mag = Math.abs(total);
  let confidence = '低';
  if (mag >= 0.4 && used.length && agree >= Math.ceil(used.length * 0.6)) confidence = '高';
  else if (mag >= 0.22) confidence = '中';
  return { factors: out, totalScore: total, dir, verdict: VERdict_LABEL[dir], confidence };
}

// ============ 自我进化 / 错误学习层 ============
// 思路：每笔判断结算后，记录各因子的「方向是否与真实方向一致」，
// 分「全局」与「按预测方向(涨/跌/震荡)」两类统计各因子的命中率；
// 据此自适应调整因子权重（命中率低的因子降权），下一笔判断即使用新权重。
// 权重缓慢进化（带平滑与样本下限），避免小样本过拟合导致抖动。
const FACTOR_KEYS = ['sentiment', 'capital', 'futures', 'market', 'holdings', 'sectorLimit', 'seesaw', 'technicalShort'];
const FACTOR_NAME = {
  sentiment: '市场情绪与消息面', capital: '资金量能', futures: '对标期货短期走势',
  market: '大盘及行业板块短期走势', holdings: '增持减持',
  sectorLimit: '板块涨跌停占比', seesaw: '板块跷跷板(科技/半导体负相关)',
  technicalShort: '技术面短期动向',
};
// 20260823i：将「近期重大利好/利空」并入「市场情绪」（成为其子信号），市场情绪权重 0.16→0.38；
// 其余因子按原比例等比缩放使总权重=1。
// 20260827d：新增第 7 因子「板块跷跷板」(权重 0.07)，其余 6 因子按 0.93 比例等比缩放，
// 使 7 因子权重之和 = 1.000（0.340+0.197+0.107+0.143+0.054+0.089+0.070）。
// 20260903o：新增第 8 因子「技术面短期动向」(权重 0.200，引用价格行为推演 shortTerm)，
// 其余 7 因子按 0.80 比例等比缩放，使 8 因子权重之和 = 1.000
// （0.272+0.158+0.086+0.114+0.043+0.071+0.056+0.200）。
// 注：各 factor* 函数内嵌的 weight 字面量与此处保持一致（combineFactors 默认走字面量权重）；
// 该因子权重暂定 20%，后续由 self-learning 层（FACTOR_KEYS/DEFAULT_WEIGHTS）按结算准确率自动进化调整。
const DEFAULT_WEIGHTS = {
  sentiment: 0.272, capital: 0.158, futures: 0.086, market: 0.114,
  holdings: 0.043, sectorLimit: 0.071, seesaw: 0.056, technicalShort: 0.200,
};
const LEARN_DIR = path.join(__dirname, '..', 'data', 'learning');
const LEARN_FILE = path.join(LEARN_DIR, 'state.json');
const LEARN_MIN_SAMPLE = 5;   // 单因子样本下限，低于此值不调整权重
const LEARN_SMOOTH = 0.4;     // 新权重占比（慢速进化）

let learningState = null;
function loadLearning() {
  if (learningState) return learningState;
  let loaded = null;
  try { loaded = JSON.parse(fs.readFileSync(LEARN_FILE, 'utf8')); } catch (e) { loaded = null; }
  learningState = {
    factorStats: {},
    byVerdict: {},
    weights: { ...DEFAULT_WEIGHTS },
    // 按个股独立累积的命中统计与专属权重（每只股票根据自身准确率进化）
    bySymbol: {},
    // 保留权重演进历史，使「进化时间线」跨重启持续
    weightHistory: (loaded && Array.isArray(loaded.weightHistory)) ? loaded.weightHistory : [],
    learnedCount: 0,
    lastUpdated: null,
    recentErrors: [],
  };
  for (const v of ['涨', '跌', '震荡']) learningState.byVerdict[v] = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS } };
  return learningState;
}
function saveLearning() {
  try {
    if (!fs.existsSync(LEARN_DIR)) fs.mkdirSync(LEARN_DIR, { recursive: true });
    fs.writeFileSync(LEARN_FILE, JSON.stringify(learningState, null, 2), 'utf8');
  } catch (e) { /* 忽略写入失败 */ }
}
function _bump(bucket, key, hit) {
  if (!bucket[key]) bucket[key] = { hits: 0, total: 0 };
  bucket[key].total++;
  if (hit) bucket[key].hits++;
}
// 注：学习模型采用「从全部已结算判断幂等重建」(见 rebuildLearning)，
// 不再依赖单条记录的标记位，避免跨进程/重启后状态丢失。该函数已废弃。
function recordJudgmentOutcome() {}

// 新建一个「个股学习桶」：全局 + 按预测方向（涨/跌/震荡）的因子命中统计与专属权重
function newSymbolBucket() {
  const b = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS }, byVerdict: {} };
  for (const v of ['涨', '跌', '震荡']) b.byVerdict[v] = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS } };
  return b;
}
// 基于命中率重算「单个桶」的自适应权重（命中率低的因子降权，带平滑与样本下限）
function _recomputeBucketWeights(factorStats, prevWeights) {
  const newW = {};
  for (const k of FACTOR_KEYS) {
    const stat = factorStats[k];
    const base = DEFAULT_WEIGHTS[k];
    const old = (prevWeights && prevWeights[k] != null) ? prevWeights[k] : base;
    if (stat && stat.total >= LEARN_MIN_SAMPLE) {
      const cr = stat.hits / stat.total;
      const target = clamp(base * (0.5 + cr), 0.03, 0.6);
      newW[k] = round(old * (1 - LEARN_SMOOTH) + target * LEARN_SMOOTH, 4);
    } else {
      newW[k] = old;
    }
  }
  const sum = FACTOR_KEYS.reduce((a, k) => a + (newW[k] || 0), 0) || 1;
  for (const k of FACTOR_KEYS) newW[k] = round(newW[k] / sum, 4);
  return newW;
}
// 基于命中率重算自适应权重：全局 + 按预测方向 + 每个个股（含其按预测方向）
function recomputeWeights() {
  const st = loadLearning();
  for (const v of ['涨', '跌', '震荡']) {
    const bv = st.byVerdict[v];
    bv.weights = _recomputeBucketWeights(bv.factorStats, bv.weights);
  }
  st.weights = _recomputeBucketWeights(st.factorStats, st.weights);
  // 按个股独立进化：每只股票累积自身命中率，得到专属权重比
  for (const ns of Object.keys(st.bySymbol)) {
    const sb = st.bySymbol[ns];
    for (const v of ['涨', '跌', '震荡']) {
      const sbv = sb.byVerdict[v];
      sbv.weights = _recomputeBucketWeights(sbv.factorStats, sbv.weights);
    }
    sb.weights = _recomputeBucketWeights(sb.factorStats, sb.weights);
  }
  // 权重演进记录（全局权重时间线，每天最多一条）
  const today = localDate();
  const last = st.weightHistory[st.weightHistory.length - 1];
  if (!last || last.date !== today) {
    st.weightHistory.push({ date: today, weights: { ...st.weights } });
    if (st.weightHistory.length > 60) st.weightHistory.shift();
  }
}
// 取某「个股 + 预测方向」的自适应权重；按回退链逐级降级：
//   1) 该股票按预测方向的专属权重（样本最贴合该股该方向）
//   2) 该股票全局专属权重（该股各方向综合）
//   3) 全局按预测方向权重（跨股票）
//   4) 全局默认权重
function getAdaptiveWeights(symbol, dir) {
  const st = loadLearning();
  const sampleOf = (bv) => FACTOR_KEYS.reduce((a, k) => a + ((bv && bv.factorStats && bv.factorStats[k] && bv.factorStats[k].total) || 0), 0);
  const ns = normSymbol(symbol);
  const sb = st.bySymbol[ns];
  if (sb) {
    const sbv = sb.byVerdict[dir] || sb.byVerdict['震荡'];
    if (sampleOf(sbv) >= 10) return sbv.weights;
    if (sampleOf(sb) >= 10) return sb.weights;
  }
  const gv = st.byVerdict[dir] || st.byVerdict['震荡'];
  if (sampleOf(gv) >= 10) return gv.weights;
  return st.weights;
}
// 历史回填 / 重建：遍历所有已结算判断，幂等重建因子命中统计 + 错误归因 + 自适应权重。
// 每次结算或查询学习状态时调用，确保模型与磁盘上的判断记录完全一致。
function backfillLearning() {
  const st = loadLearning();
  st.factorStats = {};
  st.byVerdict = {};
  for (const v of ['涨', '跌', '震荡']) st.byVerdict[v] = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS } };
  st.bySymbol = {}; // 幂等重建：每次从全部已结算记录重新累计每只股票的命中统计
  st.recentErrors = [];
  st.learnedCount = 0;
  const records = getAllRecords();
  const errs = [];
  for (const rec of records) {
    if (!rec.settled) continue;
    st.learnedCount++;
    const actualDir = rec.actualDir || '震荡';
    const actualSign = actualDir === '涨' ? 1 : (actualDir === '跌' ? -1 : 0);
    const factors = rec.factors || [];
    for (const f of factors) {
      if (!f || !f.applicable) continue;
      if (!FACTOR_KEYS.includes(f.key)) continue;
      const fsign = Math.sign(f.signal || 0);
      const hit = actualSign === 0 ? (fsign === 0) : (fsign === actualSign);
      _bump(st.factorStats, f.key, hit);
      const bv = st.byVerdict[rec.dir] || (st.byVerdict[rec.dir] = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS } });
      _bump(bv.factorStats, f.key, hit);
      // 按个股累计：该股自身各因子命中率，用于推导专属权重比
      const ns = normSymbol(rec.symbol);
      if (!st.bySymbol[ns]) st.bySymbol[ns] = newSymbolBucket();
      const sb = st.bySymbol[ns];
      _bump(sb.factorStats, f.key, hit);
      const sbv = sb.byVerdict[rec.dir] || (sb.byVerdict[rec.dir] = { factorStats: {}, weights: { ...DEFAULT_WEIGHTS } });
      _bump(sbv.factorStats, f.key, hit);
    }
    if (!rec.correct) {
      const misleading = factors
        .filter(f => f.applicable && Math.sign(f.signal || 0) !== 0 && Math.sign(f.signal || 0) === -actualSign)
        .sort((a, b) => Math.abs(b.contribution || 0) - Math.abs(a.contribution || 0));
      errs.push({
        symbol: rec.symbol, name: rec.name, date: rec.date, targetDate: rec.targetDate,
        verdict: rec.verdict, actualDir, actualChgPct: rec.actualChgPct,
        misleading: misleading.map(f => ({ key: f.key, name: f.name, signal: f.signal, contribution: f.contribution })),
      });
    }
  }
  errs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  st.recentErrors = errs.slice(0, 15);
  st.lastUpdated = new Date().toISOString();
  recomputeWeights();
  const today = localDate();
  const last = st.weightHistory[st.weightHistory.length - 1];
  if (!last || last.date !== today) {
    st.weightHistory.push({ date: today, weights: { ...st.weights } });
    if (st.weightHistory.length > 60) st.weightHistory.shift();
  }
  saveLearning();
  return st;
}

// 对外暴露学习状态（供前端「错误分析与自我进化」面板）
//   symbol 非空时额外返回该股票专属的命中率与权重进化（按个股独立进化）
function getLearningState(symbol) {
  const st = backfillLearning(); // 幂等重建，确保与已结算判断完全一致
  const factorReliability = FACTOR_KEYS.map(k => {
    const g = st.factorStats[k] || { hits: 0, total: 0 };
    return { key: k, name: FACTOR_NAME[k] || k, hits: g.hits, total: g.total, correctRate: g.total ? round(g.hits / g.total * 100) : null };
  });
  const weightEvolution = FACTOR_KEYS.map(k => ({
    key: k, name: FACTOR_NAME[k] || k,
    default: DEFAULT_WEIGHTS[k],
    current: st.weights[k],
    byVerdict: {
      涨: st.byVerdict['涨'].weights[k],
      跌: st.byVerdict['跌'].weights[k],
      震荡: st.byVerdict['震荡'].weights[k],
    },
  }));
  const enough = FACTOR_KEYS.reduce((a, k) => a + ((st.factorStats[k] && st.factorStats[k].total) || 0), 0) >= 10;

  // 按个股专属学习状态（前端个股视图展示该股票自身的命中率与权重进化）
  let bySymbolState = null;
  if (symbol) {
    const ns = normSymbol(symbol);
    const sb = st.bySymbol[ns];
    if (sb) {
      const symFactorReliability = FACTOR_KEYS.map(k => {
        const g = sb.factorStats[k] || { hits: 0, total: 0 };
        return { key: k, name: FACTOR_NAME[k] || k, hits: g.hits, total: g.total, correctRate: g.total ? round(g.hits / g.total * 100) : null };
      });
      const symWeightEvolution = FACTOR_KEYS.map(k => ({
        key: k, name: FACTOR_NAME[k] || k,
        default: DEFAULT_WEIGHTS[k],
        current: sb.weights[k],
        byVerdict: {
          涨: sb.byVerdict['涨'].weights[k],
          跌: sb.byVerdict['跌'].weights[k],
          震荡: sb.byVerdict['震荡'].weights[k],
        },
      }));
      const symSample = FACTOR_KEYS.reduce((a, k) => a + ((sb.factorStats[k] && sb.factorStats[k].total) || 0), 0);
      bySymbolState = {
        exists: true,
        symbol: ns,
        learnedCount: symSample,
        sampleEnough: symSample >= 10,
        factorReliability: symFactorReliability,
        weightEvolution: symWeightEvolution,
        currentWeights: sb.weights,
        byVerdictWeights: { 涨: sb.byVerdict['涨'].weights, 跌: sb.byVerdict['跌'].weights, 震荡: sb.byVerdict['震荡'].weights },
      };
    } else {
      bySymbolState = { exists: false, symbol: ns, note: '该股票暂无已结算判断记录，无法生成专属权重（沿用全局/默认权重）' };
    }
  }

  // 个股视图：错误归因只显示该股票的记录，避免跨股污染
  const recentErrors = symbol
    ? (st.recentErrors || []).filter(e => normSymbol(e.symbol) === normSymbol(symbol))
    : (st.recentErrors || []);

  return {
    learnedCount: st.learnedCount || 0,
    lastUpdated: st.lastUpdated,
    sampleEnough: enough,
    factorReliability,
    weightEvolution,
    defaultWeights: DEFAULT_WEIGHTS,
    currentWeights: st.weights,
    byVerdictWeights: { 涨: st.byVerdict['涨'].weights, 跌: st.byVerdict['跌'].weights, 震荡: st.byVerdict['震荡'].weights },
    bySymbol: bySymbolState,
    recentErrors,
    weightHistory: st.weightHistory || [],
  };
}

// ============ 生成判断 ============
async function buildJudgment(symbol, name, industry) {
  const [quoteR, historyR, sectorIdR, futuresR, marketR, newsR, sentimentR, shareholdersR, globalSentimentR, reportR, announceR, announceCodeR, regulatoryR, h60R] = await Promise.allSettled([
    getQuote(symbol),
    getHistory(symbol, '1y').catch(() => []),
    resolveSectorIdentity(symbol, name || '').catch(() => null),
    Promise.resolve(getFuturesMeta(symbol) ? fetchFuturesCorrelation(symbol, name || '').catch(() => ({ hasFutures: false })) : { hasFutures: false }),
    getMarketOverview().catch(() => null),
    getNews(symbol, name || '').catch(() => []),
    getMarketSentiment(symbol, name || '').catch(() => null),
    getShareholdersData(symbol).catch(() => null),
    getGlobalSentiment(name || '', { days: 2, maxArticles: 10, budget: 8 }).catch(() => ({ ok: false, count: 0 })),
    interpretReport(symbol).catch(() => ({ ok: false })),
    searchAnnouncements(name || '', 10).catch(() => ({ ok: false, items: [] })),
    searchAnnouncementsByCode(symbol, 30).catch(() => ({ ok: false, items: [] })),
    getRegulatoryNews('all', 12).catch(() => ({ ok: false, items: [] })),
    getHistoryPeriod(symbol, '60m', 400).catch(() => []), // 20260903o：技术面短期动向因子（与「技术面分析」页同源）
  ]);

  const quote = quoteR.status === 'fulfilled' ? quoteR.value : null;
  const history = historyR.status === 'fulfilled' ? historyR.value : [];
  const h60 = h60R && h60R.status === 'fulfilled' ? h60R.value : null;
  const sectorId = sectorIdR.status === 'fulfilled' ? sectorIdR.value : null;
  const futures = futuresR.status === 'fulfilled' ? futuresR.value : { hasFutures: false };
  const market = marketR.status === 'fulfilled' ? marketR.value : null;
  const stockNews = newsR.status === 'fulfilled' ? newsR.value : [];
  let sentiment = sentimentR.status === 'fulfilled' ? sentimentR.value : null;
  const shareholders = shareholdersR.status === 'fulfilled' ? shareholdersR.value : null;
  const globalSentiment = globalSentimentR.status === 'fulfilled' ? globalSentimentR.value : { ok: false, count: 0 };
  const report = reportR.status === 'fulfilled' ? reportR.value : { ok: false };
  const announcements = announceR.status === 'fulfilled' ? announceR.value : { ok: false, items: [] };
  const announcementsByCode = announceCodeR.status === 'fulfilled' ? announceCodeR.value : { ok: false, items: [] };
  const regulatory = regulatoryR.status === 'fulfilled' ? regulatoryR.value : { ok: false, items: [] };

  // 合并双源公告（名称搜索 + 代码兜底），按标题去重——避免深交所接口失效时漏掉回购/分红/增持等关键公告
  const annSeen = new Set();
  const allAnnouncements = [];
  for (const src of [announcements, announcementsByCode]) {
    if (src && src.ok && Array.isArray(src.items)) {
      for (const a of src.items) {
        const t = a && a.title;
        if (t && !annSeen.has(t)) { allAnnouncements.push(a); annSeen.add(t); }
      }
    }
  }
  // 回购识别：扫描合并后的公告标题 + 个股新闻标题（双保险——东财公告源偶发空时，新闻源常含回购报道）
  const BUYBACK_RE = /回购(股份|注销|方案|实施|进展|预案)?|股份回购/;
  const buybackCandidates = [];
  for (const a of allAnnouncements) if (a && a.title && BUYBACK_RE.test(a.title)) buybackCandidates.push({ title: a.title, date: a.date || '' });
  for (const n of stockNews) if (n && n.title && BUYBACK_RE.test(n.title)) buybackCandidates.push({ title: n.title, date: n.date || '' });
  const buyback = buybackCandidates.length
    ? { ok: true, count: buybackCandidates.length, latest: buybackCandidates.map(x => x.date).filter(Boolean).sort().reverse()[0] || '', titles: buybackCandidates.map(x => x.title) }
    : { ok: false, count: 0 };

  // 个股换手率变化：对比近 15 日均值的偏离，按近两日价格方向加权（资金量能因子子信号）
  const turnoverSeries = await getEastmoneyTurnover(symbol, 60).catch(() => []);
  const turnoverChange = _computeTurnoverChange(turnoverSeries);

  const capital = (quote && history.length)
    ? await analyzeCapitalFlow(symbol, (name || (quote && quote.name) || ''), quote, history).catch(() => null)
    : null;

  // 行业名称：20260821c 统一走 sectorIdentity 单一可信源（代码覆盖 + 多源校验）
  // 20260821e 修复：sectorIdentity 返回的 symbol 已 normalize（去 SH/SZ 前缀），
  // 必须用 normSymbol 比较，否则前端传入 SH600460 等带前缀 symbol 时，
  // 会丢弃正确行业、回退到可能陈旧的前端 industry 参数，造成板块/消息/政策全部错配。
  const sectorIdMatch = sectorId && normSymbol(sectorId.symbol) === normSymbol(symbol);
  let industryName = sectorIdMatch ? (sectorId.industry || '') : '';
  if (!industryName && sectorId && !sectorIdMatch) {
    console.warn(`[buildJudgment] sectorIdentity symbol 不匹配: input=${symbol} output=${sectorId.symbol}，忽略其行业结果`);
  }
  if (!industryName && quote && quote.name) {
    try { const prof = await getCompanyProfile(symbol); if (prof && prof.industry) industryName = prof.industry; } catch (e) {}
  }
  if (!industryName) industryName = industry || '';
  console.log(`[buildJudgment] symbol=${symbol} name=${name || ''} resolvedIndustry=${industryName || 'N/A'} queryIndustry=${industry || 'N/A'} sectorSource=${sectorId ? sectorId.industrySource : 'none'} sectorMatch=${sectorIdMatch}`);

  // 行业板块走势：用个股行业名定位板块，取板块整体涨跌作为「大盘及行业板块短期走势」因子的行业部分
  const sectorTrend = await getSectorTrend(symbol, name || '', industryName).catch(() => null);

  // 板块涨跌停占比：个股所属板块内涨停/跌停家数占比（短期情绪核心因子）
  const sectorLimit = await getSectorLimitStats(symbol, name || '', industryName).catch(() => null);

  // 板块消息联动：板块/赛道级新闻情绪 → 个股传导（市场情绪因子的子信号）
  const sectorNews = await getSectorNewsSentiment(industryName, name || '', symbol).catch(() => null);
  if (sectorNews && sectorNews.industryName && sectorNews.industryName !== industryName) {
    console.warn(`[buildJudgment] sectorNews 行业不匹配: expected=${industryName} got=${sectorNews.industryName} symbol=${symbol}`);
  }

  // 跨市场传导：隔夜美股对标股涨跌 → A股板块情绪（市场情绪因子的子信号）
  // Part B：先按"对标主题与个股行业的关联度"（含经验折扣）算有效关联度，回传覆盖缩放信号
  const cmTickers = benchmarksForIndustry(industryName);
  let cmTheme = null, cmEffRel = 1;
  if (cmTickers.length) {
    const cmInfos = cmTickers.map(t => benchmarkRelevance(industryName, t, symbol));
    const cmBest = cmInfos.sort((a, b) => b.relevance - a.relevance)[0];
    cmTheme = cmBest.theme; cmEffRel = cmBest.relevance;
  }
  const crossMarket = await getCrossMarketSignal(industryName, cmEffRel).catch(() => null);

  // 防御性校验：市场情绪数据必须携带正确的 symbol，否则可能是跨股污染
  if (sentiment && sentiment.symbol && sentiment.symbol !== symbol) {
    console.warn(`[buildJudgment] sentiment 跨股污染: expected=${symbol} got=${sentiment.symbol}，降级为 null`);
    sentiment = null;
  }

  // 近期重大利好/利空因子输入：个股新闻 + 行业相关消息 + 交易所公告 + 监管政策（去重合并）
  let news = stockNews;
  const seenTitles = new Set(stockNews.map(n => n.title).filter(Boolean));
  // 1) 行业相关消息
  if (industryName) {
    try {
      const indNews = await fetchEastmoneyContentNews(industryName, 12);
      for (const n of indNews) {
        if (n.title && !seenTitles.has(n.title)) {
          news.push({ ...n, sentiment: analyzeSentiment((n.title || '') + ' ' + (n.summary || '')) });
          seenTitles.add(n.title);
        }
      }
    } catch (e) {}
  }
  // 2) 交易所公告（名称搜索 + 代码兜底双源合并；分红/增持/回购/处罚等公告是直接利好/利空）
  if (allAnnouncements.length) {
    for (const a of allAnnouncements) {
      const t = a && a.title;
      if (t && !seenTitles.has(t)) {
        news.push({ title: t, source: '交易所公告', summary: (a.stock_name || a.stock_code || ''), sentiment: analyzeSentiment(t) });
        seenTitles.add(t);
      }
    }
  }
  // 3) 监管/宏观政策（按行业/赛道相关性过滤，避免无关宏观新闻稀释个股消息面）
  if (regulatory && regulatory.ok && Array.isArray(regulatory.items)) {
    const kw = getSectorKeywords(industryName);
    const nm = (name || '').trim();
    for (const r of regulatory.items) {
      const t = r && r.title;
      if (!t || seenTitles.has(t)) continue;
      const relevant = (nm && t.includes(nm)) || kw.some(k => k && t.includes(k));
      if (relevant) {
        news.push({ title: t, source: '监管政策', summary: (r.source || ''), sentiment: analyzeSentiment(t) });
        seenTitles.add(t);
      }
    }
  }

  // 20260823i：把"近期重大利好/利空"拆为子信号并入市场情绪因子
  const newsSubs = computeNewsFactor(news, quote, history, report, symbol, sentiment ? sentiment.marketSentiment : null);
  // 板块消息联动的弱关联主题（供结算复盘持续性学习）
  const weakThemes = (sectorNews && Array.isArray(sectorNews.weakThemes)) ? sectorNews.weakThemes : [];
  // 20260827d：板块跷跷板因子数据——取科技/半导体板块当日整体涨跌（仅非科技半导体个股使用）
  const isTechStock = TECH_EXCLUDE_INDUSTRIES.includes(industryName);
  let seesawData = { ok: false, compositeChange: 0, boards: {}, note: '' };
  if (!isTechStock) {
    try {
      const raw = await getBoardsTrend(TECH_BOARDS);
      if (raw && raw.boards) {
        const boards = {};
        const chgs = [];
        for (const k of TECH_BOARDS) {
          const b = raw.boards[k];
          if (b && b.ok && typeof b.boardChange === 'number') {
            boards[k] = b;
            chgs.push(b.boardChange);
          }
        }
        if (chgs.length) {
          const composite = round(avg(chgs), 3);
          seesawData = {
            ok: true,
            compositeChange: composite,
            boards,
            note: `科技板块均值 ${composite >= 0 ? '+' : ''}${composite}%（取自 ${chgs.length} 个板块）`,
          };
        } else {
          seesawData = { ok: false, compositeChange: 0, boards, note: '科技/半导体板块走势数据暂不可用，按中性处理' };
        }
      } else {
        seesawData = { ok: false, compositeChange: 0, boards: {}, note: '科技/半导体板块走势数据获取失败，按中性处理' };
      }
    } catch (e) {
      seesawData = { ok: false, compositeChange: 0, boards: {}, note: '科技/半导体板块走势获取异常，按中性处理' };
    }
  }
  // 20260903o：技术面短期动向因子——与「技术面分析」页同源（analyzePriceAction.shortTerm）
  const priceAction = (history && history.length >= 60)
    ? (() => { try { return analyzePriceAction(history, h60 && h60.length ? h60 : null); } catch (e) { return null; } })()
    : null;
  const factors = [
    factorSentiment(sentiment, quote, history, sectorNews, crossMarket, globalSentiment, newsSubs.parts, symbol),
    factorCapital(capital, turnoverChange, sentiment, quote),
    factorFuturesShort(futures),
    factorMarketShort(market, sectorTrend),
    factorHoldings(shareholders, buyback),
    factorSectorLimit(sectorLimit),
    factorSeesaw(seesawData, isTechStock),
    factorTechnicalShort(priceAction),
  ];
  // 第一遍：用默认权重得到初步方向
  const firstPass = combineFactors(factors);
  // 第二遍：按「个股 + 初步方向」取对应的「自适应权重」（样本不足时按回退链降级）
  const adaptive = getAdaptiveWeights(symbol, firstPass.dir);
  const { factors: scored, totalScore, dir, verdict, confidence } = combineFactors(factors, adaptive);

  const now = new Date();
  const date = localDate(now);
  // 收盘后预测下一交易日（严格晚于今天），盘中预测当日后续行情；准确率每日 15:30 盘后结算。
  const closed = marketClosed(now);
  const target = 'nextday';
  const referenceDate = referenceCloseDate(now); // 基准收盘日（结算比价用）
  const targetDate = closed ? nextTradingDay(date) : date; // 收盘后=下一交易日，盘中=今天
  const judgment = {
    symbol,
    name: (quote && quote.name) || name || symbol,
    industry: industryName,
    horizon: 'short',        // 短期
    horizonLabel: closed ? '下一交易日' : '今日后续',
    date,                    // 判断生成当天的本地日期（展示用）
    referenceDate,           // 最近一次已收盘的交易日（结算基准价用）
    generatedAt: now.toISOString(),
    closed,
    target,
    targetDate,
    verdict,
    dir,
    score: Math.round(totalScore * 100),
    confidence,
    factors: scored,
    weightsUsed: adaptive,
    weightsDefault: DEFAULT_WEIGHTS,
    price: quote ? quote.price : null,
    prevClose: quote ? quote.prevClose : null,
    settled: false,
    // 三规则铺开：判断结果自身也纳入规则约束（时效 + 当日涨跌的边际）
    // ★ 20260902a：传入 dir，使 consistency 文字方向词与 verdict/dir 同源（修复口径冲突）
    rules: decorateJudgmentRules({
      dataTime: referenceDate || date,
      source: '短期判断引擎（八因子加权）· 行情与消息面/技术面',
      price: quote ? quote.price : null,
      prevClose: quote ? quote.prevClose : null,
      score: Math.round(totalScore * 100),
      dir,
    }),
    // Part B：弱关联主题元信息，供结算复盘记录持续性经验
    crossMarketMeta: (crossMarket && crossMarket.ok) ? { theme: cmTheme, relevance: cmEffRel } : null,
    sectorNewsMeta: (sectorNews && sectorNews.ok) ? { relevance: sectorNews.relevance, weakThemes } : null,
  };
  // 最终防线：如果 judgment.symbol 或 industry 与入参不一致，说明内部逻辑出现污染，直接抛错避免落盘
  if (judgment.symbol !== symbol) {
    throw new Error(`[buildJudgment] 生成的判断 symbol 不一致: input=${symbol} output=${judgment.symbol}`);
  }
  if (industryName && judgment.industry !== industryName) {
    throw new Error(`[buildJudgment] 生成的判断 industry 不一致: input=${industryName} output=${judgment.industry}`);
  }

  // 20260821f 财报事件 → 资料库自动同步（一致性原则）：
  // 从个股新闻 + 合并公告中检测「YYYY年中期/半年度/年度报告」发布事件；
  // 若资料库缺失该报告期 PDF，异步触发下载+登记（幂等：每日每报告期一次，不阻塞响应）。
  // 同步结果挂在 judgment.reportEvent 供前端展示（如「已同步/缺口」）。
  try {
    const reportEvent = reportSync.detectReportEvent(symbol, name || '', stockNews, allAnnouncements);
    if (reportEvent) {
      judgment.reportEvent = reportEvent;
      const gap = !reportSync.hasReportDoc(reportEvent.symbol, reportEvent.type, reportEvent.year);
      judgment.reportGap = gap;
      if (gap) {
        reportSync.syncReportForSymbol(reportEvent)
          .then(r => console.log(`[reportSync] ${reportEvent.symbol} ${reportEvent.year} ${reportEvent.type}: ${r.reason}`))
          .catch(e => console.error('[reportSync] 同步异常:', e && e.message));
      }
    }
  } catch (e) {
    console.error('[buildJudgment] reportSync 检测失败:', e && e.message);
  }
  return judgment;
}

// ============ 持久化 ============
// 统一以「目标交易日 targetDate」为文件键，每只股票（按归一化代码）在单个 targetDate 下只保留一条记录。
// 收盘后 ~ 下一开盘前多次刷新会覆盖同一 (symbol, targetDate)，确保每目标日只计一次判断。
function saveJudgment(j) {
  ensureDir();
  j.schemaVersion = SCHEMA_VERSION;
  const ns = normSymbol(j.symbol);
  j.symbol = ns; // 落盘时统一使用归一化代码，杜绝 SH601318 / 601318 重复
  const targetDate = j.targetDate || j.date;
  const f = fileForTargetDate(targetDate);
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { arr = []; }
  const idx = arr.findIndex(r => normSymbol(r.symbol) === ns);
  if (idx >= 0) arr[idx] = j; else arr.push(j);
  fs.writeFileSync(f, JSON.stringify(arr, null, 2), 'utf8');
  return j;
}

function getLatestJudgment(symbol) {
  ensureDir();
  const target = normSymbol(symbol);
  const files = fs.readdirSync(JUDGE_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort()
    .reverse();
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(JUDGE_DIR, f), 'utf8'));
      const rec = arr.find(r => normSymbol(r.symbol) === target);
      if (rec) return rec;
    } catch (e) {}
  }
  return null;
}

// 归一化代码：去掉 SH/SZ/BJ/HK 前缀与 .SS/.SZ 后缀，便于跨源/跨页按个股聚合
function normSymbol(s) {
  return String(s || '').replace(/^(SH|SZ|BJ|HK)/i, '').replace(/\.(SS|SZ|BJ|HK)$/i, '').toUpperCase();
}
// 按个股过滤记录（归一化后比对，兼容前缀差异）
function filterBySymbol(records, symbol) {
  const s = normSymbol(symbol);
  return (records || []).filter(r => normSymbol(r.symbol) === s);
}

function getAllRecords() {
  ensureDir();
  // 只读取按 targetDate 命名的规范日期文件；排除 .bak-*/.v2-targetdate 等残留文件，
  // 否则旧备份中的重复记录会被重新计入，导致同一标的准确率被重复统计（Request D 根因）。
  const files = fs.readdirSync(JUDGE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  const out = [];
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(JUDGE_DIR, f), 'utf8'));
      if (Array.isArray(arr)) out.push(...arr);
    } catch (e) {}
  }
  return out;
}

// ============ 结算（命中判定） ============
// 口径：
//   intraday（今日后续）：今日收盘 vs 判断时刻价(rec.price)；当日未收盘不结算
//   nextday（下一开盘日）：次日收盘 vs 今日收盘；次日K线未出/未收盘不结算
//   旧记录(无 target)：沿用原“当日收盘 vs 前收”口径，兼容历史数据
// Part B：结算后复盘弱关联主题是否持续误导，记录进经验库（驱动下次关联度折扣）。
// 仅在判断记录含 crossMarketMeta / sectorNewsMeta（本版本起生成）时执行，旧记录自动跳过。
function _recordRelevanceOutcomes(rec) {
  try {
    if (!rec || !rec.settled || !rec.actualDir) return;
    const sent = (rec.factors || []).find(f => f.key === 'sentiment');
    const subs = (sent && Array.isArray(sent.subFactors)) ? sent.subFactors : [];
    const cmSub = subs.find(s => s.name === '跨市场传导');
    if (rec.crossMarketMeta && cmSub) {
      recordOutcome({
        symbol: rec.symbol, industry: rec.industry, theme: rec.crossMarketMeta.theme,
        predictedSign: cmSub.signal, actualDir: rec.actualDir,
        relevance: relevanceScore(rec.industry, rec.crossMarketMeta.theme),
        date: rec.date,
      });
    }
    const snSub = subs.find(s => s.name === '板块消息联动');
    if (rec.sectorNewsMeta && snSub && Array.isArray(rec.sectorNewsMeta.weakThemes) && rec.sectorNewsMeta.weakThemes.length) {
      for (const wt of rec.sectorNewsMeta.weakThemes) {
        recordOutcome({
          symbol: rec.symbol, industry: rec.industry, theme: wt,
          predictedSign: snSub.signal, actualDir: rec.actualDir,
          relevance: relevanceScore(rec.industry, wt),
          date: rec.date,
        });
      }
    }
  } catch (e) {
    console.error('[_recordRelevanceOutcomes] 记录弱关联经验失败:', e && e.message);
  }
}

async function settleRecord(rec) {
  if (rec.settled) return rec;
  const now = new Date();
  const today = localDate(now);
  try {
    const history = await getHistory(rec.symbol, '1y').catch(() => []);
    const todayCandle = history.find(h => h.date === rec.date);

    if (rec.target === 'nextday') {
      // targetDate 为预测目标日；referenceDate 为基准收盘日（旧记录缺失时用 rec.date 兼容）
      const targetDate = rec.targetDate || nextTradingDay(rec.date);
      const referenceDate = rec.referenceDate || rec.date;
      const next = history.find(h => h.date === targetDate);
      if (!next || next.close == null) return rec; // 目标日K线尚未生成
      if (targetDate === today && !marketClosed(now)) return rec; // 目标日尚未收盘，数据未定
      let baseline = null;
      let baselineLabel = '';
      const refCandle = history.find(h => h.date === referenceDate);
      if (refCandle && refCandle.close != null) {
        baseline = refCandle.close;
        baselineLabel = '基准日(' + referenceDate + ')收盘';
      }
      if (baseline == null) {
        // 兼容旧数据：回退到 rec.date 收盘，再不行用最近上一交易日收盘
        if (todayCandle && todayCandle.close != null) {
          baseline = todayCandle.close;
          baselineLabel = '今日收盘';
        } else {
          const prevCandles = history
            .filter(h => h.date <= rec.date && h.close != null)
            .sort((a, b) => b.date.localeCompare(a.date));
          if (prevCandles.length) {
            baseline = prevCandles[0].close;
            baselineLabel = '基准日(' + prevCandles[0].date + ')收盘';
          } else if (typeof rec.price === 'number') {
            baseline = rec.price;
            baselineLabel = '预判时价';
          }
        }
      }
      if (baseline == null) return rec; // 仍无法取得基准价，暂缓结算
      const actualChgPct = (next.close - baseline) / baseline * 100;
      const actualDir = next.close > baseline ? '涨' : (next.close < baseline ? '跌' : '震荡');
      const correct = rec.dir === '震荡' ? Math.abs(actualChgPct) <= 1.0 : rec.dir === actualDir;
      rec.actualClose = next.close;
      rec.actualChgPct = round(actualChgPct, 2);
      rec.actualDir = actualDir;
      rec.actualBaseline = baseline;
      rec.actualBaselineLabel = baselineLabel;
      rec.actualTargetLabel = '次日收盘';
      rec.settled = true;
      rec.correct = correct;
      _recordRelevanceOutcomes(rec);
      return rec;
    }

    // intraday 或旧记录（无 target）
    if (rec.date === today && !marketClosed(now)) return rec; // 当日未收盘，暂不结算
    const candle = todayCandle;
    if (!candle || candle.close == null) return rec;
    let baseline;
    if (rec.target === 'intraday') {
      baseline = (typeof rec.price === 'number') ? rec.price : (candle.prevClose != null ? candle.prevClose : null);
    } else {
      baseline = (rec.prevClose != null) ? rec.prevClose : (typeof rec.price === 'number' ? rec.price : null);
    }
    if (baseline == null) return rec;
    const actualChgPct = (candle.close - baseline) / baseline * 100;
    const actualDir = candle.close > baseline ? '涨' : (candle.close < baseline ? '跌' : '震荡');
    const correct = rec.dir === '震荡' ? Math.abs(actualChgPct) <= 1.0 : rec.dir === actualDir;
    rec.actualClose = candle.close;
    rec.actualChgPct = round(actualChgPct, 2);
    rec.actualDir = actualDir;
    rec.actualBaseline = baseline;
    rec.actualBaselineLabel = rec.target === 'intraday' ? '判断时价' : '前收';
    rec.actualTargetLabel = '今日收盘';
    rec.settled = true;
    rec.correct = correct;
    _recordRelevanceOutcomes(rec);
    return rec;
  } catch (e) {
    rec.settleError = e.message;
    return rec;
  }
}

async function settleSymbol(symbol) {
  ensureDir();
  const targetSymbol = normSymbol(symbol);
  const files = fs.readdirSync(JUDGE_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const f of files) {
    const fp = path.join(JUDGE_DIR, f);
    let arr;
    try { arr = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (e) { continue; }
    let changed = false;
    for (let i = 0; i < arr.length; i++) {
      if (normSymbol(arr[i].symbol) === targetSymbol && !arr[i].settled) {
        arr[i] = await settleRecord(arr[i]);
        if (arr[i].settled) changed = true;
      }
    }
    if (changed) { fs.writeFileSync(fp, JSON.stringify(arr, null, 2), 'utf8'); saveLearning(); }
  }
}

async function settleAll() {
  const records = getAllRecords();
  const bySymbol = {};
  for (const r of records) if (!r.settled) (bySymbol[r.symbol] = bySymbol[r.symbol] || []).push(r);
  for (const sym of Object.keys(bySymbol)) {
    await settleSymbol(sym);
  }
  // 历史回填：把「已结算但从未参与学习」的旧判断一次性补入学习模型，
  // 使权重演进能立即基于全部历史，而非仅从本次新结算的样本开始。
  backfillLearning();
  saveLearning();
  return computeAccuracy(getAllRecords());
}

function computeAccuracy(records) {
  const settled = records.filter(r => r.settled);
  const total = settled.length;
  const correct = settled.filter(r => r.correct).length;
  const today = localDate();
  const pending = records.filter(r => !r.settled);
  // 过期未结算：目标交易日已过去却仍未结算（通常是结算口径缺陷导致，应重点核查）
  const overdue = pending.filter(r => r.targetDate && r.targetDate < today);
  // 分方向
  const byDir = { 涨: { t: 0, c: 0 }, 跌: { t: 0, c: 0 }, 震荡: { t: 0, c: 0 } };
  // 分口径（今日后续 / 下一交易日）
  const byTarget = { intraday: { t: 0, c: 0 }, nextday: { t: 0, c: 0 } };
  for (const r of settled) {
    if (byDir[r.dir]) { byDir[r.dir].t++; if (r.correct) byDir[r.dir].c++; }
    const tgt = r.target === 'nextday' ? 'nextday' : 'intraday';
    byTarget[tgt].t++; if (r.correct) byTarget[tgt].c++;
  }
  const rate = p => p.t ? round(p.c / p.t * 100) : null;
  return {
    totalRecords: records.length,
    settled,
    settledCount: total,
    pendingCount: pending.length,
    overdueCount: overdue.length,
    correct,
    accuracy: total ? round(correct / total * 100) : null,
    bullRate: rate(byDir['涨']),
    bearRate: rate(byDir['跌']),
    flatRate: rate(byDir['震荡']),
    intradayRate: rate(byTarget['intraday']),
    nextdayRate: rate(byTarget['nextday']),
  };
}

// ============ 数据边界新鲜度（方案 C·Part A，对齐铁律二·数据最新性）============
// 判断应在「当日最近一个数据边界」之后生成才算新鲜；缓存早于最近边界即过期，自动重算。
// 边界点：0:00（新一天/新公告）、5:00（隔夜美股收盘已出，跨市场因子可更新）、
// 9:30（A股开盘，盘前消息已定）、15:00（收盘，转入下一交易日预判）。
function latestDataBoundary(now) {
  const d = new Date(now);
  const at = (h, m) => { const x = new Date(d); x.setHours(h, m, 0, 0); return x; };
  const candidates = [at(0, 0), at(5, 0), at(9, 30), at(15, 0)];
  let best = candidates[0];
  for (const c of candidates) if (c <= d) best = c;
  return best;
}
function isJudgmentStale(rec, now) {
  if (!rec || !rec.generatedAt) return true;
  const gen = new Date(rec.generatedAt);
  if (isNaN(gen.getTime())) return true;
  return gen < latestDataBoundary(now);
}

// ============ 编排 ============
async function getJudgmentWithAccuracy(symbol, name, industry, force) {
  const today = localDate();
  const currentTarget = 'nextday'; // 统一只做收盘后下一交易日预判
  // 当前所处的 targetDate：收盘后=下一交易日（严格晚于今天），盘中=今天
  const currentTargetDate = marketClosed(new Date()) ? nextTradingDay(today) : today;
  let rec = null;
  if (!force) rec = getLatestJudgment(symbol);
  // 新增（20260826c）：如果旧判断标记了“资料库缺报告”，但现在资料库已补齐，强制重新生成。
  // 根因案例：600909 在 2026-08-25 04:42:55 生成判断，PDF 在 04:42:58 才登记进资料库（相差 3ms），
  // 导致 reportGap=true 被持久化；同一 targetDate 内刷新一直复用旧缓存，持续误报“缺报告”。
  if (rec && rec.reportGap && rec.reportEvent && rec.reportEvent.type && rec.reportEvent.year) {
    const nowHasDoc = reportSync.hasReportDoc(rec.reportEvent.symbol, rec.reportEvent.type, rec.reportEvent.year);
    if (nowHasDoc) {
      console.log(`[SameDayJudgment] ${symbol} 旧判断标记缺 ${rec.reportEvent.year} ${rec.reportEvent.type}，但资料库已补齐，强制重算`);
      force = true;
      rec = null;
    }
  }
  // 复用条件（方案 C·Part A 增强）：同一 targetDate + nextday 口径 + 非强制 + 无异常文本 + schema 一致 + 未过期
  const stale = rec ? isJudgmentStale(rec, new Date()) : false;
  const reuse = rec && rec.targetDate === currentTargetDate && rec.target === currentTarget && !force && !_judgmentHasRawException(rec) && rec.schemaVersion === SCHEMA_VERSION && !stale;
  if (reuse) {
    // 复用，但仍结算该股历史判断以更新准确率
    await settleSymbol(symbol);
    return { judgment: rec, accuracy: computeAccuracy(filterBySymbol(getAllRecords(), symbol)), today: today, regenerated: false };
  }
  if (rec) {
    const reason = _judgmentHasRawException(rec) ? '异常文本' : (rec.schemaVersion !== SCHEMA_VERSION ? '旧schema' : (stale ? '数据过期' : '其他'));
    console.log('[SameDayJudgment] 旧缓存不复用，重新生成:', symbol, '(' + reason + ')');
  }
  const judgment = await buildJudgment(symbol, name, industry);
  saveJudgment(judgment);
  await settleSymbol(symbol); // 结算该股过往未结算记录
  return { judgment, accuracy: computeAccuracy(filterBySymbol(getAllRecords(), symbol)), today, regenerated: true };
}

// ============ 盘前主动重算（方案 C·Part B）============
// 对当前 targetDate 下所有 nextday 未结算判断，用最新数据重算并落盘，
// 覆盖「近期浏览/自选」标的，吸收隔夜美股与早间消息，确保开盘前判断已就绪（普通打开不必再等重算）。
async function preOpenRecomputeAll() {
  const now = new Date();
  const today = localDate(now);
  const targetDate = marketClosed(now) ? nextTradingDay(today) : today;
  const records = getAllRecords().filter(r => r.target === 'nextday' && r.targetDate === targetDate && !r.settled);
  const seen = new Set();
  let count = 0, skipped = 0;
  for (const r of records) {
    const ns = normSymbol(r.symbol);
    if (seen.has(ns)) continue;
    seen.add(ns);
    try {
      const j = await buildJudgment(ns, r.name, r.industry);
      saveJudgment(j);
      count++;
    } catch (e) {
      skipped++;
      console.error('[盘前重算] 失败', ns, (e && e.message) || e);
    }
  }
  console.log(`[盘前重算] 完成：重建 ${count} 条，跳过 ${skipped} 条（targetDate=${targetDate}）`);
  return { count, skipped, targetDate };
}

// ============ 一次性数据迁移：旧版按 date 分文件 + 未归一化 symbol 导致重复计分 ============
// 迁移后：按 targetDate 分文件，(normSymbol(symbol), targetDate) 唯一，保留 generatedAt 最新的一条。
// 幂等：迁移完成会写入 .v2-targetdate 标记文件，重启不会重复执行。
function migrateToTargetDateSchema() {
  const marker = path.join(JUDGE_DIR, '.v2-targetdate');
  if (fs.existsSync(marker)) return;
  ensureDir();
  const files = fs.readdirSync(JUDGE_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  if (!files.length) {
    fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
    return;
  }

  const allRecords = [];
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(JUDGE_DIR, f), 'utf8'));
      if (Array.isArray(arr)) allRecords.push(...arr);
    } catch (e) { console.error('[migrateJudgments] read failed:', f, e.message); }
  }

  // 按 (normSymbol, targetDate) 去重，保留 generatedAt 最新的记录
  const groups = {};
  for (const r of allRecords) {
    if (!r || !r.symbol || !r.targetDate) continue;
    const ns = normSymbol(r.symbol);
    const key = `${ns}::${r.targetDate}`;
    if (!r.referenceDate) r.referenceDate = r.date;
    const curTime = (r.generatedAt || r.date || '').toString();
    const bestTime = groups[key] ? (groups[key].generatedAt || groups[key].date || '').toString() : '';
    if (!groups[key] || curTime > bestTime) groups[key] = r;
  }

  // 按 targetDate 重组文件
  const byTarget = {};
  for (const r of Object.values(groups)) {
    if (!byTarget[r.targetDate]) byTarget[r.targetDate] = [];
    r.symbol = normSymbol(r.symbol); // 落盘统一归一化代码
    byTarget[r.targetDate].push(r);
  }

  // 备份旧文件：用 rename 移动（同一卷内为原子移动）到备份目录，
  // 既完成备份又移除原文件；避免环境 safe-delete 拦截 fs.unlinkSync 导致迁移失败。
  const backupDir = path.join(__dirname, '..', 'data', 'judgments.bak-pre-v2');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  for (const f of files) {
    const src = path.join(JUDGE_DIR, f);
    if (!fs.existsSync(src)) continue;
    try {
      fs.renameSync(src, path.join(backupDir, f));
    } catch (e) {
      console.error('[migrateJudgments] 移动备份失败:', f, e.message);
    }
  }

  // 写入新文件
  for (const [targetDate, arr] of Object.entries(byTarget)) {
    arr.sort((a, b) => String(a.symbol).localeCompare(String(b.symbol)));
    fs.writeFileSync(path.join(JUDGE_DIR, `${targetDate}.json`), JSON.stringify(arr, null, 2), 'utf8');
  }

  fs.writeFileSync(marker, new Date().toISOString(), 'utf8');
  console.log(`[migrateJudgments] 已迁移 ${allRecords.length} 条旧记录 → ${Object.keys(byTarget).length} 个 targetDate 文件，去重后 ${Object.keys(groups).length} 条`);
}

// 模块加载时自动执行一次迁移（幂等）
try { migrateToTargetDateSchema(); } catch (e) {
  console.error('[migrateJudgments] 迁移失败:', e.message);
}

module.exports = {
  buildJudgment,
  saveJudgment,
  getLatestJudgment,
  getAllRecords,
  settleRecord,
  settleSymbol,
  settleAll,
  computeAccuracy,
  getJudgmentWithAccuracy,
  preOpenRecomputeAll,
  normSymbol,
  filterBySymbol,
  localDate,
  nextTradingDay,
  previousTradingDay,
  referenceCloseDate,
  marketClosed,
  SIGNAL_ARROW,
  getLearningState,
  getAdaptiveWeights,
  factorSentiment,
  computeNewsFactor,
  factorTechnicalShort,
  DEFAULT_WEIGHTS,
  FACTOR_KEYS,
  FACTOR_NAME,
};
