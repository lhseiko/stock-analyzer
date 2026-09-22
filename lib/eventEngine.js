/**
 * 事件驱动权重引擎 v2（20260907c）
 * ----------------------------------------------------------------------------
 * 链路：新闻发现事件 → 事件匹配自选股 → 自动调整权重 → 影响评分
 *
 * ★ 设计前提（用户核心洞察）：突发事件是极小概率事件。
 *   没有捕捉到事件时，事件因子权重 = 0，既有因子保持 100%。
 *   因此「误报代价 >> 漏报代价」：不确定一律归零，不猜。
 *
 * ★ 因果铁律：只收「外生事件」（因）。
 *   - 行情描述（指数高开/板块涨幅居前/北向资金流入）是「果」，一律拒收，
 *     交给既有的「市场情绪与消息面」因子，避免重复与循环论证。
 *   - 绝不用股价/指数变动去反推事件；市场数据仅在事件已识别后用于判断「是否已消化」。
 *
 * 分层级联（成本随漏斗骤减）：
 *   T0 先验：默认无事件，权重 0
 *   T1 规则硬闸门（零成本）：排除行情描述；研究观点类型封顶轻微
 *   T2 本地模型定性（零联网费）：事件类型 + 五维严重度 + 置信度
 *   T3 联网核查（极少，可配每日上限）：预期差 / 是否已定价 / 官方证实
 *   T4 交叉校验：一致采纳，不一致降级，不确定归零；重大需人工确认才生效
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getHotNews } = require('./newsSearch');
const { annotateNewsImpact, NEWS_SECTOR_MAP } = require('./newsSectorImpact');
const { callLLM, pickModelFor } = require('./ai/llm');
const { loadConfig: loadAICfg, loadPromptFile } = require('./ai/config');
const { localDate, localCompact, localDateFromTs } = require('./localDate');

const EVENTS_DIR = path.join(__dirname, '..', 'data', 'events');
const CONFIG_FILE = path.join(EVENTS_DIR, 'config.json');
const ACTIVE_FILE = path.join(EVENTS_DIR, 'active.json');
const HISTORY_FILE = path.join(EVENTS_DIR, 'history.json');
const AUDIT_FILE = path.join(EVENTS_DIR, 'audit.json');
const STATE_FILE = path.join(EVENTS_DIR, 'state.json');
const WATCHLIST_FILE = path.join(__dirname, '..', 'data', 'watchlist.json');

const ENGINE_VERSION = 'v2';
const DAY = 86400000;

// ===== 原油主连冲击（突发因子·轻微事件变量，20260911；参考对象由布伦特原油期货改为原油主连）=====
// 触发：原油主连(INE·scm 主力连续合约)单日涨跌幅绝对值 > 3%
// ★ 20260914i：本事件等级为「轻微」，旧上限 20% 与分级严重失调（轻微基准才 3%）→ 降到 8%。
//   理由：单一商品的单日波动属高频、可预期波动，权重不应与「重大事件」同量级。
// 权重：按涨跌幅比例边际递增，封顶 8%（OIL_MAX_WEIGHT）
// 方向：石油石化板块正相关；其余板块负相关
//       （油价↑ → 推升美联储加息预期 → 对全球股指形成压制，反之亦然）
const OIL_SHOCK_FILE = path.join(EVENTS_DIR, 'oilShock.json'); // 手动/web抓取注入原油主连涨跌幅（兜底/测试/未来联网纳入）
const OIL_TRIGGER_PCT = 3;            // 单日涨跌幅触发阈值（绝对值，%）
const OIL_MAX_WEIGHT = 0.08;         // 因子权重上限 8%（20260914i：0.20→0.08，轻微级事件）
const OIL_WEIGHT_PER_PCT = 0.01;     // 权重 = min(上限, |涨跌幅%| × 该系数) → 按涨幅比例边际递增（20260914i：0.02→0.01）
const OIL_TTL_MS = 6 * 60 * 60 * 1000; // 缓存 6h，单次事件扫描即刷新
// ★ 20260921l（用户要求）：「原油主连」数据影响由 3 天改为 1 天。
//   理由：原油是高频波动的单一商品，单日涨跌幅的参考价值衰减极快——
//   隔一天再看，前日涨跌幅已被新行情覆盖，再挂 3 天会把"过期信息"当成持续利好/利空。
//   注意：本值同时被 defaultConfig().gradeRanges.minor.decayShortDays 使用（轻微级统一 1 天），
//   两处必须一致，否则合成事件与落盘事件口径打架。
const OIL_DECAY_DAYS = 1;             // 冲击有效期（天），原 3 → 现 1

// 已知自选股的板块归属（NEWS_SECTOR_MAP 的 hotStocks 未覆盖时兜底）
const STOCK_SECTOR_OVERRIDE = {
  '中国平安': '保险', '华安证券': '证券', '长江证券': '证券',
  '士兰微': '半导体', '圣湘生物': '医疗器械', '海天味业': '食品饮料',
};

// ===== T1 规则关键词 =====
// 「果」：行情描述/资金流/涨跌记录 —— 不是事件，直接拒收
const RE_MARKET_RECAP = /高开|低开|平开|收涨|收跌|涨幅居前|跌幅居前|涨超|跌超|创新高|创新低|新低|新高|成交额|换手率|换手|北向|主力资金|资金流入|资金流出|净流入|净流出|涨停|跌停|板块涨幅|领涨|领跌|走强|走弱|震荡|反弹|回调|飘红|飘绿/;
// 「观点」：券商研报/评级/策略 —— 不是事实，类型封顶轻微
const RE_RESEARCH = /研报|研究报告|给予|维持.{0,6}评级|首次覆盖|目标价|投资评级|策略报告|深度报告|券商.{0,8}(认为|表示|指出|预计|建议)|主线|配置建议|看好后市/;
// 常规货币政策操作：市场预期内、高度可预期（用户 20260907e 校准：轻微为主、最多中度，绝不重大；美联储降息/加息同理）
const RE_ROUTINE_MONETARY = /降准|降息|加息|存款准备金率|再贷款|再贴现|美联储.{0,12}(议息|降息|加息|利率)|FOMC|联邦基金利率/;
// 日常流动性管理（用户 20260907f/g 校准）：LPR 报价、逆回购、公开市场操作、MLF 属央行日常操作，不算突发事件，直接拒收（与行情播报同机制）
const RE_DAILY_LIQUIDITY = /LPR|贷款市场报价利率|逆回购|公开市场操作|MLF|中期借贷便利/;

// ===== 配置 =====
// ★ 20260914i 权重重设（用户口径）：
//   「轻微事件和中度事件的影响方向都是相反，权重不可能有 50%；就是三个中度事件叠加
//     都不应该有 50% 的权重。比较重大事件是战争级别的事件。」
//   → 旧值 major 0.45 / moderate 0.30 / minor 0.08 + 合计封顶 0.50 明显过高：
//      中度基准 0.30 本身偏高，且 min(sum, 0.5) 允许两个中度就顶到 50%。
//   → 新值 major 0.40 / moderate 0.12 / minor 0.03，合计封顶降到 0.40：
//      三个中度叠加 = 0.36 < 0.40（满足「三个中度也不该有 50%」）；
//      只有含重大事件（战争级别）才可能触及 40% 上限。
//      ratio 校验：moderate/major = 0.30 → 中度只是重大权重的 3 成，符合量级直觉。
function defaultConfig() {
  return {
    // ★ 20260921l：version 从 '20260914i' → '20260921l'，用于触发 loadConfig() 的配置迁移，
    //   把磁盘 config.json 里 minor.decayShortDays 的旧值 3 强制刷成新值（原油 1 天）。
    //   ⚠️ 只改 gradeRanges 而不升 version → 磁盘旧值会继续覆盖代码默认值，改动静默失效。
    version: '20260921l',
    engineVersion: ENGINE_VERSION,
    gradeRanges: {
      major: { fixedWeightShort: 0.40, fixedWeightLong: 0.40, decayShortDays: 225, decayLongDays: 730 },
      moderate: { fixedWeightShort: 0.12, fixedWeightLong: 0.12, decayShortDays: 105, decayLongDays: 548 },
      minor: { fixedWeightShort: 0.03, fixedWeightLong: 0.0, decayShortDays: OIL_DECAY_DAYS, decayLongDays: 0 },
    },
    severity: {
      maxPerDim: 3,
      gradeThresholds: { major: 11, moderate: 7, minor: 3 },
      minConfidence: 0.6,
      // 类型硬上限：即使评分卡波动，也绝不允许越级（杜绝「研报观点=重大」）
      // ★ 20260914i：macro_policy 从 'major' 降为 'moderate'。
      //   产业/消费类政策（如智能家居消费行动方案）属常规部门政策，不是战争级别事件，
      //   不应与 geo_disaster（地缘冲突/战争）同级。真正的重大留给 geo_disaster / industry_supply 断供级。
      typeCeiling: {
        research_opinion: 'minor',
        company_event: 'moderate',
        routine_monetary_policy: 'moderate',
        industry_supply: 'major',
        macro_policy: 'moderate',
        consumption_policy: 'moderate',
        geo_disaster: 'major',
      },
    },
    models: {
      localTriage: true,       // T2 本地模型定性（零联网费）
      webVerify: true,         // T3 联网核查（预期差/已定价/官方证实）
      webDailyCap: 20,         // 联网每日调用上限
      forumHeat: true,         // T3.5 论坛热度印证（东财股吧/同花顺/雪球/新浪财经）
      heatDailyCap: 30,        // 热度核查每日调用上限
      maxCandidatesPerScan: 8, // 单次扫描最多送模型判定的候选数
      requireConfirmForMajor: true, // 重大需人工确认才生效
    },
    sectorImportance: { '银行': 2, '证券': 2, '保险': 2, '房地产': 2, '石油石化': 2, '煤炭': 2, '有色金属': 2, '国防军工': 2 },
    defaultSectorImportance: 1,
    // ★ 20260914i：合计封顶 0.50 → 0.40。三个中度叠加(0.36)不触顶，只有含重大事件才可能接近。
    maxCombinedEventWeight: 0.4,
  };
}
function loadConfig() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { return defaultConfig(); }
  // ★ 20260914i 配置迁移：data/events/config.json 一旦存在就会**整体覆盖** defaultConfig()，
  //   导致代码里改的权重/阈值对生效配置无效（用户曾遇到「改了代码重启还是旧权重」的隐性坑）。
  //   这里用版本号兜底：磁盘配置版本落后于代码 → 只强制刷新「分级权重 / 类型上限 / 合计封顶」
  //   这三组结构性配置，其余用户自定义项（models/sectorImportance 等）保留。
  const def = defaultConfig();
  if (cfg.version !== def.version) {
    cfg.gradeRanges = def.gradeRanges;
    cfg.severity = Object.assign({}, cfg.severity || {}, def.severity);
    cfg.maxCombinedEventWeight = def.maxCombinedEventWeight;
    cfg.version = def.version;
    saveConfig(cfg);
  }
  return cfg;
}
function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); return cfg; }
  catch (e) { return loadConfig(); }
}
function updateConfig(patch) { return saveConfig(deepMerge(loadConfig(), patch || {})); }

// ===== 自选股 =====
function readWatchlist() {
  try { const a = JSON.parse(fs.readFileSync(WATCHLIST_FILE, 'utf8')); return Array.isArray(a) ? a : []; }
  catch (e) { return []; }
}
function resolveWatchlist() {
  return readWatchlist().map(w => {
    const name = (w.name || '').trim();
    let sector = '';
    for (const m of NEWS_SECTOR_MAP) { if (m.hotStocks && m.hotStocks.includes(name)) { sector = m.sector; break; } }
    if (!sector) sector = STOCK_SECTOR_OVERRIDE[name] || '';
    return { symbol: w.symbol, name, sector };
  });
}

// ===== 事件库 IO =====
function ensureDir() { if (!fs.existsSync(EVENTS_DIR)) fs.mkdirSync(EVENTS_DIR, { recursive: true }); }
function _read(f, fallback) {
  ensureDir();
  try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) ? a : fallback; }
  catch (e) { return fallback; }
}
function _write(f, data) { ensureDir(); fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8'); }
function loadActive() { return _read(ACTIVE_FILE, []); }
function saveActive(a) { _write(ACTIVE_FILE, a); }
function loadHistory() { return _read(HISTORY_FILE, []); }
function saveHistory(a) { _write(HISTORY_FILE, a.slice(0, 200)); }
function loadAudit() { return _read(AUDIT_FILE, []); }
function saveAudit(a) { _write(AUDIT_FILE, a.slice(0, 100)); }
function loadState() {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) { ensureDir(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); }

// ===== 工具 =====
function eventId(sector, signal) {
  const dir = signal > 0 ? 'up' : (signal < 0 ? 'down' : 'neu');
  return `evt_${sector}_${dir}`;
}
function gradeLabel(g) { return g === 'major' ? '重大' : g === 'moderate' ? '中度' : g === 'minor' ? '轻微' : '无'; }
function dirLabel(s) { return s > 0 ? '利好' : s < 0 ? '利空' : '中性'; }
function dirArrow(s) { return s > 0 ? '▲' : s < 0 ? '▼' : '—'; }
function round(x, n) { const p = Math.pow(10, n || 3); return Math.round(x * p) / p; }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const k of Object.keys(patch || {})) {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], patch[k]);
    } else out[k] = patch[k];
  }
  return out;
}
function effectiveWeight(base, days, createdAt, now) {
  if (!base || !days || days <= 0) return 0;
  const elapsed = now - createdAt;
  if (elapsed <= 0) return base;
  const r = elapsed / (days * DAY);
  if (r >= 1) return 0;
  return base * (1 - r);
}
function isExpired(e, now) {
  const c = new Date(e.createdAt || now).getTime();
  return effectiveWeight(e.weightShort, e.decayShortDays, c, now) <= 0
    && effectiveWeight(e.weightLong, e.decayLongDays, c, now) <= 0;
}

// ===== 原油主连冲击（突发因子·轻微事件变量，20260911；参考对象由布伦特原油期货改为原油主连）=====
// 板块归属解析：优先 NEWS_SECTOR_MAP/STOCK_SECTOR_OVERRIDE，缺失时按名称兜底
function resolveSectorForSymbol(symbol) {
  const wl = resolveWatchlist();
  const w = wl.find(x => x.symbol === symbol);
  return w ? (w.sector || '') : '';
}
function isOilSectorStock(symbol) {
  if (resolveSectorForSymbol(symbol) === '石油石化') return true;
  const w = readWatchlist().find(x => x.symbol === symbol);
  const name = (w && w.name) || '';
  return /石油|原油|海油|中石化|中石油/.test(name);
}

// 东方财富·原油主连(142.scm) / 新浪 nf_SC0：上期能源 INE 中质含硫原油主力连续合约，人民币计价
// 20260921l：取数已改为多通道（新浪为主，东财 push2delay 兜底），见 _fetchCrudeLive()。
// ⚠️ 20260921l：本机 push2delay 族已被对端掐断（实测 socket hang up，偶发成功≈1/15），
//   曾导致缓存里留下一个「偏低 6 元 + 昨收偏低」的幸运命中值（707/728 → -6.28%），
//   而同期真实值应为 713.3/730.8 → -2.39%（甚至低于 3% 触发线，本不该触发）。
//   → 保留为兜底通道，主力改为新浪 nf_SC0。
async function _fetchCrudeEM() {
  try {
    const r = await axios.get('https://push2delay.eastmoney.com/api/qt/stock/get?secid=142.scm&fields=f43,f60,f170', {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
      timeout: 12000,
    });
    const d = r.data && r.data.data;
    if (!d || typeof d.f43 !== 'number' || typeof d.f60 !== 'number') return null;
    const price = d.f43 / 10;
    const prevClose = d.f60 / 10;
    const chgPct = typeof d.f170 === 'number' ? d.f170 / 100 : ((price - prevClose) / prevClose * 100);
    if (!price || !prevClose) return null;
    return { price, prevClose, chgPct: round(chgPct, 3), symbol: '142.scm', source: '东方财富·原油主连(142.scm)', via: 'eastmoney' };
  } catch (e) { return null; }
}

// 新浪·上海原油连续(nf_SC0)：INE 原油主力连续合约，与东财 142.scm 同标的、人民币计价
// 字段（HC 为 GBK）：f[0]名称 f[1]时间HHMMSS f[2]开 f[3]高 f[4]低 f[6]买 f[8]最新
//                    f[10]昨结算 f[13]持仓 f[14]成交量 f[17]日期 f[27]均价
// ⚠️ 期货用「昨结算」作涨跌幅基准（非昨收），与东财 f60 口径一致。
// 响应是 GBK 且无 Content-Type 声明 → 必须按 latin1 收字节再转 gbk，否则中文名乱码。
async function _fetchCrudeSina() {
  try {
    const r = await axios.get('https://hq.sinajs.cn/list=nf_SC0', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: 'https://finance.sina.com.cn/futuremarket/',
      },
      timeout: 10000,
      responseType: 'arraybuffer', // 拿原始字节自行按 GBK 解，别让 axios 按 utf8 猜
    });
    const buf = Buffer.from(r.data);
    const txt = buf.toString('latin1'); // 先按 latin1 保字节
    const m = txt.match(/"([^"]*)"/);
    if (!m) return null;
    const f = m[1].split(',');
    const numAt = (i) => { const v = parseFloat(f[i]); return Number.isFinite(v) ? v : null; };
    const price = numAt(8) || numAt(6);      // 最新价（盘中无成交时退回买价）
    const prevClose = numAt(10);             // 昨结算
    const quoteDate = f[17] || '';
    const quoteTime = f[1] || '';
    if (!price || !prevClose) return null;
    const chgPct = (price - prevClose) / prevClose * 100;
    // ⚠️ 坑（20260921l 实测踩到）：Node 的 Buffer.toString('gbk') 在本机 **不可用**
    //   —— 抛 `Unknown encoding: gbk`（该构建未带 full-icu 的 GBK 解码器）。
    //   名称字段只是展示用，绝不能因为解码失败就丢掉整条行情 → 用 try/catch 兜住，
    //   失败则退回「上海原油连续」这个已知常量名。
    let name = '上海原油连续';
    try { name = Buffer.from(f[0] || name, 'latin1').toString('gbk'); }
    catch (e) { /* 无 GBK 解码器 → 保留默认名 */ }
    return {
      price, prevClose, chgPct: round(chgPct, 3), symbol: 'nf_SC0',
      source: `新浪·${name}(nf_SC0)`, via: 'sina',
      quoteDate, quoteTime, open: numAt(2), high: numAt(3), low: numAt(4),
    };
  } catch (e) {
    console.warn('[eventEngine] 新浪原油取数失败:', e && e.message);
    return null;
  }
}

