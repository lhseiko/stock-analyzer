# 短期行情判断（7 因子 · 枢纽）· 反向逻辑说明

> 逻辑模型位置：个股页 → 第二行评分卡「{M月D日}短期行情」（badge：置信度）+「查看判断逻辑」面板 + 判断记录/准确率链接
> 实现文件：`lib/sameDayJudgment.js`（2378 行主引擎）、`lib/eventEngine.js`（事件因子）、`lib/dedicatedFactor.js`（专属因子）、`public/js/app.js:816-923, 1338-1406`（渲染）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 卡片标题 `#samedayTitle` | `{目标日月}短期行情`（如「10月17日短期行情」），目标日 = targetDate（收盘后=下一交易日，盘中=今天） | app.js:832-835 |
| 置信度 badge `#samedayConfidence` | `高/中/低置信`，配 conf-high/mid/low 配色 | app.js:854-858 |
| 副标题 `#samedayTarget` | `收盘后预判 · 目标：下一交易日走势（M月D日） · 判断时间 HH:MM` | app.js:836-847 |
| 结论 `#samedayVerdict` | `verdict` 文案：涨→看涨 / 跌→看跌 / 震荡→震荡；配色 strong-bullish/strong-bearish/neutral | app.js:849-851 |
| detail `#samedayDetail` | `收盘后预判下一交易日 · 综合分 {score}/100 · 置信度{X} · {行业}` | app.js:853 |
| 准确率行 `#samedayAccuracy` | `该股预测 N 次，命中 M 次，准确率 X%（看涨 a% / 看跌 b%）（次日 c%）· 待结算 k 条 ⚠️n 条过期未结算`；样本不足时显示提示文案 | app.js:861-878 |
| 财报同步行 `#samedayReportSync` | 检测到中报/年报发布事件时显示资料库同步状态（缺库自动触发下载） | app.js:881-896 |
| 「查看判断逻辑」面板 | 因子手风琴：默认展开贡献最大前 3 个因子，其余折叠；每行 = 方向点 + 因子名 + 影响徽章 + 双向贡献条 + 权重% + 贡献分；底部 = 归一化说明 + 结算状态 + 重新判断按钮 | app.js:1338-1406 |
| 因子排序 | 一级按 FACTOR_KEYS 规范顺序（sentiment→capital→futures→holdings→sectorLimit→seesaw→technicalShort），二级按贡献分绝对值降序 | app.js:1347-1353 |
| 结算状态行 | 已结算：`✅ 已结算：{目标} {实际涨跌}%（实际{方向}），判断正确/错误`；未结算：`⏳ 待结算（口径：次日收盘 vs 今日收盘）` | app.js:1382-1385 |
| 记录/准确率链接 | `judgments.html?symbol=`（该股判断记录）、`accuracy.html?tab=sameDay`（准确率核对） | app.js:898-902, index.html:378-379 |
| 跨股污染防御 | 后端返回 judgment.symbol 与请求不符 → 自动 force 重拉一次；仍不符显示警示 | app.js:792-808, 912-921 |

## 二、核心公式 / 判定链

### 2.1 七因子与权重（默认值，Σ=1.0000）

| key | 因子名 | 默认权重 | 出处 |
|---|---|---|---|
| sentiment | 大盘 | 0.2571 | sameDayJudgment.js:1152 |
| capital | 资金量能 | 0.1783 | sameDayJudgment.js:1153 |
| futures | 对标期货短期走势 | 0.0971 | sameDayJudgment.js:1154 |
| holdings | 增持减持 | 0.0985 | sameDayJudgment.js:1155 |
| sectorLimit | 行业板块 | 0.0801 | sameDayJudgment.js:1156 |
| seesaw | 科技指数（负相关） | 0.0632 | sameDayJudgment.js:1157 |
| technicalShort | 个股短期动向 | 0.2257 | sameDayJudgment.js:1158 |

权重演进史：20260917i 删除原「大盘及行业板块短期走势」因子（0.114）后其余 7 因子等比放大至 Σ=1.0000；20260922j 增持减持 +5pp（0.0485→0.0985）、大盘 −5pp（0.3071→0.2571）（sameDayJudgment.js:1146-1151）。

