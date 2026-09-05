/**
 * Capital Flow Charts Module
 * 资金量能分析前端渲染
 */
const CapitalCharts = {
  instances: {},

  disposeAll() {
    Object.values(this.instances).forEach(c => { try { c.dispose(); } catch {} });
    this.instances = {};
  },

  renderAll(data) {
    this.disposeAll();

    if (!data) return;

    this.lastData = data;
    this.renderVolumePrice(data.volumeIndicators);
    this.renderMoneyFlow(data.moneyFlow);
    this.renderFlowSummary(data.moneyFlow?.summary, data.moneyFlow?.source);
    this.renderVolIndicators(data.volumeIndicators);
    this.renderOBV(data.volumeIndicators);
    this.renderVR(data.volumeIndicators);
    this.renderVolume(data.volumeIndicators);
    this.renderMargin(data.marginTrading);
    this.renderMarginSummary(data.marginTrading);
    this.renderConclusion(data);
  },

  renderVolumePrice(vi) {
    const el = document.getElementById('capVolumePrice');
    if (!vi || !vi.volumePrice) {
      el.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无数据</p>';
      return;
    }
    const vp = vi.volumePrice;
    const lastDate = vi.series?.dates?.length ? vi.series.dates[vi.series.dates.length - 1] : '';
    const dateNote = lastDate ? `统计截止 ${lastDate} · K线 · 本地计算` : 'K线 · 本地计算';
    // 20260902m：主信号为当日量价口径；涨跌配色红涨绿跌
    const signalClass = {
      '放量上涨': 'cap-positive',
      '量价齐升': 'cap-positive',
      '显著上涨': 'cap-positive',
      '温和上涨': 'cap-positive',
      '缩量上涨': 'cap-negative',
      '地量上涨': 'cap-neutral',
      '放量下跌': 'cap-negative',
      '量价齐跌': 'cap-negative',
      '显著下跌': 'cap-negative',
      '缩量下跌': 'cap-negative',
      '地量下跌': 'cap-negative',
      '温和回调': 'cap-neutral',
      '缩量回调': 'cap-neutral',
      '地量回调': 'cap-neutral',
      '量价平衡': 'cap-neutral',
    };
    const dayPct = typeof vp.dayChangePct === 'number' ? vp.dayChangePct : null;
    const dayPctHtml = dayPct !== null
      ? `<span class="cm-value ${dayPct > 0 ? 'cap-pos' : dayPct < 0 ? 'cap-neg' : ''}">${dayPct > 0 ? '+' : ''}${dayPct.toFixed(2)}%</span>`
      : '<span class="cm-value">--</span>';
    const dayVolRatio = typeof vp.dayVolRatio === 'number' ? vp.dayVolRatio : null;
    el.innerHTML = `
      <div class="cap-signal-box ${signalClass[vp.signal] || ''}">
        <div class="cap-signal-label">量价信号（当日）</div>
        <div class="cap-signal-value">${vp.signal}</div>
        <div class="cap-signal-desc">${vp.description}</div>
      </div>
      <div class="cap-metrics-row">
        <div class="cap-metric"><span class="cm-label">今日涨跌</span>${dayPctHtml}</div>
        <div class="cap-metric"><span class="cm-label">今日量比</span><span class="cm-value ${dayVolRatio !== null && dayVolRatio > 1.2 ? 'cap-pos' : dayVolRatio !== null && dayVolRatio < 0.8 ? 'cap-neg' : ''}">${dayVolRatio !== null ? dayVolRatio.toFixed(2) : '--'}</span></div>
        <div class="cap-metric"><span class="cm-label">20日涨跌日</span><span class="cm-value">${vp.upDays}天/${vp.downDays}天</span></div>
        <div class="cap-metric"><span class="cm-label">20日量价比</span><span class="cm-value ${vp.ratio > 1 ? 'cap-pos' : 'cap-neg'}">${vp.ratio}</span></div>
        <div class="cap-metric"><span class="cm-label">20日净涨跌</span><span class="cm-value ${vp.netChangePct > 0 ? 'cap-pos' : vp.netChangePct < 0 ? 'cap-neg' : ''}">${vp.netChangePct > 0 ? '+' : ''}${vp.netChangePct}%</span></div>
        <div class="cap-metric"><span class="cm-label">量能热度</span><span class="cm-value">${vp.heatLevel || '--'}</span></div>
      </div>
      <div class="cap-date-note">${dateNote}</div>
    `;
  },

  renderMoneyFlow(mf) {
    const el = document.getElementById('capMoneyFlowChart');
    if (!el) return;
    const daily = mf?.daily || [];
    if (daily.length === 0) {
      el.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:40px;">暂无资金流向数据</p>';
      return;
    }

    const isEstimated = mf?.source === 'estimated';
    const sourceBadge = isEstimated
      ? '<span style="display:inline-block;margin-left:8px;padding:2px 8px;border-radius:4px;background:rgba(245,158,11,0.15);color:#cdab74;font-size:11px;">估算数据</span>'
      : '';

    const chart = echarts.init(el, 'softDark');
    this.instances.moneyFlow = chart;

    const dates = daily.map(d => d.date);
    const mainNet = daily.map(d => Math.round(d.mainNet / 1e8 * 100) / 100);
    const largeNet = daily.map(d => Math.round(d.largeNet / 1e8 * 100) / 100);
    const mediumNet = daily.map(d => Math.round(d.mediumNet / 1e8 * 100) / 100);
    const smallNet = daily.map(d => Math.round(d.smallNet / 1e8 * 100) / 100);

    chart.setOption({
      title: isEstimated ? { text: '资金流向（基于量价估算）', left: 'center', top: 2, textStyle: { fontSize: 12, color: '#cdab74' } } : undefined,
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { data: ['主力净流入', '超大/大单', '中单', '小单'], top: 28, left: 'center', itemWidth: 14, itemHeight: 10, textStyle: { fontSize: 11 } },
      grid: { left: '8%', right: '5%', bottom: '10%', top: '24%' },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', name: '亿元', axisLabel: { formatter: '{value}' } },
      series: [
        { name: '主力净流入', type: 'bar', data: mainNet, itemStyle: { color: function(p) { return p.value >= 0 ? '#cf8e8e' : '#8fb89a'; } } },
        { name: '超大/大单', type: 'line', data: largeNet, smooth: true, lineStyle: { width: 1.5 }, itemStyle: { color: '#cdab74' } },
        { name: '中单', type: 'line', data: mediumNet, smooth: true, lineStyle: { width: 1.5 }, itemStyle: { color: '#7fa8c9' } },
        { name: '小单', type: 'line', data: smallNet, smooth: true, lineStyle: { width: 1.5 }, itemStyle: { color: '#8b939c' } },
      ],
    });

    // Add source badge to the section header
    const sectionEl = el.closest('.cap-section');
    if (sectionEl) {
      const titleEl = sectionEl.querySelector('.cap-section-title');
      if (titleEl && !titleEl.querySelector('.source-badge')) {
        const badge = document.createElement('span');
        badge.className = 'source-badge';
        badge.innerHTML = sourceBadge;
        titleEl.appendChild(badge);
      }
    }
  },

  renderFlowSummary(summary, source) {
    const el = document.getElementById('capFlowSummary');
    if (!el) return;
    if (!summary) {
      el.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无数据</p>';
      return;
    }

    const lastDate = summary.recent5?.length ? summary.recent5[summary.recent5.length - 1].date : '';
    const srcText = source === 'estimated' ? '基于K线量价估算' : '东方财富资金流向';
    const dateNote = lastDate ? `截止 ${lastDate} · ${srcText}` : srcText;

    let html = `<div class="cap-date-note">${dateNote}</div>`;
    html += '<div class="cap-table">';
    html += '<div class="cap-table-header"><span>周期</span><span>主力净额</span><span>方向</span></div>';
    for (const [period, data] of Object.entries(summary.summary)) {
      const dirClass = data.direction === '净流入' ? 'cap-pos' : 'cap-neg';
      const periodLabel = { '5d': '近5日', '10d': '近10日', '20d': '近20日', '60d': '近60日' }[period] || period;
      html += `<div class="cap-table-row"><span>${periodLabel}</span><span class="${dirClass}">${data.mainNet > 0 ? '+' : ''}${data.mainNet}亿</span><span class="${dirClass}">${data.direction}</span></div>`;
    }
    html += '</div>';

    html += '<div class="cap-recent-title">最近5日明细</div>';
    html += '<div class="cap-table">';
    html += '<div class="cap-table-header"><span>日期</span><span>主力净额</span><span>方向</span></div>';
    for (const d of summary.recent5) {
      const dirClass = d.direction === '流入' ? 'cap-pos' : 'cap-neg';
      html += `<div class="cap-table-row"><span>${d.date}</span><span class="${dirClass}">${d.mainNet > 0 ? '+' : ''}${d.mainNet}亿</span><span class="${dirClass}">${d.direction}</span></div>`;
    }
    html += '</div>';

    el.innerHTML = html;
  },

  renderVolIndicators(vi) {
    const el = document.getElementById('capVolIndicators');
    if (!el || !vi) {
      el.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无数据</p>';
      return;
    }
    const ind = vi.indicators;
    const lastDate = vi.series?.dates?.length ? vi.series.dates[vi.series.dates.length - 1] : '';
    const dateNote = lastDate ? `截止 ${lastDate} · K线 · 本地计算` : 'K线 · 本地计算';
    const items = [
      { label: 'OBV能量潮', value: this.formatVol(ind.obv), trend: ind.obvTrend, trendClass: ind.obvTrend === '上升趋势' ? 'cap-pos' : ind.obvTrend === '下降趋势' ? 'cap-neg' : '' },
      { label: 'VR容量比率', value: ind.vr || '--', signal: ind.vrSignal, signalClass: ind.vrSignal.includes('多') ? 'cap-pos' : ind.vrSignal.includes('空') ? 'cap-neg' : '' },
      { label: 'MFI资金指数', value: ind.mfi || '--', signal: ind.mfiSignal, signalClass: ind.mfiSignal.includes('流入') || ind.mfiSignal === '超卖' ? 'cap-pos' : ind.mfiSignal.includes('流出') || ind.mfiSignal === '超买' ? 'cap-neg' : '' },
      { label: '5日均量', value: this.formatVol(ind.volMA5) },
      { label: '10日均量', value: this.formatVol(ind.volMA10) },
      { label: '20日均量', value: this.formatVol(ind.volMA20) },
      { label: '量比(3日/20日)', value: ind.volRatio, signalClass: ind.volRatio > 1.5 ? 'cap-pos' : ind.volRatio < 0.5 ? 'cap-neg' : '' },
      { label: '换手率', value: ind.turnover + '%' + (ind.turnoverAvg > 0 ? `（月均${ind.turnoverAvg}%）` : ''), level: ind.turnoverLevel, signalClass: (ind.turnoverRatio != null && ind.turnoverRatio > 1.5) ? 'cap-pos' : (ind.turnoverRatio != null && ind.turnoverRatio < 0.5 ? 'cap-neg' : '') },
    ];

    el.innerHTML = `<div class="cap-date-note">${dateNote}</div>` + items.map(i => `
      <div class="cap-indicator-item">
        <span class="ci-label">${i.label}</span>
        <span class="ci-value ${i.trendClass || i.signalClass || ''}">${i.value}</span>
        ${i.trend ? `<span class="ci-signal ${i.trendClass}">${i.trend}</span>` : ''}
        ${i.signal ? `<span class="ci-signal ${i.signalClass}">${i.signal}</span>` : ''}
        ${i.level ? `<span class="ci-signal">${i.level}</span>` : ''}
      </div>
    `).join('');
  },

  renderOBV(vi) {
    const el = document.getElementById('capOBVChart');
    if (!el || !vi) return;
    const chart = echarts.init(el, 'softDark');
    this.instances.obv = chart;

    const s = vi.series;
    chart.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: '10%', right: '5%', bottom: '10%', top: '10%' },
      xAxis: { type: 'category', data: s.dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { formatter: v => CapitalCharts.formatVol(v) } },
      series: [{
        name: 'OBV', type: 'line', data: s.obv, smooth: true,
        areaStyle: { opacity: 0.1 }, lineStyle: { width: 2, color: '#7fa8c9' },
      }],
    });
  },

  renderVR(vi) {
    const el = document.getElementById('capVRChart');
    if (!el || !vi) return;
    const chart = echarts.init(el, 'softDark');
    this.instances.vr = chart;

    const s = vi.series;
    chart.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: '10%', right: '5%', bottom: '10%', top: '10%' },
      xAxis: { type: 'category', data: s.dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { formatter: '{value}' } },
      series: [{
        name: 'VR', type: 'line', data: s.vr, smooth: true,
        lineStyle: { width: 2, color: '#cdab74' },
        markLine: {
          data: [
            { yAxis: 200, lineStyle: { color: '#cf8e8e', type: 'dashed' }, label: { formatter: '超买200' } },
            { yAxis: 80, lineStyle: { color: '#8fb89a', type: 'dashed' }, label: { formatter: '超卖80' } },
          ],
        },
      }],
    });
  },

  renderVolume(vi) {
    const el = document.getElementById('capVolumeChart');
    if (!el || !vi) return;
    const chart = echarts.init(el, 'softDark');
    this.instances.volume = chart;

    const s = vi.series;
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['成交量', 'MA5', 'MA10', 'MA20'], top: 0 },
      grid: { left: '8%', right: '5%', bottom: '10%', top: '15%' },
      xAxis: { type: 'category', data: s.dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { formatter: v => CapitalCharts.formatVol(v) } },
      series: [
        { name: '成交量', type: 'bar', data: s.volumes, itemStyle: { color: '#7fa8c9', opacity: 0.5 } },
        { name: 'MA5', type: 'line', data: s.volMA5, smooth: true, lineStyle: { width: 1.5, color: '#cf8e8e' } },
        { name: 'MA10', type: 'line', data: s.volMA10, smooth: true, lineStyle: { width: 1.5, color: '#cdab74' } },
        { name: 'MA20', type: 'line', data: s.volMA20, smooth: true, lineStyle: { width: 1.5, color: '#a99bc4' } },
      ],
    });
  },

  renderMargin(margin) {
    const el = document.getElementById('capMarginChart');
    if (!el) return;
    if (!margin || !margin.hasData) {
      el.innerHTML = (margin && margin.degraded)
        ? '<p style="color:var(--text-secondary);text-align:center;padding:40px;">融资融券数据获取超时（数据源响应慢），已降级跳过，其余维度正常。</p>'
        : '<p style="color:var(--text-secondary);text-align:center;padding:40px;">该股票暂无融资融券数据（可能非融资融券标的）</p>';
      return;
    }

    const chart = echarts.init(el, 'softDark');
    this.instances.margin = chart;

    const data = margin.data;
    const dates = data.map(d => d.tradeDate);
    const rzBalance = data.map(d => Math.round(d.rzBalance / 1e8 * 100) / 100);
    const rqBalance = data.map(d => Math.round(d.rqBalance / 1e8 * 100) / 100);

    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['融资余额(亿)', '融券余额(亿)'], top: 0 },
      grid: { left: '8%', right: '5%', bottom: '10%', top: '15%' },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { formatter: '{value}' } },
      series: [
        { name: '融资余额(亿)', type: 'bar', data: rzBalance, itemStyle: { color: '#cf8e8e', opacity: 0.7 } },
        { name: '融券余额(亿)', type: 'line', data: rqBalance, smooth: true, lineStyle: { width: 2, color: '#8fb89a' } },
      ],
    });
  },

  renderMarginSummary(margin) {
    const el = document.getElementById('capMarginSummary');
    if (!el) return;
    if (!margin || !margin.hasData) {
      el.innerHTML = (margin && margin.degraded)
        ? '<p style="color:var(--text-secondary);text-align:center;padding:20px;">融资融券数据获取超时，已降级（不影响资金量能/资金热度评分）</p>'
        : '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无融资融券数据</p>';
      return;
    }
    const l = margin.latest;
    const lastDate = margin.data?.length ? margin.data[margin.data.length - 1].tradeDate : '';
    const dateNote = lastDate ? `截止 ${lastDate} · 东方财富融资融券` : '东方财富融资融券';
    const rzChangeClass = l.rzChange > 0 ? 'cap-pos' : l.rzChange < 0 ? 'cap-neg' : '';
    const rzNetBuyClass = l.rzNetBuy > 0 ? 'cap-pos' : l.rzNetBuy < 0 ? 'cap-neg' : '';
    const items = [
      { label: '融资余额', value: (l.rzBalance / 1e8).toFixed(2) + '亿', change: l.rzChange >= 0 ? '+' + (l.rzChange / 1e8).toFixed(2) + '亿' : (l.rzChange / 1e8).toFixed(2) + '亿', changeClass: rzChangeClass },
      { label: '融资买入额', value: (l.rzBuy / 1e8).toFixed(2) + '亿' },
      { label: '融资净买入', value: (l.rzNetBuy / 1e8).toFixed(2) + '亿', signalClass: rzNetBuyClass },
      { label: '融券余额', value: (l.rqBalance / 1e8).toFixed(2) + '亿', change: l.rqChange >= 0 ? '+' + (l.rqChange / 1e8).toFixed(2) + '亿' : (l.rqChange / 1e8).toFixed(2) + '亿', changeClass: l.rqChange > 0 ? 'cap-neg' : 'cap-pos' },
      { label: '融券余量', value: (l.rqVolume / 1e4).toFixed(0) + '万股' },
      { label: '融资融券余额', value: (l.rzrqBalance / 1e8).toFixed(2) + '亿' },
      { label: '占流通市值比', value: (l.rzRatio || 0).toFixed(2) + '%' },
      { label: '趋势', value: margin.trend, signalClass: margin.trend.includes('增加') ? 'cap-pos' : margin.trend.includes('减少') ? 'cap-neg' : '' },
    ];
    el.innerHTML = `<div class="cap-date-note">${dateNote}</div>` + items.map(i => `
      <div class="cap-indicator-item">
        <span class="ci-label">${i.label}</span>
        <span class="ci-value">${i.value}</span>
        ${i.change ? `<span class="ci-signal ${i.changeClass}">${i.change}</span>` : ''}
        ${i.signalClass ? `<span class="ci-signal ${i.signalClass}">${i.value}</span>` : ''}
      </div>
    `).join('');
  },

  renderConclusion(data) {
    const el = document.getElementById('capConclusion');
    if (!el) return;

    const parts = [];
    const vi = data.volumeIndicators;
    const mf = data.moneyFlow;
    const margin = data.marginTrading;

    // 量价关系
    if (vi?.volumePrice) {
      const vp = vi.volumePrice;
      parts.push(`📊 <b>量价关系：</b>${vp.signal} — ${vp.description}`);
    }

    // 资金流向
    if (mf?.summary?.summary) {
      const isEst = mf?.source === 'estimated';
      const estNote = isEst ? '（估算）' : '';
      const s5 = mf.summary.summary['5d'];
      const s20 = mf.summary.summary['20d'];
      if (s5) {
        const dir = s5.direction;
        parts.push(`💰 <b>短期资金${estNote}：</b>近5日主力${dir}${Math.abs(s5.mainNet)}亿`);
      }
      if (s20) {
        const dir = s20.direction;
        parts.push(`📈 <b>中期资金${estNote}：</b>近20日主力${dir}${Math.abs(s20.mainNet)}亿`);
      }
    }

    // 量能指标
    if (vi?.indicators) {
      const ind = vi.indicators;
      if (ind.obvTrend !== '中性') parts.push(`📐 <b>OBV趋势：</b>${ind.obvTrend}`);
      if (ind.vrSignal !== '中性') parts.push(`🔍 <b>VR信号：</b>${ind.vrSignal}（VR=${ind.vr}）`);
      if (ind.mfiSignal !== '中性') parts.push(`💸 <b>MFI信号：</b>${ind.mfiSignal}（MFI=${ind.mfi}）`);
      if (ind.turnoverLevel !== '正常') {
        const tvRef = ind.turnoverAvg > 0 ? `，月均${ind.turnoverAvg}%` : '';
        parts.push(`🔄 <b>换手率：</b>${ind.turnover}%（${ind.turnoverLevel}${tvRef}）`);
      }
    }

    // 融资融券
    if (margin?.hasData) {
      const l = margin.latest;
      const netBuyStr = l.rzNetBuy !== undefined ? `，净买入${(l.rzNetBuy / 1e8).toFixed(2)}亿` : '';
      const ratioStr = l.rzRatio ? `（占流通市值${l.rzRatio.toFixed(2)}%）` : '';
      parts.push(`🏦 <b>融资融券：</b>融资余额${(l.rzBalance / 1e8).toFixed(1)}亿${netBuyStr}${ratioStr}，${margin.trend}`);
    }

    // 综合判断（优先复用后端统一结论，与判断引擎因子保持一致）
    let overall, bs = 0, br = 0;
    if (data.conclusion && typeof data.conclusion.bullScore === 'number') {
      overall = data.conclusion.label;
      bs = data.conclusion.bullScore;
      br = data.conclusion.bearScore;
    } else {
      if (vi?.volumePrice) {
        const vpSig = vi.volumePrice.signal;
        if (['放量上涨', '量价齐升', '显著上涨', '温和上涨'].includes(vpSig)) bs += 2;
        else if (['缩量回调'].includes(vpSig)) bs += 1;
        else if (['缩量上涨', '温和回调', '地量上涨', '地量回调', '缩量下跌', '地量下跌'].includes(vpSig)) br += 1;
        else if (['放量下跌', '量价齐跌', '显著下跌'].includes(vpSig)) br += 2;
      }
      if (mf?.summary?.summary?.['5d']?.mainNet > 0) bs += 2;
      else if (mf?.summary?.summary?.['5d']?.mainNet < 0) br += 2;
      if (vi?.indicators?.obvTrend === '上升趋势') bs += 1;
      if (vi?.indicators?.obvTrend === '下降趋势') br += 1;
      if (vi?.indicators?.vrSignal.includes('多')) bs += 1;
      if (vi?.indicators?.vrSignal.includes('空')) br += 1;
      if (margin?.latest?.rzChange > 0) bs += 1;
      if (margin?.latest?.rzChange < 0) br += 1;

      if (bs - br >= 3) overall = '资金面偏多，量能支撑上涨';
      else if (bs - br >= 1) overall = '资金面中性偏多';
      else if (bs - br <= -3) overall = '资金面偏空，注意风险';
      else if (bs - br <= -1) overall = '资金面中性偏空';
      else overall = '资金面中性，方向不明';
    }

    parts.push(`\n🎯 <b>综合判断：</b>${overall}（多头${bs}分 vs 空头${br}分）`);

    el.innerHTML = parts.map(p => `<div class="cap-conclusion-item">${p}</div>`).join('');
  },

  formatVol(v) {
    if (!v || v === 0) return '--';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(0) + '万';
    return v.toFixed(0);
  },

  /**
   * 计算资金热度评分（0-100）与等级
   * 基于：量价关系、资金流向（5日/20日主力净流入）、OBV/VR/MFI 量能指标、融资融券余额变化
   */
  flowScoreByRatio(ratioPct, maxUp) {
    const mag = Math.abs(ratioPct);
    let base;
    if (mag > 0.5) base = maxUp;
    else if (mag > 0.2) base = Math.round(maxUp * 0.66);
    else if (mag > 0) base = Math.round(maxUp * 0.33);
    else base = 0;
    return ratioPct >= 0 ? base : -base;
  },

  calculateScore(data) {
    if (!data) data = this.lastData;
    if (!data) return null;

    // 优先复用后端统一结论（与判断引擎因子同一份数据，保证跨页面一致）
    if (data.conclusion && typeof data.conclusion.score === 'number') {
      const c = data.conclusion;
      const className = c.grade === '非常活跃' ? 'strong-bullish'
        : c.grade === '活跃' ? 'bullish'
        : c.grade === '低迷' ? 'bearish'
        : c.grade === '极度低迷' ? 'strong-bearish'
        : 'neutral';
      return {
        score: c.score,
        grade: c.grade,
        className,
        reasons: c.reasons || [],
        summary: `资金热度 ${c.score} 分 — ${c.grade}`,
        raw: { volumePrice: data.volumeIndicators?.volumePrice, moneyFlow: data.moneyFlow?.summary?.summary, indicators: data.volumeIndicators?.indicators, margin: data.marginTrading?.latest },
      };
    }

    const vi = data.volumeIndicators || {};
    const mf = data.moneyFlow || {};
    const margin = data.marginTrading || {};
    const summary = mf.summary?.summary || {};

    let score = 50; // 中性起点
    const reasons = [];

    // 量能（交易量）水平（±15，方向无关：只衡量成交量多少，不再因股价涨跌而加减分）
    if (vi.volumePrice) {
      const vp = vi.volumePrice;
      const HEAT_MAP = { '显著放量': 13, '温和放量': 8, '量能平稳': 0, '缩量': -6, '地量': -10 };
      const heat = vp.heatLevel || '量能平稳';
      const d = HEAT_MAP[heat] != null ? HEAT_MAP[heat] : 0;
      score += d;
      reasons.push(d ? `量能（交易量）：${heat}，${d > 0 ? '+' : ''}${d}` : `量能（交易量）：${heat}，0`);
    }

    // 流通市值（亿元），用于把"主力净额"归一化为占市值比
    const fmc = (typeof data.floatMarketCapYi === 'number' && data.floatMarketCapYi > 0) ? data.floatMarketCapYi : 0;

    // 短期资金流向（±15，按占流通市值比分级）
    const s5 = summary['5d'];
    if (s5 && typeof s5.mainNet === 'number') {
      const amt = Math.abs(s5.mainNet);
      const ratio = fmc > 0 ? (s5.mainNet / fmc) * 100 : null;
      if (ratio === null) {
        if (s5.mainNet > 0) { score += 15; reasons.push(`近5日主力净流入${amt.toFixed(2)}亿，+15`); }
        else { score -= 15; reasons.push(`近5日主力净流出${amt.toFixed(2)}亿，-15`); }
      } else {
        const sc = this.flowScoreByRatio(ratio, 15);
        score += sc;
        reasons.push(`近5日主力${s5.mainNet > 0 ? '净流入' : '净流出'}${amt.toFixed(2)}亿(占流通市值${ratio.toFixed(2)}%)${sc > 0 ? '，+' : '，'}${sc}`);
      }
    }

    // 中期资金流向（±10，同上归一化）
    const s20 = summary['20d'];
    if (s20 && typeof s20.mainNet === 'number') {
      const amt = Math.abs(s20.mainNet);
      const ratio = fmc > 0 ? (s20.mainNet / fmc) * 100 : null;
      if (ratio === null) {
        if (s20.mainNet > 0) { score += 10; reasons.push(`近20日主力净流入${amt.toFixed(2)}亿，+10`); }
        else { score -= 10; reasons.push(`近20日主力净流出${amt.toFixed(2)}亿，-10`); }
      } else {
        const sc = this.flowScoreByRatio(ratio, 10);
        score += sc;
        reasons.push(`近20日主力${s20.mainNet > 0 ? '净流入' : '净流出'}${amt.toFixed(2)}亿(占流通市值${ratio.toFixed(2)}%)${sc > 0 ? '，+' : '，'}${sc}`);
      }
    }

    // 量能指标（±10）
    const ind = vi.indicators || {};
    if (ind.obvTrend === '上升趋势') { score += 6; reasons.push('OBV 上升趋势，+6'); }
    else if (ind.obvTrend === '下降趋势') { score -= 6; reasons.push('OBV 下降趋势，-6'); }
    if (ind.vrSignal && ind.vrSignal.includes('多')) { score += 4; reasons.push(`VR 信号${ind.vrSignal}，+4`); }
    else if (ind.vrSignal && ind.vrSignal.includes('空')) { score -= 4; reasons.push(`VR 信号${ind.vrSignal}，-4`); }

    // 融资融券（变化按占流通市值比归一化分级；存量杠杆按余额占比评级）
    if (margin.hasData && margin.latest) {
      const l = margin.latest;
      if (typeof l.rzChange === 'number') {
        const rzYi = l.rzChange / 1e8;
        const rzChgPct = fmc > 0 ? (rzYi / fmc) * 100 : null;
        if (rzChgPct === null) {
          if (l.rzChange > 0) { score += 6; reasons.push(`融资余额增加${Math.abs(rzYi).toFixed(2)}亿，+6`); }
          else { score -= 6; reasons.push(`融资余额减少${Math.abs(rzYi).toFixed(2)}亿，-6`); }
        } else {
          const sc = this.flowScoreByRatio(rzChgPct, 6);
          score += sc;
          reasons.push(`融资余额${l.rzChange > 0 ? '增加' : '减少'}${Math.abs(rzYi).toFixed(2)}亿(占流通市值${rzChgPct.toFixed(2)}%)${sc > 0 ? '，+' : '，'}${sc}`);
        }
      }
      if (typeof l.rqChange === 'number') {
        const rqYi = l.rqChange / 1e8;
        const rqChgPct = fmc > 0 ? (rqYi / fmc) * 100 : null;
        if (rqChgPct === null) {
          if (l.rqChange > 0) { score -= 6; reasons.push(`融券余额增加${Math.abs(rqYi).toFixed(2)}亿，-6`); }
          else { score += 6; reasons.push(`融券余额减少${Math.abs(rqYi).toFixed(2)}亿，+6`); }
        } else {
          const sc = this.flowScoreByRatio(rqChgPct, 6);
          const delta = -sc;
          score += delta;
          reasons.push(`融券余额${l.rqChange > 0 ? '增加' : '减少'}${Math.abs(rqYi).toFixed(2)}亿(占流通市值${rqChgPct.toFixed(2)}%)${delta > 0 ? '，+' : '，'}${delta}`);
        }
      }
      if (l.rzRatio > 5) { score += 4; reasons.push(`融资余额占流通市值${l.rzRatio.toFixed(2)}%，杠杆活跃，+4`); }
      else if (l.rzRatio > 2) { score += 2; reasons.push(`融资余额占流通市值${l.rzRatio.toFixed(2)}%，+2`); }
    }

    // 换手率加成（±5，相对月均换手率：以个股自身近一个月活跃度为基准，替代绝对阈值）
    if (ind.turnover) {
      const t = parseFloat(ind.turnover);
      const ratio = (typeof ind.turnoverRatio === 'number' && ind.turnoverRatio > 0) ? ind.turnoverRatio : null;
      if (ratio !== null) {
        const avgStr = (ind.turnoverAvg > 0) ? `月均${ind.turnoverAvg.toFixed(2)}%的${ratio.toFixed(1)}倍` : `月均参考缺失`;
        if (ratio >= 2.0) { score += 5; reasons.push(`换手率${t.toFixed(2)}%（${avgStr}）异常活跃，+5`); }
        else if (ratio >= 1.5) { score += 3; reasons.push(`换手率${t.toFixed(2)}%（${avgStr}）高度活跃，+3`); }
        else if (ratio < 0.5) { score -= 3; reasons.push(`换手率${t.toFixed(2)}%（${avgStr}）低迷，-3`); }
      } else {
        if (t > 10) { score += 5; reasons.push(`换手率${t.toFixed(2)}% 极高，+5`); }
        else if (t > 5) { score += 3; reasons.push(`换手率${t.toFixed(2)}% 较高，+3`); }
        else if (t < 1) { score -= 3; reasons.push(`换手率${t.toFixed(2)}% 较低，-3`); }
      }
    }

    score = Math.max(0, Math.min(100, score));

    let grade, className;
    if (score >= 80) { grade = '非常活跃'; className = 'strong-bullish'; }
    else if (score >= 65) { grade = '活跃'; className = 'bullish'; }
    else if (score >= 45) { grade = '中性'; className = 'neutral'; }
    else if (score >= 30) { grade = '低迷'; className = 'bearish'; }
    else { grade = '极度低迷'; className = 'strong-bearish'; }

    return {
      score,
      grade,
      className,
      reasons,
      summary: `资金热度 ${score} 分 — ${grade}`,
      raw: { volumePrice: vi.volumePrice, moneyFlow: summary, indicators: ind, margin: margin.latest },
    };
  },
};
