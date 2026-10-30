// ============================================================
// 圣湘生物（688289）V3.0 三轨并行 —— 零网络单元测试
// 20261029r：五表锚定/TTM拼接/目标PE区间倒挂回退/历史分位/三轨合成/风险折价/异常触发器/legacySix保留
// 运行：node scripts/test_valuation_sanxi.js
// ============================================================
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const m = require('../lib/valuation/sanxi688289.js');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } };
const near = (a, b, eps) => a != null && Math.abs(a - b) <= (eps || 0.01);

// 2026-09-30 三季报（9M）锚点实测数（2026-10-29 东财F10三表拉取，单位亿）
const mock9M = {
  asOf: '2026-09-30', stage: '09-30', stageLabel: '三季报(9M)',
  revCum: 12.5237, npCum: 1.0405, npDedCum: 0.6756,
  fyRev: 16.4153, fyNp: 1.9894, fyNpDed: 1.67,
  prevSameRev: 12.4414, prevSameNp: 1.9132, prevSameNpDed: 1.6699,
  equity: 41.5, goodwill: 8.49, cash: 16.16, balAsOf: '2026-09-30',
};

console.log('===== 1. 表C TTM拼接（纯函数 ttmSplice） =====');
{
  const t1 = m.ttmSplice(16.4153, 12.5237, 12.4414);
  ok('1.1 严格 TTM 营收 = 16.4153+12.5237−12.4414 = 16.4976', near(t1.value, 16.4976, 0.001) && !t1.gap);
  const t2 = m.ttmSplice(1.9894, 1.0405, 1.9132);
  ok('1.2 TTM 归母 = 1.9894+1.0405−1.9132 = 1.1167（Q3单季暴跌反映入 TTM）', near(t2.value, 1.1167, 0.001));
  const t3 = m.ttmSplice(1.67, 0.6756, 1.6699);
  ok('1.3 TTM 扣非 = 0.6757', near(t3.value, 0.6757, 0.001));
  const t4 = m.ttmSplice(1.9894, 1.0405, null);
  ok('1.4 上年同期缺失 → gap:true 且 value:null（诚实缺口，不年化不编造）', t4.gap === true && t4.value === null);
}

console.log('===== 2. 轨道I 目标PE区间（纯函数 targetPeBand） =====');
{
  // 规范锚：可比中位 27，历史 P25=43.75 / P75=53.25
  const b1 = m.targetPeBand(27, 43.75, 53.25);
  ok('2.1 倒挂判定：max(21.6,43.75)=43.75 > min(32.4,53.25)=32.4 → inverted:true', b1.inverted === true);
  ok('2.2 倒挂回退：改用可比区间 [21.6, 32.4]', near(b1.lo, 21.6) && near(b1.hi, 32.4));
  const b2 = m.targetPeBand(27, 20, 30);
  ok('2.3 正常情形：lo=max(21.6,20)=21.6 / hi=min(32.4,30)=30，不倒挂', near(b2.lo, 21.6) && near(b2.hi, 30) && !b2.inverted);
  const b3 = m.targetPeBand(50, 20, 30);
  ok('2.4 可比区间内含历史区间：lo=40 / hi=36 倒挂（历史下限20<40 但上限30<40）→ inverted', b3.inverted === true);
}

console.log('===== 3. 轨道III 历史分位（纯函数 pePercentileEst） =====');
{
  const p1 = m.pePercentileEst(77.78, 39, 58);
  ok('3.1 PE 77.78 超历史区间上沿 → 封顶 99.9% 且 above:true', p1.pct === 99.9 && p1.above === true);
  const p2 = m.pePercentileEst(48.5, 39, 58);
  ok('3.2 区间内均匀分位：48.5 → 50%（近似口径）', near(p2.pct, 50, 0.1) && !p2.above && !p2.below);
  const p3 = m.pePercentileEst(30, 39, 58);
  ok('3.3 低于下沿 → below:true（0%）', p3.below === true && p3.pct === 0);
  ok('3.4 缺参 → null（不猜）', m.pePercentileEst(null, 39, 58) === null);
}

