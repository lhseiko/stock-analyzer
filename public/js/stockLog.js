// stockLog.js — 个股记录（20261025l，用户要求：个股页最右侧新增「个股记录」tab）
// 按日期排序的手动记录：用户为当前个股手动添加「值得注意的问题」，按日期倒序分组展示，可删除。
// 纯手动记录：不参与任何判断/评分/回测；数据存服务端 data/stock-log/<代码>.json（换设备不丢）。
(function () {
  'use strict';

  const S = { symbol: null, name: null, loaded: null };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // 本地时区今天（toISOString 是 UTC，晚上 8 点后日期会错一天）
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  async function refresh(force) {
    if (!S.symbol) return;
    if (!force && S.loaded === S.symbol) return;
    const box = document.getElementById('stockLogContainer');
    if (!box) return;
    box.innerHTML = '<div class="sl-empty">加载中…</div>';
    try {
      const resp = await fetch('/api/stock-log/' + encodeURIComponent(S.symbol));
      const data = await resp.json();
      const items = (data && data.items) || [];
      S.loaded = S.symbol;
      if (!items.length) {
        box.innerHTML = '<div class="sl-empty">暂无记录——用上方表单添加该个股值得注意的问题，按日期倒序展示</div>';
        return;
      }
      const groups = {};
      items.forEach(it => { (groups[it.date] = groups[it.date] || []).push(it); });
      const dates = Object.keys(groups).sort((a, b) => b.localeCompare(a));
      box.innerHTML = dates.map(d =>
        '<div class="sl-group">' +
          '<div class="sl-date">📅 ' + esc(d) + '</div>' +
          groups[d].map(it =>
            '<div class="sl-item">' +
              '<div class="sl-text">' + esc(it.text).replace(/\n/g, '<br>') + '</div>' +
              '<button class="sl-del" data-id="' + esc(it.id) + '" title="删除该条记录">删除</button>' +
            '</div>'
          ).join('') +
        '</div>'
      ).join('');
    } catch (e) {
      box.innerHTML = '<div class="sl-empty">记录加载失败：' + esc(e && e.message) + '</div>';
    }
  }

  async function add() {
    if (!S.symbol) { alert('请先选择个股'); return; }
    const dateEl = document.getElementById('slDate');
    const textEl = document.getElementById('slText');
    const date = (dateEl && dateEl.value) || todayStr();
    const text = (textEl && textEl.value || '').trim();
    if (!text) { alert('请先填写记录内容'); return; }
    const btn = document.getElementById('slAdd');
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch('/api/stock-log/' + encodeURIComponent(S.symbol), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, text }),
      });
      const data = await resp.json();
      if (!data || !data.success) { alert('添加失败：' + ((data && data.error) || '未知错误')); return; }
      if (textEl) textEl.value = '';
      await refresh(true);
    } catch (e) {
      alert('添加失败：' + (e && e.message));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function remove(id) {
    if (!S.symbol || !id) return;
    if (!window.confirm('删除这条记录？删除后不可恢复。')) return;
    try {
      await fetch('/api/stock-log/' + encodeURIComponent(S.symbol) + '/' + encodeURIComponent(id), { method: 'DELETE' });
      await refresh(true);
    } catch (e) {
      alert('删除失败：' + (e && e.message));
    }
  }

  window.StockLog = {
    // 切股挂钩（app.js analyze / switchTab 调用）：同股已加载则跳过，避免重复拉取
    setStock(symbol, name) {
      if (S.symbol === symbol && S.loaded === symbol) return;
      S.symbol = symbol; S.name = name; S.loaded = null;
      refresh();
    },
    init() {
      const dateEl = document.getElementById('slDate');
      if (dateEl && !dateEl.value) dateEl.value = todayStr();
      const addBtn = document.getElementById('slAdd');
      if (addBtn) addBtn.addEventListener('click', add);
      const textEl = document.getElementById('slText');
      if (textEl) textEl.addEventListener('keydown', (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') add();
      });
      const box = document.getElementById('stockLogContainer');
      if (box) box.addEventListener('click', (ev) => {
        const btn = ev.target.closest('.sl-del');
        if (btn) remove(btn.dataset.id);
      });
    },
  };
})();
