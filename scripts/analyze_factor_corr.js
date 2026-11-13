#!/usr/bin/env node
/**
 * scripts/analyze_factor_corr.js — P2-3 因子相关性离线报告（20261112）
 * ============================================================================
 * 命令：node scripts/analyze_factor_corr.js [--asOf YYYY-MM-DD] [--days 250] [--minAbs 0.7]
 *   --asOf    缺省 = 最近完整交易日（cnTradingCalendar.asOfTradingDate，周末/节假日前移）
 *   --days    样本窗口（交易日），默认 250
 *   --minAbs  高相关聚类阈值 |corr|，默认 0.7（写死常量 MIN_ABS_CORR）
 *
 * 边界（用户裁决）：
 *   - 只读：仅调既有取数函数（stockData.getHistory / cnTradingCalendar），不写任何业务表/落盘数据；
 *   - 取数可能触发既有取数缓存写入，但绝不改变业务数据；
 *   - 因子集已收编至 lib/taxonomy.js 单源（FACTOR_LIST 导出，20261112）；本脚本仅引用，不再自造定义（见报告 §1 与 Backlog 勾选）；
 *   - 全部因子同源 getHistory 日K OHLCV，结论不外推至其他数据源。
 *
 * 输出：docs/logic/factor-corr-YYYYMMDD.md（YYYYMMDD = asOf 日期）
 * 脚本头注释记录版本号与命令，便于复现。
 *
 * ⚠️ 不改权重，仅供裁决（报告首页固定声明）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sd = require('../lib/stockData');
const { asOfTradingDate } = require('../lib/cnTradingCalendar');

const ROOT = path.join(__dirname, '..');
const APP_VERSION = (() => {
  const s = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const m = s.match(/const APP_VERSION = '([^']+)'/);
  return m ? m[1] : 'unknown';
})();

const _daysIdx = process.argv.indexOf('--days');
const _minIdx = process.argv.indexOf('--minAbs');
const _asOfIdx = process.argv.indexOf('--asOf');
const DAYS = _daysIdx >= 0 && process.argv[_daysIdx + 1] ? (parseInt(process.argv[_daysIdx + 1], 10) || 250) : 250;
const MIN_ABS_CORR = _minIdx >= 0 && process.argv[_minIdx + 1] ? (parseFloat(process.argv[_minIdx + 1]) || 0.7) : 0.7;
const FORCED_ASOF = _asOfIdx >= 0 && process.argv[_asOfIdx + 1] ? process.argv[_asOfIdx + 1] : null;

// 因子集：20261112 收编至 lib/taxonomy.js 单源（FACTOR_LIST 导出），本脚本不再自造定义。
// dry-run 实证（见 taxonomy 注释）：ret_1d / turnover 经 getHistory 取不到 250 日序列、
// pe_ttm/pb 仅 getQuote 快照无历史序列、log_market_cap 无逐日股本序列 → 不参与聚类（inCluster:false）。
// gap_20d / drawdown_20d 同源 getHistory（0% 缺失）纳入主因子集（inCluster:true）。
const { FACTOR_LIST } = require('../lib/taxonomy');
const FACTORS = FACTOR_LIST;                 // 全部 12 项（含 4 快照因子），供 §1 因子清单渲染
const FACTOR_KEYS = FACTOR_LIST.filter(f => f.inCluster).map(f => f.key); // 仅 8 主因子：相关性矩阵/面板/§2/validSamples
const MAX_WARMUP = Math.max(...FACTOR_LIST.map(f => f.warmup)); // 35（macd_hist 预热）

// ---- 统计原语 ----
function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function stdSample(a) { // 样本标准差 (n-1)
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}
function smaAt(arr, i, n) { // arr[i-n+1..i] 均值
  let s = 0; for (let k = i - n + 1; k <= i; k++) s += arr[k]; return s / n;
}
function emaArray(arr, n) { // 返回与 arr 等长的 EMA 数组（seed=arr[0]）
  const k = 2 / (n + 1); const out = new Array(arr.length);
  out[0] = arr[0];
  for (let i = 1; i < arr.length; i++) out[i] = arr[i] * k + out[i - 1] * (1 - k);
  return out;
}
function rsiAt(closes, i, n = 14) {
  let up = 0, down = 0, c = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const d = closes[k] - closes[k - 1];
    if (d >= 0) up += d; else down -= d; c++;
  }
  if (down === 0) return 100;
  const rs = (up / c) / (down / c);
  return 100 - 100 / (1 + rs);
}

/** 平均秩（ties → 取并列值的平均秩），与 lib/lookahead.js 的 dateOf 同为 UTC 日历日中性口径。 */
function rankAverageTies(values) {
  const idx = values.map((_, i) => i).sort((a, b) => values[a] - values[b]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
    const avg = (i + j) / 2 + 1; // 1-based 平均秩
    for (let k = i; k <= j; k++) ranks[idx[k]] = avg;
    i = j + 1;
  }
  return ranks;
}
/** Pearson 相关系数（pairwise complete）。 */
function pearson(a, b) {
  const xs = [], ys = [];
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); }
  }
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a1 = xs[i] - mx, b1 = ys[i] - my; num += a1 * b1; dx += a1 * a1; dy += b1 * b1; }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}
/** Spearman 秩相关：对 X、Y 分别取平均秩后做 Pearson。 */
function spearman(a, b) {
  const xs = [], ys = [], ia = [], ib = [];
  for (let i = 0; i < a.length; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { xs.push(a[i]); ys.push(b[i]); ia.push(i); ib.push(i); }
  }
  if (xs.length < 3) return null;
  const ra = rankAverageTies(xs), rb = rankAverageTies(ys);
  return pearson(ra, rb);
}

/** 截断到 asOf（ISO 日期字符串比较，与 lookahead.dateOf 的 UTC 日历日口径一致）。
 *  N6（2026-11-13）：Array.filter 返回新数组，会丢掉挂在原数组对象上的自定义属性；
 *  getHistory 返回的 bars 带 .meta = { source, volumeUnit }（逐股实际取数源）。
 *  此处统一补挂，单窗口 / 多窗口调用方都无需各自手动补挂；数组元素与顺序不变，
 *  computeFactors / 相关矩阵的计算口径不受影响。 */
function truncateToAsOf(bars, asOf) {
  const trunc = bars.filter(b => String(b.date) <= asOf);
  if (bars && bars.meta !== undefined) trunc.meta = bars.meta;
  return trunc;
}

