/**
 * 美债 10 年期收益率（首页「实时大盘」→ 美国指数行）· 回归测试（零网络，全部注入夹具）
 * ---------------------------------------------------------------------------
 * 运行：node scripts/test_us_treasury.js
 * 覆盖：lib/usTreasury.js（20261021a）
 *   [1] 财政部 CSV 解析：降序行序、取最近两个交易日、空值行跳过
 *   [2] 财政部 CSV 解析：脏输入（无表头 / 无 10 Yr 列 / 空文本）→ null，不编造
 *   [3] FRED CSV 解析：升序行序、非交易日空值跳过 → prev 取上一个有值的交易日
 *   [4] 卡片口径：收益率 % + 基点 bp + 相对变动 %，以及 change 的浮点尾数处理
 *   [5] 过期守门：> MAX_STALE_DAYS 天不展示；3~10 天标 staleWarn（周末/美国假日）
 *   [6] 降级链：财政部当年失败 → 财政部去年 → FRED；全失败 → null（不伪造）
 *   [7] 缓存：TTL 内二次调用不再打网络
 *   [8] 接线守卫：stockData 追加到 us 行且来源标签改 usSource；前端 renderTile 有 kind==='yield' 分支
 */
const path = require('path');
const fs = require('fs');
const t = require('../lib/usTreasury');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

// ---- 夹具：真实的美国财政部 CSV 形状（降序，含 "10 Yr" 列） ----
const TREASURY_CSV = [
  'Date,"1 Mo","2 Mo","3 Mo","6 Mo","1 Yr","2 Yr","3 Yr","5 Yr","7 Yr","10 Yr","20 Yr","30 Yr"',
  '10/19/2026,4.11,4.17,4.27,4.37,4.50,4.77,4.85,4.94,5.04,5.15,5.53,5.48',
  '10/16/2026,4.12,4.17,4.26,4.34,4.46,4.74,4.82,4.89,4.98,5.09,5.47,5.43',
  '10/15/2026,4.17,4.19,4.28,4.35,4.49,4.77,4.85,4.91,5.00,5.10,5.48,5.43',
].join('\r\n');

// FRED 形状（升序，非交易日为空值）
const FRED_CSV = ['observation_date,DGS10', '2026-10-13,5.21', '2026-10-14,5.19', '2026-10-15,5.10', '2026-10-16,5.09'].join('\n');

console.log('\n[1] 财政部 CSV 解析（降序 / 最近两日 / 空值跳过）');
{
  const r = t.parseTreasuryCsv(TREASURY_CSV);
  eq(r.asOf, '2026-10-19', '最新日期取行首（降序首行）');
  eq(r.latest, 5.15, '最新 10Y = 5.15%');
  eq(r.prev, 5.09, '前一交易日 = 5.09%');
  eq(r.rows, 3, '有效行 3 条');

  // 行序颠倒也必须得到同一结果（不依赖源站行序）
  const asc = TREASURY_CSV.split('\r\n');
  const flipped = [asc[0], asc[3], asc[2], asc[1]].join('\n');
  eq(t.parseTreasuryCsv(flipped).asOf, '2026-10-19', '升序输入也取最新日（内部统一排序）');

  // 最新一行 10Y 为空 → 跳过该行，取上一个有值的交易日（空值≠0）
  const withEmpty = TREASURY_CSV.replace('5.04,5.15,', '5.04,,');
  eq(t.parseTreasuryCsv(withEmpty).asOf, '2026-10-16', '最新日 10Y 空值 → 跳过，顺延到有值日');
}

console.log('\n[2] 脏输入 → null（绝不编造）');
{
  eq(t.parseTreasuryCsv(''), null, '空文本');
  eq(t.parseTreasuryCsv(null), null, 'null');
  eq(t.parseTreasuryCsv('Date,"1 Mo","2 Mo"\n10/19/2026,4.11,4.17'), null, '没有 10 Yr 列 → null');
  eq(t.parseTreasuryCsv('foo,bar\n1,2'), null, '表头首列不是 Date → null');
  eq(t.parseTreasuryCsv('Date,"10 Yr"\nabc,'), null, '行全脏 → null');
}

