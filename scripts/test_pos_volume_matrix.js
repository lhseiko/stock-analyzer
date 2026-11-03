/**
 * 位置感知量价判定主判（图片 24 格矩阵）回归（零网络）
 * -----------------------------------------------------------------------
 * 运行： node scripts/test_pos_volume_matrix.js
 *
 * 用户需求（2026-11-01）：「资金量能的量能分析模块的量价十口诀替换成图片中的判定逻辑，
 * 先定位当前股价的位置，然后结合当前的量能和涨跌幅来输出判定分析，原来的量价十口诀
 * 作为补充辅助，重复的地方删除。」
 *
 * 覆盖：24 格矩阵完整性（4 位置 × 6 格）/ 关键格文案与图片对齐 /
 *       24 组归格路由 / 方向口径与 capitalFlow.vpPositionSignal 一致 /
 *       诚实降级（震荡整理 / 量比不足 / 涨跌 0 / 涨跌幅缺）/ 源码接线守卫。
 */
const fs = require('fs');
const path = require('path');
const ve = require('../lib/volumeEngine');
const { vpPositionSignal } = require('../lib/capitalFlow');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

function mkPc(over) {
  return Object.assign({
    n: 30, level: '平量', ratio5: 1.0, chgPct: 2.0,
    lowToday: 9.8, highToday: 10.2, closeToday: 10.05,
    lows: new Array(30).fill(9.8), highs: new Array(30).fill(10.2),
  }, over);
}
const CTX = { position: { label: '低位区间' } };
function run(pc, label) {
  return ve._posVolumeMatrix(pc, { ...CTX, position: { label: label || '低位区间' } });
}
const TIER_PC = {
  '放量': { level: '大量', ratio5: 1.5 },
  '缩量': { level: '缩量', ratio5: 0.6 },
  '平量': { level: '平量', ratio5: 1.0 },
};
const DIR_CHG = { '上涨': 2.0, '下跌': -2.0 };

// ============================================================================
// [1] 24 格矩阵完整性
// ============================================================================
console.log('\n[1] 24 格矩阵完整性');
{
  const positions = ['低位区间', '高位区间', '上涨中途', '下跌途中'];
  const cellKeys = ['放量上涨', '放量下跌', '缩量上涨', '缩量下跌', '平量上涨', '平量下跌'];
  ok(Object.keys(ve.POS_VM_MATRIX).length === 4, '矩阵含 4 个位置');
  for (const p of positions) {
    const meta = ve.POS_VM_MATRIX[p];
    ok(!!meta, `位置 ${p} 存在`);
    ok(cellKeys.every(k => meta.cells[k] && meta.cells[k].conclusion), `位置 ${p} 6 格齐全且有定性结论`);
    ok(['bull', 'bear', 'caution', 'observe'].includes(meta.cells['放量上涨'].direction), `位置 ${p} 方向口径合法`);
  }
  ok(ve.POS_VM_MATRIX['低位区间'].display === '低位区' && ve.POS_VM_MATRIX['高位区间'].display === '高位区'
    && ve.POS_VM_MATRIX['上涨中途'].display === '上涨途中' && ve.POS_VM_MATRIX['下跌途中'].display === '下跌途中', '展示名对齐图片（低位区/高位区/上涨途中/下跌途中）');
}

