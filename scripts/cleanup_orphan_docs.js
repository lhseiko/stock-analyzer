/**
 * scripts/cleanup_orphan_docs.js —— 清理资料库孤儿记录（有索引记录、无对应文件）
 * ----------------------------------------------------------------------------
 * 背景：data/index.json 中部分 documents 记录指向的 PDF 从未落盘（历史下载失败/被外部清理），
 * 记录却一直保留。后果：docStore 认为「已有该报告期」，阻断 reportSync 的缺失检测，
 * 资料库实际可用文档比显示的少。
 *
 * 处理：删除孤儿记录，并按 lib/docStore.js deleteDocument 同口径递减 companies 计数。
 * 只动索引，不动任何文件（这些文件本来就不存在）。
 *
 * 留痕：
 *   data/cache/orphan-cleanup-<时间戳>.json  机器可读清单（含每条完整记录字段）
 *   data/cache/orphan-cleanup-<时间戳>.log   人读清单
 *   data/index.json.bak-orphanclean-<时间戳>  删除前的索引完整备份
 *
 * 用法：
 *   node scripts/cleanup_orphan_docs.js           # 预演，只打印，不改任何东西
 *   node scripts/cleanup_orphan_docs.js --apply   # 实际执行
 */
'use strict';

const fs = require('fs');
const path = require('path');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const CACHE_DIR = path.join(DATA_DIR, 'cache');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '');

// 与 docStore.getDocumentPath 完全同口径
function resolveDocPath(doc) {
  const rp = (doc.relativePath || '').replace(/\\/g, '/');
  return rp
    ? path.join(DATA_DIR, rp)
    : path.join(DATA_DIR, 'companies', doc.stockCode, doc.type, doc.fileName);
}

const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const orphans = [];
const healthy = [];
for (const [id, doc] of Object.entries(index.documents || {})) {
  const full = resolveDocPath(doc);
  const ok = fs.existsSync(full);
  const rec = {
    docId: id,
    stockCode: doc.stockCode,
    type: doc.type,
    year: doc.year,
    fileName: doc.fileName,
    relativePath: doc.relativePath || '',
    fileSize: doc.fileSize || 0,
    uploadedAt: doc.uploadedAt || '',
    resolvedPath: path.relative(DATA_DIR, full).replace(/\\/g, '/'),
  };
  (ok ? healthy : orphans).push(rec);
}

// 按公司归组统计
const byCode = {};
for (const o of orphans) byCode[o.stockCode] = (byCode[o.stockCode] || 0) + 1;

console.log(`documents 总记录 ${Object.keys(index.documents || {}).length}，文件存在 ${healthy.length}，孤儿 ${orphans.length}`);
console.log('按公司分布：');
for (const [code, n] of Object.entries(byCode).sort((a, b) => b[1] - a[1])) {
  const docs = orphans.filter((o) => o.stockCode === code).map((o) => `${o.year}/${o.type}`);
  console.log(`  ${code}  ${String(n).padStart(2)} 条  ${docs.join('  ')}`);
}

if (!APPLY) {
  console.log('\n[dry-run] 未做任何改动。确认无误后加 --apply 执行。');
  process.exit(0);
}

if (orphans.length === 0) {
  console.log('\n无孤儿记录，无需处理。');
  process.exit(0);
}

// 1) 备份索引
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
const bak = `${INDEX_FILE}.bak-orphanclean-${stamp}`;
fs.copyFileSync(INDEX_FILE, bak);

// 2) 清单留痕（先写清单再删，保证即使中途失败也有据可查）
const manifest = {
  generatedAt: new Date().toISOString(),
  reason: '清理有索引记录、无对应文件的孤儿文档记录',
  indexPath: 'data/index.json',
  indexBackup: path.basename(bak),
  before: { documents: Object.keys(index.documents || {}).length, orphans: orphans.length },
  items: orphans,
};
fs.writeFileSync(path.join(CACHE_DIR, `orphan-cleanup-${stamp}.json`), JSON.stringify(manifest, null, 2), 'utf8');

const logLines = [
  `# 孤儿文档记录清理清单  ${new Date().toISOString()}`,
  `# 索引备份: ${path.basename(bak)}`,
  `# 共 ${orphans.length} 条`,
  '',
];
for (const o of orphans) {
  logLines.push(`${o.docId}\t${o.stockCode}\t${o.type}\t${o.year}\t${o.fileName}\t${o.relativePath}\t${o.fileSize}`);
}
fs.writeFileSync(path.join(CACHE_DIR, `orphan-cleanup-${stamp}.log`), logLines.join('\r\n'), 'utf8');

// 3) 删除记录 + 同步公司计数（docStore.deleteDocument 同口径；文件本不存在，跳过文件操作）
let removed = 0;
const touchedCompanies = new Set();
for (const o of orphans) {
  const doc = index.documents[o.docId];
  if (!doc) continue;
  delete index.documents[o.docId];
  removed++;
  touchedCompanies.add(doc.stockCode);
  const company = index.companies && index.companies[doc.stockCode];
  if (company) {
    company.docCount = Math.max(0, (company.docCount || 0) - 1);
    if (company.types && company.types[doc.type]) {
      company.types[doc.type] = Math.max(0, (company.types[doc.type] || 0) - 1);
      if (company.types[doc.type] === 0) delete company.types[doc.type];
    }
    company.lastUpdated = new Date().toISOString();
    if (company.docCount === 0) delete index.companies[doc.stockCode];
  }
}

fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');

// 4) 自检：坏链接 + companies 计数自洽性
let broken = 0;
for (const doc of Object.values(index.documents || {})) {
  if (!fs.existsSync(resolveDocPath(doc))) broken++;
}
const actual = {};
for (const doc of Object.values(index.documents || {})) {
  actual[doc.stockCode] = (actual[doc.stockCode] || 0) + 1;
}
const mismatch = [];
for (const [code, c] of Object.entries(index.companies || {})) {
  const real = actual[code] || 0;
  if ((c.docCount || 0) !== real) mismatch.push(`${code} 记录 docCount=${c.docCount} 实际=${real}`);
}
for (const code of Object.keys(actual)) {
  if (!index.companies[code]) mismatch.push(`${code} 有文档但 companies 无条目`);
}

console.log(`\n完成：删除孤儿记录 ${removed} 条，涉及 company ${touchedCompanies.size} 个`);
console.log(`索引现存 documents=${Object.keys(index.documents || {}).length}，companies=${Object.keys(index.companies || {}).length}，坏链接=${broken}`);
console.log(`计数自洽性：${mismatch.length === 0 ? '全部一致' : mismatch.length + ' 处不一致'}`);
for (const m of mismatch.slice(0, 20)) console.log('  [不一致] ' + m);
console.log(`留痕：${path.basename(bak)} / orphan-cleanup-${stamp}.json / orphan-cleanup-${stamp}.log`);
