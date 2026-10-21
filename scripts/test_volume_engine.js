/**
 * 量能分析引擎 · 行为回归（零网络，全合成数据）
 * --------------------------------------------------------------
 * 运行： node scripts/test_volume_engine.js
 * 覆盖：lib/volumeEngine.js（20261017f，依据《AI 股票量能分析工作台统一业务逻辑说明书》；20261019f 定档标准对齐市场标准量比 0.8/1.2/0.5、60 日确认不再翻转档位）——
 *   [1] 输入下限校验        [2] 预计算与档位/确认口径
 *   [3] 位置判定（四态+横盘+分歧） [4] 量价三问
 *   [5] 背离检测            [6] 五大生死位规则（含数据不足标注）
 *   [7] 位置×量能组合矩阵    [8] 连续量能序列
 *   [9] 打分权重与扣分      [10] 流动性分层/兜底/样本不足/数据降级
 *   [11] 黑名单衰减         [12] 信号分类（空头优先/多头失效/极度缩量禁多）
 *   [13] 输出结构完整性与禁交易指令扫描   [14] 缺 amount/turnover 通道降级
 *   [15] 7.4 不同位置量价补充规则（四形态+子阶段） [16] 7.5 五句量比实战口诀
 *   [17] 11.2/11.3/11.4 三个强制归集总结 + 一致性约束 + s40 约束
 *   [18] 20261020a 底部区域相位分类（构筑期/启动确认区/方向不明）：该放/该缩期望单源推导、两侧互斥
 * 说明：网络采集（东财日K/分时/公告）由服务端实测覆盖，本文件只测确定性引擎逻辑。
 */
const ve = require('../lib/volumeEngine');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// 合成日线：fn(i) 返回 {open,high,low,close,volume,amount,turnover}，date 自动编
function mkBars(n, fn) {
  return Array.from({ length: n }, (_, i) => {
    const d = fn(i);
    return {
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open: d.open, high: d.high, low: d.low, close: d.close,
      volume: d.volume, amount: d.amount, turnover: d.turnover,
    };
  });
}
const flatBar = (p, vol, extra = {}) => ({ open: p, high: p * 1.002, low: p * 0.998, close: p, volume: vol, amount: p * vol * 100, turnover: 1.5, ...extra });

// ============ [1] 输入下限 ============
console.log('\n[1] 输入下限：少于 10 根 → ok:false 且标注样本不足（不臆造）');
{
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars: mkBars(9, i => flatBar(10, 1000)), minutes: null, blacklistReasons: [] });
  ok(r.ok === false, '9 根 → ok:false');
  ok(/少于 10 根/.test(r.error || ''), `错误信息含样本不足说明（实际：${r.error}）`);
  ok(Array.isArray(r.dataGaps) && r.dataGaps.includes('日线样本不足'), 'dataGaps 含「日线样本不足」');
  const r2 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars: [], minutes: null, blacklistReasons: [] });
  ok(r2.ok === false, '空数组 → ok:false');
  const r3 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars: null, minutes: null, blacklistReasons: [] });
  ok(r3.ok === false, 'null bars → ok:false');
}

// ============ [2] 预计算与档位 ============
console.log('\n[2] 预计算：均量不含当日；六档边界（20261019f 对齐市场标准 0.8/1.2/0.5）；60 日均量确认（不再翻转档位）');
{
  // 前 259 根量 1000，最后一日 300 → ratio5 = 300/1000 = 0.3 → 极度缩量
  const bars = mkBars(260, i => flatBar(10 + i * 0.001, i === 259 ? 300 : 1000));
  const pc = ve._precompute(bars);
  ok(pc.avg5 === 1000, `5 日均量不含当日 = 1000（实际 ${pc.avg5}）`);
  ok(Math.abs(pc.ratio5 - 0.3) < 1e-9, `ratio5 = 0.3（实际 ${pc.ratio5}）`);
  ok(pc.level === '极度缩量', `档位 = 极度缩量（实际 ${pc.level}）`);
  ok(pc.confirm === '缩量', `60 日均量口径 = 缩量（实际 ${pc.confirm}）`);
}
{
  const tier = (v) => {
    const bars = mkBars(60, i => flatBar(10, i === 59 ? 1000 * v : 1000));
    return ve._precompute(bars).level;
  };
  // 20261019f：六档阈值对齐市场标准量比（缩量 <0.8 / 平量 [0.8,1.2] / 放量 >1.2 / 极度缩量 <0.5）
  ok(tier(0.39) === '极度缩量', '0.39 → 极度缩量');
  ok(tier(0.49) === '极度缩量', '0.49 → 极度缩量（新边界不含）');
  ok(tier(0.5) === '温和缩量', '0.50 → 温和缩量（边界含）');
  ok(tier(0.79) === '温和缩量', '0.79 → 温和缩量');
  ok(tier(0.8) === '平量', '0.80 → 平量（边界含）');
  ok(tier(1.2) === '平量', '1.20 → 平量（边界含）');
  ok(tier(1.21) === '温和放量', '1.21 → 温和放量');
  ok(tier(2.5) === '温和放量', '2.50 → 温和放量（边界含）');
  ok(tier(2.51) === '大量', '2.51 → 大量');
  ok(tier(4) === '大量', '4.00 → 大量（边界含）');
  ok(tier(4.01) === '天量', '4.01 → 天量');
}
{
  // 20261019f：市场标准对齐回归（用户新洋丰 000902 实测反馈：量比 0.99 市场=平量，
  // 旧逻辑因 60 日均量口径把平量翻成「温和缩量」，与市场标准矛盾）。
  // 核心不变量：定档只看 ÷5 日均量（市场标准量比），60 日确认不得翻转档位，仅作分歧披露。
  // 场景复刻：前 54 日大量（1400）→ 近 5 日回落至 1000 → 当日 950：
  //   ratio5 = 950/1000 = 0.95（平量）；60 日均量 ≈1383，950 < 1383×0.7=968 → 60 日口径缩量。
  const bars = mkBars(60, i => flatBar(10, i < 54 ? 1400 : (i < 59 ? 1000 : 950)));
  const pc = ve._precompute(bars);
  ok(Math.abs(pc.ratio5 - 0.95) < 0.01, `场景 ratio5=0.95（实际 ${pc.ratio5}）`);
  ok(pc.confirm === '缩量', `60 日均量口径 = 缩量（实际 ${pc.confirm}）`);
  ok(pc.level === '平量', `5 日量比 0.95 → 平量（市场标准，实际 ${pc.level}）`);
  ok(pc.judgedLevel === '平量', 'judgedLevel 恒等于 level（60 日确认不翻转档位）');
  const t = ve._volumeTier(pc);
  ok(t.tier === '平量' && t.shrunk === false && t.amplified === false, 'volumeTier：tier=平量、amplified/shrunk 均 false（旧逻辑 shrunk 会翻成 true）');
  ok(t.consistent === false, '60 日口径与 5 日档位不一致 → consistent=false');
  ok(/60 日均量口径确认为「缩量」/.test(t.divergenceNote || '') && /市场标准量比/.test(t.divergenceNote || ''), '分歧说明披露 60 日口径，并声明「档位以 ÷5 日均量（市场标准量比）为准」');
  const r = ve.computeVolumeEngine({ symbol: 'X', name: 'X', bars, barsSource: 'tencent' });
  ok(r.ok && r.volumeState.level === '平量', `端到端 volumeState.level=平量（实际 ${r.volumeState && r.volumeState.level}）`);
  ok(r.ok && r.volumeState.ratio5Level === '平量', 'ratio5Level 同为平量（定档改后两者一致）');
  // 反向场景：量比 0.75（<0.8）→ 缩量（即使 60 日口径未确认）；量比 1.25（>1.2）→ 放量
  const bShrink = mkBars(60, i => flatBar(10, i === 59 ? 750 : 1000));
  const tShrink = ve._volumeTier(ve._precompute(bShrink));
  ok(tShrink.tier === '温和缩量' && tShrink.shrunk === true, '量比 0.75（<0.8）→ 温和缩量（市场标准，无需 60 日确认）');
  const bAmp = mkBars(60, i => flatBar(10, i === 59 ? 1250 : 1000));
  const tAmp = ve._volumeTier(ve._precompute(bAmp));
  ok(tAmp.tier === '温和放量' && tAmp.amplified === true, '量比 1.25（>1.2）→ 温和放量（市场标准）');
}
{
  // 放量确认：最近一日 > 60 日均量 ×1.5
  const bars = mkBars(80, i => flatBar(10, i === 79 ? 1600 : 1000));
  const pc = ve._precompute(bars);
  ok(pc.confirm === '放量', `1600 > 1000×1.5 → 放量确认（实际 ${pc.confirm}）`);
  const bars2 = mkBars(80, i => flatBar(10, i === 79 ? 1500 : 1000));
  ok(ve._precompute(bars2).confirm === null, '1500 = 1000×1.5 边界 → 不确认（严格大于）');
}

// ============ [3] 位置判定 ============
console.log('\n[3] 位置判定：低位/高位/上涨中途/下跌途中/横盘并列/分歧标注');
{
  // 低位：从 20 跌到 10（分位≈0）
  const bars = mkBars(260, i => flatBar(20 - i * 0.04, 1000));
  const pc = ve._precompute(bars);
  const pos = ve._detectPosition(pc, null);
  ok(pos.label === '低位区间', `深跌 → 低位区间（实际 ${pos.label}）`);
  ok(pos.divergence === null, '深跌无位置分歧');
}
{
  // 高位：从 10 涨到 20（分位=100%）
  const bars = mkBars(260, i => flatBar(10 + i * 0.04, 1000));
  const pos = ve._detectPosition(ve._precompute(bars), null);
  ok(pos.label === '高位区间', `大涨 → 高位区间（实际 ${pos.label}）`);
}
{
  // 上涨中途：先跌至 10 再回升至 14（分位≈50%，趋势向上 close>MA20>MA60）
  const bars = mkBars(260, i => flatBar(i < 160 ? 18 - i * 0.05 : 10 + (i - 160) * 0.04, 1000));
  const pos = ve._detectPosition(ve._precompute(bars), null);
  ok(pos.label === '上涨中途', `深跌后回升 → 上涨中途（实际 ${pos.label}）`);
}
{
  // 下跌途中：趋势向下（分位居中、MA20<MA60）
  const bars = mkBars(260, i => flatBar(18 - i * 0.02, 1000));
  const pc = ve._precompute(bars);
  const pos = ve._detectPosition(pc, null);
  ok(pos.label === '低位区间' || pos.label === '下跌途中', `单调下跌 → 低位或下跌途中（实际 ${pos.label}）`);
}
{
  // 横盘并列标签：连续 20 日 ±1% 震荡
  const bars = mkBars(60, i => flatBar(10 + (i % 2 ? 0.05 : -0.05), 1000));
  const { currentSideways } = ve._sidewaysAndPlatform(bars);
  ok(currentSideways === true, '20 日 ±1% 震荡 → 横盘标记');
  const bars2 = mkBars(60, i => flatBar(10 * Math.pow(1.02, i), 1000)); // 每日 +2%
  ok(ve._sidewaysAndPlatform(bars2).currentSideways === false, '每日 +2% 单边上行 → 非横盘');
}
{
  // 分歧：分位低（贴近窗口低点）但距阶段高点不足 15%（窄幅震荡刚脱离底部）
  // 数据：10↔11.3 窄幅震荡（band 13%），末日收 10.1 → 分位≈7.7% 属低位，但距阶段高点仅 -10.6%（>-15%）
  const bars = mkBars(260, i => flatBar(i === 259 ? 10.1 : (i % 2 ? 11.3 : 10), 1000));
  const pos = ve._detectPosition(ve._precompute(bars), null);
  ok(pos.label === '低位区间' && pos.divergence && /分歧/.test(pos.divergence), `分位低位但贴近阶段高点 → 分歧标注（实际 ${pos.label} / ${pos.divergence}）`);
}

