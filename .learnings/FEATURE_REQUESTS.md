## [FEAT-20261103-001] market_log_database_search

**Logged**: 2026-11-03T18:35:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Requested Capability
用户：「把大盘记录做成一个简单的数据库，添加相应的检索功能，能够按日期、行业和涨跌等关键词进行搜索。」

### Suggested Implementation
（已实现 20261103i）lib/marketLogDb.js 把 notes.json scope=market 派生为结构化 SQLite（data/market-log.db，node:sqlite 零依赖），GET /api/market-log 支持日期范围/行业/涨跌方向/关键词/指数名组合检索；notes 页（market scope）注入检索面板。

### Resolution
- **Resolved**: 2026-11-03T18:35:00+08:00
- **Notes**: 守卫 test_market_log_db.js 40 断言全绿；真机 10 条记录入库并验证三类检索。
