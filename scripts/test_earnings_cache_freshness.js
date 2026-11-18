/**
 * scripts/test_earnings_cache_freshness.js —— 财报解读缓存「过期标记」守卫（任务卡 #025）
 * ---------------------------------------------------------------------------
 *   node scripts/test_earnings_cache_freshness.js
 *
 * 覆盖：stale（提示词版本过期）与 expired（超 7 天 TTL）的判定；
 * 用独立临时缓存文件做夹具，测试结束自动删除，不碰真实个股缓存。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readEarningsCache, EARNINGS_PROMPT_VERSION } = require('../lib/ai/cache');
const { CACHE_DIR } = require('../lib/ai/config');

let pass = 0;
const fail = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { fail.push(`✗ ${name}\n    ${e.message}`); }
}

const CODE = 'zzfreshguard';
const FILE = path.join(CACHE_DIR, `${CODE}_earnings.json`);
const day = 24 * 60 * 60 * 1000;

function writeFixture({ promptVersion = EARNINGS_PROMPT_VERSION, daysAgo = 0, date = undefined }) {
  const d = date !== undefined ? date : new Date(Date.now() - daysAgo * day).toISOString();
  const body = { symbol: CODE, promptVersion, summary: '夹具', date: d, earningsSignal: 0 };
  if (date === null) delete body.date;
  fs.writeFileSync(FILE, JSON.stringify(body), 'utf8');
}

try {
  check('新版本 + 刚生成 → stale=false 且 expired=false', () => {
    writeFixture({ daysAgo: 0 });
    const c = readEarningsCache(CODE);
    if (!c) throw new Error('读不到夹具');
    if (c.stale !== false) throw new Error(`stale 应为 false，实际 ${c.stale}`);
    if (c.expired !== false) throw new Error(`expired 应为 false，实际 ${c.expired}`);
  });

  check('版本过期 → stale=true', () => {
    writeFixture({ promptVersion: '20260909i', daysAgo: 0 });
    const c = readEarningsCache(CODE);
    if (c.stale !== true) throw new Error(`stale 应为 true，实际 ${c.stale}`);
  });

  check('版本新但超 7 天 TTL → stale=false、expired=true', () => {
    writeFixture({ daysAgo: 8 });
    const c = readEarningsCache(CODE);
    if (c.stale !== false) throw new Error(`stale 应为 false，实际 ${c.stale}`);
    if (c.expired !== true) throw new Error(`expired 应为 true，实际 ${c.expired}`);
  });

  check('7 天内 → expired=false', () => {
    writeFixture({ daysAgo: 6 });
    const c = readEarningsCache(CODE);
    if (c.expired !== false) throw new Error(`expired 应为 false，实际 ${c.expired}`);
  });

  check('缺 date 字段 → expired=true（保守视为过期）', () => {
    writeFixture({ date: null });
    const c = readEarningsCache(CODE);
    if (c.expired !== true) throw new Error(`expired 应为 true，实际 ${c.expired}`);
  });

  check('带 sh 前缀也能读到同一份夹具（#024 归一化未回退）', () => {
    writeFixture({ daysAgo: 0 });
    const c = readEarningsCache('sh' + CODE);
    if (!c) throw new Error('带前缀读不到');
    if (c.stale !== false) throw new Error('前缀读取改变了 stale 判定');
  });

  check('只读函数不改写缓存文件内容', () => {
    writeFixture({ daysAgo: 0 });
    const before = fs.readFileSync(FILE, 'utf8');
    readEarningsCache(CODE);
    const after = fs.readFileSync(FILE, 'utf8');
    if (before !== after) throw new Error('readEarningsCache 不应落盘修改缓存');
  });

  check('不存在的标的返回 null', () => {
    if (readEarningsCache('zzno_such_code') !== null) throw new Error('应返回 null');
  });
} finally {
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch {}
}

console.log(`\n共 ${pass + fail.length} 项：通过 ${pass}，失败 ${fail.length}`);
if (fail.length) { fail.forEach(f => console.log(f)); process.exitCode = 1; } else { console.log('全部通过'); }
