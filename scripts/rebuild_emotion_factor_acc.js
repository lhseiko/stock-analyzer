#!/usr/bin/env node
/**
 * rebuild_emotion_factor_acc.js — 市场情绪提醒「因子命中率台账 + 自学习权重」按新口径重放
 * ============================================================================
 * 背景（任务卡 #006 / F01+F02+F09，2026-11-15）：
 *   旧 applyFactorAccuracy 把 flat（次日 ±0.5% 震荡）日的 actualUp 判成 false，
 *   导致所有看空方向被记为命中：实测 26 个 flat 日里 81 个看空方向 81/81 全中，
 *   indexMomentum 96.7% / margin 93.3% 属统计假象，并把 3 个因子顶到 30% 上限锁死。
 *   另有历史因子改名遗留：priceVolume 的样本与 volumePrice 分裂，最大权重因子长期样本不足。
 *
 * 本脚本做什么（确定性、幂等、可重跑）：
 *   1. 备份 state.json 到 state.backup-YYYYMMDD.json（仅首次，已存在则跳过）；
 *   2. 从 BASE_WEIGHTS 出发，按 records.json 的日期顺序逐条重放：
 *      - 跳过未结算记录与 flat 日（新口径，任务卡关键问题①选 A）；
 *      - 旧键 priceVolume 归并到 volumePrice（关键口径 F09）；
 *      - 每结算一条调用线上同一份 applyFactorAccuracy + learnWeights，复现「若一开始
 *        就是新口径，历史学习轨迹会怎样」，避免另发明一套权重算法；
 *   3. 写回 factorAcc / weights；[20261115b #007 / S7] 按 baselineDate 去重、跳过非交易日快照；
 *      [S6] 宏观 events 的 active 残留归零、lastLearnDate 由运行时自行落标。
 *
 * 任务卡 #007 新口径（2026-11-15）：叠加「按日去重后的自学习」与「历史台账污染回溯」。
 *   实测 58 条里 10 个基准日被 2~7 条记录复用（2026-09-30 复用 7 次），同一天行情被
 *   反复计入因子样本；剔除 flat 与重复基准日后有效样本仅 16 条，低于 20 条自学习门槛，
 *   因此权重按规则回到 BASE_WEIGHTS，不再出现三因子 30 顶格的统计假象。
 *
 * 不做什么：
 *   - 不改 records.json / snapshots.json / 任何行情财报原始数据；
 *   - 不删历史记录；不改变因子结构或 BASE_WEIGHTS；
 *   - 不联网、不重启、不升版、不 commit/push。
 *
 * 用法：
 *   node scripts/rebuild_emotion_factor_acc.js            # 实跑写盘（因子台账 + 权重重放）
 *   node scripts/rebuild_emotion_factor_acc.js --dry-run  # 只输出将要写入的结果
 *   node scripts/rebuild_emotion_factor_acc.js --backfill-health  # S9 月报断档补齐（幂等）
 *   SA_MARKET_EMOTION_DIR=/tmp/xxx node ...               # 指定目录（守卫隔离用）
 */
const fs = require('fs');
const path = require('path');
const model = require('../lib/marketEmotionModel');
const { localDate } = require('../lib/localDate');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.SA_MARKET_EMOTION_DIR
  ? path.resolve(process.env.SA_MARKET_EMOTION_DIR)
  : path.join(ROOT, 'data', 'market-emotion');

const STATE_FILE = path.join(DIR, 'state.json');
const REC_FILE = path.join(DIR, 'records.json');

function readJson(p, dft) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dft; }
}

