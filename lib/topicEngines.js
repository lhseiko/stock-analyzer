/**
 * lib/topicEngines.js — 每日复盘「每日热点题材与归因卡片 / 资金投票质量 / 四象限中和」引擎
 * ==========================================================================
 * 20261108d 新增。用户新规格第二、三部分落地：
 *  - 消息源过滤：官方（部委/官媒）优先；自媒体「小作文」标「传闻/未核验」。
 *  - 题材阶段：启动期 / 发酵·主升期 / 高潮·退潮期，基于前 3-5 个交易日**同口径**
 *    行业涨停家数序列（scripts/board_review_data.py 的 sectors.industryHistory）。
 *  - 题材评级：S 主线共振 / A 局部投机 / B 轮动补涨 / C 诱多陷阱。
 *  - 资金投票质量：强共识 / 局部游资 / 无效陷阱 / 防御性 / 无法判断。
 *  - 双方向四象限（技术面 × 消息面）：共振 / 背离 / 先觉 / 双弱 / 无法判断。
 *
 * 【架构铁律】全部为确定性规则，零 require、零 I/O、零网络、零 LLM 推导。
 *   数值只复述真实采集值；缺失一律返回 null / 「缺失」，绝不臆造。
 *
 * 【诚实边界 / 显式取舍，勿回退】
 *  1. 工作台无「板块成分股 + 市值 + 趋势行情」映射 → 用涨停池内流通市值居前个股
 *     作「中军代理」，并在 midCapText / 口径披露里写明它不是真实板块中军。
 *     S 级要求中军大阳线，代理缺失时**不得评 S**，降级 A 并写明证据缺口。
 *  2. 工作台新闻源是「东方财富 7×24 快讯」实时流，不能证明某题材当日「无消息」。
 *     因此「无匹配新闻」= 消息面证据**缺失**，不等于「消息弱」；四象限返回
 *     「无法判断」而非「双弱」，避免把整批题材一键剔除成空白模板。
 *     消息级别由来源名称与标题关键词推断，未经公告原文核验，只作线索触发器。
 *  3. 题材阶段有效对照点 < 3 时，stage = 「缺少对照」，stageReason 写完整
 *     「缺少对照，暂不作持续性判断」，禁止把单日数据当趋势。
 *  4. D4 基本面：复盘链路未接入财报/估值数据 → 驱动标签恒不标 D4，并披露口径。
 */
'use strict';

const MISSING = '缺失';
const NO_COMPARISON = '缺少对照，暂不作持续性判断';
const SCHEMA_VERSION = 'topic-20261108d';

const TOPIC_TH = {
  sLimitUp: 5,             // S 级 / 强共识所需涨停家数下限
  strongLimitUp: 4,        // 技术面「强」的涨停家数下限
  midCapStrongPct: 5,      // 中军代理「大阳线」阈值（%）
  stageMinPoints: 3,       // 阶段判定最少有效对照点
  earlySealShare: 50,      // 早盘封板占比阈值（%），用于 D1 技术标签
  amtShrinkPct: -10,       // 涨停池成交额序列收缩阈值（%），用于防御性投票
};

const DRIVER_DEFS = {
  D1: '技术（连板/板块层次/封板时间）',
  D2: '消息（新闻催化线索）',
  D3: '资金（成交额/板块资金流/大市值代理）',
  D4: '基本面（财报/估值）',
};

