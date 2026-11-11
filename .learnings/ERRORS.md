# ERRORS.md — 命令/操作/集成失败记录（self-improving skill）

> 格式见 self-improving skill：ERR-YYYYMMDD-XXX + Summary/Error/Context/Suggested Fix/Metadata。
> 修复后把 Status 改 resolved 并补 Resolution 块。

## [ERR-20261020-001] sentiment_accuracy_weekend_basedate_stuck

**Logged**: 2026-10-20T03:50:00Z
**Priority**: high
**Status**: resolved（20261020a 三处修复完成，用户 2026-10-20 确认「按完整三步修复」）
**Area**: backend

### Summary
市场情绪提醒准确率台账（data/sentiment-accuracy/）出现「基准日落非交易日 → 记录永久卡在待结算」：2026-10-18（周日）留档的预测 baseDate=2026-10-18，上证指数日 K 无此日线，settleRecord 找不到基准日 K 线（baseIdx=-1）直接 return，任何重启/定时结算都无法结算，台账「已结算数」永久少于「已记录数」。用户 2026-10-20 截图报障「结算的数量比预测的数量少太大」。

### Error
```
rec: 2026-10-18 -> 2026-10-19 dir: 跌
hist bars: 321 | last 3 dates: 2026-10-16, 2026-10-19, 2026-10-20
has 10-18 bar: false | has 10-19 bar: true
after settleRecord: settled = false | actualDir = undefined
```

### Context
- 触发链：周日下午首页调 /api/sentiment-turning-point → buildHomeMarketEmotion → computeMarketEmotion 内 `rec.baselineDate = bars.length ? bars[bars.length-1].date : today`（marketEmotionModel.js:832）——本机东财/网络瞬时失败（logs 满屏 socket hang up）致 index bars 为空 → baselineDate 兜底为 today=2026-10-18（周日）→ server.js:942 以 `{ baseDate: emo.baselineDate }` 留档 → sentimentAccuracy 写 baseDate=2026-10-18、targetDate=nextTradingDay=2026-10-19。
- settleRecord（sentimentAccuracy.js:131）只有 targetDate 防呆（20261013f：目标日撞休市日则重算），**baseDate 侧无防呆**；`hist.findIndex(h => h.date === rec.baseDate)` 找不到周日线 → -1 → return rec，永久 pending。
- 佐证：marketEmotionModel 自己的 records.json 同日记录 baselineDate=2026-10-16（后一次成功调用 upsert 修正），证明周日数据基准确是上一个交易日 10-16；且 10-16 留档（已结算）与 10-18 留档预测目标同为 10-19、方向同为跌——10-18 记录是纯 bug 产物，无独立信息。
- 影响面：每个周末只要发生「页面访问 + 日线通道瞬时失败」就会复造一条卡死记录；当前台账 18 记录/15 结算/3 待结算，其中 10-18 为卡死，10-19（目标 10-20 今日交易中）与 10-20（目标 10-21 未来）为正常待结算。

### Suggested Fix（待用户确认后实施）
1. **结算侧防呆**（lib/sentimentAccuracy.js settleRecord）：baseDate 非交易日时回滚上一个交易日（`previousTradingDay`，cnTradingCalendar 已导出，sameDayJudgment:211 有 wrapper），与 targetDate 防呆对称；修后 settleAll 可自愈旧卡死记录。
2. **留档侧防呆**（lib/sentimentAccuracy.js recordDailyJudgment）：`meta.baseDate || localDate()` 之后，非交易日回滚 previousTradingDay——周末调用的数据基准本就是上个交易日，回滚后与既有留档幂等去重（prev.settled 早退），不再产生卡死记录。
3. **存量卡死记录**：建议删除 data/sentiment-accuracy/2026-10-18.json（与 10-16 记录同数据基准、同预测目标、同方向，属重复计数）；或保留待修复 1 自动补结算（会重复计一次未命中）。

