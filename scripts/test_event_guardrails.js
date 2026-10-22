// 单元测试：事件驱动引擎 · 20261021j 四道防线守卫（A1 摘要错配 / A2 例行重申封顶 / A3 理由自洽 / A4 事后市场反应核验）
// 运行：node scripts/test_event_guardrails.js
const assert = require('assert');
const {
  classifyByRule, scoreToGrade, evaluateMarketReaction, buildMarketCheckPatch, downgradeGradeOnce, MARKET_REACT_NO_MOVE_PCT,
} = require('../lib/eventEngine');
const { summaryMatchesTitle, analyzeNewsImpact } = require('../lib/newsSectorImpact');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// ============================================================
// A1 — 摘要/标题错配守卫（summaryMatchesTitle + analyzeNewsImpact）
// ============================================================
console.log('A1 摘要/标题错配守卫：');

const titleSame = '证监会再度强调将支持证券业并购重组和后续整合';
const summarySame = '监管层再度强调，将继续支持证券行业并购重组与后续整合工作。';
const titleDiff = '深交所首批9只主动ETF正式获中国证监会批复';
const summaryMismatch = 'xxx 调研费用转移支付属行业合规强化措施，影响券商基金商业模式……'; // 与标题主题无关

check('同主题摘要判为匹配', summaryMatchesTitle(titleSame, summarySame) === true);
check('异主题摘要判为错配', summaryMatchesTitle(titleDiff, summaryMismatch) === false);
check('空摘要永远匹配（谈不上错配）', summaryMatchesTitle(titleDiff, '') === true);
check('超短标题（<6字）跳过校验→匹配', summaryMatchesTitle('苹果涨', summaryMismatch) === true);

{
  const r = analyzeNewsImpact(titleDiff, summaryMismatch);
  // 即便能命中板块，note 必须标注「摘要与标题疑似错配，已弃用摘要只按标题判」
  const dropped = r && /摘要与标题疑似错配/.test(r.note);
  check('analyzeNewsImpact 错配摘要被弃用并标注', dropped);
}

// ============================================================
// A2 — 例行重申封顶（classifyByRule / RE_ROUTINE_REAFFIRM）
// ============================================================
console.log('A2 例行重申封顶：');

check('「再度强调」→ routine_reaffirm / 封顶 minor', (() => {
  const r = classifyByRule('证监会再度强调将支持证券业并购重组和后续整合');
  return r.kind === 'routine_reaffirm' && r.reject === false && r.ceiling === 'minor';
})());
check('「重申」→ routine_reaffirm', classifyByRule('央行重申稳健货币政策立场').kind === 'routine_reaffirm');
check('「例行发布」→ routine_reaffirm', classifyByRule('统计局例行发布月度经济数据').kind === 'routine_reaffirm');
check('普通事件文本不误判为重申', classifyByRule('某券商拟启动并购重组').kind === 'candidate');
check('降准等货币政策走 routine_monetary 上限 moderate', classifyByRule('央行宣布下调存款准备金率0.5个百分点').ceiling === 'moderate');
check('逆回购属日常流动性操作 → 拒收（无 ceiling）', classifyByRule('央行开展逆回购操作').reject === true);

// ============================================================
// A3 — 理由自洽守卫（scoreToGrade / RE_SELF_CONTRADICT）
// ============================================================
console.log('A3 理由自洽守卫：');

const cfg = { severity: { minConfidence: 0.6, gradeThresholds: { major: 11, moderate: 7, minor: 3 }, typeCeiling: {} } };
// 总分=11（本应 major），但理由写「市场已有预期、强度有限」→ 自相矛盾，应压到 minor
{
  const v = { scope: 3, persistence: 2, intensity: 2, surprise: 2, authority: 2, confidence: 0.9, reason: '属渐进式改革、市场已有预期，强度有限' };
  const r = scoreToGrade(v, 'industry_supply', cfg, null);
  check('高总分+自相矛盾理由 → 压到 minor', r.grade === 'minor' && r.selfContradict === true && r.capped === true);
}
// 总分=11，理由未见自相矛盾词 → 保持 major
{
  const v = { scope: 3, persistence: 2, intensity: 2, surprise: 2, authority: 2, confidence: 0.9, reason: '实质性重大制度利好，行业级影响' };
  const r = scoreToGrade(v, 'industry_supply', cfg, null);
  check('高总分+自洽理由 → 保持 major', r.grade === 'major' && r.selfContradict === false);
}
// 已是 minor 的，即便理由含自相矛盾词也不应再降（order.indexOf(minor) 不 > order.indexOf(minor)）
{
  const v = { scope: 1, persistence: 1, intensity: 1, surprise: 0, authority: 0, confidence: 0.9, reason: '影响有限' }; // total=3 → minor
  const r = scoreToGrade(v, 'macro_policy', cfg, null);
  check('本就 minor 不因理由再降档', r.grade === 'minor' && r.selfContradict === false);
}
// 类型硬上限已封到 moderate，且理由自相矛盾 → 仍锁在 minor（两层互不替代）
{
  const v = { scope: 3, persistence: 2, intensity: 2, surprise: 2, authority: 2, confidence: 0.9, reason: '意外度低' };
  const r = scoreToGrade(v, 'macro_policy', cfg, 'moderate');
  check('类型上限 moderate + 自相矛盾 → minor', r.grade === 'minor' && r.selfContradict === true);
}

