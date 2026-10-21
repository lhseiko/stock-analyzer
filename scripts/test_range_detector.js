/**
 * 单箱体模型回归（20261020j，零网络，全合成数据）
 * ==================================================================
 * 运行： node scripts/test_range_detector.js
 * 覆盖 lib/rangeDetector.js（用户 2026-10-20 单箱体口径）：
 *   [1] 日K不足 20 根 → insufficient（不猜箱体）
 *   [2] 最近 20 个交易日形成箱体（中轴=中位数、容差 ±10%）
 *   [3] 无固定长度上限：只要没失效就一直向前延长（55 日仍是同一个箱体）
 *   [4] 容差随长度放宽：tolPctFor 纯函数 20→10、40→14.14、45/80→15（封顶）
 *   [5] 放宽后的带宽确实能容纳更宽波动（11.4 超过 ±10% 但被 ±15% 收下）
 *   [6] 20 日种子振幅超容差 → 不构成箱体（noBox，附最大偏离）
 *   [7] 连续 3 日突破 → 失效（向上），并披露失效日/方向/边界
 *   [8] 只破 2 日后收回 → 不失效，计 1 次假突破
 *   [9] 失效判定与成交量完全无关（放量/缩量/无量结果一致）
 *   [10] 失效后必须重新积累 20 个交易日才能形成下一个箱体
 *   [11] 600909 形态夹具：55 日 7.03~8.54（振幅 19.36%）→ 成立（旧多窗口模型会否）
 *   [12] 旧多窗口API/字段已彻底移除（防回滚）
 *   [13] 与 zoneValidity 完全独立（源码级断言，双向不引用）
 *   [14] 端点：收盘 == 带边界视为箱体内；脏数据（null/0/空串）被过滤
 */
const fs = require('fs');
const path = require('path');
const rd = require('../lib/rangeDetector');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(a === b, `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);
const near = (a, b, tol, msg) => ok(typeof a === 'number' && Math.abs(a - b) <= tol, `${msg}（期望 ≈${b}，实际 ${a}）`);

// 合成日K：默认 high=low=close（不含盘中噪声），便于精确断言
function mk(closes, opt = {}) {
  return closes.map((c, i) => {
    const d = new Date(Date.UTC(2026, 5, 1) + i * 86400000);
    const b = {
      date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`,
      open: c,
      high: opt.highs ? opt.highs[i] : c,
      low: opt.lows ? opt.lows[i] : c,
      close: c,
      volume: Array.isArray(opt.volume) ? opt.volume[i] : (opt.volume == null ? 10000 : opt.volume),
    };
    if (opt.noVolume) delete b.volume;
    return b;
  });
}

// 20 根紧密震荡收盘（中位数恰为 10，最大偏离 2%）
const SEED20 = [10, 10.2, 9.8, 10.1, 9.9, 10, 10.2, 9.8, 10.05, 9.95, 10, 10.2, 9.8, 10.1, 9.9, 10, 10.2, 9.8, 10.05, 9.95];

// ============ [1] 数据不足 ============
console.log('\n[1] 日K不足 20 根 → insufficient');
{
  const r = rd.detectSingleRange(mk(SEED20.slice(0, 19)));
  eq(r.state, 'insufficient', '19 根 → 数据不足');
  eq(r.ok, false, 'ok=false');
  eq(r.need, 20, '需要 20 根');
  eq(r.barsUsed, 19, '实际 19 根');
  const r0 = rd.detectSingleRange([]);
  eq(r0.barsUsed, 0, '空数组 → 0 根');
  eq(r0.date, null, '空数组 date=null');
  eq(rd.detectSingleRange(null).state, 'insufficient', 'null 入参不抛错');
  eq(rd.detectSingleRange(undefined).state, 'insufficient', 'undefined 入参不抛错');
}

