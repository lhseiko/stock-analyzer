/**
 * Capital Flow Charts Module
 * 资金量能分析前端渲染
 */

/**
 * 20261106f：「20日涨跌日量能比」数值解读逻辑下拉面板（用户截图指令）。
 * 纯前端确定性规则 —— 结论一律由代码按规则表计算输出，不调用 LLM、不估算数值；
 * 供 app.js（资金量能页五联行）与 capitalCharts.js（资金概要兼容渲染路径）两条链路共用单一真值源。
 *
 * 三条口径铁律：
 *  ① 三档解读是「参考表」→ 仅当前命中行保留方向色（红/绿/琥珀），其余行中性灰徽标，
 *     表下附「仅高亮行是当前命中判定」对照说明（20261101f 参考表着色铁律）。
 *  ② 今日结合结论 = 历史结构（ratio 三档）× 当日量价信号（vp.signal）确定性比对，
 *     规则表写死；契合→可信度高，相反→警惕诱多/结构转弱，中性/数据不足→诚实降级。
 *  ③ ratio = 近20日上涨日均量 ÷ 下跌日均量（与「量价判定」⑤量价健康度同源，量能口径为成交量·手）；
 *     ≈1 的 0.95~1.05 只是「解读分档容差」，不改变指标算法，也不是新口径。
 */
