# 🌐 每日宏观 & 政策 · 反向逻辑说明

> 逻辑模型位置：首页 → 「🌐 每日宏观 & 政策」卡片（单一卡片，三个数据区块）
> 实现文件：`server.js:388-438`（三个 API）、`lib/macroData.js`（重要经济数据）、`lib/macroNews.js`（宏观政策动态）、`lib/usMacroEvents.js`（美国经济数据/事件）、`lib/macroSentimentFactors.js`（供市场情绪因子消费）、`public/js/homeMacro.js`（前端渲染）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

卡片由三个并发请求拼成（homeMacro.js:184-188），任一失败不影响其他区块：

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 「更新于 YYYY-MM-DD HH:mm」 | 取 macro-news.updated，回退 macro-data.updated | homeMacro.js:128-131 |
| 「🔄 刷新」按钮 | 三接口同时 `?refresh=1`；刷新期间按钮禁用显示「刷新中…」 | homeMacro.js:174-176, 202 |
| 📊 重要经济数据（区块①） | 12 张指标卡（indCard）：名称+统计期+数值+单位+口径标签+趋势徽章+环比/累计等 metrics+解读+来源 | homeMacro.js:58-76 |
| 趋势徽章「▲ +0.3pct / ▼ -0.2 点 / — 持平」 | `trend`=up/down/flat；deltaUnit=pct 显示 pct，否则显示「点」 | homeMacro.js:43-52 |
| 「数据源暂未提供最新值」占位卡 | `unavailable:true` 的指标：灰色徽章 + 数值「—」 | homeMacro.js:59-60；macroData.js:684-708 |
| 📰 宏观政策动态（区块②） | 按 5 类分组（货币政策/财政监管/数据发布/国际宏观/市场），每类最多 6 条；类头显示「N 条」 | homeMacro.js:142-152 |
| 分类图标 | 💰货币政策 / 🏛️财政监管 / 📊数据发布 / 🌍国际宏观 / 📈市场 | homeMacro.js:22 |
| 政策条目 | 时间（MM-DD HH:mm）+ 标题（有 url 可点开）+ 情绪色点 | homeMacro.js:33-42 |
| 🌍 国际经济数据 & 事件（区块③） | 事件卡 evCard：标题+分类+时间+双维度徽章+超预期角标+三值+摘要+备注 | homeMacro.js:77-118 |
| 双维度徽章「经济 偏多/偏空 · 股市 偏多/偏空」 | 20261013e 起拆成两个维度（`eco` 与 `impact`）；旧数据无 eco 字段时回退单徽章 | homeMacro.js:84-90 |
| 超预期角标（超预期/不及预期/符合预期） | `deviate`=above/below；released 且无 deviate → 符合预期 | homeMacro.js:91-95 |
| 「今日公布 / N 天后」角标 | upcoming 且 daysLeft 0~3 才显示 | homeMacro.js:96-100 |
| 三值行「公布 / 预期 / 前值」 | actual/forecast/previous 任一非空即渲染；公布值按 deviate 着色 | homeMacro.js:101-110 |
| 空态（三处） | ①经济数据空 → 「重要经济数据暂不可达，请稍后刷新」；②政策动态空 → 整块不渲染；③美国事件空 → 显示 notice 诚实文案 | homeMacro.js:120-122, 141, 160-164 |
| 页脚来源标注 | 「📌 经济数据来源：…；动态来源：…；美国宏观事件排期：…（过期事件自动剔除）。仅供研究参考，不构成投资建议。」 | homeMacro.js:165 |
| 采集失败 | 15s 超时或异常 → 「宏观数据采集失败：e.message」 | homeMacro.js:183, 198-199 |

## 二、核心公式 / 判定链

### 区块①：重要经济数据（getMacroIndicators，macroData.js:643-747）