// 官方（部委 / 中央官媒）来源关键词 —— 只作级别推断，不证明公告真实性
const STATE_SOURCES = [
  '新华社', '人民日报', '央视', '央视新闻', '中国政府网', '国务院', '工信部',
  '发改委', '财政部', '中国人民银行', '央行', '证监会', '上交所', '深交所',
  '商务部', '科技部', '国家能源局', '统计局', '求是', '新华社客户端',
];
// 产业级 / 财经官方媒体
const INDUSTRY_OFFICIAL_SOURCES = [
  '中国证券报', '证券时报', '上海证券报', '证券日报', '经济日报', '经济参考报',
  '中国工业报', '中国电子报', '国资委', '工信部网站', '地方发改委',
];
// 自媒体「小作文」判定：标题出现这些词即标传闻
const RUMOR_WORDS = ['网传', '传闻', '消息人士', '据悉未证实', '市场传言', '未经证实', '小作文', '据传'];
// 防御性投票的行业线索
const DEFENSIVE_WORDS = ['农业', '种植', '养殖', '黄金', '贵金属', '红利', '银行', '电力', '煤炭', '公用事业', '食品饮料'];
// 涨停池「所属行业」→ 新闻标题关键词（覆盖主要行业；未覆盖行业退回行业名子串匹配）
const INDUSTRY_KEYWORDS = {
  '半导体': ['半导体', '芯片', '晶圆', '光刻', '存储', '集成电路', '封装'],
  '光伏设备': ['光伏', '硅料', '组件', '逆变器', '电池片'],
  '工业金属': ['有色', '工业金属', '电解铝', '铜价', '铝价', '稀土', '金属'],
  '纺织制造': ['纺织', '服装', '面料', '棉价'],
  '专用设备': ['专用设备', '工程机械', '机器人', '设备更新'],
  '医疗器械': ['医疗器械', '医疗设备', '集采', '耗材'],
  '证券': ['券商', '证券', '资本市场', 'IPO', '并购重组'],
  '保险': ['保险', '险资', '寿险'],
  '银行': ['银行', '存款', '信贷', 'LPR'],
  '汽车整车': ['汽车', '整车', '新能源车', '车市'],
  '汽车零部件': ['汽车零部件', '汽车供应链', '智驾', '自动驾驶'],
  '电力设备': ['电网', '特高压', '储能', '电力设备', '风电'],
  '通信设备': ['通信', '5G', '光模块', '算力', '数据中心'],
  '计算机设备': ['服务器', '算力', '计算机', '国产化'],
  '软件开发': ['软件', '大模型', 'AI', '人工智能', '鸿蒙'],
  '化学制品': ['化工', '化学', '涨价', '磷化工', '氟化工'],
  '食品饮料': ['食品', '白酒', '饮料', '消费'],
  '农牧饲渔': ['农业', '养殖', '种业', '猪价', '粮食'],
  '贵金属': ['黄金', '金价', '贵金属', '避险'],
  '煤炭行业': ['煤炭', '动力煤', '焦煤'],
  '房地产开发': ['房地产', '地产', '楼市', '住建'],
  '航天航空': ['航天', '航空', '卫星', '商业航天', '军工'],
  '电池': ['锂电池', '电池', '固态电池', '储能'],
  '游戏': ['游戏', '版号', '电竞'],
  '文化传媒': ['传媒', '影视', '短剧', '出版'],
};

// ---------- 基础工具（纯函数） ----------
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function fixed(v, d) { const n = num(v); return n == null ? MISSING : n.toFixed(d == null ? 2 : d); }
function pct(v, d) { const n = num(v); return n == null ? MISSING : (n >= 0 ? '+' : '') + n.toFixed(d == null ? 2 : d) + '%'; }
function list(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }

function trendOf(series, key, opts) {
  const o = opts || {};
  const vals = list(series).map(r => (r && num(r[key]) != null ? num(r[key]) : null)).filter(v => v != null);
  const min = o.minPoints || 3;
  if (vals.length < min) {
    return { direction: '无法判断', points: vals.length, ok: false, note: NO_COMPARISON };
  }
  const half = Math.floor(vals.length / 2);
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const a = avg(vals.slice(0, half)), b = avg(vals.slice(-half));
  const chg = a !== 0 ? (b - a) / Math.abs(a) * 100 : null;
  const th = o.threshold == null ? TOPIC_TH.amtShrinkPct : o.threshold;
  const direction = chg == null ? '无法判断'
    : chg > Math.abs(th) ? '扩散' : chg < th ? '收缩' : '持平';
  return { direction, points: vals.length, ok: true, changePct: chg, note: `前 ${vals.length} 个有效对照点，前后半段均值 ${fixed(a)} → ${fixed(b)}（${pct(chg)}）` };
}

