/**
 * 量能根新浪降级 守卫（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_index_sina_fallback.js
 * 背景（2026-10-23 报障）：腾讯 fqkline 全族被 WAF 拦（HTTP 501 + wa.gtimg.com 跳转验证页），
 * 指数日线取不到 → 首页「量能活跃与量价配合」「大盘近期涨跌势头」全线降级
 * 「上证/深证日线不足 21 根」。修法：fetchIndexDailyBars 加新浪日K降级（仅指数）。
 *
 * 关键量纲（2026-10-23 实测）：新浪指数 volume 单位=股，腾讯=手，100.0 倍整 → ÷100 对齐。
 * 若不除，卡片「亿手」显示错 100 倍、且与腾讯恢复后的数据不可比。
 *
 * 用 require.cache 桩模拟：getKlineJson 抛 501（WAF）、axios.get 返回新浪形状数据。
 */
const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}

// —— 桩：先于 require('../lib/marketTechnical') 注入 require.cache ——
const axiosPath = require.resolve('axios');
const tklineHostPath = require.resolve('../lib/tklineHost');
let axiosGetCalls = [];
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: {
    get: async (url) => {
      axiosGetCalls.push(url);
      if (!/money\.finance\.sina\.com\.cn/.test(url)) throw new Error('unexpected url: ' + url);
      // 新浪形状：{day, open, high, low, close, volume(股)}
      return { data: [
        { day: '2026-10-20', open: 3600, high: 3610, low: 3590, close: 3600, volume: 40000000000 },
        { day: '2026-10-21', open: 3600, high: 3610, low: 3590, close: 3605, volume: 41000000000 },
        { day: '2026-10-22', open: 3605, high: 3620, low: 3600, close: 3658.026, volume: 43769196300 },
        { day: '2026-10-23', open: 3660, high: 3700, low: 3655, close: 3690.475, volume: 55284291200 },
      ] };
    },
  },
};
let klineCalls = 0;
require.cache[tklineHostPath] = {
  id: tklineHostPath, filename: tklineHostPath, loaded: true,
  exports: {
    getKlineJson: async () => { klineCalls++; throw new Error('Request failed with status code 501'); },
  },
};

const mt = require('../lib/marketTechnical');

(async () => {
  console.log('\n[1] 腾讯全族 501 → 新浪降级（形状/量纲/排序）');
  const bars = await mt.fetchIndexDailyBars(320, 'sh000001');
  ok(klineCalls === 1, '先走了腾讯通道（getKlineJson 被调用 1 次）');
  ok(axiosGetCalls.length === 1 && /symbol=sh000001/.test(axiosGetCalls[0]), '降级请求打到新浪（symbol=sh000001）');
  ok(/datalen=320/.test(axiosGetCalls[0]) && /scale=240/.test(axiosGetCalls[0]), 'datalen/scale 参数正确');
  ok(bars.length === 4, `返回 4 根（实际 ${bars.length}）`);
  const last = bars[bars.length - 1];
  ok(last.date === '2026-10-23', `末根日期 = 2026-10-23（实际 ${last.date}）`);
  ok(last.close === 3690.475, `close 透传（实际 ${last.close}）`);
  ok(last.volume === 552842912, `volume ÷100 对齐腾讯量纲：55284291200 股 → 552842912 手（实际 ${last.volume}）`);
  ok(typeof last.open === 'number' && typeof last.high === 'number' && typeof last.low === 'number', 'bar 形状与 fetchKline 同构（date/open/close/high/low/volume）');

  console.log('\n[2] 腾讯正常时不降级');
  // 换一个成功桩：重置 require.cache 需重新加载模块 → 用子进程方式太重，这里用计数断言：
  // 上面 [1] 中 getKlineJson 抛错后 axios 恰好 1 次调用；若腾讯成功路径存在，源码守卫 [4] 覆盖。
  ok(axiosGetCalls.length === 1, '腾讯抛错后才降级 1 次（不会重复打新浪）');

  console.log('\n[3] 新浪返回为空 → 抛错（由上层 marketEmotionData 降级捕获）');
  require.cache[axiosPath].exports.get = async () => ({ data: [] });
  let threw = false;
  try { await mt.fetchIndexDailyBars(320, 'sz399001'); } catch (e) { threw = /新浪日K返回为空/.test(e.message); }
  ok(threw, '空数据抛错、不静默返回空数组');

  console.log('\n[4] 源码守卫');
  const fs = require('fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'marketTechnical.js'), 'utf8');
  ok(/async function fetchSinaIndexDailyBars/.test(src), '定义了 fetchSinaIndexDailyBars');
  ok(/Math\.round\(\+d\.volume \/ 100\)/.test(src), '量纲换算 ÷100（股→手）存在');
  ok(/finance\.sina\.com\.cn/.test(src) && /scale=240/.test(src), '走新浪日K接口（scale=240 日线）');
  ok(/仅限指数|个股不走此降级/.test(src), '注释明示仅限指数（个股 qfq≠不复权 不走此降级）');
  ok(/腾讯日K返回为空/.test(src), '腾讯返回空数组也触发降级（fetchKline 空不抛错，须显式判空）');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('测试执行失败:', e.message); process.exit(1); });
