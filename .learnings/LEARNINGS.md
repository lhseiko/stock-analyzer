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

## [LRN-20260928-001] correction / automation_gap

**Logged**: 2026-09-28T16:40:00Z
**Priority**: high
**Status**: resolved
**Area**: backend / scheduler

### Summary
个股「短期行情判定」记录此前只在**用户打开该个股页**时才生成（`GET /api/sameday-judgment/:symbol` → `getJudgmentWithAccuracy` → `buildJudgment`+`saveJudgment`）。导致**从未打开过的自选股在准确率页「各股短期判断准确率」整行缺失**。用户重申核心原则：**所有数据分析判定在打开工作台后自动进行，无需切到对应页面后才开始。**

### Details
取证链（已实测复核）：
1. 用户截图投诉：5/8 自选股缺判定记录（长江证券 000783 / 士兰微 600460 / 圣湘生物 688289 / 新洋丰 000902 / 万润股份 002643）——均为从未打开过的标的。
2. `lib/sameDayJudgment.js` `getJudgmentWithAccuracy()` 的「复用条件」要求 `rec.targetDate===currentTargetDate`；没有任何记录的标的不会进入该函数，记录永远不被创建。
3. `preOpenRecomputeAll()` 只 `getAllRecords()` 里**已存在**的 nextday 未结算记录重算——**不会为从未打开过的标的创建记录**。
4. 15:30 调度只自动落盘「大盘技术分析 / 大盘量能情绪」与结算，从无「逐股短期判定」自动生成步骤。
5. 对照 20260917 已有先例：大盘技术分析也曾因「只在用户打开首页才落盘」而长期缺记录，已在 15:30 调度补自动落盘；**逐股短期判定漏了同等处理**。

结论：典型「页面触发 vs 后台自治」机制缺口。修复须改**机制**（启动/定时自动生成），而非改文案/配置——否则「打开工作台自动判定」原则仍不落地。

### Suggested Action
- **A（机制，已实施）** `lib/sameDayJudgment.js` 新增 `ensureAllTrackedJudgments({symbols})`：
  - 覆盖集合 = 自选股（`data/watchlist.json` 带 name）∪ 已有记录中当前目标日标的（去重、保留最新）。
  - 对缺失当前目标日记录的标的调 `getJudgmentWithAccuracy(symbol,name,'',force)` 自动 build+save；已存在且 schema 一致且未过期 → 跳过（防每轮重复刷新）。
  - 新增 `buildWithLock()` 并发锁（按归一化 symbol）：避免「后台自动判定」与「用户打开页面」同时 build 同一标的 → 并发写同一 `targetDate` 文件相互覆盖。
  - `getJudgmentWithAccuracy` 与 `preOpenRecomputeAll` 的 build 路径统一改用 `buildWithLock`。
- **B（接线，已实施）** `server.js`：
  - 启动 `app.listen` 后**立即** `ensureAllTrackedJudgments({symbols: readWatchlistFile()})`（`runAutoReview` 之后，后台静默，失败不阻断启动）。
  - 每分钟调度器内新增**每 15 分钟节流**的 `ensureAllTrackedJudgments`（非周末）：补齐盘中新增自选股的记录。
  - 导入 `ensureAllTrackedJudgments`；新增防抖槽 `_lastEnsureSlot`。
- **C（版本戳，已实施）** `APP_VERSION` 20260928c→20260928d；`index.html`(style.css/app.js/backtestUI.js) + `accuracy.html`(style.css/accuracy.js) 的 `?v=` 同步升；`scripts/test_aspects_budget.js` 守卫 49/0 通过。
- ⚠️ 范围仅限「自动生成判定记录」，不改判定因子结构/输出格式 → `SCHEMA_VERSION` 不变（按项目铁律，仅启动/调度行为变化，下游消费方无格式变化）。

