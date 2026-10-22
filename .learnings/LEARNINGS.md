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

---

## [LRN-20260930-003] correction / best_practice

**Logged**: 2026-09-30T09:55:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
首页「今日财经热点」新闻→板块关联误判：**「风电设备**板块表现活跃」被误归「医疗器械」**。根因是医疗器械词表把**裸通用词「设备」**当专属词（×3 分），而「风电**设备**」命中该子串。这是同类「泛词抢答」第 **3** 次复发（① 消费→食品饮料 ② 证券→券商 ③ 设备→医疗器械）。

### Details
- 复现：`analyzeNewsImpact('风电设备板块表现活跃 威力传动涨超10%', ...)` 旧输出 `医疗器械 / 迈瑞医疗、鱼跃医疗 / up`（打分 3，专属词 1）。
- 根因：`NEWS_SECTOR_MAP` 医疗器械条 `exclusive: [...,'设备',...]`。打分制里 exclusive 命中 ×3，「设备」作为所有「…设备」产业名（风电设备/电力设备/机械设备/光伏设备）的**公共后缀**，在 `text.includes('设备')` 下必然跨行业命中 → 3 分压过真正板块（电力设备仅凭非专属词「风电」得 1 分）。
- 同类链：① 20260914i「消费」；② 20260923k「证券」（证券交易所=市场基础设施名词）；③ 本次「设备」。共性=**裸通用词 + 子串匹配**。
- 影响面：`analyzeNewsImpact` 同时被 `/api/hot-news`（首页卡片 + `recordImpact` 自学习库）与 `lib/eventEngine.js`（事件池）消费 → 一条误判会**双向污染**（卡片展示 + 事件权重 + 自学习库统计）。

### Suggested Action（已实施）
1. **数据修复**：医疗器械词表删除裸词「设备」，改为**医疗专属完整词**「医疗设备/医用设备/医疗仪器」；医药生物 `exclude` 里的「设备」同步改为「医疗设备」；电力设备把「风电」「风电设备」提升为 `exclusive`（3 分稳胜）。
2. **系统性防护（防同类复发）**：新增 `GENERIC_TOKENS` 裸通用词集（设备/市场/行业/板块/产业/产品/服务/材料/技术/系统/平台/项目/业务），模块加载时对所有条目的 `keywords/exclusive/exclude` **整词过滤剔除**并 `console.warn`。按整词相等判断，故「医疗设备」「医疗服务」等复合词不受误伤。
3. **守卫**：新增 `scripts/test_news_sector_impact.js`（15/0）——覆盖三类历史事故回归 + 正常归属不破坏 + 裸通用词结构性守卫。

### Metadata
- Source: user_feedback（用户截图 2026-09-30 09:47「风电设备…」被标「▲医疗器械 迈瑞医疗、鱼跃医疗」+ 挂载 @skill:selfimproving / @skill:proactive-agent / @skill:a-stock-data）
- Reproducible: yes
- Related Files: lib/newsSectorImpact.js (NEWS_SECTOR_MAP / GENERIC_TOKENS / pickSector), scripts/test_news_sector_impact.js, server.js (/api/hot-news), lib/eventEngine.js
- Tags: news-sector-impact, generic-token, cross-sector-misattribution, substring-match
- Pattern-Key: news.sector_generic_token | harden.sector_token_sanitizer
- Recurrence-Count: 3
- First-Seen: 2026-09-14
- Last-Seen: 2026-09-30
- See Also: 20260914i（消费→食品饮料，打分制+强排除）, 20260923k（证券→券商，「证券」降泛词 + 境外闸门重写）

---

## LRN-20261014c — 外部数据接口可用性必须实测，不能照搬文档/假设

### What Happened
落地策略回测引擎四项待办（真实 F10 / Johansen / 60m 长窗口 / 止损止盈仓位）时，有三处**原始假设被实测推翻**：
1. **腾讯 m60 分页不可行**。原计划「分页拼接延长 60 分钟窗口」，实测 `mkline?param=sh601318,m60,,N`：`N=800` → 800 根；`N=900/1200` → **静默回退 320 根**（硬上限）；带 `start/end` 参数 → **返回 0 根**（根本不支持日期区间）。→ 改走新浪 `scale=60`，实测上限 **4023 根 ≈ 4 年**，最新收盘价与腾讯逐位一致（51.230 vs 51.23）。
2. **东财 F10 停牌/ST/退市三接口不可达**。`RPT_TERMINATED_LIST` → 业务错误 `9501`；`push2 clist` 风险警示板（`s:2048`）与 `push2 stock/get`（`f292` 停牌标记）→ **ECONNRESET**。但 `RPT_F10_BASIC_ORGINFO` **可达**，其 `FORMERNAME` 曾用名链就是 ST 历史证据（新洋丰 `中国服装→S中服→中国服装→*ST中服→…` 含 2 次 `*ST`）。
3. **探测脚本首轮全部误报**。第一版脚本用 `/"m60":\[(.*?)\]/s` 抓根数，结果恒为 `bars=1`（把整个数组当一个匹配）；且脚本放在 `/tmp` 下 `require('axios')` 直接 `MODULE_NOT_FOUND`（Git Bash `/tmp` 与项目 `node_modules` 不在一起）→ **必须把探测脚本写在项目目录内**再执行。

### Root Cause
- 二次封装接口的**上限与参数支持范围不会写在文档里**，且超限时常见行为是「静默回退到默认值」而非报错——最危险的一类。
- 沙箱/网络环境会**按域选择性拦截**：同一家的不同子域可达性可能截然相反（东财 `datacenter-web` 可达、`push2` 被重置），不能因一个接口通了就推断同族全通。
- 用正则解析 JSON 是脆弱手段，应先 `JSON.parse` 再取路径，失败再退正则。

### Suggested Action（已实施）
1. 所有外部数据源接入前**先写可复现探测脚本实测**，明确记录：单次上限、是否支持日期区间、超限行为（报错 vs 静默回退）、字段名。
2. **默认路径保持零变化**：`count ≤ 800` 仍走腾讯（`meta=null`），仅 `count > 800` 才切新浪 → 隔离性可验证。
3. 不可达的能力**如实标注缺口**，不做假降级（`f10Status` 取数失败时返回 `{ok:false, reason, detail}` + 保底 0.9 并注明"未获证据支撑"，而非编造 ST 状态）。
4. 数据源口径差异**必须量化并写进输出**：新浪 vs 腾讯 60m 在 `10:30`/`14:00` 两个整点切片口径不同（重叠 800 根中 49 根收盘价差 0.02~0.06 元，双向随机，其余 11 个整点一致）→ 挂 `.meta.caution`，让报告能标注而非静默使用。
5. 探测脚本一律写在项目目录内并在结束时删除（`rm -f _probe*.js`），避免 `node_modules` 解析失败与临时文件残留。

### Metadata
- Source: ai_self_discovery（四项待办实施中的实测发现）
- Reproducible: yes
- Related Files: lib/stockData.js (fetchSinaKline60m / fetchTencentKline60m), lib/f10Status.js, lib/backtestValidator.js
- Tags: external-api, data-source-probe, silent-fallback, sandbox-network, isolation
- Pattern-Key: api.verify_before_integrate | probe.silent_fallback
- Recurrence-Count: 1
- First-Seen: 2026-10-14
- Last-Seen: 2026-10-14
- See Also: LRN 关于「前端第三方库必须本地随包」（同类=外部依赖不可靠，必须实测+本地兜底）

---

## LRN-20261014d — 统计检验实现必须用「已知答案的合成数据」验证，而非只验证"能跑"

### What Happened
把 `engleGranger` 升级为真实 Johansen 时，若只验证"返回了数字、没报错"，无法判断特征分解是否正确。改用**已知答案的合成数据**后判定全对：
- `y = 2x + 平稳噪声`（x 为随机游走，真协整）→ 特征值 **`[0.999, 0]`**、`rank=1`、判协整、`p=0.01`。**理论预期正是「1 个近 1 + 1 个近 0」**——这条对齐说明矩矩阵构造、逆矩阵、Jacobi 分解、迹统计量整条链路数学正确。
- 两条独立随机游走（不协整）→ `stat=12.87 < 15.41`（5% 临界值）、`rank=0`、判不协整、`p=0.199`。
- 样本 15 根 → 降级 `engle-granger(fallback)`；单变量 → `johansen(rejected)`。

### Root Cause
数值算法"跑通"与"算对"是两件事。特征值分解、矩阵求逆这类实现，错误时往往仍返回看似合理的数字，只有用**有解析解/理论预期的输入**才能证伪。

### Suggested Action（已实施）
1. 统计/数值实现一律补**合成数据断言**：协整用 `y=ax+平稳噪声` 验 rank 与特征值形态；平稳性用随机游走 vs 正弦序列。
2. 同时验证**降级路径**（样本不足、矩阵奇异、维度不足）都返回明确的 `method` 标记，便于排查"到底走的哪条路"。
3. 早退分支也要补齐字段一致性（johansen 的 `k<2` 分支补 `method='johansen(rejected)'`），避免调用方拿到结构不一致的对象。

### Metadata
- Source: ai_self_discovery（Johansen 实施）
- Reproducible: yes
- Related Files: lib/backtestValidator.js (johansen / jacobiEigen / matInverse / engleGranger)
- Tags: numerical-verification, synthetic-data, eigenvalue, johansen, cointegration
- Pattern-Key: verify.statistical_impl_with_known_truth
- Recurrence-Count: 1
- First-Seen: 2026-10-14
- Last-Seen: 2026-10-14

---

## LRN-20261014e — 正则解析中文参数时，排除条件的作用域必须锁定在「子句」而非「整句」

### What Happened
为 `strategyNL.js` 加中文风控参数解析时，第 6 个测试用例 `'止损8%，止盈15%，回撤5%，分4批建仓'` **把止盈 15% 丢了**。根因：止盈的排除条件写成 `if (tpm && ... && !/回撤|回落|移动/.test(prose))` —— 用**整句 `prose`** 判断，而整句里含"回撤"两字，于是"止盈15%"被误杀。
修法：改为遍历 `splitClauses(prose)` 的**子句**，只在子句内排除移动止盈语境。

同一轮还发现：纯风控子句被子句跳过逻辑吃掉后，用户会拿到**含糊的 `incomplete`**（不知道哪句出问题）→ 已把未被参数吸收的风控子句并入 `unparsed` 一起返回。

### Root Cause
「整句扫描」与「按子句解析」混用。凡是多子句输入（中文常见用「，」并列多个条件），排除/否定类判断必须下推到子句粒度，否则任意一个子句里的关键词会污染全部匹配。

### Suggested Action（已实施）
1. 中文多条件解析统一走 `splitClauses()` 子句粒度，排除条件一律在子句内判断。
2. 失败时**如实告知具体卡在哪一句**：`unparsed` 要包含真正无法识别的子句（本例返回 `["均线金叉买入","死叉卖出"]`，明确指向缺周期数的均线句，而非止盈句）。
3. 补充反向用例：确认「金字塔式加仓」「跌破5%加仓」这类仍被如实拒绝（不能因为放开了仓位闸门就一律放行）。

### Metadata
- Source: ai_self_discovery（中文风控解析实测第 6 例失败）
- Reproducible: yes
- Related Files: lib/strategyNL.js (parseRiskParams / translate)
- Tags: nlp-regex, clause-scope, false-negative, honest-failure
- Pattern-Key: regex.clause_scoped_exclusion
- Recurrence-Count: 1
- First-Seen: 2026-10-14
- Last-Seen: 2026-10-14

---

## LRN-20261014f — 新增前端渲染函数前，必须核对既有代码读取的真实键名

### What Happened
为回测结果新增 `renderRiskExit(data)` 时，写成 `data.raw_backtest.full`，而引擎实际返回的键名是 **`raw_backtest_result`**。同一文件第 128 行既有代码写的是 `data.raw_backtest_result` —— 我自己新写的第 233 行却用错了。是端到端脚本报 `Cannot read properties of undefined (reading 'full')` 才暴露。

### Root Cause
凭记忆/推测写接口键名，没有以既有消费方代码为准。好在端到端验证覆盖到了这条路径，否则前端会静默不渲染风控块（不报错、只是不显示），属最难发现的一类缺陷。

### Suggested Action（已实施）
1. 新增前端渲染函数时，**先 grep 既有同源代码读的键名**，再写（`grep -n "raw_backtest" public/js/backtestUI.js`）。
2. 后端返回结构的键名以 `lib/` 里的 `return {...}` 为准，不靠推测。
3. 端到端验证必须**覆盖新功能的真实调用路径**（本例：经 `validateStrategy` 传入 `stop_loss` 并断言 `riskExit` 已挂载），而非只测单元函数。

### Metadata
- Source: ai_self_discovery（端到端验证捕获）
- Reproducible: yes
- Related Files: public/js/backtestUI.js (renderRiskExit), lib/backtestValidator.js (raw_backtest_result)
- Tags: frontend-contract, key-name-mismatch, silent-failure, e2e
- Pattern-Key: frontend.verify_field_name_from_existing_consumer
- Recurrence-Count: 1
- First-Seen: 2026-10-14
- Last-Seen: 2026-10-14

---

## [LRN-20261019-001] correction

**Logged**: 2026-10-19T08:50:00Z
**Priority**: critical
**Status**: resolved
**Area**: backend

### Summary
个股页「资金量能」内三处量能结论互相矛盾——量价信号（缩量回调）/ 量能热度（量能平稳）/ 量能分析·资金行为（平量下跌）。用户原话：「这些结论严重的违反了工作台的核心逻辑数据的一致性」。实测 20 只样本 **14 只（70%）** 互斥，最刺眼的是东方财富 300059：A、C 判「缩量」而 B 判「温和放量」，方向直接相反。

### Details
三处结论此前**各自独立计算、无交叉校验**，四层根因叠加：

| 层 | 问题 | 位置 |
|---|---|---|
| L1 数据源分裂 | 量价卡用路由传入的 `getHistory()` 日K；量能卡用引擎 `_fetchDailyBars` 四级链自拉。两条通道可能停在不同交易日 | server.js:1854 vs capitalFlow.js:728 |
| L2 分子不同 | A = 当日成交量；B = 近 3 日均量 | capitalFlow.js:328 vs :420 |
| L3 分母不同 | A = 前20日均量（不含当日）；B = 近20日均量（**含当日，且分子本身包含在分母内**）；C = 前5日均量 + 60日确认 | :323 / :421 / volumeEngine.js:153 |
| L4 阈值不同 | A、B 用 1.5/1.2/0.8/0.5 五档；C 用 1.3/0.7 | :342 / :426 / :641 |

**B 的结构性缺陷**：分子（近3日）包含在分母（近20日）内，比值天然被压向 1，实测几乎恒为「量能平稳」——20 只样本 6 只报平稳且多数落在 0.9~1.3，与同卡「量价信号」频繁互斥。

**排查中新发现的引擎内部自相矛盾（非用户原始反馈项）**：引擎**展示用 `pc.level`（纯 ÷5日均量），而结论走 `amplified/shrunk`（档位 or 60日确认的并集）**，两者不同源 → 出现「量能档位=平量」却「资金行为=缩量上涨」（600460/000902/002594/600030 等 4/15 触发）。第一轮只修了跨卡口径，一致性从 70% 降到 27%，剩余 4 处全部来自这一层。

### Root Cause
1. 多个模块各自实现「放量/缩量」判定，没有单一真值源；每个模块改口径时都无法感知其他模块的口径变化。
2. **「描述性档位」与「判定性状态」被混用**：`pc.level` 是描述性的（相对近 5 日），`amplified/shrunk` 是判定性的（含长期确认），引擎把描述性值直接当展示、判定性值用于结论，自相矛盾。
3. 缺少跨卡一致性回归测试——三套口径并存数月未被测出，直到用户肉眼发现。

### Suggested Action（已实施，见 commit c95088f / 版本 20261017i）
1. **建立单一真值源**：`volumeEngine.js _volumeTier`（当日量 ÷ 前5日均量定档 + 60日均量 ×1.5/×0.7 确认），放大/缩量判定与 `_comboEngine` 的 amplified/shrunk **完全同式**，并在两处都写明「改动必须同步」的注释。
2. **下游改引真值源，保留全部既有文案**：`computeVolumeIndicators` 新增 `opts.unifiedTier`，五档 `volBucket`（huge/amp/flat/shrink/dry）映射到原有全部信号文案，下游 `VP_MAP`/`HEAT_MAP` 打分零影响；未传入时退回本地口径，零副作用。
3. **展示层与判定层对齐**：新增判定性档位 `judgedLevel` 用于对外展示，原始档位以 `ratio5Level` 保留追溯；引擎内部规则与打分仍照旧用 `pc.level`（隔离修改）。
4. **数据源统一**：两卡共用引擎同一份日K（volume 按通道归一为「手」），内部 `bars` 字段返回前剔除、不下发前端。
5. **跨卡一致性回归测试**：新增 `scripts/test_volume_consistency.js` 91 项（含端到端 A/B/C 同源比对），把「三处必须同向」变成机器可校验的约束，而非依赖肉眼。

### Prevention（适用面超出本模块）
- **凡是同一语义指标在多处展示，必须共用同一个计算真值源**；展示层只做文案映射，不做二次判定。
- **警惕「比值型指标」的分子分母包含关系**（如近3日/近20日），这类口径会把结果压向中性值、掩盖真实信号。
- **区分「描述性档位」与「判定性状态」**：同一指标用于展示和用于结论分支时，若取自不同口径，必然出现自相矛盾。
- **一致性约束要机器化**：跨模块口径一致性应写成回归断言（本例 91 项），否则只能等用户肉眼发现。

### Metadata
- Source: user_feedback
- Reproducible: yes（20 只样本 14 只互斥，可脚本复现）
- Related Files: lib/volumeEngine.js (_volumeTier/_volTriState/judgedLevel), lib/capitalFlow.js (computeVolumeIndicators/analyzeCapitalFlow), public/js/capitalCharts.js (renderVolumePrice), public/js/app.js (renderVolumeEngine), scripts/test_volume_consistency.js
- Tags: data-consistency, cross-module-caliber, volume-analysis, silent-contradiction
- Pattern-Key: backend.single_source_of_truth_for_shared_metric
- Recurrence-Count: 1
- First-Seen: 2026-10-19
- Last-Seen: 2026-10-19

---

## [LRN-20261019-002] correction

**Logged**: 2026-10-19T18:20:00Z
**Priority**: high
**Status**: resolved
**Area**: backend / data-source

