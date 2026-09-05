/**
 * Charts Module - ECharts chart rendering
 */

// 注册柔和暗色主题：透明背景、浅灰文字、弱化网格、暗色 tooltip、低饱和调色板
// 面向干眼症 / 强光敏感用户，避免白底与高饱和色块眩光
(function registerSoftDarkTheme() {
  const muted = ['#7fa8c9', '#cf8e8e', '#8fb89a', '#cdab74', '#a99bc4', '#6fb0a4', '#9aa7b0', '#b0a08c'];
  const axisCommon = {
    axisLine: { lineStyle: { color: '#3a424b' } },
    axisTick: { lineStyle: { color: '#3a424b' } },
    axisLabel: { color: '#8b939c' },
    splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } }
  };
  echarts.registerTheme('softDark', {
    color: muted,
    backgroundColor: 'transparent',
    textStyle: { color: '#aeb6be' },
    title: { textStyle: { color: '#c2cad2' }, subtextStyle: { color: '#8b939c' } },
    legend: { textStyle: { color: '#aeb6be' } },
    tooltip: {
      backgroundColor: 'rgba(20,24,28,0.96)',
      borderColor: '#2c333b',
      borderWidth: 1,
      textStyle: { color: '#c2cad2' },
      axisPointer: {
        lineStyle: { color: '#3a424b' },
        crossStyle: { color: '#3a424b' },
        label: { backgroundColor: '#20262d', color: '#c2cad2' }
      }
    },
    categoryAxis: axisCommon,
    valueAxis: axisCommon,
    timeAxis: axisCommon,
    logAxis: axisCommon
  });
})();

