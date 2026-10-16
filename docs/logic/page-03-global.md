# 全局常驻入口（心得 / 大盘记录 / AI 设置 / 逻辑模型）· 反向逻辑说明

> 逻辑模型位置：独立页面与全局入口 → 全局常驻入口（badge：全局入口）
> 实现文件：public/index.html（顶部导航）、public/js/logicModel.js、public/js/app.js（AI 设置）、public/index.html:1082-1142（AI 设置弹窗）、public/js/notes.js、server.js（/api/notes）、routes/aiRoutes.js（/api/ai/config）、lib/ai/config.js
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 顶部常驻栏「投资心得 / 大盘记录 / AI 设置」 | 所有页面都显示（index.html:109 注释） | public/index.html:109,112-114 |
| 投资心得 → Notes.showScopeModal('global') | 全局作用域笔记 | index.html:112 |
| 大盘记录 → Notes.showScopeModal('market') | 大盘作用域笔记 | index.html:113 |
| AI 设置 → App.openAISettings() | 打开 AI 配置弹窗 | index.html:114；app.js:3805 |
| 工作台逻辑模型 → LogicModel.open() | 打开逻辑模型弹层（id="logicModelModal"） | index.html:115；logicModel.js:425-501 |
| 逻辑模型弹层模块树 | 纯静态 TREE 数据，不联网不调大模型 | logicModel.js:11-13,26 起 |
| AI 设置「已配置/未配置」状态 | 前端按 `hasKey` 回显 | lib/ai/config.js:165-179 |

## 二、核心公式 / 判定链

**AI 设置保存链路**
1. 用户填 provider / apiKey / modelWeb / modelLocal / searchMode / volc* / baidu*（index.html:1082-1142）。
2. 保存 `saveAISettings`（app.js:3850）→ `POST /api/ai/config`（routes/aiRoutes.js:55）。
3. 后端 `loadConfig/saveConfig` 读写 `data/ai_config.json`（lib/ai/config.js:37,107-127,141-163），**明文本机保存，不上传**（index.html:1089）。
4. 前端回显仅 `hasKey`（config.js:165-179）。

**心得 / 大盘记录存储链路**
1. 主存 localStorage（key 沿用旧 journal key，notes.js:7）。
2. `/api/notes/sync` 全量回写服务端 `data/notes.json`（server.js:1458，`writeNotesFile`）。
3. 作用域由 `Notes.showScopeModal('global'|'market')` 区分（index.html:112-113）。

**逻辑模型弹层渲染**
1. `LogicModel.open()` 取 `getElementById('logicModelModal'/'logicModelBody')` 渲染 TREE（logicModel.js:425-501）。
2. TREE 四级结构：首页（:31-89）/ 个股页（:93-221）/ 跨页面公共支撑（:225-293，含准确率闭环 :275、规则铁律 :289）/ 独立页面与全局入口（:296 起，含 accuracy.html :300）。

## 三、指标 / 因子口径

| 入口 | 配置/数据 | 出处 |
|---|---|---|
| AI 设置 provider | qwen/glm/openai | index.html:1103 |
| AI 设置 API Key | 仅存本机 data/ai_config.json | index.html:1109；config.js:37 |
| 联网模型 modelWeb / 本地模型 modelLocal | 如 qwen3-vl-plus（见 common-03/04） | index.html:1111,1113 |
| 联网搜索方式 | builtin/mcp/volc/baidu | index.html:1115 |
| 心得/大盘记录 | localStorage + data/notes.json 镜像 | notes.js:7,26,72；server.js:1454,1458 |
| 逻辑模型 TREE | 静态数据，含准确率闭环/独立页节点 | logicModel.js:275,300 |

## 四、数据来源与采集链

| 层 | 内容 | 出处 |
|---|---|---|
| AI 配置 | data/ai_config.json（本机明文） | lib/ai/config.js:37 |
| 笔记 | 浏览器 localStorage（主）+ data/notes.json（服务端镜像） | notes.js:7；server.js:1454,1458 |
| 逻辑模型 | 前端静态 TREE（logicModel.js） | logicModel.js:26 起 |
| AI 设置后端 | GET/POST /api/ai/config（routes/aiRoutes.js:51,55） | aiRoutes.js |
| 笔记后端 | GET /api/notes、POST /api/notes/sync（server.js:1454,1458） | server.js |

## 五、降级 / 容错 / 诚实性设计

- **AI 设置本地优先**：API Key 仅本机保存不上传（index.html:1089），隐私安全；但⚠️ 换设备/清缓存需重新配置（配合 memory 提的手机 APP 云端模式，需确认配置是否跨端同步）。
- **笔记 localStorage 为主 + 服务端镜像**：单用户场景下 `/api/notes/sync` 等价于落盘（server.js:1458 注释），离线可用、在线备份。
- **逻辑模型弹层纯静态**：不联网不调大模型，永远可打开，不依赖后端健康（logicModel.js:11-13）。
- **AI 设置状态诚实回显**：`hasKey` 而非明文 Key（config.js:165-179），防泄露。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **⚠️ AI 配置跨端同步缺口**：memory 计划手机 APP 云端模式继续开发——`data/ai_config.json` 为**本机明文**，云端模式需确认配置是否随云端账号同步，否则手机端无 Key 无法调用 AI（common-03 同记 Key 读本机文件）。
- [ ] **笔记 localStorage 为主**：换浏览器/清缓存/换设备，localStorage 笔记丢失，仅靠 `/api/notes/sync` 的 data/notes.json 镜像——sync 是否自动触发（还是需手动点同步）？未 sync 的笔记云端无备份。
- [ ] 逻辑模型 TREE 是否与实际模块清单同步：本次新增 common-01~07、page-01~03 文档，logicModel.js:225-300 的 TREE 节点是否已覆盖？若弹层未列新模块，用户找不到对应说明。
- [ ] AI 设置弹窗字段（volc/baidu）是否后端均落盘（aiRoutes.js:55 saveConfig 是否含 volc*/baidu*）？漏存字段保存后丢失。
- [ ] `/api/notes/sync` 全量回写：并发编辑（多标签）是否覆盖而非合并，导致笔记丢失？

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| AI provider | qwen（兜底 qwen-plus） | index.html:1103；config.js:70 |
| AI API Key | 空（本机 data/ai_config.json） | config.js:37 |
| 逻辑模型 TREE | 静态，随文档体系更新 | logicModel.js:26 起 |
| 笔记作用域 | global / market | index.html:112-113 |
| 笔记后端镜像 | data/notes.json | server.js:1458 |
