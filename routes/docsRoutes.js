/**
 * 资料库（docs）路由（20260906 自 server.js 拆出·第一阶段）
 * ----------------------------------------------------------------------------
 * 仅做路由搬运：upload / fixGarbledName / classifyFile 与 11 条 /api/docs 路由
 * 处理器主体与 server.js 原实现逐字一致，输出格式零变化。
 * 挂载方式：server.js 中 app.use(docsRoutes)（路由内部保留完整 /api 前缀路径）。
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const docStore = require('../lib/docStore');
const reportSync = require('../lib/reportSync');
const { searchStocks } = require('../lib/stockData');

const router = express.Router();

// ---- 文件上传配置 (multer) ----
// 先存到临时目录，解析完body字段后再移动到正确位置
const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(os.tmpdir()),
    filename: (req, file, cb) => {
      cb(null, 'upload_' + Date.now() + '_' + Math.random().toString(36).substr(2, 8) + path.extname(file.originalname));
    },
  }),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
});

// 修复 multer 将 UTF-8 中文文件名误按 latin1 解码造成的乱码（Mojibake）
function fixGarbledName(s) {
  if (!s) return s;
  // 若含非 latin1 字符（码点 > 255），说明已经是正确 UTF-8，直接返回
  if (/[^\u0000-\u00ff]/.test(s)) return s;
  try {
    return Buffer.from(s, 'latin1').toString('utf8');
  } catch {
    return s;
  }
}

// 根据文件名自动识别：公司、年份、报告类型、季度
// 返回 { fileName, year, quarter, type, stockCode, stockName, title, matched, confidence }
async function classifyFile(filename) {
  const name = fixGarbledName(filename || '');
  const result = {
    fileName: name,
    year: '',
    quarter: '',
    type: 'other',
    stockCode: '',
    stockName: '',
    title: name,
    matched: false,
    confidence: 0,
  };

  // 1) 年份（4 位，19xx / 20xx）
  const ym = name.match(/(?:19|20)\d{2}/);
  if (ym) result.year = ym[0];

  // 2) 报告类型
  if (/年报|年度报告|annual/i.test(name)) {
    result.type = 'annual';
  } else if (/一季报|第一季度|一季度/i.test(name)) {
    result.type = 'quarterly'; result.quarter = 'Q1';
  } else if (/半年报|中报|半年度报告|半年度|二季度|第二季度/i.test(name)) {
    result.type = 'quarterly'; result.quarter = 'Q2';
  } else if (/三季报|第三季度|三季度/i.test(name)) {
    result.type = 'quarterly'; result.quarter = 'Q3';
  } else if (/四季报|第四季度|四季度/i.test(name)) {
    result.type = 'quarterly'; result.quarter = 'Q4';
  } else if (/季报|季度报告|quarter/i.test(name)) {
    result.type = 'quarterly';
  } else if (/公告|通告|提示性/i.test(name)) {
    result.type = 'announcement';
  } else if (/研报|研究报告|深度报告|券商/i.test(name)) {
    result.type = 'research';
  }

  // 3) 公司识别：优先尝试 6 位股票代码，其次中文/英文公司名
  const codeMatch = name.match(/(?:sh|sz|SH|SZ)?\s*(\d{6})/);
  const candidateCode = codeMatch ? codeMatch[1] : '';

  const KEYWORDS = ['年度报告','半年报','中报','半年度报告','半年度','第一季度','一季报','一季度','第三季度','三季报','三季度','第四季度','四季报','四季度','季报','季度报告','年报','公告','通告','提示性公告','研报','研究报告','深度报告','券商','报告','摘要','全文','数据'];
  let candidate = name.replace(/\.[^.]+$/, '');              // 去扩展名
  candidate = candidate.replace(/(?:19|20)\d{2}年?/g, ' ');   // 去年份（含"年"）
  KEYWORDS.forEach(k => { candidate = candidate.split(k).join(' '); });
  candidate = candidate.replace(/[年月度至]/g, ' ');          // 清除残余日期字符
  candidate = candidate.replace(/[^\u4e00-\u9fa5A-Za-z]/g, ''); // 只保留中文与字母
  candidate = candidate.trim();

  const tryResolve = async (kw) => {
    if (!kw) return null;
    try {
      const matches = await searchStocks(kw);
      if (matches && matches.length) {
        // searchStocks 查不到时会回退为 {name:kw}，需剔除
        if (matches.length === 1 && matches[0].name === kw) return null;
        // 优先选择与候选名互相包含的结果
        let best = matches.find(m => m.name && (m.name.includes(kw) || kw.includes(m.name)));
        if (!best) best = matches[0];
        return best;
      }
    } catch (e) { /* ignore */ }
    return null;
  };

  let best = null;
  if (candidateCode) best = await tryResolve(candidateCode);
  if (!best && candidate) best = await tryResolve(candidate);
  if (!best && candidate && candidate.length >= 2) best = await tryResolve(candidate.slice(0, 4));

  if (best) {
    result.stockCode = best.symbol || best.code;
    result.stockName = best.name;
    result.matched = true;
    result.confidence = (best.name && candidate && (best.name.includes(candidate) || candidate.includes(best.name))) ? 1 : 0.6;
  }

  return result;
}

