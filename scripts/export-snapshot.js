#!/usr/bin/env node
/**
 * export-snapshot.js —— 门面导出基线快照工具（巨型文件拆分重构的验收基准）
 *
 * 用途：
 *   按插入序 dump lib/deepAnalysis.js（13 键）与 lib/aiAugment.js（24 键）
 *   两个门面的 module.exports 键名 + 键序 + typeof，与 scripts/export-baseline.json
 *   逐键比对。拆分过程的每一步都必须零差异。
 *
 * 行为：
 *   1. 生成当前快照写入 scripts/export-snapshot.out（每次覆盖，供 git diff）。
 *   2. 若 scripts/export-baseline.json 不存在 → 用当前快照生成基线（首次采集）。
 *   3. 若基线存在 → 逐键比对；一致 exit 0，不一致打印差异明细并 exit 1。
 *
 * 用法：
 *   node scripts/export-snapshot.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const OUT_PATH = path.join(__dirname, 'export-snapshot.out');
const BASELINE_PATH = path.join(__dirname, 'export-baseline.json');

/** 被快照的门面清单：count 为设计文档规定的导出键数 */
const TARGETS = [
  { name: 'deepAnalysis', modPath: path.join(__dirname, '..', 'lib', 'deepAnalysis.js'), expect: 13 },
  { name: 'aiAugment', modPath: path.join(__dirname, '..', 'lib', 'aiAugment.js'), expect: 24 },
];

/** 按插入序 dump 一个门面的导出键名与 typeof（不排序——键序本身是基线的一部分） */
function snapshotModule(modPath) {
  const mod = require(modPath);
  return Object.keys(mod).map((key) => ({ key, type: typeof mod[key] }));
}

/** 打印两个快照之间的逐键差异明细 */
function printDiff(baselineText, currentText) {
  let baseline = null;
  let current = null;
  try {
    baseline = JSON.parse(baselineText);
    current = JSON.parse(currentText);
  } catch (err) {
    console.error('[export-snapshot] FAIL: 快照 JSON 解析失败: ' + err.message);
    return;
  }
  for (const t of TARGETS) {
    const b = baseline[t.name] || [];
    const c = current[t.name] || [];
    const len = Math.max(b.length, c.length);
    for (let i = 0; i < len; i++) {
      const bk = b[i] ? b[i].key : '(缺失)';
      const ck = c[i] ? c[i].key : '(缺失)';
      if (bk !== ck) {
        console.error('  [' + t.name + '] 键序差异 @' + i + ': 基线=' + bk + ' 当前=' + ck);
      } else if (b[i].type !== c[i].type) {
        console.error('  [' + t.name + '] typeof差异 ' + bk + ': 基线=' + b[i].type + ' 当前=' + c[i].type);
      }
    }
    const cKeys = c.map((e) => e.key);
    for (const e of b) {
      if (!cKeys.includes(e.key)) {
        console.error('  [' + t.name + '] 键丢失: ' + e.key);
      }
    }
    const bKeys = b.map((e) => e.key);
    for (const e of c) {
      if (!bKeys.includes(e.key)) {
        console.error('  [' + t.name + '] 键新增: ' + e.key);
      }
    }
  }
}

function main() {
  const snapshot = {};
  let failed = false;
  for (const t of TARGETS) {
    snapshot[t.name] = snapshotModule(t.modPath);
    if (snapshot[t.name].length !== t.expect) {
      console.error(
        '[export-snapshot] FAIL: ' + t.name + ' 导出键数=' + snapshot[t.name].length +
        '，应为 ' + t.expect
      );
      failed = true;
    }
  }
  const text = JSON.stringify(snapshot, null, 2) + '\n';
  fs.writeFileSync(OUT_PATH, text, 'utf8');

  let baselineText = null;
  try {
    baselineText = fs.readFileSync(BASELINE_PATH, 'utf8');
  } catch (err) {
    baselineText = null;
  }

  if (!baselineText) {
    if (failed) {
      console.error('[export-snapshot] 键数与设计不符，拒绝生成基线。请先核对源码。');
      process.exit(1);
    }
    fs.writeFileSync(BASELINE_PATH, text, 'utf8');
    console.log('[export-snapshot] 基线已生成: ' + BASELINE_PATH);
    console.log('[export-snapshot] deepAnalysis=' + snapshot.deepAnalysis.length + ' 键, aiAugment=' + snapshot.aiAugment.length + ' 键');
    process.exit(0);
  }

  if (failed) {
    process.exit(1);
  }
  // 换行符归一化：git autocrlf 可能把基线文件转成 CRLF，语义比较须忽略换行差异
  const norm = (s) => s.replace(/\r\n/g, '\n');
  if (norm(baselineText) === norm(text)) {
    console.log('[export-snapshot] PASS: 快照与基线逐键一致 (deep=' + snapshot.deepAnalysis.length + ', ai=' + snapshot.aiAugment.length + ')');
    process.exit(0);
  }
  console.error('[export-snapshot] FAIL: 快照与基线存在差异（明细如下）');
  printDiff(baselineText, text);
  process.exit(1);
}

main();
