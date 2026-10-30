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

// [20261029m] 从标题解析「报告期类型+年份」。docStore 登记的 year 取的是文件名首个日期
// = 公告日期年份：「2026-04-28 发布的《2026年第一季度报告》」与「2026-03-27 发布的
// 《2025年度报告》」都被标 year=2026——前者错误挡住 2026 三季报同步（603288/000783
// 实证：hasReportDoc 假阳性），后者年份显示错 +1。口径与 lib/ai/earnings.js pickReportDoc 一致。
const PERIOD_PATS = [
  { type: 'annual', re: /(\d{4})年年度报告/ },
  { type: 'semi', re: /(\d{4})年(?:半年度|中期)报告/ },
  { type: 'q1', re: /(\d{4})年第?一季度报告/ },
  { type: 'q3', re: /(\d{4})年第?三季度报告/ },
];
function reportPeriodOf(text) {
  for (const p of PERIOD_PATS) {
    const m = String(text || '').match(p.re);
    if (m) return { type: p.type, year: m[1] };
  }
  return null;
}

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

/**
 * 检查资料库是否已持有某报告期文档。
 * [20261029m] 按标题解析报告期年份+季度（docStore.year 是公告年，不可靠）；
 * quarterly 事件按标题收窄到具体季度，避免「已有 Q1」挡住 Q3。
 */
function hasReportDoc(symbol, type, year, title) {
  const code = normSymbol(symbol);
  const docs = docStore.listCompanyDocuments(code);
  const t = String(title || '');
  const want = type === 'quarterly'
    ? (/三季报|第三季度/.test(t) ? 'q3' : /一季报|第一季度/.test(t) ? 'q1' : null)
    : (type === 'annual' || type === 'semi') ? type : null;
  const periodOf = d => reportPeriodOf(`${d.title || ''} ${d.fileName || ''}`);
  if (want) {
    return docs.some(d => {
      const p = periodOf(d);
      return p && p.type === want && p.year === String(year);
    });
  }
  // 泛称「季报」（未指明季度）：该年任意季度报告均视为已覆盖
  return docs.some(d => {
    const p = periodOf(d);
    return p && (p.type === 'q1' || p.type === 'q3') && p.year === String(year);
  });
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

/**
 * [20261029l] 事件类型 → 下载脚本类型参数。
 * 脚本合法键为 annual/semi/q1/q3（无 quarterly）：此前直接传 quarterly 被脚本
 * 静默丢弃并回退 annual,semi（静默降级 bug），三季报/一季报从未被下载过
 * （2026-10-29 华安证券 600909 用户报障，全自选股同因）。按事件标题收窄季度，
 * 泛称「季报」时 q1+q3 都查。
 */
function scriptTypesFor(event) {
  if (event.type !== 'quarterly') return event.type;   // annual / semi 原样
  const t = String(event.title || '');
  if (/三季报|第三季度/.test(t)) return 'q3';
  if (/一季报|第一季度/.test(t)) return 'q1';
  return 'q1,q3';
}

/**
 * [20261029l] 新文档落地后定点失效该股财报解读缓存。
 * earnings 缓存 TTL 30 天：PDF 变了但缓存未失效 → 财报解读停留在旧报告节选
 * （用户感知「资料库更新了、财报解读不更新」）。删除 {code}_earnings.json，
 * 下次打开个股页自动按新 PDF 重算（LLM 重算仅在用户打开时触发，不主动耗额度）。
 */
function invalidateEarningsCache(code) {
  const f = path.join(__dirname, '..', 'data', 'ai_cache', `${code}_earnings.json`);
  try {
    if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`[reportSync] 已失效 ${code} 财报解读缓存（新文档落地）`); return true; }
  } catch (e) { console.error('[reportSync] 失效财报解读缓存失败:', e.message); }
  return false;
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
      // [20261029m] year = 报告期年份（标题解析），公告日期年份仅兜底；类型同步按标题判定
      const per = reportPeriodOf(f);
      let type;
      if (per) type = (per.type === 'q1' || per.type === 'q3') ? 'quarterly' : per.type;
      else if (/(中期报告|半年度报告)/.test(f)) type = 'semi';
      else if (/(季度报告|一季报|三季报)/.test(f)) type = 'quarterly';
      else type = 'annual';
      const ym = f.match(/(\d{4})-(\d{2})-(\d{2})/);
      const year = per ? per.year : (ym ? ym[1] : '');
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
  if (hasReportDoc(code, type, year, event && event.title)) {
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
      '--types', scriptTypesFor(event),   // [20261029l] quarterly → q3/q1（按标题收窄），不再静默降级
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
    // 4) 登记新下载文件（有新文档 → 定点失效该股财报解读缓存，下次打开自动按新 PDF 重算）
    const registered = registerDownloadedReports();
    if (registered > 0) invalidateEarningsCache(code);

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
    const gapNow = !hasReportDoc(code, type, year, event && event.title);
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
  reportPeriodOf,
  normSymbol,
};
