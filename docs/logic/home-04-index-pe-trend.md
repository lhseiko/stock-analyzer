# 📊 大盘估值趋势 · 反向逻辑说明

> 逻辑模型位置：首页 → 大盘估值趋势
> 实现文件：`lib/indexPETrend.js`（全 188 行）；路由 `server.js:715`；采集器 `scripts/index_pe_trend.py`；前端 `public/js/app.js:5636`（loadIndexPeTrend）/ `:5666`（renderIndexPeTrend）/ `public/js/charts.js:334`（indexPETrend 图表）
> 口径出处：全部标注 `file:line`。

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 三张统计卡（上证50 / 沪深300 / 科创50） | 当前 PE(TTM)（2 位小数）+ 口径字段名 + 数据源 + 「近5年百分位 x%」 | app.js:5678-5688；indexPETrend.js:159-166 |
| 三色折线图 | 近 5 年 PE-TTM 序列（月/日采样），虚线 markLine 标「当前PE」，可缩放 | charts.js:334-397 |
| 卡片底部注释 | 「不同口径不可直接比较数值，仅用于趋势观察」 | indexPETrend.js:182；app.js:5693 |
| 「更新于 hh:mm」 | 数据的 updatedAt（缓存写入/脚本返回时间） | app.js:5650-5656 |
| 加载失败态 | 「估值趋势暂时不可用，点击右上角刷新重试」——**不显示旧数据冒充** | app.js:5645-5648 |

**⚠️ 已发现的口径漂移（审计发现，待用户定夺）**：逻辑模型树描述本模块「当前历史分位 → 低估 / 合理 / 高估（严格三档）」（logicModel.js:55），但**全链路查无三档判定**：lib 只算百分位（indexPETrend.js:102-112）、python 脚本无分档代码、图表只画线和当前 PE 标记、前端统计卡只显示「近5年百分位 x%」。实际交付的是「PE + 历史百分位」，**没有三档评级文字**。属 TREE 文案与实现不一致——建议改文案或按既有三档规范补映射（阈值需你定，例如 ≤30% 低估 / 30~70% 合理 / ≥70% 高估）。

## 二、核心公式 / 判定链

```
取数：python 脚本 → 三指数 PE-TTM 序列（date, pe, close）        （indexPETrend.js:70-89）
清洗：pe 保留 2 位小数，滤掉 null/非有限值                        （:154-158）
当前值：序列最后一点                                               （:159）
历史百分位 quantile = round((lower + same/2) / N × 100)           （:102-112）
  lower = 序列中严格小于当前 PE 的个数；same = 等于当前 PE 的个数（中间值法）
缓存：data/index-pe-trend.json，TTL 6 小时                        （:21、27-40）
```

无加权、无方向分、无告警——本模块是**纯事实展示**（序列 + 当前值 + 百分位）。

## 三、指标口径

| 指标 | 口径 | 注意 | 出处 |
|---|---|---|---|
| 上证50 PE | 乐咕乐股月度滚动市盈率（指数成份股**加权** PE） | 月度采样，非日频 | indexPETrend.js:5 |
| 沪深300 PE | 同上（乐咕月度加权 PE） | 月度采样 | indexPETrend.js:5 |
| 科创50 PE | 东财 RPT_VALUEMARKET「科创板50」板块**平均** PE（TTM），日频按月采样 | 平均≠加权，与指数详情页数值不一致（已在注释声明） | indexPETrend.js:6-10 |
| 近5年百分位 | 当前 PE 在近 5 年序列中的排位（中间值法） | 序列实际长度取决于脚本返回 | indexPETrend.js:102-112 |

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | 乐咕乐股（legulegu.com）月度 PE-TTM；东方财富市场估值报表（科创50） |
| 采集器 | `scripts/index_pe_trend.py`，被 indexPETrend.js 以子进程调用：120s 超时、8MB buffer、PYTHONIOENCODING=utf-8；解释器按 PYTHON_BIN → 本机 managed python → python3 → python 顺序探测（:51-68） |
| 缓存 | `data/index-pe-trend.json`；TTL 6h；force（refresh=1/force=1）跳过缓存直采并覆写 |
| 前端取数 | `GET /api/index-pe-trend`（app.js:5643，注意：前端调用**不带 refresh**，强制刷新需手动改 URL 或等 TTL） |