const VpRatioInterpret = (function () {
  'use strict';

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const EQ_LO = 0.95, EQ_HI = 1.05; // 「≈1」解读分档容差

  // 三档解读（用户提供的文案原样保留，仅按命中与否着色）
  const BAND_ROWS = [
    {
      key: 'gt', label: '＞1', tone: 'bull',
      lines: [
        '上涨日均量 > 下跌日均量',
        '上涨时花钱更多、放量拉；下跌时舍不得砸、缩量跌。',
        '典型多头偏好结构：放量上涨、缩量回调，是趋势票健康的量价特征。',
        '数值越高，代表多头发力明显强于空头抛压。',
        '例：比值 1.8 → 上涨那天平均资金，差不多是下跌那天平均资金的 1.8 倍。',
      ],
    },
    {
      key: 'eq', label: '≈1', tone: 'neutral',
      lines: ['多空出手体量差不多，涨也放量、跌也放量，震荡拉锯、分歧均衡，没有明显倾向性。'],
    },
    {
      key: 'lt', label: '＜1', tone: 'bear',
      lines: [
        '上涨日均量 < 下跌日均量',
        '上涨惜量、拉不动；一旦下跌就放量出逃。',
        '空头占优结构：缩量反弹、放量杀跌，是弱势、风险结构，反弹容易是诱多。',
      ],
    },
  ];

  const HIST_TEXT = {
    bull: '涨放量、跌缩量（典型多头偏好结构）',
    bear: '涨缩量、跌放量（空头占优结构）',
    neutral: '涨也放量、跌也放量（分歧均衡）',
    na: '量能比数据不足，无法归纳历史习惯',
  };

  function ratioBand(r) {
    if (typeof r !== 'number' || !isFinite(r)) return { key: 'na', bias: 'na', label: '数据不足' };
    if (r > EQ_HI) return { key: 'gt', bias: 'bull', label: '＞1' };
    if (r < EQ_LO) return { key: 'lt', bias: 'bear', label: '＜1' };
    return { key: 'eq', bias: 'neutral', label: '≈1' };
  }

  // 当日量价信号 → 今日量能结构倾向（站在「上涨日 vs 下跌日谁更活跃」的视角）
  function signalBias(signal) {
    const s = String(signal || '');
    if (!s) return { direction: 'na', vol: 'na', bias: 'na' };
    const up = /上涨|齐升/.test(s);
    const down = /下跌|回调/.test(s);
    const amp = /放量|巨量|齐升/.test(s);
    const dry = /缩量|地量/.test(s);
    if (up && amp) return { direction: 'up', vol: 'up-amp', bias: 'bull' };   // 上涨日放量
    if (up && dry) return { direction: 'up', vol: 'up-dry', bias: 'bear' };   // 上涨惜量
    if (down && amp) return { direction: 'down', vol: 'dn-amp', bias: 'bear' }; // 下跌日放量
    if (down && dry) return { direction: 'down', vol: 'dn-dry', bias: 'bull' }; // 缩量回调、抛压有限
    return { direction: up ? 'up' : down ? 'down' : 'na', vol: 'flat', bias: 'flat' }; // 平量/温和/量价平衡
  }

  const TODAY_TEXT = {
    'up-amp': '上涨方向放量，与「涨放量」同侧',
    'up-dry': '上涨惜量，与「涨缩量」同侧',
    'dn-amp': '下跌方向放量，与「跌放量」同侧',
    'dn-dry': '下跌缩量、抛压有限，与「跌缩量」同侧',
    'flat': '量能平量/温和，未明显放大',
    'na': '当日量价信号数据不足',
  };

  // 确定性比对：历史结构 × 今日信号
  function combine(band, sig, ratio, signal) {
    const r = (typeof ratio === 'number' && isFinite(ratio)) ? ratio.toFixed(2) : '--';
    const s = signal ? String(signal) : '数据不足';
    const base = {
      ratioText: r, signalText: s, band: band.key, bias: band.bias, sigBias: sig.bias,
      histText: HIST_TEXT[band.bias] || HIST_TEXT.na,
      todayText: TODAY_TEXT[sig.vol] || TODAY_TEXT.na,
    };
    if (band.bias === 'na' || sig.bias === 'na') {
      return Object.assign(base, {
        tone: 'neutral', alignment: 'na',
        verdict: '量能比或当日量价信号数据不足，无法做历史结构与今日信号的结构比对；上方数值解读逻辑仍可照常参考。',
      });
    }
    if (sig.bias === 'flat') {
      return Object.assign(base, {
        tone: 'neutral', alignment: 'flat',
        verdict: `历史习惯是「${base.histText}」；今日「${s}」量能未明显放大，对固有结构的印证有限，先按当日信号本身看待，不宜据此下强结论。`,
      });
    }
    if (band.bias === 'neutral') {
      return Object.assign(base, {
        tone: 'neutral', alignment: 'flat',
        verdict: `近20日比值 ${r} ≈1，多空出手体量接近、没有明显倾向性；今日「${s}」按当日信号独立看待，历史结构对本次的印证有限。`,
      });
    }
    if (band.bias === sig.bias) {
      const bullOK = band.bias === 'bull';
      return Object.assign(base, {
        tone: bullOK ? 'bull' : 'bear', alignment: 'match',
        // 20261106f 实测修正：结论不得写死「放量上涨」——今日信号可能是「缩量回调」「缩量上涨」等，
        // 契合判定只表示与历史结构同侧，不代表今日一定是放量上涨。措辞随 ${s} 动态代入、后半句保持中性。
        verdict: `历史习惯是「${base.histText}」（${r}）→ 这次「${s}」，`
          + (bullOK
            ? '契合它本身的多头量能习惯，本次量价信号的可信度高。'
            : '与固有的空头占优结构一致，弱势延续；反弹容易是诱多，别把单次放量当成反转。'),
      });
    }
    const todayBull = sig.bias === 'bull';
    return Object.assign(base, {
      tone: 'warn', alignment: 'diverge',
      verdict: `历史习惯是「${base.histText}」（${r}）→ 这次「${s}」，和它固有结构相反，`
        + (todayBull
          ? '要警惕诱多：上涨日一贯不活跃，今日量能却偏向多头一侧，需验证是否有真实增量资金。'
          : '要警惕结构转弱：上涨日一贯更活跃，今日量能却偏向空头一侧（下跌放量或上涨惜量），抛压可能真实。'),
    });
  }

  function buildTrigger(open) {
    return `<button type="button" class="cm-interpret-trigger${open ? ' is-open' : ''}"`
      + ` data-action="toggle-vp-interpret" aria-expanded="${open ? 'true' : 'false'}"`
      + ` title="展开/收起「数值解读逻辑」与今日量价结构比对">解读 <span class="cmi-chev">▾</span></button>`;
  }

  function buildPanel(vp, opts) {
    const o = opts || {};
    const ratio = vp && typeof vp.ratio === 'number' && isFinite(vp.ratio) ? vp.ratio : null;
    const signal = vp && vp.signal ? vp.signal : null;
    const band = ratioBand(ratio);
    const sig = signalBias(signal);
    const c = combine(band, sig, ratio, signal);

    const rows = BAND_ROWS.map(row => {
      const hit = row.key === band.key;
      const badge = hit ? `cmi-badge cmi-hit-${row.tone}` : 'cmi-badge cmi-ref';
      return `<div class="cmi-row${hit ? ' cmi-row-hit' : ''}">`
        + `<span class="${badge}">${row.label}</span>`
        + `<div class="cmi-lines">${row.lines.map(t => `<div>${esc(t)}</div>`).join('')}</div>`
        + `</div>`;
    }).join('');

    return `<div class="cm-interpret-panel" data-cm-interpret="1"${o.open ? '' : ' hidden'}>`
      + `<div class="cmi-head">数值解读逻辑<span class="cmi-head-sub">20日涨跌日量能比 = 近20日上涨日均量 ÷ 下跌日均量</span></div>`
      + `<div class="cmi-rows">${rows}</div>`
      + `<div class="cmi-foot">仅高亮行是当前命中判定（当前比值 ${esc(c.ratioText)}，${esc(band.label)}）；其余为参考说明。</div>`
      + `<div class="cmi-today">`
      + `<div class="cmi-today-title">区分同是放量，结构好不好 · 结合今日量价关系判定</div>`
      + `<div class="cmi-facts">`
      + `<div class="cmi-fact"><span>近20日比值</span><b>${esc(c.ratioText)}</b><em>${esc(band.label)} · ${esc(c.histText)}</em></div>`
      + `<div class="cmi-fact"><span>今日量价信号</span><b>${esc(c.signalText)}</b><em>${esc(c.todayText)}</em></div>`
      + `</div>`
      + `<div class="cmi-verdict cmi-${c.tone}"><span class="cmi-verdict-tag">${c.alignment === 'match' ? '结构契合' : c.alignment === 'diverge' ? '结构相反' : '中性／待观察'}</span>${esc(c.verdict)}</div>`
      + `<div class="cmi-example">对照示例：A 票比值 1.7 + 放量上涨 → 契合多头习惯，可信度高；B 票比值 0.6 + 放量上涨 → 与固有结构相反，要警惕诱多。</div>`
      + `</div>`
      + `<div class="cmi-caliber">口径说明：本卡为成交量（手）比值，与「量价判定」⑤量价健康度同源；「≈1」按 ${EQ_LO}~${EQ_HI} 容差仅用于解读分档，不改变指标算法；与「当日量/20日均量」（135 格归格口径）是不同分母的独立口径，数值不应相等；20261106n 起 60 日均量口径已整体退役，全量价判定与文字分析统一 ÷20 日均量；20261106o 起涨跌判定也与 135 格走势档同源（大涨≥5% / 上涨≥1.2% / 震荡 |涨跌|<1.2% / 下跌 / 大跌≤-5%），震荡档信号 = 量能档+震荡（如「缩量震荡」），判定结论直接引用 135 格归格文本。</div>`
      + `</div>`;
  }

  return { esc, ratioBand, signalBias, combine, buildTrigger, buildPanel, EQ_LO, EQ_HI };
})();

