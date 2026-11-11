#!/usr/bin/env node
/**
 * scripts/test_etf_monthly_provisional.js — [20261109a] 当月逐日明细「未定稿多日合计行」守卫
 *
 * 用户指令（截图 屏幕截图 2026-11-09 124511.png）：
 *   「11月5日和6日的数据为什么缺少，无法区分也可以一并合计入统计表格里面。」
 *
 * 事故形态：11-06 残缺快照被如实标 partial 后，11-05 收盘份额已不可得，
 * 11-05 / 11-06 两天的单日申赎永远无法拆分。但 11-04→11-06 的 Δ 是真实存在、
 * 可计算的数据，原 stockMonthlyFlow() 的 `settled && !partial` 闸门把它整条丢掉 → 用户看到数据凭空消失。
 *
 * 本守卫验证：
 *   §1 旧行为不回退：没有未定稿快照时，rows 仍只由定稿链产生
 *   §2 未定稿快照 → 一条多日合计行，带 spanNote / provisional / 正确 Δ，并计入 totals
 *   §3 重复防护：同一披露日、残缺口径、名单缩水、跨月都不产生额外行
 *   §4 台账隔离：stockMonthlyFlow 只读，不写 ledger.json
 *   §5 前端接线：行样式 / 合计行文案 / 口径说明同步
 * 全部在 os.tmpdir() 独立夹具内，不碰生产 data/。
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

const UNIT = 1000000;
const CODES = ['510300', '510050', '510500', '588000'];
function etfs(sharesMap) {
  // 只有第一只 ETF 含目标股 601398，其余含别的成分股 → 每篮 100 股，数值直观可核对
  return CODES.map((c, i) => ({
    code: c, shares: sharesMap[c], unit: UNIT,
    comps: [[i === 0 ? '601398' : '600000', 100]],
  }));
}
function shares(v) {
  const m = {}; for (const c of CODES) m[c] = v; return m;
}
function snap(date, shareDate, v, opts = {}) {
  return {
    date, shareDate,
    settled: opts.settled !== undefined ? opts.settled : true,
    partial: opts.partial !== undefined ? opts.partial : false,
    etfs: opts.only ? etfs(shares(v)).slice(0, opts.only) : etfs(shares(v)),
  };
}
function writeSnap(dir, s) {
  fs.writeFileSync(path.join(dir, s.date + '.json'), JSON.stringify(s));
  return s;
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'etf-month-test-'));
  return dir;
}
function loadEf(dir) {
  process.env.SA_ETF_FLOW_DIR = dir;
  delete require.cache[require.resolve(path.join(ROOT, 'lib/etfFlow.js'))];
  return require(path.join(ROOT, 'lib/etfFlow.js'));
}
// 三份定稿：1103(份1e9) → 1104(+1篮) → 1105(不变)，披露日分别 1102/1103/1104
function baseChain(dir) {
  writeSnap(dir, snap('20261103', '20261102', 1e9));
  writeSnap(dir, snap('20261104', '20261103', 1e9 + UNIT));
  writeSnap(dir, snap('20261105', '20261104', 1e9 + UNIT));
}

(async () => {
  const dirs = [];
  try {
    // ---------- §1 旧行为不回退 ----------
    console.log('\n[§1] 只有定稿链：rows 仍由相邻定稿快照产生，零 provisional 行');
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.ok === true, 'ok=true');
      ok(r.rows.length === 2, `2 行定稿（实际 ${r.rows.length}）`);
      ok(r.provisionalRows === 0, 'provisionalRows=0');
      ok(r.settledDays === 3, `settledDays=3（实际 ${r.settledDays}）`);
      ok(r.rows[0].date === '20261103' && r.rows[0].buy === 100, `首行 +100 股（实际 ${r.rows[0].buy}）`);
      ok(r.rows[1].date === '20261104' && r.rows[1].buy === 0, '次行份额不变 → 0 股');
      ok(r.totals.buy === 100 && r.totals.net === 100, `合计 100 股（实际 ${r.totals.net}）`);
    }

    // ---------- §2 未定稿多日合计行 ----------
    console.log('\n[§2] 定稿链之后有完整未定稿快照 → 一条多日合计行，计入 totals');
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      // 11-06 事故残缺快照（应被忽略）
      writeSnap(dir, snap('20261106', '20261106', 1e9 + 9 * UNIT, { settled: false, partial: true, only: 1 }));
      // 11-09 盘中完整未定稿快照：相对最后定稿 +2 篮 → +200 股
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: false }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.rows.length === 3, `3 行（2 定稿 + 1 多日合计，实际 ${r.rows.length}）`);
      ok(r.provisionalRows === 1, 'provisionalRows=1');
      ok(r.settledDays === 3, `settledDays 仍为 3，未定稿不算定稿日（实际 ${r.settledDays}）`);
      const p = r.rows[2];
      ok(p.provisional === true, '末行 provisional=true');
      ok(p.date === '20261106', `末行数据日 = 份额披露日 20261106（实际 ${p.date}）`);
      ok(p.snapshotDate === '20261109', '末行溯源到 20261109 快照');
      ok(/多日合计（20261104→20261106）/.test(p.spanNote || ''), `spanNote 含多日合计跨度（实际 ${p.spanNote}）`);
      ok(/含未定稿读数/.test(p.spanNote || ''), 'spanNote 明示含未定稿读数');
      ok(p.buy === 200 && p.net === 200, `多日合计 Δ = +200 股（实际 ${p.buy}）`);
      ok(r.totals.buy === 300 && r.totals.net === 300, `当月合计已含该行 = 300 股（实际 ${r.totals.net}）`);
    }

    // ---------- §2b 赎回方向 ----------
    console.log('\n[§2b] 未定稿行份额减少 → 计入赎回列');
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      writeSnap(dir, snap('20261109', '20261106', 1e9 - UNIT, { settled: false, partial: false }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      const p = r.rows.find(x => x.provisional);
      ok(!!p, '存在 provisional 行');
      ok(p && p.sell === 200, `赎回 2 篮 × 100 股 = 200 股（实际 ${p && p.sell}）`);
      ok(p && p.net === -200, `净额 -200（实际 ${p && p.net}）`);
    }

    // ---------- §3 重复 / 残缺 / 缩水 / 跨月防护 ----------
    console.log('\n[§3] 重复与脏数据防护');
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      // 同一披露日 20261104 的盘中快照 → 不得重复计数
      writeSnap(dir, snap('20261106', '20261104', 1e9 + 5 * UNIT, { settled: false, partial: false }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.provisionalRows === 0 && r.rows.length === 2, '披露日未推进 → 不产生重复行');
      ok(r.totals.net === 100, `合计未被重复放大（实际 ${r.totals.net}）`);
    }
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: true }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.provisionalRows === 0, 'partial:true 的残缺快照不产生行');
    }
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      // 名单从 4 只缩到 2 只（< 4×0.8=3）→ 拦截
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: false, only: 2 }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.provisionalRows === 0, '名单缩水超 20% → 不产生假 Δ 行');
    }
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: false }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202610');
      ok(r.rows.length === 0 && r.provisionalRows === 0, '查询其它月份 → 不串月');
    }
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      // 两份未定稿快照（不同采集日、同一披露日）→ 只取最新一份
      writeSnap(dir, snap('20261107', '20261106', 1e9 + 2 * UNIT, { settled: false, partial: false }));
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: false }));
      const ef = loadEf(dir);
      const r = ef.stockMonthlyFlow('601398', '202611');
      ok(r.provisionalRows === 1 && r.rows.length === 3, '多份未定稿快照 → 只取最新一份，不重复');
      ok(r.rows[2].snapshotDate === '20261109' && r.rows[2].buy === 200, '采用 20261109 的 +200 股');
    }

    // ---------- §4 台账隔离 ----------
    console.log('\n[§4] 只读保证：不写累计台账');
    {
      const dir = fixture(); dirs.push(dir);
      baseChain(dir);
      writeSnap(dir, snap('20261109', '20261106', 1e9 + 3 * UNIT, { settled: false, partial: false }));
      fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify({ lastDate: '20261104', days: 10, cum: {} }));
      const before = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8');
      const ef = loadEf(dir);
      ef.stockMonthlyFlow('601398', '202611');
      const after = fs.readFileSync(path.join(dir, 'ledger.json'), 'utf8');
      ok(before === after, 'ledger.json 逐字节不变（未定稿值不入台账）');
    }

    // ---------- §5 前端接线 ----------
    console.log('\n[§5] 前端同步接线');
    {
      const fe = fs.readFileSync(path.join(ROOT, 'public/js/etfFlowPage.js'), 'utf8');
      const css = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
      ok(/etf-month-provisional/.test(fe), '前端为 provisional 行加了视觉区分 class');
      ok(/stockMonthData\.provisionalRows/.test(fe), '合计行按 provisionalRows 切换文案');
      ok(/不进入累计台账/.test(fe), '口径说明已披露「不进入累计台账」');
      ok(/\.etf-month-provisional td/.test(css), '样式表含对应规则');
    }

    // ---------- §6 前端真实渲染（静态断言之外，验证最终 HTML 里确有 11-06 行）----------
    console.log('\n[§6] etfFlowPage.js 真实渲染（vm 沙箱，无需浏览器）');
    {
      const vm = require('vm');
      const mkEl = () => ({
        innerHTML: '', textContent: '', style: {}, dataset: {},
        addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
        appendChild() {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      });
      const els = {};
      const sb = {
        console, Date, Math, JSON, Number, String, Array, Object, Promise, RegExp, Error,
        isNaN, parseInt, parseFloat, encodeURIComponent,
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        fetch: () => new Promise(() => {}),   // 挂起自动 load，改由注入 api 手动渲染
        document: {
          addEventListener() {}, getElementById(id) { return els[id] || (els[id] = mkEl()); },
          querySelector() { return null; }, querySelectorAll() { return []; },
          createElement() { return mkEl(); }, body: mkEl(),
        },
        echarts: { init() { return { setOption() {}, resize() {}, dispose() {} }; } },
      };
      sb.window = sb; sb.globalThis = sb;
      vm.createContext(sb);
      let src = fs.readFileSync(path.join(ROOT, 'public/js/etfFlowPage.js'), 'utf8');
      const cut = src.lastIndexOf('})();');
      src = src.slice(0, cut)
        + 'globalThis.__ef = { render, setData: d => { DATA = d; }, setMonth: (s, r) => { selectedStock = s; stockMonthData = r; } };\n'
        + src.slice(cut);
      vm.runInContext(src, sb, { timeout: 8000 });
      const api = sb.__ef;
      ok(!!(api && typeof api.render === 'function'), 'vm 成功加载 etfFlowPage render');
      const DATA = {
        ok: true, date: '20261106', settled: false,
        summary: { groups: [{ key: 'csi300', label: '沪深300', netAmount: 1.8e9 }], totalNet: 1820051640, ledgerDays: 10, ledgerDate: '20261104' },
        etfs: [{ code: '510300', name: '沪深300ETF', groupLabel: '沪深300', netAmount: 1.8e9 }],
        stocks: [{ code: '601318', name: '中国平安', dayBuy: 1430900, daySell: 0, cumBuy: 42255700, cumSell: 1018400, buyDays: 4, sellDays: 1 }],
        gaps: ['基期披露日 20261104 与本期 20261106 不相邻，净申赎为多日合计值'],
      };
      const monthData = {
        ok: true, code: '601318', month: '202611', provisionalRows: 1,
        rows: [
          { date: '20261102', buy: 8012500, sell: 0, net: 8012500 },
          { date: '20261103', buy: 25266400, sell: 67400, net: 25199000 },
          { date: '20261104', buy: 7545900, sell: 951000, net: 6594900 },
          { date: '20261106', buy: 1430900, sell: 0, net: 1430900, provisional: true, spanNote: '多日合计（20261104→20261106） · 含未定稿读数' },
        ],
        totals: { buy: 42255700, sell: 1018400, net: 41237300 },
      };
      api.setData(DATA);
      api.setMonth({ code: '601318', name: '中国平安' }, monthData);
      api.render(DATA);
      const html = els.efBody.innerHTML;
      ok(html.length > 500, `渲染出非空 HTML（${html.length} 字符）`);
      ok(/2026-11-06/.test(html), '11-06 数据日出现在表格里（用户看到的缺失日期回来了）');
      ok(/多日合计（20261104→20261106）/.test(html), '多日合计跨度标签已显示');
      ok(/含未定稿读数/.test(html), '含未定稿读数标签已显示');
      ok(/etf-month-provisional/.test(html), '未定稿行带视觉区分 class');
      ok(/含 1 行未定稿多日合计/.test(html), '合计行文案按 provisionalRows 诚实标注');
      ok(/不进入累计台账/.test(html), '口径说明披露「不进入累计台账」');
    }

    console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
  } catch (e) {
    console.error('FATAL', e && e.stack || e);
    fail++;
  } finally {
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
    delete process.env.SA_ETF_FLOW_DIR;
  }
  process.exit(fail ? 1 : 0);
})();
