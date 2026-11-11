# 其余（.learnings / miaoxiang / reports / 根级零散文件） · 第 1 卷

> 共 30 个文件，本卷约 4853 行


---

## `.learnings\archive\LEARNINGS-full-20261110.md`  ·  3248 行

~~~md
# LEARNINGS 全量归档（2026-11-10 瘦身）

> 主文件 `.learnings/LEARNINGS.md` 已改为索引（每行 ID/日期/状态/摘要），全文逐字保留在本文件。
> 检索：`rg "LRN-20261020-002" .learnings/archive/LEARNINGS-full-20261110.md`。
> 恢复：把本文件正文（54 条）整体粘回 LEARNINGS.md 即可还原瘦身前状态。

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


## [LRN-20261101-002] correction

**Logged**: 2026-11-01T17:20:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
四维度·量能状态写「60 日均量口径未确认」（暗示缺数据），同卡 60 日均量注释却给出实际比值 1.34 倍——`confirm=null`（60 日口径中间地带 0.7~1.5×，判「平量」）被兜底文案误写成「未确认」。

### Details
用户报障（士兰微 600460 截图）：「图二，60 日均量口径未确认，图一却有 60 日量能。」真相：confirm 三态语义中 null = 当日量落在 0.7~1.5×60日均量之间（60 日口径判平量），**不是缺数据**。这是 20261024j 前端指标卡同类问题的引擎侧残留——当时只修了前端展示，四维度文本、7.4 规则 detail 三处、capitalFlow 资金行为文案共 5 处仍用 `confirm || '未确认'` 兜底。教训：**修「有数据却写未确认」类问题必须全台 grep 同款兜底写法一次清零**，否则同一真相在不同卡里呈现两种说法。

### Suggested Action
引擎层加 `_confirmDesc(pc)` 单一真值源：>×1.5 确认放量 / <×0.7 确认缩量 / 中间地带如实给出比值并判「平量」（注明未达确认阈值、并非缺数据）/ 真缺数据才写「数据不足」。四处调用点 + volumeTier.confirmDesc 下发 + capitalFlow 同源引用。守卫断言加入 test_volume_confirm_label.js（含「volumeEngine 内不再存在 pc.confirm || '未确认' 写法」源码守卫）。

### Metadata
- Source: user_feedback
- Related Files: lib/volumeEngine.js、lib/capitalFlow.js、scripts/test_volume_confirm_label.js
- Tags: 诚实合规, 口径一致, confirm, 60日均量, 兜底文案
- See Also: LRN-20261101-001（同日用户连续报障的展示一致性问题）
- Pattern-Key: harden.fallback_wording_not_data_missing
- Recurrence-Count: 2（20261024j 前端 + 20261101g 引擎侧）
- First-Seen: 2026-10-24
- Last-Seen: 2026-11-01

### Resolution
- **Resolved**: 2026-11-01T17:25:00+08:00
- **Notes**: APP_VERSION=20261101g；test_volume_confirm_label 27 项全绿（新增 [3] 段 12 项）。

---



## [LRN-20261101-001] correction

**Logged**: 2026-11-01T17:10:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
量价判定主判卡的「当前位置 6 格对照表」里，非命中行（如放量上涨·偏多）也用方向色徽标（红/绿/琥珀）着色——士兰微当日实际是「平量+下跌=观察」，但表里「放量上涨·偏多」红标很显眼，用户误读为当前判多。

### Details
用户报障原话：「当前量能判定不是放量上涨，为什么红色标注偏多判定，容易引起误读。」根因：对照参考表把每格的**假设方向色**与**当前命中态**用同样强度渲染，方向色脱离了「这是参考行不是今日判定」的语境。与项目既有语义着色规范（方向色=当前结论的语义）冲突。

### Suggested Action
参考表/对照表中**非命中行一律中性灰徽标**，方向色仅当前命中行保留；表下附「仅高亮行是当前命中判定，其余行不代表今日量价状态」对照说明。已实现（20261101f，`c.hit ? badgeCls(c.direction) : ''`）。

### Metadata
- Source: user_feedback
- Related Files: public/js/app.js（renderVolumeEngine posHtml）、scripts/test_pos_volume_matrix.js
- Tags: 语义着色, 防误读, 参考表, 红涨绿跌
- Pattern-Key: ui.reference_table_neutral_nonhit
- Recurrence-Count: 1
- First-Seen: 2026-11-01
- Last-Seen: 2026-11-01

### Resolution
- **Resolved**: 2026-11-01T17:12:00+08:00
- **Notes**: APP_VERSION=20261101f；守卫测试新增 2 项断言（非命中行中性灰 + 对照说明文案）。

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

---



## [LRN-20261025-001] correction

**Logged**: 2026-10-25T14:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
判断卡片评分展示口径连续三轮反复（删得分 → 要回得分 → 权重=评分），每轮只按字面单向执行，未先对齐"最终卡片形态"就动手。

### Details
用户第一轮「统一采取权重」→ 助手删掉档位与得分；第二轮「无法判定模型有效性，所有权重与得分都要显示」→ 恢复得分并下发子权重；第三轮「删除复杂的评分系统，直接用权重等于评分，净权重24%就是24分」→ 最终落地：子卡片只留「权重 ±X%」、因子行只留「净权重 X%（最高 Y%）/ 权重 X%」、事件聚合信号改「方向满格加权」（贡献分≈净方向权重）。反复根因：每轮只执行字面指令，没有先用真实数据给用户看"改完后的卡片样例"确认；且"简化"一词可指删数字、也可指换算法，未澄清。

### Suggested Action
凡「简化/统一展示口径」类需求：① 动手前用真实数据画目标卡片文字样例请用户确认；② 主动说明口径变更对综合分/判断结论的连锁影响（本次事件信号改方向满格加权会抬高事件驱动贡献分）；③ 口径改动与 LAYOUT_VERSION/APP_VERSION 升版同步做。

### Metadata
- Source: user_feedback
- Related Files: public/js/app.js, lib/eventEngine.js, lib/sameDayJudgment.js, public/css/style.css
- Tags: 展示口径, 评分系统, 需求澄清, 自适应布局
- Pattern-Key: ui.metric_display_alignment
- Recurrence-Count: 1
- First-Seen: 2026-10-25
- Last-Seen: 2026-10-25

---



## [LRN-20261028-001] correction

**Logged**: 2026-10-28T16:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
volumeEngine 规则3「缩量假突破」盘中误触发：用「当日未走完的累计量」与「前高全天量/60日均量×1.5」直接比较，上午结构上必然判「未有效放大」→ 假命中。

### Details
用户实测（新洋丰 000902，2026-10-28 约 11:59，放量上涨冲击平台上沿 14.11）：页面量能口径条显示「放量」（腾讯直采量比 fields[49]，按时间归一化的每分钟口径），但规则3命中「缩量假突破」。根因两层：
1. `_reconcileTodayBar` 盘中把当日 bar 覆写为「实时累计量」；规则3 `ampOk(bars[n-1].volume, levelVol)` 用这个部分日累计量 vs 前高**全天**量（53552 手）与 60日均量×1.5 —— 上午累计量永远过不了阈值，fail-closed → 必然命中。
2. 「快速回落」用最新价（14.00）< 平台上沿（14.11）判定——盘中 0.8% 的正常回落被当成「突破失败」，规则文案本身写的是「收盘日成交量」，即设计为收盘后判定。

同屏矛盾来源：量比条（归一化口径）与规则3（未归一化累计量）分母不同。

### Suggested Action
盘中未收盘时规则3不判定（dataGaps 标「当日未收盘，部分日累计量与全天历史量不可比，收盘后判定」），与规则5「尾盘突然放量拉升需收盘后判定」同先例。同口径排查其他 fail-closed 规则（该放量未放量 ampThr 比较）是否也有盘中假命中。

### Metadata
- Source: user_feedback
- Related Files: lib/volumeEngine.js (rule 3 at ~L661-705, _reconcileTodayBar at ~L2787)
- Tags: 盘中偏差, 量能口径, fail-closed, 诚实停判
- Pattern-Key: intraday.partial_volume_vs_fullday_baseline
- Recurrence-Count: 1
- First-Seen: 2026-10-28
- Last-Seen: 2026-10-28

---



## [LRN-20261028-002] best_practice

**Logged**: 2026-10-28T17:20:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
笔记云端同步（pushToServer）失败完全静默：catch 只 console.warn，且 HTTP 500 时 fetch 不抛错未检查 resp.ok——用户写的大盘记录「股市口诀坑」保存失败后丢失，全程无任何提示，用户到发现数据消失才知道出问题。

### Details
架构 = localStorage 先存 + 异步回写 /api/notes/sync（best-effort）。回写失败只进控制台，页面零反馈；加上 localStorage 按 origin 隔离（localhost vs 127.0.0.1 是两个空间），用户换地址查看即「消失」。服务端 notes.json 最后写入 11:45，16:00 的笔记从未到达服务器。

### Suggested Action
已实施（20261028b notes.js）：① pushToServer 检查 resp.ok，非 2xx 一律算失败；② 失败时页面顶部弹琥珀色醒目警告 12 秒（「云端保存失败，本条只存在这台浏览器里」），恢复成功后弹绿色确认；③ 失败后 30s 自动重试全量幂等回写。原则：**best-effort 写入绝不允许静默失败，数据落盘类操作失败必须 UI 可见**。

### Metadata
- Source: user_feedback
- Related Files: public/js/notes.js (pushToServer/_showSyncToast), public/css/style.css (.notes-sync-toast)
- Tags: 静默失败, 数据丢失, sync, localStorage, origin 隔离
- Pattern-Key: harden.silent_write_failure_ui_visible
- Recurrence-Count: 1
- First-Seen: 2026-10-28
- Last-Seen: 2026-10-28

### Resolution
- **Resolved**: 2026-10-28T17:20:00+08:00
- **Notes**: 20261028b 实施失败可见化 + 30s 自动重试 + resp.ok 检查；node 冒烟验证失败路径（不抛错/置位/排程重试）通过。

---



## [LRN-20261028-003] correction

**Logged**: 2026-10-28T17:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
个股页「大盘」因子引用首页「市场情绪提醒」（中性·关注，-3.9 分）却标「利空」徽标 + 「权重 -13%」——单源引用被渲染层重新判档，违反单源同义。

### Details
computeMarketEmotionSub 忠实引用落盘 score（-3.9 分 → 归一化 -0.04，value 文字「中性·关注」正确），但 ruleCore.toImpactScore 的「方向保底」（IMPACT_DIR_EPS=0.02，原意防 -0.10 偏空被舍成中性）把 |−0.04|≥0.02 判成 impactScore=-1 → 利空徽标；子卡「权重 ±X%」符号取自 signal 方向、幅度=份额×有效权重（与 |signal| 无关）→ 微弱 -0.04 显示成 -13%。首页「中性」判档（|分|<阈值）与 EPS=0.02 不对齐 → 同一份判断两页两个说法。

### Suggested Action
computeMarketEmotionSub 内按 tendencyKey 单源同义映射：tendencyKey=neutral → signal=0（徽标中性、权重行隐藏），bull/bear → 保持原符号 signal（|score|≥0.2 恒成立，徽标必与 tendency 同向）。改动仅此一处，不动全局 toImpactScore（其他因子的方向保底是刻意设计）。

### Metadata
- Source: user_feedback
- Related Files: lib/sameDayJudgment.js (computeMarketEmotionSub ~L532), lib/ruleCore.js (toImpactScore L365), public/js/app.js (_renderFactorBody L1417-1438)
- Tags: 单源同义, 引用型因子, 徽标判档, impactScore
- Pattern-Key: semantic.quote_factor_must_inherit_source_verdict
- Recurrence-Count: 1
- First-Seen: 2026-10-28
- Last-Seen: 2026-10-28

---



## [LRN-20261029-004] correction

**Logged**: 2026-10-29T17:30:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
平安估值卡误告「引擎按月算法判定最新已披露报告期为 M=6（半年度）…数据库尚无更新期数据，请复核更新」——而用户资料库里三季报 PDF 已上传、估值配置 M=9 已更新至三季报口径。告警方向完全颠倒。

### Details
两层根因：① pingAn601318 的按月算法把 10 月整月判为中报（day<=30→M=6），但 A 股三季报普遍 10 月下旬披露（平安 2026 三季报 10-28 披露）——而同项目 DCAVM/麦捷模型的同族算法早已用「10 月 day>=25→M=9」精细边界，唯平安版遗漏，属同族算法漂移；② 报告期核对告警是单向的：只比较 M 是否相等、不分方向——「配置落后算法」（真过期）与「配置领先算法」（提前披露、数据库已更新）输出同一条误导文案。教训：**凡「配置 vs 推断」类核对，告警必须区分方向**；推断算法滞后时配置才是权威（数据一致性铁律：数据库是单一权威源）。

### Suggested Action
① 按月算法 10 月边界改 day>=25→9（对齐同族）；② 告警改双向：仅配置 M<算法 M 才告「财报可能过期」，配置 M≥算法 M 静默（提前披露合法，以配置为准）。全项目排查同模式：凡「A vs B 不一致就告警」且 A/B 有先后权威关系的核对点，都要区分「谁领先谁」。

### Metadata
- Source: user_feedback
- Related Files: lib/valuation/pingAn601318.js (detectLatestReportMonths L82, 报告期核对), lib/valuation/dcavm688660.js / maijie300319.js (同族算法参照)
- Tags: 按月算法, 报告期自适应, 告警方向, 同族算法漂移, 配置权威
- Pattern-Key: temporal.comparison_alert_must_be_directional
- Recurrence-Count: 1
- First-Seen: 2026-10-29
- Last-Seen: 2026-10-29

---



## [LRN-20261029-005] correction

**Logged**: 2026-10-29T18:45:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary
用户报「两卡数据不一致/三季报更新出错」，排查后真因是口径差异（TTM vs 报告期累计）被旧文案「同比 -4.54%（68.44% vs 去年同期 72.98%）」隐藏——数值不同的两个口径并排出现而不标注口径，用户必然判为数据错误。

### Details
圣湘生物 688289：左卡毛利率 72.32%（TTM）、右卡同比里 68.44%（报告期累计）。两值都对，但旧格式不写「本报告期」，差异来源不可见。修复：同比文案统一为图二三段式「本报告期 X（去年同期 Y，边际 ±Z）」+ 毛利率/净利率加口径 note。

### Suggested Action
凡同一指标在同屏出现两个口径的数值，必须逐处标注口径（TTM/报告期累计），不得只靠「同比 ±X%」暗示；百分比差值单位用 pp 与增长率 % 区分。

### Metadata
- Source: user_feedback
- Related Files: lib/metricAnalysis.js
- Tags: 口径一致性, 展示格式, 报障判读
- Pattern-Key: display.dual_metric_must_label_basis
- First-Seen: 2026-10-29
---


## [LRN-20261029-006] process_gap / correction

**Logged**: 2026-10-29T19:30:00Z
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
用户报「昨日的数据为什么无法获取？」——ETF 申赎面板沪深300 组 15 只全部「基期无快照（新入名单）」。根因：10-28 18:42 采集时 27/34 只 PCF 抓取失败，**残缺快照（仅 7 只）却被 settled 定稿**，10-29 计算把它选为基期，缺失 code 全部误判为「新入名单」。

### Details
取证链：①data/etf-flow/20261028.json 仅 48KB（其余日 204KB），etfs=7 只（510050/510100/510190/510600/588000/588040/588050）；②lib/etfFlow.js computeFromSnapshots 基期选择只认 settled:true，不检查覆盖完整度；③collect 写盘时不看 okPcfs.length 是否小于 universe.length。修复（20261029j）：collect 残缺守卫（okPcfs<universe 或份额缺失→settled:false+partial:true+gaps 落盘）+ 基期选择/stockMonthlyFlow 双保险排除 partial + 数据还原（20261028.json 重建：S(10-26)官方快照+Δ(10-27)权威外部源三源交叉验证，四组校验全过）+ 台账重放补齐缺失增量。

### Suggested Action
凡「快照/批次型」落盘数据，**完整性不足时绝不能定稿（settled）**——定稿标志必须隐含「全量成功」语义；下游基期选择须同时校验 settled 与覆盖完整度（partial 排除）。残缺数据宁可不定稿留待重采自愈，也不可让残缺基期污染次日计算。恢复路径按 20261026b 惯例：权威外部源→多源交叉验证→四组校验（链路整篮/Δ整篮/官方总量逐位/前向整篮）→还原+溯源标记→台账经代码幂等重放（不手写 cum）。

### Metadata
- Source: user_feedback
- Related Files: lib/etfFlow.js, scripts/restore_etf_20261028.js, data/etf-flow/20261028.json
- Tags: 数据完整性, 快照定稿, 基期选择, 事故还原, 台账重放
- Pattern-Key: data.snapshot_partial_never_settled
- First-Seen: 2026-10-29
---



## [LRN-20261029-007] process_gap / correction

**Logged**: 2026-10-29T20:20:00Z
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
用户报「华安证券 600909 三季报已公布，但资料库和财报解读无法同步更新」。根因：reportSync 传 --types quarterly，download_reports.py 合法键仅 annual/semi/q1/q3，quarterly 被静默丢弃后回退 annual,semi——三季报/一季报自上线起从未被下载过（全自选股同因普查证实 6 只今日全部同错）。

### Details
静默降级链：syncReportForSymbol(--types quarterly) → python L1007 过滤丢弃 → types 空 → L1009 回退 ['annual','semi'] → 巨潮查 94 条只命中已存在的年报/半年报 → skipped=2 downloaded=0 → 记「下载未命中」。半年报同步正常（semi 恰为合法键）掩盖了 quarterly 从未生效。次生影响：财报解读（lib/ai/earnings.js）的 PDF 节选按最新报告期匹配资料库文档，缺三季报 PDF → 只能注入半年报节选；且 earnings 缓存 TTL 30 天，PDF 到位后旧解读仍会挂 30 天（000902 新洋丰实证：10-27 PDF 落地、10-21 中报缓存一直挂到 10-29）。

### Suggested Action
跨语言边界的枚举/类型参数必须在接收端显式校验：未知名要么报错要么映射别名（quarterly→q1+q3），**严禁静默回退到默认值**——回退会让错误看起来「正常工作」。下载/抓取类链路落地新数据后，必须联动失效依赖该数据的下游缓存（文档→财报解读），不能只靠 TTL 自然过期。修复时先普查同因范围（全自选股 report_sync.json 状态文件一次看清）。

### Metadata
- Source: user_feedback
- Related Files: lib/reportSync.js, scripts/download_reports.py, lib/ai/earnings.js, lib/ai/cache.js
- Tags: 静默降级, 跨语言参数校验, 缓存失效, 资料库同步, 财报解读
- Pattern-Key: integration.cross_lang_enum_never_silent_fallback
- See Also: LRN-20261029-006
- First-Seen: 2026-10-29
---



## [LRN-20261029-008] process_gap / correction

**Logged**: 2026-10-29T20:35:00Z
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
用户再报「海天味业和长江证券也发布了三季报，工作台没有获取到」。修复 quarterly 静默降级后仍有两处堵点：①hasReportDoc 假阳性——docStore.year 取公告日期年份，「2026-04-28 发布的《2026年第一季度报告》」被标 year=2026，错误挡住 2026 三季报同步（603288/000783 实证）；②东财通道接口两处改版未适配（ann_type 数字类目失效、列表不再带 attachments）。

### Details
假阳性链：hasReportDoc 用 d.type==='quarterly' && d.year==='2026' → 一季报文档满足 → syncReportForSymbol 直接返回「资料库已有」→ 永不下三季报。年份错位同根：「2026-03-27 发布的《2025年度报告》」也被标 year=2026。EM 通道：np-anotice ann_type=2（数字=财务报告）恒 0 条 → 正确类目为字母 A；列表 items 不再带 attachments → 需 np-cnotice 详情接口取 pdf.dfcfw.com 直链。另：巨潮对 A+H 公司（603288）索引延迟数小时，且「无 ann_type」回退组合会使 stock_list 过滤失效（返回全市场公告，标题匹配会错下别家公司报告——已删除并加归属校验 codes.stock_code）。

### Suggested Action
语义字段要区分「公告日期」与「报告期」：登记/查询报告文档一律按标题解析报告期年份+阶段（与 pickReportDoc 同口径），不得用文件名日期前缀充当报告期。外部接口改版要靠「found=0 必须查因」暴露——本次 ann_type 失效被「回退巨潮」掩盖多年。跨公司下载必须做归属校验（公告的 codes.stock_code 含目标代码），防过滤失效时错下文件。

### Metadata
- Source: user_feedback
- Related Files: lib/reportSync.js, scripts/download_reports.py, data/index.json
- Tags: 语义年份, 假阳性, 东财接口改版, 归属校验, 通道回退
- Pattern-Key: data.report_period_year_vs_announce_year
- See Also: LRN-20261029-007
- First-Seen: 2026-10-29
---



## [LRN-20261029-009] 东财F10三表接口：裸代码必被拒，必须带交易所前缀
**Area**: data-source

### Summary
实施海天估值 V3.0（全量重算支柱）时实测：emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/{lrb,zcfzb,xjllb}AjaxNew 对裸代码（code=603288）返回 {status:-1,message:'股票代码不合法'}，必须用带交易所前缀的 code=SH603288。fetchFinancialData 调用方传裸代码时三表全空、逐 companyType 回退全部落空且无显式报错（静默空数组）。

### Details
『静默空数组』再次复现 LRN-20261029-007 的模式：错误看起来像『没有数据』而非『参数错误』。诊断方法：同 URL 分别用裸代码/前缀代码单日期请求，对比返回体。另两处实测口径知识：①现金流量表补充资料 D&A 字段为 FA_IR_DEPR/IA_AMORTIZE/LPE_AMORTIZE/USERIGHT_ASSET_AMORTIZE，OILGAS_BIOLOGY_DEPR 与 FA_IR_DEPR 数值高度重合（差异<1%，疑似同一补充资料行拆分列），同时累加会重复计算；②现金流量表直接科目 CAPEX（购建固定资产…支付的现金）与腾讯财经 FCF 倒算口径差异巨大（海天 2025：12.84 vs 33.88 亿），混用会系统性扭曲 DCF。

### Suggested Action
凡调用东财 F10 三表接口，code 参数必须带 SH/SZ/BJ 前缀；调用方拿空数组时先做一次『前缀重试』或显式报错，不要逐 companyType 静默扫完。D&A 累加前对 OILGAS_BIOLOGY_DEPR 与 FA_IR_DEPR 做<1%重合排除。

### Metadata
- Source: implementation_discovery
- Related Files: lib/deep/financials.js, lib/valuation/haitian603288.js
- Tags: 东财F10, 三表, 参数校验, 静默空数组, D&A口径, CAPEX口径
- Pattern-Key: integration.em_f10_needs_exchange_prefix
- See Also: LRN-20261029-007
- First-Seen: 2026-10-29
---




## [LRN-20261029-010] 券商利润表无净额字段：直接取 FEE_COMMISSION_NI/INTEREST_NI 会假 0
**Area**: data-source

### Summary
实施长江证券 V3-五法则 E2E 验证时发现：仪表盘「手续费及佣金净收入=0 亿元 / 利息净收入=0 亿元」为假 0——东财券商利润表（lrbAjaxNew，companyType=1）根本不存在 FEE_COMMISSION_NI / INTEREST_NI 字段，模型 yi() 取不到回退 nz→0。实际披露口径为收入侧拆分：FEE_COMMISSION_INCOME（手续费收入 44.23 亿）/ INTEREST_INCOME（利息收入 29.89 亿）/ INTEREST_EXPENSE（利息支出 11.73 亿），且 FEE_COMMISSION_EXPENSE 年报/三季报均为 null（手续费净额不可得）。

### Details
假 0 危害：数值上被 nz() 吞成合法 0，下游 SOTP 轻资产净利推算（npLight）和展示文案全部带错数且无告警。正确修复：①手续费改收入侧口径并诚实标注「支出侧未披露，净额不可得」；②利息净收入由收入−支出诚实勾稽（29.89−11.73=18.16）；③下游 npLight 用勾稽后的 intNI。附：BVPS 这类「元/股」量纲变量误继承默认单位「亿元」，R() 注册器需显式传 unit。

### Suggested Action
凡新增三表字段，先对真实返回 JSON 实测字段名存在性（Object.keys 过滤打印），禁止凭字段名猜测；「整齐 0 值」按用户报障判读惯例一律先按假 0 排查。量纲非「亿元」的变量（元/股、%、倍数）注册时必须显式传 unit。

### Metadata
- Source: implementation_discovery
- Related Files: lib/valuation/changjiang000783.js
- Tags: 假0, 券商三表, 字段名实测, 利息勾稽, 量纲标注
- Pattern-Key: data.broker_income_statement_no_net_fields
- See Also: LRN-20261029-009, LRN-20261029-007
- First-Seen: 2026-10-29
---



## [LRN-20261029-011] 异步数据自适应架构：方法权重应由数据成熟度驱动而非固定百分比
**Area**: architecture

### Summary
华安证券估值引擎升级 V3.0 异步数据自适应架构（用户下发十四规则规范）：旧架构固定影子股权重 50/40/10 的问题在于无视「该方法依赖的数据是否新鲜」。新架构为每个指标生成数据契约（期差/容忍期差/成熟度绿黄红），方法成熟度=所依赖指标成熟度最低档，权重按绿×1.0/黄×0.7/红×0.3 动态分配并归一化，PB 法红→整体待更新态。

### Details
关键实现要点：①成熟度边界 60%/100% 容忍期差（age≤0.6×tol→绿）；②TTM 拼接禁×4/3粗年化（三季报后=前三季累计+上年Q4单季，上年同期数缺→null 禁静默填充）；③BPS 股本同步检测（净资产与股本期差>0.5%→区间化，无公告则区间不展开）；④SOTP 常规业务净利维持中报结转口径的理由：三季报 TTM 已含长鑫上市后公允价值增值，若再用 TTM×PE 与长鑫持股市值加总会双重计价；⑤影子股模式特例：SOTP 权重按其数据成熟度在 40-50% 摆动（绿50/黄45/红40），两套权重并列输出；⑥三态输出（精确态/区间态/待更新态）+置信度（90/75/60）。

### Suggested Action
凡多方法加权估值模型，权重不应硬编码；先算各方法依赖数据的成熟度，权重随数据新鲜度自动转移。点估值仅在全绿时给出，存在黄/红输出区间+置信度——把不确定性显性化而非伪精确。

### Metadata
- Source: implementation_discovery
- Related Files: lib/valuation/huaan600909.js, data/valuation/600909.json, scripts/test_valuation_huaan.js
- Tags: 异步数据, 数据契约, 成熟度分级, 动态权重, 三态输出, 双重计价
- Pattern-Key: architecture.async_data_adaptive_valuation
- See Also: LRN-20261029-009, LRN-20261029-010
- First-Seen: 2026-10-29
---



## [LRN-20261029-012] 数据治理升级版：锚点自动识别是消除硬编码年份的根本机制
**Area**: architecture

### Summary
士兰微估值引擎升级数据治理升级版（用户下发规范）：旧模型静态配置（2025 年报作 DCF 基数、净债务 52.43 假设值）的问题在于每次财报更新需人工改年份。新机制：东财三表实时拉取 + 锚点自动识别（三季报→中报→一季报回退链）+ TTM 固定公式（上年年报+本年累计−上年同期累计）+ 级别标签制度（A季频/B半年/C年/H高频，台账 25 项三要素）。

### Details
关键实现要点：①锚点=2026-06-30 半年报（东财 F10 尚无士兰微三季报）——锚点前移机制自动适配，季报披露后重跑即自动切换；②DCF 基数 TTM 化（130.52→139.78 亿）后第一档 g₀ 自动变小，中枢 30.77→27.88；③净债务/少数股东/ΔWC/D&A/CAPEX 从假设升级为锚点实时（ΔWC/营收实际 = (Δ应收+Δ存货−Δ应付)÷本年累计营收）；④完整度评分 A40/B20/C0/H20=80（确定性引擎无搜索通道，C 级搜索补充由配置更新执行，诚实记 0 分）；⑤上年同期缺失 → 年化退化 ×12/锚点月份数强制标注（sensHints 联动）。

### Suggested Action
凡涉及财报数据的估值模型，取数层必须实现「锚点自动识别+级别标签」，估值公式分母与分子强制同报告期体系。C 级数据需要搜索补充验证时，确定性引擎记 0 分并在报告显著标注，由配置更新流程补充——不假装 AI 搜索过。

### Metadata
- Source: implementation_discovery
- Related Files: lib/valuation/silan600460.js, data/valuation/600460.json, scripts/test_valuation_silan.js
- Tags: 数据治理, 报告期身份证, 锚点自动识别, TTM滚动, 完整度评分, 口径锁定
- Pattern-Key: architecture.data_governance_valuation
- See Also: LRN-20261029-011, LRN-20261029-010
- First-Seen: 2026-10-29
---
# LRN-20261029-013 | 圣湘 V3.0 三轨并行：五表锚定+TTM唯一合法桥接+评级方向反转属规范设计
- Context: 用户下发《圣湘生物（688289）全自动动态估值分析框架·AI指令集 v1.0》全文，要求升级圣湘专属估值模型。
- Event: 全量实施 V3.0 三轨并行层（轨道I相对估值50%/轨道II SOTP 35%/轨道III历史分位15%），五表锚定（表A年度锚硬锚/表B阶段观测软锚禁倒推/表C TTM拼接唯一合法桥接/表D市场实时/表E可比中位数非均值）。锚点自动前移至 2026-09-30 三季报(9M)（东财已有 2026 三季报，比规范给的 H1 观测点新）。TTM 归母 1.1167 亿 = 1.9894(2025年报) + 1.0405(9M累计) − 1.9132(上年同期)——Q3 单季仅 0.06 亿的暴跌首次完整进入估值分子，当前 PE(TTM) 77.8 倍超历史区间上沿（39~58）→ 分位 99.9% 封顶。
- Lesson: ①**目标 PE 区间倒挂是真实信号不是 bug**：历史 P25(43.75) > 可比上限(32.4) 说明圣湘历史估值中枢系统性高于可比公司——按回退规则改用可比区间 [21.6,32.4] 并警报，禁止硬凑。②**评级方向反转（V2.1 低估 17.65 → V3.0 高估 10.78）属规范设计意义**：V2.1 基于一致预期 FY2026E 未反映 Q3 暴跌，V3.0 TTM 口径反映最新盈利状态；数据不变则结论不变，口径升级带来结论升级是合规的，但必须在 lastVersion 存档中写明反转原因。③**三轨背离>30% 是警报不是错误**：PE 轨 30 亿 vs SOTP 144 亿偏差 315%，原因是利润端处周期低点——以利润端为主定价并在警报中写明机制。④语法排查教训：`S3 ? \`模板串\`,` 缺 else 分支报 "Unexpected token ','"，caret 指向逗号但根因在三元不完整；旧代码与新代码重名（legacySix 六模型的 sotpB 与三轨层 sotpB）会在语法检查后以 "already declared" 二连报出现，sed 按行号区间改名最小侵入。⑤nz() 帮助函数不是全局惯例，跨模型复制代码段时要确认目标文件有该 helper。
- Tags: 三轨并行, 五表锚定, TTM拼接, 区间倒挂, 评级反转, 风险折价, legacySix
- Pattern-Key: architecture.three_track_valuation
- See Also: LRN-20261029-012, LRN-20261029-011
- First-Seen: 2026-10-29
---
# LRN-20261029-014 | 万润 v2.0 数据频率自适应：置信度只动区间与权重、FCFF 实时化触发 DCF 再平衡
- Context: 用户下发《万润股份逻辑估值模型 v2.0：数据频率自适应版》全文，在 v1.0 三层加权（PB-ROE 50/PE 35/DCF 15）基础上升级。
- Event: A层核心输入实时化（东财F10三表 SZ002643，锚点 9M→H1→Q1）；置信度衰减机制（点估计不变，半宽=15%÷平均置信度，C<0.7层权重×C/0.7）；一致性校验四条。
- Lesson: ①**FCFF 基期从「假设 4.0 亿」改为「A层 TTM 规则值 0.88 亿」会让 DCF 从 11.99 元塌缩到 2.46 元 → 偏离 89.26% >80% 自动触发 DCF 再平衡（60/35/5）**——这不是 bug 而是规范设计：资本开支高峰期 DCF 本来就只配 5% 权重，再平衡机制正是为这种情况准备的；旧模型用假设值 4.0 亿反而掩盖了这一机制。②**区间口径切换（三情景→置信度区间）与评级规则切换（区间边界→信号比 0.75/1.30）必须同步**，只改区间不改评级会出现「价格在区间外但显示合理」的错位。③敏感性格网「由参数自动生成」要真做到：ROE 网格=可持续ROE×[0.7,0.85,1,1.15,1.3]、净利网格=预测净利×[0.75,0.9,1,1.1,1.2]、PE列=[行业×0.6,×0.8,targetPE,行业]，不留硬编码尾巴。④null 安全必须贯穿全链：fetchStatements 合法返回的 S 内部 prevSame/cf/bal 仍可能为 null（测试注入路径），`S.prevSame.np` 这种链式访问要提变量 `ps = S.prevSame || {}`，run 的 try/catch 会把 TypeError 吞成 COMPUTE_FAILED 使测试段整段静默失败（4 连 ❌ 无错误信息）——排查时先直接打印 {ok,error,detail}。⑤校验二/四触发是诚实记录不是失败：TTM ROE 偏离近三年均值 45.79%（周期低位+2023高价周期）→ 剥离汇兑后仍处低位属周期性偏离；PE 层隐含净利 1.62 亿 vs 一致预期 4.21 亿差 91pp → 目标 PE 假设偏高（行业 103 倍×0.85 vs 市场定价）。
- Tags: 数据频率自适应, 置信度衰减, DCF再平衡, TTM实时化, 信号比评级, 总和校验
- Pattern-Key: architecture.frequency_adaptive_valuation
- See Also: LRN-20261029-013, LRN-20261029-011
- First-Seen: 2026-10-29
---
# LRN-20261030-001 | 华安 PE 层口径修订版：长鑫收益确认开关 + 正常化 EPS 中值口径 + 字段链假 0
- Context: 用户下发《一次性损益剔除口径·报告首页强制披露（修订版）》六条，升级华安 V3.0 PE 层。
- Lesson: ①**券商模板字段链假 0 教训**：OTHER_EQUITY_TOOL 在券商资产负债表格式下恒为 null，实际值在 OTHER_EQUITY_INVEST（21.4653 亿永续债）；原代码 `yi(OTHER_EQUITY_TOOL) || 0` 把缺失吞成 0——与 LRN-20261029-010（券商利润表净额字段假 0）同类事故，券商三表字段名永远要实测验证、禁 `|| 0` 吞缺失。②**普通股 BPS =（归母净资产 − 其他权益工具）÷ 股本**：规范测算 5.62 与实时值 5.60 差 0.02 属扣减口径差异（是否再扣库存股等），代码取实时字段并标注差异来源，不硬凑规范数字。③**确认开关模式**：确定性引擎拿不到的数据（三季报非经常性损益明细，fxsy 端点无数据）做成配置开关 lcxInNonRecurring（null=未确认→保守中值 / true=确认在扣非外→上修 / false=确认在扣非内），把「人工确认」变成一键操作而非改代码。④**口径切换要同步扩展区间化**：PE 点估值改中值后，centerLow/High 必须同步纳入 PE 区间（原来只用点值），否则区间宽度不反映新增不确定性；副作用检查——区间下移使「方向性不明」边界标注消失，相关测试断言要同步更新。⑤规范给的数字是测算示例不是圣旨（0.702 vs 实时 0.70），代码权威原则下输出实时计算值并标注与规范的差异来源。
- Tags: 字段链假0, 普通股BPS, 确认开关, 正常化EPS, 口径修订
- Pattern-Key: architecture.caliber_revision_valuation
- See Also: LRN-20261029-010, LRN-20261029-011
- First-Seen: 2026-10-30
---
# LRN-20261030-001 | 华安 PE 层口径修订版：长鑫收益确认开关 + 正常化 EPS 中值口径 + 字段链假 0
- Context: 用户下发《一次性损益剔除口径·报告首页强制披露（修订版）》六条，升级华安 V3.0 PE 层。
- Lesson: ①**券商模板字段链假 0 教训**：OTHER_EQUITY_TOOL 在券商资产负债表格式下恒为 null，实际值在 OTHER_EQUITY_INVEST（21.4653 亿永续债）；原代码 `yi(OTHER_EQUITY_TOOL) || 0` 把缺失吞成 0——与 LRN-20261029-010（券商利润表净额字段假 0）同类事故，券商三表字段名永远要实测验证、禁 `|| 0` 吞缺失。②**普通股 BPS =（归母净资产 − 其他权益工具）÷ 股本**：规范测算 5.62 与实时值 5.60 差 0.02 属扣减口径差异（是否再扣库存股等），代码取实时字段并标注差异来源，不硬凑规范数字。③**确认开关模式**：确定性引擎拿不到的数据（三季报非经常性损益明细，fxsy 端点无数据）做成配置开关 lcxInNonRecurring（null=未确认→保守中值 / true=确认在扣非外→上修 / false=确认在扣非内），把「人工确认」变成一键操作而非改代码。④**口径切换要同步扩展区间化**：PE 点估值改中值后，centerLow/High 必须同步纳入 PE 区间（原来只用点值），否则区间宽度不反映新增不确定性；副作用检查——区间下移使「方向性不明」边界标注消失，相关测试断言要同步更新。⑤规范给的数字是测算示例不是圣旨（0.702 vs 实时 0.70），代码权威原则下输出实时计算值并标注与规范的差异来源。
- Tags: 字段链假0, 普通股BPS, 确认开关, 正常化EPS, 口径修订
- Pattern-Key: architecture.caliber_revision_valuation
- See Also: LRN-20261029-010, LRN-20261029-011
- First-Seen: 2026-10-30
---

