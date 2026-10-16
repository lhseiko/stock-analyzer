# 🏭 行业分析（行业前景 + 行业景气度）· 反向逻辑说明

> 逻辑模型位置：个股页 → 「🏭 行业分析」Tab（行业归属 + 政策前景评级 + 期货相关性 + 个股/行业研报 + 行业指数 K 线 + 行业景气度）
> 实现文件：`public/js/app.js:3239-3480`（`loadIndustryAnalysis`）、`public/js/industryCharts.js:845-850`（`policyLevelClass`）、`lib/industryAnalysis.js`（184 行）、`lib/industryProsperity.js`、`lib/industryIndexHistory.js`、`lib/sectorIdentity.js`
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 行业归属 | `industry.name / csrc / induName / boardName` | industryAnalysis.js:80-91 |
| 政策前景/评级 | `policy.level / plans / summary` → 前端 `_industryLevelToRating` 映射「优秀/良好/一般/较弱」；总览卡 `policyLevelClass` 映射 `support/restrict/neutral` | industryAnalysis.js:54-67；app.js:750-757；industryCharts.js:845-850 |
| 期货相关性 | `futures.hasFutures / correlation / level` | industryAnalysis.js:161 |
| 个股研报 | `companyReports[*].title/rating/targetPrice` | — |
| 行业研报 | `industryReports[*]` | — |
| 行业指数 K 线 | `/api/industry-index-history`（同花顺行业指数） | industryIndexHistory.js:81 |
| 行业景气度 | `/api/industry-prosperity` → `revenueTTM / marketCap / verdict{tag,tone,text}` | industryProsperity.js:234, 388-401 |
| 概览补充卡「行业前景评分」 | `_loadIndustryProspect`（app.js:727-748，调同一 `/api/industry-analysis`） | app.js:727-748 |
| 加载触发 | `GET /api/industry-analysis/:symbol`（并行 `/api/industry-index-history`、`/api/industry-prosperity`） | app.js:3247, 3443, 3469 |

## 二、核心公式 / 判定链

### A. 行业前景评分（政策库匹配 → level → 评级）
- **政策库**：`INDUSTRY_POLICY` 19 条（industryAnalysis.js:32-52）。
- **顺序匹配**：`getPolicySupport`（:54-67）遍历数组，`text.includes(k)` 命中即返回 `level`——**顺序敏感、子串匹配、无分词边界**。
- **level→评级（前端两套）**：
  - 概览/评分卡 `_industryLevelToRating`（app.js:750-757）：'国家战略扶持'→优秀、'战略扶持'→良好、'受限'→较弱、'中性'→一般。
  - 行业分析总览卡 `policyLevelClass`（industryCharts.js:845-850）：含扶持/战略→`support`、含受限→`restrict`、否则→`neutral`。

### B. 行业景气度（确定性规则，非 LLM）
- `getIndustryProsperity`（industryProsperity.js:234）：锁定**申万二级**（:250-257，未命中即整卡不展示）。
- **verdict 四态确定性计算**（:388-401）：以 TTM 营收同比 `revTTMYoY` 与总市值同比 `mcYoY` 的同向/背离：
  - 量价同向向上 → `景气上行`(bull)
  - 营收↑市值↓ → `基本面改善·市场未反映`(neutral)
  - 营收↓市值↑ → `估值扩张·景气未跟上`(bear)
  - 量价同向走弱 → `景气下行`(bear)

## 三、指标 / 因子口径

| 项 | 取值集合 | 出处 |
|---|---|---|
| 行业 level（后端真值 10 个） | 国家战略扶持 / 战略扶持（审慎）/ 中性（顺周期）/ 中性（强监管）/ 受限（托底）/ 中性（周期）/ 中性（出海）/ 战略扶持 / 中性（监管）/ 中性 | industryAnalysis.js:33-52 |
| 前端概览评级（4 档） | 优秀 / 良好 / 一般 / 较弱 | app.js:750-757 |
| 前端行业卡 CSS（3 档） | support / restrict / neutral | industryCharts.js:845-850 |
| 景气度 verdict.tag | 景气上行 / 基本面改善·市场未反映 / 估值扩张·景气未跟上 / 景气下行 | industryProsperity.js:388-401 |
| verdict.tone | bull / neutral / bear | 同上 |
| 行业锁定 | 申万二级（未命中不展示） | industryProsperity.js:250-257 |

## 四、数据来源与采集链