const CapitalCharts = {
  instances: {},

  // 20260916：统一的容错 init —— ECharts（本地 vendor/echarts.min.js）缺失/未就绪时不再抛错中断
  // 整个 renderAll，只在该容器内提示，其余图表继续渲染。
  _safeInit(id) {
    const el = document.getElementById(id);
    if (!el) return null;
    if (typeof echarts === 'undefined') {
      el.innerHTML = '<div class="data-empty">⚠️ 图表库（ECharts）未加载成功，请检查网络后刷新页面。</div>';
      return null;
    }
    try {
      let chart = echarts.init(el, 'softDark');
      if (window.SA_CHART) chart = SA_CHART.attach(chart); // setOption 自动过视觉修补
      return chart;
    }
    catch (e) {
      console.error('Capital chart init error:', id, e);
      el.innerHTML = `<div class="data-empty">图表渲染失败（${(e && e.message) || e}）。</div>`;
      return null;
    }
  },

  disposeAll() {
    Object.values(this.instances).forEach(c => { try { c.dispose(); } catch {} });
    this.instances = {};
  },

  renderAll(data) {
    this.disposeAll();

    if (!data) return;

    this.lastData = data;
    // 20261024i：量价关系分析已合并进「量能分析」卡（app.renderVolumeEngine），
    // 原独立 #capVolumePrice 卡已删除，此处不再单独渲染（renderVolumePrice 保留以兼容/单测）。
    this.renderMoneyFlow(data.moneyFlow);
    this.renderFlowSummary(data.moneyFlow?.summary, data.moneyFlow?.source);
    // 20261103m：每日量比趋势（用户指令：主力资金流向卡正下方，记录每日量比变化）
    this.renderVolRatio(data.volumeIndicators);
    this.renderVolIndicators(data.volumeIndicators);
    this.renderOBV(data.volumeIndicators);
    this.renderVR(data.volumeIndicators);
    this.renderVolume(data.volumeIndicators);
    this.renderMargin(data.marginTrading);
    this.renderMarginSummary(data.marginTrading);
    // 20261101k：「资金量能综合判断」卡上移进「量能分析」卡（app.renderVolumeEngine 调
    // buildConclusionParts），原 #capConclusion 独立卡删除，此处不再渲染。
  },

  // ── 20261103m：每日量比趋势（用户指令：主力资金流向卡正下方，记录每日量比变化）──
  // 量比口径（与 volumeEngine 量能三态 / zoneValidity 标准1 全站同源）：
  //   量比 = 当日成交量 ÷ 前 5 日均量（**不含当日**）；量能缺失 → null（不臆造）。
  //   市场标准阈值（20261019f 对齐东财/同花顺）：>1.2 放量、<0.8 缩量 → 图上画阈值虚线。
  //   历史序列直接由日K成交量本机推导（K线自带历史，无需另存），即「每日量比的变化记录」。
  computeVolRatioSeries(volumes) {
    const vols = Array.isArray(volumes) ? volumes : [];
    return vols.map((v, i) => {
      if (i < 5 || v == null || !(v > 0)) return null;
      let sum = 0, ok = true;
      for (let k = i - 5; k < i; k++) {
        const p = vols[k];
        if (p == null || !(p > 0)) { ok = false; break; }
        sum += p;
      }
      if (!ok || !(sum > 0)) return null;
      return Math.round((v / (sum / 5)) * 100) / 100;
    });
  },

  renderVolRatio(vi) {
    const el = document.getElementById('capVolRatioChart');
    if (!el || !vi) return;
    const s = vi.series;
    if (!s || !Array.isArray(s.dates) || !Array.isArray(s.volumes) || s.dates.length === 0) return;
    const chart = this._safeInit('capVolRatioChart');
    if (!chart) return;
    this.instances.volRatio = chart;
    const ratios = this.computeVolRatioSeries(s.volumes);
    const dates = s.dates;
    // 末值摘要（tooltip 之外的固定说明行不占位——阈值线即读法）
    chart.setOption({
      title: { text: `量比 = 当日量 ÷ 前5日均量（不含当日）· 最新 ${ratios[ratios.length - 1] == null ? '—' : ratios[ratios.length - 1]}`, left: 'center', top: 2, textStyle: { fontSize: 11, color: '#8b939c', fontWeight: 'normal' } },
      tooltip: {
        trigger: 'axis',
        formatter: (ps) => {
          const p = Array.isArray(ps) ? ps[0] : ps;
          if (!p || p.value == null) return `${p && p.axisValue || ''}<br/>量比：数据不足`;
          const v = Number(p.value);
          const tier = v > 1.2 ? '放量' : v < 0.8 ? '缩量' : '平量';
          return `${p.axisValue}<br/>量比：<b>${v.toFixed(2)}</b>（${tier}）`;
        },
      },
      grid: { left: '8%', right: '5%', bottom: '10%', top: '22%' },
      xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', scale: true, name: '量比', axisLabel: { formatter: v => Number(v).toFixed(1) } },
      series: [
        {
          name: '量比', type: 'line', data: ratios, smooth: true, symbol: 'circle', symbolSize: 4,
          lineStyle: { width: 2, color: '#cdab74' }, itemStyle: { color: '#cdab74' },
          connectNulls: false,
          markLine: {
            silent: true, symbol: 'none',
            lineStyle: { type: 'dashed', width: 1 },
            label: { fontSize: 10, formatter: (p) => p.name },
            data: [
              { name: '放量 1.2', yAxis: 1.2, lineStyle: { color: 'rgba(246,70,93,0.55)' }, label: { color: 'rgba(246,70,93,0.85)' } },
              { name: '缩量 0.8', yAxis: 0.8, lineStyle: { color: 'rgba(14,203,129,0.55)' }, label: { color: 'rgba(14,203,129,0.85)' } },
            ],
          },
        },
      ],
    });
  },

  renderVolumePrice(vi) {
    const el = document.getElementById('capVolumePrice');
    if (!el) return; // 20261024i：卡片已合并进「量能分析」，元素不存在时安全退出
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
      '大涨平量': 'cap-neutral',
      '温和上涨': 'cap-positive',
      '缩量上涨': 'cap-negative',
      '地量上涨': 'cap-neutral',
      '巨量下跌': 'cap-negative',
      '放量下跌': 'cap-negative',
      '显著下跌': 'cap-negative',
      '缩量下跌': 'cap-negative',
      '地量下跌': 'cap-negative',
      '温和回调': 'cap-neutral',
      '缩量回调': 'cap-neutral',
      '地量回调': 'cap-neutral',
      '量价平衡': 'cap-neutral',
      // 20261106o：震荡档（与 135 格走势档同源）一律中性色——震荡=观察，无方向语义
      '巨量震荡': 'cap-neutral',
      '放量震荡': 'cap-neutral',
      '平量震荡': 'cap-neutral',
      '缩量震荡': 'cap-neutral',
      '地量震荡': 'cap-neutral',
    };
    const dayPct = typeof vp.dayChangePct === 'number' ? vp.dayChangePct : null;
    const dayPctHtml = dayPct !== null
      ? `<span class="cm-value ${dayPct > 0 ? 'cap-pos' : dayPct < 0 ? 'cap-neg' : ''}">${dayPct > 0 ? '+' : ''}${dayPct.toFixed(2)}%</span>`
      : '<span class="cm-value">--</span>';
    const dayVolRatio = typeof vp.dayVolRatio === 'number' ? vp.dayVolRatio : null;
    // 20261017i：统一量能口径。此前本卡用「当日量 ÷ 前20日均量」判放量/缩量，
    // 量能分析卡（引擎）用「÷5日均量 + 60日均量确认」，两处各算一套导致同屏互斥。
    // 现两卡均引自引擎 unifiedTier，此处优先显示统一口径并显示口径来源；
    // 未接入引擎（unified 为 null）时退回原 20 日口径，行为与改动前一致。
    const un = vp.unified || null;
    const ratioVal = (un && typeof un.ratio5 === 'number') ? un.ratio5 : dayVolRatio;
    const ratioLabel = un ? '量比(÷5日均量)' : '今日量比';
    const ratioCls = ratioVal !== null ? (ratioVal > 1.3 ? 'cap-pos' : (ratioVal < 0.7 ? 'cap-neg' : '')) : '';
    // 20261106d（用户截图指令）：20日涨跌日卡按「涨天数 vs 跌天数」着色——涨多红、跌多绿、持平中性。
    // 全站红涨绿跌语义；与「20日净涨跌」的数值方向色同源（cap-pos / cap-neg）。
    const daysCls = (typeof vp.upDays === 'number' && typeof vp.downDays === 'number')
      ? (vp.upDays > vp.downDays ? 'cap-pos' : vp.upDays < vp.downDays ? 'cap-neg' : '') : '';
    const basisNote = un
      ? `量能口径（与「量能分析」同源）：${un.basis}${un.confirm ? `　当前 60 日均量口径：${un.confirm}` : ''}${un.divergenceNote ? `　${un.divergenceNote}` : ''}`
      : '';
    // 20261106f：数值解读下拉面板。展开状态在静默轮询 innerHTML 全量重建前读取、重建后恢复，
    // 避免每 60s 刷新把用户点开的面板自动收起（20261104j 轮询渲染铁律同源）。
    const interpretOpen = !!el.querySelector('.cm-interpret-panel:not([hidden])');
    const interpretTrigger = VpRatioInterpret.buildTrigger(interpretOpen);
    const interpretPanel = VpRatioInterpret.buildPanel(vp, { open: interpretOpen });
    el.innerHTML = `
      <div class="cap-signal-box ${signalClass[vp.signal] || ''}">
        <div class="cap-signal-label">量价信号（当日）</div>
        <div class="cap-signal-value">${vp.signal}</div>
        <div class="cap-signal-desc">${vp.description}</div>
      </div>
      <div class="cap-metrics-row">
        <div class="cap-metric"><span class="cm-label">今日涨跌</span>${dayPctHtml}</div>
        <div class="cap-metric"><span class="cm-label">${ratioLabel}</span><span class="cm-value ${ratioCls}">${ratioVal !== null ? ratioVal.toFixed(2) : '--'}</span></div>
        <div class="cap-metric"><span class="cm-label" title="近20日上涨天数 / 下跌天数；涨天数多于跌天数标红，反之标绿（全站红涨绿跌）">20日涨跌日</span><span class="cm-value ${daysCls}">${vp.upDays}天/${vp.downDays}天</span></div>
        <div class="cap-metric cm-has-interpret"><span class="cm-label" title="近20日上涨日均量 ÷ 下跌日均量，衡量量价健康度（与「量价判定」⑤量价健康度同源）">20日涨跌日量能比${interpretTrigger}</span><span class="cm-value ${vp.ratio > 1 ? 'cap-pos' : 'cap-neg'}">${vp.ratio}<span class="cm-sub" title="近20日上涨日平均成交量 ÷ 下跌日平均成交量 = ${vp.ratio}；≥1.15 视为量价健康">近20日涨日均量 ÷ 跌日均量</span></span></div>
        <div class="cap-metric"><span class="cm-label">20日净涨跌</span><span class="cm-value ${vp.netChangePct > 0 ? 'cap-pos' : vp.netChangePct < 0 ? 'cap-neg' : ''}">${vp.netChangePct > 0 ? '+' : ''}${vp.netChangePct}%</span></div>
        <div class="cap-metric"><span class="cm-label">量能热度</span><span class="cm-value">${vp.heatLevel || '--'}</span></div>
      </div>
      ${interpretPanel}
      <div class="cap-date-note">${dateNote}${basisNote ? `<br>${basisNote}` : ''}</div>
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

    const chart = this._safeInit('capMoneyFlowChart');
    if (!chart) return;
    this.instances.moneyFlow = chart;

    const dates = daily.map(d => d.date);
    const mainNet = daily.map(d => Math.round(d.mainNet / 1e8 * 100) / 100);
    const largeNet = daily.map(d => Math.round(d.largeNet / 1e8 * 100) / 100);
    const mediumNet = daily.map(d => Math.round(d.mediumNet / 1e8 * 100) / 100);
    const smallNet = daily.map(d => Math.round(d.smallNet / 1e8 * 100) / 100);

    let moneyOpt;
    const estTitle = isEstimated ? { text: '资金流向（基于量价估算）', left: 'center', top: 2, textStyle: { fontSize: 12, color: '#cdab74' } } : undefined;
    const use3D = !!(window.SA3D && SA3D.glb());
    if (use3D) {
      moneyOpt = SA3D.bar3D({
        xData: dates,
        yName: '亿元',
        unit: ' 亿',
        title: estTitle,
        series: [
          {
            name: '主力净流入', data: mainNet, barSize: [16, 16],
            color: function (v) { return v >= 0 ? '#F6465D' : '#0ECB81'; },
          },
          { name: '超大/大单', kind: 'line', data: largeNet, color: '#cdab74' },
          { name: '中单', kind: 'line', data: mediumNet, color: '#7fa8c9' },
          { name: '小单', kind: 'line', data: smallNet, color: '#8b939c' },
        ],
        legend: { data: ['主力净流入', '超大/大单', '中单', '小单'], top: 28, left: 'center', itemWidth: 14, itemHeight: 10, textStyle: { fontSize: 11 } },
        view: { alpha: 14, beta: -32, distance: 240 },
      });
      moneyOpt.tooltip.axisPointer = undefined;
    } else {
      moneyOpt = {
        title: estTitle,
        tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
        legend: { data: ['主力净流入', '超大/大单', '中单', '小单'], top: 28, left: 'center', itemWidth: 14, itemHeight: 10, textStyle: { fontSize: 11 } },
        grid: { left: '8%', right: '5%', bottom: '10%', top: '24%' },
        xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
        yAxis: { type: 'value', name: '亿元', axisLabel: { formatter: '{value}' } },
        series: [
          {
            name: '主力净流入', type: 'bar', data: mainNet, barMaxWidth: 18,
            itemStyle: {
              color: function(p) { return p.value >= 0 ? 'rgba(207,142,142,0.80)' : 'rgba(143,184,154,0.80)'; },
              borderRadius: [2, 2, 0, 0],
            },
          },
          { name: '超大/大单', type: 'line', data: largeNet, smooth: true, lineStyle: { width: 2 }, itemStyle: { color: '#cdab74' }, symbol: 'none' },
          { name: '中单', type: 'line', data: mediumNet, smooth: true, lineStyle: { width: 2 }, itemStyle: { color: '#7fa8c9' }, symbol: 'none' },
          { name: '小单', type: 'line', data: smallNet, smooth: true, lineStyle: { width: 2 }, itemStyle: { color: '#8b939c' }, symbol: 'none' },
        ],
      };
    }
    chart.setOption(moneyOpt);

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
    const chart = this._safeInit('capOBVChart');
    if (!chart) return;
    this.instances.obv = chart;

    const s = vi.series;
    chart.setOption({
      tooltip: { trigger: 'axis' },
      grid: { left: '10%', right: '5%', bottom: '10%', top: '10%' },
      xAxis: { type: 'category', data: s.dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { formatter: v => CapitalCharts.formatVol(v) } },
      series: [{
        name: 'OBV', type: 'line', data: s.obv, smooth: true, symbol: 'none',
        areaStyle: { color: window.SA_CHART ? SA_CHART.grad('#7fa8c9', 0.22, 0) : { opacity: 0.1 } },
        lineStyle: { width: 2, color: '#7fa8c9' },
      }],
    });
  },

  renderVR(vi) {
    const el = document.getElementById('capVRChart');
    if (!el || !vi) return;
    const chart = this._safeInit('capVRChart');
    if (!chart) return;
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
    const chart = this._safeInit('capVolumeChart');
    if (!chart) return;
    this.instances.volume = chart;

    const s = vi.series;
    chart.setOption({
      tooltip: { trigger: 'axis' },
      legend: { data: ['成交量', 'MA5', 'MA10', 'MA20'], top: 0 },
      grid: { left: '8%', right: '5%', bottom: '10%', top: '15%' },
      xAxis: { type: 'category', data: s.dates, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: 'value', scale: true, axisLabel: { formatter: v => CapitalCharts.formatVol(v) } },
      series: [
        {
          name: '成交量', type: 'bar', data: s.volumes, barMaxWidth: 12,
          itemStyle: { color: 'rgba(127,168,201,0.60)', borderRadius: [2, 2, 0, 0] },
        },
        { name: 'MA5', type: 'line', data: s.volMA5, smooth: true, symbol: 'none', lineStyle: { width: 1.5, color: '#cf8e8e' } },
        { name: 'MA10', type: 'line', data: s.volMA10, smooth: true, symbol: 'none', lineStyle: { width: 1.5, color: '#cdab74' } },
        { name: 'MA20', type: 'line', data: s.volMA20, smooth: true, symbol: 'none', lineStyle: { width: 1.5, color: '#a99bc4' } },
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

    const chart = this._safeInit('capMarginChart');
    if (!chart) return;
    this.instances.margin = chart;

    const data = margin.data;
    const dates = data.map(d => d.tradeDate);
    const rzBalance = data.map(d => Math.round(d.rzBalance / 1e8 * 100) / 100);
    const rqBalance = data.map(d => Math.round(d.rqBalance / 1e8 * 100) / 100);

    let marginOpt;
    if (window.SA3D && SA3D.glb()) {
      marginOpt = SA3D.bar3D({
        xData: dates,
        yName: '亿元',
        unit: ' 亿',
        legend: { data: ['融资余额(亿)', '融券余额(亿)'], top: 0 },
        view: { alpha: 14, beta: -32, distance: 240 },
        series: [
          { name: '融资余额(亿)', data: rzBalance, barSize: [16, 16], color: '#F6465D' },
          { name: '融券余额(亿)', kind: 'line', data: rqBalance, color: '#8fb89a' },
        ],
      });
      marginOpt.tooltip.axisPointer = undefined;
    } else {
      marginOpt = {
        tooltip: { trigger: 'axis' },
        legend: { data: ['融资余额(亿)', '融券余额(亿)'], top: 0 },
        grid: { left: '8%', right: '5%', bottom: '10%', top: '15%' },
        xAxis: { type: 'category', data: dates, axisLabel: { rotate: 45, fontSize: 10 } },
        yAxis: { type: 'value', scale: true, axisLabel: { formatter: '{value}' } },
        series: [
          {
            name: '融资余额(亿)', type: 'bar', data: rzBalance, barMaxWidth: 16,
            itemStyle: { color: 'rgba(207,142,142,0.78)', borderRadius: [2, 2, 0, 0] },
          },
          { name: '融券余额(亿)', type: 'line', data: rqBalance, smooth: true, symbol: 'none', lineStyle: { width: 2, color: '#8fb89a' } },
        ],
      };
    }
    chart.setOption(marginOpt);
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

  // 20261101k：「资金量能综合判断」内容构建器（原 renderConclusion 改造）。
  // 渲染位置上移至「量能分析」卡顶部（app.renderVolumeEngine），本方法只负责从
  // data.volumeIndicators / moneyFlow / marginTrading / conclusion 生成行数组，
  // 优先复用后端统一结论，与判断引擎因子保持一致。
  // 20261101p（用户截图指令，uicraft 重排版）：返回值改为结构化 { rows, verdict }——
  // rows 为指标条目（icon/label/text/wide），verdict 为多空结论（label/tone/bull/bear），
  // 排版（结论横幅 + 指标网格）由 app.renderVolumeEngine 完成；各条目文字口径与 p 版前完全一致。
  buildConclusionParts(data) {
    const rows = [];
    const vi = data.volumeIndicators;
    const mf = data.moneyFlow;
    const margin = data.marginTrading;

    // 20261103f（用户截图指令：利好/利空内容按红/绿语义着色）：每行带 tone（bull=红/bear=绿/neutral=灰），
    // 方向判定与 buildConclusionParts 底部多空打分同口径（单一语义源）。
    const VP_TONE = {
      '放量上涨': 'bull', '量价齐升': 'bull', '温和上涨': 'bull', '缩量回调': 'bull',
      '缩量上涨': 'bear', '温和回调': 'bear', '地量上涨': 'bear', '地量回调': 'bear', '缩量下跌': 'bear', '地量下跌': 'bear',
      '巨量下跌': 'bear', '放量下跌': 'bear', '显著下跌': 'bear',
      // 20261106o：震荡档与 135 格「震荡=观察」同源 → neutral（缺省亦为 neutral，显式列出防漏）
      '巨量震荡': 'neutral', '放量震荡': 'neutral', '平量震荡': 'neutral', '缩量震荡': 'neutral', '地量震荡': 'neutral',
    };
    const moneyTone = (v) => v > 0 ? 'bull' : v < 0 ? 'bear' : 'neutral';

    // 量价关系（长文本 → 网格通栏）
    if (vi?.volumePrice) {
      const vp = vi.volumePrice;
      rows.push({ icon: '📊', label: '今日量价关系判定（唯一结论）', text: `${vp.signal} — ${vp.description}`, wide: true, tone: VP_TONE[vp.signal] || 'neutral' });
    }

    // 资金流向
    if (mf?.summary?.summary) {
      const isEst = mf?.source === 'estimated';
      const estNote = isEst ? '（估算）' : '';
      const s5 = mf.summary.summary['5d'];
      const s20 = mf.summary.summary['20d'];
      // 20261106d（用户截图指令）：短期/中期资金文字分析补「日均净流入/净流出」。
      // 日均 = 窗口累计主力净额 ÷ 窗口交易日天数（5 / 20），单位亿/日，保留两位小数；
      // 方向按 mainNet 符号独立判定（不复用 direction 字符串，防止累计与日均方向不一致时静默错标）；
      // 数值缺失/非有限值时只显示累计额，不编造日均值（诚实降级）。
      const dailyText = (s, days) => {
        if (!s || typeof s.mainNet !== 'number' || !isFinite(s.mainNet) || !(days > 0)) return '';
        const avg = Math.abs(s.mainNet) / days;
        const d = s.mainNet > 0 ? '净流入' : s.mainNet < 0 ? '净流出' : '持平';
        return ` · 日均${d}${avg.toFixed(2)}亿`;
      };
      if (s5) {
        const dir = s5.direction;
        rows.push({ icon: '💰', label: `短期资金${estNote}`, text: `近5日主力${dir}${Math.abs(s5.mainNet)}亿${dailyText(s5, 5)}`, tone: moneyTone(s5.mainNet) });
      }
      if (s20) {
        const dir = s20.direction;
        rows.push({ icon: '📈', label: `中期资金${estNote}`, text: `近20日主力${dir}${Math.abs(s20.mainNet)}亿${dailyText(s20, 20)}`, tone: moneyTone(s20.mainNet) });
      }
    }

    // 量能指标
    if (vi?.indicators) {
      const ind = vi.indicators;
      const obvTone = ind.obvTrend === '上升趋势' ? 'bull' : ind.obvTrend === '下降趋势' ? 'bear' : 'neutral';
      if (ind.obvTrend !== '中性') rows.push({ icon: '📐', label: 'OBV趋势', text: ind.obvTrend, tone: obvTone });
      if (ind.vrSignal !== '中性') rows.push({ icon: '🔍', label: 'VR信号', text: `${ind.vrSignal}（VR=${ind.vr}）`, tone: ind.vrSignal.includes('多') ? 'bull' : ind.vrSignal.includes('空') ? 'bear' : 'neutral' });
      if (ind.mfiSignal !== '中性') rows.push({ icon: '💸', label: 'MFI信号', text: `${ind.mfiSignal}（MFI=${ind.mfi}）`, tone: /流入|多/.test(ind.mfiSignal) ? 'bull' : /流出|空/.test(ind.mfiSignal) ? 'bear' : 'neutral' });
      // 20261101o（用户截图指令）：「换手率」条目不输出——换手率已移至个股标题卡信息行
      // （20261101n），本区块不再重复展示。
    }

    // 融资融券
    if (margin?.hasData) {
      const l = margin.latest;
      // 20261104d（用户截图报障）：「（占流通市值X%）」指的是融资余额的占比，原拼接顺序跟在「净买入」后
      // 产生歧义（读成净买入占流通市值 4.46%）→ 调整为紧贴「融资余额」之后：融资余额15.7亿（占流通市值4.46%），净买入0.27亿
      const ratioStr = l.rzRatio ? `（占流通市值${l.rzRatio.toFixed(2)}%）` : '';
      const netBuyStr = l.rzNetBuy !== undefined ? `，净买入${(l.rzNetBuy / 1e8).toFixed(2)}亿` : '';
      rows.push({ icon: '🏦', label: '融资融券', text: `融资余额${(l.rzBalance / 1e8).toFixed(1)}亿${ratioStr}${netBuyStr}，${margin.trend}`, tone: moneyTone(l.rzChange) });
    }

    // 综合判断（优先复用后端统一结论，与判断引擎因子保持一致）→ verdict
    let overall, bs = 0, br = 0;
    if (data.conclusion && typeof data.conclusion.bullScore === 'number') {
      overall = data.conclusion.label;
      bs = data.conclusion.bullScore;
      br = data.conclusion.bearScore;
    } else {
      if (vi?.volumePrice) {
        const vpSig = vi.volumePrice.signal;
        if (['放量上涨', '量价齐升', '温和上涨'].includes(vpSig)) bs += 2;
        else if (['缩量回调'].includes(vpSig)) bs += 1;
        else if (['缩量上涨', '温和回调', '地量上涨', '地量回调', '缩量下跌', '地量下跌'].includes(vpSig)) br += 1;
        else if (['巨量下跌', '放量下跌', '显著下跌'].includes(vpSig)) br += 2; // 20261019e：与 capitalFlow.js 多空打分同口径（巨量下跌/放量下跌均 +2；旧「量价齐跌」标签已废弃）
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

    // 语义色调：偏多→bull（红晕）、偏空→bear（绿晕）、中性→neutral（灰底）
    const tone = /偏空|注意风险/.test(overall) ? 'bear' : /偏多|支撑上涨/.test(overall) ? 'bull' : 'neutral';
    // 20261106n（用户裁决）：20261106m 的「全模块综合总结（代码聚合）」行整体删除——
    // 用户实测反馈「总结的输出十分不理想」（点名式票型罗列冗长、与结论横幅信息重复且
    // 把「融资融券净买入」等中性信息也计票，可读性差）。恢复 m 版前的 rows/verdict 结构。

    return { rows, verdict: { label: overall, tone, bull: bs, bear: br } };
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

// 20261106f：Node 守卫可 require 本文件做纯函数实测（浏览器顶层 const 仍是全局词法绑定，
// app.js 在同页可直接访问 CapitalCharts 与 VpRatioInterpret，无需额外 script 标签）。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { CapitalCharts, VpRatioInterpret };
}