// ============================================================================
// [2] 关键格文案与图片对齐（逐格抽查图片原文关键词）
// ============================================================================
console.log('\n[2] 关键格文案对齐图片');
{
  const M = ve.POS_VM_MATRIX;
  ok(M['低位区间'].cells['放量上涨'].conclusion.includes('吸筹'), '低位·放量上涨 含「吸筹」');
  ok(M['低位区间'].cells['平量下跌'].conclusion.includes('不要提前抄底'), '低位·平量下跌 含「不要提前抄底」');
  ok(M['低位区间'].cells['平量上涨'].conclusion.includes('弱反弹'), '低位·平量上涨 含「弱反弹」（图片分化结论）');
  ok(M['高位区间'].cells['放量上涨'].conclusion.includes('对倒') || M['高位区间'].cells['放量上涨'].conclusion.includes('见顶'), '高位·放量上涨 含「对倒/见顶」');
  ok(M['高位区间'].cells['放量下跌'].conclusion.includes('减仓离场'), '高位·放量下跌 含「减仓离场」');
  ok(M['高位区间'].cells['缩量上涨'].conclusion.includes('无量空涨'), '高位·缩量上涨 含「无量空涨」');
  ok(M['高位区间'].cells['平量上涨'].conclusion.includes('没有后劲') && M['高位区间'].cells['平量上涨'].conclusion.includes('滞涨'), '高位·平量上涨 含「滞涨/没有后劲」（图片分化结论）');
  ok(M['高位区间'].cells['平量下跌'].conclusion.includes('温水煮青蛙'), '高位·平量下跌 含「温水煮青蛙」（图片分化结论）');
  ok(M['上涨中途'].cells['放量上涨'].conclusion.includes('主升浪'), '上涨途中·放量上涨 含「主升浪」');
  ok(M['上涨中途'].cells['缩量上涨'].conclusion.includes('控盘'), '上涨途中·缩量上涨 含「控盘」（图片分化结论）');
  ok(M['上涨中途'].cells['平量上涨'].conclusion.includes('良性休整'), '上涨途中·平量上涨 含「良性休整」（图片分化结论）');
  ok(M['上涨中途'].cells['平量下跌'].conclusion.includes('良性回调'), '上涨途中·平量下跌 含「良性回调」（图片分化结论）');
  ok(M['下跌途中'].cells['缩量上涨'].conclusion.includes('地量反弹') || M['下跌途中'].cells['缩量上涨'].conclusion.includes('弱势反弹'), '下跌途中·缩量上涨 含「地量反弹/弱势反弹」');
  ok(M['下跌途中'].cells['平量上涨'].conclusion.includes('逃命'), '下跌途中·平量上涨 含「逃命机会」（图片分化结论）');
  ok(M['下跌途中'].cells['平量下跌'].conclusion.includes('阴跌'), '下跌途中·平量下跌 含「阴跌」');
}

// ============================================================================
// [3] 24 组归格路由（位置 × 量能档位 × 涨跌幅 → 命中对应格）
// ============================================================================
console.log('\n[3] 24 组归格路由');
{
  let routed = 0;
  for (const p of Object.keys(ve.POS_VM_MATRIX)) {
    for (const tier of Object.keys(TIER_PC)) {
      for (const dir of Object.keys(DIR_CHG)) {
        const r = run(mkPc({ ...TIER_PC[tier], chgPct: DIR_CHG[dir] }), p);
        const key = `${tier}${dir}`;
        if (r.cell && r.cell.key === key && r.cells.find(c => c.hit).key === key) routed++;
        else ok(false, `${p} + ${key} 归格失败（实际 ${r.cell ? r.cell.key : 'null'}）`);
      }
    }
  }
  ok(routed === 24, `24 组全部正确归格（实际 ${routed}/24）`);
  const r = run(mkPc({ ...TIER_PC['放量'], chgPct: 2.0 }), '高位区间');
  ok(r.summary.includes('第一步') && r.summary.includes('第二步'), 'summary 按「第一步定位 → 第二步结合量能涨跌」叙述');
}

