/**
 * lib/reviewEngines.js — 每日复盘「机会识别引擎 / 风险识别引擎」（20261108a → 20261108d）
 * ==========================================================================
 * 用户新框架落地要点：
 *  - 四段式：事实 → 判断（机会/风险分类+等级）→ 次日验证条件 → 判断不成立信号。
 *  - 机会：O1-O5 分类、L1-L5 五层漏斗、C1-C8 确认清单、V1-V8 否决清单、A/B/C/D 评级。
 *  - 驱动标签：D1 技术 / D2 消息 / D3 资金 / D4 基本面（D4 无本机源，恒不标注）。
 *  - 中和过滤：接入 lib/topicEngines.js 的「技术面 × 消息面」四象限结论
 *    （共振不处理 / 背离降级 C / 先觉降一级 / 双弱剔除 D / 无法判断不额外升降级）。
 *  - 风险：R-M1~R-M4（市场级）/ R-S1~R-S5（板块级）/ R-I1~R-I5（个股级）。
 *  - 持续性判断必须取前 3-5 个交易日对照；对照不足写「缺少对照，暂不作持续性判断」。
 *
 * 【架构铁律】工作台「代码权威」：分类、漏斗、确认、否决、评级、风险等级全部是确定性规则，
 *   由本文件纯函数从真实采集值计算；LLM 不参与任何推导，只做（可选的）叙述复述。
 *   本文件零 require、零 I/O、零网络，可独立单测。
 *
 * 【诚实边界】数据缺失一律返回 null（未知），绝不返回 false（未通过）或臆造数值。
 *   未知项不计入确认清单命中数，也不命中否决项，但会在 evidence/reason 中标注「缺失」。
 *   这会让多数候选落在 C 级「仅观察」——这是数据不足时的正确结论，不是缺陷。
 *
 * 【口径声明】（复盘「数据完整性与口径」段须披露）
 *  - 大面股 = 昨日涨停股今日涨跌幅 <= -5%（工作台自定义代理口径，非交易所定义）。
 *  - 流动性不足阈值 = 个股成交额 < 1.0 亿元（工作台自定义阈值）。
 *  - 中军/趋势股、个股多日成交额序列、公告催化时间窗、题材新旧：
 *    工作台暂无可靠本机源 → 相关项恒为「缺失」，不由涨停池数据反推。
 *  - 成交额样本仅覆盖涨停池 + 强势股池，不代表两市成交额排名。
 *  - 新闻标题只作催化线索（附来源时间），不构成公告核验，不单独决定分类。
 */
'use strict';

const MISSING = '缺失';
const NO_COMPARISON = '缺少对照，暂不作持续性判断';

// 阈值集中定义，便于复盘附录统一披露
const TH = {
  bigDropPct: -5,          // 大面股代理阈值
  redRateWeak: 40,         // 昨日涨停今日红盘率低于此值视为接力弱（%）
  limitUpDropPct: -20,     // 涨停家数较前一日降幅超过此值视为收缩（%）
  liquidityMinYi: 1.0,     // 流动性不足阈值（亿元）
  highBoard: 5,            // 连续加速代理：连板数 >= 5
  trendMinPoints: 3,       // 持续性判断最少有效对照点
  bigDropRateHigh: 30,     // 当日大面股占比过高（%）
  promotionWeak: 20,       // 1进2 晋级率低于此值视为接力弱（%）
};

const OPPORTUNITY_CATEGORIES = {
  O1: '宏观/政策驱动',
  O2: '行业景气驱动',
  O3: '事件驱动',
  O4: '资金/情绪驱动',
  O5: '估值/错杀修复',
  MIX: '混合型',
};

// 新闻标题关键词线索（仅用于催化线索，不参与评级硬证据）
const CATALYST_KEYWORDS = {
  O1: ['政策', '国务院', '央行', '发改委', '财政部', '降准', '降息', '补贴', '规划', '会议', '部署'],
  O2: ['涨价', '提价', '订单', '库存', '渗透率', '产能', '景气', '需求', '销量', '价格'],
  O3: ['重组', '回购', '业绩预告', '中标', '新品', '发布', '签约', '收购', '增持', '获批'],
  O5: ['错杀', '低估', '估值', '周期底部', '预期差', '修复'],
};

const CONFIRM_DEFS = [
  { code: 'C1', label: '有明确催化剂或数据支撑' },
  { code: 'C2', label: '板块内部有层次（领涨+跟随+中军）' },
  { code: 'C3', label: '资金活跃≥2个交易日' },
  { code: 'C4', label: '梯队/板块未出现明显断层' },
  { code: 'C5', label: '回撤有承接或未出现高位负反馈' },
  { code: 'C6', label: '位置/拥挤度未极端' },
  { code: 'C7', label: '量价结构健康（放量突破/缩量踩支撑，非高位放量滞涨）' },
  { code: 'C8', label: '消息仍在催化/发酵期（非兑现退潮）' },
];

const VETO_DEFS = [
  { code: 'V1', label: '仅一只个股涨停、板块无跟随' },
  { code: 'V2', label: '成交额仅单日放大、次日无量' },
  { code: 'V3', label: '高位股断板后大幅走弱且扩散' },
  { code: 'V4', label: '大面股数量较前几日明显增多' },
  { code: 'V5', label: '催化剂已充分兑现、股价已连续加速' },
  { code: 'V6', label: '流动性不足' },
  { code: 'V7', label: '高位顶背离+放量滞涨+板块不跟' },
  { code: 'V8', label: '消息兑现+龙头独舞' },
];

const DRIVER_DEFS = { D1: '技术', D2: '消息', D3: '资金', D4: '基本面' };

const RISK_DEFS = {
  market: [
    { code: 'R-M1', label: '整体情绪转弱' },
    { code: 'R-M2', label: '亏钱效应扩散' },
    { code: 'R-M3', label: '赚钱效应收缩' },
    { code: 'R-M4', label: '量能萎缩或仅小票热闹' },
  ],
  sector: [
    { code: 'R-S1', label: '单票独舞，无跟随' },
    { code: 'R-S2', label: '梯队断层' },
    { code: 'R-S3', label: '高位股断板后负反馈扩散' },
    { code: 'R-S4', label: '老题材无新推动因素、资金撤离' },
    { code: 'R-S5', label: '板块内部分化，中军/趋势股走弱' },
  ],
  individual: [
    { code: 'R-I1', label: '高位爆量滞涨或冲高回落' },
    { code: 'R-I2', label: '断板后大幅走弱且无修复' },
    { code: 'R-I3', label: '催化剂已兑现、股价已加速' },
    { code: 'R-I4', label: '流动性不足' },
    { code: 'R-I5', label: '突发个股问题（公告/监管/业绩）' },
  ],
};