// ============ [2] 20 日形成箱体 ============
console.log('\n[2] 最近 20 个交易日形成箱体（中轴=收盘中位数）');
{
  const r = rd.detectSingleRange(mk(SEED20));
  eq(r.state, 'active', '20 日紧密震荡 → 形成箱体');
  eq(r.box.days, 20, '箱体长度=20');
  eq(r.box.mid, 10, '中轴=10（收盘中位数）');
  eq(r.box.tolPct, 10, '容差=±10%');
  eq(r.box.bandL, 9, '下沿 9');
  eq(r.box.bandU, 11, '上沿 11');
  eq(r.box.envL, 9.8, '收盘包络低 9.8');
  eq(r.box.envU, 10.2, '收盘包络高 10.2');
  eq(r.box.halfDevPct, 2, '最大半幅偏离 2%');
  eq(r.box.fakeBreaks, 0, '假突破 0');
  eq(r.box.maxOutStreak, 0, '最大连续在外 0 日');
  eq(r.invalidation.currentStreak, 0, '当前在外 0 日');
  eq(r.invalidation.remainDays, null, '未越界 → 不产生倒计时（remainDays=null，防「距失效还需 3 日」误解）');
  eq(r.invalidation.currentStreak, 0, '未触发失效条件');
  ok(r.conclusion.includes('箱体自') && r.conclusion.includes('延续 20 个交易日'), `结论含「延续 20 个交易日」：${r.conclusion}`);
  ok(r.invalidation.note.includes('当前收盘在箱体内'), '失效提示：当前在箱体内');
}

// ============ [3] 无固定长度上限 ============
console.log('\n[3] 无固定长度上限 → 未失效就一直延长');
{
  // 20 根种子 + 35 根仍在 9.8~10.2 内震荡 = 55 根
  const tail = [];
  for (let i = 0; i < 35; i++) tail.push([10, 10.2, 9.8, 10.1, 9.9][i % 5]);
  const r = rd.detectSingleRange(mk(SEED20.concat(tail)));
  eq(r.state, 'active', '55 根仍为同一个活动箱体');
  eq(r.box.days, 55, '箱体长度=55（不是 60/120 之类的固定窗口）');
  eq(r.box.startDate, r.date === null ? null : r.box.startDate, '起始日存在');
  eq(r.box.tolPct, 15, '55 日 → 容差已放宽并封顶 ±15%');
  eq(r.box.bandL, 8.5, '下沿 8.5（10×0.85）');
  eq(r.box.bandU, 11.5, '上沿 11.5（10×1.15）');
  eq(r.barsUsed, 55, '扫描根数 55');
}

// ============ [4] 容差放宽纯函数 ============
console.log('\n[4] tolPctFor：20 日 ±10%，按 √(天/20) 放宽，封顶 ±15%');
{
  eq(rd.tolPctFor(20), 10, '20 日 → 10');
  eq(rd.tolPctFor(40), 14.14, '40 日 → 10×√2 = 14.14');
  eq(rd.tolPctFor(45), 15, '45 日 → 10×√2.25 = 15');
  eq(rd.tolPctFor(80), 15, '80 日 → 名义 20，封顶 15');
  eq(rd.tolPctFor(500), 15, '500 日 → 仍封顶 15');
  eq(rd.tolPctFor(5), 10, '不足 20 日 → 下限 10（不会更窄）');
  eq(rd.tolPctFor(null), 10, 'null → 10');
  eq(rd.tolPctFor(0), 10, '0 → 10');
  ok(rd.tolPctFor(30) > rd.tolPctFor(20), '容差随长度单调放宽（30 > 20）');
  ok(rd.tolPctFor(1000) <= rd.TOL_CAP_PCT, '永不超过上限常量');
  eq(rd.bandOf(10, 10).L, 9, 'bandOf(10,10).L = 9');
  eq(rd.bandOf(10, 10).U, 11, 'bandOf(10,10).U = 11');
  eq(rd.bandOf(7.8, 15).L, 6.63, 'bandOf(7.8,15).L = 6.63');
  eq(rd.bandOf(7.8, 15).U, 8.97, 'bandOf(7.8,15).U = 8.97');
  eq(rd.median([]), null, 'median([]) = null');
  eq(rd.median([1, 2, 3]), 2, 'median 奇数取中');
  eq(rd.median([1, 2, 3, 4]), 2.5, 'median 偶数取均值');
}

