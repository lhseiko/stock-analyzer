/**
 * 静默吞错扫描（空 catch 分诊清单）（零网络）
 * --------------------------------------------------------------
 * 运行： node scripts/test_swallow_catch_guard.js
 * 防御 R17：路由内空 catch 仍返 200 → 错误常年不落盘、排障全靠猜。
 * 产物：docs/swallow-catch-manifest.md（分诊清单）。
 * 回归机制：首次运行建立基线（docs/swallow-catch-baseline.json）并通过；
 *          后续运行若「空 catch 总数」或「路由处理内空 catch 数」增加则判失败。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGETS = ['server.js'];
if (fs.existsSync(path.join(ROOT, 'app.js'))) TARGETS.push('app.js');
const libDir = path.join(ROOT, 'lib');
if (fs.existsSync(libDir)) for (const f of fs.readdirSync(libDir)) if (f.endsWith('.js')) TARGETS.push(path.join('lib', f));
const routesDir = path.join(ROOT, 'routes');
if (fs.existsSync(routesDir)) for (const f of fs.readdirSync(routesDir)) if (f.endsWith('.js')) TARGETS.push(path.join('routes', f));

const docsDir = path.join(ROOT, 'docs');
if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
const manifestPath = path.join(docsDir, 'swallow-catch-manifest.md');
const baselinePath = path.join(docsDir, 'swallow-catch-baseline.json');

const ROUTE_RE = /(?:app|router)\.(?:get|post|put|delete|use|all|patch)\s*\(/g;

function lineOf(src, pos) { return src.slice(0, pos).split('\n').length; }

// 返回该文件所有「空 catch」块的位置（体仅空白/注释），并标注是否在路由处理内
function scanFile(absPath) {
  const src = fs.readFileSync(absPath, 'utf8');
  const rel = path.relative(ROOT, absPath);
  const routePos = [];
  ROUTE_RE.lastIndex = 0;
  let rm;
  while ((rm = ROUTE_RE.exec(src))) routePos.push(rm.index);
  const empty = [];
  let i = 0;
  while ((i = src.indexOf('catch', i)) !== -1) {
    const brace = src.indexOf('{', i);
    if (brace === -1) break;
    let depth = 0, j = brace, end = -1;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;
    const body = src.slice(brace + 1, end);
    const stripped = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').trim();
    if (stripped === '') {
      const inRoute = routePos.some(p => p <= i && i - p <= 800);
      empty.push({ line: lineOf(src, i), inRoute });
    }
    i = end + 1;
  }
  return { rel, empty };
}

let pass = 0, fail = 0;
const all = [];
let total = 0, routeTotal = 0;
for (const t of TARGETS) {
  const r = scanFile(path.join(ROOT, t));
  if (r.empty.length) {
    all.push(`\n### ${r.rel}（空 catch ${r.empty.length} 处）`);
    for (const e of r.empty) {
      const tag = e.inRoute ? '🔴 路由处理内' : '🟡 其他';
      all.push(`- L${e.line}  ${tag}`);
      total++;
      if (e.inRoute) routeTotal++;
    }
  }
}

const manifest = '# 静默吞错（空 catch）分诊清单\n\n自动生成，勿手改。\n\n' +
  `_总计 ${total} 处空 catch；其中路由处理内 🔴 ${routeTotal} 处（最高优先级）。_\n\n` +
  all.join('\n') + '\n';
fs.writeFileSync(manifestPath, manifest);

let baseline = null;
if (fs.existsSync(baselinePath)) {
  try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch (e) { baseline = null; }
}

console.log(`\n[扫描] 空 catch 共 ${total} 处（路由处理内 🔴 ${routeTotal} 处）`);
console.log(`[产物] 分诊清单 → ${path.relative(ROOT, manifestPath)}`);

if (!baseline) {
  fs.writeFileSync(baselinePath, JSON.stringify({ total, routeTotal, generated: new Date().toISOString() }, null, 2));
  console.log(`[基线] 首次运行已建立基线（total=${total}, route=${routeTotal}），本次通过。`);
} else {
  console.log(`[基线] 历史基线 total=${baseline.total}, route=${baseline.routeTotal}`);
  if (total > baseline.total) { fail++; console.log(`  ✗ 空 catch 总数增加（+${total - baseline.total}），疑似新增静默吞错`); }
  else { pass++; console.log(`  ✓ 空 catch 总数未增加（${total} ≤ ${baseline.total}）`); }
  if (routeTotal > baseline.routeTotal) { fail++; console.log(`  ✗ 路由处理内空 catch 增加（+${routeTotal - baseline.routeTotal}），R17 回归`); }
  else { pass++; console.log(`  ✓ 路由处理内空 catch 未增加（${routeTotal} ≤ ${baseline.routeTotal}）`); }
}

console.log(`\n===== 静默吞错扫描：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
