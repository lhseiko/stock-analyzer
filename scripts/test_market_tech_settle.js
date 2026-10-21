/**
 * 大盘技术分析 · 准确率结算回归（零网络、零磁盘污染）
 * --------------------------------------------------------------
 * 运行：node scripts/test_market_tech_settle.js
 * 背景（用户 2026-10-21 报障「为什么老是出现无法结算准确率的问题」，截图：过期未结算 2 条）：
 *   历史记录里的 targetDate 由旧口径生成（只跳周末、不跳法定节假日），落在中秋 09-25 / 国庆 10-01，
 *   而 K 线里永远没有这两天 → settleRecord 找不到 K 线就 return，永不结算，同时被永久计入 overdueCount。
 * 覆盖（20261021c 修复）：
 *   [1] 存储 targetDate 是节假日 → 不采信，按交易日历重算并结算（targetDateFixed 留痕）
 *   [2] 目标日无 K 线但 5 天内无缺口邻日 → 用其后首个交易日兜底（shortTargetFallback 留痕）
 *   [3] 缺口超过容忍天数 → 拒绝结算并写 settleError（绝不把 20 天后的 K 线当"次日"）
 *   [4] 正常目标日 → 正常结算，不产生兜底字段
 *   [5] 当日未收盘（目标日=今天且未收盘）→ 不结算
 *   [6] settleAll 整批只拉一次 K 线
 *   [7] settleIfDue 节流：3 分钟内第二次调用 skipped
 *   [8] overdueCount 用「有效目标日」，不把节假日目标日算成过期
 *   [9] 接线守卫：records 路由读取即结算；修复口径在源码里存在
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

const m = require('../lib/marketTechJudgment');

// ---------- 虚拟目录：把 fs 的读写重定向到内存，绝不碰 data/market-tech ----------
function withVirtualDir(files, fn) {
  const readFile = fs.readFileSync, writeFile = fs.writeFileSync, exists = fs.existsSync,
    mkdir = fs.mkdirSync, readdir = fs.readdirSync;
  fs.existsSync = () => true;
  fs.mkdirSync = () => {};
  fs.readdirSync = () => Object.keys(files);
  fs.readFileSync = (p) => {
    const k = String(p).replace(/\\/g, '/').split('/').pop();
    if (files[k] === undefined) throw new Error('ENOENT ' + k);
    return JSON.stringify(files[k]);
  };
  fs.writeFileSync = (p, data) => {
    const k = String(p).replace(/\\/g, '/').split('/').pop();
    files[k] = JSON.parse(data);
  };
  try { return fn(files); }
  finally {
    fs.readFileSync = readFile; fs.writeFileSync = writeFile; fs.existsSync = exists;
    fs.mkdirSync = mkdir; fs.readdirSync = readdir;
  }
}

// ---------- 合成日K：上证指数（只用于结算，字段只需 date/close） ----------
function mkBars(pairs) {
  return pairs.map(([date, close]) => ({ date, open: close, close, high: close, low: close, volume: 1e8 }));
}
// 2026-09-24(四) → 09-25 中秋休市 → 09-28(一)；2026-09-30 → 10-01~10-07 国庆 → 10-08
const BARS = mkBars([
  ['2026-09-23', 3800.00],
  ['2026-09-24', 3810.00],
  ['2026-09-28', 3746.37],   // -1.67%
  ['2026-09-29', 3740.00],
  ['2026-09-30', 3750.00],
  ['2026-10-08', 3720.38],   // -0.79%
  ['2026-10-19', 3760.00],
  ['2026-10-20', 3765.00],
]);

function mkRec(over) {
  return Object.assign({
    baseDate: '2026-09-24',
    targetDate: '2026-09-25',        // 旧口径写出的节假日目标日（真实用例）
    baseClose: 3810.00,
    shortRaw: '看空', shortDir: '跌', shortVerdict: '看跌',
    midRaw: '看空', midDir: '跌',
    fusionSignal: '偏空', fusionDir: '跌', confidence: '高',
    shortSettled: false, midSettled: false, settleError: null,
  }, over || {});
}

(async () => {
  m.__setFetchDaily(async () => BARS);

  console.log('\n[1] 存储 targetDate 落在节假日（中秋 09-25）→ 按交易日历重算为 09-28');
  {
    const files = { '2026-09-24.json': mkRec() };
    await withVirtualDir(files, () => m.settleRecord(files['2026-09-24.json'], BARS));
    const r = files['2026-09-24.json'];
    eq(r.targetDate, '2026-09-28', '目标日被纠正为节后首个交易日');
    eq(r.targetDateFixed && r.targetDateFixed.from, '2026-09-25', '留痕：原目标日 09-25');
    eq(r.targetDateFixed && r.targetDateFixed.to, '2026-09-28', '留痕：修正为 09-28');
    ok(r.shortSettled, '已结算（不再永久挂在待验证）');
    eq(r.shortActualDate, '2026-09-28', '记录实际结算日');
    eq(r.shortActualChgPct, -1.67, '实际涨跌 -1.67%');
    eq(r.shortCorrect, true, '预判「跌」命中');

    const files2 = { '2026-09-30.json': mkRec({ baseDate: '2026-09-30', targetDate: '2026-10-01', baseClose: 3750.00 }) };
    await withVirtualDir(files2, () => m.settleRecord(files2['2026-09-30.json'], BARS));
    const r2 = files2['2026-09-30.json'];
    eq(r2.targetDate, '2026-10-08', '国庆：10-01 → 10-08');
    eq(r2.shortCorrect, true, '预判「跌」命中（-0.79%）');
  }

  console.log('\n[2] 目标日是交易日但无 K 线（数据缺口 3 天）→ 用其后首个交易日兜底');
  {
    const bars = mkBars([['2026-09-23', 3800], ['2026-09-24', 3810], ['2026-10-01', 3700]]);
    const files = { '2026-09-24.json': mkRec({ targetDate: '2026-09-28' }) };
    await withVirtualDir(files, () => m.settleRecord(files['2026-09-24.json'], bars));
    const r = files['2026-09-24.json'];
    ok(r.shortSettled, '在容忍天数内 → 结算');
    eq(r.shortActualDate, '2026-10-01', '用其后首个交易日结算');
    eq(r.shortTargetFallback && r.shortTargetFallback.gapDays, 3, '留痕：缺口 3 天');
  }

  console.log('\n[3] 缺口超出容忍天数 → 拒绝结算并写明原因（绝不改口径）');
  {
    const bars = mkBars([['2026-09-23', 3800], ['2026-09-24', 3810], ['2026-10-21', 3600]]);
    const files = { '2026-09-24.json': mkRec({ targetDate: '2026-09-28' }) };
    await withVirtualDir(files, () => m.settleRecord(files['2026-09-24.json'], bars));
    const r = files['2026-09-24.json'];
    ok(!r.shortSettled, `缺口 ${r.shortTargetFallback ? '?' : ''}超出 ${m.TARGET_FALLBACK_MAX_DAYS} 天 → 不结算`);
    ok(/超出容忍/.test(r.settleError || ''), 'settleError 写明超出容忍天数');
  }

  console.log('\n[4] 正常目标日 → 正常结算，不产生兜底留痕');
  {
    const files = { '2026-09-23.json': mkRec({ baseDate: '2026-09-23', targetDate: '2026-09-24', baseClose: 3800.00 }) };
    await withVirtualDir(files, () => m.settleRecord(files['2026-09-23.json'], BARS));
    const r = files['2026-09-23.json'];
    ok(r.shortSettled, '已结算');
    ok(!r.targetDateFixed, '无需纠正目标日');
    ok(!r.shortTargetFallback, '未走兜底');
    eq(r.shortActualChgPct, 0.26, '涨跌 +0.26%（3810/3800）');
    eq(r.shortCorrect, false, '预判「跌」未中');
  }

  console.log('\n[5] 目标日=今天且尚未收盘 → 不结算（数据未定）');
  {
    const today = require('../lib/localDate').localDate();
    const closed = require('../lib/sameDayJudgment').marketClosed(new Date());
    if (closed) {
      console.log('  - 当前已收盘，跳过该用例（无法构造"未收盘"现场）');
    } else {
      const bars = mkBars([[today, 3700]]);
      const files = { 'x.json': mkRec({ baseDate: today, targetDate: today, baseClose: 3800 }) };
      await withVirtualDir(files, () => m.settleRecord(files['x.json'], bars));
      ok(!files['x.json'].shortSettled, '当日未收盘 → 保持待验证');
    }
  }

  console.log('\n[6] settleAll：整批只拉一次 K 线（原来每条记录各拉一次）');
  {
    let calls = 0;
    m.__setFetchDaily(async () => { calls++; return BARS; });
    const files = {
      '2026-09-24.json': mkRec(),
      '2026-09-30.json': mkRec({ baseDate: '2026-09-30', targetDate: '2026-10-01', baseClose: 3750.00 }),
      '2026-09-23.json': mkRec({ baseDate: '2026-09-23', targetDate: '2026-09-24', baseClose: 3800.00 }),
    };
    const r = await withVirtualDir(files, () => m.settleAll());
    eq(calls, 1, '3 条记录 → 仅 1 次 K 线请求');
    eq(r.changed, 3, '3 条全部新结算');
    eq(r.accuracy.short.overdueCount, 0, '结算后过期未结算 = 0');
  }

  console.log('\n[7] settleIfDue：3 分钟内第二次调用直接 skipped（不重复打网络）');
  {
    let calls = 0;
    m.__setFetchDaily(async () => { calls++; return BARS; });
    const files = { '2026-09-24.json': mkRec() };
    await withVirtualDir(files, () => m.settleIfDue({ force: true }));
    const second = await withVirtualDir(files, () => m.settleIfDue());
    ok(second.skipped, '第二次调用被节流');
    eq(calls, 1, '只拉了 1 次 K 线');
  }

  console.log('\n[8] overdueCount 用有效目标日（节假日目标日不算「过期」）');
  {
    const today = require('../lib/localDate').localDate();
    const acc = m.computeAccuracy([
      // 未结算 + 目标日是节假日（旧记录形态）：生效目标日 = 节后交易日，已过去 → 仍应算过期（真实该补结算）
      mkRec({ baseDate: '2026-09-24', targetDate: '2026-09-25' }),
      // 未结算 + 目标日=未来 → 不算过期
      mkRec({ baseDate: '2026-09-30', targetDate: '2099-01-01' }),
    ]);
    eq(acc.short.pendingCount, 2, '2 条待验证');
    eq(acc.short.overdueCount, 1, '只有目标日确已过去的那条计为过期');
    ok(today < '2099-01-01', '（未来目标日不参与过期统计）');
  }

  console.log('\n[9] 接线守卫');
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    ok(/await marketTechJudgment\.settleIfDue\(\)/.test(srv), '/api/market-tech/records 读取即结算（带节流）');
    const mt = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketTechJudgment.js'), 'utf8');
    ok(mt.includes('不信存储的 targetDate') || mt.includes('不信存储的 targetDate') || /isTradingDay\(rec\.targetDate\)/.test(mt),
      '大盘结算不盲目采信存储目标日');
    ok(/TARGET_FALLBACK_MAX_DAYS/.test(mt), '缺口容忍常量存在');
    const jd = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sameDayJudgment.js'), 'utf8');
    ok(/calIsTradingDay\(targetDate\)/.test(jd), '个股结算同样加固（非交易日目标日不采信）');
    ok(/targetDateFixed/.test(jd) && /targetDateFixed/.test(mt), '两处都留了 targetDateFixed 修正痕迹');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})();
