/**
 * 东方财富「股票回购」结构化数据（datacenter-web 报表 RPTA_WEB_GETHGLIST_NEW）
 * ==================================================================
 * 背景（2026-09-21）：个股页「增持减持 → 股份回购」子卡片此前只在**公告/新闻标题里正则扫「回购」二字**，
 * 命中一条含「回购」的新闻标题就计 1 次、并把标题原文塞进 detail。结果：卡片显示「回购 1 次」+ 一条
 * 无关新闻标题（如「…回应二股东减持及回购力度…」），**用户真正要看的数据（已回购多少股/多少钱、
 * 承诺回购多少钱、进度到哪了）一个都没提炼出来**。
 *
 * 本模块走东财**官方回购数据页**（https://data.eastmoney.com/gphg/）背后的同一张报表，直接拿结构化字段。
 * 报表由该页 JS（/newstatic/js/gphg/list.js）暴露，参数与字段均已实测确认。
 *
 * 报表：RPTA_WEB_GETHGLIST_NEW
 *   filter = (DIM_SCODE="600909")   ← 6 位代码，不带交易所前缀
 *   columns=ALL  source=WEB  client=WEB  pageSize=50
 *
 * 关键字段（单位：金额=元，数量=股）：
 *   REPURPROGRESS      实施进度码（**需解码**，见 PROGRESS_MAP）
 *   REPURNUM  / REPURAMOUNT      已回购数量 / 已回购金额
 *   REPURAMOUNTLOWER / REPURAMOUNTLIMIT   承诺回购金额下限 / 上限
 *   REPURNUMLOWER    / REPURNUMCAP        承诺回购数量下限 / 上限
 *   REPURPRICECAP / REPURPRICELOWER1..    价格上限 / 实际成交价区间（上限/下限）
 *   REPURSTARTDATE / REPURENDDATE         回购起始 / 截止日
 *   FINISHDATE / UPD / NOTICEDATE         完成日 / 最新公告日
 *   DIM_DATE                              该档回购方案的报告期（用于多档取最新）
 *
 * ⚠️ 一只股票可能同时有**多档**回购方案（实测：宁德时代 3 档、工业富联 4 档、海天味业 2 档），
 *   必须按公告日 / 报告期取**最新一档**，否则会把历史已完成的老方案当成当前进度。
 *
 * 本模块刻意**不依赖 stockData / 不用 axios**（原因同 emDataCenter.js：避免循环 require、绕开代理环境变量）。
 */
const { REPORTS, fetchReport } = require('./emDataCenter');

/** 回购报表名（东财回购数据页 /newstatic/js/gphg/list.js 中 hgsjSearchObj.reportName） */
const BUYBACK_REPORT = 'RPTA_WEB_GETHGLIST_NEW';

/**
 * 实施进度码 → 中文（逐字对齐东财前端 switch 分支，勿改写）：
 * list.js 中 case "001"~"006"，default 走「未知」。
 */
const PROGRESS_MAP = {
  '001': '董事会预案',
  '002': '股东大会通过',
  '003': '股东大会否决',
  '004': '实施中',
  '005': '停止实施',
  '006': '完成实施',
};

const CALL_TIMEOUT_NOTE = '东财回购报表';

/**
 * 回购方案的「信号强度」与「阶段」判定（20260921k 新增，用户 2026-09-21 要求）。
 *
 * 设计原则（为什么这样分）：回购对股价的**利好来源是「未来的买入力量」**——
 * 公司承诺的钱还没花完，才意味着后续仍有持续买盘托底。反之：
 *   · **完成实施**：承诺的钱已花完、买盘结束 → **中性**（这是用户本次明确要求的）；
 *   · **停止实施 / 股东大会否决**：计划落空 → 中性（不能算利好）；
 *   · **董事会预案 / 股东大会通过**：钱还没开始花，最"新鲜" → 最强利好；
 *   · **实施中**：正在花钱、且通常还剩额度 → 利好，力度看进度（越早越强）。
 *
 * 返回值：
 *   signal  ∈ [-1,1] 供 factorHoldings 使用（0 = 中性）
 *   neutral / reason  供文案标注（说明"为何按中性处理"）
 */