// 统一取数：新浪为主（本机可用），东财 push2delay 为兜底
async function _fetchCrudeLive() {
  const s = await _fetchCrudeSina();
  if (s && typeof s.chgPct === 'number') return s;
  const e = await _fetchCrudeEM();
  if (e && typeof e.chgPct === 'number') return e;
  return null;
}

// 合理性校验（20260921l）：原油单日涨跌幅极少超过 ±15%（2020 负油价级别）；
// 若缓存值与新值差异过大，倾向采信新值并记 warning，避免"坏值长期霸占缓存"。
// 另：报价日期须是近 5 个自然日内，否则视为陈旧。
function _isOilQuoteFresh(rec) {
  if (!rec) return false;
  if (rec.quoteDate) {
    const t = Date.parse(rec.quoteDate + 'T00:00:00+08:00');
    if (Number.isFinite(t) && (Date.now() - t) > 5 * DAY) return false;
  }
  return true;
}

function _readOilShockSeed() {
  try { return JSON.parse(fs.readFileSync(OIL_SHOCK_FILE, 'utf8')); } catch (e) { return null; }
}
function _loadOilCache() { const st = loadState(); return st.oilShock || null; }
function _saveOilCache(rec) { const st = loadState(); st.oilShock = rec; saveState(st); }

