'use strict';
/**
 * scripts/test_strategy_nl.js — 「大白话中文 → 回测 DSL」确定性翻译器单测
 * 覆盖：均线/MACD/RSI/布林带/收益率z-score 的常见中文写法；不支持的玩法如实拒绝；
 *       同一句话结果可复现（确定性）；翻译产物能被 evaluateCondition 求值；
 *       与 validateStrategy 端到端接线（网络受限则跳过）。
 */
const nl = require('../lib/strategyNL');
const bv = require('../lib/backtestValidator');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra != null ? '  → ' + extra : '')); }
}
function tr(t) { return nl.translate(t); }

console.log('===== 1) 均线（金叉/死叉，两条均线）=====');
{
  const r = tr('5日均线上穿20日均线买入，5日均线下穿20日均线卖出');
  ok('ok=true', r.ok === true);
  ok('buy=CROSS_UP(MA5,MA20)', r.ok && r.dsl.buy === 'CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))', r.ok && r.dsl.buy);
  ok('sell=CROSS_DOWN(MA5,MA20)', r.ok && r.dsl.sell === 'CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))', r.ok && r.dsl.sell);
}
{
  const r = tr('当5日均线上穿10日均线时买入，当5日均线下穿10日均线时卖出');
  ok('含「当…时」也能解析', r.ok && /MA\(CLOSE,5\)/.test(r.dsl.buy) && /MA\(CLOSE,10\)/.test(r.dsl.buy), r.ok && r.dsl.buy);
}
{
  const r = tr('价格上穿5日均线买入，价格下穿5日均线卖出');
  ok('价格 vs 单均线 → CROSS_UP(CLOSE,MA5)', r.ok && r.dsl.buy === 'CROSS_UP(CLOSE, MA(CLOSE,5))', r.ok && r.dsl.buy);
  ok('价格 vs 单均线 → CROSS_DOWN(CLOSE,MA5)', r.ok && r.dsl.sell === 'CROSS_DOWN(CLOSE, MA(CLOSE,5))', r.ok && r.dsl.sell);
}

console.log('\n===== 2) MACD =====');
{
  const r = tr('MACD金叉买入，MACD死叉卖出');
  ok('buy=CROSS_UP(DIF,DEA)', r.ok && r.dsl.buy === 'CROSS_UP(MACD_DIF(CLOSE), MACD_DEA(CLOSE))', r.ok && r.dsl.buy);
  ok('sell=CROSS_DOWN(DIF,DEA)', r.ok && r.dsl.sell === 'CROSS_DOWN(MACD_DIF(CLOSE), MACD_DEA(CLOSE))', r.ok && r.dsl.sell);
}

console.log('\n===== 3) RSI =====');
{
  const r = tr('RSI低于30买入，RSI高于70卖出');
  ok('buy=RSI(14)<30', r.ok && r.dsl.buy === 'RSI(CLOSE,14) < 30', r.ok && r.dsl.buy);
  ok('sell=RSI(14)>70', r.ok && r.dsl.sell === 'RSI(CLOSE,14) > 70', r.ok && r.dsl.sell);
}
{
  const r = tr('RSI超卖买入，RSI超买卖出');
  ok('超卖→<30 / 超买→>70', r.ok && r.dsl.buy === 'RSI(CLOSE,14) < 30' && r.dsl.sell === 'RSI(CLOSE,14) > 70', r.ok && JSON.stringify(r.dsl));
}

console.log('\n===== 4) 布林带 =====');
{
  const r = tr('价格跌破布林带下轨买入，价格涨破布林带中轨卖出');
  ok('buy=CLOSE<BOLL_LOWER', r.ok && r.dsl.buy === 'CLOSE < BOLL_LOWER(CLOSE,20,2)', r.ok && r.dsl.buy);
  ok('sell=CLOSE>BOLL_MID', r.ok && r.dsl.sell === 'CLOSE > BOLL_MID(CLOSE,20,2)', r.ok && r.dsl.sell);
}