### Summary
用户连续两轮反馈量比与东方财富 App 不一致（000783 长江证券 → 20261019a 修复；000902 新洋丰 → 本条 20261019b）。第一轮修复后**同类缺陷换了形态复发**：同花顺当日 bar 带「今日日期」但收盘后数值仍是盘中快照（close 13.69 vs 终值 13.62），「日期新鲜」判据被绕过。排查中又发现更深一层系统性 bug：**腾讯行情全家桶对科创板（sh688/689）的量单位是「股」而非「手」**，getQuote 无脑 ×100 使 688 的 quote.volume 虚增 100 倍（圣湘生物量比一度 73.53）。

### Root Cause
1. **「日期新鲜 ≠ 数值终值」**：20261019a 只校验末根日期=今天，而同花顺当日 bar 收盘后一段时间内是盘中快照，日期新鲜但数值错误。
2. **「权威源」用反了方向**：日K降级链在通道之间选优，却忽略了**主行情源腾讯实时 quote 本身就是交易所终值**——当日 bar 根本不该依赖日K通道，应以 quote 为唯一权威源。
3. **单位「规律」被单一样本泛化**：「腾讯量恒为手」是从 000902（深主板）单样本实证得出的，688 科创板反例一测即破。外部数据源的单位口径必须按板块实测，不能假设统一。

### Suggested Action（已实施，版本 20261019b）
1. **当日 bar 终值对齐**：`volumeEngine._reconcileTodayBar`（纯函数）——末根日期=quote 日期→以腾讯实时 quote 覆写 OHLC/量/额；quote 日期更新且为今日→直接补齐当日 bar；实质偏差（>0.1% close 或 >0.5% 量）才留痕 dataGaps，一致则幂等静默。
2. **科创板量单位源头归一**：stockData.js `tencentVolumeUnitIsShares`（/^sh68/），qt 快照（不×100）/ 日K（÷100 归手）/ 分时 cumVol（÷100 归手）三处自适应，维持「quote.volume=股 / 日K与分时=手」既有契约。
3. **独立第三方裁决法**：单位之争用新浪行情（volume=股、amount=元）+「量×均价≈成交额」自洽性校验裁决，不靠任何单一争议源自证。

### Prevention
- **当日/实时数据与历史数据的权威源必须分层**：历史段用日K通道，当日段永远以实时行情为准——任何日K通道的「当日 bar」都可能是延迟固化的快照。
- **修复「A 类缺陷」后必须追问其变体**：000783 是「当日 bar 缺失」，000902 是「当日 bar 存在但数值假」——同一根因（当日 bar 不可信）的两种形态，只修看得见的那个会复发。
- **外部数据源单位按板块实测**：主板实测结论不得外推到科创板/北交所；单位假设要写成可校验的断言（本条已入 test_volume_consistency [11.8]）。
- **量额自洽校验是单位错的照妖镜**：`volume × 均价 ≈ amount` 不成立即为单位错，一行算式即可自动化裁决。

### Metadata
- Source: user_feedback
- Reproducible: yes（000902 三通道原始数据可脚本复现）
- Related Files: lib/volumeEngine.js (_reconcileTodayBar), lib/stockData.js (tencentVolumeUnitIsShares/fetchTencentQuote/fetchTencentHistory/fetchTencentMinutes), scripts/test_volume_consistency.js
- Tags: data-consistency, unit-normalization, realtime-vs-snapshot, star-market, volume-analysis
- Pattern-Key: backend.intraday_bar_authority_is_live_quote
- Recurrence-Count: 2（000783 同根因第一形态）
- First-Seen: 2026-10-19
- Last-Seen: 2026-10-19

---

## [LRN-20261019-003] correction / data-sourcing

**Logged**: 2026-10-19T14:00:00Z
**Priority**: high
**Status**: resolved
**Area**: backend / volume-analysis

### Summary
用户指令：「把模型的量比数据直接向 mcp 或通过腾讯或者同花顺等数据源取值，不要在本地工作台进行计算」。量比（volume ratio）改为**数据源直采**，不再在本地用「今日量 ÷ 前 5 日均量」重算。

### Details
此前量比走本地重算链路：取当日 bar 成交量（经 `_reconcileTodayBar` 对齐实时 quote 终值后）÷ 前 5 日均量。与东方财富 App 量比存在口径/时滞差异（用户原反馈 新洋丰 000902 工作台 0.97 vs 东财 App 0.99）。
探查确认腾讯 qt.gtimg.cn 行情 `fields[49]` 即为量比，与东财 App 量比完全一致（8 只自选股逐一吻合：601318=0.63、600909=0.97、000783=0.82、600460=0.93、688289=0.74、603288=1.49、000902=0.99、002643=0.64）。东财 push2 `f52`、同花顺、MCP 亦可作同源补充。

### Suggested Action（已实施，版本 20261019c）
1. `stockData.fetchTencentQuote` 解析 `fields[49]` 透出 `quote.volumeRatio`（无效置 null）。
2. `volumeEngine._precompute(bars, {quoteVolumeRatio})` 收到有效值即替代本地重算，标注 `ratio5Basis='tencent_quote'`；缺失/无效退回本地并标注 `'local_fallback'`。
3. `analyzeVolume` 透传 `quote.volumeRatio` 至 `computeVolumeEngine`，dataGaps 透明标注来源。
4. 下游消费 `pc.ratio5` 不变 → 输出格式零变化，隔离修改。

### Prevention
- **数值口径指标优先取数据源现成字段**：量比/换手率/市盈率等标准行情字段，数据源通常直接提供且与主流 App 同口径；本地重算易因「当日 vs 收盘」「分钟均量 vs 日均量」等口径偏差与权威源脱节。先查数据源是否已有该字段，再决定是否本地兜底。
- **直采值须标注来源与兜底路径**：`ratio5Basis` + dataGaps 双重留痕，不伪装本地重算，也不静默回退。
- **上游 quote 携带字段要透传到底**：`quote.volumeRatio` 经 `getQuote → analyzeCapitalFlow → analyzeVolume → computeVolumeEngine` 整链透传，缺任一环即退回兜底；改动链路时须核对透传路径。

### Metadata
- Source: user_feedback
- Reproducible: yes（腾讯 qt.gtimg fields[49] 可脚本复现）
- Related Files: lib/stockData.js (fetchTencentQuote), lib/volumeEngine.js (_precompute/computeVolumeEngine/analyzeVolume), server.js (/api/capital-flow), scripts/test_volume_consistency.js
- Tags: data-sourcing, volume-ratio, tencent-quote, data-consistency
- Pattern-Key: backend.volume_ratio_prefer_data_source
- Recurrence-Count: 1
- First-Seen: 2026-10-19
- Last-Seen: 2026-10-19

---

## [LRN-20261019-004] coverage_gap / enhancement

**Logged**: 2026-10-19T12:00:00Z
**Priority**: medium
**Status**: resolved
**Area**: backend / volume-analysis

### Summary
用户提供「什么时候该放量/该缩量」规范性判定清单（📈该放量 4 类 / 📉该缩量 4 类 / 💎位置决定性质），要求去重后补入模型。覆盖度比对：6 类与既有规则重复（不补），4 类缺口补入 `_expectedVolumeRules`（3 风险 + 3 正向确认）。

### Details
**重复项（已覆盖，未补）**：突破压力位放量=shouldAmpNot；上涨回调洗盘=shouldShrinkHuge；高位放量滞涨=highStagnant/highHugeNotUp；底部缩量不跌=shrinkDown低位大跌后/lowOscillate/lowHugeNotDown；下跌途中缩量阴跌=shouldShrinkHuge；「位置决定性质」=_detectPosition 核心设计。

**4 类缺口根因**（都是既有规则的边界未覆盖，非逻辑错误）：
1. 高位放量下跌（放量大阴线）：`highHugeNotUp`/`highStagnant` 只覆盖 `isStagnant`(｜chgPct｜<1.2%) 或 `fellFromHigh`(上影≥2%)，明显收跌的大阴线（chgPct≤−1.2%）两者都不满足 → 漏判。
2. 下跌途中放量阳线诱多：`shouldShrinkHuge` 的「下跌途中」场景要求 chgPct<0（只抓缩量阴跌），放量阳线（chgPct>0）完全漏判。
3. 高位缩量横盘（温水煮青蛙）：`shrinkUp` 高位阶段要求 chgPct>0（只覆盖缩量上涨），高位缩量横盘漏判。
4. 正向确认缺失：原模型偏矛盾/风险信号，对「突破后回踩缩量不破 / 低位倍量阳线启动 / 主升浪缩量上涨控盘」无任何正面口径。

### Suggested Action（已实施，版本 20261019d）
1. `volumeEngine.js` 新增 `_expectedVolumeRules(pc, ctx)`（纯 IF-THEN，零 LLM，导出供单测），6 信号：highVolumeDrop / downtrendVolUpTrap / highShrinkSideways（风险）+ breakoutPullbackShrink / bottomVolUpStart / mainRiseShrinkControl（正向）。
2. `_classify` 注入：风险类→noBullReasons；downtrendVolUpTrap 在下跌途中→forceBear 强制看空；正向类→`signal.bullSupport` 数组，仅在「看多信号」或「无硬性禁多理由的看多观察」时追加 note（避免与禁多理由自相矛盾）。
3. `_buildSummaries` 新增 `expectedVolumeSummary` 归集（6 项，无论命中逐条完整输出，未触发=未触发、不臆造）；前端 `renderVolumeEngine` 经既有通用 `renderSummary` + `expTone`（读 `item.tone`）渲染新卡片，零新 CSS。
4. schema 升至 `volume-engine-20261019d`（`test_volume_engine.js` 断言同步）；`test_volume_consistency.js` 新增 [13] 组 38 项（143→181）。

### Prevention
- **补规则前先做覆盖度比对**：用户给外部规范文本时，逐条映射到既有规则的**精确触发条件**（不是规则名），只有边界未覆盖的才补；每条补入项须在结论里写明「为何原规则不命中、去向是哪条」，防止重复与语义重叠。
- **正向信号必须设自相矛盾护栏**：模型以矛盾/风险信号为主时，补正向确认不能无条件追加——须限定「无硬性禁多理由」才注入 note，否则会出现「既说高位派发又说突破确认」的自相矛盾展示（违反诚实性铁律）。
- **确定性条件规则的实测以合成端到端为主**：6 信号是条件模式，当日真实数据未必命中（实测 18 只零命中但结构/ schema/既有规则全对）；须另造合成 bars（上行至高位后放量大跌、下行至低位后倍量阳线）走 `computeVolumeEngine` 端到端验证命中→风险标签→禁看多链路，避免「空过断言」。

### Metadata
- Source: user_feedback
- Reproducible: yes（scripts/test_volume_consistency.js [13] 组零网络可复现）
- Related Files: lib/volumeEngine.js (_expectedVolumeRules/_classify/_buildSummaries/computeVolumeEngine), public/js/app.js (renderVolumeEngine), scripts/test_volume_consistency.js, scripts/test_volume_engine.js
- Tags: volume-analysis, expected-volume, coverage-gap, classify-constraint, honesty-guard
- Pattern-Key: backend.volume_expected_rules_coverage_gap
- Recurrence-Count: 1
- First-Seen: 2026-10-19
- Last-Seen: 2026-10-19

---

## [LRN-20261019-005] correction / best_practice

**Logged**: 2026-10-19T20:30:00Z
**Priority**: high
**Status**: resolved
**Area**: frontend/backend

### Summary
量价信号标签「量价齐跌」与解释「下跌放量」自相矛盾（用户海天味业 603288 截图报障「严重违反工作台核心原则」）：`capitalFlow.js` 下跌分支 amp 档标签是 **20 日窗口时代的遗留词**（义为价跌+20日量能萎缩），20260902m 改当日口径时只改了解释、漏改标签——当日口径下 amp 档 = 价跌且当日量÷前5日均量 1.3~2.5（量增），标签暗示量缩与解释语义直接相反。

### Details
- 用户截图数据：603288 当日 -1.18%、量比(÷5日均量) 1.49 → amp 档 → 标签「量价齐跌」+ 解释「下跌放量，空头占优，观望为宜」。
- 根因是**半拉子口径迁移**：20260902m 把量价主信号从 20 日窗口改为当日口径时，`volumePriceDesc`（解释）改了、`volumePriceSignal`（标签词汇表）没改——「齐升/齐跌」本就是 20 日窗口词（价量同向变化），当日口径的正确词是「放量上涨/放量下跌」。
- 连带发现历史遗漏：旧 amp 档「量价齐跌」不在 `bearScore`/capitalCharts bear 列表 → **下跌放量不得空头分**（huge 档反而有分），多空打分与标签档位错配。

### Suggested Action（已实施，版本 20261019e）
1. `capitalFlow.js` 下跌侧分级对称化：huge「放量下跌」→「**巨量下跌**」、amp「量价齐跌」→「**放量下跌**」（desc 本就正确、未动）。
2. 消费方全同步且**分值按档位继承、零分值变化**：`VP_MAP`（巨量下跌 −12 / 放量下跌 −9）、sameDayJudgment `vpSigMap`（−0.6 / −0.5）、capitalCharts `signalClass` 与 bear 列表（均 +2，与后端同口径）。
3. `bearScore` 列表补「巨量下跌」，amp 档改名后自动修复「下跌放量不得空头分」遗漏。
4. sameDayJudgment `LAYOUT_VERSION` 20260922c→20261019e 手动升版（展示值随标签名变化、因子结构哈希不捕获 → 必须手动升版强制重算当日判断，否则旧快照静默复用）。

### Prevention
- **口径迁移必须标签+解释+评分+配色四处一起改**：20260902m 只改解释漏改标签，矛盾潜伏 17 天才被用户截图发现。凡「改口径」类改动，先把该字段的**全部词汇表**（生产者分支 + 所有下游映射表 + 前端配色/计分列表 + 测试断言）列清单再动手，用 grep 把旧词在全仓扫一遍（本次扫出 4 个必须改的点 + 4 个不能改的语义正确项，如 marketEmotionModel 大盘口径「量价齐跌（资金退潮）」=价跌量缩）。
- **「标签 vs 解释」矛盾是可单测的不变量**：新增 `test_volume_consistency.js` 第 14 组护栏——标签量能方向词与解释必须同向（放量/巨量/齐升 vs 缩量/地量/齐跌），覆盖 5 档 × 涨跌两向 × 统一/本地两口径 = 20 场景；「齐跌」按缩量向校验，旧矛盾写法回归即失败。同类「文字+数值双通道展示」的指标都应补这种不变量断言。
- **改名时分值按档位继承而非重算**：huge 继承原放量下跌分值、amp 继承原量价齐跌分值，保证评分零变化、只修文案矛盾——符合项目「数据不变则结论不变」铁律，也避免「修 bug 顺手改结论」引发的二次信任问题。

### Metadata
- Source: user_feedback
- Reproducible: yes（scripts/test_volume_consistency.js 第 14 组零网络可复现；603288 API 实测 signal=放量下跌/desc=下跌放量）
- Related Files: lib/capitalFlow.js, lib/sameDayJudgment.js, public/js/capitalCharts.js, scripts/test_volume_consistency.js, docs/logic/stock-13-capital.md
- Tags: volume-price-signal, label-desc-contradiction, half-migrated-lexicon, bear-score-omission, layout-version
- Pattern-Key: backend.volume_price_label_desc_contradiction
- Recurrence-Count: 1
- First-Seen: 2026-10-19
- Last-Seen: 2026-10-19

## [LRN-20261019-006] correction / best_practice

**Logged**: 2026-10-19T21:30:00Z
**Priority**: high
**Status**: resolved
**Area**: backend/frontend

### Summary
缩量定档标准与市场标准矛盾（用户新洋丰 000902 截图报障：量比(÷5日均量) 0.99 却显示「缩量上涨」/量能热度「缩量」）：`_volumeTier` 定档写为 `amplified = confirm==='放量' || ratio5>1.3`、`shrunk = confirm==='缩量' || ratio5<0.7`——**60 日均量口径的确认结果有权把 ÷5 日均量的「平量」翻转成「温和缩量」**，且 0.7/1.3 阈值偏离市场标准（缩量<0.8 / 平量0.8~1.2 / 放量>1.2 / 严重缩量<0.5）。

### Details
- 用户截图数据：000902 当日 +1.87%、量比(÷5日均量) 0.99（tencent_quote 直采 = 东财 App 口径）、20日量价比 1.03 → 卡片显示「缩量上涨」、热度「缩量」、combo「缩量上涨·caution」，与市场标准直接矛盾。
- 根因是**确认机制越界为改判机制**：judgedLevel 机制（20261017i 为修「A 卡展示平量 vs C 卡结论缩量」矛盾而引入）本意是「60 日口径确认 ÷5 档位」，实际实现是 `confirm==='缩量'` 时**无条件翻转**档位（当日量 < avg60×0.7 即判缩量，与 ÷5 日均量的市场标准量比无关）。000902 实证：当日量 806 万 < avg60×0.7=838 万 → confirm=缩量 → 平量(0.99)被翻转成温和缩量。
- 影响面：10 只自选股中 5 只档位被 60 日口径改写（000902 0.99、600460 0.93、000783 0.82 均在 0.8~1.2 市场「平量」区间却显示缩量）。
- 用户三项决策（AskUserQuestion 确认后实施）：①阈值对齐市场 0.8/1.2/0.5；②60 日均量口径保留为分歧披露（`divergenceNote`，不翻转档位）；③不增加日环比 ±10% 披露行。

### Suggested Action（已实施，版本 20261019f）
1. 定档改纯 ÷5 日均量单独定档：`LEVEL_RULES`（温和缩量 [0.5,0.8)/温和放量 (1.2,2.5]）、`_volTriState`（>1.2/<0.8）、`_volumeTier`（amplified/shrunk 纯 ratio5，去掉 confirm 或项）、`_precompute` judgedLevel（纯 ratio5，dry<0.5）、`_comboEngine`（amplified/shrunk 纯 ratio5）、`_volTraits`（isHugeVol/isShrink 纯 ratio5）六处。
2. 60 日口径降级为披露：`crossBasisOk = confirmDir===null || t5===null || confirmDir===t5`；不一致时 basis 串附「60 日均量口径确认为『缩量』（当日量低于 60 日均量 ×0.7）……档位以 ÷5 日均量（市场标准量比）为准」；`dimensions.volumeState.confirmDisagree` 同步标注。judgedLevel 恒等于 level（保留字段为输出结构兼容）。
3. capitalFlow.js `unifiedVolState` dry 边界 0.4→0.5（与引擎同源）；多日规则（pulse/口诀4/amp2 等）基准为 60 日属规则自身语义不动。
4. 版本三件套：schema `volume-engine-20261019f`；sameDayJudgment `LAYOUT_VERSION` 20261019e→20261019f（展示值变化、因子结构哈希不捕获→手动升版强制重算）；`APP_VERSION` 20261019e→20261019f + public 三 HTML 31 处 ?v= 同步。
5. 实测 10 只自选股全部与市场标准一致：000902 0.99→平量/温和上涨/热度量能平稳（divergenceNote 披露 60 日分歧）；600460 0.93、000783 0.82 缩量→平量；688289 0.74、600030 0.78 维持缩量（<0.8 判定正确）。sameDayJudgment 000902 schemaVersion=h2375b0d3-20261019f、regenerated=true、量价配合=温和上涨/0.2。

