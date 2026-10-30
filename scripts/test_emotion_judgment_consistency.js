/**
 * 「首页情绪 vs 个股大盘因子」一致性回归（20261024g）
 * ---------------------------------------------------------------------------
 * 运行： node scripts/test_emotion_judgment_consistency.js
 *
 * 用户报障（2026-10-24 14:00 截图）：
 *   首页「市场情绪提醒」= 情绪总分 0.009（中性）· 放量（量比 1.24）· 量价齐升；
 *   个股士兰微「大盘」因子 = 市场情绪提醒 看跌·预警 · 情绪总分 -0.317 · 平量。
 *   同一句「引用首页判断（2026-10-24）」，数值却相反 → 违反单源一致性铁律。
 *
 * 根因：个股判断在生成时把当日情绪总分**烘死**进 factors[sentiment].subFactors[市场情绪提醒].signal；
 *   之后首页情绪被重算（-0.317 → 0.009），判断缓存仍按 targetDate 复用，未感知情绪已变。
 * 修复：复用前比对「烘焙的情绪信号」与「当前最新情绪记录」，不一致 → 强制重算。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sdj = require('../lib/sameDayJudgment');
const mem = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  ✓', msg); } else { fail++; console.log('  ✗', msg); } }

function recWith(signal) {
  return { factors: [{ key: 'sentiment', name: '大盘', subFactors: [{ name: '市场情绪提醒', signal }] }] };
}

// ============================================================================
console.log('\n[1] _findEmotionSubSignal 从判断记录里取出烘焙的情绪信号');
{
  ok(sdj._findEmotionSubSignal(recWith(-0.317)) === -0.317, '取出 市场情绪提醒.signal = -0.317');
  ok(sdj._findEmotionSubSignal({ factors: [{ key: 'sentiment', subFactors: [{ name: '大盘短期走势', signal: 0 }] }] }) === null, '无「市场情绪提醒」子因子 → null');
  ok(sdj._findEmotionSubSignal({}) === null, '空记录 → null');
  ok(sdj._findEmotionSubSignal(recWith(0)) === 0, 'signal=0 属于有效值（不当作 null）');
}

// ============================================================================
console.log('\n[2] _emotionSubStale：引用信号变化即判过期（核心复现用户场景；20261028c 起比对口径=_emotionQuoteSig）');
{
  const orig = mem.readLatestJudgment;
  const rec = recWith(-0.317);

  mem.readLatestJudgment = () => ({ score: 0.009, tendency: '中性', tendencyKey: 'neutral' });
  ok(sdj._emotionSubStale(rec) === true, '烘焙 -0.317 vs 当前中性(0.009→信号0) → 过期=true（需重算）');

  mem.readLatestJudgment = () => ({ score: -0.317, tendency: '看跌', tendencyKey: 'bear' });
  ok(sdj._emotionSubStale(rec) === false, '烘焙 -0.317 vs 当前看跌(-0.317) → 未变=false（可复用）');

  mem.readLatestJudgment = () => ({ score: -0.31700001, tendency: '看跌', tendencyKey: 'bear' });
  ok(sdj._emotionSubStale(rec) === false, '浮点抖动（<0.0005）→ 未变=false（不误重算）');

  // 20261028c 关键回归：中性场景烘焙 0 vs 当前中性 → 不误判过期（否则每次请求都强制重算）
  const recNeutral = recWith(0);
  mem.readLatestJudgment = () => ({ score: -0.04, tendency: '中性', tendencyKey: 'neutral' });
  ok(sdj._emotionSubStale(recNeutral) === false, '烘焙 0（中性）vs 当前中性(-0.04→信号0) → 未变=false（不误重算）');

  mem.readLatestJudgment = () => null;
  ok(sdj._emotionSubStale(rec) === false, '当前情绪不可得 → false（交回原逻辑按中性处理）');

  mem.readLatestJudgment = () => ({ score: 1.4, tendency: '看涨', tendencyKey: 'bull' });
  ok(sdj._emotionSubStale(recWith(1)) === false, '当前分 clamp 到 1，与烘焙 1 一致 → false');

  ok(sdj._emotionSubStale(recWith(null)) === false, '记录无情绪子因子 → false（不额外判）');

  mem.readLatestJudgment = orig;
}

// ============================================================================
console.log('\n[3] 真实数据端到端：600460 缓存判断(11:35) vs 最新情绪记录');
{
  const jf = path.join(__dirname, '..', 'data', 'judgments', '2026-10-26.json');
  const rf = path.join(__dirname, '..', 'data', 'market-emotion', 'records.json');
  if (fs.existsSync(jf) && fs.existsSync(rf)) {
    const arr = JSON.parse(fs.readFileSync(jf, 'utf8'));
    const rec = arr.find(x => String(x.symbol || '').includes('600460'));
    const emo = JSON.parse(fs.readFileSync(rf, 'utf8'));
    const last = emo[emo.length - 1];
    if (rec && last && typeof last.score === 'number') {
      const baked = sdj._findEmotionSubSignal(rec);
      const curSig = sdj._emotionQuoteSig(last); // 20261028c：与引用子因子同源的信号推导
      if (baked !== null) {
        const shouldStale = Math.abs(baked - curSig) > 0.0005;
        // 不依赖具体数值，只校验「门控判定 == 烘焙/当前是否真的不同」这一因果关系
        ok(sdj._emotionSubStale(rec) === shouldStale,
          `600460 烘焙情绪 ${baked} vs 最新 ${curSig} → _emotionSubStale=${shouldStale}（与差值一致）`);
        console.log(`     （记录 generatedAt=${rec.generatedAt}, 最新情绪 date=${last.date} score=${last.score}）`);
      } else {
        console.log('     （600460 记录无情绪子因子，跳过）');
      }
    } else {
      console.log('     （记录/情绪文件结构不含预期字段，跳过）');
    }
  } else {
    console.log('     （判断/情绪数据文件不存在，跳过端到端校验）');
  }
}

// ============================================================================
console.log('\n[4] 源码守卫：复用条件必须包含情绪门控');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sameDayJudgment.js'), 'utf8');
  ok(src.includes('_emotionSubStale(rec)'), 'getJudgmentWithAccuracy 复用条件含 _emotionSubStale(rec)');
  ok(src.includes('!_emotionSubStale(cur)'), 'ensureAllTrackedJudgments 复用条件含 !_emotionSubStale(cur)');
  ok(src.includes('function _emotionSubStale'), '定义 _emotionSubStale');
  ok(src.includes('readLatestJudgment()'), '读最新情绪记录（单源）');
}

// ============================================================================
console.log('\n[5] 引用子因子单源同义（20261028c）：徽标语义必须继承首页 tendency，不得自行判档');
{
  // _emotionQuoteSig 映射
  ok(sdj._emotionQuoteSig({ score: -0.04, tendency: '中性', tendencyKey: 'neutral' }) === 0, '首页中性(-0.04) → 引用信号 0（不再被判利空）');
  ok(sdj._emotionQuoteSig({ score: -0.5, tendency: '看跌', tendencyKey: 'bear' }) === -0.5, '首页看跌(-0.5) → -0.5');
  ok(sdj._emotionQuoteSig({ score: 0.3, tendency: '看涨', tendencyKey: 'bull' }) === 0.3, '首页看涨(+0.3) → +0.3');
  ok(sdj._emotionQuoteSig({ score: -0.04 }) === 0, '旧记录无 tendencyKey → 按中性兜底 → 0');
  ok(sdj._emotionQuoteSig(null) === 0, '无记录 → 0');
  // computeMarketEmotionSub 端到端：中性首页不得输出利空信号
  const orig = mem.readLatestJudgment;
  mem.readLatestJudgment = () => ({
    date: '2026-10-28', score: -0.039, tendency: '中性', tendencyKey: 'neutral',
    coreDriver: '融资余额（杠杆资金）', volumeState: '平量（量比 0.97）', advice: '维持中性、不追高不杀跌，建议仓位 4 成',
  });
  const sub = sdj.computeMarketEmotionSub();
  ok(sub.signal === 0, '首页中性 → 引用子因子 signal=0（徽标中性、权重行隐藏）');
  ok(/中性/.test(sub.value), `value 仍显示首页倾向「中性」（实际：${sub.value}）`);
  ok(/-0\.04/.test(sub.detail) && /继承首页判档/.test(sub.detail), 'detail 保留原始分数 + 注明徽标继承首页判档');
  mem.readLatestJudgment = () => ({ date: '2026-10-28', score: -0.5, tendency: '看跌', tendencyKey: 'bear' });
  const subBear = sdj.computeMarketEmotionSub();
  ok(subBear.signal === -0.5 && subBear.signal < 0, '首页看跌 → 引用子因子信号为负（利空徽标与 tendency 同向）');
  mem.readLatestJudgment = () => ({ date: '2026-10-28', score: 0.4, tendency: '看涨', tendencyKey: 'bull' });
  const subBull = sdj.computeMarketEmotionSub();
  ok(subBull.signal === 0.4 && subBull.signal > 0, '首页看涨 → 引用子因子信号为正（利好徽标与 tendency 同向）');
  mem.readLatestJudgment = orig;
}

// ============================================================================
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