// 实时刷新原油主连涨跌幅（异步，由 scanEvents / API 触发）；失败则退回手动/web抓取注入
// 20260921l：校验缓存是否「陈旧」——旧实现仅看 fetchedAt + TTL，浏览器/服务重启后
//   仍可能复用一个偏低/偏高的坏值，导致卡片长期显示错误涨跌幅。改为：
//   ① 报价日期超 5 天 → 视为陈旧，强制重取；
//   ② 即使未过期，若新值取到且与缓存值差异 > 1.5pp，也采信新值（并打印 warning）。
const OIL_STALE_PP = 1.5; // 新旧涨跌幅差异阈值（百分点）
async function refreshCrudeShock(force) {
  const c = _loadOilCache();
  const fresh = c && c.fetchedAt && (Date.now() - Date.parse(c.fetchedAt)) < OIL_TTL_MS
    && typeof c.chgPct === 'number' && _isOilQuoteFresh(c);

  let live = await _fetchCrudeLive();
  if (live && typeof live.chgPct === 'number') {
    // 缓存未过期且新旧差异不大 → 沿用缓存（省一次请求的抖动）
    if (!force && fresh && Math.abs(live.chgPct - c.chgPct) <= OIL_STALE_PP) return c;
    if (fresh && Math.abs(live.chgPct - c.chgPct) > OIL_STALE_PP) {
      console.warn(`[eventEngine] 原油主连缓存值 ${c.chgPct}% 与实时值 ${live.chgPct}% 差异 ${Math.abs(live.chgPct - c.chgPct).toFixed(2)}pp（缓存来源 ${c.via || '?'}/${c.source || '?'}），采信实时值`);
    }
    live.fetchedAt = new Date().toISOString();
    _saveOilCache(live);
    return live;
  }
  // 取数失败：缓存若仍新鲜可用则沿用，否则退回种子
  if (!force && fresh) return c;
  const seed = _readOilShockSeed();
  if (seed && typeof seed.chgPct === 'number') {
    const rec = { price: seed.price, prevClose: seed.prevClose, chgPct: num(seed.chgPct), symbol: seed.symbol || 'seed', source: seed.source || '手动/web抓取注入', fetchedAt: new Date().toISOString(), via: 'seed' };
    _saveOilCache(rec); return rec;
  }
  return c || null;
}

