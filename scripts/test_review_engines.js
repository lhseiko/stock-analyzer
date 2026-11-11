/**
 * scripts/test_review_engines.js — 机会/风险识别引擎纯函数单测（20261108a）
 * ==========================================================================
 * 零 I/O、零网络、零 mock：引擎是纯函数，只喂真实结构的字面量样本。
 * 重点守卫工作台铁律：
 *  - 代码权威：同输入两次 analyze 输出逐字一致（数据不变则结论不变）。
 *  - 诚实缺失：数据缺失返回 null（未知），绝不返回 false、绝不臆造数值。
 *  - 不输出空白模板：市场级软否决只降级不整批剔除，观察池有保底与如实说明。
 */
'use strict';
const assert = require('assert');
const path = require('path');
const E = require(path.join(__dirname, '..', 'lib', 'reviewEngines'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' → ' + e.message); }
}

function fixture(over) {
  const base = {
    date: '2026-11-06',
    histDates: ['2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'],
    historySeries: [
      { date: '2026-11-03', ok: true, limitUp: 48, limitDown: 8, prevRedRate: 55, promotionRate: 30, ztAmountYi: 300 },
      { date: '2026-11-04', ok: true, limitUp: 118, limitDown: 6, prevRedRate: 62, promotionRate: 36, ztAmountYi: 480 },
      { date: '2026-11-05', ok: true, limitUp: 84, limitDown: 9, prevRedRate: 48, promotionRate: 25, ztAmountYi: 390 },
      { date: '2026-11-06', ok: true, limitUp: 32, limitDown: 15, prevRedRate: 36, promotionRate: 18, ztAmountYi: 220 },
    ],
    breadth: { up: 741, down: 4431, limitUp: 33, limitDown: 15, flat: 100 },
    ladder: {
      ok: true, limitUpCount: 32, maxBoards: 5, hasGap: true, gapAt: [4],
      spaceBoard: { name: '闽发铝业', code: '002578', boards: 5, industry: '工业金属' },
      tiers: [
        { boards: 5, count: 1, stocks: [{ code: '002578', name: '闽发铝业', industry: '工业金属' }] },
        { boards: 2, count: 3, stocks: [
          { code: '000001', name: 'A股', industry: '工业金属' },
          { code: '000002', name: 'B股', industry: '光伏设备' },
        ] },
      ],
    },
    prevPool: {
      ok: true, count: 84, redCount: 30, redRate: 35.71, avgChgPct: -0.82,
      bigDropCount: 10, bigDropRate: 11.90,
      topGainers: [{ code: '600111', name: '修复股', chgPct: 8.2, prevBoards: 3 }],
      topLosers: [
        { code: '600222', name: '断板股', chgPct: -9.8, prevBoards: 4 },
        { code: '600333', name: '断板股2', chgPct: -7.1, prevBoards: 3 },
      ],
      industryBigDrop: [{ industry: '工业金属', count: 3 }],
      promotion: [{ from: 1, to: 2, base: 63, promoted: 4, rate: 6.35 }],
    },
    sectors: {
      ok: true, total: 12,
      top: [
        { industry: '工业金属', count: 4, boardsMax: 5, amountYi: 30, hasLayer: true },
        { industry: '光伏设备', count: 2, boardsMax: 2, amountYi: 12, hasLayer: false },
      ],
      singleDance: ['银行', '保险', '煤炭', '券商', '地产', '白酒'],
    },
    activity: {
      ok: true, ztAmountYi: 220, strongCount: 151, strongAmountYi: 800,
      topAmount: [
        { code: '002578', name: '闽发铝业', amountYi: 5.39, chgPct: 10.1, industry: '工业金属', from: 'zt' },
        { code: '600444', name: '小票', amountYi: 0.3, chgPct: 10, industry: '其他', from: 'strong' },
      ],
    },
    news: [],
  };
  return Object.assign(base, over || {});
}