### Resolution（20261020a 已实施）
1. 结算侧：`settleRecord` 基准日比对改走新增纯函数 `resolveBaseDate`（非交易日→previousTradingDay 回滚，空值透传）；不变量 `nextTradingDay(d)==nextTradingDay(previousTradingDay(d))` 由测试锁定，目标日不受影响。
2. 留档侧：`recordDailyJudgment` 同样回滚，并追加保护——**回滚而来的记录不得覆盖回滚目标日的既有留档**（实证 10-18 周日降级结论只剩融资余额单因子、indexValue 为 null，若允许覆盖会顶替 10-16 正常记录；原 Suggested Fix 的「幂等去重」仅防 settled 覆盖，此处加固）。
3. 存量：`data/sentiment-accuracy/2026-10-18.json` 已删除，台账回到 17 条。
- 验证：test_event_weight_sentiment_acc.js 新增 9 项防呆用例（resolveBaseDate 4 项 + 不变量 1 项 + 接线断言 1 项 + 留档功能实测 3 项，44/44 全绿）；全量回归 50/53（3 个在档旧失败零新增）；node 直调 settleRecord 复刻周日记录 `settled=true`（回滚 10-16 基准 3716.28 vs 10-19 目标 3730.92，+0.39% 震荡未命中）；磁盘台账 overdue=0。版本戳 APP_VERSION 20261020a + public 31 处。
- 附带发现（未修，用户批准另开一轮）：权重自学习「当前样本不足」文案与实际不符——priceVolume 旧 key 28 样本不参与学习（不在 BASE_WEIGHTS）、volumePrice 新 key 仅 3 样本、indexMomentum/margin 已到 W_MAX=30 → learnLog 恒空。

### Metadata
- Reproducible: yes（node -e 调 settleRecord 实证，见上；零网络可复现路径：构造 baseDate=周日的 rec）
- Related Files: lib/sentimentAccuracy.js, lib/marketEmotionModel.js, server.js, data/sentiment-accuracy/2026-10-18.json
- Tags: sentiment-accuracy, weekend-baseline, stuck-settlement, degrade-fallback
- Pattern-Key: backend.accuracy_ledger_nontrading_basedate
- Recurrence-Count: 1
- First-Seen: 2026-10-18
- Last-Seen: 2026-10-20

## [ERR-20261104-001] llm_temperature_unsupported_model

**Logged**: 2026-11-04T16:10:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
用户把联网模型换成 kimi-k3 后，所有 AI 功能（首页 AI 解读等）报 400：`InternalError.Algo.InvalidParameter: Parameter 'temperature'=0.3 is not supported for kimi-k3 model`。

### Error
```
<400> InternalError.Algo.InvalidParameter: Parameter 'temperature'=0.3 is not supported for kimi-k3 model.
```

### Context
- lib/ai/llm.js buildRequestBody 对所有模型硬编码 `temperature: 0.3`（阿里百炼 DashScope Kimi 系模型不接受采样温度参数）
- 既有 400 兜底（去掉 enable_search 重试）条件要求请求体带联网参数，本例无 → 错误直抛前端 alert

### Suggested Fix
① buildRequestBody 对 kimi 系模型（isNoTemperatureModel：名以 kimi- 开头）预判剔除 temperature；
② postLLM 能力自学习补第三分支：400 + temperature + not supported/InvalidParameter → 记忆 NO_TEMPERATURE_MODELS + 剔除重发（首见即记忆，进程内 Set）。

### Resolution
- **Resolved**: 2026-11-04T16:10:00+08:00
- **Notes**: 版本 20261104c；守卫 test_llm_stream_fallback 扩 §F（桩服务验证 400→剔除重发→记忆零请求浪费）；真实 E2E：kimi-k3 AI 解读 42.8s 返回完整内容。
- **通用教训**：LLM 网关「参数不兼容」类报错应统一走能力自学习层（stream/enable_search/temperature 三维度），新增硬编码参数前先确认目标模型白名单；**See Also**: 源码 lib/ai/llm.js 20260918b 注释块。