### Verification
- 受控测试：临时对从未记录的 600519 调 `ensureAllTrackedJudgments({symbols:[{symbol:'600519'}]})` → `created:1`、记录落盘；清掉测试条目前剩余 8 条真实记录完整（无数据污染）。
- 真实覆盖：修复前 5/8 自选股缺 2026-09-29 记录；重启加载新代码后启动触发器自动补齐 → 全部 8/8 具备当前目标日记录，无需打开任何个股页。
- 受控测试在 degraded 网络（Eastmoney `socket hang up`、历史 K 线拉取失败）下仍成功落盘（buildJudgment 用 `Promise.allSettled`，部分源失败不影响整体写盘）。

### Metadata
- Source: user_feedback（用户截图 163954 + 重申核心原则 + 挂载 @skill:selfimproving / @skill:proactive-agent）
- Reproducible: yes
- Related Files: lib/sameDayJudgment.js (ensureAllTrackedJudgments / buildWithLock / getJudgmentWithAccuracy / preOpenRecomputeAll), server.js (app.listen 启动块 / startDailySettlementScheduler), data/watchlist.json, data/judgments/<targetDate>.json
- Tags: judgment-autogen, background-scheduler, page-trigger-gap, watchlist, concurrency-lock, core-principle
- Pattern-Key: auto.background_judgment | harden.concurrency_build_lock
- Recurrence-Count: 1
- First-Seen: 2026-09-28
- Last-Seen: 2026-09-28
- See Also: 20260917 大盘技术分析「打开首页才落盘」同类缺口（同属「页面触发 vs 后台自治」）
- 已固化到技能: `~/.workbuddy/skills/stock-analyzer-stock-page-signals/SKILL.md`（待补充 §：短期判定自动生成）

---

## [LRN-20260928-002] correction / data_source_outage

**Logged**: 2026-09-28T17:54:00Z
**Priority**: high
**Status**: resolved
**Area**: backend / data-fetch

### Summary
日K线历史取数全线失效：所有个股 `getHistory(sym,'6m')` 返回 0 根 → 日K线图空白、策略回测报「历史数据不足（0 根）」。实时行情(qt.gtimg.cn)与 60 分钟 K 线(ifzq.gtimg.cn mkline)正常。

### Details
取证链（全部已实测复核）：
1. `lib/stockData.js` 日K线 `getHistory` 对 CN/HK 先走 `fetchTencentHistory`（腾讯 `web.ifzq.gtimg.cn/appstock/app/fqkline/get`）→ 返回 HTTP **501**（该主机当前不下发日K）。
2. 再回退 `fetchEastmoneyHistoryRetry`（`push2his.eastmoney.com`）→ **socket hang up**（本机 TLS/代理到该主机不稳定）。
3. 两者皆失败后 `getHistory` 返回 `[]` → 上层判定「0 根日线」。
4. 对照：60分钟腾讯接口 `ifzq.gtimg.cn/appstock/app/kline/mkline` 工作正常（200，800 根）；实时行情 `qt.gtimg.cn` 正常。
5. 关键发现：同一腾讯日K接口，**仅主机名不同**——`web.ifzq.gtimg.cn` 返回 501，而 `ifzq.gtimg.cn` 返回 200（131 根，proxy 直连均验证通过）。

### Root Cause
腾讯日K历史接口主机 `web.ifzq.gtimg.cn` 当前停止服务（501）；代码写死该旧主机，无可用回退（东财 push2his 在本机亦不稳定）。

