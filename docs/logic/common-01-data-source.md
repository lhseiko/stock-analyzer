# 数据源接入（五要素 / TTL / 缓存）· 反向逻辑说明

> 逻辑模型位置：跨页面公共支撑 → 🗄️ 数据源接入（badge：公共支撑）
> 实现文件：lib/db.js、lib/stockData.js、lib/ai/cache.js、lib/miaoxiang.js、lib/cninfoAnnouncements.js、server.js（交易日守卫/落盘）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 任意页面上的「实时性 / 已过期」色带、freshnessRows 时效条 | 由各模块对 `valid_until` 判定 `isFresh` 后渲染 | lib/db.js:165 |
| 个股页数据上的「截至 YYYY-MM-DD」来源标注 | 落库时写入 `as_of`（数据实际日期）+ `fetched_at`（抓取时间），二者分离 | lib/db.js:52,65,67 |
| 「⚠️ 数据已过期」提示 | `staleLabel` 在 `checkFreshness` 过期为 true 时生成 | ruleCore.js:107 |
| 深度分析页「正在重算 / 版本不符自动刷新」 | 深度分析缓存仅 `APP_VERSION` 版本门控，无时间 TTL | server.js:1111-1136 |
| AI 估值/财报/研报「点 ✨ 才联网」 | AI 只读缓存版本+TTL 双重门控，失效/过期/无缓存才回源 | lib/ai/cache.js:44-45 |

## 二、核心公式 / 判定链

**1. 五要素落点（一致性铁律）**
每条数据带 名称 / 数值 / 实际时间(as_of) / 来源(source) / 获取时间(fetched_at)，对应 `data_points` 表字段（lib/db.js:52,65,67）。「最新性」由 `valid_until` 表达。

**2. TTL 过期判定链**
- 写入时推算 `valid_until = now + ttlMs(ttlType)`（lib/db.js:151）。
- 读取时 `isFresh = valid_until > Date.now()`（lib/db.js:165）。
- `isFresh=false` → 路由层返回「需重拉」提示（server.js:1257）。

**3. 交易日感知（防误标过期）**
- `isTradingDayToday()` 三态（true/false/null）：上证日K 最新日期==今天 ⇒ 开过盘（server.js:2142-2145）；双通道均失败 ⇒ 返回 null（**判断失败≠非交易日**，server.js:2129-2131,2151）。
- `countTradingDaysBetween` 为 0 时保守判「仍为最新可得」，不误标过期（ruleCore.js:94）。

## 三、指标 / 因子口径

| 指标/缓存 | TTL / 时效 | 是否进总分 | 出处 |
|---|---|---|---|
| 行情实时 quote | 5 分钟 | — | lib/db.js:21 |
| 日线 daily | 24 小时 | — | lib/db.js:22 |
| 周线 weekly | 7 天 | — | lib/db.js:23 |
| 财务 financial | 90 天 | — | lib/db.js:24 |
| 公司 company | 30 天 | — | lib/db.js:25 |
| AI 补全结果 | 7 天 | — | lib/ai/config.js:42 |
| 研报/公告/公司介绍/供应链（半静态） | 30 天 | — | lib/ai/config.js:45 |
| cninfo 公告内存 | 10 分钟 | — | lib/cninfoAnnouncements.js:14 |
| 东财 TTM 估值 Map | 6 小时 | — | lib/eastmoneyValuation.js:9 |
| 板块排名内存（同花顺/东财/腾讯） | 30 秒 | — | lib/stockData.js:783,1043,1150 |
| 交易日判断（false 态） | 10 分钟 | — | server.js:2135 |
| 深度分析缓存 | 无时间 TTL，仅 `APP_VERSION` 版本门控 | — | server.js:1127 |
| 板块排名三套 | 30 秒（now - ts < 30000） | — | lib/stockData.js:783,1043,1150 |

> 全局未检索到 `expiresIn` / `staleAfter` / `maxAge` 命名；TTL 全部以自定义常量/毫秒差值实现。⚠️ 如需精确单值，以各文件常量定义为准。

