/**
 * scripts/test_cap_vol_ratio_chart.js — 20261105b 守卫
 * ==========================================================
 * 用户指令（2026-11-03）：「在资金量能里面，主力资金流向（近60日）卡片外的正下方
 * 添加每日量比折线趋势图，记录每日量比的变化。」
 *
 * 锁定行为：
 *   §1 computeVolRatioSeries 口径（量比=当日量÷前5日均量不含当日；缺失→null 不臆造）
 *   §2 渲染接线（卡片位置=主力资金流向卡正下方 / renderAll 接线 / 阈值线 1.2·0.8）
 *   §3 版本断言
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const ROOT = path.join(__dirname, '..');

// 浏览器脚本 → vm 沙箱加载（纯函数计算无需 DOM/echarts）
function loadCapitalCharts() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/capitalCharts.js'), 'utf8');
  const sandbox = { console, window: undefined, document: undefined, echarts: undefined, SA_CHART: undefined };
  vm.createContext(sandbox);
  return vm.runInContext(src + '\n;CapitalCharts', sandbox, { filename: 'capitalCharts.js' });
}

async function main() {
  const CC = loadCapitalCharts();

  // ── §1 量比序列口径 ────────────────────────────────────────
  console.log('\n§1 computeVolRatioSeries（量比=当日量÷前5日均量，不含当日）');
  {
    ok(typeof CC.computeVolRatioSeries === 'function', 'computeVolRatioSeries 已导出（vm 沙箱可加载）');
    const flat = [100, 100, 100, 100, 100, 200, 100, 100, 100, 100, 50];
    const r = CC.computeVolRatioSeries(flat);
    ok(r.length === flat.length, '输出与输入等长（逐日对齐）');
    ok(r.slice(0, 5).every(v => v === null), '前 5 日基准不足 → null（不臆造）');
    ok(r[5] === 2, '当日 200 ÷ 前5日均量 100 = 2.0');
    ok(r[6] === 0.83, `次日 100 ÷ 前5日均量 120 = 0.83（实际 ${r[6]}）`);
    ok(r[10] === 0.42, `末值 50 ÷ 前5日均量 120 = 0.42（实际 ${r[10]}）`);

    const hole = [100, 100, 100, 100, 100, null, 100, 100, 100, 100, 100, 100, 100];
    const rh = CC.computeVolRatioSeries(hole);
    ok(rh[5] === null, '当日量缺失 → null');
    ok(rh[6] === null && rh[9] === null, '前5日窗口含缺失 → 该日 null（不跳过补算）');
    ok(rh[12] === 1, '窗口滑过缺失后恢复计算（100÷100=1.00）');

    const zero = [0, 100, 100, 100, 100, 100, 100, 200];
    const rz = CC.computeVolRatioSeries(zero);
    ok(rz[5] === null, '窗口含 0 量（停牌）→ null');
    ok(rz[6] === 1 && rz[7] === 2, '窗口滑过停牌日后恢复计算（1.00 / 2.00）');
    ok(CC.computeVolRatioSeries([]).length === 0, '空数组 → 空序列');
    ok(CC.computeVolRatioSeries(null).length === 0, 'null 输入 → 空序列（脏数据兜底）');

    // 真实数据形状：近 60 日（与 vi.series.volumes 对齐）
    const v60 = Array.from({ length: 60 }, (_, i) => 1000 + (i % 7) * 100);
    ok(CC.computeVolRatioSeries(v60).filter(v => v != null).length === 55, '60 日输入 → 55 个有效量比（前 5 日 null）');
  }

  // ── §2 渲染接线 ────────────────────────────────────────────
  console.log('\n§2 渲染接线（卡片位置 / 接线 / 阈值线）');
  {
    const idxHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const iMoney = idxHtml.indexOf('capMoneyFlowChart');
    const iRatio = idxHtml.indexOf('capVolRatioChart');
    ok(iMoney >= 0 && iRatio > iMoney, 'index.html：量比图容器位于主力资金流向卡之后');
    ok(idxHtml.includes('每日量比趋势（近60日）'), '卡片标题「每日量比趋势（近60日）」');
    ok(/主力资金流向（近60日）[\s\S]{0,400}?每日量比趋势（近60日）/.test(idxHtml), '量比卡紧跟主力资金流向卡（正下方，中间无其他卡片）');
    const cc = fs.readFileSync(path.join(ROOT, 'public/js/capitalCharts.js'), 'utf8');
    ok(/renderVolRatio\(data\.volumeIndicators\)/.test(cc), 'renderAll 已接线 renderVolRatio（消费 volumeIndicators）');
    ok(cc.includes("capVolRatioChart") && cc.includes("this.instances.volRatio = chart"), '渲染函数绑定 #capVolRatioChart（复用 _safeInit 容错）');
    ok(cc.includes("前 5 日均量") && /yAxis: 1\.2/.test(cc) && /yAxis: 0\.8/.test(cc), '口径说明与阈值线 1.2（放量）/0.8（缩量）齐备');
    ok(/放量|平量|缩量/.test(cc.split('renderVolRatio')[1]?.split('renderVolumePrice')[0] || ''), 'tooltip 标注量能三态（与量能三态同口径）');
  }

  // ── §3 版本断言 ────────────────────────────────────────────
  console.log('\n§3 版本断言');
  {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    ok(/const APP_VERSION = '20261106p'/.test(server), "APP_VERSION = '20261106p'");
    const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const acc = fs.readFileSync(path.join(ROOT, 'public/accuracy.html'), 'utf8');
    ok(idx.includes('?v=20261106p') && acc.includes('?v=20261106p'), 'index/accuracy 页面版本戳已对齐 20261106p');
    const t1 = fs.readFileSync(path.join(ROOT, 'scripts/test_metric_analysis_vote.js'), 'utf8');
    const t2 = fs.readFileSync(path.join(ROOT, 'scripts/test_market_log_db.js'), 'utf8');
    ok(t1.includes('20261106p') && t2.includes('20261106p'), '既有守卫版本断言已同步 20261106p');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试执行失败:', e); process.exit(1); });