---

## [ERR-20261104-002] back_to_top_window_scroll

**Logged**: 2026-11-04T17:45:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: frontend

### Summary
「回到顶部」按钮点击无反应：app.js 绑定 window.scrollTo({top:0})，但 Stock Analyzer 的 html/body 为 overflow:hidden（style.css 105 行），window 从不滚动，页面真正的内容滚动容器是 <main class="main-content">（overflow-y:auto）。

### Error
```
无 JS 报错——scrollTo 调用成功但作用于从不滚动的 window，用户感知为「点击后没有反应」
```

### Context
- 20261104f 新增 #backToTopBtn 绑定 window.scrollTo
- 页面布局：body flex（sidebar + .main-content），滚动发生在 .main-content

### Suggested Fix
滚动目标必须是实际 overflow-y:auto 的容器：document.querySelector('.main-content').scrollTo({top:0,behavior:'smooth'})，window.scrollTo 仅作容器缺失兜底。

### Resolution
- **Resolved**: 2026-11-04T17:48:00+08:00
- **Notes**: 20261104g 修复绑定目标；教训=**该布局下任何「滚到顶/滚到底/锚点定位」类功能都必须作用于 .main-content 而非 window**（同类排查点：shares 跳转、图表定位、锚点高亮等）

### Metadata
- Reproducible: yes
- Related Files: public/js/app.js, public/css/style.css
- Pattern-Key: frontend.scroll_container_not_window

---

## ERR-20261104-003
**Date**: 2026-11-04
**Severity**: medium
**Status**: resolved
**Area**: engine

### Symptom
威高血净 603014 专属估值模型 E2E：`POST /api/ai/valuation` 返回 200 但响应无 `weigao` 专属字段，服务日志出现「[AI 估值] 603014 已注入财报解读摘要（复用已检索数据，免重复上网）」——标的掉进通用 LLM 流程而非专属确定性分支。

### Root Cause
专属模型接线四处、只接了三处：`hasDedicatedValuation()` 闸门 / `conclusion.js` / `app.js` 均已接线并通过静态断言，但 `analyzeValuation()` 主体的**逐标的内联执行分支**遗漏——闸门函数只供前端判断免 API Key，不参与服务端执行分流。

### Resolution
- **Resolved**: 2026-11-04T19:40:00+08:00
- **Notes**: `lib/ai/valuation.js` 万润分支后补 weigao 内联分支（getQuote→run→return DEDICATED）；守卫新增第四处接线断言 + E2E 断言 `ver:'DEDICATED'`。修复后 804ms 确定性返回。教训归档 LRN-20261104-004（dedicated_model_four_point_wiring）。

### Metadata
- Reproducible: yes
- Related Files: lib/ai/valuation.js
- Pattern-Key: engine.dedicated_model_missing_inline_branch

---

## ERR-20261104-004
**Logged**: 2026-11-04T19:55:00+08:00
**Severity**: medium
**Status**: resolved
**Area**: frontend

### Summary
基金行业配置名单（homeRank.js）向下浏览时自动回弹到名单前面。

### Error
```
无报错——行为缺陷：分批更新期间（q.published && !q.done）每 3 秒轮询 →
render() 无条件 body.innerHTML 全量重建（状态条+KPI+20 行表格）→
浏览器滚动锚定 anchor 落在被销毁子树内失效 → .main-content 滚动位置回弹。
```

### Context
- 东财 2026Q3 分批披露期间轮询常开（每日 19:00 检查、批次跨日推进）
- 轮询中大多数轮次数据未变，重建纯属打断浏览
- 滚动容器=.main-content（20261104g 口径），列表非独立滚动容器

### Suggested Fix
已实施（20261104j）双保险：① dataSig 数据签名比对（未变轮次跳过重建）；② 重建时滚动锚定恢复（重建前记录 .fmr-table-wrap 相对视口 top，重建后差值校正回 .main-content.scrollTop）；手动刷新强制重建保留视觉反馈。