## 四、数据来源与采集链

| 层 | 内容 | 出处 |
|---|---|---|
| 数据源① 腾讯 qt.gtimg.cn（主行情） | 个股实时行情 `getQuote`→`fetchTencentQuote`，GBK 解码 `iconv.decode(...,'GBK')`；K线 `ifzq.gtimg.cn` | lib/stockData.js:267,273-274,1201,1366,1398 |
| 数据源② 东方财富 | 资金流 `push2his.eastmoney.com`（Node TLS 被拦，curl 兜底 lib/capitalFlow.js:40）；TTM 估值 `datacenter-web.eastmoney.com`（lib/eastmoneyValuation.js:45）；涨停/跌停池 `push2ex.eastmoney.com`（lib/stockData.js:991-1039）；板块排名（lib/stockData.js:1041） | 各文件 |
| 数据源③ 妙想金融数据（东财妙想 MCP） | 纯 Node 客户端，基址 `ai-saas.eastmoney.com`，子路由 `/api/miaoxiang/*` | lib/miaoxiang.js:20；routes/aiRoutes.js:303-352 |
| 数据源④ cninfo 巨潮 | 经 `scripts/cninfo_announcements.py` 取数，失败返回 `{ok:false}` 不影响个股页 | lib/cninfoAnnouncements.js:1-5,29,39 |
| 数据源⑤ akshare（Python） | 行业板块涨跌（sectorTrend.js:4）、指数历史（industryIndexHistory.js:63）、拥挤度（sectorCrowding.js:205）、舆情（sentiment.js:4）、周榜（hotTopicsWeekly/index.js:58） | 各文件 |
| 兜底源 | 腾讯整批失败→新浪整批兜底（lib/stockData.js:531）；美股腾讯→雅虎（lib/stockData.js:1936,2028）；历史 腾讯→东财(重试)→新浪 | lib/stockData.js |
| 落盘 | SQLite 主库 `data/stock_analyzer.db`（lib/db.js:15）；AI 只读缓存 `data/ai_cache/`；深度分析 `data/cache/deep-analysis/`；行业 `data/cache/industry_*`；F10 `data/f10-status/`；指数 `data/index_cache/` | 各文件 |
| 调度 | 过期重采（isFresh=false / 版本不符 / 核心数据空 / 交易日守卫 / 事件变更 invalidate / `?refresh=1`）；定时任务 15:30 盘后落盘（server.js:2191-2262）、事件扫描四槽位（server.js:2266-2291） | server.js |

### 4.x 腾讯 K 线「主机族」降级（20261021g）

`ifzq.gtimg.cn/appstock/app/fqkline/get` 曾对**所有代码**整段返回 **HTTP 501**（sh000001 / sz399001 / sh600519 / sz000902 全是 501），而**同一路径**在 `web.ifzq.gtimg.cn` 正常 200。两个域名历史上此消彼长，写死任何一个都会在某天让「个股日K / 大盘技术分析 / 市场情绪量价因子 / 准确率结算」同时降级，而日志里只有一条 `Request failed with status code 501`，极易被误判成业务 bug。

- 统一入口：`lib/tklineHost.js#getKlineJson(pathQuery, axiosOpts)` → 依次尝试 `ifzq.gtimg.cn` → `web.ifzq.gtimg.cn`，**只换主机、不改路径与参数**，调用方拿到的仍是原响应体。
- 只对 5xx / 网络错误换主机；4xx 是参数问题，换主机没用，直接抛。
- 接入点：`lib/stockData.js`（两处日K）、`lib/marketTechnical.js#fetchKline`、`lib/marketTechJudgment.js#fetchIndexDaily`、`lib/deep/yield.js#fetchBfqBars`、`server.js#_lastTradeDateViaFetch`。
- `mkline`（分钟）与 `minute/query`（分时）不在同一路径、未被封，保持原样。
- 守卫：`scripts/test_tkline_host.js`（28 项）断言五个调用点**不再出现裸 ifzq fqkline URL**。

