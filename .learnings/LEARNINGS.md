# Learnings — Stock Analyzer

> 由 self-improvement 流程维护。格式：LRN-YYYYMMDD-XXX。
> 广泛适用的条目会提升（promote）到 `~/.workbuddy/skills/stock-analyzer-*` 技能与工作区记忆。

---

## [LRN-20260923-001] knowledge_gap / correction

**Logged**: 2026-09-23T10:50:00Z
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
「证券交易所」被关键词 `'证券'` 字面命中 → 境外交易所的本地规则被误归到 A 股**券商**板块，并经「论坛热度 +1 跨阈值」放大 4 倍权重、锁 105 天，最终成为华安证券（600909）短期判断里的事件驱动利空。

### Details
用户截图投诉：「为什么国外交易所的规则修改会对国内的券商造成中级事件影响呢？」

取证链（全部已实测复核）：
1. 东财原文正文 = 「**土耳其伊斯坦布尔证券交易所**宣布，自9月22日起 BIST-50 成分股卖空适用报升规则…」。
2. `lib/newsSectorImpact.js: analyzeNewsImpact(title, summary)` 用 `title + ' ' + summary` 拼接文本 → 含「证券交易所」→ 命中 `NEWS_SECTOR_MAP`「证券」行的普通关键词 `'证券'`（**1 分、非 exclusive**）→ `sector='证券'`。
   - 注：`'证券'` 曾是**泛词抢答**问题（20260914i 只修了「消费」没修「证券」）。「证券」既是行业名又是市场基础设施名词（证券交易所/证券公司/证券时报/证券业协会）。
3. `FOREIGN_MARKET_HINTS` 是硬编码城市/国家白名单，**不含土耳其/伊斯坦布尔/BIST** → 境外闸门漏网。
4. `data/events/audit.json` 2026-09-22T06:28:13 那条：`candidates=2, gradeNone=1, created=1, heatChecks=1, heatAdjusted=1`。
5. 分级算式：LLM 五维合计 **6** → 按阈值（major≥11 / moderate≥7 / minor≥3）本应 **minor**；T3.5 论坛热度 heat=1 被当**第六维加进总分** → 7 → **刚好跨过 moderate 阈值** → 权重 0.03 → **0.12（4 倍）**，衰减 1 天 → **105 天**。
6. `data/events/active.json` 落盘 `evt_证券_down`（grade=moderate, score=7, affectedSymbols=[600909,000783]）；`data/judgments/2026-09-23.json` 里 600909 的 `event` 因子 weight 0.1197、subFactors `▼利空·证券·中度·剩105天`、impactScore -3。

结论：**误报（false positive）**，用户质疑正确。放大链条 = `关键词命中板块 → matchWatchlist 按 sector 广播到自选股 → 事件权重进短期判断`，**中间没有任何「是否适用于 A 股」的检查点**。

### Suggested Action
- **A（归类层，必改）** `lib/newsSectorImpact.js`：把 `'证券'` 从 `keywords` 移出并加入 `GENERIC_KEYWORDS`（0.5 分、不能单独定归属），只留 `'券商'`/`'注册制'`/`'印花税'`/`'IPO'` 等专属词定归属。
- **B（境外闸门层，必改）** `FOREIGN_MARKET_HINTS` 由城市白名单改为「境外市场实体词典 + 可扩展正则」（土耳其/伊斯坦布尔/BIST/巴西/B3/南非/沙特/Tadawul/印度/NSE/越南/印尼/墨西哥/MOEX…）；保留「全球定价品种（原油/黄金/铜/半导体/存储/芯片）不受此闸门限制」的例外。
- **C（分级层，建议）** `lib/eventEngine.js`：论坛热度**只能降级不能升级** —— `heat=0` 降一级保留；`heat>=1` 不再加进总分（或仅在原始五维已达标时做加固）。**1 分噪声不该有 4 倍权重杠杆。**
- **D（数据层，不改代码即可执行）** 备份后从 `data/events/active.json` 移除/失效 `evt_证券_down`。
- 改 A/B 会改变 `annotateNewsImpact` 的输出（哪些新闻带 `impact`）→ 按项目「模块修改两铁律」属**输出内容变化**，须同步下游（`server.js` 首页新闻影响标注 + `eventEngine` 候选池），并跑 `node scripts/test_news_sector_scoring.js` 回归。
- ⚠️ **动手前须经用户确认**（项目铁律：已有代码的修复前必须先与用户核实，禁止未经核对就断言修复方案）。

### Resolution
- **Resolved**: 2026-09-23T11:10:00Z
- **Notes**: 用户选定 **A + B + D**（C 热度机制明确不动）。
  - **A** `lib/newsSectorImpact.js`：`'证券'` 从「证券」行 keywords 移出 → 加入 `GENERIC_KEYWORDS`（0.5 分、不能单独定归属）；同时补入**境内专属**交易所名（上交所/深交所/北交所/全国股转/新三板/全称）与「证券公司/证券业」为 exclusive —— 既堵住境外误配，又不误伤境内交易所政策新闻（这是只把「证券」降级会踩的坑）。
  - **B** 同文件：`FOREIGN_MARKET_HINTS` 由 ~17 城市名扩到 ~150 项（国别/金融城市/境外监管机构全称；刻意不放 SEC/CFTC/FCA/MAS/SFC 等短缩写，避免子串误伤）；新增 `FOREIGN_EXCHANGE_RE`（境外交易所缩写，**刻意不加 `/i`**，否则 six/set/psi 等小写词会误命中）；新增 `DOMESTIC_ANCHORS` 豁免；新增 `isForeignMarketNews()` 四步判定（全球定价品种 → 无境外主体 → 有境内锚点 → 拒收）。
  - **D** 备份 `data/events/active.json.bak-20260923k` 后移除 `evt_证券_down`；校验剩余 `evt_半导体_up` 权重与当前 `gradeRanges` 一致，无需迁移。
  - **回归**：`scripts/test_news_sector_scoring.js` 由 17 项扩到 **33 项**，全通过。
  - **验证**：`getEventsForSymbol('600909','short')`→`[]`、`buildEventOverride('600909','short')`→`null`、600460 保留半导体 minor 事件；`PORT=3016` 临时实例 `/`→302、`/api/hot-news`→200。
  - **遗留（C，用户明确不动）**：`lib/eventEngine.js` T3.5 论坛热度仍作第六维加进总分，LLM 五维 6 分被 heat=1 顶到 7 分即跳 moderate（0.03→0.12、1 天→105 天）。将来若再现「1 分热度翻 4 倍权重」，改法=热度只能降级不能升级。
  - **未 commit / 未 push**（等用户说「同步」）。需用户重启 3005 + Ctrl+F5 生效。

### Metadata
- Source: user_feedback
- Reproducible: yes
- Related Files: lib/newsSectorImpact.js, lib/eventEngine.js, data/events/active.json, data/events/audit.json, data/news_impact_learning.json, data/judgments/2026-09-23.json, prompts/event-triage-system.md
- Tags: event-engine, sector-classification, foreign-event, grade-threshold, forum-heat, false-positive
- Pattern-Key: harden.foreign_event_gate | simplify.share_sector_generic_keywords
- Recurrence-Count: 1
- First-Seen: 2026-09-23
- Last-Seen: 2026-09-23
- See Also: （与 20260914i「智能家居补贴被归到食品饮料」同属「泛词抢答」类）
- 已固化到技能: `~/.workbuddy/skills/stock-analyzer-stock-page-signals/SKILL.md` §4B-bis、§4H

---
