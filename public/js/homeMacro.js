/* 首页「每日宏观 & 政策」卡片 —— 调用后端 /api/macro-news（东方财富 7×24 宏观/政策过滤） */
const MacroNews = (() => {
  let loading = false;
  let lastLoad = 0;
  const THROTTLE = 8000;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtTime(dateStr) {
    if (!dateStr) return '';
    return dateStr.length > 5 ? dateStr.slice(5) : dateStr;
  }
  function catClass(cat) {
    return {
      '货币政策': 'c-money', '财政监管': 'c-fiscal', '数据发布': 'c-data',
      '国际宏观': 'c-intl', '市场': 'c-mkt',
    }[cat] || 'c-mkt';
  }
  const CAT_ICON = { '货币政策': '💰', '财政监管': '🏛️', '数据发布': '📊', '国际宏观': '🌍', '市场': '📈' };
  function fmtDateTime(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function sentimentClass(s) {
    if (!s || !s.label) return 'neu';
    if (s.label === '积极' || s.label === '偏多') return 'pos';
    if (s.label === '消极' || s.label === '偏空') return 'neg';
    return 'neu';
  }
  function itemHtml(n) {
    const time = fmtTime(n.date);
    const safeUrl = n.url ? escapeHtml(n.url) : '';
    const sentCls = 'hn-sent-' + sentimentClass(n.sentiment);
    const inner = `
      <span class="macro-time">${escapeHtml(time)}</span>
      <span class="macro-text">${safeUrl ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(n.title)}</a>` : escapeHtml(n.title)}</span>
      <span class="macro-sent ${sentCls}" title="情绪：${(n.sentiment && n.sentiment.label) || '中性'}"></span>`;
    return `<div class="macro-item">${inner}</div>`;
  }
  function trendBadge(ind) {
    if (!ind.trend || ind.trend === 'flat') {
      return `<span class="mi-trend flat">— 持平</span>`;
    }
    const arrow = ind.trend === 'up' ? '▲' : '▼';
    const dtxt = (ind.delta != null)
      ? (ind.deltaUnit === 'pct' ? ind.delta.toFixed(1) + 'pct' : ind.delta.toFixed(1) + ' 点')
      : '';
    return `<span class="mi-trend ${ind.trend}">${arrow}${dtxt ? ' ' + dtxt : ''}</span>`;
  }
  function metricsHtml(ind) {
    if (!ind.metrics || !ind.metrics.length) return '';
    return `<div class="mi-metrics">` + ind.metrics.map(m =>
      `<div class="mi-metric"><span>${escapeHtml(m.label)}</span><b>${escapeHtml(m.value)}</b></div>`).join('') + `</div>`;
  }
  function indCard(ind) {
    const unav = ind.unavailable ? ' mi-unavailable' : '';
    const badge = ind.unavailable ? `<div class="mi-badge">数据源暂未提供最新值</div>` : '';
    return `<div class="macro-ind${unav}">
      ${badge}
      <div class="mi-head">
        <span class="mi-name">${escapeHtml(ind.name)}</span>
        <span class="mi-period">${escapeHtml(ind.period || '')}</span>
      </div>
      <div class="mi-value">
        <span class="mi-num">${escapeHtml(ind.value)}</span><span class="mi-unit">${escapeHtml(ind.unit || '')}</span>
        <span class="mi-vlabel">${escapeHtml(ind.valueLabel || '')}</span>
        ${trendBadge(ind)}
      </div>
      ${metricsHtml(ind)}
      <div class="mi-interp">${escapeHtml(ind.interpretation || '')}</div>
      <div class="mi-src">来源：${escapeHtml(ind.source || '')}</div>
    </div>`;
  }
  function evCard(ev) {
    const cls = ev.impact === 'bearish' ? 'ev-bear' : (ev.impact === 'bullish' ? 'ev-bull' : 'ev-neu');
    const dirLabel = (d) => d === 'bearish' ? '偏空' : (d === 'bullish' ? '偏多' : '中性');
    const dirCls = (d) => d === 'bearish' ? 'neg' : (d === 'bullish' ? 'pos' : 'neu');
    // 20261013e：双维度判定徽章——「经济影响」与「股市偏好」分开标注（用户要求，避免单一判定造成误读）。
    // 偏多=红 / 偏空=绿（项目语义配色）；就业类两维度方向相反属正常（数据弱→经济偏空、宽松预期偏多股市）。
    // 旧数据（后端无 eco 字段）回退单徽章。
    let dirBadges = '';
    if (ev.eco) {
      dirBadges = `<span class="mu-badge mu-dim ${dirCls(ev.eco)}" title="对经济基本面的影响">经济 ${dirLabel(ev.eco)}</span>` +
                  `<span class="mu-badge mu-dim ${dirCls(ev.impact)}" title="对股市风险偏好的影响">股市 ${dirLabel(ev.impact)}</span>`;
    } else {
      dirBadges = `<span class="mu-badge">${dirLabel(ev.impact)}</span>`;
    }
    // 超预期 / 不及预期 / 符合预期 角标（仅已公布）
    let devBadge = '';
    if (ev.deviate === 'above') devBadge = `<span class="mu-dev above">超预期</span>`;
    else if (ev.deviate === 'below') devBadge = `<span class="mu-dev below">不及预期</span>`;
    else if (ev.status === 'released') devBadge = `<span class="mu-dev inline">符合预期</span>`;
    // 时间状态角标（预告态：今日公布 / N 天后）
    let timeBadge = '';
    if (ev.status === 'upcoming' && typeof ev.daysLeft === 'number' && ev.daysLeft >= 0 && ev.daysLeft <= 3) {
      timeBadge = `<span class="mu-timebadge">${ev.daysLeft === 0 ? '今日公布' : ev.daysLeft + ' 天后'}</span>`;
    }
    // 三值（公布 / 预期 / 前值）
    let three = '';
    if (ev.actual != null || ev.forecast != null || ev.previous != null) {
      const cell = (l, v, c) => `<span class="mu-three"><i>${l}</i><b class="${c}">${escapeHtml(v == null ? '—' : String(v))}</b></span>`;
      three = `<div class="mu-three-row">
        ${cell('公布', ev.actual, ev.deviate === 'above' ? 'up' : ev.deviate === 'below' ? 'down' : '')}
        ${cell('预期', ev.forecast, '')}
        ${cell('前值', ev.previous, '')}
      </div>`;
    }
    return `<div class="macro-us-card ${cls}">
      <div class="mu-head"><span class="mu-title">${escapeHtml(ev.title)}</span><span class="mu-badge-wrap">${devBadge}${timeBadge}${dirBadges}</span></div>
      <div class="mu-meta"><span class="mu-cat">${escapeHtml(ev.category || '')}</span><span class="mu-date">${escapeHtml(ev.dateZh || ev.dateUs || '')}</span></div>
      ${three}
      <div class="mu-summary">${escapeHtml(ev.summary || '')}</div>
      ${ev.note ? `<div class="mu-note">${escapeHtml(ev.note)}</div>` : ''}
    </div>`;
  }
  function renderData(macroData) {
    if (!macroData || !macroData.indicators || !macroData.indicators.length) {
      return `<div class="ai-empty">${escapeHtml((macroData && macroData.error) || '重要经济数据暂不可达，请稍后刷新。')}</div>`;
    }
    return `<div class="macro-data">${macroData.indicators.map(indCard).join('')}</div>`;
  }
  function render(newsData, macroData, usEvents, usNotice, usSource) {
    const body = document.getElementById('macroBody');
    if (!body) return;
    const updated = (newsData && newsData.updated) ? new Date(newsData.updated)
      : (macroData && macroData.updated ? new Date(macroData.updated) : null);
    const updEl = document.getElementById('macroUpdated');
    if (updEl) updEl.textContent = updated ? '更新于 ' + fmtDateTime(updated) : '';

    let html = '';
    // 1) 重要经济数据（结构化指标 + 解读）
    const dDate = macroData && macroData.date ? macroData.date : '';
    html += `<div class="macro-sec-head">📊 重要经济数据 <span class="macro-sec-sub">${escapeHtml(dDate)}</span></div>`;
    html += renderData(macroData);

    // 2) 宏观政策动态（快讯过滤）
    const items = (newsData && newsData.items) || [];
    if (items.length) {
      html += `<div class="macro-sec-head">📰 宏观政策动态</div>`;
      const byCat = (newsData.byCategory || {});
      const order = (newsData.order || ['货币政策', '财政监管', '数据发布', '国际宏观', '市场']);
      const groups = order.filter(c => byCat[c] && byCat[c].length).map(cat => {
        const list = byCat[cat].slice(0, 6).map(itemHtml).join('');
        return `<div class="macro-cat ${catClass(cat)}">
          <div class="macro-cat-head"><span class="macro-cat-icon">${CAT_ICON[cat] || ''}</span>${escapeHtml(cat)} <span class="macro-cat-count">${byCat[cat].length} 条</span></div>
          <div class="macro-list">${list}</div>
        </div>`;
      }).join('');
      html += `<div class="macro-groups">${groups}</div>`;
    } else {
      // 20261016 审计修复：原实现 0 条时整块静默隐藏，「真无新闻」与「采集失败」不可区分。
      // 现与区块③一致给诚实空态（有后端 error 时透出，否则说明今日暂无宏观/政策快讯）。
      html += `<div class="macro-sec-head">📰 宏观政策动态</div>`;
      html += `<div class="ai-empty">${escapeHtml((newsData && newsData.error) || '今日暂无宏观/政策类快讯，请稍后刷新。')}</div>`;
    }

    // 3) 国际经济数据 & 事件（策划式事件卡片：过期事件已由后端自动剔除）
    const usEvs = (usEvents && usEvents.length) ? usEvents : [];
    if (usEvs.length) {
      html += `<div class="macro-sec-head">🌍 国际经济数据 & 事件</div>`;
      html += `<div class="macro-us-grid">${usEvs.map(evCard).join('')}</div>`;
    } else if (usNotice) {
      // 20261013：诚实空态——策划式清单无未过期事件时明示，而非静默隐藏区块
      html += `<div class="macro-sec-head">🌍 国际经济数据 & 事件</div>`;
      html += `<div class="ai-empty">${escapeHtml(usNotice)}</div>`;
    }
    html += `<div class="macro-note">📌 经济数据来源：${escapeHtml((macroData && macroData.source) || '东方财富数据中心')}；动态来源：${escapeHtml((newsData && newsData.source) || '东方财富 7×24 快讯')}；美国宏观事件排期：${escapeHtml(usSource || '自动抓取')}（过期事件自动剔除）。仅供研究参考，不构成投资建议。</div>`;
    body.innerHTML = html;
  }
  async function load(force) {
    const now = Date.now();
    if (loading) return;
    if (!force && now - lastLoad < THROTTLE) return;
    loading = true;
    lastLoad = now;
    const btn = document.getElementById('macroRefresh');
    const prevLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '刷新中…'; }
    const body = document.getElementById('macroBody');
    if (body && !body.querySelector('.macro-ind') && !body.querySelector('.ai-empty')) {
      body.innerHTML = '<div class="ai-empty">正在采集每日宏观 & 政策…</div>';
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      const [newsResp, dataResp, usResp] = await Promise.all([
        fetch('/api/macro-news' + (force ? '?refresh=1' : ''), { cache: 'no-store', signal: ctrl.signal }),
        fetch('/api/macro-data' + (force ? '?refresh=1' : ''), { cache: 'no-store', signal: ctrl.signal }),
        fetch('/api/us-macro-events' + (force ? '?refresh=1' : ''), { cache: 'no-store', signal: ctrl.signal }),
      ]);
      clearTimeout(timer);
      const newsData = await newsResp.json();
      let macroData = null;
      try { macroData = await dataResp.json(); } catch (e) { macroData = null; }
      let usEvents = [];
      let usNotice = '';
      let usSource = '';
      try { const u = await usResp.json(); usEvents = (u && u.events) || []; usNotice = (u && u.notice) || ''; usSource = (u && u.source) || ''; } catch (e) { usEvents = []; }
      render(newsData, macroData, usEvents, usNotice, usSource);
    } catch (e) {
      if (body) body.innerHTML = `<div class="ai-empty">宏观数据采集失败：${escapeHtml(e.message)}</div>`;
    } finally {
      loading = false;
      if (btn) { btn.disabled = false; btn.textContent = prevLabel || '🔄 刷新'; }
    }
  }
  function refresh() { return load(true); }
  function bind() {
    const btn = document.getElementById('macroRefresh');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => refresh());
    }
  }
  return { load, refresh, bind };
})();