### Metadata
- Reproducible: yes
- Related Files: public/js/homeRank.js
- See Also: ERR-20261104-002（滚动容器=.main-content 同源教训）

---

## ERR-20261104-005
**Logged**: 2026-11-04T21:40:00+08:00
**Severity**: medium
**Status**: fixed
**Area**: data-caliber

### Summary
威高血净页右卡「指标分析」毛利率同比显示 41.47%（去年同期 43.89%），左卡毛利率显示 37.78%——用户报「毛利率的数据不一致」。

### Error
```
主值 cur = val('grossMarginTtm') → TTM 口径 37.78%
同比 yoy = samePeriodPair(zyzb,'XSMLL') → 报告期累计口径 41.47%/43.89%
环比 qoq = consecutivePair(zyzb,'XSMLL') → 累计口径 37.88%
同一张卡三套数字两个口径，note 口径解释句无法阻止用户误读为数据错误。
```

### Context
- computeTtmMetrics 是 TTM 单一权威源，但当时只产出本期值（+ROE 的 roePrev）
- ROE 同比已有 TTM 同口径范式（roeTtmPrev 优先）但毛利率/净利率未跟进
- 20261104b 增长口径切换只覆盖成长类指标，水平型比率指标未覆盖环比同口径

### Suggested Fix
已实施（20261104k）：computeTtmMetrics 抽 marginsOf helper 补三套 TTM 窗口（本期/去年同期/上一报告期），metricAnalysis 三指标（毛利率/净利率/ROE）同比+环比维度 TTM 同口径优先、累计回退；note 改「与左卡数值完全一致」。守卫 test_margin_caliber_rename.js（46 断言，含数值复算 + 端到端文案 + 哨兵回退）。

### Metadata
- Reproducible: yes
- Related Files: lib/stockData.js, lib/metricAnalysis.js
- See Also: LRN-20261104-006

---

## ERR-20261106-001
**Logged**: 2026-11-06T15:45:00+08:00
**Severity**: high
**Status**: fixed
**Area**: frontend

### Summary
20261106g 纯 CSS「对称化」把五步判定链的中文徽标压成竖排单字，用户截图判定「界面优化完全失败」。

### Error
```
用户截图「屏幕截图 2026-11-06 153824.png」（士兰微 600460）：
「运行状态 · 五步判定链」下方的「道氏结构 / ADX 强度 / 均线排列 / 箱体量化 /
量价健康度」被拆成逐字竖排的一列，5 行内容左边界错乱、整块判定链不可用。
对照 15:21 截图（g 版尚未加载）一切正常 → 崩坏由 g 版 CSS 引入。
```

### Context
- 真实 DOM 是 `public/js/app.js:2614-2615`：
  `<div class="ve-posj-chain-item"><span class="ve-rule-badge">${s.k}</span><span class="ve-posj-chain-text">${s.v}</span></div>`。
  `s.k` 来自 `lib/volumeEngine.js:1829-1833` 的 `_runState` steps，值是
  `① 道氏结构 / ② ADX 强度 / ③ 均线排列 / ④ 箱体量化 / ⑤ 量价健康度`——**中文标签，不是 28px 圆形数字徽标**。
- g 版按类名想当然，写 `.ve-posj-chain-item { display:grid; grid-template-columns: 28px minmax(0,1fr) }`，
  28px 只放得下一个汉字 → 中文逐字换行竖排。
- **验证是假阳性**：g 版用 Edge 无头渲染「复刻页」截图两轮，但复刻页里徽标用了短数字，
  与真实 DOM 不一致，所以两轮截图都没抓到 bug；守卫 `test_posj_symmetry.js` 只断言 CSS 字符串 /
  生效值，既没断言真实 DOM 的子元素内容，也没做含真实文案的浏览器渲染。