### 2.2 三遍加权（buildJudgment 主链）

1. **第一遍**：7 因子用 `DEFAULT_WEIGHTS` 打分 → `combineFactors` 得初步方向 `firstPass.dir`（sameDayJudgment.js:1715-1716）；
2. **第二遍**：按「个股 + 初步方向」取自适应权重 `getAdaptiveWeights(symbol, dir)`（样本不足按回退链降级，见 2.6）（sameDayJudgment.js:1717-1718）；
3. **第三遍**：事件/专属因子非常驻权重覆盖——常驻因子按 `(1 − 非常驻合计权重)` 等比压缩，非常驻因子各自带有效权重，总和恒 ≤100%（sameDayJudgment.js:1720-1737）。

### 2.3 汇总公式（combineFactors）

- 有效因子 = `applicable:true` 的因子；有效权重 `eff = w / Σw(有效)`（sameDayJudgment.js:1117, 1121）；
- 贡献分 `contribution = round(eff × signal, 3)`；`totalScore = round(Σcontribution, 3)`（sameDayJudgment.js:1122-1128）；
- **方向阈值**：`total > 0.12 → 涨`；`total < −0.12 → 跌`；否则 `震荡`（sameDayJudgment.js:1129-1131）；
- **置信度**（sameDayJudgment.js:1132-1136）：
  - `|total| ≥ 0.4` 且同号因子数 ≥ `ceil(有效因子数 × 0.6)` → **高**；
  - 否则 `|total| ≥ 0.22` → **中**；
  - 其余 → **低**。
- verdict 文案：涨→看涨 / 跌→看跌 / 震荡→震荡（sameDayJudgment.js:263, 1137）。

### 2.4 各因子信号计算口径

| 因子 | 信号计算 | 出处 |
|---|---|---|
| 大盘（sentiment） | 子因子按 w 归一化加权（`Σ(w/Σw)×subSignal`）：① 市场情绪提醒（直接读首页落盘记录，不重算）w=0.25；② 大盘短期走势（所选宽基指数的首页技术短期研判均值）w=0.25；③ 内幕抢跑预警/消息面子因子 w=0.05/项；④ 全网舆情 w=0.10（cnscraper）。无子因子时 signal=0「按中性处理」 | sameDayJudgment.js:295-334, 1160-1165, 555-567 |
| 资金量能（capital） | 复用 `analyzeCapitalFlow` 结论 `c.signal` 与换手率变化/融资余额/量能活跃度融合：四者齐 `0.70×c + 0.11×tc + 0.09×margin + 0.10×vol`；缺量能活跃度时 0.78/0.12/0.10；仅换手率 0.85/0.15；仅融资 0.86/0.14；仅 vol 0.90/0.10 | sameDayJudgment.js:396-412 |
| 对标期货 | 期货近 5 日涨跌幅 `shortChg`（±4% 满格）× 相关性强度（|corr|≥0.6→1 / ≥0.35→0.7 / ≥0.15→0.4 / 其余 0.2）× **相关性符号**（负相关反向传导）；无对标期货 → `applicable:false` 不参与 | sameDayJudgment.js:429-461 |
| 增持减持 | 主信号 `0.55×方向信号 + 0.45×力度信号`（方向=(增−减+回购加成)/总户数；力度=净变动/3% 满格）；叠加被动减持困境溢价 `+0.2×forcedSignal`（确认被动减持 −0.8 / 仅冻结预告 −0.6） | sameDayJudgment.js 增持减持因子 |
| 股份回购（子模块） | 东财回购报表四要素：数据日期 / 已回购数量与金额 / 承诺回购金额 / 进度。**完成/停止/否决 → 中性**（买盘已结束）。<br>**20261021i 两条修正**：① **历史闸门**——方案完结超 `HISTORICAL_DAYS=730` 天即标「历史方案」，卡片主语改为「当前无进行中的回购」，旧方案降为脚注（000902 曾把 2021-07-23 的老方案当当前状态）；② **未足额区分**——「完成实施」但实际只到承诺上限 <95% 时，措辞为「已结束（未足额）…实际回购为承诺上限的 24%，未达承诺下限 3.00 亿元」，**不得**再说「承诺买入力量已用尽」 | lib/buybackEmDc.js；测试 scripts/test_buyback_plan.js |
| 行业板块 | `0.45×涨跌停占比差 + 0.35×行业短期走势 + 0.20×板块消息`；涨跌停差 signal=(涨停比−跌停比)×20 | sameDayJudgment.js:968-974, 1161-1163 |
| 科技指数（负相关） | 科技/半导体板块当日整体涨跌 composite → **反向**映射：死区 ±0.3% 内 signal=0，否则 `−clamp(composite/3.0, ±1)`；个股本身属科技/半导体 → `applicable:false`（避免自相关） | sameDayJudgment.js:1000-1050, 168-169 |
| 个股短期动向 | 主信号 `dirScore/3`（价格行为 7 档方向量化，与技术面分析页同一次快照）；子因子展示：短期动向预判 w=0.50、舆情与讨论热度（个股）w=0.30、财报解读 w=0.10（联动深度分析） | sameDayJudgment.js:1069-1112, 1165-1167 |

