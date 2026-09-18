/**
 * 个股「所属行业板块」一级/二级/三级 解析（单一可信源 · 确定性）
 * ================================================================
 * 用途：行业分析页「板块总市值走势」统一模板 —— 每只个股分别与所属
 *       申万一级 / 二级 / 三级行业板块的行业总市值做双坐标走势比对（三张图）。
 *       没有对应三级板块时省略第三张。
 *
 * 数据源（规则一·单一权威源）：
 *   东方财富「个股所属板块」接口
 *   `https://push2delay.eastmoney.com/api/qt/slist/get?...&secid={secid}&spt=3&fields=f12,f13,f14`
 *   返回该股所属的**全部**板块（行业板块 + 地区板块 + 概念板块 + 指数板块），
 *   形如：BK1201 电子 / BK1036 半导体 / BK1327 分立器件 / BK0172 浙江板块 / BK0500 HS300_ …
 *
 * 层级判定（复用现有唯一字典，不新增映射）：
 *   对每个板块名调用 `parseSwSectorName(name).swLevel`：
 *     - 行业板块（电子 / 半导体 / 分立器件 / 食品饮料 / 调味发酵品Ⅱ / 保险Ⅲ …）→ 返回 一级/二级/三级
 *     - 地区/概念/指数板块（浙江板块 / 融资融券 / HS300_ / 国产芯片 / 5G概念 …）→ 返回 null
 *   实测 4 只样例股（士兰微/海天/平安/麦捷）零误判：行业板块全部命中、其余全部 null。
 *   因此「swLevel 非 null」即为行业板块的判定条件，无需再跨表核对。
 *
 * 缓存：按 symbol 内存缓存 30 分钟（板块归属变动极少）；force 可跳过。
 */
const axios = require('axios');
const { getEastmoneySecid, parseSwSectorName } = require('./stockData');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const HEADERS = { 'User-Agent': UA, Referer: 'https://quote.eastmoney.com/' };
// 主机回退：push2delay 为主镜像，push2 兜底（本机 push2 偶发被限，但作为第二源仍值得一试）
const HOSTS = ['https://push2delay.eastmoney.com', 'https://push2.eastmoney.com'];
const CACHE_TTL_MS = 30 * 60 * 1000;
const LEVEL_ORDER = ['一级', '二级', '三级'];

const _cache = new Map();

function normCode(symbol) {
  return String(symbol || '').replace(/^(SH|SZ|BJ|sh|sz|bj)/, '').trim();
}

/** 拉取个股所属全部板块（[{code,name}]） */
async function fetchBoards(secid) {
  for (const host of HOSTS) {
    try {
      const url = `${host}/api/qt/slist/get?fltt=2&invt=2&np=1&secid=${encodeURIComponent(secid)}&spt=3&fields=f12,f13,f14&pi=0&pz=100&po=1`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
      const diff = (data && data.data && Array.isArray(data.data.diff)) ? data.data.diff : [];
      const list = diff
        .map(d => ({ code: String(d.f12 || ''), name: String(d.f14 || '').trim() }))
        .filter(x => x.code && x.name);
      if (list.length) return list;
    } catch (e) {
      console.warn(`[StockSectorLevels] slist ${host} 失败: ${e && e.message}`);
    }
  }
  return [];
}

/**
 * 解析个股所属 一级/二级/三级 行业板块。
 * @param {string} symbol 股票代码（支持 SH/SZ 前缀或纯数字）
 * @param {object} [opts]
 * @param {string} [opts.name] 股票名称（仅回显）
 * @param {boolean} [opts.force=false] 跳过缓存
 * @returns {Promise<{success:boolean, symbol:string, name:string, levels:Array<{swLevel:string,sectorCode:string,sectorName:string}>, industryBoards:Array, source:string, fetchedAt:string}>}
 */
async function resolveStockSectorLevels(symbol, opts = {}) {
  const code = normCode(symbol);
  const displayName = opts.name || '';
  if (!code) return { success: false, error: 'NO_SYMBOL', symbol: '', name: displayName, levels: [] };

  if (!opts.force) {
    const hit = _cache.get(code);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
      return { ...hit.data, name: displayName || hit.data.name || '', cached: true };
    }
  }

  let secid = '';
  try { secid = getEastmoneySecid(code); } catch { secid = ''; }
  if (!secid) {
    return { success: false, error: 'NO_SECID', symbol: code, name: displayName, levels: [] };
  }

  const boards = await fetchBoards(secid);
  if (!boards.length) {
    return { success: false, error: 'NO_BOARDS', symbol: code, name: displayName, levels: [], message: '未获取到个股所属板块（数据源受限）' };
  }

  // 归类：每个层级取「首个」命中的行业板块（slist 按涨跌幅排序，同层一般唯一）
  const byLevel = {};
  const industryBoards = [];
  for (const b of boards) {
    const parsed = parseSwSectorName(b.name);
    const lv = parsed && parsed.swLevel ? parsed.swLevel : null;
    if (!lv) continue; // 地区/概念/指数板块
    const item = { swLevel: lv, sectorCode: b.code, sectorName: b.name };
    industryBoards.push(item);
    if (!byLevel[lv]) byLevel[lv] = item;
  }
  const levels = LEVEL_ORDER.map(lv => byLevel[lv]).filter(Boolean);

  const result = {
    success: levels.length > 0,
    symbol: code,
    name: displayName,
    levels,
    industryBoards, // 全部命中行业板块（多用于调试/展示）
    source: '东方财富·个股所属板块(slist spt=3)',
    fetchedAt: new Date().toISOString(),
    cached: false,
  };
  if (!levels.length) result.message = '未解析到行业板块层级（可能为非申万行业个股）';

  _cache.set(code, { ts: Date.now(), data: result });
  console.log(`[StockSectorLevels] ${code} ${displayName} → ${levels.map(l => `${l.swLevel}:${l.sectorName}(${l.sectorCode})`).join(' / ') || '无'}`);
  return result;
}

module.exports = { resolveStockSectorLevels };
