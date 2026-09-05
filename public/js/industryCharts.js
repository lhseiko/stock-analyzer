/**
 * Industry Analysis Charts（行业分析页渲染）
 * 渲染：期货指数关联图（复用 Charts.futuresCorrelation）、行业归属、政策前景、
 * 行业研报评级分布（饼图）、近一年研报月度趋势（柱状图）、行业研报列表。
 * 所有渲染均做防御，数据缺失时显示友好占位而非空白。
 */
window.IndustryCharts = {
  renderAll(data, boardData, historyData, stockMarketCapData) {
    if (!data) return;
    this.renderFutures(data.futures);
    this.renderIndustryOverview(data.industry, boardData, historyData, data.policy, stockMarketCapData);
    this.renderPolicy(data.policy);
    this.renderReportRating(data.reportStats);
    this.renderReportTrend(data.reportStats);
    this.renderReportList(data.industryReports);
  },

  // ---- 期货指数分析（仅产品相关时显示）----
  renderFutures(futures) {
    const card = document.getElementById('indFuturesCard');
    if (!card) return;
    if (!futures || !futures.hasFutures) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    const nameEl = document.getElementById('indFuturesName');
    if (nameEl) nameEl.textContent = futures.futuresName || '期货';

    const badge = document.getElementById('indFuturesCorrBadge');
    if (badge) {
      if (futures.correlation != null) {
        const levelColor = {
          '高度': '#22c55e', '中度': '#f59e0b', '弱': '#94a3b8', '基本无': '#94a3b8',
        }[futures.level] || '#94a3b8';
        badge.textContent = `相关系数 ${futures.correlation.toFixed(2)} · ${futures.level}${futures.direction}相关`;
        badge.style.background = levelColor + '22';
        badge.style.color = levelColor;
        badge.style.borderColor = levelColor;
      } else {
        badge.textContent = '';
      }
    }

    // 复用全局期货关联图（先释放旧实例，避免重复 init 警告）
    try {
      if (window.Charts && Charts.instances && Charts.instances['indFuturesChart']) {
        Charts.instances['indFuturesChart'].dispose();
        delete Charts.instances['indFuturesChart'];
      }
      Charts.futuresCorrelation('indFuturesChart', futures);
    } catch (e) { console.error('Industry futures chart error:', e); }

    const concl = document.getElementById('indFuturesConclusion');
    if (concl) {
      const hasR = Array.isArray(futures.reasoning) && futures.reasoning.length > 0;
      let html = `<div class="sc-summary"><span class="sc-icon">📌</span><span>${futures.conclusion || ''}</span></div>`;
      if (hasR) {
        html += `<button type="button" class="sc-toggle" id="indFuturesToggle">查看论证过程 ▾</button>`;
        html += `<div class="sc-reasoning hidden" id="indFuturesReasoning">${futures.reasoning.map((r) => `<div class="sc-reason-item">• ${r}</div>`).join('')}</div>`;
      }
      concl.innerHTML = html;
      if (hasR) {
        const btn = document.getElementById('indFuturesToggle');
        const re = document.getElementById('indFuturesReasoning');
        if (btn && re) {
          btn.addEventListener('click', () => {
            const hidden = re.classList.toggle('hidden');
            btn.textContent = hidden ? '查看论证过程 ▾' : '收起论证过程 ▴';
          });
        }
      }
    }
  },

  // ---- 行业分析总览：归属 + 指数摘要 + 走势图表（合并卡片） ----
  renderIndustryOverview(industry, boardData, historyData, policy, stockMarketCapData) {
    const body = document.getElementById('industryOverviewBody');
    if (!body) return;

    // 1) 行业归属
    let html = '';
    if (!industry) {
      html = '<div class="data-empty">⚠️ 暂未获取到该股票所属行业信息（可能为港股/美股或非标准标的）。</div>';
      body.innerHTML = html;
      this.renderIndustryIndexChart(historyData, stockMarketCapData);
      return;
    }

    const badge = policy ? `<span class="policy-badge policy-${policyLevelClass(policy.level)}">${policy.level}</span>` : '';
    html += `
      <div class="ind-overview-classification">
        <div class="ind-overview-class-header">
          <span class="ind-overview-class-title">🏷️ 行业归属</span>
          ${badge}
        </div>
        <div class="ind-overview-class-grid">
          <div class="ind-overview-class-item">
            <span class="ind-overview-class-label">所属行业（申万/证监会）</span>
            <span class="ind-overview-class-value">${industry.name || '未知'}</span>
          </div>
          ${industry.csrc ? `<div class="ind-overview-class-item"><span class="ind-overview-class-label">证监会细分行业</span><span class="ind-overview-class-value">${industry.csrc}</span></div>` : ''}
          ${industry.induName ? `<div class="ind-overview-class-item"><span class="ind-overview-class-label">东方财富行业分类</span><span class="ind-overview-class-value">${industry.induName}${industry.induCode ? `（代码 ${industry.induCode}）` : ''}</span></div>` : ''}
        </div>
      </div>`;

    // 2) 行业板块指数摘要与文本分析
    if (boardData && boardData.status === 'done') {
      const ytd = boardData.ytdChangePct || '';
      const numMatch = ytd.match(/-?\d+(\.\d+)?/);
      let ytdClass = 'neutral';
      if (numMatch) {
        const v = parseFloat(numMatch[0]);
        ytdClass = v > 0 ? 'bull' : v < 0 ? 'bear' : 'neutral';
      }
      const codeBadge = boardData.indexCode ? `<span class="ind-index-code">${this._escape(boardData.indexCode)}</span>` : '';
      const levelLine = boardData.currentLevel ? `<span class="ind-index-level">${this._escape(boardData.currentLevel)}</span>` : '';
      const asOfLine = boardData.asOf ? `<span class="ind-index-asof">数据截至 ${this._escape(boardData.asOf)}</span>` : '';
      const drivers = (boardData.keyDrivers || []).map(d => `<span class="ind-driver-chip">${this._escape(d)}</span>`).join('');

      html += `
        <div class="ind-overview-index">
          <div class="ind-overview-index-head">
            <div class="ind-overview-index-title">📊 ${this._escape(boardData.indexName || '行业代表指数')} ${codeBadge}</div>
            <div class="ind-overview-index-metrics">
              ${levelLine}
              ${ytd ? `<span class="ind-index-ytd ind-${ytdClass}">年初至今 ${this._escape(ytd)}</span>` : ''}
            </div>
            ${asOfLine}
          </div>
          ${boardData.recentTrend ? `<div class="ind-overview-section"><div class="ind-overview-sub">📈 近期走势</div><div class="ind-overview-text">${this._escape(boardData.recentTrend)}</div></div>` : ''}
          ${drivers ? `<div class="ind-overview-section"><div class="ind-overview-sub">🧭 核心驱动</div><div class="ind-driver-chips">${drivers}</div></div>` : ''}
          ${boardData.outlook ? `<div class="ind-overview-section"><div class="ind-overview-sub">🔭 后市展望</div><div class="ind-overview-text">${this._escape(boardData.outlook)}</div></div>` : ''}
          ${boardData.valuationNote ? `<div class="ind-overview-section"><div class="ind-overview-sub">💰 估值分位</div><div class="ind-overview-text">${this._escape(boardData.valuationNote)}</div></div>` : ''}
          ${boardData.source ? `<div class="ind-overview-source">📎 来源：${this._escape(boardData.source)}</div>` : ''}
        </div>`;
    } else if (boardData && boardData.status === 'running') {
      html += `<div class="ind-overview-empty ai-loading">⏳ 正在后台联网获取行业指数分析，可切换页面/股票，完成后自动显示…</div>`;
    } else if (boardData && boardData.status === 'error') {
      html += `<div class="ind-overview-empty">⚠️ AI 联网分析获取失败：${this._escape(boardData.message || boardData.error || '未知错误')}，可点击右上角重新获取。</div>`;
    } else {
      html += `<div class="ind-overview-empty">💡 暂无 AI 联网行业指数分析，点击右上角「✨ AI 联网获取」即可联网获取该行业代表指数的表现、驱动与展望。</div>`;
    }

    body.innerHTML = html;

    // 3) 行业指数走势图（独立渲染，不依赖 AI 分析）
    this.renderIndustryIndexChart(historyData, stockMarketCapData);
  },

  _escape(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  // ---- 行业指数 K 线走势（蜡烛图 + 均线 + 成交量 + 当前个股市值双坐标轴） ----
  renderIndustryIndexChart(historyData, stockMarketCapData) {
    const el = document.getElementById('industryIndexChart');
    if (!el) return;
    if (!historyData || !historyData.success || !Array.isArray(historyData.data) || historyData.data.length === 0) {
      el.innerHTML = '<div class="data-empty" style="height:100%;display:flex;align-items:center;justify-content:center;">⚠️ 暂无行业指数走势图数据</div>';
      return;
    }

    const raw = historyData.data;
    const dates = raw.map(d => d.date);
    const values = raw.map(d => [d.open, d.close, d.low, d.high]);
    const volumes = raw.map(d => d.volume || 0);
    const ma5 = this._calcMA(5, raw);
    const ma10 = this._calcMA(10, raw);
    const ma20 = this._calcMA(20, raw);
    const ma60 = this._calcMA(60, raw);

    const upColor = '#F6465D';   // 涨红（全站统一）
    const downColor = '#0ECB81'; // 跌绿（全站统一）
    const mcColor = '#3B82F6';   // 个股市值线（蓝色，与 K线/均线区分）

    // 按行业指数日期对齐个股市值序列（亿元）
    let mcSeries = [];
    let hasMarketCap = false;
    if (stockMarketCapData && stockMarketCapData.success && Array.isArray(stockMarketCapData.data) && stockMarketCapData.data.length) {
      const mcMap = new Map();
      let last = null;
      for (const d of stockMarketCapData.data) {
        if (d.date && d.marketCap > 0) {
          mcMap.set(d.date, d.marketCap);
          last = d.marketCap;
        }
      }
      for (const d of dates) {
        if (mcMap.has(d)) {
          last = mcMap.get(d);
          mcSeries.push(last);
        } else {
          mcSeries.push(last);
        }
      }
      hasMarketCap = mcSeries.some(v => v > 0);
    }

    const legendData = hasMarketCap
      ? ['K线', 'MA5', 'MA10', 'MA20', 'MA60', '成交量', '个股市值']
      : ['K线', 'MA5', 'MA10', 'MA20', 'MA60', '成交量'];

    this._initChart(el, 'industryIndexChart', {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: 'rgba(30,34,45,0.95)',
        borderColor: '#2a2f3a',
        textStyle: { color: '#c9d1d9' },
        formatter: (params) => {
          const candle = params.find(p => p.seriesName === 'K线');
          if (!candle) return '';
          const d = candle.name;
          const [o, c, l, h] = candle.data;
          const vol = params.find(p => p.seriesName === '成交量');
          const mc = params.find(p => p.seriesName === '个股市值');
          const rows = [
            `<div style="font-weight:600;margin-bottom:4px;">${d}</div>`,
            `<div>开盘 <span style="float:right;margin-left:16px;">${o.toFixed(2)}</span></div>`,
            `<div>收盘 <span style="float:right;margin-left:16px;">${c.toFixed(2)}</span></div>`,
            `<div>最高 <span style="float:right;margin-left:16px;">${h.toFixed(2)}</span></div>`,
            `<div>最低 <span style="float:right;margin-left:16px;">${l.toFixed(2)}</span></div>`,
          ];
          params.forEach(p => {
            if (p.seriesName && p.seriesName.startsWith('MA')) {
              rows.push(`<div>${p.seriesName} <span style="float:right;margin-left:16px;">${Number(p.data).toFixed(2)}</span></div>`);
            }
          });
          if (mc && mc.data > 0) rows.push(`<div>个股市值 <span style="float:right;margin-left:16px;color:${mcColor};">${this._formatMarketCap(mc.data)}</span></div>`);
          if (vol) rows.push(`<div>成交量 <span style="float:right;margin-left:16px;">${this._formatVolume(vol.data)}</span></div>`);
          return rows.join('');
        },
      },
      legend: { data: legendData, textStyle: { color: '#9ca3af' }, top: 4 },
      grid: [
        { left: '8%', right: hasMarketCap ? '12%' : '4%', top: '44px', height: '62%' },
        { left: '8%', right: '4%', top: '76%', height: '16%' },
      ],
      xAxis: [
        { type: 'category', data: dates, scale: true, boundaryGap: false, axisLine: { lineStyle: { color: '#2a2f3a' } }, axisLabel: { color: '#9ca3af', fontSize: 10 }, splitLine: { show: false } },
        { type: 'category', data: dates, gridIndex: 1, scale: true, boundaryGap: false, axisLine: { lineStyle: { color: '#2a2f3a' } }, axisLabel: { show: false }, splitLine: { show: false } },
      ],
      yAxis: [
        { scale: true, splitArea: { show: false }, axisLine: { lineStyle: { color: '#2a2f3a' } }, axisLabel: { color: '#9ca3af', fontSize: 10 }, splitLine: { lineStyle: { color: '#2a2f3a' } } },
        { scale: true, gridIndex: 1, splitNumber: 2, axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false } },
        ...(hasMarketCap ? [{
          type: 'value',
          position: 'right',
          scale: true,
          gridIndex: 0,
          offset: 0,
          axisLine: { lineStyle: { color: mcColor } },
          axisLabel: { color: mcColor, fontSize: 10, formatter: (v) => this._formatMarketCap(v) },
          splitLine: { show: false },
          name: '市值（亿元）',
          nameTextStyle: { color: mcColor, fontSize: 10 },
        }] : []),
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: Math.max(0, 100 - Math.round(180 / raw.length * 100)), end: 100 },
        { type: 'slider', xAxisIndex: [0, 1], show: true, bottom: 4, height: 16, borderColor: '#2a2f3a', fillerColor: 'rgba(127,168,201,0.25)', handleStyle: { color: '#7fa8c9' }, textStyle: { color: '#9ca3af' } },
      ],
      series: [
        {
          name: 'K线', type: 'candlestick', data: values,
          itemStyle: { color: upColor, color0: downColor, borderColor: upColor, borderColor0: downColor },
        },
        { name: 'MA5', type: 'line', data: ma5, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#E6EDF3' } },
        { name: 'MA10', type: 'line', data: ma10, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#F0B90B' } },
        { name: 'MA20', type: 'line', data: ma20, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#A855F7' } },
        { name: 'MA60', type: 'line', data: ma60, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#22C55E' } },
        ...(hasMarketCap ? [{
          name: '个股市值',
          type: 'line',
          yAxisIndex: 2,
          data: mcSeries,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2, color: mcColor },
          itemStyle: { color: mcColor },
        }] : []),
        {
          name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volumes,
          itemStyle: {
            color: (p) => {
              const idx = p.dataIndex;
              const close = raw[idx].close;
              const open = raw[idx].open;
              return close >= open ? upColor : downColor;
            },
          },
        },
      ],
    });
  },

  _calcMA(dayCount, data) {
    const result = [];
    for (let i = 0; i < data.length; i++) {
      if (i < dayCount - 1) { result.push('-'); continue; }
      let sum = 0;
      for (let j = 0; j < dayCount; j++) sum += data[i - j].close;
      result.push((sum / dayCount).toFixed(3));
    }
    return result;
  },

  _formatVolume(n) {
    const v = Number(n) || 0;
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return v.toLocaleString();
  },

  _formatMarketCap(n) {
    const v = Number(n) || 0;
    if (v >= 1e4) return (v / 1e4).toFixed(2) + '万亿';
    if (v >= 1) return v.toFixed(0) + '亿';
    return v.toFixed(2) + '亿';
  },

  // ---- 政策前景 ----
  renderPolicy(policy) {
    const el = document.getElementById('indPolicy');
    if (!el) return;
    if (!policy) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂未获取到行业政策前景分析。</div>';
      return;
    }
    const plans = (policy.plans || []).map((p) => `<li>${p}</li>`).join('');
    const lvlClass = policyLevelClass(policy.level);
    el.innerHTML = `
      <div class="chart-header"><h3>🏛️ 行业政策前景与国家发展规划</h3><span class="policy-badge policy-${lvlClass}">${policy.level}</span></div>
      <div class="policy-body">
        <div class="policy-section">
          <div class="policy-subtitle">📋 国家发展规划相关要点</div>
          <ul class="policy-plans">${plans}</ul>
        </div>
        <div class="policy-section">
          <div class="policy-subtitle">🔭 行业未来前景分析</div>
          <div class="policy-summary">${policy.summary}</div>
        </div>
        <div class="policy-source">来源：内置行业政策库 · 建议结合最新国家规划与主管部门文件研判</div>
        ${policy.matched ? '' : '<div class="policy-note">提示：该行业未匹配内置重点行业政策库，以上为通用分析，建议结合最新"十四五"规划、政府工作报告及行业主管部门文件进一步研判。</div>'}
      </div>`;
  },

  // ---- 研报评级分布（饼图）----
  renderReportRating(stats) {
    const el = document.getElementById('indReportRating');
    if (!el) return;
    if (!stats || !stats.ratingDist) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂未获取到行业研报评级分布（数据源未提供或网络受限）。</div>';
      return;
    }
    const d = stats.ratingDist;
    const data = [
      { name: '买入', value: d['买入'] || 0 },
      { name: '增持', value: d['增持'] || 0 },
      { name: '中性', value: d['中性'] || 0 },
      { name: '减持', value: d['减持'] || 0 },
      { name: '卖出', value: d['卖出'] || 0 },
      { name: '其他', value: d['其他'] || 0 },
    ].filter((x) => x.value > 0);
    if (!data.length) {
      el.innerHTML = '<div class="data-empty">⚠️ 近一年无结构化评级数据。</div>';
      return;
    }
    this._initChart(el, 'indReportRating', {
      tooltip: { trigger: 'item' },
      legend: { bottom: 0, textStyle: { color: '#888' } },
      series: [{
        type: 'pie', radius: ['40%', '68%'], center: ['50%', '45%'],
        label: { color: '#bbb', formatter: '{b}: {c} ({d}%)' },
        data,
        color: ['#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#94a3b8'],
      }],
    });
  },

  // ---- 研报月度趋势（柱状图）----
  renderReportTrend(stats) {
    const el = document.getElementById('indReportTrend');
    if (!el) return;
    if (!stats || !stats.monthly || !stats.monthly.months || !stats.monthly.months.length) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂未获取到行业研报发布趋势。</div>';
      return;
    }
    const { months, counts } = stats.monthly;
    this._initChart(el, 'indReportTrend', {
      tooltip: { trigger: 'axis' },
      grid: { left: 40, right: 16, top: 20, bottom: 64 },
      xAxis: { type: 'category', data: months, axisLabel: { color: '#888', rotate: 45, interval: 0, fontSize: 10 } },
      yAxis: { type: 'value', axisLabel: { color: '#888' }, splitLine: { lineStyle: { color: '#2a2f3a' } } },
      series: [{ type: 'bar', data: counts, itemStyle: { color: '#7fa8c9' }, barWidth: '55%' }],
    });
  },

  // ---- 行业研报列表 ----
  renderReportList(list) {
    const el = document.getElementById('indReportList');
    if (!el) return;
    if (!list || !list.length) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂未获取到近一年的行业分析师研究报告（数据源未提供或网络受限）。</div>';
      return;
    }
    const rows = list.slice(0, 50).map((r) => `
      <div class="research-item">
        <div class="research-title">${r.title || '（无标题）'}</div>
        <div class="research-meta">
          <span class="research-org">🏛️ ${r.org || '未知机构'}</span>
          ${r.rating ? `<span class="research-rating">评级：${r.rating}</span>` : ''}
          ${r.targetPrice ? `<span class="research-target">目标价：¥${Number(r.targetPrice).toFixed(2)}</span>` : ''}
          ${r.publishDate ? `<span class="research-date">📅 ${r.publishDate}</span>` : ''}
        </div>
      </div>`).join('');
    el.innerHTML = `<div class="research-list">${rows}</div>`;
  },

  // 统一初始化 ECharts（先释放旧实例），并把实例挂到 Charts.instances 以便 Tab 切换时 resize
  _initChart(el, key, option) {
    try {
      if (el._chart) { el._chart.dispose(); el._chart = null; }
      if (window.Charts && Charts.instances && Charts.instances[key]) {
        Charts.instances[key].dispose();
        delete Charts.instances[key];
      }
      const chart = echarts.init(el, 'softDark', { renderer: 'canvas' });
      chart.setOption(option);
      el._chart = chart;
      if (window.Charts && Charts.instances) Charts.instances[key] = chart;
    } catch (e) {
      console.error('Industry chart init error:', e);
      el.innerHTML = '<div class="data-empty">图表渲染失败。</div>';
    }
  },
};

function policyLevelClass(level) {
  if (!level) return 'neutral';
  if (level.includes('扶持') || level.includes('战略')) return 'support';
  if (level.includes('受限')) return 'restrict';
  return 'neutral';
}