```
自然日缓存命中（非 force）→ 直接返回                          macroData.js:644-645
8 个东财数据中心报表并发（Promise.allSettled，单条失败不影响他人） macroData.js:647-654
  CPI/PPI/GDP/PMI/M2/社零/固定资产投资/财政收入 → 各 buildXxx 解析 + 解读
财政支出 + 工业增加值：妙想 EDB 主源（12s 超时）与财政部公告/金十三路并发  macroData.js:656-667
  财政支出：妙想命中 → 并入财政部累计口径；不可达 → 整卡回退财政部公告解析    macroData.js:669-673
  工业增加值：妙想不可达 → 金十（8s 超时 + 90 天时效校验）                   macroData.js:675-697
    金十数据超 90 天 → 占位卡（unavailable，不展示陈旧数据）                  macroData.js:683-692
    两者都不可达 → 占位卡                                                   macroData.js:699-709
LPR + 社融：LPR（12s）/ 社融（90s，人民银行 xlsx 解析）并发                 macroData.js:714-720
按 INDICATOR_ORDER 排序（12 项）                                            macroData.js:722
buildMacroRules：逐指标按「财务」档 90 天时效体检 + 变化与边际装饰            macroData.js:744, 752-770
```

**趋势徽章公式**（macroData.js:59-64）：`trendOf(cur, prev)`：cur>prev→up（delta=cur-prev）；cur<prev→down（delta=prev-cur）；相等或任一为空→flat（delta=null/0）。

**解读文案规则**（以 CPI 为例，macroData.js:96-104）：v<0「通缩区间」；v<1「低位」；v<3「温和·政策合意区间」；≥3「通胀压力抬头」。环比/累计由 `NATIONAL_SEQUENTIAL` / `NATIONAL_ACCUMULATE-100` 得出。

### 区块②：宏观政策动态（getMacroNews，macroNews.js:41-137）

```
自然日缓存（跨日失效）                                        macroNews.js:42-43
主源：东财 7×24 快讯 60 条 → macroCategory 正则过滤            macroNews.js:53-58
过滤后 <6 条 → 东财内容搜索兜底（关键词 '宏观 政策 央行…'）     macroNews.js:62-72
仍 <6 条 → 放宽到「经济/市场/股市/A股/债市/基金/外汇/人民币/金融/产业」  macroNews.js:75-79
仍 <8 条 → cn-financial-scraper 监管/政策源补财政监管类          macroNews.js:84-106
逐条：category（四类正则，未命中→'市场'）+ analyzeSentiment 情绪  macroNews.js:108-112
按 date 降序 → slice(0, 24) → 按 5 类分组 byCategory            macroNews.js:113-120
```

**分类正则**（macroNews.js:18-23，顺序判定）：货币政策（央行/降准/降息/LPR/MLF/逆回购/汇率/人民币…）→ 财政监管（财政/专项债/国债/国务院/发改委/证监会/税收…）→ 数据发布（CPI/PPI/PMI/GDP/工业增加/社零/M2/失业率…）→ 国际宏观（美联储/加息/非农/FOMC/关税/美债…）→ 市场（兜底类名）。

### 区块③：美国经济数据/事件（getUsMacroEvents，usMacroEvents.js:73-85）

```
路由先触发 refreshUsMacroEvents（12h TTL 自动抓取，失败静默）    server.js:423-424
同步读取三级源，取第一个非空：
  ① 华尔街见闻三值缓存（data/us_macro_results_cache.json）——CPI/PPI/非农/FOMC 等，公布/预期/前值齐全
  ② FedRateCalc 排期缓存（data/us_macro_calendar_cache.json）——仅日期无三值
  ③ 内置 FALLBACK_EVENTS（5 条：2026-10/11/12 月 CPI、10/12 月 FOMC、11 月非农）
统一过滤 applyFilter：
  released：公布后 14 天内保留（复盘窗口）                          usMacroEvents.js:50-53
  upcoming：date >= 今天保留                                       usMacroEvents.js:54
  按 date 升序；released 补 daysSince、upcoming 补 daysLeft        usMacroEvents.js:56-66
```

## 三、指标 / 口径