### Prevention
- **「确认/校验」机制不许拥有「改判」权力**：20261017i 引入 judgedLevel 的初衷是交叉校验（60 日口径确认 ÷5 档位），实现时写成 `confirm==='缩量' || ratio5<0.7`——一个「或」就把校验器变成了改判器，且静默。凡设计「B 口径确认 A 口径」类机制，默认语义必须是「不一致时披露分歧」（divergenceNote + confirmDisagree），档位永远归市场标准口径单独定档；只有用户明确要求「B 有权覆盖 A」时才写覆盖，且必须显式留痕。
- **阈值常量必须来自可引用的外部标准**：0.7/1.3 是项目自定义值，与市场通行量比标准（0.8/1.2/0.5）长期不一致却无人发现，因为没有任何测试或注释标注「此值对标什么」。凡与市场/监管/行业口径挂钩的阈值，注释与测试断言里必须写明「对齐 XX 标准（0.8/1.2/0.5）」并建市场标准回归块（本次复刻 000902 形态：ratio5=0.95+confirm=缩量 → 断言 tier=平量/shrunk=false/分歧披露；边界 0.49/0.5/0.79/0.8/1.2/1.21 六值全断言）。
- **前端直采值与自算值必须二选一并明示**：用户能同时看到「量比(÷5日均量) 0.99」（卡片自算或直采）与结论「缩量」，说明**数字通道与档位通道用了两套阈值**。凡卡片同时展示「数值+档位标签」，两者必须由同一函数同一边界计算（本次统一收口 `_volTriState`/`_volumeTier` 后前端展示值改读 tier 字段），否则数值与结论矛盾只是时间问题。

### Metadata
- Source: user_feedback
- Reproducible: yes（scripts/test_volume_engine.js 市场标准对齐回归块零网络可复现；000902 API 实测 signal=温和上涨/level=平量/divergenceNote 在场）
- Related Files: lib/volumeEngine.js, lib/capitalFlow.js, lib/sameDayJudgment.js, scripts/test_volume_engine.js, scripts/test_volume_consistency.js, docs/logic/stock-13-capital.md
- Tags: volume-tier, market-standard-alignment, ratio5, confirm-flip, divergence-note, layout-version
- Pattern-Key: backend.volume_tier_market_standard_misalignment
- Recurrence-Count: 1
- First-Seen: 2026-10-19
- Last-Seen: 2026-10-19

---

## [LRN-20261020-001] 兜底日期必须过交易日历：周末基准日把准确率台账卡死

**Logged**: 2026-10-20T05:10:00Z
**Type**: correction
**Priority**: high

### Summary
情绪准确率台账「已结算数永久少于已记录数」：2026-10-18（周日）日线通道瞬时失败，`baselineDate` 兜底为 today=周日，留档基准日落非交易日 → 上证无该日 K 线 → `settleRecord` 的 `findIndex` 恒 -1 → 永久 pending。用户截图报障「结算的数量比预测的数量少太大」。

### Details
- 触发链：周日 13:38 首页调 /api/sentiment-turning-point → index bars 为空（东财/网络瞬时失败，logs 满屏 socket hang up）→ marketEmotionModel.js:832 `bars.length ? bars[bars.length-1].date : today` 兜底为周日 → server.js:942 留档 → settleRecord baseIdx=-1。
- 既有防呆只覆盖 targetDate 一侧（20261013f：目标日撞休市日则重算），**baseDate 一侧裸奔**——「兜底为 today」在周末/节假日场景下天然非法。
- 实证排除两项误判：①weights 总和 160 非 bug（scaleBounded 每次归一化到 100 并夹紧，:138 有注释）；②并非服务器没跑结算（重启后 settleAll 仍未结算该记录，node 直调 settleRecord 复现 settled=false）。
- 附带发现（另开一轮）：权重自学习「当前样本不足」文案不准——priceVolume→volumePrice 改名（20261015k）致旧 key 28 样本不参与学习、新 key 仅 3 样本，indexMomentum/margin 已到 W_MAX=30，learnLog 恒空。

### Suggested Action（已实施，版本 20261020a）
1. 结算侧：新增纯函数 `resolveBaseDate`（非交易日→previousTradingDay 回滚，空值透传），`settleRecord` 基准日比对改走它；不变量 `nextTradingDay(d)==nextTradingDay(previousTradingDay(d))` 保证目标日不受回滚影响。
2. 留档侧：`recordDailyJudgment` 同样回滚；并追加「回滚而来的记录不得覆盖目标日既有留档」——周日降级结论只剩单因子、indexValue 为 null，若允许覆盖会顶替正常记录（原方案的「幂等去重」只防 settled 覆盖，不够）。
3. 存量：删除 data/sentiment-accuracy/2026-10-18.json（与 10-16 记录同目标同方向的重复计数产物），台账回 17 条。
4. 测试：test_event_weight_sentiment_acc.js 新增 9 项（resolveBaseDate 4 + 不变量 1 + 接线断言 1 + 留档功能实测 3，用 2028 未来日期+finally 复原，零污染）；44/44 全绿；全量回归 50/53 零新增失败。版本戳 APP_VERSION 20261020a + public 31 处。

### Prevention
- **兜底值必须过合法性校验，尤其日期**：`X.length ? X[last] : today` 这类兜底在「today 本身可能非法」的场景（周末/节假日/休市）会把异常扩散成持久脏数据。凡兜底一个「日期/ID/代码」类字段，落库前必须过对应日历/字典校验（交易日历 cnTradingCalendar 是唯一权威源），非法则回滚到最近合法值，而不是原样落地。
- **防呆要成对**：targetDate 有防呆、baseDate 没有——「基准日/目标日」「开始/结束」「上/下」这类成对字段，校验必须对称补齐，修一侧时主动 grep 另一侧。
- **「少太多」先分层再定位**：用户口中的「结算比预测少」是聚合数字，先拆出 pending 明细逐条定性（在途/未来/真卡死），本案 3 条 pending 里仅 1 条是 bug——避免把「1 条卡死」修成「重建结算系统」。

### Metadata
- Source: user_feedback
- Reproducible: yes（node -e 调 settleRecord 复现；scripts/test_event_weight_sentiment_acc.js 零网络可复现）
- Related Files: lib/sentimentAccuracy.js, lib/marketEmotionModel.js, server.js, scripts/test_event_weight_sentiment_acc.js, .learnings/ERRORS.md
- Tags: sentiment-accuracy, weekend-baseline, fallback-validation, trading-calendar, paired-guard
- Pattern-Key: backend.fallback_date_must_pass_calendar
- Recurrence-Count: 1
- First-Seen: 2026-10-18
- Last-Seen: 2026-10-20

## [LRN-20261020-002] 互斥期望必须单源推导：双清单并行收集把同一股票判成自相矛盾

**Logged**: 2026-10-20T06:30:00Z
**Type**: correction
**Priority**: high

### Summary
个股量能卡同时显示「该放量未放量，资金没有跟上」+「该缩量反放巨量，分歧未结束」——两个互斥期望同时命中（用户截图报障）。根因是该放量/该缩量两侧场景清单独立收集，「低位区间+前期平台整理」无条件同时进两侧，且该缩量侧的巨量判定被 60 日 confirm 口径污染（÷5 量比 1.15 的平量股因 confirm=放量命中「反放巨量」）。

### Details
- 用户给出六维度框架（时间/量能形态/价格行为/确认逻辑/假信号/观察清单）区分「底部构筑期（该缩量：卖压衰竭）」与「底部启动/确认区（该放量：买盘验证）」，要求把原判定升级。
- 实现为 `_bottomPhase` 相位分类器：启动确认区（充分条件：倍量或放量持续≥2日+价格抬升+交叉验证）> 构筑期（必要条件：近10日≥6日地量+低点不再下移+未突破平台上沿+均线非空头发散）> 方向不明（未定性不臆断期望）；非低位/无平台→不适用；样本不足→数据不足。
- 期望由相位单源推导：该放量侧平台场景加 `bpPhase==='启动确认区'` 门控；该缩量侧低位场景加 `lowSideOk`（仅构筑期）；`hugeVol` 剔除 60 日 confirm 只认 ÷5 日档位（20261019f 铁律复用：确认机制不许有改判权力）；低位+单日脉冲豁免（框架「假信号识别」）。
- 结构性保证：该放量未放量要求 `!isHugeVol`（ratio5≤1.2），该缩量反放巨量要求档位∈{大量,天量}（ratio5>2.5），量能区间不相交——永不同时命中。
- A/B 实证（git HEAD 旧版 vs 新版，合成复刻截图场景）：旧版双命中矛盾；场景3（启动确认区+当日巨量阴线）、场景4（构筑期单日脉冲）旧版均误命中「该缩量反放巨量」。
- 实测 10 只自选股（含 000902）：无一双命中；7 只低位股全部「方向不明」并逐条列明理由（地量 0-5/10 日/低点仍在下移/均线空头排列发散）——未定性不臆断期望，符合诚实合规原则。

### Suggested Action（已实施，schema 20261020a）
1. lib/volumeEngine.js：新增 `_bottomPhase` + 7 个相位常量（阈值取用户框架范围内保守值，注释对标来源）；`_contradictionRules` 两侧门控 + 巨量口径收严 + 低位脉冲豁免 + 返回 bottomPhase；`_buildSummaries` 归集总结追加相位说明；主入口输出 bottomPhase；schema volume-engine-20261019f→20261020a。
2. scripts/test_volume_engine.js：[18] 节 40 项断言（构筑期/截图复刻核心回归/启动确认区/脉冲豁免/非低位回归保护/_bottomPhase 单元/40 组合互斥不变量扫描）；schema 与 bottomPhase 字段断言同步。276/276 全绿。
3. scripts/test_volume_consistency.js：schema 断言同步 20261020a，227/227 全绿。
4. docs/logic/stock-13-capital.md 新增 8.12 节（框架映射/根因四层/修复表/实测影响面/护栏）。

### Prevention
- **互斥期望必须单源推导**：当两个结论（该放量 vs 该缩量、看多 vs 看空、买入 vs 卖出）在语义上互斥时，禁止用两个独立清单分别收集触发条件——必须先从「相位/状态」单源推导当前处于哪一侧，另一侧才谈得上触发条件。双清单并行收集是自相矛盾的通用产生器。
- **口径污染要连坐排查**：一个判定（巨量）混用两个口径（÷5 日档位 + 60 日 confirm）时，松口径会悄悄制造矛盾结论。凡「A 或 B」形式的布尔条件，先问「B 有没有权力触发基于 A 阈值的判定」——本案与 20261019f「确认机制不许有改判权力」同族，修的时候要主动 grep 全模块其余同类或项。
- **阈值取框架范围内保守值并注释对标**：用户给区间（30%-50%）时取上限为认定线（50%）、持续日数取区间中值以上（≥6/10），宁严勿宽——宽阈值把未定性场景误判进某一侧，同样制造矛盾；每个常量注释标注对标来源，后续审计有据。
- **测试要能捕获旧 bug**：新增场景测试后，用 `git show HEAD:<file>` 取旧版跑同数据 A/B 对比，确认旧版确实违反新断言（本案旧版场景2 双命中、场景3/4 误命中），防止「测试永远绿但什么都没测」。

### Metadata
- Source: user_feedback
- Reproducible: yes（scripts/test_volume_engine.js [18] 节零网络可复现；A/B 对比脚本已删除，可用 git show HEAD:lib/volumeEngine.js 重建）
- Related Files: lib/volumeEngine.js, scripts/test_volume_engine.js, scripts/test_volume_consistency.js, docs/logic/stock-13-capital.md
- Tags: contradiction-signals, bottom-phase, single-source-derivation, confirm-basis-pollution, mutual-exclusion
- Pattern-Key: backend.mutually_exclusive_expectations_need_single_source
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

---

## LRN-20261020-003：抽象阈值必须同屏具象化，用户无法核对纯符号计算式

**Issue**: 用户截图指出量比实战口诀卡第 4 条结论「（近 3 日均低于 60 日均量 ×0.7）这里最好把数据计算结果展示出来，60日均量乘以0.7是多少」——判定阈值写成计算式而非计算值，用户看不到均值、乘积、实际近 3 日量能，无法核对「为什么命中/为什么不命中」。同卡口诀 1/2/3/5 均已展示实际量比/均量倍数，唯口诀 4 是纯符号表述，卡片内部口径不齐。临界场景最致命：实测 000902 命中项中间日与阈值仅差 1.8%、601318 未命中项仅差 0.006%——没有数值在场，用户无法分辨「差得远」与「差一点」。

**Root Cause**: 结论文案模板把阈值当作「规则说明」写（`60 日均量 ×0.7`），而非当作「本次数据的计算结果」写。规则说明对调试规则的开发者足够，对需要核对判定的终端用户不够——用户是零代码背景，唯一可做的就是拿界面上的数字做心算验证。

### Suggested Action（已实施，schema 20261020b）
1. lib/volumeEngine.js 口诀 4：命中/未命中两个分支均同屏展示「60 日均量 X ×0.7 = 阈值」+ 近 3 日实际量能（早→晚）；avg60≤0 或 n<3 时未命中分支退回原文案（不输出「null ×0.7 = null」）；detail 增加 avg60/shrinkThreshold/vols3（附加字段，既有消费方不受影响）；schema 20261020a→20261020b。
2. scripts/test_volume_engine.js：口诀 4 测试块新增 4 项断言（命中文案含计算过程与实际值/已确认分支/两类未命中/detail 三字段），283/283 全绿；test_volume_consistency.js schema 断言同步，227/227 全绿。
3. docs/logic/stock-13-capital.md：8.5 清单 #22 + 8.13 新节（含实测四只股票节选表 + 同类 6 处待确认清单）；修正 8.6 配置表过时的 schema 值（20261019f→20261020b，任务六遗留）。

### Prevention
- **面向终端用户的阈值必须是「本次数据的计算结果」而非「规则符号」**：凡结论文案出现「X 均量 ×系数」形式，默认应同屏展示均值实际值、乘积结果、被比较的实际值三件套；用户核对不了的心算就是没展示。
- **量单位随数据通道变化的场景，只展示数值与相对关系、不写死单位**：东财/同花顺=股、腾讯=手（科创板恒为股），比较关系本身与单位无关，写死「手/股」会在降级通道上给出错误单位——比不给单位更糟。
- **扩大范围前先列清单问用户**：同类模式在引擎内还有 6 处（分歧披露 note/persistence note/规则1 dataGap/攻击压力位 detail/跌破 dataGap/该放量未放量结论），本次仅按截图所指修改口诀 4，其余在汇报中列明待用户确认——小步快跑，不擅自churn 用户未指摘的文案。
- **数据不齐全时优雅退回**：具象化依赖 avg60>0 且 n>=3，缺数据时未命中分支必须退回原纯文本文案，禁止输出「null ×0.7 = null」这类半成品。

### Metadata
- Source: user_feedback
- Reproducible: yes（scripts/test_volume_engine.js 口诀4 测试块零网络可复现；实测脚本已删，可用 lib/volumeEngine.js analyzeVolume 重建）
- Related Files: lib/volumeEngine.js, scripts/test_volume_engine.js, scripts/test_volume_consistency.js, docs/logic/stock-13-capital.md
- Tags: threshold-concretization, user-verifiability, ratio-rules, unit-agnostic-display
- Pattern-Key: frontend.abstract_thresholds_need_computed_values
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

---

## LRN-20261020-004：分钟级尾盘窗口必须按时间戳截取，盘后零量条目会把「萎缩/无接力」类条件抹成恒真

**Issue**: 用户截图报障圣湘生物（688289）生死位规则第 5 点「分时无量拉升」误命中——结论称「分时价格持续走高创出日内新高，但分时成交量逐级萎缩且无新增量能接力」，用户同时追问「分时成交量逐渐萎缩是如何判定的，工作台有记录分时成交量然后对比吗」。

**Root Cause**: 腾讯分时收盘后追加 15:01-15:30 盘后条目（688289 实测追加 25 条，cumVol 恒定等于收盘累计值）→ 盘后分钟差分量恒为 0。规则 5 用**原始数组位置**取「最后 40/20 分钟」，窗口混入约 25 分钟零量盘后数据：第 3/4 桶被抹成 3/0（「末桶不足首桶 60%」恒真）、末 20 分钟最大分钟量≈0（「无新增接力」恒真）。于是 shrink+noRelay 对任何收盘股近乎恒真，只剩 priceAtHigh 一道闸——688289 收盘 15.95 距日内最高 15.98 仅 0.19% 恰好过线。与 20261017g 口诀 3 修掉的「尾盘窗口按位置截取」完全同族，当年只修了口诀 3、规则 5 遗漏。实测当日 4 只自选股全被追加 25 条盘后条目——系统性缺陷，不是个案。

### Suggested Action（已实施，schema 20261020c）
1. lib/volumeEngine.js 规则 5：按 `time` 时间戳过滤出交易时段（≤'1500'）条目，priceAtHigh/分桶/无接力全部基于交易时段序列（与口诀 3 同口径）；新增「交易时段可解析条目 <40 分钟 → 数据不足」分支；注释完整记录根因与 688289 实证数据。
2. scripts/test_volume_engine.js：新增 4 项断言——误命中复现（242 真实 HHMM 交易分钟 + 尾盘创新高价 + 量能放大 + 25 条盘后零量条目含 1 条 +3 复刻实测）、A/B 对照（内联旧口径在同数据上 shrink+noRelay 恒真，证明断言确能捕获旧 bug）、防过度修正（真实萎缩仍命中）、数据不足分支；既有 3 个夹具从旧 mock 格式 '09:30'（带冒号不可解析）迁移为真实 'HHMM'。289/289 全绿。
3. scripts/test_volume_consistency.js：schema 断言同步 20261020c，227/227 全绿。
4. docs/logic/stock-13-capital.md：8.5 清单 #23 + 8.14 新节（含分时量能判定机制说明、污染/修正口径对照表、修复表、实测影响面、护栏）；spec 表五大生死位行同步标注时间戳口径。

