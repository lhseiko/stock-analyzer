# 事件驱动引擎 · 反向逻辑说明

> 逻辑模型位置：跨页面公共支撑 → ⚙️ 事件驱动引擎（badge：公共支撑）
> 实现文件：lib/eventEngine.js、lib/newsSearch.js、routes/eventRoutes.js、server.js（调度）、lib/sameDayJudgment.js、lib/longTermJudgment.js、lib/dedicatedFactor.js
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 个股页「事件驱动」因子卡片 | 事件引擎产出 `event` 非常驻因子，注入短期/长期判断权重再平衡 | eventEngine.js:876-938 |
| 事件卡片「影响评级（major/moderate/minor）」 | 五维 severity 总分 → 阈值分级 → 受 typeCeiling 硬压顶 | eventEngine.js:567-582 |
| 事件卡片「讨论热度」标注 | forumHeat 联网核验（东财股吧/同花顺/雪球/新浪），热度=0 降级 | eventEngine.js:530-547,694-699 |
| 事件扫描后「短期判断自动作废重算」 | scanEvents 后 `invalidateJudgmentForSymbol`（server.js:2299） | routes/eventRoutes.js:60 |
| 页面独立事件 widget（非因子权重） | 深度分析页事件仅作展示 widget，未并入因子权重（见第六/二节） | routes/eventRoutes.js |

## 二、核心公式 / 判定链

**事件生命周期：新闻 → 识别分类 → 权重再平衡 → 影响评分**

1. **抓取**：`getHotNews` 主源东财 7×24 快讯 `fetchKuaixunNews`（newsSearch.js:71-77）；兜底东财内容搜索（newsSearch.js:126-130）；本地 TTL 10min（newsSearch.js:118）。
2. **分类**：`classifyByRule` 正则剔除（见第三节）；未命中规则 → `llmTriage` 本地 LLM 分流（eventEngine.js:464,479，超时 180s）。
3. **分级**：`scoreToGrade` 五维 severity（scope+persistence+intensity+surprise+authority 各 0-3）→ `major≥11 / moderate≥7 / minor≥3`（eventEngine.js:100-102,567-582）→ 受 `typeCeiling` 硬压顶；`confidence<0.6` 直接 `none`（eventEngine.js:571）。
4. **热度核验**：`forumHeat` 第四论坛讨论热度（0-3），热度=0 降一级（eventEngine.js:694-699）；`webVerify` 官方证实/已定价核验（eventEngine.js:548-564）。
5. **权重再平衡**：`buildEventOverride` 注入事件因子并压缩常驻因子（eventEngine.js:903-907）。

## 三、指标 / 因子口径

| 口径 | 规则 | 出处 |
|---|---|---|
| 事件类型硬上限 typeCeiling | research_opinion:minor / company_event:moderate / **routine_monetary_policy:moderate** / industry_supply:major / macro_policy:moderate / consumption_policy:moderate / geo_disaster:major | eventEngine.js:108-116 |
| **剔除清单（直接拒收，连轻微都不是）** | LPR/贷款市场报价利率/逆回购/公开市场操作/MLF/中期借贷便利 → `{kind:'daily_liquidity_op',reject:true}` | eventEngine.js:76,429 |
| routine_monetary_policy 封顶 | 降准/降息/加息/美联储议息/FOMC → 轻微为主、最多中度、绝不重大（ceiling:moderate） | eventEngine.js:111,430；prompts/event-triage-system.md:34,50 |
| 分级固定权重 | major 0.40 / moderate 0.12 / minor 0.03（磁盘 data/events/config.json:6-23 一致） | eventEngine.js:96-98 |
| 事件单独合计封顶 | maxCombinedEventWeight 0.40 | eventEngine.js:130,895 |
| 事件+专属合并封顶 | 0.95（常驻至少保留 5%） | dedicatedFactor.js:200-202 |
| 论坛热度每日额度 | heatDailyCap 30；24h 复用缓存 | eventEngine.js:123,532,686 |
| 官方核验每日额度 | webDailyCap 20 | eventEngine.js:121,548-564 |

## 四、数据来源与采集链

