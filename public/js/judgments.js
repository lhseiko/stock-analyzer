/* ============================================================
 * 个股行情判断记录 · 准确率核对页
 * ------------------------------------------------------------
 * 独立页面，列出所有「当日个股涨跌判断」记录，并用原始数据
 * 独立重算：综合分 / 方向 / 命中判定 / 整体准确率，与工作台
 * 存储值逐项比对，任何不一致都标红，方便人工核查准确率是否算错。
 * 重算算法严格对齐 lib/sameDayJudgment.js（combineFactors / settleRecord / computeAccuracy）。
 * ============================================================ */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const STATE = { records: [], accuracy: null, learning: null, loaded: false, filterText: '', filterTag: 'all', symbolScope: null, symbolName: '' };

  // ---------- 基础工具 ----------
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function fmtMD(s) {
    const p = String(s || '').split('-');
    return p.length >= 3 ? `${+p[1]}月${+p[2]}日` : (s || '');
  }
  function round1(x) { return Math.round(x * 10) / 10; }

  // 归一化代码：去掉 SH/SZ/BJ/HK 前缀与 .SS/.SZ 后缀，便于与自选股一致比对
  function normSymbol(s) {
    return String(s || '').replace(/^(SH|SZ|BJ|HK)/i, '').replace(/\.(SS|SZ|BJ|HK)$/i, '').toUpperCase();
  }
  // 读取自选股（与工作台共用 localStorage 键）
  function getWatchlistSymbols() {
    try {
      const raw = localStorage.getItem('stock_analyzer_watchlist');
      if (!raw) return [];
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr.map(x => normSymbol(x.symbol)).filter(Boolean) : [];
    } catch (e) { return []; }
  }
  function isWatchlist(symbol) {
    return getWatchlistSymbols().includes(normSymbol(symbol));
  }

  // 读取 URL 中的 ?symbol= 参数（从个股分析页「查看该股判断记录」进入）
  function getQuerySymbol() {
    try {
      const p = new URLSearchParams(location.search);
      const s = p.get('symbol');
      return s ? s.trim() : '';
    } catch (e) { return ''; }
  }

  // 个股视图：显示横幅，并切换「自我进化」面板为该股票专属权重（同时保留全样本对照）
  function applySymbolScope() {
    const banner = $('symbolBanner');
    const learningCard = $('learningCard');
    const filter = $('filterInput');
    if (STATE.symbolScope) {
      if (banner) {
        banner.style.display = '';
        banner.innerHTML = `<span class="jd-sb-label">📌 个股视图：<b>${escapeHtml(STATE.symbolName || STATE.symbolScope)}</b>（${escapeHtml(STATE.symbolScope)}）的判断记录、准确率与<b>专属权重进化</b></span>` +
          `<a href="judgments.html" class="jd-sb-all">查看全部股票记录 →</a>` +
          `<span class="jd-sb-note">自我进化面板已切换为该股票专属权重（下方含全样本对照）</span>`;
      }
      if (learningCard) learningCard.style.display = '';
      if (filter) filter.placeholder = '按日期 / 方向筛选…';
    } else {
      if (banner) banner.style.display = 'none';
      if (learningCard) learningCard.style.display = '';
      if (filter) filter.placeholder = '按股票代码 / 名称筛选…';
    }
  }

  function arrow(sig) {
    if (sig > 0) return '<span class="jd-pos">▲ 偏多</span>';
    if (sig < 0) return '<span class="jd-neg">▼ 偏空</span>';
    return '<span class="jd-neu">— 中性</span>';
  }
  // 影响程度评分：优先用后端下发的 impactScore（唯一权威源），旧记录缺失时按 signal 现算。
  function impactOf(f) {
    if (!f) return 0;
    if (typeof f.impactScore === 'number') return f.impactScore;
    // 旧记录兜底：与后端 ruleCore.toImpactScore 同口径
    // （对称舍入 + 方向保底，避免 -0.5 被舍成 -1 而 +0.5 舍成 +2 的正负不对称）
    const sig = (typeof f.signal === 'number') ? f.signal : 0;
    const raw = Math.max(-3, Math.min(3, sig * 3));
    let s = raw >= 0 ? Math.round(raw) : -Math.round(-raw);
    if (s === 0 && Math.abs(sig) >= 0.02) s = sig > 0 ? 1 : -1;
    return s;
  }
  // 影响程度徽章：红=利好 +n / 绿=利空 -n / 灰=中性 0（与个股页判断逻辑框同款、同口径）
  function impactBadge(f) {
    const s = impactOf(f);
    const cls = s > 0 ? 'pos' : s < 0 ? 'neg' : 'neu';
    const label = s > 0 ? '利好' : s < 0 ? '利空' : '中性';
    const sign = s > 0 ? '+' : '';
    return `<span class="sd-impact ${cls}" title="影响程度评分：${label} ${sign}${s}（±3 为最强；红=利好，绿=利空）">${label} ${sign}${s}</span>`;
  }
  function matchBadge(ok, okText, badText) {
    return ok
      ? `<span class="jd-match jd-ok">✅ ${okText || '一致'}</span>`
      : `<span class="jd-match jd-bad">⚠️ ${badText || '不一致'}</span>`;
  }

  // ---------- 独立重算（对齐后端 sameDayJudgment.js）----------
  // 综合分 / 方向：combineFactors 中 total = Σ(effectiveWeight*signal) = Σ contribution
  function recomputeScore(factors) {
    const used = (factors || []).filter(f => f.applicable);
    let total = 0;
    for (const f of used) total += (typeof f.contribution === 'number' ? f.contribution : 0);
    total = Math.round(total * 1000) / 1000;
    let dir = '震荡';
    if (total > 0.12) dir = '涨';
    else if (total < -0.12) dir = '跌';
    return { total, dir, score: Math.round(total * 100) };
  }
  // 命中判定：对齐 settleRecord.correct
  function recomputeCorrect(r) {
    if (!r.settled) return null;
    if (r.dir === '震荡') return Math.abs(r.actualChgPct || 0) <= 1.0;
    return r.dir === r.actualDir;
  }
  // 准确率统计：对齐 computeAccuracy，但 correct 用本页重算值（以便暴露存储错误）
  function recomputeAccuracy(records) {
    const settled = records.filter(r => r.settled);
    const total = settled.length;
    const correct = settled.filter(recomputeCorrect).length;
    const today = (function () { const d = new Date(); const p = x => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
    const pending = records.filter(r => !r.settled);
    const overdue = pending.filter(r => r.targetDate && r.targetDate < today);
    const byDir = { 涨: { t: 0, c: 0 }, 跌: { t: 0, c: 0 }, 震荡: { t: 0, c: 0 } };
    const byTarget = { intraday: { t: 0, c: 0 }, nextday: { t: 0, c: 0 } };
    for (const r of settled) {
      const ok = recomputeCorrect(r);
      if (byDir[r.dir]) { byDir[r.dir].t++; if (ok) byDir[r.dir].c++; }
      const tgt = r.target === 'nextday' ? 'nextday' : 'intraday';
      byTarget[tgt].t++; if (ok) byTarget[tgt].c++;
    }
    const rate = p => p.t ? round1(p.c / p.t * 100) : null;
    return {
      total, correct, pendingCount: pending.length, overdueCount: overdue.length,
      accuracy: total ? round1(correct / total * 100) : null,
      bullRate: rate(byDir['涨']), bearRate: rate(byDir['跌']), flatRate: rate(byDir['震荡']),
      intradayRate: rate(byTarget['intraday']), nextdayRate: rate(byTarget['nextday']),
    };
  }

  // 单条记录的不一致检查
  function checkRecord(r) {
    const rc = recomputeScore(r.factors);
    const mismatches = [];
    if (r.score !== rc.score) mismatches.push(`综合分 存储${r.score} / 重算${rc.score}`);
    if (r.dir !== rc.dir) mismatches.push(`方向 存储${r.dir} / 重算${rc.dir}`);
    let correctMismatch = false;
    if (r.settled) {
      const rec = recomputeCorrect(r);
      if (rec !== r.correct) { correctMismatch = true; mismatches.push(`命中 存储${r.correct ? '✓' : '✗'} / 重算${rec ? '✓' : '✗'}`); }
    }
    return { rc, mismatches, mismatch: mismatches.length > 0, correctMismatch };
  }

  // ---------- 加载 ----------
  async function loadData(settle) {
    const qSym = getQuerySymbol();
    STATE.symbolScope = qSym || null;
    showLoading(settle ? '正在结算并拉取最新判断（可能稍慢）…' : '正在加载判断记录…');
    try {
      const params = [];
      if (qSym) params.push('symbol=' + encodeURIComponent(qSym));
      if (settle) params.push('settle=1');
      const url = '/api/sameday-judgment/records' + (params.length ? ('?' + params.join('&')) : '');
      const resp = await fetch(url, { cache: 'no-store' });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || '加载失败');
      STATE.records = Array.isArray(data.records) ? data.records : [];
      STATE.accuracy = data.accuracy || null;
      STATE.learning = data.learning || null;
      STATE.loaded = true;
      if (STATE.symbolScope) STATE.symbolName = data.symbolName || STATE.symbolScope;
      applySymbolScope();
      render();
      hideLoading();
    } catch (e) {
      hideLoading();
      $('recordList').innerHTML = `<div class="jd-empty">加载失败：${escapeHtml(e.message)}</div>`;
      $('accuracyBody').innerHTML = '';
      $('accVerify').innerHTML = '';
    }
  }

  function showLoading(text) {
    const o = $('loadingOverlay'); if (!o) return;
    o.classList.remove('hidden');
    if (text && $('loadingText')) $('loadingText').textContent = text;
  }
  function hideLoading() {
    const o = $('loadingOverlay'); if (o) o.classList.add('hidden');
  }

  // ---------- 渲染：准确率核对 ----------
  function renderAccuracy() {
    const be = STATE.accuracy;
    const fe = recomputeAccuracy(STATE.records);
    const body = $('accuracyBody');
    const verify = $('accVerify');
    if (!be) {
      body.innerHTML = '<div class="jd-empty">暂无准确率数据</div>';
      verify.innerHTML = '';
      return;
    }
    const accOk = be.accuracy === fe.accuracy;
    const bullOk = be.bullRate === fe.bullRate;
    const bearOk = be.bearRate === fe.bearRate;
    const flatOk = be.flatRate === fe.flatRate;
    const nextOk = be.nextdayRate === fe.nextdayRate;
    const allOk = accOk && bullOk && bearOk && flatOk && nextOk;

    const num = (x) => (x == null ? '—' : x + '%');

    const overdueWarn = (be.overdueCount || fe.overdueCount)
      ? `<div class="acc-overdue-warn">⚠️ 存在 <b>${be.overdueCount || fe.overdueCount}</b> 条「目标交易日已过却仍未结算」的判断，它们被排除在准确率分母之外，会造成准确率虚高。请点「结算并刷新」强制结算后核查。</div>`
      : '';
    const denomLine = `<div class="acc-denom">共 <b>${be.totalRecords}</b> 条判断 · 已结算 <b>${be.settledCount}</b> 次（命中 ${be.correct} 次）· 待结算 <b>${be.pendingCount}</b> 条${be.overdueCount ? ` · <span class="acc-overdue-num">过期未结算 ${be.overdueCount} 条</span>` : ''}</div>
      <div class="acc-basis">📐 准确率口径：<b>预测方向（涨/跌/震荡）</b> 对比 <b>实际次日收盘涨跌方向</b>；命中＝方向一致，震荡以涨跌绝对值≤1% 计。</div>`;

    body.innerHTML = `
      ${overdueWarn}
      ${denomLine}
      <div class="acc-grid">
        <div class="acc-cell acc-primary">
          <div class="acc-cell-label">总体准确率（已结算 ${be.settledCount} 次 · 命中 ${be.correct} 次）</div>
          <div class="acc-cell-row">
            <span class="acc-store">存储 ${num(be.accuracy)}</span>
            <span class="acc-vs">vs</span>
            <span class="acc-fe">重算 ${num(fe.accuracy)}</span>
            ${matchBadge(accOk)}
          </div>
        </div>
        <div class="acc-cell">
          <div class="acc-cell-label">看涨命中率</div>
          <div class="acc-cell-row"><span class="acc-store">${num(be.bullRate)}</span><span class="acc-vs">vs</span><span class="acc-fe">${num(fe.bullRate)}</span>${matchBadge(bullOk)}</div>
        </div>
        <div class="acc-cell">
          <div class="acc-cell-label">看跌命中率</div>
          <div class="acc-cell-row"><span class="acc-store">${num(be.bearRate)}</span><span class="acc-vs">vs</span><span class="acc-fe">${num(fe.bearRate)}</span>${matchBadge(bearOk)}</div>
        </div>
        <div class="acc-cell">
          <div class="acc-cell-label">震荡命中率</div>
          <div class="acc-cell-row"><span class="acc-store">${num(be.flatRate)}</span><span class="acc-vs">vs</span><span class="acc-fe">${num(fe.flatRate)}</span>${matchBadge(flatOk)}</div>
        </div>
        <div class="acc-cell">
          <div class="acc-cell-label">下一交易日命中率</div>
          <div class="acc-cell-row"><span class="acc-store">${num(be.nextdayRate)}</span><span class="acc-vs">vs</span><span class="acc-fe">${num(fe.nextdayRate)}</span>${matchBadge(nextOk)}</div>
        </div>
      </div>`;

    if (allOk) {
      verify.className = 'acc-verify ok';
      verify.innerHTML = '✅ 本页用原始数据独立重算，与工作台存储的准确率完全一致。';
    } else {
      verify.className = 'acc-verify bad';
      verify.innerHTML = '⚠️ 发现存储值与重算值不一致！请展开下方记录逐项核对（标红处即为差异来源）。';
    }
    const upd = $('accUpdated');
    if (upd) upd.textContent = `数据更新：${new Date().toLocaleString('zh-CN')}`;
  }

  // ---------- 渲染：单条记录卡片 ----------
  function recCardHtml(r) {
    const check = checkRecord(r);
    const dirCls = r.dir === '涨' ? 'jd-bull' : r.dir === '跌' ? 'jd-bear' : 'jd-flat';
    const statusCls = r.settled ? 'jd-settled' : 'jd-pending';
    const statusTxt = r.settled ? '✅ 已结算' : '⏳ 待结算';
    const warnBadge = check.mismatch ? `<span class="jd-warn" title="${escapeHtml(check.mismatches.join('；'))}">⚠️ 不一致</span>` : '';
    const wlBadge = isWatchlist(r.symbol) ? '<span class="jd-wl-badge">⭐ 自选</span>' : '';
    const targetLabel = r.target === 'nextday' ? '下一交易日' : '历史盘中（旧记录）';
    const confCls = r.confidence === '高' ? 'jd-conf-high' : r.confidence === '中' ? 'jd-conf-mid' : 'jd-conf-low';

    const factorRows = (r.factors || [])
      .filter(f => f.applicable)
      .map(f => {
        const eff = (f.effectiveWeight != null ? f.effectiveWeight : 0) * 100;
        const contrib = (typeof f.contribution === 'number' ? f.contribution : 0) * 100;
        const contribTxt = (contrib >= 0 ? '+' : '') + contrib.toFixed(2);
        const signCls = f.signal > 0 ? 'jd-pos' : f.signal < 0 ? 'jd-neg' : 'jd-neu';
        return `<tr>
          <td class="jd-fname">${escapeHtml(f.name)} ${impactBadge(f)}</td>
          <td>${arrow(f.signal)}</td>
          <td class="jd-num">${eff.toFixed(0)}%</td>
          <td class="jd-num ${signCls}">${contribTxt}</td>
        </tr>`;
      }).join('');

    // 重算汇总
    const scoreMatch = r.score === check.rc.score;
    const dirMatch = r.dir === check.rc.dir;
    const scoreLine = `综合分 重算 <b>${check.rc.score}</b> ｜ 存储 ${r.score} ${matchBadge(scoreMatch)}`;
    const dirLine = `方向 重算 <b>${check.rc.dir}</b> ｜ 存储 ${r.dir} ${matchBadge(dirMatch)}`;
    const totalLine = `Σ贡献分 = ${check.rc.total}`;

    // 核心因子摘要（按 |贡献分| 排序取前 3，让「逻辑」在收起状态也可见）
    const topFactors = (r.factors || [])
      .filter(f => f.applicable)
      .slice()
      .sort((a, b) => Math.abs(b.contribution || 0) - Math.abs(a.contribution || 0))
      .slice(0, 3);
    const reasonSummary = topFactors.map(f => {
      const c = (typeof f.contribution === 'number' ? f.contribution : 0) * 100;
      const ct = (c >= 0 ? '+' : '') + c.toFixed(2);
      const a = f.signal > 0 ? '▲' : f.signal < 0 ? '▼' : '—';
      const cls = f.signal > 0 ? 'jd-pos' : f.signal < 0 ? 'jd-neg' : 'jd-neu';
      return `<span class="jd-reason-item"><b>${escapeHtml(f.name)}</b> ${impactBadge(f)} <span class="${cls}">${a}${ct}</span></span>`;
    }).join('<span class="jd-reason-sep">·</span>');

    // 结论区（常驻可见）：命中/错误 + 次日实际收盘涨跌
    let conclusionHtml;
    if (r.settled) {
      const rec = recomputeCorrect(r);
      const actualChg = (r.actualChgPct >= 0 ? '+' : '') + r.actualChgPct + '%';
      const actualCls = r.actualDir === '涨' ? 'jd-bull' : r.actualDir === '跌' ? 'jd-bear' : 'jd-flat';
      const conclCls = (r.correct === rec) && r.correct ? 'jd-hit' : 'jd-miss';
      conclusionHtml = `
        <span class="jd-concl ${r.correct ? 'jd-hit' : 'jd-miss'}">${r.correct ? '✅ 命中' : '❌ 判断错误'}</span>
        <span class="jd-concl-sub">次日实际 <b class="${actualCls}">${actualChg}</b>（${r.actualDir}）</span>
        <span class="jd-concl-basis">（${escapeHtml(r.actualBaselineLabel || '')} ${r.actualBaseline != null ? r.actualBaseline : '—'} → ${escapeHtml(r.actualTargetLabel || '')} ${r.actualClose != null ? r.actualClose : '—'}）</span>`;
    } else {
      conclusionHtml = `<span class="jd-concl jd-wait">⏳ 待结算</span><span class="jd-concl-sub">${targetLabel}收盘后按次日实际涨跌结算</span>`;
    }

    // 结算核对（展开明细）
    let settleHtml = '';
    if (r.settled) {
      const rec = recomputeCorrect(r);
      const settleBasis = r.target === 'nextday' ? '次日收盘 vs 今日收盘' : '今日收盘 vs 判断时价';
      const actualChg = (r.actualChgPct >= 0 ? '+' : '') + r.actualChgPct + '%';
      const actualCls = r.actualDir === '涨' ? 'jd-bull' : r.actualDir === '跌' ? 'jd-bear' : 'jd-flat';
      settleHtml = `
        <div class="jd-settle-box">
          <div class="jd-settle-title">📊 结算核对（结合次日收盘涨跌，口径：${settleBasis}）</div>
          <div class="jd-settle-row">
            <span>${escapeHtml(r.actualTargetLabel || '实际')} <b class="${actualCls}">${actualChg}</b>（实际${r.actualDir}）</span>
            <span>基线：${escapeHtml(r.actualBaselineLabel || '')} ${r.actualBaseline != null ? r.actualBaseline : '—'}</span>
          </div>
          <div class="jd-settle-row">
            <span>命中判定：存储 <b>${r.correct ? '正确✓' : '错误✗'}</b> ｜ 重算 <b>${rec ? '正确✓' : '错误✗'}</b> ${matchBadge(rec === r.correct)}</span>
          </div>
        </div>`;
    } else {
      const settleBasis = r.target === 'nextday' ? '次日收盘 vs 今日收盘' : '今日收盘 vs 判断时价';
      settleHtml = `<div class="jd-settle-box jd-pending-box"><div class="jd-settle-row"><span>⏳ 待结算（口径：${settleBasis}）。收盘且 K 线生成后自动结算，或点上方「结算并刷新」。</span></div></div>`;
    }

    const mismatchCls = check.mismatch ? ' jd-rec-mismatch' : '';
    const wlCls = wlBadge ? ' jd-rec-wl' : '';

    return `<div class="jd-rec${mismatchCls}${wlCls}" data-symbol="${escapeHtml(r.symbol)}">
      <div class="jd-rec-head" data-toggle>
        <div class="jd-rec-row1">
          <span class="jd-rec-name">${escapeHtml(r.name || r.symbol)}</span>
          <span class="jd-rec-code">${escapeHtml(r.symbol)}</span>
          ${wlBadge}
          ${r.industry ? `<span class="jd-rec-ind">${escapeHtml(r.industry)}</span>` : ''}
        </div>
        <div class="jd-rec-row2">
          <span class="jd-rec-date">📅 判断 <b>${fmtMD(r.date)}</b></span>
          <span class="jd-rec-target">→ 目标 <b>${fmtMD(r.targetDate || r.date)}</b>（${targetLabel}）</span>
          <span class="jd-verdict ${dirCls}">结论：${r.verdict || r.dir}</span>
          <span class="jd-conf ${confCls}">${r.confidence}置信</span>
          <span class="jd-rec-score">分 ${r.score > 0 ? '+' : ''}${r.score}</span>
          <span class="jd-status ${statusCls}">${statusTxt}</span>
          ${warnBadge}
        </div>
        <div class="jd-rec-row3">
          ${conclusionHtml}
        </div>
        <div class="jd-rec-row4">
          <span class="jd-reason-label">🧠 判断逻辑（核心因子）：</span>
          <span class="jd-reason">${reasonSummary || '无因子数据'}</span>
          <span class="jd-caret">展开完整 6 因子 ▾</span>
        </div>
      </div>
      <div class="jd-rec-detail" style="display:none">
        <div class="jd-factors">
          <table class="jd-factor-tbl">
            <thead><tr><th>因子</th><th>信号</th><th>归一化权重</th><th>贡献分</th></tr></thead>
            <tbody>${factorRows || '<tr><td colspan="4" class="jd-empty">无因子数据</td></tr>'}</tbody>
          </table>
        </div>
        <div class="jd-recompute">
          <div class="jd-rec-title">🧮 独立重算（与存储值比对）</div>
          <div class="jd-rec-line">${scoreLine}</div>
          <div class="jd-rec-line">${dirLine}</div>
          <div class="jd-rec-line jd-dim">${totalLine}</div>
        </div>
        ${settleHtml}
      </div>
    </div>`;
  }

  // ---------- 渲染：错误分析 & 自我进化 ----------
  function renderLearning() {
    const L = STATE.learning;
    const body = $('learningBody');
    if (!body) return;
    if (!L) { body.innerHTML = '<div class="jd-empty">暂无学习数据</div>'; return; }
    const upd = $('learnUpdated');
    if (upd) upd.textContent = `本地判断记录库 · 已学习 ${L.learnedCount || 0} 条`;

    const perSym = (STATE.symbolScope && L.bySymbol) ? L.bySymbol : null;

    // 通用：因子命中率条 HTML
    function relBarsHtml(arr) {
      return (arr || []).map(f => {
        const pct = f.correctRate == null ? null : f.correctRate;
        const barW = pct == null ? 0 : pct;
        const cls = pct == null ? 'learn-bar-na' : (pct >= 60 ? 'learn-bar-good' : pct >= 45 ? 'learn-bar-mid' : 'learn-bar-bad');
        return `<div class="learn-rel-row">
          <span class="learn-rel-name">${escapeHtml(f.name)}</span>
          <span class="learn-rel-bar"><span class="learn-rel-fill ${cls}" style="width:${barW}%"></span></span>
          <span class="learn-rel-val">${pct == null ? '—' : pct + '%'}<span class="learn-rel-sub">（${f.hits}/${f.total}）</span></span>
        </div>`;
      }).join('');
    }
    // 通用：权重演进表 HTML
    function wTableHtml(arr) {
      return (arr || []).map(w => {
        const dev = (w.current - w.default);
        const devCls = Math.abs(dev) >= 0.01 ? (dev > 0 ? 'learn-up' : 'learn-down') : '';
        const devTxt = Math.abs(dev) < 0.005 ? '—' : (dev > 0 ? '▲' : '▼') + ' ' + Math.abs(Math.round(dev * 100)) + '%';
        const pct = x => (Math.round(x * 1000) / 10) + '%';
        const cell = (v) => `<td class="learn-w-cell ${Math.abs(v - w.default) >= 0.01 ? 'learn-w-dev' : ''}">${pct(v)}</td>`;
        return `<tr>
          <td class="learn-w-name">${escapeHtml(w.name)}</td>
          <td>${pct(w.default)}</td>
          <td class="${devCls}">${pct(w.current)} <span class="learn-dev">${devTxt}</span></td>
          ${cell(w.byVerdict['涨'])}
          ${cell(w.byVerdict['跌'])}
          ${cell(w.byVerdict['震荡'])}
        </tr>`;
      }).join('');
    }
    // 通用：错误归因 HTML
    function errListHtml(errs) {
      if (!errs || !errs.length) return '<div class="jd-empty">暂无判断错误记录 🎉</div>';
      return errs.map(e => {
        const dirCls = e.actualDir === '涨' ? 'jd-bull' : e.actualDir === '跌' ? 'jd-bear' : 'jd-flat';
        const mis = (e.misleading || []).map(m => `<span class="learn-mis-item">${escapeHtml(m.name)}<span class="jd-neg"> ${m.signal > 0 ? '▲误多' : '▼误空'}</span></span>`).join('');
        return `<div class="learn-err-item">
          <div class="learn-err-head"><b>${escapeHtml(e.name || e.symbol)}</b> <span class="learn-err-date">${fmtMD(e.date)}→${fmtMD(e.targetDate)}</span>
            <span class="learn-err-verdict">预测 ${e.verdict}</span>
            <span class="learn-err-actual ${dirCls}">实际 ${e.actualDir} ${(e.actualChgPct >= 0 ? '+' : '') + (e.actualChgPct || 0)}%</span></div>
          <div class="learn-err-mis">误导因子：${mis || '（无明显单一误导因子，多为综合偏弱）'}</div>
        </div>`;
      }).join('');
    }

    // ---- 该股票专属进化块（个股视图且存在该股票学习数据）----
    let symBlock = '';
    if (perSym) {
      if (perSym.exists) {
        const symNote = perSym.sampleEnough
          ? `<span class="learn-ok">✅ 该股票样本充足，已启用专属权重比（按该股自身准确率独立进化）</span>`
          : `<span class="learn-warn">⏳ 该股票样本积累中（每因子需 ≥10 条），暂沿用全局/默认权重；继续积累后将生成专属权重比</span>`;
        const symErrs = (L.recentErrors || []).filter(e => normSymbol(e.symbol) === normSymbol(STATE.symbolScope)).slice(0, 8);
        symBlock = `
          <div class="learn-sym">
            <div class="learn-status">🎯 <b>该股票专属权重进化</b>（${escapeHtml(STATE.symbolName || STATE.symbolScope)} · ${escapeHtml(STATE.symbolScope)}）${symNote}</div>
            <div class="learn-cols">
              <div class="learn-col">
                <div class="learn-col-title">📊 该股票各因子命中率（仅该股样本）</div>
                <div class="learn-rel">${relBarsHtml(perSym.factorReliability) || '<div class="jd-empty">—</div>'}</div>
              </div>
              <div class="learn-col">
                <div class="learn-col-title">⚖️ 该股票权重演进（默认 → 该股当前，按该股预测方向分别调整）</div>
                <table class="learn-w-tbl">
                  <thead><tr><th>因子</th><th>默认</th><th>该股当前</th><th>看涨时</th><th>看跌时</th><th>震荡时</th></tr></thead>
                  <tbody>${wTableHtml(perSym.weightEvolution)}</tbody>
                </table>
              </div>
            </div>
            <div class="learn-err-title">❌ 该股票判断错误归因（共 ${symErrs.length} 条）</div>
            <div class="learn-err-list">${errListHtml(symErrs)}</div>
          </div>`;
      } else {
        symBlock = `<div class="learn-sym"><div class="learn-status">🎯 <b>该股票专属权重进化</b>：${escapeHtml(perSym.note || '暂无数据')}</div></div>`;
      }
    }

    // ---- 全样本（跨所有股票）对照块 ----
    // 个股视图：只展示该股票自身的错误归因，避免其他个股记录污染当前页面。
    const inSymbolScope = !!STATE.symbolScope;
    const sampleNote = L.sampleEnough
      ? `<span class="learn-ok">✅ 全样本充足，自适应权重已按预测方向生效</span>`
      : `<span class="learn-warn">⏳ 全样本积累中（每因子需 ≥10 条），暂以默认权重运行；继续积累后将自动调整因子权重</span>`;
    const globalErrs = inSymbolScope ? [] : (L.recentErrors || []).slice(0, 8);
    const divider = perSym ? `<div class="learn-divider">— 全样本对照（跨所有股票）—</div>` : '';
    const globalErrBlock = inSymbolScope
      ? ''
      : `<div class="learn-err-title">❌ 最近判断错误归因（共 ${(L.recentErrors || []).length} 条）</div>
         <div class="learn-err-list">${errListHtml(globalErrs)}</div>`;

    body.innerHTML = `
      ${symBlock}
      ${divider}
      <div class="learn-status">${sampleNote}</div>
      <div class="learn-cols">
        <div class="learn-col">
          <div class="learn-col-title">📊 各因子命中率（方向判断是否与真实一致）</div>
          <div class="learn-rel">${relBarsHtml(L.factorReliability) || '<div class="jd-empty">—</div>'}</div>
        </div>
        <div class="learn-col">
          <div class="learn-col-title">⚖️ 权重演进（默认 → 当前，按预测方向分别调整）</div>
          <table class="learn-w-tbl">
            <thead><tr><th>因子</th><th>默认</th><th>当前全局</th><th>看涨时</th><th>看跌时</th><th>震荡时</th></tr></thead>
            <tbody>${wTableHtml(L.weightEvolution)}</tbody>
          </table>
        </div>
      </div>
      ${globalErrBlock}
      <div class="learn-note">📌 数据来源：本工作台判断记录库（本地已结算记录，按目标交易日累积）。<br>💡 机制：每笔判断结算后记录各因子的方向命中情况，自适应降低「常误导」因子的权重；下一笔判断将按预测方向使用对应权重。权重带平滑与样本下限，避免小样本抖动。<br>🎯 个股专属：每只股票根据自身历史准确率独立进化各自的因子权重比，不再受其他股票样本影响。<br>📝 计分规则：同一股票同一目标交易日只计一次判断；收盘后至下一开盘前多次刷新以开盘前最后一次为准。</div>
    `;
  }

  // ---------- 渲染：列表 + 筛选 ----------
  function filterRecords() {
    const text = STATE.filterText.trim().toLowerCase();
    const tag = STATE.filterTag;
    return STATE.records.filter(r => {
      if (tag === 'settled' && !r.settled) return false;
      if (tag === 'pending' && r.settled) return false;
      if (tag === 'mismatch' && !checkRecord(r).mismatch) return false;
      if (text) {
        const hay = `${r.name || ''} ${r.symbol || ''}`.toLowerCase();
        if (!hay.includes(text)) return false;
      }
      return true;
    });
  }

  function render() {
    renderAccuracy();
    renderLearning(); // 始终渲染：个股视图展示该股票专属权重 + 全样本对照，全部视图展示全样本
    // 排序：自选股置顶（按自选顺序）→ 其余；同组内判断日期降序，未结算优先
    const wlSyms = getWatchlistSymbols();
    const isWL = (r) => wlSyms.includes(normSymbol(r.symbol));
    const sorted = STATE.records.slice().sort((a, b) => {
      const aw = isWL(a), bw = isWL(b);
      if (aw !== bw) return aw ? -1 : 1; // 自选股整体在前
      if (aw && bw) {
        const ia = wlSyms.indexOf(normSymbol(a.symbol));
        const ib = wlSyms.indexOf(normSymbol(b.symbol));
        if (ia !== ib) return ia - ib; // 保持自选股加入顺序
      }
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      if (a.settled !== b.settled) return a.settled ? 1 : -1;
      return String(a.symbol) < String(b.symbol) ? -1 : 1;
    });
    STATE.records = sorted;
    const list = filterRecords();
    const cnt = $('recordCount');
    if (cnt) cnt.textContent = `共 ${STATE.records.length} 条 · 显示 ${list.length} 条`;
    const box = $('recordList');
    box.innerHTML = list.length
      ? list.map(recCardHtml).join('')
      : '<div class="jd-empty">没有符合条件的判断记录</div>';
  }

  // ---------- 事件 ----------
  function bindEvents() {
    const list = $('recordList');
    if (list) {
      list.addEventListener('click', (e) => {
        const head = e.target.closest('.jd-rec-head');
        if (!head) return;
        const detail = head.parentElement.querySelector('.jd-rec-detail');
        const caret = head.querySelector('.jd-caret');
        if (detail) {
          const open = detail.style.display === 'none';
          detail.style.display = open ? '' : 'none';
          if (caret) caret.textContent = open ? '▴' : '▾';
        }
      });
    }
    const filter = $('filterInput');
    if (filter) filter.addEventListener('input', (e) => { STATE.filterText = e.target.value; render(); });
    document.querySelectorAll('.jd-tag').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.jd-tag').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.filterTag = btn.dataset.filter;
        render();
      });
    });
    const rs = $('refreshSettleBtn');
    if (rs) rs.addEventListener('click', () => loadData(true));
    const rc = $('recheckBtn');
    if (rc) rc.addEventListener('click', () => { if (STATE.loaded) render(); else loadData(false); });
  }

  // ---------- 启动 ----------
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    loadData(false);
  });
})();
