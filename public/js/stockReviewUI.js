/**
 * public/js/stockReviewUI.js — 个股每日复盘 UI（20261110e · 替换原「策略」tab）
 * ==================================================================================
 * 联动：
 *  - [20261113b] 观察池带入 / 代码输入已按用户指令删除；生成对象固定为当前个股
 *  - 按 Symbol 生成/查看当日复盘卡片（POST /api/stock-review/:symbol/run）
 *  - 历史追踪（GET /api/stock-review/:symbol/history）+ 连续放弃信号反查横幅；日期由日历菜单切换
 * 渲染：本地随包 Markdown 渲染器（window.Markdown，零 CDN），复用全局 .dr-markdown 样式。
 * 严禁：本模块只做观察记录展示，不输出任何买卖建议。
 */
(function () {
  'use strict';

  const state = { symbol: null, name: null, pool: [], history: [], built: false, forceNext: false, busy: false };
  // [20261113a] 页面切换竞态令牌：onTabSwitch 每次切 tab 都会发 GET，返回后无条件写 DOM。
  // 若该 GET 晚于用户点击「生成今日复盘」返回，会把 loading 卡片与状态覆盖回旧快照，
  // 表现为「按钮变灰但没反应」。所有异步写 DOM 前必须校验自己仍是最新一代。
  let viewToken = 0;

  function todayStr() {
    const t = new Date();
    const p = function (n) { return String(n).padStart(2, '0'); };
    return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function mdHtml(md) {
    if (window.Markdown && typeof window.Markdown.render === 'function') {
      return '<article class="dr-markdown">' + window.Markdown.render(md) + '</article>';
    }
    return '<pre class="sr-fallback">' + esc(md) + '</pre>';
  }

  function ensureStyles() {
    if (document.getElementById('sr-style')) return;
    const st = document.createElement('style');
    st.id = 'sr-style';
    // [20261110f B0-8] 取色纪律：一律 var() 令牌（DESIGN.md §10），不再散落裸 hex。
    // 语义色：评级 S/A=红（正面）、B=中性灰、C=绿（负面）；放弃信号=绿（利空绿）。
    st.textContent = [
      '.sr-wrap{max-width:980px;margin:0 auto;padding:14px 6px;}',
      '.sr-toolbar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:12px 14px;margin-bottom:12px;}',
      '.sr-toolbar select,.sr-toolbar input{background:var(--bg-input);border:1px solid var(--border);color:var(--text-primary);border-radius:8px;padding:7px 10px;font-size:13px;outline:none;}',
      '.sr-toolbar input{width:130px;}',
      '.sr-btn{background:var(--bg-elevated);color:var(--text-primary);border:1px solid var(--border-strong);border-radius:8px;padding:7px 14px;font-size:13px;cursor:pointer;}',
      '.sr-btn:hover{background:var(--bg-hover);}',
      '.sr-btn-accent{background:var(--accent-light);color:var(--accent);border-color:var(--accent);font-weight:600;}',
      '.sr-btn:disabled{opacity:.5;cursor:not-allowed;}',
      '.sr-status{font-size:12px;color:var(--text-secondary);margin-left:4px;}',
      '.sr-banner{display:none;background:var(--tint-green);border:1px solid var(--green);color:var(--green);border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:12px;line-height:1.7;}',
      '.sr-meta{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px;}',
      '.sr-chip{display:inline-flex;align-items:center;gap:6px;background:var(--bg-card);border:1px solid var(--border);border-radius:999px;padding:4px 12px;font-size:12px;color:var(--text-primary);}',
      '.sr-chip b{font-weight:600;}',
      '.sr-chip-up{color:var(--red);border-color:var(--red);}',
      '.sr-chip-down{color:var(--green);border-color:var(--green);}',
      '.sr-chip-flat{color:var(--flat);border-color:var(--border);}',
      // [20261113b] 日历菜单（替代原「往日复盘记录」日期 chip 列表）
      '.sr-date-label{font-size:13px;color:var(--text-secondary);}',
      '.sr-date-input{background:var(--bg-input);border:1px solid var(--border);color:var(--text-primary);border-radius:8px;padding:6px 10px;font-size:13px;color-scheme:dark;}',
      '.sr-date-input:focus{outline:none;border-color:var(--accent);}',
      '.sr-date-nav{padding:6px 11px;line-height:1;font-size:15px;}',
      '.sr-card{background:var(--bg-card);border:1px solid var(--border);border-radius:12px;padding:6px 18px 14px;}',
      '.sr-empty{color:var(--text-secondary);font-size:13px;padding:24px 0;text-align:center;}',
      '.sr-loading{display:flex;align-items:center;gap:10px;color:var(--text-secondary);font-size:13px;padding:18px 4px;}',
      '.sr-spinner{width:16px;height:16px;border:2px solid var(--border-strong);border-top-color:var(--accent);border-radius:50%;animation:sr-spin .8s linear infinite;}',
      '@keyframes sr-spin{to{transform:rotate(360deg)}}',
      '.sr-fallback{background:var(--bg-input);color:var(--text-primary);border-radius:8px;padding:14px;white-space:pre-wrap;font-size:13px;}',
    ].join('\n');
    document.head.appendChild(st);
  }

  function buildDom(root) {
    root.innerHTML =
      '<div class="sr-wrap">' +
        '<div class="sr-toolbar">' +
          '<span class="sr-date-label">复盘日期</span>' +
          '<button id="srPrev" class="sr-btn sr-date-nav" type="button" title="上一个有复盘的日期">‹</button>' +
          '<input type="date" id="srDate" class="sr-date-input" title="点选任意日期查看当日复盘" />' +
          '<button id="srNext" class="sr-btn sr-date-nav" type="button" title="下一个有复盘的日期">›</button>' +
          '<button id="srRun" class="sr-btn sr-btn-accent">生成今日复盘</button>' +
          '<span id="srStatus" class="sr-status"></span>' +
        '</div>' +
        '<div id="srBanner" class="sr-banner"></div>' +
        '<div id="srMeta" class="sr-meta"></div>' +
        '<div id="srCard" class="sr-card"><div class="sr-empty">点「生成今日复盘」生成当日卡片；上方日期可切换查看往日复盘。</div></div>' +
      '</div>';

    root.querySelector('#srRun').addEventListener('click', runToday);
    root.querySelector('#srPrev').addEventListener('click', function () { stepDate(1); });
    root.querySelector('#srNext').addEventListener('click', function () { stepDate(-1); });
    root.querySelector('#srDate').addEventListener('change', function () {
      const d = this.value;
      if (d && state.symbol) viewDate(state.symbol, d);
    });
  }

  /** [20261113b] 日历菜单：按历史记录日期前后跳转（dir=+1 更早、-1 更新）。
   *  历史由 loadHistory 在每次切股/生成后写入 state.history；为空时兜底提示，不发请求。 */
  function stepDate(dir) {
    if (!state.symbol) { setStatus('请先切换个股'); return; }
    if (!state.history.length) { setStatus('暂无历史复盘可切换'); return; }
    const dates = state.history.map(function (r) { return r.date; });
    const inp = document.getElementById('srDate');
    const cur = (inp && inp.value) || '';
    let idx = dates.indexOf(cur);
    if (idx < 0) idx = 0;
    const next = Math.min(dates.length - 1, Math.max(0, idx + dir));
    if (next === idx) { setStatus(dir > 0 ? '已是最早一份复盘' : '已是最新一份复盘'); return; }
    viewDate(state.symbol, dates[next]);
  }

  function setStatus(msg) {
    const el = document.getElementById('srStatus');
    if (el) el.textContent = msg || '';
  }
  function setLoading(on) {
    const btn = document.getElementById('srRun');
    if (btn) btn.disabled = !!on;
    const card = document.getElementById('srCard');
    if (on && card) card.innerHTML = '<div class="sr-loading"><span class="sr-spinner"></span>正在采集行情 / 板块 / 资金 / 消息面数据并生成复盘…（首次约需 1-3 分钟）</div>';
    // 数据加载完成或失败时立即移除 loading 状态，不残留
    if (!on && card && card.querySelector('.sr-loading')) card.innerHTML = '<div class="sr-empty">生成失败，请重试。</div>';
  }

  async function api(url, opts) {
    const res = await fetch(url, opts);
    const j = await res.json().catch(() => null);
    if (!j || j.success === false) throw new Error((j && j.error) || ('HTTP ' + res.status));
    return j;
  }

  /** [20261113b] 只拉取历史日期供日历菜单前后切换，不再渲染日期 chip 列表。
   *  同时把日历输入框的可用区间钉到「最早一份 ~ 今天」，并标注可选日期数。 */
  async function loadHistory(symbol) {
    if (!symbol) { state.history = []; return; }
    try {
      const j = await api('/api/stock-review/' + encodeURIComponent(symbol) + '/history');
      state.history = j.reviews || [];
    } catch (e) {
      state.history = [];
    }
    const inp = document.getElementById('srDate');
    if (!inp) return;
    if (state.history.length) {
      const dates = state.history.map(function (r) { return r.date; }).sort();
      inp.min = dates[0];
      inp.max = todayStr();
      inp.title = '点选任意日期查看当日复盘（已有复盘 ' + state.history.length + ' 份）';
    } else {
      inp.removeAttribute('min');
      inp.max = todayStr();
      inp.title = '点选任意日期查看当日复盘（暂无历史记录）';
    }
    // [20261113c] 当前选中日期无记录（周末/未生成）→ 日历回落到最近一份记录日期，
    // 避免默认停在休息日、点生成被后端「非交易日」拒绝。仅在切股/生成后调用，不干扰手动选日。
    if (state.history.length) {
      const dates = state.history.map(function (r) { return r.date; }).sort().reverse();
      if (!inp.value || dates.indexOf(inp.value) < 0) inp.value = dates[0];
    }
    return state.history;
  }

  function renderMeta(rec) {
    const box = document.getElementById('srMeta');
    if (!box) return;
    const chips = [];
    if (rec.name) chips.push('<span class="sr-chip"><b>' + esc(rec.name) + '</b>（' + esc(rec.symbol) + '）</span>');
    if (rec.marks && rec.marks.rating) {
      // [20261110f B0-8] 语义色：S/A=红（正面）、B=中性灰（观察）、C=绿（负面），不把 B 染成红。
      const r = rec.marks.rating;
      const cls = (r === 'S' || r === 'A') ? 'sr-chip-up' : (r === 'C' ? 'sr-chip-down' : 'sr-chip-flat');
      chips.push('<span class="sr-chip">评级判定 <b class="' + cls + '">' + esc(r) + '</b></span>');
    }
    if (rec.marks && rec.marks.giveupTriggered != null) {
      // 放弃信号=利空 → 绿；未触发=中性灰
      chips.push('<span class="sr-chip">放弃信号 <b class="' +
        (rec.marks.giveupTriggered ? 'sr-chip-down' : 'sr-chip-flat') + '">' + (rec.marks.giveupTriggered ? '触发' : '未触发') + '</b></span>');
    }
    if (rec.giveupStreak > 0) {
      chips.push('<span class="sr-chip">连续放弃 <b>' + esc(rec.giveupStreak) + '</b> 天</span>');
    }
    if (rec.poolEntry) {
      chips.push('<span class="sr-chip">来自大盘复盘观察池（' + esc(rec.poolDate || '') + '）</span>');
    }
    if (rec.llm && rec.llm.degraded) {
      chips.push('<span class="sr-chip sr-chip-flat">AI 暂不可用，已发布数据快照</span>');
    } else if (rec.llm && rec.llm.model) {
      chips.push('<span class="sr-chip">AI 生成 · ' + esc(rec.llm.model) + '</span>');
    }
    box.innerHTML = chips.join('');
  }

  function renderBanner(rec) {
    const b = document.getElementById('srBanner');
    if (!b) return;
    const gaps = (rec && Array.isArray(rec.dataGaps)) ? rec.dataGaps : [];
    const giveup = rec && rec.giveupStreak >= 3;
    if (giveup || gaps.length) {
      b.style.display = 'block';
      const parts = [];
      if (giveup) {
        parts.push('⚠️ 该股已连续 <b>' + esc(rec.giveupStreak) + '</b> 个复盘日触发放弃信号——今日卡片末尾的「连续放弃信号反查」一节已用历史记录反查 AI 漏看的数据与环境变化，请重点阅读。');
      }
      // [20261113d] 历史补生成 / 数据缺口如实告知（不静默）
      if (gaps.length) {
        parts.push('⚠️ 数据不足：' + gaps.map(function (g) { return esc(g); }).join('；'));
      }
      b.innerHTML = parts.join('<br>');
    } else {
      b.style.display = 'none';
      b.innerHTML = '';
    }
  }

  function renderReview(rec) {
    renderMeta(rec);
    renderBanner(rec);
    const card = document.getElementById('srCard');
    if (card) card.innerHTML = mdHtml(rec.markdown || '');
  }

  async function viewDate(symbol, date) {
    const tk = ++viewToken;
    const inp = document.getElementById('srDate');
    if (inp && date) inp.value = date; // 日历菜单与当前查看日期保持同步
    setLoading(false);
    setStatus('查看 ' + date + ' …');
    try {
      const j = await api('/api/stock-review/' + encodeURIComponent(symbol) + '/' + date);
      if (tk !== viewToken) return;
      renderReview(j.review);
      setStatus('正在查看历史复盘 ' + date);
    } catch (e) { if (tk === viewToken) setStatus('读取失败：' + e.message); }
  }

  async function runToday() {
    // [20261113b] 观察池/代码输入已移除：生成对象固定为当前个股
    const symbol = state.symbol;
    const name = state.name || null;
    if (!symbol) { setStatus('请先切换个股'); return; }
    // [20261113c] 生成日期 = 日历选中日期（原实现永远按「今天」生成，周末会把最近交易日数据
    // 写成休息日卡片）。日历为空时回落今天；非交易日由后端拒绝并回显原因。
    const dateInp = document.getElementById('srDate');
    const targetDate = (dateInp && dateInp.value) || todayStr();
    state.symbol = symbol; state.name = name;
    // 抢到最新一代：在途的切 tab GET 一律作废，避免它覆盖「生成中」卡片与状态
    const tk = ++viewToken;
    state.busy = true;
    setLoading(true);
    setStatus('生成中…（' + targetDate + '）');
    try {
      const j = await api('/api/stock-review/' + encodeURIComponent(symbol) + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 当日缓存若是 LLM 降级快照则自动 force 重生成（20261110e 事故修复），正常缓存直接复用
        body: JSON.stringify({ name: name, force: !!state.forceNext, date: targetDate }),
      });
      if (tk !== viewToken) return; // 期间已切股/切页，丢弃本次结果
      state.forceNext = false;
      if (dateInp) dateInp.value = j.review.date; // 日历与生成结果对齐（后端以落盘日期为准）
      renderReview(j.review);
      setStatus('已生成 ' + j.review.date + '（' + (j.review.llm && j.review.llm.elapsedMs ? Math.round(j.review.llm.elapsedMs / 1000) + 's' : '') + '）');
      loadHistory(j.review.symbol || symbol);
    } catch (e) {
      if (tk !== viewToken) return;
      setStatus('生成失败：' + e.message);
    } finally {
      // 成功/失败都必须复位按钮；原实现成功路径漏了 setLoading(false)，按钮会永久置灰
      state.busy = false;
      if (tk === viewToken) setLoading(false);
    }
  }

  async function onTabSwitch(symbol, name) {
    ensureStyles();
    const root = document.getElementById('tab-stockreview');
    if (!root) return;
    if (!state.built) { buildDom(root); state.built = true; }
    // 回到该 tab 时若没有在途生成，强制复位按钮——修「上次成功后按钮永久置灰」
    if (!state.busy) setLoading(false);
    if (symbol && symbol !== state.symbol) {
      state.symbol = symbol;
      state.name = name || null;
      state.forceNext = false;
      const tk = ++viewToken;
      const inp = document.getElementById('srDate');
      if (inp && !inp.value) inp.value = todayStr(); // 日历默认停在今天
      setStatus('');
      loadHistory(symbol); // 先填日历可用区间，再拉当日卡片
      const card = document.getElementById('srCard');
      // 已有当日缓存则直接展示，否则保持提示
      try {
        const j = await api('/api/stock-review/' + encodeURIComponent(symbol));
        if (tk !== viewToken) return; // 已切股或已点生成，丢弃过期响应（修「覆盖 loading」竞态）
        if (j && j.review) {
          renderReview(j.review);
          // 当日缓存为 LLM 降级快照 → 标记下次点击「生成今日复盘」自动 force 重生成
          state.forceNext = (j.review.date === todayStr()) && !!(j.review.llm && j.review.llm.degraded);
          if (state.forceNext) setStatus('今日卡片是降级数据快照，点「生成今日复盘」将自动重新生成正式版');
          else setStatus('已加载 ' + j.review.date + ' 复盘');
        }
        else if (card) card.innerHTML = '<div class="sr-empty">「' + esc(name || symbol) + '」今日还没有复盘卡片，点上方「生成今日复盘」。</div>';
      } catch (e) { /* 无记录属正常 */ }
    }
  }

  window.StockReviewUI = { onTabSwitch: onTabSwitch };
})();
