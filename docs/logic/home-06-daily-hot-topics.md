# 🔥 今日财经热点 · 反向逻辑说明

> 逻辑模型位置：首页 → 「🔥 今日财经热点」卡片
> 实现文件：`server.js:311-330`（/api/hot-news）、`lib/newsSearch.js:117-152`（getHotNews）、`lib/newsSectorImpact.js`（板块影响识别）、`lib/newsImpactLearning.js`（自学习）、`public/js/homeNews.js`（前端渲染）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 卡片标题「🔥 今日财经热点」 | 固定标题，无日期前缀 | index.html:226 |
| 「更新于 HH:MM」 | 后端 `updated` 字段（ISO）本地化到时分 | homeNews.js:64-67 |
| 「刷新」按钮 | 强制刷新：`?refresh=1` 绕过后端缓存重新抓取 | homeNews.js:93, 109 |
| 折叠按钮 ▾ | 首页通用折叠（`sa_home_collapsed_v1` 持久化） | index.html:230 |
| 置顶大卡（第 1 条） | items[0]：分类徽章 + 标题 + 影响标注 + 摘要 + 「MM-DD HH:mm · 来源」 | homeNews.js:72-78 |
| 列表条目（第 2 条起） | 每条：时间（MM-DD HH:mm）+ 分类徽章 + 标题 + 影响标注 + 情绪色点 | homeNews.js:44-57, 79 |
| 分类徽章（政策/国际/公司/市场） | 四类关键词分类，未命中默认「市场」；CSS 色类映射 | homeNews.js:19-24；newsSearch.js:20-26 |
| 影响标注「▲ 板块 热门个股」 | 命中 NEWS_SECTOR_MAP 的新闻才显示：方向箭头（▲看涨红/▼看跌绿）+ 板块名 + 最多 2 只热门个股 | homeNews.js:34-42；newsSectorImpact.js:237-270 |
| 情绪色点（pos/neg/neu） | 积极/偏多=pos；消极/偏空=neg；其余 neu（含中性） | homeNews.js:26-31；analysis.js:1176-1179 |
| 「数据来源：… · 点击条目跳转原文」 | 页脚固定文案；条目有 url 时整行可点开新窗口 | homeNews.js:80-81 |
| 空态「暂无今日财经热点…」 | items 为空时展示后端 error 文案 | homeNews.js:68-71 |
| 抓取失败「热点获取失败：…」 | fetch 异常时透出 e.message | homeNews.js:96-98 |

## 二、核心公式 / 判定链

**主链路（getHotNews，TTL 10 分钟）**：

```
请求 /api/hot-news
  → 内存缓存命中（10min 内且非 force）？直接返回            newsSearch.js:118-122
  → fetchKuaixunNews(40)：东财 np-listapi 7×24 快讯        newsSearch.js:71-112
       超时 9s；URL = np-listapi.eastmoney.com/comm/web/getFastNewsList
       字段：showTime（北京墙钟）/ realSort（微秒 epoch）/ code（合成深链）
       时间归一化 normalizeNewsTime：秒/毫秒/微秒 epoch 均按 Asia/Shanghai 渲染
       summary 去「【标题】」前缀；无 title 的条目丢弃
  → 快讯为空？兜底 fetchEastmoneyContentNews('财经 股市 政策', 30)  newsSearch.js:124-130
  → 仍为空？返回空结果 + error 文案（空结果也进缓存 10min）  newsSearch.js:131-135
  → 按 title 去重 → classifyCategory 四类分类                newsSearch.js:137-146
  → analyzeSentiment(title+summary) 情绪                     newsSearch.js:145
  → 按 date 字符串降序 → slice(0, 24)                        newsSearch.js:147-148
  → annotateNewsImpact：逐条板块影响识别（仅命中的加 impact）  server.js:317
  → recordImpact：命中 impact 的写入自学习库（md5(title+sector) 幂等） server.js:318-321
  → 附带 impactLearning 状态（前端未展示，API 可见）          server.js:323
```

**分类规则**（四类，顺序判定，先命中先得，newsSearch.js:22-25）：

| 优先级 | 类别 | 关键词（任一命中） |
|---|---|---|
| 1 | 政策 | 央行/货币/利率/降准/降息/财政/国务院/发改委/证监会/资管/监管/政策/法案/国常会/政治局/两会/税收/补贴/社保/公积金/mlf/lpr |
| 2 | 国际 | 美联储/美股/特朗普/拜登/白宫/欧洲/日本/韩国/地缘/俄乌/中东/国际/加息/非农/fomc/英伟达/苹果/特斯拉/谷歌/微软/欧央行/日央 |
| 3 | 公司 | 营收/净利/业绩/回购/减持/增持/并购/重组/上市/退市/分红/募资/中标/签约/订单/研报/发债/定增 |
| 4 | 市场 | 以上都不命中（默认） |

