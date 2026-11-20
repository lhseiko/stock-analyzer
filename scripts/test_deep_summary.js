/**
 * scripts/test_deep_summary.js —— 深度分析页「全卡片总结」守卫（任务卡 #028）
 *   node scripts/test_deep_summary.js
 * 全程不调用真实 LLM：缓存命中与参数校验均在调用模型之前返回。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const DS = require('../lib/ai/deepSummary');
const { readDeepSummaryCache, DEEP_SUMMARY_VERSION } = require('../lib/ai/cache');

let pass = 0;
const fail = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { fail.push(`✗ ${name}\n    ${e.message}`); }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const SYM = '999999';
const digest = { valuation: '合理：PE 处于中枢', earnings: { reportPeriod: '2026年三季报', verdict: '主业稳增', summary: '综合信号：1' }, cardConclusions: { growth: '营收增速放缓' } };

(async () => {
  // ---------------- 提示词纪律 ----------------
  const P = DS.DEEP_SUMMARY_SYSTEM_PROMPT;
  ['总览：', '要点：', '风险：', '大白话：'].forEach(t => check(`提示词包含「${t}」`, () => assert(P.includes(t), '缺少')));
  check('禁止买卖指令', () => assert(P.includes('不得给任何买卖指令'), '缺少约束'));
  check('缺数据写暂无数据', () => assert(P.includes('暂无数据'), '缺少'));
  check('覆盖业绩/估值/财报维度', () => assert(P.includes('业绩') && P.includes('估值') && P.includes('财报'), '维度不全'));
  check('冲突口径并列', () => assert(P.includes('并列'), '缺少冲突处理'));

  // ---------------- 摘要与哈希 ----------------
  check('digestHash 稳定', () => assert(DS._digestHash(digest) === DS._digestHash(digest), '同输入哈希不一致'));
  check('卡片变化 → 哈希变化', () => assert(DS._digestHash(digest) !== DS._digestHash({ ...digest, valuation: '高估' }), '哈希未变化'));
  check('空摘要不具备内容', () => assert(!DS._hasSubstance({}) && !DS._hasSubstance('') && !DS._hasSubstance(null), '空摘要被误判为有内容'));
  check('真实摘要具备内容', () => assert(DS._hasSubstance(digest), '真实摘要被误判为空'));
  check('摘要超长截断', () => {
    const long = 'x'.repeat(9000);
    const t = DS._digestText(long);
    assert(t.length < 6300 && t.includes('截断'), '未按上限截断');
  });

  // ---------------- 后处理 ----------------
  check('后处理去井号与粗体', () => {
    const out = DS._postProcess('### 总览：测试\n**要点**：内容');
    assert(!out.includes('###') && !out.includes('**') && out.includes('总览：测试'), '清洗失败：' + out);
  });
  check('后处理超长截断', () => {
    const out = DS._postProcess('总览：' + '内容。'.repeat(2000));
    assert(out.length < 1700 && out.includes('截断'), '未截断');
  });

  // ---------------- 参数校验（不触达 LLM） ----------------
  check('缺 symbol 返回 NO_SYMBOL', async () => {});
  const noSym = await DS.analyzeDeepSummary({ digest });
  check('NO_SYMBOL', () => assert(noSym.success === false && noSym.error === 'NO_SYMBOL', JSON.stringify(noSym)));
  const noDigest = await DS.analyzeDeepSummary({ symbol: SYM, digest: {} });
  check('空摘要返回 NO_DIGEST', () => assert(noDigest.success === false && noDigest.error === 'NO_DIGEST', JSON.stringify(noDigest)));

  // ---------------- 缓存读写与命中 ----------------
  const file = DS._cacheFile(SYM);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const rec = {
    symbol: SYM, stockName: '测试股', summary: '总览：测试总结', date: new Date().toISOString(),
    model: 'test-model', promptVersion: DEEP_SUMMARY_VERSION, digestHash: DS._digestHash(digest),
  };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2), 'utf8');
  check('只读缓存带 stale/expired 标记', () => {
    const c = readDeepSummaryCache(SYM);
    assert(c && c.summary === '总览：测试总结' && c.stale === false && c.expired === false, '读取异常');
  });
  const hit = await DS.analyzeDeepSummary({ symbol: SYM, digest, force: false });
  check('摘要一致且未过期 → 命中缓存（不调用 LLM）', () => assert(hit.success && hit.cached === true && hit.summary === '总览：测试总结', JSON.stringify(hit)));
  check('提示词版本过期 → stale', () => {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    c.promptVersion = 'old';
    fs.writeFileSync(file, JSON.stringify(c), 'utf8');
    const r = readDeepSummaryCache(SYM);
    assert(r.stale === true, 'stale 未置位');
  });
  check('超过 7 天 → expired', () => {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    c.promptVersion = DEEP_SUMMARY_VERSION;
    c.date = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    fs.writeFileSync(file, JSON.stringify(c), 'utf8');
    const r = readDeepSummaryCache(SYM);
    assert(r.expired === true, 'expired 未置位');
  });
  fs.unlinkSync(file);
  check('测试夹具已清理', () => assert(!fs.existsSync(file), '缓存文件未删除'));

  // ---------------- 接线检查 ----------------
  const routes = fs.readFileSync(path.join(__dirname, '..', 'routes', 'aiRoutes.js'), 'utf8');
  check('POST/GET 路由已注册', () => assert(routes.includes("router.post('/api/ai/deep-summary'") && routes.includes("router.get('/api/ai/deep-summary/:symbol'"), '路由缺失'));
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  check('页面顶部容器存在', () => assert(html.includes('id="deepSummary"') && html.indexOf('id="deepSummary"') < html.indexOf('id="deepConclusion"'), '容器缺失或不在估值结论之前'));
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'deepCharts.js'), 'utf8');
  check('前端按需生成（打开只读缓存）', () => assert(js.includes("fetch('/api/ai/deep-summary/'") && js.includes("fetch('/api/ai/deep-summary',"), '前端调用缺失'));
  check('前端不会自动 POST 生成', () => {
    const renderFn = js.match(/renderDeepSummary\(ai, symbol, stockName\) \{[\s\S]*?\n  \},/)[0];
    assert(!renderFn.includes("method: 'POST'"), 'renderDeepSummary 不应直接 POST 生成');
  });
  // [20261118c] 回归：initDeepGroups 会移除所有子节点再按分组装回，未登记的卡片会被丢弃
  const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  check('总结卡已登记进深度分组（否则被 initDeepGroups 移除）', () => {
    assert(appJs.includes("id: 'group-summary'") && appJs.includes("cardOf('deepSummary')"), 'app.js 分组中缺少总结卡');
    const gi = appJs.indexOf("id: 'group-summary'");
    const go = appJs.indexOf("id: 'group-overview'");
    assert(gi > -1 && go > -1 && gi < go, '总结分组应位于综合估值之前');
  });

  console.log(`\n共 ${pass + fail.length} 项：通过 ${pass}，失败 ${fail.length}`);
  if (fail.length) { fail.forEach(f => console.log(f)); process.exitCode = 1; } else { console.log('全部通过'); }
})().catch(e => { console.error('测试执行异常:', e); process.exitCode = 1; });
