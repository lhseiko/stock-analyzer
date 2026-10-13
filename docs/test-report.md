# 测试回归报告（docs/test-report.md）

> 生成时间：2026-10-07（阶段二 · 防线构筑）
> 运行方式：`node scripts/run_all_tests.js`（全量）或 `npm test` / `node scripts/run_all_tests.js --quick`（仅零网络组）
> 说明：本环境（沙箱）禁止 node 进程派生子进程，故本次以「直接逐脚本调用」等价执行验证；runner 本身已通过 `--dry-run` 验证可正确发现 43 个测试并分类。

## 结论

**✅ 离线组 40/40 全绿（另 3 个需网络测试在本环境跳过，属预期）。**

- 测试脚本总数：**43**
- 离线执行：**40 通过 / 0 失败**
- 需网络（离线跳过）：3 —— `test_llm_stream_fallback.js`、`test_news_time.js`、`test_sector_market_cap_fallback.js`
- 退出码接线：全部有效（失败即非零退出，已逐文件复核）

## 本阶段修复的 3 个既有回归（runner 价值体现）

1. **`public/accuracy.html` 版本戳陈旧**（真实用户可见 bug）
   - 现象：`style.css?v=20261003j` / `accuracy.js?v=20261003j` 停留在旧版本，而 `APP_VERSION` 已升 `20261006a` → 准确率页长期加载旧 CSS/JS，除非手动硬刷新。
   - 修复：两处 `?v=` 对齐到 `20261006a`（与 index.html 同戳）。
   - 验证：`test_current_quote_refresh.js` 的 accuracy.html 版本戳断言通过。

2. **`scripts/test_hot_topics_consistency.js` 期望常量陈旧**（测试自身 bug）
   - 现象：硬编码 `cacheVer === '20260913f'`，而 `lib/hotTopics.js` 的 `CACHE_VER` 已为 `'20260923h'` → 测试恒失败。
   - 修复：期望字面量同步为 `'20260923h'`。

3. **`scripts/test_changjiang_patchFG.js` 数据依赖脆弱**（R13：测试依赖生产数据不可复现）
   - 现象：硬编码 `turnoverYi === 19323.07`（写入时近 20 日成交额均值），实际读取 `data/sector_crowding_history.json` 实时计算，数据漂移后该值变化 → 测试失败。
   - 修复：改为校验闸门*逻辑*（`gateTurnover === true && turnoverYi >= turnoverFloorYi && turnoverFloorYi === 15000`），不再冻结历史数值；闸门决策逻辑仍被完整覆盖。

## 变异验证（假阳性排除，R5）

对 5 个核心模块注入对应 bug，确认测试能捕获（基线均通过、变异后均失败）：
| 组 | 模块 | 变异 | 基线 | 变异后 |
|----|------|------|------|--------|
| G1 | marketEmotionModel | 破坏权重上界夹紧 | pass | FAIL |
| G2 | eventEngine | 中度权重 0.12→0.13 | pass | FAIL |
| G3 | localDate | 时区 Shanghai→Tokyo | pass | FAIL |
| G4 | dataHonesty | success:false 不再判 failed | pass | FAIL |
| G5 | backtestValidator | RSI 单调性破坏 | pass | FAIL |

结论：5/5 变异全部被捕获 → 目标测试非假阳性空转。详见 `docs/test-inventory.md`。

## 已知局限（阶段三补齐）

- 3 个需网络测试仅在联网环境验证；当前沙箱无法执行，建议在用户本机 `npm test` 全量跑一次确认。
- `test_market_technical.js` 为零断言诊断脚本（仅打印 `getMarketTechnical` 结果），归类为手动诊断工具而非回归防线。
- API 层冒烟（`scripts/test_api_smoke.js`，随机端口 spawn，需本机 `npm test` 全量执行；沙箱 EBUSY 限制 node→node 派生，无法在此 live 跑，但路由/静态资源/Bust 文件均已逐项核验存在）、看门狗（`scripts/watchdog.vbs` + `register_watchdog.bat` 注册计划任务每 5 分钟探 `/api/health` 并自愈）、日志落盘（`start.vbs` 将控制台输出重定向 `>> logs\server.log 2>&1` 并按 >5MB/14 天轮转；`server.js` 的全局错误中间件与 `unhandledRejection` 额外集中写 `logs/error.log`，含时间戳+路由+堆栈首行，按 >5MB 轮转保留 14 份）、`/api/health` 轻量端点、备份恢复演练（`scripts/restore_drill.js`，已在本环境实跑 **8/8 通过**：双备份 md5 一致、恢复副本完整、86 条笔记可解析、模拟删除后按 id 成功找回）：均已在阶段二落地。
