#!/usr/bin/env node
/**
 * scripts/restore_etf_20261106.js — 20261109 事故恢复（11-06 残缺快照被误标定稿）
 *
 * 事故：11-07 凌晨跨日重采覆盖 20261106 快照，PCF 只成功 7/34 只，份额被写成 11-06 收盘值
 *       （与 20261109 快照对应代码逐位相同），却被标成 settled:true 且无 partial 标记。
 *       后果：
 *         ① 20261109 的基期选中这份残缺快照 → 两份都是 shareDate=20261106 → overlap 守卫
 *            返回 baselineOnly:true，前端「家族汇总卡 / Top10 / 全部成分股累计」整块隐藏。
 *         ② computeFromSnapshots('20261106') 以 7 只 ETF 的篮子把「11-04→11-06 多日合计」
 *            当成单日入账，台账 days 11 / lastDate 20261106 被污染。
 *
 * 恢复（不臆造任何份额数字，全部走代码路径）：
 *   1) 把 20261106 如实标记 partial:true / settled:false → 基期自动回退 20261105（34 只，
 *      shareDate 20261104），20261109 恢复可计算，代码自动打 spanNote「多日合计」披露。
 *   2) 精确撤销那一次污染入账：用「修复前」的 20261106 调 computeFromSnapshots 取当日
 *      stockAgg（dayBuy/daySell），从台账 cum 逐股扣回、days-1、lastDate 回退 20261104。
 *
 * 为什么不重置台账重放（与 restore_etf_20261030.js 的关键差异）：
 *   KEEP_DAYS=10 已滚动清理掉 10-26 之前的快照；ledger.backup-20261026.json 证明台账含
 *   days=3 的早期合法累计，那部分数据只存在于 cum 里、无法从现存快照重建。重置=永久丢数据。
 *   因此本脚本**只扣最后一次污染入账**，保全全部合法历史。
 *
 * 幂等：快照已有 restored+partial 标记则跳过重写；台账仅当 lastDate=20261106 且 days=11 时撤销。
 * 用法：node scripts/restore_etf_20261106.js [--dry-run]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const DRY = process.argv.includes('--dry-run');
const SRC = path.join(__dirname, '..', 'data', 'etf-flow');
let DIR = SRC;
if (DRY) {
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sa_etf_restore_'));
  for (const f of fs.readdirSync(SRC)) {
    const s = path.join(SRC, f);
    if (fs.statSync(s).isFile()) fs.copyFileSync(s, path.join(DIR, f));
  }
  console.log('[DRY-RUN] 临时目录 ' + DIR + '（生产数据零改动）\n');
}
process.env.SA_ETF_FLOW_DIR = DIR;
const etfFlow = require(path.join(__dirname, '..', 'lib', 'etfFlow.js'));

const readJ = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const writeJ = (f, v) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(v, null, 2), 'utf8');
const BK = path.join(DIR, 'backup');
if (!fs.existsSync(BK)) fs.mkdirSync(BK, { recursive: true });
const tag = (s) => (DRY ? '[DRY] ' : '') + s;

const SNAP = '20261106.json';
const snap = readJ(SNAP);
const ledger = readJ('ledger.json');

// ── 0. 前置校验：只认这一起事故的确切指纹，避免误伤其它数据 ──
if ((snap.etfs || []).length !== 7 || String(snap.shareDate) !== '20261106') {
  console.error('✗ 20261106 快照指纹不符（期望 7 只 / shareDate 20261106），中止，不写盘。');
  process.exit(1);
}

// ── 1. 修快照前，先算出「那次污染入账」的逐股增量 ──
// 幂等保证：此时 ledger.lastDate=20261106 且 shareDate=20261106 → already=true → 不会二次入账、不写盘
const polluted = etfFlow.computeFromSnapshots('20261106');
if (!polluted.ok) { console.error('✗ 无法复现 20261106 入账：' + polluted.reason); process.exit(1); }
const deltas = (polluted.stocks || []).filter(s => s.dayBuy > 0 || s.daySell < 0);
let sumBuy = 0, sumSell = 0;
for (const s of deltas) { sumBuy += s.dayBuy; sumSell += s.daySell; }
console.log(tag(`污染入账复现：baseDate=${polluted.baseDate} spanNote=${polluted.spanNote || '无'}`));
console.log(tag(`  非零逐股 ${deltas.length} 只 | 合计买 ${sumBuy.toFixed(0)} 股 / 卖 ${sumSell.toFixed(0)} 股`));
console.log(tag(`  台账现值：lastDate=${ledger.lastDate} days=${ledger.days} cum键数=${Object.keys(ledger.cum || {}).length}\n`));

// ── 2. 备份（仅正式运行；绝不覆盖已存在的原件，保证重复执行也能保住「事故前」台账）──
const needUndo = ledger.lastDate === '20261106' && ledger.days === 11;
if (!DRY) {
  const snapBk = path.join(BK, '20261106.partial-mislabeled.json');
  const ledgerBk = path.join(BK, 'ledger.before-restore-20261106.json');
  let n = 0;
  if (!fs.existsSync(snapBk)) { fs.copyFileSync(path.join(DIR, SNAP), snapBk); n++; }
  if (needUndo && !fs.existsSync(ledgerBk)) { fs.copyFileSync(path.join(DIR, 'ledger.json'), ledgerBk); n++; }
  console.log(n ? `✓ 已备份 ${n} 份事故前原件 → data/etf-flow/backup/` : '✓ 事故前备份已存在，跳过（不覆盖）');
}

// ── 3. 快照如实标记残缺（份额数字零改动）──
if (snap.restored && snap.partial) {
  console.log(tag('20261106 已恢复过（restored + partial 标记存在），跳过快照重写。'));
} else {
  const out = Object.assign({}, snap, {
    partial: true,
    settled: false,
    gaps: [
      '20261109 诊断：该快照仅 7/34 只 ETF（27 只 PCF 抓取失败），份额为 11-06 收盘值（与 20261109 快照对应代码逐位相同），系 11-07 跨日重采覆盖产物',
      '按 20261029j 残缺快照守卫如实标记 partial:true / settled:false，不臆造份额；基期自动回退上一份完整定稿快照 20261105（shareDate 20261104）',
    ],
    restored: {
      at: new Date().toISOString(),
      reason: '残缺快照误标定稿事故恢复：只改标志位与溯源说明，不动任何份额数字',
      script: 'scripts/restore_etf_20261106.js',
      dryRun: DRY,
    },
  });
  writeJ(SNAP, out);
  console.log(tag('✓ 20261106 已标记 partial:true / settled:false（份额数字零改动）'));
}

// ── 4. 精确撤销污染入账（保全被 KEEP_DAYS 清理掉的早期合法累计）──
// needUndo 已在步骤 2 备份前计算，此处不重复声明
if (!needUndo) {
  console.log(tag(`台账 lastDate=${ledger.lastDate} days=${ledger.days}，非本次污染指纹，跳过撤销（幂等）。`));
} else {
  const L = JSON.parse(JSON.stringify(ledger));
  let nBuy = 0, nSell = 0;
  const bad = [];
  for (const s of deltas) {
    const c = L.cum[s.code];
    if (!c) { bad.push(`${s.code} 台账无 cum 项`); continue; }
    if (s.dayBuy > 0) {
      const v = (c.buyShares || 0) - s.dayBuy;
      if (v < -1) bad.push(`${s.code} buyShares 扣回后为负 ${v}`);
      c.buyShares = Math.abs(v) < 1 ? 0 : v;
      c.buyDays = Math.max(0, (c.buyDays || 0) - 1);
      nBuy++;
    }
    if (s.daySell < 0) {
      // sellShares 是累计负值；入账时 += 负数，撤销时 -= 负数（朝 0 回退）
      const v = (c.sellShares || 0) - s.daySell;
      if (v > 1) bad.push(`${s.code} sellShares 扣回后为正 ${v}`);
      c.sellShares = Math.abs(v) < 1 ? 0 : v;
      c.sellDays = Math.max(0, (c.sellDays || 0) - 1);
      nSell++;
    }
  }
  if (bad.length) {
    console.error('✗ 撤销校验未通过，中止（不写盘）：\n  ' + bad.slice(0, 10).join('\n  '));
    process.exit(1);
  }
  L.days = L.days - 1;
  L.lastDate = '20261104';
  writeJ('ledger.json', L);
  console.log(tag(`✓ 台账撤销：${nBuy} 只买入 / ${nSell} 只卖出逐股扣回；days ${ledger.days}→${L.days}，lastDate ${ledger.lastDate}→${L.lastDate}，cum键数 ${Object.keys(L.cum).length} 不变`));
}

// ── 5. 验证：20261109 恢复可计算 ──
const calc = etfFlow.computeFromSnapshots('20261109');
console.log(tag('\n=== 验证 computeFromSnapshots(20261109) ==='));
console.log(tag(`ok=${calc.ok} overlap=${Boolean(calc.overlap)} date=${calc.date} baseDate=${calc.baseDate} reason=${calc.reason || '无'}`));
console.log(tag(`etfs=${(calc.etfs || []).length} stocks=${(calc.stocks || []).length} groups=${(calc.groups || []).length} totalNet=${calc.totalNet}`));
console.log(tag(`spanNote=${calc.spanNote || '无'}`));
console.log(tag(`ledgerDays=${calc.ledgerDays} ledgerDate=${calc.ledgerDate}`));
if ((calc.groups || []).length) {
  console.log(tag('家族汇总：' + calc.groups.map(g => `${g.label}:${(g.netAmount / 1e8).toFixed(2)}亿`).join(' | ')));
}
const L2 = readJ('ledger.json');
console.log(tag(`台账最终：lastDate=${L2.lastDate} days=${L2.days} cum键数=${Object.keys(L2.cum).length}`));
console.log(tag('\n完成。'));
if (DRY) console.log('[DRY-RUN] 以上全部发生在临时目录，生产 data/etf-flow 未改动。临时目录：' + DIR);
