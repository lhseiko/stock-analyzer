/**
 * lib/ai/earnings.js —— aiAugment 领域子模块：财报解读（拆分重构 202609）
 * ----------------------------------------------------------------
 * 含本地上下文构建（buildLocalEarningsContext）与全部 _extract* 后处理。
 * EARNINGS_PROMPT_VERSION 随缓存门控语义迁至 ai/cache.js，本模块反向 require。
 * 注意：buildLocalEarningsContext 内对 ./deepAnalysis 的延迟 require 原样保留
 * （deepAnalysis 顶层依赖 aiAugment.readCache 的历史环已通过 ai/cache 切断，
 *   但延迟 require 是已验证的稳定形态，按「零行为变化」原则不改）。
 */
const fs = require('fs');
const path = require('path');
const { getCompanyProfile } = require('../shareholderData');
const { CACHE_DIR, CACHE_TTL_MS, PROVIDERS, ensureDirs, loadConfig } = require('./config');
const { callLLM, pickModelFor, extractSources } = require('./llm');
const { EARNINGS_PROMPT_VERSION } = require('./cache');

const EARNINGS_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场，并能利用联网搜索获取最新公开信息。用户会给你一家公司的名称与代码。请你联网搜索该公司最新一期（最近一个已披露季度）的财报/季报/业绩预告，并做解读分析。

【身份确认（最高优先级）】你正在分析的是用户在消息中明确指定的公司（名称 + 6 位代码）。以下所有营业收入、归母净利润、扣非净利润、报告期等数据，必须严格对应该标的；严禁混入其他任何公司（例如中国平安 601318、贵州茅台 600519 等）的财务数据。若联网检索结果指向了错误的公司，必须立即纠正标的，或明确声明「未找到该公司最新财报」，绝不可张冠李戴。

输出格式（严格）：
第 1 行：标的：{公司名}（{代码}）（例如「标的：士兰微（600460）」，必须与用户给出的公司完全一致）
第 2 行：报告期：YYYY年X季报（例如「报告期：2026年中报」）
第 3 行：综合信号：<整数，区间 [-3, +3]，+ 代表利好/看多、- 代表利空/看空、0 中性；必须严格依据「边际变化方向 + 实质强弱」综合判定，不能只看同比正负（例如「表观稳、实质弱、边际向下」应给约 -2）>
第 4 行：综合结论：用一句话概括整体定性（如「表观稳、实质弱」「超预期改善」「低于预期、压力加大」「稳健增长」等），并点明核心矛盾与边际变化方向（加速/减速/拐点）。

重点覆盖以下维度，逐条结构化呈现（无该信息则写"暂无公开信息"）：
1) 最新报告期：明确是哪一期（如 2026 年中报 / 2025 年年报），披露日期；
2) 核心业绩与边际变化（重点）：营业收入、归母净利润、扣非净利润，以及各自同比（YoY）与环比（QoQ/较上季）变化，单位统一为「亿元」。
   - 必须同时计算并说明「较去年同期的变化是加速还是放缓」。例如：营收 2025 年上半年同比 +7.59%，2026 年上半年同比 +6.01%，虽然仍为正增长，但同比增速放缓 1.58 个百分点，属于边际走弱，不能简单判为利好。
   - 必须同时计算并说明「较上一季度（QoQ）的趋势」，并给出变化率。
   - 若核心指标同比/环比方向相反，须明确指出何者占主导并解释原因。
3) 业绩驱动：营收/利润增长或下滑的主要业务线、产品、区域或成本费用原因；
4) 亮点：超预期项、毛利率/净利率改善、订单/合同负债等前瞻信号；
5) 风险与隐忧：减值、商誉、现金流恶化、负债率上升、监管或诉讼等；
6) 与一致预期/历史同期对比：是否超预期或不及预期；
7) 管理层展望/指引（如有）；
8) 再次总结：用一句话重复综合结论，确保结论清晰。

