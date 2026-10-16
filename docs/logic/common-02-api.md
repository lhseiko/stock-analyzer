# API 层（Express 路由）· 反向逻辑说明

> 逻辑模型位置：跨页面公共支撑 → 🔌 API 层（badge：公共支撑）
> 实现文件：server.js、routes/aiRoutes.js、routes/eventRoutes.js、routes/dedicatedFactor.js、routes/docsRoutes.js
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 任意前端请求返回 JSON | 各 `/api/*` 缺失具体资源时返回 `{error:...}` JSON（非 HTML） | server.js:165, docsRoutes.js:270-272 |
| 浏览器地址栏 `/` 自动带 `?v=20261016a` | 入口重定向中间件：访问 `/` 且 `?v != APP_VERSION` → 302 重定向补版本号 | server.js:99-104 |
| `/js/app.js` 等前端资源强制 `?v=` | `FRONTEND_BUST_FILES` 白名单不匹配版本号即 302 补 `?v=` | server.js:109-120 |
| 未知路径打开「白屏但能进前端路由」 | SPA 兜底：未命中任何 API/静态资源 → 返回 `public/index.html`（前端接管） | server.js:1925-1927 |
| 后端 500 返回 JSON 而非 HTML 错误页 | 全局错误中间件统一 `res.status(500).json(...)` | server.js:2373-2378 |
| 端口 3005 仅在本地回环监听 | `app.listen(port,'127.0.0.1')`（20261007a 修复原 0.0.0.0 全网可达） | server.js:2390 |

## 二、核心公式 / 判定链

**请求生命周期（从前到后）**
1. 入口缓存破坏：`/` 与 `FRONTEND_BUST_FILES` 强制 `?v=` 重定向（server.js:99-120）。
2. API 中间件：所有 `/api` 统一 `Cache-Control: no-store`（server.js:89-93）。
3. 静态资源托管：`public/`，JS/CSS/HTML 设 `no-store`（server.js:122-133）。
4. 业务路由匹配（见第三节清单）。
5. 异步路由自带 `try/catch` 返回 JSON（Express 4 不自动捕获 async rejection，server.js:2370）。
6. SPA 兜底（server.js:1925）；全局错误中间件兜底（server.js:2373）。
7. `unhandledRejection` 仅记录不崩溃（server.js:2380-2383）。

## 三、指标 / 因子口径（路由清单）

> 绝大多数处理器为 server.js / 子路由内联箭头函数（无独立命名函数）。

### server.js 直挂路由（节选高频）
| 方法 | 路径 | file:line |
|---|---|---|
| GET | /api/health | server.js:139 |
| GET | /api/quote/:symbol | server.js:162 |
| GET | /api/history/:symbol | server.js:174 |
| GET | /api/deep-analysis/:symbol | server.js:1276 |
| GET | /api/sameday-judgment/:symbol | server.js:516 |
| GET | /api/long-term-judgment/:symbol | server.js:542 |
| GET | /api/capital-flow/:symbol | server.js:1777 |
| GET | /api/industry-analysis/:symbol | server.js:1758 |
| GET | /api/shareholders/:symbol | server.js:674 |
| GET | /api/company-profile/:symbol | server.js:687 |
| GET | /api/announcements/:symbol | server.js:413 |
| GET | /api/macro-data | server.js:402 |
| GET | /api/db/datapoints/:symbol（附 isFresh） | server.js:1249 |
| GET/POST | /api/market-rank | server.js:444,453 |
| POST | /api/backtest-validate | server.js:637 |
| GET | *（SPA 兜底） | server.js:1925 |

### 子路由器挂载
| 挂载点 | file:line | 路由文件 |
|---|---|---|
| aiRoutes | server.js:1035 | routes/aiRoutes.js（/api/ai/*、/api/miaoxiang/*） |
| eventRoutes | server.js:1037 | routes/eventRoutes.js（/api/events/*） |
| dedicatedFactorRoutes | server.js:1038 | routes/dedicatedFactor.js（/api/dedicated/*） |
| docsRoutes | server.js:1811 | routes/docsRoutes.js（/api/docs/*，F10/资料库） |

> 完整路由（约 90+ 条）见各文件。⚠️ 无独立 `/api/accuracy`、`/api/judgments` 路由（见 common-06 / page-01/02）。

## 四、数据来源与采集链

| 层 | 内容 | 出处 |
|---|---|---|
| 前端取数 | 各页面 JS 经 `fetch('/api/...')` 取数，缓存破坏靠 `?v=` 强制刷新 | server.js:99-120 |
| 后端处理 | 路由内联函数调用 lib/ 层（getQuote、各 judgment、deepAnalysis 等） | server.js 各路由 |
| 落盘/回源 | 业务结果经 lib/db.js（SQLite）或内存缓存，必要时回源外部 API | lib/db.js |
| 静态托管 | public/ 目录（express.static） | server.js:122-133 |

## 五、降级 / 容错 / 诚实性设计

- **SPA 兜底返回 HTML 非 JSON**：未知路径一律回 `index.html`（server.js:1925）。⚠️ 这意味着用 curl 试探不存在的 `/api/xxx` 若路径未以 `/api` 前缀命中则返回 HTML，需用正确 `/api` 前缀路径（如 `/api/quote/:symbol` 而非 `/api/stock/:symbol`）。
- **全局错误中间件统一 JSON**：避免 Express 默认 HTML 错误页 / 前端把 HTML 当 JSON 解析（server.js:2373-2378）。
- **unhandledRejection 不崩溃**：长驻服务稳定性保护（server.js:2380-2383）。
- **API 禁用浏览器缓存**：`/api` 全量 `no-store`，避免旧响应误导（server.js:89-93）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] SPA 兜底是否会导致「API 路径拼写错误」被前端静默接管（返回 HTML 而非 JSON 报错）？前端 fetch 非 `/api` 前缀路径失败时是否按 HTML 解析报错（stock-01/02 文档曾记录 `/api/stock/` 返回 HTML 的坑）。
- [ ] `APP_VERSION` 升版是否覆盖全部前端资源（`FRONTEND_BUST_FILES` 白名单是否含本次改动的所有 .js/.css）？遗漏会导致旧缓存复用。
- [ ] 端口仅回环 `127.0.0.1`：局域网/手机端访问是否因此不可达（memory 提到手机 APP 云端模式，需确认云端转发而非直连本机端口）。
- [ ] 端口占用顺延逻辑 `startServer(port, retries=5)`（server.js:2385,2472）：顺延后实际端口是否与 `data/.server-port` 记录一致？前端是否依赖固定 3005？
- [ ] 异步路由若遗漏 try/catch，rejection 是否会落入全局中间件但仍可能已 `res.headersSent`（server.js:2373 有 `if (res.headersSent) return next(err)` 保护）。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| PORT | 3005（环境变量 PORT 可覆盖） | server.js:84 |
| 监听地址 | 127.0.0.1（仅回环） | server.js:2390 |
| APP_VERSION（缓存破坏戳） | `20261016a` | server.js:98 |
| FRONTEND_BUST_FILES 白名单 | /js/app.js、/css/style.css、/icon.png 等 | server.js:109 |
| 端口顺延上限 | retries=5 | server.js:2385 |
