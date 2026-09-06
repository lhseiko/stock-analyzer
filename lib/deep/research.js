/**
 * lib/deep/research.js —— deepAnalysis 领域子模块：本地文档 / 主营构成 / 研报 / 公告抓取
 * ----------------------------------------------------------------
 * 由 lib/deepAnalysis.js 拆分而来（202609 拆分重构）。
 * _cninfoOrgCache（巨潮 orgId 内存缓存）本子模块唯一持有；
 * ANNO_CATEGORY_LABEL 本文件内未被引用，原样保留以维持源码一致性（设计差异点 D12 相关）。
 */
const axios = require('axios');
const docStore = require('../docStore');
const { UA, HEADERS, _stmtStage } = require('./shared');

/**
 * 获取某股票的本地资料库文档。
 * 严格按 stockCode 过滤，仅返回「该股票自己」上传的文档；
 * 若该公司没有任何本地文档，返回 null（调用方据此隐藏资料库区块）。
 * 该函数在每次请求时实时读取磁盘索引，因此总能反映最新上传/删除。
 * @param {string} stockCode 标准化后的数字代码（如 '601318'）
 */
function getLocalDocuments(stockCode) {
  try {
    const localDocs = docStore.listCompanyDocuments(stockCode);
    if (localDocs && localDocs.length > 0) {
      console.log(`[DeepAnalysis] Found ${localDocs.length} local documents for ${stockCode}`);
      return {
        count: localDocs.length,
        documents: localDocs.map(d => ({
          id: d.id,
          type: d.type,
          typeName: d.typeName,
          fileName: d.fileName,
          title: d.title,
          year: d.year,
          fileSize: d.fileSize,
          uploadedAt: d.uploadedAt,
        })),
        typeBreakdown: localDocs.reduce((acc, d) => {
          acc[d.type] = (acc[d.type] || 0) + 1;
          return acc;
        }, {}),
      };
    }
    console.log(`[DeepAnalysis] No local documents found for ${stockCode}, using online data only`);
  } catch (e) {
    console.log(`[DeepAnalysis] Local doc check failed: ${e.message}`);
  }
  return null;
}

