/**
 * 量价信号接线守卫（20260921c）
 * ------------------------------------------------------------------
 * 背景：量价信号名分散在 3 个文件共 4 处（后端两张评分表 + 前端配色/计分），
 *   任一处漏改都会造成「文案/配色/评分」口径不一致。
 *   用户 2026-09-21 实际发现：圣湘生物「显著上涨」文案写「谨防冲高回落」，
 *   评级却是「利好 +1」——根因就是"大涨+平量(量比0.8~1.2)"被当成正分。
 * 本守卫锁定：
 *   1) 「大涨+平量」= 量价背离 → 中性(0)，不再算利好；
 *   2) 新信号名「大涨平量」四处齐全；
 *   3) 旧名「显著上涨」不得残留在活动代码（注释除外）。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const root = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('[PASS] ' + m); } else { fail++; console.log('[FAIL] ' + m); } };

const capPath = path.join(root, 'lib', 'capitalFlow.js');
const sdjPath = path.join(root, 'lib', 'sameDayJudgment.js');
const ccPath = path.join(root, 'public', 'js', 'capitalCharts.js');
const cap = fs.readFileSync(capPath, 'utf8');
const sdj = fs.readFileSync(sdjPath, 'utf8');
const cc = fs.readFileSync(ccPath, 'utf8');

// 去掉行注释后再查，避免把说明文字里的旧名误判为活动代码
const strip = s => s.replace(/\/\/[^\n\r]*/g, '');

// ---- 1) 旧名「显著上涨」不得残留在活动代码 ----
ok(!/'显著上涨'\s*:/.test(strip(cap)), 'capitalFlow 活动代码无「显著上涨」映射');
ok(!/'显著上涨'\s*:/.test(strip(sdj)), 'sameDayJudgment 活动代码无「显著上涨」映射');
ok(!/'显著上涨'/.test(strip(cc)), 'capitalCharts 活动代码无「显著上涨」映射');

// ---- 2) 新名「大涨平量」四处齐全 ----
ok(/\?\s*'大涨平量'\s*:\s*'温和上涨'/.test(cap), 'capitalFlow 分支：bigUp 取「大涨平量」（否则温和上涨）');
ok(/['"]大涨平量['"]\s*:\s*0\s*,/.test(cap), 'capitalFlow VP_MAP：「大涨平量」= 0（中性）');
ok(/['"]大涨平量['"]\s*:\s*0\s*,/.test(sdj), 'sameDayJudgment vpSigMap：「大涨平量」= 0（中性）');
ok(/['"]大涨平量['"]\s*:\s*'cap-neutral'/.test(cc), 'capitalCharts 配色：「大涨平量」= cap-neutral');
ok(!/\[\s*'放量上涨',\s*'量价齐升',\s*'大涨平量'/.test(cc), 'capitalCharts 多空计分未把「大涨平量」计入多头');

// ---- 3) 运行时：实际分支行为 ----
let computeVolumeIndicators = null;
try {
  const src = cap + '\nmodule.exports.__test = { computeVolumeIndicators };\n';
  const m = new Module(capPath);
  m.filename = capPath;
  m.paths = Module._nodeModulePaths(path.join(root, 'lib'));
  m._compile(src, capPath);
  computeVolumeIndicators = m.exports.__test.computeVolumeIndicators;
} catch (e) {
  console.log('[FAIL] 无法装载 computeVolumeIndicators: ' + e.message);
  fail++;
}

function makeHistory(chgPct, volRatio) {
  const bars = [];
  for (let i = 0; i < 29; i++) {
    bars.push({ date: '2026-08-' + String(i + 1).padStart(2, '0'), open: 16, high: 16.1, low: 15.9, close: 16, volume: 1000000 });
  }
  const prev = 16;
  const close = prev * (1 + chgPct / 100);
  bars.push({ date: '2026-09-18', open: prev, high: close, low: prev, close, volume: Math.round(1000000 * volRatio) });
  return bars;
}

if (computeVolumeIndicators) {
  const runtimeCases = [
    { chg: 3.05, vol: 1.13, expect: '大涨平量', note: '圣湘生物实测：大涨+平量 → 中性' },
    { chg: 3.05, vol: 1.60, expect: '放量上涨', note: '放量大涨仍属利好' },
    { chg: 3.05, vol: 1.30, expect: '量价齐升', note: '量价齐升仍属利好' },
    { chg: 1.20, vol: 1.00, expect: '温和上涨', note: '小涨+平量不受影响' },
    { chg: 3.05, vol: 0.65, expect: '缩量上涨', note: '缩量大涨仍偏空' },
  ];
  for (const c of runtimeCases) {
    let got = '(err)';
    try {
      const vi = computeVolumeIndicators(makeHistory(c.chg, c.vol), null, null);
      got = (vi && vi.volumePrice && vi.volumePrice.signal) || '(null)';
    } catch (e) { got = 'ERR:' + e.message; }
    ok(got === c.expect, `运行时 涨${c.chg}%/量比${c.vol} → 「${got}」（期望 ${c.expect}）· ${c.note}`);
  }
}

console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