// ============ [5] 放宽后的带宽确实容纳更宽波动 ============
console.log('\n[5] 容差放宽的实效：11.4 超过 ±10% 基准带宽，但被 ±15% 收下');
{
  const mid = [];
  for (let i = 0; i < 24; i++) mid.push(10.2);   // 第 21~44 日
  const wide = [];
  for (let i = 0; i < 36; i++) wide.push(11.4);  // 第 45~80 日
  const r = rd.detectSingleRange(mk(SEED20.concat(mid, wide)));
  eq(r.state, 'active', '80 日仍为同一箱体');
  eq(r.box.days, 80, '箱体延伸至 80 日');
  eq(r.box.tolPct, 15, '容差 ±15%');
  eq(r.box.bandU, 11.5, '上沿 11.5');
  ok(11.4 > 10 * 1.10, '11.4 > 基准 ±10% 上沿 11.0（放宽前会被判越界）');
  ok(11.4 <= r.box.bandU, '11.4 ≤ 放宽后上沿 11.5（被容纳）');
  eq(r.box.envU, 11.4, '收盘包络高 11.4');
  eq(r.box.halfDevPct, 14, '最大半幅偏离 14%');
  eq(r.box.maxOutStreak, 0, '全程无越界日');
}

// ============ [6] 种子振幅过大 → 不构成箱体 ============
console.log('\n[6] 20 日种子振幅超容差 → 不构成箱体（不猜）');
{
  const wild = [9.0, 9.2, 9.4, 9.6, 9.8, 10.0, 10.2, 10.4, 10.6, 10.8, 11.0, 11.2, 11.4, 11.6, 11.8, 12.0, 11.0, 10.0, 9.5, 10.5];
  const r = rd.detectSingleRange(mk(wild));
  eq(r.state, 'noBox', '振幅 14.83% > 10% → 无箱体');
  eq(r.ok, true, 'ok=true（查询成功，只是没有箱体）');
  eq(r.lastInvalid, null, '从未形成过箱体 → lastInvalid=null');
  ok(r.conclusion.includes('未形成过箱体'), '结论说明未形成过箱体');
  ok(r.conclusion.includes('14.83'), `结论披露最大偏离 14.83%：${r.conclusion}`);
  eq(r.nextFormation.seedDays, 20, '需 20 日种子');
}

// ============ [7] 连续 3 日突破 → 失效 ============
console.log('\n[7] 连续 3 日收盘突破上沿 → 箱体失效');
{
  const r = rd.detectSingleRange(mk(SEED20.concat([12, 12, 12])));
  eq(r.state, 'noBox', '失效后 → 无活动箱体');
  ok(!!r.lastInvalid, '带出已失效箱体');
  eq(r.lastInvalid.days, 20, '失效箱体长度=20（只算有效段）');
  eq(r.lastInvalid.invalidStreak, 3, '连续在外 3 日');
  eq(r.lastInvalid.invalidDir, '向上', '突破方向=向上');
  eq(r.lastInvalid.invalidClose, 12, '失效日收盘 12');
  eq(r.lastInvalid.invalidLevel, 11, '突破的边界=11');
  eq(r.lastInvalid.bandU, 11, '箱体上沿 11');
  ok(r.conclusion.includes('失效') && r.conclusion.includes('连续 3 日'), `结论说明连续 3 日失效：${r.conclusion}`);
  const down = rd.detectSingleRange(mk(SEED20.concat([8, 8, 8])));
  eq(down.lastInvalid.invalidDir, '向下', '向下突破 → 方向=向下');
  eq(down.lastInvalid.invalidLevel, 9, '向下突破边界=9');
}

