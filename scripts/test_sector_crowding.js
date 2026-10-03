/**
 * 确定性单测：行业板块拥挤度多周期聚合（lib/sectorCrowding.js）
 * ---------------------------------------------------------------
 * 回归锁定 20261002a 修复：今日/本周/本月的「成交额」曾取成窗口最后一天的值 →
 * 三列恒等（不同时间长度累计成交额不可能一样）。
 * 现在应为区间聚合：
 *   成交额 = Σ 各日成交额（累计）
 *   拥挤度 = Σ 板块成交额 ÷ Σ 全市场成交额 ×100%
 *   涨跌幅 = Π(1 + 各日涨跌幅/100) - 1（复利累计）
 * 用 SA_SECTOR_CROWDING_FILE 指向临时文件，完全隔离，不读生产存盘、不联网。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TMP = path.join(__dirname, '__tmp_sector_crowding_test.json');
process.env.SA_SECTOR_CROWDING_FILE = TMP;

// 25 个连续日期（字符串升序 == 时间升序）
const dates = [];
for (let i = 0; i < 25; i++) {
  const d = new Date(Date.UTC(2026, 8, 1 + i)); // 2026-09-01 .. 2026-09-25
  dates.push(d.toISOString().slice(0, 10));
}

// 合成存盘：每日 marketTotal=10000；半导体 amount=1000+j*10（j 为第 j 个交易日）、日涨跌 +1%；
// 通信设备恒 500、日涨跌 0。crowding 按 recordDaily 的口径填充（amount/marketTotal*100），
// 否则 _topToday 直接读存盘 crowding 会得到 0，导致「当日拥挤度」断言失真。
const store = {};
dates.forEach((d, idx) => {
  const j = idx + 1;
  const semiAmount = 1000 + j * 10;
  store[d] = {
    marketTotal: 10000,
    sectors: [
      { name: '半导体', amount: semiAmount, crowding: Math.round((semiAmount / 10000) * 10000) / 100, changePct: 1 },
      { name: '通信设备', amount: 500, crowding: 5, changePct: 0 },
    ],
    recordedAt: new Date().toISOString(),
  };
});
fs.writeFileSync(TMP, JSON.stringify(store, null, 2), 'utf8');

const { getCrowding } = require('../lib/sectorCrowding');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}
function pick(list, name) { return (list || []).find(x => x.name === name); }

try {
  const out = getCrowding(); // 不传实时板块 → today 取存盘最新一天

  const tSemi = pick(out.today, '半导体');
  const wSemi = pick(out.week, '半导体');
  const mSemi = pick(out.month, '半导体');

  // —— 窗口长度 ——
  ok(out.weekDates.length === 5, `本周窗口=5 个交易日（实际 ${out.weekDates.length}）`);
  ok(out.monthDates.length === 21, `本月窗口=21 个交易日（实际 ${out.monthDates.length}）`);

  // —— 成交额为区间累计（核心回归点）——
  ok(tSemi && tSemi.amount === 1250, `当日成交额=单日值 1250（实际 ${tSemi && tSemi.amount}）`);
  ok(wSemi && wSemi.amount === 6150, `本周成交额=5 日累计 6150（实际 ${wSemi && wSemi.amount}）`);
  ok(mSemi && mSemi.amount === 24150, `本月成交额=21 日累计 24150（实际 ${mSemi && mSemi.amount}）`);
  ok(tSemi.amount !== wSemi.amount && wSemi.amount !== mSemi.amount && tSemi.amount !== mSemi.amount,
    '三列成交额互不相同（旧 bug：三列恒等）');

  // —— 拥挤度 = 区间成交额占比 ——
  ok(tSemi.crowding === 12.5, `当日拥挤度=12.50%（实际 ${tSemi.crowding}）`);
  ok(wSemi.crowding === 12.3, `本周拥挤度=12.30%（实际 ${wSemi.crowding}）`);
  ok(mSemi.crowding === 11.5, `本月拥挤度=11.50%（实际 ${mSemi.crowding}）`);

  // —— 涨跌幅 = 区间复利累计 ——
  ok(tSemi.changePct === 1, `当日涨跌幅=+1.00%（实际 ${tSemi.changePct}）`);
  ok(wSemi.changePct === 5.1, `本周涨跌幅=1.01^5-1=+5.10%（实际 ${wSemi.changePct}）`);
  ok(mSemi.changePct === 23.24, `本月涨跌幅=1.01^21-1=+23.24%（实际 ${mSemi.changePct}）`);
  ok(tSemi.changePct !== wSemi.changePct && wSemi.changePct !== mSemi.changePct,
    '三列涨跌幅互不相同（旧 bug：三列恒等）');

  // —— 排序：区间拥挤度降序，半导体(>5%) 应压过恒 5% 的通信设备 ——
  ok(out.week[0].name === '半导体', '本周榜首=半导体（区间拥挤度降序）');
  ok(out.month[0].name === '半导体', '本月榜首=半导体（区间拥挤度降序）');

  // —— 常量板块（每日 500）区间累计口径自洽 ——
  const wComm = pick(out.week, '通信设备');
  ok(wComm.amount === 2500, `通信设备本周=5×500=2500（实际 ${wComm && wComm.amount}）`);
  ok(wComm.crowding === 5, `通信设备本周拥挤度=2500/50000=5.00%（实际 ${wComm && wComm.crowding}）`);
  ok(pick(out.month, '通信设备').amount === 10500, '通信设备本月=21×500=10500');
} catch (e) {
  fail++;
  console.log('  ✗ 异常：' + (e && e.message));
} finally {
  try { fs.unlinkSync(TMP); } catch (_) { /* ignore */ }
}

console.log(`===== test_sector_crowding 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
