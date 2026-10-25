/**
 * 非交易日数据口径守卫（20261024k）
 * 运行： node scripts/test_non_trading_day_policy.js
 *
 * 用户要求（2026-10-24）：非交易日无法获取「当日」数据应判定为正常，
 * 沿用最后一个交易日的数据即可，不能因为非交易日没有当日数据而判定数据不足。
 *
 * 本测试锁定：
 *   1) 统一口径 asOfTradingDate / isDataCurrent（非交易日 → 最近交易日）；
 *   2) 板块拥挤度落盘：数据日期=最近交易日 → 正常（沿用）；明显滞后 → 拒绝；
 *   3) 板块涨幅榜：按最近交易日为键（不产生周末伪日期）；
 *   4) 量能引擎「未包含今日数据」在非交易日 = 中性说明（非真缺口），真实滞后才进红框。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), 'sa_sector_crowding_policy_test_' + process.pid + '.json');
process.env.SA_SECTOR_CROWDING_FILE = TMP;

const cal = require('../lib/cnTradingCalendar');
const sc = require('../lib/sectorCrowding');
const ve = require('../lib/volumeEngine');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

function todayStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

console.log('\n[1] asOfTradingDate：非交易日 → 最近交易日');
{
  ok(cal.asOfTradingDate('2026-10-24') === '2026-10-23', '周六 10-24 → 最近交易日 10-23');
  ok(cal.asOfTradingDate('2026-10-25') === '2026-10-23', '周日 10-25 → 最近交易日 10-23');
  ok(cal.asOfTradingDate('2026-10-23') === '2026-10-23', '周五 10-23（交易日）→ 自身');
  ok(cal.asOfTradingDate('2026-10-01') === '2026-09-30', '国庆 10-01（周四，休市）→ 09-30');
  ok(cal.asOfTradingDate('2026-10-05') === '2026-09-30', '国庆 10-05（周一，休市）→ 09-30');
}

console.log('\n[2] isDataCurrent：沿用最近交易日即视为最新');
{
  ok(cal.isDataCurrent('2026-10-23', '2026-10-24') === true, '周六看 10-23 数据 → 最新（正常）');
  ok(cal.isDataCurrent('2026-10-22', '2026-10-24') === false, '周六但只有 10-22 → 落后最近交易日 → 陈旧');
  ok(cal.isDataCurrent('2026-10-22', '2026-10-23') === false, '交易日 10-23 看 10-22 → 陈旧');
  ok(cal.isDataCurrent('2026-10-23', '2026-10-23') === true, '交易日看当日 → 最新');
  ok(cal.isDataCurrent(null, '2026-10-24') === false, '无数据日期 → false');
}

console.log('\n[3] 板块拥挤度：非交易日沿用最近交易日数据（不判缺数据）');
{
  const asOf = cal.asOfTradingDate(todayStr());
  const sectors = [
    { name: '银行', amount: 100, changePct: 1.0 },
    { name: '证券', amount: 50, changePct: -0.5 },
  ];
  const rec = sc.recordDaily(sectors, asOf);
  ok(rec && Array.isArray(rec.sectors) && rec.sectors.length === 2, `dataDate=最近交易日(${asOf}) → 正常落盘（沿用）`);
  const recOld = sc.recordDaily(sectors, '2000-01-01');
  ok(recOld === null, '明显滞后的数据日期 → 拒绝（不污染历史）');
  const recNone = sc.recordDaily(sectors, '');
  ok(recNone === null, '无数据日期 → 拒绝');
}

console.log('\n[4] 源码守卫：涨幅榜按最近交易日为键 / 补写守卫含非交易日分支');
{
  const srh = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sectorRankHistory.js'), 'utf8');
  ok(srh.includes('asOfTradingDate(localDate())'), 'sectorRankHistory 以 asOfTradingDate 为键（不产生周末伪日期）');
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  ok(/ensureSectorCrowdingToday[\s\S]{0,900}asOfTradingDate/.test(srv), 'ensureSectorCrowdingToday 使用 asOfTradingDate');
  ok(/dow === 0 \|\| dow === 6\)[\s\S]{0,300}sectorCrowdingHasDate\(asOf\)/.test(srv), '周末分支确保最近交易日记录存在');
  const scSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sectorCrowding.js'), 'utf8');
  ok(scSrc.includes('dataDate !== asOf'), 'recordDaily 以最近交易日为落盘门槛');
}

console.log('\n[5] 量能引擎：周末末根=最近交易日 → 中性说明（非真缺口）');
{
  const TRUE_GAP_RE = /数据不足|样本仅|不足 ?250|推算值|未包含今日|未包含最近交易日|窗口仅/;
  const tNeutral = ve._staleBarGapText('2026-10-23', '2026-10-24');
  ok(/非交易日/.test(tNeutral) && !TRUE_GAP_RE.test(tNeutral), '周六 + 末根 10-23 → 中性（不进红框）');
  const tGap = ve._staleBarGapText('2026-10-22', '2026-10-24');
  ok(/未包含最近交易日 2026-10-23/.test(tGap) && TRUE_GAP_RE.test(tGap), '周六 + 末根 10-22 → 真缺口（真实滞后）');
}

try { fs.unlinkSync(TMP); } catch (e) {}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