### 4.y 成交量「单位契约」（20261021h）

同一份「成交量」在不同接口相差 100 倍是历史常客，一旦跨通道比较就会产生「7,358,800 小于 170,850」这类荒谬结论。

| 来源 | 单位 | 反验方式 |
|---|---|---|
| 东财 kline `f56` | **手** | 73,588 手 × 13.87 × 100 = 1.02 亿 = 实时成交额 |
| 腾讯 `fetchTencentHistory`（已归一） | **手** | 科创板 688/689 的「股」在取数时 ÷100 |
| 同花顺 `last.js` | **股** | 量级恒为东财的约 100 倍 |
| 实时 quote（腾讯快照 fields[36]） | **股** | 与日K手数恒差 100 倍 |

- 唯一入口：`lib/volUnit.js`（`BAR_VOL_UNIT` / `sharesToBarUnit` / `toLotDivisor`）。**禁止**再按"是否 tencent"二分。
- `_reconcileTodayBar` 覆写当日K线前先换算；换算后若与当日 bar 相差 >20 倍，判为单位异常 → **拒绝覆写**，写 `unit_mismatch` 进 dataGaps（序列绝不被污染）。
- 守卫：`scripts/test_volume_unit_contract.js`（28 项）覆盖单位表、三通道覆写、量级守卫、capitalFlow 同源、源码防回潮、文案自洽。

### 4.z 同花顺日K「样本一直 140 天」与历史段回填（20261022e）

用户报障「成交额/换手率样本一直停在 140 天」。根因两层：

1. **结构闸门过严（真因）**：`all.js` 收盘前后偶发 `sortYear` 年度计数比 `dates/volumn` 多 1~2 条（当日条目已计入年度计数、尚未落入数组）。旧 `_decodeThsAll` 要求 `sum(sortYear) === dates.length`，不符即 `return null` → 历史段整段拿不到，只剩 `last.js` 的 140 根。
2. **只有 last.js 带成交额/换手率**：`all.js` 历史段是纯 OHLCV；即便解码成功，250 日窗口里仍只有 140 天有值。

修法：

- `_decodeThsAll` 容忍「末尾多计 ≤2」：从最后一年计数扣掉；**欠计或差 >2 仍拒绝**；年份映射正确性由 `_mergeThsBars` 的重叠段 close 闸门兜底（不通则不采信）。
- 新增 `_backfillThsFields`（`_mergeThsBars` 末尾调用）：用 `last.js` 反推流通盘（`volume ÷ (turnover/100)` 中位数；跨期离散 >3% 则放弃回填换手率），历史段 `turnover = volume / 流通盘 × 100`、`amount = volume × close`；打标 `amountEstimated/turnoverEstimated`，引擎在 dataGaps 如实披露「推算值，跨除权日可能数%偏差」。
- 实测 603288：250 日换手率/成交额样本均 **250**（原 140），历史段 180 根为推算；`all.js` 与 `last.js` 重叠 140 根成交量逐根一致、隐含流通盘跨期离散仅 0.72%、`volume×close` 与真实成交额偏差 1.09%。
- 守卫：`scripts/test_ths_backfill.js`（17 项）+ `test_ths_kline.js`（50 项，含「末尾多计 1 → 容忍 / 多计 3 → null」）。
- 注意：`all.js` 高频请求会触发同花顺 502（限流）；已由 §4.aa 本地缓存彻底规避，失败时仍自动退回 140 根并如实标注。
- **20261023f 改进**：历史段 `amount` 改用腾讯「不复权」日K收盘价还原（`fetchTencentRawCloseMap`）——同花顺 all.js 是**前复权**价，`volume×前复权close` 会低估约 2~3.5%；腾讯 `day`（不带 qfq）与交易所同口径，实测偏差 **<1%**。`turnover` 仍按流通盘推算（实测一致）。打标 `amountBasis: 'raw_close' | 'qfq_close'`，引擎据此把该条从「推算值（数据不足）」降级为「来源与口径说明」。


