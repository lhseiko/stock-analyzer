/**
 * scripts/test_topic_engines.js — 热点归因 / 资金投票 / 四象限引擎纯函数单测（20261108d）
 * ==========================================================================
 * 零 I/O、零网络、零 mock。重点守卫：
 *  - 代码权威：同输入两次 analyzeTopics 输出逐字一致。
 *  - 诚实缺失：消息级别为推断且未经公告核验；中军只是涨停池内大市值代理；
 *    对照点不足写「缺少对照，暂不作持续性判断」；S 级证据不齐自动降 A。
 *  - 不输出空白模板：无匹配新闻 = 消息面证据缺失，四象限判「无法判断」而非「双弱」，
 *    绝不把整批题材一键剔除。
 */
'use strict';
const assert = require('assert');
const path = require('path');
const T = require(path.join(__dirname, '..', 'lib', 'topicEngines'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' → ' + e.message); }
}

function fixture(over) {
  const base = {
    date: '2026-11-06',
    histDates: ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05'],
    sectors: {
      ok: true, total: 3,
      top: [
        { industry: '半导体', count: 6, boardsMax: 4, amountYi: 120, hasLayer: true },
        { industry: '光伏设备', count: 2, boardsMax: 2, amountYi: 30, hasLayer: false },
        { industry: '贵金属', count: 1, boardsMax: 1, amountYi: 8, hasLayer: false },
      ],
      singleDance: ['贵金属'],
      industryHistory: [
        { date: '2026-11-02', ok: true, counts: { '半导体': 0, '光伏设备': 0, '贵金属': 1 } },
        { date: '2026-11-03', ok: true, counts: { '半导体': 0, '光伏设备': 0, '贵金属': 2 } },
        { date: '2026-11-04', ok: true, counts: { '半导体': 1, '光伏设备': 0, '贵金属': 3 } },
        { date: '2026-11-05', ok: true, counts: { '半导体': 3, '光伏设备': 0, '贵金属': 4 } },
        { date: '2026-11-06', ok: true, counts: { '半导体': 6, '光伏设备': 2, '贵金属': 1 } },
      ],
      sealTime: {
        ok: true, total: 9, early: 5, mid: 3, late: 1, unknown: 0,
        byIndustry: [{ industry: '半导体', count: 6, early: 4, mid: 2, late: 0 }],
        note: '', source: 'akshare stock_zt_pool_em 首次封板时间',
      },
      midCap: {
        ok: true,
        byIndustry: [{ industry: '半导体', count: 6, topName: '中芯', topCode: '688981',
          topFloatMvYi: 1200, topChgPct: 8.2, avgFloatMvYi: 300 }],
        note: '以涨停池内流通市值居前个股作代理', source: 'akshare stock_zt_pool_em 流通市值',
      },
      limitDown: {
        ok: true, count: 15, avgChgPct: -9.9, topLosers: [],
        industryDist: [{ industry: '光伏设备', count: 2 }], note: '', source: 'akshare stock_zt_pool_dtgc_em',
      },
    },
    quote: { sectorsUp: [{ name: '半导体', changePct: 5.2 }], sectorsDown: [] },
    news: [{ title: '工信部发布半导体产业规划', source: '新华社', date: '2026-11-06 10:00', url: '', category: '政策' }],
    sectorFlow: { todayInflowTop5: [{ name: '半导体', mainNet: 42.3 }] },
    prevPool: { ok: true, industryBigDrop: [{ industry: '光伏设备', count: 3 }] },
    ladder: { ok: true, maxBoards: 4 },
    historySeries: [
      { date: '2026-11-02', ztAmountYi: 480 }, { date: '2026-11-03', ztAmountYi: 390 },
      { date: '2026-11-04', ztAmountYi: 300 }, { date: '2026-11-05', ztAmountYi: 220 },
    ],
    breadth: { limitUp: 33, limitDown: 15 },
  };
  return Object.assign(base, over || {});
}