/** 对单只股票的窗口（已截断、已取最后 DAYS 根）计算 8 因子序列，返回 [{date, factors:{...}}]。
 *  注意：下方各因子 `if (i >= N)` 阈值是**实际计算口径**，与文件顶部 FACTOR_LIST（引自 lib/taxonomy.js）的 warmup 字段严格一一对应；
 *  但 warmup 字段**仅用于报告披露**（§1「预热(根)」列、§2 样本量口径注释），**不参与此处计算**。
 *  若调整某因子阈值，须同步改 taxonomy 的 warmup，否则报告披露与实际计算口径会不一致。 */
function computeFactors(window) {
  const closes = window.map(b => b.close);
  const opens = window.map(b => b.open);
  const vols = window.map(b => b.volume);
  const ema12 = emaArray(closes, 12), ema26 = emaArray(closes, 26);
  const dif = closes.map((_, i) => ema12[i] - ema26[i]);
  const dea = emaArray(dif, 9);
  const rows = [];
  for (let i = 0; i < window.length; i++) {
    const f = {};
    const c = closes[i];
    // mom_20d
    if (i >= 20 && closes[i - 20] > 0) f.mom_20d = c / closes[i - 20] - 1;
    // vol_20d：近 20 日日收益标准差（样本）
    if (i >= 20) {
      const rets = [];
      for (let k = i - 19; k <= i; k++) if (closes[k - 1] > 0) rets.push(closes[k] / closes[k - 1] - 1);
      if (rets.length >= 2) f.vol_20d = stdSample(rets);
    }
    // vol_ratio：当日量 / 近 20 日均量
    if (i >= 19) f.vol_ratio = vols[i] / smaAt(vols, i, 20);
    // ma_bias：close / MA20 - 1
    if (i >= 20) f.ma_bias = c / smaAt(closes, i, 20) - 1;
    // rsi_14
    if (i >= 14) f.rsi_14 = rsiAt(closes, i, 14);
    // macd_hist：DIF - DEA
    if (i >= 35) f.macd_hist = dif[i] - dea[i];
    // gap_20d：隔夜跳空 (open - 昨收) / 昨收
    if (i >= 1 && closes[i - 1] > 0) f.gap_20d = (opens[i] - closes[i - 1]) / closes[i - 1];
    // drawdown_20d：(close - 20日最高) / 20日最高
    if (i >= 20) {
      let mx = -Infinity; for (let k = i - 20; k <= i; k++) if (closes[k] > mx) mx = closes[k];
      if (mx > 0) f.drawdown_20d = (c - mx) / mx;
    }
    rows.push({ date: window[i].date, factors: f });
  }
  return rows;
}

// ---- 连通分量聚类（单遍 BFS），边权 |Pearson| > minAbs ----
function cluster(keys, pearsonMat, minAbs) {
  const adj = keys.map(() => []);
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++)
      if (Math.abs(pearsonMat[i][j]) > minAbs) { adj[i].push(j); adj[j].push(i); }
  const seen = new Array(keys.length).fill(false);
  const clusters = [];
  for (let s = 0; s < keys.length; s++) {
    if (seen[s]) continue;
    const q = [s]; seen[s] = true; const comp = [s];
    while (q.length) {
      const u = q.shift();
      for (const v of adj[u]) if (!seen[v]) { seen[v] = true; q.push(v); comp.push(v); }
    }
    if (comp.length >= 2) {
      let sum = 0, cnt = 0, minW = Infinity;
      for (let a = 0; a < comp.length; a++)
        for (let b = a + 1; b < comp.length; b++) {
          const w = Math.abs(pearsonMat[comp[a]][comp[b]]);
          sum += w; cnt++; if (w < minW) minW = w;
        }
      clusters.push({ members: comp.map(i => keys[i]), avgAbs: cnt ? sum / cnt : 0, minAbsW: cnt ? minW : 0 });
    }
  }
  return clusters;
}

async function main() {
  const asOf = FORCED_ASOF || asOfTradingDate();
  const watchlist = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'watchlist.json'), 'utf8'));
  const symbols = watchlist.map(w => w.symbol);

  console.log(`[P2-3] asOf=${asOf} · 自选股 ${symbols.length} 只 · 窗口 ${DAYS} 交易日 · 阈值 |corr|>${MIN_ABS_CORR}`);

  const panel = {}; // key -> 跨股票拼接的日序列（仅含全因子非空行）
  for (const k of FACTOR_KEYS) panel[k] = [];
  let rowsTotal = 0, lastDateStaleNote = '';
  const perSymbolMissing = {}; // key -> 缺失计数
  const fetchNotes = []; // N6（2026-11-13）：逐股实际取数源 + 截断末根日期，供报告如实标注

  for (const sym of symbols) {
    const hist = await sd.getHistory(sym, '1y');
    if (!Array.isArray(hist) || hist.length === 0) { console.warn(`  [跳过] ${sym} getHistory 空`); continue; }
    const trunc = truncateToAsOf(hist, asOf);
    const lastDate = trunc.length ? trunc[trunc.length - 1].date : null;
    if (lastDate !== asOf) {
      const note = `最后一根 ${lastDate} < asOf ${asOf}（数据滞后）`;
      if (!lastDateStaleNote) lastDateStaleNote = note;
      console.warn(`  [${sym}] ${note}`);
    }
    // N6（2026-11-13）：truncateToAsOf 已在纯函数内保留 .meta，此处逐股采集实际服务源（降级如实标注，不写「无降级」）
    fetchNotes.push({ symbol: sym, source: (trunc.meta && trunc.meta.source) || '未知', lastDate });
    const window = trunc.slice(-DAYS);
    const rows = computeFactors(window);
    for (const r of rows) {
      rowsTotal++;
      let allOk = true;
      for (const k of FACTOR_KEYS) {
        if (Number.isFinite(r.factors[k])) panel[k].push(r.factors[k]);
        else { allOk = false; perSymbolMissing[k] = (perSymbolMissing[k] || 0) + 1; }
      }
      // 仅当全因子齐备才纳入相关性面板（pairwise complete 已另处理，此处统一行口径）
      void allOk;
    }
  }

  // 相关性矩阵（Pearson + Spearman）
  const n = FACTOR_KEYS.length;
  const P = Array.from({ length: n }, () => new Array(n).fill(null));
  const S = Array.from({ length: n }, () => new Array(n).fill(null));
  for (let i = 0; i < n; i++) {
    P[i][i] = 1; S[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const p = pearson(panel[FACTOR_KEYS[i]], panel[FACTOR_KEYS[j]]);
      const s = spearman(panel[FACTOR_KEYS[i]], panel[FACTOR_KEYS[j]]);
      P[i][j] = P[j][i] = p; S[i][j] = S[j][i] = s;
    }
  }

  const clusters = cluster(FACTOR_KEYS, P, MIN_ABS_CORR);
  const validSamples = panel[FACTOR_KEYS[0]].length;

  // ---- 生成报告 ----
  const canonicalPath = path.join(ROOT, 'docs', 'logic', `factor-corr-${asOf.replace(/-/g, '')}.md`);
  // N6（2026-11-13）：支持 --out 定向输出（与多窗口模式一致），便于真实取数验证落到 tmp/ 而不覆盖已归档报告；
  // 既有报告始终从正式路径读取，保证业务解读块 / 复核意见区块在任何输出路径下都能回填。
  const outPath = parseOutArg() || canonicalPath;
  const generated = buildReport({ asOf, symbols, rowsTotal, validSamples, P, S, clusters, perSymbolMissing, lastDateStaleNote, fetchNotes });
  // ⑤ 整改 4（2026-11-13）：重跑前保留既有【业务解读】块（领域人 / AI 草稿文字）；数字段仍由 buildReport 重算
  const existingMd = fs.existsSync(canonicalPath) ? fs.readFileSync(canonicalPath, 'utf8') : '';
  const md = preserveBusinessBlocks(generated, existingMd);
  const keptBlocks = extractBusinessBlocks(existingMd).length;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`[P2-3] 业务解读块保留：${keptBlocks} 个（重跑不覆盖）`);
  const srcCount = {};
  for (const nte of fetchNotes) { const s = nte.source || '未知'; srcCount[s] = (srcCount[s] || 0) + 1; }
  console.log(`[P2-3] 实际取数源（逐股）：${Object.entries(srcCount).map(([s, c]) => `${s} ×${c}`).join('；') || '无'}`);
  console.log(`[P2-3] 报告已写出: ${outPath}`);
  console.log(`  有效样本(全因子齐备行)=${validSamples} · 高相关簇=${clusters.length}`);
  return outPath;
}