// 同步读取当前缓存的原油主连冲击事件（供 buildEventOverride 在短期口径注入；不联网）
// 返回与 getEventsForSymbol 输出兼容的合成事件对象；未触发/缓存缺失 → null
function buildCrudeShockEvent(symbol, horizon) {
  if (horizon !== 'short') return null; // 用户限定：仅短期判断口径生效
  const oil = _loadOilCache();
  if (!oil || typeof oil.chgPct !== 'number') return null;
  const chg = oil.chgPct;
  if (Math.abs(chg) <= OIL_TRIGGER_PCT) return null; // 3% 硬阈值
  const oilUp = chg > 0;
  const oilSector = isOilSectorStock(symbol);
  // 石油板块正相关；其余负相关（油价↑→美联储加息预期↑→全球股指↓，反之亦然）
  const signal = oilSector ? (oilUp ? 1 : -1) : (oilUp ? -1 : 1);
  const weight = round(Math.min(OIL_MAX_WEIGHT, Math.abs(chg) * OIL_WEIGHT_PER_PCT), 4);
  const dirWord = oilUp ? '上涨' : '下跌';
  const corrWord = oilSector ? '正相关' : '负相关';
  const rationale = oilUp
    ? '油价上涨→推升美联储加息预期→对全球股指形成压制（非石油板块利空/石油板块利好）。'
    : '油价下跌→缓解美联储加息预期→对全球股指形成支撑（非石油板块利好/石油板块利空）。';
  return {
    id: 'evt_oil_main',
    title: `原油主连单日${dirWord}${Math.abs(chg).toFixed(1)}%（>3%·${corrWord}）`,
    sector: '原油(主连)',
    signal, grade: 'minor',
    effWeight: weight, weightShort: weight, weightLong: 0,
    decayShortDays: OIL_DECAY_DAYS, decayLongDays: 0, remainingDays: OIL_DECAY_DAYS,
    source: oil.source || 'Crude oil main continuous', via: oil.via, chgPct: chg,
    isSynthetic: true, reason: rationale, oilSector,
    // 附上取数时的报价日期，便于前端/接口核对"这条冲击对应哪一天的行情"
    quoteDate: oil.quoteDate || null, quoteTime: oil.quoteTime || null,
  };
}
function getOilShockStatus() {
  const oil = _loadOilCache();
  return {
    cached: !!oil,
    chgPct: oil ? oil.chgPct : null,
    price: oil ? oil.price : null,
    prevClose: oil ? oil.prevClose : null,
    source: oil ? oil.source : null,
    via: oil ? oil.via : null,
    fetchedAt: oil ? oil.fetchedAt : null,
    triggered: oil ? Math.abs(oil.chgPct) > OIL_TRIGGER_PCT : false,
    triggerPct: OIL_TRIGGER_PCT,
    maxWeight: OIL_MAX_WEIGHT,
    weightPerPct: OIL_WEIGHT_PER_PCT,
  };
}

// 展示摘要：逐条列出每起事件，多空并存时不合并（方向抵消也要让人看见）
function summarizeEvents(events, combined, aggSignal) {
  const sorted = events.slice().sort((a, b) => b.signal - a.signal);
  const tags = sorted.map(e => `${e.sector}${dirArrow(e.signal)}${gradeLabel(e.grade)}`);
  let s = tags.slice(0, 3).join(' ｜ ');
  if (tags.length > 3) s += ` 等${tags.length}起`;
  const pct = (combined * 100).toFixed(1);
  const nUp = sorted.filter(e => e.signal > 0).length;
  const nDown = sorted.filter(e => e.signal < 0).length;
  if (nUp > 0 && nDown > 0) return `${s} · 合计${pct}%（多空并存·净${dirLabel(aggSignal)}）`;
  return `${s} · 合计${pct}%（${dirLabel(aggSignal)}）`;
}

// ===== T1 规则硬闸门 =====
function classifyByRule(text) {
  if (RE_MARKET_RECAP.test(text)) return { kind: 'market_recap', reject: true };
  if (RE_DAILY_LIQUIDITY.test(text)) return { kind: 'daily_liquidity_op', reject: true };
  if (RE_ROUTINE_MONETARY.test(text)) return { kind: 'routine_monetary_policy', reject: false, ceiling: 'moderate' };
  if (RE_RESEARCH.test(text)) return { kind: 'research_opinion', reject: false };
  return { kind: 'candidate', reject: false };
}

// 模型未必严格按 schema 输出（实测会返回 is_exogenous / score 等变体），这里做字段归一化
const SEV_DIMS = ['scope', 'persistence', 'intensity', 'surprise', 'authority'];
function normalizeVerdict(v) {
  const raw = v || {};
  let isEvent = null;
  for (const k of ['isEvent', 'is_event', 'isExogenous', 'is_exogenous']) {
    if (raw[k] != null) { isEvent = !!raw[k]; break; }
  }
  const out = { isEvent, type: String(raw.type || '').trim(), confidence: num(raw.confidence), reason: String(raw.reason || '') };
  for (const d of SEV_DIMS) out[d] = raw[d] != null ? num(raw[d]) : null;
  // 只给总分时按均分回填五维（保守估算）
  if (raw.score != null && SEV_DIMS.every(d => raw[d] == null)) {
    const per = Math.min(3, Math.round(num(raw.score) / SEV_DIMS.length));
    for (const d of SEV_DIMS) out[d] = per;
  }
  for (const d of SEV_DIMS) if (out[d] == null) out[d] = 0;
  return out;
}

