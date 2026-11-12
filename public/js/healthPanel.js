/* 首页「数据健康」卡片（P2-2 可观测性 20261111f）
 * 调用后端 GET /api/health/dashboard：聚合近 7 天 logs/requests-*.jsonl
 * 展示：API 总调用数 / 异常率(status>=400) / 平均响应耗时 / 各数据源降级次数。
 * 脚注（服务端 effectiveFrom 同步下发，前端兜底）：自 2026-11-11 起生效，更早日志为纯文本未纳入统计。
 * 纯展示层：只读统计接口，不触发行情/判定数据链路；失败如实显示错误不编造。
 */
const HealthPanel = (() => {
  let loading = false;
  let lastLoad = 0;
  const THROTTLE = 8000;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function nowHM() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 数据源键 → 中文名（后端可能新增键，未知键原样展示不丢弃）
  const SOURCE_NAMES = { tencent: '腾讯', eastmoney: '东财', sina: '新浪', yahoo: 'Yahoo' };
  function sourceLabel(k) { return SOURCE_NAMES[k] || k; }

  function render(data) {
    const body = document.getElementById('healthBody');
    if (!body) return;
    if (!data || data.ok === false) {
      body.innerHTML = `<div class="ai-empty">数据健康统计暂不可用${data && data.error ? '：' + escapeHtml(data.error) : ''}</div>`;
      return;
    }
    const d = data;
    const degradedRows = Object.keys(d.degradedBySource || {})
      .sort((a, b) => (d.degradedBySource[b] || 0) - (d.degradedBySource[a] || 0))
      .map(k => `<tr><td>${escapeHtml(sourceLabel(k))}</td><td class="hp-num">${d.degradedBySource[k]}</td></tr>`)
      .join('');
    const degradeSection = d.degradedCount > 0
      ? `<table class="hp-table"><thead><tr><th>数据源（备源接管）</th><th>降级/回退次数</th></tr></thead><tbody>${degradedRows}</tbody></table>`
      : `<div class="hp-okline">✓ 近 7 日未发生数据源降级/回退，全部请求由主数据源直接命中</div>`;
    // 异常率语义：>5% 琥珀警示（健康面板无涨跌方向语义，不使用红涨绿跌方向色）
    const errCls = d.errorRate > 5 ? 'hp-warn' : '';
    body.innerHTML = `
      <div class="hp-kpis">
        <div class="hp-tile"><span class="hp-tile-label">近 ${d.days} 日 API 调用</span><span class="hp-tile-value">${d.totalCalls}</span></div>
        <div class="hp-tile"><span class="hp-tile-label">异常率（状态码≥400）</span><span class="hp-tile-value ${errCls}">${d.errorRate}%</span></div>
        <div class="hp-tile"><span class="hp-tile-label">平均响应耗时</span><span class="hp-tile-value">${d.avgDurationMs}<small> ms</small></span></div>
        <div class="hp-tile"><span class="hp-tile-label">降级/回退总次数</span><span class="hp-tile-value">${d.degradedCount}</span></div>
      </div>
      ${degradeSection}
      <div class="hp-meta">统计窗口 ${escapeHtml((d.windowStart || '').slice(0, 10))} 起 · 日志文件 ${d.files} 个${d.parseErrors > 0 ? ` · 解析失败行 ${d.parseErrors}（已跳过）` : ''}${d.writeFailures != null ? ` · 日志写失败 ${d.writeFailures}` : ''}</div>
    `;
    const note = document.querySelector('#healthCard .health-note');
    if (note && d.effectiveFrom) note.textContent = `自 ${d.effectiveFrom} 起生效，更早日志为纯文本未纳入统计`;
  }

  async function load(force) {
    if (loading) return;
    if (!force && Date.now() - lastLoad < THROTTLE) return;
    loading = true;
    const btn = document.getElementById('healthRefresh');
    const prevLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '统计中…'; }
    try {
      const resp = await fetch('/api/health/dashboard');
      const data = await resp.json();
      render(data);
      lastLoad = Date.now();
      const upd = document.getElementById('healthUpdated');
      if (upd) upd.textContent = `更新 ${nowHM()}`;
    } catch (e) {
      render({ ok: false, error: e.message });
    } finally {
      loading = false;
      if (btn) { btn.disabled = false; btn.textContent = prevLabel || '刷新'; }
    }
  }
  function refresh() { return load(true); }
  function bind() {
    const btn = document.getElementById('healthRefresh');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => refresh());
    }
  }
  return { load, refresh, bind };
})();
