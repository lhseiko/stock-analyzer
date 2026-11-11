/**
 * test_store.js — lib/store.js JSON 读写统一守卫（20261110g · 整改方案 P1-4）
 * 断言：损坏文件留痕回退 / 缺失文件正常 fallback / 原子写成功 / 原子写无 .tmp 残留 /
 *       四类核心迁移静态扫描（reviews / stock-reviews / manual-zones / judgments 写路径）。
 * 临时目录自清理，零网络。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../lib/store');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-store-test-'));
try {
  console.log('===== 一、readJsonSafe =====');
  // 缺失文件：正常 fallback，不算损坏
  const miss = store.readJsonSafe(path.join(TMP, 'nope.json'), { d: 1 });
  ok(miss.data && miss.data.d === 1 && miss.corrupted === false, '缺失文件 → fallback 且 corrupted=false');

  // 正常文件
  fs.writeFileSync(path.join(TMP, 'good.json'), JSON.stringify({ a: [1, 2] }));
  const good = store.readJsonSafe(path.join(TMP, 'good.json'), null);
  ok(good.data && Array.isArray(good.data.a) && good.corrupted === false, '正常 JSON 正确解析');

  // 损坏文件：留痕回退（warn 走控制台，这里断言行为）
  fs.writeFileSync(path.join(TMP, 'bad.json'), '{"a": 1, "b": '); // 半截 JSON
  const bad = store.readJsonSafe(path.join(TMP, 'bad.json'), []);
  ok(Array.isArray(bad.data) && bad.data.length === 0 && bad.corrupted === true, '损坏 JSON → fallback + corrupted=true（不臆造数据）');
  ok(bad.data !== undefined, '损坏文件回退值与 fallback 一致');

  // 默认 fallback=null
  const def = store.readJsonSafe(path.join(TMP, 'nope2.json'));
  ok(def.data === null && def.corrupted === false, '缺省 fallback=null');

  console.log('\n===== 二、writeJsonAtomic =====');
  const wPath = path.join(TMP, 'sub', 'dir', 'out.json'); // 深层目录自动创建
  ok(store.writeJsonAtomic(wPath, { ok: true, n: 42 }) === true, '原子写成功（自动建父目录）');
  const reread = store.readJsonSafe(wPath, null).data;
  ok(reread && reread.ok === true && reread.n === 42, '写后读回一致');
  ok(!fs.existsSync(wPath + '.tmp'), '无 .tmp 残片（rename 后清理）');
  ok(!fs.readdirSync(path.join(TMP, 'sub', 'dir')).some(f => f.endsWith('.tmp')), '目录内无临时文件残留');

  // 覆盖写仍原子
  store.writeJsonAtomic(wPath, { ok: false, n: 0 });
  ok(store.readJsonSafe(wPath, null).data.n === 0, '覆盖写成功且内容更新');

  // 不可写路径失败不 throw
  const badDir = path.join(TMP, 'file-blocker');
  fs.writeFileSync(badDir, 'not a dir');
  let threw = false;
  try { store.writeJsonAtomic(path.join(badDir, 'x.json'), { a: 1 }); } catch (e) { threw = true; }
  ok(!threw, '写失败不 throw（返回 false 由调用方降级）');

  console.log('\n===== 三、四类核心迁移静态扫描（写路径收编） =====');
  const sdj = fs.readFileSync(path.join(ROOT, 'lib', 'sameDayJudgment.js'), 'utf8');
  ok(sdj.includes("require('./store')"), 'judgments：sameDayJudgment.js 已接 store');
  ok(!/writeFileSync\(f, JSON\.stringify\(arr/.test(sdj), 'judgments：主写路径无直接 writeFileSync(arr) 残留');
  const sr = fs.readFileSync(path.join(ROOT, 'lib', 'stockReview.js'), 'utf8');
  ok(sr.includes("require('./store')") && sr.includes('store.writeJsonAtomic(reviewFile'), 'stock-reviews：stockReview.js 写路径已收编');
  const rs = fs.readFileSync(path.join(ROOT, 'lib', 'reviewService.js'), 'utf8');
  ok(rs.includes("require('./store')") && !/fs\.renameSync\(tmp, f\)/.test(rs), 'reviews：reviewService.js 手写 tmp+rename 已收编');
  const mz = fs.readFileSync(path.join(ROOT, 'lib', 'manualZones.js'), 'utf8');
  ok(mz.includes('store.writeJsonAtomic'), 'manual-zones：manualZones.js 写路径已收编');
} finally {
  fs.rmSync(TMP, { recursive: true, force: true }); // 临时目录自清理
}

console.log(`\n===== test_store 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