// ============ [8] 只破 2 日后收回 = 假突破，不失效 ============
console.log('\n[8] 连续 2 日突破后收回 → 不失效，计 1 次假突破');
{
  const r = rd.detectSingleRange(mk(SEED20.concat([12, 12, 10])));
  eq(r.state, 'active', '2 日未达 3 日门槛 → 箱体仍有效');
  eq(r.box.days, 23, '箱体延伸至 23 日（含 2 个越界日）');
  eq(r.box.fakeBreaks, 1, '假突破 1 次');
  eq(r.box.outSegments, 1, '越界段 1 段（2 天算 1 段）');
  eq(r.box.maxOutStreak, 2, '历史最大连续在外 2 日');
  eq(r.invalidation.currentStreak, 0, '当前已收回 → 在外 0 日');
  eq(r.invalidation.remainDays, null, '已收回 → 倒计时归 null（须重新累计 3 日）');
  eq(r.box.envL, 9.8, '包络低 9.8');
  eq(r.box.envU, 12, '包络高 12（越界日也进包络披露）');

  // 越界 1 日（箱体未失效）→ 倒计时才真的存在：remainDays = 2
  const one = rd.detectSingleRange(mk(SEED20.concat([12])));
  eq(one.invalidation.currentStreak, 1, '已连续 1 日在失效线外');
  eq(one.invalidation.remainDays, 2, '再有 2 日失效（只有越界时才倒数）');
  ok(one.invalidation.note.includes('已连续 1 日'), `提示说明已连续在外：${one.invalidation.note}`);
}

// ============ [9] 与成交量无关 ============
console.log('\n[9] 失效判定与成交量完全无关（用户：无论是否放量）');
{
  const closes = SEED20.concat([12, 12, 12]);
  const base = rd.detectSingleRange(mk(closes));
  const huge = rd.detectSingleRange(mk(closes, { volume: [1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8, 1e8] }));
  const tiny = rd.detectSingleRange(mk(closes, { volume: 1 }));
  const none = rd.detectSingleRange(mk(closes, { noVolume: true }));
  eq(huge.state, 'noBox', '放天量突破 → 同样失效');
  eq(tiny.state, 'noBox', '极度缩量突破 → 同样失效');
  eq(none.state, 'noBox', '完全无成交量字段 → 同样失效');
  eq(huge.lastInvalid.invalidStreak, base.lastInvalid.invalidStreak, '放量与基准失效天数一致');
  eq(none.lastInvalid.invalidDate, base.lastInvalid.invalidDate, '无量与基准失效日一致');
  // 反证：箱体「形成」也不看量
  eq(rd.detectSingleRange(mk(SEED20, { volume: 1 })).state, 'active', '极度缩量下 20 日种子照常成立');
}

// ============ [10] 失效后重新积累 20 日 ============
console.log('\n[10] 失效后必须重新积累 20 个交易日才能形成下一个箱体');
{
  const after = [];
  for (let i = 0; i < 20; i++) after.push(10);   // 失效后 20 个交易日均回到 10
  const closes = SEED20.concat([12, 12, 12], after);
  // 前 42 根：最后一天是失效后第 19 个交易日 → 种子窗口仍含 12，形不成
  const r42 = rd.detectSingleRange(mk(closes.slice(0, 42)));
  eq(r42.state, 'noBox', '失效后第 19 日 → 仍未形成新箱体');
  eq(r42.nextFormation.elapsed, 19, '已过 19 个交易日');
  eq(r42.nextFormation.remaining, 1, '还差 1 日');
  ok(r42.conclusion.includes('还差 1 日'), `结论说明还差 1 日：${r42.conclusion}`);
  // 再补 1 根：第 20 日 → 20 根全部为 10，形成新箱体
  const r43 = rd.detectSingleRange(mk(closes));
  eq(r43.state, 'active', '失效后第 20 日 → 形成新箱体');
  eq(r43.box.days, 20, '新箱体长度=20');
  eq(r43.box.startDate, mk(closes)[22 + 1].date, '新箱体起点=失效日之后第一个交易日');
  eq(r43.lastInvalid, undefined, '新箱体成立后不再返回 lastInvalid');
}

