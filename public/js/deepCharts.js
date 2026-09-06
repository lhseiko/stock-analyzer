/**
 * Deep Analysis Charts Module
 * Renders charts for the 26-section product company analysis
 */
function round2(n) {
  const v = parseFloat(n);
  return isNaN(v) ? 0 : Math.round(v * 100) / 100;
}

const DeepCharts = {
  instances: {},

  disposeAll() {
    Object.values(this.instances).forEach(c => { try { c.dispose(); } catch {} });
    this.instances = {};
  },

  get(id) {
    let el = document.getElementById(id);
    if (!el) return null;
    if (this.instances[id]) { try { this.instances[id].dispose(); } catch {} }
    this.instances[id] = echarts.init(el, 'softDark', { renderer: 'canvas' });
    return this.instances[id];
  },

  // 仅对可见容器中的图表执行 resize（折叠分组展开时修正尺寸，隐藏容器跳过）
  resizeVisibleCharts() {
    Object.values(this.instances).forEach(c => {
      try {
        const dom = c.getDom();
        if (dom && dom.offsetParent !== null) c.resize();
      } catch (e) {}
    });
  },

  colors: {
    revenue: '#7fa8c9',
    cost: '#cf8e8e',
    profit: '#8fb89a',
    operatingProfit: '#a99bc4',
    marketCap: '#cdab74',
    netAssets: '#a99bc4',
    cash: '#6fb0a4',
    expense1: '#cf8e8e',
    expense2: '#cdab74',
    expense3: '#7fa8c9',
    mean: '#8b939c',
    // 20260902g：估值带线色对调，对齐全站利好红/利空绿语义（高估=利空→绿，低估=利好→红）
    high: '#8fb89a',
    low: '#cf8e8e',
  },

  // 通用：为年度图表生成带 TTM 标记的 x 轴标签
  _yearLabels(data) {
    return (data || []).map(d => (d && d.ttm) ? (String(d.year) + ' (TTM)') : (d ? String(d.year) : ''));
  },
  // 通用：在图表下方追加 TTM / 数据来源说明（幂等，避免重复追加）
  _appendTtmNote(chartId, data, sourceLabel) {
    const el = document.getElementById(chartId);
    if (!el || !el.parentElement) return;
    const ttmYears = (data || []).filter(d => d && d.ttm).map(d => d.year);
    if (!ttmYears.length) return;
    const id = chartId + '-ttm-note';
    if (el.parentElement.querySelector('#' + id)) return;
    const note = document.createElement('div');
    note.id = id;
    note.className = 'segment-note';
    const src = sourceLabel || '东方财富 F10 财报数据';
    note.innerHTML = '<b>数据来源：</b>' + src + '。⚠️ ' + ttmYears.join('、') + ' 年为 TTM 滚动估算（当年已披露中报/季报 + 上一年年报 − 上一年同期），非全年实际值，最新报告期以公司公告为准。';
    el.parentElement.appendChild(note);
  },

  // Section 4: Revenue & Cost Trend
  renderRevenueCost(data) {
    const chart = this.get('deepRevenueCost');
    if (!chart || !data) return;
    const years = this._yearLabels(data);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['营业总收入', '营业总成本', '归母净利润', '营运利润'], top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value', name: '亿元', position: 'left' },
      series: [
        { name: '营业总收入', type: 'line', data: data.map(d => d.revenue), smooth: true, itemStyle: { color: this.colors.revenue } },
        { name: '营业总成本', type: 'line', data: data.map(d => d.cost), smooth: true, itemStyle: { color: this.colors.cost } },
        { name: '归母净利润', type: 'line', data: data.map(d => d.netProfit), smooth: true, itemStyle: { color: this.colors.profit } },
        { name: '营运利润', type: 'line', data: data.map(d => d.operatingProfit), smooth: true, itemStyle: { color: this.colors.operatingProfit } },
      ],
    });
    this._appendTtmNote('deepRevenueCost', data);
  },

  // Section 15b: 近5年 ROE 与毛利率走势（含文字解读）
  renderRoeMarginTrend(data) {
    const chart = this.get('deepRoeMargin');
    const textEl = document.getElementById('deepRoeMarginText');
    if (!chart) return;
    if (!data || !Array.isArray(data.years) || !data.years.length) {
      chart.setOption({ title: { text: '暂无可用的 ROE / 毛利率历史数据', left: 'center', top: 'center', textStyle: { color: '#8b939c', fontSize: 13 } } });
      if (textEl) textEl.innerHTML = '<div class="data-empty">⚠️ 暂未获取到近5年 ROE 与毛利率序列（东方财富财务接口未返回 ROE 或多期数据不足）。</div>';
      return;
    }
    const years = this._yearLabels(data.years);
    const roeData = data.years.map(d => (typeof d.roe === 'number' ? round2(d.roe) : null));
    const gmData = data.years.map(d => (typeof d.grossMargin === 'number' ? round2(d.grossMargin) : null));
    const nmData = data.years.map(d => (typeof d.netMargin === 'number' ? round2(d.netMargin) : null));
    chart.setOption({
      tooltip: { trigger: 'axis', valueFormatter: (v) => (v == null ? '—' : v + '%') },
      legend: { data: ['ROE', '毛利率', '净利率'], top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value', name: '%', axisLabel: { formatter: '{value}%' } },
      series: [
        { name: 'ROE', type: 'line', data: roeData, smooth: true, connectNulls: true, itemStyle: { color: '#cdab74' }, lineStyle: { width: 3 } },
        { name: '毛利率', type: 'line', data: gmData, smooth: true, connectNulls: true, itemStyle: { color: '#8fb89a' } },
        { name: '净利率', type: 'line', data: nmData, smooth: true, connectNulls: true, itemStyle: { color: '#7fa8c9' } },
      ],
    });
    // 文字解读（方向 + 幅度 + 边际）
    if (textEl && data) {
      const srcLabel = data.source || '东方财富 F10 / ZYZBAjaxNew';
      let html = '';
      if (data.conclusion) html += '<p class="roe-margin-concl">' + this.escapeHtml(data.conclusion) + '</p>';
      if (Array.isArray(data.reasoning) && data.reasoning.length) {
        html += '<ul class="roe-margin-reason">';
        for (const r of data.reasoning) html += '<li>' + this.escapeHtml(r) + '</li>';
        html += '</ul>';
      }
      html += '<div class="metrics-period-note">数据来源：' + this.escapeHtml(srcLabel) + '。ROE 为加权净资产收益率(ROEJQ)，毛利率/净利率取自利润表，均与全页口径一致。</div>';
      textEl.innerHTML = html;
    }
  },

  // Section 6: Short-term Financial Risk
  renderShortTermRisk(data) {
    const chart = this.get('deepShortTermRisk');
    if (!chart || !data) return;
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: '15%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: ['货币资金', '短期投资', '短期负债', '应付账款'] },
      yAxis: { type: 'value', name: '亿元' },
      series: [{
        type: 'bar',
        data: [
          { value: data.cash, itemStyle: { color: '#8fb89a' } },
          { value: data.shortTermInvestments, itemStyle: { color: '#7fa8c9' } },
          { value: data.shortTermDebt, itemStyle: { color: '#cf8e8e' } },
          { value: data.accountsPayable, itemStyle: { color: '#cdab74' } },
        ],
        label: { show: true, position: 'top', formatter: '{c}亿' },
      }],
    });
  },

  // Section 7: Asset Composition
  renderAssetComp(data) {
    const chart = this.get('deepAssetComp');
    if (!chart || !data) return;
    chart.setOption({
      tooltip: { trigger: 'item', formatter: '{b}: {c}亿 ({d}%)' },
      legend: { type: 'scroll', orient: 'vertical', right: 0, top: 'middle' },
      series: [{
        type: 'pie',
        radius: ['35%', '65%'],
        center: ['40%', '50%'],
        data: data.map(a => ({ name: a.name, value: a.value })),
        label: { formatter: '{b}\n{d}%' },
      }],
    });
  },

  // Section 8: Liability Composition
  renderLiabComp(data) {
    const chart = this.get('deepLiabComp');
    if (!chart || !data) return;
    chart.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: '15%', right: '8%', bottom: '15%', top: '8%' },
      xAxis: { type: 'value', name: '亿元' },
      yAxis: { type: 'category', data: data.map(d => d.name), inverse: true },
      series: [{
        type: 'bar',
        data: data.map(d => ({ value: d.value, itemStyle: { color: '#cf8e8e' } })),
        label: { show: true, position: 'right', formatter: '{c}亿' },
      }],
    });
  },

  // Section 9: Revenue vs Operating Cash Flow (dual Y-axis)
  renderRevVsCash(data) {
    const chart = this.get('deepRevVsCash');
    if (!chart || !data) return;
    const years = this._yearLabels(data);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['营业总收入', '经营现金流净额'], top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: [
        { type: 'value', name: '营收(亿)', position: 'left' },
        { type: 'value', name: '现金流(亿)', position: 'right' },
      ],
      series: [
        { name: '营业总收入', type: 'line', data: data.map(d => d.revenue), smooth: true, itemStyle: { color: this.colors.revenue } },
        { name: '经营现金流净额', type: 'line', yAxisIndex: 1, data: data.map(d => d.operatingCashFlow), smooth: true, itemStyle: { color: this.colors.profit } },
      ],
    });
    // 追加口径说明
    const el = document.getElementById('deepRevVsCash');
    if (el && el.parentElement) {
      const id = 'rev-vs-cash-note';
      if (!el.parentElement.querySelector('#' + id)) {
        const note = document.createElement('div');
        note.id = id;
        note.className = 'segment-note';
        const ttmYears = data.filter(d => d.ttm).map(d => d.year);
        const ttmHint = ttmYears.length ? `最末年（${ttmYears.join('、')}）经营现金流净额已按 TTM 滚动累计还原为全年等效口径。` : '';
        note.innerHTML = '<b>口径说明：</b>左轴为营业总收入，右轴为经营现金流净额，双轴便于对比收入规模与现金回收能力。经营现金流受回款节奏、保单退保、投资收益等影响，短期波动未必代表收入质量变化。' + ttmHint;
        el.parentElement.appendChild(note);
      }
    }
  },

  // Section 10/11/12: Market Cap vs Fundamentals (dual Y-axis)
  renderMarketCapCompare(id, data, label1, key1, label2) {
    const chart = this.get(id);
    if (!chart || !data) return;
    const valid = data.filter(d => d && d[key1] != null && d.marketCap != null);
    if (!valid.length) {
      chart.setOption({
        title: { text: '暂无可用的市值对比数据', left: 'center', top: 'center', textStyle: { color: '#8b939c', fontSize: 13 } },
        xAxis: { type: 'category', data: [] }, yAxis: { type: 'value' }, series: []
      }, true);
      return;
    }
    const years = valid.map(d => d.year);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: [label1, label2], top: 0 },
      grid: { left: '10%', right: '10%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: [
        { type: 'value', name: label1 + '(亿)', position: 'left' },
        { type: 'value', name: label2 + '(亿)', position: 'right' },
      ],
      series: [
        { name: label1, type: 'line', data: valid.map(d => d[key1]), smooth: true, itemStyle: { color: this.colors.revenue }, label: { show: true, formatter: '{c}' } },
        { name: label2, type: 'line', yAxisIndex: 1, data: valid.map(d => d.marketCap), smooth: true, itemStyle: { color: this.colors.marketCap }, label: { show: true, formatter: '{c}' } },
      ],
    });
    // 市值对比数据说明（幂等）
    const el = document.getElementById(id);
    if (el && el.parentElement) {
      const noteId = id + '-mcap-note';
      if (!el.parentElement.querySelector('#' + noteId)) {
        const note = document.createElement('div');
        note.id = noteId;
        note.className = 'segment-note';
        note.innerHTML = '<b>口径说明：</b>左轴为' + label1 + '，右轴为市值，双轴刻度不同便于观察收入/利润/净资产与市值的相对走势。' +
          (valid.some(d => d.year >= 2026) ? '2026 年及以后若无年报，财务指标取最近可用年报作为近似参考。' : '');
        el.parentElement.appendChild(note);
      }
    }
  },

  // Section 13: Net Profit vs Operating Cash Flow
  renderProfitVsCash(data) {
    const chart = this.get('deepProfitVsCash');
    if (!chart || !data) return;
    const years = this._yearLabels(data);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['归母净利润', '经营现金流净额'], top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value', name: '亿元' },
      series: [
        { name: '归母净利润', type: 'line', data: data.map(d => d.netProfit), smooth: true, itemStyle: { color: this.colors.profit } },
        { name: '经营现金流净额', type: 'line', data: data.map(d => d.operatingCashFlow), smooth: true, itemStyle: { color: this.colors.cash } },
      ],
    });
    // 追加口径说明
    const el = document.getElementById('deepProfitVsCash');
    if (el && el.parentElement) {
      const id = 'profit-vs-cash-note';
      if (!el.parentElement.querySelector('#' + id)) {
        const note = document.createElement('div');
        note.id = id;
        note.className = 'segment-note';
        const ttmYears = data.filter(d => d.ttm).map(d => d.year);
        const ttmHint = ttmYears.length ? `最末年（${ttmYears.join('、')}）经营现金流净额已按 TTM 滚动累计还原为全年等效口径。` : '';
        note.innerHTML = '<b>口径说明：</b>经营现金流净额与净利润口径不同，前者受回款周期、存货、应付变动影响，后者含折旧摊销等非现金项目。若某年现金流大幅偏离净利润，通常与业务季节性、资本开支或营运资本变化有关。' + ttmHint;
        el.parentElement.appendChild(note);
      }
    }
  },

  // Section 14: Revenue vs Total Cost
  renderRevVsCost(data) {
    const chart = this.get('deepRevVsCost');
    if (!chart || !data) return;
    const years = this._yearLabels(data);
    const hasOp = data.some(d => d.operatingProfit !== undefined && d.operatingProfit > 0);
    const legend = ['营业总收入', '营业总成本', '营业成本'];
    const series = [
      { name: '营业总收入', type: 'line', data: data.map(d => d.revenue), smooth: true, itemStyle: { color: this.colors.revenue } },
      { name: '营业总成本', type: 'line', data: data.map(d => d.cost), smooth: true, itemStyle: { color: this.colors.cost } },
      { name: '营业成本', type: 'line', data: data.map(d => d.operatingCost), smooth: true, itemStyle: { color: '#f97316' } },
    ];
    if (hasOp) {
      legend.push('营运利润');
      series.push({ name: '营运利润', type: 'line', data: data.map(d => d.operatingProfit || 0), smooth: true, itemStyle: { color: '#7fa8c9' }, lineStyle: { width: 3 }, label: { show: true, formatter: (p) => (p.value != null ? p.value.toFixed(2) : '') } });
    }
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: legend, top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value', name: '亿元' },
      series,
    });
    // 追加口径注释：营业总成本 vs 营业成本
    const el = document.getElementById('deepRevVsCost');
    if (el && el.parentElement) {
      const id = 'rev-vs-cost-note';
      if (!el.parentElement.querySelector('#' + id)) {
        const note = document.createElement('div');
        note.id = id;
        note.className = 'segment-note';
        note.innerHTML = '<b>口径说明：</b>「营业总成本」= 营业成本 + 税金及附加 + 销售/管理/研发/财务费用等企业经营全部耗费；「营业成本」仅指直接为生产/销售产品或服务发生的成本。两者差额主要体现期间费用与税费规模。';
        el.parentElement.appendChild(note);
      }
    }
  },

  // Section 15: Revenue vs Expenses (dual Y-axis)
  renderRevVsExp(data) {
    const chart = this.get('deepRevVsExp');
    if (!chart || !data) return;
    const years = this._yearLabels(data);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['营业总收入', '销售费用', '管理费用', '研发费用'], top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: [
        { type: 'value', name: '营收(亿)', position: 'left' },
        { type: 'value', name: '费用(亿)', position: 'right' },
      ],
      series: [
        { name: '营业总收入', type: 'line', data: data.map(d => d.revenue), smooth: true, itemStyle: { color: this.colors.revenue } },
        { name: '销售费用', type: 'line', yAxisIndex: 1, data: data.map(d => d.saleExpense), smooth: true, itemStyle: { color: this.colors.expense1 } },
        { name: '管理费用', type: 'line', yAxisIndex: 1, data: data.map(d => d.manageExpense), smooth: true, itemStyle: { color: this.colors.expense2 } },
        { name: '研发费用', type: 'line', yAxisIndex: 1, data: data.map(d => d.researchExpense), smooth: true, itemStyle: { color: this.colors.expense3 } },
      ],
    });
    // 追加口径说明：解释双 Y 轴与 TTM 还原
    const el = document.getElementById('deepRevVsExp');
    if (el && el.parentElement) {
      const id = 'rev-vs-exp-note';
      if (!el.parentElement.querySelector('#' + id)) {
        const note = document.createElement('div');
        note.id = id;
        note.className = 'segment-note';
        const ttmYears = data.filter(d => d.ttm).map(d => d.year);
        const ttmHint = ttmYears.length ? `最末年（${ttmYears.join('、')}）已按 TTM 滚动累计还原为全年等效口径。` : '';
        note.innerHTML = '<b>口径说明：</b>左轴为营业总收入，右轴为三费（销售/管理/研发费用），双轴刻度不同，避免费用绝对额小导致趋势看不清。' + ttmHint + '若某期费用大幅波动，通常与业务规模扩张/收缩、会计准则调整或一次性计提有关，建议结合当期年报「管理层讨论与分析」核对。';
        el.parentElement.appendChild(note);
      }
    }
  },

  // Section 17: Growth Rates
  renderGrowth(data, revenueCost) {
    const chart = this.get('deepGrowth');
    if (!chart || !data) return;
    const latestTtm = (revenueCost || []).some(d => d.year === data.latestYear && d.ttm);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { top: 0 },
      grid: { left: '15%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: ['营收增长率', '净利润增长率'] },
      yAxis: { type: 'value', name: '%' },
      series: [{
        type: 'bar',
        data: [
          { value: data.revenueGrowth, itemStyle: { color: data.revenueGrowth >= 0 ? '#cf8e8e' : '#8fb89a' } },
          { value: data.profitGrowth, itemStyle: { color: data.profitGrowth >= 0 ? '#cf8e8e' : '#8fb89a' } },
        ],
        label: { show: true, position: 'top', formatter: (p) => (p.value != null ? p.value.toFixed(2) + '%' : '') },
      }],
      title: { subtext: `基准年: ${data.baseYear} → 最新: ${data.latestYear}${latestTtm ? '（TTM估算）' : ''}`, left: 'center', top: 20 },
    });
    if (latestTtm) {
      const el = document.getElementById('deepGrowth');
      if (el && el.parentElement && !el.parentElement.querySelector('#deepGrowth-ttm-note')) {
        const note = document.createElement('div');
        note.id = 'deepGrowth-ttm-note';
        note.className = 'segment-note';
        note.innerHTML = '<b>数据来源：</b>东方财富 F10 财报数据。⚠️ 最新年（' + data.latestYear + '）增速基于 TTM 滚动估算（当年已披露中报/季报 + 上一年年报 − 上一年同期），与历史年报同比增速不可直接比较。';
        el.parentElement.appendChild(note);
      }
    }
  },

  // Section 18: Revenue vs Accounts Payable (dual Y-axis)
  renderPayable(data) {
    const chart = this.get('deepPayable');
    if (!chart || !data) return;
    const years = this._yearLabels(data);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['营业总收入', '应付账款'], top: 0 },
      grid: { left: '10%', right: '10%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: [
        { type: 'value', name: '营收(亿)', position: 'left' },
        { type: 'value', name: '应付账款(亿)', position: 'right' },
      ],
      series: [
        { name: '营业总收入', type: 'line', data: data.map(d => d.revenue), smooth: true, itemStyle: { color: this.colors.revenue } },
        { name: '应付账款', type: 'line', yAxisIndex: 1, data: data.map(d => d.accountsPayable), smooth: true, itemStyle: { color: this.colors.cost } },
      ],
    });
    this._appendTtmNote('deepPayable', data);
  },

  // Section 19/20/21: PE/PB/PS with mean ± std reference lines
  renderValuation(id, valuation, label) {
    const chart = this.get(id);
    const data = valuation?.valuationData;
    const stats = valuation ? valuation[label.toLowerCase() + 'Stats'] : null;
    if (!chart || !data) return;
    const years = this._yearLabels(data);
    const values = data.map(d => d[label.toLowerCase()] || d.pe || 0);
    const series = [
      { name: label, type: 'line', data: values, smooth: true, itemStyle: { color: '#7fa8c9' }, label: { show: true, formatter: '{c}' } },
      { name: '均值', type: 'line', data: years.map(() => stats.mean), lineStyle: { type: 'dashed', color: this.colors.mean }, itemStyle: { color: this.colors.mean } },
      { name: '高估线(+1σ)', type: 'line', data: years.map(() => stats.high), lineStyle: { type: 'dashed', color: this.colors.high }, itemStyle: { color: this.colors.high } },
      { name: '低估线(-1σ)', type: 'line', data: years.map(() => stats.low), lineStyle: { type: 'dashed', color: this.colors.low }, itemStyle: { color: this.colors.low } },
    ];
    // PE 图显著标注「当前 PE(TTM)」来源，避免停留在最近年报静态 PE
    if (label === 'PE' && valuation?.currentPeTtm > 0) {
      series[0].markLine = {
        symbol: 'none',
        data: [{ yAxis: valuation.currentPeTtm }],
        lineStyle: { color: '#e0556b', type: 'solid', width: 2 },
        label: { formatter: '当前PE(TTM) ' + valuation.currentPeTtm, position: 'insideEndTop', color: '#e0556b', fontWeight: 'bold' },
      };
      chart.setOption({
        tooltip: { trigger: 'axis' },
        legend: { data: [label, '均值', '高估线(+1σ)', '低估线(-1σ)', '当前PE(TTM)'], top: 0 },
        grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
        xAxis: { type: 'category', data: years },
        yAxis: { type: 'value', name: label },
        series,
      });
      this._appendCurrentPeNote(id, valuation.currentPeTtm, valuation.peSource);
      return;
    }
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: [label, '均值', '高估线(+1σ)', '低估线(-1σ)'], top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value', name: label },
      series,
    });
    if (label === 'PE') this._appendTtmNote(id, data);
    if (label === 'PB' || label === 'PS') this._appendValuationSourceNote(id, valuation?.peSource);
  },


  // 通用：在 PB/PS 图下方追加数据来源标注（幂等）
  _appendValuationSourceNote(chartId, source) {
    const el = document.getElementById(chartId);
    if (!el || !el.parentElement) return;
    const id = chartId + '-src-note';
    if (el.parentElement.querySelector('#' + id)) return;
    const note = document.createElement('div');
    note.id = id;
    note.className = 'segment-note';
    note.innerHTML = '📊 数据来源：' + (source || '东方财富TTM') + '（各年末/当前 PB / PS-TTM 真实市场估值）';
    el.parentElement.appendChild(note);
  },

  // 通用：在 PE 图下方追加「当前 PE(TTM)」显著标注（幂等）
  _appendCurrentPeNote(chartId, pe, source) {
    const el = document.getElementById(chartId);
    if (!el || !el.parentElement) return;
    const id = chartId + '-currentpe-note';
    if (el.parentElement.querySelector('#' + id)) return;
    const note = document.createElement('div');
    note.id = id;
    note.className = 'segment-note current-pe-note';
    note.innerHTML = '⭐ <b>当前 PE(TTM)：' + pe + '</b>（来源：' + (source || '东方财富TTM') + '）。图中 PE 曲线为各年末/当前 PE(TTM) 真实市场估值（东方财富 TTM 口径），当前 PE(TTM) 为最新值，用于与历史均值±σ 比较判断高低估。';
    el.parentElement.appendChild(note);
  },

  // Section 22: Net Profit vs Dividends
  renderDividend(data) {
    const chart = this.get('deepDividend');
    if (!chart || !data) return;
    const years = this._yearLabels(data);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['归母净利润', '分红金额'], top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: { type: 'value', name: '亿元' },
      series: [
        { name: '归母净利润', type: 'line', data: data.map(d => d.netProfit), smooth: true, itemStyle: { color: this.colors.profit } },
        { name: '分红金额', type: 'line', data: data.map(d => d.dividend), smooth: true, itemStyle: { color: this.colors.marketCap } },
      ],
    });
    this._appendTtmNote('deepDividend', data);
  },

  // Section 22c: 分红金额柱状图（近5年 · 每次/每年 可切换）
  // data: [{ year, label, amountYi, perShare, progress, isPending, sortKey }]
  renderDividendBar(raw) {
    const el = document.getElementById('deepDividendBar');
    if (!el) return;
    const data = (raw && raw.dividendPayouts) || (Array.isArray(raw) ? raw : []);
    const card = el.closest('.chart-card');
    if (!data || data.length === 0) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂无可用的分红派次明细数据（近5年）。</div>';
      return;
    }
    const chart = this.get('deepDividendBar');
    if (!chart) return;

    // 建立 label -> 原始数据索引，便于 tooltip 反查每股分红/实施进度
    const sortedData = [...data].sort((a, b) => (a.sortKey || '').localeCompare(b.sortKey || ''));

    const build = (mode) => {
      if (mode === 'year') {
        const byYear = {};
        for (const d of data) byYear[d.year] = (byYear[d.year] || 0) + (d.amountYi || 0);
        const years = Object.keys(byYear).sort();
        return {
          cats: years,
          vals: years.map(y => Math.round(byYear[y] * 100) / 100),
          pending: years.map(() => false),
          meta: years.map(() => null),
        };
      }
      if (mode === 'perShare') {
        return {
          cats: sortedData.map(d => d.label),
          vals: sortedData.map(d => d.perShare || 0),
          pending: sortedData.map(d => !!d.isPending),
          meta: sortedData.map(d => d),
        };
      }
      // 每次分红（按 sortKey 已排序）
      return {
        cats: sortedData.map(d => d.label),
        vals: sortedData.map(d => d.amountYi || 0),
        pending: sortedData.map(d => !!d.isPending),
        meta: sortedData.map(d => d),
      };
    };

    const draw = (mode) => {
      const { cats, vals, pending, meta } = build(mode);
      const isPerShare = mode === 'perShare';
      chart.setOption({
        tooltip: {
          trigger: 'axis', axisPointer: { type: 'shadow' },
          formatter: (ps) => {
            const p = ps[0];
            const idx = p.dataIndex;
            const m = meta && meta[idx];
            const perShare = m ? (m.perShare || 0).toFixed(2) : '';
            const amount = m ? (m.amountYi || 0).toFixed(2) : (typeof p.value === 'number' ? p.value.toFixed(2) : p.value);
            const progress = m && m.progress ? ` · ${m.progress}` : '';
            if (isPerShare) {
              return `${p.axisValue}<br/>每股分红 <b>${perShare} 元/股</b><br/>分红金额 <b>${amount} 亿</b>${progress}`;
            }
            return `${p.axisValue}<br/>分红金额 <b>${amount} 亿</b><br/>每股分红 <b>${perShare} 元/股</b>${progress}`;
          },
        },
        grid: { left: '8%', right: '6%', bottom: '14%', top: '12%' },
        xAxis: { type: 'category', data: cats, axisLabel: { rotate: cats.length > 8 ? 30 : 0, interval: 0 } },
        yAxis: { type: 'value', name: isPerShare ? '每股分红(元/股)' : '分红金额(亿元)' },
        series: [{
          type: 'bar',
          data: vals.map((v, i) => ({
            value: v,
            itemStyle: { color: pending[i] ? '#d6a35c' : this.colors.marketCap },
          })),
          barMaxWidth: 40,
          label: { show: true, position: 'top', formatter: (p) => (p.value ? (isPerShare ? p.value.toFixed(2) : p.value.toFixed(1)) : ''), color: '#c9d3dd' },
        }],
      }, true);
      const note = document.getElementById('deepDividendBarNote');
      if (note) {
        if (mode === 'year') {
          note.innerHTML = '📊 每年合计 = 该年度内全部派次（中期＋末期＋特别）分红金额之和。来源：东方财富分红方案(RPT_SHAREBONUS_DET)，含董事会预案/股东大会通过等「公告未分配」记录（橙色柱）。';
        } else if (mode === 'perShare') {
          note.innerHTML = '📊 每股分红 = 单次派息事件的每股派息金额（元/股）。橙色柱为「公告未分配」（董事会预案/股东大会通过等尚未实施）。来源：东方财富分红方案(RPT_SHAREBONUS_DET)。';
        } else {
          note.innerHTML = '📊 每次分红 = 单次派息事件金额（中期/末期/特别）。橙色柱为「公告未分配」（董事会预案/股东大会通过等尚未实施）。来源：东方财富分红方案(RPT_SHAREBONUS_DET)。';
        }
      }
    };

    draw('payout');

    // 切换按钮：使用事件委托，并把最新 draw 函数挂在 card 上。
    // 原因：renderDividendBar 可能被多次调用，每次调用 DeepCharts.get() 会 dispose 旧 chart
    // 并创建新实例；若把 chart 闭包在匿名 listener 里，listener 仍指向旧（已 dispose）chart，
    // 导致点击切换时 note 更新但图表不刷新。
    if (card) {
      if (!card._dividendBarWired) {
        card._dividendBarWired = true;
        card.addEventListener('click', (e) => {
          const btn = e.target.closest('.dy-toggle-btn');
          if (!btn) return;
          const mode = btn.dataset.mode;
          card.querySelectorAll('.dy-toggle-btn').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          if (typeof card._dividendBarDraw === 'function') card._dividendBarDraw(mode);
          setTimeout(() => {
            try { DeepCharts.instances['deepDividendBar'] && DeepCharts.instances['deepDividendBar'].resize(); } catch (e) {}
          }, 0);
        });
      }
      card._dividendBarDraw = draw;
    }
  },

  // Section 23: DCF Valuation
  renderDCF(data) {
    const el = document.getElementById('deepDCF');
    if (!el || !data) return;
    if (data.error) {
      el.innerHTML = `<div class="dcf-error">${data.error}</div>`;
      return;
    }
    const premiumClass = data.premium > 30 ? 'overvalued' : data.premium < -30 ? 'undervalued' : 'fair';
    const premiumText = data.premium > 0 ? `高估 ${data.premium}%` : `低估 ${Math.abs(data.premium)}%`;
    el.innerHTML = `
      <div class="dcf-grid">
        <div class="dcf-item"><span class="dcf-label">基础自由现金流</span><span class="dcf-value">${data.baseFCF} 亿</span></div>
        <div class="dcf-item"><span class="dcf-label">预测增长率</span><span class="dcf-value">${data.projectedGrowth}%</span></div>
        <div class="dcf-item"><span class="dcf-label">折现率</span><span class="dcf-value">${data.discountRate}%</span></div>
        <div class="dcf-item"><span class="dcf-label">永续增长率</span><span class="dcf-value">${data.perpetualGrowth}%</span></div>
        <div class="dcf-item"><span class="dcf-label">企业价值</span><span class="dcf-value">${data.enterpriseValue} 亿</span></div>
        <div class="dcf-item"><span class="dcf-label">股权价值</span><span class="dcf-value">${data.equityValue} 亿</span></div>
        <div class="dcf-item highlight"><span class="dcf-label">每股内在价值</span><span class="dcf-value">¥${data.perShareValue != null ? Number(data.perShareValue).toFixed(2) : '--'}</span></div>
        <div class="dcf-item"><span class="dcf-label">当前股价</span><span class="dcf-value">¥${data.currentPrice != null ? Number(data.currentPrice).toFixed(2) : '--'}</span></div>
        <div class="dcf-item ${premiumClass}"><span class="dcf-label">估值偏差</span><span class="dcf-value">${premiumText}</span></div>
      </div>
      <div class="dcf-note">
        <p>计算方法：基于近3年平均自由现金流，按${data.projectedGrowth}%增长率预测10年，折现率${data.discountRate}%，永续增长率${data.perpetualGrowth}%。
        企业价值 = 10年现金流折现 + 终值折现。股权价值 = 企业价值 + 货币资金 - 短期借款 - 长期借款。</p>
      </div>
    `;
  },

  // Section 25: Top 10 Shareholders
  // data: { holders: top10 list, stats: { institutionCount, institutionRatio, topHoldersEndDate, note } }
  renderShareholders(data) {
    const chart = this.get('deepShareholders');
    const el = document.getElementById('deepShareholders');
    if (!chart || !el) return;
    const holders = Array.isArray(data) ? data : (data && data.holders || []);
    const stats = (!Array.isArray(data) && data && data.stats) ? data.stats : null;
    if (!holders || holders.length === 0) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂未获取到前十大股东数据。</div>';
      return;
    }
    // 渲染饼图
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
    // 在图表容器后追加机构统计说明
    let noteId = 'shareholderStatsNote';
    let noteEl = document.getElementById(noteId);
    if (!noteEl) {
      noteEl = document.createElement('div');
      noteEl.id = noteId;
      noteEl.className = 'sh-stats-note';
      el.parentNode.insertBefore(noteEl, el.nextSibling);
    }
    if (stats) {
      noteEl.innerHTML = `
        <div class="sh-stats-main">前十大股东中共有 <b>${stats.institutionCount}</b> 家机构，合计占总股本 <b>${(stats.institutionRatio || 0).toFixed(2)}%</b>（报告期：${stats.topHoldersEndDate || '—'}）</div>
        <div class="sh-stats-sub">${stats.note || ''}</div>
      `;
    } else {
      noteEl.innerHTML = '<div class="sh-stats-sub">注：饼图展示前十大股东各自占总股本比例；机构家数统计需 shareholderStats 数据。</div>';
    }
  },

  // Section 22b: Dividend yield trend (10y) with mean ± 1σ reference lines
  renderDividendYield(data) {
    const chart = this.get('deepDivYield');
    const analysisEl = document.getElementById('deepDivYieldAnalysis');
    if (!chart) return;
    if (!data || !data.series || data.series.length === 0) {
      const note = (data && data.note) ? data.note : '暂无可用的股息率数据';
      if (analysisEl) analysisEl.innerHTML = `<div class="dy-note dy-empty">⚠️ ${note}</div>`;
      return;
    }
    const years = data.series.map(d => d.year);
    const values = data.series.map(d => d.yield);
    const s = data.stats || { mean: 0, std: 0, high: 0, low: 0 };
    // 参考线配色：均值灰 / +1σ 绿(高分红) / -1σ 红(低分红) —— 用户指定语义（非价格涨跌色）
    const cMean = '#95a5a6', cHigh = '#5cb85c', cLow = '#e74c3c';
    chart.setOption({
      tooltip: { trigger: 'axis', formatter: (ps) => {
        const p = ps[0];
        const rec = data.series.find(r => r.year === p.axisValue);
        let tip = `${p.axisValue}年 股息率 <b>${p.value}%</b>`;
        if (rec) tip += `<br/>全年分红 ${rec.dividendAmount} 亿 · 年报发布日市值 ${rec.marketCap} 亿<br/>（发布日 ${rec.publishDate || '—'} · 收盘价 ${rec.close} 元${rec.basis === 'yearend' ? ' · 年末价兜底' : ''}）`;
        return tip;
      } },
      legend: { data: ['股息率', '均值', '高分红线(+1σ)', '低分红线(-1σ)'], top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: years, axisLabel: { rotate: years.length > 8 ? 35 : 0 } },
      yAxis: { type: 'value', name: '股息率(%)' },
      series: [
        { name: '股息率', type: 'line', data: values, smooth: true, symbolSize: 7,
          itemStyle: { color: '#7fa8c9' }, lineStyle: { width: 3 },
          label: { show: true, formatter: (p) => p.value != null ? p.value.toFixed(2) : '', position: 'top' } },
        { name: '均值', type: 'line', data: years.map(() => s.mean), smooth: false, symbol: 'none',
          lineStyle: { type: 'dashed', color: cMean, width: 1.5 }, itemStyle: { color: cMean } },
        { name: '高分红线(+1σ)', type: 'line', data: years.map(() => s.high), smooth: false, symbol: 'none',
          lineStyle: { type: 'dashed', color: cHigh, width: 1.5 }, itemStyle: { color: cHigh } },
        { name: '低分红线(-1σ)', type: 'line', data: years.map(() => s.low), smooth: false, symbol: 'none',
          lineStyle: { type: 'dashed', color: cLow, width: 1.5 }, itemStyle: { color: cLow } },
      ],
    });

    // ---- 文字分析：公司 vs 行业均值 / 主要险企排名 ----
    if (analysisEl) {
      const cur = data.current && data.current.yield ? data.current.yield : null;
      const latest = data.latest;
      const band = s.std > 0 ? `（历史区间 ${s.low}% ~ ${s.high}%，±1σ）` : '';
      let html = `<div class="dy-note">`;
      html += `<div class="dy-line">📈 <b>近10年股息率</b>：均值 <b>${s.mean}%</b>${band}；标准差 ${s.std}%。`;
      if (latest) html += ` 最新可得年份（${latest.year}）股息率 <b>${latest.yield}%</b>（全年分红 ${latest.dividendAmount} 亿 ÷ 年报发布日 ${latest.publishDate} 市值 ${latest.marketCap} 亿${latest.basis === 'yearend' ? '，发布日缺失改用年末收盘价' : ''}）。历史年度股息率统一按「公司公告全年分红金额 ÷ 年报发布日公司市值」计算。`;
      html += `</div>`;
      if (cur != null) {
        const vsMean = (cur - s.mean);
        const cmp = vsMean >= 0 ? `高于` : `低于`;
        const curMC = data.current && data.current.marketCap ? `（当前市值约 ${data.current.marketCap} 亿）` : '';
        html += `<div class="dy-line">💡 <b>当前股息率</b>（最近12个月实际分红(TTM) ÷ <b>当前公司市值</b>${curMC}）：<b>${cur}%</b>，${cmp}近10年均值 ${Math.abs(vsMean).toFixed(2)} 个百分点`;
        if (latest && Math.abs(cur - latest.yield) >= 0.3) {
          html += `（${latest.year} 年历史口径分母=年报发布日市值，与当前市值不同，导致两者不可直接相减对比）`;
        }
        html += `。</div>`;
      }
      // 行业对比
      const ind = data.industry;
      if (ind && ind.peers && ind.peers.length) {
        html += `<div class="dy-line">🏦 <b>保险行业对比</b>：行业（主要 ${ind.total} 家险企）当前平均股息率 <b>${ind.avg}%</b>；`;
        if (ind.companyRank > 0) html += `中国平安以 <b>${cur != null ? cur : (ind.peers.find(p=>p.isSelf)||{}).yield || '--'}%</b> 排名第 <b>${ind.companyRank}/${ind.total}</b>。`;
        html += `</div>`;
        html += `<div class="dy-peers"><span class="dy-peers-title">主要险企当前股息率排名：</span>`;
        html += ind.peers.map((p, i) => {
          const cls = p.isSelf ? 'dy-peer self' : 'dy-peer';
          const hl = p.isSelf ? ' ★' : '';
          return `<span class="${cls}">${i + 1}. ${p.name} ${p.yield}%${hl}</span>`;
        }).join('');
        html += `</div>`;
      } else if (ind === null) {
        html += `<div class="dy-line dy-sub">（行业对比暂仅支持保险行业标的；其他行业可参考上方10年走势自身评估）</div>`;
      }
      if (data.note) html += `<div class="dy-line dy-sub">※ ${data.note}</div>`;
      html += `</div>`;
      analysisEl.innerHTML = html;
    }
  },

  // ---- 估值数据卡片（vc-card）渲染 —— 规则版结论与 AI 估值共用（20260905k 单一来源）----
  // sum: { overallRating, currentPrice, fairValueRange:[lo,hi], fairValueCenter, methodsUsed:[] }
  // 样式即用户确认的图一布局：评级徽章 + 当前股价 + 综合合理估值区间定位条 + 估值方法 chips
  renderValuationCardHTML(sum, livePrice) {
    // 20260906：当前股价一律用工作台头部权威实时价（livePrice）覆盖摘要自带价（单一权威源铁律），无效时回退原值
    const _live = (livePrice != null && isFinite(Number(livePrice)) && Number(livePrice) > 0) ? Number(livePrice) : null;
    const displayPrice = _live != null ? _live : Number(sum.currentPrice);
    const ratingColors = {
      '低估': { bg: 'rgba(246,70,93,0.12)', border: 'rgba(246,70,93,0.45)', text: '#F6465D' },
      '合理': { bg: 'rgba(150,160,180,0.12)', border: 'rgba(150,160,180,0.35)', text: '#aab2c0' },
      '偏高': { bg: 'rgba(14,203,129,0.12)', border: 'rgba(14,203,129,0.40)', text: '#2fbf82' },
      '高估': { bg: 'rgba(14,203,129,0.14)', border: 'rgba(14,203,129,0.50)', text: '#0ECB81' },
      '数据不足': { bg: 'rgba(139,147,156,0.10)', border: 'rgba(139,147,156,0.35)', text: '#8B949E' },
    };
    const fmt2 = v => (v != null && v !== '' && !isNaN(v) && isFinite(v)) ? Number(v).toFixed(2) : '--';
    // 20260905k：评级词模糊归档（AI 可能输出"合理偏低"等复合词，按关键词命中取语义色，徽章仍显示原词）
    const ratingKey = ['高估', '偏高', '低估', '合理'].find(k => String(sum.overallRating || '').includes(k)) || '数据不足';
    const c = ratingColors[ratingKey] || ratingColors['数据不足'];

    // ---- 估值区间定位条 ----
    let rangeHTML = '';
    const lo = sum.fairValueRange ? Number(sum.fairValueRange[0]) : NaN;
    const hi = sum.fairValueRange ? Number(sum.fairValueRange[1]) : NaN;
    if (isFinite(lo) && isFinite(hi) && hi - lo > 0.005) {
      const price = displayPrice;
      const center = Number(sum.fairValueCenter);
      const pct = (p) => Math.max(0, Math.min(100, (p - lo) / (hi - lo) * 100));
      const pricePct = (isFinite(price) && price > 0) ? pct(price) : null;
      const centerPct = (isFinite(center) && center > 0) ? pct(center) : null;
      const posTxt = pricePct == null ? '' : (price >= hi ? '当前价已越过区间上沿' : price <= lo ? '当前价已跌破区间下沿' : `当前价位于区间 ${pricePct.toFixed(0)}% 分位`);
      rangeHTML = `
        <div class="vc-range">
          <div class="vc-range-head">
            <span class="vc-range-label">综合合理估值区间</span>
            <span class="vc-range-note">${posTxt}${centerPct != null ? ` · 中枢 ¥${fmt2(center)}` : ''}</span>
          </div>
          <div class="vc-range-track">
            <div class="vc-range-fill" style="width:${pricePct == null ? 0 : pricePct}%;"></div>
            ${centerPct != null ? `<div class="vc-range-center" style="left:${centerPct}%;" title="中枢 ¥${fmt2(center)}"></div>` : ''}
            ${pricePct != null ? `<div class="vc-range-dot" style="left:${pricePct}%;border-color:${c.text};" title="当前价 ¥${fmt2(price)}"></div>` : ''}
          </div>
          <div class="vc-range-scale">
            <span>¥${fmt2(lo)}</span>
            <span>¥${fmt2(hi)}</span>
          </div>
        </div>`;
    }

    const methodsHTML = (sum.methodsUsed || []).map(m => `<span class="vc-method-chip">${m}</span>`).join('');

    return `
      <div class="vc-card">
        <div class="vc-header">
          <div class="vc-rating-wrap">
            <span class="vc-rating-label">综合估值评级</span>
            <span class="vc-rating-chip" style="background:${c.bg};border-color:${c.border};color:${c.text};"><i style="background:${c.text};"></i>${sum.overallRating || '数据不足'}</span>
          </div>
          <div class="vc-price">
            <span class="vc-price-label">当前股价</span>
            <span class="vc-price-value">¥${fmt2(displayPrice)}</span>
          </div>
        </div>
        ${rangeHTML}
        ${methodsHTML ? `
        <div class="vc-methods">
          <span class="vc-methods-label">估值方法</span>
          <div class="vc-methods-list">${methodsHTML}</div>
        </div>` : ''}
      </div>`;
  },

  // Render valuation conclusion panel
  renderConclusion(data) {
    const el = document.getElementById('deepConclusion');
    if (!el || !data) return;
    // 20260906：AI 估值视图已激活时不抢视图（单按钮口径：打开自动展示已保存的 AI 融合估值，
    // 深度分析数据后到不得把视图打回规则版旧模型），仅静默更新规则版内容；切股残留由 selectStock 重置兜底
    const _aiBody = document.getElementById('valuationAiBody');
    const aiActive = !!(_aiBody && _aiBody.style.display !== 'none' && _aiBody.innerHTML.trim() !== '');
    // 20260902i 重设计：中性炭黑卡面，语义色只出现在评级徽章与价格锚点（消除大面积色块），
    // 新增"估值区间定位条"直观展示当前价在综合合理区间中的位置
    // 20260905k：vc-card 渲染提取为 renderValuationCardHTML（与 AI 估值共用，单一来源）

    // 20260905j：各估值方法小卡片行（如「PE估值带」）已按需求删除——方法信息已在结论文本中完整呈现，避免重复展示

    el.innerHTML = this.renderValuationCardHTML(data) +
      `<div class="conclusion-text">${(data.conclusionText || '').split('\n').map(l => `<p>${l}</p>`).join('')}</div>`;
    el.style.display = aiActive ? 'none' : '';
  },

  // Render trend prediction panel
  // 20260903h：深度分析页已彻底移除技术面模块（走势预判/技术指标信号/操作建议），
  // 技术分析统一保留在技术面分析页，避免跨页数据口径不一致。

  // ---- 公司类型分类渲染 ----
  renderCompanyType(ct) {
    const panel = document.getElementById('deepCompanyType');
    if (!panel || !ct) return;

    // 20260902i 重设计：卡面统一中性炭黑，类型色（低饱和金/蓝/青/灰）仅用于
    // 左强调线、图标底与标题——公司类型是身份标识而非涨跌信号，与红涨绿跌语义解耦
    const typeColors = {
      growth: { accent: '#7fa8c9', tint: 'rgba(127,168,201,0.14)' },
      value: { accent: '#cdab74', tint: 'rgba(205,171,116,0.14)' },
      dividend: { accent: '#6fb0a4', tint: 'rgba(111,176,164,0.14)' },
      balanced: { accent: '#aab2c0', tint: 'rgba(150,160,180,0.14)' },
    };
    const c = typeColors[ct.type] || typeColors.balanced;
    const cd = ct.classificationData || {};

    const labels = {
      revenueGrowth: '营收增速', ps: '市销率', profitGrowth: '利润增速',
      pe: '市盈率', roe: 'ROE', pb: '市净率', netMargin: '净利率',
      dividendYield: '股息率', dividendYears: '分红年限', payoutRatio: '派息率',
    };
    const metricsHTML = (ct.keyMetrics || []).map(km =>
      `<span class="ct-metric-tag">${labels[km] || km}</span>`).join('');

    const statDefs = [
      { label: '总市值', value: cd.marketCap != null ? `${cd.marketCap}亿` : '--' },
      { label: 'PE', value: cd.pe != null ? cd.pe : '--' },
      { label: '股息率', value: cd.dividendYield != null ? `${cd.dividendYield}%` : '--' },
      { label: '营收增速', value: cd.revenueGrowth != null ? `${cd.revenueGrowth}%` : '--' },
      { label: 'ROE', value: cd.roe != null ? `${cd.roe}%` : '--' },
      { label: '分红年限', value: cd.dividendYears != null ? `${cd.dividendYears}年` : '--' },
    ];
    const statsHTML = statDefs.map(s =>
      `<div class="ct-stat"><span class="ct-stat-label">${s.label}</span><span class="ct-stat-value">${s.value}</span></div>`).join('');

    panel.innerHTML = `
      <div class="company-type-card" style="--ct-accent:${c.accent};--ct-tint:${c.tint};">
        <div class="ct-header">
          <span class="ct-icon">${ct.typeIcon}</span>
          <div class="ct-title">
            <span class="ct-name">${ct.typeName}</span>
            <p class="ct-desc">${ct.description || ''}</p>
          </div>
        </div>
        ${metricsHTML ? `
        <div class="ct-focus">
          <span class="ct-focus-label">分析重点</span>
          <div class="ct-metrics">${metricsHTML}</div>
        </div>` : (ct.focusText ? `<div class="ct-focus"><span class="ct-focus-label">分析重点</span><span class="ct-focus-text">${ct.focusText}</span></div>` : '')}
        <div class="ct-data">${statsHTML}</div>
      </div>
    `;
  },

  // ---- 本地资料库文档渲染 ----
  renderLocalDocs(docs) {
    const panel = document.getElementById('deepLocalDocs');
    if (!panel) return;
    
    if (!docs || !docs.documents || docs.documents.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    
    panel.classList.remove('hidden');
    
    const typeIcons = { annual: '📋', quarterly: '📅', announcement: '📢', research: '📊', other: '📄' };
    const typeLabels = { annual: '年报', quarterly: '季报', announcement: '公告', research: '研报', other: '其他' };
    
    const docsHTML = docs.documents.map(d => `
      <div class="local-doc-item">
        <span class="doc-icon">${typeIcons[d.type] || '📄'}</span>
        <div class="doc-info">
          <div class="doc-title">${d.title || d.fileName}</div>
          <div class="doc-meta">
            <span class="doc-type-tag">${typeLabels[d.type] || d.type}</span>
            ${d.year ? `<span>${d.year}年</span>` : ''}
            <span>${(d.fileSize / 1024).toFixed(0)}KB</span>
          </div>
        </div>
        <a href="/api/docs/download/${d.id}" class="doc-download-btn" target="_blank">下载</a>
      </div>
    `).join('');
    
    panel.innerHTML = `
      <div class="local-docs-card">
        <div class="local-docs-header">
          <h3>📁 本地资料库（${docs.count}份文档）</h3>
          <span class="local-docs-hint">历史数据已从本地资料库加载，避免重复联网获取</span>
        </div>
        <div class="local-docs-list">${docsHTML}</div>
      </div>
    `;
  },

  // ---- 结论 + 论证过程 渲染 ----
  // 将「总结 + 查看论证」块追加到图表的卡片容器内。
  attachConclusion(chartId, concl) {
    if (!concl) return;
    const chartEl = document.getElementById(chartId);
    if (!chartEl) return;
    const container = chartEl.closest('.chart-card') || chartEl.parentElement;
    this._injectConclusion(container, concl);
  },

  // 将结论块追加到指定面板容器本身（如估值结论、走势预判面板）
  attachConclusionToPanel(panelId, concl) {
    if (!concl) return;
    const el = document.getElementById(panelId);
    if (!el) return;
    this._injectConclusion(el, concl);
  },

  _injectConclusion(container, concl) {
    if (!container) return;
    const prev = container.querySelector(':scope > .section-conclusion');
    if (prev) prev.remove();

    const hasReasoning = Array.isArray(concl.reasoning) && concl.reasoning.length > 0;
    const wrap = document.createElement('div');
    wrap.className = 'section-conclusion';
    let html = `<div class="sc-summary"><span class="sc-icon">📌</span><span>${concl.conclusion || ''}</span></div>`;
    if (hasReasoning) {
      html += `<button type="button" class="sc-toggle">查看论证过程 ▾</button>`;
      html += `<div class="sc-reasoning hidden">${concl.reasoning.map(r => `<div class="sc-reason-item">• ${r}</div>`).join('')}</div>`;
    }
    wrap.innerHTML = html;
    container.appendChild(wrap);

    if (hasReasoning) {
      const btn = wrap.querySelector('.sc-toggle');
      const re = wrap.querySelector('.sc-reasoning');
      btn.addEventListener('click', () => {
        const hidden = re.classList.toggle('hidden');
        btn.textContent = hidden ? '查看论证过程 ▾' : '收起论证过程 ▴';
      });
    }
  },

  // ---- 重大财务变化 AI 归因说明 ----
  // 把检测到的重大同比变化及其 AI 解释，追加到对应图表卡片内。
  attachChangeNotes(changeAnalysis) {
    if (!changeAnalysis || !changeAnalysis.hasChanges || !changeAnalysis.analyses) return;
    const analyses = changeAnalysis.analyses.filter(a => a && a.explanation);
    if (!analyses.length) return;

    // 按 chartId 分组
    const byChart = {};
    analyses.forEach(a => {
      const id = a.chartId || 'unknown';
      if (!byChart[id]) byChart[id] = [];
      byChart[id].push(a);
    });

    Object.keys(byChart).forEach(chartId => {
      const chartEl = document.getElementById(chartId);
      if (!chartEl) return;
      const container = chartEl.closest('.chart-card') || chartEl.parentElement;
      if (!container) return;
      // 避免重复渲染
      const prev = container.querySelector(':scope > .change-analysis-notes');
      if (prev) prev.remove();

      const items = byChart[chartId];
      const wrap = document.createElement('div');
      wrap.className = 'change-analysis-notes';
      let html = '<div class="ca-title">🔍 重大变化 AI 归因</div>';
      items.forEach(item => {
        const direction = item.changePct > 0 ? '上升' : '下降';
        const arrow = item.changePct > 0 ? '↗' : '↘';
        const noteTag = item.note ? `<span class="ca-tag">${item.note}</span>` : '';
        html += `
          <div class="ca-item">
            <div class="ca-header">
              <span class="ca-metric">${item.metric}</span>
              <span class="ca-pct ${item.changePct > 0 ? 'up' : 'down'}">${arrow} ${Math.abs(item.changePct).toFixed(2)}%</span>
              ${noteTag}
            </div>
            <div class="ca-summary">${item.year}年 ${item.current}${item.unit}，较${item.prevYear}年${direction}（${item.previous}${item.unit} → ${item.current}${item.unit}）</div>
            <div class="ca-explanation">${item.explanation.replace(/\n/g, '<br>')}</div>
            ${item.explanationSource === 'cached' ? '<div class="ca-source">来源：历史留存分析</div>' : '<div class="ca-source">来源：AI 联网归因</div>'}
          </div>
        `;
      });
      wrap.innerHTML = html;
      container.appendChild(wrap);
    });
  },

  // ---- 第4/5节：分产品 / 分地区 主营构成（近5年折线）----
  // 对最新一年若仅有部分报告期（如一季报/中报/三季报），使用 TTM 滚动累计还原全年口径：
  // TTM = 当年部分 + 上年年报 - 上年同期部分，确保与历史年报口径可比。
  _getSegmentItemsWithTTM(seg, year, key) {
    const base = seg.byYear[year] && seg.byYear[year][key] ? seg.byYear[year][key] : [];
    const all = seg.allPeriods;
    if (!all || year !== seg.years[seg.years.length - 1]) return { items: base, isTTM: false };
    const yearData = all[year];
    if (!yearData || !yearData[key]) return { items: base, isTTM: false };
    const periods = yearData[key].slice().sort((a, b) => (b.reportDate || '').localeCompare(a.reportDate || ''));
    const latest = periods[0];
    if (!latest || latest.stage === 'FY') return { items: base, isTTM: false };
    const prevYear = String(parseInt(year, 10) - 1);
    const prevData = all[prevYear];
    if (!prevData || !prevData[key]) return { items: base, isTTM: false };
    const prevFY = prevData[key].find(p => p.stage === 'FY');
    const prevSame = prevData[key].find(p => p.stage === latest.stage);
    if (!prevFY || !prevSame) return { items: base, isTTM: false };
    const ttmItems = [];
    for (const cur of latest.items) {
      const fy = prevFY.items.find(i => i.name === cur.name);
      const same = prevSame.items.find(i => i.name === cur.name);
      if (!fy || !same) continue;
      const income = cur.income + fy.income - same.income;
      const cost = cur.cost + fy.cost - same.cost;
      ttmItems.push({
        ...cur,
        income,
        cost,
        grossMargin: income > 0 ? Math.round((1 - cost / income) * 10000) / 100 : null,
        reportName: (cur.reportName || latest.reportName || '') + ' (TTM)',
      });
    }
    return ttmItems.length ? { items: ttmItems, isTTM: true, reportName: latest.reportName } : { items: base, isTTM: false };
  },

  _renderSegment(elId, seg, typeFilter) {
    const el = document.getElementById(elId);
    if (!el) return;
    if (!seg || !seg.byYear || seg.years.length === 0) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂未获取到该维度的历史构成数据（数据源未提供）。建议结合公司年报「主营业务构成」章节审阅。</div>';
      return;
    }
    const sampleYear = seg.years[seg.years.length - 1];
    const displayYears = seg.years.slice(-5); // 仅展示最近 5 个报告期年份，规避口径频繁切换造成的大量断层
    const types = Object.keys(seg.byYear[sampleYear] || {});
    const key = types.find(t => t.includes(typeFilter)) || (typeFilter === '产品' ? types.find(t => !t.includes('地区') && !t.includes('行业')) : types.find(t => t.includes('地区') || t.includes('内') || t.includes('外')));
    if (!key) {
      el.innerHTML = '<div class="data-empty">⚠️ 该维度（' + typeFilter + '）构成数据暂无。</div>';
      return;
    }
    // 按年取数（最新一年优先 TTM）
    const yearItems = {};
    let hasTTM = false;
    for (const y of displayYears) {
      const r = this._getSegmentItemsWithTTM(seg, y, key);
      yearItems[y] = r.items;
      if (r.isTTM) hasTTM = true;
    }
    const nameSet = new Set();
    displayYears.forEach(y => (yearItems[y] || []).forEach(p => p.name && nameSet.add(p.name)));
    const names = Array.from(nameSet).slice(0, 8);
    if (names.length === 0) {
      el.innerHTML = '<div class="data-empty">⚠️ 该维度构成数据为空。</div>';
      return;
    }
    const palette = ['#7fa8c9', '#cf8e8e', '#8fb89a', '#cdab74', '#a99bc4', '#6fb0a4', '#f97316', '#94a3b8'];
    const series = names.map((n, i) => ({
      name: n,
      type: 'line', smooth: true,
      itemStyle: { color: palette[i % palette.length] },
      data: displayYears.map(y => {
        const item = (yearItems[y] || []).find(p => p.name === n);
        return item ? Math.round((item.income || 0) / 1e8 * 100) / 100 : 0;
      }),
    }));
    el.innerHTML = '';
    // 口径变化提示（仅当父容器内尚无提示时追加，避免重复）
    let note = el.parentElement && el.parentElement.querySelector(':scope > .segment-note');
    if (!note && el.parentElement) {
      note = document.createElement('div');
      note.className = 'segment-note';
      el.parentElement.appendChild(note);
    }
    if (note) {
      note.textContent = '说明：同一年仅取最新报告期；' +
        (hasTTM ? '最末年已按 TTM 滚动累计还原（当年部分+上年年报-上年同期部分），便于与历史年报口径比较。' : '') +
        '不同年份披露口径可能变化，旧业务名称在新口径年份显示为 0。';
    }
    const chart = this.get(elId);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { type: 'scroll', top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: displayYears },
      yAxis: { type: 'value', name: '亿元' },
      series,
    });
  },

  renderSegmentProduct(seg) { this._renderSegment('deepSegmentProduct', seg, '产品'); },

  // 第5节：分地区收入构成——按用户要求只汇总成「国内 / 国外」两条线，不再按省份细分
  renderSegmentRegion(seg) {
    const elId = 'deepSegmentRegion';
    const el = document.getElementById(elId);
    if (!el) return;
    if (!seg || !seg.byYear || seg.years.length === 0) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂未获取到该维度的历史构成数据（数据源未提供）。建议结合公司年报「主营业务构成」章节审阅。</div>';
      return;
    }
    const sampleYear = seg.years[seg.years.length - 1];
    const displayYears = seg.years.slice(-5); // 仅展示最近 5 个报告期年份
    const types = Object.keys(seg.byYear[sampleYear] || {});
    const key = types.find(t => t.includes('地区')) || types.find(t => t.includes('内') || t.includes('外'));
    if (!key) {
      el.innerHTML = '<div class="data-empty">⚠️ 该维度（地区）构成数据暂无。</div>';
      return;
    }

    const isForeign = (name) => {
      if (!name) return false;
      const n = String(name).toLowerCase();
      const foreignMarks = ['境外', '海外', '国外', '国际', '香港', '澳门', '台湾', '外销', '出口', 'foreign', 'oversea', 'overseas', 'international', 'abroad'];
      return foreignMarks.some(m => n.includes(m));
    };
    const isReconciliation = (name) => {
      if (!name) return false;
      const n = String(name).toLowerCase();
      const skipMarks = ['平衡项目', '抵销', '抵消', '合并', '分部间', '未分配'];
      return skipMarks.some(m => n.includes(m));
    };

    const palette = ['#7fa8c9', '#cdab74'];
    const domesticData = [];
    const foreignData = [];
    let totalForeignRaw = 0;
    for (const y of displayYears) {
      let domestic = 0, foreign = 0;
      for (const p of (seg.byYear[y][key] || [])) {
        if (!p.name || isReconciliation(p.name)) continue;
        const v = (p.income || 0) / 1e8;
        if (isForeign(p.name)) { foreign += v; totalForeignRaw += v; }
        else domestic += v;
      }
      domesticData.push(Math.round(domestic * 100) / 100);
      foreignData.push(Math.round(foreign * 100) / 100);
    }

    // 若公司完全没有国外收入，则不展示「分地区（国内外）」图表（整张卡片隐藏）
    const card = el.closest('.chart-card') || el.parentElement;
    if (totalForeignRaw <= 0) {
      if (card) card.style.display = 'none';
      el.innerHTML = '<div class="data-empty">⚠️ 该公司无国外收入，不展示分地区（国内外）收入构成图表。</div>';
      return;
    }
    if (card) card.style.display = '';

    el.innerHTML = '';
    // 口径变化提示（仅当父容器内尚无提示时追加，避免重复）
    let note = el.parentElement && el.parentElement.querySelector(':scope > .segment-note');
    if (!note && el.parentElement) {
      note = document.createElement('div');
      note.className = 'segment-note';
      note.textContent = '说明：同一年仅取最新报告期；不同年份披露口径可能变化，旧业务名称在新口径年份显示为 0。';
      el.parentElement.appendChild(note);
    }
    const chart = this.get(elId);
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['国内收入', '国外收入'], top: 0 },
      grid: { left: '8%', right: '8%', bottom: '8%', top: '15%' },
      xAxis: { type: 'category', data: displayYears },
      yAxis: { type: 'value', name: '亿元' },
      series: [
        { name: '国内收入', type: 'line', smooth: true, itemStyle: { color: palette[0] }, data: domesticData },
        { name: '国外收入', type: 'line', smooth: true, itemStyle: { color: palette[1] }, data: foreignData },
      ],
    });
  },

  // ---- 第4节补充：细分产品 / 业务毛利率（营收占比 · 成本占比 · 毛利率）----
  renderProductGrossMargin(data) {
    const el = document.getElementById('deepProductMargin');
    if (!el) return;
    if (!data || !data.items || data.items.length === 0) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂未获取到细分产品/业务毛利率数据（数据源未提供主营构成明细）。建议结合公司年报「主营业务构成」章节审阅。</div>';
      return;
    }
    const gmColor = (gm) => {
      if (gm == null) return 'var(--text-secondary)';
      if (gm >= 40) return '#2e9e6b';   // 高毛利：盈利强
      if (gm >= 20) return '#c9a227';   // 中毛利
      return '#c0563f';                 // 低毛利：盈利弱
    };
    const fmtPct = (v) => (v == null ? '—' : v.toFixed(2) + '%');
    const fmtYi = (v) => (v == null ? '—' : v.toFixed(2));
    const maxGm = Math.max(1, ...data.items.map(i => i.grossMargin || 0));
    const rows = data.items.map((it) => {
      const gm = it.grossMargin;
      const barW = gm == null ? 0 : Math.max(3, Math.round((gm / maxGm) * 100));
      return `<tr>
        <td class="gm-name">${this.escapeHtml(it.name)}</td>
        <td class="num">${fmtYi(it.incomeYi)}</td>
        <td class="num">${fmtPct(it.incomeRatio)}</td>
        <td class="num">${fmtYi(it.costYi)}</td>
        <td class="num">${fmtPct(it.costRatio)}</td>
        <td class="num gm-cell">
          <div class="gm-val" style="color:${gmColor(gm)}">${fmtPct(gm)}</div>
          ${gm == null ? '' : `<span class="gm-bar"><i style="width:${barW}%;background:${gmColor(gm)}"></i></span>`}
        </td>
      </tr>`;
    }).join('');

    // 整体毛利率（仅当各项均披露成本时才有意义）
    const hasCost = data.items.length > 0 && data.items.every(p => p.costYi != null);
    const overallGm = (hasCost && data.totalIncomeYi > 0)
      ? Math.round((1 - data.totalCostYi / data.totalIncomeYi) * 10000) / 100
      : null;

    el.innerHTML = `
      <div class="mx-table-wrap">
        <table class="mx-table product-margin-table">
          <thead><tr>
            <th>${this.escapeHtml(data.dimension || '产品/业务分部')}</th>
            <th class="num">营业收入(亿)</th>
            <th class="num">营收占比</th>
            <th class="num">营业成本(亿)</th>
            <th class="num">成本占比</th>
            <th class="num">毛利率</th>
          </tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr>
            <td>整体（合计）</td>
            <td class="num">${fmtYi(data.totalIncomeYi)}</td>
            <td class="num">100.00%</td>
            <td class="num">${fmtYi(data.totalCostYi)}</td>
            <td class="num">${hasCost ? '100.00%' : '—'}</td>
            <td class="num gm-cell"><div class="gm-val" style="color:${gmColor(overallGm)}">${fmtPct(overallGm)}</div></td>
          </tr></tfoot>
        </table>
      </div>
      <div class="metrics-period-note">数据来源：${this.escapeHtml(data.source || '东方财富 F10 主营构成')} · 报告期：${this.escapeHtml(data.period || '')}。毛利率 =（营业收入 − 营业成本）÷ 营业收入；金融/保险企业按东财主营构成口径列示，仅供业务结构参考。</div>
    `;
  },

  // ---- 第24节：近一年券商研报（AI 联网搜索后总结）----
  renderResearchReports(ai, symbol, stockName) {
    const el = document.getElementById('deepResearchReports');
    if (!el) return;
    const key = 'research_' + symbol;
    // 优先使用已缓存的 AI 结果（切换股票回来后仍可直接显示，无需重新联网）
    if ((!ai || !ai.summary) && this._aiCache && this._aiCache[key]) ai = this._aiCache[key];
    const hasSummary = ai && typeof ai.summary === 'string' && ai.summary.trim().length > 0;
    if (!hasSummary) {
      el.innerHTML = this._aiLoadingPlaceholder('研报');
      this._triggerAi('research', symbol, stockName);
      return;
    }
    const dateStr = ai.date ? new Date(ai.date).toISOString().slice(0, 10) : '';
    // 事实截止日期（规则一·日期标注）：本地事实模式展示数据对应时间，而非仅分析时间
    const factDate = ai.factMaxDate ? String(ai.factMaxDate).slice(0, 10) : '';
    const dateLabel = (ai.mode === 'local' && factDate) ? `${factDate}（分析于 ${dateStr}）` : dateStr;
    // 过期标注（规则二·第4条）：本地事实抓取失败兜底过期缓存时，必须明确提示
    const lastUpdate = factDate || (ai.fetchedAt ? String(ai.fetchedAt).slice(0, 10) : '') || dateStr;
    const staleNote = ai.stale ? `⚠️ 本地事实已过期（最后更新 ${lastUpdate}），点击「重新总结」可重新抓取最新数据` : '';
    // 20260903f：local=基于本地事实库纯推理（不联网、零搜索费），web-fallback=联网检索
    const modeHead = ai.mode === 'local' ? 'AI 本地事实总结' : 'AI 联网总结';
    const modeFoot = ai.mode === 'local' ? 'AI 基于本地预下载研报列表生成（不联网）' : 'AI 联网生成';
    el.innerHTML = `<div class="mx-summary">
      <div class="mx-summary-head">🤖 ${modeHead} · 近一年券商研报</div>
      <div class="mx-summary-body">${this.escapeHtmlMulti(ai.summary)}</div>
      <div class="mx-summary-foot">来源：${modeFoot}${dateLabel ? '（' + dateLabel + '）' : ''}${ai.model ? ' · ' + this.escapeHtml(ai.model) : ''}</div>
      ${staleNote ? `<div class="mx-stale-note">${staleNote}</div>` : ''}
      <button class="ai-trigger-btn" data-ai-type="research">🔄 重新总结</button>
    </div>`;
    this._bindAiTrigger(el, 'research', symbol, stockName);
  },

  // 将文本转成带换行的 HTML（保留段落）
  escapeHtmlMulti(text) {
    if (!text) return '';
    const esc = String(text).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return esc.split(/\n+/).map(p => p.trim()).filter(Boolean).map(p => `<p>${p}</p>`).join('');
  },

  escapeHtml(text) {
    if (text == null) return '';
    return String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },

  // 占位：后台自动生成中
  _aiLoadingPlaceholder(label) {
    return `<div class="ai-empty ai-loading">🤖 正在后台联网生成「${label}」总结（约 10-45 秒，可切换页面，完成后自动显示）…</div>`;
  },

  _aiNoKeyPlaceholder() {
    return `<div class="data-empty">尚未配置 AI API Key，无法联网。请先在「⚙️ AI 设置」中配置（通义千问 / 智谱 GLM / OpenAI 均可，需支持联网搜索），再点击「🔄 重新联网总结」。</div>`;
  },

  _aiErrorPlaceholder(type, symbol, stockName, msg) {
    return `<div class="data-empty">联网总结失败：${this.escapeHtml(msg)}<br><br>
      <button class="ai-trigger-btn" data-ai-type="${type}">🔄 重试</button></div>`;
  },

  // 20260903f 降费：静默预热本地事实库（研报/公告/概况/主营预下载），不产生任何 LLM 费用；
  // 每只股票会话内只预热一次，失败静默（下次打开深度页会再试）
  _prefetchFacts(symbol) {
    if (!symbol) return;
    this._factsPrefetched = this._factsPrefetched || {};
    if (this._factsPrefetched[symbol]) return;
    this._factsPrefetched[symbol] = true;
    fetch('/api/ai/prefetch-facts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, stockName: this._stockName || '' }),
    }).catch(() => { this._factsPrefetched[symbol] = false; });
  },

  // 研报/公告：手动或自动触发 AI 联网总结；带 inflight 去重与股票生命周期保护
  _triggerAi(type, symbol, stockName, force) {
    if (!symbol) return;
    const elKey = type + '_' + symbol;
    this._aiInflight = this._aiInflight || {};
    if (this._aiInflight[elKey]) return; // 已在请求，避免重复
    const el = type === 'research' ? document.getElementById('deepResearchReports')
      : type === 'earnings' ? document.getElementById('deepEarningsReport')
      : document.getElementById('deepAnnouncements');
    if (!el) return;
    this._aiInflight[elKey] = true;
    const label = type === 'research' ? '研报' : type === 'earnings' ? '最新财报解读' : '公告';
    const name = stockName || (window.App && App.currentData && App.currentData.name) || '';
    el.innerHTML = this._aiLoadingPlaceholder(label);
    const done = () => { this._aiInflight[elKey] = false; };
    fetch('/api/ai/' + type, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, stockName: name, industry: '', force: !!force }),
    })
      .then(r => r.json())
      .then(data => {
        done();
        if (data && data.success && data.summary) {
          this._aiCache = this._aiCache || {};
          this._aiCache[elKey] = data;
          if (this._symbol === symbol) {
            if (type === 'research') this.renderResearchReports(data, symbol, stockName);
            else if (type === 'earnings') this.renderEarningsReport(data, symbol, stockName);
            else this.renderAnnouncements(data, symbol, stockName);
          }
        } else if (data && !data.success && data.error === 'NO_KEY') {
          el.innerHTML = this._aiNoKeyPlaceholder();
        } else {
          el.innerHTML = this._aiErrorPlaceholder(type, symbol, stockName, (data && (data.message || data.error)) || '未知错误');
        }
      })
      .catch(e => {
        done();
        el.innerHTML = this._aiErrorPlaceholder(type, symbol, stockName, e.message);
      });
  },

  // ---- 第25节：近一年重要公告（AI 联网搜索后总结）----
  // 数据格式（来自 AI）：{ summary, sources, date, model }
  renderAnnouncements(ai, symbol, stockName) {
    const el = document.getElementById('deepAnnouncements');
    if (!el) return;
    const key = 'announcements_' + symbol;
    if ((!ai || !ai.summary) && this._aiCache && this._aiCache[key]) ai = this._aiCache[key];
    const hasSummary = ai && typeof ai.summary === 'string' && ai.summary.trim().length > 0;
    if (!hasSummary) {
      el.innerHTML = this._aiLoadingPlaceholder('公告');
      this._triggerAi('announcements', symbol, stockName);
      return;
    }
    const dateStr = ai.date ? new Date(ai.date).toISOString().slice(0, 10) : '';
    // 事实截止日期（规则一·日期标注）：本地事实模式展示数据对应时间，而非仅分析时间
    const factDate = ai.factMaxDate ? String(ai.factMaxDate).slice(0, 10) : '';
    const dateLabel = (ai.mode === 'local' && factDate) ? `${factDate}（分析于 ${dateStr}）` : dateStr;
    // 过期标注（规则二·第4条）：本地事实抓取失败兜底过期缓存时，必须明确提示
    const lastUpdate = factDate || (ai.fetchedAt ? String(ai.fetchedAt).slice(0, 10) : '') || dateStr;
    const staleNote = ai.stale ? `⚠️ 本地事实已过期（最后更新 ${lastUpdate}），点击「重新总结」可重新抓取最新数据` : '';
    // 20260903f：local=基于本地事实库纯推理（不联网、零搜索费），web-fallback=联网检索
    const modeHead = ai.mode === 'local' ? 'AI 本地事实总结' : 'AI 联网总结';
    const modeFoot = ai.mode === 'local' ? 'AI 基于本地预下载公告列表生成（不联网）' : 'AI 联网生成';
    el.innerHTML = `<div class="mx-summary">
      <div class="mx-summary-head">🤖 ${modeHead} · 近一年重要公告</div>
      <div class="mx-summary-body">${this.escapeHtmlMulti(ai.summary)}</div>
      <div class="mx-summary-foot">来源：${modeFoot}${dateLabel ? '（' + dateLabel + '）' : ''}${ai.model ? ' · ' + this.escapeHtml(ai.model) : ''}</div>
      ${staleNote ? `<div class="mx-stale-note">${staleNote}</div>` : ''}
      <button class="ai-trigger-btn" data-ai-type="announcements">🔄 重新总结</button>
    </div>`;
    this._bindAiTrigger(el, 'announcements', symbol, stockName);
  },

  // 绑定「重新联网总结 / 重试」按钮
  _bindAiTrigger(container, type, symbol, stockName) {
    const btn = container.querySelector('.ai-trigger-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      this._triggerAi(type, symbol, stockName, true);
    });
  },

  // ---- 财报解读结构化解析与高亮（20260902k）----
  // 利好红 #F6465D / 利空绿 #0ECB81（与全站涨跌色一致）；
  // 关键词用单遍正则 + 长短语优先，避免「增长」吞掉「增长放缓」这类语义反转
  _ER_NEG_WORDS: ['增速放缓', '增长放缓', '边际走弱', '边际向下', '低于预期', '不及预期', '拐点向下', '增长率下降', '降幅扩大', '恶化', '下滑', '承压', '走弱', '减弱', '回落', '收窄', '下降', '下行', '亏损', '转负', '放缓', '压力', '隐忧', '风险', '盲区', '误导'],
  _ER_POS_WORDS: ['超预期', '边际向上', '拐点向上', '加速', '改善', '回升', '向好', '提升', '增长', '高增', '亮眼', '新高', '转正', '韧性', '支撑', '积极'],

  _earningsParse(text) {
    const out = { signal: null, verdict: null, sections: [], intro: [] };
    if (!text) return out;
    let cur = null;
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      let m = line.match(/^综合信号[：:]\s*([+-]?\d+)/);
      if (m) { out.signal = parseInt(m[1], 10); continue; }
      m = line.match(/^综合结论[：:]\s*(.+)$/);
      if (m) { out.verdict = m[1].trim(); continue; }
      m = line.match(/^(\d)\s*[)）]\s*([^：:]+)[：:]?\s*(.*)$/);
      if (m) {
        cur = { idx: m[1], title: m[2].trim(), lines: [] };
        if (m[3] && m[3].trim()) cur.lines.push(m[3].trim());
        out.sections.push(cur);
        continue;
      }
      (cur ? cur.lines : out.intro).push(line);
    }
    return out;
  },

  _earningsHighlight(safe) {
    if (!safe) return '';
    let s = safe;
    // 1) 弱化来源/引用括注，突出重点
    s = s.replace(/（[^（）]*(?:来源：东方财富F10财报|资料库PDF：|数据时间)[^（）]*）/g, m => '<span class="er-cite">' + m + '</span>');
    // 2) 关键词高亮（单遍替换，长短语优先）
    const map = {};
    const words = [];
    this._ER_NEG_WORDS.forEach(w => { map[w] = 'neg'; words.push(w); });
    this._ER_POS_WORDS.forEach(w => { map[w] = 'pos'; words.push(w); });
    words.sort((a, b) => b.length - a.length);
    const kwRe = new RegExp('(' + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g');
    s = s.replace(kwRe, m => '<span class="er-kw er-kw-' + map[m] + '">' + m + '</span>');
    // 3) 数字高亮：带符号百分比按正负着色；亿元/个百分点中性强调
    s = s.replace(/([+-]?)(\d+(?:\.\d+)?)(%|亿元|个百分点)/g, (m0, sign) => {
      const cls = sign === '+' ? 'pos' : sign === '-' ? 'neg' : 'num';
      return '<span class="er-num er-num-' + cls + '">' + m0 + '</span>';
    });
    return s;
  },

  // ---- 最新财报解读（AI 联网，最新一季度财报/季报/业绩预告分析）----
  // 数据格式（来自 AI）：{ summary, sources, date, model }
  renderEarningsReport(ai, symbol, stockName) {
    const el = document.getElementById('deepEarningsReport');
    if (!el) return;
    const key = 'earnings_' + symbol;
    if ((!ai || !ai.summary) && this._aiCache && this._aiCache[key]) ai = this._aiCache[key];
    const hasSummary = ai && typeof ai.summary === 'string' && ai.summary.trim().length > 0;
    if (!hasSummary) {
      el.innerHTML = this._aiLoadingPlaceholder('最新财报解读');
      this._triggerAi('earnings', symbol, stockName);
      return;
    }
    const dateStr = ai.date ? new Date(ai.date).toISOString().slice(0, 10) : '';
    // 20260904b：标的身份徽标 + 串公司告警（联网解读声明 vs 当前股票）
    const tgtBadge = (ai.earningsTarget && ai.earningsTarget.raw)
      ? '<span class="er-target" title="本次解读标的（AI 联网检索声明）">🏷️ 标的：' + this.escapeHtml(ai.earningsTarget.raw) + '</span>'
      : '';
    const tgtWarn = ai.targetMismatch
      ? '<div class="er-mismatch">⚠️ ' + this.escapeHtml(ai.targetWarn || '解读标的与当前股票不符，疑似串公司') + '</div>'
      : '';
    // 20260831h：标题由实际报告期驱动，避免三级标题重复。
    // 分组标题（group-earnings）已固定为「📑 财报解读」，此处仅更新卡片级 h3 为具体报告期。
    const titleEl = document.getElementById('deepEarningsReportTitle');
    const period = ai.reportPeriod ? String(ai.reportPeriod).trim() : '';
    const nameTag = stockName || ai.stockName || symbol;
    if (period) {
      if (titleEl) titleEl.textContent = '📑 ' + nameTag + ' · ' + period + '分析';
    } else {
      if (titleEl) titleEl.textContent = '📑 ' + nameTag + ' 最新财报解读';
    }
    // 移除内部二级标题，直接把解读正文、来源与重算按钮平铺展示
    // 20260902j：来源标签按实际模式展示——local = 本地模型+本地财报数据（含资料库同期PDF节选），
    // web-fallback = 本地数据缺失降级联网检索
    const srcLabel = ai.mode === 'local'
      ? 'AI 本地解读（本地财报数据' + (ai.localDocName ? ' + 资料库同期PDF：' + this.escapeHtml(ai.localDocPeriod || '') + ' ' + this.escapeHtml(ai.localDocName) : '') + '）'
      : 'AI 联网生成' + (ai.stockName ? '（已联网核实 ' + this.escapeHtml(ai.stockName) + '）' : '');
    // 20260902k：结构化渲染——信号横幅（利好红/利空绿）+ 分节正文 + 关键词/数字行内高亮
    const parsed = this._earningsParse(ai.summary);
    const sigVal = parsed.signal != null ? parsed.signal
      : (typeof ai.earningsSignal === 'number' && isFinite(ai.earningsSignal)
        ? Math.max(-3, Math.min(3, Math.round(ai.earningsSignal * 3))) : null);
    const sem = sigVal == null ? 'flat' : (sigVal > 0 ? 'pos' : sigVal < 0 ? 'neg' : 'flat');
    const semLabel = sem === 'pos' ? '利好' : sem === 'neg' ? '利空' : '中性';
    const sigText = sigVal == null ? '' : (sigVal > 0 ? '+' + sigVal : String(sigVal));
    const banner = (parsed.verdict || sigVal != null)
      ? '<div class="er-signal er-signal-' + sem + '">' +
          (sigVal == null ? '' : '<span class="er-badge er-badge-' + sem + '"><i class="er-dot"></i>' + semLabel + ' ' + sigText + '</span>') +
          (parsed.verdict ? '<div class="er-verdict">' + this._earningsHighlight(this.escapeHtml(parsed.verdict)) + '</div>' : '') +
        '</div>'
      : '';
    const itemHtml = l => {
      if (/^注[：:]/.test(l)) return '<div class="er-note">' + this._earningsHighlight(this.escapeHtml(l)) + '</div>';
      if (/^[-•·]\s+/.test(l)) return '<div class="er-item">' + this._earningsHighlight(this.escapeHtml(l.replace(/^[-•·]\s+/, ''))) + '</div>';
      return '<div class="er-para">' + this._earningsHighlight(this.escapeHtml(l)) + '</div>';
    };
    let bodyHtml;
    if (parsed.sections.length) {
      // 「再次总结」与横幅结论重复时跳过，避免同页重复
      const norm = t => String(t || '').replace(/[\s，。、；;：:（）()\-—]/g, '');
      const verdictNorm = norm(parsed.verdict);
      const secs = parsed.sections.filter(sec => {
        if (!/再次总结/.test(sec.title) || !verdictNorm) return true;
        const a = norm(sec.lines.join(''));
        return !(a.includes(verdictNorm) || verdictNorm.includes(a));
      });
      bodyHtml = parsed.intro.map(itemHtml).join('') + banner + secs.map(sec => {
        const sSem = /亮点|积极/.test(sec.title) ? 'pos' : (/风险|隐忧/.test(sec.title) ? 'neg' : '');
        return '<div class="er-section">' +
          '<div class="er-sec-head er-sec-' + sSem + '"><span class="er-sec-chip">' + this.escapeHtml(sec.idx) + '</span><span class="er-sec-title">' + this.escapeHtml(sec.title) + '</span></div>' +
          sec.lines.map(itemHtml).join('') +
        '</div>';
      }).join('');
    } else {
      bodyHtml = banner + String(ai.summary).split(/\n+/).map(p => p.trim()).filter(Boolean)
        .map(p => '<div class="er-para">' + this._earningsHighlight(this.escapeHtml(p)) + '</div>').join('');
    }
    el.innerHTML = `<div class="er-wrap">
      ${tgtWarn}
      <div class="er-head">${tgtBadge}</div>
      ${bodyHtml}
      <div class="mx-summary-foot">来源：${srcLabel}${dateStr ? '（' + dateStr + '）' : ''}${ai.model ? ' · ' + this.escapeHtml(ai.model) : ''}</div>
      <button class="ai-trigger-btn" data-ai-type="earnings">🔄 重新解读</button>
    </div>`;
    this._bindAiTrigger(el, 'earnings', symbol, stockName);
  },

  // Render all deep analysis charts
  renderAll(sections, symbol, stockName) {
    this._symbol = symbol || this._symbol;
    this._stockName = stockName || this._stockName;
    if (!sections) {
      console.warn('DeepCharts.renderAll: 无 sections 数据');
      return;
    }
    // 20260903f 降费：打开深度页时静默预热本地事实库（研报/公告/概况/主营免费预下载到 SQLite，
    // 后续 AI 分析走不联网模型纯推理）；fire-and-forget，不阻塞渲染，同一股票会话内只预热一次
    this._prefetchFacts(this._symbol);
    // 每个分节独立 try/catch：任一分节渲染失败都不会导致整页空白
    const safe = (label, fn) => { try { fn(); } catch (e) { console.error('DeepCharts 渲染失败 [' + label + ']:', e); } };

    // 20260905j：公司类型/分析重点行已按需求删除（估值区合并为单模块），renderCompanyType 保留但不再调用
    // safe('companyType', () => this.renderCompanyType(sections.companyClassification));
    safe('localDocs', () => this.renderLocalDocs(sections.localDocuments));
    safe('segmentProduct', () => this.renderSegmentProduct(sections.segmentData));
    safe('segmentRegion', () => this.renderSegmentRegion(sections.segmentData));
    safe('productGrossMargin', () => this.renderProductGrossMargin(sections.productGrossMargin));
    safe('researchReports', () => this.renderResearchReports(sections.researchAI, this._symbol, this._stockName));
    safe('announcements', () => this.renderAnnouncements(sections.announcementAI, this._symbol, this._stockName));
    safe('earningsReport', () => this.renderEarningsReport(sections.earningsReport, this._symbol, this._stockName));
    safe('conclusion', () => this.renderConclusion(sections.conclusion));
    safe('revenueCost', () => this.renderRevenueCost(sections.revenueCostData));
    safe('roeMarginTrend', () => this.renderRoeMarginTrend(sections.roeMarginTrend));
    safe('shortTermRisk', () => this.renderShortTermRisk(sections.shortTermRisk));
    safe('assetComp', () => this.renderAssetComp(sections.assetComposition));
    safe('liabComp', () => this.renderLiabComp(sections.liabilityComposition));
    safe('revVsCash', () => this.renderRevVsCash(sections.cashFlowData));
    safe('revVsMC', () => this.renderMarketCapCompare('deepRevVsMC', sections.marketCapData, '营业总收入', 'revenue', '市值'));
    safe('profitVsMC', () => this.renderMarketCapCompare('deepProfitVsMC', sections.marketCapData, '归母净利润', 'netProfit', '市值'));
    safe('navVsMC', () => this.renderMarketCapCompare('deepNAVVsMC', sections.marketCapData, '净资产', 'netAssets', '市值'));
    safe('profitVsCash', () => this.renderProfitVsCash(sections.cashFlowData));
    safe('revVsCost', () => this.renderRevVsCost(sections.revenueCostData));
    safe('revVsExp', () => this.renderRevVsExp(sections.expenseData));
    safe('growth', () => this.renderGrowth(sections.growth, sections.revenueCostData));
    safe('payable', () => this.renderPayable(sections.payableData));
    safe('valuationPE', () => this.renderValuation('deepPE', sections.valuation, 'PE'));
    safe('valuationPB', () => this.renderValuation('deepPB', sections.valuation, 'PB'));
    safe('valuationPS', () => this.renderValuation('deepPS', sections.valuation, 'PS'));
    safe('dividend', () => this.renderDividend(sections.dividendData));
    safe('dividendBar', () => this.renderDividendBar(sections.dividendPayouts));
    safe('dcf', () => this.renderDCF(sections.dcf));
    safe('divYield', () => this.renderDividendYield(sections.dividendYieldData));
    // Insurance-specific rendering
    safe('insuranceAnalysis', () => this.renderInsuranceAnalysis(sections.insuranceAnalysis));

    // ---- 结论 + 论证过程（先总结，点击展开论证）----
    const C = sections._conclusions || {};
    safe('concl-revenueCost', () => this.attachConclusion('deepRevenueCost', C.revenueCost));
    safe('concl-asset', () => this.attachConclusion('deepAssetComp', C.asset));
    safe('concl-liability', () => this.attachConclusion('deepLiabComp', C.liability));
    safe('concl-revVsCash', () => this.attachConclusion('deepRevVsCash', C.cashFlow));
    safe('concl-revVsMC', () => this.attachConclusion('deepRevVsMC', C.marketCapRevenue));
    safe('concl-profitVsMC', () => this.attachConclusion('deepProfitVsMC', C.marketCapProfit));
    safe('concl-navVsMC', () => this.attachConclusion('deepNAVVsMC', C.marketCapNav));
    safe('concl-profitVsCash', () => this.attachConclusion('deepProfitVsCash', C.profitVsCash));
    safe('concl-revVsCost', () => this.attachConclusion('deepRevVsCost', C.revVsCost));
    safe('concl-revVsExp', () => this.attachConclusion('deepRevVsExp', C.revVsExp));
    safe('concl-growth', () => this.attachConclusion('deepGrowth', C.growth));
    safe('concl-payable', () => this.attachConclusion('deepPayable', C.payable));
    safe('concl-valuationPE', () => this.attachConclusion('deepPE', C.valuationPE));
    safe('concl-valuationPB', () => this.attachConclusion('deepPB', C.valuationPB));
    safe('concl-valuationPS', () => this.attachConclusion('deepPS', C.valuationPS));
    safe('concl-dividend', () => this.attachConclusion('deepDividend', C.dividend));
    safe('concl-dcf', () => this.attachConclusion('deepDCF', C.dcf));
    safe('concl-divYield', () => this.attachConclusion('deepDivYield', C.divYield));
    safe('concl-shortTermRisk', () => this.attachConclusion('deepShortTermRisk', C.balance));
    safe('concl-segmentProduct', () => this.attachConclusion('deepSegmentProduct', C.segmentProduct));
    safe('concl-segmentRegion', () => this.attachConclusion('deepSegmentRegion', C.segmentRegion));
    safe('concl-productMargin', () => this.attachConclusion('deepProductMargin', C.productMargin));
    // 保险公司专属结论
    safe('concl-premium', () => this.attachConclusion('deepPremiumTrend', C.premium));
    safe('concl-combinedRatio', () => this.attachConclusion('deepCombinedRatio', C.combinedRatio));
    safe('concl-investmentYield', () => this.attachConclusion('deepInvestmentYield', C.investmentYield));
    safe('concl-nbv', () => this.attachConclusion('deepNBV', C.nbv));
    safe('concl-insuranceProfit', () => this.attachConclusion('deepProfitComparison', C.insuranceProfit));
    safe('concl-pev', () => this.attachConclusion('deepPEV', C.pev));
    safe('concl-ddm', () => this.attachConclusion('deepDDM', C.ddm));
    safe('concl-businessLife', () => this.attachConclusion('deepLifeTrend', C.businessLife));
    safe('concl-businessProperty', () => this.attachConclusion('deepPropertyTrend', C.businessProperty));
    safe('concl-businessPension', () => this.attachConclusion('deepPensionTrend', C.businessPension));
    safe('concl-businessHealth', () => this.attachConclusion('deepHealthTrend', C.businessHealth));
    // C.margin（毛利率/净利率）无独立图表容器，暂不单列结论；
    // deepConclusion 面板已在各自 render 中完整展示结论文本，
    // 若再 attach 会重复出现同一段结论，故此处不再向该面板追加结论块。

    // ---- 重大变化 AI 归因（追加到对应图表卡片）----
    safe('changeAnalysis', () => this.attachChangeNotes(sections.changeAnalysis));
  },

  // ---- 保险公司分析渲染 ----
  renderInsuranceAnalysis(insurance) {
    const panel = document.getElementById('deepInsuranceAnalysis');
    const pevCard = document.getElementById('deepPEV')?.closest('.chart-card');
    const ddmCard = document.getElementById('deepDDM')?.closest('.chart-card');
    if (!panel) return;

    if (!insurance || !insurance.isInsurance) {
      panel.classList.add('hidden');
      if (pevCard) pevCard.classList.add('hidden');
      if (ddmCard) ddmCard.classList.add('hidden');
      return;
    }

    panel.classList.remove('hidden');
    // 同时取消外层分组的隐藏，使保险公司专属分析可见
    const group = document.getElementById('group-insurance');
    if (group) group.style.display = '';
    const s = insurance.sections;
    
    // Premium trend
    this.renderPremiumTrend(s.premiumAnalysis);
    // Premium pie chart
    this.renderPremiumPie(s.premiumAnalysis);
    // NBV
    this.renderNBV(s.nbvAnalysis);
    // Combined ratio
    this.renderCombinedRatio(s.combinedRatioAnalysis);
    // Investment yield
    this.renderInvestmentYield(s.investmentYieldAnalysis);
    // Profit comparison
    this.renderProfitComparison(s.profitDivergence);
    // P/EV
    this.renderPEV(s.pevValuation);
    // DDM
    this.renderDDM(s.ddmValuation);

    // 分业务趋势（寿险 / 财产险 / 养老险 / 健康险 / NBV）
    const bl = s.businessLines || {};
    const isPingAn = insurance.symbol === '601318';
    this.renderBusinessLineTrend('deepLifeTrend', bl.life, {
      name: '寿险（寿险及健康险板块）', legend: '保费收入(亿)',
      caption: '数据口径：集团年报分业务披露（2014–2016 为「人寿保险」，2017 起为「寿险及健康险」合并披露，含健康险）。2023 年因准则/口径调整明显回落，2024–2025 恢复增长。',
    });
    this.renderBusinessLineTrend('deepPropertyTrend', bl.property, {
      name: '财产保险（平安产险）', legend: '保费收入(亿)',
      caption: '数据口径：集团年报分业务披露。财产险 2014–2025 稳健扩张，2022–2023 综合成本率上行致增速放缓，2024–2025 恢复。',
    });
    this.renderBusinessLineTrend('deepPensionTrend', bl.pension, {
      name: '养老险（平安养老）', legend: '保险业务收入(亿)',
      caption: isPingAn
        ? '数据口径：平安养老原保险保费收入公告 / 年报 / 偿付能力报告（子公司口径）。2013–2020 高速增长后，受监管压降个人养老保障产品及转型影响，2021 起连续回落；2025 年保险业务收入 99.70 亿元，同比继续下滑。'
        : '养老险数据需各公司单独披露；当前仅接入中国平安(601318)的养老险真实值，其它保险股暂未接入，显示「暂无数据」。',
    });
    this.renderBusinessLineTrend('deepHealthTrend', bl.health, {
      name: '健康险（平安健康）', legend: '保险业务收入(亿)',
      caption: isPingAn
        ? '数据口径：平安健康原保险保费收入公告 / 年报 / 偿付能力报告（子公司口径）。规模较小但增速较快，2023 小幅回落、2024 回升 +14.9%；2025 年保险业务收入 195.40 亿元，同比增长约 16.0%。'
        : '健康险数据需各公司单独披露；当前仅接入中国平安(601318)的健康险真实值，其它保险股暂未接入，显示「暂无数据」。',
    });
    // NBV 使用独立的季度趋势图（deepNBV），不再由分业务趋势覆盖
  },

  renderPremiumTrend(data) {
    const chart = this.get('deepPremiumTrend');
    if (!chart || !data || !data.yearlyData) return;
    
    // TTM 口径说明（仅当年份含 TTM 估算时显示，避免 2026 中报累计值被误读为全年）
    const noteEl = document.getElementById('deepPremiumTrendNote');
    if (noteEl) {
      const ttmNotes = (data.yearlyData || []).filter(d => d.ttm && d.note).map(d => `${d.year}：${d.note}`);
      noteEl.textContent = ttmNotes.length
        ? '口径：' + ttmNotes.join('；') + '。其余年份为年报原值，可跨年直接比较。'
        : '';
    }
    
    const years = data.yearlyData.map(d => d.year);
    const premiums = data.yearlyData.map(d => d.total);
    const growths = data.yearlyData.map(d => d.yoyGrowth || 0);
    
    chart.setOption({
      tooltip: {
        trigger: 'axis',
        formatter: (ps) => {
          let s = ps[0].axisValue + '<br/>';
          ps.forEach(p => {
            if (p.value == null) return;
            const isPct = p.seriesName.indexOf('%') >= 0;
            const v = isPct
              ? (p.value >= 0 ? '+' : '') + p.value.toFixed(2) + '%'
              : p.value.toFixed(2) + '亿';
            s += `${p.marker}${p.seriesName}: ${v}<br/>`;
          });
          return s;
        },
      },
      legend: { data: ['保费收入(亿)', '同比增长(%)'] },
      grid: { left: '8%', right: '8%', bottom: '10%' },
      xAxis: { type: 'category', data: years },
      yAxis: [
        { type: 'value', name: '保费(亿)' },
        { type: 'value', name: '增长(%)', axisLabel: { formatter: '{value}%' } },
      ],
      series: [
        { name: '保费收入(亿)', type: 'bar', data: premiums, itemStyle: { color: '#7fa8c9' } },
        { name: '同比增长(%)', type: 'line', yAxisIndex: 1, data: growths, itemStyle: { color: '#cdab74' }, smooth: true },
      ],
    });
  },

  renderPremiumPie(data) {
    const chart = this.get('deepPremiumPie');
    if (!chart) return;

    const noteEl = document.getElementById('deepPremiumPieNote');
    if (noteEl) noteEl.textContent = '';

    if (!data || !data.typeBreakdown || data.typeBreakdown.length === 0) {
      chart.setOption({
        title: { text: data?.note || '暂无险种结构数据', left: 'center', top: 'center', textStyle: { color: '#8b939c', fontSize: 14 } },
        series: [],
      }, { notMerge: true });
      return;
    }

    chart.setOption({
      tooltip: {
        trigger: 'item',
        formatter: (p) => {
          const actual = p.data && p.data.actualValue != null ? `${p.data.actualValue}亿 · ` : '';
          return `${p.name}<br/>${actual}占比 ${p.percent}%`;
        },
      },
      legend: { orient: 'vertical', right: 10, top: 'center' },
      series: [{
        type: 'pie',
        radius: ['40%', '70%'],
        center: ['40%', '50%'],
        data: data.typeBreakdown.map(t => ({ name: t.name, value: t.value, actualValue: t.value })),
        label: { formatter: '{b}\n{d}%' },
      }],
    }, { notMerge: true });

    if (noteEl) {
      const parts = [];
      if (data.compositionSource) parts.push(`来源：${data.compositionSource}`);
      if (data.compositionNote) parts.push(data.compositionNote);
      noteEl.textContent = parts.join(' · ');
    }
  },

  renderNBV(data) {
    const chart = this.get('deepNBV');
    if (!chart) return;

    const noteEl = document.getElementById('deepNBVNote');
    if (!data || !data.hasData) {
      chart.setOption({
        title: { text: data?.note || '暂无NBV数据', left: 'center', top: 'center', textStyle: { color: '#8b939c', fontSize: 14 } },
        series: [],
      }, { notMerge: true });
      if (noteEl) noteEl.textContent = '';
      return;
    }

    const labels = data.data.map(d => d.label || d.year);
    const quarterVals = data.data.map(d => d.value);
    const cumVals = data.data.map(d => d.cumulative != null ? d.cumulative : d.value);
    // TTM 滚动序列，与常见行情软件口径一致
    const ttmMap = new Map((data.ttmSeries || []).map(t => [t.label, t.value]));
    const ttmVals = labels.map(lab => ttmMap.get(lab) ?? null);

    // 计算累计 NBV 的同比增速（同比：与去年同季度累计比较）
    const yoy = data.data.map((d, i) => {
      const prevIdx = i - 4; // 往前推 4 个季度
      if (prevIdx >= 0 && cumVals[prevIdx] > 0) {
        return round2((cumVals[i] - cumVals[prevIdx]) / cumVals[prevIdx] * 100);
      }
      return null;
    });

    // x 轴标签：仅在 Q1（年报起点）显示完整年份，其余隐藏，避免 26 个季度标签重叠
    const isYearStart = (lab) => lab && lab.endsWith('Q1');

    chart.setOption({
      tooltip: {
        trigger: 'axis',
        formatter: (ps) => {
          const idx = ps[0].dataIndex;
          const q = data.data[idx];
          let s = '<strong>' + q.label + '</strong><br/>';
          s += ps[0].marker + '当季 NBV: ' + q.value.toFixed(1) + ' 亿<br/>';
          s += ps[1].marker + '累计 NBV: ' + q.cumulative.toFixed(1) + ' 亿<br/>';
          const ttm = ttmVals[idx];
          if (ttm != null) {
            s += '<span style="color:#e6b85c">● TTM 滚动: ' + ttm.toFixed(1) + ' 亿</span><br/>';
          }
          const yv = yoy[idx];
          if (yv != null) {
            const color = yv >= 0 ? '#F6465D' : '#0ECB81';
            const sign = yv >= 0 ? '+' : '';
            s += '<span style="color:' + color + '">累计同比: ' + sign + yv.toFixed(2) + '%</span><br/>';
          }
          return s;
        },
      },
      legend: { data: ['当季NBV(亿)', '累计NBV(亿)', 'TTM滚动(亿)', '累计同比(%)'] },
      grid: { left: '10%', right: '12%', bottom: '16%' },
      xAxis: {
        type: 'category',
        data: labels,
        axisLabel: {
          interval: (idx) => isYearStart(labels[idx]),
          formatter: (val) => val ? val.slice(0, 4) : '',
          hideOverlap: true,
          fontSize: 12,
        },
        axisTick: {
          alignWithLabel: true,
          interval: (idx) => labels[idx] && /(Q1|Q3)$/.test(labels[idx]),
        },
      },
      yAxis: [
        { type: 'value', name: 'NBV(亿)', position: 'left' },
        { type: 'value', name: '同比(%)', position: 'right', axisLabel: { formatter: '{value}%' } },
      ],
      series: [
        { name: '当季NBV(亿)', type: 'bar', data: quarterVals, itemStyle: { color: '#a99bc4' }, yAxisIndex: 0 },
        { name: '累计NBV(亿)', type: 'line', data: cumVals, itemStyle: { color: '#7fa8c9' }, smooth: false, yAxisIndex: 0 },
        {
          name: 'TTM滚动(亿)',
          type: 'line',
          data: ttmVals,
          itemStyle: { color: '#e6b85c' },
          lineStyle: { width: 3 },
          smooth: false,
          yAxisIndex: 0,
          connectNulls: true,
          markPoint: {
            data: [
              { type: 'max', name: '峰值', itemStyle: { color: '#e6b85c' } },
              { type: 'min', name: '谷值', itemStyle: { color: '#e6b85c' } },
            ],
            symbolSize: 40,
            label: { fontSize: 10, color: '#fff' },
          },
        },
        {
          name: '累计同比(%)',
          type: 'line',
          data: yoy,
          itemStyle: { color: '#cdab74' },
          lineStyle: { type: 'dashed' },
          yAxisIndex: 1,
          connectNulls: false,
        },
      ],
    }, { notMerge: true });

    if (noteEl) {
      const parts = [];
      if (data.note) parts.push(data.note);
      if (data.explanation) parts.push(data.explanation);
      noteEl.innerHTML = parts.map(p => `<p>${p}</p>`).join('');
    }
  },

  renderCombinedRatio(data) {
    const chart = this.get('deepCombinedRatio');
    if (!chart) return;

    const noteEl = document.getElementById('deepCombinedRatioNote');
    if (!data || !data.hasData) {
      chart.setOption({ title: { text: '暂无数据', left: 'center', top: 'center', textStyle: { color: '#8b939c' } } });
      if (noteEl) noteEl.textContent = data?.note || '';
      return;
    }

    const benchmark = data.industryBenchmark || 98.5;
    const labels = data.data.map(d => d.label || d.year);

    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['综合成本率', '行业基准'] },
      grid: { left: '10%', right: '8%', bottom: '12%' },
      xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, rotate: 30 } },
      yAxis: { type: 'value', name: '%', max: 120 },
      series: [
        { name: '综合成本率', type: 'line', data: data.data.map(d => d.value), itemStyle: { color: '#cf8e8e' }, smooth: true, label: { show: true, formatter: (p) => (p.value != null ? p.value.toFixed(2) + '%' : '') } },
        { name: '行业基准', type: 'line', data: data.data.map(() => benchmark), itemStyle: { color: '#8b939c', type: 'dashed' } },
      ],
    });
    if (noteEl) noteEl.textContent = data.note || '';
  },

  renderInvestmentYield(data) {
    const chart = this.get('deepInvestmentYield');
    if (!chart) return;

    const noteEl = document.getElementById('deepInvestmentYieldNote');
    if (!data || !data.hasData) {
      chart.setOption({ title: { text: '暂无数据', left: 'center', top: 'center', textStyle: { color: '#8b939c' } } });
      if (noteEl) noteEl.textContent = data?.note || '';
      return;
    }

    const benchmark = data.industryBenchmark || 5.0;
    const labels = data.data.map(d => d.label || d.year);
    const metricName = data.metricName || '投资收益率';

    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: [metricName, '行业基准'] },
      grid: { left: '10%', right: '8%', bottom: '12%' },
      xAxis: { type: 'category', data: labels, axisLabel: { interval: 0, rotate: 30 } },
      yAxis: { type: 'value', name: '%', axisLabel: { formatter: '{value}%' } },
      series: [
        { name: metricName, type: 'line', data: data.data.map(d => d.value), itemStyle: { color: '#8fb89a' }, smooth: true, label: { show: true, formatter: (p) => (p.value != null ? p.value.toFixed(2) + '%' : '') } },
        { name: '行业基准', type: 'line', data: data.data.map(() => benchmark), itemStyle: { color: '#8b939c', type: 'dashed' } },
      ],
    });
    if (noteEl) noteEl.textContent = data.note || '';
  },

  renderProfitComparison(data) {
    const chart = this.get('deepProfitComparison');
    if (!chart || !data || !data.data) return;

    const rows = data.data;
    const years = rows.map(d => d.year);
    // 同比增速：与上一年比较，首年无同比
    const yoyOf = (key) => rows.map((d, i) => {
      if (i === 0) return null;
      const prev = rows[i - 1][key];
      const curr = d[key];
      if (prev == null || curr == null || prev === 0) return null;
      return +(((curr - prev) / prev) * 100).toFixed(2);
    });
    const opYoy = yoyOf('operatingProfit');
    const netYoy = yoyOf('netProfit');

    chart.setOption({
      tooltip: {
        trigger: 'axis',
        formatter: (ps) => {
          let s = ps[0].axisValue + '<br/>';
          ps.forEach(p => {
            if (p.value == null) return;
            const isPct = p.seriesName.indexOf('%') >= 0;
            const v = isPct
              ? (p.value >= 0 ? '+' : '') + p.value.toFixed(2) + '%'
              : p.value.toFixed(2) + '亿';
            s += `${p.marker}${p.seriesName}: ${v}<br/>`;
          });
          return s;
        },
      },
      legend: { data: ['营运利润(亿)', '净利润(亿)', '营运利润同比(%)', '净利润同比(%)'], top: 0 },
      grid: { left: '8%', right: '10%', bottom: '15%', top: '15%' },
      xAxis: { type: 'category', data: years },
      yAxis: [
        { type: 'value', name: '亿' },
        { type: 'value', name: '同比(%)', position: 'right', axisLabel: { formatter: '{value}%' } },
      ],
      series: [
        { name: '营运利润(亿)', type: 'bar', data: rows.map(d => d.operatingProfit || 0), itemStyle: { color: '#7fa8c9' }, barGap: '20%' },
        { name: '净利润(亿)', type: 'bar', data: rows.map(d => d.netProfit || 0), itemStyle: { color: '#8fb89a' } },
        { name: '营运利润同比(%)', type: 'line', yAxisIndex: 1, data: opYoy, itemStyle: { color: '#cdab74' }, lineStyle: { width: 2 }, smooth: true },
        { name: '净利润同比(%)', type: 'line', yAxisIndex: 1, data: netYoy, itemStyle: { color: '#cf8e8e' }, lineStyle: { width: 2 }, smooth: true },
      ],
      graphic: data.trendNote ? [{
        type: 'text',
        right: 10,
        bottom: 10,
        style: { text: data.trendNote.substring(0, 80) + '...', fill: '#8b939c', fontSize: 11 },
      }] : [],
    });
  },

  renderPEV(data) {
    const el = document.getElementById('deepPEV');
    const card = el ? el.closest('.chart-card') : null;
    if (!el) return;
    if (!data) {
      if (card) card.classList.add('hidden');
      return;
    }
    if (card) card.classList.remove('hidden');
    
    let html = '<div class="dcf-grid">';
    html += `<div class="dcf-item"><span class="dcf-label">当前P/EV</span><span class="dcf-value">${data.currentPEV ? data.currentPEV.toFixed(2) : '--'}</span></div>`;
    html += `<div class="dcf-item"><span class="dcf-label">内含价值</span><span class="dcf-value">${data.latestEV ? data.latestEV.toFixed(0) + '亿' : '--'}</span></div>`;
    html += `<div class="dcf-item"><span class="dcf-label">总市值</span><span class="dcf-value">${data.marketCap ? data.marketCap.toFixed(0) + '亿' : '--'}</span></div>`;
    html += `<div class="dcf-item"><span class="dcf-label">评级</span><span class="dcf-value">${data.interpretation ? data.interpretation.substring(0, 20) : '--'}</span></div>`;
    html += '</div>';
    html += `<p class="dcf-detail">${data.interpretation || ''}</p>`;
    if (data.note) html += `<p class="dcf-warn">${data.note}</p>`;
    
    el.innerHTML = html;
  },

  renderDDM(data) {
    const el = document.getElementById('deepDDM');
    const card = el ? el.closest('.chart-card') : null;
    if (!el) return;
    if (!data) {
      if (card) card.classList.add('hidden');
      return;
    }
    if (card) card.classList.remove('hidden');
    
    let html = '<div class="dcf-grid">';
    html += `<div class="dcf-item"><span class="dcf-label">每股股息</span><span class="dcf-value">¥${data.latestDPS ? data.latestDPS.toFixed(2) : '--'}</span></div>`;
    html += `<div class="dcf-item"><span class="dcf-label">内在价值</span><span class="dcf-value">¥${data.intrinsicValue ? data.intrinsicValue.toFixed(2) : '--'}</span></div>`;
    html += `<div class="dcf-item"><span class="dcf-label">当前股价</span><span class="dcf-value">¥${data.currentPrice ? data.currentPrice.toFixed(2) : '--'}</span></div>`;
    html += `<div class="dcf-item"><span class="dcf-label">评级</span><span class="dcf-value">${data.rating || '--'}</span></div>`;
    html += '</div>';
    html += `<p class="dcf-detail">模型: ${data.model || 'DDM'} | 平均增速: ${data.avgGrowth ? data.avgGrowth.toFixed(2) : '--'}% | 折现率: ${data.discountRate || '--'}% | 永续增长: ${data.terminalGrowth || '--'}%</p>`;
    if (data.note) html += `<p class="dcf-warn">${data.note}</p>`;
    
    el.innerHTML = html;
  },

  // ---- 分业务趋势（寿险 / 财产险 / 养老险 / 健康险 / NBV）----
  renderBusinessLineTrend(chartId, series, meta) {
    const chart = this.get(chartId);
    const el = document.getElementById(chartId);
    if (!chart || !el) return;

    if (!series || !series.length) {
      chart.setOption({ title: { text: '暂无数据 / 未单独披露', left: 'center', top: 'center', textStyle: { color: '#8b939c', fontSize: 13 } } });
      return;
    }

    const years = series.map(d => d.year);
    // TTM 年份用橙色高亮，普通年报年份用主色
    const values = series.map(d => d.ttm
      ? { value: d.value, itemStyle: { color: '#e0a458' }, symbolSize: 11 }
      : d.value);
    const growths = series.map(d => (d.yoy !== undefined ? d.yoy : null));
    // 涨红跌绿：同比增长 ≥0 用红色，<0 用绿色
    const yoyColored = growths.map(v => ({
      value: v,
      itemStyle: { color: (v === null) ? '#8b939c' : (v >= 0 ? '#F6465D' : '#0ECB81') },
    }));

    chart.setOption({
      tooltip: {
        trigger: 'axis',
        formatter: (ps) => {
          let s = ps[0].axisValue + '<br/>';
          ps.forEach(p => {
            const v = p.value === null ? '--' : p.value.toFixed(2);
            const unit = p.seriesName.indexOf('%') >= 0 ? '%' : '亿';
            s += `${p.marker}${p.seriesName}: ${v}${unit}<br/>`;
          });
          return s;
        },
      },
      legend: { data: [meta.legend || '收入(亿)', '同比增长(%)'] },
      grid: { left: '8%', right: '8%', bottom: '12%' },
      xAxis: { type: 'category', data: years },
      yAxis: [
        { type: 'value', name: meta.yName || '亿' },
        { type: 'value', name: '增长(%)', axisLabel: { formatter: '{value}%' } },
      ],
      series: [
        {
          name: meta.legend || '收入(亿)', type: 'line', smooth: true, data: values,
          itemStyle: { color: '#5b8fb9' }, lineStyle: { width: 3 },
          label: { show: true, formatter: (p) => (p.value != null ? p.value.toFixed(2) : '') },
          areaStyle: { color: 'rgba(91,143,185,0.08)' },
        },
        {
          name: '同比增长(%)', type: 'line', yAxisIndex: 1, data: yoyColored,
          lineStyle: { type: 'dashed' }, symbol: 'circle', symbolSize: 7,
        },
      ],
    });

    // 注入趋势说明（卡片标题下方）
    const card = el.closest('.chart-card');
    if (card) {
      let note = card.querySelector('.bl-note');
      if (!note) {
        note = document.createElement('div');
        note.className = 'bl-note';
        card.appendChild(note);
      }
      note.innerHTML = this._businessLineSummary(series, meta);
    }
  },

  _businessLineSummary(series, meta) {
    if (series.length < 2) {
      const s = series[0];
      return `<div class="bl-line">${meta.name || ''} ${s.year}：${s.value.toFixed(2)} 亿${meta.unit || ''}。数据样本较少，仅供趋势参考。</div>`;
    }
    const first = series[0], last = series[series.length - 1];
    const yrs = series.length - 1;
    const cagr = (Math.pow(last.value / first.value, 1 / yrs) - 1) * 100;
    const lastYoy = series[series.length - 1].yoy;
    const pts = `${first.year} 的 ${first.value.toFixed(2)} 亿 → ${last.year} 的 ${last.value.toFixed(2)} 亿`;
    const cagrTxt = `年均复合增速约 ${cagr.toFixed(2)}%`;
    const yoyTxt = `最新同比 ${lastYoy != null ? (lastYoy >= 0 ? '+' : '') + lastYoy.toFixed(2) + '%' : '—'}`;
    let html = `<div class="bl-line"><strong>${meta.name || ''}：</strong>${pts}，${cagrTxt}，${yoyTxt}。</div>`;
    const ttmYears = series.filter(d => d.ttm).map(d => d.year);
    if (ttmYears.length) {
      html += `<div class="bl-caption bl-ttm">⚠️ ${ttmYears.join('、')} 年为 TTM 滚动估算（当年已披露报告 + 上一年剩余季度），非年报值，仅供趋势参考。</div>`;
    }
    if (meta.caption) html += `<div class="bl-caption">${meta.caption}</div>`;
    return html;
  },
};