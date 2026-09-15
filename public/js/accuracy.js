/**
 * 分析准确率检查页（20260914i）
 * 数据源：
 *   GET /api/market-tech/records               → 大盘技术分析（短期/中期/融合 三套统计 + 逐条记录）
 *   GET /api/tech-face/records                 → 个股技术面（全站汇总 + 各股明细）
 *   GET /api/tech-face/records?symbol=X        → 单只个股逐条记录
 *   GET /api/sameday-judgment/records          → 短期行情判断（全站汇总）
 *   GET /api/sameday-judgment/records?symbol=X → 单只个股逐条记录
 *   GET /api/sentiment-accuracy/records        → 市场情绪提醒（情绪拐点预警）
 * 与本页「重算」的关系：本页直接展示后端统计，同时**独立复算**关键比率做交叉校验（对齐 judgments.js 的思路）。
 */
(function () {
  const state = { tab: 'market', market: null, tech: null, techSymbol: null, sameDay: null, sdSymbol: null, sentiment: null };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function pct(v) { return v == null ? '—' : v + '%'; }
  function cls(v) { return v == null ? 'na' : v >= 60 ? 'good' : v >= 45 ? 'mid' : 'bad'; }
  function dirCls(d) { return d === '涨' ? 'up' : d === '跌' ? 'down' : 'side'; }

  function kpi(label, value, sub, klass) {
    return `<div class="acc-kpi ${klass || ''}"><div class="k-label">${esc(label)}</div><div class="k-value">${value}</div><div class="k-sub">${esc(sub || '')}</div></div>`;
  }

  // 独立复算：从记录重算命中率，与后端值比对
  function recompute(records, predKey, settledKey, correctKey) {
    const withPred = records.filter(r => r[predKey]);
    const settled = withPred.filter(r => r[settledKey]);
    const c = settled.filter(r => r[correctKey]).length;
    return { total: settled.length, correct: c, rate: settled.length ? Math.round(c / settled.length * 1000) / 10 : null };
  }

  function verify(label, stored, recomputed) {
    const ok = stored == null && recomputed == null ? true
      : (stored == null || recomputed == null) ? (stored == null && recomputed == null)
      : Math.abs(stored - recomputed) < 0.05;
    return ok ? `<span class="jd-ok">✓ ${esc(label)} 一致（${pct(stored)}）</span>`
      : `<span class="jd-bad">✗ ${esc(label)} 不一致：存储 ${pct(stored)} vs 重算 ${pct(recomputed)}</span>`;
  }

  function renderMarket() {
    const d = state.market;
    if (!d) return;
    const a = d.accuracy;
    const s = a.short, m = a.mid, f = a.fusion;
    document.getElementById('flatTol').textContent = a.flatTolerance;
    document.getElementById('marketKpis').innerHTML = [
      kpi('短期方向准确率', pct(s.accuracy), `${s.correct}/${s.settledCount} 命中 · 待验证 ${s.pendingCount}`, cls(s.accuracy)),
      kpi('中期方向准确率', pct(m.accuracy), `${m.correct}/${m.settledCount} 命中 · 待验证 ${m.pendingCount}`, cls(m.accuracy)),
      kpi('融合信号准确率', pct(f.accuracy), `${f.correct}/${f.settledCount} 命中`, cls(f.accuracy)),
      kpi('判断总条数', String(a.totalRecords), a.horizonLabel, ''),
      kpi('过期未结算', String(s.overdueCount), s.overdueCount > 0 ? '需核查结算口径' : '无', s.overdueCount > 0 ? 'na' : ''),
    ].join('');

    // 分方向 + 置信度校准
    const confRows = [
      ['高置信', s.confHighRate, s.confHighTotal],
      ['中置信', s.confMidRate, s.confMidTotal],
      ['低置信', s.confLowRate, s.confLowTotal],
    ];
    const dirRows = [
      ['看涨', s.bullRate, s.bullTotal],
      ['看跌', s.bearRate, s.bearTotal],
      ['看震荡', s.flatRate, s.flatTotal],
    ];
    const bar = (rows) => rows.map(([n, r, t]) => t
      ? `<span class="mt-acc-chip ${cls(r)}"><span class="mac-label">${n}</span><span class="mac-value">${pct(r)}</span><span class="mac-sub">${t} 次</span></span>`
      : `<span class="mt-acc-chip muted"><span class="mac-label">${n}</span><span class="mac-value">无样本</span></span>`).join(' ');
    let calib = `<b>分方向</b> ${bar(dirRows)}`;
    if (s.confHighTotal > 0) {
      const high = s.confHighRate, low = s.confLowRate;
      let note = '';
      if (high != null && low != null) {
        note = high > low ? '（高置信比低置信更准，置信度有区分力 ✓）' : '（高置信并未更准，置信度标定待改进 ⚠️）';
      }
      calib += `<br><b>分置信度</b> ${bar(confRows)}${note}`;
    }
    document.getElementById('marketCalib').innerHTML = calib;

    // 交叉校验
    const vShort = recompute(d.records, 'shortDir', 'shortSettled', 'shortCorrect');
    const vMid = recompute(d.records, 'midDir', 'midSettled', 'midCorrect');
    document.getElementById('marketCount').innerHTML =
      `${d.records.length} 条 · ` + verify('短期', s.accuracy, vShort.rate) + ' · ' + verify('中期', m.accuracy, vMid.rate);

    // 逐条记录
    document.getElementById('marketRecords').innerHTML = d.records.length
      ? `<div class="jd-rec-list">${d.records.map(r => `
          <div class="jd-rec">
            <div class="jd-rec-head">
              <span class="jd-rec-sym">${esc(r.baseDate)}</span>
              <span class="jd-rec-name">${esc(r.benchName || '')} ${esc(r.baseClose)}</span>
              <span class="jd-rec-date">→ ${esc(r.targetDate || '')}</span>
            </div>
            <div class="jd-rec-body">
              <div class="jd-rec-row"><b>短期</b> ${esc(r.shortVerdict || '—')}
                ${r.shortSettled ? `<span class="jd-${r.shortCorrect ? 'ok' : 'bad'}">${r.shortCorrect ? '✓ 命中' : '✗ 未中'}（实际${esc(r.shortActualDir)} ${r.shortActualChgPct}%）</span>` : '<span class="jd-pending">待验证</span>'}</div>
              <div class="jd-rec-row"><b>中期</b> ${esc(r.midVerdict || '—')}（${r.midTargetIndex} 交易日）
                ${r.midSettled ? `<span class="jd-${r.midCorrect ? 'ok' : 'bad'}">${r.midCorrect ? '✓ 命中' : '✗ 未中'}（实际${esc(r.midActualDir)} ${r.midActualChgPct}%）</span>` : '<span class="jd-pending">待验证</span>'}</div>
              <div class="jd-rec-row"><b>融合</b> ${esc(r.fusionSignal || '—')} · 置信度 ${esc(r.confidence || '—')} · ${esc(r.positionText || '')}</div>
            </div>
          </div>`).join('')}</div>`
      : '<div class="data-empty">暂无记录。打开首页「大盘技术分析」卡片、收盘后即会自动记录一条。</div>';
  }

  function renderTech() {
    const d = state.tech;
    if (!d) return;
    const a = d.accuracy;
    document.getElementById('techKpis').innerHTML = [
      kpi('全站技术面准确率', pct(a.accuracy), `${a.correct}/${a.settledCount} 命中`, cls(a.accuracy)),
      kpi('覆盖个股', String(a.symbolCount || 0), '只', ''),
      kpi('待验证', String(a.pendingCount), '条', ''),
      kpi('过期未结算', String(a.overdueCount), a.overdueCount > 0 ? '需核查' : '无', a.overdueCount > 0 ? 'na' : ''),
      kpi('分方向', `涨 ${pct(a.bullRate)} / 跌 ${pct(a.bearRate)}`, `震荡 ${pct(a.flatRate)}（涨${a.bullTotal}/跌${a.bearTotal}/震${a.flatTotal}）`, ''),
    ].join('');
    document.getElementById('techCount').textContent = `${(d.bySymbol || []).length} 只`;

    document.getElementById('techBySymbol').innerHTML = (d.bySymbol || []).length
      ? `<div class="jd-rec-list">${d.bySymbol.map(s => `
          <div class="jd-rec">
            <div class="jd-rec-head">
              <span class="jd-rec-sym">${esc(s.symbol)}</span>
              <span class="jd-rec-name">${esc(s.name || '')}</span>
              <span class="jd-rec-date">${s.settledCount} 已结算 / ${s.pendingCount} 待验证</span>
            </div>
            <div class="jd-rec-body">
              <div class="jd-rec-row">准确率 <b>${pct(s.accuracy)}</b>（${s.correct}/${s.settledCount}） · 涨 ${pct(s.bullRate)} / 跌 ${pct(s.bearRate)} / 震荡 ${pct(s.flatRate)}</div>
              <div class="jd-rec-row"><button class="btn-text jd-view-btn" data-symbol="${esc(s.symbol)}">查看逐条记录 →</button></div>
            </div>
          </div>`).join('')}</div>`
      : '<div class="data-empty">暂无记录。打开任意个股页「技术面」Tab，即会自动记录一条技术面方向判断。</div>';
  }

  async function loadMarket() {
    const r = await fetch('/api/market-tech/records').then(x => x.json());
    if (r && r.success) { state.market = r; renderMarket(); }
  }

  async function loadTech() {
    const r = await fetch('/api/tech-face/records').then(x => x.json());
    if (r && r.success) { state.tech = r; renderTech(); }
  }

  // ---- 短期行情判断（20260914i）----
  function renderSameDay() {
    const d = state.sameDay;
    if (!d) return;
    const a = d.accuracy;
    document.getElementById('sdKpis').innerHTML = [
      kpi('总体准确率', pct(a.accuracy), `${a.correct}/${a.settledCount} 命中`, cls(a.accuracy)),
      kpi('判断总条数', String(a.totalRecords), `待验证 ${a.pendingCount}`, ''),
      kpi('今日后续口径', pct(a.intradayRate), 'intraday', cls(a.intradayRate)),
      kpi('次日口径', pct(a.nextdayRate), 'nextday', cls(a.nextdayRate)),
      kpi('过期未结算', String(a.overdueCount), a.overdueCount > 0 ? '需核查结算口径' : '无', a.overdueCount > 0 ? 'na' : ''),
    ].join('');

    const bar = (rows) => rows.map(([n, r, t]) => t
      ? `<span class="mt-acc-chip ${cls(r)}"><span class="mac-label">${n}</span><span class="mac-value">${pct(r)}</span><span class="mac-sub">${t} 次</span></span>`
      : `<span class="mt-acc-chip muted"><span class="mac-label">${n}</span><span class="mac-value">无样本</span></span>`).join(' ');
    document.getElementById('sdCalib').innerHTML =
      `<b>分方向</b> ` + bar([['看涨', a.bullRate, a.bullTotal], ['看跌', a.bearRate, a.bearTotal], ['看震荡', a.flatRate, a.flatTotal]]);

    // 各股聚合
    const bySym = {};
    for (const r of d.records || []) {
      if (!r.symbol) continue;
      const k = r.symbol;
      if (!bySym[k]) bySym[k] = { symbol: k, name: r.name || '', t: 0, c: 0, p: 0 };
      if (r.settled) { bySym[k].t++; if (r.correct) bySym[k].c++; } else bySym[k].p++;
    }
    const list = Object.values(bySym).sort((x, y) => y.t - x.t);
    document.getElementById('sdCount').textContent = `${list.length} 只 · ${(d.records || []).length} 条`;
    document.getElementById('sdBySymbol').innerHTML = list.length
      ? `<div class="jd-rec-list">${list.map(s => {
          const rate = s.t ? Math.round(s.c / s.t * 1000) / 10 : null;
          return `<div class="jd-rec">
            <div class="jd-rec-head">
              <span class="jd-rec-sym">${esc(s.symbol)}</span>
              <span class="jd-rec-name">${esc(s.name)}</span>
              <span class="jd-rec-date">${s.t} 已结算 / ${s.p} 待验证</span>
            </div>
            <div class="jd-rec-body">
              <div class="jd-rec-row">准确率 <b>${pct(rate)}</b>（${s.c}/${s.t}）</div>
              <div class="jd-rec-row"><button class="btn-text jd-sd-view-btn" data-symbol="${esc(s.symbol)}">查看逐条记录 →</button></div>
            </div>
          </div>`;
        }).join('')}</div>`
      : '<div class="data-empty">暂无记录。打开任意个股页「短期行情判断」卡片即会自动记录一条。</div>';
  }

  async function loadSameDay() {
    const r = await fetch('/api/sameday-judgment/records').then(x => x.json());
    if (r && r.success) { state.sameDay = r; renderSameDay(); }
  }

  async function loadSameDaySymbol(symbol) {
    if (!symbol) return;
    const r = await fetch('/api/sameday-judgment/records?symbol=' + encodeURIComponent(symbol)).then(x => x.json());
    if (!r || !r.success) return;
    state.sdSymbol = r;
    const card = document.getElementById('sdRecordsCard');
    card.style.display = '';
    document.getElementById('sdRecordsTitle').textContent =
      `${symbol} ${r.symbolName || ''} 逐条记录（准确率 ${pct(r.accuracy.accuracy)}，已结算 ${r.accuracy.settledCount}）`;
    document.getElementById('sdRecords').innerHTML = (r.records || []).length
      ? `<div class="jd-rec-list">${r.records.slice().reverse().map(x => `
          <div class="jd-rec">
            <div class="jd-rec-head">
              <span class="jd-rec-sym">${esc(x.date)}</span>
              <span class="jd-rec-name">判断 <b>${esc(x.dir || '—')}</b>（${esc(x.target === 'nextday' ? '次日' : '今日后续')}）</span>
              <span class="jd-rec-date">${esc(x.targetDate || '')}</span>
            </div>
            <div class="jd-rec-body">
              <div class="jd-rec-row">${x.settled
                ? `<span class="jd-${x.correct ? 'ok' : 'bad'}">${x.correct ? '✓ 命中' : '✗ 未中'}</span> 实际 ${esc(x.actualDir || '')} ${x.actualChgPct == null ? '' : x.actualChgPct + '%'}`
                : '<span class="jd-pending">待验证</span>'}</div>
              ${x.confidence ? `<div class="jd-rec-row">置信度 ${esc(x.confidence)}${x.score == null ? '' : ' · 总分 ' + x.score}</div>` : ''}
            </div>
          </div>`).join('')}</div>`
      : '<div class="data-empty">该股暂无短期判断记录。</div>';
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---- 市场情绪提醒（20260914i）----
  function renderSentiment() {
    const d = state.sentiment;
    if (!d) return;
    const a = d.accuracy;
    if (document.getElementById('sentFlatTol')) document.getElementById('sentFlatTol').textContent = a.flatTolerance;
    document.getElementById('sentKpis').innerHTML = [
      kpi('情绪预警准确率', pct(a.accuracy), `${a.correct}/${a.settledCount} 命中`, cls(a.accuracy)),
      kpi('留档条数', String(a.totalRecords), `待验证 ${a.pendingCount}`, ''),
      kpi('看涨预警', pct(a.bullRate), `${a.bullRate == null ? 0 : ''}${a.bullTotal} 次`, cls(a.bullRate)),
      kpi('看跌预警', pct(a.bearRate), `${a.bearTotal} 次`, cls(a.bearRate)),
      kpi('预警等级拆分', `预警 ${pct(a.warnRate)} / 强烈 ${pct(a.strongRate)}`, `样本 ${a.warnTotal} / ${a.strongTotal}`, ''),
    ].join('');

    const recs = (d.records || []).slice().reverse();
    document.getElementById('sentCount').textContent = `${d.records.length} 条 · ${a.benchmark ? a.benchmark.name : ''} ${a.horizonLabel}`;
    document.getElementById('sentRecords').innerHTML = recs.length
      ? `<div class="jd-rec-list">${recs.map(r => `
          <div class="jd-rec">
            <div class="jd-rec-head">
              <span class="jd-rec-sym">${esc(r.baseDate)}</span>
              <span class="jd-rec-name">${esc(r.level)} · 隐含方向 <b>${esc(r.impliedDirRaw || '')}</b></span>
              <span class="jd-rec-date">→ ${esc(r.targetDate || '')}</span>
            </div>
            <div class="jd-rec-body">
              <div class="jd-rec-row">归一化 <b>${esc(r.dir || '—')}</b>${r.zScore == null ? '' : ` · 偏离值 ${r.zScore}（警戒 ${r.extremeZ}）`}</div>
              <div class="jd-rec-row">${r.settled
                ? `<span class="jd-${r.correct ? 'ok' : 'bad'}">${r.correct ? '✓ 命中' : '✗ 未中'}</span> 上证 ${esc(r.baseDate)} 收 ${r.baseClose} → ${esc(r.targetDate)} 收 ${r.targetClose}（${r.actualChgPct > 0 ? '+' : ''}${r.actualChgPct}%，${esc(r.actualDir)}）`
                : '<span class="jd-pending">待验证（次日未收盘 / K 线未出）</span>'}</div>
              ${r.reason ? `<div class="jd-rec-row sd-sent-reason">${esc(r.reason)}</div>` : ''}
            </div>
          </div>`).join('')}</div>`
      : '<div class="data-empty">暂无记录。仅「预警 / 强烈预警」且带明确方向（看涨/看跌）的情绪拐点才会留档，打开首页「市场情绪提醒」卡片即会自动检查并记录。</div>';
  }

  async function loadSentiment() {
    const r = await fetch('/api/sentiment-accuracy/records').then(x => x.json());
    if (r && r.success) { state.sentiment = r; renderSentiment(); }
  }

  async function loadTechSymbol(symbol) {
    if (!symbol) return;
    const r = await fetch('/api/tech-face/records?symbol=' + encodeURIComponent(symbol)).then(x => x.json());
    if (!r || !r.success) return;
    state.techSymbol = r;
    const card = document.getElementById('techRecordsCard');
    card.style.display = '';
    document.getElementById('techRecordsTitle').textContent = `${symbol} 技术面逐条记录（准确率 ${pct(r.accuracy.accuracy)}，已结算 ${r.accuracy.settledCount}）`;
    document.getElementById('techRecords').innerHTML = r.records.length
      ? `<div class="jd-rec-list">${r.records.map(x => `
          <div class="jd-rec">
            <div class="jd-rec-head">
              <span class="jd-rec-sym">${esc(x.baseDate)}</span>
              <span class="jd-rec-name">${esc(x.shortRaw)}（评分 ${x.dirScore == null ? '—' : x.dirScore}）</span>
              <span class="jd-rec-date">概率 ${esc(x.probability || '—')} → 第${x.horizon}交易日</span>
            </div>
            <div class="jd-rec-body">
              <div class="jd-rec-row">归一化方向 <b>${esc(x.shortVerdict || '—')}</b>${x.pattern ? ` · ${esc(x.pattern)}` : ''}</div>
              <div class="jd-rec-row">${x.settled
                ? `<span class="jd-${x.correct ? 'ok' : 'bad'}">${x.correct ? '✓ 命中' : '✗ 未中'}</span> 实际 ${esc(x.actualDir)} ${x.actualChgPct}%（${esc(x.baseDate)} 收 ${x.actualBaseClose} → ${esc(x.actualTargetDate || '')} 收 ${x.actualTargetClose}）`
                : '<span class="jd-pending">待验证（目标日未到 / 未收盘）</span>'}</div>
            </div>
          </div>`).join('')}</div>`
      : '<div class="data-empty">该股暂无技术面记录。</div>';
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const PANELS = { market: 'marketPanel', tech: 'techPanel', sameDay: 'sameDayPanel', sentiment: 'sentimentPanel' };

  function switchTab(tab) {
    if (!PANELS[tab]) tab = 'market';
    state.tab = tab;
    document.querySelectorAll('.acc-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    for (const k of Object.keys(PANELS)) {
      const el = document.getElementById(PANELS[k]);
      if (el) el.style.display = k === tab ? '' : 'none';
    }
    document.getElementById('techSymbolBar').style.display = tab === 'tech' ? '' : 'none';
    document.getElementById('sameDaySymbolBar').style.display = tab === 'sameDay' ? '' : 'none';
    let url = 'accuracy.html?tab=' + tab;
    if (tab === 'tech' && state.techSymbol) url += '&symbol=' + state.techSymbol.symbol;
    if (tab === 'sameDay' && state.sdSymbol) url += '&symbol=' + state.sdSymbol.symbol;
    try { history.replaceState(null, '', url); } catch (e) {}
  }

  async function settleAndReload() {
    const ov = document.getElementById('loadingOverlay');
    const tx = document.getElementById('loadingText');
    ov.classList.remove('hidden');
    try {
      if (state.tab === 'market') {
        tx.textContent = '正在拉取指数 K 线结算大盘判断…';
        await fetch('/api/market-tech/settle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await loadMarket();
      } else if (state.tab === 'tech') {
        tx.textContent = '正在拉取个股 K 线结算技术面判断…';
        await fetch('/api/tech-face/settle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: state.techSymbol ? state.techSymbol.symbol : undefined }) });
        await loadTech();
        if (state.techSymbol) await loadTechSymbol(state.techSymbol.symbol);
      } else if (state.tab === 'sameDay') {
        tx.textContent = '正在拉取个股 K 线结算短期判断…';
        await fetch('/api/sameday-judgment/settle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: state.sdSymbol ? state.sdSymbol.symbol : undefined }) });
        await loadSameDay();
        if (state.sdSymbol) await loadSameDaySymbol(state.sdSymbol.symbol);
      } else if (state.tab === 'sentiment') {
        tx.textContent = '正在拉取上证 K 线结算情绪预警…';
        await fetch('/api/sentiment-accuracy/settle', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        await loadSentiment();
      }
    } catch (e) { console.error(e); }
    ov.classList.add('hidden');
  }

  function bind() {
    document.querySelectorAll('.acc-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    document.getElementById('settleBtn').addEventListener('click', settleAndReload);
    document.getElementById('reloadBtn').addEventListener('click', async () => {
      if (state.tab === 'market') await loadMarket();
      else if (state.tab === 'tech') await loadTech();
      else if (state.tab === 'sameDay') await loadSameDay();
      else await loadSentiment();
    });
    document.getElementById('symbolQueryBtn').addEventListener('click', () => {
      const v = document.getElementById('symbolInput').value.trim();
      if (v) loadTechSymbol(v);
    });
    document.getElementById('symbolInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) loadTechSymbol(v); }
    });
    document.getElementById('sdSymbolQueryBtn').addEventListener('click', () => {
      const v = document.getElementById('sdSymbolInput').value.trim();
      if (v) loadSameDaySymbol(v);
    });
    document.getElementById('sdSymbolInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { const v = e.target.value.trim(); if (v) loadSameDaySymbol(v); }
    });
    document.addEventListener('click', e => {
      const btn = e.target.closest('.jd-view-btn');
      if (btn) { loadTechSymbol(btn.dataset.symbol); return; }
      const sdBtn = e.target.closest('.jd-sd-view-btn');
      if (sdBtn) loadSameDaySymbol(sdBtn.dataset.symbol);
    });
  }

  window.addEventListener('DOMContentLoaded', async () => {
    bind();
    const params = new URLSearchParams(location.search);
    const ALLOWED = ['market', 'tech', 'sameDay', 'sentiment'];
    const tab = ALLOWED.includes(params.get('tab')) ? params.get('tab') : 'market';
    const sym = params.get('symbol');
    switchTab(tab);
    if (sym) {
      if (tab === 'sameDay') document.getElementById('sdSymbolInput').value = sym;
      else document.getElementById('symbolInput').value = sym;
    }
    await Promise.all([loadMarket(), loadTech(), loadSameDay(), loadSentiment()]);
    if (sym && tab === 'tech') await loadTechSymbol(sym);
    if (sym && tab === 'sameDay') await loadSameDaySymbol(sym);
  });
})();
