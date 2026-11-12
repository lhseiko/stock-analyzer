/**
 * scripts/test_daily_review.js — 每日复盘隔离单测（20261110b · LLM 生成 Markdown 契约）
 * ==================================================================================
 * 用户 2026-11-10 16:03 架构裁决后的新契约守卫：
 *  - 旧输出层已废弃并删除；代码不再拼装报告文字、不再有 SECTION_DEFS / 硬性质检；
 *  - 代码交付干净 JSON Context → 复盘 System Prompt + LLM → 整篇 Markdown；
 *  - 缺失数据 / LLM 失败都不阻断发布；
 *  - 前端本地随包 Markdown 渲染，零 CDN。
 *
 * 全程用临时目录 + mock 数据源 + mock LLM 生成层，不触碰真实 data/，不发起任何外部网络请求。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const vm = require('vm');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-review-llm-test-'));
process.env.SA_REVIEW_DIR = path.join(TMP, 'reviews');
process.env.SA_TRADE_CALENDAR_DB = path.join(TMP, 'trade_calendar.db');
process.env.SA_TRADE_CALENDAR_OVERRIDES = path.join(TMP, 'overrides.json');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' → ' + e.message); }
}
async function ta(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + ' → ' + e.message); }
}

const LHB_OK = {
  ok: true, asOf: '2026-11-09', count: 79, netBuyTotal: -7.32, buyTotal: 88.1, sellTotal: 95.4,
  topNetBuy: [{ code: '002696', name: '百洋股份', netBuyYi: 1.87, reason: '日换手率达到20%' }],
  reasonStats: [{ reason: '日涨幅偏离值达到7%', count: 5 }],
  institutionBuyMentions: 3, institutionSellMentions: 6,
  source: 'akshare stock_lhb_detail_em（东方财富龙虎榜明细）',
};
const LHB_PENDING_BLOCK = {
  ok: false, asOf: '2026-11-09', count: null,
  note: '龙虎榜为盘后延迟发布数据：当前时点尚未发布，或接口暂不可用；本项标注「待晚间补录」',
  source: 'akshare stock_lhb_detail_em（东方财富龙虎榜明细）',
};

// ---------- 源码契约（防止旧输出层悄悄回潮） ----------
console.log('\n[1] 架构契约：纯代码拼接已下线，LLM 生成链路已接通');
t('lib/reviewOutput.js 已删除（废弃旧输出层）', () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'lib', 'reviewOutput.js')), false);
});
t('reviewService 不再 require reviewOutput / 不再有 SECTION_DEFS / qualityOf 硬门禁', () => {
  const s = read('lib/reviewService.js');
  assert.ok(!s.includes("require('./reviewOutput')"), '不得再引用旧输出层');
  assert.ok(!/\b(?:const|let|var)\s+SECTION_DEFS\b/.test(s), '不得再定义固定段落常量（注释提及不算）');
  assert.ok(!s.includes('后台质检未通过'), '不得再以质检失败拒绝发布');
  assert.ok(s.includes("require('./reviewContext')") && s.includes("require('./reviewLlm')"));
  assert.ok(s.includes('reviewLlm.generate(context'), '必须真正调用 LLM 生成层');
});
t('复盘 System Prompt 已加载且包含「### 标题骨架 / 两张强制表格 / 说人话 / 柔性缺失 / 合规」要求', () => {
  const p = read('prompts/daily-review-system.md');
  ['纯 Markdown', '三级标题', '### 一句话总结', '### 题材结构与归因', '### 资金与龙虎榜', '### 明日观察计划',
    '热点题材归因卡片', '明日核心观察池', '说人话', '暂无数据', '不给任何操作指令', '归因', '龙虎榜'].forEach(k =>
    assert.ok(p.includes(k), '提示词缺少要求：' + k));
  // 用户明确要求两张表必须带字面标题【热点题材归因卡片】/【明日核心观察池】，
  // 提示词里必须出现带方括号的字面串，否则 LLM 只会当成描述性文字而不会原样输出。
  assert.ok(p.includes('【热点题材归因卡片】'), '提示词必须含字面标题【热点题材归因卡片】');
  assert.ok(p.includes('【明日核心观察池】'), '提示词必须含字面标题【明日核心观察池】');
});
t('reviewLlm 复用项目统一 callLLM、加载提示词、关闭联网搜索、失败降级不抛错', () => {
  const s = read('lib/reviewLlm.js');
  assert.ok(s.includes("require('./ai/llm')") && s.includes('callLLM('));
  assert.ok(s.includes("loadPromptFile(PROMPT_FILE)"));
  assert.ok(s.includes('webSearch: false'), '本地数据推理不得联网');
  assert.ok(s.includes('PROMPT_FILE = \'daily-review-system.md\''));
  assert.ok(s.includes('degraded(context'), 'LLM 失败必须降级而非抛错');
});
t('reviewContext 只出 JSON，不含 SECTION_DEFS / 文本拼装 / 质检', () => {
  const s = read('lib/reviewContext.js');
  assert.ok(!/\b(?:const|let|var)\s+SECTION_DEFS\b/.test(s) &&
    !/function\s+qualityOf\b/.test(s) && !/function\s+plainify\b/.test(s));
  assert.ok(s.includes('function build(') && s.includes('function lhbBlock('));
  assert.ok(s.includes('computed'), '确定性数值必须作为 Context 的一部分');
});
t('前端 Markdown 直出：不再套卡片组件，渲染器本地随包、零 CDN', () => {
  const js = read('public/js/dailyReview.js');
  const html = read('public/daily-review.html');
  assert.ok(!/\bconst TABLE_COLS\b/.test(js) && !/function\s+renderSection\b/.test(js) &&
    !js.includes('class="dr-sections"'), '不得残留 11 段卡片渲染逻辑');
  assert.ok(js.includes('window.Markdown.render') && js.includes('dr-markdown'), '必须直接渲染 Markdown');
  assert.ok(html.includes('js/markdown.js?v='), '渲染器必须本地随包');
  assert.ok(html.indexOf('js/markdown.js') < html.indexOf('js/dailyReview.js'), '渲染器必须先加载');
  const md = read('public/js/markdown.js');
  assert.ok(!/https?:\/\/[^"']*\.min\.js/.test(md), '不得引用外部 CDN');
  assert.ok(md.includes('escape') && md.includes('safeUrl'), '必须有 XSS 防护');
});
t('APP_VERSION 与各 HTML 的 ?v= 缓存戳同步 20261112a（bump_version 全站统一）', () => {
  assert.ok(read('server.js').includes("const APP_VERSION = '20261112a'"));
  assert.ok(read('public/daily-review.html').includes('js/dailyReview.js?v=20261112a'), 'daily-review 的 dailyReview.js 版本戳已对齐');
  assert.ok(read('public/daily-review.html').includes('js/markdown.js?v=20261112a'), 'daily-review 的 markdown.js 版本戳已对齐');
  ['public/etf-flow.html', 'public/daily-review.html'].forEach(f =>
    assert.ok(read(f).includes('?v=20261112a'), f + ' 其余资源缓存戳未升级'));
  assert.ok(read('public/index.html').includes('?v=20261112a'), 'index.html 缓存戳已升 20261112a');
});
t('SCHEMA_VERSION 按铁律升级，旧落盘文档不会被幂等锁死', () => {
  const c = read('lib/reviewContext.js');
  assert.ok(c.includes("SCHEMA_VERSION = 'review-llm-20261111b'"));
});

// ---------- 干净 JSON Context ----------
console.log('\n[2] 干净 JSON Context：只有数据，没有报告文案');
const reviewContext = require(path.join(ROOT, 'lib', 'reviewContext'));
t('build() 产出不带 sections / lines / quads / 标题的纯数据对象', () => {
  const ctx = reviewContext.build({
    date: '2026-11-09', sources: [], engine: { trends: {}, candidates: [] },
    topics: { cards: [] }, meta: {}, stage: 'formal', dragonTigerStatus: 'pending',
  });
  assert.strictEqual(ctx.schema, 'review-context-20261111b');
  assert.strictEqual(ctx.sections, undefined);
  assert.strictEqual(ctx.quads, undefined);
  const txt = JSON.stringify(ctx);
  ['一、今日一句话', 'SECTION_DEFS', '四段式', '有效对照点', '待晚间补录。15:35'].forEach(k =>
    assert.ok(!txt.includes(k), 'Context 混入了报告文案：' + k));
});
t('computed 只保留数值/枚举，过滤引擎生成的句子字段', () => {
  const ctx = reviewContext.build({
    date: '2026-11-09', sources: [],
    engine: { schemaVersion: 'e1', marketRiskLevel: '高', trends: { zt: { direction: '收缩', ok: true, note: '有效对照点不足' } },
      candidates: [{ name: '甲', code: '600001', grade: 'A', oneLine: '这是引擎写死的一句话' }] },
    topics: { cards: [{ name: '半导体', grade: 'S', gradeReason: '引擎写死的评级理由' }] },
    meta: {}, stage: 'formal', dragonTigerStatus: 'pending',
  });
  const c = ctx.computed;
  assert.strictEqual(c.engine.trends.zt.direction, '收缩');
  assert.strictEqual(c.engine.trends.zt.note, undefined, 'trends.note 是黑话，不得进 Context');
  assert.strictEqual(c.engine.candidates[0].oneLine, undefined, '引擎句子不得进 Context');
  assert.strictEqual(c.topics.cards[0].gradeReason, undefined, '引擎句子不得进 Context');
  assert.strictEqual(c.topics.cards[0].grade, 'S');
});
t('龙虎榜未发布 → available=false，且明确非「数据缺失 / 接口故障」', () => {
  const b = reviewContext.lhbBlock(LHB_PENDING_BLOCK, '2026-11-09', 'akshare', false);
  assert.strictEqual(b.available, false);
  assert.strictEqual(b.count, null);
  assert.ok(b.note.includes('非接口故障、非数据缺失'));
});
t('龙虎榜已发布 → available=true 且数值原样不改写', () => {
  const b = reviewContext.lhbBlock(LHB_OK, '2026-11-09', 'akshare', true);
  assert.strictEqual(b.available, true);
  assert.strictEqual(b.count, 79);
  assert.strictEqual(b.netBuyTotal, -7.32);
  assert.strictEqual(b.topNetBuy[0].name, '百洋股份');
});
t('缺失数据源保留在 missing 清单并保留五要素（不臆造）', () => {
  const ctx = reviewContext.build({
    date: '2026-11-09',
    sources: [{ key: 'x', label: '某源', status: 'failed', source: 's', asOf: null, fetchedAt: 't', note: '暂无' }],
    engine: { trends: {}, candidates: [] }, topics: { cards: [] }, meta: {},
    stage: 'formal', dragonTigerStatus: 'pending',
  });
  assert.strictEqual(ctx.missing.length, 1);
  assert.strictEqual(ctx.missing[0].key, 'x');
  assert.strictEqual(ctx.sources[0].asOf, null);
});

// ---------- LLM 生成层（真实模块，不触网） ----------
console.log('\n[3] LLM 生成层：System Prompt / 降级 / 输出清洗');
const reviewLlm = require(path.join(ROOT, 'lib', 'reviewLlm'));
t('提示词文件名与超时配置正确', () => {
  assert.strictEqual(reviewLlm.PROMPT_FILE, 'daily-review-system.md');
  assert.ok(reviewLlm.TIMEOUT_MS >= 180000);
  assert.strictEqual(typeof reviewLlm.isConfigured(), 'boolean');
});
t('cleanMarkdown 去掉模型常见的 ```markdown 围栏', () => {
  assert.strictEqual(reviewLlm.cleanMarkdown('```markdown\n# 标题\n```'), '# 标题');
  assert.strictEqual(reviewLlm.cleanMarkdown('  正文  '), '正文');
});
// generate() 的真实链路（System Prompt + JSON Context 注入 callLLM）在 [5] 以 mock 通道验证，
// 此处不调用真实模型，避免守卫触发外部网络与费用。

// ---------- 前端 Markdown 渲染器 ----------
console.log('\n[4] 本地 Markdown 渲染器：排版能力 + XSS 防护');
const mdSrc = read('public/js/markdown.js');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(mdSrc, sandbox);
const MD = sandbox.Markdown;
t('标题 / 加粗 / 列表 / 引用 / 表格 / 代码块均可渲染', () => {
  const src = ['# 今日复盘', '', '**情绪升温**，比前三天放大。', '', '- 半导体', '- 光伏', '', '> 盘后观察记录', '',
    '| 题材 | 涨停家数 |', '| :--- | ---: |', '| 半导体 | 6 |', '', '```json', '{"a":1}', '```'].join('\n');
  const h = MD.render(src);
  ['<h2>', '<strong>', '<ul>', '<li>', '<blockquote>', '<table>', '<thead>', 'style="text-align:right"', '<pre><code'].forEach(k =>
    assert.ok(h.includes(k), '缺少渲染能力：' + k));
});
// URL 用拼接构造：run_all_tests.js 的 needsNetwork() 会把源码里出现「协议 + 冒号」
// 字面量的测试判为「需网络」而在 --quick 中跳过；本守卫完全不触网，不应被误分类。
const EXAMPLE_URL = 'https' + '://example.com';
const EVIL_IMG = 'https' + '://evil.example/a.png';
t('LLM 输出里的 <script> / javascript: 链接被安全处理', () => {
  const h = MD.render('<script>alert(1)</script>\n\n[点我](javascript:alert(1))\n\n[正常](' + EXAMPLE_URL + ')');
  assert.ok(!h.includes('<script>'));
  assert.ok(!h.includes('href="javascript:'));
  assert.ok(h.includes('href="' + EXAMPLE_URL + '"'));
});
t('不渲染外链图片', () => {
  const h = MD.render('![x](' + EVIL_IMG + ')');
  assert.ok(!h.includes('<img'));
});

// ---------- 端到端：mock 数据源 + mock LLM 生成层 ----------
console.log('\n[5] 端到端：runReview / 幂等 / 补录 / 降级（不触网）');
const tc = require(path.join(ROOT, 'lib', 'tradeCalendar'));
function mockSources(opts = {}) {
  const put = (rel, exports) => {
    const p = require.resolve(path.join(ROOT, 'lib', rel));
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
  };
  put('stockData', { getMarketOverview: async () => ({
    cn: [{ code: 'sh000001', name: '上证指数', changePct: 0.86 }],
    sectorsUp: [{ name: '半导体', changePct: 3.21 }], sectorDate: '2026-11-09',
  }) });
  put('marketEmotionData', { getMarketEmotionData: async () => ({
    date: '2026-11-09',
    breadth: { up: 3100, down: 1800, flat: 200, limitUp: 62, limitDown: 9 },
    mainFund: { mainNetToday: -125.6, date: '2026-11-09' },
  }) });
  put('sectorCapitalFlow', { getSectorCapitalFlow: async () => ({ ok: true, date: '2026-11-09', todayInflowTop5: [] }) });
  put('boardReviewData', {
    getBoardReviewData: async () => ({
      ok: true, date: '2026-11-09',
      ladder: { ok: true, asOf: '2026-11-09', maxBoards: 5, limitUpCount: 32, tiers: [], promotion: [] },
      lhb: opts.lhbPending ? LHB_PENDING_BLOCK : LHB_OK,
      prevPool: { ok: true, asOf: '2026-11-09', redRate: 35.71, bigDropCount: 10, promotion: [{ from: 1, rate: 6.35 }] },
      sectors: { ok: true, asOf: '2026-11-09', top: [], industryHistory: [] },
      activity: { ok: true, asOf: '2026-11-09', ztAmountYi: 193.74 },
      historySeries: [], issues: [],
    }),
    clearCache: () => {},
    getLhbOnly: async () => ({ ok: true, date: '2026-11-09', lhb: LHB_OK, issues: [] }),
  });
  put('marketLogDb', { searchMarketLog: () => ({ total: 0, records: [], facets: {} }) });
  put('newsSearch', { getHotNews: async () => ({ source: '东财快讯', items: [{ title: '某政策发布', source: '东财', date: '2026-11-09 14:30' }] }) });
}

const LLM_CALLS = [];
let LLM_FAIL = false;
function mockLlmLayer() {
  const p = require.resolve(path.join(ROOT, 'lib', 'reviewLlm'));
  require.cache[p] = {
    id: p, filename: p, loaded: true,
    exports: {
      PROMPT_FILE: 'daily-review-system.md', TIMEOUT_MS: 240000,
      isConfigured: () => true,
      generate: async (context, opts) => {
        LLM_CALLS.push({ context, opts });
        if (LLM_FAIL) {
          return { ok: false, degraded: true,
            markdown: '# 数据快照（AI 暂不可用）\n\n```json\n{}\n```',
            model: 'mock-model', promptFile: 'daily-review-system.md',
            error: '模拟模型超时', elapsedMs: 1, contentChars: 30 };
        }
        return { ok: true, degraded: false,
          markdown: '# 2026-11-09 复盘\n\n大模型基于干净 JSON 生成的正文，情绪比前三天放大。',
          model: 'mock-model', promptFile: 'daily-review-system.md',
          error: null, elapsedMs: 12, contentChars: 42 };
      },
    },
  };
}

(async () => {
  t('交易日历表可用（先查表，非交易日静默跳过）', () => {
    tc.ensureImported();
    assert.strictEqual(tc.isTradingDay('2026-11-09').is_trading_day, true);
    assert.strictEqual(tc.isTradingDay('2026-11-07').is_trading_day, false);
  });

  mockSources({ lhbPending: false });

  await ta('真实 reviewLlm 层：System Prompt + 干净 JSON Context 确实传给 callLLM', async () => {
    const llmPath = require.resolve(path.join(ROOT, 'lib', 'ai', 'llm'));
    const reviewLlmPath = require.resolve(path.join(ROOT, 'lib', 'reviewLlm'));
    const orig = require.cache[llmPath];
    let args = null;
    require.cache[llmPath] = {
      ...orig, exports: {
        ...orig.exports,
        callLLM: async (...a) => { args = a; return '```markdown\n# 链路实测\n```'; },
        pickModelFor: () => ({ model: 'mock-model', webSearch: false }),
      },
    };
    delete require.cache[reviewLlmPath];
    try {
      const L = require(reviewLlmPath);
      const ctx = { schema: 'review-context-20261111b', meta: { reviewDate: '2026-11-09', stage: 'formal' }, market: { breadth: { limitUp: 62 } } };
      const r = await L.generate(ctx, { stage: 'formal', date: '2026-11-09' });
      assert.ok(args, 'callLLM 必须被真正调用（证明链路不是纯代码拼装）');
      assert.strictEqual(args[3][0].role, 'system');
      assert.ok(args[3][0].content.includes('每日复盘'), 'System Prompt 必须加载复盘提示词');
      assert.ok(args[3][1].content.includes('"limitUp":62'), '干净 JSON Context 必须作为用户消息注入（紧凑序列化）');
      assert.strictEqual(args[4].webSearch, false, '本地数据推理不得联网');
      assert.strictEqual(r.markdown, '# 链路实测');
      assert.strictEqual(r.ok, true);
    } finally {
      require.cache[llmPath] = orig;
      delete require.cache[reviewLlmPath];
    }
  });

  await ta('callLLM 抛错 → 降级为数据快照，不抛异常、不拒绝发布', async () => {
    const llmPath = require.resolve(path.join(ROOT, 'lib', 'ai', 'llm'));
    const reviewLlmPath = require.resolve(path.join(ROOT, 'lib', 'reviewLlm'));
    const orig = require.cache[llmPath];
    require.cache[llmPath] = {
      ...orig, exports: {
        ...orig.exports,
        callLLM: async () => { throw new Error('模拟模型超时'); },
        pickModelFor: () => ({ model: 'mock-model', webSearch: false }),
      },
    };
    delete require.cache[reviewLlmPath];
    try {
      const L = require(reviewLlmPath);
      const r = await L.generate({ meta: { reviewDate: '2026-11-09' } }, {});
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.degraded, true);
      assert.ok(r.markdown.includes('数据快照'));
      assert.ok(!r.markdown.includes('质检未通过'));
    } finally {
      require.cache[llmPath] = orig;
      delete require.cache[reviewLlmPath];
    }
  });

  mockLlmLayer();
  const svc = require(path.join(ROOT, 'lib', 'reviewService'));

  t('SCHEMA_VERSION / 导出契约已更新（不再导出 SECTION_DEFS）', () => {
    assert.strictEqual(svc.SCHEMA_VERSION, 'review-llm-20261111b');
    assert.strictEqual(svc.SECTION_DEFS, undefined);
    assert.strictEqual(svc.CONTEXT_VERSION, 'review-context-20261111b');
  });
  t('getStatus 声明 LLM 已启用且失败策略为降级发布', () => {
    const st = svc.getStatus();
    assert.strictEqual(st.scheduler.outputFormat, 'markdown');
    assert.strictEqual(st.scheduler.llm.enabled, true);
    assert.ok(st.scheduler.llm.onFailure.includes('不阻断'));
  });

  await ta('runReview 生成 Markdown 落盘，且确实调用了一次 LLM 生成层', async () => {
    const r = await svc.runReview({ date: '2026-11-09', trigger: 'test' });
    assert.strictEqual(r.action, 'created', JSON.stringify(r));
    assert.strictEqual(r.outputFormat, 'markdown');
    assert.ok(LLM_CALLS.length >= 1, '必须调用 LLM 生成层');
    const doc = svc.readReviewSync('2026-11-09');
    assert.strictEqual(doc.outputFormat, 'markdown');
    assert.ok(doc.markdown.startsWith('# 2026-11-09 复盘'));
    assert.strictEqual(doc.stage, 'complete', '龙虎榜已有数据时直接完整版');
    assert.strictEqual(doc.llm.ok, true);
    const ver = doc.versions.find(v => v.version === doc.currentVersion);
    assert.ok(ver.context && ver.context.schema === 'review-context-20261111b', '必须保存干净 JSON Context');
    assert.strictEqual(ver.sections, undefined, '不得残留旧 sections');
    assert.strictEqual(ver.quality, undefined, '不得残留硬性质检');
    assert.strictEqual(ver.llm.model, 'mock-model');
    // 交给 LLM 的 Context 里不含任何报告文案
    assert.ok(LLM_CALLS[0].context.news[0].title === '某政策发布');
    assert.ok(!JSON.stringify(LLM_CALLS[0].context).includes('一、今日一句话'));
  });

  await ta('非交易日静默跳过（不拿最近交易日行情冒名）', async () => {
    const r = await svc.runReview({ date: '2026-11-07', trigger: 'test' });
    assert.strictEqual(r.action, 'skipped_holiday');
  });

  await ta('LLM 失败 / 字段缺失 → 降级为数据快照，照常发布（取消硬性质检）', async () => {
    LLM_FAIL = true;
    fs.rmSync(path.join(process.env.SA_REVIEW_DIR, '2026-11-06.json'), { force: true });
    const r = await svc.runReview({ date: '2026-11-06', trigger: 'test' });
    assert.strictEqual(r.action, 'created', 'LLM 失败不得拒绝发布：' + JSON.stringify(r));
    const doc = svc.readReviewSync('2026-11-06');
    assert.ok(doc.markdown.includes('数据快照'));
    assert.strictEqual(doc.llm.ok, false);
    LLM_FAIL = false;
  });

  await ta('formal → complete 补录：并入新龙虎榜并重新生成整篇 Markdown', async () => {
    fs.rmSync(path.join(process.env.SA_REVIEW_DIR, '2026-11-05.json'), { force: true });
    mockSources({ lhbPending: true });   // 让主跑时龙虎榜尚未发布 → formal
    const r1 = await svc.runReview({ date: '2026-11-05', trigger: 'test' });
    assert.strictEqual(r1.action, 'created');
    let doc = svc.readReviewSync('2026-11-05');
    assert.strictEqual(doc.stage, 'formal');
    assert.strictEqual(doc.versions[0].context.dragonTiger.available, false);
    const before = LLM_CALLS.length;
    const r2 = await svc.backfillDragonTiger('2026-11-05', { trigger: 'test' });
    assert.strictEqual(r2.action, 'completed', JSON.stringify(r2));
    assert.strictEqual(r2.stage, 'complete');
    assert.ok(LLM_CALLS.length === before + 1, '补录必须重新调用一次 LLM');
    doc = svc.readReviewSync('2026-11-05');
    assert.strictEqual(doc.stage, 'complete');
    const v2 = doc.versions.find(v => v.version === doc.currentVersion);
    assert.strictEqual(v2.context.dragonTiger.available, true);
    assert.strictEqual(v2.context.dragonTiger.count, 79);
    assert.ok(v2.markdown.startsWith('# 2026-11-09 复盘'), '完整版是重新生成的 Markdown');
    assert.strictEqual(v2.sections, undefined);
  });

  await ta('同一日期 complete 幂等唯一，重复补录静默跳过', async () => {
    const r = await svc.backfillDragonTiger('2026-11-05', { trigger: 'test' });
    assert.strictEqual(r.action, 'skipped');
    assert.ok(r.reason.includes('只允许一份'));
  });

  await ta('取消硬性质检：Context 内数据重复 / 大量 null 也不阻断发布', async () => {
    const ctx = reviewContext.build({
      date: '2026-11-04', sources: [], engine: { trends: {}, candidates: [] },
      topics: { cards: [] }, meta: {}, stage: 'formal', dragonTigerStatus: 'pending',
    });
    assert.ok(JSON.stringify(ctx).includes('null'));
    const snap = reviewContext.toDataSnapshotMarkdown(ctx, '测试');
    assert.ok(snap.includes('数据快照') && snap.includes('```json'));
    const r = await svc.runReview({ date: '2026-11-04', trigger: 'test', force: true });
    assert.ok(r.action === 'created' || r.action === 'revision', JSON.stringify(r));
  });

  await ta('SCHEMA 升级优先：旧 11 段文档即使完整度更高，重跑也会生成 Markdown 修订版', async () => {
    mockSources({ lhbPending: false });
    const f = path.join(process.env.SA_REVIEW_DIR, '2026-11-03.json');
    fs.writeFileSync(f, JSON.stringify({
      schemaVersion: 'review-20261110a', reviewDate: '2026-11-03', status: 'ok',
      stage: 'complete', currentVersion: 1,
      versions: [{ version: 1, kind: 'official', stage: 'complete',
        completeness: { score: 100 }, sections: [{ key: 'oneline', title: '一、今日一句话结论' }] }],
    }), 'utf8');
    const r = await svc.runReview({ date: '2026-11-03', trigger: 'test' });
    assert.strictEqual(r.action, 'revision', '旧结构不得锁死新报告：' + JSON.stringify(r));
    const doc = svc.readReviewSync('2026-11-03');
    assert.strictEqual(doc.schemaVersion, 'review-llm-20261111b');
    assert.ok(doc.markdown.startsWith('# 2026-11-09 复盘'));
  });

  console.log('\n──────────────────────────────────────────');
  console.log(`  每日复盘 LLM 契约守卫：${pass} 通过 / ${fail} 失败`);
  console.log('──────────────────────────────────────────');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  if (fail) process.exit(1);
})();