// ============================================================================
// [4] 方向口径与 capitalFlow.vpPositionSignal 一致（20261101c 位置覆盖表互证）
// ============================================================================
console.log('\n[4] 与 vpPositionSignal 方向互证');
{
  const cases = [
    ['高位区间', '放量上涨', 'bear'],
    ['上涨中途', '缩量上涨', 'bull'],
    ['低位区间', '放量上涨', 'bull'],
    ['下跌途中', '放量下跌', 'bear'],
    ['下跌途中', '缩量上涨', 'caution'],
  ];
  for (const [p, key, dir] of cases) {
    const cell = ve.POS_VM_MATRIX[p].cells[key];
    ok(cell.direction === dir, `${p}·${key} → ${dir}（实际 ${cell.direction}）`);
    const vpScore = vpPositionSignal(key, p);
    const sameSign = dir === 'bull' ? vpScore > 0 : (dir === 'bear' ? vpScore < 0 : true);
    ok(sameSign, `${p}·${key} vpPositionSignal 分值 ${vpScore} 与矩阵方向同号`);
  }
}

// ============================================================================
// [5] 诚实降级：不硬套矩阵
// ============================================================================
console.log('\n[5] 诚实降级');
{
  // 20261103c：箱体分支判定需 ctx.currentSideways（与生产一致：海天味业实卡 第二步=区间震荡 即 currentSideways=true）
  const runSw = (pc, label, extra) => ve._posVolumeMatrix(pc, { ...CTX, position: { label: label || '震荡整理' }, currentSideways: true, band20: 0.116, ...(extra || {}) });
  const r1 = runSw(mkPc(), '震荡整理');
  ok(r1.cell === null && r1.summary.includes('矩阵不适用'), '位置=震荡整理 → 24 格主矩阵不适用（cell=null 不变）');
  // 20261103b（版面统一）→ 20261103c（用户指令：箱体形态升为主要判定逻辑）——
  // 横盘位置接入判定优先级链：极端量能 > 量价背离 > 箱体；箱体命中行即当日主判（中性档位方向）
  ok(r1.extRef && Array.isArray(r1.extRef.trendExtra) && r1.extRef.trendExtra.length === 0, '震荡整理 → extRef.trendExtra 为空数组（前端跳过趋势运行组）');
  ok(r1.extRef && Array.isArray(r1.extRef.box) && r1.extRef.box.length === 14 && r1.extRef.boxTitle.includes('箱体'), '震荡整理 → extRef 带中性箱体 14 形态参考（8 基础 + 6 强形态，20261103m）');
  ok(r1.extJudgment && r1.extJudgment.branch === '区间横盘震荡' && r1.extJudgment.key === '平量上涨', '震荡整理 → 箱体分支生效为主判（平量上涨命中，20261103c）');
  ok(r1.extJudgment && r1.extJudgment.direction === 'observe', '横盘箱体方向用中性档位表（平量上涨=observe，不绑定牛熊，20261103c）');
  ok(r1.summary.includes('分支生效'), '震荡整理 summary 指向箱体主判（说明去重，20261103c）');
  ok(r1.anomaly && typeof r1.anomaly.divergence.triggered === 'boolean', '震荡整理 → 异常判定状态行同步输出（版面统一，20261103c）');
  // 诚实降级零变化：涨跌幅=0 → 箱体无可归格 → 无主判、如实观察
  const r1z = runSw(mkPc({ chgPct: 0 }), '震荡整理');
  ok(r1z.cell === null && !r1z.extJudgment && r1z.summary.includes('观察处理'), '震荡整理+涨跌幅0 → 箱体无可归格，诚实降级为观察（20261103c）');
  // 弱方向（放量 + 涨跌幅 ±1.2% 以内）→ 箱体滞涨/滞跌形态优先
  const r1w = runSw(mkPc({ level: '放量', ratio5: 2.0, chgPct: 0.5 }), '震荡整理');
  ok(r1w.extJudgment && r1w.extJudgment.key === '放量滞涨' && r1w.extJudgment.direction === 'caution', '震荡整理+放量弱上涨 → 箱体放量滞涨优先（caution，20261103c）');
  const r2 = run(mkPc({ ratio5: null }), '低位区间');
  ok(r2.cell === null && r2.volume.tier === null && r2.summary.includes('数据不足'), '量比数据不足 → 不硬套量能档位');
  const r3 = run(mkPc({ chgPct: 0 }), '低位区间');
  ok(r3.cell === null && r3.price.dir === null && r3.summary.includes('观察'), '涨跌幅=0 → 不硬套方向');
  const r4 = run(mkPc({ chgPct: null }), '低位区间');
  ok(r4.cell === null && r4.summary.includes('观察'), '涨跌幅缺失 → 不硬套方向');
  const r5 = run(mkPc({ chgPct: 0.5 }), '高位区间');
  ok(r5.cell && r5.price.weakAmp === true && r5.summary.includes('±1.2%'), '涨跌幅 <1.2% → 仍归格但如实标注方向含义减弱');
}

