/**
 * 工作台逻辑模型（LogicModel）
 * ------------------------------------------------------------------
 * 20261006a 新增：以「总 — 分」树状结构呈现整个工作台的逻辑框架。
 *
 * 设计原则（与项目铁律一致）：
 *   ① 纯静态结构数据 + 纯前端渲染：不请求后端、不调用大模型 —— 结构本身是确定性事实，
 *      由代码写死，不需要 AI 参与（「1+1=2 由代码执行」）。
 *   ② 零副作用：不改动任何既有模块；弹层独立于 app.js 的弹窗体系（自带 Esc / 遮罩关闭）。
 *   ③ 节点内容全部来自项目真实清单（lib/、routes/、server.js 路由、public 页面与 tab、scripts 守卫）。
 *
 * 维护约定：模块增删后同步更新下方 TREE（保持「总分」层级：L1 板块 → L2 模块 → L3 细项）。
 */
(function (global) {
  'use strict';

  // ================= 逻辑框架数据（总 — 分 树） =================
  // 字段：name 名称 / desc 说明 / badge 角标 / icon 图标（仅 L1）/ children 子节点
  var TREE = {
    name: '股票投资分析工作台',
    desc: '数据层 → 计算层 → API 层 → 展示层 的四层链路上，叠加 AI 叙事层与规则守卫层。确定性数值一律由代码计算，大模型只负责叙事。',
    children: [
      {
        icon: '🗄️', name: '数据层 · 数据源接入', badge: '单一权威源',
        desc: '同一口径只走一条权威通道；每项数据带「来源 / 日期 / 口径 / 单位 / 样本」五要素与 TTL 时效标注。',
        children: [
          {
            name: '行情通道', children: [
              { name: '腾讯 qt.gtimg.cn', desc: '实时报价 + 日/周/月 K（GBK 编码）——主行情源', badge: '主力' },
              { name: '新浪 getHistoryDeep', desc: '长历史日 K（腾讯仅回看约 2.6 年，超长周期用它）' },
              { name: '腾讯 60 分钟 K 线', desc: '策略模块回测序列（单次上限 800 根）' },
              { name: '东财 push2 族', desc: '实时 tick / 板块 / 涨跌家数；偶发被限流，连败进入 10 分钟静默期' }
            ]
          },
          {
            name: '东财数据中心（datacenter-web 报表）', children: [
              { name: 'RPT_INDUSTRY_FUNDFLOW', desc: '行业资金流（单位：元）' },
              { name: 'RPTA_WEB_GETHGLIST_NEW', desc: '股份回购（001 预案 ~ 006 完成，多档取最新）' },
              { name: 'RPT_VALUEANALYSIS_DET', desc: '个股估值带（含所属板块）' },
              { name: 'RPT_VALUEINDUSTRY_DET', desc: '申万二级行业总市值' }
            ]
          },
          {
            name: '基本面 / 公告', children: [
              { name: '东财 F10 财务快照', desc: '权威财务数字，注入 AI 并做偏差校验' },
              { name: '巨潮资讯公告', desc: '/api/security/ann（orgId 落盘缓存 + 1 次重试）' },
              { name: '本地年报资料库', desc: 'data/companies/<代码>/annual/*.pdf + 文本抽取' }
            ]
          },
          {
            name: '宏观 / 资金面', children: [
              { name: 'market_emotion.py', desc: '上证量价 / 涨跌家数与涨跌停 / 融资余额 / 主力净额 / 换手集中度' },
              { name: '央行与利率', desc: '社融（央行）/ LPR / 中债 10 年 / 离岸人民币' }
            ]
          },
          {
            name: '舆情 / 讨论热度', children: [
              { name: '东财快讯', desc: 'getFastNewsList，时间统一归一化到北京时间' },
              { name: '股吧讨论热度', desc: '散户情绪（在模型中作反向因子）' },
              { name: '多源交叉', desc: '同花顺 / 雪球 / 新浪财经' }
            ]
          }
        ]
      },
      {
        icon: '🧮', name: '计算层 · 确定性引擎', badge: '代码算数',
        desc: '所有数值由 lib/ 下的确定性引擎计算（输入锁死 ⇒ 结果锁死），大模型不参与推导。',
        children: [
          {
            name: '大盘级', children: [
              { name: '市场情绪模型（10 因子）', desc: '量能活跃度 / 市场宽度 / 量价配合 / 涨跌势头 / 融资余额 / 主力资金 / 讨论热度(反向) / 避险情绪 + 国内宏观 + 美国宏观；权重 5%~30% 有界夹紧、支持自学习' },
              { name: '大盘技术分析（七步推演）', desc: '上证 / 深证 / 创业板指，收盘后落盘留档' },
              { name: '大盘估值趋势', desc: '上证 50 / 沪深 300 / 科创 50 近 5 年 PE-TTM' },
              { name: '行业板块拥挤度', desc: '板块成交额 ÷ 全市场成交额；今日 / 本周 / 本月按区间累计' }
            ]
          },
          {
            name: '个股级', children: [
              { name: '短期行情判断（7 因子 + 事件驱动）', desc: '大盘 / 资金量能 / 对标期货 / 增持减持 / 行业板块 / 科技指数(负相关) / 个股短期动向' },
              { name: '长期价值判断', desc: '长周期趋势与价值区间的确定性判定' },
              { name: '技术面判定与结算', desc: '留档 → 第 5 个交易日（跳过法定节假日）→ 命中核对' },
              { name: '专属估值模型（10 只）', desc: '海天味业 / 中国平安 / 圣湘生物 / 士兰微 / 华安证券 / 长江证券 / 麦捷科技 / 万润股份 / 新洋丰 / 电气风电 —— 输入锁死、无 LLM、方法各自独立', badge: '10' },
              { name: '深度分析（lib/deep）', desc: '财报 / 分红 / 收益率 / 结论 四条确定性链路（含分产品收入、主营构成）' }
            ]
          },
          {
            name: '策略 · 回测', children: [
              { name: '策略生成器（5 类候选）', desc: '趋势跟踪 / 均值回归 / 动量·轮动 / 价值·基本面 / 事件驱动' },
              { name: '回测校验（6 步风险修正）', desc: '平稳性闸门 → 前视 → 成本 → 趋势 → 过拟合 → 幸存者' },
              { name: '交易约束', desc: '60 分钟 K 线序列；每个交易日最多 1 笔' }
            ]
          },
          {
            name: '事件驱动引擎', children: [
              { name: '新闻 → 事件 → 权重再平衡', desc: '只等比压缩既有因子、绝不删因子；权重总和恒 100%；事件结束自动恢复' },
              { name: '事件黑名单与封顶', desc: 'LPR / 逆回购 / 公开市场操作 / MLF 直接剔除；降准降息类封顶 moderate' },
              { name: '热度验证', desc: '讨论热度为 0 则事件降级' }
            ]
          },
          {
            name: '准确率闭环', children: [
              { name: '每日留档', desc: '个股判断 / 大盘技术 / 市场情绪 三类分别落盘' },
              { name: '事后验证', desc: '按交易日窗口核对命中（震荡 = 涨跌绝对值 ≤ 1.0%）' },
              { name: '准确率台账', desc: 'accuracy.html 分 tab 查看历史与命中率' }
            ]
          }
        ]
      },
      {
        icon: '🔌', name: 'API 层 · 服务接口', badge: '71 条主路由',
        desc: 'server.js 主路由 + routes/ 四个子模块；前端一切数据只通过 API 获取。',
        children: [
          { name: 'server.js 主路由', desc: '行情 / 判断 / 估值 / 股东 / 行业 / 资金 / 宏观 / 新闻 / 资料库 等 71 条', badge: '71' },
          { name: 'routes/aiRoutes.js', desc: 'AI 分析、妙想鉴权与取数、券商分类与估值' },
          { name: 'routes/dedicatedFactor.js', desc: '专属因子查询 / 触发 / 清理' },
          { name: 'routes/docsRoutes.js', desc: '资料库上传与自动分类' },
          { name: 'routes/eventRoutes.js', desc: '事件池查询与刷新' },
          { name: '缓存与版本契约', desc: '分析缓存绑 APP_VERSION；判断缓存绑 SCHEMA_VERSION（因子结构哈希 + LAYOUT_VERSION）' }
        ]
      },
      {
        icon: '🖥️', name: '展示层 · 前端页面', badge: '10 tab + 9 卡',
        desc: 'softDark 柔和暗色主题、红涨绿跌（#F6465D / #0ECB81）；图表口径随指标增减严格同步。',
        children: [
          {
            name: '首页（9 张卡片）', children: [
              { name: '📡 市场情绪提醒' }, { name: '📈 实时大盘' }, { name: '🧭 大盘技术分析' },
              { name: '📊 大盘估值趋势' }, { name: '🧮 行业板块拥挤度' }, { name: '🔥 今日财经热点' },
              { name: '🔥 板块舆情热度周榜' }, { name: '🌐 每日宏观 & 政策' }, { name: '🏭 基金行业配置名单' }
            ]
          },
          {
            name: '个股页（10 个 tab）', children: [
              { name: '📊 简介' }, { name: '📈 技术面' }, { name: '💰 基本面' }, { name: '👥 股东分析' }, { name: '🔬 深度分析' },
              { name: '🏭 行业分析' }, { name: '💹 资金量能' }, { name: '⭐ 个股亮点/雷点' }, { name: '📁 资料库' }, { name: '🎯 策略' }
            ]
          },
          { name: '独立页面', desc: 'accuracy.html（准确率核对）、judgments.html（判断记录）' },
          { name: '全局常驻入口', desc: '🧠 投资心得 / 🌐 大盘记录 / ⚙️ AI 设置 / 🧩 工作台逻辑模型（本页）' }
        ]
      },
      {
        icon: '🤖', name: 'AI 叙事层', badge: '只叙事不估算',
        desc: '大模型只把确定性计算结果讲成人话；所有数字以代码输出为准。',
        children: [
          { name: '双模型分离', desc: '联网模型（需先上网取信息） / 本地模型（只分析本地数据，不联网检索）' },
          { name: '联网搜索通道', desc: '阿里百炼 MCP / 火山豆包 / 百度千帆 / 内置搜索 —— 按免费额度自动回退' },
          { name: '公司深度信息分析（CFA 七段）', desc: 'lib/ai/companyDeep.js 单一出口，固定联网模型 + 永久缓存' },
          { name: '事实注入 + 数字校验', desc: '注入东财 F10 权威快照；AI 输出的数字与权威值偏差 > 1 个百分点时直接纠正为权威值' },
          { name: '后台守则', desc: 'SA_NO_BG_AI 默认开启 —— 禁用后台 LLM 定时任务，防止无人值守时静默计费' },
          { name: '稳定性兜底', desc: '整链路总耗时预算 + 流式/非流式兼容层 + 失败回退历史结果（标记 stale）' }
        ]
      },
      {
        icon: '🛡️', name: '规则与守卫 · 铁律', badge: '回归全绿',
        desc: '任何一条不满足，先停下来把问题解决，禁止输出分析结论。',
        children: [
          { name: '数据一致性', desc: '单一权威源 + 五要素（来源/日期/口径/单位/样本）+ 分析期锁定' },
          { name: '数据最新性', desc: '按类型 TTL + 交易日感知 + 过期标注 + 异常校验' },
          { name: '变化与边际分析', desc: '变化率 + 边际 + 方向 + 幅度 + 加速/减速 + 同向共振' },
          { name: '数据诚实原则', desc: '取不到必须明示「获取失败」，绝不拿陈旧快照或零值凑数' },
          { name: '确定性计算由代码执行', desc: '1+1=2 的判断不交给大模型' },
          { name: '展示口径统一', desc: '指标删除则对应图表同步删除；评级严格三档「低估 / 合理 / 高估」' },
          { name: '版本戳与缓存破坏', desc: 'APP_VERSION / SCHEMA_VERSION / LAYOUT_VERSION 三戳同步，防止浏览器沿用旧前端' },
          { name: '单元测试守卫', desc: 'scripts/test_*.js 全量回归 + 导出快照基线比对' }
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

    /** 完整树 HTML（纯函数，便于单测）：先渲染「总」根，再渲染各「分」板块 */
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

    open: function () {
      if (typeof document === 'undefined') return;
      this.init();
      var overlay = document.getElementById('logicModelModal');
      var body = document.getElementById('logicModelBody');
      if (!overlay || !body) return;
      if (!body.getAttribute('data-built')) {
        var st = this.stats();
        body.innerHTML =
          '<p class="lm-intro">按 <b>总 → 分</b> 组织：<b class="lm-hl">' + st.sections + '</b> 大板块 · ' +
          '<b class="lm-hl">' + st.modules + '</b> 个子模块 · 共 <b class="lm-hl">' + st.nodes + '</b> 个节点，' +
          '层级 <b class="lm-hl">' + st.depth + '</b> 层。点击任意一行可展开 / 收起；结构与数据全部落在本机，不联网、不调用大模型。</p>' +
          this.renderHtml();
        body.setAttribute('data-built', '1');
      }
      overlay.classList.remove('hidden');
    },

    close: function () {
      if (typeof document === 'undefined') return;
      var m = document.getElementById('logicModelModal');
      if (m) m.classList.add('hidden');
    },

    /** 展开 / 收起全部 */
    toggleAll: function (expand) {
      if (typeof document === 'undefined') return;
      var body = document.getElementById('logicModelBody');
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
      var overlay = document.getElementById('logicModelModal');
      if (!overlay || overlay.classList.contains('hidden')) return;
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
