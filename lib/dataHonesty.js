/**
 * 数据诚实原则（核心底层逻辑）
 * ================================================================
 * 规则：没有"成功获取"的数据，必须明确告知"获取失败"，绝不能用
 *   ① 其他来源的数据冒充（跨源替代）；
 *   ② 陈旧快照当新数据（除非显式标注 stale / 滞后）；
 *   ③ 零值 / 空值 / 默认值伪装成"已算出"的结果（silent padding）。
 *
 * 所有"数据获取 / 计算"函数应返回以下统一信封之一：
 *   - 成功(实时)： { success:true,  source, fetchedAt, ...data }
 *   - 成功(陈旧)： { success:true,  source, fetchedAt, stale:true, staleReason, ...data }  // 必须显式标注
 *   - 获取失败：   { success:false, source, error, errorType, reason }
 *
 * 调用方/前端据此渲染：fresh=正常 | stale=黄色"滞后/快照" | failed=红色"获取失败"。
 * 本模块不依赖任何外部包，可被任意 lib / 测试 / 前端复用。
 */

function nowISO() {
  return new Date().toISOString();
}

/** 成功（实时/同源）结果 */
function ok(data, meta) {
  meta = meta || {};
  return Object.assign({ success: true, source: meta.source || '', fetchedAt: meta.fetchedAt || nowISO() }, data);
}

/** 成功但数据陈旧（必须显式标注，前端以黄色告警呈现，绝不伪装成实时） */
function stale(data, meta) {
  meta = meta || {};
  return Object.assign(
    { success: true, stale: true, staleReason: meta.reason || '数据滞后/快照（非实时）', source: meta.source || '', fetchedAt: meta.fetchedAt || nowISO() },
    data
  );
}

/** 获取失败：诚实声明，绝不返回零值聚合伪装成功 */
function fail(error, meta) {
  meta = meta || {};
  const msg = (typeof error === 'string') ? error : (error && error.message) || 'UNKNOWN';
  return {
    success: false,
    source: meta.source || '',
    fetchedAt: nowISO(),
    error: msg,
    errorType: meta.errorType || 'FETCH_FAILED',
    reason: meta.reason || msg,
  };
}

/** 分类：fresh | stale | failed */
function classify(r) {
  if (!r || r.success === false || r.ok === false) return 'failed';
  if (r.stale === true) return 'stale';
  return 'fresh';
}

function isFailure(r) { return classify(r) === 'failed'; }
function isStale(r) { return !!(r && r.success === true && r.stale === true); }
function isFresh(r) { return !!(r && r.success === true && !r.stale); }

/**
 * 反"凑数"检测：识别把失败/无数据伪装成成功结果的典型特征。
 * 命中即视为违反诚实原则，交由 test_data_honesty.js 静态断言。
 *
 * 判定：对象看起来像一个"结果"（含 success 字段且为 true，或无 success 但像数据信封），
 * 同时其 stats/summary 类字段全为 0，且伴有 note/error 说明这是失败/不可用。
 * （纯统计助手如 _calcStats 在"空输入"时返回全 0 是合法行为，但调用方必须据此返回
 *   success:false；因此该函数只检测"结果信封级"的伪装，不检测纯统计助手本身。）
 */
function hasSilentPadding(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.success === false || obj.ok === false) return false; // 已诚实声明失败
  const s = obj.stats;
  if (s && typeof s === 'object') {
    const zeroKeys = ['mean', 'std', 'high', 'low', 'median', 'sum', 'avg'].filter(function (k) { return s[k] === 0; });
    if (zeroKeys.length >= 3 && (obj.note || obj.error || obj.reason)) return true;
  }
  return false;
}

