# 评分行（技术面 / 基本面 / 资金热度 / 个股近期热点）· 反向逻辑说明

> 逻辑模型位置：个股页 → 第一行评分卡（4 张）+ 「查看计算」追溯面板
> 实现文件：`public/index.html:327-361`（结构）、`public/js/app.js:2004-2053`（评分渲染）、`lib/analysis.js:422-529`（技术面）、`lib/fundamentalScore.js`（基本面）、`lib/capitalFlow.js:625-828` + `public/js/capitalCharts.js:516-661`（资金热度）、`lib/hotTopics.js`（近期热点）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 技术面评分卡 `#techScore` | 显示 `data.technical.techScore`（文字等级：强烈看多/偏多/中性/偏空/强烈看空）；下方 detail 显示 `signals.trend`（上升/下降/震荡趋势） | app.js:2006-2010 |
| 基本面评分卡 `#fundScore` | 显示 `overall（等级）+ (score/100)`，如「良好 (72/100)」；detail 显示 `rating`（A+/A/B/C/D） | app.js:2013-2017 |
| 资金热度卡 `#capitalScore` | 初始占位 `--`（detail「资金量能加载后更新」）；资金量能数据到位后由 `renderCapitalScore` 更新为 0-100 分数 + 等级 | app.js:2019-2023, 2038-2046 |
| 🔥 个股近期热点卡 | 独立异步加载 `/api/hot-topics/:symbol`；三种内容态：当日异动归因 / 网络热议话题 / 加载中或未配置 Key | app.js:1681-1801 |
| 「查看计算 ▾」追溯面板 | 点评分卡展开 `#scoreTracePanel`，按卡片类型展示计算依据（trendScore 拆解 / 四维得分 / 热度加减分明细） | index.html:333/339/345, app.js:6244-6312 |
| 评分卡配色 | `scoreClass()` 映射等级→CSS 类（多/空/中性），与全站红涨绿跌一致 | app.js:2009, 2016, 2045 |

## 二、核心公式 / 判定链

### 2.1 技术面评分（trendScore → 等级）

`trendScore` 由 **4 类信号累加**（lib/analysis.js:424-470）：

| 信号 | 计分规则 | 分值 | 出处 |
|---|---|---|---|
| MA 趋势 | 收盘>MA5>MA20 → 上升趋势 | +2 | analysis.js:426-429 |
| MA 趋势 | 收盘<MA5<MA20 → 下降趋势 | −2 | analysis.js:430-432 |
| RSI | >70 超买 / <30 超卖 / >50 偏强 / 其余偏弱 | −1 / +1 / +0.5 / −0.5 | analysis.js:438-442 |
| MACD | DIF>Signal 且柱>0 多头；DIF<Signal 且柱<0 空头 | +1 / −1 | analysis.js:447-452 |
| MACD 交叉 | 金叉 / 死叉（与前一日比） | +1.5 / −1.5 | analysis.js:454-459 |
| KDJ | J>100 或 K>80 超买；J<0 或 K<20 超卖 | −0.5 / +0.5 | analysis.js:465-467 |
| KDJ 方向 | K>D 偏多；K≤D 偏空 | +0.5 / −0.5 | analysis.js:468-469 |

理论区间 ±7.5。等级映射（analysis.js:486-490）：

| trendScore | 等级 |
|---|---|
| ≥ 3 | 强烈看多 |
| ≥ 1.5 | 偏多 |
| ≤ −3 | 强烈看空 |
| ≤ −1.5 | 偏空 |
| 其余（−1.5~1.5） | 中性 |

> ⚠️ 注意：`signals` 里的**布林带位置（bollPosition）与成交量（volumeTrend/volumeRatio）只展示、不计分**（analysis.js:472-483, 517-525 无 trendScore 加减），但追溯面板文案写「6 个信号综合打分」——见清单 T1。

### 2.2 基本面评分（四维各 25 分，总分 100）

`computeFundamentalScore`（fundamentalScore.js:98-398，20260909d 重构版）：**四维度各固定 25 分，不随公司类型浮动**（fundamentalScore.js:104）。

