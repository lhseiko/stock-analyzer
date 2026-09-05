/**
 * Shareholder & Company Profile Data Module (issue5 / issue6)
 *
 * 实时抓取东方财富 F10 数据，所有请求均带超时与异常兜底：
 *   - 股东户数走势   (RPT_F10_FN_HOLDERS)
 *   - 十大股东 / 十大流通股东 (RPT_F10_EH_HOLDERS)
 *   - 机构持仓数量变化 (从多期十大股东中统计机构户数)
 *   - 公司概况（主要产品 / 客户 / 企业性质）(CompanySurvey PageAjax)
 *
 * 任一子请求失败都不会让整个接口报错，前端按"暂无数据"优雅降级。
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DC_HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://data.eastmoney.com/',
  'Accept': 'application/json, text/plain, */*'
};
const EMWEB_HEADERS = {
  'User-Agent': UA,
  'Referer': 'https://emweb.securities.eastmoney.com/',
  'Accept': 'application/json, text/plain, */*'
};

// 将任意 symbol 标准化为东方财富代码 (SZ000001 / SH600519)，失败返回 null
function toEMCode(symbol) {
  if (!symbol) return null;
  let s = String(symbol).replace(/\.(SZ|SH|BJ)$/i, '').toUpperCase();
  if (/^(SH|SZ|BJ)/i.test(s)) {
    return s.slice(0, 2).toUpperCase() + s.slice(2);
  }
  if (/^\d{6}$/.test(s)) {
    const prefix = s[0] === '6' ? 'SH' : (s[0] === '8' || s[0] === '4') ? 'BJ' : 'SZ';
    return prefix + s;
  }
  // 港股 / 美股等暂不支持 F10
  return null;
}

// 国内 A 股判断（仅 A 股有完整 F10）
function isACode(symbol) {
  const em = toEMCode(symbol);
  return !!em && (em.startsWith('SH') || em.startsWith('SZ'));
}

// 判断是否为机构投资者名称
const INST_KEYWORDS = [
  '基金', '资产管理', '资管', '保险', '社保基金', '信托', '证券', '私募',
  '境外法人', 'QFII', '养老金', '企业年金', '中央汇金', '中国证券金融',
  '银行', '养老保险', '投信', '投资(集团)', '国有投资', '金融控股', '集团'
];
function isInstitution(name) {
  if (!name) return false;
  return INST_KEYWORDS.some(k => name.includes(k));
}

async function dcGet(url, timeout = 10000) {
  const resp = await axios.get(url, { headers: DC_HEADERS, timeout });
  return resp.data;
}