console.log('\n===== 5) 收益率 z-score =====');
{
  const r = tr('收益率z-score低于-1.5买入，高于1.5卖出');
  ok('buy=ZSCORE(RET(CLOSE),20)<-1.5', r.ok && r.dsl.buy === 'ZSCORE(RET(CLOSE),20) < -1.5', r.ok && r.dsl.buy);
  ok('sell=ZSCORE(RET(CLOSE),20)>1.5', r.ok && r.dsl.sell === 'ZSCORE(RET(CLOSE),20) > 1.5', r.ok && r.dsl.sell);
}

console.log('\n===== 6) 引擎不支持的玩法：如实拒绝（不猜）=====');
{
  const r = tr('按照pe历史百分位进行操作，低于50%可进行买入，每降低5%买入一成仓位，高于50%，每升高5%卖出一层仓位。');
  ok('ok=false', r.ok === false);
  ok('reason=unsupported', r.reason === 'unsupported', r.reason);
  ok('指出 估值百分位', (r.unsupported || []).some(s => /估值/.test(s)), JSON.stringify(r.unsupported));
  ok('指出 分批加减仓', (r.unsupported || []).some(s => /仓位/.test(s)), JSON.stringify(r.unsupported));
}

console.log('\n===== 7) 只写一半（缺买卖方向）→ incomplete =====');
{
  const r = tr('5日均线上穿20日均线');
  ok('ok=false', r.ok === false);
  ok('reason=incomplete', r.reason === 'incomplete', r.reason);
}

console.log('\n===== 8) 确定性：同一句话两次结果完全一致 =====');
{
  const t = 'MACD金叉买入，MACD死叉卖出';
  const a = JSON.stringify(tr(t)); const b = JSON.stringify(tr(t));
  ok('两次结果 JSON 完全相同', a === b);
}

console.log('\n===== 9) 翻译产物可被 evaluateCondition 求值 =====');
{
  const n = 120;
  const close = Array.from({ length: n }, (_, i) => 10 + Math.sin(i / 7) * 2 + i * 0.02);
  const ctx = { close, open: close, high: close.map(v => v + 0.1), low: close.map(v => v - 0.1), volume: close.map(() => 1000) };
  const samples = [
    '5日均线上穿20日均线买入，5日均线下穿20日均线卖出',
    'MACD金叉买入，MACD死叉卖出',
    'RSI低于30买入，RSI高于70卖出',
    '价格跌破布林带下轨买入，价格涨破布林带中轨卖出',
    '收益率z-score低于-1.5买入，高于1.5卖出'
  ];
  let allOk = true;
  for (const s of samples) {
    const r = tr(s);
    try {
      const bs = bv.evaluateCondition(r.dsl.buy, ctx);
      const ss = bv.evaluateCondition(r.dsl.sell, ctx);
      if (!Array.isArray(bs) || !Array.isArray(ss) || typeof bs[0] !== 'boolean') allOk = false;
    } catch (e) { allOk = false; console.log('    ⚠ 求值失败: ' + s + ' → ' + e.message); }
  }
  ok('5 类中文策略翻译后均可求值为布尔序列', allOk);
}

console.log('\n===== 10) 端到端：validateStrategy 接受中文（网络受限则跳过）=====');
(async () => {
  try {
    const out = await bv.validateStrategy({ symbol: '600519', name: '贵州茅台', dsl: '5日均线上穿20日均线买入，5日均线下穿20日均线卖出' });
    ok('base_info.derived_from=natural_language', out.base_info.derived_from === 'natural_language', out.base_info.derived_from);
    ok('base_info.derived_buy 非空', !!out.base_info.derived_buy, out.base_info.derived_buy);
    ok('返回了胜率结论', out.operation_suggestion && typeof out.operation_suggestion.verdict === 'string');
  } catch (e) {
    console.log('  ⏭ 跳过（网络/取数失败）：' + e.message);
  }
  console.log('\n==== 测试结果：' + pass + ' 通过 / ' + fail + ' 失败 ====');
  process.exit(fail ? 1 : 0);
})();
