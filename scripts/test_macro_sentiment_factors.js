// 20260922k 验证：宏观情绪因子「走势相悖 → 权重自动归 0」机制真实生效
// 背景：卡片文案承诺「若…相悖，本因子权重自动归 0」，但旧实现里
//   (a) macroSentimentFactors 的 observedIndex 未持久化 → 相悖判定被永久跳过；
//   (b) marketEmotionModel.calcMacro 只看 signal、不看 status → 即便休眠也回落默认 5%。
// 运行：node scripts/test_macro_sentiment_factors.js
const mf = require('../lib/macroSentimentFactors');
const mem = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
const BASE = mf.BASE_WEIGHT; // 0.5

// 真实上证日K（2026-09 一段，升序）
const bars = [
  { date: '2026-09-11', close: 3888.11 },
  { date: '2026-09-14', close: 3885.33 },
  { date: '2026-09-15', close: 3864.28 },
  { date: '2026-09-16', close: 3891.6 },
  { date: '2026-09-17', close: 3875.6 },
  { date: '2026-09-18', close: 3911.87 },
  { date: '2026-09-21', close: 3949.91 },
  { date: '2026-09-22', close: 3952.13 },
];

console.log('===== 1) 依赖：事件日解析 / 基准点位查找 =====');
ok('eventDate 从 dateZh 解析出 YYYY-MM-DD', mf.eventDate({ dateZh: '2026-09-17 凌晨 02:00（北京时间）' }) === '2026-09-17', mf.eventDate({ dateZh: '2026-09-17 凌晨 02:00（北京时间）' }));
ok('eventDate 无日期返回 null', mf.eventDate({ title: 'x' }) === null);
ok('closeOnOrBefore 取「不晚于事件日」的最近收盘（09-17 = 3875.6）', mf.closeOnOrBefore(bars, '2026-09-17') === 3875.6, mf.closeOnOrBefore(bars, '2026-09-17'));
ok('closeOnOrBefore 事件日晚于全部K线 → 返回最后一根', mf.closeOnOrBefore(bars, '2026-12-31') === 3952.13);
ok('closeOnOrBefore 空日期返回 null', mf.closeOnOrBefore(bars, null) === null);

console.log('\n===== 2) 状态机：新触发 → 激活 + 锚定 =====');
// 新触发且方向一致（signal=+1 偏多、指数较锚上行）→ 保持激活
const fresh = mf.stepFactor({ status: 'dormant', weight: 0 }, 'evt-A', 1, 3952.13, 3875.6);
ok('新触发(方向一致) → status=active', fresh.status === 'active', fresh.status);
ok('新触发(方向一致) → 权重 = BASE(0.5)', fresh.weight === BASE, fresh.weight);
ok('新触发 → 锚点用事件日收盘(3875.6)', fresh.observedIndex === 3875.6, fresh.observedIndex);
// 新触发且方向相悖（signal=-1 偏空、指数较锚上行）→ 同日即归零休眠
const freshContra = mf.stepFactor({ status: 'dormant', weight: 0 }, 'evt-A', -1, 3952.13, 3875.6);
ok('新触发(方向相悖) → 同日即归零休眠', freshContra.status === 'dormant' && freshContra.weight === 0, { s: freshContra.status, w: freshContra.weight });