| 维度 | 规则 | 出处 |
|---|---|---|
| ① 估值 25 | PE/PB/PS 任一为负 → 本维 0 分（重度利空，不做中性评价）；三项为正时：加权分位 = 行业均值分位×0.6 + 自身历史百分位×0.4（历史序列 <30 期时只用行业侧），得分 = 25×(1−加权分位/100)；PEG>0 且 <1 额外 +5（封顶 25） | fundamentalScore.js:134-181 |
| ② 盈利能力 25 | ROE/净利率/毛利率均取 TTM 权威口径（取数层 `computeTtmMetrics`，窗口不完整回退最新披露期并标注）；每项 ≥ 行业中枢得满分 25/3，低于按 `值/中枢` 比例扣分；按有效项数归一到 25 | fundamentalScore.js:196-243 |
| ③ 成长性 25 | 三项同比（合并营收/归母净利/扣非净利，取本地财报库 `zyzbHistory`）；任一为负 → 本维 0 分；全为正时：绝对增速档位（>30→1 / >20→0.8 / >10→0.6 / >5→0.4 / 其余 0.2）× 两年趋势系数（加速×1.15 / 持平×1.0 / 减速×0.85），按有效项平均，封顶 25 | fundamentalScore.js:245-298 |
| ④ 财务健康 25 | 四项各 6.25 分：资产负债率（行业中枢±15pp 满分，每偏离 30pp 扣满；无中枢时金融 80-96 / 地产建筑 60-80 / 一般 30-60 内置区间）、流动比率（≥2 满分 / ≥1.5 0.85 / >1 0.7 / ≤1 0）、每股经营现金流（>0 满分）、股息率（≥3% 满分 / ≥1% 0.6 / >0 0.3）；按有效项归一到 25 | fundamentalScore.js:300-373 |

总分 → 等级（fundamentalScore.js:377-381）：

| 总分 | overall | rating |
|---|---|---|
| ≥80 | 优秀 | A+ |
| ≥65 | 良好 | A |
| ≥50 | 一般 | B |
| ≥35 | 较弱 | C |
| 其余 | 较差 | D |

全局兜底：任一指标无法取值 → 记入 `unavailable`、显示 0、**不参与该维度评分**（不稀释），并生成 notice 提示（fundamentalScore.js:105-106, 392-396）。

### 2.3 资金热度评分（0-100，50 中性起点）

**权威源在后端** `computeCapitalConclusion`（capitalFlow.js:649-828）；前端 `capitalCharts.calculateScore` 是镜像兜底，仅当后端 `conclusion.score` 缺失时启用（capitalCharts.js:520-536）。

| 加减项 | 规则 | 分值 | 出处 |
|---|---|---|---|
| 量能热度 | heatLevel：显著放量/温和放量/量能平稳/缩量/地量 | +13 / +8 / 0 / −6 / −10 | capitalFlow.js:664-671 |
| 近5日主力净流 | 占流通市值比：>0.5% 满分 / >0.2% 0.66 / >0 0.33 | ±15 | capitalFlow.js:687-701, 639-647 |
| 近20日主力净流 | 同上 | ±10 | capitalFlow.js:703-718 |
| OBV 趋势 | 上升 / 下降 | +6 / −6 | capitalFlow.js:721-722 |
| VR 信号 | 含「多」/ 含「空」 | +4 / −4 | capitalFlow.js:723-724 |
| 融资余额变化 | 占流通市值比分档（方向：增加=正） | ±6 | capitalFlow.js:729-743 |
| 融券余额变化 | 同上（方向：增加=负） | ±6 | capitalFlow.js:744-758 |
| 融资余额占比 | 存量杠杆：>5% / >2% | +4 / +2 | capitalFlow.js:759-764 |
| 换手率（相对月均） | ≥2.0×月均 +5 / ≥1.5× +3 / <0.5× −3；无月均参考时退回绝对阈值（>10% +5 / >5% +3 / <1% −3） | ±5 | capitalFlow.js:767-782 |

最终 clamp 到 [0,100]；等级：≥80 非常活跃 / ≥65 活跃 / ≥45 中性 / ≥30 低迷 / 其余 极度低迷（capitalFlow.js:784, 820-825）。

