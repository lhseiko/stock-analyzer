/* 首页「今日财经热点」卡片 —— 调用后端 /api/hot-news（东方财富 7×24 快讯） */
const HomeNews = (() => {
  let loading = false;
  let lastLoad = 0;
  const THROTTLE = 8000; // 前端 8 秒内不重复请求

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(dateStr) {
    if (!dateStr) return '';
    // "2026-08-11 15:30" -> "08-11 15:30"
    return dateStr.length > 5 ? dateStr.slice(5) : dateStr;
  }

  function catClass(cat) {
    return {
      '政策': 'cat-policy', '国际': 'cat-intl',
      '公司': 'cat-company', '市场': 'cat-market',
    }[cat] || 'cat-market';
  }

  function sentimentClass(s) {
    if (!s || !s.label) return 'neu';
    if (s.label === '积极' || s.label === '偏多') return 'pos';
    if (s.label === '消极' || s.label === '偏空') return 'neg';
    return 'neu';
  }

  // 新闻 → 行业板块影响标注（红涨绿跌：up 看涨=红，down 看跌=绿）
  function impactHtml(impact) {
    if (!impact || !impact.sector) return '';
    const dirCls = impact.direction === 'up' ? 'hn-impact-up' : impact.direction === 'down' ? 'hn-impact-down' : 'hn-impact-neu';
    const arrow = impact.direction === 'up' ? '▲' : impact.direction === 'down' ? '▼' : '';
    const stocks = (impact.hotStocks || []).slice(0, 2).join('、');
    const dirTxt = impact.direction === 'up' ? '看涨' : impact.direction === 'down' ? '看跌' : '中性';
    const tip = `${dirTxt} · ${impact.sector}板块${stocks ? ' · 热门：' + stocks : ''}`;
    return `<span class="hn-impact ${dirCls}" title="${escapeHtml(tip)}">${arrow} ${escapeHtml(impact.sector)}${stocks ? ' ' + escapeHtml(stocks) : ''}</span>`;
  }

  function itemHtml(n) {
    const time = fmtTime(n.date);
    const safeUrl = n.url ? escapeHtml(n.url) : '';
    const inner = `
      <span class="hn-time">${escapeHtml(time)}</span>
      <span class="hn-cat ${catClass(n.category)}">${escapeHtml(n.category || '市场')}</span>
      <span class="hn-title">${escapeHtml(n.title)}</span>${impactHtml(n.impact)}
      <span class="hn-sent hn-sent-${sentimentClass(n.sentiment)}" title="情绪：${(n.sentiment && n.sentiment.label) || '中性'}"></span>
    `;
    if (safeUrl) {
      return `<a class="hn-item" href="${safeUrl}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
    }
    return `<div class="hn-item">${inner}</div>`;
  }

  function render(data) {
    const body = document.getElementById('homeNewsBody');
    if (!body) return;
    const items = (data && data.items) || [];
    const updated = data && data.updated ? new Date(data.updated) : null;
    const updEl = document.getElementById('homeNewsUpdated');
    if (updEl) {
      updEl.textContent = updated ? '更新于 ' + updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    }
    if (!items.length) {
      body.innerHTML = `<div class="ai-empty">${escapeHtml((data && data.error) || '暂无今日财经热点，请稍后刷新或检查网络。')}</div>`;
      return;
    }
    const top = items.slice(0, 1).map(n => `
      <a class="hn-featured" href="${n.url ? escapeHtml(n.url) : 'javascript:void(0)'}" ${n.url ? 'target="_blank" rel="noopener noreferrer"' : ''}>
        <span class="hn-cat ${catClass(n.category)}">${escapeHtml(n.category || '市场')}</span>
        <span class="hn-feat-title">${escapeHtml(n.title)}</span>${impactHtml(n.impact)}
        ${n.summary ? `<span class="hn-feat-sum">${escapeHtml(n.summary)}</span>` : ''}
        <span class="hn-feat-meta">${escapeHtml(fmtTime(n.date))} · ${escapeHtml(n.source || '东方财富')}</span>
      </a>`).join('');
    const list = items.slice(1).map(itemHtml).join('');
    body.innerHTML = `${top}<div class="hn-list">${list}</div>
      <div class="hn-foot">数据来源：${escapeHtml((data && data.source) || '东方财富 7×24 快讯')} · 点击条目跳转原文</div>`;
  }

  async function load(force) {
    const now = Date.now();
    if (loading) return;
    if (!force && now - lastLoad < THROTTLE) return;
    loading = true;
    lastLoad = now;
    const body = document.getElementById('homeNewsBody');
    if (body && !body.querySelector('.hn-list')) body.innerHTML = '<div class="ai-empty">正在获取今日财经热点…</div>';
    try {
      const resp = await fetch('/api/hot-news' + (force ? '?refresh=1' : ''));
      const data = await resp.json();
      render(data);
    } catch (e) {
      if (body) body.innerHTML = `<div class="ai-empty">热点获取失败：${escapeHtml(e.message)}</div>`;
    } finally {
      loading = false;
    }
  }

  function refresh() { return load(true); }

  function bind() {
    const btn = document.getElementById('homeNewsRefresh');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => refresh());
    }
  }

  return { load, refresh, bind };
})();