// ---------- 基础工具（全部纯函数） ----------
function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function pct(v, digits) {
  const n = num(v);
  return n == null ? MISSING : (n >= 0 ? '+' : '') + n.toFixed(digits == null ? 2 : digits) + '%';
}
function fixed(v, digits) { const n = num(v); return n == null ? MISSING : n.toFixed(digits == null ? 2 : digits); }
function yi(v) { // 元 → 亿元
  const n = num(v);
  return n == null ? null : Math.round(n / 1e8 * 100) / 100;
}
function tri(v, yes, no) { return v === true ? yes : v === false ? no : MISSING; }

/**
 * 序列趋势：扩散 / 收缩 / 持平 / 无法判断。
 * 有效点不足 TH.trendMinPoints 时一律返回「无法判断」+ NO_COMPARISON 说明，
 * 禁止把单日数据当趋势（用户硬性规则）。
 */
function trendOf(series, key, opts) {
  const o = opts || {};
  const minPoints = o.minPoints || TH.trendMinPoints;
  const arr = Array.isArray(series) ? series : [];
  const vals = arr.map(r => (r && num(r[key]) != null ? num(r[key]) : null)).filter(v => v != null);
  if (vals.length < minPoints) {
    return { direction: '无法判断', points: vals.length, values: vals, note: NO_COMPARISON, ok: false };
  }
  const half = Math.floor(vals.length / 2);
  const early = vals.slice(0, half);
  const late = vals.slice(-half);
  const avg = a => a.reduce((s, x) => s + x, 0) / a.length;
  const a = avg(early), b = avg(late);
  const chg = a !== 0 ? (b - a) / Math.abs(a) * 100 : null;
  const threshold = o.threshold == null ? 10 : o.threshold;
  const direction = chg == null ? '无法判断'
    : chg > threshold ? '扩散'
      : chg < -threshold ? '收缩' : '持平';
  return {
    direction, points: vals.length, values: vals,
    changePct: chg == null ? null : Math.round(chg * 100) / 100,
    note: `前 ${vals.length} 个有效对照点，前后半段均值 ${fixed(a)} → ${fixed(b)}（${pct(chg)}），阈值 ±${threshold}%`,
    ok: true,
  };
}

/** 四段式结论构造（唯一出口，保证每条核心判断都有验证条件与不成立信号） */
function quad(subject, fact, judgment, verify, invalidate, extra) {
  return Object.assign({
    subject: String(subject || ''),
    fact: String(fact || MISSING),
    judgment: String(judgment || MISSING),
    verify: String(verify || MISSING),
    invalidate: String(invalidate || MISSING),
  }, extra || {});
}

function riskItem(def, level, fact, observe, clear, evidence) {
  return {
    code: def.code, title: def.label,
    level: level || '无法判断',
    fact: String(fact || MISSING),
    observe: String(observe || MISSING),
    clear: String(clear || MISSING),
    evidence: evidence || [],
  };
}

// ---------- 输入归一化 ----------
function normInput(input) {
  const i = input || {};
  const hist = Array.isArray(i.historySeries) ? i.historySeries.filter(Boolean) : [];
  return {
    date: i.date || MISSING,
    histDates: Array.isArray(i.histDates) ? i.histDates : [],
    breadth: i.breadth || null,
    ladder: i.ladder || null,
    prevPool: (i.prevPool && i.prevPool.ok) ? i.prevPool : null,
    sectors: (i.sectors && i.sectors.ok) ? i.sectors : null,
    activity: (i.activity && i.activity.ok) ? i.activity : null,
    historySeries: hist,
    news: Array.isArray(i.news) ? i.news : [],
    lhb: i.lhb || null,
    sectorFlow: i.sectorFlow || null,
    mainFund: i.mainFund || null,
    quote: i.quote || null,
    // 20261108d：热点归因 / 四象限中和结论（lib/topicEngines.js 的 analyzeTopics 输出）
    topics: i.topics || null,
  };
}

// ---------- 新闻催化线索（只作线索，不单独决定分类） ----------
function catalystClues(subject, news) {
  const hits = [];
  const text = String(subject || '');
  for (const n of news || []) {
    const title = String((n && n.title) || '');
    if (!title || !text || !title.includes(text)) continue;
    for (const [code, words] of Object.entries(CATALYST_KEYWORDS)) {
      if (words.some(w => title.includes(w))) {
        hits.push({ code, title, source: String((n && n.source) || MISSING), date: String((n && n.date) || MISSING) });
      }
    }
  }
  return hits.slice(0, 3);
}

/**
 * O1-O5 分类。工作台客观证据只有 O4（连板梯队/板块联动/成交额集中）能稳定取得；
 * 其它类别必须命中带来源时间的新闻关键词线索，否则不硬猜。
 */
function classifyOpportunity(cand, ctx) {
  const clues = catalystClues(cand.matchText || cand.name, ctx.news);
  const nonO4 = clues.filter(c => c.code !== 'O4');
  const hasO4Evidence = cand.boards != null || cand.layer === true || cand.amountYi != null;
  if (!hasO4Evidence && !nonO4.length) {
    return {
      code: 'MIX', label: OPPORTUNITY_CATEGORIES.MIX, leading: '数据不足',
      reason: '既无连板/板块/成交额客观证据，也无催化线索；未做实质分类', clues,
    };
  }
  if (nonO4.length && hasO4Evidence) {
    const lead = nonO4[0];
    return {
      code: 'MIX', label: OPPORTUNITY_CATEGORIES.MIX, leading: lead.code,
      reason: `同时命中 ${lead.code} 催化线索与 O4 客观行情证据；主导类型 ${lead.code}（${OPPORTUNITY_CATEGORIES[lead.code]}）`,
      clues,
    };
  }
  if (nonO4.length) {
    const lead = nonO4[0];
    return {
      code: lead.code, label: OPPORTUNITY_CATEGORIES[lead.code], leading: lead.code,
      reason: `命中 ${lead.code} 新闻催化线索（附来源时间，非公告核验）`, clues,
    };
  }
  return {
    code: 'O4', label: OPPORTUNITY_CATEGORIES.O4, leading: 'O4',
    reason: '仅取得连板梯队/板块联动/成交额客观证据；政策、景气、事件、估值类催化数据缺失',
    clues,
  };
}

