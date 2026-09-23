/**
 * 板块舆情热度周榜 · 调度入口（20260913h 双社区源）
 * --------------------------------------------------------------
 * GET /api/home-hot-topics 的后端实现（替换旧「今日最热股票话题/涨停板池」逻辑）。
 * - 数据文件：data/hotTopics/daily/{YYYY-MM-DD}.json（每日增量，python 采集器产出）
 *             data/hotTopics/weekly/{ISO周}.json（周榜存档，便于审计/回看）
 * - 社区讨论为双源（20260913h）：东方财富股吧板块吧（gubaEm）+ 同花顺讨论 API（guba），
 *   由 engine.js 合并去重后计入 B/C/E；两源任一可用即不降级。
 * - 调度：今日文件缺失 → 后台触发采集（立即返回「采集中」状态，不阻塞 HTTP）；
 *         refresh=1 且今日文件已过 staleMinutes → 重新采集（后台）+ 用现有文件先算一版。
 * - 防并发：同一时刻仅一个采集进程；重复请求复用在途 Promise。
 * - 铁律：全部计算为确定性代码（engine.js），LLM 不参与；数据不足时诚实返回状态，不编造。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { findPython } = require('../pyRuntime');
const { loadConfig } = require('./config');
const { computeWeekly, isoWeekKey, weekDatesUntilToday, fmtDate } = require('./engine');

const execFileAsync = promisify(execFile);
const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'hotTopics');
const DAILY_DIR = path.join(DATA_DIR, 'daily');
const WEEKLY_DIR = path.join(DATA_DIR, 'weekly');

// 在途采集锁（进程级）
let _collectInFlight = null;
let _collectStartedAt = 0;
let _lastCollectFinishAt = 0;

function _readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; }
}
function _writeJsonAtomic(p, obj) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf-8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) { return false; }
}
function _dailyPath(dateStr) { return path.join(DAILY_DIR, dateStr + '.json'); }

function _today() {
  const d = new Date();
  return fmtDate(d);
}

/** 触发每日采集（后台执行，返回 Promise；防并发） */
function startDailyCollect(force) {
  if (_collectInFlight) return _collectInFlight;
  const py = findPython();
  if (!py) {
    _lastCollectFinishAt = Date.now();
    return Promise.resolve({ ok: false, error: '未找到可用 Python 解释器（akshare 环境）' });
  }
  const script = path.join(__dirname, '..', '..', 'scripts', 'hot_topics_collect.py');
  const args = [script, '--date', _today()];
  if (force) args.push('--force');
  _collectStartedAt = Date.now();
  _collectInFlight = execFileAsync(py, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 600000,
    windowsHide: true,
    cwd: path.join(__dirname, '..', '..'),
    env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8' }),
  }).then(
    (r) => ({ ok: true, stdout: (r.stdout || '').slice(-400) }),
    (e) => ({ ok: false, error: String(e && e.message || e).slice(0, 300) })
  ).finally(() => {
    _lastCollectFinishAt = Date.now();
    _collectInFlight = null;
  });
  return _collectInFlight;
}

/** 采集进行中？ */
function isCollecting() { return !!_collectInFlight; }

/**
 * 周榜主入口。
 * @param {boolean} force 前端「刷新」按钮触发
 */
