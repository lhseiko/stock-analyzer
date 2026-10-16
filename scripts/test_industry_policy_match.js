/**
 * 行业政策库 / 行业名归一化 · 最长优先匹配回归（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_industry_policy_match.js
 * 覆盖：20261016b 修复的 IA1/IA2「顺序 includes 第一命中」偏置 bug——
 *       1) getPolicySupport：'电力设备' 不再被 '电力' 抢先，'新能源汽车' 不再被 '新能源' 抢先；
 *       2) normalizeIndustryName（上游）：'新能源汽车' 不再被归一为 '新能源'
 *          （只改下游救不回来，故两处同改、本测试双覆盖）；
 *       3) 回归：既有行业（银行/房地产/白酒/消费电子）判定不变；返回结构保持 4 字段。
 * 说明：确定性纯函数，不联网、不依赖服务。
 */
const { getPolicySupport } = require('../lib/industryAnalysis');
const { normalizeIndustryName } = require('../lib/sectorIdentity');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

console.log('[1] IA1：电力设备 应命中「国家战略扶持」（旧实现被「电力」抢先落「中性（周期）」）');
{
  const r = getPolicySupport('电力设备', '电气设备');
  ok(r && r.matched === true, `matched = true（实际 ${r && r.matched}）`);
  ok(r && String(r.level).includes('国家战略扶持'), `level 含 国家战略扶持（实际 ${r && r.level}）`);
  ok(r && String(r.summary || '').includes('电力设备'), `summary 为电力设备口径（实际首句 ${String((r && r.summary) || '').slice(0, 12)}…）`);
}

console.log('\n[2] IA2：新能源汽车 应命中新能源车口径（旧实现被「新能源」抢先，summary 口径偏）');
{
  const r = getPolicySupport('新能源汽车', '整车');
  ok(r && r.matched === true, `matched = true（实际 ${r && r.matched}）`);
  ok(r && String(r.level).includes('国家战略扶持'), `level 含 国家战略扶持（实际 ${r && r.level}）`);
  ok(r && String(r.summary || '').includes('新能源车'), `summary 为新能源车口径（实际首句 ${String((r && r.summary) || '').slice(0, 12)}…）`);
}

console.log('\n[3] 上游：normalizeIndustryName 不再把「新能源汽车」吞成「新能源」');
{
  const a = normalizeIndustryName('新能源汽车');
  ok(a === '新能源汽车', `新能源汽车 → ${a}（期望 新能源汽车）`);
  const b = normalizeIndustryName('电力设备');
  ok(b === '电力设备', `电力设备 → ${b}（期望 电力设备）`);
}

console.log('\n[4] 回归：既有行业判定不受影响');
{
  const bank = getPolicySupport('银行', '');
  ok(bank && String(bank.level).includes('中性（强监管）'), `银行 → ${bank && bank.level}`);
  const re = getPolicySupport('房地产', '');
  ok(re && String(re.level).includes('受限（托底）'), `房地产 → ${re && re.level}`);
  const semi = getPolicySupport('半导体', '集成电路');
  ok(semi && String(semi.level).includes('国家战略扶持'), `半导体 → ${semi && semi.level}`);
  ok(normalizeIndustryName('白酒') === '食品饮料', `白酒 归一 → ${normalizeIndustryName('白酒')}（期望 食品饮料）`);
  ok(normalizeIndustryName('消费电子') === '电子', `消费电子 归一 → ${normalizeIndustryName('消费电子')}（期望 电子，避免被「消费」捕获）`);
}

console.log('\n[5] 兜底与返回结构：未命中仍返回 4 字段，结构未漂移');
{
  const miss = getPolicySupport('某个未收录行业XYZ', '');
  ok(miss && miss.matched === false, `未命中 matched = false（实际 ${miss && miss.matched}）`);
  ok(miss && String(miss.level).includes('中性（需结合具体政策判断）'), `兜底 level 正确（实际 ${miss && miss.level}）`);
  const keys = Object.keys(miss || {}).sort().join(',');
  ok(keys === 'level,matched,plans,summary', `返回字段 = level,matched,plans,summary（实际 ${keys}）`);
  ok(normalizeIndustryName('') === '', '空输入返回空字符串');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
