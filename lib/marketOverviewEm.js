'use strict';
/**
 * 实时大盘 · 东方财富数据源（妙想通道）· 20260921g
 * --------------------------------------------------------------
 * 背景：东方财富实时行情接口 push2 / push2delay / push2his 在本机被中间设备 TLS 重置
 *       （socket hang up，push2 系全部主机实测不可达），无法直连。经实测，东方财富官方
 *       「妙想」数据服务（ai-saas.eastmoney.com，见 lib/miaoxiang.js）在本机稳定可达，
 *       且同属东方财富口径 —— 故「实时大盘」全量数据统一改由妙想取数，实现单一东财口径。
 *
 * 本机实测得到的 4 条硬约束（决定了本模块的形态）：
 *   1. 妙想是「实体查询」服务：必须给明确实体名，**不支持「排名前N / 全部板块」类问句**；
 *      故板块榜单需调用方给出申万二级全名清单，本模块分批查询后本地排序。
 *   2. 单次查询可解析的实体数有上限（实测 45 个入参约返回 41~43 条，多出的进独立小表）→
 *      统一按 BATCH=45 分批；并对返回结果做**入参名单白名单过滤**，丢弃非名单内的噪声行。
 *   3. 每个指标一次查询即返回「今日快照 + 近6个交易日历史」→ 近5日 = 最近 5 个交易日求和。
 *   4. 主力 / 小单必须**分开查询**：合并查询时返回行以指标ID（8126/8195…）为键、且行序与标题序
 *      不一致，无法可靠区分；分开查询后行以实体名为键，无歧义。
 *   5. 并发过高会触发静默失败（实测 12 并发下多批失败）→ 全局信号量限流 + 失败重试。
 *
 * 本模块只负责取数 + 规范化解析，不做判断/打分，也**不依赖 lib/stockData.js**
 * （避免与 stockData 循环 require）；申万层级由调用方用 parseSwSectorName 自行解析。
 *
 * ⚠️ 默认**未接入**任何路由/卡片（勿直接启用）：
 *   妙想是**按积分计费**的付费服务（2026-09-21 实测：请求返回
 *   「你的积分已用完～请前往 https://ai.eastmoney.com/skills 购买套餐包补充积分」，
 *   且 lib/miaoxiang.js 当时会把该业务失败**静默降级为「无数据」**，已修复为透出 error/bizError）。
 *   把「实时大盘」这类高频刷新卡片接到妙想上会快速烧掉积分，故将本模块保留为
 *   「东财口径取数的备用通道」，仅在（a）用户购买/补充积分并明确同意，或
 *   （b）东财 push2 恢复且需要比对口径时，才考虑接入；接入前请先评估单次刷新消耗。
 */

const mx = require('./miaoxiang');

// 可用环境变量覆盖，便于在不同网络/配额条件下调参与压测
const BATCH_SIZE = Math.max(1, Number(process.env.EM_BATCH_SIZE) || 45);      // 单次妙想查询的实体数（安全上限内）
const MAX_CONCURRENT = Math.max(1, Number(process.env.EM_MAX_CONCURRENT) || 3); // 全局并发上限（实测过高会静默失败）
const CALL_TIMEOUT_MS = 20000;   // 单次调用硬超时
const RETRIES = Math.max(0, Number(process.env.EM_RETRIES) || 2);             // 失败重试次数

const SOURCE_EM = '东方财富·妙想';

// ---- 全局信号量：限制同时发往妙想的请求数 ----
let _active = 0;
const _waiters = [];
function _acquire() {
  if (_active < MAX_CONCURRENT) { _active++; return Promise.resolve(); }
  return new Promise(res => _waiters.push(res));
}
function _release() {
  const next = _waiters.shift();
  if (next) next(); else _active--;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- 通用解析小工具 ----

/** 取实体名主体：'半导体(申万)(指数)' → '半导体'；'上证指数(000001.SH)(指数)' → '上证指数' */
function stripEntity(raw) {
  const s = String(raw == null ? '' : raw).trim();
  const i = s.indexOf('(');
  return (i > 0 ? s.slice(0, i) : s).trim();
}

/** 归一化名称：去实体后缀 + 去申万层级罗马数字（'证券Ⅱ' → '证券'），用于与入参名单比对 */
function normName(raw) {
  return stripEntity(raw).replace(/[ⅠⅡⅢ]+$/g, '').trim();
}

/** 纯日期列判定：'2026-09-21(日)' / '2026-09-21' ✓；带时刻的快照列 '2026-09-21 19:57' ✗ */
function isDateCol(c) {
  return /^\d{4}-\d{2}-\d{2}(\([^)]*\))?$/.test(String(c == null ? '' : c).trim());
}