// ============ [11] 600909 形态夹具 ============
console.log('\n[11] 600909（华安证券）形态：55 日 7.03~8.54，振幅 19.36% → 成立');
{
  const cycle = [7.45, 7.8, 8.2, 8.54, 7.03];   // 每 5 日一循环，末值 7.03 = 今日
  const closes = [];
  for (let i = 0; i < 11; i++) closes.push(...cycle);
  const bars = mk(closes);
  eq(closes.length, 55, '夹具 55 个交易日');
  eq(closes[54], 7.03, '最新收盘 7.03（与截图一致）');
  const r = rd.detectSingleRange(bars);
  eq(r.state, 'active', '该形态构成箱体（旧多窗口模型因振幅 19.4%>16.8% 判定不构成）');
  eq(r.box.days, 55, '箱体长度=55（自 20 日种子起一直延长）');
  eq(r.box.mid, 7.8, '中轴=7.8');
  eq(r.box.envL, 7.03, '包络低 7.03');
  eq(r.box.envU, 8.54, '包络高 8.54');
  eq(r.box.tolPct, 15, '55 日容差 ±15%（已封顶）');
  eq(r.box.ampEnvPct, 19.36, '实测包络振幅 19.36%（旧模型据此误否）');
  eq(r.box.halfDevPct, 9.87, '最大半幅偏离 9.87% ≤ 种子基准 10%');
  eq(r.box.maxOutStreak, 0, '全程无越界日');
  eq(r.box.fakeBreaks, 0, '假突破 0');
  eq(r.box.bandL, 6.63, '下沿 6.63（7.8×0.85）');
  eq(r.box.bandU, 8.97, '上沿 8.97（7.8×1.15）');
  ok(7.03 > r.box.bandL && 8.54 < r.box.bandU, '真实最高 8.54 / 最低 7.03 都落在放宽后的带内');
  ok(r.box.ampEnvPct > 10, '包络振幅 19.36% 已超过 20 日种子 ±10% 带宽 → 靠「随长度放宽」容纳');
}

// ============ [12] 旧多窗口 API 已彻底移除 ============
console.log('\n[12] 旧「固定多窗口」API 与字段已彻底移除（防回滚）');
{
  const legacy = ['detectRanges', 'measureRange', 'measureDrift', 'scoreStability', 'annualizedVol', 'resolveAmpMax', 'ampGrade', 'mergeZoneLevels', 'WINDOWS', 'MAIN_WINDOW_DAYS'];
  legacy.forEach(k => eq(rd[k], undefined, `不再导出 ${k}`));
  const r = rd.detectSingleRange(mk(SEED20));
  ['ranges', 'windows', 'best', 'main', 'consistency', 'ampGrade', 'score', 'confidence'].forEach(k => {
    eq(r[k], undefined, `结果不再含旧字段 ${k}`);
  });
  eq(typeof rd.detectSingleRange, 'function', '唯一检测入口为 detectSingleRange');
  ok(Array.isArray(r.box) === false && typeof r.box === 'object', 'box 是单对象（不是多窗口数组）');
}

