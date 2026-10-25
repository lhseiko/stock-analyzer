/**
 * 宽基 ETF 申购赎回（20261022h）回归
 * --------------------------------------------------------------
 * 运行： node scripts/test_etf_flow.js
 * 全部离线：在临时目录里造快照，验证「快照 → 净申赎 → 逐股增减 → 累计台账」这条链。
 * 覆盖：
 *   [1] 只有一份快照 → 基线日（无基期，不硬编数字）
 *   [2] 两日定稿快照 → Δ份额 / 篮数 / 净申赎额 / 逐股理论增减
 *   [3] 台账幂等：同一天重复计算不重复累加
 *   [4] 盘中快照（settled:false）不进台账，但当日 Δ 照常展示
 *   [5] 基期只认 settled:true：跳过未定稿快照，取更早的定稿日
 *   [6] 逐股清单 = 今日篮子 ∪ 台账历史（已退出篮子的股票累计值不丢）
 *   [7] scoreOf：tanh 软饱和 + ±1 夹紧 + 非法值归零
 *   [8] 接线守卫：情绪模型因子 / server 注入 / 前端页签
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'sa-etf-flow-test-' + process.pid + '-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.SA_ETF_FLOW_DIR = TMP;   // 必须在 require 之前设置（模块加载时解析目录）

const ef = require('../lib/etfFlow');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}（期望 ≈${b}±${tol}，实际 ${a}）`);

const COMP_A = [['600519', 100], ['601318', 200], ['000001', 300]];
const COMP_B = [['600519', 30], ['300750', 500]];

function mkEtf(code, name, group, groupLabel, unit, nav, shares, comps) {
  return { code, name, group, groupLabel, nav, unit, navPerCu: null, cash: null, compCount: comps.length, shares, comps };
}
function writeSnap(date, etfs, settled, names) {
  const p = ef.snapPath(date);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ date, savedAt: new Date().toISOString(), settled: !!settled, etfs, stockNames: names || {} }), 'utf8');
}

// 基期 20261020：510300 100 亿份、510500 50 亿份
const DAY1 = [
  mkEtf('510300', '华泰柏瑞沪深300ETF', 'csi300', '沪深300', 900000, 4.0, 100e8, COMP_A),
  mkEtf('510500', '南方中证500ETF', 'csi500', '中证500', 900000, 6.0, 50e8, COMP_B),
];
// 20261021：510300 净申购 2 篮（+180 万份）、510500 净赎回 1 篮（-90 万份）
const DAY2 = [
  mkEtf('510300', '华泰柏瑞沪深300ETF', 'csi300', '沪深300', 900000, 4.1, 100e8 + 900000 * 2, COMP_A),
  mkEtf('510500', '南方中证500ETF', 'csi500', '中证500', 900000, 6.1, 50e8 - 900000 * 1, COMP_B),
];
const NAMES = { 600519: '贵州茅台', 601318: '中国平安', '000001': '平安银行', 300750: '宁德时代' };

console.log('\n[1] 只有一份快照 → 基线日');
{
  writeSnap('20261020', DAY1, true, NAMES);
  const r = ef.computeFromSnapshots('20261020');
  eq(r.ok, false, '无基期 → ok=false');
  eq(r.noPrev, true, '标记 noPrev（基线日）');
  ok(/基线/.test(r.reason || ''), '给出可读原因，不硬编净申赎');
  eq(r.etfs.length, 2, '基线日仍返回 ETF 清单（dShares 为空）');
  eq(r.etfs[0].dShares, null, '基线日 dShares=null');
}

console.log('\n[2] 两日定稿快照 → 净申赎与逐股增减');
{
  writeSnap('20261021', DAY2, true, NAMES);
  const r = ef.computeFromSnapshots('20261021');
  eq(r.ok, true, '算出结果');
  eq(r.baseDate, '20261019', '基期份额日=20261019（快照 20261020 的上一交易日）');
  const a = r.etfs.find(e => e.code === '510300');
  const b = r.etfs.find(e => e.code === '510500');
  eq(a.dShares, 1800000, '510300 Δ份额 = +180 万份');
  near(a.baskets, 2, 1e-9, '510300 篮数 = 2');
  near(a.netAmount, 1800000 * 4.1, 1, '510300 净申购额 = Δ份额 × 净值');
  eq(b.dShares, -900000, '510500 Δ份额 = -90 万份');
  near(b.baskets, -1, 1e-9, '510500 篮数 = -1');
  near(r.totalNet, 1800000 * 4.1 - 900000 * 6.1, 1, '合计净申赎额');

  const s1 = r.stocks.find(s => s.code === '600519');
  near(s1.dayBuy, 2 * 100, 1e-9, '600519 当日被买 2×100 股（沪深300 申购）');
  near(s1.daySell, -1 * 30, 1e-9, '600519 当日被卖 1×30 股（中证500 赎回）——同一只股票跨家族合并成一行');
  eq(s1.groups.length, 2, '600519 标注同时来自 2 个宽基家族');
  eq(s1.name, '贵州茅台', '逐股带上名称');
  near(r.stocks.find(s => s.code === '300750').daySell, -500, 1e-9, '300750 卖出 500 股');
  eq(r.stocks.find(s => s.code === '601318').name, '中国平安', '601318 名称正确');
  ok(r.groups.length === 2, '按家族汇总 2 组');
  near(r.groups.find(g => g.key === 'csi300').netAmount, 1800000 * 4.1, 1, '沪深300 组净申购额');
  near(r.groups.find(g => g.key === 'csi500').sellAmount, -900000 * 6.1, 1, '中证500 组净赎回额');
}

console.log('\n[3] 台账幂等');
{
  const before = JSON.parse(fs.readFileSync(ef.LEDGER, 'utf8'));
  const c0 = before.cum['600519'].buyShares;
  ef.computeFromSnapshots('20261021');
  const after = JSON.parse(fs.readFileSync(ef.LEDGER, 'utf8'));
  eq(after.cum['600519'].buyShares, c0, '同日重复计算不重复累加');
  eq(after.days, before.days, 'day 计数不变');
  eq(after.lastDate, '20261020', 'lastDate 按份额日停在 20261020');
}

console.log('\n[4] 盘中快照不进台账');
{
  // 20261022 只有盘中读数：settled=false
  const intra = [
    mkEtf('510300', '华泰柏瑞沪深300ETF', 'csi300', '沪深300', 900000, 4.2, 100e8 + 900000 * 5, COMP_A),
    mkEtf('510500', '南方中证500ETF', 'csi500', '中证500', 900000, 6.2, 50e8 - 900000 * 1, COMP_B),
  ];
  writeSnap('20261022', intra, false, NAMES);
  const r = ef.computeFromSnapshots('20261022');
  eq(r.ok, true, '盘中也能算出当日 Δ（预览）');
  eq(r.settled, false, '标记 settled=false');
  near(r.etfs.find(e => e.code === '510300').baskets, 3, 1e-9, '当日篮数=3（相对 20261021 定稿基期）');
  const led = JSON.parse(fs.readFileSync(ef.LEDGER, 'utf8'));
  eq(led.lastDate, '20261020', '台账未被盘中读数推进（仍为份额日 20261020）');
  near(led.cum['601318'].buyShares, 2 * 200, 1e-9, '累计值仍只有定稿日');
  eq(led.cum['601318'].buyDays, 1, 'buyDays 未因盘中多加一次');
}

console.log('\n[5] 基期只认定稿快照');
{
  // 20261023 定稿，但 20261022 是未定稿 → 基期应回落到 20261021
  const d23 = [
    mkEtf('510300', '华泰柏瑞沪深300ETF', 'csi300', '沪深300', 900000, 4.3, 100e8 + 900000 * 1, COMP_A),
    mkEtf('510500', '南方中证500ETF', 'csi500', '中证500', 900000, 6.3, 50e8 - 900000 * 1, COMP_B),
  ];
  writeSnap('20261023', d23, true, NAMES);
  const r = ef.computeFromSnapshots('20261023');
  eq(r.baseDate, '20261020', '跳过未定稿的 20261022，基期取 20261021 的份额日 20261020');
  near(r.etfs.find(e => e.code === '510300').baskets, -1, 1e-9, '篮数按 20261023 − 20261021 计算（−1 篮）');
}

console.log('\n[6] 逐股清单并集：已退出篮子不丢累计');
{
  // 20261026 的篮子只留 600519，601318 退出 → 其累计仍须出现
  const d26 = [
    mkEtf('510300', '华泰柏瑞沪深300ETF', 'csi300', '沪深300', 900000, 4.4, 100e8 + 900000 * 3, [['600519', 100]]),
  ];
  writeSnap('20261026', d26, true, NAMES);
  const r = ef.computeFromSnapshots('20261026');
  const gone = r.stocks.find(s => s.code === '601318');
  ok(!!gone, '601318 今日不在篮子，仍出现在清单里');
  near(gone.cumBuy, 2 * 200, 1e-9, '601318 累计值保留（2 篮 × 200 股）');
  eq(gone.dayBuy, 0, '今日增量为 0');
  eq(gone.name, '中国平安', '名称来自 stockNames');
  ok(r.stocks.every(s => typeof s.cumBuy === 'number' && typeof s.cumSell === 'number'), '所有行都有累计字段');
}

console.log('\n[7] scoreOf');
{
  eq(ef.scoreOf(0), 0, '0 → 0');
  ok(ef.scoreOf(1e12) <= 1 && ef.scoreOf(1e12) > 0.99, '极大正值 → 夹到 1');
  ok(ef.scoreOf(-1e12) >= -1 && ef.scoreOf(-1e12) < -0.99, '极大负值 → 夹到 -1');
  near(ef.scoreOf(0.5 * ef.SHARE_BASE), Math.tanh(0.5), 1e-6, '半基准 ≈ tanh(0.5)');
  ok(ef.scoreOf(null) === 0 && ef.scoreOf(NaN) === 0, '非法值 → 0');
  eq(ef.SHARE_BASE, 20e8, '基准 20 亿元');
}

console.log('\n[8] 接线守卫');
{
  const em = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketEmotionModel.js'), 'utf8');
  ok(/etfFlow:\s*\d+/.test(em), '情绪模型 BASE_WEIGHTS 含 etfFlow');
  ok(/etfFlow:\s*'[^']*ETF[^']*'/.test(em), 'FACTOR_NAMES 含 ETF 因子中文名');
  ok(/calcEtfFlow/.test(em), '存在 calcEtfFlow');
  ok(/key:\s*'etfFlow'/.test(em), '因子被 push 进 factors');
  const sv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/require\('\.\/lib\/etfFlow'\)/.test(sv), 'server 引入 etfFlow');
  ok(/etfFlow\.getEtfFlow/.test(sv), 'server 调用 getEtfFlow');
  ok(/\/api\/etf-flow/.test(sv), '提供 /api/etf-flow 路由');
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  ok(/_renderEtfFlowPane/.test(app), '前端有 ETF 申赎页签渲染');
  ok(/data-action="tp-tab"/.test(app), '页签按钮带 data-action="tp-tab"');
  ok(/_loadEtfFlow/.test(app) && /\/api\/etf-flow/.test(app), '前端拉 /api/etf-flow');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  ok(/\.tp-tabs\b/.test(css) && /\.etf-table\b/.test(css), '页签与表格样式已落地');
  const fl = fs.readFileSync(path.join(__dirname, '..', 'lib', 'etfFlow.js'), 'utf8');
  ok(/missCodes/.test(fl), '当日 PCF 缓存缺名单时只补抓新增 ETF 并回写缓存');
  ok(/KEEP_DAYS/.test(fl) && /pruneSnapshots/.test(fl), '快照有保留上限与清理');
  ok(/sessionSettled\(tradeDate\)/.test(fl), '快照落盘时打定稿标');
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
