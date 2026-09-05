/**
 * Report Sync Module (20260821f)
 * =====================================================================
 * 财报事件 → 资料库自动同步
 *
 * 一致性原则：判断引擎/公告源检测到某标的发布了最新定期报告（年报/半年报/季报）时，
 * 自动检查资料库（docStore）是否已持有该报告期的 PDF；若缺失，自动触发下载脚本
 * （scripts/download_reports.py，巨潮优先）并登记进资料库。
 *
 * 幂等约束：
 *  - 进程内 _inflight 防并发：同一 (symbol,type,year) 同时只允许一个下载任务；
 *  - 持久化状态 data/report_sync.json：每个 (symbol,type,year) 每日仅同步一次；
 *  - 下载脚本自身有 _downloaded.json 去重清单，重复调用不会重复下载。
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const docStore = require('./docStore');

const SYNC_STATE_FILE = path.join(__dirname, '..', 'data', 'report_sync.json');
const DOWNLOAD_SCRIPT = path.join(__dirname, '..', 'scripts', 'download_reports.py');
const REPORTS_OUT_DIR = path.join(__dirname, '..', 'data', 'reports');

const _inflight = new Set(); // `${symbol}:${type}:${year}`

// 报告标题识别：兼容「2026年中期报告」「2026年半年度报告」「2025年年度报告」
// 「2024_年半年度报告」（下划线变体）「2026年半年度报告全文」等写法。
// 20260821f 增强：单独提取年份后按剩余文本判断类型，兼容「2026年中期拟派现」、
// 「2026年中期业绩发布会」「2026中报」等不含"报告"字样的中报事件标题，
// 避免判断引擎已捕捉到中报事件、资料库联动却因标题字面不匹配而漏检。
const REPORT_YEAR_RE = /(20\d{2})/;
const SEMI_RE = /(中期报告|半年度报告|半年报|中期|中报)/;
const QUARTER_RE = /(季度报告|一季报|三季报|季报)/;
const ANNUAL_RE = /(年度报告|年报)/;

const TYPE_LABEL = { annual: '年报', semi: '半年报', quarterly: '季报' };

function normSymbol(s) {
  return String(s || '').replace(/^(SH|SZ|BJ|HK)/i, '').replace(/\.(SS|SZ|BJ|HK)$/i, '').toUpperCase();
}

/**
 * 从新闻/公告标题中检测最新财报发布事件。
 * @param {string} symbol 股票代码（可带 SH/SZ 前缀）
 * @param {string} name   股票名称
 * @param {Array}  newsList   个股新闻列表 [{title,date}]
 * @param {Array}  announceList 公告列表 [{title,date}]
 * @returns {null|{symbol,type,year,title,date}}
 */
function detectReportEvent(symbol, name, newsList = [], announceList = []) {
  const titles = [];
  for (const n of newsList || []) if (n && n.title) titles.push({ title: String(n.title), date: n.date || '' });
  for (const a of announceList || []) if (a && a.title) titles.push({ title: String(a.title), date: a.date || '' });
  let best = null;
  for (const t of titles) {
    const m = t.title.match(REPORT_YEAR_RE);
    if (!m) continue;
    const year = m[1];
    const rest = t.title.slice((m.index || 0) + m[0].length);
    let type = null;
    if (SEMI_RE.test(rest)) type = 'semi';
    else if (QUARTER_RE.test(rest)) type = 'quarterly';
    else if (ANNUAL_RE.test(rest)) type = 'annual';
    if (!type) continue;
    // 取最近一年份的事件（同一年取第一条即可）
    if (!best || year > best.year) {
      best = { symbol: normSymbol(symbol), type, year, title: t.title, date: t.date };
    }
  }
  return best;
}

/** 检查资料库是否已持有某报告期文档 */
function hasReportDoc(symbol, type, year) {
  const code = normSymbol(symbol);
  const docs = docStore.listCompanyDocuments(code);
  return docs.some(d => d.type === type && String(d.year) === String(year));
}

/** 读取同步状态（幂等记录） */
function readSyncState() {
  try { return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8')); }
  catch (e) { return {}; }
}

function writeSyncState(state) {
  try {
    fs.mkdirSync(path.dirname(SYNC_STATE_FILE), { recursive: true });
    fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) { console.error('[reportSync] 写状态失败:', e.message); }
}

/** 是否今日已同步过该事件 */
function _doneToday(key, today) {
  const st = readSyncState();
  const rec = st[key];
  return !!(rec && rec.doneAt && String(rec.doneAt).slice(0, 10) === today);
}

function _today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 查找 Python 解释器（与 server.js findPython 同源候选，避免重复探测开销） */
let _pyChecked = false;
let _pyCache = null;
function findPython() {
  if (_pyChecked) return _pyCache;
  const candidates = [
    process.env.PYTHON_BIN,
    'C:/Users/16507/.workbuddy/binaries/python/envs/default/Scripts/python.exe',
    'C:/Users/16507/.workbuddy/binaries/python/versions/3.13.12/python.exe',
    'python3',
    'python',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const r = cp.spawnSync(c, ['--version'], { timeout: 5000, windowsHide: true });
      if (!r.error) { _pyCache = c; _pyChecked = true; return c; }
    } catch (e) { /* continue */ }
  }
  _pyCache = null; _pyChecked = true;
  return null;
}