> 关键设计：**热度（score）与方向（signal）解耦**——量价方向只进 `dirScore`（signal=(dirScore−50)/50，供判断引擎「资金量能」因子），不进热度分；「放量下跌」不会因成交放大被判偏多（capitalFlow.js:809-812）。

### 2.4 个股近期热点（三级路由 + 双模式）

`getState`（hotTopics.js:665-702）：
1. 取行情（8s 超时兜底 null），名称以**行情源为准**（入参 name 仅降级，防串股污染，hotTopics.js:671-679）；
2. 触发判定 `resolveTrigger`：**|涨跌幅| ≥3% → priceChange 模式；否则当日振幅 >3% → amplitude 触发（同 priceChange 模式）；都不满足 → trending 模式**（hotTopics.js:41-55）；
3. 缓存复用条件（price-change.json）：同日 + 有 analysis + symbolName 与行情名一致 + cacheVer 匹配 + 触发方式一致 + 涨跌方向一致（hotTopics.js:344-350）；
4. AI 归因/聚合；未配置 Key → 直接返回 noKey 结果并**写盘**（hotTopics.js:397-406, 560-570）。

## 三、指标 / 因子口径

| 指标/因子 | 口径（原始值怎么算） | 归一化 | 是否进总分 | 出处 |
|---|---|---|---|---|
| MA5/MA20 | 简单移动均价（日 K 收盘） | 无 | 是（±2） | analysis.js:426-433 |
| RSI | 14 日相对强弱（analysis 内计算） | 阈值 30/50/70 | 是（±1/±0.5） | analysis.js:438-442 |
| MACD DIF/Signal/柱 | 12/26/9 | 符号 + 柱符号 | 是（±1/±1.5） | analysis.js:447-459 |
| KDJ K/D/J | 9 日随机指标 | 阈值 20/80/100 | 是（±0.5×2） | analysis.js:465-469 |
| 布林带位置 | (收盘−下轨)/(上轨−下轨) → 上轨附近/中上轨/中下轨/下轨附近 | — | **否（只展示）** | analysis.js:472-483 |
| 成交量趋势/量比 | analyzeVolume | — | **否（只展示）** | analysis.js:420, 517-525 |
| PE/PB/PS | PE/PS 为 TTM、PB 为 MRQ | 行业分位×0.6+历史分位×0.4 | 是（估值维 25） | fundamentalScore.js:142-171 |
| ROE/净利率/毛利率 | TTM 分子÷TTM 营收（或净资产） | 与行业中枢比 | 是（盈利维 25） | fundamentalScore.js:46-53, 208-230 |
| 三项同比增速 | 本地财报库 `TOTALOPERATEREVETZ/PARENTNETPROFITTZ/KCFJCXSYJLRTZ` | 档位×趋势系数 | 是（成长维 25） | fundamentalScore.js:248-283 |
| 资产负债率/流动比率/每股经营现金流/股息率 | 财报原始值（股息率 <1 且无 pct 标记时 ×100） | 分档 | 是（健康维 25） | fundamentalScore.js:300-362 |
| 资金热度 score | 50 + 九项加减分 | clamp[0,100] | 是（本卡即总分） | capitalFlow.js:658-784 |
| 资金方向 signal | (dirScore−50)/50 | clamp[−1,1] | 否（供判断引擎） | capitalFlow.js:809-812 |
| 异动归因/热议话题 | LLM 联网 + 五路证据（公告/全网舆情/财报解读/股吧帖/多平台热度/投资者问答） | — | 否（叙事层） | hotTopics.js:352-373, 494-532 |

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | ① 技术面：腾讯日 K（前复权）本地计算；② 基本面：东财 F10 主要财务指标 + 行业估值（`industryAvg`）+ 本地财报库；③ 资金热度：东财资金流向/融资融券/量能指标 + 腾讯量价；④ 近期热点：腾讯行情触发判定 + LLM（webSearch）+ cn-financial-scraper 五路证据 |
| 采集/落盘 | 技术面/基本面随全量快照（内存/文件缓存）；资金热度 `/api/capital-flow`（15s 整体超时，server.js:1793-1798）；近期热点落盘 `data/hot-topics/<symbol>/{price-change,trending}.json`（hotTopics.js:57-83） |
| 调度 | 首屏并行/异步加载（资金量能为异步预加载不阻塞渲染，app.js:643-647）；无后台定时；用户点 🔄 强制重算（`?refresh=1`） |
| 前端取数 | `/api/stock/:symbol`（含 technical/fundamental）；`/api/capital-flow/:symbol`；`/api/hot-topics/:symbol`（app.js:1685） |

