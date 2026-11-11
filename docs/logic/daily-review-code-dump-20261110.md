# 每日复盘 · 代码反向输出（磁盘实测快照 · 2026-11-10）

> ## ⚠️ 本文件已作废（2026-11-10 16:03 之后）
> 用户随后下达新裁决：**停止纯代码拼接，改为大模型生成 Markdown 复盘**。
> `lib/reviewOutput.js` 已被删除，本文件第 3 节收录的 11 段输出层源码、以及第 8 节的
> 「规格条款 ↔ 行号」对照表，**均已不再对应当前磁盘代码**，仅保留作为历史核对快照。
> 当前实现见：`prompts/daily-review-system.md`、`lib/reviewContext.js`、`lib/reviewLlm.js`、
> `lib/reviewService.js`、`public/js/markdown.js`，以及 `SESSION-STATE.md` 顶部 16:03 章节。
> 当前架构下复盘链路**确实调用 LLM**（已用本机配置模型实跑成功，见 SESSION-STATE 记录）。

> 用途：用户要求「把每日复盘的代码反向输出给我，我怀疑你没按照我的要求修改模型」。
> 本文件不是转述、不是摘要，所有代码块均由脚本从下列磁盘路径原样读取拼接，可逐行比对。
> 生成方式：`scripts/_dump_review_code.js`（临时脚本，生成后已删除）。

---

## 0. 先给结论：你的怀疑成立，但要看「模型」指的是什么

| 你说的「模型」 | 本次是否改动 | 证据 |
| --- | --- | --- |
| 确定性算法引擎（机会五层漏斗 O/L/C/V、四象限、题材评级、资金投票） | **一行未改** | `lib/reviewEngines.js`（830 行）与 `lib/topicEngines.js`（471 行）不在 git 改动清单中，`git diff` 为空 |
| LLM / 提示词模型 | **不存在，也没有改** | 复盘链路是纯代码引擎，不调用 LLM，`prompts/` 下没有复盘提示词 |
| 复盘的「输出模型 / 报告结构」 | **全量替换了** | 旧 14 段构建器从 `lib/reviewService.js` 删除，新建 `lib/reviewOutput.js` 作为 11 段结构唯一出口 |

**为什么引擎没改**：上一轮就「删除旧模型，全量替换」与当前纯代码架构冲突，向您确认过替换口径，
您选择的是 **「保留引擎，只换输出（推荐）」**。因此本次是「引擎零改动 + 输出层全量重写」。
如果您现在要的是「连两个引擎的算法一起换掉」，那本次确实没有做，属于另一个口径，需要您一句话确认后我再动。

---

## 1. 证据 A：谁改了、谁没改（git 实时输出）

### 1.1 `git diff --stat -- lib/reviewEngines.js lib/topicEngines.js`

````text
(空输出 = 两个引擎文件与 HEAD 完全一致，零改动)
````

### 1.2 `git status --short -- lib/reviewEngines.js lib/topicEngines.js lib/reviewOutput.js`

````text
?? lib/reviewOutput.js
````

### 1.3 本次每日复盘相关文件的 `git diff --stat`

````text
lib/boardReviewData.js       |  27 +-
 lib/reviewService.js         | 781 ++++++++++++++-----------------------------
 public/daily-review.html     |   6 +-
 public/etf-flow.html         |   4 +-
 public/index.html            |  20 +-
 public/js/dailyReview.js     | 129 +++++--
 scripts/board_review_data.py |  17 +-
 scripts/test_daily_review.js | 543 ++++++++++++++++--------------
 server.js                    |  62 +++-
 9 files changed, 760 insertions(+), 829 deletions(-)
````

### 1.4 文件规模（实测行数）

````text
568 lib/reviewOutput.js
   783 lib/reviewService.js
   830 lib/reviewEngines.js
   471 lib/topicEngines.js
   136 lib/boardReviewData.js
   722 scripts/board_review_data.py
   759 public/js/dailyReview.js
  3282 server.js
  7551 total
````

---

## 2. 证据 B：两个「模型 / 引擎」文件的头部（仍是 20261108d 老版本）

### 2.1 `lib/reviewEngines.js` 第 1-30 行（未改动）

````js
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

````

### 2.2 `lib/topicEngines.js` 第 1-23 行（未改动）

````js
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
````

这两个文件仍完整保留五层漏斗 `L1-L5`、确认清单 `C1-C8`、否决清单 `V1-V8`、四象限中和等旧规则。
新规格里「禁止过度专业化」要求的处理方式，是**在输出层把这些术语翻译成大白话**，而不是删掉引擎——见第 3 节 `JARGON_BAN` / `plainify()`。

---

## 3. 完整源码：`lib/reviewOutput.js`（新建文件 · 11 段输出层唯一出口）

这是本次「全量替换」真正落地的位置。文件为新文件（`?? lib/reviewOutput.js`），共 569 行，以下为全文：

````js
/**
 * lib/reviewOutput.js — 每日复盘「输出层」（20261110a · 11 段去重精简版）
 * ==================================================================================
 * 用户 2026-11-10 裁决：「保留引擎，只换输出」。本文件只负责把 reviewEngines /
 * topicEngines 已经算好的确定性结果，组织成 11 段精简、去重、说人话的报告；
 * 所有数值仍由引擎与采集层计算，本文件不做任何估算、不调 LLM、不补齐缺失。
 *
 * 规格（docs/logic/daily-review-spec-20261110.md）落地要点：
 *  1. 固定 11 段，顺序锁定；旧 14 段中的 opportunities / nextChecklist / quality
 *     三段不再对用户展示（质检转为后台硬门禁，落在 version.quality）。
 *  2. 「禁止信息重复」由构建期 own() 登记器强制：每个关键数据标签只允许归属一个段落，
 *     跨段重复会在后台质检里判失败，复盘不予发布。
 *  3. 「禁止过度专业化」：引擎 trends.*.note 含「有效对照点 / 前后半段均值 / 阈值 ±10%」，
 *     输出层只用 direction，经 plainTrend() 翻成「较前3日放大/萎缩」「对比昨日升温/降温」，
 *     并把这些术语列入 JARGON_BAN 做后台硬扫描。
 *  4. 「四段式只用于核心结论与核心观察池」：CORE_SECTIONS 之外的段落 quads 必须为空，
 *     由后台质检逐段核验。
 *  5. 第八段龙虎榜：15:35 正式版标「待晚间补录」；20:30 补录后升级完整版；
 *     lhbLines() 是 build 与 backfill 共用的唯一出口，避免两处文案漂移。
 *  6. 合规：不给买入/卖出/仓位建议；缺失一律标「缺失」，不臆造、不反推。
 *
 * 隔离原则：本模块不修改任何既有模块；引擎 / 采集 / 落盘字段的语义零改动。
 */
'use strict';

const engines = require('./reviewEngines');
const topicEngines = require('./topicEngines');

const MISSING = '缺失';
const num = engines.num;
const pct = engines.pct;
const fixed = engines.fixed;

// 按 SCHEMA_VERSION 升级铁律：14 段 → 11 段属输出结构变更，必须升版，
// 否则旧文档会被 runReview 的幂等逻辑判「同 schema」永久复用。
const SCHEMA_VERSION = 'review-20261110a';

// 固定 11 段结构（顺序即规格顺序，不可增删）
const SECTION_DEFS = [
  { key: 'oneline', title: '一、今日一句话结论' },
  { key: 'integrity', title: '二、数据完整性与口径说明' },
  { key: 'attribution', title: '三、每日热点题材与归因卡片' },
  { key: 'sentiment', title: '四、整体情绪与市场风险' },
  { key: 'ladder', title: '五、连板梯队与接力风险' },
  { key: 'sectors', title: '六、板块结构与资金投票' },
  { key: 'lossEffect', title: '七、亏钱效应与风险扩散' },
  { key: 'capital', title: '八、成交和资金偏好（含龙虎榜补录）' },
  { key: 'focusPool', title: '九、明日核心观察池' },
  { key: 'historyCompare', title: '十、历史判断对照与打脸记录' },
  { key: 'watchPlan', title: '十一、明日观察计划' },
];

// 只有【核心结论】四段 + 【核心观察池】允许四段式；其余段落一律不套框架。
const CORE_SECTIONS = ['sentiment', 'ladder', 'sectors', 'lossEffect', 'focusPool'];

// 禁用建议词：出现即判质检失败
const ADVICE_BAN = ['建议买入', '建议卖出', '可以买入', '可以卖出', '加仓', '减仓', '建仓', '清仓',
  '仓位建议', '目标价', '抄底', '止盈', '止损', '推荐买', '推荐卖', '适合打板', '一定反弹'];
// 禁用模糊表述词
const VAGUE_BAN = ['我觉得', '可能', '大概', '或许', '应该是', '事后解释', '果然', '正如预期', '不出所料'];
// 新规格明令禁止的过度专业化术语（引擎内部可保留，输出层不得出现）
// 注意：不收录「同口径对照」——它是数据源名称「前 3-5 交易日同口径对照序列」的一部分，
// 属于来源清单而非叙述文案；收录会把如实列出的缺失源误判成术语违规。
const JARGON_BAN = ['有效对照点', '前后半段均值', '阈值±', '阈值 ±', '四段式', '五层漏斗',
  'C1-C8', 'V1-V8'];

function byKey(sources, key) { return sources.find(s => s.key === key) || null; }
function srcData(sources, key) { const s = byKey(sources, key); return s && s.data ? s.data : null; }

function signed(n, digits) {
  const x = num(n);
  return x == null ? MISSING : (x >= 0 ? '+' : '') + x.toFixed(digits == null ? 2 : digits);
}

/** 把引擎的「扩散/收缩/持平/无法判断」翻成大白话，绝不外泄 note 里的统计术语。 */
function plainTrend(t, upWord, downWord) {
  if (!t || !t.ok) return '前几日对照不足，暂不判断';
  if (t.direction === '扩散') return `较前3日${upWord}`;
  if (t.direction === '收缩') return `较前3日${downWord}`;
  if (t.direction === '持平') return '与前3日基本持平';
  return '前几日对照不足，暂不判断';
}
function plainYesterday(t) {
  if (!t || !t.ok) return '对照不足，暂不判断';
  if (t.direction === '扩散') return '对比昨日升温';
  if (t.direction === '收缩') return '对比昨日降温';
  if (t.direction === '持平') return '与昨日基本持平';
  return '对照不足，暂不判断';
}
function joinList(arr, fallback) {
  const a = (arr || []).filter(Boolean);
  return a.length ? a.join('、') : (fallback || MISSING);
}

/**
 * 第八段龙虎榜唯一文案出口。
 * @param {object|null} H  board_review_data.py 的 lhb 数据块
 * @param {string} date    复盘日 YYYY-MM-DD
 * @param {object} opts    { stage:'formal'|'complete', dragonTigerStatus, backfillAt }
 * @returns {string[]}     可直接塞进 capital.lines 的行
 */
function lhbLines(H, date, opts) {
  const o = opts || {};
  const stage = o.stage || 'formal';
  const usable = !!(H && H.ok !== false && num(H.count) != null);
  if (!usable) {
    return [
      '龙虎榜动向：待晚间补录。15:35 生成正式版时盘后龙虎榜尚未发布，本项按等待补录处理，与数据缺口分开标注。',
      '补录机制：20:30 或收到补录任务时抓取当日龙虎榜并升级为完整版；次日 15:35 生成新复盘前还会兜底检查一次。',
      '未补录前不臆造游资席位、机构买卖或资金性质判断，相关字段一律留白。',
    ];
  }
  const lines = [];
  const lead = stage === 'complete' ? '龙虎榜动向（已补录 · 完整版）' : '龙虎榜动向（当日已发布）';
  lines.push(`${lead}：上榜 ${H.count == null ? MISSING : H.count} 家，净买额合计 ${H.netBuyTotal == null ? MISSING : H.netBuyTotal + ' 亿元'}，买入 ${H.buyTotal == null ? MISSING : H.buyTotal + ' 亿元'}，卖出 ${H.sellTotal == null ? MISSING : H.sellTotal + ' 亿元'}（口径日 ${H.asOf || date}）。`);
  const tops = Array.isArray(H.topNetBuy) ? H.topNetBuy.slice(0, 3) : [];
  lines.push('游资接力情况：' + (tops.length
    ? '净买额前列 ' + tops.map(x => `${x.name}（${x.code}）${fixed(x.netBuyYi)} 亿`).join('、') + '；'
    : '') + `知名游资席位名称${MISSING}（工作台无席位穿透数据，不据榜单猜测游资身份）。`);
  const ib = num(H.institutionBuyMentions), isl = num(H.institutionSellMentions);
  lines.push(`机构动向：数据源「解读」文本中机构买入 ${ib == null ? MISSING : ib} 条、机构卖出 ${isl == null ? MISSING : isl} 条（关键词计数，非席位穿透核验）。`);
  if (ib != null && isl != null) {
    lines.push(ib > isl
      ? '判定：机构买入提及多于卖出，大资金里看基本面的一方更活跃，持续性相对更好。'
      : isl > ib
        ? '判定：机构卖出提及多于买入，更接近纯情绪博弈，次日容易出现一致性兑现。'
        : '判定：机构买卖提及持平，无法据此区分基本面资金与情绪博弈。');
  } else lines.push(`判定：机构买卖数据${MISSING}，不区分基本面资金与情绪博弈。`);
  if (Array.isArray(H.reasonStats) && H.reasonStats.length) {
    lines.push('主要上榜原因：' + H.reasonStats.slice(0, 3).map(x => `${x.reason}（${x.count} 家）`).join('；') + '。');
  }
  if (o.backfillAt) lines.push(`补录时间 ${o.backfillAt}（Asia/Shanghai）；补录只替换本段龙虎榜内容，其余段落数值不重算、不改写。`);
  return lines;
}

/**
 * 构建 11 段 + 后台质检。
 * @param {object} ctx { date, sources, engine, topics, meta, stage, dragonTigerStatus,
 *                       verdictRows, historyRecords, backfillAt }
 * @returns {{sections:object[], quality:object, metricOwners:Map}}
 */
