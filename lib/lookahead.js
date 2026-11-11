/**
 * lib/lookahead.js — 前视偏差结算侧审计（20261110g · 整改方案阶段 1 P0-1）
 * ==================================================================================
 * 用户裁决：前视偏差只做结算侧。范围 = 4 条结算链：
 *   sameDayJudgment（个股 6 因子次日/当日结算）、marketTechJudgment（上证短/中期）、
 *   techFaceJudgment（技术面形态 HORIZON 窗口）、sentimentAccuracy（情绪预警 vs 次日上证）。
 *
 * 审计结论（2026-11-10 实查，详见 docs/logic/common-06b-lookahead.md）：
 *   四条链的**结算计算本体**只消费 K 线收盘价与交易日历——K 线在「目标日已收盘」后才可用，
 *   结算函数已有 targetDate===today && !marketClosed 守卫 → 结算计算本体无前视。
 *   真正的风险在**记录内容侧**：判断记录的因子快照（融资余额/龙虎榜/财报期等带披露时滞的数据）
 *   在落盘记录里大多**没有逐项可得时间戳**，历史记录无法逐项复核。可强校验的时间戳只有：
 *     ① rec.generatedAt（判断生成时刻 = asOf 的唯一权威口径）
 *     ② rec.reportEvent.date（财报披露日）
 *     ③ 记录内嵌的 dataTime / fetchedAt 散点时间戳（部分因子带）
 *
 * 本模块职责（代码权威，LLM 零参与）：
 *   auditSettlement(rec, opts) → 对一条已结算/待结算记录做前视校验，返回违规清单；
 *   违规记录**不悄悄剔除**：结算侧照常算出事实结果（actualDir 等），但打
 *   rec.lookaheadExcluded = true + reasons，准确率统计把这类记录计入「不可比样本」如实披露。
 *
 * 口径（方案原文）：数据可得时间 ≤ asOf + 结算窗口 才允许参与可比样本；
 *   补录字段（formal→complete 升级数据）不进当日结算，只做次级参考行（由各链落盘字段留痕）。
 */
'use strict';

const ROLLBACK_GRACE_DAYS = 1; // dataTime 为本地日期、fetchedAt/generatedAt 为 UTC 日期，跨时区边界宽限 1 天

function pad(n) { return String(n).padStart(2, '0'); }

/** ISO 时间戳或 YYYY-MM-DD → 'YYYY-MM-DD'（统一按 UTC 日历日比较，两侧同基准）。 */
function dateOf(ts) {
  if (!ts) return null;
  const s = String(ts);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  return null;
}

function addDays(dateStr, n) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
}

/**
 * 审计一条判断记录的前视风险。
 * @param {object} rec  判断记录（须含 generatedAt 或 date/baseDate；可含 reportEvent / settledAt）
 * @param {object} opts { windowDays?: number } 结算窗口（交易日数的日历日宽松上界，默认 10）
 * @returns {{ asOf: string|null, windowDays: number, violations: Array<{code,field,detail}>, excluded: boolean }}
 */