---
- ID: LRN-20261030-002
- Title: 华安估值权重与输出形态八条规范落地（PB普通股口径切换+绿权重置信度+折扣30%）
- Context: 用户下发《【本次估值权重与输出形态】》八条：权重 PB45/SOTP45/PE10、成熟度 PB绿/SOTP黄/PE绿、规则9优先于规则8声明、主情景区间+中枢、参考情景仅作参考、分项必须列示、区间态不输出单点值、数据同步说明。
- Lesson:
  1. PB 层目标价基准切换要动 pbTarget/pbTargetLow/pbTargetHigh 三个赋值（bpsUsed→bpsOrdinary），归母口径保留作参照并随行标注——只改一处会留口径不一致。
  2. 区间态置信度新口径=「绿色方法权重占比」近似（greenW=各绿方法权重和，实测 PB45+PE10=55%）+定性分层（≥70%高/≥50%中等偏高/≥35%中等/其余一般）；精确态保持 90。
  3. 规范手写的参考情景目标价（8.22 元）是按旧折扣 25% 口径手算的；限售折扣按规范第8条改 30% 后代码实测 7.97——数值由代码计算，规范文本与实测的差异要如实披露差异原因，不改代码迎合手写值。
  4. weightsNote 重写为①~⑧八条结构，全部动态值拼接（占比/区间/分项/期差/敏感性/折扣），测试用八条结构正则+关键语义逐条断言。
- Tags: 权重输出形态, 绿权重置信度, 限售折扣30%, 参考情景, 八条结构
- Pattern-Key: architecture.weights_output_form_spec
- See Also: LRN-20261030-001, LRN-20261029-011
- First-Seen: 2026-10-30
---

---
- ID: LRN-20261030-003
- Title: 华安「估值结构拆解·强制披露」五条落地（结构拆解行+评级口径带+影子股溢价敏感性传导）
- Context: 用户下发《估值结构拆解·强制披露》五条：分项目标价/评级口径说明/影子股溢价提示/置信度说明/PB口径提示。规范文本手写数值基于 20261030a 旧口径（中枢8.08/下限7.26/折扣25%）。
- Lesson:
  1. 规范文本中的手写数值（8.08/7.26/0.78 溢价/8.22 参考）是按旧口径手算的快照，落地必须全部改为代码动态值（7.81/7.00/现价−PB法/7.97），并在汇报中披露差异原因（折扣 25%→30%），不得照抄手写值也不得改代码迎合。
  2. 影子股溢价敏感性要按权重确定性传导：长鑫市值−20% → 持股价值减少额 ÷ 股本 = 每股降幅，再 × SOTP 权重 → 中枢回落值（−17.75亿 → −0.35元/股 × 45% → 7.81→7.65），不能直接用每股降幅当中枢降幅。
  3. 评级口径说明要把「区间下限」与「买入触发线（下限×0.9）」之间的地带显式命名为「持有/中性观察带」，且现价低于下限但不破买入线时明示「不判低估」——区间判定输出必须附口径解释，防用户误读。
  4. PB 双口径披露：PB(LF) 现值随 BPS 口径变（归母 1.15 / 扣减 1.24），但合理PB是三层加权乘数、与BPS口径无关——用户手写「两者均上修」中合理PB上修半句按代码口径不成立，落地时如实按代码输出并说明。
- Tags: 估值结构拆解, 强制披露, 评级观察带, 敏感性传导, 双口径PB
- Pattern-Key: architecture.structure_disclosure_spec
- See Also: LRN-20261030-002, LRN-20261030-001
- First-Seen: 2026-10-30
---

---
- ID: LRN-20261030-004
- Title: 新洋丰（000902）专属估值模型 v1.0→V2.0 全量重写（全自动动态估值指令集落地）
- Context: 用户下发《新洋丰全自动动态估值 AI 指令集 v2.0》（七节：角色/运行方式/全自动原则/A1周期判定/R1-R6数据路由/取数/估值三角/动态情景/反向验证/输出模板/硬约束），要求把原 v1.0「永久逻辑估值引擎」（正常化盈利trimmed median锚）升级。
- Lesson:
  1. 工程范式映射：指令集"全自动动态取数（东财F10多源股价交叉/分红/分部/磷矿进度）"在 project 沙箱不可全实时，按既有范式（对齐华安/万润/圣湘）映射为"配置锁死权威快照 + 全动态算法"；算法框架 100% 按 v2.0 实现（A1三信号/R1-R6/估值三角/三情景/反向验证/期权独立/置信度六档/硬约束），仅数据快照为人工刷新。须向用户显式说明此取舍。
  2. R2 TTM拼接 vs R3前向年化降级：LATEST=H1 走 R2（归母=BASE_Y全年+LATEST.H1−上年同期H1=16.2193亿），R3仅上年同期缺失时降级并打[ANNUALIZED]标记——降级路径代码保留但当前不触发。
  3. 估值三角 EV/EBIT 交叉：EV=市值+净有息负债（R4自洽，无需找上年末值）；当 EV/EBIT 隐含倍数与主模型 PE 合理价偏离>30% 时，置信度由高降为「中」（PE为主、EV为下沿约束），解决指令集 4.2"标注分歧"与六"低=偏离>30%"的张力——calibration 决策：保留"低"给 ANNUALIZED/反向失败/EV降级方向性，EV分歧>30%仅降为"中"，需向用户说明。
  4. 反向验证语义坑：第5项「股本稀释」未稀释属正常态（result='不适用'即通过），误设为'否'会被 reverseAllPass 当成失败 → 置信度错判为"低"。修复：未稀释→'不适用'。
  5. 期权增量（磷矿/磷酸铁）独立列示，绝不并入基准目标价（硬约束3）；磷酸铁单吨毛利为负/未披露只判"中性"不得判"低迷"（结构性增量非周期信号，A1 信号3）。
  6. 数值由代码计算：PE_base=0.5×peer中位(9.61)+0.5×hist中位(13)+调整(ROE>12→+0.5、CFO/E>1→+0.3)=12.1 → 合理价 15.64；中枢 15.64/区间[12.95,18.08]/置信度中。
- Tags: 新洋丰, V2.0, 全自动动态估值, R1-R6路由, 估值三角, 置信度六档, 期权独立
- Pattern-Key: architecture.full_auto_valuation_v2
- See Also: LRN-20261030-003, LRN-20261030-002
- First-Seen: 2026-10-30
---

- ID: LRN-20261030-005
- Title: 封顶/覆盖类数值变更必须全文统一用最终有效值（消除「标签X/结果Y」割裂幻觉）
- Context: 长江证券补丁I 把动态PB锚由原始 1.83 封顶至理论PB锚 1.60。补丁J 审计发现多处文案仍把 1.83 当作「当前锚」展示——市场快照、敏感性看板、结论矩阵、红灯提示、ROE质变摘要均出现「标签写1.83、但计算中枢=10.74（按1.60算）」的割裂，以及红灯提示「动态锚1.83突破上轨→以动态锚为准」这种引用旧原始值当当前值的反例。
- Lesson:
  1. 任何「中间原始值 → 最终有效值」的覆盖/封顶/降级，落地的第一铁律是：所有面向用户的文本位置（市场快照 / 敏感性看板 / 结论矩阵 / 红灯·绿灯 / 摘要）必须统一引用【最终有效值】，原始值只允许出现在「原X→封顶至Y」的诚实括号解释里，绝不能作为独立当前锚出现。
  2. 写「计算等式强校验」类说明时，若 公式值 ≠ 最终输出值（如 基准×0.75=8.06 但被铁底锁到6.14），必须如实两段式描述（先列公式值，再标注为何锁定），严禁强行画等号制造假自洽。
  3. 情景设定要防倒挂：当主模型中枢 > 对照锚（如 10.74 > 8.92）时，「乐观复苏」自动失效转为「均值回归底线（仅备注）」，绝不允许输出「乐观价 < 基准价」的反常识数据——落地时给情景对象加 inverted 标志，前端/文案统一按 inverted 重标。
  4. 熔断/状态类提示引用的数值，必须与当次计算的最新数值逐字一致；历史残留提示（如「PB锚1.83倍」「以动态锚为准」）必须清除——用全局 grep 1.83 / 以动态锚为准 兜底排查。
- Tags: 封顶一致性, 割裂幻觉, 文本数值对齐, 动态PB锚, 补丁J
- Pattern-Key: architecture.capped_value_text_consistency
- See Also: LRN-20261030-004, LRN-20261030-003
- First-Seen: 2026-10-30
---

- ID: LRN-20261030-006
- Title: 测试脚本两个暗坑——ok(name,cond) 参数顺序颠倒会恒绿；model.run() 不注入三表在沙箱必崩
- Context: 补丁J 新写离线测试 scripts/test_changjiang_patchJ.js 初版把断言写成 ok(condition, name)，但 ok 定义为 ok(name, cond)。结果 condition（布尔）被当 name 打印、cond（字符串name）恒 truthy → 全部断言假绿、26/26 通过是假象；修好顺序后立刻暴露 J4.3 真实失败。另一坑：项目内 test_changjiang_patchF/patchFG/matrix_render 三个旧测试直接 m.run('000783',{price}) 不传三表，run 内部联网取数，沙箱无网 → 返回残缺 → undefined 访问直接崩溃，且它们编码的是补丁I前旧值（center9.38/复苏8.87）。
- Lesson:
  1. 自写断言函数务必固定签名（推荐 ok(cond, name) 或 ok(name, cond) 二选一且全局统一），并在首个失败用例前用「已知会失败的条件」做一次反向自检，防止签名颠倒导致假绿。
  2. 估值模型确定性测试必须像 test_valuation_changjiang.js 那样用 baseData() 注入 statements/balanceQuarterly 离线跑 run()，绝不能裸调 run(symbol,{price}) 依赖实时联网——run_all_tests.js 的 needsNetwork 正则只扫文件源码不扫依赖，联网型测试会混进 quick 套件并崩。
  3. 预补丁/过期且联网依赖的测试，直接退役（删除）+ 用聚焦离线测试替代，比逐条回填旧值更稳；删除前确认其覆盖已被权威测试吸收。
- Tags: 测试假绿, 参数顺序, 离线注入三表, 沙箱联网崩溃, 退役过期测试
- Pattern-Key: testing.assert_signature_and_offline_run
- See Also: LRN-20261030-005
- First-Seen: 2026-10-30
---

---

- ID: LRN-20261030-007
- Title: 估值模型"前瞻情景 vs 折价后中枢"坐标轴不一致——用动态 secAxis 字段显式锚定，note 必须动态注入当前中枢而非写死用户给的示例数字
- Context: 圣湘生物模型用户报障：图1(V3.0三轨合成·含历史极端PE悲观折价)中枢 10.78 与图2(前瞻三情景/Forward PE·2026E)基准 17.65 用户看会混淆。用户口令给了"若按V3.0保守折价口径，基准情景对应中枢应平移至 10.78 元"的示例文本。落地时图1中枢因后续防高估指令(指令2)降到 9.71 —— 若把 10.78 硬编码进 note 就变成假值。
- Lesson:
  1. 当同一标的存在"滞后/折价口径"与"前瞻/未折价口径"两套中枢时，新增一个返回字段(如 secAxis)承载：折价前区间 preDiscRange、折价前中枢、折价后中枢 postDiscCenter、mandated 高亮 note、锚定 anchorLine。前端在图2顶部渲染该 note+anchorLine。
  2. note 里的"平移至 X 元"必须 `${center3}` 动态注入最终计算结果，绝不可写死用户示例里的 10.78；用户给的示例数字只是当下快照，模型逻辑一变(如指令2降低中枢)示例即失效，写死即造假。
  3. 锚定基准取"图1折价前每股区间"(synthLow/High÷N)，让用户看清前瞻情景相对折价前区间的位置，而非相对已折价的中心。
- Tags: 坐标轴对齐, 前瞻vs折价, 动态注入, secAxis, 诚实一致性
- Pattern-Key: valuation.axis_alignment_dynamic_note
- See Also: LRN-20261030-005, LRN-20261030-006
- First-Seen: 2026-10-30
---

- ID: LRN-20261030-008
- Title: 并购标的集采/政策风险防高估——config-gated PE 封顶 + 商誉减值单独扣减，动态与静态双链同步施加
- Context: 圣湘海济(生长激素)赛道有集采(粉针/水针)预期，原给其 1.85亿净利配 35.6x 生物制品PE 偏高。用户指令：核心并购标的有集采预期时，适用PE不得超过可比公司中位数×0.7，并单独计提5-10%商誉减值扣减项。
- Lesson:
  1. 这类风险约束做成 config 开关：haijiCollectExpected + haijiPeerPeMedian(可比中位数) + haijiCollectPeCapCoef(0.7) + haijiGoodwillImpairRate(5-10%取7%)。cap = peerMedian×coef，appliedPE = min(原PE, cap)。
  2. SOTP 海济 B 在【两处】都要改：动态 sotpCalc 的 B 行 + 静态三轨轨道II·B；否则两链算出不同海济估值。两处统一 `np × appliedPE × mult × coef × (1-goodwillImpair)`。
  3. 触发时必须在 alerts 推一条"集采预期触发SOTP防高估"明确提示，并在轨道II行/SOTP明细B行/coreRows行业倍数三处显式标注"集采封顶·原Xx"与"(1−N%商誉减值)"——防高估是实质性降估值，必须让用户看得见降在哪。
  4. 全局商誉折价(discounts.goodwill 10-15%，触发条件判定)与这里的海济专属商誉减值(5-10%单独)是两个不同口径，命名/注释要区分，避免重复扣减或被误并。
- Tags: 集采防高估, PE封顶, 商誉减值, config-gated, SOTP双链
- Pattern-Key: valuation.collect_risk_cap_and_goodwill_impair
- See Also: LRN-20261030-005
- First-Seen: 2026-10-30

---

- ID: LRN-20261030-009
- Title: 估值模型测试若 model.run() 为 async，测试必须 await，否则拿到 Promise 全断言恒绿/全假
- Context: scripts/test_sanxi_selling_expense.js 旧版 `const r = m.run('688289',{price:30})` 直接同步用 r.ok —— 但 run 已改 async 返回 Promise，r 是 Promise 对象，r.ok 为 undefined → 全部 check 因 cond 为 falsy 而 FAIL，且所有"含某文本"断言因 r.xxx 为 undefined 全失败(假红)，掩盖了模型真实行为。
- Lesson:
  1. 凡调用已升级为 async 的模型 run()，测试主体必须包进 `(async()=>{ const r=await m.run(...); ... })().catch(...)` 或顶层 await；切勿把 Promise 当结果对象用。
  2. 模型返回 `{ok:false,error:'SANXI_COMPUTE_FAILED',detail:e.message}` 时，detail 才是真错；测试/排障先打印 r.detail 或直接在 node -e 里 catch 打印 stack，定位 TDZ("Cannot access X before initialization")/undefined 等运行时错。
  3. 同项目惯例：确定性测试用 baseData() 注入三表离线跑（见 LRN-20261030-006）；若模型 run 允许不传 statements(内部 try/catch 回退)，可在不联网下跑通、仅降级 TTM，断言聚焦结构字段不依赖具体数值。
- Tags: async测试, await, Promise陷阱, 假绿假红, SANXI_COMPUTE_FAILED
- Pattern-Key: testing.await_async_model_run
- See Also: LRN-20261030-006
- First-Seen: 2026-10-30


## [LRN-20261030-001] best_practice

**Logged**: 2026-10-30T21:50:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: config

### Summary
同名财务指标「页面 0.37 vs 引擎 -2.39」看似矛盾，实为中报 vs 三季报口径差异；判错前必须先还原报告期链条并做双源数值闭环。

### Details
用户报障：新洋丰页「每股经营现金流 0.37（2026中报）」与估值卡「2026Q3 经营现金流 -2.39 亿」疑似矛盾。核查路径：东财 F10 xjllbAjaxNew 逐期取 NETCASH_OPERATE → 9M=-2.3852 亿（与引擎一致✅）、H1=4.6683 亿 ÷12.55 亿股=0.372 元（与卡片 0.37 闭环✅）、单季 Q3=-7.0535 亿（硫磺囤货付现+销售延后，调研纪要归因）。顺带发现配置 h1.cfo 2026=9.8/2025=8.5 是 v1.0 校准估计值 → 精确化为 4.6683/10.0404（F10 权威值）。R2 TTM 拼接（FY+9M−上年9M）不经过 H1 → 引擎输出不变。

### Suggested Action
1. 判读「数字矛盾」类报障时，先列「报告期×口径×每股/累计」三要素表，再做 F10 权威源数值闭环，禁止直接判错或改数。
2. 配置锁死模型中的**整值/估计值字段（如 9.8、8.5、10.8）是历史遗留信号**，升级报告期时应顺带用 F10 精确值替换并在 source 留痕。
3. pypdf 提取值与 F10 独立源一致时可信度升级（此前 000902 PDF 曾有股本行误读，本次 CFO 提取值经 F10 验证为正确）。

### Metadata
- Source: user_feedback
- Related Files: data/valuation/000902.json; lib/valuation/xinyangfeng000902.js
- Tags: 数据一致性, 报障判读, pypdf, 东财F10
- Pattern-Key: harden.report_period_disambiguation
- See Also: 000902 PDF 股本行误读事故（20261030h）
---


## [LRN-20261030-002] correction

**Logged**: 2026-10-30T21:55:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
getRecentReportDates 月份硬编码（10月→只请求到中报）导致 xjllb 系财务卡在三季报披露后整月不同步；数据抓取的「报告期可得性推断」必须对齐法定披露日历，不得按旧披露节奏猜。

### Details
用户报障：新洋丰页面「每股经营现金流 0.37（2026中报）」vs 东财 F10 官方页「-0.1901（2026三季报）」。根因：lib/stockData.js getRecentReportDates 用 `month>=11 才请求 Q3`（旧假设：Q3 11月才可得），实际上市公司 10 月下旬已披露 → OCF 分支整个 10 月不请求 2026-09-30。同页 ZYZB 主要指标卡正常（服务端返回报告期），形成同页口径分裂。修复：请求窗口对齐披露日历（Q1@4月/H1@8月/Q3@10月/FY@次年1-3月），未披露期接口自动缺失 → sorted[0] 回落，提前请求无害。实测 getQuote('000902') → -0.1901 元/2026年三季报，与东财一致。

### Suggested Action
1. 凡「按当前日期推断最新可得报告期」的代码，一律对齐披露日历（Q1 04-30 / H1 08-31 / Q3 10-31 / FY 次年 04-30）并提前一档请求，靠「缺失自动回落」兜底，不做逐公司披露状态判断。
2. 同一页面出现「部分卡片更新、部分滞后」时，优先排查各卡独立的日期推断函数（口径分裂信号），而非怀疑缓存。
3. See Also LRN-20261030-001：同一天两起现金流报障，先口径还原再判错。

### Metadata
- Source: user_feedback
- Related Files: lib/stockData.js (getRecentReportDates)
- Tags: 披露日历, 数据最新性, xjllb, 口径分裂
- Pattern-Key: harden.disclosure_calendar_alignment
- See Also: LRN-20261030-001
---


## [LRN-20261030-003] 三季报滞后：全工作台审计法（用户指令"全工作台检查哪些地方用了旧数据"）

### Error
- 深析/主指标/现金流卡逐个修完后，工作台仍存在两处估值模型配置（麦捷/电气风电）三季报数据滞后未被用户或 AI 察觉，靠用户"全工作台检查"指令才暴露。
- 圣湘测试 6.2 断言滞留在旧配置版本 20261029r，配置合法升级 20261030h 后测试误报红。

### Root Cause
- 各估值模块的配置文件（data/valuation/*.json）各自维护 reportPeriod/version/freshness，披露新财报后没有集中清单逐一核对；测试断言里硬编码版本号会随合法升级而失配。
- 顶层 reportLabel 与 reportPeriod 是两个字段（dcavm688660.js 直接读 cfg.reportLabel），只升其一会出现同模型内标签口径分裂。

### Suggested Action
1. 季报披露季（4/8/10 月下旬）做一次"全工作台审计"：以披露日历为基准，遍历全部 data/valuation/*.json 的 reportPeriod/disclosureDate，列出滞后清单再逐个升级，而不是等报障。
2. 升级配置时 grep 同文件内所有「半年报/中报/Q2」字样，确保 reportLabel/reportPeriod/快照 source 标注三类口径一次升齐（source 标注若真取自 H1 数据则保留）。
3. 测试断言避免硬编码配置版本号；确需版本守卫时，用「version >= 期望值」或单独一行注释「升级配置时同步改此处」。
4. 硬估值盈利锚设计（如 DCAVM 用多年中位数）的模型，新季报只需升级标注与快照，不强行进计算——升级前先确认模型设计边界。

### Metadata
- Source: user_feedback
- Related Files: data/valuation/300319.json, data/valuation/688660.json, lib/valuation/maijie300319.js, lib/valuation/dcavm688660.js, scripts/test_valuation_sanxi.js
- Tags: 三季报, 全工作台审计, 口径分裂, 测试断言滞后, 版本守卫
- Pattern-Key: harden.workspace_wide_report_audit
- See Also: LRN-20261030-002
---


## [LRN-20261101-001] 异动归因卡「盘中冻结快照」导致展示数字与页头不符

### Error
- 个股「异动归因」卡（个股近期热点）展示的 涨跌幅 -4.40% / 振幅 2.98%，与该股页头实际收盘 -5.97%（现价 6.62，昨收 7.04）不符。用户 2026-11-01 长江证券 000783 截图报障。
- 根因：lib/hotTopics.js analyzePriceChange 缓存按「交易日」复用，但命中缓存时直接 `return {...cache}`，把盘中快照的 changePct/amplitude/price/high/low/prevClose 整个冻结复用；收盘后实际涨跌幅变了，卡片数字却仍是盘中值。
- 系统性：所有「异动归因」卡（涨跌幅 ≥3% 或 振幅 >3% 触发）只要是在盘中生成缓存，都会在当日后续/收盘后被回放旧数字。模式二（网络热议话题）不展示百分比，不受影响。

### Root Cause
- 缓存职责边界错配：缓存应只复用「AI 归因叙事文本 + 证据」，而「展示用行情数值」必须每次以当前 getQuote 为准。代码把两者混在一起复用。
- 仅靠 `cache.date === today`（交易日）判定，无法区分「盘中快照」与「收盘值」。

### Suggested Action
1. 缓存命中时，只复用 analysis/sources 等叙事字段；changePct/amplitude/high/low/price/prevClose/date 一律用 live quote 重写（已落地 lib/hotTopics.js）。
2. 增加「漂移守卫」：若 live changePct 与缓存 changePct 差值 >1.0pp（典型盘中→收盘漂移），直接作废重算，保证叙事与数字同时正确。
3. LLM 失败降级的 stale 返回也一并刷新展示数值。
4. 通用红线：任何「按交易日缓存、但前端展示实时行情数字」的卡片，命中缓存时必须用当前行情重写展示字段，不得复用冻结快照。
5. 验收：注入 live quote + 植入盘中快照缓存，断言返回数字==live quote（scripts/test_hot_topics_stale_fix.js，6 项全绿）。

### Metadata
- Source: user_feedback
- Related Files: lib/hotTopics.js (analyzePriceChange), public/js/app.js (1913/1915 渲染 changePct/amplitude)
- Tags: 缓存一致性, 盘中快照, 异动归因, 涨跌幅, 振幅, 数据一致性红线
- Pattern-Key: harden.cache_must_not_freeze_display_numbers
- See Also: LRN-20261030-002
---


## [LRN-20261101-002] "切换页面后才开始读取" 是预加载不可见的观感 bug

### Error
- 用户多次重申"打开工作台后所有页面应提前读取数据和缓存"，但仍感觉"再切换页面后才开始读取"（深度分析/财报解读卡切到 tab 才出现"后台进行中（已 2s）"转圈）。用户 2026-11-01 截图报障。
- 根因不是"没预加载"：renderDashboard 已有「全局自动加载」块（打开个股页即并发触发 loadDeepAnalysis/loadCapitalFlow/loadIndustryAnalysis/loadShareholders/loadPriceAction，延迟 100~400ms）。真正的两个缺陷：
  1. 加载进度条/转圈写在**未激活的 tab 面板内部**（#deepLoading 在隐藏的 #tab-deep 里），预加载在后台进行时用户根本看不到，切到该 tab 时面板变可见才"突然"出现转圈 → 误感为"切换后才开始"。
  2. loadDeepAnalysis 的轮询逻辑 `if (deepActive) setTimeout(tryOnce,4000)`——tab 未激活就**停止轮询**，导致结果未被写入 deepData/deepLoadedSymbol；切回时 `deepLoadedSymbol !== currentSymbol` 再次触发 loadDeepAnalysis，重新展示转圈。服务端 _deepJobs 虽常驻且落盘，但前端没把后台结果接住。

### Root Cause
- 预加载的"可见性"与"结果回收"都绑定在「当前激活 tab」上，而非"任务本身是否完成"。后台任务在隐藏态既看不见、也不被回收。

### Suggested Action
1. 任何后台预加载必须有一个**常驻、与 tab 无关的全局指示器**（如顶部导航 pill），列出"正在预读哪些分页"，让用户看见预加载在进行。
2. 后台轮询**不得因 tab 隐藏而停止**：隐藏态只跳过"刷新可见 loading 文案"，但轮询照常直到结果落盘并写入 deepData，切回即秒显（不重新转圈）。token 守卫保证切股/重入时旧轮询自动作废。
3. 所有被自动加载触发的函数都要在 start/finish 处向全局指示器报状态，覆盖"所有页面"。
4. 验收：app.js 抽取 bgPreload 真实源码 + 最小 DOM stub，断言 start 显示并列出分页、并发、部分完成仍可见、全部完成隐藏（scripts/test_bg_preload_indicator.js，7 项全绿）。

### Metadata
- Source: user_feedback
- Related Files: public/js/app.js (renderDashboard 自动加载块、loadDeepAnalysis 轮询、bgPreload 指示器), server.js (_deepJobs)
- Tags: 预加载可见性, 后台轮询, 切换页面才加载, 缓存破坏版本戳
- Pattern-Key: harden.background_preload_must_be_visible_and_self_collecting
- See Also: LRN-20261101-001
---



## [LRN-20261103-001] correction

**Logged**: 2026-11-03T15:20:00+08:00
**Priority**: medium
**Status**: pending
**Area**: frontend

### Summary
位置驱动的展示分支（横盘股无主判/无参考表）会被用户感知为"这只股票版面坏了/和其他股不一样"——第三次同类报障。

### Details
量价判定卡版面由「第一步位置」驱动：POS_VM_MATRIX/POS_VM_EXT 只覆盖低位区间/高位区间/上涨途中/下跌途中四类，位置=震荡整理（横盘）时 cell=null、extRef=null、表体为空，前端显示诚实说明（20261102k）。海天味业（12个月分位44%、带宽≤15%横盘）触发该分支，圣湘生物（低位区）触发完整分支，用户再次报"版面不一样"。前例：20261102k 空表报障、20261101f 参考行误读。共同根因：**横盘位置在判定卡上缺少可视化内容（既无主判也无参考表），只剩两段文字说明**，且后端 summary（volumeEngine 2099）与前端空表注（app.js 2555）两段文字近似重复，加重"故障感"。

### Suggested Action
若用户要求统一版面：为「震荡整理」位置补思维导图原生的「区间横盘震荡（箱体）8 形态」参考表（灰色参考徽标、不参与判定），并把后端 summary 与前端空表注合并为一段；主判横幅是否补「横盘·观察」需用户拍板。方案必须类型级（所有横盘股同口径）。

### Metadata
- Source: user_feedback
- Related Files: lib/volumeEngine.js (POS_VM_MATRIX 1779/POS_VM_EXT 1845/summary 2099), public/js/app.js (posHtml 2548-2555)
- Tags: 量价判定, 位置驱动分支, 横盘, 版面一致性, 诚实降级
- Pattern-Key: ux.position_driven_branch_perceived_as_inconsistency
- See Also: LRN-20261101-001
---



## [LRN-20261103-002] correction

**Logged**: 2026-11-03T15:35:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
用户明确纠正：思维导图形态表（含横盘箱体表）**不是参考，是主要判定逻辑**——任何展示的判定表都必须有命中行并作为当日主判生效，全灰「参考」表被用户视为判定缺失。

### Details
20261103b 我按「统一版面+去重」方案给横盘位置补了箱体 8 形态参考表（全灰参考徽标、不构成判定，并明说了"不构成当日判定"），用户随即报"为什么一条都没命中，这些判定不是作为参考，是要作为模型的主要判定逻辑的"。根因：我把"诚实降级（无位置不硬套矩阵）"过度延伸到了"横盘也无判定"——但思维导图的箱体分支本身就是一个独立判定分支，不依赖四类位置；20261102f 的 extJudgment 优先级链（极端量能>背离>箱体>趋势运行）本来就只对四类位置开放，横盘被整体排除在外。正确做法：横盘位置（震荡整理）接入同一条优先级链，箱体分支用中性方向档位表（POS_VM_SIDEWAYS_TONE）生效为主判。

### Suggested Action
volumeEngine：extJudgment 块开放给 pos=震荡整理（极端量能/背离用 POS_VM_SIDEWAYS_EXT 中性文案，箱体用 POS_VM_SIDEWAYS_TONE 中性档位），anomaly 同步开放；前端表尾注改为「命中行高亮+主判横幅为当日唯一判定」。以后凡新增"参考表"，必须同时回答"它的命中分支在哪里生效"，纯参考表默认视为判定缺失。

### Metadata
- Source: user_feedback
- Related Files: lib/volumeEngine.js, public/js/app.js, scripts/test_pos_volume_matrix.js
- Tags: 量价判定, 箱体分支, 主判, 参考表, 横盘, 判定优先级链
- Pattern-Key: ux.reference_table_must_have_judgment_hit
- See Also: LRN-20261103-001, LRN-20261101-001
---



## [LRN-20261103-003] correction

**Logged**: 2026-11-03T15:58:00+08:00
**Priority**: critical
**Status**: resolved (20261103d)
**Area**: backend

### Summary
用户两条规则：①「指标分析」的总体判定必须由五维多数决决定（如 5 项中 3 项利空 → 总体利空），不得与维度方向打架；②环比无法直接从财报获得时，用各季报数据本地差分计算，并标明「本机计算」。

### Details
海天味业右卡「指标分析」营收增长：五维中同比(-2.33pp)/历史百分位(11%)/边际(放缓) 三维全绿利空，但徽标与「判定依据」显示红色利好——因为 judgment 直接引用 evaluateSignals，而 evaluateSignals 存在百分数口径 bug（把 DJD_TOI_YOY=0.12% 的「<1 即小数」猜测换算成 12.4%，20261103b 引入放大错误、20261102a 引入启发式）。实证勾稽：海天 Q1 +8.57% / Q2 +2.93% / Q3 +0.12% ≈ 累计 +4.27% 与 TOTALOPERATEREVETZ 完全吻合，证明东财 DJD_*/​*_TZ 字段全部是百分数。

### Suggested Action
① evaluateSignals 移除 A股字段的 ×100 猜测换算（仅美股 Yahoo 小数字段保留）；② metricAnalysis 增加五维多数决作为总体判定权威（与 evaluateSignals 冲突时显式标注），左右卡与顶栏统一消费该判定（单一数据源铁律）；③ 成长类指标环比用累计披露值差分出单季再算环比，标注「本机计算」+季节性提示。

### Resolution (20261103d 已全部落地)
① analysis.js：移除 `_revNorm` 与 `Math.abs(rgRaw/pgRaw) < 1` 启发式，A 股字段（DJD_*/ *_TZ/profitYoy/revenueYoy）直接用百分数，仅美股兜底 revenueGrowth/earningsGrowth（Yahoo 小数）×100；② metricAnalysis.js：新增 `dimsVote`（可用维度≥2 时多数方向为准：利空票>利好票→利空，反之利好，持平→中性；<2 回退原判定），输出阶段统一覆盖 judgment，冲突时 reason 前缀「五维多数决（x利好/y利空/z中性）判为X，与信号判定（Y）不一致——已按多数决为准。原判定依据：…」，`voteConflicts` 计数随返回导出；③ `sqSeries`（按年分链差分：单季=本期累计−上期累计，Q1=累计，Q4=FY−9M）+ `sqQoqDim`（环比=(本季−上季)/|上季|，跨年相邻季附季节性提示），成长三指标接入 TOTALOPERATEREVE/PARENTNETPROFIT/KCFJCXSYJLR；④ app.js 左卡 sigMap 与顶栏 renderKeyMetrics 均追加 `data.metricAnalysis.metrics` judgment 覆盖（三处消费同一判定）。守卫 scripts/test_metric_analysis_vote.js 35 断言全绿；真机验证海天：营收增长 0.12%（不再放大成 12.4%）、yoy bear、环比 -9.98% 本机计算、judgment bear 与左卡一致，voteConflicts=6（pb/ps/grossMargin 等被多数决覆盖且带显式标注）。

### Metadata
- Source: user_feedback
- Related Files: lib/analysis.js, lib/metricAnalysis.js, public/js/app.js
- Tags: 五维多数决, 环比, 本机计算, 百分数口径, 单季优先, 判定一致性
- Pattern-Key: harden.percent_unit_contract_and_dims_majority_verdict
- See Also: LRN-20261103-002, LRN-20261103-001
---


## [LRN-20261103-001] correction

**Logged**: 2026-11-03T18:20:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
手动阻力/支撑区间此前只走标准1（无放量轻松突破→无效），未接入「放量有效突破→角色反转」生命周期，导致被突破的手动阻力一直以原方向挂在清单里。