/** 登记 data/reports 下新下载的 PDF（与 server.js registerDownloadedReports 同逻辑，供 lib 独立调用） */
function registerDownloadedReports() {
  const reportsDir = REPORTS_OUT_DIR;
  if (!fs.existsSync(reportsDir)) return 0;
  let registered = 0;
  for (const codeDir of fs.readdirSync(reportsDir)) {
    const dir = path.join(reportsDir, codeDir);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.pdf$/i.test(f)) continue;
      const relPath = `reports/${codeDir}/${f}`;
      if (docStore.findByRelativePath(relPath)) continue;
      let type = 'annual';
      if (/(中期报告|半年度报告)/.test(f)) type = 'semi';
      else if (/(季度报告|一季报|三季报)/.test(f)) type = 'quarterly';
      const ym = f.match(/(\d{4})-(\d{2})-(\d{2})/);
      const year = ym ? ym[1] : '';
      const full = path.join(dir, f);
      let size = 0;
      try { size = fs.statSync(full).size; } catch (e) {}
      docStore.addDocument({
        stockCode: codeDir,
        stockName: '',
        type,
        fileName: f,
        fileSize: size,
        year,
        relativePath: relPath,
        title: f.replace(/\.pdf$/i, ''),
      });
      registered++;
    }
  }
  if (registered > 0) console.log(`[reportSync] Registered ${registered} report file(s) into doc store.`);
  return registered;
}

/**
 * 同步某标的的指定报告期：若资料库缺失则下载并登记。
 * 幂等：进程内防并发 + 每日每 (symbol,type,year) 一次。
 * @param {{symbol,type,year,title,date}} event detectReportEvent 返回的事件
 * @returns {Promise<{ok,event,gap,downloaded,registered,reason}>}
 */
async function syncReportForSymbol(event) {
  const code = normSymbol(event && event.symbol);
  const type = event && event.type;
  const year = event && event.year;
  if (!code || !type || !year) return { ok: false, reason: '事件缺少 code/type/year' };

  // 1) 缺口检查：资料库已有该报告期文档 → 无需同步
  if (hasReportDoc(code, type, year)) {
    return { ok: true, gap: false, reason: '资料库已有 ' + year + ' ' + (TYPE_LABEL[type] || type) };
  }

  // 2) 幂等：今日已同步过 / 正在同步 → 跳过
  const key = `${code}:${type}:${year}`;
  const today = _today();
  if (_doneToday(key, today)) {
    return { ok: false, gap: true, reason: '今日已尝试同步，跳过（见 data/report_sync.json）' };
  }
  if (_inflight.has(key)) {
    return { ok: false, gap: true, reason: '同步任务进行中，跳过' };
  }
  _inflight.add(key);

  try {
    // 3) 触发下载脚本（仅该类型、回溯 1 年，巨潮优先）
    const py = findPython();
    if (!py) {
      const msg = '未找到 Python 解释器';
      _markDone(key, today, 'error', msg);
      return { ok: false, gap: true, reason: msg };
    }
    if (!fs.existsSync(DOWNLOAD_SCRIPT)) {
      const msg = '下载脚本不存在: ' + DOWNLOAD_SCRIPT;
      _markDone(key, today, 'error', msg);
      return { ok: false, gap: true, reason: msg };
    }
    const args = [
      DOWNLOAD_SCRIPT,
      '--codes', code,
      '--years', '1',
      '--types', type,
      '--out', REPORTS_OUT_DIR,
      '--channel', 'cninfo',
      '--json',
    ];
    console.log(`[reportSync] 触发下载: ${py} ${args.join(' ')}`);
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFileP = promisify(execFile);
    let stdout = '';
    try {
      const r = await execFileP(py, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 180000 });
      stdout = r.stdout || '';
    } catch (e) {
      stdout = (e.stdout || '') + (e.stderr || '');
    }
    // 4) 登记新下载文件
    const registered = registerDownloadedReports();

    // 5) 汇总结果
    let downloaded = 0, skipped = 0, errors = 0;
    const m = stdout.match(/RESULT_JSON:(\{[\s\S]*\})/);
    if (m) {
      try {
        const summary = JSON.parse(m[1]);
        downloaded = summary.downloaded || 0;
        skipped = summary.skipped || 0;
        errors = summary.errors || 0;
      } catch (e) {}
    }
    const gapNow = !hasReportDoc(code, type, year);
    const status = (downloaded > 0 || registered > 0) ? 'ok' : (gapNow ? 'error' : 'ok');
    const reason = gapNow
      ? `下载未命中（脚本 downloaded=${downloaded} skipped=${skipped} errors=${errors}），资料库仍缺 ${year} ${TYPE_LABEL[type] || type}`
      : `已同步 ${year} ${TYPE_LABEL[type] || type}（新下载 ${downloaded}，登记 ${registered}）`;
    _markDone(key, today, status, reason);
    return { ok: !gapNow, gap: gapNow, downloaded, skipped, errors, registered, reason };
  } finally {
    _inflight.delete(key);
  }
}

function _markDone(key, today, status, reason) {
  const st = readSyncState();
  st[key] = { doneAt: new Date().toISOString(), date: today, status, reason };
  writeSyncState(st);
}

/**
 * 获取某标的的「资料同步状态」概览（供前端展示）。
 * @returns {{code, gaps:[], events:[]}}
 */
function getSyncStatus(symbol) {
  const code = normSymbol(symbol);
  const st = readSyncState();
  const events = [];
  for (const [k, rec] of Object.entries(st)) {
    if (k.startsWith(code + ':')) events.push({ key: k, ...rec });
  }
  events.sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
  return { code, events };
}

module.exports = {
  detectReportEvent,
  hasReportDoc,
  syncReportForSymbol,
  getSyncStatus,
  registerDownloadedReports,
  normSymbol,
};