function fmt(x, d = 3) { return (x == null || !Number.isFinite(x)) ? '—' : x.toFixed(d); }

// ---- ⑤ 整改 4（2026-11-13）：业务解读块重跑防覆盖 ----------------------------------
// 背景：§4【业务解读】整块由领域人/人工维护，buildReport() 只输出占位符；main() 每次
//       fs.writeFileSync 整文件覆盖 → 重跑会静默丢失该块（复核意见 ITEM 8）。
// 方案：纯函数按出现顺序，把既有报告里的【业务解读】块回填到新生成 md 的占位符处。
//       数字与结构仍全部来自 buildReport() 重算；业务解读文字原样保留，
//       不固化业务断言进代码（守「业务裁决归领域人」边界）。零 IO / 零网络，守卫可注入。
const BIZ_PLACEHOLDER = '- 【业务解读：待补充】';
// ⑤ 补充整改（2026-11-13 10:4x）：复核存疑旁注 / H2 建议门槛 / 整改留痕移出 §4 正文，
//      改置于报告末尾「附：复核意见摘要（非报告原文）」独立区块，避免领域人阅读业务断言时
//      被 agent 批注影响判断独立性。该区块同样需重跑防覆盖，故复用同一套回填机制；
//      区块文字（含复核意见与整改留痕）不固化进代码，仍只存在于 md 产物中。
const REVIEW_SECTION_HEAD = '## 附：复核意见摘要（非报告原文）';
const REVIEW_PLACEHOLDER = '<!-- REVIEW_NOTES_PLACEHOLDER -->';