/**
 * P0-3 代理口径分级打标（20261110，整改方案阶段 1）
 * ================================================================
 * 三态：observed（直接观测）/ proxy（代理推断）/ missing（缺失）。
 * 裁决③：proxy **只做展示角标**，不进打分聚合（聚合层观察一月再议）。
 *
 * 【observed 判定基准（写死，后续所有模块接入时按此判）】
 *   observed = 数据源直接返回的数值，**未经任何代码加工**——
 *   一旦有「转换」「推算」「代理」（换算单位、跨源拼接、以 A 推 B、阈值近似），就是 proxy，不是 observed。
 *
 * 【预留开关（执行清单：一个月后聚合层可能改，现在别写死）】
 *   DATA_HONESTY_PROXY_IN_SCORE = false：proxy 项是否参与打分聚合降权。默认 false（裁决③只展示）；
 *   观察一月后若裁决改为「进打分」，把此开关改 true，聚合层按此分支，无需再改结构。
 *
 * 数据契约：任何输出对象可带 `honesty` 字段：
 *   { kind: 'observed'|'proxy'|'missing', proxyKey?, proxyName?, boundary?, note? }
 * 前端约定：kind==='proxy' 渲染中性色「代理」角标（title=boundary 适用边界），
 * 与 observed 混排时不得同权重展示（角标可见即可），**禁止**红涨绿跌语义色。
 *
 * PROXY_REGISTRY 为全站唯一代理口径清单（六项），产出侧模块必须用 proxyTag(key) 引用，
 * 新增/修改口径只改本表；test_data_honesty.js 静态扫描接线点。
 */
const PROXY_REGISTRY = {
  'big-drop-def': {
    name: '大面股定义',
    boundary: '昨日涨停股今日跌超 5% 计「大面」，工作台自定义阈值，非交易所定义',
    since: '2026-11-10',
  },
  'liquidity-line': {
    name: '流动性 1 亿线',
    boundary: '个股成交额 < 1.0 亿元计「流动性不足」，工作台自定义阈值',
    since: '2026-11-10',
  },
  'sector-core-proxy': {
    name: '板块中军代理',
    boundary: '以涨停池内流通市值居前个股近似「板块中军」，非真实板块中军（无板块成分股映射）',
    since: '2026-11-10',
  },
  'zt-pool-market': {
    name: '涨停池代表全市场',
    boundary: '以涨停池样本聚合推断全市场情绪/题材结构，未覆盖非涨停股',
    since: '2026-11-10',
  },
  'single-stock-heat': {
    name: '单股代理热度',
    boundary: '以中国平安（601318）股吧情绪样本近似全市场个股情绪',
    since: '2026-11-10',
  },
  'lhb-keyword': {
    name: '龙虎榜游资关键词',
    boundary: '机构/游资动向为「解读」文本关键词计数，非席位穿透核验',
    since: '2026-11-10',
  },
};

/** 预留开关（见文件头说明）：proxy 项是否进打分聚合。默认 false=只展示角标（裁决③）。 */
const DATA_HONESTY_PROXY_IN_SCORE = false;

/** observed（直接观测）标注 */
function observedTag(note) {
  return { kind: 'observed', note: note || null };
}

/** proxy（代理推断）标注：key 必须在 PROXY_REGISTRY 内，防止口径漂移 */
function proxyTag(key, note) {
  const p = PROXY_REGISTRY[key];
  if (!p) throw new Error('[dataHonesty] 未知代理口径 key: ' + key + '（请先在 PROXY_REGISTRY 登记）');
  return { kind: 'proxy', proxyKey: key, proxyName: p.name, boundary: p.boundary, note: note || null };
}

/** missing（缺失）标注 */
function missingTag(note) {
  return { kind: 'missing', note: note || null };
}

/** 判定函数（供前端/消费方使用） */
function honestyKind(obj) {
  const h = obj && obj.honesty;
  return h && h.kind ? h.kind : null;
}
function isProxy(obj) { return honestyKind(obj) === 'proxy'; }

module.exports = {
  ok, stale, fail, classify, isFailure, isStale, isFresh, hasSilentPadding, nowISO,
  PROXY_REGISTRY, observedTag, proxyTag, missingTag, honestyKind, isProxy,
  DATA_HONESTY_PROXY_IN_SCORE,
};
