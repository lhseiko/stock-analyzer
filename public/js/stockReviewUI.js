/**
 * public/js/stockReviewUI.js — 个股每日复盘 UI（20261110e · 替换原「策略」tab）
 * ==================================================================================
 * 联动：
 *  - 大盘复盘「明日核心观察池」自动带入（GET /api/stock-review/pool）
 *  - 按 Symbol 生成/查看当日复盘卡片（POST /api/stock-review/:symbol/run）
 *  - 历史追踪（GET /api/stock-review/:symbol/history）+ 连续放弃信号反查横幅
 * 渲染：本地随包 Markdown 渲染器（window.Markdown，零 CDN），复用全局 .dr-markdown 样式。
 * 严禁：本模块只做观察记录展示，不输出任何买卖建议。
 */
(function () {
  'use strict';

  const state = { symbol: null, name: null, pool: [], history: [], built: false, forceNext: false };

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
      '.sr-hist{display:flex;flex-wrap:wrap;gap:8px;margin:14px 0 6px;}',
      '.sr-hist-item{background:var(--bg-card);border:1px solid var(--border);color:var(--text-primary);border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;}',
      '.sr-hist-item:hover{border-color:var(--accent);}',
      '.sr-hist-item .g{color:var(--green);margin-left:4px;}',
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
          '<label style="font-size:13px;color:#8B949E;">观察池带入</label>' +
          '<select id="srPool"><option value="">（加载大盘复盘观察池…）</option></select>' +
          '<label style="font-size:13px;color:#8B949E;">或输代码</label>' +
          '<input id="srSymbol" placeholder="如 601318" />' +
          '<button id="srRun" class="sr-btn sr-btn-accent">生成今日复盘</button>' +
          '<span id="srStatus" class="sr-status"></span>' +
        '</div>' +
        '<div id="srBanner" class="sr-banner"></div>' +
        '<div id="srMeta" class="sr-meta"></div>' +
        '<div id="srCard" class="sr-card"><div class="sr-empty">选择股票后点「生成今日复盘」；已生成的日期会出现在下方历史中，点击即可回看。</div></div>' +
        '<div id="srHist" class="sr-hist"></div>' +
      '</div>';

    root.querySelector('#srRun').addEventListener('click', runToday);
    root.querySelector('#srSymbol').addEventListener('keydown', function (e) { if (e.key === 'Enter') runToday(); });
    root.querySelector('#srPool').addEventListener('change', function () {
      const v = this.value;
      if (v) root.querySelector('#srSymbol').value = '';
      void v; // 名称生成走 runToday 内的 pool 解析
    });
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

  async function loadPool() {
    const sel = document.getElementById('srPool');
    if (!sel) return;
    try {
      const j = await api('/api/stock-review/pool');
      state.pool = (j.rows || []);
      if (!state.pool.length) {
        sel.innerHTML = '<option value="">（今日大盘复盘暂无核心观察池）</option>';
        return;
      }
      sel.innerHTML = '<option value="">— 从「明日核心观察池」选择（' + esc(j.date || '') + '）—</option>' +
        state.pool.map(function (r, i) {
          return '<option value="' + i + '">' + esc(r.name) + (r.rating ? ' · ' + esc(r.rating) : '') + '</option>';
        }).join('');
    } catch (e) {
      sel.innerHTML = '<option value="">（观察池加载失败：' + esc(e.message) + '）</option>';
    }
  }

  async function loadHistory(symbol) {
    const box = document.getElementById('srHist');
    if (!box) return;
    box.innerHTML = '';
    if (!symbol) return;
    try {
      const j = await api('/api/stock-review/' + encodeURIComponent(symbol) + '/history');
      state.history = j.reviews || [];
      state.history.forEach(function (r) {
        const b = document.createElement('button');
        b.className = 'sr-hist-item';
        b.innerHTML = esc(r.date) +
          (r.rating ? ' · ' + esc(r.rating) : '') +
          (r.giveupTriggered ? '<span class="g">放弃</span>' : '');
        b.addEventListener('click', function () { viewDate(symbol, r.date); });
        box.appendChild(b);
      });
    } catch (e) { /* 历史为空/加载失败不阻塞主流程 */ }
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
    if (rec && rec.giveupStreak >= 3) {
      b.style.display = 'block';
      b.innerHTML = '⚠️ 该股已连续 <b>' + esc(rec.giveupStreak) + '</b> 个复盘日触发放弃信号——今日卡片末尾的「连续放弃信号反查」一节已用历史记录反查 AI 漏看的数据与环境变化，请重点阅读。';
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
    setLoading(false);
    setStatus('查看 ' + date + ' …');
    try {
      const j = await api('/api/stock-review/' + encodeURIComponent(symbol) + '/' + date);
      renderReview(j.review);
      setStatus('正在查看历史复盘 ' + date);
    } catch (e) { setStatus('读取失败：' + e.message); }
  }

  async function runToday() {
    const input = document.getElementById('srSymbol');
    const poolSel = document.getElementById('srPool');
    let symbol = (input && input.value || '').trim();
    let name = null;
    if (!symbol && poolSel && poolSel.value !== '') {
      const row = state.pool[Number(poolSel.value)];
      if (row) { name = row.name; symbol = row.name; } // 名称交给后端确定性解析
    }
    if (!symbol) { setStatus('请先输入股票代码或从观察池选择'); return; }
    state.symbol = symbol; state.name = name;
    setLoading(true);
    setStatus('生成中…');
    try {
      const j = await api('/api/stock-review/' + encodeURIComponent(symbol) + '/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 当日缓存若是 LLM 降级快照则自动 force 重生成（20261110e 事故修复），正常缓存直接复用
        body: JSON.stringify({ name: name, force: !!state.forceNext }),
      });
      state.forceNext = false;
      renderReview(j.review);
      setStatus('已生成 ' + j.review.date + '（' + (j.review.llm && j.review.llm.elapsedMs ? Math.round(j.review.llm.elapsedMs / 1000) + 's' : '') + '）');
      loadHistory(j.review.symbol || symbol);
    } catch (e) {
      setStatus('生成失败：' + e.message);
      setLoading(false);
    }
  }

  async function onTabSwitch(symbol, name) {
    ensureStyles();
    const root = document.getElementById('tab-stockreview');
    if (!root) return;
    if (!state.built) { buildDom(root); state.built = true; loadPool(); }
    if (symbol && symbol !== state.symbol) {
      state.symbol = symbol;
      const input = document.getElementById('srSymbol');
      if (input && /^\d{5,6}$/.test(String(symbol))) input.value = symbol;
      setStatus('');
      const card = document.getElementById('srCard');
      // 已有当日缓存则直接展示，否则保持提示
      try {
        const j = await api('/api/stock-review/' + encodeURIComponent(symbol));
        if (j && j.review) {
          renderReview(j.review);
          loadHistory(symbol);
          // 当日缓存为 LLM 降级快照 → 标记下次点击「生成今日复盘」自动 force 重生成
          state.forceNext = (j.review.date === todayStr()) && !!(j.review.llm && j.review.llm.degraded);
          if (state.forceNext) setStatus('今日卡片是降级数据快照，点「生成今日复盘」将自动重新生成正式版');
        }
        else if (card) card.innerHTML = '<div class="sr-empty">「' + esc(name || symbol) + '」今日还没有复盘卡片，点上方「生成今日复盘」。</div>';
      } catch (e) { /* 无记录属正常 */ }
    }
  }

  window.StockReviewUI = { onTabSwitch: onTabSwitch };
})();