### 4.aa 同花顺日K原始响应本地缓存（20261022f，避开 all.js 502 限流）

**问题**：`all.js` 频繁请求会触发同花顺 502。实测确认是**限流**而非头部/代理差异（同一时刻 axios 502、curl 200、裸 `node:http` 200）。
根因是页面反复加载都重新拉同一份数据（`all.js` 单股 87–194 KB）。

**方案（用户选定「C 方案：存原始文本」）**：把 `last.js` / `all.js` 的 **JSONP 原始字符串**落盘到
`data/cache/ths-daily/<6位代码>.json`，读缓存后走**同一套** `_unwrapThsJsonp → _decodeThsAll → _mergeThsBars`
解码与 close 闸门，只在「文本从哪来」这一处分叉。因此缓存结果与实时拉取**逐字节一致**，
不会出现「解码逻辑改了、旧缓存按旧逻辑算」的口径漂移。

**为什么不存解码结果**（实测单股体积，603288/601318/600519）：

| 形态 | 单股体积 |
|---|---|
| `last.js` + `all.js` 原始文本 | **约 148 KB（最小）** |
| 解码后精简 `{d,o,h,l,c,v}` 全量 | 约 334 KB |
| 解码后完整字段 全量 | 约 556 KB |
| 只留引擎要的 320 根完整字段 | 约 35 KB |

容量结论：9 只自选 ≈ 1.3 MB、31 只 ≈ 4.6 MB、200 只 ≈ 30 MB。
**每只股票固定一个文件、每日覆盖写**，不随天数累积。

**三段式刷新节奏**（`thsDailyCache.resolveSlot`，交易日 + 时段）：

| 时刻 | phase | 行为 |
|---|---|---|
| 交易日 09:30–15:04 | `intraday` | 当天首次抓取后整个盘中复用 |
| 交易日 ≥15:05 | `closed` | 盘中缓存作废，补抓一次拿当日完整收盘K，之后复用 |
| 非交易日（周末/长假） | `closed` | 锚定 `previousTradingDay`，全程复用同一份 |

→ 每只股票每个交易日**最多 2 次请求**（正常 1 次），脱离 502 限流区间。

**盘中缓存可直接复用为何安全**：20261022c 已确立「有效突破/破位/打穿只认当日收盘价」，
`zoneValidity.finalizedBars` 会剔除当日未收盘K，盘中那份当日数据本就不参与判定；
展示层当日价格由腾讯实时 quote 覆写，不受日K快照影响。

**三条防线**：
1. **残缺缓存不认**：`all.js` 缺失（当场拉取失败）→ `isFresh` 返回 `incomplete_all`，不写也不命中，
   避免一整天卡在「只有 140 根」。
2. **失败退避**：`all.js` 拉取失败后 2 分钟内不再重试（内存态 `_thsAllBackoff`，不落盘），
   期间只用 `last.js` 的 140 根并如实标注样本不足；到期自动恢复。
3. **并发去重**：`_thsRawInFlight` 让同一次页面加载里多个模块对同一代码只发一轮请求。

**实测（2026-10-22，603288）**：
- 并发 3 个请求 → 网络仅 2 次（last+all 各一次），三份结果指纹一致；
- 缓存命中再请求 3 次 → **网络 0 次**，耗时 3–7 ms，320 根与首次**逐字节一致**，250/120 根为正确尾部切片；
- 缓存文件 97.0 KB（last 10.1 KB + all 86.6 KB + 结构开销）；成交额/换手率样本 320/320（含 180 根推算标记）；
- 删缓存 → 重新联网 2 次且结果与首次一致；缓存命中平均 3.0 ms/次（全量解码 3088 根 + 合并 + 回填）；
- 模拟 all.js 502 → 140 根、不写残缺缓存、退避期内 all.js 尝试增量 0；模拟 3 分钟后 → 自动恢复 320 根并写缓存。

**守卫**：`scripts/test_ths_daily_cache.js`（62 项：slot 边界、未命中原因枚举、读写往返、损坏降级、原子写无 `.tmp` 残留、元信息不外泄原始文本）。