## 五、降级 / 容错 / 诚实性设计

| 情况 | 行为 | 出处 |
|---|---|---|
| 缓存新鲜（<6h） | 直接用缓存，`cached:true` | indexPETrend.js:118-124 |
| 脚本取数失败 | **尝试回退缓存**——但 readCache 对过期缓存返回 null，实际不可用（见审计清单） | indexPETrend.js:130-136、:33-34 |
| 无缓存且取数失败 | 返回 success:false + 三指数空序列（series:[]）；前端显示「暂时不可用」 | indexPETrend.js:137-145；app.js:5645-5648 |
| Python 解释器缺失 | 抛「未找到可用的 Python 解释器」 | indexPETrend.js:72 |
| 口径差异 | note 固定声明三指数口径不可直接比较 | indexPETrend.js:182 |

## 六、逻辑漏洞自查清单（审计用）

- [ ] **TREE 三档缺失（已证实）**：logicModel.js:55 承诺的「低估/合理/高估」全链路不存在——先定「改文案」还是「补三档」（若补，阈值与分档口径需你确认）
- [x] ~~**过期缓存回退是死代码**：readCache 在 age>TTL 时返回 null，catch 里再读一次必然为 null——「取数失败回退缓存」实际永不生效，失败即空态~~ → **✅ 已修复（20261016）**：readCache 加 allowStale 参数（过期缓存可返回并带 `__stale` 内部标记），catch 分支真正回退过期缓存；返回值加顶层 `stale:true` + `staleNote`，前端渲染红色警示条「⚠️ 实时数据源暂不可达，当前展示 HH:mm 的缓存数据」。不覆盖旧缓存文件（仅成功路径写盘）
- [ ] **科创50 口径与其他两个不可比**：平均 PE vs 加权 PE，同图三条线并列可能误导——检查图表是否有分隔或注释（charts.js:337-339；indexPETrend.js:6-10）
- [ ] **百分位中间值法**：same/2 的取整在样本少时敏感，序列不满 5 年时百分位含义漂移——检查实际序列起止日期（indexPETrend.js:108-111）
- [ ] **月采样 vs 日采样混排**：上证50/沪深300 月度点、科创50 日频按月采样，X 轴对齐方式是以「日期最全的序列」为轴（charts.js:343）——检查错位视觉
- [ ] **前端不传 refresh**：loadIndexPeTrend 固定 GET /api/index-pe-trend，用户点刷新只重新读缓存——评估是否加 force（app.js:5643）
- [ ] **TTL 6h 与盘中刷新**：缓存 6 小时，盘中估值不会更新——确认这是预期（估值日内变化小）
- [ ] **脚本单次全量**：三指数一次脚本全取，任一失败整体失败（success=false）——评估分指数容错（indexPETrend.js:84-88）
- [ ] **空序列时图表静默**：Charts.indexPETrend 在 items 为空时直接 return，统计卡显示「—」——检查用户能否区分「加载中」与「无数据」（charts.js:339-340）
- [ ] **百分位无样本量标注**：卡上只显示百分位，不显示序列点数——样本不足时百分位不可信，建议补 N 值（app.js:5680）

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 缓存 TTL | 6 小时 | indexPETrend.js:21 |
| 缓存路径 | data/index-pe-trend.json | indexPETrend.js:20 |
| 脚本超时 | 120s | indexPETrend.js:79 |
| 指数清单 | 上证50 / 沪深300 / 科创50（硬编码于 :151） | indexPETrend.js:151 |
