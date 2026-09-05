const { getMarketTechnical } = require('../lib/marketTechnical');

(async () => {
  const t0 = Date.now();
  const res = await getMarketTechnical({ force: true });
  console.log('耗时(ms):', Date.now() - t0);
  console.log('date:', res.date, '| success:', res.success);
  console.log('=== 跨指数综合 ===');
  console.log(res.synthesis);
  for (const x of res.indices) {
    if (x.error) { console.log(`\n[${x.name}] 错误: ${x.error}`); continue; }
    console.log(`\n========== ${x.name}  收盘 ${x.lastClose} (${x.changePct}%)  数据日 ${x.date} ==========`);
    console.log('①趋势定性:', x.step1.arrangement, '| ADX=', x.step1.adx, x.step1.adxState, '| 结论=', x.step1.trendLabel,
      '| +DI/-DI=', x.step1.plusDI, '/', x.step1.minusDI);
    console.log('②形态识别:', x.step2.structure, '| 月线', x.step2.monthDir, '周线', x.step2.weekDir,
      '| 形态=', x.step2.pattern.name || '无', x.step2.pattern.note);
    console.log('③量价验证:', x.step3.volState, '| 健康=', x.step3.health, '| 今日量', x.step3.lastVol, '5/20日均', x.step3.avg5, '/', x.step3.avg20,
      '| 缩量新高背离=', x.step3.divergence);
    console.log('④指标共振:', x.step4.resonance, `(看多${x.step4.bull}/看空${x.step4.bear})`, JSON.stringify(x.step4.detail),
      '| RSI', x.step4.values.rsi, 'KDJ', x.step4.values.k + '/' + x.step4.values.d, 'MACD柱', x.step4.values.hist);
    console.log('⑤周期共振:', x.step5.conclusion, '| 月', x.step5.monthDir, '周', x.step5.weekDir, '日', x.step5.dayDir, '30分', x.step5.m30Dir, '| 策略:', x.step5.strategy);
    console.log('⑥综合预判:');
    console.log('  中期:', x.step6.midTerm.direction, '| 支撑', x.step6.midTerm.support, '压力', x.step6.midTerm.pressure);
    console.log('  短期:', x.step6.shortTerm.direction, '| 支撑', x.step6.shortTerm.support, '压力', x.step6.shortTerm.pressure);
    console.log('  仓位:', x.step6.strategy.position, '| 动作:', x.step6.strategy.action);
    console.log('  观测:', x.step6.strategy.watch);
    console.log('  风险:', x.step6.risk);
    if (x.issues) console.log('  数据提示:', x.issues.join(','));
  }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
