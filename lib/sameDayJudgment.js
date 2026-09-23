/**
 * 短期行情判断引擎（预测下一开盘日涨跌）
 * --------------------------------------------------------------
 * 结合短期信号做透明加权打分，输出可解释的「短期行情判断」：
 *   1) 大盘（原「市场情绪与消息面」，20260917i 改名重组：市场情绪提醒[引用首页判断] +
 *      大盘短期走势 + 内幕抢跑预警 + 全网舆情）
 *   2) 资金量能          (capitalFlow 主力净流入 + 量价 + 融资余额变化 + 换手率变化 + 量能活跃度)
 *   3) 对标期货短期走势  (futuresData 相关性 + 期货近5日涨跌幅)
 *   4) 增持减持          (前十大股东增持/减持方向)
 *   5) 行业板块（原「板块涨跌停占比」，20260917i 改名重组：涨跌停占比 + 行业短期走势 + 板块消息）
 *   6) 科技指数（负相关）(科技/半导体板块当日整体涨跌 → 非科技个股反向信号；
 *      科技/半导体行业个股本身即被参照板块，因子不适用)
 *   7) 个股短期动向      (价格行为趋势推演 shortTerm + 舆情与讨论热度（个股） + 财报解读)
 * * 每个因子都给出：方向(+1/-1/0)、权重、贡献分、取值、判断依据文字，
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
const { resolveSectorIdentity, getSectorKeywords, THS_BOARD_BY_CODE } = require('./sectorIdentity');
const { getCompanyProfile, getShareholdersData } = require('./shareholderData');
const { getMarketSentiment } = require('./sentiment');
// 20260821f：财报事件 → 资料库自动同步（一致性原则：判断引擎识别到最新定期报告发布时，
// 自动补齐资料库缺失的 PDF；仅作事件检测与异步同步，不阻塞判断生成）
const reportSync = require('./reportSync');
const { getSectorTrend, getBoardsTrend } = require('./sectorTrend');
// 20260905d：大盘及行业板块短期走势因子按个股市场筛选指数 + 联动首页大盘技术分析短期研判
const { detectMarket } = require('./stockData');
const { getMarketTechnical } = require('./marketTechnical');
// 20260905e：按个股真实成分股判定上证50/创业板指/沪深300，修复"一刀切" bug
const { pickIndicesForStock: pickIndicesForStockReal } = require('./indexConstituents');
const { getSectorLimitStats } = require('./sectorLimitStats');
const { getCrossMarketSignal, benchmarksForIndustry } = require('./crossMarket');
// Part B：关联度 / 弱关联持续性经验库（relevanceScore / effectiveRelevance / benchmarkRelevance / recordOutcome）
const { relevanceScore, effectiveRelevance, benchmarkRelevance, recordOutcome } = require('./relevanceLearning');
const { getGlobalSentiment, interpretReport, searchAnnouncements, searchAnnouncementsByCode, getRegulatoryNews } = require('./cnscraperAdapter');
const { readEarningsCache, extractEarningsSignal } = require('./aiAugment');
const { analyzePriceAction } = require('./priceAction'); // 20260903o：技术面短期动向因子引用其 shortTerm（现作为 hub 失败时的本地回退）
const { getPriceActionSnapshot } = require('./priceActionHub'); // 20260905g：与技术面分析页共用同一份快照（指标级单源）
const { decorateRules, changeRate, withImpact, clamp } = require('./ruleCore');
const eventEngine = require('./eventEngine'); // 20260907a：三联动·事件驱动权重引擎
const dedicatedFactor = require('./dedicatedFactor'); // 20260911：专属因子（海天味业CPI等）
const { buildStockSentiment } = require('./stockSentiment'); // Part B：单只个股全网舆情分析计算层
const marketEmotionModel = require('./marketEmotionModel'); // 20260917i：「大盘」卡片新增「市场情绪提醒」子因子——读首页落盘判断（单源引用，不重算）
// 20260921j：「股份回购」子卡片改走东财结构化回购报表（datacenter-web RPTA_WEB_GETHGLIST_NEW），
//   提炼「数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度」四要素（用户 2026-09-21 要求）
const { getBuybackPlan, formatPlan: formatBuybackPlan } = require('./buybackEmDc');
// 只取别名：本文件自己声明了 function localDate（委托用），避免重名冲突
const { localDate: _localDate } = require('./localDate');

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
// SCHEMA_VERSION 已改为「因子结构哈希」自动守卫，定义见 DEFAULT_WEIGHTS 之后：
//   因子增删/改名/默认权重变化 → FACTOR_KEYS/DEFAULT_WEIGHTS 变化 → 哈希自动变化 → 旧记录强制重算；
//   仅展示布局/口径（非因子名/权重/数量）调整时，手动 +1 LAYOUT_VERSION 即可（一处改动）。

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
// 统一委托给 lib/localDate.js（北京时区；UTC+8 下逐点等价）
function localDate(d = new Date()) { return _localDate(d); }
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

// 1) 大盘（20260917i：由「市场情绪与消息面」改名并重组，用户 20260917 要求）
//    卡片重组内容：
//      · 删除「消息情绪（大盘）」子因子及其底层逻辑（东财股吧全市场聚合 marketHeat 的取数与计分）；
//      · 删除「涨跌停比」子因子及其底层逻辑（全市场涨停/跌停家数取数与计分）；
//      · 新增「市场情绪提醒」子因子 —— 直接引用首页「市场情绪提醒」卡片的判断（lib/marketEmotionModel
//        落盘的同一份当日记录），个股页不重算，杜绝双源各说各话（规则一·指标级单源）；
//      · 转入原「大盘及行业板块短期走势」因子的「大盘短期走势」子因子；
//      · 「财报解读」「舆情与讨论热度（个股）」转出至「个股短期动向」卡片；
//      · 「板块消息」转出至「行业板块」卡片（原「板块涨跌停占比」）；
//      · 保留「内幕抢跑预警」「全网舆情」。
//    子因子在该因子内按 w 归一化加权：signal = Σ(w/Σw) × subSignal。
function factorSentiment(sentiment, quote, history, sectorNews, crossMarket, globalSentiment, newsParts, symbol, capital, turnoverChange, stockCtx) {
  const parts = [];

  // 1.1 市场情绪提醒 —— 直接引用首页判断（读落盘，同源不重算）
  parts.push(computeMarketEmotionSub());

  // 1.2 大盘短期走势 —— 原「大盘及行业板块短期走势」因子迁入（取数口径不变）
  const msSub = computeMarketShortSub(stockCtx);
  if (msSub && msSub.sub) parts.push(msSub.sub);

  // 1.3 内幕抢跑预警 / 兜底「消息面」（来自 computeNewsFactor）
  //     注：「消息情绪（大盘）」已删除、「财报解读」已迁出，此处显式跳过以防旧调用方误传
  for (const np of (newsParts || [])) {
    if (np.name === '消息情绪（大盘）' || np.name === '财报解读') continue;
    parts.push({ name: np.name, w: np.w || 0.05, signal: clamp(np.signal, -1, 1), value: np.value, detail: np.detail });
  }

  // 1.4 全网舆情（cn-financial-scraper：60+ 商业财经媒体源 + RSS + 搜索，与东财个股/板块新闻互补）
  if (globalSentiment && globalSentiment.ok && typeof globalSentiment.signal === 'number' && globalSentiment.count > 0) {
    const gs = globalSentiment;
    const top = (gs.articles || []).slice(0, 3).map(a => a.title).join('、');
    parts.push({
      name: '全网舆情', w: 0.10, signal: clamp(gs.signal, -1, 1),
      value: `利好 ${gs.positive}/利空 ${gs.negative}`,
      detail: `全网舆情（cn-financial-scraper）${gs.count} 条，利好 ${gs.positive}/中性 ${gs.neutral}/利空 ${gs.negative}，情感均值 ${gs.avg_score != null ? (gs.avg_score >= 0 ? '+' : '') + round(gs.avg_score, 2) : '—'}${top ? `；样例：${top}` : ''}`,
    });
  }

  if (!parts.length) {
    return { key: 'sentiment', name: FACTOR_NAME.sentiment, weight: W_SENTIMENT, signal: 0, applicable: true,
      value: '—', detail: '大盘情绪/消息/舆情数据获取失败，按中性处理' };
  }
  const wsum = parts.reduce((a, p) => a + p.w, 0) || 1;
  let s = 0;
  for (const p of parts) s += (p.w / wsum) * p.signal;
  s = clamp(s, -1, 1);
  const detail = parts.map(p => p.detail).join('；');
  const value = parts.map(p => p.value).join(' | ');
  return { key: 'sentiment', name: FACTOR_NAME.sentiment, weight: W_SENTIMENT, signal: s, applicable: true, value, detail, subFactors: parts };
}

// 2) 资金量能
// 复用 analyzeCapitalFlow 统一结论（与个股分析页「资金量能」同款），保证跨页面一致。
// turnoverChange：个股换手率变化子信号（对比近15日均值的偏离，按近两日价格方向加权），
//   为本次新增——此前资金量能只有「换手率当前水平」静态阈值，缺少「变化/趋势」维度。
// margin（融资余额变化）：20260823g 起由「市场情绪」因子迁移至此——杠杆资金属资金面范畴，归类更合理；
//   与主结论、换手率变化一并融合（权重 0.10），数值与来源完全沿用 sentiment.margin（与个股分析页一致）。
// volActivity（量能活跃度）：20260909c 起由「市场情绪」因子迁移至此——量能属资金面范畴（同 20260823g 逻辑）；
//   融合权重 0.10，其余权重等比压缩；数值口径与原 sentiment 内实现完全一致（近20日均量比 × 近两日价格方向）。
function factorCapital(capital, turnoverChange, sentiment, quote, history) {
  const c = capital && capital.conclusion;
  if (c && typeof c.signal === 'number') {
    const vp = capital && capital.volumeIndicators && capital.volumeIndicators.volumePrice;
    const mf = capital && capital.moneyFlow && capital.moneyFlow.summary && capital.moneyFlow.summary.summary;
    const estNote = (capital.moneyFlow && capital.moneyFlow.source === 'estimated') ? '（资金流向为接口估算）' : '';
    let detail = '';
    const subs = [];
    // 量能活跃度（20260909c 自市场情绪迁移）：近20日均量比 × 近两日价格方向
    let vol = null;
    if (history && history.length >= 2) {
      const last = history[history.length - 1];
      const vols = history.slice(-20).map(h => h.volume).filter(v => typeof v === 'number' && v > 0);
      if (vols.length >= 5 && last.volume != null) {
        const avgVol = avg(vols);
        const ratio = avgVol > 0 ? last.volume / avgVol : 1;
        const prevClose = history[history.length - 2].close;
        const priceDir = (prevClose != null && last.close != null) ? (last.close - prevClose) : 0;
        // 口径与 vpSigMap、_computeTurnoverChange 保持一致：
        //   放量随价向（放量涨→偏多 / 放量跌→偏空）；缩量反价向且减半（缩量涨→偏空 / 缩量跌→偏多）。
        const volDir = ratio >= 1 ? 1 : -0.5;
        const volSignal = clamp(Math.abs(ratio - 1) * (priceDir >= 0 ? 1 : -1) * volDir, -1, 1);
        const volTxt = ratio >= 1.05 ? '放量' : ratio <= 0.95 ? '缩量' : '量平';
        const toneTxt = volSignal > 0.05 ? '偏多' : volSignal < -0.05 ? '偏空' : '中性';
        vol = { signal: volSignal, ratio, avgVol, lastVol: last.volume, priceDir, volTxt, toneTxt };
      }
    }
    if (vp) {
      detail += `量价：${vp.signal}`;
      // 20260902m：量价主信号已改为当日口径（当日涨跌 × 当日量比），映射同步更新
      const vpSigMap = { '放量上涨': 0.6, '量价齐升': 0.5, '大涨平量': 0, '温和上涨': 0.2, '缩量上涨': -0.2, '地量上涨': -0.1, '放量下跌': -0.6, '量价齐跌': -0.5, '显著下跌': -0.4, '缩量下跌': -0.2, '地量下跌': -0.3, '温和回调': -0.2, '缩量回调': 0.1, '地量回调': 0, '量价平衡': 0 };
      const vpSig = vpSigMap[vp.signal] != null ? vpSigMap[vp.signal] : 0;
      subs.push({ name: '量价配合', signal: vpSig, value: vp.signal, detail: vp.description || vp.signal });
    }
    if (vol) {
      subs.push({ name: '量能活跃度', signal: vol.signal, value: `量比≈${round(vol.ratio, 2)}`, detail: `近20日均量 ${round(vol.avgVol, 0)}，最新 ${round(vol.lastVol, 0)}，量比≈${round(vol.ratio, 2)}（近两日价格${vol.priceDir >= 0 ? '走强' : '走弱'}·${vol.volTxt} → ${vol.toneTxt}）` });
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
      signal = vol
        ? clamp(0.70 * c.signal + 0.11 * turnoverChange.signal + 0.09 * clamp(margin.signal, -1, 1) + 0.10 * vol.signal, -1, 1)
        : clamp(0.78 * c.signal + 0.12 * turnoverChange.signal + 0.10 * clamp(margin.signal, -1, 1), -1, 1);
    } else if (tcOk) {
      signal = vol
        ? clamp(0.78 * c.signal + 0.12 * turnoverChange.signal + 0.10 * vol.signal, -1, 1)
        : clamp(0.85 * c.signal + 0.15 * turnoverChange.signal, -1, 1); // 仅换手率：维持原 0.85/0.15 权重
    } else if (margin) {
      signal = vol
        ? clamp(0.79 * c.signal + 0.11 * clamp(margin.signal, -1, 1) + 0.10 * vol.signal, -1, 1)
        : clamp(0.86 * c.signal + 0.14 * clamp(margin.signal, -1, 1), -1, 1);
    } else if (vol) {
      signal = clamp(0.90 * c.signal + 0.10 * vol.signal, -1, 1);
    }
    if (vol) detail += `；量能活跃度：量比≈${round(vol.ratio, 2)}（${vol.volTxt} → ${vol.toneTxt}）`;
    if (tcOk) {
      detail += `；换手率变化：${turnoverChange.detail}`;
      const tcLabel = turnoverChange.signal > 0.05 ? '放量偏多' : turnoverChange.signal < -0.05 ? '放量偏空' : '量价平稳';
      subs.push({ name: '换手率变化', signal: turnoverChange.signal, value: tcLabel, detail: turnoverChange.detail });
    }
    if (margin) {
      detail += `；融资余额：${margin.changePct >= 0 ? '+' : ''}${round(margin.changePct, 2)}%`;
      subs.push({ name: '融资余额', signal: clamp(margin.signal, -1, 1), value: `${margin.changePct >= 0 ? '+' : ''}${round(margin.changePct, 2)}%`, detail: `沪深融资余额最新 ${round(margin.latest, 0)} 亿，较前值 ${margin.changePct >= 0 ? '+' : ''}${round(margin.changePct, 2)}%（${margin.note || ''}）` });
    }
    return { key: 'capital', name: '资金量能', weight: W_CAPITAL, signal, applicable: true, value: c.label, detail, subFactors: subs };
  }
  return { key: 'capital', name: '资金量能', weight: W_CAPITAL, signal: 0, applicable: true,
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
    return { key: 'futures', name: '对标期货短期走势', weight: W_FUTURES, signal, applicable: true, value, detail, subFactors: subs };
  }
  return { key: 'futures', name: '对标期货短期走势', weight: W_FUTURES, signal: 0, applicable: false,
    value: '不适用', detail: '该公司无直接对标期货，本因子不参与打分' };
}

// 4) 大盘及行业板块指数短期走势：大盘平均涨跌幅 + 所属行业板块整体涨跌
// 20260905d：大盘指数部分改为「按个股市场筛选」+ 联动首页大盘技术分析模块的短期研判结论。
// 20260905e：进一步修复"按市场一刀切"bug——上证50/创业板指/沪深300 都按真实成分股判定。
//   例如：士兰微 600460 → 上证指数(沪市全有) + 沪深300(在 300 名单) → 不取上证50(不在 50 名单)。
//   又如：海天味业 603288 → 上证指数(沪市) + 上证50(在 50 名单) + 沪深300(在 300 名单)。
//   所属行业板块（sector）的逻辑完全保留不动（用户明确要求不改）。
async function selectMarketIndicesByStock(cnArr, symbol) {
  const all = (cnArr || []).filter(c => c && typeof c.changePct === 'number');
  if (!all.length) return { indices: [], scopeLabel: '—', marketLabel: '' };
  const m = detectMarket(symbol);
  const ex = m && m.exchange;
  // 非 A 股（HK/US/BJ）：兜底全宽基，不做精确映射
  if (ex !== 'SH' && ex !== 'SZ') {
    return { indices: all, scopeLabel: '上证/深成指/创业板/沪深300/上证50/中证500/科创50（个股非 A 股，退回全宽基）', marketLabel: ex || 'OTHER' };
  }
  // A 股：按个股真实成分股筛（lib/indexConstituents.pickIndicesForStock）
  let picked;
  try {
    picked = await pickIndicesForStockReal(symbol, all);
  } catch (e) {
    console.warn('[MarketShort] pickIndicesForStock failed:', e.message);
    return { indices: all, scopeLabel: '成分股查询失败，退回全宽基', marketLabel: ex };
  }
  if (!picked.indices.length) {
    return { indices: all, scopeLabel: picked.scopeLabel + '（个股不在任一宽基，已回退全宽基）', marketLabel: ex };
  }
  return picked;
}

// 把首页大盘技术分析模块的短期研判结论映射为数值信号：看多→+1 / 看空→-1 / 震荡→0
// （20260917i：原文件此处重复定义了两次，本次一并收敛为一份）
function shortDirectionToSignal(direction) {
  if (direction === '看多') return 1;
  if (direction === '看空') return -1;
  return 0;
}

// ===== 20260917i：「大盘及行业板块短期走势」因子按用户要求拆分删除 =====
// 因子本体（key='market'）不再存在（FACTOR_KEYS 已移除），其两个子因子迁入其他卡片：
//   · 「大盘短期走势」                        → 「大盘」卡片（原「市场情绪与消息面」）；
//   · 「行业板块」改名「行业短期走势」        → 「行业板块」卡片（原「板块涨跌停占比」）。
// 取数与口径与原因子完全一致：按个股真实成分股筛宽基指数 + 联动首页大盘技术分析的短期研判。
// 返回的子因子带 w（子权重），在目标因子内归一化后参与评分（用户确认「参与评分」）。
function computeMarketShortSub(stockCtx) {
  const picked = (stockCtx && stockCtx.selectedIndices) || [];
  const techIndices = (stockCtx && stockCtx.techIndices) || [];
  const scopeLabel = (stockCtx && stockCtx.scopeLabel) || '—';
  const cnAvg = picked.length ? avg(picked.map(c => (c.changePct != null ? c.changePct : 0))) : 0;
  const techByName = new Map();
  for (const t of techIndices) { if (t && t.name) techByName.set(t.name, t); }
  const techPicks = picked.map(idx => {
    const tech = techByName.get(idx.name);
    if (!tech || !tech.step6 || !tech.step6.shortTerm) return null;
    return { name: idx.name, direction: tech.step6.shortTerm.direction };
  }).filter(Boolean);
  const techSigSum = techPicks.reduce((s, p) => s + shortDirectionToSignal(p.direction), 0);
  const techSigAvg = techPicks.length ? techSigSum / techPicks.length : 0;
  const techVerdict = techSigAvg > 0.34 ? '看多' : techSigAvg < -0.34 ? '看空' : '震荡';
  const techDetail = techPicks.length
    ? techPicks.map(p => `${p.name}${p.direction}`).join('、')
    : '暂未提供与该股同市场的短期研判';
  const signal = clamp(techSigAvg, -1, 1);
  const detail = techPicks.length
    ? `${scopeLabel} 短期研判：${techDetail} → 综合 ${techVerdict}；该股市场口径平均涨跌 ${cnAvg >= 0 ? '+' : ''}${round(cnAvg)}%`
    : '暂未提供与该股同市场的短期研判，按中性处理';
  return {
    verdict: techVerdict,
    signal,
    sub: { name: '大盘短期走势', w: MARKET_SHORT_SUB_W, signal, value: techVerdict, detail },
  };
}

// 「行业短期走势」（20260917i：原「行业板块」子因子改名并迁入「行业板块」卡片）——所属行业板块当日整体涨跌。
function computeSectorTrendSub(sector) {
  const secOk = !!(sector && sector.ok && typeof sector.boardChange === 'number');
  const secChg = secOk ? sector.boardChange : 0;
  const up = secOk ? sector.upCount : null;
  const down = secOk ? sector.downCount : null;
  const signal = secOk ? clamp(secChg / 2, -1, 1) : 0;
  const board = secOk ? (sector.boardName || sector.industryName || '行业板块') : '行业板块';
  const detail = secOk
    ? `${board} ${secChg >= 0 ? '+' : ''}${round(secChg)}%（涨 ${up}/跌 ${down}）`
    : '行业板块走势数据暂缺，按中性处理';
  return {
    signal,
    sub: { name: '行业短期走势', w: SECTOR_TREND_SUB_W, signal, value: secOk ? `${secChg >= 0 ? '+' : ''}${round(secChg)}%` : '—', detail },
  };
}

// 「市场情绪提醒」（20260917i 新增，替代被删除的「消息情绪（大盘）」）——
// 直接引用首页「市场情绪提醒」卡片的判断：读 lib/marketEmotionModel 落盘的当日记录，
// 与首页 /api/sentiment-turning-point 同源（规则一·指标级单源），个股页不重算。
function computeMarketEmotionSub() {
  let emo = null;
  try { emo = marketEmotionModel.readLatestJudgment(); } catch (e) { emo = null; }
  if (!emo || typeof emo.score !== 'number') {
    return { name: '市场情绪提醒', w: EMOTION_SUB_W, signal: 0, value: '—',
      detail: '首页「市场情绪提醒」暂无当日判断（先在首页刷新一次即可），按中性处理' };
  }
  const sig = clamp(emo.score, -1, 1);
  const level = Math.abs(sig) >= 0.5 ? '强烈预警' : Math.abs(sig) >= 0.2 ? '预警' : '关注';
  const dateNote = emo.date ? `（${emo.date}）` : '';
  const drv = emo.coreDriver ? `；核心驱动：${emo.coreDriver}` : '';
  const vols = emo.volumeState ? `；${emo.volumeState}` : '';
  const tips = emo.advice ? `；操作建议：${emo.advice}` : '';
  return {
    name: '市场情绪提醒', w: EMOTION_SUB_W, signal: sig,
    value: `${emo.tendency || '震荡'} · ${level}`,
    detail: `引用首页「市场情绪提醒」判断${dateNote}：情绪总分 ${sig >= 0 ? '+' : ''}${sig}（${level}）→ 倾向 ${emo.tendency || '震荡'}${drv}${vols}${tips}。与首页同源、不重复计算。`,
  };
}

// 「舆情与讨论热度（个股）」（20260917i：由「大盘」卡片迁至「个股短期动向」）——
// Part B 单只 A 股个股全网舆情分析确定性模块（lib/stockSentiment）：
//   消费 同花顺讨论帖(stockDiscussion) + 东财/同花顺/雪球热度(discussionHeat) + 个股新闻(newsSentiment)，
//   并按行情/主力资金/换手率做四路交叉校验 → 综合分 + 热度等级 + 情绪标签 + 告警。
//   保留旧逻辑兜底：buildStockSentiment 不可用时卡片仍可展示基础舆情。
function computeStockSentimentSub(sentiment, quote, symbol, capital, turnoverChange) {
  let stockSent = null;
  try {
    stockSent = buildStockSentiment({
      symbol,
      name: (quote && quote.name) || symbol,
      quote,
      capital,
      turnoverChange,
      newsSentiment: sentiment && sentiment.newsSentiment,
      discussionHeat: sentiment && sentiment.discussionHeat,
      stockDiscussion: sentiment && sentiment.stockDiscussion,
    });
  } catch (e) {
    console.warn('[SameDayJudgment] buildStockSentiment failed:', e.message);
  }
  if (stockSent && stockSent.ok) {
    const dirWord = stockSent.signal > 0.12 ? '利好' : (stockSent.signal < -0.12 ? '利空' : '中性');
    const ind = stockSent.indicators || {};
    const nm = stockSent.norm || {};
    const rawTxt = `原始指标 A曝光 ${ind.A != null ? ind.A : '—'}｜B讨论 ${ind.B != null ? ind.B : '—'}｜C散户 ${ind.C != null ? ind.C : '—'}｜D专业情感 ${ind.D != null ? ind.D + '%' : '—'}｜E社区情感 ${ind.E != null ? ind.E + '%' : '—'}`;
    const normTxt = `归一化 B ${nm.B != null ? nm.B : '—'}｜C ${nm.C != null ? nm.C : '—'}｜D ${nm.D != null ? nm.D : '—'}｜E ${nm.E != null ? nm.E : '—'}（样本 ${stockSent.sample} 帖）`;
    const crossTxt = (stockSent.crossTags && stockSent.crossTags.length) ? `；交叉校验：${stockSent.crossTags.join('、')}` : '';
    const alertTxt = stockSent.alert && stockSent.alert.on ? `；${stockSent.alert.text}` : '';
    const br = stockSent.brief || {};
    const kwParts = [];
    if (br.posKeywords && br.posKeywords.length) kwParts.push(`看多词：${br.posKeywords.join('/')}`);
    if (br.negKeywords && br.negKeywords.length) kwParts.push(`看空词：${br.negKeywords.join('/')}`);
    if (br.coreEvent) kwParts.push(`焦点帖：${br.coreEvent}`);
    const degradeTxt = (stockSent.degrade && stockSent.degrade.length) ? `；口径说明：${stockSent.degrade.join('；')}` : '';
    return {
      name: '舆情与讨论热度（个股）', w: STOCK_SENT_SUB_W, signal: clamp(stockSent.signal, -1, 1),
      value: `${stockSent.heatLevel}·${stockSent.sentimentTag}·${dirWord}`,
      detail: `${stockSent.conclusion}；${rawTxt}；${normTxt}${crossTxt}${alertTxt}${kwParts.length ? '；' + kwParts.join('；') : ''}${degradeTxt}`,
    };
  }
  const hasNews = !!(sentiment && sentiment.newsSentiment && sentiment.newsSentiment.ok);
  const hasHeat = !!(sentiment && sentiment.discussionHeat && sentiment.discussionHeat.ok);
  if (!hasNews && !hasHeat) return null;
  const ns = sentiment.newsSentiment;
  const dh = sentiment.discussionHeat;
  const eng = ns && ns.engine === 'finance-model' ? '金融微调模型' : 'snownlp+词库';
  const score = ns && ns.ok ? (ns.weightedAvgScore != null ? ns.weightedAvgScore : ns.avgScore) : null;
  let heatValue = '';
  let heatDetail = '';
  let heatSignal = 0;
  if (dh && dh.ok) {
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
  const newsValue = ns && ns.ok ? `利好 ${ns.positive}/中性 ${ns.neutral}/利空 ${ns.negative}` : '';
  const newsDetail = ns && ns.ok
    ? `近 ${ns.count} 条个股新闻（${eng}），积极 ${ns.positive}/中性 ${ns.neutral}/消极 ${ns.negative}，加权情感均值 ${score != null ? round(score * 100) : '—'}（${ns.note || ''}）`
    : '';
  const subSignal = (hasNews && hasHeat)
    ? clamp(0.5 * clamp(ns.signal, -1, 1) + 0.5 * heatSignal, -1, 1)
    : (hasNews ? clamp(ns.signal, -1, 1) : heatSignal);
  return {
    name: '舆情与讨论热度（个股）', w: STOCK_SENT_SUB_W, signal: subSignal,
    value: [newsValue, heatValue].filter(Boolean).join(' | '),
    detail: [newsDetail, heatDetail].filter(Boolean).join('；'),
  };
}

// 「板块消息」（20260917i：由「大盘」卡片迁至「行业板块」卡片）——
// 板块/赛道级新闻情绪 → 个股传导（解决"个股新闻源抓不到板块级催化"）。
function computeSectorNewsSub(sectorNews) {
  if (!(sectorNews && sectorNews.ok && typeof sectorNews.signal === 'number')) return null;
  const sn = sectorNews;
  const evtTxt = (sn.eventBoosted && sn.events && sn.events.length)
    ? `；重大事件：${sn.events.slice(0, 2).map(e => e.title).join('、')}`
    : '';
  return {
    name: '板块消息', w: SECTOR_NEWS_SUB_W, signal: clamp(sn.signal, -1, 1),
    value: `利好 ${sn.positive}/利空 ${sn.negative}${sn.eventBoosted ? ' · 重大事件' : ''}`,
    detail: `板块/赛道消息 ${sn.count} 条（关键词：${(sn.keywords || []).slice(0, 3).join('、')}），利好 ${sn.positive}/利空 ${sn.negative}，情绪均值 ${sn.avgScore != null ? (sn.avgScore >= 0 ? '+' : '') + sn.avgScore : '—'}${evtTxt}`,
  };
}


// 5) 公司近期重大利好/利空（20260823i 起并入「市场情绪」因子，作为其三个子信号）：
//    消息情绪（大盘）+ 财报解读 + A股内幕抢跑提前反应。
//    返回可被 factorSentiment 直接并入的 parts（含子权重 w），而非独立因子。
//    财报判断优先用 cn-financial-scraper 的「定期报告解读」（interpret_stock），缺失时回退 quote.fundamentals 增速。
function computeNewsFactor(news, quote, history, report, symbol, marketSentiment) {
  const parts = [];
  let value = '—';
  // 20260922：内幕抢跑预警已迁移至事件驱动引擎（eventEngine.checkInsiderFrontRun），
  // 改为"仅个股/板块相关事件出现时联动触发"；本函数不再承担抢跑逻辑（原 §5.3 整体移除）。

  // 5.1 消息情绪（大盘）—— 20260917i 已按用户要求删除（子卡片 + 底层逻辑）。
  //     原实现：取东财股吧全市场聚合（marketHeat / 上升家数占比 / 全市场得分均值）并计分。
  //     现由「大盘」卡片内新增的「市场情绪提醒」子因子直接引用首页判断替代（规则一·指标级单源）。
  let earnSub = null;

  // 5.2 财报解读 —— 20260917i：按用户要求迁至「个股短期动向」卡片。
  //     本函数只负责产出 earnSub 返回给调用方，不再并入「大盘」因子。
  //     联动深度分析「最新财报解读」：优先消费同一份 AI 联网缓存，确保规则一·数据一致性；
  //     缺失时回退 cn-financial-scraper 评级 + 披露增速。量化信号始终以披露同比增速为准（规则三）。
  const f = quote && quote.fundamentals;
  const norm = (v) => (v != null && Math.abs(v) < 1 ? v * 100 : v);
  const pgN = norm(f && (f.profitYoy != null ? f.profitYoy : f.earningsGrowth));
  const rgN = norm(f && (f.revenueYoy != null ? f.revenueYoy : f.revenueGrowth));
  const repOk = report && report.ok && typeof report.score === 'number' && report.score > 0
    && report.rating && report.rating !== '数据不足';
  // 联动：读取与个股深度分析同源的「最新财报解读」缓存（单一权威源，避免双源各说各话）
  let deepEarnings = null;
  try { deepEarnings = readEarningsCache(symbol); } catch {}
  // 20260906b：缓存 promptVersion 过期（stale=true）时不引用其旧文，回退 scraper 评级分支
  const deepSummaryOk = !!(deepEarnings && !deepEarnings.stale && typeof deepEarnings.summary === 'string' && deepEarnings.summary.trim().length > 0);
  if (deepSummaryOk) {
    // 信号以 AI 深度解读的实质结论为准，而非仅看同比增速
    const earnSignal = (typeof deepEarnings.earningsSignal === 'number')
      ? deepEarnings.earningsSignal
      : extractEarningsSignal(deepEarnings.summary);
    const earnLabel = earnSignal > 0.15 ? '向好' : earnSignal < -0.15 ? '承压' : '中性';
    const verdictTxt = (deepEarnings.verdict && deepEarnings.verdict.trim()) ? deepEarnings.verdict.trim() : '';
    const yoyTxt = (pgN != null) ? '；净利同比 ' + (pgN >= 0 ? '+' : '') + round(pgN) + '%' : (rgN != null ? '；营收同比 ' + (rgN >= 0 ? '+' : '') + round(rgN) + '%' : '');
    const head = `最新财报解读（联动深度分析）：${earnLabel}${yoyTxt}`;
    // 小卡只引用精简结论（verdict 一句话），详细正文只在深度分析卡展示
    earnSub = { name: '财报解读', w: EARN_SUB_W, signal: clamp(earnSignal, -1, 1), value: '联动深度解读', detail: head + (verdictTxt ? '；' + verdictTxt : '') };
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
    earnSub = { name: '财报解读', w: EARN_SUB_W, signal: clamp(earnSignal, -1, 1), value: `评级 ${report.rating}`,
      detail: `最新财报（回退·定期报告评级）：评级 ${report.rating}${yoy != null ? '，净利/营收同比 ' + (yoy >= 0 ? '+' : '') + round(yoy) + '%' : ''}（${earnLabel}）${highlightTxt}${riskTxt}` };
  } else if (pgN != null || rgN != null) {
    const earnSignal = (pgN != null) ? clamp(pgN / 30, -1, 1) : clamp(rgN / 30, -1, 1);
    const earnTxt = pgN != null ? `净利增速 ${pgN >= 0 ? '+' : ''}${round(pgN)}%` : `营收增速 ${rgN >= 0 ? '+' : ''}${round(rgN)}%`;
    const earnLabel = earnSignal > 0.15 ? '增长/超预期' : earnSignal < -0.15 ? '下滑/低于预期' : '符合预期';
    earnSub = { name: '财报解读', w: EARN_SUB_W, signal: clamp(earnSignal, -1, 1), value: earnTxt, detail: `最新财报：${earnTxt}（${earnLabel}）` };
  }


  // 20260922：原 §5.3 内幕抢跑预警已整体迁移至事件驱动引擎（lib/eventEngine.js · checkInsiderFrontRun），
  // 改为"仅个股/板块相关事件出现时，回溯事件前 3 日涨跌幅"触发，不再在大盘/市场情绪因子内无条件计算。

  if (!parts.length) {
    // 无消息/财报数据：给一个中性占位，保证市场情绪"消息面"子卡可见
    parts.push({ name: '消息面', w: 0.05, signal: 0, value: '—', detail: '未检索到近期重大消息与财报信号，按中性处理' });
  }
  return { parts, value, earnSub };
}

// ===== 报告期工具（20260913g 修订）=====
// 十大股东 / 十大流通股东除季度末（03-31 / 06-30 / 09-30 / 12-31）定期披露外，
// 东财对「非季度末的权益变动 / 临时公告」也会给完整 10 行（如海天味业 2026-07-03，
// 比最近季度末 2026-06-30 更新）。因此标注改为以「该期是否为最新可得披露」为准：
// 非季度末的完整 10 行披露 = 最新数据，不得误标为「非最新季报期」。
// 返回「当前应当可披露的最近一个季度末」（≤ 今天的最大季度末），用于季度末口径的新鲜度对照。
function latestQuarterEnd(now = new Date()) {
  const y = now.getFullYear();
  const today = localDate(now);
  const cands = [];
  for (const yy of [y - 1, y]) {
    cands.push(`${yy}-03-31`, `${yy}-06-30`, `${yy}-09-30`, `${yy}-12-31`);
  }
  const ok = cands.filter(d => d <= today).sort();
  return ok.length ? ok[ok.length - 1] : '';
}

// 6) 股票增持减持：前十大股东实际持股变动 + 股份回购。
// 20260823h 修复：东财对实际变动股东返回数值股数（仅「不变」返回文本），原代码只做
// 文本正则导致所有数值变动被误判为「不变」。现按 changeAmount 符号定量判定，并引入
// 净变动股数/净变动占比作为信号强度；同时在文案中标注数据报告期。
// 20260913f：① 因子与「增减持家数」子卡片均显式标注数据报告期（此前仅父因子 detail 有、
//   子卡片无，用户无法判断数据新旧）；② 因子级 caption 标注报告期 + 是否最新季报期 + 来源。
// 20260922h：股东「被动减持 / 司法强制执行」检测（公告/新闻驱动，实时，不依赖 F10 季报滞后）
// 为什么走公告流而非 F10：东财前十大股东只给「增持/减持」方向、不带原因；法院强制执行/被动
// 减持 = 股东陷入平仓/债务困境，是比自愿减持更强的利空；且 9 月事件要等 Q3(09-30) 披露才进 F10，
// 故性质检测必须复用项目已有的 allAnnouncements/stockNews（回购即复用此流），实时显形。
function _forcedMatchName(title, names) {
  for (const n of (names || [])) if (n && title.indexOf(n) !== -1) return n;
  return null;
}
function detectForcedReduction(announcements, news, shareholderNames, companyName) {
  // 20260922h：正则自包含（运行时不依赖模块级常量，亦便于单元测试 sandbox eval 复用）
  // 20260922i：扩展覆盖真实公告措辞——东财真实标题多含「部分股份执行完成的结果公告」「拟被司法强制执行」
  //   （旧 FORCED_RE 仅命中「司法强制执行/被动减持」等强词，对「执行完成的结果公告」这类已发生类完全漏判）。
  const FORCED_RE = /(司法强制执行|法院强制执行|被动减持|强制减持|强制平仓|司法拍卖|被司法|裁定强制执行|强制执行.*减持|减持.*(司法|法院|强制)|司法冻结|轮候冻结|司法执行|执行完成|执行完毕|变价处置|强制变价|部分股份.*(执行|冻结|拍卖)|已减持部分股份)/;
  const FORCED_ROLE_RE = /(二股东|第二大股东|大股东|控股股东|持股5%以上股东|5%以上股东|重要股东|原持股5%以上股东|持股5%以上)/;
  // 已实际发生减持/拍卖成交/执行完成（确认利空 -0.8）vs 仅冻结/拍卖预告（未来强平风险 -0.6）
  const FORCED_CONFIRMED_RE = /(被动减持|司法强制执行.*减持|强制平仓|已减持|减持.*(司法|法院|强制)|司法拍卖.*成交|拍卖成交|执行完成|执行完毕|已执行|司法强制执行.*完成|强制变价.*成交|已减持部分股份)/;
  // 20260922i：排除利好/中性语境下的「执行完成」，避免把增持计划、回购实施完成误判为司法强减
  const FORCED_EXCLUDE_RE = /(增持计划执行|回购.*(完成|实施完成|期限届满)|股权激励.*完成|员工持股.*完成|向特定对象发行.*完成|非公开发行.*完成|可转债.*完成|配股.*完成|发行.*完成)/;
  const items = [];
  if (Array.isArray(announcements)) for (const a of announcements) if (a && a.title) items.push({ title: a.title, date: a.date || '', src: '公告' });
  if (Array.isArray(news)) for (const n of news) if (n && n.title) items.push({ title: n.title, date: n.date || '', src: '新闻' });
  const events = [];
  for (const it of items) {
    const t = it.title;
    if (FORCED_EXCLUDE_RE.test(t)) continue; // 利好/中性语境，直接跳过
    if (!FORCED_RE.test(t)) continue;
    const nameHit = _forcedMatchName(t, shareholderNames);
    const roleHit = FORCED_ROLE_RE.test(t);
    const companyHit = companyName && t.indexOf(companyName) !== -1;
    // 必须能定位到本股股东：姓名命中，或带角色词且含公司名/股东语境——避免误抓别家公司的司法拍卖
    if (!nameHit && !(roleHit && (companyHit || t.indexOf('股东') !== -1))) continue;
    const confirmed = FORCED_CONFIRMED_RE.test(t);
    events.push({ name: nameHit || (roleHit ? '二/大股东' : ''), title: t, date: it.date, src: it.src, confirmed,
      reason: confirmed ? '司法强制执行/被动减持/执行完成（已发生）' : '司法冻结/拍卖/拟被强制执行（未来强平风险）' });
  }
  const seen = new Set(); const uniq = [];
  for (const e of events) { const k = e.title + '|' + (e.name || ''); if (!seen.has(k)) { seen.add(k); uniq.push(e); } }
  if (!uniq.length) return { events: [], signal: 0, confirmed: false };
  const confirmed = uniq.some(e => e.confirmed);
  return { events: uniq, signal: confirmed ? -0.8 : -0.6, confirmed };
}

function factorHoldings(shareholders, buyback, opts) {
  const top = (shareholders && Array.isArray(shareholders.topShareholders)) ? shareholders.topShareholders : [];
  const reportDate = top[0]?.endDate || '';
  // 20260913f：报告期标注（子卡片 + 因子 caption + 父因子 detail 同源），显式区分「最新季报期 / 非最新季报期」
  // 20260913g：非季度末的完整 10 行披露（如 2026-07-03）比最近季度末更新 → 按「是否最新可得披露」判定，
  //   不再拿「是否等于最近季度末」当唯一尺度，否则会把更新的数据误标成「非最新季报期」。
  const expectQ = latestQuarterEnd();
  const isQEnd = /-(03-31|06-30|09-30|12-31)$/.test(reportDate);
  const isLatest = !!reportDate && (!expectQ || reportDate >= expectQ);
  const periodTag = reportDate
    ? (isQEnd
        ? `${reportDate}（${isLatest ? '最新季报期' : `非最新季报期，最新可披露 ${expectQ || '—'}`}）`
        : `${reportDate}（最新披露·非季度末）`)
    : '未知';
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
  // 20260921j：优先用东财结构化回购数据（buyback.structured）——
  //   旧口径把新闻标题原文当 detail，用户看不到「已回购数量/金额、承诺金额、进度」；
  //   新口径四要素固定为：数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度。
  const buybackOk = buyback && buyback.ok && buyback.count > 0;
  // 20260921k（用户要求）：回购「完成实施」后判定转为中性。
  //   逻辑依据：回购的偏多力量来自"尚未买入的承诺资金"（未来买入预期）；一旦完成实施，
  //   承诺资金已花完，后续不再有增量买盘 → 对后续股价不再构成利好，按中性处理（signal=0，
  //   且不再计入利好侧家数 buybackExtra）。停止实施/股东大会否决同样归中性。
  //   兑现路径：lib/buybackEmDc.js 的 gradeSignal() 按 REPURPROGRESS 给出 signal/neutral/stage；
  //   非结构化（标题扫描兜底）拿不到进度 → 保持旧口径 +1 家，避免误判。
  const buybackPlan = (buyback && buyback.structured && buyback.plan) ? buyback.plan : null;
  const buybackGrade = (buybackPlan && typeof buybackPlan.signal === 'number') ? buybackPlan : null;
  const buybackNeutral = !!(buybackGrade && buybackGrade.neutral);
  const buybackSignal = buybackGrade ? clamp(buybackGrade.signal, -1, 1) : clamp(0.6, -1, 1);
  const buybackExtra = (buybackOk && !buybackNeutral) ? 1 : 0;
  const buybackIsStructured = !!(buyback && buyback.structured && buyback.text);
  // 结构化：直接用四要素文案；标题扫描兜底：保留旧文案格式（明示"来自新闻标题，缺明细"）
  let buybackText = '';
  if (buybackOk) {
    if (buybackIsStructured) {
      buybackText = `；股份回购 ${buyback.text}`;
    } else {
      buybackText = `；股份回购 ${buyback.count} 次${buyback.latest ? `（最近：${buyback.latest}）` : ''}${buyback.titles && buyback.titles.length ? `：${buyback.titles.slice(0, 2).join('、')}` : ''}`;
    }
  }

  const total = inc + dec + flat + buybackExtra;
  // 若无任何股东数据但有回购，给出独立偏多信号；否则融合家数方向与净变动幅度
  let signal;
  if (total === 0) {
    signal = 0;
  } else if (top.length === 0 && buybackOk) {
    signal = buybackNeutral ? 0 : clamp(0.6, -1, 1); // 仅回购、无股东数据：完成实施时按中性，否则明确偏多
  } else {
    const directionSignal = clamp((inc - dec + buybackExtra) / total, -1, 1);
    signal = clamp(0.55 * directionSignal + 0.45 * magnitudeSignal, -1, 1);
  }

  // 20260922h：股东被动减持/司法强制执行（公告/新闻驱动，实时，不依赖 F10）
  const forced = detectForcedReduction(
    (opts && opts.announcements) || [],
    (opts && opts.news) || [],
    top.map(h => h.name),
    opts && opts.companyName,
  );
  // 困境溢价：确认被动减持 -0.8 / 司法冻结拍卖预告 -0.6；forced=0 时本行恒为 0（向后兼容，旧校准不动）
  if (forced.signal < 0) signal = clamp(signal + 0.2 * forced.signal, -1, 1);

  const dateNote = reportDate ? `（数据报告期：${periodTag}）` : '';
  const netChangeText = `${netChangeShares >= 0 ? '+' : ''}${formatWan(netChangeShares)}股`;
  const netChangePct = (netChangeRatio * 100).toFixed(2);
  const detail = `前十大股东中，增持/新进 ${inc} 家${incNames.length ? `（${incNames.slice(0, 3).join('、')}${incNames.length > 3 ? '等' : ''}）` : ''}、减持 ${dec} 家${decNames.length ? `（${decNames.slice(0, 3).join('、')}${decNames.length > 3 ? '等' : ''}）` : ''}、其余 ${flat} 家不变；十大股东合计净变动 ${netChangeText}（占其持股 ${netChangePct}%）${dateNote}` + buybackText;
  // 因子取值：结构化回购用精简四要素（不再只写"回购 N 次"，让折叠态就能看到关键数据）
  const buybackValue = buybackOk
    ? (buybackIsStructured ? buyback.text : `回购 ${buyback.count} 次`)
    : '';
  const value = `增持 ${inc}/减持 ${dec}/净变动 ${netChangeText}${buybackOk ? (buybackIsStructured ? '；回购：' + buyback.text : '/回购 ' + buyback.count) : ''}`;

  const countSignal = top.length ? clamp((inc - dec) / top.length, -1, 1) : 0;
  const subs = [
    { name: '十大股东净变动', signal: magnitudeSignal, value: netChangeText, detail: `数据报告期 ${periodTag}；前十大股东合计净变动 ${netChangeText}，占其合计持股 ${netChangePct}%；其中增持 ${formatWan(totalIncreaseShares)}股、减持 ${formatWan(totalDecreaseShares)}股` },
    { name: '增减持家数', signal: countSignal, value: `增持 ${inc}/减持 ${dec}`, detail: `数据报告期 ${periodTag}；前十大股东增持/新进 ${inc} 家、减持 ${dec} 家、不变 ${flat} 家${incNames.length ? `（增持：${incNames.slice(0, 3).join('、')}${incNames.length > 3 ? '等' : ''}）` : ''}${decNames.length ? `（减持：${decNames.slice(0, 3).join('、')}${decNames.length > 3 ? '等' : ''}）` : ''}` },
  ];
  if (buybackOk) {
    // 20260921j：四要素文案（数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度）。
    // 结构化源下 value 与 detail 同源同值；标题扫描兜底时明示"仅由标题识别、无明细"。
    // 20260921k：进度为"完成实施/停止实施/被否决"时，signal 归 0 并在 detail 末尾标注「按中性处理」。
    const subDetail = buybackIsStructured
      ? `${buyback.text}；来源：东方财富·股票回购（数据中心报表）${buybackNeutral ? `；⚠ ${buybackGrade.signalReason || '回购已结束'}，按中性处理` : ''}`
      : `股份回购 ${buyback.count} 次${buyback.latest ? `（最近：${buyback.latest}）` : ''}${buyback.titles && buyback.titles.length ? `：${buyback.titles.slice(0, 2).join('、')}` : ''}；来源：公告/新闻标题识别（未取到东财回购明细）`;
    subs.push({ name: '股份回购', signal: buybackSignal, value: buybackValue, detail: subDetail, stage: buybackGrade ? buybackGrade.stage : '' });
  } else {
    subs.push({ name: '股份回购', signal: 0, value: '无', detail: '未检索到股份回购记录，按中性处理' });
  }
  // 20260922h：第④子模块 股东被动减持/司法强制执行（实时，独立于 F10 季报滞后）
  if (forced.events.length) {
    subs.push({
      name: '股东被动减持',
      signal: forced.signal,
      value: forced.events.map(e => `${e.name || '股东'}·${e.confirmed ? '被动减持' : '司法冻结/拍卖'}`).join('、'),
      detail: `来源：公告/新闻（实时，非 F10 季报滞后）${forced.confirmed ? '；⚠ 已发生司法强制执行/被动减持，属股东平仓/债务困境信号，利空强于普通减持' : '；司法冻结/拍卖预告，存在未来强制减持风险'}${opts && opts.companyName ? `；关联公司：${opts.companyName}` : ''}；样例：${forced.events.slice(0, 2).map(e => e.title).join('；')}`,
      stage: forced.confirmed ? '司法执行' : '司法风险',
    });
  } else {
    subs.push({ name: '股东被动减持', signal: 0, value: '无', detail: '未检索到股东司法强制执行/被动减持公告，按中性处理' });
  }
  return {
    key: 'holdings', name: '增持减持', weight: W_HOLDINGS, signal, applicable: true, value, detail, subFactors: subs,
    // 20260913f：因子级数据日期/来源标注（折叠态也能看到数据报告期，不再"小卡片无日期"）
    caption: `数据报告期：${periodTag} · 来源：东方财富 F10 前十大股东（含前十大流通股东）${forced.confirmed ? ' · ⚠ 检测到股东司法强制执行被动减持（实时）' : ''}`,
  };
}

// 7) 行业板块（20260917i：由「板块涨跌停占比」改名并重组，用户 20260917 要求）
//    保留：板块内涨停/跌停家数占成分股总数的比例（板块情绪量化，原口径不变），
//          数据来自 lib/sectorLimitStats（东财涨停池/跌停池权威判定阈值 + 同花顺板块成分总数）；
//    转入：· 「板块消息」  —— 原「大盘」卡片子因子；
//          · 「行业短期走势」（原「大盘及行业板块短期走势」因子的「行业板块」子因子，改名）。
//    因子信号（用户确认「参与评分」）：
//      涨跌停占比差 × 0.45 + 行业短期走势 × 0.35 + 板块消息 × 0.20
function factorSectorLimit(stats, sector, sectorNewsSub) {
  const limitOk = !!(stats && stats.ok && typeof stats.limitUpRatio === 'number' && typeof stats.limitDownRatio === 'number');
  const limitSig = limitOk ? clamp((stats.limitUpRatio - stats.limitDownRatio) * 20, -1, 1) : 0;
  const secTrend = computeSectorTrendSub(sector);
  const newsSig = (sectorNewsSub && typeof sectorNewsSub.signal === 'number') ? clamp(sectorNewsSub.signal, -1, 1) : 0;
  const signal = round(clamp(LIMIT_SUB_W * limitSig + SECTOR_TREND_SUB_W * secTrend.signal + SECTOR_NEWS_SUB_W * newsSig, -1, 1), 3);

  const subs = [];
  let value = '—';
  let detail;
  if (limitOk) {
    const upR = stats.limitUpRatio;
    const downR = stats.limitDownRatio;
    const upPct = (upR * 100).toFixed(1);
    const downPct = (downR * 100).toFixed(1);
    const board = stats.boardName || stats.industryName || '行业板块';
    detail = `所属「${board}」板块：涨停 ${stats.limitUp} 家（${upPct}%）、跌停 ${stats.limitDown} 家（${downPct}%）、成分 ${stats.total} 家` +
      (limitSig > 0.15 ? ' → 板块情绪偏热（涨停潮）' : limitSig < -0.15 ? ' → 板块情绪偏冷（跌停潮）' : ' → 板块情绪平稳');
    value = `涨停 ${upPct}% / 跌停 ${downPct}%`;
    subs.push({ name: '涨停占比', signal: clamp(upR * 20, -1, 1), value: `${upPct}%`, detail: `所属「${board}」板块涨停 ${stats.limitUp} 家，占成分股 ${upPct}%` });
    subs.push({ name: '跌停占比', signal: clamp(-downR * 20, -1, 1), value: `${downPct}%`, detail: `所属「${board}」板块跌停 ${stats.limitDown} 家，占成分股 ${downPct}%` });
  } else {
    detail = (stats && stats.note) ? stats.note : '板块涨跌停数据不可用，按中性处理';
  }
  // 转入子因子（20260917i）
  subs.push(secTrend.sub);
  if (sectorNewsSub) subs.push(sectorNewsSub);

  return { key: 'sectorLimit', name: FACTOR_NAME.sectorLimit, weight: W_SECTOR_LIMIT, signal, applicable: true, value, detail, subFactors: subs };
}

// 7) 板块跷跷板（科技/半导体负相关）：仅对非科技/半导体个股生效。
//    取科技/半导体板块当日整体涨跌幅（多板块均值）作为 composite，
//    按"反向"映射为个股信号：科技涨 → 其他板块(含该股)跌 → 偏空；科技跌 → 偏多。
//    个股本身属于科技/半导体行业时，即跷跷板中被参照的一方，因子不适用（applicable:false）。
function factorSeesaw(seesaw, isTechStock) {
  if (isTechStock) {
    return {
      key: 'seesaw', name: '科技指数（负相关）', weight: W_SEESAW, signal: 0, applicable: false,
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
      key: 'seesaw', name: '科技指数（负相关）', weight: W_SEESAW, signal: 0, applicable: true,
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
    key: 'seesaw', name: '科技指数（负相关）', weight: W_SEESAW,
    signal: round(signal, 3), applicable: true,
    value: `${composite >= 0 ? '+' : ''}${round(composite, 2)}%`,
    detail, subFactors: subs,
  };
}

// ============ 第 8 因子：个股短期动向（20260905g） ============
// 引用价格行为趋势推演（lib/priceAction.analyzePriceAction，唯一出口 priceActionHub）的 shortTerm 输出，
// 与「技术面分析」页同源且同口径，保证数据一致性（规则一·指标级单源）。
// 20260905g：展示口径与技术面分析页②统一——直接展示原始 7 档方向
// （上行/震荡偏上/震荡/震荡偏下/下行/冲高回落/超跌反弹），不再聚合为三档。
// 子因子 signal 映射（仅用于影响程度展示，不参与总分——总分用主信号 dirScore/3）；
// 档位→信号语义与技术面页 _paVerdictClass 颜色语义一致：冲高回落偏空、超跌反弹偏多。
const SHORT_DIR_SIGNAL = {
  '上行': 1,
  '震荡偏上': 0.5,
  '超跌反弹': 0.5,
  '震荡': 0,
  '震荡偏下': -0.5,
  '冲高回落': -0.5,
  '下行': -1,
};

function factorTechnicalShort(pa, stockSentSub, earnSub) {
  // 20260917i：按用户要求转入「舆情与讨论热度（个股）」与「财报解读」两个子因子（原属「大盘」卡片），
  //   并参与评分（用户确认）：因子信号 = 短期动向预判 × 0.50 + 舆情与讨论热度（个股）× 0.30 + 财报解读 × 0.10（因子内归一化）。
  //   「短期动向预判」取数与口径不变（lib/priceAction.shortTerm，唯一出口 priceActionHub，与技术面分析页同源）。
  const stx = pa && pa.shortTerm ? pa.shortTerm : null;
  const hasShort = !!(stx && typeof stx.dirScore === 'number');

  const parts = [];
  let shortSig = 0;
  if (hasShort) {
    const dirTxt = stx.direction || '震荡';
    const dirSig = SHORT_DIR_SIGNAL[dirTxt] != null ? SHORT_DIR_SIGNAL[dirTxt] : 0;
    shortSig = clamp(round(stx.dirScore, 3) / 3, -1, 1); // dirScore 量级约 ±3.5，/3 限幅到 ±1
    parts.push({
      name: '短期动向预判', w: SHORT_DIR_SUB_W, signal: dirSig, value: dirTxt,
      detail: `与技术面分析页②短期动向预判同一次快照、同一档位展示，概率 ${stx.probability || '—'}。`,
    });
  } else {
    parts.push({
      name: '短期动向预判', w: SHORT_DIR_SUB_W, signal: 0, value: '—',
      detail: '个股短期动向数据不足（K线<60 或价格行为推演未返回短期动向）。来源：价格行为趋势推演（日/60分钟级别），与「技术面分析」页同源。',
    });
  }
  if (stockSentSub) parts.push({ name: stockSentSub.name, w: STOCK_SENT_SUB_W, signal: clamp(stockSentSub.signal || 0, -1, 1), value: stockSentSub.value, detail: stockSentSub.detail });
  if (earnSub) parts.push({ name: earnSub.name, w: EARN_SUB_W, signal: clamp(earnSub.signal || 0, -1, 1), value: earnSub.value, detail: earnSub.detail });

  // 因子主信号：各子因子按 w 归一化加权（「短期动向预判」用 dirScore 口径的 shortSig，其余用自身 signal）
  const wsum = parts.reduce((a, p) => a + p.w, 0) || 1;
  let s = 0;
  for (const p of parts) s += (p.w / wsum) * (p.name === '短期动向预判' ? shortSig : p.signal);
  s = round(clamp(s, -1, 1), 3);

  const dirTxt = hasShort ? (stx.direction || '震荡') : '震荡';
  const extraTxt = parts.filter(p => p.name !== '短期动向预判').map(p => `${p.name} ${p.value}`).join(' | ');
  const detail = hasShort
    ? `个股短期动向（预判：${dirTxt}）：与技术面分析页②短期动向预判同一次快照、同一档位展示（lib/priceAction.shortTerm.direction，唯一出口 priceActionHub），概率 ${stx.probability || '—'}；另含舆情与讨论热度（个股）、财报解读两个子因子（同口径参与评分）。`
    : `个股短期动向数据不足（K线<60 或价格行为推演未返回短期动向）；已用舆情与讨论热度（个股）、财报解读子因子加权。`;
  return {
    key: 'technicalShort', name: FACTOR_NAME.technicalShort, weight: W_TECH_SHORT,
    signal: s, applicable: true,
    value: hasShort ? dirTxt : (extraTxt || '—'),
    detail, subFactors: parts,
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
// ===== 20260917i：因子/子因子权重常量（唯一定义处，因子函数一律引用常量）=====
// 因子权重：删除「大盘及行业板块短期走势」（原 0.114）后，其余 7 因子按原比例等比放大，
// 使 Σ = 1.0000（用户 20260917 确认「等比放大到 100%」）。
// 20260922j：增持减持 +5 个百分点（0.0485→0.0985）、大盘 −5 个百分点（0.3071→0.2571），
// 一增一减、Σ 仍 = 1.0000（用户 20260922 要求）。权重变化由 _hashFactorStructure 自动捕获 → 旧判断强制重算：
//   大盘 0.2571 | 资金量能 0.1783 | 对标期货 0.0971 | 增持减持 0.0985
//   行业板块 0.0801 | 科技指数 0.0632 | 个股短期动向 0.2257
const W_SENTIMENT = 0.2571;
const W_CAPITAL = 0.1783;
const W_FUTURES = 0.0971;
const W_HOLDINGS = 0.0985;
const W_SECTOR_LIMIT = 0.0801;
const W_SEESAW = 0.0632;
const W_TECH_SHORT = 0.2257;
// 子因子权重（在所属因子内归一化后参与该因子评分；用户 20260917 确认「参与评分」）
const MARKET_SHORT_SUB_W = 0.25;  // 「大盘短期走势」在「大盘」因子内
const SECTOR_TREND_SUB_W = 0.35;  // 「行业短期走势」在「行业板块」因子内
const SECTOR_NEWS_SUB_W = 0.20;   // 「板块消息」在「行业板块」因子内
const LIMIT_SUB_W = 0.45;         // 涨跌停占比差在「行业板块」因子内
const EMOTION_SUB_W = 0.25;       // 「市场情绪提醒」在「大盘」因子内
const STOCK_SENT_SUB_W = 0.30;    // 「舆情与讨论热度（个股）」在「个股短期动向」因子内
const EARN_SUB_W = 0.10;          // 「财报解读」在「个股短期动向」因子内
const SHORT_DIR_SUB_W = 0.50;     // 「短期动向预判」在「个股短期动向」因子内

const FACTOR_KEYS = ['sentiment', 'capital', 'futures', 'holdings', 'sectorLimit', 'seesaw', 'technicalShort'];
const FACTOR_NAME = {
  sentiment: '大盘', capital: '资金量能', futures: '对标期货短期走势',
  holdings: '增持减持', sectorLimit: '行业板块', seesaw: '科技指数（负相关）',
  technicalShort: '个股短期动向',
};
// 20260917i：删除「大盘及行业板块短期走势」因子（原 0.114），其余 7 因子按比例等比放大至 Σ=1.0000。
// 注：各 factor* 函数一律引用上方 W_* 常量，不再内嵌字面量，杜绝「两处不一致」。
const DEFAULT_WEIGHTS = {
  sentiment: W_SENTIMENT, capital: W_CAPITAL, futures: W_FUTURES,
  holdings: W_HOLDINGS, sectorLimit: W_SECTOR_LIMIT, seesaw: W_SEESAW, technicalShort: W_TECH_SHORT,
};

// ===== 因子结构哈希守卫（替代纯手工 SCHEMA_VERSION，20260906）=====
// 规则：凡因子增删/改名、默认权重调整，FACTOR_KEYS / DEFAULT_WEIGHTS 变化 → 哈希自动变化
// → 旧判断记录（data/judgments/*.json）被判「旧schema」强制重算，从机制上杜绝
// 「改了因子结构却漏升版 → 旧记录被静默复用、重启不生效」。纯展示布局/口径调整
// （非因子名/权重/数量）则手动 +1 下方 LAYOUT_VERSION。
function _hashFactorStructure() {
  const payload = JSON.stringify({ keys: FACTOR_KEYS, weights: DEFAULT_WEIGHTS });
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < payload.length; i++) {
    h ^= payload.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + (h >>> 0).toString(16)).slice(-8);
}
const LAYOUT_VERSION = '20260922c'; // 20260922h：「增持减持」因子新增第④子模块「股东被动减持/司法强制执行」：扫公告/新闻标题按股东姓名(前十大股东 name)或角色词(二股东/大股东)+司法强制执行/被动减持/强制平仓/司法拍卖 关键词关联，确认已发生被动减持 signal=-0.8、仅司法冻结/拍卖预告 -0.6；父因子 signal 在原 0.55×方向+0.45×力度 基础上叠加 0.2×forcedSignal 困境溢价(forced=0 时恒为 0、旧校准不动)；caption 在确认时打 ⚠ 雷点。性质检测走公告流(实时)、不依赖 F10 季报滞后(9月事件等 Q3 才进 F10)。属展示内容/子模块新增、哈希不捕获 → 手动升版强制重算当日判断。 // 20260921l：「原油主连」冲击有效期由 3 天改为 1 天（用户要求），并修正取数通道（push2delay 不可达 → 新浪 nf_SC0）；20260921k：「股份回购」完成实施/停止实施/被股东大会否决时判定转为中性（signal=0、不再计入增持家数），利好力量仅来自尚未买入的承诺资金；20260921j：「股份回购」子卡片由「标题正则扫到几条」改为东财结构化回购报表（RPTA_WEB_GETHGLIST_NEW），按「数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度」四要素提炼——展示内容变化、哈希不捕获 → 手动升版强制重算当日判断（否则旧快照静默复用、页面看不到新格式）。 20260921c：量价配合口径修正——「大涨+平量(量比0.8~1.2)」由「显著上涨」(+8 / +0.4) 改判中性「大涨平量」(0 / 0)：大涨而量能未放大属量价背离、不再算利好（同步改 capitalCharts 配色/计分）；属口径调整、哈希不捕获 → 手动升版强制重算当日判断。 20260921a：事件驱动「口径级」修复补丁——newsSectorImpact 把「医药生物」按申万二级拆为「药品」「医疗器械」两条互斥规则、且 eventEngine 禁止 company_event 外溢广播至全行业（阳普医疗认证/药监局药品监管不再误挂医疗器械股）。此类改动不触及因子名/权重/数量（_hashFactorStructure 不捕获）→ 必须手动升版强制重算当日判断缓存，否则「清了事件、页面仍显示旧事件」。 20260918a：移除「行业板块」因子「板块成分」子卡片（展示布局/口径调整，非因子名/权重/数量，_hashFactorStructure 不捕获）→ 手动升版强制重算旧判断缓存，避免旧记录静默复用仍显示该卡片。 20260917i：个股页卡片重组（用户要求）——「市场情绪与消息面」改名「大盘」（删除「消息情绪（大盘）」「涨跌停比」两个子因子及其底层逻辑；新增「市场情绪提醒」子因子直接引用首页判断；转入「大盘短期走势」）；「板块涨跌停占比」改名「行业板块」（转入「板块消息」「行业短期走势」）；删除「大盘及行业板块短期走势」整个因子；「财报解读」「舆情与讨论热度（个股）」迁入「个股短期动向」；因子权重等比放大至 Σ=1.0000。因子结构变化（market 移除）由哈希自动捕获，此处手动升版确保布局同时刷新。展示布局/口径调整时手动 +1；因子结构变化由哈希自动捕获（20260915a：个股行业展示口径统一——公司概况与 sameDay 行业板块因子优先使用 sectorIdentity 精确行业（f10Name/emIndustry/industry），并对 THS_BOARD_BY_CODE 硬编码映射兜底，避免 688660 电气风电等股票因 F10 CSRC 泛化分类（制造业-通用设备制造业）被错配为通用设备；20260913g：股东报告期口径修正——「最新报告期」不再限定季度末，改为取东财最新一个满10行完整披露日（含非季度末的权益变动/临时披露，如海天味业 2026-07-03）；periodTag 改按「是否最新可得披露」判定，避免把更新的非季度末披露误标为“非最新季报期”；同步升级以强制重算旧记录；20260913f：增持减持因子补「数据报告期」标注——因子 caption + 两个子卡片均显式标注报告期与是否最新季报期，修掉「小卡片无日期」；同时借此强制重算旧记录，清掉报告期仍停留在临时公告日（如华安证券 2026-07-23）的陈旧缓存；20260911d：事件驱动因子「原油冲击」参考对象由布伦特原油期货改为原油主连(INE·scm主连)——因子名/文案变更，升版强制重算旧记录以刷新事件因子卡片；20260911c：新增该子因子）；20260922i：修复「公告漏抓」——① 数据端 searchAnnouncementsByCode 东财旧路径 /api/security/announcement 已失效(HTTP200空body)→ 改走可用 /api/security/ann 并带 ann_type=A&client_source=web&f_node=0&s_node=0，real titles 已验证可抓(执行完成的结果公告/拟被司法强制执行)；② detectForcedReduction 正则扩展覆盖真实措辞(执行完成/拟被司法强制执行/司法冻结/轮候冻结)，并加增持计划执行完成等利好语境排除，避免误判。属数据源+检测口径改动、哈希不捕获 → 手动升版强制重算当日判断缓存。
const SCHEMA_VERSION = 'h' + _hashFactorStructure() + '-' + LAYOUT_VERSION;
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
  const [quoteR, historyR, sectorIdR, futuresR, marketR, newsR, sentimentR, shareholdersR, globalSentimentR, reportR, announceR, announceCodeR, regulatoryR, h60R, marketTechR] = await Promise.allSettled([
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
    getMarketTechnical().catch(() => ({ indices: [] })), // 20260905d：大盘/行业短期走势因子联动首页大盘技术分析模块
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
  const marketTech = marketTechR && marketTechR.status === 'fulfilled' ? marketTechR.value : { indices: [] };

  // 20260905e：按个股真实成分股筛大盘/行业指数（lib/indexConstituents.pickIndicesForStock）。
  // 一次性算好传入 factorMarketShort，避免重复网络查询。
  let selectedIndices = (market && market.cn) || [];
  let scopeLabel = '—';
  try {
    const sel = await selectMarketIndicesByStock((market && market.cn) || [], symbol);
    selectedIndices = sel.indices || [];
    scopeLabel = sel.scopeLabel || scopeLabel;
  } catch (e) {
    console.warn('[SameDayJudgment] selectMarketIndicesByStock failed:', e.message);
  }
  const stockCtx = { symbol, techIndices: marketTech.indices || [], selectedIndices, scopeLabel };

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
  // 回购识别（20260921j 重构）：
  //   旧口径**只扫标题正则**，命中一条含「回购」的新闻标题就计 1 次、并把标题原文当 detail —— 结果
  //   用户要看的「已回购多少股/多少钱、承诺回购多少钱、进度到哪」一个都没提炼（实测 600909 卡片
  //   显示的竟是一条「…回应二股东减持及回购力度…」的新闻标题，真实数据是已回购 2537 万股/2.0 亿、
  //   承诺 1~2 亿、已完成实施）。
  //   新口径**结构化优先**：走东财回购报表（lib/buybackEmDc，datacenter-web 可达）拿权威字段；
  //   报表无记录时再退回标题扫描（保留旧能力，覆盖"公告源偶发空但新闻有报道"的场景）。
  const BUYBACK_RE = /回购(股份|注销|方案|实施|进展|预案)?|股份回购/;
  let buyback = { ok: false, count: 0 };
  let buybackSrc = 'none';
  try {
    const bp = await getBuybackPlan(symbol);
    if (bp && bp.ok && bp.plan) {
      // 结构化命中：count 保持「报表档数」语义（兼容旧消费方），titles 不再塞新闻标题
      buyback = {
        ok: true,
        count: bp.plans.length,
        latest: bp.plan.date || '',
        titles: [],
        structured: true,
        plan: bp.plan,
        plans: bp.plans,
        text: formatBuybackPlan(bp.plan),
      };
      buybackSrc = 'eastmoney-datacenter';
    } else if (bp && bp.reason === 'error') {
      console.warn('[buildJudgment] 回购报表取数失败，退回标题扫描:', bp.error);
    }
  } catch (e) {
    console.warn('[buildJudgment] 回购报表异常，退回标题扫描:', e.message);
  }
  if (!buyback.ok) {
    const buybackCandidates = [];
    for (const a of allAnnouncements) if (a && a.title && BUYBACK_RE.test(a.title)) buybackCandidates.push({ title: a.title, date: a.date || '' });
    for (const n of stockNews) if (n && n.title && BUYBACK_RE.test(n.title)) buybackCandidates.push({ title: n.title, date: n.date || '' });
    if (buybackCandidates.length) {
      buyback = {
        ok: true,
        count: buybackCandidates.length,
        latest: buybackCandidates.map(x => x.date).filter(Boolean).sort().reverse()[0] || '',
        titles: buybackCandidates.map(x => x.title),
        structured: false,
      };
      buybackSrc = 'title-scan';
    }
  }
  console.log(`[buildJudgment] symbol=${symbol} buyback src=${buybackSrc} ok=${buyback.ok} count=${buyback.count || 0}`);

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

  // 20260910 修复：板块走势/涨跌停定位改用「细分行业名优先」。
  // 根因：申万一级（如 688660 电气风电=「新能源」）传入 sector_trend.py 后经同义词表泛化扩展
  // （新能源→[光伏,风电,储能,锂电]），候选按列表顺序盲匹配，「光伏」排在「风电」前 → 误命中「光伏设备」。
  // F10 细分行业（f10Name，如「风电设备」）能在同花顺板块列表精确命中，优先使用；
  // 仅影响板块走势/涨跌停两处定位，不改全局 industryName（板块消息联动/跨市场对标/政策关键词行为不变）。
  const fineIndustry = sectorIdMatch ? String(sectorId.f10Name || sectorId.emIndustry || '').trim() : '';

  // 20260915：同花顺 K 线板块覆盖兜底。当 sectorIdentity 失败或未命中细分行业时，
  // 仍按代码硬编码映射取精确板块名（如 688660→风电设备），避免回退到泛化行业/错误 CSRC。
  const boardOverride = THS_BOARD_BY_CODE[normSymbol(symbol)] || '';
  const effectiveFineIndustry = fineIndustry || boardOverride;

  // 行业板块走势：用个股行业名定位板块，取板块整体涨跌作为「大盘及行业板块短期走势」因子的行业部分
  const sectorTrend = await getSectorTrend(symbol, name || '', effectiveFineIndustry || industryName).catch(() => null);

  // 板块涨跌停占比：个股所属板块内涨停/跌停家数占比（短期情绪核心因子）
  const sectorLimit = await getSectorLimitStats(symbol, name || '', effectiveFineIndustry || industryName).catch(() => null);

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
  // 20260917i：两个从「大盘」卡片迁出的子因子（舆情与讨论热度（个股）→个股短期动向；板块消息→行业板块）
  const stockSentSub = computeStockSentimentSub(sentiment, quote, symbol, capital, turnoverChange);
  const sectorNewsSub = computeSectorNewsSub(sectorNews);
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
  // 20260905g：技术面短期动向因子改走 priceActionHub 唯一出口——与「技术面分析」页共用
  // 同一份快照与缓存（指标级单源），消除两页各自拉K线造成的跨页不一致。
  // hub 失败时回退本地 analyzePriceAction（用本次已拉取的 history/h60），保证因子不因单点失败缺失。
  let priceAction = null;
  try {
    const paSnap = await getPriceActionSnapshot(symbol);
    if (paSnap && !paSnap.error && paSnap.shortTerm) priceAction = paSnap;
  } catch (e) { /* 回退本地计算 */ }
  if (!priceAction && history && history.length >= 60) {
    try { priceAction = analyzePriceAction(history, h60 && h60.length ? h60 : null); } catch (e) { priceAction = null; }
  }
  const factors = [
    factorSentiment(sentiment, quote, history, sectorNews, crossMarket, globalSentiment, newsSubs.parts, symbol, capital, turnoverChange, stockCtx),
    factorCapital(capital, turnoverChange, sentiment, quote, history),
    factorFuturesShort(futures),
    factorHoldings(shareholders, buyback, { announcements: allAnnouncements, news: stockNews, companyName: name }),
    factorSectorLimit(sectorLimit, sectorTrend, sectorNewsSub),
    factorSeesaw(seesawData, isTechStock),
    factorTechnicalShort(priceAction, stockSentSub, newsSubs.earnSub),
  ];
  // 第一遍：用默认权重得到初步方向
  const firstPass = combineFactors(factors);
  // 第二遍：按「个股 + 初步方向」取对应的「自适应权重」（样本不足时按回退链降级）
  const adaptive = getAdaptiveWeights(symbol, firstPass.dir);

  // 20260907a：第三遍叠加「事件驱动」权重覆盖（短期口径）。
  // 既有 8 因子按各自自适应权重等比例压缩，新增「事件驱动」因子，总和恒为 100%。
  // 无活跃事件时 evShort 为 null → 行为与旧版完全一致（weightsUsed = adaptive）。
  // 20260911：若该股有「专属因子」（如海天味业CPI），一并归并——常驻因子按
  //   (事件权重 + 专属权重) 等比压缩，事件/专属因子各自带有效权重，总和恒 ≤ 100%；
  //   无激活专属因子时 dedShort 为 null，对结果零影响（其他个股走此分支，隔离不变）。
  const evShort = eventEngine.buildEventOverride({ symbol, baseWeights: adaptive, factorKeys: FACTOR_KEYS, horizon: 'short', history });
  const dedShort = dedicatedFactor.buildDedicatedOverride({ symbol, baseWeights: adaptive, factorKeys: FACTOR_KEYS, horizon: 'short' });
  const nrShort = [];
  if (evShort) nrShort.push({ key: 'event', weight: evShort.combinedWeight, factor: evShort.eventFactor });
  if (dedShort) dedShort.dedicatedFactors.forEach(f => nrShort.push({ key: f.key, weight: f.weight, factor: f }));
  let finalFactors = factors;
  let finalWeights = adaptive;
  if (nrShort.length) {
    const merged = dedicatedFactor.mergeNonResidentOverrides(adaptive, FACTOR_KEYS, nrShort);
    finalFactors = factors.concat(merged.factors);
    finalWeights = merged.override;
  }
  const { factors: scored, totalScore, dir, verdict, confidence } = combineFactors(finalFactors, finalWeights);

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
    weightsUsed: finalWeights,
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
    // 20260910c：子卡改名「板块消息联动」→「板块消息」；旧落盘记录仍是旧名，结算复盘需兼容双名
    const snSub = subs.find(s => s.name === '板块消息' || s.name === '板块消息联动');
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
// 20260905g：当日复用判断记录时，「个股短期动向」因子用 priceActionHub 最新快照刷新
// （与技术面分析页同一份快照、同一档位），并重算总分/方向/置信度，保证：
//   ① 两页跨页一致（技术面页实时滚动 vs 判断记录当日复用，不再有时点错位）；
//   ② 生成瞬间 K 线拉取失败的坏记录（"数据不足"）自动被有效快照修复；
//   ③ 面板内部自洽（因子信号与总结论同步刷新）。
// 仅刷新返回给前端的内存对象；记录文件保留生成时原值，准确率结算口径（rec.dir）不受影响。
const _TECH_REFRESH_TIMEOUT_MS = 3500; // hub 冷缓存时拉K线可能较慢，超时则沿用记录原值
async function _refreshTechnicalShortOnReuse(rec, symbol) {
  try {
    if (!rec || !Array.isArray(rec.factors)) return rec;
    const paSnap = await Promise.race([
      getPriceActionSnapshot(symbol),
      new Promise(resolve => setTimeout(() => resolve(null), _TECH_REFRESH_TIMEOUT_MS)),
    ]);
    if (!paSnap || paSnap.error || !paSnap.shortTerm || typeof paSnap.shortTerm.dirScore !== 'number') return rec;
    const old = rec.factors.find(f => f.key === 'technicalShort');
    // 20260917i：technicalShort 现含「舆情与讨论热度（个股）」「财报解读」两个迁入子因子，
    // 复用刷新时从旧记录取出并回传，避免刷新把这两个子因子丢掉。
    const oldSubs = (old && Array.isArray(old.subFactors)) ? old.subFactors : [];
    const sentSubFromOld = oldSubs.find(s => s && s.name === '舆情与讨论热度（个股）') || null;
    const earnSubFromOld = oldSubs.find(s => s && s.name === '财报解读') || null;
    const newFactor = factorTechnicalShort(paSnap, sentSubFromOld, earnSubFromOld);
    if (old && old.value === newFactor.value && old.signal === newFactor.signal) return rec; // 结论未变，不重算
    const factors = rec.factors.map(f => (f.key === 'technicalShort' ? newFactor : f));
    const firstPass = combineFactors(factors);
    const adaptive = getAdaptiveWeights(symbol, firstPass.dir);
    const { factors: scored, totalScore, dir, verdict, confidence } = combineFactors(factors, adaptive);
    return { ...rec, factors: scored, totalScore, dir, verdict, confidence, techShortRefreshedAt: new Date().toISOString() };
  } catch (e) {
    return rec; // 刷新失败沿用记录原值，不影响面板打开
  }
}

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
  // 20260906c：财报解读新鲜度门控——上游 earnings 缓存比本判断新（如刚在深度页「重新解读」或缓存重生成），
  // 说明判断里的财报因子快照已落后，强制重算以引用最新综合结论；否则小卡会一直吐旧兜底/旧全文。
  let earningsFresher = false;
  if (rec) {
    try {
      const upEarnings = readEarningsCache(symbol);
      if (upEarnings && !upEarnings.stale && upEarnings.date && rec.generatedAt
        && new Date(upEarnings.date) > new Date(rec.generatedAt)) earningsFresher = true;
    } catch {}
  }
  const reuse = rec && rec.targetDate === currentTargetDate && rec.target === currentTarget && !force && !_judgmentHasRawException(rec) && rec.schemaVersion === SCHEMA_VERSION && !stale && !earningsFresher;
  if (reuse) {
    // 复用，但仍结算该股历史判断以更新准确率；个股短期动向因子用最新快照刷新（20260905g 跨页一致性）
    await settleSymbol(symbol);
    const judgment = await _refreshTechnicalShortOnReuse(rec, symbol);
    return { judgment, accuracy: computeAccuracy(filterBySymbol(getAllRecords(), symbol)), today: today, regenerated: false };
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

// 20260907a：事件变化后，作废某股票「当前目标日」的缓存判断，使其下次打开重新生成（带事件权重）。
function invalidateJudgmentForSymbol(symbol) {
  try {
    const now = new Date();
    const date = localDate(now);
    const targetDate = marketClosed(now) ? nextTradingDay(date) : date;
    const f = path.join(JUDGE_DIR, `${targetDate}.json`);
    if (!fs.existsSync(f)) return false;
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(arr)) return false;
    const ns = normSymbol(symbol);
    const next = arr.filter(r => normSymbol(r.symbol) !== ns);
    if (next.length === arr.length) return false;
    fs.writeFileSync(f, JSON.stringify(next, null, 2), 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  buildJudgment,
  invalidateJudgmentForSymbol,
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
  factorHoldings, // 20260922h：导出以支持第④子模块单元测试（股东被动减持/司法强制执行）
  detectForcedReduction, // 20260922h：导出以支持第④子模块检测逻辑单测
  DEFAULT_WEIGHTS,
  FACTOR_KEYS,
  FACTOR_NAME,
};