console.log('\n[3] FRED CSV 解析（升序 / 空值=非交易日）');
{
  const r = t.parseFredCsv(FRED_CSV);
  eq(r.asOf, '2026-10-16', '最新日 = 末行');
  eq(r.latest, 5.09, '最新值 5.09');
  eq(r.prev, 5.10, '前值取上一个**有值**交易日 5.10');
  const withGap = FRED_CSV.replace('2026-10-16,5.09', '2026-10-19,\n2026-10-16,5.09');
  eq(t.parseFredCsv(withGap).asOf, '2026-10-16', '末行为空（未发布）→ 顺延到有值日');
  eq(t.parseFredCsv('x,y\n1,2'), null, '表头不匹配 → null');
  eq(t.parseFredCsv('observation_date,DGS10'), null, '只有表头 → null');
}

console.log('\n[4] 卡片口径（% / bp / 相对变动）');
{
  const it = t.buildItem({ asOf: '2026-10-19', latest: 5.15, prev: 5.09 }, '美国财政部', '2026-10-21');
  eq(it.price, 5.15, '主值 = 收益率百分数 5.15（前端加 %）');
  eq(it.changeBp, 6, '变动 = +6 bp（0.06 个百分点 ×100）');
  eq(it.change, 0.06, 'changes 去浮点尾数（不是 0.0600000000000005）');
  eq(it.changePct, 1.18, '相对变动 1.18%（仅供兜底/排序）');
  eq(it.dateLabel, '10-19', '日期标签 MM-DD');
  eq(it.kind, 'yield', 'kind=yield（前端走收益率渲染，不套点位口径）');

  const down = t.buildItem({ asOf: '2026-10-19', latest: 5.05, prev: 5.15 }, 'x', '2026-10-20');
  eq(down.changeBp, -10, '收益率下行 = -10bp');
  ok(down.changePct < 0, '相对变动同步为负');

  const noPrev = t.buildItem({ asOf: '2026-10-19', latest: 5.15, prev: null }, 'x', '2026-10-20');
  eq(noPrev.changeBp, null, '无前值 → bp 为 null（前端显示 --，不是 0）');
  eq(noPrev.changePct, null, '无前值 → 相对变动 null');
}

console.log('\n[5] 过期守门（数据最新性）');
{
  ok(t.buildItem({ asOf: '2026-10-19', latest: 5.15, prev: 5.09 }, 'x', '2026-10-22') !== null, '2 天前 → 正常展示');
  const w = t.buildItem({ asOf: '2026-10-16', latest: 5.09, prev: 5.10 }, 'x', '2026-10-21');
  eq(w.staleDays, 5, '5 天前 → staleDays=5');
  ok(w.staleWarn, '超过 3 天 → staleWarn=true（打 ⚠，仍展示）');
  eq(t.buildItem({ asOf: '2026-10-01', latest: 5.15, prev: 5.09 }, 'x', '2026-10-21'), null,
    `超过 MAX_STALE_DAYS(${t.MAX_STALE_DAYS}) 天 → 不展示（不拿过期数据当现行）`);
  eq(t.buildItem({ asOf: '2026-10-19', latest: 0, prev: 5.09 }, 'x', '2026-10-21'), null, '数值 0 → 视为无效不展示');
}