| 指标 | 口径 | 归一化 | 是否进总分 | 出处 |
|---|---|---|---|---|
| 12 张经济数据卡 | CPI/PPI/GDP/PMI/M2/LPR/社融/社零/固定资产投资/工业增加值/财政收入/财政支出（INDICATOR_ORDER 排序） | 无 | 间接（7 个进国内宏观因子，见下） | macroData.js:626-641 |
| 政策动态分类 | 四类正则 + '市场' 兜底；前端 5 类展示 | 无 | 否 | macroNews.js:18-31, 121 |
| 美国事件方向 | `eco`（对经济基本面）+ `impact`（对股市偏好）双维度；deviate=above/below/符合 | 无 | 是（FOMC 的 direction 进美国宏观因子） | macroSentimentFactors.js:141-142 |
| 国内宏观因子 signal | 7 指标阈值打分（CPI 0.5~3=+1/<0=-1；PPI 0~4=+1/<0=-1；GDP 4.5~6=+1/<4=-1；PMI ≥50=+1/否则 -1；M2 8~12=+1/<8=-1；社零 3~8=+1/<2=-1；固投 3~9=+1/<0=-1）→ 平均分 avg；avg>0.15→+1；avg<-0.15→-1；否则 0 | -1/0/+1 | 是（初始权重 0.5） | macroSentimentFactors.js:40-66, 28 |
| 美国宏观因子 signal | 只取标题含 FOMC/利率决议的事件；direction=bearish→-1 / bullish→+1 / neutral→0；无 FOMC→0 | -1/0/+1 | 是（初始权重 0.5） | macroSentimentFactors.js:141-146 |
| 两因子状态机 | 触发键变化→active+权重 0.5；激活后若大盘实际方向与 signal 相反→dormant+权重 0 | 0/0.5 | 是 | macroSentimentFactors.js:92-115 |
| 宏观时效体检 | 每指标按 kind='financial' 90 天 TTL 时效校验（三规则） | 无 | 否（仅标注） | macroData.js:752-770 |

**注意口径差**：12 张卡片中只有 7 个指标（CPI/PPI/GDP/PMI/M2/RETAIL/ASSET_INVEST）参与国内宏观因子评分；LPR/社融/工业增加值/财政收入/财政支出 5 个走 `default: s=0`——**有卡无分**（macroSentimentFactors.js:47-56）。

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | ①东财数据中心 `datacenter-web.eastmoney.com/api/data/v1/get`（8 报表 RPT_ECONOMY_* + LPR RPTA_WEB_RATE）；②妙想 EDB（工业增加值 EMM00008445/08464、财政支出 EMM00059246/59231）；③金十（工业增加值备用，90 天时效校验）；④财政部公告解析（财政支出备用）；⑤人民银行统计表 xlsx（社融，pbcMacro）；⑥东财 7×24 快讯 + 内容搜索（政策动态）；⑦华尔街见闻宏观日历 / FedRateCalc（美国事件） |
| 采集/落盘 | macroData：内存缓存按自然日；macroNews：内存缓存按自然日；usMacroEvents：读 `data/us_macro_*_cache.json` + 路由触发时 12h TTL 自动刷新；macroSentimentFactors：状态落盘 `data/sentiment-macro/macroFactors.json`（每次计算都写） |
| 调度 | 无独立定时（macro 三区块均按请求+自然日缓存）；美国事件刷新挂在 /api/us-macro-events 路由上（12h TTL 内不重抓） |
| 前端取数 | 三并发 fetch（homeMacro.js:184-188），15s AbortController 总超时；`cache: 'no-store'`；前端 8s 节流 |

## 五、降级 / 容错 / 诚实性设计

| 场景 | 行为 | 出处 |
|---|---|---|
| 单个东财报表失败 | allSettled 隔离，其余指标照常；来源标注只列实际命中通道 | macroData.js:647-654, 726-732 |
| 工业增加值双源均失败 | 占位卡（unavailable:true），明示「数据源暂未提供最新值」 | macroData.js:699-709 |
| 金十数据陈旧（>90 天） | 判 stale → 占位卡，**不展示陈旧数据** | macroData.js:683-692 |
| 快讯接口失败 | 内容搜索兜底；来源标注改为「东财内容搜索（kuaixun 不可用时兜底）」 | macroNews.js:124-126 |
| 政策过滤后过少 | 三级补齐（内容搜索 → 放宽关键词 → cnscraper 监管源） | macroNews.js:62-106 |
| 美国事件双源均失败 | 内置 FALLBACK_EVENTS 兜底；source 标注「策划式清单兜底（自动抓取不可达）」 | server.js:432；usMacroEvents.js:81-83 |
| 美国事件全部过期 | events 空 → notice 诚实文案，前端显示空态而非隐藏区块 | server.js:427-429；homeMacro.js:160-164 |
| 陈旧缓存 | `cal.stale` → source 标注「自动抓取（陈旧缓存，源暂不可达）」 | server.js:430-431 |
| 情绪因子计算异常 | catch 返回 []（两因子不显示），打印 stack | macroSentimentFactors.js:175-178 |
| ⚠️ 注意 | 区块②「无条目」时前端**整块不渲染**（静默隐藏）——用户无法区分「今日无宏观新闻」与「采集失败」 | homeMacro.js:141 |