### 2.5 目标日与判断时点

- 收盘后（≥15:00 或非交易日）：预测**下一交易日**，基准 = `referenceCloseDate`（当天自身收盘，sameDayJudgment.js:248-261, 1743-1746）；
- 盘中：预测**今日后续**，基准 = 上一交易日收盘；
- 持久化键 = `targetDate`，同一 (symbol, targetDate) 只保留一条记录，收盘后多次刷新覆盖同一目标日（sameDayJudgment.js:1814-1815）。

### 2.6 自学习层（错误学习 / 自适应权重）

| 参数 | 值 | 出处 |
|---|---|---|
| 单因子样本下限 | `LEARN_MIN_SAMPLE = 5`（低于此不调整） | sameDayJudgment.js:1200 |
| 目标权重公式 | `target = clamp(base × (0.5 + 命中率), 0.03, 0.6)` | sameDayJudgment.js:1253 |
| 平滑系数 | `LEARN_SMOOTH = 0.4`（新权重 = 旧×(1−0.4) + target×0.4，保留 4 位小数） | sameDayJudgment.js:1201, 1254 |
| 归一 | 每桶算完后按 Σ 归一（4 位小数） | sameDayJudgment.js:1259-1260 |
| 桶结构 | 全局 + 按预测方向（涨/跌/震荡）+ 每只股票独立（含其按方向） | sameDayJudgment.js:1208-1221, 1239-1243 |
| 回退链（getAdaptiveWeights） | ① 该股该方向专属权重（样本≥10）→ ② 该股全局（≥10）→ ③ 全局该方向（≥10）→ ④ 全局默认 | sameDayJudgment.js:1293-1306 |
| 重建方式 | `backfillLearning` 从全部已结算记录**幂等重建**（不依赖单条标记位，防跨进程丢失） | sameDayJudgment.js:1307-1317 |
| 命中判定 | 预测「震荡」时实际涨跌幅 ≤1.0% 算命中；否则方向相同算命中 | sameDayJudgment.js:1973, 1999 |

### 2.7 非常驻因子（事件 / 专属）权重封顶

- **事件因子**（eventEngine）：分级权重 major 0.40 / moderate 0.12 / minor 0.03；**合计封顶 `maxCombinedEventWeight = 0.40`**（eventEngine.js:96, 130, 895）；类型硬上限防「研报观点=重大」越级（eventEngine.js:566-581）；
- **专属因子**（dedicatedFactor，如海天味业 CPI·食品烟酒）：mergeNonResidentOverrides 把事件+专属合计 **封顶 0.95（常驻至少保留 5%）**（dedicatedFactor.js:200-210）；
- 衰减：专属因子有效权重 = `base×(1 − r^decayExp)`（r=已过去/窗口，decayExp=2，短期 3 天/长期 15 天），衰减到 0 自动归档隐藏（dedicatedFactor.js:82-91, 36-53）。