要求：用简体中文分点结构化输出；不要孤立解读当期数字（如「营收增长 6.01%」不能直接判定为利好），必须结合同比、环比与边际变化给出定性；尽量标注数据来源（公司公告/巨潮/交易所/东方财富/同花顺等）与报告期；不要编造无来源的数字；若确无最新财报公开信息写"暂无相关公开财报"。总长一般不超过 1000 字；若内容丰富可能超出，先对次要细节做精简提炼（保留核心结论、同比/环比与边际变化、关键数据与来源标注，不得改变原意），严禁生硬截断或丢掉维度。`;

// ---------- 本地模式：分析本地数据库财报数据（不联网，使用 modelLocal） ----------
// 用途归类：财报解读只需要「分析已存在于本地财务数据库 / 已上传财报清单」的数据，
// 不需要模型去联网检索，因此切到本地模型（webSearch=false），并以本地数据作为唯一事实来源。
const EARNINGS_LOCAL_SYSTEM_PROMPT = `你是一名专业的投资分析师，熟悉中国A股市场。

【重要】你没有联网能力，也不需要联网。下方「本地财报数据」由系统从本地读取，是本轮分析唯一允许引用的事实来源，包含两部分：
①「近 8 期核心指标」结构化表（本地财务数据库，东方财富F10财报）——所有数字类结论的唯一事实来源；
②「同期财报原文节选」（本地资料库 PDF，如有）——公司披露的原文，用于业务构成、经营讨论、驱动因素、风险提示等定性背景。
严禁使用你训练记忆中的任何财务数字，严禁推测、估算或编造数据。PDF 节选中的数字仅当与结构化表一致（或结构化表未覆盖且明确标注来源）时方可引用；两者冲突时一律以结构化表为准。凡本地数据未提供的指标，一律写"本地数据未提供"，不得凭印象补充。

输出格式（严格）：
第 1 行：报告期：YYYY年X季报（例如「报告期：2026年中报」，以本地数据的最新报告期为准）
第 2 行：综合信号：<整数，区间 [-3, +3]，+ 代表利好/看多、- 代表利空/看空、0 中性；必须严格依据「边际变化方向 + 实质强弱」综合判定，不能只看同比正负（例如「表观稳、实质弱、边际向下」应给约 -2）>
第 3 行：综合结论：用一句话概括整体定性（如「表观稳、实质弱」「超预期改善」「低于预期、压力加大」「稳健增长」等），并点明核心矛盾与边际变化方向（加速/减速/拐点）。

重点覆盖以下维度，逐条结构化呈现（本地数据未提供则写"本地数据未提供"）：
1) 最新报告期：明确是哪一期，并标注数据时间与数据来源；
2) 核心业绩与边际变化（重点）：营业收入、归母净利润，各自的同比（YoY）与环比（较上一期）变化，单位统一为「亿元」。
   - 必须基于本地数据计算并说明「较去年同期的变化是加速还是放缓」，给出具体百分点。
   - 例如：营收本期同比 +6.01%、上期同比 +7.59%，仍为正增长但增速放缓 1.58 个百分点，属边际走弱，不能简单判为利好。
   - 若同比/环比方向相反，须明确指出何者占主导并解释原因。
3) 业绩驱动：优先引用 PDF 节选中「管理层讨论与分析/经营情况」披露的业务线、产品、区域、成本费用等真实原因（标注为公司披露）；结构化表能推断的原因须明确标注是推断；
4) 亮点：增速回升、降幅收窄等可从数据中直接验证的项；PDF 节选中披露的积极经营信号（如新品、渠道、订单）可一并说明；
5) 风险与隐忧：增速放缓、降幅扩大、边际走弱等可从数据中直接验证的项；PDF 节选「风险因素/可能面对的风险」章节披露的风险须逐条转述（这是数据完整性的重点）；
6) 数据可信度自查：仅一句概括，点明**实际已覆盖的字段**（如"覆盖：营收、归母净利、近 8 期核心指标"）与**实际未覆盖的具体字段名**（如"未覆盖：扣非净利、经营现金流、资产负债、一致预期"）。严禁对每个未列出的字段单独写一行同样的"数据不可验证"等套话；若有同期 PDF 原文支撑则注明。
7) 再次总结：用一句话重复综合结论，确保结论清晰。

