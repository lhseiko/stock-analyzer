/**
 * 板块舆情热度周榜 · NLP 词典与文本归属（20260909m）
 * --------------------------------------------------------------
 * 代码权威铁律：所有情绪判定 / 韭菜识别 / 板块归属全部由本模块的确定性规则完成，
 * LLM 不参与任何计算（仅 UI 文案可能用到 AI 叙事，且本模块默认不调用 LLM）。
 *
 * 口径声明（诚实降级）：
 * - 情绪识别 = 看多/看空规则词典 + 否定词窗口翻转，存在词典法固有误差（页面有免责标注）；
 * - 韭菜识别 = 新手提问/跟风句式词典近似（无法获取发帖人历史），属口径降级；
 * - 登录墙平台（抖音/快手/小红书/公众号/知乎等）不采集，见 README。
 */
'use strict';

// ---------- 文本归一化 ----------
function normalizeText(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, '')
    .replace(/\s+/g, '')
    .replace(/[【】\[\]（）()《》<>「」]/g, '');
}

// ---------- 垃圾帖/广告过滤 ----------
const SPAM_RE = /(广告|推广|开户|福利|直播间|牛股群|加微信|加v|vx|免费领|荐股|带单|私募合作|点击链接|速来领取)/;
function isSpam(text) {
  const t = String(text == null ? '' : text).trim();
  if (t.length < 5) return true; // 过短无信息量
  if (SPAM_RE.test(t.toLowerCase())) return true;
  if (/^\d+$/.test(t)) return true; // 纯数字
  return false;
}

// ---------- 情绪识别（看多/看空 + 否定词翻转） ----------
const NEGATION = ['不', '没', '无', '别', '未', '难', '非', '莫', '勿', '难以', '并非', '并没有', '不能', '不会'];
const BULL_TERMS = ['看多', '看涨', '利好', '大涨', '涨停', '反弹', '突破', '拉升', '起爆', '起飞', '走强',
  '加仓', '买入', '抄底', '上车', '主线', '龙头', '机会', '稳了', '新高', '走牛', '放量上攻', '资金流入',
  '景气上行', '业绩超预期', '供不应求', '涨价'];
const BEAR_TERMS = ['看空', '看跌', '利空', '大跌', '跌停', '破位', '下杀', '崩', '走弱', '减仓', '卖出',
  '见顶', '崩盘', '暴雷', '套牢', '割肉', '腰斩', '诱多', '出货', '资金流出', '景气下行', '业绩不及预期',
  '产能过剩', '跌跌不休', '杀跌', '走熊'];

/**
 * 情感分类：扫描词典词 + 否定词窗口（词前 3 字符内出现否定词则翻转方向）。
 * 得分 = 多 - 空；>0 看多 / <0 看空 / =0 中性。
 * @returns {'bullish'|'bearish'|'neutral'}
 */
function classifySentiment(text) {
  const t = normalizeText(text);
  if (!t) return 'neutral';
  let bull = 0, bear = 0;
  const scan = (terms, isBull) => {
    for (const term of terms) {
      const tt = normalizeText(term);
      let idx = t.indexOf(tt);
      while (idx >= 0) {
        const win = t.slice(Math.max(0, idx - 3), idx);
        const negated = NEGATION.some(n => win.includes(normalizeText(n)));
        if (!negated) { if (isBull) bull++; else bear++; }
        else { if (isBull) bear++; else bull++; }
        idx = t.indexOf(tt, idx + tt.length);
      }
    }
  };
  scan(BULL_TERMS, true);
  scan(BEAR_TERMS, false);
  if (bull > bear) return 'bullish';
  if (bear > bull) return 'bearish';
  return 'neutral';
}