### Details
用户报障：「手动设定的阻力和支撑区间，也要遵守模块本身的有效性检验，而且阻力已经被突破，为什么还保持显示」。真机复现：平安手动阻力 53.22~53.32（MA60）于 2026-11-03 放量突破（量比 1.47>1.2）。zoneValidity 标准1 只判「无放量穿越」→ 放量突破反而判「有效」；zoneReversal 此前明确跳过 isManual → 不反转。两个机制对放量突破的手动区间都「不管」，条目就永久悬挂。深层教训：**给某类条目接入"检验"时必须接入完整的生命周期（判无效 + 状态流转），只接一半会出现两类机制都不管的真空态**。20261021e 只接了标准1，当时注释还写着"手动区间不参与反转"是合理设计，但用户的心智模型是"手动区间=同一套规则"，半接入必然引发报障。

### Suggested Action
修复（20261103h）：手动区间接入完整生命周期——priceActionHub 顺序调整（手动先于反转并入）；zoneReversal 不再跳过 isManual（反转记录带 origin:'manual'+manualId，删除时 purgeByManualId 联动清除）；前端「已反转」徽标。守卫 scripts/test_manual_zone_reversal.js 36 断言。

### Metadata
- Source: user_feedback
- Related Files: lib/zoneReversal.js, lib/priceActionHub.js, lib/manualZones.js, server.js, public/js/app.js
- Tags: zone-reversal, manual-zones, lifecycle, partial-integration
- See Also: LRN-20261101-001
- Pattern-Key: harden.full_lifecycle_integration
- Recurrence-Count: 1
- First-Seen: 2026-11-03
- Last-Seen: 2026-11-03

### Resolution
- **Resolved**: 2026-11-03T18:20:00+08:00
- **Notes**: 20261103h 落地，36 断言全绿；真机验证平安手动阻力已反转为支撑（manualZonesMeta.reversed 事件齐全）。

---



## [LRN-20261103-003] correction

**Logged**: 2026-11-03T19:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
新增与既有表同构的知识表时，键名凭显示文案重打而非从既有表复制——撞上「键名与显示名不同源」的既有约定，导致仅一个位置静默 miss。

### Details
20261103k 新增 POS_VM_STRONG（大涨/大跌强形态 24 格）时，「上涨途中」位置的键写成了显示名「上涨途中」；但 POS_VM_MATRIX/POS_VM_EXT/POS_VM_EXT_TONE 的既有键是「上涨**中途**」（_detectPosition 的 label 同），display 字段才是「上涨**途中**」。其余三个位置键名恰与显示名一致，故障表现为「仅上涨途中位置 extRef=null、extJudgment=null、summary 报位置数据不足」，其余位置全部正常——极具迷惑性，且 fail 静默（无异常抛出）。排查靠逐键码点比对（node 打印 Object.keys 的 codePointAt 序列）+ grep 定位 497 行 label='上涨中途'。

### Suggested Action
凡新增与既有对象同构的表（同键空间），键名必须以既有表为准逐字复制（最好写测试遍历断言两表键集合相等），禁止凭显示文案重新输入；若既有约定本身「键≠显示」，优先考虑在新表里同时容忍两者（或在守卫中固化键名清单）。守卫侧可加「键集合一致性」断言：POS_VM_STRONG/POS_VM_EXT/POS_VM_EXT_TONE 的 keys 必须与 POS_VM_MATRIX 完全一致。

### Resolution
- **Resolved**: 2026-11-03T19:40:00+08:00
- **Notes**: POS_VM_STRONG 键已改「上涨中途」，49 断言守卫全绿 + 真机四位置验证通过；守卫后续可补键集合一致性断言。

### Metadata
- Source: self_correction
- Related Files: lib/volumeEngine.js (POS_VM_MATRIX 1804/POS_VM_STRONG 1967/_detectPosition 497), scripts/test_pos_vm_strong.js
- Tags: 键名一致性, 显示名, 同构表, 静默失败, 码点排查
- Pattern-Key: data.structural_key_must_copy_existing_table
- See Also: LRN-20261103-002
---



## [LRN-20261103-004] correction

**Logged**: 2026-11-03T19:45:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
「在对应位置添加 X」类指令只覆盖了最近的语义组（趋势运行），漏了同类兄弟组（箱体）——用户以截图指认箱体组缺失，二次返工。

### Details
20261103k 用户要求「量能涨跌关系分析的完整推演图也在对应的位置添加大涨/大跌」，我把「对应位置」理解为「趋势运行」组（与第三步量能×涨跌幅归格直接对应），只在该组加叶子。用户随即截图箱体组报「图片里面没有大涨和大跌的添加」。根因：思维导图每个位置下有 4 个兄弟组（趋势运行/区间横盘震荡/量价背离/极端量能），「对应的位置」是复数概念，未逐组排查与确认；且 LRN-20261103-002 已确立「展示的形态必须能命中」——箱体组加了叶子就必须同步箱体分支判定（本次一并落地：横盘箱体 |chg|≥5% 优先归箱体强形态）。

### Suggested Action
凡「在对应位置添加」类指令：① 先枚举目标对象下的全部同类组（本例=趋势运行/箱体/背离/极端量能）；② 逐组决定「加/不加」并给出理由（语义适用性），拿不准的列清单向用户确认；③ 加了展示就必须同步判定分支（参考 LRN-20261103-002），二者不可拆分交付。

### Resolution
- **Resolved**: 2026-11-03T19:45:00+08:00
- **Notes**: 20261103l 落地：4 位置箱体组 + 震荡整理中性箱体均加 6 强形态叶子（8→14 条），箱体分支判定同步接入（箱体强形态优先于箱体普通格），56 断言守卫全绿 + 回归 95/99（4 项既有遗留）。

### Metadata
- Source: user_feedback
- Related Files: lib/volumeEngine.js (POS_VM_BOX_STRONG/POS_VM_EXT box/POS_VM_SIDEWAYS_BOX), public/volume-map.html, public/js/app.js, scripts/test_pos_vm_strong.js
- Tags: 思维导图, 箱体组, 覆盖面, 指令理解, 强形态
- Pattern-Key: ux.additive_instruction_enumerate_all_sibling_groups
- See Also: LRN-20261103-002, LRN-20261103-003
---



## [LRN-20261103-005] correction

**Logged**: 2026-11-03T19:58:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
参考行徽标统一写「参考」二字，把该形态的方向含义（偏多/看空/警惕/观察）整个隐藏了——用户直接问「为什么没有偏空」，信息透明度缺陷。

### Details
20261101f 着色铁律「非命中行不着方向色」落地时，扩展行（强形态/箱体/滞涨滞跌）徽标做成了统一「参考」——色是去掉了，但连方向文字也一并去掉。主矩阵行始终显示 dirText（偏多/看空/警惕/观察），扩展行却只显示「参考」，两类行口径不一致；用户看到士兰微（低位区间，6 主格恰无看空档 + 参考行无方向字）全表无「看空」，产生「模型是不是不会判空」的疑问。

### Suggested Action
非命中行的正确口径是「灰底 + 方向文字」：去掉方向色（保留 20261101f 铁律）但保留方向语义。知识条目应在数据源附 direction 字段（模型层统一映射，前端免逻辑）。向用户解释位置语义差异：低位区间的下跌形态多为「观察」（底部下跌≈尾声），看空档集中在高位区间/下跌途中——这是位置驱动的合理分化，不是缺失。

### Resolution
- **Resolved**: 2026-11-03T19:58:00+08:00
- **Notes**: 20261103m 落地：extRef 各条目附 direction，参考行显示方向文字灰底徽标 + 表尾注徽标图例。

### Metadata
- Source: user_feedback
- Related Files: lib/volumeEngine.js (extRef direction 附加), public/js/app.js (extRow), scripts/test_pos_volume_matrix.js
- Tags: 徽标语义, 信息透明度, 参考行, 方向色铁律, 位置语义
- Pattern-Key: ux.neutral_badge_must_keep_semantic_text
- See Also: LRN-20261101-001
---



## [LRN-20261104-002] correction

**Logged**: 2026-11-04T16:35:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
文案括号挂靠对象歧义：「融资余额15.7亿，净买入0.27亿（占流通市值4.46%）」括号跟在净买入后，用户读成「净买入占流通市值4.46%」，实际指融资余额占比。

### Details
capitalCharts.js 融资融券 tile 拼接顺序：余额 → 净买入 → 占比。括号注解必须紧跟其语义所属的数值。

### Suggested Action
拼接含括号注解的文案时，注解片段必须紧贴其所属数值之后再拼其他片段；同类排查点：所有 `X亿（占比%）` 模式文案。

### Metadata
- Source: user_feedback
- Related Files: public/js/capitalCharts.js
- Tags: 文案, 括号歧义, 融资融券
- Pattern-Key: harden.parenthetical_attachment_ambiguity

---

## LRN-20261104-003
**Date**: 2026-11-04
**Type**: rule_refinement
**Priority**: high
**Status**: resolved
**Area**: engine

### Summary
量价判定位置定位混乱：推演图只有四种股价定位（低位区/高位区/上涨途中/下跌途中），但新洋丰 000902 自 7 月约 11 元涨至接近 15 元（+27%，趋势运行）被判「震荡整理」，与第二步运行状态「趋势运行·上涨趋势」同屏打架。

### Details
根因：`_detectPosition` 只看 12 个月分位 + MA20/MA60——MA 粘合（13.78/13.80）+ 分位被年初高点稀释到 41.5% → 直接兜底「震荡整理」，完全不看任何趋势证据。用户给出定位原则：① 原则上只有四种定位；② 无法判定先看短期是否趋势运行；③ 短期区间震荡拉长参考时间（海天味业一年横盘、3-4 年长期下跌）。

### Suggested Action
修复模式：`_trendSegment` 近 120 日趋势段检测（自窗口最低收盘涨幅 ≥20% + 锚点距今 ≥10 根 + 期间回撤 ≤ 顺向幅度 ×60%；下跌段对称；两段同存取锚点更近者）→ `_detectPosition` 兜底前插阶梯：趋势段 → 上涨/下跌中途；无趋势段 → 长期 MA250 定论定位；两者皆无才诚实兜底。通用教训：**多指标兜底型判定不能只看单一窗口**——分位被窗口内历史极值稀释、MA 粘合期趋势证据仍在，兜底前应穷尽多尺度证据（短窗趋势段 → 长期年线）再落「无法判定」。

### Metadata
- Source: user_feedback
- Related Files: lib/volumeEngine.js
- Tags: 量价判定, 位置定位, 趋势段, 多尺度证据
- Pattern-Key: harden.position_multi_scale_evidence

---

## LRN-20261104-004
**Date**: 2026-11-04
**Type**: rule_refinement
**Priority**: high
**Status**: resolved
**Area**: engine

### Summary
威高血净（603014）专属估值模型落地时发现：专属模型接线实际是**四处**而非惯常认知的三处——`lib/ai/valuation.js` 存在**两个独立接线点**：① `hasDedicatedValuation()`（路由闸门，决定前端免 API Key）+ ② `analyzeValuation()` 主体内的**逐标的内联分支**（决定真正执行确定性计算）。漏接 ② 时标的会**静默掉进通用 LLM 流程**：不报错、不崩溃，但专属卡永不渲染（可能卡 API Key 校验或走慢速联网 LLM）。

### Details
三个既有检查点全部通过（hasDedicatedValuation=true、conclusion.js 顶部评级卡接线成功、app.js 渲染分支就位），但 E2E 调 `POST /api/ai/valuation` 返回 804ms 内无 weigao 字段 + 服务日志出现「[AI 估值] 603014 已注入财报解读摘要」= 掉进 LLM 流程的铁证。`hasDedicatedValuation` 只是布尔闸门（供前端 `this._isDedicated` 判断免 Key），真正的执行分流在 `analyzeValuation` 主体——每个专属标的一个 `try { const xModel = require(...); if (xModel.isXxxModel(bareSym)) { ... return Object.assign({}, x, {success:true, dedicated:true, ver:'DEDICATED'}) } }` 内联块。

### Suggested Action
**新增专属估值模型的完整接线清单（四处，缺一即静默失败）**：① `lib/ai/valuation.js hasDedicatedValuation()` 加一行；② `lib/ai/valuation.js analyzeValuation()` 主体加内联分支（getQuote → run → return DEDICATED）；③ `lib/deep/conclusion.js` sym 分支（顶部综合评级卡引用）；④ `public/js/app.js` `j.dedicated && j.<kind>` 渲染分支。守卫必须断言全部四处 + E2E 必须验证 `/api/ai/valuation` 返回体含专属标记字段（`ver:'DEDICATED'` / `kind:true`），仅断言源码字符串不够。通用教训：**同一文件里的「闸门函数」和「执行函数」可能是两套独立接线**——闸门通过 ≠ 执行路径接通。

### Metadata
- Source: self_discovery
- Related Files: lib/ai/valuation.js, lib/valuation/weigao603014.js, scripts/test_valuation_weigao.js
- Tags: 专属估值模型, 接线完整性, 静默降级, E2E
- Pattern-Key: harden.dedicated_model_four_point_wiring

---

## LRN-20261104-005
**Logged**: 2026-11-04T19:55:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
**轮询 + innerHTML 全量重建 = 滚动回弹**：任何「定时拉数据 → 整容器 innerHTML 重建」的卡片，只要重建发生在用户浏览期间，滚动锚定就会失效回弹——即使数据没变。

### Details
homeRank 基金行业配置名单每 3 秒轮询，render 无条件重建整卡 DOM。数据未变的轮次（大多数）也重建。修复范式：① 数据签名（JSON.stringify 所有显示相关字段）未变 → render 直接 return，DOM/滚动原样保留；② 签名变化必须重建时做滚动锚定——重建前记录主体内容容器相对视口 top，重建后差值校正回滚动容器 scrollTop。手动刷新（用户主动动作）强制重建保留视觉反馈。

### Suggested Action
**排查同类模式**：项目中所有 setInterval/轮询 + innerHTML 全量重建的卡片（首页多卡、市场页）均适用此范式；新写轮询渲染时默认带签名比对。滚动定位一律作用 .main-content（ERR-20261104-002 同源）。

### Metadata
- Source: user_feedback
- Related Files: public/js/homeRank.js, scripts/test_home_rank_scroll.js
- Tags: 轮询, innerHTML, 滚动回弹, scroll-anchoring, 数据签名
- See Also: LRN-20261104-003, ERR-20261104-002
- Pattern-Key: harden.polling_innerhtml_scroll_anchor

---

## LRN-20261104-006
**Logged**: 2026-11-04T21:40:00+08:00
**Priority**: high
**Status**: resolved
**Area**: data-caliber

### Summary
**比率型指标卡片的「主值 vs 维度」必须同口径**：右卡「指标分析」主值取 TTM（37.78%）而同比/环比维度取报告期累计口径（41.47%），用户读作「毛利率的数据不一致」——两套口径同屏展示会被当成数据错误报障，note 里的口径解释句救不了。

### Details
根因：lib/stockData.js computeTtmMetrics（TTM 单一权威源）只算了本期 TTM（grossMarginTtm）与 ROE 的去年同期 TTM（roePrev，20260909j 已有），毛利率/净利率缺 TTM prev/prevQ → metricAnalysis 的 yoyDim/qoqDim 只能回退 zyzb 累计口径（XSMLL/XSJLL），与主值口径错配。修复：marginsOf helper 抽取复用同一滚动逻辑，补 grossMarginTtmPrev/netMarginTtmPrev（去年同期 TTM）+ *PrevQ/roeTtmPrevQ（上一报告期 TTM），三指标同比/环比维度 TTM 同口径优先、不可得回退累计并保留原标注。

### Suggested Action
**通用规则**：任何展示「主值 + 对比维度」的卡片，维度取数必须与主值同源同口径；新增 TTM/滚动类主值时必须同步补齐「去年同期/上一披露期」的同口径对比值（roll 函数窗口复用同一 helper），而不是拿报告期累计序列凑数。同口径排查要覆盖同类全部指标（本次毛利率/净利率/ROE 三个一起修，不只修用户报的毛利率）。

### Metadata
- Source: user_feedback
- Related Files: lib/stockData.js, lib/metricAnalysis.js, scripts/test_margin_caliber_rename.js
- Tags: 口径一致, TTM, 指标分析, 数据一致性
- Pattern-Key: harden.metric_dims_same_caliber_as_primary

---

## LRN-20261105-001
**Logged**: 2026-11-05T11:35:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: data-caliber

### Summary
**整齐极端值的镜像案例：极端值也可能是真的**——上证50「近5年百分位 99%」被用户质疑计算错误，实测当前 PE 11.72 恰为近5年窗口最高值，99% 数学正确（中位排名法 (60+0.5)/61）。真正的问题是中位排名法对最高点永远显示不出 100%，裸 99% 触发「假数据」怀疑。

### Details
判读路径：① 读缓存重算——61 个月度点（乐咕乐股），60 个低于当前、0 个高于，重算 99% 与显示一致 → 算法无误；② 双链交叉——东方财富日频 PE 11.79（同量级）、3年百分位 89.68%~90.51%（同处高位区）→ 数据可信；③ 图形自洽——曲线右端正是全图最高点。根因 = 展示歧义而非计算错误。

### Suggested Action
修复（20261105a）：当前 PE = 窗口最高（series.every(d => d.pe <= latest.pe)）时显示「近5年新高（百分位 99%）」替代裸 99%。**通用规则：报障判读「整齐极端值」时先重算 + 双链交叉再下结论，极端值与假 0 一样可能是真的；若为真且表述易误读，改表述（加语义标注）而非改算法**。

### Metadata
- Source: user_feedback
- Related Files: lib/indexPETrend.js, public/js/app.js, scripts/test_index_pe_window_high.js
- Tags: 百分位, 中位排名, 极端值判读, 双链交叉验证
- See Also: 工作区记忆「用户报障判读惯例」（0.00 亿/0 只类假 0）
- Pattern-Key: harden.extreme_value_verdict_dual_chain

---

## LRN-20261105-002
**Logged**: 2026-11-05T11:50:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
**用户纠正（correction）：「近5年新高」方案被否，改用「历史百分位」全历史口径**——20261105a 的语义标注方案（近5年新高 99%）没有解决用户对刺眼数字的本能不适；用户给的是东方财富估值页参照（PE百分位 60.63%，注：百分位数基于全部历史数据得出），期望的是**更长时间窗口下的温和口径**。

### Details
近5年窗口太短（乐咕月度 61 点），窗口内最高点百分位必然 99%；而全部历史窗口（上证50 乐咕 263 点、2005 年起）包含 2007/2015/2021 大顶，当前 11.72 只处于 67% 位置——与东财全部历史口径 60.63% 同量级。方案：乐咕接口本身返回全历史月度序列，脚本输出 seriesAll（科创50 东财抓取起点提前至 2019），服务端算 quantileAll，前端显示「历史百分位 X%」。同时按用户指令新增中证1000（乐咕同源，2014-10 起 146 点）四指数对称展示。

### Suggested Action
**估值分位类展示默认用全历史口径**（「历史百分位」），短窗口百分位只作辅助参考；用户报「数字刺眼/可疑」时，除验证真假外还要考虑窗口选择是否合理——更长的窗口往往给出更符合直觉的数字。

### Metadata
- Source: conversation (user correction)
- Related Files: scripts/index_pe_trend.py, lib/indexPETrend.js, public/js/app.js, public/js/charts.js, public/css/style.css
- Tags: 历史百分位, 窗口选择, 中证1000, 对称布局
- See Also: LRN-20261105-001（99% 真实性判读）
- Pattern-Key: harden.valuation_quantile_full_history_window

---

## LRN-20261106-001
**Logged**: 2026-11-06T00:10:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
**误判「死分支」（correction + knowledge_gap）**：20261105j 汇报称 capitalFlow 的 `POS_VP_DESC`/`VP_POS_OVERRIDE`/`computeCapitalConclusion` 里 `'上涨中途'/'下跌途中'` 在 D2 后是「永不命中的死分支」；用户追问能否删除后复核发现**完全相反——它们是仍在生效的活路径**。

### Details
D2 删除的只是判定卡那套 `POS_VM_*` 知识表；`computeVolumeEngine` 内部的 `_detectPosition`（lib/volumeEngine.js:552-596）仍在运行并产出旧四类标签（低位区间/高位区间/上涨中途/下跌途中/震荡整理），经 3212 行 `position.label` 输出。`capitalFlow.js:872` 与 `sameDayJudgment.js:1682` 都从 `volumeEngine.position.label` 取值，因此旧键正常命中。新三分区（高位/中位/低位区间）只存在于新判定链 `_posVolumeMatrix` 返回的 `pj.position`（2359-2366）——**是另一个对象**。
实测 `cf.vpPositionSignal`：`缩量上涨@上涨中途 = +0.4` vs `@中位区间/无位置 = -0.25`（偏多翻偏空）；`地量上涨 +0.2 vs -0.15`；`放量下跌 -0.7 vs -0.45`；`巨量下跌 -0.8 vs -0.6`。`test_volume_engine.js:137` 断言 `pos.label === '上涨中途'` 且全量回归通过，本就是「旧标签仍存活」的现成证据，当时未追查。

### Suggested Action
判断某键/分支是否为死代码，**必须追到该值的上游值域**（谁产生、有哪些取值、是否有测试断言），不能凭「新标准已上线 / 旧表已删」推断。删除前用导出的纯函数做一次「命中 vs 不命中」实测对比；分值或文案有差异就不是死分支。本例正确结论：不是删死分支，而是「两套位置标签并存」的口径分叉（清单 W1），统一需用户裁决且会改变结论。已同步纠正 server.js [20261105j] 注释、工作日志与 MEMORY.md 中的错误表述。

### Metadata
- Source: conversation (user question: 「永不命中的死分支能不能删除，会有什么影响」)
- Related Files: lib/capitalFlow.js, lib/volumeEngine.js, lib/sameDayJudgment.js, scripts/test_volume_engine.js
- Tags: 死代码判读, 位置标签, 口径分叉, D2, W1
- See Also: LRN-20261105-003（20261105h 误判 latestVsPriorAvg 为死代码）
- Pattern-Key: simplify.dead_code
- Recurrence-Count: 2
- First-Seen: 2026-11-05
- Last-Seen: 2026-11-06

### Resolution
- **Resolved**: 2026-11-06T01:10:00+08:00
- **Notes**: 清单 W1 已于 20261106a 完成：两条 position 链统一为三分区，旧四类标签与旧方向规则整体退役，守卫 `test_position_unified.js` 固化，全量回归 105/105。

---



## [LRN-20261106-002] best_practice

**Logged**: 2026-11-06T11:50:00+08:00
**Priority**: high
**Status**: resolved
**Area**: frontend

### Summary
同屏「20日量价比 1.19」与「量比(20日) 1.07」被读成同一指标而报「数据不一致」，实为两个不同公式；判读前必须先还原「标签 × 公式 × 数据源」三要素。

### Details
用户截图（000902 新洋丰，2026-11-06 11:43 盘中）报障。实时 API 数值闭环：
- `volumePrice.ratio = 1.19` = `avgUpVol(122275) / avgDownVol(102440)`，即近 20 日**上涨日均量 ÷ 下跌日均量**（`lib/capitalFlow.js:315-318`，抗脉冲截尾），前端标签「20日量价比」（`public/js/app.js:2450`），与量价判定「⑤ 量价健康度：上涨日均量为下跌日 1.19 倍」（`lib/volumeEngine.js:1819-1833`）同源同值。
- `posJudgment.volume.ratio20 = 1.07` = `volToday / avg20`（`lib/volumeEngine.js:280`），即**当日成交量 ÷ 前 20 日均量**，用于 135 格量能归格（0.8~1.3 → 平量），前端标签「量比(20日)」（`public/js/app.js:2547`）；与 `capitalFlow.unified.ratio20 = 1.07` 一致，两条数据链无冲突。
- 两者公式不同且都算对了，**不是数据 bug**。根因是「20日」「量比」字样高度重合，加上卡片底部注释「量比与量能档位同源，不重复展示」（`app.js:2453`）口径描述错位——该注释指的是当日量比，卡片显示的却是涨/跌日量能比。
- 次要放大因素：11:43 盘中 `volToday` 是半天累计且未做时间归一化，`ratio20=1.07` 约为全天预估的一半；而 `dayVolRatio=2.13`（`capitalFlow.js:337-340` 乘 `intradayVolFactor≈2`）与 `unified.ratio5=1.58`（腾讯直采量比）已归一化。页面已有「盘中停判」徽标，第三步「平量」是临时结论。

### Suggested Action
1. 报障「两个数字不一致」时，逐个追到赋值语句还原公式，用实时 API 把同屏相关字段一次性列出，禁止先假设数据链出错或改数。
2. 修 UX 优先改标签/注释而非数值：把「20日量价比」改名为「20日涨跌日量能比」并加公式说明；把「量比(20日)」写成「当日量/20日均量」；修正底部「不重复展示」注释。数值与判定逻辑零改动。
3. 若要动 1.07 的盘中归一化，会改变 135 格归格结论，必须单独评估并升版本戳，不可顺手做。

### Metadata
- Source: conversation (user screenshot question: 「图中两个20日量比数据不一致是为什么？」)
- Related Files: public/js/app.js, lib/capitalFlow.js, lib/volumeEngine.js
- Tags: 口径分叉, 量比, 标签歧义, 盘中折算, 数据一致性
- See Also: LRN-20261030-001（同名财务指标不同报告期）, LRN-20261019-006（量比定档与市场标准矛盾）
- Pattern-Key: diagnose.same_name_different_caliber
- Recurrence-Count: 2
- First-Seen: 2026-10-30
- Last-Seen: 2026-11-06

### Resolution
- **Resolved**: 2026-11-06T12:05:00+08:00
- **Notes**: 用户终裁「方案 A：只改标签和注释，零数值风险」，已落地 20261106b。① 卡片标签「20日量价比」→「20日涨跌日量能比」+ title 公式说明；② 第三步「量比(20日)」→「当日量/20日均量」+ title 公式与盘中提示；③ 底部注释改为显式列出三套口径并写明「数值不应相等」，删除错位旧注释；④ `public/js/capitalCharts.js` 兼容渲染路径同步改名（同类排查发现的第二处）；⑤ `scripts/test_volume_merge.js` 断言同步，新增 `scripts/test_volume_ratio_labels.js`（26 断言）固化「文案与口径分离」。数值/公式/判定逻辑/引擎 schema/LAYOUT_VERSION 全部零改动；APP_VERSION 与 5 个 HTML ?v= 升 20261106b。全量 quick 回归 106/106、实时 HTTP 验证通过。

---



## [LRN-20261106-003] correction

**Logged**: 2026-11-06T15:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
20261105f 新增的「135 格主判」未接入引擎既有的「量价信号/量能热度/资金行为三处同源」铁律，
导致同一天同一只股票在量能分析模块里出现互相矛盾的量价关系判定结论。

### Details
用户三张截图（2026-11-06 15:20 / 15:21 / 15:32，同一标的、当日 +2.08%）：
- ①「资金量能综合判断 · 量价关系」：`温和上涨 — 当日 +2.08%，量能平量（当日量÷前5日均量 1.2 倍，
  60日均量口径确认为「放量」3.26 倍），平量上涨，涨势平稳但动能一般`
  → `lib/capitalFlow.js computeVolumeIndicators` 的 `volumePrice.signal/description`，
    `volBucket` 来自 `opts.unifiedTier`（=`volumeEngine.volumeTier`，定档用 `ratio5` ÷前5日均量）。
    前端渲染 `public/js/capitalCharts.js:704`（`${vp.signal} — ${vp.description}`）。
- ②「量价判定 · 主判」：`放量 + 上涨（当日量/20日均量 2.63）` → `主判·偏多 健康主升，增量资金进场，趋势延续性较好`
  → `lib/volumeEngine.js:2084 _posVolumeMatrix` → `_volTier5`（`lib/volumeEngine.js:1898`，
    **用 `pc.ratio20` ÷20日均量，阈值 >1.3 放量**）→ `volCell()` → `lib/posModel135.js:222` 的 conclusion。
- ③「资金行为」：`量平价升：…没有增量资金大举进场…弱需求上涨、持续性存疑；只作观察`
  → `lib/volumeEngine.js:1008` 的 conclusion（用 `pc.ratio5` 的 amplified/shrunk 分支），
    前端 `public/js/app.js:2451` 的 `dim.capitalBehavior`。

①③ 同源（`ratio5`，判平量上涨，语义一致）；②另用 `ratio20` 判放量上涨，
于是「增量资金进场 / 健康主升」与「没有增量资金大举进场 / 持续性存疑」**直接互斥**。
`lib/volumeEngine.js:162 / 308 / 3003` 的注释明确写过「引擎资金行为三处结论同源，杜绝同屏互斥」
（都走 ratio5），但 20261105f 引入 135 格主判时没有把新层接入这条既有约束，形成口径分叉。
注意这与 LRN-20261106-002 的「同名不同数值、都算对」不同：这次是**两套量能分母派生出两套定性结论**，
用户明确要求「要统一，整个模块不应该出现不一样的量价关系判定结论」。

### Suggested Action
1. 先向用户确认统一到哪个口径再动代码（改动会波及 135 格全部归格、推演图、sameDayJudgment
   量价配合子因子、判断记录 LAYOUT_VERSION 与大量守卫基线，属重大改动，禁止擅自决定）：
   A 统一到 `ratio5`（工作台既有唯一量能真值源，135 格归格全变）；
   B 统一到 `ratio20`（135 格现行口径，老三卡量价信号与资金行为全变）；
   C 判定数值全不动，只把同屏收敛为一个「今日量价关系判定」结论 + 显式标注两套分母用途。
2. 无论选哪个，必须补「三处结论语义一致性」守卫：遍历 15 种 `volumePrice.signal` × 三分区 ×
   三量能档，断言同屏不出现「增量资金进场」与「没有增量资金」并存。
3. 新判定层接入时，先 grep 项目里既有的「单一真值源 / 同源」注释与铁律并显式接线，不能另起一套分母。

### Metadata
- Source: conversation (user screenshot: 「图片的模块结论不一样，是不是使用了不同的逻辑判定，如果是要统一」)
- Related Files: lib/volumeEngine.js, lib/posModel135.js, lib/capitalFlow.js, public/js/app.js, public/js/capitalCharts.js
- Tags: 结论互斥, 量能分母, 135格, 单一真值源, 跨模块一致性
- See Also: LRN-20261106-002（同名不同口径）, LRN-20261104-005（比率主值与维度同口径）
- Pattern-Key: harden.new_judgment_layer_must_join_existing_single_source
- Recurrence-Count: 1
- First-Seen: 2026-11-06
- Last-Seen: 2026-11-06

### Resolution
- **Resolved**: 2026-11-06T16:10:00+08:00
- **Notes**: 用户裁决「只统一结论展示（方案 C）」，已落地 20261106i，判定逻辑与数值零改动。① 唯一结论出口 =「资金量能综合判断」卡的量价关系行，标签改「今日量价关系判定（唯一结论）」，文本仍是 `vp.signal — vp.description`；② `lib/posModel135.js` 两处 conclusion 去掉「增量资金进场」（中位→「健康主升，量价配合，趋势延续性较好」；低位→「底部启动信号…」），`public/volume-map.html` 两处按 20261105f 同源契约逐字同步；③ `public/js/app.js`「主判 ·」改称「135 格综合判定 ·」，新增常驻口径说明（135 格 ÷20 日均量 / 量价关系与资金行为 ÷前5日均量，两套分母用途不同、数值不应相等，量价关系判定以「资金量能综合判断」为唯一结论）；④ 数值 / 公式 / 评分 / 判断记录 / API 结构 / 引擎 schema / LAYOUT_VERSION 全部零改动。守卫 `scripts/test_vp_conclusion_unified.js`（43/43，含 15 种 signal 值域真实调用 `buildConclusionParts` 遍历、135 格全遍历断言归格 key 不变、引擎-推演图同源抽查）；全量 quick 回归 111/111、退出码 0。另记一次已知铁律复发：版本戳脚本盲扫把 `test_posj_symmetry.js` 里作为功能引入戳的 `20261106h` 误升为 `i`，导致 2 条断言假失败，已逐条回正。
- **Escalated**: 20261106j 用户进一步裁决「引擎级彻底合并」，根因修复超越方案 C：`volumeTier.tier` 重写为 ÷20 三态（与 135 格 `_volTier5` 同源，`_volumeTier` 阈值 放量>1.3/平量0.8~1.3/缩量<0.8），7.4/11.3/预期量能/7.5 四张归集卡删展示+删 API 输出（评分函数体保留）；生死位五规则卡暂留。三条新增教训：① **升 LAYOUT_VERSION 前必须 grep 子因子消费链**——`sameDayJudgment` 量价配合子因子经 `unifiedTier` 间接受分母影响（同日数据「平量上涨」→「放量上涨」改判，vpSigMap 分值变化），哈希不捕获，差点漏升；② API 输出已删的 summary 字段，守卫一律改调 `_buildSummaries`/`_expectedVolumeRules`/`_contradictionRules` 导出函数直接复算，不另造数据；③ tier 已是确定三态值域时守卫直断字面值、不过方向映射函数（`tierDir` 旧正则按 ÷5 六态词写，÷20 三态下出现独立复算与守卫环境不一致的幽灵失败）。全量回归 124/124、退出码 0。

---

---



## [LRN-20261106-004] correction

**Logged**: 2026-11-06T21:55:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
20261106j「量能分母统一 ÷20」漏改 `_comboEngine` 的 amplified/shrunk（仍用 ratio5>1.2/<0.8 旧 ÷5 链），
用户截图抓出同屏互斥复发（LRN-20261106-001 同类：两条链并存、下游读旧链）；
「该放量未放量」判定门（÷5 非大量/天量即命中）与 ÷20 主基准互斥是第二个分叉根因。

### Details
- j 轮只改了 `_volumeTier`/135 格 `_volTier5`/capitalFlow unifiedTier，未 grep 全引擎比较点字面量（>1.2/<0.8/>1.3）。
- n 轮修复：`_comboEngine` amplified=`ratio20>1.3`/shrunk=`ratio20<0.8`（huge 极端档保留 ÷5）；
  「该放量未放量」门改 `ampOkUnified = ratio20 > 1.3`（放量即「量能跟上」不命中）；命中文案改 ÷20 措辞。
- 顺带完成用户裁决：avg60/confirm/_confirmDesc 引擎级整体退役（审计确认全部消费点均为放量/缩量判定性质），
  基准全改 ÷20（×1.5/×0.7 阈值不变），schema → volume-engine-20261106n；LAYOUT_VERSION 保持 j（sameDayJudgment 不消费 combo/confirm）。
- 真机验证：600460 量价关系=显著下跌（÷20 0.88 平量）与资金行为 combo=「平量下跌」同屏一致，互斥消除。

### Suggested Action
**凡「统一口径/统一分母」类改动，必须 grep 全引擎阈值字面量与旧口径字段引用（含 combo/四维度/riskTag/相位规则），
列出全部比较点清单再动手；新判定层接线前先 grep「单一真值源/同源」注释（LRN-20261106-003 同源铁律）。**

### Metadata
- Source: conversation (user screenshot ×3: 「量能的判定还是有大量的不一致，可见之前几个任务的修改有明细的漏洞」)
- Related Files: lib/volumeEngine.js, lib/capitalFlow.js
- Tags: 分母统一, 漏改复发, 同屏互斥, 阈值字面量扫描, 60日口径退役
- See Also: LRN-20261106-001（双 position 旧路径复发）, LRN-20261106-003（同源铁律）, LRN-20261109-006（第 3 次复发：异常特例层规则3 漏网 + 基准跨期不可比）
- Pattern-Key: harden.caliber_unification_must_scan_all_comparison_sites
- Recurrence-Count: 3
- First-Seen: 2026-11-06
- Last-Seen: 2026-11-09
- Last-Seen: 2026-11-06