- 另一次生问题：守卫断言「旧字符串不存在」与「末尾覆盖块」设计自相矛盾，改了两次才通过，
  进一步说明只测 CSS 文本、不测真实渲染不可靠。

### Suggested Fix
已实施（20261106h）：整块撤销 g 版覆盖规则，恢复 20261105f-b 的 flex 基线；只保留三处零风险修正——
① `.ve-posj-chain` 去掉单侧 `margin-left:140px` 使左右边界与三步骤/警示/主判/参考表对齐；
② `.ve-posj-chain-item > .ve-rule-badge { flex:0 0 96px; white-space:nowrap }` 让 5 行文字起点统一，
   并永久防止中文标签被压窄（96px 足够容纳「⑤ 量价健康度」）；
③ 窄屏说明文字 `flex:1 1 100%` 独占整行，消除右侧裁切。
复刻页改用**与 app.js 一字不差的中文标签**，宽屏 1100px / 窄屏 420px 双视口截图逐张目检确认。

### Metadata
- Reproducible: yes
- Related Files: public/css/style.css, public/js/app.js, lib/volumeEngine.js, scripts/test_posj_symmetry.js
- See Also: LRN-20261106-003
- Pattern-Key: frontend.css_assume_dom_children_by_classname
- Recurrence-Count: 1
- First-Seen: 2026-11-06
- Last-Seen: 2026-11-06

---

## [ERR-20261109-001] akshare_import_pandas_dll_blocked

**Logged**: 2026-11-09T12:51:54+08:00
**Priority**: medium
**Status**: pending
**Area**: infra / tests

### Summary
在 Bash 工具里执行 `python -c "import akshare as ak; ..."` 失败：`pandas` 的 C 扩展 DLL 被「应用程序控制策略」拦截，无法 import。但 3005 服务能正常取到两融数据（卡片显示 22710 亿），说明服务进程使用的 Python/环境不受该策略影响 —— 是**工具沙箱环境问题，不是项目代码或数据源故障**。

### Error
```
ImportError: DLL load failed while importing offsets: 应用程序控制策略已阻止此文件。
  File "pandas/_libs/tslibs/conversion.pyx", line 1, in init pandas._libs.tslibs.conversion
（触发链：akshare.__init__ → pandas → pandas._libs.tslibs）
Python: C:\Users\16507\.workbuddy\binaries\python\versions\3.13.12\python.exe
```

### Context
- 目的：实证 akshare `macro_china_market_margin_sh/sz()` 是否返回「融券余额」列（FEAT-20261109-002 前置数据可用性核查）。
- 环境：WorkBuddy Bash 工具，非交互；`python` 解析到 WorkBuddy 自带 3.13.12。
- 服务侧：`lib/marketEmotionData.js::runScript()` 通过 `findPythonForScript()` 选解释器，子进程方式调用 `scripts/market_emotion.py`，线上正常。

### Suggested Fix
不必修环境。改用**两步纯文本/HTTP 实证**绕过：① 直接读 akshare 源码取列名定义（`macro_china.py:900-907 / 931-939`）；② 用 Node `https` 直连上游 `cdn.jin10.com/data_center/reports/fs_1.json` / `fs_2.json` 拉真实数值校验。两步都已成功，结论：融券余额列存在且数值可用（2026-11-05 沪深合计 288.11 亿）。
若将来确实需要在本工具内跑 Python 脚本，优先尝试服务侧解释器或让服务自身暴露诊断接口，不要在 Bash 里硬试。