// ============ [4] 量价三问 ============
console.log('\n[4] 量价三问：真实性/价格认可度/持续性/单日脉冲');
{
  // 持续 2 日放量（均 1000，最近两日 2000）+ 当日上涨 → 三问全过
  const bars = mkBars(80, i => {
    const p = 10 + i * 0.001;
    const vol = i >= 78 ? 2000 : 1000;
    return i === 79 ? { open: p, high: p * 1.004, low: p * 0.998, close: p * 1.003, volume: vol, amount: p * vol * 100, turnover: 1.5 }
      : flatBar(p, vol);
  });
  const pc = ve._precompute(bars);
  const c = ve._threeChecks(pc);
  ok(c.authenticity.pass === true, '真实性：量能显著偏离日常 → 通过');
  ok(c.priceAcceptance.pass === true, '认可度：放量 + 收涨 → 通过');
  ok(c.persistence.pass === true, '持续性：连续 2 日放量 → 通过');
  ok(c.pulse === false, '非单日脉冲');
  ok(c.failed.length === 0, `failed 为空（实际 ${c.failed}）`);
}
{
  // 放量但收跌 → 价格认可度不足
  const bars = mkBars(80, i => {
    const p = 10 + i * 0.001;
    const vol = i >= 78 ? 2000 : 1000;
    return i === 79 ? { open: p, high: p * 1.001, low: p * 0.99, close: p * 0.985, volume: vol, amount: p * vol * 100, turnover: 1.5 }
      : flatBar(p, vol);
  });
  const c = ve._threeChecks(ve._precompute(bars));
  ok(c.priceAcceptance.pass === false && c.failed.includes('价格认可度不足'), '放量收跌 → 价格认可度不足');
}
{
  // 单日脉冲：前期大量（2000）→ 缩量期（800）→ 前两日 500 → 最后一日 5000 巨量
  const bars = mkBars(80, i => flatBar(10, i < 60 ? 2000 : (i >= 77 ? 500 : 800)));
  const bars2 = bars.map((b, i) => i === 79 ? { ...b, volume: 5000 } : b);
  const c = ve._threeChecks(ve._precompute(bars2));
  ok(c.pulse === true, '仅最新一根巨量 + 前后缩量 → 单日脉冲');
  ok(c.failed.includes('单日脉冲'), 'failed 含「单日脉冲」');
  ok(c.persistence.pass === false, '单日巨量 → 持续性不足');
}

// ============ [5] 背离检测 ============
console.log('\n[5] 背离：顶背离/底背离/一般/无');
{
  // 顶背离：创新高 + 量低于前日 + ratio5 回落
  const bars = mkBars(260, i => {
    const p = 10 + i * 0.04;
    const vol = i === 259 ? 900 : (i === 258 ? 1500 : 1000);
    return { open: p, high: p * 1.004, low: p * 0.998, close: p * 1.003, volume: vol, amount: p * vol * 100, turnover: 1.5 };
  });
  const d = ve._detectDivergence(ve._precompute(bars));
  ok(d.type === '顶背离', `创新高缩量且量能水平回落 → 顶背离（实际 ${d.type}）`);
}
{
  // 底背离：创新低 + 量低于前日 + ratio5 不再回落（萎缩放缓）
  // 数据：价格单调创新低；量能递减（1500→1400→…→900），
  // ratio5 = 900/mean(254..258)=900/1110=0.81 ≥ ratio5Prev = 950/mean(253..257)=950/1200=0.79 → 不再回落
  const bars = mkBars(260, i => {
    const p = 20 - i * 0.04;
    const vol = i >= 253 ? [1400, 1300, 1200, 1100, 1000, 950, 900][i - 253] : 1500;
    return { open: p, high: p * 1.002, low: p * 0.996, close: p * 0.997, volume: vol, amount: p * vol * 100, turnover: 1.5 };
  });
  const d = ve._detectDivergence(ve._precompute(bars));
  ok(d.type === '底背离', `创新低缩量但萎缩放缓 → 底背离（实际 ${d.type}）`);
}
{
  // 一般背离：创新低但量能与前日持平（既未放大也未萎缩）
  const bars = mkBars(260, i => {
    const p = 20 - i * 0.04;
    return { open: p, high: p * 1.002, low: p * 0.996, close: p * 0.997, volume: 1000, amount: p * 1000 * 100, turnover: 1.5 };
  });
  const d = ve._detectDivergence(ve._precompute(bars));
  ok(d.type === '一般量价背离', `创新低量平 → 一般量价背离（实际 ${d.type}）`);
}
{
  const bars = mkBars(260, i => flatBar(10, 1000));
  ok(ve._detectDivergence(ve._precompute(bars)).type === null, '无量价异动 → 无背离');
}

// ============ [6] 五大生死位规则 ============
console.log('\n[6] 五大生死位规则：命中/未命中/数据不足标注');
{
  // 规则1 低位吸筹：低位 + 前期横盘≥20日 + 连续3日放量 + 重心企稳
  const bars = mkBars(260, i => {
    const p = i < 200 ? 20 - i * 0.02 : 16 + (i - 200) * 0.002;
    const vol = i >= 257 ? 3000 : 1000;
    return flatBar(p, vol, i >= 257 ? { close: p * 1.001 } : {});
  });
  const pc = ve._precompute(bars);
  const { platform } = ve._sidewaysAndPlatform(bars);
  const ctx = { bars, pc, platform, levels: ve._keyLevels(pc, platform), position: ve._detectPosition(pc, platform), checks: ve._threeChecks(pc), minutes: null, symbol: '600000', name: '测试' };
  const rules = ve._lifeRules(pc, ctx);
  ok(rules[0].matched === true, '规则1 低位吸筹 → 命中');
  ok(rules[0].direction === 'bull', '规则1 方向 = bull');
  ok(/由散户向主力集中/.test(rules[0].conclusion), '规则1 结论含筹码转移方向表述');
}
{
  // 规则1 未命中：价格随放量下跌（重心未企稳）
  const bars = mkBars(260, i => flatBar(20 - i * 0.04, i >= 257 ? 3000 : 1000, i === 259 ? { close: 4 } : {}));
  const pc = ve._precompute(bars);
  const { platform } = ve._sidewaysAndPlatform(bars);
  const ctx = { bars, pc, platform, levels: ve._keyLevels(pc, platform), position: ve._detectPosition(pc, platform), checks: ve._threeChecks(pc), minutes: null, symbol: '600000', name: '测试' };
  const rules = ve._lifeRules(pc, ctx);
  ok(rules[0].matched === false, '价格随放量下跌 → 规则1 不命中');
  ok(rules[0].dataGaps.some(g => /企稳|下跌/.test(g)), '未命中原因如实标注（重心未企稳）');
}
{
  // 规则2 高位派发：高位 + 天量 + 换手率极高 + 分时震荡
  const bars = mkBars(260, i => {
    const p = 10 + i * 0.05, last = i === 259;
    return last
      ? { open: p, high: p * 1.005, low: p * 0.985, close: p * 0.995, volume: 8000, amount: p * 8000 * 100, turnover: 12 }
      : flatBar(p, 1000);
  });
  const minutes = { minutes: Array.from({ length: 60 }, (_, i) => {
    const price = 23 + Math.sin(i / 59 * Math.PI * 6) * 0.4;
    return { time: '09:30', price, avg: price, cumVol: 1000 + i * 20 };
  }), prevClose: 23 };
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes, blacklistReasons: [] });
  ok(r.rules[1].matched === true, '规则2 高位派发 → 命中');
  ok(r.rules[1].priority === 'top', '规则2 优先级 = 最高');
  ok(r.signal.category === '看空预警', '规则2 命中 → 看空预警');
  ok(r.riskTags.includes('高位派发'), '风险标签含「高位派发」');
}
{
  // 规则2 数据不足：无分时 → 不匹配 + 标注
  const bars = mkBars(260, i => {
    const p = 10 + i * 0.05, last = i === 259;
    return last
      ? { open: p, high: p * 1.005, low: p * 0.985, close: p * 0.995, volume: 8000, amount: p * 8000 * 100, turnover: 12 }
      : flatBar(p, 1000);
  });
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.rules[1].matched === false, '无分时数据 → 规则2 不匹配');
  ok(r.rules[1].dataGaps.some(g => /分时数据不足/.test(g)), '规则2 标注「分时数据不足，本规则不匹配」');
  ok(r.dataGaps.some(g => /分时数据不足/.test(g)), '顶层 dataGaps 同步收录分时不足');
}
{
  // 规则3 缩量假突破：冲击阶段高点后回落 + 量能未有效放大
  const bars = mkBars(260, i => {
    const attack = i >= 257;
    const p = attack ? 12.5 : 12;
    return attack
      ? { open: p, high: 12.7, low: p * 0.998, close: i === 259 ? 12.2 : 12.55, volume: 900, amount: p * 900 * 100, turnover: 1.5 }
      : flatBar(p, 1000);
  });
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.rules[2].matched === true, '规则3 缩量假突破 → 命中');
  ok(r.signal.category === '中性', '规则3 命中（多头失效）→ 不得看多，输出中性');
  ok(/多头失效信号/.test(r.signal.note), '分类说明含「多头失效信号」');
  ok(r.riskTags.includes('缩量假突破') && r.riskTags.includes('K线骗线'), '风险标签含缩量假突破 + K线骗线');
}
{
  // 规则3 未命中：突破日放量有效（前高 12.7 于 i=200 以 1000 手形成，攻击日 5000 手既超前高量又超 60 日均量×1.5）
  const bars = mkBars(260, i => {
    if (i === 200) return { open: 12, high: 12.7, low: 11.99, close: 12, volume: 1000, amount: 12 * 1000 * 100, turnover: 1.5 };
    if (i >= 257 && i < 259) return flatBar(12.5, 1000);
    if (i === 259) return { open: 12.5, high: 12.75, low: 12.45, close: 12.2, volume: 5000, amount: 12.2 * 5000 * 100, turnover: 1.5 };
    return flatBar(12, 1000);
  });
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.rules[2].matched === false, '突破日放量有效 → 规则3 不命中');
}
{
  // 规则4 放量破位：平台下沿放量跌破，连续 2 日站不回 → 看空预警
  const bars = mkBars(260, i => {
    let p, vol = 1000;
    if (i < 220) p = 10 + i * 0.03;
    else if (i < 258) p = 16.6 + Math.sin(i * 0.5) * 0.12;
    else if (i === 258) { p = 15.95; vol = 5000; }
    else { p = 15.9; vol = 5000; }
    return { open: p, high: p * (i >= 258 ? 1.001 : 1.002), low: p * (i >= 258 ? 0.99 : 0.998), close: p, volume: vol, amount: p * vol * 100, turnover: 2 };
  });
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.rules[3].matched === true, '规则4 放量破位（连续2日）→ 命中');
  ok(r.rules[3].partial === false, '非初步破位');
  ok(r.signal.category === '看空预警', '规则4 命中 → 看空预警');
  ok(r.riskTags.includes('放量破位'), '风险标签含「放量破位」');
}
{
  // 规则4 初步破位：仅最后一日跌破 → partial + 看空观察
  const bars = mkBars(260, i => {
    let p, vol = 1000;
    if (i < 220) p = 10 + i * 0.03;
    else if (i < 259) p = 16.6 + Math.sin(i * 0.5) * 0.12;
    else { p = 15.9; vol = 5000; }
    return { open: p, high: p * (i >= 259 ? 1.001 : 1.002), low: p * (i >= 259 ? 0.99 : 0.998), close: p, volume: vol, amount: p * vol * 100, turnover: 2 };
  });
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.rules[3].matched === false && r.rules[3].partial === true, '单日跌破 → 初步破位（partial）');
  ok(r.signal.category === '看空观察', '初步破位 → 看空观察');
  ok(/待确认/.test(r.rules[3].conclusion), '初步破位结论含「待确认」');
}
{
  // 规则5 分时无量拉升：分时价创新高 + 量逐级萎缩 + 无接力
  // 20261020c：规则5 尾盘窗口改按 time 时间戳截取后，夹具必须用真实 'HHMM' 时间戳
  // （腾讯分时契约；旧的 '09:30' 带冒号格式不可解析，会被整体剔除误判「交易时段数据不足」）
  const mm120 = Array.from({ length: 120 }, (_, i) => { const k = 9 * 60 + 30 + i; return `${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`; });
  const bars = mkBars(120, i => flatBar(10 + i * 0.02, 1000));
  let cum = 0;
  const minutes = { minutes: Array.from({ length: 120 }, (_, i) => {
    cum += Math.max(1, 30 - i * 0.2);
    const price = 12 + i * 0.001;
    return { time: mm120[i], price, avg: price, cumVol: cum };
  }), prevClose: 12 };
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes, blacklistReasons: [] });
  ok(r.rules[4].matched === true, '规则5 分时无量拉升 → 命中');
  ok(r.riskTags.includes('日内无量拉升'), '风险标签含「日内无量拉升」');
}
{
  // 规则5 数据不足：无分时
  const bars = mkBars(120, i => flatBar(10 + i * 0.02, 1000));
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.rules[4].matched === false && r.rules[4].dataGaps.some(g => /分时数据不足/.test(g)), '无分时 → 规则5 不匹配且标注');
}
{
  // 规则5 未命中：分时放量拉升（有接力）
  const bars = mkBars(120, i => flatBar(10 + i * 0.02, 1000));
  let cum = 0;
  const mm120b = Array.from({ length: 120 }, (_, i) => { const k = 9 * 60 + 30 + i; return `${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`; });
  const minutes = { minutes: Array.from({ length: 120 }, (_, i) => {
    cum += 50;
    const price = 12 + i * 0.001;
    return { time: mm120b[i], price, avg: price, cumVol: cum };
  }), prevClose: 12 };
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes, blacklistReasons: [] });
  ok(r.rules[4].matched === false, '分时等量拉升（有接力）→ 规则5 不命中');
}
// 20261020c：规则5 尾盘窗口盘后条目污染（用户 2026-10-20 截图报障 688289 圣湘生物误命中）
// 形态忠实复刻腾讯实测：242 个交易分钟（时间戳 09:30-11:30 + 13:00-15:00），价格持续走高创日内新高
// （688289 价格侧属实：尾盘 +0.69%、14:56 创新高、收盘距最高 0.19%），但量能向尾盘放大且末 20 分钟
// 有脉冲（688289 实测分桶 381/865/653/2333 末桶最大、末 20 分钟最大分钟量为此前均量 3.8 倍）；
// 收盘后追加 25 条盘后条目（15:01-15:25，cumVol 恒定，其中 1 条 +3——复刻腾讯对 688289 的真实返回，
// 该 +3 恰好落在第 3 桶区间使旧口径「萎缩」恒真）。
{
  const tradeTimes = [];
  for (let i = 0; i <= 120; i++) { const k = 9 * 60 + 30 + i; tradeTimes.push(`${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`); }
  for (let i = 0; i <= 120; i++) { const k = 13 * 60 + i; tradeTimes.push(`${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`); }
  const mkPolluted = (mvFn) => {
    let c = 0;
    const arr = tradeTimes.map((time, i) => { c += mvFn(i); return { time, price: 15.5 + i * 0.001983, avg: 15.5, cumVol: c }; });
    const closeCum = c;
    for (let j = 0; j < 25; j++) arr.push({ time: `15${String(1 + j).padStart(2, '0')}`, price: 15.5 + 241 * 0.001983, avg: 15.5, cumVol: closeCum + (j === 10 ? 3 : 0) });
    return { minutes: arr, prevClose: 15.5 };
  };
  const bars = mkBars(120, i => flatBar(10 + i * 0.02, 1000));
  // A. 误命中复现：量能向尾盘放大 + 末 20 分钟有脉冲，但带 25 条零量盘后条目
  const minutes = mkPolluted(i => 10 + i * 0.5);
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes, blacklistReasons: [] });
  const r5 = r.rules[4];
  ok(r5.matched === false, '688289 形态（价创新高但量能放大+有接力）+ 盘后零量条目 → 规则5 不得命中');
  ok(r5.dataGaps.some(g => /成交量未呈逐级萎缩/.test(g)), '未命中原因：量能实际未逐级萎缩（末桶最大）');
  ok(r5.dataGaps.some(g => /新增量能脉冲/.test(g)), '未命中原因：尾盘存在量能脉冲接力');
  // A/B：旧口径（原始数组位置取末尾 40/20 分钟，含 25 条零量盘后条目）在同一数据上两条件恒真 → 旧代码会误命中
  const mvOld = [];
  for (let i = 1; i < minutes.minutes.length; i++) mvOld.push(Math.max(0, minutes.minutes[i].cumVol - minutes.minutes[i - 1].cumVol));
  const ob1 = mvOld.slice(-40, -30).reduce((a, b) => a + b, 0);
  const ob2 = mvOld.slice(-30, -20).reduce((a, b) => a + b, 0);
  const ob3 = mvOld.slice(-20, -10).reduce((a, b) => a + b, 0);
  const ob4 = mvOld.slice(-10).reduce((a, b) => a + b, 0);
  const oldShrink = ob1 > ob2 && ob2 >= ob3 && ob3 > ob4 && ob4 < ob1 * 0.6;
  const oldPrev = mvOld.slice(0, -20).reduce((a, b) => a + b, 0) / Math.max(1, mvOld.slice(0, -20).length);
  const oldNoRelay = oldPrev > 0 && Math.max(...mvOld.slice(-20)) <= oldPrev * 1.2;
  ok(oldShrink && oldNoRelay, `旧口径在此数据上 shrink+noRelay 恒真（b1=${ob1.toFixed(0)} b2=${ob2.toFixed(0)} b3=${ob3.toFixed(0)} b4=${ob4.toFixed(0)}）——复现误命中根因，新口径必须不命中`);
  // B. 防过度修正：同样带 25 条盘后条目，但交易时段量能真实逐级萎缩 + 无接力 → 仍应命中
  const minutes2 = mkPolluted(i => 40 - i * 0.15);
  const r2 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: minutes2, blacklistReasons: [] });
  ok(r2.rules[4].matched === true, '真实逐级萎缩 + 无接力（带盘后条目）→ 规则5 仍命中（修复不误杀合法场景）');
  // C. 交易时段条目不足 40 分钟 → 数据不足，不冒判
  const few = { minutes: tradeTimes.slice(0, 30).map((time, i) => ({ time, price: 15.5 + i * 0.001, avg: 15.5, cumVol: 100 + i * 10 })), prevClose: 15.5 };
  const r3 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: few, blacklistReasons: [] });
  ok(r3.rules[4].matched === false && r3.rules[4].dataGaps.some(g => /交易时段数据不足/.test(g)), '交易时段不足 40 分钟 → 数据不足（不冒判）');
}