// ===== T2 本地模型定性 =====
function parseJsonLoose(content) {
  if (!content) return null;
  let s = String(content).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const m = s.match(/\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
  return null;
}
async function llmTriage(candidates, cfg) {
  const out = {};
  if (!candidates.length || !cfg.models.localTriage) return out;
  let aiCfg;
  try { aiCfg = loadAICfg(); } catch (e) { return out; }
  if (!aiCfg || !aiCfg.apiKey) return out;
  let systemPrompt = '你是A股事件驱动定性分析器，只输出JSON数组。';
  try { systemPrompt = loadPromptFile('event-triage-system.md') || systemPrompt; } catch (e) {}
  const payload = candidates.map((c, i) => ({ id: String(i), title: c.title, summary: (c.summary || '').slice(0, 200) }));
  try {
    const pick = pickModelFor(aiCfg, 'local');
    // thinking 模型带长提示词推理很慢，超时必须放宽（默认 60s 会直接超时 → 全部不认）
    const content = await callLLM(aiCfg.provider, aiCfg.apiKey, pick.model, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `请逐条判断以下快讯是否构成外生事件并评分，只输出JSON数组：\n${JSON.stringify(payload)}` },
    ], { webSearch: pick.webSearch, timeoutMs: (cfg.models.triageTimeoutMs || 180000) });
    const parsed = parseJsonLoose(content);
    // 兼容：直接数组 / {results|items|events|data:[...]} / 单对象
    let arr = [];
    if (Array.isArray(parsed)) arr = parsed;
    else if (parsed && typeof parsed === 'object') {
      for (const k of ['results', 'items', 'events', 'data', 'list']) {
        if (Array.isArray(parsed[k])) { arr = parsed[k]; break; }
      }
      if (!arr.length) arr = [parsed];
    }
    arr.forEach((a, idx) => {
      if (!a || typeof a !== 'object') return;
      // 模型漏 id 时按下标兜底（payload 顺序即候选顺序）
      const key = (a.id != null && a.id !== '') ? String(a.id) : String(idx);
      out[key] = a;
    });
    if (!Object.keys(out).length) console.warn('[eventEngine] T2 无有效判定，原始返回:', String(content).slice(0, 300));
  } catch (e) {
    console.warn('[eventEngine] T2 本地模型定性失败:', e && e.message);
  }
  return out;
}

// ===== T3 联网核查（预期差 / 已定价 / 官方证实）=====
function webUsageToday() {
  const st = loadState();
  const today = localDate();
  return (st.webDate === today) ? (st.webCount || 0) : 0;
}
function bumpWebUsage() {
  const st = loadState();
  const today = localDate();
  st.webDate = today;
  st.webCount = (st.webDate === today ? (st.webCount || 0) : 0) + 1;
  saveState(st);
}
function heatUsageToday() {
  const st = loadState();
  const today = localDate();
  return (st.heatDate === today) ? (st.heatCount || 0) : 0;
}
function bumpHeatUsage() {
  const st = loadState();
  const today = localDate();
  st.heatDate = today;
  st.heatCount = (st.heatDate === today ? (st.heatCount || 0) : 0) + 1;
  saveState(st);
}

// ===== T3.5 论坛热度印证（用户 20260907h 校准：上东财股吧/同花顺/雪球/新浪财经看讨论热度，热度越高权重越高）=====
async function forumHeat(title, cfg) {
  if (!cfg.models.forumHeat) return null;
  if (heatUsageToday() >= (cfg.models.heatDailyCap || 30)) return null;
  let aiCfg;
  try { aiCfg = loadAICfg(); } catch (e) { return null; }
  if (!aiCfg || !aiCfg.apiKey) return null;
  try {
    bumpHeatUsage();
    const pick = pickModelFor(aiCfg, 'web');
    const content = await callLLM(aiCfg.provider, aiCfg.apiKey, pick.model, [
      { role: 'system', content: '你是财经社区讨论热度评估助手，只输出JSON。' },
      { role: 'user', content: '在东方财富股吧、同花顺、雪球、新浪财经这四个财经论坛/社区搜索下面这条快讯的关键词，评估它的讨论热度：\n0=几乎无人讨论（各论坛基本搜不到相关讨论帖）\n1=少量讨论（只有零星几帖，回应很少）\n2=有一定热度（多个论坛有讨论帖，有实质回帖）\n3=热议（大量帖子、高阅读量高评论量，甚至置顶/热榜）\n只输出 {"heat":0-3,"note":"20字内，写哪些论坛有讨论"}。\n快讯：' + title },
    ], { webSearch: pick.webSearch, timeoutMs: 90000 });
    const p = parseJsonLoose(content);
    if (!p || typeof p.heat !== 'number') return null;
    return { heat: Math.max(0, Math.min(3, Math.round(p.heat))), note: String(p.note || '').slice(0, 40), checkedAt: new Date().toISOString() };
  } catch (e) { return null; }
}
async function webVerify(title, cfg) {
  if (!cfg.models.webVerify) return null;
  if (webUsageToday() >= (cfg.models.webDailyCap || 20)) return null;
  let aiCfg;
  try { aiCfg = loadAICfg(); } catch (e) { return null; }
  if (!aiCfg || !aiCfg.apiKey) return null;
  try {
    bumpWebUsage();
    const pick = pickModelFor(aiCfg, 'web');
    const content = await callLLM(aiCfg.provider, aiCfg.apiKey, pick.model, [
      { role: 'system', content: '你是A股事件核查助手，只输出JSON。' },
      { role: 'user', content: `针对这条快讯核查两点：1) 该事件此前是否已被市场预期或已消化（ pricedIn 0-1，1=完全已定价）；2) 是否有官方/权威渠道证实（confirmed true/false）。只输出 {"pricedIn":0-1,"confirmed":true/false,"note":"20字内"}。\n快讯：${title}` },
    ], { webSearch: pick.webSearch, timeoutMs: 60000 });
    const p = parseJsonLoose(content);
    return p || null;
  } catch (e) { return null; }
}

// ===== 评分卡 → 分级（含置信度闸门 + 类型硬上限；explicitCeiling 来自 T1 规则层，优先级最高）=====
function scoreToGrade(v, type, cfg, explicitCeiling) {
  const sev = cfg.severity || defaultConfig().severity;
  const total = num(v.scope) + num(v.persistence) + num(v.intensity) + num(v.surprise) + num(v.authority);
  const conf = num(v.confidence);
  if (conf < (sev.minConfidence || 0.6)) return { grade: 'none', total, confidence: conf, reason: 'confidence_low' };
  const t = sev.gradeThresholds || { major: 11, moderate: 7, minor: 3 };
  let grade = 'none';
  if (total >= t.major) grade = 'major';
  else if (total >= t.moderate) grade = 'moderate';
  else if (total >= t.minor) grade = 'minor';
  const ceiling = explicitCeiling || (sev.typeCeiling || {})[type] || 'major';
  const order = ['none', 'minor', 'moderate', 'major'];
  let capped = false;
  if (order.indexOf(grade) > order.indexOf(ceiling)) { grade = ceiling; capped = true; }
  return { grade, total, confidence: conf, capped };
}

