/**
 * 工作台逻辑模型（LogicModel）
 * ------------------------------------------------------------------
 * 20261006a 新增：以「总 — 分」树状结构呈现整个工作台的逻辑框架。
 * 20261013h 重构：改为「按工作台页面布局」组织 —— 先看有哪几个页面，每个页面有哪
 *   些模块，每个模块的「判定逻辑」是什么，以及模块之间「数据来源 / 输出去向」的
 *   共享与引用关系。底层数据源、API、AI 叙事、规则守卫等不隶属单一页面、被多页共享
 *   的部分，归入「跨页面公共支撑」。
 *
 * 设计原则（与项目铁律一致）：
 *   ① 纯静态结构数据 + 纯前端渲染：不请求后端、不调用大模型 —— 结构本身是确定性事实，
 *      由代码写死，不需要 AI 参与（「1+1=2 由代码执行」）。
 *   ② 零副作用：不改动任何既有模块；弹层独立于 app.js 的弹窗体系（自带 Esc / 遮罩关闭）。
 *   ③ 节点内容全部来自项目真实清单（lib/、routes/、server.js 路由、public 页面与 tab、scripts 守卫）。
 *
 * 节点字段：name 名称 / desc 说明 / badge 角标 / icon 图标（仅 L1）/ children 子节点
 *           logic 判定逻辑（字符串或数组）/ inputs 数据来源（数组）/ outputs 输出去向（数组）
 *
 * 维护约定：模块增删后同步更新下方 TREE；判定逻辑与数据流描述须与真实代码一致（反漂移守卫见 scripts/test_logic_model.js）。
 */
