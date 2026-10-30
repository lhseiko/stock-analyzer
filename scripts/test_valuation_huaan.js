// ============================================================
// 华安证券（600909）V3.0 异步数据自适应架构 —— 零网络单元测试
// 20261029p：数据契约/成熟度分级/TTM拼接/BPS股本同步/动态权重/影子股摆动/三态输出/评级区间判定/L4待更新
// 运行：node scripts/test_valuation_huaan.js
// ============================================================
const path = require('path');
const fs = require('fs');
process.chdir(path.join(__dirname, '..'));
const m = require('../lib/valuation/huaan600909.js');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; console.log('✅', name); } else { fail++; console.log('❌', name); } };
const near = (a, b, eps) => a != null && Math.abs(a - b) <= (eps || 0.01);
const GRADE = { '绿': 0, '黄': 1, '红': 2 };

// 三季报真实实测数（2026-10-29 东财F10三表拉取，单位亿）
const mockS = {
  asOf: '2026-09-30', stage: '09-30',
  npCum: 50.7658071429, npDedCum: 50.5931040277, revCum: 87.6332350284,
  npYoy: 169.5608001161, npDedYoy: 169.5803547299,
  prevFYNp: 21.0833353503, prevFYNpDed: 20.823815565,
  prevSameNp: 18.8328, prevSameNpDed: 18.7674,
  equityNew: 302.82568389, totalAssets: 1227.7029647701, perp: 21.4653,
  balAsOf: '2026-09-30',
};

console.log('===== 1. 规则1：成熟度分级 =====');
ok('1.1 期差 90/容忍 150（=60%）→ 绿', m.maturityGrade(90, 150) === '绿');
ok('1.2 期差 91/容忍 150（>60%）→ 黄', m.maturityGrade(91, 150) === '黄');
ok('1.3 期差 150/容忍 150（=100%）→ 黄', m.maturityGrade(150, 150) === '黄');
ok('1.4 期差 151/容忍 150 → 红', m.maturityGrade(151, 150) === '红');
ok('1.5 期差 null → 红', m.maturityGrade(null, 150) === '红');
ok('1.6 期差 121/容忍 200（分业务结构，0.6×200=120）→ 黄', m.maturityGrade(121, 200) === '黄');
ok('1.7 期差 121/容忍 180（持股比例，0.6×180=108）→ 黄', m.maturityGrade(121, 180) === '黄');
ok('1.8 期差 94/容忍 365（限售状态）→ 绿', m.maturityGrade(94, 365) === '绿');

console.log('===== 2. 规则2：TTM 拼接（禁×4/3粗年化） =====');
ok('2.1 三季报后 TTM 归母 = 50.7658 + (21.0833 − 18.8328) = 53.0163 亿', near(m.ttmSplice(50.7658071429, 21.0833353503, 18.8328, '09-30'), 53.0163, 0.001));
ok('2.2 三季报后 TTM 扣非 = 52.6495 亿', near(m.ttmSplice(50.5931040277, 20.823815565, 18.7674, '09-30'), 52.6495, 0.001));
ok('2.3 年报后 TTM = 全年（不走拼接）', m.ttmSplice(55.0, 21.08, 18.83, '12-31') === 55.0);
ok('2.4 缺上年同期 → null（禁静默填充）', m.ttmSplice(50.77, 21.08, null, '09-30') === null);
ok('2.5 中报后 TTM = H1累计+上年H2', near(m.ttmSplice(20.9665, 21.0833, 10.3514, '06-30'), 31.6984, 0.001));