console.log('\n[1] 常量与消息源分级');
t('SCHEMA_VERSION / 驱动标签 / 阈值定义齐全', () => {
  assert.strictEqual(T.SCHEMA_VERSION, 'topic-20261108d');
  ['D1', 'D2', 'D3', 'D4'].forEach(k => assert.ok(T.DRIVER_DEFS[k]));
  assert.strictEqual(T.TOPIC_TH.sLimitUp, 5);
  assert.strictEqual(T.TOPIC_TH.stageMinPoints, 3);
  assert.ok(T.INDUSTRY_KEYWORDS['半导体'].includes('芯片'));
  assert.ok(T.NO_COMPARISON.includes('暂不作持续性判断'));
});
t('消息级别：国家级 / 产业级 / 行业级 / 传闻 / 缺失', () => {
  assert.strictEqual(T.newsLevelOf({ title: '规划发布', source: '新华社' }).level, '国家级/官方');
  assert.strictEqual(T.newsLevelOf({ title: '行业数据', source: '证券时报' }).level, '产业级/官方');
  assert.strictEqual(T.newsLevelOf({ title: '公司动态', source: '东方财富快讯' }).level, '行业级/财经媒体');
  assert.strictEqual(T.newsLevelOf({ title: '网传某公司将并购', source: '某自媒体' }).level, '传闻/未核验');
  assert.strictEqual(T.newsLevelOf(null).level, '缺失');
});
t('题材 ↔ 新闻匹配：官方优先，无匹配返回 null', () => {
  const news = [
    { title: '半导体板块异动', source: '东方财富快讯', date: '2026-11-06 14:00' },
    { title: '工信部发布半导体产业规划', source: '新华社', date: '2026-11-06 10:00' },
  ];
  const m = T.matchNews('半导体', news);
  assert.ok(m, '应命中');
  assert.strictEqual(m.level.level, '国家级/官方', '官方来源应优先于普通财经快讯');
  assert.strictEqual(T.matchNews('贵金属', news), null, '无关键词命中不得硬凑');
});

console.log('\n[2] 题材阶段判定（前 3-5 日同口径行业涨停家数）');
t('对照点不足 → 缺少对照，暂不作持续性判断', () => {
  const s = T.stageOf('半导体', [{ date: '2026-11-05', ok: true, counts: { '半导体': 3 } }], 6);
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.stage, '缺少对照');
  assert.ok(s.reason.includes(T.NO_COMPARISON));
});
t('首次上榜 → 启动期；连续递增 → 发酵/主升期；霸榜回落 → 高潮/退潮期', () => {
  const hist = fixture().sectors.industryHistory;
  assert.strictEqual(T.stageOf('光伏设备', hist, 2).stage, '启动期');
  assert.strictEqual(T.stageOf('半导体', hist, 6).stage, '发酵/主升期');
  assert.strictEqual(T.stageOf('贵金属', hist, 1).stage, '高潮/退潮期');
});
t('中军代理有/无均诚实标注', () => {
  const mc = fixture().sectors.midCap;
  const a = T.midCapOf('半导体', mc);
  assert.strictEqual(a.ok, true);
  assert.ok(a.text.includes('代理'));
  const b = T.midCapOf('贵金属', mc);
  assert.strictEqual(b.ok, false);
  assert.strictEqual(b.text, '缺失');
});

