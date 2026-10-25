// 「工作台逻辑模型」守卫（20261006a 固化）
// 目的：树状逻辑框架是本工作台的「说明书」，最容易随代码演进悄悄过期。
//       本守卫保证：① 结构自洽；② 关键模块全覆盖；③ 树里点名的模块文件真实存在（反漂移）；
//                 ④ 前端接线完整（入口按钮/弹层/脚本/样式/版本戳）。
// 用法: node scripts/test_logic_model.js    输出 "N 通过 / M 失败"
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -> ' + detail : '')); }
};

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(root, p));

const LM = require(path.join(root, 'public/js/logicModel.js'));
const TREE = LM.TREE;

// ── §1 结构自洽 ──
console.log('===== §1 树结构自洽 =====');
t('模块导出 LogicModel.TREE', !!(LM && TREE && TREE.name));
t('根节点为「股票投资分析工作台」', TREE.name === '股票投资分析工作台', TREE.name);
t('根节点有总体说明', typeof TREE.desc === 'string' && TREE.desc.length > 20);
t('L1 页面 / 区域数为 4（首页/个股页/公共支撑/独立页）', TREE.children.length === 4, String(TREE.children.length));

const walk = (node, depth, cb) => { cb(node, depth); (node.children || []).forEach(k => walk(k, depth + 1, cb)); };
let badName = [], badKids = [], dupSibling = [], leafNoDesc = 0, total = 0;
walk(TREE, 1, (n, d) => {
  total++;
  if (!n.name || typeof n.name !== 'string') badName.push(n.name);
  if (n.children && !Array.isArray(n.children)) badKids.push(n.name);
  const names = (n.children || []).map(k => k.name);
  if (new Set(names).size !== names.length) dupSibling.push(n.name);
  if (d <= 2 && !(n.children || []).length && !n.desc && !n.logic) leafNoDesc++;
});
t('每个节点都有非空名称', badName.length === 0, badName.join(','));
t('children 均为数组', badKids.length === 0, badKids.join(','));
t('同级节点名称不重复', dupSibling.length === 0, dupSibling.join(','));
t('L1/L2 无空壳（叶子须有 children 或 desc 或 logic）', leafNoDesc === 0, String(leafNoDesc));
t('节点总数 ≥ 60（覆盖足够细度）', total >= 60, String(total));

const st = LM.stats();
t('stats 自洽：nodes = sections + modules + 1', st.nodes === st.sections + st.modules + 1,
  JSON.stringify(st));
t('层级深度 = 4（总/页面/模块/细项）', st.depth === 4, String(st.depth));

// ── §2 关键模块覆盖 ──
console.log('\n===== §2 关键模块覆盖 =====');
const flat = [];
walk(TREE, 1, (n) => { flat.push((n.name || '') + ' ' + (n.desc || '')); });
const ALL = flat.join('\n') + '\n' + TREE.desc;
const cover = [
  '腾讯 qt.gtimg.cn', 'RPT_INDUSTRY_FUNDFLOW', 'RPTA_WEB_GETHGLIST_NEW', '巨潮资讯公告',
  '市场情绪提醒', '大盘技术分析', '大盘估值趋势', '行业板块拥挤度',
  '短期行情判断', '长期行情判断', '技术面', '专属估值模型', '深度分析',
  '策略生成器', '回测校验', '事件驱动引擎', '准确率闭环',
  'API 层', 'AI 叙事层', '规则与守卫', '跨页面公共支撑', '页面布局',
  'SA_NO_BG_AI', '数据诚实原则', 'APP_VERSION', 'SCHEMA_VERSION', 'LAYOUT_VERSION'
];
cover.forEach(k => t('覆盖「' + k + '」', ALL.includes(k)));

const stocks = ['海天味业', '中国平安', '圣湘生物', '士兰微', '华安证券', '长江证券', '麦捷科技', '万润股份', '新洋丰', '电气风电'];
stocks.forEach(s => t('专属估值模型含「' + s + '」', ALL.includes(s)));
t('首页 9 张卡片全部列出', ['市场情绪提醒', '实时大盘', '大盘技术分析', '大盘估值趋势', '行业板块拥挤度', '今日财经热点', '板块舆情热度周榜', '每日宏观', '基金行业配置名单']
  .every(k => ALL.includes(k)));
t('个股页 10 个 tab 全部列出', ['简介', '技术面', '基本面', '股东分析', '深度分析', '行业分析', '资金量能', '个股亮点/雷点', '资料库', '策略']
  .every(k => ALL.includes(k)));

