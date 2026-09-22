// 测试长江证券（000783）补丁F-Plus & 补丁G（20260922f）
// 补丁F-Plus ① 空间校验精简：每档行仅展示该档单边空间（悲观=下行 / 乐观=上行 / 基准=不计）
// 补丁F-Plus ② SOTP 偏离深度归因：|偏离|>30% 强制穿透拆解，量化「分部估值泡沫」与「集团折价」各贡献 pp
// 补丁G     动态锚均值回归兜底：上轨 90%分位（突破→警告）/ 下轨 50%分位（跌破→估值底线保护）
const fs = require('fs');
const m = require('../lib/valuation/changjiang000783.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}
const r2 = (x) => Math.round(Number(x) * 100) / 100;

const P = 8.51;
const r = m.run('000783', { price: P });
const rows = r.matrixRows || [];
const byMethod = (kw) => rows.find(x => String(x.method).indexOf(kw) === 0);
const rl = (kw) => (r.riskLights || []).find(x => String(x.label).indexOf(kw) !== -1);

console.log('===== 补丁F-Plus ① 单边空间展示 =====');
const notePess = String(byMethod('极端悲观').note);
const noteBase = String(byMethod('基准').note);
const noteOpt = String(byMethod('极端乐观').note);

ok('极端悲观行 仅展示「下行空间 -17.27%」', notePess.indexOf('下行空间 -17.27%') !== -1);
ok('极端悲观行 含「未触及40%熔断线」', notePess.indexOf('未触及40%熔断线') !== -1);
ok('极端悲观行 **不含**「上行空间」', notePess.indexOf('上行空间') === -1);
ok('极端乐观行 仅展示「上行空间 +32.31%」', noteOpt.indexOf('上行空间 +32.31%') !== -1);
ok('极端乐观行 **不含**「下行空间」', noteOpt.indexOf('下行空间') === -1);
ok('基准行 不计空间（无上行/下行空间字样）', noteBase.indexOf('本档不计空间') !== -1 && noteBase.indexOf('上行空间') === -1 && noteBase.indexOf('下行空间') === -1);
ok('SOTP 行不含空间字样（只有分档行管空间）', String(byMethod('SOTP').note).indexOf('空间') === -1);
ok('positionNote 已去冗余（不再堆砌上下行空间）', String(r.positionNote).indexOf('上行空间') === -1 && String(r.positionNote).indexOf('下行空间') === -1);
ok('风险看板 F-Plus 空间校验行仅列下行', (() => { const x = rl('补丁F-Plus·空间校验'); return !!x && String(x.label).indexOf('下行') !== -1 && String(x.label).indexOf('上行') === -1; })());
ok('全矩阵无任何一行同时出现上行+下行空间', rows.every(x => { const n = String(x.note); return !(n.indexOf('上行空间') !== -1 && n.indexOf('下行空间') !== -1); }));
ok('patchFPlus.singleSideSpace = true', r.patchFPlus.singleSideSpace === true);
ok('单边空间原文与示例一致', r.patchFPlus.downSpaceText === '下行空间 -17.27%，未触及40%熔断线' && r.patchFPlus.upSpaceText === '上行空间 +32.31%');

console.log('\n===== 补丁F-Plus ② SOTP 偏离深度归因 =====');
const attr = r.patchFPlus.sotpAttr;
const noteSotp = String(byMethod('SOTP').note);
ok('当前偏离 >30% → 强制深度归因已触发', r.patchFPlus.sotpDeep === true && attr.devPct > 30);
ok('阈值取自配置 sotpDeviationDeepLimitPct = 30', r.patchFPlus.devDeepLimit === 30);
ok('说明含「分部倍数穿透」且逐分部列出倍数', noteSotp.indexOf('【分部倍数穿透】') !== -1 && noteSotp.indexOf('科创投资 16.5x') !== -1 && noteSotp.indexOf('投行 12.5x') !== -1);
ok('说明含「① 分部估值泡沫」并点名最高泡沫分部', noteSotp.indexOf('【① 分部估值泡沫】') !== -1 && noteSotp.indexOf('科创投资给到 16.5x PE') !== -1);
ok('说明含「② 集团折价」并给出 15%~25% / 中值 20%', noteSotp.indexOf('【② 集团折价】') !== -1 && noteSotp.indexOf('15%~25%') !== -1 && noteSotp.indexOf('中值 20%') !== -1);
ok('说明含「③ 残差」', noteSotp.indexOf('【③ 残差】') !== -1);
ok('说明含「若剔除该分部估值泡沫，SOTP 中枢将回落至 ¥11.25」', noteSotp.indexOf('若剔除该分部估值泡沫，SOTP 中枢将回落至 ¥11.25') !== -1);
ok('三类归因相加 = 总偏离（pp 自洽）', r2(attr.bubblePp + attr.discPp + attr.residualPp) === attr.devPct);
ok('泡沫贡献 16.99pp / 集团折价 24pp / 残差 -3.98pp', attr.bubblePp === 16.99 && attr.discPp === 24 && attr.residualPp === -3.98);
ok('集团折价折后中枢 ¥9.00 已写入说明', attr.discountedPs === 9 && noteSotp.indexOf('折后中枢 ¥9.00') !== -1);
ok('折后中枢与主模型吻合（差 3.98% ≤ 10%）→ 不得再以「集团折价」一笔带过', attr.gapAfterPct === 3.98 && noteSotp.indexOf('偏离完全可由「分部估值泡沫 + 集团折价」解释') !== -1);
ok('风险看板新增 F-Plus 偏离归因行', !!rl('补丁F-Plus·SOTP 偏离归因'));
ok('sotpRows 合计行 source 标注已做穿透归因', (() => { const x = (r.sotpRows || []).find(v => v.label === 'SOTP 合计'); return !!x && String(x.source).indexOf('强制穿透归因') !== -1; })());
// 纯函数：市场均值基准内/外的判定
const pure = m.attributeSotpDeviation({
  segs: [
    { key: 'a', label: 'A', profit: 10, mult: 9.18, basis: 'PE' },   // = 基准 → 无泡沫
    { key: 'b', label: 'B', profit: 10, mult: 20, basis: 'PE' },     // 高出 10.82x → 泡沫 108.2 亿
    { key: 'c', label: 'C', profit: 100, mult: 2, basis: 'PB' },     // PB 类 → 不计 PE 泡沫
  ],
  totalPs: 30, targetPs: 20, shares: 10, benchPe: 9.18, discBand: [0.15, 0.25],
});
ok('纯函数：仅 PE 且高于市场均值的分部计泡沫（108.2 亿）', pure.bubbleTotal === 108.2);
ok('纯函数：泡沫 pp = 泡沫每股 / 主模型中枢 ×100', pure.bubblePp === r2((108.2 / 10) / 20 * 100));
ok('纯函数：集团折价取区间中值 20%', pure.discMid === 0.2);
ok('纯函数：偏离 pp / 折后中枢 / 残差计算正确', pure.devPct === 50 && pure.afterBubblePs === 19.18 && pure.discountedPs === 15.34 && r2(pure.bubblePp + pure.discPp + pure.residualPp) === pure.devPct);
ok('纯函数：缺省折价区间兜底 15%~25%', m.attributeSotpDeviation({ segs: [], totalPs: 10, targetPs: 10, shares: 1, benchPe: 9 }).discMid === 0.2);

console.log('\n===== 补丁G 动态锚均值回归兜底（双轨保护） =====');
const g = r.patchG;
ok('当前 rail = upper-breach（上轨突破）', g.rail === 'upper-breach');
ok('下轨 = 近5年**真实**50%分位 0.916，铁底价 6.11', g.floorPb === 0.916 && g.floorPrice === 6.11);
ok('下轨口径已声明为「近5年日K真实50%分位，非长周期均值1.33倍」', String(g.floorRailBasis).indexOf('近5年日K真实50%分位') !== -1 && String(g.floorRailBasis).indexOf('非长周期均值 1.33 倍') !== -1);
ok('当前数据下轨未触发（anchorFloorActive=false）', g.anchorFloorActive === false);
ok('上轨/下轨均写回返回值（90%分位 1.165）', g.upRailPb === 1.165);
ok('规定文案已更新为「已触及近5年真实估值铁底（0.916倍）…静待均值回归。」', g.anchorFloorNote === '已触及近5年真实估值铁底（0.916倍），市场处于极度悲观定价，下行空间有限，静待均值回归。');
ok('旧文案「不宜过度悲观」已废弃', String(g.anchorFloorNote).indexOf('不宜过度悲观') === -1 && String(r.decisionNote).indexOf('不宜过度悲观') === -1);
ok('风险看板含「补丁G·动态锚双轨保护」行（当前红灯）', (() => { const x = rl('补丁G·动态锚双轨保护'); return !!x && String(x.light).indexOf('红灯') !== -1 && String(x.label).indexOf('近5年真实50%分位') !== -1; })());
ok('综合结论行披露双轨状态', String(byMethod('综合结论').note).indexOf('补丁G 双轨：上轨已突破') !== -1);
// 纯函数：下轨触发 / 未触发 / 刚好相等（严格小于才触发）
ok('纯函数：锚 0.85 < 50%分位 0.916 → 触发且以底线价为准', (() => { const o = m.pickAnchorFloor({ pbAnchor: 0.85, pbP50: 0.916, bvps: 6.67 }); return o.active === true && r2(o.target) === 6.11 && r2(o.rawPrice) === 5.67; })());
ok('纯函数：锚 1.41 > 50%分位 → 不触发、按原值', (() => { const o = m.pickAnchorFloor({ pbAnchor: 1.4057, pbP50: 0.916, bvps: 6.67 }); return o.active === false && r2(o.target) === r2(o.rawPrice); })());
ok('纯函数：锚 = 50%分位（临界）→ 不触发（严格小于）', m.pickAnchorFloor({ pbAnchor: 0.916, pbP50: 0.916, bvps: 6.67 }).active === false);

console.log('\n===== 补丁G·规则4 长周期均值锚 → 乐观复苏情景（仅备注，不参与主模型） =====');
const rec = g.recovery || {};
ok('长周期均值锚取配置 1.33 倍', rec.pbLtMean === 1.33);
ok('复苏情景价 = BVPS 6.67 × 1.33 = ¥8.87', rec.price === 8.87);
ok('闸门①市场日均成交额已达标（近20日日均 19323.07 亿 ≥ 15000 亿）', rec.gateTurnover === true && rec.turnoverYi === 19323.07 && rec.turnoverFloorYi === 15000);
ok('闸门②公司 ROE 持续上行（4.79→5.08→10.02 → 2026E 12.9）', rec.gateRoe === true && JSON.stringify(rec.roeValues) === '[4.79,5.08,10.02]');
ok('双条件满足 → 情景 active 并给出说明（长周期均值锚 1.33 倍 × BVPS = ¥8.87）', rec.active === true && String(rec.note).indexOf('长周期均值锚 1.33 倍 × BVPS 6.67 = ¥8.87') !== -1);
ok('说明明确「不参与主模型计算」', String(rec.note).indexOf('该锚仅作「乐观复苏情景」备用目标，不参与主模型计算') !== -1);
ok('说明明确不进入三档矩阵/不影响锚与评级', String(rec.note).indexOf('不进入上方三档矩阵，不参与动态 PB 锚、三档区间与评级计算') !== -1);
ok('主模型三档未被复苏情景污染（仍 7.04 / 9.38 / 11.26）', r.fairValueRange[0] === 7.04 && r.fairValueCenter === 9.38 && r.fairValueRange[1] === 11.26);
ok('riskLights 新增「补丁G·乐观复苏情景闸门」行（展示状态）', (() => { const x = rl('补丁G·乐观复苏情景闸门'); return !!x && String(x.light).indexOf('情景展示') !== -1 && String(x.label).indexOf('1.5 万亿') !== -1; })());
ok('综合结论行已披露乐观复苏情景', String(byMethod('综合结论').note).indexOf('乐观复苏情景（仅备注、不参与主模型）') !== -1 && String(r.decisionNote).indexOf('G·规则4 乐观复苏情景') !== -1);
// 纯函数：闸门组合判定
const ev = m.evalRecoveryScenario;
ok('纯函数：成交额 1.2 万亿（<1.5万亿）→ 闸门①不通过 → 不展示', (() => { const o = ev({ bvps: 6.67, pbLtMean: 1.33, turnoverYi: 12000, turnoverFloorYi: 15000, roeValues: [4.79, 5.08, 10.02], predictedRoePct: 12.9 }); return o.active === false && o.gateTurnover === false && o.gateRoe === true && o.price === 8.87; })());
ok('纯函数：成交额 1.55 万亿但 ROE 非递增（10.02→5.08）→ 不展示', (() => { const o = ev({ bvps: 6.67, pbLtMean: 1.33, turnoverYi: 15500, turnoverFloorYi: 15000, roeValues: [10.02, 5.08, 4.79], predictedRoePct: 12.9 }); return o.active === false && o.gateTurnover === true && o.gateRoe === false; })());
ok('纯函数：ROE 递增但预测 ROE 低于最近一年 → 不展示（非「持续上行」）', (() => { const o = ev({ bvps: 6.67, pbLtMean: 1.33, turnoverYi: 20000, turnoverFloorYi: 15000, roeValues: [4.79, 5.08, 10.02], predictedRoePct: 8.0 }); return o.active === false && o.gateRoe === false; })());
ok('纯函数：双条件满足（成交额 = 阈值 1.5 万亿，取「≥」）→ 展示', ev({ bvps: 6.67, pbLtMean: 1.33, turnoverYi: 15000, turnoverFloorYi: 15000, roeValues: [4.79, 5.08, 10.02], predictedRoePct: 12.9 }).active === true);
ok('纯函数：成交额缺失（N/A）→ 闸门①不通过 → 不展示', ev({ bvps: 6.67, pbLtMean: 1.33, turnoverYi: null, turnoverFloorYi: 15000, roeValues: [4.79, 5.08, 10.02], predictedRoePct: 12.9 }).active === false);
ok('纯函数：缺省阈值兜底 15000 亿（1.5 万亿）', ev({ bvps: 6.67, pbLtMean: 1.33, turnoverYi: 15000, roeValues: [4.79, 5.08], predictedRoePct: 12 }).turnoverFloorYi === 15000);

console.log('\n===== 补丁G 触发态端到端（临时改写配置：ROE 归零 + 预测 ROE 下修至 3%） =====');
const origRead = fs.readFileSync;
let patched = null;
try {
  fs.readFileSync = function (p, ...rest) {
    const out = origRead.call(fs, p, ...rest);
    try {
      if (String(p).indexOf('000783.json') !== -1) {
        const j = JSON.parse(out.toString());
        j.inputs.patchC.companyRoe3y.values = [0, 0, 0];   // roeRatio→0，PB中枢 → 行业PB×40% = 0.512
        j.inputs.patchC.predictedRoe.value = 3.0;          // < 行业均值×0.8 → 锚再下修 7.5% → 0.4736 < 0.916
        return JSON.stringify(j);
      }
    } catch (e) { /* ignore */ }
    return out;
  };
  patched = m.run('000783', { price: 6.5 });
} finally {
  fs.readFileSync = origRead;
}
ok('触发态：下轨生效 anchorFloorActive = true', !!(patched && patched.patchG.anchorFloorActive === true));
ok('触发态：中枢被抬升至历史50%分位价 ¥6.11（原始 ¥3.16 不再下探）', !!patched && patched.patchG.pbTarget === 6.11 && patched.patchG.pbTargetRaw === 3.16);
ok('触发态：rail = floor-active', !!patched && patched.patchG.rail === 'floor-active');
ok('触发态：基准行说明栏写入规定文案', !!(patched && String(patched.matrixRows.find(x => x.method.indexOf('基准') === 0).note).indexOf('已触及近5年真实估值铁底（0.916倍），市场处于极度悲观定价，下行空间有限，静待均值回归。') !== -1));
ok('触发态：风险看板 补丁G 行转黄灯（周期底部防御生效）', !!(patched && (patched.riskLights.find(x => String(x.label).indexOf('补丁G·动态锚双轨保护') !== -1) || {}).light.indexOf('黄灯') !== -1));
ok('触发态：三档仍自洽（50%分位落在历史分位带内 → 不触发强制外扩）', !!(patched && patched.patchF.orderOk === true && patched.patchF.boundaryFixed === false));
ok('触发态：下行空间有限（现价 6.5 → 下行 > -25%）', !!(patched && Math.abs(patched.patchF.spaceDownPct) < 25));
ok('触发态：ROE 归零 → 闸门②不通过 → 乐观复苏情景不展示（仅备注、不参与主模型）', !!(patched && patched.patchG.recovery.active === false && patched.patchG.recovery.gateRoe === false && patched.patchG.recovery.note === ''));
ok('触发态：三档不受复苏情景影响（仍为 50%分位价 ¥6.11 为中枢）', !!(patched && patched.fairValueCenter === 6.11));
ok('恢复后配置未被污染（正常态 rail 回到 upper-breach）', m.run('000783', { price: P }).patchG.rail === 'upper-breach');

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