// ============================================================================
// [6] 源码守卫：引擎接线 / 前端主判升位 / 十口诀降辅助
// ============================================================================
console.log('\n[6] 源码守卫');
{
  const eng = fs.readFileSync(path.join(__dirname, '..', 'lib', 'volumeEngine.js'), 'utf8');
  ok(eng.includes('function _posVolumeMatrix(pc, ctx)'), '引擎已定义 _posVolumeMatrix');
  ok(eng.includes('const posJudgment = _posVolumeMatrix(pc,'), 'computeVolumeEngine 已调用 _posVolumeMatrix');
  ok(/posJudgment,\s*\n\s*\};/.test(eng), '输出对象含 posJudgment 字段');
  ok(eng.includes("schema: 'volume-engine-20261101d'"), '引擎 schema 升至 20261101d');
  ok(eng.includes('_posVolumeMatrix,'), '_posVolumeMatrix 已导出（可单测）');

  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  ok(app.includes('量价判定（先定位置 × 运行状态 × 量能 × 涨跌幅）'), '前端主判卡标题（先定位置 × 运行状态 × 量能 × 涨跌幅，20261102g）');
  // 20261102g（用户指令：位置判定后增加「趋势运行 / 区间震荡」判定，原第二步顺延为第三步，另增异常判定）：
  ok(app.includes('第一步 · 位置定位') && app.includes('第二步 · 运行状态') && app.includes('第三步 · 量能 × 涨跌幅'), '主判卡三步结构（位置 → 运行状态 → 量能×涨跌）');
  // 20261102h（用户指令：趋势运行时附带说明是上涨趋势还是下跌趋势）
  ok(app.includes('mode.trend ? \' · \' + mode.trend'), '第二步 combo 附带趋势方向（上涨趋势 / 下跌趋势，20261102h）');
  // 20261102i（用户指令：思维导图各种量能下的股价震荡分析要在判定卡可见）——参考表灰色追加震荡/箱体形态
  ok(eng.includes('extRef: meta && POS_VM_EXT[pos]'), '引擎输出 extRef 参考字段（当前位置震荡 + 箱体形态，20261102i）');
  ok(app.includes('ve-posj-extrow') && app.includes('ve-posj-extgroup'), '参考表灰色追加震荡/箱体形态行（分组标题 + 参考徽标）');
  // 20261102j（用户指令：融合后量价形态与趋势运行/区间震荡判定重复，以思维导图展示方案为主）——
  // 参考表按导图结构重组：趋势运行组 11 形态同序交错合并（不再 6 主行 + 震荡灰行两段分列）+ 箱体组
  // 20261103m（用户指令：第三步补大涨/大跌强形态）：趋势运行组扩为 17 形态（6 强形态按量能段同序插入）
  ok(app.includes('TREND_FORM_ORDER') && app.includes('趋势运行（6 种量价形态 + 大涨 / 大跌强形态 + 震荡 / 滞涨 / 滞跌，思维导图同序交错）'), '参考表按思维导图结构重组：趋势运行组 17 形态同序交错（20261102j→20261103m 扩强形态）');
  ok(app.includes("(extRef.strong || []).find(x => x.k === k)") && eng.includes('strong: POS_VM_STRONG_CELL_ORDER.map'), '强形态行渲染链（extRef.strong 透出 + 前端查找，20261103m）');
  ok(app.includes('esc(extRef.boxTitle)') && app.includes('${tableRows}'), '箱体组标题 + 表体统一走 tableRows（extRef 缺失退回 6 主格，20261102j）');
  ok(app.includes('仅展示当日生效判定所属分支的形态组') && app.includes('boxActive'), '表下注按生效分支口径更新 + 分组切换接线（20261102j→20261103m）');
  // 20261102k（用户报障：海天味业量价判定下表无内容）→ 20261103b 升级（用户报障：横盘股版面与其他个股不一样）：
  // 震荡整理位置现由引擎补箱体参考表（版面统一），原空表注精简为仅位置数据不足时显示（说明去重）
  ok(app.includes('const tableHtml = tableRows') && app.includes('量价判定矩阵与参考表暂不可用'), '位置数据不足降级注精简（tableHtml 条件出口，20261102k→20261103b）');
  ok(app.includes('hasTrendGroup') && eng.includes('POS_VM_SIDEWAYS_BOX') && eng.includes('区间横盘震荡（箱体）——当前位置专属参考'), '横盘位置箱体参考表：引擎 POS_VM_SIDEWAYS_BOX + 前端 trendExtra 空时只渲染箱体组（版面统一，20261103b）');
  ok(eng.includes('POS_VM_SIDEWAYS_TONE') && eng.includes('isSidewaysPos') && eng.includes('POS_VM_SIDEWAYS_EXT'), '横盘位置接入判定优先级链（极端量能>背离>箱体，中性档位方向，20261103c）');
  ok(app.includes('异常判定 · 背离 / 极端量能') && app.includes("anomalyRow('量价背离'") && app.includes("anomalyRow('极端量能'"), '异常判定块（量价背离 / 极端量能状态展示）');
  ok(app.includes('ve.posJudgment'), '前端渲染 posJudgment');
  // 20261101e：用户指令「十口诀内容无需再展示」→ 十口诀卡整卡移除（引擎层 tenRules 保留）
  ok(!app.includes('量价十口诀（补充辅助）') && !app.includes('tenHtml'), '十口诀卡已整卡移除（不再渲染）');
  ok(!app.includes('主判 · 第 '), '十口诀卡的主判高亮已删除（消除重复）');
  ok(!app.includes('<th>今判</th>'), '十口诀表的「今判」列已删除（消除重复）');
  ok(app.indexOf('${posHtml}') > -1 && app.indexOf('${tenHtml}') === -1, '主判矩阵正常渲染、十口诀不再出现在模板中');

  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
  ok(css.includes('.ve-posj-main') && css.includes('.ve-posj-table'), '主判卡样式已就位');
  ok(css.includes('.ve-posj-table tr.ve-posj-extrow td'), '扩展参考行灰色弱化样式已就位（20261102i）');

  // 20261101f：非命中行一律中性灰徽标，方向色仅命中行保留（防「偏多」红标误读为当前判多）
  ok(app.includes("c.hit ? badgeCls(c.direction) : ''"), '参考表非命中行使用中性灰徽标（方向色仅命中行）');
  ok(app.includes('琥珀「命中」=当日生效判定') && app.includes('偏多=倾向上涨、看空=倾向下跌'), '表下附徽标图例与命中对照说明（20261103m 口径）');

  // 20261101h：去重（用户确认方案）——四维度只渲染资金行为/筹码转移；第二步精简
  // 20261101j（用户截图指令）：独立「资金行为与筹码转移」小节删除，内容并入卡片——
  //   指标行「价格位置」tile → 「筹码转移」（位置与量价判定·第一步重复）；
  //   量价配合行「今日涨跌」卡（与页头涨跌重复）→ 「资金行为」；ve-vp-line 说明行整行删除。
  //   「资金行为/筹码转移」单一数组字面量 dimTexts 保留，卡片与 tile 共用。
  ok(!app.includes("['量能状态'") && !app.includes("['量能口径'") && !app.includes("['价格位置', dim.position]"), '四维度重复三行（量能状态/价格位置/量能口径）已从前端移除');
  ok(app.includes("['资金行为', dim.capitalBehavior]") && app.includes("['筹码转移', dim.chipTransfer]"), '资金行为/筹码转移单一数组字面量保留（卡与 tile 共用）');
  ok(!app.includes('ve-dims') && !app.includes('ve-vp-line') && !app.includes('资金行为与筹码转移'), '独立小节、量价说明行已删除（20261101j，内容并入卡片）');
  ok(app.includes("['筹码转移', `<span class=\"cm-value-text${toneCls(dim.chipTransferTone)}\">") && app.includes('<span class="cm-label">资金行为</span>'), '筹码转移并入指标行 tile、资金行为并入量价配合卡（cm-value-text 长文本样式；20261103f 起 tone 着色）');
  ok(!app.includes('cm-label">今日涨跌'), '「今日涨跌」卡已移除（与页头涨跌幅重复）');
  ok(app.includes('const step2Note'), '第二步精简：重复数值仅数据不足降级时保留');
}

