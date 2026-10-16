# 💹 资金量能（九项热度评分）· 反向逻辑说明

> 逻辑模型位置：个股页 → 「💹 资金量能」Tab（评分卡 + 量价信号/资金流向/量能指标/融资融券/综合判断）
> 实现文件：`public/js/app.js:2038-2053, 3185-3231`（`loadCapitalFlow` / `renderCapitalScore`）、`public/js/capitalCharts.js:34-493, 516-661`（`CapitalCharts`）、`lib/capitalFlow.js:564-828`（`computeCapitalConclusion`）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 评分卡 `#capitalScore` | `conclusion.score`（0-100）+ `#capitalScoreDetail`（等级），由 `renderCapitalScore` → 优先复用后端 `conclusion.score`，缺失才跑前端镜像 | app.js:2038-2053；capitalCharts.js:520-536 |
| 量价信号卡 | `vp.signal/description/dayChangePct/dayVolRatio/upDays/downDays/ratio/netChangePct/heatLevel` | capitalCharts.js:52-100 |
| 资金流向图 | 主力/超大·大单/中单/小单（亿元，估算带徽标） | :102-183 |
| 资金流汇总表 | 近5/10/20/60日主力净额 | :185-217 |
| 量能指标卡 | **OBV / VR / MFI / 5·10·20日均量 / 量比 / 换手率**（MFI 展示但不计分） | :219-248 |
| 图：OBV/VR/成交量 | — | :250-321 |
| 融资融券图+汇总 | `renderMargin` / `renderMarginSummary` | :323-407 |
| 综合判断 | `renderConclusion` 复用后端 `conclusion` | :409-493 |
| 计算依据面板 | `buildScoreTrace('capital')` | app.js:6284-6311 |
| 加载触发 | 切到该 tab 调 `/api/capital-flow/:symbol?name=...`，每 60s 静默刷新 | app.js:3185, 6684 |

## 二、核心公式 / 判定链

后端 `computeCapitalConclusion(data)`（capitalFlow.js:649）；`analyzeCapitalFlow` 调用并透传（:564-569）。

- **起点**：`score = 50`（热度，方向无关）；`dirScore = 50`（方向，供 signal）（:658-659）。
- **九项加减分**（全部进 `score`，方向另计 `dirScore`）：
  1. 量能（交易量）`HEAT_MAP`（:665-667）：显著放量 +13 / 温和放量 +8 / 量能平稳 0 / 缩量 −6 / 地量 −10；方向经 `VP_MAP` 进 `dirScore`（:674-680）。
  2. 近5日主力净流 `flowScoreByRatio(ratio,15)`（:687-701，分档 :639-647）。
  3. 近20日主力净流 `flowScoreByRatio(ratio,10)`（:703-718）。
  4. OBV 趋势 ±6（:721-722，同时进 dirScore）。
  5. VR 信号 ±4（含"多"+4 / 含"空"−4，:723-724）。
  6. 融资余额变化 ±6（:729-743）。
  7. 融券余额变化 ±6（增加=做空=**取负**，:744-758）。
  8. 融资余额占比（存量杠杆）`rzRatio>5 +4 / >2 +2`（:759-764，只加热度）。
  9. 换手率（相对月均）`≥2.0× +5 / ≥1.5× +3 / <0.5× −3`；无月均退回绝对阈值（:767-782）。
- **clamp**：`score = Math.max(0, Math.min(100, score))`（:784）。
- **多空打分**：`bullScore/bearScore` 独立累加（:787-806）；`signal = clamp((dirScore-50)/50, -1, 1)`（:812，仅方向）。
- **综合 label**：按 `bullScore-bearScore` 分档（:813-818）。
- **等级 grade**：`≥80 非常活跃 / ≥65 活跃 / ≥45 中性 / ≥30 低迷 / 其余 极度低迷`（:820-825）。

前端镜像 `CapitalCharts.calculateScore`（capitalCharts.js:516-661）：**优先复用后端 `data.conclusion.score`**（:520-536），缺失才跑本地九项（:543-651）。

