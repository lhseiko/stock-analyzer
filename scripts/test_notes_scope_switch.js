/**
 * 「个股亮点/雷点」跟随个股切换 —— 防串股回归测试（20260917j）
 * --------------------------------------------------------------
 * 用户反馈（2026-09-17 截图）：个股页切到「华安证券 600909」后，
 * 「个股亮点与雷点」卡片仍显示上一只股票「士兰微 600460」的内容
 * （截图计数 亮点 3 / 雷点 5，与 600460 的 3+5 完全吻合，600909 则 0 条）。
 *
 * 根因：AI 生成的 fetch 不随个股切换取消，等待期间切股后，
 *       回调里 `this.renderStock(旧symbol)` 把 #stockNotesContainer 刷成上一只股票；
 *       另外 setAsMain / confirmDelete / saveForm 也按「条目自己的 scope」重渲染。
 *
 * 本测试用最小 DOM 桩驱动真实 notes.js，钉死「防串股守卫」行为：
 *   非当前股票 → 绝不写容器（返回 false）；当前股票 → 正常渲染。
 *
 * 另覆盖（20260917j 追加）：
 *   §7 🤖 AI 徽标兼容历史数据（早期条目漏存 ai 字段，但 type==='ai'）
 *   §8 **口径锁定**：亮点/雷点「只累积、需手动清理」—— 用户 2026-09-17 明确决定，
 *      生成时【绝不】删除该股历史条目；本组断言用于防止将来被改回「自动替换」。
 *
 * 运行：node scripts/test_notes_scope_switch.js
 */
const path = require('path');

// ---------- 最小 DOM / window 桩（notes.js 只用 getElementById + createElement） ----------
const els = {};
function makeEl() {
  let html = '';
  return {
    get innerHTML() { return html; },
    set innerHTML(v) { html = String(v); },
    textContent: '', value: '',
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    querySelector() { return null; },
    appendChild() {}, addEventListener() {}, remove() {},
  };
}
global.document = {
  getElementById(id) { if (!els[id]) els[id] = makeEl(); return els[id]; },
  createElement() {
    let t = '';
    return {
      style: {}, dataset: {}, classList: { add() {}, remove() {} },
      appendChild() {}, addEventListener() {}, remove() {},
      set textContent(v) { t = String(v == null ? '' : v); },
      get textContent() { return t; },
      get innerHTML() {
        return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      },
    };
  },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { appendChild() {} },
};
global.window = { currentStock: { code: '600460', name: '士兰微' } };
global.localStorage = { getItem() { return null; }, setItem() {} };

const Notes = require(path.join(__dirname, '..', 'public', 'js', 'notes.js'));

// ---------- 断言工具 ----------
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
const container = () => document.getElementById('stockNotesContainer');

// ---------- 测试数据：复刻截图口径（600460 = 3 亮点 + 5 雷点；600909 = 0 条） ----------
const mk = (scope, stockName, aspect, content, id) => ({
  id, date: '2026-09-17T11:48:55.610Z', scope, aspect, stockCode: scope, stockName,
  title: aspect === 'highlight' ? 'AI 亮点' : 'AI 雷点', content, tags: [], type: 'ai',
  verification: { status: 'pending', result: null, probability: null, lastChecked: null, details: null },
});
Notes.notes = [
  mk('600460', '士兰微', 'highlight', 'H460-1 产能布局持续升级，6英寸SiC产线月产1万片接近满载', 'h1'),
  mk('600460', '士兰微', 'highlight', 'H460-2 核心业务结构优化，MEMS传感器营收同比增长60%', 'h2'),
  mk('600460', '士兰微', 'highlight', 'H460-3 归母净利润大幅增长至5.16亿元，整体同比+94.84%', 'h3'),
  mk('600460', '士兰微', 'risk', 'R460-1 当前市盈率(TTM)约106.54倍，估值处于历史高位区间', 'r1'),
  mk('600460', '士兰微', 'risk', 'R460-2 存货规模高达41.62亿元，若下游需求波动或面临减值', 'r2'),
  mk('600460', '士兰微', 'risk', 'R460-3 销售毛利率为18.56%，受新产线折旧增加影响同比下滑', 'r3'),
  mk('600460', '士兰微', 'risk', 'R460-4 资产负债率升至53.28%，财务杠杆增加', 'r4'),
  mk('600460', '士兰微', 'risk', 'R460-5 扣非净利润仅2.71亿元，Q2环比-28.5%', 'r5'),
  mk('600909', '华安证券', 'highlight', 'H909-1 华安证券亮点占位', 'h909'),
  mk('600909', '华安证券', 'risk', 'R909-1 华安证券雷点占位', 'r909'),
];

