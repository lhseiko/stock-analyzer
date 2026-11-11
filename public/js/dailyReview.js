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
      return '<div class="dr-llm-bar dr-llm-degraded">⚠ AI 生成暂不可用，当前展示原始数据快照，已照常发布（不因缺数据拦截）。' +
        (llm.error ? '<br><span class="dr-meta">原因：' + esc(llm.error) + '</span>' : '') + '</div>';
    }
    const bits = ['✦ 本报告由大模型生成'];
    if (llm.model) bits.push('模型 ' + esc(llm.model));
    if (llm.promptFile) bits.push('提示词 ' + esc(llm.promptFile));
    if (llm.contentChars) bits.push(llm.contentChars + ' 字');
    if (llm.elapsedMs) bits.push('耗时 ' + Math.round(llm.elapsedMs / 1000) + 's');
    return '<div class="dr-llm-bar">' + bits.join(' · ') + '</div>';
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
   * [20261110f B0-3] 正向联动：给【明日核心观察池】表格每行加「个股复盘 →」直达入口。
   * 从渲染后的表格里就地取「代码」列（无代码列的旧复盘不渲染入口，不猜代码）；
   * 点击跳到个股页并自动切到「每日复盘」tab（app.js 识别 #stockreview）。
   */
  function decorateWatchPool(main) {
    try {
      const tables = main.querySelectorAll('article.dr-markdown table');
      const v = new URLSearchParams(location.search).get('v') || '';
      for (const t of tables) {
        const head = t.querySelector('thead tr');
        if (!head) continue;
        const ths = Array.from(head.children).map(c => c.textContent.trim());
        if (ths[0] !== '股票名称') continue;              // 只认观察池表
        const codeIdx = ths.indexOf('代码');
        if (codeIdx < 0) continue;                        // 旧版复盘无代码列 → 不加入口
        const rows = Array.from(t.querySelectorAll('tbody tr'));
        if (!rows.length) continue;
        // 表头补一列「操作」
        const th = document.createElement('th');
        th.textContent = '操作';
        head.appendChild(th);
        for (const tr of rows) {
          const tds = tr.querySelectorAll('td');
          if (!tds.length) continue;
          const cell = tds[codeIdx] ? tds[codeIdx].textContent : '';
          const m = cell.match(/\b(\d{6})\b/);
          const td = document.createElement('td');
          if (m) {
            const a = document.createElement('a');
            a.className = 'dr-pool-link';
            a.href = '/index.html' + (v ? '?v=' + encodeURIComponent(v) : '?') + '&symbol=' + m[1] + '#stockreview';
            a.textContent = '个股复盘 →';
            a.title = '打开该股并进入「每日复盘」tab';
            td.appendChild(a);
          } else {
            td.textContent = '—';
          }
          tr.appendChild(td);
        }
      }
    } catch (e) { /* 联动入口属增强项，失败不影响复盘正文 */ }
  }

  function renderVersion(review, ver, today) {
    const main = $('drMain');
    const date = (review && review.reviewDate) || (today && today.date) || S.date || '';
    const rawMd = (ver && ver.markdown) || (review && review.markdown) || '';
    const md = rawMd || (ver && ver.sections ? legacySectionsToMarkdown(ver.sections) : '');
    const dateHeading = date ? '<div class="dr-review-date">📅 <span>' + esc(date) + '</span> 盘后复盘</div>' : '';
    main.innerHTML = dateHeading + noticeBar(review, ver) + versionBar(review, ver && ver.version) + llmBar(review, ver) + markdownHtml(md);
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
