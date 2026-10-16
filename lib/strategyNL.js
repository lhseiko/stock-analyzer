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
// 【已支持】止损/止盈/移动止盈/等批建仓 → 由 parseRiskParams 解析，不再一律拒绝。
// 仍不支持的：金字塔式每涨/每跌固定比例加减仓、按"成"计的仓位分配、加减仓（动态调仓）
const UNSUP_POSITION = /(一成|两成|三成|四成|五成|六成|七成|八成|九成|半仓|满仓|空仓|轻仓|重仓|成仓|层仓|金字塔|每降|每升)/i;
const UNSUP_SCALE = /(加仓|减仓|补仓|加码|减码|调仓|再买|再卖)/i;

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

// ---------------------------------------------------------------------
//  风控出场 & 分批建仓参数解析（纯代码、确定性）
// ---------------------------------------------------------------------
// 把「8% 止损」「上涨20%止盈」「回撤5%止盈(移动)」「分3批建仓」这类描述解析为结构化参数。
// 支持百分数与小数两种写法：'8%' → 0.08；'0.08' → 0.08。
function pctOf(token) {
  if (token == null) return null;
  const s = String(token).trim();
  const hasPct = /%|％/.test(s);
  const v = parseFloat(s.replace(/[%％]/g, ''));
  if (!isFinite(v)) return null;
  if (hasPct) return v / 100;
  return v;   // 无百分号时按小数直接使用（用户写 0.08 即 8%）
}