console.log('\n[6] 降级链与失败兜底');
(async () => {
  // 只让 FRED 成功：前两次（财政部当年/去年）都抛错
  let calls = [];
  t.__setFetchText(async (url) => {
    calls.push(url);
    if (url.includes('home.treasury.gov')) throw new Error('tls reset');
    return FRED_CSV;
  });
  const a = await t.getUs10yYield({ today: '2026-10-21' });
  ok(a && a.price === 5.09, '财政部失败 → 回退 FRED，取到 5.09');
  eq(a.sourceLabel, '美联储FRED·DGS10', '来源标签如实写成 FRED（不是财政部）');
  eq(calls.length, 3, '尝试了财政部当年 → 财政部去年 → FRED 共 3 次');

  // 全失败 → null（且不能拿已经过期的旧缓存冒充）
  t.__setFetchText(async () => { throw new Error('all down'); });
  eq(await t.getUs10yYield({ today: '2026-12-31' }), null, '全部源失败且缓存过期 → null（卡片不渲染）');

  console.log('\n[7] 缓存（TTL 内不重复打网络）');
  let n = 0;
  t.__setFetchText(async () => { n += 1; return TREASURY_CSV; });
  const c1 = await t.getUs10yYield({ today: '2026-10-21' });
  const c2 = await t.getUs10yYield({ today: '2026-10-21' });
  eq(n, 1, '两次调用只打 1 次网络（30 分钟缓存）');
  eq(c1.price, c2.price, '两次返回同一数值');
  await t.getUs10yYield({ today: '2026-10-21', refresh: true });
  eq(n, 2, 'refresh=true 强制重新取数');

  console.log('\n[8] 接线守卫');
  {
    const sd = fs.readFileSync(path.join(__dirname, '..', 'lib', 'stockData.js'), 'utf8');
    ok(sd.includes("require('./usTreasury')"), 'stockData 引入了 usTreasury');
    ok(sd.includes('usList.push(bond)'), '美债条目 push 进 us 行（与三个指数同一行）');
    ok(/usSource\s*=\s*`\$\{indexSource\} \+ \$\{bond\.sourceLabel\}（日线）`/.test(sd), '美债带日线来源标签');
    ok(sd.includes('us: usList') && sd.includes('usSource,'), '接口同时返回 us 与 usSource');
    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    ok(app.includes("it.kind === 'yield'"), '前端有收益率专用渲染分支');
    ok(app.includes('mo-bond-tag'), '前端渲染「日线·MM-DD」标签');
    ok(app.includes('data.usSource || data.indexSource'), '美国指数行来源标签取 usSource（不冒充腾讯行情）');
    ok(/Number\(it\.price\)\.toFixed\(2\) \+ '%'/.test(app), '主值渲染为百分比');
    ok(/bp\.toFixed\(1\) \+ 'bp'/.test(app), '变动渲染为基点');
    // 收益率不能被当成指数点位：该分支必须在通用 dir 计算之后独立 return
    const idx = app.indexOf("it.kind === 'yield'");
    const ret = app.indexOf('return `<div class="mo-tile bond', idx);
    ok(ret > idx, '收益率分支独立 return，不落入 fmt() 点位模板');
  }

  console.log('\n[9] 卡片跳转链接（20261021b，用户要求「美债收益率链接这个指数」）');
  {
    eq(t.LINK_URL, 'https://quote.eastmoney.com/unify/r/171.US10Y', '链接指向东财 US10Y 统一行情页（secid=171.US10Y）');
    const it = t.buildItem({ asOf: '2026-10-19', latest: 5.15, prev: 5.09 }, '美国财政部', '2026-10-21');
    eq(it.linkUrl, t.LINK_URL, '条目自带 linkUrl（数据侧给，避免前端硬编码 URL）');
    ok(/东方财富/.test(it.linkLabel || ''), 'linkLabel 标明去向是东方财富');

    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    ok(/<a class="mo-tile bond mo-tile-link/.test(app), '卡片用 <a> 渲染（保留中键新窗口/复制链接等原生行为）');
    ok(app.includes('target="_blank"'), '新标签打开，不打断工作台');
    ok(app.includes('rel="noopener noreferrer"'), '带 noopener/noreferrer（外链安全）');
    ok(app.includes('it.linkUrl'), '链接取自条目，缺 linkUrl 时降级为不可点的 div');
    ok(/与本卡日线口径不同，数值可能不一致/.test(app), 'tooltip 如实声明「东财盘中价 vs 本卡日线」两套口径');

    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
    ok(/a\.mo-tile-link[\s\S]{0,200}text-decoration:\s*none/.test(css), '抹掉链接默认下划线（卡片文字不能变蓝带下划线）');
    ok(css.includes('.mo-link-mark'), '↗ 角标样式存在（提示可点击）');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
})();