function gradeSignal(progressCode, progressPct) {
  const code = String(progressCode || '').trim();
  switch (code) {
    case '001': // 董事会预案：尚未实施，最"新鲜"
      return { signal: 0.9, stage: '预案', neutral: false, reason: '回购方案刚披露、尚未开始实施，后续买入力量最充足' };
    case '002': // 股东大会通过：即将实施
      return { signal: 0.8, stage: '待实施', neutral: false, reason: '回购方案已获股东大会通过、即将实施' };
    case '004': { // 实施中：力度按进度衰减（越早越强），封顶 0.75
      const pct = (typeof progressPct === 'number' && progressPct >= 0) ? progressPct : 0;
      const decay = Math.max(0.2, 1 - pct / 100);
      const signal = Number((0.75 * decay).toFixed(4));
      const nota = pct >= 90 ? '（已接近承诺上限，剩余买入力量有限）' : '';
      return { signal, stage: '实施中', neutral: false, reason: `回购实施中、剩余额度约 ${(100 - pct).toFixed(1)}%${nota}` };
    }
    case '006': // 完成实施：钱已花完、买盘结束 → 中性（用户 2026-09-21 明确要求）
      return { signal: 0, stage: '已完成', neutral: true, reason: '回购已完成实施，承诺买入力量已用尽，对后续股价不再构成增量利好' };
    case '005': // 停止实施：计划落空
      return { signal: 0, stage: '已停止', neutral: true, reason: '回购已停止实施，计划落空，不计入利好' };
    case '003': // 股东大会否决：计划落空
      return { signal: 0, stage: '被否决', neutral: true, reason: '回购方案被股东大会否决，计划落空，不计入利好' };
    default:
      return { signal: 0, stage: '未知', neutral: true, reason: '回购进度未知，按中性处理' };
  }
}

