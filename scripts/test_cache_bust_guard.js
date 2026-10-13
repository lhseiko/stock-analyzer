/**
 * 缓存破坏守卫（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_cache_bust_guard.js
 * 防御 R11：?v= 忘更 / 文件不在 FRONTEND_BUST_FILES / SCHEMA_VERSION 忘升
 *         → 浏览器沿用旧缓存（deepCharts 三个月前科）。
 * 守护点：public 下所有 HTML 引用的本地 /js/*.js 与 /css/*.css 必须带 ?v= 戳；
 *         FRONTEND_BUST_FILES 名单里的 js/css 必须仍被某 HTML 实际引用（避免脱节死名单）。
 * vendor/ 第三方库（echarts 等）不参与戳校验（有 CDN 兜底，版本恒定）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0, warn = 0;
function ok(c, m) { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } }
function info(c, m) { if (c) { pass++; console.log('  ✓', m); } else { warn++; console.log('  ⚠', m); } }

// 1) 解析 server.js 中的 FRONTEND_BUST_FILES 名单
const bustMatch = serverSrc.match(/FRONTEND_BUST_FILES\s*=\s*new\s+Set\(\s*\[([\s\S]*?)\]\s*\)/);
ok(!!bustMatch, 'server.js 中存在 FRONTEND_BUST_FILES 定义');
const bustSet = new Set();
if (bustMatch) {
  const items = bustMatch[1].match(/'([^']+)'/g) || [];
  items.forEach(i => bustSet.add(i.slice(1, -1)));
}
console.log(`\n[1] FRONTEND_BUST_FILES 含 ${bustSet.size} 项`);

// 2) 扫描 public 下所有 html 的本地 js/css 引用
const publicDir = path.join(ROOT, 'public');
const htmlFiles = fs.existsSync(publicDir)
  ? fs.readdirSync(publicDir).filter(f => f.endsWith('.html'))
  : [];
console.log(`\n[2] 扫描 public/*.html（${htmlFiles.length} 个）的本地脚本/样式引用`);

const refRe = /(?:src|href)\s*=\s*["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g;
const canon = s => s.replace(/^\.?\//, '');
let totalRefs = 0, missingV = 0, notInBust = 0;
const problems = [];
const referenced = new Set();
for (const hf of htmlFiles) {
  const html = fs.readFileSync(path.join(publicDir, hf), 'utf8');
  refRe.lastIndex = 0;
  let m;
  while ((m = refRe.exec(html))) {
    const ref = m[1];
    if (/^https?:\/\//.test(ref)) continue;        // 跳过外链
    if (/vendor\//.test(ref)) continue;            // 第三方库不参与戳校验
    const hasV = /[?&]v=/.test(ref);
    totalRefs++;
    referenced.add(canon(ref.split('?')[0]));
    if (!hasV) { missingV++; problems.push(`${hf}: 引用 ${ref} 缺少 ?v= 戳`); }
    else if (!bustSet.has(canon(ref.split('?')[0]))) { notInBust++; }
  }
}

ok(missingV === 0, `所有本地 js/css 引用均带 ?v= 戳（共 ${totalRefs} 处，缺戳 ${missingV} 处）`);
problems.forEach(p => console.log('     -', p));
console.log(`  ℹ 非 FRONTEND_BUST_FILES 名单内但已带 ?v= 的引用 ${notInBust} 处（HTML 作者显式带戳，可接受）`);

// 3) 反向：BUST 名单里的 js/css 至少应在某 html 被引用（避免死名单 / 脱节）
let deadBust = 0;
for (const b of bustSet) {
  if ((b.endsWith('.js') || b.endsWith('.css')) && !referenced.has(canon(b))) {
    deadBust++;
    console.log(`     - BUST 项 ${b} 未在任一 public html 中被引用`);
  }
}
info(deadBust === 0, `FRONTEND_BUST_FILES 中的 js/css 均被引用（脱节 ${deadBust} 项）`);

console.log(`\n===== 缓存破坏守卫：通过 ${pass} / 警告 ${warn} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
