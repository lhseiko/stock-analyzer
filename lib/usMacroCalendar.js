/**
 * 美国宏观事件排期 · 自动抓取（20261013b）
 * --------------------------------------------------------------
 * 主源：fedratecalc.com/us-economic-calendar —— 一张汇总表覆盖 CPI / PPI /
 * 非农（Employment Situation）/ FOMC 决议，条目来源标注 BLS/美联储官网。
 * 选择理由：① 单源覆盖全类型；② 表格结构规整可正则解析；③ BLS 官网直爬
 * 被 Akamai 反爬拦（403）、美联储官网只有 FOMC；④ 实测用户网络可访问。
 *
 * 设计：
 *   - 美东时间（ET）确定性转北京时间（含 DST 规则：3月第2周日~11月第1周日）；
 *   - 事件解读用类型模板（方向框架，不编造数值）；
 *   - 结果落盘缓存（TTL 12h），抓取失败回退陈旧缓存；
 *   - 解析结果 <2 条视为抓取失败（页面结构可能改版），由调用方回退内置清单。
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { localDate } = require('./localDate');

const CAL_URL = 'https://fedratecalc.com/us-economic-calendar';
const CACHE_FILE = path.join(__dirname, '..', 'data', 'us_macro_calendar_cache.json');
const CACHE_TTL_MS = 12 * 3600 * 1000;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

// 只收录对 A 股有方向意义的高权重类型
const TYPE_RULES = {
  cpi:      { match: /Consumer Price Index/i, category: '通胀', level: 'high',   impact: 'conditional',
              summary: '美国通胀读数直接影响利率路径定价：超预期强化「更高更久」利率担忧、短期偏空全球风险资产；低于预期则缓解担忧、偏多。以 BLS 官方公布值为准。' },
  payrolls: { match: /Employment Situation|Nonfarm Payrolls/i, category: '就业', level: 'medium', impact: 'conditional',
              summary: '非农就业强弱直接影响美联储利率路径：强就业支撑加息/推迟降息预期、偏空风险资产；弱就业强化暂停/降息预期、偏多。' },
  fomc:     { match: /FOMC Rate Decision/i, category: '美联储', level: 'high', impact: 'bearish',
              summary: '美联储利率决议是当期全球资产定价核心事件：决议公布前部分资金倾向避险、短期压制风险偏好；若决议与点阵图偏鹰，全球风险资产承压。' },
  ppi:      { match: /Producer Price Index/i, category: '通胀', level: 'medium', impact: 'conditional',
              summary: 'PPI 为通胀先行指标：上游价格超预期回升预示 CPI 粘性、强化「更高更久」利率担忧；回落则缓解。' },
};

const MONTH_MAP = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function nthSundayUtc(y, month1, n) {
  const first = new Date(Date.UTC(y, month1 - 1, 1));
  const firstSunday = 1 + ((7 - first.getUTCDay()) % 7);
  return firstSunday + (n - 1) * 7;
}
// 美东夏令时（DST）：3月第2个周日 起，11月第1个周日 止
function isEtDst(y, m, d) {
  const t = Date.UTC(y, m - 1, d);
  return t >= Date.UTC(y, 2, nthSundayUtc(y, 3, 2)) && t < Date.UTC(y, 10, nthSundayUtc(y, 11, 1));
}
// "Wed, Oct 28, 2026" + "2:00 PM" → { date:'2026-10-29', beijingText:'2026-10-29 凌晨 02:00（北京时间）', etText:'2026-10-28 14:00（美东）' }
function etToBeijing(dateStr, timeStr) {
  const m = /([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})/.exec(dateStr || '');
  if (!m) return null;
  const mm = MONTH_MAP[m[1].slice(0, 3).toLowerCase()];
  const dd = parseInt(m[2], 10), yy = parseInt(m[3], 10);
  if (!mm) return null;
  const tm = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(timeStr || '');
  let hh = tm ? (parseInt(tm[1], 10) % 12 + (/pm/i.test(tm[3]) ? 12 : 0)) : 8;
  const mi = tm ? parseInt(tm[2], 10) : 30;
  const shift = isEtDst(yy, mm, dd) ? 12 : 13; // EDT=+12h、EST=+13h 到北京时间
  const bj = new Date(Date.UTC(yy, mm - 1, dd, hh, mi) + shift * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  const bjDate = `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`;
  const bjHh = bj.getUTCHours(), bjMi = bj.getUTCMinutes();
  const period = bjHh < 6 ? '凌晨' : bjHh < 12 ? '上午' : bjHh < 18 ? '下午' : '晚间';
  return {
    date: bjDate,
    beijingText: `${bjDate} ${period} ${p(bjHh)}:${p(bjMi)}（北京时间）`,
    etText: `${yy}-${p(mm)}-${p(dd)} ${p(hh)}:${p(mi)}（美东）`,
  };
}

// 解析 HTML 表格行：<td><span class="font-medium">Fri, Nov 6, 2026</span><span>8:30 AM<!-- --> ET</span></td><td><a>标题</a></td><td>数据期</td>
function parseFedRateCalc(html) {
  const clean = String(html || '').replace(/<!-- -->/g, '');
  const rowRe = /<td[^>]*><span class="font-medium text-gray-900">([^<]+)<\/span><span class="block text-sm text-gray-500">([^<]+)<\/span><\/td>\s*<td[^>]*>(?:<a[^>]*>)?([^<]+?)(?:<\/a>)?<\/td>\s*<td[^>]*>([^<]*)<\/td>/g;
  const out = [];
  let r;
  while ((r = rowRe.exec(clean)) !== null) {
    const [, dateStr, timeStr, titleRaw, periodRaw] = r;
    const title = titleRaw.trim();
    const ruleKey = Object.keys(TYPE_RULES).find(k => TYPE_RULES[k].match.test(title));
    if (!ruleKey) continue;
    const bj = etToBeijing(dateStr, timeStr.replace(/\s*ET\s*$/, '').trim());
    if (!bj) continue;
    const rule = TYPE_RULES[ruleKey];
    const period = (periodRaw || '').trim().replace(/\s+/g, ' ');
    out.push({
      id: `us-${ruleKey}-${bj.date.replace(/-/g, '')}`,
      date: bj.date,
      dateZh: bj.beijingText,
      dateUs: bj.etText,
      title: title + (period && ruleKey !== 'fomc' ? `（${period}）` : ''),
      category: rule.category,
      level: rule.level,
      impact: rule.impact,
      summary: rule.summary,
      note: `事件预告（自动抓取排期）；原始来源：BLS / 美联储官方排期，经 FedRateCalc 汇总。`,
    });
  }
  return out;
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && Array.isArray(j.events)) return j;
  } catch (e) {}
  return null;
}

function writeCache(events) {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: new Date().toISOString(), source: CAL_URL, events }, null, 2));
    return true;
  } catch (e) {
    console.error('[usMacroCalendar] 写缓存失败:', e.message);
    return false;
  }
}

/**
 * 刷新排期缓存。force=false 时 12h TTL 内直接复用缓存（不抓网）。
 * 返回 { ok, events, fromCache, stale, source }
 * ok=false 时 events 可能为空数组（由调用方回退内置清单）。
 */