**情绪判定**（analysis.js:1159-1182）：

```
pos = 命中 positiveKeywords 次数；neg = 命中 negativeKeywords 次数（子串匹配，大小写不敏感）
score = round((pos - neg) / (pos + neg) * 100)     # 无命中 → score=0 中性
label: score>30 积极 / >10 偏多 / <-30 消极 / <-10 偏空 / 其余 中性
```

**板块影响识别链**（analyzeNewsImpact，newsSectorImpact.js:237-270）：

```
text = title + ' ' + summary
  → isForeignMarketNews(text)？境外闸门（见第三节）→ 命中则 return null（不映射 A 股）
  → pickSector(text)：打分制定归属
      1) 强排除：命中该板块任一 exclude 词 → 该板块出局（score=0）
      2) 打分：exclusive 专属词 ×3 + keywords 通用词 ×1 + GENERIC 泛词 ×0.5
      3) 泛词（消费/补贴/证券…）不能单独定归属（nonGenericHit=exclusive+normal 命中数必须 >0）
      4) 裁决：总分降序 → 专属词命中数降序 → 表序（确定性兜底）
  → 方向判定（优先级从高到低）：
      ① map 自带 direction=1 → up（如银行行「降准/降息」利好，newsSectorImpact.js:67）
      ② map 自带 direction=-1 → down
      ③ BULLISH_HINTS 命中且无 BEARISH_HINTS → up
      ④ BEARISH_HINTS 命中且无 BULLISH_HINTS → down
      ⑤ 情绪分 >15 → up；<-15 → down；否则 neutral
```

## 三、指标 / 口径

| 指标 | 口径 | 归一化 | 是否进总分 | 出处 |
|---|---|---|---|---|
| 快讯条数 | 每页 40 条（pageSize=40，接口上限截断 100） | 展示 slice(0,24) | 否 | newsSearch.js:71-74, 148 |
| 分类 | 四类关键词子串匹配，顺序判定 | 无 | 否（仅徽章） | newsSearch.js:20-26 |
| 情绪分 | (pos-neg)/(pos+neg)×100，词表计数法 | -100~100 | 否（仅色点） | analysis.js:1174 |
| 板块影响分 | exclusive×3 + normal×1 + generic×0.5（exclude 出局） | 无 | 否（仅标注展示） | newsSectorImpact.js:209-217 |
| 方向 signal | 1/-1/0 | 无 | 是（进自学习库 recordImpact） | newsSectorImpact.js:252-261 |
| 自学习准确率 | correctCount / correctedCount（仅统计被复核过的记录） | 0~100 | 是 | newsImpactLearning.js:94 |

**境外闸门三层判定**（isForeignMarketNews，返回 true=拒收，newsSectorImpact.js:179-185）：

| 顺序 | 条件 | 结果 |
|---|---|---|
| ① | 命中 GLOBAL_PRICE_KEYWORDS（原油/油价/黄金/金价/铜/锂/稀土/石油/天然气/芯片/半导体/存储） | 放行（全球定价品种有真实传导路径） |
| ② | 无境外主体（国别/城市/机构词 或 境外交易所缩写正则，如 BIST/NSE/MOEX） | 放行（非境外新闻） |
| ③ | 有境内锚点（A股/中国/我国/证监会/沪深/央行/人民币/中证/国务院…） | 放行（境内为主混合新闻） |
| ④ | 境外主体 + 无境内锚点 | **拒收**（与 A 股无因果链，宁拒勿错） |

**裸通用词防护**（GENERIC_TOKENS，newsSectorImpact.js:97-112）：`设备/市场/行业/板块/产业/产品/服务/材料/技术/系统/平台/项目/业务` 加载时从所有 keywords/exclusive/exclude 中剔除（整词相等判断，「医疗设备」等复合词不受影响）——防「风电设备」误中「设备」类专属词。

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | 主：东财 `np-listapi.eastmoney.com/comm/web/getFastNewsList`（7×24 快讯，实测旧接口 newsapi 已 404 下线，newsSearch.js:32-34）；兜底：东财内容搜索 `search-api-web.eastmoney.com`（newsSearch.js:159-205） |
| 采集/落盘 | 无独立脚本；请求时实时抓取。内存缓存 `hotNewsCache` TTL 10min（newsSearch.js:15, 118）；自学习落盘 `data/news_impact_learning.json`（上限 2000 条，newsImpactLearning.js:17, 69） |
| 调度 | 无定时；用户打开首页/点刷新触发。自学习记录由每次请求同步写入（recordImpact 幂等） |
| 自动复核 | 盘后 15:30 结算任务中 `autoReviewImpacts`：用当日板块实际涨跌对照方向自动标对错（server.js:1971-1979）；已人工更正的记录不覆盖 |
| 前端取数 | `GET /api/hot-news`（homeNews.js:93）；前端 8s 节流（THROTTLE=8000，homeNews.js:5, 87）；无 force 时不重复请求 |

