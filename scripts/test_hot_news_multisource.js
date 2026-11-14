#!/usr/bin/env node
/* 今日财经热点 · 多源互备回归测试（20261114c）
 * 离线纯函数测试：零网络。解析/签名/去重均为确定性纯函数，逐项钉死口径。
 *
 * 背景：getHotNews 原为东方财富 7×24 单源，且「兜底」仍是东财内容搜索（同域名族），
 *       东财不可用时整卡空白。现为东财(主) + 新浪财经 7×24 + 财联社电报 + 华尔街见闻 7×24。
 *
 * 锁定：
 *   §1 财联社签名 = md5(sha1(字典序 query))，与 scripts/hot_topics_collect.py 同算法
 *   §2 新浪/财联社/华尔街见闻解析的统一字段 { title, summary, source, url, date }
 *   §3 三源时间一律经 normalizeNewsTime 按北京时间渲染（禁止 UTC 早 8 小时重现）
 *   §4 跨源按归一化标题去重，同题保留摘要更完整的一条
 *   §5 对外返回结构不变（只有 source/updated/items），下游零改动
 *   §6 异常载荷诚实返回空数组，不抛异常、不编造
 * 跑法：node scripts/test_hot_news_multisource.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ns = require(path.join(ROOT, 'lib', 'newsSearch'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra != null ? '  → ' + JSON.stringify(extra) : '')); }
}
function eq(name, a, b) { ok(name + ' = ' + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }

const SINA = {
  result: { data: { feed: { list: [
    { id: 1, rich_text: '【央行开展逆回购】<p>为维护流动性合理充裕，人民银行今日开展 1000 亿元逆回购。</p>',
      create_time: '2026-11-14 17:30:03', docurl: 'https://finance.sina.cn/7x24/detail-1' },
    { id: 2, rich_text: '无标题格式的普通快讯正文内容', create_time: '2026-11-14 09:05:00', docurl: '' },
  ] } } },
};
const CLS = {
  errno: 0, data: { roll_data: [
    { title: '空军多型战机试飞员将亮相航展', content: '【空军多型战机试飞员将亮相航展】财联社11月14日电，记者获悉。（央视新闻）',
      ctime: 1794648615, shareurl: 'https://www.cls.cn/detail/1' },
    { title: '', content: '【某公司中标】金额 2 亿元。', ctime: 1794648000, shareurl: '' },
  ] },
};
const WSCN = {
  code: 20000, data: { items: [
    { title: 'A股三大指数集体收涨', content_text: '沪指涨 0.5%，创业板指涨 1.2%。', display_time: 1794648615, uri: 'https://wallstreetcn.com/lives/1' },
    { title: '', content_text: '无标题快讯正文', display_time: 1794648000, uri: '' },
  ] },
};

// ============ §1 财联社签名（钉死固定值，防算法漂移） ============
console.log('\n§1 财联社签名 md5(sha1(字典序 query))');
{
  const p = { appName: 'CailianpressWeb', os: 'web', sv: '7.7.5', last_time: '', refresh_type: '1', rn: '20' };
  const r = ns.clsSign(p);
  eq('字典序 query 串', r.qs, 'appName=CailianpressWeb&last_time=&os=web&refresh_type=1&rn=20&sv=7.7.5');
  eq('签名固定值（与 Python 采集器一致）', r.sign, 'd89fdd16805945016e0b9cb12e994a46');
  ok('签名为 32 位小写十六进制', /^[0-9a-f]{32}$/.test(r.sign), r.sign);
}

// ============ §2 三源解析统一字段 ============
console.log('\n§2 新浪 / 财联社 / 华尔街见闻 解析');
{
  const s = ns.parseSinaFlash(SINA);
  eq('新浪解析条数', s.length, 2);
  eq('新浪【标题】拆分', s[0].title, '央行开展逆回购');
  ok('新浪正文剥离 HTML 标签', !/<p>/.test(s[0].summary) && s[0].summary.indexOf('为维护流动性') === 0, s[0].summary);
  eq('新浪来源标注', s[0].source, '新浪财经 7×24');
  eq('新浪原文链接', s[0].url, 'https://finance.sina.cn/7x24/detail-1');
  eq('新浪无标题时取前 40 字', s[1].title, '无标题格式的普通快讯正文内容');
  eq('新浪缺失 docurl 时回退入口页', s[1].url, 'https://finance.sina.com.cn/7x24/');

  const c = ns.parseClsTelegraph(CLS);
  eq('财联社解析条数', c.length, 2);
  eq('财联社有标题时用 title', c[0].title, '空军多型战机试飞员将亮相航展');
  ok('财联社摘要去掉与标题重复的【】前缀', c[0].summary.indexOf('财联社11月14日电') === 0, c[0].summary);
  eq('财联社无标题时从【】拆标题', c[1].title, '某公司中标');
  eq('财联社来源标注', c[0].source, '财联社电报');
  eq('财联社缺失 shareurl 时回退', c[1].url, 'https://www.cls.cn/telegraph');

  const w = ns.parseWscnLives(WSCN);
  eq('华尔街见闻解析条数', w.length, 2);
  eq('华尔街见闻标题', w[0].title, 'A股三大指数集体收涨');
  eq('华尔街见闻摘要', w[0].summary, '沪指涨 0.5%，创业板指涨 1.2%。');
  eq('华尔街见闻无标题时取正文前 40 字', w[1].title, '无标题快讯正文');
  eq('华尔街见闻来源标注', w[0].source, '华尔街见闻 7×24');
}

// ============ §3 时间一律北京时间（禁止 UTC 早 8 小时） ============
console.log('\n§3 三源时间经 normalizeNewsTime 按北京时间渲染');
{
  const s = ns.parseSinaFlash(SINA), c = ns.parseClsTelegraph(CLS), w = ns.parseWscnLives(WSCN);
  eq('新浪 create_time 墙钟字符串 → 北京时间', s[0].date, '2026-11-14 17:30');
  eq('财联社 ctime 秒级 epoch → 北京时间', c[0].date, '2026-11-14 17:30');
  eq('华尔街见闻 display_time 秒级 epoch → 北京时间', w[0].date, '2026-11-14 17:30');
  ok('三源日期格式统一为 YYYY-MM-DD HH:mm', [s[0], c[0], w[0]].every(n => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(n.date)),
    { s: s[0].date, c: c[0].date, w: w[0].date });
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'newsSearch.js'), 'utf8');
  ok('新增三源解析中不出现 toISOString 渲染（避免 UTC 错位）',
    !/parseSinaFlash[\s\S]{0,900}toISOString/.test(src) &&
    !/parseClsTelegraph[\s\S]{0,900}toISOString/.test(src) &&
    !/parseWscnLives[\s\S]{0,900}toISOString/.test(src));
}

// ============ §4 跨源去重 ============
console.log('\n§4 跨源按归一化标题去重，同题保留摘要更全的一条');
{
  const items = [
    { title: '央行降准', summary: '短', source: '东方财富 7×24' },
    { title: '央行 降准，', summary: '这是一条包含更多细节的完整摘要', source: '财联社电报' },
    { title: '另一条完全不同的快讯', summary: '', source: '新浪财经 7×24' },
    { title: '', summary: '无标题应丢弃' },
  ];
  const r = ns.dedupeHotNews(items);
  eq('去重后条数', r.length, 2);
  eq('同题保留摘要更完整的一条（来源随之取较全者）', r[0].source, '财联社电报');
  ok('无标题条目被丢弃', r.every(n => !!n.title));
  eq('空输入返回空数组', ns.dedupeHotNews([]), []);
}

// ============ §5 异常载荷诚实返回空 ============
console.log('\n§5 异常载荷诚实返回空数组');
{
  eq('新浪 code!=0 / 缺 feed', ns.parseSinaFlash({ result: { status: { code: 11 }, data: {} } }), []);
  eq('财联社签名错误 errno=10012', ns.parseClsTelegraph({ errno: '10012', msg: '签名错误' }), []);
  eq('财联社 errno 字符串 0 也算成功', ns.parseClsTelegraph({ errno: '0', data: { roll_data: CLS.data.roll_data } }).length, 2);
  eq('华尔街见闻 code!=20000', ns.parseWscnLives({ code: 400, data: {} }), []);
  eq('null 载荷', ns.parseSinaFlash(null), []);
  eq('财联社缺 roll_data', ns.parseClsTelegraph({ errno: 0, data: {} }), []);
}

// ============ §6 输出结构不变 + 下游零改动 ============
console.log('\n§6 对外返回结构不变（模块修改铁律第一条：隔离修改）');
{
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'newsSearch.js'), 'utf8');
  const m = /async function getHotNews\(force = false\) \{([\s\S]*?)\n\}/.exec(src);
  ok('getHotNews 函数可静态提取', !!m);
  const body = m ? m[1] : '';
  ok('正常返回对象仅含 source / updated / items',
    /const result = \{ source: label, updated: new Date\(\)\.toISOString\(\), items \}/.test(body), body.slice(-700));
  ok('未新增 sources / status 等对外字段', !/const result = \{[^}]*sources\b/.test(body));
  ok('空状态返回仍为 source / updated / items / error',
    /const empty = \{ source: '多源快讯（暂不可用）', updated: new Date\(\)\.toISOString\(\), items: \[\], error:/.test(body));
  ok('四路并行且逐路独立降级（Promise.allSettled）',
    /Promise\.allSettled\(jobs\)/.test(src) && /fetchMultiSourceNews/.test(body));
  ok('东财仍为主源（jobs 第一项 fetchKuaixunNews）',
    /const jobs = \[fetchKuaixunNews\(\)/.test(src));

  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok('server.js /api/hot-news 仍只调 getHotNews（未改接线）',
    /app\.get\('\/api\/hot-news'[\s\S]{0,400}getHotNews\(/.test(server));
  const homeJs = fs.readFileSync(path.join(ROOT, 'public', 'js', 'homeNews.js'), 'utf8');
  ok('homeNews.js 脚注仍用 data.source 自动透出（前端零改动）',
    /数据来源：\$\{escapeHtml\(\(data && data\.source\)/.test(homeJs));
  ok('三个新解析函数与去重函数均已导出',
    ['parseSinaFlash', 'parseClsTelegraph', 'parseWscnLives', 'dedupeHotNews', 'clsSign', 'fetchMultiSourceNews']
      .every(k => typeof ns[k] === 'function'));
  eq('源标签覆盖四路', Object.keys(ns.HOT_NEWS_SOURCE_LABELS).sort(), ['cls', 'eastmoney', 'sina', 'wscn']);
}

console.log('\n──────────────');
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
