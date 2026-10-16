# 🏭 基金行业配置名单 · 反向逻辑说明

> 逻辑模型位置：首页 → 基金行业配置名单
> 实现文件：`lib/fundIndustryMatrix.js`（全 1009 行）；路由 `server.js:831/847/859/864`；前端 `public/js/homeRank.js`（全 312 行）；页面结构 `public/index.html:268-279`
> 口径出处：全部标注 `file:line`。

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 「自然季度更新」状态条 | 目标报告期 + 徽章（本季度已完成/分批更新中/等待披露/新季度启动中）+ 进度条 + 已更新 N/N 只 + 可算环比样本 + 上/下次检查时间（每日 19:00） | homeRank.js:71-117；fundIndustryMatrix.js:253-288 |
| 采集进度块（仅 running 时） | 当前阶段（读取基金列表/采集重仓股/解析行业/本批暂停）+ 双进度条 + 速率 + 预计剩余 + 失败数 + 最后错误 | homeRank.js:120-155；fundIndustryMatrix.js:652 |
| KPI 六联卡 | 环比样本（两期齐全）/ 纳入母基金 / 重仓个股 / 可比口径合计市值 / 合计市值环比（红增绿减）/ 已归类行业 | homeRank.js:157-177 |
| 榜单表格 | 前 20 名行业：排名 + 行业名（+基金数·个股数）+ 持仓市值（加总，亿元/万元）+ 占比条 + 环比变化 + 行业内 Top 重仓股 chips | homeRank.js:179-197、201-225 |
| 「未分类」行 | 行业未解析出的个股单独置底、不参与排名，带「行业待解析」徽章；随采集推进被逐步解析掉 | homeRank.js:207-209、:181-186 |
| 环比变化单元格 | 增减额（亿元，红=增持/绿=减持）+ 百分比；**基数为 0 或新进榜时不显示百分比**（不硬造） | homeRank.js:57-68；fundIndustryMatrix.js:921 |
| 「共 N 个行业，仅展示前 20 名」 | 超过 20 名时脚注说明 | homeRank.js:214-215 |
| 底部 note + 免责 | 数据源/更新频率/口径说明 + 「仅供研究参考，不构成投资建议」 | homeRank.js:250-252；fundIndustryMatrix.js:977-983 |
| 采集轮询 | 采集中或本季未完成时每 3 秒自动重拉；正常加载 4 秒节流 | homeRank.js:13-14、:256-258、:276-278 |
| 刷新按钮 | 先 POST /crawl 触发/继续采集，再强制重拉 | homeRank.js:290-300 |

## 二、核心公式 / 判定链

```
基金宇宙：全量基金 → 权益类（股票|混合|指数|QDII，剔 债券|货币|Reits|FOF|商品|理财|其他）
          → 按母基金名去重（A/C 等份额剥离）                        （:103-130、:94-100）
重仓股：每只母基金最新报告期前十大重仓股（code, name, value 万元）   （:325-335）
行业归属：个股 → resolveSectorIdentity（东财 F10/申万；港股 push2delay f127），
          磁盘缓存 90 天；查不到 → 负缓存 7 天 → 展示为「未分类」      （:52、:358+）
纳入排名的基金（严格可比）：报告期==展示期 且 上一期==展示期的上一季，两期齐全   （:879-883）
行业持仓市值 = Σ 纳入基金前十大重仓股中归属该行业的个股市值（万元）      （:885-897）
环比变化 = 本期市值 − 上期市值（同批基金、同一个个股→行业映射）          （:900-906、:911）
占比 = 行业市值 ÷ 纳入基金重仓市值合计 × 100%                        （:922）
排名 = 按持仓市值降序；展示期 = 账本目标期（已发布）否则缓存中最多的报告期   （:863-866、:931）
```

## 三、指标口径

