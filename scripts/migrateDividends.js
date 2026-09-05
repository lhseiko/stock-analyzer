// scripts/migrateDividends.js — 批量把分红历史迁入本地 SQLite（一次性回填，不依赖 UI）
//
// 用法：
//   node scripts/migrateDividends.js                 # 默认回填常用 A 股样本
//   node scripts/migrateDividends.js 601318 600519  # 指定代码
//
// 说明：
//   - 复用 deepAnalysis.fetchDividends（单一权威源，规则一）抓取原始派息记录；
//   - 经 persistDividends 写入 SQLite 的 series 表（dividend_per_share / dividend_total_yi），
//     每条带 来源/获取时间/实际时间 五要素，并自动按 as_of 排序供边际分析。
//   - 网络不通时单只失败不中断整体，会在末尾汇总。

const path = require('path');
const db = require('../lib/db');
const { fetchDividends, persistDividends } = require('../lib/deepAnalysis');

const DEFAULT_SYMBOLS = [
  '601318', // 中国平安
  '600519', // 贵州茅台
  '603288', // 海天味业
  '601628', // 中国人寿
  '601336', // 新华保险
  '601319', // 中国人保
  '601601', // 中国太保
  '000001', // 平安银行
  '600036', // 招商银行
  '000333', // 美的集团
];

async function migrateOne(symbol) {
  const norm = symbol.replace(/^(SH|SZ|BJ|sh|sz|bj)/, '');
  try {
    const rows = await fetchDividends(norm);
    persistDividends(norm, norm, rows);
    return { symbol: norm, ok: true, count: (rows || []).length };
  } catch (e) {
    return { symbol: norm, ok: false, error: e.message };
  }
}

async function main() {
  db.initDb();
  const args = process.argv.slice(2);
  const symbols = args.length ? args : DEFAULT_SYMBOLS;

  console.log(`\n开始回填分红历史，共 ${symbols.length} 只...\n`);
  const results = [];
  for (const s of symbols) {
    const r = await migrateOne(s);
    results.push(r);
    console.log(
      r.ok
        ? `  ✓ ${r.symbol.padEnd(8)} 已写入 ${r.count} 条派息记录`
        : `  ✗ ${r.symbol.padEnd(8)} 失败：${r.error}`
    );
  }

  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  console.log(`\n完成：成功 ${ok} 只，失败 ${fail} 只。`);
  console.log(`数据库位置：${db.DB_PATH}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('迁移脚本异常：', e);
  process.exit(1);
});
