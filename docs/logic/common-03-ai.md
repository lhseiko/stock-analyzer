# AI 叙事层 · 反向逻辑说明

> 逻辑模型位置：跨页面公共支撑 → 🤖 AI 叙事层（badge：公共支撑）
> 实现文件：lib/ai/config.js、lib/ai/llm.js、lib/ai/augmentStock.js、lib/ai/companyDeep.js、lib/ai/earnings.js、lib/ai/valuation.js、lib/hotTopics.js、lib/ai/cache.js、public/js/logicModel.js
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 个股页「⚠️ 尚未配置 AI API Key…」占位 | 无 Key 时前端展示配置提示 | public/js/app.js:1706,3909,4005,5274 |
| 亮点/雷点卡文本 | `analyzeAspects` 生成（POST /api/ai/aspects），GET 只读缓存不限 TTL | lib/ai/augmentStock.js:273,418-424 |
| 深度分析「AI 估值摘要」框（利好红/利空绿/重点黄） | 由 earnings/research/announcements 缓存段落组合，纯叙事着色 | lib/deep/pipeline.js（见 stock-11） |
| 个股页「正在后台联网生成…」 | `_triggerAi` 触发，失败降级提示 | deepCharts.js:1485-1539 |
| 近期热点卡「未配置 AI Key，无法自动联网归因」 | `hotTopics` noKey 写盘占位 | lib/hotTopics.js:397-406 |

## 二、核心公式 / 判定链

**叙事边界铁律（确定性由代码，LLM 仅叙事）**
- 逻辑模型弹层明确「大模型只把确定性计算结果讲成人话；所有数字以代码输出为准」（public/js/logicModel.js:251-255）。
- 代码权威校验：augmentStock.js 对 AI 输出的「资产负债率」与权威快照偏差 >1pp 直接修正并标 `financeCorrected`（lib/ai/augmentStock.js:386-401）；earnings.js 注入「确定性代码核算的单季数据」禁用跨口径比较（lib/ai/earnings.js:496,549）；companyDeep.js 对 LLM 返回做代码兜底 `flags`（lib/ai/companyDeep.js:128,137,430）。

**LLM 调用封装**
- 客户端按 provider 选服务商 URL（qwen/glm/openai），未配置兜底 `qwen-plus`（lib/ai/config.js:66-85）。
- 单次硬超时默认 180000ms（180s）（lib/ai/llm.js:430-431）。
- API Key 从本机 `data/ai_config.json` 读取（**非环境变量**，lib/ai/config.js:37,107-127）；前端只回显 `hasKey`（config.js:165-179）。

## 三、指标 / 因子口径（AI 能力入口）

| 能力 | 入口函数 file:line | 触发方式 | 默认超时 |
|---|---|---|---|
| 亮点/雷点 aspects | augmentStock.js:273 analyzeAspects | POST /api/ai/aspects（aiRoutes.js:93）；GET 只读缓存（:113） | 240s（:339） |
| 公司深度七段 companyDeep | companyDeep.js:188 analyzeCompanyDeep | POST /api/ai/company-deep（aiRoutes.js:123）；GET 只读（:224） | 240s（:244/256） |
| 财报解读 earnings | earnings.js:515 analyzeEarningsReport | POST /api/ai/earnings（aiRoutes.js:283）；readEarningsCache（:293） | 180s（:562） |
| AI 估值叙事 valuation | valuation.js:377 analyzeValuation | POST /api/ai/valuation（aiRoutes.js:134） | 180s（:377） |
| 异动归因 hotTopics | hotTopics.js analyzePriceChange | 个股页近期热点卡异步加载 | 跟随默认 180s |
| 事件分流 llmTriage | eventEngine.js:464 | 定时 scanEvents（server.js:2297） | 180s（:479） |

> 各能力超时可覆写：aspects/companyDeep 用 240s，并传 `overallBudgetMs:300000` 整链路预算（augmentStock.js:339），避免串行重试累计超 16 分钟无响应。

## 四、数据来源与采集链