/** 从既有报告 md 中按出现顺序提取每个簇的【业务解读】整块（含缩进子项）。 */
function extractBusinessBlocks(existingMd) {
  if (typeof existingMd !== 'string' || !existingMd) return [];
  const blocks = [];
  let cur = null;
  const flush = () => { if (cur) { blocks.push(cur.join('\n').replace(/\s+$/, '')); cur = null; } };
  for (const line of existingMd.split('\n')) {
    if (/^- 【业务解读/.test(line)) {
      // 脚本模板生成的占位符不是业务解读块，跳过（否则首次生成后重跑会把它当内容回填）。
      if (line.trim() === BIZ_PLACEHOLDER) { flush(); continue; }
      flush(); cur = [line]; continue;
    }
    if (!cur) continue;
    // 块内允许空行与缩进子项；遇到下一标题或非缩进的顶层列表项即结束。
    if (/^(## |### 簇 )/.test(line) || (line.trim() !== '' && !/^\s/.test(line))) { flush(); continue; }
    cur.push(line);
  }
  flush();
  return blocks;
}

/** 提取报告末尾「附：复核意见摘要」独立区块（含标题、来源说明与全部子项）。
 *  前置约定：该区块须为报告最后一节；无此节返回 null（首次生成）。零 IO / 零网络。
 *
 *  N7 区块更新规则（2026-11-13 11:3x 用户裁决；本轮只记注释、不改函数逻辑，
 *  第二次书面复核时按此执行）：
 *   - 采用「替换」，不采用「追加」：A 段每次只放最新一次复核档案全文，报告只承载最终结论链；
 *     历史复核按日期另存 docs/logic/factor-corr-20261112-review-<date>.md 归档为审计材料，
 *     报告只链最新一次。
 *   - 不采用「追加」的理由：A 段累积多次复核会让报告越滚越长，且「放行」与「不放行」并存，
 *     读者需自行判断哪条有效，属状态失真；报告是交付物，历史复核属审计材料。
 *   - 执行时须同步更新区块来源标注、md5 与「A 段逐字相等」守卫的比对基准，
 *     勿留旧「不放行」区块与新结论并存。
 */
function extractReviewNotesBlock(existingMd) {
  if (typeof existingMd !== 'string' || !existingMd) return null;
  const lines = existingMd.split('\n');
  const at = lines.findIndex(l => l.trim() === REVIEW_SECTION_HEAD);
  if (at < 0) return null;
  return lines.slice(at).join('\n').replace(/\s+$/, '');
}

/** 把既有【业务解读】块按序回填到占位符，并把末尾复核意见摘要独立区块整段回填；
 *  块不足时多余占位符原样保留（不伪造业务结论 / 复核结论）；数字段仍全部来自 buildReport() 重算。 */
function preserveBusinessBlocks(generatedMd, existingMd) {
  const blocks = extractBusinessBlocks(existingMd);
  const review = extractReviewNotesBlock(existingMd);
  let i = 0;
  return generatedMd.split('\n')
    .map(line => {
      if (line === BIZ_PLACEHOLDER && i < blocks.length) return blocks[i++];
      if (line === REVIEW_PLACEHOLDER && review) return review;
      return line;
    })
    .join('\n');
}

function buildReport({ asOf, symbols, rowsTotal, validSamples, P, S, clusters, perSymbolMissing, lastDateStaleNote, fetchNotes }) {
  const n = FACTOR_KEYS.length;
  const startDate = asOf; // 窗口起点在脚本内为动态取最后 DAYS 根；报告注明窗口口径
  let md = '';
  md += `# 因子相关性离线分析报告（P2-3）\n`;
  md += `> ⚠️ **不改权重，仅供裁决**（本报告为只读分析产物，不影响任何业务表与既有模型权重）\n\n`;
  md += `- **数据截止日（asOf）**：${asOf}（最近完整交易日，lookahead 口径截断；${lastDateStaleNote ? '⚠️ ' + lastDateStaleNote : '截断后最后一根日期 = asOf，数据新鲜'}）\n`;
  md += `- **样本**：自选股池 ${symbols.length} 只（${symbols.join('、')}） × 近 ${DAYS} 交易日；有效样本（mom_20d 等主因子齐备行，即面板序列长度）**${validSamples}** = ${symbols.length} 只 × ${Math.round(validSamples / symbols.length)} 交易日\n`;
  md += `- **代码版本**：APP_VERSION ${APP_VERSION}；命令 \`node scripts/analyze_factor_corr.js --asOf ${asOf} --days ${DAYS} --minAbs ${MIN_ABS_CORR}\`\n`;
  md += `- **因子集注明**：本因子集已收编至 \`lib/taxonomy.js\` 单源（\`FACTOR_LIST\` 导出，20261112）；本脚本仅引用，数值与 P2-3 报告一致。\n\n`;
  if (Array.isArray(fetchNotes) && fetchNotes.length) {
    // N6（2026-11-13）：main() 已采集逐股实际取数源 → 如实写出降级链结果（与多窗口报告同口径），不再写「待补」。
    const srcCount = {};
    for (const nte of fetchNotes) { const s = nte.source || '未知'; srcCount[s] = (srcCount[s] || 0) + 1; }
    const srcStr = Object.entries(srcCount).map(([s, c]) => `${s} ×${c}`).join('；');
    md += `- **实际数据源标注**：${srcStr}（逐股如实标注，取自 \`hist.meta.source\`）；若非主源腾讯日K，则本报告数值基于降级源（新浪/东财）日K，重跑时主源恢复将得到主源口径数值。\n`;
    const stale = fetchNotes.filter(nte => nte.lastDate && nte.lastDate !== asOf);
    md += `- **截断末根核验**：${stale.length ? stale.map(nte => `${nte.symbol} 末根 ${nte.lastDate} ≠ asOf（滞后）`).join('；') : `${fetchNotes.length}/${fetchNotes.length} 只末根 = asOf，无滞后`}\n`;
  } else {
    // 历史 / 离线兜底：该轮生成时未采集取数源，无法从产物反推；N6 修复后 main() 总会传 fetchNotes，
    // 此分支仅用于纯函数直调（守卫 / 离线重跑），文案保持历史口径，不得冒充任何一轮实际取数源。
    md += `- **实际数据源标注**：⚠️ **取数源未记录，待补**——该轮生成时未采集逐股 hist.meta.source（N6 修复前 truncateToAsOf 的 filter 会丢弃挂在数组上的 .meta），无法从产物反推当时走的是腾讯主源还是新浪/东财降级源；多窗口报告 docs/logic/factor-corr-windows-${asOf.replace(/-/g, '')}.md §1.1 已把 0.725 vs 0.730 边值漂移归因为「数据源 / 取数时点差异，主源恢复后需同源复核」；多窗口标注的降级源属另一轮独立取数，**不可等同于本报告**（见复核意见 ITEM 7）。\n`;
  }

  // 1. 因子清单
  md += `## 1. 因子清单（引自 lib/taxonomy.js · FACTOR_LIST 单源，20261112 收编）\n\n`;
  md += `| 因子 key | 含义 | 数据来源 | 预热(根) | 是否参与聚类 |\n|---|---|---|---|---|\n`;
  for (const f of FACTOR_LIST) md += `| \`${f.key}\` | ${f.label} | ${f.src} | ${f.warmup} | ${f.inCluster ? '✅ 参与' : '❌ 不参与（无历史序列）'} |\n`;
  md += `\n> 主因子集（inCluster:true，8 项）同源 getHistory 日K OHLCV，参与相关性聚类；快照因子（pe_ttm/pb/turnover/log_market_cap，inCluster:false）仅 getQuote 快照/无逐日序列，不参与聚类。ret_1d / amplitude_20d 经 dry-run 实证排除（冗余或主源不回传）。\n\n`;

  // 2. 缺失率
  md += `## 2. 缺失率表\n\n`;
  md += `| 因子 | 缺失数 | 缺失率 |\n|---|---|---|\n`;
  for (const k of FACTOR_KEYS) {
    const miss = perSymbolMissing[k] || 0;
    const rate = rowsTotal ? (miss / rowsTotal * 100) : 0;
    md += `| \`${k}\` | ${miss} | ${rate.toFixed(1)}% |\n`;
  }
  md += `\n> **初始化窗口损耗**：每只请求 ${DAYS} 交易日，主因子（mom_20d 等）需 ~${FACTORS[0].warmup} 根预热，单只有效样本约 ${DAYS - FACTORS[0].warmup}（${DAYS}−${FACTORS[0].warmup}）；${symbols.length} 只合计 **${validSamples} = ${symbols.length} × ${Math.round(validSamples / symbols.length)}**。macd_hist 需 ${MAX_WARMUP} 根预热，其缺失经 pearson 的 pairwise-complete 单独处理，不计入有效样本基数损耗（缺失率表 macd_hist 14% 即其独立预热缺口）。缺失率均 <30%，全部因子参与聚类。\n`;
  md += `> **样本量口径警示**：**${validSamples} 为基准有效样本（${FACTORS[0].warmup} 根预热口径，即 mom_20d 等主因子齐备行）**；凡涉及 macd_hist 的因子对经 pearson 的 pairwise-complete 仅取两因子均齐备行，约 **${(DAYS - MAX_WARMUP) * symbols.length}（${symbols.length}×${DAYS - MAX_WARMUP}，215=250−35）**；rsi_14 齐备约 **${DAYS - (FACTORS.find(f => f.key === 'rsi_14') || { warmup: 14 }).warmup}/只（${DAYS}−14）**。请勿将 ${validSamples} 视为所有因子对的统一样本量——每个相关系数按因子对独立做 pairwise-complete，样本量随预热与数据缺口浮动。\n\n`;

  // 3. 相关矩阵摘要 Top20
  md += `## 3. 相关矩阵摘要（Top 20 |corr| 对，Pearson / Spearman）\n\n`;
  const pairs = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairs.push({ i, j, p: P[i][j], s: S[i][j] });
  pairs.sort((a, b) => Math.abs(b.p) - Math.abs(a.p));
  md += `| 因子 A | 因子 B | Pearson | Spearman |\n|---|---|---|---|\n`;
  for (const pr of pairs.slice(0, 20)) {
    md += `| \`${FACTOR_KEYS[pr.i]}\` | \`${FACTOR_KEYS[pr.j]}\` | ${fmt(pr.p)} | ${fmt(pr.s)} |\n`;
  }
  md += `\n`;

  // 4. 高相关聚类
  md += `## 4. 高相关聚类清单（|Pearson| > ${MIN_ABS_CORR}）\n\n`;
  if (clusters.length === 0) {
    md += `> 未检出 |Pearson| > ${MIN_ABS_CORR} 的因子簇。\n`;
  } else {
    clusters.forEach((c, idx) => {
      md += `### 簇 ${idx + 1}：${c.members.join(' · ')}\n`;
      md += `- 成员数：${c.members.length}\n`;
      md += `- 簇内平均 |Pearson|：${fmt(c.avgAbs)}\n`;
      md += `- 簇内最小 |Pearson|（最弱边）：${fmt(c.minAbsW)}\n`;
      md += `- 特性注记：连通分量可能因高相关因子成链而形成**链式大簇**（多因子两两高相关但非全连通成团），最小 |corr| 暴露簇内最弱边，防被平均掩盖。\n`;
      md += `- 最弱边注记：簇内最小 |Pearson|（${fmt(c.minAbsW)}）可能 < ${MIN_ABS_CORR}，此时该边系经簇内其他高相关因子**链式连通**纳入同一簇（非该因子对两两直接高相关）；不应据此误判最弱边因子对本身高度相关。\n`;
      md += `${BIZ_PLACEHOLDER}\n\n`;
    });
  }

  // 5. 结论与局限
  md += `## 5. 结论与局限\n\n`;
  md += `- **结论**：（由数值矩阵与上述聚类得出，待人工结合业务解读填充；本报告仅提供相关结构，不替代因子重要性裁决。）\n`;
  md += `- **结构结论**：本次在阈值 |Pearson| > ${MIN_ABS_CORR} 下仅检出 **${clusters.length}** 个高相关簇${clusters.length === 1 ? '（未发现第二个高相关簇）' : ''}；其余因子对 |Pearson| 均 < ${MIN_ABS_CORR}，不构成独立高相关簇（详见 §3 Top20）。\n`;
  md += `- **局限 1（窗口敏感）**：单一 ${DAYS} 日窗口对牛/熊段敏感，结论可能随窗口漂移；多窗口（60/120/${DAYS}）对照**已完成**，见 docs/logic/factor-corr-windows-${asOf.replace(/-/g, '')}.md §2（簇结构跨窗口稳健）；本报告 ${DAYS} 日结论不外推至其他窗口。\n`;
  md += `- **局限 2（同源）**：全部因子同源 getHistory 日K OHLCV，结论**仅限该数据源，不外推至其他数据源**（如财务/资金流/情绪）。\n`;
  md += `- **局限 3（市值序列缺失）**：市值仅 getQuote 快照可得（circulationValue/totalValue），无逐日股本序列，未构造 log_market_cap 时间序列。\n`;
  md += `- **局限 4（预热损耗）**：初始化窗口损耗使有效样本约 ${validSamples}（见 §2）。\n`;
  md += `- **局限 5（自相关/有效样本）**：因子基于重叠滑动窗口，序列存在时间序列自相关，名义样本量高于真实有效样本量；本报告**仅做描述性聚类，不做显著性检验**，相关结构结论不宜直接推断因果或统计显著。\n\n`;

  md += `## Backlog（P2-3 后续）\n\n`;
  md += `- [x] 因子集已收编至 \`lib/taxonomy.js\` 单源（\`FACTOR_LIST\` 导出，20261112）；本脚本不再自造定义。\n`;
  md += `- [x] 多窗口对照（60/120/${DAYS}）验证相关结构稳健性（已完成，见 docs/logic/factor-corr-windows-${asOf.replace(/-/g, '')}.md §2）。\n`;
  md += `- [ ] 补充 amplitude_20d 等更多同源因子以丰满矩阵（用户本轮决定不加）。\n`;
  md += `- [ ] 业务解读人工填充（簇级一句话）。\n`;
  md += `\n${REVIEW_PLACEHOLDER}\n`;
  return md;
}

if (require.main === module) {
  const _winIdx = process.argv.indexOf('--windows');
  const hasWindows = _winIdx >= 0 && process.argv[_winIdx + 1];
  (hasWindows ? mainWindows() : main()).then(() => process.exit(0)).catch(e => { console.error('[P2-3] 失败:', e && e.message); process.exit(1); });
}

// ============================================================================
// 多窗口对照模式（backlog ③，2026-11-12）：--windows 60,120,250 [--out <path>]
// ----------------------------------------------------------------------------
// 与单窗口 main() 完全隔离（不改其任何逻辑，既有 factor_corr 11/0 守卫不受影响）；
// 复用同一套统计原语（computeFactors / pearson / spearman / cluster）与
// lib/taxonomy.js FACTOR_LIST 单源，保证口径一致。
// 取数一次（每只 1 次 getHistory('1y')），三个窗口共用截断后序列再各自切片。

const WINDOWS_DEF = [60, 120, 250];
const INSUFFICIENT_SAMPLES = 100; // 有效样本低于此值 → 标「样本不足，不结论」

function parseWindowsArg() {
  const idx = process.argv.indexOf('--windows');
  if (idx < 0 || !process.argv[idx + 1]) return null;
  const arr = process.argv[idx + 1].split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n) && n > 0);
  return arr.length ? arr.sort((a, b) => a - b) : null;
}
function parseOutArg() {
  const idx = process.argv.indexOf('--out');
  return (idx >= 0 && process.argv[idx + 1]) ? process.argv[idx + 1] : null;
}

