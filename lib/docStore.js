/**
 * Document Store Module
 * 本地文档存储系统 — 按公司存储年报、季报、公告等文件
 * 
 * 目录结构: data/companies/{stockCode}/{type}/{filename}
 * 元数据索引: data/index.json
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const COMPANIES_DIR = path.join(DATA_DIR, 'companies');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

// 文档类型定义
// 20260821f：新增 semi（半年报）类型——「中期报告/半年度报告」与「年度报告」「季度报告」区分开，
// 保证判断引擎识别的财报事件（如"2026年中报发布"）与资料库分类口径一致。
const DOC_TYPES = {
  annual: { key: 'annual', label: '年报', icon: '📋' },
  semi: { key: 'semi', label: '半年报', icon: '📅' },
  quarterly: { key: 'quarterly', label: '季报', icon: '📅' },
  announcement: { key: 'announcement', label: '公告', icon: '📢' },
  research: { key: 'research', label: '研报', icon: '📊' },
  other: { key: 'other', label: '其他', icon: '📄' },
};

// 确保目录存在
function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(COMPANIES_DIR)) fs.mkdirSync(COMPANIES_DIR, { recursive: true });
  if (!fs.existsSync(INDEX_FILE)) {
    fs.writeFileSync(INDEX_FILE, JSON.stringify({ documents: {}, companies: {} }, null, 2), 'utf8');
  }
}

// 读取索引
function readIndex() {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
  } catch (e) {
    return { documents: {}, companies: {} };
  }
}

// 写入索引
function writeIndex(index) {
  ensureDirs();
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf8');
}

// 生成文档ID
function generateDocId() {
  return 'doc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
}

/**
 * 添加文档
 * @param {Object} params - { stockCode, stockName, type, fileName, filePath, fileSize, year, quarter, title, description }
 * @returns {Object} 文档元数据
 */
function addDocument(params) {
  const index = readIndex();
  const docId = generateDocId();
  
  const doc = {
    id: docId,
    stockCode: params.stockCode,
    stockName: params.stockName || '',
    type: params.type || 'other',
    typeName: DOC_TYPES[params.type]?.label || '其他',
    fileName: params.fileName,
    fileSize: params.fileSize || 0,
    fileType: path.extname(params.fileName).toLowerCase(),
    year: params.year || '',
    quarter: params.quarter || '',
    title: params.title || params.fileName,
    description: params.description || '',
    uploadedAt: new Date().toISOString(),
    relativePath: params.relativePath || '',
  };

  // 存入索引
  index.documents[docId] = doc;

  // 更新公司索引
  if (!index.companies[params.stockCode]) {
    index.companies[params.stockCode] = {
      stockCode: params.stockCode,
      stockName: params.stockName || '',
      docCount: 0,
      types: {},
      lastUpdated: new Date().toISOString(),
    };
  }
  const company = index.companies[params.stockCode];
  company.stockName = params.stockName || company.stockName;
  company.docCount = (company.docCount || 0) + 1;
  if (!company.types[doc.type]) company.types[doc.type] = 0;
  company.types[doc.type]++;
  company.lastUpdated = new Date().toISOString();

  writeIndex(index);
  return doc;
}

/**
 * 获取公司的所有文档
 */
function listCompanyDocuments(stockCode) {
  const index = readIndex();
  const docs = Object.values(index.documents)
    .filter(d => d.stockCode === stockCode)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
  return docs;
}

/**
 * 获取公司统计信息
 */
function getCompanyInfo(stockCode) {
  const index = readIndex();
  const company = index.companies[stockCode];
  if (!company) return null;
  const docs = listCompanyDocuments(stockCode);
  return {
    ...company,
    documents: docs,
    typeBreakdown: Object.entries(company.types || {}).map(([type, count]) => ({
      type,
      typeName: DOC_TYPES[type]?.label || type,
      icon: DOC_TYPES[type]?.icon || '📄',
      count,
    })),
  };
}

/**
 * 列出所有有文档的公司
 */
function listAllCompanies() {
  const index = readIndex();
  return Object.values(index.companies || {})
    .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));
}

/**
 * 获取文档完整路径
 * 若文档记录带有 relativePath（外部存储，如 data/reports 下），优先按相对路径解析。
 */
function getDocumentPath(docId) {
  const index = readIndex();
  const doc = index.documents[docId];
  if (!doc) return null;
  const fullPath = doc.relativePath
    ? path.join(DATA_DIR, doc.relativePath)
    : path.join(COMPANIES_DIR, doc.stockCode, doc.type, doc.fileName);
  return { doc, fullPath };
}

/**
 * 按 relativePath 查找文档（用于避免重复登记已下载的文件）
 */
function findByRelativePath(relPath) {
  const index = readIndex();
  return Object.values(index.documents).find(d => d.relativePath === relPath) || null;
}

/**
 * 删除文档
 */
function deleteDocument(docId) {
  const index = readIndex();
  const doc = index.documents[docId];
  if (!doc) return { success: false, error: '文档不存在' };

  // 删除文件（外部存储文件同样删，但 data/reports 下的年报通常希望保留，这里仍按记录删除）
  const filePath = doc.relativePath
    ? path.join(DATA_DIR, doc.relativePath)
    : path.join(COMPANIES_DIR, doc.stockCode, doc.type, doc.fileName);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.error('Delete file error:', e.message);
  }

  // 更新索引
  delete index.documents[docId];
  const company = index.companies[doc.stockCode];
  if (company) {
    company.docCount = Math.max(0, (company.docCount || 0) - 1);
    if (company.types[doc.type]) {
      company.types[doc.type] = Math.max(0, company.types[doc.type] - 1);
      if (company.types[doc.type] === 0) delete company.types[doc.type];
    }
    company.lastUpdated = new Date().toISOString();
    if (company.docCount === 0) {
      delete index.companies[doc.stockCode];
    }
  }

  writeIndex(index);
  return { success: true };
}

/**
 * 搜索文档
 */
function searchDocuments(query) {
  const index = readIndex();
  const q = query.toLowerCase().trim();
  if (!q) return [];
  
  return Object.values(index.documents).filter(d => {
    return (d.title || '').toLowerCase().includes(q) ||
           (d.fileName || '').toLowerCase().includes(q) ||
           (d.stockName || '').toLowerCase().includes(q) ||
           (d.stockCode || '').toLowerCase().includes(q) ||
           (d.description || '').toLowerCase().includes(q) ||
           (d.year || '').includes(q);
  }).sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));
}

/**
 * 获取存储路径
 */
function getStoragePath(stockCode, type) {
  const dir = path.join(COMPANIES_DIR, stockCode, type);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 获取存储统计
 */
function getStorageStats() {
  const index = readIndex();
  const docs = Object.values(index.documents);
  const totalSize = docs.reduce((sum, d) => sum + (d.fileSize || 0), 0);
  
  const typeStats = {};
  for (const [key, val] of Object.entries(DOC_TYPES)) {
    typeStats[key] = {
      label: val.label,
      icon: val.icon,
      count: docs.filter(d => d.type === key).length,
    };
  }
  
  return {
    totalDocuments: docs.length,
    totalCompanies: Object.keys(index.companies || {}).length,
    totalSize,
    totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100,
    typeStats,
  };
}

module.exports = {
  DOC_TYPES,
  ensureDirs,
  addDocument,
  listCompanyDocuments,
  getCompanyInfo,
  listAllCompanies,
  getDocumentPath,
  findByRelativePath,
  deleteDocument,
  searchDocuments,
  getStoragePath,
  getStorageStats,
};