| 层 | 内容 | 出处 |
|---|---|---|
| 配置 | `data/ai_config.json`（provider/apiKey/modelWeb/modelLocal/searchMode/volc*/baidu*） | lib/ai/config.js:37；index.html:1082-1142 |
| 缓存 | AI 只读缓存 `data/ai_cache/`（readCache 不联网不限 TTL）；估值缓存版本+TTL 双重门控（ver!=VALUATION_VER 或超 30d → null） | lib/ai/cache.js:16,44-45 |
| 调度 | 后台定时 LLM 经 `SA_NO_BG_AI=1` 开关禁用（防静默计费，server.js:2267/2308）；事件扫描四槽位（server.js:2266-2291） | server.js |
| 前端取数 | 各页面 JS fetch 对应 `/api/ai/*` | routes/aiRoutes.js |

## 五、降级 / 容错 / 诚实性设计

- **无 Key 行为分两类**（易混淆，需区分）：
  - aspects/companyDeep/earnings：**直接返回 NO_KEY 错误，不写盘**（augmentStock.js:276-278；companyDeep.js:191-193；earnings.js:518-520）。
  - hotTopics 近期热点：**写盘 noKey 占位并复用**（hotTopics.js:397-406）。⚠️ 此即 stock-02 文档 T6 记的「noKey 结果写盘且缓存复用不排除 noKey → 当日归因被占位毒化，配好 Key 也须点 🔄」，仍需修复。
- **失败兜底**：
  - aspects 超时/失败先回退上次成功结果并标 `stale`，无历史返 `{error:'API_ERROR'}`（augmentStock.js:418-427）。
  - companyDeep 联网失败且本地事实可用 → 降级本地纯推理（companyDeep.js:245-259）。
  - earnings 失败直接返错误，**无 stale 兜底、不写盘**（earnings.js:599-605）。
  - eventEngine.llmTriage 失败 catch 返空 → 该批候选一律不认（保守「不确定归零」，eventEngine.js:497-499）。
- **全局兜底**：postLLM 带能力自学习，遇 400 自动去 enable_search 或切流式重试最多 4 次；外部搜索通道失败一律降级纯推理，**绝不静默升级内置 enable_search 防扣费**（llm.js:201-239,306-466）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **⚠️ 事件分流模型名记忆不符**：用户记忆称「本地 LLM 事件分流用 `qwen3-vl-235b-a22b-thinking`，超时 180s」，但全项目 grep 无此模型名；实际取 `cfg.modelLocal`（eventEngine.js:474），磁盘 `data/ai_config.json:5` 为 `qwen3-vl-plus`，超时 180000ms 属实（eventEngine.js:479）。需核实记忆中模型名是否为旧版本/误记。
- [ ] **T6（noKey 毒化）**：hotTopics.js:397-406 写盘 noKey 占位，缓存复用排除条件 `!cache.noKey`（hotTopics.js:445）仅防「旧 noKey 当成功」，但「无缓存时仍写新 noKey 占位」——配 Key 后必须点 🔄 才更新（stock-02 T6 已记，待修）。
- [ ] AI 估值缓存版本 `VALUATION_VER='v4'`（cache.js:60）、earnings 版本 `EARNINGS_PROMPT_VERSION='20260909i'`（cache.js:57）：改 prompt 是否同步升版？漏升会导致旧缓存被误用。
- [ ] aspects 只读缓存「不限 TTL」（augmentStock.js:418-424）：AI 结论长期不刷新是否导致 stale 文本误导？前端是否给出「数据时间」提示？
- [ ] 叙事边界是否在所有 AI 入口都强制：是否存在 LLM 输出数字被前端直接当权威值展示而绕过代码核算的入口？

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| LLM 单次超时 | 180000ms（各入口可覆写 240s） | lib/ai/llm.js:430-431；augmentStock.js:339 |
| AI 完成后端总预算 | 300000ms（仅 aspects 传 overallBudgetMs） | augmentStock.js:339 |
| 默认模型 | qwen-plus（qwen-max 实测 403） | lib/ai/config.js:70 |
| API Key 存储 | data/ai_config.json（明文本机） | lib/ai/config.js:37 |
| 后台 AI 开关 | SA_NO_BG_AI=1 禁用 | server.js:2267/2308 |
| 估值缓存版本 VALUATION_VER | v4 | lib/ai/cache.js:60 |
| earnings 提示版本 | 20260909i | lib/ai/cache.js:57 |
| AI 补全 TTL / 半静态 TTL | 7d / 30d | lib/ai/config.js:42,45 |