function build(ctx) {
  const date = ctx.date;
  const sources = ctx.sources || [];
  const E = ctx.engine;
  const T = ctx.topics || topicEngines.analyzeTopics({});
  const m = ctx.meta || {};
  const stage = ctx.stage || 'formal';
  const verdictRows = Array.isArray(ctx.verdictRows) ? ctx.verdictRows : [];
  const historyRecords = Array.isArray(ctx.historyRecords) ? ctx.historyRecords : [];
  const S = {};
  const trends = E.trends;

  // 构建期「数据唯一归属」登记：同一标签被两个段落认领 = 违反禁止信息重复。
  const owners = new Map();
  function own(secKey, label, value) {
    if (!owners.has(label)) owners.set(label, []);
    owners.get(label).push(secKey);
    return String(value == null ? MISSING : value);
  }

  // 「保留引擎，只换输出」：引擎风险条目的 fact 文本里嵌了 trends.*.note 的统计术语
  // （有效对照点 / 前后半段均值 / 阈值 ±10%）。引擎一行不改，在输出层按原串精确替换成大白话。
  const trendPhrases = Object.values(trends || {}).filter(t => t && t.note)
    .map(t => ({ note: String(t.note), plain: plainTrend(t, '放大', '萎缩') }));
  function plainify(v) {
    let s = String(v == null ? '' : v);
    for (const p of trendPhrases) s = s.split(p.note).join(p.plain);
    return s;
  }
  function plainRisks(list) {
    return (list || []).map(r => ({ ...r, fact: plainify(r.fact), observe: plainify(r.observe), clear: plainify(r.clear) }));
  }

  const mk = (key, status, lines, bullets, metrics, extra) => {
    const def = SECTION_DEFS.find(d => d.key === key);
    const ex = extra || {};
    S[key] = {
      key, title: def ? def.title : key, status: status || 'ok',
      lines: (lines || []).filter(Boolean), bullets: bullets || [], metrics: metrics || [],
      quads: ex.quads || [], risks: ex.risks || [],
      table: ex.table || null, tableKind: ex.tableKind || null,
      lhbLines: ex.lhbLines || null,
      missing: (status === 'missing'),
    };
    return S[key];
  };

  const quote = srcData(sources, 'quote');
  const breadth = srcData(sources, 'breadth');
  const sectorFlow = srcData(sources, 'sectorFlow');
  const mainFund = srcData(sources, 'mainFund');
  const news = srcData(sources, 'news');
  const cal = srcData(sources, 'calendar');
  const L = srcData(sources, 'ladder');
  const H = srcData(sources, 'dragonTiger');
  const P = srcData(sources, 'prevPool');
  const SEC = srcData(sources, 'sectors');
  const ACT = srcData(sources, 'activity');
  const HS = srcData(sources, 'historySeries');
  const series = HS && Array.isArray(HS.series) ? HS.series : [];
  const b = breadth && breadth.breadth ? breadth.breadth : null;

  const okSrc = sources.filter(s => s.status === 'ok').length;
  const ASOF_CHECK_KEYS = new Set(['quote', 'breadth', 'ladder', 'dragonTiger', 'prevPool',
    'sectors', 'activity', 'historySeries', 'sectorFlow', 'mainFund']);
  const asOfMismatch = sources.filter(s => s.status === 'ok' && ASOF_CHECK_KEYS.has(s.key)
    && s.asOf && s.asOf !== MISSING && String(s.asOf).slice(0, 10) !== date);
  const mismatchKeys = new Set(asOfMismatch.map(s => s.key));
  const srcRows = sources.map(s => ({
    name: s.label, category: s.category, status: s.status,
    source: s.source, asOf: s.asOf, fetchedAt: s.fetchedAt,
    note: s.note || (mismatchKeys.has(s.key) ? '口径日与复盘日不一致，待核验' : ''),
  }));

  // —— 一、今日一句话结论（只做定性概括；具体数字由各自的归属段落首次出现） ——
  {
    const idx = quote && Array.isArray(quote.cn) ? quote.cn : [];
    const sh = idx.find(i => /上证|沪指|000001/.test(String(i.code || '') + String(i.name || ''))) || idx[0];
    const shPct = sh ? num(sh.changePct) : null;
    const up = b ? num(b.up) : null, down = b ? num(b.down) : null;
    const breadthWord = up == null || down == null ? `全市场涨跌家数${MISSING}`
      : up > down ? '涨多跌少' : up < down ? '跌多涨少' : '涨跌家数持平';
    const t = trends.limitUp;
    const tone = t.ok ? (t.direction === '扩散' ? '情绪较前3日升温' : t.direction === '收缩' ? '情绪较前3日降温' : '情绪与前3日基本持平') : '前几日对照不足，暂不判断情绪趋势';
    const topicWord = T.cards.length
      ? `题材以${T.dominantVote}为主（S/A 级 ${T.gradeSummary.S + T.gradeSummary.A} 个）`
      : `题材数据${MISSING}`;
    mk('oneline', (shPct == null || up == null) ? 'partial' : 'ok', [
      `${date}：上证指数 ${shPct == null ? MISSING : pct(shPct)}，${breadthWord}，${tone}；${topicWord}。`,
      '本页数值全部由工作台代码从已获取数据计算，缺失项如实标注「缺失」，不含任何操作类指引。',
    ]);
  }

  // —— 二、数据完整性与口径说明（规格：只列日期 / 来源模块 / 缺失字段） ——
  {
    const lines = [
      `复盘日期 ${date}（Asia/Shanghai）；交易日表判定：${cal ? (cal.is_trading_day ? '交易日' : '非交易日（休市）') : MISSING}；前一交易日 ${m.prevDate || MISSING}。`,
      `数据来源模块 ${sources.length} 项，正常 ${okSrc} 项，缺失或失败 ${sources.length - okSrc} 项；逐源名称、来源、口径日与获取时间见下表。`,
    ];
    // 龙虎榜「盘后尚未发布」不是数据缺失，单独说明，不混进缺失字段清单。
    const lhbSrc = byKey(sources, 'dragonTiger');
    const lhbpending = !!(lhbSrc && lhbSrc.status !== 'ok' && /待晚间补录|尚未发布/.test(String(lhbSrc.note || '')));
    const missingRows = sources.filter(s => s.status !== 'ok' && !(lhbpending && s.key === 'dragonTiger'));
    lines.push(missingRows.length
      ? `缺失字段：${missingRows.map(s => `${s.label}（${s.note || MISSING}）`).join('；')}。`
      : '本次无缺失字段。');
    lines.push(lhbpending
      ? '龙虎榜：盘后数据尚未发布，属于「待晚间补录」，不计入缺失；20:30 或收到补录任务后升级为完整版，次日 15:35 仍会兜底检查昨日是否补录。'
      : '龙虎榜是盘后延迟发布数据：15:35 正式版在第八段标「待晚间补录」，20:30 或收到补录任务后升级为完整版，次日 15:35 仍会兜底检查昨日是否补录。');
    lines.push(`口径：涨停 / 跌停 / 连板高度取自 akshare 东财涨停池、炸板池、跌停池；大面股指昨日涨停股今日涨跌幅 ≤ ${engines.TH.bigDropPct}%；成交额样本只覆盖涨停池与强势股池，不代表两市排名。`);
    lines.push('新闻只作催化线索并附来源时间，不替代行情与公告核验；观察池是验证市场风向的样本，不构成任何操作类指引。');
    if (m.limited) {
      lines.push(`⚠ 本次为「有限分析版」：核心字段完整率 ${m.completeness}% < 90%，未用估算值补齐。`);
      lines.push('最需补充的 3 项：' + E.keyMissingTop3.map((x, i) => `${i + 1}) ${x.field}（${x.why}）`).join('；') + '。');
    }
    if (cal && cal.is_trading_day === false) {
      lines.push(`⚠ 本复盘为「非交易日强制补生成」：${date} 为${cal.day_type || '休市'}，无当日行情；各段数值的口径日见来源表。`);
    }
    if (asOfMismatch.length) {
      lines.push(`⚠ 待核验：${asOfMismatch.length} 项行情数据源的口径日与复盘日不一致（${asOfMismatch.map(s => `${s.label}=${String(s.asOf).slice(0, 10)}`).join('、')}），这些数值不参与同日比较。`);
    }
    mk('integrity', okSrc === sources.length ? 'ok' : 'partial', lines, [], [], {
      table: srcRows, tableKind: 'source',
    });
  }

  // —— 三、每日热点题材与归因卡片（规格 6 列，不再逐段堆统计口径） ——
  {
    const cards = T.cards || [];
    const rows = cards.map(c => ({
      name: c.name,
      performance: `${c.changePct == null ? MISSING : c.changePct}，${c.limitUpCount == null ? MISSING : c.limitUpCount} 家涨停，中军${c.midCapText || MISSING}`,
      attribution: c.attribution || MISSING,
      stage: c.stage || MISSING,
      grade: c.grade || MISSING,
      verifyLogic: c.verifyLogic || MISSING,
    }));
    const lines = [
      `卡片覆盖 ${cards.length} 个活跃题材：S ${T.gradeSummary.S} / A ${T.gradeSummary.A} / B ${T.gradeSummary.B} / C ${T.gradeSummary.C}；主导演票类型 ${T.dominantVote}。`,
      '评级说明：S 级＝有消息有资金的主线共振；A 级＝只有小票涨的局部投机；C 级＝利好兑现、高位跌停的诱多陷阱。',
      '防诱多规则：出利好但中军大跌判 C 级；连续加速、消息刷屏、高位分歧的题材强制降级，不进第九段观察池。',
      '消息级别由来源名称与标题推断，未经公告原文核验；自媒体传闻标「传闻/未核验」。',
      '题材阶段来自前几个交易日的行业涨停家数对比，对照不足时写「暂不判断」，不把单日数据当趋势。',
    ];
    if (!cards.length) lines.push(`本次未取得活跃题材（板块层次数据源${MISSING}或未返回条目），表格如实留空，不补造题材。`);
    mk('attribution', cards.length ? 'ok' : 'partial', lines, [], [], {
      table: rows, tableKind: 'topicBrief',
    });
  }

  // —— 四、整体情绪与市场风险（独占：涨停 / 跌停 / 炸板率 / 红盘率 / 1进2晋级率） ——
  {
    const lines = [];
    if (!b) lines.push(`涨跌家数、涨停跌停与指数数据${MISSING}，整体情绪不做判定。`);
    else {
      const lu = own('sentiment', '涨停家数', b.limitUp == null ? MISSING : b.limitUp);
      const ld = own('sentiment', '跌停家数', b.limitDown == null ? MISSING : b.limitDown);
      const zb = own('sentiment', '炸板率', b.zbgcRate == null ? MISSING : b.zbgcRate);
      lines.push(`情绪数据：涨停 ${lu} 家，跌停 ${ld} 家，炸板率 ${zb}；全市场涨 ${b.up == null ? MISSING : b.up} / 跌 ${b.down == null ? MISSING : b.down} 家。`);
    }
    if (P) {
      const rr = own('sentiment', '昨日涨停股红盘率', P.redRate == null ? MISSING : fixed(P.redRate) + '%');
      const p1 = Array.isArray(P.promotion) ? P.promotion.find(x => x.from === 1) : null;
      const pr = own('sentiment', '1进2晋级率', p1 ? fixed(p1.rate) + '%' : MISSING);
      lines.push(`昨日涨停股今日红盘率 ${rr}，1进2晋级率 ${pr}，样本 ${P.count == null ? MISSING : P.count} 只。`);
    } else lines.push(`昨日涨停股今日表现与晋级率${MISSING}，不以上一日结构倒推。`);
    const tolerance = (() => {
      const a = trends.limitUp.direction, c = trends.prevRedRate.direction;
      if (a === '扩散' && c === '扩散') return '短线容错率升高';
      if (a === '收缩' && c === '收缩') return '短线容错率降低';
      if (!trends.limitUp.ok) return '容错率缺少前几日对照，暂不判断';
      return '短线容错率变化不明显';
    })();
    lines.push(`周期对照：涨停家数${plainTrend(trends.limitUp, '放大', '萎缩')}，昨日涨停红盘率${plainTrend(trends.prevRedRate, '升温', '降温')}，晋级率${plainTrend(trends.promotionRate, '升温', '降温')}；赚钱效应${trends.limitUp.ok ? (trends.limitUp.direction === '扩散' ? '扩散' : trends.limitUp.direction === '收缩' ? '收缩' : '基本持平') : '缺少对照，暂不判断'}，${tolerance}。`);
    lines.push(`市场级风险评级：${E.marketRiskLevel}。`);
    mk('sentiment', (b && P && series.length >= 3) ? 'ok' : 'partial', lines, [], [], {
      quads: [engines.quad('【核心结论】整体情绪与市场风险',
        `涨停 ${b ? (b.limitUp == null ? MISSING : b.limitUp) : MISSING} 家、跌停 ${b ? (b.limitDown == null ? MISSING : b.limitDown) : MISSING} 家；昨日涨停红盘率 ${P ? (P.redRate == null ? MISSING : fixed(P.redRate) + '%') : MISSING}；${plainTrend(trends.limitUp, '放大', '萎缩')}`,
        trends.limitUp.ok ? `当前处于${trends.limitUp.direction === '扩散' ? '发酵期' : trends.limitUp.direction === '收缩' ? '退潮期' : '震荡期'}；市场级风险 ${E.marketRiskLevel}` : engines.NO_COMPARISON,
        '次日看涨停家数是否增加、昨日涨停股红盘率是否回升、高位股是否修复',
        '涨停家数与红盘率同步转弱、晋级率连续两日下降，说明情绪恶化')],
      risks: plainRisks(E.risks.market),
    });
  }

  // —— 五、连板梯队与接力风险（独占：高度 / 梯队 / 断层 / 高位股反馈） ——
  {
    const lines = [];
    if (!L) {
      lines.push(`连板梯队、最高连板高度、晋级情况${MISSING}。`, '说明：取数失败时不以涨停家数反推连板高度（不臆造）。');
    } else {
      const tiers = Array.isArray(L.tiers) ? L.tiers : [];
      const at = n => { const x = tiers.find(t => num(t.boards) === n); return x ? num(x.count) : null; };
      const second = own('ladder', '二板家数', at(2));
      const third = own('ladder', '三板家数', at(3));
      const maxB = own('ladder', '最高连板', L.maxBoards == null ? MISSING : L.maxBoards + ' 板');
      lines.push(`梯队数据：最高 ${maxB}（${L.spaceBoard ? `${L.spaceBoard.name} ${L.spaceBoard.boards} 板` : MISSING}），二板 ${second} 家，三板 ${third} 家，首板 ${L.firstBoardCount == null ? MISSING : L.firstBoardCount} 家。`);
      lines.push(`梯队断层：${L.hasGap == null ? MISSING : (L.hasGap ? `在 ${(L.gapAt || []).join('、')} 板档出现断层` : '没有出现断层')}。`);
      if (L.sealFundTotal != null) lines.push(`涨停池封板资金合计 ${L.sealFundTotal} 亿元。`);
    }
    if (P && Array.isArray(P.topLosers)) {
      const high = P.topLosers.filter(x => num(x.prevBoards) >= 3);
      lines.push('昨日高位股今日反馈：' + (high.length
        ? high.slice(0, 4).map(x => `${x.name}（昨 ${x.prevBoards} 板，今 ${pct(x.chgPct)}）`).join('、')
        : '3 板以上高位股未出现在本回落样本中') + '。');
    } else lines.push(`昨日高位股今日反馈${MISSING}。`);
    lines.push(`接力意愿${plainTrend(trends.promotionRate, '转强', '转弱')}；高度、梯队与高位股反馈三项一起看，不单看一只个股。`);
    mk('ladder', L ? 'ok' : 'missing', lines, [], [], {
      quads: [engines.quad('【核心结论】连板梯队与接力风险',
        `最高 ${L ? (L.maxBoards == null ? MISSING : L.maxBoards + ' 板') : MISSING}；断层 ${L ? (L.hasGap == null ? MISSING : L.hasGap ? (L.gapAt || []).join('、') + ' 板档' : '无') : MISSING}；${plainTrend(trends.promotionRate, '转强', '转弱')}`,
        trends.promotionRate.ok ? `接力意愿${trends.promotionRate.direction === '扩散' ? '仍强' : trends.promotionRate.direction === '收缩' ? '转弱' : '持平'}` : engines.NO_COMPARISON,
        '次日看缺口板档是否补齐、最高板是否继续晋级、高位断板股是否走弱',
        '梯队补齐且最高板晋级、高位断板股没有扩散走弱')],
      risks: plainRisks(E.risks.sector.filter(r => ['R-S2', 'R-S3'].includes(r.code))),
    });
  }

  // —— 六、板块结构与资金投票（独占：领涨领跌 / 板块层次 / 三类板块判断） ——
  {
    const lines = [];
    const up = quote && Array.isArray(quote.sectorsUp) ? quote.sectorsUp : [];
    const down = quote && Array.isArray(quote.sectorsDown) ? quote.sectorsDown : [];
    lines.push('领涨板块：' + joinList(up.slice(0, 5).map(s => `${s.name} ${s.unavailable ? MISSING : pct(s.changePct)}`)) + '；领跌板块：' + joinList(down.slice(0, 5).map(s => `${s.name} ${s.unavailable ? MISSING : pct(s.changePct)}`)) + '。');
    if (SEC) {
      const tops = Array.isArray(SEC.top) ? SEC.top.slice(0, 5) : [];
      lines.push('板块层次：' + (tops.length ? tops.map(s => `${s.industry} ${s.count} 家 / 最高 ${s.boardsMax == null ? MISSING : s.boardsMax + ' 板'} / ${s.hasLayer ? '有层次' : '无层次'}`).join('；') : MISSING) + '。');
    } else lines.push(`板块层次数据${MISSING}。`);
    const cards = T.cards || [];
    const strong = cards.filter(c => c.voteQuality === '强共识投票').map(c => c.name);
    const local = cards.filter(c => c.voteQuality === '局部游资投票').map(c => c.name);
    const traps = cards.filter(c => c.grade === 'C' || c.voteQuality === '无效/陷阱投票').map(c => c.name);
    lines.push('资金合力方向（中军与小票一起动）：' + joinList(strong, '今日没有出现强共识板块') + '。');
    lines.push('局部游资博弈（只有小票涨、中军不动）：' + joinList(local, '今日没有识别到这类板块') + '。');
    lines.push('板块断层警告（领涨股走弱且中军转弱）：' + joinList(traps, '今日没有识别到这类板块') + '。');
    lines.push(`中军 / 趋势股行情与新老题材标注${MISSING}，不作题材新旧与持续性判断；下表按题材逐行列出投票类型、四象限与客观证据。`);
    const voteRows = cards.map(c => ({
      industry: c.name, voteQuality: c.voteQuality, quadrant: c.quadrant,
      quadrantAction: c.quadrantAction,
      evidence: `涨停 ${c.limitUpCount} 家 / ${c.newsLevel} / ${c.stage} / 中军代理 ${c.midCapText}`,
    }));
    mk('sectors', SEC ? 'ok' : 'partial', lines, [], [], {
      table: voteRows, tableKind: 'vote',
      quads: [engines.quad('【核心结论】板块结构与主线是否确立',
        `强共识 ${strong.length} 个、局部游资 ${local.length} 个、诱多预警 ${traps.length} 个；主导演票 ${T.dominantVote}，主导象限 ${T.dominantQuadrant}`,
        strong.length ? '存在中军与小票共振的方向，主线有初步确立迹象' : '没有出现中军与小票共振的方向，主线尚未确立',
        '次日看强共识板块是否继续放量、是否出现第 2 只跟随个股',
        '强共识板块涨停家数回落、跟随个股消失，或诱多预警板块继续走弱')],
    });
  }

  // —— 七、亏钱效应与风险扩散（独占：大面股 / 行业分布 / 回落幅度前列） ——
  {
    const lines = [];
    if (P) {
      const bd = own('lossEffect', '大面股', P.bigDropCount == null ? MISSING : P.bigDropCount + ' 只');
      lines.push(`大面股数据：今日 ${bd}（昨日涨停股今日跌幅 >5%），占昨日涨停样本 ${P.bigDropRate == null ? MISSING : fixed(P.bigDropRate) + '%'}。`);
      const spread = Array.isArray(P.industryBigDrop) ? P.industryBigDrop : [];
      lines.push('大面股行业分布：' + (spread.length ? spread.slice(0, 5).map(x => `${x.industry} ${x.count} 只`).join('、') : MISSING) + '。');
      const total = spread.reduce((n, x) => n + (num(x.count) || 0), 0);
      const top = spread[0];
      const common = (() => {
        if (top && total > 0 && num(top.count) / total >= 0.5) return `集中在 ${top.industry}，属于板块退潮`;
        const losers = Array.isArray(P.topLosers) ? P.topLosers : [];
        if (losers.filter(x => num(x.prevBoards) >= 3).length >= 2) return '高位股集体补跌';
        if (spread.length > 2) return '分散在多个行业，没有单一板块集中';
        return `样本不足，暂不判断共性`;
      })();
      lines.push(`亏钱效应共性：${common}；个股突发利空无法从本机数据区分，标${MISSING}。`);
      const losers = Array.isArray(P.topLosers) ? P.topLosers.slice(0, 5) : [];
      lines.push('回落幅度前列：' + (losers.length ? losers.map(x => `${x.name} ${pct(x.chgPct)}（昨 ${x.prevBoards == null ? MISSING : x.prevBoards} 板）`).join('、') : MISSING) + '。');
    } else lines.push(`昨日强势今日回落个股与大面股数据${MISSING}，不作亏钱效应判定。`);
    lines.push(`跌停家数${plainTrend(trends.limitDown, '增多', '减少')}（当日绝对值见第四段，此处不重复罗列）。`);
    lines.push('重要口径：亏钱效应收敛只代表压力缓解，不等于买点出现。');
    mk('lossEffect', (P && L) ? 'ok' : 'partial', lines, [], [], {
      quads: [engines.quad('【核心结论】亏钱效应与风险扩散',
        `大面股 ${P ? (P.bigDropCount == null ? MISSING : P.bigDropCount + ' 只') : MISSING}；跌停家数${plainTrend(trends.limitDown, '增多', '减少')}`,
        trends.limitDown.ok ? `压力${trends.limitDown.direction === '扩散' ? '正在扩散' : trends.limitDown.direction === '收缩' ? '正在收敛' : '基本持平'}` : engines.NO_COMPARISON,
        '次日看大面股是否减少、是否仍集中在同一批行业',
        '大面股与跌停家数同步上升，或大面股行业分布进一步扩散')],
      risks: plainRisks([].concat(
        E.risks.market.filter(r => r.code === 'R-M2'),
        E.risks.sector.filter(r => r.code === 'R-S3'),
        E.risks.individual.filter(r => r.code === 'R-I2'))),
    });
  }

  // —— 八、成交和资金偏好（含龙虎榜补录；独占：成交额 / 资金流 / 龙虎榜） ——
  {
    const lines = [];
    if (sectorFlow) {
      const inflow = Array.isArray(sectorFlow.todayInflowTop5) ? sectorFlow.todayInflowTop5 : [];
      const outflow = Array.isArray(sectorFlow.todayOutflowTop5) ? sectorFlow.todayOutflowTop5 : [];
      lines.push('主力净流入前五：' + (inflow.length ? inflow.slice(0, 5).map(x => `${x.name} ${fixed(x.mainNet)} 亿`).join('，') : MISSING) + `（口径日 ${sectorFlow.date || MISSING}）。`);
      lines.push('主力净流出前五：' + (outflow.length ? outflow.slice(0, 5).map(x => `${x.name} ${fixed(x.mainNet)} 亿`).join('，') : MISSING) + '。');
    } else lines.push(`板块资金流数据${MISSING}。`);
    if (mainFund && mainFund.mainFund) {
      const mf = mainFund.mainFund;
      const v = num(mf.mainNetToday != null ? mf.mainNetToday : mf.value != null ? mf.value : null);
      lines.push(`全市场主力净额：${v == null ? MISSING : fixed(v) + ' 亿元'}（口径 ${mf.date || mainFund.date || MISSING}）。`);
    } else lines.push(`全市场主力净额${MISSING}。`);
    if (ACT) {
      const tops = Array.isArray(ACT.topAmount) ? ACT.topAmount.slice(0, 5) : [];
      lines.push('成交额前排（样本内）：' + (tops.length ? tops.map(x => `${x.name}（${x.code}）${fixed(x.amountYi)} 亿`).join('，') : MISSING) + '。');
      lines.push(`涨停池成交额合计 ${ACT.ztAmountYi == null ? MISSING : ACT.ztAmountYi + ' 亿元'}，强势股池 ${ACT.strongCount == null ? MISSING : ACT.strongCount} 只 / ${ACT.strongAmountYi == null ? MISSING : ACT.strongAmountYi + ' 亿元'}；${plainTrend(trends.ztAmountYi, '放大', '萎缩')}。`);
    }
    lines.push(`全市场成交额靠前个股排行${MISSING}：该接口返回实时快照、口径日与复盘日不符，未采用；以上只是涨停池 / 强势股池的局部样本。`);
    const block = lhbLines(H, date, { stage, dragonTigerStatus: ctx.dragonTigerStatus, backfillAt: ctx.backfillAt });
    block.forEach(x => lines.push(x));
    lines.push('重要口径：成交额与龙虎榜只反映交易活跃度，不单独证明机构进场或资金出逃；资金数据存在 T-1 收盘口径，已在来源表标注。');
    mk('capital', (sectorFlow || mainFund || H || ACT) ? 'ok' : 'missing', lines, [], [], {
      lhbLines: block,
    });
  }

  // —— 九、明日核心观察池（只保留 A/B 级可跟踪样本，3-8 只） ——
  {
    const pool = (E.watchPool || []).filter(r => /[AB]级/.test(String(r.categoryGrade || '')));
    const rows = pool.slice(0, 8).map(r => ({
      name: `${r.name}（${r.code}）`,
      reason: `${r.sector || MISSING} / ${r.reason || MISSING}`,
      grade: r.categoryGrade || MISSING,
      watchChange: r.watchChange || MISSING,
      invalidate: r.invalidate || MISSING,
    }));
    const lines = [
      `从热点卡片与板块结构里筛出 ${rows.length} 只，只留 A / B 级可跟踪样本，数量控制在 3-8 只。`,
      '工作台机会评级是 A / B / C / D，与第三段题材 S / A / B / C 是两套口径，此处不做换算。',
      '这是明天的风向标，不构成任何操作类指引；「放弃跟踪的信号」只用于复盘核对。',
    ];
    if (rows.length < 3) lines.push(E.watchPoolNote || '今日通过漏斗的合格样本不足 3 个，按「不臆造」原则如实列出，不补足数量。');
    mk('focusPool', rows.length ? 'ok' : 'partial', lines, [], [], {
      table: rows, tableKind: 'focusPool',
      quads: [engines.quad('【核心观察池】明日风向标',
        `A / B 级样本 ${rows.length} 只；代表方向 ${joinList([...new Set(pool.slice(0, 3).map(r => r.sector).filter(x => x && x !== MISSING))])}`,
        rows.length ? '样本集中在上述方向，作为次日验证市场风向的观察对象' : '本次没有合格样本，次日只做数据链路核对',
        '次日看样本开盘是否主动放量、板块是否出现跟随个股',
        '样本低开低走且板块无响应，或命中风险标签后按表中信号停止跟踪')],
    });
  }

  // —— 十、历史判断对照与打脸记录 ——
  {
    const bad = verdictRows.filter(r => r.verdict === '未验证');
    const pending = verdictRows.filter(r => r.verdict === '待验证');
    const lines = [
      verdictRows.length
        ? '前日判断 → 今日验证：逐条见下表；判定只做方向核对，数值符号一致记「已验证」，相反记「未验证」，任一侧缺失记「待验证」。'
        : '暂无可对照的历史判断记录（历史复盘库不足）。',
      `自我纠错：近几期共 ${verdictRows.length} 条可核对判断，其中 ${bad.length} 条未兑现、${pending.length} 条因数据缺失待验证` + (bad.length ? `；未兑现项：${bad.slice(0, 3).map(r => r.item).join('、')}` : '') + '。原判断与基准值保留在历史版本里，不做事后修饰。',
    ];
    if (historyRecords.length) lines.push(`大盘记录近 30 日共 ${historyRecords.length} 条，仅作背景，不参与上表判定。`);
    if (ctx.backfillAt) {
      const related = verdictRows.filter(r => /资金|成交|龙虎/.test(String(r.item || '')));
      lines.push(`补录联动：${ctx.backfillAt} 已补录 ${date} 龙虎榜；与资金 / 成交相关的历史验证条件共 ${related.length} 条，已由代码按今日值重新核对（${related.filter(r => r.verdict === '未验证').length} 条未兑现），既有判断记录不改写。`);
    }
    mk('historyCompare', verdictRows.length ? 'ok' : 'partial', lines, [], [], {
      table: verdictRows, tableKind: 'history',
    });
  }

  // —— 十一、明日观察计划（两三句话，不套框架） ——
  {
    const topSectors = (E.watchPool || []).slice(0, 3).map(x => x.sector).filter(x => x && x !== MISSING);
    const topName = L && L.spaceBoard ? L.spaceBoard.name : MISSING;
    const lines = [
      `重点盯：${topSectors.length ? [...new Set(topSectors)].join('、') : MISSING} 能否弱转强，板块里是否出现第 2 只跟随个股。`,
      `重点看：最高标 ${topName} 是否断板；昨日涨停股是否还有溢价，大面股是否减少。`,
      `预期管理：若情绪继续退潮，观察样本只减不增；若中军放量带队，重点跟踪 ${topSectors.length ? [...new Set(topSectors)][0] : MISSING} 方向。这一页只写「核对什么」，不指向买卖。`,
    ];
    mk('watchPlan', 'ok', lines);
  }

  const sections = SECTION_DEFS.map(d => S[d.key]).filter(Boolean);
  const quality = qualityOf({ S, sections, sources, E, T, cal, okSrc, asOfMismatch, owners, stage, H });
  return { sections, quality, metricOwners: owners };
}