// ============ [7] 位置×量能组合矩阵 ============
console.log('\n[7] 位置×量能组合引擎：矩阵关键格 + 横盘场景 + 矛盾识别');
{
  const comboOf = (bars, minutes = null) => {
    const pc = ve._precompute(bars);
    const { platform } = ve._sidewaysAndPlatform(bars);
    const position = ve._detectPosition(pc, platform);
    return ve._comboEngine(pc, { bars, pc, platform, position, minutes, persistentHuge: false, checks: ve._threeChecks(pc) }).direction;
  };
  // 低位放量收阳 → bull（资金进场）
  // 末日 +2% 突破横盘阈值；3000 手 > 60日均量1000×1.5 → 放量；ratio5=3 属大量但低位分支优先
  {
    const bars = mkBars(260, i => {
      const p = i < 200 ? 20 - i * 0.04 : 4;
      return i === 259
        ? { open: p, high: p * 1.03, low: p * 0.995, close: p * 1.02, volume: 3000, amount: p * 3000 * 100, turnover: 1.5 }
        : flatBar(p, 1000);
    });
    ok(comboOf(bars) === 'bull', '低位 + 放量收阳 → 资金进场（bull）');
  }
  // 高位放量收阳 → caution（诱多派发识别）
  {
    const bars = mkBars(260, i => {
      const p = 10 + i * 0.05;
      return i === 259
        ? { open: p, high: p * 1.03, low: p * 0.995, close: p * 1.02, volume: 3000, amount: p * 3000 * 100, turnover: 1.5 }
        : flatBar(p, 1000);
    });
    ok(comboOf(bars) === 'caution', '高位 + 放量收阳 → 诱多派发识别（caution）');
  }
  // 高位缩量 → caution（买盘枯竭）
  {
    const bars = mkBars(260, i => {
      const p = 10 + i * 0.05;
      return i === 259
        ? { open: p, high: p * 1.002, low: p * 0.96, close: p * 0.97, volume: 400, amount: p * 400 * 100, turnover: 1.5 }
        : flatBar(p, 1000);
    });
    ok(comboOf(bars) === 'caution', '高位 + 缩量下跌 → 买盘枯竭（caution）');
  }
  // 下跌途中缩量 → bear（阴跌延续）
  // 数据：10→16 上涨后 16→13 回落：12个月分位≈39%（非低位非高位），MA20≈13.2 < MA60≈13.67 → 下跌途中
  {
    const bars = mkBars(260, i => {
      const p = i < 130 ? 10 + i * 0.046 : 16 - (i - 130) * 3 / 129;
      return i === 259
        ? { open: p, high: p * 1.002, low: p * 0.96, close: p * 0.97, volume: 400, amount: p * 400 * 100, turnover: 1.5 }
        : flatBar(p, 1000);
    });
    ok(comboOf(bars) === 'bear', '下跌途中 + 缩量 → 阴跌延续（bear）');
  }
  // 低位放量收阴 → observe（底部洗盘，非出逃）
  {
    const bars = mkBars(260, i => {
      const p = i < 200 ? 20 - i * 0.04 : 4;
      return i === 259
        ? { open: p, high: p * 1.002, low: p * 0.98, close: p * 0.985, volume: 3000, amount: p * 3000 * 100, turnover: 1.5 }
        : flatBar(p, 1000);
    });
    ok(comboOf(bars) === 'observe', '低位 + 放量收阴 → 底部洗盘（observe，非 bear）');
  }
  // 缩量上涨 → caution + 骗线标签（矛盾识别）
  {
    const bars = mkBars(120, i => {
      const p = 10 + i * 0.01;
      return i === 119
        ? { open: p, high: p * 1.03, low: p * 0.997, close: p * 1.02, volume: 400, amount: p * 400 * 100, turnover: 1.5 }
        : flatBar(p, 1000);
    });
    const pc = ve._precompute(bars);
    const { platform } = ve._sidewaysAndPlatform(bars);
    const c = ve._comboEngine(pc, { bars, pc, platform, position: ve._detectPosition(pc, platform), minutes: null, persistentHuge: false, checks: ve._threeChecks(pc) });
    ok(c.direction === 'caution', '缩量上涨 → caution');
    ok(c.tags.includes('K线骗线') && c.tags.includes('量能不确认'), '缩量上涨标记 K线骗线 + 量能不确认');
  }
  // 横盘极度缩量 → observe（筹码沉淀，仅观察池）
  {
    const bars = mkBars(60, i => flatBar(10, i === 59 ? 300 : 1000));
    ok(comboOf(bars) === 'observe', '横盘 + 极度缩量 → 筹码沉淀（observe）');
  }
}

// ============ [8] 连续量能序列 ============
console.log('\n[8] 连续量能序列：递增/递减/脉冲/无');
{
  const bars = mkBars(30, i => {
    const p = 10 + i * 0.01;
    const vol = [1000, 1500, 2200][i - 27] || 1000;
    return { open: p, high: p * 1.002, low: p * 0.998, close: p, volume: i >= 27 ? vol : 1000, amount: p * vol * 100, turnover: 1.5 };
  });
  const s = ve._sequenceRule(ve._precompute(bars));
  ok(s.type === '连续递增' && s.bullConfirm === true, '量价齐升 3 连 → 连续递增（多头确认）');
}
{
  const bars = mkBars(30, i => {
    const p = 12 - i * 0.01;
    const vol = [2200, 1500, 1000][i - 27] || 1000;
    return { open: p, high: p * 1.002, low: p * 0.998, close: p, volume: i >= 27 ? vol : 1000, amount: p * vol * 100, turnover: 1.5 };
  });
  const s = ve._sequenceRule(ve._precompute(bars));
  ok(s.type === '连续递减' && s.bullConfirm === false, '量价齐跌 3 连 → 连续递减（空头衰竭，仅观察）');
}
{
  const bars = mkBars(30, i => flatBar(10, i === 29 ? 5000 : (i >= 27 ? 600 : 1000)));
  const s = ve._sequenceRule(ve._precompute(bars));
  ok(s.type === '单根脉冲', '仅末日巨量前后缩量 → 单根脉冲');
}
{
  const bars = mkBars(30, i => flatBar(10, 1000));
  ok(ve._sequenceRule(ve._precompute(bars)).type === '无显著序列', '量能平稳 → 无显著序列');
}

// ============ [9] 打分 ============
console.log('\n[9] 打分：权重分量、背离扣分上限、区间钳制、巨量折扣');
{
  // 健康多头：低位放量企稳 + 3 连递增 → 高 base
  // 末日 +2% 突破横盘阈值进「低位放量收阳 → bull」分支（+0.1% 会落入横盘场景）
  const bars = mkBars(260, i => {
    const p = i < 200 ? 20 - i * 0.02 : 16 + (i - 200) * 0.004;
    const volMap = { 257: 2000, 258: 2600, 259: 3200 };
    const vol = volMap[i] || 1000;
    return { open: p, high: p * 1.03, low: p * 0.998, close: i === 259 ? p * 1.02 : p, volume: vol, amount: p * vol * 100, turnover: 1.5 };
  });
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.score.base > 55, `健康多头场景 base > 55（实际 ${r.score.base}）`);
  ok(r.score.components.volumePrice.max === 40 && r.score.components.trend.max === 30 && r.score.components.levelFit.max === 20, '权重 40/30/20 与 spec 一致');
  ok(r.score.components.volumePrice.score === 40, '量价匹配健康拿满分 40');
  ok(r.score.components.trend.score === 30, '连续递增 +30');
  ok(r.score.base <= 100 && r.score.base >= 0, 'base 钳制在 0-100');
}
{
  // 顶背离：扣 30 分上限
  const bars = mkBars(260, i => {
    const p = 10 + i * 0.04;
    const vol = i === 259 ? 900 : (i === 258 ? 1500 : 1000);
    return { open: p, high: p * 1.004, low: p * 0.998, close: p * 1.003, volume: vol, amount: p * vol * 100, turnover: 1.5 };
  });
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.score.divergencePenalty === 30, '顶背离扣 30 分（单次上限）');
  ok(r.score.base < 60, `顶背离后 base 显著下降（实际 ${r.score.base}）`);
}
{
  // 极度缩量档位适配低分
  const bars = mkBars(60, i => flatBar(10, i === 59 ? 300 : 1000));
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.score.components.levelFit.score === 5, '极度缩量档位适配 = 5（观察池）');
  ok(r.signal.category !== '看多信号' && r.signal.category !== '看多观察', '极度缩量不得输出看多');
}