### Prevention
- **分钟级「最后 N 分钟」窗口必须按 time 时间戳截取，禁止用原始数组位置**：分时数据源会在收盘后追加盘后条目（cumVol 恒定 → 差分为 0），任何「末尾窗口 + 递减/极值类条件」都会被零量条目污染成恒真。20261017g 修口诀 3 时就得出的结论，这次以 checklist 形式固化：凡新增/修改分钟级尾盘逻辑，先 grep 既有实现是否还有 `slice(-N)` 直接作用在原始分时数组上（本次审计确认规则 5 是最后一处，口诀 1 用数组头部不受影响、口诀 3/规则 2 已安全）。
- **「恒真条件」是 bear/看空类规则的隐形误报发生器**：一个看空规则若其触发条件对全体样本恒真，就退化为「价格形态单闸」——本次只剩 priceAtHigh 一道闸，等于「尾盘收在高点附近即看空」。写规则时对每个条件问一句「这个条件有没有可能对任何股票都为真」。
- **A/B 对照要内联进测试**：复现误命中根因时，把旧口径计算直接写在测试里同数据对比（旧 shrink+noRelay 恒真 vs 新口径不命中），比口头论证「旧代码会错」强得多，也防回归。
- **mock 夹具必须跟随真实数据契约演进**：规则 5 夹具用了 20261017g 之前的旧时间格式（'09:30' 带冒号），因当年规则不读 time 而一直潜伏；这次加时间戳过滤后立刻暴露。夹具迁移要跟着数据契约走，不能「能跑就行」。

### Metadata
- Source: user_feedback
- Reproducible: yes（scripts/test_volume_engine.js 规则5 测试块零网络可复现；688289 形态忠实复刻含盘后 +3 条目）
- Related Files: lib/volumeEngine.js, scripts/test_volume_engine.js, scripts/test_volume_consistency.js, docs/logic/stock-13-capital.md
- Tags: minute-window-timestamp, after-hours-entries, false-positive, life-rule-5, always-true-condition
- Pattern-Key: backend.minute_tail_windows_must_use_timestamps
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-005：LRN-20261020-003 模式首次后续执行——用户按清单指名单点，不擅自扩大范围

**Logged**: 2026-10-20T20:10:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend | tests | docs

### Summary
LRN-20261020-003「同类 6 处 ×0.7/×1.5 纯符号站点」清单中的第 ⑥ 项（11.3.1「该放量未放量」结论）由用户截图指名实施（20261020d），其余 5 处仍挂起。

### Details
用户看到 8.13 遗留清单后并未说「全部改」，而是在实际使用中遇到哪处就指名哪处（本次是常见矛盾信号卡的 ×1.5）。这验证了 003 的「扩大范围先列清单问用户」策略是对的：**清单是给用户做选择题的，不是给自己批量执行的**。执行口径与 003 完全一致：均值 X ×系数 = 阈值 + 当日实际量同屏；数据不齐（volToday≤0 只展示阈值；avg60≤0 退回原文本）优雅降级；单位不写死；schema 升 20261020d；测试新增 [19] 节 6 项（命中/纯符号残留/当日量缺失/avg60≤0/未命中原状）；295/295 + 227/227 + 全量回归 50/53 零新增。

### Suggested Action
后续用户再指名清单中其他项时，按同模式单点实施；若用户说「剩下的一起改」，再批量执行 ①—⑤。

### Metadata
- Source: conversation
- Related Files: lib/volumeEngine.js, scripts/test_volume_engine.js, scripts/test_volume_consistency.js, docs/logic/stock-13-capital.md（8.15 新节）
- Tags: threshold-concretization, follow-up-execution, scope-discipline
- See Also: LRN-20261020-003（模式源头）、LRN-20261020-004
- Pattern-Key: frontend.abstract_thresholds_need_computed_values
- Recurrence-Count: 2
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-006：跨模块「检验结论联动」必须挂路由层 + 口径声明同屏——不得把下游因子拖入新的网络依赖

**Logged**: 2026-10-20T21:30:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend | frontend | tests | docs

### Summary
技术面分析卡新增「⑤ 关键位有效性检验」（20261020e）：把资金量能引擎生死位规则（规则3 缩量假突破/规则4 放量破位/有效突破/有效跌破/突破后回踩缩量）既有结论联动到价格行为卡，回答用户「对上方关键阻力区间和下方关键支撑区间有没有有效性检验」的提问。

### Details
调研发现价格行为推演的支撑/阻力区间是近 60 日摆动点聚类口径（`findSupportResistance`/`clusterLevels`），只推演不检验；真检验在资金量能引擎。联动实施要点：
1. **接入点挂路由层**（`server.js` /api/price-action 响应合并 `levelValidity` 字段，放 `...data` 之后防覆盖），不动 `priceAction.js` 内核、不动 hub 快照语义——因为同一快照还被 sameDayJudgment 的 technicalShort/Long 因子消费，若在快照生成链路里加入引擎调用（分钟线+公告网络依赖），会把只读内存因子的判断拖成重网络请求。
2. **独立出口+独立缓存+失败 null**：`priceActionHub.getLevelValidity`（`_lvCache` 同 TTL、12s 超时、getQuote 兜底），纯函数 `_extractLevelValidity` 导出供单测；失败只降级本卡，不阻塞主链路。
3. **两套口径必须同屏声明**：②「近 60 日摆动点区间」（推演）与⑤「引擎 _keyLevels 口径 + 生死位规则检验」是不同口径，meta 行明示「为两套口径」+ 引擎结论基于的日K日期 + 引擎版本，禁止把任一方表述为对另一方的验证。
4. **前端细节**：`#paLevelValidity` 全宽卡放 pa-grid 外（保 2×2 对称）；`.pa-lv-card.hidden` 必须显式声明 CSS（本项目 .hidden 非全局类——style.css:3113/5052 两次踩过）；复用 ve-rule 样式与红涨绿跌；`_renderPaError`/`resetTransientPanels` 两处占位清单都要加新卡 id（防残留上一只股票数据）。
5. **护栏**：新测试 31 项全绿；既有量能三套件零回归（295/295+227/227+13/13）；全量回归 51/54 零新增（3 个在档旧失败）；swallow guard 的「空 catch」判定=体仅空白/注释，本轮新增 catch 均带 console.warn/赋值，未新增空 catch（+4 为历史基线）。

### Suggested Action
后续任何「把 X 模块结论联动到 Y 页面」的需求，先问三个问题：①Y 的快照/缓存是否被其他因子消费（有→挂路由层，勿改内核）；②两套口径是否同屏声明；③失败降级是否只影响新卡。三问答完再动手。

### Metadata
- Source: conversation
- Related Files: lib/priceActionHub.js, server.js, public/index.html, public/css/style.css, public/js/app.js, scripts/test_price_action_level_validity.js, docs/logic/stock-13-capital.md（8.16 新节）
- Tags: cross-module-linkage, route-level-injection, dual-caliber-declaration, hidden-css-trap, snapshot-purity
- See Also: LRN-20261020-004（分钟级尾盘窗口铁律，同为「挂载点选择」家族）
- Pattern-Key: backend.cross_module_linkage_mount_at_route_layer
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-007：用户给的判定规范里，**约束不能做成加权罚项**——否则优化器永远选最宽松的解

**Logged**: 2026-10-20T21:35:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend | algorithm | tests | docs

### Summary
按用户七段式箱体规范新建 `lib/rangeDetector.js`（20261020f）。首次实现把「越界段数/假突破/振幅/占比」全部做成加权罚项，真实数据校准发现引擎**系统性选出宽区间**（601318 60 日选出振幅 14.2%、250 日选出 39.4% 的"箱体"），60 日振幅中位 22.2%、稳定命中 0/6。改为「振幅分池硬门槛 + 池内按硬约束违反度排序」后，60 日振幅中位降到 11.3%、000902 新洋丰真实命中（13.08~14.50，振幅 10.3%、占比 91.7%、假突破 3 次、漂移 2.7%）。

### Details
1. **根因**：`粗评分 = 越界段×3 + 假突破×2 + 振幅×0.5 + 越界占比×0.3` 里「0 越界」的边际收益远大于「窄 5% 振幅」，于是宽到 39% 的区间（0 越界）永远赢过窄到 8% 的区间（2-3 次假突破）。而用户规范第五条明确「优先满足：占比≥90%、振幅≤20%、假突破≤3」——是**约束**不是偏好。
2. **修法**：先按振幅分池（`ampPct ≤ 阈值` 进合规池），**只要合规池非空就只在池内选**，哪怕合规候选假突破超标（据实报原因）；合规池全空才退回全池取最小振幅者。此时选出的才是"在振幅约束下最好的区间"，符合用户意图。
3. **阈值必须实测标定**：用户原始 20% 振幅 / 5% 漂移 / 250 日窗，实测 6 只自选股振幅 24.6–49.3%、漂移 10.5–52.1%，全部落空。改为随窗口缩放（12/18/25/35%、8/10/15/20%）后命中 1/6（60 日），既不空也不滥。**规范里的数字是"意图"，落地必须用真实数据校准**。
4. **假突破的「差一」陷阱**：「首次突破后 5 个交易日内（含第 5 个）」→ 突破日算第 1 个，收回日的下标差 ≤ **4**。写成 `≤5` 会把第 6 天收回也判成假突破，与用户明确要求相反。已在代码注释写明推导，单测 [2] 锁定"第 6 天收回=有效突破"。
5. **手工对账是最强验证**：只用单测通过不足以证明计数正确，实测把 000902 的 3 个越界段逐日列出（起始日/越界天数/收回日/距突破天数/判定）与引擎对账，完全一致后才认为可交付。
6. **一个计数器只表示一种单位**：`upBreak` 是"段数"，`intraUp` 是"天数"，同屏展示时必须分别标注「次/天」，否则用户必然误读。

### Suggested Action
后续凡"用户给了判定规范"的需求：先把每条读成「硬约束 / 软偏好」两类；硬约束实现为**过滤或分池**，软偏好才做加权；规范里的阈值默认视为待校准意向值，必须用真实数据跑一遍命中分布再定稿。

### Metadata
- Source: conversation
- Related Files: lib/rangeDetector.js, lib/priceActionHub.js, public/js/app.js, public/css/style.css, scripts/test_range_detector.js, docs/logic/stock-17-range.md
- Tags: constraint-vs-weight, threshold-calibration, off-by-one, manual-reconciliation, multi-window
- See Also: LRN-20261020-003（阈值具象化）、LRN-20261020-006（跨模块联动三问）
- Pattern-Key: backend.constraints_must_be_filters_not_weights
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-008：阈值要相对"个股自身波动"，且多窗口结果不能平权——主判定窗 + 置信度分级

**Logged**: 2026-10-20T21:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend | algorithm | frontend | docs

### Summary
箱体引擎第二轮升级（20261020g），用户指出「不要只按窗口缩放，要结合波动率；漂移不要用上下沿绝对漂移；主判定只用 250 日；置信度要分级」。四条全部落地，并发现两条新的经验性结论。

### Details
1. **固定阈值对不同波动率股票不公平**：同一 25% 振幅，对 σ=10% 的低波动股是"很宽"，对 σ=50% 的高波动股是"很窄"。改为 `ampMax = clamp(1.5×σ250年化, 窗口基准×0.6, min(窗口基准×1.4, 35%))`——低波动股收到 15%、高波动股放到 35%（用户「不应低于 1.5–2 倍波动率，但不超过上表上限」）。下限 `×0.6` 是防呆：σ=2% 时若纯按 1.5σ 只有 3%，任何箱体都不合格。
2. **「上下沿绝对漂移」会误杀边界扩张但中轴未动的情形**：中国平安 250 日上下沿漂移 28.6%（旧口径直接判死），但中轴相对漂移只有 12.8%。边界被单边插针撑开 ≠ 区间中枢在移动。用户明确要求改用中轴漂移后，原口径降级为 `edgeDriftPct` **仅披露**——这种"降级为披露字段"的处理方式比直接删除更好（审计时还能看到边界形态）。
3. **多窗口不能平权**：4 个窗口各自独立判 stable 会让用户不知道该信哪个（60 日稳、250 日不稳时更迷惑）。必须显式指定主判定窗（用户指定 250 日），其余只做稳健性检验、**不一票否决**；主窗数据不足按 120→60 降级并写进 dataGaps。
4. **二值判定信息量不足**：「有/无稳定区间」丢掉了"主窗稳但辅助全不稳"这种真实状态。改三级置信度（高=跨窗口一致、中=仅主窗稳或连续越界过长、低=主窗不稳），并在低置信度时把"辅助窗稳定"作为提示而非结论。
5. **自适应的副作用必须用分级兜住**：σ 高的股票阈值顶到 35% 后，振幅几乎失去筛选力（实测 6 只全部 33%+），筛选实际由占比/假突破/有效突破承担。若不配「窄幅/常规/宽幅」分级，用户会把 35% 的宽幅箱体当成 18% 的窄幅箱体看待——用户提前警告过这一点（「500 日 35% 只能算宽幅箱体，不能和 250 日 18% 的窄幅箱体同等宣传」）。

### Suggested Action
后续凡"阈值判据"类需求：先问「这个阈值是绝对的还是相对于标的自身属性（波动率/规模/行业）」；凡"多时间尺度"类需求：先问「哪个尺度是结论、哪些只是佐证」，并把主/辅角色写进输出结构（role 字段），前端也要可见。

### Metadata
- Source: conversation
- Related Files: lib/rangeDetector.js, public/js/app.js, public/css/style.css, scripts/test_range_detector.js, docs/logic/stock-17-range.md
- Tags: volatility-adaptive-threshold, main-judgment-window, confidence-grading, drift-caliber, disclosure-vs-judgment
- See Also: LRN-20261020-007（约束不能做成加权项）
- Pattern-Key: backend.thresholds_should_be_relative_to_own_volatility
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-009：同一份数据要展示在两个列表里时，把「归属/标注/排序」收敛成一个纯函数

**Logged**: 2026-10-20T22:05:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend | frontend | docs

### Summary
用户要求把各窗口箱体的上沿/下沿「拆开」并进②卡已有的「上方关键阻力区间 / 下方关键支撑区间」，右侧标注所属窗口，整卡自上而下按价格由高到低（20261020h）。

### Details
1. **最省事的做法是错的**：第一版直接在 `app.js` 里写了 `_boxZoneLevels()` + 前端排序，跑起来没问题。但这种「哪条进阻力、怎么排序、标签写什么」的规则一旦落在渲染层，就**无法单测**，而且下一次改文案/改顺序时很容易只改一处——这与 20261019e「标签 + 解释 + 评分 + 配色必须四处同改」是同一类陷阱。改为放进 `lib/rangeDetector.mergeZoneLevels`（纯映射 + 排序），路由层 `zoneLevels` 下发、前端只渲染，一次性获得 30 项单测（`test_range_detector.js [15]`）。
2. **要不要放进 hub 快照**：不能。`priceActionHub` 的快照被 sameDayJudgment 的 technicalShort/Long 消费，往里塞展示字段会把只读因子拖进展示口径。与 20261020e 一致：**挂在路由层 `...data` 之后追加**，实时算、不缓存、不改快照语义。
3. **单点 vs 波段**：箱体边界是收盘统计得到的**点位**（low==high），摆动点区间是**波段**。混在一列里如果沿用 `low ~ high` 渲染会出现 `33.63 ~ 33.63`，必须按 `low===high` 渲染单值。
4. **等同点排序会看起来"乱序"**：按 `high` 降序时，单点 33.63 与波段 33.29~33.63 同顶点，稳定排序会让波段在前，视觉上像"更低的价格排在更高的上面"。追加 `low` 降序作次序键，让单点边界排在波段之前，顺序才可解释。
5. **未确认的边界要不要显示**：要显示（用户要的是"所有箱体的上下沿"），但必须让"未构成箱体"这件事在视觉上可辨——`stable=false` → 标注「未确认」+ 整行淡显；主判定窗即使未确认也保留「主判定」字样（否则 250 日就失去身份）。

### Suggested Action
凡"同一批数值要出现在两个视图/两个列表"的需求：先问「归属规则、排序规则、标注文案有几份」，超过一份就抽成纯函数放 `lib/` + 路由层下发 + 单测锁定；单值边界与波段混排时，先固定「单点优先」之类的次序键，再谈降序。

### Metadata
- Source: conversation
- Related Files: lib/rangeDetector.js, server.js, public/js/app.js, public/css/style.css, scripts/test_range_detector.js, docs/logic/stock-17-range.md
- Tags: single-source-of-truth, route-layer-enrichment, point-vs-band, tie-break-ordering, unconfirmed-state
- See Also: LRN-20261020-006（跨模块联动三问）, LRN-20261019-004（口径四处同改）
- Pattern-Key: frontend.presentation_mapping_must_be_a_tested_pure_function
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-010：用「窗口内累计天数」当判据会系统性误杀趋势股——判据必须带方向性且看"事件"不看"占用时长"

**Logged**: 2026-10-20T22:15:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend | algorithm | frontend

### Summary
用户给阻力/支撑有效性检验两条标准（无放量即突破→无效；超过三天在该处来回突破→无效）。第一版把第二条实现成「近60日收盘在区间外的天数 > 3」，实测 600909 三个上方价位全部被判无效——因为它们确实有 43/36/33 天收在上方。**卡片直接空白**。改成「方向性 + 内外反转次数」后恢复正常。

### Details
1. **缺方向性 = 语义错位**：「阻力」只对「向上穿越」敏感。股价从 9 元跌到 7 元，一路穿过 7.94/7.79/7.54 三个价位，那是**跌下来的**，不是「向上突破阻力」。用 `close > high` 的天数（不分方向）计数，等于把「历史上价格曾在它上方」当成「被突破了 43 次」。
2. **「占用时长」不是「事件」**：同一批 43 天其实只是**一段**持续在上方的行情，反转次数只有 1 次。判「来回突破」必须数**内外反转（in↔out）次数**，而不是在外侧待了多少天。这是本轮最贵的教训：一个可解释的指标（外侧天数）在趋势行情里会退化成"恒真条件"（与 LRN-20261020-004 的「恒真条件=隐形误报发生器」同型）。
3. **「超过三天」的两种合理落法都要实现**：a) 当前已站上/跌破且**连续 > 3 天**（已突破并站住 → 不再是阻力/支撑）；b) 窗内反转 **> 3 次**（约 2 个完整来回）。只做 b) 会漏掉"放量突破后一路不回"的情形——那种价位继续挂在「上方阻力」里同样误导。
4. **测试先行抓到了 null → 0 的坑**：`Number(null) === 0`、`Number('') === 0`，缺字段被当成价格 0 后 `close > 0` 恒成立，整段被判「当前站在外侧」。`_num()` 必须先挡 `null/''/boolean`。这条是单测 [9] 直接抓出来的，不是线上事故。
5. **打标而不是删除**：区间在 `priceAction.js` 原地加 `valid/invalidReasons/zoneCheck`，前端过滤、④卡反转边界取首个有效项。若在各处各自 `filter`，很快会出现「前端隐藏、后端仍当有效用」的双口径。