// ============================================================================
// [7] 20261102g：第二步运行状态（趋势运行 / 区间震荡）+ 异常判定（量价背离 / 极端量能）
// ============================================================================
console.log('\n[7] 运行状态与异常判定（20261102g）');
{
  const rTrend = run(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), '低位区间');
  ok(rTrend.mode && rTrend.mode.key === '趋势运行' && rTrend.mode.sideways === false, '无横盘 ctx → 第二步判定为趋势运行');
  ok(rTrend.anomaly && rTrend.anomaly.divergence.triggered === false && rTrend.anomaly.extreme.triggered === false, '异常判定默认未触发且字段齐全');
  ok(rTrend.anomaly.extreme.note.includes('未触发'), '极端量能未触发时如实标注依据');
  // 20261102h（用户指令：趋势运行时附带说明是上涨趋势还是下跌趋势）——依据近 20 日净涨跌幅 trend20 正负
  const rUp = ve._posVolumeMatrix(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), { ...CTX, position: { label: '低位区间' }, trend20: 0.12 });
  ok(rUp.mode.key === '趋势运行' && rUp.mode.trend === '上涨趋势' && rUp.mode.trendPct === '+12%', '近 20 日净涨跌 +12% → 趋势运行附带「上涨趋势」（百分比展示）');
  ok(rUp.mode.note.includes('为上涨趋势') && rUp.summary.includes('（上涨趋势）'), '上涨方向写入 mode.note 与 summary');
  const rDown = ve._posVolumeMatrix(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), { ...CTX, position: { label: '低位区间' }, trend20: -0.08 });
  ok(rDown.mode.trend === '下跌趋势' && rDown.mode.trendPct === '-8%', '近 20 日净涨跌 -8% → 趋势运行附带「下跌趋势」');
  const rFlat = ve._posVolumeMatrix(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), { ...CTX, position: { label: '低位区间' }, trend20: 0 });
  ok(rFlat.mode.trend === null && rFlat.mode.note.includes('方向中性'), '净涨跌恰为 0 → 方向中性如实标注（不硬套）');
  const rNoTrend = ve._posVolumeMatrix(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), { ...CTX, position: { label: '低位区间' } });
  ok(rNoTrend.mode.trend === null && rNoTrend.mode.note.includes('方向未知'), 'trend20 数据不足 → 趋势方向未知如实标注');
  const rBoxTrend = ve._posVolumeMatrix(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), { ...CTX, position: { label: '低位区间' }, currentSideways: true, band20: 0.08, trend20: 0.12 });
  ok(rBoxTrend.mode.key === '区间震荡' && rBoxTrend.mode.trend === null, '区间震荡 → 不附带趋势方向（箱体口径无趋势方向）');
  const rBox = ve._posVolumeMatrix(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), { ...CTX, position: { label: '低位区间' }, currentSideways: true, band20: 0.08 });
  ok(rBox.mode.key === '区间震荡' && rBox.mode.band === '8%', '横盘 ctx → 第二步判定为区间震荡（带宽 8% 展示）');
  ok(rBox.extJudgment && rBox.extJudgment.branch === '区间横盘震荡', '区间震荡 → 箱体分支优先生效（仍为当日唯一判定）');
  const rDiv = ve._posVolumeMatrix(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), { ...CTX, position: { label: '低位区间' }, divergence: { type: '底背离', note: '价新低量能未新低' } });
  ok(rDiv.anomaly.divergence.triggered && rDiv.anomaly.divergence.key === '底背离', '底背离 → 异常判定块命中');
  ok(rDiv.extJudgment && rDiv.extJudgment.branch === '量价背离', '底背离 → 异常判定优先生效为当日唯一判定');
  const rGen = ve._posVolumeMatrix(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), { ...CTX, position: { label: '低位区间' }, divergence: { type: '一般量价背离', note: '量价一般性背离' } });
  ok(rGen.anomaly.divergence.triggered === false && rGen.anomaly.divergence.note.includes('不构成异常判定'), '一般量价背离 → 如实标注不构成异常判定（不硬套）');
  const rSky = run(mkPc({ level: '天量', ratio5: 5.0, chgPct: 2.0 }), '低位区间');
  ok(rSky.anomaly.extreme.triggered && rSky.anomaly.extreme.key === '天量', '天量 → 异常判定块命中');
  ok(rSky.extJudgment && rSky.extJudgment.branch === '极端量能', '天量 → 异常判定优先生效为当日唯一判定');
  const rPend = ve._posVolumeMatrix(mkPc({ level: '天量', ratio5: 5.0, chgPct: 2.0 }), { ...CTX, position: { label: '低位区间' }, intradayPending: true });
  ok(rPend.anomaly.extreme.pending === true && rPend.anomaly.extreme.triggered === false, '盘中天量 → 极端量能盘中停判（诚实降级）');
  ok(!rPend.extJudgment && rPend.cell && rPend.cell.key === '放量上涨', '盘中天量停判 → 回落第三步主矩阵归格为当日判定');
}