// ---- 分产品 / 分地区 主营构成（近 10 年）----
// 数据源：东方财富 F10 主营构成 RPT_F10_FN_MAINOP（stocks；原 RPT_F10_FUND_INCOME 实为基金收支报表，对股票恒为空）
// 字段：ITEM_NAME(分部名) / MAINOP_TYPE(1行业 2产品/业务分部 3地区) / MAIN_BUSINESS_INCOME(收入·元)
//       MBI_RATIO(营收占比·小数) / MAIN_BUSINESS_COST(成本·元) / MBC_RATIO(成本占比·小数)
//       GROSS_RPOFIT_RATIO(毛利率·小数，注意东财字段名拼写为 RPOFIT) / REPORT_NAME(报告期名)
function _segPct(v) {
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return null;
  return Math.round(Number(v) * 10000) / 100; // 小数比例 → 百分数
}
async function fetchSegmentData(emCode) {
  const stockCode = emCode.replace(/^(SH|SZ|BJ)/, '');
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_F10_FN_MAINOP&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)&pageSize=500&sortColumns=REPORT_DATE&sortTypes=-1`;
  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 10000 });
    const list = resp.data?.result?.data;
    if (!Array.isArray(list) || list.length === 0) return null;

    // MAINOP_TYPE 数值 → 中文维度（1=行业 2=产品/业务分部 3=地区）
    const TYPE_MAP = { '1': '行业', '2': '产品', '3': '地区' };

    // 第一阶段：按 (year, type) 收集所有记录，并记住该 (year,type) 下出现的最新报告期
    const temp = {};
    for (const r of list) {
      const year = (r.REPORT_DATE || '').slice(0, 4);
      if (!year) continue;
      const rawType = r.MAINOP_TYPE !== undefined ? String(r.MAINOP_TYPE) : '';
      const type = TYPE_MAP[rawType] || ('维度' + rawType);
      const name = r.ITEM_NAME || r.MAINOP_NAME || r.MAIN_BUSINESS_NAME || '';
      const income = parseFloat(r.MAIN_BUSINESS_INCOME) || parseFloat(r.MAINOP_INCOME) || 0;
      // 跳过「抵销 / 合并 / 其他」等负向或空项，避免污染产品细分与占比合计
      if (!name || income <= 0) continue;

      const cost = parseFloat(r.MAIN_BUSINESS_COST) || parseFloat(r.MAINOP_COST) || 0;
      let grossMargin = _segPct(r.GROSS_RPOFIT_RATIO ?? r.MAINOP_GROSS_PROFIT_RATIO);
      if (grossMargin == null && cost > 0 && income > 0) {
        grossMargin = Math.round((1 - cost / income) * 10000) / 100; // 兜底：差额法
      }
      const item = {
        name,
        income,                                                      // 元
        ratio: _segPct(r.MBI_RATIO ?? r.MAINOP_INCOME_RATIO),         // 营收占比 %
        incomeRatio: _segPct(r.MBI_RATIO ?? r.MAINOP_INCOME_RATIO),   // 营收占比 %
        cost,                                                        // 元
        costRatio: _segPct(r.MBC_RATIO ?? r.MAINOP_COST_RATIO),       // 营业成本占比 %
        grossMargin,                                                 // 毛利率 %
        reportName: r.REPORT_NAME || '',
        reportDate: (r.REPORT_DATE || '').slice(0, 10),
      };
      const yt = (temp[year] = temp[year] || {});
      const bucket = (yt[type] = yt[type] || { reportDate: '', items: [] });
      bucket.items.push(item);
      if (item.reportDate > bucket.reportDate) bucket.reportDate = item.reportDate;
    }

    // 第二阶段：每个 (year,type) 合并同名项。
    //   - byYear[year][type]：仅保留「最新报告期」（向后兼容，供毛利率/客户竞争等模块使用）；
    //   - allPeriods[year][type]：保留该年【全部报告期】（年报/中报/一季报/三季报），
    //     供分业务趋势做 TTM 滚动累计（需上一年同阶段部分报告还原剩余季度）。
    const byYear = {};
    const allPeriods = {};
    for (const year of Object.keys(temp)) {
      for (const type of Object.keys(temp[year])) {
        const bucket = temp[year][type];
        // 按报告期分组
        const byReport = {};
        for (const it of bucket.items) {
          (byReport[it.reportDate] = byReport[it.reportDate] || []).push(it);
        }
        const periodArr = [];
        for (const rd of Object.keys(byReport)) {
          const merged = new Map();
          for (const it of byReport[rd]) {
            const cur = merged.get(it.name) || {
              name: it.name, income: 0, cost: 0,
              gmWSum: 0, gmW: 0, ratio: null, reportName: it.reportName, reportDate: it.reportDate,
            };
            cur.income += it.income;
            cur.cost += it.cost;
            if (it.grossMargin != null && it.income > 0) { cur.gmWSum += it.grossMargin * it.income; cur.gmW += it.income; }
            if (cur.ratio == null) cur.ratio = it.ratio;
            merged.set(it.name, cur);
          }
          const totalCost = Array.from(merged.values()).reduce((s, c) => s + c.cost, 0);
          const items = Array.from(merged.values()).map(cur => ({
            name: cur.name,
            income: cur.income,
            cost: cur.cost,
            ratio: cur.ratio,
            incomeRatio: cur.ratio,
            costRatio: totalCost > 0 ? Math.round(cur.cost / totalCost * 10000) / 100 : null,
            grossMargin: cur.gmW > 0 ? Math.round(cur.gmWSum / cur.gmW * 100) / 100 : null,
            reportName: cur.reportName,
            reportDate: cur.reportDate,
          }));
          periodArr.push({
            reportName: items[0]?.reportName || '',
            reportDate: rd,
            stage: _stmtStage(items[0]?.reportName || ''),
            items,
          });
        }
        const latest = periodArr.filter(p => p.reportDate === bucket.reportDate);
        const latestItems = latest.length ? latest[0].items : (periodArr[periodArr.length - 1]?.items || []);
        (byYear[year] = byYear[year] || {})[type] = latestItems;
        (allPeriods[year] = allPeriods[year] || {})[type] = periodArr;
      }
    }
    const years = Object.keys(byYear).sort();
    if (years.length === 0) return null;
    return { years, byYear, allPeriods, raw: list.length };
  } catch (e) {
    console.error('[Segment] fetch failed:', e.message);
    return null;
  }
}

// ---- 细分产品/业务毛利率：取最新报告期「产品」维度，逐业务列示营收占比 / 成本占比 / 毛利率 ----
function buildProductGrossMargin(segmentData) {
  if (!segmentData || !segmentData.byYear || segmentData.years.length === 0) return null;

  // 1. 优先「产品」维度；个别公司仅披露「行业」时用行业维度兜底
  const allTypeKeys = new Set();
  Object.values(segmentData.byYear).forEach(y => Object.keys(y).forEach(t => allTypeKeys.add(t)));
  const typeKey = Array.from(allTypeKeys).find(t => t === '产品')
    || Array.from(allTypeKeys).find(t => t === '行业')
    || null;
  if (!typeKey) return null;

  // 2. 跨所有年份收集该维度的全部记录，找出最新完整报告期（精确到日），避免同一年中报+年报重复汇总
  let allItems = [];
  Object.values(segmentData.byYear).forEach(y => {
    if (y[typeKey]) allItems = allItems.concat(y[typeKey]);
  });
  if (allItems.length === 0) return null;

  // 3. 取最新报告期；同名业务汇总（收入/成本相加，毛利率按汇总后差额法重算）
  const maxDate = allItems.reduce((max, p) => (p.reportDate && p.reportDate > max ? p.reportDate : max), '');
  const latestItems = allItems.filter(p => p.reportDate === maxDate && (p.income || 0) > 0);
  if (latestItems.length === 0) return null;

  const merged = new Map();
  for (const p of latestItems) {
    const name = p.name || '其他';
    const cur = merged.get(name) || { income: 0, cost: 0, weightedGmSum: 0, weightedGmWeight: 0 };
    cur.income += (p.income || 0);
    cur.cost += (p.cost || 0);
    if (p.grossMargin != null && p.income > 0) {
      cur.weightedGmSum += p.grossMargin * p.income;
      cur.weightedGmWeight += p.income;
    }
    merged.set(name, cur);
  }

  const totalIncome = Array.from(merged.values()).reduce((s, p) => s + p.income, 0);
  const totalCost = Array.from(merged.values()).reduce((s, p) => s + p.cost, 0);

  const items = Array.from(merged.entries()).map(([name, p]) => {
    const incomeYi = Math.round(p.income / 1e8 * 100) / 100;
    const costYi = (p.cost > 0) ? Math.round(p.cost / 1e8 * 100) / 100 : null;
    // 汇总后毛利率：优先用差额法；若成本缺失则按原始毛利率收入加权平均
    let gm = null;
    if (p.cost > 0 && p.income > 0) {
      gm = Math.round((1 - p.cost / p.income) * 10000) / 100;
    } else if (p.weightedGmWeight > 0) {
      gm = Math.round(p.weightedGmSum / p.weightedGmWeight * 100) / 100;
    }
    return {
      name,
      incomeYi,
      incomeRatio: totalIncome > 0 ? Math.round(p.income / totalIncome * 10000) / 100 : null,
      costYi,
      costRatio: (totalCost > 0 && p.cost > 0) ? Math.round(p.cost / totalCost * 10000) / 100 : null,
      grossMargin: gm,
    };
  }).sort((a, b) => b.incomeYi - a.incomeYi);
  if (items.length === 0) return null;

  const totalIncomeYi = Math.round(items.reduce((s, p) => s + p.incomeYi, 0) * 100) / 100;
  const totalCostYi = Math.round(items.reduce((s, p) => s + (p.costYi || 0), 0) * 100) / 100;
  const sample = latestItems.find(p => p.reportName) || latestItems[0] || {};
  const period = sample.reportName || (sample.reportDate ? sample.reportDate.slice(0, 4) + '年' : '最新报告期');
  const reportDate = sample.reportDate || '';

  return {
    period,
    reportDate,
    dimension: typeKey,
    source: '东方财富 F10 主营构成（RPT_F10_FN_MAINOP）',
    items,
    totalIncomeYi,
    totalCostYi,
  };
}

// ---- 近一年券商研报（观点与估值）----
async function fetchResearchReports(stockCode) {
  const end = new Date();
  const begin = new Date();
  begin.setFullYear(begin.getFullYear() - 1);
  const fmt = d => d.toISOString().slice(0, 10);
  const url = `https://reportapi.eastmoney.com/report/list?qType=0&pageSize=30&pageNo=1&code=${stockCode}&beginTime=${fmt(begin)}&endTime=${fmt(end)}&industryCode=*&rating=&ratingChange=`;
  try {
    const resp = await axios.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' }, timeout: 10000 });
    const list = resp.data?.data || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.slice(0, 30).map(r => ({
      title: r.title || '',
      org: r.orgSName || r.orgName || '',
      rating: r.emRatingName || r.rating || '',
      targetPrice: parseFloat(r.targetPrice) || 0,
      publishDate: (r.publishDate || '').slice(0, 10),
      predictEps: parseFloat(r.predictThisYearEps) || 0,
      predictPe: parseFloat(r.predictThisYearPe) || 0,
      infoCode: r.infoCode || '',
    }));
  } catch (e) {
    console.error('[Research] fetch failed:', e.message);
    return null;
  }
}

