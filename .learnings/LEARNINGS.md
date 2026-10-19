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
