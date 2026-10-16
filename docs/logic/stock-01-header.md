# 顶部常驻区（股价 / 涨跌 / 行情日期 / 关键指标 / K 线周期）· 反向逻辑说明

> 逻辑模型位置：个股页 → 顶部常驻区（名称行 + 价格行 + 财务报告期标注 + 关键指标格网 + K 线主图与周期按钮）
> 实现文件：`public/index.html:291-321`（结构）、`public/js/app.js:1845-2002`（渲染）、`public/js/app.js:6633-6852`（60s 刷新与周期切换）、`lib/stockData.js:266-329`（腾讯取数）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 股票名称 `#stockName` | `data.name`（判断记录/行情名）直接渲染 | app.js:1870 |
| 股票代码 `#stockCode` | `data.symbol` 原样渲染（不带市场前缀处理） | app.js:1871 |
| 市场标签 `#stockMarket` | `CN→A股 / HK→港股 / US→美股`，未知市场原样显示 | app.js:1872, 1893-1896 |
| 现价 `#stockPrice` | `quote.price`；货币符号：`market==='US' ? '$' : '¥'`；无价格显示 `--` | app.js:1851 |
| 价格颜色 | 涨：`var(--red)`（红涨）；跌：`var(--green)`（绿跌）；平：不设色 | app.js:1857 |
| 涨跌额/幅 `#stockChange` | `{+/-}change (changePct%)`，change 保留两位格式；颜色类 `up/down` + 涨跌幅绝对值 ≥10% 加粗类 `chg-strong` | app.js:1854-1856, 6698-6700 |
| 行情日期+时间 `#stockDate` | `quote.date + ' ' + quote.time`（time 缺失时只显示 date）；quote 无 date 显示 `—` | app.js:1860-1864 |
| 财务报告期 `#stockFinDate` | `quote.fundamentals.reportPeriod \|\| reportDate`；无则清空。悬停提示「PB 所用每股净资产来自该报告期（MRQ）；PE(TTM)/PS(TTM)/ROE(TTM) 为滚动 12 个月口径，随行情更新，不绑定财报期」 | app.js:1878-1889 |
| 关键指标格网 `#keyMetrics` | 10 项（见第三节）；每项含 label / value / sub（口径小字）/ source（来源）；估值类按 signals 着色（利好红/利空绿） | app.js:1898-2002 |
| K 线主图 `#candlestickChart` | 默认日 K；周期按钮：日K / 周K / 月K / 60 分钟 | index.html:309-312, app.js:6748-6752 |
| 周期按钮切换 | 日K=已加载日 K；周/月 K=**前端对日 K 重采样**；60 分钟=另取 `/api/history60` | app.js:6755-6799 |
| 60s 实时刷新 | 定时器每 60s 拉 `/api/quote`，仅更新头部价格/涨跌/日期 + 关键指标格网 + 资金量能量价卡；技术面/基本面等分析快照不刷新 | app.js:6633-6675 |

## 二、核心公式 / 判定链

### 2.1 腾讯行情字段映射（唯一取数源）

`fetchTencentQuote` 请求 `https://qt.gtimg.cn/q=<代码>`（GBK 解码，iconv），按 `~` 分隔，字段 < 50 个则整个返回 null（stockData.js:275-278）：

| 字段 | 含义 | 代码处加工 | 出处 |
|---|---|---|---|
| fields[1] / [2] | 名称 / 代码 | 原样 | stockData.js:306-307 |
| fields[3] | 现价 | `parseFloat \|\| 0` | stockData.js:280 |
| fields[4] | 昨收 | 同上 | stockData.js:281 |
| fields[31] / [32] | 涨跌额 / 涨跌幅% | 同上 | stockData.js:282-283 |
| fields[36] | 成交量（手） | ×100 转股 | stockData.js:284, 317 |
| fields[37] | 成交额（万元） | ×10000 转元 | stockData.js:285, 318 |
| fields[38] | 换手率% | 原样 | stockData.js:286 |
| fields[39] / [46] | PE / PB | 原样 | stockData.js:287, 291 |
| fields[43] | 振幅% | 原样 | stockData.js:288 |
| fields[44] / [45] | 流通市值 / 总市值（**亿**） | 原样传入前端 | stockData.js:289-290 |
| fields[5] / [33] / [34] | 开盘 / 最高 / 最低 | 原样 | stockData.js:312-314 |
| fields[9] / [19] | 买一 / 卖一 | 原样 | stockData.js:325-326 |
| fields[30] | 行情日期时间（如 `20261016161452`） | 见 2.3 | stockData.js:294-303 |