| 指标 | 口径 | 出处 |
|---|---|---|
| 持仓市值 | 基金**最新报告期**前十大重仓股的持仓市值（万元），非当前实时市值 | fundIndustryMatrix.js:9-10、:890 |
| 纳入母基金 | 权益类母基金去重后数量（实测 17920 份额 → 10126 母基金，43.5% 是 A/C 重复） | fundIndustryMatrix.js:14-16 |
| 环比样本 | 本期+上期两期齐全的基金数——**排名与环比都只基于这批基金** | fundIndustryMatrix.js:882-883、:964 |
| 合计市值环比 | 全样本（含未分类）本期−上期总额 | fundIndustryMatrix.js:968-970；homeRank.js:160-166 |
| 行业内 Top 股 | 该行业内持仓市值最大的前 8 只（前端展示前 5） | fundIndustryMatrix.js:925-928；homeRank.js:183 |
| 行业解析率 | 已解析/查不到(负缓存)/未解析 三类，从缓存实算 | fundIndustryMatrix.js:936-942 |

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | 东财公开接口（无需鉴权）：①基金全量列表 fundcode_search.js ②各基金 FundArchivesDatas（type=jjcc 前十大重仓）③个股→行业（resolveSectorIdentity / 港股 push2delay） |
| 采集节奏 | 全量约 1 万只母基金首次十几分钟；并发 3 + 请求间隔 80ms + 单只重试 3 次（实测该参数下 240 请求仅 1 失败）；每 250 只或 60s 落盘一次，可续跑 |
| 自然季度调度 | 进入新自然季度（7/1 盯 Q2、10/1 盯 Q3…）后每日 19:00 检查东财是否开始披露目标报告期；一旦开始，每天一批（≤2500 只、≤20 分钟），直到全部更新完毕 |
| 披露宽限 | 超宽限期仍未出报告期的基金记「滞后」，不阻塞「本季完成」：Q1/Q3 40 天、Q2 70 天、Q4 100 天（依据公募披露规则：季报 15 工作日/半年报 60 日/年报 90 日） |
| 落盘 | data/fund_holdings/：universe.json（7 天 TTL）、holdings.json（每基金本期+上期）、progress.json、quarter.json；个股行业缓存 data/stock_industry_cache.json（90 天） |
| 前端取数 | GET /api/fund-industry-matrix（homeRank.js:272）；首次访问且无缓存时路由自动触发后台采集（server.js:836-838） |

出处：fundIndustryMatrix.js:1-36（设计说明）、:51-72（参数）、:168-215（季度账本）、:253-288（getQuarterStatus）、:783-818（startCrawl）。

## 五、降级 / 容错 / 诚实性设计

| 情况 | 行为 | 出处 |
|---|---|---|
| 行业解析不出 | 归「未分类」置底展示，不猜行业；负缓存 7 天避免反复重试 | fundIndustryMatrix.js:889、:358；homeRank.js:186 |
| 缺上一期数据 | 该基金**不纳入排名与环比**（新发基金等），KPI 明示「环比样本」数 | fundIndustryMatrix.js:882-883；homeRank.js:168 |
| 环比基数为 0 | 不显示百分比，只显示增减额 | fundIndustryMatrix.js:921；homeRank.js:65-66 |
| 上一季数据整体未齐 | 「环比变化」列头显示「上一季度数据待补齐」 | homeRank.js:212-213 |
| 采集被风控/失败 | 失败计数与最后错误在进度块如实展示；已抓数据保留、可续跑 | homeRank.js:150-151；fundIndustryMatrix.js:62-63 |
| 本批到时间预算 | 暂停（phase=batch），次日继续，不假装完成 | fundIndustryMatrix.js:68；homeRank.js:133 |
| 东财尚未披露目标期 | 「等待披露」状态 + 每日自动检查一次 | homeRank.js:89-92；fundIndustryMatrix.js:337-357 |
| 口径边界 | note 明示：只含前十大重仓股（非全部持仓）、按母基金去重、行业口径为东财归一行业名 | fundIndustryMatrix.js:977-983 |