### Resolution
- **Resolved**: 20261106n 落地，全量回归 124/124、退出码 0；守卫层面 test_volume_confirm_label 整文件重写（23/23）、
  volume_engine(301)/consistency(230)/unit_contract(28)/vp_conclusion_unified(46) 全绿。

---



## [LRN-20261106-005] best_practice

**Logged**: 2026-11-06T21:58:00+08:00
**Priority**: medium
**Status**: active
**Area**: tooling

### Summary
三条工程教训：① 守卫版本戳批量升级时负断言必须指向「上一版」并用占位符保护（m 轮曾把
`!html.includes('?v=20261106l')` 一并升 m 造成自相矛盾）；② `curl | python - <<EOF` 会拿空 JSON
（heredoc 与数据抢同一个 stdin），检验脚本必须 Write 落盘后 `curl | python 文件`；
③ fixture 造数前先探测引擎实际值——avg20 不含当日，地量线 0.5×avg20 与脉冲前后缩量 0.7×avg20
都吃 avg20 基准，必须抬高前段量能才能造出「后段地量」场景（n 轮场景1/2/4 fixture 重造实证）。

### Details
- 负断言占位规则：批量脚本先替换正断言为新版本号，负断言目标改为「上一版」字符串，用后即删。
- stdin 冲突：`python -` 从 stdin 读脚本后 sys.stdin 已到 EOF，json.load 拿到空 → JSONDecodeError。
- fixture 数学约束实例：场景2 目标 ratio20≈1.22 平量 + lowVolDays≥6 → 249:100/250-255:30/256-258:200/259:115。

