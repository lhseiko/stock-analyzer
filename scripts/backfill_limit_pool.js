#!/usr/bin/env node
/**
 * backfill_limit_pool.js — 任务卡 #012：按交易日补录涨跌停池到 SQLite
 * ============================================================================
 * 用法：
 *   node scripts/backfill_limit_pool.js --days 20
 *   node scripts/backfill_limit_pool.js --from 2026-10-16 --to 2026-11-13
 *   node scripts/backfill_limit_pool.js --days 20 --source review   （只复用复盘文件，零联网）
 *   node scripts/backfill_limit_pool.js --days 20 --dry-run          （只列计划，不写库）
 *   node scripts/backfill_limit_pool.js --days 20 --force            （显式重写已落盘日，默认禁止）
 *
 * 数据源优先级（--source auto，默认）：
 *   ① data/reviews/{date}.json 最新版本 context.prevPool（当日真实已落盘统计，零联网）
 *   ② getBoardReviewData(date) 按 --date 真实回查（akshare 东财池，单源）
 * 失败日写入报告 data/limit-pool/backfill-report.json，可单独重跑；不编 0、不拿今日快照倒推历史。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const store = require('../lib/limitPoolStore');
const { asOfTradingDate, previousTradingDay, isTradingDay } = require('../lib/cnTradingCalendar');

const ROOT = path.join(__dirname, '..');
const REPORT_DIR = path.join(ROOT, 'data', 'limit-pool');
const REPORT_FILE = path.join(REPORT_DIR, 'backfill-report.json');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return (v == null || v.startsWith('--')) ? def : v;
}
function flag(name) { return process.argv.indexOf('--' + name) >= 0; }

function tradingDates(from, to, limit) {
  const out = [];
  let d = String(to || asOfTradingDate());
  const floor = String(from || '');
  for (let i = 0; i < limit && /^\d{4}-\d{2}-\d{2}$/.test(d); i++) {
    if (floor && d < floor) break;
    if (isTradingDay(d)) out.push(d);
    d = previousTradingDay(d);
  }
  return out.reverse();
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const days = Math.max(1, Math.min(60, Number(arg('days', 20)) || 20));
  const sourceMode = String(arg('source', 'auto'));
  const dryRun = flag('dry-run');
  const force = flag('force');
  const waitMs = Math.max(0, Number(arg('delay', 400)) || 0);
  const to = arg('to', asOfTradingDate());
  const from = arg('from', '');
  const dates = tradingDates(from, to, days);

  console.log(`[涨跌停池补录] 目标 ${dates.length} 个交易日：${dates[0]} → ${dates[dates.length - 1]}`);
  console.log(`[涨跌停池补录] 数据源 ${sourceMode}｜dry-run=${dryRun}｜force=${force}`);

  const report = {
    generatedAt: new Date().toISOString(),
    to, from: from || null, days, sourceMode, dryRun, force,
    dbPath: store.getDbInfo().dbPath,
    items: [], failures: [],
  };
  const saveReport = () => {
    if (dryRun) return;
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2) + '\n', 'utf8');
  };

  let created = 0, skipped = 0, unavailable = 0;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    if (!force && store.getDailyPool(date)) {
      skipped++;
      report.items.push({ date, action: 'skipped', reason: '已有真实落盘记录' });
      console.log(`  [${i + 1}/${dates.length}] ${date} 跳过（已落盘）`);
      saveReport();
      continue;
    }
    if (dryRun) {
      report.items.push({ date, action: 'would-run' });
      console.log(`  [${i + 1}/${dates.length}] ${date} 计划补录（dry-run）`);
      continue;
    }

    let built = null;
    let pathUsed = '';
    if (sourceMode !== 'network') {
      built = store.buildFromReview(date, { backfilled: true });
      pathUsed = 'review';
    }
    if ((!built || !built.ok) && sourceMode !== 'review') {
      try {
        const bd = require('../lib/boardReviewData');
        const raw = await bd.getBoardReviewData(date);
        built = store.buildFromBoardReview(date, raw, { backfilled: true });
        pathUsed = 'network';
      } catch (e) {
        built = { ok: false, reason: '联网取数失败：' + String((e && e.message) || e).slice(0, 180) };
        pathUsed = 'network';
      }
    }
    if (!built || !built.ok) {
      unavailable++;
      const reason = (built && built.reason) || '无可用数据';
      report.items.push({ date, action: 'unavailable', source: pathUsed, reason });
      report.failures.push({ date, reason });
      console.log(`  [${i + 1}/${dates.length}] ${date} 不可用：${reason}`);
      saveReport();
      if (waitMs && i < dates.length - 1) await delay(waitMs);
      continue;
    }

    const r = store.saveDailyPool(Object.assign({ tradeDate: date }, built.row, {
      backfilled: true, force,
    }));
    report.items.push({
      date, action: r.action, source: pathUsed,
      sourceLabel: built.row.source,
      fetchedAt: built.row.fetchedAt,
      redRate: built.row.payload.redRate,
      reason: r.reason || null,
    });
    if (r.action === 'created') created++;
    else if (r.action === 'skipped') skipped++;
    else {
      unavailable++;
      report.failures.push({ date, reason: r.reason });
    }
    console.log(`  [${i + 1}/${dates.length}] ${date} ${r.action}（${pathUsed}｜红盘率 ${built.row.payload.redRate == null ? '缺失' : built.row.payload.redRate + '%'}）`);
    saveReport();
    if (waitMs && i < dates.length - 1) await delay(waitMs);
  }

  report.summary = { total: dates.length, created, skipped, unavailable };
  saveReport();
  console.log(`[涨跌停池补录] 完成：生成 ${created} / 跳过 ${skipped} / 不可用 ${unavailable}`);
  if (!dryRun) console.log(`[涨跌停池补录] 报告：${REPORT_FILE}`);
  console.log('[涨跌停池补录] 落库概览：' + JSON.stringify(store.getDbInfo()));
}

main().catch(e => {
  console.error('[涨跌停池补录] 失败：' + (e && e.stack || e));
  process.exitCode = 1;
});
