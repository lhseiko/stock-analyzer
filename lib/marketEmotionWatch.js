#!/usr/bin/env node
/**
 * marketEmotionWatch.js — 市场情绪提醒「观察指标层」（任务卡 #011 阶段一）
 * ============================================================================
 * 定位：**只展示、不打分**。4 个候选维度（波动率 / 期指基差 /
 * 板块主线 / 消息面）先以观察指标接入，供用户积累至少 20 个交易日验证稳定性，
 * 阶段二再单独出卡决定是否升格为正式因子。
 *
 * 硬边界（不得突破）：
 *   1. 不进基准权重表 / 因子明细 / 总分 / 倾向 / 建议 / 风险提示。
 *   2. 不进 state.json / records.json / 自学习 / 准确率台账 / 月报健康度。
 *   3. 不改任何既有因子的计算逻辑与数值；历史 58 条记录保持可比。
 *   4. 零网络、零 LLM、零随机：全部数值由代码从「运行时已有数据 + 本地落盘 JSON」
 *      确定性计算；同一输入两次输出逐字一致。
 *   5. 三条底层规则：数据一致性（单一权威源 + 五要素）、数据最新性
 *      （真实数据日 + 交易日感知 + 缺口如实标注）、变化与边际分析
 *      （当前值 + 方向 + 幅度）。
 *   6. 原则 A/B/C（docs/logic/common-01-data-source.md §二.4）：
 *      日频数据以最近交易日为基准，非交易日沿用不归零；日期标签不得用运行日冒充。
 *
 * 数据源（每个 ready 项都是单一权威源，不用别的读数冒充）：
 *   - 波动率：data.index.bars（腾讯行情指数日线，与情绪模型同源）
 *   - 板块主线：data/sector_rank_history.json（日键为数据日，不认 recordedAt 写入时间）
 *   - 消息面：data/events/active.json（既有事件引擎落盘，只列清单不做市场级方向判定）
 *   - 赚钱效应：SQLite limit_pool_daily（任务卡 #012，复盘 context / akshare 东财池真实统计）
 *   - 期指基差：本地无 IF/IH/IC/IM 行情通道 → 如实标 unavailable
 *
 * 注意：`value: null` + `unavailable` 表示「本来就没有这个数」，与原则 A/B 的
 * 「不得把已有数值归零」不是一回事；这里没有编造 0，也没有把 0 当结论。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { isTradingDay, asOfTradingDate } = require('./cnTradingCalendar');
const limitPoolStore = require('./limitPoolStore');

const ROOT = path.join(__dirname, '..');
const WATCH_VERSION = '20261118a';

const VOL_WINDOW = 20;          // 20 个简单收益率 → 需 21 根日线
const VOL_MARGINAL_BACK = 5;    // 与 5 个交易日前同口径值比较
const ANNUALIZE = Math.sqrt(252);
const SECTOR_WINDOW = 5;        // 最近 5 个交易日 Top5 领涨板块

/** 保留 2 位小数，避免浮点漂移破坏「数据不变则结论不变」 */
function r2(x) { return Math.round(x * 100) / 100; }

function localDate(d) {
  d = d || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 样本标准差 (n−1)；样本不足返回 null，不外推 */
function stdev(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return null;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const v = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (arr.length - 1);
  return Math.sqrt(v);
}

/**
 * 滚动历史波动率序列（年化 %）。
 * bars: [{ date, close }]；每点用 window 个简单收益率，样本标准差 × √252。
 * 返回 [{ date, vol, samples }]，样本不足时为空数组（由调用方标 unavailable）。
 */
function realizedVolSeries(bars, window) {
  window = Number(window) > 1 ? Number(window) : VOL_WINDOW;
  const clean = (Array.isArray(bars) ? bars : []).filter(
    b => b && typeof b.close === 'number' && isFinite(b.close) && b.close > 0 && b.date
  );
  const out = [];
  for (let i = window; i < clean.length; i++) {
    const seg = clean.slice(i - window, i + 1);
    const rets = [];
    for (let j = 1; j < seg.length; j++) rets.push(seg[j].close / seg[j - 1].close - 1);
    const sd = stdev(rets);
    if (sd == null) continue;
    out.push({ date: seg[seg.length - 1].date, vol: r2(sd * ANNUALIZE * 100), samples: rets.length });
  }
  return out;
}

/**
 * 通用边际：当前值 vs back 个交易日前同口径值。
 * 返回 { direction, delta, unit, base, compareTo } 或 null（序列不够长）。
 */
function marginalChange(series, back, field) {
  back = Number(back) > 0 ? Number(back) : VOL_MARGINAL_BACK;
  field = field || 'vol';
  if (!Array.isArray(series) || series.length <= back) return null;
  const cur = series[series.length - 1];
  const prev = series[series.length - 1 - back];
  if (!cur || !prev || typeof cur[field] !== 'number' || typeof prev[field] !== 'number') return null;
  const delta = r2(cur[field] - prev[field]);
  return {
    direction: delta > 0.005 ? 'up' : delta < -0.005 ? 'down' : 'flat',
    delta,
    unit: '百分点',
    base: prev[field],
    compareTo: prev.date,
  };
}

/** 板块历史的合法日键：YYYY-MM-DD、不晚于基准日、且是交易日 */
function sectorDays(history, asOf) {
  if (!history || typeof history !== 'object') return [];
  return Object.keys(history)
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && (!asOf || k <= asOf) && isTradingDay(k))
    .sort();
}

