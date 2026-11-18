/**
 * scripts/cleanup_dup_pdfs.js —— 年报 PDF 去重（按内容 MD5 分组）
 * ----------------------------------------------------------------
 * 背景：同一份公告可能经「巨潮」和「东方财富」两个通道各下载一次，两个通道返回的
 * 公告标题格式不同（一个带股票简称前缀、一个不带），导致同一份 PDF 落成两个文件名；
 * registerDownloadedReports 以 relativePath 去重，文件名不同即各登记一条文档记录，
 * 于是资料库出现内容完全相同的重复条目（index.json 里是两条）。
 *
 * 处理规则：
 *   1) 仅扫描 data/reports 与 scripts/data/reports 两个目录（不碰 companies，人工资料不动）；
 *   2) 按内容 MD5 + 文件大小分组，同组视为同一份文件；
 *   3) 每组保留「文件名最短」的那份（即标题里不含冗余简称/代码前缀的版本），其余删除；
 *   4) 删除被删文件在 data/index.json 里对应的文档记录，并同步 companies 的 docCount/types 计数
 *      （与 lib/docStore.js 的 deleteDocument 同口径）；
 *   5) 执行前自动备份 index.json 为 index.json.bak-dupclean-<时间戳>。
 *
 * 用法：
 *   node scripts/cleanup_dup_pdfs.js           # 预演，只打印计划，不删任何东西
 *   node scripts/cleanup_dup_pdfs.js --apply   # 实际执行
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const SCAN_DIRS = [
  path.join(DATA_DIR, 'reports'),
  path.join(__dirname, 'data', 'reports'),
];

function md5Of(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function walkPdfs(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walkPdfs(full, out);
    else if (/\.pdf$/i.test(name)) out.push({ full, size: st.size });
  }
}

// 1) 收集并分组
const files = [];
for (const d of SCAN_DIRS) walkPdfs(d, files);
const groups = new Map();
for (const f of files) {
  const key = md5Of(f.full) + '|' + f.size;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(f);
}

const plan = [];   // { del, keep }
let wasteBytes = 0;
for (const [, list] of groups) {
  if (list.length < 2) continue;
  // 保留文件名最短的（长度相同取字典序靠前，保证结果稳定可复现）
  list.sort((a, b) => path.basename(a.full).length - path.basename(b.full).length
    || path.basename(a.full).localeCompare(path.basename(b.full)));
  const keep = list[0];
  for (const del of list.slice(1)) {
    plan.push({ del, keep });
    wasteBytes += del.size;
  }
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
console.log(`扫描 ${files.length} 个 PDF，重复组 ${[...groups.values()].filter((l) => l.length > 1).length} 个，待删 ${plan.length} 个文件，可回收 ${(wasteBytes / 1048576).toFixed(1)} MB`);
for (const { del, keep } of plan) {
  console.log(`  DEL ${(del.size / 1048576).toFixed(1).padStart(6)} MB  ${rel(del.full)}`);
  console.log(`      保留：${rel(keep.full)}`);
}

if (!APPLY) {
  console.log('\n[dry-run] 未做任何改动。确认无误后加 --apply 执行。');
  process.exit(0);
}

// 2) 备份索引
const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const bak = `${INDEX_FILE}.bak-dupclean-${stamp}`;
fs.copyFileSync(INDEX_FILE, bak);
console.log('\n已备份索引：' + rel(bak));

// relativePath -> docId 映射（docStore 口径：相对 data 目录）
const rel2ids = new Map();
for (const [id, doc] of Object.entries(index.documents || {})) {
  const rp = (doc.relativePath || '').replace(/\\/g, '/');
  if (rp) {
    if (!rel2ids.has(rp)) rel2ids.set(rp, []);
    rel2ids.get(rp).push(id);
  }
}

// 3) 删文件 + 删索引记录（复刻 docStore.deleteDocument 的计数逻辑）
let removedFiles = 0;
let removedDocs = 0;
let failed = 0;
for (const { del } of plan) {
  try {
    fs.unlinkSync(del.full);
    removedFiles++;
  } catch (e) {
    console.error(`  删除文件失败 ${rel(del.full)}：${e.message}`);
    failed++;
    continue;
  }
  const key = path.relative(DATA_DIR, del.full).replace(/\\/g, '/');
  const ids = rel2ids.get(key) || [];
  for (const id of ids) {
    const doc = index.documents[id];
    if (!doc) continue;
    delete index.documents[id];
    removedDocs++;
    const company = index.companies && index.companies[doc.stockCode];
    if (company) {
      company.docCount = Math.max(0, (company.docCount || 0) - 1);
      if (company.types && company.types[doc.type]) {
        company.types[doc.type] = Math.max(0, company.types[doc.type] - 1);
        if (company.types[doc.type] === 0) delete company.types[doc.type];
      }
      company.lastUpdated = new Date().toISOString();
      if (company.docCount === 0) delete index.companies[doc.stockCode];
    }
  }
}

// 4) 落盘索引 + 坏链接自检
fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');

let broken = 0;
for (const doc of Object.values(index.documents || {})) {
  const rp = (doc.relativePath || '').replace(/\\/g, '/');
  const full = rp
    ? path.join(DATA_DIR, rp)
    : path.join(DATA_DIR, 'companies', doc.stockCode, doc.type, doc.fileName);
  if (!fs.existsSync(full)) {
    broken++;
    console.log(`  [坏链接] ${doc.stockCode} ${doc.fileName}`);
  }
}

console.log(`\n完成：删除文件 ${removedFiles} 个，清理索引记录 ${removedDocs} 条，失败 ${failed} 个`);
console.log(`回收空间 ${(wasteBytes / 1048576).toFixed(1)} MB`);
console.log(`索引现存 documents=${Object.keys(index.documents || {}).length}，坏链接=${broken}`);