// ---- 股东研究总览（一次请求覆盖 股东户数 / 机构持仓 / 基金持股）----
// 注：原 datacenter 报表 RPT_F10_FN_HOLDERS 已被东方财富下线（"报表配置不存在"），
// 现改用 F10 ShareholderResearch/PageAjax 的 gdrs/jgcc/jjcg 字段，稳定可用。
async function fetchShareholderResearch(emCode) {
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=${emCode}`;
  try {
    const resp = await axios.get(url, { headers: EMWEB_HEADERS, timeout: 10000 });
    return resp.data || {};
  } catch (e) {
    console.error('[ShareholderResearch] failed:', e.message);
    return {};
  }
}

// ---- 股东户数走势（F10 gdrs：户数 / 环比 / 户均持股 / 持股集中度）----
function parseHolderCountTrend(research) {
  const rows = Array.isArray(research.gdrs) ? research.gdrs : [];
  return rows
    .map(r => ({
      date: (r.END_DATE || '').slice(0, 10),
      holderNum: Number(r.HOLDER_TOTAL_NUM) || 0,
      changeRatio: r.TOTAL_NUM_RATIO != null ? Number(r.TOTAL_NUM_RATIO) : null,
      avgFreeShares: Number(r.AVG_FREE_SHARES) || 0,
      avgHoldAmt: Number(r.AVG_HOLD_AMT) || 0,
      focus: r.HOLD_FOCUS || '',
    }))
    .filter(r => r.holderNum > 0)
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ---- 机构持仓汇总（F10 jgcc：按报告期统计机构家数 / 持股比例）----
function parseInstitutionHoldings(research) {
  const rows = Array.isArray(research.jgcc) ? research.jgcc : [];
  return rows
    .map(r => ({
      date: (r.REPORT_DATE || '').slice(0, 10),
      orgNum: Number(r.TOTAL_ORG_NUM) || 0,
      freeShares: Number(r.TOTAL_FREE_SHARES) || 0,
      freeRatio: Number(r.TOTAL_SHARES_RATIO) || 0,
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ---- 基金持股明细（F10 jjcg：最新一期各基金持仓，按持股比例降序）----
function parseFundHoldings(research) {
  const rows = Array.isArray(research.jjcg) ? research.jjcg : [];
  return rows
    .map(r => ({
      date: (r.REPORT_DATE || '').slice(0, 10),
      name: r.HOLDER_NAME || '',
      shares: Number(r.TOTAL_SHARES) || 0,
      value: Number(r.HOLD_VALUE) || 0,
      ratio: Number(r.TOTALSHARES_RATIO) || 0,
    }))
    .sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
}

// ---- 十大股东（最新一期） ----
// 20260823h：修复「change」只做文本正则匹配的 bug。东财对实际有变动的股东返回数值（股数），
// 仅「不变」返回文本。新增 changeAmount（股数）与 changeRatio（%）数值字段，供判断引擎做
// 定量分析；原 change 文本字段保留，避免破坏旧消费方。
function _parseTopShareholderChange(r) {
  const raw = r.HOLD_NUM_CHANGE;
  const rawRatio = r.CHANGE_RATIO;
  let changeText = null;
  let changeAmount = null; // 股数，正=增持，负=减持
  let changeRatio = null;  // 相对上期持仓比例，正=增持，负=减持

  if (raw != null) {
    if (typeof raw === 'number') {
      changeAmount = raw;
      changeText = raw > 0 ? '增持' : raw < 0 ? '减持' : '不变';
    } else {
      const s = String(raw).trim();
      changeText = s;
      const num = Number(s.replace(/,/g, ''));
      if (!Number.isNaN(num)) {
        changeAmount = num;
      }
    }
  }
  if (rawRatio != null) {
    const ratioNum = Number(rawRatio);
    if (!Number.isNaN(ratioNum)) {
      changeRatio = ratioNum;
    }
  }
  return { changeText, changeAmount, changeRatio };
}

async function fetchTopShareholders(emCode) {
  const stockCode = emCode.slice(2);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=END_DATE&sortTypes=-1&pageSize=10&pageNumber=1&reportName=RPT_F10_EH_HOLDERS&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const data = await dcGet(url);
    const rows = data?.result?.data;
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const latestDate = rows[0].END_DATE;
    return rows
      .filter(r => r.END_DATE === latestDate)
      .map(r => {
        const parsed = _parseTopShareholderChange(r);
        return {
          name: r.HOLDER_NAME || '',
          holdRatio: Number(r.HOLD_NUM_RATIO) || 0,
          holdAmount: Number(r.HOLD_NUM) || 0,
          // 兼容旧字段：文本或数值原样保留
          change: parsed.changeText,
          changeAmount: parsed.changeAmount,
          changeRatio: parsed.changeRatio,
          endDate: (r.END_DATE || '').slice(0, 10),
          type: isInstitution(r.HOLDER_NAME) ? '机构' : '个人/其他',
        };
      });
  } catch (e) {
    console.error('[TopShareholders] failed:', e.message);
    return [];
  }
}

// ---- 机构持仓数量变化（按报告期统计十大股东中的机构户数） ----
async function fetchInstitutionTrend(emCode) {
  const stockCode = emCode.slice(2);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=END_DATE&sortTypes=-1&pageSize=80&pageNumber=1&reportName=RPT_F10_EH_HOLDERS&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const data = await dcGet(url);
    const rows = data?.result?.data;
    if (!Array.isArray(rows) || rows.length === 0) return [];
    // 按报告期分组
    const byDate = {};
    rows.forEach(r => {
      const d = (r.END_DATE || '').slice(0, 10);
      if (!d) return;
      if (!byDate[d]) byDate[d] = [];
      byDate[d].push(r);
    });
    return Object.keys(byDate)
      .sort((a, b) => new Date(a) - new Date(b))
      .map(d => {
        const holders = byDate[d];
        const instCount = holders.filter(h => isInstitution(h.HOLDER_NAME)).length;
        const totalRatio = holders.reduce((s, h) => s + (Number(h.HOLD_NUM_RATIO) || 0), 0);
        return { date: d, institutionCount: instCount, instRatio: Math.round(totalRatio * 100) / 100 };
      });
  } catch (e) {
    console.error('[InstitutionTrend] failed:', e.message);
    return [];
  }
}

// ---- 公司概况（主要产品 / 客户 / 企业性质） ----
// 数据源：东方财富 F10 CompanySurvey（jbzl 数组）。该接口稳定可用。
// 主营构成（产品维度）来自 MainOperate/zygcfx，反爬较严，失败时优雅降级。
async function fetchCompanyProfile(emCode) {
  const url = `https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${emCode}`;
  try {
    const resp = await axios.get(url, { headers: EMWEB_HEADERS, timeout: 10000 });
    const d = resp.data;
    // jbzl 为数组，取最新一条
    const jb = Array.isArray(d?.jbzl) ? d.jbzl[0] : (d?.jbzl?.['0'] || null);
    if (!jb || !jb.ORG_NAME) return null;

    const orgName = jb.ORG_NAME || '';
    const industry = jb.INDUSTRYCSRC1 || jb.INDUSTRY_NAME || '';
    const province = jb.PROVINCE || '';
    const businessScope = jb.BUSINESS_SCOPE || '';
    const orgProfile = jb.ORG_PROFILE || '';

    // 主要产品 / 客户：尽力从 MainOperate 主营构成（产品维度）提取；失败则留空
    let mainProducts = [];
    let mainCustomers = [];
    try {
      const mo = await axios.get(`https://emweb.securities.eastmoney.com/PC_HSF10/MainOperate/PageAjax?code=${emCode}`, { headers: EMWEB_HEADERS, timeout: 8000 });
      const m = mo.data;
      const zy = m?.zygcfx ? (Array.isArray(m.zygcfx) ? m.zygcfx : Object.values(m.zygcfx).filter(x => typeof x === 'object')) : [];
      const prodRows = zy.filter(r => (r.MAINOP_TYPE === '产品' || r.MAINOP_TYPE_NAME === '产品') && r.ITEM_NAME);
      if (prodRows.length) {
        const latest = prodRows.slice().sort((a, b) => new Date(b.REPORT_DATE) - new Date(a.REPORT_DATE))[0];
        mainProducts = [...new Set(prodRows.filter(r => r.REPORT_DATE === latest.REPORT_DATE).map(r => r.ITEM_NAME))].slice(0, 8);
      }
    } catch (e) {
      console.error('[CompanyProfile] MainOperate failed (graceful):', e.message);
    }

    const mainBusiness = orgProfile || businessScope;
    const intro = (businessScope && businessScope !== orgProfile) ? businessScope.slice(0, 300) : '';

    return {
      companyName: orgName,
      ownership: '未知',
      industry,
      mainBusiness,
      mainProducts,
      mainCustomers,
      controllingShareholder: '',
      province,
      intro,
      _raw: { empNum: jb.EMP_NUM },
    };
  } catch (e) {
    console.error('[CompanyProfile] failed:', e.message);
    return null;
  }
}

