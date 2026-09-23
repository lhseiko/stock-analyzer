// 20260922l 验证：sectorMarketCapHistory 成分股「四级回退链」
// 背景：东财 push2 族 `clist/get` 在本机被对端掐断（socket hang up）→ 板块总市值图表整体消失。
//   修复后回退链：① clist（多主机×2轮）→ ② 数据中心同源报表 RPT_VALUEANALYSIS_DET 按 BOARD_NAME
//   → ③ 侧车成分股清单 → ④ 最近一次成功快照（标注 stale）。
// 运行：node scripts/test_sector_market_cap_fallback.js
//
// 说明：本测试用 require.cache 注入 axios / eastmoneyValuation 的 mock，不发真实请求；
//       使用 BKTESTxx 假板块代码，缓存/侧车文件落在 data/cache/sector_market_cap/ 下并自动清理。
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache', 'sector_market_cap');
const DAYS = 250;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

// ---- mock 状态（每个场景前重置）----
const MOCK = { clist: 'fail', dc: [] };

function installMocks() {
  const axAbs = require.resolve('axios');
  require.cache[axAbs] = {
    id: axAbs, filename: axAbs, loaded: true,
    exports: {
      get: async (url) => {
        if (/\/api\/qt\/clist\/get/.test(url)) {
          if (MOCK.clist === 'fail') throw new Error('socket hang up');
          return { data: { data: { diff: [
            { f12: '600000', f14: '甲公司', f20: 1e11 },
            { f12: '600001', f14: '乙公司', f20: 5e10 },
          ] } } };
        }
        if (/datacenter-web\.eastmoney\.com/.test(url)) {
          return { data: { result: { data: MOCK.dc } } };
        }
        throw new Error('unexpected url: ' + url);
      },
    },
  };
  const evAbs = require.resolve('../lib/eastmoneyValuation');
  require.cache[evAbs] = {
    id: evAbs, filename: evAbs, loaded: true,
    exports: {
      fetchValuationTTM: async (code) => ({
        dailyAll: [
          { date: '2026-09-18', marketCap: 100 + Number(code.slice(-1)) },
          { date: '2026-09-22', marketCap: 110 + Number(code.slice(-1)) },
        ],
      }),
    },
  };
}

function cleanTestFiles() {
  try {
    fs.readdirSync(CACHE_DIR).filter((f) => f.startsWith('BKTEST')).forEach((f) => {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

function seedStaleSnapshot(code) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${code}_${DAYS}_2020-01-01.json`), JSON.stringify({
    success: true, sectorCode: code, sectorName: '历史板块', constituents: 2,
    usedConstituents: 2, capped: false, covered: 2, missing: [],
    dates: ['2020-01-01', '2020-01-02'], total: [1, 2], coverage: [2, 2], unit: '亿元',
    benchmark: null, latestTotal: 2, latestCoverage: 2, latestBenchmark: null,
    date: '2020-01-02', source: 'fixture', fetchedAt: '2020-01-02T00:00:00Z', cached: false,
  }, null, 2), 'utf8');
}

function seedSidecar(code) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, `${code}_${DAYS}.constituents.json`), JSON.stringify({
    source: 'fixture', updatedAt: '2020-01-02T00:00:00Z',
    list: [{ code: '600010', name: '丙公司', marketCap: 1e10 }, { code: '600011', name: '丁公司', marketCap: 9e9 }],
  }, null, 2), 'utf8');
}

(async () => {
  cleanTestFiles();
  installMocks();
  const { getSectorMarketCapHistory } = require('../lib/sectorMarketCapHistory');
  const run = (code, opts) => getSectorMarketCapHistory(code, Object.assign({
    sectorName: 'X板块', benchmark: '', days: DAYS, force: true,
  }, opts || {}));

  console.log('===== 1) clist 可用 → 走 clist（无回退）=====');
  MOCK.clist = 'ok'; MOCK.dc = [];
  const r1 = await run('BKTEST01');
  ok('success=true', r1.success === true, r1.error);
  ok('成分股数 = clist 返回 2', r1.constituents === 2, r1.constituents);
  ok('日期取序列最新（2026-09-22）', r1.date === '2026-09-22', r1.date);
  ok('非 stale', !r1.stale);

  console.log('\n===== 2) clist 失败 + 数据中心同源报表有名单 → 用 DC 名单（当日新鲜）=====');
  MOCK.clist = 'fail';
  MOCK.dc = [
    { SECURITY_CODE: '600100', SECURITY_NAME_ABBR: 'A', TRADE_DATE: '2026-09-22', TOTAL_MARKET_CAP: 3e10 },
    { SECURITY_CODE: '600101', SECURITY_NAME_ABBR: 'B', TRADE_DATE: '2026-09-22', TOTAL_MARKET_CAP: 2e10 },
    { SECURITY_CODE: '600100', SECURITY_NAME_ABBR: 'A', TRADE_DATE: '2026-09-18', TOTAL_MARKET_CAP: 1e10 },
  ];
  const r2 = await run('BKTEST02');
  ok('success=true（未因 clist 失败而整体失败）', r2.success === true, r2.error);
  ok('成分股数 = DC 最新日去重 2 只（旧日行不计）', r2.constituents === 2, r2.constituents);
  ok('日期 = 序列最新（2026-09-22，新鲜）', r2.date === '2026-09-22', r2.date);
  ok('非 stale', !r2.stale);
  ok('成功路径落盘侧车名单（供下次复用）',
    fs.existsSync(path.join(CACHE_DIR, `BKTEST02_${DAYS}.constituents.json`)));

  console.log('\n===== 3) clist + DC 均失败 + 有侧车名单 → 用侧车重建（仍为新鲜序列）=====');
  MOCK.clist = 'fail'; MOCK.dc = [];
  seedSidecar('BKTEST03');
  const r3 = await run('BKTEST03');
  ok('success=true', r3.success === true, r3.error);
  ok('成分股数 = 侧车 2 只', r3.constituents === 2, r3.constituents);
  ok('日期 = 序列最新（2026-09-22，仍新鲜）', r3.date === '2026-09-22', r3.date);
  ok('非 stale（用的是新序列，不是旧快照）', !r3.stale);

  console.log('\n===== 4) 全链失败 + 有旧快照 → 回退快照并标注 stale =====');
  MOCK.clist = 'fail'; MOCK.dc = [];
  seedStaleSnapshot('BKTEST04');
  const r4 = await run('BKTEST04');
  ok('success=true（卡片不再消失）', r4.success === true, r4.error);
  ok('stale=true（明确标注为快照）', r4.stale === true, r4.stale);
  ok('staleReason 带数据源不可用说明', /数据源暂不可用/.test(String(r4.staleReason || '')), r4.staleReason);
  ok('日期 = 旧快照日期（2020-01-02）', r4.date === '2020-01-02', r4.date);
  ok('sectorName 以调用方传入为准（X板块）', r4.sectorName === 'X板块', r4.sectorName);

  console.log('\n===== 5) 全链失败 + 无任何快照 → 明确报错（不静默）=====');
  MOCK.clist = 'fail'; MOCK.dc = [];
  const r5 = await run('BKTEST05');
  ok('success=false', r5.success === false);
  ok('error=CONSTITUENT_FETCH_FAILED', r5.error === 'CONSTITUENT_FETCH_FAILED', r5.error);
  ok('message 带底层原因（socket hang up）', /socket hang up/.test(String(r5.message || '')), r5.message);

  cleanTestFiles();
  console.log('\n===== 结果：' + pass + ' passed / ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); cleanTestFiles(); process.exit(1); });