// ============ [13] 与 zoneValidity 完全独立 ============
console.log('\n[13] 箱体失效判据与阻力/支撑有效性检验完全独立（源码级）');
{
  const rdSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'rangeDetector.js'), 'utf8');
  const zvSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'zoneValidity.js'), 'utf8');
  // 只剥离注释行（块注释 `*` 行 + 整行 `//`），保留代码本体判断——注释里提及对方名字是说明，不是耦合
  const stripComments = (s) => s.replace(/^\s*\*.*$/gm, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/require\(['"]\.\/zoneValidity['"]\)/.test(rdSrc), 'rangeDetector 不 require zoneValidity');
  ok(!/zoneValidity/.test(stripComments(rdSrc)), 'rangeDetector 代码里不出现 zoneValidity 标识');
  ok(!/require\(['"]\.\/rangeDetector['"]\)/.test(zvSrc), 'zoneValidity 不 require rangeDetector');
  ok(!/rangeDetector/.test(stripComments(zvSrc)), 'zoneValidity 代码里不出现 rangeDetector 标识');
  // 常量不共用：两者各自的阈值常量独立声明
  ok(rd.OUT_BREAK_DAYS === 3 && rd.TOL_BASE_PCT === 10, '箱体阈值常量独立（3 日 / 10%）');
  ok(!('BREAK_VOL_MIN' in rd) && !('CROSS_MAX' in rd), '箱体模块不含放量阈值/反转次数常量');
  ok(!('TOL_CAP_PCT' in require('../lib/zoneValidity')) && !('SEED_DAYS' in require('../lib/zoneValidity')), 'zoneValidity 不含箱体容差/种子常量');
}

// ============ [14] 端点与脏数据 ============
console.log('\n[14] 端点：收盘 == 带边界算箱体内；脏数据被过滤');
{
  // 第 21 日收盘恰好等于该日的上沿（用同一函数算出来，保证浮点完全相等）
  const U21 = rd.bandOf(10, rd.tolPctFor(21)).U;
  const r = rd.detectSingleRange(mk(SEED20.concat([U21])));
  eq(r.state, 'active', '收盘恰等于上沿 → 仍在箱内');
  eq(r.box.fakeBreaks, 0, '不产生假突破');
  eq(r.box.maxOutStreak, 0, '不计越界日');
  const L21 = rd.bandOf(10, rd.tolPctFor(21)).L;
  const r2 = rd.detectSingleRange(mk(SEED20.concat([L21])));
  eq(r2.box.maxOutStreak, 0, '收盘恰等于下沿 → 仍在箱内');

  // 脏数据：null / '' / 0 / 负数 被剔除；布尔值不被当数字
  const dirty = mk(SEED20).map(b => ({ ...b }));
  dirty.splice(2, 0, { date: '2026-05-03', close: null });
  dirty.splice(5, 0, { date: '2026-05-06', close: '' });
  dirty.splice(8, 0, { date: '2026-05-09', close: 0 });
  dirty.splice(11, 0, { date: '2026-05-12', close: -1 });
  const r3 = rd.detectSingleRange(dirty);
  eq(r3.barsUsed, 20, '4 条脏数据被过滤 → 仍按 20 根计算');
  eq(r3.state, 'active', '过滤后正常形成箱体');
  eq(r3.box.mid, 10, '中轴不受脏数据影响（null 未被当成价格 0）');
}

// ============ [15] 接线守卫：引擎必须真的接到快照与②卡 ============
console.log('\n[15] 接线守卫：hub 快照下发 singleRange、②卡渲染单箱体（防「引擎写好了却没接上」）');
{
  const hubSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'priceActionHub.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  ok(/require\(['"]\.\/rangeDetector['"]\)/.test(hubSrc), 'hub 引入 rangeDetector');
  ok(/data\.singleRange\s*=\s*detectSingleRange\(daily\)/.test(hubSrc), 'hub 用已拉到的 daily 计算并挂 data.singleRange');
  ok(/catch[\s\S]{0,200}singleRange\s*=\s*null/.test(hubSrc), 'hub 计算失败降级为 null（不阻塞主链路）');
  ok(/_renderSingleBoxRow\s*\(sr\)/.test(appSrc), '②卡有单箱体渲染函数 _renderSingleBoxRow');
  ok(/this\._renderSingleBoxRow\(data\.singleRange\)/.test(appSrc), '②卡确实调用了它并传入 data.singleRange');
  ok(/\$\{boxRow\}/.test(appSrc), '箱体行已插入②卡模板');
  ok(/pb-empty/.test(appSrc) && /pa-box-row/.test(appSrc), '无箱体状态也有降级文案（不渲染空壳）');
  ok(!appSrc.replace(/^\s*\/\/.*$/gm, '').includes('距失效还需'), '前端不再渲染「距失效还需 N 日」（注释除外；未越界时不得显示倒计时）');
  // 旧「多窗口箱体表格」不得复活
  ['_renderRangesBlock', '_boxWindowTip', '_boxZoneLevels'].forEach(k => {
    ok(!appSrc.includes(k), `前端不再有旧函数 ${k}`);
  });
}

// ============ [16] 箱体上下限并入阻力/支撑清单 ============
console.log('\n[16] 箱体上下限并入②卡阻力/支撑（用实际上下沿，不用失效线；不参与 zoneValidity 过滤）');
{
  const r = rd.detectSingleRange(mk(SEED20));
  ok(!!r.edges, '活动箱体带出 edges');
  eq(r.edges.upper.price, r.box.envU, '上沿价 = 收盘包络高（10.2），不是失效线 11');
  eq(r.edges.lower.price, r.box.envL, '下沿价 = 收盘包络低（9.8），不是失效线 9');
  ok(r.edges.upper.price !== r.box.bandU, '上沿 ≠ bandU（拒绝把失效线当阻力）');
  ok(r.edges.lower.price !== r.box.bandL, '下沿 ≠ bandL（拒绝把失效线当支撑）');
  eq(r.edges.upper.isBox, true, '上沿条目 isBox=true（前端据此跳过滤）');
  ok(r.edges.upper.source.includes('箱体上沿') && r.edges.upper.source.includes('20 日'), `上沿标签含「箱体上沿」与天数：${r.edges.upper.source}`);
  ok(r.edges.lower.source.includes('箱体下沿'), `下沿标签：${r.edges.lower.source}`);
  ok(r.edges.upper.note.includes('11'), '上沿 tooltip 披露失效线 11');
  ok(r.edges.upper.note.includes('连续 3 日'), '上沿 tooltip 说明连续 3 日才失效');
  ok(r.edges.label.includes('20 个交易日'), 'label 含持续天数');

  // 无箱体 → 不带 edges（清单里不出现箱体条目）
  eq(rd.detectSingleRange(mk(SEED20.concat([12, 12, 12]))).edges, undefined, '失效后不带 edges');
  eq(rd.boxEdges(null), null, 'boxEdges(null)=null');
  eq(rd.boxEdges({ state: 'noBox' }), null, 'boxEdges(noBox)=null');

  // 现价已越到上沿之外（越界 1 日，箱体仍未失效）→ 上沿不再冒充阻力，下沿照给
  const broke = rd.detectSingleRange(mk(SEED20.concat([12])));
  eq(broke.state, 'active', '越界 1 日箱体仍有效');
  eq(broke.edges.upper, null, '收盘已在上沿之上 → 省略上沿（不把已破的位挂在阻力里）');
  ok(!!broke.edges.lower, '下沿仍保留');

  // 前端接线：箱体条目必须在 validOnly 过滤之后才 concat（否则会被 zoneValidity 吞掉）
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  ok(/validOnly\(shortTerm\.resistances\)\.concat\(boxRes/.test(appSrc), '阻力清单 = 有效摆动点 + 箱体上沿（箱体条目不过滤）');
  ok(/validOnly\(shortTerm\.supports\)\.concat\(boxSup/.test(appSrc), '支撑清单 = 有效摆动点 + 箱体下沿');
  ok(/isBox\s*\?\s*' box-edge'/.test(appSrc), '箱体条目单独加 box-edge 样式类');
  ok(/Number\(z\.low\) === Number\(z\.high\)/.test(appSrc), '单点价渲染单值（不出现 8.54 ~ 8.54）');
}

// ============ 汇总 ============
console.log('\n' + '='.repeat(56));
console.log(`单箱体模型回归：通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(56));
if (fail > 0) process.exitCode = 1;