/** 数字解析：把 '1,234.5' / 数值 / 空串统一成 number|null */
function num(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DD HH:mm:ss' | Date → 'YYYY-MM-DD'（无效返回 ''） */
function ymd(v) {
  if (!v) return '';
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

/** 数量：股 → 中文可读（万/亿），保留 2 位 */
function fmtShares(v) {
  const n = num(v);
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿股`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万股`;
  return `${n.toFixed(0)}股`;
}

/**
 * 金额：元 → 中文可读（万/亿），保留 2 位。
 * 刻意不用「元」直接展示（本项目回购金额量级普遍在千万~百亿，用户看惯「亿元」）。
 */
function fmtMoney(v) {
  const n = num(v);
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿元`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(2)}万元`;
  return `${n.toFixed(0)}元`;
}

/** 元 → 亿（数值，供计算完成率用；不取整，避免比值失真） */
function toYi(v) { const n = num(v); return n == null ? null : n / 1e8; }

/** 该档回购方案的「数据日期」：优先最新公告日，退化到完成日/报告期 */
function recordDate(row) {
  return ymd(row.UPD) || ymd(row.NOTICEDATE) || ymd(row.SHMRSLTNOTICEDATE)
    || ymd(row.FINISHDATE) || ymd(row.DIM_DATE) || '';
}

/** 排序键：公告日 > 报告期（都有则取最大；字符串比较对 'YYYY-MM-DD' 安全） */
function sortKey(row) {
  const a = ymd(row.UPD) || ymd(row.NOTICEDATE);
  const b = ymd(row.DIM_DATE);
  return a > b ? a : b;
}

/**
 * 把一行报表记录规范化为展示所需的四要素（+ 若干辅助字段）。
 * 四要素严格对齐用户要求：数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度。
 */
function normalize(row) {
  const progressCode = String(row.REPURPROGRESS || '').trim();
  const progress = PROGRESS_MAP[progressCode] || (progressCode ? `未知(${progressCode})` : '未知');

  const boughtShares = num(row.REPURNUM);
  const boughtAmount = num(row.REPURAMOUNT);
  const promiseLow = num(row.REPURAMOUNTLOWER);
  const promiseHigh = num(row.REPURAMOUNTLIMIT);
  const priceCap = num(row.REPURPRICECAP);
  const didLow = num(row.REPURPRICELOWER1);
  const didHigh = num(row.REPURPRICECAP1);
  const startDate = ymd(row.REPURSTARTDATE);
  const endDate = ymd(row.REPURENDDATE);
  const finishDate = ymd(row.FINISHDATE);

  // 承诺回购金额：区间（低~高）/ 仅上限 / 仅下限
  let promiseText = '—';
  if (promiseLow != null && promiseHigh != null) {
    promiseText = promiseLow === promiseHigh ? fmtMoney(promiseLow) : `${fmtMoney(promiseLow)}~${fmtMoney(promiseHigh)}`;
  } else if (promiseHigh != null) promiseText = `不超${fmtMoney(promiseHigh)}`;
  else if (promiseLow != null) promiseText = `不低于${fmtMoney(promiseLow)}`;

  // 完成率：已回购金额 / 承诺金额上限（上限是公司承诺的最多投入，最能反映"还剩多少要做"）
  let progressPct = null;
  if (boughtAmount != null && promiseHigh != null && promiseHigh > 0) {
    progressPct = (boughtAmount / promiseHigh) * 100;
  }

  return {
    progressCode,
    progress,
    // ① 数据日期
    date: recordDate(row),
    // ② 已回购数量和金额
    boughtShares, boughtAmount,
    boughtSharesText: fmtShares(boughtShares),
    boughtAmountText: fmtMoney(boughtAmount),
    // ③ 承诺回购金额
    promiseLow, promiseHigh, promiseText,
    promiseLowYi: toYi(promiseLow), promiseHighYi: toYi(promiseHigh),
    // ④ 回购进度
    progressPct: progressPct == null ? null : Number(progressPct.toFixed(1)),
    // 信号判定（20260921k）：完成/停止/否决 → 中性；预案/通过/实施中 → 利好（见图 gradeSignal 注释）
    ...(() => { const g = gradeSignal(progressCode, progressPct); return { signal: g.signal, stage: g.stage, neutral: g.neutral, signalReason: g.reason }; })(),
    // 辅助
    priceCap, didLow, didHigh, startDate, endDate, finishDate,
    // 原始行（排查用，前端不展示）
    raw: row,
  };
}

/**
 * 取某只股票**当前（最新一档）**回购方案。
 * @param {string} symbol 股票代码（可带 SH/SZ 前缀，内部归一为 6 位）
 * @returns {Promise<{ok:boolean, reason?:string, plan?:object, plans?:Array<object>}>}
 *   ok=false 且 reason='none'    → 确实没有回购记录（正常情况，按中性处理）
 *   ok=false 且 reason='error'   → 取数失败（网络/报表异常，**不可**当成"无回购"）
 */
async function getBuybackPlan(symbol) {
  const code = String(symbol || '').replace(/^(SH|SZ|BJ)/i, '').trim();
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'error', error: '股票代码非法: ' + symbol };

  let rows;
  try {
    rows = await fetchReport(BUYBACK_REPORT, {
      filter: `(DIM_SCODE="${code}")`,
      pageSize: 50,
      pageNumber: 1,
    });
  } catch (e) {
    return { ok: false, reason: 'error', error: e.message };
  }
  if (!rows.length) return { ok: false, reason: 'none' };

  // 多档方案 → 按公告日/报告期取最新一档，其余保留供参考
  const sorted = rows.slice().sort((a, b) => (sortKey(a) < sortKey(b) ? 1 : sortKey(a) > sortKey(b) ? -1 : 0));
  const plans = sorted.map(normalize);
  return { ok: true, plan: plans[0], plans };
}

/**
 * 生成「数据日期 / 已回购数量和金额 / 承诺回购金额 / 回购进度」四要素**字符串**
 * （前端子卡片的 value/detail 用）。严格按用户 2026-09-21 指定的格式与顺序。
 * 刻意返回 string（而非 {value, detail}）——调用方会直接拼进文案，
 * 返回对象极易被误当字符串用而在页面上渲染出 `[object Object]`。
 */
function formatPlan(plan) {
  if (!plan) return '未检索到股份回购记录';
  const parts = [];
  if (plan.date) parts.push(`数据日期 ${plan.date}`);
  parts.push(`已回购 ${plan.boughtSharesText}·${plan.boughtAmountText}`);
  parts.push(`承诺回购 ${plan.promiseText}`);
  parts.push(`进度 ${plan.progress}${plan.progressPct != null ? `（已达承诺上限 ${plan.progressPct}%）` : ''}`);
  return parts.join('；');
}

module.exports = {
  BUYBACK_REPORT,
  PROGRESS_MAP,
  getBuybackPlan,
  formatPlan,
  gradeSignal,
  fmtShares,
  fmtMoney,
  normalize,
};