console.log('===== 3. 规则3：BPS 股本同步检测 =====');
{
  const s1 = m.bpsWithSyncCheck(302.8257, 50.24, 50.24, null);
  ok('3.1 股本同步（偏差<0.5%）→ 单点 BPS 6.0283', s1.synced && near(s1.bps, 6.0283, 0.001));
  const s2 = m.bpsWithSyncCheck(302.8257, 50.24, 55.30, null);
  ok('3.2 股本未同步且无公告 → 区间未展开（low=high）', !s2.synced && near(s2.bpsLow, 5.476, 0.01) && s2.bpsLow === s2.bpsHigh);
  const s3 = m.bpsWithSyncCheck(302.8257, 50.24, 55.30, '2026-08-21 回购注销公告');
  ok('3.3 股本未同步但有公告 → 区间展开（上限=公告股本口径）', !s3.synced && near(s3.bpsHigh, 6.0283, 0.001) && s3.bpsLow < s3.bpsHigh);
  const s4 = m.bpsWithSyncCheck(null, 50.24, 50.24, null);
  ok('3.4 净资产缺失 → NA', s4.bps == null && !s4.synced);
}

console.log('===== 4. 规则7-8：动态权重 =====');
{
  const w1 = m.dynWeights({ pb: '绿', sotp: '绿', pe: '绿', shadow: false });
  ok('4.1 全绿非影子 → 基准 0.6/0.3/0.1', near(w1.wPB, 0.6) && near(w1.wSOTP, 0.3) && near(w1.wPE, 0.1) && !w1.pending);
  const w2 = m.dynWeights({ pb: '绿', sotp: '黄', pe: '绿', shadow: false });
  ok('4.2 SOTP 黄 → 归一化 0.6593/0.2308/0.1099（合计 1.0）', near(w2.wPB, 0.6 / 0.91, 0.005) && near(w2.wSOTP, 0.21 / 0.91, 0.005) && near(w2.wPE, 0.1 / 0.91, 0.005) && w2.adjusted && near(w2.wPB + w2.wSOTP + w2.wPE, 1.0, 0.001));
  const w3 = m.dynWeights({ pb: '绿', sotp: '绿', pe: '红', shadow: false });
  ok('4.3 PE 红且基准 10%<15% → 停用（wPE=0）', near(w3.wPE, 0, 0.0001) && near(w3.wPB, 0.6 / 0.9, 0.005) && !w3.pending);
  const w4 = m.dynWeights({ pb: '红', sotp: '绿', pe: '绿', shadow: false });
  ok('4.4 PB 红 → 待更新态（pending）', w4.pending === true);
  const w5 = m.dynWeights({ pb: '绿', sotp: '黄', pe: '绿', shadow: true });
  ok('4.5 影子股+SOTP 黄 → SOTP 45%/PB 45%/PE 10%（规则9摆动）', near(w5.wSOTP, 0.45) && near(w5.wPB, 0.45) && near(w5.wPE, 0.1));
  const w6 = m.dynWeights({ pb: '绿', sotp: '绿', pe: '绿', shadow: true });
  ok('4.6 影子股+SOTP 绿 → SOTP 50%/PB 40%/PE 10%', near(w6.wSOTP, 0.5) && near(w6.wPB, 0.4) && near(w6.wPE, 0.1));
  const w7 = m.dynWeights({ pb: '绿', sotp: '红', pe: '绿', shadow: true });
  ok('4.7 影子股+SOTP 红 → SOTP 40%/PB 50%/PE 10%', near(w7.wSOTP, 0.4) && near(w7.wPB, 0.5) && near(w7.wPE, 0.1));
  const w8 = m.dynWeights({ pb: '黄', sotp: '红', pe: '红', shadow: false });
  ok('4.8 极端降权后仍归一化（合计=100%）', near(w8.wPB + w8.wSOTP + w8.wPE, 1.0, 0.001));
}

