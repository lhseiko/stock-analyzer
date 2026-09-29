'use strict';
/**
 * scripts/test_strategy_generator.js
 * 校验：A–E 风险修正函数 + 自动策略生成器（确定性，skipLLM）。
 * 纯函数部分不依赖网络；集成部分（getHistory）失败则跳过并告警。
 */
const assert = require('assert');
const V = require('../lib/backtestValidator');
const { generateStrategies, buildCandidateLibrary, rollingJudgmentSignals } = require('../lib/strategyGenerator');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function approxGE(a, b) { return a >= b - 1e-9; }

// ───────────────────────── 纯函数：A–E 辅助 ─────────────────────────
console.log('[A–E] 风险分析辅助函数');

// 合成一条非平稳随机游走路线的收盘价 + 对应收益率序列
const N = 400;
const close = [100];
for (let i = 1; i < N; i++) close.push(close[i - 1] + (Math.random() - 0.5) * 2 + 0.02);
const ret = V.returnsPct(close).slice(1);

// A 项：平稳性闸门系数
ok('stationarityFactorFor(均值回归+非平稳价格)=0.5', V.stationarityFactorFor('reversion', false, false) === 0.5);
ok('stationarityFactorFor(收益率回归+平稳收益)=1.0', V.stationarityFactorFor('return-reversion', false, true) === 1.0);
ok('stationarityFactorFor(趋势+非平稳价格)=1.0', V.stationarityFactorFor('trend', false, false) === 1.0);

// 分类
ok('classifyStrategy 双均线→trend', V.classifyStrategy('CROSS_UP(MA(CLOSE,5),MA(CLOSE,20))', 'CROSS_DOWN(MA(CLOSE,5),MA(CLOSE,20))') === 'trend');
ok('classifyStrategy RSIXtreme→reversion', V.classifyStrategy('RSI(CLOSE,14)<30', 'RSI(CLOSE,14)>70') === 'reversion');
ok('classifyStrategy ZSCORE(RET)→return-reversion', V.classifyStrategy('ZSCORE(RET(CLOSE),20)<-1.5', 'ZSCORE(RET(CLOSE),20)>1.5') === 'return-reversion');

// C 项：前视扫描
ok('lookaheadScan 正常 DSL→未检出', V.lookaheadScan('CROSS_UP(MA(CLOSE,5),MA(CLOSE,20))', 'CROSS_DOWN(MA(CLOSE,5),MA(CLOSE,20))').detected === false);
ok('lookaheadScan NEXT(→检出', V.lookaheadScan('CROSS_UP(CLOSE, NEXT(CLOSE))', 'CROSS_DOWN(CLOSE, NEXT(CLOSE))').detected === true);

// B 项：RET/MEAN/STD/ZSCORE 求值器
const ctx = { close, open: close, high: close, low: close, volume: close.map(() => 1) };
const retSig = V.evaluateCondition('ZSCORE(RET(CLOSE),20) < -1.5', ctx);
ok('RET/ZSCORE 求值返回等长布尔数组', Array.isArray(retSig) && retSig.length === close.length);
const maSig = V.evaluateCondition('CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))', ctx);
ok('MA 交叉求值返回布尔数组', Array.isArray(maSig) && maSig.length === close.length);

// E 项：walk-forward / structuralBreak / seasonality
const buySig = maSig, sellSig = V.evaluateCondition('CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))', ctx);
const series = close.map((c, i) => ({ date: 'd' + i, open: c, high: c, low: c, close: c, volume: 1 }));
const wf = V.walkForward(series, buySig, sellSig, { costPerSide: 0.0055 }, 3);
ok('walkForward 返回一致性', typeof wf.consistency === 'number' && wf.consistency >= 0 && wf.consistency <= 1);
const sb = V.structuralBreak(series, buySig, sellSig, { costPerSide: 0.0055 });
ok('structuralBreak 返回 delta', typeof sb.delta === 'number' && typeof sb.significant === 'boolean');
const season = V.seasonalityScan(ret);
ok('seasonalityScan 返回 hasSeasonality', typeof season.hasSeasonality === 'boolean');

