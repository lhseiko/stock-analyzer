/**
 * 个股近期热点 × 舆情讨论热度「口径一致性」回归测试
 * --------------------------------------------------------------
 * 背景（用户 2026-09-13 反馈）：个股近期热点显示「未抓取到帖子 / 无热议话题」，
 *   而同一页的「舆情与讨论热度（个股）」却抓到了 14 帖与焦点帖（2026.09.12 收购淘大食品），
 *   两张卡片结论互相打架。
 *
 * 本测试锁定修复后的行为（20260913f）：
 *   1) 热点模块新增三条渠道：同花顺股吧讨论帖 / 多平台讨论热度 / 个股新闻，
 *      与舆情因子同源（lib/sentiment），evidence 中必须出现这些来源；
 *   2) 只要有讨论帖或热度，结果必带 discussion.digest（确定性摘要，不依赖 LLM）；
 *   3) LLM 在已有讨论证据时仍答「未抓取到帖子」→ 综述必须被确定性摘要覆盖；
 *   4) LLM 失败时回退话题必须来自股吧讨论帖，而不是"无热议话题"；
 *   5) 缓存写入口带 cacheVer，旧口径缓存必须失效重算。
 *
 * 通过 require.cache 注入 mock，全程零网络、零 AI 调用；测试用 symbol 999999，
 * 结束自动清理 data/hot-topics/999999。
 *
 * 运行：node scripts/test_hot_topics_consistency.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) pass++; else fail++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${extra ? '：' + extra : ''}`);
}
// require.cache 注入 mock：必须先于 require 目标模块
// 注意：路径以「项目根」为基准解析（本脚本位于 scripts/ 下），
// 否则会解析成 scripts/lib/xxx 而报 MODULE_NOT_FOUND。
const ROOT = path.join(__dirname, '..');
function mock(rel, exports) {
  const abs = require.resolve(path.join(ROOT, rel));
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

const SYMBOL = '999999';
const CACHE_DIR = path.join(__dirname, '..', 'data', 'hot-topics', SYMBOL);

const POSTS = [
  { id: '1', content: '2026.09.12 海天味业 03288.HK 百年淘大易主 海天味业完成收购淘大食品', ctime: 1789232064, reply: 5, like: 3, share: 0, forward: 0, isV: false },
  { id: '2', content: '$海天味业(603288)$ 关于个人增持海天味业股份的公告 拟增持 25000 元', ctime: 1789261446, reply: 1, like: 0, share: 0, forward: 0, isV: false },
];
const HEAT = {
  ok: true,
  eastmoney: { ok: true, symbolScore: 74.1, symbolRise: 176 },
  tonghuashun: { ok: true, inHotList: false, note: '未入热榜' },
  xueqiu: { ok: true, inTop: true, rank: 17, follow: 1929333 },
};

mock('./lib/sentiment', {
  getMarketSentiment: async () => ({
    stockDiscussion: { ok: true, posts: POSTS },
    discussionHeat: HEAT,
    newsSentiment: { ok: true, samples: [{ title: '海天味业 2026 年中报净利润 41.90 亿元', score: 0.727, date: '08-27' }] },
  }),
});
mock('./lib/cnscraperAdapter', {
  getGlobalSentiment: async () => ({ ok: false }),
  searchAnnouncementsByCode: async () => ({ ok: false }),
  interpretReport: async () => ({ ok: false }),
});

function freshHotTopics(aiMock) {
  mock('./lib/aiAugment', aiMock);
  delete require.cache[require.resolve(path.join(ROOT, './lib/hotTopics'))];
  return require(path.join(ROOT, './lib/hotTopics'));
}

(async () => {
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (e) {}

  // ---------- 场景 A：LLM 返回「未抓取到帖子」（复现用户截图 3 的措辞）----------
  const ht = freshHotTopics({
    loadConfig: () => ({ apiKey: 'test-key', provider: 'p', modelWeb: 'm' }),
    callLLM: async () => JSON.stringify({
      topics: [{ keyword: '成交冷清', desc: '未抓取到具体帖子', heat: '低', sentiment: '中性' }],
      summary: '显示为东方财富网股吧的页面框架与基础数据字段，未抓取到具体的股民讨论帖子或新闻标题。',
    }),
  });
  const st = await ht.getState(SYMBOL, '海天味业', true);
  const a = st.analysis || {};

  check('结果含 discussion.digest（确定性讨论摘要）', !!(a.discussion && a.discussion.digest), a.discussion && a.discussion.digest);
  check('摘要含东财/雪球多平台热度', /74\.1/.test(a.discussion.digest) && /第 17 名/.test(a.discussion.digest));
  check('摘要含讨论帖条数与最热帖（焦点帖）', /2 条/.test(a.discussion.digest) && /最热帖/.test(a.discussion.digest));
  check('新增渠道出现在 sources 中',
    ['同花顺股吧讨论帖', '多平台讨论热度（东财/同花顺/雪球）', '个股新闻'].every(s => (a.sources || []).includes(s)),
    JSON.stringify(a.sources));
  check('LLM 否认有内容时综述被确定性摘要覆盖', /【讨论热度】/.test(a.content || '') && !/^未抓取到/.test(a.content || ''));
  check('缓存写入带 cacheVer', a.cacheVer === '20260913f', String(a.cacheVer));

  // ---------- 场景 B：LLM 失败 → 回退话题须来自股吧讨论帖 ----------
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (e) {}
  const ht2 = freshHotTopics({
    loadConfig: () => ({ apiKey: 'test-key', provider: 'p', modelWeb: 'm' }),
    callLLM: async () => { throw new Error('模拟超时 timeout'); },
  });
  const st2 = await ht2.getState(SYMBOL, '海天味业', true);
  const a2 = st2.analysis || {};
  check('LLM 失败仍有回退话题', Array.isArray(a2.topics) && a2.topics.length > 0, `${(a2.topics || []).length} 条`);
  check('回退话题来自股吧讨论帖/热度/新闻',
    (a2.topics || []).some(t => /淘大|增持|热度|中报/.test(t.keyword || '')),
    (a2.topics || []).map(t => t.keyword).join(' | '));
  check('不再误报「未抓取到有效网络舆情或公告」', !/未抓取到有效网络舆情或公告。$/.test(a2.content || ''));

  // ---------- 场景 C：旧口径缓存必须失效 ----------
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (e) {}
  const ht3 = freshHotTopics({
    loadConfig: () => ({ apiKey: 'test-key', provider: 'p', modelWeb: 'm' }),
    callLLM: async () => JSON.stringify({ topics: [{ keyword: '新口径', desc: 'x', heat: '高', sentiment: '利好' }], summary: 'ok' }),
  });
  const r1 = await ht3.getState(SYMBOL, '海天味业', false);
  check('首次请求写入缓存并返回结果', !!(r1.analysis && r1.analysis.topics && r1.analysis.topics.length));
  // 手工把磁盘缓存改成旧口径（无 cacheVer）→ 必须重算而不是复用
  const cf = path.join(CACHE_DIR, 'trending.json');
  const obj = JSON.parse(fs.readFileSync(cf, 'utf8'));
  delete obj.cacheVer;
  obj.topics = [{ keyword: '旧口径残留', desc: 'y', heat: '低', sentiment: '未知' }];
  fs.writeFileSync(cf, JSON.stringify(obj), 'utf8');
  const r2 = await ht3.getState(SYMBOL, '海天味业', false);
  check('旧口径缓存（无 cacheVer）被作废重算', !!(r2.analysis && !r2.analysis.cached && (r2.analysis.topics || []).some(t => t.keyword === '新口径')),
    JSON.stringify((r2.analysis && r2.analysis.topics || []).map(t => t.keyword)));

  // ---------- 清理 ----------
  try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); console.log('INFO: 已清理测试缓存 data/hot-topics/' + SYMBOL); } catch (e) {}
  console.log(`\n===== 汇总：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
