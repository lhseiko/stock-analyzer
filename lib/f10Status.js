'use strict';
/**
 * lib/f10Status.js
 * 个股上市状态 / 风险警示（ST）历史证据层 —— 供策略回测的「幸存者偏差」修正使用。
 *
 * 背景（为什么需要）：
 *   lib/backtestValidator.js 的幸存者偏差系数原本硬编码 0.9（经验折扣），
 *   属于"拍脑袋"倍率。本模块提供**可验证的确定性证据**替换它。
 *
 * 数据来源（实测于 2026-10-14）：
 *   东方财富 F10 基础信息 RPT_F10_BASIC_ORGINFO —— 可达，字段含
 *     LISTING_DATE : 上市日期（'2007-03-01 00:00:00'）
 *     FORMERNAME   : 曾用名链，以 '→' 分隔（如 '中国服装→S中服→*ST中服→中国服装→*ST中服→中国服装'）
 *     SECURITY_NAME_ABBR : 现用简称
 *
 * 已被实测证实**不可达**的接口（诚实记录，不做虚假降级）：
 *   - RPT_TERMINATED_LIST（退市名单）     → 业务错误 9501
 *   - push2 clist 风险警示板（s:2048）    → ECONNRESET
 *   - push2 stock/get 停牌标记（f292）    → ECONNRESET
 *   故 ST 判定只依据 FORMERNAME 历史链 + 当前简称；停牌/退市日**取不到就不编**。
 *
 * 设计原则（与项目一致）：
 *   1. 确定性：一切结论由代码按明文规则推导，LLM 不参与。
 *   2. 诚实性：数据取不到时返回 null + 明确 reason，绝不臆造。
 *   3. 缓存：F10 基础信息变动极低频，落盘缓存默认 7 天，避免每次回测都打外部接口。
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'f10-status');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

// ---------------------------------------------------------------------
//  纯函数：从 F10 原始字段推导状态（可单测，无 IO）
// ---------------------------------------------------------------------
/**
 * 判定风险警示历史。
 * 规则（明示，可审计）：
 *   - 名称含 '*ST'  → severe（退市风险警示）
 *   - 名称含 'ST'（不含 *ST）→ warn（其他风险警示）
 *   - 名称含 'S' 前缀（如 'S中服'、'S*ST'）→ 股改未完成标记，单独记录不计入 ST
 *   - 名称含 'N' 前缀（如 'N海天'）→ 上市首日标记，非风险警示，必须排除
 * @param {string} formerName 东财 FORMERNAME（'→' 分隔）
 * @param {string} currentName 当前简称
 * @returns {{stHistory:Array, sv:number, hasST:boolean, hasSevereST:boolean, severeCount:number, warnCount:number}}
 */
function parseRiskHistory(formerName, currentName) {
  const chain = [];
  if (currentName) chain.push(String(currentName).trim());
  if (formerName) {
    String(formerName).split('→').forEach(s => {
      const t = s.trim();
      if (t) chain.push(t);
    });
  }
  const stHistory = [];
  let severeCount = 0, warnCount = 0;
  for (const nm of chain) {
    // 先剔除 N（新股首日）/ C（上市次日）等非风险前缀的干扰：
    // 用「去掉前缀字母后是否仍含 ST」来判定，避免 'NSTxx' 这类误判
    const upper = nm.toUpperCase();
    const isSevere = upper.includes('*ST');
    // 含 ST 但不是 *ST；同时排除 'NST' 这种把 N 与 ST 连写的情况（东财未出现过，防御性处理）
    const isWarn = !isSevere && /(^|[^A-Z*])ST/.test(upper.replace(/^\*/, ''));
    if (isSevere) {
      severeCount++;
      stHistory.push({ name: nm, level: 'severe' });
    } else if (isWarn && !upper.startsWith('N')) {
      warnCount++;
      stHistory.push({ name: nm, level: 'warn' });
    }
  }
  const hadS = chain.some(nm => /^S[^A-Z]|^S\*ST|^SST/i.test(nm)) || chain.some(nm => /^S\*?ST/i.test(nm));
  // sv（survivorship 证据分）：有风险警示历史的个股，其"活下来"本身带幸存者属性，
  // 折扣应更保守。规则明示：无任何 ST 历史 → 1.0（无需折扣）；ST 历史 → 按次数递减。
  let sv = 1.0;
  if (severeCount > 0 || warnCount > 0) {
    const total = severeCount + warnCount;
    sv = Math.max(0.60, 0.90 - 0.05 * (total - 1));   // 1次→0.90, 2次→0.85, 3次→0.80 ... 下限 0.60
    if (severeCount > 0) sv = Math.max(0.60, sv - 0.05);   // 退市风险警示额外扣一档
  }
  return {
    stHistory,
    sv: +sv.toFixed(4),
    hasST: stHistory.length > 0,
    hasSevereST: severeCount > 0,
    severeCount,
    warnCount,
    hadShareReformTag: hadS,
  };
}

/**
 * 计算距今上市年数（用于识别"未满 3 年的次新股"，其回测样本天然偏短）。
 */
