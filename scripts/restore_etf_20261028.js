/**
 * [20261029j] 一次性事故还原：重建 data/etf-flow/20261028.json（残缺快照）
 *
 * 事故：10-28 18:42 采集时 27/34 只 PCF 抓取失败，快照只写入 7 只
 * （510050/510100/510190/510600/588000/588040/588050）却被标 settled:true。
 * 10-29 计算时它被选为基期 → 沪深300 组 15 只全部「基期无快照（新入名单）」（用户报障）。
 *
 * 还原方法（口径=10-27 收盘份额，与原快照 shareDate=20261027 一致）：
 *   S(10-27) = S(10-26)（20261027.json 官方快照）+ Δ(10-27)（权威外部源）
 * 数据源（多源交叉验证）：
 *   ① 腾讯金融搜索「A股行情指标」结构化表：ETF净申购份额(份)，部分码附 ETF份额(份) 总量
 *   ② 上交所官网基金规模历史（总份额/万份，当日清算后）——510320/515390/510500/510370 直接命中
 *   ③ 新浪基金工作室/证券之星 净申购金额(亿元)——量级核对
 * 校验（全部通过才写盘）：
 *   A. 残缺文件 7 只官方值链路自洽：S(10-27)官方 − S(10-26) ÷ 申赎单位 ≈ 整数篮
 *   B. 27 只重建：Δ(10-27) ÷ 申赎单位 ≈ 整数篮
 *   C. 直接命中的官方总份额与重建值逐位相等
 *   D. 前向链：S(10-28)（20261029.json，shareDate=20261028）− S(10-27)重建 ÷ 申赎单位 ≈ 整数篮
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'etf-flow');
const read = f => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

const s27 = read('20261027.json');
const s29 = read('20261029.json');
const partial = read('20261028.json');

// ── 权威外部源：2026-10-27 净申购份额（份）──
const DELTA_1027 = {
  '510300': 791100000, '510310': 324900000, '510320': 45000000, '510330': 252900000,
  '510350': 50400000,  '510360': 36000000,  '510370': 0,        '510380': 0,
  '510390': 0,         '515130': 0,         '515310': 3500000,  '515330': 429000000,
  '515350': 0,         '515360': 0,         '515380': 11700000, '515390': 32000000,
  '515660': 44100000,  '516040': -4000000,  '561420': -2000000, '561930': 0,
  '510500': -28800000, '510510': 0,         '510530': 0,        '510550': 0,
  '512100': 240000000, '516300': 0,         '560010': 150000000,
};
// 腾讯金融搜索/上交所直接给出的 10-27 收盘总份额（份）——最强校验
const DIRECT_1027 = {
  '510300': 36238087700, '510350': 771414700,  '515660': 502894200,
  '516040': 34516600,    '561420': 986237000,  '561930': 208260600,
  '510500': 7022968600,  '510510': 893038300,  '510530': 47979400, '510550': 23743300,
};

const m27 = Object.fromEntries(s27.etfs.map(e => [e.code, e]));
const m29 = Object.fromEntries(s29.etfs.map(e => [e.code, e]));
const mPartial = Object.fromEntries(partial.etfs.map(e => [e.code, e]));

let fails = 0;
const chk = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fails++; };
const nearInt = (v, tol = 0.05) => Math.abs(v - Math.round(v)) <= tol;

console.log('== A. 残缺文件 7 只官方值链路自洽（S(10-27)官方−S(10-26)÷unit≈整数篮）==');
for (const e of partial.etfs) {
  const base = m27[e.code];
  if (!base || !base.shares || !e.shares || !e.unit) { chk(false, `${e.code} 链路数据缺失`); continue; }
  const d = e.shares - base.shares;
  chk(nearInt(d / e.unit), `${e.code} Δ=${d} ÷ ${e.unit} = ${(d / e.unit).toFixed(3)} 篮`);
}

console.log('== B. 27 只重建：Δ(10-27) ÷ unit ≈ 整数篮 ==');
for (const [code, d] of Object.entries(DELTA_1027)) {
  const u = (m27[code] || {}).unit;
  if (!u) { chk(false, `${code} 10-27 快照缺 unit`); continue; }
  chk(nearInt(d / u), `${code} Δ=${d} ÷ ${u} = ${(d / u).toFixed(3)} 篮`);
}

console.log('== C. 官方总份额直接命中（重建值逐位相等）==');
for (const [code, direct] of Object.entries(DIRECT_1027)) {
  const rebuilt = m27[code].shares + DELTA_1027[code];
  chk(rebuilt === direct, `${code} 重建 ${rebuilt} vs 官方 ${direct}`);
}

console.log('== D. 前向链：S(10-28) − S(10-27)重建 ÷ unit ≈ 整数篮（全部 34 只）==');
for (const e of s29.etfs) {
  const p = mPartial[e.code] || m27[e.code];
  const s27shares = mPartial[e.code] ? mPartial[e.code].shares : (m27[e.code].shares + DELTA_1027[e.code]);
  if (!e.shares || !s27shares || !e.unit) { chk(false, `${e.code} 前向链数据缺失`); continue; }
  const d = e.shares - s27shares;
  chk(nearInt(d / e.unit), `${e.code} Δ(10-28)=${d} ÷ ${e.unit} = ${(d / e.unit).toFixed(3)} 篮`);
}

if (fails) { console.error(`\n共 ${fails} 项校验失败 → 不写盘`); process.exit(1); }
console.log('\n全部校验通过 → 写盘');

// ── 备份 ──
const bak = path.join(DIR, 'backup', '20261028.partial-broken.json');
fs.copyFileSync(path.join(DIR, '20261028.json'), bak);
console.log('备份：' + bak);

// ── 重建 ──
const restoredCodes = [];
const etfs = [];
for (const e of partial.etfs) etfs.push(e);                       // 7 只官方原样保留
for (const e of s27.etfs) {
  if (mPartial[e.code]) continue;                                  // 已在官方 7 只内
  etfs.push(Object.assign({}, e, { shares: e.shares + DELTA_1027[e.code] }));
  restoredCodes.push(e.code);
}
etfs.sort((a, b) => a.code.localeCompare(b.code));

const snap = {
  date: partial.date, shareDate: partial.shareDate, savedAt: partial.savedAt, settled: true,
  restored: {
    at: new Date().toISOString(),
    reason: '20261028 18:42 采集残缺（27/34 只 PCF 抓取失败），被 20261029 计算误选为基期 → 沪深300 组全部「基期无快照（新入名单）」（用户报障）',
    method: 'S(10-27) = S(10-26)官方快照 + Δ(10-27)权威外部源（腾讯金融搜索结构化表 × 上交所官网基金规模 × 新浪/证券之星净申购金额三源交叉验证）；7 只残缺文件原值保留；四组校验（链路整篮/Δ整篮/官方总量逐位/前向整篮）全过',
    restoredCodes,
  },
  etfs,
};
if (s27.stockNames || partial.stockNames) snap.stockNames = Object.assign({}, s27.stockNames || {}, partial.stockNames || {});

fs.writeFileSync(path.join(DIR, '20261028.json'), JSON.stringify(snap));
console.log(`写盘完成：20261028.json 共 ${etfs.length} 只（官方保留 7 + 还原 ${restoredCodes.length}）`);
