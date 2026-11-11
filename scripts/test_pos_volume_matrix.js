// =====================================================================
// test_pos_volume_matrix.js —— 量价判定模型合并版 v2 主轴守卫（20261105g 定版）
// 旧 24 格矩阵体系已退役（pos-model-135-1 替代 pos-volume-matrix-1）；
// 本文件重写为：知识表 135 格 / 归格路由夹具 / 运行状态五步 / 信号叠加层 / 异常特例 / 诚实降级 / 前端接线 / 源码守卫
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

// ---------- 夹具工具 ----------
function mkBars(gen, n = 300) {
  const bars = [];
  const d = new Date('2025-06-02');
  while (bars.length < n - 1) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      const i = bars.length;
      bars.push({ date: d.toISOString().slice(0, 10), ...gen(i) });
    }
    d.setDate(d.getDate() + 1);
  }
  return bars;
}
function nextDate(bars) {
  const d = new Date(bars[bars.length - 1].date);
  do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
  return d.toISOString().slice(0, 10);
}
function judge(bars, last) {
  last.date = nextDate(bars);
  bars.push(last);
  const pc = ve._precompute(bars, {});
  const sw = ve._sidewaysAndPlatform(bars);
  return { pj: ve._posVolumeMatrix(pc, { currentSideways: sw.currentSideways, band20: sw.band20, trend20: sw.trend20 }, bars), pc };
}

// ============================== §1 知识表完整性（posModel135） ==============================
section('§1 知识表完整性（posModel135 · 主轴 135 格）');
{
  ok(pm.ZONES.length === 3 && ['① 高位区间', '② 中位区间', '③ 低位区间'].every(z => pm.ZONES.find(x => x.name === z)), '三分区齐备（高位/中位/低位）');
  let n = 0, dv = 0;
  for (const z of pm.ZONES) for (const st of z.states) for (const v of st.vols) for (const t of pm.TIER5) {
    const c = pm.volCell(z.name, st.name, v.name, t);
    if (c) { n++; if (c.derived) dv++; }
  }
  ok(n === 135, `volCell 全组合 135 格（实际 ${n}）`);
  ok(dv === 12, `推导格 12（高位×趋势向下、低位×趋势向上）（实际 ${dv}）`);
  ok(['趋势向上', '趋势向下', '区间震荡'].every(s => pm.ZONES.every(z => z.states.find(x => x.name === s))), '三状态 × 三分区全齐');
  ok(['放量', '平量', '缩量'].every(v => pm.ZONES.every(z => z.states.every(st => st.vols.find(x => x.name === v)))), '三量能 × 三状态 × 三分区全齐');
  ok(pm.volCell('① 高位区间', '趋势向上', '放量', '大涨').conclusion.includes('严禁追高'), '高位放量大涨文案逐字命中（合并版 v2 同源）');
  ok(pm.volCell('③ 低位区间', '趋势向上', '放量', '大涨').derived === true, '低位×趋势向上为推导格');
}