// 上传文档
// 文件名自动识别预览（批量上传前调用，返回每文件的识别结果）
router.post('/api/docs/classify', async (req, res) => {
  try {
    const filenames = Array.isArray(req.body.filenames) ? req.body.filenames : [];
    const results = [];
    for (const fn of filenames) {
      results.push(await classifyFile(fn));
    }
    res.json({ ok: true, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 批量 / 单个 文档上传（字段名 files）
router.post('/api/docs/upload', upload.array('files', 100), async (req, res) => {
  try {
    const files = (req.files && req.files.length) ? req.files : (req.file ? [req.file] : []);
    if (files.length === 0) return res.status(400).json({ error: '未收到文件' });

    // 解析前端传来的逐文件元数据（可覆盖自动识别结果）
    let metas = [];
    try { metas = JSON.parse(req.body.metas || '[]'); } catch {}
    if (!Array.isArray(metas)) metas = [];

    const defaultStockCode = req.body.defaultStockCode || '';
    const defaultStockName = req.body.defaultStockName || '';

    const saved = [];
    const errors = [];

    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const meta = metas[i] || {};
      // 优先用前端显式传入的 UTF-8 安全文件名；否则用 multer 解析的 originalname 并修正编码
      const rawName = meta.fileName || f.originalname;
      const fileName = fixGarbledName(rawName);

      let stockCode = meta.stockCode || '';
      let stockName = meta.stockName || '';
      let type = meta.type || '';
      let year = meta.year || '';
      let quarter = meta.quarter || '';
      const title = meta.title || fileName;
      const description = meta.description || '';

      // 仅在缺失时做文件名自动识别
      if (!stockCode || !type || !year) {
        const cls = await classifyFile(fileName);
        stockCode = stockCode || cls.stockCode;
        stockName = stockName || cls.stockName;
        type = type || cls.type;
        year = year || cls.year;
        quarter = quarter || cls.quarter;
      }

      // 未识别到公司时，回退到默认公司（如有）
      if (!stockCode && defaultStockCode) {
        stockCode = defaultStockCode;
        stockName = defaultStockName || stockName;
      }

      if (!stockCode) {
        errors.push({ fileName, error: '未能识别公司，请手动指定或选择默认公司' });
        if (fs.existsSync(f.path)) { try { fs.unlinkSync(f.path); } catch {} }
        continue;
      }
      if (!type) type = 'other';

      const targetDir = docStore.getStoragePath(stockCode, type);
      let finalName = fileName;
      let finalPath = path.join(targetDir, fileName);
      if (fs.existsSync(finalPath)) {
        const ext = path.extname(fileName);
        const base = path.basename(fileName, ext);
        finalName = `${base}_${Date.now()}${ext}`;
        finalPath = path.join(targetDir, finalName);
      }

      fs.renameSync(f.path, finalPath);

      const doc = docStore.addDocument({
        stockCode,
        stockName: stockName || '',
        type,
        fileName: finalName,
        fileSize: f.size,
        year,
        quarter,
        title,
        description,
      });
      saved.push(doc);
    }

    res.json({ success: true, count: saved.length, saved, errors });
  } catch (err) {
    console.error('Upload error:', err);
    // 清理临时文件
    const files = (req.files && req.files.length) ? req.files : (req.file ? [req.file] : []);
    for (const f of files) {
      if (fs.existsSync(f.path)) { try { fs.unlinkSync(f.path); } catch {} }
    }
    res.status(500).json({ error: err.message });
  }
});

// 获取公司文档列表
router.get('/api/docs/company/:stockCode', (req, res) => {
  try {
    const info = docStore.getCompanyInfo(req.params.stockCode);
    if (!info) return res.json({ stockCode: req.params.stockCode, docCount: 0, documents: [], typeBreakdown: [] });
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 列出所有公司
router.get('/api/docs/companies', (req, res) => {
  try {
    const companies = docStore.listAllCompanies();
    const stats = docStore.getStorageStats();
    res.json({ companies, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 搜索文档
router.get('/api/docs/search', (req, res) => {
  try {
    const q = req.query.q || '';
    const results = docStore.searchDocuments(q);
    res.json({ query: q, count: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 下载/查看文档
router.get('/api/docs/download/:docId', (req, res) => {
  try {
    const result = docStore.getDocumentPath(req.params.docId);
    if (!result) return res.status(404).json({ error: '文档不存在' });
    const { doc, fullPath } = result;
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: '文件不存在' });
    res.download(fullPath, doc.fileName);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除文档
router.delete('/api/docs/:docId', (req, res) => {
  try {
    const result = docStore.deleteDocument(req.params.docId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取存储统计
router.get('/api/docs/stats', (req, res) => {
  try {
    res.json(docStore.getStorageStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取文档类型列表
router.get('/api/docs/types', (req, res) => {
  res.json(docStore.DOC_TYPES);
});

// 20260821f 财报事件 → 资料库手动同步：
// 前端在判断卡片/资料库看到缺口时可手动触发下载 + 登记。
// body: { symbol, name?, type?('annual'|'semi'|'quarterly'), year?('2026') }
router.post('/api/docs/sync-report', async (req, res) => {
  try {
    const { symbol, name, type, year } = req.body || {};
    const code = reportSync.normSymbol(symbol);
    if (!code || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: '请提供有效的 6 位股票代码' });
    }
    const evt = {
      symbol: code,
      type: ['annual', 'semi', 'quarterly'].includes(type) ? type : 'semi',
      year: String(year || new Date().getFullYear()),
    };
    const r = await reportSync.syncReportForSymbol(evt);
    res.json({ ok: r.ok, ...r });
  } catch (e) {
    console.error('[docs/sync-report] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 查询某标的的财报资料同步状态（最近事件与幂等记录）
router.get('/api/docs/sync-status/:symbol', (req, res) => {
  try {
    res.json(reportSync.getSyncStatus(req.params.symbol));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