### Suggested Action
凡「有效性/失效」类判据：①先问方向性（对上穿敏感还是对下穿敏感）；②问计数对象是**事件**还是**占用时长**，优先事件；③把「当前状态已越界且持续」与「历史反复穿越」拆成两条独立条件；④打标不删条目，过滤只在一处发生。

### Metadata
- Source: conversation
- Related Files: lib/zoneValidity.js, lib/priceAction.js, public/js/app.js, scripts/test_zone_validity.js, docs/logic/stock-18-zone-validity.md
- Tags: directional-judgment, event-vs-duration, null-coercion, flag-not-delete, invalid-level-filtering
- See Also: LRN-20261020-004（恒真条件）, LRN-20261020-007（约束做成过滤而非加权）
- Pattern-Key: algorithm.validity_must_be_directional_and_event_based
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-011：「固定回看窗口」是形态判定最难察觉的错——形态的长度应由形态自己决定，而不是由我们的窗口决定

**Logged**: 2026-10-20T23:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend | algorithm | frontend

### Summary
箱体检测先后做了两版：20261020f/g/h 版用固定窗口（60/120/250/500 日）+ 窗口基准振幅上限；20261020j 版改为**单箱体状态机**（20 日种子 + 无长度上限 + 容差随长度放宽 + 连续 3 日突破失效）。触发改版的证据：600909 在 7/28~10/20 这 55 个交易日里收盘占比 100%、越界段 0、中轴漂移 4.8%（几乎完美箱体），却被旧版判「不构成」——只因振幅 19.4% 超过 60 日窗口的 16.8% 阈值。

### Details
1. **错不在阈值高低，在「窗口」这个概念本身**：把 55 天的形态塞进 60 日窗口再拿 60 日的振幅标准衡量，等于用错误的尺量。用户原话「箱体只要没失效就是一直随时间而延长的」点破了根因——**形态的长度是输出，不是输入**。凡「形态检测」类需求（箱体、三角收敛、平台整理），先问一句「它的长度是给定的还是算出来的」。
2. **中轴用中位数而非均值**：用户要求「振幅距离中轴」，中位数对单日长影线/跳空更稳健；且中位数是段内实际存在的价格水平，解释性更强。
3. **容差放宽必须给天花板**：`min(10%×√(len/20), 15%)`。√ 来自随机游走位移 ∝ √t，线性放宽会让久箱体的带宽迅速失去意义；不封顶则任何长周期股票都能套成箱体（用户此前已批评过「500 日 35% 只能算宽幅箱体」）。**放宽规则要能一句话说清依据**，否则就是拍数字。
4. **失效判据必须与「有效性检验」物理隔离**：用户明确要求箱体失效（连续 3 日突破，不看量）与阻力/支撑有效性（放量 + 反转次数）两套独立。实现上做了**源码级双向守卫**（互不 require、不共用常量、源码里不出现对方标识），而不是只写在注释里——否则半年后有人「顺手复用一下量比」，两套口径就悄悄合并了。
5. **展示层要给两个数，不是折中成一个**：箱体行同时展示「收盘区间（实际高低，用户核对形态用）」与「失效线（中轴±容差，判定用）」。只给实际区间会让人以为「破了最高点箱体就废了」（实际失效线更高）；只给失效线则与用户观察对不上。**给人看的数和给机器判的数不是同一个数时必须都露面**，中轴/振幅/假突破次数收进悬停。
6. **接线守卫是最便宜的回归测试**：新增 `[15]` 节，用源码扫描断言「引擎被 require、快照挂了字段、②卡调用了渲染函数、旧函数没复活」。历史上「引擎写好了却没接上」是静默回归的高发模式，一次断言覆盖全部。

### Suggested Action
新增形态/结构检测前先确认三件事：①长度是输入还是输出；②放宽/收紧规则的对标依据能否一句话说明；③它与既有口径是否必须隔离（能隔离就加源码级守卫，不要只写注释）。展示层若「实际值」与「判定阈值」不同，两者必须同屏并注明用途。

### Metadata
- Source: conversation
- Related Files: lib/rangeDetector.js, lib/priceActionHub.js, public/js/app.js, public/css/style.css, scripts/test_range_detector.js, docs/logic/stock-17-range.md, docs/logic/stock-18-zone-validity.md
- Tags: pattern-length-as-output, median-axis, tolerance-cap, caliber-isolation, dual-number-display, wiring-guard
- See Also: LRN-20261020-007（约束做成过滤而非加权）, LRN-20261020-009（同一数据两个列表收敛成纯函数）
- Pattern-Key: algorithm.formation_length_must_be_derived_not_assumed
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-012：前端读后端的字段名漂移不会报错，只会静默显示 undefined——改了 zoneCheck 却忘了改 tooltip

**Logged**: 2026-10-20T23:42:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
20261020i 把阻力/支撑标准2 的判据从「区间外天数」改成「内外反转次数」，后端 `zoneCheck` 字段随之从 `outDays/maxOutDays/breakDate/breakVr` 改为 `transitions/crossMax/streakNow/outStreakMax/lastBreakDate/lastBreakVr`。后端单测 54/54 全绿，但前端 tooltip 仍在读旧字段名 —— 悬停会显示「近60日收盘在区间外 undefined 天（上限 undefined 天）」且**不抛错、不进日志**。

### Details
1. JS 读不存在的属性只得到 `undefined`，`escapeHtml(undefined)` 也不报错，所以这类不一致**零噪声**：没有异常、没有 console.warn，只有用户把鼠标放上去才看见。
2. 单测只覆盖后端纯函数，看不见「前端字符串里引用了哪个字段名」。这类接缝必须有源码级断言：`test_range_detector.js [15]` 现在同时守着「②卡调用的函数存在」，可作为同类问题的模板。
3. 修复时顺手把 tooltip 改成分行明细（反转次数/当前站外天数/最近穿越日与量比/未穿越说明/展示条件），并把「上限」数字从常量里读（`ck.crossMax/ck.outStreakMax`），不再硬编码 3。

### Suggested Action
后端改 `zoneCheck` 之类「只给前端消费」的结构体时：①同一次改动里 grep 前端对该结构体所有字段的引用；②在前端侧加一条源码扫描断言（字段名清单）；③字段名保留期加 `deprecated` 别名比直接改名安全，但优先级低于前两条。

### Metadata
- Source: conversation
- Related Files: public/js/app.js, lib/zoneValidity.js, scripts/test_range_detector.js
- Tags: field-name-drift, silent-undefined, frontend-backend-contract, source-scan-guard
- See Also: LRN-20261020-011（接线守卫）
- Pattern-Key: frontend.contract_field_names_need_source_scan_guard
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-013：把「形态边界」并入价位清单时，要并的是**实际上下沿**而不是**判定阈值**；而过滤顺序本身就是约束

**Logged**: 2026-10-20T23:55:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend | frontend

### Summary
用户要求「把箱体的上下限合并到上方阻力和下方支撑区间里面」。箱体有两个候选"上下限"：实际收盘区间 `envU/envL`（600909 = 8.54 / 7.03）与中轴±容差的失效线 `bandU/bandL`（9.35 / 6.91）。并入清单时取了**前者**，失效线继续留在箱体行。

### Details
1. **「能交易的价位」与「判定的阈值」不是同一类东西**：失效线是纯数学边界（中轴×1.15），离现价 33%、从未被价格触碰；摆在「上方阻力」里既不可交易，也会与用户「箱体上沿就应该是 8.54」的直觉正面冲突。判据：**这个数字有没有被价格验证过**——没有就不能当阻力/支撑。
2. **两个数各司其职，不要合并成一个**：清单收实际上下沿（可交易），箱体行留失效线（可判生死），tooltip 明示「越过 9.35 连续 3 日才判箱体失效」。合并会让两件事都被削弱。
3. **并入后必须删掉原处的重复展示**：箱体行原本有「收盘区间 7.03~8.54」，并入清单后同屏出现两次同一组数字会制造"这两个是不是不一样"的疑问，故行内只留起止天数/失效线/距失效。
4. **过滤顺序即约束**：箱体条目 `isBox:true`，前端必须写成 `validOnly(摆动点).concat(箱体条目)`——**把箱体条目写在 validOnly 里面，它就会被区间有效性检验静默吞掉**，而箱体检验与区间检验本来就要求独立（用户第六条）。这种"只差一层括号"的耦合无法靠输出断言发现，只能靠源码正则守卫（单测 [16]）。
5. **单侧越界要单侧省略**：现价已收在某侧边界之外时，该侧条目不再当阻力/支撑（否则「刚破的上沿」会继续挂在"上方阻力"里误导），另一侧照常保留。
6. **单点价渲染单值**：箱体边界 `low===high`，若沿用 `a ~ b` 模板会输出 `8.54 ~ 8.54`，前端必须判等后渲染单值（与 20261020h 同一坑，第二次踩，已写进单测）。

### Suggested Action
凡「把 A 的边界并入 B 的清单」：①先问并的是实际观察值还是判定阈值，默认取前者、后者留在原处；②并入后删掉原处的重复展示；③若 B 有过滤规则而 A 的检验独立，用「先过滤 B 再 concat A」的写法并用正则守卫锁死顺序；④单点价一律判等渲染单值。

### Metadata
- Source: conversation
- Related Files: lib/rangeDetector.js, public/js/app.js, public/css/style.css, scripts/test_range_detector.js, docs/logic/stock-17-range.md, docs/logic/stock-18-zone-validity.md
- Tags: observed-vs-threshold, filter-order-as-constraint, dedup-display, single-point-rendering, caliber-independence
- See Also: LRN-20261020-011（单箱体模型）, LRN-20261020-009（同一数据两个列表收敛成纯函数）, LRN-20261020-010（有效性判据方向性）
- Pattern-Key: presentation.merge_observed_bounds_not_thresholds
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-014：用户说「删掉这个模块」时，必须用截图锚定到**具体元素**再动手——我上一轮就删错了模块

**Logged**: 2026-10-20T23:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: process | backend | frontend

### Summary
20261020i 那一轮，用户给了两张截图并说「把图片里这个模块本身和与短期动向预判模块的联动一起删除」。当时同一句话里还有大量关于「箱体判定不构成」的讨论，我据此断定要删的是**箱体区块**，于是删了箱体、保留了「关键位有效性检验」卡。本轮用户又贴出那张卡质问：「之前的任务我不是让你删除这个模块吗？」——**我删错了模块，而且用户是隔了两轮才发现的**。

### Details
1. **代价不对称**：删错的成本不是"多删了一个东西"，而是"用户以为交付了、实际没交付"。期间我还基于"模块已删"继续做了三件事（单箱体重建、上下限并入清单），全部建立在错误前提上。
2. **正确的锚定方式**：截图里的**标题文字**是唯一可靠的主键（「关键位有效性检验」/「生死位规则口径」/「箱体判定」），拿它去 grep 代码里的 `<h4>` / 注释 / 类名，能精确落到组件 id（本例 `#paLevelValidity`）。**讨论上下文不能当主键**——同一段对话里可能同时在说三四个模块。
3. **动手前用一句话回读**：「您指的是这张『关键位有效性检验（生死位规则口径）』卡，我会连同 X/Y/Z 一起删」，用户点头再删。一次回读的成本远低于删错。
4. **删除必须有完整清单**：模块本体（组件/样式/路由/引擎函数/单测/文档）缺一项就会留下孤儿代码。本轮清单：`getLevelValidity` `_extractLevelValidity` `_lvCache` `LV_TIMEOUT_MS`（hub）+ 路由 `levelValidity` 注入 + `#paLevelValidity` `_renderLevelValidity` 复位/错误占位（前端）+ `.pa-lv-*`（CSS）+ 单测文件 + 文档 8.16 节下线声明 + 清理连带失效的 `analyzeVolume`/`getQuote` require。
5. **连带清理**：删掉唯一调用者后，`require` 与被依赖常量会变成死代码，`swallow_catch_guard` 之类的扫描反而会误报"空 catch 增加"。删模块要顺带把死依赖删干净。

### Suggested Action
凡"删模块"类指令：①用截图标题文字 grep 定位到组件 id；②列删除清单并回读一句确认；③按「前端 → 后端 → 路由 → 样式 → 单测 → 文档」六层依次清；④清死依赖；⑤留下"下文仅作历史存档"的下线声明，防后人恢复。

### Metadata
- Source: conversation
- Related Files: lib/priceActionHub.js, server.js, public/index.html, public/js/app.js, public/css/style.css, docs/logic/stock-13-capital.md
- Tags: module-identification, screenshot-as-key, deletion-checklist, dead-dependency-cleanup
- See Also: LRN-20261020-013（并入清单的是实际值还是阈值）
- Pattern-Key: process.identify_module_by_screenshot_title_before_delete
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-015：展示出来的每个数字都是一句断言——「还剩 3 天」是断言在倒数，「只统计突破」是断言到达不算数

**Logged**: 2026-10-20T23:50:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend | frontend

### Summary
同一条报障里暴露了两个方向相反、根因相同的错误：①箱体行显示「距失效还需 3 日」——可股价一直在箱体内，失效条件（连续 3 日收盘在失效线外）**根本没被触发**，这个"剩余"不存在；②阻力/支撑的有效性检验在该触发时不触发——因为「越界」被实现成「越过区间远端」，而价格只是在区间近端反复进出。

### Details
1. **倒计时类字段必须在条件未触发时为 null**：`remainDays` 原本无条件算成 `OUT_BREAK_DAYS - outStreak`，`outStreak=0` 时就得到 3，前端照渲染成"还剩 3 日"。正确语义：`currentStreak === 0 → remainDays = null`，UI 只能说「未触发失效」；只有真越界才允许出现数字。**"还剩 N"本身就是断言"正在倒数"，不是中性描述。**
2. **区间（带）天然有两种越界语义，必须分别定义**：
   - `beyondOf` 真突破 = 越过远端（阻力 `>high` / 支撑 `<low`）→ 谈"有没有放量"才有意义；
   - `touchOf` 到达 = 到达近端（阻力 `>=low` / 支撑 `<=high`）→ 谈"来回了几次"才有意义。
   只用前者：603288 在 34.33~34.67 反复进出 7 次却从未收在 34.67 之上 → 一次都不计 → 永远"有效"（用户直问"为什么不触发"）。只用后者：单次穿过去也会被算成"反复"，且"放量"判据失去基准。
3. **字段改名而不是改语义**：`transitions`（远端口径）改名为 `touchTransitions`（近端口径）后，任何消费方不改就取到 `undefined`，会立刻暴露而不是静默错——比保留同名换含义安全得多。
4. **守卫要守着"文案不存在"**：单测断言 `app.js` 出现「距失效还需」即红（注释除外），把"旧说法不许复活"变成可执行约束，而不是靠记性。

### Suggested Action
凡涉及"剩余/倒数/还有 N 次"的字段：先问"这个条件是持续态还是事件"，持续态未触发时必须给 `null`，UI 只声明状态。凡对"区间/带"做穿越判定：把"到达"与"穿越"拆成两个谓词，各用各的，并在注释里写明为什么不能合并。

### Metadata
- Source: conversation
- Related Files: lib/rangeDetector.js, lib/zoneValidity.js, public/js/app.js, scripts/test_range_detector.js, scripts/test_zone_validity.js, docs/logic/stock-17-range.md, docs/logic/stock-18-zone-validity.md
- Tags: countdown-semantics, null-when-not-triggered, predicate-granularity, reach-vs-breakout, copy-guard
- See Also: LRN-20261020-010（判据要带方向性、看事件不看占用时长）, LRN-20261020-004（恒真条件）
- Pattern-Key: presentation.every_number_is_an_assertion
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261020-016 · 「单调侵蚀」：区间只能被动消耗，不能随价格回落在数值上长回去

**Logged**: 2026-10-20T23:59:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend | frontend

### Summary
用户给区间（带）加了第二条几何规则：**无放量侵入内部但没打穿 → 近端收紧、远端不变**。实现时最容易写错的不是条件，而是「取哪一次收盘」——取最后一次会让区间跟着价格回落在数值上「长回去」，等于没侵蚀。

### Details
1. **三条件缺一不可**：`low < close < high`（真进入内部且未打穿） + 量比 `<= 1.2`（与标准1 同源同阈值） + 量比可算（`!= null`）。少掉"量能可算"，就会在数据缺失时靠 `null <= 1.2` 这种隐式转换把区间收掉。
2. **单调侵蚀取极值**：阻力取窗口内所有合规侵入日的**最高**收盘、支撑取**最低**收盘。反例：8.48 → 8.52 → 8.50，取最后一次得 8.50，区间从 `8.52~` 退回 `8.50~`，与"已消耗"事实矛盾。
3. **顺序是语义的一部分**：`assessZones`（要不要展示）→ `erodeZones`（展示成多大），**不可颠倒**；且侵蚀结果**不回灌**有效性计数——若把收紧后的近端喂回 `assessZone`，原先算到的往返次数会消失，形成「越侵蚀 → 越算不出往返 → 越有效」的自我强化循环。这是 LRN-20261019f「确认机制不许有改判权」的同构版本：**几何调整不许有改判权**。
4. **无效区间不侵蚀**：不展示的区间没有"剩下多大"的问题；对它做收缩只会在统计上制造假象。
5. **接线要守顺序**：单测用源码 `indexOf` 比较 `assessZones(daily` 与 `erodeZones(daily` 的先后，把"顺序铁律"变成可执行断言，而不是注释里的口头约定。

### Suggested Action
凡"状态会因历史事件单向变化"的字段（消耗、侵蚀、封顶、累计）：① 必须在定义里写明"只许单调"，② 取极值而非末值，③ 提供反例单测（先大后小 → 结果仍取大）。凡两步判定的流水线：把顺序写进单测，而不是只写注释。

### Metadata
- Source: conversation
- Related Files: lib/zoneValidity.js, lib/priceAction.js, public/js/app.js, public/css/style.css, scripts/test_zone_validity.js, docs/logic/stock-18-zone-validity.md
- Tags: monotonic-erosion, order-invariant, no-feedback-loop, threshold-reuse, source-level-guard
- See Also: LRN-20261019f（确认机制无改判权）, LRN-20261020-015（每个数字都是断言）, LRN-20261020-013（过滤顺序即约束）
- Pattern-Key: state.monotonic_only_absorbs
- Recurrence-Count: 1
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-20

## LRN-20261021-001 · 同排不同量纲：收益率不是点位，涨跌幅不是基点

**Logged**: 2026-10-21T00:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend | frontend

