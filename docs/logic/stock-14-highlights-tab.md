# 个股亮点 / 雷点（「日志」Tab）· 反向逻辑说明

> 逻辑模型位置：个股页 → 底部 Tab 栏「📝 日志 / 个股亮点雷点」（tabName=`journal`）→ `Notes.renderStock(symbol, name)`
> 实现文件：`public/js/app.js:2894-2897`（tab 触发）、`public/js/notes.js`（Notes 模块，本地 localStorage 镜像）、`public/js/app.js:64`（Notes 初始化：`投资心得 / 大盘记录 / 个股亮点雷点`）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| Tab 触发 | 切到 `journal` tab 且 `currentSymbol` 存在 → 调 `Notes.renderStock(symbol, name)` | app.js:2894-2897 |
| 三条笔记流 | Notes 初始化分三类：`投资心得` / `大盘记录` / `个股亮点雷点`（app.js:64 注释） | app.js:64 |
| 个股条目筛选 | `Notes.notes` 中 `scope===symbol && aspect∈{highlight,risk}` 的条目单独归到「个股亮点雷点」区 | app.js:1635（同筛选逻辑复用于概览卡） |
| 手动主项标记 | 用户可把某条 highlight/risk 标 `mainFor:true`，该条会被概览卡（stock-06）优先展示 | app.js:1636-1637 |
| 内容字段 | 每条笔记 `{ scope, aspect, content, mainFor, date }`（⚠️ 字段名以 notes.js 实际为准） | app.js:1634-1637 |

## 二、核心公式 / 判定链

本 Tab **是用户编辑型本地日志，不含任何打分/算法**，其数据流向：

1. **用户录入**：在「个股亮点雷点」区新增笔记 → 写入 `Notes.notes`（localStorage），可设 `aspect='highlight'|'risk'`、`mainFor=true/false`、附带 `date`。
2. **AI 生成回填**：个股页「AI 生成亮点/雷点」按钮触发 `POST /api/ai/aspects`（routes/aiRoutes.js:93）→ `analyzeAspects`（augmentStock.js:273）生成 6 条 → 经某回填逻辑写入 Notes（⚠️ 回填路径待核实 notes.js / app.js 生成按钮处）。
3. **概览联动**：概览卡 `_loadAspectBrief`（app.js:1626）读取同一 `Notes.notes`，优先展示 `mainFor` 条目（见 stock-06 二节）。

> 即：本 Tab 是「源头」，概览卡 stock-06 是「消费端」；两者共享 `Notes.notes` 本地镜像。

## 三、指标 / 因子口径

| 项 | 口径 | 是否计分 | 出处 |
|---|---|---|---|
| 个股亮点条目 | `aspect==='highlight'` 的 Notes 文本 | 否（纯展示/记录） | app.js:1635 |
| 个股雷点条目 | `aspect==='risk'` 的 Notes 文本 | 否（纯展示/记录） | app.js:1635 |
| 主项标记 `mainFor` | 决定概览卡优先展示 | 否 | app.js:1636-1637 |

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | ① 用户手动录入（localStorage）；② AI 生成经 `analyzeAspects` 回填 |
| 采集/落盘 | `Notes` 模块持久化到 `localStorage`（键名 ⚠️ 待核实 notes.js）；非服务端落盘 |
| 调度 | 切到 journal tab 时 `Notes.renderStock` 重渲染（app.js:2896）；切股时（app.js:542-543）立即用新 symbol 重渲染，修复「亮点/雷点不随个股页面切换」的历史问题 |
| 前端取数 | 无网络请求（纯本地），AI 回填时经 `/api/ai/aspects` |

## 五、降级 / 容错 / 诚实性设计

- **纯本地、离线可用**：未联网也能查看/编辑历史笔记（localStorage 镜像）。
- **跨股隔离**：`scope===symbol` 严格过滤，A 股笔记不会串到 B 股（app.js:1635）；切股重渲染已修复串显问题（app.js:542-543）。
- **诚实性缺口**：AI 回填的条目与用户手录条目在 UI 上若无来源标识，用户难区分「AI 生成」vs「本人录入」（对比概览卡有 detail 行区分，本 Tab 待核实是否标注来源）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **#1 AI 回填条目来源标识缺失**：AI 生成的 aspects 写入 Notes 后，若未打「AI 生成」标记，用户可能在不知情下把 AI 文本当自己笔记（对比 stock-06 概览卡有来源行）。⚠️ 待核实 notes.js 是否记录 `source` 字段。
- [ ] **#2 本地 localStorage 跨设备不同步**：笔记存浏览器 localStorage，换设备/清缓存即丢失，无云端备份（⚠️ 待核实是否有导出/同步）。
- [ ] **#3 与概览卡双写一致性**：用户改 `mainFor` 后，概览卡与 Tab 是否实时一致取决于 `Notes.notes` 引用同一数组（app.js:1634 直接读 `Notes.notes`，应为同一引用，低风险）。
- [ ] **#4 截断与全文**：概览卡截断 70 字（app.js:1662），本 Tab 是否展示全文待核实；若 Tab 全文、概览截断，用户可能困惑「为什么概览少了半句」。
- [ ] **#5 无字数/条数上限**：⚠️ 待核实是否限制单股亮点雷点条数，过多时 UI 是否分页/折叠。
- [ ] **#6 删除/编辑的持久化**：编辑或删除某条后 localStorage 是否立即落盘、切股再切回是否保留（⚠️ 待核实 notes.js 实现）。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 笔记分类 | 投资心得 / 大盘记录 / 个股亮点雷点 | app.js:64 |
| 生成条数（AI 回填） | 6 条 | augmentStock.js:361-362 |
| 主项标识 | `mainFor:true` | app.js:1636-1637 |
| 持久化层 | localStorage（键名待核实） | notes.js |