// ---------- 韭菜（新手/跟风）识别 —— 句式词典近似 ----------
const ROOKIE_STRONG = ['新手', '小白', '刚入市', '刚开户', '求教', '请教', '求指点', '该买什么', '买什么好',
  '能买吗', '还能追吗', '还能上车吗', '梭哈', '满仓干', '全仓买', '老师带带我', '大佬们', '大神们',
  '被套了', '被套住', '回本', '割肉吗', '要不要跑', '还有救吗', '怎么操作', '怎么办'];
const ROOKIE_WEAK = ['吗', '？', '?', '什么', '怎么', '如何', '为啥', '为什么', '什么意思', '懂的说说', '有没有人'];
/** 韭菜判定：强词 ≥1，或弱词 ≥2。确定性规则，无 AI。 */
function isRookiePost(text) {
  const t = normalizeText(text);
  if (!t) return false;
  let strong = 0, weak = 0;
  for (const w of ROOKIE_STRONG) if (t.includes(normalizeText(w))) strong++;
  for (const w of ROOKIE_WEAK) {
    const ww = normalizeText(w);
    let idx = t.indexOf(ww), cnt = 0;
    while (idx >= 0) { cnt++; idx = t.indexOf(ww, idx + ww.length); }
    weak += cnt;
  }
  return strong >= 1 || weak >= 2;
}

// ---------- 板块归属 ----------
/**
 * 构建文本→板块匹配器。
 * @param {Array<{code,name,aliases,keywords}>} boards sector_map.boards
 * @param {Map<string,string[]>} leadingStocks 板块名(归一化) → [主力净流入最大股]
 * @returns {{attribute:(text:string)=>string[]}}
 */
function buildMatcher(boards, leadingStocks) {
  const norm = s => String(s || '').toLowerCase().replace(/\s+/g, '');
  const entries = []; // {code, word, prio, wlen}
  for (const b of boards) {
    const baseAlias = String(b.name || '').replace(/[ⅠⅡⅢIV]+$/g, '').trim();
    const words = [
      { w: norm(b.name), prio: 3 },
      { w: norm(baseAlias), prio: 2 },
      ...(b.aliases || []).map(a => ({ w: norm(a), prio: 2 })),
      ...(b.keywords || []).map(k => ({ w: norm(k), prio: 1 })),
    ].filter(x => x.w && x.w.length >= 2);
    const seen = new Set();
    for (const x of words) {
      if (seen.has(x.w)) continue;
      seen.add(x.w);
      entries.push({ code: b.code, word: x.w, prio: x.prio, wlen: x.w.length });
    }
  }
  // 主导股名 → 板块（长度优先，避免子串误配）
  if (leadingStocks) {
    for (const [boardName, stocks] of leadingStocks.entries()) {
      const board = boards.find(b => norm(b.name) === norm(boardName) ||
        norm(String(b.name || '').replace(/[ⅠⅡⅢIV]+$/g, '')) === norm(boardName));
      if (!board) continue;
      for (const s of (stocks || [])) {
        const w = norm(s);
        if (w && w.length >= 2) entries.push({ code: board.code, word: w, prio: 2, wlen: w.length });
      }
    }
  }
  // 长词优先匹配，避免「电力」抢先吃掉「电网设备」类文本
  entries.sort((a, b2) => b2.wlen - a.wlen || b2.prio - a.prio);

  function attribute(text) {
    const t = norm(text);
    if (!t) return [];
    const hits = new Map(); // code -> best prio
    for (const e of entries) {
      if (t.indexOf(e.word) < 0) continue;
      const cur = hits.get(e.code) || 0;
      if (e.prio > cur) hits.set(e.code, e.prio);
      if (hits.size >= 6) break; // 粗筛上限
    }
    const arr = [...hits.entries()];
    arr.sort((a, b2) => b2[1] - a[1]);
    return arr.slice(0, 3).map(x => x[0]); // 每条文本最多归属 3 个板块
  }
  return { attribute };
}

module.exports = { normalizeText, isSpam, classifySentiment, isRookiePost, buildMatcher };
