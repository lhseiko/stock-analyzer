/**
 * scripts/test_cap_vol_ratio_chart.js — 20261109d 守卫
 * ==========================================================
 * 用户指令（2026-11-09）：「每日量比趋势（近60日）图表的数据由每日的量比
 * 改为每日的20日量能比，图表名字也一起改。」
 *
 * 锁定行为：
 *   §1 computeVolRatioSeries 口径（20日量能比=当日量÷前20日均量不含当日；缺失→null 不臆造）
 *   §2 渲染接线（卡片位置=主力资金流向卡正下方 / renderAll 接线 / 阈值线 1.3·0.8）
 *   §3 版本戳（动态读取 APP_VERSION，避免硬编码过期）
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

  // ── §1 20日量能比序列口径 ─────────────────────────────────
  console.log('\n§1 computeVolRatioSeries（20日量能比=当日量÷前20日均量，不含当日）');
  {
    ok(typeof CC.computeVolRatioSeries === 'function', 'computeVolRatioSeries 已导出（vm 沙箱可加载）');
    const flat = Array(22).fill(100); flat[20] = 200; // 短样本验证边界
    const r = CC.computeVolRatioSeries(flat);
    ok(r.length === flat.length, '输出与输入等长（逐日对齐）');
    ok(r.slice(0, 20).every(v => v === null), '前 20 日基准不足 → null（不臆造）');
    ok(r[20] === 2, '当日 200 ÷ 前20日均量 100 = 2.0');
    ok(Math.abs(r[21] - 200 / 210) < 0.01, `次日 100 ÷ 前20日均量(含前日200)≈${(200 / 210).toFixed(2)}（实际 ${r[21]}）`);

    const hole = Array(60).fill(100); hole[25] = null;
    const rh = CC.computeVolRatioSeries(hole);
    ok(Math.abs(rh[20] - 1) < 0.001, '正常窗口 100÷100=1.00');
    ok(rh[25] === null, '当日量缺失 → null');
    ok(rh[26] === null, '前20日窗口含缺失 → 该日 null（不跳过补算）');
    ok(Math.abs(rh[46] - 1) < 0.001 && Math.abs(rh[59] - 1) < 0.001, '窗口滑过缺失恢复后回到 1.00（数组末）');

    const zero = Array(60).fill(100); zero[25] = 0;
    const rz = CC.computeVolRatioSeries(zero);
    ok(rz[25] === null, '当日量 0（停牌）→ null');
    ok(rz[26] === null, '前20日窗口含 0 量 → null');
    ok(Math.abs(rz[46] - 1) < 0.001 && Math.abs(rz[59] - 1) < 0.001, '窗口滑过停牌日后恢复计算（1.00）');
    ok(CC.computeVolRatioSeries([]).length === 0, '空数组 → 空序列');
    ok(CC.computeVolRatioSeries(null).length === 0, 'null 输入 → 空序列（脏数据兜底）');

    // 真实数据形状：近 60 日（与 vi.series.volumes 对齐）
    const v60 = Array.from({ length: 60 }, (_, i) => 1000 + (i % 7) * 100);
    ok(CC.computeVolRatioSeries(v60).filter(v => v != null).length === 40, '60 日输入 → 40 个有效量能比（前 20 日 null）');
  }

  // ── §2 渲染接线 ────────────────────────────────────────────
  console.log('\n§2 渲染接线（卡片位置 / 标题 / 阈值线）');
  {
    const idxHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const iMoney = idxHtml.indexOf('capMoneyFlowChart');
    const iRatio = idxHtml.indexOf('capVolRatioChart');
    ok(iMoney >= 0 && iRatio > iMoney, 'index.html：20日量能比图容器位于主力资金流向卡之后');
    ok(idxHtml.includes('每日20日量能比趋势（近60日）'), '卡片标题「每日20日量能比趋势（近60日）」');
    ok(/主力资金流向（近60日）[\s\S]{0,400}?每日20日量能比趋势（近60日）/.test(idxHtml), '量能比卡紧跟主力资金流向卡（正下方，中间无其他卡片）');
    const cc = fs.readFileSync(path.join(ROOT, 'public/js/capitalCharts.js'), 'utf8');
    ok(/renderVolRatio\(data\.volumeIndicators\)/.test(cc), 'renderAll 已接线 renderVolRatio（消费 volumeIndicators）');
    ok(cc.includes("capVolRatioChart") && cc.includes("this.instances.volRatio = chart"), '渲染函数绑定 #capVolRatioChart（复用 _safeInit 容错）');
    ok(cc.includes("前 20 日均量") && /yAxis: 1\.3/.test(cc) && /yAxis: 0\.8/.test(cc), '口径说明与阈值线 1.3（放量）/0.8（缩量）齐备');
    ok(/放量|平量|缩量/.test(cc.split('renderVolRatio')[1]?.split('renderVolumePrice')[0] || ''), 'tooltip 标注量能三态（与量能三态同口径）');
    // 后端序列字段（同源、无空窗）
    ok(cc.includes('ratio20Series'), '前端优先消费后端预计算的 ratio20Series（同源，避免前端空窗）');
  }

  // ── §3 版本戳（动态读取 APP_VERSION）──────────────────────
  console.log('\n§3 版本戳');
  {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    const m = server.match(/const APP_VERSION = '([0-9a-z]+)'/);
    const VER = m ? m[1] : '';
    ok(VER !== '', `server.js 含 APP_VERSION（=${VER}）`);
    const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    ok(idx.includes(`?v=${VER}`), `index.html（本图表所在页）版本戳已对齐 ${VER}`);
    // 前端资源由 server 中间件强制 ?v=APP_VERSION（capitalCharts.js 在 FRONTEND_BUST_FILES），
    // 故 HTML 无需逐项手工同步；accuracy.html 等独立页面属历史戳、不在本次范围。
    ok(/'\/js\/capitalCharts\.js'/.test(server), 'capitalCharts.js 在 FRONTEND_BUST_FILES（被服务端强制带戳）');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试执行失败:', e); process.exit(1); });
