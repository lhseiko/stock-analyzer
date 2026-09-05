/**
 * 新闻影响判断 · 自学习数据层
 * --------------------------------------------------------------
 * 记录「新闻 → 板块影响」的判断结果，支持人工更正，持续积累命中情况，
 * 为后续判断（联动市场情绪因子的板块消息联动）提供置信度与学习信号。
 *
 * 存储：data/news_impact_learning.json
 *   { records: [{ id, title, sector, direction, createdAt, corrected, correct, correctedSector, correctedDirection }],
 *     stats: { total, correctedCount, correctCount, bySector: {sector: {total, correct}} } }
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, '..', 'data', 'news_impact_learning.json');
const MAX_RECORDS = 2000;

function readAll() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : { records: [], stats: {} };
  } catch (e) {
    return { records: [], stats: {} };
  }
}

function writeAll(obj) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { /* 忽略 */ }
}

function makeId(title, sector) {
  return crypto.createHash('md5').update(String(title || '') + '|' + String(sector || '')).digest('hex').slice(0, 16);
}

function recomputeStats(records) {
  const stats = { total: records.length, correctedCount: 0, correctCount: 0, bySector: {} };
  for (const r of records) {
    if (!r.corrected) continue;
    stats.correctedCount++;
    if (r.correct) stats.correctCount++;
    if (r.sector) {
      const b = stats.bySector[r.sector] || (stats.bySector[r.sector] = { total: 0, correct: 0 });
      b.total++;
      if (r.correct) b.correct++;
    }
  }
  return stats;
}

// 记录一条判断（幂等：同 id 已存在则跳过/更新）
function recordImpact(title, sector, direction) {
  const all = readAll();
  const id = makeId(title, sector);
  const idx = all.records.findIndex(r => r.id === id);
  if (idx >= 0) {
    // 已存在，不重复记录
    return all.records[idx];
  }
  const rec = {
    id, title: String(title || '').slice(0, 120), sector, direction,
    createdAt: new Date().toISOString(), corrected: false, correct: null,
    correctedSector: null, correctedDirection: null,
  };
  all.records.push(rec);
  if (all.records.length > MAX_RECORDS) all.records = all.records.slice(-MAX_RECORDS);
  all.stats = recomputeStats(all.records);
  writeAll(all);
  return rec;
}

// 更正一条判断：人工反馈该判断是否正确，并可纠正板块/方向
function correctImpact(id, correct, correctedSector, correctedDirection) {
  const all = readAll();
  const rec = all.records.find(r => r.id === id);
  if (!rec) return null;
  rec.corrected = true;
  rec.correct = !!correct;
  if (correctedSector) rec.correctedSector = correctedSector;
  if (correctedDirection) rec.correctedDirection = correctedDirection;
  all.stats = recomputeStats(all.records);
  writeAll(all);
  return rec;
}

function getLearningState() {
  const all = readAll();
  return {
    ...all.stats,
    recent: all.records.slice(-20).reverse(),
    accuracy: all.stats.correctedCount ? Math.round(all.stats.correctCount / all.stats.correctedCount * 100) : null,
  };
}

/**
 * 自动复核（无需人工干预）：用「板块实际涨跌」对照新闻影响判断的方向，自动标记对错。
 * sectorChgMap = { 板块名: 涨跌幅(%) }，通常来自当日收盘的行业板块涨跌幅。
 * 方向规则：direction='up'(看涨) 且板块 chg>0 → 正确；direction='down'(看跌) 且 chg<0 → 正确；否则错误。
 * 已人工更正的记录不再覆盖；中性方向暂不自动复核。
 * 返回 { reviewed, correctN, wrongN, stats }。
 */
function autoReviewImpacts(sectorChgMap) {
  const all = readAll();
  let reviewed = 0, correctN = 0, wrongN = 0;
  for (const r of all.records) {
    if (r.corrected) continue;           // 已复核（人工或自动）不再覆盖
    if (!r.sector || r.direction === 'neutral') continue;
    const chg = (sectorChgMap && typeof sectorChgMap[r.sector] === 'number') ? sectorChgMap[r.sector] : null;
    if (chg == null) continue;           // 该板块涨跌数据缺失，跳过
    const up = r.direction === 'up';
    const correct = up ? chg > 0 : chg < 0;
    r.corrected = true;
    r.correct = correct;
    r.autoReviewed = true;
    r.reviewedAt = new Date().toISOString();
    r.reviewChg = Math.round(chg * 100) / 100;
    reviewed++;
    if (correct) correctN++; else wrongN++;
  }
  if (reviewed > 0) {
    all.stats = recomputeStats(all.records);
    writeAll(all);
  }
  return { reviewed, correctN, wrongN, accuracy: all.stats.correctedCount ? Math.round(all.stats.correctCount / all.stats.correctedCount * 100) : null, stats: all.stats };
}

module.exports = { recordImpact, correctImpact, getLearningState, autoReviewImpacts, makeId };