// ===== 扫描（T0→T4）=====
async function scanEvents(force) {
  const cfg = loadConfig();
  const watchlist = resolveWatchlist();
  const now = Date.now();
  // 20260911：事件扫描时同步刷新原油主连涨跌幅缓存（失败静默，不影响主流程）
  try { await refreshCrudeShock(); } catch (e) { console.warn('[eventEngine] 原油主连刷新失败:', e && e.message); }
  const audit = {
    scannedAt: new Date().toISOString(),
    totalNews: 0, rejectedRecap: 0, rejectedNoMatch: 0,
    candidates: 0, llmNotEvent: 0, llmFailed: 0,
    gradeNone: 0, created: 0, updated: 0, expired: 0, pendingConfirm: 0, webChecks: 0,
    heatChecks: 0, heatAdjusted: 0,
  };

  let news = [];
  try { const d = await getHotNews(force); news = (d && d.items) || []; } catch (e) { news = []; }
  news = annotateNewsImpact(news);
  audit.totalNews = news.length;

  // T1 规则硬闸门 + 自选股匹配
  const candidates = [];
  for (const n of news) {
    const text = `${n.title || ''} ${n.summary || ''}`;
    const rule = classifyByRule(text);
    if (rule.reject) { audit.rejectedRecap++; continue; } // 「果」→ 拒收
    const imp = n.impact;
    if (!imp || !imp.sector || imp.signal === 0) continue;
    const affected = matchWatchlist(imp.sector, imp.hotStocks, n.title, n.summary, watchlist);
    if (!affected.length) { audit.rejectedNoMatch++; continue; }
    candidates.push({ title: n.title, summary: n.summary, sector: imp.sector, signal: imp.signal, affected, ruleKind: rule.kind, ruleCeiling: rule.ceiling || null, url: n.url });
    if (candidates.length >= (cfg.models.maxCandidatesPerScan || 8)) break;
  }
  audit.candidates = candidates.length;

  // T2 本地模型定性
  const verdicts = await llmTriage(candidates, cfg);
  if (candidates.length && !Object.keys(verdicts).length) audit.llmFailed = candidates.length;

  // T3/T4 组装事件
  const groups = {};
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const raw = verdicts[String(i)];
    if (!raw) { audit.llmNotEvent++; continue; }
    const v = normalizeVerdict(raw);
    // isEvent 显式为 false → 不认；缺失则看是否给出了有效类型
    if (v.isEvent === false) { audit.llmNotEvent++; continue; }
    if (v.isEvent === null && !v.type) { audit.llmNotEvent++; continue; }
    let type = v.type || c.ruleKind;
    if (type === 'candidate') type = 'company_event';
    if (type === 'market_recap') { audit.llmNotEvent++; continue; }
    // ★ 20260921a：company_event（单一公司事件）只按「个股名出现在标题/摘要」匹配，
    //   不再广播到整个板块——避免「阳普医疗认证」这类个股利好误挂到同板块其他股（如圣湘生物）。
    const affectedFinal = (type === 'company_event')
      ? matchWatchlist(c.sector, c.hotStocks, c.title, c.summary, watchlist, { onlyNamed: true })
      : c.affected;
    const sc = scoreToGrade(v, type, cfg, c.ruleCeiling);
    if (sc.grade === 'none') { audit.gradeNone++; continue; }

    let grade = sc.grade;
    // T3：重大或低置信才联网核查是否已定价（控制额度）
    if ((grade === 'major' || sc.confidence < 0.7) && cfg.models.webVerify) {
      const wv = await webVerify(c.title, cfg);
      if (wv) {
        audit.webChecks++;
        const pricedIn = num(wv.pricedIn);
        if (pricedIn >= 0.7 || wv.confirmed === false) {
          const order = ['none', 'minor', 'moderate', 'major'];
          grade = order[Math.max(0, order.indexOf(grade) - 1)];
        }
      }
    }
    if (grade === 'none') { audit.gradeNone++; continue; }

    const id = eventId(c.sector, c.signal);
    if (!groups[id]) {
      groups[id] = { id, sector: c.sector, signal: c.signal, affected: new Set(), grade, type, score: sc.total, confidence: sc.confidence, reason: v.reason || '', title: c.title, sources: [], ruleCeiling: c.ruleCeiling || null };
    }
    const g = groups[id];
    affectedFinal.forEach(s => g.affected.add(s));
    // 取最高分级（同一板块+方向的多条新闻取最强）
    const order = ['none', 'minor', 'moderate', 'major'];
    if (order.indexOf(grade) > order.indexOf(g.grade)) { g.grade = grade; g.score = sc.total; g.confidence = sc.confidence; g.title = c.title; }
    if (c.url) g.sources.push(c.url);
  }

  // 载入现有活跃事件（v1 遗留事件直接废弃）
  let active = loadActive();
  const discarded = active.filter(e => e.engineVersion !== ENGINE_VERSION);
  active = active.filter(e => e.engineVersion === ENGINE_VERSION);
  if (discarded.length) audit.expired += discarded.length;
  const legacySymbols = [];
  for (const e of discarded) (e.affectedSymbols || []).forEach(s => legacySymbols.push(s));

  const createdIds = [], updatedIds = [];

  // T3.5 论坛热度印证（东财股吧/同花顺/雪球/新浪财经）：热度计入总分重算分级；0 热度降一级（无讨论≈可能是误报）；24h 内复用缓存
  for (const id of Object.keys(groups)) {
    const g = groups[id];
    if (!cfg.models.forumHeat) break;
    const exEv = active.find(e => e.id === id);
    const freshCache = exEv && exEv.heat && (now - Date.parse(exEv.heat.checkedAt) < DAY);
    let hv = freshCache ? exEv.heat : await forumHeat(g.title, cfg);
    if (hv) {
      audit.heatChecks++;
      const sev = cfg.severity || defaultConfig().severity;
      const t = sev.gradeThresholds || { major: 11, moderate: 7, minor: 3 };
      const order4 = ['none', 'minor', 'moderate', 'major'];
      const ceiling = g.ruleCeiling || (sev.typeCeiling || {})[g.type] || 'major';
      if (hv.heat === 0) {
        // 零热度：降一级（热度侧印证缺失，宁降勿升）
        const ni = Math.max(0, order4.indexOf(g.grade) - 1);
        if (order4[ni] !== g.grade) audit.heatAdjusted++;
        g.grade = order4[ni];
      } else {
        // 热度作为第六维计入总分，重算分级（硬上限仍生效）
        const total = (g.score || 0) + hv.heat;
        let ng = 'none';
        if (total >= t.major) ng = 'major';
        else if (total >= t.moderate) ng = 'moderate';
        else if (total >= t.minor) ng = 'minor';
        if (order4.indexOf(ng) > order4.indexOf(ceiling)) ng = ceiling;
        if (ng !== g.grade) audit.heatAdjusted++;
        g.grade = ng; g.score = total;
      }
      if (g.grade === 'none') g.drop = true; // 热度降为 none：不新建/已有则自然过期
    }
    g.heat = hv || (exEv && exEv.heat) || null;
  }

  for (const id of Object.keys(groups)) {
    const g = groups[id];
    const affected = [...g.affected];
    // 20260921a：company_event 经 name-only 后可能无 affected（如阳普医疗事件不匹配任何自选股）→ 不建事件
    if (!affected.length) continue;
    const existing = active.find(e => e.id === id);
    // 热度印证降为 none：置零权重走自然过期归档；未入库的组直接跳过
    if (g.drop) {
      if (existing && !isExpired(existing, now)) {
        existing.weightShort = 0; existing.weightLong = 0;
        audit.expired++;
      }
      continue;
    }
    const gr = cfg.gradeRanges[g.grade];
    if (existing && !isExpired(existing, now)) {
      existing.lastSeen = now;
      existing.newsCount = (existing.newsCount || 1) + 1;
      existing.affectedSymbols = [...new Set([...(existing.affectedSymbols || []), ...affected])];
      existing.title = g.title || existing.title;
      if (!existing.direction) existing.direction = g.signal > 0 ? 'up' : 'down';
      if (g.sources.length) existing.sources = [...new Set([...(existing.sources || []), ...g.sources])];
      if (g.heat && !existing.heat) existing.heat = g.heat;
      // 热度印证调整了分级：回写分级/评分/权重/衰减（权重再平衡随 getEventsForSymbol 立即生效）
      if (gr && g.grade !== existing.grade) {
        existing.grade = g.grade;
        existing.score = g.score;
        existing.weightShort = gr.fixedWeightShort; existing.weightLong = gr.fixedWeightLong;
        existing.decayShortDays = gr.decayShortDays; existing.decayLongDays = gr.decayLongDays;
        const cAt = Date.parse(existing.createdAt) || now;
        existing.decayShortEnd = new Date(cAt + gr.decayShortDays * DAY).toISOString();
        existing.decayLongEnd = new Date(cAt + gr.decayLongDays * DAY).toISOString();
      }
      updatedIds.push(id);
    } else {
      const createdAt = now;
      const needsConfirm = g.grade === 'major' && cfg.models.requireConfirmForMajor;
      active.push({
        id, title: g.title, sector: g.sector, signal: g.signal,
        direction: g.signal > 0 ? 'up' : 'down', type: g.type,
        grade: g.grade, score: g.score, confidence: g.confidence, reason: g.reason,
        affectedSymbols: affected,
        weightShort: gr.fixedWeightShort, weightLong: gr.fixedWeightLong,
        decayShortDays: gr.decayShortDays, decayLongDays: gr.decayLongDays,
        decayShortEnd: new Date(createdAt + gr.decayShortDays * DAY).toISOString(),
        decayLongEnd: new Date(createdAt + gr.decayLongDays * DAY).toISOString(),
        status: needsConfirm ? 'pending_confirm' : 'active',
        confirmed: !needsConfirm,
        paused: false, createdAt: new Date(createdAt).toISOString(), lastSeen: now,
        newsCount: 1, sources: [...new Set(g.sources)], engineVersion: ENGINE_VERSION,
        heat: g.heat || null,
      });
      createdIds.push(id);
      if (needsConfirm) audit.pendingConfirm++;
    }
  }
  audit.created = createdIds.length;
  audit.updated = updatedIds.length;

  // 过期清理（含被热度淘汰置零的事件）；受影响个股的当日判断必须作废（20260907i 修复：过期不等于无影响）
  const expired = active.filter(e => isExpired(e, now));
  active = active.filter(e => !isExpired(e, now));
  const expiredSymbols = [];
  if (expired.length) {
    const hist = loadHistory();
    for (const e of expired) {
      e.expiredAt = new Date().toISOString(); hist.unshift(e);
      (e.affectedSymbols || []).forEach(s => expiredSymbols.push(s));
    }
    saveHistory(hist);
    audit.expired += expired.length;
  }
  saveActive(active);

  const changedSymbols = [...new Set([
    ...createdIds.flatMap(id => (active.find(e => e.id === id) || {}).affectedSymbols || []),
    ...updatedIds.flatMap(id => (active.find(e => e.id === id) || {}).affectedSymbols || []),
    ...expiredSymbols,
    ...legacySymbols,
  ])];

  const al = loadAudit(); al.unshift(audit); saveAudit(al);
  return {
    ok: true, scannedAt: audit.scannedAt, audit,
    activeCount: active.length, created: createdIds, updated: updatedIds,
    changedSymbols, events: active,
  };
}