| 层 | 内容 | 出处 |
|---|---|---|
| 新闻源 | 东财 7×24 快讯（主）+ 东财内容搜索（兜底）；本地 10min TTL | newsSearch.js:71-130 |
| 分类/分级 | classifyByRule（正则）+ llmTriage（本地 LLM） | eventEngine.js:427,464 |
| 热度核验 | 东财股吧/同花顺/雪球/新浪财经（forumHeat）/ 官方证实（webVerify） | eventEngine.js:530-564 |
| 调度 | 事件扫描四槽位 09:00/12:30/15:30/21:00，周末不扫（server.js:2266-2291）；专属因子月度（每月 8-13 日 CPI 窗口，server.js:2307-2327） | server.js |
| 注入 | shortTerm（sameDayJudgment.js:1720-1738）、longTerm（longTermJudgment.js:364）调 buildEventOverride + mergeNonResidentOverrides | 各文件 |

## 五、降级 / 容错 / 诚实性设计

- **误报代价 >> 漏报代价**：eventEngine.js:1-21 注释明确「只收外生『因』，拒收行情『果』」（RE_MARKET_RECAP 拒收涨跌/涨停/板块涨幅等果，eventEngine.js:70）。
- **LLM 分流失败**：catch 返空 → `llmFailed` 审计，该批候选一律不认（保守归零，eventEngine.js:497-499）。
- **热度=0 降级**：降一级并可置 `drop`（权重归零走自然过期，eventEngine.js:694-710）。
- **事件过期/结束恢复**：`isExpired`/`effectiveWeight` 判 effWeight→0（eventEngine.js:211-223）；无活跃事件时 `buildEventOverride` 返 null（:882），上层走自适应权重 `adaptive`，与原版完全一致。
- **硬约束兜底**：权重总和恒 100%（压缩后常驻和 + 事件 combined = 1）；不删因子；既有因子等比例压缩。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **⚠️ 深度分析未接事件引擎**：`lib/deepAnalysis.js` 全文 grep `eventEngine/event/事件` 均无匹配（见 common/agent 探查）。深度分析页的 AI 叙事段落由 `lib/deep/pipeline.js` 经 readCache 组合，事件仅作为**独立 widget** 经 eventRoutes 展示，**未并入 deepAnalysis 的因子权重或判断结果**。若期望「事件影响深度分析结论」，当前实现不含此链路——属设计缺口或文档预期偏差，需用户确认。
- [ ] **模型名记忆不符**：memory 称事件分流用 `qwen3-vl-235b-a22b-thinking`，实际取 `cfg.modelLocal`（eventEngine.js:474），磁盘为 `qwen3-vl-plus`（common-03 同记）。
- [ ] 事件封顶两级不一致：事件单独 0.40（eventEngine.js:130/895）vs 事件+专属合并 0.95（dedicatedFactor.js:202）——合并路径下事件实际占比可达 0.95，远超单独 0.40，需确认是否预期（短期判断 J6/J7 同记）。
- [ ] 事件刷新路径持续盯源：forumHeat 依赖第四论坛搜索返回，源变动可能导致热度恒 0 → 事件一律降级（需监控）。
- [ ] 热度每日额度 30 / 核验 20：配额耗尽后事件是否仍按「无热度」降级（eventEngine.js:531-532,546 返 null 不影响主流程）——降级是否保守合理？
- [ ] 事件扫描 15:30 槽位（server.js:2278）与盘后结算同窗口：若服务未常驻，事件缓存作废与重算均不触发，短期判断停留在旧权重。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| typeCeiling（类型硬上限） | 见第三节表 | eventEngine.js:108-116；data/events/config.json |
| maxCombinedEventWeight（事件单独封顶） | 0.4 | eventEngine.js:130 |
| 合并封顶（事件+专属） | 0.95 | dedicatedFactor.js:202 |
| heatDailyCap / webDailyCap | 30 / 20 | eventEngine.js:123,121 |
| triageTimeoutMs | 180000ms | eventEngine.js:479；data/events/config.json:51 |
| 扫描槽位 | 09:00/12:30/15:30/21:00（周末不扫） | server.js:2278 |
| 本地模型 | qwen3-vl-plus（取自 data/ai_config.json） | eventEngine.js:474 |