/** 重放核心：返回 { state, summary }，不写盘 */
function rebuild(opts = {}) {
  const dir = opts.dir || DIR;
  const stateFile = path.join(dir, 'state.json');
  const recFile = path.join(dir, 'records.json');
  const old = readJson(stateFile, null);
  const records = readJson(recFile, []);
  if (!Array.isArray(records)) throw new Error('records.json 不是数组');

  // [20261115b S6] 顺带回溯宏观事件台账：旧双状态机让「无事件」因子长期 active
  // 并白占非常驻权重（实测 1.64 / 2.05 残留 21 天），而 macroFactors.json 早已 dormant。
  // 本版已收敛为单一激活源，重放时把历史 active 残留一并归零，避免重启前仍是脏台账。
  const events = {};
  for (const [k, ev] of Object.entries((old && old.events) || {})) {
    events[k] = Object.assign({}, ev, { status: 'dormant', weight: 0, lastDecay: null });
  }
  const state = Object.assign({}, old || {}, {
    weights: { ...model.BASE_WEIGHTS },
    factorAcc: {},
    events,
  });
  // 重放是历史重算，不该把 lastLearnDate 写成最后一条历史记录的日期、也不该冒充
  // 「今天已学习」；删掉后由运行时首次请求按新口径自行落标。
  delete state.lastLearnDate;

  // [20261115b S7] 历史台账污染回溯（重放侧过滤，不改写 records.json）：
  // 实测 58 条里 10 个基准日被 2~7 条记录复用（2026-09-30 复用 7 次），同一天行情
  // 被反复计入因子命中样本。按 baselineDate 去重，同一基准日只保留第一条结算样本。
  const seenBaseline = new Set();
  let replayed = 0, skippedFlat = 0, skippedUnsettled = 0, adjustments = 0;
  let skippedDuplicate = 0, skippedNonTrading = 0;
  for (const r of records) {
    if (r.isTradingDay === false) { skippedNonTrading++; continue; }
    if (!r.settledT1) { skippedUnsettled++; continue; }
    const dir = (r.resultT1 && r.resultT1.dir) || null;
    if (!dir) { skippedUnsettled++; continue; }
    const baseKey = r.baselineDate || r.date;
    if (seenBaseline.has(baseKey)) { skippedDuplicate++; continue; }
    seenBaseline.add(baseKey);
    if (dir === 'flat') { skippedFlat++; continue; }

    // 旧键 priceVolume → volumePrice（历史因子改名遗留，与 migrateVolumePriceWeights 同语义）
    const dirs = {};
    for (const [k, v] of Object.entries(r.factorDirs || {})) {
      dirs[k === 'priceVolume' ? 'volumePrice' : k] = v;
    }
    model.applyFactorAccuracy(state, [{ record: { factorDirs: dirs }, actualDir: dir }]);
    // force=true：重放的是历史轨迹，逐条推进，不受「同一自然日只学一次」的按日去重约束
    const { learnLog } = model.learnWeights(state, { today: r.date, force: true });
    adjustments += learnLog.length;
    replayed++;
  }

  // 循环里 learnWeights(force=true) 会把 lastLearnDate 写成最后一条历史记录的日期，
  // 循环结束后再清一次：这是历史重算，不冒充运行时「今天已学习」。
  delete state.lastLearnDate;
  const factorAcc = {};
  for (const [k, a] of Object.entries(state.factorAcc)) {
    const s = a.samples || [];
    factorAcc[k] = { n: s.length, rate: s.length ? +(s.filter(Boolean).length / s.length).toFixed(3) : null };
  }
  return {
    state,
    summary: {
      records: records.length, replayed, skippedFlat, skippedUnsettled, adjustments,
      skippedDuplicate, skippedNonTrading,
      weights: { ...state.weights }, factorAcc,
      oldWeights: old && old.weights ? { ...old.weights } : null,
    },
  };
}

/** 写盘（含一次性备份），返回备份路径 */
function persist(result, opts = {}) {
  const dir = opts.dir || DIR;
  const stateFile = path.join(dir, 'state.json');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `state.backup-${localDate().replace(/-/g, '')}.json`);
  if (fs.existsSync(stateFile) && !fs.existsSync(backup)) {
    fs.copyFileSync(stateFile, backup);
  }
  const out = Object.assign({}, result.state, { lastUpdated: new Date().toISOString() });
  fs.writeFileSync(stateFile, JSON.stringify(out, null, 2), 'utf8');
  return backup;
}

/**
 * [20261115b S9] 月报断档补齐（幂等，带外数据，不改运行时算法）
 * ------------------------------------------------------------------
 * 实测 health/ 只有 2026-09.json，10 / 11 月断档，而 records.json 里这两个月
 * 分别有 29 / 12 条已结算记录；09 月报的 factorStats 还留着旧因子键 priceVolume
 * （#006 F09 已把权重台账归并到 volumePrice）。
 *
 * 这不改 maybeMonthlyHealth 的运行时行为（隔离化）：只在离线脚本里按
 * records.json 的当月结算记录补生成缺失月报，并把已有月报的旧键归一。
 * 补生成报告带 backfilled / method 标注，明确「非月末实时快照、取样窗口与运行时
 * 月报不同」，避免与运行时口径被误当成同一份。
 */