console.log('\n===== 3) 相悖 / 同向 判定 =====');
// 信号偏空(-1)，锚 3875.6，现 3952.13（涨）→ 相悖 → 归零
const contra = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'evt-A', observedIndex: 3875.6 }, 'evt-A', -1, 3952.13, 3875.6);
ok('偏空预测 + 指数上行 → 相悖归零', contra.status === 'dormant' && contra.weight === 0, { s: contra.status, w: contra.weight });
// 信号偏空(-1)，锚 3952.13，现 3875.6（跌）→ 同向 → 保持
const agree = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'evt-A', observedIndex: 3952.13 }, 'evt-A', -1, 3875.6, 3952.13);
ok('偏空预测 + 指数下行 → 同向 → 保持 0.5', agree.status === 'active' && agree.weight === BASE, { s: agree.status, w: agree.weight });
// 信号偏多(+1)，指数下跌 → 相悖
const contra2 = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'evt-B', observedIndex: 3952.13 }, 'evt-B', 1, 3800, 3952.13);
ok('偏多预测 + 指数下行 → 相悖归零', contra2.status === 'dormant' && contra2.weight === 0);
// 中性信号(0) 永不相悖
const neutral = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'dom', observedIndex: 3952.13 }, 'dom', 0, 4000, 3952.13);
ok('中性信号(0) + 指数任意方向 → 不归零', neutral.status === 'active' && neutral.weight === BASE);

console.log('\n===== 4) 自愈：旧快照缺 observedIndex（本次 bug 的核心）=====');
const healed = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'evt-A', signal: -1 /* 无 observedIndex */ }, 'evt-A', -1, 3952.13, 3875.6);
ok('旧快照缺锚 + 提供事件日锚 → 补锚后判定相悖 → 归零', healed.status === 'dormant' && healed.weight === 0, { s: healed.status, w: healed.weight, obs: healed.observedIndex });
const healed2 = mf.stepFactor({ status: 'active', weight: BASE, lastKey: 'dom' /* 无锚且无事件日锚 */ }, 'dom', 0, 3952.13, null);
ok('无锚且无事件锚 → 用现价补锚（下次可判定）', healed2.observedIndex === 3952.13, healed2.observedIndex);

console.log('\n===== 5) 新触发键 → 休眠可复活 =====');
const revive = mf.stepFactor({ status: 'dormant', weight: 0, lastKey: 'evt-A', observedIndex: 3875.6 }, 'evt-B', 1, 3952.13, 3900);
ok('触发键变化 → 重新激活、权重回到 BASE', revive.status === 'active' && revive.weight === BASE, { s: revive.status, w: revive.weight });

console.log('\n===== 6) 展示文案随状态变化（杜绝「写着归零却仍 5%」）=====');
ok('国内·休眠文案含「自动归 0」', /自动归 0/.test(mf.domRuleText('dormant', -1)));
ok('国内·激活且非零文案含「当前处于激活状态」并说明归零条件', /当前处于激活状态/.test(mf.domRuleText('active', -1)) && /自动归 0/.test(mf.domRuleText('active', -1)));
ok('国内·中性(0) 文案不再承诺归零、改为「无明确方向」', /无明确方向/.test(mf.domRuleText('active', 0)) && !/自动归 0/.test(mf.domRuleText('active', 0)));
ok('美国·休眠文案含「不跌反涨…自动归 0」', /自动归 0/.test(mf.usRuleText('dormant', -1)));

console.log('\n===== 7) calcMacro 必须尊重 dormant（休眠 → 未激活 → 权重 0）=====');
const cmDormant = mem.calcMacro({ key: 'US_MACRO', signal: -1, status: 'dormant', weight: 0, interpretation: 'x' });
ok('休眠因子 → active=false（权重将被置 0）', cmDormant.active === false, cmDormant);
ok('休眠因子 → score 归 0', cmDormant.score === 0, cmDormant.score);
ok('休眠因子 → 展示「休眠」', /休眠/.test(cmDormant.value), cmDormant.value);
const cmActive = mem.calcMacro({ key: 'US_MACRO', signal: -1, status: 'active', weight: 0.5, interpretation: 'x' });
ok('激活因子 → active=true、score=-1、偏空', cmActive.active === true && cmActive.score === -1 && cmActive.value === '偏空', cmActive);
const cmNone = mem.calcMacro(undefined);
ok('缺失因子 → active=false、未激活', cmNone.active === false && /未激活/.test(cmNone.value), cmNone);

console.log(`\n[test_macro_sentiment_factors] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