/** 纯函数：对已截断的各股日K序列按多窗口分别算相关结构（零网络、零落盘，供守卫注入）。
 *  historiesBySymbol: Array<{ symbol, bars }>（bars 已截断至 asOf，内部再按窗口 slice(-days)） */
function analyzeWindowsCore({ histories, windows, minAbs = MIN_ABS_CORR, insufficientThreshold = INSUFFICIENT_SAMPLES }) {
  const nKeys = FACTOR_KEYS.length;
  const results = [];
  for (const days of windows) {
    const panel = {}; for (const k of FACTOR_KEYS) panel[k] = [];
    let rowsTotal = 0;
    const perSymbolMissing = {};
    for (const { bars } of histories) {
      const window = bars.slice(-days);
      const rows = computeFactors(window);
      for (const r of rows) {
        rowsTotal++;
        for (const k of FACTOR_KEYS) {
          if (Number.isFinite(r.factors[k])) panel[k].push(r.factors[k]);
          else perSymbolMissing[k] = (perSymbolMissing[k] || 0) + 1;
        }
      }
    }
    const P = Array.from({ length: nKeys }, () => new Array(nKeys).fill(null));
    const S = Array.from({ length: nKeys }, () => new Array(nKeys).fill(null));
    let pairCount = 0, highPairCount = 0, absSum = 0, maxAbs = 0, maxAbsPair = null;
    for (let i = 0; i < nKeys; i++) {
      P[i][i] = 1; S[i][i] = 1;
      for (let j = i + 1; j < nKeys; j++) {
        const p = pearson(panel[FACTOR_KEYS[i]], panel[FACTOR_KEYS[j]]);
        const s = spearman(panel[FACTOR_KEYS[i]], panel[FACTOR_KEYS[j]]);
        P[i][j] = P[j][i] = p; S[i][j] = S[j][i] = s;
        if (p != null && Number.isFinite(p)) {
          pairCount++; absSum += Math.abs(p);
          if (Math.abs(p) > maxAbs) { maxAbs = Math.abs(p); maxAbsPair = [FACTOR_KEYS[i], FACTOR_KEYS[j]]; }
          if (Math.abs(p) > minAbs) highPairCount++;
        }
      }
    }
    const clusters = cluster(FACTOR_KEYS, P, minAbs);
    const validSamples = panel[FACTOR_KEYS[0]].length;
    // 簇内最弱边（所有簇合并计）：连通分量口径下最薄弱的一环
    let minClusterEdge = null;
    for (const c of clusters) if (c.minAbsW != null && (minClusterEdge == null || c.minAbsW < minClusterEdge)) minClusterEdge = c.minAbsW;
    results.push({
      days, validSamples, rowsTotal, pairCount, highPairCount,
      avgAbsAll: pairCount ? absSum / pairCount : null,
      maxAbs, maxAbsPair, clusters, minClusterEdge,
      insufficient: validSamples < insufficientThreshold,
      perSymbolMissing,
    });
  }
  return results;
}