> 实测验证（2026-10-16）：`sh601318` fields[45]=9394.24（总市值亿）；`sz002175` fields[44]/[45]=30.00/30.00（亿）；`usAAPL` fields[45]=50507.53814（亿）。**各市场该字段单位均为「亿」**。

### 2.2 涨跌颜色与加粗判定

- 颜色：`isUp = quote.change >= 0` → 价格红 `var(--red)`、跌绿 `var(--green)`（app.js:1854-1857）。注意判据用的是 **change（涨跌额）** 而非 changePct，两者同号（腾讯源），无实际分歧。
- 加粗：`|changePct| >= 10` → 追加 `chg-strong`（app.js:6698-6700），视觉上强化涨停/跌停档。
- 指标格网内最高/最低/开盘价着色：与昨收比较（`> prevClose 红 / < 绿`）（app.js:1932）。

### 2.3 行情日期解析链

`fields[30]` 原始形如 `20261016161452` 或 `2026-08-03 15:00:02`：
1. 日期正则 `/(\d{4})[-/]?(\d{2})[-/]?(\d{2})/` 提取 → `YYYY-MM-DD`（stockData.js:296-297）；
2. 时间正则 `/(\d{2}):(\d{2})/` 提取 → `HH:MM`（stockData.js:298-299）；
3. **解析失败（qtDate 为空）→ 静默取服务器「今天」**（stockData.js:300-303）。

### 2.4 周/月 K 前端重采样算法

`resampleHistory(history, period)`（app.js:6808-6831）：
- 周 K 分桶键 = `isoWeekKey(date)`：ISO 周算法——先回退到本周周四，再以当年 1 月 4 日所在周为第 1 周推算周序号（app.js:6833-6841）；
- 月 K 分桶键 = `date.slice(0,7)`（app.js:6811）；
- 每根聚合 K：`open=桶内首日.open`，`close=桶内末日.close`，`high=max`，`low=min`，`volume/amount=求和`，`turnover=末日值`，`date=末日日期`（app.js:6816-6829）；
- 均线：重采样后由前端 `computeMA` 现算 MA5/10/20/60（app.js:6797, 6843-6852）——**注意日 K 路径的均线来自后端 `dailyTechnical`，周/月 K 路径为前端重算，两路均线数据源不同**。

### 2.5 60 分钟周期

`render60m()`：懒加载 `/api/history60/<symbol>`（东财 `klt=60`，不复权，首根收盘价与实时价同口径）；失败toast「60分钟数据暂不可用，已切回日K」并 `fallbackToDaily()`（app.js:6768-6788, 6801-6805）。

### 2.6 总市值显示换算（⚠️ 疑似 bug）

前端渲染：`totalValue × (totalValue < 100 ? 10000 : 1)` 后加「亿」（app.js:1940）。按 2.1 实测，fields[45] 各市场均为「亿」：
- 总市值 ≥100 亿：×1，正确；
- 总市值 <100 亿（如 sz002175=30.00）：×10000 → 显示 300000 亿，**放大 10000 倍**。

## 三、指标 / 因子口径

关键指标格网共 10 项（`renderKeyMetrics`，app.js:1898-2002）。取值优先级：**`data.fundamental.metrics`（基本面左卡权威源）→ `quote.fundamentals` → 腾讯 quote 字段**：