### Suggested Action
守卫批量升级脚本沿用 n 轮范式（占位符保护+跳过 section(/注释/功能戳行）；
API 文案检验一律落盘脚本；改口径后造 fixture 先跑探测脚本核对引擎实际中间值。

### Metadata
- Source: conversation (n 轮实操)
- Related Files: scripts/test_volume_engine.js, scripts/test_vp_conclusion_unified.js
- Tags: 守卫维护, 批量升级, stdin 冲突, fixture 设计
- Pattern-Key: tooling.guard_batch_and_fixture_probe_discipline
- First-Seen: 2026-11-06
- Last-Seen: 2026-11-06

---



## [LRN-20261106-006] correction

**Logged**: 2026-11-06T23:10:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
跨模块「判定一致」类改动只统一了单一维度（量能）而漏掉其余维度（涨跌判定/运行状态）——
n 轮统一量能分母后，用户截图立刻抓出「唯一结论行缩量上涨 vs 135 格缩量+震荡」的涨跌幅档分叉
（旧 ±0.05% 符号二分 vs `_walkTier5` 五档）。这是同源铁律的第四个维度缺口。

### Details
- 量价判定共四维：位置（i 轮已接线 position.label）、量能（j/n 轮已统一 ÷20）、运行状态（o 轮经 cell.conclusion 直引补齐）、涨跌判定（o 轮改消费 posJudgment.price.walk）。
- 修复时曾把 bigUp/bigDown 3%→5% 对齐「大涨档」，被 test_volume_price_signal_wiring 的圣湘生物案例抓出：
  用户 20260921c 已裁决 ≥3% 平量涨=中性「大涨平量」——同名字「大涨」不同概念（文案分级线 vs 归格线），不强行对齐。
- 事故：python 正则替换 server.js 超长单行 APP_VERSION 说明，`(.*?)\n` 吞掉下一行 app.use 进注释行尾 → SyntaxError。

### Suggested Action
**「判定一致」类改动必须先列全维度矩阵（每一维：判定输入从哪来、消费方是谁、阈值在哪定义），逐维接线；
同一中文词（大涨/震荡）在不同模块可能是不同概念，对齐阈值前先查该词是否有用户实测定案。**
替换超长单行后必须 `node --check`；批量升版 skip 规则要先跑全量回归抓同模式断言漏网。

### Metadata
- Source: conversation (user screenshot: 「除了量能，股价定位，运行状态和涨跌判定也必须一致」)
- Related Files: lib/capitalFlow.js, lib/volumeEngine.js, public/js/capitalCharts.js, lib/sameDayJudgment.js, server.js
- Tags: 四维同源, 走势档, 符号二分, 语义同名异, 版本戳事故
- See Also: LRN-20261106-004（分母统一漏改复发）, LRN-20261106-003（同源铁律）
- Pattern-Key: harden.multi_dimension_unification_matrix
- Recurrence-Count: 2
- First-Seen: 2026-11-06
- Last-Seen: 2026-11-06

### Resolution
- **Resolved**: 20261106o 落地：涨跌判定消费 posJudgment.price.walk，震荡档 5 种中性信号（VP_POS_BASE 0 分），
  desc 直引 cell.conclusion；全量 124/124、退出码 0；3018 真机 601318 两处 PASS 同屏一致。



## [LRN-20261106-007] best_practice

**Logged**: 2026-11-06T15:35:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary
「截图数值与实测不符」的诊断纪律：三路实测（独立重算 + 现役实例 API + 聚类明细对照）全部健康后才可定性为「陈旧异常态」，禁止无法复现时臆造根因。

### Details
p 轮诊断 601318 资金量能卡「关键支撑 21.85/压力 26.02」（距现价 -60%）：探测脚本重算 priceActionHub 快照（区间全在 46~62）→ 3005 现役实例 /api/capital-flow 实测（支撑 53.22/压力 56.78）→ 快照区间明细逐条对照（无 21~26 区间）。三路全健康 → 定性为截图时的陈旧异常态（页面未硬刷新或快照缓存瞬时坏值），已自愈。注意：现役实例每请求实时重算（无服务端缓存），陈旧态只能来自前端渲染或当时的瞬时快照坏值。

### Suggested Action
遇截图值与实测不符：① 先跑独立重算探测；② 查现役实例 API（注意该链路无服务端缓存，每请求实时重算）；③ 三路一致健康 → 定性陈旧态并建议用户重启+Ctrl+F5，勿臆造根因；④ 若仍不可复现，请用户复现时保留现场（不刷新）再抓快照。

### Metadata
- Source: conversation
- Related Files: lib/priceActionHub.js, lib/zoneLevelsHint.js, lib/capitalFlow.js
- Tags: 诊断纪律, 数据一致性, 陈旧缓存
- See Also: LRN-20261106-005

---



## [LRN-20261106-008] correction

**Logged**: 2026-11-06T15:35:00+08:00
**Priority**: high
**Status**: resolved
**Area**: tests

### Summary
批量升版 sed 的三个盲区：① 元断言守卫（test_pos_vm_strong 遍历断言**其他守卫文件**含版本字符串）必须同步；② 复合引号字符串 `'homeRank.js?v=20261106o'` 不被 `'20261106o'` 单引号模式命中，需 `?v=20261106o` 复合模式补刀；③ 断言消息文本（'缓存戳全部对齐 20261106n'）是陈旧 n 文案，升级时一并回正避免误导。另：Bash 工具内 `cmd &` 分离的后台服务会随命令结束被回收（表现为代理 502「目标计算机积极拒绝」），长驻服务必须用 run_in_background。

### Details
p 轮全量回归首轮 10 文件红：缓存戳断言 o（文件已 p）+ 消息文本仍写 n（o 轮 skip 遗留）+ 元断言未同步。三轮 sed 修复：排除 LAYOUT_VERSION 行（LAYOUT 保持 o）→ 裸正则 /20261106o/ → 复合 ?v= 模式 → 消息文本模式（应为/已对齐/同步至/已同步/版本戳=/缓存戳全部对齐）。历史注释（「20261106n：60 日口径删除」等）保留不动。

### Suggested Action
批量升版 sed 后必跑全量回归（退出码判定）；sed 模式清单固定为：排除 LAYOUT 行的引号模式 + 裸正则模式 + ?v= 复合模式 + 消息文本五模式；新守卫落地时消息文本与断言同版。

### Metadata
- Source: conversation
- Related Files: scripts/test_pos_vm_strong.js, scripts/test_dashboard_ui_d.js, scripts/run_all_tests.js
- Tags: 批量升版, sed盲区, 元断言, 后台进程
- See Also: LRN-20261106-005
- Pattern-Key: harden.batch_version_bump
- Recurrence-Count: 2
- First-Seen: 2026-11-06 (o 轮 skip 误伤)
- Last-Seen: 2026-11-06

---



## [LRN-20261109-001] correction · 「卡片少了一张」≠ 代码删了卡片：先查数据状态再查 git

**Logged**: 2026-11-09T11:46:24+08:00
**Resolved**: 2026-11-09（数据修复落地 + 接口/渲染/幂等三重验证通过）
**Priority**: high
**Status**: resolved
**Area**: frontend / data-source

### Summary
用户截图质疑「宽基 ETF 页面是不是少了一张统计个股申赎数量合计的卡片」。实证结论：代码从未删除任何卡片（本次同步 `4374127` 完全未触及 ETF 文件，独立页自 20261025p 起区块结构固定 7 块）；真实原因是 `baselineOnly=true` 使 `stocks:[]` / `groups:[]`，前端 `if (stocks.length)` / `if (groups.length)` 把「家族汇总卡」「被买/被卖 Top10 双列卡」「全部成分股累计表」**整块条件隐藏**，用户感知为「卡片消失」。

### Details
1. **VM 实证**（把线上 `/api/etf-flow` 真实响应喂给 `public/js/etfFlowPage.js` 的 `render()`）：概览条/趋势图/ETF 明细表/口径说明显示；家族汇总卡、Top10 双列卡、全部成分股累计表隐藏；合计净申赎额降级为一句 reason 文本。截图里 ETF 表后三列（份额变动/篮数/净申赎额）全「—」正是同一状态。
2. **数据层根因**：`data/etf-flow/20261106.json` 是残缺快照（仅 7 只 ETF，应为 34），`savedAt=2026-11-07T03:06`（周六凌晨跨日补采），`shareDate` 被前推为 `20261106`（正常 T+1 应为 `20261105`）；`20261109.json` 的 `shareDate` 也是 `20261106` → 本期与基期份额披露日相同 → Δ 无法算 → `baselineOnly:true`、`reason="份额披露未跨日…"`。与 `scripts/restore_etf_20261030.js` 记录的「节假日跨日重采覆盖」同类事故。
3. **历史核对**：`bcb3415`/`e98255c`/`2783284`/`1f6ac5a` 四版 `etfFlowPage.js` 区块标题恒定；CSS 中 `.etf-*` 类无「个股合计卡片」孤儿样式；全项目 + git 全历史 `-S` 搜「申赎数量/个股合计/成分股合计/个股统计」仅在文档与测试注释中出现。**独立页从来没有一张叫「个股申赎数量合计」的独立卡片**。最接近的是「全部成分股累计」表与「被申购/被赎回最多的成分股」Top10；首页 ETF 因子卡则有「净申购 X 亿 · N 只净申购 / M 只净赎回」（统计的是 ETF 只数，非个股）。
4. **20261023a 线索**：`docs/logic/home-10-etf-flow.md:103`、`scripts/test_etf_card_layout.js:7` 记载 20261023a 曾把 ETF 因子卡做成「整行宽 + 卡内三页签（个股/ETF 内嵌）」含「个股统计」，用户当日报「卡片布局全乱」，20261023b 已回滚并把个股统计迁到独立页；该中间态未进 git。用户记忆中的「统计个股申赎数量合计的卡片」很可能指这一版，或指首页因子卡里的只数合计。

### Suggested Action
待用户确认后二选一（勿擅自改）：① 修数据事故——按 `restore_etf_20261030.js` 同法重建 20261106 快照的 `shareDate`/份额并补回 34 只，使 Δ 恢复，卡片自然回来；② 改展示——`baselineOnly` 时把被隐藏的 3 个统计区块渲染为「暂无数据 + 原因」的占位卡，避免「整块消失」被误读成功能被删（与 LRN-20261021 系列「被过滤 ≠ 被隐藏」同构）。

### Resolution（2026-11-09 已落地）
用户经确认选择「全部成分股累计表」+「修数据，让卡片回来」；备选 ②（baselineOnly 占位卡）**未选择、未实施**。新增一次性恢复脚本 `scripts/restore_etf_20261106.js`（前置事故指纹校验 / `--dry-run` / 备份 / 幂等），**业务代码零改动**，只改 2 个数据文件：
1. **快照**：`20261106.json` 如实标 `partial:true / settled:false` + `gaps`/`restored` 溯源，**份额数字一个没动**；基期自动回退到完整定稿的 `20261105.json`（34 只，shareDate 20261104）。
2. **台账：没有重置重放**（本次最关键的新认知）。`KEEP_DAYS=10` 已滚动删掉 10-26 之前快照，`ledger.backup-20261026.json`（days=3 / lastDate=20261022）证明台账含只存在于 `cum` 里、无法从现存快照重建的早期合法累计；照抄 `restore_etf_20261030.js` 的「重置 + 重放」会把 days 11 压成 7，等于**静默丢掉合法历史 = 制造新事故**。改为**精确撤销最后一次污染入账**：用修复前的 20261106 调 `computeFromSnapshots('20261106')` 复现当日 stockAgg（94 只逐股，买 1816.96 万股 / 卖 −1657.45 万股），逐股从 `cum` 扣回，`days 11→10`、`lastDate 20261106→20261104`，`cum` 键数 1732 **不变**（保全全部历史）。
3. **结果**：`/api/etf-flow` 恢复 `baselineOnly=false`、etfs 34 / stocks 1732 / groups 5 / totalNet 18.20 亿、`ledgerDays=10`；`gaps` 自动带出「基期披露日 20261104 与本期 20261106 不相邻，净申赎为多日合计值」诚实披露；VM 沙箱用真实响应跑 `render()`：家族汇总卡、ETF 明细表、Top10、**全部成分股累计表（台账 10 个交易日）**、多日合计披露、数据缺口条带全部显示，基线日降级提示消失。
4. **幂等 + 自纠**：第 2 次运行自动跳过快照重写与台账撤销，无重复扣减；由此发现并修复「二次运行覆盖事故前备份」缺陷（备份改为绝不覆盖 + 用逆运算重建事故前台账；重建件与 11-03 历史台账 1732 只累计单调性核对 0 违反）。

### Best Practice（比占位卡更普适）
**在快照会滚动清理的系统里做数据修复，先查 `KEEP_DAYS` 与历史台账备份，分清「合法历史」与「污染增量」，再决定「重建」还是「精确撤销」**——旧恢复脚本的「重置 + 重放」只在快照链完整时成立，切勿照抄。另：一次性恢复脚本必须做到「备份绝不覆盖」，否则幂等复验会把唯一可回滚的原件冲掉。

### Metadata
- Source: user_feedback
- Related Files: public/js/etfFlowPage.js, lib/etfFlow.js, server.js:1184, scripts/restore_etf_20261106.js, data/etf-flow/20261106.json, data/etf-flow/20261109.json, data/etf-flow/ledger.json, data/etf-flow/backup/, docs/logic/home-10-etf-flow.md
- Tags: 条件渲染, baselineOnly, 跨日补采, shareDate, 卡片消失, 诚实披露, KEEP_DAYS, 台账污染, 精确撤销, 幂等恢复
- See Also: LRN-20261022-007
- Pattern-Key: harden.conditional_render_placeholder

---



## [LRN-20261109-002] correction · 完整性判据不能锚定「当次名单」：上游静默缩水会让守卫双边同时失效

**Logged**: 2026-11-09T12:26:52+08:00
**Resolved**: 2026-11-09（A+B 根修落地 + 25/25 单测 + 全套 ETF 回归无新增失败）
**Priority**: critical
**Status**: resolved
**Area**: data-source / guard

### Summary
追查「出问题的原因能不能保证不再出现」时实证复现了 LRN-20261109-001 的**真正根因**：不是 PCF 抓取失败，而是 `selectUniverse()` 的上交所分类名单查询部分失败被 `catch (e) { byCls[cls] = []; }` **静默吞掉**，名单从 34 缩到 7；而 `collect()` 的残缺判据是 `partial = okPcfs.length < universe.length`，分子分母同时缩水 → `partial=false` → 残缺快照被标成 `settled:true` 且无 `partial` 字段。**该漏洞至今仍在代码里，同类事故无法保证不再出现。**

### Details
1. **实证复现**（临时目录注入 7 只 universe + 假 PCF/份额）：产出快照 `{date:20261106, shareDate:20261106, settled:true, etfs:7, 无 partial/gaps}`，字段结构与事故原件 `backup/20261106.partial-mislabeled.json` **指纹完全一致**。
2. **家族分布铁证**：事故 7 只 = 上证50 4 + 科创50 3；完整 34 只 = 沪深300 20 + 上证50 4 + 中证500 4 + 中证1000 3 + 科创50 3。缺的 27 只正好是 `cls='03'` 全部（`GROUPS` 里 csi300/csi500/csi1000 的 `cls:['03']`）。即 11-07 03:06 那次只有 `cls='01'`/`cls='09'` 查询成功。
3. **同类事故已复发 2 次**：`backup/20261028.partial-broken.json` 的 7 只代码与本次完全相同。10-28 当时被误归因成「27 只 PCF 抓取失败」，于是 10-29 落的 [20261029j] 残缺守卫只比对「成功 PCF 数 vs 当次名单数」，**根修打偏**；11-06 原样复发。
4. **自愈通道被反锁**：11-07 03:32 名单恢复（缓存 `byCode=34`），但 [20261103g] 跨日重采守卫看到 `existHist.settled && !existHist.partial`，把残缺快照当「已定稿完整快照」保护起来直接返回，重采无法覆盖 → 事故潜伏 3 天直到 11-09 报障。
5. **现状扫描**：`lib/etfFlow.js` 中 `universe.length <`、`名单缩水`、`名单完整性`、`EXPECTED` 均 0 处；`noteErr(` 6 处但 `selectUniverse()` 的 catch 未调用，失败不进 `gaps`，页面完全无感。
6. **11-07 代码版本**：`lib/etfFlow.js` 最后改动是 11-03 的 `1f6ac5a`，11-07 的 `7f816cb` 未碰该文件 → 两道守卫当时都在，排除「跑了旧版本」。

### Suggested Action（待用户确认，勿擅自改业务代码）
- **A（最关键）**：`selectUniverse()` 每类查询失败必须 `noteErr` 并重试；`collect()` 增加**锚定绝对基准**的完整性判据（如要求 5 个家族全覆盖 + 总只数不低于应有下限），不满足一律 `partial:true / settled:false` 并写 `gaps`。这样名单缩水必被标残缺，跨日守卫不会保护它，自愈通道保持打开。
- **B**：`partial` 判据改为「相对 + 绝对」双保险（`okPcfs.length < universe.length || okPcfs.length < 应有下限`）。
- **C**：`baselineOnly` 时把 3 个统计区块渲染成「暂无数据 + 原因 + 数据日」占位卡（LRN-20261109-001 备选②，用户上一轮未选）。这是「卡片观感消失」而非数据事故，A+B 不能覆盖。
- 三者都做才能分层回答「不再出现」：A+B 挡数据事故，C 挡观感误判。

### Best Practice
**任何「部分失败」守卫都不能用「本次拿到的集合」当分母**——上游一旦静默降级，分子分母会一起缩水，守卫形同虚设。完整性必须锚定独立绝对基准（应有家族/最小只数/上一份成功名单），且上游每个 `catch` 都必须把原因送进 `gaps`，否则故障不可观测。另：修根因前先确认失败发生在哪一层（名单 vs 清单 vs 份额），本例首次根修就是因为误归因而打偏，导致 8 天后复发。

### Resolution（2026-11-09 已落地，用户选择「补 A+B 根修」）
**只改 `lib/etfFlow.js` 一个业务文件**，输出格式不变（`partial` / `gaps` 都是既有字段，`collect()` 返回结构未变），下游 `computeFromSnapshots` / `getEtfFlow` / `server.js` / 前端零改动 —— 符合「隔离修改」第一条逻辑。
- **A 绝对基准**：新增 `UNIVERSE_FULL_SIZE`（GROUPS max 合计 34）、`UNIVERSE_MIN_RATIO=0.8`、`universeIntegrity()`（要求 5 个宽基家族全覆盖 + 总数 ≥ 下限 27）；`selectUniverse()` 三个分类查询失败**重试 1 次**，两次都失败才 `noteErr` 进内部错误台账（由 `getEtfFlow` 的 `drainErrs()` 并入 `gaps`，故障可观测）；`collect()` 名单不完整时 push 明确告警到 `gaps`。
- **B 双保险**：`partial = universeBad || okPcfs.length < universe.length || (uInt && okPcfs.length < uInt.minSize) || missingShare.length > 0`。
- **自愈反锁自动解除**：一旦标 `partial`，跨日重采守卫（442）不再保护它、基期选择（533）不再选它，重采可覆盖 —— 无需改这两处既有逻辑。
- **测试**：新增 `scripts/test_etf_universe_integrity.js`，**25/25 全绿**，覆盖 §1 绝对基准纯函数、§2 名单缩水必标残缺且事故指纹不再出现、§3 名单恢复后重采补全 34 只并恢复定稿（自愈通道打开）、§4 接线守卫。配套给 `test_etf_flow_holiday_guard.js` 的 `baseOpts()` 加 `assumeCompleteUniverse: true`（白盒夹具自担基准，生产默认校验）。
- **回归基线如实记录**：改前 4 个 ETF 单测 exit = 0/1/0/0，唯一失败是 `test_etf_flow_holiday_guard.js` §3 硬编码 `APP_VERSION = '20261106p'`（当前已是 `20261108d`），属既有过时断言；改后完全一致、**无新增失败**。未擅自改 `APP_VERSION`（会触发缓存破坏）。
- **生效条件**：改的是后端模块，3005 服务需重启一次才加载新代码；单测已在新进程验证逻辑。前端静态资源未变，不升 `APP_VERSION`。
- **未做**：C 占位卡（用户本轮未选），故「卡片观感消失」仍需单独处理。

### Metadata
- Source: user_feedback / root_cause_analysis
- Related Files: lib/etfFlow.js (selectUniverse:212, collect:385/485/499), scripts/test_etf_universe_integrity.js, scripts/test_etf_flow_holiday_guard.js, scripts/restore_etf_20261106.js, data/etf-flow/backup/20261106.partial-mislabeled.json, data/etf-flow/backup/20261028.partial-broken.json, data/etf-flow/pcf-cache/20261107.json
- Tags: 名单缩水, 静默降级, 完整性判据, partial, settled, 误归因, 根修打偏, 复发
- See Also: LRN-20261109-001
- Pattern-Key: harden.absolute_integrity_baseline

---



## [LRN-20261109-003] correction · 因子输出「字段白名单」是隐形接缝：纯函数单测全绿 ≠ 前端拿得到新字段

**Logged**: 2026-11-09
**Resolved**: 2026-11-09（20261109a 补齐透出 + 两个守卫加断言）
**Priority**: high
**Status**: resolved
**Area**: architecture / guard

### Summary
实现 FEAT-20261109-002（两融双栏）时，`calcMargin()` 已正确返回 `subs/splitNote/subScore`，纯函数守卫 63 项、静态源码断言、既有模型守卫 64 项**全部通过**；但端到端渲染探针（`vm` 加载 `app.js` 调 `_renderEmotionPanel`）报 `Cannot read properties of undefined (reading 'map')`——`data.factors[].subs` 根本不存在。根因：`computeMarketEmotion` 返回时对 factors 做了一层 `factors.map(f => ({ key, name, score, weight, contribution, ... }))` **字段白名单**，新增字段没被列进去，前端 `isDual` 恒为 false，双栏永远不渲染。

### Details
- 白名单位于 `lib/marketEmotionModel.js:1176-1208`，历史上每加一个可追溯字段都要在此手工登记（`etfDate`、`heatPct`、`pvLabel` 等均如此）。
- 这类接缝**静态断言测不到**（前端代码确实写了 `f.subs`，源码里有）；**纯函数单测也测不到**（`calcMargin` 单独调用返回是完整的）。只有「模型最终输出 → 前端渲染函数 → HTML」整条链才暴露。
- 已补：`subScore: !!f.subScore`、`subs: Array.isArray(f.subs) ? f.subs : null`、`splitNote: f.splitNote || null`。

### Best Practice
**凡模型层给因子/卡片新增字段，必须同时检查最终输出的序列化/白名单层**，并加一条端到端渲染守卫（不是静态断言）。判断标准：问「前端拿到的对象里有没有这个字段」，而不是「计算函数有没有返回」。本项目的固定接缝清单：`computeMarketEmotion` 的 `factors.map`、`server.js` 的 API 展开层（此前 ETF `/api/etf-flow` 把 detail 展开到顶层也踩过同类坑）。

### Resolution
- 白名单已补齐；`scripts/test_emotion_margin_dual.js` §2 加「输出白名单已透出 subs / subScore / splitNote」断言；新建 `scripts/test_emotion_margin_render.js`（15/15）用真实模型输出 + vm 加载 `app.js` + DOM stub 渲染，专守这条接缝。
- 顺带确认：内部 `dirWeight` 用的是**白名单之前**的 factors，所以净权重/总分计算本来就是对的，漏的只有前端展示字段——问题表现会非常隐蔽（数值对、样式不变、只是新 UI 不出现）。

### Metadata
- Source: self_diagnosis / end_to_end_probe
- Related Files: lib/marketEmotionModel.js:1176, public/js/app.js:1230, scripts/test_emotion_margin_render.js, scripts/test_emotion_margin_dual.js
- Tags: 字段白名单, 序列化接缝, 端到端渲染, 静默丢失
- See Also: FEAT-20261109-002, LRN-20261109-001
- Pattern-Key: architecture.output_whitelist_seam

---



## [LRN-20261109-004] best_practice · 中文金融列名不能用子串匹配：「融资融券余额」含「融券余额」

**Logged**: 2026-11-09
**Resolved**: 2026-11-09（20261109a 改精确匹配 + 守卫）
**Priority**: medium
**Status**: resolved
**Area**: data-source

### Summary
`scripts/market_emotion.py::fetch_margin()` 扩展解析「融券余额」列时，若沿用旧写法 `if "融券余额" in str(c)`，会先命中列名「**融资融券余额**」（字符序列 [融,资,融,券,余,额] 在索引 2 起包含 [融,券,余,额]），取到的是两融合计而非融券余额。实测误取值 11992.4 亿（沪市单日合计），真实融券余额 184.46 亿 + 深 103.65 亿 = 288.11 亿，量级差 40 倍，会直接算出虚假方向。

### Details
- 融资侧旧写法 `if "融资余额" in str(c)` 碰巧安全：「融资融券余额」不含连续子串「融资余额」。
- akshare `macro_china_market_margin_sh/sz()` 的列定义固定为 `融资买入额 / 融资余额 / 融券卖出量 / 融券余量 / 融券余额 / 融资融券余额`（`macro_china.py:900-907 / 931-939`），完全可精确匹配。
- 已改为 `if str(c).strip() == val_name`，`_to_map(df, val_name)` 由调用方显式传列名，融资/融券各解析一次。

### Best Practice
中文指标名普遍存在「前缀包含」关系（融资融券余额 / 融资余额 / 融券余额、归母净利润 / 净利润、TTM / 累计）。**取列一律用 `strip()` 后精确相等**，或先用精确匹配、失败才允许受控的模糊回退并把回退写进日志；不要裸用 `in`。扩展解析第二列时，顺便把第一列也升级为精确匹配，避免两套标准并存。

### Resolution
- 精确匹配已落地；`scripts/test_emotion_margin_dual.js` §3 断言存在 `str(c).strip() == val_name`、不存在可执行的 `if "融券余额" in str(c):`、沪深两边都解析融券列、融资 `latest` 精度不变。
- 真实数据实测（纯标准库 `ast` 提取函数 + `urllib` 直连金十 + stub DataFrame，绕过沙箱 pandas DLL 拦截）：融资 22709.8 亿 / 5日 −3.33%，融券 288.11 亿 / 5日 +2.08%，数据日 2026-11-05。

### Metadata
- Source: self_diagnosis
- Related Files: scripts/market_emotion.py, scripts/test_emotion_margin_dual.js
- Tags: 列名匹配, 中文子串, 两融, 虚假数值
- See Also: FEAT-20261109-002, ERR-20261109-001
- Pattern-Key: data_source.exact_column_match

---



## [LRN-20261109-005] correction · 自由文本着色器不能按数值符号推断方向

**Logged**: 2026-11-09
**Priority**: high
**Status**: resolved
**Area**: frontend / color-semantics

### Summary
`app.js::_dirColorize()` 与 `dailyReview.js::colorize()` 旧版用正则 `([+-]\d+...)` 给**任意**带符号数值套 `.up`(红)/`.down`(绿)。这在「涨跌幅」字段是对的，但同一函数被复用到复盘全文、核心驱动、操作建议、风险提示、因子 detail 等自由文本，于是「融券余额 +2.08%」「风险敞口 +3%」「亏损扩大 +30%」「CPI 同比 +2.1%」这类**数值为正、语义为负或中性**的内容被染成利好红，直接违反「只有利好/正面才能用红」的铁律。更糟的是 `.up/.down` 带 `!important`，会覆盖 `.tp-emo-risk` 的琥珀警示色。

### Details
- **根因是「把数值符号当业务方向」**，不是色值配错。方向必须由数据层的语义字段（`tone` / `signal` / `dir`）或显式语义词给出，不能由 `+/-` 反推。
- 同一个着色函数被「数值字段」和「自由文本」共用，是典型的抽象泄漏：调用方没地方声明「这个数是否等于方向」。
- 中文金融文本里「涨跌幅」「涨跌家数」是中性组合词，逐字着色会拆成红「涨」+绿「跌」，必须整词跳过。

### Best Practice
1. **三级显式契约**：默认只按显式语义词着色；`{numeric:true}` 只允许在已确认「语义与符号严格一致」的字段（如 `changePct`）显式 opt-in；`{tone}` 由已有确定性语义的调用方给定。**没有语义就不上色**，宁可灰字，不可猜。
2. **风险 / 警告 / 缺口 / 状态词放进 NEUTRAL**，不进 BULL/BEAR——它们是琥珀橙提示，不是利好利空。
3. **输出统一用语义 class**（`tp-sig-bull/bear/flat`），不要用带 `!important` 的 `.up/.down`，否则父级警示色会被子 span 覆盖。
4. **CSS 侧同步做「红绿用法哈希基线」**：把所有允许使用红绿的选择器集合算 sha256 锁进守卫，新增任何一处红绿都必须人工复核语义；再叠加「禁用类清单 + 好=红/坏=绿映射」双断言，防止只改一处、漏改同类。
5. 图表序列同理：**存量/结构/占比/阈值线**（股价叠加线、持仓/现金比例、两融余额柱、RSI 70/30、放量/缩量参考线）不是方向消息，用中性蓝/琥珀；只有涨跌柱、K 线、净流入、明确的多空评分才可用红绿。

### Resolution
- 三级契约已落地；`changePct` 保留 A 股 +红/-绿；守卫 `scripts/test_color_semantics.js` 147/147（含 vm 真实渲染断言）。
- 全量 132 套单测 27 个失败逐项核对均为既有硬编码旧版本戳/数据基线，**无新增失败**。

### Metadata
- Source: user_instruction + self_diagnosis
- Related Files: public/js/app.js, public/js/dailyReview.js, public/js/homeMacro.js, public/css/style.css, scripts/test_color_semantics.js
- Tags: 颜色语义, 数值符号, 方向色, 自由文本, 回归守卫
- See Also: FEAT-20261109-003, FEAT-20261109-002, LRN-20261109-003
- Pattern-Key: ui.color_semantic_not_sign_based

---



## [LRN-20261109-006] correction · 同屏互斥第 3 次复发：异常特例层是「统一口径」的漏网之鱼，且量能基准跨期跨价位不可比

**Logged**: 2026-11-09T16:34:00+08:00
**Priority**: critical
**Status**: resolved（2026-11-09 20261109c 已根修并建守卫）
**Area**: backend

### Resolution（20261109c）
1. **不再「逐处改阈值」，改为建立单一真值源模块** `lib/volumeCaliber.js`：所有放量/缩量判定只能调 `isAmpRatio / isShrinkRatio / tierOfRatio`，阈值常量集中一处。引擎 7 处 `AMP_CONFIRM=1.5` 与 `SHRINK_CONFIRM=0.7` 全部退役，`capitalFlow` 同口径接入。这是本条最重要的沉淀：**「统一口径」类改动不能只 grep 用户提到的那几处，必须把「规则自身语义」也当成判定层**，并让所有比较点物理上不可能保留第二套常量。
2. **基准可比性写成代码守卫而非口头约定**：新增 `_pickRefHigh()`（同价位带 ±10% + 时间最近有效局部前高 + 上市前 5 根保护 + 除权/股本断点 + 4×同价位带量能中位数异常值剔除 + 无合格样本返回 null 诚实披露），且前高量能**只作展示参照、绝不参与判定**——从结构上杜绝「拿上市首日天量当门槛 → 冲高回落必命中」的 fail-open 假阳性。
3. **措辞也是判定层**：规则名「缩量假突破」→「假突破量能不确认」，结论/风险标签/相关字段同步；平量或放量日不再出现「缩量」字样。
4. **口径说明必须与代码覆盖范围一致**：`app.js` 原声明只列三处，本轮补全异常特例层 / 11.3.1 / 口诀4 / 缩量止跌 / 资金卡回退，并显式区分「显式标注分母的 ÷前5日均量原始指标」与「÷20 判定档位」。
5. **新发现的边界坑**：`capitalFlow` 把量比四舍五入到 2 位再判定，`1.301 → 1.30` 会判平量而 135 格用原值判放量 → 又一处同屏互斥。已改为「判定用未取整原始量比、展示仍保留 2 位小数」。**取整后的展示值不得用于阈值比较**。
6. 守卫 `scripts/test_volume_single_source.js` 63/0，含威高血净 1.47 夹缝端到端复刻与 12 个阈值点扫描；引擎 schema / LAYOUT_VERSION / APP_VERSION / ?v= 全升 20261109c。

### Summary
用户截图（威高血净 603014，行情日 2026-11-09）抓出同屏正面矛盾：第三步「量能 × 涨跌幅」判 **放量 + 下跌**（当日 −2.29%，当日量/20日均量 **1.47**），而「缩量假突破 / 结论提示」判 **量能未有效放大、缩量假突破、不得给出看多信号**（当日量 28467 手 < 20日均量 19382 ×1.5 = 29073 手，且 < 前高对应量能 265682 手）。同时用户质疑「2026 年 11 月的量能用 2025 年 5 月股价 48 时的量能作放量标准是否合适？2026-06-17 明明有股价 38 的对应前高和量能，为什么不用？」——**两处质疑均成立**。

### Details
**根因 1（阈值夹缝 + 统一口径漏改）**：20261106j「分母统一 ÷20」只改了 `_volumeTier` / `_comboEngine` / 三张老卡，把阈值统一为 `ratio20 > 1.3 → 放量`；但 `lib/volumeEngine.js` 规则3「缩量假突破」（异常特例层）仍保留 `AMP_CONFIRM = 1.5` 与 `ampOk = vol > refVol && vol > avg20 × 1.5`（:81 / :761）。当天 `ratio20 = 28467 / 19382 = 1.469` 恰好落在 **(1.3, 1.5)** 夹缝 → 主轴判「放量」、特例层判「未有效放大」。更糟的是规则名与徽标用「缩量 / 缩量出清」措辞，把 1.47 倍量能直接叫成缩量。
`public/js/app.js:2632` 的口径说明却写着「全量价判定已统一为 当日量 ÷ 20 日均量……同屏结论不再互斥」——该声明只覆盖 135 格 / 今日量价关系判定 / 资金行为三处，**异常特例层不在内**，属于「声称统一但实际有漏网」的诚实性问题。

**根因 2（基准跨期跨价位，违反分析期锁定）**：`lib/volumeEngine.js:764-770` 取 `refVol` 的方式是 `for (i=0; i<n-1; i++) if (bars[i].high > pH) { pH = bars[i].high; pi = i; }`——**传入 bars 全窗口的全局最高价那一天**，没有价位带筛选、没有时间邻近性、没有异常值剔除、没有除权/股本归一。截图取到的 `2025-05-19 / 48.44 / 265682 手` 经 `data/cache/ths-daily/603014.json` 实证：`start=20250519`、`issuePrice=26.50`、`dates` 从 `0519` 起、`allRaw.volumn[0] = 26568240 股 = 265682 手`——即**上市首日的天量**（全历史最大量）。用它当门槛，当日 28467 手只有它的 10.7%，`vol > refVol` 恒不成立 → 规则3 退化为「只要冲高回落就必命中」的 fail-open 假阳性，并连锁污染 6 个徽标与「不得给出看多信号」的强结论。

**用户指出的替代基准真实存在**（同花顺 lastRaw 140 根，2026-04-13~2026-11-06 实测）：

| 日期 | 最高价 | 成交量(手) | 与当前 34.06 / 触及线 34.86 的关系 |
|---|---|---|---|
| 2026-06-17 | 38.16 | 94,934 | 用户点名的前高，价位最接近 |
| 2026-06-18 | 38.17 | 70,936 | 该窗口局部最高价 |
| 2026-08-04 | 35.18 | 39,088 | 同价位带最近局部高点之一 |
| 2026-08-11 | 34.54 | 25,437 | 同价位带最近局部高点之一 |

即：与当前股价同价位带（33~40）的前高量能约 **2.5~9.5 万手**，与被采用的 **26.6 万手**差一个数量级。用户判断「应该用 2026-06-17 附近」在数据上完全站得住。

**跨期不可比的四个理由**：①上市首日是无涨跌幅限制/筹码全额换手的一次性极端事件，不属正常交易日量能分布；②股价 48 → 35（−27%），成交量绝对值受价格水平与流通盘影响；③相隔 1.5 年，市场活跃度中枢漂移；④项目三条底层规则之一「数据一致性（单一权威源 + 五要素 + **分析期锁定**）」要求基准与判定对象同分析期，此处未锁定。

**已知未修缺陷**：`docs/logic/stock-13-capital.md:180` 自查清单 #12 早已记录「规则3『前高对应量能』取窗口 argmax，多个等高前高时只取第一个」，状态仍是 `[ ]`；本次是其更严重的表现（不只是取错等高点，而是取整段历史的极端异常日）。另有 `LRN-20261028-xxx`（规则3 盘中部分日累计量 vs 全天基准误触发）同属该规则的可比性缺陷族。

### Suggested Action
1. 先向用户确认三项裁决再动代码（用户铁律：修既有代码前必须核实）：①规则3 是否完全接入 `ratio20 > 1.3` 单一真值源并停用 1.5；②「前高对应量能」是改为「同价位带 + 时间最近的有效前高（剔除上市首日/极端值、跨除权归一）」还是整体删除该条件；③修改范围（规则3 = 通用逻辑，须全个股同口径）。
2. 规则名 / 徽标 / 文案去掉「缩量」措辞，改为「量能未达确认级」；若 1.3~1.5 区间出现，同屏必须显式披露两套阈值，不得一面判放量一面叫缩量。
3. 把异常特例层（`_tenRules` 规则 1/3/4/5 及 `AMP_CONFIRM` 全部比较点）纳入「统一口径」守卫的扫描范围；建立「基准可比性」断言：基准日与判定日必须同价位带、同分析期、排除上市首日/除权断点。
4. 按「类型 vs 个体」铁律列共用清单给用户确认：`lib/volumeEngine.js`（唯一引擎）、`lib/posModel135.js`、`lib/capitalFlow.js`、`public/js/app.js`（口径说明）、`public/js/capitalCharts.js`、`public/volume-map.html`、`lib/sameDayJudgment.js`、`lib/priceAction.js`、`scripts/test_volume_*.js` 共 9 类守卫。

### Metadata
- Source: user_feedback (用户截图 `屏幕截图 2026-11-09 162850.png` / `162857.png`)
- Related Files: lib/volumeEngine.js (:81 AMP_CONFIRM, :761 ampOk, :764-770 refVol, :785-790 文案), public/js/app.js (:2632 口径说明), lib/capitalFlow.js (:343-400), docs/logic/stock-13-capital.md (:180 #12), data/cache/ths-daily/603014.json
- Tags: 同屏互斥, 统一口径漏改, 阈值夹缝, 上市首日异常值, 分析期锁定, 基准可比性, 缩量假突破
- See Also: LRN-20261106-001, LRN-20261106-003, LRN-20261106-004（本条为其 Recurrence-Count 3）, LRN-20261020-002, LRN-20261017-xxx（三处量能结论互斥 70%）, FEAT-20261109-004
- Pattern-Key: harden.caliber_unification_must_scan_all_comparison_sites
- Recurrence-Count: 3
- First-Seen: 2026-11-06
- Last-Seen: 2026-11-09
- **Promotion Candidate**: Recurrence-Count 3 / 跨 3 个任务 / 3 天内 → 满足提升条件，待用户确认修复方案后写入 workspace MEMORY.md

---



## [LRN-20261110-001] knowledge_gap / best_practice

**Logged**: 2026-11-10T11:49:18+08:00
**Priority**: high
**Status**: resolved（20261110a 已落地：formal/complete 状态机 + 20:30 补录 + 次日 15:35 兜底 + 按源 `--lhb-only` 重取；见 ERR-20261110-001 Resolution）
**Area**: backend

### Summary
「数据最新性」不能只按自然日/交易日设 TTL，还须按**数据源的实际发布时刻**分级：收盘即得型（涨停池/行情快照）与盘后延迟发布型（龙虎榜等）必须有不同的就绪窗口与回补路径；否则「取数成功但取早了」会被固化成永久缺失。

### Details
用户报障「龙虎榜当天晚上才更新，第二天工作台还没有数据」。实证（详见 ERR-20261110-001）：`stock_lhb_detail_em` 在次日查 T 日返回 67 行，而 T 日 15:35 查返回空；工作台 15:35 抓空 → 落盘 → 补跑被「完整度≥90 即跳过」阈值挡掉 → 次日读旧快照，永久显示「缺失」。
三条可推广的教训：
1. **「取到空」≠「数据源故障」**：空结果要区分「未发布 / 非交易日 / 接口异常」三种，note 必须写真实原因。当前 `build_lhb` 一律写「非交易日或接口不可用」，属误导性标注，违反诚实合规审计。
2. **一次性快照 + 幂等保护会锁死缺失**：`completeness.score >= 90` 的补跑跳过条件，让 12 源中缺 1 源（94 分）被判为「完整正式版」，缺失源再无重取机会。完整度阈值应允许「单源 failed 即触发该源定向重取」，而非整份复盘重跑。
3. **按类型 TTL 需覆盖「发布时刻」维度**：交易日感知解决「哪天有数据」，但没解决「当天几点之后才有」。晚发型数据源要有独立就绪时刻 + T+1 回补 + 跨天过期标注。

### Suggested Action
- 建立数据源登记表/常量：每源标注 `readyAfter`（如涨停池 15:05、龙虎榜 18:30）与 `latePublish: true`；调度器据此排窗口，读档时对 `latePublish` 且未过就绪时刻的旧快照显示「待回补」而非「缺失」。
- 新增回补时按**缺失源定向重取**，不要整份复盘重跑（省 akshare 多日序列约 20s，也避免改动其他源口径）。
- 任何「按日期回补」都要走交易日历判定，且不能把 T 日盘后补到的数据冒名为 T 日盘中可得（五要素 asOf 必须写真实口径日）。

### Metadata
- Source: user_feedback（用户 2026-11-10 报障 + 截图）
- Related Files: server.js:2510-2562, lib/reviewService.js, lib/boardReviewData.js, scripts/board_review_data.py
- Tags: 数据最新性, 按类型TTL, 发布时滞, 定向回补, 诚实缺失标注, 五要素asOf
- See Also: ERR-20261110-001
- Pattern-Key: data.late_publish_source_needs_t1_backfill
- Recurrence-Count: 1
- First-Seen: 2026-11-10
- Last-Seen: 2026-11-10

~~~

---

## `.learnings\ERRORS.md`  ·  355 行

~~~md
# ERRORS.md — 命令/操作/集成失败记录（self-improving skill）

> 格式见 self-improving skill：ERR-YYYYMMDD-XXX + Summary/Error/Context/Suggested Fix/Metadata。
> 修复后把 Status 改 resolved 并补 Resolution 块。

## [ERR-20261020-001] sentiment_accuracy_weekend_basedate_stuck

**Logged**: 2026-10-20T03:50:00Z
**Priority**: high
**Status**: resolved（20261020a 三处修复完成，用户 2026-10-20 确认「按完整三步修复」）
**Area**: backend

### Summary
市场情绪提醒准确率台账（data/sentiment-accuracy/）出现「基准日落非交易日 → 记录永久卡在待结算」：2026-10-18（周日）留档的预测 baseDate=2026-10-18，上证指数日 K 无此日线，settleRecord 找不到基准日 K 线（baseIdx=-1）直接 return，任何重启/定时结算都无法结算，台账「已结算数」永久少于「已记录数」。用户 2026-10-20 截图报障「结算的数量比预测的数量少太大」。

### Error
```
rec: 2026-10-18 -> 2026-10-19 dir: 跌
hist bars: 321 | last 3 dates: 2026-10-16, 2026-10-19, 2026-10-20
has 10-18 bar: false | has 10-19 bar: true
after settleRecord: settled = false | actualDir = undefined
```

### Context
- 触发链：周日下午首页调 /api/sentiment-turning-point → buildHomeMarketEmotion → computeMarketEmotion 内 `rec.baselineDate = bars.length ? bars[bars.length-1].date : today`（marketEmotionModel.js:832）——本机东财/网络瞬时失败（logs 满屏 socket hang up）致 index bars 为空 → baselineDate 兜底为 today=2026-10-18（周日）→ server.js:942 以 `{ baseDate: emo.baselineDate }` 留档 → sentimentAccuracy 写 baseDate=2026-10-18、targetDate=nextTradingDay=2026-10-19。
- settleRecord（sentimentAccuracy.js:131）只有 targetDate 防呆（20261013f：目标日撞休市日则重算），**baseDate 侧无防呆**；`hist.findIndex(h => h.date === rec.baseDate)` 找不到周日线 → -1 → return rec，永久 pending。
- 佐证：marketEmotionModel 自己的 records.json 同日记录 baselineDate=2026-10-16（后一次成功调用 upsert 修正），证明周日数据基准确是上一个交易日 10-16；且 10-16 留档（已结算）与 10-18 留档预测目标同为 10-19、方向同为跌——10-18 记录是纯 bug 产物，无独立信息。
- 影响面：每个周末只要发生「页面访问 + 日线通道瞬时失败」就会复造一条卡死记录；当前台账 18 记录/15 结算/3 待结算，其中 10-18 为卡死，10-19（目标 10-20 今日交易中）与 10-20（目标 10-21 未来）为正常待结算。

### Suggested Fix（待用户确认后实施）
1. **结算侧防呆**（lib/sentimentAccuracy.js settleRecord）：baseDate 非交易日时回滚上一个交易日（`previousTradingDay`，cnTradingCalendar 已导出，sameDayJudgment:211 有 wrapper），与 targetDate 防呆对称；修后 settleAll 可自愈旧卡死记录。
2. **留档侧防呆**（lib/sentimentAccuracy.js recordDailyJudgment）：`meta.baseDate || localDate()` 之后，非交易日回滚 previousTradingDay——周末调用的数据基准本就是上个交易日，回滚后与既有留档幂等去重（prev.settled 早退），不再产生卡死记录。
3. **存量卡死记录**：建议删除 data/sentiment-accuracy/2026-10-18.json（与 10-16 记录同数据基准、同预测目标、同方向，属重复计数）；或保留待修复 1 自动补结算（会重复计一次未命中）。

### Resolution（20261020a 已实施）
1. 结算侧：`settleRecord` 基准日比对改走新增纯函数 `resolveBaseDate`（非交易日→previousTradingDay 回滚，空值透传）；不变量 `nextTradingDay(d)==nextTradingDay(previousTradingDay(d))` 由测试锁定，目标日不受影响。
2. 留档侧：`recordDailyJudgment` 同样回滚，并追加保护——**回滚而来的记录不得覆盖回滚目标日的既有留档**（实证 10-18 周日降级结论只剩融资余额单因子、indexValue 为 null，若允许覆盖会顶替 10-16 正常记录；原 Suggested Fix 的「幂等去重」仅防 settled 覆盖，此处加固）。
3. 存量：`data/sentiment-accuracy/2026-10-18.json` 已删除，台账回到 17 条。
- 验证：test_event_weight_sentiment_acc.js 新增 9 项防呆用例（resolveBaseDate 4 项 + 不变量 1 项 + 接线断言 1 项 + 留档功能实测 3 项，44/44 全绿）；全量回归 50/53（3 个在档旧失败零新增）；node 直调 settleRecord 复刻周日记录 `settled=true`（回滚 10-16 基准 3716.28 vs 10-19 目标 3730.92，+0.39% 震荡未命中）；磁盘台账 overdue=0。版本戳 APP_VERSION 20261020a + public 31 处。
- 附带发现（未修，用户批准另开一轮）：权重自学习「当前样本不足」文案与实际不符——priceVolume 旧 key 28 样本不参与学习（不在 BASE_WEIGHTS）、volumePrice 新 key 仅 3 样本、indexMomentum/margin 已到 W_MAX=30 → learnLog 恒空。

### Metadata
- Reproducible: yes（node -e 调 settleRecord 实证，见上；零网络可复现路径：构造 baseDate=周日的 rec）
- Related Files: lib/sentimentAccuracy.js, lib/marketEmotionModel.js, server.js, data/sentiment-accuracy/2026-10-18.json
- Tags: sentiment-accuracy, weekend-baseline, stuck-settlement, degrade-fallback
- Pattern-Key: backend.accuracy_ledger_nontrading_basedate
- Recurrence-Count: 1
- First-Seen: 2026-10-18
- Last-Seen: 2026-10-20

## [ERR-20261104-001] llm_temperature_unsupported_model

**Logged**: 2026-11-04T16:10:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
用户把联网模型换成 kimi-k3 后，所有 AI 功能（首页 AI 解读等）报 400：`InternalError.Algo.InvalidParameter: Parameter 'temperature'=0.3 is not supported for kimi-k3 model`。

### Error
```
<400> InternalError.Algo.InvalidParameter: Parameter 'temperature'=0.3 is not supported for kimi-k3 model.
```

### Context
- lib/ai/llm.js buildRequestBody 对所有模型硬编码 `temperature: 0.3`（阿里百炼 DashScope Kimi 系模型不接受采样温度参数）
- 既有 400 兜底（去掉 enable_search 重试）条件要求请求体带联网参数，本例无 → 错误直抛前端 alert

### Suggested Fix
① buildRequestBody 对 kimi 系模型（isNoTemperatureModel：名以 kimi- 开头）预判剔除 temperature；
② postLLM 能力自学习补第三分支：400 + temperature + not supported/InvalidParameter → 记忆 NO_TEMPERATURE_MODELS + 剔除重发（首见即记忆，进程内 Set）。

### Resolution
- **Resolved**: 2026-11-04T16:10:00+08:00
- **Notes**: 版本 20261104c；守卫 test_llm_stream_fallback 扩 §F（桩服务验证 400→剔除重发→记忆零请求浪费）；真实 E2E：kimi-k3 AI 解读 42.8s 返回完整内容。
- **通用教训**：LLM 网关「参数不兼容」类报错应统一走能力自学习层（stream/enable_search/temperature 三维度），新增硬编码参数前先确认目标模型白名单；**See Also**: 源码 lib/ai/llm.js 20260918b 注释块。

---

## [ERR-20261104-002] back_to_top_window_scroll

**Logged**: 2026-11-04T17:45:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
「回到顶部」按钮点击无反应：app.js 绑定 window.scrollTo({top:0})，但 Stock Analyzer 的 html/body 为 overflow:hidden（style.css 105 行），window 从不滚动，页面真正的内容滚动容器是 <main class="main-content">（overflow-y:auto）。

### Error
```
无 JS 报错——scrollTo 调用成功但作用于从不滚动的 window，用户感知为「点击后没有反应」
```

### Context
- 20261104f 新增 #backToTopBtn 绑定 window.scrollTo
- 页面布局：body flex（sidebar + .main-content），滚动发生在 .main-content

### Suggested Fix
滚动目标必须是实际 overflow-y:auto 的容器：document.querySelector('.main-content').scrollTo({top:0,behavior:'smooth'})，window.scrollTo 仅作容器缺失兜底。

### Resolution
- **Resolved**: 2026-11-04T17:48:00+08:00
- **Notes**: 20261104g 修复绑定目标；教训=**该布局下任何「滚到顶/滚到底/锚点定位」类功能都必须作用于 .main-content 而非 window**（同类排查点：shares 跳转、图表定位、锚点高亮等）

### Metadata
- Reproducible: yes
- Related Files: public/js/app.js, public/css/style.css
- Pattern-Key: frontend.scroll_container_not_window

---

## ERR-20261104-003
**Date**: 2026-11-04
**Severity**: medium
**Status**: resolved
**Area**: engine

### Symptom
威高血净 603014 专属估值模型 E2E：`POST /api/ai/valuation` 返回 200 但响应无 `weigao` 专属字段，服务日志出现「[AI 估值] 603014 已注入财报解读摘要（复用已检索数据，免重复上网）」——标的掉进通用 LLM 流程而非专属确定性分支。

### Root Cause
专属模型接线四处、只接了三处：`hasDedicatedValuation()` 闸门 / `conclusion.js` / `app.js` 均已接线并通过静态断言，但 `analyzeValuation()` 主体的**逐标的内联执行分支**遗漏——闸门函数只供前端判断免 API Key，不参与服务端执行分流。

### Resolution
- **Resolved**: 2026-11-04T19:40:00+08:00
- **Notes**: `lib/ai/valuation.js` 万润分支后补 weigao 内联分支（getQuote→run→return DEDICATED）；守卫新增第四处接线断言 + E2E 断言 `ver:'DEDICATED'`。修复后 804ms 确定性返回。教训归档 LRN-20261104-004（dedicated_model_four_point_wiring）。

### Metadata
- Reproducible: yes
- Related Files: lib/ai/valuation.js
- Pattern-Key: engine.dedicated_model_missing_inline_branch

---

## ERR-20261104-004
**Logged**: 2026-11-04T19:55:00+08:00
**Severity**: medium
**Status**: resolved
**Area**: frontend

### Summary
基金行业配置名单（homeRank.js）向下浏览时自动回弹到名单前面。

### Error
```
无报错——行为缺陷：分批更新期间（q.published && !q.done）每 3 秒轮询 →
render() 无条件 body.innerHTML 全量重建（状态条+KPI+20 行表格）→
浏览器滚动锚定 anchor 落在被销毁子树内失效 → .main-content 滚动位置回弹。
```

### Context
- 东财 2026Q3 分批披露期间轮询常开（每日 19:00 检查、批次跨日推进）
- 轮询中大多数轮次数据未变，重建纯属打断浏览
- 滚动容器=.main-content（20261104g 口径），列表非独立滚动容器

### Suggested Fix
已实施（20261104j）双保险：① dataSig 数据签名比对（未变轮次跳过重建）；② 重建时滚动锚定恢复（重建前记录 .fmr-table-wrap 相对视口 top，重建后差值校正回 .main-content.scrollTop）；手动刷新强制重建保留视觉反馈。

### Metadata
- Reproducible: yes
- Related Files: public/js/homeRank.js
- See Also: ERR-20261104-002（滚动容器=.main-content 同源教训）

---

## ERR-20261104-005
**Logged**: 2026-11-04T21:40:00+08:00
**Severity**: medium
**Status**: fixed
**Area**: data-caliber

### Summary
威高血净页右卡「指标分析」毛利率同比显示 41.47%（去年同期 43.89%），左卡毛利率显示 37.78%——用户报「毛利率的数据不一致」。

### Error
```
主值 cur = val('grossMarginTtm') → TTM 口径 37.78%
同比 yoy = samePeriodPair(zyzb,'XSMLL') → 报告期累计口径 41.47%/43.89%
环比 qoq = consecutivePair(zyzb,'XSMLL') → 累计口径 37.88%
同一张卡三套数字两个口径，note 口径解释句无法阻止用户误读为数据错误。
```

### Context
- computeTtmMetrics 是 TTM 单一权威源，但当时只产出本期值（+ROE 的 roePrev）
- ROE 同比已有 TTM 同口径范式（roeTtmPrev 优先）但毛利率/净利率未跟进
- 20261104b 增长口径切换只覆盖成长类指标，水平型比率指标未覆盖环比同口径

### Suggested Fix
已实施（20261104k）：computeTtmMetrics 抽 marginsOf helper 补三套 TTM 窗口（本期/去年同期/上一报告期），metricAnalysis 三指标（毛利率/净利率/ROE）同比+环比维度 TTM 同口径优先、累计回退；note 改「与左卡数值完全一致」。守卫 test_margin_caliber_rename.js（46 断言，含数值复算 + 端到端文案 + 哨兵回退）。

### Metadata
- Reproducible: yes
- Related Files: lib/stockData.js, lib/metricAnalysis.js
- See Also: LRN-20261104-006

---

## ERR-20261106-001
**Logged**: 2026-11-06T15:45:00+08:00
**Severity**: high
**Status**: fixed
**Area**: frontend

### Summary
20261106g 纯 CSS「对称化」把五步判定链的中文徽标压成竖排单字，用户截图判定「界面优化完全失败」。

### Error
```
用户截图「屏幕截图 2026-11-06 153824.png」（士兰微 600460）：
「运行状态 · 五步判定链」下方的「道氏结构 / ADX 强度 / 均线排列 / 箱体量化 /
量价健康度」被拆成逐字竖排的一列，5 行内容左边界错乱、整块判定链不可用。
对照 15:21 截图（g 版尚未加载）一切正常 → 崩坏由 g 版 CSS 引入。
```

### Context
- 真实 DOM 是 `public/js/app.js:2614-2615`：
  `<div class="ve-posj-chain-item"><span class="ve-rule-badge">${s.k}</span><span class="ve-posj-chain-text">${s.v}</span></div>`。
  `s.k` 来自 `lib/volumeEngine.js:1829-1833` 的 `_runState` steps，值是
  `① 道氏结构 / ② ADX 强度 / ③ 均线排列 / ④ 箱体量化 / ⑤ 量价健康度`——**中文标签，不是 28px 圆形数字徽标**。
- g 版按类名想当然，写 `.ve-posj-chain-item { display:grid; grid-template-columns: 28px minmax(0,1fr) }`，
  28px 只放得下一个汉字 → 中文逐字换行竖排。
- **验证是假阳性**：g 版用 Edge 无头渲染「复刻页」截图两轮，但复刻页里徽标用了短数字，
  与真实 DOM 不一致，所以两轮截图都没抓到 bug；守卫 `test_posj_symmetry.js` 只断言 CSS 字符串 /
  生效值，既没断言真实 DOM 的子元素内容，也没做含真实文案的浏览器渲染。
- 另一次生问题：守卫断言「旧字符串不存在」与「末尾覆盖块」设计自相矛盾，改了两次才通过，
  进一步说明只测 CSS 文本、不测真实渲染不可靠。

### Suggested Fix
已实施（20261106h）：整块撤销 g 版覆盖规则，恢复 20261105f-b 的 flex 基线；只保留三处零风险修正——
① `.ve-posj-chain` 去掉单侧 `margin-left:140px` 使左右边界与三步骤/警示/主判/参考表对齐；
② `.ve-posj-chain-item > .ve-rule-badge { flex:0 0 96px; white-space:nowrap }` 让 5 行文字起点统一，
   并永久防止中文标签被压窄（96px 足够容纳「⑤ 量价健康度」）；
③ 窄屏说明文字 `flex:1 1 100%` 独占整行，消除右侧裁切。
复刻页改用**与 app.js 一字不差的中文标签**，宽屏 1100px / 窄屏 420px 双视口截图逐张目检确认。

### Metadata
- Reproducible: yes
- Related Files: public/css/style.css, public/js/app.js, lib/volumeEngine.js, scripts/test_posj_symmetry.js
- See Also: LRN-20261106-003
- Pattern-Key: frontend.css_assume_dom_children_by_classname
- Recurrence-Count: 1
- First-Seen: 2026-11-06
- Last-Seen: 2026-11-06

---

## [ERR-20261109-001] akshare_import_pandas_dll_blocked

**Logged**: 2026-11-09T12:51:54+08:00
**Priority**: medium
**Status**: pending
**Area**: infra / tests

### Summary
在 Bash 工具里执行 `python -c "import akshare as ak; ..."` 失败：`pandas` 的 C 扩展 DLL 被「应用程序控制策略」拦截，无法 import。但 3005 服务能正常取到两融数据（卡片显示 22710 亿），说明服务进程使用的 Python/环境不受该策略影响 —— 是**工具沙箱环境问题，不是项目代码或数据源故障**。

### Error
```
ImportError: DLL load failed while importing offsets: 应用程序控制策略已阻止此文件。
  File "pandas/_libs/tslibs/conversion.pyx", line 1, in init pandas._libs.tslibs.conversion
（触发链：akshare.__init__ → pandas → pandas._libs.tslibs）
Python: C:\Users\16507\.workbuddy\binaries\python\versions\3.13.12\python.exe
```

### Context
- 目的：实证 akshare `macro_china_market_margin_sh/sz()` 是否返回「融券余额」列（FEAT-20261109-002 前置数据可用性核查）。
- 环境：WorkBuddy Bash 工具，非交互；`python` 解析到 WorkBuddy 自带 3.13.12。
- 服务侧：`lib/marketEmotionData.js::runScript()` 通过 `findPythonForScript()` 选解释器，子进程方式调用 `scripts/market_emotion.py`，线上正常。

### Suggested Fix
不必修环境。改用**两步纯文本/HTTP 实证**绕过：① 直接读 akshare 源码取列名定义（`macro_china.py:900-907 / 931-939`）；② 用 Node `https` 直连上游 `cdn.jin10.com/data_center/reports/fs_1.json` / `fs_2.json` 拉真实数值校验。两步都已成功，结论：融券余额列存在且数值可用（2026-11-05 沪深合计 288.11 亿）。
若将来确实需要在本工具内跑 Python 脚本，优先尝试服务侧解释器或让服务自身暴露诊断接口，不要在 Bash 里硬试。

### Update（2026-11-09 / 20261109a，已找到纯标准库绕过法）
本轮 FEAT-20261109-002 落地时需要**真正执行** `fetch_margin()` 的列解析逻辑，环境限制仍在，但已用不依赖 pandas 的方式完整实测：
- `ast.parse()` 读 `scripts/market_emotion.py`，提取 `fetch_margin` 内的两个嵌套函数 `_to_map` / `_series`，`compile` 后在注入 `to_float` 的命名空间里 `exec`；
- 用 `urllib.request` 直连 `cdn.jin10.com/data_center/reports/fs_1.json` / `fs_2.json`（沙箱允许），把 `values` 转成只有 `columns/iterrows/__len__` 的 stub DataFrame；
- 结果：融资 22709.8 亿 / 5日 −3.33% / 2026-11-05，融券 288.11 亿 / 5日 +2.08% / 2026-11-05；并验证误取「融资融券余额」列会得到 11992.4 亿（陷阱可观测）。
**结论**：pandas 被拦只影响 `import akshare`，不影响验证「本项目自己写的解析函数」。凡 Python 侧纯逻辑改动，优先用 ast 提取 + stub 依赖的方式做离线/半在线实测，不要因为环境报错就跳过验证。环境本身未修（服务端解释器正常，无需修）。

### Metadata
- Reproducible: yes
- Related Files: scripts/market_emotion.py, lib/marketEmotionData.js:201-214
- See Also: FEAT-20261109-002
- Pattern-Key: infra.sandbox_python_dll_policy

---

## [ERR-20261110-001] 龙虎榜 T+1 仍显「缺失」：取数时点早于盘后发布 + 一次性落盘无回补

**Logged**: 2026-11-10T11:49:18+08:00
**Priority**: high
**Status**: resolved（20261110a 已实施并通过 43 项守卫；用户裁决「晚间 + 次日双槽」并入每日复盘全量替换规格）
**Area**: backend

### Resolution（2026-11-10 12:50 实施）
用户后续给出「每日复盘全量替换」长文本规格，第三部分把修复方案固化为 15:35 formal / 20:30 补录 / 次日 15:35 兜底，替代了本条目里的方案 A（T+1 早间 08:30 全量重跑）。实际落地：
- `lib/reviewService.js` 新增 `backfillDragonTiger()` / `needsBackfill()` 与 `formal → complete` 状态机；补录只重抓当日龙虎榜（不重跑 13 源、不重算其余段落），只替换第八段与第十段，同一日期 complete 幂等唯一、接口抖动不降级。
- `lib/boardReviewData.js` 新增 `getLhbOnly()`（不写缓存、补录前 `clearCache()`）；`scripts/board_review_data.py` 新增 `--lhb-only` 且空结果 `ok` 保持 True 以便把诚实 note 送回 Node。
- `server.js` `REVIEW_SLOTS` 增加 20:30 补录槽；15:35 主跑前先检查昨日 `needsBackfill()`；`POST /api/review/backfill` 与 `task_type="dragon_tiger_update"` 两种触发入口。
- 误导性 note 已改为「龙虎榜为盘后延迟发布数据：当前时点尚未发布…标注『待晚间补录』」；输出层把 15:35 未发布与「数据缺失」分开标注。
- **反向实证**：`python scripts/board_review_data.py --date 20261109 --lhb-only` 返回 `lhb.ok=true, count=67`，证明 11-09 数据本就存在，只是 15:35 取早了。
- 守卫 `scripts/test_daily_review.js` 新增 [2b] 6 个状态机用例（formal / pending / completed / 幂等 / task_type 路由 / 不降级），43 项全过。

### Summary
每日复盘在收盘后 15:35 抓龙虎榜，而东财龙虎榜明细是**盘后晚间才发布**；取到空结果后被写进当天复盘快照并判定为「完整正式版」，此后**既无次日回补、也无按源重取**，导致第二天打开工作台龙虎榜仍停在「缺失」。不是接口故障、不是计算错误。

### Error
```
页面「数据源」表：龙虎榜模块 | 资金/龙虎榜模块 | 失败 | 缺失 | 数据时间=缺失
获取时间 2026-11-09T07:35:56.226Z（= 北京 15:35:56）
缺失原因：当日龙虎榜明细无数据（非交易日或接口不可用），本项标注「缺失」

落盘 data/reviews/2026-11-09.json：
generatedAt 2026-11-09T07:36:08.203Z（= 北京 15:36:08）
completeness.score=94, limited=false, missing=[{key:'dragonTiger', reason:'当日龙虎榜明细无数据…'}]
```

### Context
- 用户报障原话：「龙虎榜数据是当天晚上才更新，但是到了第二天工作台还没有数据，应该是获取数据的机制出现问题。」
- **决定性对照实验**（2026-11-10 上午用工作台 Python `akshare 1.18.94` 实测）：
  - `stock_lhb_detail_em(start_date='20261109', end_date='20261109')` → **67 行**
  - `stock_lhb_detail_em(start_date='20261106', end_date='20261106')` → 79 行
  - 即 11-09 数据已正常发布、接口可用。
- **历史复盘对照**：`data/reviews/2026-11-06.json`（generatedAt 2026-11-08 16:45，隔日生成）dragonTiger=`ok`、完整度 100；`2026-11-09.json`（当天 15:36 生成）dragonTiger=`failed`、94。同一套代码，仅生成时刻不同 → 排除接口/算法故障，坐实「时点」问题。
- 完整机制链（四段，缺一不可）：
  1. `server.js:2510-2514` `REVIEW_SLOTS` = 15:35 主跑 + 15:40/45/50 补跑，**是唯一自动取数窗口**，且只传 `date: today`。
  2. `scripts/board_review_data.py:679` `ak.stock_lhb_detail_em(start_date=d, end_date=d)` 只查复盘日当天；15:35 尚未发布 → 空 → `:282` `build_lhb` 返回 `ok:false` + 误导性 note「非交易日或接口不可用」（真实原因是「尚未发布」）。
  3. `lib/reviewService.js:186` `block.ok === false` → throw → `collect` 标 `status:'failed'`；`runReview` 15:36 把整份快照 `writeReviewSync` 落盘（94 分 / limited:false）。
  4. `server.js:2545-2552` 补跑判定 `completeness.score >= 90 && !limited` → **94 ≥ 90 直接跳过三个补跑槽**；即便跑，15:50 数据仍未发布。`getToday()/getByDate()` 纯读盘不重取；全代码库无按历史日期的 review 回补（grep `backfill|回补|T+1` 只命中板块拥挤度/ETF/分红，均非复盘）。
- 次要因素：`lib/boardReviewData.js:23` `CACHE_TTL=10min` 只影响同进程内复用，不是跨天主因。
- 违反项目三条底层规则之「数据最新性（按类型 TTL + 交易日感知 + 过期标注）」：龙虎榜属**盘后延迟发布型**数据源，却与涨停池共用 15:35 单一窗口；跨天后旧快照未标注「龙虎榜未在发布窗口内取到」。

### Suggested Fix
待用户确认后实施，勿擅改既有代码（用户铁律：修既有代码前必须核实）：
- **方案 A（推荐，隔离/新增机制）**：新增 T+1 早间回补槽（如次日 08:30），扫前一交易日已落盘且 `dragonTiger.status==='failed'` 的复盘，仅对缺失源重取后走 `runReview` 修订版逻辑生成 v2。94→100 为升分，符合现有「不得用更差数据覆盖」保护（`reviewService.js:902-906`）。
- 方案 B：把龙虎榜主跑后移到晚间 19:30 单独一次；会改变整份复盘生成时刻，影响面大。
- 方案 C：路由层懒回补 —— 读档发现 `failed` 且已过发布窗口时按日期触发重取。
- 方案 D：仅修正 note 文案与过期标注（诚实性），不解决数据缺失。
- 无论选哪个，须把 note 从「非交易日或接口不可用」改为「盘后数据尚未发布」，并给龙虎榜单独的类型 TTL / 就绪时刻。

### Metadata
- Reproducible: yes（每个交易日 15:35 必现）
- Related Files: server.js:2510-2562, lib/reviewService.js:117-133/182-191/794-805/846-905/1012-1030, lib/boardReviewData.js:23-106, scripts/board_review_data.py:272-283/655-702, data/reviews/2026-11-09.json
- See Also: LRN-20261110-001
- Tags: 盘后延迟发布, 取数时点, 一次性落盘, 无回补, 补跑阈值, 数据最新性, 按类型TTL, 诚实标注
- Pattern-Key: data.late_publish_source_needs_t1_backfill
- Recurrence-Count: 1
- First-Seen: 2026-11-10
- Last-Seen: 2026-11-10

---

~~~

---

## `.learnings\FEATURE_REQUESTS.md`  ·  187 行

~~~md
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

---

## [FEAT-20261109-001] etf_monthly_include_unsettled_span

**Logged**: 2026-11-09T12:51:54+08:00
**Resolved**: 2026-11-09（版本戳 20261109a，40/40 守卫全绿 + 真实数据实测）
**Priority**: high
**Status**: resolved
**Area**: backend / frontend

### Requested Capability
用户（截图 `屏幕截图 2026-11-09 124511.png`）：「11月5日和6日的数据为什么缺少，无法区分也可以一并合计入统计表格里面。」
即：ETF 独立页「当月逐日明细」表只到 11-04、合计 3 个交易日；要求把无法拆分的 11-05 / 11-06 数据作为**多日合计**一并纳入表格与当月合计。

### User Context
11-06 残缺快照事故修复后，11-05 收盘份额已不可得，11-05 与 11-06 两天的单日申赎**永远无法拆分**；用户接受「无法区分就合计」，不愿看到数据凭空消失。

### Complexity Estimate
medium

### Suggested Implementation
根因已定位：`lib/etfFlow.js::stockMonthlyFlow()` line 868 只吃 `s.settled && !s.partial` 快照，把 `20261109.json`（盘中未定稿、shareDate 20261106）过滤掉 → 11-04→11-06 的 Δ 有数据却不进表。该函数**已内置** `spanNote` 多日合计机制（line 889-890），前端 `etfFlowPage.js:191` 也已有 `etf-month-tag` 标签样式，属「现成能力被 settled 闸门挡住」。
方案：在已定稿链之外，允许最新一份「可计算、未定稿」快照作为**一条多日合计行**纳入 rows 与 totals，行上必须标注「多日合计（20261104→20261106）· 含未定稿读数」；**累计台账仍只吃定稿值，不得混入**。输出字段不变（rows/totals/spanNote 均为既有字段），下游零改动。

### Resolution（20261109a）
- **改动（2 个文件）**：`lib/etfFlow.js::stockMonthlyFlow()` 把 Δ 计算抽成共用的 `deltaRow(p,s)`，定稿链口径逐字不变；在定稿链之后允许**最新一份**「可计算但未定稿」快照（`!settled && !partial`、披露日严格晚于最后一行、ETF 只数 ≥ 基期 × 0.8）作为一条多日合计行加入 `rows`/`totals`，带 `spanNote = 多日合计（A→B）· 含未定稿读数` 与 `provisional:true`。`public/js/etfFlowPage.js` 同步：该行淡琥珀底 + 虚线标签、合计行文案改为「N 行 · 含 1 行未定稿多日合计」、口径说明③改为明确「无法拆分到单日 / 已一并计入当月合计 / **不进入累计台账**」。`style.css` 加 `.etf-month-provisional`。
- **硬边界**：`stockMonthlyFlow()` 只读快照，不写任何状态；台账入账仍由 `computeFromSnapshots()` 的 `if (settled && !already)` 守着（守卫 §4 验证 `ledger.json` 逐字节不变）。
- **输出格式变化已同步下游**：rows 元素新增 `provisional`、返回新增 `provisionalRows`，故前端按第二条逻辑协同修改；其余字段与 API 结构不变。
- **真实数据实测**：`601318 / 202611` 由 3 行变 4 行，新增 `20261106 buy=1,430,900 / net=+1,430,900` 且带多日合计标签；当月合计 `buy=42,255,700 / sell=1,018,400 / net=41,237,300` 已含该行。
- **守卫** `scripts/test_etf_monthly_provisional.js` **40/40 全绿**：旧行为不回退 / 多日合计行与 totals / 赎回方向 / 同披露日重复 / partial / 名单缩水 / 跨月 / 多份未定稿只取最新 / 台账只读 / 前端静态接线 / **vm 沙箱真实渲染 HTML**。
- **既有回归**：`test_etf_flow.js` 58/0、`test_etf_cash_trend.js` 20/0、`test_etf_card_layout.js` 24/0、`test_etf_universe_integrity.js` 25/0 全绿；`test_etf_flow_holiday_guard.js` 仍为既有 18/1（硬编码旧版本戳），无新增失败。

### Metadata
- Frequency: first_time
- Related Features: 宽基ETF申赎独立页 / 当月逐日明细 / LRN-20261109-001、LRN-20261109-002
- Related Files: lib/etfFlow.js, public/js/etfFlowPage.js, public/css/style.css, scripts/test_etf_monthly_provisional.js, server.js, data/etf-flow/

---

## [FEAT-20261109-002] emotion_margin_card_add_short_balance

**Logged**: 2026-11-09T12:51:54+08:00
**Resolved**: 2026-11-09（版本戳 20261109a，63/63 + 15/15 + 64/64 守卫全绿，金十真实数据实测）
**Priority**: high
**Status**: resolved
**Area**: backend / frontend / data-source

### Requested Capability
用户（截图 `屏幕截图 2026-11-09 124522.png`）：「图二卡片修改：添加融券余额数据，余额增加判断为短期利空，余额减少判断为短期利好，融券余额和融资余额共用平分卡片的权重。」
即：首页情绪模型「融资余额（杠杆资金）」因子卡加入融券余额指标，方向与融资相反，两者平分该卡权重。

### User Context
卡片内容集中在上半、下半约 40% 空白（`@skill:ui-new` UI Audit），加第二指标正好可填满并做成上下/左右对称双栏。

### Complexity Estimate
complex

### Suggested Implementation
**数据源已实证可用、无需新增外呼**：`scripts/market_emotion.py::fetch_margin()` 用的 akshare `macro_china_market_margin_sh/sz()` 来自金十 `cdn.jin10.com/data_center/reports/fs_1.json` / `fs_2.json`，返回列本来就含「融券余额」（akshare 源码 `macro_china.py:900-907 / 931-939`），现有 `_to_map()` 只挑了「融资余额」列。Node 直连实证 2026-11-05：沪融资 11807.98 亿 + 深 10901.80 亿 = 22709.78 亿（与卡片 22710 亿吻合），沪融券 184.46 亿 + 深 103.65 亿 = 288.11 亿。
只需扩展 `fetch_margin()` 多解析一列并同样按「沪深双边完整日期」求和 → `out["margin"]` 增 `rqLatest/rqChange5Pct/rqDate/rqSeries`，`marketEmotionData.js` 自检同步。
**架构约束（必须让用户选型）**：`lib/marketEmotionModel.js:101` `dirOf(s)` 只认 ±1/0，`contribution = dirOf(score) × weight`（:953），总分亦按 `dirOf` 累加（:970）——把 `score` 改成 ±0.5 会被压回满格，**「平分权重」不能靠改 score 数值实现**。两条路线：① 一张卡两个子项、卡片总权重不变、净权重允许半格（需为 margin 特判 contribution/totalScore）；② 拆成两个常驻因子各占原 9% 的一半（4.5+4.5），权重总和恒 100、其它因子不动，但因子数 8→9，需同步前端标题、`FACTOR_NAMES`、自学习 `state.weights` 旧 key 兼容。

### Resolution（20261109a，用户选型：一张卡内双栏 + 沿用融资同口径）
- **数据源（零新增外呼）**：`scripts/market_emotion.py::fetch_margin()` 把 `_to_map(df)` 改成 `_to_map(df, val_name)` 并**精确匹配列名**——「融资融券余额」含子串「融券余额」，旧的 `in` 模糊匹配会误取合计列（实测误取值 11992.4 亿 vs 真实融券 288.11 亿）。新增 `_series()` 复用同一套「沪深双边完整日」口径，融资字段 `latest/prev/changePct/change5Pct/date/base5Date/partialNote/source` 名称与数值**逐字不变**，另出 `rqLatest/rqChange5Pct/rqDate/rqBase5Date/rqPartialNote/rqSource`；融券缺失只写 `rqMissingNote`，不拖累整卡。
- **模型**：`calcMargin()` 返回 `subs`（融资/融券两子项，各 50%，方向按用户口径：融券增加=-1 利空 / 减少=+1 利好）、`score = (dirRz + dirRq)/2`（0.5 步长）、`subScore:true`、`splitNote`。`FACTOR_NAMES.margin` 由「融资余额（杠杆资金）」缩为「两融余额」消除标题折行。`dirWeight(f)` 特判：该卡的净权重与总分用**原始 score**，其它 9 因子仍走 `dirOf`，因子数与权重总和 100 不变、margin key 不变（自学习旧权重兼容）。
- **输出白名单（关键接缝）**：`computeMarketEmotion` 返回 factors 时是字段白名单，必须同步透出 `subScore/subs/splitNote`——端到端渲染探针实测抓到「模型层全绿但前端双栏不渲染」，已补齐并在两个守卫里加断言。
- **前端**：`public/js/app.js` 在 `f.key==='margin' && subs.length===2` 时渲染 `.tp-comp-dual` 双栏；方向色按**语义**给（利好=红 `tp-sig-bull` / 利空=绿 `tp-sig-bear`），双栏数值与 detail 走 `esc()` 而非 `_dirColorize`——融券「+2.08%」是增加=利空，按数值符号染红会造成方向与颜色语义错位。`style.css` 新增整套双栏样式 + 520px 窄屏单列回退。
- **颜色语义实证**：金十 2026-11-05 融资 22709.8 亿 / 5日 −3.33%（撤离=利空），融券 288.11 亿 / 5日 +2.08%（增加=利空）→ 双栏同为绿色、卡片 score=-1 满格利空；渲染守卫断言 `<span class="up">+2.08%` 不出现。
- **阈值安全性**：实测近 35 个双边完整日融券 5 日变动 −4.32%~+2.63%、中位 |1.52%|、超 ±10% **0 天** → 沿用融资的 ±10% 异常闸门不会误伤。
- **守卫**：`scripts/test_emotion_margin_dual.js` **63/63**（9 种方向组合 / subs 契约 / 缺失 / 异常 / 月末阈值 / 端到端半格总分 / 其它 9 因子零改动 / Python 列匹配 / 前端接线）；`scripts/test_emotion_margin_render.js` **15/15**（真实模型输出 → vm 加载 app.js → 最终 HTML）；既有 `test_market_emotion.js` **64/64**（[14] 断言同步为 `dirVal`，夹具补 rq* 保持等价）。
- **Python 真实数据实测**：用纯标准库 `ast` 提取 `_to_map/_series` + `urllib` 直连金十 + stub DataFrame（绕过沙箱 pandas DLL 拦截），得融资 22709.8 亿 / −3.33% / 2026-11-05、融券 288.11 亿 / +2.08% / 2026-11-05，与卡片既有 22710 亿吻合。

### Metadata
- Frequency: first_time
- Related Features: 首页情绪模型 8 常驻因子 / 个股资金量能模块（已有「融券增加=做空=负面」同口径，capitalFlow.js:1160-1170）
- Related Files: scripts/market_emotion.py, lib/marketEmotionData.js, lib/marketEmotionModel.js, public/js/app.js, public/css/style.css, scripts/test_emotion_margin_dual.js, scripts/test_emotion_margin_render.js, scripts/test_market_emotion.js

---

## [FEAT-20261109-003] workbench_unify_color_semantics

**Logged**: 2026-11-09（用户指令后立即落 WAL）
**Resolved**: 2026-11-09（版本戳 20261109b，新增守卫 147/147，全量 132 套单测无新增失败）
**Priority**: high
**Status**: resolved
**Area**: frontend / css / charts / data-display

### Requested Capability
用户：`@skill:ui-new @skill:proactive-agent 统一工作台的颜色使用规则，只有利好或正面消息才能使用红色，利空或者负面消息才能使用绿色，全工作台检查一遍颜色的使用情况然后修改。`

### User Context
- WAL 已落 `D:\ai agent\2026-11-07-11-10-36\.workbuddy\memory\MEMORY.md`：红=利好/正面、绿=利空/负面、中性灰、警告/风险/数据缺口=琥珀橙；**数值符号 ≠ 方向**；适用范围含 CSS / JS 动态 class / 文案着色 / ECharts / 内联样式 / 后端 tone。
- `AskUserQuestion` 三项均选推荐：**全量统一** / **状态中性，好坏分红绿** / **符号着色本轮一起修**。
- 子代理 very thorough 只读审计覆盖 `public/css/style.css`、全部 `public/js/*.js`、8 个 HTML、`lib/*.js`、`server.js`、ECharts 色板。

### Complexity Estimate
complex（跨 CSS 100+ 规则 + 7 个前端 JS + 图表序列 + 版本戳 + 守卫）

### Resolution（20261109b）
- **CSS 三轮迁移**：① 按规则块精确迁移 109 个选择器 / 111 个规则块（AMBER 风险警告、NEUTRAL 流程状态、SWAP 好坏反转、SPECIAL 等级/旗标）；② 修复 `toSwap()` 的 rgba 二次替换缺陷（`.good`/`.bad` 曾双红）并补齐 11 个未命中；③ 收尾 47 条精确替换（删除/错误/缺口/排名热度/宏观趋势/流程状态/语义反转）。最终使用红绿的规则由 274 → **231**，方向色工具类 `.up/.down`、K 线红涨绿跌、资金流柱、融券增加=绿等**合规项零改动**。
- **语义反转修正**：`good/ok/hit/PASS/低估/鸽派/站上5日/最佳行` → 红；`bad/miss/REJECT/高估/鹰派/未站上5日` → 绿；`sl-verdict-ok/bad`（对/错）、`mt-short-foot .up/.down`（站上/未站上 5 日）原本整组反了，已互换。
- **风险/状态退出方向色**：toast 成功/失败、错误条、数据缺口、校验无效、URL 警告、成本/竞争风险等级、复盘段落状态、交易日徽标、文档徽标、上传文件名、研究评级、删除按钮、RSI 70/30 阈值、放量/缩量参考线 → 中性灰或琥珀橙。
- **文字着色器根修（本轮核心）**：`public/js/app.js::_dirColorize()` 与 `public/js/dailyReview.js::colorize()` 旧版对任意 `+X%/-X%` 机械染红绿，会把「融券余额 +2.08%」「风险敞口 +3%」「亏损扩大 +30%」误判成利好红。改为三级显式契约：自由文本只按**显式语义词**着色（含「涨跌幅」中性组合词守卫）；`{numeric:true}` 仅限已确认语义=涨跌幅的字段（`changePct`）；`{tone:'bull'|'bear'|'flat'}` 由调用方给定确定性语义方向。操作建议 / 风险提示改纯 `esc()`，不再被 `.up/.down` 的 `!important` 覆盖琥珀警示色。
- **中性内容退出方向色**：宏观趋势徽标（CPI/失业率回升≠利好）→ 中性灰；量能档位（放量≠利好）→ 暖/冷中性色 `tp-vol-active/tp-vol-quiet`；产业链上/下游、主导力量长期/短期 → 中性；股价叠加线、ETF 持仓/现金比例、两融存量柱序列 → 中性蓝/琥珀；估值警告内联红字与「重大机会」绿字 → 琥珀。
- **守卫** `scripts/test_color_semantics.js` **147/147**：L1 CSS 红绿规则集合 sha256 基线（新增用法强制人工复核）；L2 62 个禁用类 + 37 个语义映射 + 8 个琥珀必用；L3 15 条 JS 静态接线；L4 vm 沙箱真实调用 `_dirColorize` / `semanticText` 验证最终 HTML（含「+2.08% 不染红」「tone=bear 忽略符号」「changePct 仍 +红/-绿」）。
- **版本戳** `20261109a → 20261109b`：`index.html` 6 处、`etf-flow.html` 2 处、`daily-review.html` 2 处 `?v=` 同步；`etfFlowPage.js` 不在 `FRONTEND_BUST_FILES` 白名单，必须手动改。
- **回归**：全量 132 套单测 105 PASS / 27 FAIL，**27 个失败逐项核对全部为既有硬编码旧版本戳（`APP_VERSION='20261106p'` / `LAYOUT_VERSION='20261106o'`）、`logic-model.html` 入口、manual_zones 数据基线、safe-delete 阈值、空 catch 基线 +7，无一项由本轮颜色改动引入**；直接相关 10 套守卫全绿（147/63/15/64/40/25/35/42/3/27）。
- **未擅自修**：上述既有硬编码断言，按用户铁律「修既有代码前先确认」保持原状。

### Metadata
- Frequency: first_time
- Related Features: 全工作台 softDark 主题 / 两融双栏语义着色 / 复盘全文着色 / 图表色板
- Related Files: public/css/style.css, public/js/app.js, public/js/dailyReview.js, public/js/homeMacro.js, public/js/charts.js, public/js/capitalCharts.js, public/js/shareholderCharts.js, public/js/etfFlowPage.js, public/index.html, public/etf-flow.html, public/daily-review.html, server.js, scripts/test_color_semantics.js

---

## [FEAT-20261109-004] volume_rule3_align_single_source_and_fix_baseline_comparability

**Logged**: 2026-11-09T16:34:00+08:00
**Priority**: critical
**Status**: resolved（2026-11-09 全部四项裁决已落地：全引擎统一 1.3 / 同价位带最近前高 / 全个股统一 / AMP_CONFIRM 统一 1.3）
**Area**: backend / frontend / tests

### Resolution（20261109c）
用户裁决链：① 反问「工作台已经统一使用 20 日量能比来作为量能标准，为什么现在会出现其他的标准选择？」→ 明确「不应把保留第二套标准列为可选项」，属行为纠正；② 前高基准 = **同价位带最近前高**；③ 修复范围 = **全个股统一**；④ 残留 `AMP_CONFIRM = 1.5`（7 处）→ **全引擎统一到 1.3**。
落地：
- 新建 `lib/volumeCaliber.js` 作为全工作台「÷20 日均量」量能判定唯一真值源（VOL_AMP=1.3 / VOL_SHRINK=0.8 + isAmpRatio/isShrinkRatio/tierOfRatio/ratioOfVol + 基准可比性常量）。
- `lib/volumeEngine.js`：7 处 AMP_CONFIRM 与全部 SHRINK_CONFIRM 比较点接入真值源；规则3 唯一判据改为 `isAmpRatio(ratio20)`，`vol > refVol` 门槛与全窗口 argmax 删除；新增 `_pickRefHigh()`（同价位带 ±10% + 时间最近局部前高 + 上市前 5 根保护 + 除权断点 + 4×中位数异常量剔除）；前高量能降级为展示参照、无合格样本诚实披露；规则名「缩量假突破」→「假突破量能不确认」，风险标签/结论/相关字段同步；schema → `volume-engine-20261109c`。
- `lib/capitalFlow.js`：÷20 回退五档、量能热度、latestVsPriorAvg、breakout 全部接入真值源；判定改用未取整原始量比（修复 1.301 被 2 位小数取整判平量的边界互斥）。
- `lib/zoneValidity.js` / `public/js/capitalCharts.js`：÷前5日均量的原始指标保留 1.2 独立口径（页面显式标注分母、不承担判定结论），更正误导性「与 _volumeTier 同源」注释。
- `public/js/app.js` 口径说明补全覆盖范围（异常特例层 / 11.3.1 / 口诀4 / 缩量止跌 / 资金卡回退），不再只声明三处。
- 版本戳：APP_VERSION / LAYOUT_VERSION / 引擎 schema / 三个 HTML ?v= 全升 20261109c。
- 新增守卫 `scripts/test_volume_single_source.js` **63/0**：静态契约、基准可比性纯函数、威高血净 `ratio20=1.47` 端到端复刻（主轴放量 + 135 格放量 + 规则3 不命中 + 无「缩量」措辞）、前高量能不参与判定、4 只个股一致性、12 个阈值点全扫描。
- 同步更新 14 个既有守卫的 schema / ×1.5 / ×0.7 / 规则名 / 降级契约基线。量能专项 23 个守卫中 16 个全绿，其余 7 个仅因写死旧版本号（20261106p / 20261106o）失败，属历史遗留，与本轮逻辑无关。

### Requested Capability
用户（威高血净 603014 截图）：「还是出现了矛盾的结论，(第三步 · 量能 × 涨跌幅 放量 + 下跌 当日 -2.29% · 当日量/20日均量 1.47) VS (判定为无量假突破形态……量能未有效放大……命中「缩量假突破」……不得给出看多信号)。还有一个问题，2026年11月的量能用2025年5月的量能作为判断量能是否放量的标准是否合适？当时对应的股价是48左右，现在股价只是35左右，在2026年6月17日左右明明就有一个对应的前高股价38左右和量能，为什么不使用作为标准对比？」

隐含三项诉求：①同屏不得出现互斥量能结论；②「前高对应量能」基准必须与当前价位、当前分析期可比；③规则名/徽标不得把 1.47 倍放量叫成「缩量」。

### User Context
- 这是**同屏互斥第 3 次复发**（2026-10-17 三处量能结论 70% 互斥 → 2026-11-06 统一口径漏改 combo → 2026-11-09 异常特例层漏网），用户已多次明确「整个模块不应该出现不一样的量价关系判定结论」。
- 用户三条底层规则：数据一致性（单一权威源 + 五要素 + **分析期锁定**）、数据最新性、变化与边际分析；**任何规则不满足时不得输出分析结论，必须先停下来把问题解决**。当前规则3 的输出违反第一条，应视为无效结论。
- 用户铁律：修既有代码前必须先核实、修改前必须列共用清单确认、「类型 vs 个体」默认全个股统一。

### Complexity Estimate
complex（跨引擎/135格/前端口径说明/多个守卫，且涉及判定语义变更需升 LAYOUT_VERSION / SCHEMA_VERSION）

### Suggested Implementation
见 `LRN-20261109-006` 的 Details 与 Suggested Action。核心两处：
1. `lib/volumeEngine.js:761` `ampOk` 与 `:81 AMP_CONFIRM=1.5` → 接入 `pc.ratio20` / `_volumeTier` 单一真值源（阈值 >1.3），或至少让 1.3~1.5 区间不再被文案称「缩量」。
2. `lib/volumeEngine.js:764-770` `refVol` 全窗口 argmax → 改为「与当前阻力区间同价位带 + 时间最近的有效局部前高」的量能，剔除上市首日 / 极端异常值 / 跨除权断点；或整体删除 `vol > refVol` 条件。
3. 共用清单（9 类，需用户确认）：`lib/volumeEngine.js`、`lib/posModel135.js`、`lib/capitalFlow.js`、`public/js/app.js`（口径说明）、`public/js/capitalCharts.js`、`public/volume-map.html`、`lib/sameDayJudgment.js`、`lib/priceAction.js`、`scripts/test_volume_*.js`。
4. 新守卫：阈值夹缝断言（任意 ratio20∈(1.3,1.5) 不得同屏出现「放量」与「缩量」）、基准可比性断言（基准日与判定日同价位带 / 同分析期 / 非上市首日）、异常特例层纳入统一口径全量比较点扫描。

### Metadata
- Frequency: recurring（第 3 次）
- Related Features: 135 格综合判定 / 异常特例层规则3 缩量假突破 / 量能口径统一 ÷20 / 量价判定唯一结论
- See Also: LRN-20261109-006, LRN-20261106-004, LRN-20261106-001, LRN-20261020-002, docs/logic/stock-13-capital.md #12

## FEAT-20261109-005 · 每日量比趋势图改为每日20日量能比趋势

- **状态**：resolved
- **用户指令**（2026-11-09 截图，`@skill:ui-new` + `@skill:proactive-agent`）：「每日量比趋势（近60日）图表的数据由每日的量比改为每日的20日量能比，图表名字也一起改。」
- **根因/设计**：图表 `series.volumes` 仅取最后 60 根日K，若前端直接算 ÷20 前 20 天必然 null（图左 1/3 空白）。采用「后端用完整历史（~320 根）预计算 `ratio20Series` 再 `slice(-60)`」方案，与判定层 `ratio20` 同源且无空窗。
- **改动文件**：`lib/capitalFlow.js`（新增 `series.ratio20Series` 纯字段）、`public/js/capitalCharts.js`（`renderVolRatio` 消费后端序列 + 全口径 ÷20/1.3/0.8）、`public/index.html`（标题改为「每日20日量能比趋势（近60日）」）、`lib/volumeCaliber.js`（注释同步）、`scripts/test_cap_vol_ratio_chart.js`（守卫全量同步）、版本戳 `20261109c → 20261109d`。
- **验证**：`test_cap_vol_ratio_chart.js` 26/0；运行时实跑 `computeVolumeIndicators` 确认 `ratio20Series` 60 个无空窗、与 dates 等长；量能核心守卫 64/0、306/0、228/0、缓存破坏 3/0 全绿。
- **隔离**：引擎 schema 与 `LAYOUT_VERSION` 未变（本轮未改判断结构），保持 20261109c。
- **记录**：见 `SESSION-STATE.md`、工作日志 `2026-11-09.md` 同日章节。

~~~

---

## `.learnings\LEARNINGS.md`  ·  69 行

~~~md
# Learnings — Stock Analyzer

> 由 self-improvement 流程维护。格式：LRN-YYYYMMDD-XXX。
> **瘦身口径（2026-11-10）**：本文件是**索引**（每行：ID / 日期 / 状态 / 摘要首句），全部条目逐字全文在 `archive/LEARNINGS-full-20261110.md`，需要细节时按 ID 检索归档。
> 新条目只写精简版（Summary + ≤6 行 Details + Suggested Action + Metadata）；每月归档一次，主文件永远保持可全读。
> 技能提炼只在用户明确说「沉淀成技能」时才做，不自动提炼。

---

## 待办（pending / active）

- **LRN-20261103-001**（2026-11-03 · pending）位置驱动的展示分支（横盘股无主判/无参考表）会被用户感知为"这只股票版面坏了/和其他股不一样"——第三次同类报障。
- **LRN-20261106-005**（2026-11-06 · active）三条工程教训：① 守卫版本戳批量升级时负断言必须指向「上一版」并用占位符保护（m 轮曾把

## 已解决（按日期倒序，共 52 条）

- **LRN-20261110-001**（2026-11-10 · resolved）「数据最新性」不能只按自然日/交易日设 TTL，还须按数据源的实际发布时刻分级：收盘即得型（涨停池/行情快照）与盘后延迟发布型（龙虎榜等）必须有不同的就绪窗口与回补路径；否则「取数成功但取早了」会被固化成永久缺失。
- **LRN-20261109-001**（2026-11-09 · resolved）用户截图质疑「宽基 ETF 页面是不是少了一张统计个股申赎数量合计的卡片」。实证结论：代码从未删除任何卡片（本次同步 4374127 完全未触及 ETF 文件，独立页自 20261025p 起区块结构固定 7 块）；真实…
- **LRN-20261109-002**（2026-11-09 · resolved）追查「出问题的原因能不能保证不再出现」时实证复现了 LRN-20261109-001 的真正根因：不是 PCF 抓取失败，而是 selectUniverse() 的上交所分类名单查询部分失败被 catch (e) { b…
- **LRN-20261109-003**（2026-11-09 · resolved）实现 FEAT-20261109-002（两融双栏）时，calcMargin() 已正确返回 subs/splitNote/subScore，纯函数守卫 63 项、静态源码断言、既有模型守卫 64 项全部通过；但端到端渲…
- **LRN-20261109-004**（2026-11-09 · resolved）scripts/market_emotion.py::fetch_margin() 扩展解析「融券余额」列时，若沿用旧写法 if "融券余额" in str(c)，会先命中列名「融资融券余额」（字符序列 [融,资,融,券…
- **LRN-20261109-005**（2026-11-09 · resolved）app.js::_dirColorize() 与 dailyReview.js::colorize() 旧版用正则 ([+-]\d+...) 给任意带符号数值套 .up(红)/.down(绿)。这在「涨跌幅」字段是对的，…
- **LRN-20261109-006**（2026-11-09 · resolved）用户截图（威高血净 603014，行情日 2026-11-09）抓出同屏正面矛盾：第三步「量能 × 涨跌幅」判 放量 + 下跌（当日 −2.29%，当日量/20日均量 1.47），而「缩量假突破 / 结论提示」判 量能未…
- **LRN-20261106-002**（2026-11-06 · resolved）同屏「20日量价比 1.19」与「量比(20日) 1.07」被读成同一指标而报「数据不一致」，实为两个不同公式；判读前必须先还原「标签 × 公式 × 数据源」三要素。
- **LRN-20261106-003**（2026-11-06 · resolved）20261105f 新增的「135 格主判」未接入引擎既有的「量价信号/量能热度/资金行为三处同源」铁律，
- **LRN-20261106-004**（2026-11-06 · resolved）20261106j「量能分母统一 ÷20」漏改 _comboEngine 的 amplified/shrunk（仍用 ratio51.2/<0.8 旧 ÷5 链），
- **LRN-20261106-006**（2026-11-06 · resolved）跨模块「判定一致」类改动只统一了单一维度（量能）而漏掉其余维度（涨跌判定/运行状态）——
- **LRN-20261106-007**（2026-11-06 · resolved）「截图数值与实测不符」的诊断纪律：三路实测（独立重算 + 现役实例 API + 聚类明细对照）全部健康后才可定性为「陈旧异常态」，禁止无法复现时臆造根因。
- **LRN-20261106-008**（2026-11-06 · resolved）批量升版 sed 的三个盲区：① 元断言守卫（test_pos_vm_strong 遍历断言其他守卫文件含版本字符串）必须同步；② 复合引号字符串 'homeRank.js?v=20261106o' 不被 '202611…
- **LRN-20261104-002**（2026-11-04 · resolved）文案括号挂靠对象歧义：「融资余额15.7亿，净买入0.27亿（占流通市值4.46%）」括号跟在净买入后，用户读成「净买入占流通市值4.46%」，实际指融资余额占比。
- **LRN-20261103-001**（2026-11-03 · resolved）手动阻力/支撑区间此前只走标准1（无放量轻松突破→无效），未接入「放量有效突破→角色反转」生命周期，导致被突破的手动阻力一直以原方向挂在清单里。
- **LRN-20261103-002**（2026-11-03 · resolved）用户明确纠正：思维导图形态表（含横盘箱体表）不是参考，是主要判定逻辑——任何展示的判定表都必须有命中行并作为当日主判生效，全灰「参考」表被用户视为判定缺失。
- **LRN-20261103-003**（2026-11-03 · resolved）用户两条规则：①「指标分析」的总体判定必须由五维多数决决定（如 5 项中 3 项利空 → 总体利空），不得与维度方向打架；②环比无法直接从财报获得时，用各季报数据本地差分计算，并标明「本机计算」。
- **LRN-20261103-003**（2026-11-03 · resolved）新增与既有表同构的知识表时，键名凭显示文案重打而非从既有表复制——撞上「键名与显示名不同源」的既有约定，导致仅一个位置静默 miss。
- **LRN-20261103-004**（2026-11-03 · resolved）「在对应位置添加 X」类指令只覆盖了最近的语义组（趋势运行），漏了同类兄弟组（箱体）——用户以截图指认箱体组缺失，二次返工。
- **LRN-20261103-005**（2026-11-03 · resolved）参考行徽标统一写「参考」二字，把该形态的方向含义（偏多/看空/警惕/观察）整个隐藏了——用户直接问「为什么没有偏空」，信息透明度缺陷。
- **LRN-20261101-001**（2026-11-01 · resolved）量价判定主判卡的「当前位置 6 格对照表」里，非命中行（如放量上涨·偏多）也用方向色徽标（红/绿/琥珀）着色——士兰微当日实际是「平量+下跌=观察」，但表里「放量上涨·偏多」红标很显眼，用户误读为当前判多。
- **LRN-20261101-001**（2026-11-01 · unknown）
- **LRN-20261101-002**（2026-11-01 · resolved）四维度·量能状态写「60 日均量口径未确认」（暗示缺数据），同卡 60 日均量注释却给出实际比值 1.34 倍——confirm=null（60 日口径中间地带 0.7~1.5×，判「平量」）被兜底文案误写成「未确认」。
- **LRN-20261101-002**（2026-11-01 · unknown）
- **LRN-20261030-001**（2026-10-30 · resolved）同名财务指标「页面 0.37 vs 引擎 -2.39」看似矛盾，实为中报 vs 三季报口径差异；判错前必须先还原报告期链条并做双源数值闭环。
- **LRN-20261030-002**（2026-10-30 · resolved）getRecentReportDates 月份硬编码（10月→只请求到中报）导致 xjllb 系财务卡在三季报披露后整月不同步；数据抓取的「报告期可得性推断」必须对齐法定披露日历，不得按旧披露节奏猜。
- **LRN-20261030-003**（2026-10-30 · unknown）
- **LRN-20261029-004**（2026-10-29 · resolved）平安估值卡误告「引擎按月算法判定最新已披露报告期为 M=6（半年度）…数据库尚无更新期数据，请复核更新」——而用户资料库里三季报 PDF 已上传、估值配置 M=9 已更新至三季报口径。告警方向完全颠倒。
- **LRN-20261029-005**（2026-10-29 · resolved）用户报「两卡数据不一致/三季报更新出错」，排查后真因是口径差异（TTM vs 报告期累计）被旧文案「同比 -4.54%（68.44% vs 去年同期 72.98%）」隐藏——数值不同的两个口径并排出现而不标注口径，用户必…
- **LRN-20261029-006**（2026-10-29 · resolved）用户报「昨日的数据为什么无法获取？」——ETF 申赎面板沪深300 组 15 只全部「基期无快照（新入名单）」。根因：10-28 18:42 采集时 27/34 只 PCF 抓取失败，残缺快照（仅 7 只）却被 sett…
- **LRN-20261029-007**（2026-10-29 · resolved）用户报「华安证券 600909 三季报已公布，但资料库和财报解读无法同步更新」。根因：reportSync 传 --types quarterly，download_reports.py 合法键仅 annual/semi…
- **LRN-20261029-008**（2026-10-29 · resolved）用户再报「海天味业和长江证券也发布了三季报，工作台没有获取到」。修复 quarterly 静默降级后仍有两处堵点：①hasReportDoc 假阳性——docStore.year 取公告日期年份，「2026-04-28 …
- **LRN-20261029-009**（2026-10-29 · unknown）实施海天估值 V3.0（全量重算支柱）时实测：emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/{lrb,zcfzb,xjllb}AjaxNew 对裸代…
- **LRN-20261029-010**（2026-10-29 · unknown）实施长江证券 V3-五法则 E2E 验证时发现：仪表盘「手续费及佣金净收入=0 亿元 / 利息净收入=0 亿元」为假 0——东财券商利润表（lrbAjaxNew，companyType=1）根本不存在 FEE_COMMI…
- **LRN-20261029-011**（2026-10-29 · unknown）华安证券估值引擎升级 V3.0 异步数据自适应架构（用户下发十四规则规范）：旧架构固定影子股权重 50/40/10 的问题在于无视「该方法依赖的数据是否新鲜」。新架构为每个指标生成数据契约（期差/容忍期差/成熟度绿黄红）…
- **LRN-20261029-012**（2026-10-29 · unknown）士兰微估值引擎升级数据治理升级版（用户下发规范）：旧模型静态配置（2025 年报作 DCF 基数、净债务 52.43 假设值）的问题在于每次财报更新需人工改年份。新机制：东财三表实时拉取 + 锚点自动识别（三季报→中报→…
- **LRN-20261028-001**（2026-10-28 · resolved）volumeEngine 规则3「缩量假突破」盘中误触发：用「当日未走完的累计量」与「前高全天量/60日均量×1.5」直接比较，上午结构上必然判「未有效放大」→ 假命中。
- **LRN-20261028-002**（2026-10-28 · resolved）笔记云端同步（pushToServer）失败完全静默：catch 只 console.warn，且 HTTP 500 时 fetch 不抛错未检查 resp.ok——用户写的大盘记录「股市口诀坑」保存失败后丢失，全程无任…
- **LRN-20261028-003**（2026-10-28 · resolved）个股页「大盘」因子引用首页「市场情绪提醒」（中性·关注，-3.9 分）却标「利空」徽标 + 「权重 -13%」——单源引用被渲染层重新判档，违反单源同义。
- **LRN-20261025-001**（2026-10-25 · resolved）判断卡片评分展示口径连续三轮反复（删得分 → 要回得分 → 权重=评分），每轮只按字面单向执行，未先对齐"最终卡片形态"就动手。
- **LRN-20261020-001**（2026-10-20 · unknown）情绪准确率台账「已结算数永久少于已记录数」：2026-10-18（周日）日线通道瞬时失败，baselineDate 兜底为 today=周日，留档基准日落非交易日 → 上证无该日 K 线 → settleRecord 的…
- **LRN-20261020-002**（2026-10-20 · resolved）个股量能卡同时显示「该放量未放量，资金没有跟上」+「该缩量反放巨量，分歧未结束」——两个互斥期望同时命中（用户截图报障）。根因是该放量/该缩量两侧场景清单独立收集，「低位区间+前期平台整理」无条件同时进两侧，且该缩量侧的…
- **LRN-20261019-001**（2026-10-19 · resolved）个股页「资金量能」内三处量能结论互相矛盾——量价信号（缩量回调）/ 量能热度（量能平稳）/ 量能分析·资金行为（平量下跌）。用户原话：「这些结论严重的违反了工作台的核心逻辑数据的一致性」。实测 20 只样本 14 只（7…
- **LRN-20261019-002**（2026-10-19 · resolved）用户连续两轮反馈量比与东方财富 App 不一致（000783 长江证券 → 20261019a 修复；000902 新洋丰 → 本条 20261019b）。第一轮修复后同类缺陷换了形态复发：同花顺当日 bar 带「今日日…
- **LRN-20261019-003**（2026-10-19 · resolved）用户指令：「把模型的量比数据直接向 mcp 或通过腾讯或者同花顺等数据源取值，不要在本地工作台进行计算」。量比（volume ratio）改为数据源直采，不再在本地用「今日量 ÷ 前 5 日均量」重算。
- **LRN-20261019-004**（2026-10-19 · resolved）用户提供「什么时候该放量/该缩量」规范性判定清单（📈该放量 4 类 / 📉该缩量 4 类 / 💎位置决定性质），要求去重后补入模型。覆盖度比对：6 类与既有规则重复（不补），4 类缺口补入 _expectedVol…
- **LRN-20261019-005**（2026-10-19 · resolved）量价信号标签「量价齐跌」与解释「下跌放量」自相矛盾（用户海天味业 603288 截图报障「严重违反工作台核心原则」）：capitalFlow.js 下跌分支 amp 档标签是 20 日窗口时代的遗留词（义为价跌+20日量…
- **LRN-20261019-006**（2026-10-19 · resolved）缩量定档标准与市场标准矛盾（用户新洋丰 000902 截图报障：量比(÷5日均量) 0.99 却显示「缩量上涨」/量能热度「缩量」）：_volumeTier 定档写为 amplified = confirm==='放量'…
- **LRN-20260930-003**（2026-09-30 · resolved）首页「今日财经热点」新闻→板块关联误判：「风电设备板块表现活跃」被误归「医疗器械」。根因是医疗器械词表把裸通用词「设备」当专属词（×3 分），而「风电设备」命中该子串。这是同类「泛词抢答」第 3 次复发（① 消费→食品饮…
- **LRN-20260928-001**（2026-09-28 · resolved）个股「短期行情判定」记录此前只在用户打开该个股页时才生成（GET /api/sameday-judgment/:symbol → getJudgmentWithAccuracy → buildJudgment+saveJ…
- **LRN-20260928-002**（2026-09-28 · resolved）日K线历史取数全线失效：所有个股 getHistory(sym,'6m') 返回 0 根 → 日K线图空白、策略回测报「历史数据不足（0 根）」。实时行情(qt.gtimg.cn)与 60 分钟 K 线(ifzq.gti…
- **LRN-20260923-001**（2026-09-23 · resolved）「证券交易所」被关键词 '证券' 字面命中 → 境外交易所的本地规则被误归到 A 股券商板块，并经「论坛热度 +1 跨阈值」放大 4 倍权重、锁 105 天，最终成为华安证券（600909）短期判断里的事件驱动利空。

~~~

---

## `启动诊断.bat`  ·  69 行

~~~bat
@echo off
chcp 65001 >nul 2>&1
title Stock Analyzer 启动（诊断模式）
REM ============================================================================
REM 备用启动器（诊断模式）：当双击桌面图标没反应时，双击本文件即可启动工作台。
REM 与 start.vbs 的区别：本文件不隐藏窗口，会把每一步都打印出来，便于定位问题。
REM 20261005b 新增：配合修复 start.vbs「Node 路径写死导致静默失败」的问题。
REM ============================================================================
cd /d "%~dp0"
set "PORT=3005"
set "SA_NO_BG_AI=1"

echo ============================================
echo   Stock Analyzer 启动（诊断模式）
echo ============================================
echo.
echo [1/5] 清理占用 3005 的旧服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3005" ^| findstr LISTENING') do (
    echo       杀掉 PID %%a
    taskkill /F /PID %%a >nul 2>&1
)
ping -n 2 127.0.0.1 >nul 2>&1

echo [2/5] 定位 Node.js...
set "NODE_ROOT=C:\Users\16507\.workbuddy\binaries\node\versions"
set "MANAGED_NODE="
if exist "%NODE_ROOT%\current" for /f "usebackq delims=" %%V in ("%NODE_ROOT%\current") do call :TryNode "%NODE_ROOT%\%%V\node.exe"
if not defined MANAGED_NODE if exist "%NODE_ROOT%" for /d %%D in ("%NODE_ROOT%\*") do call :TryNode "%%D\node.exe"

if defined MANAGED_NODE (
    set "NODE_EXE=%MANAGED_NODE%"
    echo       找到: %MANAGED_NODE%
) else (
    where node >nul 2>&1
    if not errorlevel 1 (
        set "NODE_EXE=node"
        echo       使用 PATH 中的 node
    ) else (
        echo.
        echo [错误] 未找到 Node.js，无法启动。
        echo        已检查目录: %NODE_ROOT%
        echo        请把这段文字截图发给开发者。
        echo.
        pause
        exit /b 1
    )
)
goto :AfterNodePick

:TryNode
if not defined MANAGED_NODE if exist "%~1" set "MANAGED_NODE=%~1"
exit /b 0

:AfterNodePick

echo [3/5] 启动服务（前台运行，关闭本窗口即停止服务）...
echo [4/5] 就绪后浏览器会自动打开；若没弹出，手动访问 http://localhost:3005
echo [5/5] 地址: http://localhost:3005
echo.

REM 后台延迟开浏览器（不阻塞下面前台 node）
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:3005"

"%NODE_EXE%" server.js

echo.
echo [服务已停止] 若上方有红色报错，请把报错内容发给开发者。
pause

~~~

---

## `kill_port_3005.bat`  ·  5 行

~~~bat
@echo off
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3005" ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

~~~

---

## `logs\server.log`  ·  120 行

~~~log
[DB] sqlite ready at D:\stock analyzer\stock-analyzer\data\stock_analyzer.db
(node:26852) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

  Stock Analyzer 已启动： http://localhost:3005
  （浏览器由启动器打开，此处跳过以避免重复开窗）

[ensureTracked] 完成：新建 0 · 复用 8 · 跳过 0（targetDate=2026-11-11）
  [每日复盘] 定时调度已启动：15:35 主跑 + 15:40/45/50 补跑 + 20:30 龙虎榜补录 + 次日兜底（Asia/Shanghai，先查 trade_calendar 表）
  [事件] 后台 AI 总开关(SA_NO_BG_AI=1)已启用，跳过事件定时扫描（不再自动调用 LLM，停止后台静默计费）
  [专属因子] 后台 AI 总开关(SA_NO_BG_AI=1)已启用，跳过专属因子月度定时触发（不再自动调用 LLM，停止后台静默计费）
  [自动判定·自选股] 新建 0 · 已存在 8 · 跳过 0（共 8 只）
[Analysis] Fetching data for 601318...
[SectorIdentity] 601318  → 保险 (source=code-override, conf=1)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 价值型 (value)
[Analysis] Fetching data for 600909...
[SectorIdentity] 600909  → 证券 (source=code-override, conf=1)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 均衡型 (balanced)
[Analysis] Fetching data for 000783...
[SectorIdentity] 000783 个股研报无 induCode，按行业兜底 证券=473
[SectorIdentity] 000783  → 证券 (source=code-override, conf=1)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 均衡型 (balanced)
[Analysis] Fetching data for 600460...
  [FundMatrix] 季度检查(启动补偿)：跳过(already-ran-today)
[SectorIdentity] F10 failed: 600460 timeout of 10000ms exceeded
[SectorIdentity] 600460  → 半导体 (source=code-override, conf=1)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 均衡型 (balanced)
[Analysis] Fetching data for 688289...
[SectorIdentity] 688289  → 医疗器械 (source=code-override, conf=1)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 均衡型 (balanced)
[Analysis] Fetching data for 603288...
[SectorIdentity] 603288  → 食品饮料 (source=code-override, conf=1)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 价值型 (value)
[Analysis] Fetching data for 000902...
[SectorIdentity] 000902  → 农业 (source=f10-sshy, conf=0.75)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 均衡型 (balanced)
[Analysis] Fetching data for 603014...
[SectorIdentity] 603014  → 医疗器械 (source=f10-sshy, conf=0.75)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 均衡型 (balanced)
[Analysis] Fetching data for 002643...
[SectorIdentity] 002643  → 电子 (source=f10-sshy, conf=0.75)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 均衡型 (balanced)
[Analysis] Fetching data for 300319...
[SectorIdentity] 300319  → 电子 (source=code-override, conf=1)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 均衡型 (balanced)
[Analysis] Fetching data for 601628...
[SectorIdentity] 601628  → 保险 (source=code-override, conf=1)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 价值型 (value)
[Analysis] Fetching data for 600030...
[SectorIdentity] 600030  → 证券 (source=code-override, conf=1)
[Analysis] Quote: OK, History: 321 bars, Profile: OK
[Analysis] Company type: 价值型 (value)
  [分析预热] 12 只（自选 8 + 最近 12，去重后）：成功 12 · 失败 0 · 耗时 32.5s

  [结算] 触发每日 15:30 盘后结算 + 自学习自动复核（2026-11-10）...
[ensureTracked] 完成：新建 0 · 复用 8 · 跳过 0（targetDate=2026-11-11）
  [大盘AI复盘] 跳过：2026-11-10 已有 AI 大盘复盘记录
  [自动判定·自选股] 新建 0 · 已存在 8 · 跳过 0（共 8 只）
[Analysis] cache hit for 601318 (age 39s)
  [大盘技术] 每日判断已落盘：2026-11-10
[Analysis] cache hit for 600909 (age 38s)
[Analysis] cache hit for 000783 (age 37s)
[Analysis] cache hit for 600460 (age 27s)
[Analysis] cache hit for 688289 (age 24s)
[Analysis] cache hit for 603288 (age 23s)
[Analysis] cache hit for 000902 (age 22s)
[Analysis] cache hit for 603014 (age 20s)
  [数据巡检] 2026-11-10：8 只自选股，不一致 0 项 / 口径注记 0 项 / 缺数据跳过 3 项
  [情绪模型] 每日判断已落盘：2026-11-10 情绪总分 -0.095（中性）
  [SectorCrowding] 盘后历史回填: {"ok":false,"written":0,"total":0,"error":"backfill already running"}
  [SectorCrowding] 盘后历史回填: {"ok":true,"written":21,"total":60,"source":"同花顺·行业板块","failures":0}
[Analysis] cache hit for 603288 (age 194s)
[SectorIdentity] 603288 海天味业 → 食品饮料 (source=code-override, conf=1)
[SectorIdentity] 603288 海天味业 → 食品饮料 (source=code-override, conf=1)
[SectorIdentity] 603288 海天味业 → 食品饮料 (source=code-override, conf=1)
[DeepAnalysis] Request for 603288 (refresh=false)...
[Cache] invalidating 603288 (version mismatch)
[CapitalFlow] Starting for 603288...
[Shareholders] Fetching for 603288...
[DeepAnalysis] Starting for 603288...
[DeepAnalysis] Found 28 local documents for 603288
[DeepAnalysis] Company type: Product
[DeepAnalysis] Fetching financial data for SH603288...
[DB] persisted 14 dividend records for 603288
[DeepAnalysis] Income: 9, Balance: 5, Cashflow: 9
[DeepAnalysis] EastMoney TTM valuation: 9 points (东方财富TTM)
[DB] persisted valuation scalars for 603288
[DeepAnalysis] Company classification: 价值型 (value)
[DeepAnalysis] Classification data: marketCap=2072.27亿, PE=29.18, divYield=2.26%, revGrowth=39.68%, roe=13.29%
[StockSectorLevels] 603288 海天味业 → 一级:食品饮料(BK0438) / 二级:调味发酵品Ⅱ(BK1278) / 三级:调味发酵品Ⅲ(BK1576)
[CapitalFlow] Starting for 603288...
[DeepAnalysis] Optional: segment=ok
[DeepAnalysis] Dividend yield: 10 years, mean=1.35%, current=2.26%
[DeepAnalysis] Request for 603288 (refresh=false)...
[DeepAnalysis] Serving cached result for 603288
[DeepAnalysis] Found 28 local documents for 603288
[CapitalFlow] Starting for 603288...
[HotTopics] analyzeTrendingTopics LLM failed: LLM 超时 60000ms
  [结算·技术分析] 大盘技术分析 短期命中率 42.4%（已结算 33 条）/ 中期 85.7%（已结算 14 条）；个股技术面 新结算 0 条；市场情绪提醒 新结算 0 条，命中率 35.5%
  [结算] 已结算 391 条，准确率 51.7%，待结算 8 条
  [自学习·归因] 最近 15 笔判断错误的误导因子已标记，权重已按命中率自动调整
  [自学习·cn-scraper] 对 8 只误判个股拉取财报解读+全网舆情
  [自学习·情绪指数] 情绪指数 0.349 已存档；学习样本 30675 命中 24075（阈值 1.5）
  [结算·技术分析] 大盘技术分析 短期命中率 42.4%（已结算 33 条）/ 中期 85.7%（已结算 14 条）；个股技术面 新结算 0 条；市场情绪提醒 新结算 0 条，命中率 35.5%
  [结算] 已结算 391 条，准确率 51.7%，待结算 8 条
  [自学习·归因] 最近 15 笔判断错误的误导因子已标记，权重已按命中率自动调整
  [自学习·cn-scraper] 对 8 只误判个股拉取财报解读+全网舆情
  [自学习·情绪指数] 情绪指数 0.349 已存档；学习样本 30663 命中 24064（阈值 1.5）

~~~

---

## `make_shortcut.bat`  ·  9 行

~~~bat
@echo off
REM 20261005b：快捷方式改为「显式调用 wscript.exe + 脚本路径作为参数」，
REM 不再依赖 .vbs 文件关联。若系统安全策略/杀软禁用了 .vbs 关联，
REM 旧写法（TargetPath 直接指向 start.vbs）会双击毫无反应；显式指定宿主可绕开该问题。
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=New-Object -ComObject WScript.Shell; $d=$s.SpecialFolders('Desktop'); $lnk=Join-Path $d 'Stock Analyzer.lnk'; $sc=$s.CreateShortcut($lnk); $sc.TargetPath=(Join-Path $env:SystemRoot 'System32\wscript.exe'); $sc.Arguments='\"D:\stock analyzer\stock-analyzer\start.vbs\"'; $sc.WorkingDirectory='D:\stock analyzer\stock-analyzer'; $sc.IconLocation='D:\stock analyzer\stock-analyzer\icon.ico,0'; $sc.Description='Stock Analyzer'; $sc.WindowStyle=7; $sc.Save(); Write-Host ('OK: '+[string]$lnk)"
echo.
echo If you see "OK:" above, the desktop shortcut was created successfully.
pause

~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_025ac324.md`  ·  5 行

~~~md
## 中国平安(601318.SH)的新业务价值(寿险)

| 中国平安(601318.SH) | 2026中报 | 2026一季报 | 2025年报 | 2024年报 | 2023年报 | 2022年报 | 2021年报 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 新业务价值(寿险) | 248.5亿元 | 155.7亿元 | 369亿元 | 400.2亿元 | 310.8亿元 | 288.2亿元 | 379亿元 |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_07ae0db8.md`  ·  5 行

~~~md
## 中国平安(601318.SH)的新业务价值(寿险)

| 中国平安(601318.SH) | 2026中报 | 2026一季报 | 2025年报 | 2025三季报 | 2025中报 | 2025一季报 |
| --- | --- | --- | --- | --- | --- | --- |
| 新业务价值(寿险) | 248.5亿元 | 155.7亿元 | 369亿元 | 357.2亿元 | 223.4亿元 | 128.9亿元 |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_238c37ee.md`  ·  5 行

~~~md
## 中国平安(601318.SH)的总投资收益率

| 中国平安(601318.SH) | 2026一季报 | 2025中报 | 2025一季报 |
| --- | --- | --- | --- |
| 总投资收益率 | 0.8% | 6.2% | 5.2% |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_2b74088e.md`  ·  5 行

~~~md
## 中国平安(601318.SH)的总投资收益率

| 中国平安(601318.SH) | 2026一季报 |
| --- | --- |
| 总投资收益率 | 0.8% |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_3d468810.md`  ·  5 行

~~~md
## 中国平安(601318.SH)的总投资收益率

| 中国平安(601318.SH) | 2026一季报 | 2025中报 | 2025一季报 |
| --- | --- | --- | --- |
| 总投资收益率 | 0.8% | 6.2% | 5.2% |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_3fc5381d.md`  ·  117 行

~~~md
## 华安证券(600909.SH)的公司基本信息

| 华安证券(600909.SH) |  |
| --- | --- |
| 公司基本信息 | 【股票代码】600909.SH【公司简介】华安证券股份有限公司，源自1991年成立的安徽省证券公司，2001年整合资源成立华安证券有限责任公司，2012年整体变更为股份公司，并于2016年在上海证券交易所上市（股票代码：600909）。作为安徽省属一级企业，华安证券业务牌照齐全，内控体系完善，全资拥有资产管理、私募基金、另类投资、期货、投资咨询及国际业务子公司，控股公募基金公司，参股股权服务公司，形成集团化发展框架。公司深耕财富管理、投资银行、资产管理、股权投资等业务，致力于为客户提供综合化、一站式、全生命周期的投融资解决方案。华安证券在行业排名中整体居于前三分之一，部分业务指标进入前四分之一，尤其在证券经纪、资产管理、私募投资、并购重组等领域表现突出。公司坚持党的金融工作方针，以“综合化布局、特色化突破”为发展路径，以“稳中求进、进中有新”为工作总基调，以资本、人才、科技、文化为驱动，致力于打造服务新兴产业的创新型投行和专业财富管理机构，目标全面进军行业前四分之一位次。【主营产品】证券自营业务投资股票、基金、债券等金融资产【办公地址】安徽省合肥市滨湖新区紫云路1018号【公司第一大股东】安徽省国有资本运营控股集团有限公司【公司第一大股东持股比例】24.18% |

## 华安证券(600909.SH)当前的市盈率(TTM)行业排名、

| 华安证券(600909.SH) | 2026-08-26 11:30 |
| --- | --- |
| 市盈率(TTM)行业排名 | 16 |
| 市净率行业排名 | 36 |
| 市销率(TTM)行业排名 | 30 |
| 市现率(TTM)行业排名 | 26 |
| 涨跌幅 | 2.96% |
| 5日涨跌幅 | 3.47% |
| 成交额 | 9.437亿 |
| 成交量 | 1.139亿 |
| 开盘价 | 8.11 |
| 最高价 | 8.44 |
| 最新价 | 8.36 |
| 均价 | 8.29 |
| 最低价 | 8.11 |
| 换手率 | 2.27% |
| 振幅 | 4.06% |
| 是否涨停 | 0 |
| 是否跌停 | 0 |
| 当日DDX | 0.388 |
| 当日DDY | 0.846 |
| 当日DDZ | 49.91 |
| 超大单净流入资金 | 6215万元 |
| 超大单流出资金 | 1.155亿元 |
| 超大单流入资金 | 1.776亿元 |
| 大单净流入资金 | 9973万元 |
| 大单流出 | 2.034亿元 |
| 大单流入 | 3.031亿元 |
| 中单净流入资金 | -4326万元 |
| 中单流出 | 2.997亿元 |
| 中单流入 | 2.565亿元 |
| 小单净流入资金 | -1.186亿元 |
| 小单流出 | 3.226亿元 |
| 小单流入 | 2.04亿元 |
| 主力净流入资金 | 1.619亿元 |
| 3日DDX | 0.443 |
| 3日DDY | 1.968 |
| 5日DDX | 0.244 |
| 5日DDY | 1.826 |
| 10日DDX | -0.176 |
| 10日DDY | 2.447 |

## 华安证券(600909.SH)当前的市销率(TTM)、市现率(

| 华安证券(600909.SH) | 2026-08-26 11:30 |
| --- | --- |
| 市销率(TTM) | 6.32 |
| 市现率(TTM) | 5.46 |
| 主力流出(元) | 3.189亿 |
| 主力流入(元) | 4.808亿 |

## 华安证券(600909.SH)的3年市盈率历史百分位、3年市净

| 华安证券(600909.SH) | 2026-08-25 | 2026-08-24 | 2026-08-21 | 2026-08-20 | 2026-08-19 |
| --- | --- | --- | --- | --- | --- |
| 3年市盈率历史百分位 | 0% | 90.47% | 89.92% | 85.64% | 87.02% |
| 3年市净率PB历史百分位 | 93.79% | 94.48% | 94.34% | 92.69% | 92.97% |
| 3年市销率PS百分位 | 60.08% | 95.3% | 95.03% | 94.2% | 94.34% |
| 3年市现率PCF百分位数 | 36.04% | 41.22% | 40.32% | 36.71% | 37.16% |

## 华安证券(600909.SH)的市盈率PE(TTM)、市净率P

| 华安证券(600909.SH) | 2026-08-25(日) | 2026-08-24(日) | 2026-08-21(日) | 2026-08-20(日) | 2026-08-19(日) |
| --- | --- | --- | --- | --- | --- |
| 市盈率PE(TTM) | 12.87倍 | 20.4倍 | 20.35倍 | 20.03倍 | 20.13倍 |
| 市净率PB | 1.494倍 | 1.506倍 | 1.503倍 | 1.479倍 | 1.486倍 |
| 市现率PCF(TTM,经营现金流) | 5.302倍 | 5.416倍 | 5.403倍 | 5.317倍 | 5.344倍 |
| 市销率PS(TTM) | 6.134倍 | 8.572倍 | 8.551倍 | 8.415倍 | 8.457倍 |
| 市现率PCF(TTM,现金净流量) | 2.983 | 3.766 | 3.757 | 3.697 | 3.716 |
| 成交量 | 9722万股 | 1.128亿股 | 7661万股 | 8898万股 | 1.278亿股 |
| 开盘价 | 8.09元 | 8.16元 | 8.03元 | 8.16元 | 8.2元 |
| 收盘价 | 8.12元 | 8.19元 | 8.17元 | 8.04元 | 8.08元 |
| 成交额 | 7.856亿 | 9.219亿 | 6.229亿 | 7.174亿 | 10.49亿 |
| 换手率 | 1.935% | 2.245% | 1.525% | 1.771% | 2.544% |
| 涨跌幅 | -0.8547% | 0.2448% | 1.617% | -0.495% | -2.885% |
| 是否涨停 | 否 | 否 | 否 | 否 | 否 |
| 大单流出资金 | 1.593亿 | 1.906亿 | 1.482亿 | 2.162亿 | 2.822亿 |
| 小单流出资金 | 2.891亿 | 3.365亿 | 2.027亿 | 1.719亿 | 2.683亿 |
| 超大单流出资金 | 8609万 | 1.162亿 | 6062万 | 9155万 | 1.825亿 |
| 中单流出资金 | 2.384亿 | 2.693亿 | 2.006亿 | 2.285亿 | 3.005亿 |
| 小单净流入资金 | -3784万元 | -4016万元 | 631.5万元 | 8123万元 | 4980万元 |
| 主力净流入资金 | 3609万 | -1421万 | 853万 | -8889万 | -3610万 |
| 大单净流入资金 | 2635万元 | 2332万元 | -307万元 | -5713万元 | -1171万元 |
| 超大单净流入资金 | 973.9万元 | -3753万元 | 1160万元 | -3177万元 | -2439万元 |
| 主力流入资金 | 2.815亿元 | 2.926亿元 | 2.174亿元 | 2.188亿元 | 4.287亿元 |
| 主力流出资金 | 2.454亿元 | 3.068亿元 | 2.089亿元 | 3.077亿元 | 4.648亿元 |

## 华安证券(600909.SH)的营业总收入、营业收入等

| 华安证券(600909.SH) | 2026中报 | 2026一季报 | 2025年报 | 2025三季报 | 2025中报 | 2025一季报 |
| --- | --- | --- | --- | --- | --- | --- |
| 营业总收入 | 40.07亿元 | 9.722亿元 | 50.68亿元 | 44.23亿元 | 28.08亿元 | 14.31亿元 |
| 营业收入 | 40.07亿元 | 9.722亿元 | 50.68亿元 | 44.23亿元 | 28.08亿元 | 14.31亿元 |
| 净利润 | 20.96亿元 | 4.421亿元 | 21.11亿元 | 18.9亿元 | 10.35亿元 | 5.244亿元 |
| 归属于母公司股东的净利润 | 20.97亿元 | 4.333亿元 | 21.08亿元 | 18.83亿元 | 10.35亿元 | 5.246亿元 |
| 经营活动产生的现金流量净额 | 52.23亿元 | 32.34亿元 | 65.39亿元 | 50.93亿元 | 40.68亿元 | 21.76亿元 |
| 每股收益EPS(基本) | 0.43元 | 0.09元 | 0.45元 | 0.4元 | 0.22元 | 0.11元 |
| 净资产收益率ROE(加权) | 8.08% | 1.79% | 9.11% | 8.16% | 4.52% | 2.32% |
| 总资产周转率 | 0.03561次 | 0.008927次 | 0.04843次 | 0.04219次 | 0.02737次 | 0.01397次 |
| 归属母公司股东的净利润同比增长率 | 102.5% | -17.4% | 41.92% | 64.71% | 44.94% | 87.79% |
| 资产负债率 | 76.95% | 76.28% | 77.52% | 77.73% | 77.3% | 77.53% |
| 销售净利率 | 52.32% | 45.48% | 41.65% | 42.72% | 36.87% | 36.64% |

## 华安证券(600909.SH)当前的支撑位、压力位

| 华安证券(600909.SH) | 2026-08-26 11:30 |
| --- | --- |
| 支撑位 | 7.47 |
| 压力位 | 8.54 |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_401f2761.md`  ·  5 行

~~~md
## 中国平安(601318.SH)的新业务价值(寿险)

| 中国平安(601318.SH) | 2026中报 | 2026一季报 |
| --- | --- | --- |
| 新业务价值(寿险) | 248.5亿元 | 155.7亿元 |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_4b873186.md`  ·  5 行

~~~md
## 中国平安(601318.SH)的总投资收益率

| 中国平安(601318.SH) | 2026一季报 | 2025中报 | 2025一季报 |
| --- | --- | --- | --- |
| 总投资收益率 | 0.8% | 6.2% | 5.2% |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_4f9d72e5.md`  ·  5 行

~~~md
## 中国平安(601318.SH)保费-原保险保费收入(2025-

| 指标名称 | 数值类型 | 2026-06-30 | 2026-03-31 | 2025-12-31 | 2025-09-30 |
| --- | --- | --- | --- | --- | --- |
| 原保险保费收入 | 期末值 | 17875100万元 | 9095100万元 | 34316800万元 | 25624700万元 |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_6f3cad96.md`  ·  29 行

~~~md
## 中国平安(601318.SH)主营构成分析(2026-06-3

| 类型 | 主营构成 | 主营业务收入(元) | 主营业务收入占比 | 主营成本(元) | 主营成本占比 | 主营利润(元) | 主营利润占比 | 毛利率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 产品 | 寿险及健康险 | 2694亿 | 46.84% | 2006亿 | 45.15% | 687.8亿 | 52.58% | 25.53% |
|  | 财产保险 | 1790亿 | 31.13% | 1659亿 | 37.34% | 131.4亿 | 10.05% | 7.34% |
|  | 银行 | 706.2亿 | 12.28% | 397.9亿 | 8.96% | 308.3亿 | 23.56% | 43.66% |
|  | 资产管理 | 426.6亿 | 7.42% | 283.3亿 | 6.38% | 143.3亿 | 10.95% | 33.59% |
|  | 金融赋能 | 224.9亿 | 3.91% | 221.4亿 | 4.98% | 3.55亿 | 0.27% | 1.58% |
|  | 内部抵销 | -90.68亿 | -1.58% | -124.5亿 | -2.80% | 33.87亿 | 2.59% | -37.35% |
|  | 合计 | 5751亿 | 100.00% | 4443亿 | 100.00% | 1308亿 | 100.00% | 22.75% |
| 地区 | 中国大陆 | 2625亿 | 45.64% | - | - | - | - | - |
|  | 其他项目 | 3126亿 | 54.36% | - | - | - | - | - |
|  | 合计 | 5751亿 | 100.00% | - | - | - | - | - |

## 中国平安(601318.SH)主营构成分析(2025-12-3

| 类型 | 主营构成 | 主营业务收入(元) | 主营业务收入占比 | 主营成本(元) | 主营成本占比 | 主营利润(元) | 主营利润占比 | 毛利率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 产品 | 寿险及健康险 | 5022亿 | 47.80% | 3779亿 | 43.80% | 1243亿 | 66.22% | 24.75% |
|  | 财产保险 | 3533亿 | 33.63% | 3342亿 | 38.73% | 190.7亿 | 10.16% | 5.40% |
|  | 银行 | 1314亿 | 12.51% | 800.3亿 | 9.28% | 514.1亿 | 27.39% | 39.11% |
|  | 资产管理 | 513.5亿 | 4.89% | 475.1亿 | 5.51% | 38.38亿 | 2.05% | 7.48% |
|  | 金融赋能 | 493.6亿 | 4.70% | 486.9亿 | 5.64% | 6.71亿 | 0.36% | 1.36% |
|  | 内部抵销 | -370.8亿 | -3.53% | -255亿 | -2.96% | -115.8亿 | -6.17% | 31.23% |
|  | 合计 | 10505亿 | 100.00% | 8628亿 | 100.00% | 1877亿 | 100.00% | 17.87% |
| 地区 | 中国大陆 | 4392亿 | 41.81% | - | - | - | - | - |
|  | 其他项目 | 6113亿 | 58.19% | - | - | - | - | - |
|  | 合计 | 10505亿 | 100.00% | - | - | - | - | - |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_7783f10f.md`  ·  29 行

~~~md
## 中国平安(601318.SH)主营构成分析(2026-06-3

| 类型 | 主营构成 | 主营业务收入(元) | 主营业务收入占比 | 主营成本(元) | 主营成本占比 | 主营利润(元) | 主营利润占比 | 毛利率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 产品 | 寿险及健康险 | 2694亿 | 46.84% | 2006亿 | 45.15% | 687.8亿 | 52.58% | 25.53% |
|  | 财产保险 | 1790亿 | 31.13% | 1659亿 | 37.34% | 131.4亿 | 10.05% | 7.34% |
|  | 银行 | 706.2亿 | 12.28% | 397.9亿 | 8.96% | 308.3亿 | 23.56% | 43.66% |
|  | 资产管理 | 426.6亿 | 7.42% | 283.3亿 | 6.38% | 143.3亿 | 10.95% | 33.59% |
|  | 金融赋能 | 224.9亿 | 3.91% | 221.4亿 | 4.98% | 3.55亿 | 0.27% | 1.58% |
|  | 内部抵销 | -90.68亿 | -1.58% | -124.5亿 | -2.80% | 33.87亿 | 2.59% | -37.35% |
|  | 合计 | 5751亿 | 100.00% | 4443亿 | 100.00% | 1308亿 | 100.00% | 22.75% |
| 地区 | 中国大陆 | 2625亿 | 45.64% | - | - | - | - | - |
|  | 其他项目 | 3126亿 | 54.36% | - | - | - | - | - |
|  | 合计 | 5751亿 | 100.00% | - | - | - | - | - |

## 中国平安(601318.SH)主营构成分析(2025-12-3

| 类型 | 主营构成 | 主营业务收入(元) | 主营业务收入占比 | 主营成本(元) | 主营成本占比 | 主营利润(元) | 主营利润占比 | 毛利率 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 产品 | 寿险及健康险 | 5022亿 | 47.80% | 3779亿 | 43.80% | 1243亿 | 66.22% | 24.75% |
|  | 财产保险 | 3533亿 | 33.63% | 3342亿 | 38.73% | 190.7亿 | 10.16% | 5.40% |
|  | 银行 | 1314亿 | 12.51% | 800.3亿 | 9.28% | 514.1亿 | 27.39% | 39.11% |
|  | 资产管理 | 513.5亿 | 4.89% | 475.1亿 | 5.51% | 38.38亿 | 2.05% | 7.48% |
|  | 金融赋能 | 493.6亿 | 4.70% | 486.9亿 | 5.64% | 6.71亿 | 0.36% | 1.36% |
|  | 内部抵销 | -370.8亿 | -3.53% | -255亿 | -2.96% | -115.8亿 | -6.17% | 31.23% |
|  | 合计 | 10505亿 | 100.00% | 8628亿 | 100.00% | 1877亿 | 100.00% | 17.87% |
| 地区 | 中国大陆 | 4392亿 | 41.81% | - | - | - | - | - |
|  | 其他项目 | 6113亿 | 58.19% | - | - | - | - | - |
|  | 合计 | 10505亿 | 100.00% | - | - | - | - | - |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_8ccd89e0.md`  ·  29 行

~~~md
## 半导体(申万)(指数)等当前的主力净流入资金

| 主力净流入资金 | 2026-09-21 19:48 |
| --- | --- |
| 半导体(申万)(指数) | -47.88亿元 |
| 电池(申万)(指数) | -17.41亿元 |
| 化学制药(申万)(指数) | 26.59亿元 |
| 证券Ⅱ(申万)(指数) | 4.884亿元 |
| 生物制品(申万)(指数) | 11.86亿元 |
| 中药Ⅱ(申万)(指数) | 6.777亿元 |
| 贵金属(申万)(指数) | -11.23亿元 |
| 工业金属(申万)(指数) | -14.23亿元 |
| 医疗服务(申万)(指数) | 12.66亿元 |
| 医疗器械(申万)(指数) | 5.414亿元 |

## 半导体(申万)(指数)等的主力净流入资金

| 主力净流入资金 | 2026-09-21(日) | 2026-09-18(日) | 2026-09-17(日) | 2026-09-16(日) |
| --- | --- | --- | --- | --- |
| 半导体(申万)(指数) | -47.88亿 | 184.2亿 | -50.65亿 | 135亿 |
| 电池(申万)(指数) | -17.41亿 | 4287万 | -21.74亿 | -36.12亿 |
| 化学制药(申万)(指数) | 26.59亿 | -2.525亿 | -1.594亿 | -7.509亿 |
| 证券Ⅱ(申万)(指数) | 4.884亿 | 11.23亿 | -15.42亿 | -4.796亿 |
| 生物制品(申万)(指数) | 11.86亿 | 1.72亿 | 2.955亿 | -1691万 |
| 中药Ⅱ(申万)(指数) | 6.777亿 | 8073万 | 5335万 | -1.917亿 |
| 贵金属(申万)(指数) | -11.23亿 | 1.395亿 | -12.72亿 | 7.449亿 |
| 工业金属(申万)(指数) | -14.23亿 | 17.68亿 | -38.13亿 | 7.874亿 |
| 医疗服务(申万)(指数) | 12.66亿 | 9.321亿 | 12.64亿 | 5.401亿 |
| 医疗器械(申万)(指数) | 5.414亿 | 1.567亿 | 1342万 | -3.109亿 |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_8e2e0372.md`  ·  5 行

~~~md
## 中国平安(601318.SH)保费-原保险保费收入(2026-

| 指标名称 | 数值类型 | 2026-06-30 |
| --- | --- | --- |
| 原保险保费收入 | 期末值 | 17875100万元 |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_a8693cee.md`  ·  5 行

~~~md
## 中国平安(601318.SH)保费-健康险保费收入(2025-

| 指标名称 | 数值类型 | 2025-12-31 | 2025-09-30 |
| --- | --- | --- | --- |
| 健康险保费收入 | 期末值 | 15900000万元 | 12700000万元 |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_b07db832.md`  ·  5 行

~~~md
## 中国平安(601318.SH)的总投资收益率

| 中国平安(601318.SH) | 2026一季报 | 2025中报 | 2025一季报 |
| --- | --- | --- | --- |
| 总投资收益率 | 0.8% | 6.2% | 5.2% |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_b27c63ae.md`  ·  5 行

~~~md
## 中国平安(601318.SH)的综合成本率(产险业务)

| 中国平安(601318.SH) | 2026中报 | 2026一季报 | 2025年报 | 2025三季报 | 2025中报 | 2025一季报 |
| --- | --- | --- | --- | --- | --- | --- |
| 综合成本率(产险业务) | 95.1% | 95.8% | 96.8% | 97% | 95.2% | 96.6% |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_b3893c72.md`  ·  128 行

~~~md
## 中国平安(601318.SH)的总投资收益率

| 中国平安(601318.SH) | 2026一季报 |
| --- | --- |
| 总投资收益率 | 0.8% |

## 中国平安-R(82318.HK)(最新年结日12-31)的投入

| 中国平安-R(82318.HK)(最新年结日12-31) | 2026中报 | 2026一季报 |
| --- | --- | --- |
| 投入资本回报率(年化)(%) | 1.514 | 0.8132 |
| 投入资本回报率ROIC(%) | 0.7571 | 0.2033 |

## 中国平安-R(82318.HK)的投入资本回报率(TTM)(%

| 中国平安-R(82318.HK) | 2026-06-30 | 2026-03-31 |
| --- | --- | --- |
| 投入资本回报率(TTM)(%) | 1.273 | 1.095 |

## 中国平安(02318.HK)资产负债表_合并报表(调整)_(2

| 指标名称 | 2026-06-30 | 2026-03-31 |
| --- | --- | --- |
| 应收账款(元) | 476.9亿 | 457.5亿 |
| 显示币种 | 人民币 | 人民币 |
| 原始币种 | 人民币 | 人民币 |

## 中国平安(02318.HK)利润表_合并报表(调整)_(202

| 指标名称 | 2026-06-30 | 2026-03-31 |
| --- | --- | --- |
| 利息收入(元) | 1486亿 | 742.4亿 |
| 原始币种 | 人民币 | 人民币 |

## 中国平安(02318.HK)现金流量表_合并报表(调整)_(2

| 指标名称 | 2026-06-30 | 2026-03-31 |
| --- | --- | --- |
| 报告期 | 中报 | 一季报 |
| 报表类型 | 合并报表(调整) | 合并报表(调整) |
| 报表年结日 | 12-31 | 12-31 |
| 上市前/上市后 | 上市后 | 上市后 |
| 公司类型 | 保险 | 保险 |
| 经营活动产生的现金流量净额(元) | 3680亿 | 1311亿 |
| 收到的利息(元) | 808.4亿 | 388.5亿 |
| 收到的股息(元) | 349.8亿 | 141.8亿 |
| 处置固定资产、无形资产和其他长期资产收回的现金净额(元) | 6.61亿 | 6600万 |
| 购建固定资产、无形资产和其他长期资产支付的现金(元) | -30.38亿 | -13.92亿 |
| 处置子公司收到的现金净额(元) | 7.48亿 | - |
| 收回投资收到的现金(元) | 19918亿 | 8271亿 |
| 投资支付的现金(元) | -21198亿 | -10017亿 |
| 投资活动使用的现金流量净额(元) | -138亿 | -1229亿 |
| 融资前现金净额(元) | 3542亿 | 81.3亿 |
| 借入资金的现金流入(元) | 365.6亿 | 199.9亿 |
| 偿还资金的现金流出(元) | -4172亿 | -1842亿 |
| 支付的利息(元) | -101.2亿 | -43.26亿 |
| 支付的股息(元) | -234.4亿 | -16.5亿 |
| 子公司吸收少数股东投资收到的现金(元) | 120亿 | 29.02亿 |
| 长期服务计划购买股份支付的现金(元) | -40.32亿 | -15.53亿 |
| 发行债券的现金流入(元) | 2422亿 | 1602亿 |
| 偿还租赁负债支付的现金(元) | -19.49亿 | -9.12亿 |
| 子公司赎回其他权益工具支付的现金(元) | -104亿 | -93.98亿 |
| 融资业务其他项目(元) | -1982亿 | -398.7亿 |
| 筹资活动使用的现金流量净额(元) | -3745亿 | -588.1亿 |
| 现金及现金等价物的净(减少)╱增加额(元) | -202.5亿 | -506.8亿 |
| 现金及现金等价物的期初余额(元) | 6502亿 | 6502亿 |
| 净汇兑差额(元) | -31.19亿 | -12.96亿 |
| 现金及现金等价物的期末余额(元) | 6269亿 | 5982亿 |
| 原始币种 | 人民币 | 人民币 |
| 区间起始日 | 2026-01-01 | 2026-01-01 |
| 区间截止日 | 2026-06-30 | 2026-03-31 |
| 公告日期 | 2026-08-20 | 2026-04-28 |
| 会计准则 | 国际会计准则 | 国际会计准则 |

## 中国平安-R(82318.HK)资产负债表_合并报表(调整)_

| 指标名称 | 2026-06-30 | 2026-03-31 |
| --- | --- | --- |
| 应收账款(元) | 476.9亿 | 457.5亿 |
| 显示币种 | 人民币 | 人民币 |
| 原始币种 | 人民币 | 人民币 |

## 中国平安-R(82318.HK)利润表_合并报表(调整)_(2

| 指标名称 | 2026-06-30 | 2026-03-31 |
| --- | --- | --- |
| 利息收入(元) | 1486亿 | 742.4亿 |
| 原始币种 | 人民币 | 人民币 |

## 中国平安-R(82318.HK)现金流量表_合并报表(调整)_

| 指标名称 | 2026-06-30 | 2026-03-31 |
| --- | --- | --- |
| 报告期 | 中报 | 一季报 |
| 报表类型 | 合并报表(调整) | 合并报表(调整) |
| 报表年结日 | 12-31 | 12-31 |
| 上市前/上市后 | 上市后 | 上市后 |
| 公司类型 | 保险 | 保险 |
| 经营活动产生的现金流量净额(元) | 3680亿 | 1311亿 |
| 收到的利息(元) | 808.4亿 | 388.5亿 |
| 收到的股息(元) | 349.8亿 | 141.8亿 |
| 处置固定资产、无形资产和其他长期资产收回的现金净额(元) | 6.61亿 | 6600万 |
| 购建固定资产、无形资产和其他长期资产支付的现金(元) | -30.38亿 | -13.92亿 |
| 处置子公司收到的现金净额(元) | 7.48亿 | - |
| 收回投资收到的现金(元) | 19918亿 | 8271亿 |
| 投资支付的现金(元) | -21198亿 | -10017亿 |
| 投资活动使用的现金流量净额(元) | -138亿 | -1229亿 |
| 融资前现金净额(元) | 3542亿 | 81.3亿 |
| 借入资金的现金流入(元) | 365.6亿 | 199.9亿 |
| 偿还资金的现金流出(元) | -4172亿 | -1842亿 |
| 支付的利息(元) | -101.2亿 | -43.26亿 |
| 支付的股息(元) | -234.4亿 | -16.5亿 |
| 子公司吸收少数股东投资收到的现金(元) | 120亿 | 29.02亿 |
| 长期服务计划购买股份支付的现金(元) | -40.32亿 | -15.53亿 |
| 发行债券的现金流入(元) | 2422亿 | 1602亿 |
| 偿还租赁负债支付的现金(元) | -19.49亿 | -9.12亿 |
| 子公司赎回其他权益工具支付的现金(元) | -104亿 | -93.98亿 |
| 融资业务其他项目(元) | -1982亿 | -398.7亿 |
| 筹资活动使用的现金流量净额(元) | -3745亿 | -588.1亿 |
| 现金及现金等价物的净(减少)╱增加额(元) | -202.5亿 | -506.8亿 |
| 现金及现金等价物的期初余额(元) | 6502亿 | 6502亿 |
| 净汇兑差额(元) | -31.19亿 | -12.96亿 |
| 现金及现金等价物的期末余额(元) | 6269亿 | 5982亿 |
| 原始币种 | 人民币 | 人民币 |
| 区间起始日 | 2026-01-01 | 2026-01-01 |
| 区间截止日 | 2026-06-30 | 2026-03-31 |
| 公告日期 | 2026-08-20 | 2026-04-28 |
| 会计准则 | 国际会计准则 | 国际会计准则 |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_e6778ca1.md`  ·  25 行

~~~md
## 华安证券(600909.SH)的营业收入、归属于母公司股东的净

| 华安证券(600909.SH) | 2026中报 |
| --- | --- |
| 营业收入 | 40.07亿元 |
| 归属于母公司股东的净利润 | 20.97亿元 |
| 营业总收入 | 40.07亿元 |
| 营业总收入同比增长率 | 65.28% |
| 单季度.营业总收入 | 30.35亿元 |
| 单季度.营业总收入同比增长率 | 156.3% |
| 归属于母公司股东的净利润 | 20.97亿元 |
| 归属母公司股东的净利润同比增长率 | 102.5% |
| 单季度.归属母公司股东的净利润 | 16.63亿元 |
| 单季度.归属母公司股东的净利润同比增长率 | 225.8% |
| 扣除非经常性损益后归属于母公司股东的净利润 | 20.83亿元 |
| 归属母公司股东的净利润同比增长率(扣除非经常性损益) | 102.5% |
| 单季度.扣除非经常损益后的净利润 | 16.52亿元 |
| 单季度.扣除非经常损益后的净利润同比增长率 | 224.4% |

## 华安证券(600909.SH)的预测归属于母公司的净利润中值(

| 华安证券(600909.SH) | 2026 |
| --- | --- |
| 预测归属于母公司的净利润中值(2026-08-25) | 24.76亿元 |
| 预测归属于母公司的净利润增长率(2026-08-25) | 86.3% |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_f1f724e3.md`  ·  17 行

~~~md
## 半导体(申万)(指数)等当前的小单净流入资金

| 小单净流入资金 | 2026-09-21 19:48 |
| --- | --- |
| 半导体(申万)(指数) | 55.31亿元 |
| 化学制药(申万)(指数) | -10.8亿元 |
| 证券Ⅱ(申万)(指数) | -3.994亿元 |
| 中药Ⅱ(申万)(指数) | -3.529亿元 |

## 半导体(申万)(指数)等的小单净流入资金

| 小单净流入资金 | 2026-09-21(日) | 2026-09-18(日) | 2026-09-17(日) | 2026-09-16(日) | 2026-09-15(日) | 2026-09-14(日) |
| --- | --- | --- | --- | --- | --- | --- |
| 半导体(申万)(指数) | 55.31亿元 | -75.35亿元 | 74.91亿元 | -54.3亿元 | -15.85亿元 | 52.69亿元 |
| 化学制药(申万)(指数) | -10.8亿元 | 1.825亿元 | 605.1万元 | 7.333亿元 | 11.67亿元 | -2.04亿元 |
| 证券Ⅱ(申万)(指数) | -3.994亿元 | -6.131亿元 | 9.777亿元 | 3.204亿元 | 8.567亿元 | 5.176亿元 |
| 中药Ⅱ(申万)(指数) | -3.529亿元 | -1.685亿元 | -2.076亿元 | 1.897亿元 | 3.939亿元 | -1.604亿元 |
~~~

---

## `miaoxiang\mx_finance_data\mx_finance_data_fabb0453.md`  ·  5 行

~~~md
## 中国平安(601318.SH)的新业务价值(寿险)

| 中国平安(601318.SH) | 2025年报 | 2025三季报 | 2025中报 | 2025一季报 | 2024年报 | 2024三季报 | 2024中报 | 2024一季报 | 2023年报 | 2023三季报 | 2023中报 | 2023一季报 | 2022年报 | 2022三季报 | 2022中报 | 2022一季报 | 2021年报 | 2021三季报 | 2021中报 | 2021一季报 | 2020年报 | 2020三季报 | 2020中报 | 2020一季报 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 新业务价值(寿险) | 369亿元 | 357.2亿元 | 223.4亿元 | 128.9亿元 | 400.2亿元 | 351.6亿元 | 223.2亿元 | 128.9亿元 | 310.8亿元 | 335.7亿元 | 259.6亿元 | 137亿元 | 288.2亿元 | 258.5亿元 | 195.7亿元 | 125.9亿元 | 379亿元 | 352.4亿元 | 273.9亿元 | 189.8亿元 | 495.8亿元 | 428.4亿元 | 310.3亿元 | 164.5亿元 |
~~~

---

## `reports\财政支出多渠道分析_2026-08-24.html`  ·  285 行

~~~html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>财政支出多渠道获取与交叉分析 · 2026年1-7月</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
<style>
  :root{
    --bg:#f5f7fa; --card:#ffffff; --ink:#1f2733; --sub:#5b6776; --line:#e6ebf2;
    --up:#cf1322; --down:#389e0d; --brand:#2f54eb; --warn:#d48806; --mut:#8c98a8;
  }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--bg);color:var(--ink);
    font-family:-apple-system,"PingFang SC","Microsoft YaHei",Segoe UI,Roboto,sans-serif;
    line-height:1.6;font-size:15px;}
  .wrap{max-width:1080px;margin:0 auto;padding:28px 20px 60px;}
  header{border-bottom:3px solid var(--brand);padding-bottom:14px;margin-bottom:22px;}
  h1{font-size:26px;margin:0 0 6px;}
  .meta{color:var(--sub);font-size:13px;}
  .tldr{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin:18px 0 26px;}
  .tldr .k{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;
    box-shadow:0 1px 3px rgba(20,40,80,.05);}
  .tldr .k .v{font-size:22px;font-weight:700;color:var(--brand);}
  .tldr .k .v.up{color:var(--up);} .tldr .k .v.down{color:var(--down);}
  .tldr .k .l{font-size:12.5px;color:var(--sub);margin-top:2px;}
  section{background:var(--card);border:1px solid var(--line);border-radius:12px;
    padding:20px 22px;margin-bottom:20px;box-shadow:0 1px 3px rgba(20,40,80,.05);}
  h2{font-size:19px;margin:0 0 12px;padding-left:10px;border-left:4px solid var(--brand);}
  h3{font-size:15.5px;margin:18px 0 8px;color:#2b3a4d;}
  p{margin:8px 0;}
  .up{color:var(--up);font-weight:600;} .down{color:var(--down);font-weight:600;}
  table{border-collapse:collapse;width:100%;font-size:13.5px;margin:10px 0;}
  th,td{border:1px solid var(--line);padding:8px 10px;text-align:center;}
  th{background:#f0f4fa;color:#33425a;font-weight:600;}
  td.l,th.l{text-align:left;}
  .tag{display:inline-block;padding:1px 8px;border-radius:20px;font-size:12px;font-weight:600;}
  .tag.ok{background:#e6f7ec;color:#1a7a3c;} .tag.warn{background:#fff4e0;color:#a85b00;}
  .tag.bad{background:#fdeaea;color:#b3261e;}
  .tag.pend{background:#eef1f6;color:#5b6776;}
  .chart{width:100%;height:380px;margin:10px 0 4px;}
  .src{font-size:12px;color:var(--mut);margin-top:6px;}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;}
  .chip{background:#eef2fb;border:1px solid #d6e0f5;color:#2f54eb;border-radius:8px;
    padding:4px 10px;font-size:12.5px;}
  ul{margin:8px 0 8px 4px;padding-left:20px;} li{margin:5px 0;}
  .note{background:#fbfcfe;border:1px dashed var(--line);border-radius:8px;padding:10px 14px;
    font-size:13px;color:var(--sub);margin:12px 0;}
  .flow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:14px 0;}
  .flow .box{background:#eef2fb;border:1px solid #d6e0f5;border-radius:8px;padding:8px 12px;font-size:13px;}
  .flow .arr{color:var(--brand);font-weight:700;}
  .disc{font-size:12px;color:var(--mut);border-top:1px solid var(--line);padding-top:12px;margin-top:18px;}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
  @media(max-width:760px){.tldr,.two{grid-template-columns:1fr;}}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>财政支出多渠道获取与交叉分析</h1>
  <div class="meta">数据周期：2026年1-7月（财政部国库司，发布 2026-08-14 / 08-21 国新办发布会）&nbsp;·&nbsp;生成时间：2026-08-24&nbsp;·&nbsp;口径：全国一般公共预算（第一本账）</div>
</header>

<!-- 结论先行 -->
<div class="tldr">
  <div class="k"><div class="v up">+5.8%</div><div class="l">1-7月一般公共预算收入累计同比（税收+6.7% 主导，质量改善）</div></div>
  <div class="k"><div class="v down">+1.3%</div><div class="l">1-7月一般公共预算支出累计同比（显著弱于收入端）</div></div>
  <div class="k"><div class="v">19,193亿</div><div class="l">1-7月第一本账赤字（支出162,889 − 收入143,696 亿元）</div></div>
  <div class="k"><div class="v down">−30.8%</div><div class="l">1-7月国有土地使用权出让收入同比（土地财政深度调整）</div></div>
</div>

<!-- 渠道与可信度 -->
<section>
  <h2>一、多渠道取数与可信度（A股情报调查员方法）</h2>
  <p>本次按要求调用 cnfinancialscraper、东方财富妙想（mx-finance-data）、agentic_search、WebSearch 四个技能通道获取财政支出数据，并做交叉验证。</p>
  <table>
    <tr><th class="l">数据通道</th><th>状态</th><th class="l">取数结果 / 说明</th><th>可信度</th></tr>
    <tr>
      <td class="l"><b>① 财政部国库司官网</b><br>gks.mof.gov.cn（一手来源）</td>
      <td><span class="tag ok">已取数</span></td>
      <td class="l">经 cnfinancialscraper 直连统计数据库，解析《2026年1-7月财政收支情况》：收入143,696亿(+5.8%)、支出162,889亿(+1.3%)。修复了 GBK 编码误判（官网声明 UTF-8 实为 GBK），现可稳定取数。</td>
      <td><span class="tag ok">✅ 已确认</span></td>
    </tr>
    <tr>
      <td class="l"><b>② WebSearch 聚合</b><br>人民网 / 央视 / 新华社 转引财政部</td>
      <td><span class="tag ok">一致</span></td>
      <td class="l">检索到财政部官网原文及央视/人民日报报道，数字与通道①逐项一致（16.29万亿支出、+1.3% 等）。</td>
      <td><span class="tag ok">✅ 已确认</span></td>
    </tr>
    <tr>
      <td class="l"><b>③ agentic_search 智能检索</b></td>
      <td><span class="tag ok">一致</span></td>
      <td class="l">合成并补充历史对照：2025全年（收216,045/−1.7%、支287,395/+1%）、2026上半年（收121,047/+4.7%、支143,329/+1.5%）、政府性基金（收−21.2%、支−16.4%），与①②一致。</td>
      <td><span class="tag ok">✅ 已确认</span></td>
    </tr>
    <tr>
      <td class="l"><b>④ 东方财富妙想</b><br>mx-finance-data</td>
      <td><span class="tag pend">待授权</span></td>
      <td class="l">脚本运行退出码 10（need_auth），需用户扫码授权 <code>EM_API_KEY</code> 后方可取数。该通道为结构化东财数据，可作为第四重交叉验证源。<br><span class="src">授权地址（扫码）：https://dl.dfcfs.com/m/u6e0?m_token=979156f51a134af2a0ce221e1885e968</span></td>
      <td><span class="tag warn">🔍 待开通</span></td>
    </tr>
  </table>
  <div class="note">结论：核心指标（1-7月收支累计额及同比）在 ①②③ 三个独立通道高度一致，属<span class="up">一手财政部数据，可信度最高</span>；通道④待授权后补充。7月当月数（收22,649亿/+11.7%、支19,560亿/+0.5%）由累计数相减推算，内部一致，标注为「推算」。</div>
</section>

<!-- 交叉验证表 -->
<section>
  <h2>二、关键指标三源交叉验证</h2>
  <table>
    <tr><th class="l">指标（周期）</th><th>财政部官网①</th><th>WebSearch②</th><th>agentic③</th><th>一致</th></tr>
    <tr><td class="l">一般公共预算收入（1-7月，亿 / 同比）</td><td>143,696 / +5.8%</td><td>一致</td><td>一致</td><td><span class="tag ok">✓</span></td></tr>
    <tr><td class="l">一般公共预算支出（1-7月，亿 / 同比）</td><td>162,889 / +1.3%</td><td>一致</td><td>一致</td><td><span class="tag ok">✓</span></td></tr>
    <tr><td class="l">税收收入（1-7月，亿 / 同比）</td><td>118,381 / +6.7%</td><td>一致</td><td>一致</td><td><span class="tag ok">✓</span></td></tr>
    <tr><td class="l">收入（2026上半年，亿 / 同比）</td><td>121,047 / +4.7%</td><td>一致</td><td>一致</td><td><span class="tag ok">✓</span></td></tr>
    <tr><td class="l">支出（2026上半年，亿 / 同比）</td><td>143,329 / +1.5%</td><td>一致</td><td>一致</td><td><span class="tag ok">✓</span></td></tr>
    <tr><td class="l">收入（2025全年，亿 / 同比）</td><td>—</td><td>—</td><td>216,045 / −1.7%</td><td><span class="tag warn">单一源</span></td></tr>
    <tr><td class="l">支出（2025全年，亿 / 同比）</td><td>—</td><td>—</td><td>287,395 / +1%</td><td><span class="tag warn">单一源</span></td></tr>
    <tr><td class="l">政府性基金收入（1-7月，亿 / 同比）</td><td>18,219 / −21.2%</td><td>一致</td><td>一致</td><td><span class="tag ok">✓</span></td></tr>
    <tr><td class="l">政府性基金支出（1-7月，亿 / 同比）</td><td>45,410 / −16.4%</td><td>一致</td><td>一致</td><td><span class="tag ok">✓</span></td></tr>
  </table>
  <div class="src">来源：财政部国库司《2026年1-7月财政收支情况》(gks.mof.gov.cn/tongjishuju/202608/t20260814_3995497.htm)；人民网/央视新闻(2026-08-21)；agentic_search 合成（含2025全年、政府性基金）。2025全年数为媒体引财政部，标注单一源。</div>
</section>

<!-- 图表 -->
<section>
  <h2>三、收支走势与结构</h2>
  <h3>3.1 一般公共预算：支出额高于收入，但收入增速反超支出</h3>
  <div id="chartA" class="chart"></div>
  <div class="src">柱=累计额(亿元，左轴)；线=累计同比(%)，右轴。来源：财政部国库司 2026-08-14/21。</div>

  <h3>3.2 重点支出科目同比增速（1-7月，红涨绿跌）</h3>
  <div id="chartB" class="chart"></div>
  <div class="src">民生类（卫健+9.8%、社保就业+7%）高增；传统基建/环保/农林（节能环保−11.9%、农林水−6.8%、城乡社区−2.9%）压减，反映零基预算改革与债务付息挤压。来源：财政部。</div>

  <h3>3.3 两本账收支同比：第一本账温和，第二本账（土地财政）深度负增</h3>
  <div id="chartC" class="chart"></div>
  <div class="src">政府性基金收入−21.2%（其中土地出让−30.8%），支出−16.4%，是广义财政支出偏弱的主因。来源：财政部 / 中国财政。</div>
</section>

<!-- 分析 -->
<section>
  <h2>四、分析：收入强、支出弱、土地财政拖累</h2>

  <h3>1）收入端：高增且质量改善</h3>
  <ul>
    <li>1-7月收入 <span class="up">+5.8%</span>，增速较上半年(+4.7%)再抬升；7月当月 <span class="up">+11.7%</span>，创19个月新高。</li>
    <li>结构：税收 <span class="up">+6.7%</span> &gt; 非税 +1.6%，收入"含税额"回升，质量改善。</li>
    <li>驱动：①价格上行（PPI回升，约80%税收为价相关税）；②股市活跃（<b>证券交易印花税+99.2%</b>）；③外贸强劲（进口环节税+12.3%）；④企业利润改善（所得税+7.2%）。</li>
  </ul>

  <h3>2）支出端：温和且地方偏弱</h3>
  <ul>
    <li>1-7月支出 <span class="down">+1.3%</span>，显著低于收入增速；7月当月 <span class="down">+0.5%</span>（较6月回落3.5pct），地方支出 <span class="down">−0.4%</span>。</li>
    <li>原因：零基预算改革压低效支出、债务付息（7,966亿，+5.2%）挤占、土地出让下滑削弱地方财力。</li>
  </ul>

  <h3>3）两本账与赤字</h3>
  <ul>
    <li>第一本账：1-7月赤字 <b>19,193亿</b>（支162,889 − 收143,696）；2025全年赤字 71,350亿。</li>
    <li>第二本账（政府性基金）：收 −21.2% / 支 −16.4%，<b>土地出让收入−30.8%</b> —— 土地财政仍在深度调整，是广义财政支出欠进度的核心拖累。</li>
    <li>广义财政：1-7月广义收入累计 <span class="up">+1.9%</span>（接近预算+1.8%），但广义支出累计 <span class="down">−3.1%</span>（预算目标+4.6%）—— <b>支出端明显欠进度</b>。</li>
  </ul>

  <div class="note">政策前瞻：财政部8月21日国新办发布会明确表示"下半年将及时谋划出台务实管用的增量政策"。在支出欠进度 + 土地财政收缩背景下，下半年增量财政（特别国债、专项债提速、消费补贴扩围）是可预期的博弈方向。</div>
</section>

<!-- 宏观传导 -->
<section>
  <h2>五、宏观→行业传导（对 A股 / 债市的影响链）</h2>
  <div class="flow">
    <span class="box">财政支出偏弱 + 基金收缩</span><span class="arr">→</span>
    <span class="box">基建/地产链需求预期受压</span><span class="arr">→</span>
    <span class="box">建材·工程机械·建筑·地产承压</span>
  </div>
  <div class="flow">
    <span class="box">"投资于人"民生倾斜</span><span class="arr">→</span>
    <span class="box">医疗·养老·消费服务结构性机会</span><span class="arr">→</span>
    <span class="box">医保/养老服务/必选消费</span>
  </div>
  <div class="flow">
    <span class="box">收入高增 + 印花税翻倍</span><span class="arr">→</span>
    <span class="box">市场活跃度提升</span><span class="arr">→</span>
    <span class="box">券商/财富管理业绩弹性（已部分定价）</span>
  </div>
  <div class="two">
    <div>
      <h3>一阶 / 二阶受益</h3>
      <ul>
        <li><b>受益（财政倾斜）</b>：医疗服务、养老、必选消费、设备更新/以旧换新链条；券商（市场活跃）。</li>
        <li><b>承压</b>：传统基建建材、地产链、城投债（土地财政收缩 + 化债约束）。</li>
        <li><b>二阶弹性</b>：专项债提速利好下的工程机械、电网设备，需等数据验证（时滞1-2季度）。</li>
      </ul>
    </div>
    <div>
      <h3>债市视角</h3>
      <ul>
        <li>财政"紧平衡" + 赤字率约束 → 利率下行空间受限。</li>
        <li>专项债/特别国债提速 → 利率债供给压力。</li>
        <li>但经济内生动能偏弱、广义支出欠进度 → 配置需求仍支撑。</li>
        <li>传导时滞提示：数据公布时市场可能已部分定价，警惕"利好兑现"反向交易。</li>
      </ul>
    </div>
  </div>
  <div class="note">传导不是直线：历史上财政数据与市场表现常背离，且不假设政策意图必然兑现。以上为方向性框架，非买卖建议。</div>
</section>

<!-- 工具化进展 -->
<section>
  <h2>六、对 Stock Analyzer 工具化的进展</h2>
  <ul>
    <li><b>cnfinancialscraper 通道已修通</b>：升级 <code>scripts/cnscraper_adapter.py</code> 的 <code>fiscal</code> 子命令——直连财政部统计数据库（gks.mof.gov.cn），并修复 GBK/UTF-8 编码误判；现可稳定返回收入与支出累计额及同比（已实跑验证：收入143,696/+5.8%、支出162,889/+1.3%）。</li>
    <li><b>端到端打通</b>：<code>lib/macroData.js</code> 的「财政支出（一般公共预算）」卡已能取到真实财政部数据（此前沙箱无网时为占位），与「财政收入」卡对称呈现。</li>
    <li><b>东方财富妙想通道</b>：待用户扫码授权 EM_API_KEY 后，可在 <code>lib/cnscraperAdapter.js</code> 之外增加第四重东财结构化交叉验证。</li>
  </ul>
</section>

<div class="disc">
  <b>免责声明</b>：以上内容基于公开数据和量化分析，仅供参考，不构成投资建议。市场有风险，投资需谨慎。任何投资决策应结合个人风险承受能力、资金状况和投资目标独立判断，必要时咨询持牌专业机构。过往表现不预示未来收益。<br>
  数据来源：财政部国库司（一手）、人民网/央视新闻/新华社（一手转引）、agentic_search 合成、cnfinancialscraper 直连解析。7月当月数为累计相减推算。统计时点：2026年1-7月（发布 2026-08-14/21）。
</div>
</div>

<script>
(function(){
  var UP='#cf1322', DOWN='#389e0d', BRAND='#2f54eb', GREY='#8c98a8';
  function init(id, opt){ echarts.init(document.getElementById(id)).setOption(opt); }

  // 图A：累计额(柱,左轴) + 累计同比(线,右轴)
  init('chartA', {
    tooltip:{trigger:'axis', axisPointer:{type:'shadow'}},
    legend:{data:['累计额(亿元)','累计同比(%)']},
    xAxis:{type:'category', data:['一般公共预算收入','一般公共预算支出']},
    yAxis:[
      {type:'value', name:'累计额(亿)', axisLabel:{formatter:'{value}'}},
      {type:'value', name:'同比(%)', axisLabel:{formatter:'{value}%'}}
    ],
    series:[
      {name:'累计额(亿元)', type:'bar', barWidth:'42%',
        data:[{value:143696, itemStyle:{color:BRAND}}, {value:162889, itemStyle:{color:'#7a8aa0'}}],
        label:{show:true, position:'top', formatter:'{c}'}},
      {name:'累计同比(%)', type:'line', yAxisIndex:1, symbolSize:10,
        data:[{value:5.8, itemStyle:{color:UP}}, {value:1.3, itemStyle:{color:DOWN}}],
        label:{show:true, formatter:'{c}%'}, lineStyle:{width:3}}
    ]
  });

  // 图B：重点支出科目同比（横向柱，红涨绿跌）
  var items = [
    {n:'卫生健康', v:9.8}, {n:'社会保障和就业', v:7.0}, {n:'债务付息', v:5.2},
    {n:'住房保障', v:4.0}, {n:'教育', v:0.7}, {n:'科学技术', v:1.5},
    {n:'城乡社区', v:-2.9}, {n:'农林水', v:-6.8}, {n:'文化旅游体育与传媒', v:-6.9},
    {n:'节能环保', v:-11.9}
  ].sort(function(a,b){return a.v-b.v;});
  init('chartB', {
    tooltip:{trigger:'axis', axisPointer:{type:'shadow'}, formatter:'{b}: {c}%'},
    grid:{left:140, right:40, top:20, bottom:20},
    xAxis:{type:'value', axisLabel:{formatter:'{value}%'}},
    yAxis:{type:'category', data:items.map(function(i){return i.n;})},
    series:[{
      type:'bar', barWidth:'62%',
      data:items.map(function(i){return {value:i.v, itemStyle:{color: i.v>=0?UP:DOWN}};}),
      label:{show:true, position:'right', formatter:'{c}%'}
    }]
  });

  // 图C：两本账收支同比
  init('chartC', {
    tooltip:{trigger:'axis', axisPointer:{type:'shadow'}},
    legend:{data:['收入同比','支出同比']},
    xAxis:{type:'category', data:['一般公共预算(第一本账)','政府性基金(第二本账)']},
    yAxis:{type:'value', axisLabel:{formatter:'{value}%'}},
    series:[
      {name:'收入同比', type:'bar', barWidth:'30%',
        data:[{value:5.8, itemStyle:{color:UP}}, {value:-21.2, itemStyle:{color:DOWN}}],
        label:{show:true, position:'top', formatter:'{c}%'}},
      {name:'支出同比', type:'bar', barWidth:'30%',
        data:[{value:1.3, itemStyle:{color:UP}}, {value:-16.4, itemStyle:{color:DOWN}}],
        label:{show:true, position:'top', formatter:'{c}%'}}
    ]
  });
})();
</script>
</body>
</html>

~~~

---

## `start.bat`  ·  67 行

~~~bat
@echo off
chcp 65001 >nul 2>&1
title 股票分析工作台
REM 始终启动 D 盘最新开发目录中的代码
cd /d "%~dp0"
set PORT=3005

echo ============================================
echo   股票分析工作台 (Stock Analyzer)
echo ============================================
echo.

REM 关键：先强制杀掉占用 3005 端口的旧服务，确保启动的是最新代码
echo 正在检查并清理占用端口 3005 的旧服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3005" ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo 端口清理完成，等待释放...
ping -n 2 127.0.0.1 >nul 2>&1

REM 选定 Node 路径：优先托管版本（自动探测版本目录，不写死版本号），否则系统 PATH 中的 node
REM 注意：批处理中「括号块内的 %VAR% 在解析时展开」，所以不能在同一个块里先 set 再用 %VAR%。
REM       这里统一用 CALL 子过程（运行时求值），规避延迟展开陷阱。
set "NODE_ROOT=C:\Users\16507\.workbuddy\binaries\node\versions"
set "MANAGED_NODE="

REM ① 优先 versions\current 指向的版本；② 再扫 versions\* 任意子目录
if exist "%NODE_ROOT%\current" for /f "usebackq delims=" %%V in ("%NODE_ROOT%\current") do call :TryNode "%NODE_ROOT%\%%V\node.exe"
if not defined MANAGED_NODE if exist "%NODE_ROOT%" for /d %%D in ("%NODE_ROOT%\*") do call :TryNode "%%D\node.exe"

REM ③ 回退 PATH 上的 node；④ 全失败则明确报错（不再静默）
if defined MANAGED_NODE (
    set "NODE_EXE=%MANAGED_NODE%"
) else (
    where node >nul 2>&1
    if not errorlevel 1 (
        set "NODE_EXE=node"
    ) else (
        echo [错误] 未找到 Node.js，无法启动。
        echo 已检查: %NODE_ROOT%
        pause
        exit /b 1
    )
)
goto :AfterNodePick

:TryNode
if not defined MANAGED_NODE if exist "%~1" set "MANAGED_NODE=%~1"
exit /b 0

:AfterNodePick

echo 正在启动股票分析工作台...
echo 地址： http://localhost:3005
echo 服务器启动后约 3 秒自动打开浏览器...
echo.

REM 用一个独立的延迟进程打开浏览器（不阻塞服务器主进程）
start "" /min cmd /c "ping -n 4 127.0.0.1 >nul & start http://localhost:3005"

REM 前台运行 node：node 本身是常驻服务进程，会一直保持此窗口（绝不闪退）。
REM 关闭此窗口即停止服务器。
"%NODE_EXE%" server.js
echo.
echo [服务已停止] 若上方有红色报错，请把报错内容发给我。
pause

~~~
