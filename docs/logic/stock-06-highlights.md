# 最大亮点 / 雷点（概览卡片）· 反向逻辑说明

> 逻辑模型位置：个股页 → 顶部常驻区下方「📌 最大亮点 / 雷点」概览补充卡（与行业前景、股东户数变化并列，app.js:666/698）
> 实现文件：`public/js/app.js:1626-1675`（`_loadAspectBrief` 渲染）、`lib/ai/augmentStock.js:273`（`analyzeAspects` 真实生成入口）、`routes/aiRoutes.js:93-119`（POST 生成 / GET 只读缓存）、`public/index.html:392-394`（容器）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 容器 `#aspectValue` / `#aspectDetail` | index.html:392-394，标签「最大亮点 / 雷点」 | index.html:392-394 |
| 优先展示：用户手动主项 | 若 Notes 中该 symbol 存在 `aspect==='highlight'&&mainFor` 或 `aspect==='risk'&&mainFor` 的笔记，优先展示其 `content`（截断 70 字），detail 标「⭐ 用户手动指定」 | app.js:1630-1648 |
| 回退：AI 生成首条 | 无手动主项时 `GET /api/ai/aspects/:symbol`，展示 `highlights[0]` + `risks[0]`（各截断 70 字） | app.js:1650-1664 |
| 来源行 `#aspectDetail` | 无手动主项时：「来源：AI 联网生成（日期）· 最新报告期 X」 | app.js:1666-1668 |
| 空态 | 未生成缓存且非手动 → 「尚未生成」+「点个股页「AI 生成亮点/雷点」」 | app.js:1654-1658 |
| 失败态 | 请求异常 → 「加载失败」+「AI 亮点/雷点加载失败」 | app.js:1669-1674 |
| 内容对象兼容 | 亮点/雷点可能是 `{text,outdated}` 对象或纯字符串（向后兼容），统一取 `.text` | app.js:1660-1661 |
| 跨股污染防御 | 异步返回时校验 `overviewExtraSymbol === symbol`，否则丢弃 | app.js:1653, 1670 |

## 二、核心公式 / 判定链

本卡片**不做打分**，仅做「文本展示 + 优先级选择」：

1. **优先级判定**（`_loadAspectBrief`，app.js:1630-1648）：先查 `Notes.notes` 中 `scope===symbol && aspect∈{highlight,risk}` 的条目；取 `mainFor===true` 的 highlight / risk 作为主项；命中则直接展示并 return。
2. **AI 缓存读取**（app.js:1650-1664）：未命中手动主项 → `GET /api/ai/aspects/:symbol` → 后端 `readCache(symbol,'_aspects')`（routes/aiRoutes.js:113-119，**只读缓存、不联网、不限 TTL**）→ 返回 `{highlights[], risks[], date, latestReportLabel}`。
3. **真实生成入口**：`POST /api/ai/aspects`（routes/aiRoutes.js:93-102）→ `analyzeAspects`（augmentStock.js:273）。取 `slice(0,6)`（augmentStock.js:361-362），前端仅展示首条。
4. **内容来源**：权威财务快照 `fetchAuthoritativeFinancials`（augmentStock.js:317）+ 报告期 `getFinanceHub`（:309）+ 联网搜索 `callLLM`（:339 附近）；prompt 声称熟悉 A 股/港股/美股（:257）。

## 三、指标 / 因子口径

| 项 | 口径 | 是否计分 | 出处 |
|---|---|---|---|
| 亮点列表 `highlights` | LLM 生成的文本数组，最多 6 条，前端取 [0] | 否（纯展示） | augmentStock.js:361-362；app.js:1662 |
| 雷点列表 `risks` | 同上 | 否（纯展示） | 同上 |
| 截断 | 前端 `slice(0,70)` 字 | — | app.js:1662-1663 |
| 手动主项 | Notes 中 `mainFor:true` 的 highlight/risk | 否（纯展示） | app.js:1635-1637 |