| 字段 | 取数函数 | 上游数据源 |
|---|---|---|
| 行业归属 | resolveSectorIdentity（sectorIdentity.js:273-361） | 覆盖表 INDUSTRY_BY_CODE(37-90) + 东财 F10 CompanySurvey(193-213) + 研报(215-236) |
| 政策前景 | getPolicySupport（industryAnalysis.js:54-67） | 内置 INDUSTRY_POLICY（32-52，纯静态） |
| 行业指数 K 线 | getIndustryIndexHistory（industryIndexHistory.js:81） | 同花顺（scripts/ths_industry_index_history.py） |
| 行业景气度 | getIndustryProsperity（industryProsperity.js:234） | 东财 RPT_LICO_FN_CPD(营收) + RPT_VALUEANALYSIS_DET(市值) + 板块成分 push2delay(161-223) |
| 板块走势 | getSectorTrend/getBoardsTrend（sectorTrend.js:24-80） | scripts/sector_trend.py (akshare) |

## 五、降级 / 容错 / 诚实性设计

- **政策未命中**：后端固定通用文案（industryAnalysis.js:61-66）；前端 `_loadIndustryProspect` 未命中显示「— · 无政策数据」（app.js:737），两套「无数据」表达不一致。
- **景气度无申万二级**：`industryProsperity.js:250-257` 返回 `NO_SW2_SECTOR` 不展示。
- **诚实性缺口**：`INDUSTRY_POLICY` 为**静态硬编码表**（非联网），但长期判断卡片 source 标「AI 联网抓取」（见 stock-05 #1），行业前景评级实质是关键词匹配而非 AI 研判。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **#1【实打实 bug】电力设备被「电力」条抢先**：`getPolicySupport` 顺序遍历，`INDUSTRY_POLICY` 第 10 条 `电力/能源`（industryAnalysis.js:42，含 key `电力`）排在第 19 条 `电力设备`（:51）之前；`text.includes('电力')` 对「电力设备」「电网」「特高压」先命中 → 落到 `中性（周期）` 而非 `国家战略扶持`。同条 key 同时含 `电力` 与 `电网/特高压`，与第 19 条重复且被压制。
- [ ] **#2 新能源汽车被「新能源」条抢先**：第 3 条通用新能源口径（:35）排在第 4 条新能源车专属口径（:36）前；「新能源汽车」含「新能源」→ 命中通用口径，评级同但 summary 口径偏。
- [ ] **#3 顺序匹配偏置通病（子串无边界）**：`getPolicySupport`（:56-57）用 `text.includes(k)` 顺序命中，无分词/长词优先；「消费电子」含「消费」→ 命中 `中性（顺周期）`（:38）而非科技扶持；「生物」先于农业；「家用电器」不含「家电」连续子串（可能落兜底）。
- [ ] **#4 level→三套映射不一致**：后端真值 10 个 level；前端概览 4 档（app.js:750-757）；前端行业卡 3 档 CSS（industryCharts.js:845-850）。优秀/良好在第三套均归 `support` 无区分；`战略扶持（审慎）`（:37）被等同 `战略扶持`→良好/support，**丢失「审慎」语义**。
- [ ] **#5「未知行业」与「未命中库」评分卡都显示「一般」不可区分**：`_industryLevelToRating` 对空/未命中均归「一般」（app.js:750-757），用户无法区分"真中性行业"还是"库未覆盖"。
- [ ] **#6 行业景气度量纲未校正成员变动**：`industryProsperity.js:388-401` verdict 用营收/市值同比背离，但新股上市/退市造成的同比偏差仅在 `caveats` 文字提示（:404-409），**未从 verdict 数值扣除**；且强约束申万二级（:250-257）未命中即整卡消失，与政策库（行业名）口径可能错位。
- [ ] **#7 政策库硬编码无时效标注**：`INDUSTRY_POLICY` 19 条（industryAnalysis.js:32-52）无生效日期/失效期，政策变化需人工改代码，无"政策可能已过时效"提示。
- [ ] **#8 19 条 vs 申万 31 一级覆盖缺口**：多个行业（如美容护理、国防军工细分等）无专条 → 兜底「一般」，评价偏保守且不可见原因。
- [ ] **#9 期货相关性对行业评级无直接影响**：`futures.level`（industryAnalysis.js:161）仅展示，不参与行业前景评级，但界面上紧邻"政策前景"，用户易误以为期货影响评级。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 政策库 | INDUSTRY_POLICY（19 条，顺序敏感） | industryAnalysis.js:32-52 |
| 行业覆盖/映射表 | INDUSTRY_BY_CODE / EM_INDUSTRY_BY_CODE / THS_BOARD_BY_CODE / INDUSTRY_NORM / INDUSTRY_CODE_BY_NAME | sectorIdentity.js:37-180 |
| 概览评级映射 | 4 档 | app.js:750-757 |
| 行业卡 CSS 映射 | 3 档 | industryCharts.js:845-850 |
| 景气度参数 | PLOT_PERIODS=12, FETCH_PERIODS=18, MCAP_LOOKBACK_DAYS=8, CONCURRENCY=4 | industryProsperity.js:40-44 |
| 景气度缓存 | 12h | industryProsperity.js:39 |
| 行业指数缓存 | 1 天 | industryIndexHistory.js:16 |