async function refreshUsMacroCalendar({ force = false } = {}) {
  const cached = readCache();
  const freshEnough = cached && cached.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < CACHE_TTL_MS;
  if (!force && freshEnough) {
    return { ok: true, events: cached.events, fromCache: true, stale: false, source: cached.source || CAL_URL };
  }
  try {
    const resp = await axios.get(CAL_URL, {
      timeout: 20000,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      adapter: 'http',
    });
    const events = parseFedRateCalc(resp.data);
    if (!Array.isArray(events) || events.length < 2) {
      throw new Error(`解析事件过少（${events ? events.length : 0} 条），页面结构可能改版`);
    }
    writeCache(events);
    return { ok: true, events, fromCache: false, stale: false, source: CAL_URL };
  } catch (e) {
    console.error('[usMacroCalendar] 抓取失败:', e.message);
    if (cached && Array.isArray(cached.events) && cached.events.length) {
      return { ok: true, events: cached.events, fromCache: true, stale: true, source: cached.source || CAL_URL, warn: e.message };
    }
    return { ok: false, events: [], fromCache: false, stale: false, source: CAL_URL, warn: e.message };
  }
}

module.exports = { refreshUsMacroCalendar, parseFedRateCalc, etToBeijing, isEtDst, _CACHE_FILE: CACHE_FILE };