// ---- 近一年公告：巨潮资讯网（优先）+ 东方财富（兜底）----
// 分类：增持 / 减持 / 回购 / 高管变动 / 立案处罚 / 诉讼仲裁 / 其他
function classifyAnnouncement(title) {
  const t = title || '';
  if (/增持/.test(t)) return 'increase';
  if (/减持/.test(t)) return 'decrease';
  if (/回购/.test(t)) return 'buyback';
  if (/高管|董事|监事|独立董|辞职|聘任|任职|董事会秘书/.test(t)) return 'execChange';
  if (/立案|处罚|警示函|监管措施|行政处罚|被立案|公开谴责|通报批评/.test(t)) return 'csrcAction';
  if (/诉讼|仲裁|判决|裁定|起诉书/.test(t)) return 'litigation';
  return 'other';
}

const ANNO_CATEGORY_LABEL = {
  increase: '股东增持',
  decrease: '股东减持',
  buyback: '股份回购',
  execChange: '高管/董事变动',
  csrcAction: '立案/处罚/监管',
  litigation: '诉讼/仲裁',
  other: '其他公告',
};

// 从公告标题 + 正文文本中尽力提取关键字段（best-effort，找不到的字段不返回）
function parseAnnouncementFields(text, category) {
  const fields = {};
  if (!text) return fields;
  const t = text.replace(/\s+/g, '');
  // 增持价格上限：不超过 X 元/股
  let m = t.match(/不超过\s*([\d.]+)\s*元/);
  if (m) fields.priceCap = parseFloat(m[1]);
  // 已增持股数 / 金额
  m = t.match(/已增持[^，。；]*?([\d,]+)\s*股/);
  if (m) fields.increasedShares = m[1].replace(/,/g, '');
  m = t.match(/已增持[^，。；]*?([\d.]+)\s*万元/);
  if (m) fields.increasedAmountWan = parseFloat(m[1]);
  // 拟增持 / 剩余未增持金额
  m = t.match(/(?:拟增持|剩余|尚未增持|增持金额)[^，。；]*?([\d.]+)\s*万元/);
  if (m) fields.remainingAmountWan = parseFloat(m[1]);
  // 减持：已减持 / 剩余未减持 / 截止日
  m = t.match(/已减持[^，。；]*?([\d,]+)\s*股/);
  if (m) fields.decreasedShares = m[1].replace(/,/g, '');
  m = t.match(/剩余[^，。；]*?(?:未减持|拟减持)[^，。；]*?([\d,]+)\s*股/);
  if (m) fields.remainingDecreaseShares = m[1].replace(/,/g, '');
  m = t.match(/(?:截止|届满|到期)[日期:：]?\s*(\d{4}[-/年]\d{1,2}[-/月]\d{1,2})/);
  if (m) fields.deadline = m[1].replace(/[年月]/g, '-').replace(/\//g, '-');
  // 回购：均价 / 金额 / 完成度
  m = t.match(/回购均价[^，。；]*?([\d.]+)\s*元/);
  if (m) fields.buybackAvgPrice = parseFloat(m[1]);
  m = t.match(/回购(?:金额|资金)[^，。；]*?([\d.]+)\s*万元/);
  if (m) fields.buybackAmountWan = parseFloat(m[1]);
  m = t.match(/完成\s*([\d.]+)\s*%/);
  if (m) fields.buybackProgress = parseFloat(m[1]);
  return fields;
}

// 巨潮资讯网：代码 → orgId 映射（内存缓存，避免每次公告查询都先搜一遍）
const _cninfoOrgCache = new Map();
async function fetchCninfoOrgId(stockCode) {
  if (_cninfoOrgCache.has(stockCode)) return _cninfoOrgCache.get(stockCode);
  const url = 'https://www.cninfo.com.cn/new/information/topSearch/query';
  const body = new URLSearchParams({ keyWord: stockCode, maxSecNum: '10', maxListNum: '5' }).toString();
  try {
    const resp = await axios.post(url, body, {
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': 'https://www.cninfo.com.cn/' },
      timeout: 8000,
    });
    const arr = Array.isArray(resp.data) ? resp.data : [];
    const hit = arr.find(x => x.code === stockCode) || null;
    const orgId = hit ? hit.orgId : null;
    if (orgId) _cninfoOrgCache.set(stockCode, orgId);
    return orgId;
  } catch (e) {
    console.error('[CNINFO orgId] fetch failed:', e.message);
    return null;
  }
}

// 巨潮资讯网：近一年公告列表（20260903g 重写：stock=code,orgId 精确过滤 + seDate 区间 +
// announcementTime 毫秒时间戳解析；旧参数 stockCode/startTime/endTime 会被忽略导致翻页泄漏其他公司数据）
async function fetchCninfoAnnouncements(stockCode, stockName) {
  const orgId = await fetchCninfoOrgId(stockCode);
  if (!orgId) return null;
  const end = new Date();
  const start = new Date();
  start.setFullYear(start.getFullYear() - 1);
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const isSH = /^6/.test(stockCode);
  const url = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
  const body = new URLSearchParams({
    pageNum: '1',
    pageSize: '60',
    column: isSH ? 'sse' : 'szse',
    tabName: 'fulltext',
    stock: `${stockCode},${orgId}`,
    plate: isSH ? 'sh' : 'sz',
    seDate: `${fmt(start)}~${fmt(end)}`,
    searchkey: '',
    secid: '',
    category: '',
    trade: '',
  }).toString();
  try {
    const resp = await axios.post(url, body, {
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'Referer': 'https://www.cninfo.com.cn/', 'X-Requested-With': 'XMLHttpRequest' },
      timeout: 12000,
    });
    const list = resp.data?.announcements || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    return list.map(a => {
      const title = a.announcementTitle || '';
      // announcementTime 为北京日期零点的毫秒时间戳，+8h 后取 UTC 日期即公告日
      const ts = Number(a.announcementTime);
      let date = ts > 0 ? new Date(ts + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';
      if (!date) {
        const m = (a.adjunctUrl || '').match(/finalpage\/(\d{4}-\d{2}-\d{2})\//);
        if (m) date = m[1];
      }
      const category = classifyAnnouncement(title);
      const rawHtml = typeof a.adjHTML === 'string' ? a.adjHTML : '';
      const text = rawHtml.replace(/<[^>]+>/g, ' ').slice(0, 8000);
      const parsed = parseAnnouncementFields(title + '\n' + text, category);
      const id = a.announcementId || '';
      const link = id ? `https://www.cninfo.com.cn/new/disclosure/detail?announcementId=${encodeURIComponent(id)}&stockCode=${encodeURIComponent(stockCode)}&orgId=${encodeURIComponent(orgId)}` : (a.adjunctUrl ? `https://static.cninfo.com.cn/${a.adjunctUrl}` : '');
      return { title, date, category, parsed, url: link, source: '巨潮资讯网' };
    }).filter(a => a.title);
  } catch (e) {
    console.error('[CNINFO Announcements] fetch failed:', e.message);
    return null;
  }
}

// 东方财富兜底（仅标题列表，无全文解析）
async function fetchAnnouncementsEastmoney(stockCode) {
  const url = `https://np-anotice-stock.eastmoney.com/api/security/announcement?sr=-1&page_size=60&page_index=1&stock_list=${stockCode}`;
  try {
    const resp = await axios.get(url, { headers: { 'User-Agent': UA, 'Referer': 'https://data.eastmoney.com/' }, timeout: 10000 });
    const list = resp.data?.announcements || resp.data?.list || resp.data?.data || [];
    if (!Array.isArray(list) || list.length === 0) return null;
    const end = new Date();
    const start = new Date(); start.setFullYear(start.getFullYear() - 1);
    return list.map(a => ({
      title: a.title || a.notice_title || '',
      date: (a.ei_time || a.notice_date || a.datetime || '').slice(0, 10),
      category: classifyAnnouncement(a.title || a.notice_title || ''),
      parsed: {},
      url: a.url || a.notice_url || '',
      source: '东方财富',
    })).filter(a => a.title && a.date >= start.toISOString().slice(0, 10));
  } catch (e) {
    console.error('[Announcements EM] fetch failed:', e.message);
    return null;
  }
}

// 统一入口：优先巨潮，失败/空则东方财富兜底；返回 { source, items } 或 null
async function fetchAnnouncements(stockCode, stockName) {
  const cn = await fetchCninfoAnnouncements(stockCode, stockName);
  if (cn && cn.length) return { source: '巨潮资讯网', items: cn };
  const em = await fetchAnnouncementsEastmoney(stockCode);
  if (em && em.length) return { source: '东方财富(兜底)', items: em };
  return null;
}

module.exports = { getLocalDocuments, fetchSegmentData, buildProductGrossMargin, fetchResearchReports, fetchAnnouncements };