(function (global) {
  'use strict';

  // ================= 逻辑框架数据（按页面布局） =================
  // L1 = 页面 / 区域；L2 = 页面内模块（卡片 / tab / 子系统）；L3 = 细项。
  var TREE = {
    name: '股票投资分析工作台',
    desc: '按工作台真实页面布局组织：每个页面 → 页面内模块 → 每个模块的「判定逻辑」与「数据来源 / 输出去向」。不隶属单一页面、被多页共享的后端能力归入「跨页面公共支撑」。确定性数值一律由代码计算，大模型只负责叙事。',
    children: [
      // ========================== 页面一：首页 ==========================
      {
        icon: '🏠', name: '首页', badge: '9 张卡片',
        desc: '左侧选中「首页」（未选个股）时展示的 9 张市场级卡片；全部为收盘 / 实时口径，可折叠，折叠状态本地持久化。',
        children: [
          {
            name: '📡 市场情绪提醒', badge: '9 因子',
            logic: '9 因子加权（量能活跃与量价配合 25〔=原量能活跃度 15 + 量价配合度 10 加权合并〕 / 市场宽度 / 涨跌势头 / 融资余额 / 主力资金 / 讨论热度·反向 / 避险情绪 / 国内宏观 / 美国宏观），权重 5%~30% 有界夹紧 + 降级归零分摊 + 自学习 → 情绪倾向（看涨 / 中性 / 看跌，总分 ±0.2 阈值）与六档仓位建议及拐点提醒。',
            inputs: ['上证量价 / 涨跌家数与涨跌停', '融资余额 / 主力净额 / 换手集中度', '国内宏观指标', '美国宏观事件', '股吧讨论热度（反向因子）'],
            outputs: ['首页情绪面板展示', '落盘市场情绪判断 → 准确率台账', '被个股页「短期行情」的大盘因子单源引用（读落盘、不重算）']
          },
          {
            name: '📈 实时大盘',
            logic: '三大 A 股指数 + 美股 + 热门板块实时报价与涨跌幅；红涨绿跌；可选「✨ AI 解读」联网解读大盘。',
            inputs: ['腾讯 qt.gtimg.cn 实时行情', '东财 push2 板块 / 涨跌家数'],
            outputs: ['首页实时大盘展示']
          },
          {
            name: '🧭 大盘技术分析（融合版）',
            logic: '上证 / 深证 / 创业板指，收盘后技术面推演（趋势 / 形态 / 量价 / 指标 / 支撑压力 / 背离 / 结论），指标取 SMA/EMA/RSI/MACD/BOLL/KDJ/ADX，并融合宏观新闻 → 多空结论。',
            inputs: ['三大指数日 K（腾讯 / 新浪）', '技术指标（lib/analysis）', '宏观新闻（lib/macroNews）'],
            outputs: ['首页技术分析展示', '落盘大盘技术判断 → 准确率台账', '被个股页「短期行情」的大盘因子引用（getMarketTechnical）']
          },
          {
            name: '📊 大盘估值趋势',
            logic: '上证 50 / 沪深 300 / 科创 50 近 5 年 PE-TTM 序列 → 当前历史百分位（近5年分位，仅展示分位与趋势，不输出评级档位）。',
            inputs: ['三大宽基指数 PE-TTM 历史序列'],
            outputs: ['首页估值趋势展示']
          },
          {
            name: '🧮 行业板块拥挤度',
            logic: '板块成交额 ÷ 全市场成交额 = 拥挤度；按今日 / 本周 / 本月区间累计，取前五名。',
            inputs: ['板块成交额', '全市场成交额'],
            outputs: ['首页拥挤度展示']
          },
          {
            name: '🔥 今日财经热点',
            logic: '东财 7×24 快讯 → 关键词四类分类（政策 / 国际 / 公司 / 市场）+ analyzeSentiment 情绪 → 板块影响识别（▲ / ▼ 板块 · 热门个股，打分制+强排除+境外闸门）；纯确定性计算，无 LLM、无涨停板池。',
            inputs: ['东财 7×24 快讯（np-listapi）', '东财内容搜索（快讯不可用时兜底）', '板块关键词映射（NEWS_SECTOR_MAP）'],
            outputs: ['首页热点展示', '新闻 → 事件 → 事件驱动引擎权重再平衡']
          },
          {
            name: '🔥 板块舆情热度周榜',
            logic: '自然周统计，五指标（讨论热度 / 资金流 / 涨幅 / 涨停数 / 新闻量）加权 → 板块热度排名；热度 ≠ 涨跌预测。',
            inputs: ['多源舆情（东财股吧 / 同花顺 / 雪球 / 新浪）', '板块资金流'],
            outputs: ['首页周榜展示']
          },
          {
            name: '🌐 每日宏观 & 政策',
            logic: '国内宏观 / 政策每日采集；美国宏观按三值（公布 / 预期 / 前值）→ 偏离判定（above / inline / below）→ 双维度（经济影响 + 股市偏好）分开标注；国内指标转情绪因子。',
            inputs: ['华尔街见闻宏观三值', 'FedRateCalc 排期', '国内宏观指标（社融 / LPR / 中债 10 年 / 离岸人民币）'],
            outputs: ['首页宏观与政策展示', '宏观情绪因子 → 市场情绪模型的国内 / 美国宏观因子（数据共享）']
          },
          {
            name: '🏭 基金行业配置名单',
            logic: '全市场权益类基金最新季报前十大重仓股 → 按行业持仓市值加总排名，取前 20 名 + 季度环比变化。',
            inputs: ['全市场基金持仓季报'],
            outputs: ['首页行业配置名单展示']
          }
        ]
      },

      // ========================== 页面二：个股页 ==========================
      {
        icon: '📈', name: '个股页', badge: '10 tab',
        desc: '左侧选中某只个股后进入；顶部常驻「股价 + K 线 + 评分区」，下方 10 个 tab。',
        children: [
          {
            name: '顶部常驻区', badge: '随页面滚动',
            desc: '股票头部（公司名 + 实时股价 + 行情 / 财务双日期）+ 主图 K 线（日 / 周 / 月 / 60 分钟）+ 关键指标条。',
            inputs: ['腾讯实时报价', '日 / 周 / 月 / 60 分钟 K'],
            outputs: ['个股页头部与主图展示']
          },
          {
            name: '评分行：技术面 / 基本面 / 资金热度 / 个股近期热点',
            desc: '三张可点击评分卡（点开看计算依据）+ 个股近期热点归因卡。',
            logic: '技术面评分、基本面评分、资金热度分别由确定性模型打分；个股近期热点按「涨跌幅 ≥3%」或「振幅 >3%」触发联网归因。',
            inputs: ['技术指标 / 财务快照 / 资金流', '实时行情（涨跌幅 + 振幅）'],
            outputs: ['评分卡与热点卡展示', '评分供综合结论']
          },
          {
            name: '行业前景评分',
            logic: [
              '取数：行业身份（sectorIdentity 单一可信源）+ 公司 / 行业研报（东财近 365 天）+ 内置政策库 INDUSTRY_POLICY（19 条）',
              '政策匹配：行业名 + 细分名拼接，按关键词 includes 顺序匹配，第一个命中即定级；未命中兜底「中性」',
              '等级 → 评级映射：国家战略扶持→优秀 / 战略扶持→良好 / 受限→较弱 / 中性→一般',
              '结论：只输出评级文字（优秀 / 良好 / 一般 / 较弱），不输出 0–100 数字分'
            ],
            inputs: ['行业身份（sectorIdentity）', '公司 / 行业研报（东财 reportapi）', '政策库（INDUSTRY_POLICY 19 条）'],
            outputs: ['行业前景评分卡展示', '评级供「长期行情」的行业前景因子引用']
          },
          {
            name: '短期行情判断', badge: '7 因子 · 枢纽',
            logic: [
              '取数（7 因子）：大盘=首页落盘情绪+大盘短期走势+内幕抢跑+全网舆情；资金量能=capitalFlow 主力净流入+量价+融资余额变化+换手率变化+量能活跃度；对标期货=相关性+近 5 日涨跌；增持减持=前十大股东增减持+股份回购；行业板块=涨跌停占比+行业短期走势+板块消息；科技指数=科技/半导体当日涨跌（负相关，3% 满格 / 0.3% 死区）；个股短期动向=价格行为 shortTerm+个股舆情+财报解读',
              '每因子算 signal∈[-1,1]，contribution = 有效权重 × signal',
              '加权汇总 totalScore = Σ contribution（默认权重 Σ=1：大盘 0.2571 / 个股短期动向 0.2257 / 资金量能 0.1783 / 增持减持 0.0985 / 对标期货 0.0971 / 行业板块 0.0801 / 科技指数 0.0632；命中率低的因子自学习降权）',
              '定方向：total>0.12→看涨；total<-0.12→看跌；否则中性',
              '定置信度：|total|≥0.4 且同号因子≥60%→高；|total|≥0.22→中；否则低',
              '事件 / 突发：eventEngine 对既有因子等比例压缩、绝不删因子、总和恒 100%',
              '结算：每票每日 15:30 盘后按次日 K 线收盘核对，累计准确率'
            ],
            inputs: ['大盘（读首页落盘）', '资金量能', '对标期货', '增持减持', '行业板块', '科技指数', '个股短期动向', '事件引擎权重'],
            outputs: ['短期行情卡展示（可展开逐因子明细）', '留档 → 判断记录 / 准确率台账']
          },
          {
            name: '长期行情判断', badge: '5 因子',
            logic: [
              '取数（9 路并行）：实时行情、行业政策 + 研报、行业身份、对标期货长期、4 指数 60 日涨跌、所属板块（akshare）、日 / 月 K（≥250 根）、大盘中期研判、基本面分',
              '5 因子 signal∈[-1,1]：公司基本面（权重 0.28，(fundScore-50)/50）、行业前景（0.20，政策 level 映射）、对标期货长期（0.12，futuresChg/15×相关性）、大盘及行业中长期（0.20，0.6×指数 + 0.4×板块）、个股长期趋势（0.20，价格行为 longTerm.score/4）',
              '加权汇总 total = Σ（有效权重 × signal）',
              '定方向：total>0.12→看多；total<-0.12→看空；否则中性',
              '定置信度：|total|≥0.35 且同号因子≥60%→高；|total|≥0.2→中；否则低',
              '事件 / 专属因子可等比例压缩既有 5 因子（总和恒 100%）；score=round(total×100)；不核算准确率（长周期）'
            ],
            inputs: ['实时行情', '行业政策与研报', '对标期货长期', '4 指数 60 日涨跌', '所属板块（akshare）', '日 / 月 K（≥250 根）', '基本面分'],
            outputs: ['长期行情卡展示（可展开逐因子明细）']
          },
          {
            name: '最大亮点 / 雷点',
            logic: [
              '取数：AI 联网（妙想资讯源优先，失败回退通用搜索）+ 注入东财 F10 权威财务快照 + 公司概况 + 最新报告期',
              'Prompt 约束：只出 JSON，亮点 / 雷点各 3–6 条；涉财必须给「最新值 + 环比 + 同比」；金融 / 保险类禁用 DCF 作亮点',
              '后置校验：引用过期财报→标记 outdated；资产负债率与权威值偏差 >1 个百分点→纠正为权威值',
              '「最大」= AI 返回数组第 1 条（highlights[0] / risks[0]，截断 70 字），无二次排序',
              '用户可在笔记里手动指定主项（setAsMain），优先于 AI 首位'
            ],
            inputs: ['AI 联网（妙想资讯源）', '东财 F10 财务快照', '公司概况', '最新报告期'],
            outputs: ['亮点 / 雷点卡（aspectCard）展示']
          },
          {
            name: '📊 简介',
            logic: '公司档案、主营构成、分产品收入展示；公司概况注入 AI 分析。',
            inputs: ['公司概况（东财 F10）', '主营构成数据'],
            outputs: ['简介 tab 展示', '公司概况供 AI 深度 / 估值注入']
          },
          {
            name: '📈 技术面',
            logic: '多指标技术分析 + 价格行为快照（priceActionHub）→ 技术面评分与买卖点。',
            inputs: ['日 / 60 分钟 K', '技术指标（lib/analysis）', '价格行为快照'],
            outputs: ['技术面 tab 展示', '价格行为快照被「短期行情」的短期动向因子共用（指标级单源）']
          },
          {
            name: '💰 基本面',
            logic: '财务指标评分 + 财务趋势；注入权威快照并对 AI 输出数字做偏差校验（>1 个百分点纠正为权威值）。',
            inputs: ['东财 F10 财务快照', 'financeHub'],
            outputs: ['基本面 tab 展示', '基本面评分', '财务数据供 AI 分析并校验']
          },
          {
            name: '👥 股东分析',
            logic: '股东户数走势 / 机构持仓变化 / 十大股东 / 基金持股；按报告期口径核对。',
            inputs: ['东财 F10 股东数据'],
            outputs: ['股东分析 tab 展示', '公司概况供 AI（companyDeep / augmentStock）引用']
          },
          {
            name: '🔬 深度分析',
            logic: '财报解读四链路（财报 / 分红 / 收益率 / 结论）确定性计算；结论联动专属估值模型（valuationHub 唯一出口）。',
            inputs: ['财报数据（deep/pipeline / financials / dividends）', '年报 PDF 文本抽取', '专属估值模型'],
            outputs: ['深度分析 tab 展示', '财报解读被「短期行情」的财报解读因子联动（口径一致）', '结论供 AI 引用']
          },
          {
            name: '🏭 行业分析',
            logic: '所属板块行情 / 资金流 / 估值 → 行业前景评分；申万层级统一口径。',
            inputs: ['industryAnalysis', '板块趋势与资金流', '申万行业字典'],
            outputs: ['行业分析 tab 展示', '行业前景评分', '行业板块因子供「短期行情」']
          },
          {
            name: '💹 资金量能',
            logic: '主力 / 北向 / 融资融券 / 大宗资金流分析 → 资金热度评分。',
            inputs: ['capitalFlow', '东财资金流'],
            outputs: ['资金量能 tab 展示', '资金热度评分', '资金量能因子供「短期行情」']
          },
          {
            name: '⭐ 个股亮点/雷点',
            logic: '笔记模块，亮点 / 雷点结构化记录（支持全局 / 大盘 / 个股作用域）。',
            inputs: ['用户笔记', '分析结论'],
            outputs: ['亮点 / 雷点卡（aspectCard）展示']
          },
          {
            name: '📁 资料库',
            logic: '年报 PDF 等资料上传与自动分类；本地资料库供财报文本抽取。',
            inputs: ['用户上传 PDF', 'data/companies/<代码>/annual'],
            outputs: ['资料库 tab 展示', '资料供深度分析 / 财报解读抽取']
          },
          {
            name: '🎯 策略',
            desc: '策略生成器 + 回测校验：生成候选策略并跑历史回测，输出风险修正后的结果。',
            logic: '策略生成器（5 类候选：趋势跟踪 / 均值回归 / 动量轮动 / 价值基本面 / 事件驱动）+ 回测校验（6 步风险闸门：平稳性 / 前视 / 成本 / 趋势 / 过拟合 / 幸存者）。',
            inputs: ['60 分钟 K 线回测序列'],
            outputs: ['策略与回测 tab 展示']
          }
        ]
      },

      // ==================== 跨页面公共支撑（多页共享） ====================
      {
        icon: '🔗', name: '跨页面公共支撑', badge: '多页共享',
        desc: '不隶属单一页面、被首页与个股页等共同消费的后端能力；这里是数据流的中枢。',
        children: [
          {
            name: '🗄️ 数据源接入', badge: '单一权威源',
            desc: '同一口径只走一条权威通道；每项数据带「来源 / 日期 / 口径 / 单位 / 样本」五要素与 TTL 时效标注。',
            children: [
              { name: '行情通道', desc: '腾讯 qt.gtimg.cn（主）/ 新浪长历史 / 60 分钟 K / 东财 push2（连败 10 分钟静默）' },
              { name: '东财数据中心报表', desc: 'RPT_INDUSTRY_FUNDFLOW / RPTA_WEB_GETHGLIST_NEW / RPT_VALUEANALYSIS_DET / RPT_VALUEINDUSTRY_DET' },
              { name: '基本面 / 公告', desc: '东财 F10 快照 / 巨潮资讯公告 / 本地年报资料库' },
              { name: '宏观 / 资金面', desc: 'market_emotion.py / 央行与利率（社融 / LPR / 中债 10 年 / 离岸人民币）' },
              { name: '舆情 / 讨论热度', desc: '东财快讯 / 股吧热度（反向因子）/ 多源交叉' }
            ]
          },
          {
            name: '🔌 API 层', badge: 'server.js 主路由',
            desc: '前端一切数据只通过 API 获取；server.js 主路由 + routes/ 子模块。',
            children: [
              { name: 'routes/aiRoutes.js', desc: 'AI 分析 / 妙想鉴权取数 / 券商分类与估值' },
              { name: 'routes/dedicatedFactor.js', desc: '专属因子查询 / 触发 / 清理' },
              { name: 'routes/docsRoutes.js', desc: '资料库上传与自动分类' },
              { name: 'routes/eventRoutes.js', desc: '事件池查询与刷新' }
            ]
          },
          {
            name: '🤖 AI 叙事层', badge: '只叙事不估算',
            desc: '大模型只把确定性计算结果讲成人话；所有数字以代码输出为准；SA_NO_BG_AI 默认禁后台定时任务防静默计费。',
            logic: '双模型分离（联网 / 本地）；联网搜索通道按免费额度自动回退；注入东财 F10 权威快照并校验数字；SA_NO_BG_AI 默认禁后台定时任务防静默计费。',
            inputs: ['确定性计算结果', '东财 F10 快照', '本地事实库（研报 / 公告 / 概况）'],
            outputs: ['AI 解读 / 摘要（个股与大盘）', '估值 / 财报解读叙事']
          },
          {
            name: '⚙️ 事件驱动引擎', badge: '权重再平衡',
            logic: '新闻 → 事件 → 权重再平衡 → 影响评分；只等比压缩既有因子、绝不删因子，权重总和恒 100%，事件结束自动恢复；黑名单事件（LPR / 逆回购 / 公开市场操作 / MLF）直接剔除，降准降息类封顶 moderate；讨论热度为 0 则降级。',
            inputs: ['新闻 / 事件', '既有因子权重'],
            outputs: ['再平衡后的因子权重 → 短期行情判断', '今日财经热点的板块影响']
          },
          {
            name: '🎯 专属估值模型库', badge: '10 只 + 基座',
            desc: '专属估值模型（10 只）+ brokerModel 共用基座；valuationHub 唯一出口；每只股票独立估值协议，输入锁死、无 LLM、方法各自独立。',
            children: [
              { name: '海天味业 603288', desc: '专属估值协议' },
              { name: '中国平安 601318', desc: 'P/EV + DDM + SOTP' },
              { name: '圣湘生物 688289' }, { name: '士兰微 600460' }, { name: '华安证券 600909' },
              { name: '长江证券 000783' }, { name: '麦捷科技 300319' }, { name: '万润股份 002643' },
              { name: '新洋丰 000902' }, { name: '电气风电 688660' }
            ]
          },
          {
            name: '📊 准确率闭环', badge: '越用越准',
            logic: '个股判断 / 大盘技术 / 市场情绪三类每日留档 → 按交易日窗口事后验证 → 汇总命中率。震荡判定分两套口径（20261016b 审计 J2 如实披露）：个股为涨跌绝对值 ≤ 1.0%（lib/sameDayJudgment.js:1973/1999），大盘技术为 ≤ 0.5%（lib/marketTechJudgment.js:34，指数单日波动天然更小）；两者阈值不同但各自口径不姑息。',
            inputs: ['三类判断留档', '交易日历'],
            outputs: ['准确率台账（accuracy.html）', '判断记录（judgments.html）']
          },
          {
            name: '🛡️ 规则与守卫 · 铁律', badge: '回归全绿',
            desc: '任何一条不满足，先停下来把问题解决，禁止输出分析结论。',
            children: [
              { name: '数据一致性', desc: '单一权威源 + 五要素 + 分析期锁定' },
              { name: '数据最新性', desc: '按类型 TTL + 交易日感知 + 过期标注 + 异常校验' },
              { name: '变化与边际分析', desc: '变化率 + 边际 + 方向 + 幅度 + 加速减速 + 同向共振' },
              { name: '数据诚实原则', desc: '取不到必须明示失败，绝不凑数' },
              { name: '展示口径统一', desc: '指标删改图表同步；评级严格三档' },
              { name: '版本戳与缓存破坏', desc: 'APP_VERSION / SCHEMA_VERSION / LAYOUT_VERSION 三戳同步' }
            ]
          }
        ]
      },

      // ==================== 独立页面与全局入口 ====================
      {
        icon: '📄', name: '独立页面与全局入口', badge: '跳出主体',
        desc: '主体（首页 / 个股页）之外的独立页面与全局常驻入口。',
        children: [
          { name: '🎯 accuracy.html', desc: '准确率核对页：历史判断与事后命中率，分 tab（个股 / 大盘 / 情绪）。', inputs: ['三类判断留档'], outputs: ['命中率与历史核对'] },
          { name: '📋 judgments.html', desc: '判断记录页：个股判断流水。', inputs: ['判断留档'], outputs: ['判断流水查询'] },
          {
            name: '全局常驻入口', desc: '顶部导航常驻，所有页面可见。',
            children: [
              { name: '🧠 投资心得', desc: '笔记（全局作用域）' },
              { name: '🌐 大盘记录', desc: '笔记（大盘作用域）' },
              { name: '⚙️ AI 设置', desc: '模型 / 通道 / 额度配置' },
              { name: '🧩 工作台逻辑模型', desc: '本页' }
            ]
          }
        ]
      }
    ]
  };

  // ================= 统计（供头部摘要与守卫测试使用） =================
  function countNodes(node) {
    var n = 1;
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) n += countNodes(kids[i]);
    return n;
  }
  function maxDepth(node, d) {
    d = d || 1;
    var kids = node.children || [];
    if (!kids.length) return d;
    var m = d;
    for (var i = 0; i < kids.length; i++) m = Math.max(m, maxDepth(kids[i], d + 1));
    return m;
  }

  // ================= 渲染（纯字符串，可在 Node 中单测） =================
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  // 判定逻辑 / 数据来源 / 输出去向（模块间数据共享与引用）
  function renderFields(node) {
    var html = '';
    if (node.logic) {
      var logic = Array.isArray(node.logic) ? node.logic : [node.logic];
      html += '<div class="lm-desc lm-logic"><span class="lm-k lm-k-logic">🧠 判定逻辑</span>' +
        logic.map(function (x) { return '<span class="lm-li">' + esc(x) + '</span>'; }).join('') + '</div>';
    }
    var hasIo = (node.inputs && node.inputs.length) || (node.outputs && node.outputs.length);
    if (hasIo) {
      html += '<div class="lm-io">';
      if (node.inputs && node.inputs.length) {
        html += '<div class="lm-io-row"><span class="lm-k lm-k-in">📥 数据来源</span>' +
          '<span class="lm-io-list">' + node.inputs.map(esc).join('<i>、</i>') + '</span></div>';
      }
      if (node.outputs && node.outputs.length) {
        html += '<div class="lm-io-row"><span class="lm-k lm-k-out">📤 输出去向</span>' +
          '<span class="lm-io-list">' + node.outputs.map(esc).join('<i>、</i>') + '</span></div>';
      }
      html += '</div>';
    }
    return html;
  }

  function renderNode(node, depth) {
    var kids = node.children || [];
    var hasKids = kids.length > 0;
    var lv = Math.min(depth, 4);
    var html = '<div class="lm-node lm-lv' + lv + (hasKids ? '' : ' lm-leaf') + '">';
    html += '<div class="lm-row' + (hasKids ? ' lm-row-parent' : '') + '">';
    if (hasKids) {
      html += '<button class="lm-caret" type="button" tabindex="-1" aria-label="展开 / 收起">▾</button>';
    } else {
      html += '<span class="lm-dot"></span>';
    }
    if (node.icon) html += '<span class="lm-icon">' + esc(node.icon) + '</span>';
    html += '<span class="lm-name">' + esc(node.name) + '</span>';
    if (node.badge) html += '<span class="lm-badge">' + esc(node.badge) + '</span>';
    if (hasKids) {
      html += '<span class="lm-count">' + kids.length + ' 项 · 共 ' + (countNodes(node) - 1) + ' 个子项</span>';
    }
    html += '</div>';
    if (node.desc) html += '<div class="lm-desc">' + esc(node.desc) + '</div>';
    html += renderFields(node);
    if (hasKids) {
      html += '<div class="lm-children">';
      for (var i = 0; i < kids.length; i++) html += renderNode(kids[i], depth + 1);
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  // ================= 弹层交互 =================
  var LogicModel = {
    TREE: TREE,

    /** 结构统计（纯函数） */
    stats: function () {
      return {
        sections: TREE.children.length,
        nodes: countNodes(TREE),
        depth: maxDepth(TREE),
        modules: countNodes(TREE) - TREE.children.length - 1
      };
    },

    /** 完整树 HTML（纯函数，便于单测）：先渲染「总」根，再渲染各「分」页面 */
    renderHtml: function () {
      var html = '<div class="lm-root">' +
        '<span class="lm-root-tag">总</span>' +
        '<span class="lm-root-name">' + esc(TREE.name) + '</span>' +
        '</div>';
      if (TREE.desc) html += '<div class="lm-desc lm-root-desc">' + esc(TREE.desc) + '</div>';
      for (var i = 0; i < TREE.children.length; i++) html += renderNode(TREE.children[i], 1);
      return html;
    },

    _inited: false,
    _bound: false,

    init: function () {
      if (typeof document === 'undefined') return;
      if (this._bound) return;
      this._bound = true;
      var self = this;

      var overlay = document.getElementById('logicModelModal');
      var closeBtn = document.getElementById('logicModelClose');
      var btnAll = document.getElementById('logicModelExpandAll');
      var btnNone = document.getElementById('logicModelCollapseAll');

      if (closeBtn) closeBtn.addEventListener('click', function () { self.close(); });
      if (overlay) {
        overlay.addEventListener('click', function (e) { if (e.target === overlay) self.close(); });
      }
      if (btnAll) btnAll.addEventListener('click', function () { self.toggleAll(true); });
      if (btnNone) btnNone.addEventListener('click', function () { self.toggleAll(false); });

      // 20261025c：独立页面模式（public/logic-model.html）——无 overlay 概念，直接把树构建进 #lmPageBody。
      // 首页工作台（index.html）没有该容器，此调用安全 no-op。
      this.buildInto(document.getElementById('lmPageBody'));

      // Esc 关闭：独立监听，不改动 app.js 的 closeAllPopups（隔离修改）
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && self.isOpen()) self.close();
      });
    },

    isOpen: function () {
      if (typeof document === 'undefined') return false;
      var m = document.getElementById('logicModelModal');
      return !!m && !m.classList.contains('hidden');
    },

    /** 把「总—分」树构建进目标容器（幂等，data-built 防重复）。
     *  20261025c：open()（首页弹窗）与独立页面（#lmPageBody）共用同一构建逻辑。 */
    buildInto: function (body) {
      if (!body || body.getAttribute('data-built')) return;
      var st = this.stats();
      body.innerHTML =
        '<p class="lm-intro">按 <b>工作台页面布局</b> 组织：<b class="lm-hl">' + st.sections + '</b> 个页面 / 区域 · ' +
        '<b class="lm-hl">' + st.modules + '</b> 个模块 · 共 <b class="lm-hl">' + st.nodes + '</b> 个节点。' +
        '每个模块标注 <b>🧠 判定逻辑</b> 与 <b>📥 数据来源 / 📤 输出去向</b>（模块间的共享与引用）。' +
        '点击任意一行可展开 / 收起；结构与数据全部落在本机，不联网、不调用大模型。</p>' +
        this.renderHtml();
      body.setAttribute('data-built', '1');
    },

    open: function () {
      if (typeof document === 'undefined') return;
      this.init();
      var overlay = document.getElementById('logicModelModal');
      var body = document.getElementById('logicModelBody');
      if (!overlay || !body) return;
      this.buildInto(body);
      overlay.classList.remove('hidden');
    },

    close: function () {
      if (typeof document === 'undefined') return;
      var m = document.getElementById('logicModelModal');
      if (m) m.classList.add('hidden');
    },

    /** 展开 / 收起全部（20261025c：兼容首页弹窗 #logicModelBody 与独立页面 #lmPageBody） */
    toggleAll: function (expand) {
      if (typeof document === 'undefined') return;
      var body = document.getElementById('logicModelBody') || document.getElementById('lmPageBody');
      if (!body) return;
      var nodes = body.querySelectorAll('.lm-node');
      for (var i = 0; i < nodes.length; i++) {
        if (!nodes[i].querySelector('.lm-children')) continue;
        if (expand) nodes[i].classList.remove('lm-collapsed');
        else nodes[i].classList.add('lm-collapsed');
      }
    },

    /** 行点击：展开 / 收起该节点 */
    toggleNode: function (el) {
      if (typeof document === 'undefined') return;
      var node = el && el.closest ? el.closest('.lm-node') : null;
      if (!node || !node.querySelector('.lm-children')) return;
      node.classList.toggle('lm-collapsed');
    }
  };

  // 行点击委托（挂到 body 上，避免为每个节点绑定监听）
  if (typeof document !== 'undefined') {
    document.addEventListener('click', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.lm-row-parent') : null;
      if (!row) return;
      // 20261025c：首页弹窗模式要求 overlay 可见才响应；独立页面（无 overlay）直接放行。
      var overlay = document.getElementById('logicModelModal');
      if (overlay && overlay.classList.contains('hidden')) return;
      LogicModel.toggleNode(row);
    });
  }

  // 自动初始化
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { LogicModel.init(); });
    } else {
      LogicModel.init();
    }
  }

  global.LogicModel = LogicModel;
  if (typeof module !== 'undefined' && module.exports) module.exports = LogicModel;
})(typeof window !== 'undefined' ? window : globalThis);