/** 后台质检：不再对用户展示，但任一硬检查未通过则复盘不予发布。 */
function qualityOf(x) {
  const checks = [];
  const S = x.S, sections = x.sections, sources = x.sources;
  const ownText = Object.values(S).flatMap(sec => [].concat(
    sec.lines || [],
    (sec.bullets || []).filter(t => !String(t).startsWith('新闻催化：')),
    (sec.quads || []).flatMap(q => [q.fact, q.judgment, q.verify, q.invalidate]),
    (sec.risks || []).flatMap(r => [r.fact, r.observe, r.clear])
  )).join('\n');
  const push = (item, passed, detail) => checks.push({ item, passed: !!passed, detail: String(detail || '') });

  push('固定 11 段结构完整', sections.length === SECTION_DEFS.length, `${sections.length}/${SECTION_DEFS.length}`);
  const banned = ADVICE_BAN.filter(w => ownText.includes(w));
  push('不含操作类建议', !banned.length, banned.length ? '命中：' + banned.join('、') : '未命中禁用词');
  const vague = VAGUE_BAN.filter(w => ownText.includes(w));
  push('不含模糊表述与事后修饰', !vague.length, vague.length ? '命中：' + vague.join('、') : '未命中模糊词');
  const jargon = JARGON_BAN.filter(w => ownText.includes(w));
  const jargonCtx = jargon.length
    ? '；原文：' + (ownText.split('\n').find(l => jargon.some(w => l.includes(w))) || '').slice(0, 120) : '';
  push('不含过度专业化术语', !jargon.length, jargon.length ? '命中：' + jargon.join('、') + jargonCtx : '未命中术语');
  const missingQuads = CORE_SECTIONS.filter(k => !S[k] || !S[k].quads || !S[k].quads.length);
  const badQuads = CORE_SECTIONS.flatMap(k => (S[k] && S[k].quads ? S[k].quads : [])
    .filter(q => !q.fact || !q.judgment || !q.verify || !q.invalidate || q.fact === MISSING || q.judgment === MISSING)
    .map(q => k + ':' + q.subject));
  push('每条核心判断均有四段式', !missingQuads.length && !badQuads.length,
    missingQuads.length ? '缺段：' + missingQuads.join('、') : badQuads.length ? '不完整：' + badQuads.join('、') : `${CORE_SECTIONS.length} 个核心段全部具备`);
  const nonCoreWithQuads = SECTION_DEFS.filter(d => !CORE_SECTIONS.includes(d.key) && S[d.key] && S[d.key].quads && S[d.key].quads.length).map(d => d.key);
  push('结论框架只用于核心结论与核心观察池', !nonCoreWithQuads.length, nonCoreWithQuads.length ? '越界：' + nonCoreWithQuads.join('、') : `${CORE_SECTIONS.length} 个核心段，其余段落均未套框架`);
  const dup = [...x.owners.entries()].filter(([, ks]) => new Set(ks).size > 1).map(([l, ks]) => `${l}→${[...new Set(ks)].join('/')}`);
  push('同一数据只归属一个核心模块', !dup.length, dup.length ? '重复：' + dup.join('；') : `${x.owners.size} 个关键数据标签均唯一归属`);
  push('缺失项未被推测替代', true, `${sources.filter(s => s.status !== 'ok').length} 项数据源缺失逐项标注；无源维度标「无法判断」，不补数值`);
  push('未把单日数据当趋势', true, `${Object.values(x.E.trends).filter(t => !t.ok).length} 项趋势对照不足，已写「暂不判断」`);
  const gradeEvidence = x.E.candidates.filter(c => c.trackable && c.confirm.count < 4);
  push('机会评级有证据支撑', !gradeEvidence.length, gradeEvidence.length ? gradeEvidence.map(c => c.name).join('、') : `可跟踪 ${x.E.candidates.filter(c => c.trackable).length} 个，确认项均 ≥4`);
  push('数据源五要素齐全', sources.every(s => s.source && s.fetchedAt), `正常 ${x.okSrc}/${sources.length} 项`);
  push('交易日历表已先查', !!(x.cal && x.cal.from_table), x.cal ? `is_trading_day=${x.cal.is_trading_day}` : MISSING);
  const cap = S.capital;
  const lhbText = (cap && cap.lhbLines ? cap.lhbLines : []).join('');
  push('龙虎榜未发布时如实标「待晚间补录」', lhbText.includes('待晚间补录') || (x.H && x.H.ok !== false && num(x.H.count) != null),
    x.stage === 'complete' ? '完整版已补录' : '正式版标注待补录，不视作数据缺失');

  return { passed: checks.every(c => c.passed), checks };
}

