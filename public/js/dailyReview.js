/**
 * dailyReview.js — DailyReviewPage（20261110b · 大模型 Markdown 直出版）
 * ======================================================================
 * 用户 2026-11-10 16:03 裁决：「统一使用 Markdown 输出，前端页面直接渲染大模型返回的
 * Markdown，不要再强行去套卡片组件」。
 *
 * 本版相对 20261110a 的变化：
 *  - 删除全部 11 段 sections / quads / risks / TABLE_COLS / renderTable / 卡片折叠逻辑；
 *  - 主内容区只做一件事：把后端 version.markdown 交给本地随包的 Markdown 渲染器；
 *  - 保留交易日判定、running 轮询、历史检索、按日期查询、手动重跑、版本切换、
 *    formal / complete 徽标（这些不是报告排版，属于页面外壳）。
 *  - 新增 AI 生成信息条（模型 / 提示词 / 字数 / 降级原因），让用户能直接看到
 *    这篇报告确实由大模型生成，而不是代码拼的。
 *
 * 约束：前端不直连数据库（只经 /api/review/* 与 /api/calendar/*）；
 *       Markdown 来源不可信，渲染器先做 HTML 转义；loading 数据到位后立即移除。
 */
(function () {
  'use strict';

  const S = { date: null, view: 'today', pollTimer: null, today: null, running: false };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /** Markdown 表格单元格：转义 + 把竖线换成全角，避免把表格撑坏。 */
  function mdCell(s) { return esc(s).replace(/\|/g, '／'); }
  function _num(v) { return (v == null || v === '') ? '—' : v; }
  function _pct(v) {
    const n = Number(v);
    return Number.isFinite(n) ? (n > 0 ? '+' : '') + (Math.round(n * 100) / 100) + '%' : '—';
  }
  function _yi(v) {
    const n = Number(v);
    return Number.isFinite(n) ? (Math.round(n * 10) / 10) + ' 亿元' : '—';
  }
  function localToday() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  /** 让日历下拉始终反映「当前正文显示的是哪一天」——解决日期菜单与正文内容不同步的误解。 */
  function syncCalendar(date) {
    const di = $('drDateInput');
    if (di && date) di.value = date;
  }
  async function api(url, opts) {
    const r = await fetch(url, opts);
    const d = await r.json();
    if (!r.ok && !(d && d.success === false)) throw new Error((d && d.error) || ('HTTP ' + r.status));
    return d;
  }

  const SUBTITLE_TODAY = '交易日 15:35 生成正式版 · 20:30 补录龙虎榜升级完整版 · 大模型生成 Markdown 复盘 · 数据缺失如实说明';

  function stageLabel(review, ver) {
    const st = (ver && ver.stage) || (review && review.stage);
    if (st === 'complete') return '完整版';
    if (st === 'formal') return '正式版';
    return '';
  }
  function isPendingLhb(review, ver) {
    const st = (ver && ver.dragonTigerStatus) || (review && review.dragonTigerStatus);
    return st === 'pending';
  }
  function currentVersion(review) {
    return review && (review.versions || []).find(v => v.version === review.currentVersion);
  }
  function isLimited(review, ver) {
    return !!(review && (review.limited || (ver && ver.limited)));
  }
  function setLimitedBadge(limited) {
    const bar = $('drStatusBar');
    if (!bar) return;
    let chip = $('drChipLimited');
    if (limited && !chip) {
      chip = document.createElement('span');
      chip.id = 'drChipLimited';
      chip.className = 'dr-chip dr-limited-chip';
      chip.textContent = '数据源不足';
      const spacer = bar.querySelector('.dr-spacer');
      bar.insertBefore(chip, spacer || null);
    } else if (!limited && chip) chip.remove();
  }

  /** Markdown → HTML；渲染器缺失时退化为安全纯文本，绝不把原文当 HTML 注入。 */
  function markdownHtml(md) {
    if (!md) return '<div class="dr-empty">这篇复盘暂无正文。</div>';
    if (window.Markdown && typeof window.Markdown.render === 'function') {
      return '<article class="dr-markdown">' + window.Markdown.render(md) + '</article>';
    }
    return '<pre class="dr-markdown-fallback">' + esc(md) + '</pre>';
  }

  /** 旧版结构化复盘（sections）兼容还原：把旧 11/14 段结构转成可读 Markdown，不调 LLM 也能显示历史。 */
  function legacySectionsToMarkdown(sections) {
    if (!Array.isArray(sections) || !sections.length) return '';
    const escCell = s => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const out = [];
    for (const sec of sections) {
      if (!sec || !sec.title) continue;
      out.push('### ' + sec.title);
      const lines = Array.isArray(sec.lines) ? sec.lines.filter(Boolean) : [];
      const bullets = Array.isArray(sec.bullets) ? sec.bullets.filter(Boolean) : [];
      const metrics = Array.isArray(sec.metrics) ? sec.metrics : [];
      const risks = Array.isArray(sec.risks) ? sec.risks : [];
      if (lines.length) out.push(lines.map(l => String(l)).join('\n\n'));
      if (bullets.length) out.push(bullets.map(b => '- ' + String(b)).join('\n'));
      if (metrics.length) {
        out.push('| 指标 | 数值 |', '| --- | --- |');
        for (const m of metrics) out.push('| ' + escCell(m.label) + ' | ' + escCell(m.value) + ' |');
      }
      if (risks.length) {
        for (const r of risks) {
          out.push('- **风险**：' + String(r.fact || ''));
          if (r.observe) out.push('  - 观察：' + String(r.observe));
          if (r.clear) out.push('  - 解除：' + String(r.clear));
        }
      }
      const tbl = sec.table;
      if (Array.isArray(tbl) && tbl.length) {
        let header, rows;
        if (Array.isArray(tbl[0])) { header = tbl[0]; rows = tbl.slice(1); }
        else if (tbl[0] && typeof tbl[0] === 'object') { header = Object.keys(tbl[0]); rows = tbl.map(r => header.map(k => r[k])); }
        else { header = null; rows = tbl; }
        if (header) {
          out.push('| ' + header.map(escCell).join(' | ') + ' |', '| ' + header.map(() => '---').join(' | ') + ' |');
          for (const row of rows) out.push('| ' + (Array.isArray(row) ? row : [row]).map(escCell).join(' | ') + ' |');
        }
      }
      if (sec.missing) out.push('_（本段数据源暂无，已如实标注）_');
      out.push('');
    }
    return out.join('\n').trim();
  }

  /** AI 生成信息条：直观证明「这篇是大模型写的」。 */
  function llmBar(review, ver) {
    const llm = (ver && ver.llm) || (review && review.llm) || null;
    if (!llm) return '<div class="dr-llm-bar dr-llm-legacy">该日期为旧版结构化复盘，已按原结构还原展示；点右上角「手动重跑」可重新生成大模型 Markdown 报告。</div>';
    if (!llm.ok) {
      return '<div class="dr-llm-bar dr-llm-degraded">⚠ AI 生成暂不可用，当前展示当日数据摘要，已照常发布（不因缺数据拦截）。' +
        (llm.error ? '<br><span class="dr-meta">原因：' + esc(llm.error) + '</span>' : '') + '</div>';
    }
    const bits = ['✦ 本报告由大模型生成'];
    if (llm.model) bits.push('模型 ' + esc(llm.model));
    if (llm.promptFile) bits.push('提示词 ' + esc(llm.promptFile));
    if (llm.contentChars) bits.push(llm.contentChars + ' 字');
    if (llm.elapsedMs) bits.push('耗时 ' + Math.round(llm.elapsedMs / 1000) + 's');
    return '<div class="dr-llm-bar">' + bits.join(' · ') + '</div>';
  }

  /**
   * [20261116d] 降级快照的可读版：不再把 Context JSON 原样倾倒给用户。
   * 只做「字段 → 表格/条目」的如实转写，不写推演、不下结论；字段缺失就省略或写「—」。
   */
  function snapshotMarkdown(ctx) {
    const c = ctx || {};
    const m = c.market || {};
    const d = (c.meta && c.meta.reviewDate) || '';
    const L = [];
    L.push('# 每日复盘 · ' + d + '（数据快照）', '');
    L.push('> AI 生成暂不可用，下面是工作台采集到的当日数据，只做如实罗列、不做推演；右上角「手动重跑」可生成完整版。', '');

    const q = m.quote || {};
    const b = m.breadth || null;
    const idx = Array.isArray(q.index) ? q.index.slice(0, 3) : [];
    const mf = m.mainFund || null;
    if (idx.length || b || (mf && mf.mainNetToday != null)) {
      L.push('## 市场概况', '', '| 指标 | 数值 |', '| --- | --- |');
      idx.forEach(x => L.push('| ' + mdCell(x.name || x.code || '指数') + ' | ' + mdCell(_num(x.price)) + '（' + _pct(x.changePct) + '） |'));
      if (b) {
        L.push('| 上涨 / 下跌 / 平盘 | ' + _num(b.up) + ' / ' + _num(b.down) + ' / ' + _num(b.flat) + ' |');
        L.push('| 涨停 / 跌停 | ' + _num(b.limitUp) + ' / ' + _num(b.limitDown) + ' |');
      }
      if (mf && mf.mainNetToday != null) L.push('| 主力资金净额 | ' + _yi(mf.mainNetToday) + ' |');
      L.push('');
    }

    const sf = m.sectorFlow;
    if (sf && ((sf.inflowTop || []).length || (sf.outflowTop || []).length)) {
      L.push('## 板块资金', '');
      if ((sf.inflowTop || []).length) L.push('- 净流入前列：' + sf.inflowTop.map(x => mdCell(x.name) + '（' + _yi(x.mainNet) + '）').join('、'));
      // 净流出方向已由标题表达，数值统一取绝对值，避免「净流出 -126.7 亿元」双重反向
      if ((sf.outflowTop || []).length) L.push('- 净流出前列：' + sf.outflowTop.map(x => mdCell(x.name) + '（' + _yi(Math.abs(Number(x.mainNet) || 0)) + '）').join('、'));
      L.push('');
    }

    const sec = c.sectors;
    if (sec && Array.isArray(sec.top) && sec.top.length) {
      L.push('## 涨停板块', '', '| 板块 | 涨停家数 | 最高连板 |', '| --- | --- | --- |');
      sec.top.slice(0, 6).forEach(x => L.push('| ' + mdCell(x.industry) + ' | ' + _num(x.count) + ' | ' + _num(x.boardsMax) + ' |'));
      L.push('');
    }

    if (c.ladder && c.ladder.ok !== false) {
      const ld = c.ladder;
      const bits = [];
      if (ld.maxBoards != null) bits.push('最高 ' + ld.maxBoards + ' 板');
      if (ld.limitUpCount != null) bits.push('涨停 ' + ld.limitUpCount + ' 家');
      if (ld.board2PlusCount != null) bits.push('2 板以上 ' + ld.board2PlusCount + ' 家');
      const tiers = Array.isArray(ld.tiers) ? ld.tiers : [];
      if (bits.length || tiers.length) {
        L.push('## 连板梯队', '');
        if (bits.length) L.push('- 涨停池口径：' + bits.join('；'));
        tiers.slice(0, 5).forEach(t => {
          const names = (t.stocks || []).map(s => s.name).filter(Boolean).join('、');
          L.push('- ' + _num(t.boards) + ' 板：' + _num(t.count) + ' 家' + (names ? '（' + names + '）' : ''));
        });
        L.push('');
      }
    }

    const dt = c.dragonTiger;
    if (dt) {
      L.push('## 龙虎榜', '');
      if (!dt.available) {
        L.push('- 盘后延迟发布，当前时点尚未公布（不是接口故障）。');
      } else {
        L.push('- 上榜 ' + _num(dt.count) + ' 家；合计净买入 ' + _yi(dt.netBuyTotal));
        const seen = new Set();
        (dt.topNetBuy || []).slice(0, 8).forEach(x => {
          const k = String(x.name || '') + '|' + x.netBuyYi;
          if (seen.has(k)) return; // 源数据可能重复同一行，展示层去重，不改源数据
          seen.add(k);
          if (seen.size <= 5) L.push('- ' + mdCell(x.name) + '：净买入 ' + _yi(x.netBuyYi));
        });
      }
      L.push('');
    }

    if (Array.isArray(c.news) && c.news.length) {
      L.push('## 消息面（前 5 条）', '');
      c.news.slice(0, 5).forEach(n => L.push('- ' + mdCell(n.title || '（无标题）') + (n.source ? '（' + mdCell(n.source) + '）' : '')));
      L.push('');
    }

    if (Array.isArray(c.sources) && c.sources.length) {
      const okN = c.sources.filter(s => s.status === 'ok').length;
      L.push('## 数据源', '', '- 正常 ' + okN + ' 项 / 共 ' + c.sources.length + ' 项');
      const miss = Array.isArray(c.missing) ? c.missing : [];
      if (miss.length) L.push('- 缺失：' + miss.map(x => mdCell(x.label || x.key) + (x.reason ? '（' + mdCell(x.reason) + '）' : '')).join('；'));
      L.push('');
    }

    L.push('_本文为盘后观察记录，不是投资建议。_');
    return L.join('\n');
  }

  function noticeBar(review, ver) {
    let h = '';
    const pendingLhb = isPendingLhb(review, ver);
    const missing = ((ver && ver.completeness && ver.completeness.missing) || [])
      .filter(m => !(pendingLhb && m.key === 'dragonTiger'));
    if (missing.length) {
      h += '<div class="dr-notice">本次有 ' + missing.length + ' 项数据源暂无数据，报告已在提示词指导下自然说明，未用估算值填充。</div>';
    }
    if (pendingLhb) {
      h += '<div class="dr-notice">龙虎榜为盘后延迟发布数据，当前为 15:35 正式版；20:30 或次日 15:35 兜底会自动补录，并由大模型重新生成完整版。</div>';
    }
    return h;
  }

  function versionBar(review, active) {
    if ((review.versions || []).length <= 1) return '';
    return '<div class="dr-versionbar">历史版本：' + review.versions.map(v =>
      '<button class="dr-ver-btn' + (v.version === active ? ' active' : '') + '" data-ver="' + esc(v.version) + '">v' + esc(v.version) +
      (v.kind === 'revision' ? ' 修订' : ' 正式') +
      (v.stage === 'complete' ? ' · 完整版' : v.stage === 'formal' ? ' · 正式版' : '') + '</button>').join('') + '</div>';
  }

  function setStatus(today, review, ver) {
    const date = (today && today.date) || S.date || localToday();
    S.date = date;
    const cal = today && today.calendar;
    $('drChipDate').textContent = '📅 ' + date;
    if (today && today.holiday) {
      $('drChipDay').textContent = '休市 · 非交易日';
      $('drChipDay').className = 'dr-chip dr-chip-holiday';
    } else if (cal && cal.is_trading_day === true) {
      $('drChipDay').textContent = '交易日';
      $('drChipDay').className = 'dr-chip dr-chip-trading';
    } else {
      $('drChipDay').textContent = '交易日历判定缺失';
      $('drChipDay').className = 'dr-chip';
    }
    const st = stageLabel(review, ver);
    $('drChipVersion').textContent = ver
      ? ('v' + ver.version + (ver.kind === 'revision' ? ' 修订' : '') + (st ? ' · ' + st : ''))
      : '暂无复盘';
    $('drChipCompleteness').textContent = ver && ver.completeness
      ? ('数据源 ' + ver.completeness.score + '%') : '数据源 —';
    const running = !!(today && today.running) || S.running;
    $('drChipRunning').classList.toggle('hidden', !running);
    setLimitedBadge(isLimited(review, ver));
    const meta = [];
    if (ver) meta.push('生成于 ' + esc(ver.localTime || ver.generatedAt || '—'));
    if (review) meta.push(esc(review.schemaVersion || ''));
    if (isPendingLhb(review, ver)) meta.push('龙虎榜待晚间补录（不计入缺失）');
    $('drMeta').textContent = meta.join(' · ');
  }

  /**
   * [20261113b] 用户指令：删除观察池表格右侧「操作」列与个股复盘直达链接（仅保留大盘复盘正文）。
   * 说明：入口删除后不再给表格追加列；个股复盘仍可从自选股切换个股手动进入。
   */
  function decorateWatchPool() { /* 已停用：用户要求移除操作列 */ }

  function renderVersion(review, ver, today) {
    const main = $('drMain');
    const date = (review && review.reviewDate) || (today && today.date) || S.date || '';
    const rawMd = (ver && ver.markdown) || (review && review.markdown) || '';
    const md = rawMd || (ver && ver.sections ? legacySectionsToMarkdown(ver.sections) : '');
    // [20261116d] AI 降级时不再把落盘的 JSON 快照原样渲染，改由 Context 生成可读摘要；
    // 旧记录（已存 JSON 快照）也走这里，无需重跑即可正常阅读；没有 context 时才回退原文。
    const degraded = !!(ver && ver.llm && ver.llm.ok === false);
    const ctx = (ver && ver.context) || (review && review.context) || null;
    const bodyMd = (degraded && ctx) ? snapshotMarkdown(ctx) : md;
    const dateHeading = date ? '<div class="dr-review-date">📅 <span>' + esc(date) + '</span> 盘后复盘</div>' : '';
    main.innerHTML = dateHeading + noticeBar(review, ver) + versionBar(review, ver && ver.version) + llmBar(review, ver) + markdownHtml(bodyMd);
    decorateWatchPool(main);
    setStatus(today, review, ver);
    bindVersionButtons(review, today);
  }

  function bindVersionButtons(review, today) {
    document.querySelectorAll('.dr-ver-btn').forEach(b => b.addEventListener('click', () => {
      const v = (review.versions || []).find(x => String(x.version) === b.dataset.ver);
      if (v) renderVersion(review, v, today);
    }));
  }

  function renderReview(review, today) {
    const ver = currentVersion(review);
    const main = $('drMain');
    if (!ver) {
      main.innerHTML = '<div class="dr-empty">当日尚无复盘记录。交易日 15:35 自动生成，或点击右上角「手动重跑」。</div>';
      setStatus(today, review, null);
      return;
    }
    renderVersion(review, ver, today);
  }

  // ---------- 加载 ----------
  async function loadToday() {
    const main = $('drMain');
    main.innerHTML = '<div class="dr-loading">正在加载当日复盘…</div>';
    try {
      const d = await api('/api/review/today');
      S.today = d; S.date = d.date;
      syncCalendar(d.date);
      if (d.holiday) {
        main.innerHTML = '<div class="dr-holiday-box"><div class="dr-holiday-icon">🏖</div>' +
          '<h2>今日休市</h2><p>' + esc(d.date) + ' 为非交易日（' + esc((d.calendar && d.calendar.day_type) || '休市') + '），不生成当日复盘。</p>' +
          '<button class="btn-secondary" type="button" id="drViewHistoryBtn">查看最近一份复盘</button></div>';
        setStatus(d, d.review, currentVersion(d.review));
        const vb = $('drViewHistoryBtn');
        if (vb) vb.addEventListener('click', loadLatest);
        stopPoll();
        return;
      }
      if (d.running || d.status === 'running') {
        main.innerHTML = '<div class="dr-loading">⏳ 复盘正在生成中：采集数据 → 组装 JSON → 调用大模型，稍后自动刷新…</div>';
        setStatus(d, d.review, currentVersion(d.review));
        startPoll();
        return;
      }
      stopPoll();
      if (d.review) renderReview(d.review, d);
      else {
        main.innerHTML = '<div class="dr-empty">当日尚无复盘记录。交易日 15:35 自动生成，或点击右上角「手动重跑」。</div>';
        setStatus(d, null, null);
      }
    } catch (e) {
      main.innerHTML = '<div class="dr-empty">加载失败：' + esc(e.message) + '</div>';
    }
  }

  function startPoll() {
    if (S.pollTimer) return;
    S.running = true;
    S.pollTimer = setInterval(async () => {
      try {
        const st = await api('/api/review/status');
        $('drChipRunning').classList.toggle('hidden', !st.running);
        if (!st.running) { stopPoll(); await loadToday(); }
        else if (st.phase) {
          const el = $('drToolbarNote');
          if (el) el.textContent = '生成阶段：' + st.phase + '（第 ' + st.attempt + ' 次）';
        }
      } catch (e) { /* 轮询失败下次重试，不弹窗打扰 */ }
    }, 3000);
  }
  function stopPoll() {
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
    S.running = false;
    const el = $('drToolbarNote');
    if (el) el.textContent = '';
  }

  async function loadByDate(date) {
    S.date = date;
    syncCalendar(date);
    const main = $('drMain');
    main.innerHTML = '<div class="dr-loading">正在加载 ' + esc(date) + ' 复盘…</div>';
    try {
      const d = await api('/api/review/by-date?date=' + encodeURIComponent(date));
      switchView('today');
      if (d.review) {
        renderReview(d.review, { date, calendar: d.calendar, holiday: d.calendar && d.calendar.is_trading_day === false, running: false });
        $('drSubtitle').textContent = date + ' 复盘（按日期查询）· 大模型生成 Markdown';
      } else if (d.failedReport) {
        main.innerHTML = '<div class="dr-fail-box"><h2>该日复盘生成失败</h2><ul class="dr-bullets">' +
          (d.failedReport.errors || []).map(e => '<li>第 ' + e.attempt + ' 次：' + esc(e.message) + '</li>').join('') + '</ul></div>';
        setStatus({ date, calendar: d.calendar }, null, null);
      } else {
        main.innerHTML = '<div class="dr-empty">' + esc(date) + ' 无复盘记录' +
          (d.calendar && d.calendar.is_trading_day === false ? '（非交易日，正常休市）' : '') + '。</div>';
        setStatus({ date, calendar: d.calendar, holiday: d.calendar && d.calendar.is_trading_day === false }, null, null);
      }
    } catch (e) {
      main.innerHTML = '<div class="dr-empty">查询失败：' + esc(e.message) + '</div>';
    }
  }

  function switchView(v) {
    S.view = v;
    $('drSubtitle').textContent = SUBTITLE_TODAY;
  }

  /** 休市日「查看最近一份复盘」：拉取历史列表最新一条，用日历直接打开（历史复盘已由日历菜单完全替代）。 */
  async function loadLatest() {
    try {
      const d = await api('/api/review/history?limit=1');
      if (d.items && d.items.length) { await loadByDate(d.items[0].date); }
    } catch (e) { /* 忽略，不弹窗打扰 */ }
  }

  async function rerun() {
    const target = S.date || localToday();
    if (!window.confirm('手动重跑 ' + target + ' 的复盘？\n将重新采集数据并调用大模型生成一篇新的 Markdown 复盘（约 1-3 分钟）。')) return;
    const btn = $('drRerunBtn');
    btn.disabled = true;
    const main = $('drMain');
    main.innerHTML = '<div class="dr-loading">⏳ 正在重跑 ' + esc(target) + '：采集数据 → 组装 JSON Context → 调用大模型生成 Markdown（约 1-3 分钟）…</div>';
    S.running = true;
    setStatus({ date: target }, null, null);
    startPoll();
    try {
      const r = await api('/api/review/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: target, force: true }),
      });
      stopPoll();
      const reload = (target === localToday()) ? loadToday : () => loadByDate(target);
      if (r.action === 'failed') {
        main.innerHTML = '<div class="dr-fail-box"><h2>重跑失败</h2><p>连续 3 次失败，已输出失败报告。</p></div>';
      } else if (r.action === 'skipped_holiday') {
        await reload();
        $('drToolbarNote').textContent = '非交易日，按规则跳过生成';
      } else if (r.action === 'skipped') {
        await reload();
        $('drToolbarNote').textContent = r.reason || '正式版已存在且数据未更完整，已跳过';
      } else {
        await reload();
        $('drToolbarNote').textContent = r.message || '已生成复盘';
      }
    } catch (e) {
      stopPoll();
      main.innerHTML = '<div class="dr-empty">重跑失败：' + esc(e.message) + '</div>';
    } finally {
      btn.disabled = false;
    }
  }

  window.DailyReviewPage = {
    init() {
      const di = $('drDateInput');
      $('drSubtitle').textContent = SUBTITLE_TODAY;
      $('drRerunBtn').addEventListener('click', rerun);
      $('drTabToday').addEventListener('click', () => { switchView('today'); loadToday(); });
      // 日历下拉：选中日期即自动加载该日复盘（历史复盘已由日历菜单完全替代，无需独立 tab）
      if (di) {
        if (!di.value) di.value = localToday();
        di.addEventListener('change', () => { if (di.value) loadByDate(di.value); });
      }
      loadToday();
    },
    loadToday, loadByDate, rerun,
  };
})();
