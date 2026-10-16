# 长期行情判断（5 因子）· 反向逻辑说明

> 逻辑模型位置：个股页 → 顶部常驻区下方「{M月D日}长期行情」卡片（badge：置信度）+「查看判断逻辑」面板
> 实现文件：`lib/longTermJudgment.js`（462 行主引擎）、`lib/industryAnalysis.js`（行业因子静态表）、`lib/ruleCore.js`（影响徽章/阈值）、`public/js/app.js:1445-1622`（渲染）、`public/index.html:383-391`（容器）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 卡片标题 `#longtermTitle` | 可见文案「长期行情」（代码注释写「长期行情判断」，文案不一致）；动态前缀日期由 `j.horizonLabel` 提供 | index.html:383；app.js:1445（注释）、:1535 |
| 副标题 `#longtermSubtitle` | 如「未来 6-12 个月 · 综合基本面/行业前景/期货/指数长期走势/技术长期趋势」 | app.js:1518-1528 |
| 结论 `#longtermVerdict` | `j.verdict`：涨→看多 / 跌→看空 / 震荡→中性 | app.js:1532 |
| 综合分 `#longtermScore` | `j.score`（综合分 /100） | app.js:1535 |
| 置信度 badge `#longtermConfidence` | `j.confidence`：高/中/低，配 conf-high/mid/low | app.js:1536-1539 |
| 更新时间 `#longtermDetail` | `j.generatedAt` + `j.autoUpdated` → 文案「🔄 每次打开自动联网更新 · 暂不核算准确率」 | app.js:1518-1528、:1543 |
| 「查看判断逻辑」面板 `#longtermLogic` | 五因子手风琴：每行 = 名称 + 影响徽章(利好·看多/利空·看空/中性) + signal 箭头 + `effectiveWeight*100%` + 贡献分 + detail + value | app.js:1594-1622 |
| 因子排序 | 按五因子固定顺序（fundamentals→industry→futures→market→technicalLong） | app.js:1594 |
| 来源标注 `#longtermNote` | 写死「AI 联网抓取 · 东方财富/同花顺/新浪期货/腾讯行情」（⚠️ 与实现不符，见第六节 #1） | longTermJudgment.js:396 |
| 跨股污染防御 | 后端返回的 `judgment.symbol` 与请求不符 → 自动 `refresh=1` 重拉一次 | app.js:1479-1491 |
| Loading 态 | 「分析中…/正在联网抓取基本面/行业前景/期货/指数长期走势…」 | app.js:1446-1463 |
| 失败态 | 「长期分析加载失败」+ 重试提示 | app.js:1473-1497 |

## 二、核心公式 / 判定链

### 2.1 五因子与权重（Σ = 1.000，代码自洽）

| # | 因子函数 | 输入 | signal 计算 | 权重 | 出处 |
|---|---|---|---|---|---|
| 1 | `factorFundamentals` | `fund.score`（基本面四维总分 0-100） | `clamp((score-50)/50, -1, 1)` | **0.280** | longTermJudgment.js:58-69（权重 :64/:67） |
| 2 | `factorIndustryPolicy` | `policy.level`（字符串） | `level.includes` 映射（见第三节） | **0.200** | :72-88（权重 :83/:86） |
| 3 | `factorFuturesLong` | `futures.futuresChg` + `correlation` | `clamp(chg/15,-1,1) * corrSigned` | **0.120** | :91-107（权重 :103/:105） |
| 4 | `factorMarketLong` | 指数60日 + 板块 + 中期研判 | `clamp(0.6*idxSignal+0.4*secSignal,-1,1)` | **0.200** | :146-186（权重 :182/:184） |
| 5 | `factorTechnicalLong` | `pa.longTerm.score`（价格行为长期） | `clamp(score/4, -1, 1)` | **0.200** | :191-214（权重 :195/:209） |

> ⚠️ **重要更正**：期货（futures）因子权重实际为 **0.120**，不是 0.200。五因子和 = 0.280+0.200+0.120+0.200+0.200 = 1.000，代码内部自洽；任何按 0.200 描述本模块的反向文档都会失真。

### 2.2 汇总公式（combineFactors）

- 有效因子 = `applicable:true` 的因子；期货缺数据时 `applicable:false`，**不参与且触发权重重归一化**（:218-219, :223）；
- 贡献分 `contribution = round(eff * f.signal, 3)`，`total` 累加（:224-225）；
- **方向阈值**：`total > 0.12 → 涨（看多）`；`total < −0.12 → 跌（看空）`；否则 `震荡（中性）`（:231-232）；
- **置信度**（:235-237）：
  - `mag ≥ 0.35` 且 `used.length` 非空 且 同号因子数 `agree ≥ ceil(used.length × 0.6)` → **高**；
  - 否则 `mag ≥ 0.2` → **中**；
  - 其余 → **低**；
