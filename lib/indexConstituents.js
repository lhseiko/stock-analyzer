/**
 * 主要指数成分股数据（用于按个股所属市场筛相关指数，修复此前"按市场一刀切"bug）
 * ------------------------------------------------------------
 * 上证50 成分股（50只，CSI 官方 2025-04 调整版）
 * 沪深300 成分股（300只）：实时从 Sina Market_Center API 拉取（hs300 节点，分页）
 * 创业板指 成分股（100只）：实时从 Sina Market_Center API 拉取（cyb 节点）
 *
 * 数据来源：
 *   - 上证50：中证指数有限公司 CSI 官方 2025-04-18 调整名单
 *   - 沪深300 / 创业板指：新浪财经 Market_Center API（每日变动小，磁盘缓存 24h）
 *
 * 缓存策略：沪深300/创业板指 进程内 5 分钟 + 磁盘 24h。冷启动时优先读磁盘，
 *          磁盘失效再走 Sina，Sina 失败则降级为空集并打 warn。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 上证50 官方成分股（上交所 2026-06-15 发布版，50 只；2026-06-12 调整后生效）
// 来源：https://www.sse.com.cn/market/sseindex/indexlist/basic/index.shtml?COMPANY_CODE=000016
// 注：本数据每半年（6月/12月）调整一次，建议下次调整时同步更新本数组。
//  2026-06 调入：特变电工/生益科技/中国铝业/华泰证券/兆易创新；
//  2026-06 调出：上汽集团/海尔智家/陕西煤业/京沪高铁/中国核电；
//  海天味业(603288) 已不在名单（2025-12 调整时调出后未再调入）。
const SSE50_CONSTITUENTS = [
  '600028', '600030', '600031', '600036', '600050', '600089', '600111', '600150',
  '600183', '600276', '600309', '600406', '600519', '600760', '600809', '600887',
  '600900', '600930', '601012', '601088', '601127', '601166', '601211', '601288',
  '601318', '601328', '601398', '601600', '601601', '601628', '601658', '601668',
  '601688', '601728', '601857', '601888', '601899', '601919', '601988', '603019',
  '603259', '603501', '603986', '603993', '688008', '688012', '688041', '688111',
  '688256', '688981',
];
// 注：600460 士兰微不在名单；上证50 ⊂ 沪深300，沪深300 包含士兰微。

// ===== Sina 沪深300 / 创业板指 缓存（进程内 + 磁盘）=====
const CACHE_DIR = path.join(__dirname, '..', 'data', 'index_cache');
const INMEM_TTL = 5 * 60 * 1000; // 5 分钟
const DISK_TTL = 24 * 60 * 60 * 1000; // 24 小时

const _inmem = new Map(); // key -> { ts, data }

function ensureCacheDir() {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* ignore */ }
}

function readDisk(key) {
  try {
    const p = path.join(CACHE_DIR, key + '.json');
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Date.now() - (j.ts || 0) > DISK_TTL) return null;
    return j.data;
  } catch (e) { return null; }
}

function writeDisk(key, data) {
  try {
    ensureCacheDir();
    fs.writeFileSync(path.join(CACHE_DIR, key + '.json'), JSON.stringify({ ts: Date.now(), data }));
  } catch (e) { /* 磁盘写失败不影响运行 */ }
}