console.log('\n[3] 归因卡片 / 评级 / 投票质量 / 四象限');
t('卡片结构完整，评级只取 S/A/B/C，每行带来源时间与验证逻辑', () => {
  const o = T.analyzeTopics(fixture());
  assert.strictEqual(o.cards.length, 3);
  o.cards.forEach(c => {
    ['name', 'changePct', 'limitUpCount', 'midCapText', 'attribution', 'newsLevel',
      'newsTime', 'stage', 'grade', 'gradeReason', 'verifyLogic', 'voteQuality',
      'quadrant', 'quadrantAction', 'drivers'].forEach(k =>
      assert.ok(Object.prototype.hasOwnProperty.call(c, k), '缺字段 ' + k));
    assert.ok(['S', 'A', 'B', 'C'].includes(c.grade));
    assert.ok(c.verifyLogic.length > 8, '验证逻辑不得是空占位');
    assert.ok(c.newsTime, '来源时间字段必须存在');
  });
});
t('S 级六项证据齐备才成立；中军代理缺失时自动降 A 并写明证据缺口', () => {
  const o = T.analyzeTopics(fixture());
  const s = o.cards.find(c => c.name === '半导体');
  assert.strictEqual(s.grade, 'S');
  assert.strictEqual(s.newsLevel, '国家级/官方');
  assert.strictEqual(s.stage, '发酵/主升期');
  assert.strictEqual(s.quadrant, '共振');
  assert.strictEqual(s.voteQuality, '强共识投票');
  const noMidCap = fixture();
  noMidCap.sectors = Object.assign({}, noMidCap.sectors, { midCap: { ok: false, byIndustry: [], note: '' } });
  const s2 = T.analyzeTopics(noMidCap).cards.find(c => c.name === '半导体');
  assert.strictEqual(s2.grade, 'A', '中军证据缺失不得评 S');
  assert.ok(s2.gradeReason.includes('S 级不成立'));
  assert.strictEqual(s2.evidenceComplete, false);
});
t('C 级诱多陷阱：退潮阶段 + 龙头独舞', () => {
  const o = T.analyzeTopics(fixture());
  const c = o.cards.find(x => x.name === '贵金属');
  assert.strictEqual(c.stage, '高潮/退潮期');
  assert.strictEqual(c.grade, 'C');
  assert.ok(c.gradeReason.includes('诱多陷阱'));
});
t('无匹配新闻 = 消息面证据缺失，四象限判「无法判断」而非「双弱」', () => {
  const o = T.analyzeTopics(fixture());
  const noNews = o.cards.filter(c => c.newsLevel === '缺失');
  assert.ok(noNews.length >= 1);
  noNews.forEach(c => {
    assert.strictEqual(c.quadrant, '无法判断', c.name + ' 不应被误判为双弱');
    assert.ok(c.quadReason.includes('不能证明') || c.quadReason.includes('缺失'));
  });
  assert.ok(o.cards.every(c => c.grade !== undefined), '证据缺失不得导致整批题材被剔除');
});
t('资金投票质量与四象限分布汇总一致', () => {
  const o = T.analyzeTopics(fixture());
  const sum = Object.values(o.voteSummary).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, o.cards.length);
  const qsum = Object.values(o.quadrantSummary).reduce((a, b) => a + b, 0);
  assert.strictEqual(qsum, o.cards.length);
  assert.strictEqual(o.dominantVote, '强共识投票', '半导体六项证据齐备 → 强共识；平票时按固定顺序取首个');
  assert.strictEqual(o.dominantQuadrant, '无法判断');
  assert.ok(o.topicByIndustry['半导体'], '供机会引擎中和的行业索引必须存在');
});
t('驱动标签 D1/D2/D3 由证据给出，D4 恒不标注', () => {
  const o = T.analyzeTopics(fixture());
  const s = o.cards.find(c => c.name === '半导体');
  assert.strictEqual(s.drivers, 'D1/D2/D3');
  assert.ok(o.cards.every(c => !c.drivers.includes('D4')), 'D4 无财报/估值源，恒不标');
});

console.log('\n[4] 口径披露 / 诚实边界 / 确定性');
t('notes 披露推断口径、中军代理、缺少对照、D4 与「不是交易发令枪」', () => {
  const all = T.analyzeTopics(fixture()).notes.join('\n');
  ['未经公告原文核验', '代理', '缺少对照，暂不作持续性判断', 'D4', '线索归因'].forEach(k =>
    assert.ok(all.includes(k), '缺口径 ' + k));
});
t('封板节奏 / 跌停结构摘要由真实采集值给出', () => {
  const o = T.analyzeTopics(fixture());
  assert.ok(o.sealTimeSummary.includes('早盘 5'));
  assert.ok(o.limitDownSummary.includes('跌停股 15 家'));
});
t('空输入不崩：卡片为空、主导结论「无法判断」、最需补充 3 项仍有', () => {
  const o = T.analyzeTopics({});
  assert.strictEqual(o.cards.length, 0);
  assert.strictEqual(o.dominantVote, '无法判断');
  assert.strictEqual(o.dominantQuadrant, '无法判断');
  assert.strictEqual(o.keyMissingTop3.length, 3);
  assert.strictEqual(o.sealTimeSummary, '缺失');
});
t('同输入两次 analyzeTopics 输出逐字一致（数据不变则结论不变）', () => {
  const a = JSON.stringify(T.analyzeTopics(fixture()));
  const b = JSON.stringify(T.analyzeTopics(fixture()));
  assert.strictEqual(a, b);
});
t('卡片文案不含买卖建议与模糊措辞', () => {
  const o = T.analyzeTopics(fixture());
  const text = o.cards.map(c => [c.gradeReason, c.verifyLogic, c.voteReason, c.quadReason].join(' ')).join('\n');
  ['建议买入', '建议卖出', '仓位', '抄底', '一定反弹', '我觉得', '大概', '或许', '事后解释'].forEach(w =>
    assert.ok(!text.includes(w), '命中禁用词 ' + w));
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