## 三、指标 / 因子口径

| 指标 | 参数 | 定义/阈值 | 是否进 score | 出处 |
|---|---|---|---|---|
| 量能热度 | HEAT_MAP | 显著放量+13/温和+8/平稳0/缩量−6/地量−10 | 是 | capitalFlow.js:665-667 |
| 主力净流(5日) | flowScoreByRatio | >0.5%满分/>0.2%×0.66/>0×0.33 | 是 | :639-647, 687-701 |
| 主力净流(20日) | 同上 ratio,10 | 权重 10 | 是 | :703-718 |
| OBV | 近5/20均值趋势 | 上升+6/下降−6 | 是 | :207-216, 721-722 |
| VR | 周期26 | >200多/>120偏多/<70空/<80偏空 | 是(±4) | :218-230, 425-430, 723-724 |
| 融资变化 | 占市值比 | ±6 | 是 | :729-743 |
| 融券变化 | 占市值比 | 增加=做空=取负 ±6 | 是 | :744-758 |
| 融资占比 | 存量 | >5 +4 / >2 +2 | 是 | :759-764 |
| 换手率 | 相对近22日月均 | ≥2.0×+5/≥1.5×+3/<0.5×−3 | 是 | :364-390, 767-782 |
| **MFI** | 周期14 | >80超买/>50流入/<20超卖/<40流出 | **否（仅展示）** | :232-247, 431 |
| ADX | — | 未接入 | 否 | analysis.js:251-303 |

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 资金流向 | 东财 `push2his stock/fflow/daykline`（capitalFlow.js:45），axios 失败回退 curl（:60）；**API 不可用则 `estimateMoneyFlowFromHistory` 由 K 线量价估算**（标 `source:'estimated'`，:490-527, 549-553） |
| 融资融券 | 东财 `datacenter-web RPTA_WEB_RZRQ_GGMX`（:101），2 次重试/超时降级（:113-171） |
| 换手率序列 | `getEastmoneyTurnover`（东财历史，:540）→ stockData.js:1982；缺失退回绝对阈值 |
| 量能指标 OBV/VR/MFI/量比/均量 | 本地由 `history` 计算（`computeVolumeIndicators`，:198-484） |
| 流通市值 | quote.circulationValue/totalValue（腾讯行情，万亿/亿混编归一为亿元，:558-560） |
| 接口层 | `/api/capital-flow/:symbol`，15s 整体超时兜底，失败 500 {error}（server.js:1777-1804）。**无磁盘缓存，每次实时重算** |

> ⚠️ **重要澄清**：任务将"缓存复用 / noKey 写盘"列在 capitalFlow.js 下，但实际位于 **`lib/hotTopics.js`（近期热点·异动归因 `price-change.json`）**，与资金量能 tab 不是同一模块：版本门控 `CACHE_VER='20261013g'`（hotTopics.js:35）；缓存复用 4 条件（同日期+symbolName 一致+方向同号，:344-348）；未配 Key → `writeJSON` 写盘 noKey（:397-406）。资金量能 tab 自身**不写盘、不读盘缓存**。

## 五、降级 / 容错 / 诚实性设计

- **资金流向 API 失败**：用 K 线估算并如实标 `source:'estimated'`，前端资金流图/汇总显示"估算数据"徽标（capitalCharts.js:111-114, 194）；不冒充真实披露值。
- **融资融券无数据/超时**：`margin.hasData=false`，图表显示"暂无融资融券数据（可能非两融标的）"或"获取超时已降级跳过"（:326-330, 379-381）；评分中 `margin.hasData` 为 false 则该维度整体跳过（capitalFlow.js:727）。
- **换手率序列缺失**：退回绝对阈值（:776-781），注明"月均参考缺失"。
- **MFI 缺失**：仅 `mfiSignal` 显示 "--"，不影响计分。
- **失败时评分卡停在占位**：错误分支 return 前未调用 `renderCapitalScore`，`capitalScore` 保持初始 `'--'`（app.js:2021），`capitalScoreDetail='资金量能加载后更新'`（app.js:2023）。

