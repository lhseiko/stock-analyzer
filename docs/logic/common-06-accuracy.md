# 准确率闭环 · 反向逻辑说明

> 逻辑模型位置：跨页面公共支撑 → 📊 准确率闭环（badge：公共支撑）
> 实现文件：lib/sameDayJudgment.js、lib/longTermJudgment.js、lib/marketTechJudgment.js、lib/techFaceJudgment.js、lib/sentimentAccuracy.js、server.js（结算调度）、public/accuracy.html、public/js/accuracy.js、public/judgments.html、public/js/judgments.js
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| accuracy.html 四个 tab（大盘技术/个股技术面/短期行情判断/市场情绪） | 各 tab fetch 对应 records 接口，展示命中率台账 | public/accuracy.html:52-55；accuracy.js:148,153,209,277 |
| judgments.html「准确率核对（存储值 vs 本页重算）」 | 同源 `/api/sameday-judgment/records`，本页重算对比存储值 | public/js/judgments.js:170-171；judgments.html:38-44 |
| 结论卡「准确率 87%」等数字 | `computeAccuracy` 对已结算记录 `correct/total*100` 实时聚合 | sameDayJudgment.js:2049-2081,2074 |
| 结算后「✓ 已结算 / 待结算」标记 | 每条记录 `settled/correct/actualClose/actualChgPct/actualDir` | sameDayJudgment.js:1980-2007 |

## 二、核心公式 / 判定链

**1. 判断记录持久化与复用门控**
- 落盘 `data/judgments/{targetDate}.json`，每条带 `schemaVersion`（sameDayJudgment.js:1818）。
- SCHEMA_VERSION 由「因子结构 FNV-1a 哈希」+ `-` + LAYOUT_VERSION 拼接（sameDayJudgment.js:1197）；写侧哈希 `_hashFactorStructure`（:1182-1195）。
- 复用条件 `rec.schemaVersion === SCHEMA_VERSION`（sameDayJudgment.js:2166,2241）——**旧版本记录被判「旧 schema」强制重算**（铁律：只改代码不升版本 → 旧记录永久复用，永不生效）。

**2. 命中率计算（结算口径）**
- 每条结算：`correct = rec.dir==='震荡' ? Math.abs(actualChgPct)<=1.0 : rec.dir===actualDir`（sameDayJudgment.js:1999）。
- `computeAccuracy`：`accuracy = total ? round(correct/total*100) : null`（:2074），`total` = 已 settled 记录数（:2052-2054）。

**3. 结算触发**
- `settleAll` 遍历未结算记录并 `saveLearning`（sameDayJudgment.js:2035-2047）。
- 调度：15:30 盘后 `runAutoReview()`（server.js:2200,2204-2207）；每分钟检查（server.js:2261）；启动兜底补写（server.js:2413-2435）。

## 三、指标 / 因子口径

| 口径 | 规则 | 出处 |
|---|---|---|
| 短期判断 schemaVersion | 'h' + 因子哈希 + '-' + LAYOUT_VERSION | sameDayJudgment.js:1197 |
| 短期自学习样本下限 LEARN_MIN_SAMPLE | **5**（单因子样本下限，低于不调整权重） | sameDayJudgment.js:1200,1251 |
| 首页情绪自学习下限（同名常量） | **20** | marketEmotionModel.js:68,617 |
| 舆情拐点自学习下限（同名常量） | **15** | sentimentTurningPoint.js:39 |
| 结算震荡阈值 | 实际涨跌幅绝对值 ≤1.0% 判震荡正确 | sameDayJudgment.js:1999 |
| 长期判断 | **不落盘历史、不核算准确率**（仅进程内 ~5min 缓存） | longTermJudgment.js:12；server.js:541 |

## 四、数据来源与采集链

