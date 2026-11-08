/**
 * scripts/test_daily_review.js — 每日复盘模块隔离单测（20261108d）
 * 用临时目录 + mock 数据源，不触碰真实 data/，不发起任何外部网络请求。
 * 覆盖：交易日历表、14 段结构、热点归因卡片、四段式结论、机会/风险引擎、五要素、
 *       禁用建议词与模糊词、有限分析版、幂等、修订版、SCHEMA 结构升级、非交易日 skipped_holiday、
 *       3 次重试 + 失败报告、API 查询函数。
 * 引擎纯函数专项见 scripts/test_review_engines.js。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-review-test-'));
process.env.SA_REVIEW_DIR = path.join(TMP, 'reviews');
process.env.SA_TRADE_CALENDAR_DB = path.join(TMP, 'trade_calendar.db');
process.env.SA_TRADE_CALENDAR_OVERRIDES = path.join(TMP, 'overrides.json');

const ROOT = path.join(__dirname, '..');
const tc = require(path.join(ROOT, 'lib', 'tradeCalendar'));
const cal = require(path.join(ROOT, 'lib', 'cnTradingCalendar'));
// 先持有真实桥接层引用（后续 mockSources() 会覆盖 require.cache，但此引用不变）
const board = require(path.join(ROOT, 'lib', 'boardReviewData'));

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' → ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' → ' + e.message); }
}

// ---------- mock 数据源（塞入 require.cache，reviewService 内部 require 会命中） ----------
function mockSources(opts = {}) {
  const q = opts.quote === undefined ? {
    cn: [{ code: 'sh000001', name: '上证指数', changePct: 0.86 }],
    sectorsUp: [{ name: '半导体', changePct: 3.21 }],
    sectorsDown: [{ name: '银行', changePct: -1.12 }],
    sectorUpCount: 22, sectorDownCount: 8, sectorTotal: 31,
    sectorDate: '2026-11-09', sectorSource: '同花顺',
    sectorAll: [{ name: '半导体', amount: 1200.5 }],
    topLimitUpBoard: { name: '半导体', count: 6, date: '2026-11-09' },
  } : opts.quote;
  const b = opts.breadth === undefined ? {
    date: '2026-11-09',
    breadth: { up: 3100, down: 1800, flat: 200, limitUp: 62, limitDown: 9, activePct: 3.2, zbgcCount: 18, zbgcBreaks: 12, zbgcRate: '18%' },
    mainFund: { mainNetToday: -125.6, date: '2026-11-09', source: '东财行业资金流求和' },
  } : opts.breadth;
  const put = (rel, exports) => {
    const p = require.resolve(path.join(ROOT, 'lib', rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  put('stockData', { getMarketOverview: async () => q });
  put('marketEmotionData', { getMarketEmotionData: async () => b });
  put('sectorCapitalFlow', { getSectorCapitalFlow: async () => ({
    ok: true, date: '2026-11-09', source: '东财',
    todayInflowTop5: [{ name: '半导体', mainNet: 42.3 }],
    todayOutflowTop5: [{ name: '银行', mainNet: -21.1 }],
  }) });
  put('boardReviewData', { getBoardReviewData: async () => (opts.boardFail
    ? (() => { throw new Error('模拟 akshare 不可用'); })()
    : {
        ok: true, date: '2026-11-09', fetchedAt: '2026-11-09T07:00:00Z',
        ladder: {
          ok: true, asOf: '2026-11-09', limitUpCount: 32, maxBoards: 5,
          spaceBoard: { boards: 5, code: '002578', name: '闽发铝业', industry: '工业金属' },
          tiers: [{ boards: 5, count: 2, stocks: [{ code: '002578', name: '闽发铝业', industry: '工业金属' }] },
                  { boards: 3, count: 3, stocks: [] }, { boards: 1, count: 21, stocks: [] }],
          hasGap: true, gapAt: [4, 2], board2PlusCount: 5, board3PlusCount: 5, firstBoardCount: 21,
          promotion: [{ from: 1, to: 2, base: 63, promoted: 4, rate: 6.35 }],
          brokenCount: 14, brokenRate: 30.43, limitDownCount: 15, sealFundTotal: 42.6,
        },
        lhb: {
          ok: true, asOf: '2026-11-09', count: 79, netBuyTotal: -7.32, buyTotal: 88.1, sellTotal: 95.4,
          topNetBuy: [{ code: '002696', name: '百洋股份', netBuyYi: 1.87, reason: '日换手率达到20%' }],
          topNetSell: [], reasonStats: [{ reason: '日涨幅偏离值达到7%', count: 5 }],
          institutionBuyMentions: 3, institutionSellMentions: 6,
        },
        // 20261108a 新增四块：昨日涨停今日表现 / 板块层次 / 活跃度 / 前 3-5 日对照
        prevPool: {
          ok: true, asOf: '2026-11-09', count: 84, redCount: 30, redRate: 35.71,
          avgChgPct: -0.82, bigDropCount: 10, bigDropRate: 11.90,
          topGainers: [{ code: '600111', name: '修复股', chgPct: 8.2, prevBoards: 3 }],
          topLosers: [{ code: '600222', name: '断板股', chgPct: -9.8, prevBoards: 4 }],
          industryBigDrop: [{ industry: '工业金属', count: 3 }],
          promotion: [{ from: 1, to: 2, base: 63, promoted: 4, rate: 6.35 }],
          note: '', source: 'akshare stock_zt_pool_previous_em',
        },
        sectors: {
          ok: true, asOf: '2026-11-09', total: 12,
          top: [{ industry: '工业金属', count: 4, boardsMax: 5, sealFundYi: 2, amountYi: 30, leaders: [], followers: [], hasLayer: true },
                { industry: '光伏设备', count: 2, boardsMax: 2, sealFundYi: 1, amountYi: 12, leaders: [], followers: [], hasLayer: false }],
          singleDance: ['银行', '保险'], note: '', source: 'akshare stock_zt_pool_em',
          // 20261108d 新增四块（由 scripts/test_topic_engines.js 专项覆盖阶段/评级分支）
          industryHistory: [],
          sealTime: { ok: true, total: 32, early: 12, mid: 18, late: 2, unknown: 0,
            byIndustry: [{ industry: '工业金属', count: 4, early: 2, mid: 2, late: 0 }],
            note: '', source: 'akshare stock_zt_pool_em 首次封板时间' },
          midCap: { ok: true,
            byIndustry: [{ industry: '工业金属', count: 4, topName: '闽发铝业', topCode: '002578',
              topFloatMvYi: 43.14, topChgPct: 10.11, avgFloatMvYi: 30.2 }],
            note: '以涨停池内流通市值居前个股作代理，非真实板块中军', source: 'akshare stock_zt_pool_em 流通市值' },
          limitDown: { ok: true, count: 15, avgChgPct: -9.93,
            topLosers: [{ code: '001225', name: '和泰机电', chgPct: -9.99, industry: '专用设备', continuous: 1, openTimes: 4, amountYi: 1.35 }],
            industryDist: [{ industry: '专用设备', count: 2 }], note: '', source: 'akshare stock_zt_pool_dtgc_em' },
        },
        activity: {
          ok: true, asOf: '2026-11-09', ztAmountYi: 193.74, strongCount: 151, strongAmountYi: 1164.29,
          topAmount: [{ code: '002578', name: '闽发铝业', amountYi: 5.39, chgPct: 10.1, industry: '工业金属', from: 'zt' }],
          note: '', source: 'akshare stock_zt_pool_strong_em',
        },
        historySeries: [
          { date: '2026-11-04', ok: true, limitUp: 118, maxBoards: 6, board2Plus: 20, brokenCount: 12, limitDown: 6, prevRedRate: 62, promotionRate: 36, ztAmountYi: 480 },
          { date: '2026-11-05', ok: true, limitUp: 84, maxBoards: 5, board2Plus: 15, brokenCount: 14, limitDown: 9, prevRedRate: 48, promotionRate: 25, ztAmountYi: 390 },
          { date: '2026-11-06', ok: true, limitUp: 48, maxBoards: 4, board2Plus: 8, brokenCount: 10, limitDown: 8, prevRedRate: 55, promotionRate: 30, ztAmountYi: 300 },
          { date: '2026-11-09', ok: true, limitUp: 32, maxBoards: 5, board2Plus: 9, brokenCount: 14, limitDown: 15, prevRedRate: 36, promotionRate: 18, ztAmountYi: 220 },
        ],
        issues: [],
      }) });
  put('marketLogDb', { searchMarketLog: () => ({ total: 0, records: [], facets: {} }) });
  put('newsSearch', { getHotNews: async () => ({
    source: '东方财富 7×24 快讯', updated: '2026-11-09T07:00:00.000Z',
    items: [{ title: '某政策发布', source: '东方财富', date: '2026-11-09 14:30', url: '', category: '政策' }],
  }) });
}

(async () => {
  console.log('\n[1] 交易日历表（trade_calendar）');
  t('ensureImported 建表并导入', () => {
    const r = tc.ensureImported();
    assert.ok(r.imported > 900 || r.already > 900, '应导入 3 年约 1095 天');
  });
  t('普通交易日 2026-11-09（周一）= true', () => {
    const r = tc.isTradingDay('2026-11-09');
    assert.strictEqual(r.is_trading_day, true);
    assert.strictEqual(r.from_table, true, '必须来自表');
    assert.strictEqual(r.day_type, 'trading');
  });
  t('周末 2026-11-07（周六）= false', () => {
    const r = tc.isTradingDay('2026-11-07');
    assert.strictEqual(r.is_trading_day, false);
    assert.strictEqual(r.day_type, 'weekend');
  });
  t('法定节假日 2026-10-01（国庆）= false', () => {
    const r = tc.isTradingDay('2026-10-01');
    assert.strictEqual(r.is_trading_day, false);
    assert.strictEqual(r.day_type, 'holiday');
  });
  t('与权威源 cnTradingCalendar 口径一致（2026 全年逐日）', () => {
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= 31; d++) {
        const s = `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        if (new Date(s + 'T00:00:00Z').getUTCDate() !== d) continue;
        assert.strictEqual(tc.isTradingDay(s).is_trading_day, cal.isTradingDay(s), s + ' 不一致');
      }
    }
  });
  t('调休交易日 override=true 生效', () => {
    fs.writeFileSync(process.env.SA_TRADE_CALENDAR_OVERRIDES, JSON.stringify({
      '2026-11-14': { is_trading_day: true, reason: '交易所公告：调休补交易日', source: '上交所公告', source_time: '2026-11-01' },
    }));
    tc.importRange('2026-11-14', '2026-11-14');
    const r = tc.isTradingDay('2026-11-14');
    assert.strictEqual(r.is_trading_day, true, '周末应被 override 为交易日');
    assert.strictEqual(r.day_type, 'makeup');
    assert.ok(r.source_time.includes('2026-11-01'), '必须带来源时间');
  });
  t('stats 统计正常', () => {
    const s = tc.stats();
    assert.ok(s.total > 900 && s.tradingDays > 500);
  });

  console.log('\n[1b] 连板/龙虎榜取数桥接层：口径日归一化');
  t('紧凑 YYYYMMDD 统一为 YYYY-MM-DD（4 个口径日字段）', () => {
    const x = board.normalizeDateFields({
      date: '20261106', prevDate: '20261105',
      ladder: { asOf: '20261106' }, lhb: { asOf: '20261106' },
    });
    assert.strictEqual(x.date, '2026-11-06');
    assert.strictEqual(x.prevDate, '2026-11-05');
    assert.strictEqual(x.ladder.asOf, '2026-11-06');
    assert.strictEqual(x.lhb.asOf, '2026-11-06');
  });
  t('已是 ISO 的不改写，空值不臆造日期', () => {
    const x = board.normalizeDateFields({ date: '2026-11-06', prevDate: null, ladder: null, lhb: {} });
    assert.strictEqual(x.date, '2026-11-06');
    assert.strictEqual(x.prevDate, null);
    assert.strictEqual(x.ladder, null);
  });

  console.log('\n[2] ReviewService 结构 / 生成 / 幂等 / 修订');
  mockSources();
  const svc = require(path.join(ROOT, 'lib', 'reviewService'));
  t('SECTION_DEFS 固定 14 段且顺序正确', () => {
    assert.strictEqual(svc.SECTION_DEFS.length, 14);
    assert.deepStrictEqual(svc.SECTION_DEFS.map(s => s.title), [
      '今日一句话结论', '数据完整性与口径', '每日热点题材与归因卡片',
      '整体情绪与市场级风险', '连板梯队与接力风险', '板块结构与资金投票',
      '成交和资金偏好', '亏钱效应与风险扩散', '机会识别汇总（五层漏斗输出）',
      '明日观察池（含中和过滤）', '明日观察计划', '次日验证清单',
      '历史判断对照', '复盘质量检查',
    ]);
    assert.deepStrictEqual(svc.CORE_SECTIONS,
      ['attribution', 'sentiment', 'ladder', 'sectors', 'capital', 'lossEffect', 'opportunities']);
  });
  t('SCHEMA_VERSION 与禁用词表升级', () => {
    assert.strictEqual(svc.SCHEMA_VERSION, 'review-20261108d');
    assert.strictEqual(svc.LIMITED_THRESHOLD, 90);
    assert.ok(svc.VAGUE_BAN.includes('可能') && svc.ADVICE_BAN.includes('适合打板'));
  });
  t('MISSING 常量为「缺失」', () => assert.strictEqual(svc.MISSING, '缺失'));

  const DATE = '2026-11-09';
  await ta('runReview 首次生成正式版', async () => {
    const r = await svc.runReview({ date: DATE, trigger: 'api' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.action, 'created');
    assert.strictEqual(r.version, 1);
  });
  await ta('生成的复盘含 14 段且顺序固定', async () => {
    const doc = svc.readReviewSync(DATE);
    const v = doc.versions.find(x => x.version === doc.currentVersion);
    assert.strictEqual(v.sections.length, 14);
    assert.deepStrictEqual(v.sections.map(s => s.title), svc.SECTION_DEFS.map(s => s.title));
  });
  await ta('四段式：7 个核心段均含事实/判断/验证/不成立信号', async () => {
    const doc = svc.readReviewSync(DATE);
    const v = doc.versions.find(x => x.version === doc.currentVersion);
    svc.CORE_SECTIONS.forEach(k => {
      const s = v.sections.find(x => x.key === k);
      assert.ok(s && s.quads.length > 0, k + ' 缺四段式');
      s.quads.forEach(q => {
        ['fact', 'judgment', 'verify', 'invalidate'].forEach(f => {
          assert.ok(q[f] && q[f] !== '缺失', k + '.' + f + ' 不得为空或缺失');
        });
      });
    });
    const q = v.sections.find(s => s.key === 'quality');
    assert.strictEqual(q.table.find(c => c.item.includes('每条核心判断均有四段式')).passed, true);
    assert.strictEqual(q.table.find(c => c.item.includes('不含模糊表述')).passed, true);
  });
  await ta('机会/风险引擎：汇总表、观察池、三级风险与口径披露', async () => {
    const doc = svc.readReviewSync(DATE);
    const v = doc.versions.find(x => x.version === doc.currentVersion);
    const opp = v.sections.find(s => s.key === 'opportunities');
    assert.strictEqual(opp.tableKind, 'opportunity');
    assert.ok(opp.table.length > 0, '机会汇总表不得为空');
    assert.ok(opp.table.every(r => ['A', 'B', 'C'].includes(r.grade)), 'D 级不得进表');
    assert.ok(opp.table.every(r => r.capitalContinuity === '缺失'), 'C3 无个股多日成交额，必须诚实标缺失');
    const pool = v.sections.find(s => s.key === 'watchPool');
    assert.strictEqual(pool.tableKind, 'watch');
    assert.ok(pool.table.length >= 3 && pool.table.length <= 8, '观察池 3-8 个样本');
    const sent = v.sections.find(s => s.key === 'sentiment');
    assert.strictEqual(sent.risks.length, 4, 'R-M1~R-M4');
    assert.ok(sent.risks.every(r => ['高', '中', '低', '无法判断'].includes(r.level)));
    const loss = v.sections.find(s => s.key === 'lossEffect');
    assert.ok(loss.risks.some(r => r.code === 'R-M2') && loss.risks.some(r => r.code === 'R-I2'));
    const integ = v.sections.find(s => s.key === 'integrity');
    assert.ok(integ.lines.some(l => l.includes('大面股 = 昨日涨停股今日涨跌幅')));
    assert.ok(integ.lines.some(l => l.includes('成交额样本仅覆盖涨停池')));
    assert.ok(v.engineVersion === 'engine-20261108d');
    assert.strictEqual(v.topicVersion, 'topic-20261108d');
    assert.ok(opp.table.every(r => typeof r.drivers === 'string' && r.drivers.length > 0), '机会表须带 D1-D4 驱动标签');
    assert.ok(pool.table.every(r => typeof r.drivers === 'string'), '观察池须带驱动标签');
    assert.strictEqual(v.histDates.length, 4, '前 4 个交易日对照');
  });
  await ta('热点归因卡片：第 3 段、投票质量表与四段式齐全', async () => {
    const doc = svc.readReviewSync(DATE);
    const v = doc.versions.find(x => x.version === doc.currentVersion);
    const attr = v.sections.find(s => s.key === 'attribution');
    assert.ok(attr, '必须有归因卡片段');
    assert.strictEqual(v.sections[2].key, 'attribution', '归因卡片必须是第 3 段');
    assert.strictEqual(attr.tableKind, 'topic');
    assert.ok(attr.table.length > 0, '归因卡片不得是空白模板');
    assert.ok(attr.table.every(r => ['S', 'A', 'B', 'C'].includes(r.grade)), '题材评级必须是 S/A/B/C');
    assert.ok(attr.table.every(r => r.newsTime && r.newsLevel && r.verifyLogic), '消息级别/来源时间/验证逻辑齐全');
    assert.ok(attr.table.every(r => typeof r.drivers === 'string'), '驱动标签齐全');
    assert.ok(attr.quads.length > 0, '归因段须有四段式结论');
    assert.ok(attr.lines.some(l => l.includes('未经公告原文核验')), '须披露消息级别推断口径');
    assert.ok(attr.lines.some(l => l.includes('封板节奏')), '须披露封板时间分桶');
    const sec = v.sections.find(s => s.key === 'sectors');
    assert.strictEqual(sec.title, '板块结构与资金投票');
    assert.strictEqual(sec.tableKind, 'vote');
    assert.ok(sec.table.length > 0, '资金投票表不得为空');
    assert.ok(sec.table.every(r => r.voteQuality && r.quadrant && r.quadrantAction));
    assert.ok(v.snapshot.topics && v.snapshot.topics.gradeSummary, '快照须保留归因结论供次日对照');
    const q = v.sections.find(s => s.key === 'quality');
    assert.ok(q.lines.some(l => l.includes('我看到了什么')), '质检段须含事实 vs 主观自查');
  });
  await ta('质检 13 项全部通过且无禁用词', async () => {
    const doc = svc.readReviewSync(DATE);
    const v = doc.versions.find(x => x.version === doc.currentVersion);
    const q = v.sections.find(s => s.key === 'quality');
    assert.strictEqual(q.table.length, 13);
    assert.strictEqual(q.passed, true, JSON.stringify(q.table.filter(c => !c.passed)));
    assert.strictEqual(q.table.find(c => c.item.includes('固定 14 段')).passed, true);
    assert.strictEqual(q.table.find(c => c.item.includes('机会评级有证据支撑')).passed, true);
  });
  await ta('禁用建议词检查通过（无买入/卖出/仓位建议）', async () => {
    const doc = svc.readReviewSync(DATE);
    const v = doc.versions.find(x => x.version === doc.currentVersion);
    const q = v.sections.find(s => s.key === 'quality');
    const check = q.table.find(c => c.item.includes('不含操作类建议'));
    assert.strictEqual(check.passed, true, JSON.stringify(check));
    const all = JSON.stringify(v.sections);
    ['建议买入', '加仓', '减仓', '仓位建议', '目标价'].forEach(w => assert.ok(!all.includes(w), '命中禁用词 ' + w));
  });
  await ta('连板梯队 / 龙虎榜 / 昨日涨停 / 板块层次：13 项数据源全部正常', async () => {
    const doc = svc.readReviewSync(DATE);
    const v = doc.versions.find(x => x.version === doc.currentVersion);
    const lad = v.sections.find(s => s.key === 'ladder');
    assert.strictEqual(lad.status, 'ok');
    assert.ok(lad.lines.some(l => l.includes('空间板')), '应含真实空间板');
    assert.ok(lad.lines.some(l => l.includes('梯队分布')), '应含梯队分布');
    assert.ok(lad.lines.some(l => l.includes('晋级率')), '应含晋级率');
    assert.ok(lad.lines.some(l => l.includes('昨日高位股今日反馈')), '应含高位股反馈');
    assert.ok(lad.quads.length > 0 && lad.risks.some(r => r.code === 'R-S2'), '应含接力风险');
    const cap = v.sections.find(s => s.key === 'capital');
    assert.ok(cap.lines.some(l => l.includes('龙虎榜：上榜 79 家')), '应含龙虎榜真实统计');
    assert.ok(cap.lines.some(l => l.includes('净买额前列')), '应含净买额前列');
    assert.ok(cap.lines.some(l => l.includes('全市场成交额靠前个股排行')), '应披露排行缺失口径');
    const loss = v.sections.find(s => s.key === 'lossEffect');
    assert.ok(loss.lines.some(l => l.includes('涨停池同源统计：炸板 14 家')), '应含同源炸板/跌停统计');
    assert.ok(loss.lines.some(l => l.includes('亏钱效应收敛只代表压力缓解')), '应声明收敛≠买点');
    const sent = v.sections.find(s => s.key === 'sentiment');
    assert.ok(sent.lines.some(l => l.includes('昨日涨停股今日表现')), '应含昨日涨停今日红盘率');
    const integ = v.sections.find(s => s.key === 'integrity');
    assert.strictEqual(integ.table.filter(r => r.status === 'ok').length, 13, '13 项数据源应全部正常');
    assert.ok(integ.lines.some(l => l.includes('数据源 13 项，正常 13 项，缺失/失败 0 项')));
    assert.ok(integ.table.every(r => r.source && r.fetchedAt), '五要素：来源/获取时间齐全');
    assert.strictEqual(doc.schemaVersion, 'review-20261108d');
    assert.strictEqual(doc.limited, false, '13 源齐全不应是有限分析版');
  });
  await ta('有限分析版：核心源缺失 → limited=true 且列最需补充 3 项', async () => {
    const D = '2026-11-12';
    mockSources({ boardFail: true });
    try {
      const r = await svc.runReview({ date: D, trigger: 'api', force: true });
      assert.strictEqual(r.action, 'created', JSON.stringify(r));
      assert.strictEqual(r.limited, true, '多源缺失应为有限分析版');
      const doc = svc.readReviewSync(D);
      assert.strictEqual(doc.limited, true);
      const v = doc.versions.find(x => x.version === doc.currentVersion);
      assert.strictEqual(v.limited, true);
      assert.ok(v.limitedReason && v.limitedReason.includes('有限分析版'));
      const integ = v.sections.find(s => s.key === 'integrity');
      assert.ok(integ.lines.some(l => l.includes('最需补充的 3 项')));
      ['个股多日成交额', '板块中军', '公告'].forEach(k =>
        assert.ok(integ.lines.some(l => l.includes(k)), '最需补充项应含 ' + k));
    } finally {
      mockSources();
    }
  });
  await ta('取数失败时连板/龙虎榜诚实降级为「缺失」，不臆造、不反推', async () => {
    const D = '2026-11-05';
    mockSources({ boardFail: true });
    try {
      const r = await svc.runReview({ date: D, trigger: 'api' });
      assert.strictEqual(r.action, 'created', JSON.stringify(r));
      const v = svc.readReviewSync(D).versions[0];
      const lad = v.sections.find(s => s.key === 'ladder');
      assert.strictEqual(lad.status, 'missing');
      assert.ok(lad.lines.join('').includes('缺失'));
      assert.ok(lad.lines.join('').includes('不以涨停家数反推连板高度'), '必须声明不反推');
      const cap = v.sections.find(s => s.key === 'capital');
      assert.ok(cap.lines.some(l => l.includes('龙虎榜数据缺失')));
      const integ = v.sections.find(s => s.key === 'integrity');
      assert.ok(integ.table.some(r2 => r2.name.includes('龙虎榜') && r2.status !== 'ok'));
      assert.ok(integ.table.every(r2 => r2.source && r2.fetchedAt), '五要素齐全');
      const all = JSON.stringify(v.sections);
      assert.ok(!all.includes('闽发铝业') && !all.includes('百洋股份'), '不得残留/编造补全数值');
    } finally {
      mockSources(); // 恢复真实补全数据，避免污染后续用例
    }
  });
  await ta('连板/龙虎榜由缺失→补全，完整度提升自动触发修订版（无需 force）', async () => {
    const D = '2026-11-03';
    mockSources({ boardFail: true });
    let r1;
    try {
      r1 = await svc.runReview({ date: D, trigger: 'cron' });
    } finally {
      mockSources();
    }
    assert.strictEqual(r1.action, 'created', JSON.stringify(r1));
    const s1 = svc.readReviewSync(D).versions[0].completeness.score;
    const r2 = await svc.runReview({ date: D, trigger: 'cron' });
    assert.strictEqual(r2.action, 'revision', '补全后应自动修订：' + JSON.stringify(r2));
    assert.strictEqual(r2.version, 2);
    const v2 = svc.readReviewSync(D).versions[1];
    assert.ok(v2.completeness.score > s1, '修订版完整度应高于正式版');
    assert.strictEqual(v2.sections.find(s => s.key === 'ladder').status, 'ok');
    assert.ok(v2.sections.find(s => s.key === 'capital').lines.some(l => l.includes('龙虎榜：上榜')));
  });
  await ta('新闻催化条目带来源与来源时间，且不参与数值', async () => {
    const doc = svc.readReviewSync(DATE);
    const v = doc.versions.find(x => x.version === doc.currentVersion);
    const pool = v.sections.find(s => s.key === 'watchPool');
    const news = pool.bullets.filter(b => b.includes('新闻催化'));
    assert.ok(news.length > 0);
    news.forEach(n => { assert.ok(n.includes('来源 ')); assert.ok(n.includes('来源时间 ')); });
  });
  await ta('幂等：正式版已存在且完整度未提升 → skipped', async () => {
    const r = await svc.runReview({ date: DATE, trigger: 'cron' });
    assert.strictEqual(r.action, 'skipped');
  });
  await ta('数据更完整（板块资金流源恢复）→ 自动触发修订版 v2，无需 force', async () => {
    // 先在 2026-11-06 用「板块资金流缺失」生成正式版，再让该源恢复 → 完整度上升
    const D2 = '2026-11-06';
    mockSources();
    const scfPath = require.resolve(path.join(ROOT, 'lib', 'sectorCapitalFlow'));
    require.cache[scfPath].exports.getSectorCapitalFlow = async () => { throw new Error('模拟源不可用'); };
    const r1 = await svc.runReview({ date: D2, trigger: 'cron' });
    assert.strictEqual(r1.action, 'created', JSON.stringify(r1));
    const s1 = svc.readReviewSync(D2).versions[0].completeness.score;
    // 源恢复
    mockSources();
    const r2 = await svc.runReview({ date: D2, trigger: 'cron' });
    assert.strictEqual(r2.action, 'revision', '完整度提升应自动生成修订版：' + JSON.stringify(r2));
    assert.strictEqual(r2.version, 2);
    const d2 = svc.readReviewSync(D2);
    assert.strictEqual(d2.versions.length, 2);
    assert.ok(d2.versions[1].completeness.score > s1, '修订版完整度应高于正式版');
  });
  await ta('force 手动重跑 → 生成修订版 v2（管理员入口）', async () => {
    const r = await svc.runReview({ date: DATE, trigger: 'manual', force: true });
    assert.strictEqual(r.action, 'revision');
    assert.strictEqual(r.version, 2);
    const doc = svc.readReviewSync(DATE);
    assert.strictEqual(doc.versions.length, 2);
    assert.strictEqual(doc.currentVersion, 2);
  });
  await ta('SCHEMA_VERSION 升级铁律：旧结构文档完整度持平也自动升级（无需 force）', async () => {
    const D3 = '2026-11-13';
    mockSources();
    const r1 = await svc.runReview({ date: D3, trigger: 'cron' });
    assert.strictEqual(r1.action, 'created', JSON.stringify(r1));
    const f = path.join(process.env.SA_REVIEW_DIR, D3 + '.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.schemaVersion = 'review-20261107b'; // 模拟历史遗留的旧 12 段文档
    fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');
    const r2 = await svc.runReview({ date: D3, trigger: 'cron' });
    assert.strictEqual(r2.action, 'revision', '结构升级不应被同分幂等锁死：' + JSON.stringify(r2));
    assert.strictEqual(r2.version, 2);
    assert.ok(r2.message.includes('复盘结构升级'), '应如实说明升级原因：' + r2.message);
    const d2 = svc.readReviewSync(D3);
    assert.strictEqual(d2.schemaVersion, 'review-20261108d');
    assert.strictEqual(d2.currentVersion, 2);
    assert.strictEqual(d2.versions.find(v => v.version === 2).sections.length, 14);
  });
  await ta('旧结构文档 + 本次取数更差 → 仍跳过，绝不以更差数据覆盖', async () => {
    const D4 = '2026-11-16';
    mockSources();
    const r1 = await svc.runReview({ date: D4, trigger: 'cron' });
    assert.strictEqual(r1.action, 'created', JSON.stringify(r1));
    const f = path.join(process.env.SA_REVIEW_DIR, D4 + '.json');
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    d.schemaVersion = 'review-20261107b';
    fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');
    mockSources({ boardFail: true });
    let r2;
    try { r2 = await svc.runReview({ date: D4, trigger: 'cron', force: true }); }
    finally { mockSources(); }
    assert.strictEqual(r2.action, 'skipped', JSON.stringify(r2));
    assert.ok(r2.reason.includes('待升级'), '应披露结构待升级：' + r2.reason);
    const d2 = svc.readReviewSync(D4);
    assert.strictEqual(d2.currentVersion, 1, '不得覆盖现有版本');
    assert.strictEqual(d2.schemaVersion, 'review-20261107b');
  });
  await ta('非交易日 定时任务 → skipped_holiday 且落日志', async () => {
    const r = await svc.runReview({ date: '2026-11-07', trigger: 'cron', skipHoliday: true });
    assert.strictEqual(r.action, 'skipped_holiday');
    const st = svc.getStatus();
    assert.ok(st.skipLog.some(x => x.status === 'skipped_holiday'));
    const f = path.join(process.env.SA_REVIEW_DIR, '_scheduler.json');
    assert.ok(fs.existsSync(f), 'skipped_holiday 应落盘');
    assert.ok(JSON.parse(fs.readFileSync(f, 'utf8'))[0].status === 'skipped_holiday');
  });
  await ta('非交易日 普通手动重跑也跳过（不拿陈旧行情冒充当日）', async () => {
    const r = await svc.runReview({ date: '2026-11-08', trigger: 'manual' });
    assert.strictEqual(r.action, 'skipped_holiday');
    assert.ok(!fs.existsSync(path.join(process.env.SA_REVIEW_DIR, '2026-11-08.json')), '不应生成休市日复盘');
  });
  await ta('非交易日 force=true 补生成 → integrity 段强制标注口径日', async () => {
    const r = await svc.runReview({ date: '2026-11-08', trigger: 'manual', force: true });
    assert.strictEqual(r.action, 'created', JSON.stringify(r));
    const doc = svc.readReviewSync('2026-11-08');
    const v = doc.versions[0];
    const integ = v.sections.find(s => s.key === 'integrity');
    assert.ok(integ.lines.join('').includes('非交易日强制补生成'), '必须标注非交易日口径');
    assert.ok(doc.tradingDay && doc.tradingDay.is_trading_day === false);
  });
  await ta('查询函数 today / by-date / history / status 正常', async () => {
    const today = svc.getToday();
    assert.ok(today.date && today.calendar);
    const bd = svc.getByDate(DATE);
    assert.strictEqual(bd.found, true);
    assert.ok(bd.review.versions.length === 2);
    assert.strictEqual(svc.getByDate('bad').ok, false);
    const h = svc.getHistory({ limit: 10 });
    assert.ok(h.items.some(x => x.date === DATE));
    const st = svc.getStatus();
    assert.strictEqual(st.scheduler.cron, '35 15 * * 1-5');
    assert.strictEqual(st.scheduler.timezone, 'Asia/Shanghai');
    assert.deepStrictEqual(st.scheduler.retrySlots, ['15:40', '15:45', '15:50']);
    assert.strictEqual(st.scheduler.calendarTable, 'trade_calendar');
  });

  console.log('\n[3] 失败重试 3 次 + 失败报告（关键源全不可用）');
  mockSources({ quote: null, breadth: null });
  await ta('关键源全缺失 → action=failed，输出失败报告', async () => {
    const r = await svc.runReview({ date: '2026-11-10', trigger: 'api' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.action, 'failed');
    assert.strictEqual(r.errors.length, 3, '应重试 3 次');
  });
  t('失败报告落盘且不写正式复盘', () => {
    const f = path.join(process.env.SA_REVIEW_DIR, '2026-11-10.failed.json');
    assert.ok(fs.existsSync(f), '失败报告应存在');
    const rep = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert.strictEqual(rep.attempts, 3);
    assert.strictEqual(rep.errors.length, 3);
    assert.ok(!fs.existsSync(path.join(process.env.SA_REVIEW_DIR, '2026-11-10.json')), '不应写正式复盘');
  });

  tc.close();
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('单测异常:', e); process.exit(1); });
