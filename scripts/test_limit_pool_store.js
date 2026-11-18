#!/usr/bin/env node
/**
 * test_limit_pool_store.js — 任务卡 #012「每日涨跌停池按交易日落库」专项守卫
 * ============================================================================
 * 覆盖：
 *   1) 表结构 / 五要素 / 交易日校验 / 同交易日幂等跳过
 *   2) 复盘 context 与 getBoardReviewData 两个入口的数值保真（Node 层不重算）
 *   3) 原则 A/C：as_of 只认真实交易日；周末不新增落盘；缺数据不编 0
 *   4) 观察层联动：profitEffect 从 unavailable 转 ready，数值与落盘逐字一致 + 边际
 *   5) 隔离性：不进权重表 / 总分 / 自学习，不改前端，不升版本戳
 *
 * 离线：临时 SQLite + 临时复盘夹具目录，零网络、零生产数据写入。
 * @test-scope: local — 本脚本纯本地临时夹具，run_all_tests.js 的 needsNetwork() 不得跳过。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-limit-pool-'));
const DB_FILE = path.join(TMP, 'stock_analyzer.db');
const REVIEWS = path.join(TMP, 'reviews');
fs.mkdirSync(REVIEWS, { recursive: true });
process.env.SA_DB_PATH = DB_FILE;

const db = require('../lib/db');
const store = require('../lib/limitPoolStore');
const watch = require('../lib/marketEmotionWatch');
const { isTradingDay } = require('../lib/cnTradingCalendar');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

function fixture(date, redRate, avgChgPct, bigDropRate) {
  const doc = {
    schemaVersion: 1,
    reviewDate: date,
    currentVersion: '1',
    updatedAt: '2026-11-13T20:00:00.000Z',
    versions: [{
      version: '1',
      generatedAt: '2026-11-13T20:05:00+08:00',
      context: {
        prevPool: {
          ok: true, asOf: date, source: 'akshare stock_zt_pool_previous_em（东财昨日涨停股今日表现）',
          count: 40, redCount: 16, redRate, avgChgPct, bigDropRate,
          promotion: [{ from: 1, to: 2, base: 20, promoted: 4, rate: 20 }],
          note: '红盘率分母为涨跌幅有效样本',
        },
        ladder: { ok: true, asOf: date, limitUpCount: 40, maxBoards: 4 },
      },
    }],
  };
  fs.writeFileSync(path.join(REVIEWS, date + '.json'), JSON.stringify(doc), 'utf8');
}

(async () => {
  console.log('=== 1) 建表 / 交易日校验 / 五要素 ===');
  ok(store.TABLE === 'limit_pool_daily', '表名固定为 limit_pool_daily');
  store.ensureTable();
  const tables = db.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
  ok(tables.includes('limit_pool_daily'), '表已创建');
  ok(!isTradingDay('2026-11-15'), '2026-11-15 是周日（非交易日）');

  const bad = store.saveDailyPool({ tradeDate: '2026-11-15', payload: { redRate: 10 } });
  ok(bad.action === 'rejected' && /非交易日/.test(bad.reason), '非交易日拒绝落盘（原则 A）', JSON.stringify(bad));
  const badFmt = store.saveDailyPool({ tradeDate: '20261113', payload: { redRate: 10 } });
  ok(badFmt.action === 'rejected' && /YYYY-MM-DD/.test(badFmt.reason), '日期格式严格校验');

  fixture('2026-11-12', 37.65, -0.87, 27.06);
  fixture('2026-11-13', 37.84, -1.54, 43.24);

  const r1 = store.captureFromReview('2026-11-13', { reviewsDir: REVIEWS });
  const r2 = store.captureFromReview('2026-11-13', { reviewsDir: REVIEWS });
  ok(r1.action === 'created' && r2.action === 'skipped', '同交易日首次 created、重跑 skipped（生成 0 / 跳过 1）', `${r1.action}/${r2.action}`);
  ok(/不覆盖/.test(r2.reason || ''), '跳过原因写明不覆盖真实读数');
  const r3 = store.captureFromReview('2026-11-12', { reviewsDir: REVIEWS });
  ok(r3.action === 'created', '前一交易日可独立落盘', JSON.stringify(r3));

  console.log('\n=== 2) 数值保真 / 五要素 ===');
  const rec = store.getDailyPool('2026-11-13');
  ok(rec && rec.tradeDate === '2026-11-13' && rec.asOf === '2026-11-13', 'as_of = 真实交易日，不是运行日');
  ok(rec.redRate === 37.84 && rec.avgChgPct === -1.54 && rec.bigDropRate === 43.24,
    '红盘率 / 平均涨幅 / 大面率逐字取复盘统计，Node 层不重算', JSON.stringify(rec && [rec.redRate, rec.avgChgPct, rec.bigDropRate]));
  ok(!!(rec.source && rec.fetchedAt && rec.method && rec.asOf && rec.completeness),
    '五要素齐备（数值 / 来源 / 获取时间 / 数据日 / 口径 / 完整性）');
  ok(/复盘/.test(rec.source) && /不重算/.test(rec.method), '来源与口径如实标注复用复盘、不重算');
  ok(rec.backfilled === false, '正常调度落盘不标回溯补录');

  const raw = {
    ok: true,
    source: 'akshare（东方财富涨停股池 / 炸板池 / 跌停池）',
    fetchedAt: '2026-11-10T15:40:00',
    prevPool: { ok: true, asOf: '2026-11-10', count: 55, redRate: 65.62, avgChgPct: 1.23, bigDropRate: 10.11, promotion: null, note: '' },
    ladder: { ok: true, asOf: '2026-11-10', limitUpCount: 55, maxBoards: 5 },
  };
  const built = store.buildFromBoardReview('2026-11-10', raw, { backfilled: true });
  const saved = store.saveDailyPool(Object.assign({ tradeDate: '2026-11-10' }, built.row));
  ok(saved.action === 'created', '联网入口可落盘');
  const rec2 = store.getDailyPool('2026-11-10');
  ok(rec2.redRate === 65.62 && rec2.backfilled === true, '联网入口数值保真且标回溯补录');
  const badRaw = store.buildFromBoardReview('2026-11-09', { ok: false }, {});
  ok(!badRaw.ok && /ok=false/.test(badRaw.reason), '取数 ok=false 不落失败快照');
  const noPrev = store.buildFromBoardReview('2026-11-09', { ok: true, prevPool: { ok: false } }, {});
  ok(!noPrev.ok && /不编 0/.test(noPrev.reason), '缺失池标不可用、不编 0', noPrev.reason);

  console.log('\n=== 3) 序列与原则 A ===');
  const s = store.getProfitEffectSeries('2026-11-13');
  ok(s.length === 3 && s[0].tradeDate === '2026-11-10' && s[2].tradeDate === '2026-11-13',
    '序列按交易日升序，只含有真实读数的日', s.map(x => x.tradeDate).join(','));
  const sWeekend = store.getProfitEffectSeries('2026-11-15');
  ok(sWeekend.length === 3 && sWeekend[2].tradeDate === '2026-11-13',
    '周日查询沿用最近交易日 2026-11-13，不新增、不归零');
  const before = store.getProfitEffectSeries('2026-11-12');
  ok(before.length === 2 && before[1].tradeDate === '2026-11-12', '按基准日截断，杜绝未来数据');
  const missing = store.captureFromReview('2026-11-11', { reviewsDir: REVIEWS });
  ok(missing.action === 'unavailable' && /缺失/.test(missing.reason), '无复盘文件时如实 unavailable，不编 0', JSON.stringify(missing));

  console.log('\n=== 4) 观察层联动（profitEffect 转 ready） ===');
  const emo = { baselineDate: '2026-11-13' };
  const bars = [];
  let p = 3000;
  for (let i = 0; i < 40; i++) {
    const d = new Date(2026, 8, 1 + i);
    const ds = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
    p = p * (1 + Math.sin(i * 1.7) * 0.008);
    bars.push({ date: ds, close: Math.round(p * 100) / 100 });
  }
  const input = {
    data: { index: { bars } },
    emo,
    opts: {
      dataDir: TMP,
      today: '2026-11-15', // 运行日周日，验证不拿运行日冒充数据日
      limitPoolStore: store,
    },
  };
  // [20261116c] 赚钱效应已从观察层并入「市场宽度 · 赚钱效应」因子（子权重 30%，参与打分）
  const out = watch.buildWatchIndicators(input);
  ok(out.items.length === 4, '观察层固定 4 项（赚钱效应已移出）', String(out.items.length));
  ok(!out.items.some(x => x.key === 'profitEffect'), '观察层不再展示赚钱效应（避免与因子卡重复）');
  const MODEL0 = src('lib/marketEmotionModel.js');
  ok(/子权重 30%/.test(MODEL0) && MODEL0.includes('limitPoolStore'),
    '模型已接入涨跌停池：赚钱效应用于市场宽度因子（宽度70/赚钱效应30）');

  console.log('\n=== 5) 隔离性与协同进化 ===');
  const MODEL = src('lib/marketEmotionModel.js');
  const WATCH = src('lib/marketEmotionWatch.js');
  const SERVER = src('server.js');
  const DOC = src('docs/logic/home-01-market-emotion.md');
  const COMMON = src('docs/logic/common-01-data-source.md');
  ok(MODEL.includes("require('./limitPoolStore')") && !MODEL.includes('saveDailyPool'),
    '主模型只读落库层赚钱效应序列（20261116c 纳入市场宽度因子打分），不写库');
  ok(!WATCH.includes('BASE_WEIGHTS') && !WATCH.includes('learnWeights') && !WATCH.includes('totalScore'),
    '观察层不引用权重表 / 自学习 / 总分');
  ok(!WATCH.includes('fetch(') && !WATCH.includes('axios'), '观察层零网络（联网只在补录脚本）');
  ok(SERVER.includes("require('./lib/limitPoolStore')") && SERVER.includes('limitPoolStore.captureFromReview(today'),
    '15:35 复盘主跑后复用 context 落盘');
  ok(fs.existsSync(path.join(ROOT, 'scripts', 'backfill_limit_pool.js')), '补录脚本存在');
  ok(/limit_pool_daily/.test(DOC) && /任务卡 #012/.test(DOC), '逻辑说明文档已登记新数据源');
  ok(/涨跌停池按交易日真实落盘/.test(COMMON), '数据基准原则补入 D 条');
  const ver = SERVER.match(/^const APP_VERSION = '(\d{8}[a-z])';/m);
  ok(ver && ver[1] === '20261118a', '前端零改动，版本戳仍 20261118a', ver && ver[1]);

  db.closeDb();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('守卫异常：', e && e.stack || e);
  try { db.closeDb(); } catch (_) {}
  process.exit(1);
});
