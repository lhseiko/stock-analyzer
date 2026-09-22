/**
 * Industry Analysis Charts（行业分析页渲染）
 * 渲染：期货指数关联图（复用 Charts.futuresCorrelation）、行业归属、政策前景、
 * 公司研报列表（针对本公司）、行业研报列表（所属行业相关）。
 * 所有渲染均做防御，数据缺失时显示友好占位而非空白。
 */
window.IndustryCharts = {
  renderAll(data, boardData, historyData, stockMarketCapData, opts) {
    if (!data) return;
    const o = Object.assign({ stockName: (data && data.name) || '', boardLoading: false }, opts || {});
    this.renderFutures(data.futures);
    this.renderIndustryOverview(data.industry, boardData, historyData, data.policy, stockMarketCapData, o);
    this.renderPolicy(data.policy);
    this.renderCompanyReportList(data.companyReports, data.name);
    this.renderReportList(data.industryReports, data.industry && data.industry.induName);
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
  renderIndustryOverview(industry, boardData, historyData, policy, stockMarketCapData, opts) {
    const body = document.getElementById('industryOverviewBody');
    if (!body) return;
    const o = opts || {};

    // 1) 行业归属
    let html = '';
    if (!industry) {
      html = '<div class="data-empty">⚠️ 暂未获取到该股票所属行业信息（可能为港股/美股或非标准标的）。</div>';
      body.innerHTML = html;
      this.renderIndustryIndexChart(historyData, stockMarketCapData, o);
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
      // 20260913d：后台刷新中 / 上次刷新失败 —— 都保留并展示上一次成功内容，仅在旁提示状态
      const refreshingBadge = boardData.refreshing ? '<span class="ind-index-asof ind-refreshing">🔄 后台更新中…</span>' : '';
      const lastErrorLine = boardData.lastError
        ? `<div class="ind-overview-section"><div class="ind-overview-sub">⚠️ 上次更新失败</div><div class="ind-overview-text">${this._escape(boardData.lastError)}（下方仍为上一次成功获取的内容）</div></div>`
        : '';

      html += `
        <div class="ind-overview-index">
          <div class="ind-overview-index-head">
            <div class="ind-overview-index-title">📊 ${this._escape(boardData.indexName || '行业代表指数')} ${codeBadge}</div>
            <div class="ind-overview-index-metrics">
              ${levelLine}
              ${ytd ? `<span class="ind-index-ytd ind-${ytdClass}">年初至今 ${this._escape(ytd)}</span>` : ''}
            </div>
            ${asOfLine}
            ${refreshingBadge}
          </div>
          ${lastErrorLine}
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
    } else if (o.boardLoading) {
      // 20260913d：首次读取尚未返回 —— 显示"读取中"而非"暂无"，避免打开页面时内容短暂消失
      html += `<div class="ind-overview-empty ai-loading">⏳ 正在读取行业指数分析…</div>`;
    } else {
      html += `<div class="ind-overview-empty">💡 暂无 AI 联网行业指数分析，点击右上角「✨ AI 联网获取」即可联网获取该行业代表指数的表现、驱动与展望。</div>`;
    }

    body.innerHTML = html;

    // 3) 行业指数走势图（独立渲染，不依赖 AI 分析）
    this.renderIndustryIndexChart(historyData, stockMarketCapData, o);
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
  // 20260913d：① 图例显式标注 K 线代表哪个板块指数、市值线代表哪只个股；
  //             ② 修复均线前期占位 '-' 在 tooltip 里显示 NaN；③ 图表下方补数据源与数据日期。
  //             仅改标注与取值，图表样式/配色/布局不变（样式与内容解耦）。
  renderIndustryIndexChart(historyData, stockMarketCapData, opts) {
    const el = document.getElementById('industryIndexChart');
    if (!el) return;
    const noteEl = document.getElementById('industryIndexNote');
    const stockName = (opts && opts.stockName) || '个股';

    if (!historyData || !historyData.success || !Array.isArray(historyData.data) || historyData.data.length === 0) {
      el.innerHTML = '<div class="data-empty" style="height:100%;display:flex;align-items:center;justify-content:center;">⚠️ 暂无行业指数走势图数据</div>';
      if (noteEl) noteEl.textContent = '';
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

    // 图例显示名：K 线 = 实际绘制的板块指数；市值线 = 当前个股
    const indexSeriesName = historyData.name ? `${historyData.name}指数` : '行业指数';
    const capSeriesName = `${stockName}市值`;

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
      ? [indexSeriesName, 'MA5', 'MA10', 'MA20', 'MA60', '成交量', capSeriesName]
      : [indexSeriesName, 'MA5', 'MA10', 'MA20', 'MA60', '成交量'];

    // 数值格式化：均线前期为 '-' 占位，Number('-') 为 NaN —— 统一显示 '--' 而非 NaN
    const num2 = (v) => { const n = Number(v); return isFinite(n) ? n.toFixed(2) : '--'; };

    this._initChart(el, 'industryIndexChart', {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        backgroundColor: 'rgba(30,34,45,0.95)',
        borderColor: '#2a2f3a',
        textStyle: { color: '#c9d1d9' },
        formatter: (params) => {
          const candle = params.find(p => p.seriesType === 'candlestick') || params.find(p => p.seriesName === indexSeriesName);
          if (!candle) return '';
          const d = candle.name;
          const [o, c, l, h] = candle.data;
          const vol = params.find(p => p.seriesName === '成交量');
          const mc = params.find(p => p.seriesName === capSeriesName);
          const rows = [
            `<div style="font-weight:600;margin-bottom:2px;">${d}</div>`,
            `<div style="color:#9ca3af;margin-bottom:4px;">${this._escape(indexSeriesName)}</div>`,
            `<div>开盘 <span style="float:right;margin-left:16px;">${num2(o)}</span></div>`,
            `<div>收盘 <span style="float:right;margin-left:16px;">${num2(c)}</span></div>`,
            `<div>最高 <span style="float:right;margin-left:16px;">${num2(h)}</span></div>`,
            `<div>最低 <span style="float:right;margin-left:16px;">${num2(l)}</span></div>`,
          ];
          params.forEach(p => {
            if (p.seriesName && /^MA(5|10|20|60)$/.test(p.seriesName)) {
              rows.push(`<div>${p.seriesName} <span style="float:right;margin-left:16px;">${num2(p.data)}</span></div>`);
            }
          });
          if (mc && Number(mc.data) > 0) rows.push(`<div>${this._escape(capSeriesName)} <span style="float:right;margin-left:16px;color:${mcColor};">${this._formatMarketCapExact(mc.data)}</span></div>`);
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
          name: indexSeriesName, type: 'candlestick', data: values,
          itemStyle: { color: upColor, color0: downColor, borderColor: upColor, borderColor0: downColor },
        },
        { name: 'MA5', type: 'line', data: ma5, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#E6EDF3' } },
        { name: 'MA10', type: 'line', data: ma10, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#F0B90B' } },
        { name: 'MA20', type: 'line', data: ma20, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#A855F7' } },
        { name: 'MA60', type: 'line', data: ma60, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#22C55E' } },
        ...(hasMarketCap ? [{
          name: capSeriesName,
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

    // 数据源 + 数据日期标注（规则一·数据一致性 / 规则二·数据最新性）
    if (noteEl) {
      const last = raw[raw.length - 1] || {};
      const codeTxt = historyData.code ? `（${historyData.code}）` : '';
      const mcLast = hasMarketCap && stockMarketCapData && Array.isArray(stockMarketCapData.data) && stockMarketCapData.data.length
        ? stockMarketCapData.data[stockMarketCapData.data.length - 1] : null;
      const mcTxt = mcLast ? ` · ${stockName}市值截至 ${mcLast.date}（${this._formatMarketCapExact(mcLast.marketCap)}）` : '';
      noteEl.textContent = `数据源：${historyData.source || '同花顺·行业板块'} · ${historyData.name || ''}${codeTxt} 日线截至 ${last.date || '-'} · 共 ${raw.length} 个交易日${mcTxt}`;
    }
  },

  // ---- 板块总市值走势「三图骨架」：按个股所属一级/二级/三级行业板块生成卡片 ----
  // 统一模板（20260916）：所有个股一律生成三张（无三级板块则两张）。
  // levelsPayload = { symbol, name, levels: [{ swLevel, sectorCode, sectorName }] }
  // 数据到达后由 renderSectorMarketCap(data, { suffix }) 逐张填充。
  renderSectorCapGroup(levelsPayload, opts) {
    const box = document.getElementById('sectorCapGroup');
    if (!box) return;
    const levels = (levelsPayload && Array.isArray(levelsPayload.levels)) ? levelsPayload.levels : [];
    if (!levels.length) { box.innerHTML = ''; return; }
    const sfxOf = (lv) => ({ '一级': 'L1', '二级': 'L2', '三级': 'L3' }[lv] || ('L' + lv));
    box.innerHTML = levels.map((lv) => {
      const sfx = sfxOf(lv.swLevel);
      return `
        <div class="chart-card large" id="sectorCapCard-${sfx}" style="display:none;">
          <div class="chart-header">
            <h3>📈 板块总市值走势 · <span class="sector-cap-level">${lv.swLevel}</span> <span id="sectorCapTitle-${sfx}">所属板块</span></h3>
            <div class="ai-head-actions">
              <span id="sectorCapDate-${sfx}" class="ai-date"></span>
            </div>
          </div>
          <div id="sectorCapChart-${sfx}" class="chart" style="height:420px;"></div>
          <div id="sectorCapNote-${sfx}" class="sh-source"></div>
        </div>`;
    }).join('');
  },

  // ---- 板块总市值走势（成分股总市值合计 + 当前个股自身市值对比） ----
  // 口径说明：总市值是「每日单一数值」，没有开/收/高/低四个价，因此用折线/面积呈现走势，
  //           而非蜡烛 K 线（K 线必须四价）。数据源与日期在卡片下方显式标注。
  // 20260916：统一模板 —— 每只个股按所属申万一级/二级/三级行业板块各渲染一张（suffix 区分 id）。
  renderSectorMarketCap(data, opts) {
    const o = opts || {};
    const suffix = o.suffix || 'main';
    const stockName = o.stockName || '个股';
    const card = document.getElementById(`sectorCapCard-${suffix}`);
    if (!card) return;

    if (!data || !data.success || !Array.isArray(data.dates) || !data.dates.length) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';

    const lvLabel = o.swLevel ? ` · ${o.swLevel}` : '';
    const sectorLabel = data.sectorName ? `${data.sectorName}（${data.sectorCode}）${lvLabel}` : (data.sectorCode || '所属板块');
    const titleEl = document.getElementById(`sectorCapTitle-${suffix}`);
    if (titleEl) titleEl.textContent = sectorLabel;
    const dateEl = document.getElementById(`sectorCapDate-${suffix}`);
    if (dateEl) dateEl.textContent = data.date ? `数据截至 ${data.date}` : '';

    const dates = data.dates;
    const total = data.total || [];
    const bm = (data.benchmark && Array.isArray(data.benchmark.series) && data.benchmark.series.length) ? data.benchmark.series : null;

    const totalName = '板块总市值（成分股合计）';
    const bmName = `${stockName}市值`;
    const ratioName = `${stockName}占板块比重`;

    const ratio = total.map((v, i) => {
      const b = bm ? bm[i] : null;
      return (v > 0 && b != null && b > 0) ? Math.round(b / v * 10000) / 100 : null;
    });
    const hasRatio = ratio.some(v => v != null);

    const totalColor = '#3B82F6';
    const bmColor = '#F0B97B';
    const ratioColor = '#A855F7';

    const num2 = (v) => { const n = Number(v); return isFinite(n) ? n.toFixed(2) : '--'; };

    const legendData = hasRatio ? [totalName, bmName, ratioName] : [totalName, bmName];

    const chartEl = document.getElementById(`sectorCapChart-${suffix}`);
    if (chartEl) {
      this._initChart(chartEl, `sectorCapChart-${suffix}`, {
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross' },
          backgroundColor: 'rgba(30,34,45,0.95)',
          borderColor: '#2a2f3a',
          textStyle: { color: '#c9d1d9' },
          formatter: (params) => {
            if (!params || !params.length) return '';
            const rows = [`<div style="font-weight:600;margin-bottom:4px;">${params[0].name}</div>`];
            params.forEach(p => {
              if (p.seriesName === totalName) rows.push(`<div>${totalName} <span style="float:right;margin-left:16px;color:${totalColor};">${this._formatMarketCapExact(p.data)}</span></div>`);
              else if (p.seriesName === bmName) rows.push(`<div>${bmName} <span style="float:right;margin-left:16px;color:${bmColor};">${p.data == null ? '--' : this._formatMarketCapExact(p.data)}</span></div>`);
              else if (p.seriesName === ratioName) rows.push(`<div>${ratioName} <span style="float:right;margin-left:16px;color:${ratioColor};">${p.data == null ? '--' : Number(p.data).toFixed(2) + '%'}</span></div>`);
            });
            return rows.join('');
          },
        },
        legend: { data: legendData, textStyle: { color: '#9ca3af' }, top: 4 },
        grid: { left: '8%', right: hasRatio ? '20%' : (bm ? '13%' : '8%'), top: '44px', bottom: '70px' },
        xAxis: {
          type: 'category', data: dates, scale: true, boundaryGap: false,
          axisLine: { lineStyle: { color: '#2a2f3a' } }, axisLabel: { color: '#9ca3af', fontSize: 10 }, splitLine: { show: false },
        },
        yAxis: [
          {
            type: 'value', scale: true, position: 'left', name: '板块总市值（亿元）', nameTextStyle: { color: totalColor, fontSize: 10 },
            axisLine: { lineStyle: { color: totalColor } }, axisLabel: { color: totalColor, fontSize: 10, formatter: (v) => this._formatMarketCap(v) },
            splitLine: { lineStyle: { color: '#2a2f3a' } },
          },
          ...(bm ? [{
            type: 'value', position: 'right', scale: true, name: `${stockName}市值（亿元）`, nameTextStyle: { color: bmColor, fontSize: 10 },
            offset: 0,
            axisLine: { lineStyle: { color: bmColor } }, axisLabel: { color: bmColor, fontSize: 10, formatter: (v) => this._formatMarketCap(v) },
            splitLine: { show: false },
          }] : []),
          ...(hasRatio ? [{
            type: 'value', position: 'right', scale: true, name: '占板块比重（%）', nameTextStyle: { color: ratioColor, fontSize: 10 },
            offset: 60,
            axisLine: { lineStyle: { color: ratioColor } }, axisLabel: { color: ratioColor, fontSize: 10, formatter: (v) => v + '%' },
            splitLine: { show: false },
          }] : []),
        ],
        dataZoom: [
          { type: 'inside', xAxisIndex: [0], start: Math.max(0, 100 - Math.round(180 / dates.length * 100)), end: 100 },
          { type: 'slider', xAxisIndex: [0], show: true, bottom: 4, height: 16, borderColor: '#2a2f3a', fillerColor: 'rgba(127,168,201,0.25)', handleStyle: { color: '#7fa8c9' }, textStyle: { color: '#9ca3af' } },
        ],
        series: [
          {
            name: totalName, type: 'line', yAxisIndex: 0, data: total, smooth: true, showSymbol: false,
            lineStyle: { width: 2, color: totalColor }, itemStyle: { color: totalColor },
            areaStyle: { color: 'rgba(59,130,246,0.12)' },
          },
          ...(bm ? [{
            name: bmName, type: 'line', yAxisIndex: 1, data: bm, smooth: true, showSymbol: false,
            lineStyle: { width: 2, color: bmColor }, itemStyle: { color: bmColor },
          }] : []),
          ...(hasRatio ? [{
            name: ratioName, type: 'line', yAxisIndex: 2, data: ratio, smooth: true, showSymbol: false,
            lineStyle: { width: 1.5, color: ratioColor, type: 'dashed' }, itemStyle: { color: ratioColor },
          }] : []),
        ],
      });
    }

    // 摘要 + 数据源/日期/覆盖度标注
    const noteEl = document.getElementById(`sectorCapNote-${suffix}`);
    if (noteEl) {
      const n = total.length;
      const lastTotal = total[n - 1];
      const prevTotal = n > 1 ? total[n - 2] : null;
      const totalChg = (prevTotal && prevTotal > 0) ? (lastTotal / prevTotal - 1) * 100 : null;
      const lastBm = bm ? bm[n - 1] : null;
      const prevBm = (bm && n > 1) ? bm[n - 2] : null;
      const bmChg = (prevBm && prevBm > 0 && lastBm > 0) ? (lastBm / prevBm - 1) * 100 : null;
      const lastRatio = ratio[n - 1];
      const chgTxt = (v) => (v == null ? '—' : (v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`));
      const chgCls = (v) => (v == null ? '' : (v >= 0 ? 'up' : 'down'));
      const missTxt = (Array.isArray(data.missing) && data.missing.length)
        ? ` · 未纳入 ${data.missing.length} 只（${data.missing.map(m => `${m.name || ''}${m.code ? '(' + m.code + ')' : ''}`).join('、')}），因其无日频市值数据`
        : '';
      const capTxt = data.capped
        ? ` · 成分股共 ${data.constituents} 只，按总市值降序取前 ${data.usedConstituents} 只合计`
        : '';
      noteEl.innerHTML = `
        <div class="sector-cap-summary">
          <div class="sector-cap-summary-item"><span class="sector-cap-summary-label">板块总市值合计</span><span class="sector-cap-summary-value">${this._formatMarketCapExact(lastTotal)}</span></div>
          <div class="sector-cap-summary-item"><span class="sector-cap-summary-label">较前一交易日</span><span class="sector-cap-summary-value ${chgCls(totalChg)}">${chgTxt(totalChg)}</span></div>
          <div class="sector-cap-summary-item"><span class="sector-cap-summary-label">${stockName}市值</span><span class="sector-cap-summary-value">${lastBm == null ? '—' : this._formatMarketCapExact(lastBm)}</span></div>
          <div class="sector-cap-summary-item"><span class="sector-cap-summary-label">${stockName}较前一日</span><span class="sector-cap-summary-value ${chgCls(bmChg)}">${chgTxt(bmChg)}</span></div>
          <div class="sector-cap-summary-item"><span class="sector-cap-summary-label">${stockName}占板块</span><span class="sector-cap-summary-value">${lastRatio == null ? '—' : lastRatio.toFixed(2) + '%'}</span></div>
        </div>
        <div>数据源：${data.source || '东方财富'} · 日线截至 ${data.date || '-'} · 共 ${dates.length} 个交易日 · 计入成分股 ${data.covered || 0}/${data.constituents || data.usedConstituents || 0} 只${missTxt}${capTxt}</div>`;
    }
  },

  // ---- 行业景气度：行业总营收(TTM) vs 行业总市值，双坐标轴折线 ----
  // 数据来自服务端 /api/industry-prosperity/:symbol（东方财富业绩报表+估值明细按申万二级全量汇总）。
  // 左轴 = 总营收(TTM, 亿元)，右轴 = 总市值(亿元)，x = 报告期标签；卡片下方标注行业公司数等。
  renderIndustryProsperity(data, opts) {
    const card = document.getElementById('indProsperityCard');
    if (!card) return;

    // 失败 / 无数据：隐藏卡片，不残留上一只股票
    if (!data || !data.success || !Array.isArray(data.periodLabels) || !data.periodLabels.length) {
      card.style.display = 'none';
      return;
    }
    card.style.display = '';

    const o = opts || {};
    const stockName = o.stockName || (data.stockName || '');
    const industryName = (data.industry && data.industry.sectorName) || '';
    const titleEl = document.getElementById('indProsperityIndustry');
    if (titleEl) titleEl.textContent = industryName || '所属行业';
    const dateEl = document.getElementById('indProsperityDate');
    if (dateEl) dateEl.textContent = data.date ? `数据截至 ${data.date}` : '';

    const labels = data.periodLabels;
    const revenue = (data.revenueTTM || []).map(v => (v == null ? null : Number(v)));
    const mcap = (data.marketCap || []).map(v => (v == null ? null : Number(v)));
    const single = (data.revenueSingle || []).map(v => (v == null ? null : Number(v)));
    const revYoY = data.latest && data.latest.revenueTTMYoY;
    const mcYoY = data.latest && data.latest.marketCapYoY;

    const revName = '行业总营收（TTM，亿元）';
    const mcName = '行业总市值（亿元）';
    const revColor = '#4ADE80';
    const mcColor = '#60A5FA';
    const num2 = (v) => { const n = Number(v); return isFinite(n) ? n.toFixed(2) : '--'; };

    const chartEl = document.getElementById('indProsperityChart');
    if (chartEl) {
      this._initChart(chartEl, 'indProsperityChart', {
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'cross' },
          backgroundColor: 'rgba(30,34,45,0.95)',
          borderColor: '#2a2f3a',
          textStyle: { color: '#c9d1d9' },
          formatter: (params) => {
            if (!params || !params.length) return '';
            const idx = params[0].dataIndex;
            const p = labels[idx] || '';
            const rows = [`<div style="font-weight:600;margin-bottom:4px;">${p}</div>`];
            params.forEach((pp) => {
              if (pp.seriesName === revName) {
                rows.push(`<div>${revName} <span style="float:right;margin-left:16px;color:${revColor};">${num2(pp.data)}</span></div>`);
                if (single[idx] != null) rows.push(`<div style="color:#9ca3af;font-size:11px;">　└ 单季营收：<span style="float:right;margin-left:16px;color:${revColor};">${num2(single[idx])}</span></div>`);
              } else if (pp.seriesName === mcName) {
                rows.push(`<div>${mcName} <span style="float:right;margin-left:16px;color:${mcColor};">${num2(pp.data)}</span></div>`);
                const md = (data.mcapDates && data.mcapDates[idx]) ? data.mcapDates[idx] : '';
                if (md) rows.push(`<div style="color:#9ca3af;font-size:11px;">　└ 市值交易日：<span style="float:right;margin-left:16px;">${md}</span></div>`);
              }
            });
            // 同比（仅最新一期展示，与 4 个报告期前比较 = 年距）
            if (idx === labels.length - 1) {
              if (revYoY != null) rows.push(`<div style="margin-top:2px;">营收(TTM) 同比 <span style="float:right;margin-left:16px;color:${revYoY >= 0 ? revColor : mcColor};">${revYoY >= 0 ? '+' : ''}${revYoY}%</span></div>`);
              if (mcYoY != null) rows.push(`<div>总市值 同比 <span style="float:right;margin-left:16px;color:${mcYoY >= 0 ? revColor : mcColor};">${mcYoY >= 0 ? '+' : ''}${mcYoY}%</span></div>`);
            }
            return rows.join('');
          },
        },
        legend: { data: [revName, mcName], textStyle: { color: '#9ca3af' }, top: 4 },
        grid: { left: '10%', right: '12%', top: '44px', bottom: '70px' },
        xAxis: {
          type: 'category', data: labels, scale: true, boundaryGap: false,
          axisLine: { lineStyle: { color: '#2a2f3a' } }, axisLabel: { color: '#9ca3af', fontSize: 10, rotate: labels.length > 8 ? 35 : 0 }, splitLine: { show: false },
        },
        yAxis: [
          {
            type: 'value', scale: true, position: 'left', name: '总营收(TTM，亿元)', nameTextStyle: { color: revColor, fontSize: 10 },
            axisLine: { lineStyle: { color: revColor } }, axisLabel: { color: revColor, fontSize: 10, formatter: (v) => this._formatMarketCap(v) },
            splitLine: { lineStyle: { color: '#2a2f3a' } },
          },
          {
            type: 'value', scale: true, position: 'right', name: '总市值(亿元)', nameTextStyle: { color: mcColor, fontSize: 10 },
            axisLine: { lineStyle: { color: mcColor } }, axisLabel: { color: mcColor, fontSize: 10, formatter: (v) => this._formatMarketCap(v) },
            splitLine: { show: false },
          },
        ],
        dataZoom: [
          { type: 'inside', xAxisIndex: [0], start: 0, end: 100 },
          { type: 'slider', xAxisIndex: [0], show: true, bottom: 4, height: 16, borderColor: '#2a2f3a', fillerColor: 'rgba(127,168,201,0.25)', handleStyle: { color: '#7fa8c9' }, textStyle: { color: '#9ca3af' } },
        ],
        series: [
          {
            name: revName, type: 'line', yAxisIndex: 0, data: revenue, smooth: true, showSymbol: true, symbolSize: 5,
            lineStyle: { width: 2, color: revColor }, itemStyle: { color: revColor }, connectNulls: false,
          },
          {
            name: mcName, type: 'line', yAxisIndex: 1, data: mcap, smooth: true, showSymbol: true, symbolSize: 5,
            lineStyle: { width: 2, color: mcColor }, itemStyle: { color: mcColor }, connectNulls: false,
          },
        ],
      });
    }

    // 卡片下方注释：行业公司总数 / 覆盖度 / 景气度判读 / 口径提示 / 来源
    const noteEl = document.getElementById('indProsperityNote');
    if (noteEl) {
      const l = data.latest || {};
      const verdict = data.verdict;
      const toneCls = (t) => ({ bull: 'up', bear: 'down', neutral: '' }[t] || '');
      const companyCount = data.industryCompanyCount != null ? data.industryCompanyCount : (data.universeCount || 0);
      const chgTxt = (v) => (v == null ? '—' : (v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`));

      const summary = [];
      summary.push(`<div class="sector-cap-summary-item"><span class="sector-cap-summary-label">所属行业</span><span class="sector-cap-summary-value">${this._escape(industryName)}（申万二级）</span></div>`);
      summary.push(`<div class="sector-cap-summary-item"><span class="sector-cap-summary-label">行业公司总数</span><span class="sector-cap-summary-value">${companyCount} 家</span></div>`);
      summary.push(`<div class="sector-cap-summary-item"><span class="sector-cap-summary-label">最新期覆盖</span><span class="sector-cap-summary-value">营收 ${data.coveredRevenue || 0} / 市值 ${data.coveredMarketCap || 0} 家</span></div>`);
      if (l.revenueTTM != null) summary.push(`<div class="sector-cap-summary-item"><span class="sector-cap-summary-label">${l.label || '最新期'} 总营收(TTM)</span><span class="sector-cap-summary-value">${num2(l.revenueTTM)} 亿</span></div>`);
      if (l.marketCap != null) summary.push(`<div class="sector-cap-summary-item"><span class="sector-cap-summary-label">${l.label || '最新期'} 总市值</span><span class="sector-cap-summary-value">${num2(l.marketCap)} 亿</span></div>`);

      const verdictHtml = verdict
        ? `<div class="ind-prosperity-verdict ${toneCls(verdict.tone)}">🌡️ ${this._escape(verdict.tag)}：${this._escape(verdict.text)}</div>`
        : '';

      const caveats = Array.isArray(data.caveats) ? data.caveats : [];
      const caveatHtml = caveats.length
        ? `<div class="ind-prosperity-caveats">⚠️ ${caveats.map(c => this._escape(c)).join(' ')}</div>`
        : '';

      const missingHtml = (Array.isArray(data.missing) && data.missing.length)
        ? `<div class="ind-prosperity-caveats">未纳入合计 ${data.missing.length} 家：${data.missing.map(m => this._escape(m.name || m.code || '')).join('、')}</div>`
        : '';

      noteEl.innerHTML = `
        <div class="sector-cap-summary">${summary.join('')}</div>
        ${verdictHtml}
        ${caveatHtml}
        ${missingHtml}
        <div>数据源：${this._escape(data.source || '东方财富')} · 数据截至 ${data.date || '-'} · 同比基准为 4 个报告期前（年距）</div>`;
    }
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

  // 精确市值（用于 tooltip / 摘要等「读数」场景，保留 2 位小数，避免 1999.89 → "2000亿" 丢精度）
  // 坐标轴刻度仍用 _formatMarketCap（紧凑易读）；两者分工：刻度求简洁、读数求精确。
  _formatMarketCapExact(n) {
    const v = Number(n);
    if (!isFinite(v)) return '--';
    if (Math.abs(v) >= 1e4) return (v / 1e4).toFixed(2) + '万亿';
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

  // ---- 公司研报列表（针对本公司）----
  renderCompanyReportList(list, stockName) {
    const nameEl = document.getElementById('indCompanyReportName');
    if (nameEl && stockName) nameEl.textContent = stockName;
    const el = document.getElementById('indCompanyReportList');
    if (!el) return;
    if (!list || !list.length) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂未获取到近一年针对本公司的券商研报（数据源未提供或网络受限）。</div>';
      return;
    }
    el.innerHTML = `<div class="research-list">${list.slice(0, 50).map((r) => this._renderReportItem(r)).join('')}</div>`;
  },

  // ---- 行业研报列表（所属行业相关）----
  renderReportList(list, induName) {
    const nameEl = document.getElementById('indIndustryReportName');
    if (nameEl) nameEl.textContent = induName || '所属行业';
    const el = document.getElementById('indReportList');
    if (!el) return;
    if (!list || !list.length) {
      el.innerHTML = '<div class="data-empty">⚠️ 暂未获取到近一年的行业研报（数据源未提供或网络受限）。</div>';
      return;
    }
    el.innerHTML = `<div class="research-list">${list.slice(0, 50).map((r) => this._renderReportItem(r)).join('')}</div>`;
  },

  // ---- 单条研报渲染（公司/行业共用）----
  _renderReportItem(r) {
    return `
      <div class="research-item">
        <div class="research-title">${r.title || '（无标题）'}</div>
        <div class="research-meta">
          <span class="research-org">🏛️ ${r.org || '未知机构'}</span>
          ${r.rating ? `<span class="research-rating">评级：${r.rating}</span>` : ''}
          ${r.targetPrice ? `<span class="research-target">目标价：¥${Number(r.targetPrice).toFixed(2)}</span>` : ''}
          ${r.publishDate ? `<span class="research-date">📅 ${r.publishDate}</span>` : ''}
        </div>
      </div>`;
  },

  // 统一初始化 ECharts（先释放旧实例），并把实例挂到 Charts.instances 以便 Tab 切换时 resize
  // 20260913e：容器不可见时（tab 未激活 / 卡片 display:none）宽高为 0，
  //   echarts.init 会退化成 100×100 默认尺寸 → 图表被压成小方块且之后不再恢复。
  //   因此改为：不可见时先挂起 option，等容器真正有宽高后再初始化（轮询重试，最多约 9 秒）。
  _initChart(el, key, option) {
    try {
      // 20260916：ECharts 尚未就绪（脚本仍在下载/被拦截）时，不要直接判为失败——
      // 挂起 option 轮询等待，`echarts` 一出现即初始化，避免 CDN 慢就永久空白。
      if (typeof echarts === 'undefined') {
        el._pendingOption = option; el._pendingKey = key;
        if (el._pendingEchartsTimer) return;
        let tries = 0;
        el._pendingEchartsTimer = setInterval(() => {
          if (typeof echarts !== 'undefined') {
            clearInterval(el._pendingEchartsTimer); el._pendingEchartsTimer = null;
            const opt = el._pendingOption; el._pendingOption = null;
            if (opt) this._initChart(el, el._pendingKey || key, opt);
            return;
          }
          if (++tries > 100) { // ~10s 仍未就绪：给出可诊断的提示（而非笼统的「渲染失败」）
            clearInterval(el._pendingEchartsTimer); el._pendingEchartsTimer = null;
            if (!el._chart) el.innerHTML = '<div class="data-empty">⚠️ 图表库（ECharts）未加载成功，请检查网络后刷新页面。</div>';
          }
        }, 100);
        return;
      }
      if (el._chart) { el._chart.dispose(); el._chart = null; }
      if (window.Charts && Charts.instances && Charts.instances[key]) {
        Charts.instances[key].dispose();
        delete Charts.instances[key];
      }
      const doInit = (opt, k) => {
        const chart = echarts.init(el, 'softDark', { renderer: 'canvas' });
        chart.setOption(opt);
        el._chart = chart;
        if (window.Charts && Charts.instances) Charts.instances[k] = chart;
      };
      const measurable = () => el.clientWidth > 0 && el.clientHeight > 0;

      if (measurable()) { doInit(option, key); return; }

      // 容器尚不可见：缓存 option，等它出现宽高后再初始化
      if (el._pendingInitTimer) { clearTimeout(el._pendingInitTimer); el._pendingInitTimer = null; }
      el._pendingOption = option;
      el._pendingKey = key;
      let tries = 0;
      const retry = () => {
        if (el._pendingInitTimer == null) return;              // 已被取消
        if (!document.body || !document.body.contains(el)) { el._pendingInitTimer = null; return; }
        if (measurable()) {
          el._pendingInitTimer = null;
          const opt = el._pendingOption; const k = el._pendingKey || key;
          el._pendingOption = null;
          if (opt) this._initChart(el, k, opt);
          return;
        }
        if (++tries > 60) {
          // 9 秒内仍未变成可见（用户可能一直没切到本页）：停止轮询，但**保留 _pendingOption**，
          // 交由切到行业 tab 时的 IndustryCharts.reflow() 补初始化，避免图表永久空白。
          el._pendingInitTimer = null;
          return;
        }
        el._pendingInitTimer = setTimeout(retry, 150);
      };
      el._pendingInitTimer = setTimeout(retry, 150);
    } catch (e) {
      console.error('Industry chart init error:', e);
      // 区分「图库缺失」与「真正的渲染错误」，给出可定位的提示
      const libMissing = (typeof echarts === 'undefined');
      el.innerHTML = libMissing
        ? '<div class="data-empty">⚠️ 图表库（ECharts）未加载成功，请检查网络后刷新页面。</div>'
        : `<div class="data-empty">图表渲染失败（${(e && e.message) || e}）。</div>`;
    }
  },

  // tab 切到行业分析页时调用：对「已挂起」或「尺寸为 0」的图表补一次初始化/重算尺寸，
  // 覆盖"数据比 tab 切换更晚到达"与"先隐藏后显示"两类时序。
  reflow() {
    // 20260916：改为遍历行业页内所有图表容器，兼容动态生成的一/二/三级板块市值图（id 带 suffix）。
    const nodes = document.querySelectorAll('#industryContent .chart');
    nodes.forEach((el) => {
      const w = el.clientWidth, h = el.clientHeight;
      if (w <= 0 || h <= 0) return;
      if (el._pendingOption) {
        const opt = el._pendingOption; el._pendingOption = null;
        if (el._pendingInitTimer) { clearTimeout(el._pendingInitTimer); el._pendingInitTimer = null; }
        this._initChart(el, el._pendingKey || el.id, opt);
      } else if (el._chart) {
        try { el._chart.resize(); } catch (e) { /* ignore */ }
      }
    });
  },
};

function policyLevelClass(level) {
  if (!level) return 'neutral';
  if (level.includes('扶持') || level.includes('战略')) return 'support';
  if (level.includes('受限')) return 'restrict';
  return 'neutral';
}
