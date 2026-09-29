'use strict';
/**
 * public/js/backtestUI.js — 策略回测校验模块前端
 * 依赖：lib/backtestValidator.js（后端纯 JS 引擎）
 * 调用：app.js switchTab('backtest') → BacktestUI.open(symbol, name)
 */
window.BacktestUI = (function () {
  let current = { symbol: '', name: '' };
  let lastRenderedSymbol = ''; // 已渲染结果对应的个股（用于「策略页随个股切换」自动重渲染判定）

  // 高级框「一键模板」：纯前端确定性预设，点击后填入合法 DSL（避免零代码用户手写 DSL 出错）
  const PRESETS = [
    { label: '双均线金叉(5,20)', dsl: 'STRATEGY_TYPE: single\nNAME: 双均线金叉(5,20)\nBUY: CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))\nSELL: CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))' },
    { label: 'MACD金叉', dsl: 'STRATEGY_TYPE: single\nNAME: MACD金叉\nBUY: CROSS_UP(MACD_DIF(CLOSE), MACD_DEA(CLOSE))\nSELL: CROSS_DOWN(MACD_DIF(CLOSE), MACD_DEA(CLOSE))' },
    { label: 'RSI超卖反弹(14)', dsl: 'STRATEGY_TYPE: single\nNAME: RSI超卖反弹(14)\nBUY: RSI(CLOSE,14) < 30\nSELL: RSI(CLOSE,14) > 70' },
    { label: '布林带下轨买入(20,2)', dsl: 'STRATEGY_TYPE: single\nNAME: 布林带下轨买入(20,2)\nBUY: CLOSE < BOLL_LOWER(CLOSE,20,2)\nSELL: CLOSE > BOLL_MID(CLOSE,20,2)' },
    { label: '价格z-score回归(20)', dsl: 'STRATEGY_TYPE: single\nNAME: 价格z-score回归(20)\nBUY: ZSCORE(CLOSE,20) < -1.5\nSELL: ZSCORE(CLOSE,20) > 1.5' }
  ];

  function el(id) { return document.getElementById(id); }
  function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }
  function cls(x) { return x > 0 ? 'up' : (x < 0 ? 'down' : ''); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function metricCard(k, v, c) {
    return '<div class="bt-metric"><div class="k">' + k + '</div><div class="v ' + (c || '') + '">' + v + '</div></div>';
  }
  function verdictBadge(v) {
    const label = v === 'PASS' ? '✅ 通过' : (v === 'WARNING' ? '⚠️ 警示' : '⛔ 否决');
    return '<span class="bt-verdict ' + v + '">' + label + ' · ' + v + '</span>';
  }
  function num(x, d) { return (x == null || isNaN(x)) ? '-' : (typeof x === 'number' ? x.toFixed(d == null ? 2 : d) : x); }

  // 5 大类中文名（与 lib/strategyGenerator.js CATEGORY_NAMES 对齐）
  const CAT_NAMES = { trend: '趋势跟踪', mean_reversion: '均值回归', momentum: '动量/轮动', value: '价值/基本面', event: '事件驱动', other: '其他' };
  const CAT_ORDER = ['trend', 'mean_reversion', 'momentum', 'value', 'event'];

  // 解析「当前个股」：优先 app.js 传入，其次全局 App 当前状态，再次 URL ?symbol=
  function resolveSymbol() {
    if (!current.symbol) {
      try {
        if (typeof App !== 'undefined' && App.currentSymbol) {
          current.symbol = App.currentSymbol;
          if (!current.name && App.currentData && App.currentData.name) current.name = App.currentData.name;
        }
      } catch (e) { /* ignore */ }
    }
    if (!current.symbol) {
      try {
        const p = new URLSearchParams(location.search).get('symbol');
        if (p) current.symbol = p;
      } catch (e) { /* ignore */ }
    }
    return current.symbol;
  }

  function refreshStockLabel() {
    const lab = el('btCurrentStock');
    if (!lab) return;
    if (current.symbol) {
      lab.textContent = '当前个股：' + current.symbol + (current.name ? '（' + current.name + '）' : '');
      lab.className = 'bt-current ok';
    } else {
      lab.textContent = '当前个股：未选择（请先在左侧搜索并打开一只股票）';
      lab.className = 'bt-current err';
    }
  }

  // 由 app.js 在切换 Tab / 切换个股时调用
  function open(symbol, name) {
    let symbolChanged = false;
    if (symbol && symbol !== current.symbol) { current.symbol = symbol; symbolChanged = true; }
    if (name) current.name = name;
    resolveSymbol();
    refreshStockLabel();
    const status = el('btStatus');
    if (status) { status.textContent = ''; status.className = 'bt-status'; }
    // 修复「策略页不随个股切换」：个股变化（切股 / 切到新个股 Tab）时清掉旧结果并自动重算
    if (symbol && symbol !== lastRenderedSymbol) {
      const r = el('btResult');
      if (r) r.innerHTML = '<div class="bt-section"><div class="bt-advice">已切换至 ' + escapeHtml(symbol) + (current.name ? '（' + escapeHtml(current.name) + '）' : '') + '，正在自动生成策略…</div></div>';
      runAuto();
    }
  }

  async function run() {
    const btn = el('btRun'), status = el('btStatus'), result = el('btResult');
    if (!resolveSymbol()) {
      refreshStockLabel();
      status.textContent = '请先在左侧搜索并打开一只股票';
      status.className = 'bt-status err';
      return;
    }
    const dslText = (el('btDsl').value || '') + '\nRANGE: ' + el('btRange').value;
    btn.disabled = true;
    status.textContent = '校验中…';
    status.className = 'bt-status';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const resp = await fetch('/api/backtest-validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: current.symbol, name: current.name, dsl: dslText }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || '校验失败');
      render(data);
      status.textContent = '校验完成';
      status.className = 'bt-status ok';
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? '请求超时（>60秒）' : (e && e.message);
      status.textContent = '错误：' + msg;
      status.className = 'bt-status err';
      if (result) result.innerHTML = '<div class="bt-section"><div class="bt-advice">' + escapeHtml(msg) + '</div></div>';
    } finally {
      btn.disabled = false;
    }
  }

  function render(data) {
    const r = el('btResult');
    if (!r) return;
    const bi = data.base_info || {};
    const raw = data.raw_backtest_result || {};
    const full = raw.full || {}; const train = raw.train || {}; const test = raw.test || {};
    const risk = data.risk_check_result || {};
    const adj = data.adjusted_result || {};
    const op = data.operation_suggestion || {};
    const diag = data.diagnostics || {};
    const co = risk.cointegration;

    let html = '';

    // ① 基础信息
    html += '<div class="bt-section"><h3>① 基础信息</h3><div class="bt-grid">'
      + metricCard('标的', bi.symbol || '-')
      + metricCard('策略', bi.strategy_name || bi.strategy_type || '-')
      + metricCard('区间', bi.range || '-')
      + metricCard('数据点', bi.data_points || 0)
      + metricCard('单边成本', (bi.cost_per_side != null ? (bi.cost_per_side * 100).toFixed(2) : '-') + '%')
      + metricCard('数据契约', '前复权 qfq')
      + '</div><div class="bt-note">' + (bi.contract && bi.contract.note ? bi.contract.note : '') + '</div></div>';

    // ①b 若输入是大白话中文 → 展示确定性翻译出的规则（透明、可复核）
    if (bi.derived_from === 'natural_language') {
      html += '<div class="bt-section"><h3>🧠 你的中文描述已翻译为规则</h3>'
        + '<div class="bt-dsl">买：' + escapeHtml(bi.derived_buy || '') + '<br>卖：' + escapeHtml(bi.derived_sell || '') + '</div>'
        + ((bi.derived_notes && bi.derived_notes.length) ? '<div class="bt-note">' + bi.derived_notes.map(escapeHtml).join('<br>') + '</div>' : '')
        + '</div>';
    }

    // ② 原始虚拟回测
    html += '<div class="bt-section"><h3>② 原始虚拟回测（T+1 · 含成本）</h3><div class="bt-grid">'
      + metricCard('全样本胜率', fmtPct(full.winRate || 0), cls((full.winRate || 0) - 0.5))
      + metricCard('全样本交易数', full.totalTrades || 0)
      + metricCard('全样本收益', (full.totalReturn * 100).toFixed(1) + '%', cls(full.totalReturn))
      + metricCard('买入持有', (full.buyHold * 100).toFixed(1) + '%', cls(full.buyHold))
      + metricCard('最大回撤', (full.maxDrawdown * 100).toFixed(1) + '%')
      + metricCard('夏普', num(full.sharpe))
      + '</div><div class="bt-note">训练集胜率 ' + fmtPct(train.winRate || 0) + '（' + (train.totalTrades || 0) + '笔） ｜ 测试集胜率 '
      + fmtPct(test.winRate || 0) + '（' + (test.totalTrades || 0) + '笔）｜ 训练/测试拆分 ' + ((bi.train_ratio * 100).toFixed(0)) + '%</div></div>';

    // ③ 统计检验
    const adfP = risk.adf_price || {}, adfR = risk.adf_return || {}, kp = risk.kpss_price || {};
    html += '<div class="bt-section"><h3>③ 统计检验（风险校验）</h3>'
      + '<table class="bt-table"><thead><tr><th>检验</th><th>统计量</th><th>临界值(p5)</th><th>结论</th></tr></thead><tbody>'
      + '<tr><td>ADF 价格</td><td>' + num(adfP.stat) + '</td><td>' + (adfP.critical ? adfP.critical.p5 : '-') + '</td><td>' + (adfP.stationary ? '平稳' : '非平稳') + '</td></tr>'
      + '<tr><td>ADF 收益率</td><td>' + num(adfR.stat) + '</td><td>' + (adfR.critical ? adfR.critical.p5 : '-') + '</td><td>' + (adfR.stationary ? '平稳' : '非平稳') + '</td></tr>'
      + '<tr><td>KPSS 价格</td><td>' + num(kp.stat) + '</td><td>' + (kp.critical ? kp.critical.p5 : '-') + '</td><td>' + (kp.stationary ? '平稳' : '非平稳') + '</td></tr>'
      + (co ? '<tr><td>协整(EG)</td><td>' + num(co.stat) + '</td><td>' + (co.critical ? co.critical.p5 : '-') + '</td><td>' + (co.cointegrated ? '协整' : '不协整') + '</td></tr>' : '')
      + '</tbody></table>'
      + '<div class="bt-note">ACF(1)=' + (risk.acf ? risk.acf.lag1 : '-') + ' ｜ PACF(lag1-5)=' + (risk.pacf_lag1_5 ? risk.pacf_lag1_5.join(', ') : '-') + ' ｜ ' + (risk.notes || []).join('；') + '</div></div>';

    // ④ 五大胜率修正
    const steps = (adj.corrections || []).map(s =>
      '<tr><td>' + s.name + '</td><td class="factor">×' + (s.factor * 100).toFixed(1) + '%</td><td>' + s.note + '</td></tr>'
    ).join('');
    html += '<div class="bt-section"><h3>④ 五大胜率修正</h3>'
      + '<table class="bt-table"><thead><tr><th>步骤</th><th>系数</th><th>说明</th></tr></thead><tbody>' + steps + '</tbody></table>'
      + '<div class="bt-grid" style="margin-top:12px">'
      + metricCard('修正后胜率', fmtPct(adj.adjusted_win_rate || 0), cls((adj.adjusted_win_rate || 0) - 0.5))
      + metricCard('修正后收益', (adj.adjusted_return * 100).toFixed(1) + '%', cls(adj.adjusted_return))
      + '</div></div>';

    // ⑤ 操作建议
    html += '<div class="bt-section"><h3>⑤ 操作建议</h3>'
      + verdictBadge(op.verdict)
      + '<div class="bt-advice">' + (op.advice || '') + '</div>'
      + '<div class="bt-diag">信号日（买/卖）：' + (diag.buy_signal_days || 0) + ' / ' + (diag.sell_signal_days || 0) + ' ｜ ' + (diag.note || '') + '</div></div>';

    r.innerHTML = html;
    lastRenderedSymbol = current.symbol;
  }

  // —— 自动策略生成流程（无需用户 DSL）——
  async function runAuto() {
    const btn = el('btAuto'), status = el('btStatus'), result = el('btResult');
    if (!resolveSymbol()) {
      refreshStockLabel();
      status.textContent = '请先在左侧搜索并打开一只股票';
      status.className = 'bt-status err';
      return;
    }
    btn.disabled = true;
    status.textContent = '正在分析当前个股并生成策略（取历史数据 → 枚举候选 → 回测 → 风控修正）…';
    status.className = 'bt-status';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      const resp = await fetch('/api/auto-strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: current.symbol, name: current.name, range: el('btRange').value }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || '生成失败');
      renderAuto(data);
      status.textContent = '自动策略生成完成';
      status.className = 'bt-status ok';
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? '请求超时（>120秒）' : '错误：' + (e && e.message);
      status.textContent = msg;
      status.className = 'bt-status err';
      if (result) result.innerHTML = '<div class="bt-section"><div class="bt-advice">' + msg + '</div></div>';
    } finally {
      btn.disabled = false;
    }
  }

  function renderAuto(data) {
    const r = el('btResult');
    if (!r) return;
    const bi = data.base_info || {};
    const mc = data.market_context || {};
    const ps = data.parameter_sensitivity || {};
    const ranked = data.ranked_strategies || [];
    const best = data.best_strategy;
    const adv = data.operation_advice || {};
    let html = '';

    // 头部：市场语境（平稳性闸门依据）
    html += '<div class="bt-section"><h3>🌐 市场语境（数据特征）</h3><div class="bt-grid">'
      + metricCard('价格 ADF', (mc.adf_price ? (mc.adf_price.stationary ? '平稳' : '非平稳') : '-'), mc.adf_price && mc.adf_price.stationary ? '' : 'down')
      + metricCard('收益率 ADF', (mc.adf_return ? (mc.adf_return.stationary ? '平稳' : '非平稳') : '-'), mc.adf_return && mc.adf_return.stationary ? '' : 'down')
      + metricCard('趋势 R²', mc.trend ? mc.trend.r2 : '-', '')
      + metricCard('季节性', mc.seasonality && mc.seasonality.hasSeasonality ? '有' : '无', '')
      + metricCard('候选策略', bi.candidate_count || 0)
      + metricCard('有效/剔除', (bi.valid_count || 0) + ' / ' + (bi.insufficient_count || 0))
      + '</div>'
      + '<div class="bt-note">价格' + (mc.adf_price && mc.adf_price.stationary ? '平稳' : '非平稳') + ' → '
      + (mc.adf_price && !mc.adf_price.stationary ? '均值回归类须落于「平稳收益率」上（RET/ZSCORE 路径），否则按伪回归陷阱 ×0.5 折算。' : '可直接做趋势/回归。')
      + '</div></div>';

    // 参数敏感性（E 项）
    html += '<div class="bt-section"><h3>🎚️ 参数敏感性汇总</h3><div class="bt-grid">'
      + metricCard('候选数', ps.candidate_count || 0)
      + metricCard('修正胜率 最高', (ps.max != null ? (ps.max * 100).toFixed(1) + '%' : '-'))
      + metricCard('修正胜率 最低', (ps.min != null ? (ps.min * 100).toFixed(1) + '%' : '-'))
      + metricCard('离散度', (ps.spread != null ? (ps.spread * 100).toFixed(1) + 'pp' : '-'), ps.spread > 0.1 ? 'down' : '')
      + '</div><div class="bt-note">' + (ps.note || '') + '</div></div>';

    // 最优策略
    if (best) {
      html += '<div class="bt-section"><h3>🏆 最优策略：' + best.name + '</h3>'
        + '<span class="bt-verdict ' + best.verdict + '">' + verdictBadgeText(best.verdict) + '</span>'
        + '<div class="bt-grid" style="margin-top:10px">'
        + metricCard('修正后胜率', (best.adjusted_win_rate * 100).toFixed(1) + '%', cls(best.adjusted_win_rate - 0.5))
        + metricCard('原始胜率', (best.raw.winRate * 100).toFixed(1) + '%', cls(best.raw.winRate - 0.5))
        + metricCard('交易笔数', best.raw.trades)
        + metricCard('样本外一致性', (best.walk_forward ? (best.walk_forward.consistency * 100).toFixed(0) + '%' : '-'), best.walk_forward && best.walk_forward.consistency < 0.8 ? 'down' : '')
        + metricCard('类别', CAT_NAMES[best.category] || best.cls)
        + '</div>'
        + '<div class="bt-dsl">买：' + best.dsl.buy + '<br>卖：' + best.dsl.sell + '</div>'
        + (best.warnings && best.warnings.length ? '<div class="bt-warn">' + best.warnings.map(w => '⚠ ' + w).join('<br>') + '</div>' : '')
        + '</div>';
    }

    // 排名列表（按 5 大类分组）
    html += '<div class="bt-section"><h3>📊 候选策略排名（按 5 大类分组）</h3>';
    const catsAll = Object.keys(data.category_summary || {});
    const orderedCats = CAT_ORDER.filter(c => catsAll.indexOf(c) >= 0).concat(catsAll.filter(c => CAT_ORDER.indexOf(c) < 0));
    const byCat = {};
    ranked.forEach(s => { (byCat[s.category] = byCat[s.category] || []).push(s); });
    orderedCats.forEach(cat => {
      const sum = (data.category_summary || {})[cat] || { valid: 0, insufficient: 0 };
      const list = byCat[cat] || [];
      html += '<div class="bt-cat"><div class="bt-cat-h">'
        + '<span class="bt-cat-name">' + (CAT_NAMES[cat] || cat) + '</span>'
        + '<span class="bt-cat-meta">有效 ' + (sum.valid || 0) + ' · 剔除 ' + (sum.insufficient || 0) + '</span></div>';
      if (list.length) {
        html += '<table class="bt-table"><thead><tr>'
          + '<th>策略</th><th>原始胜率</th><th>修正胜率</th><th>交易</th><th>walk-forward</th><th>结论</th></tr></thead><tbody>';
        list.forEach(s => {
          html += '<tr' + (s.key === (best && best.key) ? ' class="bt-best-row"' : '') + '>'
            + '<td>' + s.name + '</td>'
            + '<td>' + fmtPct(s.raw.winRate) + '</td>'
            + '<td>' + fmtPct(s.adjusted_win_rate) + '</td>'
            + '<td>' + s.raw.trades + '</td>'
            + '<td>' + (s.walk_forward ? (s.walk_forward.consistency * 100).toFixed(0) + '%' : '-') + '</td>'
            + '<td>' + verdictBadgeText(s.verdict) + '</td></tr>';
        });
        html += '</tbody></table>';
      } else {
        html += '<div class="bt-note">该类别下无有效策略</div>';
      }
      html += '</div>';
    });
    html += '</div>';

    // 数据备注（跨模块数据获取情况：价值/事件 数据缺失时说明跳过）
    const dn = data.data_notes || {};
    const dnLabel = { value: '价值/基本面', event: '事件驱动' };
    const dnLines = Object.keys(dn).map(k => (dnLabel[k] || k) + '：' + dn[k]);
    if (dnLines.length) {
      html += '<div class="bt-section"><h3>📎 数据备注</h3>' + dnLines.map(t => '<div class="bt-note">' + t + '</div>').join('') + '</div>';
    }

    // 未触发 / 已剔除策略（含原因，按类别列示）
    const ins = data.insufficient_strategies || [];
    if (ins.length) {
      html += '<div class="bt-section"><h3>🚫 未触发 / 已剔除（' + ins.length + ' 套）</h3>'
        + '<table class="bt-table"><thead><tr><th>策略</th><th>类别</th><th>交易笔数</th><th>原因</th></tr></thead><tbody>';
      ins.forEach(s => {
        html += '<tr><td>' + s.name + '</td><td>' + (CAT_NAMES[s.category] || s.category || '-') + '</td><td>' + (s.trades != null ? s.trades : '-') + '</td><td>' + (s.reason || '-') + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    // 操作建议（LLM 叙事 + 确定性兜底）
    html += '<div class="bt-section"><h3>💡 操作建议</h3>'
      + verdictBadge(adv.verdict)
      + '<div class="bt-advice">' + (adv.narrative || '') + '</div>'
      + (adv.deterministic ? '<div class="bt-note">（以上为确定性规则生成的文字；配置 AI 密钥后可获得更口语化的解读）</div>' : '')
      + '</div>';

    r.innerHTML = html;
    lastRenderedSymbol = current.symbol;
  }

  function verdictBadgeText(v) {
    return v === 'PASS' ? '✅ 通过' : (v === 'WARNING' ? '⚠️ 警示' : '⛔ 否决');
  }

  function init() {
    const btn = el('btRun');
    if (btn && !btn.dataset.btWired) {
      btn.dataset.btWired = '1';
      btn.addEventListener('click', run);
    }
    const auto = el('btAuto');
    if (auto && !auto.dataset.btWired) {
      auto.dataset.btWired = '1';
      auto.addEventListener('click', runAuto);
    }
    // 高级框「一键模板」按钮：点击把合法 DSL 填入文本框
    const pc = el('btPresets');
    if (pc && !pc.dataset.btWired) {
      pc.dataset.btWired = '1';
      PRESETS.forEach(function (p) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bt-preset';
        b.textContent = p.label;
        b.addEventListener('click', function () {
          const ta = el('btDsl');
          if (ta) { ta.value = p.dsl; ta.focus(); }
        });
        pc.appendChild(b);
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { open: open, run: run, render: render };
})();