// ============ [10] 流动性 ============
console.log('\n[10] 流动性：四分层 + 兜底 + 样本不足 + 数据不足降级');
{
  // 250 根变异成交额：第 249 根替换为测试值
  const base = mkBars(250, i => flatBar(10, 1000, { amount: 1e8 * (0.5 + (i % 100) / 100) }));
  const test = (amt) => {
    const bars = base.map((b, i) => i === 249 ? { ...b, amount: amt } : b);
    return ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  };
  const r1 = test(2e7);   // 极低
  ok(r1.liquidity.level === '流动性严重不足' && r1.score.liquidityCoef === 0.4, `<20% → 严重不足 ×0.4（实际 ${r1.liquidity.level}/${r1.score.liquidityCoef}）`);
  ok(r1.riskTags.includes('低流动性'), '标签：低流动性');
  const r2 = test(7.5e7); // 中位
  ok(r2.score.liquidityCoef === 0.7, `[20,40) → ×0.7（实际 pct=${r2.liquidity.amountPct250}% coef=${r2.score.liquidityCoef}）`);
  ok(r2.riskTags.includes('流动性偏弱'), '标签：流动性偏弱');
  const r3 = test(1e8);
  ok(r3.liquidity.level === '流动性充足' && r3.score.liquidityCoef === 1, `[40,85] → 充足 ×1.0（实际 ${r3.liquidity.level}/${r3.score.liquidityCoef}）`);
  const r4 = test(2.5e8);
  ok(r4.liquidity.level === '流动性过热' && r4.score.liquidityCoef === 0.85, `>85% → 过热 ×0.85（实际 ${r4.liquidity.level}/${r4.score.liquidityCoef}）`);
  ok(r4.riskTags.includes('流动性过热'), '标签：流动性过热');
  const r5 = test(4e6);
  ok(r5.liquidity.level === '流动性严重不足（兜底）' && r5.score.liquidityCoef === 0.2, `<500万 → 兜底 ×0.2（实际 ${r5.score.liquidityCoef}）`);
}
{
  // 样本不足：50 根 → ×0.5
  const bars = mkBars(50, i => flatBar(10, 1000));
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.liquidity.level === '样本不足' && r.score.liquidityCoef === 0.5, '<60 根 → 样本不足 ×0.5');
  ok(r.riskTags.includes('流动性样本不足'), '标签：流动性样本不足');
}
{
  // 成交额数据不足（腾讯通道形状：无 amount）→ 不衰减只标注
  const bars = mkBars(250, i => {
    const b = flatBar(10, 1000);
    return { date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
  });
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.score.liquidityCoef === 1, '无成交额字段 → 流动性系数 1（不臆造衰减）');
  ok(r.dataGaps.some(g => /成交额数据不足/.test(g)), '标注「成交额数据不足，流动性校验降级」');
  ok(r.volumeState.amountToday === null, 'amountToday = null（不伪造）');
}
{
  // 最终有效得分 = base × 流动性 × 黑名单（连乘）
  const bars = mkBars(250, i => flatBar(10, 1000, { amount: 1e8 }));
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: ['近期公告：2026-09-01 股东减持股份计划'] });
  const expect = Math.round(r.score.base * r.score.liquidityCoef * r.score.blacklistCoef * 10) / 10;
  ok(Math.abs(r.score.final - expect) < 0.05, `final = base×系数连乘（${r.score.base}×${r.score.liquidityCoef}×${r.score.blacklistCoef} = ${expect}，实际 ${r.score.final}）`);
}

// ============ [11] 黑名单 ============
console.log('\n[11] 黑名单：衰减系数 0.3 + 原因上送');
{
  const bars = mkBars(250, i => flatBar(10, 1000, { amount: 1e8 }));
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '*ST 测试', bars, minutes: null, blacklistReasons: ['ST/退市风险警示：*ST 测试'] });
  ok(r.blacklist.triggered === true && r.blacklist.coef === 0.3, '黑名单触发 → ×0.3');
  ok(r.riskTags.includes('黑名单衰减'), '标签：黑名单衰减');
  ok(r.blacklist.reasons.length === 1 && /ST/.test(r.blacklist.reasons[0]), '原因上送（ST）');
  ok(/黑名单衰减/.test(r.conclusion), '结论提示含黑名单衰减说明');
}
{
  const bars = mkBars(250, i => flatBar(10, 1000, { amount: 1e8 }));
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '正常股', bars, minutes: null, blacklistReasons: [] });
  ok(r.blacklist.triggered === false && r.blacklist.coef === 1, '无黑名单 → 系数 1');
}

// ============ [12] 信号分类 ============
console.log('\n[12] 信号分类：空头优先 / 多头失效 / score 分档');
{
  // 空头优先：规则1(bull) 与 规则4(bear,top) 同时命中 → 看空预警
  const sig = ve._classify({
    pc: { level: '平量' },
    combo: { direction: 'bull' },
    sequence: { bullConfirm: true },
    divergence: { type: null },
    riskTags: [],
    rules: [
      { id: 1, name: '低位吸筹', matched: true, direction: 'bull', priority: 'normal' },
      { id: 4, name: '放量破位', matched: true, direction: 'bear', priority: 'top' },
    ],
  }, { base: 80 });
  ok(sig.category === '看空预警' && sig.ruleBased === true, `空头结论优先于多头（实际 ${sig.category}）`);
  ok(/放量破位/.test(sig.note), '分类说明指向最高优先级空头规则');
}
{
  // 多头规则命中且无空头冲突 → 看多信号
  const sig = ve._classify({
    pc: { level: '温和放量' },
    combo: { direction: 'bull' },
    sequence: { bullConfirm: true },
    divergence: { type: null },
    riskTags: [],
    rules: [{ id: 1, name: '低位吸筹', matched: true, direction: 'bull', priority: 'normal' }],
  }, { base: 70 });
  ok(sig.category === '看多信号', '规则1 命中且无空头冲突 → 看多信号');
}
{
  // 无规则：score 分档
  const mk = (base) => ve._classify({
    pc: { level: '平量' }, combo: { direction: 'neutral' }, sequence: { bullConfirm: false },
    divergence: { type: null }, riskTags: [], rules: [],
  }, { base });
  ok(mk(80).category === '看多信号', 'base 80 → 看多信号');
  ok(mk(60).category === '看多观察', 'base 60 → 看多观察');
  ok(mk(45).category === '中性', 'base 45 → 中性');
  ok(mk(30).category === '看空观察', 'base 30 → 看空观察');
  ok(mk(20).category === '看空预警', 'base 20 → 看空预警');
}
{
  // 无显著异常 → 常态结论
  const bars = mkBars(250, i => flatBar(10, 1000, { amount: 1e8 }));
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.rules.every(x => !x.matched) || r.signal.category === '中性', '无异动 → 中性或规则空');
  ok(/常态运行|无显著异常/.test(r.conclusion) || r.rules.some(x => x.matched), '结论提示为常态表述或有规则命中');
}

// ============ [13] 输出结构与禁交易指令 ============
console.log('\n[13] 输出结构完整性 + 禁交易指令扫描');
{
  const bars = mkBars(260, i => flatBar(10 + i * 0.01, 1000, { amount: 1e8 }));
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  const need = ['ok', 'schema', 'symbol', 'name', 'date', 'volumeState', 'position', 'checks', 'divergence', 'rules', 'combo', 'sequence', 'score', 'liquidity', 'blacklist', 'signal', 'riskTags', 'dimensions', 'conclusion', 'disclaimer', 'dataGaps', 'positionVolumeSummary', 'contradictionSummary', 'ratioSummary'];
  const missing = need.filter(k => !(k in r));
  ok(missing.length === 0, `输出字段齐全（缺失：${missing.join(',') || '无'}）`);
  ok(r.rules.length === 5, '五条生死位规则全部输出（含未命中）');
  // 20261019d：新增 expectedVolumeSummary 归集（该放/该缩缺口补充）与 signal.bullSupport → schema 升至 20261019d。
  // 20261019f：定档标准改市场标准量比（÷5日均量 0.8/1.2 单独定档，60 日确认降级为分歧披露）→ schema 升至 20261019f。
  // 20261020a：新增 bottomPhase 底部区域相位分类（该放/该缩期望由相位单源推导、两侧互斥）→ schema 升至 20261020a。
  // 20261020b：口诀4 阈值具象化（均值×0.7=阈值 + 实际近3日量能同屏，detail 新增 avg60/shrinkThreshold/vols3）→ schema 升至 20261020b。
  // 20261020c：规则5 尾盘窗口按 time 时间戳剔除盘后条目（零量盘后条目曾致系统性误命中）→ schema 升至 20261020c。
  // 20261020d：11.3.1「该放量未放量」结论文案阈值具象化（均值×1.5=阈值 + 当日实际量同屏）→ schema 升至 20261020d。
  ok(r.schema === 'volume-engine-20261020d', `schema 已升级 20261020d（实际 ${r.schema}）`);
  ok(r.volumeTier && typeof r.volumeTier.tier === 'string', '输出含 volumeTier（统一量能档位真值源）');
  ok(r.volumeState.level === r.volumeTier.tier, `引擎展示档位等于统一档位（${r.volumeState.level}）`);
  ok('ratio5Level' in r.volumeState, 'volumeState 保留 ratio5Level（原始 ÷5日均量档位）供追溯');
  ok(typeof r.volumeTier.amplified === 'boolean' && typeof r.volumeTier.shrunk === 'boolean', 'volumeTier 输出 amplified/shrunk 判定（与 _comboEngine 同式）');
  // 20261020a：bottomPhase 字段齐全（相位/依据/观察清单三件套）
  ok(r.bottomPhase && typeof r.bottomPhase.phase === 'string' && r.bottomPhase.phase.length > 0, '输出含 bottomPhase.phase');
  ok(typeof r.bottomPhase.basis === 'string' && r.bottomPhase.basis.length > 0, 'bottomPhase.basis 非空');
  ok(r.bottomPhase.detail && typeof r.bottomPhase.detail === 'object', 'bottomPhase.detail 观察清单输出');
  // 20261017f：三个归集总结逐条完整输出（spec 11.2/11.3/11.4）
  ok(r.positionVolumeSummary.items.length === 4, '位置量价归集 4 项（高位放量滞涨/低位放量震荡/缩量上涨/缩量下跌）');
  ok(r.contradictionSummary.items.length === 4, '矛盾信号归集 4 项');
  ok(r.ratioSummary.items.length === 5, '量比口诀归集 5 项');
  ok([r.positionVolumeSummary, r.contradictionSummary, r.ratioSummary].every(s => typeof s.summary === 'string' && s.summary.length > 0), '三个归集总结的总结性判定均非空');
  ok([...r.positionVolumeSummary.items, ...r.contradictionSummary.items, ...r.ratioSummary.items].every(i => ['命中', '未命中', '数据不足'].includes(i.status)), '归集明细每项 status ∈ {命中,未命中,数据不足}（无留空）');
  const dims = ['volumeState', 'position', 'capitalBehavior', 'chipTransfer'];
  ok(dims.every(d => typeof r.dimensions[d] === 'string' && r.dimensions[d].length > 0), '四维度客观描述齐全');
  ok(/不构成投资建议|不涉及交易执行/.test(r.disclaimer), '免责备注齐全');
  ok(typeof r.position.basis === 'string' && r.position.basis.length > 0, '位置判定依据非空');
  ok(r.volumeState.avg60 > 0, '均量序列非空');
  // 禁交易指令：叙事字段不得出现指令性措辞（减持/解禁为事实标签，不扫描）
  const summaryNarratives = [...r.positionVolumeSummary.items, ...r.contradictionSummary.items, ...r.ratioSummary.items]
    .flatMap(i => [i.conclusion, i.hint, i.riskHint, i.trackHint, i.scenario].filter(Boolean));
  const narratives = [r.conclusion, r.dimensions.volumeState, r.dimensions.position, r.dimensions.capitalBehavior, r.dimensions.chipTransfer,
    r.combo.conclusion, r.divergence.note, r.signal.note, r.disclaimer, ...r.rules.map(x => x.conclusion),
    r.positionVolumeSummary.summary, r.contradictionSummary.summary, r.ratioSummary.summary, ...summaryNarratives].join(' ');
  const banned = ['买入', '卖出', '加仓', '减仓', '清仓', '抄底', '逃顶', '建议买', '建议卖', '满仓', '空仓'];
  const hit = banned.filter(w => narratives.includes(w));
  ok(hit.length === 0, `叙事字段无交易指令措辞（命中：${hit.join(',') || '无'}）`);
}