/** 名称匹配：精确 → 双向子串 → null。板块名口径不同（申万 vs 东财细行业）时不硬凑。 */
function matchByName(arr, nameOf, industry) {
  const rows = list(arr);
  const key = String(industry || '');
  if (!key) return null;
  let hit = rows.find(x => String(nameOf(x) || '') === key);
  if (hit) return hit;
  hit = rows.find(x => {
    const n = String(nameOf(x) || '');
    return n && (key.includes(n) || n.includes(key));
  });
  return hit || null;
}

// ---------- 消息源级别与性质 ----------
const LEVEL_RANK = { '国家级/官方': 0, '产业级/官方': 1, '行业级/财经媒体': 2, '传闻/未核验': 3, [MISSING]: 4 };

function newsLevelOf(item) {
  if (!item) return { level: MISSING, rank: 4, reason: `无匹配新闻线索，消息面证据${MISSING}` };
  const title = String(item.title || '');
  const source = String(item.source || '');
  if (RUMOR_WORDS.some(w => title.includes(w))) {
    return { level: '传闻/未核验', rank: 3, reason: `标题含传闻类措辞（${RUMOR_WORDS.filter(w => title.includes(w)).join('、')}），按自媒体小作文处理，未经公告核验` };
  }
  if (STATE_SOURCES.some(w => source.includes(w))) {
    return { level: '国家级/官方', rank: 0, reason: `来源「${source}」命中部委/中央官媒关键词（按来源名推断，未经公告原文核验）` };
  }
  if (INDUSTRY_OFFICIAL_SOURCES.some(w => source.includes(w))) {
    return { level: '产业级/官方', rank: 1, reason: `来源「${source}」命中产业/财经官方媒体关键词（按来源名推断，未经公告原文核验）` };
  }
  return { level: '行业级/财经媒体', rank: 2, reason: `来源「${source}」为一般财经快讯，未标注官方级别（按来源名推断，未经公告原文核验）` };
}

