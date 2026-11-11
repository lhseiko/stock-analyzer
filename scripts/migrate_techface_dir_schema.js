/**
 * scripts/migrate_techface_dir_schema.js — [20261111a] techFace 归一化口径迁移（一次性）
 * ================================================================================
 * 背景：normalizeDir 口径变更（震荡偏上→涨 / 震荡偏下→跌），见 lib/techFaceJudgment.js
 * 头注释与 docs/logic/stock-08-technical.md「准确率归因记录」。
 *
 * 动作（先备份再改盘）：
 *   1. 整目录备份到 data/tech-face-backup-20261111a/（存在则跳过备份，防重复覆盖）；
 *   2. 每条记录按 shortRaw 重算 shortDir/shortVerdict（用最新 normalizeDir）；
 *   3. 已结算记录按结算公式重算 correct（震荡→|chg|≤容差；否则方向一致）；
 *   4. 全部记录写 schemaVersion='tf-20261111a'；
 *   4b. [20261111b P0] 迁移记录打 migrated: true + migratedAt + migratedFrom 标记——
 *       区分历史迁移记录与 2026-11-12 起的前向新样本，前向验证查询 filter(!r.migrated && r.settled)；
 *   5. 原子写回（lib/store.js writeJsonAtomic）。
 * 幂等：可重复跑，重算结果稳定。shortRaw 是迁移的权威依据（落盘时保留的原始词）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { normalizeDir, verdictOf, FLAT_TOLERANCE, SCHEMA_VERSION, DIR } = require('../lib/techFaceJudgment');
const { writeJsonAtomic } = require('../lib/store');

const BACKUP = path.join(__dirname, '..', 'data', 'tech-face-backup-20261111a');

function round2(x) { return Math.round(x * 100) / 100; }

function main() {
  if (!fs.existsSync(DIR)) { console.error('目录不存在:', DIR); process.exit(1); }

  // 1. 备份（整目录拷贝，已存在则跳过）
  if (!fs.existsSync(BACKUP)) {
    fs.cpSync(DIR, BACKUP, { recursive: true });
    console.log('[备份] 已复制 →', BACKUP);
  } else {
    console.log('[备份] 已存在，跳过（防覆盖）:', BACKUP);
  }

  const files = fs.readdirSync(DIR).filter(f => f.endsWith('.json'));
  let filesChanged = 0, recsChanged = 0, settledRejudged = 0, flips = 0, migratedCount = 0;
  const summary = [];

  for (const f of files) {
    const p = path.join(DIR, f);
    let arr;
    try { arr = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error('解析失败，跳过:', f, e.message); continue; }
    if (!Array.isArray(arr)) continue;

    let fileChanged = false;
    for (const r of arr) {
      if (!r || typeof r !== 'object') continue;
      // [20261111b P0 补丁1] TFA_TEST_ 测试夹具：无 shortRaw，不参与归一化迁移，
      // 但为防止其（一旦 settled）污染 --forward 前向样本，统一打 migrated: true 排除。
      const isFixture = !r.shortRaw && (String(r.symbol || '').startsWith('TFA_TEST_') || String(r.name || '').startsWith('TFA_TEST_'));
      if (isFixture) {
        if (!r.migrated) {
          r.migrated = true;
          r.migratedAt = new Date().toISOString();
          r.migratedFrom = { reason: 'test_fixture' };
          fileChanged = true; migratedCount++;
        }
        continue;
      }
      if (!r.shortRaw) continue;
      const newDir = normalizeDir(r.shortRaw);
      if (newDir == null) continue;                       // 无法归一的原始词不动
      const oldDir = r.shortDir;
      const oldCorrect = r.correct;
      if (newDir !== oldDir) {
        r.shortDir = newDir;
        r.shortVerdict = verdictOf(newDir);
        fileChanged = true; recsChanged++;
      }
      if (r.settled === true && (r.shortDir !== oldDir || r.schemaVersion !== SCHEMA_VERSION)) {
        const chg = Number(r.actualChgPct);
        r.correct = r.shortDir === '震荡'
          ? Math.abs(chg) <= FLAT_TOLERANCE
          : r.shortDir === r.actualDir;
        settledRejudged++;
        if (!!oldCorrect !== !!r.correct) flips++;
      }
      if (r.schemaVersion !== SCHEMA_VERSION) { r.schemaVersion = SCHEMA_VERSION; fileChanged = true; }
      // [20261111b P0] 迁移标记：区分「本次口径迁移的历史记录」与「2026-11-12 起的新记录」。
      // 前向验证查询口径：records.filter(r => !r.migrated && r.settled)（迁移记录不参与前向命中率统计）。
      // migratedFrom 留回溯依据（迁移前的归一化口径与原始词）。幂等：已有 migrated: true 则跳过。
      if (!r.migrated) {
        r.migrated = true;
        r.migratedAt = new Date().toISOString();
        r.migratedFrom = { normalizeDir: 'old(震荡偏上/偏下→震荡)', shortRaw: r.shortRaw };
        fileChanged = true; migratedCount++;
      }
    }

    if (fileChanged) {
      writeJsonAtomic(p, arr);
      filesChanged++;
      summary.push(`  ${f}: 重映射+重判完成`);
    }
  }

  console.log(`\n[迁移完成] SCHEMA_VERSION=${SCHEMA_VERSION}`);
  console.log(`  文件: ${files.length} 个，改动 ${filesChanged} 个`);
  console.log(`  shortDir 重映射: ${recsChanged} 条`);
  console.log(`  已结算 correct 重判: ${settledRejudged} 条（其中命中状态翻转 ${flips} 条）`);
  console.log(`  migrated 标记写入: ${migratedCount} 条（含 TFA_TEST_ 夹具，前向验证口径 filter(!r.migrated)）`);
  if (summary.length) console.log(summary.join('\n'));
  console.log('[排除] TFA_TEST_ 夹具 2 条已打 migrated:true，不进入前向样本统计');
}

main();