| 指标 | 口径 | 归一化/加工 | 出处 |
|---|---|---|---|
| 最高 / 最低 / 开盘 / 昨收 | 腾讯当日 fields[33]/[34]/[5]/[4] | 无 | app.js:1934-1937 |
| 换手率 | 腾讯 fields[38]（%） | 直接加 % | app.js:1938 |
| 成交额 | 腾讯 fields[37]（万元→元 ×10000） | 千分位格式化 | app.js:1939, stockData.js:318 |
| 总市值 | 腾讯 fields[45]（亿） | `<100 ? ×10000 : ×1` + 「亿」 | app.js:1940 |
| 市盈率(TTM) | 总市值 ÷ 近 12 个月归母净利（滚动，随行情更新，**不绑定财报期**） | 优先 `fm.pe` → `f.pe` → `quote.pe` | app.js:1945-1953 |
| 市净率(PB) | 股价 ÷ 每股净资产（**MRQ，绑定财报期**，sub 标注财报日期） | 优先 `fm.pb` → `f.pb` → `quote.pb` | app.js:1954-1962 |
| 市销率(PS) | 主口径东财 PS_TTM；本地兜底为「总市值÷最新一期营收」**单期口径**，标签区分（`PS·TTM` vs `PS`），防假 TTM | `fm.ps` → `f.ps` | app.js:1963-1979 |
| ROE | 优先 TTM（截至行情日）；回退最新披露期值 | `f.roeTtm` → `fm.roe` → `f.roe` | app.js:1980-1991 |

估值类着色：复用 `data.signals.signals` 的 `pe/pb/ps/roe` 信号（利好红、利空绿、中性默认），判定依据写进 title 悬停（app.js:1907-1920）。

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | ① 实时行情：腾讯 `qt.gtimg.cn/q=`（GBK，8s 超时，stockData.js:266-272）；② 日 K：腾讯 `ifzq.gtimg.cn/appstock/app/fqkline/get?...,qfq`（前复权，stockData.js:1201）；③ 60 分钟 K：东财 `klt=60`（app.js:6767 注释）；④ 财务报告期：东财 F10（`REPORT_DATE_NAME`，stockData.js:1712） |
| 采集/落盘 | 实时行情不落盘（透传）；日 K 由 `getHistory` 走内存/文件缓存（lib/stockData.js）；60 分钟由 `/api/history60` 实时取 |
| 调度 | 无后台定时抓取；**前端驱动**：打开个股页取一次全量快照（`/api/stock/:symbol` 一族），随后 60s 定时器只拉 `/api/quote`（server.js:162-171） |
| 前端取数 | 首屏：`/api/quote` 之外的全量分析快照（含 quote/history/fundamental 等）；60s：`/api/quote?cache:no-store`（app.js:6650）；周期切换：周/月 K 纯前端重采样不请求，60 分钟请求 `/api/history60`（app.js:6772） |

## 五、降级 / 容错 / 诚实性设计

| 场景 | 行为 | 诚实性评价 |
|---|---|---|
| 60s 刷新失败（网络/5xx） | **静默**：catch 后保留上一次数值，不弹错（app.js:6672-6674） | 价格陈旧但无提示；靠「行情日期+时间」可人工识别新鲜度 |
| 60s 刷新期间切换股票 | 结果丢弃（symbol 比对），防串股（app.js:6654） | 安全 |
| 后台标签页 / 回到首页 | `document.hidden` 或 dashboard 隐藏时跳过刷新（app.js:6639-6642） | 省流量，无诚实性问题 |
| 行情日期解析失败 | 静默取服务器今天（stockData.js:300-303） | **不诚实**：接口异常时会显示一个「看似正常的今天日期」（见清单 S6） |
| 60 分钟数据不可用 | toast 明示 + 降级日 K（app.js:6777-6781, 6784-6787） | 诚实降级 |
| 港股/美股货币符号 | `market==='US' ? '$' : '¥'`（app.js:1851） | **不诚实**：港股显示 ¥ 应为 HK$（见清单 S1） |
| 无 quote（取数失败） | 价格 `--`；`applyLiveQuote` 直接 return（app.js:1846） | 诚实（显示 --） |
| PE/PB/PS/ROE 缺失 | 对应格直接不渲染（`if (peVal)` 守卫） | 诚实（不造假值） |

## 六、逻辑漏洞自查清单（审计用）

