# 主图「区间最高 / 区间最低」自动追踪光标 · 反向逻辑说明

> 逻辑模型位置：个股页 → 中栏主图（K 线卡）
> 实现文件：`public/js/charts.js`（`_visibleRange` / `_rangeExtremes` / `_rangeMarkLine` / `_bindRangeMarkLine`，接线在 `candlestick()`）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断
> 引入版本：`20261022i`（用户需求原文：「主图模块删除右侧标示今日收盘价的光标，增加两个自动追踪光标，一个显示当前选定的时间范围内股票的最高价，一个显示最低价。」）

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 红色虚线 + 右端价签「高 x.xx」 | **当前可视区间**内所有 K 线 `high` 的最大值 | `charts.js:_rangeExtremes` → `hi`；`_rangeMarkLine` 第 1 条，`position:'insideEndTop'` |
| 绿色虚线 + 右端价签「低 x.xx」 | **当前可视区间**内所有 K 线 `low` 的最小值 | `charts.js:_rangeExtremes` → `lo`；`_rangeMarkLine` 第 2 条，`position:'insideEndBottom'` |
| 光标随缩放/拖动移动 | 监听 ECharts `dataZoom`，用 rAF 节流重算 | `charts.js:_bindRangeMarkLine` |
| （已删除）右端「今日收盘价」价签 | 旧逻辑：`markLine` 只标 `history[last].close`，信息量低且与区间无关 | 20261022i 整块删除，`candlestick()` 中不再存在单条 `yAxis: lastDay.close` 的 markLine |

**颜色语义**：高=红（`this.colors.up`）、低=绿（`this.colors.down`），与全站红涨绿跌一致；价签文字用深色 `#0B0E11` 压在彩色底上保证对比度。

## 二、核心公式 / 判定链

```
用户操作（四条路径，全部收敛到同一处）
├─ 点 3月/6月/1年/3年 → analyze() 重新取 history → 重走 candlestick()
├─ 滚轮缩放（dataZoom inside）
├─ 拖动平移（dataZoom inside, moveOnMouseMove）
└─ 拖拽底部 slider
        ↓
  chart.getOption().dataZoom[0] 的 start/end（百分比）
        ↓  _visibleRange(chart, total)
  i0 = floor(total * start / 100)
  i1 = ceil(total * end / 100) - 1        // 夹到 [0, total-1]，且 i1 ≥ i0
        ↓  _rangeExtremes(history, i0, i1)
  遍历 [i0, i1]：hi = max(Number(d.high))、lo = min(Number(d.low))   // isFinite 过滤
        ↓  _rangeMarkLine(history, i0, i1)
  markLine.data = [ {yAxis: hi, 高·红·insideEndTop},
                    {yAxis: lo, 低·绿·insideEndBottom} ]             // 长度恒为 2
        ↓
  chart.setOption({ series: [{ markLine }] })   // rAF 节流，一帧最多一次
```

**为什么读 `dataZoom` 百分比而不是内部下标**：`getOption()` 是 ECharts 公开 API，内部 model 取下标属于私有实现，升级易碎。百分比 → 下标换算与 ECharts 自身的取整方向（起 floor、终 ceil）保持一致，实测与可视区完全对齐。

**为什么 `markLine.data` 长度必须恒为 2**：ECharts 的 `markLine.data` 按**索引**合并。若某次只输出 1 条，上一次的第 2 条会作为脏数据留在图上（表现为轨道上多一条错误光标）。因此缺值时输出「占位条目」（`yAxis:null` + `lineStyle.opacity:0` + `label.show:false`），而不是缩短数组。

**为什么用 rAF 节流**：拖动缩放时 `dataZoom` 每帧触发多次，直接 `setOption` 会明显掉帧。同帧内多次触发只排 1 次。

## 三、指标 / 因子口径

| 指标/因子 | 口径（原始值怎么算） | 归一化 | 是否进总分 | 出处 |
|---|---|---|---|---|
| 区间最高价 | `max(high)`，区间 = 可视 K 线（含两端） | 无（原值展示） | 否（纯展示，不参与任何评分/概率） | `charts.js:_rangeExtremes` |
| 区间最低价 | `min(low)`，区间同上 | 无 | 否 | 同上 |

