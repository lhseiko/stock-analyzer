// test_analysis_warm.js — lib/analysisWarm.js 单元测试（20261027d）
// 覆盖：TTL 读写命中/过期、LRU 淘汰、失败响应不缓存（防毒化）、cachedAt 附加字段、
//       最近查看 LRU 与持久化、预热循环去重/自选优先/上限。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}

// 预热循环的 fetch 需要注入；warmCycle 直接 fetch 本机 HTTP，单测改测「目标列表构造」逻辑较难，
// 故此处聚焦缓存核心；warmCycle 的去重/上限通过导出的 warmListSnapshot + 真实路由做 e2e（另测）。
const aw = require('../lib/analysisWarm');
const T = aw.__test;

console.log('\n===== §1 TTL 缓存 读/命中/过期 =====');
// 备份真实持久化文件（测试会写 data/analysis-warm.json，测完还原）
const persistBackup = fs.existsSync(T.PERSIST) ? fs.readFileSync(T.PERSIST, 'utf8') : null;
T.clearAll();

const payload = { symbol: 'sh601318', name: '中国平安', ok: true };
ok('写入成功', aw.setCached('sh601318', '1y', payload) === true);
const hit = aw.getCached('sh601318', '1y', () => true);
ok('TTL 内命中', !!hit && hit.symbol === 'sh601318');
ok('附加 cachedAt 字段', hit && typeof hit.cachedAt === 'number');
ok('附加 cacheAgeSec 字段', hit && typeof hit.cacheAgeSec === 'number');
ok('原字段不被篡改', hit && hit.name === '中国平安' && hit.ok === true);

// 过期：按「当前真实时刻的实际 TTL」构造边界（不依赖测试运行时段是盘中还是盘后）
const key = 'sh601318|1y';
const entry = T.cache.get(key);
const curTtl = T.ttlMs(new Date(), () => true); // 当前时段实际生效的 TTL（盘中 2 分钟 / 其余 30 分钟）
console.log(`  （当前时段 TTL = ${Math.round(curTtl / 1000)}s）`);
entry.ts = Date.now() - curTtl - 1000;
ok('超过当前时段 TTL → 过期不返回', aw.getCached('sh601318', '1y', () => true) === null);
entry.ts = Date.now() - (curTtl - 5000);
ok('TTL 边界内仍命中', !!aw.getCached('sh601318', '1y', () => true));
// 反向：盘中传“非交易日”判定 → 走 30 分钟 TTL
entry.ts = Date.now() - 3 * 60 * 1000;
ok('同样新旧数据：非交易日口径下仍命中（TTL 切换生效）', !!aw.getCached('sh601318', '1y', () => false));
// 30 分钟 TTL 过期
entry.ts = Date.now() - 31 * 60 * 1000;
ok('非盘中超过 30 分钟 → 过期', aw.getCached('sh601318', '1y', () => false) === null);

console.log('\n===== §2 失败响应不缓存（防毒化） =====');
T.clearAll();
ok('error 响应拒绝缓存', aw.setCached('sh000err', '1y', { error: '无法获取' }) === false);
ok('null 拒绝缓存', aw.setCached('sh000err', '1y', null) === false);
ok('error 响应读不到', aw.getCached('sh000err', '1y', () => true) === null);

console.log('\n===== §3 LRU 淘汰（上限 30） =====');
T.clearAll();
for (let i = 0; i < 35; i++) aw.setCached('sym' + i, '1y', { i });
ok('缓存条数不超过 30', T.cache.size <= 30, T.cache.size);
ok('最新的 sym34 仍在', !!aw.getCached('sym34', '1y', () => true));
ok('最旧的 sym0 已淘汰', aw.getCached('sym0', '1y', () => true) === null);

console.log('\n===== §4 最近查看 LRU 与持久化 =====');
T.clearAll();
try { if (fs.existsSync(T.PERSIST)) fs.unlinkSync(T.PERSIST); } catch (e) {}
aw.noteAnalysisRequest('sh600000');
aw.noteAnalysisRequest('sz000001');
aw.noteAnalysisRequest('sh600000'); // 再看一次 → 提到最前
const snap = aw.warmListSnapshot();
ok('最近查看去重置顶', snap.recents[0] === 'sh600000' && snap.recents[1] === 'sz000001', snap.recents);
ok('持久化文件已写', fs.existsSync(T.PERSIST));
const saved = JSON.parse(fs.readFileSync(T.PERSIST, 'utf8'));
ok('持久化内容一致', Array.isArray(saved.recents) && saved.recents[0] === 'sh600000');

console.log('\n===== §5 缓存键含 range =====');
T.clearAll();
aw.setCached('sh600000', '1y', { v: '1y' });
aw.setCached('sh600000', '3m', { v: '3m' });
ok('同股不同 range 各自命中', aw.getCached('sh600000', '1y', () => true).v === '1y' && aw.getCached('sh600000', '3m', () => true).v === '3m');
ok('缓存键数量 2', T.cache.size === 2, T.cache.size);

// 清场 + 还原持久化
T.clearAll();
try { if (fs.existsSync(T.PERSIST)) fs.unlinkSync(T.PERSIST); } catch (e) {}
if (persistBackup !== null) { try { fs.writeFileSync(T.PERSIST, persistBackup); } catch (e) {} }

console.log(`\n[test_analysis_warm] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