- [ ] **S1 港股货币符号误用 ¥**：`applyLiveQuote` 只区分 US/非 US，港股（HK）现价符号显示 ¥ 而非 HK$（app.js:1851）。验证：任选港股（如 hk00700）看头部价格前缀。
- [ ] **S2 总市值 <100 亿时放大 10000 倍**：`totalValue < 100 ? 10000 : 1`（app.js:1940）与腾讯 fields[45]=「亿」的单位实测矛盾（sz002175=30.00 亿 → 显示 300000 亿）。小市值 A 股/港股均触发。验证：`sz002175` 或任意 <100 亿 A 股看「总市值」格。
- [ ] **S3 估值指标 60s 刷新实时性弱于价格**：`renderKeyMetrics` 优先取 `data.fundamental.metrics`（页面加载快照，60s  tick 不更新 `data.fundamental`），PE/PB/PS/ROE 显示值可能停留在首屏快照，而价格已变（app.js:1907, 1945-1991, 6656-6666）。两源分歧时以哪个为准无明文。
- [ ] **S4 周/月 K 均线与日 K 均线不同源**：日 K 均线来自后端 `dailyTechnical`，周/月 K 为前端 `computeMA` 现算（app.js:6794-6797, 6843-6852）；同一只股票切周期均线数值口径可能不完全一致（复权处理、区间不同）。
- [ ] **S5 周 K 分桶用 ISO 周**：`isoWeekKey` 以周四定周（app.js:6833-6841），与部分行情软件「自然周」分桶可能差 1-3 天，跨年周归属需人工核对。
- [ ] **S6 行情日期静默落今天**：fields[30] 解析失败时取服务器今天（stockData.js:300-303），接口降级（如字段错位）时用户看到「今天的日期」但价格可能是旧值，日期失去保鲜度指示作用。
- [ ] **S7 换手率单位**：fields[38] 直接当 % 用（app.js:1938）。腾讯该字段为百分数（如 0.62 表示 0.62%），需与「资金热度」卡换手率口径交叉验证一致性。
- [ ] **S8 成交额单位链**：万→元 ×10000（stockData.js:318），前端只做格式化不再换算；若腾讯改字段单位，两处（stockData + 前端）不会同时发现。
- [ ] **S9 价格颜色判据是 change 而非 changePct**：app.js:1854 用 `quote.change >= 0`。腾讯源两者恒同号，但若接入其他源（如新浪兜底）出现精度差，方向着色可能错。
- [ ] **S10 `stockFinDate` 报告期与估值口径混排风险**：同行展示「财报报告期」，但同格网的 PE(TTM)/PS(TTM)/ROE(TTM) 是滚动口径不绑定该报告期，只有 PB(MRQ) 绑定（app.js:1884）。用户可能误读全部指标都截至该报告期（title 有说明，但格内无视觉区分）。
- [ ] **S11 60s 刷新不刷新 K 线与 signals 着色**：`refreshCurrentQuote` 只重渲染头部 + 格网 + 资金量价卡（app.js:6665-6671），K 线主图与分析快照在页面打开后不再更新；「日期/时间」在走，图是旧的，需刷新页面。
- [ ] **S12 首屏快照与 60s 合并的口径一致性**：合并逻辑 `Object.assign(prevQuote, q)` + fundamentals 浅合并（app.js:6659-6662），若 `/api/quote` 与全量快照的 quote 字段结构不一致（如一侧有 `roeTtm` 一侧没有），合并结果依赖运气而非契约。
- [ ] **S13 `renderDashboardCharts` 只重置周期态不重绘图**：app.js:6748-6752 仅置 `currentPeriod='daily'` 与按钮态，实际绘图由 `renderMainChart` 触发；若首屏 history 未就绪，周期按钮点击空跑（`if (!history.length) return`，app.js:6792）。
- [ ] **S14 市场标签 `marketLabel` 对 BJ（北交所）无映射**：labels 只有 CN/HK/US（app.js:1894），北交所股票显示原始 market 值。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 腾讯行情请求超时 | 8000ms | lib/stockData.js:270 |
| 60s 刷新间隔 | 60000ms | public/js/app.js:6635 |
| 涨跌加粗阈值 | \|changePct\| ≥ 10% | public/js/app.js:6699 |
| K 线周期选项 | daily / weekly / monthly / 60m | public/index.html:309-312 |
| 周 K 分桶算法 | ISO 周（周四定周） | public/js/app.js:6833-6841 |
| 均线周期 | MA5/10/20/60 | public/js/app.js:6851 |
| 总市值单位换算阈值 | <100 亿 → ×10000（⚠️ 见 S2） | public/js/app.js:1940 |
| 货币符号映射 | US→$，其他→¥（⚠️ 见 S1） | public/js/app.js:1851 |
