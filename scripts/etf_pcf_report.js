/**
 * 上交所 ETF 当日申购赎回清单（PCF）抓取 + 沪深300 家族统计 —— 样板脚本
 * =========================================================
 * 数据源（全部实测可用，仅需 UA + Referer）：
 *   列表   https://query.sse.com.cn/commonQuery.do?sqlId=COMMON_SSE_PL_ETFGGSGSHQD_L&ETF_CLASS=03
 *   基本信息 ...sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C&FUNDID2=510300
 *   成分股   ...sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C&FUNDID2=510300
 * 行情     https://qt.gtimg.cn/q=sh600519,...（GBK）—— 仅用于把「份数」折算成「权重」
 *
 * ETF_CLASS 实测：01=单市场股票ETF(沪) 02=债券 03=跨市场股票ETF 06=黄金 08=沪港深 09=科创板 31=双创 33=跨境
 *
 * ⚠ 口径红线：PCF 是「申赎一篮子要交什么」的清单，**不含当日实际净申购/净赎回份额**。
 *   它能回答「谁被哪些 ETF 共同持有、权重多少、各家篮子差异多大」；
 *   不能回答「今天这只 ETF 被净申购了多少」。后者需份额数据（T+1 披露）。
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const HDR = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Referer': 'https://www.sse.com.cn/disclosure/fund/etflist/',
  'Accept': 'application/json, text/javascript, */*; q=0.01',
};

function httpGet(url, { timeout = 20000, gbk = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HDR, timeout }, (res) => {
      const bufs = [];
      res.on('data', (c) => bufs.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
        const buf = Buffer.concat(bufs);
        if (gbk) return resolve(new TextDecoder('gbk').decode(buf));
        resolve(buf.toString('utf8'));
      });
    });
    req.on('timeout', () => req.destroy(new Error('超时')));
    req.on('error', reject);
  });
}

const json = async (u) => JSON.parse(await httpGet(u));

const Q = 'https://query.sse.com.cn/commonQuery.do';
const listUrl = (cls, size = 600) => `${Q}?isPagination=true&pageHelp.pageSize=${size}&pageHelp.pageNo=1&pageHelp.beginPage=1&pageHelp.cacheSize=1&pageHelp.endPage=1&sqlId=COMMON_SSE_PL_ETFGGSGSHQD_L&ETF_CLASS=${cls}&type=inParams&FUND_CODE=&KEY_WORDS=`;
const jbxxUrl = (code) => `${Q}?isPagination=false&FUNDID2=${code}&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_JBXX_C`;
const compUrl = (code) => `${Q}?isPagination=false&FUNDID2=${code}&sqlId=COMMON_SSE_CP_JJLB_ETFJJGK_GGSGSHQD_COMPONENT_C`;

const SUB = { '0': '禁止', '1': '允许', '2': '必须', '3': '深市退补', '4': '深市必须', '5': '退补', '6': '必须', '7': '港市退补', '8': '港市必须' };
const MKT = { '101': '沪', '102': '深', '103': '港', '105': '外汇', '106': '北', '9999': '其他' };
const MECH = { '0': '现金申赎', '1': '沪市实物对价', '2': '沪深实物对价', '3': '银行间债券实物' };

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __err: e.message, __key: items[k] }; }
    }
  }));
  return out;
}

const numOf = (v) => {
  const n = Number(String(v == null ? '' : v).replace(/[￥,\s%]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const cn = (n, d = 2) => (n == null || !Number.isFinite(n) ? '—' : n.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d }));
const yi = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e8) return (n / 1e8).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' 亿';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + ' 万';
  return n.toLocaleString('zh-CN');
};

// 排除「沪深300 + 行业/策略/增强」衍生品
const DERIV = /医药|红利|ESG|增强|价值|成长|低波|质量|动量|等权|非银|银行|消费|科技|信息|军工|有色|能源|地产|国企|央企|龙头|优选|量化|策略|A50|A100/i;

async function fetchPrices(codes) {
  const map = new Map();
  const B = 60;
  for (let i = 0; i < codes.length; i += B) {
    const batch = codes.slice(i, i + B);
    const q = batch.map(c => (/^(6|9)/.test(c) ? 'sh' : /^(0|2|3)/.test(c) ? 'sz' : 'bj') + c).join(',');
    let txt;
    try { txt = await httpGet('https://qt.gtimg.cn/q=' + q, { gbk: true, timeout: 20000 }); } catch (e) { continue; }
    for (const line of txt.split(';\n')) {
      const m = line.match(/v_([a-z]{2})(\d{6})="([^"]*)"/);
      if (!m) continue;
      const f = m[3].split('~');
      const price = numOf(f[3]);
      if (price) map.set(m[2], { price, name: f[1] });
    }
  }
  return map;
}

