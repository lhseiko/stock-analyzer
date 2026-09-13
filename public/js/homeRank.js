/* 首页「🏭 基金行业配置名单」卡片
 * 数据源：/api/fund-industry-matrix
 *   全市场权益类公募基金（股票/混合/指数/QDII，按母基金去重）最新报告期【前十大重仓股】
 *   → 个股市值归属行业 → 按【持仓市值（万元）】加总排名。
 *
 * 后端为「后台增量采集 + 磁盘缓存（按季度）」：首次约 1 万只基金需十几分钟，
 * 因此本卡片在采集期间显示进度并自动轮询，采集完成后展示行业排名。
 */
const HomeRank = (() => {
  let loading = false;
  let lastLoad = 0;
  let pollTimer = null;
  const THROTTLE = 4000;
  const POLL_MS = 3000;

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtDateTime(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  function fmtShort(ts) {
    if (!ts) return '—';
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const t = `${p(d.getHours())}:${p(d.getMinutes())}`;
    return sameDay ? `今日 ${t}` : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}`;
  }
  function fmtInt(n) { return Number(n || 0).toLocaleString('zh-CN'); }
  // 持仓市值：万元 → 亿元（<1 亿则显示万元）
  function fmtValue(yi, wan) {
    if (yi == null) return '—';
    if (yi >= 1) return yi.toFixed(2) + ' 亿';
    if (wan != null) return Math.round(wan) + ' 万';
    return yi.toFixed(3) + ' 亿';
  }
  function fmtDuration(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    if (sec < 60) return Math.round(sec) + ' 秒';
    return Math.round(sec / 60) + ' 分钟';
  }
  // 环比增减：带正负号的亿元（增持=红 / 减持=绿，遵循 A 股习惯）
  function fmtSignedYi(v) {
    if (v == null || !isFinite(v)) return '—';
    const s = v > 0 ? '+' : (v < 0 ? '−' : '');
    return s + Math.abs(v).toFixed(2) + ' 亿';
  }
  function fmtSignedPct(v) {
    if (v == null || !isFinite(v)) return '';
    const s = v > 0 ? '+' : (v < 0 ? '−' : '');
    return s + Math.abs(v).toFixed(2) + '%';
  }
  // 环比变化单元格：无基数（新进榜/上季为 0）不硬造百分比
  function changeCell(ind) {
    if (ind.name === '未分类') return '<span class="fmr-chg-na">—</span>';
    const v = ind.changeYi;
    if (v == null || !isFinite(v)) return '<span class="fmr-chg-na">—</span>';
    if (v === 0) return '<span class="fmr-chg-num fmr-chg-flat">0.00 亿</span>';
    const cls = v > 0 ? 'fmr-up' : 'fmr-down';
    const arrow = v > 0 ? '▲' : '▼';
    const pct = ind.changePct == null ? '<span class="fmr-chg-pct"></span>'
      : `<span class="fmr-chg-pct">${fmtSignedPct(ind.changePct)}</span>`;
    return `<span class="fmr-chg-num ${cls}">${arrow} ${fmtSignedYi(v)}</span>${pct}`;
  }

  // 「自然季度更新」状态条：目标报告期 / 披露状态 / 更新进度 / 上下次检查时间
  function quarterView(data) {
    const q = data.quarter || {}, c = data.coverage || {}, p = data.progress || {};
    const running = !!p.running;
    const total = c.universe || 0;
    const updated = c.fundsAtTarget != null ? c.fundsAtTarget : (q.updatedTo || 0);
    const comparable = c.fundsComparable || 0;
    const pct = total ? Math.min(100, updated / total * 100) : 0;

    let icon, badge, badgeCls, sub;
    if (q.done) {
      icon = '✅'; badge = '本季度已完成'; badgeCls = 'fmr-qb-done';
      sub = `${q.targetLabel} 报告已全部更新完成，当前展示即为该季度全量结果；下一自然季度开始后自动进入下一轮检查。`;
    } else if (q.published) {
      icon = running ? '⏳' : '🕗';
      badge = running ? '分批更新中' : (q.lastRunDate ? '已跑完本日批次' : '待启动批次');
      badgeCls = 'fmr-qb-run';
      sub = `东财已开始披露 ${q.targetLabel} 报告，按批次推进（每批上限 ${fmtInt(q.dailyBatch)} 只）。`
          + `已更新 ${fmtInt(updated)} / ${fmtInt(total)} 只，${running ? '本轮进行中' : `剩余 ${fmtInt(q.remaining < 0 ? 0 : q.remaining)} 只待披露或待更新，次日继续`}。`;
    } else if (q.inWindow) {
      icon = '🔍'; badge = '等待披露'; badgeCls = 'fmr-qb-wait';
      sub = `东财尚未开始披露 ${q.targetLabel} 报告，每日自动检查一次，披露后立即分批更新。`;
    } else {
      icon = '🔄'; badge = '新季度启动中'; badgeCls = 'fmr-qb-wait';
      sub = `已进入 ${q.naturalQuarterLabel}，目标报告期切换为 ${q.targetLabel}，将在下次检查时开始。`;
    }

    const lastProbe = q.lastProbeLabel ? `上次检查：东财最新 ${q.lastProbeLabel}` : '上次检查：—';
    return `
      <div class="fmr-quarter">
        <div class="fmr-q-head">
          <span class="fmr-q-title">${icon} 自然季度更新 · ${escapeHtml(q.naturalQuarterLabel || '')} → 目标报告期 <b>${escapeHtml(q.targetLabel || '—')}</b></span>
          <span class="fmr-q-badge ${badgeCls}">${escapeHtml(badge)}</span>
        </div>
        <div class="fmr-bar"><div class="fmr-bar-in" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="fmr-q-meta">
          <span>本季已更新 ${fmtInt(updated)} / ${fmtInt(total)} 只母基金（${pct.toFixed(1)}%）</span>
          <span>可算环比样本 ${fmtInt(comparable)} 只</span>
          <span>${running ? '正在执行本批采集' : ''}</span>
        </div>
        <div class="fmr-q-meta fmr-q-time">
          <span>${escapeHtml(lastProbe)}</span>
          <span>${q.lastRunDate ? '上次执行：' + escapeHtml(q.lastRunDate) : '上次执行：尚未执行'}</span>
          <span>下次检查：${escapeHtml(fmtShort(q.nextCheckAt))}（每日 ${String(q.dailyHour == null ? 19 : q.dailyHour).padStart(2, '0')}:00）</span>
        </div>
        <div class="fmr-prog-hint">${escapeHtml(sub)}</div>
      </div>`;
  }

  // 采集中的实时进度（仅 running 时显示）
  function progressView(data) {
    const c = data.coverage || {}, p = data.progress || {};
    const total = c.universe || p.total || 0;
    // 进度用「本轮已完成数」而非「有缓存的基金数」：季度更新时大多数条目早已存在，
    // 用 covered 会让进度条看起来卡住不动（历史踩坑）。
    const done = (p.done != null && p.done > 0) ? p.done : (c.covered || 0);
    const pct = total ? Math.min(100, done / total * 100) : 0;
    const ind = p.industry || {};
    const indTotal = c.stocks || ind.total || 0;
    const indDone = c.industryResolved != null ? c.industryResolved : (ind.done || 0);
    const indPct = indTotal ? Math.min(100, indDone / indTotal * 100) : 0;
    const phaseLabel = {
      universe: '读取基金列表', holdings: '采集基金前十大重仓股',
      industry: '解析个股所属行业（收尾）', batch: '本批已到时间预算，暂停', done: '已完成',
      error: '出错', stopped: '已暂停',
    }[p.phase] || '准备中';

    return `
      <div class="fmr-prog">
        <div class="fmr-prog-head">
          <span class="fmr-prog-title">${p.phase === 'error' ? '⚠️ 采集中断' : '⏳ 正在采集全市场基金持仓'}</span>
          <span class="fmr-prog-num">当前阶段：${escapeHtml(phaseLabel)}</span>
        </div>
        <div class="fmr-bar"><div class="fmr-bar-in" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="fmr-prog-meta">
          <span>已采集 ${fmtInt(done)} / ${fmtInt(total)}（${pct.toFixed(1)}%，累计口径）</span>
          <span>行业解析 ${fmtInt(indDone)} / ${fmtInt(indTotal)}（${indPct.toFixed(1)}%）</span>
          ${p.rate ? `<span>速率 ${p.rate}/秒</span>` : ''}
          ${p.etaSec != null && p.running ? `<span>预计剩余约 ${fmtDuration(p.etaSec)}</span>` : ''}
          ${p.remaining >= 0 ? `<span>本季待更新 ${fmtInt(p.remaining)} 只</span>` : ''}
          ${p.failed ? `<span class="fmr-warn">取数失败 ${p.failed}</span>` : ''}
          ${p.lastError ? `<span class="fmr-warn">${escapeHtml(p.lastError)}</span>` : ''}
        </div>
        <div class="fmr-prog-hint">全量约 1 万只母基金，首次采集需十几分钟；此后按自然季度每日检查、分批更新，直到本季度全部更新完毕。下方仅展示前 20 名行业，排名会随进度实时刷新。</div>
      </div>`;
  }

  function summaryView(data) {
    const c = data.coverage || {};
    // 全市场重仓市值环比（最新季 − 上一季）
    const curYi = c.totalMarketValueYi, prevYi = c.prevTotalMarketValueYi;
    let qoqVal = '—', qoqCls = 'fmr-chg-flat';
    if (curYi != null && prevYi != null && prevYi > 0) {
      const d = curYi - prevYi;
      qoqVal = (d > 0 ? '+' : (d < 0 ? '−' : '')) + Math.abs(d).toFixed(0) + ' 亿';
      qoqCls = d > 0 ? 'fmr-up' : (d < 0 ? 'fmr-down' : 'fmr-chg-flat');
    }
    const kpi = [
      [fmtInt(c.fundsComparable), '环比样本（两期齐全）'],
      [fmtInt(c.universe), '纳入母基金'],
      [fmtInt(c.stocks), '重仓个股'],
      [curYi != null ? curYi.toFixed(0) + ' 亿' : '—', '可比口径合计市值'],
      [`<span class="${qoqCls}">${escapeHtml(qoqVal)}</span>`, '合计市值环比'],
      [fmtInt((data.industries || []).filter(i => i.name !== '未分类').length), '已归类行业'],
    ];
    return `<div class="fmr-kpis">${kpi.map(([v, l]) =>
      `<div class="fmr-kpi"><div class="fmr-kpi-v">${v}</div><div class="fmr-kpi-l">${escapeHtml(l)}</div></div>`).join('')}</div>`;
  }

  function rowView(ind, idx) {
    const yi = ind.marketValueYi;
    const isUnresolved = ind.name === '未分类';
    const barW = Math.max(1.5, Math.min(100, ind.share || 0));
    const tops = (ind.topStocks || []).slice(0, 5);
    return `<tr class="fmr-row ${isUnresolved ? 'fmr-row-unres' : ''}">
      <td class="fmr-rank ${idx < 3 ? 'fmr-rank-top' : ''}">${isUnresolved ? '—' : idx + 1}</td>
      <td class="fmr-ind"><span class="fmr-ind-name">${escapeHtml(ind.name)}${isUnresolved ? '<span class="fmr-badge">行业待解析</span>' : ''}</span>
        <span class="fmr-ind-sub">${fmtInt(ind.fundCount)} 只基金 · ${fmtInt(ind.stockCount)} 只个股</span></td>
      <td class="fmr-val">
        <div class="fmr-val-num">${fmtValue(yi, ind.marketValue)}</div>
        <div class="fmr-val-bar"><i style="width:${barW.toFixed(1)}%"></i></div>
      </td>
      <td class="fmr-chg">${changeCell(ind)}</td>
      <td class="fmr-share">${(ind.share || 0).toFixed(2)}%</td>
      <td class="fmr-tops">${tops.map(s =>
        `<span class="fmr-chip" title="合计持仓市值 ${fmtValue(s.marketValue / 10000, s.marketValue)} · 被 ${s.fundCount} 只基金重仓">${escapeHtml(s.name)}<b>${fmtValue(s.marketValue / 10000, s.marketValue)}</b></span>`).join('')}</td>
    </tr>`;
  }

  const TOP_N = 20;

  function rankView(data) {
    const all = data.industries || [];
    if (!all.length) {
      return `<div class="ai-empty">尚无聚合结果。${data.progress && data.progress.running ? '数据采集进行中，稍候自动刷新…' : '可点击「刷新」启动采集。'}</div>`;
    }
    // 只展示前 20 名；「未分类」不参与排名，单独置底（采集中会逐步被解析掉）
    const resolved = all.filter(i => i.name !== '未分类');
    const unresolved = all.filter(i => i.name === '未分类');
    const rows = resolved.slice(0, TOP_N);
    const cur = data.periodLabel || data.period || '最新期';
    const prev = data.prevPeriodLabel || data.prevPeriod || '上一期';
    const hasPrev = (data.coverage && data.coverage.fundsComparable) > 0;
    const chgHint = hasPrev ? `${prev} → ${cur}（同批基金）` : '上一季度数据待补齐';
    const moreHint = resolved.length > TOP_N
      ? `<div class="fmr-more">共 ${fmtInt(resolved.length)} 个行业，此处仅展示前 ${TOP_N} 名。</div>` : '';
    return `<div class="fmr-table-wrap"><table class="fmr-table">
      <thead><tr>
        <th class="fmr-th-rank">#</th><th>行业</th><th>持仓市值（加总）</th>
        <th class="fmr-th-chg">环比变化<i>${escapeHtml(chgHint)}</i></th>
        <th>占比</th><th>行业内 Top 重仓股</th>
      </tr></thead>
      <tbody>${rows.map((ind, i) => rowView(ind, i)).join('')}
      ${unresolved.map((ind, i) => rowView(ind, rows.length + i)).join('')}</tbody>
    </table></div>${moreHint}`;
  }

  function render(data) {
    const body = document.getElementById('rankBody');
    if (!body) return;
    const updEl = document.getElementById('rankUpdated');
    const c = data.coverage || {}, q = data.quarter || {};
    if (updEl) {
      const parts = [];
      if (data.periodLabel) parts.push('📊 ' + data.periodLabel + '（环比 ' + (data.prevPeriodLabel || '—') + '）');
      else if (data.period) parts.push('📊 ' + data.period);
      if (q.done) parts.push('本季度已更新完成');
      else if (q.published) parts.push('本季已更新 ' + fmtInt(c.fundsAtTarget) + '/' + fmtInt(c.universe));
      else if (q.inWindow) parts.push('等待东财披露 ' + (q.targetLabel || ''));
      parts.push('环比样本 ' + fmtInt(c.fundsComparable));
      parts.push('更新 ' + fmtDateTime(new Date()));
      updEl.textContent = parts.join(' · ');
    }

    const running = data.progress && data.progress.running;
    let html = '';
    html += quarterView(data);
    if (running) html += progressView(data);
    if (c.fundsComparable > 0) html += summaryView(data);
    html += rankView(data);
    if (data.note) {
      html += `<div class="rank-note">📌 ${escapeHtml(data.note)}<div style="margin-top:4px;color:var(--text-light);">仅供研究参考，不构成投资建议。</div></div>`;
    }
    body.innerHTML = html;
  }

  function schedulePoll() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => { pollTimer = null; load(true); }, POLL_MS);
  }

  async function load(force) {
    const now = Date.now();
    if (loading) return;
    if (!force && now - lastLoad < THROTTLE) return;
    loading = true;
    lastLoad = now;
    const body = document.getElementById('rankBody');
    if (body && !body.querySelector('.fmr-table') && !body.querySelector('.fmr-quarter')) {
      body.innerHTML = '<div class="ai-empty">正在获取全市场基金行业配置名单…</div>';
    }
    try {
      const resp = await fetch('/api/fund-industry-matrix?_=' + Date.now(), { cache: 'no-store' });
      const data = await resp.json();
      if (data && data.success !== false && data.ok !== false) {
        render(data);
        // 采集进行中 / 本季度尚未更新完成 → 继续轮询（让分批推进实时可见）
        const q = data.quarter || {};
        if ((data.progress && data.progress.running) || (q.published && !q.done)) schedulePoll();
      } else if (body) {
        body.innerHTML = `<div class="ai-empty">基金行业配置获取失败：${escapeHtml((data && data.error) || '暂无数据')}</div>`;
      }
    } catch (e) {
      if (body) body.innerHTML = `<div class="ai-empty">基金行业配置获取失败：${escapeHtml(e.message)}</div>`;
    } finally {
      loading = false;
    }
  }

  // 刷新：先触发/继续采集，再拉取结果
  async function refresh() {
    const btn = document.getElementById('rankRefresh');
    const prev = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '🔄 刷新中…'; }
    try {
      await fetch('/api/fund-industry-matrix/crawl', { method: 'POST' });
    } catch (e) { /* 忽略，继续拉取 */ }
    lastLoad = 0;
    await load(true);
    if (btn) { btn.disabled = false; btn.textContent = prev || '🔄 刷新'; }
  }

  function bind() {
    const btn = document.getElementById('rankRefresh');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => refresh());
    }
  }

  return { load, refresh, bind };
})();