### 2.8 schema 守卫（缓存复用闸门）

- `SCHEMA_VERSION = 'h' + FNV1a哈希({FACTOR_KEYS, DEFAULT_WEIGHTS}) + '-' + LAYOUT_VERSION`（sameDayJudgment.js:1187-1197）；
- 因子增删/改名/默认权重变化 → 哈希自动变 → 旧记录判「旧 schema」强制重算；纯展示布局/口径调整 → 手动 +1 `LAYOUT_VERSION`（当前 `20260922c`，变更史见同文件注释）；
- 复用条件：`rec.targetDate===当前 && rec.target===当前 && !force && 无异常文本 && schemaVersion 一致 && !stale && !earningsFresher`（sameDayJudgment.js:2166）。

## 三、指标 / 因子口径

| 指标/因子 | 口径（原始值怎么算） | 归一化 | 是否进总分 | 出处 |
|---|---|---|---|---|
| 7 因子 signal | 见 2.4 | clamp[−1,1] | 是（eff×signal） | sameDayJudgment.js:1121-1123 |
| 有效权重 effectiveWeight | w/Σw(有效因子) | Σ=1 | 展示 + 计分 | sameDayJudgment.js:1121 |
| 贡献分 contribution | eff×signal | round 3 位 | 展示 + 求和 | sameDayJudgment.js:1122 |
| 综合分 score | `round(totalScore×100)`（±100） | — | 卡片主显示 | sameDayJudgment.js:1761 |
| 置信度 | 幅度 + 同号比例双条件 | 三档 | 展示 | sameDayJudgment.js:1134-1136 |
| 震荡命中容差 | \|实际涨跌\| ≤ 1.0% | — | 准确率结算 | sameDayJudgment.js:1973 |
| 结算基准 | 基准日收盘价（referenceDate 优先，多级回退）vs 目标日收盘 | — | 准确率结算 | sameDayJudgment.js:1945-1971 |
| 事件因子权重 | 分级固定权重 × 衰减 | ≤0.40 | 是（第三遍） | eventEngine.js:895 |
| 专属因子权重 | base × (1−r²) | ≤0.95 合计 | 是（第三遍） | dedicatedFactor.js:83-91, 202 |

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | ① 行情/K 线：腾讯 qt.gtimg.cn + ifzq 前复权日 K；② 市场情绪：lib/marketEmotionModel 落盘记录（与首页同源）；③ 资金量能：东财资金流/融资融券；④ 期货：对标期货相关性（futuresData）；⑤ 股东：东财 F10 增持减持 + 公告流被动减持检测 + 结构化回购报表；⑥ 行业板块：板块涨跌停统计 + 行业走势 + 板块消息；⑦ 科技指数：科技/半导体板块当日涨跌；⑧ 价格行为：lib/priceAction（priceActionHub 唯一出口，与技术面页同快照）；⑨ 事件：eventEngine（新闻→事件→权重再平衡）；⑩ 专属：dedicatedFactor（海天 CPI） |
| 采集/落盘 | 判断记录落盘 `data/judgments/{targetDate}.json`（每 symbol 一条，带 schemaVersion）；学习状态落盘 `data/learning/state.json`；事件/专属激活实例落盘 `data/dedicatedFactors/active.json` |
| 调度 | 用户打开个股页/点「重新判断」触发；收盘后 15:30 盘后结算（settleAll）；专属因子每月 8-13 日窗口触发（dedicatedFactor.js:240-246） |
| 前端取数 | `GET /api/sameday-judgment/:symbol?name=&industry=`（默认复用缓存）；`&refresh=1` 强制重算（app.js:784, 796） |

## 五、降级 / 容错 / 诚实性设计

