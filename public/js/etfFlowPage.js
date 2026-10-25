// etfFlowPage.js — 宽基 ETF 申赎独立页（20261025p，用户要求：删除首页页签、保留卡片按钮直达本页）
// 内容自 app.js 的 _renderEtfFlowPane/_loadEtfFlow 整体迁移（渲染逻辑与口径一字不改），
// 数据源 /api/etf-flow，与情绪模型 etfFlow 因子同源。
(function () {
  'use strict';

  let DATA = null;
  let LOADING = false;
  let showAll = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function _fmtShares(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(2) + ' 亿份';
    if (a >= 1e4) return (v / 1e4).toFixed(2) + ' 万份';
    return Math.round(v) + ' 份';
  }
  function _fmtMoney(v, sign) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    let s;
    if (a >= 1e8) s = (v / 1e8).toFixed(2) + ' 亿';
    else if (a >= 1e4) s = (v / 1e4).toFixed(2) + ' 万';
    else s = Math.round(v) + ' 元';
    return sign && v > 0 ? '+' + s : s;
  }
  function _fmtQty(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(2) + ' 亿股';
    if (a >= 1e4) return (v / 1e4).toFixed(2) + ' 万股';
    return Math.round(v).toLocaleString() + ' 股';
  }
  function _fmtBaskets(v) {
    if (v == null || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + (Math.round(v * 100) / 100);
  }
  function _netCls(v) { return v == null ? '' : v > 0 ? 'etf-pos' : v < 0 ? 'etf-neg' : ''; }

  function render(d) {
    const body = document.getElementById('efBody');
    if (!body) return;
    const _rawDate = String((d && d.date) || '');
    const dataDate = /^\d{8}$/.test(_rawDate)
      ? `${_rawDate.slice(0, 4)}-${_rawDate.slice(4, 6)}-${_rawDate.slice(6)}` : _rawDate;
    const dataDateShort = dataDate ? dataDate.slice(5) : '当日';
    if (!d) {
      body.innerHTML = '<div class="etf-empty">📡 正在读取宽基 ETF 申赎数据…<div class="etf-empty-sub">首次读取需向上交所取当日申赎清单（约 2~6 秒），之后 3 分钟内走缓存。</div></div>';
      return;
    }
    if (d.error || d.ok === false) {
      body.innerHTML = `<div class="etf-empty etf-warn">⚠ 宽基 ETF 申赎数据不可用：${esc(d.error || (d.gaps || []).join('；') || '未知原因')}<div class="etf-empty-sub">该因子在情绪模型里已按规则降级（权重归零并分摊），不影响其余因子。</div></div>`;
      return;
    }

    const sum = d.summary || {};
    const etfs = Array.isArray(d.etfs) ? d.etfs : [];
    const stocks = Array.isArray(d.stocks) ? d.stocks : [];
    const groups = Array.isArray(sum.groups) ? sum.groups : [];
    const settled = d.settled === true;
    const effCount = etfs.filter(e => e.netAmount != null).length;
    const nBuy = etfs.filter(e => e.netAmount != null && e.netAmount > 0).length;
    const nSell = etfs.filter(e => e.netAmount != null && e.netAmount < 0).length;
    const totalNet = sum.totalNet;

    let html = '';

    // ① 概览
    html += '<div class="etf-head">';
    html += '<div class="etf-head-row">';
    html += `<span class="etf-k">数据日</span><span class="etf-v">${esc(d.date || '—')}</span>`;
    html += `<span class="etf-k">对比基期</span><span class="etf-v">${esc(d.baseDate || '—')}</span>`;
    html += `<span class="etf-k">口径</span><span class="etf-v">${settled ? '收盘定稿' : '盘中读数（收盘后定稿）'}</span>`;
    html += `<span class="etf-k">有效 ETF</span><span class="etf-v">${effCount} / ${etfs.length} 只</span>`;
    html += '</div>';
    if (totalNet != null) {
      html += `<div class="etf-total ${_netCls(totalNet)}">`
        + `合计 ${totalNet >= 0 ? '净申购' : '净赎回'} <b>${_fmtMoney(Math.abs(totalNet))}</b>`
        + `<span class="etf-total-sub">${nBuy} 只净申购 / ${nSell} 只净赎回 · 累计台账 ${sum.ledgerDays || 0} 个交易日（至 ${esc(sum.ledgerDate || '—')}）</span>`
        + '</div>';
    } else {
      html += `<div class="etf-total flat">${esc(d.reason || '尚无基期快照，无法计算净申赎')}<span class="etf-total-sub">本模块每个交易日收盘后自动留存一份快照（份额 + 全篮成分），下一交易日即可算出净申赎。</span></div>`;
    }
    html += '</div>';

    // ② 家族汇总
    if (groups.length) {
      html += '<div class="etf-groups">';
      groups.forEach(g => {
        html += `<div class="etf-group ${_netCls(g.netAmount)}">`
          + `<span class="etf-group-name">${esc(g.label)}</span>`
          + `<span class="etf-group-net">${g.netAmount >= 0 ? '净申购' : '净赎回'} ${_fmtMoney(Math.abs(g.netAmount))}</span>`
          + `<span class="etf-group-sub">${g.etfCount} 只有效</span>`
          + '</div>';
      });
      html += '</div>';
    }

    // ③ ETF 明细
    if (etfs.length) {
      html += `<div class="etf-block-title">各宽基 ETF 申赎（${etfs.length} 只）· 数据日 ${esc(dataDate || '未知')}</div>`;
      html += '<div class="etf-scroll"><table class="etf-table"><thead><tr>'
        + '<th>代码</th><th>名称</th><th>家族</th><th class="num">最小申赎单位</th><th class="num">基金份额</th>'
        + '<th class="num">份额变动</th><th class="num">篮数</th><th class="num">净申赎额</th><th>备注</th>'
        + '</tr></thead><tbody>';
      etfs.slice().sort((a, b) => (b.netAmount == null ? -1e18 : b.netAmount) - (a.netAmount == null ? -1e18 : a.netAmount))
        .forEach(e => {
          html += `<tr class="${e.netAmount == null ? 'row-dim' : ''}">`
            + `<td class="mono">${esc(e.code)}</td>`
            + `<td class="name">${esc((e.name || '').replace(/交易型开放式指数证券投资基金|交易型开放式指数基金|ETF|交易型开放式/g, '').slice(0, 14) || e.name || '')}</td>`
            + `<td>${esc(e.groupLabel || '')}</td>`
            + `<td class="num">${e.unit != null ? (e.unit / 1e4).toFixed(0) + ' 万份' : '—'}</td>`
            + `<td class="num">${_fmtShares(e.shares)}</td>`
            + `<td class="num ${_netCls(e.dShares)}">${e.dShares == null ? '—' : _fmtShares(e.dShares).replace(/^/, e.dShares > 0 ? '+' : '')}</td>`
            + `<td class="num ${_netCls(e.baskets)}">${_fmtBaskets(e.baskets)}</td>`
            + `<td class="num ${_netCls(e.netAmount)}">${e.netAmount == null ? '—' : _fmtMoney(e.netAmount, true)}</td>`
            + `<td class="note">${esc(e.note || '')}</td>`
            + '</tr>';
        });
      html += '</tbody></table></div>';
    }

    // ④ 逐股明细
    if (stocks.length) {
      const topBuy = stocks.slice().sort((a, b) => (b.dayBuy || 0) - (a.dayBuy || 0)).slice(0, 10);
      const topSell = stocks.slice().sort((a, b) => (a.daySell || 0) - (b.daySell || 0)).slice(0, 10);
      html += `<div class="etf-block-title">被申购 / 被赎回最多的成分股（${esc(dataDate || '数据日未知')}）</div>`;
      html += '<div class="etf-two-col">';
      html += '<div class="etf-col"><div class="etf-col-head etf-pos">▲ 被买入最多（净申购篮子里占比最高）</div>';
      topBuy.filter(s => (s.dayBuy || 0) > 0).forEach(s => {
        html += `<div class="etf-li"><span class="etf-li-name">${esc(s.name || s.code)}<em>${esc(s.code)}</em></span>`
          + `<span class="etf-li-val etf-pos">+${_fmtQty(s.dayBuy)}</span></div>`;
      });
      html += '</div>';
      html += '<div class="etf-col"><div class="etf-col-head etf-neg">▼ 被卖出最多（净赎回篮子里占比最高）</div>';
      topSell.filter(s => (s.daySell || 0) < 0).forEach(s => {
        html += `<div class="etf-li"><span class="etf-li-name">${esc(s.name || s.code)}<em>${esc(s.code)}</em></span>`
          + `<span class="etf-li-val etf-neg">−${_fmtQty(s.daySell)}</span></div>`;
      });
      html += '</div></div>';

      // 全量逐股表（独立页空间充足，默认展开）
      html += `<div class="etf-block-title">全部成分股累计（台账 ${sum.ledgerDays || 0} 个交易日）</div>`;
      html += '<div class="etf-scroll etf-scroll-tall"><table class="etf-table"><thead><tr>'
        + `<th>代码</th><th>名称</th><th>所属宽基</th><th class="num">${esc(dataDateShort)} 买</th><th class="num">${esc(dataDateShort)} 卖</th>`
        + '<th class="num">累计被申购</th><th class="num">累计被赎回</th><th class="num">买/卖天数</th>'
        + '</tr></thead><tbody>';
      stocks.forEach(s => {
        html += '<tr>'
          + `<td class="mono">${esc(s.code)}</td>`
          + `<td class="name">${esc(s.name || '—')}</td>`
          + `<td class="dim">${esc(s.groupLabel || '')}</td>`
          + `<td class="num ${_netCls(s.dayBuy)}">${s.dayBuy ? '+' + _fmtQty(s.dayBuy) : '—'}</td>`
          + `<td class="num ${_netCls(s.daySell)}">${s.daySell ? '−' + _fmtQty(s.daySell) : '—'}</td>`
          + `<td class="num etf-pos">${s.cumBuy ? '+' + _fmtQty(s.cumBuy) : '—'}</td>`
          + `<td class="num etf-neg">${s.cumSell ? '−' + _fmtQty(s.cumSell) : '—'}</td>`
          + `<td class="num dim">${s.buyDays || 0} / ${s.sellDays || 0}</td>`
          + '</tr>';
      });
      html += '</tbody></table></div>';
    }

    // ⑤ 口径与缺口（诚实披露，不允许含糊成"申购了多少"）
    html += '<div class="etf-notes">';
    html += '<div class="etf-note-item"><b>怎么算的：</b>交易所申赎清单（PCF）只说明「一篮子要交哪些股票」，不含实际申赎量；真实申赎看<b>基金总份额变动</b>：Δ份额 ÷ 最小申赎单位 = 篮数，篮数 × 每篮成分股数 = 该股理论增减股数。</div>';
    html += '<div class="etf-note-item etf-warn"><b>必须说清的口径：</b>份额本身是<b>净</b>概念（申购 − 赎回）。本模块只能给出<b>净申赎额</b>与「净申购日 / 净赎回日」的累计，<b>无法拆出申购总量与赎回总量两个绝对数</b>。逐股股数为理论值，实际受现金替代、取整影响会有偏差。</div>';
    html += `<div class="etf-note-item"><b>口径边界：</b>只统计宽基（${groups.map(g => esc(g.label)).join('、') || '—'}）的纯指数复制 ETF；行业/主题/红利/增强/策略类 ETF 已排除（它们的资金流不代表大盘增量资金）。</div>`;
    if (!settled) html += '<div class="etf-note-item etf-warn"><b>盘中提示：</b>当前份额是盘中实时值，此处为预览；15:05 收盘定稿后才计入累计台账，避免把半天进度永久记成全天。</div>';
    if (d.baselineOnly) html += '<div class="etf-note-item etf-warn"><b>基线日：</b>本次是模块第一次留存快照，尚无对比基期；下一交易日起可算出净申赎与逐股增减。</div>';
    const gaps = Array.isArray(d.gaps) ? d.gaps.filter(Boolean) : [];
    if (gaps.length) html += `<div class="etf-note-item etf-warn"><b>数据缺口（${gaps.length}）：</b>${gaps.map(esc).join('；')}</div>`;
    html += '</div>';

    body.innerHTML = html;
  }

  async function load(force) {
    if (LOADING) return;
    LOADING = true;
    const status = document.getElementById('efStatus');
    try {
      const r = await fetch('/api/etf-flow' + (force ? '?refresh=1' : ''), { cache: 'no-store' });
      DATA = await r.json();
    } catch (e) {
      DATA = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    LOADING = false;
    const okFlag = DATA && DATA.ok !== false && !DATA.error;
    if (status) status.textContent = okFlag ? `数据日 ${DATA.date || '—'} · ${DATA.settled ? '收盘定稿' : '盘中读数'}` : '数据不可用';
    const upd = document.getElementById('efUpdated');
    if (upd) upd.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
    render(DATA);
  }

  document.getElementById('efRefresh').addEventListener('click', () => load(true));
  load(false);
})();