// ============ [14] 边界与降级 ============
console.log('\n[14] 边界：短样本 / 脏数据 / 缺换手率');
{
  // 恰好 10 根：可运行但样本不足衰减
  const bars = mkBars(10, i => flatBar(10, 1000, { amount: 1e8 }));
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.ok === true, '10 根下限 → 可运行');
  ok(r.score.liquidityCoef === 0.5, '10 根 < 60 → 样本不足 ×0.5');
}
{
  // 脏数据：含 null/NaN 行被过滤
  const bars = mkBars(70, i => flatBar(10, 1000, { amount: 1e8 }));
  bars[30] = { date: '2026-01-30', open: null, high: null, low: null, close: null, volume: NaN, amount: null, turnover: null };
  bars[40] = null;
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: { minutes: [], prevClose: 0 }, blacklistReasons: null });
  ok(r.ok === true, '脏数据行被过滤后仍可运行');
  ok(r.dataGaps.some(g => /60/.test(g)) || r.score.liquidityCoef <= 1, '短样本/数据缺口有标注或衰减');
}
{
  // 缺换手率字段 → 天量确认降级标注
  const bars = mkBars(250, i => {
    const b = flatBar(10, 1000, { amount: 1e8 });
    return { date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, amount: b.amount };
  });
  const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r.dataGaps.some(g => /换手率数据不足/.test(g)), '标注「换手率数据不足，天量确认降级」');
  ok(r.volumeState.turnoverToday === null, 'turnoverToday = null（不伪造）');
}
{
  // 大盘环境：配置折扣时连乘，未配置时仅标注
  const bars = mkBars(250, i => flatBar(10, 1000, { amount: 1e8 }));
  const r1 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [], marketEnv: { label: '系统性风险', discount: 0.9 } });
  ok(r1.score.marketCoef === 0.9 && /系统性风险/.test(r1.marketEnvNote), '配置大盘折扣 → ×0.9 并标注');
  const r2 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  ok(r2.score.marketCoef === 1 && /未叠加大盘环境折扣/.test(r2.marketEnvNote), '未配置 → 系数 1 + 如实标注');
}

// ============ [15] 7.4 不同位置量价补充规则 ============
console.log('\n[15] 7.4 位置量价补充规则：四形态 + 子阶段（直接调用，确定性口径）');
{
  // 手搭 pc：n=60，近 20 日低点窗口（40..58）全为 9.5
  const mkPc = (over = {}) => {
    const n = over.n || 60;
    const lows = over.lows || Array.from({ length: n }, () => 9.5);
    return {
      n, level: '平量', ratio5: 1, ratio5Prev: 1, ratio10: 1, ratio20: 1,
      avg5: 1000, avg10: 1000, avg20: 1000, avg60: 1000,
      confirm: null, chgPct: 0, closePrev: 10, closeToday: 10, highToday: 10.02,
      volToday: 1000, vols: Array.from({ length: n }, () => 1000), lows, lowToday: 9.95,
      drawdownFromHigh: -5, pricePct12m: 0.5,
      ...over,
    };
  };
  const pv = (label, pcOver) => ve._positionVolumeRules(mkPc(pcOver), { position: { label }, rules: [] });

  // 7.4.1 高位放量滞涨：高位 + 天量 + 滞涨（|chg|<1.2%）
  const a = pv('高位区间', { level: '天量', ratio5: 5, confirm: '放量', chgPct: 0.5 });
  ok(a.highStagnant.matched === true && a.highStagnant.status === '命中', '高位+天量+滞涨 → 高位放量滞涨命中');
  ok(/高位派发风险/.test(a.highStagnant.conclusion), '结论含高位派发风险提示');
  // 冲高回落同样命中（high 10.5 vs close 10.2 → 回落 2.9%）
  const a2 = pv('高位区间', { level: '大量', ratio5: 2.6, chgPct: 1.5, highToday: 10.5, closeToday: 10.2 });
  ok(a2.highStagnant.matched === true, '高位+大量+冲高回落 → 命中（上影线口径）');
  // 高位但量能不达放量标准 → 未命中
  const a3 = pv('高位区间', { level: '平量', ratio5: 1, chgPct: 0.3 });
  ok(a3.highStagnant.matched === false && a3.highStagnant.status === '未命中', '高位但无量 → 未命中');
  // 非高位 → 未命中
  const a4 = pv('低位区间', { level: '天量', ratio5: 5, chgPct: 0.3 });
  ok(a4.highStagnant.matched === false, '低位天量 → 高位放量滞涨未命中（位置不满足）');

  // 7.4.2 低位放量震荡：低位 + 大量 + 小阴小阳 + 未创新低（lowToday 9.95 ≥ 窗口低点 9.5）
  const b = pv('低位区间', { level: '大量', ratio5: 2.6, confirm: '放量', chgPct: 0.3, lowToday: 9.95 });
  ok(b.lowOscillate.matched === true && b.lowOscillate.status === '命中', '低位+大量+震荡未新低 → 低位放量震荡命中');
  ok(/观察池/.test(b.lowOscillate.conclusion), '结论为观察池口径（不直接看多）');
  // 创新低 → 未命中
  const b2 = pv('低位区间', { level: '大量', ratio5: 2.6, chgPct: -0.3, lowToday: 9.4 });
  ok(b2.lowOscillate.matched === false && /新低/.test(b2.lowOscillate.detail.priceBehavior), '仍在创新低 → 未命中且说明原因');

  // 7.4.3 缩量上涨两种情况
  const upLow = pv('低位区间', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: 1.5 });
  ok(upLow.shrinkUp.matched === true && upLow.shrinkUp.subStage === '低位启动阶段' && upLow.shrinkUp.status === '命中', '低位缩量上涨 → 低位启动阶段');
  ok(/不直接给强看多信号/.test(upLow.shrinkUp.conclusion), '低位缩量上涨结论不直接给强看多');
  const upHigh = pv('高位区间', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: 1.5 });
  ok(upHigh.shrinkUp.subStage === '高位阶段' && upHigh.shrinkUp.status === '命中', '高位缩量上涨 → 高位阶段（风险观察）');
  ok(/顶背离或买盘枯竭/.test(upHigh.shrinkUp.conclusion), '高位缩量上涨结论含买盘枯竭风险');
  const upMid = pv('上涨中途', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: 1.5 });
  ok(upMid.shrinkUp.matched === true && upMid.shrinkUp.status === '数据不足', '缩量上涨位置子阶段不明 → 数据不足（按谨慎观察）');

  // 7.4.4 缩量下跌两种情况
  const dnBigDrop = pv('低位区间', { level: '极度缩量', ratio5: 0.3, confirm: '缩量', chgPct: -1.5, drawdownFromHigh: -22 });
  ok(dnBigDrop.shrinkDown.subStage === '低位大跌后' && dnBigDrop.shrinkDown.status === '命中', '低位 + 距高点 ≤-15% → 低位大跌后缩量出清');
  ok(/不直接看多/.test(dnBigDrop.shrinkDown.conclusion), '低位大跌后结论仅观察不直接看多');
  const dnEarly = pv('下跌途中', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: -1.5, drawdownFromHigh: -8 });
  ok(dnEarly.shrinkDown.subStage === '下跌初期' && dnEarly.shrinkDown.bearish === true && dnEarly.shrinkDown.status === '命中', '下跌途中 + 距高点 >-10% → 下跌初期');
  ok(/看空观察或看空预警/.test(dnEarly.shrinkDown.conclusion), '下跌初期结论按看空处理');
  const dnAmb = pv('低位区间', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: -1.5, drawdownFromHigh: -10 });
  ok(dnAmb.shrinkDown.matched === true && dnAmb.shrinkDown.status === '数据不足', '缩量下跌子阶段不明 → 数据不足');
  const dnGap = pv('下跌途中', { level: '温和缩量', ratio5: 0.5, confirm: '缩量', chgPct: null });
  ok(dnGap.shrinkDown.status === '数据不足' && /无法判定/.test(dnGap.shrinkDown.conclusion), '涨跌幅缺失 → 数据不足，无法判定（不臆造）');

  // 量能性状共享口径（7.4/7.5/11.3 同源）
  const t = ve._volTraits(mkPc({ level: '天量', ratio5: 5, confirm: '放量', chgPct: 0.5, highToday: 10.5, closeToday: 10.2 }));
  ok(t.isHugeVol === true && t.isStagnant === true && t.fellFromHigh === true && t.isShrink === false, '性状：天量+滞涨+冲高回落 → isHugeVol/isStagnant/fellFromHigh');
  const t2 = ve._volTraits(mkPc({ level: '平量', ratio5: 0.5, confirm: '缩量', chgPct: -2 }));
  ok(t2.isShrink === true && t2.isStagnant === false, '性状：缩量+跌幅 -2% → isShrink 且非滞涨');
}