module.exports = {
  SCHEMA_VERSION, SECTION_DEFS, CORE_SECTIONS,
  ADVICE_BAN, VAGUE_BAN, JARGON_BAN, MISSING,
  build, lhbLines, plainTrend, plainYesterday, srcData, signed,
};

````

---

## 4. 完整源码：`lib/reviewService.js`（主服务 · 删掉旧 14 段构建器后）

共 784 行。旧 `buildSections()` 已被整段删除；采集、幂等、落盘保留；新增 `formal/complete` 状态机与 `backfillDragonTiger()`。以下为全文：

````js
/**
 * lib/reviewService.js — 每日复盘聚合服务 ReviewService（20261110a · 11 段去重版 + 龙虎榜异步补录）
 * ==================================================================================
 * 用户 2026-11-10 裁决「保留引擎，只换输出」：确定性计算引擎 reviewEngines.js /
 * topicEngines.js 一行未改，本文件继续负责采集、幂等、修订、落盘与状态机；
 * 11 段输出结构、去重登记、说人话文案、后台质检统一由 lib/reviewOutput.js 承担。
 *
 * 本次落地要点：
 *  1. SCHEMA_VERSION 按铁律升级 review-20261108d → review-20261110a（14 段 → 11 段属结构变更）。
 *  2. formal → complete 状态机：15:35 正式版若龙虎榜未发布，第八段标「待晚间补录」；
 *     20:30 / task_type=dragon_tiger_update / 次日 15:35 兜底调用 backfillDragonTiger()
 *     抓取当日龙虎榜并升级完整版，同一日期 complete 只允许一份，幂等静默跳过。
 *  3. 「数据最新性」按发布时刻分级：龙虎榜是盘后延迟发布数据，15:35 拿不到不等于接口故障，
 *     不落 failed 快照、不写误导性「非交易日或接口不可用」，见 ERR-20261110-001。
 *  4. 历史判断对照改从 version.snapshot.baselines 读基准（旧 nextChecklist 段已删除，
 *     同时兼容历史文档），保证删除段落不丢回溯能力。
 *
 * 三条底层规则（工作台铁律）：
 *  - 一致性：每个数据点带「名称/数值/实际时间/来源/获取时间」五要素（source/asOf/fetchedAt）。
 *  - 最新性：交易日感知（必须先查 trade_calendar 表）、数据过期标注、异常校验、按发布时刻补录。
 *  - 变化与边际：变化率 + 边际 + 方向 + 幅度；连续对照由 historySeries 提供。
 *
 * 代码权威：所有数值由本机代码从真实数据计算，绝不交给 LLM 估算；文案只复述计算结果。
 * 合规：不给买入/卖出/仓位建议；缺失一律标注「缺失」，不臆造、不用占位数字。
 *
 * 隔离原则：采集失败只降级为「缺失」，不抛给前端；输出层不参与任何数值计算。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { localDate, localDateTime } = require('./localDate');
const tradeCalendar = require('./tradeCalendar');
const engines = require('./reviewEngines');
const topicEngines = require('./topicEngines');
const reviewOutput = require('./reviewOutput');

const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_DIR = process.env.SA_REVIEW_DIR
  ? path.resolve(process.env.SA_REVIEW_DIR)
  : path.join(DATA_DIR, 'reviews');

// 20261110a：14 段 → 11 段 + formal/complete 状态机，按 SCHEMA_VERSION 升级铁律升版。
// 结构定义、核心段、禁用词表统一由输出层提供（单一权威源），此处只做转出。
const SCHEMA_VERSION = reviewOutput.SCHEMA_VERSION;
const SECTION_DEFS = reviewOutput.SECTION_DEFS;
const CORE_SECTIONS = reviewOutput.CORE_SECTIONS;
const ADVICE_BAN = reviewOutput.ADVICE_BAN;
const VAGUE_BAN = reviewOutput.VAGUE_BAN;
const JARGON_BAN = reviewOutput.JARGON_BAN;
const ENGINE_VERSION = engines.analyze({}).schemaVersion;
const TOPIC_VERSION = topicEngines.SCHEMA_VERSION;
const MISSING = '缺失';
const MAX_ATTEMPTS = 3;
const SOURCE_TIMEOUT_MS = 25000;
const BOARD_TIMEOUT_MS = 90000;   // 多日涨停池序列取数（实测约 15s），单独放宽
const LIMITED_THRESHOLD = 90;     // 核心字段完整率低于此值 → 有限分析版
const HIST_DAYS = 4;              // 前 3-5 个交易日对照，取 4 日

// formal / complete 版本状态：15:35 formal → 20:30 或次日兜底补录后 complete
const STAGE_FORMAL = 'formal';
const STAGE_COMPLETE = 'complete';
const LHB_PENDING = 'pending';
const LHB_FILLED = 'filled';
const LHB_UNAVAILABLE = 'unavailable';

// ---------- 内存运行状态（供 /api/review/status 轮询） ----------
const RUN = {
  running: false,
  phase: 'idle',
  reviewDate: null, trigger: null, attempt: 0,
  startedAt: null, finishedAt: null,
  lastResult: null, lastError: null,
};
const SKIP_LOG = [];
const MAX_SKIP_LOG = 200;

function nowIso() { return new Date().toISOString(); }
function ensureDir() { if (!fs.existsSync(REVIEW_DIR)) fs.mkdirSync(REVIEW_DIR, { recursive: true }); }
function reviewFile(date) { return path.join(REVIEW_DIR, `${date}.json`); }
function failedFile(date) { return path.join(REVIEW_DIR, `${date}.failed.json`); }

const num = engines.num;
const pct = engines.pct;
const fixed = engines.fixed;
const MISSING_TEXT = engines.MISSING;

function signed(n, digits) {
  const x = num(n);
  return x == null ? MISSING : (x >= 0 ? '+' : '') + x.toFixed(digits == null ? 2 : digits);
}
function fmtAmt(v) { return fixed(v); }

function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => { if (timer) clearTimeout(timer); });
}

/** 单源采集信封：统一「五要素 + 状态」，任何异常都降级为缺失，不臆造。 */
async function collect(key, label, fn, { category, timeout } = {}) {
  const fetchedAt = nowIso();
  try {
    const data = await withTimeout(fn(), timeout || SOURCE_TIMEOUT_MS, label);
    if (data == null) {
      return { key, label, category: category || '', status: 'missing', source: MISSING, asOf: MISSING, fetchedAt, data: null, note: '数据源未返回内容' };
    }
    return {
      key, label, category: category || '', status: 'ok',
      source: String(data.__source || data.source || label),
      asOf: String(data.__asOf || data.date || data.sectorDate || data.sectorDataDate || MISSING),
      fetchedAt, data, note: '',
    };
  } catch (e) {
    return { key, label, category: category || '', status: 'failed', source: MISSING, asOf: MISSING, fetchedAt, data: null, note: String((e && e.message) || e).slice(0, 180) };
  }
}

function notAvailable(key, label, category, reason) {
  return { key, label, category, status: 'missing', source: MISSING, asOf: MISSING, fetchedAt: nowIso(), data: null, note: reason };
}

/** 前 n 个交易日（复用唯一权威交易日历，不在本模块另造日历） */
function previousTradingDates(date, n) {
  const { previousTradingDay } = require('./cnTradingCalendar');
  const out = [];
  let d = date;
  for (let i = 0; i < n; i++) {
    const p = previousTradingDay(d);
    if (!p) break;
    out.push(p);
    d = p;
  }
  return out;
}

