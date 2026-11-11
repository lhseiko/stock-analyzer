#!/usr/bin/env node
/**
 * scripts/test_etf_flow_holiday_guard.js — 20261105b 守卫
 * 用户指令：节假日/假后第一天只读取最后一次更新的数据，避免取数报错。
 * 事故背景：11-01（周日）重采把 10-30 已定稿快照覆盖（shareDate 被 T+1 采集日语义前推一天），
 * 逐日表 10-30 出现假 Δ=0、台账把周四增量重复计入。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}
const write = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj), 'utf8');

// 独立临时目录夹具（不碰生产 data/）；snapPath：快照直接在根目录（与生产 data/etf-flow/ 同构）
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-flow-test-'));
  const pcf = path.join(dir, 'pcf-cache');
  fs.mkdirSync(pcf, { recursive: true });
  return { dir, pcf, snaps: dir };
}

(async () => {
  console.log('=== §1 collect 跨日重采守卫（节假日不覆盖已定稿快照）===');
  {
    const fx = makeFixture();
    process.env.SA_ETF_FLOW_DIR = fx.dir;
    delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
    const etfFlow = require(path.join(ROOT, 'lib/etfFlow.js'));

    // 快照：10-30（周五）已定稿，shareDate=20261029（周五晚采集的正确语义）
    const snap = {
      date: '20261030', shareDate: '20261029', settled: true, partial: false,
      etfs: [{ code: '510300', name: '沪深300ETF', group: 'hs300', groupLabel: '沪深300', unit: 1000000, shares: 32729887700, comps: [] }],
    };
    write(path.join(fx.snaps, '20261030.json'), snap);

    // PCF 缓存：周日（采集日）返回的是周五清单 → tradeDate=20261030（历史日期）
    const pcf = { date: '20261030', byCode: { '510300': { code: '510300', name: '沪深300ETF', tradeDate: '20261030', nav: 4.0, unit: 1000000, comps: [] } } };
    write(path.join(fx.pcf, '20261102.json'), pcf);

    // 外呼全走 collect 的 opts 注入口（20261105b 测试 seam），不做真实外呼
    let sharesFetched = false;
    const baseOpts = () => ({
      cacheKey: '20261102',
      // [20261109a] 本夹具只注入 1 只 ETF，专测「跨日重采守卫」；名单完整性由
      // test_etf_universe_integrity.js 单独覆盖，故显式声明夹具自担基准。
      assumeCompleteUniverse: true,
      universe: [{ code: '510300', name: '沪深300ETF', group: 'hs300', groupLabel: '沪深300' }],
      fetchPcf: async () => ({ __err: '测试内不应外呼（缓存应命中）' }),
      fetchShares: async () => { sharesFetched = true; return { '510300': 38866987700 }; },
    });

    const r = await etfFlow.collect(baseOpts());
    const snapAfter = JSON.parse(fs.readFileSync(path.join(fx.snaps, '20261030.json'), 'utf8'));
    ok(r.ok === true, 'collect 正常返回（节假日读旧快照不算错误）');
    ok(sharesFetched === false, '守卫在抓份额之前生效（省一次外呼）');
    ok(snapAfter.shareDate === '20261029', '原快照保留：shareDate 仍为 20261029（不被前推成 20261030）');
    ok(snapAfter.etfs[0].shares === 32729887700, '原快照份额值未被覆盖');
    ok((r.gaps || []).join('').indexOf('保留原快照') >= 0, 'gaps 如实标注「保留原快照」');

    // partial（残缺）快照不拦截：重采自愈通道保留
    write(path.join(fx.snaps, '20261030.json'), Object.assign({}, snap, { settled: false, partial: true, gaps: ['份额缺失 1 只'] }));
    sharesFetched = false;
    const r2 = await etfFlow.collect(baseOpts());
    const snapAfter2 = JSON.parse(fs.readFileSync(path.join(fx.snaps, '20261030.json'), 'utf8'));
    ok(sharesFetched === true && r2.ok === true, 'partial 快照走重采通道');
    ok(snapAfter2.shareDate === '20261030' && snapAfter2.settled === true, 'partial 快照被重采自愈（shareDate=采集日语义的 20261030）');

    // 无历史快照 → 跨日补采通道保留（20261026a）
    fs.unlinkSync(path.join(fx.snaps, '20261030.json'));
    const r3 = await etfFlow.collect(baseOpts());
    ok(r3.ok === true && fs.existsSync(path.join(fx.snaps, '20261030.json')), '无历史快照时跨日补采正常落盘');
    delete process.env.SA_ETF_FLOW_DIR;
    delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
  }

  console.log('=== §2 最近一次成功数据兜底（withLastFactorFallback）===');
  {
    const fx = makeFixture();
    process.env.SA_ETF_FLOW_DIR = fx.dir;
    delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
    const etfFlow = require(path.join(ROOT, 'lib/etfFlow.js'));
    // 手写一份「最近一次成功数据」（字段与 saveLastSuccessfulFactor 一致）
    write(path.join(fx.dir, 'last-factor.json'), {
      date: '20261030',
      factor: { score: 0.76, degraded: false, value: '净申购 362.39 亿 · 23 只净申购 / 2 只净赎回', detail: '…', totalNet: 3.6239e10, settleStatus: 'settled' },
      savedAt: '2026-11-01T12:00:00.000Z',
    });
    // 夹具无快照/PCF → selectUniverse 真实外呼可能成功 → 但 PCF 抓取会失败（无网/或成功后无份额）……
    // 为确定性：宇宙为空场景不可控 → 直接对 getEtfFlow 断言兜底行为（任何 ok:false/无因子结果都应被兜底）
    const res = await etfFlow.getEtfFlow({ refresh: true });
    if (res.factor && res.factor.degraded === false && !res.factor.fallback) {
      // 真实外呼意外全成功（有网）→ 视为正常路径，验证「有效因子不兜底」即可
      ok(true, '真实外呼成功 → 有效因子不兜底（正常路径）');
    } else {
      ok(res.ok === true, `取数失败时兜底为 ok（实际 ok=${res.ok}）`);
      ok(res.date === '20261030', `兜底数据日期=最近成功日 20261030（实际 ${res.date}）`);
      ok(res.factor && res.factor.fallback === true, '兜底因子带 fallback 标记');
      ok(/节假日\/取数兜底/.test((res.factor && res.factor.reason) || ''), '兜底 reason 显式标注');
    }
    ok(etfFlow.getLastSuccessfulFactor().date === '20261030', 'getLastSuccessfulFactor 可读');
    delete process.env.SA_ETF_FLOW_DIR;
    delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
  }

  console.log('=== §3 接线守卫 ===');
  {
    const src = fs.readFileSync(path.join(ROOT, 'lib/etfFlow.js'), 'utf8');
    ok(src.indexOf('跨日重采守卫') >= 0, 'etfFlow.js 含跨日重采守卫');
    ok(src.indexOf('getLastSuccessfulFactor') >= 0 && src.indexOf('LAST_FACTOR_FILE') >= 0, 'etfFlow.js 含最近成功数据兜底');
    const serverJs = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(serverJs.indexOf('etfFlow.getLastSuccessfulFactor()') >= 0, 'server.js 情绪注入点含兜底回读');
    const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    ok(appJs.indexOf('f.fallback') >= 0, 'app.js 情绪卡展示兜底标注');
    const t1 = fs.readFileSync(path.join(ROOT, 'scripts/test_metric_analysis_vote.js'), 'utf8');
    const t2 = fs.readFileSync(path.join(ROOT, 'scripts/test_consistency_audit.js'), 'utf8');
    ok(t1.indexOf('20261111d') >= 0 && t2.indexOf('20261111d') >= 0, '版本断言已同步 20261111d');
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(/const APP_VERSION = '20261111d'/.test(server), "APP_VERSION = '20261111d'");
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e && e.message); process.exit(1); });