/** 纯函数：由 analyzeWindowsCore 结果构建对照报告 md（数字全部动态插入，重跑覆盖重写）。
 *  fetchNotes（可选）：Array<{ symbol, source, lastDate }>——逐股实际服务源与截断后末根日期，
 *  降级/滞后如实标注（degraded 口径：只写「实际走了什么源」，不写「无降级」）。
 *  histRef（可选）：{ asOf, avgAbs, minEdge, path }——历史单窗口报告解析结果（mainWindows 动态解析），
 *  用于「全对平均 vs 簇内平均」口径并列对照与最弱边差异归因（归因按 asOf 是否一致分支，不臆测）。 */
function buildWindowsReport({ asOf, symbols, results, minAbs = MIN_ABS_CORR, generatedAt, fetchNotes, histRef }) {
  let md = '';
  md += `# 因子相关性多窗口对照报告（backlog ③）\n`;
  md += `> ⚠️ **AI 生成，待人工复核**；**不改权重，仅供裁决**（只读分析产物，不影响任何业务表与既有模型权重）。\n`;
  md += `> ⚠️ **数字由脚本动态插入（analyzeWindowsCore 重算），禁止手改**——手改内容会在下次重跑时被擦除。\n\n`;
  md += `- **数据截止日（asOf）**：${asOf}（最近完整交易日，lookahead 口径截断；取数一次、三窗口共用）\n`;
  md += `- **样本**：自选股池 ${symbols.length} 只（${symbols.join('、')}）\n`;
  md += `- **窗口**：${results.map(r => r.days).join(' / ')} 交易日；聚类阈值 |Pearson| > ${minAbs}（与单窗口报告一致）\n`;
  md += `- **代码版本**：APP_VERSION ${APP_VERSION}；命令 \`node scripts/analyze_factor_corr.js --windows ${results.map(r => r.days).join(',')}\`\n`;
  md += `- **生成时间**：${generatedAt || new Date().toISOString()}\n`;
  if (Array.isArray(fetchNotes) && fetchNotes.length) {
    const srcCount = {};
    for (const n of fetchNotes) srcCount[n.source] = (srcCount[n.source] || 0) + 1;
    const srcStr = Object.entries(srcCount).map(([s, c]) => `${s} ×${c}`).join('；');
    md += `- **实际数据源（逐股如实标注，降级链结果）**：${srcStr}；若非主源腾讯日K，则本报告数值基于降级源（新浪/东财）日K，重跑时主源恢复将得到主源口径数值。\n`;
    const stale = fetchNotes.filter(n => n.lastDate && n.lastDate !== asOf);
    md += `- **截断末根核验**：${stale.length ? stale.map(n => `${n.symbol} 末根 ${n.lastDate} ≠ asOf（滞后）`).join('；') : `${fetchNotes.length}/${fetchNotes.length} 只末根 = asOf，无滞后`}\n`;
  }
  md += `\n`;

  md += `## 1. 多窗口对照表\n\n`;
  md += `> ⚠️ **两列平均口径不同，不可互比**：「全对平均」= 全部非空因子对（含低相关对）的平均 |Pearson|，刻画整体相关背景水平；「簇内平均」= 仅高相关簇内两两边的平均 |Pearson|（与历史单窗口报告 §4「簇内平均 |Pearson|」同口径，如历史 0.725）。混读会把「整体背景 0.17」误判为「相关性从 0.725 掉到 0.17」。\n\n`;
  md += `| 窗口(日) | 有效样本 | 非空相关对 | 高相关对(>阈值) | 簇数 | 簇成员 | 全对平均\\|P\\|（全部非空对） | 簇内平均\\|P\\|（与历史 §4 同口径） | 最强对\\|P\\| | 簇内最弱边 | 第二簇 | 样本判定 |\n`;
  md += `|---|---|---|---|---|---|---|---|---|---|---|---|\n`;
  for (const r of results) {
    const members = r.clusters.length ? r.clusters.map((c, i) => `簇${i + 1}[${c.members.join('·')}]`).join('；') : '—';
    const second = r.clusters.length === 0 ? '无簇' : (r.clusters.length >= 2 ? `是（${r.clusters.length} 簇）` : '否');
    const verdict = r.insufficient ? '**样本不足，不结论**' : '可用';
    md += `| ${r.days} | ${r.validSamples} | ${r.pairCount} | ${r.highPairCount} | ${r.clusters.length} | ${members} | ${fmt(r.avgAbsAll)} | ${r.clusters.length === 0 ? '—' : r.clusters.map((c, i) => (r.clusters.length === 1 ? fmt(c.avgAbs) : `簇${i + 1}:${fmt(c.avgAbs)}`)).join('；')} | ${r.maxAbsPair ? `${fmt(r.maxAbs)}（${r.maxAbsPair[0]}·${r.maxAbsPair[1]}）` : '—'} | ${r.minClusterEdge == null ? '—' : fmt(r.minClusterEdge)} | ${second} | ${verdict} |\n`;
  }
  md += `\n> 有效样本口径与单窗口报告一致（mom_20d 等 20 根预热主因子齐备行 = 各股（窗口−20）根；macd_hist 35 根预热的因子对按 pairwise-complete 独立取样）。样本判定阈值：有效样本 < ${INSUFFICIENT_SAMPLES} 标「样本不足，不结论」。\n`;
  if (histRef && Number.isFinite(histRef.avgAbs) && Number.isFinite(histRef.minEdge)) {
    md += `\n### 1.1 与历史单窗口报告对照（防口径误读与归因臆测）\n\n`;
    md += `- 历史基线：\`docs/logic/factor-corr-${(histRef.asOf || asOf).replace(/-/g, '')}.md\`（asOf ${histRef.asOf || asOf}，250 日）：**簇内平均 ${histRef.avgAbs.toFixed(3)}、簇内最弱边 ${histRef.minEdge.toFixed(3)}**（该报告生成时未标注数据源）。\n`;
    const r250 = results.find(r => r.days === 250) || results[results.length - 1];
    const r250Avg = r250.clusters.length && r250.clusters[0] ? fmt(r250.clusters[0].avgAbs) : '—';
    const r250Edge = r250.minClusterEdge == null ? '—' : fmt(r250.minClusterEdge);
    if (histRef.asOf === asOf) {
      md += `- 本轮 250 日窗口簇内平均 ${r250Avg}、簇内最弱边 ${r250Edge}：**两报告 asOf 相同（${asOf}）、窗口相同（250 日），差异不能归因「窗口后移」**；本轮数据源${fetchNotes && fetchNotes.length ? '为 ' + Object.entries(fetchNotes.reduce((m, n) => { m[n.source] = (m[n.source] || 0) + 1; return m; }, {})).map(([x, c]) => `${x}×${c}`).join('、') : '见 §0 数据源标注'}（历史报告源未标注）→ 边值 0.009 量级漂移**归因数据源/取数时点差异，主源恢复后需同源复核**。\n`;
      md += `- 簇内平均同因脚注：本轮 ${r250Avg} vs 历史 ${histRef.avgAbs.toFixed(3)}（差 ${Math.abs(parseFloat(r250Avg) - histRef.avgAbs).toFixed(3)}）与最弱边漂移（${r250Edge} vs ${histRef.minEdge.toFixed(3)}）**同因——同 asOf 同窗口下归因数据源/取数时点差异**；两数口径一致（均为簇内平均），非口径变化、非相关性衰减。\n`;
    } else {
      md += `- 本轮 250 日窗口簇内最弱边 ${r250Edge} vs 历史 ${histRef.minEdge.toFixed(3)}：**窗口后移（asOf ${asOf} vs ${histRef.asOf}），叠加数据源差异（本轮源见 §0 标注）**，两类因素并存、不单独归因。\n`;
      md += `- 簇内平均同因脚注：本轮 ${r250Avg} vs 历史 ${histRef.avgAbs.toFixed(3)} 与最弱边漂移（${r250Edge} vs ${histRef.minEdge.toFixed(3)}）**同因——窗口后移+数据源差异并存，不单独归因**；两数口径一致（均为簇内平均），非口径变化。\n`;
    }
  }
  md += `\n## 2. 稳健性对照结论（跨窗口）\n\n`;
  const clCounts = results.map(r => r.clusters.length);
  const members0 = results[0].clusters.map(c => c.members.join('·')).sort().join(';');
  const membersLast = results[results.length - 1].clusters.map(c => c.members.join('·')).sort().join(';');
  md += `- 簇数序列（${results.map(r => r.days).join('→')}）= ${clCounts.join(' → ')}；`;
  if (results.length >= 2 && members0 === membersLast && clCounts[0] === clCounts[clCounts.length - 1]) {
    md += `最短与最长窗口簇成员一致 → **簇结构跨窗口稳健**。\n`;
  } else {
    md += `最短与最长窗口簇成员/簇数不一致 → **簇结构窗口敏感，如实记录、不做调和**（逐窗口数值见 §1）。\n`;
  }
  const avgSeq = results.map(r => fmt(r.avgAbsAll)).join(' → ');
  md += `- 全对平均 |Pearson|（全部非空对口径，非簇内平均）序列 = ${avgSeq}（窗口越短样本越少，估计噪声越大，不宜直接横向比大小下结论）。\n`;
  const minEdgeSeq = results.map(r => (r.minClusterEdge == null ? '—' : fmt(r.minClusterEdge))).join(' → ');
  md += `- 簇内最弱边序列 = ${minEdgeSeq}；若短窗口最弱边明显下降，提示该簇在高频段边缘松动（如实记录，不外推）。\n\n`;

  md += `## 3. 局限（逐条如实声明）\n\n`;
  md += `- **窗口敏感**：60/120/250 结果可能随牛/熊段漂移，本报告为描述性对照，不构成任一窗口的优选结论。\n`;
  md += `- **同源不外推**：全部因子同源 getHistory 日K OHLCV，结论仅限该数据源。\n`;
  md += `- **市值缺失**：无逐日股本序列，log_market_cap 未参与（lib/taxonomy.js inCluster:false）。\n`;
  md += `- **预热损耗**：每窗口有效样本 = 各股（窗口−20）根，60 日窗口损耗占比最高（1/3），其估计最不稳。\n`;
  md += `- **重叠窗口自相关**：因子基于重叠滑动窗口，名义样本量高于有效样本量；**不做显著性检验**，不推断统计显著或因果。\n`;
  md += `- **多窗口共线**：三窗口共用同一批原始日K（重叠区间高度重叠），跨窗口差异不能当独立证据。\n`;
  const r60 = results[0];
  md += `- **短窗口样本口径与不可直比**：60 窗口有效样本 ${r60.validSamples} = ${symbols.length} 只 × ${r60.validSamples / symbols.length} 有效点（窗口 ${r60.days} 根 − 20 根预热，预热损耗 ${r60.days - (r60.validSamples / symbols.length)} 根/只）；重叠窗口自相关更强，**高相关对数与最弱边不可与 250 窗口直接比较，结论不外推**。\n`;
  md += `- **降级源影响（不写「无影响」）**：本轮数据源若为降级源（新浪/东财兜底），其量纲/缺失模式可能影响 vol_ratio、mom_20d 等因子的相关强度（新浪日K此前修过 100 倍量纲错位，P2-1）；**跨日对照需固定数据源或标注源差异**。\n\n`;
  md += `## Backlog\n\n`;
  md += `- [x] 多窗口对照（60/120/250）验证相关结构稳健性（本报告）。\n`;
  md += `- [ ] 业务解读人工填充（复核后删「AI 生成，待人工复核」标注，报告转「可归档」）。\n`;
  return md;
}

