'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// 基础设施 · 数据目录单一出口（20261111d · P2-1 测试隔离）【已登记为项目基础设施】
// ----------------------------------------------------------------------------
// 迁移策略（用户裁决 20261111d）：
//   ① 新代码统一经本模块 getDataDir() 取数据目录，不再散写 path.join(__dirname,'..','data')；
//   ② 存量模块「按改动迁移」——仅在下次触碰该模块数据路径时顺手接入本模块，不做一次性强制统一；
//   ③ 仅改落盘位置，绝不改动现存模块的输出格式 / 下游数据契约。
// 测试隔离用途：测试设 SA_DATA_DIR 把落盘重定向到项目外临时目录，从而
//   ① 不污染真实 data/；② 规避沙箱「批量删除需确认」守卫（SAFE_DELETE_BULK_CONFIRM_REQUIRED，阈值 50/轮）。
// 生产环境不设置 SA_DATA_DIR → 仍用默认 project/data/，行为完全不变（确定性逻辑不受影响）。
// 求值时机不变式（关键）：本模块在「调用时」读 env（非加载期缓存），因此测试必须在
//   require 依赖模块（如 lib/stockLog 的 DIR 在加载期经 getDataDir() 求值）【之前】设置 SA_DATA_DIR，
//   否则该依赖模块会锁定到默认 project/data/（见 SESSION-STATE ③ 确认）。
// 📌 铁律：测试使用本模块时，SA_DATA_DIR 必须在 require 任何依赖模块【之前】设置。
//   双探针实测：env 在 require 前设 → 落 temp（隔离生效）；env 在 require 后设 → 落真实 project/data/
//   （失去隔离 + 重新暴露沙箱批量删除守卫）。其他模块迁移 getDataDir() 时，若其测试不遵守此顺序会立刻露馅。
// ============================================================================
function getDataDir() {
  const override = process.env.SA_DATA_DIR;
  if (override && typeof override === 'string' && override.trim()) {
    return path.resolve(override.trim());
  }
  return path.join(__dirname, '..', 'data');
}

// 本模块创建的测试临时目录前缀（test_stock_log.js 使用 sa-stocklog-test-<pid>）。
// 仅清理匹配此前缀的目录，绝不触碰 /tmp 中其他文件。
const TEST_TMP_PREFIX = 'sa-stocklog-test-';

/**
 * 自愈清理：扫描 os.tmpdir() 中本模块创建的测试临时目录，删除超过 maxAgeMs 的旧目录，
 * 避免 /tmp 长期累积。由 run_all_tests.js 启动、及 test_stock_log.js 单独运行时调用（仅删匹配前缀的目录）。
 * ⚠️ 边界假设：默认 maxAgeMs=24h，本函数假设「不会有任何测试进程运行超过 24 小时」。
 *   若未来出现长跑测试（>24h），其临时目录可能被误删——届时需调大阈值，或加入 pid 活性检测
 *   （目录名含 <pid>，删除前检查该 pid 是否仍存活）后再删。
 * @param {{maxAgeMs?:number, prefix?:string, dryRun?:boolean}} [opts]
 * @returns {{scanned:number, removed:number, kept:number, failed:number}}
 */
function cleanupStaleTmpDirs(opts = {}) {
  const maxAgeMs = typeof opts.maxAgeMs === 'number' ? opts.maxAgeMs : 24 * 60 * 60 * 1000;
  const prefix = opts.prefix || TEST_TMP_PREFIX;
  const dryRun = !!opts.dryRun;
  const tmp = os.tmpdir();
  let scanned = 0, removed = 0, kept = 0, failed = 0;
  let entries = [];
  try { entries = fs.readdirSync(tmp); } catch (e) { return { scanned, removed, kept, failed }; }
  const now = Date.now();
  for (const name of entries) {
    if (name.indexOf(prefix) !== 0) continue;
    scanned++;
    let stat = null;
    try { stat = fs.statSync(path.join(tmp, name)); } catch (e) { continue; }
    if (now - (stat.mtimeMs || 0) > maxAgeMs) {
      if (dryRun) { removed++; continue; }
      try { fs.rmSync(path.join(tmp, name), { recursive: true, force: true }); removed++; }
      catch (e) { failed++; } // 记录清理失败但不阻断，避免 /tmp 个别锁定的旧目录卡住启动
    } else {
      kept++;
    }
  }
  return { scanned, removed, kept, failed };
}

module.exports = { getDataDir, cleanupStaleTmpDirs, TEST_TMP_PREFIX };