function auditSettlement(rec, opts) {
  const o = opts || {};
  const windowDays = (typeof o.windowDays === 'number') ? o.windowDays : 10;
  const violations = [];

  // asOf 口径：判断生成时刻（UTC 日历日）。无 generatedAt 的旧记录回退 rec.date / rec.baseDate。
  const asOf = dateOf((rec && rec.generatedAt)) || (rec && rec.date) || (rec && rec.baseDate) || null;
  if (!asOf) {
    return { asOf: null, windowDays, violations: [], excluded: false, note: '记录无 generatedAt/date/baseDate，无法审计（按原口径计入可比样本）' };
  }
  const limit = addDays(asOf, windowDays + ROLLBACK_GRACE_DAYS);

  // L1 财报披露日晚于判断生成日：财报解读类输入在判断时点不可得
  const repDate = dateOf(rec && rec.reportEvent && rec.reportEvent.date);
  if (repDate && repDate > asOf) {
    violations.push({
      code: 'L1_report_after_asof', field: 'reportEvent.date',
      detail: '财报披露日 ' + repDate + ' 晚于判断生成日 ' + asOf + '（判断时点不可得）',
    });
  }

  // L2 结算时点早于目标日收盘（结算不该在目标日数据可得前发生）
  const settledAt = dateOf(rec && rec.settledAt);
  const effTarget = (rec && rec.targetDate) || (rec && rec.actualTargetDate) || null;
  if (settledAt && effTarget && settledAt < dateOf(effTarget)) {
    violations.push({
      code: 'L2_settled_before_target', field: 'settledAt',
      detail: '结算时点 ' + settledAt + ' 早于目标日 ' + dateOf(effTarget) + '（目标日数据尚未可得）',
    });
  }

  // L3 记录内嵌时间戳越过 asOf+窗口：扫描 dataTime / fetchedAt / asOf 字段散点
  let scanned = '';
  try { scanned = JSON.stringify(rec); } catch (e) { scanned = ''; }
  const patterns = [
    /"(?:dataTime|asOf)"\s*:\s*"(\d{4}-\d{2}-\d{2})/g,
    /"fetchedAt"\s*:\s*"(\d{4}-\d{2}-\d{2})[^"]*"/g,
  ];
  const seen = new Set();
  for (const re of patterns) {
    let m;
    while ((m = re.exec(scanned))) {
      const d = m[1];
      const key = re.source.slice(0, 24) + '|' + d;
      if (seen.has(key)) continue;
      seen.add(key);
      if (d > limit) {
        violations.push({
          code: 'L3_embedded_ts_beyond_window', field: 'embedded timestamp',
          detail: '记录内嵌时间戳 ' + d + ' 越过 asOf(' + asOf + ')+窗口(' + windowDays + 'd)，该数据在判断+结算窗口内不可得',
        });
      }
    }
  }

  return { asOf, windowDays, violations, excluded: violations.length > 0 };
}

/**
 * 结算侧统一挂钩：结算成功后调用。违规 → 打标（不剔除记录本体，事实结果照常留存）。
 * @returns {boolean} 是否打了 lookaheadExcluded
 */
function markSettlement(rec, opts) {
  if (!rec) return false;
  const r = auditSettlement(rec, opts);
  if (r.excluded) {
    rec.lookaheadExcluded = true;
    rec.lookaheadAsOf = r.asOf;
    rec.lookaheadViolations = r.violations;
    return true;
  }
  // 曾被打标但本次审计通过（如数据修复）→ 显式清除并留痕，不静默
  if (rec.lookaheadExcluded) {
    rec.lookaheadExcluded = false;
    rec.lookaheadClearedAt = new Date().toISOString();
  }
  return false;
}

/**
 * 准确率统计的统一口径：把 lookaheadExcluded 记录拆出为「不可比样本」，可比样本单独统计。
 * @param {Array} settled 已结算记录数组
 * @returns {{ valid: Array, excluded: Array }}
 */
function splitComparable(settled) {
  const arr = Array.isArray(settled) ? settled : [];
  return {
    valid: arr.filter(r => !r.lookaheadExcluded),
    excluded: arr.filter(r => r.lookaheadExcluded),
  };
}

/** 不可比样本披露块（computeAccuracy 输出复用，四链口径一致）。 */
function incomparableDisclosure(excluded) {
  return {
    lookaheadExcludedCount: excluded.length,
    incomparableSamples: excluded.slice(0, 50).map(r => ({
      date: r.date || r.baseDate || null,
      symbol: r.symbol || null,
      reasons: (r.lookaheadViolations || []).map(v => v.code + ':' + v.detail.slice(0, 80)),
    })),
  };
}

module.exports = {
  auditSettlement, markSettlement, splitComparable, incomparableDisclosure,
  dateOf, addDays, ROLLBACK_GRACE_DAYS,
  // [执行清单] 预留开关：准确率口径切换（一个月后可能改，现在别写死）
  // 'asOf'（默认）= 排除前视嫌疑记录后的新口径；'legacy' = 含全部已结算记录的旧口径。
  // 前端/接口可按此开关决定展示哪个口径，切换无需改代码结构。
  ACCURACY_CALIBER: 'asOf',
};
