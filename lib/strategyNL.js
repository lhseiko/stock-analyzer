'use strict';
/**
 * lib/strategyNL.js — 「高级」框：大白话（中文）策略 → 回测 DSL 的确定性翻译器。
 *
 * 铁律：
 *   · 纯代码、无 LLM、无随机 —— 同一句中文永远翻译成同一段 DSL，回测结果可复现。
 *   · 只覆盖常见技术面玩法；识别不了、或涉及引擎不支持的玩法（估值百分位 / 分批加减仓）
 *     时如实报告（返回 ok:false + reason），绝不猜测、绝不编造规则。
 *
 * 支持的「大白话」要素：
 *   · 均线：N日均线 / N日线 / MA5 …  金叉/死叉/上穿/下穿（两条均线，或价格 vs 均线）
 *   · MACD：金叉 / 死叉 / DIF 上穿 DEA
 *   · RSI：RSI 低于/高于 阈值、RSI 超卖/超买（默认周期 14）
 *   · 布林带：跌破下轨 / 涨破上轨 / 中轨（默认 20,2）
 *   · 收益率 z-score：z-score 低于/高于 阈值（默认窗口 20）
 *   · 买卖方向：买入/建仓/做多/开仓 … ；卖出/清仓/平仓/止盈/止损 …
 */

// 买卖方向关键词
const ROLE_BUY = /买入|买进|建仓|做多|开仓|开多|进场|入场|抄底|买点/;
const ROLE_SELL = /卖出|卖掉|清仓|平仓|做空|开空|出场|离场|止盈|止损|卖点/;

// 语气/连接词填充（剥离后不影响语义）
const FILLER = /(当|的时候|时候|时|则|就|即|如果|若|可|进行|操作|的话|情况下|表明|意味着)/g;

// 引擎暂不支持的玩法
const UNSUP_VALUATION = /(市盈率|市净率|市销率|PE|PB|PS|估值|百分位|分位数|分位)/i;
const UNSUP_POSITION = /(一成|两成|三成|四成|五成|六成|七成|八成|九成|半仓|满仓|空仓|轻仓|重仓|仓位|成仓|层仓|分批|每降|每升|每跌|每涨|金字塔)/i;

function toHalfWidth(s) {
  return String(s)
    .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ');
}

function splitClauses(text) {
  // 保护小数点的 "."（如 -1.5 / 30.5），避免被当句子分隔符切碎
  const PROT = '\u0001';
  const t = String(text).replace(/(\d)\.(\d)/g, '$1' + PROT + '$2');
  return t.split(/[，,；;。\.\n\r]+/)
    .map(s => s.split(PROT).join('.').trim())
    .filter(Boolean);
}