function topNames(entry) {
  const up = entry && Array.isArray(entry.up) ? entry.up : [];
  return up.slice(0, 5).map(x => String((x && x.name) || '')).filter(Boolean);
}

function avgChangePct(entry) {
  const up = entry && Array.isArray(entry.up) ? entry.up : [];
  const vals = up.slice(0, 5).map(x => Number(x && x.changePct)).filter(v => isFinite(v));
  return vals.length ? r2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

/**
 * 主线延续度：某日 Top5 领涨板块，在前 4 个交易日 Top5 中的平均命中率（0~100）。
 * 输入的是「已按日期排序的日键数组」与「history 原对象」，endIdx 为目标日下标。
 */
function continuityAt(dayKeys, history, endIdx) {
  if (!Array.isArray(dayKeys) || endIdx < 1 || endIdx >= dayKeys.length) return null;
  const cur = topNames(history[dayKeys[endIdx]]);
  if (!cur.length) return null;
  let sum = 0, n = 0;
  for (let j = 1; j <= 4 && endIdx - j >= 0; j++) {
    const prev = topNames(history[dayKeys[endIdx - j]]);
    if (!prev.length) continue;
    const hit = cur.filter(x => prev.indexOf(x) >= 0).length;
    sum += hit / cur.length;
    n++;
  }
  return n ? r2(sum / n * 100) : null;
}

/** 既有事件引擎落盘：只保留真正在生效、且未被中性化的事件 */
function activeEvents(events) {
  const list = (Array.isArray(events) ? events : []).filter(
    e => e && e.status === 'active' && !e.paused && !e.marketNeutralized
  );
  return list.map(e => ({
    title: String(e.title || ''),
    sector: String(e.sector || ''),
    direction: String(e.direction || 'neutral'),
    grade: String(e.grade || ''),
    time: typeof e.createdAt === 'string' ? e.createdAt.slice(0, 10) : null,
  }));
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return null; }
}

function readyItem(meta, extra) {
  return Object.assign({
    key: meta.key,
    name: meta.name,
    status: 'ready',
    value: null,
    unit: '',
    detail: '',
    asOf: null,
    asOfKind: 'trading-day',
    source: '',
    method: '',
    completeness: '',
    change: null,
    note: '',
    plain: '',
  }, extra || {});
}

function unavailableItem(meta, reason, requirement, plain) {
  return {
    key: meta.key,
    name: meta.name,
    status: 'unavailable',
    value: null,
    unit: '',
    detail: reason,
    asOf: null,
    asOfKind: 'trading-day',
    source: '无',
    method: '阶段一不接入网络取数；待数据源落盘后再计算',
    completeness: '0',
    change: null,
    note: requirement,
    plain: plain || '这项没数据，暂时看不出什么。',
  };
}

const META = {
  volatility: { key: 'volatility', name: '波动率（20 日年化）' },
  futuresBasis: { key: 'futuresBasis', name: '期指基差' },
  sectorLead: { key: 'sectorLead', name: '板块主线' },
  newsFlow: { key: 'newsFlow', name: '消息面' },
};

// 固定顺序（20261116c 起 4 项：赚钱效应已并入「市场宽度 · 赚钱效应」因子，不在观察层重复展示）
const ORDER = ['volatility', 'futuresBasis', 'sectorLead', 'newsFlow'];

/**
 * 主入口：生成观察指标层。
 * @param {object} input
 *   - data: getMarketEmotionData() 的原始返回（用 data.index.bars）
 *   - emo:  computeMarketEmotion() 的结果（用 emo.baselineDate 作基准日）
 *   - opts: { dataDir, today } —— dataDir 可注入，供离线守卫构造夹具
 * @returns {object} { version, asOf, scope, items[5], summary }
 */
