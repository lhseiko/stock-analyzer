# accuracy.html / judgments.html · 反向逻辑说明

> 逻辑模型位置：独立页面与全局入口 → 🎯 accuracy.html / 📋 judgments.html（badge：独立页面）
> 实现文件：public/accuracy.html + public/js/accuracy.js、public/judgments.html + public/js/judgments.js、server.js（records 接口）、lib/sameDayJudgment.js 等
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| accuracy.html 标题「分析准确率检查 · 大盘技术分析/个股技术面/短期行情判断/市场情绪提醒」 | 四 tab 总览页 | public/accuracy.html:6,52-55 |
| 大盘技术分析 tab | fetch /api/market-tech/records | accuracy.js:148 |
| 个股技术面 tab | fetch /api/tech-face/records | accuracy.js:153 |
| 短期行情判断 tab | fetch /api/sameday-judgment/records（单股可带 ?symbol=） | accuracy.js:209,215 |
| 市场情绪提醒 tab | fetch /api/sentiment-accuracy/records | accuracy.js:277 |
| 结算按钮 | 各 tab POST .../settle | accuracy.js:333-347 |
| judgments.html「📋 个股下一交易日判断记录 · 准确率核对」 | 每日判断记录 + 存储值 vs 本页重算核对 | public/judgments.html:21,38-44 |
| 记录筛选（全部/已结算/待结算/不一致） | 前端按 settled/correct 状态分组 | public/judgments.html:56-69 |
| 错误分析与自我进化区块 | 展示不一致/错误样本 | public/judgments.html:48-54 |

## 二、核心公式 / 判定链

**accuracy.html（展示层）**
1. 打开页面 → 四 tab 各自 fetch 对应 records 接口。
2. 接口内 `computeAccuracy` 对已结算记录 `correct/total*100` 聚合（sameDayJudgment.js:2049-2081,2074）。
3. 结算按钮触发 `POST /api/.../settle` → `settleAll` 补算未结算记录（server.js:531 等）。

**judgments.html（核对层）**
1. fetch `/api/sameday-judgment/records`（judgments.js:170-171，`cache:'no-store'`）。
2. 本页用同样规则**重算** `correct`，与存储值比对 → 标记「不一致」（judgments.html:38-44）。
3. 按全部/已结算/待结算/不一致筛选展示（judgments.html:56-69）。

## 三、指标 / 因子口径

| 口径 | 规则 | 出处 |
|---|---|---|
| 命中率口径 | correct = dir==='震荡' ? |actualChgPct|<=1.0 : dir===actualDir | sameDayJudgment.js:1999 |
| 准确率聚合 | accuracy = total ? round(correct/total*100) : null | sameDayJudgment.js:2074 |
| 长期判断 | **不在此两页**（longTermJudgment.js:12 不落盘不核算） | longTermJudgment.js:12 |
| 结算触发 | POST /api/sameday-judgment/settle（server.js:531）等 | server.js |

> ⚠️ 两页均**复用既有 records 接口**，无独立 `/api/accuracy`、`/api/judgments` 路由（common-02 同记）。

## 四、数据来源与采集链

| 层 | 内容 | 出处 |
|---|---|---|
| 数据源 | data/judgments/{targetDate}.json（短期）、data/market-tech/、data/tech-face/、data/sentiment-accuracy/ | 各 judgment lib |
| 接口 | /api/sameday-judgment/records（server.js:471）、/api/market-tech/records（:747）、/api/tech-face/records（:225）、/api/sentiment-accuracy/records（:268） | server.js |
| 前端 | accuracy.html + accuracy.js；judgments.html + judgments.js | public/ |
| 调度 | 15:30 盘后结算（server.js:2191-2262）填充 records | server.js |

## 五、降级 / 容错 / 诚实性设计

- **records 接口统一返回 JSON**：缺失具体资源返回 `{error:...}` 非 HTML（server.js 各路由）。
- **结算依赖 15:30 任务在线**：漏跑则 records 中记录长期 pending，accuracy 页命中率偏低（非 bug，属调度依赖；J15/J16 同记）。
- **judgments.html 本页重算核对**：存储值 vs 重算不一致即标红，提供「诚实自检」而非盲信存储——符合铁律「先查现状摆问题」。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **长期判断缺准确率页（common-06 同记）**：longTermJudgment.js:12 不落盘不核算，accuracy.html/judgments.html 均无长期 tab——若用户期望长期也进台账，属缺口。
- [ ] **结算依赖 15:30（J15/J16）**：服务未常驻则 records 不更新，accuracy 页数字失真。
- [ ] accuracy.js 单股 `?symbol=` 参数（:215）：后端是否支持按 symbol 过滤 records？不支持则单股视图为空。
- [ ] judgments.html「本页重算」与存储值口径是否完全一致（同一 1.0% 震荡阈值、同一 dir 判定）？若两处实现分叉会导致「假不一致」。
- [ ] 两页均为纯静态 HTML + JS，是否纳入 APP_VERSION 缓存破坏（FRONTEND_BUST_FILES 是否含 accuracy.html/judgments.html）？改动后旧页面可能缓存复用。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 结算槽位 | 15:30（每分钟检查） | server.js:2200,2261 |
| 震荡判定阈值 | 1.0% | sameDayJudgment.js:1999 |
| APP_VERSION（缓存破坏戳） | 20261016a | server.js:98 |
| FRONTEND_BUST_FILES | /js/app.js、/css/style.css、/icon.png 等 | server.js:109 |