console.log('===== 1) 基础渲染：当前股票 = 600460 =====');
Notes.renderStock('600460', '士兰微');
let html = container().innerHTML;
ok('渲染出 600460 的亮点内容', html.includes('H460-1') && html.includes('H460-3'));
ok('渲染出 600460 的雷点内容', html.includes('R460-1') && html.includes('R460-5'));
ok('亮点计数 = 3（与截图一致）', html.includes('sn-count">3<'), '未找到 3 的计数');
ok('雷点计数 = 5（与截图一致）', html.includes('sn-count">5<'), '未找到 5 的计数');
ok('不包含 600909 的内容', !html.includes('H909-1'));

console.log('\n===== 2) 切股后旧的异步回调不得污染当前页（本次 bug 的核心场景）=====');
// 模拟：用户在 600460 页面点了「AI 生成」，AI 请求在途；此时切到 600909
global.window.currentStock = { code: '600909', name: '华安证券' };
container().innerHTML = 'SENTINEL';                 // 标记「当前页已有自己的内容」
ok('isCurrentStock(600460) 应为 false', Notes.isCurrentStock('600460') === false);
ok('isCurrentStock(600909) 应为 true', Notes.isCurrentStock('600909') === true);
const r1 = Notes.renderStockIfCurrent('600460', '士兰微');
ok('renderStockIfCurrent(旧股票) 返回 false', r1 === false, '实际返回 ' + r1);
ok('容器未被旧股票的异步回调改写（关键断言）', container().innerHTML === 'SENTINEL',
  '容器被改写成：' + String(container().innerHTML).slice(0, 60));
ok('切股后容器内不含上一只股票内容', !container().innerHTML.includes('H460-1'));

console.log('\n===== 3) 当前股票自己可以正常渲染 =====');
const r2 = Notes.renderStockIfCurrent('600909', '华安证券');
ok('renderStockIfCurrent(当前股票) 返回 true', r2 === true);
html = container().innerHTML;
ok('渲染出 600909 的亮点/雷点', html.includes('H909-1') && html.includes('R909-1'));
ok('不再残留 600460 的任何内容（含股票名）', !html.includes('H460-') && !html.includes('R460-') && !html.includes('士兰微'));
ok('标题为当前股票名', html.includes('华安证券 · 个股亮点与雷点'));

console.log('\n===== 4) 无记录股票：应显示「暂无」而不是上一只股票的内容 =====');
global.window.currentStock = { code: '601318', name: '中国平安' };
Notes.renderStock('601318', '中国平安');
html = container().innerHTML;
ok('显示「暂无亮点」', html.includes('暂无亮点'));
ok('显示「暂无雷点」', html.includes('暂无雷点'));
ok('无任何其他股票残留', !html.includes('H460-') && !html.includes('H909-') && !html.includes('R909-'));

console.log('\n===== 5) 代码前缀归一化（sh/sz 前缀不应造成误判）=====');
global.window.currentStock = { code: 'sh600460', name: '士兰微' };
ok('currentStock=sh600460 时 isCurrentStock(600460) 应为 true', Notes.isCurrentStock('600460') === true);
ok('renderStockIfCurrent(600460) 应放行', Notes.renderStockIfCurrent('600460', '士兰微') === true);
global.window.currentStock = { code: '600460', name: '士兰微' };
ok('currentStock=600460 时 isCurrentStock(sh600460) 应为 true', Notes.isCurrentStock('sh600460') === true);

console.log('\n===== 5B) 旧行为复现：裸 renderStock 无保护 —— 证明守卫是「承重」的 =====');
// 旧代码就是直接调 renderStock(symbol)（无守卫），下面复现它会把当前页刷成别的股票：
global.window.currentStock = { code: '600909', name: '华安证券' };
container().innerHTML = 'CURRENT_PAGE_OF_600909';
Notes.renderStock('600460', '士兰微');           // ← 模拟修复前 AI 回调的行为
ok('裸 renderStock(旧股票) 确实会覆盖当前页（这就是原 bug）',
  container().innerHTML.includes('H460-1') && !container().innerHTML.includes('CURRENT_PAGE_OF_600909'));
