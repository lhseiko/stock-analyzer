/**
 * scripts/test_market_log_db.js — 20261103m 守卫
 * ==========================================================
 * 用户指令（2026-11-03）：「把大盘记录做成一个简单的数据库，添加相应的检索功能，
 * 能够按日期、行业和涨跌等关键词进行搜索。」
 *
 * 锁定行为：
 *   §1 parseMarketNote 解析（AI 条目：交易日/指数/行业/方向；手写条目：诚实缺失；脏数据兜底）
 *   §2 SQLite 派生库（同步幂等 / 删除收敛 / 关键词·行业·涨跌·日期·组合检索 / facets）
 *   §3 接线守卫（server 路由 / 前端面板 / CSS 红涨绿跌 / 版本断言）
 *
 * IO 隔离：SA_NOTES_FILE / SA_MARKET_LOG_DB 重定向到临时目录，测试结束清理，
 * 不触碰真实 data/notes.json 与 data/market-log.db。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

const TMP = path.join(os.tmpdir(), 'mldb-test-' + Date.now());
const NOTES = path.join(TMP, 'notes.json');
const DBF = path.join(TMP, 'market-log.db');
fs.mkdirSync(TMP, { recursive: true });
process.env.SA_NOTES_FILE = NOTES;
process.env.SA_MARKET_LOG_DB = DBF;

const ROOT = path.join(__dirname, '..');
const marketLogDb = require(path.join(ROOT, 'lib/marketLogDb'));

const AI_NOTE_1 = {
  id: 'ai-market-20261103-test1',
  date: '2026-11-03T08:30:00.000Z',
  scope: 'market', aspect: null, stockCode: '', stockName: '',
  title: 'AI 大盘复盘 · 2026-11-03',
  content: '【大盘】A股今日探底回升强势反攻，沪指涨0.89%逼近3700点，创业板指狂飙4.16%，两市成交放量。\n【领涨板块】电机涨5.18%居首，软件开发、自动化设备涨近5%，资金涌入具身智能主线。\n【领跌板块】地面兵装、银行双双跌0.54%垫底，玻璃玻纤受下游需求偏弱拖累。\n【指数收盘】上证指数 0.89%，深证成指 1.20%，创业板指 4.16%\n（AI 自动复盘 · 数据源：东方财富行业板块/腾讯行情 · 模型：test）',
  tags: ['AI复盘', '大盘'], type: 'ai', ai: true,
  verification: { status: 'pending', result: null, probability: null, lastChecked: null, details: null },
};
const AI_NOTE_2 = {
  id: 'ai-market-20261030-test2',
  date: '2026-10-30T08:30:00.000Z',
  scope: 'market', aspect: null, stockCode: '', stockName: '',
  title: 'AI 大盘复盘 · 2026-10-30',
  content: '【大盘】A股震荡整理，沪指跌0.42%失守3600点，防御风格占优。\n【领涨板块】银行涨0.31%护盘，保险涨近0.5%。\n【领跌板块】软件开发跌2.10%领跌，电机跌超1.5%。\n【指数收盘】上证指数 -0.42%，创业板指 -1.05%\n（AI 自动复盘 · 模型：test）',
  tags: ['AI复盘', '大盘'], type: 'ai', ai: true,
  verification: { status: 'pending', result: null, probability: null, lastChecked: null, details: null },
};
const MANUAL_NOTE = {
  id: 'manual-market-test3',
  date: '2026-09-28T10:40:52.841Z',
  scope: 'market', aspect: null, stockCode: '', stockName: '',
  title: '2026/9/28',
  content: '无明确的原因，大盘下跌，银行股相对抗跌。',
  tags: [], type: 'experience', ai: false,
  verification: { status: 'pending', result: null, probability: null, lastChecked: null, details: null },
};
// 干扰条目：个股范围（不应入库）
const STOCK_NOTE = { id: 'stock-note-x', scope: '601318', title: '个股亮点', content: '与大盘记录无关', tags: [], type: 'experience', ai: false, date: '2026-11-01T00:00:00Z' };

let fixture = [STOCK_NOTE, MANUAL_NOTE, AI_NOTE_2, AI_NOTE_1];   // 与真实 notes.json 一致：新条目在前
function writeFixture(arr) { fs.writeFileSync(NOTES, JSON.stringify(arr), 'utf8'); }

function cleanup() {
  try { marketLogDb.close(); } catch (e) {}
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
}

async function main() {
  try {
    // ── §1 解析纯函数 ─────────────────────────────────────────
    console.log('\n§1 parseMarketNote 解析（代码权威，诚实缺失）');
    {
      const r = marketLogDb.parseMarketNote(AI_NOTE_1);
      ok(r.tradeDate === '2026-11-03', 'AI 条目交易日从 title 提取（2026-11-03）');
      ok(r.direction === 'up' && r.marketPct === 0.89, '方向 up（沪指 +0.89%）');
      ok(r.indices.length >= 3 && r.indices.some(i => i.name === '创业板指' && i.changePct === 4.16), '指数收盘解析（含创业板指 +4.16%）');
      ok(r.sectorsUp.includes('电机') && r.sectorsUp.includes('软件开发') && r.sectorsUp.includes('自动化设备'), '领涨行业候选（电机/软件开发/自动化设备）');
      ok(r.sectorsDown.includes('地面兵装') && r.sectorsDown.includes('银行'), '领跌行业候选（地面兵装/银行）');
      ok(r.source === 'ai', '来源 ai');

      const r2 = marketLogDb.parseMarketNote(AI_NOTE_2);
      ok(r2.direction === 'down' && r2.marketPct === -0.42, '方向 down（沪指 -0.42%）');
      ok(r2.sectorsUp.includes('银行'), '领涨行业候选（银行）');
      ok(r2.tradeDate === '2026-10-30', '第二条交易日 2026-10-30');

      const r3 = marketLogDb.parseMarketNote(MANUAL_NOTE);
      ok(r3.tradeDate === '2026-09-28', '手写条目 tradeDate 用笔记时间兜底（本地日期）');
      ok(r3.direction === null && r3.marketPct === null, '无标记段落 → 方向/涨跌幅如实 null（不臆造）');
      ok(r3.sectorsUp.length === 0 && r3.indices.length === 0, '手写条目结构字段为空数组（诚实缺失）');
      ok(r3.source === 'manual', '来源 manual');

      const r4 = marketLogDb.parseMarketNote(null);
      ok(r4 && r4.direction === null && r4.noteId === '', 'null 输入不抛错（脏数据兜底）');
      const r5 = marketLogDb.parseMarketNote({ id: 'x', scope: 'market', title: '', content: '', date: 'bad-date' });
      ok(r5.tradeDate === null, '坏日期 → tradeDate null（不编造）');
    }

    // ── §2 SQLite 派生库 ──────────────────────────────────────
    console.log('\n§2 SQLite 派生库（同步幂等 / 检索）');
    {
      writeFixture(fixture);
      const s1 = marketLogDb.syncMarketLog();
      ok(s1.synced === 3, `首次同步入库 3 条（scope=market 过滤个股条目，实际 ${s1.synced}）`);
      const c1 = marketLogDb.count();
      const s2 = marketLogDb.syncMarketLog();
      ok(marketLogDb.count() === c1 && s2.synced === 3, '重复同步幂等（全量重建不重复）');

      // 关键词
      let r = marketLogDb.searchMarketLog({ q: '探底回升' });
      ok(r.total === 1 && r.records[0].tradeDate === '2026-11-03', '关键词检索（content 命中）');
      r = marketLogDb.searchMarketLog({ q: '大盘下跌' });
      ok(r.total === 1 && r.records[0].source === 'manual', '手写条目可被关键词检索（content）');
      // 行业（sectors JSON + content 兜底）
      r = marketLogDb.searchMarketLog({ sector: '电机' });
      ok(r.total === 2, `行业「电机」命中 2 条（11-03 领涨 + 10-30 领跌，实际 ${r.total}）`);
      r = marketLogDb.searchMarketLog({ sector: '银行' });
      ok(r.total === 3, `行业「银行」命中 3 条（含手写条目 content 兜底，实际 ${r.total}）`);
      // 方向
      r = marketLogDb.searchMarketLog({ direction: 'up' });
      ok(r.total === 1 && r.records[0].tradeDate === '2026-11-03', '涨跌检索：up 1 条');
      r = marketLogDb.searchMarketLog({ direction: 'down' });
      ok(r.total === 1 && r.records[0].tradeDate === '2026-10-30', '涨跌检索：down 1 条（手写条目方向未知不入）');
      // 日期范围
      r = marketLogDb.searchMarketLog({ from: '2026-11-01', to: '2026-11-30' });
      ok(r.total === 1, '日期范围检索（11 月 1 条）');
      r = marketLogDb.searchMarketLog({ from: '2026-01-01' });
      ok(r.total === 3, '起始日期检索 3 条');
      // 指数名
      r = marketLogDb.searchMarketLog({ index: '创业板指' });
      ok(r.total === 2, '指数名检索（创业板指 2 条）');
      // 组合
      r = marketLogDb.searchMarketLog({ sector: '银行', direction: 'down' });
      ok(r.total === 1 && r.records[0].tradeDate === '2026-10-30', '组合检索（银行 × 下跌 → 10-30）');
      r = marketLogDb.searchMarketLog({ q: '不存在的关键词xyz' });
      ok(r.total === 0 && Array.isArray(r.records), '无命中 → total 0 / 空数组（不报错）');
      // facets
      const names = r.facets.sectors.map(f => f.name);
      ok(names.includes('电机') && names.includes('银行'), '行业 facets 聚合（含电机/银行）');
      // stats
      const st = marketLogDb.getStats();
      ok(st.total === 3 && st.fromDate === '2026-09-28' && st.toDate === '2026-11-03', '库统计（条数/日期范围）');

      // 删除收敛：权威源删掉一条 → 重建后库内同步减少
      fixture = fixture.filter(n => n.id !== 'ai-market-20261030-test2');
      writeFixture(fixture);
      const s3 = marketLogDb.syncMarketLog();
      ok(s3.synced === 2 && marketLogDb.count() === 2, '删除笔记后重建收敛（库内不再残留）');
      r = marketLogDb.searchMarketLog({ direction: 'down' });
      ok(r.total === 0, '被删条目不再可检索');
    }

    // ── §3 接线守卫 ────────────────────────────────────────────
    console.log('\n§3 接线守卫（路由 / 前端 / CSS / 版本）');
    {
      const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
      ok(server.includes("require('./lib/marketLogDb')") && server.includes("app.get('/api/market-log'"), 'server.js：marketLogDb 接线 + /api/market-log 路由');
      ok(/const APP_VERSION = '20261103m'/.test(server), "APP_VERSION = '20261103m'");
      const notesJs = fs.readFileSync(path.join(ROOT, 'public/js/notes.js'), 'utf8');
      ok(notesJs.includes('renderMarketDbPanel') && notesJs.includes('runMarketSearch') && notesJs.includes('mldbSearch'), 'notes.js：检索面板/检索执行函数齐备');
      ok(notesJs.includes("data-page-scope") && /renderMarketDbPanel\(\);\n/.test(notesJs), 'notes.js：面板按 market scope 注入（投资心得页零变化）');
      const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
      ok(css.includes('.mldb-panel') && css.includes('.mldb-dir.up') && css.includes('.mldb-dir.down'), 'style.css：检索面板与方向徽标样式齐备');
      const notesHtml = fs.readFileSync(path.join(ROOT, 'public/notes.html'), 'utf8');
      ok(notesHtml.includes('js/notes.js?v=20261103m') && notesHtml.includes('css/style.css?v=20261103m'), 'notes.html：notes.js/style.css 版本戳已对齐');
      const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
      const acc = fs.readFileSync(path.join(ROOT, 'public/accuracy.html'), 'utf8');
      ok(idx.includes('?v=20261103m') && acc.includes('?v=20261103m'), 'index/accuracy 页面版本戳已对齐 20261103m');
      const lib = fs.readFileSync(path.join(ROOT, 'lib/marketLogDb.js'), 'utf8');
      ok(lib.includes("require('node:sqlite')") && lib.includes('ensureSynced'), 'marketLogDb.js：node:sqlite + mtime 自动重建');
    }
  } finally {
    cleanup();
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试执行失败:', e); cleanup(); process.exit(1); });