### Update（2026-11-09 / 20261109a，已找到纯标准库绕过法）
本轮 FEAT-20261109-002 落地时需要**真正执行** `fetch_margin()` 的列解析逻辑，环境限制仍在，但已用不依赖 pandas 的方式完整实测：
- `ast.parse()` 读 `scripts/market_emotion.py`，提取 `fetch_margin` 内的两个嵌套函数 `_to_map` / `_series`，`compile` 后在注入 `to_float` 的命名空间里 `exec`；
- 用 `urllib.request` 直连 `cdn.jin10.com/data_center/reports/fs_1.json` / `fs_2.json`（沙箱允许），把 `values` 转成只有 `columns/iterrows/__len__` 的 stub DataFrame；
- 结果：融资 22709.8 亿 / 5日 −3.33% / 2026-11-05，融券 288.11 亿 / 5日 +2.08% / 2026-11-05；并验证误取「融资融券余额」列会得到 11992.4 亿（陷阱可观测）。
**结论**：pandas 被拦只影响 `import akshare`，不影响验证「本项目自己写的解析函数」。凡 Python 侧纯逻辑改动，优先用 ast 提取 + stub 依赖的方式做离线/半在线实测，不要因为环境报错就跳过验证。环境本身未修（服务端解释器正常，无需修）。

### Metadata
- Reproducible: yes
- Related Files: scripts/market_emotion.py, lib/marketEmotionData.js:201-214
- See Also: FEAT-20261109-002
- Pattern-Key: infra.sandbox_python_dll_policy

---

## [ERR-20261110-001] 龙虎榜 T+1 仍显「缺失」：取数时点早于盘后发布 + 一次性落盘无回补

**Logged**: 2026-11-10T11:49:18+08:00
**Priority**: high
**Status**: resolved（20261110a 已实施并通过 43 项守卫；用户裁决「晚间 + 次日双槽」并入每日复盘全量替换规格）
**Area**: backend

### Resolution（2026-11-10 12:50 实施）
用户后续给出「每日复盘全量替换」长文本规格，第三部分把修复方案固化为 15:35 formal / 20:30 补录 / 次日 15:35 兜底，替代了本条目里的方案 A（T+1 早间 08:30 全量重跑）。实际落地：
- `lib/reviewService.js` 新增 `backfillDragonTiger()` / `needsBackfill()` 与 `formal → complete` 状态机；补录只重抓当日龙虎榜（不重跑 13 源、不重算其余段落），只替换第八段与第十段，同一日期 complete 幂等唯一、接口抖动不降级。
- `lib/boardReviewData.js` 新增 `getLhbOnly()`（不写缓存、补录前 `clearCache()`）；`scripts/board_review_data.py` 新增 `--lhb-only` 且空结果 `ok` 保持 True 以便把诚实 note 送回 Node。
- `server.js` `REVIEW_SLOTS` 增加 20:30 补录槽；15:35 主跑前先检查昨日 `needsBackfill()`；`POST /api/review/backfill` 与 `task_type="dragon_tiger_update"` 两种触发入口。
- 误导性 note 已改为「龙虎榜为盘后延迟发布数据：当前时点尚未发布…标注『待晚间补录』」；输出层把 15:35 未发布与「数据缺失」分开标注。
- **反向实证**：`python scripts/board_review_data.py --date 20261109 --lhb-only` 返回 `lhb.ok=true, count=67`，证明 11-09 数据本就存在，只是 15:35 取早了。
- 守卫 `scripts/test_daily_review.js` 新增 [2b] 6 个状态机用例（formal / pending / completed / 幂等 / task_type 路由 / 不降级），43 项全过。

### Summary
每日复盘在收盘后 15:35 抓龙虎榜，而东财龙虎榜明细是**盘后晚间才发布**；取到空结果后被写进当天复盘快照并判定为「完整正式版」，此后**既无次日回补、也无按源重取**，导致第二天打开工作台龙虎榜仍停在「缺失」。不是接口故障、不是计算错误。

### Error
```
页面「数据源」表：龙虎榜模块 | 资金/龙虎榜模块 | 失败 | 缺失 | 数据时间=缺失
获取时间 2026-11-09T07:35:56.226Z（= 北京 15:35:56）
缺失原因：当日龙虎榜明细无数据（非交易日或接口不可用），本项标注「缺失」

落盘 data/reviews/2026-11-09.json：
generatedAt 2026-11-09T07:36:08.203Z（= 北京 15:36:08）
completeness.score=94, limited=false, missing=[{key:'dragonTiger', reason:'当日龙虎榜明细无数据…'}]
```

