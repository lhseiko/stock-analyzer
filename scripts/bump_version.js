#!/usr/bin/env node
/**
 * bump_version.js — 版本戳一条命令自动化（20261110g · 整改方案 P1-2）
 * ============================================================================
 * 用法：
 *   node scripts/bump_version.js <新版本> [--note "变更说明"] [--dry-run]
 * 例：
 *   node scripts/bump_version.js 20261110h --note "P1-2 版本戳自动化落地"
 *
 * 做什么（幂等）：
 *   1. server.js：APP_VERSION '旧' → '新'，并在注释最前插入 `// [新] <note>`（历史版本注释原样保留）；
 *   2. 全部 public/*.html：`?v=旧` → `?v=新`；
 *   3. scripts/test_*.js：**行级限定替换**——含 `APP_VERSION` / `?v=` / 版本断言扫描关键词的行内 旧→新
 *      （杜绝上轮裸 token 替换误伤历史条目断言/测试名的问题，如威高守卫的 20261104i；
 *        20261111d 起补「版本断言/版本戳/版本注释」语境，修跨文件版本断言扫描漏改）。
 *
 * 不做什么：
 *   - 不动 data/ 落盘数据的版本字段（历史 SCHEMA 版本不随代码版本升级）；
 *   - 不动不含旧版本 token 的任何内容（幂等：重复跑同版本零变化）。
 *
 * 退出码：0 成功/幂等无变化；1 失败（参数错误/版本格式非法/旧版 token 缺失且非首次）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VER_RE = /^\d{8}[a-z]$/; // 20261110g 格式

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.writeFileSync(p, s, 'utf8'); }

// ---- 参数解析 ----
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noteIdx = args.indexOf('--note');
const note = noteIdx >= 0 ? String(args[noteIdx + 1] || '') : '';
const nextVer = args.find(a => !a.startsWith('--') && args.indexOf(a) !== noteIdx + 1);
if (!nextVer || !VER_RE.test(nextVer)) {
  console.error('用法: node scripts/bump_version.js <新版本 YYYYMMDDx> [--note "说明"] [--dry-run]');
  process.exit(1);
}

// ---- 1. 读当前版本（server.js APP_VERSION）----
const serverPath = path.join(ROOT, 'server.js');
const serverSrc = read(serverPath);
const m = serverSrc.match(/const APP_VERSION = '(\d{8}[a-z])'/);
if (!m) { console.error('✗ server.js 未找到 APP_VERSION 声明'); process.exit(1); }
const oldVer = m[1];

if (oldVer === nextVer && !note) {
  console.log(`⏸ 幂等：APP_VERSION 已是 ${nextVer}，无变化。`);
  process.exit(0);
}

let changed = 0;
const report = [];

// ---- 2. server.js：APP_VERSION 值 + 注释插入 ----
{
  let src = serverSrc;
  if (oldVer !== nextVer) {
    const before = src;
    src = src.replace(`const APP_VERSION = '${oldVer}'`, `const APP_VERSION = '${nextVer}'`);
    if (src !== before) { changed++; report.push(`server.js: APP_VERSION ${oldVer} → ${nextVer}`); }
  }
  if (note) {
    const anchor = `const APP_VERSION = '${nextVer}'; // `;
    if (src.includes(anchor) && !src.includes(`// [${nextVer}] ${note}`)) {
      // 历史注释（// [旧] ... // [更旧] ...）原样保留，新条目插到最前
      src = src.replace(anchor, anchor + `[${nextVer}] ${note}. `, 1);
      changed++; report.push(`server.js: 插入注释 [${nextVer}] ${note}`);
    }
  }
  if (!dryRun) write(serverPath, src);
}

// ---- 3. public/*.html：?v=旧 → ?v=新 ----
const pubDir = path.join(ROOT, 'public');
const htmls = fs.readdirSync(pubDir).filter(f => f.endsWith('.html'));
for (const f of htmls) {
  const p = path.join(pubDir, f);
  const src = read(p);
  if (oldVer !== nextVer && src.includes('?v=' + oldVer)) {
    const out = src.split('?v=' + oldVer).join('?v=' + nextVer);
    if (!dryRun) write(p, out);
    changed++; report.push(`public/${f}: ?v= ${oldVer} → ${nextVer}（${(src.match(new RegExp('\\?v=' + oldVer, 'g')) || []).length} 处）`);
  }
}

// ---- 4. scripts/test_*.js：行级限定替换（仅 APP_VERSION / ?v= 语境行）----
const testDir = path.join(ROOT, 'scripts');
const tests = fs.readdirSync(testDir).filter(f => /^test_.*\.js$/.test(f));
for (const f of tests) {
  const p = path.join(testDir, f);
  const lines = read(p).split('\n');
  let hit = 0;
  const out = lines.map(line => {
    if (oldVer === nextVer) return line;
    // [20261111d] 补「版本断言扫描」语境：多个守卫脚本用
    //   「XX.js 版本断言同步至 <旧>」/「版本戳=<旧>」/「版本注释应对齐 <旧>」
    // 做跨文件字面量同步检查，这些行既不含 APP_VERSION 也不含 ?v=，旧规则会漏改 → 全量回归红灯。
    // 关键词均取中文断言措辞，不会误伤 SCHEMA_VERSION 名（review-llm-2026xxxx）或历史功能标记。
    const inCtx = line.includes('APP_VERSION') || line.includes('?v=')
      || /版本断言|版本戳|版本标识|版本注释|缓存破坏/.test(line);
    if (inCtx && line.includes(oldVer)) { hit++; return line.split(oldVer).join(nextVer); }
    return line;
  }).join('\n');
  if (hit > 0) {
    if (!dryRun) write(p, out);
    changed++; report.push(`scripts/${f}: ${hit} 行（版本戳/版本断言语境）${oldVer} → ${nextVer}`);
  }
}

// ---- 汇报 ----
console.log(`\n===== bump_version ${dryRun ? '（DRY-RUN 预览）' : '完成'} =====`);
console.log(`旧版本: ${oldVer} → 新版本: ${nextVer}${note ? '\n说明: ' + note : ''}`);
report.forEach(r => console.log('  · ' + r));
if (!report.length) console.log('  （无可替换内容——可能已 bump 过）');

// [P1-2 清单] FRONTEND_BUST_FILES 白名单差集提示：public/js 下新增文件若不在白名单，
// 浏览器不会重新拉取（?v= 不会注入）。只提示不自动改（server.js 手术区，人工确认更稳）。
try {
  const serverNow = read(serverPath);
  const wm = serverNow.match(/const FRONTEND_BUST_FILES = new Set\(\[([^\]]*)\]\)/);
  if (wm) {
    const listed = (wm[1].match(/'\/js\/[^']+'/g) || []).map(s => s.replace(/^'\/js\/|'$/g, '')); // '/js/x.js' → x.js
    const onDisk = fs.readdirSync(path.join(ROOT, 'public', 'js')).filter(f => f.endsWith('.js'));
    const missing = onDisk.filter(f => !listed.includes(f));
    console.log(`\n[白名单检查] FRONTEND_BUST_FILES 含 ${listed.length} 项（js），public/js 下有 ${onDisk.length} 个 js${missing.length ? '，差集（不在白名单、?v= 不生效）：' + missing.join(', ') : '，无差集'}`);
  }
} catch (e) { /* 提示失败不影响 bump */ }

console.log(`\n共 ${changed} 处文件变更。下一步：跑 node scripts/test_cache_bust_guard.js 验证。`);