| 场景 | 行为 | 诚实性评价 |
|---|---|---|
| 单因子数据缺失 | 多数因子 `applicable:true` 但 signal=0 + detail「XX数据不足，按中性处理」（如资金量能、市场情绪、行业走势） | 诚实（detail 明示），但 **0 信号仍占权重**（归一化后其他因子被稀释，见清单 J3） |
| 对标期货不适用 | `applicable:false`，不参与归一化与计分 | 诚实（权重让位） |
| 科技股不适用跷跷板 | `applicable:false`，detail 说明「被参照一方」 | 诚实 |
| 判断接口失败 | `success:false` → 卡片 `—` +「判断失败：{error}」 | 诚实 |
| 跨股污染 | symbol 不一致自动重拉 + 仍不符显示警示框 | 诚实 |
| 异常文本泄漏防护 | `_judgmentHasRawException` 检测 detail 含网络异常堆栈 → 判「异常文本」强制重算；`_sanitizeSectorNote` 过滤主机名/堆栈 | 诚实 |
| 最终一致性防线 | judgment.symbol/industry 与入参不一致直接抛错不落盘 | 安全 |
| 过期未结算 | 准确率行显示 `⚠️n 条过期未结算`（computeAccuracy 标记 targetDate 已过仍未结算） | 诚实（sameDayJudgment.js:2055-2056） |
| 财报事件→资料库缺口 | 自动触发下载 + 卡片显示「正在自动同步」 | 诚实 |

## 六、逻辑漏洞自查清单（审计用）

- [ ] **J1 消息面子因子永动中性占位**：`newsParts` 中「消息情绪（大盘）」已删、「财报解读」已迁出，代码显式 skip（sameDayJudgment.js:307-308）；若上游仍传默认 w=0.05 的空 parts，会在「大盘」因子内占权重。需核实 computeNewsFactor 实际返回的 parts 构成（⚠️ 待核实：本次未逐行追 computeNewsFactor 输出）。
- [ ] **J2 三处震荡容差口径不一**：个股短期判断命中容差 1.0%（sameDayJudgment.js:1973/1999）；大盘技术 marketTechJudgment 容差 0.5%（home-03 文档）；logicModel TREE 描述 0.5%。同一「震荡命中」概念两套数值，跨模块准确率不可直接互比。
- [ ] **J3 中性占位稀释**：数据缺失因子 signal=0 但 applicable=true → 归一化后有效权重被缺失因子「摊薄」约 1/N；例如仅 5/7 因子有数据时，有数据因子权重被压到约 5/7。detail 有说明但卡片不显示「本日 N/7 因子有效」。
- [ ] **J4 自学习样本下限内外部描述不一**：代码 `LEARN_MIN_SAMPLE=5`（sameDayJudgment.js:1200），而首页市场情绪模块文案写「需累计 20 次以上预测样本」（app.js:1101，属另一模块）、长期模块无自学习。用户对比两卡会得到矛盾印象。
- [ ] **J5 自学习回退链阈值 10 vs 调整阈值 5**：调整用 ≥5 样本，回退链取专属权重用 ≥10 样本（sameDayJudgment.js:1300-1304）——5~9 样本的因子已参与权重计算但不足以上岗「专属权重」，中间态行为需文档化。
- [ ] **J6 事件封顶两级不一致**：事件单独合计封顶 0.40（eventEngine.js:130）；事件+专属合并后封顶 0.95（dedicatedFactor.js:202）——两条路径上限不同，且 0.95 意味着非常驻因子最多可挤占常驻 95%，与「常驻为主」的设计语义需持续评估。
- [ ] **J7 事件权重对旧记录的追溯**：事件触发后 `changedSymbols` 机制会重算该股判断（dedicatedFactor.js:283/289），但事件引擎侧的记录刷新路径需与 schema 守卫配合，避免「清了事件、页面仍显示旧事件」（20260921a 曾修此类，属持续盯项）。
- [ ] **J8 第一遍方向决定第二遍权重桶**：`firstPass.dir` 若落在阈值边界（±0.12 附近），微小数据抖动会切换权重桶（涨/跌/震荡三套专属权重），可能导致结论跳变。权重桶切换无滞回设计。
- [ ] **J9 盘中判断的 target=today 与结算竞态**：盘中记录 `targetDate=今天`，settleRecord 对「目标日=今天且未收盘」暂不结算（sameDayJudgment.js:1944）；若当天始终未生成判断（如服务中午重启），该日无记录，准确率分母缺一天。
- [ ] **J10 结算基准多级回退的隐含口径**：基准价优先 referenceDate 收盘 → rec.date 收盘 → 最近上一交易日收盘 → 预判时价（sameDayJudgment.js:1945-1968）；旧记录回退到「预判时价」时，与「次日收盘 vs 今日收盘」的展示口径（app.js:1382）实际不同，卡片不区分。
- [ ] **J11 置信度「高」的同号比例门槛**：`agree ≥ ceil(used×0.6)`（sameDayJudgment.js:1135）——4 个有效因子时需 3 个同号；若其中 2 个是 signal=0 的占位因子，同号判定把 0 排除（`f.signal !== 0`，:1132），占位因子变相降低达标难度。
- [ ] **J12 权重归一化掩盖「实际可用因子少」**：卡片 footnote「权重按当日可用因子自动归一化；对标期货不适用时不参与打分」（app.js:1400）只提了期货，未提其他 signal=0 占位因子（对照 J3）。
- [ ] **J13 技术因子 dirScore/3 的满格假设**：`dirScore` 量级约 ±3.5，/3 限幅（sameDayJudgment.js:1081）；若价格行为页调整档位数或量级，此处魔数 3 需同步（两模块耦合无断言保护）。
- [ ] **J14 子因子 w 与父因子 signal 的双轨制**：子因子有权重 w（仅展示/归一），父因子 signal 另按硬编码比例融合（如 capital 0.70/0.11/0.09/0.10）——子因子 w（如 EMOTION_SUB_W 0.25）与父内融合比例不是同一套数，审计时容易混淆（子因子 w 用于 sentiment 类父因子内归一，capital 的融合比例是代码硬编码）。
- [ ] **J15 结算时间依赖**：准确率「每日 15:30 盘后结算」（sameDayJudgment.js:1742 注释），若结算任务未跑（服务不在线），记录长期 pending；卡片有「过期未结算」提示但无自动补算按钮（需打开页面触发 settleSymbol）。
- [ ] **J16 LAYOUT_VERSION 手工升版依赖**：展示/口径类变更（哈希不捕获）必须手动 +1 LAYOUT_VERSION，漏升则旧快照静默复用（20260921c/j 等多次踩过）；建议在发布 checklist 中固化「改 sameDay 展示→升 LAYOUT_VERSION」一步。