## 五、降级 / 容错 / 诚实性设计

- **回退链**：`getQuote` 腾讯→雅虎；`getHistory` CN/HK 腾讯→东财(重试)→新浪；板块排名 同花顺→东财→腾讯→合成空块；涨停池单池失败对应字段 `null`（前端不渲染）。
- **核心数据为空**：`isAnalysisCacheValid` 返回 false（server.js:1115-1116）→ 不命中、强制重算，防空白图卡冻结。
- **抓取失败不编造**：估值失败时返回 `ok:false, note:'⚠️ 未能获取估值数据，本次不输出估值结论'` 而非零值聚合（valuationHub.js:67-74）。
- **⚠️ 防并发锁缺失（全局）**：全局未检索到 singleflight / dedup / mutex / in-flight 去重（仅 SQLite WAL + `busy_timeout=5000` lib/db.js:42-43 与顺序 try/catch 回退）。深度分析同 symbol 多并发未命中缓存时会各自重算（server.js:1276-1338），存在重复计算/瞬时负载风险。
  - 例外（20261022f 已局部解决）：同花顺日K通道已有 in-flight 去重 `_thsRawInFlight`（lib/stockData.js），同一代码并发请求共享同一轮取数。该去重**仅覆盖此通道**，不改变上述全局结论。

## 六、逻辑漏洞自查清单（审计用）

- [x] ~~**⚠️ 涨停板池数据源记忆不符（已核实撤回）**：原疑「home-06 记反 akshare 涨停池」，实查 home-06 用东财 7×24 快讯（newsSearch.js:71），文档正确；`lib/stockData.js:991` 的 push2ex 是「当日最多涨停/跌停板块」大盘面板功能，与周榜无关；`stock_zt_pool_em` 真实用于 sector_limit_stats.py:161（板块涨停潮因子）/ sentiment.py:189 / market_emotion.py:83（炸板池），非周榜。用户记忆的「akshare 涨停板池」是已被 hotTopicsWeekly（home-07 快讯×4+社区×2）替换的旧「今日最热股票话题」设计~~ → 属记忆滞后，无文档需修正
- [ ] TTL 是否覆盖所有缓存：板块排名 30s 内存缓存与落盘 SQLite 的 TTL 是否一致？跨进程重启后内存缓存失效是否导致首屏抖动？
- [ ] `isTradingDayToday` 返回 null（双通道失败）时，盘后落盘守卫是否误拒（server.js:2091-2151）？
- [ ] 防并发锁缺失是否在大盘技术/深度分析重算高峰导致重复 LLM 调用/CPU 尖峰（见第五节）。
- [ ] 「五要素」中 `source` 字段是否在所有写入路径都如实填写，还是部分路径留空导致来源标注失效？
- [ ] 深度分析仅 `APP_VERSION` 门控、无时间 TTL：若用户长期不刷新但代码未升版，陈旧财务结论会一直展示（server.js:1127）。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| TTL 各档（realtime/daily/weekly/financial/company） | 5m/24h/7d/90d/30d | lib/db.js:21-25 |
| AI 补全 TTL / 半静态 TTL | 7d / 30d | lib/ai/config.js:42,45 |
| 东财估值 Map TTL | 6h | lib/eastmoneyValuation.js:9 |
| cninfo 公告缓存 TTL | 10min | lib/cninfoAnnouncements.js:14 |
| 板块排名内存 TTL | 30s | lib/stockData.js:783,1043,1150 |
| 同花顺日K缓存：收盘定稿时刻 | 15:05 | lib/thsDailyCache.js:CLOSE_HHMM |
| 同花顺日K缓存：硬过期兜底 | 15 天 | lib/thsDailyCache.js:MAX_AGE_MS |
| 同花顺 all.js 失败退避 | 2 分钟 | lib/stockData.js:THS_ALL_BACKOFF_MS |
| APP_VERSION（缓存破坏戳） | `20261022f` | server.js:108 |
| SQLite busy_timeout | 5000ms | lib/db.js:42-43 |