// ============================================================
// A4 — 事后市场反应核验（downgradeGradeOnce / evaluateMarketReaction / buildMarketCheckPatch）
// ============================================================
console.log('A4 事后市场反应核验：');

check('downgradeGradeOnce(major)=moderate', downgradeGradeOnce('major') === 'moderate');
check('downgradeGradeOnce(moderate)=minor', downgradeGradeOnce('moderate') === 'minor');
check('downgradeGradeOnce(minor)=minor（封底）', downgradeGradeOnce('minor') === 'minor');

// 构造历史：anchor=2026-10-19；prior 5 根、post 5 根
function mkHistory(postCloses, anchorPostClose) {
  const prior = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']
    .map(d => ({ date: d, close: 100 }));
  const posts = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'];
  const closes = postCloses || [100, 100.2, 100.2, 100.2, 100.2]; // 默认几乎无反应
  const post = posts.map((d, i) => ({ date: d, close: i === 0 ? (anchorPostClose || 100) : closes[i] }));
  return prior.concat(post);
}
const evBase = (signal, extra) => Object.assign({ id: 'evt_g', title: '测试事件', signal, grade: 'moderate', createdAt: new Date('2026-10-19T09:30:00').toISOString() }, extra || {});

// evaluateMarketReaction 守卫
check('hist<4 → null', evaluateMarketReaction(evBase(1), [{ date: '2026-10-19', close: 100 }], 1) === null);
check('无 createdAt → null', evaluateMarketReaction({ id: 'e', signal: 1 }, mkHistory(), 1) === null);
check('post 不足 stage1(2根) → null', evaluateMarketReaction(evBase(1), mkHistory([100, 100, 100, 100, 100]).slice(0, 6), 1) === null);
check('post 不足 stage2(5根) → null', evaluateMarketReaction(evBase(1), mkHistory([100, 100.2, 100.2, 100.2, 100.2]).slice(0, 8), 2) === null);
check('无 prior → null', evaluateMarketReaction(evBase(1), mkHistory().filter(h => h.date >= '2026-10-19'), 1) === null);

// 反应方向判定
{
  const r = evaluateMarketReaction(evBase(1), mkHistory([100, 100.2, 100.2, 100.2, 100.2]), 1); // +0.2%
  check('stage1 几乎无反应 → no_reaction', r && r.verdict === 'no_reaction');
}
{
  const r = evaluateMarketReaction(evBase(1), mkHistory([100, 103, 103, 103, 103]), 1); // +3% 同向
  check('stage1 同向 ≥1% → confirm', r && r.verdict === 'confirm');
}
{
  const r = evaluateMarketReaction(evBase(1), mkHistory([100, 97, 97, 97, 97]), 1); // -3% 反向
  check('stage1 反向 → opposite', r && r.verdict === 'opposite');
}
{
  const r = evaluateMarketReaction(evBase(1), mkHistory([100, 100.2, 100.2, 100.2, 100.2], 100), 2); // 5根后 +0.2%
  check('stage2 仍无反应 → no_reaction', r && r.verdict === 'no_reaction' && r.barsUsed === 5);
}

// buildMarketCheckPatch
check('signal:0 → null（中性化事件不重复核）', buildMarketCheckPatch(evBase(0), 'X', mkHistory()) === null);
check('isSynthetic → null', buildMarketCheckPatch(evBase(1, { isSynthetic: true }), 'X', mkHistory()) === null);
check('已中性化 → null', buildMarketCheckPatch(evBase(1, { marketNeutralized: true }), 'X', mkHistory()) === null);
check('已确认 → null', buildMarketCheckPatch(evBase(1, { marketConfirmed: true }), 'X', mkHistory()) === null);

// 24h 节流：prev.at 在 24h 内 → null
check('24h 内已核 → 节流 null', buildMarketCheckPatch(evBase(1, { marketChecks: { X: { stage: 1, at: Date.now() } } }), 'X', mkHistory()) === null);

// stage1 无反应 → 降一级（major→moderate 或 moderate→minor），signal 不变
{
  const p = buildMarketCheckPatch(evBase(1, { grade: 'major' }), 'X', mkHistory([100, 100.2, 100.2, 100.2, 100.2]));
  check('stage1 无反应 → 降一级且 signal 不变', p && p.patch.grade === 'moderate' && p.patch.signal === undefined && p.patch.marketDowngraded === true);
}
// stage2 无反应 → 中性化（signal=0, marketNeutralized）
{
  const p = buildMarketCheckPatch(evBase(1, { grade: 'moderate', marketChecks: { X: { stage: 1, at: 0 } } }), 'X', mkHistory([100, 100.2, 100.2, 100.2, 100.2]));
  check('stage2 无反应 → 中性化 signal=0', p && p.patch.signal === 0 && p.patch.marketNeutralized === true);
}
// confirm → marketConfirmed 终态
{
  const p = buildMarketCheckPatch(evBase(1), 'X', mkHistory([100, 103, 103, 103, 103]));
  check('confirm → marketConfirmed 终态', p && p.patch.marketConfirmed === true && p.patch.signal === undefined);
}
// opposite → 立即中性化
{
  const p = buildMarketCheckPatch(evBase(1), 'X', mkHistory([100, 97, 97, 97, 97]));
  check('opposite → 立即中性化 signal=0', p && p.patch.signal === 0 && p.patch.marketNeutralized === true);
}

// ============================================================
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