async function getWeeklyReport(force) {
  const cfg = loadConfig(DATA_DIR);
  const map = _readJson(path.join(DATA_DIR, 'sector_map.json'));
  if (!map || !Array.isArray(map.boards) || !map.boards.length) {
    return { ok: false, status: 'error', message: '板块映射表缺失（data/hotTopics/sector_map.json）' };
  }

  const today = _today();
  const now = new Date();
  const weekKey = isoWeekKey(now);
  const dates = weekDatesUntilToday(now);
  const todayPath = _dailyPath(today);
  const todayData = _readJson(todayPath);

  // 今日数据缺失 → 触发后台采集，立即返回「采集中」
  if (!todayData) {
    const collecting = isCollecting();
    if (!collecting) startDailyCollect(false);
    return {
      ok: false, status: 'collecting', weekKey,
      message: '本周板块舆情数据采集中（首次约 4-5 分钟：92 板块 × 双社区源限速抓取），页面将自动重试。',
      completeness: { collectedDays: 0, expectedDays: dates.length, dates },
      collecting: true,
    };
  }

  // refresh=1 且今日文件已过期（超过 staleMinutes）→ 后台重采，同时用现有数据先算一版
  let reCollecting = false;
  if (force) {
    const staleMs = (cfg.collect?.staleMinutes ?? 30) * 60 * 1000;
    const age = Date.now() - (fs.statSync(todayPath).mtimeMs || 0);
    if (age > staleMs && !isCollecting() && Date.now() - _lastCollectFinishAt > 60 * 1000) {
      startDailyCollect(true);
      reCollecting = true;
    }
  }

  // 读取本周已有每日文件（升序）
  const dailies = [];
  for (const d of dates) {
    const data = _readJson(_dailyPath(d));
    if (data) dailies.push({ date: d, data });
  }
  if (!dailies.length) {
    return { ok: false, status: 'collecting', weekKey, collecting: true, message: '本周数据文件尚未生成，稍后自动重试。' };
  }

  const result = computeWeekly(map.boards, dailies, cfg);
  if (!result.ok) {
    return {
      ok: false, status: 'empty', weekKey,
      message: '本周暂无可统计的舆情/讨论数据（采集可能受限，稍后自动重试）。',
      completeness: { collectedDays: dailies.length, expectedDays: dates.length, dates },
    };
  }

  // 完整度与来源状态
  const last = dailies[dailies.length - 1].data;
  const summary = last.summary || {};
  const completeness = {
    collectedDays: dailies.length, expectedDays: dates.length, dates: dailies.map(d => d.date),
    status: dailies.length >= 5 ? '本周数据完整' : (dailies.length >= 3 ? '数据累积中（可用）' : '数据累积中（仅供参考）'),
  };
  const sources = {
    news: summary.news || (last.news && last.news.status) || 'unknown',
    // 社区讨论·主源：同花顺讨论 API
    guba: summary.guba || (last.guba && last.guba.status) || 'unknown',
    // 社区讨论·补充源：东方财富股吧板块吧（20260913h）
    gubaEm: summary.gubaEm || (last.gubaEm && last.gubaEm.status) || 'unknown',
    market: summary.market || (last.market && last.market.status) || 'unknown',
    gubaBoards: `${summary.gubaOk ?? last.guba?.okCount ?? 0}/${summary.gubaTotal ?? last.guba?.mapCount ?? map.boards.length}`,
    gubaEmBoards: `${summary.gubaEmOk ?? last.gubaEm?.okCount ?? 0}/${summary.gubaEmTotal ?? last.gubaEm?.mapCount ?? map.boards.length}`,
    // 合并口径：任一社区源可用即 ok
    community: (summary.guba === 'ok' || summary.gubaEm === 'ok') ? 'ok' : 'degraded',
  };

  const report = {
    ok: true,
    status: reCollecting ? 'refreshing' : 'ok',
    weekKey,
    updated: last.fetchedAt || new Date().toISOString(),
    date: today,
    completeness, sources,
    meta: result.meta,
    rows: result.rows.slice(0, cfg.topN || 10),
    rowsTotal: result.rows.length,
    footnotes: buildFootnotes(cfg, result.meta, sources),
  };

  // 周榜存档（审计/回看）
  _writeJsonAtomic(path.join(WEEKLY_DIR, weekKey + '.json'), Object.assign({}, report, { rows: result.rows }));

  // refresh 时后台采集完成后无需额外动作：下次请求自然读到新文件
  if (reCollecting && _collectInFlight) {
    _collectInFlight.catch(() => {});
  }
  return report;
}

function buildFootnotes(cfg, meta, sources) {
  const notes = [
    '热度≠涨跌预测：本榜只反映舆情与社区讨论热度，不构成买卖建议。',
    'NLP 词典法存在固有误差（情绪/韭菜识别为规则近似），仅供参考。',
    `指标口径：A=归属快讯条数（代理曝光量）；B=社区讨论帖数增量+采样帖浏览评论和（量级项统一取同花顺讨论 API，避免与东财股吧「真·浏览量」混算）；C=韭菜句式帖数；D=舆情看多%；E=社区看多%（社区帖取自东方财富股吧 + 同花顺讨论 API 合并去重）。`,
    '快讯源（决定 A 的条数基数）：新浪财经 7×24 · 同花顺全球财经快讯 · 华尔街见闻 7×24 · 财联社电报（后两源 20260923 新增，走独立域名、互为备份，可经 data/hotTopics/config.json 的 news 节单独开关）。',
  ];
  if (meta.degradeMode) {
    notes.push('⚠️ 降级模式：两个社区讨论通道（东方财富股吧 + 同花顺讨论 API）当日均无数据，B/E 指标缺失，权重已重分配为 A×0.8+D×0.2。');
  }
  if (sources.news && sources.news !== 'ok') {
    notes.push(`⚠️ 舆情快讯通道当日状态：${sources.news}。若为空，A（曝光）对全部板块等值、不产生区分度，请以 B/C/D/E 为主解读。`);
  }
  if ((sources.guba && sources.guba !== 'ok') || (sources.gubaEm && sources.gubaEm !== 'ok')) {
    notes.push(`社区讨论当日状态：东方财富股吧 ${sources.gubaEm}（${sources.gubaEmBoards} 板块成功）· 同花顺讨论 ${sources.guba}（${sources.gubaBoards} 板块成功）；东财受反爬风控时会在熔断后保留已抓板块，未覆盖板块自动由同花顺兜底。`);
  }
  return notes;
}

module.exports = { getWeeklyReport, startDailyCollect, isCollecting };