// ============================== §2 归格路由（夹具端到端） ==============================
section('§2 归格路由（位置 × 状态 × 量能 × 走势 → 135 格）');
{
  // 场景1：长期上涨（高位）+ 末日放量大涨 6%（量比爆表创 250 日新高 → 天量归放量档）
  let b = mkBars(i => { const c = 10 + i * 0.02; return { open: c - 0.02, close: c, high: c + 0.05, low: c - 0.05, volume: 8000 }; });
  let p = b[b.length - 1].close;
  let r = judge(b, { open: p * 1.01, close: p * 1.062, high: p * 1.07, low: p * 1.005, volume: 60000 });
  ok(r.pj.position.label === '高位区间' && r.pj.position.zoneName === '① 高位区间', `场景1 位置=高位区间（分位 ${Math.round(r.pj.position.pct * 100)}%）`);
  ok(r.pj.mode.key === '趋势向上' && r.pj.mode.gray === false, '场景1 运行状态=趋势向上（线性上涨 ADX≥25）');
  ok(r.pj.volume.tier === '放量' && r.pj.volume.extreme === '天量' && r.pj.volume.tier5 === '天量', `场景1 量能=天量（量比 ${r.pj.volume.ratio20} ≥2 且创 250 日量新高，归放量档）`);
  ok(r.pj.price.walk === '大涨' && Math.abs(r.pj.price.chgPct - 6.2) < 0.3, '场景1 走势=大涨（≥5%）');
  ok(r.pj.cell && r.pj.cell.key === '① 高位区间|趋势向上|放量|大涨' && r.pj.cell.derived === false, '场景1 归格 = ①高位区间|趋势向上|放量|大涨（非推导）');
  ok(r.pj.cell.conclusion.includes('严禁追高'), '场景1 主判文案逐字同源');
  ok(r.pj.signals.extreme.triggered === true && r.pj.signals.extreme.type === '天量', '场景1 极端量能卡触发（天量+位置挂接解读）');
  ok((r.pj.mode.steps || []).length === 5 && r.pj.mode.steps[1].k.includes('ADX') && r.pj.mode.steps[3].k.includes('箱体'), '场景1 五步判定链齐备（道氏/ADX/均线/箱体/健康度）');
  ok(r.pj.schema === 'pos-model-135-1', 'schema = pos-model-135-1');

  // 场景2：长期下跌（低位）+ 末日放量大跌 6%
  b = mkBars(i => { const c = 20 - i * 0.03; return { open: c + 0.02, close: c, high: c + 0.05, low: c - 0.05, volume: 9000 }; });
  p = b[b.length - 1].close;
  r = judge(b, { open: p * 0.99, close: p * 0.94, high: p * 1.005, low: p * 0.93, volume: 60000 });
  ok(r.pj.position.label === '低位区间', '场景2 位置=低位区间');
  ok(r.pj.cell && r.pj.cell.key === '③ 低位区间|趋势向下|放量|大跌', '场景2 归格 = ③低位区间|趋势向下|放量|大跌');

  // 场景3：末日平盘（chg=0）→ 震荡档覆盖（旧体系 chg=0 不归格，新模型震荡档填补空档）
  b = mkBars(i => { const c = 20 - i * 0.03; return { open: c + 0.02, close: c, high: c + 0.05, low: c - 0.05, volume: 9000 }; });
  p = b[b.length - 1].close;
  r = judge(b, { open: p, close: p, high: p + 0.04, low: p - 0.04, volume: 9000 });
  ok(r.pj.price.walk === '震荡' && r.pj.cell && r.pj.cell.key.endsWith('|平量|震荡'), '场景3 chg=0 归震荡档（135 格无空档）');

  // 场景4：地量（量比 <0.5 且创 250 日量新低）→ 缩量档极端化
  b = mkBars(i => { const c = 20 - i * 0.03; return { open: c + 0.02, close: c, high: c + 0.05, low: c - 0.05, volume: 9000 }; });
  p = b[b.length - 1].close;
  r = judge(b, { open: p * 1.005, close: p * 1.015, high: p * 1.02, low: p, volume: 1500 });
  ok(r.pj.volume.extreme === '地量' && r.pj.volume.tier === '缩量', `场景4 地量检测（量比 ${r.pj.volume.ratio20} <0.5 且创 250 日量新低，归缩量档）`);
  ok(r.pj.signals.extreme.triggered === true && r.pj.signals.extreme.type === '地量', '场景4 极端量能卡触发（地量+连续性提醒）');
}

