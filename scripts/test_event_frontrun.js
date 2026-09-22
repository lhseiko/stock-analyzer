// 单元测试：事件驱动引擎 · 内幕抢跑检查（checkInsiderFrontRun）
// 设计要点（用户 20260922 校正）：仅事件触发、锚定事件前 3 日、方向一致且幅度≥2.5% 才判抢跑。
// 运行：node scripts/test_event_frontrun.js
const assert = require('assert');
const { checkInsiderFrontRun } = require('../lib/eventEngine');

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

// 事件前 3 个交易日（严格早于 anchorDate=2026-09-22）
const mkHist = (c1, c2, c3) => [
  { date: '2026-09-15', close: 100 },
  { date: '2026-09-17', close: c1 }, // 事件前第3日
  { date: '2026-09-18', close: c2 }, // 事件前第2日
  { date: '2026-09-19', close: c3 }, // 事件前第1日（紧邻事件）
  { date: '2026-09-22', close: 110 }, // 事件日（不含入回溯）
];
const evBase = (signal) => ({ id: 'evt_test', title: '测试事件', signal, createdAt: new Date('2026-09-22T09:30:00').toISOString() });

console.log('内幕抢跑检查 · 分支覆盖：');

// 1. 历史不足 → 不触发
check('历史不足时不触发', checkInsiderFrontRun('X', evBase(1), []).detected === false);
check('历史<4根不触发', checkInsiderFrontRun('X', evBase(1), [{ date: '2026-09-19', close: 105 }]).detected === false);

// 2. 合成事件（原油主连 isSynthetic）跳过
check('合成事件跳过', checkInsiderFrontRun('X', { ...evBase(1), isSynthetic: true }, mkHist(100, 103, 105)).detected === false);

// 3. 无 createdAt 不触发
check('无事件时间不触发', checkInsiderFrontRun('X', { id: 'e', signal: 1 }, mkHist(100, 103, 105)).detected === false);

// 4. 方向不一致（利好事件但事件前下跌）→ 不触发
{
  const r = checkInsiderFrontRun('X', evBase(1), mkHist(100, 98, 96)); // 事件前 -4%
  check('方向不一致不触发', r.detected === false && r.reason === '方向不一致');
}

// 5. 提前反应幅度不足（<2.5%）→ 不触发
{
  const r = checkInsiderFrontRun('X', evBase(1), mkHist(100, 101, 102)); // 事件前 +2%
  check('幅度不足不触发', r.detected === false && r.reason === '提前反应幅度不足');
}

// 6. 利好透支（事件前上涨≥2.5%）→ 触发，signal=-0.4，下调比例正确
{
  const r = checkInsiderFrontRun('X', evBase(1), mkHist(100, 103, 105)); // 事件前 +5%
  check('利好透支触发', r.detected === true);
  check('利好透支 signal=-0.4', r.signal === -0.4);
  check('利好透支 tone=利好透支', r.tone === '利好透支，边际偏空');
  check('利好透支下调25%（retain0.75）', r.cutPct === 25);
  check('利好透支 preChg=+5%', Math.abs(r.preChg - 5) < 1e-9);
}

// 7. 利空出尽（利空事件但事件前已跌≥2.5%）→ 触发，signal=+0.4
{
  const r = checkInsiderFrontRun('X', evBase(-1), mkHist(100, 97, 95)); // 事件前 -5%
  check('利空出尽触发', r.detected === true);
  check('利空出尽 signal=+0.4', r.signal === 0.4);
  check('利空出尽 tone=利空出尽', r.tone === '利空出尽，边际偏多');
  check('利空出尽下调25%', r.cutPct === 25);
}

// 8. 保留率封底（抢跑≥17% → cutPct=85）
{
  const r = checkInsiderFrontRun('X', evBase(1), mkHist(100, 110, 120)); // 事件前 +20%
  check('大额抢跑封底 cutPct=85', r.cutPct === 85);
  check('大额抢跑 retain=0.15', Math.abs(r.preChg - 20) < 1e-9);
}

// 9. 事件前交易日不足 3 个 → 不触发
{
  const shortHist = [
    { date: '2026-09-18', close: 103 },
    { date: '2026-09-19', close: 105 },
    { date: '2026-09-22', close: 110 },
  ];
  check('事件前不足3交易日不触发', checkInsiderFrontRun('X', evBase(1), shortHist).detected === false);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