### Context
- 用户报障原话：「龙虎榜数据是当天晚上才更新，但是到了第二天工作台还没有数据，应该是获取数据的机制出现问题。」
- **决定性对照实验**（2026-11-10 上午用工作台 Python `akshare 1.18.94` 实测）：
  - `stock_lhb_detail_em(start_date='20261109', end_date='20261109')` → **67 行**
  - `stock_lhb_detail_em(start_date='20261106', end_date='20261106')` → 79 行
  - 即 11-09 数据已正常发布、接口可用。
- **历史复盘对照**：`data/reviews/2026-11-06.json`（generatedAt 2026-11-08 16:45，隔日生成）dragonTiger=`ok`、完整度 100；`2026-11-09.json`（当天 15:36 生成）dragonTiger=`failed`、94。同一套代码，仅生成时刻不同 → 排除接口/算法故障，坐实「时点」问题。
- 完整机制链（四段，缺一不可）：
  1. `server.js:2510-2514` `REVIEW_SLOTS` = 15:35 主跑 + 15:40/45/50 补跑，**是唯一自动取数窗口**，且只传 `date: today`。
  2. `scripts/board_review_data.py:679` `ak.stock_lhb_detail_em(start_date=d, end_date=d)` 只查复盘日当天；15:35 尚未发布 → 空 → `:282` `build_lhb` 返回 `ok:false` + 误导性 note「非交易日或接口不可用」（真实原因是「尚未发布」）。
  3. `lib/reviewService.js:186` `block.ok === false` → throw → `collect` 标 `status:'failed'`；`runReview` 15:36 把整份快照 `writeReviewSync` 落盘（94 分 / limited:false）。
  4. `server.js:2545-2552` 补跑判定 `completeness.score >= 90 && !limited` → **94 ≥ 90 直接跳过三个补跑槽**；即便跑，15:50 数据仍未发布。`getToday()/getByDate()` 纯读盘不重取；全代码库无按历史日期的 review 回补（grep `backfill|回补|T+1` 只命中板块拥挤度/ETF/分红，均非复盘）。
- 次要因素：`lib/boardReviewData.js:23` `CACHE_TTL=10min` 只影响同进程内复用，不是跨天主因。
- 违反项目三条底层规则之「数据最新性（按类型 TTL + 交易日感知 + 过期标注）」：龙虎榜属**盘后延迟发布型**数据源，却与涨停池共用 15:35 单一窗口；跨天后旧快照未标注「龙虎榜未在发布窗口内取到」。

### Suggested Fix
待用户确认后实施，勿擅改既有代码（用户铁律：修既有代码前必须核实）：
- **方案 A（推荐，隔离/新增机制）**：新增 T+1 早间回补槽（如次日 08:30），扫前一交易日已落盘且 `dragonTiger.status==='failed'` 的复盘，仅对缺失源重取后走 `runReview` 修订版逻辑生成 v2。94→100 为升分，符合现有「不得用更差数据覆盖」保护（`reviewService.js:902-906`）。
- 方案 B：把龙虎榜主跑后移到晚间 19:30 单独一次；会改变整份复盘生成时刻，影响面大。
- 方案 C：路由层懒回补 —— 读档发现 `failed` 且已过发布窗口时按日期触发重取。
- 方案 D：仅修正 note 文案与过期标注（诚实性），不解决数据缺失。
- 无论选哪个，须把 note 从「非交易日或接口不可用」改为「盘后数据尚未发布」，并给龙虎榜单独的类型 TTL / 就绪时刻。