// ---------- 五层漏斗 ----------
function funnelOf(cand, ctx) {
  const L = {};
  const b = ctx.breadth;
  const lu = b ? num(b.limitUp) : null;
  const ld = b ? num(b.limitDown) : null;
  const up = b ? num(b.up) : null;
  const down = b ? num(b.down) : null;
  if (lu == null || ld == null || up == null || down == null) {
    L.L1 = { passed: null, reason: `今日成交额/涨跌家数/涨停跌停数据${MISSING}` };
  } else {
    const ok = lu > ld && up > down;
    L.L1 = { passed: ok, reason: `涨停 ${lu} / 跌停 ${ld}，涨 ${up} / 跌 ${down}（口径：涨停多于跌停且上涨家数多于下跌家数）` };
  }

  if (cand.layer == null) L.L2 = { passed: null, reason: `板块层次数据${MISSING}（中军/趋势股无可靠本机源）` };
  else L.L2 = { passed: cand.layer === true, reason: cand.layer ? '所属板块存在领涨+跟随的客观层次' : '所属板块仅单只涨停，判「单票独舞」' };

  if (cand.boards == null) L.L3 = { passed: null, reason: `个股定位与连板高度数据${MISSING}` };
  else L.L3 = {
    passed: cand.boards >= 2,
    reason: cand.boards >= 2
      ? `连板高度 ${cand.boards} 板，属领涨/高位样本`
      : '首板且位于跟随位，属跟风样本；基本面支撑数据' + MISSING,
  };

  if (cand.catalyst == null) L.L4 = { passed: null, reason: `明确催化剂或数据支撑${MISSING}` };
  else L.L4 = { passed: true, reason: cand.catalyst };

  // L5：个股多日成交额序列工作台暂无；只能用全市场涨停池成交额作市场级代理，并明确标注。
  const t = trendOf(ctx.historySeries, 'ztAmountYi');
  if (!t.ok) L.L5 = { passed: null, reason: `资金活跃持续性${MISSING}：个股多日成交额序列无本机源；${NO_COMPARISON}` };
  else L.L5 = {
    passed: t.direction !== '收缩',
    reason: `市场级代理口径：涨停池成交额 ${t.note}（非个股多日成交额；单日热闹与连续活跃不可由此完全区分）`,
  };

  const known = Object.values(L).filter(x => x.passed != null);
  return {
    layers: L,
    passedAll: known.length === 5 && known.every(x => x.passed === true),
    explicitFail: Object.values(L).some(x => x.passed === false),
    unknownCount: Object.values(L).filter(x => x.passed == null).length,
  };
}

// ---------- 热点归因 / 四象限 / 驱动标签（20261108d） ----------
function topicOf(cand, ctx) {
  const by = ctx.topics && ctx.topics.topicByIndustry;
  if (!by || !cand || !cand.industry || cand.industry === MISSING) return null;
  return by[cand.industry] || null;
}
function driversOf(cand, tp) {
  const tags = [];
  if (cand.boards != null || cand.layer != null) tags.push('D1');
  if (tp && tp.newsLevel && tp.newsLevel !== MISSING) tags.push('D2');
  if (cand.amountYi != null || (tp && String(tp.drivers || '').includes('D3'))) tags.push('D3');
  // D4 基本面：复盘链路未接入财报/估值数据，恒不标注（口径见 caliberNotes）。
  return tags.length ? tags.join('/') : MISSING;
}

// ---------- 确认清单 C1-C8 ----------
function confirmOf(cand, ctx) {
  const C = {};
  C.C1 = cand.catalyst == null
    ? { hit: null, reason: `催化剂与数据支撑均${MISSING}` }
    : { hit: true, reason: cand.catalyst };
  C.C2 = cand.layer == null
    ? { hit: null, reason: `板块内部层次${MISSING}（中军/趋势股无可靠本机源）` }
    : { hit: cand.layer, reason: cand.layer ? '领涨+跟随客观成立' : '板块仅单只涨停，无跟随' };
  // C3：个股多日成交额序列无本机源；全市场代理不能冒充个股级证据。
  C.C3 = { hit: null, reason: `个股资金活跃≥2交易日${MISSING}（工作台无个股多日成交额序列，不以全市场代理冒充）` };
  const gap = ctx.ladder ? ctx.ladder.hasGap : null;
  C.C4 = gap == null
    ? { hit: null, reason: `梯队断层数据${MISSING}` }
    : { hit: gap === false, reason: gap ? `梯队存在断层（缺 ${(ctx.ladder.gapAt || []).join('、')} 板档）` : '梯队未出现明显断层' };
  const pp = ctx.prevPool;
  if (!pp || num(pp.bigDropRate) == null) {
    C.C5 = { hit: null, reason: `高位负反馈数据${MISSING}` };
  } else {
    const bad = num(pp.bigDropRate) <= TH.bigDropRateHigh;
    C.C5 = {
      hit: bad,
      reason: `昨日涨停股今日大幅回落占比 ${fixed(pp.bigDropRate)}%（阈值 ${TH.bigDropRateHigh}%，工作台自定义大面股代理口径）`,
    };
  }
  if (cand.boards == null) C.C6 = { hit: null, reason: `连板高度${MISSING}` };
  else C.C6 = {
    hit: cand.boards < TH.highBoard,
    reason: `连板 ${cand.boards} 板；以 ≥${TH.highBoard} 板作「连续加速」代理，「全员讨论」热度数据${MISSING}`,
  };
  // C7：量价结构需要个股多日量价序列，工作台无可靠本机源 → 恒「缺失」，
  // 不以封板时间、单日成交额等其它口径冒充（诚实边界）。
  C.C7 = { hit: null, reason: `个股多日量价序列${MISSING}，无法判定「放量突破 / 缩量踩支撑 / 高位放量滞涨」` };
  // C8：由热点归因引擎的多日行业涨停家数序列确定性给出，是本轮唯一新增的真实可证确认项。
  const tp = topicOf(cand, ctx);
  if (!tp || !tp.stage) {
    C.C8 = { hit: null, reason: `题材阶段（催化/发酵 vs 兑现/退潮）数据${MISSING}` };
  } else if (tp.stage === '启动期' || tp.stage === '发酵/主升期') {
    C.C8 = { hit: true, reason: `题材处于 ${tp.stage}（${tp.stageReason}）` };
  } else if (tp.stage === '高潮/退潮期') {
    C.C8 = { hit: false, reason: `题材处于 ${tp.stage}，催化已兑现（${tp.stageReason}）` };
  } else {
    C.C8 = { hit: null, reason: `题材阶段：${tp.stage}；${tp.stageReason}` };
  }
  const count = Object.values(C).filter(x => x.hit === true).length;
  return { items: C, count, unknown: Object.values(C).filter(x => x.hit == null).length };
}