function matchWatchlist(sector, hotStocks, title, summary, watchlist, opts) {
  const onlyNamed = !!(opts && opts.onlyNamed);
  const out = new Set();
  for (const w of watchlist) {
    // onlyNamed：仅按「个股名出现在标题/摘要」匹配（单一公司事件不外溢到全板块）
    if (!onlyNamed && w.sector && w.sector === sector) out.add(w.symbol);
    else if (!onlyNamed && hotStocks && hotStocks.includes(w.name)) out.add(w.symbol);
    else if ((title && title.includes(w.name)) || (summary && summary.includes(w.name))) out.add(w.symbol);
  }
  return [...out];
}

// ===== 查询 =====
function getActiveEvents() { return loadActive(); }
function getEventsForSymbol(symbol, horizon) {
  const now = Date.now();
  const list = loadActive().filter(e =>
    (e.affectedSymbols || []).includes(symbol)
    && e.status === 'active'   // pending_confirm（未确认的重大）不参与权重
    && !e.paused);
  const events = [];
  for (const e of list) {
    const c = new Date(e.createdAt).getTime();
    const base = horizon === 'long' ? e.weightLong : e.weightShort;
    const days = horizon === 'long' ? e.decayLongDays : e.decayShortDays;
    const eff = effectiveWeight(base, days, c, now);
    if (eff <= 0 || e.signal === 0) continue;
    events.push({ ...e, effWeight: round(eff, 4), remainingDays: Math.max(0, Math.ceil((days * DAY - (now - c)) / DAY)) });
  }
  return events;
}

