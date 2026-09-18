/**
 * 行业板块资金流向（20260909o 重写：纯 Node 直连 push2delay）
 * --------------------------------------------------------------
 * 卡片：主力净流入/流出前五（含暗盘）+ 散户（小单）净流入/流出前五 + 近5日最大流入/流出（主力与小单各一组）
 * 数据源：东方财富 clist 接口（push2delay.eastmoney.com，本机 push2 主站被封锁）：
 *   - 今日口径：f62 主力净额/f184 占比、f66 超大/f69、f72 大单/f75、f78 中单/f81、f84 小单净额/f87 占比、f204 主力净流入最大股
 *   - 5日口径：f164 主力/f165、f172 小单净额/f173、f257 5日主力净流入最大股、f109 5日涨跌幅
 *   主力 = 超大单 + 大单（含暗盘性质机构资金）；小单 = 单笔＜2万股或＜4万元（散户口径）
 * 慢根因修复（20260909o）：旧版每次缓存过期 spawn Python（冷启动+import akshare 2~4s）再串行 4 请求
 *   （固定延时 3s），首屏 8~15s。改为：纯 Node curl 子进程 + 8 个定向小请求分 2 批并发 + 60s 缓存
 *   + in-flight 并发锁 + 服务启动预热，首屏基本即时。
 */
const { execFile } = require('child_process');
const { getEastmoneySectorRanking, parseSwSectorName, SW_LEVEL_UNIFIED } = require('./stockData');
const { localDate, localCompact, localDateFromTs } = require('./localDate');

let _cache = { ts: 0, data: null };
let _inFlight = null;
const CACHE_TTL = 60000; // 60 秒缓存（盘中资金流数据刷新节奏）

const UA = 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'Referer: https://data.eastmoney.com/bkzj/hy.html';
const UT = 'b2884a393a59ad64002292a3e90d46a5';
const HOST = 'https://push2delay.eastmoney.com/api/qt/clist/get';

const FIELDS_TODAY = 'f12,f14,f2,f3,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f204,f205,f124';
const FIELDS_5DAY = 'f12,f14,f2,f109,f164,f165,f166,f167,f168,f169,f170,f171,f172,f173,f257,f258,f124';

const _fmtYi = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n / 1e8 * 100) / 100 : 0;
};

// 单次定向请求：curl -4 直连 push2delay（与旧版 Python/curl 方案同参数，已验证稳定）
function _curlRows(fid, stat, po, pz) {
  const fields = stat === '1' ? FIELDS_TODAY : FIELDS_5DAY;
  const url = `${HOST}?pn=1&pz=${pz}&po=${po}&np=1&ut=${UT}&fltt=2&invt=2`
    + `&fid0=${fid}&fid=${fid}&fs=m:90+t:2&stat=${stat}&fields=${fields}&rt=52975239&_=${Date.now()}`;
  return new Promise((resolve, reject) => {
    execFile('curl', ['-4', '-s', '--connect-timeout', '5', '--max-time', '15', '-H', UA, '-H', REFERER, url],
      { timeout: 20000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return reject(new Error(`curl 退出码 ${err.code || err.message}`));
        try {
          const data = JSON.parse(stdout);
          const diff = data && data.data && data.data.diff;
          if (!Array.isArray(diff) || diff.length === 0) return reject(new Error('接口返回空 diff'));
          resolve(diff);
        } catch (e) {
          reject(new Error('JSON 解析失败: ' + e.message));
        }
      });
  });
}