// ---------- 否决清单 V1-V8 ----------
// 否决项分级（口径披露见 caliberNotes）：
//  - 个股级硬否决 V1/V2/V6：标的一本身不合格 → D 剔除，不进汇总表。
//  - 市场级/位置级/消息级软否决 V3/V4/V5/V7/V8：按规格「不得进入可跟踪」降级为 C「仅观察」，
//    不整批剔除；否则一次高位负反馈或消息退潮就会让汇总表与观察池全空，等于输出空白模板。
//    这是对规格「降级或剔除」二选一的显式取舍，不是放宽标准：软否决命中后永远不能评 A/B。
const HARD_VETO = new Set(['V1', 'V2', 'V6']);
const SOFT_VETO = new Set(['V3', 'V4', 'V5', 'V7', 'V8']);

function vetoOf(cand, ctx) {
  const hits = [];
  const unknown = [];
  const sec = ctx.sectors;
  const singles = sec && Array.isArray(sec.singleDance) ? sec.singleDance : null;
  if (!singles) unknown.push('V1：板块跟随数据' + MISSING);
  else if (cand.industry && singles.includes(cand.industry)) {
    hits.push({ code: 'V1', reason: `${cand.industry} 板块仅 1 只涨停，无跟随` });
  }
  unknown.push('V2：个股多日成交额序列' + MISSING + '，无法判断「单日放大、次日无量」');

  const pp = ctx.prevPool;
  const highBreak = pp && Array.isArray(pp.topLosers)
    ? pp.topLosers.filter(x => num(x.prevBoards) >= 3 && num(x.chgPct) <= TH.bigDropPct)
    : [];
  if (pp && highBreak.length >= 2) {
    hits.push({ code: 'V3', reason: `昨日 3 板以上高位股今日大幅回落 ${highBreak.length} 只（${highBreak.slice(0, 3).map(x => x.name).join('、')}），负反馈已扩散` });
  } else if (!pp) unknown.push('V3：昨日涨停股今日表现' + MISSING);

  unknown.push('V4：前几日大面股序列' + MISSING + '，无法判断「较前几日明显增多」；仅能观察当日大面股占比');
  if (cand.boards != null && cand.boards >= TH.highBoard) {
    hits.push({ code: 'V5', reason: `连板 ${cand.boards} 板达到连续加速代理阈值；催化剂兑现时间窗数据${MISSING}，按位置极值处理` });
  }
  if (cand.amountYi == null) unknown.push('V6：个股成交额' + MISSING);
  else if (cand.amountYi < TH.liquidityMinYi) {
    hits.push({ code: 'V6', reason: `成交额 ${fixed(cand.amountYi)} 亿元 < ${TH.liquidityMinYi} 亿元（工作台自定义流动性阈值）` });
  }
  // V7 三项需同时成立（高位顶背离 + 放量滞涨 + 板块不跟）；前两项依赖个股多日量价 → 恒未知。
  unknown.push('V7：个股多日量价序列' + MISSING + '，无法判定顶背离/放量滞涨；板块不跟单独不构成 V7');
  // V8：题材阶段（来自多日行业涨停家数序列）+ 龙头独舞（单票独舞名单 / 涨停仅 1 家）。
  const tp = topicOf(cand, ctx);
  const singleHit = !!(singles && cand.industry && singles.includes(cand.industry));
  if (!tp || !tp.stage) unknown.push('V8：题材阶段 / 消息兑现数据' + MISSING);
  else if (tp.stage === '高潮/退潮期' && (singleHit || num(tp.limitUpCount) === 1)) {
    hits.push({
      code: 'V8',
      reason: `题材处于 ${tp.stage} 且龙头独舞（涨停 ${tp.limitUpCount == null ? MISSING : tp.limitUpCount} 家${singleHit ? ' / 单票独舞名单命中' : ''}），消息兑现后无跟随`,
    });
  }
  const hard = hits.filter(h => HARD_VETO.has(h.code));
  const soft = hits.filter(h => SOFT_VETO.has(h.code));
  return {
    hits, hardHits: hard, softHits: soft, unknown,
    hasVeto: hits.length > 0, hasHardVeto: hard.length > 0,
  };
}