// ============ [16] 7.5 五句量比实战口诀 ============
console.log('\n[16] 7.5 五句量比口诀：开盘/均价线/尾盘（分时）+ 三条日线条目');
{
  // 20261017g：分时构造改用真实交易时段（09:30-11:30 = 121 条 + 13:00-15:00 = 121 条，共 242 条，
  // 时间格式 'HHMM' 与腾讯 fetchTencentMinutes 一致）——尾盘窗口需按时间戳截取，旧的 120 条/带冒号形态不再适用。
  const TRADE_MIN = (() => {
    const t = [];
    for (let i = 0; i <= 120; i++) { const k = 9 * 60 + 30 + i; t.push(`${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`); }
    for (let i = 0; i <= 120; i++) { const k = 13 * 60 + i; t.push(`${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`); }
    return t;
  })();
  const TAIL_START = 211; // 14:30 所在索引（上午 121 条 + 13:00 起第 90 分钟）
  const mkMinutes = (spec = {}) => {
    const rate = (i) => (typeof spec.rate === 'function' ? spec.rate(i) : 4);
    const price = (i) => (typeof spec.price === 'function' ? spec.price(i) : 10);
    let cum = 0;
    const minutes = TRADE_MIN.map((time, i) => { cum += rate(i); return { time, price: price(i), avg: 10, cumVol: cum }; });
    return { minutes, prevClose: 10 };
  };
  // 盘中截断（模拟未收盘，截取到指定分钟数）
  const intraday = (obj, n) => ({ minutes: obj.minutes.slice(0, n), prevClose: obj.prevClose });
  const mkPc = (over = {}) => {
    const n = over.n || 60;
    const lows = over.lows || Array.from({ length: n }, () => 9.5);
    return {
      n, level: '平量', ratio5: 1, ratio5Prev: 1, ratio10: 1, ratio20: 1,
      avg5: 1000, avg10: 1000, avg20: 1000, avg60: 1000,
      confirm: null, chgPct: 0, closePrev: 10, closeToday: 10, highToday: 10.02,
      volToday: 1000, vols: Array.from({ length: n }, () => 1000), lows, lowToday: 9.95,
      drawdownFromHigh: -5, pricePct12m: 0.5,
      ...over,
    };
  };

  // 口诀1 命中：avg5=1000000 股 → 前 5 日每分钟均量 41.67 手；开盘 30 分钟累计 4000 手 → 量比 3.2；末端站均价线
  {
    const pc = mkPc({ avg5: 1000000 });
    const minutes = mkMinutes({ rate: i => (i < 30 ? 133.33 : 0), price: i => (i === 241 ? 10.5 : 10) });
    const r = ve._ratioRules(pc, { minutes, position: { label: '低位区间' } });
    const k1 = r.items[0];
    ok(k1.matched === true && k1.status === '命中', `开盘量比 >3 且站均价线 → 命中（detail ${JSON.stringify(k1.detail)}）`);
    ok(k1.detail.openRatio > 3 && k1.detail.aboveAvg === true, `开盘量比 ${k1.detail.openRatio} >3 且 aboveAvg`);
    ok(k1.tag === '开盘量比超3放量待确认', '标签：开盘量比超3放量待确认');
    ok(/不直接输出看多信号/.test(k1.conclusion), '结论限定为观察/确认（不直接看多）');
  }
  // 20261021h 单位表修正（实测成交额反验）：东财日K=「手」、腾讯日K=「手」、同花顺日K=「股」。
  // 旧注释把东财当「股」，会让 5 日均量基准缩 100 倍 → 开盘量比虚高 100 倍。
  {
    const minutes = mkMinutes({ rate: i => (i < 30 ? 133.33 : 0), price: i => (i === 241 ? 10.5 : 10) });
    const pcShare = mkPc({ avg5: 1000000 });   // 同花顺口径：100 万股
    const pcHand = mkPc({ avg5: 10000 });      // 东财/腾讯口径：1 万手（= 100 万股）
    const rEM = ve._ratioRules(pcHand, { minutes, position: { label: '低位区间' }, barsSource: 'eastmoney' });
    const rTHS = ve._ratioRules(pcShare, { minutes, position: { label: '低位区间' }, barsSource: 'ths' });
    const rTX = ve._ratioRules(pcHand, { minutes, position: { label: '低位区间' }, barsSource: 'tencent' });
    ok(Math.abs(rEM.items[0].detail.openRatio - 3.2) < 0.05, `东财（手）通道开盘量比 3.2（实际 ${rEM.items[0].detail.openRatio}）`);
    ok(Math.abs(rTHS.items[0].detail.openRatio - 3.2) < 0.05, `同花顺（股）通道换算后开盘量比 3.2（实际 ${rTHS.items[0].detail.openRatio}）`);
    ok(Math.abs(rTX.items[0].detail.openRatio - 3.2) < 0.05, `腾讯（手）通道开盘量比同为 3.2（实际 ${rTX.items[0].detail.openRatio}）`);
    // 反向校验：把同花顺的「股」数据误当「手」（不除 100）→ 基准放大 100 倍 → 量比塌陷到 1/100
    const wrong = ve._ratioRules(pcShare, { minutes, position: { label: '低位区间' }, barsSource: 'eastmoney' });
    ok(wrong.items[0].detail.openRatio < 0.1, `把「股」数据当「手」时量比塌陷至 ${wrong.items[0].detail.openRatio}（反向印证必须按通道区分）`);
    ok(rTX.items[0].matched === true, '腾讯通道命中口径与其余通道一致（不因单位虚高/塌陷）');
  }
  // 口诀1 未命中：开盘量比不足（rate 低）→ 未命中
  {
    const pc = mkPc({ avg5: 1000000 });
    const minutes = mkMinutes({ rate: i => (i < 30 ? 10 : 0) });
    const r = ve._ratioRules(pc, { minutes, position: { label: '低位区间' } });
    ok(r.items[0].matched === false && r.items[0].status === '未命中', '开盘量比不足 → 未命中');
  }
  // 口诀1 未命中：量比够但跌破均价线 → 承接失败口径
  {
    const pc = mkPc({ avg5: 1000000 });
    const minutes = mkMinutes({ rate: i => (i < 30 ? 133.33 : 0), price: i => (i === 241 ? 9.5 : 10) });
    const r = ve._ratioRules(pc, { minutes, position: { label: '低位区间' } });
    const k1 = r.items[0];
    ok(k1.matched === false && /未站上均价线/.test(k1.conclusion), '量比够但跌破均价线 → 未命中（需站上均价线）');
  }
  // 口诀1 数据不足：无分时 → 不得臆造
  {
    const r = ve._ratioRules(mkPc(), { minutes: null, position: { label: '低位区间' } });
    ok(r.items[0].status === '数据不足' && r.items[0].dataOk === false, '无分时 → 口诀1 数据不足');
    ok(r.dataGaps.some(g => /分时数据不足/.test(g)), 'dataGaps 收录分时不足说明');
  }
  // 口诀2 命中：昨日量比 1.5 回落至 1.0 且横盘不跌
  {
    const pc = mkPc({ ratio5: 1.0, ratio5Prev: 1.5, chgPct: 0.3, closePrev: 10, closeToday: 10.03 });
    const k2 = ve._ratioRules(pc, { minutes: null, position: { label: '上涨中途' } }).items[1];
    ok(k2.matched === true && k2.tag === '量比回落横盘卖盘变轻观察', '口诀2 命中（量比回落至 1 附近 + 横盘不跌）');
    ok(/不得因量比回落直接输出看空结论/.test(k2.conclusion), '口诀2 结论禁止因量比回落直接看空');
  }
  // 口诀2 未命中：量比仍在高位
  {
    const pc = mkPc({ ratio5: 1.4, ratio5Prev: 1.5, chgPct: 0.3 });
    ok(ve._ratioRules(pc, { minutes: null, position: { label: '上涨中途' } }).items[1].matched === false, '量比未回落至 0.8-1.2 → 未命中');
  }
  // 口诀3 命中：尾盘（14:30-15:00 时间戳窗口）每分钟均量 12 ≥ 此前 1×2 且价格拉升 ≥0.5%
  // （rally 基准 = 尾盘窗口起点 14:30，不再是数组末尾）
  {
    const pc = mkPc({ avg5: 1000000 });
    const minutes = mkMinutes({ rate: i => (i >= TAIL_START ? 12 : 1), price: i => (i === TAIL_START ? 10 : (i === 241 ? 10.2 : 10)) });
    const r = ve._ratioRules(pc, { minutes, position: { label: '低位区间' } });
    const k3 = r.items[2];
    ok(k3.matched === true && k3.status === '命中', `尾盘放量拉升 → 命中（detail ${JSON.stringify(k3.detail)}）`);
    ok(k3.detail.tailPerMin === 12 && k3.detail.priorPerMin === 1 && k3.detail.rally === true, '尾盘窗口按 14:30-15:00 时间戳截取（均量 12 vs 此前 1）');
    ok(k3.tag === '尾盘放量拉升真实性待确认', '标签：尾盘放量拉升真实性待确认');
    ok(/不能仅因红盘判断为抢筹/.test(k3.conclusion) && /不得输出看多信号/.test(k3.hint), '结论限定真实性待确认（不直接看多）');
  }
  // 口诀3 未命中：尾盘量够但价格未拉升
  {
    const pc = mkPc({ avg5: 1000000 });
    const minutes = mkMinutes({ rate: i => (i >= TAIL_START ? 12 : 1) });
    const k3 = ve._ratioRules(pc, { minutes, position: { label: '低位区间' } }).items[2];
    ok(k3.matched === false && /价格未走高/.test(k3.conclusion), '尾盘放量但价格未拉升 → 未命中');
  }
  // 20261017g：盘中未收盘 → 不得把「最近半小时」当尾盘判定
  {
    const pc = mkPc({ avg5: 1000000 });
    const minutes = intraday(mkMinutes({ rate: i => (i >= 70 ? 12 : 1) }), 100); // 截断至 11:09
    const r = ve._ratioRules(pc, { minutes, position: { label: '低位区间' } });
    const k3 = r.items[2];
    ok(k3.status === '数据不足' && k3.matched === false, '盘中未收盘 → 口诀3 数据不足（不冒判尾盘）');
    ok(/尚未覆盖到收盘/.test(k3.conclusion), '明确指出「尚未收盘」，而非笼统的数据不足');
    ok(r.dataGaps.some(g => /尚未覆盖收盘/.test(g)), 'dataGaps 收录未收盘说明');
  }
  // 20261017g：尾盘窗口不足 25 分钟（分时断了尾巴但含 1500）→ 数据不足
  {
    const arr = [];
    let cum = 0;
    for (let i = 0; i < 200; i++) { cum += 1; arr.push({ time: '0930', price: 10, avg: 10, cumVol: cum }); }
    for (let i = 0; i < 10; i++) { cum += 12; arr.push({ time: `14${40 + i}`, price: 10, avg: 10, cumVol: cum }); }
    cum += 12; arr.push({ time: '1500', price: 10, avg: 10, cumVol: cum });
    const k3 = ve._ratioRules(mkPc({ avg5: 1000000 }), { minutes: { minutes: arr, prevClose: 10 }, position: { label: '低位区间' } }).items[2];
    ok(k3.status === '数据不足' && /窗口不足 25 分钟/.test(k3.conclusion), '尾盘时间戳窗口不足 25 分钟 → 数据不足');
  }
  // 口诀3 数据不足：无分时
  {
    const k3 = ve._ratioRules(mkPc(), { minutes: null, position: { label: '低位区间' } }).items[2];
    ok(k3.status === '数据不足' && k3.matched === false, '无分时 → 口诀3 数据不足');
  }
  // 口诀4 命中：近 3 日量 600 < avg60×0.7 且 lowToday 9.95 > 近 20 日最低 9.5
  {
    const vols = Array.from({ length: 60 }, () => 1000);
    vols[57] = 600; vols[58] = 600; vols[59] = 600;
    const pc = mkPc({ vols, avg60: 1000, chgPct: -0.2, confirm: '缩量' });
    const k4 = ve._ratioRules(pc, { minutes: null, position: { label: '低位区间' } }).items[3];
    ok(k4.matched === true && k4.confirmed === false && k4.tag === '连续低成交不再新低待放量阳线', '口诀4 命中且未确认（等待放量阳线）');
    ok(/不得直接输出看多信号/.test(k4.hint), '口诀4 未确认前禁直接看多');
    // 20261020b：阈值具象化——均值×0.7=阈值与实际近 3 日量能同屏展示（用户要求「展示数据计算结果」）
    ok(/近 3 日成交量 600 \/ 600 \/ 600，均低于 60 日均量 1000 ×0\.7 = 700/.test(k4.conclusion), `口诀4 命中文案展示阈值计算过程与实际近 3 日量能（实际：${k4.conclusion}）`);
    ok(k4.detail.avg60 === 1000 && k4.detail.shrinkThreshold === 700, `detail 具象化字段 avg60/shrinkThreshold（实际 ${k4.detail.avg60}/${k4.detail.shrinkThreshold}）`);
    ok(JSON.stringify(k4.detail.vols3) === '[600,600,600]', `detail.vols3 近 3 日量能数组（实际 ${JSON.stringify(k4.detail.vols3)}）`);
  }
  // 口诀4 已确认：当日放量阳线 → confirmed
  {
    const vols = Array.from({ length: 60 }, () => 1000);
    vols[57] = 600; vols[58] = 600; vols[59] = 600;
    const pc = mkPc({ vols, avg60: 1000, chgPct: 2.5, confirm: '放量' });
    const k4 = ve._ratioRules(pc, { minutes: null, position: { label: '低位区间' } }).items[3];
    ok(k4.matched === true && k4.confirmed === true && k4.tag === null, '口诀4 已出现放量阳线 → 确认成立不再限制');
    ok(/60 日均量 1000 ×0\.7 = 700/.test(k4.conclusion), '口诀4 已确认分支同样展示阈值计算过程');
  }
  // 口诀4 未命中：股价仍创新低
  {
    const vols = Array.from({ length: 60 }, () => 1000);
    vols[57] = 600; vols[58] = 600; vols[59] = 600;
    const pc = mkPc({ vols, avg60: 1000, chgPct: -0.2, lowToday: 9.4 });
    const k4 = ve._ratioRules(pc, { minutes: null, position: { label: '低位区间' } }).items[3];
    ok(k4.matched === false, '仍创新低 → 口诀4 未命中');
    ok(/低成交线 60 日均量 1000 ×0\.7 = 700，近 3 日实际 600 \/ 600 \/ 600/.test(k4.conclusion), '未命中文案展示低成交线与实际近 3 日量能（便于核对差在哪一步）');
  }
  // 口诀4 未命中：量能未达低成交线（20261020b：文案需展示阈值计算过程与实际值）
  {
    const vols = Array.from({ length: 60 }, () => 1000);
    vols[57] = 900; vols[58] = 950; vols[59] = 800;
    const pc = mkPc({ vols, avg60: 1000, chgPct: -0.2, confirm: '缩量' });
    const k4 = ve._ratioRules(pc, { minutes: null, position: { label: '低位区间' } }).items[3];
    ok(k4.matched === false && k4.detail.low3 === false, '近 3 日量未全部低于低成交线 → 未命中');
    ok(/低成交线 60 日均量 1000 ×0\.7 = 700，近 3 日实际 900 \/ 950 \/ 800/.test(k4.conclusion), `未命中文案展示阈值计算过程与实际近 3 日量能（实际：${k4.conclusion}）`);
  }
  // 口诀5 命中：量比 2.5 但滞涨
  {
    const pc = mkPc({ ratio5: 2.5, chgPct: 0.3, level: '大量' });
    const k5 = ve._ratioRules(pc, { minutes: null, position: { label: '上涨中途' } }).items[4];
    ok(k5.matched === true && k5.tag === '量比大价格滞涨警惕对倒', '口诀5 命中（量比大 + 涨不动）');
    ok(/警惕是否为对倒出货/.test(k5.conclusion), '口诀5 结论含对倒警惕');
  }
  // 口诀5 未命中：量比大但价格明确上涨
  {
    const pc = mkPc({ ratio5: 2.5, chgPct: 3.0, highToday: 10.3, closeToday: 10.3 });
    ok(ve._ratioRules(pc, { minutes: null, position: { label: '上涨中途' } }).items[4].matched === false, '量比大但价格真涨 → 未命中');
  }
}