// 根据前十大股东名称推断企业性质（仅供参考，非权威判定）
const GOV_KEYWORDS = ['国资委', '国有', '国资', '中央汇金', '证金', '社保基金', '财政部', '国家', '汇金', '中国烟草', '铁道', '电网', '石油', '石化', '人民政府', '资产经营', '投资控股', '产业发展', '城市建设', '交通投资'];
const PROVINCE_RE = /(北京|上海|天津|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|深圳|广州|杭州|南京|武汉|成都|青岛|宁波|厦门|苏州|西安)/;
function inferOwnership(topHolders) {
  if (!topHolders || !topHolders.length) return '未知';
  const names = topHolders.map(h => h.name || '');
  // 任一前十大股东命中国资关键词 → 国有控股（覆盖第一大为名义持有人的情况）
  if (names.some(n => GOV_KEYWORDS.some(k => n.includes(k)))) return '国有控股';
  const top = names[0];
  // 第一大股东为港股通名义持有人，无法据此判定实际控制人
  if (/香港中央结算|中央结算\(代理人\)|代理人有限公司/.test(top)) {
    return '无法判定（含港股通名义持有人）';
  }
  // 省级行政区 + 强国资信号（集团/国资/国有/城建）才推断为地方国企，避免误判民营投资公司为国企
  if (PROVINCE_RE.test(top) && /(集团|国资|国有|城建|发展投资集团)/.test(top)) {
    return '国有控股（推断）';
  }
  if (isInstitution(top)) return '机构控股';
  return '民营 / 其他';
}

/**
 * 汇总股东分析数据
 */
async function getShareholdersData(symbol) {
  const emCode = toEMCode(symbol);
  if (!emCode) {
    return { error: '仅支持 A 股市场股东分析', supported: false };
  }
  const research = await fetchShareholderResearch(emCode);
  const [holderCountTrend, topShareholders, institutionTrend] = await Promise.all([
    Promise.resolve(parseHolderCountTrend(research)),
    fetchTopShareholders(emCode),
    fetchInstitutionTrend(emCode),
  ]);
  const institutionHoldings = parseInstitutionHoldings(research);
  const fundHoldings = parseFundHoldings(research);

  const controllingShareholder = topShareholders[0]?.name || '';

  return {
    symbol,
    emCode,
    supported: true,
    holderCountTrend,
    institutionHoldings,
    fundHoldings,
    topShareholders,
    institutionTrend,
    controllingShareholder,
    holderCountTrendAvailable: holderCountTrend.length > 0,
    institutionHoldingsAvailable: institutionHoldings.length > 0,
    fundHoldingsAvailable: fundHoldings.length > 0,
    topShareholdersAvailable: topShareholders.length > 0,
    institutionTrendAvailable: institutionTrend.length > 0,
  };
}

/**
 * 汇总公司概况数据（含企业性质推断）
 */
async function getCompanyProfile(symbol) {
  const emCode = toEMCode(symbol);
  if (!emCode) {
    return { error: '仅支持 A 股公司概况', supported: false };
  }
  const [profile, topShareholders] = await Promise.all([
    fetchCompanyProfile(emCode),
    fetchTopShareholders(emCode),
  ]);
  if (!profile) {
    return { error: '暂未获取到公司概况数据', supported: true };
  }
  const controllingShareholder = topShareholders[0]?.name || '';
  const ownership = inferOwnership(topShareholders);
  return {
    ...profile,
    controllingShareholder,
    ownership,
    supported: true,
  };
}

module.exports = {
  toEMCode,
  isACode,
  getShareholdersData,
  getCompanyProfile,
};
