/**
 * 市场情绪提醒 · 宏观情绪因子（非常驻 · 自学习）
 * --------------------------------------------------------------
 * 在市场情绪拐点面板中新增两张「非常驻」因子小卡片，引用「每日宏观 & 政策」卡片数据：
 *   - 国内宏观数据情绪因子：解读最新国内经济数据公布（社零 / 固定资产投资 / 工业增加值等）
 *     对短期市场情绪的影响。
 *   - 美国宏观事件情绪因子：解读最新美国经济数据 / 事件（以 FOMC 为主）对短期情绪的影响。
 *
 * 行为约定（来自需求）：
 *   1) 两因子初始权重「平均分配」（各 50%）。
 *   2) 自学习：若大盘指数走势与因子预示的影响相悖，该因子权重自动归 0，转为「休眠」，
 *      待下一次数据 / 事件触发再恢复默认权重（重新激活）。
 *   3) 非常驻：国内因子以宏观数据公布期（period）为触发键；美国因子以美国事件 id 为触发键。
 *      触发键变化即视为「新触发」，重置为激活态 + 默认权重。
 *
 * 依赖：lib/macroData.getMacroIndicators（国内指标）、lib/usMacroEvents.getUsMacroEvents（美国事件）、
 *       shHistory（上证历史，由调用方 getTurningPointState 复用，避免重复拉取）。
 */
const fs = require('fs');
const path = require('path');

const { getMacroIndicators } = require('./macroData');
const { getUsMacroEvents } = require('./usMacroEvents');

const DATA_DIR = path.join(__dirname, '..', 'data', 'sentiment-macro');
const STATE_FILE = path.join(DATA_DIR, 'macroFactors.json');

const BASE_WEIGHT = 0.5; // 两因子平均分配

function ensureDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function writeState(s) {
  ensureDir();
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch (e) {}
}

// 国内宏观综合评分：在合理区间=利好(+1)，偏低/收缩/负增=利空(-1)，否则 0
function deriveDomestic(indicators) {
  const scores = [];
  const parts = [];
  for (const ind of (indicators || [])) {
    if (!ind || ind.unavailable) continue;
    const v = Number(ind.value);
    let s = 0;
    switch (ind.key) {
      case 'CPI': s = (v >= 0.5 && v <= 3) ? 1 : (v < 0 ? -1 : 0); break;
      case 'PPI': s = (v >= 0 && v <= 4) ? 1 : (v < 0 ? -1 : 0); break;
      case 'GDP': s = (v >= 4.5 && v <= 6) ? 1 : (v < 4 ? -1 : 0); break;
      case 'PMI': s = v >= 50 ? 1 : -1; break;
      case 'M2': s = (v >= 8 && v <= 12) ? 1 : (v < 8 ? -1 : 0); break;
      case 'RETAIL': s = (v >= 3 && v <= 8) ? 1 : (v < 2 ? -1 : 0); break;
      case 'ASSET_INVEST': s = (v >= 3 && v <= 9) ? 1 : (v < 0 ? -1 : 0); break;
      default: s = 0;
    }
    scores.push(s);
    parts.push(`${ind.name.replace(/（.*?）/g, '').slice(0, 6)} ${v}${ind.unit || ''}${s < 0 ? '↓' : s > 0 ? '↑' : '→'}`);
  }
  if (!scores.length) return { signal: 0, score: 0, label: '中性（影响有限）', parts: [] };
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  let signal = 0, label = '中性（影响有限）';
  if (avg > 0.15) { signal = 1; label = '偏多（支撑风险偏好）'; }
  else if (avg < -0.15) { signal = -1; label = '偏空（压制风险偏好）'; }
  return { signal, score: Math.round(avg * 100) / 100, label, parts };
}

function lastClose(shHistory) {
  const closes = (Array.isArray(shHistory) ? shHistory : []).map(h => h.close).filter(v => typeof v === 'number');
  return closes.length ? closes[closes.length - 1] : null;
}

