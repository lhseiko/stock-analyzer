# 📁 资料库（公司资料库 / F10）· 反向逻辑说明

> 逻辑模型位置：个股页 → 「📁 资料库」Tab（tabName=`docs` → `DocStore.onTabSwitch`）
> 实现文件：`public/js/docStore.js`（前端）、`lib/docStore.js:18-25`（六类定义）、`lib/f10Status.js`（上市状态/ST 历史）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 区块标题 | 实际为「📁 公司资料库」（非字面 "F10"） | docStore.js:63 |
| 六类文档 | annual（年报）/ semi（半年报）/ quarterly（季报）/ announcement（公告）/ research（研报）/ other（其他） | lib/docStore.js:18-25 |
| 单文档卡 | 标题、文件名、类型徽标、年份、季度、大小、上传时间 `uploadedAt` | docStore.js:584-614（前端）；lib/docStore.js:593 |
| 自动抓取 | 进入 Tab 时自动从**巨潮资讯网 cninfo** 抓取年报/半年报 | docStore.js:193-231，POST `/api/reports/download` |
| 搜索/上传 | `/api/docs/search` / `/api/docs/upload`（支持手动上传任意文件） | docStore.js:562, 774 |
| 加载触发 | 切到 docs tab → `DocStore.setStock` + `DocStore.onTabSwitch()` | app.js:2900-2905 |

## 二、核心公式 / 判定链

资料库**不做打分**，是文档管理与检索系统：

1. **本地库**：`lib/docStore.js` 管理 `data/companies/{code}/{type}/` 下的文档（六类，:18-25）。
2. **自动抓取**：进入 Tab 时 `POST /api/reports/download`（docStore.js:205）从 cninfo 抓年报/半年报；每股票每日仅一次（:191-199），默认回溯 5 年（:208，可选 3/5/8/10）。
3. **手动上传**：`/api/docs/upload`（:774）支持任意文件，落入对应类型目录。
4. **检索/统计**：`/api/docs/stats`、`/api/docs/search`（:414, 434）。

## 三、指标 / 因子口径

| 项 | 口径 | 出处 |
|---|---|---|
| 文档类型 | annual/semi/quarterly/announcement/research/other（六类） | lib/docStore.js:18-25 |
| 单文档字段 | title/fileName/type/year/quarter/size/uploadedAt | docStore.js:584-614 |
| 自动回溯 | 默认 5 年（3/5/8/10 可选） | docStore.js:208 |
| 抓取频控 | 每股票每日 1 次 | :191-199 |

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | ① 本地 `data/companies/{code}/{type}/`；② 自动抓取**巨潮资讯网 cninfo**（docStore.js:89, 205, 208） |
| 采集/落盘 | 进入 Tab 触发下载，落本地；`uploadedAt` 记录上传时间（lib/docStore.js:593） |
| 调度 | 切到 docs tab 触发（app.js:2904-2905）；后端 `/api/reports/download`（server.js:1819）、`/api/reports/probe`（:1882） |
| 前端取数 | `/api/docs/company/:code`、`/api/docs/stats`、`/api/docs/search`、`/api/docs/upload` |

## 五、降级 / 容错 / 诚实性设计

- **空态**："暂无文档/请先选择股票"（docStore.js:438-444, 155-164）。
- **加载失败**："加载失败: …"（docStore.js:485, 545, 579）。
- **抓取失败/网络受限**：警告并提示改通道（:221-227），不冒充已抓取。
- **诚实性亮点**：`lib/f10Status.js:16-20` 记录"退市/停牌接口不可达，取不到就不编"；回测幸存者偏差沿用默认 0.9 并标注"未获证据支撑"（:187）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **#1 标签「资料库(F10)」与实际数据源/性质不符**：区块标题实为"📁 公司资料库"（docStore.js:63）；自动抓取源是**巨潮资讯网 cninfo**（:89, 205, 208），且支持手动上传任意文件（:651-793）。并非"东财 F10 实时权威披露流"。而简介卡却标注"来源：东方财富F10"（app.js:2158），两处来源口径不一致。
- [ ] **#2 资料库时效标注弱**：单文档仅记 `uploadedAt`（lib/docStore.js:593），年报标 `year`（:590）；无"截至最新披露日/是否最新一期"提示，用户难判断资料时效性；自动下载"每股票每日一次"（docStore.js:191-199）后静默，无"最后同步时间"展示。
- [ ] **#3 自动抓取仅覆盖年报/半年报**：`POST /api/reports/download` 抓年报/半年报（docStore.js:205），季报/公告/研报依赖本地已有或手动上传，未自动补齐——界面未明示"仅自动抓年报/半年报"。
- [ ] **#4 通道失败降级提示笼统**：抓取失败提示"改通道"（docStore.js:221-227），但前端未明确是哪个通道（cninfo/本地）失败，用户难定位。
- [ ] **#5 手动上传无类型校验**：`/api/docs/upload`（docStore.js:774）支持任意文件，错误归类（如把研报拖进 announcement）无校验，影响检索准确性。
- [ ] **#6 f10Status 未接入简介卡**：`lib/f10Status.js` 服务上市状态/ST 历史（:177），其 `LISTING_DATE` 概念上属"上市日期"，但简介卡未接入（见 stock-07 #1），上市日期仍只在 AI 卡显示。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 文档六类 | annual/semi/quarterly/announcement/research/other | lib/docStore.js:18-25 |
| 自动回溯年限 | 5 年（3/5/8/10 可选） | docStore.js:208 |
| 自动抓取频控 | 每股票每日 1 次 | :191-199 |
| f10Status 缓存 TTL | 7 天 | lib/f10Status.js:33 |