function numbersOf(s) {
  return (String(s).match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
}

// 方向判定：cross_up / cross_down / lt / gt / oversold / overbought / null
function dirOf(s) {
  if (/金叉|上穿|向上穿越|由下向上/.test(s)) return 'cross_up';
  if (/死叉|下穿|向下穿越|由上向下/.test(s)) return 'cross_down';
  if (/超卖/.test(s)) return 'oversold';
  if (/超买/.test(s)) return 'overbought';
  if (/低于|小于|跌破|少于|不足|不到|≤|<=|</.test(s)) return 'lt';
  if (/高于|大于|涨破|突破|超过|多于|≥|>=|>/.test(s)) return 'gt';
  return null;
}

// 均线周期提取（保序去重）
function maPeriods(cond) {
  const out = [];
  const re = /(?:MA\s*(\d+))|(?:(\d+)\s*(?:日|天)?\s*(?:均线|均价线|移动平均|线))/gi;
  let m;
  while ((m = re.exec(cond)) !== null) {
    const v = Number(m[1] || m[2]);
    if (isFinite(v) && v > 0 && out.indexOf(v) < 0) out.push(v);
  }
  return out;
}

function parseMA(cond) {
  const ps = maPeriods(cond);
  const d = dirOf(cond);
  if (ps.length >= 2) {
    const a = ps[0], b = ps[1];
    if (d === 'cross_up') return `CROSS_UP(MA(CLOSE,${a}), MA(CLOSE,${b}))`;
    if (d === 'cross_down') return `CROSS_DOWN(MA(CLOSE,${a}), MA(CLOSE,${b}))`;
  }
  if (ps.length === 1) {
    const n = ps[0];
    if (d === 'cross_up') return `CROSS_UP(CLOSE, MA(CLOSE,${n}))`;
    if (d === 'cross_down') return `CROSS_DOWN(CLOSE, MA(CLOSE,${n}))`;
    if (d === 'lt') return `CLOSE < MA(CLOSE,${n})`;
    if (d === 'gt') return `CLOSE > MA(CLOSE,${n})`;
  }
  return null;
}

function parseMACD(cond) {
  const d = dirOf(cond);
  if (d === 'cross_up') return 'CROSS_UP(MACD_DIF(CLOSE), MACD_DEA(CLOSE))';
  if (d === 'cross_down') return 'CROSS_DOWN(MACD_DIF(CLOSE), MACD_DEA(CLOSE))';
  if (d === 'gt' || d === 'overbought') return 'MACD_DIF(CLOSE) > MACD_DEA(CLOSE)';
  if (d === 'lt' || d === 'oversold') return 'MACD_DIF(CLOSE) < MACD_DEA(CLOSE)';
  return null;
}

function parseRSI(cond) {
  const pm = cond.match(/RSI\s*\(?\s*(\d+)?\s*\)?/i);
  const period = (pm && pm[1]) ? Number(pm[1]) : 14;
  const d = dirOf(cond);
  const rest = numbersOf(cond).filter(x => x !== period);
  let t = rest.length ? rest[0] : null;
  if (t == null) { if (d === 'oversold') t = 30; else if (d === 'overbought') t = 70; }
  if (t == null) return null;
  if (d === 'lt' || d === 'oversold') return `RSI(CLOSE,${period}) < ${t}`;
  if (d === 'gt' || d === 'overbought') return `RSI(CLOSE,${period}) > ${t}`;
  return null;
}

function parseBOLL(cond) {
  const d = dirOf(cond);
  const all = numbersOf(cond);
  const period = all.length >= 1 ? all[0] : 20;
  const k = all.length >= 2 ? all[1] : 2;
  let band = null;
  if (/下轨|下边|下沿|lower/i.test(cond)) band = 'lower';
  else if (/上轨|上边|上沿|upper/i.test(cond)) band = 'upper';
  else if (/中轨|中边|中沿|mid/i.test(cond)) band = 'mid';
  if (!band) return null;
  const fn = band === 'lower' ? 'BOLL_LOWER' : (band === 'upper' ? 'BOLL_UPPER' : 'BOLL_MID');
  if (d === 'lt' || d === 'oversold') return `CLOSE < ${fn}(CLOSE,${period},${k})`;
  if (d === 'gt' || d === 'overbought') return `CLOSE > ${fn}(CLOSE,${period},${k})`;
  return null;
}

function parseZ(cond) {
  const d = dirOf(cond);
  const isRet = /收益|涨跌|报酬|回报/.test(cond);
  const pm = cond.match(/(?:Z\s*-?\s*SCORE|标准分|标准化|z值)/i);
  const periodM = cond.match(/(?:Z\s*-?\s*SCORE|标准分|标准化|z值)\s*\(?\s*(\d+)/i);
  const period = (periodM && periodM[1]) ? Number(periodM[1]) : 20;
  const rest = numbersOf(cond).filter(x => x !== period);
  let t = rest.length ? rest[0] : null;
  if (t == null) { if (d === 'oversold') t = -1.5; else if (d === 'overbought') t = 1.5; }
  if (pm == null || t == null) return null;
  const series = isRet ? 'RET(CLOSE)' : 'CLOSE';
  const fn = `ZSCORE(${series},${period})`;
  if (d === 'lt' || d === 'oversold') return `${fn} < ${t}`;
  if (d === 'gt' || d === 'overbought') return `${fn} > ${t}`;
  return null;
}

// 单条子句 → 表达式（识别不了返回 null）
function parseCondition(cond) {
  if (/布林|BOLL/i.test(cond)) return parseBOLL(cond);
  if (/MACD/i.test(cond)) return parseMACD(cond);
  if (/RSI|相对强弱/i.test(cond)) return parseRSI(cond);
  if (/Z\s*-?\s*SCORE|标准分|标准化|z值/i.test(cond)) return parseZ(cond);
  if (/均线|均价线|移动平均|MA\s*\d|\d+\s*(?:日|天)?\s*线/.test(cond)) return parseMA(cond);
  return null;
}

// 提取「指标基座」：剥掉方向词与数字，留下指标名，供后续省略指标的子句继承。
// 例："收益率z-score低于-1.5" → "收益率z-score"；"RSI高于70" → "RSI"
function condBase(cond) {
  return String(cond)
    .replace(/金叉|死叉|上穿|下穿|向上穿越|向下穿越|超卖|超买|低于|小于|跌破|少于|不足|不到|高于|大于|涨破|突破|超过|多于|[<>=≤≥]/g, '')
    .replace(/-?\d+(?:\.\d+)?/g, '')
    .replace(/[\s,，]/g, '')
    .trim();
}

/**
 * 把大白话策略翻译成 DSL 对象。
 * @param {string} text 用户输入（可含 RANGE: 3y 这类 DSL 行，会被识别并忽略/复用）
 * @returns {{ok:true, dsl:object, notes:string[]} | {ok:false, reason:string, unsupported?:string[], unparsed?:string[]}}
 */
function translate(text) {
  const clean = toHalfWidth(text == null ? '' : text);
  const lines = clean.split(/\r?\n/);
  let range = null, name = null;
  const proseParts = [];
  for (const ln of lines) {
    const m = ln.match(/^\s*(STRATEGY_TYPE|NAME|BUY|SELL|RANGE|SYMBOLS|TRAIN_RATIO|COST_PER_SIDE|SURVIVORSHIP)\s*:\s*(.+)$/i);
    if (m) {
      const k = m[1].toUpperCase(), v = m[2].trim();
      if (k === 'RANGE') range = v;
      else if (k === 'NAME') name = v;
      // BUY/SELL 行说明已是 DSL，交给 parseDSL，不会走到这里
    } else if (ln.trim()) {
      proseParts.push(ln.trim());
    }
  }
  const prose = proseParts.join('，').trim();
  if (!prose) return { ok: false, reason: 'empty' };

  // 引擎不支持的玩法：如实拒绝，不猜
  const unsupported = [];
  if (UNSUP_VALUATION.test(prose)) unsupported.push('估值百分位（PE/PB/分位）');
  if (UNSUP_POSITION.test(prose)) unsupported.push('分批加减仓（仓位管理）');
  if (unsupported.length) return { ok: false, reason: 'unsupported', unsupported };

  const clauses = splitClauses(prose);
  const buyExprs = [], sellExprs = [], unparsed = [];
  let lastRole = null, lastBase = '';
  for (const cl of clauses) {
    const isBuy = ROLE_BUY.test(cl), isSell = ROLE_SELL.test(cl);
    let role = (isBuy && !isSell) ? 'buy' : (isSell && !isBuy) ? 'sell' : lastRole;
    if (role) lastRole = role;
    let cond = cl.replace(ROLE_BUY, '').replace(ROLE_SELL, '').replace(FILLER, '').replace(/[（）()]/g, ' ').trim();
    let expr = parseCondition(cond);
    // 省略了指标名的后续子句（如「…买入，高于1.5卖出」）→ 继承上一条的指标基座
    if (!expr && lastBase) {
      const retry = lastBase + cond;
      const e2 = parseCondition(retry);
      if (e2) { expr = e2; cond = retry; }
    }
    if (!expr) { unparsed.push(cl); continue; }
    const base = condBase(cond);
    if (base) lastBase = base;
    if (role === 'buy') buyExprs.push(expr);
    else if (role === 'sell') sellExprs.push(expr);
    else unparsed.push(cl);
  }

  if (!buyExprs.length || !sellExprs.length) {
    return { ok: false, reason: 'incomplete', unparsed };
  }

  return {
    ok: true,
    dsl: {
      strategy_type: 'single',
      name: name || '大白话策略（自动翻译）',
      buy: buyExprs.join(' AND '),
      sell: sellExprs.join(' AND '),
      range: range || '3y'
    },
    notes: ['已按确定性规则把中文描述翻译为回测规则（同一句话结果可复现）']
  };
}

module.exports = { translate, parseCondition };