- 影响徽章 `withImpact`（:227）→ `ruleCore.js:378-381` → `toImpactScore`（:365-372）：`signal*3` 对称舍入，方向保底 `IMPACT_DIR_EPS=0.02`（ruleCore.js:364）。

### 2.3 编排（buildLongTermJudgment）

- `Promise.allSettled` 并发拉取 9 路数据（:274-284）；
- 计算五因子（:350-356）→ 注入事件驱动权重覆盖 `eventEngine.buildEventOverride`（:364）+ 专属因子 `dedicatedFactor`（:365-368, :372-375）；
- 返回对象含 `verdict/dir/score/confidence/factors/weightsUsed/weightsDefault/autoUpdated/source/rules`（:378-400）。

## 三、指标 / 因子口径

| 因子 | 原始值口径 | 归一化 signal | 是否进总分 | 出处 |
|---|---|---|---|---|
| 基本面 | 四维总分 0-100 | `(score-50)/50` 截尾 [-1,1] | 是（权重 0.280） | :58-69 |
| 行业政策 | `INDUSTRY_POLICY` 顺序命中 level | 国家战略扶持→1 / 战略扶持→0.7 / 中性→0 / 受限→−0.7 | 是（权重 0.200） | :72-88；industryAnalysis.js:54-67 |
| 对标期货 | 期货涨跌幅 + 相关系数 | `chg/15 × corrSigned` | 是（权重 0.120，缺数据不进） | :91-107 |
| 大盘长期 | 指数60日 + 板块 + 中期 | `0.6*idx + 0.4*sec` 截尾 | 是（权重 0.200） | :146-186 |
| 技术长期 | 价格行为长期 score | `score/4` 截尾 | 是（权重 0.200） | :191-214 |

- **行业 level→signal 映射**（用 `lv.includes`，:76-79）：`'国家战略扶持'`→1；`'战略扶持'`（含「战略扶持（审慎）」）→0.7；`'中性'`（含全部「中性（…）」及默认）→0；`'受限'`（含「受限（托底）」）→−0.7。
- **行业默认 level**：未命中库 → `'中性（需结合具体政策判断）'`（industryAnalysis.js:63）→ signal 0。
- **期货相关性分档**（:96）：`|corr|≥0.6→1`、`≥0.35→0.7`、`≥0.15→0.4`、else `0.2`；期货长期缩放 `/15`（:100）。

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | 基本面 `fundamentalAnalysis`（腾讯行情 quote → fund.score）；行业 `industryAnalysis(symbol,name).policy`（**静态硬编码表 INDUSTRY_POLICY**，非联网）；期货 `getFuturesMeta`+`fetchFuturesCorrelation`（新浪期货）；大盘 `fetchIndexLongTerm`（腾讯/东财 1y 4 指数）+`getSectorTrend`（同花顺）+`getMarketTechnical`；技术长期 `getPriceActionSnapshot`（priceActionHub，与「技术面分析」页同源） |
| 采集/落盘 | 9 路 `Promise.allSettled` 并发（longTermJudgment.js:274-284）；部分失败走单路回退（如技术长期失败→`analyzePriceAction(daily≥250)`，:331-335） |
| 调度 | 进程内缓存 `CACHE_TTL=5*60*1000`（:267），key=symbol（:266）；前端 symbol 不符触发 `refresh=1` 重拉（app.js:1479-1491） |
| 前端取数 | `GET /api/long-term-judgment/:symbol`（server.js:542-553）→ `getLongTermJudgment`（:451） |

## 五、降级 / 容错 / 诚实性设计