const Charts = {
  instances: {},

  // Dispose all charts
  disposeAll() {
    Object.values(this.instances).forEach(c => { try { c.dispose(); } catch {} });
    this.instances = {};
  },

  // Get or create chart instance
  get(id) {
    let el = document.getElementById(id);
    if (!el) return null;
    if (this.instances[id]) { try { this.instances[id].dispose(); } catch {} }
    this.instances[id] = echarts.init(el, 'softDark', { renderer: 'canvas' });
    return this.instances[id];
  },

  // Color scheme
  colors: {
    up: '#F6465D',      // 红涨（阳线/涨幅）
    down: '#0ECB81',    // 绿跌（阴线/跌幅）
    flat: '#8B949E',    // 平盘
    ma5: '#E6EDF3',     // 白
    ma10: '#F0B90B',    // 黄
    ma20: '#A855F7',    // 紫
    ma60: '#22C55E',    // 绿
    ma120: '#8B949E',
    bollUpper: '#F0B90B',
    bollMiddle: '#E6EDF3',
    bollLower: '#3B82F6',
    rsi: '#A855F7',
    rsiOverbought: '#F6465D',
    rsiOversold: '#0ECB81',
    macdDif: '#E6EDF3',   // DIF 白线
    macdSignal: '#F0B90B',// DEA 黄线
    kdjK: '#E6EDF3',
    kdjD: '#F0B90B',
    kdjJ: '#A855F7',
  },

  // 滚动均线：与后端 SMA 同口径，前 n-1 个为空，之后为窗口均值（保留 2 位小数）
  _sma(closes, n) {
    const out = [];
    let sum = 0;
    for (let i = 0; i < closes.length; i++) {
      sum += closes[i];
      if (i >= n) sum -= closes[i - n];
      out.push(i >= n - 1 ? +(sum / n).toFixed(2) : null);
    }
    return out;
  },

  // 蜡烛/量柱配色：阳线红、阴线绿；十字星/一字板按与前收比较着色（涨停一字红、跌停一字绿）
  _candleColor(d, prevClose) {
    if (d.close > d.open) return this.colors.up;
    if (d.close < d.open) return this.colors.down;
    return (d.close >= prevClose) ? this.colors.up : this.colors.down;
  },

  // 成交额：优先真实 amount（元），无则用 收盘价 × 成交量(手) × 100 近似兜底
  _amount(d) {
    if (d.amount != null && !isNaN(d.amount) && d.amount > 0) return d.amount;
    if (d.close != null && !isNaN(d.close)) return d.close * (d.volume || 0) * 100;
    return 0;
  },

  fmtNum(v, d = 2) {
    return (v === null || v === undefined || isNaN(v)) ? '--' : Number(v).toFixed(d);
  },

  // 金额换算：≥1万亿用"万亿"、≥1亿用"亿"、≥1万用"万"
  fmtAmount(v) {
    if (v === null || v === undefined || isNaN(v) || v <= 0) return '--';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + '万亿';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
    if (v >= 1e4) return (v / 1e4).toFixed(2) + '万';
    return v.toFixed(2);
  },

  // 成交量换算（手）
  fmtVolume(v) {
    if (v === null || v === undefined || isNaN(v)) return '--';
    if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿手';
    if (v >= 1e4) return (v / 1e4).toFixed(2) + '万手';
    return Math.round(v) + '手';
  },

  // y 轴简洁刻度
  fmtCompact(v) {
    if (v === null || v === undefined || isNaN(v)) return v;
    const abs = Math.abs(v);
    if (abs >= 1e8) return (v / 1e8).toFixed(1) + '亿';
    if (abs >= 1e4) return (v / 1e4).toFixed(0) + '万';
    return v;
  },

  // Candlestick chart with MA and volume
  candlestick(id, history) {
    const chart = this.get(id);
    if (!chart || !history || !history.length) return;

    const dates = history.map(d => d.date);
    const ohlc = history.map(d => [d.open, d.close, d.low, d.high]);
    const closes = history.map(d => d.close);
    const volumes = history.map(d => d.volume || 0);

    // 实心蜡烛：阳线红、阴线绿，边框同色；十字星/一字板按前收正确着色
    const candleItems = history.map((d, i) => {
      const color = this._candleColor(d, i > 0 ? history[i - 1].close : d.close);
      return { value: ohlc[i], itemStyle: { color, borderColor: color } };
    });

    const series = [{
      name: 'K线',
      type: 'candlestick',
      data: candleItems,
      itemStyle: {
        color: this.colors.up,
        color0: this.colors.down,
        borderColor: this.colors.up,
        borderColor0: this.colors.down,
      },
    }];

    // 均线 MA5/10/20/60：白/黄/紫/绿 1px 细线。
    // 基于「完整历史」滚动计算；缩放(dataZoom)仅为可视裁切，每个点的均线值恒为该点窗口的正确值，缩放不改变数值。
    const maConfigs = [
      { name: 'MA5', n: 5, color: this.colors.ma5 },
      { name: 'MA10', n: 10, color: this.colors.ma10 },
      { name: 'MA20', n: 20, color: this.colors.ma20 },
      { name: 'MA60', n: 60, color: this.colors.ma60 },
    ];
    maConfigs.forEach(m => {
      series.push({
        name: m.name,
        type: 'line',
        data: this._sma(closes, m.n),
        smooth: true,
        lineStyle: { width: 1, color: m.color },
        itemStyle: { color: m.color },
        symbol: 'none',
        z: 3,
      });
    });

    // 成交量副图：红涨绿跌
    series.push({
      name: '成交量',
      type: 'bar',
      xAxisIndex: 1,
      yAxisIndex: 1,
      data: volumes.map((v, i) => ({
        value: v,
        itemStyle: { color: this._candleColor(history[i], i > 0 ? history[i - 1].close : history[i].close) },
      })),
    });

    chart.setOption({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross', label: { backgroundColor: '#20262d', color: '#E6EDF3' } },
        backgroundColor: 'rgba(18,22,28,0.96)',
        borderColor: 'rgba(255,255,255,0.12)',
        borderWidth: 1,
        textStyle: { color: '#E6EDF3', fontSize: 12 },
        formatter: (params) => {
          if (!params || !params.length) return '';
          const p = params.find(x => x.seriesType === 'candlestick') || params[0];
          const i = p.dataIndex;
          if (i == null || !history[i]) return '';
          const d = history[i];
          const prev = i > 0 ? history[i - 1].close : d.open;
          const pct = prev ? ((d.close - prev) / prev) * 100 : 0;
          const c = pct > 0 ? this.colors.up : (pct < 0 ? this.colors.down : this.colors.flat);
          const sign = pct > 0 ? '+' : '';
          const rows = [
            ['开盘', this.fmtNum(d.open)],
            ['最高', this.fmtNum(d.high)],
            ['最低', this.fmtNum(d.low)],
            ['收盘', this.fmtNum(d.close)],
          ];
          let html = `<div style="font-weight:600;margin-bottom:5px;color:#E6EDF3">${d.date}</div>`;
          html += rows.map(r =>
            `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7">
              <span style="color:#8B949E">${r[0]}</span>
              <span style="color:#E6EDF3;font-variant-numeric:tabular-nums">${r[1]}</span>
            </div>`).join('');
          html += `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7">
              <span style="color:#8B949E">涨跌幅</span>
              <span style="color:${c};font-weight:600;font-variant-numeric:tabular-nums">${sign}${pct.toFixed(2)}%</span>
            </div>`;
          html += `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7">
              <span style="color:#8B949E">成交量</span>
              <span style="color:#E6EDF3;font-variant-numeric:tabular-nums">${this.fmtVolume(d.volume)}</span>
            </div>`;
          html += `<div style="display:flex;justify-content:space-between;gap:18px;line-height:1.7">
              <span style="color:#8B949E">成交额</span>
              <span style="color:#E6EDF3;font-variant-numeric:tabular-nums">${this.fmtAmount(this._amount(d))}</span>
            </div>`;
          return html;
        },
      },
      legend: {
        data: ['K线', 'MA5', 'MA10', 'MA20', 'MA60'],
        top: 0,
        textStyle: { fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
      },
      grid: [
        { left: '8%', right: '3%', top: '8%', height: '52%' },
        { left: '8%', right: '3%', top: '65%', height: '13%' },
      ],
      xAxis: [
        { type: 'category', data: dates, scale: true, boundaryGap: false, splitLine: { show: false }, axisLabel: { fontSize: 10 } },
        { type: 'category', gridIndex: 1, data: dates, scale: true, boundaryGap: false, splitLine: { show: false }, axisLabel: { show: false } },
      ],
      yAxis: [
        { scale: true, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.06)' } }, axisLabel: { fontSize: 10 } },
        { gridIndex: 1, splitNumber: 2, axisLabel: { fontSize: 10, formatter: v => this.fmtCompact(v) } },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1], start: 60, end: 100, zoomOnMouseWheel: true, moveOnMouseWheel: false, moveOnMouseMove: true },
        { type: 'slider', xAxisIndex: [0, 1], start: 60, end: 100, height: 16, bottom: 4 },
      ],
      series,
    });

    // 双击复位缩放（滚轮缩放 / 拖拽平移由 inside dataZoom 覆盖）
    this._bindChartGestures(chart);
  },

  // 主图交互：双击复位缩放
  _bindChartGestures(chart) {
    if (!chart) return;
    // 双击复位：恢复初始可视窗口（与 setOption 的 start/end 对齐）
    chart.getZr().off('dblclick');
    chart.getZr().on('dblclick', () => {
      chart.dispatchAction({ type: 'dataZoom', start: 60, end: 100 });
    });
  },

  // 大盘估值趋势：上证50 / 沪深300 / 科创50 近5年PE-TTM
  indexPETrend(id, trendData) {
    const chart = this.get(id);
    if (!chart || !trendData) return;
    const names = ['上证50', '沪深300', '科创50'];
    const colors = ['#7fa8c9', '#cdab74', '#cf8e8e'];
    const items = names.map((n, i) => ({ name: n, color: colors[i], data: trendData[n] })).filter(it => it.data && it.data.series && it.data.series.length);
    if (!items.length) return;

    // 以日期最全的序列为 X 轴
    const xData = items.reduce((max, it) => it.data.series.length > max.length ? it.data.series.map(d => d.date) : max, []);
    const series = items.map((it, i) => ({
      name: it.name,
      type: 'line',
      data: it.data.series.map(d => d.pe),
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 2, color: it.color },
      itemStyle: { color: it.color },
      endLabel: {
        show: true,
        formatter: '{a}',
        color: it.color,
        fontSize: 11,
      },
      markLine: it.data.latest && it.data.latest.pe ? {
        silent: true, symbol: 'none',
        lineStyle: { type: 'dashed', color: it.color, width: 1, opacity: 0.5 },
        label: { show: false },
        data: [{ yAxis: it.data.latest.pe, name: '当前PE' }],
      } : undefined,
    }));

    chart.setOption({
      tooltip: {
        trigger: 'axis',
        backgroundColor: 'rgba(18,22,28,0.96)', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1,
        textStyle: { color: '#E6EDF3', fontSize: 12 },
        formatter: (params) => {
          if (!params || !params.length) return '';
          const date = params[0].axisValue;
          let html = `<div style="font-weight:600;margin-bottom:5px;color:#E6EDF3">${date}</div>`;
          params.forEach(p => {
            const name = p.seriesName;
            const item = trendData[name];
            const s = item.series[p.dataIndex] || item.series[item.series.length - 1] || {};
            html += `<div style="display:flex;align-items:center;gap:8px;line-height:1.7">
              <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color}"></span>
              <span style="color:#8B949E;width:60px">${name}</span>
              <span style="color:#E6EDF3;font-variant-numeric:tabular-nums">PE ${this.fmtNum(p.value, 2)}</span>
              ${s.close ? `<span style="color:#8B949E;font-variant-numeric:tabular-nums">指数 ${this.fmtNum(s.close, 2)}</span>` : ''}
            </div>`;
          });
          return html;
        },
      },
      legend: { data: items.map(it => it.name), top: 0, textStyle: { fontSize: 11 } },
      grid: { left: '8%', right: '8%', top: 40, bottom: 60 },
      xAxis: { type: 'category', data: xData, boundaryGap: false, axisLabel: { fontSize: 10, rotate: 30 } },
      yAxis: { scale: true, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } } },
      dataZoom: [{ type: 'inside', start: 0, end: 100 }, { type: 'slider', start: 0, end: 100, height: 16, bottom: 5 }],
      series,
    });
  },

  // 月线趋势结构图（价格行为·长期视角）：月K + MA + 成交量 + 月线MACD + 长期趋势线
  paMonthly(id, monthly, trendline) {
    const chart = this.get(id);
    if (!chart || !monthly || !monthly.labels || !monthly.labels.length) return;

    const labels = monthly.labels;
    const ohlc = monthly.ohlc;
    const candleItems = ohlc.map((v, i) => {
      const color = v[1] >= v[0] ? this.colors.up : this.colors.down;
      return { value: v, itemStyle: { color, borderColor: color } };
    });

    const maSeries = [
      { name: 'MA5', n: 5, color: this.colors.ma5 },
      { name: 'MA10', n: 10, color: this.colors.ma10 },
      { name: 'MA30', n: 30, color: this.colors.ma20 },
    ].filter(m => monthly['ma' + m.n]).map(m => ({
      name: m.name,
      type: 'line',
      xAxisIndex: 0,
      yAxisIndex: 0,
      data: monthly['ma' + m.n],
      smooth: true,
      showSymbol: false,
      lineStyle: { width: 1, color: m.color },
      itemStyle: { color: m.color },
      z: 3,
    }));

    // 长期上升趋势线：p1 → 当前投影值（trendline.value 为最后一个月的投影价）
    let markLine = undefined;
    if (trendline && trendline.p1) {
      const i1 = labels.indexOf(trendline.p1.date);
      const i2 = labels.indexOf(trendline.p2.date);
      if (i1 >= 0 && i2 >= 0) {
        markLine = {
          silent: true,
          symbol: ['circle', 'arrow'],
          data: [[
            { coord: [i1, trendline.p1.price], symbol: 'circle', symbolSize: 6 },
            { coord: [labels.length - 1, trendline.value], symbol: 'arrow', symbolSize: 6 },
          ]],
          lineStyle: { color: '#F0B90B', type: 'dashed', width: 1.5 },
          label: { formatter: `趋势线 ${this.fmtNum(trendline.value)}`, color: '#F0B90B', fontSize: 10 },
        };
      }
    }

    const series = [
      {
        name: '月K',
        type: 'candlestick',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: candleItems,
        markLine,
      },
      ...maSeries,
      {
        name: '成交量',
        type: 'bar',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: monthly.volumes.map(v => ({
          value: v,
          itemStyle: { color: 'rgba(127,168,201,0.45)' },
        })),
        barWidth: '60%',
      },
    ];

    // 月线 MACD（可选）
    if (monthly.macd && monthly.macd.dif) {
      series.push(
        { name: 'DIF', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: monthly.macd.dif, smooth: true, showSymbol: false, lineStyle: { width: 1, color: this.colors.macdDif } },
        { name: 'DEA', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: monthly.macd.dea, smooth: true, showSymbol: false, lineStyle: { width: 1, color: this.colors.macdSignal } },
        {
          name: 'MACD', type: 'bar', xAxisIndex: 2, yAxisIndex: 2,
          data: monthly.macd.hist.map(v => v == null ? null : { value: v, itemStyle: { color: v >= 0 ? this.colors.up : this.colors.down } }),
        },
      );
    }

    chart.setOption({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'cross' },
        formatter: (ps) => {
          if (!ps || !ps.length) return '';
          const i = ps[0].dataIndex;
          const v = ohlc[i];
          let s = `${labels[i]}<br/>`;
          if (v) s += `开 ${this.fmtNum(v[0])} · 收 ${this.fmtNum(v[1])} · 低 ${this.fmtNum(v[2])} · 高 ${this.fmtNum(v[3])}<br/>`;
          if (monthly.ma5 && monthly.ma5[i] != null) s += `MA5: ${this.fmtNum(monthly.ma5[i])} · MA10: ${this.fmtNum(monthly.ma10[i] || null)} · MA30: ${this.fmtNum(monthly.ma30[i] || null)}<br/>`;
          if (monthly.macd && monthly.macd.dif && monthly.macd.dif[i] != null) s += `月MACD: DIF ${this.fmtNum(monthly.macd.dif[i])} · DEA ${this.fmtNum(monthly.macd.dea[i])} · 柱 ${this.fmtNum(monthly.macd.hist[i])}`;
          return s;
        },
      },
      legend: { data: ['MA5', 'MA10', 'MA30', 'DIF', 'DEA'], top: 0, textStyle: { fontSize: 11 } },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      grid: [
        { left: '8%', right: '3%', top: 30, height: '48%' },
        { left: '8%', right: '3%', top: '62%', height: '10%' },
        { left: '8%', right: '3%', top: '76%', height: '16%' },
      ],
      xAxis: [
        { type: 'category', data: labels, gridIndex: 0, axisLabel: { show: false } },
        { type: 'category', data: labels, gridIndex: 1, axisLabel: { show: false } },
        {
          type: 'category', data: labels, gridIndex: 2,
          axisLabel: { fontSize: 10, interval: (i, v) => v.endsWith('-01') || v.endsWith('-07') },
        },
      ],
      yAxis: [
        { gridIndex: 0, scale: true, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } } },
        { gridIndex: 1, axisLabel: { show: false }, splitLine: { show: false } },
        { gridIndex: 2, scale: true, axisLabel: { fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } } },
      ],
      dataZoom: [
        { type: 'inside', xAxisIndex: [0, 1, 2], start: 40, end: 100 },
        { type: 'slider', xAxisIndex: [0, 1, 2], start: 40, end: 100, height: 16, bottom: 2, handleStyle: { color: '#7fa8c9' } },
      ],
      series,
    });
  },

  // 成交密集区图（价格行为·筹码分布）：横向量价分布 + 现价/阻力带/支撑带标注
  paProfile(id, profile) {
    const chart = this.get(id);
    if (!chart || !profile || !profile.bins || !profile.bins.length) return;

    const bins = profile.bins;
    const cur = profile.currentPrice;
    // 现价所在分档（markLine 用索引定位）
    let curIdx = 0;
    for (let i = 0; i < bins.length; i++) {
      if (cur >= bins[i].low && cur <= bins[i].high) { curIdx = i; break; }
      if (cur > bins[i].high) curIdx = i;
    }
    const volMax = Math.max(...bins.map(b => b.vol));
    const inRes = profile.resistance && profile.resistance.low != null;
    const inSup = profile.support && profile.support.low != null;

    chart.setOption({
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (ps) => {
          if (!ps || !ps.length) return '';
          const b = bins[ps[0].dataIndex];
          if (!b) return '';
          let s = `价格档 ${this.fmtNum(b.low)} ~ ${this.fmtNum(b.high)}<br/>成交占比 ${this.fmtNum(b.pct)}%`;
          if (inRes && b.low >= profile.resistance.low && b.high <= profile.resistance.high) s += '<br/>↑ 长期阻力带';
          if (inSup && b.low >= profile.support.low && b.high <= profile.support.high) s += '<br/>↓ 长期支撑带';
          return s;
        },
      },
      grid: { left: '14%', right: '12%', top: 16, bottom: 40 },
      xAxis: {
        type: 'value',
        name: '成交占比',
        axisLabel: { fontSize: 10, formatter: (v) => this.fmtNum((v / volMax) * 100) + '%' },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: bins.map(b => this.fmtNum((b.low + b.high) / 2)),
        axisLabel: { fontSize: 9, interval: 2 },
      },
      series: [{
        type: 'bar',
        barWidth: '80%',
        data: bins.map(b => {
          // 现价上方 → 套牢阻力（暗红）；现价下方 → 获利支撑（暗绿）；现价档 → 金
          let color = 'rgba(143,184,154,0.65)';
          if (b.low >= cur) color = 'rgba(207,142,142,0.65)';
          else if (b.high <= cur) color = 'rgba(143,184,154,0.65)';
          else color = '#F0B90B';
          if (inRes && b.low >= profile.resistance.low && b.high <= profile.resistance.high) color = '#cf8e8e';
          if (inSup && b.low >= profile.support.low && b.high <= profile.support.high) color = '#8fb89a';
          return { value: b.vol, itemStyle: { color, borderRadius: [0, 2, 2, 0] } };
        }),
        markLine: {
          silent: true,
          symbol: 'none',
          data: [{ yAxis: curIdx }],
          lineStyle: { color: '#F0B90B', type: 'dashed', width: 1.5 },
          label: { formatter: `现价 ${this.fmtNum(cur)}`, color: '#F0B90B', fontSize: 10, position: 'end' },
        },
      }],
    });
  },

  // MACD chart
  macd(id, history, technical) {
    const chart = this.get(id);
    if (!chart || !technical?.series) return;

    const dates = history.map(d => d.date);
    const s = technical.series;

    chart.setOption({
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      legend: { data: ['DIF', 'DEA', 'MACD'], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: '8%', right: '4%', top: 40, bottom: 60 },
      xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
      yAxis: { scale: true, axisLabel: { fontSize: 10 } },
      dataZoom: [{ type: 'inside', start: 60, end: 100 }, { type: 'slider', start: 60, end: 100, height: 20, bottom: 5 }],
      series: [
        {
          name: 'DIF',
          type: 'line',
          data: s.macdDif,
          smooth: true,
          lineStyle: { color: this.colors.macdDif, width: 1.5 },
          symbol: 'none',
        },
        {
          name: 'DEA',
          type: 'line',
          data: s.macdSignal,
          smooth: true,
          lineStyle: { color: this.colors.macdSignal, width: 1.5 },
          symbol: 'none',
        },
        {
          name: 'MACD',
          type: 'bar',
          data: s.macdHistogram.map(v => ({
            value: v,
            itemStyle: { color: v >= 0 ? this.colors.up : this.colors.down }
          })),
        }
      ],
    });
  },

  // RSI chart
  rsi(id, history, technical) {
    const chart = this.get(id);
    if (!chart || !technical?.series) return;

    const dates = history.map(d => d.date);
    const rsiData = technical.series.rsi;

    chart.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: '8%', right: '4%', top: 20, bottom: 60 },
      xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
      yAxis: { min: 0, max: 100, axisLabel: { fontSize: 10 } },
      dataZoom: [{ type: 'inside', start: 60, end: 100 }, { type: 'slider', start: 60, end: 100, height: 20, bottom: 5 }],
      series: [{
        name: 'RSI(14)',
        type: 'line',
        data: rsiData,
        smooth: true,
        lineStyle: { color: this.colors.rsi, width: 1.5 },
        areaStyle: { color: 'rgba(139,92,246,0.08)' },
        symbol: 'none',
        markLine: {
          silent: true,
          data: [
            { yAxis: 70, lineStyle: { color: this.colors.rsiOverbought, type: 'dashed' }, label: { formatter: '70 超买', fontSize: 10 } },
            { yAxis: 30, lineStyle: { color: this.colors.rsiOversold, type: 'dashed' }, label: { formatter: '30 超卖', fontSize: 10 } },
            { yAxis: 50, lineStyle: { color: '#cbd5e1', type: 'dotted' }, label: { formatter: '50', fontSize: 10 } },
          ]
        }
      }],
    });
  },

  // KDJ chart
  kdj(id, history, technical) {
    const chart = this.get(id);
    if (!chart || !technical?.series) return;

    const dates = history.map(d => d.date);
    const s = technical.series;

    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['K', 'D', 'J'], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: '8%', right: '4%', top: 40, bottom: 60 },
      xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
      yAxis: { axisLabel: { fontSize: 10 } },
      dataZoom: [{ type: 'inside', start: 60, end: 100 }, { type: 'slider', start: 60, end: 100, height: 20, bottom: 5 }],
      series: [
        { name: 'K', type: 'line', data: s.kdjK, smooth: true, lineStyle: { color: this.colors.kdjK, width: 1.5 }, symbol: 'none' },
        { name: 'D', type: 'line', data: s.kdjD, smooth: true, lineStyle: { color: this.colors.kdjD, width: 1.5 }, symbol: 'none' },
        { name: 'J', type: 'line', data: s.kdjJ, smooth: true, lineStyle: { color: this.colors.kdjJ, width: 1.5 }, symbol: 'none' },
      ],
    });
  },

  // Bollinger + MA chart
  boll(id, history, technical) {
    const chart = this.get(id);
    if (!chart || !technical?.series) return;

    const dates = history.map(d => d.date);
    const closes = history.map(d => d.close);
    const s = technical.series;

    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['收盘价', 'BOLL上轨', 'BOLL中轨', 'BOLL下轨'], top: 0, textStyle: { fontSize: 11 } },
      grid: { left: '8%', right: '4%', top: 40, bottom: 60 },
      xAxis: { type: 'category', data: dates, axisLabel: { fontSize: 10 } },
      yAxis: { scale: true, axisLabel: { fontSize: 10 } },
      dataZoom: [{ type: 'inside', start: 60, end: 100 }, { type: 'slider', start: 60, end: 100, height: 20, bottom: 5 }],
      series: [
        {
          name: '收盘价',
          type: 'line',
          data: closes,
          smooth: true,
          lineStyle: { color: '#E6EDF3', width: 1.5 },
          symbol: 'none',
          areaStyle: { color: 'rgba(230,237,243,0.04)' },
        },
        {
          name: 'BOLL上轨',
          type: 'line',
          data: s.bollUpper,
          smooth: true,
          lineStyle: { color: this.colors.bollUpper, width: 1, type: 'dashed' },
          symbol: 'none',
        },
        {
          name: 'BOLL中轨',
          type: 'line',
          data: s.bollMiddle,
          smooth: true,
          lineStyle: { color: this.colors.bollMiddle, width: 1 },
          symbol: 'none',
        },
        {
          name: 'BOLL下轨',
          type: 'line',
          data: s.bollLower,
          smooth: true,
          lineStyle: { color: this.colors.bollLower, width: 1, type: 'dashed' },
          symbol: 'none',
        },
      ],
    });
  },

  // Radar chart for fundamental scores
  radar(id, fundamental) {
    const chart = this.get(id);
    if (!chart || !fundamental?.scores) return;

    const scores = fundamental.scores;
    const data = [
      { name: '估值', value: scores.valuation?.score || 0, max: scores.valuation?.max || 25 },
      { name: '盈利能力', value: scores.profitability?.score || 0, max: scores.profitability?.max || 25 },
      { name: '成长性', value: scores.growth?.score || 0, max: scores.growth?.max || 25 },
      { name: '财务健康', value: scores.health?.score || 0, max: scores.health?.max || 25 },
    ];

    chart.setOption({
      tooltip: {},
      radar: {
        indicator: data.map(d => ({ name: d.name, max: d.max })),
        radius: '65%',
        splitArea: { areaStyle: { color: ['rgba(255,255,255,0.02)', 'transparent'] } },
        axisLine: { lineStyle: { color: 'rgba(255,255,255,0.07)' } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,0.07)' } },
        axisName: { color: '#8b939c', fontSize: 13 },
      },
      series: [{
        type: 'radar',
        data: [{
          value: data.map(d => d.value),
          name: '评分',
          areaStyle: { color: 'rgba(127,168,201,0.15)' },
          lineStyle: { color: '#7fa8c9', width: 2 },
          itemStyle: { color: '#7fa8c9' },
        }]
      }]
    });
  },

  // Sentiment gauge
  sentimentGauge(id, sentiment) {
    const chart = this.get(id);
    if (!chart) return;

    const score = sentiment.score;
    const color = score > 10 ? '#cf8e8e' : score < -10 ? '#8fb89a' : '#8b939c';

    chart.setOption({
      series: [{
        type: 'gauge',
        startAngle: 180,
        endAngle: 0,
        min: -100,
        max: 100,
        radius: '90%',
        center: ['50%', '80%'],
        progress: { show: true, width: 14 },
        axisLine: { lineStyle: { width: 14, color: [[0.3, '#8fb89a'], [0.7, '#8b939c'], [1, '#cf8e8e']] } },
        pointer: { width: 4, length: '60%', itemStyle: { color: color } },
        anchor: { show: true, size: 8, itemStyle: { color: color } },
        axisTick: { show: false },
        splitLine: { length: 8, lineStyle: { color: '#cbd5e1' } },
        axisLabel: { distance: 18, fontSize: 10, color: '#8b939c' },
        detail: {
          valueAnimation: true,
          formatter: '{value}',
          fontSize: 20,
          fontWeight: 'bold',
          color: color,
          offsetCenter: [0, '-10%'],
        },
        data: [{ value: score, name: sentiment.overall }]
      }]
    });
  },

  // ---- 期货关联走势：股价与期货归一化曲线叠加 ----
  futuresCorrelation(id, data) {
    const chart = this.get(id);
    if (!chart || !data) return;
    const dates = data.dates || [];
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['股价(归一化)', data.futuresName + '(归一化)'], top: 0 },
      grid: { left: '8%', right: '8%', bottom: '12%', top: '15%' },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', name: '基准=100' },
      series: [
        {
          name: '股价(归一化)',
          type: 'line',
          data: data.stockNorm,
          smooth: true,
          showSymbol: false,
          itemStyle: { color: '#cf8e8e' },
          lineStyle: { width: 2 },
        },
        {
          name: data.futuresName + '(归一化)',
          type: 'line',
          data: data.futuresNorm,
          smooth: true,
          showSymbol: false,
          itemStyle: { color: '#7fa8c9' },
          lineStyle: { width: 2 },
        },
      ],
    });
  },
};