// ---------- 机会评级 ----------
function gradeOf(cand, ctx) {
  const cls = classifyOpportunity(cand, ctx);
  const funnel = funnelOf(cand, ctx);
  const confirm = confirmOf(cand, ctx);
  const veto = vetoOf(cand, ctx);
  const marketHigh = ctx.marketRiskLevel === '高';
  let grade, reason;
  if (veto.hasHardVeto) {
    grade = 'D';
    reason = `命中个股级硬否决 ${veto.hardHits.map(v => v.code).join('、')}，剔除出观察池`;
  } else if (veto.softHits.length) {
    grade = 'C';
    reason = `命中市场级/位置级否决 ${veto.softHits.map(v => v.code).join('、')}，按「不得进入可跟踪」降级为 C 仅观察（不剔除，避免空白模板）`;
  } else if (funnel.explicitFail) {
    grade = 'C';
    const failed = Object.entries(funnel.layers)
      .filter(([, v]) => v.passed === false).map(([k]) => k).join('、');
    reason = `五层漏斗 ${failed} 层明确未通过，降级为仅观察（确认 ${confirm.count} 项）`;
  } else if (funnel.passedAll && confirm.count >= 5) {
    grade = marketHigh ? 'B' : 'A';
    reason = marketHigh ? '五层全过且确认≥5项，但市场级风险偏高，按规则降一级' : '五层全过 + 确认≥5项 + 无否决项';
  } else if (confirm.count >= 4) {
    grade = marketHigh ? 'C' : 'B';
    reason = marketHigh ? '确认≥4项，但市场级风险偏高，按规则降一级' : '确认清单≥4项 + 无否决项';
  } else {
    grade = 'C';
    reason = `确认清单仅 ${confirm.count} 项（<4），仅观察；其中 ${confirm.unknown} 项因数据缺失未计入`;
  }

  // 20261108d 中和过滤：接入热点归因引擎的「技术面 × 消息面」四象限。
  // 「无法判断」不额外升降级 —— 工作台新闻流是实时快讯，不能证明某题材「当日无消息」，
  // 因此不把证据缺失误判成「双弱」而整批剔除（避免空白模板）。
  const tp = topicOf(cand, ctx);
  const quadrant = tp ? tp.quadrant : '无法判断';
  if (tp && grade !== 'D') {
    if (quadrant === '双弱') {
      grade = 'D';
      reason += '；四象限判定「双弱」（无催化无量价），按规格剔除出可跟踪候选';
    } else if (quadrant === '背离' && (grade === 'A' || grade === 'B')) {
      grade = 'C';
      reason += '；四象限判定「消息强 + 技术弱」背离，降级为仅观察（防诱多）';
    } else if (quadrant === '先觉' && (grade === 'A' || grade === 'B')) {
      const before = grade;
      grade = before === 'A' ? 'B' : 'C';
      reason += `；四象限判定「消息弱 + 技术强」先觉，按规格降一级（${before} → ${grade}，防无源之水）`;
    }
  }
  return {
    ...cand,
    category: cls.code === 'MIX' ? `混合型（主导 ${cls.leading}）` : `${cls.code} ${cls.label}`,
    categoryCode: cls.code,
    classificationReason: cls.reason,
    clues: cls.clues,
    grade, gradeReason: reason,
    funnel, confirm, veto,
    quadrant, quadrantAction: tp ? tp.quadrantAction : '消息面证据缺失，不因象限额外升降级',
    drivers: driversOf(cand, tp),
    topicStage: tp ? tp.stage : MISSING,
    trackable: grade === 'A' || grade === 'B',
  };
}

// ---------- 候选生成（全部来自真实采集值，不臆造标的） ----------
function buildCandidates(ctx) {
  // 个股与板块分别限额：早期版本共用一个 24 上限，真实交易日个股候选多时
  // 会把板块级候选全部挤出，导致「板块结构与机会分类」段没有可分类对象。
  const stocks = [];
  const sectors = [];
  const out = stocks;
  const L = ctx.ladder;
  const sec = ctx.sectors;
  const act = ctx.activity;
  const pp = ctx.prevPool;

  const amountByCode = {};
  for (const x of (act && Array.isArray(act.topAmount) ? act.topAmount : [])) {
    if (x && x.code) amountByCode[String(x.code)] = num(x.amountYi); // 契约：amountYi 单位亿元
  }
  const layerByIndustry = {};
  for (const s of (sec && Array.isArray(sec.top) ? sec.top : [])) {
    if (s && s.industry) layerByIndustry[String(s.industry)] = s;
  }

  if (L && Array.isArray(L.tiers)) {
    for (const t of L.tiers) {
      for (const s of (t.stocks || []).slice(0, 8)) {
        if (!s || !s.code) continue;
        const ind = String(s.industry || '');
        const secInfo = layerByIndustry[ind];
        out.push({
          name: s.name, code: s.code, scope: 'stock', industry: ind || MISSING,
          matchText: s.name, boards: num(t.boards),
          layer: secInfo ? secInfo.hasLayer : null,
          amountYi: amountByCode[String(s.code)] != null ? amountByCode[String(s.code)] : null,
          catalyst: num(t.boards) >= 2 ? `连板 ${t.boards} 板（涨停池客观数据支撑，非公告催化）` : null,
          sourceTag: '连板梯队',
        });
      }
    }
  }
  // 断板修复股：昨日连板、今日仍上涨（客观修复信号，不做方向结论）
  if (pp && Array.isArray(pp.topGainers)) {
    for (const g of pp.topGainers.slice(0, 4)) {
      if (!g || !g.code || out.some(o => o.code === String(g.code))) continue;
      out.push({
        name: g.name, code: String(g.code), scope: 'stock', industry: MISSING,
        matchText: g.name, boards: num(g.prevBoards), layer: null,
        amountYi: null,
        catalyst: `昨日连板 ${g.prevBoards} 板、今日涨跌幅 ${pct(g.chgPct)}（断板修复客观数据支撑）`,
        sourceTag: '断板修复',
      });
    }
  }
  // 成交额活跃样本（低位放量代理；来自涨停池/强势股池局部样本）
  if (act && Array.isArray(act.topAmount)) {
    for (const a of act.topAmount.slice(0, 4)) {
      if (!a || !a.code || out.some(o => o.code === String(a.code))) continue;
      out.push({
        name: a.name, code: String(a.code), scope: 'stock', industry: String(a.industry || MISSING),
        matchText: a.name, boards: 1, layer: null,
        amountYi: num(a.amountYi), // 契约：亿元
        catalyst: `活跃度样本成交额 ${fixed(a.amountYi)} 亿元（仅涨停池/强势股池，非全市场排行）`,
        sourceTag: '活跃样本',
      });
    }
  }
  // 板块级候选
  if (sec && Array.isArray(sec.top)) {
    for (const s of sec.top.slice(0, 5)) {
      if (!s || !s.industry) continue;
      sectors.push({
        name: s.industry, code: '—', scope: 'sector', industry: s.industry,
        matchText: s.industry, boards: num(s.boardsMax), layer: s.hasLayer,
        amountYi: num(s.amountYi),
        catalyst: `板块涨停 ${s.count} 家（涨停池按所属行业聚合，客观数据支撑）`,
        sourceTag: '板块层次',
      });
    }
  }
  return stocks.slice(0, 16).concat(sectors.slice(0, 6));
}