async function _tryCurl(fid, stat, po, pz, retries = 1) {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try {
      return await _curlRows(fid, stat, po, pz);
    } catch (e) {
      lastErr = e;
      if (i < retries) await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

// 并发跑一批请求，单项失败不拖垮整批
async function _batch(jobs) {
  const results = await Promise.all(jobs.map(p => p.catch(e => ({ __err: e }))));
  return results.map(r => (r && r.__err) ? null : r);
}

function _pickLeader(row) {
  return (row && (row.f204 || row.f257)) ? String(row.f204 || row.f257).trim() : '';
}

function _empty(error) {
  return {
    ok: false,
    error: error || null,
    date: localDate(),
    source: '获取失败',
    note: '',
    todayInflowTop5: [],
    todayOutflowTop5: [],
    retailInflowTop5: [],
    retailOutflowTop5: [],
    fiveDayMaxInflow: null,
    fiveDayMaxOutflow: null,
    retailFiveDayMaxInflow: null,
    retailFiveDayMaxOutflow: null,
  };
}

async function fetchAll() {
  // 先并发取「东财全量行业板块」的名称→申万层级映射：资金流接口返回的板块名不一定带 Ⅱ/Ⅲ 后缀，
  // 需据此把每条资金流条目解析到统一层级，再按 SW_LEVEL_UNIFIED 过滤，保证榜单层级一致。
  const emSectorsP = getEastmoneySectorRanking().catch(e => {
    console.warn('[SectorCapitalFlow] 申万层级映射获取失败:', e.message);
    return null;
  });
  // 第 1 批（今日口径 4 个定向小请求）：主力净额降序/升序 + 小单净额降序/升序
  // 取数行数加大（PZ_TODAY/PZ_5D）：榜单只认统一层级（SW_LEVEL_UNIFIED），而净额头部多为一/二级板块，
  // 必须多取一些原始行，过滤到该层级后仍有足量候选（否则会出现「不足5条/为空」）。
  const PZ_TODAY = 60, PZ_5D = 30;
  const batch1 = await _batch([
    _tryCurl('f62', '1', '1', PZ_TODAY),  // 今日主力 desc → 流入前五
    _tryCurl('f62', '1', '0', PZ_TODAY),  // 今日主力 asc → 流出前五
    _tryCurl('f84', '1', '1', PZ_TODAY),  // 今日小单 desc → 散户流入前五
    _tryCurl('f84', '1', '0', PZ_TODAY),  // 今日小单 asc → 散户流出前五
  ]);
  await new Promise(r => setTimeout(r, 400)); // 批间小延时，避免触发东财限流
  // 第 2 批（5日口径 4 个）：主力/小单 各 desc/asc 头部
  const batch2 = await _batch([
    _tryCurl('f164', '5', '1', PZ_5D),
    _tryCurl('f164', '5', '0', PZ_5D),
    _tryCurl('f172', '5', '1', PZ_5D),
    _tryCurl('f172', '5', '0', PZ_5D),
  ]);
  const [mainDesc, mainAsc, retailDesc, retailAsc, d5MainIn, d5MainOut, d5RetailIn, d5RetailOut] = [...batch1, ...batch2];

  const dead = batch1.every(x => x === null) && batch2.every(x => x === null);
  if (dead) throw new Error('东财板块资金流接口全部请求失败（push2delay 不可达）');

  // 名称→申万层级映射（等待前置请求）：优先名称自带 Ⅱ/Ⅲ 后缀，其次用全量榜兜底
  const emSectors = await emSectorsP;
  const levelMap = new Map();
  if (emSectors && Array.isArray(emSectors.allSectors)) {
    for (const s of emSectors.allSectors) {
      if (s.swLevel && s.name) levelMap.set(s.name, s.swLevel);
    }
  }
  const resolveLevel = (parsed) => parsed.swLevel || levelMap.get(parsed.name) || null;

  const tile = (row, netKey) => {
    if (!row) return null;
    const parsed = parseSwSectorName(row.f14);
    return {
      name: parsed.name,
      rawName: parsed.rawName,
      swLevel: resolveLevel(parsed),
      changePct: Number(row.f3) || 0,
      mainNet: _fmtYi(row[netKey]),
      superLargeNet: netKey === 'f62' ? _fmtYi(row.f66) : null,
      largeNet: netKey === 'f62' ? _fmtYi(row.f72) : null,
      leader: _pickLeader(row),
    };
  };

  // 统一分级（20260916）：只保留 SW_LEVEL_UNIFIED 指定层级的板块。
  // 原实现混入一级/二级板块，导致「电子(一级)」与「半导体(二级)」同时上榜、同一笔资金被重复计入。
  const inLevel = (x) => !!x && x.swLevel === SW_LEVEL_UNIFIED;

  const topPositive = (rows, netKey, n = 5) => (rows || [])
    .map(r => tile(r, netKey)).filter(x => inLevel(x) && x.mainNet > 0)
    .sort((a, b) => b.mainNet - a.mainNet).slice(0, n);
  const topNegative = (rows, netKey, n = 5) => (rows || [])
    .map(r => tile(r, netKey)).filter(x => inLevel(x) && x.mainNet < 0)
    .sort((a, b) => a.mainNet - b.mainNet).slice(0, n);

  const fiveDayTile = (rows, netKey, dir) => {
    const list = (rows || []).map(r => tile(r, netKey)).filter(inLevel)
      .sort((a, b) => dir === 'max' ? b.mainNet - a.mainNet : a.mainNet - b.mainNet);
    return list[0] || null;
  };

  const anyToday = batch1.some(x => x !== null);
  const result = {
    ok: anyToday || batch2.some(x => x !== null),
    date: localDate(),
    source: '东方财富·板块资金流向',
    note: '主力净流入 = 超大单净流入 + 大单净流入（含暗盘性质机构资金）；散户净流入 = 小单净流入（单笔＜2万股或＜4万元）；榜单统一申万' + SW_LEVEL_UNIFIED + '口径（单层级，父子行业不重复计入）',
    todayInflowTop5: topPositive(mainDesc, 'f62'),
    todayOutflowTop5: topNegative(mainAsc, 'f62'),
    retailInflowTop5: topPositive(retailDesc, 'f84'),
    retailOutflowTop5: topNegative(retailAsc, 'f84'),
    fiveDayMaxInflow: fiveDayTile(d5MainIn, 'f164', 'max'),
    fiveDayMaxOutflow: fiveDayTile(d5MainOut, 'f164', 'min'),
    retailFiveDayMaxInflow: fiveDayTile(d5RetailIn, 'f172', 'max'),
    retailFiveDayMaxOutflow: fiveDayTile(d5RetailOut, 'f172', 'min'),
    fallbackWarning: null,
    fiveDayWarning: (batch2.every(x => x === null) && batch2.length > 0) ? '近5日资金流向获取失败' : null,
  };

  return result;
}

async function getSectorCapitalFlow(refresh = false) {
  const now = Date.now();
  if (!refresh && _cache.data && now - _cache.ts < CACHE_TTL) {
    return _cache.data;
  }
  // in-flight 并发锁：并发请求共享同一次抓取，避免重复打接口
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const result = await fetchAll();
      _cache = { ts: Date.now(), data: result };
      return result;
    } catch (e) {
      console.error('[SectorCapitalFlow] error:', e.message);
      // 有旧缓存时降级返回旧数据并标注，避免闪空
      if (_cache.data) {
        const stale = { ..._cache.data, staleWarning: '数据刷新失败，以下为最近一次成功数据：' + e.message };
        return stale;
      }
      return _empty(e.message);
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

// 服务启动预热：提前填充缓存，用户打开首页即命中（由 server.js 启动流程调用）
function warmup() {
  getSectorCapitalFlow(false).catch(() => {});
}

module.exports = { getSectorCapitalFlow, warmup };