async function fetchSinaNodeAll(node, total) {
  // Sina Market_Center API 分页：每页最多 100 只，按 num=100 拉多次
  const pages = Math.ceil(total / 100);
  const all = [];
  for (let p = 1; p <= pages; p++) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?num=100&page=${p}&node=${node}&sort=mktcap&asc=0`;
    try {
      const r = await axios.get(url, {
        headers: { 'User-Agent': UA, Referer: 'https://vip.stock.finance.sina.com.cn/' },
        timeout: 10000,
      });
      const rows = (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) || [];
      for (const x of rows) {
        if (x && x.code) all.push(String(x.code));
      }
    } catch (e) {
      console.warn(`[IndexConstituents] Sina ${node} page ${p} fetch failed:`, e.message);
    }
  }
  return Array.from(new Set(all)); // 去重
}

async function getHs300() {
  const key = 'hs300';
  const cached = _inmem.get(key);
  if (cached && Date.now() - cached.ts < INMEM_TTL) return cached.data;
  let data = readDisk(key);
  if (!data) {
    data = await fetchSinaNodeAll('hs300', 300);
    if (data && data.length) writeDisk(key, data);
  }
  if (data && data.length) _inmem.set(key, { ts: Date.now(), data });
  return data || [];
}

async function getCyb() {
  const key = 'cyb';
  const cached = _inmem.get(key);
  if (cached && Date.now() - cached.ts < INMEM_TTL) return cached.data;
  let data = readDisk(key);
  if (!data) {
    data = await fetchSinaNodeAll('cyb', 100);
    if (data && data.length) writeDisk(key, data);
  }
  if (data && data.length) _inmem.set(key, { ts: Date.now(), data });
  return data || [];
}

/**
 * 查个股是否在某指数成分内。
 * @param {string} symbol 6 位股票代码（不含交易所前缀）
 * @param {'sse50'|'hs300'|'cyb'} index
 * @returns {Promise<boolean>}
 */
async function isMemberOf(symbol, index) {
  const code = String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim();
  if (!code) return false;
  if (index === 'sse50') return SSE50_CONSTITUENTS.includes(code);
  if (index === 'hs300') {
    const set = await getHs300();
    return set.includes(code);
  }
  if (index === 'cyb') {
    const set = await getCyb();
    return set.includes(code);
  }
  return false;
}

/**
 * 一次性把个股所属市场的相关指数筛出来（含上交所/深交所/创业板映射 + 真实成分判定）。
 * 取代此前 "沪市 → 上证+上证50+沪深300" 一刀切的逻辑。
 *
 * @param {string} symbol
 * @param {string} cnIndexCodeList 腾讯行情接口返回的 cn 指数数组（每项含 code/name）
 * @returns {Promise<{indices: Array, scopeLabel: string, marketLabel: string}>}
 */
async function pickIndicesForStock(symbol, cnArr) {
  const all = (cnArr || []).filter(c => c && typeof c.changePct === 'number');
  if (!all.length) return { indices: [], scopeLabel: '—', marketLabel: '' };
  const code = String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim();
  // 检测交易所：6/9 开头 → SH；0/3 开头 → SZ
  const isSH = /^[69]/.test(code);
  const isSZ = /^[03]/.test(code);
  const isCyb = /^3/.test(code); // 创业板仅 30xxxx/301xxx

  // 20260905e：建两个 map（code→item 和 name→item），wantNames 是名称（与 cn[i].name 对齐），
  // 所以用 name 做 key 查找，否则会全部 miss 退回全宽基。
  const codeMap = new Map(all.map(c => [String(c.code || ''), c]));
  const nameMap = new Map(all.map(c => [String(c.name || ''), c]));
  const wantNames = []; // 指数名（与 cn[i].name 对齐）

  if (isSH) {
    // 上证指数：所有沪市股都属于（上证指数是全沪市加权指数）
    wantNames.push('上证指数');
    // 上证50：仅在官方 50 只名单内才引用
    if (await isMemberOf(code, 'sse50')) wantNames.push('上证50');
    // 沪深300：仅在 300 只名单内才引用
    if (await isMemberOf(code, 'hs300')) wantNames.push('沪深300');
  } else if (isSZ) {
    // 深证成指：所有深市主板/创业板股都引用（深证成指涵盖深市主板+中小板）
    wantNames.push('深证成指');
    // 创业板指：仅创业板股 + 在 100 只名单内才引用
    if (isCyb && await isMemberOf(code, 'cyb')) wantNames.push('创业板指');
    // 沪深300：仅在 300 只名单内才引用
    if (await isMemberOf(code, 'hs300')) wantNames.push('沪深300');
  } else {
    // 非 A 股：兜底全宽基
    return {
      indices: all,
      scopeLabel: '上证/深成指/创业板/沪深300/上证50/中证500/科创50（个股非 A 股，退回全宽基）',
      marketLabel: 'OTHER',
    };
  }

  const picked = wantNames.map(n => nameMap.get(n)).filter(Boolean);
  const scopeLabel = wantNames.join('/');
  if (!picked.length) {
    return { indices: all, scopeLabel: scopeLabel + '（个别指数缺失，已回退）', marketLabel: isSH ? 'SH' : 'SZ' };
  }
  return { indices: picked, scopeLabel, marketLabel: isSH ? 'SH' : 'SZ' };
}

module.exports = {
  SSE50_CONSTITUENTS,
  pickIndicesForStock,
  isMemberOf,
  // 暴露给上层按 name 过滤长期指数（longTerm 的 indices 数组只有 name + chg60d）
  isSHCode: (s) => /^[69]/.test(String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim()),
  isSZCode: (s) => /^[03]/.test(String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim()),
  isCybCode: (s) => /^3/.test(String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim()),
  isSse50: (s) => SSE50_CONSTITUENTS.includes(String(s || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim()),
};