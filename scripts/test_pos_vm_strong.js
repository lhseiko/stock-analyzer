#!/usr/bin/env node
// =====================================================================
// test_pos_vm_strong.js —— 量价判定强形态 + 推演图页面 + 引擎-页面同源守卫（20261105g 定版）
// §1 模型层（posModel135 强形态表 + 走势/量能五档阈值边界）
// §2 推演图页面（volume-map.html = 合并版 v2：135 叶子/三分区/信号三卡/缩放平移）
// §3 引擎-页面同源抽查
// §4 版本断言
// =====================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const ve = require('../lib/volumeEngine.js');
const pm = require('../lib/posModel135.js');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✓ ' + msg); } else { fail++; console.log('  ✗ ' + msg); } };
const section = (t) => console.log('\n===== ' + t + ' =====');

// ============================== §1 模型层单元（posModel135 强形态表 + 五档阈值边界） ==============================
section('§1 模型层：强形态表与五档阈值（posModel135 / _walkTier5 / _volTier5）');
{
  // 1.1 STRONG 强形态表 54 格齐备（3 分区 × 3 状态 × 3 量能 × {大涨,大跌}）
  let strongN = 0, derivedN = 0;
  for (const z of pm.ZONES) for (const st of z.states) for (const v of st.vols) {
    for (const t of ['大涨', '大跌']) {
      const c = pm.volCell(z.name, st.name, v.name, t);
      if (c && c.conclusion) { strongN++; if (c.derived) derivedN++; }
    }
  }
  ok(strongN === 54, `强形态表 54 格齐备（实际 ${strongN}）`);
  ok(derivedN === 12, `其中推导格 12（带 derived 角标）（实际 ${derivedN}）`);
  ok(pm.volCell('② 中位区间', '趋势向上', '放量', '大涨').conclusion.includes('主升浪'), '中位趋势向上放量大涨 = 旧图「上涨途中」逐字映射');
  ok(pm.volCell('① 高位区间', '区间震荡', '放量', '大跌').conclusion.includes('箱体'), '高位箱体强形态文案含箱体语义');

  // 1.2 走势五档阈值边界（spec ④：≥5 大涨 / 1.2~5 上涨 / <1.2 震荡 / -1.2~-5 下跌 / ≤-5 大跌）
  ok(ve._walkTier5(5.0) === '大涨' && ve._walkTier5(6.2) === '大涨', '涨跌幅 5.0% → 大涨（边界含）');
  ok(ve._walkTier5(4.9) === '上涨' && ve._walkTier5(1.2) === '上涨', '4.9% → 上涨；1.2% → 上涨（弱幅下界含）');
  ok(ve._walkTier5(1.19) === '震荡' && ve._walkTier5(0) === '震荡' && ve._walkTier5(-1.19) === '震荡', '|涨跌幅| <1.2%（含 0）→ 震荡档（135 格无空档）');
  ok(ve._walkTier5(-1.2) === '下跌' && ve._walkTier5(-4.9) === '下跌', '-1.2% → 下跌；-4.9% → 下跌');
  ok(ve._walkTier5(-5.0) === '大跌' && ve._walkTier5(-7.2) === '大跌', '-5.0% → 大跌（边界含）');
  ok(ve._walkTier5(null) === null, '涨跌幅数据不足 → null（诚实降级）');

  // 1.3 量能五档阈值边界（spec ③ 裁决：平量 0.8~1.3 含上界；量比 = 当日 ÷ 20 日均量）
  const mkVolPc = (ratio20) => ({ ratio20, volToday: 2, turnovers: [], turnoverToday: null, ratio5: ratio20 });
  const miniBars = Array.from({ length: 60 }, (_, i) => ({ date: `2026-01-${String(i + 1).padStart(2, '0')}`, open: 10, close: 10, high: 10.1, low: 9.9, volume: 1000 }));
  const t5 = (ratio20) => ve._volTier5(mkVolPc(ratio20), miniBars);
  ok(t5(2.5).vol === '放量' && t5(1.31).vol === '放量', '量比 >1.3 → 放量');
  ok(t5(1.3).vol === '平量' && t5(0.8).vol === '平量', '量比 0.8~1.3（含双边界）→ 平量（裁决 ⑦-1 无缝隙）');
  ok(t5(0.79).vol === '缩量' && t5(0.4).vol === '缩量', '量比 <0.8 → 缩量');
  ok(t5(null).vol === null && t5(null).basis.includes('不硬套'), '20 日均量数据不足 → 诚实降级');
  ok(t5(2.5).extreme === null, '放量但未创 250 日量新高 → 不标天量（量能口径天量需双条件）');
}
// ============================== §2 推演图页面（20261105g 替换为合并版 v2） ==============================
section('§2 推演图页面（volume-map.html = 合并版 v2）');
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'volume-map.html'), 'utf8');
  // 2.1 页面结构：主轴 135 叶子 + 三分区 + 五档走势
  ok((html.match(/class="leaf"/g) || []).length === 135, '推演图页面主轴 135 叶子（3 位置 × 3 状态 × 3 量能 × 5 档）');
  ok(html.includes('量价判定模型（合并版）') && html.includes('合并版 v2'), '页面标题/版本标识为合并版 v2（20261105g 替换旧推演图）');
  ok((html.match(/t-bigup">大涨</g) || []).length === 27 && (html.match(/t-bigdown">大跌</g) || []).length === 27, '大涨/大跌各 27 行（每路径 1 格）');
  ok(['① 高位区间', '② 中位区间', '③ 低位区间'].every(z => html.includes(z)), '三大位置分区齐备');
  ok(['趋势向上', '趋势向下', '区间震荡'].every(s => html.includes(s)), '三状态分组齐备');
  ok((html.match(/class="sig-card"/g) || []).length === 3, '信号叠加层三卡（量价背离 / 极端量能 / 弱方向异动）');
  ok(html.includes('弱方向异动（滞涨 / 滞跌）') && html.includes('量增价滞'), '滞涨/滞跌已归入信号层（量增价滞 = 量价背离家族口径）');
  ok((html.match(/class="dv">推导</g) || []).length === 12, '12 格推导角标（高位×趋势向下、低位×趋势向上 的强形态）');
  ok(html.includes('异常特例分支') && html.includes('一字涨停 / 一字跌停'), '异常特例栏保留');
  // 2.2 旧推演图痕迹清零：不再包含旧 DATA 结构与旧分支标题
  ok(!html.includes("l: '放量滞涨'") && !html.includes("区间横盘震荡（底部箱体）"), '旧推演图 DATA 结构已整体替换（无残留）');
  // 2.3 缩放/平移（20261105g：恢复滚动 + 缩放工具栏 + 拖拽平移）
  ok(html.includes('overflow:auto !important'), '页面级覆盖恢复滚动（对抗全站 style.css body overflow:hidden）');
  ok(html.includes('id="vm-zoombar"') && html.includes('vm-zoom-fit') && html.includes('vm-zoom-reset'), '缩放工具栏（放大/缩小/适应宽度/重置）');
  ok(html.includes('vm-grabbing') && html.includes("scrollTo(sl - "), '按住左键拖拽平移接线');
  ok(html.includes('e.ctrlKey') && html.includes('passive: false'), 'Ctrl+滚轮缩放（preventDefault 拦截）');
}