// ============================== §3 运行状态五步判定 ==============================
section('§3 运行状态五步判定（道氏 / ADX / 均线 / 箱体 / 量价健康度）');
{
  ok(typeof ve._adx14 === 'function', '_adx14 已导出可单测');
  // 线性上涨 → ADX 高、+DI>-DI
  let b = mkBars(i => { const c = 10 + i * 0.02; return { open: c - 0.02, close: c, high: c + 0.05, low: c - 0.05, volume: 8000 }; });
  let a = ve._adx14(b);
  ok(a && a.adx >= 25 && a.plusDI > a.minusDI, `线性上涨 ADX=${a.adx.toFixed(1)} ≥25 且 +DI>-DI（趋势向上）`);
  // 线性下跌 → -DI>+DI
  b = mkBars(i => { const c = 20 - i * 0.03; return { open: c + 0.02, close: c, high: c + 0.05, low: c - 0.05, volume: 9000 }; });
  a = ve._adx14(b);
  ok(a && a.adx >= 25 && a.minusDI > a.plusDI, `线性下跌 ADX=${a.adx.toFixed(1)} ≥25 且 -DI>+DI（趋势向下）`);
  // 道氏结构（波浪上涨：涨 5 回调 3 循环 → 摆动高点递进）
  ok(typeof ve._dowStructure === 'function', '_dowStructure 已导出');
  const dow = ve._dowStructure(mkBars(i => {
    const phase = i % 8;
    const c = 10 + Math.floor(i / 8) * 0.5 + (phase < 5 ? phase * 0.05 : (8 - phase) * 0.04);
    return { open: c - 0.01, close: c, high: c + 0.03, low: c - 0.03, volume: 8000 };
  }));
  ok(dow.dir === 'up', '波浪上涨 → 道氏高低点同步抬高（向上结构）');
  // 箱体量化
  ok(typeof ve._boxQuant === 'function', '_boxQuant 已导出');
  const box = ve._boxQuant(mkBars(i => { const c = 10 + Math.sin(i / 6) * 0.5; return { open: c, close: c, high: c + 0.12, low: c - 0.12, volume: 8000 }; }), null);
  ok(Array.isArray(box.conds) && box.conds.length === 5, '箱体量化输出五条件明细（可审计）');
  ok(box.conds.some(c => c.k.includes('布林带宽')) && box.conds.some(c => c.k.includes('宽度')), '箱体五条件含布林带宽与宽度 8%~25%（spec ②）');
  // 诚实降级：K 线 <30 根
  const small = mkBars(i => ({ open: 10, close: 10, high: 10.1, low: 9.9, volume: 8000 }), 15);
  const pcS = ve._precompute(small, {});
  const pjS = ve._posVolumeMatrix(pcS, {}, small);
  ok(pjS.mode.key === null && pjS.mode.note.includes('不足 30 根'), 'K 线不足 30 根 → 运行状态诚实降级（不硬套）');
}

// ============================== §4 信号叠加层（spec ⑤ 三卡 + 共振） ==============================
section('§4 信号叠加层（背离 / 极端量能 / 弱方向异动 + 共振）');
{
  // 滞涨：低位 + 放量（量比 5 日 ≥2）+ 涨幅 0.6% <1.2%
  let b = mkBars(i => { const c = 20 - i * 0.03; return { open: c + 0.02, close: c, high: c + 0.05, low: c - 0.05, volume: 9000 }; });
  let p = b[b.length - 1].close;
  let r = judge(b, { open: p * 1.002, close: p * 1.006, high: p * 1.02, low: p, volume: 40000 });
  ok(r.pj.signals.weak.triggered === true && r.pj.signals.weak.type === '放量滞涨', '滞涨卡触发（量比 ≥2 + 涨幅 0.6% <1.2%）');
  ok(r.pj.signals.weak.position.includes('低位'), `滞涨位置解读=低位·吸筹可能倾向（${(r.pj.signals.weak.position || '').slice(0, 18)}…）`);
  ok(r.pj.signals.weak.note.includes('后续 3~5 天') || r.pj.signals.weak.note.includes('3~5 日'), '滞涨附后续 3~5 日量价延续性确认（滞涨≠出货）');
  ok(r.pj.cell !== null, '信号层命中不覆盖主判（主轴照常归格，spec ⑤ 叠加不覆盖）');
  // 主判挂起时信号层仍输出（一字板场景）
  b = mkBars(i => { const c = 10 + i * 0.02; return { open: c - 0.02, close: c, high: c + 0.05, low: c - 0.05, volume: 8000 }; });
  p = b[b.length - 1].close;
  const zt = p * 1.10;
  r = judge(b, { open: zt, close: zt, high: zt, low: zt, volume: 800 });
  ok(r.pj.special && r.pj.special.type === '一字板' && r.pj.cell === null, '一字板特例命中 → 主判挂起（cell=null 不臆造归格）');
  ok(r.pj.special.note.includes('板价'), '一字板专用观察维度=开板日「收盘 vs 板价」判据');
  ok(r.pj.signals && r.pj.signals.divergence.state !== undefined, '信号层结构在特例挂起时仍完整输出');
}