### Summary
用户要求在「🇺🇸 美国指数」三个卡（道指/纳指/标普）后面加「美债10年期收益率」。看似只是多一个卡，实际是把**两种量纲**塞进同一行：指数是「点位 + 涨跌幅%」，国债收益率是「收益率% + 基点bp」。直接套用同排的 `fmt()` / `fmtPct()`，会渲染出「5.15」（被读成点位）和「+1.18%」（被读成涨跌幅，实际是收益率相对变动），两个数字都是错的表达。

### Details
1. **先定"这行是什么"，再决定能不能共享渲染**：三个卡共享 `renderTile`，是因为它们同量纲同语义；新增项若量纲不同，必须走**独立分支 + 独立 return**，而不是往模板里塞条件。条目带 `kind:'yield'` 作为分派键。
2. **单位必须写在值上，不能靠上下文**：`5.15%`（收益率）与 `+6.0bp`（变动）都自带单位；`bp` 是债券市场通用表达（1bp = 0.01 个百分点），比「+0.06」或「+1.18%」都更不容易被误读。
3. **频率也是数据的一部分**：日线数据混进实时行里，必须在卡片上写「日线·MM-DD」，并把整行来源标签从「腾讯行情」改成「腾讯行情 + 美国财政部（日线）」——否则就是拿真实数据做虚假标注。
4. **数据源选型必须先实测可达性，不能看文档选**：本项目此前的东财 push2 族、CNBC、Yahoo、TradingView、华尔街见闻 market API 全部不可达/下线，腾讯与新浪根本没有美债收益率代码。可达且权威的只有**美国财政部官方日度收益率曲线 CSV**（比 FRED 还新一个交易日：10/19 vs 10/16）。选型结论要写进模块头注释，避免下一个人再猜。
5. **过期要分两档**：>3 天打 ⚠（周末/美国假日常见，属正常）、>10 天不展示（不拿过期数据当现行）。只有"展示/不展示"两态会把正常的周末误判成故障，只有"永远展示"又违反数据最新性。
6. **降级要有总预算**：单源 9s × 3 级 = 最坏 27s，首页等不起 → `Promise.race` 卡 12s，超时先返回 null（本次不渲染卡片），后台链路继续跑并可写缓存，下次刷新命中。**不能为了一个附加字段拖慢整块首页。**

### Suggested Action
新增任何"往既有列表里塞一项"的需求时，先问三句：① 它的**量纲/单位**和邻居一致吗？② 它的**更新频率**和邻居一致吗？③ 它的**数据来源**和邻居一致吗？任一不同 → 独立渲染分支 + 卡内自带单位与频率 + 行级来源标签按项合并写明。数据源选型一律以"本机 curl 实测可达"为准，并把不可达清单写进代码注释。

### Metadata
- Source: conversation
- Related Files: lib/usTreasury.js, lib/stockData.js, public/js/app.js, public/css/style.css, scripts/test_us_treasury.js, docs/logic/home-02-realtime-market.md
- Tags: unit-mismatch, percent-vs-bp, freshness-labeling, source-reachability, total-timeout-budget
- See Also: LRN-20261020-015（每个数字都是断言）, LRN-20261020-013（过滤顺序即约束）
- Pattern-Key: presentation.unit_travels_with_value
- Recurrence-Count: 1
- First-Seen: 2026-10-21
- Last-Seen: 2026-10-21

## LRN-20261021-002 · 外链要「实查 secid」而不是猜 URL；链接页与本地卡口径不同时必须显式声明

**Logged**: 2026-10-21T00:55:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend | frontend

### Summary
用户要求「美债收益率链接这个指数」，给了一张东财行情页截图。凭经验猜 URL 会踩两个坑：① 东财的页面路径与 secid 一一对应且**不统一**（`/usbond/US10Y.html`、`/globalbond/US10Y.html` 都是 404）；② 找对了页面，页面上的数字（盘中实时 2.78%）与卡片上的数字（财政部日线 5.15%）**本来就不是一个东西**，用户点进去会以为程序算错了。

### Details
1. **用搜索接口实查，不要猜路径**：`searchapi.eastmoney.com/api/suggest/get?input=美国10年期国债收益率&type=14` 返回 `QuoteID=171.US10Y`（market 171 = 全球债券）；东财有**通用行情页** `https://quote.eastmoney.com/unify/r/<市场号>.<代码>`，对任意 secid 都成立（实测 A股 1.600519 同样 200）。要验证 URL 正确，看返回 HTML 的 `<title>` 是否为该指数名——这是唯一可靠的确认方式。
2. **URL 由数据侧下发，前端不硬编码**：`lib/usTreasury.js` 的条目带 `linkUrl/linkLabel`，前端只负责渲染。这样以后换指数/换站点只需改一处，且缺 `linkUrl` 时天然降级为不可点卡片。
3. **用 `<a>` 而不是给 div 挂 onclick**：中键新窗口、复制链接地址、状态栏预览目标、无障碍语义全部免费获得；只需 CSS 抹掉 `text-decoration` 并继承色（否则整卡文字变蓝带下划线）。
4. **两套口径必须在 tooltip 里说清**：本卡＝美国财政部日度收益率；链接页＝东财 push2 盘中实时报价。同一时点实测 5.15% vs 2.78%（东财自己的数据中心给的也是 5.15%），说明是「实时口径 vs 日度口径」的差异，不是本卡的 bug。**绝不能为了让两个数字「看起来一致」去改卡片数值或删掉链接**——那是拿真实数据做假一致。
5. **点击目标要带 `rel="noopener noreferrer"`**：`target=_blank` 不加 rel，新页面可通过 `window.opener` 反向操作本页。

### Suggested Action
凡"让某个卡片指向某个网站/页面"的需求：① 先用该站的搜索/联想接口查真实 ID，再用页面 `<title>` 反验 URL；② URL 放数据层、前端只渲染；③ 用原生 `<a>` + `rel`；④ 若链接页与本地卡的数据口径/频率不同，tooltip 必须写明，并在文档审计清单里留一条"禁止为了一致而改数"。

### Metadata
- Source: conversation
- Related Files: lib/usTreasury.js, public/js/app.js, public/css/style.css, scripts/test_us_treasury.js, docs/logic/home-02-realtime-market.md
- Tags: external-link, secid-lookup, title-verification, caliber-disclosure, a-tag-native
- See Also: LRN-20261021-001（同排不同量纲）, LRN-20261020-013（过滤顺序即约束）
- Pattern-Key: integration.verify_target_before_linking
- Recurrence-Count: 1
- First-Seen: 2026-10-21
- Last-Seen: 2026-10-21

## LRN-20261021-003 · 结算类字段不能盲信存储值：写入时过日历，结算时再审一遍

**Logged**: 2026-10-21T11:10:00+08:00
**Priority**: critical
**Status**: resolved
**Area**: backend

### Summary
用户反复报障「老是出现无法结算准确率」（截图：大盘技术分析卡「⚠ 2 条过期未结算」）。根因不是结算算法，而是**记录里存的目标日不是交易日**：旧口径的 `nextTradingDay` 只跳周末不跳法定节假日，把 `2026-09-24` 的次日写成中秋 `09-25`、`09-30` 的次日写成国庆 `10-01`。结算逻辑老老实实按存储值去 K 线里找那一天 —— K 线永远没有节假日 —— 于是 `return rec` 不结算，同时因为 `targetDate < today` 被永久计入「过期未结算」。**一个错误的输入字段，把"未结算"变成永久状态。**

### Details
1. **存储值是历史快照，不是当前事实**：任何"由规则推导出来"的字段（目标日、下一交易日、到期日）在写入时是对的，但**规则本身会变**（日历补入节假日、口径改版）。结算方必须按**当前规则重算**，只在重算结果与存储值冲突时以重算为准，并留痕（`targetDateFixed`），而不是无条件信任。
2. **纠错要有边界**：目标日没有 K 线还有第二种成因——数据缺口。此时可以退到"其后首个有 K 线的交易日"，但必须**限距**（这里 5 个自然日）并留痕（`shortTargetFallback`）；超过就拒绝结算并写 `settleError`。否则"次日"会被静默替换成"半个月后"，准确率统计直接失真。
3. **只读接口 = 永不推进**：准确率条命中 `/api/market-tech/records`，该接口原来只有 `?settle=1` 才结算 → 用户不点「结算」就永远看到旧状态。读路径应顺带结算（带节流 3 分钟），让系统自愈，而不是把"记得点按钮"当成用户义务。
4. **顺手把 N 次网络请求压成 1 次**：`settleAll` 原来每条记录各拉一次指数日K，19 条=19 次请求；改成整批共享一次。修 bug 时顺手看一眼循环里的 IO 是划算的。
5. **改字段的位置要先问"它是不是键"**：`sameDayJudgment` 里 `rec.targetDate` 同时是**文件名语义键**，所以那边只把修正值用于本次查找、**不改写字段**；而 `marketTechJudgment` 的文件名是 `baseDate`，改写 `targetDate` 安全。同一个字段在不同模块的可写性不同。

### Suggested Action
任何"记录里有推导出来的日期/状态字段"的模块：① 写入前过权威日历；② 结算/核对时按当前规则重算并对比，冲突以重算为准 + 留痕；③ 重算也找不到对应数据时，兜底要限距并留痕，超距就报错不结算；④ 让读取路径自动结算（带节流），别让用户手动点；⑤ 改字段前确认它是不是文件名/去重键。

### Metadata
- Source: conversation
- Related Files: lib/marketTechJudgment.js, lib/sameDayJudgment.js, lib/cnTradingCalendar.js, server.js, scripts/test_market_tech_settle.js, docs/logic/home-03-market-technical.md
- Tags: settlement, stale-derived-field, holiday-calendar, self-healing, throttled-autosettle
- See Also: LRN-20261020-001（兜底日期落库前必须过交易日历）, LRN-20261020-015（每个数字都是断言）
- Pattern-Key: settlement.recompute_derived_target
- Recurrence-Count: 2
- First-Seen: 2026-10-20
- Last-Seen: 2026-10-21

## LRN-20261021-004 · 用户手工标注与模型输出必须分层：可以同屏，不能让模型裁决用户的标注

**Logged**: 2026-10-21T11:30:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend | backend

### Summary
用户要在②卡加一条 tab 自己填阻力/支撑。最省事的实现是"把手动条目直接 push 进模型数组"——但那样它会经过 `validOnly` 的有效性检验、也会被 `erodeZone` 收缩。结果是：**用户加了，模型判它"无效"或"已被吃过"，界面上看不见**，用户会以为功能坏了，而且无从解释。

### Details
1. **谁的数据谁裁决**：模型区间的展示与否由 `zoneValidity` 决定；用户标注的展示与否只由用户自己决定（他自己点删除）。实现上手动条目必须在 `validOnly(...)` **之后** concat 追加，且不经过侵蚀。
2. **同屏但可辨识**：手动条目与模型条目并列在同一清单（用户要的就是"补上模型漏掉的位"），但用不同的左边框样式 + 「手动」小标 + tooltip 说明口径，一眼能分清责任归属。
3. **口径要写在卡片上，不是只写在文档里**：手动页签顶部直接写「不参与模型的有效性检验与侵蚀收缩，也不影响方向判断、概率与准确率统计」——否则用户会以为加了就能影响判断。
4. **表单的"省略即默认"要在接口层再兜一次**：前端"只填一个价=单点"是 UI 约定；后端如果不兜，任何直接调 API 的场景（或前端漏传）就会报「请填写有效价格」。**前端约定不能当成后端不变量。**
5. **持久化位置决定体验**：存 localStorage 会在换设备/清缓存后丢；这类"用户自己录进去的数据"应存服务端（`data/manual-zones/<code>.json`），与用户"手机端继续用"的用法一致。
6. **重渲染后要恢复页签**：增删触发整卡重渲染，若不复原 `activeTab`，用户每次点「添加」都会被弹回模型页，看起来像"没成功"。

### Suggested Action
凡是"引入用户手工输入、与机器计算结果并列展示"的功能：① 两条数据流分开存、分开算，只在渲染层合并；② 机器口径**不得**过滤/修正用户数据；③ 合并处必须可辨识（样式+文案+tooltip 三件套）；④ 用户数据的校验在服务端重做一遍；⑤ 用户数据存服务端；⑥ 增删后重渲染要恢复交互态（页签/滚动/展开）。

### Metadata
- Source: conversation
- Related Files: lib/manualZones.js, server.js, public/js/app.js, public/css/style.css, scripts/test_manual_zones.js, docs/logic/stock-19-manual-zones.md
- Tags: user-input-vs-model, layering, no-model-veto, server-side-persistence, ui-state-restore
- See Also: LRN-20261020-013（过滤顺序即约束）, LRN-20261020-014（删模块要锚定组件）
- Pattern-Key: ux.user_data_never_vetoed_by_model
- Recurrence-Count: 1
- First-Seen: 2026-10-21
- Last-Seen: 2026-10-21
- **Superseded-By（2026-10-21 用户改口）**: 用户随后明确要求「手动添加的阻力和支撑区间同样接受本模块的两个有效性检验」——第 1 条「不参与有效性检验」作废，改为"同权检验、但不侵蚀、不影响判定"。保留此条是因为第 2~6 条（可辨识、口径上屏、服务端校验兜底、服务端持久化、重渲染恢复交互态）仍然成立。见 LRN-20261021-005。

## LRN-20261021-005 · 用户改口径时，代码之外还有三处会变成"假话"

**Logged**: 2026-10-21T15:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend | backend | docs

### Summary
20261021d 按"用户标注不受模型裁决"实现，手动区间不进有效性检验；当天用户改口「手动添加的阻力和支撑区间**同样接受**本模块的两个有效性检验」。代码改动不算大，真正危险的是**代码之外的表述会继续骗人**：卡片的 tooltip、页签顶部的口径说明、文档里的"铁律"章节、单测里的断言——它们全都写着旧口径，而界面照样在跑新逻辑。

### Details
1. **口径迁移要数四处**：① 代码分支 ② **界面文案/tooltip**（用户唯一会读的地方）③ 文档的"口径纪律"章节 ④ **单测断言**（否则测试在守护一个已废弃的约束，比如 `ok(!manualRes...)` 会一直绿着骗人）。
2. **"同权"不等于"全同权"，要把边界说清楚**：用户说的是「两个有效性检验」，侵蚀是第三条规则。实现上就要让 `attachManualZones` 在 `erodeZones` **之后** append —— 顺序即语义（LRN-20261020-013 同源）。
3. **改了"谁过滤"就要想"用户还看得见吗"**：手动区间一旦判无效就从清单消失，用户会觉得"我刚加的就没了"。所以「手动添加」页签必须**始终列出全部**（含无效）并标红+原因——**"被过滤"与"被隐藏"是两件事**：前者是规则，后者是信息丢失。
4. **接进缓存体系就要有失效路径**：手动区间并入快照后，增删必须 `invalidateSnapshot(symbol)`，否则非盘中 TTL 24h → 用户加完看不到，会被当成"功能坏了"。任何"用户可写数据 + 快照缓存"的组合都必须成对提供失效函数。
5. **旧学习要显式作废**：LRN-20261021-004 第 1 条已与用户决策冲突，必须标 `Superseded-By`，否则下一个人（或下一轮 AI）会拿旧"铁律"去回滚新需求。

### Suggested Action
用户改变某条口径时，按清单改：代码 → 界面文案 → 文档 → 单测 → 旧学习条目（标 Superseded）。任何"过滤/检验"类规则变更，都要同时回答"被过滤掉的东西用户还能不能看见、怎么看"。任何进缓存的数据，都要同时交付失效入口。

### Metadata
- Source: user_feedback
- Related Files: lib/priceActionHub.js, lib/manualZones.js, server.js, public/js/app.js, public/css/style.css, scripts/test_manual_zones.js, docs/logic/stock-19-manual-zones.md, docs/logic/stock-18-zone-validity.md
- Tags: caliber-migration, tooltip-truth, filtered-vs-hidden, cache-invalidation, superseded-learning
- See Also: LRN-20261021-004（Superseded 部分）, LRN-20261020-013（过滤顺序即约束）
- Pattern-Key: docs.caliber_change_four_places
- Recurrence-Count: 1
- First-Seen: 2026-10-21
- Last-Seen: 2026-10-21

## LRN-20261021-006 · 同一张卡片里两个不同窗口的指标，文案必须各写各的窗口

**Logged**: 2026-10-21T16:10:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
用户报障：「量能状态是平量，风险提示却写 量价背离（放量下跌或量价齐跌）」——看着像算错，其实是**文案把两个不同窗口的结论缝成了一句**：
- 量能状态 = **当日**成交量 ÷ 近20日均量 → 平量；
- 量价形态 = **近5日**价格趋势 × **近3日**量能趋势 → 量价齐跌。
两者可以同时成立且完全自洽，但旧文案写成「量价背离（放量下跌或量价齐跌）」，把三种互斥形态并列，于是"平量 + 放量下跌"同屏出现，等于自打脸。

### Details
1. **枚举比符号更可靠**：`pv.score` 只有正/负，负分下面藏着「齐跌 / 量升价跌 / 量缩价升」三种形态。只凭符号写文案必然只能写"最多数情形"或"全部并列"。给 `calcPriceVolume` 加 `kind` 枚举，下游按 kind 查表，才是单一来源。
2. **文案必须带窗口**：`近3日`/`近5日` 不是修辞，是让用户能把两个数字对上的唯一线索。凡是 3/5/20 日混用的模块，文案里不带窗口就一定会有下一次同类报障。
3. **把文案抽成可测的纯函数**：原本文案内联在 `computeMarketEmotion` 里，只能靠整条链路跑通才能验证。抽成 `pvRiskText(vp)` + `PV_RISK_TEXT` 后，可以单测「形态→文案」映射、可以断言「齐跌文案不含'放量'」这类不变量，也能被接线守卫检查"旧固定文案不许复活"。
4. **顺带发现真故障**：排查时上证日线返回 501，导致量能因子整块降级（卡片上没有量能状态）。这说明"文案怪"有时和"数据空"是两回事，**先看 issues/降级标记再判文案**。

### Suggested Action
任何卡片里同时出现"当日值"和"N日趋势值"时：① 文案各带窗口；② 形态用枚举而不是符号；③ 文案抽成纯函数并写"不变量单测"（如"非放量形态不得出现'放量'二字"）；④ 排查顺序固定为「先看降级标记 → 再看口径 → 最后看文案」。

### Metadata
- Source: user_feedback
- Related Files: lib/marketEmotionModel.js, scripts/test_market_emotion_volume_text.js, docs/logic/home-01-market-emotion.md
- Tags: window-mismatch, enum-over-sign, testable-copy, self-consistency
- See Also: LRN-20261019f（确认机制不许有改判权）, LRN-20261020-015（每个数字都是断言）
- Pattern-Key: copy.window_must_be_explicit
- Recurrence-Count: 1
- First-Seen: 2026-10-21
- Last-Seen: 2026-10-21

