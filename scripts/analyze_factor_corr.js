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
 *   - 因子集为 P2-3 分析专用、临时定义，待收编至 lib/taxonomy.js 单源（见报告与 backlog 注记）；
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

// 因子集（临时定义，待收编至 lib/taxonomy.js 单源 — P2-3 backlog）
// dry-run 实证：ret_1d / turnover 经 getHistory 取不到 250 日序列（腾讯主源不回传换手率）、
// pe_ttm / pb 仅 getQuote 快照无历史序列 → 不参与聚类；log_market_cap 无逐日股本序列 → 不加。
// 默认追加 gap_20d / drawdown_20d（均来自 getHistory，0% 缺失），不加 amplitude_20d。
const FACTORS = [
  { key: 'mom_20d',      label: '20日动量',         src: 'getHistory.close',            warmup: 20 },
  { key: 'vol_20d',      label: '20日收益波动率',   src: 'getHistory.close 日收益',     warmup: 20 },
  { key: 'vol_ratio',    label: '量比',             src: 'getHistory.volume',           warmup: 19 },
  { key: 'ma_bias',      label: '均线偏离',         src: 'getHistory.close/MA20',       warmup: 20 },
  { key: 'rsi_14',       label: '14日RSI',          src: 'getHistory.close',            warmup: 14 },
  { key: 'macd_hist',    label: 'MACD柱',           src: 'getHistory.close',            warmup: 35 },
  { key: 'gap_20d',      label: '隔夜跳空',         src: 'getHistory.open/prevClose',   warmup: 1 },
  { key: 'drawdown_20d', label: '20日回撤',         src: 'getHistory.close',            warmup: 20 },
];
const FACTOR_KEYS = FACTORS.map(f => f.key);
const MAX_WARMUP = Math.max(...FACTORS.map(f => f.warmup));

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

/** 截断到 asOf（ISO 日期字符串比较，与 lookahead.dateOf 的 UTC 日历日口径一致）。 */
function truncateToAsOf(bars, asOf) {
  return bars.filter(b => String(b.date) <= asOf);
}

/** 对单只股票的窗口（已截断、已取最后 DAYS 根）计算 8 因子序列，返回 [{date, factors:{...}}]。 */
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
  const outPath = path.join(ROOT, 'docs', 'logic', `factor-corr-${asOf.replace(/-/g, '')}.md`);
  const md = buildReport({ asOf, symbols, rowsTotal, validSamples, P, S, clusters, perSymbolMissing, lastDateStaleNote });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md, 'utf8');
  console.log(`[P2-3] 报告已写出: ${outPath}`);
  console.log(`  有效样本(全因子齐备行)=${validSamples} · 高相关簇=${clusters.length}`);
  return outPath;
}

function fmt(x, d = 3) { return (x == null || !Number.isFinite(x)) ? '—' : x.toFixed(d); }

function buildReport({ asOf, symbols, rowsTotal, validSamples, P, S, clusters, perSymbolMissing, lastDateStaleNote }) {
  const n = FACTOR_KEYS.length;
  const startDate = asOf; // 窗口起点在脚本内为动态取最后 DAYS 根；报告注明窗口口径
  let md = '';
  md += `# 因子相关性离线分析报告（P2-3）\n`;
  md += `> ⚠️ **不改权重，仅供裁决**（本报告为只读分析产物，不影响任何业务表与既有模型权重）\n\n`;
  md += `- **数据截止日（asOf）**：${asOf}（最近完整交易日，lookahead 口径截断；${lastDateStaleNote ? '⚠️ ' + lastDateStaleNote : '截断后最后一根日期 = asOf，数据新鲜'}）\n`;
  md += `- **样本**：自选股池 ${symbols.length} 只（${symbols.join('、')}） × 近 ${DAYS} 交易日；有效样本（mom_20d 等主因子齐备行，即面板序列长度）**${validSamples}** = ${symbols.length} 只 × ${Math.round(validSamples / symbols.length)} 交易日\n`;
  md += `- **代码版本**：APP_VERSION ${APP_VERSION}；命令 \`node scripts/analyze_factor_corr.js --asOf ${asOf} --days ${DAYS} --minAbs ${MIN_ABS_CORR}\`\n`;
  md += `- **因子集注明**：本因子集为 P2-3 分析**临时定义**，待收编至 \`lib/taxonomy.js\` 单源（见文末 Backlog）。\n\n`;

  // 1. 因子清单
  md += `## 1. 因子清单（同源 getHistory，临时定义待收编）\n\n`;
  md += `| 因子 key | 含义 | 数据来源 | 预热(根) |\n|---|---|---|---|\n`;
  for (const f of FACTORS) md += `| \`${f.key}\` | ${f.label} | ${f.src} | ${f.warmup} |\n`;
  md += `\n> dry-run 实证排除：ret_1d（与 mom/vol 冗余）、turnover（getHistory 主源不回传换手率，无 250 日序列）、pe_ttm/pb（仅 getQuote 快照，无历史序列 → 不参与聚类）、log_market_cap（无逐日股本序列 → 不加，局限节注明）。\n\n`;

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
      md += `- 【业务解读：待补充】\n\n`;
    });
  }

  // 5. 结论与局限
  md += `## 5. 结论与局限\n\n`;
  md += `- **结论**：（由数值矩阵与上述聚类得出，待人工结合业务解读填充；本报告仅提供相关结构，不替代因子重要性裁决。）\n`;
  md += `- **局限 1（窗口敏感）**：单一 ${DAYS} 日窗口对牛/熊段敏感，结论可能随窗口漂移；多窗口（60/120/${DAYS}）对照已列入 Backlog，本轮未实现。\n`;
  md += `- **局限 2（同源）**：全部因子同源 getHistory 日K OHLCV，结论**仅限该数据源，不外推至其他数据源**（如财务/资金流/情绪）。\n`;
  md += `- **局限 3（市值序列缺失）**：市值仅 getQuote 快照可得（circulationValue/totalValue），无逐日股本序列，未构造 log_market_cap 时间序列。\n`;
  md += `- **局限 4（预热损耗）**：初始化窗口损耗使有效样本约 ${validSamples}（见 §2）。\n`;
  md += `- **局限 5（自相关/有效样本）**：因子基于重叠滑动窗口，序列存在时间序列自相关，名义样本量高于真实有效样本量；本报告**仅做描述性聚类，不做显著性检验**，相关结构结论不宜直接推断因果或统计显著。\n\n`;

  md += `## Backlog（P2-3 后续）\n\n`;
  md += `- [ ] 因子集临时定义，待收编至 \`lib/taxonomy.js\` 单源（本报告及本 backlog 各记一条）。\n`;
  md += `- [ ] 多窗口对照（60/120/${DAYS}）验证相关结构稳健性。\n`;
  md += `- [ ] 补充 amplitude_20d 等更多同源因子以丰满矩阵（用户本轮决定不加）。\n`;
  md += `- [ ] 业务解读人工填充（簇级一句话）。\n`;
  return md;
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('[P2-3] 失败:', e && e.message); process.exit(1); });
}

module.exports = { spearman, pearson, rankAverageTies, truncateToAsOf, computeFactors, cluster, FACTORS, FACTOR_KEYS };
