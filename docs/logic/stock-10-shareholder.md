# 👥 股东分析 · 反向逻辑说明

> 逻辑模型位置：个股页 → 「👥 股东分析」区块（汇总卡 + 四张图/表）
> 实现文件：`public/js/app.js:3595-3620`（`renderShareholders`）、`public/js/shareholderCharts.js`（`ShareholderCharts.renderAll`）、`lib/shareholderData.js:403-438`（`getShareholdersData`）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 汇总卡 | 第一大股东、最新股东户数 + 环比、户均持股、持股集中度 | shareholderCharts.js:79-105 |
| 股东户数走势图 | `holderNum` + `changeRatio`（户数环比%） | shareholderCharts.js:129-211 |
| 机构持仓变化图 | `orgNum` / `freeRatio`（相邻报告期差值） | shareholderCharts.js:36, 343-344, 407-412 |
| 前十大股东持股比例饼图 | `holdRatio` + `endDate` + `periodKind` | shareholderCharts.js:43-49, 282-284 |
| 十大股东明细 | 表格 | shareholderCharts.js:47-49, 322 |
| 基金持股 | `fundHoldings` | shareholderData.js:191-202 |
| 来源标注 | 「东方财富 F10」各子卡 | shareholderCharts.js:84, 284, 322, 407 |
| 加载触发 | `GET /api/shareholders/:symbol`（server.js:674-678）→ `getShareholdersData` | app.js:3595 |

## 二、核心公式 / 判定链

1. **户数环比**：`changeRatio = r.TOTAL_NUM_RATIO`（东财返回，户数环比）（shareholderData.js:119-132，解析 `parseHolderCountTrend`）。
2. **机构变化**：相邻报告期 `cur.orgNumChange = cur.orgNum - prev.orgNum`、`freeRatioChange = cur.freeRatio - prev.freeRatio`（:177-182），仅取 `ORG_TYPE='00'` 汇总行（:160）。
3. **报告期选定**：取「最新一个满 10 行的完整披露日」（`MIN_FULL_ROWS=10`，:73, 85-97），不再只认季度末。
4. **股价对齐**：`getHistoryDeep`（:415）用新浪/腾讯日 K（±20 日对齐，WINDOW=20，:358-398）。

## 三、指标 / 因子口径

| 项 | 口径 | 出处 |
|---|---|---|
| 股东户数变化率 | `TOTAL_NUM_RATIO`（报告期环比%） | shareholderData.js:125 |
| 机构持仓变化 | 邻期 `orgNum`/`freeRatio` 差值（未做股本变动归一） | :177-182 |
| 持股集中度 | `focus`（⚠️ 具体公式待核实 shareholderCharts.js） | shareholderCharts.js:79-105 |
| 户均持股 | `avgFreeShares` | shareholderCharts.js:89-92 |
| 报告期满行阈值 | MIN_FULL_ROWS=10 | shareholderData.js:73 |
| 股价对齐容差 | WINDOW=20 日 | :384 |

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | 东财 F10 `ShareholderResearch/PageAjax`(gdrs/jgcc/jjcg)（股东户数/机构/基金，:107）；`RPT_F10_EH_HOLDERS`（十大股东，:240）；`RPT_MAIN_ORGHOLD`（机构趋势，:151） |
| 采集/落盘 | 实时 API，无独立落盘；各子请求独立 try-catch 返回 `{}`/`[]` |
| 调度 | 切到股东 tab 触发 `renderShareholders`（app.js:3595） |
| 前端取数 | `GET /api/shareholders/:symbol`（server.js:674-678） |

## 五、降级 / 容错 / 诚实性设计

- **Loading**："正在获取股东与机构持仓数据"（app.js:3596）。
- **失败**：`error` 字段 → "⚠️ {error}"（app.js:3613）；接口失败 → "⚠️ 股东数据加载失败"（app.js:3604）。
- **子图空态**：各子图无数据 → "暂无…（F10 未披露或接口暂不可用）"（shareholderCharts.js:37,45,49）。
- **非 A 股合理降级**：返回 `{error:'仅支持 A 股市场股东分析'}`（shareholderData.js:406）—— 属合理降级（后端真实限制）。
- **诚实性缺口**：各子请求独立优雅降级为"暂无"，用户可能无感地看到大片"暂无"，不易察觉是接口失败还是真无数据（:113-116, 184-187, 267-269, 322-325）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **#1 机构持仓变化未做股本变动归一**：`freeRatioChange` 为相邻报告期简单相减（shareholderData.js:177-182）；遇增发/回购/转债转股导致总股本变动的期间，占比变化会被股本变动污染，非纯"机构增减持"。
- [ ] **#2 户数"环比"与股价叠加轴口径不对齐**：户数环比为东财 `TOTAL_NUM_RATIO`（报告期口径），股价用报告期 ±20 日最近交易日收盘价对齐（:358-398，容差 WINDOW=20），叠加对比时两轴并非同日记价（shareholderCharts.js:134-187），趋势解读有轻微错位。
- [ ] **#3 非 A 股一刀切（但属合理）**：`shareholderData.js:406` 对非 A 股返回"仅支持 A 股"，与资金量能 app.js:3195 同类文案，但此处后端确实限制市场，归因准确；建议统一文案风格即可。
- [ ] **#4 报告期选定可能跳 latest**：`MIN_FULL_ROWS=10`（:73）选"满 10 行完整披露日"，若最新一期披露未满 10 行，会回退到上一期，用户看到的是"上一期"数据但界面未明示"非最新一期"。
- [ ] **#5「0」与缺失不可区分**：子请求失败返回 `[]`，前端渲染"暂无"，与"真实 0 户变化"展示相同，用户难区分。
- [ ] **#6 持股集中度 focus 公式未文档化**：`shareholderCharts.js:79-105` 用 `focus` 但计算口径未在代码注释或本文档固化（⚠️ 待核实具体公式）。
- [ ] **#7 基金持股口径单一**：`fundHoldings`（shareholderData.js:191-202）来源单一，可能未合并多类基金口径。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 报告期满行阈值 | MIN_FULL_ROWS=10 | shareholderData.js:73 |
| 股价对齐容差 | WINDOW=20 日 | :384 |
| 股东/资料 fetch 超时 | 股东 10000ms；MainOperate 8000ms | :110, 295 |
| 机构汇总行筛选 | ORG_TYPE='00' | :160 |