### Metadata
- Reproducible: yes（每个交易日 15:35 必现）
- Related Files: server.js:2510-2562, lib/reviewService.js:117-133/182-191/794-805/846-905/1012-1030, lib/boardReviewData.js:23-106, scripts/board_review_data.py:272-283/655-702, data/reviews/2026-11-09.json
- See Also: LRN-20261110-001
- Tags: 盘后延迟发布, 取数时点, 一次性落盘, 无回补, 补跑阈值, 数据最新性, 按类型TTL, 诚实标注
- Pattern-Key: data.late_publish_source_needs_t1_backfill
- Recurrence-Count: 1
- First-Seen: 2026-11-10
- Last-Seen: 2026-11-10

---
## [ERR-20261110-001] stockReview LLM 超时降级

**Logged**: 2026-11-10T21:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
个股每日复盘首次实测 LLM 180s 超时，降级为数据快照。

### Error
```
AI 生成暂不可用（LLM 调用失败：大模型请求超时（180000ms 无响应））
```

### Context
- 首版 Context 含 quoteHub.analysis/shortTerm 序列统计 + capital recent10Flow，体积偏大
- 每日复盘同链路（reviewLlm.js）实测大 Context 会逼近 240s，已用 300s

### Suggested Fix（已实施）
Context 瘦身（hub 只留 latest 五要素；recent10Flow→recent5Flow 且只留 date+mainNet亿；news 12→10）→ 实测 Context ≈3.2KB；TIMEOUT_MS 180s→300s 对齐每日复盘。

### Resolution
- **Resolved**: 2026-11-10T21:50:00+08:00
- **Notes**: test_stock_review.js 46/46；套件复跑 129/130

---

## [ERR-20261110-002] stockReview 数据单位/字段名三连错（快照表格数值错误）

**Logged**: 2026-11-10T21:45:00+08:00
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
首版快照：成交额显示 raw 元（269790000 误标「亿」）、换手率「-」（字段名错）、前日成交额「-」（通道选错）。

### Error
```
换手率/成交额(亿) → "- / 269790000"；前一交易日成交额(亿) → "-"
```

### Context
- 实时行情（qt.gtimg.cn）字段实为 `turnover`（换手率%），不是 turnoverRate；`amount` 单位是**元**
- `getHistory()` tencent 通道的 bar **没有 amount/turnover 字段**；含成交额的历史通道是 `fetchEastmoneyHistory`（bar = {date,open,close,high,low,volume,amount(元),turnover(%)}）

### Suggested Fix（已实施）
amount/1e8 转亿；换手率改读 q.turnover；前日成交额/换手率改从 fetchEastmoneyHistory(symbol,6) 取 date<今日 的最近一根。

### Resolution
- **Resolved**: 2026-11-10T21:50:00+08:00
- **Notes**: 运行时实测 000783：amountYi=2.7、prev={2.55, 0.66%}

---

## [ERR-20261110-003] 快照 [object Object] 与板块 raw JSON dump

**Logged**: 2026-11-10T21:45:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: backend

### Summary
资金摘要渲染出 "[object Object]"；板块联动整包 JSON 倾倒（含 ok:false 全 null 字段）。

### Error
```
资金摘要 → [object Object]
板块联动 → {"source":"东方财富涨跌停池 + 同花顺行业板块","ok":false,"industryName":null,...}
```

### Context
- analyzeCapitalFlow 的 moneyFlow.summary 是**双层嵌套** { summary:{'5d':{mainNet,direction,...}}, recent5:[...] }
- getSectorLimitStats 行业识别失败时不 throw，而是返回 ok:false + 全 null 字段

### Suggested Fix（已实施）
代码拆双层取 '5d'/'10d'/'20d' mainNet+direction 拼可读字符串（注意 direction 已含「净」字，勿再拼接）；sector 判 ok:false → `{missing:true, note}`，快照按字段渲染绝不 JSON.stringify 整包。

### Resolution
- **Resolved**: 2026-11-10T21:55:00+08:00
- **Notes**: 实测 "5日主力净流出 0.69 亿；10日…；20日…"；守卫新增 4 条回归断言（无 [object Object]/无 {" dump/亿单位/换手率%）
