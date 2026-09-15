/**
 * Shareholder & Company Profile Data Module (issue5 / issue6)
 *
 * 实时抓取东方财富 F10 数据，所有请求均带超时与异常兜底：
 *   - 股东户数走势   (F10 ShareholderResearch gdrs)
 *   - 十大股东 / 十大流通股东 (RPT_F10_EH_HOLDERS，取最新一期「满10行完整披露」，
 *     含非季度末的权益变动/临时披露日，如海天味业 2026-07-03)
 *   - 机构持仓变化（机构家数 / 占流通股比，全历史） (RPT_MAIN_ORGHOLD)
 *   - 基金持股明细   (F10 ShareholderResearch jjcg)
 *   - 公司概况（主要产品 / 客户 / 企业性质）(CompanySurvey PageAjax)
 *
 * 任一子请求失败都不会让整个接口报错，前端按"暂无数据"优雅降级。
 */

const axios = require('axios');
const { resolveSectorIdentity } = require('./sectorIdentity');

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

// 报告期判定（20260913g 修订）。东财 RPT_F10_EH_HOLDERS 的 END_DATE 有三类：
//   ① 季度末（03-31 / 06-30 / 09-30 / 12-31）——标准定期披露，通常 10 行；
//   ② 非季度末的权益变动 / 临时公告日——东财对最新股东名册同样给完整 10 行
//      （如海天味业 2026-07-03 = 10 行完整披露，且比最近季度末 2026-06-30 更新）；
//   ③ 残缺临时行——仅 1 行（如长江电力 2026-08-22），不能当作报告期。
// 旧逻辑「只认季度末」会把 ② 整段丢弃，表现为「东财已有 7 月数据、工作台却仍显示 6-30」
// （用户反馈：「你不能只盯着财报」）。现改为：优先取「最新一个满 10 行的完整披露日」
// （不区分是否季度末）；只有当没有任何满 10 行的日期时，才退回最近季度末 → 最近日期。
const QUARTER_END_RE = /-(03-31|06-30|09-30|12-31)$/;
const MIN_FULL_ROWS = 10; // 完整披露应达到的行数（十大股东 / 十大流通股东）
function isQuarterEnd(d) {
  return QUARTER_END_RE.test(String(d || '').slice(0, 10));
}
// 在若干日期中优先取「最近的季度末」；若一条季度末都没有，才退回最近日期（保证极端情况下仍可用）
function pickLatestReportDate(dates) {
  const uniq = [...new Set(dates.filter(Boolean))].sort();
  const q = uniq.filter(isQuarterEnd);
  return (q.length ? q[q.length - 1] : uniq[uniq.length - 1]) || '';
}
// 从原始行中选出「最新一个满 10 行的完整披露日」；无满 10 行的日期时退回 pickLatestReportDate。
// 返回 { date, kind }；kind = 季度末报告期 | 最新披露（权益变动/临时公告）。
function pickLatestDisclosure(rows) {
  const byDate = {};
  for (const r of rows) {
    const d = String(r.END_DATE || '').slice(0, 10);
    if (d) byDate[d] = (byDate[d] || 0) + 1;
  }
  const dates = Object.keys(byDate).sort();
  if (!dates.length) return { date: '', kind: '' };
  const full = dates.filter(d => byDate[d] >= MIN_FULL_ROWS);
  const date = full.length ? full[full.length - 1] : pickLatestReportDate(dates);
  if (!date) return { date: '', kind: '' };
  return { date, kind: isQuarterEnd(date) ? '季度末报告期' : '最新披露（权益变动/临时公告）' };
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
// 注：jgcc 只返回最新一期数据，且按 ORG_TYPE 拆成多条记录，已弃用。
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

// ---- 机构持仓变化趋势（datacenter-web RPT_MAIN_ORGHOLD：多报告期机构家数 / 占流通股比）----
async function fetchInstitutionHoldingsTrend(emCode) {
  const stockCode = emCode.slice(2);
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=REPORT_DATE&sortTypes=1&pageSize=1000&pageNumber=1&reportName=RPT_MAIN_ORGHOLD&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const data = await dcGet(url);
    const rows = data?.result?.data;
    if (!Array.isArray(rows) || rows.length === 0) return [];

    const byDate = {};
    rows.forEach(r => {
      // 仅取“机构汇总”这一行，避免同一日期出现基金/券商等明细条目
      if (String(r.ORG_TYPE) !== '00') return;
      const d = (r.REPORT_DATE || '').slice(0, 10);
      if (!d) return;
      byDate[d] = {
        date: d,
        orgNum: Number(r.HOULD_NUM) || 0,
        freeShares: Number(r.FREE_SHARES) || 0,
        freeRatio: Number(r.FREESHARES_RATIO) || 0,
        totalShares: Number(r.TOTAL_SHARES) || 0,
        totalRatio: Number(r.TOTALSHARES_RATIO) || 0,
        holdChaNum: Number(r.HOLDCHA_NUM) || 0,
        holdChaRatio: Number(r.HOLDCHA_RATIO) || 0,
      };
    });

    const sorted = Object.values(byDate).sort((a, b) => new Date(a.date) - new Date(b.date));
    // 计算相邻报告期间的绝对变化
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      cur.orgNumChange = cur.orgNum - prev.orgNum;
      cur.freeRatioChange = +(cur.freeRatio - prev.freeRatio).toFixed(4);
    }
    return sorted;
  } catch (e) {
    console.error('[InstitutionHoldingsTrend] failed:', e.message);
    return [];
  }
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
  // pageSize 提高到 80：原来只取 10 条，会在「临时公告日」有零星记录时把最新报告期挤掉（如长江电力只剩 1 条）
  const url = `https://datacenter-web.eastmoney.com/api/data/v1/get?sortColumns=END_DATE&sortTypes=-1&pageSize=80&pageNumber=1&reportName=RPT_F10_EH_HOLDERS&columns=ALL&filter=(SECURITY_CODE=%22${stockCode}%22)`;
  try {
    const data = await dcGet(url);
    const rows = data?.result?.data;
    if (!Array.isArray(rows) || rows.length === 0) return [];
    // 20260913g：取「最新一个满 10 行的完整披露日」，不再只认季度末——
    // 保证东财已展示的非季度末更新（如海天味业 2026-07-03 完整 10 行）能被工作台同步；
    // 残缺临时行（如长江电力 2026-08-22 仅 1 行）因不满 10 行被自然排除。
    const picked = pickLatestDisclosure(rows);
    const latestDate = picked.date;
    const periodRows = rows.filter(r => (r.END_DATE || '').slice(0, 10) === latestDate);
    return periodRows.map(r => {
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
        // 20260913g：报告期性质（季度末 vs 非季度末最新披露），供前端/判断因子正确标注新鲜度
        periodKind: picked.kind,
        type: isInstitution(r.HOLDER_NAME) ? '机构' : '个人/其他',
      };
    });
  } catch (e) {
    console.error('[TopShareholders] failed:', e.message);
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
  const [holderCountTrend, topShareholders, institutionHoldings] = await Promise.all([
    Promise.resolve(parseHolderCountTrend(research)),
    fetchTopShareholders(emCode),
    fetchInstitutionHoldingsTrend(emCode),
  ]);
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
    controllingShareholder,
    holderCountTrendAvailable: holderCountTrend.length > 0,
    institutionHoldingsAvailable: institutionHoldings.length > 0,
    fundHoldingsAvailable: fundHoldings.length > 0,
    topShareholdersAvailable: topShareholders.length > 0,
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
  const [profile, topShareholders, identity] = await Promise.all([
    fetchCompanyProfile(emCode),
    fetchTopShareholders(emCode),
    resolveSectorIdentity(symbol).catch(() => null),
  ]);
  if (!profile) {
    return { error: '暂未获取到公司概况数据', supported: true };
  }
  // 20260915：用 sectorIdentity 的精确行业覆盖 F10 原始 CSRC 分类。
  // 例：688660 电气风电 F10 CSRC=制造业-通用设备制造业，但真实业务是风电设备，
  //     泛化的 CSRC 名称会导致行业板块走势/涨跌停/公司概况全部错配。
  const preciseIndustry = identity
    ? (identity.f10Name || identity.emIndustry || identity.industry || '')
    : '';
  if (preciseIndustry) {
    profile.industry = preciseIndustry;
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
  // 20260913g：导出纯函数供离线单测（scripts/test_shareholder_period.js）验证报告期选取，不参与业务调用
  _pickLatestDisclosure: pickLatestDisclosure,
  _isQuarterEnd: isQuarterEnd,
};
