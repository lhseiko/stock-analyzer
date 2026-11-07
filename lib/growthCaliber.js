/**
 * lib/growthCaliber.js — 增长类指标口径设置（20261104b，用户指令：单季/累计一键切换）
 *
 * 背景：20261102a 起「单季优先」（DJD_*_YOY 优先，缺失回退累计 *_TZ）；用户 20261104 决策：
 * 增长指标（营收/利润/扣非）口径应可一键切换（单季 ↔ 累计），切换后对应指标分析
 * （左卡关键财务指标 / 右卡指标分析 / 顶栏 tiles / 信号判定 / 历史百分位）同步切换。
 *
 * 设计：
 *  - 持久化 data/settings.json { growthCaliber: 'sq' | 'cum' }，默认 'sq'（沿用 20261102a 行为）。
 *  - 口径只影响「同比主值」取数字段的**优先级顺序**：sq = 单季 DJD 优先回退累计；cum = 累计 TZ 优先回退单季
 *    （组内逐字段回退的既有稳健机制不变，仅重排优先级——orderedYoYFields）。
 *  - 口径不影响的模块（保持单季优先，各有独立口径语义）：sameDayJudgment 短期行情判断因子、
 *    deep 深度分析年度结论序列、stockData 原始快照字段（revenueYoy/profitYoy 仍 DJD 优先落库）。
 *  - 环比维度（单季绝对额环比·本机计算）与本设置无关，始终如实标注口径。
 *  - 测试重定向：环境变量 SA_SETTINGS_FILE 指定设置文件路径（同 SA_NOTES_FILE 模式）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'settings.json');
const settingsFile = () => process.env.SA_SETTINGS_FILE || DEFAULT_FILE;

// mtime 检测缓存：外部改文件即时生效，不重复读盘
let cache = { mtimeMs: 0, val: null };

function readSettings() {
  try {
    const st = fs.statSync(settingsFile());
    if (!cache.val || cache.mtimeMs !== st.mtimeMs) {
      cache = { mtimeMs: st.mtimeMs, val: JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {} };
    }
    return cache.val;
  } catch (e) {
    return {};
  }
}

/** 当前增长口径：'sq'（单季优先，默认）| 'cum'（累计优先） */
function getGrowthCaliber() {
  const v = readSettings().growthCaliber;
  return v === 'cum' ? 'cum' : 'sq';
}

/** 口径中文标签 */
function growthCaliberLabel(c) {
  return (c || getGrowthCaliber()) === 'cum' ? '累计口径' : '单季优先口径';
}

/** 设置口径并持久化（原子写：tmp + rename）；非法值抛错 */
function setGrowthCaliber(c) {
  if (c !== 'sq' && c !== 'cum') throw new Error('growthCaliber 必须是 sq（单季优先）或 cum（累计优先）');
  const file = settingsFile();
  let s = {};
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (e) { s = {}; } // 文件不存在/损坏 → 从空设置开始（默认口径 sq）
  s.growthCaliber = c;
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, file);
  cache = { mtimeMs: 0, val: null };
  return getGrowthCaliber();
}

/**
 * 增长类同比取数字段组：按当前口径重排优先级。
 * @param {string[]} pair 固定 [单季字段, 累计字段]（如 ['DJD_TOI_YOY', 'TOTALOPERATEREVETZ']）
 * @param {'sq'|'cum'} caliber 可选，缺省读当前设置
 * @returns {string[]} sq → 原序（单季优先回退累计）；cum → 反序（累计优先回退单季）
 */
function orderedYoYFields(pair, caliber) {
  const cal = caliber || getGrowthCaliber();
  if (!Array.isArray(pair) || pair.length !== 2) return pair;
  return cal === 'cum' ? [pair[1], pair[0]] : [pair[0], pair[1]];
}

module.exports = { getGrowthCaliber, setGrowthCaliber, growthCaliberLabel, orderedYoYFields };