// ============ [17] 三个强制归集总结 + 一致性约束 ============
console.log('\n[17] 11.2/11.3/11.4 归集总结：逐条完整 + 常态模板 + 数据不足 + 约束联动');
{
  const mkPv = (over = {}) => ({
    highStagnant: { form: '高位放量滞涨', status: '未命中', matched: false, conclusion: 'x', detail: {} },
    lowOscillate: { form: '低位放量震荡', status: '未命中', matched: false, conclusion: 'x', detail: {} },
    shrinkUp: { form: '缩量上涨', status: '未命中', matched: false, subStage: '不属于缩量上涨', conclusion: 'x', detail: {} },
    shrinkDown: { form: '缩量下跌', status: '未命中', matched: false, subStage: '不属于缩量下跌', conclusion: 'x', detail: {} },
    ...over,
  });
  const mkContra = (over = {}) => ({
    shouldAmpNot: { signal: '该放量未放量', status: '未命中', matched: false, conclusion: 'x', scenario: '', riskHint: '' },
    shouldShrinkHuge: { signal: '该缩量反放巨量', status: '未命中', matched: false, conclusion: 'x', scenario: '', riskHint: '' },
    highHugeNotUp: { signal: '高位放巨量但价格不涨', status: '未命中', matched: false, conclusion: 'x', scenario: '', riskHint: '' },
    lowHugeNotDown: { signal: '低位放大量但价格不跌', status: '未命中', matched: false, conclusion: 'x', scenario: '', trackHint: '' },
    ...over,
  });
  const mkRatio = (items) => ({ items });

  // 全未命中 → 常态模板（spec：未命中必须写「未命中」）
  {
    const s = ve._buildSummaries({ pv: mkPv(), contra: mkContra(), ratio: mkRatio([1, 2, 3, 4, 5].map(id => ({ id, name: `口诀${id}`, status: '未命中', matched: false, conclusion: '未命中', hint: '', detail: {} }))), position: { label: '上涨中途' } });
    ok(s.positionVolumeSummary.items.length === 4 && s.positionVolumeSummary.items.every(i => i.status === '未命中'), '位置量价 4 项全部「未命中」');
    ok(/常态运行/.test(s.positionVolumeSummary.summary) && /高位放量滞涨/.test(s.positionVolumeSummary.summary), '位置量价归集总结为常态模板（列出未命中项）');
    ok(/不显著/.test(s.contradictionSummary.summary), '矛盾信号归集总结为常态模板（不显著）');
    ok(/常态运行/.test(s.ratioSummary.summary), '量比口诀归集总结为常态模板');
  }
  // 数据不足 → 总结显式标注（不得与未命中混淆）
  {
    const s = ve._buildSummaries({ pv: mkPv(), contra: mkContra(), ratio: mkRatio([1, 2, 3, 4, 5].map(id => ({ id, name: `口诀${id}`, status: id === 1 ? '数据不足' : '未命中', matched: false, conclusion: '数据不足，无法判定', hint: '', detail: {} }))), position: { label: '上涨中途' } });
    ok(/数据不足/.test(s.ratioSummary.summary) && /分时数据不足/.test(s.ratioSummary.summary), '口诀1 数据不足 → 归集总结显式标注');
  }
  // 命中 + 空头优先：总结给出主结论但明细完整
  {
    const s = ve._buildSummaries({
      pv: mkPv({ highStagnant: { form: '高位放量滞涨', status: '命中', matched: true, conclusion: '高位放量滞涨：命中', detail: {} }, shrinkDown: { form: '缩量下跌', status: '命中', matched: true, subStage: '下跌初期', conclusion: '下跌初期缩量无承接', detail: {} } }),
      contra: mkContra({ shouldAmpNot: { signal: '该放量未放量', status: '命中', matched: true, conclusion: '资金没有跟上', scenario: '突破关键压力位', riskHint: '谨防假突破' } }),
      ratio: mkRatio([1, 2, 3, 4, 5].map(id => ({ id, name: `口诀${id}`, status: id === 5 ? '命中' : '未命中', matched: id === 5, conclusion: '量比大但股价涨不动', hint: '警惕对倒', detail: {} }))),
      position: { label: '高位区间' },
    });
    ok(/主要命中【高位放量滞涨】/.test(s.positionVolumeSummary.summary) && /下跌初期缩量无承接/.test(s.positionVolumeSummary.summary), '位置量价归集：主命中 + 空头优先项均列出');
    ok(/空头优先结论为【有/.test(s.positionVolumeSummary.summary), '空头优先结论显式给出');
    ok(/需小心的项/.test(s.contradictionSummary.summary), '矛盾信号归集区分「需小心/需跟踪」');
    ok(/需警惕项为【口诀5】/.test(s.ratioSummary.summary), '口诀归集：口诀3/5 归入需警惕');
  }
  // 一致性约束（_classify 直调）：高位放量滞涨 + 多头规则 → 只能看多观察
  {
    const sig = ve._classify({
      pc: { level: '平量' }, combo: { direction: 'bull' }, sequence: { bullConfirm: true },
      divergence: { type: null }, checks: { failed: [] }, position: { label: '高位区间' }, riskTags: [],
      rules: [{ id: 1, name: '低位吸筹', matched: true, direction: 'bull', priority: 'normal' }],
      pv: { highStagnant: { matched: true } }, contra: {}, ratio: { items: [] },
    }, { base: 70 });
    ok(sig.category === '看多观察' && /高位放量滞涨/.test(sig.note), '高位放量滞涨禁看多信号 → 降级看多观察');
  }
  // 一致性约束：下跌初期缩量 → 强制看空观察（压过多头规则）
  {
    const sig = ve._classify({
      pc: { level: '平量' }, combo: { direction: 'neutral' }, sequence: { bullConfirm: false },
      divergence: { type: null }, checks: { failed: [] }, position: { label: '下跌途中' }, riskTags: [],
      rules: [{ id: 1, name: '低位吸筹', matched: true, direction: 'bull', priority: 'normal' }],
      pv: { shrinkDown: { subStage: '下跌初期' } }, contra: {}, ratio: { items: [] },
    }, { base: 80 });
    ok(sig.category === '看空观察' && /下跌初期/.test(sig.note), '下跌初期缩量无承接 → 强制看空观察');
  }
  // spec 7.4 例外：低位吸筹完整命中 → 低位放量震荡不限制看多
  {
    const sig = ve._classify({
      pc: { level: '平量' }, combo: { direction: 'bull' }, sequence: { bullConfirm: true },
      divergence: { type: null }, checks: { failed: [] }, position: { label: '低位区间' }, riskTags: [],
      rules: [{ id: 1, name: '低位吸筹', matched: true, direction: 'bull', priority: 'normal' }],
      pv: { lowOscillate: { matched: true } }, contra: { lowHugeNotDown: { matched: true } }, ratio: { items: [] },
    }, { base: 70 });
    ok(sig.category === '看多信号', '规则1 命中时低位放量震荡/低位放大量不跌不限制看多（spec 7.4 例外）');
  }
  // s40 约束：高位放量滞涨封顶 12；低位缩量上涨保底 16
  {
    const s1 = ve._scoreEngine({ level: '大量' }, { combo: { direction: 'bull' }, sequence: { type: null, bullConfirm: false }, checks: { pulse: false, failed: [] }, divergence: { type: null }, pv: { highStagnant: { matched: true } } });
    ok(s1.components.volumePrice.score === 12, `高位放量滞涨 → 量价匹配分封顶 12（实际 ${s1.components.volumePrice.score}）`);
    const s2 = ve._scoreEngine({ level: '温和缩量' }, { combo: { direction: 'observe' }, sequence: { type: null, bullConfirm: false }, checks: { pulse: false, failed: [] }, divergence: { type: null }, pv: { shrinkUp: { subStage: '低位启动阶段' } } });
    ok(s2.components.volumePrice.score === 16, `低位缩量上涨 → 量价匹配分保底 16（实际 ${s2.components.volumePrice.score}）`);
  }
  // 集成：高位放量滞涨全链路（冒烟场景 A 固化）
  {
    const bars = mkBars(260, i => {
      const p = 10 + i * 0.04;
      return i === 259
        ? { open: p, high: p * 1.01, low: p * 0.995, close: p * 1.001, volume: 5000, amount: p * 5000 * 100, turnover: 1.5 }
        : flatBar(p, 1000);
    });
    const r = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
    ok(r.positionVolumeSummary.items[0].status === '命中' && r.positionVolumeSummary.items[0].form === '高位放量滞涨', '集成：高位放量滞涨归集命中');
    ok(r.riskTags.includes('高位放量滞涨'), '风险标签：高位放量滞涨');
    ok(r.signal.category !== '看多信号', `高位放量滞涨不得输出看多信号（实际 ${r.signal.category}）`);
  }
  // 集成：无分时时口诀 1/3 数据不足如实标注；提供分时时不误标
  {
    const bars = mkBars(250, i => flatBar(10, 1000, { amount: 1e8 }));
    const r1 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
    ok(r1.ratioSummary.items[0].status === '数据不足' && r1.ratioSummary.items[2].status === '数据不足', '无分时 → 口诀1/3 数据不足');
    ok(r1.dataGaps.some(g => /开盘量比超3/.test(g)) && r1.dataGaps.some(g => /尾盘突然放量拉升/.test(g)), 'dataGaps 收录两条口诀的分时不足说明');
    // 20261017g：分时须带真实交易时段时间戳（'HHMM'）且覆盖到 15:00，口诀3 才具备判定条件
    const fullMinutes = { minutes: Array.from({ length: 242 }, (_, i) => {
      const k = i <= 120 ? 9 * 60 + 30 + i : 13 * 60 + (i - 121);
      return { time: `${String(Math.floor(k / 60)).padStart(2, '0')}${String(k % 60).padStart(2, '0')}`, price: 10, avg: 10, cumVol: (i + 1) * 4 };
    }), prevClose: 10 };
    const r2 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: fullMinutes, blacklistReasons: [] });
    ok(r2.ratioSummary.items[0].status !== '数据不足' && r2.ratioSummary.items[2].status !== '数据不足', '提供完整交易日分时 → 口诀1/3 不标数据不足');
    const r3 = ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: { minutes: fullMinutes.minutes.slice(0, 100), prevClose: 10 }, blacklistReasons: [] });
    ok(r3.ratioSummary.items[2].status === '数据不足' && r3.ratioSummary.items[0].status !== '数据不足', '盘中未收盘分时 → 仅口诀3 标数据不足（口诀1 开盘已完整可判）');
    ok(r3.dataGaps.some(g => /尚未覆盖收盘/.test(g)), '集成层 dataGaps 收录未收盘说明');
  }
}