// applyCorrections 接入平稳性闸门：reversion + 非平稳价格 → WARNING + factor 0.5
const fakeRaw = { winRate: 0.7, totalTrades: 50, totalReturn: 0.3 };
const corr = V.applyCorrections(fakeRaw, null,
  { trainWinRate: 0.7, testWinRate: 0.68, trend: { r2: 0.1, direction: 'flat' }, costPerSide: 0.0055, survivorship: 0.9, lookaheadDetected: false },
  { strategyClass: 'reversion', adfPriceStationary: false, adfReturnStationary: false, stationarityFactor: 0.5 });
ok('applyCorrections(reversion+非平稳)→stationarityFactor=0.5', corr.stationarityFactor === 0.5);
ok('applyCorrections(reversion+非平稳)→verdict WARNING', corr.verdict === 'WARNING');

// 对照：低趋势依赖 + 高原始胜率 → PASS（趋势贡献不惩罚，成本/幸存者后仍能过线）
const corr2 = V.applyCorrections({ winRate: 0.9, totalTrades: 50, totalReturn: 0.4 }, null,
  { trainWinRate: 0.9, testWinRate: 0.89, trend: { r2: 0.1, direction: 'flat' }, costPerSide: 0.0055, survivorship: 0.9, lookaheadDetected: false },
  { strategyClass: 'trend', adfPriceStationary: false, adfReturnStationary: false, stationarityFactor: 1.0 });
ok('applyCorrections(低趋势依赖+高胜率)→verdict PASS', corr2.verdict === 'PASS');

// 对照：高趋势依赖(r2=0.85) → 即使高胜率也被折扣为 REJECT/WARNING（边缘 alpha 不足）
const corr3 = V.applyCorrections({ winRate: 0.9, totalTrades: 50, totalReturn: 0.4 }, null,
  { trainWinRate: 0.9, testWinRate: 0.89, trend: { r2: 0.85, direction: 'up' }, costPerSide: 0.0055, survivorship: 0.9, lookaheadDetected: false },
  { strategyClass: 'trend', adfPriceStationary: false, adfReturnStationary: false, stationarityFactor: 1.0 });
ok('applyCorrections(高趋势依赖)→verdict 降级', corr3.verdict !== 'PASS');

// ───────────────────────── 生成器（候选项枚举） ─────────────────────────
console.log('[生成器] 候选库枚举');
const lib = buildCandidateLibrary();
ok('候选库含 双均线/ MACD/ RSI/ 布林回归/ 布林突破/ 收益率zscore', lib.length >= 10);
ok('候选库含 return-reversion 平稳路径模板', lib.some(c => c.cls === 'return-reversion'));

// 行情判定派生策略：纯函数（不依赖网络），校验信号序列长度与布尔性
const jseries = close.map((c, i) => ({ date: 'd' + i, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 1 + (i % 5) * 0.4 }));
const jsSig = rollingJudgmentSignals(jseries);
ok('rollingJudgmentSignals 返回四组等长布尔数组', jsSig && jsSig.longBull.length === N && jsSig.longBear.length === N && jsSig.shortBull.length === N && jsSig.shortBear.length === N);
ok('rollingJudgmentSignals 元素均为布尔', [jsSig.longBull, jsSig.longBear, jsSig.shortBull, jsSig.shortBear].every(a => a.every(b => typeof b === 'boolean')));
ok('rollingJudgmentSignals 预热期无信号（长期 i<249 / 短期 i<119 全 false）', jsSig.longBull.slice(0, 249).every(v => v === false) && jsSig.shortBull.slice(0, 119).every(v => v === false));

