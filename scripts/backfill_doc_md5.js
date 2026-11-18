/**
 * scripts/backfill_doc_md5.js —— 给资料库现有记录回填内容 MD5
 * ------------------------------------------------------------
 * [20261117a] 去重判据由「文件名」改为「内容 MD5」后，历史记录缺少 md5 字段，
 * 需一次性补齐，否则新文件无法与既有记录做内容比对（会退化成按报告期误判）。
 *
 * 留痕：
 *   data/cache/md5-backfill-<时间戳>.log    每条记录的 md5 与文件路径
 *   data/index.json.bak-md5backfill-<时间戳> 回填前的索引备份
 *
 * 用法：
 *   node scripts/backfill_doc_md5.js           # 预演（统计待回填数量）
 *   node scripts/backfill_doc_md5.js --apply   # 执行
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19).replace('T', '');

function resolveDocPath(doc) {
  const rp = (doc.relativePath || '').replace(/\\/g, '/');
  return rp
    ? path.join(DATA_DIR, rp)
    : path.join(DATA_DIR, 'companies', doc.stockCode, doc.type, doc.fileName);
}

function md5Of(p) {
  try { return crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex'); }
  catch (e) { return ''; }
}

const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const docs = Object.entries(index.documents || {});
const todo = [];
const skipped = { hasMd5: 0, noFile: 0 };
for (const [id, doc] of docs) {
  if (doc.md5) { skipped.hasMd5++; continue; }
  const full = resolveDocPath(doc);
  if (!fs.existsSync(full)) { skipped.noFile++; continue; }
  todo.push({ id, doc, full });
}

console.log(`documents 共 ${docs.length} 条：已有 md5 ${skipped.hasMd5}，文件缺失 ${skipped.noFile}，待回填 ${todo.length}`);

if (!APPLY) {
  console.log('\n[dry-run] 未做任何改动。确认后加 --apply 执行。');
  process.exit(0);
}
if (todo.length === 0) { console.log('无待回填记录。'); process.exit(0); }

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
const bak = `${INDEX_FILE}.bak-md5backfill-${stamp}`;
fs.copyFileSync(INDEX_FILE, bak);

const log = [`# MD5 回填  ${new Date().toISOString()}`, `# 索引备份: ${path.basename(bak)}`, ''];
let done = 0, failed = 0, totalBytes = 0;
for (const { id, doc, full } of todo) {
  const md5 = md5Of(full);
  if (!md5) { failed++; log.push(`FAIL\t${id}\t${doc.stockCode}\t${doc.fileName}`); continue; }
  doc.md5 = md5;
  doc.md5BackfilledAt = new Date().toISOString();
  done++;
  try { totalBytes += fs.statSync(full).size; } catch (e) {}
  log.push(`OK\t${id}\t${doc.stockCode}\t${doc.type}\t${doc.year}\t${md5}\t${path.relative(DATA_DIR, full).replace(/\\/g, '/')}`);
}

fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
log.push('', `# 完成：成功 ${done}，失败 ${failed}`);
fs.writeFileSync(path.join(CACHE_DIR, `md5-backfill-${stamp}.log`), log.join('\r\n'), 'utf8');

console.log(`完成：回填 ${done} 条，失败 ${failed}，扫描 ${(totalBytes / 1048576).toFixed(1)} MB`);
console.log(`留痕：${path.basename(bak)} / md5-backfill-${stamp}.log`);