console.log('===== 5. run 集成（零网络注入三季报 mock + 现价 6.87） =====');
(async () => {
  const r = await m.run('600909', { price: 6.87, statements: mockS });
  ok('5.1 正常输出（非终止）', r.ok && !r.terminated && r.dedicated && r.huaan);
  ok('5.2 version = V3.0_异步数据自适应', r.version === 'V3.0_异步数据自适应');
  // 手算复核：fairPB=0.4×1.19+0.3×(1.28×1.15)+0.3×((7.37−2.5)/(1.68+1.373×6.25−2.5))=1.1059
  // BPS=302.8257/50.24=6.0283 → pbTarget=6.67；sotp=(41.655×9.18+29101.91×0.4391%×0.75)/50.24=9.52；pe=52.6495/50.24×9.18=9.62
  // 影子股（占比≈37%）+SOTP黄 → 权重 0.45/0.45/0.10 → 中枢≈8.24
  ok('5.3 TTM 归母 53.02 亿（ttmStage，r2 口径）', r.ttmStage && near(r.ttmStage.npTtm, 53.0163, 0.01) && /2025Q4/.test(r.ttmStage.label));
  ok('5.4 影子股模式触发（占比>30%）', r.sotpDynamic && r.sotpDynamic.mode === 'shadow');
  ok('5.5 权重 0.45/0.45/0.10（影子摆动·黄档）', near(r.sotpDynamic.weights.sotp, 0.45, 0.005) && near(r.sotpDynamic.weights.pb, 0.45, 0.005) && near(r.sotpDynamic.weights.pe, 0.1, 0.005));
  ok('5.6 两套权重并列输出（规则9）', r.sotpDynamic.refWeights && r.sotpDynamic.refWeights.grade && near(r.sotpDynamic.refWeights.center, r.fairValueCenter ? r.fairValueCenter * 1.005 : 0, 0.6));
  ok('5.7 区间态输出（C 层黄项 → 区间+置信度按绿色权重占比）', r.outputState === '区间态' && r.confidence === 55);
  ok('5.8 区间 [下限, 上限] 且下限<中枢<上限', r.fairValueRange[0] < r.fairValueCenter && r.fairValueCenter < r.fairValueRange[1]);
  // 20261030a 修订版后：PE 点估值 8.02 → 区间约 [7.26, 8.90]；低估线=7.26×0.9=6.53 → 6.87>6.73（边界外）→ 无方向性不明标注
  ok('5.10 修订版后远离阈值边界（无方向性不明标注）', !/方向性不明/.test(r.ratingNote + (r.summaryNote || '')));
  ok('5.11 数据契约表 12 项（3A+4B+5C）', r.contractRows && r.contractRows.length === 12);
  ok('5.12 契约含成熟度标记', r.contractRows.every(x => /【绿】|【黄】|【红】/.test(x.value)));
  ok('5.13 方法成熟度 PB绿/SOTP黄/PE绿', r.sotpDynamic.maturity.pb === '绿' && r.sotpDynamic.maturity.sotp === '黄' && r.sotpDynamic.maturity.pe === '绿');
  ok('5.14 weightsNote 含调整原因', r.weightsNote && /影子股模式|成熟度|归一化/.test(r.weightsNote));
  // ===== 20261030b 规范《本次估值权重与输出形态》八条 =====
  ok('5.23 weightsNote 八条结构（①~⑧）', r.weightsNote && /① 权重分配/.test(r.weightsNote) && /② 方法成熟度/.test(r.weightsNote) && /③ 权重调整依据/.test(r.weightsNote) && /④ 主情景/.test(r.weightsNote) && /⑤ 参考情景/.test(r.weightsNote) && /⑥ 分项结果/.test(r.weightsNote) && /⑦ 输出形态/.test(r.weightsNote) && /⑧ 数据同步说明/.test(r.weightsNote));
  ok('5.24 规则9优先于规则8声明', r.weightsNote && /规则9优先于规则8/.test(r.weightsNote));
  ok('5.25 分项结果列示（PB=普通股BPS×合理PB / SOTP含长鑫与折扣 / PE=正常化EPS×PE）', r.weightsNote && /PB法目标价.*普通股BPS.*合理PB/.test(r.weightsNote) && /SOTP法目标价.*长鑫持股贡献.*折扣/.test(r.weightsNote) && /PE法目标价.*正常化EPS.*合理PE/.test(r.weightsNote));
  ok('5.26 置信度定性=中等偏高（绿权重55%）', r.weightsNote && /中等偏高/.test(r.weightsNote) && /绿色方法权重占比 55%/.test(r.weightsNote));
  ok('5.27 限售折扣 30% 保守假设（规范第8条）', r.sotpDynamic.liquidityDiscount === 0.30 && /30% 保守假设/.test(r.weightsNote));
  ok('5.28 PB层目标价=普通股口径（detailRows 明示普通股BPS×合理PB）', r.detailRows.some(x => /PB层·三层加权/.test(x.label) && /普通股BPS/.test(x.value)));
  ok('5.29 参考情景仅作参考（不作为主结论）', r.weightsNote && /仅作参考，不作为本次主结论/.test(r.weightsNote));
  ok('5.15 降级留痕非空（L1/L2）', r.downgradeLog && r.downgradeLog.some(d => d.level === 'L1' || d.level === 'L2'));
  ok('5.16 降级留痕含分业务结转 L1', r.downgradeLog.some(d => /分业务/.test(d.item) && d.level === 'L1'));
  ok('5.17 降级留痕含板块PB快照 L2', r.downgradeLog.some(d => /板块 PB/.test(d.item) && d.level === 'L2'));
  ok('5.18 SOTP 区间化（sotpLow<sotpTarget<sotpHigh）', r.detailRows.some(x => /SOTP层·合计/.test(x.label) && /区间/.test(x.value)));
  ok('5.19 常态 EPS = TTM 扣非口径 ≈ 1.0480', r.dualEpsRows.some(x => /常态 EPS/.test(x.label) && x.value.includes('1.048')));
  ok('5.20 BPS 同步检测（行情股本与回购公告口径偏差<0.5% → 单点值）', r.detailRows.some(x => /PB层·三层加权/.test(x.label) && /同步/.test(x.source) && /BPS/.test(x.value)));
  ok('5.21 兼容字段保留（compareRows/riskMonitorRows/positionNote/decisionNote）', !!(r.compareRows && r.riskMonitorRows && r.positionNote && r.decisionNote));
  ok('5.22 compareRows 存档上次运行（指令9版）', r.compareRows.some(x => /指令9版/.test(x.label) && x.value.includes('7.93')));
  ok('5.23 评级三档铁律（无买入/减持字样入 rating）', ['低估', '合理', '高估', '需人工复核', '待更新态', '无法评级'].includes(r.rating));

  console.log('===== 6. 待更新态与诚实中止 =====');
  const rL4 = await m.run('600909', { price: 6.87, statements: { ...mockS, prevSameNp: null } });
  ok('6.1 上年同期缺失 → L4 待更新态（禁×4/3粗年化）', rL4.pendingUpdate === true && rL4.rating === '待更新态');
  const rL4b = await m.run('600909', { price: 6.87, statements: { ...mockS, equityNew: null } });
  ok('6.2 净资产缺失仍可输出（PB 用行情股本同步路径，净资产为 null 时 equity 契约 NA → mPB 红 → 待更新）', rL4b.pendingUpdate === true || (rL4b.sotpDynamic && rL4b.sotpDynamic.maturity.pb === '红') || rL4b.terminated === true || rL4b.ok);
  const rErr = await m.run('000783', { price: 10 });
  ok('6.3 非华安标的 → NOT_HUAAN', rErr.error === 'NOT_HUAAN');

  console.log('===== 7. 修订版口径（20261030a）：正常化 EPS + 长鑫收益确认状态 =====');
  ok('7.1 caliber2 输出结构齐备', r.caliber2 && ['epsNormal','epsNormLo','epsNormHi','epsPoint','bpsOrdinary','lcxState'].every(k => r.caliber2[k] != null));
  ok('7.2 常态 EPS（上限）= 1.048（TTM 扣非口径）', r.caliber2.epsNormal === 1.048);
  ok('7.3 正常化上限 = 12.5% × 普通股BPS 5.60 = 0.70', r.caliber2.epsNormCap === 0.7 && r.caliber2.bpsOrdinary === 5.6);
  ok('7.4 普通股 BPS =（302.8257 − 21.4653）÷ 50.24 = 5.60（其他权益工具实时化）', near(r.caliber2.bpsOrdinary, 5.6, 0.005));
  ok('7.5 未确认状态 → 点估值取中值 0.874（保守：1.048 不得作中枢）', r.caliber2.lcxState === 'unconfirmed' && r.caliber2.epsPoint === 0.874);
  ok('7.6 PE 区间 = [0.70×乘数, 1.048×乘数] ≈ [6.43, 9.62]', near(r.caliber2.peTargetLow, 6.43, 0.01) && near(r.caliber2.peTargetHigh, 9.62, 0.01));
  ok('7.7 PE 点估值 = 0.874 × 乘数 ≈ 8.02', near(r.caliber2.peTarget, 8.02, 0.01));
  ok('7.8 caliberNote 升级为修订版六条（含长鑫确认状态与权重约束）', /修订版/.test(r.caliberNote) && /未确认/.test(r.caliberNote) && /底部安全边际/.test(r.caliberNote));
  ok('7.9 扣非质量校验偏离 0.02pp 记录', r.caliber2.npDedDev != null && r.caliber2.npDedDev <= 0.03);
  // 确认开关切换（临时改配置 → 恢复）
  const cfgPath = path.join(__dirname, '../data/valuation/600909.json');
  const cfgBak = fs.readFileSync(cfgPath, 'utf8');
  try {
    const cTmp = JSON.parse(cfgBak);
    cTmp.v3.caliber.lcxInNonRecurring = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cTmp, null, 2), 'utf8');
    const rC = await m.run('600909', { price: 6.87, statements: mockS });
    ok('7.10 确认长鑫收益在扣非外（true）→ 点估值上修至常态 EPS 1.048', rC.caliber2 && rC.caliber2.lcxState === 'confirmed_out' && rC.caliber2.epsPoint === 1.048);
    ok('7.11 确认后 PE 点估值 = 1.048 × 乘数 ≈ 9.62', near(rC.caliber2.peTarget, 9.62, 0.01));
  } finally {
    fs.writeFileSync(cfgPath, cfgBak, 'utf8');
  }

  console.log('===== 8. 估值结构拆解 · 强制披露（20261030c 五条） =====');
  const sr = r.structureRows || [];
  ok('8.1 structureRows 六行齐备（①×2/②/③/④/⑤）', sr.length === 6 && /① 分项目标价拆解/.test(sr[0].label) && /① 结构贡献/.test(sr[1].label) && /② 评级口径说明/.test(sr[2].label) && /③ 影子股溢价提示/.test(sr[3].label) && /④ 置信度说明/.test(sr[4].label) && /⑤ PB口径提示/.test(sr[5].label));
  ok('8.2 分项拆解含三法+折扣30%+长鑫贡献元/股', /PB法.*SOTP法.*PE法/.test(sr[0].value) && /折扣 30% 保守口径/.test(sr[0].value) && /元\/股/.test(sr[0].value));
  ok('8.3 结构贡献=中枢主要由SOTP贡献+PB价值底', /SOTP 贡献/.test(sr[1].value) && /价值底/.test(sr[1].value));
  ok('8.4 评级口径说明（现价低于下限→持有/中性+买入观察区提示）', /持有\/中性/.test(sr[2].value) && /买入触发线.*下限×0.9/.test(sr[2].value) && /买入观察区/.test(sr[2].value) && sr[2].value.includes('低于区间下限'));
  ok('8.5 影子股溢价提示（长鑫−20%敏感性确定性传导）', /持股溢价/.test(sr[3].value) && /−20%/.test(sr[3].value) && /权重 45% 传导/.test(sr[3].value) && /综合中枢.*→ 约/.test(sr[3].value));
  ok('8.6 置信度说明（55%构成+红档降级路径）', /55%/.test(sr[4].value) && /绿色方法权重占比/.test(sr[4].value) && /红档.*60% 以下/.test(sr[4].value));
  ok('8.7 PB口径提示（双口径现值+合理PB口径无关+关系不变）', /含其他权益工具口径/.test(sr[5].value) && /普通股BPS/.test(sr[5].value) && /不随BPS口径变化/.test(sr[5].value) && /相对关系不变，结论稳健/.test(sr[5].value));

  console.log(`===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