// ============================== §5 异常特例检测层（spec ⑥） ==============================
section('§5 异常特例检测层（一字板 / 停牌复牌 / 黑天鹅跳空 / 对倒嫌疑）');
{
  // 停牌复牌：日期断档 >10 天（手工 push 保证末两根间隔超阈值）
  let b = mkBars(i => { const c = 10 + i * 0.02; return { open: c - 0.02, close: c, high: c + 0.05, low: c - 0.05, volume: 8000 }; });
  b[b.length - 1].date = '2026-09-01'; // 人为制造断档起点
  let p = b[b.length - 1].close;
  b.push({ date: '2026-09-15', open: p * 1.02, close: p * 1.03, high: p * 1.05, low: p * 1.01, volume: 30000 });
  const pcR = ve._precompute(b, {});
  const swR = ve._sidewaysAndPlatform(b);
  const r = { pj: ve._posVolumeMatrix(pcR, { currentSideways: swR.currentSideways, band20: swR.band20, trend20: swR.trend20 }, b) };
  ok(r.pj.special && r.pj.special.type === '停牌复牌', '日期断档 >10 天 → 停牌复牌特例命中');
  ok(r.pj.special.note.includes('悬空'), '停复牌专用观察维度=悬空K线群突破方向');
  ok(r.pj.cell === null, '特例生效 → 主轴判定挂起');
  // 对倒嫌疑：换手率 >20% 且涨跌幅 <1.5%
  const bt = mkBars(i => { const c = 10 + i * 0.02; return { open: c - 0.02, close: c, high: c + 0.05, low: c - 0.05, volume: 8000 }; });
  bt[bt.length - 1].turnover = 23;
  const pc = ve._precompute(bt, {});
  const pj = ve._posVolumeMatrix(pc, {}, bt);
  ok(pj.special && pj.special.type === '对倒嫌疑', '换手 >20% 且 |涨跌幅| <1.5% → 对倒嫌疑（量价特征标注）');
  ok(pj.special.note.includes('降权') || pj.special.note.includes('一致性'), '对倒框架调整：量绝对值降权、量价一致性升权');
}

// ============================== §6 诚实降级 ==============================
section('§6 诚实降级（数据不足不硬套）');
{
  const b = mkBars(i => ({ open: 10, close: 10, high: 10.1, low: 9.9, volume: 8000 }), 12);
  const pc = ve._precompute(b, {});
  const pj = ve._posVolumeMatrix(pc, {}, b);
  ok(pj.position.label === null && pj.cell === null, 'K 线不足 → 位置无法归格、主判不出（不臆造）');
  ok(pj.summary.includes('不硬套'), '降级说明明示「不硬套」');
}