// 单因子「触发 / 休眠 / 相悖归零」状态机
function stepFactor(prev, triggerKey, signal, curIndex) {
  const out = { status: prev.status || 'dormant', weight: prev.weight != null ? prev.weight : 0, observedIndex: prev.observedIndex };
  const fresh = prev.lastKey !== triggerKey;
  if (fresh) {
    out.status = 'active';
    out.weight = BASE_WEIGHT;
    out.observedIndex = (curIndex != null) ? curIndex : prev.observedIndex;
  } else if (out.status === 'active' && out.observedIndex != null && curIndex != null) {
    const dir = Math.sign(curIndex - out.observedIndex);
    // 预测：signal<0 期望市场向下；signal>0 期望向上。实际方向相反即「相悖」→ 归零休眠
    if ((signal < 0 && dir > 0) || (signal > 0 && dir < 0)) {
      out.status = 'dormant';
      out.weight = 0;
    }
  }
  out.lastKey = triggerKey;
  out.signal = signal;
  out.lastUpdated = new Date().toISOString();
  return out;
}

async function computeMacroFactors({ shHistory } = {}) {
  try {
    const macro = await getMacroIndicators(false);
    const events = getUsMacroEvents();
    const indicators = (macro && macro.indicators) || [];
    const period = (indicators[0] && indicators[0].period) || (macro && macro.date) || '';

    const dom = deriveDomestic(indicators);

    const activeEvents = (events || []).filter(e => e && e.id);
    const fomc = activeEvents.find(e => e.id === 'us-fomc-2026-09-17') || activeEvents.find(e => e.impact === 'bearish');
    const usSignal = fomc ? -1 : 0;
    const usLabel = fomc ? '偏空（短期压制全球风险偏好）'
      : (activeEvents.length ? '中性（关注待落地事件）' : '中性（近期无重大美国宏观事件）');
    const usKey = (events && events[0] && events[0].id) || 'none';

    const curIndex = lastClose(shHistory);
    const domKey = period || 'dom';

    const state = readState();
    const domSt = stepFactor(state.DOMESTIC || {}, domKey, dom.signal, curIndex);
    const usSt = stepFactor(state.US || {}, usKey, usSignal, curIndex);
    writeState({ DOMESTIC: domSt, US: usSt });

    const domInterp = `最新（${period || '—'}）国内宏观：经济动能${dom.signal < 0 ? '偏弱' : dom.signal > 0 ? '稳健' : '中性'}（${dom.parts.join('，')}）。整体对短期市场情绪${dom.label}。若大盘走势与预示方向相反，本因子权重自动归 0，待下期数据公布再触发。`;
    const usInterp = fomc
      ? `近期美国宏观核心事件：${fomc.title}（${fomc.dateZh}）。${fomc.summary} 短期对 A 股风险偏好${usLabel}。若议息后 A 股不跌反涨（与「加息拖累全球股市」相悖），本因子权重自动归 0，待下次美国宏观事件触发恢复。`
      : `近期无重大美国宏观事件，因子维持中性。`;

    return [
      {
        key: 'DOMESTIC_MACRO', name: '国内宏观数据情绪因子', signal: dom.signal,
        weight: domSt.weight, status: domSt.status, interpretation: domInterp,
        source: '每日宏观 & 政策（东方财富数据中心）',
      },
      {
        key: 'US_MACRO', name: '美国宏观事件情绪因子', signal: usSignal,
        weight: usSt.weight, status: usSt.status, interpretation: usInterp,
        source: '每日宏观 & 政策 · 美国经济事件（策划式）',
      },
    ];
  } catch (e) {
    console.error('[macroFactors][COMPUTE] threw:', e && e.stack ? e.stack : String(e));
    return [];
  }
}

module.exports = { computeMacroFactors, BASE_WEIGHT };
