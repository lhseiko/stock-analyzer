#!/usr/bin/env node
/**
 * Stock Analyzer · 一键全量回归 runner（零依赖纯 Node）
 * --------------------------------------------------------------
 * 用法：
 *   node scripts/run_all_tests.js              # 全量（含 3 个需网络测试）
 *   node scripts/run_all_tests.js --quick      # 仅跑零网络组（SA_TEST_SCOPE=quick 等价）
 *   node scripts/run_all_tests.js --dry-run    # 只列出测试与分类，不执行（用于 CI 预检）
 *
 * 设计：
 *   - child_process.spawn 串行执行每个 test_*.js，避免端口/临时目录冲突；
 *   - 每脚本独立子进程 + 120s 超时（超时仅标记失败，不阻塞后续）；
 *   - 退出码优先：子进程非零退出即判失败（全部测试均已确认 fail>0 → 非零退出）；
 *   - 结束写 docs/test-report.md 结论化报告；汇总行同时打印到控制台。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');
const NODE = process.execPath;
const TIMEOUT_MS = 120000;

const QUICK = process.argv.includes('--quick') || process.env.SA_TEST_SCOPE === 'quick';
const DRYRUN = process.argv.includes('--dry-run');

function listTests() {
  return fs.readdirSync(SCRIPTS).filter(f => /^test_.*\.js$/.test(f)).sort();
}
function needsNetwork(src) {
  return /\baxios\b|\bhttps?\s*[:=]|\bfetch\(|\brequest\(|\.get\(['"]https?:/.test(src)
    || /require\(['"]https?['"]\)/.test(src);
}

function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [path.join(SCRIPTS, file)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    let done = false;
    const finish = (code, timedOut) => {
      if (done) return; done = true;
      resolve({ file, code: timedOut ? 'TIMEOUT' : code, out });
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(null, true); }, TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); finish(code, false); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ file, code: 'ERR', out: String(e && e.stack || e) }); });
  });
}

function classify() {
  return listTests().map(f => ({ f, net: needsNetwork(fs.readFileSync(path.join(SCRIPTS, f), 'utf8')) }));
}

(async () => {
  const all = classify();
  const selected = QUICK ? all.filter(t => !t.net) : all;
  const skipped = QUICK ? all.filter(t => t.net) : [];

  if (DRYRUN) {
    console.log('=== DRY-RUN：测试发现与分类（不执行）===');
    console.log(`模式: ${QUICK ? 'quick' : 'full'} | 总 ${all.length} | 将执行 ${selected.length} | 跳过 ${skipped.length}`);
    for (const t of all) {
      const mark = t.net ? (QUICK ? 'SKIP(网络)' : 'NET') : 'OK';
      console.log(`  [${mark}] ${t.f}`);
    }
    process.exit(0);
  }

  console.log('\n=== Stock Analyzer 测试总跑 ===');
  console.log(`模式: ${QUICK ? `quick（跳过需网络 ${skipped.length} 个）` : `full（全部 ${all.length} 个）`}`);

  const results = [];
  for (const t of selected) {
    const r = await runOne(t.f);
    const ok = r.code === 0;
    results.push({ ...t, ...r, ok });
    const tag = r.code === 'TIMEOUT' ? '⏱ 超时' : (r.code === 'ERR' ? '💥 错误' : (ok ? '✅ 通过' : '❌ 失败'));
    console.log(`  [${tag}] ${t.f} (exit=${r.code})`);
  }

  const failed = results.filter(r => !r.ok);
  const passed = results.length - failed.length;
  const ts = new Date().toISOString();
  const total = results.length;

  let summary;
  if (failed.length === 0) {
    summary = `✅ ${passed}/${total} 全绿${skipped.length ? `（另跳过 ${skipped.length} 个需网络测试）` : ''}`;
  } else {
    summary = `❌ ${passed}/${total} 通过，失败 ${failed.length} 项`;
  }

  console.log(`\n=== 汇总：通过 ${passed}/${total}` + (skipped.length ? `，跳过 ${skipped.length}（需网络）` : '') + ' ===');
  if (failed.length) {
    console.log('失败明细：');
    for (const f of failed) {
      console.log(`  - ${f.file} (exit=${f.code})`);
      const tail = (f.out || '').split('\n').filter(l => /✗|❌|FAIL|Error|throw/.test(l)).slice(-5).join('\n    ');
      if (tail) console.log('    ' + tail);
    }
  } else {
    console.log('✅ 全部通过');
  }

  // 写结论化报告
  const lines = [];
  lines.push('# 测试回归报告（docs/test-report.md）');
  lines.push('');
  lines.push(`> 生成时间：${ts}`);
  lines.push(`> 模式：${QUICK ? 'quick（跳过需网络测试）' : 'full'}`);
  lines.push(`> 命令：\`node scripts/run_all_tests.js${QUICK ? ' --quick' : ''}\``);
  lines.push('');
  lines.push(`## 结论\n\n**${summary}**\n`);
  lines.push(`- 执行测试数：${total}`);
  lines.push(`- 通过：${passed}　失败：${failed.length}` + (skipped.length ? `　跳过（需网络）：${skipped.length}` : ''));
  lines.push('');
  lines.push('## 明细\n');
  lines.push('| 状态 | 测试 | 退出码 |');
  lines.push('|------|------|--------|');
  for (const r of results) {
    const st = r.ok ? '✅' : '❌';
    lines.push(`| ${st} | \`${r.file}\` | ${r.code} |`);
  }
  if (skipped.length) {
    lines.push('');
    lines.push('> 以下需网络测试在本模式被跳过（用 `node scripts/run_all_tests.js` 全量执行）：');
    for (const s of skipped) lines.push(`> - \`${s.f}\``);
  }
  lines.push('');
  try {
    fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'docs', 'test-report.md'), lines.join('\n'), 'utf8');
    console.log(`\n📄 报告已写入 docs/test-report.md`);
  } catch (e) {
    console.log('\n⚠️ 报告写入失败：' + e.message);
  }

  process.exit(failed.length ? 1 : 0);
})();