// ============================================================================
// [8] 20261102i：扩展参考字段（震荡 / 箱体形态，参考表灰色追加，不参与判定）
// ============================================================================
console.log('\n[8] 扩展参考字段（20261102i）');
{
  const r = run(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), '低位区间');
  ok(r.extRef && Array.isArray(r.extRef.trendExtra) && r.extRef.trendExtra.length === 5, 'extRef.trendExtra = 当前位置 5 种趋势震荡形态（放量/缩量/平量震荡 · 滞涨 · 滞跌）');
  ok(r.extRef.trendExtra.some(it => it.k === '放量滞涨' && it.d.length > 5), 'trendExtra 形态含分析文字（k + d）');
  ok(r.extRef.boxTitle && r.extRef.boxTitle.includes('箱体'), 'extRef.boxTitle 为当前位置箱体标题');
  ok(Array.isArray(r.extRef.box) && r.extRef.box.length === 14, 'extRef.box = 当前位置 14 种箱体形态（8 基础 + 6 强形态，20261103m）');
  ok(r.extRef.box.some(it => it.k === '放量滞跌' && it.d.length > 5), 'box 形态含分析文字（k + d）');
  // 判定零变化：extRef 不影响 cell / extJudgment（仍是主矩阵归格）
  ok(r.cell && r.cell.key === '平量上涨' && !r.extJudgment, 'extRef 仅参考不参与判定（cell/extJudgment 零变化）');
  // 位置不适用时 extRef 为 null（与 meta 同口径）
  const rNa = ve._posVolumeMatrix(mkPc({ level: '平量', ratio5: 1.0, chgPct: 2.0 }), { ...CTX, position: { label: '未知位置' } });
  ok(rNa.extRef === null, '位置不适用 → extRef 为 null（前端不追加行）');
}

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
