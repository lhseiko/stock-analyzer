#!/usr/bin/env node
/**
 * scripts/test_etf_universe_integrity.js — [20261109a] 名单完整性绝对基准守卫
 *
 * 事故背景（20261028、20261106 两次复发）：上交所名单按 03/01/09 三个分类分别查询，
 * 任一分类失败被静默吞成空数组 → 名单从 34 缩到 7（只剩上证50 4 + 科创50 3）。
 * 旧判据 `partial = okPcfs.length < universe.length` 的分子分母一起缩水 →
 * 残缺快照被标 settled:true，且被跨日重采守卫保护、无法自愈。
 *
 * 本测试验证：
 *   §1 绝对基准纯函数：家族全覆盖 + 总数下限
 *   §2 名单缩水 → 必标 partial / 不定稿 / gaps 可观测（事故指纹不再出现）
 *   §3 名单恢复 → 重采可覆盖残缺快照（自愈通道未被反锁）
 *   §4 接线守卫
 * 全部在 os.tmpdir() 独立夹具内，不碰生产 data/。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

// 与 lib/etfFlow.js GROUPS 的 max 同构：20+4+4+3+3 = 34
const FIX_GROUPS = [
  { key: 'csi300', label: '沪深300', n: 20 },
  { key: 'sse50', label: '上证50', n: 4 },
  { key: 'csi500', label: '中证500', n: 4 },
  { key: 'csi1000', label: '中证1000', n: 3 },
  { key: 'star50', label: '科创50', n: 3 },
];
function fullUniverse() {
  const list = [];
  let i = 0;
  for (const g of FIX_GROUPS) {
    for (let k = 0; k < g.n; k++) {
      list.push({ code: String(510000 + (i++)), name: '宽基ETF', group: g.key, groupLabel: g.label, expectComps: 50 });
    }
  }
  return list;
}
// 事故形态：cls='03' 查询失败 → 只剩上证50 + 科创50 = 7 只
function brokenUniverse() {
  return fullUniverse().filter(u => u.group === 'sse50' || u.group === 'star50');
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-universe-test-'));
  fs.mkdirSync(path.join(dir, 'pcf-cache'), { recursive: true });
  return dir;
}
function loadEf(dir) {
  process.env.SA_ETF_FLOW_DIR = dir;
  delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
  return require(path.join(ROOT, 'lib/etfFlow.js'));
}
const fetchPcf = async (code) => ({
  code, name: '宽基ETF', tradeDate: '20261106', nav: 2.9, unit: 900000,
  navPerCu: 2600000, cash: 400, compCount: 1, comps: [['601398', 1000]],
});
const fetchShares = async (codes) => {
  const o = {};
  for (const c of codes) o[c] = 1e9;
  return o;
};
const optsFor = (u) => ({ universe: u, fetchPcf, fetchShares, cacheKey: '20261109' });
const readSnap = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '20261106.json'), 'utf8'));

(async () => {
  const fixtures = [];
  console.log('=== §1 名单完整性绝对基准（universeIntegrity）===');
  {
    const d = makeFixture(); fixtures.push(d);
    const ef = loadEf(d);
    const full = fullUniverse(), broken = brokenUniverse();
    ok(full.length === 34, '完整夹具 34 只（与 GROUPS max 合计一致）');
    ok(broken.length === 7, '事故夹具 7 只（上证50 4 + 科创50 3）');
    const iFull = ef.universeIntegrity(full);
    const iBad = ef.universeIntegrity(broken);
    ok(iFull.ok === true && iFull.families === 5, '完整名单：5 家族全覆盖 → ok');
    ok(iBad.ok === false, '缩水名单 → 判不完整');
    ok(iBad.missing.length === 3 && iBad.missing.indexOf('沪深300') >= 0, '准确指出缺失家族（沪深300/中证500/中证1000）');
    ok(iBad.size === 7 && iBad.minSize > iBad.size, '绝对下限独立于当次名单（7 < 下限 ' + iBad.minSize + '）');
    const thin = FIX_GROUPS.map(g => ({ code: 'X' + g.key, name: 'X', group: g.key }));
    ok(ef.universeIntegrity(thin).ok === false, '5 家族覆盖但只数不足 27 → 仍判不完整（绝对下限生效）');
  }

  console.log('=== §2 名单缩水 → 必标残缺（事故指纹不再出现）===');
  {
    const d = makeFixture(); fixtures.push(d);
    const ef = loadEf(d);
    const r = await ef.collect(optsFor(brokenUniverse()));
    const s = readSnap(d);
    ok(r.ok === true, 'collect 正常返回');
    ok(s.etfs.length === 7, '快照仍只有 7 只（不臆造份额）');
    ok(s.partial === true && s.settled === false, '★ partial:true / settled:false（不再误标定稿）');
    ok(!(s.settled === true && !s.partial), '★ 事故指纹 7只+settled:true+无partial 不再出现');
    const sg = (s.gaps || []).join('');
    ok(sg.indexOf('ETF 名单不完整') >= 0, '快照 gaps 如实标注「ETF 名单不完整」');
    ok(sg.indexOf('缺 沪深300') >= 0, '快照 gaps 列出缺失家族');
    ok((r.gaps || []).join('').indexOf('ETF 名单不完整') >= 0, 'collect 返回 gaps 同步披露（页面数据缺口可见）');
    ok(s.shareDate === '20261106', '份额披露日语义不变（输出格式未变）');
  }

  console.log('=== §3 名单恢复 → 重采自愈（跨日守卫不再反锁残缺快照）===');
  {
    const d = makeFixture(); fixtures.push(d);
    const ef = loadEf(d);
    await ef.collect(optsFor(brokenUniverse()));
    const s1 = readSnap(d);
    ok(s1.partial === true && s1.settled === false, '第一次：残缺快照落盘');
    const r2 = await ef.collect(optsFor(fullUniverse()));
    const s2 = readSnap(d);
    ok(r2.ok === true, '第二次：重采正常返回');
    ok(s2.etfs.length === 34, '★ 重采补全 34 只（缓存扩容补抓 27 只生效）');
    ok(s2.settled === true && !s2.partial, '★ 残缺快照被覆盖、恢复定稿（自愈通道打开）');
    ok(!s2.gaps || (s2.gaps || []).join('').indexOf('ETF 名单不完整') < 0, '完整名单不再带「名单不完整」告警');
  }

  console.log('=== §4 接线守卫 ===');
  {
    const src = fs.readFileSync(path.join(ROOT, 'lib/etfFlow.js'), 'utf8');
    ok(src.indexOf('function universeIntegrity') >= 0, 'lib/etfFlow.js 含绝对基准函数');
    ok(src.indexOf('okPcfs.length < uInt.minSize') >= 0, 'partial 含绝对只数下限（B 双保险）');
    ok(src.indexOf('上交所 ETF 名单分类') >= 0, '名单查询失败已接入内部错误台账（不再静默吞掉）');
    ok(src.indexOf('assumeCompleteUniverse') >= 0, '仅白盒测试夹具可显式豁免，生产默认校验');
    const t = fs.readFileSync(path.join(ROOT, 'scripts/test_etf_flow_holiday_guard.js'), 'utf8');
    ok(t.indexOf('assumeCompleteUniverse: true') >= 0, '既有节假日守卫夹具已同步适配');
  }

  for (const d of fixtures) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.SA_ETF_FLOW_DIR;
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e && e.stack ? e.stack : e); process.exit(1); });