## 七、可配置项

| 配置 | 默认值 | 位置 |
|---|---|---|
| 方向阈值 | ±0.12 | lib/sameDayJudgment.js:1130-1131 |
| 置信度阈值 | 高：\|total\|≥0.4 且同号≥60%；中：≥0.22 | lib/sameDayJudgment.js:1135-1136 |
| 7 因子默认权重 | 见 2.1 | lib/sameDayJudgment.js:1152-1158 |
| 子因子权重 | 大盘短期 0.25 / 市场情绪 0.25 / 行业趋势 0.35 / 板块消息 0.20 / 涨跌停差 0.45 / 个股舆情 0.30 / 财报解读 0.10 / 短期动向 0.50 | lib/sameDayJudgment.js:1160-1167 |
| 自学习样本下限 | 5 | lib/sameDayJudgment.js:1200 |
| 自学习平滑 | 0.4 | lib/sameDayJudgment.js:1201 |
| 目标权重钳制 | [0.03, 0.6] | lib/sameDayJudgment.js:1253 |
| 回退链样本门槛 | 10 | lib/sameDayJudgment.js:1300-1304 |
| 事件合计封顶 | 0.40（major 0.40 / moderate 0.12 / minor 0.03） | lib/eventEngine.js:96, 130 |
| 非常驻合并封顶 | 0.95 | lib/dedicatedFactor.js:202 |
| 专属因子（海天 CPI） | 短/长期各 10%，衰减 3/15 天，exp=2，触发窗口每月 8-13 日 | lib/dedicatedFactor.js:36-53 |
| 震荡命中容差 | 1.0% | lib/sameDayJudgment.js:1973, 1999 |
| SCHEMA_VERSION | `h{因子结构哈希}-20260922c` | lib/sameDayJudgment.js:1196-1197 |