// 而同一个场景走守卫则不覆盖 → 守卫有效拦截，正是本次修复点
global.window.currentStock = { code: '600909', name: '华安证券' };
container().innerHTML = 'CURRENT_PAGE_OF_600909';
Notes.renderStockIfCurrent('600460', '士兰微');
ok('同一场景走 renderStockIfCurrent 则不被覆盖（修复生效）',
  container().innerHTML === 'CURRENT_PAGE_OF_600909');

console.log('\n===== 6) 边界：无 currentStock / 空 symbol =====');
global.window.currentStock = null;
ok('无 currentStock 时不误判为当前股票', Notes.isCurrentStock('600460') === false);
container().innerHTML = 'KEEP';
ok('无 currentStock 时守卫拒绝渲染（不误刷）', Notes.renderStockIfCurrent('600460', '士兰微') === false && container().innerHTML === 'KEEP');
global.window.currentStock = { code: '600460', name: '士兰微' };
// '' 经 _normScope 归一化为 'global'，与当前股票 '600460' 不等 → 守卫应拒绝
container().innerHTML = 'KEEP2';
ok('symbol 为空时守卫返回 false 且不改写容器',
  Notes.renderStockIfCurrent('', '') === false && container().innerHTML === 'KEEP2');

(async () => {
  console.log("\n===== 7) 🤖 AI 徽标：兼容历史数据（漏存 ai 字段、但 type==='ai'）=====");
  global.window.currentStock = { code: '600460', name: '士兰微' };
  Notes.renderStock('600460', '士兰微');
  html = container().innerHTML;
  ok('历史 AI 条目（仅有 type=ai、无 ai 字段）也显示 🤖 AI 徽标', html.includes('🤖 AI'));
  const nAiBadges = html.split('🤖 AI').length - 1;
  ok('600460 的 3+5 条历史 AI 条目全部带 🤖 徽标', nAiBadges === 8, '实际 🤖 次数 = ' + nAiBadges);

  // 追加一条「手动录入」（type=experience、ai=false）→ 不应出现 🤖
  const manual = mk('600460', '士兰微', 'highlight', 'H460-MANUAL 手动录入的一条亮点', 'm1');
  manual.type = 'experience'; manual.ai = false;
  Notes.notes.push(manual);
  Notes.renderStock('600460', '士兰微');
  const withManual = container().innerHTML;
  ok('手动录入条目不显示 🤖 徽标（仍为 8 个）',
    withManual.includes('H460-MANUAL') && (withManual.split('🤖 AI').length - 1) === 8,
    '🤖 次数 = ' + (withManual.split('🤖 AI').length - 1));

  console.log('\n===== 8) 口径锁定：「只累积、需手动清理」—— 生成时绝不删除历史条目 =====');
  // 用户 2026-09-17 明确决定：亮点/雷点只累积，清理靠手动点「🧹 清理重复」。
  // 本组断言用于防止将来有人把「生成前先清除旧 AI 条目」改回来（那是被用户否决的方案）。
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/ai/aspects')) {
      return { json: async () => ({ success: true, stockName: '士兰微', highlights: ['NEW-HL-1 新增亮点'], risks: ['NEW-RK-1 新增雷点'] }) };
    }
    return { json: async () => ({ success: true, notes: [] }) };
  };
  const cnt = (aspect) => Notes.notes.filter(n => String(n.scope) === '600460' && n.aspect === aspect).length;
  const beforeHL = cnt('highlight'), beforeRK = cnt('risk');
  await Notes.generateAspects('600460', '士兰微');
  const afterHL = cnt('highlight'), afterRK = cnt('risk');
  ok('原有亮点一条未删（仅 +1 新增）', afterHL === beforeHL + 1, `前 ${beforeHL} → 后 ${afterHL}`);
  ok('原有雷点一条未删（仅 +1 新增）', afterRK === beforeRK + 1, `前 ${beforeRK} → 后 ${afterRK}`);
  ok('历史内容仍在（H460-1 未被清除）', Notes.notes.some(n => String(n.content).includes('H460-1')));
  ok('新条目已落盘', Notes.notes.some(n => String(n.content).includes('NEW-HL-1')) && Notes.notes.some(n => String(n.content).includes('NEW-RK-1')));
  const newHL = Notes.notes.find(n => String(n.content).includes('NEW-HL-1'));
  ok('新写入的 AI 条目 ai 字段已落盘为 true（add() 不再丢字段）', !!newHL && newHL.ai === true);
  Notes.renderStock('600460', '士兰微');
  ok('渲染后亮点计数已增加', container().innerHTML.includes('sn-count">' + afterHL + '<'));

  console.log('\n===== 汇总：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