/** 解析历史单窗口报告（docs/logic/factor-corr-<asOfYYYYMMDD>.md）的簇内平均/最弱边，供 1.1 节对照；不存在或格式不符返回 null。 */
function parseHistoricalSingleWindow(asOf) {
  try {
    const p = path.join(ROOT, 'docs', 'logic', `factor-corr-${asOf.replace(/-/g, '')}.md`);
    if (!fs.existsSync(p)) return null;
    const txt = fs.readFileSync(p, 'utf8');
    const avg = txt.match(/簇内平均 \|Pearson\|：([0-9.]+)/);
    const minE = txt.match(/簇内最小 \|Pearson\|（最弱边）：([0-9.]+)/);
    if (!avg || !minE) return null;
    return { asOf, avgAbs: parseFloat(avg[1]), minEdge: parseFloat(minE[1]), path: p };
  } catch (e) { return null; }
}

async function mainWindows() {
  const asOf = FORCED_ASOF || asOfTradingDate();
  const windows = parseWindowsArg() || WINDOWS_DEF;
  const outArg = parseOutArg();
  const watchlist = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'watchlist.json'), 'utf8'));
  const symbols = watchlist.map(w => w.symbol);

  console.log(`[P2-3 windows] asOf=${asOf} · 自选股 ${symbols.length} 只 · 窗口 ${windows.join('/')} · 阈值 |corr|>${MIN_ABS_CORR}`);

  // 取数一次，三窗口共用（截断至 asOf 后传纯函数）；逐股记录实际服务源（降级如实标注）
  const histories = [];
  const fetchNotes = [];
  for (const sym of symbols) {
    const hist = await sd.getHistory(sym, '1y');
    if (!Array.isArray(hist) || hist.length === 0) { console.warn(`  [跳过] ${sym} getHistory 空`); continue; }
    const trunc = truncateToAsOf(hist, asOf); // N6（2026-11-13）：纯函数内已统一保留 .meta，不再需要手动补挂
    const lastDate = trunc.length ? trunc[trunc.length - 1].date : null;
    if (lastDate !== asOf) console.warn(`  [${sym}] 最后一根 ${lastDate} < asOf ${asOf}（数据滞后）`);
    histories.push({ symbol: sym, bars: trunc });
    fetchNotes.push({ symbol: sym, source: (trunc.meta && trunc.meta.source) || '未知', lastDate });
  }
  if (histories.length === 0) throw new Error('全部标的 getHistory 为空，无法分析');

  const results = analyzeWindowsCore({ histories, windows, minAbs: MIN_ABS_CORR });
  const md = buildWindowsReport({ asOf, symbols, results, minAbs: MIN_ABS_CORR, fetchNotes, histRef: parseHistoricalSingleWindow(asOf) });
  const outPath = outArg || path.join(ROOT, 'docs', 'logic', `factor-corr-windows-${asOf.replace(/-/g, '')}.md`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`[P2-3 windows] 报告已写出: ${outPath}`);
  for (const r of results) console.log(`  窗口 ${r.days}: 有效样本=${r.validSamples} · 簇=${r.clusters.length} · 平均|P|=${fmt(r.avgAbsAll)}${r.insufficient ? ' · ⚠️ 样本不足，不结论' : ''}`);
  return outPath;
}

module.exports = { spearman, pearson, rankAverageTies, truncateToAsOf, computeFactors, cluster, FACTORS, FACTOR_KEYS, analyzeWindowsCore, buildWindowsReport, parseHistoricalSingleWindow, WINDOWS_DEF, INSUFFICIENT_SAMPLES, buildReport, BIZ_PLACEHOLDER, extractBusinessBlocks, preserveBusinessBlocks, REVIEW_SECTION_HEAD, REVIEW_PLACEHOLDER, extractReviewNotesBlock };