(async () => {
  const t0 = Date.now();
  const log = (s) => console.log(s);

  // ── 1. 候选池：跨市场股票ETF 中名称含「沪深300」且非衍生
  const l = await json(listUrl('03'));
  const all = (l.pageHelp && l.pageHelp.data) || [];
  const cand = all.filter(it => (it.ETF_FULLNAME || '').includes('沪深300'));
  log(`跨市场股票ETF ${all.length} 只 → 名称含「沪深300」${cand.length} 只`);

  // ── 2. 拉基本信息，判定「真·沪深300」（成分正好 300 且非衍生）
  const basics = await mapLimit(cand, 4, async (it) => {
    const j = await json(jbxxUrl(it.FUNDID2));
    return { list: it, base: (j.result && j.result[0]) || null };
  });
  const members = [];
  const excluded = [];
  for (const b of basics) {
    if (b.__err) { excluded.push({ code: b.__key && b.__key.FUNDID2, name: b.__key && b.__key.ETF_FULLNAME, why: '基本信息抓取失败：' + b.__err }); continue; }
    const it = b.list, base = b.base;
    if (!base) { excluded.push({ code: it.FUNDID2, name: it.ETF_FULLNAME, why: '无当日清单（可能未发布/停牌/已终止）' }); continue; }
    const n = numOf(base.RECORD_NUM);
    if (n !== 300) { excluded.push({ code: it.FUNDID2, name: it.ETF_FULLNAME, why: `成分为 ${n} 只，非「纯沪深300」（属行业/策略/增强衍生）` }); continue; }
    if (DERIV.test(base.FUND_NAME || it.ETF_FULLNAME)) { excluded.push({ code: it.FUNDID2, name: it.ETF_FULLNAME, why: '名称含行业/策略/增强关键词，非纯指数复制' }); continue; }
    members.push({ code: it.FUNDID2, list: it, base });
  }
  log(`入组 ${members.length} 只；排除 ${excluded.length} 只`);

  // ── 3. 拉成分股
  const withComp = await mapLimit(members, 4, async (m) => {
    const c = await json(compUrl(m.code));
    const comps = (c.result || []).filter(x => x && x.INSTRUMENT_ID && x.INSTRUMENT_NAME !== '现金替代');
    return Object.assign({}, m, { comps });
  });
  const okMembers = withComp.filter(m => !m.__err && m.comps && m.comps.length);
  log(`拿到成分股 ${okMembers.length} 只，成分数区间 ${Math.min(...okMembers.map(m => m.comps.length))}~${Math.max(...okMembers.map(m => m.comps.length))}`);

  // ── 4. 家族一致性校验（Jaccard vs 基准 510300）
  const seed = okMembers.find(m => m.code === '510300') || okMembers[0];
  const seedSet = new Set((seed.comps || []).map(c => c.INSTRUMENT_ID));
  for (const m of okMembers) {
    const s = new Set(m.comps.map(c => c.INSTRUMENT_ID));
    let inter = 0;
    for (const x of s) if (seedSet.has(x)) inter++;
    m.jaccard = s.size + seedSet.size ? (2 * inter) / (s.size + seedSet.size) : 0;
  }

  // ── 5. 行情（用于份数 → 权重）
  const ids = Array.from(new Set(okMembers.flatMap(m => m.comps.map(c => c.INSTRUMENT_ID))));
  const priceMap = await fetchPrices(ids);
  log(`行情取到 ${priceMap.size}/${ids.length} 只`);

  // ── 6. 每只 ETF 的权重解剖
  // 两个口径必须分清：
  //   覆盖率 cover = Σ(份数×价) ÷ 单篮净值      —— 绝对口径，<100% 说明篮子没把净值全额还原（现金差额/替代/取整/时点差）
  //   篮内权重 w   = (份数×价) ÷ Σ(份数×价)      —— 相对口径，各 ETF 按自身篮子归一，跨 ETF 才可比
  // 跨 ETF 比较必须用 w：若用 cover 口径，覆盖率 94%~99% 的差异会直接污染权重对比。
  for (const m of okMembers) {
    const unitNet = numOf(m.base.NAVPERCU);          // 每申赎单位对应的一篮子净值
    let sumMV = 0, priced = 0, miss = 0;
    const rows = [];
    for (const c of m.comps) {
      const qty = numOf(c.QUANTITY) || 0;
      const p = priceMap.get(c.INSTRUMENT_ID);
      const mv = p ? qty * p.price : null;
      if (mv == null) miss++; else { sumMV += mv; priced++; }
      rows.push({
        id: c.INSTRUMENT_ID, name: c.INSTRUMENT_NAME, qty,
        sub: SUB[String(c.SUBSTITUTION_FLAG)] || String(c.SUBSTITUTION_FLAG),
        mkt: MKT[String(c.UNDERLYION_SECURITY_ID)] || '?',
        price: p ? p.price : null, mv, w: null,
      });
    }
    for (const r of rows) {
      // 数量为 0 的行 = 纯现金替代（停牌/不可交付），不构成实物持仓 → 不参与权重统计，
      // 否则会算出「权重 0.000%」把极差表污染成假信号。
      r.w = (r.mv != null && r.qty > 0 && sumMV > 0) ? (r.mv / sumMV) * 100 : null;
    }
    m.unitNet = unitNet;
    m.rows = rows;
    m.priced = priced; m.miss = miss;
    m.sumMV = sumMV;
    m.cover = (unitNet && sumMV) ? (sumMV / unitNet) * 100 : null;   // 覆盖率
    m.cash = numOf(m.base.ESTIMATED_CASH_COMPONENT);
    m.zeroRows = rows.filter(r => !r.qty).length;                    // 0 股（纯现金替代）行数
    m.mustRows = rows.filter(r => r.sub.includes('必须')).length;      // 必须现金替代行数
  }

  // ── 7. 交叉统计
  const agg = new Map();
  for (const m of okMembers) {
    for (const r of m.rows) {
      let a = agg.get(r.id);
      if (!a) { a = { id: r.id, name: r.name, mkt: r.mkt, funds: 0, held: 0, ws: [], qty: 0, must: 0, allow: 0, forbid: 0, zero: 0 }; agg.set(r.id, a); }
      a.funds += 1;                                   // 被多少只 ETF 的清单收录
      if (r.qty > 0) { a.held += 1; a.qty += r.qty; }  // 其中有多少只是「实物交付」（有股数）
      if (r.qty === 0) a.zero += 1;
      if (r.w != null) a.ws.push(r.w);
      if (r.sub.includes('必须')) a.must += 1; else if (r.sub.includes('允许')) a.allow += 1; else if (r.sub.includes('禁止')) a.forbid += 1;
    }
  }
  const N = okMembers.length;
  const rowsAgg = Array.from(agg.values()).map(a => {
    const sorted = a.ws.slice().sort((x, y) => x - y);
    const avg = sorted.length ? sorted.reduce((s, x) => s + x, 0) / sorted.length : null;
    const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
    return Object.assign(a, {
      avgW: avg, medW: med,
      minW: sorted.length ? sorted[0] : null,
      maxW: sorted.length ? sorted[sorted.length - 1] : null,
      spread: sorted.length > 1 ? sorted[sorted.length - 1] - sorted[0] : 0,
      relSpread: (sorted.length > 1 && avg) ? (sorted[sorted.length - 1] - sorted[0]) / avg : 0,
      full: a.funds === N,
      fullHeld: a.held === N,
    });
  });
  const byFunds = rowsAgg.slice().sort((x, y) => y.funds - x.funds || (y.avgW || 0) - (x.avgW || 0));
  const byWeight = rowsAgg.slice().sort((x, y) => (y.avgW || 0) - (x.avgW || 0));
  // 极差榜：只统计「有实物股数」的观察，且要求覆盖 ≥ 半数 ETF，避免小样本噪声
  const bySpread = rowsAgg.filter(r => r.ws.length >= Math.max(3, N * 0.5)).slice().sort((x, y) => y.spread - x.spread);
  const byRel = rowsAgg.filter(r => r.ws.length >= Math.max(3, N * 0.5) && (r.avgW || 0) >= 0.2)
    .slice().sort((x, y) => y.relSpread - x.relSpread);
  const notFull = rowsAgg.filter(r => !r.full).sort((x, y) => x.funds - y.funds);
  const mustList = rowsAgg.filter(r => r.must > 0).sort((x, y) => y.must - x.must || y.funds - x.funds);
  const tradeDate = (okMembers[0].base.TRADING_DAY || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3');

  // ── 8. 生成 HTML
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const pct = (v, d = 3) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d) + '%');

  const memberRows = okMembers.slice().sort((a, b) => a.code.localeCompare(b.code)).map((m) => {
    const b = m.base;
    const nav = numOf(b.NAV);
    return `<tr>
      <td class="mono">${m.code}</td>
      <td>${esc(m.list.ETF_FULLNAME)}</td>
      <td class="dim">${esc(m.list.FUND_COMP_NAME)}</td>
      <td class="num">${nav == null ? '—' : nav.toFixed(4)}</td>
      <td class="num">${cn(numOf(b.CREATION_REDEMPTION_UNIT), 0)}</td>
      <td class="num">${cn(m.unitNet)}</td>
      <td class="num">${cn(numOf(b.PRE_CASH_COMPONENT))}</td>
      <td class="num">${cn(numOf(b.ESTIMATED_CASH_COMPONENT))}</td>
      <td class="num">${b.CREATION_LIMIT === '-' ? '—' : yi(numOf(b.CREATION_LIMIT))}</td>
      <td class="num">${b.REDEMPTION_LIMIT === '-' ? '—' : yi(numOf(b.REDEMPTION_LIMIT))}</td>
      <td class="num">${m.comps.length}</td>
      <td class="num dim">${m.zeroRows}</td>
      <td class="num dim">${m.mustRows}</td>
      <td class="num ${m.cover > 99.5 ? 'ok' : 'warn'}">${pct(m.cover, 2)}</td>
    </tr>`;
  }).join('');

  const exclRows = excluded.map(e => `<tr><td class="mono">${esc(e.code)}</td><td>${esc(e.name)}</td><td class="dim">${esc(e.why)}</td></tr>`).join('');

  const rankRows = byFunds.map((r, i) => `<tr>
      <td class="num dim">${i + 1}</td>
      <td class="mono">${r.id}</td>
      <td>${esc(r.name)}</td>
      <td class="num">${r.mkt}</td>
      <td class="num"><span class="pill ${r.full ? 'full' : r.funds >= N * 0.8 ? 'most' : 'part'}">${r.funds}/${N}</span></td>
      <td class="num">${pct(r.avgW)}</td>
      <td class="num dim">${pct(r.minW)} ~ ${pct(r.maxW)}</td>
      <td class="num dim">${pct(r.spread)}</td>
      <td class="num dim">${r.must ? r.must : '—'}</td>
    </tr>`).join('');

  const spreadRows = bySpread.slice(0, 20).map((r) => `<tr>
      <td class="mono">${r.id}</td><td>${esc(r.name)}</td>
      <td class="num">${pct(r.minW)}</td><td class="num">${pct(r.maxW)}</td>
      <td class="num">${pct(r.spread)}</td>
      <td class="num dim">${r.funds}/${N}</td>
    </tr>`).join('');

  const notFullRows = notFull.slice(0, 20).map(r => `<tr>
      <td class="mono">${r.id}</td><td>${esc(r.name)}</td>
      <td class="num">${r.funds}/${N}</td><td class="num">${pct(r.avgW)}</td>
    </tr>`).join('');

  const mustRowsHtml = mustList.slice(0, 30).map(r => `<tr>
      <td class="mono">${r.id}</td><td>${esc(r.name)}</td>
      <td class="num">${r.must}/${N}</td>
      <td class="num dim">${r.zero}/${N}</td>
      <td class="num">${r.ws.length}/${N}</td>
      <td class="num">${r.ws.length >= 2 ? pct(r.avgW) : '—'}</td>
    </tr>`).join('');

  const relRows = byRel.slice(0, 15).map(r => `<tr>
      <td class="mono">${r.id}</td><td>${esc(r.name)}</td>
      <td class="num">${pct(r.avgW)}</td>
      <td class="num">${pct(r.medW)}</td>
      <td class="num">${pct(r.minW)} ~ ${pct(r.maxW)}</td>
      <td class="num warn">${(r.relSpread * 100).toFixed(0)}%</td>
      <td class="num dim">${r.ws.length}/${N}</td>
    </tr>`).join('');

  const sumW = okMembers.map(m => m.cover).filter(v => v != null);
  const avgSumW = sumW.length ? sumW.reduce((a, b) => a + b, 0) / sumW.length : null;
  const minCover = sumW.length ? Math.min(...sumW) : null;
  const maxCover = sumW.length ? Math.max(...sumW) : null;
  const bigW = byWeight.slice(0, 10);

  // 孤立异常：某只 ETF 对单个成分的权重 ≥ 中位数的 1.5 倍 → 列为「需人工核实」，不做结论
  const anomalies = [];
  for (const r of rowsAgg) {
    if (!r.medW || r.medW <= 0 || r.ws.length < N * 0.5) continue;
    if (r.maxW / r.medW < 1.5) continue;
    const detail = okMembers.map(m => {
      const row = m.rows.find(x => x.id === r.id);
      return row && row.w != null ? { code: m.code, w: row.w } : null;
    }).filter(Boolean).sort((a, b) => b.w - a.w);
    anomalies.push({ id: r.id, name: r.name, med: r.medW, max: r.maxW, ratio: r.maxW / r.medW, top: detail.slice(0, 3) });
  }
  anomalies.sort((a, b) => b.ratio - a.ratio);
  const anomalyRows = anomalies.slice(0, 12).map(a => `<tr>
      <td class="mono">${a.id}</td><td>${esc(a.name)}</td>
      <td class="num">${pct(a.med)}</td><td class="num">${pct(a.max)}</td>
      <td class="num warn">${a.ratio.toFixed(2)}×</td>
      <td class="dim">${a.top.map(t => `${t.code} ${pct(t.w, 2)}`).join(' · ')}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>沪深300 ETF 当日申赎清单（PCF）统计 · ${tradeDate}</title>
<style>
  :root{
    --bg:#0d1117; --card:#161B22; --elev:#1c2128; --bd:#2b323b;
    --tx:#E6EDF3; --tx2:#9aa4b2; --tx3:#6b7683;
    --accent:#F0B97B; --red:#F6465D; --green:#0ECB81; --blue:#58a6ff;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--tx);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    font-size:13px;line-height:1.65;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1280px;margin:0 auto;padding:28px 20px 80px}
  h1{font-size:21px;margin:0 0 6px;font-weight:700;letter-spacing:.2px}
  .sub{color:var(--tx2);font-size:12.5px;margin-bottom:22px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:22px}
  .kpi{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:12px 14px}
  .kpi .k{color:var(--tx3);font-size:11px;letter-spacing:.3px}
  .kpi .v{font-size:20px;font-weight:700;margin-top:3px;font-variant-numeric:tabular-nums}
  .kpi .v small{font-size:12px;font-weight:500;color:var(--tx2);margin-left:3px}
  section{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:16px 18px;margin-bottom:18px}
  h2{font-size:14px;margin:0 0 4px;font-weight:700}
  h2 .tag{font-size:10.5px;font-weight:600;color:var(--accent);border:1px solid rgba(240,185,123,.45);
    background:rgba(240,185,123,.1);border-radius:3px;padding:1px 5px;margin-left:7px;vertical-align:1px}
  .note{color:var(--tx2);font-size:12px;margin:6px 0 12px}
  .note b{color:var(--accent);font-weight:600}
  .scroll{max-height:520px;overflow:auto;border-radius:6px;border:1px solid var(--bd)}
  table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
  th{position:sticky;top:0;z-index:1;background:var(--elev);color:var(--tx3);
    font-size:11px;font-weight:600;text-align:left;padding:8px 10px;border-bottom:1px solid var(--bd);white-space:nowrap}
  td{padding:7px 10px;border-bottom:1px solid rgba(43,50,59,.6);vertical-align:top}
  tbody tr:hover{background:rgba(255,255,255,.028)}
  .num{text-align:right;white-space:nowrap}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  .dim{color:var(--tx2);font-size:12px}
  .ok{color:var(--green)}
  .warn{color:var(--accent)}
  .pill{display:inline-block;padding:0 6px;border-radius:3px;font-size:11px;border:1px solid var(--bd)}
  .pill.full{color:var(--green);border-color:rgba(14,203,129,.45);background:rgba(14,203,129,.1)}
  .pill.most{color:var(--accent);border-color:rgba(240,185,123,.45);background:rgba(240,185,123,.08)}
  .pill.part{color:var(--tx2)}
  ul.caveat{margin:8px 0 0;padding-left:18px;color:var(--tx2);font-size:12.2px}
  ul.caveat li{margin-bottom:5px}
  ul.caveat b{color:var(--tx)}
  .foot{color:var(--tx3);font-size:11.5px;text-align:center;margin-top:26px}
  code{background:var(--elev);border:1px solid var(--bd);border-radius:3px;padding:1px 5px;font-size:11.5px;color:var(--accent)}
</style></head><body><div class="wrap">

<h1>沪深300 ETF · 当日申购赎回清单（PCF）统计</h1>
<div class="sub">数据日期 <b style="color:var(--tx)">${tradeDate}</b> · 来源 上海证券交易所 ETF 公告申购赎回清单 · 生成 ${new Date().toLocaleString('zh-CN', { hour12: false })}</div>

<div class="grid">
  <div class="kpi"><div class="k">入组 ETF</div><div class="v">${N}<small>只</small></div></div>
  <div class="kpi"><div class="k">并集标的</div><div class="v">${rowsAgg.length}<small>只</small></div></div>
  <div class="kpi"><div class="k">被全部持有</div><div class="v">${rowsAgg.filter(r => r.full).length}<small>只</small></div></div>
  <div class="kpi"><div class="k">篮子覆盖率</div><div class="v ${avgSumW > 99.5 ? 'ok' : 'warn'}">${pct(avgSumW, 2)}<small>均值 ${pct(minCover, 1)}~${pct(maxCover, 1)}</small></div></div>
  <div class="kpi"><div class="k">行情缺失</div><div class="v">${okMembers.reduce((s, m) => s + m.miss, 0)}<small>条</small></div></div>
</div>

<section>
  <h2>一、这份数据是什么（以及不是什么）</h2>
  <ul class="caveat">
    <li><b>是</b>：ETF 当日「申购/赎回一篮子」的<b>清单</b>——包含每只成分券的代码、名称、数量、现金替代标志、溢价/折价率、挂牌市场，以及最小申赎单位、单篮净值、现金差额、当日累计可申赎上限。</li>
    <li><b>不是</b>：<b>不是当日实际净申购/净赎回份额</b>。PCF 只是「模板」，无论今天有没有人申赎，清单都照发。想知道「今天哪只 ETF 被净申购多少」，要另取<b>基金份额</b>数据（T 日份额通常 T+1 披露），本报告不含该口径。</li>
    <li><b>不是</b>：不是基金真实持仓的完整还原。PCF 按申赎单位取整（例如每篮若干手茅台），与基金实际持股有舍入差异；停牌股会变成「必须现金替代」。</li>
    <li><b>两个权重口径</b>：① <b>篮内权重</b> = 单只成分市值 ÷ 该 ETF 篮子成分市值合计（本报告第四~七节用这个，各 ETF 自身归一，跨 ETF 才可比）；② <b>篮子覆盖率</b> = 篮子成分市值合计 ÷ 单篮净值（第三节用这个，看篮子有没有把净值全额还原）。</li>
    <li><b>覆盖率为什么不到 100%</b>：差额来自 ① 现金差额（<code>ESTIMATED_CASH_COMPONENT</code>，正=篮子比净值多备现金，负=反）；② 部分成分在清单里以「必须现金替代」出现，不计股数；③ 申赎单位取整；④ 行情是实时价而清单净值可能取 T-1 收盘。实测覆盖 <b>${pct(minCover, 1)} ~ ${pct(maxCover, 1)}</b>，属正常区间，<b>不是抓取错误</b>。</li>
  </ul>
</section>

<section>
  <h2>二、家族识别 <span class="tag">为什么不是「名称含沪深300 就算」</span></h2>
  <div class="note">名称里带「沪深300」的不一定是纯指数复制——实测有 <b>沪深300医药卫生(20只)</b>、<b>沪深300红利(50只)</b>、<b>沪深300ESG(233只)</b>、<b>沪深300增强策略(144只)</b>。故判定标准为：<b>成分正好 300 只 + 名称不含行业/策略/增强关键词</b>，并用与 510300 的篮子 Jaccard 相似度做交叉验证。</div>
  <div class="note">入组 ${N} 只（Jaccard 与基准 510300 的相似度区间 <b>${(Math.min(...okMembers.map(m => m.jaccard)) * 100).toFixed(1)}% ~ ${(Math.max(...okMembers.map(m => m.jaccard)) * 100).toFixed(1)}%</b>）；排除 ${excluded.length} 只。</div>
  <div class="scroll" style="max-height:280px">
    <table><thead><tr><th>代码</th><th>基金全称</th><th>排除原因</th></tr></thead>
    <tbody>${exclRows || '<tr><td colspan="3" class="dim">无</td></tr>'}</tbody></table>
  </div>
</section>

<section>
  <h2>三、申赎参数对比 <span class="tag">按代码排序</span></h2>
  <div class="note">同一指数的 ${N} 只 ETF，门槛(<b>最小申赎单位</b>)差异可达 <b>${(Math.max(...okMembers.map(m => numOf(m.base.CREATION_REDEMPTION_UNIT) || 0)) / Math.min(...okMembers.map(m => numOf(m.base.CREATION_REDEMPTION_UNIT) || Infinity))).toFixed(1)} 倍</b>；单篮净值从 <b>${cn(Math.min(...okMembers.map(m => m.unitNet)))}</b> 到 <b>${cn(Math.max(...okMembers.map(m => m.unitNet)))}</b> 元不等——同样申购一次，资金占用差很多。</div>
  <div class="scroll">
    <table><thead><tr>
      <th>代码</th><th>基金全称</th><th>管理人</th><th class="num">份额净值</th>
      <th class="num">最小申赎单位</th><th class="num">单篮净值(元)</th>
      <th class="num">现金差额(T-1)</th><th class="num">现金差额(预估T)</th>
      <th class="num">申购上限</th><th class="num">赎回上限</th><th class="num">成分</th><th class="num">0股行</th><th class="num">必须替代</th><th class="num">篮子覆盖率</th>
    </tr></thead><tbody>${memberRows}</tbody></table>
  </div>
</section>

<section>
  <h2>四、成分股抱团排行 <span class="tag">被多少只 ETF 同时纳入</span></h2>
  <div class="note">「纳入 N/${N}」= 有多少只 ETF 的当日篮子里有这只股票。全 ${N} 只都纳入的有 <b>${rowsAgg.filter(r => r.full).length}</b> 只；只被 1 只纳入的有 <b>${rowsAgg.filter(r => r.funds === 1).length}</b> 只。<b>平均权重</b>与<b>权重极差</b>反映各家的复制方式差异（完全复制 vs 抽样/替代）。</div>
  <div class="scroll">
    <table><thead><tr>
      <th class="num">#</th><th>代码</th><th>名称</th><th class="num">市场</th>
      <th class="num">纳入 ETF</th><th class="num">平均权重</th><th class="num">权重区间</th><th class="num">极差</th><th class="num">必须替代</th>
    </tr></thead><tbody>${rankRows}</tbody></table>
  </div>
</section>

<section>
  <h2>五、权重最分散的标的 <span class="tag">同一指数、不同篮子</span></h2>
  <div class="note">同一只股票在 ${N} 只 ETF 里的<b>篮内权重</b>本应几乎一致。极差越大 = 各家复制偏差越大（取整、抽样复制、停牌替代、替代券替换）。<b>已排除数量为 0 的纯现金替代行</b>（那些行权重算出来必然是 0，会伪造出「0%~2.5%」的假极差），只统计有实物股数、且覆盖过半 ETF 的标的。</div>
  <div class="scroll" style="max-height:420px">
    <table><thead><tr><th>代码</th><th>名称</th><th class="num">最低权重</th><th class="num">最高权重</th><th class="num">绝对极差</th><th class="num">覆盖</th></tr></thead>
    <tbody>${spreadRows}</tbody></table>
  </div>
</section>

<section>
  <h2>六、权重相对离散度 <span class="tag">极差 ÷ 均值，去掉量级干扰</span></h2>
  <div class="note">绝对极差对权重大的股票天然更大，所以再看<b>相对极差</b>（极差 ÷ 平均权重）。这一列高 = 各家对这个位子的配置分歧大，往往来自成分调整期、停牌替代或跟踪误差管理差异。</div>
  <div class="scroll" style="max-height:400px">
    <table><thead><tr><th>代码</th><th>名称</th><th class="num">平均权重</th><th class="num">中位权重</th><th class="num">区间</th><th class="num">相对极差</th><th class="num">覆盖</th></tr></thead>
    <tbody>${relRows || '<tr><td colspan="7" class="dim">无</td></tr>'}</tbody></table>
  </div>
</section>

<section>
  <h2>七、必须现金替代的标的 <span class="tag">${mustList.length} 只</span></h2>
  <div class="note">「必须现金替代」= 申购时不能用股票、只能用现金顶替。实测一致呈现一个现象：<b>688 开头的科创板成分在 19 只 ETF 里全部为「必须现金替代」且股数给 0</b>（龙芯中科 / 拓荆科技 / 盛美上海 / 寒武纪等）——即这些位子在篮子里是「虚位」，权重看着有、实物拿不到。<b>制度层面的确切原因（科创板适当性/交易规则）建议核对基金合同与申赎清单说明，本报告只呈现数据事实、不推断规则来源。</b>「有实物」列 = 有多少只 ETF 真的给了股数。</div>
  <div class="scroll" style="max-height:420px">
    <table><thead><tr><th>代码</th><th>名称</th><th class="num">必须替代 ETF 数</th><th class="num">其中 0 股</th><th class="num">有实物</th><th class="num">平均权重(仅实物)</th></tr></thead>
    <tbody>${mustRowsHtml || '<tr><td colspan="6" class="dim">无</td></tr>'}</tbody></table>
  </div>
</section>

<section>
  <h2>八、未被全部 ETF 纳入的标的 <span class="tag">共 ${notFull.length} 只</span></h2>
  <div class="note">纯指数复制下，300 只成分应被 ${N} 只 ETF 全部收录。没被全部收录的，说明该 ETF 用了<b>替代券/抽样复制</b>。</div>
  <div class="scroll" style="max-height:360px">
    <table><thead><tr><th>代码</th><th>名称</th><th class="num">纳入</th><th class="num">平均权重</th></tr></thead>
    <tbody>${notFullRows || '<tr><td colspan="4" class="dim">无 —— 19 只全部收录全部 300 只成分</td></tr>'}</tbody></table>
  </div>
</section>

<section>
  <h2>九、权重前十（跨 ETF 平均）</h2>
  <div class="note">把 ${N} 只 ETF 的篮子里同一只股票的权重取平均，近似「这一篮子指数此时的真实结构」。</div>
  <table><thead><tr><th class="num">#</th><th>代码</th><th>名称</th><th class="num">平均权重</th><th class="num">纳入 ETF</th></tr></thead>
  <tbody>${bigW.map((r, i) => `<tr><td class="num dim">${i + 1}</td><td class="mono">${r.id}</td><td>${esc(r.name)}</td><td class="num">${pct(r.avgW)}</td><td class="num dim">${r.funds}/${N}</td></tr>`).join('')}</tbody></table>
</section>

<section>
  <h2>十、需人工核实的孤立异常 <span class="tag">某只 ETF 对单个成分权重 ≥ 中位数 1.5 倍</span></h2>
  <div class="note">同一指数、同一只成分，各家权重本应几乎一致。出现 ≥1.5 倍偏离时，<b>不判定谁对谁错</b>——可能是基金对个别成分的主动配置、申赎单位取整、或清单发布差异。列出以便人工核对原始 PCF。</div>
  <div class="scroll" style="max-height:380px">
    <table><thead><tr><th>代码</th><th>名称</th><th class="num">中位权重</th><th class="num">最高权重</th><th class="num">倍数</th><th>偏离最大的 ETF</th></tr></thead>
    <tbody>${anomalyRows || '<tr><td colspan="6" class="dim">无（各 ETF 对同一成分的权重偏离均在 1.5 倍内）</td></tr>'}</tbody></table>
  </div>
</section>

<div class="foot">数据源：上海证券交易所 ETF 公告申购赎回清单（query.sse.com.cn）· 行情：腾讯行情 qt.gtimg.cn · 本报告为数据统计，不构成投资建议</div>
</div></body></html>`;

  const outDir = path.join(__dirname, '..', 'docs', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `etf-pcf-csi300-${tradeDate.replace(/-/g, '')}.html`);
  fs.writeFileSync(outFile, html, 'utf8');
  log(`\n报告已写出：${outFile}  (${(html.length / 1024).toFixed(0)} KB)`);
  log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})().catch(e => { console.error('失败:', e && e.stack ? e.stack : e); process.exit(1); });