// ===== 内幕抢跑检查（事件驱动联动）=====
// 设计（用户 20260922 校正）：不再"只要大涨就纳入"，必须等个股/板块相关事件（利好/利空）出现才调用。
// 锚定事件出现时间（createdAt），回溯其之前 3 个交易日的累计涨跌幅：
//   若股价已沿事件方向提前反应（同向 且 幅度≥阈值）→ 判为"提前抢跑/已透支"，据此调整该事件预期。
//   利好透支 → 剩余上行动能耗尽 → 边际偏空；利空出尽 → 边际偏多（方向语义同原市场情绪子信号，20260901a 修正）。
// 合成事件（原油主连 isSynthetic）按"油价→股指"传导，与个股自身抢跑无关，直接跳过。
// 依赖调用方传入的 history（日K close 序列）；未传则跳过（不报错）。
function checkInsiderFrontRun(symbol, event, history) {
  const hist = Array.isArray(history) ? history : [];
  if (hist.length < 4) return { detected: false, reason: '历史不足' };
  if (event.isSynthetic || !event.createdAt) return { detected: false, reason: '非真实事件' };
  const anchorTs = Date.parse(event.createdAt);
  if (!anchorTs) return { detected: false, reason: '无事件时间' };
  const anchorDate = localDateFromTs(new Date(anchorTs));
  // 严格早于事件日的交易日，升序
  const prior = hist
    .filter(h => h && h.date && h.date < anchorDate)
    .map(h => ({ date: h.date, close: num(h.close) }))
    .filter(x => x.close > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (prior.length < 3) return { detected: false, reason: '事件前交易日不足3' };
  const win = prior.slice(-3); // 事件前最近 3 个交易日
  const base = win[0].close, last = win[2].close;
  const preChg = (last - base) / base * 100;
  const dir = event.signal > 0 ? 1 : (event.signal < 0 ? -1 : 0);
  if (dir === 0) return { detected: false, reason: '事件无方向' };
  const sameDir = (preChg > 0 && dir > 0) || (preChg < 0 && dir < 0);
  if (!sameDir) return { detected: false, preChg: round(preChg, 2), reason: '方向不一致' };
  const THRESHOLD = 2.5;
  if (Math.abs(preChg) < THRESHOLD) return { detected: false, preChg: round(preChg, 2), reason: '提前反应幅度不足' };
  // 保留率随抢跑幅度连续递减（与原口径一致）：抢 2.5%→0.875，5%→0.75，10%→0.5，15%→0.25，≥17%→封底0.15
  const retain = Math.max(0.15, 1 - Math.abs(preChg) / 20);
  const cutPct = round((1 - retain) * 100);
  const runDir = preChg >= 0 ? 1 : -1;
  const signal = round(-0.4 * runDir, 3);
  const tone = signal > 0 ? '利空出尽，边际偏多' : '利好透支，边际偏空';
  return { detected: true, preChg: round(preChg, 2), cutPct, signal, tone, anchorDate, windows: win.map(x => x.date) };
}

// 构建权重覆盖 + 事件因子（无事件 → null → 权重 0，既有因子保持 100%）
function buildEventOverride({ symbol, baseWeights, factorKeys, horizon, history }) {
  const events = getEventsForSymbol(symbol, horizon);
  const cfg = loadConfig();
  // 20260911：原油主连冲击（突发因子·轻微事件变量，仅短期口径）；同步读取缓存，不联网
  const oilEvt = buildCrudeShockEvent(symbol, horizon);
  if (oilEvt) events.push(oilEvt);
  if (!events.length) return null;
  // 内幕抢跑检查：仅对真实个股/板块事件（非合成）在事件出现时调用，回溯事件前 3 日涨跌幅。
  const frontRunParts = [];
  for (const e of events) {
    const fr = checkInsiderFrontRun(symbol, e, history);
    e.frontRun = fr;
    if (fr && fr.detected) {
      // 抢跑子信号权重 = 该事件有效权重 × 下调比例（与事件本身同方向计入，调整预期而非替代事件）
      frontRunParts.push({ eventId: e.id, signal: fr.signal, weight: e.effWeight * (fr.cutPct / 100) });
    }
  }
  const frontRunCount = frontRunParts.length;
  const sumEff = events.reduce((a, e) => a + e.effWeight, 0);
  let combined = Math.min(sumEff, cfg.maxCombinedEventWeight || 0.5);
  if (combined <= 0) return null;
  // 事件净信号 = 各事件 signal 加权；叠加内幕抢跑子信号（按各自权重计入），调整预期方向。
  // 无抢跑时 frWeight=0，aggSignal 退化为原口径（向后兼容）。
  const frWeight = frontRunParts.reduce((a, p) => a + p.weight, 0);
  const aggSignal = round(
    (events.reduce((a, e) => a + e.signal * e.effWeight, 0) + frontRunParts.reduce((a, p) => a + p.signal * p.weight, 0))
    / (sumEff + frWeight || 1), 3);
  const override = {};
  for (const k of factorKeys) {
    const base = baseWeights[k] != null ? baseWeights[k] : (1 / factorKeys.length);
    override[k] = round(base * (1 - combined), 4);
  }
  const nUp = events.filter(e => e.signal > 0).length;
  const nDown = events.filter(e => e.signal < 0).length;
  const mixed = nUp > 0 && nDown > 0;
  const subFactors = [];
  for (const e of events.slice().sort((a, b) => b.signal - a.signal)) {
    subFactors.push({
      key: 'evt_' + e.id,
      name: (e.title || '').slice(0, 26),
      signal: e.signal,
      value: `${dirArrow(e.signal)}${dirLabel(e.signal)}·${e.sector}·${gradeLabel(e.grade)}·剩${e.remainingDays}天`,
    });
    // 内幕抢跑预警：仅事件触发，附在对应事件下，显示事件前 3 日提前反应与预期下调
    if (e.frontRun && e.frontRun.detected) {
      subFactors.push({
        key: 'evt_' + e.id + '_fr',
        name: '内幕抢跑预警',
        signal: e.frontRun.signal,
        value: `事件前3日${e.frontRun.preChg >= 0 ? '+' : ''}${e.frontRun.preChg}%，预期下调${e.frontRun.cutPct}%`,
        detail: `${e.frontRun.tone}（${e.frontRun.windows ? e.frontRun.windows.join(' / ') : ''}）`,
      });
    }
  }
  const eventFactor = {
    key: 'event', name: '事件驱动',
    weight: round(combined, 4), signal: aggSignal, applicable: true,
    value: summarizeEvents(events, combined, aggSignal),
    detail: `共 ${events.length} 起事件（利好${nUp}/利空${nDown}）影响本股（${horizon === 'long' ? '长期' : '短期'}口径），合计权重 ${(combined * 100).toFixed(1)}%${mixed ? '；多空并存，方向互相抵消为净' + dirLabel(aggSignal) : ''}${frontRunCount ? `；其中 ${frontRunCount} 起检测到内幕抢跑（事件前已提前反应），预期已相应下调` : ''}`,
    subFactors,
  };
  return { override, eventFactor, events, combinedWeight: combined, aggSignal, horizon };
}

// ===== 人工干预 =====
function confirmEvent(id) {
  const arr = loadActive();
  const e = arr.find(x => x.id === id);
  if (!e) return { ok: false, error: 'NOT_FOUND' };
  e.status = 'active'; e.confirmed = true; e.confirmedAt = new Date().toISOString();
  saveActive(arr);
  return { ok: true, event: e };
}
function setEventPaused(id, paused) {
  const arr = loadActive();
  const e = arr.find(x => x.id === id);
  if (!e) return { ok: false, error: 'NOT_FOUND' };
  e.paused = !!paused;
  e.status = e.paused ? 'paused' : 'active';
  saveActive(arr);
  return { ok: true, event: e };
}
function setEventGrade(id, grade) {
  const arr = loadActive();
  const e = arr.find(x => x.id === id);
  if (!e) return { ok: false, error: 'NOT_FOUND' };
  if (!['major', 'moderate', 'minor'].includes(grade)) return { ok: false, error: 'BAD_GRADE' };
  const cfg = loadConfig();
  const gr = cfg.gradeRanges[grade];
  e.grade = grade; e.weightShort = gr.fixedWeightShort; e.weightLong = gr.fixedWeightLong;
  e.decayShortDays = gr.decayShortDays; e.decayLongDays = gr.decayLongDays;
  const c = new Date(e.createdAt).getTime();
  e.decayShortEnd = new Date(c + gr.decayShortDays * DAY).toISOString();
  e.decayLongEnd = new Date(c + gr.decayLongDays * DAY).toISOString();
  saveActive(arr);
  return { ok: true, event: e };
}

module.exports = {
  loadConfig, saveConfig, defaultConfig, updateConfig,
  scanEvents, getActiveEvents, getEventsForSymbol, buildEventOverride, checkInsiderFrontRun,
  confirmEvent, setEventPaused, setEventGrade,
  resolveWatchlist, loadAudit, classifyByRule, scoreToGrade,
  eventId, gradeLabel, dirLabel, dirArrow, effectiveWeight, summarizeEvents,
  ENGINE_VERSION, EVENTS_DIR,
  // 20260911：原油主连冲击（突发因子·轻微事件变量）
  refreshCrudeShock, getOilShockStatus, buildCrudeShockEvent,
  OIL_TRIGGER_PCT, OIL_MAX_WEIGHT, OIL_WEIGHT_PER_PCT, OIL_DECAY_DAYS,
};