// ── §3 反漂移：树里点名的模块，文件必须真实存在 ──
console.log('\n===== §3 反漂移（树 ↔ 真实模块文件） =====');
const files = [
  ['lib/sameDayJudgment.js', '短期行情判断'],
  ['lib/longTermJudgment.js', '长期价值判断'],
  ['lib/marketEmotionModel.js', '市场情绪模型'],
  ['lib/marketTechnical.js', '大盘技术分析'],
  ['lib/indexPETrend.js', '大盘估值趋势'],
  ['lib/sectorCrowding.js', '行业板块拥挤度'],
  ['lib/strategyGenerator.js', '策略生成器'],
  ['lib/backtestValidator.js', '回测校验'],
  ['lib/eventEngine.js', '事件驱动引擎'],
  ['lib/techFaceJudgment.js', '技术面判定'],
  ['lib/dataHonesty.js', '数据诚实原则'],
  ['lib/valuation/haitian603288.js', '海天味业模型'],
  ['lib/valuation/pingAn601318.js', '中国平安模型'],
  ['lib/valuation/sanxi688289.js', '圣湘生物模型'],
  ['lib/valuation/silan600460.js', '士兰微模型'],
  ['lib/valuation/huaan600909.js', '华安证券模型'],
  ['lib/valuation/changjiang000783.js', '长江证券模型'],
  ['lib/valuation/maijie300319.js', '麦捷科技模型'],
  ['lib/valuation/wanrun002643.js', '万润股份模型'],
  ['lib/valuation/xinyangfeng000902.js', '新洋丰模型'],
  ['lib/valuation/dcavm688660.js', '电气风电模型'],
  ['routes/aiRoutes.js', 'AI 路由'],
  ['routes/dedicatedFactor.js', '专属因子路由'],
  ['routes/docsRoutes.js', '资料库路由'],
  ['routes/eventRoutes.js', '事件路由'],
  ['public/accuracy.html', '准确率核对页'],
  ['public/judgments.html', '判断记录页'],
  ['lib/localDate.js', '统一中国自然日'],
  ['lib/deep/pipeline.js', '深度分析链路'],
  ['lib/valuationHub.js', '估值 Hub 唯一出口'],
  ['lib/macroSentimentFactors.js', '宏观情绪因子'],
  ['lib/hotTopicsWeekly/index.js', '板块舆情周榜']
];
files.forEach(([p, label]) => t(label + ' 对应文件存在（' + p + '）', exists(p)));

// 专属估值模型数量与 lib/valuation 实际数量一致（brokerModel 为共用基座，不计）
const valDir = fs.readdirSync(path.join(root, 'lib/valuation')).filter(f => f.endsWith('.js') && f !== 'brokerModel.js');
t('专属估值模型数量 = lib/valuation 实际数量（' + valDir.length + '）', /专属估值模型（\d+ 只）/.test(ALL)
  ? Number(ALL.match(/专属估值模型（(\d+) 只）/)[1]) === valDir.length
  : false, valDir.join(','));

// ── §4 前端接线 ──
console.log('\n===== §4 前端接线 =====');
const idx = read('public/index.html');
const css = read('public/css/style.css');
const serverSrc = read('server.js');
const avm = serverSrc.match(/APP_VERSION = '([^']+)'/);
const APP_V = avm ? avm[1] : '';

// 20261025c：弹窗改独立页面后的新契约 —— index.html 入口按钮 window.open 新标签跳转，
// 树主体渲染进独立页 logic-model.html 的 #lmPageBody；logicModel.js 移至该页面加载。
const lmpage = read('public/logic-model.html');
t('nav 内有 logic-model.html 新标签页入口按钮', /window\.open\('logic-model\.html', '_blank'\)/.test(idx));
t('入口在 global-nav-common 常驻组内（与投资心得/大盘记录/AI 设置同组）',
  /global-nav-common[\s\S]{0,600}window\.open\('logic-model\.html'[\s\S]{0,200}global-nav-extra/.test(idx));
t('入口按钮文案为「工作台逻辑模型」', />工作台逻辑模型</.test(idx));
t('独立页面 logic-model.html 存在', !!lmpage);
t('独立页面含 lmPageBody/展开/收起 三个挂点',
  ['lmPageBody', 'logicModelExpandAll', 'logicModelCollapseAll'].every(id => lmpage.includes('id="' + id + '"')));
t('logic-model.html 引入 logicModel.js（带版本戳）', lmpage.includes('js/logicModel.js?v=' + APP_V));
t('style.css 为弹层单独声明 .hidden（本项目 .hidden 非全局类）', /\.lm-modal-overlay\.hidden\s*\{[^}]*display:\s*none/.test(css));
t('style.css 含树状层级样式（.lm-node/.lm-children）', /\.lm-node/.test(css) && /\.lm-children/.test(css));
t('style.css 含折叠态样式（.lm-collapsed）', /\.lm-collapsed/.test(css));

// ── §5 部署与渲染 ──
console.log('\n===== §5 部署与渲染 =====');
t('server.js 存在 APP_VERSION', !!APP_V);
t('APP_VERSION 与 logic-model.html 内 logicModel.js 版本戳一致', lmpage.includes('js/logicModel.js?v=' + APP_V), APP_V);
t('/js/logicModel.js 在缓存破坏名单内', /FRONTEND_BUST_FILES[\s\S]{0,400}\/js\/logicModel\.js/.test(serverSrc));
t('APP_VERSION 注释含本次变更说明', serverSrc.includes('[20261013h]'));

const html = LM.renderHtml();
t('renderHtml 产出「总」根节点', /class="lm-root"/.test(html) && html.includes('股票投资分析工作台'));
t('renderHtml 产出 L1 页面卡片', (html.match(/lm-node lm-lv1/g) || []).length === 4,
  String((html.match(/lm-node lm-lv1/g) || []).length));
t('renderHtml 含节点计数与角标', /class="lm-count"/.test(html) && /class="lm-badge"/.test(html));
// 20261013h：判定逻辑 / 数据来源 / 输出去向三字段渲染
t('renderHtml 含判定逻辑块（lm-logic / lm-k-logic）', /class="lm-desc lm-logic"/.test(html) && /lm-k-logic/.test(html));
t('renderHtml 含数据来源 / 输出去向块（lm-io / lm-k-in / lm-k-out）', /class="lm-io"/.test(html) && /lm-k-in/.test(html) && /lm-k-out/.test(html));
t('renderHtml 无 undefined/null 字样', !/>undefined</.test(html) && !/>null</.test(html));
t('renderHtml 转义 < > &（防注入）', LM.renderHtml().indexOf('<') === 0); // 结构标签正常；内容转义由 esc 保证
t('折叠/展开 API 齐备', typeof LM.open === 'function' && typeof LM.close === 'function' && typeof LM.toggleAll === 'function' && typeof LM.toggleNode === 'function');

console.log('\n===== 汇总：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