function listingYears(listingDate, now) {
  if (!listingDate) return null;
  const t = Date.parse(String(listingDate).replace(/-/g, '/'));
  if (!isFinite(t)) return null;
  const base = now ? now.getTime() : Date.now();
  return +((base - t) / (365.25 * 24 * 3600 * 1000)).toFixed(2);
}

// ---------------------------------------------------------------------
//  带缓存的取数
// ---------------------------------------------------------------------
function cacheFile(symbol) {
  return path.join(CACHE_DIR, String(symbol).replace(/[^\w]/g, '') + '.json');
}
function readCache(symbol) {
  try {
    const f = cacheFile(symbol);
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || !j.fetchedAt) return null;
    if (Date.now() - j.fetchedAt > CACHE_TTL_MS) return null;   // 过期
    return j;
  } catch (_) { return null; }
}
function writeCache(symbol, payload) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile(symbol), JSON.stringify(payload, null, 2), 'utf8');
  } catch (_) { /* 缓存写入失败不影响主流程 */ }
}

/**
 * 拉取 F10 基础信息（带 7 天落盘缓存）。
 * @returns {Promise<object>} { ok, symbol, currentName, formerName, listingDate, source } 或
 *                            { ok:false, reason, detail }（诚实失败，不做假数据）
 */
async function fetchF10Basic(symbol) {
  const sym = String(symbol).replace(/^(sh|sz|bj)/i, '').trim();
  if (!/^\d{6}$/.test(sym)) return { ok: false, reason: 'invalid_symbol', detail: '需要一个 6 位 A 股代码' };

  const cached = readCache(sym);
  if (cached) return { ...cached.data, fromCache: true };

  try {
    const resp = await axios.get('https://datacenter-web.eastmoney.com/api/data/v1/get', {
      params: {
        reportName: 'RPT_F10_BASIC_ORGINFO',
        columns: 'SECURITY_CODE,SECURITY_NAME_ABBR,FORMERNAME,LISTING_DATE',
        filter: `(SECURITY_CODE="${sym}")`,
        pageSize: 1,
      },
      timeout: 12000,
      headers: { Referer: 'https://quote.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
    });
    const row = (resp.data && resp.data.result && resp.data.result.data && resp.data.result.data[0]) || null;
    if (!row) return { ok: false, reason: 'no_data', detail: '东财 F10 未返回该公司记录' };
    const data = {
      ok: true,
      symbol: sym,
      currentName: row.SECURITY_NAME_ABBR || null,
      formerName: row.FORMERNAME || null,
      listingDate: row.LISTING_DATE || null,
      source: '东方财富 F10 · RPT_F10_BASIC_ORGINFO',
    };
    writeCache(sym, { fetchedAt: Date.now(), data });
    return data;
  } catch (e) {
    const status = e.response ? 'HTTP ' + e.response.status : (e.code || e.message);
    return { ok: false, reason: 'fetch_failed', detail: '东财 F10 通道不可达（' + status + '）' };
  }
}

/**
 * 取个股上市状态 + 风险警示证据（回测幸存者偏差修正的主入口）。
 * @param {string} symbol
 * @param {object} [opts] { now: Date }
 * @returns {Promise<object>} 始终返回对象；取数失败时 { ok:false, reason, survivorship:null }
 *                            以便调用方**明确标注降级**，而不是静默用默认值。
 */
async function getListingStatus(symbol, opts) {
  opts = opts || {};
  const basic = await fetchF10Basic(symbol);
  if (!basic.ok) {
    return {
      ok: false,
      symbol: String(symbol),
      reason: basic.reason,
      detail: basic.detail,
      survivorship: null,
      note: '上市状态不可得，幸存者偏差沿用默认 0.9（未获证据支撑，回测结论需按此打折理解）',
    };
  }
  const risk = parseRiskHistory(basic.formerName, basic.currentName);
  const years = listingYears(basic.listingDate, opts.now);
  const out = {
    ok: true,
    symbol: basic.symbol,
    currentName: basic.currentName,
    formerName: basic.formerName,
    listingDate: basic.listingDate,
    listingYears: years,
    ...risk,
    source: basic.source,
    fromCache: !!basic.fromCache,
  };
  // 证据化说明
  const bits = [];
  if (risk.hasSevereST) bits.push(`曾 ${risk.severeCount} 次退市风险警示（*ST）`);
  if (risk.warnCount > 0) bits.push(`曾 ${risk.warnCount} 次其他风险警示（ST）`);
  if (!risk.hasST) bits.push('无风险警示历史');
  if (years != null) bits.push(`上市 ${years} 年`);
  out.evidence = bits.join('；');
  // 次新股提示：样本天然偏短，不构成"幸存者"，但需标注
  out.isNewListing = years != null && years < 3;
  if (out.isNewListing) out.evidence += '；上市未满 3 年（回测样本天然偏短）';
  out.survivorship = risk.sv;
  return out;
}

module.exports = { getListingStatus, fetchF10Basic, parseRiskHistory, listingYears };