function parseRiskParams(prose) {
  const out = {};
  // 1) 止损：'止损5%' / '亏损达到8%止损' / '跌破8%止损'
  const slm = prose.match(/(?:止损|亏损|亏了|跌破|下跌)\s*(?:到|达|达到|超过|幅度|为)?\s*(-?\d+(?:\.\d+)?\s*[%％]?)/);
  if (slm && /止损|亏损|亏了/.test(prose)) {
    const v = pctOf(slm[1]);
    if (v != null && v > 0) out.stop_loss = Math.abs(v);
  }
  // 2) 移动止盈：'回撤5%止盈' / '移动止盈5%' / '从最高点回撤3%卖出'
  const trm = prose.match(/(?:回撤|回落|移动止盈|跟踪止盈|最高点.{0,6}回撤)\s*(?:到|达|达到|超过|幅度|为)?\s*(-?\d+(?:\.\d+)?\s*[%％]?)/);
  if (trm) {
    const v = pctOf(trm[1]);
    if (v != null && v > 0) out.trailing = Math.abs(v);
  }
  // 3) 止盈：'止盈20%' / '上涨20%止盈' / '盈利20%就卖'
  // 注意：必须按**子句**排除移动止盈语境——不能用整句判断，否则"止损8%，止盈15%，回撤5%"
  // 里的"止盈15%"会被整句中出现的"回撤"两字误杀（实测踩过此坑）。
  const subClauses = splitClauses(prose);
  for (const sub of subClauses) {
    if (/回撤|回落|移动止盈|跟踪止盈/.test(sub)) continue;   // 移动止盈子句，交给 trailing
    if (!/止盈|盈利|涨了|上涨|获利/.test(sub)) continue;
    const tpm = sub.match(/(?:止盈|盈利|涨了|上涨|获利)\s*(?:到|达|达到|超过|幅度|为)?\s*(-?\d+(?:\.\d+)?\s*[%％]?)/);
    if (!tpm) continue;
    // '止损5%，止盈20%' 同一个子句内可能同时含止损与止盈 → 需确保匹配到的数字紧跟止盈词
    const idx = sub.search(/止盈|盈利|涨了|上涨|获利/);
    const tail = sub.slice(idx);
    const tm2 = tail.match(/(?:止盈|盈利|涨了|上涨|获利)\s*(?:到|达|达到|超过|幅度|为)?\s*(-?\d+(?:\.\d+)?\s*[%％]?)/);
    if (!tm2) continue;
    const v = pctOf(tm2[1]);
    if (v != null && v > 0) { out.take_profit = Math.abs(v); break; }
  }
  // 4) 分批建仓：'分3批建仓' / '分三批买入' / '分3次建仓' / '3批建仓'
  const CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  const tm = prose.match(/(?:分|每)?\s*(\d+|[一二两三四五六七八九十])\s*(?:批|次|档|笔)\s*(?:建仓|买入|进场|入场|买)/)
    || prose.match(/(?:建仓|买入|进场|入场)\s*(?:分|每)?\s*(\d+|[一二两三四五六七八九十])\s*(?:批|次|档|笔)/);
  if (tm) {
    const raw = tm[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : (CN_NUM[raw] || 0);
    if (n > 1) out.tranches = Math.min(10, n);
  }
  // 5) 批次间隔：'每隔2个交易日建一批'
  const gm = prose.match(/每\s*(?:隔)?\s*(\d+|[一二两三四五六七八九十])\s*(?:个)?\s*(?:交易日|天|日)/);
  if (gm && out.tranches) {
    const raw = gm[1];
    const n = /^\d+$/.test(raw) ? Number(raw) : (CN_NUM[raw] || 0);
    if (n > 0) out.tranche_gap = n;
  }
  return Object.keys(out).length ? out : null;
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
    const m = ln.match(/^\s*(STRATEGY_TYPE|NAME|BUY|SELL|RANGE|SYMBOLS|TRAIN_RATIO|COST_PER_SIDE|SURVIVORSHIP|STOP_LOSS|TAKE_PROFIT|TRAILING|TRANCHES)\s*:\s*(.+)$/i);
    if (m) {
      const k = m[1].toUpperCase(), v = m[2].trim();
      if (k === 'RANGE') range = v;
      else if (k === 'NAME') name = v;
      else if (k === 'STOP_LOSS' || k === 'TAKE_PROFIT' || k === 'TRAILING' || k === 'TRANCHES') {
        // 结构化风控行 → 直接进 prose 由 parseRiskParams 统一处理（拼成等价中文）
        const key = { STOP_LOSS: '止损', TAKE_PROFIT: '止盈', TRAILING: '回撤', TRANCHES: '分' }[k];
        proseParts.push(k === 'TRANCHES' ? `分${v}批建仓` : `${key}${v}`);
      }
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
  if (UNSUP_POSITION.test(prose)) unsupported.push('金字塔式按比例加减仓 / 按「成」计的仓位分配');
  if (UNSUP_SCALE.test(prose)) unsupported.push('持仓过程中的动态加仓/减仓');
  if (unsupported.length) return { ok: false, reason: 'unsupported', unsupported };

  // 先抽出风控/仓位参数（这些子句不是买卖条件，需从条件解析中剔除）
  const risk = parseRiskParams(prose);
  const RISK_CLAUSE = /(止损|止盈|回撤|回落|移动止盈|跟踪止盈|分批|分\d+批|分[一二两三四五六七八九十]批|建仓批次)/;

  const clauses = splitClauses(prose);
  const buyExprs = [], sellExprs = [], unparsed = [], riskOnly = [];
  let lastRole = null, lastBase = '';
  for (const cl of clauses) {
    // 纯风控子句（只描述出场/仓位，不含指标条件）→ 跳过条件解析，但记录以便失败时如实告知
    if (RISK_CLAUSE.test(cl) && !parseCondition(cl)) { riskOnly.push(cl); continue; }
    const isBuy = ROLE_BUY.test(cl), isSell = ROLE_SELL.test(cl);
    let role = (isBuy && !isSell) ? 'buy' : (isSell && !isBuy) ? 'sell' : lastRole;
    if (role) lastRole = role;
    let cond = cl.replace(ROLE_BUY, '').replace(ROLE_SELL, '').replace(FILLER, '').replace(/[（）()]/g, ' ').trim();
    // 剥掉风控片段，避免"止盈20%"里的数字干扰指标参数解析
    cond = cond.replace(/(?:止损|止盈|回撤|回落|移动止盈|跟踪止盈)\s*(?:到|达|达到|超过|幅度|为)?\s*-?\d+(?:\.\d+)?\s*[%％]?/g, '').trim();
    let expr = parseCondition(cond);
    // 省略了指标名的后续子句（如「…买入，高于1.5卖出」）→ 继承上一条的指标基座
    if (!expr && lastBase && cond) {
      const retry = lastBase + cond;
      const e2 = parseCondition(retry);
      if (e2) { expr = e2; cond = retry; }
    }
    if (!expr) { if (cl.trim()) unparsed.push(cl); continue; }
    const base = condBase(cond);
    if (base) lastBase = base;
    if (role === 'buy') buyExprs.push(expr);
    else if (role === 'sell') sellExprs.push(expr);
    else unparsed.push(cl);
  }

  if (!buyExprs.length || !sellExprs.length) {
    // 诚实告知：把未能识别的子句（含只被当作风控、但没解析出任何参数的）一并返回，
    // 避免用户拿到一个笼统的 incomplete 却不知道问题出在哪一句。
    const absorbed = risk ? Object.keys(risk).length : 0;
    const stuck = riskOnly.filter(c => absorbed === 0);
    return { ok: false, reason: 'incomplete', unparsed: unparsed.concat(stuck) };
  }

  const notes = ['已按确定性规则把中文描述翻译为回测规则（同一句话结果可复现）'];
  const dsl = {
    strategy_type: 'single',
    name: name || '大白话策略（自动翻译）',
    buy: buyExprs.join(' AND '),
    sell: sellExprs.join(' AND '),
    range: range || '3y'
  };
  if (risk) {
    Object.assign(dsl, risk);
    const bits = [];
    if (risk.stop_loss) bits.push(`止损 ${(risk.stop_loss * 100).toFixed(1)}%`);
    if (risk.take_profit) bits.push(`止盈 ${(risk.take_profit * 100).toFixed(1)}%`);
    if (risk.trailing) bits.push(`移动止盈 ${(risk.trailing * 100).toFixed(1)}%`);
    if (risk.tranches) bits.push(`等分 ${risk.tranches} 批建仓`);
    if (bits.length) notes.push('已识别风控/仓位参数：' + bits.join('、'));
  }
  return { ok: true, dsl, notes };
}

module.exports = { translate, parseCondition, parseRiskParams };
