#!/usr/bin/env node
/**
 * scripts/test_emotion_margin_dual.js — [20261109a] 两融余额因子卡「融资 / 融券双栏平分权重」守卫
 *
 * 用户指令（截图 屏幕截图 2026-11-09 124522.png）：
 *   「图二卡片修改：添加融券余额数据，余额增加判断为短期利空，余额减少判断为短期利好，
 *     融券余额和融资余额共用平分卡片的权重。」
 * 用户选型：一张卡内双栏 + 沿用融资同口径（5 日变动 / ±0.5%，月末 ±0.8% / ±10% 异常闸门）。
 *
 * 本守卫验证：
 *   §1 calcMargin 纯函数：9 种方向组合、缺失 / 异常 / 月末阈值、subs 契约
 *   §2 端到端：半格按原始 score 计入净权重与总分，其它 9 因子零改动、权重和恒 100
 *   §3 Python 取数列精确匹配（「融资融券余额」不得被误当「融券余额」）
 *   §4 前端语义着色与接线（融券「+」=利空，不得按数值符号染红）
 * 全部离线、零网络；端到端部分用临时目录，不碰生产 records/state。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-margin-dual-test-'));
process.env.SA_MARKET_EMOTION_DIR = TMP;
process.env.SA_MSI_SERIES = path.join(TMP, 'msi-series.json');
fs.writeFileSync(process.env.SA_MSI_SERIES, '[]');

const { computeMarketEmotion, calcMargin, FACTOR_NAMES } = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}
const M = (rz, rq, extra = {}) => Object.assign({
  latest: 22710, change5Pct: rz,
  rqLatest: 288.11, rqChange5Pct: rq,
}, extra);
const call = (m, isMonthEnd = false) => calcMargin({ date: '2026-11-09', margin: m }, isMonthEnd);

(async () => {
  // ---------- §1 纯函数分支 ----------
  console.log('\n[§1] 融资 / 融券方向组合（融资增=利好，融券增=利空，各占 50%）');
  const cases = [
    { rz: 1.2, rq: -1.2, score: 1, long: 1, short: 1, desc: '融资加仓 + 融券减少 → 双利好 → 满格 +1' },
    { rz: -1.2, rq: 1.2, score: -1, long: -1, short: -1, desc: '融资撤离 + 融券增加 → 双利空 → 满格 -1' },
    { rz: 1.2, rq: 1.2, score: 0, long: 1, short: -1, desc: '融资加仓 + 融券增加 → 互相抵消 → 0' },
    { rz: -1.2, rq: -1.2, score: 0, long: -1, short: 1, desc: '融资撤离 + 融券减少 → 互相抵消 → 0' },
    { rz: 1.2, rq: 0.1, score: 0.5, long: 1, short: 0, desc: '仅融资利好 → 半格 +0.5' },
    { rz: -1.2, rq: 0.1, score: -0.5, long: -1, short: 0, desc: '仅融资利空 → 半格 -0.5' },
    { rz: 0.1, rq: -1.2, score: 0.5, long: 0, short: 1, desc: '仅融券利好 → 半格 +0.5' },
    { rz: 0.1, rq: 1.2, score: -0.5, long: 0, short: -1, desc: '仅融券利空 → 半格 -0.5' },
    { rz: 0.1, rq: 0.1, score: 0, long: 0, short: 0, desc: '两侧均不明显 → 0' },
  ];
  for (const c of cases) {
    const r = call(M(c.rz, c.rq));
    ok(r.score === c.score, `${c.desc}（score=${r.score}）`);
    ok(r.subs[0].dir === c.long && r.subs[1].dir === c.short, `  └ 子项方向 融资=${r.subs[0].dir} 融券=${r.subs[1].dir}`);
  }

  console.log('\n[§1b] subs 契约与语义着色 tone');
  {
    const r = call(M(1.2, 1.2));
    ok(Array.isArray(r.subs) && r.subs.length === 2, 'subs 恰为 2 个子项');
    ok(r.subs[0].name === '融资余额' && r.subs[1].name === '融券余额', '子项名称正确');
    ok(r.subs.every(s => s.weightPct === 50), '两子项各占 50%');
    ok(r.subs[0].tone === 'bull' && r.subs[1].tone === 'bear', '融资利好=红(bull) / 融券增加利空=绿(bear)');
    ok(r.subScore === true, 'subScore=true 标记（净权重/总分用原始 score）');
    ok(/各占本卡 50% 权重/.test(r.splitNote || ''), 'splitNote 明示平分权重');
    ok(!/[+−-]\d+\.\d+%/.test(r.detail), 'detail 不含带符号百分比（防前端按符号染错色）');
    ok(r.change5Pct === 1.2, 'change5Pct 仍是融资 5 日变动（topWarning 口径不变）');
    ok(r.lagged === true && r.lagKind === 'cadence', 'T+1 例行披露标记保留');
  }

  console.log('\n[§1c] 缺失 / 异常 / 月末阈值');
  {
    const noRq = call({ latest: 22710, change5Pct: 1.2 });
    ok(noRq.degraded === false, '融券缺失不降级整卡');
    ok(noRq.score === 0.5, `融券缺失 → 仅融资半格 +0.5（实际 ${noRq.score}）`);
    ok(noRq.subs[1].absent === true && noRq.subs[1].tone === 'flat', '融券子项标 absent / 中性');
    ok(/不计分|不计入/.test(noRq.subs[1].note + noRq.detail) || /融券余额缺失/.test(noRq.detail), '缺失口径已如实披露');
  }
  {
    const r = call(M(1.2, 25));
    ok(r.subs[1].absent === true && r.score === 0.5, '融券 5 日变动超 ±10% → 该子项不计分（不误降级整卡）');
    const r2 = call(M(25, -1.2));
    ok(r2.degraded === true, '融资 5 日变动超 ±10% → 整卡降级（与旧版一致）');
  }
  {
    ok(call({ latest: 0, change5Pct: 1.2 }).degraded === true, '融资余额缺失 → 降级');
    ok(call({ latest: 22710 }).degraded === true, '融资变化不可用 → 降级');
  }
  {
    // 0.6% 在平日 (±0.5%) 达阈值、月末 (±0.8%) 不达 → 月末放宽只影响融资侧，融券 0.1% 两侧都不明显
    const normal = call(M(0.6, 0.1), false);
    const monthEnd = call(M(0.6, 0.1), true);
    ok(normal.score === 0.5 && monthEnd.score === 0,
      `月末阈值放宽到 ±0.8% 生效（平日 ${normal.score} / 月末 ${monthEnd.score}）`);
  }

  // ---------- §2 端到端 ----------
  console.log('\n[§2] 端到端：半格计入总分、其它因子零改动、权重和恒 100');
  function mkBars(n) {
    const bars = []; let close = 3800;
    const endT = Date.parse('2026-09-17T00:00:00');
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dates = [];
    for (let t = endT; dates.length < n; t -= 86400000) {
      const d = new Date(t);
      if (d.getDay() !== 0 && d.getDay() !== 6) dates.unshift(fmt(d));
    }
    for (let i = 0; i < n; i++) {
      close *= 1.0005;
      bars.push({ date: dates[i], close: Math.round(close * 100) / 100, vol: Math.round(5e8 * (1 + Math.sin(i / 7) * 0.1)) });
    }
    return bars;
  }
  const bundle = (margin) => ({
    ok: true, date: '2026-09-17',
    index: { code: 'sh000001', name: '上证指数', bars: mkBars(260) },
    breadth: { up: 3000, down: 1800, flat: 100, limitUp: 60, limitDown: 3, activePct: 60 },
    margin,
    mainFund: { mainNetToday: 150, history: [] },
    capital: { totalAmount: 15000, turnoverAvg: 3, topDecileShare: 45 },
    fx: { usdcnh: 7.0, usdcnhChgPct: -0.3, usdcny: 7.0, usdcnyChgPct: -0.3 },
    bond: { cn10y: 2.0, chgBp5: 5 },
    discussionHeat: { marketHeat: 0.2, date: '2026-09-17', value: '热度 0.2', detail: '讨论综合得分 0.12、看多占比 55%（数据源：东财股吧，样本 1200 只）' },
    issues: [], warnings: [],
  });
  {
    const r = await computeMarketEmotion({ data: bundle(M(1.2, 1.2)), macroFactors: [] });
    const mg = r.factors.find(f => f.key === 'margin');
    ok(r.factors.length === 10, '因子数仍为 10（8 常驻 + 2 非常驻），未新增因子');
    ok(Math.abs(r.factors.reduce((a, f) => a + f.weight, 0) - 100) < 0.1, '权重合计仍 = 100%');
    ok(mg.score === 0 && mg.contribution === 0, '两子项反向 → margin 净权重 0');
    ok(mg.name === '两融余额' && FACTOR_NAMES.margin === '两融余额', '卡片显示名已缩短为「两融余额」');
    // 关键回归：computeMarketEmotion 返回时 factors 经过字段白名单，漏透出 subs 会让前端双栏不渲染
    ok(Array.isArray(mg.subs) && mg.subs.length === 2, '输出白名单已透出 subs（前端才能渲染双栏）');
    ok(mg.subScore === true && /50%/.test(mg.splitNote || ''), 'subScore / splitNote 一并透出');
    const dirOf = s => (s > 0 ? 1 : s < 0 ? -1 : 0);
    const dirVal = f => (f.subScore ? (f.score || 0) : dirOf(f.score || 0));
    const exp = r.factors.reduce((a, f) => a + dirVal(f) * (f.weight / 100), 0);
    ok(Math.abs(r.totalScore - exp) < 0.001, `总分 = Σ(方向强度×权重)（${r.totalScore} vs ${exp.toFixed(3)}）`);
    ok(r.factors.every(f => Math.abs((f.contribution || 0) - dirVal(f) * f.weight) < 0.011), '每因子净权重与评分同源');
  }
  {
    // 半格因子：融资 +1、融券 0 → score=+0.5，净权重必须恰为权重的一半（不被 dirOf 压回满格）
    const r = await computeMarketEmotion({ data: bundle(M(1.2, 0.1)), macroFactors: [] });
    const mg = r.factors.find(f => f.key === 'margin');
    ok(mg.score === 0.5, '半格 score=+0.5');
    ok(Math.abs(mg.contribution - mg.weight / 2) < 0.011,
      `净权重 = 权重 × 0.5，未被 dirOf 压回满格（${mg.contribution} vs ${(mg.weight / 2).toFixed(2)}）`);
  }
  {
    // 其它 9 因子零改动：换 margin 夹具，比较除 margin 外的 score/weight/contribution
    const a = await computeMarketEmotion({ data: bundle(M(1.2, -1.2)), macroFactors: [] });
    const b = await computeMarketEmotion({ data: bundle(M(-1.2, 1.2)), macroFactors: [] });
    const pick = r => r.factors.filter(f => f.key !== 'margin').map(f => [f.key, f.score, f.weight, f.contribution]);
    ok(JSON.stringify(pick(a)) === JSON.stringify(pick(b)), '改变两融方向后，其它 9 个因子数值逐项不变（隔离修改）');
  }

  // ---------- §3 Python 数据源 ----------
  console.log('\n[§3] Python 取数：融券列精确匹配 + 融资字段口径不变');
  {
    const py = fs.readFileSync(path.join(ROOT, 'scripts/market_emotion.py'), 'utf8');
    ok(/str\(c\)\.strip\(\) == val_name/.test(py), '列名用精确匹配（防「融资融券余额」误吞「融券余额」）');
    // 精确匹配「可执行代码」（带冒号），不误伤说明注释里引用的旧写法
    ok(!/if\s+"融券余额"\s+in\s+str\(c\)\s*:/.test(py), '不存在「融券余额」子串模糊匹配的可执行代码');
    ok(/_to_map\(sh, "融券余额"\)/.test(py) && /_to_map\(sz, "融券余额"\)/.test(py), '沪深两边都解析融券余额列');
    ok(/_to_map\(sh, "融资余额"\)/.test(py), '融资列仍单独解析（口径不变）');
    ok(/"rqLatest"/.test(py) && /"rqChange5Pct"/.test(py) && /"rqDate"/.test(py), '输出 rqLatest / rqChange5Pct / rqDate');
    ok(/"latest": round\(rz\["latest"\], 1\)/.test(py), '融资 latest 仍按原精度输出');
    ok(/rqMissingNote/.test(py), '融券缺失有单独标注（不拖累整卡）');
    const dat = fs.readFileSync(path.join(ROOT, 'lib/marketEmotionData.js'), 'utf8');
    ok(/margin: raw\.margin \|\| null/.test(dat), '取数层透传整个 margin 对象（rq* 自动带上）');
  }

  // ---------- §4 前端接线 ----------
  console.log('\n[§4] 前端双栏与语义着色');
  {
    const js = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
    ok(/f\.key === 'margin' && Array\.isArray\(f\.subs\)/.test(js), 'app.js 按 margin + subs 分流渲染');
    ok(/tp-comp-dual/.test(js), '渲染 tp-comp-dual 双栏容器');
    ok(/esc\(sub\.value \|\| '—'\)/.test(js), '双栏数值用 esc 而非 _dirColorize（防「融券+=利空」染红）');
    ok(/sub\.tone === 'bull'/.test(js) && /tp-sig-bear/.test(js), 'tone 映射到红/绿方向色');
    ok(/两融双栏各按半格/.test(js), '卡片区标题已同步说明半格口径');
    ok(/\.tp-comp-dual \{/.test(css) && /\.tp-comp-sub \{/.test(css), 'style.css 含双栏与子项样式');
    ok(/@media \(max-width: 520px\)/.test(css), '窄屏回退单列');
    ok(/esc\(detailTxt\)/.test(js), 'margin 卡 detail 用中性色，避免符号着色错位');
  }

  console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  delete process.env.SA_MARKET_EMOTION_DIR;
  delete process.env.SA_MSI_SERIES;
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.error('FATAL', e && e.stack || e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