## 五、降级 / 容错 / 诚实性设计

| 场景 | 行为 | 诚实性评价 |
|---|---|---|
| 资金热度未加载 | 占位 `--` +「资金量能加载后更新」 | 诚实 |
| 资金量能接口 error（如非 A 股/行情缺失） | 主内容区显示 `⚠️ {error}` + **固定文案「资金量能分析目前仅支持A股市场。」**；评分卡停留在 `--` | **部分不诚实**：任何 error（含 404 行情缺失、15s 超时）都附「仅支持 A 股」文案，一刀切归因（见清单 C4） |
| 资金量能 fetch 超时/异常（15s 前端硬超时） | 主内容区显示「⚠️ 资金量能数据加载超时」；评分卡仍 `--` | 诚实（主区域明示），但评分卡无错误态 |
| 近期热点未配置 AI Key | 卡片显示「未配置 AI API Key，无法联网分析。请在「AI 设置」中配置 Key 后刷新。」 | 诚实 |
| 近期热点 LLM 失败 | 降级链：① 历史成功缓存（同版本）→ ② 本次抓取的讨论帖/舆情/公告原始条目 → ③ 明确提示 + error 字段 | 诚实（hotTopics.js:635-658） |
| 近期热点 LLM 返回空话题 | 降级展示抓取到的原始条目，文案注明「AI 聚合返回为空」 | 诚实（hotTopics.js:610-623） |
| 基本面指标无法取值 | 显示 0 + 不参与维度评分 + notice 汇总提示 | 诚实（但「0」易被误读为差，靠 notice 缓解） |
| 技术面数据不足 | signals 缺项留空，trendScore 少项累加 | 基本诚实（无明示缺项） |

## 六、逻辑漏洞自查清单（审计用）

