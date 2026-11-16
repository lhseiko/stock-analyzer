#!/usr/bin/env node
/**
 * test_emotion_bars_cache.js — 任务卡 #014「行情日线本地缓存回退」专项守卫
 * ============================================================================
 * 覆盖：
 *   1) resolveIndexBlock 纯函数四分支：实时正常不回退 / 失败回退 / 不足门槛回退 / 缓存也不可用保持原样
 *   2) saveBars/loadBars 往返 + 损坏 JSON 容错 + 不足门槛拒存
 *   3) 回退标注如实：note 含原因 / 根数 / 最新 K 线日 / 缓存时间，含「非实时」字样
 *   4) 接线：marketEmotionData 写缓存 + 回退判定 + ok 保护（回退成功不再 block:'index' 报失败）
 *   5) 隔离：模型层不引用缓存模块（回退在数据层完成）；守卫用临时目录不碰生产缓存
 *
 * 离线、零网络、零生产数据依赖。
 * @test-scope: local
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-bars-cache-'));
process.env.SA_EMO_BARS_CACHE_DIR = TMP; // 守卫隔离：不碰生产缓存

const c = require('../lib/indexBarsCache');

let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? ' → ' + detail : '')); }
}
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function bars(n, lastDate) {
  const arr = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(2026, 10, 13) - i * 86400000);
    arr.push({ date: lastDate && i === 0 ? lastDate : d.toISOString().slice(0, 10), close: 3600 + i, vol: 1000 + i });
  }
  return arr;
}

console.log('\n=== #014 行情日线缓存回退守卫 ===\n');

// ---------- 1) resolveIndexBlock 四分支 ----------
const liveGood = { code: 'sh000001', name: '上证指数', bars: bars(320) };
const r1 = c.resolveIndexBlock({ live: liveGood, liveErr: null, cache: null });
ok(!r1.fromCache && r1.block === liveGood && r1.note === null,
  '分支1：实时正常（≥21 根）用实时、不回退');

const cacheGood = { code: 'sh000001', name: '上证指数', savedAt: '2026-11-15T15:30:00.000Z', bars: bars(320, '2026-11-13') };
const r2 = c.resolveIndexBlock({ live: null, liveErr: new Error('curl exit=56'), cache: cacheGood });
ok(r2.fromCache && r2.block && r2.block.bars.length === 320,
  '分支2：实时失败 → 回退缓存');
ok(r2.note.includes('curl exit=56') && r2.note.includes('320 根') && r2.note.includes('2026-11-13')
  && r2.note.includes('缓存时间') && r2.note.includes('非实时'),
  '分支2：标注含原因/根数/最新K线日/缓存时间/非实时', r2.note);
ok(r2.cacheSavedAt === '2026-11-15T15:30:00.000Z' && r2.block.name === '上证指数',
  '分支2：cacheSavedAt 与 name 透出');

const liveShort = { code: 'sh000001', name: '上证指数', bars: bars(8) };
const r3 = c.resolveIndexBlock({ live: liveShort, liveErr: null, cache: cacheGood });
ok(r3.fromCache && r3.block.bars.length === 320 && r3.note.includes('仅 8 根'),
  '分支3：实时返回不足 21 根 → 回退缓存（接口异常截断场景）');

const cacheShort = { code: 'sh000001', name: '', savedAt: '2026-11-15T15:30:00.000Z', bars: bars(8) };
const r4a = c.resolveIndexBlock({ live: null, liveErr: new Error('timeout'), cache: cacheShort });
const r4b = c.resolveIndexBlock({ live: null, liveErr: new Error('timeout'), cache: null });
ok(!r4a.fromCache && r4a.block === null && !r4b.fromCache && r4b.block === null,
  '分支4：缓存也不可用 → 保持原样（block=null），不编数据');

const liveEqual = { code: 'sh000001', name: '', bars: bars(15) };
const r5 = c.resolveIndexBlock({ live: liveEqual, liveErr: null, cache: { code: 'sh000001', savedAt: '', bars: bars(15) } });
ok(!r5.fromCache && r5.block === liveEqual,
  '分支5：缓存根数不优于实时 → 保持实时原样（不倒退）');

// ---------- 2) saveBars/loadBars 往返 ----------
ok(c.saveBars('sh000001', bars(320), '上证指数') === true, 'saveBars：≥21 根保存成功');
const loaded = c.loadBars('sh000001');
ok(loaded && loaded.code === 'sh000001' && loaded.name === '上证指数' && loaded.bars.length === 320,
  'loadBars：往返一致（code/name/根数）');
ok(c.saveBars('sz399001', bars(8)) === false, 'saveBars：不足 21 根拒存');
ok(c.loadBars('sz399001') === null, 'loadBars：无缓存返回 null');
fs.writeFileSync(path.join(TMP, 'index-bars-bad.json'), '{broken json');
ok(c.loadBars('bad') === null, 'loadBars：损坏 JSON 容错（按无缓存处理，不抛出）');

// ---------- 3) 接线：marketEmotionData ----------
const DATA = src('lib/marketEmotionData.js');
ok(DATA.includes("require('./indexBarsCache')"), '接线：marketEmotionData 引入缓存模块');
ok(DATA.includes('indexBarsCache.saveBars(indexBlock.code') && DATA.includes('indexBarsCache.saveBars(indexSZBlock.code'),
  '接线：上证/深证成功路径写缓存');
ok(DATA.includes('indexBarsCache.resolveIndexBlock'), '接线：回退判定走纯函数');
ok(DATA.includes("indexErr && !indexFromCache) extra.push"), '接线：回退成功时不以 block:index 报失败（保护 data.ok）');
ok(DATA.includes("concat(cacheWarnings)"), '接线：缓存标注走 warnings（既有展示链透出）');
ok(DATA.includes('raw.index.fromCache = true'), '接线：index block 透出 fromCache');

// ---------- 4) 隔离 ----------
ok(!src('lib/marketEmotionModel.js').includes('indexBarsCache'), '隔离：模型层不引用缓存模块（回退在数据层）');

// ---------- 5) 生产默认路径（静态源码断言：本进程已注入临时目录，运行时测不到默认值） ----------
const CACHE_SRC = src('lib/indexBarsCache.js');
ok(CACHE_SRC.includes("path.join(__dirname, '..', 'data', 'market-emotion', 'cache')"),
  '默认缓存目录为 data/market-emotion/cache（源码断言；守卫进程已注入临时目录）');
ok(CACHE_SRC.includes('SA_EMO_BARS_CACHE_DIR'), '隔离开关：SA_EMO_BARS_CACHE_DIR 仅守卫注入用');

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exit(fail ? 1 : 0);