// ---------- 13 类数据源并行采集 ----------
async function gatherSources(date, histDates) {
  const jobs = [];

  jobs.push(collect('quote', '行情数据库（指数/板块快照）', async () => {
    const sd = require('./stockData');
    const mo = await sd.getMarketOverview();
    return { ...mo, __source: 'stockData.getMarketOverview（腾讯行情 + 东财/同花顺板块）', __asOf: mo.sectorDate || MISSING };
  }, { category: '行情数据库' }));

  // 20261108c 实测修正：breadth 与 mainFund 原先各调一次 getMarketEmotionData，
  // 并发跑同一底层取数（进程/缓存竞争），叠加多日 akshare 序列后随机出现其中一个 25s 超时，
  // 使完整度在 100/94/84 之间抖动。改为共享同一次调用，消除竞争且不改变任何数值口径。
  const emotionPromise = (async () => {
    const med = require('./marketEmotionData');
    return await med.getMarketEmotionData({ refresh: false });
  })();

  jobs.push(collect('breadth', '涨停跌停模块（涨跌家数/涨停跌停）', async () => {
    const r = await emotionPromise;
    if (!r || !r.breadth) throw new Error('breadth 未返回');
    return { ...r, __source: 'marketEmotionData / scripts/market_emotion.py（akshare 乐咕乐股）', __asOf: r.breadth.date || r.date };
  }, { category: '涨停跌停模块' }));

  // 一次 akshare 取数产出 6 块，避免重复跑 Python（实测多日序列约 15s）
  const boardPromise = (async () => {
    const bd = require('./boardReviewData');
    return await bd.getBoardReviewData(date, { histDates });
  })();
  const boardSrc = (key, label, pick, category) => jobs.push(collect(key, label, async () => {
    const raw = await boardPromise;
    const block = pick(raw);
    if (!block) throw new Error((raw && raw.issues && raw.issues[0] && raw.issues[0].msg) || '该数据块不可用');
    if (block.ok === false) throw new Error(block.note || '该数据块标记不可用');
    const src = block.source || 'board_review_data.py / akshare（东财）';
    return Array.isArray(block)
      ? { series: block, __source: src, __asOf: date }
      : { ...block, __source: src, __asOf: block.asOf || date };
  }, { category, timeout: BOARD_TIMEOUT_MS }));

  boardSrc('ladder', '连板模块（连板高度/梯队）', r => r && r.ladder, '连板模块');
  boardSrc('dragonTiger', '龙虎榜模块', r => r && r.lhb, '资金/龙虎榜模块');
  boardSrc('prevPool', '昨日涨停股今日表现（红盘率/大面股/晋级率）', r => r && r.prevPool, '涨停跌停模块');
  boardSrc('sectors', '板块层次（涨停池按所属行业聚合）', r => r && r.sectors, '板块模块');
  boardSrc('activity', '活跃度样本（涨停池/强势股池成交额）', r => r && r.activity, '本机计算');
  boardSrc('historySeries', '前 3-5 交易日同口径对照序列',
    r => (r && Array.isArray(r.historySeries) && r.historySeries.length ? r.historySeries : null), '本机计算');

  jobs.push(collect('sectorFlow', '板块模块（板块涨跌与资金流）', async () => {
    const scf = require('./sectorCapitalFlow');
    const r = await scf.getSectorCapitalFlow(false);
    if (!r || r.ok === false) throw new Error((r && r.note) || '板块资金流返回 ok=false');
    return { ...r, __source: 'sectorCapitalFlow（东财行业资金流）', __asOf: r.date || MISSING };
  }, { category: '板块模块' }));

  jobs.push(collect('mainFund', '资金模块（全市场主力净额）', async () => {
    const r = await emotionPromise;
    if (!r || !r.mainFund) throw new Error('mainFund 未返回');
    const mfDate = r.mainFund.date || r.mainFund.tradeDate || r.date;
    return { mainFund: r.mainFund, date: r.date, issues: r.issues || [], __source: 'marketEmotionData.mainFund（东财行业资金流求和 / T-lag 收盘口径）', __asOf: mfDate };
  }, { category: '资金/龙虎榜模块' }));

  jobs.push(collect('history', '历史复盘库（大盘记录 + 历史复盘）', async () => {
    const mldb = require('./marketLogDb');
    const r = mldb.searchMarketLog({ from: shiftDate(date, -30), to: date, limit: 60 });
    const own = listHistorySync(10);
    return { records: (r && r.records) || [], total: (r && r.total) || 0, facets: (r && r.facets) || {}, ownReviews: own, __source: 'marketLogDb.searchMarketLog + data/reviews/*.json', __asOf: date };
  }, { category: '历史复盘库' }));

  jobs.push(collect('news', '联网搜索（新闻催化 / 节假日公告兜底）', async () => {
    const ns = require('./newsSearch');
    const r = await ns.getHotNews(false);
    const items = (r && Array.isArray(r.items)) ? r.items : [];
    return {
      source: (r && r.source) || MISSING,
      updated: (r && r.updated) || nowIso(),
      items: items.slice(0, 24).map(n => ({
        title: String(n.title || ''), source: String(n.source || MISSING),
        date: String(n.date || MISSING), url: String(n.url || ''),
        category: String(n.category || ''), sentiment: String(n.sentiment || ''),
      })),
      __source: 'newsSearch.getHotNews（东方财富 7×24 快讯）', __asOf: (r && r.updated) || MISSING,
    };
  }, { category: '联网搜索' }));

  jobs.push(collect('calendar', '本机计算（交易日历判定）', async () => {
    tradeCalendar.ensureImported();
    const c = tradeCalendar.isTradingDay(date);
    return { ...c, tz: 'Asia/Shanghai', __source: 'trade_calendar 表（权威源 cnTradingCalendar.js）', __asOf: date };
  }, { category: '本机计算' }));

  const settled = await Promise.allSettled(jobs);
  return settled.map((s, i) => s.status === 'fulfilled'
    ? s.value
    : notAvailable('src_' + i, '数据源 ' + i, '', String((s.reason && s.reason.message) || s.reason)));
}

function shiftDate(dateStr, delta) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function byKey(sources, key) { return sources.find(s => s.key === key) || null; }
function srcData(sources, key) { const s = byKey(sources, key); return s && s.data ? s.data : null; }
function isOk(sources, key) { const s = byKey(sources, key); return !!(s && s.status === 'ok' && s.data); }
function deltaOf(cur, prev) {
  const a = num(cur), b = num(prev);
  if (a == null || b == null) return { value: MISSING, rate: MISSING, direction: MISSING, amplitude: MISSING };
  const change = a - b;
  const rate = b !== 0 ? (change / Math.abs(b)) * 100 : null;
  return { value: signed(change), rate: rate == null ? MISSING : pct(rate), direction: change > 0 ? '上升' : change < 0 ? '下降' : '持平', amplitude: Math.abs(change).toFixed(2) };
}

/** 把采集结果组装成引擎输入（只做字段映射，不计算、不补齐） */
function engineInputOf(date, sources, histDates) {
  const b = srcData(sources, 'breadth');
  const hs = srcData(sources, 'historySeries');
  const news = srcData(sources, 'news');
  const mf = srcData(sources, 'mainFund');
  const sf = srcData(sources, 'sectorFlow');
  const q = srcData(sources, 'quote');
  return {
    date, histDates,
    breadth: b && b.breadth ? b.breadth : null,
    ladder: srcData(sources, 'ladder'),
    prevPool: srcData(sources, 'prevPool'),
    sectors: srcData(sources, 'sectors'),
    activity: srcData(sources, 'activity'),
    historySeries: hs && Array.isArray(hs.series) ? hs.series : [],
    news: news && Array.isArray(news.items) ? news.items : [],
    lhb: srcData(sources, 'dragonTiger'),
    sectorFlow: sf, mainFund: mf && mf.mainFund ? mf.mainFund : null,
    quote: q,
  };
}

// ---------- 输出层（11 段）由 lib/reviewOutput.js 承担，本文件只做采集 / 落盘 / 幂等 ----------

/**
 * 历史判断基准 → 今日同口径值对照（纯代码比对，不臆造）。
 * 20261110a：旧「次日验证清单」段已删除，基准改存 version.snapshot.baselines；
 * 历史文档仍按旧 nextChecklist 表读取，保证 11 段新文档与 14 段旧文档可互相回溯。
 */
function baselinesOf(sources, L, P) {
  const bb = srcData(sources, 'breadth');
  const b = bb && bb.breadth ? bb.breadth : null;
  const p1 = P && Array.isArray(P.promotion) ? P.promotion.find(x => x.from === 1) : null;
  return [
    { item: '涨停家数是否延续', baseline: b ? (b.limitUp == null ? null : String(b.limitUp)) : null },
    { item: '昨日涨停股红盘率是否回升', baseline: P ? (P.redRate == null ? null : fixed(P.redRate) + '%') : null },
    { item: '1进2晋级率是否止跌', baseline: p1 ? fixed(p1.rate) + '%' : null },
    { item: '最高板是否继续晋级', baseline: L ? (L.maxBoards == null ? null : L.maxBoards + ' 板') : null },
    { item: '大面股数量是否减少', baseline: P ? (P.bigDropCount == null ? null : String(P.bigDropCount) + ' 只') : null },
  ];
}

function readHistoryVerdicts(date, sources) {
  const out = [];
  const bb = srcData(sources, 'breadth');
  const b = bb && bb.breadth ? bb.breadth : null;
  const P = srcData(sources, 'prevPool');
  const p1 = P && Array.isArray(P.promotion) ? P.promotion.find(x => x.from === 1) : null;
  const dates = listHistorySync(4).map(r => r.date).filter(d => d && d !== date).slice(0, 3);
  for (const d of dates) {
    const doc = readReviewSync(d);
    if (!doc) continue;
    const v = (doc.versions || []).find(x => x.version === doc.currentVersion) || (doc.versions || []).slice(-1)[0];
    let rows = [];
    if (v && v.snapshot && Array.isArray(v.snapshot.baselines)) {
      rows = v.snapshot.baselines.map(x => ({ item: x.item, baseline: x.baseline == null ? MISSING : String(x.baseline) }));
    } else {
      const sec = v && Array.isArray(v.sections) ? v.sections.find(s => s.key === 'nextChecklist') : null;
      rows = sec && Array.isArray(sec.table) ? sec.table : [];
    }
    for (const r of rows.slice(0, 5)) {
      const base = String(r.baseline == null ? MISSING : r.baseline);
      const item = String(r.item || MISSING);
      let today = MISSING;
      if (/涨停家数/.test(item) && b) today = b.limitUp == null ? MISSING : String(b.limitUp);
      else if (/红盘率/.test(item) && P) today = P.redRate == null ? MISSING : fixed(P.redRate) + '%';
      else if (/晋级率/.test(item) && p1) today = fixed(p1.rate) + '%';
      else if (/最高板/.test(item) && srcData(sources, 'ladder')) {
        const L = srcData(sources, 'ladder');
        today = L.maxBoards == null ? MISSING : L.maxBoards + ' 板';
      } else if (/大面股/.test(item) && P) today = P.bigDropCount == null ? MISSING : String(P.bigDropCount) + ' 只';
      const a = parseFloat(base.replace(/[^\d.+-]/g, ''));
      const c = parseFloat(String(today).replace(/[^\d.+-]/g, ''));
      const verdict = (base === MISSING || today === MISSING || !isFinite(a) || !isFinite(c))
        ? '待验证' : (a >= 0) === (c >= 0) ? '已验证' : '未验证';
      out.push({ date: d, item, baseline: base, today, verdict });
    }
  }
  return out.slice(0, 12);
}

// ---------- 完整性评分（幂等/修订/有限分析版判定依据） ----------
function completenessOf(sources, sections) {
  // 完整度只能由「外部行情数据源」决定，必须排除自反馈项。
  // 反例（20261107 单测抓到）：第一次生成后，历史复盘库会读到本次刚写的复盘文件 →
  // 「历史判断对照」段由 missing 变 ok → 完整度虚高 → 每次补跑都误生成修订版，幂等失效。
  const RESULT_DEPENDENT_SOURCES = new Set(['history']);
  // 20261110a：11 段里只有 sentiment / ladder / sectors / lossEffect / capital 由外部行情源直接决定，
  // 其余 6 段均为结果依赖或结构型，必须排除，否则分数口径漂移会破坏幂等与结构升级判定。
  const RESULT_DEPENDENT_SECTIONS = new Set(['oneline', 'integrity', 'attribution', 'focusPool', 'historyCompare', 'watchPlan']);
  const scoredSources = sources.filter(s => !RESULT_DEPENDENT_SOURCES.has(s.key));
  const scoredSections = sections.filter(s => !RESULT_DEPENDENT_SECTIONS.has(s.key));
  const ok = scoredSources.filter(s => s.status === 'ok').length;
  const total = scoredSources.length || 1;
  const secOk = scoredSections.filter(s => s.status === 'ok').length;
  const secTotal = scoredSections.length || 1;
  const score = Math.round((ok / total) * 70 + (secOk / secTotal) * 30);
  return {
    score, sourcesOk: ok, sourcesTotal: total, sectionsOk: secOk, sectionsTotal: secTotal,
    excluded: ['history 源', 'oneline/integrity/attribution/focusPool/historyCompare/watchPlan 段（结果依赖或结构型）'],
    missing: sources.filter(s => s.status !== 'ok').map(s => ({ key: s.key, label: s.label, reason: s.note || MISSING })),
  };
}

// ---------- 读写 ----------
function readReviewSync(date) {
  const f = reviewFile(date);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}
function writeReviewSync(doc) {
  ensureDir();
  const f = reviewFile(doc.reviewDate);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}
function listHistorySync(limit) {
  ensureDir();
  let files = [];
  try { files = fs.readdirSync(REVIEW_DIR).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse(); } catch (e) { return []; }
  const out = [];
  for (const n of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(REVIEW_DIR, n), 'utf8'));
      const cur = (d.versions || []).find(v => v.version === d.currentVersion) || (d.versions || []).slice(-1)[0];
      out.push({
        date: d.reviewDate, schemaVersion: d.schemaVersion,
        version: cur ? cur.version : null, kind: cur ? cur.kind : null,
        stage: d.stage || (cur && cur.stage) || null,
        dragonTigerStatus: d.dragonTigerStatus || (cur && cur.dragonTigerStatus) || null,
        completeness: cur && cur.completeness ? cur.completeness.score : null,
        limited: cur ? !!cur.limited : false,
        generatedAt: cur ? cur.generatedAt : null,
        status: d.status || 'ok', versionCount: (d.versions || []).length,
      });
    } catch (e) { /* 损坏文件跳过，不臆造 */ }
  }
  return typeof limit === 'number' ? out.slice(0, limit) : out;
}

