/**
 * 专属因子引擎 v1（20260911）
 * ----------------------------------------------------------------------------
 * 用途：为特定个股提供「非常驻专属因子」卡片，工作机制与 eventEngine（突发事件因子）完全一致：
 *   - 非常驻：无触发数据时不占权重、卡片自动隐藏（与事件驱动因子同口径）；
 *   - 触发时：常驻因子按「事件权重 + 专属权重」之和等比压缩，腾出空间给非常驻因子；
 *   - 衰减：有效权重随触发后时间边际递增式衰减（w = base·(1 - r^exp)，r=已过去比例），
 *           衰减到 0 自动隐藏，等待下一个周期触发；
 *   - 权重上限：常驻 + 非常驻权重之和恒 ≤ 100%（mergeNonResidentOverrides 统一归并）。
 *
 * 首个落地的专属因子：海天味业(603288) ——「CPI·食品烟酒及在外餐饮」
 *   触发：每月 8~13 日（国家统计局 CPI 发布窗口）自动检索最新一期 CPI；
 *   权重：短期 10% / 长期 10%（暂定，后续由准确率模型自学习调整）；
 *   衰减：短期 3 天 / 长期 15 天（暂定）；
 *   信号：食品烟酒及在外餐饮 同比/环比 → 映射为多空信号（占位规则，后续由准确率模型校准）。
 *
 * 设计铁律（与 eventEngine 一致）：
 *   - 计算层=代码（纯四则 + 固定阈值/乘数），不依赖 LLM 决定权重；
 *   - 输入锁死 ⇒ 结果锁死（1+1=2）；
 *   - 仅影响配置了专属因子的个股，其他个股零改动（按 symbol 过滤）。
 */

'use strict';
const fs = require('fs');
const path = require('path');
const DAY = 86400000;

const DIR = path.join(__dirname, '..', 'data', 'dedicatedFactors');
const ACTIVE_FILE = path.join(DIR, 'active.json');
const HISTORY_FILE = path.join(DIR, 'history.json');
const STATE_FILE = path.join(DIR, 'state.json');

// ===== 专属因子注册表（按个股 + 因子键）=====
// 后续新增个股/因子只需在此追加，无需改动判断模块接线。
const DEDICATED_FACTOR_DEFS = {
  '603288': [ // 海天味业
    {
      key: 'cpiFood',
      name: 'CPI·食品烟酒及在外餐饮',
      // 权重（暂定 10%，后续准确率模型自学习调整）
      weightShort: 0.10,
      weightLong: 0.10,
      // 衰减窗口（天）
      decayShortDays: 3,
      decayLongDays: 15,
      // 边际递增式衰减：有效权重 = base·(1 - r^decayExp)，r=已过去/窗口。
      // decayExp>1 ⇒ 前期保留高、末期骤降（每日边际衰减额递增）；decayExp 亦可由准确率模型校准。
      decayExp: 2,
      // 信号映射规则标识（见 computeSignal）
      signalRule: 'food_cpi_haitian',
      // 月度触发：国家统计局 CPI 一般于次月 9~10 日发布，取每月 8~13 日为检索窗口
      trigger: { type: 'monthly_cpi', windowDays: [8, 9, 10, 11, 12, 13], source: 'NBS' },
    },
  ],
};

