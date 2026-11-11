/**
 * scripts/accuracy_backtest_report.js — 历史准确率按新口径（前视排除）回算对比报告
 * （整改方案阶段 1 P0-1 · 用户裁决④：审计落地后回算并出新旧对比报告 · 只读不改任何落盘记录）
 * 运行：node scripts/accuracy_backtest_report.js
 * 产出：docs/accuracy-backtest-report-20261110.md
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'accuracy-backtest-report-20261110.md');

function round(x, n) { const p = Math.pow(10, n == null ? 1 : n); return Math.round(x * p) / p; }

function pick(a) {
  // computeAccuracy 返回中与我们相关的字段（旧口径 / 新口径 / 排除数）
  return {
    totalRecords: a.totalRecords,
    settledCount: a.settledCount,
    correct: a.correct,
    newAccuracy: a.accuracy,
    oldAccuracy: a.accuracyIncludingLookahead != null ? a.accuracyIncludingLookahead : a.accuracy,
    excludedCount: a.lookaheadExcludedCount || 0,
    incomparable: a.incomparableSamples || [],
    baselines: a.baselines || null,
    pendingCount: a.pendingCount,
    overdueCount: a.overdueCount,
  };
}

(async () => {
  const rows = [];
  const detail = [];
  const baselines = require(path.join(ROOT, 'lib', 'baselines.js'));
  const lookahead = require(path.join(ROOT, 'lib', 'lookahead.js'));
  const { getHistory } = require(path.join(ROOT, 'lib', 'stockData.js'));

  // 历史记录动量基准只读回算（不改落盘）：按 symbol 拉 2y 日 K，对每条已结算记录算
  // 「baseDate 收盘 vs 5 个交易日前收盘」方向是否与实际一致（口径与结算侧新记录一致）。
  const barsCache = {};
  async function retroMomentum(items) {
    // items: [{symbol, baseDate, actualDir, actualChgPct}]
    const bySymbol = {};
    for (const it of items) if (it.symbol && it.baseDate) (bySymbol[it.symbol] = bySymbol[it.symbol] || []).push(it);
    const agg = { t: 0, c: 0 };
    for (const [sym, list] of Object.entries(bySymbol)) {
      let bars = barsCache[sym];
      if (!bars) {
        try { bars = await getHistory(sym, '2y'); } catch (e) { bars = null; }
        barsCache[sym] = bars && bars.length ? bars.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))) : null;
      }
      if (!bars) continue;
      for (const it of list) {
        const idx = bars.findIndex(b => b.date === it.baseDate);
        const mom = baselines.momentumSignal(bars, idx, 5);
        if (!mom) continue;
        agg.t++;
        if (baselines.momentumCorrect(mom, it.actualDir, it.actualChgPct)) agg.c++;
      }
    }
    return agg;
  }

  // 链 1：sameDayJudgment（个股 6 因子，磁盘只读）
  {
    const sjd = require(path.join(ROOT, 'lib', 'sameDayJudgment.js'));
    const allRecs = sjd.getAllRecords();
    const a = pick(sjd.computeAccuracy(allRecs));
    const mom = await retroMomentum(allRecs
      .filter(r => r.settled && !r.lookaheadExcluded && r.actualDir)
      .map(r => ({ symbol: r.symbol, baseDate: r.referenceDate || r.date, actualDir: r.actualDir, actualChgPct: r.actualChgPct })));
    if (a.baselines && mom.t) a.baselines.momentumBenchmark = { t: mom.t, c: mom.c, rate: round(mom.c / mom.t * 100, 1), note: '5 日动量同向（历史只读回算）' };
    rows.push({ chain: 'sameDayJudgment（个股 6 因子 nextday/intraday）', ...a });
  }
  // 链 2：marketTechJudgment（上证短/中期）
  {
    const mt = require(path.join(ROOT, 'lib', 'marketTechJudgment.js'));
    const recsMT = mt.getAllRecords();
    const full = mt.computeAccuracy(recsMT);
    const a = pick(full);
    a.oldAccuracy = full.short.accuracyIncludingLookahead != null ? full.short.accuracyIncludingLookahead : null;
    a.newAccuracy = full.short.accuracy;
    a.settledCount = full.short.settledCount;
    a.correct = full.short.correct;
    a.excludedCount = (full.lookaheadExcludedCount || 0);
    a.baselines = full.baselines;
    const mom = await retroMomentum(recsMT
      .filter(r => r.shortSettled && r.shortActualDir)
      .map(r => ({ symbol: 'sh000001', baseDate: r.baseDate, actualDir: r.shortActualDir, actualChgPct: r.shortActualChgPct })));
    if (a.baselines && mom.t) a.baselines.momentumBenchmark = { t: mom.t, c: mom.c, rate: round(mom.c / mom.t * 100, 1), note: '5 日动量同向（历史只读回算，上证）' };
    rows.push({ chain: 'marketTechJudgment（上证 短期=次日）', ...a });
  }
  // 链 3：techFaceJudgment（全站合并）
  {
    const tf = require(path.join(ROOT, 'lib', 'techFaceJudgment.js'));
    const a = pick(tf.computeGlobalAccuracy());
    // 只读回算动量基准：逐 symbol 文件读取
    const tfDir = path.join(ROOT, 'data', 'tech-face');
    const items = [];
    let files = [];
    try { files = fs.readdirSync(tfDir).filter(f => f.endsWith('.json') && !f.startsWith('TFA_TEST')); } catch (e) {}
    for (const f of files) {
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(tfDir, f), 'utf8'));
        for (const r of (Array.isArray(arr) ? arr : [])) {
          if (r.settled && !r.lookaheadExcluded && r.actualDir) {
            items.push({ symbol: r.symbol || f.replace('.json', ''), baseDate: r.baseDate, actualDir: r.actualDir, actualChgPct: r.actualChgPct });
          }
        }
      } catch (e) { /* 损坏文件跳过 */ }
    }
    const mom = await retroMomentum(items);
    if (a.baselines && mom.t) a.baselines.momentumBenchmark = { t: mom.t, c: mom.c, rate: round(mom.c / mom.t * 100, 1), note: '5 日动量同向（历史只读回算）' };
    rows.push({ chain: 'techFaceJudgment（技术面形态 HORIZON=5，全站合并）', ...a });
  }
  // 链 4：sentimentAccuracy（情绪预警 vs 次日上证）
  {
    const sa = require(path.join(ROOT, 'lib', 'sentimentAccuracy.js'));
    const a = pick(sa.computeAccuracy());
    const saDir = path.join(ROOT, 'data', 'sentiment-accuracy');
    const items = [];
    let files = [];
    try { files = fs.readdirSync(saDir).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)); } catch (e) {}
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(saDir, f), 'utf8'));
        if (rec && rec.settled && rec.actualDir) items.push({ symbol: 'sh000001', baseDate: rec.baseDate, actualDir: rec.actualDir, actualChgPct: rec.actualChgPct });
      } catch (e) { /* 损坏文件跳过 */ }
    }
    const mom = await retroMomentum(items);
    if (a.baselines && mom.t) a.baselines.momentumBenchmark = { t: mom.t, c: mom.c, rate: round(mom.c / mom.t * 100, 1), note: '5 日动量同向（历史只读回算，上证）' };
    rows.push({ chain: 'sentimentAccuracy（情绪预警 vs 次日上证）', ...a });
  }

  // 审计（四链全部已结算记录逐条 auditSettlement）
  let audited = 0, flagged = 0;
  {
    const lookahead = require(path.join(ROOT, 'lib', 'lookahead.js'));
    const dirs = [
      ['sameDayJudgment', path.join(ROOT, 'data', 'judgments')],
      ['marketTechJudgment', path.join(ROOT, 'data', 'market-tech-judgments')],
      ['techFaceJudgment', path.join(ROOT, 'data', 'tech-face')],
      ['sentimentAccuracy', path.join(ROOT, 'data', 'sentiment-accuracy')],
    ];
    for (const [name, dir] of dirs) {
      let files = [];
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch (e) { continue; }
      for (const f of files) {
        try {
          const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          const arr = Array.isArray(j) ? j : (Array.isArray(j.records) ? j.records : []);
          for (const rec of arr) {
            audited++;
            const r = lookahead.auditSettlement(rec, { windowDays: 10 });
            if (r.excluded) { flagged++; detail.push({ chain: name, date: rec.date || rec.baseDate, violations: r.violations }); }
          }
        } catch (e) { /* 损坏文件跳过 */ }
      }
    }
  }

  const L = [];
  L.push('# 历史准确率新旧口径回算对比报告（2026-11-10 · 裁决④）');
  L.push('');
  L.push('> 新口径 = 可比样本（`lookaheadExcluded` 记录拆出为不可比样本）；旧口径 = 全部已结算记录（`accuracyIncludingLookahead`）。');
  L.push('> 本报告**只读回算**，未修改任何落盘记录。审计器：`lib/lookahead.js`；结论表：`docs/logic/common-06b-lookahead.md`。');
  L.push('');
  L.push('## 一、回算总览');
  L.push('');
  L.push('| 结算链 | 记录总数 | 已结算 | 命中 | 新口径准确率 | 旧口径准确率 | 差异 | 前视排除数 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const diff = (r.newAccuracy != null && r.oldAccuracy != null) ? round(r.newAccuracy - r.oldAccuracy, 1) : '—';
    L.push(`| ${r.chain} | ${r.totalRecords} | ${r.settledCount} | ${r.correct} | ${r.newAccuracy == null ? '—' : r.newAccuracy + '%'} | ${r.oldAccuracy == null ? '—' : r.oldAccuracy + '%'} | ${diff === '—' ? '—' : diff + 'pp'} | ${r.excludedCount} |`);
  }
  L.push('');
  L.push(`审计器逐条回审：**${audited}** 条已结算记录，前视违规 **${flagged}** 条 → 新旧口径差异来源即这 ${flagged} 条。`);
  L.push('');
  L.push('## 二、三基准并列（新口径可比样本，手算可复核）');
  L.push('');
  L.push('| 结算链 | 准确率(新) | 方向基准（永远涨） | 随机 50% | 5 日动量基准 | 样本充足（≥30） |');
  L.push('|---|---|---|---|---|---|');
  for (const r of rows) {
    const b = r.baselines;
    if (!b) { L.push(`| ${r.chain} | ${r.newAccuracy == null ? '—' : r.newAccuracy + '%'} | — | — | — | — |`); continue; }
    L.push(`| ${r.chain} | ${r.newAccuracy == null ? '—' : r.newAccuracy + '%'} | ${b.directionBenchmark.rate == null ? '—' : b.directionBenchmark.rate + '%'} | 50% | ${b.momentumBenchmark.rate == null ? '—' : b.momentumBenchmark.rate + '%'}（n=${b.momentumBenchmark.t}） | ${b.sampleSufficient ? '是' : '否（' + b.directionBenchmark.t + ' 条，无统计意义）'} |`);
  }
  L.push('');
  L.push('## 三、按市场状态月分组（涨/跌/震荡月，上证月度聚合 >±1%）');
  L.push('');
  L.push('| 结算链 | 月份分组（月: 状态 n条/命中） |');
  L.push('|---|---|');
  for (const r of rows) {
    const b = r.baselines;
    if (!b || !b.byMonth || !Object.keys(b.byMonth).length) { L.push(`| ${r.chain} | — |`); continue; }
    const cells = Object.entries(b.byMonth).sort((x, y) => y[0].localeCompare(x[0])).slice(0, 6)
      .map(([m, v]) => `${m}: ${v.marketState || '无状态'} ${v.t}条/${v.c}中`).join('；');
    L.push(`| ${r.chain} | ${cells} |`);
  }
  L.push('');
  L.push('## 四、违规明细（如有）');
  L.push('');
  if (!detail.length) {
    L.push('无。历史已结算记录未发现 L1（财报披露晚于判断日）/ L2（结算早于目标日）/ L3（内嵌时间戳越窗）任一违规 → **新旧口径数字一致**，历史准确率无需修正。');
  } else {
    for (const d of detail) {
      L.push(`- [${d.chain}] ${d.date}: ${d.violations.map(v => v.detail).join('；')}`);
    }
  }
  L.push('');
  L.push('## 五、口径与边界');
  L.push('');
  L.push('- 逐链审计范围与「用了什么数据/可得时点/风险/处理」见 `docs/logic/common-06b-lookahead.md`。');
  L.push('- 因子快照缺逐项可得时间戳 → 判断生成侧的历史数据无法逐项复核（结算侧裁决范围内无法补救），已如实声明。');
  L.push('- 样本 <30 的链按方案口径明示「无统计意义」，页面同口径展示。');
  fs.writeFileSync(OUT, L.join('\n'), 'utf8');
  console.log('报告已写入 ' + path.relative(ROOT, OUT));
  console.log(L.filter(l => l.startsWith('|')).slice(0, 12).join('\n'));
})().catch(e => { console.error('回算失败:', e.message); process.exit(1); });
