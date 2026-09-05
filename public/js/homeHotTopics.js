/* 首页「今日最热股票投资话题」卡片 —— 调用后端 /api/home-hot-topics
 * 由 AI 联网聚合同花顺、雪球、东方财富三大平台的当日最热股票投资话题并做简要分析。 */
const HomeHotTopics = (() => {
  let loading = false;
  let lastLoad = 0;
  const THROTTLE = 8000; // 前端 8 秒内不重复请求

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function sentimentClass(s) {
    return ({ '利好': 'pos', '利空': 'neg', '中性': 'neu', '未知': 'neu' })[s] || 'neu';
  }

  function sourceTag(s) {
    const cls = ({
      '同花顺': 'src-thsh', '雪球': 'src-xq', '东方财富': 'src-em', '联网搜索': 'src-web',
      '东方财富涨停板池': 'src-zt',
    })[s] || (String(s).indexOf('涨停') >= 0 ? 'src-zt' : 'src-other');
    return `<span class="hht-tag ${cls}">${escapeHtml(s)}</span>`;
  }

  function topicHtml(t, idx) {
    const stocks = (t.relatedStocks || []).map(s => `<span class="hht-stock">${escapeHtml(s)}</span>`).join('');
    const sources = (t.sources || []).map(sourceTag).join('');
    const sent = t.sentiment || '未知';
    const analysis = t.analysis
      ? `<div class="hht-analysis">${escapeHtml(t.analysis)}</div>`
      : (sent === '未知' && !t.analysis ? '' : '');
    return `
      <div class="hht-item">
        <div class="hht-rank">${idx + 1}</div>
        <div class="hht-main">
          <div class="hht-title-row">
            <span class="hht-topic">${escapeHtml(t.topic)}</span>
            <span class="hht-sent hht-sent-${sentimentClass(sent)}">${escapeHtml(sent)}</span>
          </div>
          ${stocks ? `<div class="hht-stocks">${stocks}</div>` : ''}
          ${analysis}
          ${sources ? `<div class="hht-sources">${sources}</div>` : ''}
        </div>
      </div>`;
  }

  function render(data) {
    const body = document.getElementById('homeHotTopicsBody');
    if (!body) return;
    const topics = (data && data.topics) || [];
    const updated = data && data.updated ? new Date(data.updated) : null;
    const updEl = document.getElementById('homeHotTopicsUpdated');
    if (updEl) {
      updEl.textContent = updated ? '更新于 ' + updated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    }
    if (!topics.length) {
      const msg = (data && (data.error || data.summary)) || '暂无可展示的热点话题，请稍后刷新或检查网络。';
      body.innerHTML = `<div class="ai-empty">${escapeHtml(msg)}</div>`;
      return;
    }
    const list = topics.map((t, i) => topicHtml(t, i)).join('');
    const summary = data.summary ? `<div class="hht-summary">${escapeHtml(data.summary)}</div>` : '';
    const zt = data && data.ztSummary;
    const ztHtml = (zt && zt.total)
      ? `<div class="hht-ztline">当日全市场涨停 <b>${escapeHtml(zt.total)}</b> 只${zt.date ? '（' + escapeHtml(zt.date) + '）' : ''}，按行业聚合为下列热点</div>`
      : '';
    body.innerHTML = `${ztHtml}${list}${summary}
      <div class="hht-foot">真实数据来源：东方财富涨停板池（akshare）· 按涨停家数聚合 · 点击「🔄 刷新」重新获取</div>`;
  }

  async function load(force) {
    const now = Date.now();
    if (loading) return;
    if (!force && now - lastLoad < THROTTLE) return;
    loading = true;
    lastLoad = now;
    const body = document.getElementById('homeHotTopicsBody');
    if (body && !body.querySelector('.hht-item')) body.innerHTML = '<div class="ai-empty">正在联网聚合同花顺/雪球/东方财富最热话题…</div>';
    try {
      const resp = await fetch('/api/home-hot-topics' + (force ? '?refresh=1' : ''));
      const data = await resp.json();
      render(data);
    } catch (e) {
      if (body) body.innerHTML = `<div class="ai-empty">热点聚合失败：${escapeHtml(e.message)}</div>`;
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