// ===== IO =====
function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }
function _read(f, fallback) {
  ensureDir();
  try { const a = JSON.parse(fs.readFileSync(f, 'utf8')); return Array.isArray(a) ? a : fallback; }
  catch (e) { return fallback; }
}
function _write(f, data) { ensureDir(); fs.writeFileSync(f, JSON.stringify(data, null, 2), 'utf8'); }
function loadActive() { return _read(ACTIVE_FILE, []); }
function saveActive(a) { _write(ACTIVE_FILE, a); }
function loadHistory() { return _read(HISTORY_FILE, []); }
function saveHistory(a) { _write(HISTORY_FILE, a.slice(0, 100)); }
function loadState() {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(s) { ensureDir(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8'); }

// ===== 工具 =====
function round(x, n) { const p = Math.pow(10, n || 4); return Math.round(x * p) / p; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function dirArrow(s) { return s > 0 ? '▲' : s < 0 ? '▼' : '—'; }
function dirLabel(s) { return s > 0 ? '利好' : s < 0 ? '利空' : '中性'; }
function normSymbol(sym) { return String(sym || '').replace(/^(sh|sz|bj)/i, '').trim(); }

// 边际递增式衰减：w = base·(1 - r^exp)，r∈[0,1]
function effectiveWeight(base, days, createdAt, now, exp) {
  if (!base || !days || days <= 0) return 0;
  const elapsed = now - createdAt;
  if (elapsed <= 0) return base;
  const r = elapsed / (days * DAY);
  if (r >= 1) return 0;
  const e = (exp && exp > 0) ? exp : 2;
  return base * (1 - Math.pow(r, e));
}

// 计算触发所属的统计期（上个月的 YYYY-MM）。国家统计局于次月 9~10 日发布上月 CPI，
// 故在窗口内检索的「最新」即上个月。
function prevMonthPeriod(now) {
  const d = new Date(now);
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ===== 信号映射（占位规则，后续由准确率模型校准）=====
// food_cpi_haitian：食品烟酒及在外餐饮 CPI 上行 → 调味品龙头定价权/营收利好；
//   综合 = 0.6·同比 + 0.4·环比，归一化到 [-1,1]（约 3% 读数≈满仓信号）。
// 注：此方向判定为初始占位，准确率模型后续会同时校准「权重」与「信号映射」。
function computeSignal(rule, data) {
  const yoy = Number(data && data.yoy);
  const mom = Number(data && data.mom);
  const y = Number.isFinite(yoy) ? yoy : 0;
  const m = Number.isFinite(mom) ? mom : 0;
  if (rule === 'food_cpi_haitian') {
    const combined = y * 0.6 + m * 0.4;
    return round(clamp(combined / 3, -1, 1), 3);
  }
  return 0;
}

// ===== 查询：某股在某口径下的活跃专属因子（已是「因子卡片」对象）=====
function getDedicatedFactorsForSymbol(symbol, horizon) {
  const sym = normSymbol(symbol);
  const now = Date.now();
  const defs = DEDICATED_FACTOR_DEFS[sym];
  if (!defs || !defs.length) return [];
  const active = loadActive().filter(a => a.symbol === sym && a.status === 'active');
  const out = [];
  for (const a of active) {
    const def = defs.find(d => d.key === a.factorKey);
    if (!def) continue;
    const base = horizon === 'long' ? a.weightLong : a.weightShort;
    const days = horizon === 'long' ? a.decayLongDays : a.decayShortDays;
    const exp = a.decayExp || def.decayExp || 2;
    const eff = effectiveWeight(base, days, Date.parse(a.createdAt), now, exp);
    if (eff <= 0) continue;
    const cAt = Date.parse(a.createdAt);
    const remain = Math.max(0, Math.ceil((days * DAY - (now - cAt)) / DAY));
    const signal = (typeof a.signal === 'number') ? a.signal : 0;
    out.push({
      key: a.factorKey,
      name: a.name,
      weight: round(eff, 4),
      signal,
      applicable: true,
      remainingDays: remain,
      value: `食品烟酒及在外餐饮：同比 ${yoyFmt(a.data && a.data.yoy)} / 环比 ${yoyFmt(a.data && a.data.mom)}`,
      detail: `国家统计局CPI·食品烟酒及在外餐饮；权重${(eff * 100).toFixed(1)}%（暂定10%）；剩${remain}天自动隐藏（边际递增式衰减）；后续由准确率模型自学习调整。`,
      // 用户要求：统计期/来源不再单独成卡片，改为数据下方小字标注（caption）
      caption: `数据日期：${a.period} · 来源：${(a.data && a.data.source) || '国家统计局'}`,
      subFactors: [
        { key: 'yoy', name: '同比', signal, value: yoyFmt(a.data && a.data.yoy) },
        { key: 'mom', name: '环比', signal, value: yoyFmt(a.data && a.data.mom) },
      ],
    });
  }
  return out;
}
function yoyFmt(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toFixed(1) + '%';
}

// 复用事件因子的覆盖结构：返回 { combinedWeight, dedicatedFactors } 或 null（无激活时）。
function buildDedicatedOverride({ symbol, baseWeights, factorKeys, horizon }) {
  const list = getDedicatedFactorsForSymbol(symbol, horizon);
  if (!list.length) return null;
  const combinedWeight = round(list.reduce((a, f) => a + f.weight, 0), 4);
  return { combinedWeight, dedicatedFactors: list, horizon };
}

// ===== 归并多个非常驻因子（事件 + 专属）的权重覆盖 =====
// 常驻因子按 (1 - 非常驻合计权重) 等比压缩；非常驻因子各自带有效权重，总和恒 ≤ 100%。
function mergeNonResidentOverrides(baseWeights, factorKeys, nrList) {
  let combinedNR = nrList.reduce((a, n) => a + (n.weight || 0), 0);
  combinedNR = Math.min(combinedNR, 0.95); // 硬上限：常驻至少保留 5%
  const override = {};
  for (const k of factorKeys) {
    const base = baseWeights[k] != null ? baseWeights[k] : (1 / factorKeys.length);
    override[k] = round(base * (1 - combinedNR), 4);
  }
  const factors = nrList.map(n => n.factor);
  return { override, factors, combinedNR: round(combinedNR, 4) };
}

// ===== 联网抓取 CPI 食品烟酒及在外餐饮（运行时自动触发用）=====
// 仅在配置了 AI Key 时尝试；失败返回 null（此时由 Agent/手动种子数据兜底）。
async function fetchCpiFood(period) {
  let aiCfg;
  try { aiCfg = require('./ai/config').loadConfig(); } catch (e) { return null; }
  if (!aiCfg || !aiCfg.apiKey) return null;
  try {
    const { callLLM, pickModelFor } = require('./ai/llm');
    const pick = pickModelFor(aiCfg, 'web');
    const prompt = `请检索国家统计局《${period}月份居民消费价格》官方数据，提取其中「食品烟酒及在外餐饮类」价格的同比与环比涨跌幅。
只输出JSON：{"yoy": 数字(同比%, 下降为负), "mom": 数字(环比%, 下降为负), "source": "国家统计局", "url": "官方链接"}。
若未找到该统计期数据，输出 {"notFound": true}。`;
    const content = await callLLM(aiCfg.provider, aiCfg.apiKey, pick.model, [
      { role: 'system', content: '你是宏观数据检索助手，只输出JSON。' },
      { role: 'user', content: prompt },
    ], { webSearch: pick.webSearch, timeoutMs: 90000 });
    const p = (() => { try { let s = String(content).trim().replace(/^```(?:json)?/i, '').replace(/```$/, ''); return JSON.parse(s); } catch (e) { return null; } })();
    if (!p || p.notFound) return null;
    const yoy = Number(p.yoy), mom = Number(p.mom);
    if (!Number.isFinite(yoy) || !Number.isFinite(mom)) return null;
    return { yoy, mom, source: p.source || '国家统计局', url: p.url || '', period };
  } catch (e) {
    console.warn('[dedicatedFactor] fetchCpiFood 失败:', e && e.message);
    return null;
  }
}

// ===== 触发：窗口内检索最新 CPI 并落库（月度自动 / 手动均可调用）=====
async function triggerDedicatedFactors({ force } = {}) {
  const now = new Date();
  const dom = now.getDate();
  const inWindow = dom >= 8 && dom <= 13;
  if (!inWindow && !force) {
    return { ok: true, triggered: false, reason: 'not_in_window', today: dom };
  }
  const period = prevMonthPeriod(now); // 最新统计期（上月）
  const st = loadState();
  // 每月仅在窗口内尝试一次（避免重复联网）
  if (!force && st.lastAttemptPeriod === period) {
    return { ok: true, triggered: false, reason: 'already_attempted_this_period', period };
  }
  let triggered = [];
  const changedSymbols = new Set();
  const active = loadActive();
  for (const sym of Object.keys(DEDICATED_FACTOR_DEFS)) {
    for (const def of DEDICATED_FACTOR_DEFS[sym]) {
      if (def.trigger && def.trigger.type === 'monthly_cpi') {
        // 若该统计期已有实例则跳过
        if (active.some(a => a.symbol === sym && a.factorKey === def.key && a.period === period)) continue;
        const data = await fetchCpiFood(period);
        if (!data) { console.warn(`[dedicatedFactor] ${sym}/${def.key} ${period} 抓取失败，等待 Agent/手动种子`); continue; }
        const signal = computeSignal(def.signalRule, data);
        const createdAt = Date.now();
        const inst = {
          id: `df_${sym}_${def.key}_${period}`,
          symbol: sym, factorKey: def.key, name: def.name,
          period, data, signal,
          weightShort: def.weightShort, weightLong: def.weightLong,
          decayShortDays: def.decayShortDays, decayLongDays: def.decayLongDays,
          decayExp: def.decayExp,
          decayShortEnd: new Date(createdAt + def.decayShortDays * DAY).toISOString(),
          decayLongEnd: new Date(createdAt + def.decayLongDays * DAY).toISOString(),
          status: 'active', createdAt: new Date(createdAt).toISOString(),
          engineVersion: 'v1',
        };
        // 同因子更旧统计期的激活实例归档（避免重复卡片）
        const kept = [];
        for (const a of active) {
          if (a.symbol === sym && a.factorKey === def.key && a.period && a.period < period && a.status === 'active') {
            a.status = 'archived'; a.archivedAt = inst.createdAt;
            const hist = loadHistory(); hist.unshift(a); saveHistory(hist);
            changedSymbols.add(sym); // 旧实例归档 → 该股判断需重算
          } else kept.push(a);
        }
        kept.push(inst);
        saveActive(kept);
        triggered.push(inst.id);
        changedSymbols.add(sym); // 新实例生成 → 该股判断需重算
      }
    }
  }
  st.lastAttemptPeriod = period;
  saveState(st);
  return { ok: true, triggered, changedSymbols: [...changedSymbols], period, inWindow };
}

// 过期清理（衰减为 0 的激活实例归档，避免数据无限堆积）
function cleanupExpired() {
  const now = Date.now();
  const active = loadActive();
  const remain = [];
  let archived = 0;
  const changedSymbols = new Set();
  for (const a of active) {
    if (a.status !== 'active') { remain.push(a); continue; }
    const effShort = effectiveWeight(a.weightShort, a.decayShortDays, Date.parse(a.createdAt), now, a.decayExp || 2);
    const effLong = effectiveWeight(a.weightLong, a.decayLongDays, Date.parse(a.createdAt), now, a.decayExp || 2);
    if (effShort <= 0 && effLong <= 0) {
      a.status = 'archived'; a.archivedAt = new Date().toISOString();
      const hist = loadHistory(); hist.unshift(a); saveHistory(hist); archived++;
      changedSymbols.add(a.symbol); // 到期归档 → 该股判断需重算（卡片自动隐藏）
    } else remain.push(a);
  }
  if (archived) saveActive(remain);
  return { ok: true, archived, changedSymbols: [...changedSymbols] };
}

module.exports = {
  DEDICATED_FACTOR_DEFS,
  loadActive, saveActive, loadHistory,
  effectiveWeight, computeSignal, prevMonthPeriod,
  getDedicatedFactorsForSymbol, buildDedicatedOverride, mergeNonResidentOverrides,
  triggerDedicatedFactors, cleanupExpired, fetchCpiFood,
  DIR,
};
