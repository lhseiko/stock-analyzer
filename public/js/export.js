/**
 * Export Module - Export analysis results to HTML or JSON
 */
const Exporter = {

  // Export to JSON
  toJSON(data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    this.download(blob, `stock_analysis_${data.symbol}_${Date.now()}.json`);
  },

  // Export to HTML
  toHTML(data) {
    const html = this.buildHTML(data);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    this.download(blob, `stock_analysis_${data.symbol}_${Date.now()}.html`);
  },

  download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  buildHTML(data) {
    const { quote, technical, fundamental, symbol, name, market } = data;
    const fmt = (n, d = 2) => n === null || n === undefined || isNaN(n) ? '--' : Number(n).toFixed(d);
    const fmtPct = (n, d = 2) => n === null || n === undefined || isNaN(n) ? '--' : (n > 0 ? '+' : '') + Number(n).toFixed(d) + '%';
    const fmtNum = (n) => Storage.formatNumber(n);

    let metricsHTML = '';
    if (fundamental && fundamental.metrics) {
      const m = fundamental.metrics;
      const rows = [
        ['市盈率(PE)', fmt(m.pe)],
        ['市净率(PB)', fmt(m.pb)],
        ['市销率(PS)', fmt(m.ps)],
        ['PEG', fmt(m.peg)],
        ['ROE', fmtPct(m.roe)],
        ['毛利率', fmtPct(m.grossMargin)],
        ['净利率', fmtPct(m.netMargin)],
        ['营收增长', fmtPct(m.revenueGrowth)],
        ['利润增长', fmtPct(m.profitGrowth)],
        ['资产负债率', fmt(m.debtToEquity)],
        ['流动比率', fmt(m.currentRatio)],
        ['股息率', fmtPct(m.dividendYield)],
      ];
      metricsHTML = rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
    }

    let signalsHTML = '';
    if (technical && technical.signals) {
      const s = technical.signals;
      signalsHTML = `
        <tr><td>趋势</td><td>${s.trend}</td></tr>
        <tr><td>RSI信号</td><td>${s.rsiSignal}</td></tr>
        <tr><td>MACD信号</td><td>${s.macdSignal}</td></tr>
        <tr><td>KDJ信号</td><td>${s.kdjSignal}</td></tr>
        <tr><td>布林带位置</td><td>${s.bollPosition}</td></tr>
        <tr><td>成交量趋势</td><td>${s.volumeTrend} (量比${s.volumeRatio})</td></tr>
      `;
    }

    let newsHTML = '';

    const priceColor = quote && quote.change >= 0 ? '#ef4444' : '#22c55e';
    const priceChange = quote ? `${quote.change >= 0 ? '+' : ''}${fmt(quote.change)} (${fmtPct(quote.changePct)})` : '--';

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${name} - 股票分析报告</title>
<style>
  body { font-family: -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif; background: #f0f2f5; color: #1e293b; margin: 0; padding: 20px; }
  .container { max-width: 900px; margin: 0 auto; }
  .header { background: #fff; border-radius: 10px; padding: 24px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .header h1 { font-size: 28px; margin-bottom: 8px; }
  .price { font-size: 36px; font-weight: 700; color: ${priceColor}; }
  .change { font-size: 16px; color: ${priceColor}; }
  .scores { display: grid; grid-template-columns: repeat(2,1fr); gap: 12px; margin-bottom: 16px; }
  .score-card { background: #fff; border-radius: 10px; padding: 20px; text-align: center; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .score-card .label { font-size: 13px; color: #64748b; margin-bottom: 8px; }
  .score-card .value { font-size: 24px; font-weight: 700; }
  .section { background: #fff; border-radius: 10px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
  .section h2 { font-size: 18px; margin-bottom: 16px; padding-bottom: 10px; border-bottom: 2px solid #e2e8f0; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 8px 12px; border-bottom: 1px solid #e2e8f0; }
  td:first-child { color: #64748b; }
  td:last-child { font-weight: 600; text-align: right; }
  .news-item { padding: 12px; border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 8px; }
  .news-header { display: flex; justify-content: space-between; margin-bottom: 4px; }
  .news-title { font-weight: 600; color: #1e293b; text-decoration: none; }
  .news-meta { font-size: 12px; color: #94a3b8; }
  .tag { font-size: 11px; padding: 2px 8px; border-radius: 4px; }
  .tag.pos { background: #fef2f2; color: #ef4444; }
  .tag.neg { background: #f0fdf4; color: #22c55e; }
  .tag.neu { background: #f8fafc; color: #64748b; }
  .footer { text-align: center; color: #94a3b8; font-size: 12px; padding: 20px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>${name} <span style="font-size:14px;color:#94a3b8;">${symbol}</span></h1>
    ${quote ? `<div class="price">¥${fmt(quote.price)}</div><div class="change">${priceChange}</div>` : ''}
    <div style="margin-top:12px;display:flex;gap:16px;color:#64748b;font-size:13px;">
      ${quote?.high ? `<span>最高: ${fmt(quote.high)}</span>` : ''}
      ${quote?.low ? `<span>最低: ${fmt(quote.low)}</span>` : ''}
      ${quote?.open ? `<span>开盘: ${fmt(quote.open)}</span>` : ''}
      ${quote?.turnover ? `<span>换手率: ${fmt(quote.turnover)}%</span>` : ''}
    </div>
  </div>

  <div class="scores">
    <div class="score-card">
      <div class="label">技术面评分</div>
      <div class="value">${technical?.techScore || '--'}</div>
    </div>
    <div class="score-card">
      <div class="label">基本面评分</div>
      <div class="value">${fundamental?.overall || '--'} (${fundamental?.score || 0}/100)</div>
    </div>
  </div>

  ${technical?.signals ? `
  <div class="section">
    <h2>技术面信号</h2>
    <table>${signalsHTML}</table>
  </div>` : ''}

  ${fundamental?.metrics ? `
  <div class="section">
    <h2>基本面指标</h2>
    <table>${metricsHTML}</table>
  </div>` : ''}

  <div class="footer">
    报告生成时间: ${new Date(data.timestamp).toLocaleString('zh-CN')} | 股票投资分析工作台
  </div>
</div>
</body>
</html>`;
  }
};