function backfillHealth(opts = {}) {
  const dir = opts.dir || DIR;
  const healthDir = path.join(dir, 'health');
  const records = readJson(path.join(dir, 'records.json'), []);
  if (!Array.isArray(records)) throw new Error('records.json 不是数组');
  fs.mkdirSync(healthDir, { recursive: true });

  const byMonth = {};
  for (const r of records) {
    const k = String(r.date || '').slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(k)) continue;
    (byMonth[k] = byMonth[k] || []).push(r);
  }
  const created = [], normalized = [];
  for (const month of Object.keys(byMonth).sort()) {
    const file = path.join(healthDir, month + '.json');
    const recs = byMonth[month];
    if (!fs.existsSync(file)) {
      const settled = recs.filter(r => r.settledT1);
      // factorStats 与线上 applyFactorAccuracy 同口径：flat 日不计样本、dir=0 不计
      const stats = {};
      for (const r of settled) {
        const d = r.resultT1 && r.resultT1.dir;
        if (!d || d === 'flat') continue;
        const up = d === 'up';
        for (const [k, sign] of Object.entries(r.factorDirs || {})) {
          if (!sign) continue;
          const key = k === 'priceVolume' ? 'volumePrice' : k;
          if (!stats[key]) stats[key] = { name: model.FACTOR_NAMES[key] || key, n: 0, correct: 0 };
          stats[key].n++;
          if ((sign > 0) === up) stats[key].correct++;
        }
      }
      const factorStats = {};
      for (const [k, v] of Object.entries(stats)) {
        factorStats[k] = { name: v.name, rate: +(v.correct / v.n).toFixed(3), n: v.n };
      }
      fs.writeFileSync(file, JSON.stringify({
        month, generatedAt: new Date().toISOString(),
        backfilled: true,
        method: '按 data/market-emotion/records.json 当月结算记录回溯生成（非月末实时快照；factorStats 取样窗口与运行时月报不同，仅作断档补齐与可追溯留档）',
        report: {
          month,
          settledCount: settled.length,
          accuracy: settled.length ? +(settled.filter(r => r.correctT1).length / settled.length * 100).toFixed(1) : null,
          factorStats,
          failedFactors: [],
        },
      }, null, 2), 'utf8');
      created.push(month);
    } else {
      // 旧键归一：只改因子键与显示名，准确率 / 结算数原样保留（不重写历史数值）
      const old = readJson(file, null);
      const statsOld = old && old.report && old.report.factorStats;
      if (statsOld && statsOld.priceVolume) {
        const pv = statsOld.priceVolume;
        delete statsOld.priceVolume;
        statsOld.volumePrice = { name: '量能活跃与量价配合', rate: pv.rate, n: pv.n };
        old.normalizedAt = new Date().toISOString();
        old.normalizedNote = '因子改名遗留 priceVolume → volumePrice（与 BASE_WEIGHTS / #006 F09 对齐）；准确率与结算数原样保留';
        fs.writeFileSync(file, JSON.stringify(old, null, 2), 'utf8');
        normalized.push(month);
      }
    }
  }
  return { created, normalized, months: Object.keys(byMonth).sort() };
}

module.exports = { rebuild, persist, backfillHealth, DIR };

if (require.main === module) {
  if (process.argv.includes('--backfill-health')) {
    const res = backfillHealth();
    console.log('===== 情绪模型月报断档补齐（S9）=====');
    console.log('台账月份：', res.months.join(', '));
    console.log('补生成：', res.created.length ? res.created.join(', ') : '无（均已存在）');
    console.log('旧键归一：', res.normalized.length ? res.normalized.join(', ') : '无');
    const again = backfillHealth();
    console.log(`幂等校验：${again.created.length === 0 && again.normalized.length === 0 ? '通过' : '失败'}（重复执行不再写盘）`);
    if (again.created.length || again.normalized.length) process.exit(1);
  } else runReplay();
}

function runReplay() {
  const dryRun = process.argv.includes('--dry-run');
  const result = rebuild();
  const s = result.summary;
  console.log('===== 情绪因子台账按新口径重放 =====');
  console.log(`记录 ${s.records} 条｜参与重放 ${s.replayed}｜跳过震荡日 ${s.skippedFlat}｜未结算 ${s.skippedUnsettled}｜重复基准日 ${s.skippedDuplicate}｜非交易日 ${s.skippedNonTrading}`);
  console.log(`自学习调整累计 ${s.adjustments} 次`);
  console.log('旧权重：', JSON.stringify(s.oldWeights));
  console.log('新权重：', JSON.stringify(s.weights));
  console.log('新样本：', JSON.stringify(s.factorAcc));
  if (dryRun) {
    console.log('--dry-run：未写盘');
  } else {
    const backup = persist(result);
    console.log('已写盘：', STATE_FILE);
    console.log('备份：', backup);
  }
  // 幂等自检：同一份输入再算一次，权重与样本必须逐字一致
  const again = rebuild();
  const a = JSON.stringify(rebuild().summary);
  const b = JSON.stringify(again.summary);
  if (a !== b) { console.error('幂等校验失败'); process.exit(1); }
  console.log('幂等校验：通过（重复计算结果一致）');
}
