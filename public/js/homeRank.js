/* 首页「基金重仓行业配置矩阵」卡片 —— 调用后端 /api/fund-industry-matrix
 * 展示头部基金最新季报前 10 重仓股按行业聚合的矩阵（行业 × 基金 × 重仓股）。
 * 数据源：akshare 混合型基金按近 1 年业绩头部 N 只 + industryAnalysis 股票→行业映射。 */
const HomeRank = (() => {
  let loading = false;
  let lastLoad = 0;
  const THROTTLE = 8000;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDateTime(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // 权重色阶：行业总权重越高颜色越深（红→看涨集中）
  function weightColor(w) {
    if (w >= 200) return 'wt-hot';      // 集中度极高
    if (w >= 100) return 'wt-warm';
    if (w >= 40)  return 'wt-mid';
    if (w >= 10)  return 'wt-light';
    return 'wt-low';
  }
  function weightLabel(w) {
    if (w >= 200) return '集中';
    if (w >= 100) return '重仓';
    if (w >= 40)  return '中等';
    if (w >= 10)  return '低配';
    return '微配';
  }

  // 行业行：展示行业名 + 基金数 + 行业内重仓股明细（按基金×股票列）
  function industryRow(ind, idx) {
    const indClass = weightColor(ind.totalWeight);
    const topFunds = (ind.funds || []).slice(0, 5);
    // 构造 "基金×股票" 矩阵 cell：每只基金 1 列，cell 内展示其重仓股
    const fundHeaders = topFunds.map(f => `<th class="fm-fund">${escapeHtml(f.name)}<div class="fm-fund-ret">${f.yearReturn != null ? (f.yearReturn >= 0 ? '+' : '') + f.yearReturn + '%' : '—'}</div></th>`).join('');
    // 行业内 unique 重仓股
    const stockMap = new Map();
    for (const f of topFunds) {
      for (const s of (f.stocks || [])) {
        if (!stockMap.has(s.code)) stockMap.set(s.code, { code: s.code, name: s.name, fundWeights: [] });
        stockMap.get(s.code).fundWeights.push({ fundName: f.name, weight: s.weight });
      }
    }
    const stocks = Array.from(stockMap.values()).sort((a, b) => {
      const aw = a.fundWeights.reduce((s, x) => s + x.weight, 0);
      const bw = b.fundWeights.reduce((s, x) => s + x.weight, 0);
      return bw - aw;
    }).slice(0, 6);

    const bodyRows = stocks.map(s => {
      const cells = topFunds.map(f => {
        const w = (f.stocks || []).find(x => x.code === s.code);
        return `<td class="fm-cell">${w ? (w.weight >= 0 ? '<span class="pos">' : '<span class="neg">') + w.weight.toFixed(2) + '%</span>' : '—'}</td>`;
      }).join('');
      return `<tr><td class="fm-stock">${escapeHtml(s.name)}<span class="fm-stock-code">${escapeHtml(s.code)}</span></td>${cells}</tr>`;
    }).join('');

    return `<div class="fm-industry ${indClass}" style="animation-delay:${(idx * 0.04).toFixed(2)}s">
      <div class="fm-industry-head">
        <span class="fm-industry-name">${escapeHtml(ind.name)}</span>
        <span class="fm-industry-stat">
          <span class="fm-stat-tag">行业总权 <b>${ind.totalWeight.toFixed(1)}%</b></span>
          <span class="fm-stat-tag">${ind.fundCount} 只基金</span>
          <span class="fm-stat-tag ${indClass}">${weightLabel(ind.totalWeight)}</span>
        </span>
      </div>
      <div class="fm-table-wrap">
        <table class="fm-table">
          <thead><tr><th class="fm-stock-head">重仓股 \\ 基金</th>${fundHeaders}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>
    </div>`;
  }

  function matrixView(data) {
    const industries = data.industries || [];
    if (!industries.length) {
      return `<div class="ai-empty">暂无基金重仓行业配置数据。可点击「刷新」重试。</div>`;
    }
    return industries.slice(0, 8).map((ind, i) => industryRow(ind, i)).join('');
  }

  function render(data) {
    const body = document.getElementById('rankBody');
    if (!body) return;
    const updEl = document.getElementById('rankUpdated');
    if (updEl) {
      const parts = [];
      if (data.quarter) parts.push('📊 ' + data.quarter);
      parts.push('更新 ' + fmtDateTime(new Date()));
      if (data.fundCount) parts.push('覆盖 ' + data.fundCount + ' 只基金');
      updEl.textContent = parts.join(' · ');
    }

    let html = '';
    html += matrixView(data);
    if (data.note) {
      html += `<div class="rank-note">📌 ${escapeHtml(data.note)}<div style="margin-top:4px;color:var(--text-light);">仅供研究参考，不构成投资建议。</div></div>`;
    }

    body.innerHTML = html;
  }

  async function load(force) {
    const now = Date.now();
    if (loading) return;
    if (!force && now - lastLoad < THROTTLE) return;
    loading = true;
    lastLoad = now;
    const btn = document.getElementById('rankRefresh');
    const prevLabel = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '🔄 刷新中…'; }
    const body = document.getElementById('rankBody');
    if (body && !body.querySelector('.fm-industry')) {
      body.innerHTML = '<div class="ai-empty">正在拉取头部基金最新季报前 10 重仓股并按行业聚合…</div>';
    }
    try {
      const url = '/api/fund-industry-matrix' + (force ? '?topN=15&_=' + Date.now() : '?_=' + Date.now());
      const resp = await fetch(url, { cache: 'no-store' });
      const data = await resp.json();
      if (data && data.success !== false && (data.industries || []).length) {
        render({ ...data, ok: true });
      } else {
        if (body) body.innerHTML = `<div class="ai-empty">基金重仓行业配置矩阵获取失败：${escapeHtml((data && data.error) || '暂无数据')}</div>`;
      }
    } catch (e) {
      if (body) body.innerHTML = `<div class="ai-empty">基金重仓行业配置矩阵获取失败：${escapeHtml(e.message)}</div>`;
    } finally {
      loading = false;
      if (btn) { btn.disabled = false; btn.textContent = prevLabel || '🔄 刷新'; }
    }
  }
  function refresh() { return load(true); }
  function bind() {
    const btn = document.getElementById('rankRefresh');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => refresh());
    }
  }
  return { load, refresh, bind };
})();