## 六、逻辑漏洞自查清单（审计用）

- [x] ~~**注释漂移（已确认）**：usMacroEvents.js:10 文件头写「released 保留 **7 天**」，applyFilter 注释:44 与代码:52 实际是「**14 天**」~~ → **✅ 已修复（20261016）**：文件头注释改为「保留 14 天（以 applyFilter 代码为准）」
- [ ] **国内因子 7/12 口径差**：12 张卡只有 7 个进因子评分，LPR/社融/工业增加值/财政收支「有卡无分」——LPR 下调这种强信号对国内宏观因子毫无贡献，是否符合设计意图？（macroSentimentFactors.js:47-56）
- [x] ~~**domKey 漂移误触发**：domKey = `indicators[0].period`（排序后首个指标，正常是 CPI）——CPI 抓取失败时 domKey 漂移到 PPI/其他指标的 period，stepFactor 判「新触发」→ 权重重置为 0.5、状态复活~~ → **✅ 已修复（20261016）**：domKey 优先取 CPI 的数据期（月度公布最稳定），CPI 缺失才回退排序首位、最后回退采集日；正常路径（CPI 在）展示与行为完全不变
- [ ] **PMI 二元判定过硬**：PMI 49.9 与 48 同为 -1、49.9 与 50 只差 0.1 却从 +1 跳到 -1——荣枯线附近无缓冲带，是否该加 0.5 分过渡？（macroSentimentFactors.js:51）
- [ ] **avg>0.15 阈值与指标数耦合**：7 个指标平均，若只有 1 个指标可得分（其余抓取失败），avg=±1 → 直接 ±1 满信号——单指标驱动整体方向，样本不足时是否该降权或标注？（macroSentimentFactors.js:60-64）
- [ ] **相悖检测只看符号不看幅度**：`Math.sign(curIndex - observedIndex)`——上证涨 0.01% 即判「相符」，涨跌方向反转才归零；日内噪声是否该加容差（如 ±0.5%）？（macroSentimentFactors.js:104-109）
- [ ] **DOMESTIC 因子无基准锚**：usSt 传了 usAnchor（FOMC 日收盘），domSt 传 null → 新触发时锚定「本次实时收盘」——国内数据公布日（通常盘后/假日）与触发日之间若有大盘波动，相悖判定的基准不干净。（macroSentimentFactors.js:154-155, 98）
- [ ] **美国因子只认 FOMC**：非农/CPI 事件 impact=bearish 也不进 signal（注释明确排除，防干扰）——CPI 超预期这类高频事件的信号价值被完全放弃，是否该设次要权重？（macroSentimentFactors.js:139-142）
- [ ] **每次计算都写盘**：computeMacroFactors 无节流 writeState——市场情绪模块高频调用时（每 60s 刷新）会产生同等频率的磁盘写入，长期是否磨损/竞态？（macroSentimentFactors.js:156）
- [ ] **released 14 天窗口**：超预期事件保留 14 天供复盘，但 `daysSince` 只用于展示；14 天后事件消失 → usKey 回退 `events[0].id` → 触发键变化 → 因子重置激活——「过期」被误当「新触发」，是否符合预期？（usMacroEvents.js:52 + macroSentimentFactors.js:146, 154-155）
- [ ] **upcoming 字符串比较**：`e.date >= today` 是字典序——date 字段若非严格 'YYYY-MM-DD'（如带时间 '2026-10-14 20:30'）比较会错乱；实测两个缓存源与内置清单是否统一？（usMacroEvents.js:54）
- [ ] **dayDiff 用 +08:00 时区**：`new Date(a+'T00:00:00+08:00')`——美国事件 date 是北京自然日，与东财/统计局口径混算时差一天风险；跨源事件 date 定义是否一致？（usMacroEvents.js:39-41）
- [x] ~~**区块② 空态静默**：政策动态为 0 条时前端整块不渲染——采集失败与「真无新闻」不可区分，与区块③的诚实 notice 设计不一致~~ → **✅ 已修复（20261016）**：0 条时渲染诚实空态（有后端 error 透出 error，否则「今日暂无宏观/政策类快讯，请稍后刷新」），与区块③口径一致
- [ ] **macroCategory 与 hot-news 分类表不同源**：政策动态四类正则（macroNews.js:18-23）与今日热点四类词表（newsSearch.js:20-26）是两套独立关键词——同一条「降准」新闻在热点卡可能归「政策」、在宏观卡归「货币政策」，跨卡片分类口径是否需统一？
- [ ] **LPR 无独立解析函数引用**：FETCHERS 无 LPR 项，LPR 走单独 `fetchLPR()`（12s 超时）——抓取失败时**无占位卡**（不像工业增加值有兜底卡），LPR 卡直接消失，total 仍显示 12，「应有 12 张实际 11 张」的口径差是否明示？（macroData.js:714-719, 739）
- [ ] **社融 90s 超时拖慢首屏**：社融是三个区块之外最慢的一环（人民银行 xlsx 解析）， Promise.race 90s——接口整体等待上限被社融撑大，前端 15s 就 abort 了，后端算 90s 是否浪费？（macroData.js:716 vs homeMacro.js:183）
- [ ] **buildMacroRules 的 series 依赖**：`ind.series` 数组只有部分 buildXxx 产出——未产 series 的指标 rules 为空壳（时效有、变化无），前端不展示 rules 时这些计算是否白做？（macroData.js:756-767）
- [ ] **macroData 自带 localToday**：macroData.js:31-35 自己实现本地日期，未用共享 `localDate()`——与 newsSearch/macroNews 的 `localDate` 口径存在两条实现，时区/边界日行为需抽查一致性。（macroData.js:31-35 vs macroNews.js:36）
- [ ] **分类正则顺序**：「央行」在货币政策第一位——「央行行长出席 IMF 会议」会被归货币政策而非国际宏观；四类顺序判定与 hot-news 同理存在顺序偏置。（macroNews.js:19-22）
- [ ] **美国事件时间展示三选一**：前端优先 `dateZh`，回退 `dateUs`（homeMacro.js:113）——dateZh 是北京墙钟字符串、dateUs 是美东，混排时同一卡片可能这次显示北京时间、下次显示美东时间，是否该统一？
- [ ] **工业增加值占位卡的布局动机**：注释明说「保留占位卡片，避免与相邻固定资产投资卡片布局失衡」（macroData.js:698）——为布局保留 unavailable 卡，是否会让用户误以为「有数据但源暂缺」而非「本就没有」？

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 东财报表每指标条数 | 3（当前+前两期） | macroData.js:648 |
| 东财报表超时 | 12s | macroData.js:41 |
| 妙想/财政部/LPR 超时 | 12s | macroData.js:658, 661, 715 |
| 金十备用超时/时效 | 8s / 90 天 | macroData.js:681, 683 |
| 社融超时 | 90s | macroData.js:716 |
| 宏观快讯主源条数 | 60 | macroNews.js:54 |
| 兜底触发阈值 | 过滤后 <6 条；监管源补充 <8 条 | macroNews.js:62, 84 |
| 展示条数 | 24（前端每类再截 6） | macroNews.js:114；homeMacro.js:146 |
| 美国事件 released 保留 | 14 天（文件头注释误写 7 天） | usMacroEvents.js:52（:10 漂移） |
| 美国事件刷新 TTL | 12h | usMacroEvents.js:88 |
| 国内因子阈值 | 见第三节七指标区间；avg ±0.15 | macroSentimentFactors.js:47-63 |
| 两因子初始权重 | 各 0.5 | macroSentimentFactors.js:28 |
| 前端总超时 | 15s | homeMacro.js:183 |
| 前端节流 | 8s | homeMacro.js:5 |