- 本卡片**与长期判断卡片（stock-05）逻辑完全独立**：长期判断是 5 因子加权确定性计算；本卡是 AI 文本生成结果（见 stock-05 第六节 #10）。

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | 概览卡：用户在 Notes 中的手动标注（localStorage）+ AI 联网搜索生成的 aspects 缓存 |
| 采集/落盘 | AI 生成写 `data/companies/{code}/_aspects`（augmentStock.js 经 `writeCache`）；GET 端只读缓存不限 TTL（routes/aiRoutes.js:104 注释） |
| 调度 | 概览卡随个股加载异步拉取（app.js:666/698）；生成需用户在个股页主动点「AI 生成亮点/雷点」按钮触发 POST |
| 前端取数 | `GET /api/ai/aspects/:symbol`（app.js:1651） |

## 五、降级 / 容错 / 诚实性设计

- **手动主项优先于 AI**：用户可在 Notes 手动指定亮点/雷点并标 `mainFor`，覆盖 AI 结果（app.js:1640-1648），属合理「人审优先」设计。
- **无缓存诚实空态**：未生成 → 「尚未生成 · 点个股页「AI 生成亮点/雷点」」（app.js:1654-1658），不编造。
- **生成失败回退**：`analyzeAspects` 失败回退上一次成功结果并标 `stale`（augmentStock.js:418-423）。
- **无「仅支持 A 股」一刀切**：本卡与长期卡均**不存在**「仅支持 A 股」文案（该文案仅出现在深度分析 app.js:2949 与资金量能 app.js:3195）；但 AI prompt 声称覆盖港股/美股，实际生成质量对非 A 股未经充分验证（⚠️ 待核实）。
- **误导风险**：来源行标「AI 联网生成」，但展示的是**上次生成缓存**，无「数据可能已过期」提示（GET 不限 TTL）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **#1 概览卡只读缓存、无主动生成入口**：`GET /api/ai/aspects`（routes/aiRoutes.js:113）仅读 cache，未命中即「尚未生成」（app.js:1654）。用户若未在个股页点过「AI 生成亮点/雷点」，概览卡永远空白，无自动触发——可用性/诚实性缺口。
- [ ] **#2 缓存不限 TTL、无过期提示**：`aspects` GET 不限 TTL（routes/aiRoutes.js:104），旧亮点雷点可能长期展示；来源行「AI 联网生成（日期）」仅标生成日，不标「已过期」（对比深度分析有 stale 徽标，此处缺失）。
- [ ] **#3 手动主项与 AI 结果口径混用无区分**：卡片同一位置既可能显示用户手动标注、也可能显示 AI 文本，仅 detail 行用「⭐ 用户手动指定」vs「来源：AI 联网生成」区分（app.js:1646,1668），但视觉权重偏弱，用户易忽略来源差异。
- [ ] **#4 AI 文本非确定性、不可复现**：`analyzeAspects` 经 LLM 生成（augmentStock.js:273），同一股票不同时间生成可能不同；概览卡展示首条（[0]），LLM 排序稳定性未经断言保护。
- [ ] **#5 与长期判断卡片同区却逻辑无关**：见 stock-05 第六节 #10——用户易误以为亮点雷点来自 5 因子打分体系。
- [ ] **#6 截断 70 字可能丢失关键风险**：`slice(0,70)`（app.js:1662-1663）硬性截断，雷点关键限定条件（如「若 XX 不成立则…」）可能在 70 字外被截断，且无「展开全文」入口（⚠️ 待核实 tab 是否展示全文）。
- [ ] **#7 非 A 股生成质量未验证**：prompt 声称覆盖港股/美股（augmentStock.js:257），但生成链路依赖东财 F10 权威快照（:317），港股/美股 F10 字段覆盖度未验证，可能静默降级。
- [ ] **#8 跨股异步竞态**：虽已用 `overviewExtraSymbol` 校验（app.js:1653,1670），但手动主项分支（:1640-1648）未做同符号校验，快速切股时理论上可能短暂展示上一股手动项（低概率，⚠️ 待核实）。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 生成条数 | slice(0,6) | augmentStock.js:361-362 |
| 前端截断 | 70 字 | app.js:1662-1663 |
| 缓存策略 | GET 只读、不限 TTL | routes/aiRoutes.js:104,116 |
| 手动主项标识 | Notes `mainFor:true` | app.js:1636-1637 |
| LLM 模型 | ⚠️ 待核实（augmentStock.js callLLM 配置） | augmentStock.js |