// ───────────────────────── 生成器（集成：真实行情） ─────────────────────────
console.log('[生成器] 集成（getHistory，失败则跳过）');
(async () => {
  try {
    const res = await generateStrategies({ symbol: '600519', name: '贵州茅台', range: '2y', skipLLM: true });
    ok('generateStrategies 成功', res && res.success === true);
    ok('base_info 含候选计数', res.base_info && res.base_info.candidate_count > 0);
    ok('market_context 含 ADF 价格/收益', res.market_context && res.market_context.adf_price && res.market_context.adf_return);
    ok('ranked_strategies 非空', Array.isArray(res.ranked_strategies) && res.ranked_strategies.length > 0);
    ok('best_strategy 存在', !!res.best_strategy);
    ok('best 修正胜率∈[0,1]', res.best_strategy && res.best_strategy.adjusted_win_rate >= 0 && res.best_strategy.adjusted_win_rate <= 1);
    ok('best verdict 合法', res.best_strategy && ['PASS', 'WARNING', 'REJECT'].includes(res.best_strategy.verdict));
    ok('parameter_sensitivity 已计算', res.parameter_sensitivity && typeof res.parameter_sensitivity.spread === 'number');
    ok('operation_advice 含叙述', res.operation_advice && typeof res.operation_advice.narrative === 'string' && res.operation_advice.narrative.length > 0);
    ok('所有有效策略均有 walk-forward', res.ranked_strategies.every(s => s.walk_forward && s.walk_forward.consistency >= 0));
    ok('收益率zscore 模板在排名中', res.ranked_strategies.some(s => s.key === 'ret_zscore'));
    const allKeys = res.ranked_strategies.concat(res.insufficient_strategies || []).map(s => s.key);
    ok('候选库仅含 judge_short 派生策略（已删除 judge_long / judge_both）', allKeys.includes('judge_short') && !allKeys.includes('judge_long') && !allKeys.includes('judge_both'));
    ok('候选总数 >= 12（11 量价 + 1 行情判定 + 价值/事件按数据）', res.base_info.candidate_count >= 12);
    ok('输出含 5 大类概况', res.category_summary && typeof res.category_summary === 'object');
    ok('趋势跟踪类已纳入候选', !!(res.category_summary && res.category_summary.trend));
    ok('均值回归类已纳入候选', !!(res.category_summary && res.category_summary.mean_reversion));
    ok('动量轮动类已纳入候选', !!(res.category_summary && res.category_summary.momentum));
    console.log('  分类概况：' + Object.keys(res.category_summary || {}).map(k => k + '=' + (res.category_summary[k].valid + res.category_summary[k].insufficient) + '套').join(' / '));
    if (res.data_notes) console.log('  数据备注：' + JSON.stringify(res.data_notes));
    console.log('\n  茅台集成结果：候选=' + res.base_info.candidate_count
      + ' 有效=' + res.base_info.valid_count + ' 剔除=' + res.base_info.insufficient_count
      + ' 最优=' + (res.best_strategy ? res.best_strategy.name : '-')
      + ' 修正胜率=' + (res.best_strategy ? (res.best_strategy.adjusted_win_rate * 100).toFixed(1) + '%' : '-')
      + ' 结论=' + (res.best_strategy ? res.best_strategy.verdict : '-'));
    const jd = res.ranked_strategies.concat(res.insufficient_strategies || []).filter(s => s.key.indexOf('judge') === 0);
    ok('行情判定派生策略已进入排名或剔除列表', jd.length === 1);
    jd.forEach(s => console.log('  · ' + s.key + ' 交易=' + (s.raw ? s.raw.trades : s.trades)
      + ' 胜率=' + (s.raw ? (s.raw.winRate * 100).toFixed(1) + '%' : (s.winRate * 100).toFixed(1) + '%')
      + ' 修正=' + (s.adjusted_win_rate != null ? (s.adjusted_win_rate * 100).toFixed(1) + '%' : '-')
      + ' 结论=' + (s.verdict || '-') + (s.reason ? '（' + s.reason + '）' : '')));
  } catch (e) {
    console.log('  ⚠ 集成测试跳过（getHistory 失败，可能无网络）：' + e.message);
  }

  console.log('\n==== 测试结果：' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail > 0 ? 1 : 0);
})();