// ============================== §3 引擎-页面同源抽查 ==============================
section('§3 引擎-页面同源（posModel135 文案 ⊆ volume-map.html）');
{
  const html = fs.readFileSync(path.join(ROOT, 'public', 'volume-map.html'), 'utf8');
  const samples = [
    pm.volCell('① 高位区间', '趋势向上', '放量', '大涨'),
    pm.volCell('③ 低位区间', '趋势向下', '缩量', '大跌'),
    pm.volCell('② 中位区间', '区间震荡', '平量', '上涨'),
  ];
  for (const c of samples) ok(html.includes(c.conclusion), `主判文案页面同源：${c.conclusion.slice(0, 24)}…`);
  const appjs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  ok(appjs.includes('ve.posJudgment') && appjs.includes('pj.signals') && appjs.includes('pj.special'), '前端消费 posJudgment 主判/信号层/特例字段');
  ok(appjs.includes('banner.derived') || appjs.includes('cell.derived'), '前端消费推导格角标');
}
// ============================== §4 版本断言 ==============================
section('§4 版本断言（20261106k）');
{
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/const APP_VERSION = '20261106p'/.test(server), 'server.js APP_VERSION=20261106p');
  ok(server.includes('[20261103k] 量价判定第三步补「大涨 / 大跌」强形态') && server.includes('[20261104c] AI 解读生成失败修复') && server.includes('[20261104d] 融资融券 tile 文案歧义修复') && server.includes('[20261104e] 量价判定位置阶梯'), 'server.js 版本注释含 [20261103k]/[20261104c]/[20261104d]/[20261105b] 条目');
  for (const f of ['test_metric_analysis_vote', 'test_consistency_audit', 'test_etf_flow_holiday_guard', 'test_manual_zone_reversal', 'test_market_log_db']) {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', `${f}.js`), 'utf8');
    ok(src.includes('20261106p') && !src.includes('20261103j'), `${f}.js 版本断言同步至 20261106p`);
  }
  for (const f of ['index.html', 'accuracy.html', 'notes.html']) {
    const src = fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');
    ok(src.includes('20261106p') && !src.includes('20261103j'), `public/${f} 版本戳=20261106p`);
  }
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
