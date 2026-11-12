/**
 * scripts/test_fallback_chain_e2e.js — P2-1 批次 2 链路 5：数据源降级链 E2E
 * ------------------------------------------------------------------------------
 * @test-scope: local —— 零网络。仅替换底层 axios.get（require.cache），不触 3005、不打真实接口。
 *
 * 依据：docs/整改方案-20261110.md 阶段 3 P2-1「数据源降级链」；用户指令（2026-11-11）：
 *   ① 腾讯挂掉后是否切到东财/新浪；② source 是否如实标注（数据诚实性）；
 *   ③ 降级数据单位必须与腾讯口径对齐（防静默 100 倍错位）；④ 全挂时明确报错/空态，绝不伪造 0 价格。
 * 桩边界（用户指定）：不桩 getQuote/getHistory 本身，只桩其底层 axios.get，让真实降级逻辑执行。
 *
 * 实测依据（2026-11-11 真实探针，非估算）：
 *   - 腾讯 quote 601318 volume=49,827,400 股；腾讯日K末根=498,274 手 → quote=股、日K=手，比值恰 100。
 *   - 新浪日K（CN_MarketData.getKLineData scale=240）末根 volume=49,827,393 → 单位为「股」，
 *     原实现直接透传 = 新浪兜底命中时量能分析被静默虚增 100 倍（B2 级缺陷，本链路修复）。
 *
 * 修复内容（lib/stockData.js，最小隔离）：
 *   - fetchSinaHistory volume ÷100 归一为「手」（与东财 f56 / 腾讯归一后同口径）；
 *   - 腾讯/东财/新浪四个日K通道返回数组附加 .meta={source, volumeUnit}（沿用 getHistoryPeriod 先例）。
 *
 * 运行：node scripts/test_fallback_chain_e2e.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const axiosPath = require.resolve('axios');
const realAxios = require(axiosPath);

// ── 受控 axios：按 URL 域名分流，模拟「腾讯超时 / 东财 500 / 新浪 500」──────────
const mock = { calls: [], eastmoney: 'ok', sina: 'ok' };
// 东财 kline 字段序：date,open,close,high,low,volume(手),amount,amplitude,changePct,change,turnover
// 注意 ≥6 根：fetchEastmoneyHistoryRetry / 新浪兜底均有「length > 5 才算有效数据」门槛
const EM_KLINES = [
  '2026-11-02,53.60,53.75,53.90,53.50,386020,2072000000,0.74,0.19,0.10,0.29',
  '2026-11-03,53.75,53.62,53.95,53.55,401150,2154000000,0.74,-0.24,-0.13,0.30',
  '2026-11-04,53.62,53.88,54.00,53.60,398440,2141000000,0.75,0.48,0.26,0.30',
  '2026-11-05,53.88,54.35,54.40,53.80,512330,2773000000,1.11,0.87,0.47,0.39',
  '2026-11-06,54.35,54.50,54.60,54.20,556205,3020000000,0.74,0.28,0.15,0.42',
  '2026-11-07,54.50,53.90,54.55,53.80,420100,2269000000,1.38,-1.10,-0.60,0.32',
  '2026-11-10,54.00,54.10,54.40,53.90,427287,2311000000,0.93,0.37,0.20,0.33',
  '2026-11-11,54.10,53.41,54.30,53.41,498274,2663000000,1.65,-1.28,-0.69,0.38',
];
// 新浪日K：volume 单位 = 股（真实探针实测口径）；49,827,400 股应产出 498,274 手（≥6 根，同上门槛）
const SINA_BARS = [
  { day: '2026-11-02', open: '53.60', close: '53.75', high: '53.90', low: '53.50', volume: '38602000' },
  { day: '2026-11-03', open: '53.75', close: '53.62', high: '53.95', low: '53.55', volume: '40115000' },
  { day: '2026-11-04', open: '53.62', close: '53.88', high: '54.00', low: '53.60', volume: '39844000' },
  { day: '2026-11-05', open: '53.88', close: '54.35', high: '54.40', low: '53.80', volume: '51233000' },
  { day: '2026-11-06', open: '54.35', close: '54.50', high: '54.60', low: '54.20', volume: '55620500' },
  { day: '2026-11-07', open: '54.50', close: '53.90', high: '54.55', low: '53.80', volume: '42010000' },
  { day: '2026-11-10', open: '54.00', close: '54.10', high: '54.40', low: '53.90', volume: '42728746' },
  { day: '2026-11-11', open: '54.10', close: '53.41', high: '54.30', low: '53.41', volume: '49827400' },
];
const mkRes = data => ({ status: 200, data });

const wrapped = function axiosStub(url, cfg) { return wrapped.get(url, cfg); };
Object.assign(wrapped, realAxios);
wrapped.get = async function (url) {
  const u = String(url);
  mock.calls.push(u.slice(0, 100));
  if (/gtimg\.cn/.test(u)) {
    const e = new Error('mock: 腾讯接口超时（ETIMEDOUT）'); e.code = 'ETIMEDOUT'; throw e;
  }
  if (/eastmoney\.com/.test(u)) {
    if (mock.eastmoney === 'fail') { const e = new Error('mock: 东财 500'); e.response = { status: 500 }; throw e; }
    if (mock.eastmoney === 'empty') return mkRes({ data: { klines: [] } });
    // axios resp.data 即响应体 = { data: { klines } }（fetchEastmoneyHistory 读 resp.data?.data?.klines）
    return mkRes({ data: { klines: EM_KLINES } });
  }
  if (/quotes\.sina\.cn/.test(u)) {
    if (mock.sina === 'fail') { const e = new Error('mock: 新浪 500'); e.response = { status: 500 }; throw e; }
    return mkRes(SINA_BARS);
  }
  throw new Error('mock: 未声明端点 ' + u.slice(0, 80));
};
wrapped.post = realAxios.post;
require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: wrapped };

const sd = require(path.join(ROOT, 'lib', 'stockData.js'));
const { getQuoteHub } = require(path.join(ROOT, 'lib', 'quoteHub.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
function reset(em, sina) {
  mock.calls = []; mock.eastmoney = em; mock.sina = sina;
}

(async () => {
  try {
    section('§0 受控接线自检');
    ok(typeof sd.getHistory === 'function' && typeof sd.getQuote === 'function',
      '真实 getQuote / getHistory 参与执行（未被桩替换）');
    ok(typeof wrapped.get === 'function' && mock.calls.length === 0, '底层 axios.get 已被受控桩替换');

    /* ════ §A 腾讯挂 → 东财接管（真实降级顺序） ════ */
    section('§A 腾讯超时 → 东财接管，source 如实标注');
    reset('ok', 'ok');
    const h1 = await sd.getHistory('601318', '3m');
    ok(mock.calls.some(u => /gtimg\.cn/.test(u)), '先尝试腾讯（降级顺序第一步真实发生）');
    ok(mock.calls.some(u => /push2his\.eastmoney\.com/.test(u)), '腾讯挂后转东财');
    ok(!mock.calls.some(u => /quotes\.sina\.cn/.test(u)), '东财命中后不再请求新浪（顺序正确，不浪费兜底）');
    ok(Array.isArray(h1) && h1.length === 8, '东财接管返回 8 根日K');
    ok(h1.meta && /东财/.test(String(h1.meta.source)), 'meta.source 如实标注「东财」（数据诚实性），实际 ' + JSON.stringify(h1.meta || null));
    ok(h1[h1.length - 1] && h1[h1.length - 1].volume === 498274, '东财量纲为「手」，与腾讯日K口径直接对齐（f56），实际 ' + (h1[h1.length - 1] || {}).volume);

    /* ════ §B 腾讯+东财全挂 → 新浪接管 + 100 倍量纲修复 ════ */
    section('§B 腾讯+东财全挂 → 新浪接管，量纲归一手（100 倍错位消除）');
    reset('fail', 'ok');
    const h2 = await sd.getHistory('601318', '3m');
    ok(Array.isArray(h2) && h2.length === 8, '新浪接管返回 8 根日K');
    ok(h2.meta && /新浪/.test(String(h2.meta.source)), 'meta.source 如实标注「新浪」，实际 ' + JSON.stringify(h2.meta || null));
    ok(h2.meta && h2.meta.volumeUnit === '手', 'meta.volumeUnit 如实标注「手」');
    ok(Math.abs(h2[h2.length - 1].volume - 498274) < 0.01,
      '新浪 49,827,400 股 ÷100 = 498,274 手（修复生效；修复前会透传 49,827,400，量能虚增 100 倍），实际 ' + h2[h2.length - 1].volume);

    /* ════ §B2 跨源口径一致性（同股数输入 → 同手数产出） ════ */
    section('§B2 同日同股数：东财主源与新浪兜底产出完全一致');
    ok(h1[h1.length - 1].volume === h2[h2.length - 1].volume,
      '2026-11-11 同为 49,827,400 股：东财 ' + h1[h1.length - 1].volume + ' 手 = 新浪 ' + h2[h2.length - 1].volume + ' 手（无 100 倍错位）');

    /* ════ §C 三源全挂 → 明确空态，绝不伪造 0 价格 ════ */
    section('§C 全部数据源 500：明确空态与报错');
    reset('fail', 'fail');
    const h3 = await sd.getHistory('601318', '3m');
    ok(Array.isArray(h3) && h3.length === 0, '三源全挂：getHistory 返回空数组（明确空态）');
    ok(mock.calls.filter(u => /push2his\.eastmoney\.com/.test(u)).length === 3,
      '东财通道按重试策略共试 3 次（1 主 + 2 retry），实际 ' + mock.calls.filter(u => /push2his\.eastmoney\.com/.test(u)).length);
    const hub = await getQuoteHub('601318');
    ok(hub && hub.ok === false && !!hub.error, '行情全挂：getQuoteHub 返回 ok=false 并给出 error，实际 ' + JSON.stringify(hub && hub.error));
    ok(!hub.latest && hub.price == null && !hub.analysis,
      '绝不伪造 0 价格：无 latest / price / analysis（规则：无有效数据不得分析）');
    ok(/未能获取行情数据/.test(String(hub.note || '')), '空态 note 如实告知用户，实际 ' + JSON.stringify(hub && hub.note));

    /* ════ §D 静态守卫：修复锁定 + 降级顺序 ════ */
    section('§D 静态守卫（防修复被回退）');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'stockData.js'), 'utf8');
    ok(/volume:\s*\(parseFloat\(d\.volume\)\s*\|\|\s*0\)\s*\/\s*100,/.test(src),
      '新浪日K volume ÷100 归一手已固化在代码中');
    ok(/tencentVolumeUnitIsShares/.test(src), '科创板「股→手」归一逻辑保留（20261019b 契约不回归）');
    ok((src.match(/\.meta\s*=\s*\{\s*source:/g) || []).length >= 4,
      '腾讯/东财/新浪四个日K通道均带 meta.source 标注，实际 ' + (src.match(/\.meta\s*=\s*\{\s*source:/g) || []).length + ' 处');
    const iT = src.indexOf('fetchTencentHistory(info.tencentCode, count)');
    const iE = src.indexOf('const emHistory = await fetchEastmoneyHistoryRetry(input, count);');
    const iS = src.indexOf('fetchSinaHistory(info.tencentCode, count)');
    ok(iT >= 0 && iE > iT && iS > iE, 'getHistory 三级降级顺序：腾讯 → 东财 → 新浪');

    /* ════ §E 全量 runner 分类自检（防假绿） ════ */
    section('§E run_all_tests 分类器：本 E2E 必须进 quick 集');
    {
      const runnerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'run_all_tests.js'), 'utf8');
      const selfSrc = fs.readFileSync(__filename, 'utf8');
      const m = runnerSrc.match(/function needsNetwork\(src\) \{[\s\S]*?\n\}/);
      let classified = null;
      try {
        const box = {};
        vm.createContext(box);
        vm.runInContext((m ? m[0] : '') + '\nthis.result = needsNetwork(' + JSON.stringify(selfSrc) + ');', box);
        classified = box.result;
      } catch (e) { classified = 'ERR: ' + (e && e.message); }
      ok(classified === false, '分类器判定 net=false（quick 模式真跑，非静默跳过），实际 ' + classified);
    }
  } catch (e) {
    ok(false, '主流程异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
  } finally {
    console.log('\n===== 链路 5 数据源降级链 E2E：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
  }
})();