// ============================== §7 前端接线（app.js 新渲染） ==============================
section('§7 前端接线（保留原布局风格 · 新标准展示）');
{
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  ok(src.includes('第一步 · 位置定位') && src.includes('第二步 · 运行状态') && src.includes('第三步 · 量能 × 涨跌幅'), '三步骤行结构保留（原界面风格）');
  ok(src.includes('运行状态 · 五步判定链') && src.includes('ve-posj-chain'), '五步判定链独立紧凑区（20261105f-b UI 重排）');
  ok(src.includes('信号叠加层') && src.includes("sigChip('divergence'") && src.includes("sigChip('extreme'") && src.includes("sigChip('weak'"), '信号叠加层三卡 chips 渲染（未触发压缩单行）');
  ok(src.includes('sigDetail(') && src.includes('trigCount === 0'), '触发卡展开明细 / 未触发压缩单行的分档渲染');
  ok(src.includes('⚠️ 异常特例生效'), '异常特例行渲染（主判挂起标注）');
  ok(src.includes('主轴 135 格归格'), '生效路径=135 格归格');
  ok(src.includes('参考锚点') && src.includes('pos.refs'), '参考锚点表（锚点二~四仅参考提醒，唯一渲染处）');
  ok(src.includes('mode.steps'), '五步明细接线');
  ok(!src.includes('step1Refs') && !src.includes('TREND_FORM_ORDER'), '第一步行内锚点块已移除 + 旧 17 形态参考表退役（零残留）');
  ok(!src.includes('pj.extRef') && !src.includes('pj.extJudgment'), '旧 extRef/extJudgment 消费零残留');
  const styleSrc = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  ok(styleSrc.includes('.ve-posj-step') && styleSrc.includes('.ve-posj-main') && styleSrc.includes('.ve-posj-chain') && styleSrc.includes('.ve-sig-chip'), '既有样式复用 + 新增五步链/信号 chips 样式类');
}

// ============================== §8 源码守卫 ==============================
section('§8 源码守卫（引擎接线与 schema）');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'volumeEngine.js'), 'utf8');
  ok(src.includes("schema: 'volume-engine-20261109c'"), '引擎 schema = volume-engine-20261109c（量能单一真值源）');
  ok(src.includes("schema: 'pos-model-135-1'"), '主判 schema = pos-model-135-1');
  ok(src.includes("require('./posModel135')"), '135 格知识表接线（posModel135 同源真值）');
  ok(/const posJudgment = _posVolumeMatrix\(pc, \{ \.\.\.ctxBase, rules, levels, position, currentSideways, band20, trend20, trendSegment: trendSeg \}, bars\);/.test(src), '主判调用传入 bars（ADX/道氏/信号层需要）');
  ok(src.includes('function _adx14') && src.includes('function _dowStructure') && src.includes('function _maArrange') && src.includes('function _boxQuant') && src.includes('function _runState'), '五步判定函数齐备');
  ok(src.includes('function _volTier5') && src.includes('function _walkTier5') && src.includes('function _posZone'), '量能五档/走势五档/位置 3 区函数齐备');
  ok(src.includes('function _signalLayer') && src.includes('function _specialCases'), '信号叠加层/异常特例函数齐备');
  ok(!src.includes('POS_VM_MATRIX'), '旧 24 格知识表已随 D2 删除（新链仅用 posModel135.volCell，旧体系完全移除）');
  ok(src.includes("require('./chipDistribution')") && src.includes('quoteSnapshot: input.quoteSnapshot') && src.includes('chip: input.chip'), '锚点二/三数据接线（quote PE/PB 快照 + 本地 CYQ 筹码入 ctx）');
  ok(src.includes('锚点三 · 筹码获利盘') && src.includes('获利盘'), '锚点三 refs 输出真实筹码数据');
  const chipSrc = fs.readFileSync(path.join(ROOT, 'lib', 'chipDistribution.js'), 'utf8');
  ok(chipSrc.includes('function computeChipDistribution') && chipSrc.includes('CYQ_WINDOW = 250'), '筹码模块导出与 250 日窗口参数');
  const pmSrc = fs.readFileSync(path.join(ROOT, 'lib', 'posModel135.js'), 'utf8');
  ok(pmSrc.includes('module.exports = { ZONES, STRONG, DERIVED_KEYS, TIER5, volCell }'), 'posModel135 导出齐备');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
