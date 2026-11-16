#!/usr/bin/env node
/**
 * test_emotion_rectification.js — 任务卡 #010「口径合规 + 披露整改」批 1 专项守卫
 * ============================================================================
 * 覆盖批 1 七项动作 A1~A7 与两条数据基准原则（用户 18:12 裁决 A/B/C）：
 *   A1 日期回退链（真实数据日 → 基准日 → 运行日）+ 降级态不显示「数据日期」
 *   A2 后端给因子补齐真实数据日（不新造数据、不用运行日冒充）
 *   A3 撤销 #007 F8 全零缓存判降级（原则 B：全零是有效中性读数）
 *   A4 lagDays 判不出来不判过期归零（原则 A）+ 单股代理降级不写运行日
 *   A5 MSI 读侧 / 写入侧非交易日不产出热度读数 + 热度锚定基准日
 *   A6 披露去重（sampleNote 唯一总览、合并 dataNote 与 warnings、标题精简、量能状态去重）
 *   A7 月报 backfilled / method 透出并前端标注回溯补生成
 * 另验证「零数值变化」：接口连调 3 次 totalScore 与 10 因子权重逐字恒定。
 *
 * 离线、零网络；SA_MARKET_EMOTION_DIR 把连调写入隔离到临时目录，不触碰生产台账。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-emo-rect-'));
process.env.SA_MARKET_EMOTION_DIR = TMP; // 必须在 require 模型之前（DIR 加载时求值）

const model = require('../lib/marketEmotionModel');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const APP = src('public/js/app.js');
const M = src('lib/marketEmotionModel.js');
const SERVER = src('server.js');
const MSI = src('lib/marketSentimentIndex.js');

(async function main() {
  console.log('\n=== 1) A1 日期回退链（原则 A/C） ===');
  ok(APP.includes('f.dataDate || data.baselineDate || data.date'), '基准日排在模型运行日之前');
  ok(APP.includes('f.degraded ?') && APP.includes('无可用数据'), '降级卡片不显示「数据日期」，改显示无可用数据');
  ok(!APP.includes('f.dataDate || data.date || data.baselineDate'), '旧回退链已下线');

  console.log('\n=== 2) A2 后端补齐真实数据日 ===');
  ok(M.includes('rec.baselineDate || null'), '缺 dataDate 的因子取最近交易日基准日');
  ok(M.includes("f.key === 'etfFlow' || f.key === 'discussionHeat'"), 'ETF / 讨论热度保留专属口径日');

  console.log('\n=== 3) A3 原则 B：全零缓存不降级 ===');
  ok(!SERVER.includes('const allZero =') && !SERVER.includes('按数据不可用降级'), '#007 F8 全零判降级已撤销');
  ok(SERVER.includes('最近一次更新日') && SERVER.includes('原则 B'), '兜底分支统一「最近一次成功更新」并如实标注');
  ok(M.includes('宽基 ETF 最近一次更新日'), 'ETF 卡片如实标「最近一次更新日 + 早于基准日」');
  {
    const f = model.calcEtfFlow({
      date: '2026-11-15',
      etfFlow: { score: 0, degraded: false, date: '20261112', totalNet: 0, value: '净申购 0.00 亿' },
    });
    ok(f.degraded === false && f.score === 0,
      '全零缓存实测：degraded=false、score=0 视为中性', `degraded=${f.degraded}, score=${f.score}`);
  }

  console.log('\n=== 4) A4 原则 A：时效无法判定不归零 ===');
  ok(M.includes('lagDays != null && lagDays >= LAG_DEGRADE_DAYS'), '只有明确算出超期才判 stale');
  ok(SERVER.includes('emoBaseline') && !SERVER.includes('date: data.date'), 'MSI 缺失降级路径不写运行日');
  ok(M.includes('与基准日同源'), 'lagDays=0 不再标「当日」');

  console.log('\n=== 5) A5 非交易日快照 / 热度锚定基准日 ===');
  ok(SERVER.includes('isTradingDay(series[i].date)'), 'readMsiHeat 读侧按交易日过滤');
  ok(MSI.includes('if (!isTradingDay(idx.date)) return null;'), 'MSI 写入侧非交易日不落盘');
  ok(M.includes('heatBaseline'), '热度时效锚定最近交易日（基准日）');
  ok(M.includes('(!isTrading || mc.lagged)'), '情绪快照非交易日热度记 null（#007 F6 仍在位）');

  console.log('\n=== 6) A6 披露去重 ===');
  ok(APP.includes('warnExtra.join') && APP.includes('数据说明：'), 'dataNote 与采集警告去重后合并成一行');
  ok(!APP.includes('采集警告：'), '独立「采集警告」行已下线');
  ok(APP.includes('计入总分 = 方向 × 本卡权重'), '因子明细标题精简为一句');
  ok(!APP.includes('tp-status-idx">量能状态'), '顶部胶囊不再重复「量能状态」（另一面板的 tp-status-idx 情绪评分不受影响）');
  ok(M.includes('结论置信度口径') && !M.includes('const confParts'), 'confidenceNote 只留分母口径 + 死逻辑标注');
  ok(M.includes('滞后口径因子：') && !M.includes('本日有 ${laggedFactors.length}'), 'timelinessNote 删除重复计数');
  ok(M.includes('sampleNote: `共 10 个因子'), 'sampleNote 仍是唯一总览');

  console.log('\n=== 7) A7 月报回溯标注 ===');
  ok(M.includes('backfilled: !!prev.backfilled') && M.includes('method: prev.method'), '非月末 return 透出 backfilled / method');
  ok(M.includes('backfilled: !!p.backfilled'), '回退分支同样透出');
  ok(APP.includes('回溯补生成，非月末实时快照') && APP.includes('staleTag'), '前端标注回溯补生成');

  console.log('\n=== 8) 动态：连调 3 次数值恒定 + 日期不冒充运行日 ===');
  {
    const bars = [];
    for (let i = 0; i < 12; i++) {
      bars.push({ date: `2026-11-${String(1 + i).padStart(2, '0')}`, close: 3600 + i * 2, volume: 1e8, amount: 1e11 });
    }
    bars[bars.length - 1].date = '2026-11-13';
    const data = {
      date: '2026-11-15',
      index: { bars },
      breadth: { up: 100, down: 200, limitUp: 5, limitDown: 10 },
      discussionHeat: { marketHeat: -0.229, date: '2026-11-13', value: '热度 -0.23' },
      etfFlow: { score: 0, degraded: false, date: '20261112', totalNet: 0, value: '净申购 0.00 亿' },
    };
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await model.computeMarketEmotion({ data, macroFactors: [] }));
    const r0 = rs[0];
    ok(rs.every(r => r.totalScore === r0.totalScore && JSON.stringify(r.weights) === JSON.stringify(r0.weights)),
      '连调 3 次：totalScore 与 10 因子权重逐字恒定');
    ok(r0.factors.every(f => f.dataDate !== '2026-11-15'), '没有任何因子 dataDate = 运行日 2026-11-15');
    const baseCnt = r0.factors.filter(f => f.dataDate === '2026-11-13').length;
    ok(baseCnt >= 6, `至少 6 个因子显示基准日 2026-11-13（实测 ${baseCnt}）`);
    const etf = r0.factors.find(f => f.key === 'etfFlow');
    ok(etf && etf.etfDate === '20261112', 'ETF 保留最近一次更新日 20261112');
    ok(Array.isArray(r0.factors) && r0.factors.length === 10, '因子数仍为 10（未增删合并）');
  }

  console.log('\n=== 9) 动态：热度日期未知不再按过期剔除（原则 A） ===');
  {
    const bars = [];
    for (let i = 0; i < 12; i++) {
      bars.push({ date: `2026-11-${String(1 + i).padStart(2, '0')}`, close: 3600 + i, volume: 1e8, amount: 1e11 });
    }
    const r = await model.computeMarketEmotion({
      data: { date: '2026-11-15', index: { bars }, breadth: { up: 100, down: 200 }, discussionHeat: { marketHeat: 0.2 } },
      macroFactors: [],
    });
    const dh = r.factors.find(f => f.key === 'discussionHeat');
    ok(dh.lagDays === null && !/已按过期数据剔除/.test(dh.reason || ''), '日期未知 → 不判过期、不归零分摊');
    ok(/热度日期未知/.test(dh.detail || ''), '如实标注「热度日期未知」，不冒充当日');
  }

  console.log('\n=== 10) 版本戳强绑定 ===');
  {
    const m = SERVER.match(/const APP_VERSION = '(\d{8}[a-z])'/);
    const ver = m ? m[1] : '';
    ok(ver === '20261116f', `APP_VERSION 已升到 20261116f（实测 ${ver}）`);
    const htmls = fs.readdirSync(path.join(ROOT, 'public')).filter(f => f.endsWith('.html'));
    const bad = [];
    let hits = 0;
    for (const h of htmls) {
      const list = src('public/' + h).match(/\?v=\d{8}[a-z]/g) || [];
      hits += list.length;
      if (list.some(x => x.slice(3) !== ver)) bad.push(h);
    }
    ok(bad.length === 0, `全部 ?v= 等于 APP_VERSION（共 ${hits} 处）`, bad.join(','));
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* best-effort */ }
  console.log('\n' + '='.repeat(60));
  console.log(`===== #010 整改守卫：${pass} 通过 / ${fail} 失败 =====`);
  if (fail) process.exit(1);
})().catch(e => {
  console.error('守卫执行异常：', e && e.stack ? e.stack : e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  process.exit(1);
});