## 五、降级 / 容错 / 诚实性设计

| 场景 | 行为 | 出处 |
|---|---|---|
| 快讯接口超时/失败（9s） | 返回 [] → 触发内容搜索兜底 | newsSearch.js:108-111, 124-130 |
| 兜底也为空 | 返回 `{items:[], error:'暂未获取到最新快讯（可能网络受限或接口变更）'}`，空结果**也写缓存**（10min 内不重试） | newsSearch.js:131-135 |
| 接口结构变更（无 fastNewsList） | list 为空 → 同上兜底链 | newsSearch.js:81-83 |
| 后端 500 | 返回 `{source, updated, items:[], error}`，前端渲染空态文案 | server.js:326-329 |
| 前端 fetch 失败 | 展示「热点获取失败：e.message」（透出真实错误） | homeNews.js:96-98 |
| 板块识别无命中 | 不加 impact 字段，卡片不显示影响标注（不是错，是「无关」） | newsSectorImpact.js:278-279 |
| 境外新闻 | 拒收映射（不显示影响标注），但**新闻本身仍展示** | newsSectorImpact.js:243 |
| 自学习写盘失败 | 静默忽略（`catch {}`），不影响主流程 | newsImpactLearning.js:31-33 |
| ⚠️ 注意 | 「无影响标注」≠「无影响」——未命中映射表的板块一律无标注，用户可能误读为中性；**20261016 D2 修复**：卡片脚注已明示「板块影响标注仅覆盖 N 个行业板块」（N 由后端 NEWS_SECTOR_MAP.length 动态传出，当前 21 个） | newsSectorImpact.js:48-89（NEWS_SECTOR_MAP 共 21 个板块；原文档误写 22，已校正） |

## 六、逻辑漏洞自查清单（审计用）

- [x] ~~**TREE 文案漂移（已证实）**：logicModel.js:67-68 写「叠加涨停板池按行业本地聚合；LLM 仅作可选润色」，inputs 列「涨停板池（按行业聚合）」——实现（newsSearch.js:117-152）纯确定性分类+情绪，无 LLM、无涨停板池~~ → **✅ 已修复（20261016）**：TREE 文案改为「关键词四类分类 + analyzeSentiment 情绪 → 板块影响识别；纯确定性计算，无 LLM、无涨停板池」，inputs 改列「东财 7×24 快讯（np-listapi）/ 东财内容搜索（兜底）/ 板块关键词映射」实际数据源