## LRN-20261021-007 · 单主机写死＝把整条数据链押在一个域名上（501 静默降级）

**Logged**: 2026-10-21T16:10:00+08:00
**Priority**: critical
**Status**: resolved
**Area**: infra | backend

### Summary
排查上一条文案问题时发现：`ifzq.gtimg.cn/appstock/app/fqkline/get` 对**所有代码**整段返回 501（sh000001/sz399001/sh600519/sz000902 全一样），而同一路径在 `web.ifzq.gtimg.cn` 正常 200。项目里 6 处 fqkline 调用点都写死了前一台主机 → 个股日K、大盘技术分析、市场情绪量价、准确率结算**同时降级**，而日志只有一条 `Request failed with status code 501`。

### Details
1. **同一路径的两个主机通常此消彼长**：历史上还出现过相反情况（旧注释写着"web.ifzq 已停用 501"）。所以正确做法不是"换成能用的那台"，而是**主机降级链**。
2. **降级只换主机，不改路径与参数**：把 `getKlineJson(pathQuery, opts)` 做成唯一入口，调用方拿到的仍是原响应体，解析逻辑一行都不用动——这让改动风险从"改 6 个模块"降到"改 6 行"。
3. **只对 5xx / 网络错误换主机**：4xx 是参数问题，换主机只是浪费一次超时。
4. **别把"空数据"当业务结论**：降级后因子归零、风险提示缺项、准确率全部挂起，这些表现都像是业务逻辑坏了。凡是数据驱动模块，**先看 issues/降级标记**。
5. **守卫要断言"没有裸 URL"**：`scripts/test_tkline_host.js` 直接扫源码，任何文件里再出现 `https://ifzq.gtimg.cn/appstock/app/fqkline` 就算红——否则下次有人新写一个调用点就绕过了降级。

### Suggested Action
接入任何第三方 HTTP 数据源时：① 确认它有没有等价域名，有就做成降级链；② 抽唯一入口函数，禁止业务代码直接拼 URL；③ 单测覆盖"第一台 5xx 切第二台 / 4xx 不切 / 全失败抛错"；④ 守卫扫源码禁裸 URL；⑤ 日志里带上"用了哪台主机"，否则排查时看不出降级发生过。

### Metadata
- Source: error
- Related Files: lib/tklineHost.js, lib/stockData.js, lib/marketTechnical.js, lib/marketTechJudgment.js, lib/deep/yield.js, server.js, scripts/test_tkline_host.js, docs/logic/common-01-data-source.md
- Tags: single-host-risk, host-fallback, silent-degradation, no-bare-url-guard
- See Also: LRN-20261021-006（同次排查发现）, LRN-20261021-003（只读接口永不推进）
- Pattern-Key: infra.host_fallback_chain
- Recurrence-Count: 1
- First-Seen: 2026-10-21
- Last-Seen: 2026-10-21

## LRN-20261021-008 · 「同一单位」的假设散落在多处＝同一份错误被复制三遍

**Logged**: 2026-10-21T16:20:00+08:00
**Priority**: critical
**Status**: resolved
**Area**: backend

### Summary
用户截图报障：「60 日均量 113900 ×1.5 = 170850（当日量 7358800）」——当日量是阈值的 43 倍，文案却说「未达阈值」。根因不是算术，而是**当日 K 线被实时行情覆写时单位换错**：代码假设"非腾讯通道的日K是股"，而**东财日K实测是「手」**，于是把「股」写进了「手」序列，当日量凭空 ×100。顺着这条线全台排查，同一份错误假设一共被复制到**三处**，方向还相反（两处 ×100、一处 ÷100）。

### Details
1. **判断单位别看文档、看成交额**：`volume ≈ 成交额 ÷ 收盘价 ÷ 100` 是唯一硬证据。000902：73,588 手 ×13.87×100 = 1.02 亿 = 实时成交额 → 东财是「手」；600519 同为「手」。旧注释"东财/同花顺日K为股"是错的（同花顺确实为股，东财不是）。
2. **同一份知识复制三遍 = 三份 bug**：`_reconcileTodayBar`（×100）、口诀1 开盘量比 `tencent ? 1 : 100`（÷100，基准缩 100 倍→量比虚高 100 倍）、`capitalFlow VOLUME_TO_LOT`（÷100，绝对量小 100 倍）。修复必须收敛成**唯一来源** `lib/volUnit.js`，并加源码守卫禁止"按是否 tencent 二分"的写法回潮。
3. **给数据流加"量级守卫"比修好单位更重要**：同一天同一只股票，实时量与日K量不可能差 20 倍以上。换算后差 >20 倍 → 判单位异常、**拒绝覆写**、写进 dataGaps。这样即使将来又多一个通道、又写错一次，也只是"少一次覆写 + 一条告警"，而不是静默污染整条序列再产出荒谬结论。
4. **旧测试会把错的行为锁成"预期"**：三条断言原本写的是「东财=股 → ÷100」「未归一的 quote 会覆写出 100 倍假量」，它们一直在绿灯守护 bug。修口径时必须同步改测试并把"为什么改"写进断言文案，否则下一个人会拿它回滚。
5. **数值同屏 = 必须能自洽核对**：文案既然打印了「均值 ×1.5 = 阈值（当日量）」，就必须同时给出「当日量为阈值的 X 倍」；否则用户只能靠肉眼比大小，一旦单位错就立刻变成荒唐话。

### Suggested Action
凡涉及单位（股/手/万手/元/万元/亿）的字段：① 用「量×价≈成交额」这类恒等式反验，不靠注释和记忆；② 单位换算收敛到单一模块，源码守卫禁止就地二分；③ 数据写入前加量级守卫（同对象同日不应差 10 倍以上），异常就拒写+告警；④ 只要界面并排打印两个量，就要给出它们的关系（倍数/差值），让用户能自己核对；⑤ 修口径时同步翻测试里的"预期"，避免旧断言守护旧 bug。

### Metadata
- Source: user_feedback
- Related Files: lib/volUnit.js, lib/volumeEngine.js, lib/capitalFlow.js, lib/stockData.js, scripts/test_volume_unit_contract.js, docs/logic/stock-13-capital.md, docs/logic/common-01-data-source.md
- Tags: unit-mismatch, single-source-of-truth, magnitude-guard, test-locked-bug, self-checkable-copy
- See Also: LRN-20261021-006（文案必须带窗口）, LRN-20261019b 相关（腾讯科创板量单位）
- Pattern-Key: data.unit_single_source
- Recurrence-Count: 2
- First-Seen: 2026-10-19
- Last-Seen: 2026-10-21

## LRN-20261021-009 · 「已完结的历史方案」被当成「当前状态」+「未足额却说已用尽」

**Logged**: 2026-10-21T17:00:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
用户截图报障：新洋丰（000902）的「股份回购」子卡片，① 根本没有当前回购行为却被照四要素展示；② 显示「完成实施（已达承诺上限 24%）」、理由却写「承诺买入力量已用尽」——1.44 亿 vs 承诺 3~6 亿，钱没花完却宣称已用尽。两处观感都是"虚构/自相矛盾的回购状态"。

### Details
1. **历史方案≠当前状态**：`lib/buybackEmDc.js` 默认把"最新一档"当成"当前进行中"展示。000902 最新一档是 **2021-07-23 完成实施**（5 年前）。任何"回购/增发/减持"这类有起止时间的方案，展示前必须先判**是否还在有效期内**——完结超过合理窗口（回购设 `HISTORICAL_DAYS=730` 自然日）就必须标"历史方案"，卡片主语改成"当前无进行中的回购"，旧方案降为脚注。否则用户会以为它现在还在回购。
2. **「完成」不等于「足额」**：进度码 `006 完成实施` 是"方案结束"，但可能只回购到承诺上限的 24%（到期结束、没买完）。旧代码一律 `signal=0 中性 + 理由"承诺买入力量已用尽"` 是错的——钱没花完就不能说"已用尽"。必须按**实际完成率**分支：`<95%` → stage「已结束（未足额）」、理由说"只回购到承诺上限 X%，未足额买完，剩余额度不再兑现"；`≥95%` 才说"已用尽"。
3. **改展示不改结构 → 必须升 LAYOUT_VERSION**：本次只动文案/状态标记，因子结构哈希没变，但旧判断快照会静默复用 → 页面仍显示旧文案。凡是改了"卡片里用户能看到的内容"却没动因子字段结构，都要升 `LAYOUT_VERSION` 强制重算。这条是此类修复反复踩的坑（同 008 的量纲修复、006 的窗口文案同理）。
4. **措辞自洽校验**：进度文案里同时出现"完成实施"和"已达承诺上限 24%"本身就在自相矛盾（完成了却只达 24%）。凡并排出现"状态词 + 百分比"，必须能通过"百分比能否支撑状态词"的直觉核对——不能让"已完成/已用尽"和"<100%"同屏。

### Suggested Action
凡展示"有起止时间的公司行为"（回购/增减持/增发/承诺），一律先算**时效闸门**（完结超过 N 天 → 历史，不作为当前状态）；进度文案按**实际完成率**分支，禁止"状态词"与"百分比"自相矛盾；改展示不改结构时记得升 LAYOUT_VERSION 强制重算；卡片里并排出现的两个量必须能互相印证。

### Metadata
- Source: user_feedback
- Related Files: lib/buybackEmDc.js, lib/sameDayJudgment.js, scripts/test_buyback_plan.js, docs/logic/stock-04-short-term.md
- Tags: stale-plan-as-current, unfulfilled-but-claimed-done, layout-version-guard, self-contradictory-copy
- See Also: LRN-20261021-006（文案必须带窗口）, LRN-20261021-008（量纲单一来源）
- Pattern-Key: data.temporal_state_gate
- Recurrence-Count: 1
- First-Seen: 2026-10-21
- Last-Seen: 2026-10-21

---

## LRN-20261022-001 · 「同一条规则」被拆成两个分支时，量能前提必须逐支明确

**Logged**: 2026-10-22T12:05:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend
**Related**: LRN-20261021-008（同一假设散落多处）

### Summary
阻力/支撑「标准2 · 超过三天来回突破 → 无效」原先实现成两条互不相干的判据：`streakNow`（站外连续>3天）与 `touchTransitions`（窗内往返>3次），**都不看量能**。用户 2026-10-22 更正：只有「在没有放量的情况下」来回突破才判无效——放量穿越属真实方向性动作，不该被当成「该位置没意义」。前期把用户一句话拆成多分支时，漏了「量能」这个共同前提，导致放量来回也一律判无效。

### Details
1. **用户规则按分支落地后要回归校验「前提」是否每个分支都带上**：标准1（无放量突破）本就带量能；标准2 拆成 a/b 两分支却都没带。更正只针对 b（来回突破），故 a（站住>3天）保持与量能无关——不要因为「都在标准2 里」就一刀切改 a，会造成「放量突破站住也被保留成阻力」的新错。
2. **计数保留 raw + 新增 gated 两个字段**：`touchTransitions`（全部往返，用于展示「往返几次」）+ `touchTransitionsNoVol`（无放量往返，驱动判无效）+ `volumeCrossCount`（放量穿越次数，展示"另有 N 次不计入"）。不要把 raw 语义直接改成 gated——展示与判据混用会让用户看到「往返 4 次却判定有效」而无解释。
3. **量能缺失不臆断**：`volRatioAt==null`（前5日不足/量为0）时该次穿越**不计入** gated 计数（与侵蚀"缺量不动几何"同原则）。宁可少判无效，不凭空判死。
4. **对照测试必须成对**：同一形态分别用「全无放量」与「全放量」两组数据各测一遍（测试 [6] vs [6b]），否则单侧通过会掩盖量能门槛失效。

### Suggested Action
把用户的一句话规则拆成多个判定分支时，逐支列出它需要的**全部前提**（量能/方向/窗口），并用「前提开/关」两组对照数据验证；展示用的 raw 计数与判据用的 gated 计数分开存，前端 tooltip 明示"放量穿越不计入"。

### Metadata
- Source: user_feedback
- Related Files: lib/zoneValidity.js, public/js/app.js, scripts/test_zone_validity.js, docs/logic/stock-18-zone-validity.md
- Pattern-Key: rules.branch_precondition_volume
- Recurrence-Count: 1
- First-Seen: 2026-10-22
- Last-Seen: 2026-10-22

---

## LRN-20261022-002 · 删掉一条规则会留下空洞，必须有替代机制顶上

**Logged**: 2026-10-22T12:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend
**Related**: LRN-20261022-001（规则分支的量能前提）

### Summary
用户要求「彻底删除标准2（超过三天来回突破→无效），只保留标准1」，同时新增「放量有效突破→角色反转（可多次，判无效才删）」。
删除标准2 后，「价格一直站在阻力上方」「无放量反复穿越」两类原本被判无效的情形失去判据——不能只删不补，必须确认替代机制覆盖，并把残留边界如实写进文档。

### Details
1. **删除规则前先列出「它原本拦下的所有情形」**：标准2 拦了两类——(a) 突破后站住 >3 天；(b) 窗内往返 >3 次。删掉后要逐类回答「现在谁负责」：放量突破 → 反转模块；无放量穿越 → 标准1；(a) 的「一直站外、窗内无穿越」无人接管 → 保留展示，作为已知边界记录。
2. **状态化机制必须有游标**：反转记录用 `lastEvalDate` + `wasBeyond` 增量回放，否则每次快照都会在同一历史突破上重复翻转，`flipCount` 会无限增长。幂等性靠「只处理 date > lastEvalDate 的 K 线」保证。
3. **方向反转要成对校验**：阻力上破→支撑、支撑下破→阻力；创建记录时用「突破后当前仍在外侧」过滤掉「冲高即回落」的假有效突破，避免把噪声当反转。
4. **持久化要防污染**：没有活动记录且无既存文件时不写空 json，否则每只被访问的股票都会生成一个空文件，数据目录迅速变脏。
5. **删字段要全链路清**：`streakNow`/`touchTransitions` 从 `zoneCheck`、tooltip、单测、文档、导出常量一并清除，并用 grep 校验零残留（`test_range_detector` 的隔离守卫除外）。

### Suggested Action
删除任何判定规则时，先枚举它拦截的情形，逐个指定替代归属（或明确列为已知边界）；新增状态化机制必须带增量游标与幂等校验；方向互换用「仍在外侧」过滤假突破；持久化避免产生空文件；删字段后 grep 零残留。

### Metadata
- Source: user_feedback
- Related Files: lib/zoneValidity.js, lib/zoneReversal.js, lib/priceActionHub.js, public/js/app.js, scripts/test_zone_validity.js, scripts/test_zone_reversal.js, docs/logic/stock-18-zone-validity.md, docs/logic/stock-20-zone-reversal.md
- Pattern-Key: rules.delete_rule_requires_replacement
- Recurrence-Count: 1
- First-Seen: 2026-10-22
- Last-Seen: 2026-10-22

---

## LRN-20261022-003 · 同一指标被两个模块各算一套 = 静默双口径；「AND 一个永远为假的字段」= 条件性死逻辑

**Logged**: 2026-10-22T13:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend
**Related**: LRN-20261022-002（删规则必须有替代）

### Summary
用户看「4. 放量破位」问：这个模块自己有支撑位逻辑吗？和短期动向重复吗？没有的话是不是死逻辑？
答案：`volumeEngine._keyLevels` **自己算了一套**（平台沿/阶段高低/MA20/MA60 取最近，支撑兜底 stageLow），因此**不是死逻辑**，但**与②卡的两套口径重复**。另外做全模型审计时发现：规则2「高位派发」的 `turnoverExtreme` 硬依赖 `hasTurnover`（日K f61 换手率）——腾讯 OHLCV 兜底通道无换手率 → 该通道该规则**永远无法命中**，是「AND 一个永远为假的条件」造成的条件性死逻辑。

### Details
1. **重复不报错，只会静默给出不同数字**：两个模块各自算「关键支撑」，单测都绿、界面都正常，但同一只股票两处显示不同价位 → 用户困惑。改法是把权威源收敛到一个（②卡区间），另一处通过注入 hint 引用，并保留自算兜底。
2. **注入式统一优于互相 require**：`volumeEngine` 是纯计算模块，直接 require `priceActionHub` 会引入循环依赖与网络。改为 `capitalFlow`（编排层）注入 `levelHints`，引擎纯函数只读 hint。并给 hint 获取加 6s 超时，绝不拖垮上层 15s 预算。
3. **零 hint 必须逐位等价**：新参数默认 `low=high=price`，保证既有 295 项单测与线上行为不变；只在新 hint 生效时改为区间语义（触及线=上沿、跌破线=下沿）。
4. **死逻辑分两类**：①**硬死**（字段永远缺失 → 分支不可达）；②**条件死**（某数据通道下某字段为 0 → AND 恒假）。检测方法：找「AND 链里依赖 optional 字段」的条件，问「这个字段在所有通道都可能缺失吗」。本例规则2 属条件死，且是刻意保守（无证据不臆造），不应改为放行。
5. **NOT a bug ≠ 不用报告**：条件死逻辑仍要在文档里写明「哪个通道下不可命中、为什么保留」，否则下次有人会误以为是 bug 去"修"。

### Suggested Action
同一指标只保留一个权威计算源，其它消费方用「注入结果 + 兜底」引用，禁止各自复算；新增可选参数必须保证缺省时与旧行为逐位等价；审计死逻辑时区分「硬死」与「条件死」，条件死要写清通道与保留理由。

### Metadata
- Source: user_feedback
- Related Files: lib/volumeEngine.js, lib/capitalFlow.js, lib/zoneLevelsHint.js, scripts/test_zone_level_hints.js, docs/logic/stock-13-capital.md
- Pattern-Key: rules.single_source_of_levels
- Recurrence-Count: 1
- First-Seen: 2026-10-22
- Last-Seen: 2026-10-22

---

## LRN-20261022-004 · 严格结构闸门遇到「数据源尾部暂未同步」会整段 fail-closed；固定窗口接口可用「权威段反推」扩样本

**Logged**: 2026-10-22T15:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: data
**Related**: LRN-20261022-003（单源/死逻辑审计）

### Summary
用户报障「成交额/换手率样本一直停在 140 天」。真因不是「同花顺只有 140 根」，而是 `all.js` 解码器要求 `sum(sortYear) === dates.length`，而收盘前后 all.js 偶发年度计数比 dates 多 1~2 条（当日条目已计入年度、尚未落入数组）→ 解码 `return null` → 历史段整段丢弃，只剩 `last.js` 的 140 根。修好后，再用 `last.js` 反推流通盘回填历史段的 turnover/amount，样本从 140 → 250。

