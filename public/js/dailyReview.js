/**
 * dailyReview.js — DailyReviewPage（20261107 · /daily-review）
 * ==============================================================
 * 用户指令：页面点击后自动加载当日复盘；running 状态轮询；非交易日显示休市；
 * 管理员可手动重跑；必要检索（历史列表 + 按日期查询）。
 *
 * 严格约束：
 *  - 前端**不得直连数据库**：所有数据只经 /api/review/* 与 /api/calendar/*。
 *  - 数值一律来自后端（代码权威），前端只渲染，不做任何估算/补齐。
 *  - 数据缺失显示「缺失」，不臆造；不给买入/卖出/仓位建议。
 *  - A 股语义：红涨绿跌（+ 红 / - 绿），禁止方向与颜色错位。
 *  - loading 数据到位后立即移除，不残留。
 */
(function () {
  'use strict';

  const S = {
    date: null, view: 'today', pollTimer: null,
    today: null, running: false,
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  /** 先转义，再对带符号数值着色（A股：+红 / -绿）。缺失文本不着色。 */
  function colorize(s) {
    const e = esc(s);
    return e.replace(/([+-]\d+(?:\.\d+)?(?:%|亿|家|个)?)/g, (m) => {
      const cls = m.charAt(0) === '+' ? 'dr-up' : 'dr-down';
      return '<span class="' + cls + '">' + m + '</span>';
    });
  }
  function localToday() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  async function api(url, opts) {
    const r = await fetch(url, opts);
    const d = await r.json();
    if (!r.ok && !(d && d.success === false)) throw new Error((d && d.error) || ('HTTP ' + r.status));
    return d;
  }

  const SUBTITLE_TODAY = '交易日 15:35 自动生成 · 固定 14 段结构 · 热点归因 · 机会/风险分级 · 数据缺失如实标注';

  // ---------- 有限分析版标记 ----------
  function isLimited(review, ver) {
    return !!(review && (review.limited || (ver && ver.limited)));
  }
  function setLimitedBadge(limited) {
    const bar = $('drStatusBar');
    if (!bar) return;
    let chip = $('drChipLimited');
    if (limited && !chip) {
      chip = document.createElement('span');
      chip.id = 'drChipLimited';
      chip.className = 'dr-chip dr-limited-chip';
      chip.textContent = '有限分析版';
      const spacer = bar.querySelector('.dr-spacer');
      bar.insertBefore(chip, spacer || null);
    } else if (!limited && chip) {
      chip.remove();
    }
  }
  function metaText(review, ver) {
    let meta = ver ? ('生成于 ' + esc(ver.localTime || ver.generatedAt || '—') + ' · ' + esc((review && review.schemaVersion) || '')) : '';
    if (isLimited(review, ver)) {
      meta += (meta ? ' · ' : '') + '核心字段完整率不足 90%，已做有限分析，最需补充 3 项见『数据完整性与口径』段';
    }
    return meta;
  }

  // ---------- 状态条 ----------
  function setStatus(today, review) {
    const date = (today && today.date) || S.date || localToday();
    S.date = date;
    const cal = today && today.calendar;
    $('drChipDate').textContent = '📅 ' + date;
    if (today && today.holiday) {
      $('drChipDay').textContent = '休市 · 非交易日';
      $('drChipDay').className = 'dr-chip dr-chip-holiday';
    } else if (cal && cal.is_trading_day === true) {
      $('drChipDay').textContent = '交易日';
      $('drChipDay').className = 'dr-chip dr-chip-trading';
    } else {
      $('drChipDay').textContent = '交易日历判定缺失';
      $('drChipDay').className = 'dr-chip';
    }
    const ver = review && (review.versions || []).find(v => v.version === review.currentVersion);
    $('drChipVersion').textContent = ver ? ('v' + ver.version + (ver.kind === 'revision' ? ' 修订版' : ' 正式版')) : '暂无复盘';
    $('drChipCompleteness').textContent = ver && ver.completeness ? ('完整度 ' + ver.completeness.score + '%') : '完整度 —';
    const running = !!(today && today.running) || S.running;
    $('drChipRunning').classList.toggle('hidden', !running);
    setLimitedBadge(isLimited(review, ver));
    $('drMeta').textContent = metaText(review, ver);
  }

  // ---------- 14 段渲染（兼容旧版文档：section 缺 quads/risks/tableKind 时自动走原路径） ----------
  /** 字段文本：缺失显示「缺失」，其余经 colorize() 转义并对带符号数值着色（A股 +红 / -绿）。 */
  function field(v) {
    return (v == null || v === '') ? '<span class="dr-missing">缺失</span>' : colorize(v);
  }
  /** 纯标签文本：只做 esc()，不做数值着色（用于 code / level / name 等标识，避免编号被误着色）。 */
  function plain(v) {
    return (v == null || v === '') ? '<span class="dr-missing">缺失</span>' : esc(v);
  }

  // 各 tableKind 的列顺序与中文表头（顺序按约定 key）
  const TABLE_COLS = {
    source: [['name', '数据源'], ['category', '类别'], ['status', '状态'], ['source', '来源'], ['asOf', '数据时间'], ['fetchedAt', '获取时间'], ['note', '缺失原因 / 说明']],
    // 20261108 · 14 段：机会表新增 drivers，列顺序按规格，原宽表补充列保留在后
    opportunity: [['name', '名称/代码'], ['code', '代码'], ['category', '机会分类'], ['drivers', '驱动标签'], ['grade', '等级'], ['confirmCount', '确认项数'], ['vetoes', '否决项'], ['oneLine', '一句话判断'], ['catalyst', '催化剂'], ['layer', '板块层次'], ['capitalContinuity', '资金持续性']],
    watch: [['name', '名称/代码'], ['code', '代码'], ['categoryGrade', '机会分类/等级'], ['reason', '入选原因'], ['sector', '代表板块/现象'], ['watchChange', '明日观察的变化'], ['invalidate', '判断不成立信号'], ['riskTags', '风险标签'], ['drivers', '驱动标签']],
    checklist: [['item', '核对项'], ['baseline', '今日基准'], ['condition', '验证条件']],
    history: [['date', '历史日期'], ['item', '判断项'], ['baseline', '历史基准'], ['today', '今日值'], ['verdict', '结论']],
    quality: [['item', '检查项'], ['passed', '通过'], ['detail', '明细']],
    // 20261108 · 第 3 段「每日热点题材与归因卡片」宽表；评级依据须可见（结论四段式要求理由透明）
    topic: [['name', '题材名称'], ['changePct', '板块涨幅'], ['limitUpCount', '涨停家数'], ['midCapText', '中军代理表现'], ['attribution', '核心消息催化'], ['newsLevel', '消息级别 / 性质'], ['newsTime', '来源时间'], ['stage', '题材阶段'], ['grade', '评级'], ['gradeReason', '评级依据'], ['verifyLogic', '评级与明日验证逻辑'], ['voteQuality', '资金投票质量'], ['quadrant', '四象限'], ['quadrantAction', '四象限动作'], ['drivers', '驱动标签']],
    // 20261108 · 「板块结构与资金投票」段
    vote: [['industry', '板块 / 行业'], ['voteQuality', '资金投票质量'], ['quadrant', '四象限'], ['quadrantAction', '四象限动作'], ['evidence', '资金投票依据']],
  };
  // 内部字段，一律不展示。归因卡片行带一批供引擎/质检使用的结构化字段，
  // 若漏隐藏会被 columnsFor() 追加成英文列名（表格污染），此处一次列全。
  const HIDDEN_COLS = {
    scope: true, sourceTag: true, voteSummary: true,
    stageReason: true, voteReason: true, quadReason: true, newsSource: true,
    evidenceComplete: true, count: true, boardsMax: true, hasLayer: true,
    mainNet: true, earlyShare: true, midCapChangePct: true, sealTimeText: true,
  };

  /** 决定表格列：新文档按 tableKind；旧文档 / null 沿用 labelOf() 动态推断。 */
  function columnsFor(sec) {
    const rows = sec.table || [];
    const def = sec.tableKind && TABLE_COLS[sec.tableKind];
    const seen = {};
    let cols;
    if (def) {
      cols = def.filter(c => !HIDDEN_COLS[c[0]]);
      cols.forEach(c => { seen[c[0]] = true; });
      // 保留后端额外给出的列（仍隐藏内部字段），避免静默丢字段
      Object.keys(rows[0] || {}).forEach(k => {
        if (!seen[k] && !HIDDEN_COLS[k]) cols.push([k, labelOf(k)]);
      });
    } else {
      // 旧 12 段文档：无 tableKind，按数据对象 key 动态推断
      cols = Object.keys(rows[0] || {}).filter(k => !HIDDEN_COLS[k]).map(k => [k, labelOf(k)]);
    }
    return cols;
  }

  /** 四段式结论卡片：事实 / 判断 / 次日验证条件 / 判断不成立信号。 */
  function renderQuads(quads) {
    const ROWS = [
      ['fact', '事实', 'dr-quad-fact'],
      ['judgment', '判断', 'dr-quad-judgment'],
      ['verify', '次日验证条件', 'dr-quad-verify'],
      ['invalidate', '判断不成立信号', 'dr-quad-invalidate'],
    ];
    return '<div class="dr-quads">' + quads.map(q => {
      let c = '<div class="dr-quad">';
      c += '<div class="dr-quad-subject">' + field(q.subject) + '</div>';
      c += '<div class="dr-quad-rows">' + ROWS.map(r =>
        '<div class="dr-quad-row ' + r[2] + '">' +
          '<span class="dr-quad-label">' + r[1] + '</span>' +
          '<span class="dr-quad-text">' + field(q[r[0]]) + '</span>' +
        '</div>').join('') + '</div>';
      c += '</div>';
      return c;
    }).join('') + '</div>';
  }

  /** 风险条目：code + title + 等级徽标 + 三行信息；含与行情方向无关的红绿免责图例。 */
  function renderRisks(risks) {
    const LEVEL_CLS = { '高': 'dr-level-high', '中': 'dr-level-mid', '低': 'dr-level-low', '无法判断': 'dr-level-unknown' };
    const legend = '<div class="dr-risk-legend">注：风险等级配色与行情红涨绿跌无关，仅表示风险级别，不代表涨跌方向。' +
      '（等级：<span class="dr-level-high">高</span> / <span class="dr-level-mid">中</span> / ' +
      '<span class="dr-level-low">低</span> / <span class="dr-level-unknown">无法判断</span>）</div>';
    const LINES = [['事实', 'fact'], ['次日观察信号', 'observe'], ['风险解除信号', 'clear']];
    return '<div class="dr-risks">' + legend + risks.map(r => {
      const lv = r.level;
      const cls = LEVEL_CLS[lv] || 'dr-level-unknown';
      let c = '<div class="dr-risk">';
      c += '<div class="dr-risk-head">' +
        '<span class="dr-risk-code">' + plain(r.code) + '</span>' +
        '<span class="dr-risk-title">' + field(r.title) + '</span>' +
        '<span class="dr-level-badge ' + cls + '">' + esc(lv || '无法判断') + '</span>' +
      '</div>';
      c += '<div class="dr-risk-lines">' + LINES.map(l =>
        '<div class="dr-risk-line">' +
          '<span class="dr-risk-line-k">' + l[0] + '</span>' +
          '<span class="dr-risk-line-v">' + field(r[l[1]]) + '</span>' +
        '</div>').join('') + '</div>';
      if (r.evidence && r.evidence.length) {
        c += '<div class="dr-risk-evidence">' + r.evidence.map(e =>
          '<span class="dr-risk-ev">' +
            '<span class="dr-risk-ev-k">' + plain(e.name) + '</span>' +
            '<span class="dr-risk-ev-v">' + field(e.value) + '</span>' +
          '</span>').join('') + '</div>';
      }
      c += '</div>';
      return c;
    }).join('') + '</div>';
  }

  /**
   * 第 3 段「每日热点题材与归因卡片」：把 15 列宽表改造为卡片网格（ui-new 6 维度审查结论）。
   * 每张卡片 = 一个题材的完整归因：题材名 + S/A/B/C 评级 + 题材阶段 + 四指标（板块涨幅/涨停家数/中军代理/来源时间）
   * + 三徽标（消息级 / 资金投票 / 四象限）+ 核心催化 + 评级依据 + 明日验证逻辑 + 明日动作 + 驱动标签。
   * 缺失项（attribution / midCapText / newsTime）静默省略或用「—」占位，消除宽表式「缺失」噪音；
   * 逐卡片内聚，不再有列宽失衡 / 行高过高 / 底部裁切问题。徽标复用既有 renderCell 保证口径一致。
   */
  function renderTopicCards(sec) {
    const rows = sec.table || [];
    if (!rows.length) return '<p class="dr-line dr-missing">缺失</p>';
    return '<div class="dr-topic-cards">' + rows.map(r => {
      const g = String(r.grade || '').toUpperCase();
      const gradeBadge = (g === 'S' || g === 'A' || g === 'B' || g === 'C')
        ? '<span class="dr-topic-grade dr-topic-' + g.toLowerCase() + '">' + esc(g) + '级</span>' : '';
      const stage = r.stage ? '<span class="dr-topic-stage ' + stageCls(r.stage) + '">' + esc(r.stage) + '</span>' : '';
      const hasAttr = r.attribution && r.attribution !== '缺失';
      const midCap = (r.midCapText && r.midCapText !== '缺失') ? field(r.midCapText) : '<span class="dr-muted">—</span>';
      const newsTime = r.newsTime && r.newsTime !== '缺失' ? esc(r.newsTime) : '<span class="dr-muted">—</span>';
      let c = '<div class="dr-topic-card">';
      // 头部：题材名（左对齐推开）+ 评级 + 阶段
      c += '<div class="dr-topic-card-head">' +
        '<span class="dr-topic-card-name">' + plain(r.name) + '</span>' +
        gradeBadge + stage + '</div>';
      // 四指标：板块涨幅 / 涨停家数 / 中军代理 / 来源时间
      c += '<div class="dr-topic-card-meta">' +
        metric('板块涨幅', renderCell('changePct', r.changePct, sec)) +
        metric('涨停家数', field(r.limitUpCount)) +
        metric('中军代理', midCap) +
        metric('来源时间', newsTime) +
        '</div>';
      // 三徽标：消息级别（缺失则省略，不渲染「缺失」噪音）/ 资金投票质量（含「无法判断」真实判定）/ 四象限
      c += '<div class="dr-topic-card-badges">' +
        (r.newsLevel && r.newsLevel !== '缺失' ? renderCell('newsLevel', r.newsLevel, sec) : '') +
        (r.voteQuality ? renderCell('voteQuality', r.voteQuality, sec) : '') +
        (r.quadrant ? renderCell('quadrant', r.quadrant, sec) : '') +
        '</div>';
      // 核心催化（缺失则整块省略，避免噪音）
      if (hasAttr) {
        c += '<div class="dr-topic-card-block">' +
          '<span class="dr-topic-ck">核心催化</span>' +
          '<span class="dr-topic-cv">' + field(r.attribution) + '</span></div>';
      }
      // 评级依据 + 明日验证逻辑（四段式理由透明）
      c += '<div class="dr-topic-card-block">' +
        '<span class="dr-topic-ck">评级依据</span>' +
        '<span class="dr-topic-cv">' + field(r.gradeReason) + '</span></div>';
      c += '<div class="dr-topic-card-block">' +
        '<span class="dr-topic-ck">明日验证逻辑</span>' +
        '<span class="dr-topic-cv">' + field(r.verifyLogic) + '</span></div>';
      // 底部：明日动作 + 驱动标签
      c += '<div class="dr-topic-card-foot">' +
        (r.quadrantAction ? '<span class="dr-topic-ck">明日动作</span><span class="dr-topic-cv">' + field(r.quadrantAction) + '</span>' : '') +
        (r.drivers ? '<span class="dr-topic-ck">驱动</span>' + renderCell('drivers', r.drivers, sec) : '') +
        '</div>';
      c += '</div>';
      return c;
    }).join('') + '</div>';
  }
  function metric(k, v) {
    return '<div class="dr-topic-metric"><span class="dr-topic-mk">' + esc(k) +
      '</span><span class="dr-topic-mv">' + v + '</span></div>';
  }
  function stageCls(s) {
    const t = String(s);
    if (t.indexOf('启动') !== -1) return 'dr-stage-start';
    if (t.indexOf('发酵') !== -1 || t.indexOf('主升') !== -1) return 'dr-stage-rise';
    if (t.indexOf('高潮') !== -1 || t.indexOf('退潮') !== -1) return 'dr-stage-peak';
    return 'dr-stage-none'; // 缺少对照等
  }

  // ---- 段落折叠（长页方便浏览；折叠状态按 section key 持久化到 localStorage） ----
  const SECTION_COLLAPSE_KEY = 'sa_review_collapsed_v1';
  function loadCollapsed() {
    try { return JSON.parse(localStorage.getItem(SECTION_COLLAPSE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }
  function saveCollapsed(obj) {
    try { localStorage.setItem(SECTION_COLLAPSE_KEY, JSON.stringify(obj)); } catch (e) {}
  }
  function isCollapsed(key) {
    return loadCollapsed()[key] === true;
  }
  function allCollapsed() {
    const secs = document.querySelectorAll('.dr-section');
    if (!secs.length) return false;
    let n = 0;
    secs.forEach(s => { if (s.classList.contains('dr-sec-collapsed')) n++; });
    return n === secs.length;
  }
  function updateToggleAllLabel() {
    const all = document.getElementById('drToggleAll');
    if (all) all.textContent = allCollapsed() ? '全部展开' : '全部折叠';
  }
  // 每次（重新）渲染后调用：单段点击折叠 + 全局折叠/展开，状态持久化
  function bindSectionInteractions() {
    document.querySelectorAll('.dr-section').forEach(sec => {
      const head = sec.querySelector('.dr-sec-head');
      const key = sec.getAttribute('data-key');
      if (!head) return;
      head.addEventListener('click', () => {
        const nowCollapsed = sec.classList.toggle('dr-sec-collapsed');
        if (key) { const store = loadCollapsed(); store[key] = nowCollapsed; saveCollapsed(store); }
        head.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        updateToggleAllLabel();
      });
      head.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); head.click(); }
      });
    });
    const all = document.getElementById('drToggleAll');
    if (all) {
      all.addEventListener('click', () => {
        const collapse = !allCollapsed();
        document.querySelectorAll('.dr-section').forEach(sec => {
          const key = sec.getAttribute('data-key');
          sec.classList.toggle('dr-sec-collapsed', collapse);
          if (key) { const store = loadCollapsed(); store[key] = collapse; saveCollapsed(store); }
          const hd = sec.querySelector('.dr-sec-head');
          if (hd) hd.setAttribute('aria-expanded', collapse ? 'false' : 'true');
        });
        updateToggleAllLabel();
      });
    }
    updateToggleAllLabel();
  }
  function sectionToolbar() {
    return '<div class="dr-sec-toolbar">' +
      '<button type="button" class="dr-sec-toggle-all" id="drToggleAll">全部折叠</button>' +
      '</div>';
  }

  /** 表格：按 tableKind 定列；opportunity / watch / vote 用横向滚动容器（topic 已改为卡片，见 renderTopicCards）。 */
  function renderTable(sec) {
    const cols = columnsFor(sec);
    const kind = sec.tableKind;
    const scroll = (kind === 'topic' || kind === 'opportunity' || kind === 'watch' || kind === 'vote');
    const wrapCls = 'dr-table-wrap' + (scroll ? ' dr-table-scroll' : '') + (kind === 'topic' ? ' dr-tbl-topic' : '');
    return '<div class="' + wrapCls + '"><table class="dr-table"><thead><tr>' +
      cols.map(c => '<th>' + esc(c[1]) + '</th>').join('') +
      '</tr></thead><tbody>' +
      sec.table.map(row => '<tr>' + cols.map(c => '<td>' + renderCell(c[0], row[c[0]], sec) + '</td>').join('') + '</tr>').join('') +
      '</tbody></table></div>';
  }

  function renderSection(sec, idx) {
    const statusCls = sec.status === 'missing' ? 'dr-sec-missing'
      : sec.status === 'partial' ? 'dr-sec-partial' : 'dr-sec-ok';
    const badge = sec.status === 'missing' ? '缺失'
      : sec.status === 'partial' ? '部分缺失' : '完整';
    const secKey = sec.key || ('idx' + idx);
    const collapsed = isCollapsed(secKey);
    let h = '<section class="dr-section ' + statusCls + (collapsed ? ' dr-sec-collapsed' : '') + '" data-key="' + esc(secKey) + '">' +
      '<div class="dr-sec-head" role="button" tabindex="0" aria-expanded="' + (collapsed ? 'false' : 'true') + '">' +
        '<span class="dr-sec-chevron" aria-hidden="true"></span>' +
        '<span class="dr-sec-no">' + String(idx + 1).padStart(2, '0') + '</span>' +
        '<h2 class="dr-sec-title">' + esc(sec.title) + '</h2>' +
        '<span class="dr-sec-badge">' + badge + '</span>' +
      '</div><div class="dr-sec-body">';
    let body = '';
    if (sec.lines && sec.lines.length) {
      body += sec.lines.map(l => '<p class="dr-line">' + colorize(l) + '</p>').join('');
    }
    if (sec.bullets && sec.bullets.length) {
      body += '<ul class="dr-bullets">' + sec.bullets.map(b => '<li>' + colorize(b) + '</li>').join('') + '</ul>';
    }
    if (sec.metrics && sec.metrics.length) {
      // metrics 兼容后端契约 {k,v} 与旧文档 {name,value}；值缺失时复用 field() 显示「缺失」，不臆造为 0
      body += '<div class="dr-metrics">' + sec.metrics.map(m => {
        const k = m.name != null ? m.name : (m.k != null ? m.k : '');
        const v = m.value != null ? m.value : m.v;
        return '<div class="dr-metric"><span class="dr-metric-k">' + esc(k) + '</span>' +
          '<span class="dr-metric-v">' + field(v) + '</span></div>';
      }).join('') + '</div>';
    }
    // ★ 新增字段（旧文档缺这些字段时，下面 if 自动跳过，完全走原有渲染路径）
    if (sec.quads && sec.quads.length) body += renderQuads(sec.quads);
    if (sec.risks && sec.risks.length) body += renderRisks(sec.risks);
    // 第 3 段热点归因：topic 表改为卡片网格；其余表（opportunity / watch / vote 等）仍走宽表
    if (sec.table && sec.table.length) body += (sec.tableKind === 'topic' ? renderTopicCards(sec) : renderTable(sec));
    if (!body) body = '<p class="dr-line dr-missing">缺失</p>';  // 空段兜底：旧文档不空白
    h += body + '</div></section>';
    return h;
  }
  function labelOf(k) {
    const M = {
      name: '数据源', category: '类别', status: '状态', source: '来源', asOf: '数据时间',
      fetchedAt: '获取时间', note: '缺失原因 / 说明', item: '核对项', baseline: '今日基准',
      passed: '通过', detail: '明细', condition: '验证条件', verdict: '结论', today: '今日值',
      date: '历史日期', grade: '等级', code: '代码',
      // 20261108 · 14 段新增字段（供旧文档动态推断 / 后端额外列兜底时取中文表头）
      changePct: '板块涨幅', limitUpCount: '涨停家数', midCapText: '中军代理表现',
      attribution: '核心消息催化', newsLevel: '消息级别 / 性质', newsTime: '来源时间',
      stage: '题材阶段', gradeReason: '评级理由', verifyLogic: '评级与明日验证逻辑',
      voteQuality: '资金投票质量', quadrant: '四象限', quadrantAction: '四象限动作',
      drivers: '驱动标签', industry: '板块 / 行业', evidence: '资金投票依据',
      confirmCount: '确认项数', vetoes: '否决项', oneLine: '一句话判断',
      catalyst: '催化剂', layer: '板块层次', capitalContinuity: '资金持续性',
      categoryGrade: '机会分类 / 等级', reason: '入选原因', sector: '代表板块 / 现象',
      watchChange: '明日观察的变化', invalidate: '判断不成立信号', riskTags: '风险标签',
    };
    return M[k] || k;
  }
  function renderCell(k, v, sec) {
    if (v == null || v === '') {
      // note =「缺失原因 / 说明」、detail = 质检明细：正常数据源本就无说明，
      // 空值显示「—」；若统一显示「缺失」，会把状态为「正常」的行也标成缺失，误导用户。
      if (k === 'note' || k === 'detail') return '<span class="dr-mono">—</span>';
      return '<span class="dr-missing">缺失</span>';
    }
    // 后端以字符串「缺失」标记缺失的长文本 / 枚举字段（如 midCapText / attribution），统一按缺失样式
    if (String(v) === '缺失') return '<span class="dr-missing">缺失</span>';
    if (k === 'passed') return v === true ? '<span class="dr-pass">✓ 通过</span>' : '<span class="dr-fail">✗ 未通过</span>';
    if (k === 'status') {
      const M = { ok: '正常', partial: '部分', missing: '缺失', failed: '失败' };
      const cls = v === 'ok' ? 'dr-pass' : (v === 'missing' || v === 'failed') ? 'dr-fail' : 'dr-warn';
      return '<span class="' + cls + '">' + esc(M[v] || v) + '</span>';
    }
    if (k === 'grade') {
      const g = String(v).toUpperCase();
      // 题材评级 S/A/B/C 与机会等级 A-D 是两套语义，仅在 topic 表用独立题材徽标，避免 A/B/C 混淆
      if (sec && sec.tableKind === 'topic' && (g === 'S' || g === 'A' || g === 'B' || g === 'C')) {
        return '<span class="dr-topic-grade dr-topic-' + g.toLowerCase() + '">' + esc(g) + '级</span>';
      }
      const m = { A: 'a', B: 'b', C: 'c', D: 'd' };
      return m[g] ? '<span class="dr-grade dr-grade-' + m[g] + '">' + esc(g) + '</span>' : colorize(v);
    }
    if (k === 'verdict') {
      const m = { '已验证': 'ok', '未验证': 'no', '待验证': 'wait' };
      return m[v] ? '<span class="dr-verdict dr-verdict-' + m[v] + '">' + esc(v) + '</span>' : colorize(v);
    }
    if (k === 'quadrant') {
      const M = { '共振': 'resonance', '背离': 'divergence', '先觉': 'prescience', '双弱': 'weak' };
      return '<span class="dr-quadrant dr-quadrant-' + (M[String(v)] || 'weak') + '">' + esc(v) + '</span>';
    }
    if (k === 'voteQuality') return '<span class="dr-vote">' + esc(v) + '</span>';
    if (k === 'drivers') return '<span class="dr-drivers">' + esc(v) + '</span>';
    if (k === 'newsLevel') {
      const t = String(v);
      const c = (t.indexOf('官方') !== -1 || t.indexOf('国家级') !== -1) ? 'dr-news-official'
        : t.indexOf('传闻') !== -1 ? 'dr-news-rumor'
        : t.indexOf('未核验') !== -1 ? 'dr-news-unverified'
        : 'dr-news-neutral';
      return '<span class="dr-news-badge ' + c + '">' + esc(v) + '</span>';
    }
    if (k === 'changePct') {
      // 板块涨幅：沿用 colorize() 红涨绿跌（A 股口径）；纯数值 / 无符号文本补 '+' 以触发着色
      const s = String(v);
      const sign = (typeof v === 'number' || /^\d/.test(s)) && s.charAt(0) !== '-' ? '+' : '';
      return colorize(sign + s);
    }
    if (k === 'fetchedAt' || k === 'asOf') return '<span class="dr-mono">' + esc(v) + '</span>';
    return colorize(v);
  }

  function renderReview(review, today) {
    const main = $('drMain');
    const ver = review && (review.versions || []).find(v => v.version === review.currentVersion);
    if (!ver) {
      main.innerHTML = '<div class="dr-empty">当日尚无复盘记录。交易日 15:35 自动生成，或点击右上角「手动重跑」。</div>';
      setStatus(today, review);
      return;
    }
    let h = '';
    if (ver.completeness && ver.completeness.missing && ver.completeness.missing.length) {
      h += '<div class="dr-notice">⚠ 本次有 ' + ver.completeness.missing.length +
        ' 项数据源缺失，相关段落已标注「缺失」，未用估算值填充。</div>';
    }
    if ((review.versions || []).length > 1) {
      h += '<div class="dr-versionbar">历史版本：' + review.versions.map(v =>
        '<button class="dr-ver-btn" data-ver="' + v.version + '">v' + v.version +
        (v.kind === 'revision' ? ' 修订' : ' 正式') + '</button>').join('') + '</div>';
    }
    h += sectionToolbar();
    h += '<div class="dr-sections">' + (ver.sections || []).map(renderSection).join('') + '</div>';
    main.innerHTML = h;
    setStatus(today, review);
    bindVersionButtons(review);
  }

  function bindVersionButtons(review) {
    const btns = document.querySelectorAll('.dr-ver-btn');
    btns.forEach(b => b.addEventListener('click', () => {
      const v = review.versions.find(x => String(x.version) === b.dataset.ver);
      if (!v) return;
      const main = $('drMain');
      main.innerHTML = '<div class="dr-versionbar">历史版本：' + review.versions.map(x =>
        '<button class="dr-ver-btn" data-ver="' + x.version + '">v' + x.version +
        (x.kind === 'revision' ? ' 修订' : ' 正式') + '</button>').join('') + '</div>' +
        sectionToolbar() +
        '<div class="dr-sections">' + (v.sections || []).map(renderSection).join('') + '</div>';
      setLimitedBadge(isLimited(review, v));
      $('drMeta').textContent = metaText(review, v);
      // 切换历史版本时状态条同步到该版本，避免「看 v1 内容、顶栏却显示 v5」的口径错位
      $('drChipVersion').textContent = 'v' + v.version + (v.kind === 'revision' ? ' 修订版' : ' 正式版');
      $('drChipCompleteness').textContent = v.completeness
        ? ('完整度 ' + v.completeness.score + '%') : '完整度 —';
      bindVersionButtons(review);
    }));
    bindSectionInteractions();
  }

  // ---------- 加载 ----------
  async function loadToday() {
    const main = $('drMain');
    main.innerHTML = '<div class="dr-loading">正在加载当日复盘…</div>';
    try {
      const d = await api('/api/review/today');
      S.today = d;
      S.date = d.date;
      if (d.holiday) {
        // 需求 8：非交易日显示休市
        main.innerHTML = '<div class="dr-holiday-box">' +
          '<div class="dr-holiday-icon">🏖</div>' +
          '<h2>今日休市</h2>' +
          '<p>' + esc(d.date) + ' 为非交易日（' + esc((d.calendar && d.calendar.day_type) || '休市') + '），不生成当日复盘。</p>' +
          '<p class="dr-meta">' + esc((d.calendar && d.calendar.source) || '') +
          (d.calendar && d.calendar.source_time ? '｜来源时间 ' + esc(d.calendar.source_time) : '') + '</p>' +
          '<button class="btn-secondary" type="button" id="drViewHistoryBtn">查看最近一份复盘</button>' +
          '</div>';
        setStatus(d, d.review);
        const vb = $('drViewHistoryBtn');
        if (vb) vb.addEventListener('click', () => { switchView('history'); loadHistory(); });
        stopPoll();
        return;
      }
      if (d.running || d.status === 'running') {
        main.innerHTML = '<div class="dr-loading">⏳ 复盘正在生成中，稍后自动刷新…</div>';
        setStatus(d, d.review);
        startPoll();
        return;
      }
      stopPoll();
      if (d.review) renderReview(d.review, d);
      else {
        main.innerHTML = '<div class="dr-empty">当日尚无复盘记录。交易日 15:35 自动生成，或点击右上角「手动重跑」。</div>';
        setStatus(d, null);
      }
    } catch (e) {
      main.innerHTML = '<div class="dr-empty">加载失败：' + esc(e.message) + '</div>';
    }
  }

  // running 轮询（需求 8）
  function startPoll() {
    if (S.pollTimer) return;
    S.running = true;
    S.pollTimer = setInterval(async () => {
      try {
        const st = await api('/api/review/status');
        $('drChipRunning').classList.toggle('hidden', !st.running);
        if (!st.running) {
          stopPoll();
          await loadToday();
        } else if (st.phase) {
          const el = $('drToolbarNote');
          if (el) el.textContent = '生成阶段：' + st.phase + '（第 ' + st.attempt + ' 次）';
        }
      } catch (e) { /* 轮询失败下次重试，不弹窗打扰 */ }
    }, 3000);
  }
  function stopPoll() {
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
    S.running = false;
    const el = $('drToolbarNote');
    if (el) el.textContent = '';
  }

  // 历史列表（需求：必要检索）
  async function loadHistory() {
    const box = $('drHistoryList');
    box.innerHTML = '<div class="dr-loading">加载历史复盘…</div>';
    try {
      const d = await api('/api/review/history?limit=120');
      $('drHistoryCount').textContent = '共 ' + d.total + ' 份';
      if (!d.items || !d.items.length) {
        box.innerHTML = '<div class="dr-empty">暂无历史复盘记录。</div>';
        return;
      }
      box.innerHTML = '<div class="dr-table-wrap"><table class="dr-table"><thead><tr>' +
        '<th>日期</th><th>版本</th><th>类型</th><th>完整度</th><th>生成时间</th><th>操作</th>' +
        '</tr></thead><tbody>' + d.items.map(r =>
          '<tr><td class="dr-mono">' + esc(r.date) + '</td>' +
          '<td>v' + esc(r.version) + '</td><td>' + esc(r.kind === 'revision' ? '修订版' : '正式版') + '</td>' +
          '<td>' + (r.completeness == null ? '缺失' : r.completeness + '%') + '</td>' +
          '<td class="dr-mono">' + esc(r.generatedAt) + '</td>' +
          '<td><button class="dr-link" data-date="' + esc(r.date) + '">查看</button></td></tr>'
        ).join('') + '</tbody></table></div>';
      box.querySelectorAll('.dr-link').forEach(b => b.addEventListener('click', () => loadByDate(b.dataset.date)));
    } catch (e) {
      box.innerHTML = '<div class="dr-empty">历史加载失败：' + esc(e.message) + '</div>';
    }
  }

  async function loadByDate(date) {
    const main = $('drMain');
    main.innerHTML = '<div class="dr-loading">正在加载 ' + esc(date) + ' 复盘…</div>';
    try {
      const d = await api('/api/review/by-date?date=' + encodeURIComponent(date));
      switchView('today');
      if (d.review) {
        renderReview(d.review, { date, calendar: d.calendar, holiday: d.calendar && d.calendar.is_trading_day === false, running: false });
        $('drSubtitle').textContent = date + ' 复盘（按日期查询）· 固定 14 段结构 · 热点归因 · 机会/风险分级 · 数据缺失如实标注';
      } else if (d.failedReport) {
        main.innerHTML = '<div class="dr-fail-box"><h2>该日复盘生成失败</h2>' +
          '<p>连续 3 次生成失败，已输出失败报告；未写入正式复盘，未臆造数据。</p>' +
          '<ul class="dr-bullets">' + (d.failedReport.errors || []).map(e =>
            '<li>第 ' + e.attempt + ' 次：' + esc(e.message) + '</li>').join('') + '</ul></div>';
        setStatus({ date, calendar: d.calendar }, null);
      } else {
        main.innerHTML = '<div class="dr-empty">' + esc(date) + ' 无复盘记录' +
          (d.calendar && d.calendar.is_trading_day === false ? '（非交易日，正常休市）' : '') + '。</div>';
        setStatus({ date, calendar: d.calendar, holiday: d.calendar && d.calendar.is_trading_day === false }, null);
      }
    } catch (e) {
      main.innerHTML = '<div class="dr-empty">查询失败：' + esc(e.message) + '</div>';
    }
  }

  function switchView(v) {
    S.view = v;
    $('drTabToday').classList.toggle('active', v !== 'history');
    $('drTabHistory').classList.toggle('active', v === 'history');
    $('drHistoryPanel').classList.toggle('hidden', v !== 'history');
    if (v === 'today') $('drSubtitle').textContent = SUBTITLE_TODAY;
  }

  // 管理员手动重跑（需求 8）
  async function rerun() {
    if (!window.confirm('手动重跑当日复盘？\n若正式版已存在且数据未更完整，将自动跳过（幂等）；数据更完整时生成修订版。')) return;
    const btn = $('drRerunBtn');
    btn.disabled = true;
    const main = $('drMain');
    main.innerHTML = '<div class="dr-loading">⏳ 正在重跑：并行采集 8 类数据源…</div>';
    S.running = true;
    setStatus(S.today, null);
    startPoll();
    try {
      const r = await api('/api/review/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date: S.date, force: false }),
      });
      stopPoll();
      if (r.action === 'failed') {
        main.innerHTML = '<div class="dr-fail-box"><h2>重跑失败</h2><p>连续 3 次失败，已输出失败报告。</p></div>';
      } else if (r.action === 'skipped_holiday') {
        // 非交易日：不拿最近交易日行情冒充当日复盘，页面显示休市
        await loadToday();
        $('drToolbarNote').textContent = '今日休市（非交易日），按规则跳过生成';
      } else if (r.action === 'skipped') {
        await loadToday();
        $('drToolbarNote').textContent = '正式版已存在且数据未更完整，已跳过';
      } else {
        await loadToday();
        $('drToolbarNote').textContent = r.message || ('已生成 ' + (r.action === 'revision' ? '修订版' : '正式版'));
      }
    } catch (e) {
      stopPoll();
      main.innerHTML = '<div class="dr-empty">重跑失败：' + esc(e.message) + '</div>';
    } finally {
      btn.disabled = false;
    }
  }

  window.DailyReviewPage = {
    init() {
      const di = $('drDateInput');
      if (di && !di.value) di.value = localToday();
      $('drSubtitle').textContent = SUBTITLE_TODAY;   // 覆盖 HTML 初始文案里的旧「12 段」字样（不改 HTML 文件）
      $('drRerunBtn').addEventListener('click', rerun);
      $('drTabToday').addEventListener('click', () => { switchView('today'); loadToday(); });
      $('drTabHistory').addEventListener('click', () => { switchView('history'); loadHistory(); });
      $('drByDateBtn').addEventListener('click', () => {
        const v = di && di.value;
        if (!v) { alert('请先选择日期'); return; }
        loadByDate(v);
      });
      loadToday();   // 需求 8：页面点击后自动加载当日复盘
    },
    loadToday, loadHistory, loadByDate, rerun,
  };
})();
