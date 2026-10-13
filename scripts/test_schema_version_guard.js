/**
 * SCHEMA_VERSION 守卫（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_schema_version_guard.js
 * 防御 R11（SCHEMA_VERSION 忘升 → 旧缓存被永久复用，任何重启都不生效）：
 *  1) 写侧：SCHEMA_VERSION 由因子结构哈希自动派生，并写入判断记录；
 *  2) 读侧：复用判定存在 `rec.schemaVersion === SCHEMA_VERSION` 门控；
 *  3) 持久化：抽样 data/judgments/*.json，每个判断元素均携带 schemaVersion 字段。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sdSrc = fs.readFileSync(path.join(ROOT, 'lib', 'sameDayJudgment.js'), 'utf8');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }

console.log('\n[1] 写侧：SCHEMA_VERSION 定义与写入记录');
ok(/const\s+SCHEMA_VERSION\s*=\s*'h'\s*\+\s*_hashFactorStructure\(\)/.test(sdSrc),
   'SCHEMA_VERSION 由因子结构哈希自动派生（改因子即自动变版本）');
ok(/schemaVersion\s*=\s*SCHEMA_VERSION/.test(sdSrc),
   '判断记录写入时打上 schemaVersion 戳（写侧接线）');

console.log('\n[2] 读侧：复用判定存在版本门控');
ok(/rec\.schemaVersion\s*===\s*SCHEMA_VERSION/.test(sdSrc),
   '复用逻辑含 `rec.schemaVersion === SCHEMA_VERSION` 门控（旧版本判 miss → 重算）');

console.log('\n[3] 持久化抽样：data/judgments 每个判断元素携带 schemaVersion');
const jDir = path.join(ROOT, 'data', 'judgments');
let files = fs.existsSync(jDir) ? fs.readdirSync(jDir).filter(f => f.endsWith('.json')) : [];
files = files.slice(0, 20);
let elems = 0, okElems = 0; const bad = [];
for (const f of files) {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(path.join(jDir, f), 'utf8')); }
  catch (e) { console.log(`  ⚠ 无法解析 ${f}: ${e.message}`); continue; }
  const vals = Array.isArray(rec) ? rec : Object.values(rec);
  for (const v of vals) {
    if (!v || typeof v !== 'object') continue;
    elems++;
    if (typeof v.schemaVersion === 'string' && v.schemaVersion.length > 0) okElems++;
    else bad.push(`${f}#${typeof v}`);
  }
}
ok(elems > 0, `抽样到判断元素 ${elems} 个`);
ok(okElems === elems, `所有判断元素均携带 schemaVersion 字段（${okElems}/${elems}）`);
bad.slice(0, 5).forEach(b => console.log('     - 缺戳:', b));

console.log(`\n===== SCHEMA_VERSION 守卫：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
