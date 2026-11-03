#!/usr/bin/env node
/**
 * scripts/restore_etf_20261030.js — 20261103g 事故恢复（10-30 快照被节假日重采覆盖）
 *
 * 事故：11-01（周日）打开首页触发 collect → PCF 返回上周五（10-30）清单 → 已定稿的
 * 20261030 快照被覆盖，shareDate 被 T+1 采集日语义从 20261029 前推到 20261030，
 * shares 从「10-29 收盘」变成「10-30 收盘」→ 逐日表 10-30 假 Δ=0、台账重复计入周四增量。
 * （根修已在 lib/etfFlow.js collect 跨日重采守卫落地，本脚本清洗已发生的污染。）
 *
 * 恢复推导（全内部、份级精确）：
 *   Δwrong = s(10-30快照) − s(10-29快照) = 10-30收盘 − 10-28收盘   （= 周四+周五 合计）
 *   Δthu   = s(10-29快照) − s(10-28快照) = 10-29收盘 − 10-28收盘   （= 周四 单日）
 *   Δfri   = Δwrong − Δthu = 10-30收盘 − 10-29收盘                （= 周五 单日）
 *   恢复   s(10-29收盘) = s(10-30快照现值) − Δfri
 * 可信度校验：Δfri ÷ 申赎单位 ≈ 整数篮（阈值 0.05，与 computeFromSnapshots 同口径）。
 *
 * 步骤：备份 → 重建 20261030 快照（shares=10-29收盘、shareDate=20261029、restored 溯源）
 *       → 台账重置 → 按快照链升序幂等重放（不手写 cum，走 computeFromSnapshots 代码路径）
 * 幂等：可重复执行（恢复前检查 restored 标记跳过）。
 */
'use strict';
const path = require('path');
const fs = require('fs');
process.env.SA_ETF_FLOW_DIR = path.join(__dirname, '..', 'data', 'etf-flow');
const etfFlow = require(path.join(__dirname, '..', 'lib', 'etfFlow.js'));
const DIR = process.env.SA_ETF_FLOW_DIR;
const BK = path.join(DIR, 'backup');
if (!fs.existsSync(BK)) fs.mkdirSync(BK, { recursive: true });
const readJ = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const snapP = (d) => path.join(DIR, `${d}.json`);

const SNAP_D = '20261030';
const snap = readJ(snapP(SNAP_D));
if (snap.restored) { console.log('已恢复过（restored 标记存在），跳过快照重建；仅重放台账。'); }
else {
  const s28 = readJ(snapP('20261028')), s29 = readJ(snapP('20261029'));
  const pick = (s, c) => { const e = s.etfs.find(x => x.code === c); return e ? e.shares : null; };
  const unitOf = (c) => { const e = snap.etfs.find(x => x.code === c) || s29.etfs.find(x => x.code === c); return e ? e.unit : null; };

  let okN = 0, zeroN = 0, bad = [];
  const restoredEtfs = snap.etfs.map(e => {
    const s28v = pick(s28, e.code), s29v = pick(s29, e.code), s30v = e.shares;
    if (s28v == null || s29v == null || !e.unit) { bad.push(`${e.code} 链上缺值`); return e; }
    const dWrong = s30v - s29v, dThu = s29v - s28v, dFri = dWrong - dThu;
    if (dFri === 0) { zeroN++; return e; }  // 周四+周五均无申赎 → 覆盖前后同值，无需恢复
    const baskets = dFri / e.unit;
    if (Math.abs(baskets - Math.round(baskets)) > 0.05) { bad.push(`${e.code} Δfri 篮数 ${baskets.toFixed(3)} 非整数`); return e; }
    const restored = s30v - dFri;
    okN++;
    return Object.assign({}, e, { shares: restored, _restoreNote: `节假日覆盖恢复：shares=10-29收盘值（Δfri=${dFri}，${Math.round(baskets)} 篮）` });
  });
  if (bad.length) {
    console.error('✗ 校验未全部通过，中止（不写盘）：\n  ' + bad.join('\n  '));
    process.exit(1);
  }
  // 备份被覆盖版
  fs.copyFileSync(snapP(SNAP_D), path.join(BK, `${SNAP_D}.holiday-overwritten.json`));
  const out = Object.assign({}, snap, {
    etfs: restoredEtfs,
    shareDate: '20261029',
    restored: {
      at: new Date().toISOString(),
      reason: '20261103g：11-01 周日跨日重采覆盖（shareDate 被 T+1 采集日语义前推），本快照由 Δwrong−Δthu 推导恢复为 10-29 收盘份额；全量篮数整除校验通过',
      script: 'scripts/restore_etf_20261030.js',
    },
  });
  delete out.partial; delete out.gaps;
  fs.writeFileSync(snapP(SNAP_D), JSON.stringify(out, null, 2), 'utf8');
  console.log(`✓ 快照 ${SNAP_D} 已恢复：${okN} 只份额回写（10-29 收盘值），${zeroN} 只 Δfri=0 无需恢复；shareDate=20261029`);
}

// —— 台账重放：重置后按快照链升序幂等重放（走 computeFromSnapshots 代码路径，不手写 cum）——
const ledgerP = path.join(DIR, 'ledger.json');
const before = readJ(ledgerP);
fs.copyFileSync(ledgerP, path.join(BK, `ledger.before-replay-20261103.json`));
console.log(`\n重放前台账：lastDate=${before.lastDate} days=${before.days}`);

const chain = fs.readdirSync(DIR).filter(f => /^2026\d{4}\.json$/.test(f)).sort()
  .filter(f => { const s = readJ(path.join(DIR, f)); return s.settled && !s.partial; });
console.log('快照链（settled 升序）：', chain.map(f => f.replace('.json', '')).join(' → '));
// 重置台账（computeFromSnapshots 从空台账逐日幂等入账）
fs.writeFileSync(ledgerP, JSON.stringify({ lastDate: null, cum: {}, days: 0 }), 'utf8');
for (const f of chain) {
  const d = f.replace('.json', '');
  try { etfFlow.computeFromSnapshots(d); } catch (e) { console.error(`  重放 ${d} 失败:`, e.message); }
}
const after = readJ(ledgerP);
console.log(`重放后台账：lastDate=${after.lastDate} days=${after.days} cum键数=${Object.keys(after.cum).length}`);

// —— 验证：恢复后逐日 Δ ——
const s1102 = readJ(snapP('20261102')), s1103 = readJ(snapP('20261103'));
const restored = readJ(snapP(SNAP_D));
const pick = (s, c) => { const e = s.etfs.find(x => x.code === c); return e ? e.shares : null; };
const dFri = pick(s1102, '510300') - pick(restored, '510300');
const dMon = pick(s1103, '510300') - pick(s1102, '510300');
console.log(`\n验证（510300）：周五(10-30) Δ = ${(dFri / 1e8).toFixed(3)} 亿份（${dFri / 1000000} 篮）；周一(11-02) Δ = ${(dMon / 1e8).toFixed(3)} 亿份`);
console.log('完成。');