### Details
1. **strict gate + 上游异步更新 = 全有或全无**：数据源在「收盘重建」期间会短暂不自洽（计数多 1、数组少 1）。要求「完全相等」的闸门会把**整段**判死，而不是只丢最后一条。正确做法：只容忍**尾部**小差异（本例 ≤2），从最后一年扣掉；欠计或差异大仍拒绝。
2. **容忍必须配交叉校验**：放宽闸门后，年份映射可能错位。用 `_mergeThsBars` 的**重叠段 close 逐根比对（±0.005）**做最终验收——错位即不采信，退回权威段。放宽 + 兜底校验，比「一严到底」既稳又不丢数据。
3. **固定窗口接口的样本扩展**：`last.js` 恒 140 根（唯一带 amount/turnover），`all.js` 有全历史但只 OHLCV。可用权威段**反推参数**（流通盘 = volume ÷ turnover%），对历史段回填 turnover；`amount ≈ volume × close`。**先实证再回填**：本例重叠 140 根成交量逐根一致、流通盘离散 0.72%、amount 偏差 1.09%，才敢回填。
4. **回填必须 fail-closed + 可追溯**：流通盘跨期离散 >3%（送转/增发）→ 放弃回填换手率；所有回填行打 `amountEstimated/turnoverEstimated`；引擎在 dataGaps 明确写「推算值，跨除权日可能数%偏差」。禁止把推算值当交易所原值。
5. **限流是常态**：`all.js` 连续高频请求会 502；失败必须自动退回 140 根并如实标注，不得静默。

### Suggested Action
数据源有「尾部异步更新」时，结构闸门只容忍尾部小差异并用重叠校验兜底；固定窗口接口可用权威段反推参数扩样本，但需先实测一致性、再 fail-closed 回填、打标并在文档/UI 披露推算。

### Metadata
- Source: user_feedback
- Related Files: lib/stockData.js, lib/volumeEngine.js, scripts/test_ths_backfill.js, scripts/test_ths_kline.js, docs/logic/common-01-data-source.md, docs/logic/stock-13-capital.md
- Pattern-Key: data.strict_gate_tail_lag
- Recurrence-Count: 1
- First-Seen: 2026-10-22
- Last-Seen: 2026-10-22

## LRN-20261022-005 · 限流的正解是「降低请求频率」而非「重试/换源」；缓存要按语义时段切分，且缓存**原始响应**而非解码结果

**Logged**: 2026-10-22T16:25:00+08:00
**Priority**: high
**Status**: resolved
**Area**: data
**Related**: LRN-20261022-004（同花顺样本 140 天）

### Summary
用户问「同花顺 all.js 高频请求会触发 502 限流，能否一次获取本地保存解决，容量大吗」。实测确认是**真限流**（同一时刻 axios 502、curl 200、裸 `node:http` 200 → 不是头部/代理问题），单股 `all.js` 87–194 KB。方案定为「把 JSONP 原始文本落盘 + 三段式时段复用」，实测每只股票每交易日最多 2 次请求，命中缓存网络 0 次、耗时 3 ms、结果逐字节一致；容量 9 只自选 1.3 MB、31 只 4.6 MB、200 只 30 MB，每只固定一个文件每日覆盖写、不累积。

### Details
1. **先证明「是限流」再动手**：502 有三种常见成因（头部被拒 / 代理挂起 / 真限流）。用同一 URL 分别走 axios、curl、裸 `node:http` 对照，三者行为不一致（axios 502 / curl 200 / http 200）+ 间隔请求即恢复 → 锁定限流。**不做这步就会去改 header、关代理，白改**。
2. **限流的解法是降低频率，不是加重试**：重试/换源只会加压。真正有效的是「同一份数据在语义有效期内只取一次」。判断依据不能是「过了 N 分钟」，而是**数据的语义边界**——日K的有效边界是「交易日 + 是否收盘」，不是时间 TTL。
3. **时段切分要贴合判定口径**：`intraday`（<15:05）与 `closed`（≥15:05）必须分开缓存。若只按「自然日」缓存，早上抓的那份会一直被用到晚上——当日收盘K永远拿不到。反过来，≥15:05 必须让盘中缓存失效并补抓一次。`15:05` 与 `zoneValidity.finalizedBars` 的 `closeHhmm` **同口径**（复用同一个语义，不另造数字）。
4. **非交易日一律按 closed 锚定上一交易日**：周末/长假的「早上 10 点」若按 intraday 处理，会与周五收盘后写入的 closed 缓存错位 → 每次访问都重新联网。锚定 `previousTradingDay` 后，长假全程复用同一份。
5. **缓存原始响应，不缓存解码结果**：两者体积实测差 2–4 倍（原始 148 KB vs 解码全量 556 KB），更重要的是——存解码结果会让缓存与解码逻辑**脱钩**（改了闸门/回填，旧缓存仍是旧逻辑的产物，且看不出）。存原始文本则读缓存后走**完全相同的解码/校验路径**，只在「文本从哪来」分叉，结果天然逐字节一致。这符合项目「单一权威源 + 确定性逻辑由代码执行」。
6. **残缺缓存必须不认**：`all.js` 拉取失败时如果照写缓存（`allRaw: ''`），会让**一整天**都卡在只有 `last.js` 的 140 根。`isFresh` 显式判 `incomplete_all` → 不命中，下次重试。
7. **退避要短且能自愈**：502 后退避 5 分钟会让「网络已恢复但用户仍在看 140 根」的空窗过长；改 2 分钟，并验证「退避期内不重试（增量 0）」+「到期自动恢复（140 → 320 并写缓存）」双向闭环。
8. **实测必须证伪而非证真**：不只验证「命中缓存快」，还要验证「命中后网络请求数真的是 0」（patch `axios.get` 计数）、「缓存结果与实时结果逐字节一致」（拼指纹比对）、「删缓存后确实重新联网且结果不变」、「不同 `count` 是同一份数据的正确尾部切片」。

### Suggested Action
遇到第三方限流：先做三方对照证明是限流；用「语义时段」而不是「时间 TTL」做复用边界；缓存原始响应保持解码路径单一；残缺/损坏缓存一律降级为未命中；退避要短并可验证自愈；用请求计数 + 指纹比对做证伪式验证。

### Metadata
- Source: user_question
- Related Files: lib/stockData.js, lib/thsDailyCache.js, scripts/test_ths_daily_cache.js, docs/logic/common-01-data-source.md
- Pattern-Key: data.rate_limit_semantic_cache
- Recurrence-Count: 1
- First-Seen: 2026-10-22
- Last-Seen: 2026-10-22

## LRN-20261022-006 · 「多方法共振」类功能的三条硬约束：排序要给下游让路、几何定稿后才能统计、侵蚀不能压成线

**Logged**: 2026-10-22T17:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: analysis / ui
**Related**: LRN-20261022-004、stock-18-zone-validity、stock-20-zone-reversal

### Summary
按用户六部分规范，把②卡阻力/支撑从「摆动点 + MA20」升级为「10 种方法 + 周线层 → 共振合并 → 强度分级」。过程中踩到三个坑，都不是代码写错，而是**顺序/方向/边界**的隐性假设出了问题，且每一个都只在真实股票数据上才暴露。

### Details
1. **数组排序是下游契约，不是展示偏好**：本想「按强度排序」直接改后端输出，但 ④卡 `calcFalsification` 取 `resistances[0]`、量能规则4 的 `zoneLevelsHint` 取「就近支撑/阻力」——两者都**依赖后端「阻力 low 升序 / 支撑 low 降序」**。改排序等于偷偷改下游语义。正解：后端顺序不动，强度只作为字段；前端在**副本**上排序。
2. **「统计」必须排在「几何」之后**：触碰次数 = 收盘落在这条带内的次数。先算触碰再改带宽，用户点开详情就会看到「宽度 0.21 但触碰 22 次」这种自相矛盾的组合。流水线固定为 几何（聚类/带宽/裁剪）→ 消解（切重叠）→ 统计（触碰/60分钟/评分/失效位）。
3. **同一段「消解重叠」代码不能两个方向通用**：阻力数组升序、支撑数组降序，重叠区在**相反的一端**。照阻力逻辑套到支撑上，产出 `low > high` 的畸形带（实测出现过 `32.96 ~ 32.98` 而中心 33.32）。必须按 `side` 分支切不同端，并在最后加 `low<=high` 自检丢弃畸形带。
4. **带宽不能用「成员区间并集」**：单个宽来源（筹码峰、均线粘合带）会把整条带撑到 `ATR×2.6` 并与下一条重叠。改为「中心取中位数 + 带宽钳在 `[0.7,1.0]×ATR`」，需要「更宽」时去加成员，而不是拉伸带宽。
5. **新几何规则会与旧规则打架，要主动发现并上报**：新共振带是 ATR 量级（0.7~1.0 ATR），旧侵蚀规则会把 `33.50~34.20` 一步收到 `34.18~34.20`（0.02 宽 = 一条线），与「支撑阻力必须输出为区域」直接冲突。**发现后先量化影响（实测 4 只股票的收缩前后宽度）再问用户**，用户选「设最小保留宽度」→ `MIN_KEEP_ATR = 0.3`，并同步修正侵蚀文案（否则界面显示「收紧到 34.18~34.20」而实际是 `33.99~34.20`）。
6. **「按强度排序」这个默认值要拿真实输出反推**：实测 603288 五条阻力按强度排成 `35.41 / 34.40 / 33.99 / 37.21 / 38.32`，最近的 `33.99` 被挤到第 3 位，「上方/下方」清单失去空间感。**默认改为距离优先**，强度由徽标 + 一键切换承担。功能选择要在真数据上验一遍再定默认值，不能只看设计稿。
7. **「算不出来」要如实写在界面上**：趋势线在 603288/600460 上「无条件满足」（要求两点连线 + 第三点验线 + 距现价 ≤4ATR 三条同时成立）。**不降标准凑方法**，把 `skipped[]` 原样透出成「未算出：trendline：无条件满足」。
8. **前端沙箱探针能在不装浏览器时验证渲染**：用 `vm` + Proxy 桩加载 `public/js/app.js`，把真实接口数据喂给 `_renderZoneRow` 等纯渲染函数，断言「行数=详情数=箭头数」「无 NaN/undefined」「来源明细条数≥数据条数」，并打印去标签后的人读文本——比截图肉眼检查更快定位排版/字段错位。

### Suggested Action
改造「多来源聚合」类模块时：先找出所有依赖数组顺序的下游消费者并固定契约；把「几何定稿」与「统计」分成两个阶段；方向相反的数组禁止共用同一段切割逻辑；新增几何规则与旧规则冲突时先量化再提问；默认排序/默认展示方式必须用真实输出反推；算不出来的方法一律界面披露。

---

## LRN-20261022-007 · 「份额变动」类资金流信号的四个陷阱：净值≠总量、盘中≠收盘、净额≠毛额、配额截断≠无数据

**Date**: 2026-10-22
**Priority**: high
**Status**: resolved
**Area**: data-source / analysis
**Related**: LRN-20261022-005（缓存按语义时段切分）、home-10-etf-flow.md

### Summary
把「宽基 ETF 申购赎回」做成情绪模型因子时，四个坑全部踩到，且都属于「代码没报错、数字看着合理、但含义是错的」。共同特征：**口径问题伪装成技术问题**。

### Details
1. **PCF 是模板，不是成交记录**：交易所「申购赎回清单」只说明"一篮子要交哪些股票"，本身**不含当日实际申赎量**。第一直觉是"抓清单就能知道买了什么"，实际清单对每只 ETF 每天都一样（除非调仓）。真正的申赎信号只能来自**基金总份额的日变化**。任何"用 PCF 统计申购量"的实现都是错的。
2. **份额是「净」概念，物理上拆不出毛额**：Δ份额 = 当日申购 − 当日赎回，只有一个方程、两个未知数。所以文案必须限定为「净申赎」，累计也只能给「净申购日累计 / 净赎回日累计」。用户口语说的"申购了多少、赎回了多少"，落到数据上只能回答"净额"，这一点必须在界面上**说清而不是绕开**。
3. **盘中的份额是半天进度，不能当收盘值**：份额（f84 / 腾讯字段 72）盘中实时更新。若 10:00 采一份快照、次日拿它当基期，Δ 会虚增；若把 10:00 的增量写进「累计台账」，收盘后的真实值会被幂等闸门 `lastDate===date` 永久挡在外面。正解是**双保险**：快照落盘时打 `settled` 标（交易日 15:05 后为真）＋ 累计台账只吃 `settled:true`；且 `settled` 取**快照内记录值**，不按当前时间重算（一份 14:00 的快照到晚上仍是盘中值）。
4. **份额源优先级要按"本机可达性"定，不是按"谁更权威"定**：东财 `push2*.eastmoney.com` 全族在本机被 reset（4 镜像 × Node https + 系统 curl 全失败，单次取数会被拖到 90 秒），而腾讯 `qt.gtimg.cn` 稳定可达。腾讯 ETF 行情的**字段 72 = 份额**（73 = 总份额，ETF 两者相等），并与「总市值 ÷ 现价」交叉验证一致（510300：1240.28e8 ÷ 4.107 = 301.99 亿份 ≡ 字段 72 = 30199087700）。结论：**先测可达性再定主源**，权威源降为备链并加熔断（失败一次静默 10 分钟），否则每条降级路径都是分钟级。
5. **配额截断会静默丢掉一整个家族**：`GROUPS` 里 5 个家族各设上限、总上限 `MAX_ETF`，若总上限 = 各族之和 −1，最后一族会被**静默挤掉**（实测「科创50」整族消失，界面上只是少了 3 行，不报错）。同时家族关键词必须用交易所**全称**：上交所写「上证科创板50成份」，关键词写「科创50」匹配不到。凡是"按配额挑子集"的逻辑，都要断言"每个家族至少挑到 1 个"，否则失败。
6. **同一只股票跨多个家族必须按代码合并**：601398 同时属于沪深300与上证50的篮子，按 `家族|代码` 做聚合键会拆成两行，用户看到的是"只被买了半份"。聚合键用**代码**，家族降级为标签（`沪深300 / 上证50`）。
7. **首次运行没有基期，不要"编一个"**：Δ 需要两个时点，模块第一天上线的物理事实就是算不出来。返回 `baselineOnly` + 界面写「已建立基线，下一交易日起可算」，比塞一个 0 或拿「昨日净值推算」诚实得多。

### Suggested Action
做任何「变化量」类信号（份额、持仓、库存、订单）时先自问四句：① 我的数据源是**快照**还是**流水**？② 这个量是**净**的还是**毛**的，能不能拆？③ 采样的时点是否代表"日终"？④ 我选的源在本机**真的可达**吗（先探测再接线）？四问答不清就不要接线到模型里。

---

## LRN-20261022-008 · 「点一次不生效」优先怀疑事件被吞、「越点越慢」优先怀疑请求被重置

**Date**: 2026-10-22
**Priority**: high
**Status**: resolved
**Area**: frontend / interaction
**Related**: LRN-20261022-006、common-08-switch-stock.md

### Summary
用户报「需要多次点击才能切换个股，系统反应缓慢」。先入为主去查接口耗时（确实 2~4 秒），但**慢不等于点不动**。四个成因里只有一个是慢，另外三个是"点击根本没被当成一次点击"。诊断这类问题必须把「响应慢」与「点击丢失」分开取证。

### Details
1. **`draggable="true"` 会吞 click**：行元素带 `draggable` 时，指针按下期间只要有几像素移动，浏览器就进入 HTML5 拖拽并**取消 `click` 派发**。触控板/手抖鼠标下这是高频事件，表现正是"点好几次才中"。修法不是去掉拖拽，而是用 `pointerup` 兜底（`click` 被取消时 `pointerup` 一定触发）：位移 ≤6px 且间隔 ≤900ms 视为单击。兜底与 `click` 之间必须去重，且**去重键要带业务标识（symbol）**，否则"快速点 A 再点 B"会把 B 当重复点击吞掉。
2. **每次点击都重发请求 = 越点越慢**：带 `_reqToken` 的防串股机制会在新请求发起时把旧请求结果丢弃。若用户因为没反馈而连点，每一下都在丢弃上一发并**从零开始新的 2~4 秒**——体感就是"点了半天一直不出来"。正解是**在飞去重**：同一标的已有在飞请求且它就是当前最新请求时，直接忽略重复点击；同时保留 `force` 通道给"刷新按钮/换时间范围"这类语义上必须重取的操作。
3. **`showLoading(text)` 收了 text 却没用**：函数只驱动一条 3px 顶部进度条，文字参数被丢弃。等待期屏幕仍是上一只股票的内容，用户唯一能得到的结论就是"没点上"。**"有加载动画"≠"有反馈"**——必须让用户看到"正在加载哪只票"，并且点击瞬间就把目标行的高亮切过去。
4. **注释与实现相反的地方一定是 bug 温床**：`startWatchlistQuoteRefresh` 注释写「不重渲染整个列表，只更新价格/涨跌幅单元」，实现却调 `renderWatchlist()` 做整表 `innerHTML` 重建。后果：每 60 秒重置滚动位置与悬浮态，还可能吃掉"按下时有、抬起时没了"的那次点击。修成 `patchWatchlistPrices()` 只改单元格；**排序态例外**（价格变了要重排，否则排序语义不成立）。
5. **超时类诊断先量化再动手**：实测同一接口 0.79s（命中缓存）→ 3.99s（冷缓存），四个样本全部 >1.8s。先把数字摆出来，再决定"要不要优化服务端"。本例结论是服务端耗时受上游限制、不在本次范围，只消除点击链路的三处损耗。
6. **跨端守卫会被行尾打败**：`test_market_volume_root_migration.js` 拿 `git show HEAD:`（恒为 LF）与工作区文件（`core.autocrlf=true` 下为 CRLF）做逐字比对，`round` 函数除了多一个 `\r` 完全一致却抛出"等价性前提不成立"，**导致该测试的 102 项实质断言从未执行过**。修法是比对前 `replace(/\r\n/g,'\n')`——与项目跨端 md5 用 `tr -d '\r'` 同一思路。凡是「读工作区 vs 读 git 对象」再比字符串的守卫，都必须先归一化行尾，否则在 Windows 上恒假失败。

### Suggested Action
听到「要点好几次才生效」：① 先确认 `click` 是否真的触发（有 `draggable` 就上 `pointerup` 兜底）；② 数一数一次操作实际发了几个请求（连点是否重置了计时）；③ 看等待期用户能不能分辨"在加载"和"没反应"；④ 检查定时器有没有在偷偷重建 DOM。四条都过一遍，再谈接口性能。