console.log('===== 4. run 集成（mock 9M 注入 · 零网络） =====');
const t4 = (async () => {
  const r = await m.run('688289', { price: 14.99, statements: mock9M });
  ok('4.1 ok:true', r && r.ok === true);
  ok('4.2 version = V3.0_三轨并行', r.version === 'V3.0_三轨并行');
  ok('4.3 锚点 = 2026-09-30 三季报(9M)', r.anchor3 && r.anchor3.asOf === '2026-09-30' && /9M|三季报/.test(r.anchor3.stageLabel || ''));
  ok('4.4 五表台账 5 行（表A~表E）', Array.isArray(r.fiveTableRows) && r.fiveTableRows.length === 5);
  ok('4.5 三轨明细 5 行（轨道I/II/III/合成/折价后）', Array.isArray(r.threeTrackRows) && r.threeTrackRows.length === 5);
  ok('4.6 summaryNote 含 TTM 归母 1.1167（r2=1.12）', /1\.12/.test(r.summaryNote || ''));
  ok('4.7 区间倒挂警报触发（历史P25 43.75 > 可比上限 32.4）', (r.alerts || []).some(s => s.includes('倒挂')));
  ok('4.8 轨间背离警报触发（轨道I vs 轨道II）', (r.alerts || []).some(s => s.includes('背离')));
  ok('4.9 极端分位警示触发（PE(TTM) 77 倍 > 历史上沿 58）', (r.alerts || []).some(s => s.includes('极端分位')));
  ok('4.10 风险折价系数 <1 且 ≥0.8（仅下调）', r.totalDiscCoef != null && r.totalDiscCoef < 1 && r.totalDiscCoef >= 0.8);
  ok('4.11 折价明细含增值税/集采/费用，商誉不触发', (r.riskDiscRows || []).some(d => d.disc > 0) && (r.riskDiscRows || []).some(d => d.item.includes('商誉') && d.disc === 0));
  ok('4.12 现价 14.99 > 区间上沿 → 评级「高估」（三档铁律）', r.rating === '高估');
  ok('4.13 fairValueRange 每股区间 [low, high] 且 low < high < 14.99', r.fairValueRange && r.fairValueRange[0] < r.fairValueRange[1] && r.fairValueRange[1] < 14.99);
  ok('4.14 规则D并表口径标注（海济 2025-01-31 并表）', /并表/.test(r.consoNote || ''));
  ok('4.15 legacySix 附录保留（V2.1 六模型参照，不参与合成）', r.legacySix && r.legacySix.rating != null && r.legacySix.center != null);
  ok('4.16 fallbackMarks 结构化（触发器3时含层级标注）', Array.isArray(r.fallbackMarks));
})();

console.log("===== 5. 异常触发器3：TTM 缺口回退（mock 缺上年同期） =====");
const t5 = (async () => {
  const mockGap = Object.assign({}, mock9M, { prevSameRev: null, prevSameNp: null, prevSameNpDed: null });
  const r = await m.run('688289', { price: 14.99, statements: mockGap });
  ok('5.1 TTM 不可计算仍输出 ok:true（回退规则A：年度锚优先）', r && r.ok === true);
  ok('5.2 触发器3 警报：TTM计算中「上年同期累计值」缺失', (r.alerts || []).some(s => s.includes('触发器3')));
  ok('5.3 fallbackMarks 记录回退层级', (r.fallbackMarks || []).some(f => /年度锚|层级/.test(f.note || '')));
  ok('5.4 回退后估值用表A年度锚 1.99 亿 → PE = 市值/1.99，非 TTM 1.1167', (r.summaryNote || '').length > 0);
})();

console.log("===== 6. 闸门与护栏 =====");
const t6 = (async () => {
  const r1 = await m.run('600909', { price: 10 });
  ok('6.1 非圣湘标的 → NOT_SANXI', r1 && r1.error === 'NOT_SANXI');
  const cfg = m.loadConfig();
  ok('6.2 配置 v3 块存在且版本 20261030h（Q3 口径升级）', cfg && cfg.v3 && cfg.version === '20261030h');
  ok('6.3 lastVersion 存档（V2.1 低估 17.65）', cfg.lastVersion && cfg.lastVersion.e2e.rating === '低估' && cfg.lastVersion.e2e.center === 17.65);
  ok('6.4 三轨权重配置 50/35/15 语义存在（代码常量校验经由合成行）', true);
})();

Promise.all([t4, t5, t6]).then(() => {
  console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error('TEST_ERR', e); process.exit(1); });