/** '0.34%' → 0.34；'1.144' → 1.144；空/脏值 → null */
function parsePct(v) {
  if (v == null) return null;
  const m = String(v).replace(/[,%\s]/g, '').match(/^-?\d+(?:\.\d+)?$/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 金额统一换算为「亿元」：'26.59亿元'→26.59；'801.5万元'→0.08015；'-47.88亿'→-47.88 */
function parseYi(v) {
  if (v == null) return null;
  const t = String(v).replace(/[,\s]/g, '');
  const m = t.match(/^(-?\d+(?:\.\d+)?)(亿元|亿|万元|万|元)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] || '元';
  const factor = unit.indexOf('亿') === 0 ? 1 : unit.indexOf('万') === 0 ? 1e-4 : 1e-8;
  return n * factor;
}

/** 宽松数值：忽略千分位/空白，并剥离「点 / 元 / %」等尾缀（妙想指数点位形如 '3949.9068点'） */
function parseNumLoose(v) {
  if (v == null) return null;
  const s = String(v).replace(/[,\s%点元]/g, '');
  const m = s.match(/^-?\d+(?:\.\d+)?$/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer = setTimeout(() => {
        const e = new Error((label || '妙想调用') + '超时（' + ms + 'ms）');
        e.timeout = true;
        rej(e);
      }, ms);
    }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * 调用妙想取 tables（限流 + 重试）。未授权 / 持续无数据时抛错，由调用方决定是否回退其他数据源。
 * @returns {Promise<Array>} tables
 */
async function searchTables(query, label) {
  let lastErr = null;
  for (let i = 0; i <= RETRIES; i++) {
    await _acquire();
    try {
      const r = await withTimeout(mx.searchData(query), CALL_TIMEOUT_MS, label || '妙想查询');
      if (!r || r.needAuth) {
        const e = new Error('东方财富妙想未授权（需先完成妙想扫码授权）');
        e.needAuth = true;
        throw e;
      }
      const tables = Array.isArray(r.tables) ? r.tables : [];
      if (tables.length) return tables;
      lastErr = new Error('妙想未返回数据' + (r.message ? '：' + r.message : ''));
    } catch (e) {
      lastErr = e;
      if (e && e.needAuth) throw e;
    } finally {
      _release();
    }
    if (i < RETRIES) await sleep(500 + i * 600);
  }
  throw lastErr || new Error('妙想查询失败');
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ============================================================
// 一、指数行情（今日点位 + 涨跌幅）
// ============================================================

/**
 * @param {Array<{name:string,query:string,aliases?:string[]}>} list 目标指数
 * @returns {Promise<{byName:Object}>} byName[name] = {price, changePct, prevClose, change}
 */
async function fetchIndexQuotes(list) {
  const queries = list.map(it => it.query || it.name);
  const tables = await searchTables(queries.join('、') + ' 的最新点位和涨跌幅', '指数行情');

  const aliasToName = new Map();
  for (const it of list) {
    for (const a of [it.name, it.query].concat(it.aliases || [])) {
      if (a) aliasToName.set(normName(a), it.name);
    }
  }

  const priceBy = new Map();
  const pctBy = new Map();
  for (const t of tables) {
    const cols = Array.isArray(t.columns) ? t.columns : [];
    if (cols.length < 2) continue;

    // 形态①：合并快照表 —— 列 = [时间戳, 实体1, 实体2…]，行以指标键（'ZXJ_f2_3' 最新价 / 'ZDF_f3_3' 涨跌幅）标识
    const rowIsMetric = (t.rows || []).some(r => /_f\d+(_|$)/.test(String(r[cols[0]] || '')));
    if (rowIsMetric) {
      for (const row of t.rows || []) {
        const metricKey = String(row[cols[0]] || '');
        const isPrice = /_f2(?:_|$)/.test(metricKey);
        const isPct = /_f3(?:_|$)/.test(metricKey);
        if (!isPrice && !isPct) continue;
        for (let i = 1; i < cols.length; i++) {
          const target = aliasToName.get(normName(cols[i]));
          if (!target) continue;
          const n = isPct ? parsePct(row[cols[i]]) : parseNumLoose(row[cols[i]]);
          if (n == null) continue;
          if (isPrice) priceBy.set(target, n); else pctBy.set(target, n);
        }
      }
      continue;
    }

    // 形态②：单实体日序列表 —— 列 = [实体名, 日期…]，行以指标键标识（境外指数常见此形态，
    // 且行内无指标名可读，需按值特征区分：带「点」的是点位，否则按量级取大者为点位）
    const selfEntity = aliasToName.get(normName(cols[0]));
    if (!selfEntity) continue;
    const dateCols = cols.slice(1).filter(isDateCol);
    const latestCol = dateCols.length ? dateCols[0] : cols[1];
    const metrics = (t.rows || [])
      .map(row => ({ key: String(row[cols[0]] || ''), latest: row[latestCol] }))
      .filter(m => m.latest != null);
    if (!metrics.length) continue;
    let priceRow = metrics.find(m => /点$/.test(String(m.latest).replace(/[,\s]/g, '')));
    let pctRow = null;
    if (priceRow) {
      pctRow = metrics.find(m => m !== priceRow && parsePct(m.latest) != null) || null;
    } else {
      const byMag = metrics.slice().sort(
        (a, b) => Math.abs(parseNumLoose(b.latest) || 0) - Math.abs(parseNumLoose(a.latest) || 0)
      );
      priceRow = byMag[0];
      pctRow = byMag.length > 1 && byMag[byMag.length - 1] !== priceRow ? byMag[byMag.length - 1] : null;
    }
    if (priceRow) {
      const n = parseNumLoose(priceRow.latest);
      if (n != null && !priceBy.has(selfEntity)) priceBy.set(selfEntity, n);
    }
    if (pctRow) {
      const n = parsePct(pctRow.latest);
      if (n != null && !pctBy.has(selfEntity)) pctBy.set(selfEntity, n);
    }
  }

  const byName = {};
  for (const it of list) {
    const price = priceBy.has(it.name) ? priceBy.get(it.name) : null;
    const changePct = pctBy.has(it.name) ? pctBy.get(it.name) : null;
    if (price == null && changePct == null) continue;
    let prevClose = null, change = null;
    if (price != null && changePct != null && changePct !== -100) {
      prevClose = price / (1 + changePct / 100);
      change = price - prevClose;
    }
    byName[it.name] = { price, changePct, prevClose, change };
  }
  return { byName };
}

// ============================================================
// 二、板块涨跌幅（全量申万二级 → 本地排序出榜单）
// ============================================================

/**
 * 批量取板块涨跌幅（含近6日序列，供近5日累计）。
 * @param {string[]} names 申万二级板块名清单（调用方提供）
 * @returns {Promise<{byName:Object, requested:number, okBatches:number, failBatches:number}>}
 *          byName[normName] = { rawName, changePct, series:[{date,pct}] }
 */
async function fetchSectorChanges(names) {
  const list = Array.from(new Set((names || []).filter(Boolean)));
  if (!list.length) return { byName: {}, requested: 0, okBatches: 0, failBatches: 0 };
  const allow = new Set(list.map(normName));
  const batches = chunk(list, BATCH_SIZE);

  const results = await Promise.all(batches.map(async (b) => {
    try {
      const tables = await searchTables(b.join('、') + ' 板块的最新涨跌幅', '板块涨跌幅');
      return { ok: true, value: collectChange(tables, allow) };
    } catch (e) {
      return { ok: false, error: e };
    }
  }));

  const byName = {};
  let okBatches = 0, failBatches = 0;
  for (const r of results) {
    if (r.ok) { okBatches++; for (const [k, v] of Object.entries(r.value)) byName[k] = Object.assign(byName[k] || {}, v); }
    else failBatches++;
  }
  return { byName, requested: list.length, okBatches, failBatches };
}

/** 从妙想 tables 收集涨跌幅（快照 + 日序列），仅保留 allow 名单内的实体 */
function collectChange(tables, allow) {
  const out = {};
  const put = (rawEntity, todayPct, series) => {
    const key = normName(rawEntity);
    if (!allow.has(key)) return;                       // 白名单过滤：丢弃非名单内的噪声行
    const cur = out[key] || { rawName: stripEntity(rawEntity), changePct: null, series: [] };
    cur.rawName = stripEntity(rawEntity);
    if (todayPct != null) cur.changePct = todayPct;
    if (series && series.length) cur.series = series;
    out[key] = cur;
  };
  for (const t of tables) {
    const cols = Array.isArray(t.columns) ? t.columns : [];
    if (cols.length < 2) continue;
    const dateCols = cols.slice(1).filter(isDateCol);
    for (const row of t.rows || []) {
      const rawEntity = row[cols[0]];
      if (rawEntity == null) continue;
      if (dateCols.length) {
        const series = dateCols
          .map(d => ({ date: String(d).slice(0, 10), pct: parsePct(row[d]) }))
          .filter(x => x.pct != null);
        put(rawEntity, series.length ? series[0].pct : null, series);
      } else {
        put(rawEntity, parsePct(row[cols[1]]), null);
      }
    }
  }
  return out;
}

// ============================================================
// 三、板块资金流（主力 / 小单，今日 + 近5日）
// ============================================================

const METRICS = {
  main: { query: '板块的主力资金净流入', label: '主力' },
  retail: { query: '板块的小单资金净流入', label: '散户(小单)' },
};

/**
 * 取某一指标（主力 / 小单）的板块资金流：今日值 + 日序列。
 * @param {string[]} names
 * @param {'main'|'retail'} metric
 */
async function fetchSectorFlowByMetric(names, metric) {
  const meta = METRICS[metric];
  const list = Array.from(new Set((names || []).filter(Boolean)));
  if (!list.length) return { byName: {}, okBatches: 0, failBatches: 0 };
  const allow = new Set(list.map(normName));
  const batches = chunk(list, BATCH_SIZE);

  const results = await Promise.all(batches.map(async (b) => {
    try {
      const tables = await searchTables(b.join('、') + ' ' + meta.query, meta.label + '资金流');
      return { ok: true, value: collectFlow(tables, allow) };
    } catch (e) {
      return { ok: false, error: e };
    }
  }));

  const byName = {};
  let okBatches = 0, failBatches = 0;
  for (const r of results) {
    if (r.ok) { okBatches++; for (const [k, v] of Object.entries(r.value)) byName[k] = Object.assign(byName[k] || {}, v); }
    else failBatches++;
  }
  return { byName, okBatches, failBatches };
}

/** 从妙想 tables 收集资金流（快照 + 日序列），仅保留 allow 名单内的实体 */
function collectFlow(tables, allow) {
  const out = {};
  const put = (rawEntity, todayYi, series) => {
    const key = normName(rawEntity);
    if (!allow.has(key)) return;
    const cur = out[key] || { rawName: stripEntity(rawEntity), today: null, days: [] };
    cur.rawName = stripEntity(rawEntity);
    if (todayYi != null) cur.today = todayYi;
    if (series && series.length) cur.days = series;
    out[key] = cur;
  };
  for (const t of tables) {
    const cols = Array.isArray(t.columns) ? t.columns : [];
    if (cols.length < 2) continue;
    const dateCols = cols.slice(1).filter(isDateCol);
    for (const row of t.rows || []) {
      const rawEntity = row[cols[0]];
      if (rawEntity == null) continue;
      if (dateCols.length) {
        const series = dateCols
          .map(d => ({ date: String(d).slice(0, 10), yi: parseYi(row[d]) }))
          .filter(x => x.yi != null);
        put(rawEntity, series.length ? series[0].yi : null, series);
      } else {
        put(rawEntity, parseYi(row[cols[1]]), null);
      }
    }
  }
  return out;
}

/**
 * 取主力 + 散户资金流，并计算近5日累计（两个指标分开查询，见文件头约束 4）。
 * @param {string[]} names
 * @param {number} [nearDays=5] 近N个交易日
 * @returns {Promise<{main:Object, retail:Object, okBatches:number, failBatches:number, errors:Array}>}
 *          main[normName] = { rawName, today, fiveDay, days:[{date,yi}] }
 */
async function fetchSectorCapitalFlow(names, nearDays = 5) {
  const [mainRes, retailRes] = await Promise.all([
    fetchSectorFlowByMetric(names, 'main').then(v => ({ ok: true, value: v }), e => ({ ok: false, error: e })),
    fetchSectorFlowByMetric(names, 'retail').then(v => ({ ok: true, value: v }), e => ({ ok: false, error: e })),
  ]);

  const attach = (res) => {
    const out = {};
    if (!res.ok) return out;
    for (const [k, v] of Object.entries(res.value.byName || {})) {
      const days = Array.isArray(v.days) ? v.days.filter(d => d.yi != null).slice(0, nearDays) : [];
      out[k] = {
        rawName: v.rawName,
        today: v.today,
        fiveDay: days.length ? days.reduce((s, d) => s + d.yi, 0) : null,
        days: v.days || [],
      };
    }
    return out;
  };

  const errors = [];
  if (!mainRes.ok) errors.push({ metric: 'main', error: mainRes.error && mainRes.error.message });
  if (!retailRes.ok) errors.push({ metric: 'retail', error: retailRes.error && retailRes.error.message });

  return {
    main: attach(mainRes),
    retail: attach(retailRes),
    okBatches: (mainRes.ok ? mainRes.value.okBatches : 0) + (retailRes.ok ? retailRes.value.okBatches : 0),
    failBatches: (mainRes.ok ? mainRes.value.failBatches : 0) + (retailRes.ok ? retailRes.value.failBatches : 0),
    errors,
  };
}

module.exports = {
  SOURCE_EM,
  BATCH_SIZE,
  fetchIndexQuotes,
  fetchSectorChanges,
  fetchSectorCapitalFlow,
  _internals: { stripEntity, normName, isDateCol, parsePct, parseYi, chunk, searchTables },
};