// ============ [18] 底部区域相位分类（20261020a） ============
console.log('\n[18] 底部相位分类：构筑期/启动确认区/方向不明单源推导，该放/该缩两侧互斥');
{
  // 低位+平台价格基底（260 根）：前 180 日自 20 阴跌进入平台区，其后在 [9.9,10.6] 震荡（带宽约 7%，
  // 满足 _sidewaysAndPlatform 平台口径）；平台前 30 日（199..228）放量 200 抬升 60 日均量，
  // 使平台后地量 30 ≤ 60 日均量×50%（地量线），供 _bottomPhase 六维度框架判定。
  const lpPrice = i => (i < 180 ? 20 - i * 0.055 : 10.25 + 0.35 * Math.sin((i - 180) * 0.7));
  const lpBars = (volFn, overrides = {}) => mkBars(260, i => (overrides[i] ? overrides[i] : flatBar(lpPrice(i), volFn(i))));
  const run = bars => ve.computeVolumeEngine({ symbol: '600000', name: '测试', bars, minutes: null, blacklistReasons: [] });
  const ampItem = r => r.contradictionSummary.items[0];    // 该放量未放量
  const shrinkItem = r => r.contradictionSummary.items[1]; // 该缩量反放巨量

  // 场景1 构筑期（缩量磨底）：地量持续 10/10 日 + 未创新低 + 未突破平台上沿 + 均线走平 → 该缩量是预期
  {
    const r = run(lpBars(i => (i < 199 ? 500 : (i <= 228 ? 200 : 30)), { 258: flatBar(10.25, 30), 259: flatBar(10.25, 25) }));
    ok(r.position.label === '低位区间', '场景1（构筑期）：位置 = 低位区间');
    ok(r.bottomPhase.phase === '构筑期', `场景1：相位 = 构筑期（实际 ${r.bottomPhase.phase}）`);
    ok(/卖压衰竭/.test(r.bottomPhase.basis), '场景1：相位依据 = 卖压衰竭验证（地量持续+低点不再下移）');
    ok(r.bottomPhase.detail.lowVolDays >= 6, `场景1：观察清单 lowVolDays ≥6（实际 ${r.bottomPhase.detail.lowVolDays}）`);
    ok(!ampItem(r).matched, '场景1：构筑期不施加「该放量」期望 → 该放量未放量未命中');
    ok(!shrinkItem(r).matched, '场景1：缩量磨底且量能未达巨量 → 该缩量反放巨量未命中');
    ok(/底部相位判定为【构筑期】/.test(r.contradictionSummary.summary), '场景1：归集总结追加相位说明（构筑期）');
  }
  // 场景2 截图复刻（核心回归）：低位+平台+量比 1.15 平量+60 日 confirm=放量
  // 旧代码双命中：该放量侧「低位吸筹确认场景」（isHugeVol=false）+ 该缩量侧「横盘整理+confirm 放量」
  {
    const r = run(lpBars(i => (i < 199 ? 500 : (i <= 228 ? 200 : (i <= 255 ? 30 : (i <= 257 ? 400 : (i === 258 ? 150 : 232))))), { 258: flatBar(10.25, 150), 259: flatBar(10.25, 232) }));
    ok(r.position.label === '低位区间', '场景2（截图复刻）：位置 = 低位区间');
    ok(r.bottomPhase.phase === '构筑期', `场景2：相位 = 构筑期（实际 ${r.bottomPhase.phase}）`);
    ok(r.volumeState.confirm === '放量', '场景2：60 日均量口径确认为放量（旧口径污染前提成立）');
    ok(r.volumeState.level === '平量', `场景2：÷5 日档位 = 平量（实际 ${r.volumeState.level}）`);
    ok(Math.abs(r.volumeState.ratio5 - 1.15) < 0.01, `场景2：量比 ≈1.15（实际 ${r.volumeState.ratio5}）`);
    ok(r.rules[0].matched === false, '场景2：规则1 低位吸筹未命中（近3日未连续放量）');
    ok(!ampItem(r).matched, '场景2：该放量未放量未命中（构筑期不施加该放量期望——相位门控生效）');
    ok(!shrinkItem(r).matched, '场景2：该缩量反放巨量未命中（档位平量，60 日 confirm 不参与巨量判定——口径收严生效）');
    ok(/横盘整理/.test(shrinkItem(r).scenario), '场景2：该缩量侧场景仍在（横盘整理）——未命中源于巨量口径而非无场景');
    ok(/卖压衰竭/.test(ampItem(r).conclusion), '场景2：该放量侧未命中文案带相位依据');
  }
  // 场景3 启动确认区（放量突破）：近3日放量持续 + 收盘突破平台上沿 → 该放量是预期；
  // 当日巨量+阴线（旧代码「低位洗盘+天量」误命中来源）不再触发该缩量侧
  {
    const r = run(lpBars(i => (i < 199 ? 500 : (i <= 228 ? 200 : (i <= 256 ? 30 : (i <= 258 ? 1000 : 3000)))), { 257: flatBar(10.8, 1000), 258: flatBar(10.9, 1000), 259: flatBar(10.7, 3000) }));
    ok(r.position.label === '低位区间', '场景3（启动确认区）：位置 = 低位区间');
    ok(r.bottomPhase.phase === '启动确认区', `场景3：相位 = 启动确认区（实际 ${r.bottomPhase.phase}）`);
    ok(/买盘验证/.test(r.bottomPhase.basis), '场景3：相位依据 = 买盘验证成立（放量持续+价格抬升）');
    ok(r.rules[0].matched === false, '场景3：规则1 未命中（重心未企稳：今收 10.7 < 3 日前 10.8）');
    ok(/底部启动确认场景/.test(ampItem(r).scenario), '场景3：该放量侧纳入「底部启动确认场景」');
    ok(!ampItem(r).matched, '场景3：启动确认区且量能已有效放大 → 该放量未放量未命中');
    ok(!shrinkItem(r).matched, '场景3：启动确认区放量是预期行为 → 该缩量反放巨量未命中（旧代码此处误命中）');
    ok(/买盘验证/.test(shrinkItem(r).conclusion), '场景3：该缩量侧未命中文案带相位依据');
  }
  // 场景4 低位单日脉冲豁免：构筑期内单日倍量脉冲 = 噪音（框架「假信号识别」），不判启动也不判分歧
  {
    const r = run(lpBars(i => (i < 199 ? 500 : (i <= 228 ? 200 : (i === 259 ? 90 : 30))), { 258: flatBar(10.1, 30), 259: flatBar(10.5, 90) }));
    ok(r.bottomPhase.phase === '构筑期', `场景4（脉冲豁免）：脉冲不判启动 → 仍为构筑期（实际 ${r.bottomPhase.phase}）`);
    ok(/单日脉冲噪音/.test(r.bottomPhase.basis), '场景4：相位依据标注单日脉冲为构筑期内噪音');
    ok(r.checks.pulse === true, '场景4：单日脉冲爆量判定成立');
    ok(/横盘整理/.test(shrinkItem(r).scenario), '场景4：该缩量侧场景仍在（横盘整理）');
    ok(!shrinkItem(r).matched, '场景4：低位单日脉冲豁免 → 该缩量反放巨量未命中（旧代码此处误命中）');
    ok(!ampItem(r).matched, '场景4：该放量未放量未命中（量能已有效放大）');
  }
  // 场景5 非低位回归保护：相位门控只影响低位平台——上涨中途缩量回调+大量仍应命中
  {
    const upBars = mkBars(260, i => flatBar(i < 100 ? 9 + i * 0.05 : (i < 200 ? 13.95 - (i - 100) * 0.04 : 10.5 + (i - 200) * 0.015), 1000));
    upBars[258] = flatBar(11.42, 1000);
    upBars[259] = flatBar(11.3, 5000);
    const r = run(upBars);
    ok(r.position.label === '上涨中途', `场景5（回归保护）：位置 = 上涨中途（实际 ${r.position.label}）`);
    ok(r.bottomPhase.phase === '不适用', '场景5：非低位 → 相位不适用');
    ok(shrinkItem(r).matched === true, '场景5：上涨中途缩量回调+大量 → 该缩量反放巨量仍命中（门控不影响非低位）');
    ok(/上涨中途缩量回调/.test(shrinkItem(r).scenario), '场景5：场景文案保持');
  }
  // 场景6 _bottomPhase 单元：不适用 / 数据不足分支
  {
    const upBars = mkBars(260, i => flatBar(i < 100 ? 9 + i * 0.05 : (i < 200 ? 13.95 - (i - 100) * 0.04 : 10.5 + (i - 200) * 0.015), 1000));
    upBars[258] = flatBar(11.42, 1000);
    upBars[259] = flatBar(11.3, 5000);
    const pc5 = ve._precompute(upBars);
    ok(ve._bottomPhase(pc5, { position: { label: '上涨中途' }, platform: null }).phase === '不适用', '_bottomPhase：非低位区间 → 不适用');
    const shortBars = mkBars(24, i => flatBar(i === 0 ? 20 : 10, 1000));
    const pcS = ve._precompute(shortBars);
    const platS = ve._sidewaysAndPlatform(shortBars).platform;
    ok(platS !== null, '场景6：24 根仍可识别平台（供相位判定消费）');
    ok(ve._bottomPhase(pcS, { position: ve._detectPosition(pcS, platS), platform: platS }).phase === '数据不足', '_bottomPhase：样本 24 根 <25 → 数据不足（不臆断相位）');
  }
  // 场景7 互斥不变量扫描：低位平台基底上扫量比×涨跌幅，「该放量未放量」与「该缩量反放巨量」不得同时命中
  {
    const ratios = [0.3, 0.6, 0.9, 1.15, 1.5, 2.0, 3.0, 5.0];
    const chgs = [-4, -1.5, 0, 1.5, 4];
    let viol = 0, badPhase = 0;
    for (const r5 of ratios) for (const c of chgs) {
      const r = run(lpBars(i => (i < 199 ? 500 : (i <= 228 ? 200 : (i === 259 ? Math.round(30 * r5) : 30))), { 258: flatBar(10.25, 30), 259: flatBar(+(10.25 * (1 + c / 100)).toFixed(4), Math.round(30 * r5)) }));
      if (ampItem(r).matched && shrinkItem(r).matched) viol++;
      if (!['构筑期', '启动确认区', '方向不明'].includes(r.bottomPhase.phase)) badPhase++;
    }
    ok(viol === 0, `互斥不变量：${ratios.length * chgs.length} 组合扫描双信号无同时命中（违例 ${viol}）`);
    ok(badPhase === 0, `相位取值合法：${ratios.length * chgs.length} 组合均在 {构筑期,启动确认区,方向不明}（异常 ${badPhase}）`);
  }
}

// ============ [19] 11.3.1 该放量未放量阈值具象化（20261020d） ============
console.log('\n[19] 该放量未放量：「60 日均量 ×1.5」同屏展示均值×1.5=阈值与当日实际量');
{
  // 与 [16] 节同模式的节内私有 mkPc（预计算 pc 夹具；avg60/volToday 等可由 over 覆盖；
  // highs/closes 供 _contradictionRules 攻击压力位与 _bottomPhase 相位判定消费）
  const mkPc = (over = {}) => {
    const n = over.n || 60;
    const lows = over.lows || Array.from({ length: n }, () => 9.5);
    return {
      n, level: '平量', ratio5: 1, ratio5Prev: 1, ratio10: 1, ratio20: 1,
      avg5: 1000, avg10: 1000, avg20: 1000, avg60: 1000,
      confirm: null, chgPct: 0, closePrev: 10, closeToday: 10, highToday: 10.02,
      volToday: 1000, vols: Array.from({ length: n }, () => 1000),
      highs: Array.from({ length: n }, () => 10), closes: Array.from({ length: n }, () => 10),
      ma20: Array.from({ length: n }, () => 10), ma60: Array.from({ length: n }, () => 10),
      lows, lowToday: 9.95,
      drawdownFromHigh: -5, pricePct12m: 0.5,
      ...over,
    };
  };
  const baseCtx = { position: { label: '上涨中途' }, levels: {}, sequence: {}, rules: [], platform: null, breakThrough: false, currentSideways: false };
  // 命中：上涨确认场景（chgPct≥1.2）+ 档位平量（非巨量）→ 文案展示阈值计算过程与当日实际量
  {
    const pc = mkPc({ chgPct: 1.5, avg60: 1000, volToday: 800, level: '平量', ratio5: 0.8 });
    const item = ve._contradictionRules(pc, baseCtx).shouldAmpNot;
    ok(item.matched === true && /上涨确认/.test(item.scenario), '命中：上涨确认场景且量能未达巨量 → 该放量未放量命中');
    // 20261021h：文案现在同时给出「当日量 ÷ 阈值」的倍数，便于用户自己核对，不再只凭档位下结论
    ok(/但成交量未达 60 日均量 1000 ×1\.5 = 1500（当日量 800）（当日量为阈值的 0\.53 倍）/.test(item.conclusion),
      `命中文案展示「60 日均量 1000 ×1.5 = 1500（当日量 800）」计算过程（实际：${item.conclusion}）`);
    ok(!/未达 60 日均量 ×1\.5 也未/.test(item.conclusion), '命中文案不再残留纯符号「60 日均量 ×1.5」');
  }
  // 当日量缺失：仅展示均值×1.5=阈值，不拼「当日量」（禁 null 入文案）
  {
    const pc = mkPc({ chgPct: 1.5, avg60: 1000, volToday: 0, level: '平量', ratio5: 0.8 });
    const item = ve._contradictionRules(pc, baseCtx).shouldAmpNot;
    ok(/但成交量未达 60 日均量 1000 ×1\.5 = 1500 也未进入温和放量区/.test(item.conclusion) && !/当日量/.test(item.conclusion),
      `当日量缺失 → 只展示阈值不拼「当日量」（实际：${item.conclusion}）`);  }
  // avg60≤0 数据不足：退回原纯符号文本（禁「null ×1.5 = null」）
  {
    const pc = mkPc({ chgPct: 1.5, avg60: 0, volToday: 800, level: '平量', ratio5: 0.8 });
    const item = ve._contradictionRules(pc, baseCtx).shouldAmpNot;
    ok(item.matched === true && /但成交量未达 60 日均量 ×1\.5 也未进入温和放量区/.test(item.conclusion) && !/null/.test(item.conclusion),
      `avg60≤0 → 退回原纯文本且无 null（实际：${item.conclusion}）`);
  }
  // 未命中分支不涉及阈值文案，保持原状
  {
    const pc = mkPc({ chgPct: 0.3, avg60: 1000, volToday: 800, level: '平量', ratio5: 0.8 });
    const item = ve._contradictionRules(pc, baseCtx).shouldAmpNot;
    ok(item.matched === false && /未命中「该放量未放量、资金未跟上」（当前无本应放量场景/.test(item.conclusion),
      '无放量场景 → 未命中文案保持原状');
  }
}

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