- **因子缺数据降级为中性 signal=0**：基本面（:67-68）、行业（:86-87）、指数（:184-185）、技术（:194-198）；**期货缺 → `applicable:false` 且不参与打分**（:105-106），权重重归一。
- **诚实性修正**：引用非最新期财报→`outdated:true`（:380-381）；负债率与权威快照偏差>1pct→`financeCorrected` 直接修正（:399-400）。
- **亮点/雷点独立缓存**：`GET /api/ai/aspects` 只读缓存、不限 TTL（routes/aiRoutes.js:104,116），仅展示生成日期，无「数据已过期」提示；生成失败回退上一次成功结果并标 `stale`（augmentStock.js:418-423）。
- **误导风险**：`source` 字段写死「AI 联网抓取」（:396），但行业 policy.level 来自**静态硬编码表**，基本面为本地计算——「AI 联网」措辞夸大（见第六节 #1）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **#1 行业因子「AI 联网」措辞虚假**：`source` 标「AI 联网抓取」（longTermJudgment.js:396），但 `policy.level` 由 `INDUSTRY_POLICY` 关键词表驱动（industryAnalysis.js:32-52, :54-67），非联网。卡片 note 同时称「暂不核算准确率」且「AI 联网抓取」，自相矛盾。
- [ ] **#2 权重与常见假设不符**：期货因子权重实际 0.120（longTermJudgment.js:103），若任何文档/面板按 0.200 描述则失真；权重和虽自洽（=1.0），但需核对展示面板是否用了正确权重。
- [ ] **#3 文件头注释过时**：:5-9 写「四因子」、:17 写「第 4 个因子」，实际已含第 5 因子 technicalLong（:188-190），注释与实现冲突。
- [ ] **#4 方向阈值三处不一致（跨模块矛盾）**：长期判断 `±0.12`（:231-232）；首页 `marketSentimentIndex.js:101` 用 `±0.05`；首页 `marketEmotionModel.js:765-766` 用 `±0.2`。综合分 0.15：在情绪模块判「中性」、在长期模块判「看多」——语义冲突。
- [ ] **#5 行业 level 的 includes 匹配脆弱**：`factorIndustryPolicy`（:76-79）靠字符串包含匹配；`'国家战略扶持'` 须先于 `'战略扶持'` 判断（顺序正确但脆弱），若新增含「战略扶持」但语义相反的 level（如「非战略扶持」）会被误判 0.7。
- [ ] **#6 非 A 股静默降级未明示**：港股/美股行业名可能不匹配 `INDUSTRY_POLICY`→level=中性→signal 0；`selectLongIndicesByStock` 对非 A 股回退全宽基（:132-133），卡片均未标注「行业/指数因子已静默置中」。
- [ ] **#7 期货不适用导致权重重分配未告知**：`combineFactors` 仅对 `applicable` 归一（:218-219, :223），其它因子 `effectiveWeight` 上升，前端展示权重（app.js:1607）与默认权重不同，但卡片未说明「因期货不适用已重分配」。
- [ ] **#8 缓存 key 仅 symbol 无 name 防护**：长期缓存 key 仅 symbol（:266）；同 symbol 不同 name 复用（前端已用 symbol 校验+重试缓解，后端无防护）。`aspects` GET 不限 TTL（routes/aiRoutes.js:104），旧亮点雷点可能长期展示。
- [ ] **#9 置信度「高」门槛难达易误读**：需 `mag≥0.35 且 agree≥ceil(used*0.6)`（:236）；期货不参与（used=4）时需 3 个同向且受权重上限约束，常驻「中/低」——与卡片「看多」并存虽不矛盾，但用户易解读为矛盾。
- [ ] **#10 两卡同区逻辑无关联**：长期判断是 5 因子加权（确定性计算），亮点/雷点是 AI 文本生成（augmentStock.js:273），二者独立（index.html:363-394 同区），用户易误以为亮点雷点来自同一套因子打分体系。
- [ ] **#11 概览卡只读缓存无主动生成**：`GET /api/ai/aspects`（routes/aiRoutes.js:113）仅读 cache，未命中即「尚未生成」（app.js:1654）；用户若未在个股页点过「AI 生成亮点/雷点」，概览卡永远空白，无自动触发。
- [ ] **#12 行业因子顺序匹配偏置（与 stock-03 同源）**：`INDUSTRY_POLICY` 顺序命中（industryAnalysis.js:54-67），电力设备恒被「电力」条（中性·周期）抢先、新能源汽车恒被「新能源」条抢先，详见 stock-03 审计表 I1/I2。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 五因子权重 | 0.280 / 0.200 / 0.120 / 0.200 / 0.200 | longTermJudgment.js:64, :83, :103, :182, :195 |
| 方向阈值 | ±0.12 | longTermJudgment.js:231-232 |
| 置信度阈值 | 高 0.35（含 agree≥0.6）；中 0.2 | longTermJudgment.js:235-237 |
| 期货相关性分档 | ≥0.6→1 / ≥0.35→0.7 / ≥0.15→0.4 / else 0.2 | longTermJudgment.js:96 |
| 期货长期缩放 | /15 | longTermJudgment.js:100 |
| 指数/板块/技术缩放 | 指数 /12（:157）、板块 /5（:161）、技术 /4（:200） | longTermJudgment.js |
| 缓存 TTL | 5 分钟（symbol key） | longTermJudgment.js:267 |
| 影响徽章常量 | IMPACT_DIR_EPS=0.02 | ruleCore.js:364 |
| 行业因子 level 表 | INDUSTRY_POLICY（19 条） | industryAnalysis.js:32-52 |
| 亮点雷点条数 | slice(0,6) / 前端截断 70 字 | augmentStock.js:361-362；app.js:1662-1663 |
| SCHEMA/LAYOUT 版本 | 未在本模块发现独立常量（沿用 sameDay 体系） | ⚠️ 待核实 |
