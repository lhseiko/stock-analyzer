/**
 * scripts/test_earnings_symbol_normalize.js —— 财报解读「代码归一化」守卫（任务卡 #024）
 * -------------------------------------------------------------------------
 *   node scripts/test_earnings_symbol_normalize.js
 *
 * 背景：调用方可能传 sh688027 形式，AI 首行声明的是裸码 688027。
 * 未归一化导致 ① 缓存同一标的两份 ② 串公司比对把同一只票误判为不同标的。
 *
 * 覆盖：
 *  1) 生成侧：缓存文件名用裸码、串公司比对用裸码；
 *  2) 读取侧：readEarningsCache 对 sh/SH 前缀与裸码读到同一份；
 *  3) 回归：不再出现 `${symbol}_earnings.json` 的旧写法。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readEarningsCache } = require('../lib/ai/cache');
const { CACHE_DIR } = require('../lib/ai/config');

let pass = 0;
const fail = [];
function check(name, fn) {
  try { fn(); pass++; } catch (e) { fail.push(`✗ ${name}\n    ${e.message}`); }
}

const earnSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai', 'earnings.js'), 'utf8');
const cacheSrc = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai', 'cache.js'), 'utf8');

// ---------------- 1) 生成侧 ----------------
check('生成侧定义 normalizeSymbol', () => {
  if (!/function normalizeSymbol\(symbol\)/.test(earnSrc)) throw new Error('缺少 normalizeSymbol 定义');
});
check('缓存文件使用裸码 symbolBare', () => {
  if (!earnSrc.includes('const symbolBare = normalizeSymbol(symbol)')) throw new Error('未构造 symbolBare');
  if (!earnSrc.includes('`${symbolBare}_earnings.json`')) throw new Error('缓存文件名未使用 symbolBare');
});
check('串公司比对使用裸码', () => {
  if (!earnSrc.includes('earningsTarget.code !== symbolBare')) throw new Error('比对仍在用原始 symbol（前缀会误报）');
});
check('旧写法已清除（不再以原始 symbol 拼缓存键）', () => {
  if (earnSrc.includes('`${symbol}_earnings.json`')) throw new Error('仍存在 `${symbol}_earnings.json`');
});

// ---------------- 2) 读取侧 ----------------
check('readEarningsCache 读入前归一化', () => {
  if (!cacheSrc.includes('normalizeEarningsSymbol(symbol)')) throw new Error('readEarningsCache 未归一化');
});

const probe = '688027';
const hasProbe = fs.existsSync(path.join(CACHE_DIR, `${probe}_earnings.json`));
if (hasProbe) {
  check('裸码与 sh 前缀读到同一份缓存', () => {
    const a = readEarningsCache(probe);
    const b = readEarningsCache('sh' + probe);
    if (!a || !b) throw new Error('任一形式读不到缓存');
    if (a.date !== b.date || a.promptVersion !== b.promptVersion) throw new Error('两种形式读到的不是同一份');
  });
  check('大小写前缀同样归一化（SH688027）', () => {
    const c = readEarningsCache('SH' + probe);
    if (!c) throw new Error('大写前缀读不到缓存');
  });
} else {
  console.log(`（跳过读写实测：缓存目录无 ${probe}_earnings.json）`);
}

check('不存在的标的两种形式都返回 null', () => {
  if (readEarningsCache('999999') !== null) throw new Error('没有缓存却返回了内容');
  if (readEarningsCache('sh999999') !== null) throw new Error('带前缀也没有缓存却返回了内容');
});

// ---------------- 汇总 ----------------
console.log(`\n共 ${pass + fail.length} 项：通过 ${pass}，失败 ${fail.length}`);
if (fail.length) { fail.forEach(f => console.log(f)); process.exitCode = 1; } else { console.log('全部通过'); }