| 层 | 内容 | 出处 |
|---|---|---|
| 落盘 | data/judgments/{targetDate}.json（短期）；data/market-tech/（大盘技术）；data/tech-face/（个股技术面）；data/sentiment-accuracy/（情绪） | sameDayJudgment.js:1818；marketTechJudgment.js:32；techFaceJudgment.js:48；sentimentAccuracy.js:34 |
| 接口 | /api/sameday-judgment/records（短期，server.js:471）、/api/market-tech/records（:747）、/api/tech-face/records（:225）、/api/sentiment-accuracy/records（:268）；结算 POST 各 /settle（:531/:757/:256/:278） | server.js |
| 前端 | accuracy.html（四 tab）、judgments.html（存储值 vs 重算核对） | public/accuracy.html；public/js/accuracy.js；public/js/judgments.js |
| 调度 | 15:30 盘后结算 + 自学习复核（server.js:2191-2262）；事件扫描四槽位（:2266-2291） | server.js |

> ⚠️ **无独立 `/api/accuracy` 或 `/api/judgments` 路由**：两页均复用既有 records 接口。

## 五、降级 / 容错 / 诚实性设计

- **旧 schema 强制重算**：复用门控 `schemaVersion===SCHEMA_VERSION` 防止旧结论静默复用（sameDayJudgment.js:2166）。但⚠️ 反面风险：改因子结构但**忘升 LAYOUT_VERSION** → 哈希不变 → 旧记录被判「同 schema」永久复用（记忆铁律已记此坑，test_schema_version_guard.js 防御）。
- **长期判断不核算**：`longTermJudgment.js:12` 明确「不落盘、不核算准确率」，每次打开自动重算——长期判断无准确率台账（设计决策，非 bug，但 accuracy.html 无长期 tab）。
- **启动兜底**：服务未常驻时 `settleAll()` 仅补跑一次（server.js:2413-2435），长期 pending 风险（J15/J16 同记）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **⚠️ LEARN_MIN_SAMPLE 三值矛盾（跨模块）**：同一常量名 `LEARN_MIN_SAMPLE` 在三处取值不同——短期判断=5（sameDayJudgment.js:1200）、首页情绪=20（marketEmotionModel.js:68）、舆情拐点=15（sentimentTurningPoint.js:39）。若首页情绪模块文案写「20」而短期判断自学习代码值为「5」，确为跨模块矛盾（短期判断 J4/J5 同记）。需统一语义或改名区分。
- [ ] **⚠️ 长期判断无准确率闭环**：longTermJudgment.js:12 不落盘不核算，accuracy.html 无长期 tab——若用户期望「长期判断也进准确率台账」，当前实现缺口。
- [ ] **⚠️ 结算依赖 15:30 任务在线（J15/J16）**：漏跑则短期判断长期 pending；启动兜底仅一次，跨多日停机仍堆积。
- [ ] LAYOUT_VERSION 手工升版易漏：因子结构哈希不捕获「展示/口径类变更」，必须手动 +1（sameDayJudgment.js:1196 长注释）；是否纳入发布 checklist？
- [ ] computeAccuracy 在 total=0 时返回 null（sameDayJudgment.js:2074）：前端对 null 是否显示「暂无结算数据」而非 NaN/空？
- [ ] 震荡判定阈值 1.0% 与大盘技术 0.5%（home-03）、短期判断 J2 记的 1.0% 是否一致？跨模块口径需对齐。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| SCHEMA_VERSION | 'h'+因子哈希+'-'+LAYOUT_VERSION | sameDayJudgment.js:1197 |
| LAYOUT_VERSION | '20260922c'（手工 +1） | sameDayJudgment.js:1196 |
| LEARN_MIN_SAMPLE（短期） | 5 | sameDayJudgment.js:1200 |
| LEARN_MIN_SAMPLE（情绪） | 20 | marketEmotionModel.js:68 |
| LEARN_MIN_SAMPLE（舆情拐点） | 15 | sentimentTurningPoint.js:39 |
| APP_VERSION（缓存破坏戳） | 20261016a | server.js:98 |
| 结算槽位 | 15:30（每分钟检查） | server.js:2200,2261 |