- [ ] **T1 技术面追溯面板文案与代码矛盾**：面板称「以下 **6 个信号**综合打分」（app.js:6256），但 trendScore 实际只由 MA/RSI/MACD/KDJ **4 类**计分（analysis.js:426-469）；布林带、成交量仅展示不计分。用户按面板理解会高估两者影响。
- [ ] **T2 基本面追溯面板文案与代码矛盾**：面板称「各维度的权重**随公司类型（增长/价值/红利/均衡）不同而调整**」（app.js:6278），但 20260909d 重构后四维**固定各 25 分**（fundamentalScore.js:104 及文件头注释）。公司类型仅作记录字段（`companyType/companyTypeName`）。
- [ ] **T3 资金热度追溯面板文案与代码矛盾**：面板称综合「量能指标（OBV/VR/**MFI**）」（app.js:6307），但计分只含 OBV/VR（capitalFlow.js:721-724），**MFI 不参与计分**（仅在 detailRows 展示，app.js:6301）。
- [ ] **T4 资金卡错误文案一刀切**：`data.error` 时无论根因（非 A 股 / 行情 404 / 15s 超时）都追加「资金量能分析目前仅支持A股市场。」（app.js:3189-3198），误导归因。
- [ ] **T5 资金热度卡无错误态**：接口失败/超时时 `#capitalScore` 永远停在 `--` +「资金量能加载后更新」（app.js:2019-2023，error 路径不更新该卡），用户以为还在加载。建议失败时置「加载失败」。
- [ ] **T6 noKey 缓存毒化当日归因**：未配置 Key 时 noKey 结果被写盘（hotTopics.js:404, 568），且缓存复用条件不排除 noKey（hotTopics.js:348 只要求 `cache.analysis` 存在）→ 当天再次打开仍返回 noKey 占位；用户中途配好 Key 也必须点 🔄（force）才能刷新。
- [ ] **T7 近期热点缓存方向一致但涨幅可能已变**：复用条件只校验 `Math.sign(changePct)` 同号（hotTopics.js:348），盘中从 +3.1% 涨到 +9% 仍复用早前 +3% 时的归因文案，卡片头部却显示最新涨幅——归因与展示数字可能脱节。
- [ ] **T8 振幅触发与涨跌幅触发的缓存互相排斥**：`cacheTriggeredBy === triggeredBy` 才复用（hotTopics.js:347-348）：盘中先振幅触发（平盘宽震），尾盘拉涨超 3% 变为涨跌幅触发 → 当天第二次 LLM 调用。属有意设计（口径不同），但 LLM 调用量翻倍，需盯成本。
- [ ] **T9 技术面趋势判定只用 MA5/MA20 双条件**：`lastClose>ma5>ma20` 才 +2（analysis.js:427-428），横盘黏合时 trend 信号缺失（不加分不减分），trendScore 主要由 RSI/KDJ 摆动类贡献，与「趋势」语义有偏差。
- [ ] **T10 MACD 金叉/死叉可与多头/空头叠加**：同一根 K 上「金叉」时也满足 dif>signal 且柱>0 → +1.5 后再 +1（analysis.js:448-459 顺序执行无互斥），实际是双重计分（设计如此但需知晓）。
- [ ] **T11 基本面「任一为负即 0 分」的连锁**：估值维任一负 → 0（fundamentalScore.js:137-140）；成长性任一负 → 0（:268-270）。ST/亏损股三项全负时总分结构性压低，属预期但需在解读时说明。
- [ ] **T12 PEG 加成上限**：+5 后封顶 25（fundamentalScore.js:179），但 `valScore = 25*(1-avgW/100)` 在分位极低时可能已接近 25，+5 被封顶吸收—— PEG 加成对「低分位股」无效，仅对中高分位股有效。
- [ ] **T13 行业中枢来源单一**：`buildBenchmark` 的 ROE 中枢 = PB/PE×100、净利率 = PS/PE×100 由恒等式推导（fundamentalScore.js:73-75），毛利率/行业营收增速/负债率中枢「数据源未提供」→ 兜底内置区间或跳过（:78-80）。行业基准质量取决于东财行业估值三数的完整性。
- [ ] **T14 资金热度前端兜底与后端口径已对齐但独立两份实现**：capitalCharts.js:543-651 与 capitalFlow.js:658-825 规则相同、代码两份；后端 `conclusion.score` 恒存在时前端兜底是死代码，但一旦后端字段改名，前端兜底静默接管的数值需人工比对（双份实现漂移风险）。
- [ ] **T15 近期热点卡与「舆情与讨论热度（个股）」因子的同源性**：两者同源 lib/sentiment（hotTopics.js:496 注释），但热点卡证据还含 LLM 联网，口径不完全等同，卡片间结论可能不一致。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 异动触发阈值（涨跌幅） | 3% | lib/hotTopics.js:32 |
| 异动触发阈值（振幅） | 3% | lib/hotTopics.js:33 |
| 热点缓存版本门控 | CACHE_VER='20261013g' | lib/hotTopics.js:35 |
| 基本面四维分值 | 各 25（固定） | lib/fundamentalScore.js:104 |
| 估值加权分位 | 行业 0.6 / 历史 0.4 | lib/fundamentalScore.js:157-159 |
| PEG 加成 | +5（0<PEG<1，封顶 25） | lib/fundamentalScore.js:172-179 |
| 成长性趋势系数 | 加速 1.15 / 持平 1.0 / 减速 0.85 | lib/fundamentalScore.js:280 |
| 资金热度起点 | 50 分 | lib/capitalFlow.js:658 |
| 主力净流分档 | >0.5% 满分 / >0.2% 0.66 / >0 0.33 | lib/capitalFlow.js:639-647 |
| 资金量能接口整体超时 | 15000ms | server.js:1793 |
| 前端资金量能硬超时 | 15000ms | public/js/app.js:3181 |