### Fix（20260928e）
- **A（根因）** `fetchTencentHistory` / `fetchTencentHistoryEndingAt` 主机由 `web.ifzq.gtimg.cn` → `ifzq.gtimg.cn`（与已工作的 60m 接口同源同主机，沿用默认代理）。
- **B（韧性）** `getHistory` 在腾讯→东财两级回退后，新增**三级兜底：新浪日K** `quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData?symbol=<tencentCode>&scale=240&ma=5&datalen=<count>`（proxy 实测 200/320 根，返回结构与腾讯日K一致），避免单一源再导致全空白。
- **C（版本戳）** `APP_VERSION` 20260928d→20260928e；`index.html`/`accuracy.html` 的 `?v=` 同步升；`scripts/test_aspects_budget.js` 守卫 49/0 通过；`test_backtest_validator` 28/0、`test_strategy_generator` 40/0 通过。
- ⚠️ 范围仅限数据取数源，**不改变 `getHistory` 输出字段结构**（仍为 {date,open,close,high,low,volume}）→ 下游（图表/回测/短期判断）无格式变化，按项目铁律属隔离修改，无需改其他模块。
- **D（同源修复·隔离）** 同一 `web.ifzq.gtimg.cn` 失效主机还被以下日K/分钟取数硬编码引用，一并切换（均仅换主机、输出结构不变，按铁律属隔离修改）：`server.js:_lastTradeDateViaFetch`（大盘交易日检测）、`lib/marketTechJudgment.js:fetchIndexDaily`、`lib/marketTechnical.js:fetchKline`（大盘技术面）、`lib/stockData.js:fetchTencentMinutes`（分时）、`lib/deep/yield.js:fetchBfqBars/fetchAllBfqBars`（股息率趋势不复权日线）。
- **E（getHistoryDeep 改写）** 原 `fetchTencentHistoryEndingAt` 用 `endDate` 分段回溯；但 `ifzq.gtimg.cn` **拒绝 start/end 参数（返回 `param error`）且日K回看上限约 2.6 年（~640 根）**；新浪日K `datalen` 实测上限约 **1500 根（≈6 年）**。故 `getHistoryDeep` 改为「新浪日K 优先（≤1500）→ 腾讯 ifzq 近 2.6 年兜底」，恢复长历史（原上游停用时为 0 根）。股息率模块原 10 年分段分页因上游限制降级为单次拉取近 2.6 年不复权日线（优雅降级，不崩溃/不空）。
- 🔑 **关键约束（未来取数务必牢记）**：腾讯 `ifzq.gtimg.cn/appstock/app/fqkline` 仅支持 `count`，**不支持 start/end**；单 only ~2.6y 日K；60m 用 `ifzq.gtimg.cn/appstock/app/kline/mkline`（可用）。长历史优先新浪 `quotes.sina.cn/cn/api/json_v2.php/CN_MarketData.getKLineData?scale=240&datalen≤1500`。东财 `push2his.eastmoney.com` 本机常被 TLS 阻断（socket hang up），仅作兜底。

### Verification
- `require('./lib/stockData').getHistory('000783','6m')` → 131 根，末根 2026-09-28 close=7.92（与用户截图实时价一致）。
- 000783/601318/600909/603288/688289 全部恢复 131 根日K。

### Metadata
- Source: user_feedback（用户截图 175400 日K空白 + 175407「[ERROR] 历史数据不足（0 根）」+ 挂载 @skill:a-stock-data / @skill:proactive-agent / @skill:selfimproving / @skill:cnfinancialscraper）
- Reproducible: yes（上游主机 501 为持续态）
- Related Files: lib/stockData.js (fetchTencentHistory / fetchSinaHistory / getHistory / getHistoryDeep / fetchTencentMinutes), server.js (_lastTradeDateViaFetch), lib/marketTechJudgment.js (fetchIndexDaily), lib/marketTechnical.js (fetchKline), lib/deep/yield.js (fetchBfqBars / fetchAllBfqBars), public/index.html, public/accuracy.html
- Tags: data-source, tencent-kline-host, fallback-chain, daily-kline, outage
- Pattern-Key: data.tencent_kline_host | harden.kline_fallback_chain
- Recurrence-Count: 1
- First-Seen: 2026-09-28
- Last-Seen: 2026-09-28
- See Also: LRN-20260922（sector 成分股 push2 全通道 reset → 多主机轮询 + stale 快照回退，同一类「单一源失效」韧性模式）