// ---------- 风险识别引擎 ----------
function assessRisks(ctx) {
  const market = [], sector = [], individual = [];
  const D = RISK_DEFS;
  const b = ctx.breadth, L = ctx.ladder, pp = ctx.prevPool, sec = ctx.sectors, act = ctx.activity;
  const hist = ctx.historySeries;
  const tLimitUp = trendOf(hist, 'limitUp');
  const tPromo = trendOf(hist, 'promotionRate');
  const tRed = trendOf(hist, 'prevRedRate');
  const tDown = trendOf(hist, 'limitDown');
  const tAmt = trendOf(hist, 'ztAmountYi');

  // R-M1 整体情绪转弱
  {
    const lu = b ? num(b.limitUp) : null, ld = b ? num(b.limitDown) : null;
    const red = pp ? num(pp.redRate) : null;
    const weakParts = [];
    if (lu != null && ld != null && lu <= ld) weakParts.push(`涨停 ${lu} ≤ 跌停 ${ld}`);
    if (red != null && red < TH.redRateWeak) weakParts.push(`昨日涨停今日红盘率 ${fixed(red)}% < ${TH.redRateWeak}%`);
    if (tLimitUp.direction === '收缩') weakParts.push(`涨停家数序列${tLimitUp.note}`);
    const level = weakParts.length >= 2 ? '高' : weakParts.length === 1 ? '中' : (lu == null && red == null ? '无法判断' : '低');
    market.push(riskItem(D.market[0], level,
      weakParts.length ? weakParts.join('；') : `涨停 ${lu == null ? MISSING : lu} / 跌停 ${ld == null ? MISSING : ld}，昨日涨停红盘率 ${red == null ? MISSING : fixed(red) + '%'}；${tLimitUp.note}`,
      '次日核对涨停家数是否继续下降、跌停家数是否上升、昨日涨停股红盘率是否低于今日基准',
      '涨停家数回升且跌停家数回落、昨日涨停股红盘率回到 ' + TH.redRateWeak + '% 以上',
      [{ name: '涨停家数趋势', value: tLimitUp.direction }]));
  }
  // R-M2 亏钱效应扩散
  {
    const big = pp ? num(pp.bigDropCount) : null;
    const bigRate = pp ? num(pp.bigDropRate) : null;
    const indSpread = pp && Array.isArray(pp.industryBigDrop) ? pp.industryBigDrop : [];
    const dt = b ? num(b.limitDown) : null;
    const level = bigRate != null && bigRate > TH.bigDropRateHigh ? '高'
      : (big != null && big > 0 ? '中' : (big == null ? '无法判断' : '低'));
    market.push(riskItem(D.market[1], level,
      `大面股（昨日涨停今日涨跌幅≤${TH.bigDropPct}%）${big == null ? MISSING : big + ' 只'}，占比 ${bigRate == null ? MISSING : fixed(bigRate) + '%'}；跌停 ${dt == null ? MISSING : dt} 家；大面股行业分布 ${indSpread.length ? indSpread.slice(0, 3).map(x => `${x.industry} ${x.count} 只`).join('、') : MISSING}；跌停家数序列 ${tDown.direction}（${tDown.note}）`,
      '次日核对大面股数量是否减少、是否仍集中在同一批行业',
      '大面股数量与占比同步回落，且行业分布不再集中',
      [{ name: '跌停家数趋势', value: tDown.direction }]));
  }
  // R-M3 赚钱效应收缩
  {
    const promo = pp && Array.isArray(pp.promotion) ? pp.promotion.find(x => x.from === 1) : null;
    const rate = promo ? num(promo.rate) : null;
    const level = tPromo.direction === '收缩' ? '高'
      : (rate != null && rate < TH.promotionWeak ? '中'
        : (!tPromo.ok && rate == null ? '无法判断' : '低'));
    market.push(riskItem(D.market[2], level,
      `1进2 晋级率 ${rate == null ? MISSING : fixed(rate) + '%'}；连续晋级率序列 ${tPromo.direction}（${tPromo.note}）；昨日涨停红盘率序列 ${tRed.direction}`,
      '次日核对 1进2 晋级率与昨日涨停股红盘率是否继续走低',
      '晋级率与红盘率连续两日回升',
      [{ name: '晋级率趋势', value: tPromo.direction }]));
  }
  // R-M4 量能萎缩或仅小票热闹
  {
    const amt = act ? num(act.ztAmountYi) : null;
    const level = tAmt.direction === '收缩' ? '高'
      : (tAmt.direction === '持平' ? '中' : (!tAmt.ok ? '无法判断' : '低'));
    market.push(riskItem(D.market[3], level,
      `涨停池成交额合计 ${amt == null ? MISSING : fixed(amt) + ' 亿元'}；序列 ${tAmt.note}；全市场成交额靠前个股排行${MISSING}（接口为实时快照、口径日不符，未采用）`,
      '次日核对涨停池成交额是否继续萎缩、活跃是否仍集中在少数样本',
      '涨停池成交额回升且活跃样本扩散',
      [{ name: '涨停池成交额趋势', value: tAmt.direction }]));
  }

  // R-S1 单票独舞
  {
    const singles = sec && Array.isArray(sec.singleDance) ? sec.singleDance : null;
    const level = singles == null ? '无法判断' : singles.length >= 5 ? '高' : singles.length > 0 ? '中' : '低';
    sector.push(riskItem(D.sector[0], level,
      `仅 1 只涨停的行业 ${singles == null ? MISSING : singles.length + ' 个'}${singles && singles.length ? '（' + singles.slice(0, 5).join('、') + '）' : ''}`,
      '次日核对这些行业是否出现第二只跟随涨停',
      '出现跟随个股或该行业退出涨停样本',
      []));
  }
  // R-S2 梯队断层
  {
    const gap = L ? L.hasGap : null;
    const level = gap == null ? '无法判断' : gap ? '中' : '低';
    sector.push(riskItem(D.sector[1], level,
      gap == null ? `梯队断层数据${MISSING}` : gap
        ? `最高 ${L.maxBoards} 板，缺 ${(L.gapAt || []).join('、')} 板档`
        : `最高 ${L.maxBoards == null ? MISSING : L.maxBoards} 板，梯队未出现断层`,
      '次日核对缺口板档是否被补齐、最高板是否继续晋级',
      '梯队各板档补齐且最高板维持',
      []));
  }
  // R-S3 高位股断板负反馈扩散
  {
    const losers = pp && Array.isArray(pp.topLosers) ? pp.topLosers : null;
    const high = losers ? losers.filter(x => num(x.prevBoards) >= 3 && num(x.chgPct) <= TH.bigDropPct) : [];
    const level = !losers ? '无法判断' : high.length >= 2 ? '高' : high.length === 1 ? '中' : '低';
    sector.push(riskItem(D.sector[2], level,
      !losers ? `昨日高位股今日表现${MISSING}`
        : `昨日 3 板以上、今日跌幅≤${TH.bigDropPct}% 的高位股 ${high.length} 只${high.length ? '（' + high.slice(0, 3).map(x => x.name).join('、') + '）' : ''}`,
      '次日核对高位断板股是否继续走弱、是否扩散到同板块其他个股',
      '高位断板股止跌且同板块未出现新的大幅回落',
      []));
  }
  // R-S4 老题材无新推动：题材新旧判定无本机源
  sector.push(riskItem(D.sector[3], '无法判断',
    `题材新旧与「新推动因素」判定所需的历史题材标注/公告时间窗数据${MISSING}；不作持续性判断`,
    '补充题材首现日期与催化公告时间窗后再核对',
    '数据补齐后方可判定',
    []));
  // R-S5 板块内部分化、中军走弱
  {
    const top = sec && Array.isArray(sec.top) ? sec.top : null;
    const weak = top ? top.filter(s => s.hasLayer === false) : [];
    const level = !top ? '无法判断' : weak.length >= 3 ? '中' : '低';
    sector.push(riskItem(D.sector[4], level,
      `板块层次客观代理：${top == null ? MISSING : top.length + ' 个活跃行业中 ' + weak.length + ' 个无层次（仅领涨无跟随）'}；中军/趋势股表现${MISSING}（无可靠本机源）`,
      '次日核对活跃板块内是否出现更多跟随个股',
      '板块内跟随家数增加、层次恢复',
      []));
  }

  // R-I1 高位爆量滞涨：需个股多日量价
  individual.push(riskItem(D.individual[0], '无法判断',
    `个股多日量价序列${MISSING}，无法判定「爆量滞涨/冲高回落」；涨停池仅提供当日炸板次数`,
    '补充个股近 3-5 日量价后再核对',
    '数据补齐后方可判定', []));
  // R-I2 断板后大幅走弱且无修复（个股级，真实可算）
  {
    const losers = pp && Array.isArray(pp.topLosers) ? pp.topLosers : null;
    const bad = losers ? losers.filter(x => num(x.chgPct) <= TH.bigDropPct) : [];
    const level = !losers ? '无法判断' : bad.length >= 3 ? '高' : bad.length > 0 ? '中' : '低';
    individual.push(riskItem(D.individual[1], level,
      !losers ? `昨日涨停股今日表现${MISSING}`
        : `昨日涨停、今日跌幅≤${TH.bigDropPct}% 的个股 ${bad.length} 只${bad.length ? '（' + bad.slice(0, 3).map(x => `${x.name} ${pct(x.chgPct)}`).join('、') + '）' : ''}`,
      '次日核对这批个股是否继续走弱或出现修复',
      '断板个股止跌回升且未再创新低', []));
  }
  // R-I3 催化剂兑现 + 股价加速
  {
    const maxB = L ? num(L.maxBoards) : null;
    const level = maxB == null ? '无法判断' : maxB >= TH.highBoard ? '中' : '低';
    individual.push(riskItem(D.individual[2], level,
      `最高连板 ${maxB == null ? MISSING : maxB + ' 板'}；催化剂公告级别与兑现时间窗${MISSING}（仅以连板高度作「已加速」代理）`,
      '次日核对最高板是否继续加速或首次断板',
      '连板高度回落且未出现断板后大幅走弱', []));
  }
  // R-I4 流动性不足
  {
    const list = act && Array.isArray(act.topAmount) ? act.topAmount : null;
    const thin = list ? list.filter(x => num(x.amountYi) != null && num(x.amountYi) < TH.liquidityMinYi) : [];
    const level = !list ? '无法判断' : thin.length > 0 ? '中' : '低';
    individual.push(riskItem(D.individual[3], level,
      `活跃样本中成交额 < ${TH.liquidityMinYi} 亿元的 ${thin.length} 只（样本仅覆盖涨停池/强势股池）`,
      '次日核对该批个股成交额是否放大',
      '成交额回到阈值之上', []));
  }
  // R-I5 突发个股问题：无公告/监管本机源
  individual.push(riskItem(D.individual[4], '无法判断',
    `个股公告/监管/业绩突发数据源${MISSING}；联网搜索仅用于新闻催化线索，不替代公告核验`,
    '补充公告与监管数据源后再核对',
    '数据补齐后方可判定', []));

  return { market, sector, individual };
}

