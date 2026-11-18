#!/usr/bin/env node
/**
 * test_emotion_learning_health.js — 市场情绪提醒「自学习 / 健康披露」修复守卫
 * ============================================================================
 * 任务卡 #006（2026-11-15）11 项修复的确定性回归：静态接线断言 + 纯函数动态验证。
 * 离线、零网络、不写生产数据；用 SA_MARKET_EMOTION_DIR 把月报读取隔离到临时目录。
 *
 * 覆盖：F01 flat 口径 / F02 重放 / F03 台账统一 / F04 非交易日 / F05 无事件归零 /
 *       F06 ETF 兜底 / F07 采集警告 / F08 月度落盘 / F09 权重归一 /
 *       F10 时效上提 / F11 因子数 / APP_VERSION 与 ?v= 强绑定。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PROD_EMO_DIR = path.join(ROOT, 'data', 'market-emotion');

// 受控临时目录：让 maybeMonthlyHealth 在只有 2026-09 月报的环境里验证 stale 回退，
// 不读写生产台账。必须在 require 模型之前设置（DIR 在模块加载时求值）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-emo-health-'));
fs.mkdirSync(path.join(TMP, 'health'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'health', '2026-09.json'), JSON.stringify({
  month: '2026-09', generatedAt: '2026-09-30T10:44:22.100Z',
  report: { month: '2026-09', settledCount: 13, accuracy: 23.1, factorStats: {}, failedFactors: [] },
}));
process.env.SA_MARKET_EMOTION_DIR = TMP;

const model = require('../lib/marketEmotionModel');
const cal = require('../lib/cnTradingCalendar');
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
const LOGIC = src('public/js/logicModel.js');
const SA = src('lib/sentimentAccuracy.js');
const T_ACC = src('scripts/test_event_weight_sentiment_acc.js');
const SERVER = src('server.js');

console.log('\n=== 1) F01 因子命中率口径：[任务卡 #021] 方向符号一致即命中 ===');
ok(M.includes('hitDir') && M.includes("if (!hitDir || hitDir === 'flat') continue;"), 'applyFactorAccuracy 按实际符号计入样本，仅零涨幅/不可判定跳过');
ok(!M.includes("if (actualDir === 'flat') continue;"), '旧「flat 整日跳过」逻辑已移除');
{
  const s = { factorAcc: {} };
  model.applyFactorAccuracy(s, [{ record: { factorDirs: { indexMomentum: -1, margin: 1 } }, actualDir: 'flat' }]);
  ok(Object.keys(s.factorAcc).length === 0, '无涨跌幅的旧调用仍不写样本（旧行为兼容）');
}
{
  const s = { factorAcc: {} };
  model.applyFactorAccuracy(s, [{ record: { factorDirs: { indexMomentum: -1, margin: 1, volumePrice: 0 } }, actualDir: 'flat', hitDir: 'down', chgPct: -0.2 }]);
  ok(s.factorAcc.indexMomentum.samples[0] === true, '小幅下跌（-0.2%）看空因子记命中');
  ok(s.factorAcc.margin.samples[0] === false, '小幅下跌（ -0.2%）看多因子记未命中');
  ok(!s.factorAcc.volumePrice, '中性方向（dir=0）仍不参与命中统计');
}

console.log('\n=== 2) F02 历史重放与样本归并 ===');
ok(fs.existsSync(path.join(ROOT, 'scripts/rebuild_emotion_factor_acc.js')), '重放脚本已落盘');
ok(has('scripts/rebuild_emotion_factor_acc.js', 'model.applyFactorAccuracy') && has('scripts/rebuild_emotion_factor_acc.js', 'model.learnWeights'), '重放复用线上同一份实现，不另发明算法');
ok(has('scripts/rebuild_emotion_factor_acc.js', "k === 'priceVolume' ? 'volumePrice' : k"), '旧键 priceVolume 归并到 volumePrice');
{
  const a = rebuild.rebuild({ dir: PROD_EMO_DIR });
  const b = rebuild.rebuild({ dir: PROD_EMO_DIR });
  ok(JSON.stringify(a.summary) === JSON.stringify(b.summary), '重放幂等：两次结果逐字一致');
  ok(a.summary.skippedFlat > 0, `重放仅跳过零涨幅/无涨跌幅日（${a.summary.skippedFlat} 条）`);
  ok(a.summary.smallMoveReplayed > 0, `重放把小幅同向日计入样本（${a.summary.smallMoveReplayed} 条）`);
  ok(!Object.prototype.hasOwnProperty.call(a.state.factorAcc, 'priceVolume'), '重放结果无 priceVolume 孤儿键');
  ok(Object.values(a.state.weights).every(v => v <= model.W_MAX + 1e-9), '重放结果无超 W_MAX 权重');
}
{
  const st = JSON.parse(fs.readFileSync(path.join(PROD_EMO_DIR, 'state.json'), 'utf8'));
  ok(!Object.prototype.hasOwnProperty.call(st.factorAcc, 'priceVolume'), '生产 state.json 已无孤儿键');
  ok(st.weights.volumePrice <= model.W_MAX, `生产 weights.volumePrice=${st.weights.volumePrice} ≤ W_MAX=${model.W_MAX}`);
}

console.log('\n=== 3) F03 准确率台账单一权威源 + 单测隔离 ===');
ok(M.includes('internalAccuracy: computeAccuracy(records)'), '模型内统计改名 internalAccuracy');
ok(!/^\s*accuracy: computeAccuracy\(records\)/m.test(M), '模型内不再有同名 accuracy 被静默覆盖');
ok(SERVER.includes('单一权威源 = sentimentAccuracy') || SERVER.includes('准确率台账单一权威源'), '路由注释声明唯一权威源');
ok(SA.includes('SA_SENTIMENT_ACCURACY_DIR'), 'sentimentAccuracy 支持目录环境变量隔离');
{
  const iEnv = T_ACC.indexOf('process.env.SA_SENTIMENT_ACCURACY_DIR');
  const iReq = T_ACC.indexOf("require('../lib/sentimentAccuracy')");
  ok(iEnv >= 0 && iEnv < iReq, '单测在 require 之前设置隔离目录（DIR 加载时求值）');
}
ok(T_ACC.includes('fsSa.rmSync(SA_TEST_DIR'), '单测结尾清理隔离目录');
{
  const accDir = path.join(ROOT, 'data', 'sentiment-accuracy');
  const future = fs.existsSync(accDir) ? fs.readdirSync(accDir).filter(f => /^20(?:2[7-9]|[3-9]\d)-/.test(f)) : [];
  ok(future.length === 0, '生产台账无 2027/2028 未来日期假记录', future.join(','));
  ok(fs.existsSync(path.join(ROOT, 'data/test-scenes/sentiment-accuracy-unittest-2027-12-31.json')), '假记录①已归档（非删除）');
  ok(fs.existsSync(path.join(ROOT, 'data/test-scenes/sentiment-accuracy-unittest-2028-01-05.json')), '假记录②已归档（非删除）');
}

console.log('\n=== 4) F04 非交易日记录不参与结算 ===');
ok(M.includes('rec.isTradingDay = isTradingDay(today)'), '写记录时打交易日标记');
ok(M.includes('if (r.isTradingDay === false) continue;'), 'settleRecords 跳过非交易日快照');
ok(cal.isTradingDay('2026-11-15') === false && cal.isTradingDay('2026-11-13') === true, '交易日历实测：11-15 非交易日 / 11-13 交易日');

console.log('\n=== 5) F05 无事件因子权重归零 ===');
ok(MCR.includes("if (!fomc) { usSt.status = 'dormant'; usSt.weight = 0; }"), '无 FOMC 事件强制 dormant + weight=0');
ok(model.calcMacro({ signal: 0, status: 'dormant' }).active === false, 'dormant 经 calcMacro 判为未激活（computeWeights 将置 0）');

console.log('\n=== 6) F06 ETF 兜底标记与真实滞后 ===');
ok(M.includes('const fallback = !!ef.fallback;'), 'calcEtfFlow 读取兜底标记');
ok(M.includes('fallback: !!f.fallback,'), '输出白名单透出 fallback');
ok(M.includes("lagKind: fallback ? 'stale'"), '兜底时改用异常滞后口径，不再冒充例行披露');
ok(M.includes('asOfTradingDate(d.date)'), 'lagDays 按真实交易日计算，不再硬编码 1');
ok(APP.includes('else if (f.fallback)'), '前端 ⊕ 兜底渲染分支在位');
{
  const f = model.calcEtfFlow({
    date: '2026-11-15',
    etfFlow: { score: 0, degraded: false, date: '20261112', fallback: true, reason: '实时取数失败（守卫）', value: 'x', detail: 'y', totalNet: 0, settleStatus: 'settled' },
  });
  ok(f.fallback === true && /守卫/.test(f.reason || ''), '兜底实测：fallback 与 reason 原样透出');
  ok(f.lagKind === 'stale', '兜底实测：lagKind=stale');
  ok(f.lagDays === 1, `兜底实测：lagDays=${f.lagDays}（11-15 周日 → 最近交易日 11-13 → 数据日 11-12）`);
}
{
  const f = model.calcEtfFlow({ date: '2026-11-15', etfFlow: { score: 0, degraded: false, date: '20261112', value: 'x' } });
  ok(f.fallback === false && f.reason === null && f.lagKind === 'cadence', '非兜底路径仍按 T+1 例行披露，行为不变');
}

console.log('\n=== 7) F07 采集警告进入结论层与界面 ===');
ok(M.includes('const warnList = (d.warnings || []).filter(Boolean);'), 'dataNote 收集采集层警告');
// [20261115b S11] #007 把 sampleNote 改为如实汇总（降级 / 兜底 / 滞后 / 单源 / 警告），
// 旧断言针对的旧文案已下线；改断言新口径，保留「不再无条件宣称齐备」的语义。
{
  const sampleLine = M.split('\n').find(l => l.trim().startsWith('sampleNote:')) || '';
  ok(!/全部因子数据齐备/.test(sampleLine) && /采集层警告 \$\{warnList\.length\} 条/.test(sampleLine)
     && /有效权重/.test(sampleLine) && /兜底缓存/.test(sampleLine),
     'sampleNote 如实汇总有效权重/降级/兜底/滞后/警告，不再无条件宣称「全部因子数据齐备」');
}
// [20261115c A6] dataNote 与 warnings 去重后合并成一行、去掉「数据缺口：」前缀；
// 旧断言针对的独立「采集警告」行已下线，改断言新的合并行（输出格式变了，相邻守卫同步进化）。
ok(APP.includes('warnExtra.join') && APP.includes('数据说明：') && APP.includes('data.warnings'),
  '前端把 dataNote 与采集层警告去重后合并成一行，不再硬加「数据缺口」前缀');

console.log('\n=== 8) F08 月度兜底落盘与报告回退 ===');
ok(M.includes('saveState(state); // 幂等二次写盘'), 'maybeMonthlyHealth 之后补写盘（权重修正不再丢失）');
ok(M.includes('stale: true'), '非月末回退读最近月报并标 stale');
ok(APP.includes('staleTag'), '前端标注「最近一次月报」');
{
  const h = model.maybeMonthlyHealth({ factorAcc: {}, weights: {} }, [], '2026-11-15');
  const now = new Date();
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  if (now.getDate() !== lastDay) {
    ok(h && h.stale === true && h.month === '2026-09', `回退实测：month=${h && h.month}, stale=${h && h.stale}`);
  } else {
    ok(h && h.report && typeof h.report.settledCount === 'number', '月末实测：生成本月报告');
  }
}

console.log('\n=== 9) F09 权重迁移归一 ===');
ok(M.includes('clamp(base, W_MIN, W_MAX)'), 'migrateVolumePriceWeights 统一夹紧到 [W_MIN, W_MAX]');

console.log('\n=== 10) F10 / F11 时效上提与因子数 ===');
ok(M.includes('timelinessNote,'), '模型输出 timelinessNote');
ok(APP.includes('data.timelinessNote'), '前端渲染滞后口径汇总');
ok(LOGIC.includes("badge: '10 因子'") && !LOGIC.includes('9 因子'), '逻辑模型页显示 10 因子且无 9 因子残留');
ok(LOGIC.includes('宽基ETF申购赎回'), '逻辑模型页因子清单补齐 ETF');

console.log('\n=== 11) 版本戳强绑定（动态读取，不硬编码） ===');
{
  const m = SERVER.match(/const APP_VERSION = '(\d{8}[a-z])'/);
  ok(!!m, 'server.js 存在合法 APP_VERSION');
  const ver = m ? m[1] : '';
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

try { fs.rmSync(TMP, { recursive: true, force: true }); }
catch (e) { try { fs.rmdirSync(TMP, { recursive: true }); } catch (_) { /* best-effort */ } }

console.log('\n' + '='.repeat(56));
console.log(`===== 情绪自学习健康守卫：${pass} 通过 / ${fail} 失败 =====`);
if (fail) process.exit(1);
