# 📊 简介（公司概况）· 反向逻辑说明

> 逻辑模型位置：个股页 → 「📊 简介」区块（随主流程 renderOverview 渲染）
> 实现文件：`public/js/app.js:2114-2160`（`renderCompanyProfile`）、`lib/shareholderData.js:443-473`（`getCompanyProfile`）、`public/index.html`（容器）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 公司全称 | `profile.companyName`（东财 F10 公司基本资料） | app.js:2134；shareholderData.js:311 |
| 企业性质 | `profile.ownership`，由 `inferOwnership()` 关键词推断（非权威） | app.js:2135；shareholderData.js:466, 331-347 |
| 所属行业 | `profile.industry`，被 `sectorIdentity` 精确行业覆盖 | app.js:2136；shareholderData.js:459-464 |
| 控股股东 | `profile.controllingShareholder`，取十大股东第 1 位 | app.js:2137；shareholderData.js:419, 465 |
| 总部地点 | `profile.province` | app.js:2138 |
| 简介片段 | `profile.intro`，实为「经营范围 businessScope」前 300 字 | app.js:2140；shareholderData.js:307-308, 319 |
| 主要产品截图 | 复用 AI 信息分析卡的 `companyDeepData.profile.productsServices[].imageLocal`（仅图片、无名称文本） | app.js:2145-2155 |
| 来源标注 | 「东方财富 F10 · 公司基本资料」 | app.js:2158 |
| 加载触发 | 主流程 `renderDashboard` → `renderOverview` → 填充 DOM | app.js:2114 |

## 二、核心公式 / 判定链

简介区块**不做打分**，仅做字段映射 + 文本推断：

1. **公司概况获取**：`getCompanyProfile`（shareholderData.js:443-473）→ 东财 F10 `CompanySurvey/PageAjax`(jbzl) 取公司名/性质/行业/控股/省份/经营范围（:277）；主营构成 `MainOperate` 可能失败降级（:291-305）。
2. **企业性质推断**：`inferOwnership`（:331-347）靠十大股东名称关键词（国资/集团等）+ 港股通名义持有人特判，属启发式非权威。
3. **行业精确化**：`resolveSectorIdentity`（:451, 459-464）用板块身份精确行业覆盖 F10 的 CSRC 行业。
4. **产品图**：来自 AI 信息分析卡 `companyDeepData.profile.productsServices[].imageLocal`（必应搜图兜底），未加载时整段 try/catch 跳过（app.js:2156）。

## 三、指标 / 因子口径

| 项 | 口径 | 是否计分 | 出处 |
|---|---|---|---|
| 公司全称 / 行业 / 控股 / 省份 | 东财 F10 原始字段 | 否（纯展示） | shareholderData.js:311, 419, 459 |
| 企业性质 | 关键词启发式推断 | 否 | shareholderData.js:331-347 |
| 简介片段 | 经营范围前 300 字 | 否 | shareholderData.js:307-319 |
| 主要产品图 | AI 搜图（imageLocal） | 否 | app.js:2145-2155 |

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | 东财 F10 `CompanySurvey`(jbzl) + `MainOperate`；行业经 `sectorIdentity` 覆盖；产品图经 AI 信息分析卡（lib/ai/companyDeep.js） |
| 采集/落盘 | 实时 API（东财 F10 接口），无独立落盘 |
| 调度 | 随个股主流程渲染（app.js:2114） |
| 前端取数 | `GET /api/company-profile/:symbol`（server.js:687-695）→ `getCompanyProfile` |

## 五、降级 / 容错 / 诚实性设计

- **主营构成失败降级**：`MainOperate` 取不到时回退（shareholderData.js:291-305），简介片段退为经营范围，不报错。
- **产品图缺失静默跳过**：AI 卡未加载时 `try/catch` 跳过产品区（app.js:2156），整块可能空白而不提示原因。
- **诚实性缺口**：来源统一标「东方财富 F10」，但企业性质实为关键词推断（非 F10 权威字段），未注明「推断」。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **#1 简介缺失「上市日期 / 主营业务文本」**：标签「📊 简介」暗示公司概况，却只渲染 5 行 + 简介片段 + 产品图；"上市日期"仅在 AI 信息分析卡（`app.js:5351` `bi.listedDate`），"主营业务"文本未出现在简介（app.js:2134-2140）。与标签暗示不符。
- [ ] **#2 企业性质为关键词推断非权威**：`inferOwnership`（shareholderData.js:331-347）仅靠前十大股东名匹配；对"民营投资公司含'国资'字样""第一大为名义持有人"等会误判（代码已做部分防御，仍属启发式）。卡片来源标「东方财富 F10」却含非 F10 推断字段。
- [ ] **#3 主要产品仅显示图片、不显示名称**：`app.js:2145-2155` 只用 `productsServices[].imageLocal`，未用 `name`；且依赖 AI 卡 `this.companyDeepData` 加载，未加载时整段跳过（:2156），简介产品区可能整块空白而不提示原因。
- [ ] **#4 行业字段被 sectorIdentity 覆盖但来源标注未变**：`profile.industry` 实际来自 `resolveSectorIdentity`（shareholderData.js:459-464），与 F10 原始 CSRC 行业可能不同，但卡片统一标「东方财富 F10」（app.js:2158），口径易混。
- [ ] **#5 简介片段实为「经营范围」**：`intro` 来自 `businessScope` 前 300 字（shareholderData.js:307-308,319），与"公司简介"语义不同，用户易误读。
- [ ] **#6 跨股异步竞态**：填充 DOM 时若未校验当前 symbol，快速切股可能短暂显示上一股简介（⚠️ 待核实是否用 currentSymbol 守卫）。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 简介片段截断 | 300 字 | shareholderData.js:307-308 |
| 企业性质关键词表 | 国资委/集团/控股等 | shareholderData.js:331-347 |
| 产品图来源 | AI 信息分析卡（必应搜图兜底） | lib/ai/companyDeep.js |