要求：用简体中文分点结构化输出；不要孤立解读当期数字，必须结合同比、环比与边际变化给出定性；
结构化表数字后标注「（本地财报数据，报告期 XXXX-XX-XX，来源：东方财富F10财报）」，PDF 节选取材的定性内容标注「（资料库PDF：{PDF 报告期}）」；总长一般不超过 1000 字；若内容丰富可能超出，先精简提炼（不得改变原意），重复行仍会被自动折叠。`;

/**
 * 构建「本地财报上下文」——供本地模型分析，不联网。
 * 数据来源（规则一 · 指标级单源）：东方财富 F10 财报（lrbAjaxNew），经 lib/financeHub 输出五要素 + 同比 + 边际。
 * @param {string} symbol 6 位股票代码（或 sh600000 形式）
 * @returns {{ok:boolean, text?:string, reportDate?:string, series?:Array, docs?:Array, reason?:string}}
 */
// 从资料库文档中挑选与最新报告期最匹配的财报 PDF（20260902j）。
// 匹配优先级：同期完整报告 > 同期摘要 > 最近一期同类型完整报告 > 最近一期同类型摘要。
// 报告期从文件名/标题解析（如 603288_2026-08-27_海天味业2026年半年度报告.pdf → 2026年中报）。
// 注意：doc.year 是披露年份（年报比报告期晚一年），因此一律以文件名中的报告期年份为准。
function pickReportDoc(docs, reportDate) {
  if (!Array.isArray(docs) || !docs.length || !reportDate) return null;
  const rd = String(reportDate).slice(0, 10);
  const md = rd.slice(5); // MM-DD
  const targetYear = rd.slice(0, 4);
  const targetStage = md === '12-31' ? 'annual' : md === '06-30' ? 'semi'
    : md === '03-31' ? 'q1' : md === '09-30' ? 'q3' : '';
  if (!targetStage) return null;

  const STAGE_PAT = {
    semi: /(\d{4})年(?:半年度|中期)报告/,
    annual: /(\d{4})年年度报告/,
    q1: /(\d{4})年第?一季/,
    q3: /(\d{4})年第?三季/,
  };
  const STAGE_LABEL = { annual: '年报', semi: '中报', q1: '一季报', q3: '三季报' };

  const parsed = docs.map(d => {
    const fn = `${d.fileName || ''} ${d.title || ''}`;
    let stage = null, year = '';
    for (const [st, pat] of Object.entries(STAGE_PAT)) {
      const m = fn.match(pat);
      if (m) { stage = st; year = m[1]; break; }
    }
    return { doc: d, stage, year, isAbstract: /摘要/.test(fn) };
  }).filter(p => p.stage && p.year && /\.pdf$/i.test(String(p.doc.fileName || '')));

  const sameStage = parsed.filter(p => p.stage === targetStage);
  if (!sameStage.length) return null;

  const exact = sameStage.filter(p => p.year === targetYear);
  const pool = exact.length ? exact : sameStage.filter(p => p.year < targetYear);
  if (!pool.length) return null;
  // 报告期年份最新优先；完整报告优先于摘要
  pool.sort((a, b) => (Number(b.year) - Number(a.year)) || (a.isAbstract - b.isAbstract));
  const best = pool[0];
  return {
    doc: best.doc,
    periodLabel: `${best.year}年${STAGE_LABEL[best.stage]}`,
    exactMatch: best.year === targetYear,
  };
}

async function buildLocalEarningsContext(symbol, opts = {}) {
  const { pdfCharCap = 28000 } = opts; // 0 = 不注入 PDF（本地模型上下文装不下且无 modelWeb 可升级时）
  try {
    // 延迟 require：deepAnalysis 顶层依赖 aiAugment（readCache），此处顶层 require 会形成循环依赖
    const { fetchFinancialData } = require('../deepAnalysis');
    const { getFinanceHub } = require('../financeHub');
    const docStore = require('../docStore');

    const emCode = /^(sh|sz|bj)/i.test(String(symbol))
      ? String(symbol).toUpperCase()
      : (String(symbol).startsWith('6') ? `SH${symbol}` : `SZ${symbol}`);

    const finData = await fetchFinancialData(emCode);
    const hub = getFinanceHub(finData);
    if (!hub || !hub.ok) {
      return { ok: false, reason: (hub && hub.error) || '本地财务数据不可用' };
    }

    // 近 8 期营收 / 归母净利润明细（供本地模型自行计算同比与环比）
    const rows = (finData.income || [])
      .slice()
      .sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')))
      .slice(-8)
      .map(r => ({
        reportDate: String(r.REPORT_DATE || '').slice(0, 10),
        periodName: r.REPORT_DATE_NAME || '',
        revenue: Number(r.TOTAL_OPERATE_INCOME),
        netProfit: Number(r.PARENT_NETPROFIT),
        deduct: (r.DEDUCT_PARENT_NETPROFIT != null && r.DEDUCT_PARENT_NETPROFIT !== '')
          ? Number(r.DEDUCT_PARENT_NETPROFIT) : null,
      }))
      .filter(r => r.reportDate && (isFinite(r.revenue) || isFinite(r.netProfit)));
    if (!rows.length) return { ok: false, reason: '本地财报无可用明细行' };

    const yi = v => (isFinite(v) ? (v / 1e8).toFixed(2) : '--');
    const table = rows.map(r =>
      `- ${r.reportDate}（${r.periodName || '—'}）：营业收入 ${yi(r.revenue)} 亿元；归母净利润 ${yi(r.netProfit)} 亿元` +
      (r.deduct != null && isFinite(r.deduct) ? `；扣非归母净利润 ${yi(r.deduct)} 亿元` : '')
    ).join('\n');

    // 20260906（v4）：现金流量表 + 资产负债表关键科目注入（修复 AI 自搜旧年份/错误数据违反数据一致性，
    // 如圣湘生物曾被 AI 误引"2025 年报经营现金流 18.7 亿/商誉 0"，实际本地三表齐全且新）
    const cfRows = (finData.cashflow || [])
      .slice()
      .sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')))
      .slice(-8)
      .map(r => ({
        reportDate: String(r.REPORT_DATE || '').slice(0, 10),
        periodName: r.REPORT_DATE_NAME || '',
        operating: Number(r.NETCASH_OPERATE),
        salesCash: Number(r.SALES_SERVICES),
      }))
      .filter(r => r.reportDate && (isFinite(r.operating) || isFinite(r.salesCash)));
    const cfTable = cfRows.length
      ? cfRows.map(r =>
          `- ${r.reportDate}（${r.periodName || '—'}）：经营现金流净额 ${yi(r.operating)} 亿元` +
          (isFinite(r.salesCash) ? `；销售商品收现 ${yi(r.salesCash)} 亿元` : '')
        ).join('\n')
      : '（现金流量表暂无可用明细行）';

    const latestBal = (finData.balance || [])
      .slice()
      .sort((a, b) => String(a.REPORT_DATE || '').localeCompare(String(b.REPORT_DATE || '')))
      .pop();
    let balBlock = '';
    if (latestBal) {
      const balItems = [
        ['总资产', latestBal.TOTAL_ASSETS], ['总负债', latestBal.TOTAL_LIABILITIES], ['归母净资产', latestBal.TOTAL_PARENT_EQUITY],
        ['货币资金', latestBal.MONETARYFUNDS], ['应收账款', latestBal.ACCOUNTS_RECE], ['存货', latestBal.INVENTORY],
        ['商誉', latestBal.GOODWILL], ['固定资产', latestBal.FIXED_ASSET], ['短期借款', latestBal.SHORT_LOAN],
      ];
      const balDate = String(latestBal.REPORT_DATE || '').slice(0, 10);
      const balName = latestBal.REPORT_DATE_NAME || balDate;
      const balLines = balItems
        .filter(([, v]) => v != null && v !== '' && isFinite(Number(v)))
        .map(([k, v]) => `${k} ${yi(Number(v))} 亿元`).join('；');
      balBlock = `■ 资产负债表关键科目（最新报告期 ${balDate}（${balName}），单位：亿元）\n- ${balLines || '（无可用科目）'}`;
    }

    // 已上传财报清单（资料库）——文档库 stockCode 为裸码（如 688289），带前缀 symbol 须归一化
    // （20260906 修复：此前带前缀查询精确匹配永远落空，PDF 节选从未注入成功）
    let docs = [];
    try { docs = docStore.listCompanyDocuments(String(symbol).replace(/^(sh|sz|bj)/i, '')) || []; } catch (e) { docs = []; }
    const docLine = docs.length
      ? docs.slice(0, 12).map(d => `${d.typeName || d.type}｜${d.title || d.fileName}${d.year ? `（${d.year}年）` : ''}`).join('；')
      : '本地资料库暂无已上传财报文件';

    // ---- 同期财报 PDF 正文节选（20260902j）：提取与最新报告期匹配的 PDF 前 N 页，
    // 用于补充业务构成/经营讨论/风险提示等定性背景；数字事实源仍以结构化表为准 ----
    let docInfo = null;
    let pdfExcerpt = null;
    const picked = pdfCharCap > 0 ? pickReportDoc(docs, hub.reportDate) : null;
    if (picked && picked.doc) {
      try {
        const { getDocumentPath } = docStore;
        const resolved = getDocumentPath(picked.doc.id);
        const pdfPath = resolved && resolved.fullPath;
        if (pdfPath) {
          const pdf = require('../pdfText');
          const ext = await pdf.extractPdfText(pdfPath, { maxPages: 40, charCap: pdfCharCap });
          // 正文过短视为无效（扫描件无文本层），跳过注入不阻塞主流程
          if (ext.ok && ext.text && ext.text.replace(/\s/g, '').length >= 300) {
            docInfo = {
              fileName: picked.doc.fileName,
              periodLabel: picked.periodLabel,
              exactMatch: picked.exactMatch,
              pages: ext.pages,
              totalPages: ext.total_pages,
              truncated: !!ext.truncated,
              cached: !!ext.cached,
            };
            pdfExcerpt = [
              `■ 同期财报原文节选（本地资料库：${picked.doc.fileName}，覆盖报告期 ${picked.periodLabel}${picked.exactMatch ? '' : '（非最新一期，为最近可得同期报告）'}）`,
              `（节选前 ${ext.pages} 页${ext.truncated ? '，已截断' : ''}；本节用于业务构成、经营讨论、风险提示等定性背景；其中数字仅当与结构化表一致时方可引用，冲突时以结构化表为准）`,
              ext.text,
            ].join('\n');
          } else if (!ext.ok) {
            console.warn(`[财报解读PDF] ${symbol} 提取失败: ${ext.error}`);
          }
        }
      } catch (e) {
        console.warn(`[财报解读PDF] ${symbol} 注入异常（不影响解读主流程）: ${e.message}`);
      }
    }

    const gm = hub.growthMarginal || {};
    const labelOf = k => (k === 'TOTAL_OPERATE_INCOME' ? '营业收入' : '归母净利润');
    const marginalLines = ['TOTAL_OPERATE_INCOME', 'PARENT_NETPROFIT']
      .map(k => (gm[k] && gm[k].available
        ? `  · ${gm[k].text}`
        : `  · ${labelOf(k)}：${(gm[k] && gm[k].reason) || '不足三期，无法计算增速的边际'}`))
      .join('\n');

    const text = [
      `【本地财报数据｜公司代码 ${symbol}】`,
      `数据来源：${hub.source}；最新报告期（数据时间）：${hub.reportDate}；获取时间：${hub.fetchedAt}`,
      hub.staleNote ? `⚠️ ${hub.staleNote}` : '',
      '',
      '■ 近 8 期核心指标（单位：亿元）',
      table,
      '',
      '■ 系统已计算的同比与边际（规则三：变化率 = 同比增速；边际 = 本期同比 − 上期同比）',
      marginalLines,
      '',
      '■ 近 8 期现金流量表（单位：亿元）',
      cfTable,
      '',
      balBlock || '■ 资产负债表暂无可用数据',
      '',
      pdfExcerpt || '■ 本地资料库已上传财报文件（未匹配到本期 PDF，仅登记文件名）',
      pdfExcerpt ? '' : docLine,
    ].filter(Boolean).join('\n');

    return { ok: true, text, reportDate: hub.reportDate, series: rows, docs, fetchedAt: hub.fetchedAt, docInfo };
  } catch (e) {
    return { ok: false, reason: e.message || '本地财报上下文构建失败' };
  }
}

function _extractReportPeriod(content) {
  if (!content) return null;
  const m = String(content).match(/^\s*报告期[：:]\s*(.+?)\s*(?:\n|\r|$)/m);
  if (!m) return null;
  return m[1].replace(/[\s\u3000]+/g, ' ').trim();
}

// 20260904b：解析 AI 在首行声明的「标的：公司名（代码）」，用于前端展示 + 串公司检测。
// 若 AI 返回的代码与当前 symbol 不一致，即为疑似串公司（如 600460 误读为 601318）。
function _extractEarningsTarget(content) {
  if (!content) return null;
  const m = String(content).match(/标的[：:]\s*(.+?)\s*(?:\n|\r|$)/);
  if (!m) return null;
  const raw = m[1].replace(/[\s\u3000]+/g, ' ').trim();
  if (!raw) return null;
  const codeM = raw.match(/\(?\s*(\d{6})\s*\)?/);
  const code = codeM ? codeM[1] : null;
  const name = raw.replace(/[（(]\s*\d{6}\s*[)）]/, '').replace(/[（）()]/g, '').trim();
  return { raw, name, code };
}

// 20260904a：把「2026-06-30」转成人类可读报告期标签「2026年中报」/「2025年年报」等
function _reportDateToLabel(reportDate) {
  if (!reportDate) return null;
  const s = String(reportDate).slice(0, 10);
  const md = s.slice(5);
  const y = s.slice(0, 4);
  if (md === '12-31') return `${y}年年报`;
  if (md === '06-30') return `${y}年中报`;
  if (md === '03-31') return `${y}年一季报`;
  if (md === '09-30') return `${y}年三季报`;
  return `${y}年（${md}）`;
}

// 20260904a：从 AI 返回的亮点/雷点文本里检测它**作为论据**引用的财报年份。
// 返回该条目实际引用的最新年份（数字），用于与 latestReportYear 比对；若条目不含年报年份则返回 null（不涉财报，放行）。
function _detectCitedYear(text) {
  if (!text) return null;
  const m = String(text).match(/(20\d{2})\s*年(?:[半一三]|度)?报?/);
  return m ? parseInt(m[1], 10) : null;
}

// 从 AI 财报解读文本提取结构化信号（[-1,1]）：
// 优先解析「综合信号：N」整数行（N∈[-3,+3] 归一化）；缺失时按综合结论关键词启发式兜底。
function _extractEarningsSignal(content) {
  if (!content) return 0;
  const m = content.match(/综合信号[：:]\s*([+-]?\d+)/);
  if (m) {
    const n = Math.max(-3, Math.min(3, parseInt(m[1], 10)));
    return Math.max(-1, Math.min(1, n / 3));
  }
  // 兜底：优先用「综合结论」定性行做关键词启发式（避免全文亮点/风险段相互抵消，导致方向误判）
  const concl = (content.match(/综合结论[：:]\s*(.+?)(?:\n|\r|$)/) || [])[1] || '';
  const scope = concl.trim().length ? concl : content.slice(0, 240);
  const negRe = /放缓|下滑|恶化|承压|向下|走弱|不及|收窄|负增长|转负|亏损|隐忧|压力加大|拐点向下|边际向下|低于预期|不及预期/;
  const posRe = /超预期|改善|加速|向好|转正|回升|拐点向上|边际向上|高于预期|超预期改善/;
  const negCnt = (scope.match(negRe) || []).length;
  const posCnt = (scope.match(posRe) || []).length;
  if (posCnt > negCnt) return 0.5;
  if (negCnt > posCnt) return -0.5;
  return 0;
}

// 提取「综合结论」定性短句，供因子卡片展示（如「表观稳、实质弱」）
function _extractEarningsVerdict(content) {
  if (!content) return null;
  const m = content.match(/综合结论[：:]\s*(.+?)\s*(?:\n|\r|$)/);
  if (m) return m[1].replace(/[\s\u3000]+/g, ' ').trim();
  return null;
}

// 后置清理财报解读正文（20260904a，修士兰微 8 行重复 bug；20260906a 放宽长度）。
// 1) 折叠连续 2+ 行完全重复的相邻行（保留一行 + 计数提示，例如「（同上×7」），
//    防模型机械地把每个缺数据指标都写成同一句话刷屏。
// 2) 长度策略（20260906a）：取消 800 字硬上限——AI 侧目标 ≤1000 字、超出由模型精简提炼；
//    此处仅保留 1500 字安全兜底（正常不触发），只防模型失控刷屏。
function _postProcessEarningsSummary(text, maxChars = 1500) {
  if (!text) return text;
  // 步骤1：按"连续重复行组"收集（避免把上一行标记成对象后再去 trim 的递归坑）
  const lines = String(text).split(/\r?\n/);
  const groups = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (!t) {
      groups.push({ kind: 'blank', raw: ln });
      continue;
    }
    const last = groups[groups.length - 1];
    if (last && last.kind === 'dup' && last.text === t) {
      last.count++;
      continue;
    }
    groups.push({ kind: 'dup', text: t, count: 1, raw: ln });
  }
  // 步骤2：把 dup 组展开为「首行 + (同上×N)」
  const merged = [];
  for (const g of groups) {
    if (g.kind == 'blank') { merged.push(g.raw); continue; }
    merged.push(g.raw);
    if (g.count > 1) {
      merged.push(`（同上×${g.count}，已折叠以避免重复占用篇幅）`);
    }
  }
  let out = merged.join('\n').trim();

  // 步骤3：总长硬上限（保留「综合信号/结论」与「最新报告期/数据可信度自查」两句完整性，截中间正文）
  if (out.length > maxChars) {
    const cut = out.slice(0, maxChars);
    const lastStop = Math.max(
      cut.lastIndexOf('。'),
      cut.lastIndexOf('；'),
      cut.lastIndexOf('）'),
    );
    const safeCut = lastStop >= maxChars * 0.7 ? cut.slice(0, lastStop + 1) : cut;
    out = safeCut + '\n\n（…正文超出安全长度上限，已被截断。正常情况下 AI 会自动精简提炼到 1000 字左右；如反复出现请点击「重新解读」重试。）';
  }
  return out;
}

async function analyzeEarningsReport({ symbol, stockName, industry, force }) {
  ensureDirs();
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    return { success: false, error: 'NO_KEY', message: '请先在「⚙️ AI 设置」中配置 API Key' };
  }
  const cacheFile = path.join(CACHE_DIR, `${symbol}_earnings.json`);
  if (!force && fs.existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const promptOk = cached.promptVersion === EARNINGS_PROMPT_VERSION;
      if (promptOk) {
        // 20260904b：财报解读统一为「联网 AI 分析」主路径（mode 恒为 'web'），
        // 全部按 7 天 TTL 保鲜；旧 'local' 模式缓存因 promptVersion 变更已自动失效，不会继续展示本地口径。
        if (Date.now() - new Date(cached.date).getTime() < CACHE_TTL_MS) {
          return { success: true, ...cached, cached: true };
        }
        console.log(`[AI 财报解读] ${symbol} 缓存已超 7 天 TTL，重新联网解读`);
      }
    } catch {}
  }
  let name = stockName, ind = industry;
  if (!name) {
    try { const prof = await getCompanyProfile(symbol); name = prof.companyName; ind = prof.industry; } catch {}
  }
  // ── 用途归类（20260904b）─────────────────────────────────────────────────
  // 财报解读 = 联网 AI 分析主路径：本地财务数据库取数链路存在跨公司串号污染
  // （如 600460 士兰微误读为 601318 中国平安），故不再以本地数据为事实源，
  // 统一走 modelWeb + 联网检索（webSearch=true），由系统层「身份确认」句强约束 AI 声明标的。
  // 不再调用 buildLocalEarningsContext，彻底绕过本地取数污染源。
  let modelPick, mode;
  modelPick = pickModelFor(cfg, 'web');
  mode = 'web';
  console.log(`[AI 财报解读] ${symbol} 走联网 AI 分析主路径（webSearch=${!!modelPick.webSearch}）`);
  const messages = [
    { role: 'system', content: EARNINGS_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `公司：${name || symbol}（代码 ${symbol}${ind ? '，行业：' + ind : ''}）。请联网搜索该公司最新一期（最近一个已披露季度）的财报/季报/业绩预告，并做解读分析。`,
    },
  ];
  try {
    // 20260906a：联网检索 + 长文生成常超 60s（「timeout of 60000ms exceeded」），财报解读单独放宽到 180s；不影响其他模块默认 60s
    const content = await callLLM(cfg.provider, cfg.apiKey, modelPick.model, messages, { webSearch: modelPick.webSearch, timeoutMs: 180000 });
    if (!content || !content.trim()) return { success: false, error: 'EMPTY', message: 'AI 返回为空' };
    const reportPeriod = _extractReportPeriod(content);
    const earningsTarget = _extractEarningsTarget(content);
    // 20260904b：串公司检测——AI 首行声明的代码若与当前 symbol 不一致，即为疑似张冠李戴
    let targetMismatch = false, targetWarn = '';
    if (earningsTarget && earningsTarget.code && earningsTarget.code !== symbol) {
      targetMismatch = true;
      targetWarn = `解读标的疑似串公司：AI 返回代码 ${earningsTarget.code}，当前股票为 ${symbol}。请点击「重新解读」重试。`;
      console.warn(`[AI 财报解读] ${symbol} 检测到标的代码不符：AI=${earningsTarget.code}`);
    }
    // summary 去掉「报告期：...」行（标题已展示）与「标的：...」行（前端以徽标展示），避免重复。
    // 注意：AI 可能把「标的」行放在「报告期」行之前，故 reportPeriod 提取改用 /m 全行匹配，
    // 此处 strip 也独立于 reportPeriod 是否取到，始终剥离「报告期」行。
    let rawSummary = String(content).trim();
    rawSummary = rawSummary.replace(/^[^\r\n]*报告期[：:][^\r\n]*\r?\n?/m, '').trim();
    if (earningsTarget) rawSummary = rawSummary.replace(/^[^\r\n]*标的[：:][^\r\n]*\r?\n?/m, '').trim();
    // 20260904a：后置清理（折叠连续重复行 + 长度安全兜底；20260906a 起 800 字硬上限改为 1500 字兜底，AI 侧目标 ≤1000 字精简提炼），修士兰微 8 行重复 bug
    const summary = _postProcessEarningsSummary(rawSummary);
    // 结构化信号：优先解析「综合信号：N」行；缺失时按综合结论关键词启发式兜底（确保实质弱/边际向下被正确判为利空）
    const earningsSignal = _extractEarningsSignal(content);
    const verdict = _extractEarningsVerdict(content);
    const result = {
      symbol, stockName: name || symbol, summary, reportPeriod, earningsSignal, verdict, sources: extractSources(content),
      date: new Date().toISOString(), model: modelPick.model || (PROVIDERS[cfg.provider] ? PROVIDERS[cfg.provider].defModel : ''),
      // 归类溯源（20260904b）：统一为联网 AI 分析主路径
      mode,
      modelKind: modelPick.webSearch ? 'web' : 'web-noSearch',
      localDataUsed: false,
      // 20260904b：标的身份（供前端展示 + 串公司检测）
      earningsTarget,
      targetMismatch,
      targetWarn,
      promptVersion: EARNINGS_PROMPT_VERSION,
    };
    try { fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2), 'utf8'); } catch {}
    return { success: true, ...result, cached: false };
  } catch (e) {
    const status = e.response && e.response.status;
    const data = e.response && e.response.data;
    let message = e.message;
    if (data) { if (typeof data === 'string') message = data.slice(0, 300); else if (data.message) message = data.message; else if (data.error && data.error.message) message = data.error.message; }
    return { success: false, error: 'API_ERROR', status, message };
  }
}

module.exports = {
  analyzeEarningsReport,
  buildLocalEarningsContext,
  _extractReportPeriod,
  _extractEarningsTarget,
  _reportDateToLabel,
  _detectCitedYear,
  _extractEarningsSignal,
  _extractEarningsVerdict,
  _postProcessEarningsSummary,
};
