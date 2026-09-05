const { extractEarningsSignal } = require('../lib/aiAugment');

const tests = [
  { name: '旧缓存·实质弱(关键词兜底)', text: '综合结论：表观稳、实质弱，核心利润增速放缓，现金流大幅下滑，Q2环比恶化，边际趋势拐头向下' },
  { name: '结构化行 -2', text: '综合信号：-2\n综合结论：表观稳、实质弱，边际向下' },
  { name: '结构化行 +3', text: '综合信号：+3\n综合结论：超预期改善' },
  { name: '结构化行 -1', text: '综合信号：-1' },
  { name: '利好关键词', text: '综合结论：超预期改善，营收加速向好，拐点向上' },
  { name: '中性', text: '综合结论：稳健增长' },
  { name: '结构化优先于正文', text: '综合信号：-2\n综合结论：稳健增长，但实质承压向下' },
];

for (const t of tests) {
  const s = extractEarningsSignal(t.text);
  const dir = s > 0.15 ? '利好(红)' : s < -0.15 ? '利空(绿)' : '中性';
  const impact = Math.max(-3, Math.min(3, Math.round(s * 3)));
  console.log(`${t.name} => signal=${s.toFixed(3)} | ${dir} | 影响 ${impact >= 0 ? '+' : ''}${impact}`);
}