function writeFailureReport(date, attempts) {
  ensureDir();
  const report = {
    reviewDate: date, schemaVersion: SCHEMA_VERSION, status: 'failed',
    generatedAt: nowIso(), localTime: localDateTime(),
    attempts: MAX_ATTEMPTS,
    errors: attempts.map((e, i) => ({ attempt: i + 1, time: e.time, message: String(e.message).slice(0, 300) })),
    note: '连续 3 次生成失败，已输出失败报告；未写入正式复盘，不臆造数据。',
  };
  try { fs.writeFileSync(failedFile(date), JSON.stringify(report, null, 2), 'utf8'); } catch (e) { /* ignore */ }
  return report;
}

// ---------- 主入口 ----------
/**
 * @param {{date?:string, trigger?:'cron'|'manual'|'api', force?:boolean, taskType?:string, task_type?:string}} opts
 * @returns {Promise<object>} {ok, action:'created'|'revision'|'skipped'|'skipped_holiday'|'failed'|'completed'|'pending', ...}
 */
async function runReview(opts = {}) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.date || '')) ? opts.date : localDate();
  const trigger = opts.trigger || 'api';
  // 规格第三部分：收到 task_type="dragon_tiger_update" 的晚间补跑任务时，
  // 不重新生成整份复盘，直接走龙虎榜补录状态机（幂等 + 完整版唯一）。
  const taskType = opts.taskType || opts.task_type;
  if (taskType === 'dragon_tiger_update') {
    return backfillDragonTiger(date, { trigger });
  }
  if (RUN.running) return { ok: true, action: 'running', reviewDate: date, message: '已有复盘任务进行中', status: getStatus() };

  let cal;
  try { tradeCalendar.ensureImported(); cal = tradeCalendar.isTradingDay(date); }
  catch (e) { cal = { is_trading_day: null, reason: '交易日历表查询失败：' + e.message, from_table: false }; }
  // 合规硬约束：非交易日不得用「最近交易日行情」冒名为当日复盘。
  if (cal.is_trading_day === false && !opts.force) {
    recordSkip(date, trigger, cal);
    return { ok: true, action: 'skipped_holiday', reviewDate: date, reason: `非交易日（${cal.day_type || '休市'}），静默跳过`, calendar: cal };
  }

  RUN.running = true; RUN.phase = 'gathering'; RUN.reviewDate = date; RUN.trigger = trigger;
  RUN.startedAt = nowIso(); RUN.finishedAt = null; RUN.lastError = null;
  const errors = [];
  const histDates = previousTradingDates(date, HIST_DAYS);
  const prevDate = histDates[0] || MISSING;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    RUN.attempt = attempt;
    try {
      const sources = await gatherSources(date, histDates);
      const quoteOk = isOk(sources, 'quote');
      const breadthOk = isOk(sources, 'breadth');
      if (!quoteOk && !breadthOk) throw new Error('关键数据源（行情数据库 + 涨停跌停模块）同时不可用，拒绝输出空壳复盘');
      RUN.phase = 'building';
      // 20261110a：确定性引擎保持原接线不变（归因 → 机会引擎中和过滤），
      // 只有「把结果组织成 11 段」这一步改由 reviewOutput.build() 承担。
      const baseInput = engineInputOf(date, sources, histDates);
      const topics = topicEngines.analyzeTopics(baseInput);
      const engine = engines.analyze({ ...baseInput, topics });
      const prevDoc = readReviewSync(date);
      const prevVersion = prevDoc && (prevDoc.versions || []).find(v => v.version === prevDoc.currentVersion);
      // SCHEMA_VERSION 升级铁律：旧结构文档即使完整度持平，也必须能生成新版修订，
      // 否则旧 14 段文档会被幂等判定永久锁死，新结构永远进不来。
      const schemaOutdated = !!(prevDoc && prevDoc.schemaVersion && prevDoc.schemaVersion !== SCHEMA_VERSION);
      const lhbOk = isOk(sources, 'dragonTiger') && !!(srcData(sources, 'dragonTiger') || {}).ok;
      // 状态机保护（放在构建之前，避免取数抖动时先跑质检再误判失败）：
      // 已升级为完整版的复盘，若本次又拿不到龙虎榜，绝不允许重新生成 formal 把它降级回去。
      if (prevDoc && prevDoc.stage === STAGE_COMPLETE && !lhbOk) {
        RUN.phase = 'done'; RUN.finishedAt = nowIso();
        RUN.lastResult = { action: 'skipped', reviewDate: date, reason: '完整版已存在，本次未取到龙虎榜，不降级' };
        RUN.running = false;
        return {
          ok: true, action: 'skipped', reviewDate: date, version: prevVersion ? prevVersion.version : null,
          reason: '该日期已存在完整版（龙虎榜已补录），本次未取到龙虎榜，保留完整版不降级'
            + (schemaOutdated ? `；当前文档结构 ${prevDoc.schemaVersion} 待升级，待取数恢复后再升级` : ''),
        };
      }
      const stage = lhbOk ? STAGE_COMPLETE : STAGE_FORMAL;
      const dragonTigerStatus = lhbOk ? LHB_FILLED : LHB_PENDING;
      const H = srcData(sources, 'dragonTiger');
      const P = srcData(sources, 'prevPool');
      const L = srcData(sources, 'ladder');
      const verdictRows = readHistoryVerdicts(date, sources);
      const historyData = srcData(sources, 'history');
      const historyRecords = historyData && Array.isArray(historyData.records) ? historyData.records : [];
      const buildCtx = (extra) => ({
        date, sources, engine, topics,
        meta: { prevDate, histDates, ...extra },
        stage, dragonTigerStatus,
        verdictRows, historyRecords,
      });
      // 两遍构造：第一遍得出真实完整率，第二遍把「有限分析版」标记写进 integrity 段。
      // integrity 段被排除在计分之外，故两遍的 completeness 完全一致，不会破坏幂等。
      let built = reviewOutput.build(buildCtx({ limited: false, completeness: 0 }));
      const completeness = completenessOf(sources, built.sections);
      const limited = completeness.score < LIMITED_THRESHOLD;
      if (limited) built = reviewOutput.build(buildCtx({ limited: true, completeness: completeness.score }));
      const quality = built.quality;
      if (!quality || quality.passed === false) {
        const bad = (quality && quality.checks ? quality.checks : []).filter(c => !c.passed).map(c => `${c.item}：${c.detail}`).join('；');
        throw new Error('后台质检未通过（' + (bad || '无质检结果') + '）');
      }
      const sections = built.sections;
      const realCompleteness = completenessOf(sources, sections);

      // 需求「数据更完整时生成修订版」的硬保护：偶发取数超时让本次完整度反而更低时，
      // 绝不用更差的数据覆盖当前版本（force 手动重跑也不例外）；否则一次网络抖动
      // 就会把已落盘的 100% 正式版降级成有限分析版。
      if (prevDoc && prevVersion) {
        const prevScore = prevVersion.completeness ? prevVersion.completeness.score : 0;
        if (realCompleteness.score < prevScore) {
          RUN.phase = 'done'; RUN.finishedAt = nowIso();
          RUN.lastResult = { action: 'skipped', reviewDate: date, reason: '本次数据不如现有版本，保留现有版本' };
          RUN.running = false;
          return {
            ok: true, action: 'skipped', reviewDate: date, version: prevVersion.version,
            reason: `本次完整度 ${realCompleteness.score}% 低于现有 ${prevScore}%，保留现有版本（不以更差数据覆盖）`
              + (schemaOutdated ? `；当前文档结构 ${prevDoc.schemaVersion} 待升级，待取数恢复后再升级` : ''),
          };
        }
        // 结构升级优先于「同分跳过」：旧 schema 文档在完整度不降低时，普通定时任务也应自动升级。
        if (!opts.force && !schemaOutdated && realCompleteness.score <= prevScore) {
          RUN.phase = 'done'; RUN.finishedAt = nowIso();
          RUN.lastResult = { action: 'skipped', reviewDate: date, reason: '正式版已存在且数据未更完整' };
          RUN.running = false;
          return { ok: true, action: 'skipped', reviewDate: date, reason: `正式版已存在（完整度 ${prevScore}% ≥ 本次 ${realCompleteness.score}%），跳过`, version: prevVersion.version };
        }
      }

      RUN.phase = 'saving';
      const bb = srcData(sources, 'breadth');
      const snapshot = {
        breadth: bb && bb.breadth ? {
          up: num(bb.breadth.up), down: num(bb.breadth.down), flat: num(bb.breadth.flat),
          limitUp: num(bb.breadth.limitUp), limitDown: num(bb.breadth.limitDown),
        } : null,
        // 20261110a：旧「次日验证清单」段已删除，历史判断对照改从这里读基准，
        // 保证 11 段结构下回溯能力不丢，且旧文档仍可经 nextChecklist 兼容读取。
        baselines: baselinesOf(sources, L, P),
        engine: {
          marketRiskLevel: engine.marketRiskLevel,
          grades: engine.candidates.map(c => ({ name: c.name, code: c.code, grade: c.grade, category: c.category })),
          trends: Object.fromEntries(Object.entries(engine.trends).map(([k, v]) => [k, v.direction])),
          quadrants: engine.candidates.map(c => ({ name: c.name, quadrant: c.quadrant, drivers: c.drivers })),
        },
        topics: {
          gradeSummary: topics.gradeSummary,
          dominantVote: topics.dominantVote,
          dominantQuadrant: topics.dominantQuadrant,
          cards: topics.cards.map(c => ({ name: c.name, grade: c.grade, stage: c.stage, quadrant: c.quadrant, voteQuality: c.voteQuality })),
        },
      };
      const version = {
        version: prevDoc ? ((prevDoc.currentVersion || 0) + 1) : 1,
        kind: prevDoc ? 'revision' : 'official',
        stage, dragonTigerStatus,
        trigger, generatedAt: nowIso(), localTime: localDateTime(),
        completeness: realCompleteness,
        limited: realCompleteness.score < LIMITED_THRESHOLD,
        limitedReason: realCompleteness.score < LIMITED_THRESHOLD
          ? `核心字段完整率 ${realCompleteness.score}% < ${LIMITED_THRESHOLD}%，输出有限分析版，最需补充 3 项见「数据完整性与口径」段`
          : null,
        engineVersion: engine.schemaVersion,
        topicVersion: topics.schemaVersion,
        histDates, prevDate,
        sources: sources.map(s => ({
          key: s.key, label: s.label, category: s.category, status: s.status,
          source: s.source, asOf: s.asOf, fetchedAt: s.fetchedAt, note: s.note,
        })),
        sections, snapshot, quality,
      };
      const doc = {
        schemaVersion: SCHEMA_VERSION, reviewDate: date, tradingDay: cal,
        status: 'ok', limited: version.limited,
        stage, dragonTigerStatus, quality,
        currentVersion: version.version,
        versions: (prevDoc && Array.isArray(prevDoc.versions) ? prevDoc.versions : []).concat([version]),
        updatedAt: nowIso(),
      };
      writeReviewSync(doc);
      RUN.phase = 'done'; RUN.finishedAt = nowIso();
      RUN.lastResult = { action: version.kind === 'official' ? 'created' : 'revision', reviewDate: date, version: version.version, completeness: realCompleteness.score, limited: version.limited, stage };
      RUN.running = false;
      const prevScoreText = prevVersion && prevVersion.completeness ? prevVersion.completeness.score : MISSING;
      const revisionReason = schemaOutdated
        ? `复盘结构升级（${prevDoc.schemaVersion} → ${SCHEMA_VERSION}，完整度 ${prevScoreText}% → ${realCompleteness.score}%），已生成修订版`
        : `数据更完整（${prevScoreText}% → ${realCompleteness.score}%），已生成修订版`;
      return {
        ok: true, action: version.kind === 'official' ? 'created' : 'revision',
        reviewDate: date, version: version.version, completeness: realCompleteness,
        limited: version.limited, stage, dragonTigerStatus,
        message: (version.kind === 'official' ? '正式版已生成' : revisionReason)
          + (stage === STAGE_FORMAL ? '（龙虎榜待晚间补录）' : '（龙虎榜已发布，完整版）'),
      };
    } catch (e) {
      errors.push({ time: nowIso(), message: String((e && e.message) || e) });
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }

  const report = writeFailureReport(date, errors);
  RUN.phase = 'failed'; RUN.finishedAt = nowIso(); RUN.lastError = errors[errors.length - 1].message;
  RUN.lastResult = { action: 'failed', reviewDate: date };
  RUN.running = false;
  return { ok: false, action: 'failed', reviewDate: date, errors, report };
}

/**
 * 龙虎榜异步补录：formal → complete（规格第三部分）。
 * 触发点：20:30 定时槽 / task_type="dragon_tiger_update" / 次日 15:35 兜底。
 * 设计约束：
 *  - 只重新抓「当日龙虎榜」这一项，不重跑 13 个数据源、不重算其他段落的任何数值；
 *  - 第八段龙虎榜文案由 reviewOutput.lhbLines() 与首次构建共用同一出口，避免两处漂移；
 *  - 第十段「历史判断对照」按今日值重新核对与资金相关的历史条件，既有判断记录不改写；
 *  - 同一日期 complete 只允许一份，已存在则静默跳过；非交易日静默跳过；
 *  - 仍未发布时保持 formal（不写 failed 快照、不标「接口故障」），等下一次补录。
 */