## 六、逻辑漏洞自查清单（审计用）

- [ ] **#1【文案与实现矛盾】资金热度面板称综合"量能指标（OBV/VR/MFI）"但 MFI 不计分**：九项计分只含 OBV(+6)、VR(±4)，**MFI 计算并展示（:232-247, :431）却不参与任何加减分**；"MFI"仅出现在展示行与文案，误导用户以为其影响评分。
- [ ] **#2 资金量能"九项"前后端两份独立实现，漂移风险**：后端 `conclusion.score`（capitalFlow.js:649-828）vs 前端 `capitalCharts.calculateScore`（:516-661）。后端恒存在时前端兜底（:520-536）是死代码；一旦后端改名/改权重，前端镜像静默接管需人工比对，双份实现易漂移。
- [ ] **#3【一刀切】任何 error 一律附"仅支持 A 股"**：`loadCapitalFlow` 收到 `data.error` 时，无论成因（404 行情缺失 / 15s 超时 / 其它），统一渲染"资金量能分析目前仅支持A股市场"（app.js:3193-3196）；而后端 `/api/capital-flow` 并未限制市场（server.js:1782-1799 对任何 symbol 都尝试计算），对 A 股自身超时属**虚假归因**。
- [ ] **#4 失败/无数据时评分卡停在占位易误读**：`capitalScore='--'` 不动（app.js:2021, 3197-3199）；同时内容区被错误文案替换。技术面同理（app.js:2006），面板未被标记"数据不足"。
- [ ] **#5 热度注释"±15"与实现 HEAT_MAP 不符**：注释"±15"（:662）vs 实际 显著放量+13 / 地量−10，**最大 +13 非 +15**；文档 stock-02 也误写 ±15。注释与代码漂移。
- [ ] **#6 资金流估算回退冒充口径边界**：API 不可用时 `flowSource='estimated'`，`rules` 装饰器标"回退为K线量价估算"（:595-597），但 `conclusion` 评分仍用估算流；前端若忽略 source 徽标则误读为真实资金流。
- [ ] **#7 换手率缺失时退回绝对阈值，大小盘基准不一致**：月均序列缺失时换绝对阈值（>10% 高 / <1% 低，:776-781），与有月均时（相对自身）口径不同，可能造成同数值个股不同评分。
- [ ] **#8 量价方向 VP_MAP 与信号文案非一一对应**：`VP_MAP`（:674-680）含"量价温和偏多/温和偏弱"等键，但 `computeVolumeIndicators` 实际产生的 `volumePriceSignal` 取值集合（放量上涨/温和上涨/缩量上涨…）中并无上述键，映射缺失项按 0 计，属冗余/失效键。

## 七、可配置项

| 配置项 | 值 | 位置 |
|---|---|---|
| 起点 | score=50、dirScore=50 | capitalFlow.js:658-659 |
| HEAT_MAP | 显著放量+13/温和+8/平稳0/缩量−6/地量−10 | :665-667 |
| VP_MAP | 放量上涨+12 … 地量回调−1 | :674-680 |
| 主力净流分档 | >0.5%满分/>0.2%×0.66/>0×0.33 | :639-647 |
| OBV ±6 / VR ±4 / 融资 ±6 / 融券 ∓6 / 融资占比 >5+4/>2+2 | — | :721-764 |
| 换手率 | ≥2.0+5/≥1.5+3/<0.5−3；绝对退回 >10+5/>5+3/<1−3 | :767-782 |
| clamp / 等级 | score∈[0,100]；≥80/≥65/≥45/≥30 | :784, 820-825 |
| 接口超时 | OVERALL_TIMEOUT_MS=15000（后端兜底 500）；前端 fetch 硬超时 15000 | server.js:1793；app.js:3181 |
| 缓存 | 资金量能无 TTL/磁盘缓存（每次实时算）；前端仅内存 `capitalLoadedSymbol` | app.js:3203 |
