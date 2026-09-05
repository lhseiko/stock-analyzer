/**
 * ShareholderCharts Module (issue5)
 * 股东分析 Tab 的图表与列表渲染：股东户数走势、机构持仓数量变化、十大股东。
 * 使用已注册的 softDark 主题；任一数据缺失时优雅降级为"暂无数据"提示。
 */
const ShareholderCharts = {
  instances: {},

  disposeAll() {
    Object.values(this.instances).forEach(c => { try { c.dispose(); } catch {} });
    this.instances = {};
  },

  _init(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    if (this.instances[id]) { try { this.instances[id].dispose(); } catch {} }
    this.instances[id] = echarts.init(el, 'softDark', { renderer: 'canvas' });
    return this.instances[id];
  },

  // 主渲染入口：data 来自 /api/shareholders/:symbol
  renderAll(container, data) {
    this.disposeAll();
    if (!container) return;
    const d = data || {};

    const summary = this._buildSummary(d);
    const holderCard = d.holderCountTrendAvailable
      ? `<div class="chart-card large"><h3>👥 股东户数走势</h3><div id="shHolderTrend" class="chart"></div></div>`
      : `<div class="chart-card large"><h3>👥 股东户数走势</h3><div class="sh-empty">暂无股东户数数据（F10 未披露或接口暂不可用）</div></div>`;

    const instCard = d.institutionTrendAvailable
      ? `<div class="chart-card large"><h3>🏛️ 机构持仓数量变化<span class="sh-sub">（按报告期统计十大股东中的机构户数）</span></h3><div id="shInstTrend" class="chart"></div></div>`
      : `<div class="chart-card large"><h3>🏛️ 机构持仓数量变化</h3><div class="sh-empty">暂无机构持仓数据（F10 未披露或接口暂不可用）</div></div>`;

    const instHoldCard = d.institutionHoldingsAvailable
      ? `<div class="chart-card large"><h3>🏦 机构持仓汇总<span class="sh-sub">（按报告期：机构家数 / 流通持股比例）</span></h3><div id="shInstHoldTrend" class="chart"></div></div>`
      : `<div class="chart-card large"><h3>🏦 机构持仓汇总</h3><div class="sh-empty">暂无机构持仓数据（F10 未披露或接口暂不可用）</div></div>`;

    const fundCard = d.fundHoldingsAvailable
      ? `<div class="chart-card large"><h3>📊 基金持股<span class="sh-sub">（最新报告期前 10 大持仓基金）</span></h3><div id="shFundHold" class="sh-holders"></div></div>`
      : `<div class="chart-card large"><h3>📊 基金持股</h3><div class="sh-empty">暂无基金持股数据（F10 未披露或接口暂不可用）</div></div>`;

    const topShareholdersRatioCard = d.topShareholdersAvailable
      ? `<div class="chart-card large"><h3>📊 前十大股东持股比例<span class="sh-sub">（最新报告期：${d.topShareholders[0]?.endDate || '—'}）</span></h3><div id="shTopHoldersPie" class="chart"></div><div id="shTopHoldersPieNote"></div></div>`
      : `<div class="chart-card large"><h3>📊 前十大股东持股比例</h3><div class="sh-empty">暂无十大股东数据（F10 未披露或接口暂不可用）</div></div>`;

    const holdersCard = d.topShareholdersAvailable
      ? `<div class="chart-card large"><h3>📋 十大股东明细<span class="sh-sub">（最新报告期：${d.topShareholders[0]?.endDate || '—'}）</span></h3><div id="shTopHolders" class="sh-holders"></div></div>`
      : `<div class="chart-card large"><h3>📋 十大股东明细</h3><div class="sh-empty">暂无十大股东数据（F10 未披露或接口暂不可用）</div></div>`;

    container.innerHTML = `
      ${summary}
      ${topShareholdersRatioCard}
      ${holderCard}
      ${instCard}
      ${instHoldCard}
      ${holdersCard}
      ${fundCard}
    `;

    if (d.topShareholdersAvailable && d.topShareholders?.length) {
      this._renderTopHoldersPie(d.topShareholders);
    }

    if (d.holderCountTrendAvailable && d.holderCountTrend?.length) {
      this._renderHolderTrend(d.holderCountTrend);
    }
    if (d.institutionTrendAvailable && d.institutionTrend?.length) {
      this._renderInstTrend(d.institutionTrend);
    }
    if (d.institutionHoldingsAvailable && d.institutionHoldings?.length) {
      this._renderInstHoldTrend(d.institutionHoldings);
    }
    if (d.topShareholdersAvailable && d.topShareholders?.length) {
      this._renderTopHolders(d.topShareholders);
    }
    if (d.fundHoldingsAvailable && d.fundHoldings?.length) {
      this._renderFundHoldings(d.fundHoldings);
    }
  },

  _buildSummary(d) {
    const holderTrend = d.holderCountTrend || [];
    const instTrend = d.institutionTrend || [];
    const latestHolders = holderTrend.length ? holderTrend[holderTrend.length - 1] : null;
    const latestInst = instTrend.length ? instTrend[instTrend.length - 1] : null;
    const latestTopDate = d.topShareholders?.length ? d.topShareholders[0]?.endDate : '';
    const sourceNote = `来源：东方财富F10${latestHolders?.date ? ' · 户数截止 ' + latestHolders.date : ''}${latestTopDate ? ' · 十大股东报告期 ' + latestTopDate : ''}`;

    const items = [];
    items.push(['第一大股东', d.controllingShareholder || '—']);
    if (latestHolders) {
      const changeTxt = latestHolders.changeRatio != null
        ? `${latestHolders.changeRatio >= 0 ? '+' : ''}${latestHolders.changeRatio.toFixed(2)}% 环比`
        : '—';
      items.push(['最新股东户数', `${latestHolders.holderNum.toLocaleString('zh-CN')} 户 (${changeTxt})`]);
      if (latestHolders.avgFreeShares) {
        items.push(['户均持股', `${latestHolders.avgFreeShares.toLocaleString('zh-CN')} 股`]);
      }
      if (latestHolders.focus) {
        items.push(['持股集中度', latestHolders.focus]);
      }
    }
    if (latestInst) {
      items.push(['最新机构户数', `${latestInst.institutionCount} 家（占十大股东 ${latestInst.instRatio || 0}%）`]);
    }

    return `<div class="sh-summary">${items.map(([k, v]) => `
      <div class="sh-summary-item">
        <span class="sh-summary-label">${k}</span>
        <span class="sh-summary-value">${v}</span>
      </div>`).join('')}<div class="sh-summary-note">${sourceNote}</div></div>`;
  },

  _renderHolderTrend(trend) {
    const chart = this._init('shHolderTrend');
    if (!chart) return;
    const dates = trend.map(t => t.date);
    const nums = trend.map(t => t.holderNum);
    const ratios = trend.map(t => t.changeRatio);

    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['股东户数', '环比变化%'], top: 0 },
      grid: { left: 60, right: 60, top: 40, bottom: 50 },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 30 } },
      yAxis: [
        { type: 'value', name: '户数', axisLabel: { formatter: v => (v / 1e4).toFixed(1) + '万' } },
        { type: 'value', name: '环比%', position: 'right' },
      ],
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 12 }],
      series: [
        {
          name: '股东户数', type: 'bar', data: nums,
          itemStyle: { color: '#5470c6' }, barWidth: '50%',
        },
        {
          name: '环比变化%', type: 'line', yAxisIndex: 1, smooth: true, data: ratios,
          lineStyle: { width: 2, color: '#cdab74' }, itemStyle: { color: '#cdab74' },
        },
      ],
    });
  },

  _renderInstTrend(trend) {
    const chart = this._init('shInstTrend');
    if (!chart) return;
    const dates = trend.map(t => t.date);
    const counts = trend.map(t => t.institutionCount);
    const ratios = trend.map(t => t.instRatio);

    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['机构户数', '机构持股占比%'], top: 0 },
      grid: { left: 50, right: 55, top: 40, bottom: 50 },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 30 } },
      yAxis: [
        { type: 'value', name: '户数' },
        { type: 'value', name: '占比%', position: 'right' },
      ],
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 12 }],
      series: [
        { name: '机构户数', type: 'bar', data: counts, itemStyle: { color: '#7fa8c9' }, barWidth: '50%' },
        { name: '机构持股占比%', type: 'line', yAxisIndex: 1, smooth: true, data: ratios, lineStyle: { width: 2 } },
      ],
    });
  },

  _renderTopHoldersPie(holders) {
    const chart = this._init('shTopHoldersPie');
    const el = document.getElementById('shTopHoldersPie');
    if (!chart || !el) return;
    if (!holders || holders.length === 0) {
      el.innerHTML = '<div class="sh-empty">⚠️ 暂未获取到前十大股东数据。</div>';
      return;
    }

    chart.setOption({
      tooltip: { trigger: 'item', formatter: (p) => `${p.name}: ${(p.value != null ? p.value.toFixed(2) : '--')}% (${p.percent != null ? p.percent.toFixed(2) : '--'}%)` },
      legend: { type: 'scroll', orient: 'vertical', right: 0, top: 'middle' },
      series: [{
        type: 'pie',
        radius: ['30%', '65%'],
        center: ['40%', '50%'],
        data: holders.map(h => ({ name: h.name || '未知', value: h.holdRatio })),
        label: { formatter: '{b}\n{d}%' },
      }],
    });

    const institutionCount = holders.filter(h => h.type === '机构').length;
    const institutionRatio = holders.reduce((s, h) => s + (h.type === '机构' ? (h.holdRatio || 0) : 0), 0);
    const endDate = holders[0]?.endDate || '—';
    const noteId = 'shTopHoldersPieNote';
    let noteEl = document.getElementById(noteId);
    if (!noteEl) {
      noteEl = document.createElement('div');
      noteEl.id = noteId;
      noteEl.className = 'sh-stats-note';
      el.parentNode.insertBefore(noteEl, el.nextSibling);
    }
    noteEl.innerHTML = `
      <div class="sh-stats-main">前十大股东中共有 <b>${institutionCount}</b> 家机构，合计占总股本 <b>${institutionRatio.toFixed(2)}%</b>（报告期：${endDate}）</div>
      <div class="sh-stats-sub">注：饼图展示前十大股东各自占总股本比例。</div>
    `;
  },

  _renderTopHolders(holders) {
    const el = document.getElementById('shTopHolders');
    if (!el) return;
    const maxRatio = Math.max(...holders.map(h => h.holdRatio || 0), 1);

    const changeLabel = (c) => {
      if (c == null) return '<span class="sh-change neutral">—</span>';
      const num = Number(c);
      if (!isNaN(num) && String(c).trim() !== '') {
        if (num > 0) return `<span class="sh-change up">▲ 增持 ${num.toLocaleString('zh-CN')}</span>`;
        if (num < 0) return `<span class="sh-change down">▼ 减持 ${Math.abs(num).toLocaleString('zh-CN')}</span>`;
        return '<span class="sh-change neutral">— 不变</span>';
      }
      const s = String(c);
      if (s.includes('新进')) return '<span class="sh-change up">★ 新进</span>';
      if (s.includes('减')) return `<span class="sh-change down">▼ ${s}</span>`;
      if (s.includes('增')) return `<span class="sh-change up">▲ ${s}</span>`;
      return `<span class="sh-change neutral">— ${s}</span>`;
    };
    const typeTag = (t) => t === '机构'
      ? '<span class="sh-tag inst">机构</span>'
      : '<span class="sh-tag person">其他</span>';

    el.innerHTML = holders.map((h, i) => `
      <div class="sh-holder-row">
        <div class="sh-rank">${i + 1}</div>
        <div class="sh-holder-main">
          <div class="sh-holder-name">${this._esc(h.name)}${typeTag(h.type)}</div>
          <div class="sh-holder-bar"><div class="sh-holder-fill" style="width:${(h.holdRatio / maxRatio * 100).toFixed(1)}%"></div></div>
        </div>
        <div class="sh-holder-ratio">${h.holdRatio?.toFixed(2) || '0'}%</div>
        <div class="sh-holder-change">${changeLabel(h.change)}</div>
      </div>
    `).join('');
  },

  _renderInstHoldTrend(trend) {
    const chart = this._init('shInstHoldTrend');
    if (!chart) return;
    const dates = trend.map(t => t.date);
    const orgNums = trend.map(t => t.orgNum);
    const ratios = trend.map(t => t.freeRatio);

    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['机构家数', '流通持股比例%'], top: 0 },
      grid: { left: 55, right: 55, top: 40, bottom: 50 },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 30 } },
      yAxis: [
        { type: 'value', name: '家数' },
        { type: 'value', name: '占比%', position: 'right' },
      ],
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 12 }],
      series: [
        { name: '机构家数', type: 'bar', data: orgNums, itemStyle: { color: '#7fa8c9' }, barWidth: '50%' },
        { name: '流通持股比例%', type: 'line', yAxisIndex: 1, smooth: true, data: ratios, lineStyle: { width: 2 } },
      ],
    });
  },

  _renderFundHoldings(holdings) {
    const el = document.getElementById('shFundHold');
    if (!el) return;
    const top = holdings.slice(0, 10);
    const maxRatio = Math.max(...top.map(h => h.ratio || 0), 0.0001);
    const fmtWan = (v) => {
      if (!v) return '—';
      const yi = v / 1e8;
      return yi >= 1 ? `${yi.toFixed(2)} 亿` : `${(v / 1e4).toFixed(0)} 万`;
    };

    el.innerHTML = top.map((h, i) => `
      <div class="sh-holder-row">
        <div class="sh-rank">${i + 1}</div>
        <div class="sh-holder-main">
          <div class="sh-holder-name">${this._esc(h.name)}<span class="sh-tag inst">基金</span></div>
          <div class="sh-holder-bar"><div class="sh-holder-fill" style="width:${(h.ratio / maxRatio * 100).toFixed(1)}%"></div></div>
        </div>
        <div class="sh-holder-ratio">${h.ratio?.toFixed(2) || '0'}%</div>
        <div class="sh-holder-change">${fmtWan(h.value)}</div>
      </div>
    `).join('');
  },

  _esc(s) {
    if (!s) return '';
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },
};

if (typeof window !== 'undefined') window.ShareholderCharts = ShareholderCharts;
if (typeof module !== 'undefined' && module.exports) module.exports = ShareholderCharts;