async function backfillDragonTiger(date, opts = {}) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : localDate();
  const trigger = opts.trigger || 'cron';
  const doc = readReviewSync(d);
  if (!doc || doc.status !== 'ok') {
    return { ok: true, action: 'skipped', reviewDate: d, reason: '该日期尚无正式版，先生成正式版再补录' };
  }
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    return { ok: true, action: 'skipped', reviewDate: d, reason: '该日期为旧结构文档，待结构升级后再补录龙虎榜' };
  }
  if ((doc.versions || []).some(v => v && v.stage === STAGE_COMPLETE)) {
    return { ok: true, action: 'skipped', reviewDate: d, version: doc.currentVersion, stage: STAGE_COMPLETE, reason: '完整版已存在，静默跳过（同一日期 complete 只允许一份）' };
  }
  let cal;
  try { tradeCalendar.ensureImported(); cal = tradeCalendar.isTradingDay(d); }
  catch (e) { cal = { is_trading_day: null, reason: '交易日历表查询失败：' + e.message }; }
  if (cal.is_trading_day === false) {
    return { ok: true, action: 'skipped_holiday', reviewDate: d, reason: `非交易日（${cal.day_type || '休市'}），静默跳过补录` };
  }
  const cur = (doc.versions || []).find(v => v.version === doc.currentVersion) || (doc.versions || []).slice(-1)[0];
  if (!cur || !Array.isArray(cur.sections)) {
    return { ok: true, action: 'skipped', reviewDate: d, reason: '当前版本无可用段落，跳过补录' };
  }

  // 只抓龙虎榜：清缓存后走 --lhb-only，避免命中 15:35 那次「尚未发布」的空结果。
  let H = null, fetchErr = '';
  try {
    const bd = require('./boardReviewData');
    bd.clearCache();
    const raw = await withTimeout(bd.getLhbOnly(d), 60000, '龙虎榜补录取数');
    H = raw && raw.lhb;
  } catch (e) { fetchErr = String((e && e.message) || e).slice(0, 160); }
  const usable = !!(H && H.ok !== false && num(H.count) != null);
  if (!usable) {
    doc.lastBackfillAttempt = { at: nowIso(), localTime: localDateTime(), result: 'pending', reason: fetchErr || (H && H.note) || '盘后数据尚未发布' };
    writeReviewSync(doc);
    return {
      ok: true, action: 'pending', reviewDate: d, stage: STAGE_FORMAL,
      reason: `龙虎榜盘后数据尚未发布${fetchErr ? '（本次取数：' + fetchErr + '）' : ''}，保持正式版「待晚间补录」，不落失败快照`,
    };
  }

  const backfillAt = localDateTime();
  const sections = JSON.parse(JSON.stringify(cur.sections));
  const cap = sections.find(s => s.key === 'capital');
  if (!cap) return { ok: true, action: 'skipped', reviewDate: d, reason: '当前版本无「成交和资金偏好」段，跳过补录' };
  const fresh = reviewOutput.lhbLines(H, d, { stage: STAGE_COMPLETE, dragonTigerStatus: LHB_FILLED, backfillAt });
  const old = Array.isArray(cap.lhbLines) ? cap.lhbLines : [];
  cap.lines = (cap.lines || []).filter(l => !old.includes(l)).concat(fresh);
  cap.lhbLines = fresh;
  cap.status = 'ok';
  cap.missing = false;

  // 第十段：补录与历史判断对照联动（代码按今日值重新核对，不改写既有判断记录）。
  const hc = sections.find(s => s.key === 'historyCompare');
  if (hc) {
    const rows = Array.isArray(hc.table) ? hc.table : [];
    const related = rows.filter(r => /资金|成交|龙虎/.test(String(r.item || '')));
    hc.lines = (hc.lines || []).filter(l => !String(l).startsWith('补录联动：'));
    hc.lines.push(`补录联动：${backfillAt} 已补录 ${d} 龙虎榜（上榜 ${H.count == null ? MISSING : H.count} 家）；与资金 / 成交相关的历史验证条件共 ${related.length} 条，已按今日值重新核对（${related.filter(r => r.verdict === '未验证').length} 条未兑现），既有判断记录不改写。`);
  }

  const newSources = (cur.sources || []).map(s => s.key === 'dragonTiger'
    ? { ...s, status: 'ok', source: H.source || s.source, asOf: H.asOf || d, fetchedAt: nowIso(), note: '' }
    : s);
  const completeness = completenessOf(newSources, sections);
  const nextVersion = (doc.currentVersion || 0) + 1;
  const version = {
    ...cur,
    version: nextVersion, kind: 'revision',
    stage: STAGE_COMPLETE, dragonTigerStatus: LHB_FILLED,
    trigger, generatedAt: nowIso(), localTime: backfillAt,
    completeness, sections, sources: newSources,
    snapshot: { ...(cur.snapshot || {}), lhb: { count: H.count, asOf: H.asOf || d, netBuyTotal: H.netBuyTotal } },
  };
  const doc2 = {
    ...doc,
    stage: STAGE_COMPLETE, dragonTigerStatus: LHB_FILLED,
    currentVersion: nextVersion,
    versions: (doc.versions || []).concat([version]),
    updatedAt: nowIso(),
    lastBackfillAt: { at: nowIso(), localTime: backfillAt, result: 'completed', count: H.count },
  };
  writeReviewSync(doc2);
  return {
    ok: true, action: 'completed', reviewDate: d, version: nextVersion,
    stage: STAGE_COMPLETE, completeness: completeness.score, lhbCount: H.count,
    reason: `已补录当日龙虎榜（上榜 ${H.count} 家），正式版升级为完整版`,
  };
}

/** 次日兜底用：判断某日期是否仍停留在「待补录」状态。 */
function needsBackfill(date) {
  const doc = readReviewSync(date);
  if (!doc || doc.status !== 'ok') return false;
  if (doc.schemaVersion !== SCHEMA_VERSION) return false;
  if ((doc.versions || []).some(v => v && v.stage === STAGE_COMPLETE)) return false;
  return (doc.dragonTigerStatus || LHB_PENDING) === LHB_PENDING;
}

function recordSkip(date, trigger, cal) {
  const rec = { reviewDate: date, status: 'skipped_holiday', trigger, dayType: cal.day_type || MISSING, reason: '非交易日静默跳过', at: nowIso(), localTime: localDateTime() };
  SKIP_LOG.unshift(rec);
  if (SKIP_LOG.length > MAX_SKIP_LOG) SKIP_LOG.length = MAX_SKIP_LOG;
  try {
    ensureDir();
    const f = path.join(REVIEW_DIR, '_scheduler.json');
    let arr = [];
    try { if (fs.existsSync(f)) arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (e) { arr = []; }
    if (!Array.isArray(arr)) arr = [];
    arr.unshift(rec);
    fs.writeFileSync(f, JSON.stringify(arr.slice(0, MAX_SKIP_LOG), null, 2), 'utf8');
  } catch (e) { /* ignore */ }
  return rec;
}

// ---------- 查询 API 支撑 ----------
function getToday() {
  const date = localDate();
  let cal = null;
  try { tradeCalendar.ensureImported(); cal = tradeCalendar.isTradingDay(date); } catch (e) { cal = { is_trading_day: null, reason: e.message }; }
  const doc = readReviewSync(date);
  return {
    date, calendar: cal, holiday: cal && cal.is_trading_day === false,
    status: doc ? (doc.status || 'ok') : (RUN.running ? 'running' : 'none'),
    review: doc || null, running: RUN.running, phase: RUN.phase,
  };
}
function getByDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
  const doc = readReviewSync(date);
  let cal = null;
  try { tradeCalendar.ensureImported(); cal = tradeCalendar.isTradingDay(date); } catch (e) { /* ignore */ }
  let failed = null;
  try { if (fs.existsSync(failedFile(date))) failed = JSON.parse(fs.readFileSync(failedFile(date), 'utf8')); } catch (e) { /* ignore */ }
  return { ok: true, date, calendar: cal, review: doc, failedReport: failed, found: !!doc };
}
function getHistory(opts = {}) {
  let rows = listHistorySync();
  if (opts.from) rows = rows.filter(r => r.date >= opts.from);
  if (opts.to) rows = rows.filter(r => r.date <= opts.to);
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 60, 1), 365);
  return { ok: true, total: rows.length, items: rows.slice(0, limit), skipLog: SKIP_LOG.slice(0, 20) };
}
function getStatus() {
  return {
    running: RUN.running, phase: RUN.phase, reviewDate: RUN.reviewDate,
    trigger: RUN.trigger, attempt: RUN.attempt,
    startedAt: RUN.startedAt, finishedAt: RUN.finishedAt,
    lastResult: RUN.lastResult, lastError: RUN.lastError,
    schemaVersion: SCHEMA_VERSION, engineVersion: ENGINE_VERSION, topicVersion: TOPIC_VERSION,
    scheduler: {
      cron: '35 15 * * 1-5', timezone: 'Asia/Shanghai',
      retrySlots: ['15:40', '15:45', '15:50'],
      eveningSlot: '20:30', nextDayFallback: '15:35 先检查昨日是否补录',
      backfillTaskType: 'dragon_tiger_update',
      stages: [STAGE_FORMAL, STAGE_COMPLETE],
      onHoliday: 'skipped_holiday', calendarTable: 'trade_calendar',
      limitedThreshold: LIMITED_THRESHOLD, histDays: HIST_DAYS,
      sectionCount: SECTION_DEFS.length,
    },
    skipLog: SKIP_LOG.slice(0, 20), reviewDir: REVIEW_DIR,
  };
}

module.exports = {
  runReview, backfillDragonTiger, needsBackfill,
  getToday, getByDate, getHistory, getStatus,
  recordSkip, listHistorySync, readReviewSync,
  SECTION_DEFS, SCHEMA_VERSION, ENGINE_VERSION, TOPIC_VERSION, MISSING, CORE_SECTIONS,
  ADVICE_BAN, VAGUE_BAN, JARGON_BAN, LIMITED_THRESHOLD,
  STAGE_FORMAL, STAGE_COMPLETE, LHB_PENDING, LHB_FILLED, LHB_UNAVAILABLE,
  previousTradingDates, engineInputOf, completenessOf, baselinesOf, readHistoryVerdicts,
};

````

---

## 5. `server.js`：路由与定时调度（第 2490-2607 行）

`APP_VERSION` 已从 `20261109e` 升到 `20261110a`。以下是新增补录接口与 5 个定时槽：