**只看 `high`/`low`，不看 `close`**：用户要的是「这段时间的最高价/最低价」，即影线极值，不是收盘价极值。日/周/月/60m 四类 `history` 元素均带 `high`/`low`（周月线由 `app.js:resampleHistory` 聚合 `Math.max(high)` / `Math.min(low)` 产出，字段一致）。

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | 个股页 `/api/analysis/:symbol` 返回的 `history[]`（日K，含 `date/open/close/high/low/volume`） |
| 采集/落盘 | 服务端既有链路（同花顺 all.js 原始响应缓存 → 腾讯/新浪降级），本模块不新增任何取数 |
| 调度 | 无独立调度；随主图渲染时机触发 |
| 前端取数 | 纯前端计算，用已渲染的 `history` 数组，**零额外请求** |

## 五、降级 / 容错 / 诚实性设计

| 场景 | 行为 |
|---|---|
| `getOption()` 抛错（图表已销毁等） | 回退默认区间 `start:60, end:100`（与主图 dataZoom 初始值一致），`_rangeCursorErrCount++` 记账，不阻断绘图 |
| `history` 为空 / 少于 2 根 | `candlestick()` 直接 return；`_bindRangeMarkLine` 也做长度校验 |
| 某段 `high`/`low` 为 `null`/`NaN` | `Number()` + `isFinite()` 过滤，只取合法值；若整段非法则输出占位条目（不画线不显示价签） |
| `setOption` 时图表已销毁 | `_rangeCursorErrCount++`，不弹窗打扰 |
| 分时视图（`minute()`） | **不受影响**：`minute()` 是独立方法，未接 `_bindRangeMarkLine`，仍按自身逻辑绘制 |

**诊断计数器**：`Charts._rangeCursorErrCount` 累计失败次数，供调试读取。刻意不写空 `catch` —— 项目回归守卫 `scripts/test_swallow_catch_guard.js` 按**计数**比对基线，新增空 `catch` 会被判为「新增静默吞错」。

## 六、逻辑漏洞自查清单（审计用）

- [x] 「今日收盘价」标线已彻底移除：`charts.js:candlestick()` 中不存在 `yAxis: lastDay.close` 形式的 markLine 数据（`scripts/test_chart_range_cursor.js` [1] 断言）
- [x] 光标恒为 2 条，且两条价格不同（`test_chart_range_cursor.js` [1]）
- [x] 初次渲染按全区间算，挂载后立即按真实 dataZoom 校正（`[2]`/`[3]`）
- [x] `dataZoom` 事件驱动重算正确（`[4]`：80%~100% / 0%~30% / 全量三种区间逐一比对期望值）
- [x] 同帧多次 `dataZoom` 只排 1 次 rAF（`[4]`，节流生效）
- [x] 多次重算后 `data.length` 恒为 2，无脏光标残留（`[4]`）
- [x] 周K/月K（重采样后 history 根数更少）同样正确（`[5]`）
- [x] `high`/`low` 缺失时段输出占位条目、不抛错（`[6]`）
- [x] 空历史 / 单根历史 / 空 chart 不抛错（`[6]`）
- [x] `getOption` 抛错时错误计数 +1 且回退区间合法（`[7]`）
- [x] 分时视图未接入本逻辑（`minute()` 独立方法，无 `_bindRangeMarkLine` 调用）
- [ ] ⚠️ 60 分钟视图（`60m`）：若将来接 `candlestick()` 渲染，需确认其 `history` 也带 `high`/`low`，否则区间极值会算错
- [ ] ⚠️ 若将来给主图增加第二个 `dataZoom` 于 `dataZoom[0]` 之前，`_visibleRange` 读固定索引 0 会读错；新增时必须同步调整取值逻辑

## 七、可配置项

| 项 | 当前值 | 位置 |
|---|---|---|
| 回退默认区间 | `start:60, end:100` | `charts.js:_visibleRange` |
| 虚线样式 | `type:'dashed', width:1, opacity:0.9` | `charts.js:_rangeMarkLine` |
| 价签字号/内边距/圆角 | `fontSize:10, padding:[3,7], borderRadius:4` | 同上 |
| 价签颜色 | 底色 = 红/绿，文字 `#0B0E11` | 同上 |
| 节流 | `requestAnimationFrame`（无则 `setTimeout 16ms`） | `charts.js:_bindRangeMarkLine` |

## 八、守卫

`scripts/test_chart_range_cursor.js` —— **39 项断言**，全离线（stub echarts 捕获 `setOption`），覆盖上表全部条目。
