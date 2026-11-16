#!/usr/bin/env node
/**
 * test_emotion_factor_audit.js — 任务卡 #007「市场情绪提醒 10 因子系统性评估」修复守卫
 * ============================================================================
 * 覆盖 P0 三项（验收标准 A）：
 *   S4 自学习按自然日去重（同日重复请求权重不漂移、force 可重放）
 *   S1 计分口径「算法零改动」+ 文案如实化（强度分不进总分）
 *   S2 有效权重只披露、不改阈值（倾向 ±0.2 / 仓位档 ±0.25 原样）
 * 另覆盖 P1/P2 关键接线：S3 滞后折扣如实化 / S5 双台账 / S6 宏观单一状态源 /
 *   F4 滞后交易日口径 / F5 分母排除当日 / F6 周末快照 / F7 单源标注 / F8 全零 ETF /
 *   S7 重放按基准日去重 / S11 sampleNote 如实汇总 / APP_VERSION 与 ?v= 强绑定。
 *
 * 离线、零网络；用 SA_MARKET_EMOTION_DIR 把连调写入隔离到临时目录，不触碰生产台账。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PROD_EMO_DIR = path.join(ROOT, 'data', 'market-emotion');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-emo-factor-audit-'));
process.env.SA_MARKET_EMOTION_DIR = TMP; // 必须在 require 模型之前（DIR 加载时求值）

const model = require('../lib/marketEmotionModel');
const macro = require('../lib/macroSentimentFactors');
const rebuild = require('./rebuild_emotion_factor_acc');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function has(rel, needle) { return src(rel).includes(needle); }

const M = src('lib/marketEmotionModel.js');
const MCR = src('lib/macroSentimentFactors.js');
const APP = src('public/js/app.js');
const SERVER = src('server.js');
const RB = src('scripts/rebuild_emotion_factor_acc.js');

(async function main() {
  console.log('\n=== 1) P0 · S4 自学习按日去重（动态） ===');
  {
    const mk = () => ({
      weights: { ...model.BASE_WEIGHTS },
      factorAcc: {
        indexMomentum: { samples: Array(25).fill(true), total: 25, correct: 25 },
        margin: { samples: Array(25).fill(false), total: 25, correct: 0 },
      },
    });
    const s = mk();
    const r1 = model.learnWeights(s, { today: '2026-11-15' });
    ok(r1.learnLog.length === 2 && r1.skippedToday === false, '首日确实执行了自学习调整', `learnLog=${r1.learnLog.length}`);
    const snapshot = JSON.stringify(s.weights);
    let allSkipped = true;
    for (let i = 0; i < 4; i++) {
      const r = model.learnWeights(s, { today: '2026-11-15' });
      if (!r.skippedToday || r.learnLog.length) allSkipped = false;
    }
    ok(allSkipped, '同日再连调 4 次全部跳过调整（skippedToday=true）');
    ok(JSON.stringify(s.weights) === snapshot, '同日连调 5 次后权重逐字不变（旧实现会漂到 30 顶格）');
    ok(s.lastLearnDate === '2026-11-15', 'lastLearnDate 落盘标记正确');
    ok(model.learnWeights(s, { today: '2026-11-16' }).learnLog.length === 2, '次日重新允许调整');
    ok(model.learnWeights(mk(), { today: '2026-11-15', force: true }).learnLog.length === 2, 'force=true 历史重放不受当日去重约束');
    ok(M.includes("learnWeights(state, { today })"), '主流程把模型日传入自学习');
  }

  console.log('\n=== 2) P0 · S1 计分口径：算法零改动 + 文案如实化 ===');
  ok(M.includes('const dirWeight = (f) => (f.subScore ? (f.score || 0) : dirOf(f.score || 0));'), 'dirWeight 公式原样（方向满格口径未改）');
  ok(M.includes('for (const f of factors) score10 += dirWeight(f) * (f.weight / 100);'), '总分公式原样');
  ok(M.includes('if (totalScore >= 0.2)') && M.includes('else if (totalScore <= -0.2)'), '倾向阈值 ±0.2 原样');
  ok(M.includes('else if (totalScore >= 0.25)') && M.includes('else if (totalScore >= -0.25)'), '仓位档 ±0.25 原样');
  ok(M.includes('scoreRuleNote') && M.includes('强度分仅用于本卡文案分档'), '「打5折/打7折」文案已注明强度分不进总分');
  ok(has('scripts/test_market_emotion.js', '/打7折/'), '既有「打7折」文案断言仍保留（未破坏下游守卫）');
  ok(MCR.includes("if (dormant)") || MCR.includes('自动归 0'), 'usRuleText 保留「自动归 0」语义');
  {
    const bull = macro.usRuleText('active', 1);
    ok(/偏多/.test(bull) && !/加息拖累/.test(bull), 'F10 文案按 direction 生成：偏多不再写「加息拖累」');
    ok(/自动归 0/.test(macro.usRuleText('dormant', -1)), '休眠文案仍含「自动归 0」（兼容既有守卫）');
    ok(/不涨反跌/.test(macro.usRuleText('dormant', 1)), '偏多事件的相悖描述为「不涨反跌」');
  }

  console.log('\n=== 3) P0 · S2 有效权重只披露、不改阈值（动态 + 静态） ===');
  ok(M.includes('scoreRuleNote,') && M.includes('effectiveWeight,') && M.includes('confidenceNote,'), '模型输出新增 3 个披露字段');
  ok(APP.includes('data.confidenceNote') && APP.includes('data.scoreRuleNote'), '前端渲染置信度与计分口径');
  // [20261115c A6] 因子明细标题精简为一句；计分口径改由结论层 scoreRuleNote 完整披露。
  ok(APP.includes('计入总分 = 方向 × 本卡权重') && M.includes('scoreRuleNote'),
    '因子明细标题精简为一句，计分口径由结论层 scoreRuleNote 承载');
  ok(M.includes('未做有效权重归一'), '置信度明确说明阈值仍按 100% 分母');
  {
    // 构造隔离数据：只有 etfFlow 给出方向，其余因子降级 → 有效权重应小于 100
    const data = {
      date: '2026-11-13',
      index: { bars: [] },
      breadth: { up: 100, down: 200, limitUp: 5, limitDown: 10 },
      etfFlow: { score: -1, date: '20261113', value: '净赎回', detail: '守卫样本', totalNet: -100 },
    };
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await model.computeMarketEmotion({ data, macroFactors: [] }));
    const r0 = rs[0];
    ok(rs.every(r => r.totalScore === r0.totalScore && JSON.stringify(r.weights) === JSON.stringify(r0.weights)),
      '接口连调 3 次：总分与权重逐字恒定（验收标准 A）');
    ok(typeof r0.effectiveWeight === 'number' && r0.effectiveFactorCount >= 1,
      '有效权重与有效因子数已产出', `effW=${r0.effectiveWeight}, effN=${r0.effectiveFactorCount}`);
    ok(r0.effectiveWeight < 100 && r0.zeroWeight > 0,
      '零分因子权重被单列披露，未混入有效权重', `zeroW=${r0.zeroWeight}`);
    ok(/置信度|极端行情熔断|季末周期/.test(r0.confidenceNote || ''), '置信度说明已生成');
    ok(Object.values(r0.weights).reduce((a, b) => a + b, 0) > 99.9, '权重合计仍恒 100%（算法零改动）');
  }

  console.log('\n=== 4) P1 · S6 宏观单一状态源 + F5/F4/F7/F8/F6 ===');
  {
    const s = { events: { usMacro: { status: 'active', weight: 2.05, lastTrigger: '2026-09-17' }, domesticMacro: { status: 'active', weight: 1.64 } } };
    model.decayEvents(s, '2026-11-15', { domesticMacro: false, usMacro: false });
    ok(s.events.usMacro.status === 'dormant' && s.events.usMacro.weight === 0
       && s.events.domesticMacro.status === 'dormant' && s.events.domesticMacro.weight === 0,
       '未激活的非常驻因子立即归零休眠（不再逐日 0.8 衰减残留）');
  }
  ok(MCR.includes("if (!fomc) { usSt.status = 'dormant'; usSt.weight = 0; }"), '无 FOMC 事件仍强制休眠（#006 F05 未回归）');
  {
    // F5：当日净额 999 只能作分子，5 日均必须只由 5 条历史 100 组成
    const snaps = [
      { date: '2026-11-06', mainNet: 100 }, { date: '2026-11-09', mainNet: 100 },
      { date: '2026-11-10', mainNet: 100 }, { date: '2026-11-11', mainNet: 100 },
      { date: '2026-11-12', mainNet: 100 }, { date: '2026-11-13', mainNet: 999 },
    ];
    const r = model.calcMainCapital({ date: '2026-11-13', mainFund: { mainNetToday: 999, date: '2026-11-13' } }, snaps);
    ok(r.avg5 === 100 && r.sampleDays === 5, 'F5 分母排除当日：avg5 只由 5 条历史算出', `avg5=${r.avg5}, n=${r.sampleDays}`);
    ok(M.includes('asOfTradingDate(d.date)'), 'F4 滞后天数改按真实交易日计算');
  }
  {
    const onlyFx = model.calcRiskAversion({ fx: { usdcnhChgPct: 0.5, usdcnh: 7.2 } });
    const both = model.calcRiskAversion({ fx: { usdcnhChgPct: 0.5, usdcnh: 7.2 }, bond: { chgBp5: -5, cn10y: 1.8 } });
    ok(onlyFx.partial === true && /国债/.test(onlyFx.partialNote || ''), 'F7 单源缺失显式标注');
    ok(both.partial === false, 'F7 双源齐备不误标');
    ok(M.includes('partial: !!f.partial,') && APP.includes('f.partialNote'), 'F7 标注进输出白名单且前端渲染');
  }
  // [20261115c A3] 原则 B 反向修正 #007 F8：ETF 全零缓存不再判「数据不可用」。
  ok(!SERVER.includes('const allZero =') && SERVER.includes('最近一次更新日') && SERVER.includes('原则 B'),
    'A3 撤销全零判降级，ETF 兜底统一沿用「最近一次成功更新」数据（原则 B）');
  ok(M.includes('const isTrading = isTradingDay(today);') && M.includes('(!isTrading || mc.lagged)'), 'F6 非交易日快照不写热度/主力净额');

  console.log('\n=== 5) P1/P2 · S7 重放去重 / S3 / S5 / S11 ===');
  {
    const a = rebuild.rebuild({ dir: PROD_EMO_DIR });
    const b = rebuild.rebuild({ dir: PROD_EMO_DIR });
    ok(JSON.stringify(a.summary) === JSON.stringify(b.summary), 'S7 重放幂等：两次结果逐字一致');
    ok(a.summary.skippedDuplicate > 0, `S7 按基准日去重生效（剔除 ${a.summary.skippedDuplicate} 条复用记录）`);
    ok(a.summary.skippedNonTrading > 0, 'S7 非交易日快照不参与重放');
    ok(RB.includes("model.learnWeights(state, { today: r.date, force: true })"), '重放用 force 跳过当日去重（历史轨迹完整）');
    ok(Object.values(a.state.weights).every(v => v <= model.W_MAX + 1e-9), '重放结果无超上限权重');
  }
  ok(M.includes('再按合计 100% 重新归一') && APP.includes('后再按合计 100% 归一'), 'S3 滞后折扣如实化（归一转嫁已写明）');
  ok(M.includes("scope: 'internal-diagnostic'") && SERVER.includes('accuracySource'), 'S5 双台账：内部诊断标注 + 路由层唯一权威源');
  {
    const sampleLine = M.split('\n').find(l => l.trim().startsWith('sampleNote:')) || '';
    ok(/有效权重/.test(sampleLine) && /兜底缓存/.test(sampleLine) && !/全部因子数据齐备/.test(sampleLine),
       'S11 sampleNote 如实汇总，不再无条件宣称齐备');
  }

  console.log('\n=== 5b) P2 · S9 月报断档补齐 ===');
  {
    const HD = path.join(ROOT, 'data', 'market-emotion', 'health');
    const months = ['2026-09', '2026-10', '2026-11'];
    ok(months.every(m => fs.existsSync(path.join(HD, m + '.json'))), 'S9 三个月月报齐备（09 / 10 / 11）');
    const all = months.map(m => fs.readFileSync(path.join(HD, m + '.json'), 'utf8')).join('\n');
    // 只查 factorStats 的键：09 月报的归一说明里会合法出现旧键名文字，全文匹配会误报
    const noOldKey = months.every(m => {
      const j = JSON.parse(fs.readFileSync(path.join(HD, m + '.json'), 'utf8'));
      return !Object.prototype.hasOwnProperty.call(j.report.factorStats || {}, 'priceVolume');
    });
    ok(noOldKey, 'S9 月报 factorStats 无旧因子键 priceVolume（已归一 volumePrice）');
    ok(all.includes('"backfilled": true') && /非月末实时快照/.test(all), 'S9 补生成报告标注口径（非月末实时快照，非运行时快照）');
    const j10 = JSON.parse(fs.readFileSync(path.join(HD, '2026-10.json'), 'utf8'));
    const j11 = JSON.parse(fs.readFileSync(path.join(HD, '2026-11.json'), 'utf8'));
    ok(j10.report.settledCount === 29 && j11.report.settledCount === 12, 'S9 补生成月报结算数与 records.json 一致');
    ok(RB.includes('function backfillHealth(') && RB.includes('backfill-health'), 'S9 补齐能力幂等可重跑');
    ok(APP.includes('staleTag'), '前端仍保留「最近一次月报」stale 标注（运行时回退未被破坏）');
  }

  console.log('\n=== 6) 版本戳强绑定（动态读取，不硬编码） ===');
  {
    const m = SERVER.match(/const APP_VERSION = '(\d{8}[a-z])'/);
    const ver = m ? m[1] : '';
    ok(!!m, 'server.js 存在合法 APP_VERSION');
    const htmls = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'));
    const bad = [];
    let hits = 0;
    for (const h of htmls) {
      const list = src('public/' + h).match(/\?v=\d{8}[a-z]/g) || [];
      hits += list.length;
      if (list.some(x => x.slice(3) !== ver)) bad.push(h);
    }
    ok(htmls.length === 8, `public/ 下共 8 个 HTML（实测 ${htmls.length}）`);
    ok(bad.length === 0, `全部 ?v= 等于 APP_VERSION ${ver}（共 ${hits} 处）`, bad.join(','));
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
  console.log('\n' + '='.repeat(60));
  console.log(`===== 情绪因子审计守卫：${pass} 通过 / ${fail} 失败 =====`);
  if (fail) process.exit(1);
})().catch(e => {
  console.error('守卫执行异常：', e && e.stack ? e.stack : e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  process.exit(1);
});