console.log('\n[1] 常量与定义完整性');
t('O1-O5 分类齐全', () => {
  ['O1', 'O2', 'O3', 'O4', 'O5'].forEach(k => assert.ok(E.OPPORTUNITY_CATEGORIES[k]));
});
t('C1-C8 / V1-V8 清单齐全', () => {
  assert.strictEqual(E.CONFIRM_DEFS.length, 8);
  assert.strictEqual(E.VETO_DEFS.length, 8);
  assert.deepStrictEqual(E.CONFIRM_DEFS.map(x => x.code), ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8']);
  assert.deepStrictEqual(E.VETO_DEFS.map(x => x.code), ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8']);
  assert.ok(E.CONFIRM_DEFS.find(x => x.code === 'C7').label.includes('量价结构健康'));
  assert.ok(E.CONFIRM_DEFS.find(x => x.code === 'C8').label.includes('催化/发酵期'));
  assert.ok(E.VETO_DEFS.find(x => x.code === 'V7').label.includes('顶背离'));
  assert.ok(E.VETO_DEFS.find(x => x.code === 'V8').label.includes('龙头独舞'));
  assert.strictEqual(E.DRIVER_DEFS.D1, '技术');
  assert.strictEqual(E.DRIVER_DEFS.D4, '基本面');
});
t('R-M 4 条 / R-S 5 条 / R-I 5 条', () => {
  assert.strictEqual(E.RISK_DEFS.market.length, 4);
  assert.strictEqual(E.RISK_DEFS.sector.length, 5);
  assert.strictEqual(E.RISK_DEFS.individual.length, 5);
});
t('阈值集中定义且口径可披露', () => {
  assert.strictEqual(E.TH.bigDropPct, -5);
  assert.strictEqual(E.TH.trendMinPoints, 3);
  assert.strictEqual(E.TH.liquidityMinYi, 1.0);
  assert.ok(E.NO_COMPARISON.includes('缺少对照'));
});

console.log('\n[2] trendOf：持续性判断必须有 >=3 个对照点');
t('对照点不足 → 无法判断 + 缺少对照说明', () => {
  const r = E.trendOf([{ limitUp: 10 }, { limitUp: 20 }], 'limitUp');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.direction, '无法判断');
  assert.ok(r.note.includes(E.NO_COMPARISON));
});
t('全部缺失 → 无法判断，不臆造数值', () => {
  const r = E.trendOf([{}, {}, {}, {}], 'limitUp');
  assert.strictEqual(r.points, 0);
  assert.strictEqual(r.direction, '无法判断');
});
t('上升序列 → 扩散', () => {
  const r = E.trendOf([10, 20, 30, 40].map(v => ({ limitUp: v })), 'limitUp');
  assert.strictEqual(r.direction, '扩散');
  assert.strictEqual(r.points, 4);
});
t('下降序列 → 收缩', () => {
  const r = E.trendOf([100, 80, 60, 40].map(v => ({ limitUp: v })), 'limitUp');
  assert.strictEqual(r.direction, '收缩');
});
t('平稳序列 → 持平', () => {
  const r = E.trendOf([50, 50, 50, 50].map(v => ({ limitUp: v })), 'limitUp');
  assert.strictEqual(r.direction, '持平');
});
t('含 null 值只按有效点计算', () => {
  const r = E.trendOf([{ limitUp: 10 }, { limitUp: null }, { limitUp: 20 }, { limitUp: 30 }, {}], 'limitUp');
  assert.strictEqual(r.points, 3);
  assert.strictEqual(r.direction, '扩散');
});

console.log('\n[3] 四段式与机会分类');
t('quad 五字段齐全且原样保留', () => {
  const q = E.quad('对象', '事实', '判断', '验证', '不成立');
  assert.deepStrictEqual(Object.keys(q).sort(), ['fact', 'invalidate', 'judgment', 'subject', 'verify'].sort());
  assert.strictEqual(q.invalidate, '不成立');
});
t('无证据无新闻 → 混合型 / 主导数据不足，不硬猜', () => {
  const ctx = E.normInput({});
  const c = E.classifyOpportunity({ name: '某股' }, ctx);
  assert.strictEqual(c.code, 'MIX');
  assert.strictEqual(c.leading, '数据不足');
});
t('仅客观行情证据 → O4 资金/情绪驱动', () => {
  const ctx = E.normInput({});
  const c = E.classifyOpportunity({ name: '某股', boards: 2 }, ctx);
  assert.strictEqual(c.code, 'O4');
});
t('新闻命中事件关键词 → 混合型主导 O3，且线索带来源时间', () => {
  const ctx = E.normInput({ news: [{ title: '某股发布回购公告', source: '东财', date: '2026-11-06 14:00' }] });
  const c = E.classifyOpportunity({ name: '某股', boards: 2 }, ctx);
  assert.strictEqual(c.code, 'MIX');
  assert.strictEqual(c.leading, 'O3');
  assert.strictEqual(c.clues[0].date, '2026-11-06 14:00');
});
t('无行情证据但有催化线索 → 归该催化类', () => {
  const ctx = E.normInput({ news: [{ title: '某股中标大单', source: '东财', date: '2026-11-06' }] });
  const c = E.classifyOpportunity({ name: '某股' }, ctx);
  assert.strictEqual(c.code, 'O3');
});

console.log('\n[4] 漏斗 / 确认 / 否决：诚实缺失必须是 null 而非 false');
t('数据全缺时 L1/L2/L3/L4/L5 均为 null', () => {
  const ctx = E.normInput({});
  const f = E.funnelOf({ name: '某股' }, ctx);
  Object.values(f.layers).forEach(l => assert.strictEqual(l.passed, null, JSON.stringify(l)));
  assert.strictEqual(f.passedAll, false);
  assert.strictEqual(f.explicitFail, false);
});
t('C3 恒为 null：个股多日成交额序列无本机源，不以全市场代理冒充', () => {
  const ctx = E.normInput(fixture());
  const c = E.confirmOf({ name: '某股', boards: 2, layer: true, catalyst: '客观数据' }, ctx);
  assert.strictEqual(c.items.C3.hit, null);
  assert.ok(c.items.C3.reason.includes('不以全市场代理冒充'));
});
t('漏斗数据齐全时 L1 由确定性阈值判定', () => {
  const ctx = E.normInput(fixture());
  const f = E.funnelOf({ name: '某股', boards: 2, layer: true, catalyst: '客观数据' }, ctx);
  assert.strictEqual(f.layers.L1.passed, false, '涨 741 < 跌 4431 应判不通过');
  assert.strictEqual(f.layers.L2.passed, true);
  assert.strictEqual(f.layers.L3.passed, true);
});
t('V6 小成交额 → 个股级硬否决', () => {
  const ctx = E.normInput(fixture());
  const v = E.vetoOf({ name: '小票', amountYi: 0.3, boards: 2 }, ctx);
  assert.ok(v.hardHits.some(h => h.code === 'V6'));
  assert.strictEqual(v.hasHardVeto, true);
});
t('V1 单票独舞 → 个股级硬否决', () => {
  const ctx = E.normInput(fixture());
  const v = E.vetoOf({ name: '某股', industry: '银行', amountYi: 5, boards: 1 }, ctx);
  assert.ok(v.hardHits.some(h => h.code === 'V1'));
});
t('V3 高位负反馈扩散 → 市场级软否决', () => {
  const ctx = E.normInput(fixture());
  const v = E.vetoOf({ name: '某股', amountYi: 5, boards: 2 }, ctx);
  assert.ok(v.softHits.some(h => h.code === 'V3'), JSON.stringify(v));
  assert.strictEqual(v.hasHardVeto, false);
});
t('V2/V4 无序列 → 记入 unknown 而非命中', () => {
  const ctx = E.normInput(fixture());
  const v = E.vetoOf({ name: '某股', amountYi: 5, boards: 2 }, ctx);
  assert.ok(v.unknown.some(x => x.startsWith('V2')));
  assert.ok(v.unknown.some(x => x.startsWith('V4')));
  assert.ok(!v.hits.some(h => h.code === 'V2' || h.code === 'V4'));
});

console.log('\n[5] 评级 A/B/C/D 与市场级风险降级');
t('硬否决 → D 剔除，trackable=false', () => {
  const ctx = Object.assign(E.normInput(fixture()), { marketRiskLevel: '低' });
  const g = E.gradeOf({ name: '小票', code: '600444', amountYi: 0.3, boards: 2, layer: true, catalyst: '客观' }, ctx);
  assert.strictEqual(g.grade, 'D');
  assert.strictEqual(g.trackable, false);
});
t('软否决 → 只能 C 仅观察，永不评 A/B', () => {
  const ctx = Object.assign(E.normInput(fixture()), { marketRiskLevel: '低' });
  const g = E.gradeOf({ name: 'A股', code: '000001', amountYi: 5, boards: 2, layer: true, catalyst: '客观' }, ctx);
  assert.strictEqual(g.grade, 'C');
  assert.strictEqual(g.trackable, false);
  assert.ok(g.gradeReason.includes('不得进入可跟踪'));
});
t('漏斗明确未通过 → C，且理由写明哪一层', () => {
  const clean = Object.assign(E.normInput(fixture({
    prevPool: Object.assign({}, fixture().prevPool, { topLosers: [] }),
  })), { marketRiskLevel: '低' });
  const g = E.gradeOf({ name: '某股', code: '1', amountYi: 5, boards: 1, layer: false, catalyst: '客观' }, clean);
  assert.strictEqual(g.grade, 'C');
  assert.ok(/L\d/.test(g.gradeReason), g.gradeReason);
});
t('市场级风险偏高时按规则降一级', () => {
  const clean = fixture({
    prevPool: Object.assign({}, fixture().prevPool, { topLosers: [], bigDropRate: 5 }),
    breadth: { up: 3500, down: 1200, limitUp: 80, limitDown: 5, flat: 100 },
    ladder: Object.assign({}, fixture().ladder, { hasGap: false, gapAt: [] }),
  });
  const base = { name: '某股', code: '1', amountYi: 5, boards: 2, layer: true, catalyst: '客观数据' };
  const lo = E.gradeOf(base, Object.assign(E.normInput(clean), { marketRiskLevel: '低' }));
  const hi = E.gradeOf(base, Object.assign(E.normInput(clean), { marketRiskLevel: '高' }));
  const rank = { A: 0, B: 1, C: 2, D: 3 };
  assert.ok(rank[hi.grade] >= rank[lo.grade], `${lo.grade} → ${hi.grade} 应降级或持平`);
});

console.log('\n[5b] 20261111 板块地位评级覆盖：退潮期也按板块地位给评级，绝不空白');
t('板块地位保底：最高标无否决且确认不足 → 保底 B（试错），绝不空白', () => {
  const f = fixture({
    breadth: { up: 3000, down: 1500, limitUp: 80, limitDown: 5, flat: 100 },
    ladder: { ok: true, limitUpCount: 80, maxBoards: 3, hasGap: true, gapAt: [2],
      spaceBoard: { name: '空间板', code: '000001', boards: 3, industry: '半导体' },
      tiers: [
        { boards: 3, count: 1, stocks: [{ code: '000001', name: '空间板', industry: '半导体' }] },
        { boards: 2, count: 1, stocks: [{ code: '000002', name: '跟风', industry: '半导体' }] },
      ] },
    prevPool: { ok: true, count: 84, redRate: 60, bigDropRate: 40, bigDropCount: 8,
      topLosers: [], topGainers: [], industryBigDrop: [], promotion: [{ from: 1, to: 2, rate: 30 }] },
    sectors: { ok: true, total: 1, top: [{ industry: '半导体', count: 3, boardsMax: 3, amountYi: 30, hasLayer: true }], singleDance: [] },
    activity: { ok: true, ztAmountYi: 300, strongCount: 100, strongAmountYi: 500,
      topAmount: [
        { code: '000001', name: '空间板', amountYi: 5, chgPct: 10, industry: '半导体', from: 'zt' },
        { code: '000002', name: '跟风', amountYi: 5, chgPct: 10, industry: '半导体', from: 'zt' },
      ] },
    news: [],
    historySeries: [
      { date: 'd1', limitUp: 80, limitDown: 5, prevRedRate: 60, promotionRate: 30, ztAmountYi: 300 },
      { date: 'd2', limitUp: 80, limitDown: 5, prevRedRate: 60, promotionRate: 30, ztAmountYi: 300 },
      { date: 'd3', limitUp: 80, limitDown: 5, prevRedRate: 60, promotionRate: 30, ztAmountYi: 300 },
      { date: 'd4', limitUp: 80, limitDown: 5, prevRedRate: 60, promotionRate: 30, ztAmountYi: 300 },
    ],
  });
  const o = E.analyze(f);
  const top = o.candidates.find(c => c.code === '000001');
  const follower = o.candidates.find(c => c.code === '000002');
  assert.ok(top, '空间板候选应存在');
  assert.strictEqual(top.sectorPosition, '最高标', '3 板为板块最高 → 最高标');
  assert.strictEqual(top.grade, 'B', '最高标无否决、确认不足 → 保底 B（试错）');
  assert.strictEqual(top.trialGrade, true, '保底 B 应标记试错级');
  assert.strictEqual(top.gradeLabel, 'B（试错）', '语义标注应为 B（试错）');
  assert.ok(follower.sectorPosition === '梯队中位' || follower.sectorPosition === '跟风/独立', '2 板非最高 → 梯队中位/跟风');
  assert.strictEqual(follower.grade, 'C', '跟风确认不足 → C（观察）');
  assert.strictEqual(follower.gradeLabel, 'C（观察）');
  // 所有候选评级必须非空白（含板块级）
  o.candidates.forEach(c => assert.ok(c.gradeLabel && c.gradeLabel !== '—', c.name + ' 评级不得空白'));
});
t('板块地位保底不破坏铁律：硬/软否决与漏斗明确未通过仍 → C/D', () => {
  // 复用 fixture：软否决（V3 高位负反馈扩散）候选不得因板块地位升 B
  const o = E.analyze(fixture());
  o.candidates.forEach(c => {
    if (c.veto.hasHardVeto) assert.strictEqual(c.grade, 'D', c.name + ' 硬否决必须 D');
    else if ((c.veto.softHits || []).length) assert.strictEqual(c.grade, 'C', c.name + ' 软否决必须 C 永不 A/B');
    else if (c.funnel && c.funnel.explicitFail) assert.strictEqual(c.grade, 'C', c.name + ' 漏斗未通过必须 C');
  });
});

console.log('\n[6] 风险引擎与 analyze 主入口');
t('assessRisks 输出 4/5/5 条，每条字段齐全', () => {
  const r = E.assessRisks(E.normInput(fixture()));
  assert.strictEqual(r.market.length, 4);
  assert.strictEqual(r.sector.length, 5);
  assert.strictEqual(r.individual.length, 5);
  [].concat(r.market, r.sector, r.individual).forEach(x => {
    ['code', 'title', 'level', 'fact', 'observe', 'clear'].forEach(k => assert.ok(x[k], x.code + '.' + k));
    assert.ok(['高', '中', '低', '无法判断'].includes(x.level), x.code + ' level=' + x.level);
  });
});
t('无源风险项诚实标「无法判断」，不编造等级', () => {
  const r = E.assessRisks(E.normInput({}));
  const rs4 = r.sector.find(x => x.code === 'R-S4');
  const ri1 = r.individual.find(x => x.code === 'R-I1');
  const ri5 = r.individual.find(x => x.code === 'R-I5');
  [rs4, ri1, ri5].forEach(x => {
    assert.strictEqual(x.level, '无法判断');
    assert.ok(x.fact.includes('缺失'));
  });
});
t('空输入不崩：14 条风险、表空、观察池有如实说明', () => {
  const o = E.analyze({});
  assert.strictEqual(o.risks.market.length + o.risks.sector.length + o.risks.individual.length, 14);
  assert.strictEqual(o.opportunityTable.length, 0);
  assert.strictEqual(o.watchPool.length, 0);
  assert.ok(o.watchPoolNote.includes('无可用候选数据'));
  assert.strictEqual(o.keyMissingTop3.length, 3);
});
t('真实结构样例：汇总表/观察池非空，D 级不进表', () => {
  const o = E.analyze(fixture());
  assert.ok(o.opportunityTable.length > 0);
  assert.ok(o.watchPool.length >= 3 && o.watchPool.length <= 8);
  assert.ok(o.opportunityTable.every(r => r.grade !== 'D'));
  assert.ok(o.opportunityTable.every(r => r.capitalContinuity === '缺失'));
  assert.ok(o.candidates.some(c => c.grade === 'D'), '样例应有硬否决被剔除的标的');
});
t('所有 A/B 级候选确认项 >=4（试错级 B 除外，允许确认不足）', () => {
  const o = E.analyze(fixture());
  o.candidates.filter(c => c.trackable && !c.trialGrade).forEach(c =>
    assert.ok(c.confirm.count >= 4, c.name + ' 确认项 ' + c.confirm.count));
});
t('观察池不足 3 个时用板块级补足并标注「板块」', () => {
  const sec4 = fixture().sectors.top.concat([
    { industry: '电力', count: 2, boardsMax: 2, amountYi: 10, hasLayer: true },
    { industry: '种植业', count: 2, boardsMax: 1, amountYi: 8, hasLayer: true },
  ]);
  const only = fixture({
    ladder: { ok: true, tiers: [], maxBoards: null, hasGap: null },
    prevPool: Object.assign({}, fixture().prevPool, { topGainers: [] }),
    activity: Object.assign({}, fixture().activity, { topAmount: [] }),
    sectors: Object.assign({}, fixture().sectors, { top: sec4 }),
  });
  const o = E.analyze(only);
  assert.ok(o.watchPool.length >= 3, '应有保底补足');
  assert.ok(o.watchPool.some(x => x.name.includes('（板块）')));
  assert.ok(o.watchPoolNote.includes('板块级候选补足'));
});
t('候选总量仍不足 3 时如实说明，绝不硬凑标的', () => {
  const only2 = fixture({
    ladder: { ok: true, tiers: [], maxBoards: null, hasGap: null },
    prevPool: Object.assign({}, fixture().prevPool, { topGainers: [] }),
    activity: Object.assign({}, fixture().activity, { topAmount: [] }),
  });
  const o = E.analyze(only2);
  assert.strictEqual(o.watchPool.length, 2);
  assert.ok(o.watchPoolNote.includes('不补足到 3 个'));
});
t('同输入两次 analyze 输出逐字一致（代码权威：数据不变结论不变）', () => {
  const a = JSON.stringify(E.analyze(fixture()));
  const b = JSON.stringify(E.analyze(fixture()));
  assert.strictEqual(a, b);
});
t('caliberNotes 披露大面股/流动性/成交额样本/否决分级口径', () => {
  const o = E.analyze(fixture());
  const all = o.caliberNotes.join('\n');
  ['大面股 = ', '流动性不足阈值', '成交额样本仅覆盖', '否决项分级', '连续加速代理'].forEach(k =>
    assert.ok(all.includes(k), '缺口径 ' + k));
});
t('趋势结论与序列方向一致，且不作单日断言', () => {
  const o = E.analyze(fixture());
  assert.strictEqual(o.trends.limitUp.direction, '收缩');
  assert.strictEqual(o.trends.limitUp.ok, true);
  assert.ok(o.trends.limitUp.points >= 3);
});

console.log('\n[7] 20261108d 新增：C7/C8、V7/V8、四象限中和、驱动标签');
function topicsFixture(over) {
  return Object.assign({
    schemaVersion: 'topic-20261108d',
    topicByIndustry: {
      '工业金属': {
        stage: '发酵/主升期', stageReason: '最近 3 个对照日递增', newsLevel: '国家级/官方',
        quadrant: '共振', quadrantAction: '可给 S/A 级', voteQuality: '强共识投票',
        drivers: 'D1/D2/D3', verifyLogic: '次日核对涨停家数', limitUpCount: 6,
        hasLayer: true, midCapChangePct: 10.1, evidenceComplete: true,
      },
      '光伏设备': {
        stage: '高潮/退潮期', stageReason: '霸榜多日回落', newsLevel: '行业级/财经媒体',
        quadrant: '双弱', quadrantAction: '剔除', voteQuality: '无效/陷阱投票',
        drivers: 'D1', verifyLogic: '次日核对断板股', limitUpCount: 1,
        hasLayer: false, midCapChangePct: -2, evidenceComplete: true,
      },
    },
  }, over || {});
}
function cleanCtx(topics) {
  const ctx = E.normInput(Object.assign(fixture(), {
    breadth: { up: 3100, down: 1800, limitUp: 62, limitDown: 9, flat: 200 },
    ladder: { ok: true, maxBoards: 3, hasGap: false, gapAt: [], tiers: [] },
    prevPool: {
      ok: true, count: 84, redRate: 60, bigDropRate: 5, bigDropCount: 2,
      topLosers: [], topGainers: [], industryBigDrop: [], promotion: [{ from: 1, to: 2, rate: 30 }],
    },
    sectors: {
      ok: true, total: 2,
      top: [{ industry: '工业金属', count: 6, boardsMax: 3, amountYi: 30, hasLayer: true }],
      singleDance: [],
    },
    activity: { ok: true, ztAmountYi: 300, topAmount: [{ code: '000001', name: '测试股', amountYi: 10, industry: '工业金属' }] },
    historySeries: [
      { date: 'd1', ztAmountYi: 100, limitUp: 40, limitDown: 5, prevRedRate: 50, promotionRate: 20 },
      { date: 'd2', ztAmountYi: 200, limitUp: 50, limitDown: 4, prevRedRate: 55, promotionRate: 25 },
      { date: 'd3', ztAmountYi: 300, limitUp: 60, limitDown: 3, prevRedRate: 60, promotionRate: 30 },
    ],
    news: [], topics,
  }));
  ctx.marketRiskLevel = '低';
  return ctx;
}
const CAND = {
  name: '测试股', code: '000001', scope: 'stock', industry: '工业金属', matchText: '测试股',
  boards: 3, layer: true, amountYi: 10, catalyst: '连板 3 板（涨停池客观数据）', sourceTag: '测试',
};
t('C7 恒「缺失」（无个股多日量价）；C8 由多日行业序列真实给出', () => {
  const o = E.analyze(fixture({ topics: topicsFixture() }));
  const a = o.candidates.find(c => c.industry === '工业金属');
  const b = o.candidates.find(c => c.industry === '光伏设备');
  assert.ok(a && b, '两个行业的候选都应存在');
  assert.strictEqual(a.confirm.items.C7.hit, null, 'C7 无本机源，必须未知');
  assert.strictEqual(a.confirm.items.C8.hit, true, '发酵期 → C8 命中');
  assert.strictEqual(b.confirm.items.C8.hit, false, '退潮期 → C8 明确未通过');
});
t('V7 恒未知；V8 消息兑现+龙头独舞命中且归软否决', () => {
  const o = E.analyze(fixture({ topics: topicsFixture() }));
  const b = o.candidates.find(c => c.industry === '光伏设备');
  assert.ok(b.veto.unknown.some(u => u.startsWith('V7')), 'V7 三项需个股多日量价，必须诚实标未知');
  assert.ok(b.veto.hits.some(h => h.code === 'V8'), '退潮期 + 涨停仅 1 家应命中 V8');
  assert.ok(E.SOFT_VETO.has('V8') && E.SOFT_VETO.has('V7'));
  assert.ok(E.HARD_VETO.has('V1') && E.HARD_VETO.has('V6'));
});
t('四象限中和：共振 A / 背离 C / 先觉 B / 双弱 D', () => {
  const q = ['共振', '背离', '先觉', '双弱'];
  const expect = { '共振': 'A', '背离': 'C', '先觉': 'B', '双弱': 'D' };
  q.forEach(quadrant => {
    const tp = topicsFixture();
    tp.topicByIndustry['工业金属'].quadrant = quadrant;
    const g = E.gradeOf(CAND, cleanCtx(tp));
    assert.strictEqual(g.grade, expect[quadrant], quadrant + ' 实际=' + g.grade + ' 理由=' + g.gradeReason);
  });
});
t('驱动标签由客观证据给出，D4 基本面恒不标注', () => {
  const g = E.gradeOf(CAND, cleanCtx(topicsFixture()));
  assert.ok(g.drivers.includes('D1'), '连板/层次 → D1');
  assert.ok(g.drivers.includes('D2'), '消息线索 → D2');
  assert.ok(g.drivers.includes('D3'), '成交额 → D3');
  assert.ok(!g.drivers.includes('D4'), 'D4 无财报/估值源，恒不标');
  assert.strictEqual(g.quadrant, '共振');
  assert.strictEqual(E.analyze(fixture()).schemaVersion, 'engine-20261108d');
});
t('caliberNotes 披露 C7/C8、V7/V8、D1-D4、四象限与中军代理口径', () => {
  const all = E.analyze(fixture()).caliberNotes.join('\n');
  ['C7', 'C8', 'V7', 'V8', 'D1 技术', '四象限中和', '中军表现以涨停池内'].forEach(k =>
    assert.ok(all.includes(k), '缺口径 ' + k));
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