function marketRiskLevelOf(risks) {
  const all = [].concat(risks.market, risks.sector, risks.individual);
  if (all.some(r => r.level === '高')) return '高';
  if (all.some(r => r.level === '中')) return '中';
  if (all.some(r => r.level === '无法判断')) return '无法判断';
  return '低';
}

// ---------- 主入口 ----------
/**
 * @param {object} raw 由 reviewService 组装的采集值
 * @returns {object} 引擎输出（全部确定性，可直接落盘/渲染）
 */
function analyze(raw) {
  const ctx = normInput(raw);
  // 先算风险（不含市场级降级的初版），再把市场级风险等级回填给机会评级
  const risksFirst = assessRisks(ctx);
  ctx.marketRiskLevel = marketRiskLevelOf(risksFirst);
  const candidates = buildCandidates(ctx).map(c => gradeOf(c, ctx));
  const passed = candidates.filter(c => c.grade !== 'D');
  const rank = { A: 0, B: 1, C: 2, D: 3 };
  passed.sort((a, b) => (rank[a.grade] - rank[b.grade]) || (b.confirm.count - a.confirm.count));
  // 观察池保底：用户要求 3-8 只，但硬凑会变成臆造。优先取个股级候选；
  // 不足 3 只时用板块级候选补足并标注类别，仍不足则如实输出实际数量 + 原因（不输出空白表）。
  let watch = passed.filter(c => c.scope === 'stock').slice(0, 8);
  const watchSectorFill = watch.length < 3
    ? passed.filter(c => c.scope === 'sector').slice(0, 3 - watch.length)
    : [];
  watch = watch.concat(watchSectorFill);
  const dCount = candidates.filter(c => c.grade === 'D').length;
  const watchPoolNote = watch.length < 3
    ? `今日通过漏斗的候选仅 ${watch.length} 个（<3）：${candidates.length === 0
      ? '本次无可用候选数据（相关数据源缺失或取数失败）'
      : `${dCount} 个候选命中个股级硬否决被剔除`}；按「不臆造」原则如实列出，不补足到 3 个。`
    : (watchSectorFill.length ? `个股级合格样本不足 3 个，已用 ${watchSectorFill.length} 个板块级候选补足，并在名称中标注「板块」。` : '');

  const keyMissing = [
    { field: '个股多日成交额 / 量价序列', why: 'C3 资金持续性、L5、R-I1 无法判定' },
    { field: '板块中军 / 趋势股行情', why: 'L2 板块层次、R-S5 无法完整判定' },
    { field: '公告 / 监管 / 题材首现时间窗', why: 'O1-O3/O5 催化分类、R-S4、R-I5 无法判定' },
  ];

  return {
    schemaVersion: 'engine-20261108d',
    date: ctx.date,
    histDates: ctx.histDates,
    marketRiskLevel: ctx.marketRiskLevel,
    trends: {
      limitUp: trendOf(ctx.historySeries, 'limitUp'),
      limitDown: trendOf(ctx.historySeries, 'limitDown'),
      prevRedRate: trendOf(ctx.historySeries, 'prevRedRate'),
      promotionRate: trendOf(ctx.historySeries, 'promotionRate'),
      ztAmountYi: trendOf(ctx.historySeries, 'ztAmountYi'),
    },
    risks: risksFirst,
    candidates,
    opportunityTable: passed.map(c => ({
      name: c.name, code: c.code, scope: c.scope,
      category: c.category, drivers: c.drivers || MISSING, grade: c.grade,
      catalyst: c.catalyst || MISSING,
      layer: c.layer == null ? MISSING : (c.layer ? '有层次' : '单票独舞'),
      capitalContinuity: MISSING,
      confirmCount: c.confirm.count,
      vetoes: c.veto.hits.length ? c.veto.hits.map(v => v.code).join('、') : '无',
      oneLine: c.gradeReason,
      sourceTag: c.sourceTag,
    })),
    watchPool: watch.map(c => ({
      name: c.scope === 'sector' ? `${c.name}（板块）` : c.name, code: c.code,
      categoryGrade: `${c.category} / ${c.grade}级`,
      drivers: c.drivers || MISSING,
      reason: c.catalyst || MISSING,
      sector: c.industry || MISSING,
      watchChange: c.grade === 'A' || c.grade === 'B'
        ? '次日核对板块是否出现更多跟随个股、买盘是否延续'
        : '次日仅核对是否出现跟随个股与成交额变化',
      invalidate: c.topicStage && c.topicStage !== MISSING
        ? `题材阶段 ${c.topicStage} 未延续、板块无跟随、成交额回落或出现高位断板后大幅走弱`
        : '板块无跟随、成交额回落或出现高位断板后大幅走弱',
      riskTags: c.veto.hits.length ? c.veto.hits.map(v => v.code).join('、') : (c.confirm.unknown ? `数据缺失${c.confirm.unknown}项` : '无'),
    })),
    watchPoolNote,
    keyMissingTop3: keyMissing,
    caliberNotes: [
      `大面股 = 昨日涨停股今日涨跌幅 ≤ ${TH.bigDropPct}%（工作台自定义代理口径）`,
      `流动性不足阈值 = 个股成交额 < ${TH.liquidityMinYi} 亿元`,
      `连续加速代理 = 连板高度 ≥ ${TH.highBoard} 板`,
      `持续性判定至少需 ${TH.trendMinPoints} 个有效对照点；不足则输出「${NO_COMPARISON}」`,
      '成交额样本仅覆盖涨停池 + 强势股池，不代表两市成交额排名',
      '中军/趋势股、个股多日量价、公告催化时间窗、题材新旧：工作台暂无可靠本机源，相关项标「缺失」',
      '新闻标题只作催化线索（附来源时间），不构成公告核验，不单独决定分类',
      '否决项分级：V1/V2/V6 为个股级硬否决 → D 剔除；V3/V4/V5 为市场级/位置级软否决 → 降级 C「仅观察」，命中后永不评 A/B（对规格「降级或剔除」的显式取舍，避免一次负反馈让汇总表与观察池全空）',
      '观察池个股级合格样本不足 3 个时，用板块级候选补足并标注；仍不足则如实列出实际数量与原因，绝不硬凑',
      '20261108d 新增 C7（量价结构健康）与 V7（高位顶背离+放量滞涨+板块不跟）依赖个股多日量价序列，工作台暂无该源 → 恒「缺失」，不以封板时间或单日成交额冒充',
      '20261108d 新增 C8（消息在催化/发酵期）与 V8（消息兑现+龙头独舞）由 lib/topicEngines.js 基于前 3-5 日同口径行业涨停家数序列确定性给出，是本轮新增的真实可证项',
      '驱动标签 D1 技术 / D2 消息 / D3 资金 / D4 基本面；D4 因复盘链路未接入财报与估值数据恒不标注，不以新闻标题冒充基本面证据',
      '四象限中和：共振不处理、背离降级 C、先觉降一级、双弱剔除 D；「无法判断」不额外升降级（实时新闻流不能证明某题材当日无消息，不把证据缺失误判成双弱而整批剔除）',
      '中军表现以涨停池内流通市值居前个股作代理，不是真实板块中军；代理样本缺失时题材 S 级不成立',
    ],
  };
}

module.exports = {
  analyze, quad, riskItem, trendOf, num, pct, fixed, yi, tri,
  classifyOpportunity, funnelOf, confirmOf, vetoOf, gradeOf,
  buildCandidates, assessRisks, marketRiskLevelOf, normInput,
  topicOf, driversOf,
  TH, MISSING, NO_COMPARISON, HARD_VETO, SOFT_VETO, DRIVER_DEFS,
  OPPORTUNITY_CATEGORIES, CONFIRM_DEFS, VETO_DEFS, RISK_DEFS,
};