- [ ] **分类顺序偏置**：一条新闻同时含「央行」和「英伟达」（如「美联储降息 英伟达大涨」）时归「政策」而非「国际」——先命中先得的顺序判定是否符合预期？（newsSearch.js:22-25）
- [ ] **泛词表与分类表重叠**：「证券」在分类表（newsSearch.js:22 无，但 newsSectorImpact.js:42 已降为泛词）与板块映射表处置不同——分类表的「监管/资管」等词是否也会把交易所规则类新闻归「政策」？（newsSearch.js:22 vs newsSectorImpact.js:68-74）
- [ ] **方向偏置与情绪冲突**：map.direction=1（如银行行）时**完全不看情绪**——「央行降准但银行股大跌」类标题仍标 ▲看涨，是否需加情绪否决？（newsSectorImpact.js:252-253）
- [ ] **BULLISH/BEARISH 同时命中**：hasBull && hasBear 时落到情绪分支（±15），但「回购」「增持」在 BULLISH_HINTS、「减持」在 BEARISH_HINTS——一条含「减持+回购」的新闻方向是否合理？（newsSectorImpact.js:254-261）
- [ ] **情绪词表子串误伤**：positiveKeywords 含英文 'buy'/'gain'/'record'——英文快讯里 "record high" 计多、「buyback」含 buy；中文里「突破」「成功」极高频率中性使用（如「成功举办」）——词表计数法把「成功举办」计为利好是否失真？（analysis.js:1140-1157）
- [ ] **score=±15 方向阈值 vs 情绪标签阈值不一致**：影响方向用 ±15（newsSectorImpact.js:258-259），色点标签用 ±10/±30（analysis.js:1176-1179）——同一条新闻可能「色点=中性」但「影响方向=看涨」，两处口径是否需要统一？
- [x] ~~**板块表只有 21 行**（原文档误写 22，20261016 校正）：银行/证券/食品饮料/家用电器等大消费齐备，但**没有**「电子」「建筑」「社服」「美护」「纺服」「轻工」等——这些行业的新闻一律无影响标注，是否算系统性漏报？~~ → **✅ 已修复（20261016，按 D2 方案②）**：卡片脚注明示「板块影响标注仅覆盖 N 个行业板块，未命中板块的新闻不显示标注（≠无影响）」，N 由后端 `NEWS_SECTOR_MAP.length` 动态传出（当前 21）杜绝文档与代码再次脱节；按申万补齐到 31 个列为 README 待决策 D2 排期项
- [ ] **打分平局表序兜底**：同分时按 NEWS_SECTOR_MAP 数组顺序取前者——「半导体」行在「计算机」行之前，含「AI」「芯片」的新闻归半导体而非计算机，顺序即语义，是否可接受？（newsSectorImpact.js:224）
- [ ] **exclude 单向性**：医药生物排除「医疗器械」，医疗器械也排除「药品」——互斥设计下，同时提及两类（「创新药+医疗器械集采」）的新闻**两个板块都出局**，影响标注消失，是否该允许一方低分胜出？（newsSectorImpact.js:58-59）
- [ ] **时间字段纯字符串排序**：`items.sort((a,b) => (b.date||'').localeCompare(a.date||''))`——date 为空字符串的条目排最后，但若兜底内容搜索返回的 date 格式与快讯不同（如 '2026-08-11' vs '2026-08-11 15:30'），localeCompare 仍按字典序，跨源混排是否稳定？（newsSearch.js:147）
- [ ] **缓存与刷新竞态**：force=1 时不读缓存但仍写缓存——两次并发刷新是否可能把较旧结果覆盖较新结果？（hotNewsCache 无锁，newsSearch.js:120-121, 150）
- [ ] **空结果缓存 10min**：接口临时故障时，用户 10 分钟内点刷新都拿到同一句 error——是否应该给空结果更短 TTL？（newsSearch.js:131-134）
- [ ] **自学习只增不删**：recordImpact 幂等但无 TTL，2000 条后按时间截尾——「降准利好银行」这类**永久性映射**与**一次性事件**混在一起统计准确率，口径是否混淆？（newsImpactLearning.js:69）
- [ ] **自动复核方向判据极简**：up 且 chg>0 即正确——「利好银行但当天大盘暴跌拖累银行小跌」会被记错，单日噪声是否该加容差（如 ±0.5%）？（newsImpactLearning.js:113-114）
- [ ] **neutral 方向不自动复核**：`if (r.direction === 'neutral') continue`——中性记录永远只有人工复核一条路，中性占比是否被低估？（newsImpactLearning.js:110）
- [ ] **板块名口径不一致**：自学习库 key 是展示名（「医药生物」「电力设备」…），而自动复核的 chgMap 来自 getMarketOverview 的 sectorsUp/Down 名——两处板块名若不同源（申万 vs 东财行业），chg 匹配不上则静默跳过（`chg == null` 不标记）。（newsImpactLearning.js:111-112 vs server.js:1974-1978）
- [ ] **hotStocks 静态写死**：每个板块的「热门个股」是硬编码 3-5 只（如半导体→中芯国际/北方华创…），不随市值/热度更新——标注「热门」是否可能长期过期？（newsSectorImpact.js:48-89 hotStocks 字段）
- [ ] **前端 8s 节流 vs 后端 10min 缓存叠加**：用户连点刷新时前端 8s 内直接 return（非 force），但按钮 refresh() 是 force=true 路径——节流只保护非强制加载，符合预期否？（homeNews.js:87, 103）
- [ ] **title 去重但 summary 不去重**：同一事件多源报道标题不同（如「XX发布」vs「XX出台」）→ 两条都展示，是否算信息噪声？（newsSearch.js:137-141）
- [ ] **置顶卡永远是排序后第一条**：第 1 条即「最新」——凌晨抓取时置顶可能是昨日 23:50 的旧闻，标题写「今日」是否口径漂移？（homeNews.js:72 vs newsSearch.js:147）

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 快讯 TTL | 10min | newsSearch.js:118 |
| 快讯每页条数 | 40（接口截断 100） | newsSearch.js:71-72 |
| 快讯超时 | 9s | newsSearch.js:78 |
| 兜底内容搜索条数/超时 | 30 / 8s | newsSearch.js:127, 185 |
| 展示条数 | 24 | newsSearch.js:148 |
| summary 截断 | 120 字符 | newsSearch.js:100 |
| 前端节流 | 8s | homeNews.js:5 |
| 专属词/通用词/泛词分值 | 3 / 1 / 0.5 | newsSectorImpact.js:44-46 |
| 自学习上限 | 2000 条 | newsImpactLearning.js:17 |
| 影响标注热门个股展示数 | 2 | homeNews.js:38 |
| 方向情绪阈值 | ±15 | newsSectorImpact.js:258-259 |
