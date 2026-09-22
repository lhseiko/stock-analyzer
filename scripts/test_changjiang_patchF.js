// 测试长江证券（000783）补丁F：估值矩阵逻辑自洽强制校验（20260922e）
// 守卫：① 排序校验 极端悲观<基准<极端乐观（违反→动态锚强制外扩 ±）
//       ② 空间校验 下行空间=(极端悲观−现价)/现价，负数严禁截断为0，|下行|>40% 熔断
//       ③ 基准一致性 动态PB锚>历史90%分位 → 矩阵最上方强制「🔴估值体系重构警告」
const m = require('../lib/valuation/changjiang000783.js');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('✅', name); }
  else { fail++; console.log('❌', name); }
}
const r2 = (x) => Math.round(Number(x) * 100) / 100;

const P = 9.08;
const r = m.run('000783', { price: P });

// ---- 基础 ----
ok('模型返回 ok 且 changjiang=true', !!(r && r.ok && r.changjiang));
ok('版本戳 = V2-patched-FG', r.version === 'V2-patched-FG');
ok('patchF 字段已输出', !!r.patchF);

// ---- F1 排序校验 ----
const rows = r.matrixRows || [];
const sumRow = rows.find(x => String(x.method).indexOf('综合结论') === 0);
ok('综合结论行三档齐全', !!(sumRow && sumRow.low != null && sumRow.mid != null && sumRow.high != null));
ok('F1 极端悲观 < 基准中枢 < 极端乐观', sumRow.low < sumRow.mid && sumRow.mid < sumRow.high);
ok('F1 违反原边界已被识别（orderOk=false）', r.patchF.orderOk === false);
ok('F1 触发强制外扩（boundaryFixed=true）', r.patchF.boundaryFixed === true);
ok('F1 说明含规定文案「历史分位已失真，已按动态锚强制外扩边界」',
  String(r.patchF.boundaryNote).indexOf('历史分位已失真，已按动态锚强制外扩边界') !== -1);
ok('F1 极端乐观 = 基准 × 1.20', r2(sumRow.mid * 1.2) === sumRow.high);
ok('F1 极端悲观 = 基准 × 0.75', r2(sumRow.mid * 0.75) === sumRow.low);
ok('F1 历史分位原始边界仍保留在 patchF（背景参照）',
  r.patchF.extremeLowPct === 5.3 && r.patchF.extremeHighPct === 7.77);
ok('F1 极端悲观行说明含外扩文案', String(rows.find(x => String(x.method).indexOf('极端悲观') === 0).note)
  .indexOf('历史分位已失真，已按动态锚强制外扩边界') !== -1);
ok('F1 极端乐观行说明含外扩文案', String(rows.find(x => String(x.method).indexOf('极端乐观') === 0).note)
  .indexOf('历史分位已失真，已按动态锚强制外扩边界') !== -1);

// ---- F2 空间计算校验 ----
ok('F2 下行空间 = (极端悲观 − 现价) / 现价', r.patchF.spaceDownPct === r2((sumRow.low - P) / P * 100));
ok('F2 下行空间为负数且未被截断为 0', r.patchF.spaceDownPct < 0 && r.patchF.spaceDownPct !== 0);
ok('F2 上行空间 = (极端乐观 − 现价) / 现价', r.patchF.spaceUpPct === r2((sumRow.high - P) / P * 100));
ok('F2 矩阵说明含负数下行空间（不出现「下行空间 0%」）', (() => {
  const n = String(rows.find(x => String(x.method).indexOf('极端悲观') === 0).note);
  return n.indexOf('下行空间 -') !== -1 && n.indexOf('下行空间 0%') === -1;
})());
ok('F2 现价低于极端悲观时符号原样保留（不截断）', (() => {
  const r2c = m.run('000783', { price: 6.0 });
  return r2c.patchF.spaceDownPct > 0 && r2c.patchF.spaceDownPct === r2((r2c.fairValueRange[0] - 6.0) / 6.0 * 100);
})());
ok('F2 未触及熔断线时 fuseF=false 且评级正常', r.patchF.fuseF === false && r.fused === false && r.rating === '合理');
ok('F2 |下行|>40% 触发熔断并锁定「无法评级」', (() => {
  // 极端悲观 7.03 固定；P=12.5 → (7.03-12.5)/12.5 = -43.8% 触发
  const rHi = m.run('000783', { price: 12.5 });
  return rHi.patchF.fuseF === true && rHi.fused === true && rHi.rating === '无法评级'
    && String(rHi.fuseReason).indexOf('补丁F·空间校验') !== -1;
})());
ok('F2 风险看板输出补丁F·空间校验行（含负号原样）', (() => {
  const li = (r.riskLights || []).find(x => String(x.label).indexOf('补丁F-Plus·空间校验') === 0);
  return !!li && String(li.label).indexOf('下行 -') !== -1;
})());

// ---- F3 基准一致性校验 ----
ok('F3 动态PB锚 > 历史90%分位 已识别', r.patchF.anchorBreached === true);
ok('F3 矩阵最上方为「🔴 估值体系重构警告」行', rows.length > 0 && String(rows[0].method).indexOf('估值体系重构警告') !== -1);
ok('F3 警告行置于极端悲观行之前', rows.findIndex(x => String(x.method).indexOf('估值体系重构警告') !== -1) < rows.findIndex(x => String(x.method).indexOf('极端悲观') === 0));
ok('F3 警告行 emph=true（前端醒目渲染）', rows[0].emph === true);
ok('F3 警告文案含「历史分位失去参考意义」', String(rows[0].note).indexOf('历史分位失去参考意义') !== -1);
ok('F3 风险看板输出补丁F·基准一致性行', !!(r.riskLights || []).find(x => String(x.label).indexOf('补丁F·基准一致性') === 0));

// ---- 区间/下游一致性 ----
ok('fairValueRange = [极端悲观, 极端乐观]', r.fairValueRange[0] === sumRow.low && r.fairValueRange[1] === sumRow.high);
ok('fairValueCenter = 基准中枢', r.fairValueCenter === sumRow.mid);
ok('敏感性表保留历史分位原值并标注失真', (() => {
  const s10 = (r.sensRows || []).find(x => String(x.label).indexOf('PB 10%分位') === 0);
  return !!s10 && s10.value === 5.3 && String(s10.label).indexOf('已失真') !== -1;
})());
ok('敏感性表补充补丁F修正边界两行', (r.sensRows || []).filter(x => String(x.label).indexOf('补丁F·') === 0).length === 2);

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
