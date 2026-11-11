/**
 * scripts/test_e2e_chains.js — P2-1 批次 2：E2E 固化（5 条链路，逐链追加）
 * --------------------------------------------------------------
 * 链路 1（已落地）：个股复盘 run 幂等 + 降级链（B0-1/B0-2/B0-4）
 * 链路 2（本轮）：deep-analysis 当前价降级 E2E（P0-1 价格口径可见性）
 *   - 直调 deepAnalysis（不混路由 _deepJobs 状态机，属链路 3）。
 *   - 复用 dataDir 隔离 + require.cache 合成桩替换所有网络数据层；
 *     仅保持 pipeline / statements / conclusions / conclusion / companyType / chipDistribution / insuranceAnalysis 真实执行。
 *   - 降级触发方式：传入「无 .price 的 quote 对象」（行情网关不可用但非 null），
 *     真实 wrapQuote 返回 null → 真实降级分支回退 history 末日收盘价并打 degraded 标记。
 * 运行：node scripts/test_e2e_chains.js
 * 说明：链路 3-5（analysis / 复盘生成 / 数据源降级链）后续回合逐条追加。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// ── 隔离：env 在 require 任何依赖【之前】设到项目外临时目录（dataDir 机制） ──
const TMP_ROOT = path.join(os.tmpdir(), 'sa-e2e-chains-' + process.pid + '-' + Date.now());
const TMP_DATA = path.join(TMP_ROOT, 'stock-reviews');
const TMP_MARKET = path.join(TMP_ROOT, 'reviews');
fs.mkdirSync(TMP_DATA, { recursive: true });
fs.mkdirSync(TMP_MARKET, { recursive: true });
process.env.SA_STOCK_REVIEW_DIR = TMP_DATA;
process.env.SA_REVIEW_DIR = TMP_MARKET;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

// ── 共享可变桩状态（降级开关 + LLM 调用计数） ──
// [20261111d] intradayMode 切换 AKShare 主源可用 / 不可达，用于验证分时多源降级链。
const state = {
  degraded: false, callLLMCount: 0, lastUserText: '', lastSectorIndustry: null,
  intradayMode: 'akshare-ok', intradayAkshareCalls: 0, intradayTencentCalls: 0,
};

// [20261111d] 合成完整交易日 242 个分钟点（09:30-11:30 + 13:00-15:00），累计量单调递增。
function makeIntradayPoints(startPrice) {
  const out = [];
  let cum = 0;
  const add = (mod) => {
    const i = out.length;
    const step = 100 + (i % 5) * 10;
    cum += step;
    out.push({
      time: String(Math.floor(mod / 60)).padStart(2, '0') + String(mod % 60).padStart(2, '0'),
      price: Number((startPrice + i * 0.002).toFixed(3)),
      avg: Number((startPrice + i * 0.001).toFixed(3)),
      volume: cum,
    });
  };
  for (let m = 0; m <= 120; m++) add(9 * 60 + 30 + m);
  for (let m = 0; m <= 120; m++) add(13 * 60 + m);
  return out;
}

// 合成 require.cache 桩：覆盖个股复盘 + deep-analysis 的全部网络数据层。
// 保持真实执行：pipeline / statements / conclusions / conclusion / companyType / chipDistribution / insuranceAnalysis。
function installFakes() {
  const map = {
    stockData: path.join(ROOT, 'lib', 'stockData.js'),
    quoteHub: path.join(ROOT, 'lib', 'quoteHub.js'),
    capitalFlow: path.join(ROOT, 'lib', 'capitalFlow.js'),
    sectorLimitStats: path.join(ROOT, 'lib', 'sectorLimitStats.js'),
    sectorIdentity: path.join(ROOT, 'lib', 'sectorIdentity.js'),
    boardReviewData: path.join(ROOT, 'lib', 'boardReviewData.js'),
    newsSearch: path.join(ROOT, 'lib', 'newsSearch.js'),
    aiConfig: path.join(ROOT, 'lib', 'ai', 'config.js'),
    aiLlm: path.join(ROOT, 'lib', 'ai', 'llm.js'),
    // deep-analysis 网络数据层
    finData: path.join(ROOT, 'lib', 'deep', 'financials.js'),
    dividendsMod: path.join(ROOT, 'lib', 'deep', 'dividends.js'),
    yieldMod: path.join(ROOT, 'lib', 'deep', 'yield.js'),
    researchMod: path.join(ROOT, 'lib', 'deep', 'research.js'),
    changeMod: path.join(ROOT, 'lib', 'changeAnalysis.js'),
    emVal: path.join(ROOT, 'lib', 'eastmoneyValuation.js'),
    valHub: path.join(ROOT, 'lib', 'valuationHub.js'),
    finHub: path.join(ROOT, 'lib', 'financeHub.js'),
    dbMod: path.join(ROOT, 'lib', 'db.js'),
    aiCache: path.join(ROOT, 'lib', 'ai', 'cache.js'),
  };

  // 真实 wrapQuote 的忠实镜像：无 .price → 返回 null（触发 pipeline 降级分支）；
  // 有 .price → 返回 {ok, latest:{price:{value}}}（pipeline 据此取权威价）。
  function fakeWrapQuote(q) {
    if (!q || !q.price) return null;
    const SOURCE = 'quote';
    const fetchTime = new Date().toISOString();
    const dataTime = q.date + (q.time ? ' ' + q.time : '');
    return {
      ok: true,
      source: SOURCE,
      freshness: { expired: false },
      analysis: {},
      latest: { price: { name: '当前价', value: q.price, dataTime, source: SOURCE, fetchTime } },
    };
  }

  // 安全最小财务数据集：income 非空（绕过 income.length===0 提前返回），
  // balance/cashflow 给 2 年数值，使真实分析模块（statements 等）安全完成而不崩。
  const income = [
    { REPORT_DATE: '2024-12-31', REPORT_DATE_NAME: '2024年报', TOTAL_OPERATE_INCOME: 1.0e11, TOTAL_OPERATE_INCOME_YOY: 0.10, PARENT_NETPROFIT: 1.0e10, PARENT_NETPROFIT_YOY: 0.10, BASIC_EPS: 1.5, OPERATE_COST: 8.0e10, OPERATING_PROFIT: 2.0e10, SALE_EXPENSE: 5e9, MANAGE_EXPENSE: 4e9, RESEARCH_EXPENSE: 3e9, FINANCE_EXPENSE: 1e9 },
    { REPORT_DATE: '2025-12-31', REPORT_DATE_NAME: '2025年报', TOTAL_OPERATE_INCOME: 1.1e11, TOTAL_OPERATE_INCOME_YOY: 0.10, PARENT_NETPROFIT: 1.1e10, PARENT_NETPROFIT_YOY: 0.10, BASIC_EPS: 1.6, OPERATE_COST: 8.5e10, OPERATING_PROFIT: 2.2e10, SALE_EXPENSE: 5e9, MANAGE_EXPENSE: 4e9, RESEARCH_EXPENSE: 3e9, FINANCE_EXPENSE: 1e9 },
  ];
  const balance = [
    { REPORT_DATE: '2024-12-31', REPORT_DATE_NAME: '2024年报', TOTAL_ASSETS: 1.0e11, TOTAL_LIABILITIES: 9e10, TOTAL_PARENT_EQUITY: 1e10, SHARE_CAPITAL: 1e10, MONETARYFUNDS: 1e10, INVENTORY: 1e9, FIXED_ASSET: 1e9, INTANGIBLE_ASSET: 1e8, ACCOUNTS_RECE: 1e9, PREPAYMENT: 1e8, OTHER_CURRENT_ASSET: 1e8, DEFER_TAX_ASSET: 1e7, CIP: 1e8, GOODWILL: 1e8, ACCOUNTS_PAYABLE: 1e9, CONTRACT_LIAB: 1e8, TAX_PAYABLE: 1e8, STAFF_SALARY_PAYABLE: 1e7, OTHER_CURRENT_LIAB: 1e8, DEFER_TAX_LIAB: 1e7, LONG_LOAN: 1e9, BOND_PAYABLE: 1e8, LEASE_LIAB: 1e7, OTHER_NONCURRENT_FINASSET: 0, LEND_FUND: 0, ACCEPT_DEPOSIT_INTERBANK: 0, TRADE_FINASSET_NOTFVTPL: 0, BUY_RESALE_FINASSET: 0 },
    { REPORT_DATE: '2025-12-31', REPORT_DATE_NAME: '2025年报', TOTAL_ASSETS: 1.1e11, TOTAL_LIABILITIES: 9.5e10, TOTAL_PARENT_EQUITY: 1.5e10, SHARE_CAPITAL: 1e10, MONETARYFUNDS: 1.1e10, INVENTORY: 1.1e9, FIXED_ASSET: 1.1e9, INTANGIBLE_ASSET: 1e8, ACCOUNTS_RECE: 1.1e9, PREPAYMENT: 1e8, OTHER_CURRENT_ASSET: 1e8, DEFER_TAX_ASSET: 1e7, CIP: 1e8, GOODWILL: 1e8, ACCOUNTS_PAYABLE: 1.1e9, CONTRACT_LIAB: 1e8, TAX_PAYABLE: 1e8, STAFF_SALARY_PAYABLE: 1e7, OTHER_CURRENT_LIAB: 1e8, DEFER_TAX_LIAB: 1e7, LONG_LOAN: 1.1e9, BOND_PAYABLE: 1e8, LEASE_LIAB: 1e7, OTHER_NONCURRENT_FINASSET: 0, LEND_FUND: 0, ACCEPT_DEPOSIT_INTERBANK: 0, TRADE_FINASSET_NOTFVTPL: 0, BUY_RESALE_FINASSET: 0 },
  ];
  const cashflow = [
    { REPORT_DATE: '2024-12-31', REPORT_DATE_NAME: '2024年报', NETCASH_OPERATE: 1.0e10 },
    { REPORT_DATE: '2025-12-31', REPORT_DATE_NAME: '2025年报', NETCASH_OPERATE: 1.1e10 },
  ];

  const fakes = {
    stockData: {
      detectMarket: (s) => {
        const code = String(s).replace(/^(SH|SZ|sh|sz)/i, '');
        return { market: 'CN', exchange: 'SH', tencentCode: 'sh' + code, yahooCode: code + '.SS' };
      },
      getQuote: async (symbol) => ({ code: symbol, name: '测试股', date: '2026-11-10', time: '15:00', open: 10, high: 10.5, low: 9.8, price: 10.2, prevClose: 10, changePct: 2, turnover: 1.2, amount: 2.7e8, volume: 1000000 }),
      fetchEastmoneyHistory: async () => ([{ date: '2026-11-09', amount: 2.55e8, turnover: 1.1 }]),
      // [20261111d] 分时降级源：项目现成腾讯通道（cumVol 为累计量）
      fetchTencentMinutes: async (tc) => {
        state.intradayTencentCalls++;
        return {
          date: '2026-11-10', prevClose: 10,
          minutes: makeIntradayPoints(10).map(p => ({ time: p.time, price: p.price, avg: p.avg, cumVol: p.volume })),
        };
      },
    },
    quoteHub: {
      getQuoteHub: async () => ({ ok: true, latest: { price: 10.2 }, dataTime: '2026-11-10 15:00' }),
      wrapQuote: fakeWrapQuote,
    },
    capitalFlow: { analyzeCapitalFlow: async () => ({
      moneyFlow: { summary: { summary: { '5d': { mainNet: 3.2e8, direction: '净流入' }, '10d': { mainNet: -1.1e8, direction: '净流出' } } } },
      // 资金量能模块结论（个股复盘 Context.volume 的数据源）
      volumeEngine: { ok: true, volumeState: { level: '放量', ratio5: 1.8, ratio10: 1.4, ratio20: 1.2, avg5: 100, avg10: 90, avg20: 80, turnoverToday: 1.2 }, volumeTier: { level: '放量' }, position: { label: '阶段高位', pricePct12m: 85 }, dataGaps: [] },
    }) },
    sectorLimitStats: { getSectorLimitStats: async (symbol, name, industry) => {
      state.lastSectorIndustry = industry;
      return { ok: true, industryName: industry || '测试行业', boardName: '主板', limitUp: 2, limitDown: 1, total: 10, date: '2026-11-10' };
    } },
    // 行业分析模块：模拟中国平安类大盘蓝筹被正确识别为「保险」
    sectorIdentity: { resolveSectorIdentity: async (symbol, name) => ({ symbol, name, industry: '保险', industrySource: 'code-override', confidence: 1, ok: true }) },
    // 龙虎榜：全量 byCode 索引（600002 命中上榜，其余未上榜）
    boardReviewData: {
      getLhbOnly: async (date) => ({
        ok: true, date,
        lhb: {
          ok: true, count: 2, netBuyTotal: 1.5, buyTotal: 3.0, sellTotal: 1.5, asOf: date,
          source: 'akshare stock_lhb_detail_em（测试桩）',
          topNetBuy: [{ code: '600002', name: '测试股', netBuyYi: 1.2, reason: '日涨幅偏离值达7%' }],
          topNetSell: [], reasonStats: [{ reason: '日涨幅偏离值达7%', count: 2 }],
          institutionBuyMentions: 1, institutionSellMentions: 0,
          byCode: { '600002': { name: '测试股', netBuyYi: 1.2, buyYi: 2.0, sellYi: 0.8, reason: '日涨幅偏离值达7%', changePct: 9.9 } },
          note: '',
        },
      }),
      // [20261111d] 分时主源：AKShare 1 分钟 K 线（volume 为当分钟量，与腾讯累计量路径不同）
      getIntraday: async (symbol, date) => {
        state.intradayAkshareCalls++;
        if (state.intradayMode === 'akshare-fail') throw new Error('ProxyError push2his.eastmoney.com（测试桩）');
        return {
          ok: true, symbol, date, asOf: date,
          source: 'stock_zh_a_hist_min_em(period=1)（测试桩）',
          points: makeIntradayPoints(10).map((p, i) => ({ ...p, volume: 100 + (i % 5) * 10 })),
          note: '',
        };
      },
    },
    newsSearch: { getNews: async () => ([{ title: '测试新闻', date: '2026-11-10', source: '测试源', sentiment: 'neutral' }]) },
    aiConfig: {
      loadConfig: () => state.degraded
        ? { apiKey: null, provider: 'test', modelLocal: 'm', model: 'm' }
        : { apiKey: 'test', provider: 'test', modelLocal: 'm', model: 'm' },
      loadPromptFile: () => '系统提示词：个股每日复盘',
    },
    aiLlm: {
      // 捕获 userText（内含完整 JSON Context），供端到端断言三块数据确实注入
      callLLM: async (provider, key, model, messages) => {
        state.callLLMCount++;
        state.lastUserText = (messages && messages[1] && messages[1].content) || '';
        return '> 评级判定：B\n> 放弃信号判定：未触发\n#### 三、明日剧本推演与验证\n测试剧本内容';
      },
      pickModelFor: () => ({ model: 'test-model' }),
    },
    // —— deep-analysis 数据层 ——
    finData: {
      fetchFinancialData: async () => ({ income, balance, cashflow }),
      fetchShareholders: async () => ({ totalShares: 1e10, floatShares: 1e10, holders: 100000, avgHolding: 1e5 }),
      buildShareholderStats: () => ({ top10Pct: 0, institutionPct: 0 }),
      fetchTopShareholders: async () => [],
    },
    dividendsMod: {
      fetchDividends: async () => [],
      persistDividends: async () => {},
      classifyDividendStage: () => '',
      dividendLabel: () => '',
      normalizeSymbol: (s) => s,
      persistValuationScalars: async () => {},
      loadDividendSeries: async () => [],
    },
    yieldMod: { analyzeDividendYield: async () => null },
    researchMod: {
      getLocalDocuments: () => [],
      fetchSegmentData: async () => null,
      buildProductGrossMargin: () => null,
    },
    changeMod: { analyzeChangesForSymbol: async () => ({ hasChanges: false, analyses: [] }) },
    emVal: { fetchValuationTTM: async () => null },
    valHub: { getValuationHub: async () => null, beginSnapshot: (x) => x },
    finHub: { getFinanceHub: async () => null },
    dbMod: { upsertDataPoint: async () => {}, saveSnapshot: async () => {} },
    aiCache: { readCache: () => null, readEarningsCache: () => null },
  };

  for (const [k, p] of Object.entries(map)) {
    const abs = require.resolve(p);
    require.cache[abs] = { id: abs, filename: abs, loaded: true, exports: fakes[k] };
  }
}

installFakes();
const stockReview = require(path.join(ROOT, 'lib', 'stockReview.js'));
const deepAnalysis = require(path.join(ROOT, 'lib', 'deepAnalysis.js')).deepAnalysis;

// 行情不可用场景：quote 是对象但缺 .price（非 null，避免 pipeline:300 在 quote 上挂属性抛错）
const NO_PRICE_QUOTE = { date: '2026-11-10', time: '15:00' };
const VALID_QUOTE = { date: '2026-11-10', time: '15:00', price: 12.3, prevClose: 12, changePct: 2.5 };
const HIST = [{ date: '2026-11-09', close: 9.5 }];

(async () => {
  try {
    /* ══════════════ §A 批量 run 幂等 ══════════════ */
    section('§A 个股复盘批量 run 幂等（runPoolBatch 当日已有→跳过，不调 LLM）');
    {
      const D = '2026-11-09';
      fs.mkdirSync(TMP_MARKET, { recursive: true });
      const mk6 = '**【明日核心观察池】**\n\n| 股票名称 | 代码 | 入选原因 | 评级 | 明日观察什么 | 放弃跟踪的信号 |\n|---|---|---|---|---|---|\n| 测试股 | 600001 | 测试 | A | 看承接 | 无承接即弃 |\n';
      fs.writeFileSync(path.join(TMP_MARKET, D + '.json'), JSON.stringify({ markdown: mk6 }), 'utf8');
      const rec = {
        schemaVersion: stockReview.SCHEMA_VERSION, symbol: '600001', name: '测试股', date: D,
        createdAt: new Date().toISOString(), poolEntry: null, poolDate: null, giveupStreak: 0,
        marks: { rating: 'A', giveupTriggered: false, ratingMarkFound: true, giveupMarkFound: false },
        llm: { degraded: false, model: 't', error: null, elapsedMs: 1, contentChars: 5 }, markdown: '测试',
      };
      fs.mkdirSync(path.join(TMP_DATA, '600001'), { recursive: true });
      fs.writeFileSync(path.join(TMP_DATA, '600001', D + '.json'), JSON.stringify(rec), 'utf8');

      const sum = await stockReview.runPoolBatch(D, { max: 12 });
      ok(sum.total === 1 && sum.skipped === 1 && sum.generated === 0 && sum.degraded === 0 && sum.failed === 0,
        'runPoolBatch 幂等：当日已有→跳过且不调 LLM（' + JSON.stringify({ total: sum.total, skipped: sum.skipped, gen: sum.generated, deg: sum.degraded, fail: sum.failed }) + '）');
    }

    /* ══════════════ §B generateReview 双调用幂等 ══════════════ */
    section('§B 个股复盘 generateReview 幂等（连续两次→第2次命中缓存，不重生成）');
    {
      state.degraded = false; state.callLLMCount = 0;
      const D = '2026-11-10';
      const rec1 = await stockReview.generateReview('600002', { date: D });
      ok(rec1 && rec1.marks && rec1.marks.rating === 'B', '首次生成：评级抽取=B');
      ok(rec1.llm.degraded === false, '首次生成：llm.degraded=false');

      const rec2 = await stockReview.generateReview('600002', { date: D });
      ok(rec2 && rec2.marks.rating === 'B', '第二次：仍返回评级=B');
      ok(state.callLLMCount === 1, 'callLLM 仅调用 1 次（第2次命中缓存，未重生成，实际 ' + state.callLLMCount + '）');
      ok(JSON.stringify(rec1) === JSON.stringify(rec2), '两次返回记录字节一致（幂等）');

      const files = fs.readdirSync(path.join(TMP_DATA, '600002')).filter(n => n.endsWith('.json'));
      ok(files.length === 1, '磁盘仅落盘 1 个文件（实际 ' + files.length + '）');

      // [20261111c] 三处「缺失」数据端到端验证：真实 buildContext → llmGenerate → 桩捕获完整 JSON Context
      const ctxText = state.lastUserText || '';
      ok(state.lastSectorIndustry === '保险', '板块：行业分析模块先解析出行业并作为入参传给涨跌停取数（实际 ' + state.lastSectorIndustry + '）');
      ok(ctxText.includes('"sector"') && ctxText.includes('保险'), '板块：Context.sector 含已识别行业（不再「行业识别失败」）');
      ok(ctxText.includes('"volume"') && ctxText.includes('"volumeState"') && ctxText.includes('1.8'), '量能：Context.volume 含资金量能模块结论（量比 1.8）');
      ok(ctxText.includes('"lhb"') && ctxText.includes('"listed":true'), '龙虎榜：Context.lhb 含按代码精确匹配的上榜判定');

      // [20261111d] 分钟级真实分时：AKShare 主源 → Node 侧代码压缩特征 → 注入 Context
      ok(ctxText.includes('"intraday"') && ctxText.includes('"available":true') && ctxText.includes('AKShare'),
        '分时：Context.intraday 为 AKShare 主源的真实分钟特征（非「数据缺失」）');
      ok(ctxText.includes('"pattern"') && ctxText.includes('"segments"') && ctxText.includes('"highTime"')
        && ctxText.includes('"source"') && ctxText.includes('"dateMatches"'),
        '分时：形态 / 四段 / 时点 / 来源 / 口径日已注入（LLM 只拿特征，不拿 raw 分钟点）');
      ok(!ctxText.includes('"points":[{') && !ctxText.includes('"cumVol"'),
        '分时：Context 不含 240+ 条原始分钟点（体积控制，由 Node 侧算成结构化特征）');
      ok(state.intradayAkshareCalls >= 1 && state.intradayTencentCalls === 0,
        '分时：AKShare 主源可用时不触发腾讯降级（实际 ' + state.intradayAkshareCalls + '/' + state.intradayTencentCalls + '）');
    }

    /* ══════════════ §C 降级链（无 AI 配置→degraded 快照照常落盘） ══════════════ */
    section('§C 个股复盘降级链（AI 未配置→degraded 快照照常落盘，不抛、不含 [object Object]）');
    {
      state.degraded = true; state.callLLMCount = 0;
      const D = '2026-11-10';
      let threw = false, rec = null;
      try { rec = await stockReview.generateReview('600003', { date: D, force: true }); } catch (e) { threw = true; }
      ok(!threw, '降级路径不抛异常');
      ok(rec && rec.llm && rec.llm.degraded === true, '降级：llm.degraded=true（如实披露）');
      ok(rec.markdown.indexOf('数据快照') !== -1, '降级：markdown 标注「数据快照」');
      ok(!rec.markdown.includes('[object Object]'), '降级：快照无 [object Object]');
      ok(rec.markdown.indexOf('不构成任何投资建议') !== -1, '降级：含免责行');
      ok(rec.markdown.indexOf('| 量能 |') !== -1, '降级快照：量能行已渲染（资金量能模块）');
      ok(rec.markdown.indexOf('| 龙虎榜 |') !== -1, '降级快照：龙虎榜行已渲染（未上榜如实标注，不留白）');
      ok(state.callLLMCount === 0, '降级：未调用 LLM（实际 ' + state.callLLMCount + '）');
      const f = path.join(TMP_DATA, '600003', D + '.json');
      ok(fs.existsSync(f), '降级：仍照常落盘');
    }

    /* ══════════════ §D 降级结果可幂等读取 ══════════════ */
    section('§D 个股复盘降级结果可幂等读取（force=false 命中缓存，不重生成）');
    {
      state.degraded = true;
      const D = '2026-11-10';
      const rec = await stockReview.generateReview('600003', { date: D });
      ok(rec && rec.llm.degraded === true, 'force=false 命中已落盘降级记录');
      ok(state.callLLMCount === 0, '降级缓存读取未触发 LLM');
    }

    /* ══════════════ §E 结构版本过期自愈（20261111c 用户截图回归） ══════════════ */
    section('§E 旧 schema 当日记录自动重生成（非 force 也不复用旧「缺失」文案）');
    {
      state.degraded = false; state.callLLMCount = 0;
      const D = '2026-11-10';
      const dir = path.join(TMP_DATA, '600004');
      fs.mkdirSync(dir, { recursive: true });
      const stale = {
        schemaVersion: 'stock-review-20261110b', symbol: '600004', name: '测试股', date: D,
        createdAt: new Date().toISOString(), giveupStreak: 0,
        marks: { rating: 'C', giveupTriggered: false, ratingMarkFound: true, giveupMarkFound: false },
        llm: { degraded: false, model: 'old', error: null, elapsedMs: 1, contentChars: 5 },
        markdown: '旧版卡片：板块数据缺失；龙虎榜数据缺失；分时明细数据缺失',
      };
      fs.writeFileSync(path.join(dir, D + '.json'), JSON.stringify(stale), 'utf8');

      const rec = await stockReview.generateReview('600004', { date: D });
      ok(rec.schemaVersion === stockReview.SCHEMA_VERSION, '旧 schema 记录被判定过期并按新 schema 重生成（实际 ' + rec.schemaVersion + '）');
      ok(state.callLLMCount === 1, '过期记录触发且仅触发 1 次 LLM（实际 ' + state.callLLMCount + '）');
      ok(rec.markdown.indexOf('板块数据缺失') === -1, '新卡片不再含旧「缺失」占位文案');

      const rec2 = await stockReview.generateReview('600004', { date: D });
      ok(state.callLLMCount === 1 && rec2.schemaVersion === stockReview.SCHEMA_VERSION, '新 schema 记录再次读取命中缓存（幂等，不重跑 LLM）');

      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, D + '.json'), 'utf8'));
      ok(onDisk.schemaVersion === stockReview.SCHEMA_VERSION, '重生成结果已按新 schema 落盘（下次读取即命中缓存，不会反复重跑 LLM）');
    }

    /* ══════════════ §F 分时多源降级链（20261111d） ══════════════ */
    section('§F 分时多源降级链（AKShare 不可达 → 腾讯分时，来源与降级原因如实标注）');
    {
      state.degraded = false; state.callLLMCount = 0;
      state.intradayMode = 'akshare-fail';
      state.intradayAkshareCalls = 0; state.intradayTencentCalls = 0;
      const D = '2026-11-10';
      const rec = await stockReview.generateReview('600005', { date: D, force: true });
      const ctxText = state.lastUserText || '';
      ok(rec && rec.llm.degraded === false, '分时主源失败不影响复盘正常生成（非降级快照）');
      ok(ctxText.includes('"intraday"') && ctxText.includes('"available":true') && ctxText.includes('腾讯分时'),
        '分时：AKShare 失败后 Context.intraday 由腾讯分时补齐（不留白、不写缺失）');
      ok(ctxText.includes('"degradedFrom"') && ctxText.includes('AKShare'),
        '分时：degradedFrom 如实记录主源失败原因，不冒充 AKShare 数据');
      ok(ctxText.includes('"dateMatches":true'), '分时：口径日与复盘日一致，dateMatches=true');
      ok(ctxText.includes('"pattern"') && ctxText.includes('"peakVolTime"'),
        '分时：降级后仍由代码计算形态 / 量能峰值（代码权威，不交给 LLM 推断）');
      ok(state.intradayAkshareCalls === 1 && state.intradayTencentCalls === 1,
        '分时：主源试 1 次失败后仅降级 1 次（实际 ' + state.intradayAkshareCalls + '/' + state.intradayTencentCalls + '）');
      ok(rec && rec.markdown.indexOf('分时明细数据缺失') === -1 && rec.markdown.indexOf('按 OHLC 还原') === -1,
        '分时：新卡片不再出现旧「缺失 / 按 OHLC 还原」占位文案');
      state.intradayMode = 'akshare-ok';
    }

    /* ══════════════ 链路 2 · §A 当前价降级触发 ══════════════ */
    section('链路2·§A deep-analysis 当前价降级触发（行情不可用→回退日线末日收盘价，degraded 标记）');
    {
      let threw = false, res = null;
      try {
        res = await deepAnalysis('600001', '测试股', NO_PRICE_QUOTE, HIST, { force: true });
      } catch (e) { threw = true; console.log('   抛错：' + (e && e.message)); }
      ok(!threw, '降级路径不抛异常');
      const cp = res && res.sections && res.sections.currentPrice;
      ok(cp && cp.value === 9.5, '权威价回退为日线末日收盘价（9.5），实际 ' + (cp && cp.value));
      ok(cp && cp.degraded === true, 'currentPrice.degraded=true（如实标记降级）');
      ok(cp && typeof cp.source === 'string' && cp.source.indexOf('降级') !== -1, '来源文案含「降级」：' + (cp && cp.source));
      // [20261111d] 口径统一：conclusion 不再另立一套价格（降级时旧逻辑会退回 dcf.currentPrice / 0）
      const cc = res && res.sections && res.sections.conclusion;
      ok(cc && cc.currentPrice === 9.5,
        'conclusion.currentPrice 恒等于权威价 9.5，前端不再显示 0 / 旧 DCF 价（实际 ' + (cc && cc.currentPrice) + '）');
    }

    /* ══════════════ 链路 2 · §B 降级标记透出（P0-1 价格口径可见性） ══════════════ */
    section('链路2·§B 降级标记随响应透出（sections.currentPrice + sections.dataGaps）');
    {
      const res = await deepAnalysis('600001', '测试股', NO_PRICE_QUOTE, HIST, { force: true });
      const cp = res && res.sections && res.sections.currentPrice;
      const gaps = res && res.sections && res.sections.dataGaps;
      ok(cp && cp.degraded === true, 'sections.currentPrice.degraded===true（前端可据此识别降级口径）');
      ok(Array.isArray(gaps) && gaps.length === 1 && gaps[0].field === 'currentPrice' && gaps[0].level === 'degraded',
        'sections.dataGaps 含 currentPrice 降级项：' + JSON.stringify(gaps));
      ok(gaps[0].note && String(gaps[0].note).indexOf('降级') !== -1,
        'dataGaps.note 带出降级来源文案（前端琥珀警告条 title 的数据源）');
    }

    /* ══════════════ 链路 2 · §C 双重降级不崩溃（quote 无价 + history 为空） ══════════════ */
    section('链路2·§C 双重降级不崩溃（行情不可用且日线为空→不抛，price=0 标记降级）');
    {
      let threw = false, res = null;
      try {
        res = await deepAnalysis('600001', '测试股', NO_PRICE_QUOTE, [], { force: true });
      } catch (e) { threw = true; console.log('   抛错：' + (e && e.message)); }
      ok(!threw, 'quote 无价 + history 空 不抛异常');
      const cp = res && res.sections && res.sections.currentPrice;
      ok(cp && cp.degraded === true, '仍标记 degraded（price=0 兜底）');
      ok(cp && cp.value === 0, '兜底价为 0（实际 ' + (cp && cp.value) + '）');
    }

    /* ══════════════ 链路 2 · §D 缓存与降级共存（降级非粘性：数据源恢复后重算为非降级） ══════════════ */
    section('链路2·§D 缓存与降级共存（降级非粘性：同口径复现降级；恢复有效 quote 后重算为非降级）');
    {
      // §D-1：同一降级口径再次调用，仍如实复现 degraded（确定性、不静默"修复"）
      const r1 = await deepAnalysis('600001', '测试股', NO_PRICE_QUOTE, HIST, { force: true });
      const c1 = r1 && r1.sections && r1.sections.currentPrice;
      ok(c1 && c1.degraded === true && c1.value === 9.5, '§D-1 降级口径复现：degraded 仍=true、price 仍=9.5');

      // §D-2：数据源恢复（传入有效 quote）→ 重新计算为非降级，证明降级不会被永久缓存
      const r2 = await deepAnalysis('600001', '测试股', VALID_QUOTE, HIST, { force: true });
      const c2 = r2 && r2.sections && r2.sections.currentPrice;
      ok(c2 && c2.degraded !== true, '§D-2 恢复有效 quote → 非降级（degraded 不为 true，降级非粘性）');
      ok(c2 && c2.value === 12.3, '§D-2 权威价取自有效 quote（12.3），实际 ' + (c2 && c2.value));
      const cc2 = r2 && r2.sections && r2.sections.conclusion;
      ok(cc2 && cc2.currentPrice === 12.3,
        '§D-2 conclusion.currentPrice 同步为 12.3（降级/恢复两态双价格恒等，不漂移），实际 ' + (cc2 && cc2.currentPrice));
      const g2 = r2 && r2.sections && r2.sections.dataGaps;
      ok(Array.isArray(g2) && g2.length === 0, '§D-2 恢复后 dataGaps 清空：' + JSON.stringify(g2));
    }
  } catch (e) {
    ok(false, '主流程异常：' + (e && e.message));
  } finally {
    try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch (_) { /* 忽略清理异常 */ }
    console.log('\n===== E2E 链路 1（个股复盘）+ 链路 2（deep-analysis 当前价降级）结果：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
  }
})();
