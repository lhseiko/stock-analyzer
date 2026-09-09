/* 首页「板块舆情热度周榜」卡片 —— 调用后端 /api/home-hot-topics（20260909m 重构）
 * 五指标(A 舆情曝光/B 社区讨论/C 韭菜讨论/D 舆情情感/E 社区情感) + 三路交叉验证 + 情绪标签 + 告警。
 * 热度≠涨跌预测；NLP 词典法存在误差；全部口径以后端 footnotes 为准。 */
const HomeHotTopics = (() => {
  let loading = false;
  let lastLoad = 0;
  let retryTimer = null;
  let retryCount = 0;
  const THROTTLE = 8000;      // 前端 8 秒内不重复请求
  const RETRY_INTERVAL = 30000; // 采集中自动重试间隔
  const RETRY_MAX = 10;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  const LEVEL_CLS = { '最热': 'lv-hot', '有点挤': 'lv-warm', '热度一般': 'lv-cool' };
  const TAG_CLS = {
    '比谁跑得快': 'tag-run', '极度恐慌': 'tag-panic', '资金拥挤': 'tag-crowd',
    'KOL蜂拥': 'tag-kol', '分化磨盘': 'tag-div', '筹码钝化': 'tag-numb',
  };

  function pctCell(v) {
    if (v == null) return '<span class="htw-dim">--</span>';
    const cls = v > 0 ? 'htw-up' : (v < 0 ? 'htw-down' : 'htw-dim');
    return `<span class="${cls}">${v > 0 ? '+' : ''}${v}%</span>`;
  }

  function rowHtml(r, idx) {
    const alarm = r.alarm ? '<span class="htw-alarm" title="韭菜讨论归一化值≥90 且综合分≥70">⚠️ 韭菜蜂拥</span>' : '';
    const tag = r.tag ? `<span class="htw-tag2 ${TAG_CLS[r.tag] || ''}">${escapeHtml(r.tag)}</span>` : '';
    const level = `<span class="htw-level ${LEVEL_CLS[r.level] || ''}">${escapeHtml(r.level)}</span>`;
    const sub = [];
    sub.push(`舆情A ${r.A.raw}(${r.A.n == null ? '--' : r.A.n})`);
    if (r.B) sub.push(`社区B ${r.B.raw}(${r.B.n == null ? '--' : r.B.n})`);
    if (r.C) sub.push(`韭菜C ${r.C.raw}(${r.C.n == null ? '--' : r.C.n})`);
    sub.push(`舆情看多 ${r.D == null ? '--' : r.D + '%'}`);
    if (r.E != null) sub.push(`社区看多 ${r.E}%`);
    const maxStock = r.maxStock ? `<span class="htw-stock" title="5日主力净流入最大股">${escapeHtml(r.maxStock)}</span>` : '';
    return `
      <div class="htw-item${r.alarm ? ' htw-alarm-row' : ''}">
        <div class="htw-rank">${idx + 1}</div>
        <div class="htw-main">
          <div class="htw-title-row">
            <span class="htw-name">${escapeHtml(r.name)}</span>
            ${level}${tag}${alarm}${maxStock}
          </div>
          <div class="htw-sub">${sub.map(escapeHtml).join(' · ')}</div>
        </div>
        <div class="htw-right">
          <div class="htw-score">${r.score}</div>
          <div class="htw-market">5日 ${pctCell(r.pct5d)} · 资金 ${r.netPct5d == null ? '--' : (r.netPct5d > 0 ? '+' : '') + r.netPct5d + '%'}</div>
        </div>
      </div>`;
  }

  function render(data) {
    const body = document.getElementById('homeHotTopicsBody');
    if (!body) return;
    const updEl = document.getElementById('homeHotTopicsUpdated');
    const updated = data && data.updated ? new Date(data.updated) : null;
    if (updEl) {
      updEl.textContent = updated ? '更新于 ' + updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    }
    stopRetry();

    // 采集中 / 失败状态
    if (!data || data.ok !== true) {
      const msg = (data && data.message) || '周榜数据尚未就绪。';
      if (data && data.collecting) startRetry();
      body.innerHTML = `<div class="htw-status"><span class="htw-spin"></span>${escapeHtml(msg)}</div>`;
      return;
    }

    const rows = data.rows || [];
    const cp = data.completeness || {};
    const src = data.sources || {};
    const degrade = data.meta && data.meta.degradeMode;
    const notice = data.status === 'refreshing'
      ? '<div class="htw-notice">🔄 后台正在重新采集今日数据，本列表先用已保存数据计算；完成后自动更新。</div>'
      : '';
    const degradeHtml = degrade
      ? '<div class="htw-notice htw-notice-warn">⚠️ 东财股吧通道受限，社区类指标(B/E)缺失，当前为降级口径：综合分 = 舆情曝光×0.8 + 舆情情感×0.2。</div>'
      : '';

    if (!rows.length) {
      body.innerHTML = `<div class="ai-empty">${escapeHtml(data.message || '本周暂无可统计数据。')}</div>`;
      return;
    }

    const list = rows.map((r, i) => rowHtml(r, i)).join('');
    const completeness = cp.collectedDays != null
      ? `<span class="htw-chip">${escapeHtml(cp.status || '数据累积中')}（${cp.collectedDays}/${cp.expectedDays} 天）</span>`
      : '';
    const srcChips = [
      `<span class="htw-chip">舆情快讯: ${escapeHtml(src.news || '--')}</span>`,
      `<span class="htw-chip">东财股吧: ${escapeHtml(src.guba || '--')}（${escapeHtml(src.gubaBoards || '--')}）</span>`,
      `<span class="htw-chip">5日资金流: ${escapeHtml(src.market || '--')}</span>`,
    ].join('');
    const foot = ((data.footnotes || []).map(f => `<div class="htw-foot-line">${escapeHtml(f)}</div>`)).join('');
    const more = data.rowsTotal > rows.length ? `<div class="htw-foot-line">共 ${data.rowsTotal} 个板块有数据，当前显示前 ${rows.length} 名。</div>` : '';

    body.innerHTML = `${notice}${degradeHtml}
      <div class="htw-meta">${completeness}${srcChips}</div>
      ${list}${more}
      <div class="htw-foot">${foot}</div>`;
  }

  // ---------- 采集中自动重试 ----------
  function startRetry() {
    stopRetry();
    retryCount = 0;
    retryTimer = setInterval(() => {
      retryCount++;
      if (retryCount > RETRY_MAX) { stopRetry(); return; }
      load(false, true);
    }, RETRY_INTERVAL);
  }
  function stopRetry() {
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  }

  async function load(force, isAuto) {
    const now = Date.now();
    if (loading) return;
    if (!force && !isAuto && now - lastLoad < THROTTLE) return;
    loading = true;
    lastLoad = now;
    const body = document.getElementById('homeHotTopicsBody');
    if (body && !body.querySelector('.htw-item') && !isAuto) {
      body.innerHTML = '<div class="ai-empty">正在加载板块舆情热度周榜…</div>';
    }
    try {
      const resp = await fetch('/api/home-hot-topics' + (force ? '?refresh=1' : ''));
      const data = await resp.json();
      render(data);
    } catch (e) {
      if (body) body.innerHTML = `<div class="ai-empty">周榜加载失败：${escapeHtml(e.message)}</div>`;
    } finally {
      loading = false;
    }
  }

  function refresh() { return load(true); }

  function bind() {
    const btn = document.getElementById('homeHotTopicsRefresh');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => refresh());
    }
  }

  return { load, refresh, bind };
})();