/** 题材 ↔ 新闻匹配：官方优先；同级按来源时间倒序（上游已排序），再按输入顺序，保证确定性。 */
function matchNews(industry, news) {
  const key = String(industry || '');
  const words = INDUSTRY_KEYWORDS[key] || [key];
  const hits = [];
  for (const n of list(news)) {
    const title = String((n && n.title) || '');
    if (!title) continue;
    if (!words.some(w => w && title.includes(w))) continue;
    hits.push({ item: n, level: newsLevelOf(n) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (a.level.rank - b.level.rank));
  return hits[0];
}

// ---------- 题材阶段判定（前 3-5 日同口径行业涨停家数） ----------
function stageOf(industry, industryHistory, todayCount) {
  const hist = list(industryHistory);
  const series = hist.map(r => ({
    date: String((r && r.date) || ''),
    ok: !!(r && r.ok),
    count: (r && r.ok && r.counts && num(r.counts[industry]) != null) ? num(r.counts[industry]) : null,
  }));
  const valid = series.filter(x => x.count != null);
  if (valid.length < TOPIC_TH.stageMinPoints) {
    return {
      stage: '缺少对照', ok: false, points: valid.length,
      reason: `${NO_COMPARISON}（该行业仅取得 ${valid.length} 个有效同口径对照点，需 ≥${TOPIC_TH.stageMinPoints} 个）`,
      series: valid.map(x => x.count),
    };
  }
  const vals = valid.map(x => x.count);
  const today = num(todayCount) == null ? vals[vals.length - 1] : num(todayCount);
  const prev = vals.slice(0, -1);
  const peak = Math.max.apply(null, vals);
  const zeroPrev = prev.every(v => v === 0);
  const last3 = vals.slice(-3);
  const last3AllUp = last3.length === 3 && last3.every(v => v > 0) && last3[2] >= last3[1] && last3[1] >= last3[0];
  const multiDay = vals.filter(v => v > 0).length >= 4;
  let stage, reason;
  if (zeroPrev && today >= 2) {
    stage = '启动期';
    reason = `前 ${prev.length} 个对照日该行业涨停家数均为 0，今日 ${today} 家首次上榜（${valid.length} 个有效对照点）`;
  } else if (multiDay && (today < peak || today === peak && vals.length >= 5)) {
    stage = '高潮/退潮期';
    reason = `连续 ${vals.filter(v => v > 0).length} 个对照日上榜（≥4 日霸榜），今日 ${today} 家、区间峰值 ${peak} 家，家数自峰值回落`;
  } else if (last3AllUp && today >= 2) {
    stage = '发酵/主升期';
    reason = `最近 3 个对照日涨停家数 ${last3.join(' → ')} 连续上榜且未回落（${valid.length} 个有效对照点）`;
  } else {
    stage = '无明显阶段特征';
    reason = `同口径序列 ${vals.join(' → ')}（${valid.length} 个有效对照点）未满足启动/连续发酵/霸榜回落任一条件`;
  }
  return { stage, ok: true, points: valid.length, reason, series: vals };
}

// ---------- 中军代理 ----------
function midCapOf(industry, midCap) {
  const rows = list(midCap && midCap.byIndustry);
  const row = matchByName(rows, x => x.industry, industry);
  if (!row || !(midCap && midCap.ok)) {
    return { ok: false, text: MISSING, changePct: null, topName: null, floatMvYi: null };
  }
  const chg = num(row.topChgPct);
  const text = `${row.topName || MISSING} ${pct(chg)}（流通市值 ${fixed(row.topFloatMvYi)} 亿元，涨停池内大市值代理）`;
  // 20261110g P0-3：代理口径轻量打标（零 require；汇聚层/前端按 PROXY_REGISTRY 展开角标）
  return { ok: true, text, changePct: chg, topName: row.topName || null, floatMvYi: num(row.topFloatMvYi), proxyKeys: ['sector-core-proxy'] };
}

// ---------- 主入口 ----------
function normInput(raw) {
  const i = raw || {};
  return {
    date: String(i.date || MISSING),
    histDates: Array.isArray(i.histDates) ? i.histDates : [],
    sectors: (i.sectors && i.sectors.ok) ? i.sectors : null,
    quote: i.quote || null,
    news: list(i.news),
    sectorFlow: i.sectorFlow || null,
    prevPool: (i.prevPool && i.prevPool.ok) ? i.prevPool : null,
    ladder: i.ladder || null,
    historySeries: list(i.historySeries),
    breadth: i.breadth || null,
  };
}

/**
 * @param {object} raw 由 reviewService 组装的采集值
 * @returns {object} 归因卡片 / 投票质量 / 四象限 / 供机会引擎中和的 topicByIndustry
 */
function analyzeTopics(raw) {
  const ctx = normInput(raw);
  const sec = ctx.sectors;
  const top = sec ? list(sec.top).slice(0, 8) : [];
  const industryHistory = sec ? list(sec.industryHistory) : [];
  const sealTime = sec && sec.sealTime && sec.sealTime.ok ? sec.sealTime : null;
  const midCap = sec && sec.midCap && sec.midCap.ok ? sec.midCap : null;
  const limitDown = sec && sec.limitDown && sec.limitDown.ok ? sec.limitDown : null;
  const amtTrend = trendOf(ctx.historySeries, 'ztAmountYi', { threshold: TOPIC_TH.amtShrinkPct });
  const largeDropIndustries = ctx.prevPool ? list(ctx.prevPool.industryBigDrop).map(x => String(x.industry || '')) : [];
  const singles = sec ? list(sec.singleDance).map(String) : [];

  const cards = [];
  for (const s of top) {
    const industry = String(s.industry || '');
    if (!industry) continue;
    const count = num(s.count);
    const boardsMax = num(s.boardsMax);
    const hasLayer = s.hasLayer === true ? true : s.hasLayer === false ? false : null;
    const amountYi = num(s.amountYi);

    // 板块涨幅：同花顺板块快照（口径与东财细行业不完全一致，匹配不上即缺失）
    const upRow = matchByName(ctx.quote && ctx.quote.sectorsUp, x => x.name, industry);
    const changePct = upRow ? num(upRow.changePct) : null;
    // 板块资金净流入：申万板块口径，匹配不上即缺失
    const flowRow = matchByName(ctx.sectorFlow && ctx.sectorFlow.todayInflowTop5, x => x.name, industry);
    const mainNet = flowRow ? num(flowRow.mainNet) : null;

    const m = matchNews(industry, ctx.news);
    const level = m ? m.level : { level: MISSING, rank: 4, reason: `无匹配新闻线索，消息面证据${MISSING}` };
    const newsItem = m ? m.item : null;
    const newsTime = newsItem ? String(newsItem.date || MISSING) : MISSING;
    const attribution = newsItem
      ? `${String(newsItem.title || MISSING)}（${String(newsItem.source || MISSING)}）`
      : MISSING;

    // 核心催化（禁止留白 / 无意义填充）：有新闻用新闻标题；无新闻按「资金 × 连板」自动归因。
    // 这是工作台铁律——代码权威，LLM 只负责原样引用，不得改写、不得输出「暂无可核验催化」/「无」/「缺失」。
    // 规则优先级：涨停数 > 0 且主力净流入 > 0 → 资金与游资共振；涨停数 > 0（无正流入）→ 纯游资接力；
    // 涨停数 = 0 且主力净流入 > 0 → 纯资金驱动；二者皆无 → 退化的板块联动描述（仍非占位词）。
    let catalyst;
    if (newsItem) {
      catalyst = `${String(newsItem.title || MISSING)}（${String(newsItem.source || MISSING)}）`;
    } else {
      const zt = num(count) || 0;
      const net = num(mainNet);
      if (zt > 0 && net != null && net > 0) {
        catalyst = `资金与游资共振（净流入${fixed(net)}亿/最高${boardsMax == null ? '—' : boardsMax}板）`;
      } else if (zt > 0) {
        catalyst = `纯游资接力（最高${boardsMax == null ? '—' : boardsMax}板）`;
      } else if (net != null && net > 0) {
        catalyst = `纯资金驱动（净流入${fixed(net)}亿）`;
      } else {
        catalyst = `板块联动（涨停 ${zt} 家${net != null ? `、主力净${net >= 0 ? '流入' : '流出'}${fixed(Math.abs(net))}亿` : ''}）`;
      }
    }

    const st = stageOf(industry, industryHistory, count);
    const mc = midCapOf(industry, midCap);
    const sealRow = sealTime ? matchByName(list(sealTime.byIndustry), x => x.industry, industry) : null;
    const earlyShare = (sealRow && num(sealRow.count) > 0)
      ? num(sealRow.early) / num(sealRow.count) * 100 : null;

    // ---- 驱动标签 D1-D4（D4 恒不标，口径披露见 notes） ----
    const tags = [];
    if ((boardsMax != null && boardsMax >= 2) || hasLayer === true || (earlyShare != null && earlyShare >= TOPIC_TH.earlySealShare)) tags.push('D1');
    if (newsItem) tags.push('D2');
    if (mainNet != null || amountYi != null || mc.ok) tags.push('D3');
    const drivers = tags.length ? tags.join('/') : MISSING;

    // ---- 资金投票质量 ----
    let voteQuality, voteReason;
    const isDefensive = DEFENSIVE_WORDS.some(w => industry.includes(w));
    const trapHit = st.stage === '高潮/退潮期' && (largeDropIndustries.includes(industry) || (mc.ok && mc.changePct != null && mc.changePct < 0));
    const msgHigh = (level.rank <= 1) && (st.stage === '启动期' || st.stage === '发酵/主升期');
    const coreOk = boardsMax != null && boardsMax >= 2;
    const midCapStrong = mc.ok && mc.changePct != null && mc.changePct >= TOPIC_TH.midCapStrongPct;
    if (trapHit) {
      voteQuality = '无效/陷阱投票';
      voteReason = `题材处于${st.stage}且出现「利好兑现后回落」证据（大面股行业命中或中军代理走弱）；利好未转化为持续承接`;
    } else if (isDefensive && amtTrend.direction === '收缩') {
      voteQuality = '防御性投票';
      voteReason = `涨停池成交额序列${amtTrend.direction}（${amtTrend.note}），资金流向「${industry}」等防御方向；仅作当日结构描述`;
    } else if (msgHigh && count != null && count >= TOPIC_TH.strongLimitUp && coreOk && midCapStrong) {
      voteQuality = '强共识投票';
      voteReason = `官方级线索 + ${st.stage} + 涨停 ${count} 家 + 连板核心 ${boardsMax} 板 + 中军代理 ${pct(mc.changePct)}，四项证据齐备`;
    } else if (count != null && (count <= 2 || hasLayer === false || (mc.ok && mc.changePct != null && mc.changePct < TOPIC_TH.midCapStrongPct))) {
      voteQuality = '局部游资投票';
      voteReason = `涨停 ${count} 家、板块层次 ${hasLayer == null ? MISSING : (hasLayer ? '有' : '无')}、中军代理 ${mc.ok ? pct(mc.changePct) : MISSING}；有涨停但承接不足或仅小票异动`;
    } else {
      voteQuality = '无法判断';
      voteReason = `消息级别、板块层次或中军代理证据${MISSING}，不足以归入任一投票类型`;
    }

    // ---- 双方向四象限（技术面 × 消息面） ----
    let quadrant, quadrantAction, quadReason;
    const msgKnown = !!newsItem;
    const msgStrong = msgKnown && level.rank <= 1 && (st.stage === '启动期' || st.stage === '发酵/主升期');
    const techKnown = count != null;
    const techStrong = techKnown && count >= TOPIC_TH.strongLimitUp && coreOk && hasLayer === true;
    const techWeak = techKnown && (count <= 2 || hasLayer === false || singles.includes(industry));
    if (!msgKnown || !techKnown) {
      quadrant = '无法判断';
      quadrantAction = '不因象限额外升降级；证据缺口已在确认项中扣分';
      quadReason = `${msgKnown ? '' : `消息面证据${MISSING}（新闻流不能证明「无消息」）；`}${techKnown ? '' : `技术面涨停家数${MISSING}；`}按诚实缺失原则不判「双弱」、不整批剔除`;
    } else if (msgStrong && techStrong) {
      quadrant = '共振'; quadrantAction = '可给 S/A 级，重点跟踪次日板块响应';
      quadReason = `消息强（${level.level} + ${st.stage}）且技术强（涨停 ${count} 家 / 连板核心 / 有层次）`;
    } else if (msgStrong && techWeak) {
      quadrant = '背离'; quadrantAction = '降级为仅观察（防诱多）';
      quadReason = `消息强但技术弱：涨停 ${count} 家、层次 ${hasLayer === false ? '无' : '待核验'}，中军未跟`;
    } else if (!msgStrong && techStrong) {
      quadrant = '先觉'; quadrantAction = '放入观察池但降一级（防无源之水）';
      quadReason = `技术强（涨停 ${count} 家 / 连板核心 / 有层次）但消息级别为 ${level.level}，催化未明`;
    } else if (!msgStrong && techWeak) {
      quadrant = '双弱'; quadrantAction = '按规格剔除出可跟踪候选';
      quadReason = `消息级别 ${level.level}、涨停 ${count} 家且板块无跟随，无催化无量价`;
    } else {
      quadrant = '无法判断'; quadrantAction = '不因象限额外升降级';
      quadReason = '消息面与技术面均未达到强/弱判定阈值，保持中性';
    }

    // ---- 题材评级 S/A/B/C ----
    let grade, gradeReason, evidenceComplete;
    const cTrap = st.stage === '高潮/退潮期' && (trapHit || (mc.ok && mc.changePct != null && mc.changePct < 0) || singles.includes(industry));
    if (cTrap) {
      grade = 'C'; evidenceComplete = true;
      gradeReason = `利好兑现/退潮特征（${st.reason}）+ 中军代理走弱或龙头独舞，按「诱多陷阱」处理`;
    } else if (level.rank <= 1 && (st.stage === '启动期' || st.stage === '发酵/主升期')
      && count != null && count >= TOPIC_TH.sLimitUp && coreOk && midCapStrong && hasLayer === true) {
      grade = 'S'; evidenceComplete = true;
      gradeReason = `国家级/产业级线索 + ${st.stage} + 涨停 ${count} 家 + 连板核心 + 中军代理 ${pct(mc.changePct)} + 板块有层次，主线共振六项齐备`;
    } else if (level.rank <= 1 && (st.stage === '启动期' || st.stage === '发酵/主升期')
      && count != null && count >= TOPIC_TH.sLimitUp && coreOk && !mc.ok) {
      grade = 'A'; evidenceComplete = false;
      gradeReason = `消息与阶段、涨停家数、连板核心齐备，但「中军大阳线」数据${MISSING}（工作台仅有涨停池内大市值代理，当前无该行业样本）→ S 级不成立，降为 A`;
    } else if (msgKnown && count != null && count <= 2) {
      grade = 'A'; evidenceComplete = count != null;
      gradeReason = `${level.level} 线索 + 仅 ${count} 家涨停、中军代理 ${mc.ok ? pct(mc.changePct) : MISSING}，属局部投机`;
    } else if (!msgKnown) {
      grade = 'B'; evidenceComplete = false;
      gradeReason = `无匹配新闻催化线索（消息面证据${MISSING}），涨停 ${count == null ? MISSING : count} 家；按「轮动补涨/无明显新闻」处理，S/A 级不成立`;
    } else {
      grade = 'B'; evidenceComplete = false;
      gradeReason = `消息级别 ${level.level}、阶段 ${st.stage}、涨停 ${count == null ? MISSING : count} 家，未同时满足 S/A/C 条件，按轮动补涨归类`;
    }

    const verifyLogic = grade === 'S'
      ? `明日核对 ${industry} 涨停家数是否维持 ≥${count} 家、中军代理 ${mc.topName || MISSING} 是否继续放量、最高板 ${boardsMax == null ? MISSING : boardsMax} 板是否晋级`
      : grade === 'A'
        ? `明日核对 ${industry} 是否出现第 2 只跟随涨停、中军代理是否响应、早盘封板占比是否维持`
        : grade === 'B'
          ? `明日核对 ${industry} 是否延续涨停家数 ${count == null ? MISSING : count} 家、是否出现可核验催化线索`
          : `明日核对 ${industry} 高位断板股是否止跌、涨停家数是否继续自峰值 ${Math.max.apply(null, st.series.length ? st.series : [0])} 家回落`;

    cards.push({
      name: industry,
      // 20261110g P0-3：题材卡整体基于涨停池样本聚合（代表全市场为代理口径）+ 中军代理命中时叠加
      proxyKeys: mc.ok ? ['zt-pool-market', 'sector-core-proxy'] : ['zt-pool-market'],
      changePct,
      limitUpCount: count == null ? MISSING : count,
      midCapText: mc.text,
      attribution,
      catalyst,
      newsLevel: level.level,
      newsTime,
      stage: st.stage,
      stageReason: st.reason,
      grade,
      gradeReason,
      verifyLogic,
      voteQuality,
      voteReason,
      quadrant,
      quadrantAction,
      quadReason,
      drivers,
      // 内部结构字段：前端 HIDDEN_COLS 不展示，机会引擎中和时使用
      newsSource: newsItem ? String(newsItem.source || MISSING) : MISSING,
      evidenceComplete,
      count, boardsMax, hasLayer, mainNet, earlyShare,
      midCapChangePct: mc.changePct,
      sealTimeText: sealRow
        ? `早盘 ${sealRow.early} / 盘中 ${sealRow.mid} / 尾盘 ${sealRow.late}（共 ${sealRow.count} 家）`
        : MISSING,
    });
  }

  // ---- 汇总 ----
  const voteSummary = { '强共识投票': 0, '局部游资投票': 0, '无效/陷阱投票': 0, '防御性投票': 0, '无法判断': 0 };
  const quadrantSummary = { '共振': 0, '背离': 0, '先觉': 0, '双弱': 0, '无法判断': 0 };
  const gradeSummary = { S: 0, A: 0, B: 0, C: 0 };
  cards.forEach(c => {
    if (voteSummary[c.voteQuality] != null) voteSummary[c.voteQuality]++;
    if (quadrantSummary[c.quadrant] != null) quadrantSummary[c.quadrant]++;
    if (gradeSummary[c.grade] != null) gradeSummary[c.grade]++;
  });
  const dominantVote = cards.length
    ? Object.entries(voteSummary).sort((a, b) => b[1] - a[1])[0][0] : '无法判断';
  const dominantQuadrant = cards.length
    ? Object.entries(quadrantSummary).sort((a, b) => b[1] - a[1])[0][0] : '无法判断';
  const topicByIndustry = {};
  cards.forEach(c => {
    topicByIndustry[c.name] = {
      stage: c.stage, stageReason: c.stageReason, grade: c.grade, gradeReason: c.gradeReason,
      newsLevel: c.newsLevel, newsTime: c.newsTime, quadrant: c.quadrant,
      quadrantAction: c.quadrantAction, voteQuality: c.voteQuality,
      drivers: c.drivers, verifyLogic: c.verifyLogic,
      limitUpCount: c.count, hasLayer: c.hasLayer, midCapChangePct: c.midCapChangePct,
      evidenceComplete: c.evidenceComplete,
    };
  });

  const notes = [
    '消息级别与性质由「来源名称 + 标题关键词」推断，未经公告原文核验；自媒体小作文一律标「传闻/未核验」。联网搜索只作线索触发器，不替代行情数据与公告核验。',
    '「中军表现」以涨停池内流通市值居前个股作代理，工作台无板块成分股/市值/趋势行情映射；代理样本缺失时 S 级不成立，自动降为 A 并写明证据缺口。',
    `题材阶段基于前 3-5 个交易日同口径「按所属行业聚合的涨停家数」序列，有效对照点 < ${TOPIC_TH.stageMinPoints} 时输出「${NO_COMPARISON}」，禁止把单日数据当趋势。`,
    '工作台新闻源为实时 7×24 快讯，无法证明某题材「当日无消息」；因此「无匹配线索」记为消息面证据缺失，四象限判「无法判断」而非「双弱」，不整批剔除候选（避免空白模板）。',
    'S 级六项证据：国家级/产业级线索 + 启动或良性发酵 + 涨停≥5 家 + 连板核心 + 中军代理大阳线 + 板块有层次；缺任一证据不得评 S。',
    'C 级诱多陷阱需同时具备「利好兑现/退潮阶段」与「中军代理走弱或龙头独舞」客观证据，不因单日下跌直接判 C。',
    '驱动标签 D1 技术 / D2 消息 / D3 资金 / D4 基本面；D4 因复盘链路未接入财报与估值数据恒不标注，不以新闻标题冒充基本面证据。',
    '封板时间分桶口径：首次封板时间 ≤10:00 为早盘、10:00-14:00 为盘中、≥14:00 为尾盘，非法值计入 unknown；仅反映封板节奏，不单独证明资金性质。',
    '成交额、龙虎榜、涨停时间只反映交易活跃度，不能单独证明机构进场或资金出逃；亏钱效应收敛只代表压力缓解，不等于买点出现。',
    '本卡片是线索归因与验证清单，不是买入发令枪；观察池是验证市场风向的样本，不构成任何操作建议。',
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    date: ctx.date,
    histDates: ctx.histDates,
    cards,
    voteSummary,
    quadrantSummary,
    gradeSummary,
    dominantVote,
    dominantQuadrant,
    topicByIndustry,
    sealTimeSummary: sealTime
      ? `全市场首次封板时间：早盘 ${sealTime.early} / 盘中 ${sealTime.mid} / 尾盘 ${sealTime.late} / 无法解析 ${sealTime.unknown}（共 ${sealTime.total} 家）`
      : MISSING,
    limitDownSummary: limitDown
      ? `跌停股 ${limitDown.count} 家，平均涨跌幅 ${pct(limitDown.avgChgPct)}；行业分布 ${list(limitDown.industryDist).slice(0, 3).map(x => `${x.industry} ${x.count}`).join('、') || MISSING}`
      : MISSING,
    amtTrend,
    notes,
    keyMissingTop3: [
      { field: '板块中军 / 趋势股真实行情', why: 'S 级「中军大阳线」与 R-S5 无法完整判定，现用涨停池内大市值代理' },
      { field: '官方公告原文与催化时间窗', why: '消息级别仅能按来源名推断，无法核验公告真伪与首发时间' },
      { field: '板块涨幅榜与资讯的结构化关联', why: '题材归因依赖行业名/关键词匹配，覆盖率有限' },
    ],
  };
}

module.exports = {
  analyzeTopics, trendOf, matchByName, matchNews, newsLevelOf, stageOf, midCapOf, normInput,
  SCHEMA_VERSION, TOPIC_TH, DRIVER_DEFS, INDUSTRY_KEYWORDS, MISSING, NO_COMPARISON,
};