function buildWatchIndicators(input) {
  input = input || {};
  const data = input.data || {};
  const emo = input.emo || {};
  const opts = input.opts || {};
  const dataDir = opts.dataDir || path.join(ROOT, 'data');
  const today = opts.today || localDate();
  // 原则 A/C：基准日一律取模型算出的最近交易日，绝不回退到运行日
  const asOf = emo.baselineDate || data.baselineDate || asOfTradingDate(today);

  const items = [];

  // ① 波动率 ---------------------------------------------------------------
  {
    const bars = (data.index && Array.isArray(data.index.bars)) ? data.index.bars : [];
    const valid = bars.filter(b => b && typeof b.close === 'number' && isFinite(b.close) && b.close > 0 && b.date);
    const series = realizedVolSeries(bars, VOL_WINDOW);
    if (!series.length) {
      items.push(unavailableItem(
        META.volatility,
        `指数日线不足：有效 ${valid.length}/${VOL_WINDOW + 1} 根，无法计算 ${VOL_WINDOW} 个收益率；不外推、不补值`,
        `需至少 ${VOL_WINDOW + 1} 根连续交易日收盘价`,
        '指数日线不够，暂时看不出市场稳不稳。'
      ));
    } else {
      const cur = series[series.length - 1];
      const chg = marginalChange(series, VOL_MARGINAL_BACK, 'vol');
      const dirWord = chg ? (chg.direction === 'up' ? '上升' : chg.direction === 'down' ? '下降' : '持平') : '样本不足';
      // 文案直接表达：说「下降 0.11 个百分点」，不说「下降 -0.11 个百分点」（双重反向）
      const chgTxt = chg
        ? `较 ${chg.compareTo}（${chg.base}%）${dirWord} ${Math.abs(chg.delta)} 个百分点`
        : '不足 5 个交易日历史，暂不给边际';
      items.push(readyItem(META.volatility, {
        value: cur.vol,
        unit: '%',
        detail: `上证指数近 ${VOL_WINDOW} 个交易日收盘收益率的年化波动率；${chgTxt}`,
        asOf: cur.date,
        source: '腾讯行情指数日线（与情绪模型 data.index.bars 同源）',
        method: `${VOL_WINDOW} 日简单收益率 → 样本标准差(n−1) × √252 × 100%`,
        completeness: `${cur.samples}/${VOL_WINDOW} 个收益率；共 ${series.length} 个滚动点`,
        change: chg,
        note: '仅展示波动水平与边际，不映射为看涨/看跌方向',
        plain: !chg || chg.direction === 'flat'
          ? '指数波动和上周差不多。'
          : chg.direction === 'up' ? '指数波动在放大，市场更不安。' : '指数波动不大，比上周更平稳。',
      }));
    }
  }

  // [20261116c] ② 赚钱效应已并入「市场宽度 · 赚钱效应」因子（子权重 30%，参与打分），
  // 观察层不再重复展示，避免同一读数在页面出现两次。原缺口判定逻辑随之移除。

  // ② 期指基差 -------------------------------------------------------------
  items.push(unavailableItem(
    META.futuresBasis,
    '全库无 IF/IH/IC/IM 股指期货行情字段与通道；lib/futuresData.js 是新浪商品期货（个股对标相关性用），不能冒充',
    '待接入条件：新增股指期货行情源并按交易日落盘基差',
    '这项没数据，暂时看不出期货资金的态度。'
  ));

  // ④ 板块主线 -------------------------------------------------------------
  {
    const file = path.join(dataDir, 'sector_rank_history.json');
    const hist = readJson(file);
    if (!hist) {
      items.push(unavailableItem(META.sectorLead, `读取 ${path.basename(file)} 失败或文件缺失`, '需板块涨跌前五按交易日结构化落盘', '板块数据不全，暂时看不出主线。'));
    } else {
      const allKeys = Object.keys(hist).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k));
      const keys = sectorDays(hist, asOf);
      const skipped = allKeys.length - keys.length;
      const last = keys.length - 1;
      if (last < 1 || !topNames(hist[keys[last]]).length) {
        items.push(unavailableItem(
          META.sectorLead,
          `基准日 ${asOf} 之前的合法交易日板块记录不足（${keys.length} 日），无法算延续度；不外推`,
          `需至少 2 个交易日、每日含 Top5 领涨板块`,
          '板块记录不够，暂时看不出主线。'
        ));
      } else {
        const cur = continuityAt(keys, hist, last);
        const prev = last >= SECTOR_WINDOW ? continuityAt(keys, hist, last - 1) : null;
        const delta = (cur != null && prev != null) ? r2(cur - prev) : null;
        const chg = delta == null ? null : {
          direction: delta > 0.005 ? 'up' : delta < -0.005 ? 'down' : 'flat',
          delta, unit: '百分点', base: prev, compareTo: keys[last - 1],
        };
        const leaders = topNames(hist[keys[last]]).slice(0, 3);
        const avg = avgChangePct(hist[keys[last]]);
        const dirWord = chg ? (chg.direction === 'up' ? '上升' : chg.direction === 'down' ? '下降' : '持平') : '样本不足';
        const chgTxt = chg ? `；延续度较前一窗口${dirWord} ${Math.abs(chg.delta)} 个百分点` : '（不足 6 个交易日，暂不给边际）';
        items.push(readyItem(META.sectorLead, {
          value: cur,
          unit: '%',
          detail: `近 ${Math.min(SECTOR_WINDOW, last + 1)} 日 Top5 领涨板块延续度；当日领涨前三：${leaders.join(' / ') || '—'}${avg != null ? `；Top5 平均涨幅 ${avg}%` : ''}${chgTxt}${skipped > 0 ? `；已跳过 ${skipped} 个非交易日或晚于基准日的日键` : ''}`,
          asOf: keys[last],
          source: 'data/sector_rank_history.json（板块涨跌前五按交易日落盘）',
          method: '当日 Top5 与前 4 个交易日 Top5 的平均命中率 × 100%；数据日只认 YYYY-MM-DD 日键，不认 recordedAt 写入时间',
          completeness: `${Math.min(SECTOR_WINDOW, last + 1)}/${SECTOR_WINDOW} 个交易日；共 ${keys.length} 个合法日键`,
          change: chg,
          note: '仅展示主线是否延续，不映射为看涨/看跌方向',
          plain: cur == null ? '暂时看不出主线强弱。'
            : cur >= 40 ? '领涨板块有延续，主线较清楚。'
              : cur >= 20 ? '主线一般，热点有切换。'
                : '领涨板块几乎天天换，热点很散。',
        }));
      }
    }
  }

  // ⑤ 消息面 ---------------------------------------------------------------
  {
    const file = path.join(dataDir, 'events', 'active.json');
    const raw = readJson(file);
    if (!raw) {
      items.push(unavailableItem(META.newsFlow, `读取 ${path.basename(file)} 失败或文件缺失`, '需事件引擎 active.json 落盘', '消息数据没取到，暂时看不出消息面冷热。'));
    } else {
      const list = activeEvents(raw);
      const times = list.map(e => e.time).filter(Boolean).sort();
      const eventDate = times.length ? times[times.length - 1] : null;
      const brief = list.length
        ? list.slice(0, 3).map(e => `${e.sector || '全市场'}·${e.title}`).join('；')
        : '当前无生效事件';
      items.push(readyItem(META.newsFlow, {
        value: list.length,
        unit: '条',
        detail: `${brief}；只列事件清单，不做全市场方向判定（市场级方向仍由既有非常驻宏观因子负责）`,
        asOf: eventDate,
        asOfKind: 'event-time',
        source: 'data/events/active.json（既有 eventEngine 落盘）',
        method: '过滤 status=active 且未 paused / 未 marketNeutralized 的事件；只做清单汇总',
        completeness: `${list.length}/${Array.isArray(raw) ? raw.length : 0} 条生效（其余已暂停或已中性化）`,
        change: null,
        note: 'asOf 为事件时间，不是行情数据日；不新建第二套事件口径',
        plain: list.length === 0 ? '消息面清淡，暂无驱动。'
          : list.length <= 2 ? '消息面偏清淡，还没形成主线。'
            : '消息面较热闹，留意板块轮动。',
      }));
    }
  }

  const ordered = ORDER.map(k => items.find(x => x.key === k)).filter(Boolean);
  const ready = ordered.filter(x => x.status === 'ready').length;
  const missing = ordered.filter(x => x.status === 'unavailable');
  return {
    version: WATCH_VERSION,
    asOf,
    scope: 'observation-only',
    note: '观察指标层仅展示与标注，不进权重表、不进总分、不进自学习；稳定 20 个交易日后再单独评估是否升格',
    items: ordered,
    // 只写统计数字，不列维度名、不重复「不参与打分」：名字由缺口行唯一出现，
    // 边界由 note 唯一说明，标题已写明「仅展示 · 不参与打分」（#010 A6 披露去重口径）
    summary: `观察指标 ${ready} 项可读、${missing.length} 项数据源待接入`,
  };
}

module.exports = {
  WATCH_VERSION,
  VOL_WINDOW,
  VOL_MARGINAL_BACK,
  buildWatchIndicators,
  realizedVolSeries,
  marginalChange,
  sectorDays,
  continuityAt,
  activeEvents,
  stdev,
  localDate,
};