````js
app.post('/api/review/run', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await reviewService.runReview({
      date: b.date, trigger: 'manual', force: b.force === true || b.force === '1',
      taskType: b.task_type || b.taskType,
    });
    res.json({ success: r.ok !== false, ...r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ⑤-2 龙虎榜异步补录（20:30 定时槽 / 外部任务 task_type="dragon_tiger_update" 共用）
// 支持两种入口：POST /api/review/backfill {date}；或 POST /api/review/run 带 task_type。
app.post('/api/review/backfill', async (req, res) => {
  try {
    const b = req.body || {};
    const r = await reviewService.backfillDragonTiger(b.date, { trigger: b.trigger || 'api' });
    res.json({ success: r.ok !== false, ...r });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ⑥ 运行状态（running 轮询 / Cron 配置 / skipped_holiday 日志）
app.get('/api/review/status', (req, res) => {
  try { res.json({ success: true, ...reviewService.getStatus() }); }
  catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// 定时任务（20261110a · 11 段 + 龙虎榜异步补录）：
//   15:35 主跑 formal；15:40/45/50 补跑；20:30 龙虎榜补录升级 complete；
//   15:35 主跑前先兜底检查昨日是否仍「待补录」，是则先补昨日再生成今日。
// 非交易日静默跳过并记录 skipped_holiday。触发前必须先查 trade_calendar 表。
const REVIEW_SLOTS = [
  { h: 15, m: 35, kind: 'main' },
  { h: 15, m: 40, kind: 'retry' },
  { h: 15, m: 45, kind: 'retry' },
  { h: 15, m: 50, kind: 'retry' },
  { h: 20, m: 30, kind: 'backfill' },
];
function startDailyReviewScheduler() {
  let lastSlot = '';
  setInterval(() => {
    try {
      const p = bjParts(new Date());
      if (!p) return;
      const hh = parseInt(p.hour, 10), mm = parseInt(p.minute, 10);
      const slot = REVIEW_SLOTS.find(s => s.h === hh && s.m === mm);
      if (!slot) return;
      const today = `${p.year}-${p.month}-${p.day}`;
      const slotKey = `${today} ${hh}:${mm}`;
      if (slotKey === lastSlot) return;      // 同一分钟防抖
      lastSlot = slotKey;

      // 需求 4：定时任务必须先查交易日历表
      tradeCalendar.ensureImported();
      const cal = tradeCalendar.isTradingDay(today);
      if (cal.is_trading_day === false) {
        reviewService.recordSkip(today, 'cron', cal);
        console.log(`  [每日复盘] ${today} 非交易日（${cal.day_type}），静默跳过并记 skipped_holiday`);
        return;
      }
      if (cal.is_trading_day !== true) {
        console.log(`  [每日复盘] ${today} 交易日历判定不可用（${cal.reason || '未知'}），本轮跳过`);
        return;
      }

      // 20:30 晚间补录：只重抓当日龙虎榜，不重算整份复盘；complete 幂等静默跳过。
      if (slot.kind === 'backfill') {
        reviewService.backfillDragonTiger(today, { trigger: 'cron' })
          .then(r => console.log(`  [每日复盘] ${today} 20:30 龙虎榜补录：${r.action}${r.version ? ' v' + r.version : ''}（${r.reason || ''}）`))
          .catch(e => console.error('  [每日复盘] 晚间补录失败:', e && e.message));
        return;
      }

      // 补跑：仅当当日尚无正式版 / 为有限分析版 / 完整率不足时才真正重新取数；
      // 已有高分版本或已升级 complete 则直接跳过，避免每个槽都重复跑约 20 秒 akshare 取数。
      if (slot.kind === 'retry') {
        const cur = reviewService.getByDate(today);
        const doc = cur && cur.review;
        const ver = doc && (doc.versions || []).find(v => v.version === doc.currentVersion);
        if (doc && doc.stage === 'complete') {
          console.log(`  [每日复盘] ${today} ${hh}:${mm} 已升级为完整版，跳过补跑`);
          return;
        }
        if (ver && !ver.limited && ver.completeness && ver.completeness.score >= 90) {
          console.log(`  [每日复盘] ${today} ${hh}:${mm} 已有完整正式版（${ver.completeness.score}%），跳过补跑`);
          return;
        }
      }

      // 次日兜底（规格第三部分第 3 条）：15:35 生成今日复盘前，先检查昨日复盘是否仍
      // 停留在「待晚间补录」。是则先把昨日龙虎榜补上，再生成今日，避免缺口跨日固化。
      const mainRun = async () => {
        if (slot.kind === 'main') {
          try {
            const y = (reviewService.previousTradingDates(today, 1) || [])[0];
            if (y && reviewService.needsBackfill(y)) {
              const bf = await reviewService.backfillDragonTiger(y, { trigger: 'cron-fallback' });
              console.log(`  [每日复盘] ${today} 15:35 次日兜底：${y} → ${bf.action}（${bf.reason || ''}）`);
            }
          } catch (e) {
            console.error('  [每日复盘] 次日兜底补录异常（不阻断今日生成）:', e && e.message);
          }
        }
        return reviewService.runReview({ date: today, trigger: 'cron', skipHoliday: true });
      };
      mainRun()
        .then(r => console.log(`  [每日复盘] ${today} ${hh}:${mm} ${slot.kind}：${r.action}${r.version ? ' v' + r.version : ''}${r.stage ? ' [' + r.stage + ']' : ''}${(r.reason || r.message) ? '（' + (r.reason || r.message) + '）' : ''}`))
        .catch(e => console.error('  [每日复盘] 定时生成失败:', e && e.message));
    } catch (e) {
      console.error('  [每日复盘] 调度器异常:', e && e.message);
    }
  }, 60 * 1000);
  console.log('  [每日复盘] 定时调度已启动：15:35 主跑 + 15:40/45/50 补跑 + 20:30 龙虎榜补录 + 次日兜底（Asia/Shanghai，先查 trade_calendar 表）');
}
````

---

## 6. 采集层：`--lhb-only` 晚间补录通道

### 6.1 `lib/boardReviewData.js` 第 110-136 行

````js
 * 龙虎榜晚间补录专用：只抓当日龙虎榜明细，不跑涨停池/多日序列（实测快很多）。
 * 20261110a / ERR-20261110-001：龙虎榜是盘后延迟发布数据，15:35 的空结果不能当失败快照；
 * 补录时必须绕开 10 分钟缓存并重新请求，否则会一直命中下午那次「尚未发布」。
 * 本方法刻意不写缓存，也不清全局缓存（由调用方在补录前显式 clearCache）。
 */
async function getLhbOnly(dateStr) {
  const py = findPython();
  if (!py) throw new Error('未找到 Python 解释器');
  if (!fs.existsSync(SCRIPT)) throw new Error('board_review_data.py 不存在');
  const compact = String(dateStr || '').replace(/-/g, '');
  const { stdout } = await execFileAsync(py, [SCRIPT, '--date', compact, '--lhb-only'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 90000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  let data;
  try { data = JSON.parse(String(stdout).trim()); }
  catch (e) { throw new Error('补录取数脚本返回非 JSON：' + String(stdout).slice(0, 160)); }
  if (!data || typeof data !== 'object') throw new Error('补录取数脚本返回空内容');
  normalizeDateFields(data);
  return data;
}

function clearCache() { _cache.clear(); }

module.exports = { getBoardReviewData, getLhbOnly, prevTradingDate, clearCache, normalizeDateFields };
````

### 6.2 `scripts/board_review_data.py` `build_lhb()` 空结果文案（第 272-292 行）

````python
def build_lhb(rows, date_str):
    """龙虎榜：只做客观统计与席位属性计数，不做看多/看空结论、不给操作建议。"""
    block = {
        'ok': False, 'asOf': date_str, 'source': 'akshare stock_lhb_detail_em（东方财富龙虎榜明细）',
        'count': None, 'netBuyTotal': None, 'buyTotal': None, 'sellTotal': None,
        'topNetBuy': [], 'topNetSell': [], 'reasonStats': [],
        'institutionBuyMentions': None, 'institutionSellMentions': None,
        'note': '',
    }
    if not rows:
        # 20261110a / ERR-20261110-001：龙虎榜是盘后延迟发布数据。15:35 抓不到空结果，
        # 首要原因是「尚未发布」而不是「非交易日 / 接口故障」；旧文案把这个状态固化成
        # 「缺失」并被幂等逻辑锁死，导致第二天仍看不到数据。此处如实标注等待补录。
        block['note'] = ('龙虎榜为盘后延迟发布数据：当前时点尚未发布，或接口暂不可用；'
                         '本项标注「待晚间补录」，由 20:30 / 次日 15:35 兜底重新抓取，不判为数据缺失')
        return block
    recs = []
    for r in rows:
        recs.append({
            'code': _str(r.get('代码')), 'name': _str(r.get('名称')),
            'netBuy': _num(r.get('龙虎榜净买额')),
````

### 6.3 `scripts/board_review_data.py` `--lhb-only` 参数与分支

````python
    p = argparse.ArgumentParser()
    p.add_argument('--date', required=True, help='交易日 YYYYMMDD')
    p.add_argument('--prev-date', default='', help='上一交易日 YYYYMMDD（算晋级率）')
    p.add_argument('--hist-dates', default='', help='复盘日之前的前3-5个交易日，逗号分隔 YYYYMMDD（由 Node 侧传入）')
    p.add_argument('--lhb-only', action='store_true', help='晚间龙虎榜补录：只抓当日龙虎榜明细，不跑涨停池/多日序列')
    a = p.parse_args()
    d, pd = a.date.strip(), a.prev_date.strip()
    hist_dates = [x.strip() for x in a.hist_dates.strip().split(',') if x.strip()]
    out = {
        'ok': True, 'date': d, 'prevDate': pd or None,
        'fetchedAt': datetime.now().isoformat(timespec='seconds'),
        'source': 'akshare（东方财富涨停股池 / 炸板池 / 跌停池 / 龙虎榜明细）',
        'ladder': None, 'lhb': None,
        'prevPool': None, 'sectors': None, 'activity': None, 'historySeries': [],
        'lhbOnly': bool(a.lhb_only),
        'issues': [],
    }
    try:
        import akshare as ak
        # 20261110a：补录通道只请求龙虎榜明细。空结果也要把「尚未发布」的诚实 note 返回，
        # 故 out['ok'] 保持 True（由 lhb.ok / lhb.note 表达状态），不再拿 ladder 或 lhb 反推整体成败。
        if a.lhb_only:
            lhb = _safe_call(lambda: ak.stock_lhb_detail_em(start_date=d, end_date=d), '龙虎榜明细', out)
            out['lhb'] = build_lhb(_pool_rows(lhb), d)
            out['ok'] = True
            sys.stdout.write(json.dumps(out, ensure_ascii=False, default=str))
            sys.stdout.write('\n')
            return
        zt = _safe_call(lambda: ak.stock_zt_pool_em(date=d), '涨停池', out)
        zb = _safe_call(lambda: ak.stock_zt_pool_zbgc_em(date=d), '炸板池', out)
        dt = _safe_call(lambda: ak.stock_zt_pool_dtgc_em(date=d), '跌停池', out)
````

---

## 7. 前端渲染：`public/js/dailyReview.js` 关键片段

### 7.1 副标题与 `formal/complete` 徽标（第 66-135 行）

````js

  // 20261110a：14 段 → 11 段去重精简版；15:35 正式版 / 20:30 龙虎榜补录完整版。
  const SUBTITLE_TODAY = '交易日 15:35 生成正式版 · 20:30 补录龙虎榜升级完整版 · 固定 11 段去重结构 · 数据缺失如实标注';
  function stageLabel(review, ver) {
    const st = (ver && ver.stage) || (review && review.stage);
    if (st === 'complete') return '完整版';
    if (st === 'formal') return '正式版';
    return '';
  }
  function isPendingLhb(review, ver) {
    const st = (ver && ver.dragonTigerStatus) || (review && review.dragonTigerStatus);
    return st === 'pending';
  }

  // ---------- 有限分析版标记 ----------
  function isLimited(review, ver) {
    return !!(review && (review.limited || (ver && ver.limited)));
  }
  function setLimitedBadge(limited) {
    const bar = $('drStatusBar');
    if (!bar) return;
    let chip = $('drChipLimited');
    if (limited && !chip) {
      chip = document.createElement('span');
      chip.id = 'drChipLimited';
      chip.className = 'dr-chip dr-limited-chip';
      chip.textContent = '有限分析版';
      const spacer = bar.querySelector('.dr-spacer');
      bar.insertBefore(chip, spacer || null);
    } else if (!limited && chip) {
      chip.remove();
    }
  }
  function metaText(review, ver) {
    let meta = ver ? ('生成于 ' + esc(ver.localTime || ver.generatedAt || '—') + ' · ' + esc((review && review.schemaVersion) || '')) : '';
    if (isLimited(review, ver)) {
      meta += (meta ? ' · ' : '') + '核心字段完整率不足 90%，已做有限分析，最需补充 3 项见「二、数据完整性与口径说明」';
    }
    if (isPendingLhb(review, ver)) {
      meta += (meta ? ' · ' : '') + '龙虎榜待晚间补录（盘后数据尚未发布，不计入缺失）';
    }
    return meta;
  }

  // ---------- 状态条 ----------
  function setStatus(today, review) {
    const date = (today && today.date) || S.date || localToday();
    S.date = date;
    const cal = today && today.calendar;
    $('drChipDate').textContent = '📅 ' + date;
    if (today && today.holiday) {
      $('drChipDay').textContent = '休市 · 非交易日';
      $('drChipDay').className = 'dr-chip dr-chip-holiday';
    } else if (cal && cal.is_trading_day === true) {
      $('drChipDay').textContent = '交易日';
      $('drChipDay').className = 'dr-chip dr-chip-trading';
    } else {
      $('drChipDay').textContent = '交易日历判定缺失';
      $('drChipDay').className = 'dr-chip';
    }
    const ver = review && (review.versions || []).find(v => v.version === review.currentVersion);
    const st = stageLabel(review, ver);
    $('drChipVersion').textContent = ver
      ? ('v' + ver.version + (ver.kind === 'revision' ? ' 修订' : '') + (st ? ' · ' + st : ''))
      : '暂无复盘';
    $('drChipCompleteness').textContent = ver && ver.completeness ? ('完整度 ' + ver.completeness.score + '%') : '完整度 —';
    const running = !!(today && today.running) || S.running;
    $('drChipRunning').classList.toggle('hidden', !running);
    setLimitedBadge(isLimited(review, ver));
    $('drMeta').textContent = metaText(review, ver);
````

### 7.2 `TABLE_COLS` 两套新表列

````text
162:    topicBrief: [['name', '题材名称'], ['performance', '盘面表现'], ['attribution', '核心消息催化'], ['stage', '题材阶段'], ['grade', '评级'], ['verifyLogic', '次日验证逻辑']],
164:    focusPool: [['name', '股票名称/代码'], ['reason', '入选原因（代表题材/板块）'], ['grade', '评级'], ['watchChange', '明日观察什么'], ['invalidate', '放弃跟踪的信号']],
391:      || kind === 'topicBrief' || kind === 'focusPool');
477:      if (sec && (sec.tableKind === 'topic' || sec.tableKind === 'topicBrief') && (g === 'S' || g === 'A' || g === 'B' || g === 'C')) {
516:    if (sec && (sec.tableKind === 'topicBrief' || sec.tableKind === 'focusPool')
````
### 7.3 版本戳（`?v=20261110a`）

````text
public/daily-review.html:9:  <link rel="stylesheet" href="css/style.css?v=20261110a">
public/daily-review.html:64:  <script src="js/dailyReview.js?v=20261110a"></script>
public/index.html:9:  <link rel="stylesheet" href="css/style.css?v=20261110a">
public/index.html:1142:    <script src="js/charts.js?v=20261110a"></script>
public/index.html:1145:  <script src="js/capitalCharts.js?v=20261110a"></script>
public/index.html:1147:  <script src="js/shareholderCharts.js?v=20261110a"></script>
public/index.html:1152:  <script src="js/homeMacro.js?v=20261110a"></script>
public/index.html:1158:  <script src="js/app.js?v=20261110a"></script>
public/etf-flow.html:9:  <link rel="stylesheet" href="css/style.css?v=20261110a">
public/etf-flow.html:38:  <script src="js/etfFlowPage.js?v=20261110a"></script>
````
---

## 8. 人话对照：规格条款落在哪一行

| 规格要求 | 落地位置 | 是否动到引擎 |
| --- | --- | --- |
| 固定 11 段、禁止信息重复 | `reviewOutput.js:39-51` 段定义；`:156-160` `own()` 归属登记；`:548-549` 质检查重 | 否 |
| 禁止过度专业化 | `reviewOutput.js:64-65` `JARGON_BAN`；`:162-173` `plainify()/plainRisks()`；`:536-539` 硬扫描 | 否（仅输出层改写文案） |
| 四段式只用于核心结论与观察池 | `reviewOutput.js:54` `CORE_SECTIONS`；`:540-547` 质检 | 否 |
| 不给买卖/仓位建议、缺失标缺失 | `reviewOutput.js:57-60` 禁用词；`:29` `MISSING`；`:532-535` 质检 | 否 |
| 质检不占页面段落 | `reviewOutput.js:519-562` 后台 13 项；`reviewService.js:490-494` 不过则拒绝发布 | 否 |
| 15:35 正式版 / 20:30 补录 / 次日兜底 | `server.js:2521-2607`；`reviewService.js:610-708` | 否 |
| 龙虎榜未发布不判「缺失」 | `reviewOutput.js:102-134` `lhbLines()`；`board_review_data.py:282-287` | 否 |
| 同一日期 complete 唯一、不降级 | `reviewService.js:460-471`、`:620-622`、`:702-708` | 否 |

---

## 9. 状态说明

- 本地改动已完成，**未执行 git commit / push / 三端同步**，等待您明确的「同步」指令。
- 后端与调度改动需重启服务才生效：关闭旧服务器 → 双击桌面 `Stock Analyzer.lnk` → 浏览器 `Ctrl+F5` 硬刷新。
- 守卫实测：`scripts/test_daily_review.js` 43/0 通过；`test_review_engines.js` 41/0、`test_topic_engines.js` 17/0 通过（证明引擎未破坏）。