## 六、逻辑漏洞自查清单（审计用）

- [ ] **母基金去重规则**：baseFundName 循环剥离尾部 1-3 个字母最多 3 轮——检查「华夏成长A」「安信稳健增利C」等是否被正确合并，异常名（如尾部数字）是否漏合并或误合并（fundIndustryMatrix.js:94-100）
- [ ] **展示期回退 modeQ 的风险**：账本未 published 时用「缓存中最多的报告期」——新旧报告期混杂（部分基金已更新、部分未更）时 mode 可能取到旧期，排名混口径——检查当前 period 与 quarter 状态（fundIndustryMatrix.js:863-866）
- [ ] **「同批基金」随时间漂移**：环比样本从 5000 → 8000 只推进过程中，今天的环比与明天的环比不是同一口径——评估是否在 UI 标注「样本 N 只，随披露推进变化」（homeRank.js:213）
- [ ] **持仓市值是报告期时点值**：列头「持仓市值（加总）」易被误读为实时市值——评估加 title「报告期末口径」（fundIndustryMatrix.js:890）
- [ ] **港股与 A 股行业混榜**：港股用 push2delay f127 行业、A 股用申万，两套行业体系同表排名——检查「未分类」里港股占比（fundIndustryMatrix.js:11）
- [ ] **占比分母含未分类**：share = 行业市值 ÷ 纳入基金重仓市值合计（含未分类）——未分类大会压低所有行业占比——检查分母是否应剔除未分类（fundIndustryMatrix.js:922）
- [ ] **GRACE_DAYS_BY_Q 硬编码**：Q2=70 天等宽限期依据披露规则写死——东财披露节奏变化（如系统延迟）会误标「滞后」并提前结束本季——检查 quarter.json 最近记录（fundIndustryMatrix.js:69-72）
- [ ] **detectLatestPeriod 用 6 只探针基金**：探针未更新但其他基金已披露时会漏检——评估探针集大小与更换频率（fundIndustryMatrix.js:336-357）
- [ ] **90 天行业缓存**：公司主业变更/重组后行业归属 90 天后才重解析——检查是否有主动刷新入口（fundIndustryMatrix.js:52）
- [ ] **并发参数与限流**：CONC=3/GAP=80ms 是实测调出来的，换网络环境可能仍被限流——检查 progress.json 的 failed 清单规模（fundIndustryMatrix.js:58-61）
- [ ] **minFunds 参数前端未用**：API 支持按基金数过滤行业，前端没传——评估是否需要（过滤掉仅 1 只基金重仓的噪声行业）（fundIndustryMatrix.js:933-934；server.js:833）
- [ ] **首次访问自动采集**：任何用户打开首页都会触发全量采集（covered==0 且非 running）——确认服务器常驻时才安全，避免每次冷启动都跑（server.js:836-838）
- [ ] **totalValue 含未分类但 KPI 称「可比口径合计市值」**：命名与成分是否一致（fundIndustryMatrix.js:968-970；homeRank.js:171）

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 权益类口径 | RE_EQUITY / RE_EXCLUDE 正则 | fundIndustryMatrix.js:55-56 |
| 采集并发/间隔/重试 | 3 / 80ms / 3 次 | fundIndustryMatrix.js:58-61 |
| 落盘频率 | 每 250 只或 60s | fundIndustryMatrix.js:62-63 |
| 每日检查时刻 | 19:00 | fundIndustryMatrix.js:66 |
| 单批上限/时间预算 | 2500 只 / 20 分钟 | fundIndustryMatrix.js:67-68 |
| 披露宽限天数 | Q1/Q3=40，Q2=70，Q4=100 | fundIndustryMatrix.js:72 |
| 基金宇宙 TTL / 行业缓存 TTL / 负缓存 TTL | 7 天 / 90 天 / 7 天 | fundIndustryMatrix.js:51-52、:358 |
| 前端展示规模 | 前 20 名；Top 股前 5 | homeRank.js:199、:183 |
