# 前端（public/） · 第 1 卷

> 共 8 个文件，本卷约 17915 行


---

## `public\accuracy.html`  ·  140 行

~~~html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>分析准确率检查 · 大盘技术分析 / 个股技术面 / 短期行情判断 / 市场情绪提醒</title>
  <link rel="icon" type="image/x-icon" href="favicon.ico?v=20261106p">
  <link rel="icon" type="image/png" sizes="512x512" href="icon.png?v=20261106p">
  <link rel="stylesheet" href="css/style.css?v=20261106p">
  <!-- 本页是独立长页，覆盖主工作台全局的 html,body{overflow:hidden} 以恢复滚动。
       20261025f：页宽/工具条/tab 芯片/KPI/提示样式统一在 style.css「独立长页统一外壳」段（令牌取色）。 -->
  <style>
    html, body { height: auto !important; overflow-y: auto !important; overflow-x: hidden; }
  </style>
</head>
<body>
  <div class="acc-page">
    <header class="jd-header">
      <h1 class="jd-title">🎯 分析准确率检查</h1>
      <div class="jd-actions">
        <button id="reloadBtn" class="btn-secondary">重新加载</button>
        <button id="settleBtn" class="btn-primary" title="拉取最新行情结算历史判断，再刷新统计">结算并刷新</button>
        <a href="index.html" class="btn-text">返回工作台</a>
      </div>
    </header>

    <div id="loadingOverlay" class="loading-overlay hidden">
      <div class="loading-spinner"></div>
      <p id="loadingText">正在加载准确率数据…</p>
    </div>

    <div class="acc-toolbar">
      <div class="acc-tabs">
        <button class="acc-tab active" data-tab="market">大盘技术分析</button>
        <button class="acc-tab" data-tab="tech">个股技术面</button>
        <button class="acc-tab" data-tab="sameDay">短期行情判断</button>
        <button class="acc-tab" data-tab="sentiment">市场情绪提醒</button>
        <button class="acc-tab" data-tab="consistency">数据巡检</button>
      </div>
      <div id="techSymbolBar" style="display:none; margin-bottom:10px;">
        <input type="text" id="symbolInput" class="jd-filter" placeholder="输入股票代码（如 601318）查该股技术面准确率" autocomplete="off" style="max-width:320px;">
        <button id="symbolQueryBtn" class="btn-secondary">查询该股</button>
      </div>
      <div id="sameDaySymbolBar" style="display:none; margin-bottom:10px;">
        <input type="text" id="sdSymbolInput" class="jd-filter" placeholder="输入股票代码（如 601318）查该股短期判断准确率" autocomplete="off" style="max-width:320px;">
        <button id="sdSymbolQueryBtn" class="btn-secondary">查询该股</button>
      </div>
    </div>

    <!-- 大盘技术分析 -->
    <section id="marketPanel">
      <div class="acc-hint">
        结算口径：<b>短期方向</b> = <code>step6.shortTerm.direction</code> 对照<b>次日</b>上证指数收盘方向；
        <b>中期方向</b> = <code>step6.midTerm.direction</code> 对照<b>20 个交易日</b>后收盘方向；
        <b>融合信号</b> = <code>fused.fusionSignal</code> 按次日口径结算。
        命中＝方向一致，「震荡」以涨跌绝对值 ≤ <span id="flatTol">0.5</span>% 计。
      </div>
      <div class="acc-kpis" id="marketKpis"></div>
      <div class="acc-hint" id="marketCalib"></div>
      <section class="home-card">
        <div class="home-card-head"><h2>逐条记录（最新在前）</h2><span id="marketCount" class="mo-updated"></span></div>
        <div id="marketRecords" class="acc-body"></div>
      </section>
    </section>

    <!-- 个股技术面 -->
    <section id="techPanel" style="display:none;">
      <div class="acc-hint">
        结算口径：<code>shortTerm.direction</code>（上行/下行/震荡偏上/震荡偏下/冲高回落/超跌反弹）归一化为 涨/跌/震荡，
        对照<b>未来 5 个交易日</b>累计涨跌。<br>
        ⚠️ 本页与「短期行情判断」的 <code>technicalShort</code> 因子<b>口径不同</b>：后者用次日涨跌验证个股整体判断，
        本页用 5 日累计验证<b>技术面模块自身</b>的方向，两者互不干扰。
      </div>
      <div class="acc-kpis" id="techKpis"></div>
      <section class="home-card" id="techBySymbolCard">
        <div class="home-card-head"><h2>各股技术面准确率</h2><span id="techCount" class="mo-updated"></span></div>
        <div id="techBySymbol" class="acc-body"></div>
      </section>
      <section class="home-card" id="techRecordsCard" style="display:none;">
        <div class="home-card-head"><h2 id="techRecordsTitle">逐条记录</h2></div>
        <div id="techRecords" class="acc-body"></div>
      </section>
    </section>

    <!-- 短期行情判断 -->
    <section id="sameDayPanel" style="display:none;">
      <div class="acc-hint">
        结算口径：当日个股短期涨跌判断（<code>dir</code> ∈ 涨/跌/震荡）对照<b>目标交易日</b>实际收盘方向。
        含两种口径：<code>intraday</code>（今日后续：判断时刻价 → 当日收盘）与
        <code>nextday</code>（下一交易日：今日收盘 → 次日收盘）。<br>
        命中＝方向一致，「震荡」以涨跌绝对值 ≤ 1.0% 计。数据源与「个股页 · 短期行情判断」卡片同源，为本项目准确率统计的主口径。
      </div>
      <div class="acc-kpis" id="sdKpis"></div>
      <div class="acc-hint" id="sdCalib"></div>
      <section class="home-card" id="sdBySymbolCard">
        <div class="home-card-head"><h2>各股短期判断准确率</h2><span id="sdCount" class="mo-updated"></span></div>
        <div id="sdBySymbol" class="acc-body"></div>
      </section>
      <section class="home-card" id="sdRecordsCard" style="display:none;">
        <div class="home-card-head"><h2 id="sdRecordsTitle">逐条记录</h2></div>
        <div id="sdRecords" class="acc-body"></div>
      </section>
    </section>

    <!-- 数据巡检（20261103e）：跨板块同数据一致性核对 -->
    <section id="consistencyPanel" style="display:none;">
      <div class="acc-hint">
        巡检口径：核对<b>同一数据在多个板块的展示值是否一致</b>（即使数据源不同）。
        ⚠️ <b>累计数据与固定期数据分属不同口径，绝不互比</b>——如「前三季度累计」与「第三季度单季」数值不同属正常口径差异，
        注记为「口径差异」而非不一致；仅「同口径数值不一致」才记为<b>不一致（需修复）</b>。
        兜底 0（取不到的比率字段，左卡显示 --）按缺失跳过。每交易日收盘后自动巡检全部自选股并落盘，可点「结算并刷新」立即重跑。
      </div>
      <div class="acc-kpis" id="caKpis"></div>
      <div class="acc-hint" id="caCalib"></div>
      <section class="home-card">
        <div class="home-card-head"><h2>逐股巡检明细</h2><span id="caCount" class="mo-updated"></span></div>
        <div id="caBody" class="acc-body"></div>
      </section>
    </section>

    <!-- 市场情绪提醒 -->
    <section id="sentimentPanel" style="display:none;">
      <div class="acc-hint">
        结算口径：<b>仅对「预警 / 强烈预警」且带明确方向</b>（看涨 / 看跌）的情绪拐点判断留档
        （「无」「关注」以及方向为「震荡」的日期不留档 —— 没有明确判断就无从验证），
        对照<b>次日上证指数</b>实际涨跌。<br>
        命中＝次日方向与预警方向一致；次日涨跌幅 ≤ <span id="sentFlatTol">0.5</span>% 视为震荡，此时方向性预警记为<b>未命中</b>。
      </div>
      <div class="acc-kpis" id="sentKpis"></div>
      <section class="home-card">
        <div class="home-card-head"><h2>逐条记录（最新在前）</h2><span id="sentCount" class="mo-updated"></span></div>
        <div id="sentRecords" class="acc-body"></div>
      </section>
    </section>
  </div>

  <script src="js/accuracy.js?v=20261106p"></script>
</body>
</html>

~~~

---

## `public\css\style.css`  ·  6707 行

~~~css
/* ===== CSS Variables =====
   柔和暗色系（面向干眼症 / 强光敏感用户）：
   - 低亮度背景，避免纯黑与纯白
   - 低对比文字（柔灰而非刺眼白）
   - 低饱和强调色，避免高饱和色块眩光
*/
:root {
  /* ===== 主题：华尔街交易终端 · 深色专业主题 ===== */
  --bg-primary: #0B0E11;   /* 页面背景 */
  --bg-sidebar: #0E1217;   /* 侧边栏（比页面略深，突出层级） */
  --bg-card: #161B22;      /* 卡片背景 */
  --bg-hover: #1D242D;     /* 悬停 / 次级面 */
  --bg-elevated: #1A212B;  /* 抬升面板 */
  --bg-input: #0F131A;     /* 输入框 */
  --surface: var(--bg-card);
  --surface-hover: var(--bg-hover);
  --bg: var(--bg-card);
  --bg-secondary: var(--bg-hover);
  --bg-subtle: var(--bg-hover);
  --hover: var(--bg-hover);

  /* ===== 文字三级 ===== */
  --text-primary: #E6EDF3;
  --text-secondary: #8B949E;
  --text-dim: #8B949E;
  --text-muted: #8B949E;
  --text-light: #828B96;
  --text-disabled: #484F58;
  --text: var(--text-primary);
  --text-on-dark: var(--text-primary);
  --text-on-dark-secondary: var(--text-secondary);

  /* ===== 边框 ===== */
  --border: rgba(255,255,255,0.08);
  --border-color: var(--border);
  --border-light: var(--border);
  --border-strong: rgba(255,255,255,0.16);

  /* ===== 品牌强调色：金色（仅交互焦点 / 选中态 / 主按钮） ===== */
  --accent: #F0B97B;
  --accent-hover: #F5C894;
  --accent-light: rgba(240,185,123,0.16);
  --blue: var(--accent);
  --brand: #F0B97B;

  /* ===== 涨跌语义色：红涨 / 绿跌（全站唯一，严禁其他颜色表达涨跌） ===== */
  --red: #F6465D;
  --tint-red: rgba( 246,70,93,0.10 ); --red-light: var(--tint-red);
  --red-soft: var(--tint-red);
  --green: #0ECB81;
  --tint-green: rgba( 14,203,129,0.10 ); --green-light: var(--tint-green);
  --green-soft: var(--tint-green);
  --flat: #8B949E;

  /* ===== 辅助语义色 ===== */
  --orange: #F0B97B;
  --amber: #E0B45C;
  --amber-bg: rgba(224,180,92,0.14);
  --amber-text: #E0B45C;
  --purple: #A78BFA;
  --teal: #2DD4BF;

  /* ===== 阴影 ===== */
  --shadow: 0 2px 8px rgba(0,0,0,0.5);
  --shadow-lg: 0 12px 32px rgba(0,0,0,0.5);

  /* ===== 圆角 ===== */
  --radius: 8px;       /* 卡片 */
  --radius-sm: 6px;    /* 按钮 / 输入框 */
  --radius-xs: 4px;    /* 小标签 */
  --sidebar-width: 288px;

  /* ===== 间距体系 ===== */
  --spacing-4: 4px;
  --spacing-8: 8px;
  --spacing-12: 12px;
  --spacing-16: 16px;
  --spacing-24: 24px;
  --gap: 16px;
  --gap-lg: 24px;
  --pad-card: 16px;
}

/* ===== 全局涨跌色工具类（红涨绿跌，全站唯一语义） ===== */
.up, .bullish { color: var(--red) !important; }
.down, .bearish { color: var(--green) !important; }
.flat { color: var(--flat) !important; }
.bg-up { background: var(--red-soft); }
.bg-down { background: var(--green-soft); }

/* 涨跌幅绝对值 ≥10% 时数字加粗（仅加粗，不改变涨跌色） */
.chg-strong { font-weight: 700 !important; }

/* 数据刷新时仅数字位闪动，避免整行重绘闪烁 */
@keyframes numFlash {
  0% { opacity: 0.15; }
  100% { opacity: 1; }
}
.num-flash { animation: numFlash 0.45s ease-out; }

/* ===== Reset ===== */
* { margin: 0; padding: 0; box-sizing: border-box; }
/* 20261016：全局键盘焦点环（金色，仅键盘导航时出现，不干扰鼠标点击） */
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
html, body { height: 100%; overflow: hidden; }
body {
  font-family: 'Segoe UI Variable Text', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.6;
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* ===== Layout ===== */
#app {
  display: flex;
  height: 100vh;
}

/* ===== Sidebar ===== */
.sidebar {
  width: var(--sidebar-width);
  background: var(--bg-sidebar);
  color: var(--text-on-dark);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  overflow-x: hidden; /* 侧栏内容不允许横向滚动，宽度溢出直接裁切 */
  flex-shrink: 0;
}

.sidebar-header {
  padding: 22px 20px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}

.logo {
  font-size: 21px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--text-on-dark);
}

/* Search */
.search-section {
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  position: relative;
}

.search-box {
  display: flex;
  gap: 8px;
}

.search-box input {
  flex: 1;
  padding: 9px 12px;
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: var(--radius-sm);
  background: rgba(255,255,255,0.08);
  color: var(--text-on-dark);
  font-size: 13px;
  outline: none;
  transition: all 0.2s;
}

.search-box input::placeholder { color: var(--text-on-dark-secondary); }
.search-box input:focus { border-color: var(--accent); background: rgba(255,255,255,0.12); }

.btn-search {
  padding: 9px 16px;
  background: var(--accent);
  color: #0B0E11;
  border: none;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  transition: background 0.2s;
}
.btn-search:hover { background: var(--accent-hover); }

.search-results {
  position: absolute;
  top: 100%;
  left: 20px;
  right: 20px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-lg);
  max-height: 300px;
  overflow-y: auto;
  z-index: 100;
  display: none;
}
.search-results.show { display: block; }

.search-result-item {
  padding: 10px 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  display: flex;
  justify-content: space-between;
  align-items: center;
  transition: background 0.15s;
}
.search-result-item:hover { background: var(--bg-hover); }
.search-result-item:last-child { border-bottom: none; }
.search-result-item .name { font-weight: 500; color: var(--text-primary); }
.search-result-item .code { font-size: 12px; color: var(--text-light); }
.search-result-item .market-tag {
  font-size: 10px;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--accent-light);
  color: var(--accent);
}

/* Quick links */
.quick-links {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 20px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}

.quick-link {
  padding: 4px 10px;
  background: rgba(255,255,255,0.08);
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
  color: var(--text-on-dark-secondary);
  transition: all 0.2s;
}
.quick-link:hover { background: var(--accent); color: #0B0E11; font-weight: 600; }

/* Sidebar sections */
.sidebar-section {
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 10px;
}
/* 20261016：侧栏 section 头部右侧动作组（清除 + 折叠按钮，间距由 .btn-collapse 自带 margin-left 提供） */
.section-header .header-actions { display: flex; align-items: center; }
/* 20261016：侧栏搜索历史面板可折叠（与首页卡片折叠机制一致） */
.sidebar-section.collapsed > :not(.section-header) { display: none; }
.sidebar-section.collapsed .section-header { margin-bottom: 0; }

.section-header h3, .section-header h2 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-on-dark);
}

.count-badge {
  background: var(--accent);
  color: #0B0E11;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 10px;
}

.btn-text {
  background: none;
  border: none;
  color: var(--text-on-dark-secondary);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 6px;
}
.btn-text:hover { color: var(--text-on-dark); }

/* Watchlist */
.watchlist-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 0;
  cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  transition: all 0.15s;
}
.watchlist-item:hover { padding-left: 6px; }
.watchlist-item .wl-info { display: flex; flex-direction: column; }
.watchlist-item .wl-name { font-size: 13px; color: var(--text-on-dark); }
.watchlist-item .wl-code { font-size: 11px; color: var(--text-on-dark-secondary); }
.watchlist-item .wl-remove {
  color: var(--text-on-dark-secondary);
  cursor: pointer;
  font-size: 16px;
  padding: 0 4px;
  opacity: 0.5;
  transition: opacity 0.2s;
}
.watchlist-item .wl-remove:hover{ color: var(--accent); }

/* History */
.history-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 0;
  cursor: pointer;
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.history-item:hover .h-name { color: var(--accent); }
.history-item .h-name { font-size: 13px; color: var(--text-on-dark); transition: color 0.15s; }
.history-item .h-time { font-size: 11px; color: var(--text-on-dark-secondary); }

/* ===== Main Content ===== */
.main-content {
  flex: 1;
  overflow-y: auto;
  padding: 32px 36px 48px;
  position: relative;
}

/* Loading */
.loading-overlay {
  position: absolute;
  inset: 0;
  background: rgba(21,24,28,0.92);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.loading-overlay.hidden { display: none; }

.loading-spinner {
  width: 48px;
  height: 48px;
  border: 4px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

.loading-text { margin-top: 16px; color: var(--text-secondary); font-size: 14px; }

/* 顶部进度条：非阻塞加载指示，pointer-events:none 不拦截任何交互 */
.top-progress {
  position: fixed;
  top: 0; left: 0;
  height: 3px;
  width: 0;
  z-index: 80;
  pointer-events: none;
  background: linear-gradient(90deg, var(--accent), var(--purple));
  box-shadow: 0 0 8px rgba(240,185,123,0.6);
  opacity: 0;
  transition: width 0.4s ease, opacity 0.25s ease;
}

/* ---- 加载提示胶囊（20261022i）----
   与顶部进度条配套：进度条只表达"有事情在发生"，胶囊表达"具体在加载哪只股票"。
   pointer-events:none —— 绝不拦截任何点击（这是它和 .loading-overlay 的关键区别），
   因此切股等待期间用户仍可继续操作，只是不会再误以为点击没生效。 */
.loading-pill {
  position: fixed;
  top: 10px; left: 50%;
  transform: translateX(-50%) translateY(-6px);
  z-index: 81;
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  background: rgba(22,27,34,0.96);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  box-shadow: var(--shadow-lg);
  opacity: 0;
  transition: opacity .18s ease, transform .18s ease;
  max-width: 78vw;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.loading-pill.hidden { display: none; }
.loading-pill.on { opacity: 1; transform: translateX(-50%) translateY(0); }
.loading-pill::before {
  content: '';
  width: 10px; height: 10px;
  flex-shrink: 0;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}
.top-progress.active { opacity: 1; width: 85%; }
.top-progress.done { opacity: 1; width: 100%; }

/* Empty state */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  min-height: 100%;
  text-align: left;
  padding: 24px;
}
.empty-state > .home-hero { text-align: center; width: 100%; }

.empty-icon { font-size: 64px; margin-bottom: 20px; }
.empty-state h2 { font-size: 24px; margin-bottom: 8px; color: var(--text-primary); }
.empty-state > p { color: var(--text-secondary); margin-bottom: 32px; }

.features-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  max-width: 700px;
  width: 100%;
}

.feature-card {
  background: var(--bg-card);
  border-radius: var(--radius);
  padding: 20px;
  text-align: center;
  box-shadow: var(--shadow);
  transition: transform 0.2s, box-shadow 0.2s;
}
.feature-card:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); }
.feature-icon { font-size: 32px; display: block; margin-bottom: 10px; }
.feature-card h4 { font-size: 15px; margin-bottom: 6px; }
.feature-card p { font-size: 12px; color: var(--text-secondary); }

/* Dashboard */
.dashboard.hidden, .empty-state.hidden { display: none; }

/* Stock header */
.stock-header {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  flex-wrap: wrap;
  gap: 16px;
  background: linear-gradient(180deg, var(--bg-elevated), var(--bg-card));
  padding: 18px 22px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  backdrop-filter: blur(8px);
}

.stock-title-row { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.stock-title-row h2 { font-size: 24px; font-weight: 700; margin: 0; letter-spacing: 0.2px; }
.stock-code { font-size: 13px; color: var(--text-secondary); background: var(--bg-primary); padding: 3px 9px; border-radius: 6px; }
.stock-market { font-size: 11px; padding: 3px 9px; border-radius: 6px; background: var(--accent-light); color: var(--accent); font-weight: 600; }
.stock-price { font-size: 32px; font-weight: 700; letter-spacing: -0.3px; }
.stock-change { font-size: 15px; font-weight: 600; }
.stock-change.up { color: var(--red); }
.stock-change.down { color: var(--green); }
.stock-date { font-size: 13px; color: var(--text-light); white-space: nowrap; }
.stock-date::before { content: '行情日期 '; color: var(--text-secondary); }

.stock-date-bar { display: flex; gap: 18px; margin-top: 8px; flex-wrap: wrap; align-items: center; }
.stock-fin-date { font-size: 13px; color: var(--text-light); white-space: nowrap; }
.stock-fin-date::before { content: '财务 '; color: var(--text-secondary); }
/* 20261101n：换手率/成交额自页首固定指标条移入个股标题卡信息行（标签前置伪元素，与行情日期/财务同构） */
.stock-turnover, .stock-amount, .stock-vol-ratio { font-size: 13px; color: var(--text-light); white-space: nowrap; }
.stock-turnover::before { content: '换手率 '; color: var(--text-secondary); }
/* 20261106d：banner 换手率后补量比，与相邻两枚同字号同色、仅前缀标签弱化，保持信息行节奏统一 */
.stock-vol-ratio::before { content: '量比 '; color: var(--text-secondary); }
.stock-amount::before { content: '成交额 '; color: var(--text-secondary); }

.stock-actions { display: flex; gap: 8px; align-items: center; }

/* 20261104f：banner 右侧「回到顶部」按钮（softDark 主题，hover 琥珀与全站小按钮一致） */
.back-top-btn {
  padding: 7px 14px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 13px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.2s;
}
.back-top-btn:hover { border-color: var(--accent); color: var(--accent); }
.back-top-btn:active { transform: translateY(1px); }

.btn-icon {
  width: 36px;
  height: 36px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-secondary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  transition: all 0.2s;
}
.btn-icon:hover { border-color: var(--accent); color: var(--accent); }
.btn-icon.active { color: var(--orange); border-color: var(--orange); }

.btn-secondary {
  padding: 8px 14px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  color: var(--text-primary);
  transition: all 0.2s;
}
.btn-secondary:hover { border-color: var(--accent); color: var(--accent); }

/* Key metrics bar */
.key-metrics-bar {
  display: flex;
  gap: 1px;
  background: var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  margin-bottom: 24px;
  flex-wrap: wrap;
  border: 1px solid var(--border);
}

.metric-item {
  flex: 1;
  min-width: 110px;
  background: var(--bg-card);
  padding: 16px 20px;
  text-align: center;
}

.metric-item .metric-label { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; letter-spacing: 0.3px; }
.metric-item .metric-value { font-size: 18px; font-weight: 700; }
.metric-item .metric-value.red { color: var(--red); }
.metric-item .metric-value.green { color: var(--green); }
.metric-item .metric-sub { font-size: 11px; color: var(--text-dim); margin-top: 4px; line-height: 1.4; }
.metric-item .metric-source { font-size: 10px; color: var(--text-light); margin-top: 3px; line-height: 1.4; }

/* Scores row */
.scores-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 18px;
  margin-bottom: 24px;
}

.score-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 22px;
  text-align: center;
  box-shadow: var(--shadow);
  transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease;
}
.score-card.clickable:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-lg);
  border-color: var(--border-strong);
}

.score-label { font-size: 13px; color: var(--text-secondary); margin-bottom: 10px; letter-spacing: 0.3px; }
.score-value { font-size: 30px; font-weight: 700; margin-bottom: 6px; letter-spacing: -0.3px; }
.score-value.strong-bullish { color: var(--red); }
.score-value.bullish { color: var(--orange); }
.score-value.neutral { color: var(--text-secondary); }
.score-value.bearish { color: var(--teal); }
.score-value.strong-bearish { color: var(--green); }
.score-value.excellent { color: var(--red); }
.score-value.good { color: var(--orange); }
.score-value.average { color: var(--text-secondary); }
.score-value.weak { color: var(--teal); }
.score-value.poor { color: var(--green); }
.score-detail { font-size: 12px; color: var(--text-light); }

/* 个股近期热点追踪与分析卡片（20260826g） */
.hot-topics-card {
  text-align: left;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.hot-topics-card .score-label { margin-bottom: 0; }
.hot-topics-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.hot-topics-date { font-size: 11px; color: var(--text-light); white-space: nowrap; }
.hot-topics-input-row { display: flex; gap: 6px; margin-bottom: 8px; }
.hot-topic-input {
  flex: 1 1 auto;
  min-width: 0;
  background: var(--bg-input, var(--bg-card));
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 12px;
  color: var(--text);
}
.hot-topic-input:focus { outline: none; border-color: var(--accent, var(--border-strong)); }
.hot-topics-actions { display: flex; gap: 6px; margin-bottom: 10px; flex-wrap: wrap; }
.hot-topics-actions .ai-trigger-btn {
  flex: 1 1 auto;
  font-size: 11px;
  padding: 5px 6px;
  white-space: nowrap;
}
.hot-topics-chips { margin-bottom: 8px; }
.hot-topics-chip-label { font-size: 11px; color: var(--text-light); margin-bottom: 4px; }
.hot-topics-chip-list { display: flex; flex-wrap: wrap; gap: 5px; }
.hot-topic-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  padding: 2px 6px 2px 8px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--bg-hover, rgba(255,255,255,0.04));
  color: var(--text);
}
.hot-topic-chip.manual { border-color: var(--accent); color: var(--accent); }
.hot-topic-chip .chip-x {
  cursor: pointer;
  font-weight: 700;
  line-height: 1;
  opacity: 0.6;
  padding: 0 2px;
}
.hot-topic-chip .chip-x:hover { opacity: 1; }
.hot-topic-chip.none { border-style: dashed; color: var(--text-light); }
.hot-topics-analysis {
  margin-top: 4px;
  border-top: 1px dashed var(--border);
  padding-top: 8px;
  max-height: 260px;
  overflow-y: auto;
}
.hot-topic-item { margin-bottom: 10px; }
.hot-topic-item:last-child { margin-bottom: 0; }
.hot-topic-item-head { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.hot-topic-kw { font-size: 13px; font-weight: 600; color: var(--text); }
.hot-topic-prio {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 8px;
  border: 1px solid var(--border);
  color: var(--text-light);
}
.hot-topic-prio.manual { border-color: var(--accent); color: var(--accent); }
.hot-topic-sent {
  font-size: 10px;
  padding: 0 5px;
  border-radius: 8px;
  font-weight: 600;
}
.hot-topic-sent.利好 { color: var(--red); background: var(--tint-red); }
.hot-topic-sent.利空 { color: var(--green); background: var(--tint-green); }
.hot-topic-sent.中性 { color: var(--text-secondary); background: rgba(128,128,128,0.14); }
.hot-topic-sent.未知 { color: var(--text-light); background: rgba(128,128,128,0.10); }
.hot-topic-analysis-text { font-size: 12px; line-height: 1.5; color: var(--text-secondary); }
.hot-topic-sources { font-size: 11px; color: var(--text-light); margin-top: 2px; }
.hot-topic-summary {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text);
  background: var(--bg-hover, rgba(255,255,255,0.04));
  border-radius: 6px;
  padding: 6px 8px;
  margin-bottom: 10px;
}
.hot-topics-analysis .ai-empty { font-size: 12px; color: var(--text-light); text-align: center; padding: 8px 0; }

/* 股吧讨论热度条（20260913f：与「舆情与讨论热度（个股）」因子同源，保证两卡口径一致） */
.ht-discussion {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  background: rgba(240, 185, 123, 0.08);
  border: 1px solid rgba(240, 185, 123, 0.28);
  border-radius: 8px;
  padding: 7px 10px;
  margin-bottom: 10px;
  font-size: 12px;
  line-height: 1.5;
}
.ht-disc-label { color: var(--accent, #F0B97B); font-weight: 600; white-space: nowrap; }
.ht-disc-text { color: var(--text, #E6EDF3); word-break: break-word; }

/* 当日异动归因（涨跌幅 ≥3%） */
.ht-price-change {
  background: var(--bg-hover, rgba(255,255,255,0.04));
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.ht-price-change.ht-pc-up { border-left: 3px solid var(--red); }
.ht-price-change.ht-pc-down { border-left: 3px solid var(--green); }
.ht-pc-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 6px;
}
.ht-pc-pct {
  font-size: 14px;
  font-weight: 700;
}
.ht-pc-up .ht-pc-pct { color: var(--red); }
.ht-pc-down .ht-pc-pct { color: var(--green); }
/* 20261013g：振幅角标（触发来源展示；中性色，不与涨跌幅的涨跌色争语义） */
.ht-pc-amp { font-size: 11px; font-weight: 600; color: var(--accent); background: rgba(240,185,123,.12); border: 1px solid rgba(240,185,123,.3); border-radius: 6px; padding: 1px 6px; margin-left: 5px; }
.ht-pc-analysis {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  white-space: pre-line;
}
.ht-pc-sources {
  font-size: 11px;
  color: var(--text-light);
  margin-top: 6px;
}
.ht-cached { font-size: 11px; color: var(--text-light); font-weight: 400; }

/* 网络热议话题（涨跌幅 <3%） */
.ht-trending {
  background: var(--bg-hover, rgba(255,255,255,0.04));
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 10px;
}
.ht-trend-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 6px;
}
.ht-trend-count {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-light);
  background: var(--bg-elevated, rgba(255,255,255,0.06));
  border-radius: 10px;
  padding: 1px 8px;
}
.ht-trend-summary {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary);
  margin-bottom: 8px;
  white-space: pre-line;
}
.ht-topic-list { display: flex; flex-direction: column; gap: 6px; }
.ht-topic-item {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  background: var(--bg-elevated, rgba(255,255,255,0.03));
}
.ht-topic-head {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.ht-topic-kw { font-size: 12px; font-weight: 600; color: var(--text); }
.ht-topic-heat {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  border: 1px solid var(--border);
  color: var(--text-light);
}
.ht-topic-heat.heat-高 { color: var(--accent); border-color: var(--accent); }
.ht-topic-heat.heat-中 { color: var(--amber); border-color: var(--amber); }
.ht-topic-heat.heat-低 { color: var(--text-light); }
.ht-topic-sent {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  font-weight: 600;
}
.ht-topic-sent.pos { color: var(--red); background: var(--tint-red); }
.ht-topic-sent.neg { color: var(--green); background: var(--tint-green); }
.ht-topic-sent.neu { color: var(--text-light); background: var(--bg-elevated, rgba(255,255,255,0.06)); }
.ht-topic-sent.unk { color: var(--text-light); background: var(--bg-elevated, rgba(255,255,255,0.06)); }
.ht-topic-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* 投资者问答子卡（20260923h：沪市上证e互动 / 深市巨潮互动易） */
.ht-irm {
  background: var(--bg-hover, rgba(255,255,255,0.04));
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-top: 10px;
}
.ht-irm-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}
.ht-irm-src {
  font-size: 10px;
  font-weight: 500;
  color: var(--accent, #F0B97B);
  border: 1px solid rgba(240, 185, 123, 0.35);
  background: rgba(240, 185, 123, 0.08);
  border-radius: 8px;
  padding: 1px 6px;
}
.ht-irm-count { font-size: 11px; font-weight: 500; color: var(--text-light); }
.ht-irm-list { display: flex; flex-direction: column; gap: 8px; }
.ht-irm-item {
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 9px;
  background: var(--bg-elevated, rgba(255,255,255,0.03));
}
.ht-irm-q {
  font-size: 12px;
  line-height: 1.55;
  color: var(--text);
  word-break: break-word;
}
.ht-irm-a {
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--text-secondary);
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px dashed var(--border);
  word-break: break-word;
}
.ht-irm-q-tag, .ht-irm-a-tag {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  border-radius: 4px;
  padding: 0 4px;
  margin-right: 5px;
  vertical-align: 1px;
}
.ht-irm-q-tag { color: var(--accent, #F0B97B); background: rgba(240, 185, 123, 0.14); }
.ht-irm-a-tag { color: var(--text-light); background: var(--bg-elevated, rgba(255,255,255,0.08)); }
.ht-irm-a-none { color: var(--text-light); font-style: italic; }
.ht-irm-time { font-size: 10px; color: var(--text-light); margin-left: 6px; white-space: nowrap; }
.ht-irm-note { font-size: 11px; line-height: 1.5; color: var(--text-light); }

/* 概览补充卡片：最大亮点/雷点（小字多行） */
.score-value.aspect {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.55;
  text-align: left;
  margin-bottom: 6px;
  color: var(--text-primary);
}
.asp-hl { color: var(--red); margin-bottom: 4px; word-break: break-word; }
.asp-rk { color: var(--accent); word-break: break-word; }
.asp-empty { color: var(--text-light); font-weight: 400; }
/* 20261016b（审计 H2）：概览卡「亮点/雷点」尚未生成时的卡内生成入口 */
.asp-gen-hint { color: var(--text-light); }
.asp-gen-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--accent);
  border-radius: 4px;
  padding: 1px 8px;
  font-size: 12px;
  cursor: pointer;
}
.asp-gen-btn:hover { border-color: var(--accent); }
.asp-gen-btn:disabled { opacity: .55; cursor: default; }

/* Tabs */
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 22px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.tab {
  padding: 12px 20px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-secondary);
  font-weight: 500;
  position: relative;
  letter-spacing: 0.2px;
  white-space: nowrap;
  transition: color 0.18s;
}
.tab:hover { color: var(--text-primary); }
.tab.active { color: var(--accent); font-weight: 600; }
.tab.active::after {
  content: '';
  position: absolute;
  bottom: -1px;
  left: 8px;
  right: 8px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: var(--accent);
}

/* Tab panels */
.tab-panel { display: none; }
.tab-panel.active { display: block; }

/* Chart cards */
.chart-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 22px;
  box-shadow: var(--shadow);
  margin-bottom: 18px;
}
.chart-card.hidden { display: none; }

.chart-card h3 { font-size: 15px; font-weight: 600; margin-bottom: 18px; letter-spacing: 0.2px; }

.chart-card.large .chart { height: 400px; }
.chart { height: 300px; width: 100%; }

/* 图表口径说明（如 TTM 估算提示） */
.chart-caption { margin-top: 8px; font-size: 12.5px; line-height: 1.6; color: var(--text-dim); }

/* 分业务趋势：卡片内趋势说明 / TTM 提示 */
.bl-note { margin-top: 10px; font-size: 12.5px; line-height: 1.6; color: var(--text-dim); }
.bl-line { margin-bottom: 4px; }
.bl-caption { margin-top: 4px; color: var(--text-dim); }
.bl-ttm { color: var(--amber); font-weight: 600; }

/* 股息率趋势：文字分析块（公司 vs 行业均值 / 排名） */
.dy-analysis { margin-top: 10px; font-size: 12.5px; line-height: 1.65; color: var(--text-dim); }
.dy-note { padding: 4px 2px; }
.dy-line { margin-bottom: 5px; }
.dy-line b { color: var(--text-primary); }
.dy-sub { color: var(--text-dim); opacity: 0.85; font-size: 12px; }
.dy-empty { color: var(--amber); }
.dy-peers { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: center; }
.dy-peers-title { color: var(--text-dim); margin-right: 4px; }
.dy-peer { padding: 2px 8px; border-radius: 4px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); white-space: nowrap; }
.dy-peer.self { background: rgba(240,185,123,0.18); border-color: #7fa8c9; color: #cfe2f3; font-weight: 600; }

/* 产品毛利率表格：不使用固定高度，随表格内容自然撑开，避免与下方卡片重叠 */
.product-margin-chart { height: auto; min-height: 220px; overflow: visible; }
.product-margin-card { overflow: visible; }

/* 深度分析：可折叠分组（减少单页信息密度） */
.deep-group { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 18px; overflow: hidden; background: var(--surface); box-shadow: var(--shadow); }
.deep-group-header { display: flex; align-items: center; justify-content: space-between; padding: 15px 20px; cursor: pointer; user-select: none; font-weight: 600; font-size: 15px; transition: background .15s; }
.deep-group-header:hover { background: var(--surface-hover); }
.deep-group-header .chevron { transition: transform .2s ease; font-size: 13px; color: var(--text-secondary); }
.deep-group.collapsed .deep-group-header .chevron { transform: rotate(-90deg); }
.deep-group-body { padding: 6px 20px 20px; }
.deep-group.collapsed .deep-group-body { display: none; }

.chart-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 18px;
  gap: 12px;
  flex-wrap: wrap;
}

/* 时间范围 / 周期选择器：Robinhood 式胶囊分组（内凹浅底 + 圆角胶囊按钮） */
.chart-controls {
  display: inline-flex; gap: 2px; align-items: center;
  padding: 3px;
  background: rgba(255,255,255,0.035);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 999px;
}

.range-btn, .period-btn, .dy-toggle-btn {
  padding: 4px 13px;
  border: none;
  background: transparent;
  border-radius: 999px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  transition: color 0.16s, background 0.16s, box-shadow 0.16s;
}
.range-btn:hover, .period-btn:hover, .dy-toggle-btn:hover {
  background: rgba(255,255,255,0.07);
  color: var(--text-primary);
}
.range-btn.active, .period-btn.active, .dy-toggle-btn.active {
  background: var(--accent);
  color: #0B0E11;
  font-weight: 600;
  box-shadow: 0 2px 10px rgba(240,185,123,0.30);
}

/* 分红金额柱状图 每次/每年/每股 分段切换：胶囊分组与图表控件统一 */
.dy-toggle { display: inline-flex; gap: 2px; align-items: center; padding: 3px; margin-bottom: 10px; background: rgba(255,255,255,0.035); border: 1px solid rgba(255,255,255,0.05); border-radius: 999px; flex-wrap: wrap; }

.chart-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 24px;
  margin-bottom: 18px;
}

/* Signal grid */
.signal-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.signal-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
}

.signal-item .sig-label { font-size: 13px; color: var(--text-secondary); }
.signal-item .sig-value { font-size: 13px; font-weight: 600; }
.sig-value.positive { color: var(--red); }
.sig-value.negative { color: var(--green); }
.sig-value.neutral { color: var(--text-secondary); }

/* ========================================================= */
/* 价格行为趋势推演（Price Action 框架，技术面页） */
/* ========================================================= */
.pa-subtitle { font-size: 12px; color: var(--text-light); font-weight: 400; margin-left: 8px; }
.pa-meta { font-size: 11px; color: var(--text-light); margin-bottom: 12px; font-variant-numeric: tabular-nums; }

.pa-summary { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.pa-sum-chip {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; border-radius: var(--radius-sm);
  background: var(--bg-hover); border: 1px solid var(--border);
  font-variant-numeric: tabular-nums;
}
.psc-label { font-size: 11px; color: var(--text-light); }
.psc-value { font-size: 13px; font-weight: 600; }
.psc-value.up { color: var(--red); }
.psc-value.down { color: var(--green); }
.psc-value.neutral { color: var(--text-secondary); } /* [20261109b] 主导力量「长期/短期」是中性标签，不是利好/利空 */
.psc-value.side { color: var(--gold, #F0B90B); }

.pa-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.pa-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.5);
  min-width: 0;
}
.pa-card h4 {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 0 0 12px; font-size: 13px; font-weight: 600; color: var(--text-primary);
}
.pa-verdict {
  padding: 2px 10px; border-radius: var(--radius-sm);
  font-size: 12px; font-weight: 700; font-variant-numeric: tabular-nums;
  border: 1px solid var(--border);
}
.pa-verdict.up { color: var(--red); background: var(--red-light); }
.pa-verdict.down { color: var(--green); background: var(--green-light); }
.pa-verdict.side { color: #F0B90B; background: rgba(240, 185, 11, 0.10); }

.pa-evidence { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
.pa-evidence li {
  position: relative; padding-left: 14px;
  font-size: 12px; line-height: 1.65; color: var(--text-secondary);
}
.pa-evidence li::before {
  content: ''; position: absolute; left: 0; top: 8px;
  width: 5px; height: 5px; border-radius: 50%; background: var(--text-light);
}

.pa-zone-title { font-size: 12px; font-weight: 600; margin: 12px 0 6px; }
.pa-zone-title.resistance { color: var(--green); }
.pa-zone-title.support { color: var(--red); }
.pa-zone-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; margin-bottom: 4px;
  border-radius: var(--radius-sm); font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
/* 20261022g：紧凑清单——强度徽标 / 区间 / 来源摘要（超出省略，点开看全文）/ 展开箭头 */
.pa-zone-row:hover { filter: brightness(1.14); }
.pa-zone-row:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.pa-zone-row .pz-badge {
  flex: none; padding: 0 5px; border-radius: 3px;
  font-size: 10px; line-height: 15px; font-weight: 700;
  border: 1px solid var(--border); color: var(--text-muted);
}
.pa-zone-row .pz-badge.strong {
  color: var(--accent); border-color: rgba(240, 185, 123, 0.6);
  background: rgba(240, 185, 123, 0.14);
}
.pa-zone-row .pz-badge.mid { color: var(--text-primary); border-color: rgba(255, 255, 255, 0.22); }
.pa-zone-row .pz-badge.weak { color: var(--text-muted); border-color: rgba(255, 255, 255, 0.12); }
.pa-zone-row .pz-badge.none { color: var(--text-muted); border-style: dashed; opacity: .7; }
/* 特殊条目（箱体边界/手动/反转）不参与强度评分 → 徽标只标语义，不用强弱色 */
.pa-zone-row .pz-badge.special { color: var(--text-light); border-color: rgba(255, 255, 255, 0.16); border-style: dashed; }
.pa-zone-row .pz-caret {
  flex: none; width: 12px; text-align: center;
  color: var(--text-muted); font-size: 10px;
  transition: transform .15s ease;
}
.pa-zone-row.open .pz-caret { transform: rotate(180deg); }
.pa-zone-row.resistance { background: var(--green-light); }
.pa-zone-row.support { background: var(--red-light); }
.pa-zone-row .pz-range { font-weight: 600; color: var(--text-primary); flex: none; }
.pa-zone-row .pz-src {
  flex: 1 1 auto; min-width: 0; text-align: right;
  color: var(--text-light); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 侵蚀标记（20261020m）：区间近端被无放量侵入收紧过 → 价格侧已「长回去」的部分不计入，
   右侧小标签提示，完整「原区间 → 收紧后」在 title 里。 */
.pa-zone-row .pz-erode {
  margin-left: 6px; padding: 0 4px; border-radius: 3px;
  font-size: 10px; color: var(--accent);
  border: 1px solid var(--accent); opacity: .85;
}

/* 反转区间（20261022b）：放量有效突破后角色互换（支撑↔阻力），可多次反转。
   青色虚线左边框 + 「反转×N」标签，与「手动」蓝紫、「已收紧」金色区分开。 */
.pa-zone-row.reversed { border-left: 2px dashed #12b5b0; padding-left: 8px; }
.pa-zone-row .pz-rev {
  margin-left: 6px; padding: 0 4px; border-radius: 3px;
  font-size: 10px; color: #0f9b96;
  border: 1px solid #12b5b0; opacity: .9;
}

/* 箱体边界条目（20261020k）：金色虚线左边框 = 结构性边界（与摆动点聚类的区间区分开） */
.pa-zone-row.box-edge { border-left: 2px dashed var(--accent); padding-left: 8px; }
.pa-zone-row.box-edge .pz-range { font-weight: 600; }
.pa-zone-row.box-edge .pz-src { color: var(--accent); }
.pa-zone-row .pz-box {
  margin-left: 6px; padding: 0 4px; border-radius: 3px;
  font-size: 10px; color: var(--accent);
  border: 1px solid rgba(240, 185, 123, 0.5);
}

/* ②卡共振带统计条（20261022g；20261022h 移除排序切换——清单固定按价格高低排列）。
   统计条只描述「怎么算出来的」，不参与任何判定。 */
.pa-zone-bar {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px;
  margin: 10px 0 2px; padding: 5px 10px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: var(--radius-sm);
  font-size: 11px; color: var(--text-light);
  font-variant-numeric: tabular-nums;
}
.pa-zone-bar-meta { flex: 1 1 auto; min-width: 0; }
.pa-zone-bar-skip {
  flex: 1 1 100%; color: var(--text-muted); font-size: 10.5px; line-height: 1.5;
}
.pa-zone-title .pa-zone-count {
  margin-left: 5px; font-size: 11px; font-weight: 500; color: var(--text-muted);
}

/* 共振带展开详情（20261022g）：点开才显示——来源明细 / 确认信号 / 失效位 / 侵蚀。
   左边框继承方向语义：阻力绿、支撑红（红涨绿跌：支撑看涨=红、阻力看跌=绿），与紧凑行保持一致。 */
.pa-zone-detail {
  margin: -2px 0 8px; padding: 8px 10px 9px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  border-left: 2px solid var(--border);
  font-size: 11.5px; line-height: 1.62; color: var(--text-light);
  font-variant-numeric: tabular-nums;
}
.pa-zone-detail.hidden { display: none; }
.pa-zone-detail.resistance { border-left-color: rgba(14, 203, 129, 0.45); }
.pa-zone-detail.support { border-left-color: rgba(246, 70, 93, 0.45); }
.pzd-grid { display: flex; flex-wrap: wrap; gap: 3px 14px; }
.pzd-grid b { color: var(--text-primary); font-weight: 600; }
.pzd-sec { margin-top: 6px; }
.pzd-label {
  display: inline-block; margin-right: 6px;
  color: var(--text-muted); font-size: 10.5px; letter-spacing: .03em;
}
.pzd-list { margin: 2px 0 0; padding: 0; list-style: none; }
.pzd-list li { position: relative; padding-left: 10px; }
.pzd-list li::before { content: '·'; position: absolute; left: 2px; color: var(--text-muted); }
.pzd-tier {
  margin-left: 6px; padding: 0 4px; border-radius: 3px;
  font-size: 10px; color: var(--text-muted);
  border: 1px solid var(--border);
}
.pzd-tier.major { color: var(--accent); border-color: rgba(240, 185, 123, 0.45); }
.pzd-num { margin-left: 6px; color: var(--text-primary); }
.pzd-weak { margin-left: 6px; font-size: 10px; color: var(--text-muted); font-style: italic; }
.pzd-note { display: block; padding-left: 2px; font-size: 10.5px; color: var(--text-muted); }
.pzd-text { margin: 2px 0 0; }
.pzd-text b { color: var(--text-primary); font-weight: 600; }
.pzd-dim { color: var(--text-muted); font-size: 10.5px; }
.pzd-warn { color: #F0B90B; }
.pzd-inv { color: var(--text-primary); font-weight: 700; }
.pzd-note-line { margin-top: 6px; }

/* ②卡页签（20261021d）：模型判定 / 手动添加。页签只是分区，不改变任何口径。 */
.pa-tabs {
  display: flex; gap: 4px; margin: 2px 0 10px;
  border-bottom: 1px solid var(--border);
}
.pa-tab {
  position: relative; padding: 6px 12px 7px; margin-bottom: -1px;
  background: transparent; border: none; border-bottom: 2px solid transparent;
  color: var(--text-muted); font-size: 12.5px; font-weight: 600; cursor: pointer;
  transition: color .15s ease, border-color .15s ease;
}
.pa-tab:hover { color: var(--text-primary); }
.pa-tab.active { color: var(--accent); border-bottom-color: var(--accent); }
.pa-tab-badge {
  display: inline-block; margin-left: 5px; padding: 0 5px;
  font-size: 10px; line-height: 14px; border-radius: 999px;
  color: var(--accent); background: var(--accent-light);
  border: 1px solid rgba(240, 185, 123, 0.35);
}
.pa-tab-body.hidden { display: none; }

/* 手动区间：整块与模型口径视觉隔离（蓝紫左边框），并自带口径声明 */
.pa-mz-tip {
  font-size: 11.5px; color: var(--text-light); line-height: 1.55;
  background: var(--bg-elevated); border-radius: var(--radius-sm);
  padding: 7px 10px; margin-bottom: 10px;
}
.pa-mz-tip b { color: var(--accent); font-weight: 600; }
.pa-mz-form { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pa-mz-input {
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm);
  color: var(--text-primary); font-size: 12px; padding: 5px 8px; outline: none;
}
.pa-mz-input:focus { border-color: var(--accent); }
.pa-mz-input[type="number"] { width: 92px; font-variant-numeric: tabular-nums; }
.pa-mz-side { min-width: 108px; }
.pa-mz-note { flex: 1 1 140px; min-width: 120px; }
.pa-mz-sep { color: var(--text-muted); font-size: 12px; }
.pa-mz-add {
  padding: 5px 14px; border-radius: var(--radius-sm); cursor: pointer;
  background: var(--accent-light); border: 1px solid rgba(240, 185, 123, 0.45);
  color: var(--accent); font-size: 12px; font-weight: 600;
}
.pa-mz-add:hover { background: rgba(240, 185, 123, 0.22); }
.pa-mz-add:disabled { opacity: .55; cursor: default; }
.pa-mz-err { min-height: 16px; margin: 6px 0 2px; font-size: 11.5px; color: var(--accent); }
.pa-mz-empty { font-size: 12px; color: var(--text-muted); padding: 10px 2px; }
.pa-mz-group { margin-top: 8px; }
.pa-mz-group-title { font-size: 12px; font-weight: 700; margin-bottom: 5px; }
.pa-mz-group.resistance .pa-mz-group-title { color: var(--green); }
.pa-mz-group.support .pa-mz-group-title { color: var(--red); }
.pa-mz-count { margin-left: 5px; font-size: 11px; color: var(--text-muted); font-weight: 500; }
.pa-mz-row {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; margin-bottom: 4px; font-size: 12px;
  background: var(--bg-elevated); border-radius: var(--radius-sm);
  border-left: 2px solid rgba(139, 148, 255, 0.55);
}
.pa-mz-row .pa-mz-range { font-weight: 600; font-variant-numeric: tabular-nums; color: var(--text-primary); }
.pa-mz-row .pa-mz-note-text {
  flex: 1; color: var(--text-light); font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.pa-mz-del {
  padding: 2px 8px; font-size: 11px; cursor: pointer;
  background: transparent; color: var(--text-muted);
  border: 1px solid var(--border); border-radius: 3px;
}
.pa-mz-del:hover { color: var(--accent); border-color: rgba(240,185,123,0.5); }
/* 检验结果徽标（20261021e）：手动区间与模型区间同一条有效性检验，通过/未通过都要看得见 */
.pa-mz-badge {
  padding: 1px 6px; border-radius: 3px; font-size: 10px; line-height: 15px;
  border: 1px solid var(--border); color: var(--text-muted); white-space: nowrap;
}
.pa-mz-badge.ok{ color: var(--text-secondary); border-color: rgba(139,148,158,0.45); background: rgba(139,148,158,0.08); }
.pa-mz-badge.invalid{ color: var(--accent); border-color: rgba(240,185,123,0.45); background: rgba(240,185,123,0.10); cursor: help; }
.pa-mz-badge.unknown { color: var(--text-muted); }
/* 20261103h：「已反转」徽标——手动区间被放量有效突破后转为对侧区间，属正常状态流转（非错误），
   用强调琥珀色与 通过(绿)/未通过(红)/未检验(灰) 区分 */
.pa-mz-badge.reversed { color: #F0B97B; border-color: rgba(240, 185, 123, 0.5); background: rgba(240, 185, 123, 0.12); cursor: help; }
.pa-mz-row.reversed .pa-mz-range { opacity: .75; }
.pa-mz-row.invalid { opacity: .82; }
.pa-mz-row.invalid .pa-mz-range{ text-decoration: line-through; text-decoration-color: rgba(240,185,123,0.6); }
/* 混在模型清单里的手动条目：蓝紫虚线左边框 + 「手动」小标 */
.pa-zone-row.manual { border-left: 2px dashed rgba(139, 148, 255, 0.75); padding-left: 8px; }
.pa-zone-row .pz-manual {
  margin-left: 6px; padding: 0 4px; border-radius: 3px;
  font-size: 10px; color: rgba(160, 168, 255, 0.95);
  border: 1px solid rgba(139, 148, 255, 0.5);
}
/* 单箱体精简一行（20261020j）：一行读完「起始日 / 持续天数 / 失效线 / 是否触发失效」。
   上沿=阻力侧用绿、下沿=支撑侧用红（红涨绿跌：支撑看涨=红、阻力看跌=绿），与下方区间行同色语义。 */
.pa-box-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px;
  padding: 7px 10px; margin: 10px 0 4px;
  background: var(--accent-light);
  border-left: 2px solid var(--accent);
  border-radius: var(--radius-sm);
  font-size: 12px; font-variant-numeric: tabular-nums;
  color: var(--text-primary);
}
.pa-box-row .pb-tag { font-size: 11px; font-weight: 700; color: var(--accent); letter-spacing: .04em; }
.pa-box-row .pb-kv { color: var(--text-light); }
.pa-box-row .pb-kv b { color: var(--text-primary); font-weight: 600; }
.pa-box-row .pb-kv b.up { color: var(--red); }
.pa-box-row .pb-kv b.down { color: var(--green); }
.pa-box-row .pb-kv.sub { font-size: 11px; }
.pa-box-row .pb-risk { margin-left: auto; font-size: 11px; color: var(--text-light); }
.pa-box-row .pb-risk.warn { color: #F0B90B; font-weight: 600; }
.pa-box-row.none { background: rgba(255, 255, 255, 0.02); border-left-color: var(--text-light); }
.pa-box-row .pb-empty { font-size: 11px; color: var(--text-light); line-height: 1.5; }

.pa-scenario {
  font-size: 15px; font-weight: 700; color: #F0B90B;
  padding: 8px 12px; border-radius: var(--radius-sm);
  background: rgba(240, 185, 11, 0.08); margin-bottom: 8px;
}
.pa-scenario-text { font-size: 12px; line-height: 1.7; color: var(--text-secondary); margin: 0 0 12px; }
.pa-dom-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px; border-radius: var(--radius-sm); background: var(--bg-hover);
}
.pa-dom-row .pd-label { font-size: 12px; color: var(--text-secondary); }
.pa-dom-row .pd-value { font-size: 12px; font-weight: 600; color: var(--text-primary); }

.pa-edges { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
.pa-edges li {
  display: flex; flex-direction: column; gap: 3px;
  padding: 8px 10px; border-radius: var(--radius-sm);
  background: var(--bg-hover); border-left: 2px solid #F0B90B;
}
.pa-edges .pe-cond { font-size: 12px; color: var(--text-primary); line-height: 1.55; font-variant-numeric: tabular-nums; }
.pa-edges .pe-effect { font-size: 11px; color: var(--text-light); line-height: 1.5; }

.pa-loading { display: flex; flex-direction: column; gap: 8px; }
.pa-error {
  display: flex; align-items: center; gap: 8px;
  padding: 16px; border-radius: var(--radius-sm);
  background: var(--bg-hover); color: var(--text-secondary); font-size: 12px;
}
.pa-error .pe-icon { font-size: 16px; }

@media (max-width: 880px) {
  .pa-grid { grid-template-columns: 1fr; }
}

/* Score breakdown */
.score-breakdown { display: flex; flex-direction: column; gap: 16px; }

.score-bar-item { display: flex; flex-direction: column; gap: 6px; }

.score-bar-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.score-bar-label { font-size: 14px; font-weight: 500; }
.score-bar-value { font-size: 14px; font-weight: 600; }

.score-bar-track {
  height: 10px;
  background: var(--bg-primary);
  border-radius: 5px;
  overflow: hidden;
}

.score-bar-fill {
  height: 100%;
  border-radius: 5px;
  transition: width 0.6s ease;
}

/* Metrics table */
.metrics-table { display: flex; flex-direction: column; gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }

.metric-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding: 13px 16px;
  background: var(--bg-card);
}

.metric-row .mr-label { color: var(--text-secondary); font-size: 13px; }
.metric-row .mr-value { font-weight: 600; font-size: 13px; text-align: right; white-space: nowrap; }
.metric-row .mr-extra { font-size: 11px; color: var(--text-dim); font-weight: 400; margin-top: 3px; opacity: 0.9; }
.metric-row .mr-period { display: inline-block; font-size: 10px; padding: 0 5px; margin-right: 4px; border-radius: 5px; background: rgba(120,140,160,0.18); color: var(--text-secondary); vertical-align: middle; }
.metrics-period-note { font-size: 11px; line-height: 1.5; color: var(--text-secondary); padding: 7px 10px; background: rgba(120,140,160,0.10); border-bottom: 1px solid var(--border); }

/* ROE 与毛利率走势文字解读 */
.roe-margin-text { padding: 8px 12px 10px; line-height: 1.7; }
.roe-margin-text .roe-margin-concl { margin: 0 0 6px; font-size: 13px; color: var(--text-primary); font-weight: 600; }
.roe-margin-text .roe-margin-reason { margin: 0; padding-left: 18px; }
.roe-margin-text .roe-margin-reason li { font-size: 12px; color: var(--text-secondary); margin: 3px 0; }
.roe-margin-text .roe-margin-reason li::marker { color: var(--accent); }

/* 利好(红)/利空(绿) 指标行着色 */
.metric-row.sig-bull { box-shadow: inset 3px 0 0 var(--red); background: rgba(246,70,93,0.12); }
.metric-row.sig-bull .mr-value { color: var(--red); font-weight: 700; }
.metric-row.sig-bear { box-shadow: inset 3px 0 0 var(--green); background: rgba(14,203,129,0.12); }
.metric-row.sig-bear .mr-value { color: var(--green); font-weight: 700; }
.mr-tag { font-size: 11px; margin-left: 6px; padding: 1px 6px; border-radius: 6px; vertical-align: middle; }
.mr-tag.bull { background: var(--tint-red); color: var(--red); }
.mr-tag.bear { background: var(--tint-green); color: var(--green); }
.mr-tag.neutral { background: rgba(160,160,160,0.16); color: var(--text-secondary); }

/* ★ 20261013i：指标行「分析」跳转 tab —— 点击平滑定位右卡「指标分析」同键卡片并闪烁高亮。
   中性金色（accent），避开红/绿涨跌语义；margin-left:auto 保证加 tab 后数值仍紧贴右侧。 */
.metric-row .mr-value { margin-left: auto; }
.metric-jump {
  flex: 0 0 auto; align-self: flex-start;
  display: inline-flex; align-items: center; gap: 3px;
  margin-top: 1px; padding: 3px 9px;
  font-size: 11px; font-weight: 600; line-height: 1.4;
  color: var(--accent); background: rgba(240,185,123,0.10);
  border: 1px solid rgba(240,185,123,0.35); border-radius: 6px;
  cursor: pointer; white-space: nowrap;
  transition: background 0.15s ease, transform 0.15s ease;
}
.metric-jump:hover { background: rgba(240,185,123,0.22); }
.metric-jump:active { transform: scale(0.95); }
.metric-jump-arrow { font-size: 9px; opacity: 0.85; }
.ma-row.ma-flash { animation: maFlash 1.8s ease; }
@keyframes maFlash {
  0% { box-shadow: 0 0 0 0 rgba(240,185,123,0); border-color: var(--border-light); }
  20% { box-shadow: 0 0 0 2px rgba(240,185,123,0.75); border-color: var(--accent); }
  100% { box-shadow: 0 0 0 0 rgba(240,185,123,0); border-color: var(--border-light); }
}
/* ★ 20261013j：右卡按需单卡展示——非当前查看项一律隐藏；空态引导点击左卡「分析 ▸」 */
.ma-row.ma-hidden { display: none; }
.ma-empty { font-size: 12.5px; line-height: 1.7; color: var(--text-secondary); text-align: center; padding: 30px 16px; border: 1px dashed var(--border-light); border-radius: 10px; background: rgba(255,255,255,0.02); }
.ma-empty.hidden { display: none; }
/* ★ 20261104m：指标分析行内展开面板（手风琴）——展开在所点指标行正下方，与指标行同一水平；
   面板内 .ma-row 克隆自右卡（同一结构），去自身边框由面板容器承载视觉；
   .metrics-table 为 flex column + overflow hidden，面板融入列表用上下边线而非外边距 */
.ma-inline-panel { background: var(--card-bg); border-top: 1px solid var(--border-light); border-bottom: 1px solid var(--border-light); padding: 4px 6px; }
.ma-inline-panel .ma-row { margin: 0; border: none; background: transparent; }
.ma-inline-panel.ma-flash { animation: maFlash 1.8s ease; }
/* 左卡 tab 激活态：当前右卡正在展示的指标（中性金色加亮，避开红绿涨跌语义） */
.metric-jump.active { background: rgba(240,185,123,0.28); border-color: var(--accent); }

/* 信号提醒卡片 */
.sig-note { font-size: 12px; color: var(--text-secondary); margin: 4px 0 10px; }
.sig-list { display: flex; flex-direction: column; gap: 8px; }
.sig-item { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--bg-elevated); }
.sig-item.sig-bull { border-left: 4px solid var(--red); background: rgba(246,70,93,0.12); }
.sig-item.sig-bear { border-left: 4px solid var(--green); background: rgba(14,203,129,0.12); }
.sig-item.sig-neutral { border-left: 4px solid var(--text-secondary); }
.sig-head { display: flex; align-items: center; gap: 10px; }
.sig-label { font-weight: 600; font-size: 13px; }
.sig-value { font-variant-numeric: tabular-nums; font-size: 13px; color: var(--text-primary); }
.sig-tag { margin-left: auto; font-size: 12px; padding: 1px 8px; border-radius: 6px; }
.sig-bull .sig-tag { background: var(--tint-red); color: var(--red); }
.sig-bear .sig-tag { background: var(--tint-green); color: var(--green); }
.sig-reason { font-size: 12px; color: var(--text-secondary); margin-top: 5px; line-height: 1.5; }
.signal-grid-meta { font-size: 11px; color: var(--text-light); margin-bottom: 8px; }
.sig-meta { font-size: 11px; color: var(--text-light); margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border-light); }

/* 指标释义「?」图标 + 浮层 */
.metric-help {
  display: inline-flex; align-items: center; justify-content: center;
  width: 14px; height: 14px; margin-left: 5px;
  font-size: 10px; font-weight: 700; line-height: 1;
  border-radius: 50%; background: var(--accent); color: #0B0E11;
  cursor: pointer; vertical-align: super; user-select: none;
  box-shadow: 0 0 0 2px var(--bg-elevated);
}
.metric-help:hover { filter: brightness(1.15); }
.metric-help-pop {
  display: none; position: absolute; z-index: 9999;
  max-width: 320px; min-width: 220px;
  background: var(--bg-elevated); border: 1px solid var(--accent);
  border-radius: 10px; padding: 12px 14px;
  box-shadow: 0 8px 28px rgba(0,0,0,0.45);
  font-size: 12.5px; line-height: 1.65; color: var(--text-primary);
}
.metric-help-pop.show { display: block; }
.metric-help-pop .mhp-title { font-weight: 700; font-size: 13.5px; color: var(--accent); margin-bottom: 6px; }
.metric-help-pop .mhp-body { color: var(--text-secondary); }
.metric-help-pop .mhp-body b, .metric-help-pop .mhp-body u { color: var(--text-primary); }


/* 20261016：已删除死 CSS .analyst-rating / .rating-circle（public/ 内零引用，20260919a 起由 .metric-analysis 替代） */

/* 指标分析（20260919a，替代原分析师评级） */
.metric-analysis { padding: 4px 2px; }
.ma-note { font-size: 11px; color: var(--text-secondary); line-height: 1.5; padding: 6px 9px; margin-bottom: 10px; background: rgba(240,185,123,0.08); border: 1px solid rgba(240,185,123,0.28); border-radius: 8px; }
.ma-row { border: 1px solid var(--border-light); border-radius: 10px; padding: 9px 11px; margin-bottom: 9px; background: var(--card-bg); }
.ma-row-head { display: flex; align-items: center; gap: 8px; }
.ma-row-label { font-size: 13px; font-weight: 600; color: var(--text-primary); flex: 1; }
.ma-row-value { font-size: 14px; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
.ma-badge { font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 10px; white-space: nowrap; }
.ma-bull { color: var(--red); background: var(--tint-red); border: 1px solid rgba(246,70,93,0.5); }
.ma-bear { color: var(--green); background: var(--tint-green); border: 1px solid rgba(14,203,129,0.5); }
.ma-neutral { color: var(--text-secondary); background: rgba(140,160,180,0.16); border: 1px solid rgba(140,160,180,0.4); }
.ma-dims { display: grid; grid-template-columns: 1fr 1fr; gap: 5px 10px; margin: 8px 0 6px; }
.ma-dim { border-radius: 7px; padding: 5px 8px; background: rgba(255,255,255,0.03); border-left: 3px solid var(--border-light); }
.ma-dim-label { display: block; font-size: 10px; color: var(--text-secondary); font-weight: 600; margin-bottom: 2px; }
.ma-dim-text { display: block; font-size: 11px; color: var(--text-primary); line-height: 1.4; }
.ma-dim-bull { border-left-color: var(--red); }
.ma-dim-bull .ma-dim-text { color: var(--red); }
.ma-dim-bear { border-left-color: var(--green); }
.ma-dim-bear .ma-dim-text { color: var(--green); }
.ma-dim-neutral { border-left-color: rgba(140,160,180,0.6); }
.ma-dim-na { border-left-color: var(--border-light); opacity: 0.7; }
.ma-reason { font-size: 11.5px; color: var(--text-secondary); line-height: 1.5; padding-top: 6px; border-top: 1px dashed var(--border-light); }
.ma-reason::before { content: '判定依据：'; color: var(--accent); font-weight: 600; }
/* 20261029a：指标级口径说明（营运利润 vs 扣非净利润、NBV 释义等），黄字=重点信息，语义着色统一规范 */
.ma-metric-note { font-size: 11px; color: #F0B97B; line-height: 1.55; margin-top: 6px; padding: 6px 8px; background: rgba(240, 185, 123, 0.07); border-left: 2px solid rgba(240, 185, 123, 0.45); border-radius: 0 4px 4px 0; }

/* Sentiment gauge */
.sentiment-gauge {
  width: 100%;
  height: 150px;
  position: relative;
  margin-bottom: 12px;
}

.sentiment-dist {
  display: flex;
  height: 8px;
  border-radius: 4px;
  overflow: hidden;
  margin-bottom: 16px;
}

.sentiment-dist .sd-pos { background: var(--red); }
.sentiment-dist .sd-neu { background: var(--text-light); }
.sentiment-dist .sd-neg { background: var(--green); }

.sentiment-legend {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 16px;
}

/* News list */
.news-list { display: flex; flex-direction: column; gap: 12px; }

.news-item {
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: box-shadow 0.2s;
}
.news-item:hover { box-shadow: var(--shadow-lg); }

.news-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 6px; }

.news-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  text-decoration: none;
  flex: 1;
}
.news-title:hover { color: var(--accent); }

.news-sentiment-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
}
.news-sentiment-tag.positive { background: var(--red-light); color: var(--red); }
.news-sentiment-tag.negative { background: var(--green-light); color: var(--green); }
.news-sentiment-tag.neutral { background: var(--bg-hover); color: var(--text-secondary); }

.news-meta { font-size: 12px; color: var(--text-light); display: flex; gap: 12px; }
.news-summary { font-size: 13px; color: var(--text-secondary); margin-top: 6px; }

/* Volume analysis */
.vol-analysis { display: flex; flex-direction: column; gap: 10px; }

.vol-item {
  display: flex;
  justify-content: space-between;
  padding: 8px 12px;
  background: var(--bg-hover);
  border-radius: var(--radius-sm);
}
.vol-item .vl-label { font-size: 13px; color: var(--text-secondary); }
.vol-item .vl-value { font-size: 13px; font-weight: 600; }
.vol-meta { font-size: 11px; color: var(--text-light); margin-bottom: 6px; }

/* Toast */
.toast {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translate(-50%, 12px);
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg-sidebar);
  color: var(--text-primary);
  padding: 12px 20px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255,255,255,0.12);
  font-size: 14px;
  z-index: 1000;
  box-shadow: var(--shadow-lg);
  opacity: 0;
  pointer-events: none;
  transition: opacity .25s ease, transform .25s ease;
}
.toast.show { opacity: 1; pointer-events: auto; transform: translate(-50%, 0); }
.toast-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; border-radius: 50%;
  font-size: 13px; font-weight: 700; flex-shrink: 0;
}
.toast.success .toast-icon { background: rgba(255,255,255,0.05); color: var(--text-secondary); }
.toast.error .toast-icon { background: var(--accent-light); color: var(--accent); }
.toast.info .toast-icon { background: rgba(240,185,123,0.16); color: var(--accent); }
.toast.loading .toast-icon { background: rgba(240,185,123,0.16); color: var(--accent); animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.toast.success { border-left: 3px solid var(--text-secondary); }
.toast.error { border-left: 3px solid var(--accent); }
.toast.info { border-left: 3px solid var(--accent); }
.toast.loading { border-left: 3px solid var(--accent); }

/* Scrollbar */
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(120,130,145,0.22); border-radius: 4px; }
::-webkit-scrollbar-thumb:hover { background: rgba(120,130,145,0.38); }

.sidebar::-webkit-scrollbar-thumb { background: rgba(160,175,195,0.18); }

/* Responsive */
@media (max-width: 1500px) {
  .scores-row { grid-template-columns: repeat(2, 1fr); }
}
@media (max-width: 1200px) {
  .chart-grid { grid-template-columns: 1fr; }
  .scores-row { grid-template-columns: 1fr; }
}

/* ===== Deep Analysis Styles ===== */
.deep-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 80px 20px;
  gap: 16px;
}
/* 关键修复：deep-loading 默认 display:flex，必须有 .hidden 规则才能真正隐藏（深度分析/资金量能的加载态） */
.deep-loading.hidden { display: none; }

.deep-loading p {
  color: var(--text-secondary);
  font-size: 14px;
}

.deep-content {
  transition: opacity 0.3s;
}

/* 深度分析缓存状态条 */
.deep-cache-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  margin-bottom: 16px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: 13px;
}

.deep-cache-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.deep-cache-status.cached {
  color: var(--teal);
}

.deep-cache-status.fresh {
  color: var(--accent);
}

.deep-refresh-btn {
  flex-shrink: 0;
  width: auto;
  min-width: 0;
  height: 30px;
  padding: 0 14px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  cursor: pointer;
  white-space: nowrap;
}
.deep-refresh-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-light);
}

.audit-warning {
  background: rgba(224,180,92,0.14);
  border: 1px solid var(--amber);
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
  color: var(--amber-text);
  font-weight: 600;
  font-size: 14px;
}

.audit-warning.hidden { display: none; }

.deep-loading .loading-spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* DCF Result */
.dcf-result {
  padding: 10px 0;
}

.dcf-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}

.dcf-item {
  background: var(--bg-primary);
  border-radius: 8px;
  padding: 14px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border: 1px solid var(--border);
}

.dcf-item.highlight {
  background: rgba(240,185,123,0.12);
  border-color: var(--accent);
}

.dcf-item.overvalued {
  background: var(--green-light);
  border-color: var(--green);
}

.dcf-item.undervalued {
  background: var(--red-light);
  border-color: var(--red);
}

.dcf-item.fair {
  background: var(--amber-bg);
  border-color: var(--orange);
}

.dcf-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.dcf-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.dcf-error {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
  font-size: 14px;
}

.dcf-note {
  background: var(--bg-primary);
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}

.dcf-note p { margin: 0; }

/* ===== Valuation Conclusion Panel ===== */
.conclusion-panel {
  margin-bottom: 16px;
}

/* ===== 20260905j：估值结论面板合并 AI 估值（valuation-merged） ===== */
/* 规则版解读与 AI 结果同容器切换（JS 控制 display）；按钮行置顶（date 左 / 按钮右），字体颜色沿用面板既有变量 */
.valuation-merged { margin-bottom: 16px; }
.valuation-merged .valuation-ai-head { margin: 0 0 10px; }

/* ===== 估值结论卡片（20260902i 重设计：中性炭黑卡面 + 语义色徽章 + 估值区间定位条）===== */
/* 语义方向：利好红/利空绿只出现在评级徽章与价格锚点上，卡面不再大面积着色 */
.vc-card {
  background: var(--bg-card);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.vc-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.vc-rating-wrap { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.vc-rating-label { font-size: 12px; color: var(--text-secondary); letter-spacing: 0.02em; }
.vc-rating-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 4px 14px;
  border: 1px solid;
  border-radius: 6px;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.3;
}
.vc-rating-chip i { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.vc-price { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.vc-price-label { font-size: 12px; color: var(--text-secondary); }
.vc-price-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  line-height: 1.15;
}
.vc-duel { display: inline-flex; align-items: baseline; gap: 8px; font-size: 20px; }
.vc-duel b { font-weight: 700; font-variant-numeric: tabular-nums; }
.vc-duel em { font-style: normal; font-size: 12px; color: var(--text-secondary); }

/* ---- 估值区间定位条：金色填充=已覆盖区间，圆点=当前价（描边为评级语义色），竖线=中枢 ---- */
.vc-range { display: flex; flex-direction: column; gap: 6px; }
.vc-range-head { display: flex; justify-content: space-between; align-items: baseline; font-size: 12px; flex-wrap: wrap; gap: 4px 12px; }
.vc-range-label { color: var(--text-secondary); }
.vc-range-note { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.vc-range-track { position: relative; height: 6px; border-radius: 3px; background: rgba(255,255,255,0.07); margin-top: 20px; }
.vc-range-fill {
  position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px;
  background: linear-gradient(90deg, rgba(224,180,92,0.18), rgba(224,180,92,0.42));
}
/* 20260906：中枢竖线上下贯穿突出于刻度条，标注文字挂竖线上方（用户要求，全部个股生效） */
.vc-range-center {
  position: absolute; top: -9px; width: 2px; height: 24px; border-radius: 1px;
  background: #e0b45c; transform: translateX(-1px);
}
.vc-range-center-label {
  position: absolute; bottom: calc(100% + 4px); left: 50%; transform: translateX(-50%);
  font-size: 11px; line-height: 1; color: #e0b45c; white-space: nowrap;
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 4px rgba(0,0,0,0.5);
}
.vc-range-dot {
  position: absolute; top: 50%; width: 14px; height: 14px; border-radius: 50%;
  background: #fff; border: 3px solid;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 0 3px rgba(255,255,255,0.06);
}
.vc-range-scale {
  display: flex; justify-content: space-between;
  font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums;
}

/* ---- 估值方法 chips ---- */
.vc-methods { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.vc-methods-label { font-size: 12px; color: var(--text-secondary); flex: none; }
.vc-methods-list { display: flex; flex-wrap: wrap; gap: 6px; }
.vc-method-chip {
  font-size: 12px; padding: 3px 10px; border-radius: 4px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.10);
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.conclusion-text {
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 16px 20px;
  margin-top: 12px;
  font-size: 14px;
  line-height: 1.8;
}

.conclusion-text p {
  margin: 0 0 6px 0;
}

.conclusion-text p:last-child {
  margin-bottom: 0;
}

/* 20260905r：AI 估值结论文本的语义着色（利好红/利空绿/关键信息黄） */
.ai-text-bullish { color: #F6465D; font-weight: 600; }
.ai-text-bearish { color: #0ECB81; font-weight: 600; }
.ai-text-key { color: #e0b45c; font-weight: 500; }

/* ===== 20260908b：个股专属确定性估值模型渲染（计算过程表，无 AI 参与） ===== */
.vd-card {
  background: var(--bg-card);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 8px;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.vd-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.vd-title { font-size: 15px; font-weight: 700; color: var(--text-primary); }
.vd-badge {
  display: inline-flex; align-items: center; padding: 3px 12px; border-radius: 6px;
  font-size: 14px; font-weight: 700; border: 1px solid; line-height: 1.4;
}
.vd-rating-low { color: #F6465D; border-color: rgba(246,70,93,0.5); background: var(--tint-red); }
.vd-rating-high { color: #0ECB81; border-color: rgba(14,203,129,0.5); background: var(--tint-green); }
.vd-rating-mid { color: #e0b45c; border-color: rgba(224,180,92,0.5); background: rgba(224,180,92,0.10); }
.vd-intervals { display: flex; flex-direction: column; gap: 8px; }
.vd-iv {
  display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
  padding: 8px 12px; background: var(--bg-secondary); border-radius: 6px; font-size: 13px;
}
.vd-iv span { color: var(--text-secondary); }
.vd-iv b { font-size: 16px; color: var(--text-primary); font-variant-numeric: tabular-nums; font-weight: 700; }
.vd-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.vd-table th {
  text-align: left; padding: 8px 12px; color: var(--text-secondary); font-weight: 600;
  border-bottom: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.03);
}
.vd-table td { padding: 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.05); vertical-align: top; }
.vd-label { color: var(--text-primary); }
.vd-value { color: var(--text-primary); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; font-weight: 600; }
.vd-note { font-size: 12px; padding: 8px 12px; border-radius: 6px; }
.vd-warn { color: #e0b45c; background: rgba(224,180,92,0.10); border: 1px solid rgba(224,180,92,0.3); }
.vd-axis-hl { color: #ffcf8a; background: rgba(224,180,92,0.16); border: 1px solid rgba(224,180,92,0.5); border-left: 4px solid #e0b45c; font-weight: 600; }
.vd-axis-anchor { color: var(--text-secondary); background: rgba(120,170,255,0.08); border: 1px solid rgba(120,170,255,0.25); border-left: 4px solid rgba(120,170,255,0.6); }
.vd-foot { font-size: 12px; color: var(--text-secondary); line-height: 1.6; }

/* 20260908g：专属估值模型三段式明细 */
.vd-sec { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px dashed rgba(255,255,255,0.10); }
.vd-sec-title { font-size: 14px; font-weight: 700; color: var(--text-primary); }
.vd-sec-sub { font-size: 12px; color: var(--text-secondary); line-height: 1.6; }
.vd-seg-table th:nth-child(2),
.vd-seg-table th:nth-child(3),
.vd-seg-table th:nth-child(4) { text-align: right; }
.vd-seg-total td { font-weight: 700; background: rgba(255,255,255,0.03); border-top: 1px solid rgba(255,255,255,0.12); }
.vd-formula {
  font-size: 12px; color: #F0B97B; background: rgba(240,185,123,0.08);
  border: 1px solid rgba(240,185,123,0.25); border-radius: 6px; padding: 8px 12px;
  font-variant-numeric: tabular-nums; line-height: 1.6; word-break: break-all;
}
.vd-src-block { display: flex; flex-direction: column; gap: 6px; }
.vd-src-title { font-size: 12px; font-weight: 700; color: var(--text-secondary); }
.vd-src-table td, .vd-src-table th { font-size: 12px; vertical-align: top; }
.vd-src { color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
.vd-src-title + .vd-src-table { margin-top: 2px; }

.conclusion-methods-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.conclusion-method {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--bg-secondary);
  border-radius: 6px;
  font-size: 13px;
}

.conclusion-method .method-name {
  font-weight: 600;
  min-width: 100px;
}

.conclusion-method .method-detail {
  flex: 1;
  color: var(--text-secondary);
}

.conclusion-method .method-fair-row {
  flex-basis: 100%;
  margin-top: 2px;
}

/* 20260902g：合理估值为中性信息，改用品牌金系，避免与利空绿/利好红语义混淆 */
.conclusion-method .method-fair {
  display: inline-block;
  background: rgba(224,180,92,0.10);
  color: #e0b45c;
  border: 1px solid rgba(224,180,92,0.35);
  padding: 2px 10px;
  border-radius: 4px;
  font-weight: 600;
  font-size: 12.5px;
}

/* ===== Trend Prediction Panel ===== */
.trend-prediction-panel {
  margin-bottom: 16px;
}

.trend-reasons {
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 12px 20px;
  margin-top: 12px;
}

.trend-reasons ul {
  margin: 0;
  padding-left: 20px;
}

.trend-reasons li {
  font-size: 13px;
  line-height: 2;
  color: var(--text-primary);
}

.trend-text {
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px 16px;
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.8;
}

.trend-text p {
  margin: 0 0 4px 0;
}

.trend-text p:last-child {
  margin-bottom: 0;
}

/* ===== Insurance Panel ===== */
.insurance-panel { margin-top: 12px; }
.insurance-panel.hidden { display: none; }

/* ===== Investment Journal ===== */
.journal-container { padding: 0 0 20px 0; }

.journal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  padding: 16px 20px;
  background: var(--bg-card);
  border-radius: 10px;
}

.journal-stats {
  display: flex;
  gap: 24px;
}

.journal-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.stat-num {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
}
.stat-num.verified { color: var(--text-secondary); }
.stat-num.partial { color: var(--orange); }
.stat-num.unverified { color: var(--text-secondary); }

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 2px;
}

.btn-journal-add {
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border);
  padding: 7px 14px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
  transition: border-color 0.18s, color 0.18s, background 0.18s;
}
.btn-journal-add:hover { border-color: var(--accent); color: var(--accent); background: var(--bg-hover); }

.journal-filter-bar {
  display: flex;
  gap: 12px;
  align-items: center;
  margin-bottom: 16px;
  padding: 12px 16px;
  background: var(--bg-card);
  border-radius: 8px;
}

.journal-filter-bar select,
.journal-filter-bar input {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 13px;
}

.journal-checkbox {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}

.journal-list { display: flex; flex-direction: column; gap: 12px; }

.journal-empty {
  text-align: center;
  padding: 60px 20px;
  color: var(--text-secondary);
}
.journal-empty p { margin: 4px 0; font-size: 16px; }
.journal-empty-hint { font-size: 13px !important; }

.journal-note {
  background: var(--bg-card);
  border-radius: 10px;
  padding: 16px 20px;
  border: 1px solid var(--border);
}

.note-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}

.note-type {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 12px;
  background: rgba(240,185,123,0.12);
  color: var(--accent);
}

.note-stock {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 12px;
  background: rgba(139,148,158,0.10);
  color: var(--text-secondary);
}

.note-date {
  font-size: 12px;
  color: var(--text-secondary);
  margin-left: auto;
}

.note-title {
  margin: 0 0 8px 0;
  font-size: 15px;
  color: var(--text-primary);
}

.note-content {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.6;
  margin-bottom: 8px;
}

.note-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.note-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text-secondary);
}

.note-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
}

.note-actions { display: flex; gap: 8px; }

/* 20261025b：记录卡动作按钮统一缩小（含 .btn-set-main，此前缺失基础尺寸依赖浏览器默认样式） */
.btn-verify, .btn-edit, .btn-delete, .btn-set-main {
  font-size: 11.5px;
  padding: 3px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  cursor: pointer;
  background: var(--bg-card);
  transition: all 0.2s;
}

.btn-verify { color: var(--accent); border-color: var(--accent); }
.btn-verify:hover { background: var(--accent); color: #0B0E11; }
.btn-verify:disabled { opacity: 0.5; cursor: wait; }

.btn-edit { color: var(--text-secondary); }
.btn-edit:hover { background: var(--bg-primary); }

.btn-delete { color: var(--accent); border-color: rgba(240,185,123,0.4); }
.btn-delete:hover{ background: var(--accent); color: #0B0E11; }

/* 20260904a：把笔记设为该股最大亮点/雷点的按钮（橙色描边，区别于普通动作） */
.btn-set-main { color: #F0B90B; border-color: rgba(240,185,11,0.5); }
.btn-set-main:hover { background: #F0B90B; color: #1a1a1a; }
.btn-set-main.is-main { background: rgba(240,185,11,0.15); color: #F0B90B; border-color: #F0B90B; }
.btn-set-main.is-main:hover { background: #F0B90B; color: #1a1a1a; }

.ver-badge {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 12px;
}
.ver-badge.pending { background: var(--bg-elevated); color: var(--text-secondary); }
.ver-badge.checking { background: rgba(224,180,92,0.14); color: var(--amber-text); }
.ver-badge.verified { background: rgba(255,255,255,0.05); color: var(--text-secondary); }
.ver-badge.partial { background: rgba(224,180,92,0.14); color: var(--amber-text); }
.ver-badge.unverified { background: var(--accent-light); color: var(--accent); }
.ver-badge.error { background: var(--accent-light); color: var(--accent); }

.note-verification-result {
  margin-top: 10px;
  padding: 10px 14px;
  background: var(--bg-hover);
  border-radius: 8px;
  border-left: 3px solid var(--accent);
}

.verification-header {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 4px;
  color: var(--text-primary);
}

.verification-text {
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
}

.verification-details {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 6px;
  white-space: pre-wrap;
}

.verification-time {
  font-size: 11px;
  color: var(--text-secondary);
  margin-top: 4px;
}

/* Journal Modal */
.journal-modal-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

/* 20261025b：弹窗加宽适配页面（600→760px）、加大内边距 */
.journal-modal {
  background: var(--bg-card);
  border-radius: 12px;
  padding: 26px 30px;
  width: 92%;
  max-width: 760px;
  max-height: 90vh;
  overflow-y: auto;
}

.journal-modal h3 {
  margin: 0 0 16px 0;
  font-size: 18px;
}

/* 首页操作栏（笔记入口按钮行，替代原先占中的大卡片） */
.home-actions { display: flex; gap: 14px; justify-content: center; align-items: center; margin: 4px auto 0; max-width: 1100px; padding: 0 20px; }

/* 常驻顶部导航（所有页面显示：投资心得 / 大盘记录 / AI设置 + 个股页操作按钮） */
.global-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  flex-wrap: nowrap;
  margin-bottom: 4px;
  overflow-x: auto;
  scrollbar-width: thin;
}
.global-nav::-webkit-scrollbar { height: 4px; }
.global-nav::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 2px; }
.global-nav-common,
.global-nav-extra {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.global-nav-extra { margin-left: auto; }
.global-nav-extra.hidden { display: none; }
@media (max-width: 880px) {
  .global-nav { justify-content: flex-start; }
  .global-nav-extra { margin-left: 0; }
}
.home-action-btn { background: var(--bg-card); border: 1px solid var(--border); color: var(--text-primary); border-radius: var(--radius-sm); padding: 8px 16px; font-size: 13px; cursor: pointer; transition: border-color .15s, background .15s, transform .1s, color .15s; white-space: nowrap; }
.home-action-btn:hover { border-color: var(--accent); background: var(--bg-hover); transform: translateY(-1px); color: var(--accent); }
.home-action-btn.active { color: var(--accent); border-color: var(--accent); background: var(--accent-light); }

/* 20261003：准确率入口由顶栏移入常驻导航行 .global-nav，与 .home-action-btn 同高并列（保留金色强调色） */
.nav-acc-link { display: inline-flex; align-items: center; gap: 4px; padding: 8px 16px; border-radius: var(--radius-sm); background: var(--accent-light); border: 1px solid rgba(240,185,123,.4); color: var(--accent); font-size: 13px; font-weight: 600; text-decoration: none; white-space: nowrap; flex-shrink: 0; transition: all .18s ease; }
.nav-acc-link:hover { background: rgba(240,185,123,.22); border-color: #F0B97B; transform: translateY(-1px); }

/* 笔记查看弹窗（scope modal） */
.journal-modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
.journal-modal-head h3 { margin: 0; font-size: 18px; }
.modal-close { background: none; border: none; color: var(--text-secondary); font-size: 18px; line-height: 1; cursor: pointer; padding: 4px 6px; border-radius: 6px; transition: background .15s, color .15s; }
.modal-close:hover { background: var(--bg-hover); color: var(--text-primary); }
/* 20261025b：列表弹窗与记录块间距拉开，滚动区留出内边距 */
.scope-modal { max-width: 760px; display: flex; flex-direction: column; }
.scope-modal-body { display: flex; flex-direction: column; gap: 14px; max-height: 64vh; overflow-y: auto; margin-bottom: 16px; padding: 2px 8px 2px 2px; }
.scope-modal-foot { display: flex; justify-content: flex-end; }

.journal-form { display: flex; flex-direction: column; gap: 12px; }

.form-row { display: flex; flex-direction: column; gap: 4px; }
.form-row label { font-size: 13px; color: var(--text-secondary); font-weight: 500; }
.form-row input, .form-row select, .form-row textarea {
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 14px;
  font-family: inherit;
}
.form-row textarea { resize: vertical; }
.form-stock-input { display: flex; gap: 8px; }

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 8px;
}

.btn-cancel, .btn-save {
  padding: 8px 20px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  font-size: 14px;
}
.btn-cancel { background: var(--bg-primary); color: var(--text-secondary); }
.btn-save { background: var(--bg-sidebar); color: white; }

.form-verify-hint {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
  padding: 8px;
  background: var(--bg-hover);
  border-radius: 6px;
}

/* ====== 文档资料库 ====== */
.doc-store-container { padding: 0 0 20px 0; }

.docs-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 16px; flex-wrap: wrap; gap: 10px;
}
.docs-title h3 { margin: 0; font-size: 18px; color: var(--text-primary); }
.docs-subtitle { font-size: 13px; color: var(--text-secondary); margin-left: 8px; }
.docs-stats { display: flex; gap: 12px; font-size: 12px; color: var(--text-secondary); }
.docs-stat-item { background: var(--bg-primary); padding: 4px 10px; border-radius: 12px; white-space: nowrap; }

.docs-toolbar {
  display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;
}
.docs-view-toggle { display: flex; gap: 4px; background: var(--bg-primary); border-radius: 8px; padding: 3px; }
.docs-view-btn {
  padding: 6px 14px; border: none; background: transparent; cursor: pointer;
  border-radius: 6px; font-size: 13px; color: var(--text-secondary); transition: all 0.2s;
}
.docs-view-btn.active { background: var(--bg-sidebar); color: white; }

.docs-search-box { display: flex; gap: 4px; flex: 1; max-width: 400px; }
.docs-search-input {
  flex: 1; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 8px;
  font-size: 13px; outline: none; background: var(--bg-primary); color: var(--text-primary);
}
.docs-search-input:focus { border-color: var(--bg-sidebar); }
.docs-search-btn {
  padding: 8px 14px; border: none; background: var(--bg-sidebar); color: white;
  border-radius: 8px; cursor: pointer; font-size: 14px;
}
.docs-upload-btn {
  padding: 8px 16px; border: none; background: var(--teal); color: white;
  border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
  transition: background 0.2s; white-space: nowrap;
}
.docs-upload-btn:hover { background: var(--teal); }

.docs-content { min-height: 300px; }
.docs-loading, .docs-empty, .docs-error {
  text-align: center; padding: 60px 20px; color: var(--text-secondary); font-size: 14px;
}
.docs-empty-icon { font-size: 48px; margin-bottom: 12px; }
.docs-empty-hint { font-size: 12px; margin-top: 8px; opacity: 0.7; }
.docs-error { color: var(--accent); }

/* 类型概览条 */
.docs-type-bar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
.docs-type-chip {
  background: var(--bg-primary); padding: 4px 12px; border-radius: 12px;
  font-size: 12px; color: var(--text-secondary);
}

/* 分组 */
.docs-group { margin-bottom: 20px; }
.docs-group-header {
  display: flex; align-items: center; gap: 8px; margin-bottom: 10px;
  padding-bottom: 6px; border-bottom: 1px solid var(--border-color);
}
.docs-group-icon { font-size: 18px; }
.docs-group-title { font-size: 15px; font-weight: 600; color: var(--text-primary); }
.docs-group-count { font-size: 12px; color: var(--text-secondary); margin-left: auto; }

/* 文档卡片 */
.docs-list { display: flex; flex-direction: column; gap: 8px; }
.doc-card {
  display: flex; align-items: flex-start; gap: 12px; padding: 12px 16px;
  background: var(--bg-primary); border-radius: 10px; border: 1px solid var(--border-color);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.doc-card:hover { border-color: var(--bg-sidebar); box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
.doc-card-icon { font-size: 28px; line-height: 1; padding-top: 2px; }
.doc-card-body { flex: 1; min-width: 0; }
.doc-card-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px; }
.doc-card-file { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; word-break: break-all; }
.doc-card-meta { display: flex; gap: 10px; font-size: 11px; color: var(--text-secondary); flex-wrap: wrap; }
.doc-type-badge {
  background: rgba(240,185,123,0.12); color: var(--accent); padding: 2px 8px; border-radius: 10px; font-size: 11px;
}
.doc-company-badge{ background: rgba(139,148,158,0.10); color: var(--text-secondary); padding: 2px 8px; border-radius: 10px; font-size: 11px; }
.doc-card-desc { font-size: 12px; color: var(--text-secondary); margin-top: 6px; font-style: italic; }
.doc-card-actions { display: flex; gap: 4px; flex-shrink: 0; }
.doc-action-btn {
  width: 32px; height: 32px; border: none; background: transparent; cursor: pointer;
  border-radius: 6px; font-size: 16px; display: flex; align-items: center; justify-content: center;
  transition: background 0.2s;
}
.doc-action-btn:hover { background: rgba(0,0,0,0.06); }
.doc-delete-btn:hover { background: rgba(240,185,123,0.12); }

/* 全部公司网格 */
.docs-company-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
.docs-company-card {
  padding: 16px; background: var(--bg-primary); border-radius: 10px;
  border: 1px solid var(--border-color); cursor: pointer; transition: all 0.2s;
}
.docs-company-card:hover { border-color: var(--bg-sidebar); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
.docs-company-name { font-size: 15px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px; }
.docs-company-code { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
.docs-company-types { display: flex; gap: 6px; margin-bottom: 8px; flex-wrap: wrap; }
.docs-type-mini { font-size: 11px; background: var(--bg-secondary); padding: 2px 8px; border-radius: 10px; }
.docs-company-meta { display: flex; gap: 10px; font-size: 11px; color: var(--text-secondary); }

/* 搜索结果 */
.docs-search-results { margin-bottom: 12px; font-size: 13px; color: var(--text-secondary); }

/* 上传对话框 */
.docs-upload-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10000;
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.docs-upload-dialog {
  background: var(--bg-card); border-radius: 14px; width: 100%; max-width: 520px;
  max-height: 90vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
}
.docs-upload-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 20px; border-bottom: 1px solid var(--border-color);
}
.docs-upload-header h4 { margin: 0; font-size: 16px; color: var(--text-primary); }
.docs-upload-close {
  border: none; background: transparent; font-size: 18px; cursor: pointer;
  color: var(--text-secondary); padding: 4px 8px; border-radius: 6px;
}
.docs-upload-close:hover { background: var(--bg-primary); }
.docs-upload-body { padding: 20px; }
.docs-upload-field { margin-bottom: 14px; }
.docs-upload-field label {
  display: block; font-size: 13px; color: var(--text-secondary); margin-bottom: 4px; font-weight: 500;
}
.docs-upload-field input, .docs-upload-field select, .docs-upload-field textarea {
  width: 100%; padding: 8px 12px; border: 1px solid var(--border-color); border-radius: 8px;
  font-size: 13px; outline: none; background: var(--bg-primary); color: var(--text-primary);
  font-family: inherit;
}
.docs-upload-field input:focus, .docs-upload-field select:focus, .docs-upload-field textarea:focus {
  border-color: var(--bg-sidebar);
}
.docs-upload-field-row { display: flex; gap: 12px; }
.docs-upload-field-row .docs-upload-field { flex: 1; }

.docs-upload-dropzone {
  border: 2px dashed var(--border-color); border-radius: 12px; padding: 32px 20px;
  text-align: center; cursor: pointer; transition: all 0.2s; margin-top: 4px;
}
.docs-upload-dropzone:hover, .docs-upload-dropzone.dragover {
  border-color: var(--bg-sidebar); background: rgba(13,148,136,0.05);
}
.docs-dropzone-icon { font-size: 36px; margin-bottom: 8px; }
.docs-upload-dropzone p { margin: 4px 0; font-size: 13px; color: var(--text-secondary); }
.docs-dropzone-hint { font-size: 11px !important; opacity: 0.7; }
.docs-upload-filename {
  margin-top: 10px; padding: 8px 12px; background: rgba(139,148,158,0.10); border-radius: 8px;
  font-size: 13px; color: var(--text-secondary);
}

.docs-upload-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 16px 20px; border-top: 1px solid var(--border-color);
}
.docs-upload-cancel {
  padding: 8px 20px; border: 1px solid var(--border-color); background: var(--bg-primary);
  color: var(--text-secondary); border-radius: 8px; cursor: pointer; font-size: 13px;
}
.docs-upload-submit {
  padding: 8px 24px; border: none; background: var(--teal); color: white;
  border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
}
.docs-upload-submit:disabled { background: var(--text-disabled); cursor: not-allowed; }
.docs-upload-submit:not(:disabled):hover { background: var(--teal); }

/* ---- 批量上传对话框 ---- */
.docs-batch-btn {
  padding: 7px 14px; border: 1px solid var(--border-color); background: var(--bg-secondary);
  color: var(--text-primary); border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 500;
}
.docs-batch-btn:hover { background: rgba(13,148,136,0.08); border-color: var(--bg-sidebar); }
.docs-batch-dialog { max-width: 760px; }
.docs-batch-tip {
  font-size: 12px; color: var(--text-secondary); background: var(--bg-secondary);
  border: 1px solid var(--border-color); border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; line-height: 1.5;
}
.docs-batch-tip b { color: var(--text-primary); }
.docs-batch-toggle { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-primary); margin-bottom: 10px; cursor: pointer; }
.docs-batch-default { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); margin-bottom: 14px; }
.docs-batch-default select {
  padding: 6px 10px; border: 1px solid var(--border-color); border-radius: 8px; font-size: 13px;
  background: var(--bg-primary); color: var(--text-primary); font-family: inherit;
}
.docs-batch-rows { margin-top: 14px; max-height: 46vh; overflow-y: auto; border: 1px solid var(--border-color); border-radius: 10px; }
.bc-head, .bc-row {
  display: grid; grid-template-columns: 1.6fr 1.8fr 0.7fr 0.8fr 0.7fr; gap: 8px; align-items: center;
  padding: 8px 10px; font-size: 12px;
}
.bc-head { background: var(--bg-secondary); color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid var(--border-color); position: sticky; top: 0; }
.bc-row { border-bottom: 1px solid var(--border-color); }
.bc-row:nth-child(even) { background: var(--bg-primary); }
.bc-file { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
.bc-company { position: relative; }
.bc-badge { display: inline-block; font-size: 11px; padding: 2px 6px; border-radius: 6px; }
.bc-badge.bc-ok { background: rgba(139,148,158,0.12); color: var(--text-secondary); }
.bc-badge.bc-fallback { background: rgba(240,185,123,0.12); color: var(--accent); }
.bc-badge.bc-warn { background: var(--accent-light); color: var(--accent); }
.bc-pick { border: none; background: transparent; cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 6px; }
.bc-pick:hover { background: var(--bg-secondary); }
.bc-pick-box { position: absolute; top: 26px; left: 0; z-index: 20; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; padding: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.15); width: 240px; }
.bc-pick-input { width: 100%; padding: 6px 8px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 12px; outline: none; background: var(--bg-primary); color: var(--text-primary); font-family: inherit; }
.bc-pick-list { margin-top: 6px; max-height: 180px; overflow-y: auto; }
.bc-pick-item { padding: 6px 8px; font-size: 12px; border-radius: 6px; cursor: pointer; color: var(--text-primary); }
.bc-pick-item:hover { background: rgba(13,148,136,0.1); }
.bc-pick-item small { color: var(--text-secondary); }
.bc-pick-empty { padding: 6px 8px; font-size: 12px; color: var(--text-secondary); }
.bc-year-input { width: 100%; padding: 5px 6px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 12px; background: var(--bg-primary); color: var(--text-primary); font-family: inherit; }
.bc-type-sel, .bc-quarter-sel { width: 100%; padding: 5px 4px; border: 1px solid var(--border-color); border-radius: 6px; font-size: 12px; background: var(--bg-primary); color: var(--text-primary); font-family: inherit; }

/* ---- Capital Flow Analysis Styles ---- */
.capital-content { display: flex; flex-direction: column; gap: 16px; }
.capital-summary { padding: 12px; }
.cap-signal-box {
  padding: 16px; border-radius: 10px; text-align: center; margin-bottom: 12px;
  background: var(--bg-secondary); border: 1px solid var(--border-color);
}
.cap-signal-box.cap-positive { border-color: var(--red); background: rgba(246,70,93,0.05); }
.cap-signal-box.cap-negative { border-color: var(--green); background: rgba(14,203,129,0.05); }
.cap-signal-label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.cap-signal-value { font-size: 20px; font-weight: 700; margin-bottom: 6px; }
.cap-signal-desc { font-size: 13px; color: var(--text-secondary); }
.cap-metrics-row { display: flex; flex-wrap: wrap; gap: 12px; }
.cap-metric { flex: 1; min-width: 100px; text-align: center; padding: 8px; background: var(--bg-primary); border-radius: 8px; }
.cm-label { display: block; font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }
.cm-value { display: block; font-size: 15px; font-weight: 600; }
/* [20261024d] 指标卡括号内说明文字：比主值（15px）小一号，弱化为辅助信息（用户 2026-10-24 要求） */
.cm-value .cm-paren { font-size: 12px; font-weight: 500; }
/* 20261101i：60 日口径数值句并入「60日量能确认」tile 副行（原独立说明行删除） */
.cm-value .cm-sub { display: block; font-size: 10px; font-weight: 400; color: var(--text-light); margin-top: 3px; line-height: 1.5; }
/* 20261106f：「20日涨跌日量能比」数值解读逻辑下拉面板（用户截图指令）。
   排版纪律：触发器贴在卡片标签行内不额外占高度；面板在五联行下方普通流跨整行，
   不用绝对定位浮层 → 不受滚动容器裁剪、不破坏 ve-cols-5 五列等宽。
   着色纪律：三档解读是参考表，仅命中行保留方向色（红/绿/琥珀），其余中性灰（20261101f 铁律）；
   结论区按「契合/相反/中性」用红/琥珀/灰，全站红涨绿跌。 */
.cm-has-interpret { position: relative; }
.cm-interpret-trigger {
  position: relative; display: inline-flex; align-items: center; gap: 3px;
  margin-left: 6px; padding: 1px 6px; vertical-align: middle;
  font-size: 10px; font-weight: 500; line-height: 1.6;
  color: var(--accent); background: transparent;
  border: 1px solid var(--border); border-radius: 999px; cursor: pointer;
  transition: border-color 150ms ease, background 150ms ease, color 150ms ease;
}
/* 透明扩展点击区：手机端也能点到，但不改变标签行高度与卡片排版 */
.cm-interpret-trigger::before { content: ''; position: absolute; inset: -10px -4px; }
.cm-interpret-trigger:hover { border-color: var(--accent); background: rgba(240, 185, 123, 0.10); }
.cm-interpret-trigger:active { transform: scale(0.97); }
.cm-interpret-trigger:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.cm-interpret-trigger.is-open { border-color: var(--accent); background: rgba(240, 185, 123, 0.12); }
.cmi-chev { display: inline-block; font-size: 9px; transition: transform 180ms ease; }
.cm-interpret-trigger.is-open .cmi-chev { transform: rotate(180deg); }
.cm-interpret-panel[hidden] { display: none; }
.cm-interpret-panel {
  margin-top: 10px; padding: 12px 14px; text-align: left;
  background: var(--bg-primary); border: 1px solid var(--border-light);
  border-left: 3px solid var(--accent); border-radius: 8px;
}
.cmi-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 10px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.cmi-head-sub { font-size: 11px; font-weight: 400; color: var(--text-secondary); }
.cmi-rows { display: grid; gap: 8px; }
.cmi-row { display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 6px; }
.cmi-row-hit { border-color: var(--border); }
.cmi-badge { flex: none; min-width: 32px; padding: 2px 6px; text-align: center; font-size: 11px; font-weight: 700; border-radius: 4px; }
.cmi-ref { color: var(--text-secondary); background: var(--bg-elevated); }
.cmi-hit-bull { color: var(--red); background: rgba(246, 70, 93, 0.14); }
.cmi-hit-bear { color: var(--green); background: rgba(14, 203, 129, 0.14); }
.cmi-hit-neutral { color: var(--amber-text); background: var(--amber-bg); }
.cmi-lines { font-size: 11.5px; line-height: 1.7; color: var(--text-primary); }
.cmi-lines > div + div { margin-top: 2px; color: var(--text-secondary); }
.cmi-row-hit .cmi-lines > div:first-child { font-weight: 600; }
.cmi-foot { margin-top: 8px; font-size: 10.5px; color: var(--text-light); }
.cmi-today { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-light); }
.cmi-today-title { margin-bottom: 8px; font-size: 12.5px; font-weight: 600; color: var(--text-primary); }
.cmi-facts { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; }
.cmi-fact { flex: 1 1 220px; padding: 8px 10px; background: var(--bg-secondary); border: 1px solid var(--border-light); border-radius: 6px; }
.cmi-fact span { display: block; font-size: 10.5px; color: var(--text-secondary); }
.cmi-fact b { display: block; margin: 2px 0; font-size: 14px; color: var(--text-primary); }
.cmi-fact em { display: block; font-style: normal; font-size: 10.5px; line-height: 1.5; color: var(--text-light); }
.cmi-verdict { padding: 9px 11px; font-size: 12px; line-height: 1.7; border: 1px solid var(--border-light); border-radius: 6px; }
.cmi-verdict-tag { display: inline-block; margin-right: 8px; padding: 1px 7px; font-size: 10px; font-weight: 600; border-radius: 999px; background: var(--bg-elevated); }
.cmi-bull { color: var(--red); background: rgba(246, 70, 93, 0.06); border-color: rgba(246, 70, 93, 0.28); }
.cmi-bear { color: var(--green); background: rgba(14, 203, 129, 0.06); border-color: rgba(14, 203, 129, 0.28); }
.cmi-warn { color: var(--amber-text); background: var(--amber-bg); border-color: rgba(224, 180, 92, 0.32); }
.cmi-neutral { color: var(--text-secondary); background: var(--bg-secondary); }
.cmi-example { margin-top: 8px; font-size: 10.5px; line-height: 1.6; color: var(--text-light); }
.cmi-caliber { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border-light); font-size: 10.5px; line-height: 1.65; color: var(--text-muted); }
@media (max-width: 768px) {
  .cm-interpret-panel { padding: 10px; }
  .cm-interpret-trigger { padding: 4px 9px; font-size: 11px; }
  .cmi-fact { flex-basis: 100%; }
}
/* 20261101j：长文本卡（「资金行为」卡 / 指标行「筹码转移」tile）——整句短文案用小字号常规字重，
   与相邻数值卡（15px/600）保持盒高对齐（flex 拉伸），文字左对齐更利多行阅读 */
.cm-value-text { display: block; font-size: 12px; font-weight: 400; line-height: 1.55; color: var(--text-primary); text-align: left; }
.cap-pos { color: var(--red); }
.cap-neg { color: var(--green); }
.cap-neutral { color: var(--text-secondary); }
.cap-table { margin-bottom: 12px; }
.cap-table-header, .cap-table-row {
  display: flex; justify-content: space-between; padding: 6px 12px; font-size: 13px;
}
.cap-table-header { font-weight: 600; color: var(--text-secondary); border-bottom: 1px solid var(--border-color); }
.cap-table-row { border-bottom: 1px solid var(--border-light); }
.cap-recent-title { font-size: 13px; font-weight: 600; margin: 12px 0 6px; color: var(--text-primary); }
.cap-indicator-item {
  display: flex; align-items: center; gap: 8px; padding: 8px 12px;
  border-bottom: 1px solid var(--border-light); font-size: 13px;
}
.ci-label { flex: 1; color: var(--text-secondary); }
.ci-value { font-weight: 600; min-width: 80px; text-align: right; }
.ci-signal { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--bg-secondary); }
/* 20261101r（用户截图指令：卡片过密重排版，uicraft 排版纪律 + brand-guidelines 层级/间距节奏）：
   ① 三套栅格（结论 auto-fit 网格 / flex 均分指标行 / 量价 4 卡行）统一为共享网格语言
   （.ve-tile-row 10 列基准 + 通栏 .ve-cc-wide / 等分满行 .ve-flow-row），列缝 10px；
   ② 瓦片统一 surface（bg-primary + 细边框 + 10/12 内边距），高度自然对齐；
   ③ 结论横幅改左侧语义色竖条强调 + 多空比分徽标化（chip）；
   ④ 色板仍遵循工作台红涨绿跌 + 金强调（DESIGN.md）——brand-guidelines 的 Anthropic 色板
   与交易主题冲突，仅取其排版纪律（用户明确要求「与工作台一致」优先级最高）。 */
.ve-verdict {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 12px 14px 12px 15px; border-radius: 8px;
  border: 1px solid var(--border); border-left: 4px solid var(--accent);
  background: var(--bg-primary); margin-bottom: 6px;
}
.ve-verdict-bull { border-color: rgba(246, 70, 93, 0.35); border-left-color: var(--red); background: rgba(246, 70, 93, 0.06); }
.ve-verdict-bear { border-color: rgba(14, 203, 129, 0.35); border-left-color: var(--green); background: rgba(14, 203, 129, 0.06); }
.ve-verdict-neutral { border-left-color: var(--border-strong); background: var(--bg-primary); }
.ve-verdict-label { font-size: 14px; font-weight: 600; }
.ve-verdict-score { display: inline-flex; gap: 6px; }
.ve-score-chip { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
.ve-score-chip.ve-chip-bull { background: rgba(246, 70, 93, 0.14); color: var(--red); }
.ve-score-chip.ve-chip-bear { background: rgba(14, 203, 129, 0.14); color: var(--green); }
/* 20261101r：指标瓦片行——统一网格容器（替代原 flex 均分 cap-metrics-row，
   cap-metrics-row 类保留给 capitalCharts 资金概要卡，量能引擎卡内不再使用） */
.ve-tile-row { display: grid; gap: 10px; margin-top: 10px; }
.ve-cols-5 { grid-template-columns: repeat(5, 1fr); }
.ve-cols-4 { grid-template-columns: repeat(4, 1fr); } /* 20261106k：60日量能确认卡退役后量价统计行改四联 */
.ve-cols-3 { grid-template-columns: repeat(3, 1fr); } /* 20261106l：5日量能比卡退役后量价统计行改三联 */
.ve-cols-10 { grid-template-columns: repeat(10, 1fr); }
.ve-span4 { grid-column: span 4; }
/* 20261102c：ve-cols-10 行内 cap-metric 默认占 2 列（4+2+2+2=10 列满行，修复此前默认 1 列
   导致宽屏下 4+1+1+1=7 列、右侧 3 列空白的隐患）；ve-span4 长文本卡覆盖为 4 列。 */
.ve-cols-10 .cap-metric { grid-column: span 2; }
.ve-tile-row .cap-metric {
  padding: 10px 12px; min-width: 0;
  background: var(--bg-primary); border: 1px solid var(--border-light); border-radius: 8px;
}
/* 20261102b（用户截图指令「展示卡片杂乱无章、毫无设计美感和对称性」）：
   原 .ve-conclusion-grid 固定 3 列在条目数非 3 的倍数时右侧留大块空白（融资融券独占 1/3 行），
   且列缝与 5 列/10 列基准网格断裂 → 改 .ve-flow-row 等分满行：条目（2~6 个动态）flex 等分
   等高（stretch），满行对称；通栏长文本（量价关系）用 .ve-cc-wide 独占整行。
   与 .ve-tile-row 同 gap（10px）、同瓦片 surface，整卡行节奏统一。 */
.ve-flow-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 10px; }
.ve-flow-row .ve-cc { flex: 1 1 180px; }
.ve-cc {
  padding: 10px 12px; border-radius: 8px; min-width: 0;
  background: var(--bg-primary); border: 1px solid var(--border-light); text-align: left;
}
.ve-cc-wide {
  display: flex; align-items: baseline; gap: 10px; margin-top: 10px;
  padding: 10px 12px; border-radius: 8px;
  background: var(--bg-primary); border: 1px solid var(--border-light);
}
.ve-cc-wide .ve-cc-label { margin-bottom: 0; flex: none; }
.ve-cc-label { display: block; font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; }
.ve-cc-text { display: block; font-size: 13px; line-height: 1.55; }
/* 20261103f（用户截图指令）：量能分析卡利好/利空语义着色——利好=红、利空=绿（全站红涨绿跌语义），中性不着色 */
.ve-tone-bull { color: var(--red); }
.ve-tone-bear { color: var(--green); }
/* 20261101r：窄屏降级——≤900px 两列（长文本卡通栏、列缝逐列对齐失效处保持整洁），≤560px 单列 */
@media (max-width: 900px) {
  .ve-cols-5 { grid-template-columns: repeat(2, 1fr); }
  .ve-cols-4 { grid-template-columns: repeat(2, 1fr); }
  .ve-cols-3 { grid-template-columns: repeat(3, 1fr); }
  .ve-cols-10 { grid-template-columns: 1fr 1fr; }
  .ve-cols-10 .ve-span4 { grid-column: span 2; }
  .ve-cols-10 .cap-metric { grid-column: auto; } /* 20261102c：两列窄网格下重置为流式，两枚一行 */
  .ve-flow-row .ve-cc { flex-basis: calc(50% - 5px); }
}
@media (max-width: 560px) {
  .ve-cols-5, .ve-cols-4, .ve-cols-3, .ve-cols-10 { grid-template-columns: 1fr; }
  .ve-cols-10 .ve-span4 { grid-column: auto; }
  .ve-cols-10 .cap-metric { grid-column: auto; } /* 20261102c：单列下重置，防隐式第二列 */
  .ve-flow-row .ve-cc { flex-basis: 100%; }
}
.cap-date-note { font-size: 11px; color: var(--text-light); margin-top: 10px; }

/* ---- 量能分析引擎卡（20261017c：spec 十三步链路，红涨绿跌 softDark）----
   20261101k：.ve-score 两行随「量能信号」横幅删除（见上方死样式清理注释） */
.ve-section-title { font-size: 13px; font-weight: 600; color: var(--text-primary); margin: 16px 0 10px; padding-left: 9px; border-left: 3px solid var(--accent); line-height: 1.4; }
/* 20261101j：.ve-vp-line/.ve-vp-signal/.ve-vp-desc 与 .ve-dims/.ve-dim* 随展示层改版删除
   （量价说明行删除、「资金行为/筹码转移」并入卡片，全库零引用，守卫见 test_pos_volume_matrix） */
.ve-rules { display: flex; flex-direction: column; gap: 8px; }
.ve-rule { padding: 8px 12px; border-radius: 8px; background: var(--bg-primary); border: 1px solid var(--border-light); }
.ve-rule-hit { border-color: var(--border-strong); background: var(--bg-secondary); }
.ve-rule-head { display: flex; align-items: center; gap: 8px; }
.ve-rule-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.ve-rule-badge { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--bg-hover); color: var(--text-secondary); }
.ve-rule-badge.ve-bull { background: rgba(246,70,93,0.15); color: var(--red); }
.ve-rule-badge.ve-bear { background: rgba(14,203,129,0.15); color: var(--green); }
.ve-rule-badge.ve-block { background: var(--accent-light); color: var(--accent); }
.ve-rule-badge.ve-miss { opacity: 0.7; }
.ve-rule-concl { font-size: 12px; color: var(--text-secondary); line-height: 1.6; margin-top: 4px; }
.ve-rule-gaps { font-size: 11px; color: var(--text-light); line-height: 1.5; margin-top: 4px; }
.ve-risk-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.ve-risk-tag { font-size: 11px; padding: 2px 8px; border-radius: 4px; background: var(--accent-light); color: var(--accent); }
.ve-conclusion { font-size: 13px; line-height: 1.7; color: var(--text-primary); padding: 10px 12px; background: var(--bg-primary); border-radius: 8px; }
.ve-note { font-size: 12px; color: var(--text-secondary); margin-top: 8px; line-height: 1.6; }
.ve-gaps { margin-top: 10px; padding: 8px 12px; border-radius: 8px; background: var(--accent-light); border: 1px solid var(--accent); }
.ve-gaps-title { font-size: 12px; font-weight: 600; color: var(--accent); margin-bottom: 4px; }
.ve-gap-item { font-size: 12px; color: var(--text-secondary); line-height: 1.6; }

/* 20261023f：数据来源与口径说明（与红色「数据不足」分开，避免误读） */
.ve-src-notes { margin-top: 10px; padding: 8px 12px; border-radius: 8px; background: var(--bg-primary); border: 1px solid var(--border); }
.ve-src-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 4px; }

/* ---- 20261023d：量价十口诀（郭睿体系）主判层 ---- */
.ve-ten-primary { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 8px 0 10px; background: var(--bg-card); }
.ve-ten-head { font-size: 12.5px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px; }
.ve-ten-risk { font-size: 11px; color: var(--accent); margin-left: 8px; font-weight: 400; }
.ve-ten-table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin: 6px 0; }
.ve-ten-table th { text-align: left; color: var(--text-secondary); padding: 5px 8px; border-bottom: 1px solid var(--border); font-weight: 600; white-space: nowrap; }
.ve-ten-table td { padding: 5px 8px; border-bottom: 1px solid rgba(255,255,255,.04); color: var(--text-secondary); vertical-align: top; }
.ve-ten-table tr.hit td { color: var(--text-primary); background: rgba(240,185,123,.07); }
.ve-ten-table tr.hit td:nth-child(2) { color: var(--accent); font-weight: 600; }
.ve-ten-fw { font-size: 11.5px; color: var(--text-muted); margin: 5px 0; line-height: 1.6; }
.ve-ten-rem { font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.7; }

/* ---- 20261101d：位置感知量价判定主判（先定位置 → 量能×涨跌幅 → 判定，红涨绿跌 softDark）---- */
.ve-posj { border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin: 8px 0 10px; background: var(--bg-card); }
.ve-posj-step { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; padding: 3px 0; }
.ve-posj-step-label { flex: 0 0 132px; font-size: 11px; color: var(--text-muted); }
.ve-posj-pos { font-size: 14px; font-weight: 700; color: var(--accent); }
.ve-posj-pos-note { font-size: 12px; color: var(--text-secondary); }
.ve-posj-combo { font-size: 14px; font-weight: 700; color: var(--text-primary); }
.ve-posj-combo-note { font-size: 12px; color: var(--text-secondary); }
/* 20261106c（用户截图指令）：第三步「当日量/20日均量」为全日口径，盘中只有半天累计量 → 常驻琥珀高亮提醒。
   .ve-posj-step 是 flex-wrap 容器，flex:1 1 100% 使其独占整行排在文案之后，不被挤成窄列；
   配色沿用工作台金强调（--amber-*），与参考表「仅命中行着色」铁律无关（本条是口径警示，不是方向判定）。 */
.ve-posj-caliber-warn {
  flex: 1 1 100%; margin-top: 2px; padding: 5px 10px;
  font-size: 11.5px; font-weight: 600; line-height: 1.6;
  color: var(--amber-text); background: var(--amber-bg);
  border: 1px solid rgba(224,180,92,0.32); border-left: 3px solid var(--amber);
  border-radius: 4px;
}
.ve-posj-main { margin: 8px 0; padding: 10px 12px; border-radius: 8px; font-size: 13px; line-height: 1.7; background: var(--bg-primary); border-left: 3px solid var(--text-muted); color: var(--text-primary); }
.ve-posj-main.bull { border-left-color: var(--red); }
.ve-posj-main.bear { border-left-color: var(--green); }
.ve-posj-main.caution, .ve-posj-main.observe { border-left-color: var(--accent); }
.ve-posj-main .ve-posj-dir { font-weight: 700; margin-right: 6px; }
.ve-posj-main.bull .ve-posj-dir { color: var(--red); }
.ve-posj-main.bear .ve-posj-dir { color: var(--green); }
.ve-posj-main.caution .ve-posj-dir, .ve-posj-main.observe .ve-posj-dir { color: var(--accent); }
.ve-posj-table { width: 100%; border-collapse: collapse; font-size: 11.5px; margin: 6px 0; }
.ve-posj-table th { text-align: left; color: var(--text-secondary); padding: 5px 8px; border-bottom: 1px solid var(--border); font-weight: 600; white-space: nowrap; }
.ve-posj-table td { padding: 5px 8px; border-bottom: 1px solid rgba(255,255,255,.04); color: var(--text-secondary); vertical-align: top; }
.ve-posj-table tr.hit td { color: var(--text-primary); background: rgba(240,185,123,.07); }
.ve-posj-table tr.hit td:nth-child(1) { color: var(--accent); font-weight: 600; }
/* 20261102i：参考表灰色追加的震荡/箱体形态行（未触发仅参考，弱化不抢主矩阵视觉；命中高亮复用 hit 规则） */
.ve-posj-table tr.ve-posj-extgroup td { border-bottom: none; padding: 8px 8px 2px; color: var(--text-muted); font-weight: 600; font-size: 11px; letter-spacing: .3px; }
.ve-posj-table tr.ve-posj-extrow td { color: var(--text-muted); }
.ve-posj-table tr.ve-posj-extrow td:first-child { white-space: nowrap; }
.ve-posj-table tr.ve-posj-extrow .ve-rule-badge { background: transparent; border: 1px solid var(--border); color: var(--text-muted); }
/* 20261102f：主判生效路径说明（扩展判定归一，替代 20261102e 的静态扩展清单） */
.ve-posj-path { font-size: 11px; color: var(--text-muted); line-height: 1.6; margin: -4px 0 6px; }
/* 20261102g：异常判定块（量价背离 / 极端量能状态展示，位于三步之后、主判横幅之前） */
.ve-posj-anomaly { align-items: flex-start; }
.ve-posj-anomaly-list { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.ve-posj-anomaly-item { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; }
.ve-posj-anomaly-name { font-size: 12.5px; font-weight: 600; color: var(--text-primary); }

/* 20261105f-b：五步判定链紧凑区（从第二步行内移出，单列小字可审计）
   20261106h（回滚 20261106g 失败改造）：g 版把 .ve-posj-chain-item 改成 28px 双列栅格，
   但 .ve-rule-badge 里装的是「① 道氏结构 / ⑤ 量价健康度」这类中文标签，被压到 28px 后
   逐字竖排，整个判定链崩坏（用户截图 15:38「界面优化完全失败」）。已整块撤销覆盖规则，
   恢复本处 flex 基线。本轮只做两处零风险修正：
   ① margin 去掉单侧 140px 左缩进，判定链左右边界与三步骤 / 警示 / 主判 / 参考表对齐；
   ② 徽标固定 96px 且 nowrap —— 既让 5 行文字起点统一，也永久防止中文标签被压成竖排。 */
.ve-posj-chain { margin: 6px 0 2px 0; padding: 6px 10px; background: rgba(240, 185, 123, 0.04); border-left: 2px solid rgba(240, 185, 123, 0.35); border-radius: 4px; display: flex; flex-direction: column; gap: 3px; }
.ve-posj-chain-title { font-size: 10.5px; color: var(--text-muted); letter-spacing: 0.5px; }
.ve-posj-chain-item { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.ve-posj-chain-item > .ve-rule-badge { flex: 0 0 96px; white-space: nowrap; }
.ve-posj-chain-text { font-size: 11.5px; color: var(--text-secondary); min-width: 0; flex: 1; }
@media (max-width: 768px) {
  .ve-posj-chain-item > .ve-rule-badge { flex: 0 0 auto; }
  /* 20261106h：窄屏说明文字独占整行，避免与结果列挤在同一行被右侧裁切；仅窄屏生效，宽屏零变化 */
  .ve-posj-step > .ve-posj-pos-note, .ve-posj-step > .ve-posj-combo-note { flex: 1 1 100%; min-width: 0; }
}
/* 20261105f-b：信号叠加层未触发单行 chips */
.ve-sig-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; }
.ve-sig-chip { display: inline-flex; align-items: baseline; gap: 4px; font-size: 12px; color: var(--text-secondary); }

/* ---- 20261106h：20261106g 对称化覆盖块已整块撤销（事故留档）----
   失效原因：g 版把 .ve-posj-chain-item 改成 grid 28px + 1fr，误以为第一列是圆形数字徽标；
   实际 .ve-rule-badge 的内容是「① 道氏结构」「⑤ 量价健康度」等中文标签（见 lib/volumeEngine.js
   _runState 的 steps.k），28px 只放得下一个汉字 → 五步判定链整列竖排，用户截图判定「界面优化完全失败」。
   教训：改布局前必须先读真实 DOM 的子元素内容，不能按类名想当然；无头截图复刻页必须与真实 DOM
   一字不差（g 版复刻页用了短徽标，所以两轮截图都没抓到这个 bug）。
   现行方案见上方 20261105f-b 区块：flex 基线 + 取消单侧缩进 + 徽标 96px nowrap。 */

/* ---- 公司类型分类面板（20260902i 重设计：中性卡面 + 类型色左强调线 + 数据栅格）---- */
.company-type-panel { margin-bottom: 16px; }
.company-type-card {
  background: var(--bg-card);
  border: 1px solid rgba(255,255,255,0.08);
  border-left: 3px solid var(--ct-accent, #aab2c0);
  border-radius: 8px;
  padding: 16px 20px;
  display: flex; flex-direction: column; gap: 12px;
}
.ct-header { display: flex; align-items: flex-start; gap: 12px; }
.ct-icon {
  flex: none; width: 40px; height: 40px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; background: var(--ct-tint, rgba(255,255,255,0.06));
  border: 1px solid rgba(255,255,255,0.08);
}
.ct-title { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.ct-name { font-size: 18px; font-weight: 700; color: var(--ct-accent, #aab2c0); letter-spacing: 0.02em; }
.ct-desc { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin: 0; }
.ct-focus { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ct-focus-label { font-size: 12px; color: var(--text-secondary); flex: none; }
.ct-focus-text { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.ct-metrics { display: flex; flex-wrap: wrap; gap: 6px; }
.ct-metric-tag {
  font-size: 12px; padding: 3px 10px; border-radius: 4px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.10);
  color: var(--text-primary);
}
.ct-data { display: flex; flex-wrap: wrap; row-gap: 10px; }
.ct-stat { display: flex; flex-direction: column; gap: 3px; padding: 2px 16px; border-left: 1px solid rgba(255,255,255,0.07); }
.ct-stat:first-child { border-left: none; padding-left: 0; }
.ct-stat-label { font-size: 11px; color: var(--text-secondary); white-space: nowrap; }
.ct-stat-value { font-size: 15px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; white-space: nowrap; }

/* ---- 本地资料库面板 ---- */
.local-docs-panel { margin-bottom: 16px; }
.local-docs-card {
  background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 10px;
  padding: 16px 20px;
}
.local-docs-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.local-docs-header h3 { font-size: 16px; margin: 0; }
.local-docs-hint { font-size: 12px; color: var(--text-secondary); }
.local-docs-list { display: flex; flex-direction: column; gap: 8px; }
.local-doc-item {
  display: flex; align-items: center; gap: 12px; padding: 8px 12px;
  border: 1px solid var(--border-light); border-radius: 8px; background: var(--bg-primary);
}
.doc-icon { font-size: 1.3em; }
.doc-info { flex: 1; min-width: 0; }
.doc-title { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.doc-meta { display: flex; gap: 8px; font-size: 11px; color: var(--text-secondary); margin-top: 2px; }
.doc-type-tag {
  background: var(--bg-secondary); padding: 1px 6px; border-radius: 4px; font-size: 10px;
}
.doc-download-btn {
  font-size: 12px; padding: 4px 12px; border-radius: 6px;
  background: var(--blue, var(--accent)); color: #0B0E11; text-decoration: none; white-space: nowrap;
}
.doc-download-btn:hover { opacity: 0.85; }

/* ---- 产品分析面板 ---- */
.product-analysis-panel { margin-bottom: 16px; }
.product-analysis-card {
  background: var(--bg-card); border: 1px solid var(--border-light); border-radius: 10px;
  padding: 16px 20px;
}
.pa-header h3 { font-size: 16px; margin: 0 0 6px; }
.pa-description { font-size: 13px; color: var(--text-secondary); margin: 0 0 2px; }
.pa-focus-text { font-size: 13px; color: var(--text-primary); font-weight: 500; margin: 0 0 12px; }
.pa-focus-section, .pa-growth-section, .pa-expense-section {
  margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border-light);
}
.pa-focus-section h4, .pa-growth-section h4, .pa-expense-section h4 {
  font-size: 14px; margin: 0 0 8px; color: var(--text-primary);
}
.pa-focus-metrics { display: flex; flex-wrap: wrap; gap: 8px; }
.pa-metric-item {
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 6px 14px; border-radius: 8px; border: 1px solid var(--border-light);
  min-width: 100px;
}
.pa-metric-item.good { background: rgba(246,70,93,0.08); border-color: rgba(246,70,93,0.3); }
.pa-metric-item.bad { background: rgba(14,203,129,0.08); border-color: rgba(14,203,129,0.3); }
.pa-metric-label { font-size: 11px; color: var(--text-secondary); }
.pa-metric-value { font-size: 14px; font-weight: 600; }
.pa-growth-info { display: flex; flex-wrap: wrap; gap: 16px; font-size: 13px; }
.pa-growth-info .positive { color: var(--red); }
.pa-growth-info .negative { color: var(--green); }
.pa-expense-list { display: flex; flex-direction: column; gap: 6px; }
.pa-expense-item {
  display: flex; justify-content: space-between; padding: 6px 12px;
  background: var(--bg-primary); border-radius: 6px; font-size: 13px;
}
.pa-expense-value { font-weight: 600; }

/* ---- 公司类型徽章 (基本面tab) ---- */
.company-type-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 12px; border-radius: 16px; font-size: 13px; font-weight: 600;
  margin-bottom: 12px;
}
.company-type-badge.growth { background: rgba(240,185,123,0.12); color: var(--accent); }
.company-type-badge.value { background: rgba(224,180,92,0.14); color: var(--amber-text); }
.company-type-badge.dividend { background: rgba(139,148,158,0.12); color: var(--text-secondary); }
.company-type-badge.balanced { background: var(--bg-elevated); color: var(--text-primary); }

/* ===== 期货关联走势面板（需求1） ===== */
#futuresChart { height: 340px; }
.corr-badge {
  display: inline-block; padding: 2px 10px; border-radius: 12px;
  font-size: 12px; font-weight: 600; border: 1px solid transparent;
}
.futures-conclusion { margin-top: 12px; }
.futures-conclusion .sc-reasoning { max-height: 280px; overflow-y: auto; }

/* ===== 结论 + 论证过程（需求3/4） ===== */
.section-conclusion {
  margin-top: 12px; padding: 12px 14px; background: var(--bg-primary);
  border-left: 3px solid var(--accent); border-radius: 6px;
}
.sc-summary { display: flex; gap: 8px; font-size: 13px; line-height: 1.6; color: var(--text-primary); }
.sc-icon { flex-shrink: 0; }
.sc-toggle {
  margin-top: 10px; padding: 5px 14px; font-size: 12px; cursor: pointer;
  background: var(--accent); color: #0B0E11; border: none; border-radius: 6px;
  transition: background 0.2s;
}
.sc-toggle:hover { background: var(--accent-hover); }
.sc-reasoning { margin-top: 10px; padding: 10px 12px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 6px; }
/* 论证过程默认折叠：必须显式隐藏 .hidden，否则 toggle 无效（需求⑥·②） */
.sc-reasoning.hidden { display: none; }
.sc-reason-item { font-size: 12.5px; line-height: 1.7; color: var(--text-secondary); padding: 2px 0; }

/* 技术指标结论（需求4） */
.chart-conclusion {
  margin-top: 10px; padding: 8px 12px; background: rgba(240,185,123,0.06);
  border-radius: 6px; font-size: 12.5px; line-height: 1.6; color: var(--text-primary);
  display: flex; gap: 6px;
}
.cc-icon { flex-shrink: 0; }

/* ===== 批量下载年报（需求2） ===== */
.docs-report-card {
  margin-bottom: 16px; padding: 16px; background: var(--bg-card);
  border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow);
}
.drc-header { display: flex; align-items: baseline; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.drc-header h4 { font-size: 15px; color: var(--text-primary); }
.drc-hint { font-size: 12px; color: var(--text-secondary); }
.drc-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.drc-input {
  flex: 1; min-width: 240px; padding: 8px 12px; border: 1px solid var(--border);
  border-radius: var(--radius-sm); font-size: 13px; outline: none;
}
.drc-input:focus { border-color: var(--accent); }
.drc-label { font-size: 13px; color: var(--text-secondary); }
.drc-select { padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; }
.drc-check { font-size: 13px; color: var(--text-primary); display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.drc-btn {
  padding: 8px 18px; background: var(--accent); color: #0B0E11; border: none;
  border-radius: var(--radius-sm); font-size: 13px; font-weight: 500; cursor: pointer; transition: background 0.2s;
}
.drc-btn:hover { background: var(--accent-hover); }
.drc-btn:disabled { opacity: 0.6; cursor: wait; }
.drc-btn-sm {
  padding: 6px 14px; background: var(--bg-primary); color: var(--accent);
  border: 1px solid var(--accent); border-radius: var(--radius-sm); font-size: 12px; cursor: pointer;
}
.drc-result { margin-top: 8px; }
.drc-msg { padding: 10px 12px; border-radius: 6px; font-size: 13px; line-height: 1.6; }
.drc-msg.info { background: rgba(240,185,123,0.12); color: var(--accent); }
.drc-msg.success { background: rgba(255,255,255,0.05); color: var(--text-secondary); }
.drc-msg.warn { background: rgba(224,180,92,0.14); color: var(--amber-text); }
.drc-msg.error { background: var(--accent-light); color: var(--accent); }
.drc-details { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.drc-detail-row { display: flex; gap: 10px; padding: 6px 10px; font-size: 12.5px; border-bottom: 1px solid var(--border); }
.drc-detail-row:last-child { border-bottom: none; }
.drc-code { font-weight: 600; min-width: 64px; }
.drc-detail-status { margin-left: auto; color: var(--text-secondary); }
.drc-actions { margin-top: 10px; }
.drc-btn-ghost { background: transparent; color: var(--text-secondary); border: 1px solid var(--border); }
/* 下载年报默认当前个股：目标提示行 */
.drc-target-row { justify-content: space-between; }
.drc-target {
  flex: 1; min-width: 240px; padding: 8px 12px; font-size: 13px; line-height: 1.5;
  background: var(--bg-primary); border: 1px dashed var(--border);
  border-radius: var(--radius-sm); color: var(--text-primary);
}
.drc-target b { color: var(--accent); }
.drc-target.drc-target-empty { border-color: var(--amber); background: rgba(224,180,92,0.14); color: var(--amber-text); }
.drc-more-toggle { white-space: nowrap; }
.drc-btn-ghost:hover { background: var(--hover); }
.drc-probe-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12.5px; }
.drc-probe-table th, .drc-probe-table td { border: 1px solid var(--border); padding: 6px 8px; text-align: left; }
.drc-probe-table th { background: var(--bg-secondary); color: var(--text-secondary); font-weight: 600; }
.drc-probe-table tr.drc-probe-hit td { background: rgba(139,148,158,0.12); color: var(--text-secondary); font-weight: 600; }
.drc-channels { margin-top: 8px; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
.drc-channel-row { display: flex; gap: 10px; align-items: center; padding: 6px 10px; font-size: 12.5px; border-bottom: 1px solid var(--border); background: var(--bg-secondary); }
.drc-channel-row:last-child { border-bottom: none; }
.drc-ch-name { font-weight: 600; min-width: 96px; }
.drc-ch-q { margin-left: auto; color: var(--text-secondary); }

/* ===== 自选股按钮（issue1：暗色下清晰可见） ===== */
.btn-watchlist {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 14px; border-radius: var(--radius-sm);
  border: 1px solid var(--accent);
  background: transparent; color: var(--accent);
  font-size: 13px; font-weight: 600; cursor: pointer;
  transition: all .15s ease;
}
.btn-watchlist:hover { background: var(--accent-light); }
.btn-watchlist.active { background: var(--accent); color: #0B0E11; border-color: var(--accent); }

/* ===== 首页美化（issue3） ===== */
.home-hero { padding: 36px 20px 28px; position: relative; }
.home-hero::after { content: ''; display: block; width: 64px; height: 3px; margin: 18px auto 0; border-radius: 3px; background: linear-gradient(90deg, var(--accent), var(--purple)); }
.home-hero .empty-icon { font-size: 56px; margin-bottom: 12px; }
.home-hero h2 { font-size: 26px; color: var(--text-primary); margin-bottom: 10px; letter-spacing: -0.5px; }
.home-date { color: var(--accent); font-size: 13px; margin-bottom: 10px; letter-spacing: 1px; }
.home-sub { color: var(--text-secondary); font-size: 15px; max-width: 560px; margin: 0 auto 18px; }
.home-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--gap-lg); max-width: 1100px; margin: 8px auto 40px; padding: 0 20px; }
.home-card {
  width: 100%;
  max-width: 1100px;
  margin: 0 auto 24px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--pad-card);
  min-height: 0;
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow);
}
.home-card-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
.home-card-head h3, .home-card-head h2 { font-size: 16px; font-weight: 600; color: var(--text-primary); margin: 0; letter-spacing: 0.2px; }
.home-card-body { flex: 1; overflow-y: auto; }

/* ===== 首页卡片折叠（除实时大盘/左侧边栏外全部可折叠） ===== */
.btn-collapse {
  width: 26px; height: 26px; border-radius: var(--radius-xs);
  background: transparent; border: 1px solid var(--border);
  color: var(--text-secondary); font-size: 12px; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: all 0.2s; margin-left: 4px;
}
.btn-collapse:hover { border-color: var(--accent); color: var(--accent); }
.btn-collapse.collapsed { transform: rotate(180deg); }
/* 卡片内容折叠动画：隐藏除 header 外所有子元素 */
.home-card > :not(.home-card-head),
.chart-card > :not(.chart-header) {
  /* 20260915：max-height 由 4000px 提升到 99999px。公司深度分析等长卡片（如 688660 电气风电）
     内容高度可超过 4000px，导致底部文本/表格被截断；99999px 在保留折叠动画的同时避免正常内容被截断。 */
  max-height: 99999px;
  opacity: 1;
  overflow: hidden;
  transition: max-height 0.28s ease, opacity 0.2s ease, padding 0.2s ease, margin 0.2s ease;
}
.home-card.collapsed > :not(.home-card-head),
.chart-card.collapsed > :not(.chart-header) {
  max-height: 0; opacity: 0;
  padding-top: 0; padding-bottom: 0;
  margin-top: 0; margin-bottom: 0;
}
.home-card.collapsed .home-card-head,
.chart-card.collapsed .chart-header { margin-bottom: 0; }
@media (max-width: 880px) { .home-grid { grid-template-columns: 1fr; } }

/* ===== 首页「今日财经热点」卡片 ===== */
.hot-news-card { min-height: 0; }
.hot-news-body { display: flex; flex-direction: column; gap: 8px; }

/* 20260907a：事件驱动卡片 */
.event-drive-body { display: flex; flex-direction: column; gap: 8px; }
.ev-list { display: flex; flex-direction: column; gap: 6px; }
.ev-row {
  display: flex; flex-direction: column; gap: 5px;
  padding: 9px 10px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-card);
}
.ev-line1 { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ev-line2 { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.ev-title { font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
.ev-row.ev-major { border-left: 3px solid #F0B97B; }
.ev-row.ev-moderate { border-left: 3px solid #F0B97B; }
.ev-row.ev-minor { border-left: 3px solid var(--text-light); }
.ev-grade { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 10px; }
.ev-grade.ev-major { background: var(--accent-light); color: #F0B97B; }
.ev-grade.ev-moderate { background: rgba(240,185,123,0.16); color: #F0B97B; }
.ev-grade.ev-minor { background: rgba(255,255,255,0.06); color: var(--text-secondary); }
.ev-dir { font-size: 12px; font-weight: 700; }
.ev-dir.ev-up { color: #F6465D; }
.ev-dir.ev-down { color: #0ECB81; }
.ev-dir.ev-neu { color: var(--text-secondary); }
.ev-sector { font-size: 13px; color: var(--text-primary); font-weight: 600; }
.ev-weight { font-size: 12px; color: var(--text-secondary); }
.ev-stocks { display: inline-flex; gap: 4px; flex-wrap: wrap; }
.ev-stock { font-size: 11px; background: rgba(240,185,123,0.12); color: #F0B97B; padding: 1px 6px; border-radius: 8px; }
.ev-paused { font-size: 11px; color: var(--text-light); }
.ev-pending { font-size: 11px; color: #F0B97B; background: rgba(240,185,123,0.12); padding: 1px 6px; border-radius: 8px; }
.ev-confirm {
  font-size: 11px; cursor: pointer; border-radius: 8px; padding: 2px 8px;
  background: rgba(240,185,123,0.16); color: #F0B97B; border: 1px solid rgba(240,185,123,0.4);
}
.ev-confirm:hover { background: rgba(240,185,123,0.28); }
.ev-confirm:disabled { opacity: .6; cursor: default; }
.ev-foot { font-size: 11px; color: var(--text-light); line-height: 1.6; padding-top: 2px; }
.hn-featured {
  display: block; text-decoration: none;
  background: linear-gradient(135deg, rgba(240,185,123,0.16), rgba(240,185,123,0.04));
  border: 1px solid var(--border-strong);
  border-radius: 10px; padding: 14px 16px; margin-bottom: 4px;
  transition: border-color .15s, transform .1s;
}
.hn-featured:hover { border-color: var(--accent); transform: translateY(-1px); }
.hn-feat-title { display: block; font-size: 16px; font-weight: 700; color: var(--text-primary); line-height: 1.4; margin: 8px 0 6px; }
.hn-feat-sum { display: block; font-size: 13px; color: var(--text-secondary); line-height: 1.5; margin-bottom: 8px; }
.hn-feat-meta { display: block; font-size: 12px; color: var(--text-light); }
.hn-list { display: flex; flex-direction: column; max-height: 320px; overflow-y: auto; }
.hn-list::-webkit-scrollbar { width: 6px; }
.hn-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.hn-item {
  display: flex; align-items: center; gap: 10px;
  text-decoration: none; color: var(--text-primary);
  padding: 9px 8px; border-bottom: 1px solid var(--border);
  transition: background .12s;
}
.hn-item:hover { background: var(--bg-hover); }
.hn-item:last-child { border-bottom: none; }
.hn-time { flex: 0 0 auto; font-size: 12px; color: var(--text-light); font-variant-numeric: tabular-nums; min-width: 80px; }
.hn-title { flex: 1 1 auto; font-size: 13.5px; color: var(--text-primary); line-height: 1.4; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.hn-sent { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
.hn-sent-pos { background: var(--red); }
.hn-sent-neg { background: var(--green); }
.hn-sent-neu { background: var(--text-light); }
.hn-impact { flex: 0 0 auto; font-size: 11.5px; font-weight: 600; white-space: nowrap; padding: 1px 7px; border-radius: 4px; line-height: 1.4; }
.hn-impact-up { color: var(--red); background: var(--tint-red); }
.hn-impact-down { color: var(--green); background: var(--tint-green); }
.hn-impact-neu { color: var(--text-muted); background: rgba(128,128,128,0.12); }
.hn-featured .hn-impact { font-size: 11.5px; vertical-align: middle; margin-left: 6px; }

/* 近一周涨跌前五高频板块提醒（红涨绿跌）：
   7日涨幅/跌幅最大卡片直接追加到行业板块涨跌前5的 .mo-tiles 末尾，
   与 Top5 共用同一行，样式完全继承 .mo-tile。 */

.hn-cat { flex: 0 0 auto; font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid transparent; white-space: nowrap; }
.cat-policy { color: #d8b878; background: rgba(216,184,120,0.12); border-color: rgba(216,184,120,0.3); }
.cat-intl   { color: #a99bc4; background: rgba(169,155,196,0.12); border-color: rgba(169,155,196,0.3); }
.cat-company{ color: #6fb0a4; background: rgba(111,176,164,0.12); border-color: rgba(111,176,164,0.3); }
.cat-market { color: var(--accent); background: rgba(240,185,123,0.12); border-color: rgba(240,185,123,0.3); }
.hn-foot { font-size: 11px; color: var(--text-light); margin-top: 6px; }

/* ===== 首页「板块舆情热度周榜」（20260909m：舆情+社区讨论热度五指标引擎） ===== */
.hot-topics-home-card { min-height: 0; }
.home-hot-topics-body { display: flex; flex-direction: column; gap: 8px; }

/* ---------- 板块舆情热度周榜（20260909m） ---------- */
.htw-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.htw-chip { font-size: 11px; color: var(--text-secondary); background: var(--bg-hover); border: 1px solid rgba(128,128,128,0.25); padding: 1px 8px; border-radius: 10px; white-space: nowrap; }
.htw-notice { font-size: 12.5px; color: var(--text-secondary); padding: 6px 10px; background: var(--bg-hover); border-radius: var(--radius-sm); border-left: 3px solid var(--accent); }
.htw-notice-warn { color: #e8c476; border-left-color: #e8c476; }
.htw-item {
  display: flex; align-items: center; gap: 10px; padding: 9px 6px;
  border-bottom: 1px solid var(--bg-hover);
}
.htw-item:hover { background: var(--bg-hover); }
.htw-item:last-of-type { border-bottom: none; }
.htw-alarm-row { background: rgba(240,185,123,0.06); }
.htw-rank {
  flex: 0 0 26px; height: 26px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 700; color: var(--text-secondary); background: var(--bg-hover);
}
.htw-item:nth-child(1) .htw-rank{ color: #fff; background: var(--accent); }
.htw-item:nth-child(2) .htw-rank{ color: #fff; background: rgba(240,185,123,0.65); }
.htw-item:nth-child(3) .htw-rank{ color: #fff; background: rgba(240,185,123,0.4); }
.htw-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.htw-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.htw-name { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.htw-sub { font-size: 11.5px; color: var(--text-light); font-variant-numeric: tabular-nums; }
.htw-right { flex: 0 0 auto; display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.htw-score { font-size: 17px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; line-height: 1; }
/* 20261015m：综合分大数字上方的含义小标签（用户反馈右侧白色数字无标注） */
.htw-score-label { display: block; font-size: 10px; font-weight: 500; color: var(--text-muted); letter-spacing: 1px; margin-bottom: 2px; line-height: 1; }
.htw-market { font-size: 11px; color: var(--text-light); font-variant-numeric: tabular-nums; white-space: nowrap; }
.htw-up { color: var(--red); }
.htw-down { color: var(--green); }
.htw-dim { color: var(--text-light); }
.htw-level { flex: 0 0 auto; font-size: 11px; font-weight: 600; padding: 1px 8px; border-radius: 10px; white-space: nowrap; }
.htw-level.lv-hot { color: #fff; background: var(--accent); }
.htw-level.lv-warm { color: #7a5a2e; background: rgba(240,185,123,0.6); }
.htw-level.lv-cool { color: var(--text-muted); background: rgba(128,128,128,0.15); }
.htw-tag2 { flex: 0 0 auto; font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid transparent; white-space: nowrap; }
.htw-tag2.tag-run  { color: var(--accent); background: var(--accent-light); border-color: rgba(240,185,123,0.3); }
.htw-tag2.tag-panic { color: var(--accent); background: var(--accent-light); border-color: rgba(240,185,123,0.3); }
.htw-tag2.tag-crowd { color: var(--accent); background: var(--accent-light); border-color: rgba(240,185,123,0.3); }
.htw-tag2.tag-kol  { color: var(--accent); background: var(--accent-light); border-color: rgba(240,185,123,0.3); }
.htw-tag2.tag-div  { color: #e8c476; background: rgba(232,196,118,0.12); border-color: rgba(232,196,118,0.3); }
.htw-tag2.tag-numb { color: var(--text-muted); background: rgba(128,128,128,0.12); border-color: rgba(128,128,128,0.3); }
.htw-alarm { font-size: 11px; font-weight: 700; color: var(--accent); white-space: nowrap; }
.htw-stock { font-size: 11px; color: var(--accent); background: rgba(240,185,123,0.12); border: 1px solid rgba(240,185,123,0.3); padding: 0 7px; border-radius: 10px; }
.htw-foot { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--bg-hover); }
.htw-foot-line { font-size: 11px; color: var(--text-light); line-height: 1.6; }
.htw-status { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary); padding: 8px 4px; }
.htw-spin {
  width: 14px; height: 14px; border-radius: 50%; flex: 0 0 auto;
  border: 2px solid var(--bg-hover); border-top-color: var(--accent);
  animation: htw-spin 0.9s linear infinite;
}
@keyframes htw-spin { to { transform: rotate(360deg); } }

/* ===== 实时大盘概览（首页指数速览） ===== */
.market-overview-card { min-height: 0; }
.mo-head-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.mo-updated { font-size: 12px; color: var(--text-secondary); }
.market-overview-body { display: flex; flex-direction: column; gap: 12px; }
.mo-empty { align-self: center; font-size: 12px; color: var(--text-secondary); padding: 8px 4px; white-space: nowrap; }
.mo-loading { color: var(--text-secondary); font-size: 13px; padding: 16px 4px; text-align: center; }

/* ===== 大盘估值趋势（上证50 / 沪深300 / 科创50 近5年PE-TTM） ===== */
.index-pe-trend-card { min-height: 0; }
.index-pe-trend-body { display: flex; flex-direction: column; gap: 12px; }
.ipe-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
.ipe-stat {
  background: var(--bg-hover); border-radius: var(--radius-sm); padding: 12px 14px;
  border-left: 3px solid var(--accent); display: flex; flex-direction: column; gap: 4px;
}
.ipe-stat.ipe-sz50 { border-left-color: #7fa8c9; }
.ipe-stat.ipe-hs300 { border-left-color: #cdab74; }
.ipe-stat.ipe-ci1000 { border-left-color: #a48fd8; }
.ipe-stat.ipe-kc50 { border-left-color: #cf8e8e; }
.ipe-name { font-size: 13px; color: var(--text-secondary); font-weight: 500; }
.ipe-pe { font-size: 22px; color: var(--text-primary); font-weight: 700; line-height: 1.2; }
.ipe-pe .ipe-unit { font-size: 12px; color: var(--text-muted); font-weight: 400; margin-left: 4px; }
.ipe-meta { font-size: 11px; color: var(--text-muted); line-height: 1.4; }
.ipe-quantile { display: inline-block; margin-top: 2px; font-size: 11px; color: var(--accent); background: var(--amber-bg); padding: 2px 6px; border-radius: var(--radius-xs); }
.ipe-chart { width: 100%; height: 320px; border-radius: var(--radius-sm); }
/* 20261016 审计修复：估值趋势数据源不可达回退缓存时的诚实警示条 */
.ipe-stale-warn { font-size: 11px; color: var(--accent); background: rgba(240,185,123,0.08); border-left: 3px solid var(--accent); border-radius: var(--radius-xs); padding: 4px 8px; margin-bottom: 4px; line-height: 1.5; }
.index-pe-trend-note { font-size: 11px; color: var(--text-muted); line-height: 1.5; padding-top: 4px; }

/* ===== 公司概况（issue6） ===== */
.company-profile { padding: 4px 0; }
.cp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
.cp-row { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.cp-label { font-size: 12px; color: var(--text-secondary); }
.cp-value { font-size: 14px; color: var(--text-primary); font-weight: 500; }
.cp-empty { color: var(--text-light); }
.cp-intro { margin-top: 14px; padding: 12px 14px; background: var(--bg-hover); border-radius: var(--radius-sm); font-size: 13px; color: var(--text-secondary); line-height: 1.6; }
/* 20261012：简介页面「主要产品」截图区（复用信息分析卡 productsServices.imageLocal） */
.cp-prod-title { margin-top: 16px; font-size: 13px; font-weight: 600; color: var(--text-primary); }
.cp-prod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; margin-top: 8px; }
.cp-prod { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--bg-card); display: flex; flex-direction: column; }
.cp-prod-img { position: relative; height: 90px; background: var(--bg-elevated); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.cp-prod-img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cp-ph { font-size: 22px; opacity: 0.4; }
.cp-prod-name { font-size: 12px; font-weight: 600; color: var(--text-primary); padding: 6px 8px 0; text-align: center; }
.cp-source { font-size: 11px; color: var(--text-light); margin-top: 12px; }
.company-type-badge-inline {
  display: inline-flex; align-items: center; padding: 3px 12px; border-radius: 999px;
  font-size: 12px; font-weight: 600; background: var(--accent-light); color: var(--accent);
  border: 1px solid var(--accent);
}

/* ===== 股东分析（issue5） ===== */
.shareholders-container { display: flex; flex-direction: column; gap: var(--gap-lg); }
.sh-summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.sh-summary-item { display: flex; flex-direction: column; gap: 4px; }
.sh-summary-label { font-size: 12px; color: var(--text-secondary); }
.sh-summary-value { font-size: 14px; color: var(--text-primary); font-weight: 500; }
.sh-summary-note { grid-column: 1 / -1; font-size: 11px; color: var(--text-light); margin-top: 6px; }
.sh-sub { font-size: 12px; color: var(--text-secondary); font-weight: 400; margin-left: 6px; }
.sh-empty { padding: 30px; text-align: center; color: var(--text-secondary); font-size: 13px; }
.sh-holders { display: flex; flex-direction: column; gap: 10px; }
.sh-holder-row { display: grid; grid-template-columns: 28px 1fr 70px 140px; align-items: center; gap: 12px; padding: 10px 12px; background: var(--bg-hover); border-radius: var(--radius-sm); }
.sh-rank { width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: var(--bg-primary); background: var(--accent); border-radius: 50%; }
.sh-holder-main { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.sh-holder-name { font-size: 13.5px; color: var(--text-primary); font-weight: 500; display: flex; align-items: center; gap: 8px; }
.sh-holder-bar { height: 6px; background: var(--bg-primary); border-radius: 3px; overflow: hidden; }
.sh-holder-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-hover)); border-radius: 3px; }
.sh-holder-ratio { text-align: right; font-size: 13px; color: var(--text-primary); font-weight: 600; }
.sh-holder-change { text-align: right; font-size: 12px; }
.sh-change.up { color: var(--red); }
.sh-change.down { color: var(--green); }
.sh-change.neutral { color: var(--text-secondary); }
.sh-tag { font-size: 10.5px; padding: 1px 6px; border-radius: 4px; }
.sh-tag.inst { background: var(--accent-light); color: var(--accent); }

/* ===== 东方财富妙想数据面板 ===== */
.mx-auth { padding: 16px; line-height: 1.9; font-size: 13px; color: var(--text-primary); }
.mx-auth a { color: var(--accent); word-break: break-all; }
.mx-hint { color: var(--text-secondary); font-size: 12px; margin-top: 8px; }
.mx-sub { font-size: 14px; color: var(--text-primary); margin: 18px 0 8px; font-weight: 600; }
.mx-table-block { margin-bottom: 16px; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.mx-table-title { font-size: 13px; font-weight: 600; color: var(--text-primary); padding: 10px 12px; background: var(--bg-hover); border-bottom: 1px solid var(--border); }
.mx-cond { font-size: 12px; color: var(--text-secondary); padding: 6px 12px 0; }
.mx-table-wrap { overflow-x: auto; }
.mx-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.mx-table th, .mx-table td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
.mx-table th { background: var(--bg-card); color: var(--text-secondary); font-weight: 600; position: sticky; top: 0; }
.mx-table tbody tr:hover { background: var(--bg-hover); }
/* 细分产品/业务毛利率表 */
.product-margin-table th.num, .product-margin-table td.num { text-align: right; font-variant-numeric: tabular-nums; }
.product-margin-table td.gm-name { font-weight: 600; color: var(--text-primary); white-space: normal; }
.product-margin-table .gm-cell { min-width: 96px; }
.product-margin-table .gm-val { font-weight: 600; }
.product-margin-table .gm-bar { display: block; height: 4px; border-radius: 2px; background: var(--border); margin-top: 4px; overflow: hidden; }
.product-margin-table .gm-bar i { display: block; height: 100%; border-radius: 2px; }
.product-margin-table tfoot td { font-weight: 600; background: var(--bg-hover); border-top: 1px solid var(--border); }
.mx-news { font-size: 13px; line-height: 1.8; color: var(--text-primary); background: var(--bg-hover); border-radius: var(--radius-sm); padding: 12px 16px; }
.mx-news h3, .mx-news h4, .mx-news h5 { color: var(--text-primary); margin: 10px 0 4px; }
.mx-news ul, .mx-news ol { padding-left: 20px; margin: 4px 0; }
.mx-keypaste { display: flex; gap: 8px; align-items: center; margin-top: 12px; padding: 10px 12px; background: var(--bg-hover); border-top: 1px solid var(--border); }
.mx-keypaste .ai-input { flex: 1; min-width: 0; }
.mx-news li { margin: 3px 0; }
.sh-tag.person { background: var(--bg-primary); color: var(--text-secondary); border: 1px solid var(--border); }
@media (max-width: 700px) { .sh-holder-row { grid-template-columns: 24px 1fr 56px; } .sh-holder-change { grid-column: 2 / -1; text-align: left; } }

/* ===== 个股亮点/雷点记录（issue4） ===== */
.stock-notes-container { display: flex; flex-direction: column; gap: 16px; }

/* ===== 个股记录（20261025l：个股页「个股记录」tab，按日期排序的手动记录） ===== */
.sl-wrap { display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
.sl-add { display: flex; flex-direction: column; gap: 8px; background: var(--card-bg, #161B22); border: 1px solid rgba(230,237,243,0.08); border-radius: 10px; padding: 14px; }
.sl-add input[type="date"] { align-self: flex-start; background: rgba(255,255,255,0.05); border: 1px solid rgba(230,237,243,0.12); color: var(--text-primary, #E6EDF3); border-radius: 8px; padding: 6px 10px; font-size: 13px; }
.sl-add textarea { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.04); border: 1px solid rgba(230,237,243,0.12); color: var(--text-primary, #E6EDF3); border-radius: 8px; padding: 10px 12px; font-size: 13.5px; line-height: 1.6; resize: vertical; font-family: inherit; }
.sl-add textarea:focus { outline: none; border-color: rgba(240,185,123,0.5); }
.sl-list { display: flex; flex-direction: column; gap: 14px; }
.sl-group { display: flex; flex-direction: column; gap: 8px; }
.sl-date { font-size: 12.5px; font-weight: 700; color: var(--accent, #F0B97B); }
.sl-item { display: flex; align-items: flex-start; gap: 10px; background: var(--card-bg, #161B22); border: 1px solid rgba(230,237,243,0.08); border-radius: 10px; padding: 10px 12px; }
.sl-text { flex: 1 1 auto; min-width: 0; font-size: 13.5px; line-height: 1.7; color: var(--text-primary, #E6EDF3); white-space: pre-wrap; word-break: break-word; }
.sl-del { flex: 0 0 auto; background: transparent; border: 1px solid rgba(230,237,243,0.16); color: var(--text-muted, #8B949E); border-radius: 7px; padding: 3px 10px; font-size: 11.5px; cursor: pointer; }
.sl-del:hover { color: var(--red, #F0B97B); border-color: rgba(240,185,123,0.5); }
.sl-empty { color: var(--text-muted, #8B949E); font-size: 13px; padding: 18px 4px; text-align: center; border: 1px dashed rgba(230,237,243,0.14); border-radius: 10px; }
/* 20261026f：行内编辑表单（修改按钮展开）——与 .sl-add 添加表单同一设计语言 */
.sl-btns { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.sl-edit { background: transparent; border: 1px solid rgba(230,237,243,0.16); color: var(--text-muted, #8B949E); border-radius: 7px; padding: 3px 10px; font-size: 11.5px; cursor: pointer; }
.sl-edit:hover { color: var(--accent, #F0B97B); border-color: rgba(240,185,123,0.5); }
.sl-item.sl-editing { border-color: rgba(240,185,123,0.45); background: rgba(240,185,123,0.04); }
.sl-edit-form { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.sl-edit-date { align-self: flex-start; background: rgba(255,255,255,0.05); border: 1px solid rgba(230,237,243,0.12); color: var(--text-primary, #E6EDF3); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: inherit; color-scheme: dark; }
.sl-edit-text { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.04); border: 1px solid rgba(230,237,243,0.12); color: var(--text-primary, #E6EDF3); border-radius: 8px; padding: 10px 12px; font-size: 13.5px; line-height: 1.6; resize: vertical; font-family: inherit; color-scheme: dark; }
.sl-edit-date:focus, .sl-edit-text:focus { outline: none; border-color: rgba(240,185,123,0.5); }
.sl-edit-actions { display: flex; justify-content: flex-end; gap: 8px; }
.sl-save { padding: 6px 16px; background: var(--accent, #F0B97B); color: #0B0E11; border: 1px solid var(--accent, #F0B97B); border-radius: 8px; cursor: pointer; font-size: 12.5px; font-weight: 600; }
.sl-save:hover { filter: brightness(1.08); }
.sl-save:disabled { opacity: 0.55; cursor: default; }
.sl-cancel { padding: 6px 14px; background: transparent; border: 1px solid rgba(230,237,243,0.16); color: var(--text-muted, #8B949E); border-radius: 8px; cursor: pointer; font-size: 12.5px; }
.sl-cancel:hover { color: var(--text-primary, #E6EDF3); border-color: rgba(230,237,243,0.3); }

/* ===== 个股行情判断记录（20261107 升级） ===== */
/* 添加表单：标题 + 日期/方向/依据一行 + 备注 + 按钮 */
.sl-add-head { font-size: 13px; font-weight: 600; color: var(--text-secondary, #8B949E); }
.sl-add-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sl-add-row select { background: rgba(255,255,255,0.05); border: 1px solid rgba(230,237,243,0.12); color: var(--text-primary, #E6EDF3); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: inherit; color-scheme: dark; }
/* 检索 / 筛选 / 排序 工具栏 */
.sl-toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; background: var(--card-bg, #161B22); border: 1px solid rgba(230,237,243,0.08); border-radius: 10px; padding: 10px 12px; }
.sl-search { flex: 1 1 220px; min-width: 160px; background: rgba(255,255,255,0.04); border: 1px solid rgba(230,237,243,0.12); color: var(--text-primary, #E6EDF3); border-radius: 8px; padding: 7px 12px; font-size: 13px; font-family: inherit; }
.sl-toolbar select, .sl-filter, .sl-sort { background: rgba(255,255,255,0.05); border: 1px solid rgba(230,237,243,0.12); color: var(--text-primary, #E6EDF3); border-radius: 8px; padding: 7px 10px; font-size: 12.5px; font-family: inherit; color-scheme: dark; cursor: pointer; }
.sl-filter { flex: 0 0 auto; }
.sl-sort { flex: 0 0 auto; white-space: nowrap; }
.sl-search:focus, .sl-filter:focus, .sl-sort:focus { outline: none; border-color: rgba(240,185,123,0.5); }
.sl-sort:hover { border-color: rgba(240,185,123,0.5); color: var(--accent, #F0B97B); }
/* 记录卡：主体（标签 + 备注）+ 动作按钮 */
.sl-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.sl-tags { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sl-date { font-size: 12.5px; font-weight: 700; color: var(--accent, #F0B97B); }
.sl-note { font-size: 13.5px; line-height: 1.7; color: var(--text-primary, #E6EDF3); white-space: pre-wrap; word-break: break-word; }
/* 方向徽标：A 股红涨绿跌 */
.sl-dir { font-size: 11.5px; font-weight: 600; border-radius: 6px; padding: 1px 8px; border: 1px solid transparent; }
.sl-dir-up { color: var(--red, #F6465D); background: rgba(246,70,93,0.12); border-color: rgba(246,70,93,0.4); }
.sl-dir-down { color: var(--green, #0ECB81); background: rgba(14,203,129,0.12); border-color: rgba(14,203,129,0.4); }
.sl-dir-sideways { color: var(--text-secondary, #8B949E); background: rgba(139,148,158,0.12); border-color: rgba(139,148,158,0.35); }
.sl-dir-na { color: var(--text-muted, #8B949E); background: rgba(139,148,158,0.1); border-color: rgba(139,148,158,0.3); }
/* 依据徽标 */
.sl-basis { font-size: 11px; border-radius: 6px; padding: 1px 8px; border: 1px solid rgba(230,237,243,0.16); color: var(--text-secondary, #8B949E); background: rgba(255,255,255,0.03); }
.sl-basis-technical { color: var(--accent, #F0B97B); border-color: rgba(240,185,123,0.4); }
.sl-basis-news { color: #6EA8FE; border-color: rgba(110,168,254,0.4); }
.sl-basis-other { color: var(--text-secondary, #8B949E); }
/* 行内编辑：日期/方向/依据一行 */
.sl-edit-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.sl-edit-row select { background: rgba(255,255,255,0.05); border: 1px solid rgba(230,237,243,0.12); color: var(--text-primary, #E6EDF3); border-radius: 8px; padding: 6px 10px; font-size: 13px; font-family: inherit; color-scheme: dark; }

/* ===== 20261108b：准确率标签布局优化（UI Audit 后重构） =====
   问题：旧版是「卡片里的卡片」——双行、独立边框、min-width 208px、约 70px 高，
   配合 align-items:flex-start 使标题贴顶、统计框下垂，中间空出大片留白并拉高头部行；
   最该突出的数值又用低对比灰，层级倒置。
   改法：单行胶囊标签 + 与标题同一基线（align-items:center）+ 完整明细收进 title。 */
.sl-add-head-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.sl-acc { display: inline-flex; align-items: center; gap: 8px; flex: 0 0 auto; max-width: 100%; padding: 4px 11px; border: 1px solid rgba(230,237,243,0.10); border-radius: 999px; background: rgba(255,255,255,0.035); white-space: nowrap; cursor: help; transition: border-color 150ms ease, background-color 150ms ease; }
.sl-acc:hover { border-color: rgba(240,185,123,0.40); background: rgba(240,185,123,0.05); }
.sl-acc-label { font-size: 11px; color: var(--text-muted, #8B949E); }
.sl-acc-value { font-size: 16px; font-weight: 700; line-height: 1; color: var(--text-primary, #E6EDF3); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.sl-acc-has .sl-acc-value { color: var(--accent, #F0B97B); }
.sl-acc-sub { padding-left: 8px; border-left: 1px solid rgba(230,237,243,0.12); font-size: 10.5px; color: var(--text-muted, #8B949E); }

/* 三类徽标统一尺寸（旧版 11.5 / 11 / 11 混用、padding 不一，并排时高低不齐） */
.sl-dir, .sl-basis, .sl-verdict { font-size: 11px; line-height: 1.55; padding: 1px 7px; border-radius: 6px; }
/* 结算徽标：✓ / ✗ 形状本身即语义，颜色只作辅助；附中文「对/错」避免色觉歧义 */
.sl-verdict { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px 1px 6px; border: 1px solid transparent; vertical-align: middle; font-weight: 600; cursor: help; }
.sl-verdict svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; flex: 0 0 auto; }
.sl-verdict-pending svg { fill: currentColor; stroke: none; }
.sl-verdict-txt { line-height: 1.3; }
.sl-verdict-ok{ color: var(--red, #F6465D); background: rgba(246,70,93,0.10); border-color: rgba(246,70,93,0.38); }
.sl-verdict-bad{ color: var(--green, #0ECB81); background: rgba(14,203,129,0.10); border-color: rgba(14,203,129,0.38); }
.sl-verdict-pending { color: var(--text-muted, #8B949E); background: rgba(139,148,158,0.08); border-color: rgba(139,148,158,0.25); font-weight: 500; }
/* 未填类统一弱化（去掉旧版虚线，与方向徽标同语言） */
.sl-dir-na, .sl-basis-na { background: rgba(139,148,158,0.07); border-color: rgba(139,148,158,0.22); }
/* 「未填依据」信息量低 → 降级为纯文字，消除与「未填」并列的两个灰 chip 冗余 */
.sl-basis-na { border-color: transparent; background: transparent; padding: 1px 3px; color: var(--text-muted, #8B949E); font-size: 10.5px; }
@media (max-width: 640px) {
  .sl-add-head-row { align-items: flex-start; }
  .sl-acc { border-radius: 10px; white-space: normal; flex-wrap: wrap; }
  .sl-acc-sub { border-left: none; padding-left: 0; }
}
.sn-toolbar { display: flex; align-items: center; justify-content: space-between; }
.sn-title { font-size: 16px; color: var(--text-primary); font-weight: 600; }
.sn-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.sn-block { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.sn-block.sn-highlight{ border-top: 3px solid var(--accent); }
.sn-block.sn-risk { border-top: 3px solid var(--accent); }
.sn-block-head { display: flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 600; color: var(--text-primary); }
.sn-count { font-size: 12px; color: var(--text-secondary); background: var(--bg-hover); border-radius: 999px; padding: 1px 8px; }
.sn-block-body { display: flex; flex-direction: column; gap: 10px; }
.sn-add { align-self: flex-start; }
.notes-empty { color: var(--text-secondary); font-size: 13px; padding: 14px 4px; text-align: center; background: var(--bg-hover); border-radius: var(--radius-sm); }
/* 20261025b：记录卡重排（用户要求：日期居左、状态标签小色块居右、正文行高拉开、
   动作按钮缩小沉底右对齐并与正文用细分隔线隔开，整体更清爽的金融工作台风格） */
.note-card { background: var(--bg-hover); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.note-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.note-head-tags { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.note-scope { font-size: 11.5px; color: var(--text-secondary); }
.note-date { font-size: 11.5px; color: var(--text-light); margin-left: 0; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; }
.note-title { font-size: 14px; font-weight: 600; color: var(--text-primary); margin: 0; }
.note-content { font-size: 13px; color: var(--text-secondary); line-height: 1.75; white-space: pre-wrap; margin: 0; }
.note-ver { font-size: 12px; }
.note-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--border); }

/* ===== 20261104h：投资心得图片附件 + 标签分类（用户指令：写心得可加图片；按标签分类展示管理；
   卡片右上角「💡 投资心得」改为显示标签） ===== */
/* 卡片右上角标签徽标（可点击筛选；样式沿用 note-scope 小字口径 + 琥珀描边轻强调） */
.note-tag-badge { cursor: pointer; padding: 1px 7px; border: 1px solid var(--accent-light); border-radius: 4px; color: var(--accent); background: var(--accent-light); transition: all 0.15s; }
.note-tag-badge:hover { border-color: var(--accent); }
.note-head-tagwrap { display: inline-flex; gap: 6px; flex-wrap: wrap; align-items: center; }
/* 卡片附件缩略图区 */
.note-attach-grid { display: flex; gap: 8px; flex-wrap: wrap; }
.note-attach-item { display: block; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; line-height: 0; transition: border-color 0.15s; }
.note-attach-item:hover { border-color: var(--accent); }
.note-attach-item img { width: 96px; height: 72px; object-fit: cover; display: block; }
/* 表单附件上传区 */
.form-attach-status { font-size: 12px; color: var(--text-secondary); min-height: 18px; }
.form-attach-grid { display: flex; gap: 8px; flex-wrap: wrap; }
.form-attach-item { position: relative; width: 84px; height: 64px; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
.form-attach-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
.form-attach-remove { position: absolute; top: 2px; right: 2px; width: 18px; height: 18px; border: none; border-radius: 50%; background: rgba(0,0,0,0.6); color: #fff; font-size: 12px; line-height: 18px; padding: 0; cursor: pointer; }
.form-attach-remove:hover { background: var(--accent); }
/* 投资心得页标签分类筛选条 */
.tag-filter-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 14px; padding: 10px 14px; background: var(--bg-hover); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.tag-bar-title { font-size: 12.5px; color: var(--text-secondary); font-weight: 600; }
.tag-bar-tip { font-size: 11px; color: var(--text-light); margin-left: auto; }
.tag-chip-wrap { display: inline-flex; align-items: center; }
.tag-chip { font-size: 12px; padding: 3px 10px; border: 1px solid var(--border); border-radius: 999px; background: var(--bg-card); color: var(--text-secondary); cursor: pointer; transition: all 0.15s; }
.tag-chip i { font-style: normal; font-size: 10.5px; color: var(--text-light); margin-left: 3px; }
.tag-chip:hover { border-color: var(--accent); color: var(--accent); }
.tag-chip.active { border-color: var(--accent); color: var(--accent); background: var(--accent-light); }
.tag-chip-manage { display: none; gap: 2px; margin-left: 4px; }
.tag-chip-wrap:hover .tag-chip-manage { display: inline-flex; }
.tag-manage-btn { width: 18px; height: 18px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-card); color: var(--text-secondary); font-size: 11px; line-height: 16px; padding: 0; cursor: pointer; }
.tag-manage-btn:hover { border-color: var(--accent); color: var(--accent); }
.sn-tag.hl { font-size: 10.5px; padding: 1px 6px; border-radius: 4px; background: var(--red-light); color: var(--red); }
.sn-tag.rk { font-size: 10.5px; padding: 1px 6px; border-radius: 4px; background: var(--accent-light); color: var(--accent); }
.sn-tag.ai { font-size: 10.5px; padding: 1px 6px; border-radius: 4px; background: var(--accent-light); color: var(--accent); }
.sn-ai { align-self: flex-start; }
.sn-ai:disabled { opacity: 0.6; cursor: progress; }
.sn-ai-status { font-size: 12px; padding: 6px 0; min-height: 22px; }
.sn-status.loading { color: var(--text-secondary); }
.sn-status.success { color: var(--text-secondary); }
.sn-status.info { color: var(--text-secondary); }
.sn-status.error { color: var(--accent); }
@media (max-width: 760px) { .sn-grid, .cp-grid { grid-template-columns: 1fr; } }

/* ===== 评分计算追溯（issue7） ===== */
.score-card.clickable { cursor: pointer; }
.score-card.clickable:active { transform: scale(0.98); }
.score-card.active { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(100, 149, 237, 0.25); }
.score-trace { font-size: 11.5px; color: var(--accent); cursor: pointer; margin-top: 6px; opacity: .85; }
.score-trace:hover { opacity: 1; }
.score-trace-panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px 18px; margin-top: 12px; }
.score-trace-panel.hidden { display: none; }
.score-trace-panel:not(.hidden) { animation: stFadeIn .18s ease; }
@keyframes stFadeIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
.score-trace-panel .st-head { font-size: 15px; font-weight: 600; color: var(--text-primary); margin-bottom: 8px; }
.score-trace-panel .st-note { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; margin-bottom: 10px; }
.score-trace-panel .st-sub { font-size: 13px; color: var(--text-primary); margin-bottom: 10px; }
.score-trace-panel .st-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; margin-bottom: 10px; }
.score-trace-panel .st-row { display: flex; justify-content: space-between; gap: 12px; font-size: 12.5px; padding: 4px 0; border-bottom: 1px dashed var(--border); }
.score-trace-panel .st-row span:first-child { color: var(--text-secondary); }
.score-trace-panel .st-row span:last-child { color: var(--text-primary); }
.score-trace-panel .st-rule { font-size: 12px; color: var(--text-secondary); padding: 8px 10px; background: var(--bg-hover); border-radius: var(--radius-sm); }

/* ===== AI 联网资料补全（内嵌 AI 工具） ===== */
.sidebar-setting-btn {
  width: 100%; padding: 8px 12px; background: var(--bg-elevated); color: var(--text-secondary);
  border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; font-size: 13px;
  text-align: left; transition: border-color 0.15s, color 0.15s;
}
.sidebar-setting-btn:hover { border-color: var(--accent); color: var(--accent); }

.ai-augment-card .ai-head-actions { display: flex; align-items: center; gap: 10px; }
.ai-date { font-size: 12px; color: var(--text-light); }
.ai-augment-body { padding: 4px 0; }
.ai-empty { color: var(--text-secondary); font-size: 13px; line-height: 1.7; padding: 12px 2px; }
.ai-empty.ai-loading { color: var(--accent); opacity: 1; animation: aiPulse 1.4s ease-in-out infinite; }
@keyframes aiPulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
.ai-note { color: var(--text-secondary); font-size: 13px; padding: 12px 2px; }
.ai-holder-body { padding: 4px 0; }
.ai-holder-result { padding: 6px 2px; }
.aih-count { font-size: 20px; font-weight: 700; color: var(--text-primary); }
.aih-asof { font-size: 13px; font-weight: 400; color: var(--text-secondary); }
.aih-trend { margin-top: 8px; font-size: 13px; line-height: 1.7; color: var(--text-primary); }
.aih-source { margin-top: 4px; font-size: 12px; color: var(--text-secondary); }
.aih-note { margin-top: 10px; font-size: 12px; line-height: 1.6; color: var(--text-secondary); background: var(--accent-light); border-left: 3px solid var(--accent); padding: 6px 10px; border-radius: 6px; }
.aih-note.aih-note-local { background: var(--accent-light); border-left-color: var(--accent); }
.ai-holder-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; }
.ai-holder-date { font-size: 12px; color: var(--text-secondary); }
.ai-loading { display: flex; align-items: center; gap: 12px; padding: 18px 4px; color: var(--text-secondary); font-size: 13px; }
.ai-loading .loading-spinner { width: 20px; height: 20px; }

/* AI 生成的 Markdown 内容 */
.ai-markdown { font-size: 13.5px; line-height: 1.75; color: var(--text-primary); }
.ai-markdown h3 { font-size: 16px; margin: 14px 0 8px; color: var(--text-primary); }
.ai-markdown h4 { font-size: 14.5px; margin: 12px 0 6px; color: var(--accent); }
.ai-markdown h5 { font-size: 13.5px; margin: 10px 0 4px; color: var(--text-primary); }
.ai-markdown p { margin: 6px 0; }
.ai-markdown ul, .ai-markdown ol { margin: 6px 0; padding-left: 22px; }
.ai-markdown li { margin: 4px 0; }
.ai-markdown strong { color: var(--text-primary); font-weight: 600; }

/* ── 20261110b 每日复盘：大模型 Markdown 直出版 ─────────────────────────────
   样式与内容解耦：这里只定义排版容器，不参与任何报告文案；主题色沿用 softDark 变量。 */
.dr-markdown {
  font-size: 14px; line-height: 1.85; color: var(--text-primary);
  background: var(--bg-card, #161B22); border: 1px solid var(--border, #2B3139);
  border-radius: var(--radius, 8px); padding: 22px 26px; margin-top: 12px;
  word-break: break-word;
}
.dr-markdown h2, .dr-markdown h3, .dr-markdown h4,
.dr-markdown h5, .dr-markdown h6 { line-height: 1.4; font-weight: 650; }
.dr-markdown h2 { font-size: 21px; margin: 4px 0 16px; color: var(--text-primary); }
.dr-markdown h3 { font-size: 17px; margin: 26px 0 10px; color: var(--accent, #F0B97B); }
.dr-markdown h4 { font-size: 15px; margin: 20px 0 8px; color: var(--text-primary); }
.dr-markdown h5, .dr-markdown h6 { font-size: 14px; margin: 16px 0 6px; color: var(--text-primary); }
.dr-markdown p { margin: 10px 0; }
.dr-markdown strong { color: var(--text-primary); font-weight: 650; }
.dr-markdown em { color: var(--text-secondary); }
.dr-markdown del { opacity: .65; }
.dr-markdown a { color: var(--accent, #F0B97B); text-decoration: underline; }
.dr-markdown ul, .dr-markdown ol { margin: 10px 0 10px 4px; padding-left: 24px; }
.dr-markdown li { margin: 5px 0; }
.dr-markdown li::marker { color: var(--accent, #F0B97B); }
.dr-markdown blockquote {
  margin: 14px 0; padding: 10px 16px; color: var(--text-secondary);
  background: var(--bg-hover, #1C232C); border-radius: var(--radius-sm, 6px);
}
.dr-markdown hr { border: 0; border-top: 1px solid var(--border, #2B3139); margin: 22px 0; }
.dr-markdown code {
  font-family: var(--num, monospace); font-size: 12.5px;
  background: var(--bg-hover, #1C232C); padding: 1px 5px; border-radius: 4px;
}
.dr-markdown pre {
  background: var(--bg-hover, #1C232C); border: 1px solid var(--border, #2B3139);
  border-radius: var(--radius-sm, 6px); padding: 14px; overflow-x: auto; margin: 14px 0;
}
.dr-markdown pre code { background: none; padding: 0; font-size: 12px; line-height: 1.6; }
.dr-markdown .md-table-wrap { overflow-x: auto; margin: 14px 0; }
.dr-markdown table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dr-markdown th, .dr-markdown td {
  border: 1px solid var(--border, #2B3139); padding: 8px 10px; text-align: left; vertical-align: top;
}
.dr-markdown th { background: var(--bg-hover, #1C232C); color: var(--text-primary); font-weight: 600; white-space: nowrap; }
.dr-markdown td { color: var(--text-secondary); }
.dr-markdown-fallback {
  white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.75;
  background: var(--bg-card, #161B22); padding: 18px; border-radius: var(--radius, 8px);
  border: 1px solid var(--border, #2B3139); color: var(--text-primary);
}
.dr-llm-bar {
  margin-top: 12px; padding: 9px 14px; border-radius: var(--radius-sm, 6px);
  font-size: 12.5px; color: var(--accent, #F0B97B);
  background: rgba(240, 185, 123, .08); border: 1px solid rgba(240, 185, 123, .25);
}
.dr-llm-bar.dr-llm-degraded {
  color: var(--text-secondary); background: var(--bg-hover, #1C232C);
  border-color: var(--border, #2B3139); line-height: 1.6;
}
.dr-llm-bar.dr-llm-legacy { color: var(--text-secondary); background: var(--bg-hover, #1C232C); border-color: var(--border, #2B3139); }
.dr-ver-btn.active { border-color: var(--accent, #F0B97B); color: var(--accent, #F0B97B); }
.ai-sources { margin-top: 14px; padding: 10px 12px; background: var(--bg-hover); border-radius: var(--radius-sm); }
.ai-sources-title { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
.ai-sources ul { margin: 0; padding-left: 18px; }
.ai-sources li { margin: 3px 0; font-size: 12px; word-break: break-all; }
.ai-sources a { color: var(--accent); text-decoration: none; }
.ai-sources a:hover { text-decoration: underline; }
.ai-foot-note { margin-top: 12px; font-size: 11.5px; color: var(--text-light); }

/* AI 设置弹窗 */
.ai-modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.ai-modal-overlay.hidden { display: none; }
.ai-modal {
  width: 460px; max-width: 92vw; background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: 0 12px 40px rgba(0,0,0,0.45); overflow: hidden;
}
.ai-modal-head {
  display: flex; align-items: center; justify-content: space-between; padding: 14px 18px;
  border-bottom: 1px solid var(--border); background: var(--bg-elevated);
}
.ai-modal-head h3 { margin: 0; font-size: 16px; color: var(--text-primary); }
.ai-close { background: none; border: none; color: var(--text-light); font-size: 18px; cursor: pointer; line-height: 1; }
.ai-close:hover { color: var(--text-primary); }
.ai-modal-body { padding: 16px 18px; display: flex; flex-direction: column; gap: 6px; }
.ai-settings-note { font-size: 12.5px; color: var(--text-secondary); line-height: 1.7; margin: 0 0 8px; }
.ai-link { color: var(--accent); }
.ai-modal-body code { background: var(--bg-hover); padding: 1px 6px; border-radius: 4px; font-size: 12px; color: var(--text-primary); }
.ai-field-label { font-size: 12.5px; color: var(--text-secondary); margin-top: 8px; }
.ai-input {
  width: 100%; padding: 9px 11px; background: var(--bg-primary); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: var(--radius-sm); font-size: 13px; outline: none;
}
.ai-input:focus { border-color: var(--accent); }
/* 20260903n：搜索方式对应的厂商 Key 分组（火山/百度），按下拉选择显示；
   注意 .hidden 在本项目不是全局类，必须为新容器单独声明，否则 class="hidden" 无效 */
#aiVolcFields, #aiBaiduFields { display: flex; flex-direction: column; gap: 6px; }
#aiVolcFields.hidden, #aiBaiduFields.hidden { display: none; }
.ai-settings-status { font-size: 12.5px; margin-top: 10px; min-height: 16px; }
.ai-settings-status.ok { color: var(--accent); }
.ai-settings-status.warn { color: var(--accent); }
/* 20260902d：双模型设置弹窗 —— 加宽 + 用途归类图例 + 复选框行 */
.ai-modal-wide { width: 560px; }
.ai-modal-wide .ai-modal-body { max-height: 68vh; overflow-y: auto; }
.ai-cat-legend {
  display: flex; flex-direction: column; gap: 8px; margin-bottom: 6px;
  /* 20261016 UI审计：容器改内嵌深底 —— --bg-hover 过亮，红字标签叠加红底达不到 AA 4.5:1 */
  padding: 10px 12px; background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.ai-cat-row { display: flex; gap: 9px; align-items: flex-start; }
.ai-cat-tag {
  flex: none; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 4px; line-height: 1.6;
}
.ai-cat-tag.web { color: var(--accent); background: rgba(240,185,123,0.10); }
.ai-cat-tag.local { color: var(--accent); background: rgba(240, 185, 123, 0.14); }
.ai-cat-desc { font-size: 12px; line-height: 1.65; color: var(--text-secondary); }
.ai-cat-desc b { color: var(--text-primary); }
.ai-checkbox-row {
  display: flex; gap: 8px; align-items: flex-start; margin-top: 10px;
  font-size: 12.5px; line-height: 1.6; color: var(--text-secondary); cursor: pointer;
}
.ai-checkbox-row input { flex: none; margin-top: 2px; accent-color: var(--accent); cursor: pointer; }
.ai-checkbox-row b { color: var(--text-primary); }
.ai-modal-foot {
  display: flex; justify-content: flex-end; gap: 10px; padding: 12px 18px; border-top: 1px solid var(--border); background: var(--bg-elevated);
}
.btn-primary {
  padding: 8px 16px; background: var(--accent); color: #0B0E11; border: 1px solid var(--accent);
  border-radius: var(--radius-sm); cursor: pointer; font-size: 13px; font-weight: 500;
}
.btn-primary:hover { filter: brightness(1.08); }

/* ===== 首页大盘：四个分组统一收进一个框架（双列） ===== */
.mo-stack { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; background: var(--bg-elevated); }
.mo-row { display: flex; align-items: stretch; gap: 14px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: transparent; }
.mo-row:last-child { border-bottom: none; }
.mo-row.mo-up { box-shadow: inset 3px 0 0 var(--red); }
.mo-row.mo-down { box-shadow: inset 3px 0 0 var(--green); }
.mo-row.mo-cn { box-shadow: inset 3px 0 0 var(--accent); }
.mo-row.mo-us { box-shadow: inset 3px 0 0 #9b8cc9; }
.mo-row.mo-capital-in { box-shadow: inset 3px 0 0 #c9a84c; } /* 主力资金净流入：金色 */
.mo-row.mo-capital-out { box-shadow: inset 3px 0 0 #8b7355; } /* 主力资金净流出：暗金 */
.mo-row-head { flex: 0 0 120px; display: flex; flex-direction: column; justify-content: center; gap: 3px; font-weight: 600; font-size: 13px; color: var(--text-primary); }
.mo-row-head .mo-row-name { line-height: 1.25; }
.mo-row-head .mo-flag { font-size: 16px; }
.mo-src { font-size: 10.5px; font-weight: 400; color: var(--text-light); line-height: 1.3; margin-top: 2px; opacity: 0.95; }
.mo-src.mo-src-warn { color: #ffb74d; opacity: 1; font-weight: 600; }
.mo-count { font-size: 10px; font-weight: 500; color: var(--text-muted); line-height: 1.3; margin-top: 1px; }
.mo-src-date { font-size: 10px; font-weight: 600; color: #ffb74d; background: rgba(255,183,77,0.12); border-radius: 4px; padding: 1px 6px; line-height: 1.4; margin-top: 1px; }
.mo-empty { font-size: 12px; color: var(--text-muted); font-style: italic; padding: 8px 4px; }
.mo-warn { font-size: 12px; line-height: 1.5; color: #ffd9a0; background: rgba(255, 152, 0, 0.12); border: 1px solid rgba(255, 152, 0, 0.35); border-radius: 8px; padding: 10px 12px; margin: 0 16px 12px; }
.mo-warn:empty { display: none; }
.mo-note { font-size: 12px; line-height: 1.5; color: var(--text-light); background: rgba(100, 149, 237, 0.10); border: 1px solid rgba(100, 149, 237, 0.25); border-radius: 8px; padding: 10px 12px; margin: 0 16px 12px; }
.mo-note:empty { display: none; }
.mo-tiles { display: flex; gap: 10px; overflow-x: auto; padding: 2px 2px 6px; flex: 1; align-items: stretch; }
.mo-tiles::-webkit-scrollbar { height: 6px; }
.mo-tiles::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

.mo-tile {
  flex: 0 0 auto;
  min-width: 92px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 10px 12px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  text-align: center;
  transition: transform .15s ease, box-shadow .15s ease, border-color .15s ease;
}
.mo-tile:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0,0,0,0.35);
  border-color: var(--border-strong);
}
.mo-tile.up { background: linear-gradient(180deg, var(--bg-card) 0%, var(--red-soft) 100%); border-color: rgba(246,70,93,0.35); }
.mo-tile.down { background: linear-gradient(180deg, var(--bg-card) 0%, var(--green-soft) 100%); border-color: rgba(14,203,129,0.35); }
.mo-tile.flat { opacity: 0.92; }
.mo-tile .mo-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.25;
  white-space: nowrap;
}
.mo-tile .mo-price {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
  letter-spacing: -0.01em;
}
.mo-tile .mo-chg {
  font-size: 12px;
  font-weight: 600;
  line-height: 1.2;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--bg-elevated);
}
.mo-tile.up .mo-chg { background: var(--red-light); color: var(--red); font-weight: 700; }
.mo-tile.down .mo-chg { background: var(--green-light); color: var(--green); font-weight: 700; }
.mo-tile.flat .mo-chg { color: var(--text-muted); }

.mo-sw-level {
  display: inline-block;
  margin-left: 4px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 500;
  line-height: 14px;
  color: var(--text-muted);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 3px;
  vertical-align: middle;
}
/* 当日最多涨停/跌停板块卡（20261015l）：name 行右侧的金色小标签，与卡片方向色无关 */
.mo-limit-tag {
  display: inline-block;
  margin-left: 5px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  color: var(--accent);
  background: var(--accent-light);
  border: 1px solid rgba(240, 185, 123, 0.35);
  border-radius: 3px;
  vertical-align: middle;
  white-space: nowrap;
}
/* 美债10年期收益率卡（20261021a）：与道指/纳指/标普同处一行，但量纲不同——
   主值是收益率%（配 bp 变动），不是指数点位。用金色描边与「日线·MM-DD」小标签与三个指数卡区分，
   标签同时承担"这不是实时行情"的告知责任（数据源为美国财政部日度收益率曲线）。 */
.mo-tile.bond { border-color: rgba(240, 185, 123, 0.35); }
.mo-tile.bond .mo-price { font-variant-numeric: tabular-nums; }
/* 可点击卡片（20261021b）：整卡是 <a>，必须抹掉链接的默认蓝字下划线，否则卡片文字全变蓝；
   ↗ 角标说明「可跳转」，hover 时加深描边强化可点感。 */
a.mo-tile-link,
a.mo-tile-link:hover,
a.mo-tile-link:visited {
  text-decoration: none;
  color: inherit;
  position: relative;
  cursor: pointer;
}
a.mo-tile-link:hover { border-color: var(--accent); }
.mo-link-mark {
  position: absolute;
  top: 4px;
  right: 6px;
  font-size: 10px;
  line-height: 1;
  color: var(--accent);
  opacity: 0.75;
}
a.mo-tile-link:hover .mo-link-mark { opacity: 1; }
.mo-bond-tag {
  display: inline-block;
  margin-left: 5px;
  padding: 0 4px;
  font-size: 9.5px;
  font-weight: 500;
  line-height: 14px;
  color: var(--accent);
  background: var(--accent-light);
  border: 1px solid rgba(240, 185, 123, 0.3);
  border-radius: 3px;
  vertical-align: middle;
  white-space: nowrap;
}
/* 近一周高频板块提醒卡片槽位：与 .mo-tiles 内 Top5 卡片同处一行（不改变既有 flex 布局） */
.mo-tiles-reminder {
  display: contents;
}

@media (max-width: 760px) {
  .mo-row { flex-direction: column; gap: 10px; }
  .mo-row-head { flex-basis: auto; flex-direction: row; gap: 6px; align-items: center; }
  .mo-tile { min-width: 84px; padding: 9px 10px; }
}

/* ===== 首页大盘/板块 AI 解读摘要条（单行省略，悬停看全文） ===== */
.mo-ai-bar {
  overflow: hidden;
  background: rgba(100, 130, 255, 0.06);
  border-bottom: 1px dashed var(--border);
  position: relative;
  min-height: 28px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 4px 32px;
}
.mo-ai-bar::before { content: '✨'; position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 12px; }
.mo-ai-text {
  font-size: 12.5px;
  color: var(--text-secondary);
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.mo-ai-bar:hover { background: rgba(100, 130, 255, 0.10); }

/* ===== 公司概况：产品/客户简介（替代密集主营业务） ===== */
.cp-products { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.cp-products-title { font-size: 12.5px; color: var(--text-secondary); margin: 10px 0 8px; font-weight: 600; }
.cp-products-title:first-child { margin-top: 0; }
.cp-prod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr)); gap: 10px; }
.cp-prod { display: flex; flex-direction: column; gap: 4px; }
.cp-prod-img { position: relative; height: 84px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.cp-prod-img img { width: 100%; height: 100%; object-fit: cover; }
.cp-prod-ph { font-size: 22px; opacity: 0.5; }
.cp-prod-name { font-size: 12px; color: var(--text-primary); text-align: center; line-height: 1.3; }
.cp-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.cp-chip { background: var(--bg-card); border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; font-size: 12.5px; color: var(--text-primary); }

/* ===== 公司深度分析（CFA 七段统一输出） ===== */
.company-deep-body { display: flex; flex-direction: column; gap: 4px; line-height: 1.6; }
.cd-sec { font-size: 14px; font-weight: 700; color: var(--accent); margin: 16px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.cd-sec:first-child { margin-top: 0; }
.cd-block-title { font-size: 13px; font-weight: 600; color: var(--text-secondary); margin: 12px 0 8px; }

/* 置顶风险提示 */
.cd-topwarn { background: var(--accent-light); border: 1px solid rgba(240,185,123,0.45); border-left: 4px solid var(--accent); border-radius: 0 8px 8px 0; padding: 10px 14px; font-size: 13px; font-weight: 700; color: var(--accent); margin-bottom: 14px; }
.cd-topwarn-body { margin-top: 6px; font-weight: 400; color: var(--text-primary); display: flex; flex-direction: column; gap: 4px; }

/* 一句话定位 / 摘要 */
.cd-oneliner { font-size: 14px; font-weight: 600; color: var(--text-primary); background: var(--bg-elevated); border-left: 3px solid var(--accent); border-radius: 0 8px 8px 0; padding: 10px 14px; margin-bottom: 10px; }
.cd-summary { font-size: 13px; color: var(--text-primary); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; line-height: 1.65; }

/* 代码判定 flags 芯片 */
.cd-flags { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
.cd-flag { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid transparent; }
.cd-flag-danger { background: var(--accent-light); color: var(--accent); border-color: rgba(240,185,123,0.4); }
.cd-flag-warn { background: rgba(240,185,123,0.16); color: var(--accent); border-color: rgba(240,185,123,0.4); }
.cd-flag-good{ background: var(--red-light); color: var(--red); border-color: rgba(246,70,93,0.35); }

/* 键值对表 */
.cd-bi { display: flex; flex-direction: column; gap: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--bg-card); }
.cd-bi-row { display: flex; align-items: flex-start; gap: 10px; padding: 7px 12px; font-size: 13px; border-bottom: 1px solid var(--border); }
.cd-bi-row:last-child { border-bottom: none; }
.cd-k { flex: 0 0 108px; color: var(--text-secondary); }
.cd-k2 { flex: 0 0 76px; color: var(--text-secondary); font-size: 12px; }
.cd-v { flex: 1; min-width: 0; color: var(--text-primary); word-break: break-word; }
.cd-muted { color: var(--text-secondary); font-size: 12.5px; }
.cd-warn { color: #F0B97B; }

/* 产品与服务卡片 */
.cd-prod-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.cd-prod { border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--bg-card); display: flex; flex-direction: column; padding-bottom: 10px; }
.cd-prod-img { position: relative; height: 112px; background: var(--bg-elevated); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.cd-prod-img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cd-ph { font-size: 26px; opacity: 0.4; }
.cd-prod-name { font-size: 13px; font-weight: 600; color: var(--text-primary); padding: 8px 10px 0; }
.cd-prod-share { font-size: 12px; color: var(--accent); padding: 3px 10px 0; }
.cd-prod-line { font-size: 12px; color: var(--text-secondary); padding: 3px 10px 0; line-height: 1.5; }
.cd-prod-line b { color: var(--text-primary); font-weight: 600; }
.cd-imgnote { font-size: 11.5px; color: var(--text-secondary); padding: 4px 10px 0; line-height: 1.45; font-style: italic; }

/* 芯片 */
.cd-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.cd-chip { background: var(--bg-card); border: 1px solid var(--border); border-radius: 999px; padding: 3px 12px; font-size: 12.5px; color: var(--text-primary); }

/* 统计条 */
.cd-stat-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 8px 0; }
.cd-stat { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 9px 12px; display: flex; flex-direction: column; gap: 4px; }
.cd-stat-l { font-size: 12px; color: var(--text-secondary); }
.cd-stat-v { font-size: 14.5px; font-weight: 600; color: var(--text-primary); }

/* 事件时间线 */
.cd-events { display: flex; flex-direction: column; gap: 8px; }
.cd-event { display: flex; gap: 12px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-card); }
.cd-ev-date { flex: 0 0 84px; font-size: 12.5px; font-weight: 700; color: var(--accent); }
.cd-ev-body { flex: 1; min-width: 0; }
.cd-ev-head { display: flex; align-items: center; gap: 8px; margin-bottom: 3px; }
.cd-ev-cat { font-size: 11.5px; color: var(--text-secondary); background: var(--bg-elevated); border-radius: 6px; padding: 1px 8px; }
.cd-ev-lv { font-size: 11.5px; padding: 1px 8px; border-radius: 6px; }
.cd-ev-lv-high { background: var(--accent-light); color: var(--accent); }
.cd-ev-lv-mid { background: rgba(240,185,123,0.16); color: var(--accent); }
.cd-ev-lv-low { background: var(--bg-elevated); color: var(--text-secondary); }
.cd-ev-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.cd-ev-desc { font-size: 12.5px; color: var(--text-secondary); margin-top: 3px; line-height: 1.55; }
.cd-ev-impact { font-size: 12px; color: var(--text-primary); margin-top: 5px; background: var(--bg-elevated); border-radius: 6px; padding: 4px 8px; }

/* 产业链位置徽章 */
.cd-pos { display: inline-block; padding: 2px 12px; border-radius: 999px; font-weight: 600; font-size: 13px; }
.cd-pos-up { background: var(--accent-light); color: var(--accent); }
.cd-pos-down { background: var(--accent-light); color: var(--accent); }
.cd-pos-mid { background: rgba(240,185,123,0.16); color: var(--accent); }
.cd-pos-neutral { background: var(--bg-elevated); color: var(--text-secondary); }

/* 原材料 / 供应商 */
.cd-mats { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.cd-mat { display: flex; gap: 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px; background: var(--bg-card); }
.cd-mat-img { position: relative; flex: 0 0 72px; height: 72px; background: var(--bg-elevated); border-radius: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.cd-mat-img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cd-mat-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.cd-mat-name { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.cd-mat-line { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; color: var(--text-primary); }

/* 表格 */
.cd-table-wrap { overflow-x: auto; margin: 8px 0; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.cd-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.cd-table th { background: var(--bg-elevated); color: var(--text-secondary); font-weight: 600; text-align: left; padding: 8px 12px; white-space: nowrap; border-bottom: 1px solid var(--border); }
.cd-table td { padding: 8px 12px; color: var(--text-primary); border-bottom: 1px solid var(--border); }
.cd-table tbody tr:last-child td { border-bottom: none; }
.cd-table tbody tr:hover { background: rgba(255,255,255,0.02); }

.cd-note { font-size: 12.5px; color: var(--text-secondary); background: var(--bg-elevated); border-radius: var(--radius-sm); padding: 8px 12px; line-height: 1.6; margin: 6px 0; }

/* 成本控制方法 */
.cd-ctrl { display: flex; flex-direction: column; gap: 8px; }
.cd-ctrl-item { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 9px 12px; background: var(--bg-card); font-size: 13px; color: var(--text-primary); }
.cd-ctrl-type { flex: 0 0 auto; font-size: 12px; color: var(--accent); background: rgba(240,185,123,0.14); border-radius: 6px; padding: 2px 9px; white-space: nowrap; }

/* 结论条（风险等级） */
.cd-concl { border-radius: var(--radius-sm); padding: 10px 14px; font-size: 13px; line-height: 1.6; margin-top: 10px; border: 1px solid transparent; }
.cd-concl-high{ background: rgba(240,185,123,0.16); border-color: rgba(240,185,123,0.5); color: var(--text-primary); }
.cd-concl-mid { background: rgba(240,185,123,0.12); border-color: rgba(240,185,123,0.4); color: var(--text-primary); }
.cd-concl-low{ background: rgba(240,185,123,0.06); border-color: rgba(240,185,123,0.28); color: var(--text-primary); }
.cd-concl b { color: var(--text-primary); }

/* 竞争对手 */
.cd-comps { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
.cd-comp { border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-card); padding: 12px; display: flex; flex-direction: column; gap: 6px; }
.cd-comp-img { position: relative; height: 72px; background: var(--bg-elevated); border-radius: 8px; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.cd-comp-img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.cd-comp-name { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.cd-comp-line { font-size: 12.5px; color: var(--text-secondary); }
.cd-comp-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.cd-tag { font-size: 11.5px; color: var(--text-secondary); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; }
.cd-tag-ps { color: var(--accent); border-color: rgba(240,185,123,0.35); }

.cd-graph { font-size: 13px; color: var(--text-primary); background: var(--bg-elevated); border: 1px dashed var(--border); border-radius: var(--radius-sm); padding: 12px 14px; line-height: 1.7; white-space: pre-wrap; }

/* 列表 */
.cd-list { margin: 6px 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
.cd-list li { font-size: 13px; color: var(--text-primary); line-height: 1.55; }
.cd-list-warn li { color: #F0B97B; }

.cd-foot { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--text-secondary); line-height: 1.6; }

@media (max-width: 760px) {
  .cd-prod-grid, .cd-mats, .cd-comps { grid-template-columns: 1fr; }
  .cd-k { flex: 0 0 88px; }
  .cd-ev-date { flex: 0 0 68px; }
}


/* 深度分析新增小节（第3/4/5/24/25节） */
.data-empty { padding: 24px; text-align: center; color: var(--text-secondary); font-size: 13px; line-height: 1.7; background: var(--bg-elevated); border-radius: var(--radius-sm); }
.cc-products h4, .cc-futures h4, .cc-note h4 { font-size: 13px; margin: 14px 0 8px; color: var(--text-primary); }
.cc-prod-item { display: inline-block; margin: 0 8px 8px 0; padding: 5px 12px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 14px; font-size: 13px; color: var(--text-primary); }
.cc-futures p, .cc-note p { font-size: 13px; color: var(--text-secondary); line-height: 1.7; margin: 0; }
.research-list { display: flex; flex-direction: column; gap: 10px; max-height: 460px; overflow: auto; }
.research-item { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; background: var(--bg-card); }
.research-title { font-size: 13px; font-weight: 600; color: var(--text-primary); line-height: 1.5; }
.research-meta { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 6px; font-size: 12px; color: var(--text-secondary); }
.research-meta .research-rating, .research-meta .research-target{ color: var(--accent); font-weight: 600; }
.research-sub { margin-top: 4px; font-size: 12px; color: var(--text-secondary); }
.annc-flagged h4 { font-size: 13px; margin: 4px 0 10px; color: var(--text-primary); }
.annc-group h4 { font-size: 13px; margin: 10px 0 6px; color: var(--text-primary); }
.annc-group { margin-bottom: 12px; }
.annc-item { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 8px 10px; border-bottom: 1px solid var(--border); font-size: 13px; }
.annc-item.annc-flag{ background: rgba(240,185,123,0.08); }
.annc-head { display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }
.annc-date { color: var(--text-secondary); flex: 0 0 92px; }
.annc-title { flex: 1; color: var(--text-primary); }
.annc-title-link { flex: 1; color: var(--text-primary); text-decoration: underline; cursor: pointer; }
.annc-title-link:hover{ color: var(--accent); }
.annc-tag { flex: 0 0 auto; padding: 2px 8px; border-radius: 10px; background: var(--accent); color: #0B0E11; font-weight: 600; font-size: 11px; }
.annc-parsed { width: 100%; font-size: 11px; color: var(--text-light); opacity: 0.95; margin-top: 2px; }
.annc-source { font-size: 11px; color: var(--text-light); opacity: 0.9; margin-top: 10px; }
.annc-note { font-size: 13px; color: var(--text-secondary); padding: 10px 0; }
.annc-all { margin-top: 12px; font-size: 13px; }
.annc-all summary { cursor: pointer; color: var(--text-secondary); }
.annc-all .annc-item { font-size: 12px; }
.annc-list { list-style: none; margin: 0; padding: 0; }
.annc-type { flex: 0 0 auto; padding: 1px 8px; border-radius: 10px; background: var(--bg-hover); color: var(--text-secondary); font-size: 11px; border: 1px solid var(--border); white-space: nowrap; }
.annc-link { flex: 0 0 auto; color: var(--accent); text-decoration: none; font-size: 12px; white-space: nowrap; }
.annc-link:hover { text-decoration: underline; }
.sh-stats-note { margin-top: 12px; padding: 10px 12px; background: var(--bg-card); border-radius: 8px; font-size: 12px; color: var(--text-secondary); }

/* 东方财富妙想 AI 综述（研报/公告补充） */
.mx-summary { margin-top: 14px; padding: 12px 14px; background: linear-gradient(135deg, rgba(214,48,49,0.06), rgba(64,120,200,0.06)); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.mx-summary-head { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; }
.mx-summary-body { font-size: 12px; color: var(--text-secondary); line-height: 1.75; }
.mx-summary-body p { margin: 0 0 6px; }
.mx-summary-body p:last-child { margin-bottom: 0; }
.mx-summary-foot { margin-top: 8px; font-size: 11px; color: var(--text-muted); }
.mx-stale-note { margin-top: 8px; padding: 7px 10px; font-size: 11.5px; line-height: 1.5; color: #F0B97B; background: rgba(240, 185, 123, 0.1); border: 1px solid rgba(240, 185, 123, 0.35); border-radius: var(--radius-sm); }
.ai-trigger-btn { margin-top: 10px; padding: 8px 16px; font-size: 12px; color: #0B0E11; background: var(--brand); border: none; border-radius: var(--radius-sm); cursor: pointer; font-weight: 600; transition: filter .15s, opacity .15s; }
.ai-trigger-btn:hover { filter: brightness(1.08); }
.ai-trigger-btn:disabled { opacity: .55; cursor: progress; }
.ai-hint { display: inline-block; margin-top: 8px; font-size: 11px; color: var(--text-muted); line-height: 1.6; }
.sh-stats-note b { color: var(--text-primary); }
.sh-stats-main { margin-bottom: 4px; }
.sh-stats-sub { font-size: 11px; color: var(--text-light); opacity: 0.9; }
.sh-source { margin-top: 8px; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
.sh-source::before { content: 'ℹ️ '; }

/* 20260929a：股东户数走势「叠加股价走势」开关 */
.sh-toggle { font-size: 12px; font-weight: 400; color: var(--text-secondary); margin-left: 10px; cursor: pointer; user-select: none; vertical-align: middle; }
.sh-toggle input { width: 13px; height: 13px; vertical-align: middle; margin-right: 4px; cursor: pointer; accent-color: #F0B97B; }

/* ===== 当日涨跌判断卡片 ===== */
.sameday-card { border: 1px solid var(--border); }
.sameday-card .score-label { display: flex; align-items: center; flex-wrap: wrap; }
.sameday-subtitle { font-size: 11px; color: var(--text-muted); margin: 2px 0 0; line-height: 1.4; }
.sameday-card .sameday-badge { font-size: 10px; font-weight: 600; padding: 1px 7px; border-radius: 10px; margin-left: 6px; vertical-align: middle; }
.sameday-badge.conf-high { background: rgba(139,148,158,.18); color: var(--text-secondary); }
.sameday-badge.conf-mid { background: rgba(230,160,40,.18); color: #f0a830; }
.sameday-badge.conf-low { background: rgba(150,160,180,.18); color: #aab2c0; }
.sameday-verdict.strong-bullish { color: var(--red); }
.sameday-verdict.strong-bearish { color: var(--green); }
.sameday-verdict.neutral { color: var(--text-secondary); }
.sameday-accuracy { margin-top: 8px; font-size: 11px; color: var(--text-muted); line-height: 1.5; }
.sameday-accuracy.sameday-acc-warn { color: var(--accent); font-weight: 600; }
/* 20260821f：财报事件→资料库同步状态提示（一致性） */
.sameday-report-sync { margin-top: 6px; font-size: 11px; line-height: 1.5; padding: 4px 8px; border-radius: 6px; }
.sameday-report-sync.sync-ok { color: var(--text-secondary); background: rgba(255,255,255,0.05); }
.sameday-report-sync.sync-gap { color: var(--amber); background: rgba(245, 158, 11, 0.1); }
.sameday-logic-btn { margin-top: 8px; margin-bottom: 4px; }
.sameday-logic { margin-top: 8px; }

.sd-logic-box { border-top: 1px dashed var(--border); padding-top: 8px; }
.sd-logic-title { font-size: 12px; font-weight: 600; color: var(--text-primary); margin-bottom: 6px; }
.sd-factor { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.05); }
.sd-factor-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; }
.sd-factor-name { font-weight: 600; color: var(--text-primary); }
.sd-impact { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 9px; margin-left: 6px; flex: 0 0 auto; white-space: nowrap; }
.sd-impact.pos { color: var(--red); background: var(--tint-red); border: 1px solid rgba(246,70,93,0.4); }
.sd-impact.neg { color: var(--green); background: var(--tint-green); border: 1px solid rgba(14,203,129,0.4); }
.sd-impact.neu { color: #aab2c0; background: rgba(150,160,180,0.16); border: 1px solid rgba(150,160,180,0.35); }
/* 20260906：板块跷跷板专用——子卡片「负相关」标注（黄色）与因子标题「负相关」高亮 */
.sd-impact.rel { color: #e0b45c; background: rgba(224,180,92,0.14); border: 1px solid rgba(224,180,92,0.4); }
.sd-rel-hl { color: #e0b45c; }
.sd-factor-signal.pos { color: var(--red); }
.sd-factor-signal.neg { color: var(--green); }
.sd-factor-signal.neu { color: #aab2c0; }
.sd-factor-w { font-size: 11px; color: var(--text-muted); }
.sd-factor-contrib { font-size: 11px; font-weight: 600; }
.sd-factor-contrib.pos { color: var(--red); }
.sd-factor-contrib.neg { color: var(--green); }
.sd-factor-detail { font-size: 11px; color: var(--text-secondary); margin-top: 2px; line-height: 1.5; }
.sd-factor-val { font-size: 11px; color: var(--text-muted); margin-top: 1px; }
.sd-factor-val-summary { font-size: 12px; color: var(--text-primary); margin-top: 2px; }
.sd-factor-caption { font-size: 10px; color: var(--text-muted); margin-top: 6px; line-height: 1.4; }
.sd-weight-note { font-size: 10px; color: var(--text-muted); margin-top: 6px; }
.sd-settle { margin-top: 6px; font-size: 11px; padding: 5px 8px; border-radius: 6px; }
.sd-settle:not(.sd-pending) { background: rgba(139,148,158,.12); color: var(--text-secondary); }
.sd-settle.sd-pending { background: rgba(150,160,180,.12); color: #aab2c0; }
.sd-actions { margin-top: 8px; }

/* ===== 短期行情判断逻辑：重构（主导因子优先 · 紧凑横向条） ===== */
.sd-summary { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.sd-verdict-pill { font-size: 13px; font-weight: 700; padding: 4px 12px; border-radius: 999px; line-height: 1; white-space: nowrap; }
.sd-verdict-pill.bull { background: rgba(246,70,93,.16); color: var(--red); border: 1px solid rgba(246,70,93,.35); }
.sd-verdict-pill.bear { background: rgba(14,203,129,.16); color: var(--green); border: 1px solid rgba(14,203,129,.35); }
.sd-verdict-pill.neu  { background: rgba(150,160,180,.16); color: #aab2c0; border: 1px solid rgba(150,160,180,.35); }
.sd-summary-meta { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text-muted); flex-wrap: wrap; }
.sd-summary-meta b { color: var(--text-primary); font-weight: 700; }
.sd-conf { padding: 1px 8px; border-radius: 10px; font-weight: 600; }
.sd-conf.conf-high { background: rgba(139,148,158,.18); color: var(--text-secondary); }
.sd-conf.conf-mid  { background: rgba(230,160,40,.18); color: #f0a830; }
.sd-conf.conf-low  { background: rgba(150,160,180,.18); color: #aab2c0; }

.sd-drivers { display: flex; flex-direction: column; gap: 4px; }
.sd-factor-row { border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: rgba(255,255,255,.02); }
.sd-factor-row.is-hidden { display: none; }
.sd-factor-toggle { width: 100%; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; padding: 7px 10px; background: transparent; border: 0; cursor: pointer; text-align: left; color: var(--text-primary); font-size: 12px; }
/* 20261025i 自适应：文本不收缩不截断、条形弹性收缩；空间不足时数字组整体换行到第二行 */
.sd-factor-toggle .sd-factor-name { flex: 0 1 auto; min-width: 0; }
.sd-factor-toggle .sd-bar-track { flex: 1 1 72px; min-width: 48px; }
.sd-factor-toggle .sd-factor-w, .sd-factor-toggle .sd-factor-contrib, .sd-factor-toggle .sd-impact { flex: 0 0 auto; white-space: nowrap; }
.sd-factor-toggle:hover { background: rgba(255,255,255,.04); }
.sd-dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 auto; }
.sd-dot.pos { background: var(--red); box-shadow: 0 0 0 3px rgba(246,70,93,.18); }
.sd-dot.neg { background: var(--green); box-shadow: 0 0 0 3px rgba(14,203,129,.18); }
.sd-dot.neu { background: #aab2c0; box-shadow: 0 0 0 3px rgba(150,160,180,.18); }
.sd-factor-name { font-weight: 600; flex: 0 0 auto; min-width: 84px; }
.sd-bar-track { position: relative; flex: 1 1 auto; height: 6px; border-radius: 3px; background: rgba(255,255,255,.06); min-width: 56px; }
.sd-bar-track::after { content: ""; position: absolute; left: 50%; top: -1px; bottom: -1px; width: 1px; background: rgba(255,255,255,.18); } /* 中线，区分多/空方向 */
.sd-bar { position: absolute; top: 0; height: 6px; border-radius: 3px; }
.sd-bar.pos { background: linear-gradient(90deg, rgba(246,70,93,.45), var(--red)); }
.sd-bar.neg { background: linear-gradient(90deg, var(--green), rgba(14,203,129,.45)); }
.sd-factor-w { font-size: 11px; color: var(--text-muted); flex: 0 0 auto; }
.sd-factor-contrib { font-size: 11px; font-weight: 700; flex: 0 0 auto; min-width: 42px; text-align: right; }
.sd-factor-contrib.pos { color: var(--red); }
.sd-factor-contrib.neg { color: var(--green); }
.sd-chevron { flex: 0 0 auto; color: var(--text-muted); transition: transform .2s ease; font-size: 10px; }
.sd-factor-toggle.is-open .sd-chevron { transform: rotate(180deg); }
.sd-factor-body { display: none; padding: 2px 10px 9px 26px; border-top: 1px solid rgba(255,255,255,.05); }
.sd-factor-body.is-open { display: block; }
.sd-factor-body .sd-factor-detail { font-size: 11px; color: var(--text-secondary); margin-top: 4px; line-height: 1.5; }
.sd-factor-body .sd-factor-val { font-size: 11px; color: var(--text-muted); margin-top: 2px; }
.sd-expand-btn { margin-top: 6px; background: transparent; border: 1px dashed var(--border); color: var(--text-secondary); font-size: 11px; padding: 5px 10px; border-radius: 8px; cursor: pointer; width: 100%; transition: background .15s ease, color .15s ease; }
.sd-expand-btn:hover { background: rgba(255,255,255,.04); color: var(--text-primary); }
.sd-expand-btn.is-expanded { border-style: solid; }

/* ===== 短期行情判断：子维度指标卡片（用于市场情绪等含多子维度因子） ===== */
.sd-sub-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; margin-top: 6px; }
.sd-sub-card { background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.06); border-radius: 8px; padding: 8px 10px; transition: background .15s ease, border-color .15s ease; }
.sd-sub-card:hover { background: rgba(255,255,255,.05); border-color: rgba(255,255,255,.10); }
.sd-sub-head { display: flex; align-items: center; flex-wrap: wrap; gap: 3px 6px; margin-bottom: 4px; }
/* 20261025i：子卡片头部自适应——名称可收缩换行，徽章/权重数字不截断 */
.sd-sub-head .sd-sub-name { flex: 0 1 auto; min-width: 0; }
.sd-sub-head .sd-dot { width: 7px; height: 7px; box-shadow: none; }
.sd-sub-name { font-size: 12px; font-weight: 600; color: var(--text-primary); }
/* 20261025h：子卡片头部「权重 ±X% / 得分」——沿用因子行数字类，缩小并去右对齐 min-width */
.sd-sub-head .sd-factor-w { font-size: 10.5px; flex: 0 0 auto; white-space: nowrap; }
.sd-sub-head .sd-factor-contrib { font-size: 10.5px; min-width: 0; text-align: left; flex: 0 0 auto; white-space: nowrap; }
.sd-sub-value { font-size: 13px; font-weight: 700; margin-bottom: 3px; line-height: 1.3; }
.sd-sub-value.pos { color: var(--red); }
.sd-sub-value.neg { color: var(--green); }
.sd-sub-value.neu { color: #aab2c0; }
.sd-sub-detail { font-size: 11px; color: var(--text-muted); line-height: 1.45; }

/* ===== 行业分析页 ===== */
.industry-content { display: flex; flex-direction: column; gap: 16px; }

.policy-badge { display: inline-block; padding: 3px 12px; border-radius: 12px; font-size: 12px; font-weight: 600; border: 1px solid transparent; }
.policy-support { background: var(--tint-red); color: var(--red); border-color: rgba(246,70,93,0.4); }
.policy-restrict { background: var(--tint-green); color: var(--green); border-color: rgba(14,203,129,0.4); }
.policy-neutral { background: rgba(148,163,184,0.16); color: var(--text-secondary); border-color: rgba(148,163,184,0.4); }

.ind-info-body { display: flex; flex-direction: column; gap: 0; padding: 4px 0; }
.ind-info-row { display: flex; align-items: baseline; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.ind-info-row:last-child { border-bottom: none; }
.ind-info-label { flex: 0 0 200px; color: var(--text-secondary); font-size: 13px; }
.ind-info-value { flex: 1; color: var(--text-primary); font-size: 14px; font-weight: 600; }

.policy-body { display: flex; flex-direction: column; gap: 18px; padding: 4px 0; }
.policy-section { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px 16px; }
.policy-subtitle { font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 10px; }
.policy-plans { margin: 0; padding-left: 20px; color: var(--text-secondary); font-size: 13px; line-height: 1.9; }
.policy-summary { font-size: 13px; color: var(--text-secondary); line-height: 1.8; }
.policy-note { font-size: 12px; color: var(--text-secondary); background: rgba(245,158,11,0.08); border-left: 3px solid var(--amber); padding: 8px 12px; border-radius: 4px; line-height: 1.7; }
.policy-source { font-size: 11px; color: var(--text-light); margin-top: 10px; opacity: 0.9; }

/* ===== 行情判断记录 · 准确率核对页（judgments.html） ===== */
.jd-page { max-width: 1080px; margin: 0 auto; padding: 22px 20px 60px; }
.jd-header { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.jd-title { font-size: 21px; font-weight: 700; color: var(--text-primary); margin: 0; }
.jd-actions { display: flex; align-items: center; gap: 10px; }

/* 20261025f：.jd-toolbar / .jd-tag 样式已并入文末「独立长页统一外壳」——与 .np-toolbar / .acc-toolbar / .np-tab / .acc-tab 统一为同一套工具条与芯片 */
.jd-filter { padding: 8px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-card); color: var(--text-primary); min-width: 240px; font-size: 13px; }
.jd-filter:focus { outline: none; border-color: var(--accent); }
.jd-filter-tags { display: flex; gap: 8px; flex-wrap: wrap; }
.rc { font-size: 12px; color: var(--text-muted); margin-left: auto; }

.acc-body { margin-top: 8px; }
.acc-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; }
.acc-cell { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
.acc-cell.acc-primary { grid-column: 1 / -1; }
.acc-cell-label { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
.acc-cell-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 15px; }
.acc-store { color: var(--text-primary); font-weight: 700; }
.acc-vs { color: var(--text-light); font-size: 11px; }
.acc-fe { color: var(--text-primary); font-weight: 700; }
.acc-verify { margin-top: 12px; padding: 10px 14px; border-radius: 8px; font-size: 13px; line-height: 1.6; }
.acc-verify.ok { background: rgba(246,70,93,.10); color: var(--red); border: 1px solid rgba(246,70,93,.3); }
.acc-verify.bad { background: rgba(14,203,129,.10); color: var(--green); border: 1px solid rgba(14,203,129,.32); }
.acc-denom { font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; line-height: 1.6; }
.acc-denom b { color: var(--text-primary); }
.acc-basis { font-size: 12px; color: var(--text-muted); margin-bottom: 12px; line-height: 1.6; }
.acc-basis b { color: var(--text-secondary); }
.acc-overdue-num { color: var(--accent); font-weight: 600; }
.acc-overdue-warn { background: rgba(240,185,123,.10); color: var(--accent); border: 1px solid rgba(240,185,123,.32); padding: 10px 14px; border-radius: 8px; font-size: 13px; line-height: 1.6; margin-bottom: 12px; }
.acc-overdue-warn b { color: #ff6b6b; }

.jd-match { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 10px; white-space: nowrap; }
.jd-match.jd-ok { background: rgba(246,70,93,.15); color: var(--red); }
.jd-match.jd-bad { background: rgba(14,203,129,.18); color: var(--green); }

.record-list { display: flex; flex-direction: column; gap: 12px; margin-top: 8px; }
.jd-rec { background: var(--bg-card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.jd-rec.jd-rec-mismatch{ border-color: rgba(240,185,123,.55); }
.jd-rec-head { display: flex; flex-direction: column; align-items: stretch; gap: 7px; padding: 13px 14px; cursor: pointer; }
.jd-rec-head:hover { background: var(--bg-hover); }
.jd-rec-row1 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.jd-rec-row2 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px; color: var(--text-secondary); }
.jd-rec-row3 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; padding: 6px 10px; border-radius: 8px; background: var(--bg-elevated); }
.jd-rec-row4 { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--text-secondary); border-top: 1px dashed var(--border); padding-top: 8px; }
.jd-rec-name { font-size: 16px; font-weight: 700; color: var(--text-primary); }
.jd-rec-code { font-size: 12px; color: var(--text-muted); }
.jd-rec-ind { font-size: 11px; color: var(--text-secondary); background: var(--bg-elevated); padding: 1px 8px; border-radius: 10px; }
.jd-wl-badge { font-size: 11px; font-weight: 700; color: #f0b429; background: rgba(240,180,41,.16); padding: 1px 8px; border-radius: 10px; }
.jd-rec.jd-rec-wl { border-color: rgba(240,180,41,.5); }
.jd-rec-date b, .jd-rec-target b { color: var(--text-primary); font-weight: 700; }
/* 20260928c：准确率页「各股」聚合卡的判断日期行（最新判断日 + 数据区间） */
.jd-rec-dates { font-size: 12px; color: var(--text-muted); }

/* 结论区 */
.jd-concl { font-weight: 700; padding: 2px 10px; border-radius: 12px; font-size: 13px; }
.jd-concl.jd-hit { color: var(--red); background: rgba(246,70,93,.14); }
.jd-concl.jd-miss { color: var(--green); background: rgba(14,203,129,.14); }
.jd-concl.jd-wait { color: #e0a93b; background: rgba(224,169,59,.14); }
.jd-concl-sub { color: var(--text-secondary); }
.jd-concl-sub b { font-weight: 700; }
.jd-concl-basis { font-size: 11px; color: var(--text-muted); }

/* 判断逻辑摘要 */
.jd-reason-label { color: var(--text-secondary); font-weight: 600; }
.jd-reason { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.jd-reason-item { white-space: nowrap; }
.jd-reason-item b { color: var(--text-primary); font-weight: 600; }
.jd-reason-sep { color: var(--text-muted); margin: 0 6px; }
.jd-caret { margin-left: auto; color: var(--text-muted); font-size: 12px; white-space: nowrap; }
.jd-verdict { font-weight: 700; padding: 2px 10px; border-radius: 12px; }
.jd-verdict.jd-bull { color: var(--red); background: rgba(246,70,93,.12); }
.jd-verdict.jd-bear { color: var(--green); background: rgba(14,203,129,.12); }
.jd-verdict.jd-flat { color: var(--text-secondary); background: var(--bg-elevated); }
.jd-rec-score { font-weight: 600; color: var(--text-primary); }
.jd-conf { font-size: 11px; padding: 1px 7px; border-radius: 10px; }
.jd-conf.jd-conf-high { background: rgba(139,148,158,.18); color: var(--text-secondary); }
.jd-conf.jd-conf-mid { background: rgba(230,160,40,.18); color: #f0a830; }
.jd-conf.jd-conf-low { background: rgba(150,160,180,.18); color: #aab2c0; }
.jd-status { font-size: 11px; padding: 1px 8px; border-radius: 10px; }
.jd-status.jd-settled { background: rgba(139,148,158,.12); color: var(--text-secondary); }
.jd-status.jd-pending { background: rgba(150,160,180,.12); color: #aab2c0; }
.jd-warn { font-size: 11px; font-weight: 700; color: var(--accent); background: rgba(240,185,123,.16); padding: 1px 8px; border-radius: 10px; }
.jd-caret { color: var(--text-muted); font-size: 12px; }

/* 135 格综合判定（20261107）：头徽标 + 展开明细块 */
.jd-pos135 { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; font-weight: 700; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--border); }
.jd-pos135.jd-bull { color: var(--red); background: rgba(246,70,93,.12); border-color: rgba(246,70,93,.3); }
.jd-pos135.jd-bear { color: var(--green); background: rgba(14,203,129,.12); border-color: rgba(14,203,129,.3); }
.jd-pos135.jd-flat { color: var(--text-secondary); background: var(--bg-elevated); }
.jd-pos135-label { color: var(--text-muted); font-weight: 600; }
.jd-pos135-tag { font-size: 10px; padding: 0 5px; border-radius: 8px; background: rgba(150,160,180,.18); color: #aab2c0; }
.jd-pos135.jd-bull .jd-pos135-tag, .jd-pos135.jd-bear .jd-pos135-tag { background: rgba(230,160,40,.2); color: #f0a830; }
.jd-pos135-box { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.jd-pos135-title { font-size: 13px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px; }
.jd-pos135-main { font-size: 13px; line-height: 1.6; }
.jd-pos135-main.jd-bull { color: var(--red); }
.jd-pos135-main.jd-bear { color: var(--green); }
.jd-pos135-main.jd-flat { color: var(--text-secondary); }
.jd-pos135-dir-big { font-weight: 800; margin-right: 6px; }
.jd-pos135-path { font-size: 11px; color: var(--text-muted); margin-top: 6px; line-height: 1.6; }

.jd-rec-detail { padding: 14px; border-top: 1px dashed var(--border); background: var(--bg-elevated); display: flex; flex-direction: column; gap: 14px; }
.jd-factor-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.jd-factor-tbl th { text-align: left; color: var(--text-secondary); font-weight: 600; padding: 6px 8px; border-bottom: 1px solid var(--border); }
.jd-factor-tbl td { padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.04); color: var(--text-primary); }
.jd-fname { font-weight: 600; }
.jd-num { text-align: right; font-variant-numeric: tabular-nums; }
.jd-pos { color: var(--red); }
.jd-neg { color: var(--green); }
.jd-neu { color: #aab2c0; }

.jd-recompute, .jd-settle-box { background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; }
.jd-rec-title, .jd-settle-title { font-size: 13px; font-weight: 700; color: var(--text-primary); margin-bottom: 6px; }
.jd-rec-line { font-size: 12px; color: var(--text-secondary); margin: 3px 0; }
.jd-dim { color: var(--text-muted); }
.jd-settle-row { font-size: 12px; color: var(--text-secondary); margin: 3px 0; display: flex; gap: 16px; flex-wrap: wrap; }
.jd-bull { color: var(--red); }
.jd-bear { color: var(--green); }
.jd-flat { color: var(--text-secondary); }
.jd-empty { color: var(--text-muted); padding: 18px; text-align: center; font-size: 13px; }
.sameday-all-link { display: inline-block; margin-top: 8px; font-size: 12px; color: var(--accent); text-decoration: none; font-weight: 600; }
.sameday-all-link:hover { text-decoration: underline; color: var(--accent-hover); }

/* ---- 行业板块指数（AI 联网）卡片 ---- */
.ind-board-body { display: flex; flex-direction: column; gap: 16px; padding: 4px 0; }
.ind-index-head { display: flex; flex-direction: column; gap: 6px; }
.ind-index-title { font-size: 16px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ind-index-code { font-size: 12px; font-weight: 500; color: var(--text-secondary); background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 4px; padding: 2px 8px; }
.ind-index-metrics { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.ind-index-level { font-size: 22px; font-weight: 700; color: var(--text-primary); }
.ind-index-ytd { font-size: 14px; font-weight: 600; }
.ind-index-asof { font-size: 12px; color: var(--text-secondary); }
.ind-index-ytd.ind-bull { color: var(--red); }   /* 涨 → 红 */
.ind-index-ytd.ind-bear { color: var(--green); }   /* 跌 → 绿 */
.ind-index-ytd.ind-neutral { color: var(--text-secondary); }
.ind-index-section { display: flex; flex-direction: column; gap: 6px; }
.ind-index-sub { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.ind-index-text { font-size: 13px; color: var(--text-secondary); line-height: 1.8; }
.ind-driver-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.ind-driver-chip { font-size: 13px; color: var(--accent); background: rgba(240,185,123,0.12); border: 1px solid rgba(240,185,123,0.3); border-radius: 999px; padding: 4px 12px; }
.ind-index-source { font-size: 12px; color: var(--text-secondary); border-top: 1px dashed var(--border); padding-top: 10px; }

/* ---- 行业分析总览（行业归属 + 行业指数 + 走势图 合并卡片） ---- */
.industry-overview-body { display: flex; flex-direction: column; gap: 18px; padding: 4px 0 16px; }
.ind-overview-classification {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
}
.ind-overview-class-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.ind-overview-class-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.ind-overview-class-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 10px 24px;
}
.ind-overview-class-item {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 13px;
}
.ind-overview-class-label { color: var(--text-secondary); white-space: nowrap; }
.ind-overview-class-value { color: var(--text-primary); font-weight: 500; }
.ind-overview-index {
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px 16px;
}
.ind-overview-index-head { display: flex; flex-direction: column; gap: 6px; }
.ind-overview-index-title { font-size: 16px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ind-overview-index-metrics { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
.ind-overview-section { display: flex; flex-direction: column; gap: 6px; }
.ind-overview-sub { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.ind-overview-text { font-size: 13px; color: var(--text-secondary); line-height: 1.8; }
.ind-overview-source { font-size: 12px; color: var(--text-secondary); border-top: 1px dashed var(--border); padding-top: 10px; }
.ind-overview-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-secondary);
  font-size: 13px;
  background: var(--bg-elevated);
  border: 1px dashed var(--border);
  border-radius: 10px;
}
.ind-overview-empty.ai-loading { color: var(--text-light); }
/* 行业指数卡片：后台刷新中提示（保留旧内容，仅旁标状态） */
.ind-refreshing { color: var(--accent); }
/* 板块总市值走势卡片：摘要行 */
.sector-cap-summary { display: flex; flex-wrap: wrap; gap: 10px 22px; margin: 4px 0 6px; }
.sector-cap-summary-item { display: flex; align-items: baseline; gap: 6px; font-size: 13px; }
.sector-cap-summary-label { color: var(--text-secondary); }
.sector-cap-summary-value { font-weight: 700; color: var(--text-primary); }
.sector-cap-summary-value.up { color: var(--red); }
.sector-cap-summary-value.down { color: var(--green); }
/* 行业景气度卡片：景气度判读 + 口径提示 */
.ind-prosperity-verdict { margin: 6px 0; padding: 6px 10px; border-radius: 6px; font-size: 12.5px; line-height: 1.6; background: rgba(240,185,123,0.08); border-left: 3px solid var(--accent); }
.ind-prosperity-verdict.up { color: var(--red); border-left-color: var(--red); background: rgba(246,70,93,0.08); }
.ind-prosperity-verdict.down { color: var(--green); border-left-color: var(--green); background: rgba(14,203,129,0.08); }
.ind-prosperity-caveats { margin: 4px 0; font-size: 12px; color: #d6a04a; line-height: 1.6; }
/* 板块总市值走势卡片：申万层级角标（一级/二级/三级） */
.sector-cap-level { display: inline-block; padding: 1px 7px; margin-right: 2px; font-size: 11px; font-weight: 600; line-height: 1.5; border-radius: 8px; color: var(--accent); background: rgba(240,185,123,0.14); border: 1px solid rgba(240,185,123,0.4); vertical-align: middle; }
/* 板块总市值走势卡片：数据源暂不可用、回退最近快照时的告示 */
.sector-cap-stale { margin: 4px 0; padding: 6px 10px; font-size: 12px; line-height: 1.6; color: #d6a04a; background: rgba(240,185,123,0.08); border-left: 3px solid var(--accent); border-radius: 6px; }

/* ================= 错误分析与自我进化面板 ================= */
.learn-body { display: flex; flex-direction: column; gap: 14px; padding: 4px 0; }
.learn-status { font-size: 13px; }
.learn-ok { color: var(--text-secondary); font-weight: 600; }
.learn-warn { color: var(--amber); font-weight: 600; }
.learn-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
@media (max-width: 860px) { .learn-cols { grid-template-columns: 1fr; } }
.learn-col { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.learn-col-title { font-size: 13px; font-weight: 700; color: var(--text-primary); margin-bottom: 10px; }
.learn-rel { display: flex; flex-direction: column; gap: 8px; }
.learn-rel-row { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.learn-rel-name { flex: 0 0 96px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.learn-rel-bar { flex: 1; height: 8px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; }
.learn-rel-fill { display: block; height: 100%; border-radius: 999px; }
.learn-bar-good { background: var(--red); }
.learn-bar-mid { background: var(--amber); }
.learn-bar-bad { background: var(--green); }
.learn-bar-na { background: var(--text-muted); }
.learn-rel-val { flex: 0 0 96px; text-align: right; font-weight: 600; color: var(--text-primary); }
.learn-rel-sub { font-weight: 400; color: var(--text-muted); font-size: 11px; }
.learn-w-tbl { width: 100%; border-collapse: collapse; font-size: 12px; }
.learn-w-tbl th, .learn-w-tbl td { padding: 5px 6px; text-align: center; border-bottom: 1px solid var(--border); }
.learn-w-tbl th { color: var(--text-secondary); font-weight: 600; }
.learn-w-name { text-align: left !important; color: var(--text-primary); font-weight: 600; }
.learn-w-dev { color: var(--accent); font-weight: 600; }
.learn-up{ color: var(--text-secondary); }
.learn-down{ color: var(--text-secondary); }
.learn-dev { font-size: 10px; opacity: 0.85; margin-left: 2px; }
.learn-err-title { font-size: 13px; font-weight: 700; color: var(--text-primary); margin-top: 4px; }
.learn-err-list { display: flex; flex-direction: column; gap: 8px; }
.learn-err-item{ background: var(--bg-elevated); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 8px; padding: 8px 12px; }
.learn-err-head { font-size: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.learn-err-date { color: var(--text-muted); }
.learn-err-verdict { color: var(--text-secondary); }
.learn-err-actual { font-weight: 700; }
.learn-err-mis { font-size: 12px; color: var(--text-secondary); margin-top: 4px; display: flex; gap: 10px; flex-wrap: wrap; }
.learn-mis-item { color: var(--text-secondary); }
.learn-note { font-size: 12px; color: var(--text-muted); line-height: 1.7; border-top: 1px dashed var(--border); padding-top: 10px; }
.learn-sym { background: rgba(240,185,123,0.06); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
.learn-divider { text-align: center; font-size: 12px; color: var(--text-muted); margin: 6px 0; letter-spacing: 1px; }

/* ================= 首页「每日宏观 & 政策」卡片 ================= */
.macro-card .macro-body { display: flex; flex-direction: column; gap: 10px; padding: 4px 0; max-height: 480px; overflow-y: auto; }
.macro-card .macro-body::-webkit-scrollbar { width: 6px; }
.macro-card .macro-body::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.macro-groups { display: flex; flex-direction: column; gap: 12px; padding-right: 2px; }
.macro-groups::-webkit-scrollbar { width: 6px; }
.macro-groups::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.macro-cat { display: flex; flex-direction: column; gap: 6px; }
.macro-cat-head { font-size: 13px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px; }
.macro-cat-icon { flex: 0 0 auto; font-size: 14px; line-height: 1; }
.macro-cat-head .macro-cat-count { font-size: 11px; color: var(--text-muted); font-weight: 400; }
.macro-cat.c-money .macro-cat-head { color: var(--amber); }
.macro-cat.c-fiscal .macro-cat-head { color: #60a5fa; }
.macro-cat.c-data .macro-cat-head { color: #34d399; }
.macro-cat.c-intl .macro-cat-head { color: #c084fc; }
.macro-cat.c-mkt .macro-cat-head { color: #f472b6; }
.macro-list { display: flex; flex-direction: column; gap: 6px; }
.macro-item { display: flex; gap: 8px; font-size: 13px; line-height: 1.6; padding: 6px 8px; border-radius: 8px; background: var(--bg-elevated); border: 1px solid var(--border); }
.macro-item:hover { border-color: var(--accent); }
.macro-item .macro-time { flex: 0 0 42px; color: var(--text-muted); font-size: 11px; padding-top: 1px; }
.macro-item .macro-text { flex: 1; color: var(--text-secondary); }
.macro-item .macro-text a { color: var(--text-secondary); text-decoration: none; }
.macro-item .macro-text a:hover { color: var(--accent); text-decoration: underline; }
.macro-sent { flex: 0 0 auto; font-size: 11px; font-weight: 600; padding-top: 1px; }
.macro-note { font-size: 12px; color: var(--text-muted); border-top: 1px dashed var(--border); padding-top: 10px; }
.hn-sent-pos { color: var(--red); }
.hn-sent-neg { color: var(--green); }
.hn-sent-neu { color: var(--text-muted); }

/* ---- 重要经济数据：结构化卡片 ---- */
.macro-sec-head { font-size: 14px; font-weight: 700; color: var(--text-primary); display: flex; align-items: center; gap: 8px; margin-top: 4px; }
.macro-sec-sub { font-size: 11px; font-weight: 400; color: var(--text-muted); }
.macro-data { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.macro-ind { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px; background: var(--bg-elevated); border: 1px solid var(--border); }
.macro-ind .mi-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.macro-ind .mi-name { font-size: 12.5px; font-weight: 700; color: var(--text-primary); }
.macro-ind .mi-period { font-size: 11px; color: var(--text-muted); white-space: nowrap; }
.macro-ind .mi-value { display: flex; align-items: baseline; gap: 5px; flex-wrap: wrap; }
.macro-ind .mi-num { font-size: 26px; font-weight: 800; color: var(--accent); line-height: 1.1; font-variant-numeric: tabular-nums; }
.macro-ind .mi-unit { font-size: 13px; color: var(--text-secondary); }
.macro-ind .mi-vlabel { font-size: 11px; color: var(--text-muted); margin-left: 2px; }
.macro-ind .mi-trend { font-size: 11px; font-weight: 700; padding: 1px 6px; border-radius: 6px; margin-left: auto; }
.macro-ind .mi-trend.up{ color: var(--text-secondary); background: rgba(139,148,158,.12); }
.macro-ind .mi-trend.down{ color: var(--text-secondary); background: rgba(139,148,158,.12); }
.macro-ind .mi-trend.neutral { color: var(--text-secondary); background: rgba(139,148,158,.12); }
.macro-ind .mi-trend.flat { color: var(--text-muted); background: rgba(148,163,184,.12); }
.macro-ind .mi-metrics { display: flex; flex-wrap: wrap; gap: 4px 14px; }
.macro-ind .mi-metric { font-size: 11.5px; color: var(--text-secondary); }
.macro-ind .mi-metric span { color: var(--text-muted); margin-right: 3px; }
.macro-ind .mi-metric b { color: var(--text-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.macro-ind .mi-interp { font-size: 12px; line-height: 1.55; color: var(--text-secondary); border-top: 1px dashed var(--border); padding-top: 6px; }
.macro-ind .mi-src { font-size: 10.5px; color: var(--text-muted); }
.macro-ind.mi-unavailable { border-style: dashed; border-color: rgba(240,185,123,.5); background: repeating-linear-gradient(135deg, var(--bg-elevated), var(--bg-elevated) 10px, rgba(240,185,123,.04) 10px, rgba(240,185,123,.04) 20px); }
.macro-ind.mi-unavailable .mi-num { color: var(--text-muted); }
.macro-ind .mi-badge { align-self: flex-start; font-size: 10.5px; font-weight: 700; color: #F0B97B; background: rgba(240,185,123,.14); border: 1px solid rgba(240,185,123,.4); padding: 1px 8px; border-radius: 6px; }

/* ---- 国际经济数据 & 事件（策划式事件卡片）---- */
.macro-us-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.macro-us-card { display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border-radius: 10px; background: var(--bg-elevated); border: 1px solid var(--border); border-left: 3px solid var(--text-muted); }
.macro-us-card.ev-bear { border-left-color: var(--green); }
.macro-us-card.ev-cond { border-left-color: #F0B97B; }
.macro-us-card.ev-neu { border-left-color: var(--text-muted); }
.macro-us-card .mu-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.macro-us-card .mu-title { font-size: 12.5px; font-weight: 700; color: var(--text-primary); }
.macro-us-card .mu-badge { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 6px; white-space: nowrap; }
.macro-us-card .mu-badge-wrap { display: inline-flex; align-items: center; gap: 5px; }
.macro-us-card .mu-timebadge { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 6px; white-space: nowrap; color: var(--accent); background: rgba(240,185,123,.12); border: 1px solid rgba(240,185,123,.35); }
.macro-us-card.ev-bear .mu-badge { color: var(--green); background: rgba(14,203,129,.14); }
.macro-us-card.ev-cond .mu-badge { color: #F0B97B; background: rgba(240,185,123,.14); }
.macro-us-card.ev-neu .mu-badge { color: var(--text-muted); background: rgba(148,163,184,.14); }
.macro-us-card .mu-meta { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--text-muted); }
.macro-us-card .mu-cat { color: var(--text-secondary); }
.macro-us-card .mu-summary { font-size: 12px; line-height: 1.55; color: var(--text-secondary); }
.macro-us-card .mu-note { font-size: 10.5px; color: var(--text-muted); font-style: italic; }
/* 20261013c：偏多卡片（红，涨）+ 超预期/不及预期角标 + 三值行 */
.macro-us-card.ev-bull { border-left-color: var(--red); }
.macro-us-card.ev-bull .mu-badge { color: var(--red); background: var(--red-soft); }
/* 20261013e：双维度判定徽章（经济影响 / 股市偏好）——各自按方向配色：偏多红 / 偏空绿 / 中性灰 */
.macro-us-card .mu-badge.mu-dim { color: var(--text-muted); background: rgba(148,163,184,.14); }
.macro-us-card .mu-badge.mu-dim.pos { color: var(--red); background: var(--red-soft); }
.macro-us-card .mu-badge.mu-dim.neg { color: var(--green); background: rgba(14,203,129,.14); }
.macro-us-card .mu-dev { font-size: 10.5px; font-weight: 700; padding: 1px 7px; border-radius: 6px; white-space: nowrap; }
.macro-us-card .mu-dev.above { color: #F0B97B; background: rgba(240,185,123,.14); }
.macro-us-card .mu-dev.below { color: #7fa8c9; background: rgba(127,168,201,.14); }
.macro-us-card .mu-dev.inline { color: var(--text-muted); background: rgba(148,163,184,.14); }
.macro-us-card .mu-three-row { display: flex; gap: 12px; flex-wrap: wrap; padding: 5px 8px; background: var(--bg-hover); border-radius: 6px; }
.macro-us-card .mu-three { display: inline-flex; align-items: baseline; gap: 4px; font-size: 11px; }
.macro-us-card .mu-three i { font-style: normal; color: var(--text-muted); }
.macro-us-card .mu-three b { font-size: 12px; font-weight: 700; color: var(--text-primary); }
.macro-us-card .mu-three b.up { color: #F0B97B; }
.macro-us-card .mu-three b.down { color: #7fa8c9; }

/* ---- 市场情绪提醒 · 宏观情绪因子（非常驻 · 自学习）---- */
.tp-macro-block { margin-top: 8px; }
.tp-macro-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
.tp-macro-card { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: 10px; background: var(--bg-elevated); border: 1px solid var(--border); }
.tp-macro-card.dormant { border-style: dashed; border-color: rgba(148,163,184,.5); opacity: .85; }
.tp-macro-head { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; }
.tp-macro-name { font-size: 12.5px; font-weight: 700; color: var(--text-primary); }
.tp-macro-dormant { font-size: 10px; font-weight: 700; color: var(--text-muted); background: rgba(148,163,184,.16); padding: 1px 7px; border-radius: 6px; }
.tp-macro-sig { font-size: 12px; font-weight: 700; }
.tp-macro-sig.pos { color: var(--red); }
.tp-macro-sig.neg { color: var(--green); }
.tp-macro-sig.neu { color: var(--text-muted); }
.tp-macro-w { font-size: 11.5px; color: var(--text-secondary); }
.tp-macro-detail { font-size: 11.5px; line-height: 1.55; color: var(--text-secondary); }
.tp-macro-src { font-size: 10.5px; color: var(--text-muted); }
.tp-macro-note { margin-top: 6px; font-size: 11px; color: var(--text-muted); line-height: 1.5; }

@media (max-width: 560px) {
  .macro-data { grid-template-columns: 1fr; }
  .macro-us-grid { grid-template-columns: 1fr; }
  .tp-macro-grid { grid-template-columns: 1fr; }
}

/* ================= 首页「基金重仓行业配置矩阵」卡片 ================= */
.rank-card .rank-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 0; }
.rank-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.rank-toolbar-label { font-size: 12.5px; color: var(--text-secondary); font-weight: 600; }
.rank-toolbar-sub { font-size: 11.5px; color: var(--text-muted); }
.rank-toolbar .btn-journal-add { margin-left: auto; }
.rank-matrix-wrap { overflow: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--bg-elevated); }
.rank-matrix-wrap::-webkit-scrollbar { width: 6px; height: 6px; }
.rank-matrix-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
.rank-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.rank-table thead th {
  position: sticky; top: 0; z-index: 1;
  background: var(--bg-elevated); color: var(--text-secondary);
  font-weight: 600; text-align: right; padding: 9px 10px; white-space: nowrap;
  border-bottom: 1px solid var(--border);
  box-shadow: 0 1px 0 0 var(--border);
}
.rank-table thead th:first-child { text-align: left; }
.rank-table tbody td { padding: 8px 10px; text-align: right; color: var(--text-secondary); border-bottom: 1px solid var(--border); white-space: nowrap; font-variant-numeric: tabular-nums; }
.rank-table tbody tr:last-child td { border-bottom: none; }
.rank-table tbody tr { transition: background .15s ease; animation: rankFade .34s ease both; }
.rank-table tbody tr:hover { background: rgba(240,185,123,.08); }
@keyframes rankFade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
.rank-name { text-align: left !important; font-weight: 600; color: var(--text-primary); }
.rank-num.pos { color: var(--red); font-weight: 600; }
.rank-num.neg { color: var(--green); font-weight: 600; }
.rank-num.neu { color: var(--text-muted); }
.rank-trend { padding: 0 8px !important; }
.rank-spark { display: block; vertical-align: middle; }
.rank-import { display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px dashed var(--border); border-radius: 10px; background: var(--bg-elevated); }
.rank-import-row { display: flex; gap: 10px; flex-wrap: wrap; }
.rank-import-area {
  width: 100%; min-height: 90px; resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px; line-height: 1.5;
  background: var(--bg-primary); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 8px; padding: 10px;
}
.rank-import-input {
  flex: 1; min-width: 160px;
  font-size: 12.5px; background: var(--bg-primary); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
}
.rank-import-actions { display: flex; gap: 10px; align-items: center; }
.rank-import-actions .btn-ghost { background: transparent; color: var(--text-secondary); }
.rank-sample-warn { color: var(--amber); margin-top: 6px; }
.rank-note { font-size: 11.5px; color: var(--text-muted); border-top: 1px dashed var(--border); padding-top: 10px; line-height: 1.6; }
.rank-note a { color: var(--accent); text-decoration: none; }
.rank-note a:hover { text-decoration: underline; }

/* ---------- 基金重仓行业配置矩阵（实时） ---------- */
.fm-industry {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg-card);
  margin-bottom: 12px;
  animation: rankFade .4s ease both;
  position: relative;
  overflow: hidden;
}
.fm-industry::before {
  content: "";
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 3px;
  background: var(--text-muted);
  transition: background .25s ease;
}
.fm-industry.wt-hot::before{ background: var(--accent); }   /* 高度集中 红 */
.fm-industry.wt-warm::before{ background: rgba(240,185,123,0.7); }
.fm-industry.wt-mid::before  { background: var(--amber); }
.fm-industry.wt-light::before{ background: rgba(240,185,123,0.35); }
.fm-industry.wt-low::before  { background: var(--text-light); }

.fm-industry-head {
  display: flex; align-items: center; justify-content: space-between;
  gap: 10px; flex-wrap: wrap;
  margin-bottom: 10px;
}
.fm-industry-name {
  font-size: 15px; font-weight: 600; color: var(--text-primary);
  display: flex; align-items: center; gap: 8px;
}
.fm-industry-name::before { content: "🏭"; font-size: 14px; }
.fm-industry-stat { display: flex; gap: 6px; flex-wrap: wrap; }
.fm-stat-tag {
  font-size: 11.5px; padding: 3px 8px; border-radius: 6px;
  background: rgba(240,185,123,.08); color: var(--text-secondary);
  border: 1px solid transparent;
}
.fm-stat-tag b { color: var(--text-primary); font-weight: 600; }
.fm-stat-tag.wt-hot{ background: rgba(240,185,123,.16); color: var(--accent); border-color: rgba(240,185,123,.35); }
.fm-stat-tag.wt-warm{ background: rgba(240,185,123,.10); color: var(--accent); }
.fm-stat-tag.wt-mid  { background: rgba(245,158,11,.1);  color: var(--amber); }
.fm-stat-tag.wt-light{ background: rgba(139,148,158,.10); color: var(--text-secondary); }
.fm-stat-tag.wt-low  { background: rgba(148,163,184,.1); color: var(--text-light); }

.fm-table-wrap { overflow-x: auto; }
.fm-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.fm-table thead th {
  padding: 6px 8px; background: var(--bg-elevated);
  color: var(--text-secondary); font-weight: 500; font-size: 11.5px;
  border-bottom: 1px solid var(--border);
  text-align: center; white-space: nowrap;
}
.fm-table thead th.fm-stock-head { text-align: left; }
.fm-table thead th.fm-fund { min-width: 90px; }
.fm-fund-ret { font-size: 10.5px; color: var(--text-light); margin-top: 2px; }
.fm-table tbody td {
  padding: 6px 8px; text-align: center; color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
}
.fm-table tbody tr:last-child td { border-bottom: none; }
.fm-table tbody tr:hover { background: rgba(240,185,123,.05); }
.fm-table .fm-stock {
  text-align: left; color: var(--text-primary); font-weight: 500;
  display: flex; align-items: center; gap: 6px;
}
.fm-stock-code { font-size: 10.5px; color: var(--text-light); font-weight: 400; }
.fm-cell .pos { color: var(--red); font-weight: 600; }   /* 红=集中(看涨) */
.fm-cell .neg { color: var(--green); font-weight: 600; }   /* 绿=减持/负权重(看跌) */

@media (max-width: 720px) {
  .fm-industry { padding: 10px; }
  .fm-table { font-size: 11px; }
  .fm-table thead th, .fm-table tbody td { padding: 5px 6px; }
  .fm-fund-ret { display: none; }
}
@media (max-width: 720px) {
  .rank-matrix-wrap { max-height: 320px; }
  .rank-table tbody td { padding: 7px 8px; font-size: 11.5px; }
  .rank-spark { display: none; }
}

/* ---------- 个股视图横幅（judgments.html ?symbol=） ---------- */
.jd-symbol-banner {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px;
  margin: 0 0 14px; padding: 10px 14px; border-radius: 10px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  font-size: 13px; color: var(--text-secondary);
}
.jd-sb-label b { color: var(--text-primary); }
.jd-sb-all { color: var(--accent); text-decoration: none; font-weight: 600; white-space: nowrap; }
.jd-sb-all:hover { text-decoration: underline; color: var(--accent-hover); }
.jd-sb-note { color: var(--text-muted); font-size: 12px; }

/* ============ 市场情绪拐点（全局预警条 + 个股面板） ============ */
/* 首页预警条 */
.tp-warning-card {
  border-left: 4px solid var(--border);
  background: var(--bg-elevated);
  transition: border-color .2s, background .2s;
}
.tp-warning-card.tp-level-none { border-left-color: var(--text-muted); }
.tp-warning-card.tp-level-watch { border-left-color: #d9b26a; background: rgba(217,178,106,0.08); }
.tp-warning-card.tp-level-warn { border-left-color: var(--orange); background: rgba(217,142,90,0.10); }
.tp-warning-card.tp-level-strong { border-left-color: var(--accent); background: rgba(240,185,123,0.12); }
.tp-warning-head { display: flex; align-items: center; gap: 14px; }
.tp-warning-icon { font-size: 26px; line-height: 1; }
.tp-warning-main { flex: 1; min-width: 0; }
.tp-warning-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.tp-warning-desc { font-size: 12px; color: var(--text-secondary); margin-top: 3px; }
.tp-warning-level {
  flex-shrink: 0; font-size: 15px; font-weight: 700; padding: 5px 14px; border-radius: 8px;
  background: var(--bg-card); color: var(--text-muted); border: 1px solid var(--border);
}
.tp-warning-card.tp-level-watch .tp-warning-level { color: #d9b26a; border-color: #d9b26a; }
.tp-warning-card.tp-level-warn .tp-warning-level { color: var(--orange); border-color: var(--orange); }
.tp-warning-card.tp-level-strong .tp-warning-level{ color: var(--accent); border-color: var(--accent); }
.tp-warning-reasons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.tp-reason {
  font-size: 12px; padding: 4px 10px; border-radius: 7px; line-height: 1.4;
  background: var(--bg-card); border: 1px solid var(--border); color: var(--text-secondary);
}
.tp-reason-bullish { color: var(--red); border-color: var(--red-soft); }
.tp-reason-bearish { color: var(--green); border-color: var(--green-soft); }
.tp-reason-warn { color: #d9b26a; border-color: rgba(217,178,106,0.4); }
.tp-reason-info { color: var(--text-muted); }
.tp-reason-note { color: var(--text-muted); font-style: italic; }

/* 个股页面板 */
.tp-status-row {
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 18px;
  padding: 10px 14px; border-radius: 9px; margin-bottom: 14px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-left: 4px solid var(--text-muted);
}
.tp-status-row.tp-level-watch { border-left-color: #d9b26a; }
.tp-status-row.tp-level-warn { border-left-color: var(--orange); }
.tp-status-row.tp-level-strong { border-left-color: var(--accent); }
.tp-status-badge { font-size: 14px; font-weight: 700; padding: 3px 12px; border-radius: 7px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-primary); }
.tp-status-dir b { color: var(--text-primary); }
.tp-status-idx, .tp-status-z { font-size: 12.5px; color: var(--text-secondary); }

.tp-comp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-bottom: 16px; }
.tp-comp { background: var(--bg-card); border: 1px solid var(--border); border-radius: 9px; padding: 10px 12px; }
.tp-comp-label { font-size: 12.5px; color: var(--text-secondary); display: flex; justify-content: space-between; align-items: baseline; }
.tp-comp-w { font-size: 11px; color: var(--text-muted); }
.tp-comp-sig { font-size: 20px; font-weight: 700; margin: 4px 0 2px; }
.tp-sig-bull { color: var(--red); }
.tp-sig-bear { color: var(--green); }
.tp-sig-flat { color: var(--text-muted); }
.tp-comp-value { font-size: 12px; color: var(--text-primary); }
.tp-comp-detail { font-size: 11px; color: var(--text-muted); margin-top: 3px; line-height: 1.4; }
.tp-comp-date { font-size: 10.5px; color: var(--text-muted); margin-top: 6px; padding-top: 4px; border-top: 1px dashed rgba(255,255,255,.06); }

/* [20261109a] 两融余额因子卡：卡内双栏，融资 / 融券各占 50% 权重。
   方向色沿用 tp-sig-bull(红=利好) / tp-sig-bear(绿=利空)，与全站红涨绿跌语义一致；
   双栏数值不经过 _dirColorize（融券「+」是利空，按符号着色会错位）。 */
.tp-comp-dual { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 8px 0 6px; }
.tp-comp-sub {
  min-width: 0; padding: 7px 8px; border-radius: 7px;
  background: rgba(255,255,255,0.025); border: 1px solid var(--border);
}
.tp-comp-sub-hd {
  display: flex; justify-content: space-between; align-items: baseline; gap: 4px;
  font-size: 11px; color: var(--text-secondary); white-space: nowrap;
}
.tp-comp-sub-hd span { font-size: 10px; color: var(--text-muted); }
.tp-comp-sub-val { font-size: 14px; font-weight: 700; margin-top: 4px; white-space: nowrap; }
.tp-comp-sub-dir { font-size: 11.5px; font-weight: 600; margin-top: 1px; }
.tp-comp-sub-note { font-size: 10px; color: var(--text-muted); margin-top: 4px; line-height: 1.35; }
.tp-comp-sub-absent { opacity: 0.62; border-style: dashed; }
@media (max-width: 520px) { .tp-comp-dual { grid-template-columns: 1fr; } }

.tp-block-title { font-size: 13px; font-weight: 600; color: var(--text-primary); margin: 14px 0 8px; padding-left: 9px; border-left: 3px solid var(--accent); }
.tp-reasons-block, .tp-learn-block, .tp-sens-block { margin-bottom: 6px; }

/* ---- 20260917d：大盘量能情绪分析模型（首页「市场情绪提醒」卡片）---- */
.tp-status-row.tp-emo.bull { border-left-color: var(--red); }
.tp-status-row.tp-emo.bear { border-left-color: var(--green); }
.tp-status-row.tp-emo.flat { border-left-color: var(--text-muted); }
.tp-emo-lines { margin: 4px 0 12px; border: 1px solid var(--border); border-radius: 9px; overflow: hidden; background: var(--bg-card); }
.tp-emo-line { display: flex; align-items: flex-start; gap: 12px; padding: 9px 14px; border-bottom: 1px solid var(--border); }
.tp-emo-line:last-child { border-bottom: none; }
.tp-emo-k { flex: 0 0 74px; font-size: 12.5px; color: var(--text-muted); }
.tp-emo-v { flex: 1; font-size: 13.5px; color: var(--text-primary); line-height: 1.55; word-break: break-word; }
.tp-emo-sub { font-size: 11.5px; color: var(--text-muted); margin-left: 6px; }
.tp-emo-lines .pos, .tp-emo-v.pos { color: var(--red); }
.tp-emo-lines .neg, .tp-emo-v.neg { color: var(--green); }
.tp-emo-lines .neu, .tp-emo-v.neu { color: var(--text-primary); }
.tp-emo-v.tp-emo-warn { color: var(--orange); font-weight: 600; }
.tp-emo-v.tp-emo-risk { color: var(--orange); }
/* [20261109b] 量能档位：暖/冷中性色做视觉区分，不占用「红=利好 / 绿=利空」方向色 */
.tp-vol-active { color: #F0B97B; font-weight: 600; }
.tp-vol-quiet  { color: #7fa8c9; font-weight: 600; }
.tp-comp.tp-comp-degraded { opacity: 0.72; border-style: dashed; }
.tp-comp-detail.tp-emo-warn { color: var(--orange); }
.tp-comp-detail.tp-emo-info { color: var(--text-secondary); }
.tp-sample-note.tp-emo-warn { color: var(--orange); }

/* 20260914e：大盘技术分析融合版（七步推演单一融合输出，替代原「短线结构研判」独立模块） */
/* —— 每只指数卡片底部：紧凑短线结构读数 —— */
.mt-short-foot { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border); font-size: 12px; color: var(--text-secondary); }
.mt-sf-title { font-weight: 600; color: var(--text-primary); }
.mt-sf-anchor { margin-left: auto; color: var(--text-muted); font-variant-numeric: tabular-nums; }
.mt-short-foot .up{ color: var(--red); }
.mt-short-foot .down{ color: var(--green); }

/* —— 融合决策块 —— */
.mt-fused { margin-top: 16px; padding-top: 16px; border-top: 2px solid rgba(240,185,123,0.4); }
.mt-fused-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.mt-fused-head .mt-block-title { margin: 0; border: none; padding: 0; font-size: 14px; }
.mt-fusion-badge { font-size: 14px; font-weight: 700; padding: 4px 14px; border-radius: 999px; border: 1px solid; }
.fu-bull-strong { color: var(--red); background: var(--tint-red); border-color: rgba(246,70,93,0.5); }
.fu-bull { color: var(--red); background: var(--tint-red); border-color: rgba(246,70,93,0.4); }
.fu-flat { color: var(--accent); background: var(--accent-light); border-color: rgba(240,185,123,0.4); }
.fu-bear { color: var(--green); background: var(--tint-green); border-color: rgba(14,203,129,0.4); }
.fu-bear-strong { color: var(--green); background: var(--tint-green); border-color: rgba(14,203,129,0.5); }
.fu-amber { color: #d9b26a; background: rgba(217,178,106,0.12); border-color: rgba(217,178,106,0.45); }
.mt-state-badge { font-size: 13px; font-weight: 700; padding: 3px 12px; border-radius: 999px; border: 1px solid; }
.mt-conf-badge { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
.fu-conf-high { color: var(--text-secondary); background: rgba(139,148,158,0.12); border: 1px solid rgba(139,148,158,0.4); }
.fu-conf-mid { color: var(--accent); background: var(--accent-light); border: 1px solid rgba(240,185,123,0.4); }
.fu-conf-low { color: #d9b26a; background: rgba(217,178,106,0.12); border: 1px solid rgba(217,178,106,0.45); }
.mt-reli-badge { font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; }
.mt-reli-badge.ok { color: var(--text-secondary); background: rgba(139,148,158,0.12); border: 1px solid rgba(139,148,158,0.4); }
.mt-reli-badge.warn { color: #d9b26a; background: rgba(217,178,106,0.12); border: 1px solid rgba(217,178,106,0.45); }

/* —— 锚点行 —— */
.mt-anchors { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.mt-anchor { flex: 1; min-width: 110px; display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; border-radius: 8px; background: var(--bg-card); border: 1px solid var(--border); }
.mt-anchor-label { font-size: 11.5px; color: var(--text-muted); }
.mt-anchor-val { font-size: 16px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.mt-anchor-val small { font-size: 10.5px; font-weight: 400; color: var(--text-muted); margin-left: 4px; }

/* —— 三列区（量能 / 外部 / 仓位） —— */
.mt-fused-row { display: grid; grid-template-columns: 1fr 1.2fr 1fr; gap: 10px; margin-bottom: 10px; }
.mt-vol-badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
.mt-vol-badge.fu-vol-eff { color: var(--text-secondary); background: rgba(139,148,158,0.12); border: 1px solid rgba(139,148,158,0.4); }
.mt-vol-badge.fu-vol-weak { color: #d9b26a; background: rgba(217,178,106,0.12); border: 1px solid rgba(217,178,106,0.4); }
.mt-ext-badge { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; }
.fu-ext-hawk { color: var(--green); background: var(--tint-green); border: 1px solid rgba(14,203,129,0.4); }
.fu-ext-dove { color: var(--red); background: var(--tint-red); border: 1px solid rgba(246,70,93,0.4); }
.fu-ext-neutral { color: var(--accent); background: var(--accent-light); border: 1px solid rgba(240,185,123,0.4); }
.mt-pos-range { display: inline-block; font-size: 18px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; padding: 2px 0; }
.mt-pos-range.no-add { color: var(--accent); }
.mt-bias-block { grid-column: 1 / -1; }

/* —— 信号 / 风险 / 证据链 双列 —— */
.mt-fused-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px; }
.mt-sig-list, .mt-risk-list, .mt-evi-list { list-style: none; margin: 0; padding: 0; }
.mt-sig-list li, .mt-risk-list li, .mt-evi-list li { font-size: 12.5px; line-height: 1.6; padding: 5px 10px; border-radius: 7px; background: var(--bg-card); border: 1px solid var(--border); margin-bottom: 6px; color: var(--text-secondary); }
.mt-risk-list li.mt-risk-item { color: #d9b26a; border-color: rgba(217,178,106,0.35); background: rgba(217,178,106,0.08); }
.mt-resonance { font-size: 11.5px; color: var(--text-muted); margin-top: 6px; line-height: 1.6; padding: 8px 10px; border-radius: 6px; background: rgba(240,185,123,0.06); border-left: 3px solid var(--accent); }
.mt-muted { color: var(--text-muted) !important; }
.tp-reason-line { font-size: 12.5px; line-height: 1.6; padding: 4px 10px; border-radius: 7px; margin-bottom: 6px; background: var(--bg-card); border: 1px solid var(--border); color: var(--text-secondary); }
.tp-reason-line.tp-reason-bullish { color: var(--red); border-color: var(--red-soft); }
.tp-reason-line.tp-reason-bearish { color: var(--green); border-color: var(--green-soft); }
.tp-reason-line.tp-reason-warn { color: #d9b26a; border-color: rgba(217,178,106,0.4); }
.tp-learn-line { font-size: 12.5px; color: var(--text-secondary); line-height: 1.8; }
.tp-learn-line b { color: var(--text-primary); }
.tp-learn-sub { color: var(--text-muted); font-size: 11.5px; }
.tp-sens-line { font-size: 12.5px; color: var(--text-secondary); line-height: 1.8; }
.tp-sens-line b { color: var(--text-primary); }
.tp-sample-note { font-size: 11.5px; color: var(--text-muted); margin-top: 10px; }
.tp-source-note { font-size: 11px; color: var(--text-muted); margin-top: 8px; line-height: 1.5; opacity: .85; }

/* 市场情绪拐点：详情折叠按钮与折叠态 */
.tp-detail-toggle {
  margin: 0 0 10px;
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--border-subtle, #30363d);
  color: var(--text-secondary, #8b949e);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: color .15s ease, border-color .15s ease;
}
.tp-detail-toggle:hover {
  color: var(--accent, #F0B97B);
  border-color: var(--accent, #F0B97B);
}
.tp-detail-body.collapsed { display: none; }

/* ===== 宽基 ETF 申赎独立页容器（20261025p：/etf-flow.html，组件样式沿用下方 etf-* 段） ===== */
.ef-page-body { display: flex; flex-direction: column; gap: 14px; padding: 4px 2px 40px; }

/* ===== 情绪面板页签（20261022h：情绪因子明细 / 宽基 ETF 申赎）===== */
/* 20261025p：页签已删除（ETF 明细改独立页），tp-tabs/tp-tab 样式保留为死规则无害，暂不清理 */
.tp-tabs {
  display: flex;
  gap: 6px;
  margin: 10px 0 12px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 0;
}
.tp-tab {
  appearance: none;
  border: 1px solid transparent;
  border-bottom: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  padding: 6px 12px;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  transition: color .15s ease, background .15s ease;
  position: relative;
  top: 1px;
}
.tp-tab:hover { color: var(--text-primary); background: var(--bg-hover); }
.tp-tab.active {
  color: var(--accent);
  background: var(--bg-card);
  border-color: var(--border);
  font-weight: 600;
}
.tp-tab-tag {
  font-size: 10.5px;
  padding: 0 5px;
  line-height: 15px;
  border-radius: 4px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-weight: 500;
}
.tp-tab-tag.bull { color: var(--red); background: rgba(246,70,93,.14); }
.tp-tab-tag.bear { color: var(--green); background: rgba(14,203,129,.14); }
.tp-tab-tag.flat { color: var(--text-secondary); }
.tp-tab-tag.none { color: var(--text-disabled, #484F58); }

/* ===== 宽基 ETF 申赎明细（页签内容）===== */
.etf-empty {
  padding: 18px 14px;
  font-size: 12.5px;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border-radius: 8px;
  line-height: 1.7;
}
.etf-empty-sub { font-size: 11.5px; color: var(--text-muted); margin-top: 4px; }
.etf-warn { color: #E3B341; }

.etf-head { background: var(--bg-hover); border-radius: 8px; padding: 10px 12px; }
.etf-head-row { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 12px; }
.etf-k { color: var(--text-muted); }
.etf-v { color: var(--text-primary); font-weight: 600; margin-right: 4px; }
.etf-total {
  margin-top: 8px;
  font-size: 13px;
  color: var(--text-primary);
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.etf-total b { font-size: 16px; }
.etf-total.flat { color: var(--text-secondary); font-size: 12.5px; }
.etf-total.flat b { font-size: 13px; }
.etf-total-sub { display: block; font-size: 11.5px; color: var(--text-muted); margin-top: 4px; font-weight: 400; }
.etf-pos { color: var(--red); }
.etf-neg { color: var(--green); }

.etf-groups { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 2px; }
.etf-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 7px 11px;
  border-radius: 7px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  min-width: 130px;
}
.etf-group-name { font-size: 11.5px; color: var(--text-secondary); }
.etf-group-net { font-size: 13px; font-weight: 600; }
.etf-group-sub { font-size: 10.5px; color: var(--text-muted); }

.etf-block-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 14px 0 7px;
  padding-left: 8px;
  border-left: 3px solid var(--accent);
  display: flex;
  align-items: center;
  gap: 10px;
}
.etf-more {
  appearance: none; border: 1px solid var(--border); background: transparent;
  color: var(--text-secondary); font-size: 11px; padding: 2px 8px; border-radius: 5px; cursor: pointer;
}
.etf-more:hover { color: var(--accent); border-color: var(--accent); }

.etf-scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
.etf-scroll-tall { max-height: 420px; overflow-y: auto; }
.etf-table { width: 100%; border-collapse: collapse; font-size: 11.5px; min-width: 720px; }
.etf-table th {
  text-align: left; font-weight: 600; color: var(--text-secondary);
  padding: 7px 9px; background: var(--bg-elevated, #1A212B);
  border-bottom: 1px solid var(--border); white-space: nowrap; position: sticky; top: 0;
}
.etf-table td { padding: 6px 9px; border-bottom: 1px solid rgba(255,255,255,0.04); color: var(--text-primary); }
.etf-table tbody tr:last-child td { border-bottom: none; }
.etf-table tbody tr:hover { background: var(--bg-hover); }
.etf-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.etf-table .mono { font-family: ui-monospace, Menlo, Consolas, monospace; color: var(--text-secondary); }
.etf-table .name { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.etf-table .dim { color: var(--text-muted); }
.etf-table .note { color: var(--text-muted); font-size: 11px; max-width: 240px; }
.etf-table .row-dim { opacity: .55; }

/* 20261027a：累计表股票名超链接 + 当月逐日明细表 */
.etf-stock-link {
  color: var(--accent); cursor: pointer; text-decoration: none;
  border-bottom: 1px dashed rgba(240,185,123,0.45);
}
.etf-stock-link:hover { color: #ffce96; border-bottom-style: solid; }
.etf-month-table { min-width: 420px; }
.etf-month-total td {
  border-top: 1px solid rgba(240,185,123,0.4); font-weight: 700; padding-top: 8px;
  background: rgba(240,185,123,0.05);
}
.etf-month-close { margin: 8px 2px 2px; font-size: 11.5px; color: var(--text-muted); }
.etf-month-close .etf-stock-clear { color: var(--accent); cursor: pointer; text-decoration: none; }
.etf-month-close .etf-stock-clear:hover { text-decoration: underline; }
.etf-month-tag {
  font-style: normal; margin-left: 6px; padding: 1px 6px; border-radius: 6px;
  font-size: 10.5px; color: var(--accent); background: rgba(240,185,123,0.12);
  border: 1px solid rgba(240,185,123,0.35); white-space: nowrap;
}
/* [20261109a] 未定稿多日合计行：淡琥珀底 + 左侧细线，与已定稿的逐日行区分但同表可比 */
.etf-month-provisional td { background: rgba(240,185,123,0.045); }
.etf-month-provisional td:first-child { box-shadow: inset 2px 0 0 rgba(240,185,123,0.55); }
.etf-month-provisional .etf-month-tag { border-style: dashed; }
.etf-month-note {
  margin: 8px 2px 2px; font-size: 11.5px; line-height: 1.7; color: var(--text-muted);
  border: 1px dashed rgba(230,237,243,0.14); border-radius: 8px; padding: 8px 10px;
}
.etf-month-note b { color: var(--text-secondary); }

/* ---- 20261028a：宽基 ETF「持仓比例 vs 现金比例」趋势折线图（独立页，echarts softDark）---- */
.etf-trend-chart {
  width: 100%; height: 320px; margin: 4px 0 2px;
  background: var(--bg-card, #161B22); border: 1px solid var(--border, #21262D); border-radius: 10px;
}


/* ---- 20261023b：宽基 ETF 卡片「查看明细」入口（明细已移到独立页签，卡片不再内嵌表格）---- */
.tp-comp-more {
  appearance: none; margin-top: 7px; padding: 0; border: none; background: transparent;
  color: var(--accent); font-size: 11.5px; cursor: pointer;
}
.tp-comp-more:hover { text-decoration: underline; }

.etf-two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
@media (max-width: 760px) { .etf-two-col { grid-template-columns: 1fr; } }
.etf-col { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--bg-card); }
.etf-col-head { font-size: 11.5px; font-weight: 600; margin-bottom: 6px; }
.etf-li { display: flex; justify-content: space-between; gap: 8px; font-size: 11.5px; padding: 3px 0; border-bottom: 1px dashed rgba(255,255,255,0.04); }
.etf-li:last-child { border-bottom: none; }
.etf-li-name { color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.etf-li-name em { font-style: normal; color: var(--text-muted); margin-left: 6px; font-size: 10.5px; }
.etf-li-val { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }

.etf-notes { margin-top: 14px; border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 7px; }
.etf-note-item { font-size: 11.5px; color: var(--text-muted); line-height: 1.7; }
.etf-note-item b { color: var(--text-secondary); }
.etf-note-item.etf-warn { color: #E3B341; }
.etf-note-item.etf-warn b { color: #E3B341; }

/* 首页市场情绪完整面板：继承 chart-card，但宽度对齐原 home-card */
#homeSentimentPanel {
  width: 100%;
  max-width: 1100px;
  margin-left: auto;
  margin-right: auto;
}

/* ===== 行业板块拥挤度卡片 ===== */
.sector-crowding-card .crowding-body {
  display: flex; gap: 14px; flex-wrap: wrap;
}
.sector-crowding-card .crowd-col {
  flex: 1 1 0; min-width: 220px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 8px; padding: 10px 12px;
}
.sector-crowding-card .crowd-col-head {
  font-size: 13px; font-weight: 600; color: var(--text-primary);
  margin-bottom: 8px; display: flex; justify-content: space-between; align-items: baseline;
}
.sector-crowding-card .crowd-col-date {
  font-size: 10.5px; font-weight: 400; color: var(--text-muted);
}
.sector-crowding-card .crowd-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
}
.sector-crowding-card .crowd-table th {
  text-align: right; color: var(--text-muted); font-weight: 500;
  padding: 4px 6px; border-bottom: 1px solid var(--border); font-size: 11px;
}
.sector-crowding-card .crowd-table th:first-child,
.sector-crowding-card .crowd-table td:first-child { text-align: center; width: 26px; }
.sector-crowding-card .crowd-table th:nth-child(2),
.sector-crowding-card .crowd-table td:nth-child(2) { text-align: left; }
.sector-crowding-card .crowd-table td {
  padding: 5px 6px; border-bottom: 1px solid rgba(44,51,59,0.5);
  color: var(--text-secondary);
}
.sector-crowding-card .crowd-name { color: var(--text-primary); }
.sector-crowding-card .crowd-val { color: var(--accent); font-weight: 600; }
.sector-crowding-card .crowd-chg.up { color: var(--accent); }
.sector-crowding-card .crowd-chg.down { color: var(--accent); }
.sector-crowding-card .crowd-rank { color: var(--text-muted); }
.sector-crowding-card tr.rank-1 { background: rgba(240,185,123,0.12); }
.sector-crowding-card tr.rank-1 .crowd-rank { color: var(--accent); font-weight: 700; }
.sector-crowding-card tr.rank-2 .crowd-rank,
.sector-crowding-card tr.rank-3 .crowd-rank { color: var(--text-secondary); font-weight: 600; }
.sector-crowding-card .crowd-empty { text-align: center; color: var(--text-muted); padding: 16px 0; }
.sector-crowding-card .crowding-note {
  margin-top: 10px; font-size: 11px; color: var(--text-muted); line-height: 1.6;
  border-top: 1px dashed var(--border); padding-top: 8px;
}
.mo-sub { font-size: 11px; color: var(--text-secondary); margin-right: 6px; }

/* 分产品 / 分地区 口径变化提示 */
.segment-note { margin-top: 8px; font-size: 11px; color: var(--text-muted); line-height: 1.6; border-top: 1px dashed var(--border); padding-top: 6px; }
.current-pe-note { margin-top: 8px; font-size: 12px; line-height: 1.6; border-top: 1px dashed var(--border); padding-top: 6px; color: var(--text); background: rgba(240,185,123,0.10); border: 1px solid rgba(240,185,123,0.35); border-radius: 6px; padding: 6px 8px; }
.current-pe-note b { color: var(--accent); }

/* 重大财务变化 AI 归因 */
.change-analysis-notes { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 10px; }
.change-analysis-notes .ca-title { font-size: 13px; font-weight: 700; color: var(--accent); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.change-analysis-notes .ca-item { background: var(--bg-hover); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
.change-analysis-notes .ca-item:last-child { margin-bottom: 0; }
.change-analysis-notes .ca-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.change-analysis-notes .ca-metric { font-size: 12px; font-weight: 700; color: var(--text-primary); }
.change-analysis-notes .ca-pct { font-size: 12px; font-weight: 700; }
.change-analysis-notes .ca-pct.up { color: var(--red); }
.change-analysis-notes .ca-pct.down { color: var(--green); }
.change-analysis-notes .ca-tag { font-size: 10px; color: var(--text-muted); background: var(--bg-elevated); padding: 1px 5px; border-radius: 3px; }
.change-analysis-notes .ca-summary { font-size: 11px; color: var(--text-secondary); margin-bottom: 6px; }
.change-analysis-notes .ca-explanation { font-size: 12px; color: var(--text-primary); line-height: 1.7; }
.change-analysis-notes .ca-source { font-size: 10px; color: var(--text-muted); margin-top: 6px; text-align: right; }

/* ============================================================
   设计系统：组件基座 / 焦点环 / 骨架屏 / 加载·空·错误 三态
   ============================================================ */

/* --- 交互基座：统一按钮 / 输入 / 下拉 / 文本域三态 --- */
button,
input,
select,
textarea {
  font-family: inherit;
  font-variant-numeric: tabular-nums;
}
button {
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s,
              box-shadow 0.15s, transform 0.12s, filter 0.15s, opacity 0.15s;
}
button:disabled { cursor: not-allowed; opacity: 0.55; }
button:active:not(:disabled) { transform: translateY(1px); }
input,
select,
textarea {
  transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
}

/* 键盘焦点环（金色），不影响鼠标点击态 */
button:focus-visible,
input:focus-visible,
select:focus-visible,
textarea:focus-visible,
a:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(240,185,123,0.18);
}

/* --- 骨架屏 --- */
.skeleton {
  position: relative;
  overflow: hidden;
  background: var(--bg-hover);
  border-radius: var(--radius-xs);
}
.skeleton::after {
  content: '';
  position: absolute;
  inset: 0;
  transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent);
  animation: sk-shimmer 1.5s ease-in-out infinite;
}
@keyframes sk-shimmer { 100% { transform: translateX(100%); } }

.sk-stack { display: flex; flex-direction: column; gap: 10px; width: 100%; max-width: 640px; }
.sk-title { height: 18px; width: 42%; }
.sk-line  { height: 12px; }
.sk-line.short { width: 66%; }
.sk-block { height: 140px; border-radius: var(--radius); }
.sk-row { display: flex; gap: 10px; }
.sk-row .skeleton { flex: 1; height: 60px; }

/* 骨架屏→内容过渡：淡入避免白屏/闪烁 */
.sk-fade { opacity: 0; transition: opacity 0.3s ease; }
.sk-fade.ready { opacity: 1; }

/* --- 通用 加载 / 空 / 错误 三态组件 --- */
.ui-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 32px 20px;
  text-align: center;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  min-height: 120px;
}
.ui-state .ui-icon { font-size: 40px; line-height: 1; }
.ui-state .ui-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.ui-state .ui-desc { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; }
.ui-state .ui-action { margin-top: 4px; }

.ui-empty { color: var(--text-secondary); }
.ui-empty .ui-icon { opacity: 0.6; }
.ui-error { border-color: rgba(240,185,123,0.35); }
.ui-error .ui-icon, .ui-error .ui-title{ color: var(--accent); }
.ui-loading .ui-icon { color: var(--accent); }

/* ============================================================
   顶栏 + 三栏 + 底部Tab 专业仪表盘布局
   ============================================================ */
:root { --sidebar-width: 260px; }

body { display: flex; flex-direction: column; }
#app { flex: 1; min-height: 0; height: auto; }

/* ---- 顶栏：大盘行情状态栏 ---- */
.market-topbar {
  flex-shrink: 0;
  background: var(--bg-sidebar);
  border-bottom: 1px solid var(--border);
}
.topbar-inner {
  display: flex; align-items: center; gap: 16px;
  padding: 6px 16px;
}
.topbar-brand {
  font-size: 13px; font-weight: 700; color: var(--text-primary);
  white-space: nowrap; flex-shrink: 0;
  display: flex; align-items: center; gap: 6px;
}
.topbar-brand .brand-logo {
  width: 20px; height: 20px; border-radius: 5px; flex-shrink: 0;
  display: block;
}
.topbar-indices {
  display: flex; align-items: center; gap: 20px;
  flex: 1; min-width: 0; overflow-x: auto;
  scrollbar-width: none;
}
.topbar-indices::-webkit-scrollbar { display: none; }
.tb-loading { font-size: 11px; color: var(--text-secondary); }
.tb-index {
  display: inline-flex; align-items: baseline; gap: 6px;
  white-space: nowrap; font-size: 11px; line-height: 1;
}
.tb-name { color: var(--text-secondary); }
.tb-price { color: var(--text-primary); font-weight: 600; }
.tb-chg { font-weight: 600; }
.tb-chg.up { color: var(--red); }
.tb-chg.down { color: var(--green); }
.tb-chg.flat { color: var(--flat); }
.topbar-collapse {
  background: none; border: 1px solid var(--border); color: var(--text-secondary);
  border-radius: var(--radius-sm); width: 24px; height: 24px; font-size: 11px;
  cursor: pointer; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; transition: color .15s, border-color .15s, transform .2s;
}
.topbar-collapse:hover { color: var(--accent); border-color: var(--accent); }
.market-topbar.collapsed .topbar-indices { display: none; }
.market-topbar.collapsed .topbar-collapse { transform: rotate(180deg); }

/* ---- 左栏自选股列表（实时行情 + 排序） ---- */
.wl-head, .wl-row {
  display: grid;
  /* 名称列 minmax(0,1fr)：允许收缩配合省略号，总最小宽度低于侧栏内容宽（220px），
     消除横向溢出导致的底部滚动条；横向 padding 由 .sidebar-section 的 20px 提供 */
  grid-template-columns: minmax(0, 1fr) 54px 62px 14px;
  gap: 6px; align-items: center;
}
.wl-head {
  padding: 6px 0; font-size: 11px; color: var(--text-secondary);
  border-bottom: 1px solid var(--border);
}
.wl-head span { cursor: pointer; user-select: none; white-space: nowrap; }
.wl-head span:hover, .wl-head span.active { color: var(--accent); }
.wl-row {
  padding: 7px 0; border-bottom: 1px solid rgba(255,255,255,0.04);
  cursor: pointer; font-size: 12px;
}
.wl-row:hover { background: var(--bg-hover); }
.wl-row.selected { background: var(--accent-light); }
.wl-nm { color: var(--text-primary); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wl-cd { color: var(--text-light); font-size: 10px; }
.wl-price { text-align: right; color: var(--text-primary); }
.wl-chg {
  text-align: center; justify-self: end; padding: 1px 6px; border-radius: 4px;
  font-weight: 600; font-size: 11px;
}
.wl-chg.up { color: var(--red); background: var(--red-soft); }
.wl-chg.down { color: var(--green); background: var(--green-soft); }
.wl-chg.flat { color: var(--flat); background: rgba(139,148,158,0.12); }
.wl-remove { color: var(--text-light); font-size: 14px; cursor: pointer; text-align: center; }
.wl-remove:hover{ color: var(--accent); }
.wl-empty { color: var(--text-secondary); font-size: 12px; padding: 10px 4px; }
.wl-loading { color: var(--text-secondary); font-size: 11px; padding: 6px 4px; }

/* ---- 中栏图表：周期切换（按钮样式统一见 .range-btn/.period-btn 胶囊规则） ---- */
.chart-header-wrap { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 14px; }

/* ---- 响应式 ---- */
@media (max-width: 1024px) {
  #app { flex-direction: column; }
  .sidebar { width: 100%; max-height: 240px; flex-shrink: 0; }
  .main-content { min-height: 0; }
}

/* =====================================================================
   交互细节打磨：右键菜单 / 确认弹窗 / 快捷键提示 / 错误横幅 /
   分组chip / 选中态 / 卡片hover / 无障碍行高
   ===================================================================== */

/* ---- 右键菜单 ---- */
.context-menu {
  position: fixed;
  z-index: 1200;
  min-width: 180px;
  padding: 6px;
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  animation: ctxIn .15s ease;
}
.context-menu.hidden { display: none; }
@keyframes ctxIn { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: scale(1); } }
.ctx-item {
  padding: 9px 12px;
  border-radius: var(--radius-xs);
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
  white-space: nowrap;
  transition: background .12s ease;
}
.ctx-item:hover { background: var(--bg-hover); }
.ctx-item.danger { color: var(--accent); }
/* 20261016：红字压淡红底 4.25:1 不达 AA，hover 改实底红 + 深字（11:1），与徽章实底模式一致 */
.ctx-item.danger:hover{ background: var(--accent); color: #0B0E11; font-weight: 600; }
.ctx-sep { height: 1px; margin: 6px 4px; background: var(--border); }
.ctx-label { padding: 4px 12px 6px; font-size: 11px; color: var(--text-disabled); letter-spacing: .3px; }

/* ---- 确认弹窗：250ms 平滑进出 + 30% 黑色遮罩 ---- */
.confirm-overlay {
  position: fixed; inset: 0; z-index: 1100;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.3);
  animation: overlayIn .25s ease;
}
.confirm-overlay.hidden { display: none; }
@keyframes overlayIn { from { opacity: 0; } to { opacity: 1; } }
.confirm-dialog {
  width: min(400px, 92vw);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: dialogIn .25s ease;
}
@keyframes dialogIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
.confirm-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.confirm-head h3 { font-size: 15px; font-weight: 600; }
.confirm-x { background: none; border: none; color: var(--text-secondary); font-size: 16px; cursor: pointer; }
.confirm-x:hover { color: var(--text-primary); }
.confirm-body { padding: 18px; }
.confirm-body p { color: var(--text-secondary); font-size: 14px; line-height: 1.7; }
.confirm-foot { display: flex; justify-content: flex-end; gap: 10px; padding: 14px 18px; border-top: 1px solid var(--border); }

/* ---- 快捷键入口 + 提示层 ---- */
.sidebar-header { display: flex; align-items: center; justify-content: space-between; }
.kb-trigger {
  background: none; border: 1px solid var(--border);
  color: var(--text-secondary); border-radius: var(--radius-xs);
  width: 30px; height: 30px; cursor: pointer; font-size: 15px;
  transition: border-color .15s, color .15s;
}
.kb-trigger:hover { border-color: var(--accent); color: var(--accent); }
.kb-overlay {
  position: fixed; inset: 0; z-index: 1100;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.3);
  animation: overlayIn .25s ease;
}
.kb-overlay.hidden { display: none; }
.kb-dialog {
  width: min(420px, 92vw);
  background: var(--bg-card);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
  animation: dialogIn .25s ease;
}
.kb-head { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.kb-head h3 { font-size: 15px; font-weight: 600; }
.kb-close { background: none; border: none; color: var(--text-secondary); font-size: 16px; cursor: pointer; }
.kb-close:hover { color: var(--text-primary); }
.kb-body { padding: 8px 18px 16px; }
.kb-row { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.05); }
.kb-row:last-child { border-bottom: none; }
.kb-key {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 26px; padding: 3px 9px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-bottom-width: 2px;
  border-radius: var(--radius-xs);
  font-size: 12px; color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}
.kb-desc { font-size: 13px; color: var(--text-secondary); }

/* ---- 错误占位横幅（断网 / 接口异常） ---- */
.error-banner {
  position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
  z-index: 1050;
  display: flex; align-items: center; gap: 10px;
  max-width: min(640px, 92vw);
  padding: 12px 16px;
  background: rgba(48,36,24,0.98);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
  animation: ctxIn .2s ease;
}
.error-banner.hidden { display: none; }
.err-icon { font-size: 16px; flex-shrink: 0; }
.err-msg { flex: 1; font-size: 13px; color: var(--text-primary); }
.err-retry { background: var(--accent); color: #0B0E11; font-weight: 600; border: none; padding: 6px 14px; border-radius: var(--radius-sm); font-size: 13px; cursor: pointer; transition: filter .15s; }
.err-retry:hover { filter: brightness(1.1); }
.err-close { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 15px; }
.err-close:hover { color: var(--text-primary); }

/* ---- 自选股分组 chip + 标签 ---- */
.wl-groups { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 2px 6px; }
.wl-group-chip {
  background: none; border: 1px solid var(--border);
  color: var(--text-secondary); font-size: 11px;
  padding: 3px 10px; border-radius: 999px; cursor: pointer;
  transition: color .15s, border-color .15s, background .15s;
}
.wl-group-chip:hover { color: var(--text-primary); }
.wl-group-chip.on { color: var(--accent); border-color: var(--accent); background: var(--accent-light); }
.wl-tag {
  display: inline-block; margin-left: 6px; padding: 0 6px;
  font-size: 10px; line-height: 16px;
  color: var(--accent); background: var(--accent-light);
  border-radius: var(--radius-xs); vertical-align: 1px;
}

/* ---- 搜索下拉空态 + 键盘高亮 ---- */
.search-empty { padding: 14px 12px; font-size: 12px; color: var(--text-disabled); text-align: center; }
.search-result-item.active { background: var(--bg-hover); }

/* ---- 选中态：品牌色左侧竖条 + 浅色背景（全站一致） ---- */
.wl-row.selected { background: var(--accent-light); box-shadow: inset 3px 0 0 var(--accent); }
.wl-row.nav-active { background: var(--bg-hover); }
.wl-row.selected.nav-active { background: var(--accent-light); }
.wl-row.dragging { opacity: .5; }
.wl-row.drag-over { box-shadow: inset 0 2px 0 var(--accent); }

/* ---- 卡片 hover：边框提亮 + 上浮 1px + 阴影加深（150–200ms） ---- */
.chart-card {
  transition: transform .18s ease, box-shadow .18s ease, border-color .18s ease;
}
.chart-card:hover {
  transform: translateY(-1px);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-lg);
}
.home-card { transition: border-color .18s ease, box-shadow .18s ease; }
.home-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-lg); }

/* ---- 数据密集区行高 ≥36px，避免误触 ---- */
.wl-row { min-height: 36px; }
.search-result-item { min-height: 36px; }
.wl-head { min-height: 28px; }

/* ===== 财报解读结构化卡片（20260902k）：信号横幅 + 分节 + 重点高亮 ===== */
.er-wrap { margin-top: 14px; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; }
.er-signal { display: flex; align-items: flex-start; gap: 10px; padding: 12px 14px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-left: 3px solid #8B949E; border-radius: 6px; }
.er-signal-pos { border-left-color: #F6465D; }
.er-signal-neg { border-left-color: #0ECB81; }
.er-badge { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; letter-spacing: 0.02em; white-space: nowrap; border: 1px solid rgba(139,148,158,0.35); color: #8B949E; background: rgba(139,148,158,0.08); flex: none; }
.er-badge-pos { color: #F6465D; border-color: rgba(246,70,93,0.35); background: rgba(246,70,93,0.08); }
.er-badge-neg { color: #0ECB81; border-color: rgba(14,203,129,0.35); background: rgba(14,203,129,0.08); }
.er-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
.er-verdict { font-size: 13px; font-weight: 600; color: var(--text-primary); line-height: 1.6; flex: 1; min-width: 0; }
.er-section { display: flex; flex-direction: column; gap: 8px; }
.er-sec-head { display: flex; align-items: center; gap: 8px; }
.er-sec-chip { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 4px; background: rgba(255,255,255,0.06); color: var(--text-secondary); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; flex: none; }
.er-sec-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.er-sec-pos .er-sec-title { color: #F6465D; }
.er-sec-pos .er-sec-chip { background: var(--tint-red); color: #F6465D; }
.er-sec-neg .er-sec-title { color: #0ECB81; }
.er-sec-neg .er-sec-chip { background: var(--tint-green); color: #0ECB81; }
.er-item { position: relative; padding-left: 12px; font-size: 12px; color: var(--text-secondary); line-height: 1.75; }
.er-item::before { content: ''; position: absolute; left: 0; top: 0.7em; width: 4px; height: 4px; border-radius: 50%; background: rgba(255,255,255,0.22); }
.er-para { font-size: 12px; color: var(--text-secondary); line-height: 1.75; }
.er-note { padding-left: 12px; font-size: 11px; color: var(--text-light); font-style: italic; line-height: 1.7; }
.er-cite { color: var(--text-light); }
.er-kw-pos { color: #F6465D; font-weight: 600; }
.er-kw-neg { color: #0ECB81; font-weight: 600; }
.er-num { font-variant-numeric: tabular-nums; font-weight: 600; }
.er-num-pos { color: #F6465D; }
.er-num-neg { color: #0ECB81; }
.er-num-num { color: var(--text-primary); }
/* 20260904b：财报解读标的身份徽标 + 串公司告警 */
.er-head { display: flex; flex-wrap: wrap; gap: 8px; }
.er-target { display: inline-flex; align-items: center; gap: 4px; padding: 3px 10px; border-radius: 4px; font-size: 12px; font-weight: 600; color: var(--accent, #F0B97B); border: 1px solid rgba(240,185,123,0.4); background: rgba(240,185,123,0.1); }
.er-mismatch{ padding: 10px 12px; border-radius: 6px; font-size: 12px; font-weight: 600; color: var(--accent); border: 1px solid rgba(240,185,123,0.45); background: rgba(240,185,123,0.10); }

/* ===== 首页·大盘技术分析（三大指数六步推演）===== */
.market-technical-card .home-card-head h3 { font-size: 15px; }
.market-technical-body { padding: 12px 16px 4px; }
.market-technical-note { padding: 4px 16px 14px; border-top: 1px solid var(--bg-hover); }

.mt-list { display: flex; flex-direction: column; gap: 12px; }
.mt-index { background: var(--bg-elevated, #1A212B); border: 1px solid var(--bg-hover); border-radius: 8px; padding: 12px 14px; }
.mt-index-error { color: var(--text-secondary); }
.mt-err { color: #F0B97B; font-size: 12px; margin-top: 4px; }

.mt-index-head { display: flex; align-items: baseline; gap: 10px; padding-bottom: 8px; border-bottom: 1px solid var(--bg-hover); margin-bottom: 8px; }
.mt-name { font-size: 15px; font-weight: 700; color: var(--text-primary); }
.mt-close { font-size: 16px; font-weight: 700; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.mt-chg { font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }
.mt-chg.mt-up { color: #F6465D; }
.mt-chg.mt-down { color: #0ECB81; }
.mt-date { margin-left: auto; font-size: 11px; color: var(--text-light); }

.mt-steps { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
.mt-step { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; }
.mt-step b { color: var(--text-primary); font-weight: 600; }

.mt-verdict { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mt-block { background: rgba(11,14,17,0.4); border: 1px solid var(--bg-hover); border-radius: 6px; padding: 9px 11px; }
.mt-block-title { font-size: 11px; font-weight: 700; color: var(--accent, #F0B97B); letter-spacing: 0.5px; margin-bottom: 5px; }
.mt-dir { font-size: 14px; font-weight: 700; margin-bottom: 3px; }
.mt-dir-bull { color: #F6465D; }
.mt-dir-bear { color: #0ECB81; }
.mt-dir-flat { color: var(--accent, #F0B97B); }
.mt-line { font-size: 12px; color: var(--text-secondary); line-height: 1.6; }
.mt-lv { color: var(--text-primary); font-variant-numeric: tabular-nums; }
.mt-watch { color: var(--text-primary); }
.mt-strategy { grid-column: 1 / -1; }
.mt-risk { grid-column: 1 / -1; margin-top: 2px; padding: 8px 11px; border-radius: 6px; font-size: 12px; color: var(--text-secondary); background: rgba(240,185,123,0.08); border-left: 3px solid var(--accent, #F0B97B); line-height: 1.6; }

.mt-synthesis { font-size: 13px; font-weight: 600; color: var(--text-primary); line-height: 1.6; margin-bottom: 4px; }
.mt-src { font-size: 11px; color: var(--text-light); }
.mt-fallback-note { margin-top: 6px; padding: 5px 9px; border: 1px solid rgba(240,185,123,.4); border-radius: 6px; background: rgba(240,185,123,.08); color: #f0b97b; font-size: 12px; line-height: 1.5; }

@media (max-width: 760px) {
  .mt-verdict { grid-template-columns: 1fr; }
  .mt-strategy, .mt-risk { grid-column: 1; }
  .mt-fused-row { grid-template-columns: 1fr; }
  .mt-fused-cols { grid-template-columns: 1fr; }
  .mt-anchors { flex-direction: column; }
}

/* ---------- 基金行业配置名单（全市场 · 持仓市值加总排名） ---------- */
.fmr-prog {
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--bg-card);
  margin-bottom: 12px;
}
.fmr-prog-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.fmr-prog-title { font-size: 13.5px; font-weight: 600; color: var(--text-primary); }
.fmr-prog-num { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.fmr-bar { height: 6px; border-radius: 4px; background: rgba(148,163,184,.16); overflow: hidden; margin: 8px 0 7px; }
.fmr-bar-in { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--accent), #f6d9a8); transition: width .5s ease; }
.fmr-prog-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-muted); }
.fmr-prog-meta .fmr-warn { color: var(--accent); }
.fmr-prog-hint { margin-top: 6px; font-size: 11px; color: var(--text-light); line-height: 1.6; }

/* 「自然季度更新」状态条 */
.fmr-quarter {
  padding: 10px 12px; border-radius: 10px; margin-bottom: 12px;
  background: rgba(240,185,123,.06); border: 1px solid rgba(240,185,123,.16);
}
.fmr-q-head { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 8px; }
.fmr-q-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.fmr-q-title b { color: var(--accent); font-weight: 600; }
.fmr-q-badge {
  font-size: 10.5px; font-weight: 500; padding: 2px 8px; border-radius: 999px; white-space: nowrap;
}
.fmr-qb-done { background: rgba(139,148,158,.14); color: var(--text-secondary); border: 1px solid rgba(139,148,158,.3); }
.fmr-qb-run  { background: rgba(139,148,158,.14);  color: var(--text-secondary);   border: 1px solid rgba(139,148,158,.3); }
.fmr-qb-wait { background: rgba(148,163,184,.14); color: var(--text-muted); border: 1px solid rgba(148,163,184,.28); }
.fmr-q-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: var(--text-muted); margin-top: 6px; }
.fmr-q-time { color: var(--text-light); }

.fmr-kpis { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.fmr-kpi {
  flex: 1 1 96px; min-width: 88px;
  border: 1px solid var(--border); border-radius: 9px;
  padding: 8px 10px; background: var(--bg-card);
}
.fmr-kpi-v { font-size: 16px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.fmr-kpi-l { font-size: 10.5px; color: var(--text-muted); margin-top: 2px; }

.fmr-table-wrap { overflow-x: auto; }
.fmr-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.fmr-table thead th {
  text-align: left; font-size: 11px; font-weight: 600; color: var(--text-muted);
  padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap;
}
.fmr-th-rank { width: 34px; text-align: center !important; }
.fmr-row { border-bottom: 1px dashed rgba(148,163,184,.14); }
.fmr-row:hover { background: rgba(240,185,123,.05); }
.fmr-row td { padding: 8px; vertical-align: middle; }
.fmr-rank { text-align: center; color: var(--text-light); font-variant-numeric: tabular-nums; font-weight: 600; }
.fmr-rank-top { color: var(--accent); font-size: 14px; }
.fmr-ind-name { display: block; color: var(--text-primary); font-weight: 600; font-size: 13px; }
.fmr-ind-sub { display: block; font-size: 10.5px; color: var(--text-light); margin-top: 2px; }
.fmr-val { min-width: 118px; }
.fmr-val-num { color: var(--accent); font-weight: 600; font-variant-numeric: tabular-nums; }
.fmr-val-bar { height: 4px; border-radius: 3px; background: rgba(148,163,184,.14); margin-top: 4px; overflow: hidden; }
.fmr-val-bar i { display: block; height: 100%; border-radius: 3px; background: linear-gradient(90deg, rgba(240,185,123,.85), rgba(240,185,123,.7)); }
.fmr-share { color: var(--text-secondary); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
/* 环比变化列（增持=红 / 减持=绿，遵循 A 股习惯） */
.fmr-th-chg { min-width: 104px; }
.fmr-th-chg i { display: block; font-style: normal; font-size: 9.5px; font-weight: 400; color: var(--text-light); margin-top: 1px; }
.fmr-chg { min-width: 104px; white-space: nowrap; }
.fmr-chg-num { display: block; font-weight: 600; font-variant-numeric: tabular-nums; font-size: 12.5px; }
.fmr-chg-pct { display: block; font-size: 10.5px; color: var(--text-muted); font-variant-numeric: tabular-nums; margin-top: 1px; }
.fmr-chg .fmr-up, .fmr-chg-num.fmr-up { color: var(--red); }
.fmr-chg .fmr-down, .fmr-chg-num.fmr-down { color: var(--green); }
.fmr-chg-flat { color: var(--text-muted); }
.fmr-chg-na { color: var(--text-light); }
.fmr-kpi-v .fmr-up { color: var(--red); }
.fmr-kpi-v .fmr-down { color: var(--green); }
.fmr-kpi-v .fmr-chg-flat { color: var(--text-primary); }
.fmr-more { margin-top: 8px; font-size: 11px; color: var(--text-light); text-align: center; }
.fmr-tops { min-width: 200px; }
.fmr-chip {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 10.5px; padding: 2px 7px; margin: 2px 4px 2px 0;
  border-radius: 999px; background: rgba(240,185,123,.09);
  color: var(--text-secondary); border: 1px solid rgba(240,185,123,.18);
  white-space: nowrap;
}
.fmr-chip b{ color: var(--text-primary); font-weight: 600; }
.fmr-row-unres { opacity: .68; }
.fmr-row-unres .fmr-val-num { color: var(--text-light); }
.fmr-row-unres .fmr-val-bar i { background: rgba(148,163,184,.5); }
.fmr-badge {
  margin-left: 6px; font-size: 10px; font-weight: 500;
  padding: 1px 6px; border-radius: 999px;
  background: rgba(148,163,184,.14); color: var(--text-light);
}

@media (max-width: 760px) {
  .fmr-kpi { flex: 1 1 72px; min-width: 72px; padding: 6px 8px; }
  .fmr-kpi-v { font-size: 14px; }
  /* 列序：# | 行业 | 持仓市值 | 环比 | 占比 | Top重仓股 → 窄屏只留 前 4 列 */
  .fmr-share, .fmr-table thead th:nth-child(5),
  .fmr-tops, .fmr-table thead th:nth-child(6) { display: none; }
}





/* ===== 20260914i：技术分析准确率检查条（大盘技术分析 / 个股技术面）===== */
.mt-accuracy { margin: 8px 14px 0; }
.mt-acc-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 7px 10px; background: rgba(240,185,123,0.06); border: 1px solid rgba(240,185,123,0.18); border-radius: 6px; }
.mt-acc-title { font-size: 12px; font-weight: 600; color: #F0B97B; white-space: nowrap; }
.mt-acc-chip { display: inline-flex; align-items: baseline; gap: 4px; padding: 2px 8px; border-radius: 4px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); font-size: 12px; }
.mt-acc-chip .mac-label { color: #8B949E; }
.mt-acc-chip .mac-value { font-weight: 700; font-family: ui-monospace, Consolas, monospace; }
.mt-acc-chip .mac-sub { color: #828B96; font-size: 11px; }
.mt-acc-chip.good .mac-value { color: #F6465D; }
.mt-acc-chip.mid .mac-value { color: #F0B97B; }
.mt-acc-chip.bad .mac-value { color: #0ECB81; }
.mt-acc-chip.muted { opacity: 0.65; }
.mt-acc-chip.muted .mac-value { color: #828B96; font-weight: 500; }
.mt-acc-note { font-size: 11px; color: #828B96; }
.mt-acc-warn { font-size: 11px; color: #F0B97B; }
.mt-acc-link { margin-left: auto; font-size: 12px; color: #58A6FF; text-decoration: none; white-space: nowrap; }
.mt-acc-link:hover { text-decoration: underline; }

@media (max-width: 720px) { .mt-acc-link { margin-left: 0; } }

/* ===== 20260914i：准确率入口链接 ===== */
.topbar-acc-link{display:inline-flex;align-items:center;gap:4px;margin-left:10px;padding:5px 12px;border-radius:8px;
  background:rgba(240,185,123,.12);border:1px solid rgba(240,185,123,.4);color:#F0B97B;
  font-size:13px;font-weight:600;text-decoration:none;white-space:nowrap;transition:all .18s ease;}
.topbar-acc-link:hover{background:rgba(240,185,123,.22);border-color:#F0B97B;}
.topbar-acc-small{margin-left:0;padding:3px 9px;border-radius:6px;font-size:12px;font-weight:500;}
.pa-acc-link{margin-left:auto;float:right;align-self:center;}
.pa-panel h3{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}

/* ===== 20260926a：策略回测校验模块 ===== */
.bt-wrap{max-width:1080px;margin:0 auto;padding:18px 20px 40px;}
.bt-header h2{margin:0 0 6px;font-size:19px;color:#E6EDF3;}
.bt-header .muted{color:#8B949E;font-size:13px;line-height:1.6;margin:0 0 16px;}
.bt-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px;}
.bt-controls label{font-size:13px;color:#8B949E;display:flex;align-items:center;gap:6px;}
.bt-controls select{background:#0D1117;border:1px solid #30363D;color:#E6EDF3;border-radius:6px;padding:6px 10px;font-size:13px;}
.bt-controls .btn-primary{background:rgba(240,185,123,.16);border:1px solid rgba(240,185,123,.5);color:#F0B97B;border-radius:8px;padding:7px 18px;font-size:14px;font-weight:600;cursor:pointer;transition:all .18s;}
.bt-controls .btn-primary:hover{background:rgba(240,185,123,.28);}
.bt-controls .btn-primary:disabled{opacity:.5;cursor:not-allowed;}
.bt-status{font-size:13px;color:#8B949E;}
.bt-status.err{color:#F0B97B;}
.bt-status.ok{color:#8B949E;}
#btDsl{width:100%;min-height:150px;background:#0D1117;border:1px solid #30363D;border-radius:8px;color:#C9D1D9;
  font-family:'SFMono-Regular',Consolas,monospace;font-size:13px;line-height:1.6;padding:12px 14px;resize:vertical;margin-bottom:18px;}
.bt-section{background:#161B22;border:1px solid #21262D;border-radius:10px;padding:16px 18px;margin-bottom:16px;}
.bt-section h3{margin:0 0 12px;font-size:15px;color:#F0B97B;display:flex;align-items:center;gap:8px;}
.bt-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.bt-metric{background:#0D1117;border:1px solid #21262D;border-radius:8px;padding:10px 12px;}
.bt-metric .k{font-size:12px;color:#8B949E;margin-bottom:4px;}
.bt-metric .v{font-size:17px;font-weight:700;color:#E6EDF3;}
.bt-metric .v.up{color:#F6465D;}
.bt-metric .v.down{color:#0ECB81;}
.bt-table{width:100%;border-collapse:collapse;font-size:13px;}
.bt-table th,.bt-table td{text-align:left;padding:8px 10px;border-bottom:1px solid #21262D;}
.bt-table th{color:#8B949E;font-weight:600;}
.bt-table td.factor{color:#F0B97B;font-weight:600;}
.bt-verdict{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;border-radius:10px;font-size:15px;font-weight:700;}
.bt-verdict.PASS{background:rgba(246,70,93,.14);border:1px solid rgba(246,70,93,.5);color:#F6465D;}
.bt-verdict.WARNING{background:rgba(240,185,123,.14);border:1px solid rgba(240,185,123,.5);color:#F0B97B;}
.bt-verdict.REJECT{background:rgba(14,203,129,.14);border:1px solid rgba(14,203,129,.5);color:#0ECB81;}
.bt-verdict.INSUFFICIENT_SAMPLE{background:rgba(127,168,201,.14);border:1px solid rgba(127,168,201,.5);color:#7FA8C9;}
.bt-ps-bars{display:flex;flex-direction:column;gap:6px;margin:10px 0 4px;}
.bt-ps-row{display:flex;align-items:center;gap:10px;font-size:12.5px;}
.bt-ps-name{flex:0 0 210px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:.9;}
.bt-ps-track{flex:1;height:10px;background:rgba(127,168,201,.16);border-radius:6px;overflow:hidden;}
.bt-ps-track i{display:block;height:100%;background:#7FA8C9;border-radius:6px;}
.bt-ps-track i.bt-ps-top{background:#F0B97B;}
.bt-ps-val{flex:0 0 52px;text-align:right;opacity:.75;font-variant-numeric:tabular-nums;}
/* 幸存者偏差证据块：中性蓝=有证据，金=无证据保底（避开红绿涨跌语义） */
.bt-evidence{margin-top:12px;border:1px solid #21262D;border-radius:8px;padding:10px 12px;background:#0D1117;}
.bt-evidence.bt-sv-ok{border-color:rgba(127,168,201,.45);background:rgba(127,168,201,.06);}
.bt-evidence.bt-sv-warn{border-color:rgba(240,185,123,.4);background:rgba(240,185,123,.06);}
.bt-ev-title{font-size:13px;color:#E6EDF3;margin-bottom:6px;}
.bt-ev-title b{color:#7FA8C9;}
.bt-evidence.bt-sv-warn .bt-ev-title b{color:#F0B97B;}
.bt-ev-body{font-size:12.5px;color:#9DA7B3;line-height:1.7;}
.bt-ev-src{font-size:11.5px;color:#828B96;margin-top:6px;}
.bt-advice{margin-top:10px;font-size:13px;color:#C9D1D9;line-height:1.6;}
.bt-note{font-size:12px;color:#828B96;margin-top:8px;line-height:1.6;}
.bt-diag{font-size:12px;color:#8B949E;margin-top:6px;}
.bt-hint{font-size:12px;color:#8B949E;margin:10px 0 0;line-height:1.6;}
.btn-primary.bt-auto{background:linear-gradient(135deg,#F0B97B,#E08A3C);color:#1A1208;border-color:transparent;font-weight:700;}
.btn-secondary{background:#21262D;color:#E6EDF3;border:1px solid #30363D;padding:7px 16px;border-radius:8px;cursor:pointer;font-size:13px;}
.btn-secondary:hover{background:#2D333B;}
.bt-dsl{margin-top:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:#9DA7B3;background:#0D1117;border:1px solid #21262D;border-radius:8px;padding:8px 10px;line-height:1.7;}
.bt-warn{margin-top:10px;font-size:12px;color:#F0B97B;background:rgba(240,185,123,.08);border:1px solid rgba(240,185,123,.35);border-radius:8px;padding:8px 10px;line-height:1.7;}
.bt-best-row{ background:rgba(246,70,93,.06); }
.bt-best-row td{font-weight:600;}
.bt-cat{border-top:1px solid #21262D;margin-top:14px;padding-top:12px;}
.bt-cat:first-child{border-top:none;margin-top:0;padding-top:0;}
.bt-cat-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;padding:0 2px;}
.bt-cat-name{font-size:14px;font-weight:700;color:#E6EDF3;}
.bt-cat-meta{font-size:12px;color:#8B949E;}
.bt-current{font-size:13px;color:#8B949E;white-space:nowrap;margin-right:4px;}
.bt-current.ok{color:#E6EDF3;font-weight:600;}
.bt-current.err{color:#F0B97B;}
.bt-advanced{margin-top:10px;}
.bt-advanced>summary{cursor:pointer;font-size:12px;color:#8B949E;padding:6px 0;outline:none;}
.bt-advanced>summary:hover{color:#F0B97B;}
.bt-advanced>summary::-webkit-details-marker{display:none;}
.bt-advanced>summary::before{content:'▸ ';}
.bt-advanced[open]>summary::before{content:'▾ ';}
.bt-advanced #btRun{margin-top:10px;}
.bt-presets{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 12px;}
.bt-preset{background:#0D1117;border:1px solid #30363D;color:#C9D1D9;border-radius:8px;padding:7px 12px;font-size:13px;cursor:pointer;transition:all .18s;}
.bt-preset:hover{border-color:#F0B97B;color:#F0B97B;background:rgba(240,185,123,.08);}
.bt-preset:active{transform:scale(.97);}

/* ===== 数据诚实原则·状态徽标（20261002b） ===== */
.ds-badge{display:inline-block;font-size:12px;line-height:1.5;padding:2px 9px;border-radius:10px;margin:2px 0;font-weight:600;}
.ds-fresh{background:rgba(139,148,158,.14);color:#8B949E;border:1px solid rgba(139,148,158,.35);}
.ds-stale{background:rgba(240,185,123,.14);color:#F0B97B;border:1px solid rgba(240,185,123,.4);}
.ds-failed{background:rgba(246,72,92,.14);color:#F0B97B;border:1px solid rgba(246,72,92,.4);}
.dy-note.dy-failed{color:#F0B97B;font-weight:600;border-left:3px solid #F0B97B;padding:6px 10px;background:rgba(246,72,92,.08);border-radius:6px;}

/* ============ [20261003e] 卡片化表格增强（只改视觉） ============ */
/* 冻结表头：表格容器纵向滚动时表头吸顶 */
.fmr-table-wrap { max-height: 620px; overflow-y: auto; scrollbar-width: thin; }
.fmr-table thead th { position: sticky; top: 0; background: #161B22; z-index: 3; box-shadow: 0 1px 0 rgba(255,255,255,0.06); }
.metrics-table-wrap, .sh-table-wrap, .cap-table-wrap { max-height: 480px; overflow-y: auto; }
.metrics-table thead th, .sh-table thead th { position: sticky; top: 0; background: #161B22; z-index: 3; }
/* 斑马纹 + 行悬浮高亮 */
.fmr-table tbody tr:nth-child(even) { background: rgba(255,255,255,0.018); }
.fmr-table tbody tr:hover { background: rgba(240,185,123,0.06); }
.metrics-table > div:nth-child(even), .cap-table-row:nth-child(even) { background: rgba(255,255,255,0.018); }
/* 涨跌色块：数字带底色圆角块，红涨绿跌 */
.fmr-chg-num.fmr-up, .fmr-chg-num.fmr-down { display: inline-block; padding: 1px 8px; border-radius: 4px; margin-top: 2px; }
.fmr-chg-num.fmr-up { background: var(--tint-red); color: #F6465D; }
.fmr-chg-num.fmr-down { background: var(--tint-green); color: #0ECB81; }
.fmr-chg-pct { margin-top: 3px; }
/* 首列排名徽章 */
.fmr-rank { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; border-radius: 6px; background: rgba(148,163,184,0.10); }
.fmr-rank-top { background: linear-gradient(135deg, rgba(240,185,123,0.28), rgba(240,185,123,0.10)); color: #F0B97B; box-shadow: 0 0 10px rgba(240,185,123,0.18); }

/* ============================================================
   20261006a：工作台逻辑模型（「总—分」树状弹层 · .lm-*）
   注意：本项目 .hidden 不是全局类，新容器必须自己声明，否则 class="hidden" 无效。
   ============================================================ */
.lm-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.62); display: flex; align-items: center; justify-content: center; z-index: 1100; padding: 3vh 2vw; }
.lm-modal-overlay.hidden { display: none; }
.lm-modal {
  width: 1120px; max-width: 96vw; max-height: 92vh; display: flex; flex-direction: column;
  background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius);
  box-shadow: 0 16px 48px rgba(0,0,0,0.5); overflow: hidden;
}
.lm-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); }
.lm-modal-head h3 { margin: 0; font-size: 16px; color: var(--text-primary); display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.lm-head-sub { font-size: 12px; font-weight: 400; color: var(--text-light); margin-left: 10px; }
/* 20261025f：.lm-page-head / .lm-head-actions / .lm-tool-btn 已随独立页页头统一为 .jd-header / .jd-actions / .btn-secondary，规则删除 */
.lm-modal-body { padding: 18px 22px 24px; overflow-y: auto; flex: 1; }
.lm-modal-foot { padding: 10px 18px; border-top: 1px solid var(--border); background: var(--bg-primary); font-size: 12px; color: var(--text-light); line-height: 1.6; }
.lm-intro { font-size: 13px; line-height: 1.85; color: var(--text-secondary); margin: 0 0 14px; padding: 10px 14px; background: var(--bg-hover); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.lm-hl { color: var(--accent); }

/* 「总」根节点 */
.lm-root { display: flex; align-items: center; gap: 9px; margin-bottom: 4px; }
.lm-root-tag { flex: none; font-size: 11.5px; font-weight: 700; padding: 2px 9px; border-radius: 4px; color: #0b0e14; background: linear-gradient(135deg, #F0B97B, #cfa87c); }
.lm-root-name { font-size: 17px; font-weight: 700; color: var(--text-primary); letter-spacing: .3px; }
.lm-root-desc { padding: 2px 0 12px 0 !important; color: var(--text-secondary); }

/* 节点 */
.lm-node { position: relative; }
.lm-node.lm-lv1 {
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: rgba(255,255,255,0.02);
  padding: 10px 14px 12px; margin-bottom: 12px;
}
.lm-node.lm-lv1 > .lm-row .lm-name { font-size: 15px; font-weight: 700; color: var(--text-primary); }
.lm-node.lm-lv2 { margin-top: 7px; }
.lm-node.lm-lv2 > .lm-row .lm-name { font-size: 13.5px; font-weight: 600; color: #F0B97B; }
.lm-node.lm-lv3 > .lm-row .lm-name, .lm-node.lm-lv4 > .lm-row .lm-name { font-size: 13px; color: var(--text-primary); }
.lm-row { display: flex; align-items: center; gap: 7px; padding: 3px 4px; border-radius: 5px; }
.lm-row-parent { cursor: pointer; }
.lm-row-parent:hover { background: rgba(240,185,123,0.07); }
.lm-caret { background: none; border: none; color: var(--text-light); font-size: 11px; line-height: 1; padding: 2px 3px; cursor: pointer; flex: none; transition: transform .15s ease; }
.lm-node.lm-collapsed > .lm-row .lm-caret { transform: rotate(-90deg); }
.lm-node.lm-collapsed > .lm-children { display: none; }
.lm-dot { flex: none; width: 5px; height: 5px; border-radius: 50%; background: var(--border-strong); margin: 0 3px; }
.lm-icon { flex: none; font-size: 15px; }
.lm-name { line-height: 1.65; }
.lm-badge { flex: none; font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 4px; color: var(--accent); background: rgba(240,185,123,0.14); }
.lm-count { margin-left: auto; flex: none; font-size: 11.5px; color: var(--text-light); white-space: nowrap; }
.lm-node.lm-lv1 > .lm-row .lm-count { color: var(--text-secondary); }
.lm-desc { font-size: 12.5px; line-height: 1.78; color: var(--text-secondary); padding: 2px 0 4px 26px; }
/* 判定逻辑 / 数据来源 / 输出去向（20261013h：按页面布局新增字段）——避开红绿涨跌语义，用金/蓝/青 */
.lm-logic { margin: 3px 0 5px 26px !important; padding: 6px 10px !important; background: rgba(240,185,123,0.06); border-left: 2px solid rgba(240,185,123,0.45); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; color: var(--text-primary); }
.lm-k { display: inline-block; font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 4px; margin-right: 6px; vertical-align: 1px; white-space: nowrap; }
.lm-k-logic { color: #F0B97B; background: rgba(240,185,123,0.14); }
.lm-li { display: block; margin-top: 3px; }
.lm-io { margin: 0 0 5px 26px; padding: 5px 10px; background: var(--bg-hover); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.lm-io-row { font-size: 12px; line-height: 1.75; color: var(--text-secondary); }
.lm-io-row + .lm-io-row { margin-top: 2px; }
.lm-k-in { color: #8AB4F8; background: rgba(138,180,248,0.12); }
.lm-k-out { color: #6FD3C4; background: rgba(111,211,196,0.12); }
.lm-io-list i { color: var(--text-light); font-style: normal; }
.lm-children { margin-left: 12px; padding-left: 14px; border-left: 1px dashed rgba(148,163,184,0.22); }
@media (max-width: 768px) {
  .lm-modal { max-height: 94vh; }
  .lm-modal-body { padding: 12px 12px 18px; }
  .lm-count { display: none; }
}

/* ===== 20261025f：独立长页统一外壳（notes / accuracy / judgments / logic-model 四页共用） =====
   统一约定（详见 DESIGN.md §12）：
   - 页宽阶梯：notes 808px（760 阅读列）/ accuracy·judgments 1148px（1100 数据列，与首页 .home-card 同宽）/ logic-model 1328px（1280 宽树列）
   - 页头：统一 .jd-header（标题居左 21px/700、动作居右、下边框分隔、18px 顶部呼吸）
   - 工具条：统一 sticky 悬浮（.np-toolbar / .acc-toolbar / .jd-toolbar 同一套）
   - 芯片：统一页面级 tab/筛选芯片（.np-tab / .acc-tab / .jd-tag 同一套，金令牌着色，不涉涨跌语义）
   - 空态：统一大空盒（虚线框居中）；表格单元格内的小空态不受影响
   - 滚动：html,body 覆盖须同时改 html，无法由共享样式表达，保留为各页唯一页内规则 */
.np-page, .acc-page, .jd-page, .lm-page { min-height: 100vh; margin: 0 auto; padding: 0 24px 48px; }
.np-page { max-width: 808px; }
.acc-page, .jd-page { max-width: 1148px; }
.lm-page { max-width: 1328px; }

/* 页头：四页统一节奏（基础 .jd-header 见上文 jd-* 段，此处仅补页内边距与分隔线） */
.np-page .jd-header, .acc-page .jd-header, .jd-page .jd-header, .lm-page .jd-header { padding: 18px 0 14px; border-bottom: 1px solid var(--border); }

/* sticky 工具条：同一套（滚动时内容从其下穿过，实底 bg-primary 遮挡） */
.np-toolbar, .acc-toolbar, .jd-toolbar { position: sticky; top: 0; z-index: 20; background: var(--bg-primary); padding: 10px 0 12px; border-bottom: 1px solid var(--border); margin: 0 0 16px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

/* 页面级芯片（tab / 筛选）：同一套（active = 金淡底 + 金字，模式 B 徽章，容器为 --bg-card 深表面达标） */
.np-tab, .acc-tab, .jd-tag { padding: 6px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-card); color: var(--text-primary); cursor: pointer; font-size: 13px; transition: border-color .15s, background .15s, color .15s; }
.np-tab:hover, .acc-tab:hover, .jd-tag:hover { border-color: var(--accent); color: var(--accent); }
.np-tab.active, .acc-tab.active, .jd-tag.active { background: var(--accent-light); border-color: var(--accent); color: var(--accent); font-weight: 600; }

/* notes 页：单列流式 + 折叠摘要（20261025d 交互，样式并入单一来源） */
.np-list { display: flex; flex-direction: column; gap: 16px; margin: 16px 0 0; }
.np-count { font-size: 12px; color: var(--text-light); margin-left: 6px; font-variant-numeric: tabular-nums; }
.note-content.is-clamped { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.note-actions .btn-expand { font-size: 11.5px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-card); color: var(--text-secondary); cursor: pointer; }

/* ===== 20261103i：大盘记录数据库检索面板（notes.html?scope=market 专属；红涨绿跌语义） ===== */
.mldb-panel { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; margin: 16px 0 0; }
.mldb-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.mldb-title { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.mldb-stats { font-size: 12px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.mldb-form { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mldb-input { padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-primary); font-size: 12.5px; }
.mldb-input:focus { outline: none; border-color: var(--accent); }
.mldb-q { width: 220px; }
.mldb-sector { width: 180px; }
.mldb-dir { width: 110px; }
.mldb-date { width: 140px; color-scheme: dark; }
.mldb-sep { color: var(--text-light); font-size: 12px; }
.mldb-btn { padding: 6px 16px; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent-light); color: var(--accent); font-size: 12.5px; cursor: pointer; font-weight: 600; }
.mldb-btn:hover { filter: brightness(1.1); }
.mldb-btn-ghost { background: var(--bg-card); border-color: var(--border); color: var(--text-secondary); font-weight: 400; }
.mldb-tip { margin-top: 8px; font-size: 11.5px; color: var(--text-light); line-height: 1.6; }
.mldb-err { color: var(--accent); font-size: 12px; margin-top: 6px; min-height: 0; }
.mldb-result-head { font-size: 12.5px; color: var(--text-secondary); padding: 2px 2px 0; }
.mldb-result-head b { color: var(--accent); }
.mldb-row { background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 14px; }
.mldb-row-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.mldb-date { font-size: 13px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.mldb-dir { font-size: 12px; font-weight: 600; padding: 1px 8px; border-radius: 10px; }
/* 红涨绿跌：up=红 / down=绿 / flat·未知=中性灰（全站语义，勿反） */
.mldb-dir.up { color: var(--red); background: var(--red-light); }
.mldb-dir.down { color: var(--green); background: var(--green-light); }
.mldb-dir.flat { color: var(--text-secondary); background: var(--bg-primary); }
.mldb-src { font-size: 11px; color: var(--text-light); }
.mldb-idx { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; font-variant-numeric: tabular-nums; }
.mldb-idx .mi-up { color: var(--red); font-style: normal; }
.mldb-idx .mi-down { color: var(--green); font-style: normal; }
.mldb-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.mldb-chip-label { font-size: 11px; color: var(--text-light); }
.mldb-chip { font-size: 11px; padding: 1px 8px; border-radius: 9px; border: 1px solid var(--border); color: var(--text-secondary); }
.mldb-chip.up { color: var(--red); border-color: rgba(246, 70, 93, 0.4); }
.mldb-chip.down { color: var(--green); border-color: rgba(14, 203, 129, 0.4); }
.mldb-summary { font-size: 12.5px; color: var(--text-primary); line-height: 1.7; }
.mldb-full { font-size: 12.5px; color: var(--text-primary); line-height: 1.8; margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); }
.mldb-row-actions { margin-top: 6px; }
.mldb-toggle { font-size: 11.5px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-primary); color: var(--text-secondary); cursor: pointer; }
.mldb-toggle:hover { border-color: var(--accent); color: var(--accent); }

/* accuracy 页：口径提示 + KPI 行（令牌取色；good=红 涨语义 / bad=绿 跌语义，与全站红涨绿跌一致） */
.acc-tabs { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.acc-kpis { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; }
.acc-kpi { flex: 1 1 150px; padding: 12px 14px; border-radius: var(--radius); background: var(--bg-card); border: 1px solid var(--border); }
.acc-kpi .k-label { font-size: 12px; color: var(--text-secondary); }
.acc-kpi .k-value { font-size: 22px; font-weight: 700; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; margin-top: 4px; }
.acc-kpi .k-sub { font-size: 12px; color: var(--text-light); margin-top: 2px; }
.acc-kpi.good .k-value { color: var(--red); }
.acc-kpi.mid .k-value { color: var(--accent); }
.acc-kpi.bad .k-value { color: var(--green); }
.acc-kpi.na .k-value { color: var(--text-light); font-size: 16px; }
.acc-hint { font-size: 12px; color: var(--text-secondary); margin: 10px 0; line-height: 1.7; }

/* 20261103e：数据巡检（跨板块一致性核对）逐股明细表（令牌取色） */
.ca-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-top: 6px; }
.ca-table th, .ca-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.ca-table th { color: var(--text-secondary); font-weight: 600; white-space: nowrap; }
.ca-table td.ca-note { color: var(--text-secondary); line-height: 1.6; word-break: break-all; }
.ca-table tbody tr:last-child td { border-bottom: none; }
.acc-hint code { background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 3px; }

/* 统一大空盒：notes 列表 / judgments 记录列表与准确率区 / accuracy 记录区（虚线框居中；基类小空态保留原样） */
.np-list .notes-empty, .record-list .jd-empty, .acc-body .jd-empty, .acc-body .data-empty { padding: 48px 20px; text-align: center; color: var(--text-secondary); font-size: 13px; line-height: 1.7; background: none; border: 1px dashed var(--border); border-radius: var(--radius); }

/* logic-model 页：树主体与脚注节奏（20261025f 从页内样式并入） */
.lm-page-body { padding: 18px 22px 24px; }
.lm-page-foot { padding: 10px 18px; border-top: 1px solid var(--border); font-size: 12px; color: var(--text-light); line-height: 1.6; }

/* ===== 20261016：动效无障碍（WCAG 2.3.3 前庭安全，系统关闭动画时全站降级） ===== */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* ===== 笔记云端同步状态提示（20261028b）：保存失败必须醒目可见，禁止静默丢失 ===== */
.notes-sync-toast {
  position: fixed; top: 14px; left: 50%; transform: translateX(-50%);
  z-index: 99999; max-width: 680px; padding: 10px 16px; border-radius: 10px;
  font-size: 13px; line-height: 1.7; box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  display: none;
}
.notes-sync-toast.warn { background: #2a1f10; border: 1px solid #F0B97B; color: #F0B97B; }
.notes-sync-toast.ok   { background: #10231c; border: 1px solid #8B949E; color: #8B949E; }

/* 20261104b：增长口径一键切换按钮（左卡「关键财务指标」卡头；单季 ↔ 累计） */
.growth-caliber-btn {
  float: right; margin-left: 8px; margin-top: -2px;
  padding: 3px 10px; font-size: 11px; font-weight: 600; line-height: 1.4;
  color: var(--accent); background: rgba(240, 185, 123, 0.10);
  border: 1px solid rgba(240, 185, 123, 0.35); border-radius: 6px;
  cursor: pointer; white-space: nowrap;
  transition: background 0.15s ease, transform 0.15s ease;
}
.growth-caliber-btn:hover { background: rgba(240, 185, 123, 0.22); }
.growth-caliber-btn:active { transform: scale(0.95); }
.growth-caliber-btn:disabled { opacity: 0.5; cursor: wait; }

/* ===== 20261107q：每日复盘页 DailyReviewPage（/daily-review，独立长页） =====
   沿用独立页统一外壳 .jd-page / .jd-header / .jd-toolbar / .np-tab；
   softDark 主题；A 股语义红涨绿跌（+红 / -绿），缺失用琥珀而非绿色，避免语义错位。 */
.dr-page { padding-bottom: 64px; }
.dr-subtitle { font-size: 12.5px; color: var(--text-light, #8B949E); margin-top: 4px; }
.home-action-btn-accent { border-color: rgba(240,185,123,0.45); color: var(--accent, #F0B97B); }
.home-action-btn-accent:hover { background: rgba(240,185,123,0.12); border-color: var(--accent, #F0B97B); }

.dr-statusbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 14px 0 0; }
.dr-spacer { flex: 1 1 auto; }
.dr-chip { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-card, #161B22); color: var(--text-secondary, #8B949E); white-space: nowrap; }
.dr-chip-trading{ color: var(--text-secondary, #8B949E); border-color: rgba(139,148,158,0.45); background: rgba(139,148,158,0.08); }
.dr-chip-holiday { color: var(--accent, #F0B97B); border-color: rgba(240,185,123,0.45); background: rgba(240,185,123,0.08); }
.dr-chip-running { color: var(--accent, #F0B97B); border-color: rgba(240,185,123,0.5); }
.dr-meta { font-size: 11.5px; color: var(--text-light, #8B949E); }
.dr-mono { font-variant-numeric: tabular-nums; font-size: 11.5px; color: var(--text-secondary, #8B949E); }

/* 复盘正文日期抬头：明确当前展示的是哪一天复盘，消除「左上日期≠菜单日期」误解 */
.dr-review-date { font-size: 15px; font-weight: 600; color: var(--text-secondary, #8B949E); margin: 4px 0 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.dr-review-date span { color: var(--accent, #F0B97B); }

.dr-toolbar { gap: 8px; }
.dr-input { background: var(--bg-primary, #0B0E11); border: 1px solid var(--border); color: var(--text-primary, #E6EDF3); border-radius: var(--radius-sm, 6px); padding: 6px 10px; font-size: 12.5px; color-scheme: dark; font-family: inherit; }
.dr-input:focus { outline: none; border-color: var(--accent, #F0B97B); }
.dr-btn { padding: 6px 12px; font-size: 12.5px; }
.dr-toolbar-note { font-size: 11.5px; color: var(--accent, #F0B97B); margin-left: 4px; }

.dr-main { min-height: 160px; }
.dr-loading, .dr-empty { text-align: center; padding: 48px 16px; color: var(--text-light, #8B949E); font-size: 13px; border: 1px dashed var(--border); border-radius: var(--radius, 10px); margin-top: 16px; }
.dr-notice { margin-top: 16px; padding: 10px 14px; border-radius: 8px; font-size: 12.5px; color: var(--accent, #F0B97B); background: rgba(240,185,123,0.08); border: 1px solid rgba(240,185,123,0.3); }
.dr-versionbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 14px; font-size: 12px; color: var(--text-light, #8B949E); }
.dr-ver-btn { padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg-card, #161B22); color: var(--text-secondary, #8B949E); font-size: 11.5px; cursor: pointer; }
.dr-ver-btn:hover { border-color: var(--accent, #F0B97B); color: var(--accent, #F0B97B); }

.dr-sections { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.dr-section { background: var(--bg-card, #161B22); border: 1px solid var(--border); border-left: 3px solid var(--border); border-radius: var(--radius, 10px); padding: 14px 16px; }
.dr-sec-ok { border-left-color: rgba(139,148,158,0.5); }
.dr-sec-partial { border-left-color: rgba(240,185,123,0.6); }
.dr-sec-missing { border-left-color: rgba(139,148,158,0.5); }
.dr-sec-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; cursor: pointer; user-select: none; outline: none; }
.dr-sec-head:focus-visible { box-shadow: 0 0 0 2px rgba(240,185,123,0.45); border-radius: 6px; }
.dr-sec-chevron {
  width: 0; height: 0; flex: none;
  border-top: 5px solid var(--text-light, #8B949E);
  border-left: 4px solid transparent;
  border-right: 4px solid transparent;
  margin-right: 2px;
  transition: transform 0.15s ease;
}
.dr-section.dr-sec-collapsed > .dr-sec-head .dr-sec-chevron { transform: rotate(-90deg); }
.dr-section.dr-sec-collapsed > .dr-sec-body { display: none; }
.dr-sec-no { font-size: 11px; color: var(--text-light, #8B949E); font-variant-numeric: tabular-nums; background: var(--bg-hover); border-radius: 4px; padding: 2px 6px; }
.dr-sec-title { font-size: 15px; font-weight: 600; color: var(--text-primary, #E6EDF3); margin: 0; }
.dr-sec-badge { margin-left: auto; font-size: 11px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--border); color: var(--text-secondary, #8B949E); }
.dr-sec-ok .dr-sec-badge{ color: var(--text-light, #8B949E); border-color: rgba(139,148,158,0.4); }
.dr-sec-partial .dr-sec-badge { color: var(--accent, #F0B97B); border-color: rgba(240,185,123,0.4); }
.dr-sec-missing .dr-sec-badge { color: var(--text-light, #8B949E); }
.dr-sec-body { font-size: 13px; color: var(--text-primary, #E6EDF3); line-height: 1.8; }
/* 段落折叠工具栏：全部折叠 / 全部展开 */
.dr-sec-toolbar { display: flex; justify-content: flex-end; margin: 12px 0 2px; }
.dr-sec-toggle-all {
  font-size: 12px; color: var(--text-secondary, #8B949E);
  background: var(--bg-card, #161B22); border: 1px solid var(--border);
  border-radius: 999px; padding: 5px 14px; cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;
}
.dr-sec-toggle-all:hover { border-color: var(--accent, #F0B97B); color: var(--accent, #F0B97B); }
.dr-line { margin: 0 0 6px; }
.dr-line:last-child { margin-bottom: 0; }
.dr-bullets { margin: 8px 0 0; padding-left: 20px; }
.dr-bullets li { margin: 4px 0; }
.dr-metrics { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.dr-metric { display: flex; flex-direction: column; gap: 2px; background: var(--bg-hover); border-radius: 6px; padding: 6px 12px; }
.dr-metric-k { font-size: 11px; color: var(--text-light, #8B949E); }
.dr-metric-v { font-size: 13px; font-variant-numeric: tabular-nums; }

/* A 股：涨红跌绿（仅用于数值符号，不用于状态徽标） */
.dr-up { color: var(--red, #F6465D); }
.dr-down { color: var(--green, #0ECB81); }

.dr-table-wrap { overflow-x: auto; margin-top: 10px; }
.dr-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dr-table th, .dr-table td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.dr-table th { color: var(--text-light, #8B949E); font-weight: 600; background: var(--bg-hover); white-space: nowrap; }
.dr-table td { color: var(--text-secondary, #8B949E); word-break: break-word; }
.dr-pass{ color: var(--text-secondary, #8B949E); }
.dr-fail { color: var(--accent, #F0B97B); }
.dr-warn { color: var(--text-secondary, #8B949E); }

.dr-holiday-box, .dr-fail-box { margin-top: 20px; text-align: center; padding: 36px 20px; border: 1px dashed var(--border); border-radius: var(--radius, 10px); background: var(--bg-card, #161B22); }
.dr-holiday-icon { font-size: 32px; margin-bottom: 8px; }
.dr-holiday-box h2, .dr-fail-box h2 { font-size: 18px; color: var(--text-primary, #E6EDF3); margin: 0 0 10px; }
.dr-holiday-box p, .dr-fail-box p { font-size: 13px; color: var(--text-secondary, #8B949E); margin: 6px 0; }
.dr-fail-box .dr-bullets { text-align: left; max-width: 640px; margin: 12px auto 0; }
.dr-holiday-box .btn-secondary { margin-top: 14px; }
.dr-history { margin-top: 20px; }
.dr-history-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 10px; }
.dr-history-title { font-size: 15px; font-weight: 600; color: var(--text-primary, #E6EDF3); }
.dr-link { background: transparent; border: none; color: var(--accent, #F0B97B); cursor: pointer; font-size: 12px; padding: 0; text-decoration: underline; }
.hidden { display: none !important; }
@media (max-width: 700px) {
  .dr-page { padding: 0 14px 48px; }
  .dr-statusbar { gap: 6px; }
  .dr-section { padding: 12px; }
}

/* ===== 20261108：每日复盘 · 固定 14 段新字段渲染（仅追加，不改动上方既有 .dr- 规则） =====
   四段式结论 quads / 风险条目 risks / grade·verdict 徽标 / 有限分析版 / 宽表横向滚动。
   风险等级红绿属「级别」语义，页面已用图例声明与行情红涨绿跌无关。 */

/* —— 有限分析版徽标（状态条） —— */
.dr-limited-chip {
  color: var(--accent, #F0B97B);
  border-color: rgba(240,185,123,0.5);
  background: rgba(240,185,123,0.10);
  font-weight: 600;
}

/* —— 通用：缺失文本 —— */
.dr-missing { color: var(--text-light, #8B949E); font-style: normal; }

/* —— 四段式结论卡片 quads —— */
.dr-quads {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
.dr-quad {
  background: var(--bg-card, #161B22);
  border: 1px solid rgba(230,237,243,0.10);
  border-radius: 8px;
  padding: 12px 14px;
  transition: border-color 0.15s ease;
}
.dr-quad:hover { border-color: rgba(230,237,243,0.22); }
.dr-quad-subject {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #E6EDF3);
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(230,237,243,0.10);
}
.dr-quad-rows { display: flex; flex-direction: column; gap: 8px; }
.dr-quad-row { display: flex; align-items: baseline; gap: 8px; }
.dr-quad-label {
  flex: 0 0 auto;
  font-size: 11.5px;
  line-height: 1.6;
  white-space: nowrap;
}
.dr-quad-label::before {
  content: '';
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  margin-right: 6px;
  vertical-align: middle;
}
.dr-quad-text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary, #E6EDF3);
  word-break: break-word;
}
.dr-quad-fact .dr-quad-label { color: #58A6FF; }
.dr-quad-judgment .dr-quad-label { color: var(--accent, #F0B97B); }
.dr-quad-verify .dr-quad-label { color: #A78BFA; }
.dr-quad-invalidate .dr-quad-label { color: #8B949E; }

/* —— 风险条目 risks —— */
.dr-risks { display: flex; flex-direction: column; gap: 10px; margin-top: 12px; }
.dr-risk-legend { font-size: 11px; color: var(--text-light, #8B949E); line-height: 1.5; }
.dr-level-high { color: #F5C894; }
.dr-level-mid { color: #D9A566; }
.dr-level-low { color: #B08B57; }
.dr-level-unknown { color: #8B949E; }
.dr-risk {
  background: var(--bg-card, #161B22);
  border: 1px solid rgba(230,237,243,0.10);
  border-radius: 8px;
  padding: 10px 12px;
  transition: border-color 0.15s ease;
}
.dr-risk:hover { border-color: rgba(230,237,243,0.22); }
.dr-risk-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.dr-risk-code {
  font-size: 11px;
  color: var(--text-light, #8B949E);
  font-variant-numeric: tabular-nums;
  background: var(--bg-hover);
  border-radius: 4px;
  padding: 2px 6px;
}
.dr-risk-title { font-size: 13px; font-weight: 600; color: var(--text-primary, #E6EDF3); }
.dr-level-badge {
  margin-left: auto;
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid currentColor;
  background: rgba(230,237,243,0.04);
  white-space: nowrap;
}
.dr-risk-lines { display: flex; flex-direction: column; gap: 4px; }
.dr-risk-line { display: flex; gap: 8px; font-size: 12.5px; line-height: 1.6; }
.dr-risk-line-k { flex: 0 0 auto; color: var(--text-light, #8B949E); white-space: nowrap; }
.dr-risk-line-v { color: var(--text-secondary, #8B949E); word-break: break-word; }
.dr-risk-evidence {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed rgba(230,237,243,0.10);
}
.dr-risk-ev {
  display: inline-flex;
  gap: 4px;
  font-size: 11.5px;
  background: var(--bg-hover);
  border-radius: 4px;
  padding: 3px 8px;
}
.dr-risk-ev-k { color: var(--text-light, #8B949E); }
.dr-risk-ev-v { color: var(--text-primary, #E6EDF3); font-variant-numeric: tabular-nums; }

/* —— 表格内徽标：grade / verdict —— */
.dr-grade {
  display: inline-block;
  min-width: 20px;
  text-align: center;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid currentColor;
  background: rgba(230,237,243,0.04);
}
.dr-grade-a { color: #F0B97B; }
.dr-grade-b { color: #58A6FF; }
.dr-grade-c { color: #8B949E; }
.dr-grade-d { color: #6E7681; }
.dr-verdict {
  display: inline-block;
  font-size: 11.5px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 4px;
}
.dr-verdict-ok { color: #8B949E; }
.dr-verdict-no { color: #F0B97B; }
.dr-verdict-wait { color: #8B949E; }

/* —— opportunity / watch 宽表：横向滚动 —— */
.dr-table-scroll .dr-table { min-width: 960px; }
.dr-table-scroll .dr-table th { white-space: nowrap; }
.dr-table-scroll .dr-table tbody tr:hover td { background: rgba(230,237,243,0.04); }

/* —— 窄屏：四段式卡片纵向单列 + 宽表仍可横向滚动 —— */
@media (max-width: 640px) {
  .dr-quads { grid-template-columns: 1fr; }
  .dr-quad { padding: 10px 12px; }
  .dr-risk-head { gap: 6px; }
  .dr-table-scroll .dr-table { min-width: 680px; }
}

/* ===== 20261108d：每日复盘 · 固定 14 段 · 热点题材归因徽标（softDark，遵守 UI Audit 6 维度） =====
   与既有 .dr-grade / .dr-level-badge 同构：圆角 6px|999px、border:1px solid currentColor、
   background rgba(230,237,243,.04)、font-size 11px / font-weight 600 —— 排版不新增层级、间距按 8pt。
   配色均为「分类 / 级别」语义：S金·A蓝·B灰蓝·C绿灰、四象限琥珀/珊瑚/靛蓝/灰、消息级蓝/琥珀/灰，
   一律不与行情红涨绿跌（.dr-up/.dr-down）混用；hover 仅做克制的背景反馈，S 级加一层极淡辉光；
   不引入外部字体或 CDN。 */

/* —— 题材评级 S/A/B/C（与机会等级 A-D 的 .dr-grade 视觉区分，两套语义不混淆） —— */
.dr-topic-grade {
  display: inline-block;
  min-width: 26px;
  text-align: center;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.5;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid currentColor;
  background: rgba(230,237,243,0.04);
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.dr-topic-grade:hover { background: rgba(230,237,243,0.10); }
.dr-topic-s { color: #E3B341; box-shadow: 0 2px 8px rgba(227,179,65,0.10); } /* 最高级：强调金 + 克制辉光 */
.dr-topic-a { color: #58A6FF; }  /* 蓝 */
.dr-topic-b { color: #8FA3B8; }  /* 灰蓝 */
.dr-topic-c { color: #7E9086; }  /* 绿灰（低饱和，不与跌绿混淆） */

/* —— 四象限（分类语义配色，与行情红涨绿跌无关） —— */
.dr-quadrant {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
  background: rgba(230,237,243,0.04);
  white-space: nowrap;
  transition: background 0.15s ease;
}
.dr-quadrant:hover { background: rgba(230,237,243,0.10); }
.dr-quadrant-resonance  { color: #F0B97B; }  /* 共振 */
.dr-quadrant-divergence { color: #F0B97B; }  /* 背离 */
.dr-quadrant-prescience { color: #7C9EF5; }  /* 先觉 */
.dr-quadrant-weak       { color: #8B949E; }  /* 双弱 */

/* —— 资金投票质量 / 驱动标签 / 消息级别：共用同构徽标底座 —— */
.dr-vote,
.dr-drivers,
.dr-news-badge {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.5;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid currentColor;
  background: rgba(230,237,243,0.04);
  white-space: nowrap;
}
.dr-vote { border-radius: 999px; color: #9FB2C8; }
.dr-drivers { color: #8B949E; font-variant-numeric: tabular-nums; }

/* —— 消息级别与性质 —— */
.dr-news-official   { color: #58A6FF; }  /* 国家级 / 官方 */
.dr-news-rumor      { color: #F0B97B; }  /* 传闻 */
.dr-news-unverified { color: #8B949E; }  /* 未核验 */
.dr-news-neutral    { color: #9FB2C8; }  /* 行业级 / 财经媒体等 */

/* —— topic 宽表：14 列，桌面加宽保证信息密度，窄屏仍可横向滚动 —— */
.dr-tbl-topic.dr-table-scroll .dr-table { min-width: 1100px; }
.dr-tbl-topic.dr-table-scroll .dr-table td { vertical-align: middle; }

@media (max-width: 640px) {
  .dr-tbl-topic.dr-table-scroll .dr-table { min-width: 880px; }
  .dr-topic-grade,
  .dr-quadrant,
  .dr-vote,
  .dr-drivers,
  .dr-news-badge { padding: 2px 6px; font-size: 10.5px; }
}

/* —— 第 3 段热点归因：卡片网格（替代 15 列宽表；ui-new 排版优化） —— */
/* 与 .dr-quad / .dr-risk 同构：圆角 10px、8pt 间距、softDark 卡片底色、hover 仅做克制边框反馈。 */
.dr-topic-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
  align-items: stretch;
}
.dr-topic-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  background: var(--bg-card, #161B22);
  border: 1px solid rgba(230, 237, 243, 0.08);
  border-radius: 10px;
  padding: 14px;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.dr-topic-card:hover {
  border-color: rgba(240, 185, 123, 0.35);
  background: rgba(230, 237, 243, 0.02);
}
/* 头部：题材名左对齐推开徽标 */
.dr-topic-card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.dr-topic-card-name {
  font-size: 15px;
  font-weight: 700;
  color: var(--fg, #E6EDF3);
  margin-right: auto;
  line-height: 1.4;
}
/* 四指标：两列网格，标签左 / 数值右 */
.dr-topic-card-meta {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 6px 14px;
}
.dr-topic-metric {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  font-size: 12px;
  padding: 3px 0;
}
.dr-topic-mk { color: #8B949E; white-space: nowrap; }
.dr-topic-mv { color: #E6EDF3; font-weight: 600; text-align: right; }
/* 徽标行 */
.dr-topic-card-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
/* 文本块：核心催化 / 评级依据 / 明日验证逻辑 */
.dr-topic-card-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 2px 0;
}
.dr-topic-ck {
  font-size: 11px;
  letter-spacing: 0.3px;
  color: #8B949E;
}
.dr-topic-cv {
  font-size: 13px;
  line-height: 1.6;
  color: #C9D4E0;
}
/* 底部：明日动作 + 驱动标签，顶部虚线分隔 */
.dr-topic-card-foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
  border-top: 1px dashed rgba(230, 237, 243, 0.10);
  padding-top: 8px;
  margin-top: auto;
}
.dr-muted { color: #6E7681; }
/* 题材阶段胶囊（分类语义色，不与行情红涨绿跌混用） */
.dr-topic-stage {
  display: inline-block;
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid currentColor;
  background: rgba(230, 237, 243, 0.04);
  white-space: nowrap;
}
.dr-stage-start { color: #58A6FF; }   /* 启动 */
.dr-stage-rise  { color: #F0B97B; }   /* 发酵·主升 */
.dr-stage-peak  { color: #F0B97B; }   /* 高潮·退潮 */
.dr-stage-none  { color: #8B949E; }   /* 缺少对照 */

/* 窄屏：卡片单列铺满 */
@media (max-width: 640px) {
  .dr-topic-cards { grid-template-columns: 1fr; }
  .dr-topic-card-meta { grid-template-columns: 1fr; }
  .dr-topic-grade,
  .dr-quadrant,
  .dr-vote,
  .dr-drivers,
  .dr-news-badge,
  .dr-topic-stage { padding: 2px 6px; font-size: 10.5px; }
}

~~~

---

## `public\daily-review.html`  ·  64 行

~~~html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>每日复盘 · 股票分析工作台</title>
  <link rel="icon" type="image/x-icon" href="favicon.ico?v=20261108d">
  <link rel="icon" type="image/png" sizes="512x512" href="icon.png?v=20261108d">
  <link rel="stylesheet" href="css/style.css?v=20261110b">
  <!-- 独立长页：恢复滚动（与 notes.html / accuracy.html 同一外壳口径，html,body 须同时覆盖） -->
  <style>
    html, body { height: auto !important; overflow-y: auto !important; overflow-x: hidden; }
  </style>
</head>
<body>
  <!-- DailyReviewPage：每日复盘（Key=daily-review，路由 /daily-review，排序 30） -->
  <div class="jd-page dr-page">
    <header class="jd-header">
      <div>
        <h1 class="jd-title">📋 每日复盘</h1>
        <div class="dr-subtitle" id="drSubtitle">交易日 15:35 生成正式版 · 20:30 补录龙虎榜升级完整版 · 大模型生成 Markdown 复盘 · 数据缺失如实说明</div>
      </div>
      <div class="jd-actions">
        <button id="drRerunBtn" class="btn-secondary" type="button" title="管理员手动重跑当日复盘">↻ 手动重跑</button>
        <a href="index.html" class="btn-text">返回工作台</a>
      </div>
    </header>

    <!-- 状态条：交易日 / 休市 / running / 版本 / 完整度 -->
    <div class="dr-statusbar" id="drStatusBar">
      <span class="dr-chip" id="drChipDate">—</span>
      <span class="dr-chip" id="drChipDay">加载中…</span>
      <span class="dr-chip" id="drChipVersion">—</span>
      <span class="dr-chip" id="drChipCompleteness">—</span>
      <span class="dr-chip dr-chip-running hidden" id="drChipRunning">⏳ 生成中…</span>
      <span class="dr-spacer"></span>
      <span class="dr-meta" id="drMeta"></span>
    </div>

    <!-- 工具条：回到当日 + 日历选日期（历史复盘已由日历菜单完全替代，不再单独留 tab） -->
    <div class="jd-toolbar dr-toolbar">
      <button class="np-tab active" type="button" id="drTabToday">当日复盘</button>
      <input type="date" id="drDateInput" class="dr-input" title="点选任意日期即可自动显示该日复盘">
      <span class="dr-toolbar-note" id="drToolbarNote"></span>
    </div>

    <!-- 主内容 -->
    <main class="dr-main" id="drMain">
      <div class="dr-loading">正在加载当日复盘…</div>
    </main>
  </div>

  <!-- Markdown 渲染器本地随包（零 CDN 依赖）：必须在 dailyReview.js 之前加载 -->
  <script src="js/markdown.js?v=20261110c"></script>
  <script src="js/dailyReview.js?v=20261110d"></script>
  <script>
    // 页面组件入口：DailyReviewPage.init()（点击后自动加载当日复盘）
    document.addEventListener('DOMContentLoaded', function () {
      if (window.DailyReviewPage) window.DailyReviewPage.init();
    });
  </script>
</body>
</html>

~~~

---

## `public\etf-flow.html`  ·  41 行

~~~html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>宽基 ETF 申赎明细 · 股票分析工作台</title>
  <link rel="icon" type="image/x-icon" href="favicon.ico?v=20261025p">
  <link rel="icon" type="image/png" sizes="512x512" href="icon.png?v=20261025p">
  <link rel="stylesheet" href="css/style.css?v=20261110b">
  <!-- 独立长页：恢复滚动（同 notes/logic-model 独立页；其余样式统一在 style.css「独立长页统一外壳」段） -->
  <style>
    html, body { height: auto !important; overflow-y: auto !important; overflow-x: hidden; }
  </style>
</head>
<body>
  <div class="np-page">
    <header class="jd-header">
      <h1 class="jd-title">📐 宽基 ETF 申赎明细</h1>
      <div class="jd-actions">
        <button id="efRefresh" class="btn-primary" type="button">重新拉取</button>
        <a href="index.html" class="btn-text">返回工作台</a>
      </div>
    </header>

    <!-- sticky 统一工具条（DESIGN §12 独立页外壳） -->
    <div class="np-toolbar">
      <span class="np-count" id="efStatus">加载中…</span>
      <span class="np-count" id="efUpdated"></span>
    </div>

    <main id="efBody" class="ef-page-body">
      <div class="etf-empty">📡 正在读取宽基 ETF 申赎数据…<div class="etf-empty-sub">首次读取需向上交所取当日申赎清单（约 2~6 秒），之后 3 分钟内走缓存。</div></div>
    </main>
  </div>

  <!-- 20261028a：第三方库本地随包（铁律：禁止境外 CDN），供「持仓比例 vs 现金比例」趋势折线图 -->
  <script src="vendor/echarts.min.js?v=20261028a"></script>
  <script src="js/etfFlowPage.js?v=20261110b"></script>
</body>
</html>

~~~

---

## `public\index.html`  ·  1225 行

~~~html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>股票投资分析工作台</title>
  <link rel="icon" type="image/x-icon" href="favicon.ico?v=20261106p">
  <link rel="icon" type="image/png" sizes="512x512" href="icon.png?v=20261106p">
  <link rel="stylesheet" href="css/style.css?v=20261110b">
  <script>
    // 启动时确保 URL 带 ?v= 参数（用于破坏静态资源缓存）。
    // 重要：版本号以 server.js 的 APP_VERSION 为准，由服务端重定向统一下发，
    // 此处【禁止硬编码版本号】，否则会与 server.js 的强制定向互相覆盖形成重定向死循环。
    (function () {
      try {
        var u = new URL(location.href);
        // 仅当 URL 完全没有 v 参数时，补一个占位值；server.js 会重定向到正确的 APP_VERSION。
        if (!u.searchParams.get('v')) {
          u.searchParams.set('v', '1');
          location.replace(u.pathname + u.search + location.hash);
        }
      } catch (e) {}
    })();
  </script>
  <!-- ECharts 5.4.3：优先加载本地随包文件（不依赖外网，彻底避免 CDN 被墙/超时导致的「图表渲染失败」）；
       本地文件缺失时才回退到 CDN。onerror 回退保证任何一端可用即能出图。 -->
  <script src="vendor/echarts.min.js"></script>
  <script>
    if (typeof echarts === 'undefined') {
      document.write('<script src="https://cdn.jsdelivr.net/npm/echarts@5.4.3/dist/echarts.min.js"><\/script>');
    }
  </script>
  <!-- echarts-gl 2.0.9：ECharts 3D 扩展（bar3D 等）。本地优先，加载失败时静默降级 2.5D/2D（SA3D.glb() 自动检测）。 -->
  <script src="vendor/echarts-gl.min.js"></script>
  <script>
    if (typeof echarts !== 'undefined' && !echarts.gl) {
      document.write('<script src="https://cdn.jsdelivr.net/npm/echarts-gl@2.0.9/dist/echarts-gl.min.js"><\/script>');
    }
  </script>
</head>
<body>
  <!-- 顶栏：大盘行情状态栏（上证/深证/创业板/科创50/日经指数/恒生/纳斯达克/道琼斯），支持折叠 -->
  <header id="marketTopbar" class="market-topbar">
    <div class="topbar-inner">
      <div class="topbar-brand"><img class="brand-logo" src="icon.png?v=20261106p" alt="logo">股票分析台</div>
      <div id="marketTopbarIndices" class="topbar-indices">
        <span class="tb-loading">大盘行情加载中…</span>
      </div>
      <button id="topbarCollapse" class="topbar-collapse" title="折叠 / 展开大盘行情" aria-label="折叠 / 展开大盘行情">▾</button>
    </div>
  </header>

  <div id="app">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <h1 class="logo">📈 股票分析台</h1>
        <button id="keyboardHelpBtn" class="kb-trigger" title="查看快捷键" aria-label="查看快捷键">⌨️</button>
      </div>

      <!-- Search -->
      <div class="search-section">
        <div class="search-box">
          <input type="text" id="searchInput" placeholder="输入股票名称或代码..." autocomplete="off">
          <button id="searchBtn" class="btn-search">搜索</button>
        </div>
        <div id="searchResults" class="search-results"></div>
      </div>

      <!-- AI 模型设置入口（联网 / 本地双模型） -->
      <div class="sidebar-section">
        <button id="aiSettingsBtn" class="sidebar-setting-btn" title="配置 AI 模型（联网/本地）">AI 模型设置</button>
      </div>

      <!-- Quick links -->
      <div class="quick-links">
        <div class="quick-link" data-stock="000001" data-name="平安银行">平安银行</div>
        <div class="quick-link" data-stock="600519" data-name="贵州茅台">贵州茅台</div>
        <div class="quick-link" data-stock="000858" data-name="五粮液">五粮液</div>
        <div class="quick-link" data-stock="601318" data-name="中国平安">中国平安</div>
        <div class="quick-link" data-stock="AAPL" data-name="Apple">Apple</div>
        <div class="quick-link" data-stock="TSLA" data-name="Tesla">Tesla</div>
      </div>

      <!-- Watchlist -->
      <div class="sidebar-section">
        <div class="section-header">
          <h2>⭐ 自选股</h2>
          <span id="watchlistCount" class="count-badge">0</span>
        </div>
        <div id="watchlist" class="watchlist"></div>
      </div>

      <!-- History -->
      <div class="sidebar-section" id="historyPanel" data-collapsible="true">
        <div class="section-header">
          <h2>🕐 搜索历史</h2>
          <div class="header-actions">
            <button id="clearHistory" class="btn-text">清除</button>
            <button class="btn-collapse" data-collapse-target="historyPanel" title="折叠/展开" aria-label="折叠/展开">▾</button>
          </div>
        </div>
        <div id="historyList" class="history-list"></div>
      </div>
    </aside>

    <!-- Main Content -->
    <main class="main-content">
      <!-- 常驻顶部导航：投资心得 / 大盘记录 / 每日复盘 / AI设置（所有页面都显示） + 个股页操作按钮 -->
      <nav class="global-nav">
        <div class="global-nav-common">
          <button class="home-action-btn" onclick="window.open('notes.html?scope=global', '_blank')" title="在新标签页打开投资心得">投资心得</button>
          <button class="home-action-btn" onclick="window.open('notes.html?scope=market', '_blank')" title="在新标签页打开大盘记录">大盘记录</button>
          <!-- 20261107：每日复盘（Key=daily-review / 路由 /daily-review / 组件 DailyReviewPage / 排序 30）。
               工作台为原生多页面无前端路由，故用 data 属性承载规格元数据，按钮新开独立页。 -->
          <button class="home-action-btn home-action-btn-accent" data-nav-key="daily-review" data-nav-order="30"
                  onclick="window.open('/daily-review?v=20261108d', '_blank')"
                  title="每日复盘：交易日 15:35 生成正式版、20:30 补录龙虎榜，由大模型生成 Markdown 报告">每日复盘</button>
          <button class="home-action-btn" onclick="App.openAISettings()">AI 设置</button>
          <button class="home-action-btn" onclick="window.open('logic-model.html', '_blank')" title="在新标签页按页面布局查看整个工作台的逻辑框架">工作台逻辑模型</button>
        </div>
        <div class="global-nav-extra hidden" id="globalNavExtra">
          <button id="backHomeBtn" class="home-action-btn" title="返回首页">首页</button>
          <button id="addToWatchlist" class="home-action-btn" title="加入 / 移出自选股">☆ 自选</button>
          <button id="exportHTML" class="home-action-btn" title="导出HTML">导出HTML</button>
          <button id="exportJSON" class="home-action-btn" title="导出JSON">导出JSON</button>
          <button id="refreshBtn" class="home-action-btn" title="刷新">刷新</button>
          <a id="navAccuracyLink" class="nav-acc-link" href="accuracy.html" title="查看判断准确率核对页">准确率</a>
        </div>
      </nav>

      <!-- Loading overlay -->
      <div id="loadingOverlay" class="loading-overlay hidden">
        <div class="loading-spinner"></div>
        <p class="loading-text" id="loadingText">正在获取数据...</p>
      </div>

      <!-- 顶部进度条：非阻塞加载指示（pointer-events:none，不拦截任何点击） -->
      <div id="topProgressBar" class="top-progress hidden"></div>
      <!-- 加载提示胶囊（20261022i）：显示「正在加载 XX」文字，pointer-events:none 不拦截点击。
           此前 showLoading(text) 的 text 被丢弃，切股 2~4 秒内屏幕无任何提示 → 用户以为没点上而重复点击。 -->
      <div id="loadingPill" class="loading-pill hidden"></div>

      <!-- Empty state / Home -->
      <div id="emptyState" class="empty-state">
        <div class="home-hero">
          <div class="empty-icon">📊</div>
          <h2>股票投资分析工作台</h2>
          <p class="home-date" id="homeDate"></p>
          <p class="home-sub">在左侧搜索框输入股票名称或代码，获取全面的投资分析报告</p>
        </div>

        <!-- 市场情绪拐点·完整面板（不含个股敏感度） -->
        <section class="chart-card large" id="homeSentimentPanel" data-collapsible="true">
          <div class="chart-header">
            <h3>📡 市场情绪提醒</h3>
            <div class="mo-head-actions">
              <span id="homeSentimentUpdated" class="mo-updated"></span>
              <button class="btn-journal-add" id="homeSentimentRefresh" title="重新检测">重新检测</button>
              <a class="mt-acc-link topbar-acc-small" href="accuracy.html?tab=sentiment" title="查看情绪预警历史与事后验证">准确率核对 →</a>
              <button class="btn-collapse" data-collapse-target="homeSentimentPanel" title="折叠/展开" aria-label="折叠/展开">▾</button>
            </div>
          </div>
          <div id="homeSentimentBody" class="sentiment-tp-body">
            <div class="ai-empty">正在检测市场情绪拐点…</div>
          </div>
        </section>

        <!-- 实时大盘（指数速览：大盘指数 / 美国股指 / 热门板块） -->
        <section class="home-card market-overview-card" id="marketOverviewCard">
          <div class="home-card-head">
            <h3>📈 实时大盘</h3>
            <div class="mo-head-actions">
              <span id="marketUpdated" class="mo-updated"></span>
              <button class="btn-journal-add" id="marketAIBtn" title="AI 联网解读大盘">AI 解读</button>
              <button class="btn-journal-add" id="marketRefreshBtn" title="刷新行情">刷新</button>
            </div>
          </div>
          <div id="marketOverview" class="market-overview-body"></div>
        </section>

        <!-- 大盘技术分析（上证/深证/创业板指 收盘后六步技术面推演） -->
        <section class="home-card market-technical-card" id="marketTechnicalCard" data-collapsible="true">
          <div class="home-card-head">
            <h3>🧭 大盘技术分析（融合版）</h3>
            <div class="mo-head-actions">
              <span id="marketTechnicalUpdated" class="mo-updated"></span>
              <button class="btn-journal-add" id="marketTechnicalRefresh" title="重新推演三大指数">刷新</button>
              <a class="mt-acc-link topbar-acc-small" href="accuracy.html?tab=market" title="查看历史判断与事后验证">准确率核对 →</a>
              <button class="btn-collapse" data-collapse-target="marketTechnicalCard" title="折叠/展开" aria-label="折叠/展开">▾</button>
            </div>
          </div>
          <div class="mt-accuracy" id="marketTechAccuracy"></div>
          <div id="marketTechnicalBody" class="market-technical-body">
            <div class="mo-loading">正在对三大指数进行收盘后技术面推演…</div>
          </div>
          <div class="market-technical-note" id="marketTechnicalNote"></div>
        </section>

        <!-- 大盘估值趋势（上证50 / 沪深300 / 中证1000 / 科创50 近5年PE-TTM + 历史百分位，20261105b） -->
        <section class="home-card index-pe-trend-card" id="indexPeTrendCard" data-collapsible="true">
          <div class="home-card-head">
            <h3>📊 大盘估值趋势</h3>
            <div class="mo-head-actions">
              <span id="indexPeTrendUpdated" class="mo-updated"></span>
              <button class="btn-journal-add" id="indexPeTrendRefresh" title="刷新估值趋势">刷新</button>
              <button class="btn-collapse" data-collapse-target="indexPeTrendCard" title="折叠/展开" aria-label="折叠/展开">▾</button>
            </div>
          </div>
          <div class="index-pe-trend-body" id="indexPeTrendBody">
            <div class="mo-loading">正在加载四大指数估值趋势…</div>
          </div>
          <div class="index-pe-trend-note" id="indexPeTrendNote"></div>
        </section>

        <!-- 行业板块拥挤度（板块成交额 ÷ 全市场成交额，当日/本周/本月 前五） -->
        <section class="home-card sector-crowding-card" id="sectorCrowdingCard" data-collapsible="true">
          <div class="home-card-head">
            <h3>🧮 行业板块拥挤度</h3>
            <div class="mo-head-actions">
              <span id="crowdingUpdated" class="mo-updated"></span>
              <span id="crowdingMarketTotal" class="mo-sub"></span>
              <button class="btn-journal-add" id="crowdingRefreshBtn" title="刷新拥挤度">刷新</button>
              <button class="btn-collapse" data-collapse-target="sectorCrowdingCard" title="折叠/展开" aria-label="折叠/展开">▾</button>
            </div>
          </div>
          <div class="crowding-body" id="sectorCrowding"></div>
          <div class="crowding-note" id="sectorCrowdingNote"></div>
        </section>

        <!-- 今日财经热点（AI 联网抓取东方财富 7×24 快讯） -->
        <section class="home-card hot-news-card" id="homeNewsCard" data-collapsible="true">
          <div class="home-card-head">
            <h3>🔥 今日财经热点</h3>
            <div class="mo-head-actions">
              <span id="homeNewsUpdated" class="mo-updated"></span>
              <button class="btn-journal-add" id="homeNewsRefresh" title="刷新热点新闻">刷新</button>
              <button class="btn-collapse" data-collapse-target="homeNewsCard" title="折叠/展开" aria-label="折叠/展开">▾</button>
            </div>
          </div>
          <div id="homeNewsBody" class="hot-news-body">
            <div class="ai-empty">正在获取今日财经热点…</div>
          </div>
        </section>

        <!-- 板块舆情热度周榜（20260909m：舆情+社区讨论热度五指标引擎，自然周统计；热度≠涨跌预测） -->
        <section class="home-card hot-topics-home-card" id="homeHotTopicsCard" data-collapsible="true">
          <div class="home-card-head">
            <h3>🔥 板块舆情热度周榜</h3>
            <div class="mo-head-actions">
              <span id="homeHotTopicsUpdated" class="mo-updated"></span>
              <button class="btn-journal-add" id="homeHotTopicsRefresh" title="重新采集并计算本周板块舆情热度">刷新</button>
              <button class="btn-collapse" data-collapse-target="homeHotTopicsCard" title="折叠/展开" aria-label="折叠/展开">▾</button>
            </div>
          </div>
          <div id="homeHotTopicsBody" class="home-hot-topics-body">
            <div class="ai-empty">正在加载板块舆情热度周榜…</div>
          </div>
        </section>

        <!-- 每日宏观 & 政策（东方财富 7×24 宏观/政策过滤，每日自动采集） -->
        <section class="home-card macro-card" id="macroCard" data-collapsible="true">
          <div class="home-card-head">
            <h3>🌐 每日宏观 &amp; 政策</h3>
            <div class="mo-head-actions">
              <span id="macroUpdated" class="mo-updated"></span>
              <button class="btn-journal-add" id="macroRefresh" title="刷新宏观与政策">刷新</button>
              <button class="btn-collapse" data-collapse-target="macroCard" title="折叠/展开" aria-label="折叠/展开">▾</button>
            </div>
          </div>
          <div id="macroBody" class="macro-body">
            <div class="ai-empty">正在采集每日宏观 &amp; 政策…</div>
          </div>
        </section>

        <!-- 基金行业配置名单（全市场权益类基金最新季前十大重仓股 → 按持仓市值加总排名，展示前20名 + 季度环比） -->
        <section class="home-card rank-card" id="rankCard" data-collapsible="true">
          <div class="home-card-head">
            <h3>🏭 基金行业配置名单（全市场 · 前20 · 季度环比）</h3>
            <div class="mo-head-actions">
              <span id="rankUpdated" class="mo-updated"></span>
              <button class="btn-journal-add" id="rankRefresh" title="刷新 / 继续采集">刷新</button>
              <button class="btn-collapse" data-collapse-target="rankCard" title="折叠/展开" aria-label="折叠/展开">▾</button>
            </div>
          </div>
          <div id="rankBody" class="rank-body">
            <div class="ai-empty">正在获取全市场基金行业配置名单…</div>
          </div>
        </section>

      </div>

      <!-- Analysis dashboard -->
      <div id="dashboard" class="dashboard hidden">
        <!-- Stock header（置顶：公司名 + 股价随页面滚动常驻；含行情/财务双日期） -->
        <div class="stock-header">
          <div class="stock-info">
            <div class="stock-title-row">
              <h2 id="stockName">--</h2>
              <span id="stockCode" class="stock-code"></span>
              <span id="stockMarket" class="stock-market"></span>
              <span id="stockPrice" class="stock-price">--</span>
              <span id="stockChange" class="stock-change"></span>
            </div>
            <div class="stock-date-bar">
              <span id="stockDate" class="stock-date"></span>
              <span id="stockFinDate" class="stock-fin-date"></span>
              <!-- 20261101n：换手率/成交额自页首固定指标条移入标题卡（applyLiveQuote 单点刷新） -->
              <!-- 20261106d（用户截图指令）：换手率之后补「量比」（腾讯行情原生字段 quote.volumeRatio，
                   与量能引擎 volumeState.ratio5 同源；缺失时整段隐藏不估算） -->
              <span id="stockTurnover" class="stock-turnover"></span>
              <span id="stockVolRatio" class="stock-vol-ratio"></span>
              <span id="stockAmount" class="stock-amount"></span>
            </div>
          </div>
          <!-- 20261104f：banner 右侧「回到顶部」（用户指令：点击后回到页面顶端） -->
          <div class="stock-actions">
            <button type="button" id="backToTopBtn" class="back-top-btn" title="回到页面顶端">回到顶部 ↑</button>
          </div>
        </div>

        <!-- K线走势图（常驻页面上方、股价正下方，不受 Tab 切换影响） -->
        <div class="chart-card large" id="klineCard">
          <div class="chart-header chart-header-wrap">
            <h3>📈 主图</h3>
            <div class="chart-controls period-controls">
              <!-- 20261017h：新增「分时」视图（腾讯分时 + 均价线 + 分钟量柱），与量能引擎共用同一数据源 -->
              <button class="period-btn" data-period="minute">分时</button>
              <button class="period-btn active" data-period="daily">日K</button>
              <button class="period-btn" data-period="weekly">周K</button>
              <button class="period-btn" data-period="monthly">月K</button>
              <button class="period-btn" data-period="60m">60分钟</button>
            </div>
            <div class="chart-controls range-controls" id="rangeControls">
              <button class="range-btn" data-range="3m">3月</button>
              <button class="range-btn" data-range="6m">6月</button>
              <button class="range-btn active" data-range="1y">1年</button>
              <button class="range-btn" data-range="3y">3年</button>
            </div>
          </div>
          <div id="candlestickChart" class="chart"></div>
        </div>

        <!-- Key metrics bar -->
        <div id="keyMetrics" class="key-metrics-bar"></div>

        <!-- Overall scores -->
        <div class="scores-row">
          <div class="score-card clickable" id="techScoreCard" title="点击查看计算依据">
            <div class="score-label">技术面评分</div>
            <div class="score-value" id="techScore">--</div>
            <div class="score-detail" id="techScoreDetail"></div>
            <div class="score-trace">查看计算 ▾</div>
          </div>
          <div class="score-card clickable" id="fundScoreCard" title="点击查看计算依据">
            <div class="score-label">基本面评分</div>
            <div class="score-value" id="fundScore">--</div>
            <div class="score-detail" id="fundScoreDetail"></div>
            <div class="score-trace">查看计算 ▾</div>
          </div>
          <div class="score-card clickable" id="capitalScoreCard" title="点击查看计算依据">
            <div class="score-label">资金热度</div>
            <div class="score-value" id="capitalScore">--</div>
            <div class="score-detail" id="capitalScoreDetail"></div>
            <div class="score-trace">查看计算 ▾</div>
          </div>
          <!-- 个股近期热点（20260827c：AI 联网，按涨跌幅切异动归因/网络热议） -->
          <div class="score-card hot-topics-card" id="hotTopicsCard">
            <div class="hot-topics-head">
              <div class="score-label">🔥 个股近期热点</div>
              <span class="hot-topics-date" id="hotTopicsDate"></span>
              <button class="btn-journal-add" id="hotTopicRefreshBtn" type="button" title="重新联网分析" aria-label="重新联网分析">🔄</button>
            </div>
            <div class="hot-topics-analysis" id="hotTopicsAnalysis">
              <div class="ai-empty" id="hotTopicsEmpty">正在联网分析…</div>
            </div>
          </div>
        </div>

        <!-- 评分计算追溯面板（默认隐藏，紧跟第一行评分卡） -->
        <div id="scoreTracePanel" class="score-trace-panel hidden"></div>

        <!-- 概览补充卡片：行业前景 / 股东户数变化 / 最大亮点雷点（异步加载，不随切换页面中断） -->
        <div class="scores-row">
          <div class="score-card" id="industryScoreCard">
            <div class="score-label">行业前景评分</div>
            <div class="score-value" id="industryScore">--</div>
            <div class="score-detail" id="industryScoreDetail"></div>
          </div>
          <div class="score-card sameday-card" id="samedayCard">
            <div class="score-label"><span id="samedayTitle">短期行情</span> <span class="sameday-badge" id="samedayConfidence"></span></div>
            <div class="sameday-subtitle" id="samedayTarget"></div>
            <div class="score-value sameday-verdict" id="samedayVerdict">--</div>
            <div class="score-detail" id="samedayDetail"></div>
            <div class="sameday-report-sync" id="samedayReportSync" style="display:none"></div>
            <button class="ai-trigger-btn sameday-logic-btn" id="samedayLogicBtn" type="button">查看判断逻辑</button>
            <div class="sameday-accuracy" id="samedayAccuracy"></div>
            <a href="judgments.html" target="_blank" id="samedayAllLink" class="sameday-all-link">查看该股判断记录</a>
            <a href="accuracy.html?tab=sameDay" target="_blank" class="sameday-all-link">准确率核对</a>
            <div class="sameday-logic" id="samedayLogic" style="display:none"></div>
          </div>
          <div class="score-card sameday-card" id="longtermCard">
            <div class="score-label"><span id="longtermTitle">长期行情</span> <span class="sameday-badge" id="longtermConfidence"></span></div>
            <div class="sameday-subtitle" id="longtermSubtitle"></div>
            <div class="score-value sameday-verdict" id="longtermVerdict">--</div>
            <div class="score-detail" id="longtermDetail"></div>
            <button class="ai-trigger-btn sameday-logic-btn" id="longtermLogicBtn" type="button">查看判断逻辑</button>
            <div class="sameday-accuracy" id="longtermNote"></div>
            <div class="sameday-logic" id="longtermLogic" style="display:none"></div>
          </div>
          <div class="score-card" id="aspectCard">
            <div class="score-label">最大亮点 / 雷点</div>
            <div class="score-value aspect" id="aspectValue">--</div>
            <div class="score-detail" id="aspectDetail"></div>
          </div>
        </div>

        <!-- Tabs -->
        <div class="tabs">
          <button class="tab active" data-tab="overview">简介</button>
          <button class="tab" data-tab="technical">技术面</button>
          <button class="tab" data-tab="fundamental">基本面</button>
          <button class="tab" data-tab="shareholders">股东分析</button>
          <button class="tab" data-tab="deep">深度分析</button>
          <button class="tab" data-tab="industry">行业分析</button>
          <button class="tab" data-tab="capital">资金量能</button>
          <button class="tab" data-tab="journal">个股亮点/雷点</button>
          <button class="tab" data-tab="docs">资料库</button>
          <button class="tab" data-tab="backtest">策略</button>
          <button class="tab" data-tab="stocklog">个股记录</button>
        </div>

        <!-- Tab content -->
        <div class="tab-content">
          <!-- Overview tab -->
          <div id="tab-overview" class="tab-panel active">
            <!-- 公司概况（主要产品/客户/企业性质） -->
            <div class="chart-card large" id="companyProfileCard">
              <div class="chart-header">
                <h3>🏢 公司概况</h3>
                <span id="companyTypeBadge" class="company-type-badge-inline"></span>
              </div>
              <div id="companyProfile" class="company-profile"></div>
            </div>

            <!-- 公司深度分析（CFA 统一框架 · 20260914f：合并原「公司综合介绍/供应链与成本/主要产品&客户」三模块） -->
            <div class="chart-card large" id="companyDeepCard">
              <div class="chart-header">
                <h3>📊 信息分析</h3>
                <div class="ai-head-actions">
                  <span id="companyDeepDate" class="ai-date"></span>
                  <button class="btn-journal-add" id="companyDeepAiBtn">AI 联网获取</button>
                  <button class="btn-text" id="companyDeepRefresh" style="display:none">重新搜索</button>
                </div>
              </div>
              <div id="companyDeepBody" class="company-deep-body">
                <div class="ai-empty">正在检查已存的信息分析资料…</div>
              </div>
            </div>

            <!-- 期货关联走势（产品型公司） -->
            <div class="chart-card large" id="futuresPanel" style="display:none;">
              <div class="chart-header">
                <h3>📈 期货关联走势（股价 vs <span id="futuresName">期货</span>）</h3>
                <div class="chart-controls">
                  <span id="futuresCorrBadge" class="corr-badge"></span>
                </div>
              </div>
              <div id="futuresChart" class="chart"></div>
              <div id="futuresConclusion" class="futures-conclusion"></div>
            </div>
          </div>

          <!-- Technical tab -->
          <div id="tab-technical" class="tab-panel">
            <!-- 价格行为趋势推演（Price Action：价格包容一切 · 人性重复演绎） -->
            <div class="chart-card large pa-panel">
              <h3>🎯 价格行为趋势推演<span class="pa-subtitle">价格包容一切 · 人性重复演绎</span><a class="mt-acc-link topbar-acc-small pa-acc-link" href="accuracy.html?tab=tech" title="查看该股历史判断与事后验证">准确率核对 →</a></h3>
              <div class="mt-accuracy" id="techFaceAccuracy"></div>
              <div id="paMeta" class="pa-meta">数据加载中…</div>
              <div id="paSummary" class="pa-summary"></div>
              <div class="pa-grid">
                <div id="paLongTerm" class="pa-card"></div>
                <div id="paShortTerm" class="pa-card"></div>
                <div id="paCoord" class="pa-card"></div>
                <div id="paEdges" class="pa-card"></div>
              </div>
            </div>

            <!-- 月线趋势结构（长期视角） -->
            <div class="chart-card large">
              <h3>📊 月线趋势结构（长期视角）</h3>
              <div id="paMonthlyChart" class="chart" style="height:440px;"></div>
            </div>

            <!-- 成交密集区（筹码分布） -->
            <div class="chart-card large">
              <h3>🧲 成交密集区与价格引力（近3年）</h3>
              <div id="paProfileChart" class="chart" style="height:380px;"></div>
            </div>

            <div class="chart-card large">
              <h3>技术指标信号</h3>
              <div id="signalGridMeta" class="signal-grid-meta"></div>
              <div id="signalSummary" class="signal-grid"></div>
            </div>

            <div class="chart-card large">
              <h3>MACD 指标</h3>
              <div id="macdChart" class="chart"></div>
            </div>
            <div class="chart-grid">
              <div class="chart-card">
                <h3>RSI (14)</h3>
                <div id="rsiChart" class="chart"></div>
              </div>
              <div class="chart-card">
                <h3>KDJ 指标</h3>
                <div id="kdjChart" class="chart"></div>
              </div>
            </div>
            <div class="chart-card">
              <h3>布林带 + 均线</h3>
              <div id="bollChart" class="chart"></div>
            </div>
            <div class="chart-card">
              <h3>成交量分析</h3>
              <div id="volumeAnalysis" class="vol-analysis"></div>
            </div>
          </div>

          <!-- Fundamental tab -->
          <div id="tab-fundamental" class="tab-panel">
            <div id="fundCompanyTypeBadge" class="company-type-badge" style="display:none;"></div>
            <div class="chart-card large">
              <h3>基本面评分明细</h3>
              <div id="fundScoreBreakdown" class="score-breakdown"></div>
            </div>
            <div class="chart-card" id="fundConclusion" style="display:none;"></div>
            <div class="chart-grid">
              <div class="chart-card">
                <h3>关键财务指标<button type="button" id="growthCaliberBtn" class="growth-caliber-btn" title="切换增长类指标（营收/利润/扣非）的同比口径：单季优先 ↔ 累计。切换后左卡数值、右卡指标分析、顶栏判定、历史百分位全链路同步">口径：单季</button></h3>
                <div id="fundMetrics" class="metrics-table"></div>
              </div>
              <div class="chart-card">
                <h3>指标分析</h3>
                <div id="metricAnalysis" class="metric-analysis"></div>
              </div>
            </div>
          </div>

          <!-- Shareholders tab (issue5: 股东户数走势 + 十大股东 + 机构持仓变化) -->
          <div id="tab-shareholders" class="tab-panel">
            <div id="shareholdersContainer" class="shareholders-container"></div>
          </div>

          <!-- Deep analysis tab -->
          <div id="tab-deep" class="tab-panel">
            <div id="deepLoading" class="deep-loading hidden">
              <div class="sk-stack">
                <div class="skeleton sk-title"></div>
                <div class="skeleton sk-line"></div>
                <div class="skeleton sk-line short"></div>
                <div class="sk-row">
                  <div class="skeleton"></div>
                  <div class="skeleton"></div>
                  <div class="skeleton"></div>
                </div>
                <div class="skeleton sk-block"></div>
              </div>
              <p>正在获取最近5年财务数据进行深度分析，请稍候...</p>
            </div>
            <div id="deepCacheBar" class="deep-cache-bar hidden">
              <span id="deepCacheStatus" class="deep-cache-status"></span>
              <button id="deepRefreshBtn" class="btn-icon deep-refresh-btn" title="重新获取并分析最新数据">刷新</button>
            </div>
            <div id="deepContent" class="deep-content">
              <!-- Audit warning -->
              <div id="auditWarning" class="audit-warning hidden"></div>

              <!-- 本地资料库文档 -->
              <div id="deepLocalDocs" class="local-docs-panel hidden"></div>

              <!-- 估值结论面板（20260905j 合并 AI 估值大模型：默认规则版解读，点「✨ AI 估值」原地切换；
                   原公司类型/分析重点行、PE估值带小卡片、独立 AI 估值大模型卡片均已并入/删除） -->
              <div class="valuation-merged">
                <div class="ai-holder-foot valuation-ai-head">
                  <span id="valuationAiDate" class="ai-holder-date"></span>
                  <!-- 20260905m：原「🔄 重新估值」按钮已删除——单按钮口径：打开自动读保存的结果，点「✨ AI 估值」即重新估值并保存 -->
                  <button class="ai-trigger-btn" id="valuationAiBtn" type="button">AI 估值</button>
                </div>
                <div id="deepConclusion" class="conclusion-panel"></div>
                <div id="valuationAiBody" class="ai-holder-body" style="display:none"></div>
              </div>

              <!-- 最新财报解读（AI 联网，标题由 JS 根据实际报告期动态设置） -->
              <div class="chart-card large">
                <h3 id="deepEarningsReportTitle">📑 最新财报解读</h3>
                <div id="deepEarningsReport" class="earnings-report-panel"></div>
              </div>

              <!-- Section 4: Revenue & Cost Trend -->
              <div class="chart-card large">
                <h3>📊 营收与成本趋势（近5年）</h3>
                <div id="deepRevenueCost" class="chart"></div>
              </div>

              <!-- Section 15b: 近5年 ROE 与毛利率走势 -->
              <div class="chart-card large">
                <h3>📈 ROE 与毛利率走势（近5年）</h3>
                <div id="deepRoeMargin" class="chart"></div>
                <div id="deepRoeMarginText" class="roe-margin-text"></div>
              </div>

              <!-- 第4节：分产品收入构成（近10年折线） -->
              <div class="chart-card large">
                <h3>📦 分产品收入构成趋势（第4节 · 近5年）</h3>
                <div id="deepSegmentProduct" class="chart"></div>
              </div>

              <!-- 第5节：分地区（国内外）收入构成（近10年折线） -->
              <div class="chart-card large">
                <h3>🌏 分地区（国内外）收入构成趋势（第5节 · 近5年）</h3>
                <div id="deepSegmentRegion" class="chart"></div>
              </div>

              <div class="chart-grid">
                <!-- Section 6: Short-term Financial Risk -->
                <div class="chart-card">
                  <h3>💰 短期财务风险</h3>
                  <div id="deepShortTermRisk" class="chart"></div>
                </div>
                <!-- Section 7: Asset Composition -->
                <div class="chart-card">
                  <h3>🏦 资产构成分析</h3>
                  <div id="deepAssetComp" class="chart"></div>
                </div>
              </div>

              <!-- Section 8: Liability Composition -->
              <div class="chart-card">
                <h3>📉 负债构成分析</h3>
                <div id="deepLiabComp" class="chart"></div>
              </div>

              <!-- Section 9: Revenue vs Operating Cash Flow -->
              <div class="chart-card large">
                <h3>💵 营收 vs 经营现金流净额（近5年）</h3>
                <div id="deepRevVsCash" class="chart"></div>
              </div>

              <!-- Section 10: Revenue vs Market Cap -->
              <div class="chart-card large">
                <h3>📈 营收 vs 市值（双Y轴）</h3>
                <div id="deepRevVsMC" class="chart"></div>
              </div>

              <!-- Section 11: Net Profit vs Market Cap -->
              <div class="chart-card large">
                <h3>💹 净利润 vs 市值（双Y轴）</h3>
                <div id="deepProfitVsMC" class="chart"></div>
              </div>

              <!-- Section 12: Net Assets vs Market Cap -->
              <div class="chart-card large">
                <h3>🏦 净资产 vs 市值（双Y轴）</h3>
                <div id="deepNAVVsMC" class="chart"></div>
              </div>

              <!-- Section 13: Net Profit vs Operating Cash Flow -->
              <div class="chart-card large">
                <h3>🔍 净利润 vs 经营现金流（业绩真实性）</h3>
                <div id="deepProfitVsCash" class="chart"></div>
              </div>

              <!-- Section 14: Revenue vs Total Cost -->
              <div class="chart-card large">
                <h3>📊 营收 vs 总成本趋势</h3>
                <div id="deepRevVsCost" class="chart"></div>
              </div>

              <!-- Section 15: Revenue vs Expenses -->
              <div class="chart-card large">
                <h3>📋 营收 vs 三费（销售/管理/研发）双Y轴</h3>
                <div id="deepRevVsExp" class="chart"></div>
              </div>

              <div class="chart-grid">
                <!-- Section 17: Growth Rates -->
                <div class="chart-card">
                  <h3>增长率分析（基准年对比）</h3>
                  <div id="deepGrowth" class="chart"></div>
                </div>
                <!-- Section 18: Revenue vs Accounts Payable -->
                <div class="chart-card">
                  <h3>应付账款 vs 营收（资金占用）</h3>
                  <div id="deepPayable" class="chart"></div>
                </div>
              </div>

              <div class="chart-grid">
                <!-- Section 19: PE Ratio -->
                <div class="chart-card">
                  <h3>市盈率PE趋势（含均值±标准差）</h3>
                  <div id="deepPE" class="chart"></div>
                </div>
                <!-- Section 20: PB Ratio -->
                <div class="chart-card">
                  <h3>市净率PB趋势（含均值±标准差）</h3>
                  <div id="deepPB" class="chart"></div>
                </div>
              </div>

              <div class="chart-grid">
                <!-- Section 21: PS Ratio -->
                <div class="chart-card">
                  <h3>市销率PS趋势（含均值±标准差）</h3>
                  <div id="deepPS" class="chart"></div>
                </div>
              </div>

              <!-- Section 23: DCF Valuation -->
              <div class="chart-card large">
                <h3>自由现金流折现估值（DCF）</h3>
                <div id="deepDCF" class="dcf-result"></div>
              </div>

              <div class="chart-grid">
                <!-- Section 23b: P/EV Valuation -->
                <div class="chart-card">
                  <h3>⚖️ P/EV 估值分析</h3>
                  <div id="deepPEV" class="dcf-result"></div>
                </div>
                <!-- Section 23c: DDM Valuation -->
                <div class="chart-card">
                  <h3>💰 DDM 股息贴现估值</h3>
                  <div id="deepDDM" class="dcf-result"></div>
                </div>
                <!-- 20260905j：原 Section 23d「AI 估值大模型」卡片已合并至上方估值结论面板（valuation-merged），独立卡片删除 -->
              </div>

              <!-- Section 22: Dividends -->
              <div class="chart-card large">
                <h3>净利润 vs 分红（近5年）</h3>
                <div id="deepDividend" class="chart"></div>
              </div>

              <!-- Section 22c: 分红分析（金额 / 每股 可切换） -->
              <div class="chart-card large">
                <h3>分红分析（近5年 · 每次 / 每年 / 每股 可切换）</h3>
                <div class="dy-toggle">
                  <button class="dy-toggle-btn active" data-mode="payout">每次分红</button>
                  <button class="dy-toggle-btn" data-mode="year">每年合计</button>
                  <button class="dy-toggle-btn" data-mode="perShare">每股分红</button>
                </div>
                <div id="deepDividendBar" class="chart"></div>
                <div id="deepDividendBarNote" class="chart-caption"></div>
              </div>

              <!-- Section 22b: Dividend Yield Trend (10y + mean±σ + industry) -->
              <div class="chart-card large">
                <h3>股息率趋势（近10年 · 均值±标准差参考线）</h3>
                <div id="deepDivYield" class="chart"></div>
                <div id="deepDivYieldAnalysis" class="dy-analysis"></div>
              </div>

              <!-- 第24节：近一年券商研报观点与估值 -->
              <div class="chart-card large">
                <h3>📚 近一年券商研报观点与估值（第24节）</h3>
                <div id="deepResearchReports" class="research-panel"></div>
              </div>

              <!-- 第25节：近一年公告（增持/减持/回购/高管/立案） -->
              <div class="chart-card large">
                <h3>📢 近一年重要公告（增持/减持/回购/高管/立案 · 第25节）</h3>
                <div id="deepAnnouncements" class="annc-panel"></div>
              </div>

              <!-- 第25b节：官方公告（巨潮资讯，确定性数据，非 AI） -->
              <div class="chart-card large">
                <h3>🏛️ 官方公告（巨潮资讯 · 确定性数据）</h3>
                <div id="cninfoAnnouncements" class="annc-panel"></div>
              </div>

              <!-- 第4节补充：细分产品/业务毛利率（营收占比 · 成本占比 · 毛利率） -->
              <div class="chart-card large product-margin-card">
                <h3>🧮 细分产品 / 业务毛利率（营收占比 · 成本占比 · 毛利率）</h3>
                <div id="deepProductMargin" class="product-margin-chart"></div>
              </div>

              <!-- 保险公司专属分析 -->
              <div id="deepInsuranceAnalysis" class="insurance-panel hidden">
                <div class="chart-card large">
                  <h3>🏷️ 保费收入趋势（近5年）</h3>
                  <div id="deepPremiumTrend" class="chart"></div>
                  <div class="chart-caption" id="deepPremiumTrendNote"></div>
                </div>
                <!-- 险种占比 + 综合成本率 并排 -->
                <div class="chart-grid">
                  <div class="chart-card">
                    <h3>📊 险种及业务结构占比</h3>
                    <div id="deepPremiumPie" class="chart"></div>
                    <div class="chart-caption" id="deepPremiumPieNote"></div>
                  </div>
                  <div class="chart-card">
                    <h3>📉 综合成本率趋势（产险业务）</h3>
                    <div id="deepCombinedRatio" class="chart"></div>
                    <div class="chart-caption" id="deepCombinedRatioNote"></div>
                  </div>
                </div>
                <!-- 新业务价值 NBV 趋势 单独展示 -->
                <div class="chart-card large">
                  <h3>💎 新业务价值NBV趋势（2020-2026 分季度 · 含TTM滚动）</h3>
                  <div id="deepNBV" class="chart"></div>
                  <div class="chart-caption" id="deepNBVNote"></div>
                </div>
                <!-- 投资收益率趋势 单独展示 -->
                <div class="chart-card large">
                  <h3>📈 投资收益率趋势（总投资收益率）</h3>
                  <div id="deepInvestmentYield" class="chart"></div>
                  <div class="chart-caption" id="deepInvestmentYieldNote"></div>
                </div>
                <div class="chart-card large">
                  <h3>💰 营运利润 vs 净利润对比</h3>
                  <div id="deepProfitComparison" class="chart"></div>
                </div>
                <!-- 分业务营收趋势（近10年） -->
                <div class="chart-card large">
                  <h3>📈 寿险（寿险及健康险板块）保费收入趋势</h3>
                  <div id="deepLifeTrend" class="chart"></div>
                </div>
                <div class="chart-card large">
                  <h3>📈 财产保险（平安产险）保费收入趋势</h3>
                  <div id="deepPropertyTrend" class="chart"></div>
                </div>
                <div class="chart-card large">
                  <h3>📈 养老险（平安养老）保险业务收入趋势</h3>
                  <div id="deepPensionTrend" class="chart"></div>
                </div>
                <div class="chart-card large">
                  <h3>📈 健康险（平安健康）保险业务收入趋势</h3>
                  <div id="deepHealthTrend" class="chart"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- 行业分析 tab -->
          <div id="tab-industry" class="tab-panel">
            <div id="industryLoading" class="deep-loading hidden">
              <div class="loading-spinner"></div>
              <p>正在获取行业政策、板块与研报数据，请稍候...</p>
            </div>
            <div id="industryContent" class="industry-content">
              <!-- 期货指数分析（仅产品相关时显示） -->
              <div class="chart-card large" id="indFuturesCard" style="display:none;">
                <div class="chart-header">
                  <h3>📈 期货指数分析（股价 vs <span id="indFuturesName">期货</span>）</h3>
                  <div class="chart-controls">
                    <span id="indFuturesCorrBadge" class="corr-badge"></span>
                  </div>
                </div>
                <div id="indFuturesChart" class="chart"></div>
                <div id="indFuturesConclusion" class="futures-conclusion"></div>
              </div>

              <!-- 行业分析总览：行业归属 + 行业指数 + 走势（合并卡片） -->
              <div class="chart-card large" id="industryOverviewCard">
                <div class="chart-header">
                  <h3>🏭 行业分析总览</h3>
                  <div class="ai-head-actions">
                    <span id="industryOverviewDate" class="ai-date"></span>
                    <button class="btn-journal-add" id="industryOverviewAiBtn">AI 联网获取</button>
                    <button class="btn-text" id="industryOverviewRefresh" style="display:none">重新搜索</button>
                  </div>
                </div>
                <div id="industryOverviewBody" class="industry-overview-body">
                  <div class="ai-empty">正在加载行业信息…</div>
                </div>
              </div>

              <!-- 行业景气度（20260920a 新增）：个股所属申万二级行业内「全部公司」的
                   总营收（TTM 滚动12个月合计）与总市值（报告期末合计）双坐标折线对比；
                   卡片下方标注行业公司数量 / 覆盖度 / 同比与背离判读 / 数据源。
                   由 IndustryCharts.renderIndustryProsperity 渲染，无数据时整卡隐藏。 -->
              <div class="chart-card large" id="indProsperityCard" style="display:none;">
                <div class="chart-header">
                  <h3>🌡️ 行业景气度 · <span id="indProsperityIndustry">所属行业</span></h3>
                  <div class="ai-head-actions">
                    <span id="indProsperityDate" class="ai-date"></span>
                  </div>
                </div>
                <div id="indProsperityChart" class="chart" style="height:420px;"></div>
                <div id="indProsperityNote" class="sh-source"></div>
              </div>

              <!-- 板块总市值走势（统一模板）：个股市值 vs 所属申万一级/二级/三级行业板块总市值，双坐标三张图
                   （由 IndustryCharts.renderSectorCapGroup 动态生成；无对应三级板块时省略第三张） -->
              <div id="sectorCapGroup"></div>

              <!-- 政策前景 -->
              <div class="chart-card large" id="indPolicy"></div>

              <!-- 公司研报（针对本公司） -->
              <div class="chart-card large">
                <h3>📊 公司研报（近一年·针对 <span id="indCompanyReportName">本公司</span>）</h3>
                <div id="indCompanyReportList" class="research-panel"></div>
              </div>

              <!-- 行业研报（所属行业相关） -->
              <div class="chart-card large">
                <h3>📚 行业研报（近一年·<span id="indIndustryReportName">所属行业</span>）</h3>
                <div id="indReportList" class="research-panel"></div>
              </div>
            </div>
          </div>

          <!-- 资金量能 tab -->
          <div id="tab-capital" class="tab-panel">
            <div id="capitalLoading" class="deep-loading hidden">
              <div class="loading-spinner"></div>
              <p>正在获取资金流向和量能数据，请稍候...</p>
            </div>
            <div id="capitalContent" class="capital-content">
              <!-- 量能分析引擎（20261024i：原独立「量价关系分析」卡已合并进本卡，重复指标去重；
                   20261101k：顶部改为「资金量能综合判断」，量价配合行仅保留指标卡；
                   量比/量能热度与「量能档位」重复，不再单独展示） -->
              <div class="chart-card large">
                <h3>🔬 量能分析（量价 × 价格位置 × 量能行为）</h3>
                <div id="capVolumeEngine" class="capital-summary"></div>
              </div>

              <!-- 资金流向趋势 -->
              <div class="chart-card large">
                <h3>💰 主力资金流向（近60日）</h3>
                <div id="capMoneyFlowChart" class="chart"></div>
              </div>

              <!-- 每日20日量能比趋势（[20261109d] 用户指令：原每日量比趋势改为每日20日量能比；
                   口径=当日量÷前20日均量（不含当日），与判定层 ratio20 同源，阈值线 1.3 放量 / 0.8 缩量 -->
              <div class="chart-card large">
                <h3>📉 每日20日量能比趋势（近60日）</h3>
                <div id="capVolRatioChart" class="chart"></div>
              </div>

              <div class="chart-grid">
                <!-- 资金流向汇总 -->
                <div class="chart-card">
                  <h3>📋 资金流向汇总</h3>
                  <div id="capFlowSummary" class="capital-summary"></div>
                </div>
                <!-- 量能指标 -->
                <div class="chart-card">
                  <h3>📐 量能指标</h3>
                  <div id="capVolIndicators" class="capital-summary"></div>
                </div>
              </div>

              <div class="chart-grid">
                <!-- OBV 指标 -->
                <div class="chart-card">
                  <h3>📈 OBV 能量潮</h3>
                  <div id="capOBVChart" class="chart"></div>
                </div>
                <!-- VR 指标 -->
                <div class="chart-card">
                  <h3>📊 VR 容量比率</h3>
                  <div id="capVRChart" class="chart"></div>
                </div>
              </div>

              <!-- 成交量与均量 -->
              <div class="chart-card large">
                <h3>📊 成交量与均量趋势</h3>
                <div id="capVolumeChart" class="chart"></div>
              </div>

              <!-- 融资融券 -->
              <div class="chart-card large">
                <h3>🏦 融资融券数据</h3>
                <div id="capMarginChart" class="chart"></div>
              </div>

              <!-- 20261101k：「资金量能综合判断」卡上移进「量能分析」卡顶部（替换原量能信号横幅），
                   原页底独立卡删除避免双份展示；融资融券明细改为通栏（chart-card large）保持布局对称 -->
              <div class="chart-card large">
                <h3>📋 融资融券明细</h3>
                <div id="capMarginSummary" class="capital-summary"></div>
              </div>
            </div>
          </div>

          <!-- 个股亮点/雷点 记录（issue4：亮点与雷点放在一起，按股票存储） -->
          <div id="tab-journal" class="tab-panel">
            <div id="stockNotesContainer" class="stock-notes-container"></div>
          </div>

          <!-- Document Store tab -->
          <div id="tab-docs" class="tab-panel">
            <div id="docStoreContainer" class="doc-store-container"></div>
          </div>

          <!-- Strategy Backtest Validation tab -->
          <div id="tab-backtest" class="tab-panel">
            <div class="bt-wrap">
              <div class="bt-header">
                <h2>🎯 策略（虚拟盘风控闸门）</h2>
                <p class="muted">自动取当前个股前复权日线 → 由代码确定性生成多套交易策略 → 虚拟回测（T+1 次日开盘成交）→ 统计检验与胜率修正 → 给出校验结论与操作建议。全部由代码确定性计算，不构成投资建议。<br>其中「趋势跟踪·短期行情判定（技术核心）」为派生策略：它复用工作台自身的行情判定结论（priceAction.shortTerm.direction，见 lib/strategyGenerator.js:198-222），把同一套确定性技术内核回算成历史买卖信号，属工作台内部联动，不是外部 AI 或第三方信号源。</p>
              </div>
              <div class="bt-controls">
                <span id="btCurrentStock" class="bt-current">当前个股：—</span>
                <label>回测区间
                  <select id="btRange">
                    <option value="1y">近 1 年</option>
                    <option value="2y">近 2 年</option>
                    <option value="3y" selected>近 3 年</option>
                    <option value="5y">近 5 年</option>
                  </select>
                </label>
                <button id="btAuto" class="btn-primary bt-auto">生成并校验策略</button>
                <span id="btStatus" class="bt-status"></span>
              </div>
              <p class="bt-hint">无需输入任何代码：直接点「生成并校验策略」，工作台会取当前个股的 <b>60 分钟 K 线</b>（回退日线）按五大类（趋势跟踪 / 均值回归 / 动量轮动 / 价值基本面 / 事件驱动）确定性生成多套策略并逐一校验，给出胜率与操作建议；虚拟交易硬约束 <b>每天最多 1 笔</b>。</p>
              <details class="bt-advanced">
                <summary>高级（可选）：用大白话或规则代码自定义策略</summary>
                <p class="bt-hint">可以直接用中文描述，如：「5日均线上穿20日均线买入，5日均线下穿20日均线卖出」。支持：均线金叉/死叉、MACD、RSI、布林带、收益率 z-score。也可点下面「模板」一键填入，或直接用上方「生成并校验策略」（无需输入）。中文→规则由<b>确定性代码</b>翻译（同一句话结果永远一致），不调用 AI。</p>
                <div id="btPresets" class="bt-presets"></div>
                <textarea id="btDsl" spellcheck="false">5日均线上穿20日均线买入，5日均线下穿20日均线卖出</textarea>
                <button id="btRun" class="btn-secondary">运行我的策略</button>
              </details>
              <div id="btResult"></div>
            </div>
          </div>

          <!-- 个股行情判断记录（20261107 升级：原「个股记录」改为行情判断记录；
               含涨跌方向下拉、判断依据下拉、备注输入、关键词检索、方向/依据筛选、日期排序切换；纯手动，不参与任何判断） -->
          <div id="tab-stocklog" class="tab-panel">
            <div class="sl-wrap">
              <div class="sl-add">
                <div class="sl-add-head-row">
                  <div class="sl-add-head">添加行情判断</div>
                  <!-- 20261108d：单行胶囊标签，与标题同一基线；完整明细/口径收进 title，不再撑高头部 -->
                  <div class="sl-acc" id="slAccuracy" title="读取中…">
                    <span class="sl-acc-label">涨跌幅判断准确率</span>
                    <span class="sl-acc-value" id="slAccRate">—</span>
                    <span class="sl-acc-sub" id="slAccDetail">—</span>
                  </div>
                </div>
                <div class="sl-add-row">
                  <input type="date" id="slDate" title="判断日期">
                  <select id="slDir" title="涨跌方向（可不选；未选不纳入准确率统计）">
                    <option value="" selected>未选方向</option>
                    <option value="up">上涨</option>
                    <option value="sideways">震荡</option>
                    <option value="down">下跌</option>
                  </select>
                  <select id="slBasis" title="判断依据（可不选）">
                    <option value="" selected>未选依据</option>
                    <option value="technical">技术面</option>
                    <option value="news">消息面</option>
                    <option value="other">其他</option>
                  </select>
                </div>
                <textarea id="slNote" rows="2" placeholder="记录该个股的行情判断（如：缩量止跌、政策利好、减持公告……）"></textarea>
                <button id="slAdd" class="btn-primary">添加记录</button>
              </div>
              <div class="sl-toolbar">
                <input type="text" id="slSearch" class="sl-search" placeholder="🔍 检索备注 / 日期 / 方向 / 依据…">
                <select id="slFilterDir" class="sl-filter" title="按方向筛选">
                  <option value="">全部方向</option>
                  <option value="up">上涨</option>
                  <option value="sideways">震荡</option>
                  <option value="down">下跌</option>
                </select>
                <select id="slFilterBasis" class="sl-filter" title="按依据筛选">
                  <option value="">全部依据</option>
                  <option value="technical">技术面</option>
                  <option value="news">消息面</option>
                  <option value="other">其他</option>
                </select>
                <button id="slSortBtn" class="sl-sort" title="切换排序（先后/倒序）">日期↑（先后）</button>
              </div>
              <div id="stockLogContainer" class="sl-list"></div>
            </div>
          </div>
        </div>
      </div>
    </main>
  </div>

  <!-- Toast notification -->
  <div id="toast" class="toast" role="status" aria-live="polite"></div>

  <!-- 右键菜单（自选股） -->
  <div id="watchlistContextMenu" class="context-menu hidden"></div>

  <!-- 二次确认弹窗 -->
  <div id="confirmDialog" class="confirm-overlay hidden" role="dialog" aria-modal="true">
    <div class="confirm-dialog">
      <div class="confirm-head">
        <h3 id="confirmTitle">确认操作</h3>
        <button class="confirm-x" id="confirmClose" title="关闭">✕</button>
      </div>
      <div class="confirm-body"><p id="confirmMessage"></p></div>
      <div class="confirm-foot">
        <button class="btn-secondary" id="confirmCancel">取消</button>
        <button class="btn-primary" id="confirmOk">确认</button>
      </div>
    </div>
  </div>

  <!-- 快捷键提示层 -->
  <div id="keyboardHelp" class="kb-overlay hidden" role="dialog" aria-modal="true">
    <div class="kb-dialog">
      <div class="kb-head">
        <h3>⌨️ 快捷键</h3>
        <button id="keyboardHelpClose" class="kb-close" title="关闭">✕</button>
      </div>
      <div class="kb-body">
        <div class="kb-row"><span class="kb-key">↑</span><span class="kb-key">↓</span><span class="kb-desc">切换自选股</span></div>
        <div class="kb-row"><span class="kb-key">Enter</span><span class="kb-desc">查看选中自选股</span></div>
        <div class="kb-row"><span class="kb-key">/</span><span class="kb-desc">聚焦搜索框</span></div>
        <div class="kb-row"><span class="kb-key">1–4</span><span class="kb-desc">切换周期（日K/周K/月K/60分钟）</span></div>
        <div class="kb-row"><span class="kb-key">Esc</span><span class="kb-desc">关闭弹窗 / 下拉</span></div>
        <div class="kb-row"><span class="kb-key">滚轮</span><span class="kb-desc">图表缩放</span></div>
        <div class="kb-row"><span class="kb-key">拖拽</span><span class="kb-desc">图表平移 · 双击复位</span></div>
      </div>
    </div>
  </div>

  <!-- 错误占位横幅（断网 / 接口异常，保留已展示数据） -->
  <div id="errorBanner" class="error-banner hidden" role="alert">
    <span class="err-icon">⚠️</span>
    <span class="err-msg" id="errorBannerMsg">数据加载失败</span>
    <button class="err-retry" id="errorBannerRetry">重试</button>
    <button class="err-close" id="errorBannerClose" title="关闭">✕</button>
  </div>

  <script src="js/storage.js?v=20261106p"></script>
    <script src="js/chartTheme.js?v=20261106p"></script>
    <script src="js/chart3D.js?v=20261106p"></script>
    <script src="js/charts.js?v=20261110b"></script>
  <script src="js/deepCharts.js?v=20261106p"></script>
  <script src="js/industryCharts.js?v=20261106p"></script>
  <script src="js/capitalCharts.js?v=20261110b"></script>
  <script src="js/notes.js?v=20261106p"></script>
  <script src="js/shareholderCharts.js?v=20261110b"></script>
  <script src="js/docStore.js?v=20261106p"></script>
  <script src="js/export.js?v=20261106p"></script>
  <script src="js/homeNews.js?v=20261106p"></script>
  <script src="js/homeHotTopics.js?v=20261106p"></script>
  <script src="js/homeMacro.js?v=20261110b"></script>
  <script src="js/homeRank.js?v=20261106p"></script>
  <script src="js/dataStatus.js?v=20261106p"></script>
  <!-- logicModel.js 已移至独立页面 logic-model.html 引用（20261025c 弹窗改页面），首页不再加载 -->

  <script src="js/stockLog.js?v=20261108d"></script>
  <script src="js/app.js?v=20261110b"></script>
  <script src="js/backtestUI.js?v=20261106p"></script>

  <!-- AI 设置弹窗（20260902e：双模型 · 联网 / 本地分离） -->
  <div class="ai-modal-overlay hidden" id="aiSettingsModal">
    <div class="ai-modal ai-modal-wide">
      <div class="ai-modal-head">
        <h3>⚙️ AI 模型设置（联网 / 本地）</h3>
        <button class="ai-close" id="aiSettingsClose" title="关闭">✕</button>
      </div>
      <div class="ai-modal-body">
        <p class="ai-settings-note">工作台本身不能上网，AI 能力由你自配的大模型 API 提供。Key 仅保存在你本机 <code>data/ai_config.json</code>，不会上传。默认 <b>通义千问（DashScope）</b>，申请地址 <span class="ai-link">dashscope.aliyun.com</span>。</p>

        <div class="ai-cat-legend">
          <div class="ai-cat-row">
            <span class="ai-cat-tag web">联网模型</span>
            <span class="ai-cat-desc"><b>需要模型先上网获取信息，再进行分析。</b> 工作台自身不能上网，因此调用带联网搜索能力的大模型。适用：个股资料补全、投资亮点/雷点、产品与客户、公司综合介绍、供应链与成本、大盘概览、行业指数、研报检索、公告检索、异动归因、网络热议等。</span>
          </div>
          <div class="ai-cat-row">
            <span class="ai-cat-tag local">本地模型</span>
            <span class="ai-cat-desc"><b>只需要模型分析本地数据、做逻辑推导。</b> 例如分析本地财务数据库中的财报文本、已上传年报、复杂图表、生成分析报告等。当前<b>财报解读</b>会自动注入本地营收/净利全序列与同比·边际，不联网、不消耗检索额度。未配置本地模型时，自动回退到联网模型（但仍关闭联网检索）。</span>
          </div>
        </div>

        <label class="ai-field-label">服务商</label>
        <select id="aiProvider" class="ai-input">
          <option value="qwen">通义千问 Qwen（推荐，原生联网搜索）</option>
          <option value="glm">智谱 GLM（联网搜索）</option>
          <option value="openai">OpenAI（需自备搜索方案）</option>
        </select>
        <label class="ai-field-label">API Key</label>
        <input type="password" id="aiApiKey" class="ai-input" placeholder="粘贴你的 API Key（留空则保留原值）" autocomplete="off">
        <label class="ai-field-label">🌐 联网模型（modelWeb）</label>
        <input type="text" id="aiModelWeb" class="ai-input" placeholder="留空使用默认（qwen-max / glm-4-plus / gpt-4o-mini）">
        <label class="ai-field-label">💾 本地模型（modelLocal）</label>
        <input type="text" id="aiModelLocal" class="ai-input" placeholder="分析本地财报数据用；留空则回退到联网模型（仍不联网检索）">
        <label class="ai-field-label">🔍 联网搜索方式</label>
        <select id="aiSearchMode" class="ai-input">
          <option value="builtin">内置联网搜索（enable_search，无免费额度，约 0.003 元/次）</option>
          <option value="mcp">阿里百炼联网搜索 MCP（前 2000 次调用免费，一次性总额度，超出约 0.029 元/次）</option>
          <option value="volc">火山豆包搜索（每月 500 次免费，每月 1 日重置，超出 0.020 元/次）</option>
          <option value="baidu">百度千帆 AI 搜索 MCP（每日 100 次免费，每日重置，超出约 0.008 元/次）</option>
        </select>
        <p class="ai-settings-note" id="aiSearchModeNote">火山与百度为<b>周期性重置</b>免费额度（约 500 次/月、3000 次/月），按本工作台当前用量可长期免费；阿里 2000 次为一次性总额度、用完不再重置；内置搜索无免费额度，留作回退。</p>

        <div id="aiVolcFields" class="hidden">
          <label class="ai-field-label">🌋 火山方舟 Ark API Key</label>
          <input type="password" id="aiVolcApiKey" class="ai-input" placeholder="火山方舟通用 API Key（留空则保留原值；未配置时自动回退内置搜索）" autocomplete="off">
          <label class="ai-field-label">🌋 火山豆包模型（可留空）</label>
          <input type="text" id="aiVolcModel" class="ai-input" placeholder="留空使用默认 doubao-seed-1-6-250615">
        </div>

        <div id="aiBaiduFields" class="hidden">
          <label class="ai-field-label">🐾 百度千帆 API Key</label>
          <input type="password" id="aiBaiduApiKey" class="ai-input" placeholder="千帆平台 API Key（留空则保留原值；未配置时自动回退内置搜索）" autocomplete="off">
        </div>

        <div id="aiSettingsStatus" class="ai-settings-status"></div>
      </div>
      <div class="ai-modal-foot">
        <button class="btn-secondary" id="aiSettingsCancel">取消</button>
        <button class="btn-primary" id="aiSettingsSave">保存</button>
      </div>
    </div>
  </div>
</body>
</html>

~~~

---

## `public\js\accuracy.js`  ·  469 行

~~~js
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

  // 20260928c：聚合行（各股）统一展示「最新判断日 + 数据区间」——聚合卡本身没有单一判定日期，
  // 用「该股全部判断记录的最早/最晚 baseDate」表达覆盖范围与数据新鲜度（两处聚合卡共用同一口径）。
  function dateLine(minDate, maxDate) {
    const a = minDate ? String(minDate) : '', b = maxDate ? String(maxDate) : '';
    if (!b) return '';
    return a && a !== b
      ? `📅 最新判断 ${esc(b)} · 数据区间 ${esc(a)} ~ ${esc(b)}`
      : `📅 判断日 ${esc(b)}`;
  }

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
      ? `<div class="jd-rec-list">${d.bySymbol.map(s => {
          const dl = dateLine(s.minDate, s.maxDate);
          return `<div class="jd-rec">
            <div class="jd-rec-head">
              <span class="jd-rec-sym">${esc(s.symbol)}</span>
              <span class="jd-rec-name">${esc(s.name || '')}</span>
              <span class="jd-rec-date">${s.settledCount} 已结算 / ${s.pendingCount} 待验证</span>
            </div>
            <div class="jd-rec-body">
              <div class="jd-rec-row">准确率 <b>${pct(s.accuracy)}</b>（${s.correct}/${s.settledCount}） · 涨 ${pct(s.bullRate)} / 跌 ${pct(s.bearRate)} / 震荡 ${pct(s.flatRate)}</div>
              ${dl ? `<div class="jd-rec-row jd-rec-dates">${dl}</div>` : ''}
              <div class="jd-rec-row"><button class="btn-text jd-view-btn" data-symbol="${esc(s.symbol)}">查看逐条记录 →</button></div>
            </div>
          </div>`;
        }).join('')}</div>`
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
      if (!bySym[k]) bySym[k] = { symbol: k, name: r.name || '', t: 0, c: 0, p: 0, dates: [] };
      if (r.date) bySym[k].dates.push(String(r.date));
      if (r.settled) { bySym[k].t++; if (r.correct) bySym[k].c++; } else bySym[k].p++;
    }
    const list = Object.values(bySym).sort((x, y) => y.t - x.t);
    document.getElementById('sdCount').textContent = `${list.length} 只 · ${(d.records || []).length} 条`;
    document.getElementById('sdBySymbol').innerHTML = list.length
      ? `<div class="jd-rec-list">${list.map(s => {
          const rate = s.t ? Math.round(s.c / s.t * 1000) / 10 : null;
          const ds = (s.dates || []).slice().sort();
          const dl = dateLine(ds[0], ds.slice(-1)[0]);
          return `<div class="jd-rec">
            <div class="jd-rec-head">
              <span class="jd-rec-sym">${esc(s.symbol)}</span>
              <span class="jd-rec-name">${esc(s.name)}</span>
              <span class="jd-rec-date">${s.t} 已结算 / ${s.p} 待验证</span>
            </div>
            <div class="jd-rec-body">
              <div class="jd-rec-row">准确率 <b>${pct(rate)}</b>（${s.c}/${s.t}）</div>
              ${dl ? `<div class="jd-rec-row jd-rec-dates">${dl}</div>` : ''}
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
                : `<span class="jd-pending">待验证（第${x.horizon}交易日・预计 ${esc(x.targetDate || '')} 结算；遇长假顺延）</span>`}</div>
            </div>
          </div>`).join('')}</div>`
      : '<div class="data-empty">该股暂无技术面记录。</div>';
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const PANELS = { market: 'marketPanel', tech: 'techPanel', sameDay: 'sameDayPanel', sentiment: 'sentimentPanel', consistency: 'consistencyPanel' };

  // ===== 数据巡检（20261103e）：跨板块同数据一致性核对 =====
  async function loadConsistency(force) {
    const kpis = document.getElementById('caKpis');
    const calib = document.getElementById('caCalib');
    const body = document.getElementById('caBody');
    const cnt = document.getElementById('caCount');
    try {
      const res = await fetch('/api/consistency-audit' + (force ? '?force=1' : ''));
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        kpis.innerHTML = '';
        calib.innerHTML = '';
        cnt.textContent = '';
        body.innerHTML = `<div class="data-empty">今日尚无巡检报告${err.dates && err.dates.length ? '。历史报告日期：' + esc(err.dates.join('、')) : ''}。可点「结算并刷新」立即执行一次巡检。</div>`;
        return;
      }
      const r = await res.json();
      const t = r.totals || { ok: 0, caliber: 0, mismatch: 0, missing: 0 };
      kpis.innerHTML = [
        kpi('巡检股票', String(r.symbolCount || 0), `报告日期 ${esc(r.date || '—')}`, ''),
        kpi('核对项', String(t.ok + t.caliber + t.mismatch + t.missing), '同一数据多板块互比', ''),
        kpi('一致', String(t.ok), '同口径数值一致', t.ok > 0 ? 'good' : ''),
        kpi('口径差异', String(t.caliber), '累计/单季/TTM 已注记', t.caliber > 0 ? 'na' : ''),
        kpi('不一致', String(t.mismatch), t.mismatch > 0 ? '需修复' : '无', t.mismatch > 0 ? 'bad' : 'good'),
        kpi('缺数据跳过', String(t.missing), '如实标注不误报', t.missing > 0 ? 'na' : ''),
      ].join('');
      calib.innerHTML = r.health === 'warn'
        ? '<b>⚠️ 存在同口径数值不一致项，请结合下方明细排查数据链</b>'
        : '<b>✓ 全部核对项通过</b>：同数据跨板块展示一致；累计/单季等口径差异已如实注记。';
      const statusBadge = (st) => st === 'ok' ? '<span class="jd-ok">✓ 一致</span>'
        : st === 'mismatch' ? '<span class="jd-bad">✗ 不一致</span>'
        : st === 'caliber' ? '<span class="jd-pending">◐ 口径差异</span>'
        : '<span class="jd-pending">– 缺数据</span>';
      cnt.textContent = `${(r.results || []).length} 只 · ${r.ranAt ? esc(String(r.ranAt).replace('T', ' ').slice(0, 16)) : ''}`;
      body.innerHTML = (r.results || []).map(sym => {
        if (sym.error) {
          return `<div class="jd-record"><div class="jd-rec-head"><b>${esc(sym.symbol)} ${esc(sym.name || '')}</b></div>
            <div class="jd-rec-body"><div class="jd-rec-row"><span class="jd-bad">巡检执行失败</span> ${esc(sym.error)}</div></div></div>`;
        }
        const rows = (sym.checks || []).map(c => `<tr>
            <td>${esc(c.metric)}</td>
            <td>${statusBadge(c.status)}</td>
            <td class="ca-note">${esc(c.note || '')}</td>
          </tr>`).join('');
        const bad = (sym.summary && sym.summary.mismatch) || 0;
        return `<div class="jd-record">
          <div class="jd-rec-head"><b>${esc(sym.symbol)} ${esc(sym.name || '')}</b>
            <span>${bad > 0 ? '<span class="jd-bad">需修复</span>' : '<span class="jd-ok">通过</span>'}
            · 一致 ${sym.summary.ok} / 口径差异 ${sym.summary.caliber} / 不一致 ${sym.summary.mismatch} / 缺数据 ${sym.summary.missing}</span></div>
          <div class="jd-rec-body"><table class="ca-table"><thead><tr><th>核对项</th><th>结果</th><th>说明</th></tr></thead><tbody>${rows}</tbody></table></div>
        </div>`;
      }).join('');
    } catch (e) {
      body.innerHTML = `<div class="data-empty">巡检报告加载失败：${esc(e.message)}</div>`;
    }
  }

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
      } else if (state.tab === 'consistency') {
        // 20261103e：巡检页无结算语义，结算按钮 = 立即重跑一次巡检（?force=1）
        tx.textContent = '正在重跑跨板块数据一致性巡检（逐只拉取自选股载荷）…';
        await loadConsistency(true);
      }
    } catch (e) { console.error(e); }
    // 20261016：结算完成确定性反馈——KPI 数字闪烁一次（复用 numFlash 动画），明确告知数据已刷新
    document.querySelectorAll('.acc-kpi .k-value').forEach(el => {
      el.classList.remove('num-flash');
      void el.offsetWidth;
      el.classList.add('num-flash');
    });
    ov.classList.add('hidden');
  }

  function bind() {
    document.querySelectorAll('.acc-tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    document.getElementById('settleBtn').addEventListener('click', settleAndReload);
    document.getElementById('reloadBtn').addEventListener('click', async () => {
      if (state.tab === 'market') await loadMarket();
      else if (state.tab === 'tech') await loadTech();
      else if (state.tab === 'sameDay') await loadSameDay();
      else if (state.tab === 'consistency') await loadConsistency();
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
    const ALLOWED = ['market', 'tech', 'sameDay', 'sentiment', 'consistency'];
    const tab = ALLOWED.includes(params.get('tab')) ? params.get('tab') : 'market';
    const sym = params.get('symbol');
    switchTab(tab);
    if (sym) {
      if (tab === 'sameDay') document.getElementById('sdSymbolInput').value = sym;
      else document.getElementById('symbolInput').value = sym;
    }
    await Promise.all([loadMarket(), loadTech(), loadSameDay(), loadSentiment(), loadConsistency()]);
    if (sym && tab === 'tech') await loadTechSymbol(sym);
    if (sym && tab === 'sameDay') await loadSameDaySymbol(sym);
  });
})();

~~~

---

## `public\js\app.js`  ·  8800 行

~~~js
/**
 * Main Application Logic
 */

// 20261025a：量能档位视觉区分（放量系暖色 / 缩量系冷色 / 平量与数据不足默认白，用户 2026-10-25 要求）。
// [20261109b] 全工作台颜色铁律修正：放量 ≠ 利好、缩量 ≠ 利空（放量下跌同样是利空），
// 原先返回 cap-pos(红)/cap-neg(绿) 会把「量能状态」误读成方向结论。
// 改为不改语义的暖/冷中性色，保留用户要的「一眼可分辨」，但不占用红绿方向色。
// 档位真值源 lib/volumeEngine.js VOLUME_TIERS：极度缩量/温和缩量/平量/温和放量/大量/天量；
// 60日确认：放量确认/缩量确认/平量。正则覆盖全部档位词，仅对量能语义字段使用。
function volTierCls(s) {
  const t = String(s == null ? '' : s);
  if (/放量|大量|天量/.test(t)) return 'tp-vol-active';
  if (/缩量|地量/.test(t)) return 'tp-vol-quiet';
  return '';
}

// 20261101：全局后台预加载状态指示。打开个股页即并发预读所有分页（见 renderDashboard 的自动加载块），
// 但进度条原本藏在未激活的 tab 面板里，用户看不到预读在进行，误以为"切换页面后才开始读取"。
// 此指示器把"正在预读哪些分页"常驻显示在顶部导航，让预读过程可见。
const bgPreload = {
  _set: new Set(),
  el: null,
  _ensure() {
    if (this.el && document.body.contains(this.el)) return this.el;
    const nav = document.querySelector('.global-nav');
    const el = document.createElement('span');
    el.id = 'bgPreloadPill';
    el.style.cssText = 'display:none;margin-left:12px;padding:3px 10px;border-radius:12px;font-size:12px;background:rgba(240,185,123,0.92);color:#1a1a1a;white-space:nowrap;vertical-align:middle;';
    if (nav) nav.appendChild(el); else document.body.appendChild(el);
    this.el = el;
    return el;
  },
  start(label) {
    this._set.add(label);
    this._render();
  },
  finish(label) {
    this._set.delete(label);
    this._render();
  },
  _render() {
    const el = this._ensure();
    if (this._set.size === 0) { el.style.display = 'none'; return; }
    el.style.display = 'inline-block';
    el.textContent = '⏳ 后台预加载：' + Array.from(this._set).join('、');
  }
};

// 关键指标释义（点击指标标签后的「?」图标展示）
const METRIC_HELP = {
  '市盈率(PE)': { title: '市盈率 PE', body: '市盈率 = 股价 ÷ 每股收益，表示按当前盈利多少年回本。<br>· 越低通常越便宜，但过低可能反映市场对其增长预期差；<br>· 不同行业不可直接比，成长股 PE 天然偏高。' },
  '市盈率(PE·TTM)': { title: '市盈率 PE(TTM)', body: '<b>PE(TTM) = 总市值 ÷ 近12个月归母净利（滚动12个月口径）</b>，随行情每日更新，不绑定某一财报期。<br>· 亏损股 PE 为负，市盈率失效；<br>· 不同行业不可直接比，成长股 PE 天然偏高。' },
  '市净率(PB)': { title: '市净率 PB', body: '市净率 = 股价 ÷ 每股净资产，反映股价相对账面资产的溢价。<br>· 每股净资产为<b>最新报告期（MRQ）时点值</b>，非 TTM 概念；<br>· PB&lt;1（破净）可能低估，但也可能是资产质量差；<br>· 银行、地产等重资产行业常用 PB 估值。' },
  '市销率(PS)': { title: '市销率 PS', body: '市销率 = 市值 ÷ 营业收入，适合尚未盈利的成长型公司。<br>· 看"收入规模"与估值的匹配度；<br>· PS 低不代表便宜，需结合利润率看。' },
  '市销率(PS·TTM)': { title: '市销率 PS(TTM)', body: '<b>PS(TTM) = 总市值 ÷ 近12个月营业收入（滚动12个月口径）</b>，随行情每日更新。<br>· 分母为东方财富 PS_TTM 权威值；<br>· PS 低不代表便宜，需结合利润率看。' },
  'PEG': { title: 'PEG', body: 'PEG = 市盈率 PE(TTM) ÷（盈利增长率×100）。<br>· PEG≈1 表示估值与成长性匹配；<br>· &lt;1 可能被低估，&gt;1 可能偏贵（仅适用于正增长公司）。<br>· 当前行情数据源未提供 PEG 字段时，本工具显示「--」而不估算。' },
  'ROE': { title: '净资产收益率 ROE', body: 'ROE = 净利润 ÷ 净资产，衡量用股东投入赚钱的能力。<br>· 长期 ROE&gt;15% 是优质公司的标志；<br>· 但过高的 ROE 也可能来自高杠杆（债务），需结合资债比看。' },
  '毛利率': { title: '毛利率', body: '毛利率 =（营业收入 − 营业成本）÷ 营业收入。<br>· 反映产品竞争力与定价权，越高越能抵御成本上涨；<br>· 茅台式高毛利代表强品牌护城河。' },
  '净利率': { title: '净利率', body: '净利率 = 净利润 ÷ 营业收入，扣除税费、利息、费用后的真实盈利能力。<br>· 比毛利率更综合，受费用率、减值等影响。' },
  '营收增长': { title: '营收增长', body: '营业收入同比增速（YoY）。<br><b>20261102a 起为「单季优先」口径：</b>优先展示最新单季营收同比（东财主要指标 DJD_TOI_YOY），单季缺失时回退报告期累计同比并在悬浮标注。<br>· 单季更能反映<b>当期</b>业务扩张速度，累计值易被上半年高基数/低基数平滑；<br>· &gt;15% 通常视为高成长；负增长一般偏利空（金融/周期类需结合行业阶段看）。' },
  '归母净利润': { title: '归母净利润', body: '归母净利润同比增速（YoY）。<br><b>20261102a 起为「单季优先」口径：</b>优先展示最新单季归母净利同比（DJD_DPNP_YOY），单季缺失时回退报告期累计同比并在悬浮标注。<br>· 比营收增长更关键，需警惕"增收不增利"；<br>· 单季口径对偶发大额损益更敏感，请结合扣非增速一起看。' },
  '扣非净利润增长': { title: '扣非净利润增长', body: '扣非归母净利润同比增长（YoY）——剔除政府补助、资产处置、公允价值变动等<b>非经常性损益</b>后的归母净利润增速。<br><b>20261102a 起为「单季优先」口径：</b>优先展示最新单季扣非同比（DJD_DEDUCTDPNP_YOY），单季缺失时回退报告期累计同比并在悬浮标注。<br>· 比「利润增长」更能反映<b>主营业务的真实盈利趋势</b>；<br>· 若扣非增速显著低于归母增速，说明利润中含较多一次性收益，需警惕；<br>· 来源：东方财富 F10 主要指标（单季 DJD_DEDUCTDPNP_YOY 优先，累计 KCFJCXSYJLRTZ 回退；与左卡、深度分析同源）。' },
  '营运利润': { title: '营运利润（利润表「营业利润」）', body: '<b>本行取自利润表「营业利润」科目</b>（通用会计口径，全个股统一）= 营业收入 − 营业成本 − 税金及附加 − 期间费用 + 投资收益等，位于利润表中段，<b>尚未扣所得税与少数股东损益</b>。<br><b>20261102a 起为「单季优先」口径：</b>优先展示最新单季值（本期累计 − 上期累计差分，Q1 报告期单季=累计），单季不可得（缺上期累计）时如实回退累计并在悬浮标注。<br><b>与「扣非净利润」的区别：</b><br>· 营业利润看<b>经营盘面的整体盈利规模</b>（含投资收益/公允价值变动/减值等波动项，金融企业的利息与投资收入都计入其中）；<br>· 扣非净利润看<b>落到归母股东手里的经常性盈利</b>（剔除非经常项、已扣税）；<br>· 营业利润适合看盈利规模与结构，扣非增速适合看主业趋势。<br><i>注：中国平安等公司财报另披露一个非通用口径的「营运利润」（剔除短期投资波动等），本工具不采用该口径。</i>' },
  'NBV(新业务价值)': { title: 'NBV 新业务价值（保险股专属）', body: '<b>NBV = 新签保单在未来可贡献利润的折现值</b>，是寿险公司「新业务造血能力」的核心指标，<b>保险股专属</b>（非保险股无此概念）。<br>· 衡量的是「未来利润的现值」而非当期现金流，与净利润/扣非净利润口径完全不同；<br>· 同比为<b>去年同期同累计阶段</b>口径（如 2026H1 vs 2025H1），跨阶段不可比；<br>· 历史数据受精算假设调整影响（长期投资回报率假设 5%→4.5%→4%），跨年口径需注意；<br>· 数据来源：妙想金融数据 + 公司年报（备查库）。' },
  '资产负债率': { title: '资产负债率 · 信号算法详解', body: '<b>一、取数来源（两个口径，已自动识别）</b><br>· <b>A 股</b>：取东方财富 F10 资产负债表「资产负债率 ZCFZL」，单位是 <b>%</b>（如 89.88 表示 89.88%）。本工具已加 <code>debtMetricPct</code> 标记；<br>· <b>港股 / 美股</b>：取「带息债 ÷ 所有者权益」<b>比值</b>（无单位小数，如 0.27）。<br><br><b>二、信号判定步骤（evaluateSignals）</b><br>第 1 步：读取数值 d = 资产负债率（A股用% / 港股美股用比值）；<br>第 2 步：判断是否金融业（银行/保险/证券等）→ 直接判 <b>中性</b>（高负债是经营常态，不红不绿）；<br>第 3 步：非金融业，按口径分档：<br>&nbsp;&nbsp;▸ A股（%）：<b>＞70%</b> → 利空(绿)；<b>＜40%</b> → 利好(红)；40%~70% 合理区间不提示；<br>&nbsp;&nbsp;▸ 港股/美股（比值）：<b>＞2</b> → 利空(绿)；<b>＜0.5</b> → 利好(红)；中间不提示。<br><br><b>三、健康评分里的算法（fundamentalAnalysis）</b><br>同口径分档累加（满分 25 再按权重缩放）：A股 资产负债率 ＜40% 加12、40%~70% 加9、70%~90% 加5、＞90% 不加分；金融业 80%~96% 视为正常加10。<br><br><b>四、颜色与边界</b><br>红=利好、绿=利空，仅适用于<b>非金融</b>公司；金融业一律中性。例：中国平安 89.88%→中性；贵州茅台（A股，约 20%出头）→利好(红)。' },
  '流动比率': { title: '流动比率', body: '流动比率 = 流动资产 ÷ 流动负债，衡量短期偿债能力。<br>· &gt;2 较安全，&lt;1 可能短期资金紧张；<br>· 不同行业合理区间差异大（如零售天然较低）。' },
  '股息率': { title: '股息率', body: '股息率 = 每股分红 ÷ 股价（年化）。<br>· 红利型公司（银行、电力、煤炭等）看重此指标；<br>· 高股息率通常偏利好，但需警惕"分红不可持续"。' },
  '股息率(TTM)': { title: '股息率(TTM)', body: '<b>股息率(TTM) = 近12个月已实施除息的每股分红合计 ÷ 当前股价</b>（滚动12个月口径）。<br>· 无近12个月分红记录时回退「最近完整年度」口径并已在悬浮说明标注；<br>· 红利型公司（银行、电力、煤炭等）看重此指标；<br>· 高股息率通常偏利好，但需警惕"分红不可持续"。' },
  '每股经营现金流': { title: '每股经营现金流', body: '每股经营现金流 = 经营活动现金流量净额 ÷ 总股本。<br>· 反映公司日常经营真正产生了多少现金，比净利润更难粉饰；<br>· 若长期高于每股收益，说明盈利质量高、回款好。' },
};

const App = {
  currentData: null,
  currentSymbol: null,
  currentRange: '1y',
  searchDebounce: null,
  deepDataLoaded: false,
  deepData: null,
  capitalDataLoaded: false,
  capitalData: null,
  deepLoadedSymbol: null,
  capitalLoadedSymbol: null,
  shareholderLoadedSymbol: null,
  shareholderData: null,
  // 价格行为趋势推演（技术面页）
  paLoadedSymbol: null,
  paData: null,
  // 仪表盘三栏布局：中栏图表周期 / 自选股排序状态
  currentPeriod: 'daily',
  dailyHistory: [],
  dailyTechnical: null,
  history60m: [],
  technical60m: null,
  watchlistQuotes: {},
  watchlistSortKey: null,
  watchlistSortDir: 1,
  watchlistNavIndex: -1,   // ↑/↓ 键盘导航当前高亮项（-1 表示无）
  searchCursor: -1,        // 搜索下拉当前高亮项

  init() {
    this.bindEvents();
    this.renderWatchlist();
    // 自选股真源在服务端：启动后从服务端拉取，拉取完成再重渲染（localStorage 仅离线兜底）
    if (typeof Storage !== 'undefined' && Storage.initWatchlist) {
      Storage.initWatchlist().then(() => { this.renderWatchlist(); this.loadWatchlistQuotes(); this.startWatchlistQuoteRefresh(); }).catch(() => {});
    }
    // 详情页当前个股实时刷新（每 60s，与左侧自选股同源同频，消除「同一只股两个价」）
    this.startCurrentQuoteRefresh();
    this.renderHistory();
    // Initialize notes (投资心得 / 大盘记录 / 个股亮点雷点)
    if (typeof Notes !== 'undefined') {
      Notes.init();
    }
    // 深度分析折叠分组（仅执行一次，重组 #deepContent 内的卡片）
    this.initDeepGroups();
    // 20260914h：打开工作台即静默预热本地事实库（东财 F10：公司概况/经营范围/主营构成，
    // 纯抓取零 LLM 费用），并秒显已存的信息分析资料——无需用户点击、不自动联网。
    this._prefetchCompanyFacts();
    // 首页实时大盘概览
    this.loadMarketOverview();
    // 首页·大盘估值趋势（上证50 / 沪深300 / 科创50 近5年PE-TTM）
    this.loadIndexPeTrend();
    // 首页·大盘技术分析（上证/深证/创业板指 融合版六步 + 短线结构 + 外部变量）
    this.loadMarketTechnical();
    // 顶栏大盘行情状态栏（上证/深证/创业板/科创50/日经指数/恒生/纳斯达克/道琼斯）
    this.loadTopbarIndices();
    // 首页「今日财经热点」卡片
    if (typeof HomeNews !== 'undefined') {
      HomeNews.bind();
      HomeNews.load();
    }
    // 首页「今日最热股票投资话题」卡片（AI 联网聚合同花顺/雪球/东方财富）
    if (typeof HomeHotTopics !== 'undefined') {
      HomeHotTopics.bind();
      HomeHotTopics.load();
    }
    // 首页「每日宏观 & 政策」卡片
    if (typeof MacroNews !== 'undefined') {
      MacroNews.bind();
      MacroNews.load();
    }
    // 首页「基金 & 机构重仓排行」卡片
    if (typeof HomeRank !== 'undefined') {
      HomeRank.bind();
      HomeRank.load();
    }
    // 首页「市场情绪拐点」全局预警条
    this.loadSentimentTurningPoint();
    // 首页「行业板块拥挤度」
    this.loadSectorCrowding();
    const crowdingRefreshBtn = document.getElementById('crowdingRefreshBtn');
    if (crowdingRefreshBtn) {
      crowdingRefreshBtn.addEventListener('click', () => this.loadSectorCrowding(true));
    }
    // 首页日期
    const homeDate = document.getElementById('homeDate');
    if (homeDate) homeDate.textContent = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    // AI 配置（用于判断补全按钮是否需要提示先设置 Key）
    this.loadAIConfig();
    // 首页卡片折叠（默认收起，localStorage 记忆）
    this.initHomeCollapsible();

    // URL 携带 ?symbol= 时，启动后自动加载该个股，刷新即可保留在当前页面
    try {
      const params = new URLSearchParams(location.search);
      const symbolFromUrl = params.get('symbol');
      if (symbolFromUrl) {
        // 延迟到 init 完成后再加载，确保 DOM/事件已就绪
        setTimeout(() => this.analyze(symbolFromUrl), 0);
      }
    } catch (e) {}
    const marketRefreshBtn = document.getElementById('marketRefreshBtn');
    if (marketRefreshBtn) {
      marketRefreshBtn.addEventListener('click', () => this.loadMarketOverview());
    }
    const marketAIBtn = document.getElementById('marketAIBtn');
    if (marketAIBtn) {
      // 20261024l：点击=确保有解读（同一交易日复用缓存，缺失才调 LLM）；Alt+点击=强制重新解读
      marketAIBtn.addEventListener('click', (e) => this.loadMarketAI(e.altKey ? true : 'ensure'));
    }
    const indexPeTrendRefresh = document.getElementById('indexPeTrendRefresh');
    if (indexPeTrendRefresh) {
      indexPeTrendRefresh.addEventListener('click', () => this.loadIndexPeTrend());
    }
    const marketTechnicalRefresh = document.getElementById('marketTechnicalRefresh');
    if (marketTechnicalRefresh) {
      marketTechnicalRefresh.addEventListener('click', () => {
        this.loadMarketTechnical(true);
      });
    }
    // 首页可见时每 60 秒自动刷新行情；离开首页则暂停
    setInterval(() => {
      // 顶栏大盘行情常驻，任何页面每 60 秒刷新一次
      this.loadTopbarIndices();
      const empty = document.getElementById('emptyState');
      if (empty && !empty.classList.contains('hidden')) {
        this.loadMarketOverview();
        this.loadIndexPeTrend();
        this.loadMarketTechnical();
        this.loadSentimentTurningPoint();
        this.loadSectorCrowding();
      }
    }, 60000);
  },

  bindEvents() {
    // Search
    const input = document.getElementById('searchInput');
    const btn = document.getElementById('searchBtn');

    btn.addEventListener('click', () => this.handleSearch());
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        this.navigateSearch(e.key === 'ArrowDown' ? 1 : -1, e);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // 下拉有高亮项则直达该项，否则常规搜索
        const active = this.getSearchActiveItem();
        if (active) this.chooseSearchResult(active);
        else this.handleSearch();
      } else if (e.key === 'Escape') {
        document.getElementById('searchResults').classList.remove('show');
        this.searchCursor = -1;
      }
    });
    input.addEventListener('input', () => {
      clearTimeout(this.searchDebounce);
      this.searchCursor = -1;
      this.searchDebounce = setTimeout(() => this.searchSuggest(input.value), 200);
    });

    // Click outside to close search results
    document.addEventListener('click', e => {
      if (!e.target.closest('.search-section')) {
        document.getElementById('searchResults').classList.remove('show');
      }
    });

    // 20261106f：「20日涨跌日量能比」数值解读下拉面板。document 级委托同时覆盖
    // ① 量能分析卡五联行（本文件 renderVolumeEngine）② 资金概要兼容渲染路径（capitalCharts.js）；
    // 静默轮询 innerHTML 全量重建后无需重新绑定。面板是卡片行的下一个兄弟、普通流跨整行，
    // 展开不撑破 ve-cols-5 五列等宽，也不被 .main-content 滚动容器裁剪。
    document.addEventListener('click', e => {
      const trigger = e.target && e.target.closest ? e.target.closest('.cm-interpret-trigger') : null;
      if (!trigger) return;
      const row = trigger.closest('.ve-tile-row, .cap-metrics-row');
      const panel = row && row.nextElementSibling;
      if (!panel || !panel.classList.contains('cm-interpret-panel')) return;
      const opening = panel.hasAttribute('hidden');
      if (opening) panel.removeAttribute('hidden');
      else panel.setAttribute('hidden', '');
      trigger.classList.toggle('is-open', opening);
      trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
    });

    // Quick links
    document.querySelectorAll('.quick-link').forEach(el => {
      el.addEventListener('click', () => {
        this.analyze(el.dataset.stock, el.dataset.name);
      });
    });

    // Clear history
    document.getElementById('clearHistory').addEventListener('click', () => {
      Storage.clearHistory();
      this.renderHistory();
      this.toast('搜索历史已清除');
    });

    // Tabs
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => this.switchTab(tab.dataset.tab));
    });
    // 20261025l：个股记录 tab 初始化（日期默认今天、添加/删除事件绑定）
    if (typeof StockLog !== 'undefined') StockLog.init();

    // Range buttons
    document.querySelectorAll('.range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentRange = btn.dataset.range;
        // 换时间范围语义是"必须重取历史"，绕开同股在飞去重（20261022i）
        if (this.currentSymbol) this.analyze(this.currentSymbol, this.currentData?.name, 0, { force: true });
      });
    });

    // Stock actions
    document.getElementById('addToWatchlist').addEventListener('click', () => this.toggleWatchlist());
    document.getElementById('backHomeBtn').addEventListener('click', () => this.backHome());
    // 评分计算追溯（issue7）
    document.getElementById('techScoreCard').addEventListener('click', () => this.toggleScoreTrace('tech'));
    document.getElementById('fundScoreCard').addEventListener('click', () => this.toggleScoreTrace('fund'));
    document.getElementById('capitalScoreCard').addEventListener('click', () => this.toggleScoreTrace('capital'));
    document.getElementById('deepRefreshBtn').addEventListener('click', () => this.loadDeepAnalysis(true));
    document.getElementById('exportHTML').addEventListener('click', () => this.exportHTML());
    document.getElementById('exportJSON').addEventListener('click', () => this.exportJSON());
    document.getElementById('refreshBtn').addEventListener('click', () => {
      // 手动刷新语义是"强制重取"，必须绕开同股在飞去重（20261022i）
      if (this.currentSymbol) this.analyze(this.currentSymbol, this.currentData?.name, 0, { force: true });
    });
    const companyDeepAiBtn = document.getElementById('companyDeepAiBtn');
    if (companyDeepAiBtn) companyDeepAiBtn.addEventListener('click', () => this.loadCompanyDeep(true));
    let companyDeepRefresh = document.getElementById('companyDeepRefresh');
    // 20260914h：单按钮口径——「✨ AI 联网获取」/「🔄 重新搜索」由主按钮自适应，
    // 原独立「🔄 重新搜索」按钮不再显示（功能与主按钮重复），仅保留兜底绑定以防旧缓存 HTML
    if (companyDeepRefresh) companyDeepRefresh.style.display = 'none';
    const industryOverviewAiBtn = document.getElementById('industryOverviewAiBtn');
    if (industryOverviewAiBtn) industryOverviewAiBtn.addEventListener('click', () => this.loadIndustryBoardIndex(true));
    const industryOverviewRefresh = document.getElementById('industryOverviewRefresh');
    if (industryOverviewRefresh) industryOverviewRefresh.addEventListener('click', () => this.loadIndustryBoardIndex(true));
    const valuationAiBtn = document.getElementById('valuationAiBtn');
    // 20260905m：单按钮口径——打开自动读保存的结果（loadValuationAICache），点「✨ AI 估值」= 重新估值并保存；
    // 原「🔄 重新估值」按钮已删除（与主按钮功能重复）
    if (valuationAiBtn) valuationAiBtn.addEventListener('click', () => this.runValuationAI(true));
    document.getElementById('aiSettingsBtn').addEventListener('click', () => this.openAISettings());
    document.getElementById('aiSettingsClose').addEventListener('click', () => this.closeAISettings());
    document.getElementById('aiSettingsCancel').addEventListener('click', () => this.closeAISettings());
    document.getElementById('aiSettingsSave').addEventListener('click', () => this.saveAISettings());
    // 20260903n：切换联网搜索方式时，按需显示对应厂商的 Key 输入框
    const aiSearchModeSel = document.getElementById('aiSearchMode');
    if (aiSearchModeSel) aiSearchModeSel.addEventListener('change', () => this.syncSearchModeFields());
    document.getElementById('aiSettingsModal').addEventListener('click', (e) => {
      if (e.target === document.getElementById('aiSettingsModal')) this.closeAISettings();
    });
    // 市场情绪拐点·首页重新检测
    const homeTpRefresh = document.getElementById('homeSentimentRefresh');
    if (homeTpRefresh) homeTpRefresh.addEventListener('click', () => this.loadSentimentTurningPoint(true));

    // 个股近期热点（20260827c）：单按钮重新联网分析
    const htRefresh = document.getElementById('hotTopicRefreshBtn');
    if (htRefresh) htRefresh.addEventListener('click', () => this.refreshHotTopics());

    document.addEventListener('keydown', (e) => this.handleGlobalKeydown(e));

    // 右键菜单：事件代理 + 点击别处关闭
    const ctxMenu = document.getElementById('watchlistContextMenu');
    if (ctxMenu) {
      ctxMenu.addEventListener('click', e => {
        const item = e.target.closest('.ctx-item');
        if (!item) return;
        this.handleContextAction(item.dataset.act, item.dataset.group);
      });
      ctxMenu.addEventListener('contextmenu', e => e.preventDefault());
    }
    document.addEventListener('click', e => {
      if (!e.target.closest('#watchlistContextMenu')) this.closeContextMenu();
    });

    // 20261104f：banner 右侧「回到顶部」（用户指令：点击后回到页面顶端）。
    // 20261104g 修复「点击无反应」：html/body 为 overflow:hidden（style.css 105 行），
    // window 从不滚动——真正的内容滚动容器是 <main class="main-content">（overflow-y:auto），
    // 必须滚动该容器；window.scrollTo 仅作容器缺失时兜底。
    const bttBtn = document.getElementById('backToTopBtn');
    if (bttBtn) {
      bttBtn.addEventListener('click', () => {
        const mainEl = document.querySelector('.main-content');
        if (mainEl && typeof mainEl.scrollTo === 'function') {
          mainEl.scrollTo({ top: 0, behavior: 'smooth' });
        } else {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }
      });
    }


    // 20261104b：增长口径一键切换（用户指令：单季 ↔ 累计，切换后对应指标分析同步切换）
    // 按钮位于左卡「关键财务指标」卡头（index.html 静态节点，此处一次性绑定）。
    // 点击 → POST /api/growth-caliber（服务端持久化 data/settings.json 并清空 /api/analysis TTL 缓存）
    // → 重载当前个股分析（analyze 自带 loading 遮罩与请求令牌），左卡数值/右卡指标分析/顶栏判定/历史百分位全链路同口径切换。
    const gcBtn = document.getElementById('growthCaliberBtn');
    if (gcBtn) {
      gcBtn.addEventListener('click', async () => {
        if (gcBtn.disabled) return;
        const cur = (this.currentData && this.currentData.metricAnalysis && this.currentData.metricAnalysis.growthCaliber) || 'sq';
        const next = cur === 'sq' ? 'cum' : 'sq';
        const oldText = gcBtn.textContent;
        gcBtn.disabled = true;
        gcBtn.textContent = '切换中…';
        try {
          const resp = await fetch('/api/growth-caliber', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ caliber: next })
          });
          const r = await resp.json();
          if (!r.ok) throw new Error(r.error || '服务端拒绝');
          const cs = window.currentStock || {};
          if (cs.code) {
            await this.analyze(cs.code, cs.name || ''); // 重载后 renderDashboard 会按新口径同步按钮文案
          } else {
            this.setGrowthCaliberBtn(r.caliber);
          }
        } catch (err) {
          console.error('[GrowthCaliber] 切换失败:', err);
          gcBtn.textContent = oldText;
          this.showErrorBanner('增长口径切换失败：' + err.message, null);
        } finally {
          gcBtn.disabled = false;
        }
      });
    }

    // 快捷键提示
    const kbBtn = document.getElementById('keyboardHelpBtn');
    if (kbBtn) kbBtn.addEventListener('click', () => this.toggleKeyboardHelp());
    const kbClose = document.getElementById('keyboardHelpClose');
    if (kbClose) kbClose.addEventListener('click', () => this.toggleKeyboardHelp(false));

    // 确认弹窗
    const cfCancel = document.getElementById('confirmCancel');
    if (cfCancel) cfCancel.addEventListener('click', () => this.closeConfirm());
    const cfClose = document.getElementById('confirmClose');
    if (cfClose) cfClose.addEventListener('click', () => this.closeConfirm());
    const cfOk = document.getElementById('confirmOk');
    if (cfOk) cfOk.addEventListener('click', () => this.confirmOk());
    const confirmDialog = document.getElementById('confirmDialog');
    if (confirmDialog) {
      confirmDialog.addEventListener('click', e => { if (e.target === confirmDialog) this.closeConfirm(); });
    }

    // 错误占位横幅重试
    const errRetry = document.getElementById('errorBannerRetry');
    if (errRetry) errRetry.addEventListener('click', () => this.retryBanner());
    const errClose = document.getElementById('errorBannerClose');
    if (errClose) errClose.addEventListener('click', () => this.hideErrorBanner());

    // 顶栏：大盘行情折叠/展开
    const topbarCollapse = document.getElementById('topbarCollapse');
    if (topbarCollapse) {
      topbarCollapse.addEventListener('click', () => {
        const bar = document.getElementById('marketTopbar');
        bar.classList.toggle('collapsed');
        topbarCollapse.textContent = bar.classList.contains('collapsed') ? '▸' : '▾';
      });
    }
    // 中栏图表：周期切换（日K/周K/月K/60分钟）
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', () => this.switchPeriod(btn.dataset.period));
    });

    // Resize charts
    window.addEventListener('resize', () => {
      Object.values(Charts.instances).forEach(c => { try { c.resize(); } catch {} });
    });
  },

  // ---- Search ----
  async handleSearch() {
    const input = document.getElementById('searchInput');
    const q = input.value.trim();
    if (!q) return;
    document.getElementById('searchResults').classList.remove('show');

    // If input looks like a stock code (digits, letters, dots, with optional suffix), analyze directly
    if (/^[0-9A-Za-z.]+$/.test(q)) {
      this.analyze(q);
      return;
    }

    // Chinese name or mixed input — search first, then analyze the best match
    try {
      this.showLoading('正在搜索股票...');
      const resp = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      const results = await resp.json();
      this.hideLoading();
      if (results && results.length > 0) {
        const first = results[0];
        this.analyze(first.symbol || first.code, first.name);
      } else {
        this.toast('未找到匹配的股票，请尝试输入股票代码', 'error');
      }
    } catch (e) {
      this.hideLoading();
      this.toast('搜索失败: ' + e.message, 'error');
    }
  },

  // For DocStore company card click
  searchAndSelect(code) {
    const input = document.getElementById('searchInput');
    if (input) input.value = code;
    this.analyze(code);
  },

  async searchSuggest(query) {
    if (!query || query.length < 1) {
      document.getElementById('searchResults').classList.remove('show');
      return;
    }

    try {
      const resp = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
      const results = await resp.json();
      this.renderSearchResults(results);
    } catch (e) {
      console.error('Search suggest failed:', e);
    }
  },

  renderSearchResults(results) {
    const container = document.getElementById('searchResults');
    if (!results || results.length === 0) {
      container.innerHTML = '<div class="search-empty">未找到匹配，请输入代码 / 名称 / 拼音首字母</div>';
      container.classList.add('show');
      this.searchCursor = -1;
      return;
    }

    container.innerHTML = results.slice(0, 10).map(r => `
      <div class="search-result-item" data-symbol="${this.escapeHtml(r.symbol || r.code)}" data-name="${this.escapeHtml(r.name)}">
        <div>
          <div class="name">${this.escapeHtml(r.name)}</div>
          <div class="code">${this.escapeHtml(r.code || r.symbol)}</div>
        </div>
        <span class="market-tag">${this.escapeHtml(r.market || '')}</span>
      </div>
    `).join('');

    container.classList.add('show');
    this.searchCursor = -1;

    container.querySelectorAll('.search-result-item').forEach((el, i) => {
      el.addEventListener('mousemove', () => {
        if (this.searchCursor !== i) {
          this.searchCursor = i;
          container.querySelectorAll('.search-result-item').forEach((it, j) => it.classList.toggle('active', j === i));
        }
      });
      el.addEventListener('click', () => this.chooseSearchResult(el));
    });
  },

  // 高亮搜索下拉项
  getSearchActiveItem() {
    const items = document.querySelectorAll('#searchResults .search-result-item');
    if (!items.length || this.searchCursor < 0) return null;
    return items[Math.min(this.searchCursor, items.length - 1)];
  },

  navigateSearch(dir, e) {
    const items = document.querySelectorAll('#searchResults .search-result-item');
    if (!items.length) return;
    e && e.preventDefault();
    if (this.searchCursor < 0) this.searchCursor = dir > 0 ? 0 : items.length - 1;
    else this.searchCursor = (this.searchCursor + dir + items.length) % items.length;
    items.forEach((it, i) => it.classList.toggle('active', i === this.searchCursor));
    const cur = items[this.searchCursor];
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  },

  chooseSearchResult(el) {
    const input = document.getElementById('searchInput');
    document.getElementById('searchResults').classList.remove('show');
    if (input) input.value = '';
    this.searchCursor = -1;
    this.analyze(el.dataset.symbol, el.dataset.name);
  },

  // ---- 全局快捷键 ----
  handleGlobalKeydown(e) {
    const t = e.target;
    const tag = (t && t.tagName) || '';
    const isTyping = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);

    // Esc：关闭所有弹层（右键菜单/快捷键提示/下拉/设置弹窗/确认框）
    if (e.key === 'Escape') {
      if (this.closeAllPopups()) e.preventDefault();
      return;
    }
    // `/` 聚焦搜索
    if (e.key === '/' && !isTyping) { e.preventDefault(); this.focusSearch(); return; }
    // 数字键切换周期：0分时 1日K 2周K 3月K 4=60分钟（20261017h 新增 0=分时）
    if (!isTyping && /^[0-4]$/.test(e.key)) {
      const periods = ['minute', 'daily', 'weekly', 'monthly', '60m'];
      const p = periods[parseInt(e.key, 10)];
      if (p && this.currentSymbol) { e.preventDefault(); this.switchPeriod(p); }
      return;
    }
    // 输入框内由 input 自身处理；此处不重复
    if (isTyping) return;
    // ↑/↓ 切换自选、Enter 查看
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      this.navigateWatchlist(e.key === 'ArrowDown' ? 1 : -1);
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') { this.openWatchlistSelection(); e.preventDefault(); }
  },

  navigateWatchlist(dir) {
    const list = this.getDisplayWatchlist();
    if (!list.length) return;
    if (this.watchlistNavIndex < 0) this.watchlistNavIndex = dir > 0 ? 0 : list.length - 1;
    else this.watchlistNavIndex = (this.watchlistNavIndex + dir + list.length) % list.length;
    this.updateWatchlistNavHighlight();
    const item = list[this.watchlistNavIndex];
    const row = item && document.querySelector(`.wl-row[data-symbol="${this.escapeAttr(item.symbol)}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  },

  openWatchlistSelection() {
    const list = this.getDisplayWatchlist();
    if (!list.length) return;
    let item = (this.watchlistNavIndex >= 0 && list[this.watchlistNavIndex]) || list.find(s => s.symbol === this.currentSymbol) || list[0];
    if (item) this.analyze(item.symbol, item.name);
  },

  focusSearch() {
    const input = document.getElementById('searchInput');
    if (input) { input.focus(); input.select(); }
  },

  closeAllPopups() {
    let closed = false;
    const sr = document.getElementById('searchResults');
    if (sr && sr.classList.contains('show')) { sr.classList.remove('show'); this.searchCursor = -1; closed = true; }
    this.closeContextMenu();
    const hint = document.getElementById('keyboardHelp');
    if (hint && !hint.classList.contains('hidden')) { hint.classList.add('hidden'); closed = true; }
    const m = document.getElementById('aiSettingsModal');
    if (m && !m.classList.contains('hidden')) { this.closeAISettings(); closed = true; }
    const cf = document.getElementById('confirmDialog');
    if (cf && !cf.classList.contains('hidden')) { this.closeConfirm(); closed = true; }
    return closed;
  },

  escapeAttr(s) {
    return String(s).replace(/[^\w\u4e00-\u9fa5.-]/g, '');
  },

  // ---- Analyze ----
  // 同步当前股票代码到 URL（?symbol=xxx），刷新后可回到当前个股；
  // 首页/返回时传 null 删除 symbol 参数。始终保留 ?v= 等其它参数。
  updateUrlSymbol(symbol) {
    try {
      const url = new URL(location.href);
      if (symbol) url.searchParams.set('symbol', symbol);
      else url.searchParams.delete('symbol');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
    } catch (e) {}
  },

  async analyze(symbol, name = '', _retry = 0, opts = null) {
    // 20261022i：同一只股票的请求"在飞去重"。
    // 症状：切股时（冷缓存 2~4 秒）用户以为没点上而连点多次，旧逻辑每次点击都 _reqToken++
    // 并重新 fetch，前一次结果被 token 校验丢弃 → 连点等于不断重置读条，越点越切不过去。
    // 规则：若该股票已有仍在飞的请求、且它就是当前最新请求（token === _reqToken），直接忽略本次点击。
    // force=true（刷新按钮 / 快捷键强刷）时跳过去重，语义不变。
    const force = !!(opts && opts.force);
    this._inflightTokens = this._inflightTokens || {};
    if (!force && this._inflightTokens[symbol] && this._inflightTokens[symbol] === this._reqToken) return;
    // 请求令牌：每次调用自增；后续若用户切换到别的股票/再触发分析，
    // 旧请求的返回值会被丢弃，避免"慢的旧请求覆盖快的新请求"或闪烁。
    const token = (this._reqToken = (this._reqToken || 0) + 1);
    this._inflightTokens[symbol] = token;
    this.currentSymbol = symbol;
    // 立刻高亮目标行：给"点击已生效"的第一时间反馈（此前要等 fetch 回来才在 renderDashboard 里高亮）
    this.updateWatchlistSelection();
    this.updateUrlSymbol(symbol);
    this.deepDataLoaded = false;
    this.deepData = null;
    this.capitalDataLoaded = false;
    this.capitalData = null;
    // 切换新股：重置各 tab 的"已加载股票"标记，避免沿用旧股票数据 / 误判已完成
    this.deepLoadedSymbol = null;
    this.capitalLoadedSymbol = null;
    this.shareholderLoadedSymbol = null;
    this.paLoadedSymbol = null;
    this.paData = null;
    // 切换新股：复位不会随 analyze 自动重渲染的面板，避免残留上一只股票的数据
    this.resetTransientPanels();
    // Update current stock info for journal
    window.currentStock = { code: symbol, name: name };
    // 20260917j：切股后立即用新个股重渲染「个股亮点/雷点」（数据取自 Notes 本地镜像）。
    // 修复用户反馈「亮点/雷点不随个股页面切换」：此前只在该 tab 为 journal 时才重渲染，
    // 且 AI 生成的异步回调会用旧 symbol 重画，导致容器长期停留在上一只股票。
    // 此处是「当前个股」唯一变更点，在此重渲染可确保内容始终跟随当前个股。
    if (typeof Notes !== 'undefined' && document.getElementById('stockNotesContainer')) {
      Notes.renderStock(symbol, name);
    }
    // 20261025l：切股后重置「个股记录」tab（下一切换/渲染时按新 symbol 拉取）
    if (typeof StockLog !== 'undefined') StockLog.setStock(symbol, name);
    // Update DocStore stock info
    DocStore.setStock(symbol, name);
    DeepCharts.disposeAll();
    this.showLoading(`正在加载 ${name || symbol}…`);

    try {
      const range = this.currentRange;
      const resp = await fetch(`/api/analysis/${encodeURIComponent(symbol)}?range=${range}&name=${encodeURIComponent(name)}`);
      const data = await resp.json();

      if (token !== this._reqToken) return; // 已有更新的请求，丢弃本次过期结果

      if (data.error) {
        this.hideLoading();
        this.showErrorBanner(data.error, () => this.analyze(symbol, name));
        return;
      }

      this.currentData = data;
      this.renderDashboard(data);

      // Add to history
      Storage.addToHistory({ symbol: data.symbol, name: data.name, market: data.market });
      this.renderHistory();

      this.hideLoading();

      // 若切换股票时正停留在"按当前股票懒加载"的 Tab，立即重载之，避免残留上一只股票的内容
      const activeTabEl = document.querySelector('.tab.active');
      const activeTab = activeTabEl ? activeTabEl.dataset.tab : 'overview';
      if (activeTab === 'deep') {
        // 注意：不要清空 #deepContent —— 章节骨架是 index.html 内的静态 HTML，
        // 清空会导致 renderAll 找不到章节元素而整页空白（切换股票时的白屏根因）。
        // 加载遮罩 + 透明度已覆盖过渡，骨架保留即可。
        this.loadDeepAnalysis();
      } else if (activeTab === 'capital') {
        this.loadCapitalFlow();
      } else if (activeTab === 'shareholders') {
        this.loadShareholders();
      } else if (activeTab === 'backtest') {
        // 修复「策略页不随个股切换」：切股时若正停留在策略 Tab，立即按新股重算
        if (typeof BacktestUI !== 'undefined') BacktestUI.open(this.currentSymbol, this.currentData?.name);
      } else if (activeTab === 'journal') {
        if (typeof Notes !== 'undefined') Notes.renderStock(this.currentSymbol, this.currentData?.name);
      } else if (activeTab === 'docs') {
        if (typeof DocStore !== 'undefined') DocStore.onTabSwitch();
      }
    } catch (e) {
      if (token !== this._reqToken) return; // 过期请求，不弹错误、不干扰新请求
      // 20260909o：网络层瞬断（服务重启窗口/瞬时断连）自动重试 2 次——服务恢复即自愈，用户无感；穷尽才弹错误条
      const msg = String((e && e.message) || e);
      if (_retry < 2 && /Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        this.showLoading(`连接中断，正在自动重连（${_retry + 1}/2）…`);
        await new Promise(r => setTimeout(r, 2500));
        if (token !== this._reqToken) return; // 重连期间用户已切换其他股票
        // 递归重试前必须清掉在飞标记，否则重试自己会被"在飞去重"拦下（20261022i）
        delete this._inflightTokens[symbol];
        return this.analyze(symbol, name, _retry + 1);
      }
      this.hideLoading();
      this.showErrorBanner('获取数据失败: ' + e.message, () => this.analyze(symbol, name, 0, { force: true }));
      console.error(e);
    } finally {
      // 无论成功/失败/被 token 丢弃，都要清掉本股的在飞标记（只清自己那一笔，避免误删后来的请求）
      if (this._inflightTokens && this._inflightTokens[symbol] === token) delete this._inflightTokens[symbol];
    }
  },

  // ---- Dashboard rendering ----
  renderDashboard(data) {
    document.getElementById('emptyState').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    this.hideErrorBanner();

    // 个股页顶部导航显示操作按钮（首页/自选/导出/刷新/AI补全）
    const navExtra = document.getElementById('globalNavExtra');
    if (navExtra) navExtra.classList.remove('hidden');

    this.renderStockHeader(data);
    // 20261104b：增长口径按钮文案随服务端设置同步（单一数据源 metricAnalysis.growthCaliber）
    this.setGrowthCaliberBtn(data.metricAnalysis && data.metricAnalysis.growthCaliber);
    this.renderKeyMetrics(data);
    this.renderScores(data);
    this.renderOverview(data);
    this.renderTechnical(data);
    this.renderFundamental(data);

    // 缓存中栏图表所需的日K历史 + 技术指标（周期切换 / 指标 Tab 切换复用）
    this.dailyHistory = data.history || [];
    this.dailyTechnical = data.technical || null;
    // 切换股票后清空 60分钟缓存，避免串股
    this.history60m = [];
    this.technical60m = null;
    // 20261017h：切换股票后清空分时缓存，避免串股（renderMinute 另有 symbol 校验兜底）
    this.minuteData = null;
    // 中栏指标图初始化（周期默认日K / 指标默认 MACD）
    this.renderDashboardCharts(data);
    // 左栏选中行高亮
    this.updateWatchlistSelection();

    // Update watchlist button
    this.updateWatchlistButton();

    // 异步预加载资金量能数据，用于计算资金热度评分（不阻塞页面渲染）
    if (this.currentSymbol && this.capitalLoadedSymbol !== this.currentSymbol) {
      setTimeout(() => this.loadCapitalFlow(), 50);
    } else if (this.capitalData) {
      this.renderCapitalScore(this.capitalData);
    }

    // 自动加载已存的 AI 联网补全缓存（一次搜索、长期留存，无需每次手动点击/联网）
    if (this.currentSymbol) {
      setTimeout(() => this.loadAICache(), 60);
    }
    // 20260906：切股即重置估值面板（清旧股 AI 视图残留、回规则版占位；新股已存估值由下方 loadValuationAICache 自动接管）
    const _vaiBodyReset = document.getElementById('valuationAiBody');
    if (_vaiBodyReset) { _vaiBodyReset.style.display = 'none'; _vaiBodyReset.innerHTML = ''; }
    const _vDeepConcReset = document.getElementById('deepConclusion');
    if (_vDeepConcReset) _vDeepConcReset.style.display = '';
    const _vaiDateReset = document.getElementById('valuationAiDate');
    if (_vaiDateReset) _vaiDateReset.textContent = '';
    // 自动加载已存的 AI 估值大模型缓存（打开个股页即显示，无需手动点击）
    if (this.currentSymbol) {
      setTimeout(() => this.loadValuationAICache(), 60);
    }

    // 概览补充卡片：行业前景 / 股东户数变化 / 最大亮点雷点（异步加载，不随切换页面中断）
    if (this.currentSymbol) {
      setTimeout(() => this.loadOverviewExtras(data), 70);
    }

    // 20260914h：切换个股后同样静默预热本地事实库 + 秒显已存信息分析（会话内每股一次）
    if (this.currentSymbol) {
      setTimeout(() => {
        try { this._prefetchCompanyFacts(); } catch (e) { console.error('Auto prefetchCompanyFacts failed:', e); }
      }, 80);
    }

    // 全局自动加载：打开个股页后，后台并发拉取所有 tab 数据，无需用户切换到对应页面才触发
    if (this.currentSymbol) {
      setTimeout(() => {
        try { this.loadDeepAnalysis(); } catch (e) { console.error('Auto loadDeepAnalysis failed:', e); }
      }, 100);
      setTimeout(() => {
        try { this.loadPriceAction(); } catch (e) { console.error('Auto loadPriceAction failed:', e); }
      }, 150);
      setTimeout(() => {
        try { this.loadCapitalFlow(); } catch (e) { console.error('Auto loadCapitalFlow failed:', e); }
      }, 200);
      setTimeout(() => {
        try { this.loadIndustryAnalysis(); } catch (e) { console.error('Auto loadIndustryAnalysis failed:', e); }
      }, 300);
      setTimeout(() => {
        try { this.loadShareholders(); } catch (e) { console.error('Auto loadShareholders failed:', e); }
      }, 400);
    }
  },

  // ---- 概览补充卡片：行业前景评分 / 股东户数变化 / 最大亮点雷点 ----
  // 这三个请求都只按元素 id 填充固定卡片，与当前激活的 tab 无关，
  // 因此切换页面/标签不会中断；返回时若已切换股票则丢弃结果，避免串数据。
  loadOverviewExtras(mainData) {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    this.overviewExtraSymbol = symbol;
    const name = this.currentData?.name || mainData?.quote?.name || '';
    const industry = mainData?.quote?.industry || '';

    // 复位为加载态
    const setLoad = (vId, dId, dText) => {
      const v = document.getElementById(vId);
      const d = document.getElementById(dId);
      if (v) { v.textContent = '加载中…'; v.className = 'score-value' + (vId === 'aspectValue' ? ' aspect' : '') + ' neutral'; }
      if (d) d.textContent = dText || '';
    };
    setLoad('industryScore', 'industryScoreDetail', '行业政策库分析中…');
    this._setSameDayLoading();
    this._setLongTermLoading();
    setLoad('aspectValue', 'aspectDetail', 'AI 亮点/雷点读取中…');

    this._loadIndustryProspect(symbol, name, industry);
    this._loadSameDayJudgment(symbol, name, industry);
    this._loadLongTermJudgment(symbol, name, industry);
    this._loadAspectBrief(symbol, name, industry);
    this.loadHotTopics(symbol, name);
  },

  async _loadIndustryProspect(symbol, name, industry) {
    const v = document.getElementById('industryScore');
    const d = document.getElementById('industryScoreDetail');
    if (!v || !d) return;
    try {
      const resp = await fetch(`/api/industry-analysis/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name || '')}`);
      const data = await resp.json();
      if (this.overviewExtraSymbol !== symbol) return; // 已切换股票，丢弃
      const pol = data && data.policy;
      const indName = (data && data.industry && data.industry.name) || industry || '—';
      if (!pol) { v.textContent = '—'; v.className = 'score-value neutral'; d.textContent = `${indName} · 无政策数据`; return; }
      const { rating, cls } = this._industryLevelToRating(pol.level);
      v.textContent = rating;
      v.className = 'score-value ' + cls;
      d.textContent = `${indName} · 来源：行业政策库`;
      v.title = `${pol.level}：${pol.summary || ''}`;
    } catch (e) {
      if (this.overviewExtraSymbol !== symbol) return;
      v.textContent = '—'; v.className = 'score-value neutral';
      d.textContent = '行业前景加载失败';
    }
  },

  _industryLevelToRating(level) {
    if (!level) return { rating: '一般', cls: 'average' };
    if (level.includes('国家战略扶持')) return { rating: '优秀', cls: 'excellent' };
    if (level.includes('战略扶持')) return { rating: '良好', cls: 'good' };
    if (level.includes('受限')) return { rating: '较弱', cls: 'weak' };
    if (level.includes('中性')) return { rating: '一般', cls: 'average' };
    return { rating: '一般', cls: 'average' };
  },

  _setSameDayLoading() {
    const v = document.getElementById('samedayVerdict');
    const d = document.getElementById('samedayDetail');
    const acc = document.getElementById('samedayAccuracy');
    const btn = document.getElementById('samedayLogicBtn');
    const logic = document.getElementById('samedayLogic');
    const conf = document.getElementById('samedayConfidence');
    const title = document.getElementById('samedayTitle');
    const target = document.getElementById('samedayTarget');
    if (v) { v.textContent = '判断中…'; v.className = 'score-value sameday-verdict neutral'; }
    if (d) d.textContent = '正在汇聚技术面/行业/期货/资金/消息面/大盘六类信号…';
    if (acc) acc.textContent = '';
    if (conf) { conf.textContent = ''; conf.className = 'sameday-badge'; }
    if (title) title.textContent = '短期行情';
    if (target) target.textContent = '';
    if (btn) btn.style.display = 'none';
    if (logic) { logic.style.display = 'none'; logic.innerHTML = ''; }
    this._samedayShownSymbol = this.overviewExtraSymbol;
  },

  async _loadSameDayJudgment(symbol, name, industry) {
    const v = document.getElementById('samedayVerdict');
    const d = document.getElementById('samedayDetail');
    if (!v || !d) return;
    try {
      const resp = await fetch(`/api/sameday-judgment/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name || '')}&industry=${encodeURIComponent(industry || '')}`);
      const data = await resp.json();
      if (this.overviewExtraSymbol !== symbol) return; // 已切换股票，丢弃
      if (!data || data.success === false) {
        v.textContent = '—'; v.className = 'score-value sameday-verdict neutral';
        d.textContent = (data && data.error) ? ('判断失败：' + data.error) : '判断加载失败';
        return;
      }
      // 防御性校验：如果后端返回了错误股票的判断（跨股污染/缓存串号），自动强制刷新一次
      if (data.judgment && data.judgment.symbol && data.judgment.symbol !== symbol) {
        console.warn(`[SameDay] symbol mismatch: requested=${symbol} received=${data.judgment.symbol}, forcing refresh`);
        try {
          const r2 = await fetch(`/api/sameday-judgment/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name || '')}&industry=${encodeURIComponent(industry || '')}&refresh=1`);
          const d2 = await r2.json();
          if (this.overviewExtraSymbol !== symbol) return;
          if (d2 && d2.success !== false && d2.judgment && d2.judgment.symbol === symbol) {
            this.renderSameDayJudgment(d2, symbol);
            return;
          }
        } catch (e) {}
        v.textContent = '—'; v.className = 'score-value sameday-verdict neutral';
        d.textContent = '判断数据与当前股票不一致，请重新选择股票或刷新';
        return;
      }
      this.renderSameDayJudgment(data, symbol);
    } catch (e) {
      if (this.overviewExtraSymbol !== symbol) return;
      v.textContent = '—'; v.className = 'score-value sameday-verdict neutral';
      d.textContent = '判断加载失败';
    }
  },

  renderSameDayJudgment(data, symbol) {
    const j = data.judgment;
    const acc = data.accuracy;
    const v = document.getElementById('samedayVerdict');
    const d = document.getElementById('samedayDetail');
    const conf = document.getElementById('samedayConfidence');
    const btn = document.getElementById('samedayLogicBtn');
    const logic = document.getElementById('samedayLogic');
    const accEl = document.getElementById('samedayAccuracy');
    const titleEl = document.getElementById('samedayTitle');
    const targetEl = document.getElementById('samedayTarget');
    if (!v || !j) return;

    // 动态标题：预判的目标交易日 + 行情判断（统一为收盘后下一交易日预判）
    const targetLabel = '下一交易日走势';
    const fmtMD = (s) => { const p = String(s || '').split('-'); return (p.length >= 3) ? `${+p[1]}月${+p[2]}日` : ''; };
    const titleDate = j.targetDate || j.date; // 优先用预判目标交易日，兼容旧记录
    if (titleEl && titleDate) {
      titleEl.textContent = `${fmtMD(titleDate)}短期行情`;
    }
    if (targetEl) {
      let t = `收盘后预判 · 目标：${targetLabel}${titleDate ? `（${fmtMD(titleDate)}）` : ''}`;
      if (j.generatedAt) {
        const dt = new Date(j.generatedAt);
        if (!isNaN(dt)) {
          const hh = String(dt.getHours()).padStart(2, '0');
          const mm = String(dt.getMinutes()).padStart(2, '0');
          t += ` · 判断时间 ${hh}:${mm}`;
        }
      }
      targetEl.textContent = t;
    }

    const cls = j.dir === '涨' ? 'strong-bullish' : j.dir === '跌' ? 'strong-bearish' : 'neutral';
    v.textContent = j.verdict;
    v.className = 'score-value sameday-verdict ' + cls;
    v.title = `综合分 ${j.score} / 100 · 置信度${j.confidence} · 预测${targetLabel}：${j.dir}`;
    d.textContent = `收盘后预判下一交易日 · 综合分 ${j.score > 0 ? '+' : ''}${j.score}/100 · 置信度${j.confidence}${j.industry ? ' · ' + j.industry : ''}`;
    if (conf) {
      const confCls = j.confidence === '高' ? 'conf-high' : j.confidence === '中' ? 'conf-mid' : 'conf-low';
      conf.className = 'sameday-badge ' + confCls;
      conf.textContent = j.confidence + '置信';
    }
    if (btn) btn.style.display = '';
    if (logic) { logic.style.display = 'none'; logic.innerHTML = ''; }
    if (accEl) {
      accEl.className = 'sameday-accuracy' + (acc && acc.overdueCount ? ' sameday-acc-warn' : '');
      if (!acc || !acc.settledCount) {
        accEl.textContent = '该股准确率：样本不足（达到结算条件后自动核算）';
      } else {
        const parts = [];
        if (acc.bullRate != null) parts.push(`看涨 ${acc.bullRate}%`);
        if (acc.bearRate != null) parts.push(`看跌 ${acc.bearRate}%`);
        let byTgt = '';
        if (acc.nextdayRate != null) {
          byTgt = `（次日 ${acc.nextdayRate}%）`;
        }
        let tail = '';
        if (acc.pendingCount) tail += ` · 待结算 ${acc.pendingCount} 条`;
        if (acc.overdueCount) tail += ` ⚠️${acc.overdueCount} 条过期未结算`;
        accEl.textContent = `该股预测 ${acc.settledCount} 次，命中 ${acc.correct} 次，准确率 ${acc.accuracy != null ? acc.accuracy + '%' : '—'}` + (parts.length ? `（${parts.join(' / ')}）` : '') + byTgt + tail;
      }
    }
    // 20260821f：财报事件 → 资料库同步状态提示（一致性：判断引擎捕捉到的中报/年报发布，
    // 资料库是否已同步，在此直观呈现；缺口时自动触发后端下载）
    const syncEl = document.getElementById('samedayReportSync');
    if (syncEl) {
      const evt = j.reportEvent;
      if (evt) {
        const label = evt.type === 'semi' ? '半年报' : evt.type === 'annual' ? '年报' : '季报';
        const dateTxt = evt.date ? `（${String(evt.date).slice(0, 10)}）` : '';
        syncEl.className = 'sameday-report-sync' + (j.reportGap ? ' sync-gap' : ' sync-ok');
        syncEl.innerHTML = j.reportGap
          ? `📥 检测到 ${evt.year}${label}发布${dateTxt}，资料库缺此报告，正在自动同步…`
          : `✅ ${evt.year}${label}已同步至资料库${dateTxt}`;
        syncEl.style.display = '';
      } else {
        syncEl.style.display = 'none';
        syncEl.innerHTML = '';
      }
    }
    // 链接指向「该股」判断记录（而非全部）
    const allLink = document.getElementById('samedayAllLink');
    if (allLink) {
      const nm = (this.currentData && this.currentData.name) ? this.currentData.name : '';
      allLink.href = 'judgments.html?symbol=' + encodeURIComponent(symbol) + (nm ? '&name=' + encodeURIComponent(nm) : '');
    }
    if (btn) {
      // 用 cloneNode 彻底清除旧点击监听器，避免切换股票后点击逻辑框仍显示上一只股票数据
      const freshBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(freshBtn, btn);
      freshBtn.addEventListener('click', () => this._toggleSameDayLogic(j, symbol));
    }
    this._lastSameDayJudgment = j;
    // 渲染短路：若 judgment.symbol 与当前激活 symbol 不一致，立即清空 logic 框并强制重新渲染，
    // 防止出现「切换股票后，逻辑框仍展开且仍展示旧股票 HTML」的污染窗口。
    const logicBox = document.getElementById('samedayLogic');
    if (logicBox) {
      if (j && j.symbol && j.symbol !== symbol) {
        logicBox.innerHTML = '<div class="sd-factor"><div class="sd-factor-detail">⚠️ 判断数据与当前股票不一致，正在重新拉取…</div></div>';
        logicBox.style.display = '';
      } else if (logicBox.style.display !== 'none') {
        // logic 框处于展开态：直接用最新判断重新渲染其内容
        logicBox.innerHTML = this._renderSameDayLogicHtml(j, symbol);
        this._bindSameDayLogicExtras(logicBox);
      }
    }
  },

  // ============ 市场情绪拐点（全市场级，仅首页展示）============
  async loadSentimentTurningPoint(refresh) {
    try {
      const url = '/api/sentiment-turning-point' + (refresh ? '?refresh=1' : '');
      const resp = await fetch(url);
      const data = await resp.json();
      if (!data || data.success === false) { this._tpRenderError(); return; }
      this.renderHomeTpPanel(data);
    } catch (e) {
      this._tpRenderError();
    }
  },

  _tpRenderError() {
    const homeBody = document.getElementById('homeSentimentBody');
    if (homeBody) homeBody.innerHTML = '<div class="ai-empty">情绪拐点检测失败，请稍后重试</div>';
  },

  // ============ 行业板块拥挤度 ============
  async loadSectorCrowding(refresh) {
    try {
      if (refresh) {
        const el = document.getElementById('sectorCrowding');
        if (el) el.innerHTML = '<div class="deep-loading"><div class="loading-spinner"></div><p>正在联网获取历史行业板块数据，首次约需 1-2 分钟，请稍候…</p></div>';
      }
      const url = '/api/sector-crowding' + (refresh ? '?refresh=1' : '');
      const resp = await fetch(url);
      const data = await resp.json();
      if (!data || data.success === false) { this._renderCrowdingError(); return; }
      this.renderSectorCrowding(data);
    } catch (e) {
      this._renderCrowdingError();
    }
  },

  _renderCrowdingError() {
    const el = document.getElementById('sectorCrowding');
    if (el) el.innerHTML = '<div class="ai-empty">行业拥挤度加载失败，请稍后重试</div>';
  },

  _crowdingRow(item, rank) {
    const chg = (item.changePct != null) ? item.changePct : null;
    const chgCls = chg == null ? '' : (chg >= 0 ? 'up' : 'down');
    const chgStr = chg == null ? '—' : (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
    const rankCls = rank === 0 ? 'rank-1' : rank === 1 ? 'rank-2' : rank === 2 ? 'rank-3' : '';
    return `<tr class="${rankCls}">
      <td class="crowd-rank">${rank + 1}</td>
      <td class="crowd-name">${this.escapeHtml(item.name)}</td>
      <td class="crowd-val">${item.crowding != null ? item.crowding.toFixed(2) + '%' : '—'}</td>
      <td class="crowd-amt">${item.amount != null ? item.amount.toFixed(1) : '—'}</td>
      <td class="crowd-chg ${chgCls}">${chgStr}</td>
    </tr>`;
  },

  _crowdingCol(title, list, dateStr) {
    const rows = (list && list.length)
      ? list.map((it, i) => this._crowdingRow(it, i)).join('')
      : '<tr><td colspan="5" class="crowd-empty">暂无数据</td></tr>';
    const head = `<div class="crowd-col-head">${title}${dateStr ? `<span class="crowd-col-date">${dateStr}</span>` : ''}</div>`;
    return `<div class="crowd-col">
      ${head}
      <table class="crowd-table">
        <thead><tr><th>序</th><th>行业</th><th>拥挤度</th><th>成交额(亿)</th><th>涨跌幅</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  },

  renderSectorCrowding(data) {
    const el = document.getElementById('sectorCrowding');
    if (!el) return;
    // 用户要求只保留日期，不显示“当日/本周/本月”前缀
    const todayDate = data.date || '';
    const weekRange = (data.weekDates && data.weekDates.length) ? `${data.weekDates[0]}~${data.weekDates[data.weekDates.length - 1]}` : '';
    const monthRange = (data.monthDates && data.monthDates.length) ? `${data.monthDates[0]}~${data.monthDates[data.monthDates.length - 1]}` : '';
    el.innerHTML =
      this._crowdingCol(todayDate, data.today, '') +
      this._crowdingCol(weekRange, data.week, '') +
      this._crowdingCol(monthRange, data.month, '');

    const mt = document.getElementById('crowdingMarketTotal');
    if (mt) mt.textContent = data.marketTotal != null ? `全市场成交 ${data.marketTotal.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} 亿` : '';
    const note = document.getElementById('sectorCrowdingNote');
    if (note) {
      note.innerHTML = `${data.denominatorNote || ''}${data.note ? '；' + data.note : ''}｜来源：${data.source || '同花顺'}｜口径：拥挤度 = 板块成交额 ÷ 全市场成交额 ×100%；当日=单日值，本周/本月=区间累计（成交额、涨跌幅均按区间累计）`;
    }
    const upd = document.getElementById('crowdingUpdated');
    if (upd) upd.textContent = '更新 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  },

  _tpPlainDir(d) {
    if (!d) return '震荡';
    return String(d).replace(/（.*?）/g, '').replace(/\(.*?\)/g, '').trim() || '震荡';
  },

  // 读取「市场情绪拐点」详情折叠状态（默认展开，用户可手动折叠）。
  _isTpDetailOpen() {
    try {
      return localStorage.getItem('sa_tp_detail_open_v1') !== 'false';
    } catch (e) {
      return true;
    }
  },

  // 首页情绪面板（20260917d：大盘量能情绪分析模型 / 旧版情绪拐点检测器）
  renderHomeTpPanel(data, symbol) {
    // 若用户已离开首页，丢弃旧请求
    const empty = document.getElementById('emptyState');
    if (empty && empty.classList.contains('hidden')) return;
    if (data && data.model === 'volume-emotion-v2') { this._renderEmotionPanel(data); return; }
    this._renderTpPanelInto({ panelId: 'homeSentimentPanel', bodyId: 'homeSentimentBody', updatedId: 'homeSentimentUpdated' }, data, symbol, { guardSymbol: false, hideSensitivity: true });
  },

  // ============ 首页·大盘量能情绪分析模型（20260917d，20261015k 起 9 因子确定性计算）============


  _renderEmotionPanel(data) {
    const panel = document.getElementById('homeSentimentPanel');
    const body = document.getElementById('homeSentimentBody');
    const updated = document.getElementById('homeSentimentUpdated');
    if (!body) return;
    if (panel) panel.style.display = '';
    if (updated) updated.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');
    this._emoData = data;                       // 详情折叠状态变化时重渲染用

    // 20261025p：情绪总分改「权重比合计净值」（±分制）——totalScore(−1~1) × 100 = 各因子净权重之和
    const score = (typeof data.totalScore === 'number') ? data.totalScore : null;
    const points = (score != null) ? Number((score * 100).toFixed(2)) : null;
    const scoreCls = points == null ? 'flat' : points >= 20 ? 'bull' : points <= -20 ? 'bear' : 'flat';
    const dirCls = data.tendencyKey === 'bull' ? 'pos' : data.tendencyKey === 'bear' ? 'neg' : 'neu';
    const detailOpen = this._isTpDetailOpen();
    const esc = (s) => this.escapeHtml(s == null ? '' : String(s));

    let html = '';
    html += `<div class="tp-status-row tp-emo ${scoreCls}">`;
    html += `<span class="tp-status-badge">情绪总分 ${points != null ? (points > 0 ? '+' : '') + points.toFixed(2) + ' 分' : '—'}</span>`;
    html += `<span class="tp-status-dir">短期倾向：<b class="${dirCls}">${esc(data.tendency || '中性')}</b></span>`;
    html += `<span class="tp-status-idx">量能状态：<span class="${volTierCls(data.volumeState)}">${esc(data.volumeState || '—')}</span></span>`;
    if (data.circuit) html += `<span class="tp-status-z">⛔ 极端行情熔断</span>`;
    html += `</div>`;
    html += `<button class="tp-detail-toggle" data-action="toggle-tp-detail">${detailOpen ? '▾ 隐藏详情' : '▸ 展开详情'}</button>`;

    // —— §十 最终输出：六行结论（始终可见）——
    const line = (k, v, cls) => `<div class="tp-emo-line"><span class="tp-emo-k">${k}</span><span class="tp-emo-v ${cls || ''}">${v}</span></div>`;
    html += `<div class="tp-emo-lines">`;
    html += line('情绪总分', `${points != null ? (points > 0 ? '+' : '') + points.toFixed(2) + ' 分' : '—'}<span class="tp-emo-sub">（范围 −100 ~ +100 分，正值乐观；= 各因子净权重合计）</span>`);
    html += line('短期倾向', `<b class="${dirCls}">${esc(data.tendency || '中性')}</b>`);
    html += line('核心驱动', this._dirColorize(data.coreDriver || '—'));
    html += line('量能状态', this._dirColorize(data.volumeState || '—'), volTierCls(data.volumeState));
    // [20261109b] 操作建议 / 风险提示是「提示」而非方向信号，不着红绿，
    // 否则会把 .tp-emo-warn / .tp-emo-risk 的琥珀警示色染成方向色（数值符号 ≠ 方向）。
    html += line('操作建议', esc(data.advice || '—'), data.circuit ? 'tp-emo-warn' : '');
    html += line('风险提示', esc(data.riskTip || '—'), 'tp-emo-risk');
    html += `</div>`;

    // 20261025p：删除「情绪因子明细 / 宽基 ETF 申赎」页签——ETF 明细改独立网页 /etf-flow.html，
    // 因子卡片内按钮直达（open-etf-page），首页卡片回归单视图，保持排版对称。

    html += `<div class="tp-detail-body ${detailOpen ? '' : 'collapsed'}">`;

    // 因子网格（与后端同源，数值一致）
    const fs = Array.isArray(data.factors) ? data.factors : [];
    if (fs.length) {
      html += `<div class="tp-block-title">因子明细（8 常驻 + 2 非常驻 · 净权重=评分，方向满格计入总分；两融双栏各按半格）</div>`;
      html += '<div class="tp-comp-grid">';
      fs.forEach(f => {
        // 20261025n：权重=评分（对齐个股短期判断模块）——大字显示「净权重 ±X%」（方向满格×权重），
        // 不再显示 -1~1 的强度得分；强度信息保留在 detail 文案里
        const contrib = (typeof f.contribution === 'number') ? f.contribution : 0;
        const sigCls = contrib > 0 ? 'tp-sig-bull' : contrib < 0 ? 'tp-sig-bear' : 'tp-sig-flat';
        const signTxt = `净权重 ${contrib > 0 ? '+' : ''}${contrib.toFixed(2)}%`;
        // [20261109a] 两融余额：一张卡内融资/融券双栏，各占本卡 50% 权重
        const isDual = f.key === 'margin' && Array.isArray(f.subs) && f.subs.length === 2;
        html += `<div class="tp-comp${f.degraded ? ' tp-comp-degraded' : ''}${isDual ? ' tp-comp-dual-card' : ''}">`;
        html += `<div class="tp-comp-label">${esc(f.name)}<span class="tp-comp-w">权重${f.weight != null ? f.weight.toFixed(2) : '—'}%</span></div>`;
        html += `<div class="tp-comp-sig ${sigCls}">${signTxt}</div>`;
        if (isDual) {
          // 方向色按**语义**给（利好=红 / 利空=绿），不经过 _dirColorize：
          // 融券余额「+2%」是增加=利空，若按数值符号染红就与本卡语义错位（用户铁律：禁止方向与颜色语义错位）。
          html += '<div class="tp-comp-dual">';
          f.subs.forEach(sub => {
            const tCls = sub.tone === 'bull' ? 'tp-sig-bull' : sub.tone === 'bear' ? 'tp-sig-bear' : 'tp-sig-flat';
            const dirTxt = sub.absent ? '不计分' : sub.dir > 0 ? '利好' : sub.dir < 0 ? '利空' : '中性';
            html += `<div class="tp-comp-sub${sub.absent ? ' tp-comp-sub-absent' : ''}">`
              + `<div class="tp-comp-sub-hd">${esc(sub.name)}<span>${esc(String(sub.weightPct != null ? sub.weightPct : 50))}%</span></div>`
              + `<div class="tp-comp-sub-val ${tCls}">${esc(sub.value || '—')}</div>`
              + `<div class="tp-comp-sub-dir ${tCls}" title="${esc(sub.label || '')}">${esc(dirTxt)}</div>`
              + `<div class="tp-comp-sub-note">${esc(sub.note || '')}</div>`
              + '</div>';
          });
          html += '</div>';
        } else {
          html += `<div class="tp-comp-value">${this._dirColorize(f.value || '')}</div>`;
        }
        // 20261025p：ETF 明细改独立网页 /etf-flow.html（弹窗/页签废弃），卡片按钮新标签打开
        const detailTxt = f.key === 'etfFlow'
          ? '份额较上一收盘增加 → 折算净申赎额；口径说明、ETF 名单与逐股明细见独立页（点下方按钮新标签打开）。'
          : (f.detail || '');
        html += `<div class="tp-comp-detail">${isDual ? esc(detailTxt) : this._dirColorize(detailTxt)}</div>`;
        if (isDual && f.splitNote) html += `<div class="tp-comp-detail tp-emo-info">ℹ️ ${esc(f.splitNote)}</div>`;
        if (f.key === 'etfFlow') html += `<button type="button" class="tp-comp-more" data-action="open-etf-page">查看宽基ETF明细 →</button>`;
        // 20261023j：卡片补「数据日期」——原来只有结论没有日期，用户无法判断数据新旧（2026-10-23 截图报障）。
        //   优先用因子自带日期（ETF=份额披露日 20261022、讨论热度=热度时间），其余用模型基准日；
        //   宏观因子数据期为月度，已在 detail 写明（如「2026年09月份」），不再重复。
        const isMacroF = f.key === 'domesticMacro' || f.key === 'usMacro';
        const fmtD = (s) => /^\d{8}$/.test(String(s)) ? `${String(s).slice(0, 4)}-${String(s).slice(4, 6)}-${String(s).slice(6)}` : String(s);
        const dateTxt = (f.key === 'etfFlow' && f.etfDate) ? fmtD(f.etfDate)
          : (f.key === 'discussionHeat' && f.heatDate) ? String(f.heatDate).slice(0, 10)
            : fmtD(f.dataDate || data.date || data.baselineDate || '');
        if (!isMacroF && dateTxt) html += `<div class="tp-comp-date">数据日期 ${esc(dateTxt)}</div>`;
        if (f.degraded) html += `<div class="tp-comp-detail tp-emo-warn">⚠ ${esc(f.reason || '数据不可用')} → 权重已归零并按比例分摊</div>`;
        else if (f.fallback) html += `<div class="tp-comp-detail tp-emo-warn">⊕ ${esc(f.reason || '节假日兜底：显示最近一次成功数据')}</div>`;
        else if (f.lagged) {
          // 20261023l：区分「T+1 例行披露」（融资余额等，最新可得就是上一交易日）与「异常滞后」。
          //   前者不再用 ⏱ 警告口吻，改为中性说明：8 折是模型规则，不是数据缺失。
          const lagDate = f.dataDate ? fmtD(f.dataDate) : (f.lagDays != null ? `${f.lagDays} 个交易日前` : '上一交易日');
          const cadenceTxt = f.lagNote || `T+1 例行披露（最新可得 ${lagDate}）`;
          html += f.lagKind === 'cadence'
            ? `<div class="tp-comp-detail tp-emo-info">ℹ️ ${esc(cadenceTxt)} → 模型规则权重 ×0.8（惯例折扣，非数据异常）</div>`
            : `<div class="tp-comp-detail tp-emo-warn">⏱ 数据滞后${f.lagDays != null ? ` ${f.lagDays} 个交易日` : '（日期未知）'} → 权重按规则打 8 折</div>`;
        }
        html += `</div>`;
      });
      html += '</div>';
    }

    // 自学习 + 准确率台账
    const acc = data.accuracy || {};
    const ll = Array.isArray(data.learnLog) ? data.learnLog : [];
    const ld = Array.isArray(data.learnDetail) ? data.learnDetail : [];
    // 20261027c：learnLog 为空 ≠ 样本不足——可能是已顶 5%~30% 权重上限或处于 45%~60% 死区。
    // 逐因子诚实三分态：adjusted（本次调整）/ cap_up·cap_down（顶上限/踩下限）/ deadzone（死区）/ insufficient（样本不足）。
    let learnTxt;
    if (ll.length) {
      learnTxt = `本次调整 ${ll.length} 项：${ll.map(x => `${esc(x.name)} ${x.from}%→${x.to}%`).join('、')}`;
    } else if (ld.length) {
      const fmtRate = (r) => (r == null ? '—' : Math.round(r * 100) + '%');
      const ready = ld.filter(x => x.status !== 'insufficient');
      const ins = ld.filter(x => x.status === 'insufficient');
      if (ready.length) {
        const parts = [];
        const capped = ready.filter(x => x.status === 'cap_up' || x.status === 'cap_down');
        const dz = ready.filter(x => x.status === 'deadzone');
        if (capped.length) parts.push(`已顶权重边界（不再同向调整）：${capped.map(x => `${esc(x.name)} 近窗命中 ${fmtRate(x.rate)}（权重 ${x.weight}%）`).join('、')}`);
        if (dz.length) parts.push(`死区观望（45%~60% 按规则不动）：${dz.map(x => `${esc(x.name)} 近窗命中 ${fmtRate(x.rate)}（权重 ${x.weight}%）`).join('、')}`);
        if (ins.length) {
          const maxN = Math.max(...ins.map(x => x.n || 0));
          parts.push(`待积累 ${ins.length} 个因子（样本最高 ${maxN}/20）`);
        }
        learnTxt = `自学习已在运行、权重维持不动：${parts.join('；')}`;
      } else {
        const maxN = Math.max(...ld.map(x => x.n || 0));
        learnTxt = `当前样本不足（因子样本最高 ${maxN}/20），权重保持固定（只记录不调整）`;
      }
    } else {
      learnTxt = '当前样本不足，权重保持固定（只记录不调整）';
    }
    html += '<div class="tp-learn-block">';
    html += '<div class="tp-block-title">越用越准（自动学习）</div>';
    html += `<div class="tp-learn-line">权重自学习：需累计 <b>20</b> 次以上预测样本后才自动调整（命中率 &gt;60% 上调、&lt;45% 下调，常驻因子权重恒定在 <b>5%~30%</b>）；${learnTxt}</div>`;
    if (acc.totalRecords != null) {
      let line = `准确率台账：已记录 <b>${acc.totalRecords}</b> 条预测，已结算 <b>${acc.settledCount}</b> 条`;
      if (acc.accuracy != null) {
        line += `，命中率 <b>${acc.accuracy}%</b>`;
        // 20261013f：拆分展示「震荡未命中」与「方向真错」，避免 0% 一刀切被误读（结算口径不变）
        if (acc.flatMissCount != null && (acc.flatMissCount + acc.dirMissCount) > 0) {
          line += `（其中震荡未命中 <b>${acc.flatMissCount}</b> / 方向真错 <b>${acc.dirMissCount}</b>）`;
        }
      }
      line += `（口径：${esc(acc.horizonLabel || 'T+1 / T+3 / T+5')}）`;
      html += `<div class="tp-learn-line">${line}</div>`;
      // 20261023g：列出待结算的具体日期，避免「已记录 20 / 已结算 18」看不出差在哪两天
      if (Array.isArray(acc.pendingList) && acc.pendingList.length) {
        const d0 = new Date();
        const todayStr = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')}`;
        const parts = acc.pendingList.map(p => {
          const b = String(p.baseDate || '').slice(5);
          const t = String(p.targetDate || '').slice(5);
          const wait = p.targetDate === todayStr ? '待今日收盘' : '未到目标日';
          return `${b}（目标 ${t}，${wait}）`;
        });
        html += `<div class="tp-learn-line">待结算 ${acc.pendingList.length} 条：${parts.join(' · ')}</div>`;
      }
    }
    if (data.health && data.health.report) {
      const hr = data.health.report;
      html += `<div class="tp-learn-line">模型健康度（${esc(hr.month)}）：结算 ${hr.settledCount} 条${hr.accuracy != null ? `，准确率 ${hr.accuracy}%` : ''}${(hr.failedFactors || []).length ? `；⚠ ${esc(hr.failedFactors.join('；'))}` : ''}</div>`;
    }
    html += '</div>';

    if (data.dataNote) html += `<div class="tp-sample-note tp-emo-warn">数据缺口：${esc(data.dataNote)}</div>`;
    if (data.sampleNote) html += `<div class="tp-sample-note">${esc(data.sampleNote)}</div>`;
    if (Array.isArray(data.issues) && data.issues.length) html += `<div class="tp-sample-note tp-emo-warn">数据自检：${esc(data.issues.map(i => i.msg).join('；'))}</div>`;
    html += `<div class="tp-source-note">数据来源：${esc(data.source || '')}｜基准日 ${esc(data.baselineDate || data.date || '')}｜规则：大盘量能情绪分析模型（完整版）。</div>`;
    html += `</div>`;

    body.innerHTML = html;
  },

  _renderTpPanelInto(ids, data, symbol, opts) {
    opts = opts || {};
    if (opts.guardSymbol && this.currentSymbol && this.currentSymbol !== symbol) return; // 已切换股票，丢弃
    const panel = document.getElementById(ids.panelId);
    const body = document.getElementById(ids.bodyId);
    const updated = document.getElementById(ids.updatedId);
    if (!panel || !body) return;
    panel.style.display = '';
    if (updated) updated.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN');

    const levelCls = 'tp-level-' + (data.levelKey || 'none');
    const lvlLabel = { none: '无预警', watch: '关注', warn: '预警', strong: '强烈预警' }[data.levelKey] || '无预警';

    let html = '';
    const detailOpen = this._isTpDetailOpen();
    // 顶部状态行
    html += `<div class="tp-status-row ${levelCls}">`;
    html += `<span class="tp-status-badge">${lvlLabel}</span>`;
    html += `<span class="tp-status-dir">短期倾向：<b>${this._tpPlainDir(data.impliedDir)}</b></span>`;
    html += `<span class="tp-status-idx">情绪评分 ${data.index != null ? data.index : '—'}（在 -1~1 之间，越接近 1 越乐观） · 偏离值 ${data.zScore != null ? data.zScore : '—'} · 短期均线 ${data.ma5 != null ? data.ma5 : '—'} / 长期均线 ${data.ma20 != null ? data.ma20 : '—'}</span>`;
    html += `<span class="tp-status-z">警戒线 ${data.extremeZ != null ? data.extremeZ : '—'}</span>`;
    html += `</div>`;
    html += `<button class="tp-detail-toggle" data-action="toggle-tp-detail">${detailOpen ? '▾ 隐藏详情' : '▸ 展开详情'}</button>`;
    html += `<div class="tp-detail-body ${detailOpen ? '' : 'collapsed'}">`;

    // 分量网格（与后端同源，数值一致）
    const comps = Array.isArray(data.components) ? data.components : [];
    if (comps.length) {
      html += '<div class="tp-comp-grid">';
      comps.forEach(c => {
        const sig = (typeof c.signal === 'number') ? c.signal : 0;
        // 20261016b（审计 L4）：阈值对齐后端判色口径 ±0.05
        // （短期判断因子 lib/sameDayJudgment.js:209/1040，大盘情绪分量 lib/marketEmotionModel.js:526）
        // 旧值 ±0.03 会导致「文字显示中性、颜色却染成偏多/偏空」的语义错位。
        const sigCls = sig > 0.05 ? 'tp-sig-bull' : sig < -0.05 ? 'tp-sig-bear' : 'tp-sig-flat';
        const signTxt = (sig >= 0 ? '+' : '') + sig.toFixed(2);
        html += `<div class="tp-comp">`;
        html += `<div class="tp-comp-label">${c.label}<span class="tp-comp-w">占${c.weight != null ? (c.weight * 100).toFixed(0) : '—'}%</span></div>`;
        html += `<div class="tp-comp-sig ${sigCls}">${signTxt}</div>`;
        html += `<div class="tp-comp-value">${this._dirColorize(c.value || '')}</div>`;
        html += `<div class="tp-comp-detail">${this._dirColorize(c.detail || '')}</div>`;
        html += `</div>`;
      });
      html += '</div>';
    }

    // 拐点原因
    const rs = Array.isArray(data.reasons) ? data.reasons : [];
    if (rs.length) {
      html += '<div class="tp-reasons-block"><div class="tp-block-title">提醒原因</div>';
      rs.forEach(r => {
        html += `<div class="tp-reason-line tp-reason-${r.type || 'info'}">${r.text}</div>`;
      });
      html += `</div>`;
    }

    // 自适应学习状态
    const lr = data.learning || {};
    html += '<div class="tp-learn-block">';
    html += '<div class="tp-block-title">越用越准（自动学习）</div>';
    html += `<div class="tp-learn-line">警戒线（判断是否到极端）：<b>${lr.extremeZ != null ? lr.extremeZ : '—'}</b>`;
    if (lr.calibratedFrom) html += `（首次根据大盘历史数据自动设定）`;
    html += `</div>`;
    html += `<div class="tp-learn-line">已记录 <b>${lr.total || 0}</b> 次"情绪到极端"的情况，其中 <b>${lr.correct || 0}</b> 次之后市场确实反转了`;
    if (lr.hitRate != null) html += `，准确率 <b>${(lr.hitRate * 100).toFixed(0)}%</b>`;
    html += `</div>`;
    if (lr.lastUpdated) html += `<div class="tp-learn-line tp-learn-sub">最近学习：${new Date(lr.lastUpdated).toLocaleString('zh-CN')}</div>`;
    html += '</div>';

    // 个股市场敏感度（首页隐藏）
    if (!opts.hideSensitivity && data.sensitivity) {
      html += '<div class="tp-sens-block">';
      html += `<div class="tp-block-title">这只股票对大盘情绪的敏感程度</div>`;
      html += `<div class="tp-sens-line">敏感度系数 = <b>${data.sensitivity.beta != null ? data.sensitivity.beta : '—'}</b> · ${data.sensitivity.note || ''}</div>`;
      html += '</div>';
    }

    if (data.sampleNote) {
      html += `<div class="tp-sample-note">${data.sampleNote}</div>`;
    }
    html += `<div class="tp-source-note">数据来源：东方财富（涨停跌停 / 融资余额 / 股吧讨论）+ 全网消息抓取 + 大盘自身涨跌；每天收盘后自动存档，用于识别情绪拐点和自动学习。</div>`;
    html += `</div>`;

    body.innerHTML = html;
  },

  _toggleSameDayLogic(j, symbol) {
    const logic = document.getElementById('samedayLogic');
    if (!logic) return;
    if (logic.style.display === 'none') {
      logic.innerHTML = this._renderSameDayLogicHtml(j, symbol);
      logic.style.display = '';
      this._bindSameDayLogicExtras(logic);
      const refresh = logic.querySelector('#samedayRefreshBtn');
      if (refresh) refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        refresh.textContent = '重新判断中…';
        try {
          const name = this.currentData?.name || '';
          const industry = this.currentData?.quote?.industry || '';
          const resp = await fetch(`/api/sameday-judgment/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name)}&industry=${encodeURIComponent(industry)}&refresh=1`);
          const data = await resp.json();
          if (data && data.success !== false && data.judgment) {
            this.renderSameDayJudgment(data, symbol);
            logic.innerHTML = this._renderSameDayLogicHtml(data.judgment, symbol);
            const rb = logic.querySelector('#samedayRefreshBtn');
            if (rb) rb.addEventListener('click', () => this._rebindRefresh(symbol));
          }
        } catch (e) {
          refresh.textContent = '重试';
        } finally {
          refresh.disabled = false;
        }
      });
    } else {
      logic.style.display = 'none';
    }
  },

  _rebindRefresh(symbol) {
    const logic = document.getElementById('samedayLogic');
    const refresh = logic && logic.querySelector('#samedayRefreshBtn');
    if (!refresh) return;
    refresh.disabled = true;
    refresh.textContent = '重新判断中…';
    (async () => {
      try {
        const name = this.currentData?.name || '';
        const industry = this.currentData?.quote?.industry || '';
        const resp = await fetch(`/api/sameday-judgment/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name)}&industry=${encodeURIComponent(industry)}&refresh=1`);
        const data = await resp.json();
        if (data && data.success !== false && data.judgment) {
          this.renderSameDayJudgment(data, symbol);
          logic.innerHTML = this._renderSameDayLogicHtml(data.judgment, symbol);
          this._bindSameDayLogicExtras(logic);
          const rb = logic.querySelector('#samedayRefreshBtn');
          if (rb) rb.addEventListener('click', () => this._rebindRefresh(symbol));
        }
      } catch (e) {} finally { refresh.disabled = false; }
    })();
  },

  // 影响程度评分：优先用后端 combineFactors 下发的 impactScore（唯一权威源），
  // 旧缓存无该字段时按 signal 现算兜底，保证任何展示位置数值一致（规则一·指标级单源）。
  _impactOf(f) {
    if (f == null) return 0;
    if (typeof f.impactScore === 'number') return f.impactScore;
    // 旧缓存兜底：与后端 ruleCore.toImpactScore 同口径
    // （对称舍入 + 方向保底，避免 -0.5 被舍成 -1 而 +0.5 舍成 +2 的正负不对称）
    const sig = (typeof f.signal === 'number') ? f.signal : 0;
    const raw = Math.max(-3, Math.min(3, sig * 3));
    let s = raw >= 0 ? Math.round(raw) : -Math.round(-raw);
    if (s === 0 && Math.abs(sig) >= 0.02) s = sig > 0 ? 1 : -1;
    return s;
  },

  // 方向色类名：由影响程度评分统一决定（与徽章同源），杜绝「圆点红、徽章灰」的错位
  _impactCls(f) {
    const s = this._impactOf(f);
    return s > 0 ? 'pos' : s < 0 ? 'neg' : 'neu';
  },

  // 方向徽章：红=利好 / 绿=利空 / 灰=中性（20261025g：统一口径，只显示文字方向，不再显示 ±档位数字）
  _impactBadge(f) {
    const s = (typeof f === 'number') ? f : this._impactOf(f);
    const cls = s > 0 ? 'pos' : s < 0 ? 'neg' : 'neu';
    const label = s > 0 ? '利好' : s < 0 ? '利空' : '中性';
    return `<span class="sd-impact ${cls}" title="方向：${label}（红=利好，绿=利空）">${label}</span>`;
  },

  // 20260906：因子名渲染——板块跷跷板标题中的「负相关」用黄色高亮（用户要求，仅此因子；其他因子名原样）
  _factorNameHtml(f) {
    const name = this._escapeHtml(f.name);
    if (f.key === 'seesaw') return name.replace(/负相关/g, '<span class="sd-rel-hl">负相关</span>');
    return name;
  },

  // 渲染单个因子的详情体：含子维度的因子用卡片网格分段，否则保留原有密集文本
  _renderFactorBody(f) {
    const subs = f.subFactors;
    if (subs && subs.length >= 1) {
      const cards = subs.map(sf => {
        // 颜色由影响程度评分统一决定，保证圆点/取值/徽章三者同向
        const signCls = this._impactCls(sf);
        // 20260906：板块跷跷板因子子卡片不做利好/利空/中性判断，只标注「负相关」（黄色；用户要求，仅此因子）
        const badge = (f.key === 'seesaw')
          ? '<span class="sd-impact rel" title="该板块与个股呈负相关关系（跷跷板效应），不做方向判断">负相关</span>'
          : this._impactBadge(sf);
        // 20261025j：子卡片显示「权重 ±X%」= 因子内份额 × 因子有效权重（方向入符号、带方向色）
        const eff = (typeof f.effectiveWeight === 'number') ? f.effectiveWeight : 0;
        const hasW = typeof sf.weight === 'number' && sf.weight > 0 && sf.signal !== 0;
        const wPart = hasW
          ? `<span class="sd-factor-contrib ${signCls}">权重 ${sf.signal > 0 ? '+' : '-'}${(Math.abs(sf.weight) * eff * 100).toFixed(0)}%</span>`
          : '';
        return `<div class="sd-sub-card">
          <div class="sd-sub-head">
            <span class="sd-dot ${signCls}"></span>
            <span class="sd-sub-name">${this._escapeHtml(sf.name)}</span>
            ${badge}${wPart}
          </div>
          <div class="sd-sub-value ${signCls}">${this._dirColorize(String(sf.value || '—'))}</div>
          <div class="sd-sub-detail">${this._dirColorize(sf.detail || '')}</div>
        </div>`;
      }).join('');
      // 20260914i：移除顶部「汇总取值」白字行（用户要求）——
      // 该行内容与下方子卡片里的红/绿着色文字完全重复（如「食品饮料▲中度 ｜ 原油(主连)▼轻微·合计50.0%」
      // 与子卡的「▲利好·食品饮料·中度·剩105天」重复），且白字不携带方向语义、反而干扰阅读。
      // 方向信息一律由子卡片的有色文字承载。
      const summary = '';
      const caption = f.caption
        ? `<div class="sd-factor-caption">${this._escapeHtml(f.caption)}</div>` : '';
      return `${summary}<div class="sd-sub-grid">${cards}</div>${caption}`;
    }
    return `<div class="sd-factor-detail">${this._escapeHtml(f.detail)}</div>
      <div class="sd-factor-val">取值：${this._escapeHtml(String(f.value))}</div>`;
  },

  _renderSameDayLogicHtml(j, symbol) {
    // 重构：主导因子优先 + 紧凑横向条 + 逐因子手风琴，避免密集堆叠
    const all = (j.factors || []).filter(f => f.applicable);
    const maxAbs = all.reduce((m, f) => Math.max(m, Math.abs(f.contribution || 0)), 0) || 1;
    const topN = 3; // 默认只展示贡献最大的前 3 个因子，其余折叠
    // 20260905f：类型级一致性，所有个股按 FACTOR_KEYS 规范顺序（与 lib/sameDayJudgment.js 一致），
    // 一级排序=规范顺序，二级排序=贡献分绝对值降序（保证可视化稳定性，贡献大的优先）。
    // 这样无论两只股票数据是否相同，渲染顺序都一致（用户可对照同位置比较）。
    // 20260917i：因子重组后同步——删除 market（原「大盘及行业板块短期走势」），其余顺序保持
    const FACTOR_ORDER = { sentiment: 0, capital: 1, futures: 2, holdings: 3, sectorLimit: 4, seesaw: 5, technicalShort: 6 };
    const sorted = all.slice().sort((a, b) => {
      const oa = (FACTOR_ORDER[a.key] != null) ? FACTOR_ORDER[a.key] : 999;
      const ob = (FACTOR_ORDER[b.key] != null) ? FACTOR_ORDER[b.key] : 999;
      if (oa !== ob) return oa - ob;
      return Math.abs(b.contribution || 0) - Math.abs(a.contribution || 0);
    });
    const rows = sorted.map((f, i) => {
      // 颜色由影响程度评分统一决定（与圆点/条形同源）；条形方向仍按贡献分符号（左右分侧）
      const signCls = this._impactCls(f);
      const pct = Math.min(50, Math.abs(f.contribution || 0) / maxAbs * 50); // 双向条：从中线向两侧延伸
      const barStyle = f.contribution >= 0 ? `left:50%;width:${pct}%` : `left:${50 - pct}%;width:${pct}%`;
      const hidden = i >= topN ? ' is-hidden' : '';
      // 20261025j：权重=评分铺满全模块——子卡 weight 统一为「因子内份额」，显示份额×因子有效权重；
      // 因子行「净权重 X%（最高 Y%）」= Σ(份额×eff×方向)，即该因子评分；无加权子卡的因子仍显示「权重 X%」。
      const effW = (typeof f.effectiveWeight === 'number') ? f.effectiveWeight : 0;
      const subW = (f.subFactors || []).filter(sf => typeof sf.weight === 'number' && sf.weight > 0 && sf.signal !== 0);
      const netW = subW.length ? subW.reduce((a, sf) => a + sf.weight * effW * (sf.signal > 0 ? 1 : -1), 0) : null;
      const wHtml = (netW != null)
        ? `<span class="sd-factor-contrib ${netW > 0 ? 'pos' : netW < 0 ? 'neg' : 'neu'}">净权重 ${(netW * 100).toFixed(0)}%</span><span class="sd-factor-w">（最高 ${Math.round((f.effectiveWeight || 0) * 100)}%）</span>`
        : `<span class="sd-factor-w">权重 ${Math.round((f.effectiveWeight || 0) * 100)}%</span>`;
      return `<div class="sd-factor-row${hidden}">
        <button class="sd-factor-toggle" type="button" aria-expanded="false">
          <span class="sd-dot ${signCls}"></span>
          <span class="sd-factor-name">${this._factorNameHtml(f)}</span>
          <span class="sd-bar-track"><span class="sd-bar ${signCls}" style="${barStyle}"></span></span>
          ${wHtml}
          <span class="sd-chevron">▾</span>
        </button>
        <div class="sd-factor-body">
          ${this._renderFactorBody(f)}
        </div>
      </div>`;
    }).join('');
    const targetLabel = '下一交易日走势';
    const fmtMD = (s) => { const p = String(s || '').split('-'); return (p.length >= 3) ? `${+p[1]}月${+p[2]}日` : ''; };
    const titleDate = j.targetDate || j.date;
    const targetWithDate = `${targetLabel}${titleDate ? `（${fmtMD(titleDate)}）` : ''}`;
    const cls = j.dir === '涨' ? 'bull' : j.dir === '跌' ? 'bear' : 'neu';
    const confCls = j.confidence === '高' ? 'conf-high' : j.confidence === '中' ? 'conf-mid' : 'conf-low';
    const settleBasis = '次日收盘 vs 今日收盘';
    const hist = (j.settled)
      ? `<div class="sd-settle">✅ 已结算：${j.actualTargetLabel || '实际'} ${j.actualChgPct >= 0 ? '+' : ''}${j.actualChgPct}%（实际${j.actualDir}），${j.correct ? '判断正确' : '判断错误'}</div>`
      : `<div class="sd-settle sd-pending">⏳ 待结算（口径：${settleBasis}）</div>`;
    const expandBtn = sorted.length > topN
      ? `<button class="sd-expand-btn" id="sdExpandBtn" type="button">展开全部 ${sorted.length} 个因子 ▾</button>`
      : '';
    return `<div class="sd-logic-box">
      <div class="sd-summary">
        <span class="sd-verdict-pill ${cls}">${this._escapeHtml(j.verdict)}</span>
        <div class="sd-summary-meta">
          <span>预测 ${this._escapeHtml(targetWithDate)}</span>
          <span>综合分 <b>${j.score > 0 ? '+' : ''}${j.score}</b>/100</span>
          <span class="sd-conf ${confCls}">${this._escapeHtml(j.confidence)}置信</span>
        </div>
      </div>
      <div class="sd-drivers">${rows}</div>
      ${expandBtn}
      <div class="sd-weight-note">权重按当日可用因子自动归一化；对标期货不适用时不参与打分。数据缺失的因子按 signal=0 占位但仍计入归一化，会摊薄有效因子权重（如仅 5/7 因子有效时，有效因子合计权重约降至 5/7）。</div>
      ${hist}
      <div class="sd-actions">
        <button class="ai-trigger-btn" id="samedayRefreshBtn" type="button">重新判断</button>
      </div>
    </div>`;
  },

  // 绑定逻辑框内的交互：因子手风琴 + 展开/收起全部
  _bindSameDayLogicExtras(logic) {
    if (!logic) return;
    const expandBtn = logic.querySelector('#sdExpandBtn');
    if (expandBtn) {
      expandBtn.addEventListener('click', () => {
        const rows = Array.from(logic.querySelectorAll('.sd-factor-row'));
        const anyHidden = rows.some(el => el.classList.contains('is-hidden'));
        if (anyHidden) {
          rows.forEach(el => el.classList.remove('is-hidden'));
          expandBtn.textContent = '收起 ▴';
          expandBtn.classList.add('is-expanded');
        } else {
          rows.forEach((el, i) => { if (i >= 3) el.classList.add('is-hidden'); });
          expandBtn.textContent = `展开全部 ${rows.length} 个因子 ▾`;
          expandBtn.classList.remove('is-expanded');
        }
      });
    }
    logic.querySelectorAll('.sd-factor-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.sd-factor-row');
        const body = row && row.querySelector('.sd-factor-body');
        if (!body) return;
        const open = body.classList.toggle('is-open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.classList.toggle('is-open', open);
      });
    });
  },

  // [20261109b] 全工作台颜色语义铁律（用户 2026-11-09 指令）：
  //   只有「利好 / 正面」才能红色，只有「利空 / 负面」才能绿色；数值符号 ≠ 方向。
  // 旧版对任意带符号数值机械染红/绿，会把「融券余额 +2.08%」「亏损扩大 +30%」这类
  // 正数值但语义负面的内容误染成利好红，也会让风险提示里的数字覆盖琥珀警示色。
  // 现在改为三级契约：
  //   ① _dirColorize(text)                    自由文本：仅按【显式语义词】着色，不看数值符号
  //   ② _dirColorize(text, { tone:'bull' })  调用方已有确定性语义方向：整段按 tone 着色
  //   ③ _dirColorize(text, { numeric:true }) 仅限「语义与符号严格一致」的涨跌幅字段，显式 opt-in
  // 纯文本着色统一用 tp-sig-* 语义类（不带 !important），避免 .up/.down 覆盖父级琥珀警示色。
  _dirColorize(text, opts) {
    const o = opts || {};
    const s = this._escapeHtml(text == null ? '' : String(text));
    if (o.tone === 'bull' || o.tone === 'bear' || o.tone === 'flat') {
      const cls = o.tone === 'bull' ? 'tp-sig-bull' : o.tone === 'bear' ? 'tp-sig-bear' : 'tp-sig-flat';
      return `<span class="${cls}">${s}</span>`;
    }
    if (o.numeric === true) {
      return s.replace(/(^|[^0-9A-Za-z%./])([+\-−]\d+(?:\.\d+)?%?)/g, (m, p, num) =>
        /^[-−]/.test(num) ? `${p}<span class="down">${num}</span>` : `${p}<span class="up">${num}</span>`);
    }
    // 长词优先；NEUTRAL 中的组合词整体跳过，避免「涨跌幅」被拆成红「涨」+绿「跌」
    // NEUTRAL：组合词整体跳过（避免「涨跌幅」被拆成红涨+绿跌）；风险/状态词保持琥珀或灰，不染方向色
    const NEUTRAL = '涨跌幅|涨跌家数|涨跌停|涨跌幅分布|风险|风控|压力|隐忧|承压|放缓|缺口|缺失|未核验|待验证|中性|震荡|持平|未通过';
    const BULL = '上涨|涨停|增持|净流入|利好|偏多|看多|低估|超预期|改善|回升|向好|突破|站上|转正|新高|高增|亮眼|加速|涨';
    const BEAR = '下跌|跌停|减持|净流出|利空|偏空|看空|高估|不及预期|低于预期|恶化|亏损|走弱|回落|下滑|收窄|转负|未站上|跌';
    const bullRe = new RegExp('^(?:' + BULL + ')$');
    const re = new RegExp('(' + NEUTRAL + '|' + BULL + '|' + BEAR + ')', 'g');
    return s.replace(re, (w) => {
      if (new RegExp('^(?:' + NEUTRAL + ')$').test(w)) return w;
      return `<span class="${bullRe.test(w) ? 'tp-sig-bull' : 'tp-sig-bear'}">${w}</span>`;
    });
  },

  _escapeHtml(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  },


  // ---- 长期行情判断（中长期走势，不核算准确率，每次打开自动联网更新）----
  _setLongTermLoading() {
    const v = document.getElementById('longtermVerdict');
    const d = document.getElementById('longtermDetail');
    const conf = document.getElementById('longtermConfidence');
    const title = document.getElementById('longtermTitle');
    const sub = document.getElementById('longtermSubtitle');
    const btn = document.getElementById('longtermLogicBtn');
    const logic = document.getElementById('longtermLogic');
    const note = document.getElementById('longtermNote');
    if (v) { v.textContent = '分析中…'; v.className = 'score-value sameday-verdict neutral'; }
    if (d) d.textContent = '正在联网抓取基本面/行业前景/期货/指数长期走势…';
    if (conf) { conf.textContent = ''; conf.className = 'sameday-badge'; }
    if (title) title.textContent = '长期行情';
    if (sub) sub.textContent = '';
    if (note) note.textContent = '';
    if (btn) btn.style.display = 'none';
    if (logic) { logic.style.display = 'none'; logic.innerHTML = ''; }
  },

  async _loadLongTermJudgment(symbol, name, industry) {
    const v = document.getElementById('longtermVerdict');
    const d = document.getElementById('longtermDetail');
    if (!v || !d) return;
    try {
      const resp = await fetch(`/api/long-term-judgment/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name || '')}`);
      const data = await resp.json();
      if (this.overviewExtraSymbol !== symbol) return;
      if (!data || data.success === false || !data.judgment) {
        v.textContent = '—'; v.className = 'score-value sameday-verdict neutral';
        d.textContent = (data && data.error) ? ('分析失败：' + data.error) : '长期分析加载失败';
        return;
      }
      const j = data.judgment;
      if (j.symbol !== symbol) {
        // 后端返回了非当前股票的数据（缓存/竞态污染），强制刷新重试一次
        console.warn('[LongTerm] symbol mismatch, retry with refresh:', symbol, j.symbol);
        const retry = await fetch(`/api/long-term-judgment/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name || '')}&refresh=1`);
        const data2 = await retry.json();
        if (this.overviewExtraSymbol !== symbol) return;
        if (data2 && data2.success !== false && data2.judgment && data2.judgment.symbol === symbol) {
          this.renderLongTermJudgment(data2.judgment, symbol);
        } else {
          v.textContent = '—'; v.className = 'score-value sameday-verdict neutral';
          d.textContent = '长期分析数据与当前股票不一致';
        }
        return;
      }
      this.renderLongTermJudgment(j, symbol);
    } catch (e) {
      if (this.overviewExtraSymbol !== symbol) return;
      v.textContent = '—'; v.className = 'score-value sameday-verdict neutral';
      d.textContent = '长期分析加载失败';
    }
  },

  renderLongTermJudgment(j, symbol) {
    const v = document.getElementById('longtermVerdict');
    const d = document.getElementById('longtermDetail');
    const conf = document.getElementById('longtermConfidence');
    const btn = document.getElementById('longtermLogicBtn');
    const logic = document.getElementById('longtermLogic');
    const note = document.getElementById('longtermNote');
    const titleEl = document.getElementById('longtermTitle');
    const sub = document.getElementById('longtermSubtitle');
    if (!v || !j) return;
    if (j.symbol !== symbol) {
      console.warn('[renderLongTermJudgment] symbol mismatch, skip render:', symbol, j.symbol);
      return;
    }

    const fmtMD = (s) => { const p = String(s || '').split('-'); return (p.length >= 3) ? `${+p[1]}月${+p[2]}日` : ''; };
    if (titleEl) titleEl.textContent = '长期行情';
    if (sub) {
      let t = `中长期（约 3~12 个月）· ${j.horizonLabel || ''}`;
      if (j.generatedAt) {
        const dt = new Date(j.generatedAt);
        if (!isNaN(dt)) {
          const hh = String(dt.getHours()).padStart(2, '0');
          const mm = String(dt.getMinutes()).padStart(2, '0');
          t += ` · 更新 ${hh}:${mm}`;
        }
      }
      sub.textContent = t;
    }

    const cls = j.dir === '涨' ? 'strong-bullish' : j.dir === '跌' ? 'strong-bearish' : 'neutral';
    v.textContent = j.verdict;
    v.className = 'score-value sameday-verdict ' + cls;
    v.title = `长期综合分 ${j.score} / 100 · 置信度${j.confidence} · 判断：${j.verdict}`;
    d.textContent = `中长期走势 · 综合分 ${j.score > 0 ? '+' : ''}${j.score}/100 · 置信度${j.confidence}${j.industry ? ' · ' + j.industry : ''}`;
    if (conf) {
      const confCls = j.confidence === '高' ? 'conf-high' : j.confidence === '中' ? 'conf-mid' : 'conf-low';
      conf.className = 'sameday-badge ' + confCls;
      conf.textContent = j.confidence + '置信';
    }
    if (note) {
      note.className = 'sameday-accuracy';
      note.textContent = j.autoUpdated ? '🔄 每次打开自动联网更新 · 暂不核算准确率' : '暂不核算准确率';
    }
    if (btn) {
      btn.style.display = '';
      // 用 cloneNode 彻底清除旧点击监听器，避免切换股票后点击逻辑框仍显示上一只股票数据
      const freshBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(freshBtn, btn);
      freshBtn.addEventListener('click', () => this._toggleLongTermLogic(j, symbol));
    }
    if (logic) { logic.style.display = 'none'; logic.innerHTML = ''; }
  },

  _toggleLongTermLogic(j, symbol) {
    const logic = document.getElementById('longtermLogic');
    if (!logic) return;
    if (logic.style.display === 'none') {
      logic.innerHTML = this._renderLongTermLogicHtml(j, symbol);
      logic.style.display = '';
      const refresh = logic.querySelector('#longtermRefreshBtn');
      if (refresh) refresh.addEventListener('click', async () => {
        refresh.disabled = true;
        refresh.textContent = '重新分析中…';
        try {
          const name = this.currentData?.name || '';
          const resp = await fetch(`/api/long-term-judgment/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name)}&refresh=1`);
          const data = await resp.json();
          if (data && data.success !== false && data.judgment) {
            this.renderLongTermJudgment(data.judgment, symbol);
            logic.innerHTML = this._renderLongTermLogicHtml(data.judgment, symbol);
            const rb = logic.querySelector('#longtermRefreshBtn');
            if (rb) rb.addEventListener('click', async () => {
              const n2 = this.currentData?.name || '';
              const r2 = await fetch(`/api/long-term-judgment/${encodeURIComponent(symbol)}?name=${encodeURIComponent(n2)}&refresh=1`);
              const d2 = await r2.json();
              if (d2 && d2.success !== false && d2.judgment) {
                this.renderLongTermJudgment(d2.judgment, symbol);
                logic.innerHTML = this._renderLongTermLogicHtml(d2.judgment, symbol);
              }
            });
          }
        } catch (e) {
          refresh.textContent = '重试';
        } finally {
          refresh.disabled = false;
        }
      });
    } else {
      logic.style.display = 'none';
    }
  },

  _renderLongTermLogicHtml(j, symbol) {
    const factors = (j.factors || []).filter(f => f.applicable);
    const rows = factors.map(f => {
      // 箭头文字与颜色均由影响程度评分统一决定：利好=红「看多」/ 利空=绿「看空」/ 中性=灰
      const imp = this._impactOf(f);
      const arrow = imp > 0 ? '▲ 看多' : imp < 0 ? '▼ 看空' : '— 中性';
      const signCls = imp > 0 ? 'pos' : imp < 0 ? 'neg' : 'neu';
      return `<div class="sd-factor">
        <div class="sd-factor-head">
          <span class="sd-factor-name">${this._factorNameHtml(f)}</span>
          <span class="sd-factor-signal ${signCls}">${arrow}</span>
          <span class="sd-factor-w">权重 ${(f.effectiveWeight * 100).toFixed(0)}%</span>
        </div>
        <div class="sd-factor-detail">${this._dirColorize(f.detail)}</div>
        <div class="sd-factor-val">取值：${this._dirColorize(String(f.value))}</div>
      </div>`;
    }).join('');
    return `<div class="sd-logic-box">
      <div class="sd-logic-title">长期判断逻辑（${j.horizonLabel || '中长期'}：${j.dir === '涨' ? '看多' : j.dir === '跌' ? '看空' : '中性'}，综合分 ${j.score > 0 ? '+' : ''}${j.score}/100，置信度${j.confidence}）</div>
      ${rows}
      <div class="sd-weight-note">长期判断不核算准确率，每次打开工作台即时重算；对标期货不适用时不参与打分。数据缺失的因子按 signal=0 占位但仍计入归一化，会摊薄有效因子权重。</div>
      <div class="sd-actions">
        <button class="ai-trigger-btn" id="longtermRefreshBtn" type="button">重新分析</button>
      </div>
    </div>`;
  },



  async _loadAspectBrief(symbol, name, industry) {
    const v = document.getElementById('aspectValue');
    const d = document.getElementById('aspectDetail');
    if (!v || !d) return;
    // 20260904a：先查用户手动设的主项（localStorage 里的笔记 mainFor:true）；
    // 有主项时优先展示用户选的，否则回退到 AI 接口的第一条。
    let userHL = null, userRK = null;
    try {
      const all = (Notes && Notes.notes) || [];
      const forStock = all.filter(n => n.scope === symbol && (n.aspect === 'highlight' || n.aspect === 'risk'));
      userHL = forStock.find(n => n.aspect === 'highlight' && n.mainFor) || null;
      userRK = forStock.find(n => n.aspect === 'risk' && n.mainFor) || null;
    } catch {}

    if (userHL || userRK) {
      const hlTxt = (userHL && userHL.content) ? String(userHL.content).slice(0, 70) : '—';
      const rkTxt = (userRK && userRK.content) ? String(userRK.content).slice(0, 70) : '—';
      v.innerHTML = `<div class="asp-hl">✅ ${this.escapeHtml(hlTxt)}</div><div class="asp-rk">⚠️ ${this.escapeHtml(rkTxt)}</div>`;
      v.className = 'score-value aspect';
      const dt = userHL ? new Date(userHL.date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      d.textContent = `⭐ 用户手动指定${dt ? '（' + dt + '）' : ''}`;
      return;
    }

    try {
      const resp = await fetch(`/api/ai/aspects/${encodeURIComponent(symbol)}`);
      const data = await resp.json();
      if (this.overviewExtraSymbol !== symbol) return;
      if (!data || data.success === false || !Array.isArray(data.highlights) || !Array.isArray(data.risks)) {
        v.innerHTML = '<span class="asp-empty">尚未生成</span>';
        v.className = 'score-value aspect neutral';
        // 20261016b（审计 H2）：原仅提示「点个股页某按钮」，概览卡内无入口，用户常无从下手。
        // 改为在本卡内直接给一个生成按钮（POST /api/ai/aspects），失败时如实回显原因。
        d.innerHTML = '<span class="asp-gen-hint">尚未生成 · </span>'
          + `<button type="button" class="asp-gen-btn" id="aspectGenBtn">立即生成</button>`;
        const genBtn = document.getElementById('aspectGenBtn');
        if (genBtn) {
          genBtn.addEventListener('click', async () => {
            genBtn.disabled = true;
            genBtn.textContent = '生成中…';
            d.innerHTML = '<span class="asp-gen-hint">AI 联网生成中，通常需要数秒…</span>';
            try {
              const r = await fetch('/api/ai/aspects', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol, stockName: name, industry: industry || '' })
              });
              const j = await r.json();
              if (j && j.success !== false) {
                await this._loadAspectBrief(symbol, name, industry);
              } else {
                d.innerHTML = `<span class="asp-gen-hint">⚠️ 生成失败：${this.escapeHtml((j && (j.message || j.error)) || '未知原因')}</span>`;
              }
            } catch (err) {
              d.innerHTML = `<span class="asp-gen-hint">⚠️ 生成异常：${this.escapeHtml(err.message || '网络错误')}</span>`;
            }
          });
        }
        return;
      }
      // 20260904a：亮点/雷点可能是 {text,outdated} 对象或字符串（向后兼容）
      const _asText = (x) => (x && typeof x === 'object' && x.text != null) ? String(x.text) : (x == null ? '' : String(x));
      const hl = _asText(data.highlights[0]).slice(0, 70);
      const rk = _asText(data.risks[0]).slice(0, 70);
      v.innerHTML = `<div class="asp-hl">✅ ${this.escapeHtml(hl) || '—'}</div><div class="asp-rk">⚠️ ${this.escapeHtml(rk) || '—'}</div>`;
      v.className = 'score-value aspect';
      const dt = data.date ? new Date(data.date).toISOString().slice(0, 10) : '';
      const latestLabel = data.latestReportLabel ? ` · 最新报告期 ${data.latestReportLabel}` : '';
      // 20261016b（审计 H1）：缓存无 TTL 校验、永不过期，旧结论会被当成当天观点展示。
      // 按「数据最新性」铁律如实标注：距生成日超过 7 天即加过期提示（不改变展示内容本身）。
      let staleTip = '';
      if (dt) {
        const ageDays = Math.floor((Date.now() - new Date(dt + 'T00:00:00').getTime()) / 86400000);
        if (Number.isFinite(ageDays) && ageDays > 7) staleTip = ` · ⚠️ 已过期（生成于 ${ageDays} 天前）`;
      }
      d.textContent = `来源：AI 联网生成${dt ? '（' + dt + '）' : ''}${latestLabel}${staleTip}`;
    } catch (e) {
      if (this.overviewExtraSymbol !== symbol) return;
      v.innerHTML = '<span class="asp-empty">加载失败</span>';
      v.className = 'score-value aspect neutral';
      d.textContent = 'AI 亮点/雷点加载失败';
    }
  },

  // ---- 个股近期热点追踪与分析（20260826g） ----
  // 注意：必须显式接收 symbol/name，不可读 this.currentData?.name——
  // 切换股票时 this.currentData 可能残留上一只股票的数据，导致 name 与 symbol 错配
  // （曾出现 600460 配「长江证券」，AI 全部证据检索基于错误公司，整卡不可信）
  async loadHotTopics(symbol, name) {
    if (!symbol) return;
    this.hotTopicsSymbol = symbol;
    try {
      const resp = await fetch(`/api/hot-topics/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name || '')}`);
      const data = await resp.json();
      if (this.hotTopicsSymbol !== symbol) return; // 已切换股票，丢弃
      this.renderHotTopics(data);
    } catch (e) {
      if (this.hotTopicsSymbol !== symbol) return;
      const empty = document.getElementById('hotTopicsEmpty');
      if (empty) { empty.textContent = '热点追踪加载失败'; empty.style.display = ''; }
    }
  },

  renderHotTopics(data) {
    if (!data) return;
    const analysisEl = document.getElementById('hotTopicsAnalysis');
    const dateEl = document.getElementById('hotTopicsDate');
    const emptyEl = document.getElementById('hotTopicsEmpty');
    if (!analysisEl) return;

    // 状态行
    if (dateEl) {
      if (data.analysis && data.analysis.date) dateEl.textContent = '更新于 ' + data.analysis.date;
      else if (!data.hasKey) dateEl.textContent = '（未配置 AI Key）';
      else dateEl.textContent = '';
    }

    if (!data.analysis) {
      if (emptyEl) {
        emptyEl.style.display = '';
        emptyEl.textContent = data.hasKey
          ? '正在联网分析该股的网络讨论热点…'
          : '未配置 AI API Key，无法联网分析。请在「AI 设置」中配置 Key。';
      }
      analysisEl.innerHTML = '';
      return;
    }
    if (emptyEl) emptyEl.style.display = 'none';

    const a = data.analysis;
    // 20260913f：股吧讨论热度/焦点帖（确定性摘要，与「舆情与讨论热度（个股）」因子同一数据源），
    // 单独一行置顶展示，避免 LLM 综述遗漏或否认「无热议话题」时卡片信息缺失/与舆情卡打架。
    const discStrip = (a.discussion && a.discussion.digest)
      ? `<div class="ht-discussion"><span class="ht-disc-label">📌 股吧讨论热度</span><span class="ht-disc-text">${this.escapeHtml(a.discussion.digest)}</span></div>`
      : '';
    let html = discStrip;

    if (a.mode === 'priceChange') {
      // 模式一：当日异动归因（涨跌幅 ≥3% 或 振幅 >3%，20261013g）
      const up = a.changePct > 0;
      const sign = up ? '+' : '';
      const cls = up ? 'ht-pc-up' : 'ht-pc-down';
      const src = Array.isArray(a.sources) && a.sources.length ? '参考来源：' + a.sources.map(s => this.escapeHtml(s)).join('、') : '';
      const cachedTag = a.cached ? '<span class="ht-cached">（今日已分析）</span>' : '';
      // 20261013g：触发来源角标——涨跌幅触发显示涨跌幅；振幅触发（收盘平盘但盘中震荡大）额外显示振幅
      const ampTxt = (a.amplitude != null && a.amplitude > 0) ? `<span class="ht-pc-amp">振幅 ${a.amplitude.toFixed(2)}%</span>` : '';
      html += `<div class="ht-price-change ${cls}">`;
      html += `<div class="ht-pc-head">🔥 当日异动归因 <span class="ht-pc-pct">${sign}${a.changePct.toFixed(2)}%</span>${ampTxt}${cachedTag}</div>`;
      html += `<div class="ht-pc-analysis">${this.escapeHtml(a.analysis || '')}</div>`;
      if (src) html += `<div class="ht-pc-sources">${src}</div>`;
      html += `</div>`;
    } else if (a.mode === 'trending') {
      // 模式二：网络热议话题（涨跌幅 <3% 且振幅 ≤3%，20261013g）
      const src = Array.isArray(a.sources) && a.sources.length ? '参考来源：' + a.sources.map(s => this.escapeHtml(s)).join('、') : '';
      const cachedTag = a.cached ? '<span class="ht-cached">（今日已分析）</span>' : '';
      html += `<div class="ht-trending">`;
      html += `<div class="ht-trend-head">🌐 网络热议话题 <span class="ht-trend-count">${Array.isArray(a.topics) ? a.topics.length : 0} 个</span>${cachedTag}</div>`;
      if (a.content) html += `<div class="ht-trend-summary">${this.escapeHtml(a.content)}</div>`;
      if (Array.isArray(a.topics) && a.topics.length) {
        html += '<div class="ht-topic-list">';
        a.topics.forEach(t => {
          const sentCls = { '利好': 'pos', '利空': 'neg', '中性': 'neu', '未知': 'unk' }[t.sentiment] || 'unk';
          html += `<div class="ht-topic-item">
            <div class="ht-topic-head">
              <span class="ht-topic-kw">${this.escapeHtml(t.keyword || '')}</span>
              <span class="ht-topic-heat heat-${t.heat}">${t.heat}热度</span>
              <span class="ht-topic-sent ${sentCls}">${t.sentiment}</span>
            </div>
            ${t.desc ? `<div class="ht-topic-desc">${this.escapeHtml(t.desc)}</div>` : ''}
          </div>`;
        });
        html += '</div>';
      }
      if (src) html += `<div class="ht-pc-sources">${src}</div>`;
      html += `</div>`;
    }

    // 20260923h：投资者问答子卡（沪市→上证e互动 / 深市→巨潮互动易，与「个股近期热点」同一数据源）
    // 无问答/获取失败时如实标注原因，不静默隐藏（诚实降级）
    const irm = a.irmQa;
    if (irm) {
      if (irm.ok && Array.isArray(irm.posts) && irm.posts.length) {
        const shownAnswered = irm.posts.filter(p => p.answered).length;
        const total = Number(irm.count) || irm.posts.length;
        const cntTxt = `${irm.posts.length} 条问答` +
          (shownAnswered ? `，其中 ${shownAnswered} 条已回复` : '（暂未获回复）') +
          (total > irm.posts.length ? `（平台近期共 ${total} 条）` : '') +
          (irm.unansweredList ? '·均为未回复提问' : '');
        const srcTag = irm.source ? `<span class="ht-irm-src">${this.escapeHtml(irm.source)}</span>` : '';
        html += `<div class="ht-irm"><div class="ht-irm-head">💬 投资者问答 ${srcTag}<span class="ht-irm-count">${cntTxt}</span></div><div class="ht-irm-list">`;
        irm.posts.forEach(p => {
          const time = p.askTime ? `<span class="ht-irm-time">${this.escapeHtml(p.askTime)}</span>` : '';
          html += `<div class="ht-irm-item">
            <div class="ht-irm-q"><span class="ht-irm-q-tag">问</span>${this.escapeHtml(p.question || '')}${time}</div>
            ${p.answer
              ? `<div class="ht-irm-a"><span class="ht-irm-a-tag">答</span>${this.escapeHtml(p.answer)}</div>`
              : `<div class="ht-irm-a ht-irm-a-none"><span class="ht-irm-a-tag">答</span>公司暂未回复</div>`}
          </div>`;
        });
        html += `</div></div>`;
      } else if (irm.note) {
        const srcTag = irm.source ? `<span class="ht-irm-src">${this.escapeHtml(irm.source)}</span>` : '';
        html += `<div class="ht-irm"><div class="ht-irm-head">💬 投资者问答 ${srcTag}</div>`
          + `<div class="ht-irm-note">${this.escapeHtml(irm.note)}</div></div>`;
      }
    }

    analysisEl.innerHTML = html;
  },

  async refreshHotTopics() {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const name = this.currentData?.name || '';
    const empty = document.getElementById('hotTopicsEmpty');
    if (empty) { empty.style.display = ''; empty.textContent = '正在重新联网分析…'; }
    try {
      const resp = await fetch(`/api/hot-topics/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name || '')}&refresh=1`);
      const data = await resp.json();
      if (this.hotTopicsSymbol !== symbol) return; // 已切换股票，丢弃
      this.renderHotTopics(data);
    } catch (e) {
      if (this.hotTopicsSymbol !== symbol) return;
      const empty2 = document.getElementById('hotTopicsEmpty');
      if (empty2) { empty2.style.display = ''; empty2.textContent = '重新分析失败'; }
    }
  },

  // 打开个股页时自动读取并渲染已存的 AI 联网补全（不联网）
  async loadAICache() {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const body = document.getElementById('aiAugmentBody');
    if (!body) return;
    // 切换股票后若已被其他逻辑覆盖，放弃本次异步结果
    try {
      const resp = await fetch(`/api/ai/augment/${encodeURIComponent(symbol)}`);
      const data = await resp.json();
      if (this.currentSymbol !== symbol) return; // 已切换到别的股票
      if (data.success && data.cached && data.content) {
        this.renderAIAugment(data);
      } else {
        // 无缓存：保持提示态
        body.innerHTML = '<div class="ai-empty">点击上方「一键补全」，让 AI 联网搜索 <b>' + this.escapeHtml(symbol) + '</b> 的近期资料（搜索一次后将长期留存，不再重复联网）。</div>';
      }
    } catch {
      body.innerHTML = '<div class="ai-empty">点击上方「一键补全」，让 AI 联网搜索 <b>' + this.escapeHtml(symbol) + '</b> 的近期资料。</div>';
    }
  },

  // 仅更新头部「价格 / 涨跌幅 / 行情日期+时间」——打开页面时渲染与 60s 实时刷新共用同一段逻辑，
  // 保证头部价格口径单点，不会出现「渲染」与「刷新」两套格式。
  applyLiveQuote(quote, market) {
    if (!quote) return;
    const priceEl = document.getElementById('stockPrice');
    const changeEl = document.getElementById('stockChange');
    const dateEl = document.getElementById('stockDate');

    if (priceEl) priceEl.textContent = quote.price ? (market === 'US' ? '$' : market === 'HK' ? 'HK$' : '¥') + Storage.formatNumber(quote.price) : '--';

    if (changeEl && quote.changePct !== undefined) {
      const isUp = quote.change >= 0;
      changeEl.textContent = `${isUp ? '+' : ''}${Storage.formatNumber(quote.change)} (${Storage.formatPercent(quote.changePct)})`;
      changeEl.className = 'stock-change ' + (isUp ? 'up' : 'down') + this.boldClass(quote.changePct);
      if (priceEl) priceEl.style.color = isUp ? 'var(--red)' : 'var(--green)';
    }

    // 标注行情日期/时间，方便了解这是哪一刻的股价
    // 20261016b（审计 S6）：服务端未返回可解析日期时 date 为本机日期，旧版静默展示易被误读为真实交易日，此处如实标注。
    if (dateEl) {
      const d = quote.date || '';
      dateEl.textContent = d ? (quote.time ? `${d} ${quote.time}` : d) : '—';
      if (d && quote.dateFallback === true) {
        dateEl.textContent += ' ⚠️ 日期解析失败，显示为本机日期';
        dateEl.title = '行情接口未返回可解析的交易日，此处显示的是本机系统日期，非真实交易日';
      }
    }

    // 20261101n（用户两张截图指令）：换手率/成交额从页首固定指标条移入个股标题卡信息行，
    // 与行情日期/财务报告期同行展示；applyLiveQuote 为打开页面渲染与 60s 实时刷新的共用单点，
    // 两值随行情同步更新。US/HK 口径同源（quote.turnover/quote.amount，缺失时整段隐藏）。
    const turnEl = document.getElementById('stockTurnover');
    const amtEl = document.getElementById('stockAmount');
    if (turnEl) {
      if (quote.turnover) {
        turnEl.textContent = Storage.formatNumber(quote.turnover) + '%';
        turnEl.style.display = '';
      } else {
        turnEl.style.display = 'none';
      }
    }
    // 20261106d（用户截图指令）：换手率之后补「量比」。数据源 = 腾讯行情原生字段 quote.volumeRatio
    // （当日成交量 ÷ 前5日均量，基准不含当日），与量能引擎 volumeState.ratio5 同源
    // （ratio5Basis='tencent_quote' 时数值一致）。盘中为半天累计量、收盘后定论；
    // 字段缺失或非正数时整段隐藏，不用均值反推、不编造。
    const vrEl = document.getElementById('stockVolRatio');
    if (vrEl) {
      if (typeof quote.volumeRatio === 'number' && isFinite(quote.volumeRatio) && quote.volumeRatio > 0) {
        vrEl.textContent = quote.volumeRatio.toFixed(2);
        vrEl.title = `量比 = 当日成交量 ÷ 前5日均量（基准不含当日）= ${quote.volumeRatio.toFixed(2)}；小于1为缩量、大于1为放量。腾讯行情口径，盘中为半天累计量、收盘后定论；与量能引擎 volumeState.ratio5 同源（20261106l 起「5日量能比」卡退役，本 banner 为 ÷5 口径唯一展示处）`;
        vrEl.style.display = '';
      } else {
        vrEl.style.display = 'none';
      }
    }
    if (amtEl) {
      if (quote.amount) {
        amtEl.textContent = Storage.formatNumber(quote.amount);
        amtEl.style.display = '';
      } else {
        amtEl.style.display = 'none';
      }
    }
  },

  renderStockHeader(data) {
    const { quote, name, symbol, market } = data;

    document.getElementById('stockName').textContent = name;
    document.getElementById('stockCode').textContent = symbol;
    document.getElementById('stockMarket').textContent = this.marketLabel(market);

    if (quote) {
      this.applyLiveQuote(quote, market);

      // 标注财务数据报告期：PE/PB 等所用的每股收益、每股净资产来自该报告期
      const finEl = document.getElementById('stockFinDate');
      if (finEl) {
        const rep = quote.fundamentals?.reportDate;
        const repPeriod = quote.fundamentals?.reportPeriod;
        if (rep) {
          finEl.textContent = repPeriod || rep;
          finEl.title = 'PB 所用每股净资产来自该报告期（MRQ）；PE(TTM)/PS(TTM)/ROE(TTM) 为滚动12个月口径，随行情更新，不绑定财报期';
        } else {
          finEl.textContent = '';
          finEl.removeAttribute('title');
        }
      }
    }
  },

  marketLabel(market) {
    const labels = { CN: 'A股', HK: '港股', US: '美股' };
    return labels[market] || market || '';
  },

  // 20261104b：增长口径切换按钮文案（'sq'=单季优先 / 'cum'=累计；未知值按单季显示）
  setGrowthCaliberBtn(caliber) {
    const btn = document.getElementById('growthCaliberBtn');
    if (btn) btn.textContent = caliber === 'cum' ? '口径：累计' : '口径：单季';
  },

  renderKeyMetrics(data) {
    const { quote } = data;
    const container = document.getElementById('keyMetrics');
    const metrics = [];
    const f = quote?.fundamentals || {};
    // ★ 20261015e：顶栏 PE/PB/PS/ROE 与「基本面·关键财务指标」联动——
    //   数值优先取 fundamental.metrics（基本面左卡同一权威口径，杜绝两处分裂）；
    //   着色复用 evaluateSignals 的利好/利空信号：利好=红、利空=绿（与左卡 sig-bull/sig-bear 同一判定），
    //   判定依据追加进 title，鼠标悬停可见。
    const fm = (data.fundamental && !data.fundamental.error && data.fundamental.metrics) || {};
    const sigMap = {};
    (data.signals?.signals || []).forEach(s => { sigMap[s.key] = s; });
    // ★ 20261103d：五维多数决统一判定（用户指令）——右卡「指标分析」judgment 已按多数决覆盖，
    //   顶栏 tiles 与左卡徽标/右卡三处消费同一 judgment（单一数据源，杜绝「五维利空 vs 总体利好」打架）。
    (data.metricAnalysis?.metrics || []).forEach(mm => { if (mm && mm.key && mm.judgment) sigMap[mm.key] = mm.judgment; });
    const sigColor = (key) => {
      const s = sigMap[key];
      if (!s) return '';
      return s.signal === 'bull' ? 'red' : s.signal === 'bear' ? 'green' : '';
    };
    const sigNote = (key) => {
      const s = sigMap[key];
      if (!s || !s.reason) return '';
      const tag = s.signal === 'bull' ? '利好' : s.signal === 'bear' ? '利空' : '中性';
      return ` · 信号判定（${tag}）：${String(s.reason).replace(/"/g, '&quot;')}`;
    };
    const repDate = f.reportDate;
    const repPeriod = f.reportPeriod;
    const finLabel = repPeriod || repDate || '';
    const priceDate = quote?.date || '—';
    const priceTime = quote?.time || '';
    const priceDateTime = priceDate + (priceTime ? ` ${priceTime}` : '');

    if (quote) {
      // Real-time quote metrics (跟随行情每日更新)
      const priceSrc = '腾讯行情';
      const prevClose = quote.prevClose || 0;
      const quoteColor = (v) => v > prevClose ? 'red' : (v < prevClose ? 'green' : '');
      const quoteSub = `行情 ${priceDateTime}`;
      if (quote.high) metrics.push({ label: '最高', value: Storage.formatNumber(quote.high), source: priceSrc, sub: quoteSub, valueColor: quoteColor(quote.high), title: `当日最高价 · 来源：${priceSrc} · ${quoteSub}` });
      if (quote.low) metrics.push({ label: '最低', value: Storage.formatNumber(quote.low), source: priceSrc, sub: quoteSub, valueColor: quoteColor(quote.low), title: `当日最低价 · 来源：${priceSrc} · ${quoteSub}` });
      if (quote.open) metrics.push({ label: '开盘', value: Storage.formatNumber(quote.open), source: priceSrc, sub: quoteSub, valueColor: quoteColor(quote.open), title: `当日开盘价 · 来源：${priceSrc} · ${quoteSub}` });
      if (quote.prevClose) metrics.push({ label: '昨收', value: Storage.formatNumber(quote.prevClose), source: priceSrc, sub: quoteSub, title: `昨日收盘价 · 来源：${priceSrc} · ${quoteSub}` });
      // 20261101n（用户两张截图指令）：「换手率」「成交额」tile 从本指标条删除，
      // 数据移至个股标题卡信息行（#stockTurnover/#stockAmount，applyLiveQuote 同点刷新）。
      if (quote.totalValue) metrics.push({ label: '总市值', value: Storage.formatNumber(quote.totalValue) + (this.currentData?.market === 'US' ? '亿美元' : '亿'), source: priceSrc, sub: quoteSub, title: `总市值 · 来源：${priceSrc} · ${quoteSub}` });

      // Valuation / fundamental metrics (with type, source and report period)
      // ★ 20261015e：数值优先 fundamental.metrics（与基本面「关键财务指标」同源同值），
      //   并按 signals 信号着色：利好=红(red)、利空=绿(green)、中性=默认白色。
      const peVal = fm.pe || f.pe || quote.pe;
      if (peVal) metrics.push({
        label: '市盈率(TTM)',
        value: Storage.formatNumber(peVal),
        source: f.peSource || '行情数据',
        sub: `股价 ${priceDate} · TTM 随行情更新`,
        valueColor: sigColor('pe'),
        title: `PE(TTM) = 总市值 ÷ 近12个月归母净利（滚动12个月，随行情每日更新，不绑定某一财报期） · 来源：${f.peSource || '行情数据'}${sigNote('pe')}`
      });
      const pbVal = fm.pb || f.pb || quote.pb;
      if (pbVal) metrics.push({
        label: '市净率(PB)',
        value: Storage.formatNumber(pbVal),
        source: f.pbSource || '行情数据',
        sub: finLabel ? `股价 ${priceDate} · 财报 ${finLabel}` : `股价 ${priceDate}`,
        valueColor: sigColor('pb'),
        title: finLabel ? `PB = 股价(${priceDate}) ÷ 每股净资产(财报 ${finLabel}) · 来源：${f.pbSource || '行情数据'}${sigNote('pb')}` : '市净率 PB'
      });
      const psVal = fm.ps || f.ps;
      if (psVal) {
        // 20260909j 审计：PS 主口径为东财 PS_TTM（真 TTM）；本地兜底（总市值÷最新一期营收）为单期口径，须分开标注避免假 TTM
        const psIsTtm = f.psSource && String(f.psSource).indexOf('PS_TTM') >= 0;
        metrics.push({
          label: psIsTtm ? '市销率(PS·TTM)' : '市销率(PS)',
          value: Storage.formatNumber(psVal),
          source: f.psSource || '本地计算',
          sub: psIsTtm
            ? `总市值(行情 ${priceDate}) ÷ 近12个月营收`
            : (finLabel ? `总市值(行情 ${priceDate}) ÷ 营收(财报 ${finLabel}，单期)` : `总市值(行情 ${priceDate}) ÷ 营收`),
          valueColor: sigColor('ps'),
          title: (psIsTtm
            ? `PS(TTM) = 总市值(行情 ${priceDate}) ÷ 近12个月营业收入（滚动12个月，随行情更新） · 来源：${f.psSource || '本地计算'}`
            : `PS = 总市值(行情 ${priceDate}) ÷ 最新一期营业收入(财报 ${finLabel}，单期口径非TTM) · 来源：${f.psSource || '本地计算'}`) + sigNote('ps')
        });
      }
      // ROE：优先 TTM（与基本面左卡 metrics.roe 同口径），回退最新披露期值
      const roeVal = f.roeTtm != null ? f.roeTtm : (typeof fm.roe === 'number' ? fm.roe : f.roe);
      if (roeVal != null) metrics.push({
        label: '净资产收益率(ROE)',
        value: Storage.formatNumber(roeVal) + '%',
        source: f.roeSource || '财报数据',
        sub: f.roeTtm != null ? `TTM（截至 ${priceDate}）` : (finLabel ? `财报 ${finLabel}` : ''),
        valueColor: sigColor('roe'),
        title: (f.roeTtm != null
          ? `ROE(TTM) = 近12个月归母净利 ÷ 期末归母净资产（滚动12个月，与关键财务指标页/深度分析同源） · 来源：${f.roeSource || '财报数据'}`
          : `ROE = 归母净利润 ÷ 净资产(财报 ${finLabel}) · 来源：${f.roeSource || '财报数据'}`) + sigNote('roe')
      });
    }

    container.innerHTML = metrics.map(m => `
      <div class="metric-item"${m.title ? ` title="${m.title}"` : ''}>
        <div class="metric-label">${m.label}</div>
        <div class="metric-value ${m.valueColor || ''}">${m.value}</div>
        ${m.sub ? `<div class="metric-sub">${m.sub}</div>` : ''}
        ${m.source ? `<div class="metric-source">来源：${m.source}</div>` : ''}
      </div>
    `).join('');
  },

  renderScores(data) {
    // Technical score
    const techScore = data.technical?.techScore || '--';
    const techEl = document.getElementById('techScore');
    techEl.textContent = techScore;
    techEl.className = 'score-value ' + this.scoreClass(techScore, 'tech');
    document.getElementById('techScoreDetail').textContent = data.technical?.signals?.trend || '';

    // Fundamental score
    const fundScore = data.fundamental?.overall || '--';
    const fundEl = document.getElementById('fundScore');
    fundEl.textContent = fundScore + (data.fundamental?.score ? ` (${data.fundamental.score}/100)` : '');
    fundEl.className = 'score-value ' + this.scoreClass(fundScore, 'fund');
    document.getElementById('fundScoreDetail').textContent = data.fundamental?.rating || '';

    // Capital activity score：资金量能加载前显示占位，加载后由 loadCapitalFlow 更新
    const capEl = document.getElementById('capitalScore');
    capEl.textContent = '--';
    capEl.className = 'score-value neutral';
    document.getElementById('capitalScoreDetail').textContent = '资金量能加载后更新';

    // 保存可追溯数据，供"查看计算"面板使用（issue7）
    this.scoreTraceData = {
      technical: {
        techScore,
        trendScore: data.technical?.trendScore,
        signals: data.technical?.signals,
      },
      fundamental: data.fundamental,
      capital: null,
    };
  },

  // 根据资金量能数据计算并渲染资金热度评分
  renderCapitalScore(data) {
    const result = typeof CapitalCharts !== 'undefined' ? CapitalCharts.calculateScore(data) : null;
    const capEl = document.getElementById('capitalScore');
    const capDetail = document.getElementById('capitalScoreDetail');
    if (!capEl || !result) return;

    capEl.textContent = result.score;
    capEl.className = 'score-value ' + result.className;
    if (capDetail) capDetail.textContent = result.grade;

    if (this.scoreTraceData) {
      this.scoreTraceData.capital = result;
    } else {
      this.scoreTraceData = { capital: result };
    }
  },

  // 20261017f：量能分析引擎渲染（lib/volumeEngine.js，spec 十三步链路 + 7.4/7.5/11.2-11.4 归集）。
  // 口径约束：红涨绿跌；仅客观分析标签（后端已做禁交易指令扫描，此处转义防注入）；
  // 数据不足/样本不足如实展示，不伪造；引擎失败不影响其他资金量能维度。
  // 20261017f 新增：三个强制归集总结卡片（位置量价/常见矛盾信号/量比实战口诀），
  // 无论是否命中逐条完整输出，未命中=灰、数据不足=琥珀、命中按多空语义配色。
  renderVolumeEngine(data) {
    const el = document.getElementById('capVolumeEngine');
    if (!el) return;
    const ve = data && data.volumeEngine;
    if (!ve) {
      el.innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">量能分析引擎暂不可用（数据源异常），不影响上方资金量能维度</p>';
      return;
    }
    if (ve.ok === false) {
      el.innerHTML = `<p style="color:var(--text-secondary);text-align:center;padding:20px;">${this._veEsc(ve.error || '量能分析数据不足')}</p>`;
      return;
    }
    const esc = (s) => this._veEsc(s);
    const num = (v, d = 2) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : '--');
    // 20261106f：「20日涨跌日量能比」数值解读下拉面板。展开状态在静默轮询 innerHTML 全量重建前读取、
    // 重建后原样恢复，避免每 60s 刷新把用户点开的面板自动收起（20261104j 轮询渲染铁律同源）。
    // 规则与文案的单一真值源 = capitalCharts.js 的 VpRatioInterpret（同页先加载）。
    const interpretOpen = !!el.querySelector('.cm-interpret-panel:not([hidden])');
    const interpretTrigger = VpRatioInterpret.buildTrigger(interpretOpen);

    // 量能指标行
    // 20261106l（用户裁决）：「5日量能比」卡退役——÷前5日均量口径由顶部 banner「量比」（腾讯行情直采）
    // 继续展示；volumeState.ratio5/level API 字段保留（引擎内部判据 + banner 同源），仅前端不再单独占格。
    const pos = ve.position || {};
    // 20261106e（用户裁决「换回60日卡」）：第 3 格恢复「60日量能确认」（历史决策留档）。
    // 20261106k（用户裁决）：「60日量能确认」卡整卡退役——60 日 confirm 口径的数据与引擎语义
    // （生死位五规则、四维度「量能状态」、capitalFlow 资金行为文案、风险标签）全部保留，
    // 仅前端展示层不再单独占格；口径在下方 135 格综合判定卡「口径说明」中披露。
    // 「5日量能比」新名与 20261106d 其余四项改动（日均资金/涨跌日着色/量比 banner）保持不变。
    // [20261024d] 括号内说明文字缩小一号（用户 2026-10-24 要求）：包 .cm-paren，样式见 style.css。
    // 关键支撑/压力的 kind 内可能自带嵌套括号（如「MA250（上翘）」），外层整体包 span 即可全部继承小字号。
    // 20261101j：四维度「资金行为 / 筹码转移」单一数组字面量（下方指标行与量价配合卡共用，
    // 守卫测试 test_pos_volume_matrix 依赖该字面量）。原「价格位置」tile 由本 tile 替换——
    // 位置信息与下方量价判定·第一步「位置定位」重复，不再单独占格。
    const dim = ve.dimensions || {};
    // 20261103f（用户截图指令）：资金行为/筹码转移按语义方向着色（tone 由引擎输出，bull=红/bear=绿）
    const toneCls = (t) => t === 'bull' ? ' ve-tone-bull' : t === 'bear' ? ' ve-tone-bear' : '';
    const dimTexts = [
      ['资金行为', dim.capitalBehavior], ['筹码转移', dim.chipTransfer],
    ];
    // 20261102c（历史布局决策；卡片名现为「5日量能比 / 60日量能确认」，20261106d+e）：
    // 「资金行为」定性长文本上移至指标行首位（span4），两枚量能卡下移至量价统计行，
    // 与 20 日三张数值卡并列——指标行=定性四维（资金行为/筹码转移/支撑/压力），量价行=量能数值五联。
    const metrics = [
      ['筹码转移', `<span class="cm-value-text${toneCls(dim.chipTransferTone)}">${esc(dimTexts[1][1] || '数据不足')}</span>`],
      ['关键支撑', pos.support && pos.support.price != null ? `${num(pos.support.price)}<span class="cm-paren">（${esc(pos.support.kind)}）</span>` : '--'],
      ['关键压力', pos.resistance && pos.resistance.price != null ? `${num(pos.resistance.price)}<span class="cm-paren">（${esc(pos.resistance.kind)}）</span>` : '--'],
    ];
    const metricsHtml = `<div class="cap-metric ve-span4"><span class="cm-label">资金行为</span><span class="cm-value-text${toneCls(dim.capitalBehaviorTone)}">${esc(dimTexts[0][1] || '数据不足')}</span></div>` + metrics.map(([k, v]) =>
      `<div class="cap-metric"><span class="cm-label">${esc(k)}</span><span class="cm-value">${v}</span></div>`).join('');

    // 20261024i：量价关系分析合并进本卡（原独立「量价关系分析」卡删除）。
    // 去重原则——「量比 / 量能热度」与上方「5日量能比」同源，不再重复展示。
    // 数据缺失时给出明确原因（不整卡空白），上方量能分析照常展示。
    // 20261101j（用户截图指令）：① 量价中间文字说明行（信号徽标 + 长描述）整行删除——
    // 描述与四维度「资金行为」卡同源重复；② 「今日涨跌」卡与页头涨跌幅重复 → 该卡位改放
    // 四维度「资金行为」（原独立小节删除，内容上移至此）；卡片行保持 4 张，布局对称不变。
    // 20261101k（用户截图指令）：量价配合区块标题删除（守卫禁此字面量，注释同理规避）——卡片行紧跟上方指标行，
    // 语义已由各卡 cm-label 自明，无需区块标题；降级说明同理去掉标题（说明文字自含语义）。
    const vi = data && data.volumeIndicators;
    const vp = vi && vi.volumePrice;
    // 20261102c：量能 tile 独立成变量——量价数据不足（vp 缺失）时仍保留 5日量能比，
    // 20 日三卡随量价数据缺失降级（数据诚实：量能引擎数据与 vp 无关，不静默消失）。
    // 20261106c：量能卡可见 .cm-sub 计算方法副行；完整口径放 title。
    // 20261106d：「量能档位」→「5日量能比」（命名直接暴露分母；主值纯比值 ×，定性档位以括号保留）。
    // 20261106e（历史）：第 3 格曾恢复「60日量能确认」；20261106k（用户裁决）该卡退役，
    // 60 日口径转为引擎内部判据（生死位规则/资金行为文案/风险标签），不再单独占格展示。
    // 20261106l（用户裁决）：「5日量能比」卡退役，四联改三联（ve-cols-3）。
    let vpHtml = '';
    if (vp) {
      const nc = typeof vp.netChangePct === 'number' ? vp.netChangePct : null;
      const ncCls = nc == null ? '' : (nc > 0 ? 'cap-pos' : nc < 0 ? 'cap-neg' : '');
      const ratioCls = typeof vp.ratio === 'number' ? (vp.ratio > 1 ? 'cap-pos' : 'cap-neg') : '';
      // 20261106d（用户截图指令）：涨天数 > 跌天数标红、反之标绿、持平/数据不足中性（全站红涨绿跌）。
      const daysCls = (typeof vp.upDays === 'number' && typeof vp.downDays === 'number')
        ? (vp.upDays > vp.downDays ? 'cap-pos' : vp.upDays < vp.downDays ? 'cap-neg' : '') : '';
      const vpDate = (vi.series && Array.isArray(vi.series.dates) && vi.series.dates.length)
        ? vi.series.dates[vi.series.dates.length - 1] : '';
      // 20261102c：量价统计行原五联等宽（ve-cols-5，与原指标行同构）；20261101r：10 列基准栅格沿用。
      // 20261106c（用户截图指令）：「20日涨跌日量能比」上移到第一张量能卡右边，其余卡顺次后移；
      // 20261106k（用户裁决）：「60日量能确认」卡退役，五联改四联（ve-cols-4）；
      // 20261106l（用户裁决）：「5日量能比」卡退役，四联改三联（ve-cols-3）。
      const vpRatioSub = '近20日涨日均量 ÷ 跌日均量';
      const vpRatioTip = `近20日上涨日平均成交量 ÷ 下跌日平均成交量 = ${vp.ratio != null ? vp.ratio : '--'}；≥1.15 视为量价健康（与「量价判定」⑤量价健康度同源）`;
      // 20261106f：触发器在卡片标签行内（不额外占高度），展开面板在数值行下方普通流跨整行，
      // 不用绝对定位浮层 → 不受 .main-content 滚动容器裁剪，也不破坏 ve-cols-3 三列等宽。
      const interpretPanel = VpRatioInterpret.buildPanel(vp, { open: interpretOpen });
      const vpRatioTile = `<div class="cap-metric cm-has-interpret"><span class="cm-label" title="近20日上涨日均量 ÷ 下跌日均量，衡量量价健康度（与「量价判定」⑤量价健康度同源）">20日涨跌日量能比${interpretTrigger}</span><span class="cm-value ${ratioCls}">${vp.ratio != null ? vp.ratio : '--'}<span class="cm-sub" title="${esc(vpRatioTip)}">${esc(vpRatioSub)}</span></span></div>`;
      vpHtml = `
      <div class="ve-tile-row ve-cols-3">
        ${vpRatioTile}
        <div class="cap-metric"><span class="cm-label" title="近20日上涨天数 / 下跌天数；涨天数多于跌天数标红，反之标绿（全站红涨绿跌）">20日涨跌日</span><span class="cm-value ${daysCls}">${vp.upDays != null ? vp.upDays : '--'}天/${vp.downDays != null ? vp.downDays : '--'}天</span></div>
        <div class="cap-metric"><span class="cm-label">20日净涨跌</span><span class="cm-value ${ncCls}">${nc == null ? '--' : (nc > 0 ? '+' : '') + nc + '%'}</span></div>
      </div>
      ${interpretPanel}
      <div class="cap-date-note">量价统计截止 ${esc(vpDate || '--')} · K线 · 本地计算｜口径说明：全量价判定已统一为 当日量 ÷ 20 日均量（与 135 格推演图同源）；本行「20日涨跌日量能比」= 近20日上涨日均量 ÷ 下跌日均量，为显式标注分母的原始指标卡（非量价判定结论），与 ÷20 统一口径分母不同，数值不应相等；「5日量能比」「60日量能确认」已退役——20261106n 起 60 日均量口径整体退役，全量价判定与文字分析统一使用 20 日量能比（当日量 ÷ 20 日均量），5 日均量原始值由顶部「量比」（腾讯行情直采）继续展示</div>`;
    } else {
      // 20261106l：5日量能比退役后降级分支无独立量能卡可保留，仅输出诚实降级说明（不渲染空行）
      vpHtml = `
      <div class="ve-src-notes"><div class="ve-gap-item">· 量价数据不足（可用日K不足 20 根或数据源暂不可用），不影响上方量能分析结论</div></div>`;
    }

    // 四维度客观描述 —— 20261101h 仅保留「资金行为」「筹码转移」两行；
    // 20261101j：独立小节整体删除，两行内容并入上方卡片（指标行「筹码转移」tile +
    // 量价配合行「资金行为」卡，共用 dimTexts 单一数组）。后端 dimensions 四键保留不动
    // （铁律第一条：仅展示层过滤，API 输出格式零变化）。

    // 20261106k（用户裁决）：「生死位规则（五大）」独立卡删除，五规则融合进 135 格综合判定模块——
    // 规则1-4（低位吸筹/高位派发/假突破量能不确认/放量破位）参考天量/地量「异常特例」特殊提醒样式，
    // 命中才显示、带方向色、不挂起主判（与 pj.special 的「综合判定挂起」语义区分）；
    // 规则5「分时无量拉升」作为特殊判定并入信号叠加层（与背离/极端量能/弱方向异动并列）。
    // 引擎 ve.rules 输出与评分链（_classify noBull/observeOnly/forceBear + riskTags）零改动，
    // API 输出格式不变（铁律第一条：仅前端展示层重排）。
    const rules = Array.isArray(ve.rules) ? ve.rules : [];
    const lifeDirTone = { bull: 've-bull', bear: 've-bear', 'bear-block': 've-block' };
    const lifeHits = rules.filter(r => r.matched && r.id !== 5);
    const lifeSpecialHtml = lifeHits.length
      ? `<div class="ve-posj-step ve-posj-anomaly"><span class="ve-posj-step-label">📍 生死位特殊提醒</span><div class="ve-posj-anomaly-list">${lifeHits.map(r =>
          `<div class="ve-posj-anomaly-item"><span class="ve-rule-badge ${lifeDirTone[r.direction] || ''}">${esc(r.name)}${r.partial ? ' · 初步触发' : ' · 命中'}</span><span class="ve-posj-pos-note">${esc(r.conclusion)}</span></div>`).join('')}</div></div>`
      : '';
    // 规则5 分时无量拉升 → 信号叠加层适配项：命中=触发（明细给结论）、未命中=未触发 chip
    const lifeAmpRule = rules.find(r => r.id === 5) || null;
    const lifeAmpSignal = lifeAmpRule
      ? { triggered: !!lifeAmpRule.matched, pending: false, type: lifeAmpRule.matched ? (lifeAmpRule.partial ? '初步触发' : '命中') : null, note: lifeAmpRule.conclusion || '', state: lifeAmpRule.matched ? null : '未触发' }
      : null;

    // 风险标签
    const riskHtml = (ve.riskTags && ve.riskTags.length)
      ? `<div class="ve-risk-row">${ve.riskTags.map(t => `<span class="ve-risk-tag">${esc(t)}</span>`).join('')}</div>` : '';

    // 20261106j：原「位置量价补充（7.4）/ 常见矛盾信号（11.3）/ 量比实战口诀（7.5）/ 预期量能规则」
    // 四张归集卡按用户裁决「引擎级彻底合并」删除——其判定逻辑已并入 135 格推演图（posModel135）
    // 与引擎评分/风险标签（_classify / riskTags / bullSupport 备注），同屏只保留唯一的量价判定模块。
    // 引擎仍计算 pv / contra / exp / ratio 对象供评分与风险标签复用，不再单独输出归集总结卡片。

    // 20261101d：位置感知量价判定主判（图片 24 格矩阵）—— 先定位置 → 量能×涨跌幅 → 判定
    const posHtml = (() => {
      // 20261105f：底层=量价判定模型合并版 v2；20261105f-b UI 重排（用户反馈「输出展示效果非常差」）——
      // ① 锚点参考从第一步行内移出（原右挤竖排块），统一放底部参考表；② 五步判定链从第二步行内移出为独立紧凑区；
      // ③ 信号叠加层未触发时压缩为单行 chips（长说明仅触发卡展开）；④ 三步骤行回归「label + 结果 + 一句话依据」。
      const pj = ve.posJudgment;
      if (!pj) return '';
      const mainCls = (d) => d === 'bull' ? 'bull' : d === 'bear' ? 'bear' : 'observe';
      const pos = pj.position || {};
      const vol = pj.volume || {};
      const pri = pj.price || {};
      const mode = pj.mode || null;
      const grayTxt = mode && mode.gray ? '（灰色地带）' : '';
      // 三步骤行：label + 结果 + 一句话依据（无内嵌子列表）
      const basisShort = (pos.basis || '').replace(/^锚点一（默认判定源）：/, '');
      const stateNote = mode ? (mode.note || '').replace(/^(ADX 未达趋势阈值（或方向不明），|ADX <20，)/, '') : '';
      const step3Note = vol.tier && pri.walk
        ? `<span class="ve-posj-combo-note" title="当日成交量 ÷ 前20日均量，用于 135 格量能归格；盘中为半天累计量，收盘后定论">当日 ${esc(pri.text || '?')}${vol.ratio20 != null ? ` · 当日量/20日均量 ${esc(vol.ratio20)}` : ''}</span>`
        : `<span class="ve-posj-combo-note">${esc(vol.basis || '')}｜涨跌幅 ${esc(pri.text || '数据不足')}</span>`;
      // 20261106c（用户截图指令）：紧跟第三步文案常驻高亮提醒——「当日成交量 ÷ 20日均量」是
      // 收盘后才成立的全日口径，盘中只有半天累计量，无法完成判定；收盘后以全日成交量定论。
      // 这句是口径属性说明（不随当前时间变化），故常驻展示，不引入盘中/收盘条件分支；
      // 与信号叠加层「极端量能·盘中停判」互补：那里说规则停判，这里说数值口径本身不成立。
      const step3CaliberWarn = `<span class="ve-posj-caliber-warn" title="当日成交量 ÷ 20日均量是收盘后才成立的全日口径；盘中数值为半天累计量，与全天量能阈值不可比">注意：「当日成交量 ÷ 20日均量」这个全日口径，盘中无法完成判定，收盘后以全日成交量定论</span>`;
      const stepHtml = `
        <div class="ve-posj-step"><span class="ve-posj-step-label">第一步 · 位置定位</span><span class="ve-posj-pos">${esc(pos.display || '数据不足')}</span><span class="ve-posj-pos-note">${esc(basisShort)}</span></div>
        <div class="ve-posj-step"><span class="ve-posj-step-label">第二步 · 运行状态</span><span class="ve-posj-combo">${mode ? esc((mode.key || '数据不足') + grayTxt) : '数据不足'}</span><span class="ve-posj-pos-note">${esc(stateNote)}</span></div>
        <div class="ve-posj-step"><span class="ve-posj-step-label">第三步 · 量能 × 涨跌幅</span><span class="ve-posj-combo">${vol.tier ? esc(vol.tier) + (vol.extreme ? `（${esc(vol.extreme)}）` : '') + ' + ' + (pri.walk ? esc(pri.walk) : '方向不明') : '量能数据不足'}</span>${step3Note}${step3CaliberWarn}</div>`;
      // 五步判定链：独立紧凑区（单列小字，每行「徽标 + 结论」，可审计）
      const chainHtml = mode && Array.isArray(mode.steps) && mode.steps.length
        ? `<div class="ve-posj-chain"><div class="ve-posj-chain-title">运行状态 · 五步判定链</div>${mode.steps.map(s =>
            `<div class="ve-posj-chain-item"><span class="ve-rule-badge ${s.hit ? '' : 've-miss'}">${esc(s.k)}</span><span class="ve-posj-chain-text">${esc(s.v)}</span></div>`).join('')}</div>`
        : '';
      // 信号叠加层：未触发压缩为单行 chips；任一触发时展开明细（触发卡带 note，未触发卡保持短句）
      const signals = pj.signals || {};
      // 20261106k：规则5「分时无量拉升」作为特殊判定并入信号叠加层（lifeAmp 适配项，数据源 ve.rules id=5）
      const sigGet = (k) => k === 'lifeAmp' ? lifeAmpSignal : signals[k];
      const trigCount = [signals.divergence, signals.extreme, signals.weak, lifeAmpSignal].filter(s => s && (s.triggered || s.pending)).length;
      const SIG_META = [['divergence', '背离'], ['extreme', '极端量能'], ['weak', '弱方向异动'], ['lifeAmp', '分时无量拉升']];
      const sigChip = (k, name) => {
        const it = sigGet(k);
        const t = !it ? '未触发' : (it.pending ? '盘中停判' : it.triggered ? (it.type || '触发') : (it.state === '不予采纳' ? '不予采纳' : '未触发'));
        const cls = it && (it.triggered || it.pending) ? 've-block' : '';
        return `<span class="ve-sig-chip"><span class="ve-rule-badge ${cls}">${esc(t)}</span>${esc(name)}</span>`;
      };
      const sigDetail = (k, name) => {
        const it = sigGet(k);
        if (!it || (!it.triggered && !it.pending)) return '';
        return `<div class="ve-posj-anomaly-item"><span class="ve-rule-badge ve-block">${esc(name)}${it.type ? ' · ' + esc(it.type) : ''}</span><span class="ve-posj-pos-note">${esc(it.note || '')}</span></div>`;
      };
      const resonanceHtml = signals.resonance ? `<div class="ve-posj-path">⚡ ${esc(signals.resonanceNote || '三卡共振，信号可靠性升级')}</div>` : '';
      const anomalyHtml = (pj.signals || pj.anomaly || lifeAmpSignal)
        ? `<div class="ve-posj-step ve-posj-anomaly"><span class="ve-posj-step-label">信号叠加层</span>${trigCount === 0
            ? `<span class="ve-sig-row">${sigChip('divergence', '背离')}${sigChip('extreme', '极端量能')}${sigChip('weak', '弱方向异动')}${sigChip('lifeAmp', '分时无量拉升')}</span>`
            : `<div class="ve-posj-anomaly-list">${sigDetail('divergence', '背离')}${sigDetail('extreme', '极端量能')}${sigDetail('weak', '弱方向异动')}${sigDetail('lifeAmp', '分时无量拉升')}</div>`}</div>${resonanceHtml}`
        : '';
      // 异常特例（命中则主判挂起）
      const specialHtml = pj.special
        ? `<div class="ve-posj-step ve-posj-anomaly"><span class="ve-posj-step-label">⚠️ 异常特例生效</span><div class="ve-posj-anomaly-list"><div class="ve-posj-anomaly-item"><span class="ve-rule-badge ve-block">${esc(pj.special.type)}</span><span class="ve-posj-pos-note">${esc(pj.special.note || '')}</span></div></div></div>`
        : '';
      // 主判横幅（每日唯一生效判定；特例挂起时由 summary 说明）
      const banner = pj.cell || null;
      const mainHtml = banner
        ? `<div class="ve-posj-main ${mainCls(banner.direction)}"><span class="ve-posj-dir">135 格综合判定 · ${esc(banner.dirText || '')}</span>${esc(banner.conclusion)}</div>`
        : `<div class="ve-note">${esc(pj.summary || '')}</div>`;
      const pathHtml = banner
        ? `<div class="ve-posj-path">生效路径：主轴 135 格归格 · ${esc(banner.key)}${banner.derived ? '（推导格）' : ''}——信号叠加层与异常特例今日${pj.special ? '有特例命中（综合判定已挂起）' : (signals.resonance ? '存在共振（可靠性升级）' : '均未改变综合判定')}</div>`
        : '';
      // 20261106i（用户裁决「只统一结论展示」）+ 20261106j（分母统一 ÷20）：同屏只保留一个「今日量价关系判定」结论，
      // 且全量价判定的分母已统一为 ÷20 日均量（与本卡 135 格推演图同源），故同屏结论不再互斥。
      // 20261106l：「5日量能比」「60日量能确认」均已退役，5 日均量口径由顶部「量比」继续展示。
      // 20261109c（用户裁决「工作台已统一 20 日量能比，不应出现其他标准」）：异常特例层已接入同一真值源，
      // 口径说明必须把覆盖范围写全，不能再只声明 135 格 / 今日量价关系 / 资金行为三处。
      const caliberHtml = `<div class="ve-posj-path">📐 口径说明：全量价判定（本卡 135 格综合判定 / 资金量能综合判断·今日量价关系判定 / 资金行为）已统一为 当日量 ÷ 20 日均量（与 135 格推演图同源：放量 >1.3 / 平量 0.8~1.3 / 缩量 <0.8），同屏结论不再互斥；「20日涨跌日量能比」（近20日涨日均量 ÷ 跌日均量）为显式标注分母的原始指标卡，仅作辅助参考，不承担量价判定结论；「5日量能比」「60日量能确认」已退役——20261106n 起 60 日均量口径整体退役，全量价判定与文字分析统一使用 20 日量能比（当日量 ÷ 20 日均量），5 日均量原始值由顶部「量比」（腾讯行情直采）继续展示。〔20261109c 覆盖补完〕异常特例层（生死位五规则）、11.3.1「该放量未放量」、口诀 4「连续低成交」、缩量止跌观察与资金卡回退分档，已全部接入唯一真值源 lib/volumeCaliber.js（放量 >1.3 / 平量 0.8~1.3 / 缩量 <0.8），引擎内不再存在 ×1.5 或「当日量必须超过前高量能」等第二套标准；前高对应量能改取「同价位带最近前高」并仅作展示参照、不参与判定。显式标注分母的原始指标（顶部量比、每日量比趋势图、20日涨跌日量能比、箱体放量穿越线）为 ÷前5日均量或独立口径，不承担量价判定结论，与 ÷20 统一口径分母不同，数值不应相等。</div>`;
      // 参考锚点表（唯一渲染处；仅参考提醒不参与判定）
      const refRows = (pos.refs || []).map(r =>
        `<tr><td>${esc(r.k)}</td><td><span class="ve-rule-badge ${r.available ? '' : 've-miss'}">${r.available ? '参考' : '未接入'}</span></td><td>${esc(r.v)}</td></tr>`).join('');
      const tableHtml = refRows
        ? `<table class="ve-posj-table"><thead><tr><th>参考锚点</th><th>状态</th><th>说明</th></tr></thead><tbody>${refRows}</tbody></table>
          <div class="ve-ten-fw">注：判定采用锚点一（250 日价格分位，默认判定源）；锚点二/三/四仅为参考提醒、不参与量价判定（完整判定标准见推演图页「量价判定模型（合并版）」）。本卡为当日唯一的 135 格综合判定；信号叠加层命中追加警示不覆盖综合判定；异常特例命中综合判定挂起。</div>`
        : `<div class="ve-ten-fw">${esc(pj.summary || '量价判定数据不足。')}</div>`;
      const basisHtml = pos.basis ? `<div class="ve-ten-fw">位置依据：${esc(pos.basis)}${pos.divergence ? `；${esc(pos.divergence)}` : ''}</div>` : '';
      return `<div class="ve-section-title">量价判定（先定位置 × 运行状态 × 量能 × 涨跌幅）</div>
        <div class="ve-posj">
          ${stepHtml}
          ${chainHtml}
          ${specialHtml}
          ${anomalyHtml}
          ${lifeSpecialHtml}
          ${mainHtml}
          ${pathHtml}
          ${caliberHtml}
          ${tableHtml}
          ${basisHtml}
        </div>`;
    })();

    // 20261101e：量价十口诀卡整卡移除（用户 2026-11-01 截图指令「图片里面的内容无需再展示」）。
    // 引擎层 tenRules 字段保留不动（铁律第一条：仅前端展示层移除，后端输出格式零变化）。

    // 20261101k：原顶部「量能信号」横幅（信号档 + 得分）整块删除，由「资金量能综合判断」
    // 上移替换——CapitalCharts.buildConclusionParts(data) 与旧卡同一数据源（data.volumeIndicators
    // / moneyFlow / marginTrading / conclusion），静默刷新 refreshCapitalFlowSilent 内随本函数
    // 一并同步更新；原 #capConclusion 独立卡已删除，避免同内容双份展示。
    // 20261101p（用户截图指令，uicraft 重排版）：原 8 行通栏纵向列表改为两级结构——
    // ① 多空结论提炼为语义着色的结论横幅（偏多红晕 / 偏空绿晕 / 中性灰底）+ 多空比分徽标；
    // ② 指标条目改网格（量价关系长文本通栏）。数据内容口径与重排版前完全一致。
    // 20261102b（用户截图指令「展示卡片杂乱无章、毫无设计美感和对称性」）：原固定 3 列网格
    // 在条目数非 3 的倍数时右侧留大块空白（如融资融券独占 1/3 行），且列缝与下方 5 列/10 列
    // 基准网格断裂 → 改「等分满行」：通栏项（量价关系）各自占整行，其余条目（短期/中期资金、
    // OBV/VR/MFI、融资融券，数量 2~6 动态）包进同一 flex 行等分等高，无论几项都满行对称；
    // 阅读顺序理顺为 标题 → 结论横幅 → 通栏摘要 → 等分明细行。
    const conclusion = (typeof CapitalCharts !== 'undefined' && typeof CapitalCharts.buildConclusionParts === 'function')
      ? CapitalCharts.buildConclusionParts(data) : null;
    let conclusionHtml = '';
    if (conclusion && Array.isArray(conclusion.rows) && conclusion.rows.length) {
      const v = conclusion.verdict || {};
      const verdictHtml = v.label ? `
      <div class="ve-verdict ve-verdict-${esc(v.tone || 'neutral')}">
        <span class="ve-verdict-label">🎯 ${esc(v.label)}</span>
        <span class="ve-verdict-score"><span class="ve-score-chip ve-chip-bull">多头 ${v.bull} 分</span><span class="ve-score-chip ve-chip-bear">空头 ${v.bear} 分</span></span>
      </div>` : '';
      const ccHtml = (r) => `
        <div class="ve-cc">
          <span class="ve-cc-label">${esc(r.icon || '')} ${esc(r.label || '')}</span>
          <span class="ve-cc-text ${r.tone === 'bull' ? 've-tone-bull' : r.tone === 'bear' ? 've-tone-bear' : ''}">${r.text || ''}</span>
        </div>`;
      const wideHtml = conclusion.rows.filter(r => r.wide).map(r => `
        <div class="ve-cc-wide">
          <span class="ve-cc-label">${esc(r.icon || '')} ${esc(r.label || '')}</span>
          <span class="ve-cc-text ${r.tone === 'bull' ? 've-tone-bull' : r.tone === 'bear' ? 've-tone-bear' : ''}">${r.text || ''}</span>
        </div>`).join('');
      const flowItems = conclusion.rows.filter(r => !r.wide);
      const flowHtml = flowItems.length ? `<div class="ve-flow-row">${flowItems.map(ccHtml).join('')}</div>` : '';
      conclusionHtml = `
      <div class="ve-section-title">资金量能综合判断</div>
      ${verdictHtml}
      ${wideHtml}
      ${flowHtml}`;
    }

    // 20261023f：把「真·数据不足（影响置信度）」与「数据来源/口径说明（不影响结论）」分开。
    // 原实现把日K降级、当日bar覆写、量比直采、分时未收盘等来源说明全塞进红色「数据不足」框，
    // 用户看到满屏"数据不足"误以为数据缺失（2026-10-23 截图报障）。
    const allGaps = Array.isArray(ve.dataGaps) ? ve.dataGaps : [];
    const TRUE_GAP_RE = /数据不足|样本仅|不足 ?250|推算值|未包含今日|未包含最近交易日|窗口仅/;
    const trueGaps = allGaps.filter(g => TRUE_GAP_RE.test(g));
    const sourceNotes = allGaps.filter(g => !TRUE_GAP_RE.test(g));
    const gapsHtml = trueGaps.length
      ? `<div class="ve-gaps"><div class="ve-gaps-title">⚠️ 数据不足（影响结论置信度）</div>${trueGaps.map(g => `<div class="ve-gap-item">· ${esc(g)}</div>`).join('')}</div>` : '';
    const notesHtml = sourceNotes.length
      ? `<div class="ve-src-notes"><div class="ve-src-title">数据来源与口径说明（不影响结论）</div>${sourceNotes.map(g => `<div class="ve-gap-item">· ${esc(g)}</div>`).join('')}</div>` : '';

    // 20261101n：20261101m 的置顶卡换手率注入块已回滚（m 版理解错用户截图指向，真实目标
    // 是页首固定指标条与个股标题卡，与本函数无关）。

    el.innerHTML = `
      ${conclusionHtml}
      <div class="ve-tile-row ve-cols-10">${metricsHtml}</div>
      ${vpHtml}
      ${posHtml}
      ${riskHtml}
      <div class="ve-section-title">结论提示</div>
      <div class="ve-conclusion">${esc(ve.conclusion || '')}</div>
      ${ve.marketEnvNote ? `<div class="ve-note">${esc(ve.marketEnvNote)}</div>` : ''}
      ${gapsHtml}
      ${notesHtml}
      <div class="cap-date-note">${esc(ve.disclaimer || '')} 数据源：东方财富日K（降级同花顺/腾讯）/腾讯分时/交易所公告 · 本地计算</div>
    `;
  },

  // 量能引擎渲染用转义（与后端禁交易指令扫描互补，防 XSS）
  _veEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  scoreClass(score, type) {
    if (type === 'tech') {
      if (score === '强烈看多') return 'strong-bullish';
      if (score === '偏多') return 'bullish';
      if (score === '偏空') return 'bearish';
      if (score === '强烈看空') return 'strong-bearish';
      return 'neutral';
    }
    if (type === 'fund') {
      if (score === '优秀') return 'excellent';
      if (score === '良好') return 'good';
      if (score === '一般') return 'average';
      if (score === '较弱') return 'weak';
      if (score === '较差') return 'poor';
      return 'neutral';
    }
    if (type === 'sentiment') {
      if (score === '积极') return 'strong-bullish';
      if (score === '偏多') return 'bullish';
      if (score === '偏空') return 'bearish';
      if (score === '消极') return 'strong-bearish';
      return 'neutral';
    }
    if (type === 'capital') {
      if (score === '非常活跃') return 'strong-bullish';
      if (score === '活跃') return 'bullish';
      if (score === '低迷') return 'bearish';
      if (score === '极度低迷') return 'strong-bearish';
      return 'neutral';
    }
    return 'neutral';
  },

  // ---- Overview tab ----
  renderOverview(data) {
    const { history, technical, fundamental } = data;
    // 20261012：留存 overview 数据，供信息分析卡加载完成后回填「主要产品」截图
    this._overviewData = data;

    // 公司概况（公司全称 / 企业性质 / 所属行业 / 控股股东 / 总部地点）
    this.renderCompanyProfile(data);

    // Candlestick chart
    if (history.length > 0) {
      Charts.candlestick('candlestickChart', history, technical);
    }

    // 期货关联走势面板（产品型公司，异步加载，不阻塞概览渲染）
    this.renderFuturesPanel(this.currentSymbol, data.name);

    // 概览内嵌 AI 信息分析（CFA 统一框架，仅读缓存，不自动联网）
    if (this.currentSymbol) {
      this.loadCompanyDeep(false);
    }
  },

  // 公司概况卡片渲染（issue6）：突出主要产品、主要客户、企业性质
  // 20261012：简介页面新增「主要产品」截图区——复用信息分析卡已抓取的 productsServices.imageLocal
  // （含必应搜图兜底），让商品截图直接展示在「📊 简介」tab 的公司概况卡；信息分析卡仍保留完整产品与服务详情。
  renderCompanyProfile(data) {
    const el = document.getElementById('companyProfile');
    const badgeEl = document.getElementById('companyTypeBadge');
    if (!el) return;
    const profile = data.companyProfile || {};
    const ct = data.fundamental?.companyTypeName;
    if (badgeEl && ct) {
      badgeEl.textContent = ct;
      badgeEl.className = 'company-type-badge-inline';
    }

    const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
    const row = (label, value) => `
      <div class="cp-row">
        <span class="cp-label">${label}</span>
        <span class="cp-value">${value || '<span class="cp-empty">—</span>'}</span>
      </div>`;

    let html = `
      <div class="cp-grid">
        ${row('公司全称', profile.companyName)}
        ${row('企业性质', profile.ownership)}
        ${row('所属行业', profile.industry)}
        ${row('控股股东', profile.controllingShareholder)}
        ${row('总部地点', profile.province)}
      </div>
      ${(() => {
        // 20261016b（审计 P1）：mainBusiness 后端已返回（lib/shareholderData.js:307-314，取自东财 F10 经营范围/主营构成原文），
        // 前端此前从未渲染，导致「简介」缺了最关键的经营口径。此处补上，超长截断并保留全文于 title。
        const mb = profile.mainBusiness ? String(profile.mainBusiness) : '';
        if (!mb) return '';
        const shown = mb.length > 300 ? mb.slice(0, 300) + '…' : mb;
        return `<div class="cp-row"><span class="cp-label">主营业务 / 经营范围</span><span class="cp-value" title="${esc(mb)}">${esc(shown)}</span></div>`;
      })()}
      ${profile.intro ? `<div class="cp-intro">${profile.intro}</div>` : ''}
    `;

    // 主要产品截图（简介页面）：复用信息分析卡 productsServices（含必应兜底图）；未加载时不阻塞简介渲染
    try {
      const ps = (this.companyDeepData && this.companyDeepData.profile && this.companyDeepData.profile.productsServices) || [];
      if (ps.length) {
        html += `<div class="cp-prod-title">主要产品</div>`;
        html += '<div class="cp-prod-grid">' + ps.map(p => {
          const img = p.imageLocal || '';
          return `<div class="cp-prod">
            <div class="cp-prod-img">${img ? `<img src="${esc(img)}" alt="${esc(p.name)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="cp-ph">🏷️</span></div>
            <div class="cp-prod-name">${esc(p.name)}</div>
          </div>`;
        }).join('') + '</div>';
      }
    } catch (e) { /* 信息分析未加载时跳过产品图 */ }

    // 20261016b 诚实性修正（审计 P2）：「企业性质」由股东结构推断（shareholderData.js:466 inferOwnership），
    // 非东财 F10 权威登记口径；旧文案整块标「东方财富F10」属虚假归因，此处分层如实标注。
    html += `<div class="cp-source">来源：东方财富F10 · 公司基本资料（⚠️「企业性质」为按股东结构推断，非权威登记口径）</div>`;
    el.innerHTML = html;
  },

  // ---- 期货关联走势面板（需求1） ----
  async renderFuturesPanel(symbol, name) {
    const panel = document.getElementById('futuresPanel');
    const nameEl = document.getElementById('futuresName');
    const badgeEl = document.getElementById('futuresCorrBadge');
    const conclEl = document.getElementById('futuresConclusion');
    if (!panel) return;
    panel.style.display = 'none';
    if (!symbol) return;
    // 异步竞态保护：本次请求的唯一令牌，切换股票后令牌变化，旧响应将被丢弃
    const token = (this.futuresToken = (this.futuresToken || 0) + 1);
    try {
      const resp = await fetch(`/api/futures-correlation/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name || '')}`);
      const d = await resp.json();
      if (token !== this.futuresToken) return; // 已切换到其他股票，丢弃旧响应
      if (!d.hasFutures) {
        // 释放上一只有期货时的残留图表实例
        if (Charts.instances && Charts.instances['futuresChart']) {
          try { Charts.instances['futuresChart'].dispose(); } catch {}
          delete Charts.instances['futuresChart'];
        }
        return; // 该公司无关联期货，保持隐藏
      }

      panel.style.display = '';
      nameEl.textContent = d.futuresName || '期货';

      if (d.correlation === null) {
        badgeEl.textContent = '';
        badgeEl.className = 'corr-badge';
        conclEl.innerHTML = `<div class="sc-summary"><span class="sc-icon">📌</span><span>${d.conclusion || '暂无法进行关联分析。'}</span></div>`;
        return;
      }

      // 渲染归一化对比图
      Charts.futuresCorrelation('futuresChart', d);

      // 关联度徽章
      const levelColor = {
        '高度': '#F0B90B', '中度': '#cdab74', '弱': '#94a3b8', '基本无': '#94a3b8',
      }[d.level] || '#94a3b8';
      badgeEl.textContent = `相关系数 ${d.correlation.toFixed(2)} · ${d.level}${d.direction}相关`;
      badgeEl.style.background = levelColor + '22';
      badgeEl.style.color = levelColor;
      badgeEl.style.borderColor = levelColor;

      // 结论 + 论证过程（可展开）
      const hasR = Array.isArray(d.reasoning) && d.reasoning.length > 0;
      let html = `<div class="sc-summary"><span class="sc-icon">📌</span><span>${d.conclusion || ''}</span></div>`;
      if (hasR) {
        html += `<button type="button" class="sc-toggle" id="futuresToggle">查看论证过程 ▾</button>`;
        html += `<div class="sc-reasoning hidden" id="futuresReasoning">${d.reasoning.map(r => `<div class="sc-reason-item">• ${r}</div>`).join('')}</div>`;
      }
      conclEl.innerHTML = html;

      if (hasR) {
        const btn = document.getElementById('futuresToggle');
        const re = document.getElementById('futuresReasoning');
        btn.addEventListener('click', () => {
          const hidden = re.classList.toggle('hidden');
          btn.textContent = hidden ? '查看论证过程 ▾' : '收起论证过程 ▴';
        });
      }
    } catch (e) {
      console.error('Futures panel error:', e);
    }
  },

  // ---- 价格行为趋势推演（Price Action 框架：长期/短期预判 + 趋势一致性矩阵 + 证伪临界点） ----
  async loadPriceAction() {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    if (this.paLoadedSymbol === symbol) return;
    bgPreload.start('价格行为推演');
    const token = this._reqToken;
    try {
      const resp = await fetch(`/api/price-action/${encodeURIComponent(symbol)}`);
      const data = await resp.json();
      if (token !== this._reqToken || this.currentSymbol !== symbol) return; // 已切到别的股票，丢弃过期结果
      if (!data || data.error || !data.success) {
        this._renderPaError(data?.error || '价格行为推演数据获取失败');
        return;
      }
      // 20261021d：手动阻力/支撑区间与主数据**一起取**，保证 ②卡 一次渲染成型
      // （若在渲染后再补，模型清单会先少两条再跳出来）。失败按空处理，不影响模型内容。
      this.manualZones = await this._fetchManualZones(symbol);
      this.paData = data;
      this.paLoadedSymbol = symbol;
      this.renderPriceAction(data);
      bgPreload.finish('价格行为推演');
    } catch (e) {
      if (token !== this._reqToken) return;
      bgPreload.finish('价格行为推演');
      this._renderPaError('价格行为推演加载失败：' + e.message);
    }
  },

  _renderPaError(msg) {
    const meta = document.getElementById('paMeta');
    if (meta) meta.textContent = '';
    const html = `<div class="pa-error"><span class="pe-icon">⚠️</span><span>${this.escapeHtml(msg || '数据不足')}</span></div>`;
    ['paLongTerm', 'paShortTerm', 'paCoord', 'paEdges'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = html;
    });
  },

  // 趋势定性 → 视觉等级（涨红 / 跌绿 / 震荡金，与全站规范一致）
  _paVerdictClass(v) {
    if (v === '上行' || v === '偏上' || v === '超跌反弹') return 'up';
    if (v === '下行' || v === '偏下' || v === '冲高回落') return 'down';
    return 'side';
  },

  // 单箱体精简一行（20261020j）：旧版「多窗口箱体表格」已彻底移除，此处只留一行结论。
  // 口径来源 lib/rangeDetector.js；与②卡下方阻力/支撑区间的有效性检验（lib/zoneValidity.js）
  // 是两套完全独立的口径，禁止互相引用或互相当作验证。
  // ---- 20261021d：手动阻力/支撑区间（②卡「手动添加」页签）----
  // 口径：用户自填，只做展示；**不进** zoneValidity 的有效性检验、**不进**侵蚀、不影响方向判断与准确率统计。
  // 落盘在服务端 data/manual-zones/<symbol>.json（换设备/清缓存都不丢），与模型数据互不相干。
  _emptyManualZones() {
    return { resistances: [], supports: [], total: 0, limits: { maxPerSide: 20, noteMax: 40 } };
  },

  async _fetchManualZones(symbol) {
    try {
      const r = await fetch(`/api/manual-zones/${encodeURIComponent(symbol)}`);
      const d = await r.json();
      if (!d || !d.success) return this._emptyManualZones();
      return {
        resistances: d.resistances || [],
        supports: d.supports || [],
        total: d.total || 0,
        limits: d.limits || this._emptyManualZones().limits,
      };
    } catch (e) {
      console.warn('[ManualZones] 读取失败（按空处理，不影响模型内容）:', e && e.message);
      return this._emptyManualZones();
    }
  },

  async _saveManualZone(side, low, high, note) {
    const symbol = this.currentSymbol;
    try {
      const r = await fetch(`/api/manual-zones/${encodeURIComponent(symbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side, low, high, note }),
      });
      const d = await r.json();
      if (!d || !d.success) return { ok: false, error: (d && d.error) || '保存失败' };
      this.manualZones = {
        resistances: d.resistances || [], supports: d.supports || [],
        total: d.total || 0, limits: d.limits || this._emptyManualZones().limits,
      };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '网络异常：' + (e && e.message ? e.message : '') };
    }
  },

  async _deleteManualZone(id) {
    const symbol = this.currentSymbol;
    try {
      const r = await fetch(`/api/manual-zones/${encodeURIComponent(symbol)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!d || !d.success) return { ok: false, error: (d && d.error) || '删除失败' };
      this.manualZones = {
        resistances: d.resistances || [], supports: d.supports || [],
        total: d.total || 0, limits: d.limits || this._emptyManualZones().limits,
      };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: '网络异常：' + (e && e.message ? e.message : '') };
    }
  },

  /** 「手动添加」页签正文：表单 + 已添加清单（含有效性检验结果） */
  _renderManualZonesPanel(shortTerm) {
    const mz = this.manualZones || this._emptyManualZones();
    const fmt = (v) => (v == null ? '—' : Storage.formatNumber(v));
    const rowTxt = (z) => (Number(z.low) === Number(z.high)
      ? fmt(z.low)
      : `${fmt(z.low)} ~ ${fmt(z.high)}`);
    // 20261021e：后端已把手动区间并入短期清单并跑过两条有效性检验，这里按 manualId 取回结论，
    // 让用户在「手动添加」页签里就能看到「通过 / 未通过 + 原因」，而不是纳闷"为什么模型清单里没有"。
    // 20261103h：手动区间被放量有效突破后会反转成对侧区间（原条目移出清单）——从 manualZonesMeta.reversed
    // 取回反转事件，页签标注「已反转」，避免用户纳闷"为什么清单里找不到我加的那条"。
    const checked = {};
    const revMap = {};
    const st = shortTerm || {};
    [].concat(st.resistances || [], st.supports || []).forEach(z => {
      if (z && z.isManual && z.manualId) checked[z.manualId] = z;
    });
    ((st.manualZonesMeta || {}).reversed || []).forEach(r => {
      if (r && r.manualId) revMap[r.manualId] = r;
    });
    const sideTxt = (s) => (s === 'resistance' ? '上方阻力' : '下方支撑');
    const group = (arr, side, title) => {
      if (!arr.length) return '';
      return `<div class="pa-mz-group ${side}">
        <div class="pa-mz-group-title">${title}<span class="pa-mz-count">${arr.length}</span></div>
        ${arr.map(z => {
          const info = checked[z.id];
          const rev = revMap[z.id];
          const invalid = info && info.valid === false;
          const reasons = invalid && Array.isArray(info.invalidReasons) ? info.invalidReasons.join('；') : '';
          const badge = rev
            ? `<span class="pa-mz-badge reversed" title="已放量有效突破反转">已反转</span>`
            : !info
              ? '<span class="pa-mz-badge unknown">未检验</span>'
              : invalid
                ? `<span class="pa-mz-badge invalid" title="${this.escapeHtml(reasons)}">检验未通过</span>`
                : '<span class="pa-mz-badge ok">通过检验</span>';
          const revTip = rev
            ? `你标注的这条${sideTxt(side)}已于 ${rev.date || '近期'} 被<b>放量有效突破</b>（量比 ${rev.vr} > 1.2，以当日收盘价为准），按「放量突破 → 角色反转」规则转换为${sideTxt(rev.to)}，出现在模型清单里（带「反转」标）。它继续接受有效性检验（无放量轻松穿越 → 无效移除）。`
            : '';
          const tip = rev
            ? revTip
            : invalid
              ? `${reasons}\n（未通过有效性检验，因此不在下方/上方的模型清单里显示；你仍可删除它）`
              : '已通过本模块的有效性检验：无放量轻松突破 → 无效（放量有效突破则反转为对侧区间）';
          return `<div class="pa-mz-row ${side}${invalid ? ' invalid' : ''}${rev ? ' reversed' : ''}" title="${this.escapeHtml(tip)}">
            <span class="pa-mz-range">${rowTxt(z)}</span>
            <span class="pa-mz-note-text">${this.escapeHtml(z.note || '')}</span>
            ${badge}
            <button type="button" class="pa-mz-del" data-mz-del="${this.escapeHtml(z.id)}" title="删除这条手动区间">删除</button>
          </div>`;
        }).join('')}
      </div>`;
    };
    const body = (mz.resistances.length || mz.supports.length)
      ? group(mz.resistances, 'resistance', '手动阻力') + group(mz.supports, 'support', '手动支撑')
      : '<div class="pa-mz-empty">还没有手动区间。上面填一个价位（只填一个就代表单点），点「添加」即可。</div>';
    return `
      <div class="pa-mz-tip">手动区间与模型区间<b>走同一条生命周期</b>（20261103h）：无放量轻松突破 → 无效，不进上方清单、本页标原因；<b>放量有效突破 → 反转为对侧区间</b>（本页标「已反转」，模型清单出现带「反转」标的对侧条目）。
        但<b>不参与</b>侵蚀收缩，也不影响方向判断、概率与准确率统计。</div>
      <div class="pa-mz-form">
        <select id="paMzSide" class="pa-mz-input pa-mz-side">
          <option value="resistance">加为上方阻力</option>
          <option value="support">加为下方支撑</option>
        </select>
        <input id="paMzLow" class="pa-mz-input" type="number" step="0.01" min="0" placeholder="价位（下沿）">
        <span class="pa-mz-sep">~</span>
        <input id="paMzHigh" class="pa-mz-input" type="number" step="0.01" min="0" placeholder="上沿（留空=单点）">
        <input id="paMzNote" class="pa-mz-input pa-mz-note" type="text" maxlength="${mz.limits.noteMax}" placeholder="备注（可选）">
        <button type="button" id="paMzAdd" class="pa-mz-add">添加</button>
      </div>
      <div class="pa-mz-err" id="paMzErr"></div>
      ${body}
    `;
  },

  /** 绑定 ②卡 页签与手动区间表单（每次重渲染后重新绑定；DOM 是新的） */
  _wirePriceActionTabs(stEl) {
    const tabs = stEl.querySelectorAll('[data-pa-tab]');
    const bodies = stEl.querySelectorAll('[data-pa-body]');
    const activate = (key) => {
      this._paTab = key;
      tabs.forEach(b => b.classList.toggle('active', b.getAttribute('data-pa-tab') === key));
      bodies.forEach(b => b.classList.toggle('hidden', b.getAttribute('data-pa-body') !== key));
    };
    tabs.forEach(btn => {
      btn.addEventListener('click', () => activate(btn.getAttribute('data-pa-tab')));
    });
    // 恢复上次停留的页签（同一页面内反复增删/刷新不会跳回模型页）
    activate(this._paTab === 'manual' ? 'manual' : 'model');

    const addBtn = stEl.querySelector('#paMzAdd');
    if (!addBtn) return;
    const errEl = stEl.querySelector('#paMzErr');
    const showErr = (msg) => { if (errEl) errEl.textContent = msg || ''; };
    addBtn.addEventListener('click', async () => {
      const side = (stEl.querySelector('#paMzSide') || {}).value || 'resistance';
      const lowRaw = ((stEl.querySelector('#paMzLow') || {}).value || '').trim();
      const highRaw = ((stEl.querySelector('#paMzHigh') || {}).value || '').trim();
      const note = ((stEl.querySelector('#paMzNote') || {}).value || '').trim();
      if (!lowRaw) { showErr('请先填价位'); return; }
      const low = Number(lowRaw);
      const high = highRaw ? Number(highRaw) : low;   // 只填一个 = 单点区间
      if (!Number.isFinite(low) || !Number.isFinite(high)) { showErr('价格必须是数字'); return; }
      if (low > high) { showErr('下沿不能高于上沿'); return; }
      addBtn.disabled = true;
      const r = await this._saveManualZone(side, low, high, note);
      addBtn.disabled = false;
      if (!r.ok) { showErr(r.error || '保存失败'); return; }
      this._paTab = 'manual';
      if (this.paData) this.renderPriceAction(this.paData);   // 重渲染：模型清单同步出现该条（带「手动」标）
    });
    stEl.querySelectorAll('[data-mz-del]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-mz-del');
        btn.disabled = true;
        const r = await this._deleteManualZone(id);
        if (!r.ok) { showErr(r.error || '删除失败'); btn.disabled = false; return; }
        this._paTab = 'manual';
        if (this.paData) this.renderPriceAction(this.paData);
      });
    });
  },

  _renderSingleBoxRow(sr) {
    if (!sr || sr.ok === false) return '';   // 数据不足/异常 → 整行隐藏，不占位
    const fmt = (v) => (v == null ? '—' : Storage.formatNumber(v));
    const basis = (sr.tolerance && sr.tolerance.basis) || '';
    const rule = (sr.invalidation && sr.invalidation.rule) || '';
    const commonTip = [
      `箱体口径：${basis}`,
      `失效规则：${rule}`,
      '箱体区间=箱体存续期内的收盘实际区间；失效线=中轴±容差（连续 3 日收盘越过失效线即箱体失效，与是否放量无关）。',
      '注意：与本卡下方「阻力/支撑区间」的有效性检验是两套独立口径，不可互相验证。',
    ].filter(Boolean).join('\n');

    if (sr.state !== 'active' || !sr.box) {
      const li = sr.lastInvalid;
      const nf = sr.nextFormation || {};
      let txt;
      if (li) {
        txt = `上一个箱体 ${li.startDate}~${li.endDate}（${li.days} 日）已于 ${li.invalidDate} 失效：连续 ${li.invalidStreak} 日收盘${li.invalidDir}突破 ${fmt(li.invalidLevel)}`
          + (nf.remaining > 0 ? ` · 新箱体还差 ${nf.remaining} 个交易日` : ' · 已够 20 日种子，但振幅尚未收窄到容差内');
      } else {
        txt = sr.conclusion || '未形成箱体';
      }
      return `<div class="pa-box-row none" title="${this.escapeHtml(`${sr.conclusion || ''}\n${commonTip}`)}"><span class="pb-tag">箱体</span><span class="pb-empty">${this.escapeHtml(txt)}</span></div>`;
    }

    const b = sr.box;
    const inv = sr.invalidation || {};
    const tip = [
      sr.conclusion,
      `中轴 ${fmt(b.mid)}｜容差 ±${b.tolPct}%｜收盘区间 ${fmt(b.envL)}~${fmt(b.envU)}（振幅 ${b.ampEnvPct}%，最大半幅 ${b.halfDevPct}%）｜假突破 ${b.fakeBreaks} 次`,
      `上下限已并入下方清单：上沿 ${fmt(b.envU)} 列入「上方关键阻力区间」、下沿 ${fmt(b.envL)} 列入「下方关键支撑区间」。`,
      commonTip,
    ].filter(Boolean).join('\n');
    // 20261020l：**绝不显示「距失效还需 N 日」这种倒计时**——失效条件是「连续 3 日收盘在失效线外」，
    // 股价还在箱体里震荡时该条件根本没被触发，倒数会让人误以为「三日后自动失效」（用户实测报障）。
    // 只有真的已连续越界（currentStreak>0）才显示「已连续 N 日在外，再有 M 日失效」。
    const riskTxt = inv.currentStreak > 0
      ? `已连续 ${inv.currentStreak} 日在失效线外，再有 ${inv.remainDays} 日失效`
      : '未触发失效';
    return `<div class="pa-box-row" title="${this.escapeHtml(tip)}">
      <span class="pb-tag">箱体</span>
      <span class="pb-main">自 ${this.escapeHtml(b.startDate || '')} 起 <b>${b.days}</b> 个交易日</span>
      <span class="pb-kv">失效线 <b class="up">${fmt(b.bandU)}</b> / <b class="down">${fmt(b.bandL)}</b></span>
      <span class="pb-risk ${inv.currentStreak > 0 ? 'warn' : ''}">${riskTxt}</span>
    </div>`;
  },

  // ─────────────────────────────────────────────────────────────
  // 20261022g：②卡「共振带」展示（紧凑清单 + 点开看详情）
  // 数据全部来自后端 lib/zoneResonance.js，前端不重算强度/失效位，只负责排版。
  // ─────────────────────────────────────────────────────────────
  /**
   * 排序：**上方 / 下方两段统一，都按价格从高到低、自上而下排列**（用户 20261022i 要求）。
   *   → 上方阻力：最高的一条在最上面，越靠下越接近现价
   *   → 下方支撑：最高的一条（最接近现价）在最上面，越靠下越远
   * 整张卡自上而下价格**单调下降**，等价于一根竖直的价格轴：
   *   6.62 … 5.48（阻力） → 4.99 … 4.59（支撑），读起来与看盘软件的纵轴方向一致。
   * ⚠ 历史：20261022h 曾写成「阻力 low 升序 / 支撑 low 降序」（两段都是"离现价最近的在最上"），
   *   结果两段方向相反、整卡不连续，用户指出"做错了"。现改为单一口径，不再区分 side。
   * ⚠ 只排**副本**：后端数组顺序恒为「阻力 low 升序 / 支撑 low 降序」，
   *   ④卡反转边界取 [0]、量能规则4 取就近位都依赖该顺序，前端不得改动接口数据。
   */
  _sortZones(arr, side) {
    const list = (Array.isArray(arr) ? arr : []).slice();
    const lo = (z) => (Number.isFinite(Number(z && z.low)) ? Number(z.low) : 0);
    // 统一按 low 降序（高价在上、低价在下）；side 参数保留只为兼容既有调用点，不参与排序
    list.sort((a, b) => lo(b) - lo(a));
    return list;
  },

  /** 共振带统计条：ATR / 候选数 / 方法数 / 合并统计 / 算不出的方法
   *  （20261022h：排序切换已删除，清单固定按价格高低排列） */
  _renderZoneMetaBar(zm, resAll, supAll) {
    const parts = [];
    if (zm && Number.isFinite(zm.atr)) parts.push(`ATR(20) ${Storage.formatNumber(zm.atr)}`);
    if (zm && zm.candidateCount != null) parts.push(`候选 ${zm.candidateCount} 条`);
    if (zm && Array.isArray(zm.methods) && zm.methods.length) parts.push(`${zm.methods.length} 种方法命中`);
    parts.push(`共振带 阻 ${resAll.length} / 撑 ${supAll.length}`);
    const st = (zm && zm.stats) || {};
    const stats = [];
    if (st.merged) stats.push(`合并 ${st.merged} 组`);
    if (st.overlapCut) stats.push(`切重叠 ${st.overlapCut} 处`);
    if (st.droppedWeakOnly) stats.push(`弃单点关口 ${st.droppedWeakOnly} 个`);
    const skipped = (zm && Array.isArray(zm.skipped)) ? zm.skipped : [];
    return `<div class="pa-zone-bar">
      <span class="pa-zone-bar-meta">${this.escapeHtml(parts.join(' · '))}${stats.length ? ` ｜ ${this.escapeHtml(stats.join(' / '))}` : ''}</span>
      ${skipped.length ? `<span class="pa-zone-bar-skip">未算出：${this.escapeHtml(skipped.join('；'))}</span>` : ''}
    </div>`;
  },

  /** 单条共振带：紧凑行 + 展开详情（详情默认隐藏，点行展开） */
  _renderZoneRow(z, cls, zm) {
    const fmt = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : Storage.formatNumber(v));
    const lo = Number(z && z.low);
    const hi = Number(z && z.high);
    // 箱体边界是单点价（low===high）→ 渲染单值，避免「8.54 ~ 8.54」
    const single = lo === hi;
    const rangeTxt = single ? fmt(lo) : `${fmt(lo)} ~ ${fmt(hi)}`;
    const er = z && z.erosion;
    // 强度徽标：共振带给 强/中/弱；特殊条目给语义标签（避免缺失感，也不冒充强度）
    const sm = z && z.strength
      ? { text: z.strength, cls: z.strength === '强' ? 'strong' : z.strength === '中' ? 'mid' : 'weak' }
      : z.isReversed ? { text: '反转', cls: 'special' }
        : z.isManual ? { text: '自定', cls: 'special' }
          : z.isBox ? { text: '结构', cls: 'special' }
            : null;
    const tags = [
      z.isReversed ? `<span class="pz-rev">反转×${z.flipCount || 1}</span>` : '',
      z.isManual ? '<span class="pz-manual">手动</span>' : '',
      z.isBox ? '<span class="pz-box">箱体</span>' : '',
      er ? '<span class="pz-erode">已收紧</span>' : '',
    ].join('');
    if (!(this._paZoneOpen instanceof Set)) this._paZoneOpen = new Set();
    // 稳定 key：同一只股票重渲染/切排序后，已展开的行不会莫名收起或错位
    const key = `${cls === 'resistance' ? 'R' : 'S'}|${lo}|${hi}|${String(z.source || '').slice(0, 40)}`;
    const open = this._paZoneOpen.has(key);
    const rowCls = `pa-zone-row ${cls}${z.isBox ? ' box-edge' : ''}${z.isManual ? ' manual' : ''}${z.isReversed ? ' reversed' : ''}${open ? ' open' : ''}`;
    return `<div class="${rowCls}" data-zone-key="${this.escapeHtml(key)}" role="button" tabindex="0" aria-expanded="${open ? 'true' : 'false'}">
        <span class="pz-badge ${sm ? sm.cls : 'none'}">${sm ? sm.text : '—'}</span>
        <span class="pz-range">${rangeTxt}</span>
        <span class="pz-src">${this.escapeHtml(z.source || '')}${tags}</span>
        <span class="pz-caret">▾</span>
      </div>
      <div class="pa-zone-detail ${cls}${open ? '' : ' hidden'}">${this._renderZoneDetail(z, cls, zm, { single })}</div>`;
  },

  /** 展开详情：几何 / 来源明细 / 确认信号 / 失效位 / 侵蚀 / 数据说明 */
  _renderZoneDetail(z, cls, zm, ctx) {
    const fmt = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : Storage.formatNumber(v));
    const atr = zm && Number.isFinite(zm.atr) ? zm.atr : null;
    const price = zm && Number.isFinite(zm.price) ? zm.price : null;
    const out = [];

    // ── 几何
    const geo = [];
    if (Number.isFinite(Number(z.center))) geo.push(`中心价 <b>${fmt(z.center)}</b>`);
    const lo = Number(z.low);
    const hi = Number(z.high);
    const width = (Number.isFinite(lo) && Number.isFinite(hi)) ? hi - lo : null;
    if (width != null && width > 0) geo.push(`带宽 <b>${fmt(width)}</b>${atr ? `（ATR×${(width / atr).toFixed(2)}）` : ''}`);
    if (width === 0) geo.push('带宽 <b>单点</b>');
    if (z.methodCount != null) geo.push(`方法 <b>${z.methodCount}</b> / 大周期 <b>${z.majorCount || 0}</b>`);
    if (z.touches != null) geo.push(`近60日触碰 <b>${z.touches}</b> 次${z.lastTouchDate ? `（最近 ${this.escapeHtml(z.lastTouchDate)}）` : ''}`);
    if (price && Number.isFinite(Number(z.center))) {
      const pct = ((Number(z.center) - price) / price) * 100;
      geo.push(`距现价 <b>${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%</b>`);
    }
    if (geo.length) out.push(`<div class="pzd-grid">${geo.map(g => `<span>${g}</span>`).join('')}</div>`);

    // ── 来源明细（用户规范第三部分：每个区域要知道「凭什么这么画」）
    const srcs = Array.isArray(z.sources) ? z.sources : [];
    if (srcs.length) {
      const li = srcs.map(s => {
        const slo = Number(s.low);
        const shi = Number(s.high);
        const rng = (Number.isFinite(slo) && Number.isFinite(shi) && slo !== shi) ? `${fmt(slo)} ~ ${fmt(shi)}` : fmt(slo);
        return `<li>${this.escapeHtml(s.source || s.method || '')}
          <span class="pzd-tier ${s.tier === 'major' ? 'major' : ''}">${s.tier === 'major' ? '大周期' : '日内'}</span>
          <span class="pzd-num">${rng}</span>
          ${s.weakOnly ? '<span class="pzd-weak">仅与其他方法重合时采用</span>' : ''}
          ${s.note ? `<span class="pzd-note">${this.escapeHtml(s.note)}</span>` : ''}</li>`;
      }).join('');
      out.push(`<div class="pzd-sec"><span class="pzd-label">来源明细</span><ul class="pzd-list">${li}</ul></div>`);
    }

    // ── 确认信号
    const sigs = Array.isArray(z.confirmSignals) ? z.confirmSignals : [];
    if (sigs.length) {
      out.push(`<div class="pzd-sec"><span class="pzd-label">确认信号</span><ul class="pzd-list">${sigs.map(s => `<li>${this.escapeHtml(s)}</li>`).join('')}</ul></div>`);
    }

    // ── 失效位 / 失效条件
    if (z.invalidationText) {
      out.push(`<div class="pzd-sec"><span class="pzd-label">失效位</span><b class="pzd-inv">${fmt(z.invalidationLevel)}</b>
        <p class="pzd-text">${this.escapeHtml(z.invalidationText)}</p>
        <p class="pzd-text pzd-dim">判定口径：一律以<b>当日收盘价</b>为准，不认分时价；含 ATR×0.3 缓冲，盘中短暂刺穿不算失效。</p></div>`);
    }

    // ── 特殊条目（反转 / 手动 / 箱体 / 仅过标准1的模型区间）的说明
    const notes = [];
    if (z.isReversed) {
      // 20261103h：手动来源反转的首条说明区分「你手动添加的」与模型区间
      notes.push(z.originManual
        ? `由你手动添加的${z.reversedFrom === 'support' ? '下方支撑' : '上方阻力'}经「放量有效突破」反转而来（累计反转 ${z.flipCount || 1} 次）`
        : `由${z.reversedFrom === 'support' ? '下方支撑' : '上方阻力'}经「放量有效突破」反转而来（累计反转 ${z.flipCount || 1} 次）`);
      notes.push('放量突破后角色互换：支撑被放量下破 → 变阻力；阻力被放量上破 → 变支撑；允许多次反转');
      notes.push('突破/破位/打穿一律以当日收盘价为准，不认分时价');
      const hist = Array.isArray(z.reversalHistory) ? z.reversalHistory : [];
      hist.slice(-3).forEach(h => notes.push(`${h.date || ''} 收盘 ${fmt(h.close)}（量比 ${h.vr}）${h.from === 'support' ? '支撑→阻力' : '阻力→支撑'}`));
      notes.push('待有效性检验（标准1：无放量轻松突破）判无效时自动从记录移除');
    } else if (z.isManual) {
      notes.push('你手动添加的区间（保存在服务端，换设备也在）');
      notes.push('与模型区间走同一条有效性检验（无放量轻松突破 → 无效则不在本清单显示）');
      notes.push('但不参与侵蚀收缩，也不影响方向判断与准确率统计');
    } else if (z.isBox) {
      if (z.note) notes.push(z.note);
      notes.push('该条目为箱体边界（本模块判定），与其余区间的有效性检验是两套独立口径，不参与其过滤');
    } else if (z.zoneCheck) {
      const ck = z.zoneCheck;
      notes.push(ck.lastBreakDate
        ? `最近一次${ck.side === 'resistance' ? '向上突破' : '向下跌破'} ${ck.lastBreakDate}（按当日收盘价判定），量比 ${ck.lastBreakVr == null ? '数据不足' : ck.lastBreakVr}（需 >${ck.breakVolMin} 才算放量；无放量轻松穿越 → 判无效）`
        : `近${ck.lookbackDays}日未发生收盘穿越（该位置尚未被测试，保留）`);
      notes.push('区间有效性已通过检验才展示（仅标准1：无放量轻松突破 → 本次不展示；一律以当日收盘价为准）');
    }
    if (notes.length) {
      out.push(`<div class="pzd-sec"><span class="pzd-label">口径说明</span><ul class="pzd-list">${notes.map(n => `<li>${this.escapeHtml(n)}</li>`).join('')}</ul></div>`);
    }

    // ── 侵蚀
    const er = z.erosion;
    if (er) {
      out.push(`<div class="pzd-sec"><span class="pzd-label">侵蚀</span>
        <p class="pzd-text">${this.escapeHtml(`${er.date || '近'} 收盘 ${er.close} 侵入区间内部（量比 ${er.vr} ≤ ${er.volRatioMax}，未放量且未打穿）→ 区间由 ${er.rangeFrom} 收紧为 ${er.rangeTo}，远端不变`)}</p>
        ${er.guardNote ? `<p class="pzd-text pzd-warn">${this.escapeHtml(er.guardNote)}</p>` : ''}</div>`);
    }

    // ── 备注（来源方法自带的短说明）
    if (z.note && !z.isBox) out.push(`<p class="pzd-text pzd-dim pzd-note-line">${this.escapeHtml(z.note)}</p>`);
    return out.join('');
  },

  /** 展开/收起 + 排序切换（每次重渲染后重新绑定，DOM 是新的） */
  _wireZoneToggle(stEl) {
    if (!(this._paZoneOpen instanceof Set)) this._paZoneOpen = new Set();
    stEl.querySelectorAll('.pa-zone-row[data-zone-key]').forEach(row => {
      const toggle = () => {
        const key = row.getAttribute('data-zone-key');
        const panel = row.nextElementSibling;
        const isOpen = row.classList.toggle('open');
        if (panel && panel.classList.contains('pa-zone-detail')) panel.classList.toggle('hidden', !isOpen);
        row.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
        if (isOpen) this._paZoneOpen.add(key); else this._paZoneOpen.delete(key);
      };
      row.addEventListener('click', toggle);
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      });
    });
  },

  renderPriceAction(data) {
    const { longTerm, shortTerm, coordination, falsification, meta } = data;
    const metaEl = document.getElementById('paMeta');
    if (metaEl) metaEl.textContent = `K线 ${meta.range} · 日K ${meta.dailyBars} 根 / 月K ${meta.monthlyBars} 根 · ${meta.source}`;

    // 20260914i：技术面准确率条（未来 5 个交易日口径，后端随 /api/price-action 一并返回）
    this.renderTechFaceAccuracy(data.accuracy);

    // 顶部速览条
    const summaryEl = document.getElementById('paSummary');
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="pa-sum-chip"><span class="psc-label">长期趋势</span><span class="psc-value ${this._paVerdictClass(longTerm.verdict)}">${longTerm.verdict}</span></div>
        <div class="pa-sum-chip"><span class="psc-label">短期动向</span><span class="psc-value ${this._paVerdictClass(shortTerm.direction)}">${shortTerm.direction}（概率${shortTerm.probability}）</span></div>
        <div class="pa-sum-chip"><span class="psc-label">推演场景</span><span class="psc-value side">${this.escapeHtml(coordination.scenario)}</span></div>
        <div class="pa-sum-chip"><span class="psc-label">主导力量</span><span class="psc-value neutral">${this.escapeHtml(coordination.dominant)}</span></div>
      `;
    }

    // 1. 长期趋势定性
    const ltEl = document.getElementById('paLongTerm');
    if (ltEl) {
      ltEl.innerHTML = `
        <h4>① 长期趋势定性 <span class="pa-verdict ${this._paVerdictClass(longTerm.verdict)}">${longTerm.verdict}</span></h4>
        <ul class="pa-evidence">${longTerm.evidence.map(e => `<li>${this.escapeHtml(e)}</li>`).join('')}</ul>
      `;
    }

    // 2. 短期动向预判（未来1-5个交易日）
    const stEl = document.getElementById('paShortTerm');
    if (stEl) {
      // 20261020j：②卡恢复箱体，但改为「单箱体精简一行」；20261020i 删掉的是旧「固定多窗口」表格版。
      // 20261022g：区间清单改为「共振带」——后端（zoneMethods + zoneResonance）已按 10 种方法
      //   （筹码/枢轴/均线/斐波那契/VWAP/整数关口/缺口/趋势线/摆动点 + 周线层）聚类合并，
      //   并为每条带给出强度、确认信号、失效位。前端只做展示，不重算任何数。
      //
      // 展示仍先过有效性检验（lib/zoneValidity.js，仅剩标准1）：
      //   标准1 最近一次方向性穿越日量比 ≤1.2（不需要放量就突破/跌破）→ 本次不展示、不落永久黑名单
      // 用户决策（20261022g）：「紧凑清单 + 点开看详情」——默认只显示强度徽标 + 区间 + 来源摘要，
      //   点开才展开来源明细 / 确认信号 / 失效位 / 侵蚀与数据说明，保证一屏可读且信息不丢。
      const boxRow = this._renderSingleBoxRow(data.singleRange);
      const validOnly = (arr) => (arr || []).filter(z => z && z.valid !== false);
      // 20261020k：箱体上下限并入「上方关键阻力区间 / 下方关键支撑区间」（用户要求合并展示）。
      // 铁律：箱体条目 isBox=true，**不得**交给 zoneValidity 过滤（两套检验必须独立），
      // 箱体是否失效只由 rangeDetector「连续 3 日突破」判定；有效性过滤只作用于模型/手动区间。
      const edges = (data.singleRange && data.singleRange.edges) || null;
      const asZone = (e) => (e ? { low: e.price, high: e.price, source: e.source, isBox: true, note: e.note } : null);
      const boxRes = asZone(edges && edges.upper);
      const boxSup = asZone(edges && edges.lower);
      // 20261021e：手动区间**由后端并入** shortTerm.resistances/supports（同一条有效性检验），
      // 前端不再自己 concat，否则会重复渲染两条；是否展示统一按 valid !== false 过滤。
      const mz = this.manualZones || this._emptyManualZones();
      const resAll = this._sortZones(validOnly(shortTerm.resistances).concat(boxRes ? [boxRes] : []), 'resistance');
      const supAll = this._sortZones(validOnly(shortTerm.supports).concat(boxSup ? [boxSup] : []), 'support');
      const mzCount = (mz.resistances || []).length + (mz.supports || []).length;
      stEl.innerHTML = `
        <h4>② 短期动向预判（1-5个交易日） <span class="pa-verdict ${this._paVerdictClass(shortTerm.direction)}">${shortTerm.direction} · 概率${shortTerm.probability}</span></h4>
        <div class="pa-tabs">
          <button type="button" class="pa-tab active" data-pa-tab="model">模型判定</button>
          <button type="button" class="pa-tab" data-pa-tab="manual">手动添加${mzCount ? `<span class="pa-tab-badge">${mzCount}</span>` : ''}</button>
        </div>
        <div class="pa-tab-body" data-pa-body="model">
          <ul class="pa-evidence">${shortTerm.evidence.map(e => `<li>${this.escapeHtml(e)}</li>`).join('')}</ul>
          ${boxRow}
          ${this._renderZoneMetaBar(shortTerm.zoneMethods, resAll, supAll)}
          ${resAll.length ? `<div class="pa-zone-title resistance">上方关键阻力区间<span class="pa-zone-count">${resAll.length}</span></div>${resAll.map(z => this._renderZoneRow(z, 'resistance', shortTerm.zoneMethods)).join('')}` : ''}
          ${supAll.length ? `<div class="pa-zone-title support">下方关键支撑区间<span class="pa-zone-count">${supAll.length}</span></div>${supAll.map(z => this._renderZoneRow(z, 'support', shortTerm.zoneMethods)).join('')}` : ''}
        </div>
        <div class="pa-tab-body hidden" data-pa-body="manual">${this._renderManualZonesPanel(shortTerm)}</div>
      `;
      this._wireZoneToggle(stEl);
      this._wirePriceActionTabs(stEl);
    }

    // 3. 长短周期协调性评估
    const coEl = document.getElementById('paCoord');
    if (coEl) {
      coEl.innerHTML = `
        <h4>③ 长短周期协调性评估 <span class="pa-verdict ${coordination.consistent ? 'up' : 'side'}">${coordination.consistent ? '趋势一致' : '长短背离'}</span></h4>
        <div class="pa-scenario">${this.escapeHtml(coordination.scenario)}</div>
        <p class="pa-scenario-text">${this.escapeHtml(coordination.text)}</p>
        <div class="pa-dom-row"><span class="pd-label">最终主导力量预判</span><span class="pd-value">${this.escapeHtml(coordination.dominant)}</span></div>
      `;
    }

    // 4. 趋势延续与反转的量化边界
    const edEl = document.getElementById('paEdges');
    if (edEl) {
      edEl.innerHTML = `
        <h4>④ 趋势延续与反转的量化边界</h4>
        <ul class="pa-edges">${falsification.edges.map(e => `<li><span class="pe-cond">${this.escapeHtml(e.condition)}</span><span class="pe-effect">${this.escapeHtml(e.effect)}</span></li>`).join('')}</ul>
      `;
    }

    // 图表：月线趋势结构 + 成交密集区（独立容错：图表失败不影响上方卡片）
    const chartError = (id, msg) => {
      try {
        if (Charts.instances && Charts.instances[id]) { Charts.instances[id].dispose(); delete Charts.instances[id]; }
      } catch {}
      const el = document.getElementById(id);
      if (el) {
        el.removeAttribute('_echarts_instance_');
        el.innerHTML = `<div class="pa-error"><span class="pe-icon">⚠️</span><span>${this.escapeHtml(msg)}</span></div>`;
      }
    };
    try {
      if (typeof Charts !== 'undefined' && data.charts && data.charts.monthly) {
        Charts.paMonthly('paMonthlyChart', data.charts.monthly, data.charts.trendline);
      }
    } catch (e) {
      console.error('paMonthly render error:', e);
      chartError('paMonthlyChart', '月线图渲染失败：' + e.message);
    }
    try {
      if (typeof Charts !== 'undefined' && data.charts && data.charts.profile) {
        Charts.paProfile('paProfileChart', data.charts.profile);
      }
    } catch (e) {
      console.error('paProfile render error:', e);
      chartError('paProfileChart', '密集区图渲染失败：' + e.message);
    }
  },

  // ---- Technical tab ----
  renderTechnical(data) {
    const { history, technical, quote } = data;
    if (!technical || technical.error) return;

    // 技术面数据日期范围（用于标注来源时效）
    const firstDate = history?.length ? history[0].date : '';
    const lastDate = history?.length ? history[history.length - 1].date : (quote?.date || '');
    const techDateNote = lastDate ? `K线 ${firstDate && firstDate !== lastDate ? firstDate + ' ~ ' + lastDate : lastDate} · 本地计算` : '本地计算';

    // 技术指标信号 + 支撑阻力（从概览迁移至此，issue6）
    if (technical.signals) {
      const s = technical.signals;
      const signalClass = v => {
        if (['上升趋势', '多头', '金叉', '偏多', '超卖', '放量', '温和放量'].includes(v)) return 'positive';
        if (['下降趋势', '空头', '死叉', '偏空', '超买'].includes(v)) return 'negative';
        return 'neutral';
      };
      const metaEl = document.getElementById('signalGridMeta');
      if (metaEl) metaEl.textContent = techDateNote;
      const sigEl = document.getElementById('signalSummary');
      if (sigEl) sigEl.innerHTML = [
        { label: '趋势', value: s.trend },
        { label: 'RSI', value: s.rsiSignal },
        { label: 'MACD', value: s.macdSignal },
        { label: 'KDJ', value: s.kdjSignal },
        { label: '布林带', value: s.bollPosition },
        { label: '成交量', value: `${s.volumeTrend}(${s.volumeRatio})` },
      ].map(sig => `
        <div class="signal-item" title="${sig.label} · ${techDateNote}">
          <span class="sig-label">${sig.label}</span>
          <span class="sig-value ${signalClass(sig.value)}">${sig.value}</span>
        </div>
      `).join('');
    }
    Charts.macd('macdChart', history, technical);
    Charts.rsi('rsiChart', history, technical);
    Charts.kdj('kdjChart', history, technical);
    Charts.boll('bollChart', history, technical);

    // 各指标结论与论证（需求4）
    this.renderTechnicalConclusions(technical);

    // Volume analysis
    if (technical.signals) {
      const s = technical.signals;
      const ind = technical.indicators;
      document.getElementById('volumeAnalysis').innerHTML = `
        <div class="vol-meta">${techDateNote}</div>
        <div class="vol-item"><span class="vl-label">成交量趋势</span><span class="vl-value">${s.volumeTrend}</span></div>
        <div class="vol-item"><span class="vl-label">量比</span><span class="vl-value">${s.volumeRatio}</span></div>
        <div class="vol-item"><span class="vl-label">RSI(14)</span><span class="vl-value">${ind?.rsi || '--'}</span></div>
        <div class="vol-item"><span class="vl-label">MACD柱</span><span class="vl-value">${ind?.macd?.histogram || '--'}</span></div>
        <div class="vol-item"><span class="vl-label">MA5</span><span class="vl-value">${ind?.ma5 || '--'}</span></div>
        <div class="vol-item"><span class="vl-label">MA20</span><span class="vl-value">${ind?.ma20 || '--'}</span></div>
        <div class="vol-item"><span class="vl-label">MA60</span><span class="vl-value">${ind?.ma60 || '--'}</span></div>
        <div class="vol-item"><span class="vl-label">布林上轨</span><span class="vl-value">${ind?.boll?.upper || '--'}</span></div>
      `;
    }
  },

  // ---- 技术面各指标「结论 + 论证」（需求4） ----
  renderTechnicalConclusions(technical) {
    const s = technical?.signals;
    const ind = technical?.indicators;
    if (!s) return;
    const captions = {
      macdChart: this._macdConclusion(s, ind),
      rsiChart: this._rsiConclusion(s, ind),
      kdjChart: this._kdjConclusion(s, ind),
      bollChart: this._bollConclusion(s, ind),
    };
    for (const [id, text] of Object.entries(captions)) {
      if (!text) continue;
      const chartEl = document.getElementById(id);
      if (!chartEl) continue;
      const card = chartEl.closest('.chart-card') || chartEl.parentElement;
      const prev = card.querySelector(':scope > .chart-conclusion');
      if (prev) prev.remove();
      const cap = document.createElement('div');
      cap.className = 'chart-conclusion';
      cap.innerHTML = `<span class="cc-icon">💡</span><span>${text}</span>`;
      card.appendChild(cap);
    }
  },

  _macdConclusion(s, ind) {
    const sig = s.macdSignal;
    let txt = `MACD 当前为「${sig}」`;
    if (ind?.macd?.histogram !== undefined && ind?.macd?.histogram !== null) {
      txt += `，柱值 ${Storage.formatNumber(ind.macd.histogram)}`;
    }
    if (sig.includes('金叉')) txt += '，短线动能转强，偏多信号。';
    else if (sig.includes('死叉')) txt += '，短线动能转弱，偏空信号。';
    else if (sig === '多头') txt += '，DIF 位于信号线上方，多头排列。';
    else if (sig === '空头') txt += '，DIF 位于信号线下方，空头排列。';
    else txt += '，多空力量相对均衡。';
    return txt;
  },

  _rsiConclusion(s, ind) {
    const v = ind?.rsi;
    let txt = `RSI(14) 当前 ${typeof v === 'number' ? Storage.formatNumber(v) : '--'}（${s.rsiSignal}）`;
    if (s.rsiSignal === '超买') txt += '，已进入超买区，注意回调风险。';
    else if (s.rsiSignal === '超卖') txt += '，已进入超卖区，关注反弹机会。';
    else if (s.rsiSignal === '偏强') txt += '，动能偏强。';
    else if (s.rsiSignal === '偏弱') txt += '，动能偏弱。';
    else txt += '，处于中性区间。';
    return txt;
  },

  _kdjConclusion(s, ind) {
    let txt = `KDJ 当前「${s.kdjSignal}」`;
    const j = ind?.kdj?.j;
    if (typeof j === 'number') {
      if (j > 100) txt += '，J 值 >100 超买。';
      else if (j < 0) txt += '，J 值 <0 超卖。';
    }
    return txt;
  },

  _bollConclusion(s) {
    return `布林带位置：${s.bollPosition}，反映股价在通道中的相对高低。${s.bollPosition.includes('上轨') ? '贴近上轨，短期偏强但注意回落。' : s.bollPosition.includes('下轨') ? '贴近下轨，短期偏弱但关注反弹。' : ''}`;
  },

  // ---- Fundamental tab ----
  renderFundamental(data) {
    const { fundamental, companyType } = data;
    if (!fundamental || fundamental.error) {
      document.getElementById('fundScoreBreakdown').innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:40px;">暂无基本面数据</p>';
      return;
    }

    // Company type badge
    const badgeEl = document.getElementById('fundCompanyTypeBadge');
    if (badgeEl && companyType) {
      badgeEl.className = 'company-type-badge ' + (companyType.type || 'balanced');
      badgeEl.innerHTML = `${companyType.typeIcon || ''} ${companyType.typeName || ''} — ${companyType.focusText || ''}`;
      badgeEl.style.display = 'inline-flex';
    } else if (badgeEl) {
      badgeEl.style.display = 'none';
    }

    // Score breakdown
    const scores = fundamental.scores || {};
    const colors = { valuation: '#3b82f6', profitability: '#f59e0b', growth: '#22c55e', health: '#8b5cf6' };
    let breakdownHTML = '';
    for (const [key, val] of Object.entries(scores)) {
      const pct = (val.score / val.max) * 100;
      const color = colors[key] || '#3b82f6';
      breakdownHTML += `
        <div class="score-bar-item">
          <div class="score-bar-header">
            <span class="score-bar-label">${val.label}</span>
            <span class="score-bar-value">${val.score}/${val.max}</span>
          </div>
          <div class="score-bar-track">
            <div class="score-bar-fill" style="width:${pct}%;background:${color}"></div>
          </div>
        </div>
      `;
    }
    document.getElementById('fundScoreBreakdown').innerHTML = breakdownHTML;

    // Metrics table
    const m = fundamental.metrics || {};
    const qf = data.quote?.fundamentals || {};
    const finLabel = qf.reportPeriod || qf.reportDate || '';
    const priceDate = data.quote?.date || '—';
    const comp = data.comparison || {};
    const pctOf = comp.percentiles || {};
    const ind = comp.industryAvg || {};
    const ocfLabel = qf.operatingCashFlowPeriodName || finLabel || '';
    // 去年同期：按「去年同月日」报告期精确匹配（zyzbHistory 为降序多期序列，最新在前）。
    // 20260909j 修复：原 zyzb[zyzb.length-2] 在降序序列中取到的是接近最早期的数据（如 300319 实际取到 2024-09-30 的值），并非去年同期。
    const zyzb = Array.isArray(qf.zyzbHistory) ? qf.zyzbHistory : [];
    const latestZyzb = zyzb.length ? zyzb[0] : null;
    const priorYoy = (() => {
      if (!latestZyzb) return null;
      const ld = String(latestZyzb.REPORT_DATE || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}/.test(ld)) return null;
      const tgt = (parseInt(ld.slice(0, 4), 10) - 1) + ld.slice(4);
      return zyzb.find(x => String(x.REPORT_DATE || '').slice(0, 10) === tgt) || null;
    })();
    // 20261102a（用户指令：指标优先最新单季口径）：单季同比优先——DJD_* 为东财主要指标行内自带「单季同比」字段，
    // 缺失时回退报告期累计同比（*_TZ），与 lib/fundamentalScore/analysis/metricAnalysis 同口径。
    const parsePct = (v) => { const n = parseFloat(v); return (v == null || isNaN(n)) ? null : n; };
    const yoyRaw = (row, sqKey, cumKey) => (row == null) ? null : (row[sqKey] != null ? row[sqKey] : row[cumKey]);
    const priorRevenueYoy = priorYoy && !isNaN(parseFloat(yoyRaw(priorYoy, 'DJD_TOI_YOY', 'TOTALOPERATEREVETZ'))) ? parsePct(yoyRaw(priorYoy, 'DJD_TOI_YOY', 'TOTALOPERATEREVETZ')) : null;
    const priorProfitYoy = priorYoy && !isNaN(parseFloat(yoyRaw(priorYoy, 'DJD_DPNP_YOY', 'PARENTNETPROFITTZ'))) ? parsePct(yoyRaw(priorYoy, 'DJD_DPNP_YOY', 'PARENTNETPROFITTZ')) : null;
    // ROE 去年同期：优先与当前值同口径的 TTM（取数层 roeTtmPrev）；无则回退同期披露加权 ROE(ROEJQ)，文字明确标注口径
    const priorRoeTtm = (typeof qf.roeTtmPrev === 'number') ? qf.roeTtmPrev : null;
    const priorRoeJQ = priorYoy && !isNaN(parseFloat(priorYoy.ROEJQ)) ? parseFloat(priorYoy.ROEJQ) : null;
    const priorRoeTxt = priorRoeTtm != null
      ? `去年同期(TTM同口径) ${priorRoeTtm.toFixed(2)}%`
      : (priorRoeJQ != null ? `去年同期(同期加权) ${priorRoeJQ.toFixed(2)}%` : null);
    // 扣非净利润同比：与营收/归母同源，取自东财 ZYZBAjaxNew 主要指标（zyzbHistory.KCFJCXSYJLRTZ）
    // ★ 20260923m 修复：去年同期原先取 `zyzb[zyzb.length - 2]`（降序序列的倒数第二项 ≈ 接近最早的一期），
    //   与上方 priorYoy / priorRevenueYoy / priorProfitYoy 的「去年同期·同报告期」口径不一致。
    //   实证 长江证券 000783：最新期 2026-06-30 扣非同比 +84.93%，去年同期应为 2025-06-30 的 +123.28%；
    //   旧写法却取到 2024-09-30 的 +21.06% → 左卡显示「去年同期 21.06%」，而右卡「指标分析」/「判定依据」
    //   显示「去年同期 123.3%」，同一只股票同一指标两处打架。
    //   现统一改用 priorYoy（同上「去年同月日报告期」精确匹配），与 lib/metricAnalysis.js `samePeriodPair`、
    //   lib/analysis.js `samePeriodYoY`、lib/fundamentalScore.js `yoyPair` 三处保持同一口径。
    //   20261102a：扣非去年同期同样「单季优先」（DJD_DEDUCTDPNP_YOY），缺失回退累计 KCFJCXSYJLRTZ。
    const priorDedYoy = priorYoy ? parsePct(yoyRaw(priorYoy, 'DJD_DEDUCTDPNP_YOY', 'KCFJCXSYJLRTZ')) : null;
    // 数据期标注：报表指标引用具体财报期；估值类为 TTM；股息率为历史分红（均非财报期）
    const stmtPeriod = finLabel ? '财报 ' + finLabel : '';
    const valPeriod = 'TTM';
    const divPeriod = 'TTM·分红';
    const ocflowPeriod = ocfLabel ? '财报 ' + ocfLabel : stmtPeriod;
    const rows = [
      // ★ 20260923l：估值三项由 `m.pe?.toFixed(2)` 改为「真值判定」——与右卡「指标分析」统一 0/-- 口径
      //   （0 的 PE/PB/PS 不是可信数值，属兜底哨兵 → 显示 `--` 而非 `0.00`）。
      ['市盈率(PE·TTM)', m.pe ? m.pe.toFixed(2) : '--', `PE(TTM) · 总市值 ÷ 近12个月归母净利（滚动12个月，随行情每日更新，不绑定财报期） · 来源：${qf.peSource || '行情数据'}`, { indKey: 'pe', pctKey: 'pe' }, valPeriod],
      ['市净率(PB)', m.pb ? m.pb.toFixed(2) : '--', `PB · 股价 ${priceDate} ÷ 每股净资产${finLabel ? '(财报 ' + finLabel + ')' : ''} · 来源：${qf.pbSource || '行情数据'}`, { indKey: 'pb', pctKey: 'pb' }, valPeriod],
      [(qf.psSource && String(qf.psSource).indexOf('PS_TTM') >= 0) ? '市销率(PS·TTM)' : '市销率(PS)', m.ps ? m.ps.toFixed(2) : '--', (qf.psSource && String(qf.psSource).indexOf('PS_TTM') >= 0) ? `PS(TTM) · 总市值 ÷ 近12个月营收（滚动12个月，随行情更新） · 来源：${qf.psSource || '东方财富估值(PS_TTM)'}` : `PS · 总市值 ÷ 最新一期营收（财报 ${finLabel}，单期口径非TTM） · 来源：${qf.psSource || '本地计算'}`, { indKey: null, pctKey: 'ps' }, (qf.psSource && String(qf.psSource).indexOf('PS_TTM') >= 0) ? valPeriod : stmtPeriod],
      ['PEG', m.peg > 0 ? m.peg.toFixed(2) : '--', 'PEG · 当前行情数据源未提供该字段（PE(TTM)÷盈利增速），本工具不做估算，避免展示无依据数值', { indKey: null, pctKey: null }, '--'],
      ['ROE', m.roe ? m.roe.toFixed(2) + '%' : '--',
        qf.roeTtm != null
          ? `ROE(TTM) = 近12个月归母净利 ÷ 期末归母净资产（滚动12个月，与深度分析 ROE 走势图同源一致） · 来源：${qf.roeSource || '东方财富财报'}`
          : `ROE · 归母净利润 ÷ 净资产${finLabel ? '(财报 ' + finLabel + ')' : ''} · 来源：${qf.roeSource || '财报数据'}`,
        { indKey: 'roe', pctKey: 'roe', prior: priorRoeTxt }, qf.roeTtm != null ? valPeriod : stmtPeriod],
      ['毛利率', m.grossMargin ? m.grossMargin.toFixed(2) + '%' : '--',
        qf.grossMarginTtm != null
          ? `毛利率(TTM) = 近12个月毛利额 ÷ 近12个月营收（滚动12个月） · 来源：${qf.reportSource || '东方财富财报'}`
          : `毛利率 · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`,
        { indKey: null, pctKey: 'grossMargin' }, qf.grossMarginTtm != null ? valPeriod : stmtPeriod],
      ['净利率', m.netMargin ? m.netMargin.toFixed(2) + '%' : '--',
        qf.netMarginTtm != null
          ? `净利率(TTM) = 近12个月净利额 ÷ 近12个月营收（滚动12个月） · 来源：${qf.reportSource || '东方财富财报'}`
          : `净利率 · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`,
        { indKey: null, pctKey: 'netMargin' }, qf.netMarginTtm != null ? valPeriod : stmtPeriod],
      ['营收增长', m.revenueGrowth ? m.revenueGrowth.toFixed(2) + '%' : '--', `营收同比增长（单季优先，缺单季回退累计口径） · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: 'revenueGrowth', prior: priorRevenueYoy != null ? `去年同期单季 ${priorRevenueYoy.toFixed(2)}%` : null }, finLabel ? '财报 ' + finLabel + ' · 单季优先' : ''],
      ['归母净利润', m.profitGrowth ? m.profitGrowth.toFixed(2) + '%' : '--', `归母净利润同比增长（单季优先，缺单季回退累计口径） · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: 'profitGrowth', prior: priorProfitYoy != null ? `去年同期单季 ${priorProfitYoy.toFixed(2)}%` : null }, finLabel ? '财报 ' + finLabel + ' · 单季优先' : ''],
      ['扣非净利润增长', m.deductedProfitGrowth ? m.deductedProfitGrowth.toFixed(2) + '%' : '--', `扣非归母净利润同比增长（单季优先，缺单季回退累计口径） · 来源：东方财富财报${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: null, prior: priorDedYoy != null ? `去年同期单季 ${priorDedYoy.toFixed(2)}%` : null }, finLabel ? '财报 ' + finLabel + ' · 单季优先' : ''],
      ['资产负债率', m.debtToEquity ? m.debtToEquity.toFixed(2) + (m.debtMetricPct ? '%' : '') : '--', `资产负债率 · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: 'debtToEquity' }, stmtPeriod],
      ['流动比率', m.currentRatio ? m.currentRatio.toFixed(2) : '--', `流动比率 · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: 'currentRatio' }, stmtPeriod],
      ['股息率(TTM)', m.dividendYield ? m.dividendYield.toFixed(2) + '%' : '--', '股息率(TTM) = 近12个月已实施除息的每股分红合计 ÷ 当前股价（滚动12个月口径；无近12个月分红记录时回退最近完整年度） · 来源：东方财富分红数据', { indKey: null, pctKey: null }, divPeriod],
      ['每股经营现金流', m.operatingCashFlowPerShare ? m.operatingCashFlowPerShare.toFixed(2) : '--', `每股经营现金流 = 经营现金流净额 ÷ 总股本${ocfLabel ? ' · 财报 ' + ocfLabel : ''} · 来源：${qf.operatingCashFlowSource || '东方财富财报'}`, { indKey: null, pctKey: null }, ocflowPeriod],
    ];
    // ★ 20261029a：在「扣非净利润增长」之后条件插入「营运利润」(全个股) 与「NBV(新业务价值)」(保险股专属)。
    //   数据由 /api/analysis 下发（opProfit / insuranceNBV），取不到时整行不渲染（左右两卡一致，绝不编造）。
    {
      const _dedIdx = rows.findIndex(r => r[0] === '扣非净利润增长');
      const _ins = [];
      const opP = data.opProfit;
      // 20261102a（用户指令：指标优先最新单季口径）：营运利润优先展示最新单季（sqCur = 本期累计 − 上期累计，Q1 单季=累计），
      // 单季不可得（缺上期累计等）时如实回退累计并标注，绝不编造。
      const _opSqOk = !!(opP && opP.sqCur && typeof opP.sqCur.opProfitYi === 'number');
      if (opP && opP.cur && typeof opP.cur.opProfitYi === 'number') {
        _ins.push(['营运利润', _opSqOk ? opP.sqCur.opProfitYi.toFixed(2) + '亿' : opP.cur.opProfitYi.toFixed(2) + '亿',
          `营业利润 = 营业收入 − 营业成本 − 税金及附加 − 期间费用 + 投资收益等（利润表中段科目，未扣所得税/少数股东损益，与扣非净利润口径不同）${_opSqOk ? ' · 当前为<b>最新单季</b>（本期累计 − 上期累计差分）' : ' · 单季值不可得（缺上期累计），已如实回退<b>累计口径</b>'} · 来源：东方财富 F10 利润表 OPERATE_PROFIT`,
          { indKey: null, pctKey: null, prior: _opSqOk ? ((opP.sqPrev && typeof opP.sqPrev.opProfitYi === 'number') ? `去年同期单季 ${opP.sqPrev.opProfitYi.toFixed(2)}亿` : null) : ((opP.prev && typeof opP.prev.opProfitYi === 'number') ? `去年同期同报告期 ${opP.prev.opProfitYi.toFixed(2)}亿` : null) }, '财报 ' + opP.cur.date + (_opSqOk ? ' · 单季' : ' · 累计')]);
      }
      const nbvS = data.insuranceNBV;
      if (nbvS && typeof nbvS.valueYi === 'number') {
        _ins.push(['NBV(新业务价值)', nbvS.valueYi.toFixed(2) + '亿',
          `NBV = 新签保单未来可贡献利润的折现值（寿险新业务造血能力，保险股专属） · ${nbvS.periodText || ''}累计口径 · 来源：${nbvS.source || '备查库'}`,
          { indKey: null, pctKey: null, prior: (nbvS.prevValueYi != null) ? `去年同期同阶段 ${nbvS.prevLabel || ''} ${nbvS.prevValueYi.toFixed(2)}亿` : null }, nbvS.label ? ('报告期 ' + nbvS.label) : '']);
      }
      if (_ins.length) {
        if (_dedIdx >= 0) rows.splice(_dedIdx + 1, 0, ..._ins);
        else rows.push(..._ins);
      }
    }
    // 卡片级数据期说明（报表指标 vs 估值指标，避免把 TTM 误读为财报期）
    const periodNote = `报表指标引用：<b>${finLabel || '—'}</b>${qf.reportDate ? '（' + qf.reportDate + '）' : ''} · 来源 ${qf.reportSource || '东方财富财报'} ｜ 估值指标 PE/PS 为 TTM 滚动口径（截至 ${priceDate}）· PB 为最新报告期账面值 · 股息率为 TTM 口径（近12个月实际分红）`;
    // 指标行按信号着色：利好(红)/利空(绿)
    const sigMap = {};
    (data.signals?.signals || []).forEach(s => { sigMap[s.key] = s; });
    // ★ 20261103d：五维多数决统一判定——左卡徽标消费与右卡/顶栏同一 judgment（单一数据源）；
    //   多数决与信号判定冲突时 reason 已带「已按多数决为准」标注，悬停判定依据可见。
    (data.metricAnalysis?.metrics || []).forEach(mm => { if (mm && mm.key && mm.judgment) sigMap[mm.key] = mm.judgment; });
    const keyOf = (label) => ({ '市盈率(PE)': 'pe', '市盈率(PE·TTM)': 'pe', '市净率(PB)': 'pb', '市销率(PS)': 'ps', '市销率(PS·TTM)': 'ps', 'PEG': 'peg', 'ROE': 'roe', '毛利率': 'grossMargin', '净利率': 'netMargin', '营收增长': 'growth', '归母净利润': 'profitGrowth', '扣非净利润增长': 'dedProfitGrowth', '营运利润': 'opProfit', 'NBV(新业务价值)': 'nbv', '资产负债率': 'debt', '流动比率': 'currentRatio', '股息率': 'div', '股息率(TTM)': 'div', '每股经营现金流': 'ocf' }[label]);
    const metricsEl = document.getElementById('fundMetrics');
    const periodNoteHtml = `<div class="metrics-period-note">${periodNote}</div>`;
    metricsEl.innerHTML = periodNoteHtml + rows.map(r => {
      const s = keyOf(r[0]) ? sigMap[keyOf(r[0])] : null;
      const cls = s ? (s.signal === 'bull' ? ' sig-bull' : s.signal === 'bear' ? ' sig-bear' : ' sig-neutral') : '';
      const tag = s ? (s.signal === 'bull' ? '<span class="mr-tag bull">利好</span>' : s.signal === 'bear' ? '<span class="mr-tag bear">利空</span>' : '<span class="mr-tag neutral">中性</span>') : '';
      const help = METRIC_HELP[r[0]] ? `<span class="metric-help" data-help="${r[0]}" title="点击查看释义">?</span>` : '';
      const extra = r[3] || {};
      const extras = [];
      if (r[4]) extras.push(`<span class="mr-period">${r[4]}</span>`);
      if (extra.prior) extras.push(extra.prior);
      if (extra.indKey && ind[extra.indKey] != null && ind[extra.indKey] !== 0) {
        extras.push(`行业均值 ${Number(ind[extra.indKey]).toFixed(2)}${r[0] === 'ROE' ? '%' : ''}`);
      }
      if (extra.pctKey != null && pctOf[extra.pctKey] != null) {
        extras.push(`历史百分位 ${pctOf[extra.pctKey]}%`);
      }
      const extraHtml = extras.length ? `<div class="mr-extra">${extras.join(' · ')}</div>` : '';
      // ★ 20261013i：每个指标右侧加「分析」tab，点击展示右卡「指标分析」对应卡片（20261013j 按需单卡）。
      //   键口径：左卡 keyOf(label) ↔ 右卡 metricAnalysis.metrics[].key（同一套 14 键，单一权威）。
      // ★ 20261013j：激活态在渲染时按 this.activeMetricKey 直接带上——实时刷新/切股重渲染后不丢失。
      const jumpKey = keyOf(r[0]);
      const jump = jumpKey
        ? `<button type="button" class="metric-jump${this.activeMetricKey === jumpKey ? ' active' : ''}" data-key="${jumpKey}" title="查看「${r[0]}」的指标分析">分析<span class="metric-jump-arrow">▸</span></button>`
        : '';
      return `<div class="metric-row${cls}" title="${r[2] || ''}">
        <span class="mr-label">${r[0]}${help}</span>
        <span class="mr-value">${r[1] || '--'}${tag}${extraHtml}</span>
        ${jump}
      </div>`;
    }).join('');
    // 指标释义「?」图标：点击展开浮层
    metricsEl.querySelectorAll('.metric-help').forEach(el => {
      el.addEventListener('click', (e) => { e.stopPropagation(); this.showMetricHelp(el.dataset.help, el); });
    });
    // ★ 20261104m：「分析」tab 点击 → 在该指标行正下方展开行内分析面板（手风琴，与指标行同一水平），
    //   右卡「指标分析」同步显示当前项；再次点击同一 tab 收起（移除面板 + 右卡回空态）。
    //   右卡数据缺失时 toast 明示，不静默失败。
    metricsEl.querySelectorAll('.metric-jump').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.key;
        if (!key) return;
        const next = (this.activeMetricKey === key) ? null : key; // 再次点击当前项 → 收起
        if (next && !document.querySelector('#metricAnalysis .ma-row[data-key="' + next + '"]')) {
          this.toast('该指标暂无分析数据', 'info', 2000);
          return;
        }
        this.showMetricAnalysis(next, next ? btn.closest('.metric-row') : null);
      });
    });

    // 指标分析（20260919a）：替代原「分析师评级」——对左侧「关键财务指标」做确定性五维对比 + 判定依据
    const maEl = document.getElementById('metricAnalysis');
    if (maEl) maEl.innerHTML = this.renderMetricAnalysis(data.metricAnalysis, this.activeMetricKey); // 20261104l：按需单卡，激活态重渲染不丢

    // ★ 20261104m：重渲染（实时刷新/切股）后恢复行内展开面板——分析内容与所点指标行同水平的
    //   展开状态在 DOM 重建后会丢失，按 activeMetricKey 重新展开到对应行下方；指标已不存在时清空选择。
    if (this.activeMetricKey) {
      const kEl = metricsEl.querySelector('.metric-jump[data-key="' + this.activeMetricKey + '"]');
      if (kEl) {
        this.showMetricAnalysis(this.activeMetricKey, kEl.closest('.metric-row'));
      } else {
        this.activeMetricKey = null;
      }
    }

    // 基本面结论 + 论证过程（需求3/4）
    const fc = this.buildFundamentalConclusion(fundamental);
    const fcEl = document.getElementById('fundConclusion');
    if (fcEl && fc) {
      fcEl.style.display = '';
      const hasR = fc.reasoning.length > 0;
      let html = `<h3>📋 基本面结论</h3><div class="section-conclusion"><div class="sc-summary"><span class="sc-icon">📌</span><span>${fc.conclusion}</span></div>`;
      if (hasR) {
        html += `<button type="button" class="sc-toggle" id="fundToggle">查看论证过程 ▾</button>`;
        html += `<div class="sc-reasoning hidden" id="fundReasoning">${fc.reasoning.map(r => `<div class="sc-reason-item">• ${r}</div>`).join('')}</div>`;
      }
      html += '</div>';
      fcEl.innerHTML = html;
      if (hasR) {
        const btn = document.getElementById('fundToggle');
        const re = document.getElementById('fundReasoning');
        btn.addEventListener('click', () => {
          const hidden = re.classList.toggle('hidden');
          btn.textContent = hidden ? '查看论证过程 ▾' : '收起论证过程 ▴';
        });
      }
    } else if (fcEl) {
      fcEl.style.display = 'none';
    }

    // 全局兜底提示：有指标无法取值时，弹窗告知用户（不改动版面/字体/颜色，仅复用既有 toast 浮层）
    if (fundamental.notice) {
      setTimeout(() => this.toast(fundamental.notice, 'info', 8000), 600);
    }
  },

  // 指标分析渲染（20260919a）：替代原「分析师评级」
  // 展示每只关键财务指标的「当前值 + 五维对比（同比/环比/行业均值/历史百分位/边际变化）+ 判定依据」
  // ★ 20261104l（用户澄清指令，回退 20261104k 全量展示）：恢复按需单卡展示——右卡默认只显示与
  //   左卡选中指标对应的一张，其他指标默认隐藏（ma-hidden）；activeKey 由 showMetricAnalysis 维护
  //   （this.activeMetricKey），实时刷新 / 切股后重渲染仍保持用户当前选择的指标。
  // ★ 20261104m（用户澄清第二轮）：单卡 HTML 抽成 renderMetricAnalysisCard 共用生成器——
  //   右卡与左卡「行内展开面板」同一结构（单一数据源），见 showMetricAnalysis。
  renderMetricAnalysis(data, activeKey) {
    if (!data || !Array.isArray(data.metrics) || !data.metrics.length) {
      return '<p style="color:var(--text-secondary);padding:12px 0;">暂无指标分析数据</p>';
    }
    const esc = (s) => this.escapeHtml(String(s == null ? '' : s));
    const rows = data.metrics.map(m => {
      // ★ 20261104l：非当前查看项默认隐藏（按需单卡展示）
      const isActive = !!activeKey && m.key === activeKey;
      return `<div class="ma-row${isActive ? '' : ' ma-hidden'}" data-key="${esc(m.key || '')}">${this.renderMetricAnalysisCard(m)}</div>`;
    }).join('');
    const emptyHtml = `<div class="ma-empty${activeKey ? ' hidden' : ''}">👈 点击左侧「关键财务指标」任一指标右侧的「分析 ▸」，在该指标行下方查看五维对比与判定依据；再次点击同一 tab 可收起。</div>`;
    return `<div class="ma-note">${esc(data.note || '')}</div>${emptyHtml}${rows}`;
  },

  // ★ 20261104m：指标分析单卡 HTML 生成器（右卡 .ma-row 内体与左卡行内展开面板共用，单一数据源）。
  //   注意：外层 .ma-row 容器（含 data-key 与 ma-hidden 状态）由调用方拼接，本方法只生成卡体内容。
  renderMetricAnalysisCard(m) {
    const esc = (s) => this.escapeHtml(String(s == null ? '' : s));
    const sigBadge = (signal) => {
      const map = { bull: ['利好', 'ma-bull'], bear: ['利空', 'ma-bear'], neutral: ['中性', 'ma-neutral'] };
      const sm = map[signal] || ['—', 'ma-neutral'];
      return `<span class="ma-badge ${sm[1]}">${sm[0]}</span>`;
    };
    const dimChip = (d) => {
      if (!d) return '';
      const sigCls = d.signal === 'bull' ? 'ma-dim-bull' : d.signal === 'bear' ? 'ma-dim-bear' : d.signal === 'neutral' ? 'ma-dim-neutral' : 'ma-dim-na';
      return `<div class="ma-dim ${sigCls}"><span class="ma-dim-label">${esc(d.label)}</span><span class="ma-dim-text">${esc(d.text)}</span></div>`;
    };
    const dims = m.dims || {};
    const dimOrder = [
      ['yoy', '同比'], ['qoq', '环比'], ['industry', '行业均值'], ['pct', '历史百分位'], ['marginal', '边际变化'],
    ];
    const dimHtml = dimOrder.map(([k, label]) => {
      const d = Object.assign({ label }, dims[k] || {});
      return dimChip(d);
    }).join('');
    const j = m.judgment || {};
    return `
        <div class="ma-row-head">
          <span class="ma-row-label">${esc(m.label)}</span>
          <span class="ma-row-value">${esc(m.valueText)}</span>
          ${sigBadge(j.signal)}
        </div>
        <div class="ma-dims">${dimHtml}</div>
        <div class="ma-reason">${esc(j.reason || '—')}</div>
        ${m.note ? `<div class="ma-metric-note">📌 ${esc(m.note)}</div>` : ''}
      `;
  },

  // ★ 20261104m（用户澄清第二轮，核心改动）：分析内容与所点指标行**同一水平**——
  //   点击左卡「分析 ▸」时在该指标行正下方展开行内分析面板（手风琴，flex column 兄弟节点全宽），
  //   面板内容 = 右卡对应单卡的克隆（renderMetricAnalysisCard 同一结构），
  //   不再把页面滚动到上方右卡模块（l 版 scrollIntoView 回弹问题的根治）。
  //   右卡「指标分析」仍按需单卡同步显示当前项（用户在上方浏览时可见），key=null 收起回空态。
  //   当前选择维护在 this.activeMetricKey：实时刷新 / 切股后重渲染仍恢复展开，用户选择不丢。
  showMetricAnalysis(key, rowEl) {
    const maEl = document.getElementById('metricAnalysis');
    if (maEl) {
      const rows = maEl.querySelectorAll('.ma-row[data-key]');
      rows.forEach(r => {
        const isTarget = !!key && r.dataset.key === key;
        r.classList.toggle('ma-hidden', !isTarget);
      });
      const empty = maEl.querySelector('.ma-empty');
      if (empty) empty.classList.toggle('hidden', !!key);
    }
    // 左卡 tab 激活态同步（让用户看到当前展开的是哪一项）
    document.querySelectorAll('#fundMetrics .metric-jump').forEach(btn => {
      btn.classList.toggle('active', !!key && btn.dataset.key === key);
    });
    this.activeMetricKey = key || null;
    // 20261104m：行内展开面板——先移除旧面板（手风琴同时只展开一项），再在选中行下方插入
    document.querySelectorAll('.ma-inline-panel').forEach(p => p.remove());
    if (!key) return;
    const srcRow = maEl ? maEl.querySelector('.ma-row[data-key="' + key + '"]') : null;
    if (!srcRow) { this.toast('该指标暂无分析数据', 'info', 2000); return; }
    if (rowEl) {
      const panel = document.createElement('div');
      panel.className = 'ma-inline-panel';
      panel.appendChild(srcRow.cloneNode(true));
      rowEl.insertAdjacentElement('afterend', panel);
      // 面板紧邻点击行（同一水平），block:'nearest' 仅在面板底部超出视口时轻微下滚使其可见，不回弹
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      panel.classList.add('ma-flash');
      void panel.offsetWidth; // 强制重排，使重复点击也能重新触发闪烁动画
      window.setTimeout(() => panel.classList.remove('ma-flash'), 1800);
    }
  },

  // 指标释义浮层（点击指标标签后的「?」图标）
  showMetricHelp(key, anchor) {
    const info = METRIC_HELP[key];
    if (!info) return;
    let pop = document.getElementById('metricHelpPop');
    if (!pop) {
      pop = document.createElement('div');
      pop.id = 'metricHelpPop';
      pop.className = 'metric-help-pop';
      document.body.appendChild(pop);
      // 点击浮层外部或按 Esc 关闭
      document.addEventListener('click', (e) => {
        if (pop.classList.contains('show') && !pop.contains(e.target) && !(e.target.classList && e.target.classList.contains('metric-help'))) {
          pop.classList.remove('show');
        }
      });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape') pop.classList.remove('show'); });
    }
    const isOpen = pop.classList.contains('show') && pop.dataset.key === key;
    if (isOpen) { pop.classList.remove('show'); return; } // 再次点击同一项则收起
    pop.dataset.key = key;
    pop.innerHTML = `<div class="mhp-title">${info.title}</div><div class="mhp-body">${info.body}</div>`;
    pop.classList.add('show');
    // 定位（图标下方，避免超出视口右边界）
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const vw = document.documentElement.clientWidth;
    let left = r.left + window.scrollX;
    let top = r.bottom + window.scrollY + 6;
    if (left + pw > window.scrollX + vw - 8) left = window.scrollX + vw - pw - 8;
    if (left < 8) left = 8;
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  },

  // 由基本面评分对象生成「结论 + 论证」
  buildFundamentalConclusion(fund) {
    if (!fund) return null;
    const { overall, rating, score, scores } = fund;
    const typeName = fund.companyTypeName || '均衡型';
    const parts = [];
    parts.push(`${typeName}综合评级「${overall}」(${rating}，${score}/100)。`);
    const arr = Object.values(scores || {});
    if (arr.length) {
      const sorted = [...arr].sort((a, b) => b.score / b.max - a.score / a.max);
      const best = sorted[0], worst = sorted[sorted.length - 1];
      const bestPct = Math.round(best.score / best.max * 100);
      const worstPct = Math.round(worst.score / worst.max * 100);
      parts.push(`最强维度为「${best.label}」(${bestPct}分)，最弱维度为「${worst.label}」(${worstPct}分)。`);
    }
    const conclusion = parts.join('');
    const reasoning = [];
    const dl = fund.dimensionLogic || {};
    const order = ['valuation', 'profitability', 'growth', 'health'];
    for (const k of order) {
      const v = scores[k]; if (!v) continue;
      const pct = Math.round(v.score / v.max * 100);
      const judge = pct >= 70 ? '表现良好' : pct >= 45 ? '表现一般' : '表现偏弱';
      let line = `${v.label}：${v.score}/${v.max} 分（${pct}%），${judge}。`;
      // 展示真实推导过程（如"成长性 0 分"是因为营收/净利增速≤0，落入无加分档）
      if (dl[k] && dl[k].rule) line += ` 推导：${dl[k].rule}。`;
      reasoning.push(line);
    }
    return { conclusion, reasoning };
  },

  // ---- Tab switching ----
  switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`.tab[data-tab="${tabName}"]`).classList.add('active');
    document.getElementById(`tab-${tabName}`).classList.add('active');

    // Resize charts after tab switch
    setTimeout(() => {
      Object.values(Charts.instances).forEach(c => { try { c.resize(); } catch {} });
      Object.values(DeepCharts.instances).forEach(c => { try { c.resize(); } catch {} });
    }, 50);

    // 深度分析：仅当"当前股票"尚未加载时才转圈拉取；已加载则直接重渲染（issue2）
    if (tabName === 'deep') {
      if (this.currentSymbol && this.deepLoadedSymbol !== this.currentSymbol) {
        this.loadDeepAnalysis();
      } else if (this.deepData) {
        setTimeout(() => { try { DeepCharts.renderAll(this.deepData.sections, this.currentSymbol, this.currentData?.name); } catch (e) {} }, 100);
      }
    }

    // 资金量能：同上，按当前股票追踪（issue2）
    if (tabName === 'capital') {
      if (this.currentSymbol && this.capitalLoadedSymbol !== this.currentSymbol) {
        this.loadCapitalFlow();
      } else if (this.capitalData) {
        setTimeout(() => { try { CapitalCharts.renderAll(this.capitalData); } catch (e) {} }, 100);
      }
    }

    // 20261025l：个股记录——切到该 tab 时按当前股票拉取（同股已加载则模块内部跳过）
    if (tabName === 'stocklog' && typeof StockLog !== 'undefined' && this.currentSymbol) {
      StockLog.setStock(this.currentSymbol, this.currentData && this.currentData.name);
    }

    // 行业分析（按当前股票追踪）
    if (tabName === 'industry') {
      if (this.currentSymbol && this.industryLoadedSymbol !== this.currentSymbol) {
        this.loadIndustryAnalysis();
      } else if (this.industryData) {
        setTimeout(() => {
          try { IndustryCharts.renderAll(this.industryData, this.industryBoardData, this.industryHistoryData, this.industryStockMarketCapData, this._industryRenderOpts()); }
          catch (e) { console.error('Industry charts render error:', e); }
        }, 100);
        this.loadIndustryBoardIndex(false);
      }
      // 20260913e：切到本页后补一次图表初始化/尺寸重算。
      // 覆盖两类时序：① 数据在 tab 隐藏期间到达 → 图表被挂起，此处补初始化；
      //               ② 图表曾在隐藏期被 echarts.init 退化成 100×100 → 此处 resize 复原。
      setTimeout(() => { try { IndustryCharts.reflow(); } catch (e) { /* ignore */ } }, 80);
      setTimeout(() => { try { IndustryCharts.reflow(); } catch (e) { /* ignore */ } }, 320);
    }

    // 技术面：图表曾在隐藏 tab 期被 echarts.init 退化成小尺寸（20261003f 已注册实例），
    // 切回后统一 resize 复原（与上方 50ms 统一 resize 形成双保险）
    if (tabName === 'technical') {
      setTimeout(() => { try { Object.values(Charts.instances).forEach(c => c.resize()); } catch (e) { /* ignore */ } }, 120);
    }

    // 股东分析（issue5）
    if (tabName === 'shareholders') {
      if (this.currentSymbol && this.shareholderLoadedSymbol !== this.currentSymbol) {
        this.loadShareholders();
      } else if (this.shareholderData) {
        this.renderShareholders(this.shareholderData);
      }
    }

    // 个股亮点/雷点 记录（issue4）
    if (tabName === 'journal' && this.currentSymbol) {
      if (typeof Notes !== 'undefined') Notes.renderStock(this.currentSymbol, this.currentData?.name);
    }

    // Docs tab
    if (tabName === 'docs') {
      if (this.currentSymbol) {
        const name = this.currentData?.name || '';
        DocStore.setStock(this.currentSymbol, name);
      }
      DocStore.onTabSwitch();
    }

    // 策略回测校验 tab（20260926a）
    if (tabName === 'backtest') {
      if (this.currentSymbol && typeof BacktestUI !== 'undefined') {
        BacktestUI.open(this.currentSymbol, this.currentData?.name);
      }
    }
  },

  // ---- Deep Analysis ----
  async loadDeepAnalysis(forceRefresh = false) {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const loadingEl = document.getElementById('deepLoading');
    const contentEl = document.getElementById('deepContent');
    const cacheBar = document.getElementById('deepCacheBar');
    // 首次且骨架完整时，捕获静态章节骨架，供后续恢复（避免任何意外清空/错误占位后白屏）
    if (!this._deepSkeletonHTML && contentEl && document.getElementById('deepResearchReports')) {
      this._deepSkeletonHTML = contentEl.innerHTML;
    }
    // 已加载且同股、非强制刷新 → 直接重渲染，不重新拉取（避免切回页面重新转圈）
    if (!forceRefresh && this.deepLoadedSymbol === symbol && this.deepData && this.deepData.sections) {
      this.ensureDeepSkeleton();
      this.updateDeepCacheBar(this.deepData);
      setTimeout(() => { try { DeepCharts.renderAll(this.deepData.sections, symbol, this.currentData?.name); } catch (e) {} try { this.syncDeepGroupsVisibility(); } catch (e) {} }, 100);
      if (loadingEl) loadingEl.classList.add('hidden');
      if (contentEl) contentEl.style.opacity = '1';
      return;
    }
    if (forceRefresh) { this.deepData = null; this.deepLoadedSymbol = null; }

    bgPreload.start('深度分析/财报解读');
    if (loadingEl) { loadingEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text-secondary);">⏳ 正在加载深度分析…</div>'; loadingEl.classList.remove('hidden'); }
    if (contentEl) contentEl.style.opacity = '0.3';
    if (cacheBar) cacheBar.classList.add('hidden');

    // 20261021k：后台任务轮询——服务端任务脱离请求生命周期，切页/断连都不中断；
    // 本函数只负责「秒回状态 + 轮询 + 完成后渲染」，不阻塞、不 abort。
    const pollToken = (this._deepPollToken = (this._deepPollToken || 0) + 1);
    const startTime = Date.now();
    const self = this;

    const showRunning = () => {
      if (!loadingEl) return;
      const secs = Math.floor((Date.now() - startTime) / 1000);
      loadingEl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-secondary);">
        <div style="font-size:15px;margin-bottom:8px;">📡 深度分析 / 财报解读正在<b>后台进行中</b>…（已 ${secs}s）</div>
        <div style="font-size:13px;">可随意切换页面，完成后自动显示，无需等待。</div>
      </div>`;
      loadingEl.classList.remove('hidden');
      if (contentEl) contentEl.style.opacity = '1';
    };

    const renderDone = (data) => {
      self.deepData = data;
      self.deepDataLoaded = true;
      self.deepLoadedSymbol = symbol;
      if (!data.sections) {
        bgPreload.finish('深度分析/财报解读');
        if (contentEl) contentEl.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);"><h3>⚠️ 深度分析数据不完整</h3><p>本次未能获取到完整的分析数据，请点击「刷新」重试。</p></div>`;
        if (loadingEl) loadingEl.classList.add('hidden');
        if (contentEl) contentEl.style.opacity = '1';
        return;
      }
      if (data.auditWarning) { const w = document.getElementById('auditWarning'); if (w) { w.textContent = data.auditWarning; w.classList.remove('hidden'); } }
      self.ensureDeepSkeleton();
      self.updateDeepCacheBar(data);
      setTimeout(() => { try { DeepCharts.renderAll(data.sections, symbol, self.currentData?.name); } catch (e) { console.error('DeepCharts render error:', e); } try { self.syncDeepGroupsVisibility(); } catch (e) {} }, 100);
      self.toast(forceRefresh ? '已重新分析完成' : (data.fromCache ? '已加载缓存数据' : '深度分析数据加载完成'));
      bgPreload.finish('深度分析/财报解读');
      if (loadingEl) loadingEl.classList.add('hidden');
      if (contentEl) contentEl.style.opacity = '1';
    };

    const tryOnce = async () => {
      if (self._deepPollToken !== pollToken) return;       // 已切股/重入，放弃本轮
      if (self.currentSymbol !== symbol) return;
      const params = [];
      if (forceRefresh) params.push('refresh=1');
      const nm = self.currentData?.name || '';
      if (nm) params.push('name=' + encodeURIComponent(nm));
      const qs = params.length ? '?' + params.join('&') : '';
      let data;
      try {
        const resp = await fetch(`/api/deep-analysis/${encodeURIComponent(symbol)}${qs}`, { cache: 'no-store' });
        data = await resp.json();
      } catch (e) {
        if (self._deepPollToken !== pollToken || self.currentSymbol !== symbol) return;
        bgPreload.finish('深度分析/财报解读');
        self.toast('深度分析请求失败: ' + (e && e.message), 'error');
        if (loadingEl) loadingEl.classList.add('hidden');
        if (contentEl) contentEl.style.opacity = '1';
        return;
      }
      if (self._deepPollToken !== pollToken || self.currentSymbol !== symbol) return;
      if (data.error) {
        bgPreload.finish('深度分析/财报解读');
        if (contentEl) contentEl.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);"><h3>⚠️ ${data.error}</h3><p>深度分析目前仅支持A股市场，且需要该股票有完整的财务报表数据。</p></div>`;
        if (loadingEl) loadingEl.classList.add('hidden');
        if (contentEl) contentEl.style.opacity = '1';
        return;
      }
      if (data.status === 'running') {
        const deepActive = document.querySelector('.tab[data-tab="deep"]') && document.querySelector('.tab[data-tab="deep"]').classList.contains('active');
        if (deepActive) showRunning();   // 仅在深度分析 tab 可见时刷新可见 loading 文案
        // 20261101：后台预加载——无论是否停留在本 tab 都继续轮询，直到服务端落盘结果写入 deepData，
        // 切回时直接秒显（不再重新转圈）。服务端任务脱离请求生命周期，轮询间隔 4s 足够轻量。
        setTimeout(tryOnce, 4000);
        return;
      }
      renderDone(data); // done（含 fromCache / background）
    };

    tryOnce();
  },

  // 恢复深度分析静态章节骨架（首屏成功渲染前调用）。
  // 章节骨架是 index.html 内的静态 HTML；若被清空或错误占位冲掉，
  // 没有骨架 renderAll 会找不到元素而整页空白。这里用首次捕获的 HTML 重建。
  ensureDeepSkeleton() {
    const content = document.getElementById('deepContent');
    if (!content) return;
    const hasSkeleton = document.getElementById('deepResearchReports') || document.getElementById('deepAnnouncements') || document.getElementById('cninfoAnnouncements');
    if (hasSkeleton) return;
    if (this._deepSkeletonHTML) {
      content.innerHTML = this._deepSkeletonHTML;
    } else {
      content.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-secondary);"><h3>⚠️ 页面结构异常</h3><p>请刷新页面后重试。</p></div>';
    }
  },

  // 更新深度分析缓存状态条
  updateDeepCacheBar(data) {
    const bar = document.getElementById('deepCacheBar');
    const status = document.getElementById('deepCacheStatus');
    if (!bar || !status) return;
    const ts = data.cachedAt ? new Date(data.cachedAt).toLocaleString('zh-CN') : '';
    // 20261016b（审计 G7）：深度分析管线不消费事件引擎（lib/deepAnalysis.js 及 lib/deep/* 均无 eventEngine 引用），
    // 事件仅在个股页事件区单独展示，未并入本页结论。旧文案未披露，易被误读为「已纳入事件影响」，此处如实标注。
    const sourceNote = '数据来源：东方财富财报 / 分红 / 股东数据 · 本地规则计算；⚠️ 事件引擎识别的突发事件未并入本页结论（仅在个股页事件区单独展示）';
    if (data.fromCache) {
      status.innerHTML = `📦 已加载缓存数据 · 更新于 ${ts} · ${sourceNote}`;
      status.className = 'deep-cache-status cached';
    } else {
      status.innerHTML = `✅ 已生成最新分析 · ${ts} · ${sourceNote}`;
      status.className = 'deep-cache-status fresh';
    }
    bar.classList.remove('hidden');
  },

  // 首页卡片折叠（除实时大盘/左侧边栏外默认收起，localStorage 记忆用户选择）
  initHomeCollapsible() {
    const COLLAPSE_KEY = 'sa_home_collapsed_v1';
    const defaultCollapsed = ['homeSentimentPanel', 'indexPeTrendCard', 'sectorCrowdingCard', 'homeNewsCard', 'homeHotTopicsCard', 'macroCard', 'rankCard', 'historyPanel'];
    let state;
    try { state = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch { state = {}; }
    const firstVisit = !localStorage.getItem(COLLAPSE_KEY);
    document.querySelectorAll('[data-collapsible="true"]').forEach(card => {
      const id = card.id;
      const btn = document.querySelector(`.btn-collapse[data-collapse-target="${id}"]`);
      if (!btn) return;
      if (firstVisit) state[id] = defaultCollapsed.includes(id);
      // historyPanel 为后续新增：老用户 localStorage 无此键时默认折叠（undefined 视为折叠，显式 false 才展开）
      const collapsed = id === 'historyPanel' ? state[id] !== false : !!state[id];
      if (collapsed) {
        card.classList.add('collapsed');
        btn.classList.add('collapsed');
        btn.title = '展开';
      }
      btn.addEventListener('click', () => {
        const isCollapsed = card.classList.toggle('collapsed');
        btn.classList.toggle('collapsed', isCollapsed);
        btn.title = isCollapsed ? '展开' : '折叠';
        state[id] = isCollapsed;
        try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state)); } catch {}
        if (!isCollapsed) {
          // 展开后触发图表 resize，避免 ECharts 在隐藏容器初始化后尺寸为 0
          setTimeout(() => {
            if (typeof Charts !== 'undefined' && Charts.instances) {
              Object.values(Charts.instances).forEach(c => { try { c.resize(); } catch {} });
            }
          }, 60);
        }
      });
    });

    // 市场情绪拐点：详情区（分量网格 / 提醒原因 / 越用越准 / 数据来源）可折叠，保留顶部状态行。
    const tpBody = document.getElementById('homeSentimentBody');
    if (tpBody) {
      tpBody.addEventListener('click', (e) => {
        // 20261025p：卡片内「查看宽基ETF明细」→ 新标签打开独立网页 /etf-flow.html（页签/弹窗废弃）
        const openEtf = e.target.closest('[data-action="open-etf-page"]');
        if (openEtf) {
          window.open('/etf-flow.html', '_blank', 'noopener');
          return;
        }
        const btn = e.target.closest('.tp-detail-toggle');
        if (!btn) return;
        const detail = tpBody.querySelector('.tp-detail-body');
        if (!detail) return;
        const collapsed = detail.classList.toggle('collapsed');
        btn.textContent = collapsed ? '▸ 展开详情' : '▾ 隐藏详情';
        try { localStorage.setItem('sa_tp_detail_open_v1', String(!collapsed)); } catch {}
      });
    }

    if (firstVisit) {
      try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(state)); } catch {}
    }
  },

  // 深度分析：将 #deepContent 内的卡片按主题分组为可折叠区块（仅执行一次）
  initDeepGroups() {
    if (this._deepGroupsReady) return;
    const root = document.getElementById('deepContent');
    if (!root || root.querySelector('.deep-group')) { this._deepGroupsReady = true; return; }
    const audit = document.getElementById('auditWarning');
    const helper = (id) => document.getElementById(id);
    const gridOf = (id) => { const el = helper(id); return el ? (el.closest('.chart-grid') || el) : null; };
    const cardOf = (id) => { const el = helper(id); return el ? (el.closest('.chart-card') || el) : null; };

    const groups = [
      { id: 'group-overview', title: '📋 综合估值', open: true,
        nodes: [document.querySelector('.valuation-merged')] },
      { id: 'group-earnings', title: '📑 财报解读',
        nodes: [cardOf('deepEarningsReport')] },
      { id: 'group-revenue', title: '📊 营收与盈利趋势',
        nodes: [cardOf('deepRevenueCost'), cardOf('deepRoeMargin'), cardOf('deepSegmentProduct'), cardOf('deepSegmentRegion'), cardOf('deepRevVsCost'), cardOf('deepMargin'), cardOf('deepRevVsExp')] },
      { id: 'group-balance', title: '🏦 资产与负债结构',
        nodes: [gridOf('deepShortTermRisk'), gridOf('deepAssetComp'), cardOf('deepLiabComp'), gridOf('deepGrowth'), gridOf('deepPayable')] },
      { id: 'group-cashflow', title: '💵 现金流与业绩真实性',
        nodes: [cardOf('deepRevVsCash'), cardOf('deepProfitVsCash')] },
      { id: 'group-mcap', title: '📈 市值对比分析',
        nodes: [cardOf('deepRevVsMC'), cardOf('deepProfitVsMC'), cardOf('deepNAVVsMC')] },
      { id: 'group-valuation', title: '⚖️ 估值分析',
        nodes: [gridOf('deepPE'), gridOf('deepPB'), gridOf('deepPS'), cardOf('deepDCF'), gridOf('deepPEV'), gridOf('deepDDM')] },
      { id: 'group-product', title: '🧮 主营业务构成',
        nodes: [cardOf('deepProductMargin')] },
      { id: 'group-dividend', title: '💰 分红分析',
        nodes: [cardOf('deepDividend'), cardOf('deepDividendBar'), cardOf('deepDivYield')] },
      { id: 'group-research', title: '📚 研报与重要公告',
        nodes: [cardOf('deepResearchReports'), cardOf('deepAnnouncements'), cardOf('cninfoAnnouncements')] },
      { id: 'group-insurance', title: '🏦 保险公司专属分析', hidden: true,
        nodes: [helper('deepInsuranceAnalysis')] },
    ];

    // 收集除审计警告外的所有子节点并暂时移除，随后装入各分组
    const collected = Array.from(root.children).filter(c => c !== audit);
    collected.forEach(c => { if (c.parentNode) c.parentNode.removeChild(c); });

    groups.forEach(g => {
      const sec = document.createElement('section');
      sec.className = 'deep-group' + (g.open ? '' : ' collapsed');
      sec.id = g.id;
      if (g.hidden) sec.style.display = 'none';
      const header = document.createElement('div');
      header.className = 'deep-group-header';
      header.innerHTML = '<span>' + g.title + '</span><span class="chevron">▾</span>';
      const body = document.createElement('div');
      body.className = 'deep-group-body';
      Array.from(new Set(g.nodes.filter(Boolean))).forEach(n => { if (n) body.appendChild(n); });
      sec.appendChild(header);
      sec.appendChild(body);
      root.appendChild(sec);
    });

    // 绑定折叠 / 展开
    root.querySelectorAll('.deep-group-header').forEach(header => {
      header.addEventListener('click', () => {
        const group = header.closest('.deep-group');
        if (!group) return;
        group.classList.toggle('collapsed');
        if (typeof DeepCharts !== 'undefined' && !group.classList.contains('collapsed')) {
          setTimeout(() => { try { DeepCharts.resizeVisibleCharts(); } catch (e) {} }, 50);
        }
      });
    });

    this._deepGroupsReady = true;
  },

  // 根据渲染结果，隐藏无数据的分组（保险专属）
  syncDeepGroupsVisibility() {
    [['group-insurance', 'deepInsuranceAnalysis']].forEach(([gid, pid]) => {
      const g = document.getElementById(gid);
      const p = document.getElementById(pid);
      if (g && p) g.style.display = p.classList.contains('hidden') ? 'none' : '';
    });
  },

  // 加入自选股后，后台预生成并缓存深度分析（fire-and-forget）
  preCacheAnalysis(symbol, name) {
    const params = [];
    if (name) params.push('name=' + encodeURIComponent(name));
    const qs = params.length ? '?' + params.join('&') : '';
    fetch(`/api/deep-analysis/${encodeURIComponent(symbol)}${qs}`).catch(() => {});
  },

  // ---- Capital Flow Analysis ----
  async loadCapitalFlow() {
    const loadingEl = document.getElementById('capitalLoading');
    const contentEl = document.getElementById('capitalContent');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (contentEl) contentEl.style.opacity = '0.3';
    bgPreload.start('资金量能');

    // 前端硬超时：避免后端长时间无响应时 capitalContent 一直停在 opacity:0.3 + loading
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), 15000);

    try {
      const name = this.currentData?.name || '';
      const resp = await fetch(`/api/capital-flow/${encodeURIComponent(this.currentSymbol)}?name=${encodeURIComponent(name)}`, { signal: controller.signal });
      clearTimeout(fetchTimer);
      const data = await resp.json();

      if (data.error) {
        if (loadingEl) loadingEl.classList.add('hidden');
        if (contentEl) {
          contentEl.style.opacity = '1';
          contentEl.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);">
            <h3>⚠️ ${data.error}</h3>
            <p>数据加载失败，请稍后刷新重试（可能是行情源超时或网络异常，并非仅限 A 股）。</p>
          </div>`;
          const sc = document.getElementById('capitalScore');
          if (sc) sc.textContent = '加载失败';
          const scd = document.getElementById('capitalScoreDetail');
          if (scd) scd.textContent = '资金量能数据加载失败';
        }
        return;
      }

      this.capitalData = data;
      this.capitalDataLoaded = true;
      this.capitalLoadedSymbol = this.currentSymbol; // issue2：标记已为当前股票加载

      if (loadingEl) loadingEl.classList.add('hidden');
      if (contentEl) contentEl.style.opacity = '1';

      // 单个图表渲染异常不应阻断资金热度（评分卡）渲染
      setTimeout(() => {
        try {
          CapitalCharts.renderAll(data);
        } catch (re) {
          console.error('CapitalCharts.renderAll error:', re);
        }
        try {
          this.renderCapitalScore(data);
        } catch (re) {
          console.error('renderCapitalScore error:', re);
        }
        try {
          this.renderVolumeEngine(data);
        } catch (re) {
          console.error('renderVolumeEngine error:', re);
        }
      }, 100);

      this.toast('资金量能数据加载完成');
      bgPreload.finish('资金量能');
    } catch (e) {
      clearTimeout(fetchTimer);
      bgPreload.finish('资金量能');
      if (loadingEl) loadingEl.classList.add('hidden');
      if (contentEl) {
        contentEl.style.opacity = '1';
        contentEl.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);">
          <h3>⚠️ 资金量能数据加载超时</h3>
          <p>数据源响应较慢或网络异常，请稍后刷新重试。</p>
        </div>`;
      }
      this.toast('资金量能分析加载失败: ' + e.message, 'error');
      console.error('Capital flow error:', e);
    }
  },

  // ---- Industry Analysis ----
  async loadIndustryAnalysis() {
    const loadingEl = document.getElementById('industryLoading');
    const contentEl = document.getElementById('industryContent');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (contentEl) contentEl.style.opacity = '0.3';
    bgPreload.start('行业分析');

    try {
      const name = this.currentData?.name || '';
      const resp = await fetch(`/api/industry-analysis/${encodeURIComponent(this.currentSymbol)}?name=${encodeURIComponent(name)}`);
      const data = await resp.json();

      if (data.error) {
        if (loadingEl) loadingEl.classList.add('hidden');
        if (contentEl) {
          contentEl.style.opacity = '1';
          contentEl.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);">
            <h3>⚠️ ${data.error}</h3>
            <p>行业分析目前主要支持A股市场。</p>
          </div>`;
        }
        return;
      }

      this.industryData = data;
      this.industryDataLoaded = true;
      this.industryLoadedSymbol = this.currentSymbol; // 标记已为当前股票加载

      // 行业板块指数 AI 分析 + 历史行情（K线）并行加载
      // 20260913d：读取期间置 loading 标记 —— 避免 100ms 后的首次渲染先闪出"暂无 AI 分析"再被内容覆盖
      if (!(this.industryBoardLoadedSymbol === this.currentSymbol && this.industryBoardData)) {
        this.industryBoardLoading = true;
      }
      this.loadIndustryBoardIndex(false);
      this.loadIndustryIndexHistory();
      this.loadIndustryProsperity();

      if (loadingEl) loadingEl.classList.add('hidden');
      if (contentEl) contentEl.style.opacity = '1';

      setTimeout(() => {
        try { IndustryCharts.renderAll(data, this.industryBoardData, this.industryHistoryData, this.industryStockMarketCapData, this._industryRenderOpts()); } catch (e) { console.error('Industry charts render error:', e); }
      }, 100);

      this.toast('行业分析数据加载完成');
      bgPreload.finish('行业分析');
    } catch (e) {
      bgPreload.finish('行业分析');
      if (loadingEl) loadingEl.classList.add('hidden');
      if (contentEl) contentEl.style.opacity = '1';
      this.toast('行业分析加载失败: ' + e.message, 'error');
      console.error('Industry analysis error:', e);
    }
  },

  // ---- 行业板块指数 AI 分析（联网获取） ----
  async loadIndustryBoardIndex(force = false) {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const ind = this.industryData && this.industryData.industry;
    if (!ind) return;
    const induCode = ind.induCode ? ind.induCode : '';
    const industryName = ind.name ? ind.name : '';
    const induName = ind.induName ? ind.induName : '';
    const pollParams = { symbol, induCode, industryName, induName };

    // 已加载且非强制刷新：直接渲染，无需重新查询
    if (!force && this.industryBoardLoadedSymbol === symbol && this.industryBoardData) {
      this.industryBoardLoading = false;
      this._renderIndustryOverview();
      this._updateIndustryOverviewHeader(this.industryBoardData);
      return;
    }

    if (force) {
      // 触发后台联网获取（fire-and-forget，不阻塞界面）；随后由轮询自动显示结果。
      // 20260913d：若已有内容，保留旧内容并标记 refreshing（刷新期间不清空，避免"内容消失"）
      const prev = (this.industryBoardData && this.industryBoardData.status === 'done') ? this.industryBoardData : null;
      this.industryBoardData = prev ? Object.assign({}, prev, { refreshing: true }) : { status: 'running' };
      this.industryBoardLoading = false;
      this._renderIndustryOverview();
      fetch('/api/ai/industry-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, industry: industryName, induName, induCode, force: true }),
      }).catch(() => {});
      this.pollIndustryBoardIndex(pollParams);
      return;
    }

    // 自动加载：先查缓存（命中 done 直接渲染；命中 running 则接手轮询；error 提示）
    try {
      const q = new URLSearchParams({
        induCode: induCode || '',
        industry: industryName || '',
        induName: induName || '',
      }).toString();
      const resp = await fetch(`/api/ai/industry-index/${encodeURIComponent(symbol)}?${q}`);
      const cached = await resp.json();
      if (this.currentSymbol !== symbol) return;
      this.industryBoardLoading = false;
      if (cached.success && cached.status === 'done') {
        this.industryBoardData = cached;
        this.industryBoardLoadedSymbol = symbol;
        this._renderIndustryOverview();
        this._updateIndustryOverviewHeader(cached);
        // 后台正在刷新：继续轮询，完成后覆盖为最新内容
        if (cached.refreshing) this.pollIndustryBoardIndex(pollParams);
        return;
      }
      if (cached.success && cached.status === 'running') {
        this.industryBoardData = cached;
        this._renderIndustryOverview();
        this.pollIndustryBoardIndex(pollParams);
        return;
      }
      if (cached.success && cached.status === 'error') {
        this.industryBoardData = cached;
        this._renderIndustryOverview();
        return;
      }
      this.industryBoardData = null;
      this._renderIndustryOverview();
    } catch (e) {
      this.industryBoardLoading = false;
      this.industryBoardData = { status: 'error', message: e.message };
      this._renderIndustryOverview();
    }
  },

  // 轮询行业板块指数后台任务：与 currentSymbol 解耦，切换页面/股票不中断；
  // 仅当当前显示的仍是该股票时才把结果渲染到 DOM，否则仅更新内存，待切回时显示。
  pollIndustryBoardIndex(params) {
    if (!this._industryPoll) this._industryPoll = {};
    const key = (params.induCode || params.industryName || '') + '|' + params.symbol;
    if (this._industryPoll[key]) return; // 已在轮询，避免重复

    const q = new URLSearchParams({
      induCode: params.induCode || '',
      industry: params.industryName || '',
      induName: params.induName || '',
    }).toString();
    let attempts = 0;
    const maxAttempts = 40; // ~2 分钟（3 秒/次）
    const tick = async () => {
      attempts++;
      try {
        const resp = await fetch(`/api/ai/industry-index/${encodeURIComponent(params.symbol)}?${q}`);
        const cached = await resp.json();
        if (cached.success && cached.status === 'running') {
          if (attempts < maxAttempts) return;
        }
        if (cached.success && cached.status === 'done') {
          this.industryBoardData = cached;
          this.industryBoardLoadedSymbol = params.symbol;
          if (this.currentSymbol === params.symbol) {
            this._renderIndustryOverview();
            this._updateIndustryOverviewHeader(cached);
          }
          return true; // 结束轮询
        }
        if (cached.success && cached.status === 'error') {
          this.industryBoardData = cached;
          if (this.currentSymbol === params.symbol) this._renderIndustryOverview();
          return true;
        }
        // 暂无缓存（后端可能尚未写入 running），继续等待
        if (attempts < maxAttempts) return;
      } catch (e) {
        if (attempts >= maxAttempts) {
          // 20260913d：超时也保留已有内容（只在完全无内容时才显示错误），避免刷新失败把上次分析顶掉
          const prev = (this.industryBoardData && this.industryBoardData.status === 'done') ? this.industryBoardData : null;
          this.industryBoardData = prev || { status: 'error', message: '获取超时，请稍后点击右上角重新获取。' };
          if (this.currentSymbol === params.symbol) this._renderIndustryOverview();
        }
      }
      return false; // 继续轮询
    };
    const timer = setInterval(async () => {
      const done = await tick();
      if (done || attempts >= maxAttempts) {
        clearInterval(timer);
        delete this._industryPoll[key];
      }
    }, 3000);
    this._industryPoll[key] = timer;
  },

  // 行业指数历史行情（同花顺 K 线），不依赖 AI，与 AI 分析并行加载
  async loadIndustryIndexHistory() {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    this.industryStockMarketCapData = null; // 清空旧市值数据，避免切换股票时短暂显示上个股票
    const ind = this.industryData && this.industryData.industry;
    if (!ind) return;
    // 优先用同花顺 K 线专用板块（命中覆盖表时填充，如海天味业→食品加工制造），
    // 否则回退到归一化行业名（ind.name）。boardName 为空时不影响既有逻辑。
    const industryName = ind.boardName || (ind.name ? ind.name : (ind.induName || ''));
    if (!industryName) return;

    // 20260913d：板块成分股总市值合计走势（按东方财富板块代码，如 BK1278）。
    // 独立加载，失败仅隐藏该卡片，不影响上方 K 线。
    this.loadSectorMarketCap();

    try {
      const q = new URLSearchParams({ industry: industryName, induName: ind.induName || '' }).toString();
      const [resp, mcResp] = await Promise.all([
        fetch(`/api/industry-index-history/${encodeURIComponent(symbol)}?${q}`),
        fetch(`/api/stock-market-cap-history/${encodeURIComponent(symbol)}`),
      ]);
      const data = await resp.json();
      const mcData = await mcResp.json().catch(() => ({ success: false }));
      if (this.currentSymbol !== symbol) return;
      this.industryHistoryData = data;
      this.industryStockMarketCapData = mcData;
      this._renderIndustryOverview();
    } catch (e) {
      this.industryHistoryData = { success: false, error: e.message };
      this.industryStockMarketCapData = { success: false, error: e.message };
      this._renderIndustryOverview();
    }
  },

  // 行业景气度：行业总营收(TTM) vs 总市值 双轴走势（服务端按申万二级行业全量汇总）
  // 独立加载，失败仅隐藏卡片，不影响上方 K 线与其他模块。所有个股同口径执行。
  async loadIndustryProsperity() {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const stockName = (this.currentData && this.currentData.name) || '';
    // 先复位，避免切换股票时短暂显示上一只股票
    try { this._resetIndustryProsperity(); } catch (e) { /* ignore */ }
    try {
      const q = stockName ? ('?name=' + encodeURIComponent(stockName)) : '';
      const resp = await fetch(`/api/industry-prosperity/${encodeURIComponent(symbol)}${q}`);
      const data = await resp.json();
      if (this.currentSymbol !== symbol) return;
      this.industryProsperityData = data;
      if (data && data.success) {
        IndustryCharts.renderIndustryProsperity(data, { stockName });
      } else {
        // 非 A 股 / 无申万二级 / 无数据：隐藏卡片
        const card = document.getElementById('indProsperityCard');
        if (card) card.style.display = 'none';
      }
    } catch (e) {
      console.error('loadIndustryProsperity error:', e);
      const card = document.getElementById('indProsperityCard');
      if (card) card.style.display = 'none';
    }
  },

  // 板块成分股总市值合计走势「统一模板」（20260916 重构）
  // 流程：解析个股所属申万一级/二级/三级行业板块 → 生成三张卡片骨架 → 并行取各层级板块市值走势 → 逐张填充。
  // 无对应三级板块时自动省略第三张（后端 levels 只回有数据的层级）。所有个股同口径执行。
  async loadSectorMarketCap() {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const stockName = (this.currentData && this.currentData.name) || '';
    this._resetSectorCap(); // 复位容器/实例，避免残留上一只股票
    try {
      const q0 = stockName ? ('?name=' + encodeURIComponent(stockName)) : '';
      const lvResp = await fetch(`/api/stock-sector-levels/${encodeURIComponent(symbol)}${q0}`);
      const lvData = await lvResp.json();
      if (this.currentSymbol !== symbol) return;
      const levels = (lvData && Array.isArray(lvData.levels)) ? lvData.levels : [];
      if (!levels.length) return;

      // 1) 生成一/二/三级三张卡片骨架（无三级则两张）
      IndustryCharts.renderSectorCapGroup(lvData, { stockName });

      const suffixOf = (lv) => ({ '一级': 'L1', '二级': 'L2', '三级': 'L3' }[lv] || ('L' + lv));
      // 2) 并行取各层级板块总市值走势，各自到达即渲染（渐进呈现，互不阻塞）
      await Promise.all(levels.map(async (lv) => {
        try {
          const q = new URLSearchParams({
            name: lv.sectorName || '',
            benchmark: symbol,
            benchmarkName: stockName,
            days: '250',
          }).toString();
          const resp = await fetch(`/api/sector-market-cap-history/${encodeURIComponent(lv.sectorCode)}?${q}`);
          const data = await resp.json();
          if (this.currentSymbol !== symbol) return;
          IndustryCharts.renderSectorMarketCap(data, {
            suffix: suffixOf(lv.swLevel),
            stockName,
            swLevel: lv.swLevel,
          });
        } catch (e) {
          console.error('Sector market cap chart error:', lv && lv.swLevel, e);
        }
      }));
    } catch (e) {
      console.error('loadSectorMarketCap error:', e);
    }
  },

  // 复位板块总市值走势容器：清空卡片骨架 + 释放一/二/三级图表实例
  _resetSectorCap() {
    const box = document.getElementById('sectorCapGroup');
    if (box) box.innerHTML = '';
    try {
      if (window.Charts && Charts.instances) {
        ['sectorCapChart-L1', 'sectorCapChart-L2', 'sectorCapChart-L3'].forEach((k) => {
          if (Charts.instances[k]) { Charts.instances[k].dispose(); delete Charts.instances[k]; }
        });
      }
    } catch (e) { /* ignore */ }
  },

  // 复位行业景气度卡片：隐藏容器 + 释放图表实例，避免残留上一只股票
  _resetIndustryProsperity() {
    const card = document.getElementById('indProsperityCard');
    if (card) card.style.display = 'none';
    try {
      if (window.Charts && Charts.instances && Charts.instances['indProsperityChart']) {
        Charts.instances['indProsperityChart'].dispose();
        delete Charts.instances['indProsperityChart'];
      }
    } catch (e) { /* ignore */ }
    this.industryProsperityData = null;
  },

  // 行业分析卡片渲染参数：stockName 供 K 线图例标注；boardLoading 用于避免闪出"暂无"
  _industryRenderOpts() {
    return {
      stockName: (this.currentData && this.currentData.name) || '',
      boardLoading: !!this.industryBoardLoading,
    };
  },

  _renderIndustryOverview() {
    try {
      IndustryCharts.renderIndustryOverview(
        this.industryData && this.industryData.industry,
        this.industryBoardData,
        this.industryHistoryData,
        this.industryData && this.industryData.policy,
        this.industryStockMarketCapData,
        this._industryRenderOpts()
      );
    } catch (e) {
      console.error('Industry overview render error:', e);
    }
  },

  _updateIndustryOverviewHeader(data) {
    const dateEl = document.getElementById('industryOverviewDate');
    const rf = document.getElementById('industryOverviewRefresh');
    if (dateEl && data && data.date) {
      const d = new Date(data.date);
      const pad = (n) => String(n).padStart(2, '0');
      dateEl.textContent = '更新于 ' + `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    if (rf) rf.style.display = '';
  },

  // ---- Shareholders Analysis (issue5) ----
  async loadShareholders() {
    const container = document.getElementById('shareholdersContainer');
    if (container) container.innerHTML = `<div class="deep-loading"><div class="loading-spinner"></div><p>正在获取股东与机构持仓数据，请稍候...</p></div>`;
    bgPreload.start('股东分析');
    try {
      const resp = await fetch(`/api/shareholders/${encodeURIComponent(this.currentSymbol)}?name=${encodeURIComponent(this.currentData?.name || '')}`);
      const data = await resp.json();
      this.shareholderData = data;
      this.shareholderLoadedSymbol = this.currentSymbol;
      this.renderShareholders(data);
      bgPreload.finish('股东分析');
    } catch (e) {
      bgPreload.finish('股东分析');
      if (container) container.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);"><h3>⚠️ 股东数据加载失败</h3><p>${e.message}</p></div>`;
      console.error('Shareholders error:', e);
    }
  },

  renderShareholders(data) {
    const container = document.getElementById('shareholdersContainer');
    if (!container) return;
    if (data.error) {
      container.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);"><h3>⚠️ ${data.error}</h3></div>`;
      return;
    }
    // 渲染交给 ShareholderCharts 模块（图表 + 文字），缺失数据优雅降级
    if (typeof ShareholderCharts !== 'undefined') {
      ShareholderCharts.renderAll(container, data);
    }
  },

  // ---- Watchlist ----
  toggleWatchlist() {
    if (!this.currentData) return;
    const symbol = this.currentData.symbol;
    if (Storage.isInWatchlist(symbol)) {
      Storage.removeFromWatchlist(symbol);
      this.toast('已从自选股移除');
    } else {
      Storage.addToWatchlist({
        symbol,
        name: this.currentData.name,
        market: this.currentData.market
      });
      this.toast('已加入自选股');
      // 加入自选股后，后台预生成并缓存深度分析数据，下次打开即瞬时加载
      this.preCacheAnalysis(symbol, this.currentData.name);
    }
    this.renderWatchlist();
    this.updateWatchlistButton();
  },

  updateWatchlistButton() {
    const btn = document.getElementById('addToWatchlist');
    if (Storage.isInWatchlist(this.currentSymbol)) {
      btn.textContent = '★ 已自选';
      btn.classList.add('active');
    } else {
      btn.textContent = '☆ 自选';
      btn.classList.remove('active');
    }
  },

  // 返回首页（issue3）：显示美化的首页，隐藏分析面板
  backHome() {
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('emptyState').classList.remove('hidden');
    this.updateUrlSymbol(null);
    // 首页不需要个股操作按钮
    const navExtra = document.getElementById('globalNavExtra');
    if (navExtra) navExtra.classList.add('hidden');
    if (typeof Notes !== 'undefined') Notes.renderHome();
    // 回到首页时刷新财经热点与宏观政策（走前端节流，不会频繁打接口）
    if (typeof HomeNews !== 'undefined') HomeNews.load();
    if (typeof MacroNews !== 'undefined') MacroNews.load();
    if (typeof HomeRank !== 'undefined') HomeRank.load();
  },

  // 切换股票时复位"不会随 analyze 自动重渲染"的面板，避免残留上一只股票的数据
  resetTransientPanels() {
    // 价格行为趋势推演面板：复位为加载态，待 loadPriceAction 重新拉取
    const paMeta = document.getElementById('paMeta');
    if (paMeta) paMeta.textContent = '数据加载中…';
    const paSummary = document.getElementById('paSummary');
    if (paSummary) paSummary.innerHTML = '';
    ['paLongTerm', 'paShortTerm', 'paCoord', 'paEdges'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<div class="pa-loading"><span class="skeleton sk-line"></span><span class="skeleton sk-line short"></span><span class="skeleton sk-line"></span></div>';
    });

    // 技术指标信号 meta 行：复位，避免残留上一只股票
    const signalMeta = document.getElementById('signalGridMeta');
    if (signalMeta) signalMeta.textContent = '';

    // 关闭可能打开的指标释义浮层，避免残留上一只股票
    const helpPop = document.getElementById('metricHelpPop');
    if (helpPop) helpPop.classList.remove('show');

    // AI 补全卡片：先清空，待 loadAICache 自动加载已存缓存（或显示提示）
    const aiBody = document.getElementById('aiAugmentBody');
    const aiDate = document.getElementById('aiAugmentDate');
    const aiRefresh = document.getElementById('aiAugmentRefresh');
    if (aiBody) aiBody.innerHTML = '<div class="ai-empty">正在检查已存的 AI 联网资料...</div>';
    if (aiDate) aiDate.textContent = '';
    if (aiRefresh) aiRefresh.style.display = 'none';
    this.aiAugmentSymbol = null;

    // 短期判断卡片的「财报资料同步」提示：复位，避免残留上一只股票
    const sdSync = document.getElementById('samedayReportSync');
    if (sdSync) { sdSync.style.display = 'none'; sdSync.innerHTML = ''; }

    // 行业分析总览卡片：复位，避免残留上一只股票数据
    const ibBody = document.getElementById('industryOverviewBody');
    const ibDate = document.getElementById('industryOverviewDate');
    const ibRefresh = document.getElementById('industryOverviewRefresh');
    if (ibBody) ibBody.innerHTML = '<div class="ai-empty">正在加载行业信息…</div>';
    if (ibDate) ibDate.textContent = '';
    if (ibRefresh) ibRefresh.style.display = 'none';
    this.industryBoardLoadedSymbol = null;
    this.industryBoardData = null;
    this.industryBoardLoading = false;
    this.industryHistoryData = null;
    this.industryStockMarketCapData = null;
    // 板块总市值走势（一/二/三级三图）：清空骨架并释放实例，避免残留上一只股票的图
    this._resetSectorCap();
    // 行业景气度卡片：隐藏容器 + 释放实例，避免残留上一只股票
    this._resetIndustryProsperity();


    // 评分追溯面板：关闭并取消卡片高亮，避免残留上一只股票的评分依据
    const stp = document.getElementById('scoreTracePanel');
    if (stp) stp.classList.add('hidden');
    ['techScoreCard', 'fundScoreCard', 'capitalScoreCard'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });

    // 资金热度评分复位为占位态
    const capEl = document.getElementById('capitalScore');
    const capDetail = document.getElementById('capitalScoreDetail');
    if (capEl) { capEl.textContent = '--'; capEl.className = 'score-value neutral'; }
    if (capDetail) capDetail.textContent = '资金量能加载后更新';

    // 概览补充卡片：复位，避免残留上一只股票数据
    this.overviewExtraSymbol = null;
    const resetExtra = (vId, dId, vText, dText) => {
      const v = document.getElementById(vId);
      const d = document.getElementById(dId);
      if (v) { v.textContent = vText; v.className = 'score-value' + (vId === 'aspectValue' ? ' aspect' : '') + ' neutral'; }
      if (d) d.textContent = dText || '';
    };
    resetExtra('industryScore', 'industryScoreDetail', '--', '');
    resetExtra('samedayVerdict', 'samedayDetail', '--', '');
    const accEl = document.getElementById('samedayAccuracy'); if (accEl) accEl.textContent = '';
    const confEl = document.getElementById('samedayConfidence'); if (confEl) { confEl.textContent = ''; confEl.className = 'sameday-badge'; }
    const titleEl = document.getElementById('samedayTitle'); if (titleEl) titleEl.textContent = '短期行情';
    const targetEl = document.getElementById('samedayTarget'); if (targetEl) targetEl.textContent = '';
    const btnEl = document.getElementById('samedayLogicBtn'); if (btnEl) btnEl.style.display = 'none';
    const logicEl = document.getElementById('samedayLogic'); if (logicEl) { logicEl.style.display = 'none'; logicEl.innerHTML = ''; }
    // 长期行情卡片复位
    resetExtra('longtermVerdict', 'longtermDetail', '--', '');
    const ltNote = document.getElementById('longtermNote'); if (ltNote) ltNote.textContent = '';
    const ltConf = document.getElementById('longtermConfidence'); if (ltConf) { ltConf.textContent = ''; ltConf.className = 'sameday-badge'; }
    const ltSub = document.getElementById('longtermSubtitle'); if (ltSub) ltSub.textContent = '';
    const ltBtn = document.getElementById('longtermLogicBtn'); if (ltBtn) ltBtn.style.display = 'none';
    const ltLogic = document.getElementById('longtermLogic'); if (ltLogic) { ltLogic.style.display = 'none'; ltLogic.innerHTML = ''; }
    resetExtra('aspectValue', 'aspectDetail', '--', '');

    // 期货关联面板：递增令牌，使上一只股票的迟到异步响应失效
    this.futuresToken = (this.futuresToken || 0) + 1;

    // 信息分析面板（CFA 统一框架）：复位，避免残留上一只股票内容
    const cdBody = document.getElementById('companyDeepBody');
    const cdDate = document.getElementById('companyDeepDate');
    if (cdBody) cdBody.innerHTML = '<div class="ai-empty">正在检查已存的信息分析资料...</div>';
    if (cdDate) cdDate.textContent = '';
    // 20260914h：按钮回默认态（无资料 → 「✨ AI 联网获取」）
    this._setCompanyDeepButtons(false);
    this.companyDeepLoadedSymbol = null;
    this.companyDeepData = null;
  },

  // ---- AI 联网资料补全（issue：内嵌 AI 工具，补全本地未覆盖资料）----
  async loadAIConfig() {
    try {
      const r = await fetch('/api/ai/config');
      this.aiConfig = await r.json();
    } catch {
      this.aiConfig = {
        provider: 'qwen', hasKey: false, modelWeb: '', modelLocal: '',
        searchMode: 'builtin', hasVolcKey: false, volcModel: '', hasBaiduKey: false,
        mcpQuota: null,
        useCustomProtocol: true,
      };
    }
    return this.aiConfig;
  },

  // 20260903n：按当前搜索方式显示/隐藏对应厂商的 Key 输入框
  syncSearchModeFields() {
    const modeEl = document.getElementById('aiSearchMode');
    const mode = modeEl ? modeEl.value : 'builtin';
    const volcBox = document.getElementById('aiVolcFields');
    const baiduBox = document.getElementById('aiBaiduFields');
    if (volcBox) volcBox.classList.toggle('hidden', mode !== 'volc');
    if (baiduBox) baiduBox.classList.toggle('hidden', mode !== 'baidu');
  },

  // 20260902d：双模型设置 —— 联网模型（modelWeb）/ 本地模型（modelLocal）/ useCustomProtocol
  // 20260903n：新增联网搜索方式回填（此前未回填，重开弹窗会被重置为 builtin）+ 火山/百度 Key 字段
  async openAISettings() {
    // 20260917：打开前强制重新拉取服务端最新配置，避免 init 时 loadAIConfig() 未 await 完成
    // 导致 this.aiConfig 为 undefined/旧值，从而误显示「尚未配置 API Key」「内置联网搜索」。
    try { await this.loadAIConfig(); } catch {}
    const cfg = this.aiConfig || { provider: 'qwen', modelWeb: '', modelLocal: '', hasKey: false, useCustomProtocol: true };
    document.getElementById('aiProvider').value = cfg.provider || 'qwen';
    document.getElementById('aiModelWeb').value = cfg.modelWeb || '';
    document.getElementById('aiModelLocal').value = cfg.modelLocal || '';
    document.getElementById('aiApiKey').value = '';
    const modeEl = document.getElementById('aiSearchMode');
    if (modeEl) modeEl.value = cfg.searchMode || 'builtin';
    const volcKeyEl = document.getElementById('aiVolcApiKey');
    if (volcKeyEl) volcKeyEl.value = '';
    const volcModelEl = document.getElementById('aiVolcModel');
    if (volcModelEl) volcModelEl.value = cfg.volcModel || '';
    const baiduKeyEl = document.getElementById('aiBaiduApiKey');
    if (baiduKeyEl) baiduKeyEl.value = '';
    this.syncSearchModeFields();
    const statusEl = document.getElementById('aiSettingsStatus');
    const localNote = cfg.modelLocal ? '｜本地模型已配置' : '｜本地模型未配置，财报解读将回退到联网模型';
    const protoNote = cfg.useCustomProtocol !== false ? '｜useCustomProtocol 已开启' : '｜useCustomProtocol 已关闭';
    const modeLabels = { builtin: '内置搜索', mcp: '阿里百炼 MCP', volc: '火山豆包', baidu: '百度千帆' };
    let searchNote = '｜搜索方式：' + (modeLabels[cfg.searchMode] || '内置搜索');
    if (cfg.searchMode === 'volc' && !cfg.hasVolcKey) searchNote += '（⚠️ 未配置火山 Key，将回退内置搜索）';
    if (cfg.searchMode === 'baidu' && !cfg.hasBaiduKey) searchNote += '（⚠️ 未配置百度 Key，将回退内置搜索）';
    // 20260904c：阿里 MCP 免费额度本地计数展示（用尽自动回退内置搜索）
    const mq = cfg.mcpQuota;
    if (cfg.searchMode === 'mcp' && mq && typeof mq.count === 'number') {
      if (mq.count >= mq.limit) {
        searchNote += `（⚠️ 免费额度已用尽：本地成功调用 ${mq.count}/${mq.limit}，已自动回退内置搜索）`;
      } else if (mq.count >= (mq.warnAt || 1800)) {
        searchNote += `（⚠️ 免费额度即将用尽：已成功调用 ${mq.count}/${mq.limit}，用尽自动回退内置）`;
      } else {
        searchNote += `（免费额度已用 ${mq.count}/${mq.limit}，用尽自动回退内置）`;
      }
    }
    statusEl.textContent = (cfg.hasKey ? '✅ 已配置 API Key（如无需更改请留空）' : '⚠️ 尚未配置 API Key') + localNote + protoNote + searchNote;
    statusEl.className = 'ai-settings-status ' + (cfg.hasKey ? 'ok' : 'warn');
    document.getElementById('aiSettingsModal').classList.remove('hidden');
  },

  closeAISettings() {
    document.getElementById('aiSettingsModal').classList.add('hidden');
  },

  async saveAISettings() {
    const provider = document.getElementById('aiProvider').value;
    const apiKey = document.getElementById('aiApiKey').value;
    const modelWeb = document.getElementById('aiModelWeb').value;
    const modelLocal = document.getElementById('aiModelLocal').value;
    const searchMode = document.getElementById('aiSearchMode').value;
    const volcEl = document.getElementById('aiVolcApiKey');
    const volcModelEl = document.getElementById('aiVolcModel');
    const baiduEl = document.getElementById('aiBaiduApiKey');
    const volcApiKey = volcEl ? volcEl.value : '';
    const volcModel = volcModelEl ? volcModelEl.value : '';
    const baiduApiKey = baiduEl ? baiduEl.value : '';
    const statusEl = document.getElementById('aiSettingsStatus');
    statusEl.textContent = '保存中…';
    statusEl.className = 'ai-settings-status';
    try {
      const r = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider, apiKey, modelWeb, modelLocal, useCustomProtocol: true,
          searchMode, volcApiKey, volcModel, baiduApiKey,
        }),
      });
      const j = await r.json();
      if (j.success) {
        this.aiConfig = j.config;
        const modeLabels = { builtin: '内置搜索', mcp: '阿里百炼 MCP', volc: '火山豆包（每月500次免费）', baidu: '百度千帆（每日100次免费）' };
        let warn = '';
        if (j.config.searchMode === 'volc' && !j.config.hasVolcKey) warn = '，⚠️ 火山 Key 为空将回退内置搜索';
        if (j.config.searchMode === 'baidu' && !j.config.hasBaiduKey) warn = '，⚠️ 百度 Key 为空将回退内置搜索';
        // 20260904c：保存后回显阿里 MCP 免费额度本地计数
        if (j.config.searchMode === 'mcp' && j.config.mcpQuota && typeof j.config.mcpQuota.count === 'number') {
          warn += `，免费额度已用 ${j.config.mcpQuota.count}/${j.config.mcpQuota.limit}（用尽自动回退内置）`;
        }
        statusEl.textContent = `✅ 已保存（搜索方式：${modeLabels[j.config.searchMode] || '内置搜索'}${warn}）`;
        statusEl.className = 'ai-settings-status ok';
        setTimeout(() => this.closeAISettings(), 1200);
      } else {
        statusEl.textContent = '❌ 保存失败：' + (j.error || '未知错误');
        statusEl.className = 'ai-settings-status warn';
      }
    } catch (e) {
      statusEl.textContent = '❌ 网络错误：' + e.message;
      statusEl.className = 'ai-settings-status warn';
    }
  },

  async runAIAugment(force) {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const body = document.getElementById('aiAugmentBody');
    const btn = document.getElementById('aiAugmentBtn');
    const refreshBtn = document.getElementById('aiAugmentRefresh');
    if (!body || !btn) return; // 概览页 AI 补全卡已移除，安全退出
    if (!this.aiConfig || !this.aiConfig.hasKey) {
      this.aiConfig = await this.loadAIConfig();
    }
    if (!this.aiConfig || !this.aiConfig.hasKey) {
      body.innerHTML = '<div class="ai-empty">⚠️ 尚未配置 API Key。请点击左侧栏「⚙️ AI 联网设置」填入通义千问等带联网搜索的 Key。</div>';
      return;
    }
    btn.disabled = true;
    btn.textContent = '搜索中…';
    refreshBtn.style.display = 'none';
    body.innerHTML = '<div class="ai-loading"><div class="loading-spinner"></div><p>AI 正在联网搜索 ' + (this.escapeHtml(this.currentData?.name || symbol)) + ' 的最新资料…</p></div>';
    try {
      const r = await fetch('/api/ai/augment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, stockName: this.currentData?.name || '', industry: '', force: !!force }),
      });
      const j = await r.json();
      if (j.success) {
        this.renderAIAugment(j);
      } else {
        body.innerHTML = '<div class="ai-empty">❌ ' + this.escapeHtml(j.message || '请求失败') + '</div>';
      }
    } catch (e) {
      body.innerHTML = '<div class="ai-empty">❌ 网络错误：' + this.escapeHtml(e.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = '一键补全';
    }
  },

  renderAIAugment(j) {
    const body = document.getElementById('aiAugmentBody');
    const dateEl = document.getElementById('aiAugmentDate');
    const refreshBtn = document.getElementById('aiAugmentRefresh');
    this.aiAugmentSymbol = this.currentSymbol; // 记录当前补全所属股票，供切换判断
    const d = new Date(j.date);
    const pad = (n) => String(n).padStart(2, '0');
    dateEl.textContent = (j.cached ? '缓存于 ' : '更新于 ') +
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    refreshBtn.style.display = '';
    let html = '<div class="ai-markdown">' + this.renderMarkdown(j.content) + '</div>';
    if (j.sources && j.sources.length) {
      html += '<div class="ai-sources"><div class="ai-sources-title">参考链接</div><ul>' +
        j.sources.map((u) => '<li><a href="' + this.escapeHtml(u) + '" target="_blank" rel="noopener">' + this.escapeHtml(u) + '</a></li>').join('') +
        '</ul></div>';
    }
    if (j.stale) {
      const lu = (j.fetchedAt || j.factMaxDate || '').toString().slice(0, 10);
      html += '<div class="mx-stale-note">⚠️ 本地事实已过期（最后更新 ' + this.escapeHtml(lu || '未知') + '），点击「一键补全」可重新抓取最新数据</div>';
    }
    const modeText = j.mode === 'local' ? '由本地公开资料（东财F10/巨潮）生成，未联网' : '由 AI 联网搜索生成';
    html += '<div class="ai-foot-note">' + modeText + '，仅供参考，请自行核实。模型：' + this.escapeHtml(j.model || '') + '</div>';
    body.innerHTML = html;
  },

  // ---- AI 估值大模型（提示词驱动，读取 prompts/valuation-system.md）----
  async loadValuationAICache() {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const body = document.getElementById('valuationAiBody');
    if (!body) return;
    try {
      const resp = await fetch(`/api/ai/valuation/${encodeURIComponent(symbol)}`);
      const data = await resp.json();
      if (this.currentSymbol !== symbol) return;
      if (data.success && (data.dedicated || (data.cached && data.content))) {
        // 20260908l：登记券商专属模型标的（供 runValuationAI 跳过 apiKey 校验/保留综合估值卡）
        if (data.dedicated && data.broker) {
          this._brokerSymbols = this._brokerSymbols || new Set();
          this._brokerSymbols.add(symbol);
        }
        this.renderValuationAI(data);
      }
    } catch {}
  },

  // 20260908l/p/q/r + 20260916g + 20260919f：该标的是否走专属确定性估值模型（601318 平安 / 券商 / 688289 圣湘 / 603288 海天 / 600460 士兰 / 600909 华安 / 000783 长江 / 300319 麦捷 / 688660 电气风电 / 000902 新洋丰 / 002643 万润）
  _isDedicated(sym) {
    const bare = String(sym || '').replace(/^(sh|sz|bj)/i, '');
    return bare === '601318' || bare === '688289' || bare === '603288' || bare === '600460' || bare === '600909' || bare === '000783' || bare === '300319' || bare === '688660' || bare === '000902' || bare === '002643' || !!(this._brokerSymbols && this._brokerSymbols.has(sym));
  },

  async runValuationAI(force) {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const body = document.getElementById('valuationAiBody');
    const btn = document.getElementById('valuationAiBtn');
    if (!body || !btn) return;
    // 20260905j：点击即切换到 AI 视图（隐藏规则版估值，同一模块原地展示 AI 结果）
    // 20260908c/l：601318 与券商专属模型标的保留规则版综合估值卡片，只把 AI 估值文本卡片换成专属明细卡
    const deepConc = document.getElementById('deepConclusion');
    if (deepConc && !this._isDedicated(this.currentSymbol)) deepConc.style.display = 'none';
    body.style.display = '';
    // 20260908b/l：专属确定性估值模型（601318/券商配置标的）无需 API Key，跳过密钥校验
    if (!this._isDedicated(this.currentSymbol)) {
      if (!this.aiConfig || !this.aiConfig.hasKey) {
        this.aiConfig = await this.loadAIConfig();
      }
      if (!this.aiConfig || !this.aiConfig.hasKey) {
        body.innerHTML = '<div class="ai-empty">⚠️ 尚未配置 API Key。请点击左侧栏「⚙️ AI 联网设置」填入通义千问等带联网搜索的 Key。</div>';
        return;
      }
    }
    btn.disabled = true;
    btn.textContent = '估值中…';
    body.innerHTML = '<div class="ai-loading"><div class="loading-spinner"></div><p>AI 估值大模型正在联网检索 ' + (this.escapeHtml(this.currentData?.name || symbol)) + ' 的行情/财报…</p></div>';
    try {
      const r = await fetch('/api/ai/valuation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, stockName: this.currentData?.name || '', industry: '', force: !!force }),
      });
      const j = await r.json();
      if (this.currentSymbol !== symbol) return;
      if (j.success) {
        this.renderValuationAI(j);
      } else {
        body.innerHTML = '<div class="ai-empty">❌ ' + this.escapeHtml(j.message || '请求失败') + '</div>';
      }
    } catch (e) {
      body.innerHTML = '<div class="ai-empty">❌ 网络错误：' + this.escapeHtml(e.message) + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = this._isDedicated(this.currentSymbol) ? '专属估值模型' : 'AI 估值';
    }
  },

  // 20260905k：解析 AI 估值输出的【机器可读摘要】JSON 块（提示词要求正文末尾固定附）
  _parseValuationSummary(content) {
    const text = String(content || '');
    const blocks = text.match(/```json\s*([\s\S]*?)```/g);
    if (!blocks || !blocks.length) return null;
    let s;
    try { s = JSON.parse(blocks[blocks.length - 1].replace(/```json\s*|\s*```/g, '').trim()); } catch { return null; }
    if (!s || !s.overallRating) return null;
    const lo = Number(s.fairValueLow), hi = Number(s.fairValueHigh);
    return {
      overallRating: String(s.overallRating),
      currentPrice: Number(s.currentPrice),
      fairValueRange: (isFinite(lo) && isFinite(hi)) ? [lo, hi] : null,
      fairValueCenter: isFinite(Number(s.fairValueCenter)) ? Number(s.fairValueCenter) : null,
      methodsUsed: Array.isArray(s.methodsUsed) ? s.methodsUsed.map(x => String(x)) : [],
    };
  },

  _stripValuationSummary(content) {
    return String(content || '')
      .replace(/```json[\s\S]*?```/g, '')
      .replace(/【机器可读摘要】[^\n]*/g, '')
      .trim();
  },

  _colorizeValuationText(html) {
    // 20260905r → 20260906e：AI 估值结论文本的语义着色（仅展示层，跳过 HTML 标签内部）
    // 实测 AI 正文从不出现「利好/利空」字面词，改为按标点切段、整段语义着色：
    // 利好段=红，利空段=绿，同段多空混合=黄；章节标题/命中提示/警告符号=黄
    return html.split(/(<[^>]+>)/g).map(part => {
      if (!part || /^</.test(part)) return part; // 标签原样
      return this._colorizeValuationChunk(part);
    }).join('');
  },

  _colorizeValuationChunk(text) {
    // 利好关键词（红）
    const RE_BULL = /(低估|被低估|安全边际|保护|支撑|提振|看好|积极|正面|乐观|充裕|稳健|修复|改善|优势|吸引力|高股息|竞争优势|护城河强)/;
    // 利空关键词（绿）。（?<!无)风险 排除"无风险利率"误判
    const RE_BEAR = /(亏损|恶化|偏高|过高|承压|压力大|压力较大|缩水|回避|高估|负面|悲观|侵蚀|流出|为负|下滑|下行|疲弱|疲软|减值|质押|退市|杠杆|占用严重|谨慎|跌破|回落|失效|失真|紧张|存疑|偏离|价格战|评级：弱|依赖|拖累|(?<!无)风险)/;
    // 用占位符保护已确定的着色片段，避免二次包裹
    const parts = [];
    const hold = (wrapped) => { parts.push(wrapped); return `\u0000${parts.length - 1}\u0000`; };
    let t = text
      .replace(/【[^】]+】/g, m => hold(`<span class="ai-text-key">${m}</span>`))
      .replace(/命中\d+项|⚠/g, m => hold(`<span class="ai-text-key">${m}</span>`));
    // 按句读切段，整段判色（同段多空并存→黄）
    t = t.replace(/[^，。；！？\n]+[，。；！？]?/g, seg => {
      if (!seg.trim()) return seg;
      const bull = RE_BULL.test(seg), bear = RE_BEAR.test(seg);
      if (bull && bear) return hold(`<span class="ai-text-key">${seg}</span>`);
      if (bull) return hold(`<span class="ai-text-bullish">${seg}</span>`);
      if (bear) return hold(`<span class="ai-text-bearish">${seg}</span>`);
      return seg;
    });
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => parts[Number(i)]);
  },

  renderValuationAI(j) {
    const body = document.getElementById('valuationAiBody');
    const dateEl = document.getElementById('valuationAiDate');
    if (!body) return;
    // 20260905j：AI 内容渲染时切换视图（缓存命中/生成成功均隐藏规则版估值，同模块原地显示 AI 结果）
    // 20260908c：专属模型(601318)保留规则版估值卡片，只替换 AI 估值文本卡片
    // 20260908m：顶部「综合估值评级」可视化卡对所有个股常显（统一平安模板布局：顶部滑条卡 + 明细卡）
    const deepConc = document.getElementById('deepConclusion');
    if (deepConc) deepConc.style.display = '';
    body.style.display = '';
    // ===== 20260908l：券商专属「分类+估值」卡片（仅配置了券商模型的标的），展示方式参照 601318 样本 =====
    // ① 券商分类判定（6指标+来源 → 三维评分 → 决策树） ② 估值模型计算过程（假设/乘数 + 输入数据出处）
    if (j && j.dedicated && j.broker) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + '确定性计算（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const metricsRows = (j.metricsRows || []).map(m => `
        <tr><td class="vd-label">${esc(m.label)}</td><td class="vd-value">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const scoreRows = (j.scoreRows || []).map(m => `
        <tr><td class="vd-label">${esc(m.label)}</td><td class="vd-value">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const modelRows = (j.modelRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);font-variant-numeric:tabular-nums;">${esc(m.value)}</td></tr>`).join('');
      const srcRows = (j.modelSources || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">🏦 ${esc(j.stockName || '')}（${esc(j.symbol || '')}）券商专属估值模型</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          <div class="vd-intervals">
            <div class="vd-iv"><span>综合估值区间（${esc(j.typeName || '')} · ${esc(j.primaryModel || '')}）</span><b>${fmtRange(j.fairValueRange)}</b></div>
            <div class="vd-iv"><span>当前股价${j.currentPB != null ? ' / 当前PB ' + fmt(j.currentPB) + ' 倍' : ''}</span><b>${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">① 券商分类判定（6 指标 → 三维评分 → 决策树）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>核心指标</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>${metricsRows}</tbody>
            </table>
            <table class="vd-table vd-src-table">
              <thead><tr><th>三维评分</th><th>得分</th><th>阈值（写死）</th></tr></thead>
              <tbody>${scoreRows}</tbody>
            </table>
            <div class="vd-formula">${esc(j.decisionNote || '')}</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">② 估值模型计算过程（${esc(j.primaryModel || '')}）</div>
            <table class="vd-table">
              <thead><tr><th>步骤</th><th>算式与结果</th></tr></thead>
              <tbody>${modelRows}</tbody>
            </table>
            <div class="vd-src-block">
              <div class="vd-src-title">输入数据出处</div>
              <table class="vd-table vd-src-table">
                <tbody>${srcRows}</tbody>
              </table>
            </div>
          </div>
          <div class="vd-foot">口径：分类与估值全部由确定性代码计算（阈值/乘数写死，输入锁死 ⇒ 结果锁死，与 AI 模型无关）。核心风险：${esc(j.riskPoint || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }
    // ===== 20260908t→20260922b/c：华安证券（600909）动态估值框架 V3.0 卡片（指令9：SOTP 权重自适应 + 影子股模式） =====
    // 布局 = 平安统一模板（vd-card 骨架）；内容 = 守门员自检 + 口径分离 + PB/SOTP/PE 动态加权（指令9）+ 评级与对比 + 风险监测；权重/模式随指令9实时计算动态渲染。
    if (j && j.dedicated && j.huaan) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + '确定性计算（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      // 指令9：权重/模式/标题随实时计算动态渲染（不再写死 V2.0 固定权重）
      const hVer = j.version || 'V3.0';
      const sd = j.sotpDynamic || {};
      const sdModeLabel = { shadow: '影子股模式', elevated: '显著参股模式', normal: '常规模式' }[sd.mode] || '';
      const sdW = sd.weights || { pb: 0.6, sotp: 0.3, pe: 0.1 };
      const wLabel = `PB ${Math.round(sdW.pb * 100)}% + SOTP ${Math.round(sdW.sotp * 100)}% + PE ${Math.round(sdW.pe * 100)}%`;
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const guardRows = (j.guardRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);white-space:nowrap;">${esc(m.status)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const dualEpsRows = (j.dualEpsRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const detailRows = (j.detailRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const compareRows = (j.compareRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const riskRows = (j.riskMonitorRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.light)}</td></tr>`).join('');
      // 20261029p：V3.0 异步数据自适应架构新区块——数据契约表 / 权重说明 / 降级留痕 / 三态输出+置信度
      const contractRows = (j.contractRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const dlogRows = (j.downgradeLog || []).map(d => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(d.item)}</td><td style="text-align:left;color:var(--text-primary);">${esc(d.why)}</td><td style="text-align:center;color:var(--text-primary);white-space:nowrap;">${esc(d.level)}</td><td style="text-align:left;color:var(--text-primary);">${esc(d.impact)}</td></tr>`).join('');
      // 20261030c：估值结构拆解 · 强制披露（五条：分项拆解/评级口径/影子股溢价/置信度/PB口径）
      const structureRows = (j.structureRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const stateBadge = j.outputState ? `<span style="margin-left:8px;padding:2px 8px;border-radius:10px;font-size:12px;background:rgba(240,185,123,0.15);color:var(--accent,#F0B97B);">${esc(j.outputState)} · 置信度 ${esc(j.confidence)}%</span>` : '';
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">🛡️ ${esc(j.stockName || '')}（${esc(j.symbol || '')}）动态估值框架 ${esc(hVer)}${sdModeLabel ? ' · ' + esc(sdModeLabel) : ''}${stateBadge}</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          <div class="vd-intervals">
            <div class="vd-iv"><span>综合目标价（${wLabel}）/ 当前股价</span><b>¥${fmt(j.fairValueCenter)} / ${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
            <div class="vd-iv"><span>目标价区间（下限×0.9 触发低估 ~ 上限×1.05 触发高估）</span><b>${fmtRange(j.fairValueRange)}</b></div>
          ${frStrip}
          ${j.summaryNote ? `<div class="vd-note">📋 ${esc(j.summaryNote)}</div>` : ''}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">① 守门员自检（指令0：不通过即终止估值）</div>
            <table class="vd-table">
              <thead><tr><th>检测项</th><th>状态</th><th>检测详情</th></tr></thead>
              <tbody>${guardRows}</tbody>
            </table>
            <div class="vd-formula"><b>${esc(j.caliberNote || '')}</b></div>
          </div>
          ${contractRows ? `
          <div class="vd-sec">
            <div class="vd-sec-title">② 数据契约表（异步数据自适应·第一层：无契约裸数据一律拒收）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>指标（层级）</th><th>期差/成熟度/结转标注</th><th>数值 ｜ 频率 ｜ 来源 ｜ 报告期</th></tr></thead>
              <tbody>${contractRows}</tbody>
            </table>
          </div>` : ''}
          <div class="vd-sec">
            <div class="vd-sec-title">${contractRows ? '③' : '②'} 核心数据摘要（双 EPS 口径分离 · 指令1）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源（附时间戳）</th></tr></thead>
              <tbody>${dualEpsRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">${contractRows ? '④' : '③'} 估值过程明细表（指令2 / 指令9 / 规则9：权重 ${wLabel}）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>步骤</th><th>算式与结果</th><th>来源</th></tr></thead>
              <tbody>${detailRows}</tbody>
            </table>
          </div>
          ${j.weightsNote ? `
          <div class="vd-sec">
            <div class="vd-sec-title">${contractRows ? '⑤' : '④'} 本次权重及调整原因（规则7-8：方法成熟度动态加权）</div>
            <div class="vd-formula">${esc(j.weightsNote)}</div>
          </div>` : ''}
          ${dlogRows ? `
          <div class="vd-sec">
            <div class="vd-sec-title">${contractRows ? '⑥' : '⑤'} 降级留痕（第四层：L0 正常 → L1 结转 → L2 区间化 → L3 降权 → L4 待更新）</div>
            <table class="vd-table">
              <thead><tr><th>指标</th><th>原因</th><th>级别</th><th>对目标价的影响</th></tr></thead>
              <tbody>${dlogRows}</tbody>
            </table>
          </div>` : ''}
          ${structureRows ? `
          <div class="vd-sec">
            <div class="vd-sec-title">${contractRows ? '⑦' : '⑤'} 估值结构拆解 · 强制披露（分项拆解 / 评级口径 / 影子股溢价 / 置信度 / PB口径）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>披露项</th><th>内容（全部动态计算）</th><th>依据</th></tr></thead>
              <tbody>${structureRows}</tbody>
            </table>
          </div>` : ''}
          <div class="vd-sec">
            <div class="vd-sec-title">${contractRows ? '⑧' : '④'} 综合目标价、评级与上次对比（指令3 / 规则12 区间判定）</div>
            <div class="vd-formula">${esc(j.positionNote || '')}</div>
            <table class="vd-table" style="margin-top:8px;">
              <tbody>${compareRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">${contractRows ? '⑨' : '⑤'} 风险监测（指令4）</div>
            <table class="vd-table">
              <tbody>${riskRows}</tbody>
            </table>
          </div>
          <div class="vd-foot">口径：全部由确定性代码计算（输入锁死 ⇒ 结果锁死，与 AI 模型无关）；守门员任一项终止则历史结论不再外推；异步数据自适应架构下黄/红项自动区间化并留痕，不输出伪精确点值。${esc(j.decisionNote || '')}【关键风险】${esc(j.riskNote || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }
    // ===== 20260908w：圣湘生物（688289）专属「V2.0_全动态」卡片 =====
    // 布局 = 平安统一模板（vd-card 骨架：头部+徽章 / 区间行 / 分节 / 脚注）；
    // 内容 = 动态时间引擎 + 画像诊断 + 动态SOTP + 五重交叉验证 + 权重自适应 + 三情景 + 兜底状态。
    if (j && j.dedicated && j.sanxi) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + (j.version || 'V2.0_全动态') + '（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const reportHeadRows = (j.reportHeadRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source || '')}</td></tr>`).join('');
      const diagRows = (j.diagRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const coreRows = (j.coreRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const sotpRows = (j.sotpRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const xvalRows = (j.xvalRows || []).map(m => `
        <tr><td class="vd-label">${esc(m.model)}</td><td class="vd-value">${fmt(m.perShare)}</td><td class="vd-value">${esc(m.weight)}</td><td class="vd-value">${fmt(m.contribution)}</td><td style="text-align:left;color:var(--text-secondary);font-size:12px;">${esc(m.note)}</td></tr>`).join('');
      const weightRows = (j.weightRows || []).map(m => `<div class="vd-note">⚖️ ${esc(m.text)}</div>`).join('');
      const fallbackRows = (j.fallbackFlags || []).map(s => `<div class="vd-note vd-warn">🛟 ${esc(s)}</div>`).join('') || '<div class="vd-note">✅ 机构预期 / 最新季报 / 行业倍数三项数据齐备，未触发兜底回退</div>';
      const scenRows = (j.scenRows || []).map(m => `
        <tr><td class="vd-label">${esc(m.name)}</td><td class="vd-value">¥${fmt(m.value)}</td><td style="text-align:left;color:var(--text-secondary);font-size:12px;">${esc(m.note)}</td></tr>`).join('');
      // 20261029r：V3.0 三轨并行新区块——五表锚定/三轨明细/风险折价/异常警报
      const fiveTableRows = (j.fiveTableRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}${m.source ? `<div class="vd-src" style="display:block;margin-top:2px;font-size:11px;">${esc(m.source)}</div>` : ''}</td></tr>`).join('');
      const threeTrackRows = (j.threeTrackRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}${m.source ? `<div class="vd-src" style="display:block;margin-top:2px;font-size:11px;">${esc(m.source)}</div>` : ''}</td></tr>`).join('');
      const riskDiscRows = (j.riskDiscRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.item)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.trigger)}</td><td class="vd-value" style="white-space:nowrap;">${m.disc > 0 ? '−' + (m.disc * 100).toFixed(1) + '%' : '不触发'}</td><td style="text-align:left;color:var(--text-secondary);font-size:12px;">${esc(m.scope)}</td></tr>`).join('');
      const alertNotes = (j.alerts && j.alerts.length)
        ? j.alerts.map(s => `<div class="vd-note vd-warn">⚠️ ${esc(s)}</div>`).join('')
        : '<div class="vd-note">✅ 未触发任何异常检测（5 触发器全部通过）</div>';
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">🧬 ${esc(j.stockName || '')}（${esc(j.symbol || '')}）专属估值模型${j.version ? ' · ' + esc(j.version) : ''}</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          <div class="vd-intervals">
            <div class="vd-iv"><span>三轨并行最终区间（折价后 · 每股）</span><b>${fmtRange(j.fairValueRange)}</b></div>
            <div class="vd-iv"><span>三轨合成中枢 / 当前股价</span><b>¥${fmt(j.fairValueCenter)} / ${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
          ${frStrip}
          ${j.summaryNote ? `<div class="vd-note">📋 ${esc(j.summaryNote)}</div>` : ''}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">数据层 · 五表锚定（表A硬锚 / 表B软锚禁倒推 / 表C TTM唯一合法桥接 / 表D实时 / 表E可比中位）</div>
            <table class="vd-table">
              <thead><tr><th>锚定表</th><th>数值与出处</th></tr></thead>
              <tbody>${fiveTableRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">估值层 · 三轨并行（轨道I 相对估值 50% + 轨道II SOTP 35% + 轨道III 历史分位 15%，缺口权重再分配）</div>
            <table class="vd-table">
              <thead><tr><th>轨道</th><th>算式与结果</th></tr></thead>
              <tbody>${threeTrackRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">异常检测 · 5 触发器状态（区间倒挂 / 轨间背离 / TTM 缺口 / 极端分位 / 商誉）</div>
            ${alertNotes}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">风险折价（合成后施加 · 仅下调不回加；合计系数 ${j.totalDiscCoef != null ? esc(j.totalDiscCoef) : 'N/A'}）</div>
            <table class="vd-table">
              <thead><tr><th>折价项</th><th>触发条件</th><th>幅度</th><th>作用范围</th></tr></thead>
              <tbody>${riskDiscRows}</tbody>
            </table>
          </div>
          ${j.consoNote ? `<div class="vd-note">🔗 ${esc(j.consoNote)}</div>` : ''}
          <div class="vd-note">—— 以下为 V2.1 六模型 legacy 附录（完整保留运行 · 参照不参与三轨合成）——</div>
          <div class="vd-sec">
            <div class="vd-sec-title">⓪ 动态时间引擎（基准日=系统日，自动映射财报期）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>${reportHeadRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">① 公司画像动态诊断（每次运行自动刷新 → 模型路由）</div>
            <table class="vd-table">
              <thead><tr><th>诊断项</th><th>判定与路由</th></tr></thead>
              <tbody>${diagRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">② 核心假设与数据出处</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>${coreRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">③ 动态 SOTP 分部估值明细（核心模型）</div>
            <table class="vd-table">
              <thead><tr><th>板块 / 步骤</th><th>算式与结果</th></tr></thead>
              <tbody>${sotpRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">④ 六模型交叉验证汇总（基准情景 · 权重自适应后）</div>
            <table class="vd-table">
              <thead><tr><th>模型</th><th>每股(元)</th><th>权重</th><th>加权贡献</th><th>说明</th></tr></thead>
              <tbody>${xvalRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑤ 权重自适应分配（±5%规则联动）与兜底状态</div>
            ${weightRows}
            ${fallbackRows}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑥ 三情景测试（行业倍数 ±10%）</div>
            ${(j.secAxis && j.secAxis.note) ? `<div class="vd-note vd-axis-hl">🔎 ${esc(j.secAxis.note)}</div>` : ''}
            ${(j.secAxis && j.secAxis.anchorLine) ? `<div class="vd-note vd-axis-anchor">📐 ${esc(j.secAxis.anchorLine)}</div>` : ''}
            <table class="vd-table">
              <thead><tr><th>情景</th><th>综合每股(元)</th><th>参数设定</th></tr></thead>
              <tbody>${scenRows}</tbody>
            </table>
          </div>
          ${(j.sellExpRows && j.sellExpRows.length) ? `
          <div class="vd-sec">
            <div class="vd-sec-title">⑦ 销售费用显性调整模块（性质拆解 / SOTP 差异化 / Forward PE 费用效率 / EV-EBITDA 列示）</div>
            <table class="vd-table">
              <thead><tr><th>步骤 / 判定项</th><th>判定与算式</th></tr></thead>
              <tbody>${j.sellExpRows.map(m => `<tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}${m.source ? `<div class="vd-src" style="display:block;margin-top:2px;font-size:11px;">${esc(m.source)}</div>` : ''}</td></tr>`).join('')}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑧ 销售费用情景测试（费用优化 / 基准 / 费用恶化）</div>
            <table class="vd-table">
              <thead><tr><th>情景</th><th>综合每股(元)</th><th>参数设定与传导</th></tr></thead>
              <tbody>${(j.sellExpScenRows || []).map(m => `<tr><td class="vd-label">${esc(m.name)}</td><td class="vd-value">¥${fmt(m.value)}</td><td style="text-align:left;color:var(--text-secondary);font-size:12px;">${esc(m.note)}</td></tr>`).join('')}</tbody>
            </table>
          </div>` : ''}
          <div class="vd-formula">${esc(j.decisionNote || '')}</div>
          <div class="vd-foot">口径：顶层结论（评级/区间/中枢）= V3.0 三轨并行（五表锚定+TTM拼接唯一合法桥接+风险折价仅下调），全部由确定性代码计算，与 AI 模型无关；V2.1 六模型附录参照不参与合成。假设项已在表中标注。【关键风险】${esc(j.riskNote || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }
    // ===== 20260908o：海天味业（603288）专属「动态估值引擎」卡片 =====
    // 布局 = 平安统一模板（vd-card 骨架）；内容 = DCF锚 + PE校准 + 三情景，确定性计算。
    if (j && j.dedicated && j.haitian) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + '动态估值引擎（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const paramRows = (j.paramRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const matrixRows = (j.matrixRows || []).map(m => `
        <tr class="${m.method === '综合建议区间' ? 'vd-seg-total' : ''}"><td class="vd-label">${esc(m.method)}</td><td class="vd-value">¥${fmt(m.low)}</td><td class="vd-value">¥${fmt(m.mid)}</td><td class="vd-value">¥${fmt(m.high)}</td><td style="text-align:left;color:var(--text-secondary);font-size:12px;">${esc(m.note)}</td></tr>`).join('');
      const scenRows = (j.scenRows || []).map(m => `
        <tr><td class="vd-label">${esc(m.name)}</td><td class="vd-value">¥${fmt(m.value)}</td><td style="text-align:left;color:var(--text-secondary);font-size:12px;">${esc(m.note)}</td></tr>`).join('');
      // 20260908v：V2.0_修复版 输出协议（运行报告头 + 情景横幅 + 替代警告 + QA状态）
      const reportHeadRows = (j.reportHeadRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const substituteRows = (j.substituteRows || []).map(s => `<div class="vd-note vd-warn">⚠️ ${esc(s)}</div>`).join('');
      const qaRows = (j.qaRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.light)}</td></tr>`).join('');
      const scenarioBanner = j.scenarioBanner ? `<div class="vd-note" style="border:1px solid var(--accent);border-radius:8px;padding:8px 10px;color:var(--accent);">🔀 ${esc(j.scenarioBanner)}</div>` : '';
      // 20261029n：V3.0 输出协议新增区块（架构声明 / 数据时效矩阵 / 混频处理声明·健康度 / WACC×g 敏感性）
      const archRows = (j.archRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const timeMatrixRows = (j.timeMatrixRows || []).map(v => `
        <tr><td class="vd-label">${esc(v.name)}</td><td class="vd-value">${v.value != null ? esc(v.value) : 'N/A'}</td><td class="vd-value">${esc(v.period)}</td><td class="vd-value">${esc(v.frequency)}</td><td class="vd-value">${v.staleness}天</td><td style="text-align:left;color:var(--text-secondary);font-size:12px;">${esc(v.caliber || '')}</td><td style="text-align:center;">${esc(v.flag)}</td></tr>`).join('');
      const mixingNote = j.mixingNote ? `<div class="vd-formula">${esc(j.mixingNote)}</div>` : '';
      const sens = j.sensitivity;
      const sensTable = (sens && sens.grid && sens.waccs && sens.gs) ? (() => {
        const head = `<tr><th>WACC % \\ g %</th>${sens.gs.map(g => `<th>${g}${g === sens.baseG ? '（基准g）' : ''}</th>`).join('')}</tr>`;
        const body = sens.grid.map((row, i) => `<tr><td class="vd-label">${sens.waccs[i]}${sens.waccs[i] === sens.baseWacc ? '（基准WACC）' : ''}</td>${row.map(v => `<td class="vd-value" style="${v == null ? 'color:var(--text-secondary);' : ''}${(v != null && sens.waccs[i] === sens.baseWacc && sens.gs[row.indexOf(v)] === sens.baseG) ? 'font-weight:bold;color:var(--accent);' : ''}">${v == null ? '不满足硬约束' : '¥' + v}</td>`).join('')}</tr>`).join('');
        return `<table class="vd-table"><thead>${head}</thead><tbody>${body}</tbody></table><div class="vd-note">口径：主模型 DCF 每股价值（元）；金色加粗 = 基准情景；「不满足硬约束」= 该组合 WACC − g &lt; 1.5pct（第六章硬约束自动拦截）。</div>`;
      })() : '';
      const healthChip = j.healthScore != null ? `<div class="vd-note">💊 数据健康度：<b>${j.healthScore}/100</b>（${esc(j.healthLabel)}）${j.healthWarning ? '　' + esc(j.healthWarning) : ''}</div>` : '';
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">🧂 ${esc(j.stockName || '')}（${esc(j.symbol || '')}）动态估值引擎 ${esc(j.version || 'V3.0_架构重构版')}</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          <div class="vd-intervals">
            <div class="vd-iv"><span>综合建议区间（保守边界 ~ 高估边界）</span><b>${fmtRange(j.fairValueRange)}</b></div>
            <div class="vd-iv"><span>综合中枢 / 当前股价</span><b>¥${fmt(j.fairValueCenter)} / ${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
          ${frStrip}
          </div>
          ${scenarioBanner}
          ${substituteRows}
          <div class="vd-sec">
            <div class="vd-sec-title">⓪ 估值引擎运行报告（输出协议 · 补丁#7）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>内容</th><th>说明</th></tr></thead>
              <tbody>${reportHeadRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⓪.5 架构声明（V3.0 四大支柱 · 第十一章）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>架构项</th><th>声明</th><th>来源</th></tr></thead>
              <tbody>${archRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⓪.6 数据时效矩阵（图例：🟢季报级最新 / 🟡年报比率反推 / 🔴超1年未更新）</div>
            <table class="vd-table">
              <thead><tr><th>变量</th><th>数值</th><th>数据截止期</th><th>频率</th><th>距今天数</th><th>口径</th><th>状态</th></tr></thead>
              <tbody>${timeMatrixRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⓪.7 混频处理声明 + 数据健康度（第七/八/十章）</div>
            ${healthChip}
            ${mixingNote}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⓪.8 WACC（±0.5pct）× g（±0.5pct）敏感性矩阵（3×3）</div>
            ${sensTable}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">① 模型参数输入（本次运行采用）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>参数</th><th>取值</th><th>来源</th></tr></thead>
              <tbody>${paramRows}</tbody>
            </table>
            <div class="vd-formula">${esc(j.decisionNote || '')}</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">② 估值结论矩阵（动态区间，禁止单一目标价）</div>
            <table class="vd-table">
              <thead><tr><th>估值方法</th><th>低估边界</th><th>合理中枢</th><th>高估边界</th><th>说明</th></tr></thead>
              <tbody>${matrixRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">③ 三情景压力测试（量化触发条件 · 补丁#5）</div>
            <table class="vd-table">
              <thead><tr><th>情景</th><th>综合中枢(元)</th><th>参数设定与触发条件</th></tr></thead>
              <tbody>${scenRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">④ 当前位置判断</div>
            <div class="vd-formula">${esc(j.positionNote || '')}</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑤ QA 检查状态（估值输出前最后关卡 · 补丁#4）</div>
            <table class="vd-table">
              <tbody>${qaRows}</tbody>
            </table>
          </div>
          <div class="vd-foot">口径：全部由确定性代码计算（全量重算+输入锁死 ⇒ 结果锁死，与 AI 模型无关）；核心估值逻辑（DCF 50% + 动态PE 50% + 三情景）不变，架构按 V3.0 四大支柱重构。【关键扰动因子】${esc(j.riskNote || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }
    // ===== 20260908s：士兰微（600460）专属景气度动态估值引擎卡片 =====
    // 布局 = 平安统一模板（vd-card 骨架）；内容 = 景气度评分→情景权重→PE/PB/PS(+DCF)情景加权，确定性计算。
    if (j && j.dedicated && j.silan) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + '确定性计算（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const cycRows = (j.cycRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.status)}（${m.score > 0 ? '+' : ''}${esc(m.score)} 分）</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const scenRows = (j.scenRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const matrixRows = (j.matrixRows || []).map(m => `
        <tr class="${m.method.indexOf('情景综合') === 0 ? 'vd-seg-total' : ''}"><td class="vd-label">${esc(m.method)}</td><td class="vd-value">${m.low == null ? '—' : '¥' + fmt(m.low)}</td><td class="vd-value">${m.mid == null ? '—' : '¥' + fmt(m.mid)}</td><td class="vd-value">${m.high == null ? '—' : '¥' + fmt(m.high)}</td><td style="text-align:left;color:var(--text-secondary);font-size:12px;">${esc(m.note)}</td></tr>`).join('');
      const assumpRows = (j.assumpRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const coreRows = (j.coreRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      // 20261029q：数据治理升级版新区块——报告期身份证台账/级别矩阵/口径锁定/自检清单/完整度徽章
      const ledgerRows = (j.dataLedgerRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);white-space:nowrap;">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const lvlRows = (j.levelMatrixRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.level)}级</td><td style="text-align:left;color:var(--text-primary);">${esc(m.period)}</td><td style="text-align:center;color:var(--text-primary);">${m.synced === true ? '✅ 同步' : (m.synced === false ? '⚠️ 滞后' : '—')}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.note)}</td></tr>`).join('');
      const calRows = (j.caliberRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);white-space:nowrap;">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const chkRows = (j.checklistRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${m.pass ? '✅' : '⚠️'} ${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.detail)}</td></tr>`).join('');
      const compBadge = j.completeness != null ? `<span style="margin-left:8px;padding:2px 8px;border-radius:10px;font-size:12px;background:rgba(240,185,123,0.15);color:var(--accent,#F0B97B);">完整度 ${esc(j.completeness)}/100${j.anchor ? ' · 锚点 ' + esc(j.anchor.asOf) + '（' + esc(j.anchor.stageLabel) + '）' : ''}</span>` : '';
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">⚡ ${esc(j.stockName || '')}（${esc(j.symbol || '')})专属景气度动态估值引擎${compBadge}</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          <div class="vd-intervals">
            <div class="vd-iv"><span>最终目标价（三情景按景气度权重加权）/ 当前股价</span><b>¥${fmt(j.fairValueCenter)} / ${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
            <div class="vd-iv"><span>情景综合区间（悲观 ~ 乐观）</span><b>${fmtRange(j.fairValueRange)}</b></div>
          ${frStrip}
          ${j.summaryNote ? `<div class="vd-note">📋 ${esc(j.summaryNote)}</div>` : ''}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">① 景气度判断（H级高频数据·指令第三步：评分 → 情景权重）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>指标</th><th>最新状态</th><th>数据来源（附时间戳）</th></tr></thead>
              <tbody>${cycRows}</tbody>
            </table>
          </div>
          ${ledgerRows ? `
          <div class="vd-sec">
            <div class="vd-sec-title">② 数据报告期身份证台账（第一道防火墙：无三要素标签禁入估值公式）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>数据项（级别）</th><th>报告期 ｜ 获取方式</th><th>取值与备注</th></tr></thead>
              <tbody>${ledgerRows}</tbody>
            </table>
            <div class="vd-formula"><b>${esc(j.decisionNote || '')}</b></div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">③ 级别-报告期矩阵（第五章 5.2：滞后级别自动触发替代规则）</div>
            <table class="vd-table">
              <thead><tr><th>级别</th><th>当前对应报告期</th><th>与锚点同步</th><th>处理说明</th></tr></thead>
              <tbody>${lvlRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">④ 口径锁定指标（第四章：分子=基准日总市值，分母强制同报告期；拦截规则生效）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>指标</th><th>数值</th><th>口径（分子÷分母）</th></tr></thead>
              <tbody>${calRows}</tbody>
            </table>
          </div>` : ''}
          <div class="vd-sec">
            <div class="vd-sec-title">${ledgerRows ? '⑤' : '②'} 各情景目标价明细（适用财年 2026E/2027E）</div>
            <table class="vd-table">
              <tbody>${scenRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">${ledgerRows ? '⑥' : '③'} 估值方法矩阵与情景合成</div>
            <table class="vd-table">
              <thead><tr><th>估值方法</th><th>悲观</th><th>基准</th><th>乐观</th><th>说明</th></tr></thead>
              <tbody>${matrixRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">${ledgerRows ? '⑦' : '④'} 关键假设汇总表（变量取值依据）</div>
            <table class="vd-table">
              <tbody>${assumpRows}</tbody>
            </table>
            <div class="vd-sec-sub">数据出处补充</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>${coreRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">${ledgerRows ? '⑧' : '⑤'} 当前估值水位（实时口径 + 预期涨幅评级）</div>
            <div class="vd-formula">${esc(j.positionNote || '')}</div>
            ${(j.sensHints && j.sensHints.length) ? `<div class="vd-note">📏 口径敏感性提示：${j.sensHints.map(h => esc(h)).join('；')}</div>` : ''}
          </div>
          ${chkRows ? `
          <div class="vd-sec">
            <div class="vd-sec-title">⑨ 输出前自检清单（第八章：任一不通过则标注警示）</div>
            <table class="vd-table">
              <tbody>${chkRows}</tbody>
            </table>
          </div>` : ''}
          <div class="vd-foot">口径：全部由确定性代码计算（输入锁死 ⇒ 结果锁死，与 AI 模型无关）；本模型自动适配任意时点，景气度回落时情景权重自动切换，财报披露后锚点自动前移。【关键风险】${esc(j.riskNote || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }
    // ===== 20260909b：麦捷科技（300319）专属动态逻辑估值引擎卡片 =====
    // 布局 = 平安统一模板（vd-card 骨架）；内容 = 时间引擎 + 画像诊断 + 三情景 + 四路估值矩阵 + 交叉验证 + 监控指标。
    if (j && j.dedicated && j.maijie) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + '确定性计算（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const alertStrip = (j.alerts && j.alerts.length) ? '<div class="vd-note">⚠️ ' + j.alerts.map(a => esc(a)).join('；') + '</div>' : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const segRows = (j.segRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const scenRows = (j.scenRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const matrixRows = (j.matrixRows || []).map(m => `
        <tr class="${m.method.indexOf('情景综合') === 0 ? 'vd-seg-total' : ''}"><td class="vd-label">${esc(m.method)}</td><td class="vd-value">${m.low == null ? '—' : '¥' + fmt(m.low)}</td><td class="vd-value">${m.mid == null ? '—' : '¥' + fmt(m.mid)}</td><td class="vd-value">${m.high == null ? '—' : '¥' + fmt(m.high)}</td><td style="text-align:left;color:var(--text-secondary);font-size:12px;">${esc(m.note)}</td></tr>`).join('');
      const assumpRows = (j.assumpRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const coreRows = (j.coreRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const monitorRows = (j.monitorRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">⚡ ${esc(j.stockName || '')}（${esc(j.symbol || '')}）专属动态逻辑估值引擎</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          <div class="vd-intervals">
            <div class="vd-iv"><span>综合中枢（三情景加权）/ 当前股价</span><b>¥${fmt(j.fairValueCenter)} / ${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
            <div class="vd-iv"><span>综合区间（悲观 ~ 乐观）</span><b>${fmtRange(j.fairValueRange)}</b></div>
            <div class="vd-iv"><span>保守目标价（安全边际后）/ 上行空间</span><b>¥${fmt(j.conservativeTarget)} / ${j.upside != null ? j.upside + '%' : 'N/A'}</b></div>
          ${frStrip}
          ${alertStrip}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">① 画像诊断（业务拆分 + 生命周期判定）</div>
            <table class="vd-table">
              <tbody>${segRows}</tbody>
            </table>
            <div class="vd-formula">${esc(j.decisionNote || '')}</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">② 三情景财务预测与目标价明细</div>
            <table class="vd-table">
              <tbody>${scenRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">③ 四路估值矩阵与情景合成</div>
            <table class="vd-table">
              <thead><tr><th>估值方法</th><th>悲观</th><th>基准</th><th>乐观</th><th>说明</th></tr></thead>
              <tbody>${matrixRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">④ 关键假设汇总表（变量取值依据）</div>
            <table class="vd-table">
              <tbody>${assumpRows}</tbody>
            </table>
            <div class="vd-sec-sub">数据出处补充</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>${coreRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑤ 当前估值水位与交叉验证</div>
            <div class="vd-formula">${esc(j.positionNote || '')}</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑥ 关键监控指标（触发条件）</div>
            <table class="vd-table">
              <tbody>${monitorRows}</tbody>
            </table>
          </div>
          <div class="vd-foot">口径：全部由确定性代码计算（输入锁死 ⇒ 结果锁死，与 AI 模型无关）；模型自动适配最新报告期与实时行情。【核心风险】${esc(j.riskNote || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }
    // ===== 20261030d：新洋丰（000902）专属「全自动动态估值 V2.0」引擎卡片 =====
    // 布局 = 统一 vd-card 骨架；内容 = 〇内生判定(三信号) → 一期间锚定与数据质量(R1-R6) → 二核心输入量 → 三估值三角(PE-TTM/EV-EBIT/PB-ROE) → 四三情景 → 五期权增量(独立) → 六反向验证 → 七结论与置信度。确定性计算。
    if (j && j.dedicated && j.xinyangfeng) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + '确定性计算（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const cfoStrip = j.cfoVeto ? '<div class="vd-note" style="color:#F0B97B;border:1px solid #F0B97B;border-radius:8px;padding:8px 10px;font-weight:600;background:rgba(240,185,123,0.08);">⚠️ ' + esc(j.cfoVetoWarning || '现金流硬性否决已触发') + ' 置信度已锁定【低】，保守情景 E_TTM 下调系数强制加深至 0.82~0.84。</div>' : '';
      const openingStrip = j.openingStatement ? '<div class="vd-note" style="border:1px solid var(--accent);border-radius:8px;padding:8px 10px;">📌 ' + esc(j.openingStatement) + '</div>' : '';
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const alertStrip = (j.alerts && j.alerts.length) ? '<div class="vd-note">⚠️ ' + j.alerts.map(a => esc(a)).join('；') + '</div>' : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const kv = (arr, cls) => (arr || []).map(m => `
        <tr class="${cls || ''}"><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td>${m.source ? '<td class="vd-src">' + esc(m.source) + '</td>' : ''}</tr>`).join('');
      const nvRows = (arr) => (arr || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const revRows = (arr) => (arr || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.id)}</td><td style="text-align:center;color:var(--text-primary);">${esc(m.result)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.detail)}</td></tr>`).join('');
      const failRows = (j.failRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.id)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.text)}</td><td class="vd-src" style="white-space:nowrap;">${esc(m.status)}${m.threshold != null ? '（阈值 ' + esc(m.threshold) + '）' : ''}</td></tr>`).join('');
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">⚡ ${esc(j.stockName || '')}（${esc(j.symbol || '')}）专属「全自动动态估值 V2.1（六项防呆防错补丁）」引擎</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          ${cfoStrip}
          ${openingStrip}
          <div class="vd-intervals">
            <div class="vd-iv"><span>基准合理价（中枢）/ 当前股价</span><b>¥${fmt(j.fairValueCenter)} / ${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
            <div class="vd-iv"><span>三情景区间（保守 ~ 乐观）</span><b>${fmtRange(j.fairValueRange)}</b></div>
            <div class="vd-iv"><span>保守目标价（区间下沿）/ 相对现价</span><b>¥${fmt(j.conservativeTarget)} / ${j.conservativePct != null ? (j.conservativePct >= 0 ? '+' : '') + j.conservativePct + '%' : (j.upside != null ? j.upside + '%（乐观情景空间）' : 'N/A')}</b></div>
          ${frStrip}
          ${alertStrip}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">〇 内生判定声明（A1 三信号多数决 · CYCLE_VIEW=${esc(j.cycleView || '中性')}）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源/判定</th></tr></thead>
              <tbody>${kv(j.cycleRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">一 期间锚定与数据质量声明（R1-R6 · 硬约束：不静默替代）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源/标记</th></tr></thead>
              <tbody>${kv(j.periodRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">二 核心输入量（构造路径标签）</div>
            <table class="vd-table">
              <tbody>${kv(j.coreRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">三 估值三角（① PE-TTM 主 / ② EV/EBIT 交叉 / ③ PB-ROE 锚）</div>
            <table class="vd-table">
              <tbody>${kv(j.tripleRows)}</tbody>
            </table>
            <div class="vd-formula">${esc(j.decisionNote || '')}</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">四 三情景估值（保守 / 基准 / 乐观 · 同向 E×PE 调整）</div>
            <table class="vd-table">
              <tbody>${nvRows(j.scenRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">五 期权增量（独立列示，不并入基准目标价）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值/条件</th><th>来源</th></tr></thead>
              <tbody>${kv(j.optionRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">六 反向验证清单（逐项 是/否/不适用）</div>
            <table class="vd-table">
              <thead><tr><th>编号</th><th>结果</th><th>说明</th></tr></thead>
              <tbody>${revRows(j.reverseRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">七 结论与置信度（指令集六档）</div>
            <div class="vd-formula">${esc(j.summaryNote || '')}</div>
            <div class="vd-note">置信度【${esc(j.confidence || 'N/A')}】：${esc(j.confidenceNote || '')}</div>
            <div class="vd-note">硬约束核验：${esc(j.hardConstraintNote || '')}</div>
            <div class="vd-sec-sub">模型失效预警</div>
            <div class="vd-formula">${esc(j.modelFailureNote || '')}</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>编号</th><th>失效条件</th><th>状态</th></tr></thead>
              <tbody>${failRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">八 当前估值水位</div>
            <div class="vd-formula">${esc(j.positionNote || '')}</div>
          </div>
          <div class="vd-foot">口径：全部由确定性代码计算（配置锁死权威快照 + 全动态算法，与 AI 模型无关）；算法框架 100% 按 v2.0 指令集实现。【关键风险】${esc(j.riskNote || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }

    // ===== 20260919f：万润股份（002643）专属「永久逻辑」估值引擎卡片（替换旧通用 PE估值带 模型）=====
    // 布局 = 统一 vd-card 骨架；内容 = 三层加权（PB-ROE 50% / PE 35% / DCF 15%）→ 五业务单元叙事 → 三情景 → 敏感性(两矩阵) → 防失真规则 → 失效预警。确定性计算。
    if (j && j.dedicated && j.wanrun) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + '确定性计算（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const alertStrip = (j.alerts && j.alerts.length) ? '<div class="vd-note">⚠️ ' + j.alerts.map(a => esc(a)).join('；') + '</div>' : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const kv = (arr, cls) => (arr || []).map(m => `
        <tr class="${cls || ''}"><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td>${m.source ? '<td class="vd-src">' + esc(m.source) + '</td>' : ''}</tr>`).join('');
      const nvRows = (arr) => (arr || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const failRows = (j.failRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.id)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.text)}</td><td class="vd-src" style="white-space:nowrap;">${esc(m.status)}${m.threshold != null ? '（阈值 ' + esc(m.threshold) + '）' : ''}</td></tr>`).join('');
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">⚡ ${esc(j.stockName || '')}（${esc(j.symbol || '')}）专属估值引擎${j.version ? ' · ' + esc(j.version) : ''}${j.anchor2 && j.anchor2.asOf ? `<span style="margin-left:8px;padding:2px 8px;border-radius:10px;font-size:12px;background:rgba(240,185,123,0.15);color:var(--accent,#F0B97B);">锚点 ${esc(j.anchor2.asOf)}（${esc(j.anchor2.stageLabel)}）</span>` : ''}</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          <div class="vd-intervals">
            <div class="vd-iv"><span>三层加权目标价 / 当前股价</span><b>¥${fmt(j.fairValueCenter)} / ${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
            <div class="vd-iv"><span>置信度区间（半宽 ±${j.confLayers ? esc(j.confLayers.halfPct) : '—'}% · 平均置信度 ${j.confLayers ? esc(j.confLayers.avg) : '—'}）</span><b>${fmtRange(j.fairValueRange)}</b></div>
            <div class="vd-iv"><span>保守目标价（安全边际后）/ 上行空间</span><b>¥${fmt(j.conservativeTarget)} / ${j.upside != null ? j.upside + '%' : 'N/A'}</b></div>
          ${frStrip}
          ${alertStrip}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">① 估值基准与数据来源</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>${kv(j.reportHeadRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">② 数据更新表（最新财报 + 行情 + 行业 + 一致预期）</div>
            <table class="vd-table">
              <tbody>${kv(j.diagRows)}</tbody>
            </table>
            <div class="vd-formula">${esc(j.decisionNote || '')}</div>
          </div>
          ${(j.cbRows && j.cbRows.length) ? `
          <div class="vd-sec">
            <div class="vd-sec-title">②·0 v2.1 四项熔断状态表（数据熔断与异常校准，强制开启不可关闭）</div>
            <table class="vd-table">
              <tbody>${j.cbRows.map(m => `<tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('')}</tbody>
            </table>
          </div>` : ''}
          ${(j.spliceRows && j.spliceRows.length) ? `
          <div class="vd-sec">
            <div class="vd-sec-title">②·1 v2.0 数据拼接与置信度表（外推/插补/近似逐项标注，点估计不变）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>字段</th><th>层级</th><th>替代规则</th><th>置信度</th><th>数值</th></tr></thead>
              <tbody>${j.spliceRows.map(m => `<tr><td class="vd-label" style="white-space:nowrap;">${esc(m.field)}</td><td style="text-align:center;color:var(--accent,#F0B97B);">${esc(m.layer)}</td><td style="text-align:left;color:var(--text-primary);font-size:12px;">${esc(m.method)}</td><td style="text-align:center;">${m.conf != null ? esc(m.conf) : '—'}</td><td style="text-align:left;color:var(--text-primary);white-space:nowrap;">${esc(m.value)}<div class="vd-src" style="font-size:11px;">截止 ${esc(m.asOf)}</div></td></tr>`).join('')}</tbody>
            </table>
          </div>` : ''}
          ${(j.weightRows && j.weightRows.length) ? `
          <div class="vd-sec">
            <div class="vd-sec-title">②·2 v2.0 权重调整与置信度传导（先 DCF 再平衡 → 再置信度调整 → 归一化）</div>
            <table class="vd-table">
              <tbody>${kv(j.weightRows)}</tbody>
            </table>
          </div>` : ''}
          ${(j.checkRows && j.checkRows.length) ? `
          <div class="vd-sec">
            <div class="vd-sec-title">②·3 v2.0 一致性校验四条（总和 / 趋势 / 环比 / 交叉）</div>
            <table class="vd-table">
              <thead><tr><th>校验</th><th>结果与处理</th></tr></thead>
              <tbody>${j.checkRows.map(m => `<tr><td class="vd-label" style="white-space:nowrap;">${m.pass ? '✅' : '⚠️'} ${esc(m.id)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.detail)}</td></tr>`).join('')}</tbody>
            </table>
          </div>` : ''}
          <div class="vd-sec">
            <div class="vd-sec-title">③ 三层加权估值（第一层 PB-ROE 主锚 / 第二层 PE 相对 / 第三层 DCF 辅助）</div>
            <table class="vd-table">
              <tbody>${kv(j.layerRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">④ 业务估值单元（显示 / 环保 / 半导体 / 生命科学 / 新能源 · 叙事，不单独估值）</div>
            <table class="vd-table">
              <tbody>${kv(j.unitRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑤ 三情景估值（悲观 / 基准 / 乐观）</div>
            <table class="vd-table">
              <tbody>${nvRows(j.scenRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑥ 敏感性分析（矩阵一 可持续ROE×目标PE / 矩阵二 预测净利×目标PE）</div>
            <table class="vd-table">
              <tbody>${nvRows(j.sensRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑦ 防失真规则落地（汇兑剥离 / 季报ROE / 股本 / 分歧预警 / 大客户 / 新产能）</div>
            <table class="vd-table">
              <tbody>${kv(j.distortionRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑧ 关键假设与数据出处</div>
            <table class="vd-table">
              <tbody>${kv(j.assumpRows)}</tbody>
            </table>
            <div class="vd-sec-sub">数据出处</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>${kv(j.coreRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑨ 模型触发条件与失效预警</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>编号</th><th>触发条件</th><th>状态</th></tr></thead>
              <tbody>${failRows}</tbody>
            </table>
            <div class="vd-formula">${esc(j.modelFailureNote || '')}</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑩ 当前估值水位</div>
            <div class="vd-formula">${esc(j.positionNote || '')}</div>
          </div>
          ${j.versionNote ? `<div class="vd-sec">
            <div class="vd-sec-title">⑪ 版本记录（本次更新日期 / 数据截止期 / 关键假设变化）</div>
            <div class="vd-formula">${esc(j.versionNote)}</div>
          </div>` : ''}
          <div class="vd-foot">口径：v2.1 数据熔断与异常校准——v2.0 四层分级基础上强制开启四项熔断（①行业PE极值熔断 >60倍/80%分位 → 基准PE=min(中位数,60)；②市场隐含定价反向约束 隐含利润vs一致预期偏差>30% → 取均值；③D层行情时效 >5交易日标滞后+置信度0.6、>15交易日禁止方向信号；④层间背离一票否决 差异>100% → 取较低者合并、释放权重转 DCF）。A层流量统一「累计转单季再滚动TTM」、存量用最近时点、置信度只影响区间宽度与层权重（点估计不变），全部由确定性代码计算，与 AI 模型无关；三层加权框架永久不变。【关键风险】${esc(j.riskNote || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }
    // ===== 20261104i：威高血净（603014）专属「动态估值引擎 V1.0」卡片（九指令整合版） =====
    // 布局 = 统一 vd-card 骨架；内容 = 〇并表状态与口径声明 → 一三口径桥接表 → 二数据新鲜度总览 → 三核心财务矩阵 →
    // 四业绩承诺追踪 → 五DCF三档 → 六相对估值交叉验证+PE归因 → 七协同期权(独立) → 八对价合理性(独立) →
    // 九反向验证 → 十结论与置信度+跟踪变量 → 十一当前水位。确定性计算。
    if (j && j.dedicated && j.weigao) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + '确定性计算（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const openingStrip = j.openingStatement ? '<div class="vd-note" style="border:1px solid var(--accent);border-radius:8px;padding:8px 10px;">📌 ' + esc(j.openingStatement) + '</div>' : '';
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const alertStrip = (j.alerts && j.alerts.length) ? '<div class="vd-note">⚠️ ' + j.alerts.map(a => esc(a)).join('；') + '</div>' : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const kv = (arr, cls) => (arr || []).map(m => `
        <tr class="${cls || ''}"><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td>${m.source ? '<td class="vd-src">' + esc(m.source) + '</td>' : ''}</tr>`).join('');
      const nvRows = (arr) => (arr || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const revRows = (arr) => (arr || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.id)}</td><td style="text-align:center;color:var(--text-primary);">${esc(m.result)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.detail)}</td></tr>`).join('');
      const failRowsHtml = (j.failRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.id)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.text)}</td><td class="vd-src" style="white-space:nowrap;">${esc(m.status)}${m.threshold != null ? '（阈值 ' + esc(m.threshold) + '）' : ''}</td></tr>`).join('');
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">⚡ ${esc(j.stockName || '')}（${esc(j.symbol || '')}）专属「动态估值引擎（九指令整合版）」</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          ${openingStrip}
          <div class="vd-intervals">
            <div class="vd-iv"><span>DCF 基准合理价 / 当前股价</span><b>¥${fmt(j.fairValueCenter)} / ${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
            <div class="vd-iv"><span>DCF 三档区间（悲观 ~ 乐观）</span><b>${fmtRange(j.fairValueRange)}</b></div>
            <div class="vd-iv"><span>加协同期权中值后综合基准价值</span><b>${j.synergyAdjCenter != null ? '¥' + fmt(j.synergyAdjCenter) : 'N/A'}（期权独立列示，不并入基准）</b></div>
          ${frStrip}
          ${alertStrip}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">〇 并表状态与口径声明（指令二：P/C/F 状态表 + 三口径定义）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源/判定</th></tr></thead>
              <tbody>${kv(j.consolidationRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">一 三口径桥接表（指令三：缺项视为运行无效）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>standalone｜普瑞全期｜备考｜法定合并｜并表</th><th>桥接规则</th></tr></thead>
              <tbody>${kv(j.bridgeRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">二 数据新鲜度总览（指令四：A/B/C 分级与降级协议）</div>
            <div class="vd-formula">${esc(j.freshnessOverview || '')}</div>
            <div class="vd-note">质量折价规则：改变权重，不改变原始数值——A 级权重 1.0；B 级增长率假设 ×0.85 收缩；C 级不进基准现金流、行业中值保守替代并强制标注。</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">三 核心财务矩阵（指令五：[报告期 | 新鲜度 | 口径 | 质量标记]）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>指标</th><th>数值（含四联标注）</th><th>来源/校验</th></tr></thead>
              <tbody>${kv(j.coreRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">四 业绩承诺追踪与商誉减值敏感性（指令六 · 口径③）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>规则/说明</th></tr></thead>
              <tbody>${kv(j.promiseRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">五 DCF 三档估值（指令七·轨道A：分部双轨，DCF 主锚）</div>
            <table class="vd-table">
              <tbody>${nvRows(j.dcfRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">六 相对估值分部交叉验证（指令七·轨道B）与 PE 归因</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源/规则</th></tr></thead>
              <tbody>${kv(j.compRows)}</tbody>
            </table>
            <table class="vd-table vd-src-table" style="margin-top:6px;">
              <thead><tr><th>PE 口径</th><th>数值</th><th>口径/归因</th></tr></thead>
              <tbody>${kv(j.peRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">七 协同效应看涨期权（指令八：独立列示，不并入基准 DCF）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值/条件</th><th>来源</th></tr></thead>
              <tbody>${kv(j.optionRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">八 对价合理性检验（指令八：独立结论，与 DCF 并列）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源/规则</th></tr></thead>
              <tbody>${kv(j.considerationRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">九 反向验证清单（逐项 是/否）</div>
            <table class="vd-table">
              <thead><tr><th>编号</th><th>结果</th><th>说明</th></tr></thead>
              <tbody>${revRows(j.reverseRows)}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">十 结论与置信度 + 核心跟踪变量（指令九⑨⑪）</div>
            <div class="vd-formula">${esc(j.summaryNote || '')}</div>
            <div class="vd-note">置信度【${esc(j.confidence || 'N/A')}】：${esc(j.confidenceNote || '')}</div>
            <div class="vd-note">硬约束核验：${esc(j.hardConstraintNote || '')}</div>
            <div class="vd-sec-sub">核心跟踪变量（下一报告期重点校验项）</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>内容</th><th>说明</th></tr></thead>
              <tbody>${kv(j.trackRows)}</tbody>
            </table>
            <div class="vd-sec-sub">模型失效/人工干预预警</div>
            <div class="vd-formula">${esc(j.modelFailureNote || '')}</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>编号</th><th>失效条件</th><th>状态</th></tr></thead>
              <tbody>${failRowsHtml}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">十一 当前估值水位</div>
            <div class="vd-formula">${esc(j.positionNote || '')}</div>
          </div>
          <div class="vd-foot">口径：全部由确定性代码计算（配置锁死权威快照 + 全动态算法，与 AI 模型无关）；算法框架 100% 按九指令整合版实现。执行顺序：并表状态识别 → 三口径桥接 → 数据新鲜度分级 → 核心矩阵构建 → 估值引擎 → 动态结论。【关键风险】${esc(j.riskNote || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }

    // ===== 20260908r：长江证券（000783）专属 PB-ROE 动态估值引擎卡片 =====
    // 布局 = 平安统一模板（vd-card 骨架）；内容 = PB-ROE主模型 + 理论PB + SOTP交叉验证 + 敏感性/信号/风险看板，确定性计算。
    if (j && j.dedicated && j.changjiang) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + '确定性计算（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const coreRows = (j.coreRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      // 20260922e 补丁F：矩阵行支持 emph（估值体系重构警告行 → 红字粗体 + 淡红底，置顶）
      const matrixRows = (j.matrixRows || []).map(m => {
        const warn = !!m.emph;
        const cls = warn ? 'vd-mat-warn' : (m.method.indexOf('综合') === 0 ? 'vd-seg-total' : '');
        // 20260922e 补丁F：矩阵行 emph 为「估值体系重构警告」→ 琥珀橙（风险/口径提示，非利好利空）
        const trSt = warn ? ' style="background:rgba(240,185,123,0.10);"' : '';
        const cellSt = warn ? ' style="color:#F0B97B;font-weight:700;"' : '';
        const noteSt = warn ? ' style="text-align:left;color:#F0B97B;font-weight:600;font-size:12px;"' : ' style="text-align:left;color:var(--text-secondary);font-size:12px;"';
        return `<tr class="${cls}"${trSt}><td class="vd-label"${cellSt}>${esc(m.method)}</td><td class="vd-value"${cellSt}>${m.low == null ? '—' : '¥' + fmt(m.low)}</td><td class="vd-value"${cellSt}>${m.mid == null ? '—' : '¥' + fmt(m.mid)}</td><td class="vd-value"${cellSt}>${m.high == null ? '—' : '¥' + fmt(m.high)}</td><td${noteSt}>${esc(m.note)}</td></tr>`;
      }).join('');
      const sotpRows = (j.sotpRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const sensRows = (j.sensRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);font-variant-numeric:tabular-nums;">¥${esc(m.value)}</td></tr>`).join('');
      const riskRows = (j.riskLights || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.light)}</td></tr>`).join('');
      // 20260922e 补丁F：区间标签改为由模型输出动态生成（原硬编码「BVPS × PB 1.33/1.40/1.50」已失效）
      const pF = j.patchF || {};
      const rangeLabel = pF.boundaryFixed
        ? `目标价区间（动态锚基准 × ${Number(pF.downMult || 0.75).toFixed(2)} ~ × ${Number(pF.upMult || 1.2).toFixed(2)}，补丁F 强制外扩）`
        : '目标价区间（极端悲观 PB 10%分位 ~ 极端乐观 PB 90%分位）';
      const fStrip = pF.anchorBreached ? '<div class="vd-note" style="color:#F0B97B;font-weight:600;">⚠️ 估值体系重构警告：' + esc(pF.reframeNote || '') + '</div>' : '';
      // 20260922f 补丁G：动态锚跌破历史50%分位 → 周期底部估值体系防御提示条
      const pG = j.patchG || {};
      const gStrip = pG.anchorFloorActive
        ? '<div class="vd-note" style="color:#F0B97B;font-weight:600;">🛡️ 补丁G·周期底部估值体系防御：' + esc(pG.anchorFloorNote || '') + '（估值底线 = 近5年真实50%分位 ' + Number(pG.floorPb || 0).toFixed(3) + ' 倍 → ¥' + fmt(pG.floorPrice) + '）</div>'
        : '';
      // 20260922g 补丁G·规则4 + 补丁J·规则③：长周期均值锚（1.33倍）→ 乐观复苏情景（仅备注，不参与主模型；双闸门未满足则不展示）。
      // 补丁J：若主模型中枢 > 长周期均值锚（倒挂），则自动转为「均值回归底线」（下行保护参考），不再标注「乐观复苏」。
      const vLabel = (pG.recovery && pG.recovery.inverted) ? '📉 均值回归底线（仅备注，不参与主模型）' : '🌟 乐观复苏情景（仅备注，不参与主模型）';
      const vStrip = (pG.recovery && pG.recovery.active)
        ? '<div class="vd-note" style="color:#8AB4F8;font-weight:600;">' + vLabel + '：' + esc(pG.recovery.note || '') + '</div>'
        : '';
      // 20261030e 补丁I：极值纠偏、逻辑闭环与动态数据强同步（规则①②③④ 渲染）
      const pI = j.patchI || {};
      const iStrip = (pI.rule1) ? (() => {
        const parts = [];
        const r1 = pI.rule1 || {};
        const psLabel = ({ 'caller-injected-live': '调用方注入实时价', 'live-quote-fallback': '实时行情快照回退' })[r1.priceSource] || r1.priceSource || 'N/A';
        parts.push('<div class="vd-note" style="color:#F0B97B;font-weight:600;">🔄 补丁I·规则①运行时态数据强同步：强制使用当日行情快照现价（来源：' + esc(psLabel) + '），严禁历史残留现价（如 8.51）</div>');
        const r2 = pI.rule2 || {};
        if (r2.anchorCapped) {
          parts.push('<div class="vd-note" style="color:#F0B97B;font-weight:600;">📌 补丁I·规则②三位一体向下约束（防悬空）：' + esc(r2.cappedNote || '') + '</div>');
        }
        const r2b = pI.rule2b || {};
        const r3 = pI.rule3 || {};
        if (r2b.floorBreached) {
          parts.push('<div class="vd-note" style="color:#F0B97B;font-weight:700;">⚠️ 补丁I·规则③边界常识校验：' + esc(r2b.floorBreachWarn || '') + '</div>');
        } else if (r3.maxDownsidePct != null) {
          parts.push('<div class="vd-note" style="color:#F0B97B;font-weight:600;">📉 补丁I·规则③边界常识校验：极端悲观已锁历史铁底 ¥' + fmt(r3.extremeLowLocked) + ' → 潜在最大下行风险仅 ' + esc(r3.maxDownsidePct) + '%</div>');
        }
        const r4 = pI.rule4 || {};
        if (r4.ratingDowngraded) {
          parts.push('<div class="vd-note" style="color:#F0B97B;font-weight:700;">⚠️ 补丁I·规则④戴维斯双杀预警 + 熔断降级（重大机会）：' + esc(r4.davisNote || '') + (r4.buyRange ? '　💡 买入区间建议：¥' + fmt(r4.buyRange[0]) + ' ~ ¥' + fmt(r4.buyRange[1]) : '') + '</div>');
        }
        return parts.join('');
      })() : '';
      // 20261029o V3-五法则：核心逻辑摘要条带（输出模板③，≤200字）
      const sumStrip = j.summaryNote ? '<div class="vd-note" style="border:1px solid var(--accent);border-radius:8px;padding:8px 10px;">📋 核心逻辑摘要：' + esc(j.summaryNote) + '</div>' : '';
      // 20261029o V3-五法则：数据新鲜度仪表盘（输出模板①：刚性实时层/柔性平滑层报告期标签）
      const dashRows = (j.dashboardRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-value">${esc(m.period || '')}</td></tr>`).join('');
      const dashSec = dashRows ? `
          <div class="vd-sec">
            <div class="vd-sec-title">⓪ 数据新鲜度仪表盘（第一法则：刚性实时层［最新报告期］/ 柔性平滑层［推算估算值］）</div>
            <table class="vd-table">
              <thead><tr><th>数据项</th><th>数值</th><th>报告期/基准</th></tr></thead>
              <tbody>${dashRows}</tbody>
            </table>
          </div>` : '';
      // 20261029o V3-五法则：SOTP 休眠降级条带（第三法则）
      const dormStrip = (j.layers && j.layers.sotpDormant) ? '<div class="vd-note" style="color:#F0B97B;font-weight:600;">⏸️ SOTP 休眠降级（' + esc(j.layers.sotpStageLabel || '') + '）：因财报披露颗粒度不足，SOTP暂不作为决策依据，其估值结果仅作参考上限。</div>' : '';
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">⚡ ${esc(j.stockName || '')}（${esc(j.symbol || '')}）专属 PB-ROE 动态估值引擎 ${esc(j.version || '')}</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          <div class="vd-intervals">
            <div class="vd-iv"><span>${esc(rangeLabel)}</span><b>${fmtRange(j.fairValueRange)}</b></div>
            <div class="vd-iv"><span>中枢目标价 / 当前股价</span><b>¥${fmt(j.fairValueCenter)} / ${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
          ${frStrip}
          ${fStrip}
          ${gStrip}
          ${vStrip}
          ${iStrip}
          ${sumStrip}
          </div>
          ${dashSec}
          <div class="vd-sec">
            <div class="vd-sec-title">① 核心假设与数据出处</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>${coreRows}</tbody>
            </table>
            <div class="vd-formula">${esc(j.decisionNote || '')}</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">② 估值结论矩阵</div>
            <table class="vd-table">
              <thead><tr><th>估值方法</th><th>低估边界</th><th>合理中枢</th><th>高估边界</th><th>说明</th></tr></thead>
              <tbody>${matrixRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">③ SOTP 分部加总${(j.layers && j.layers.sotpDormant) ? '（休眠降级 · 仅参考上限）' : '（交叉验证）'}</div>
            ${dormStrip}
            <table class="vd-table vd-src-table">
              <thead><tr><th>分部</th><th>估值过程</th><th>来源</th></tr></thead>
              <tbody>${sotpRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">④ 敏感性 · 买卖信号 · 风险看板</div>
            <table class="vd-table">
              <tbody>${sensRows}</tbody>
            </table>
            <div class="vd-formula">${esc(j.yieldNote || '')}</div>
            <div class="vd-formula">${esc(j.positionNote || '')}</div>
            <table class="vd-table" style="margin-top:8px;">
              <tbody>${riskRows}</tbody>
            </table>
          </div>
          <div class="vd-foot">口径：全部由确定性代码计算（输入锁死 ⇒ 结果锁死，与 AI 模型无关）；假设项已标注。【关键风险】${esc(j.riskNote || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }
    // ===== 20260909h：电气风电（688660）专属「动态周期估值模型 DCAVM v1.0」卡片 =====
    // 布局 = 平安统一模板（vd-card 骨架）；内容 = 景气周期评分 + 业务/SOTP分部 + 多路估值矩阵 + 三情景 + 假设 + 敏感性 + 监控。
    if (j && j.dedicated && j.dcavm) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + '确定性计算（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const alertStrip = (j.alerts && j.alerts.length) ? '<div class="vd-note">⚠️ ' + j.alerts.map(a => esc(a)).join('；') + '</div>' : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const cycRows = (j.cycRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const segRows = (j.segRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const sotpSegRows = (j.sotpSegRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const scenRows = (j.scenRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const matrixRows = (j.matrixRows || []).map(m => `
        <tr class="${m.method.indexOf('动态加权合成') === 0 ? 'vd-seg-total' : ''}"><td class="vd-label">${esc(m.method)}</td><td class="vd-value">${m.low == null ? '—' : '¥' + fmt(m.low)}</td><td class="vd-value">${m.mid == null ? '—' : '¥' + fmt(m.mid)}</td><td class="vd-value">${m.high == null ? '—' : '¥' + fmt(m.high)}</td><td style="text-align:left;color:var(--text-secondary);font-size:12px;">${esc(m.note)}</td></tr>`).join('');
      const sensRows = (j.sensRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td class="vd-value">${m.tpDCF == null ? '—' : '¥' + fmt(m.tpDCF)}</td></tr>`).join('');
      const assumpRows = (j.assumpRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      const coreRows = (j.coreRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.label)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td><td class="vd-src">${esc(m.source)}</td></tr>`).join('');
      const monitorRows = (j.monitorRows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m.name)}</td><td style="text-align:left;color:var(--text-primary);">${esc(m.value)}</td></tr>`).join('');
      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">🌬 ${esc(j.stockName || '')}（${esc(j.symbol || '')}）专属动态周期估值模型 DCAVM</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>
          <div class="vd-intervals">
            <div class="vd-iv"><span>综合中枢（周期动态加权）/ 当前股价</span><b>¥${fmt(j.fairValueCenter)} / ${j.currentPrice != null ? '¥' + fmt(j.currentPrice) : 'N/A'}</b></div>
            <div class="vd-iv"><span>综合区间（悲观 ~ 乐观）</span><b>${fmtRange(j.fairValueRange)}</b></div>
            <div class="vd-iv"><span>保守目标价（安全边际后）/ 上行空间</span><b>¥${fmt(j.conservativeTarget)} / ${j.upside != null ? j.upside + '%' : 'N/A'}</b></div>
          ${frStrip}
          ${alertStrip}
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">① 景气周期评分（量化子指标加权 → 周期阶段）</div>
            <table class="vd-table">
              <tbody>${cycRows}</tbody>
            </table>
            <div class="vd-formula">综合评分 ${esc(j.cycleScore)}/100 → 当前阶段【${esc(j.cycleBand)}】；WACC ${esc(j.wacc)}%；可比 PE 中位 ${esc(j.peMedian)}× / PB 中位 ${esc(j.pbMedian)}×。</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">② 业务分部与 SOTP 分部估值</div>
            <div class="vd-sec-sub">业务结构（收入占比）</div>
            <table class="vd-table">
              <tbody>${segRows}</tbody>
            </table>
            <div class="vd-sec-sub">SOTP 分部加总明细</div>
            <table class="vd-table">
              <tbody>${sotpSegRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">③ 多路估值矩阵与动态加权合成</div>
            <table class="vd-table">
              <thead><tr><th>估值方法</th><th>悲观</th><th>基准</th><th>乐观</th><th>说明</th></tr></thead>
              <tbody>${matrixRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">④ 三情景综合目标价</div>
            <table class="vd-table">
              <tbody>${scenRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑤ 关键假设汇总与数据出处</div>
            <table class="vd-table">
              <tbody>${assumpRows}</tbody>
            </table>
            <div class="vd-sec-sub">数据出处补充</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>项目</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>${coreRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑥ DCF 敏感性（对永续增长 g）</div>
            <table class="vd-table">
              <tbody>${sensRows}</tbody>
            </table>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑦ 当前估值水位与交叉验证</div>
            <div class="vd-formula">${esc(j.positionNote || '')}</div>
          </div>
          <div class="vd-sec">
            <div class="vd-sec-title">⑧ 关键监控指标（触发条件）</div>
            <table class="vd-table">
              <tbody>${monitorRows}</tbody>
            </table>
          </div>
          <div class="vd-foot">口径：全部由确定性代码计算（输入锁死 ⇒ 结果锁死，与 AI 模型无关）；模型自动适配最新报告期与实时行情。DCAVM = 动态周期估值模型，针对风电设备强周期、TTM PE 常为负的特征，以归一化盈利 + 资产锚 + 周期阶段动态加权合成。【核心风险】${esc(j.riskNote || '')}</div>
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }
    // ===== 20260908x：中国平安（601318）「滚动估值协议 v2.0」—— 统一单卡片：
    //   ⓪ 协议汇总表（固定模板逐格填充）｜① SOTP 分部明细（熔断可跳过）｜② DDM 简表 ｜③ P/EV 简表
    if (j && j.dedicated) {
      const btn = document.getElementById('valuationAiBtn');
      if (btn) btn.textContent = '专属估值模型';
      if (dateEl) dateEl.textContent = (j.reportLabel ? j.reportLabel + ' · ' : '') + (j.version || '滚动估值协议') + '（无 AI 参与）';
      const ratingMap = { '低估': 'vd-rating-low', '买入': 'vd-rating-low', '合理': 'vd-rating-mid', '高估': 'vd-rating-high', '需人工复核': 'vd-rating-mid', '无法评级': 'vd-rating-mid' };
      const ratingCls = ratingMap[j.rating] || 'vd-rating-mid';
      const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
      const frStrip = (j.freshnessRows && j.freshnessRows.length) ? (() => {
        const stale = j.freshnessRows.filter(f => f.stale);
        const items = j.freshnessRows.map(f => esc(f.label) + ' ' + esc(f.asOf) + '（' + f.ageDays + '天）' + (f.stale ? '⚠️' : ''));
        return '<div class="vd-note">⏱ 数据时效：' + items.join(' · ') + (stale.length ? '　⚠️ ' + stale.length + ' 项超龄，请复核更新' : '　✅ 全部在有效期内') + '</div>';
      })() : '';
      const fmt = (x) => (x == null || x === '' ? 'N/A' : Number(x).toFixed(2));
      const fmtRange = (r) => (r && r.length === 2) ? `${fmt(r[0])} ~ ${fmt(r[1])}` : 'N/A';
      const sotp = j.sotpDetails || {};
      const ddm = j.ddmDetails || {};
      const pev = j.pevDetails || {};
      const Nrow = (sotp.inputs || []).find(i => i.key === 'N');
      const Nval = Nrow ? Nrow.value : null;

      // ⓪ 协议汇总表（逐格填充）
      const sumRows = (j.summaryRows || j.rows || []).map(m => `
        <tr><td class="vd-label" style="white-space:nowrap;">${esc(m[0])}</td><td class="vd-value" style="text-align:left;color:var(--text-primary);">${esc(m[1])}</td></tr>`).join('');
      // 报告期自适应告警
      const alertRows = (j.alerts || []).map(s => `<div class="vd-note vd-warn">⚠️ ${esc(s)}</div>`).join('');

      // v3.1.1 缺失变量处理规则：缺失只在备注行汇总说明，禁止在备注行之外单独输出 ⚠️ 缺失警告
      const skipNote = (j.sotpSkipped || (sotp && sotp.skipped))
        ? `<div class="vd-note vd-warn">🛟 ${esc(j.sotpSkipReason || sotp.skipReason || 'SOTP：数据不足，已跳过')}</div>` : '';

      // ① SOTP 分部估值明细表（折扣系数 + 分部价值）——熔断跳过时隐藏
      const segRows = (sotp.segments || []).map(s => `
        <tr>
          <td class="vd-label">${esc(s.name)}</td>
          <td class="vd-value">${fmt(s.value)}</td>
          <td class="vd-value">×${fmt(s.multiplier)}</td>
          <td class="vd-value">${fmt(s.result)}</td>
        </tr>`).join('');
      // SOTP 原始数据出处表
      const srcRows = (sotp.inputs || []).map(i => `
        <tr>
          <td class="vd-label">${esc(i.key)}</td>
          <td class="vd-label">${esc(i.label)}</td>
          <td class="vd-value">${fmt(i.value)}${i.unit ? ' ' + esc(i.unit) : ''}</td>
          <td class="vd-src">${esc(i.source)}</td>
        </tr>`).join('');
      const sotpSec = (j.sotpSkipped || (sotp && sotp.skipped)) ? '' : `
        <div class="vd-sec">
          <div class="vd-sec-title">① SOTP 分部估值（参与极值法合成 · ±${fmt(sotp.band != null ? sotp.band * 100 : 10)}%）</div>
          <div class="vd-sec-sub">分部折扣系数（写死）：寿险(EV_L 内含价值口径，仅作乘数) ×0.80 · 产险(E_PC 会计净资产) ×0.84 · 银行(E_BK 会计净资产) ×0.83 · FVOCI权益 ×1.00 · FVTPL权益 ×0.60 · 陆金所(条件估值) · 非权益其他资产 ×0.60（净资产扣减一律会计口径 E_L/E_PC/E_BK，严禁用 EV_L）</div>
          <table class="vd-table vd-seg-table">
            <thead><tr><th>分部</th><th>估值基础（亿元）</th><th>折扣系数</th><th>分部价值（亿元）</th></tr></thead>
            <tbody>${segRows}
              <tr class="vd-seg-total"><td class="vd-label" colspan="3">分部合计（SOTP 总价值）</td><td class="vd-value">${fmt(sotp.totalValue)}</td></tr>
            </tbody>
          </table>
          <div class="vd-formula">非权益其他资产（协议公式）：${esc(sotp.otherAssetsFormula)}</div>
          <div class="vd-sec-sub">SOTP 目标价 = 分部合计 ${fmt(sotp.totalValue)} ÷ 总股本 N ${fmt(Nval)} = ${fmt(sotp.targetPrice)}；区间 = ${fmt(sotp.targetPrice)} ×(1±${fmt(sotp.band != null ? sotp.band * 100 : 10)}%) = ${fmtRange(sotp.range)}</div>
          <div class="vd-src-block">
            <div class="vd-src-title">原始数据出处</div>
            <table class="vd-table vd-src-table">
              <thead><tr><th>变量</th><th>含义</th><th>数值</th><th>来源</th></tr></thead>
              <tbody>${srcRows}</tbody>
            </table>
          </div>
        </div>`;

      body.innerHTML = `
        <div class="vd-card">
          <div class="vd-head">
            <span class="vd-title">🧮 中国平安（601318）专属估值模型 · 滚动估值协议</span>
            <span class="vd-badge ${ratingCls}">${esc(j.rating || 'N/A')}</span>
          </div>

          <div class="vd-intervals">
            <div class="vd-iv"><span>合成估值区间（极值法：P/EV + DDM + SOTP 各自极值）</span><b>${fmtRange(j.fairValueRange)}</b></div>
            <div class="vd-iv"><span>核心聚焦区间（P/EV 0.65x~0.90x）/ 当前股价</span><b>${fmtRange(j.focusRange)} / ${j.raw && j.raw.P != null ? '¥' + fmt(j.raw.P) : 'N/A'}</b></div>
          ${frStrip}
          </div>

          <!-- ⓪ 协议汇总表 -->
          <div class="vd-sec">
            <div class="vd-sec-title">⓪ 滚动估值协议汇总表（固定模板 · 逐格填充）</div>
            <table class="vd-table">
              <thead><tr><th>项目</th><th>计算结果（元/股）</th></tr></thead>
              <tbody>${sumRows}</tbody>
            </table>
            ${alertRows}
          </div>

          ${sotpSec}

          <!-- ② DDM 简表 -->
          <div class="vd-sec">
            <div class="vd-sec-title">② DDM 股息贴现（参与极值法合成）</div>
            <div class="vd-sec-sub">每股股息 D（TTM口径，M固定=12）= ${fmt(ddm.d)} ${esc(ddm.unit || '')} ｜ 保守 r=${fmt(ddm.conservative && ddm.conservative.r)}、g=${fmt(ddm.conservative && ddm.conservative.g)} ｜ 乐观 r=${fmt(ddm.optimistic && ddm.optimistic.r)}、g=${fmt(ddm.optimistic && ddm.optimistic.g)}</div>
            <div class="vd-iv"><span>DDM 估值区间（保守 ~ 乐观）</span><b>${fmt(ddm.conservative && ddm.conservative.value)} ~ ${fmt(ddm.optimistic && ddm.optimistic.value)}</b></div>
            <div class="vd-src">数据来源：${esc(ddm.source)}</div>
          </div>

          <!-- ③ P/EV 简表 -->
          <div class="vd-sec">
            <div class="vd-sec-title">③ P/EV 内含价值倍数（核心锚 · 永远优先计算）</div>
            <div class="vd-sec-sub">每股内含价值 EVPS = ${fmt(pev.evps)}（内含价值 EV ${fmt(pev.ev)} ÷ 总股本 N ${fmt(pev.n)}）｜ 倍数区间 ${fmt(pev.pevLow)}x ~ ${fmt(pev.pevHigh)}x</div>
            <div class="vd-iv"><span>P/EV 核心聚焦区间</span><b>${fmtRange(pev.range)}</b></div>
            <div class="vd-src">数据来源：${esc(pev.source)}</div>
          </div>

          <div class="vd-foot">滚动协议 v3.1 口径：无日期硬编码，报告期自适应（M 由月算法自动判定）；合成估值区间=极值法（P/EV、DDM、SOTP 中成功计算的模型各取极值，N/A 模型排除）；SOTP v3.1 修正版：净资产扣减一律会计口径（E_L/E_PC/E_BK，严禁用 EV_L），缺失变量记 N/A 并跳过对应分支（严禁填 0 落入其他资产池），其他资产<0 时警告并暂停 SOTP；核心聚焦区间=[EVPS×0.65, EVPS×0.90]；动态EV中枢=[(EV+年化NBV)÷N]×0.80 与 FVOCI税后浮盈/股 为辅助行，不参与合成；当前股价仅展示、不参与区间合成。模型：${esc(j.model || '确定性计算')}</div>
          ${skipNote}
        </div>`;
      body.classList.add('dedicated-valuation');
      return;
    }
    body.classList.remove('dedicated-valuation');
    const d = new Date(j.date);
    const pad = (n) => String(n).padStart(2, '0');
    if (dateEl) dateEl.textContent = (j.cached ? '缓存于 ' : '更新于 ') +
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    // 20260908m：综合估值卡片布局统一固化为中国平安模板（vd-card 骨架：头部标题+评级徽章 / 区间行 / 明细分节 / 口径脚注）。
    // 只固定布局模板，与估值模型和数据无关——普通股把 AI 估值结论文本装进同一骨架。
    // 顶部「综合估值评级」滑条卡（deepConclusion）已常显，此处不再重复渲染 vc-card，避免双滑条。
    const stockName = this.currentData?.name || '';
    const livePrice = this.currentData?.quote?.price;
    const summary = this._parseValuationSummary(j.content);
    const ratingRaw = summary ? String(summary.overallRating || '') : '';
    // 评级词模糊归档（AI 可能输出"合理偏低"等复合词，按关键词命中取语义色，徽章仍显示原词）
    const ratingKey = ['低估', '高估', '偏高', '合理'].find(k => ratingRaw.includes(k));
    const ratingCls = ratingKey === '低估' ? 'vd-rating-low'
      : (ratingKey === '高估' || ratingKey === '偏高') ? 'vd-rating-high' : 'vd-rating-mid';
    const fmt2 = (x) => (x == null || x === '' || !isFinite(Number(x))) ? 'N/A' : Number(x).toFixed(2);
    const fmtRange2 = (r) => (r && r.length === 2) ? `¥${fmt2(r[0])} ~ ¥${fmt2(r[1])}` : 'N/A';
    // 20260906：当前股价用工作台头部权威实时价（腾讯行情，单一权威源），无效时回退摘要自带价
    const dispPrice = (livePrice != null && isFinite(Number(livePrice)) && Number(livePrice) > 0) ? Number(livePrice) : (summary ? summary.currentPrice : null);
    // 明细内容：摘要可解析 → 语义着色结论文本；否则兜底 markdown（均装进同一 vd-sec 分节）
    let detailHTML = '';
    if (summary) {
      const bodyText = this._stripValuationSummary(j.content);
      detailHTML = '<div class="conclusion-text">' + bodyText.split('\n').filter(l => l.trim()).map(l => `<p>${this.escapeHtml(l)}</p>`).join('') + '</div>';
      detailHTML = this._colorizeValuationText(detailHTML);
    } else {
      detailHTML = this._colorizeValuationText('<div class="ai-markdown">' + this.renderMarkdown(j.content) + '</div>');
    }
    const srcNote = summary ? (j.localDataUsed ? '历史财务：本地年报数据库；实时数据：联网搜索 · ' : '数据来源：联网搜索（补抓） · ') : '';
    body.innerHTML = `
      <div class="vd-card">
        <div class="vd-head">
          <span class="vd-title">✨ ${this.escapeHtml(stockName)}（${this.escapeHtml(this.currentSymbol || '')}）综合估值</span>
          <span class="vd-badge ${ratingCls}">${this.escapeHtml(ratingRaw || 'N/A')}</span>
        </div>
        <div class="vd-intervals">
          <div class="vd-iv"><span>综合合理估值区间</span><b>${summary ? fmtRange2(summary.fairValueRange) : 'N/A'}</b></div>
          <div class="vd-iv"><span>当前股价</span><b>${dispPrice != null ? '¥' + fmt2(dispPrice) : 'N/A'}</b></div>
        </div>
        <div class="vd-sec">
          <div class="vd-sec-title">估值分析结论</div>
          ${detailHTML}
        </div>
        <div class="vd-foot">由 AI 估值大模型生成（${srcNote}模型：${this.escapeHtml(j.model || '')}），仅供参考，请自行核实。</div>
      </div>`;
  },

  // ---- 信息分析（CFA 统一框架 · 20260914f）----
  // 合并原「公司综合介绍 / 供应链与成本 / 主要产品&客户」三模块为单一分析：
  // 七段输出（一句话定位与摘要 / 基本面画像 / 供应链与成本 / 客户与竞争 / 跨模块联动 / 风险提示 / 来源与缺失说明）。

  // 20260914h：静默预热本地事实库（东财 F10：公司概况 / 经营范围 / 主营构成）。
  // 纯数据抓取、零 LLM 费用，用于下次「✨ AI 联网获取」时作为补充上下文；
  // 每只股票每个会话只预热一次，失败静默且解除标记以便下次重试。
  _prefetchCompanyFacts() {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    this._factsPrefetched = this._factsPrefetched || {};
    if (this._factsPrefetched[symbol]) return;
    this._factsPrefetched[symbol] = true;
    const name = this.currentData?.name || '';
    fetch('/api/ai/prefetch-facts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, stockName: name }),
    }).then((r) => r.json()).then((d) => {
      // 预热失败则解除标记，下次打开/切股再试
      if (!d || d.success === false) this._factsPrefetched[symbol] = false;
    }).catch(() => { this._factsPrefetched[symbol] = false; });
  },

  async loadCompanyDeep(force = false) {
    const symbol = this.currentSymbol;
    const body = document.getElementById('companyDeepBody');
    if (!symbol || !body) return;
    if (!force && this.companyDeepLoadedSymbol === symbol && this.companyDeepData) {
      this.renderCompanyDeep(this.companyDeepData);
      return;
    }
    try {
      if (!force) {
        const resp = await fetch(`/api/ai/company-deep/${encodeURIComponent(symbol)}`);
        const cached = await resp.json();
        if (this.currentSymbol !== symbol) return;
        if (cached.success) {
          this.companyDeepData = cached;
          this.companyDeepLoadedSymbol = symbol;
          this.renderCompanyDeep(cached);
          // 20261012：信息分析加载完成，回填简介卡「主要产品」截图
          if (this._overviewData) this.renderCompanyProfile(this._overviewData);
          return;
        }
        // 无缓存：主按钮保持「✨ AI 联网获取」，隐藏「🔄 重新搜索」
        this._setCompanyDeepButtons(false);
        body.innerHTML = '<div class="ai-empty">暂无已存的信息分析资料。<br>简介类资料（基本面画像 / 供应链与成本 / 客户与竞争 / 重大事件）更新频率很低，'
          + '生成一次后会<b>永久保存</b>在本机，之后每次打开工作台自动秒显、无需重复联网。<br>'
          + '点击右上角「✨ AI 联网获取」即可联网生成。</div>';
        return;
      }
      body.innerHTML = '<div class="ai-loading"><div class="loading-spinner"></div><p>正在联网进行信息分析（CFA 七段框架，含产品/供应商/竞争对手图片），内容较长请稍候（约 3-4 分钟）…</p></div>';
      const aiBtn = document.getElementById('companyDeepAiBtn');
      if (aiBtn) { aiBtn.disabled = true; aiBtn.textContent = '分析中…'; }
      let data;
      try {
        const resp = await fetch('/api/ai/company-deep', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, force: true, companyName: this.currentData?.name, industry: this.currentData?.industry, companyType: this.currentData?.companyType?.type }),
        });
        data = await resp.json();
      } finally {
        if (aiBtn) { aiBtn.disabled = false; }
        // 按钮文案按是否已有资料自适应
        this._setCompanyDeepButtons(!!(this.companyDeepData && this.companyDeepLoadedSymbol === symbol));
      }
      if (this.currentSymbol !== symbol) return;
      if (data.success) {
        this.companyDeepData = data;
        this.companyDeepLoadedSymbol = symbol;
        this.renderCompanyDeep(data);
        // 20261012：信息分析加载完成，回填简介卡「主要产品」截图
        if (this._overviewData) this.renderCompanyProfile(this._overviewData);
      } else if (!data.success && data.error === 'NO_KEY') {
        body.innerHTML = '<div class="ai-empty">尚未配置 AI API Key，无法联网获取。请先在「⚙️ AI 设置」中配置。</div>';
      } else {
        body.innerHTML = '<div class="ai-empty">获取失败：' + this.escapeHtml(data.message || data.error || '未知错误') + '</div>';
      }
    } catch (e) {
      if (force) body.innerHTML = '<div class="ai-empty">获取失败：' + this.escapeHtml(e.message) + '</div>';
    }
  },

  // 20260914h：信息分析卡片按钮状态自适应
  // hasData=true → 主按钮「🔄 重新搜索」（强制重跑），隐藏副按钮
  // hasData=false → 主按钮「✨ AI 联网获取」，隐藏副按钮
  // 副按钮 companyDeepRefresh 保留在 DOM 中但不再单独显示，避免两按钮功能重复
  _setCompanyDeepButtons(hasData) {
    const aiBtn = document.getElementById('companyDeepAiBtn');
    const rf = document.getElementById('companyDeepRefresh');
    if (aiBtn) {
      aiBtn.disabled = false;
      aiBtn.textContent = hasData ? '🔄 重新搜索' : '✨ AI 联网获取';
    }
    if (rf) rf.style.display = 'none';
  },

  renderCompanyDeep(data) {
    const body = document.getElementById('companyDeepBody');
    if (!body) return;
    const dateEl = document.getElementById('companyDeepDate');
    if (dateEl && data.date) {
      const d = new Date(data.date);
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      // 20260914h：永久保存口径——明确告知「已永久保存，无需重复联网」
      dateEl.textContent = `已保存 · 更新于 ${stamp}`;
    }
    // 有资料 → 主按钮切为「🔄 重新搜索」
    this._setCompanyDeepButtons(true);

    const esc = (s) => this.escapeHtml(s == null ? '' : String(s));
    const val = (s) => (s == null || s === '' ? '未披露' : esc(s));
    const A = (arr) => (Array.isArray(arr) ? arr : []);
    const imgOf = (o) => (o.imageLocal || '');
    const secTitle = (t) => `<h4 class="cd-sec">${esc(t)}</h4>`;
    const blockTitle = (t) => `<div class="cd-block-title">${esc(t)}</div>`;
    // 文本块：颜色由内容语义决定（利好红 / 利空绿 / 风险黄），与全局口径一致
    const textCls = (s) => {
      const t = String(s || '');
      if (/未披露|未检索到|待核实|未提供|未获取/.test(t)) return 'cd-muted';
      if (/置顶|风险|处罚|诉讼|退市|违规|质押|下滑|承压/.test(t)) return 'cd-warn';
      return '';
    };

    const bi = (data.profile && data.profile.basicInfo) || {};
    const profile = data.profile || {};
    const sc = data.supplyChain || {};
    const comp = data.competition || {};

    let html = '';

    // ===== 置顶重大风险 =====
    const flags = A(data.flags);
    const dangerFlags = flags.filter(f => f.level === 'danger');
    if ((data.topWarning && data.topWarning !== '无') || dangerFlags.length) {
      const items = [];
      if (data.topWarning && data.topWarning !== '无') items.push(data.topWarning);
      dangerFlags.forEach(f => { if (!items.includes(f.text)) items.push(f.text); });
      html += `<div class="cd-topwarn">⚠️ 置顶风险提示<div class="cd-topwarn-body">${items.map(t => `<div>${esc(t)}</div>`).join('')}</div></div>`;
    }

    // ===== 一、一句话定位与投资摘要 =====
    html += secTitle('一、公司一句话定位与投资摘要');
    html += `<div class="cd-oneliner">${esc(data.oneLiner || '未披露')}</div>`;
    if (data.investmentSummary) html += `<div class="cd-summary">${esc(data.investmentSummary)}</div>`;
    // 代码判定的确定性 flags（成本敏感型 / 传导强弱 / 客户集中 / 收入依赖 / 红线）
    if (flags.length) {
      html += '<div class="cd-flags">' + flags.map(f => `<span class="cd-flag cd-flag-${esc(f.level)}">${esc(f.text)}</span>`).join('') + '</div>';
    }

    // ===== 二、公司基本面画像 =====
    html += secTitle('二、公司基本面画像');
    const biRows = [
      ['公司全称', bi.fullName], ['办公地点', bi.officeLocation], ['注册地址', bi.registeredAddress],
      ['成立日期', bi.foundedDate], ['上市日期', bi.listedDate], ['所属行业', bi.industry],
      ['员工人数', bi.employeeCount], ['高管人数', bi.execCount],
      ['高管平均薪酬', bi.execAvgSalary + (bi.execSalaryBasis ? `（口径：${bi.execSalaryBasis}）` : '')],
    ];
    html += '<div class="cd-bi">' + biRows.map(([k, v]) => `<div class="cd-bi-row"><span class="cd-k">${esc(k)}</span><span class="cd-v">${val(v)}</span></div>`).join('') + '</div>';

    // 产品与服务
    const ps = A(profile.productsServices);
    html += blockTitle('产品与服务');
    if (ps.length) {
      html += '<div class="cd-prod-grid">' + ps.map(p => {
        const img = imgOf(p);
        return `<div class="cd-prod">
          <div class="cd-prod-img">${img ? `<img src="${esc(img)}" alt="${esc(p.name)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="cd-ph">🏷️</span></div>
          <div class="cd-prod-name">${esc(p.name)}</div>
          ${p.revenueShare ? `<div class="cd-prod-share">收入占比 ${esc(p.revenueShare)}</div>` : ''}
          ${p.content ? `<div class="cd-prod-line"><b>服务内容：</b>${esc(p.content)}</div>` : ''}
          ${p.scenario ? `<div class="cd-prod-line"><b>应用场景：</b>${esc(p.scenario)}</div>` : ''}
          ${p.customerType ? `<div class="cd-prod-line"><b>主要客户类型：</b>${esc(p.customerType)}</div>` : ''}
          ${p.imageNote ? `<div class="cd-imgnote">${esc(p.imageNote)}</div>` : ''}
        </div>`;
      }).join('') + '</div>';
    } else html += '<div class="cd-muted">未披露</div>';

    // 文化 · 品牌
    const cul = profile.culture || {};
    html += blockTitle('经营宗旨 / 企业文化 / 品牌');
    const culRows = [['经营宗旨', cul.mission], ['企业文化', cul.culture], ['公司愿景', cul.vision], ['核心价值观', cul.values], ['商标情况', cul.trademarks]];
    html += '<div class="cd-bi">' + culRows.map(([k, v]) => `<div class="cd-bi-row"><span class="cd-k">${esc(k)}</span><span class="cd-v">${val(v)}</span></div>`).join('') + '</div>';
    if (A(cul.brands).length) html += '<div class="cd-chips">' + A(cul.brands).map(b => `<span class="cd-chip">${esc(b)}</span>`).join('') + '</div>';

    // 专利创新
    const pat = profile.patents || {};
    html += blockTitle('专利与创新');
    html += `<div class="cd-stat-row">
      <div class="cd-stat"><span class="cd-stat-l">专利总数</span><span class="cd-stat-v">${val(pat.total)}</span></div>
      <div class="cd-stat"><span class="cd-stat-l">发明专利占比</span><span class="cd-stat-v">${val(pat.inventionRatio)}</span></div>
      <div class="cd-stat"><span class="cd-stat-l">近3年年均增速</span><span class="cd-stat-v">${val(pat.yoy3y)}</span></div>
      <div class="cd-stat"><span class="cd-stat-l">行业分位</span><span class="cd-stat-v">${val(pat.industryPercentile)}</span></div>
    </div>`;

    // 实控人
    const ctl = profile.controller || {};
    html += blockTitle('实际控制人与治理');
    html += `<div class="cd-bi">
      <div class="cd-bi-row"><span class="cd-k">有无实控人</span><span class="cd-v">${val(ctl.hasController)}</span></div>
      <div class="cd-bi-row"><span class="cd-k">姓名 / 类型</span><span class="cd-v">${val(ctl.name)}</span></div>
      <div class="cd-bi-row"><span class="cd-k">持股比例</span><span class="cd-v">${val(ctl.holdingPct)}</span></div>
      <div class="cd-bi-row"><span class="cd-k">控制路径</span><span class="cd-v">${val(ctl.controlPath)}</span></div>
      <div class="cd-bi-row"><span class="cd-k">一致行动人</span><span class="cd-v">${A(ctl.concertParties).length ? esc(A(ctl.concertParties).join('、')) : '未披露'}</span></div>
      <div class="cd-bi-row"><span class="cd-k">背景</span><span class="cd-v">${val(ctl.background)}</span></div>
      <div class="cd-bi-row"><span class="cd-k">质押情况</span><span class="cd-v ${textCls(ctl.pledge)}">${val(ctl.pledge)}</span></div>
      <div class="cd-bi-row"><span class="cd-k">潜在治理风险</span><span class="cd-v ${textCls(ctl.governanceRisk)}">${val(ctl.governanceRisk)}</span></div>
      ${ctl.equityStructure ? `<div class="cd-bi-row"><span class="cd-k">股权结构特征</span><span class="cd-v">${esc(ctl.equityStructure)}</span></div>` : ''}
    </div>`;

    // 近10年重大事件时间线
    const events = A(profile.majorEvents);
    html += blockTitle('近10年重大事件雷达');
    if (events.length) {
      html += '<div class="cd-events">' + events.map(e => {
        const lv = (e.impactLevel || '').includes('高') ? 'high' : (e.impactLevel || '').includes('低') ? 'low' : 'mid';
        return `<div class="cd-event">
          <span class="cd-ev-date">${esc(e.date || '')}</span>
          <div class="cd-ev-body">
            <div class="cd-ev-head"><span class="cd-ev-cat">${esc(e.category || '事件')}</span><span class="cd-ev-lv cd-ev-lv-${lv}">${esc(e.impactLevel || '中')}</span></div>
            <div class="cd-ev-title">${esc(e.title)}</div>
            ${e.desc ? `<div class="cd-ev-desc">${esc(e.desc)}</div>` : ''}
            ${e.impactOn ? `<div class="cd-ev-impact">影响：${esc(e.impactOn)}</div>` : ''}
          </div>
        </div>`;
      }).join('') + '</div>';
    } else html += '<div class="cd-muted">未检索到</div>';

    // ===== 三、供应链与成本 =====
    html += secTitle('三、供应链与成本');
    const posCls = /上游/.test(sc.chainPosition || '') ? 'up' : /下游/.test(sc.chainPosition || '') ? 'down' : /中游/.test(sc.chainPosition || '') ? 'mid' : 'neutral';
    html += `<div class="cd-bi-row"><span class="cd-k">产业链位置</span><span class="cd-v"><span class="cd-pos cd-pos-${posCls}">${val(sc.chainPosition)}</span>${sc.positionBasis ? ` <span class="cd-muted">（${esc(sc.positionBasis)}）</span>` : ''}</span></div>`;

    const mats = A(sc.materials);
    html += blockTitle('主要原材料 / 服务与供应商');
    if (mats.length) {
      html += '<div class="cd-mats">' + mats.map(m => {
        const img = imgOf(m);
        return `<div class="cd-mat">
          <div class="cd-mat-img">${img ? `<img src="${esc(img)}" alt="${esc(m.name)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="cd-ph">🔩</span></div>
          <div class="cd-mat-info">
            <div class="cd-mat-name">${esc(m.name)}</div>
            ${m.desc ? `<div class="cd-mat-line">${esc(m.desc)}</div>` : ''}
            <div class="cd-mat-line"><span class="cd-k2">前五大供应商</span>${val(m.supplierTop5)}</div>
            <div class="cd-mat-line"><span class="cd-k2">采购占比</span>${val(m.procureShare)}</div>
            <div class="cd-mat-line"><span class="cd-k2">供应内容</span>${val(m.supplyContent)}</div>
            <div class="cd-mat-line"><span class="cd-k2">合作稳定性</span>${val(m.stability)}</div>
            ${m.imageNote ? `<div class="cd-imgnote">${esc(m.imageNote)}</div>` : ''}
          </div>
        </div>`;
      }).join('') + '</div>';
    } else html += '<div class="cd-muted">未披露</div>';

    // 成本传导与敏感性
    html += blockTitle('成本传导与敏感性分析');
    html += `<div class="cd-stat-row">
      <div class="cd-stat"><span class="cd-stat-l">直接材料占营业成本</span><span class="cd-stat-v">${val(sc.directMaterialRatio)}</span></div>
      <div class="cd-stat"><span class="cd-stat-l">成本传导系数</span><span class="cd-stat-v">${sc.conductionCoef == null ? '未披露' : esc(sc.conductionCoef)}</span></div>
      <div class="cd-stat"><span class="cd-stat-l">毛利率敏感系数</span><span class="cd-stat-v">${sc.grossMarginSensitivity == null ? '未披露' : esc(sc.grossMarginSensitivity)}</span></div>
    </div>`;
    const smRows = A(sc.sensitivityMatrix);
    if (smRows.length) {
      html += `<div class="cd-table-wrap"><table class="cd-table">
        <thead><tr><th>原材料价格变动</th><th>对毛利率影响</th><th>对净利润影响</th><th>对现金流影响</th></tr></thead><tbody>
        ${smRows.map(r => `<tr><td>${esc(r.priceChange)}</td><td>${esc(r.grossMargin)}</td><td>${esc(r.netProfit)}</td><td>${esc(r.cashFlow)}</td></tr>`).join('')}
        </tbody></table></div>`;
    }
    if (sc.sensitivityNote) html += `<div class="cd-note">${esc(sc.sensitivityNote)}</div>`;

    // 成本控制方法
    const cc = A(sc.costControl);
    html += blockTitle('成本控制方法');
    if (cc.length) {
      html += '<div class="cd-ctrl">' + cc.map(c => `<div class="cd-ctrl-item"><span class="cd-ctrl-type">${esc(c.type || '方法')}</span><div><div>${esc(c.practice)}</div>${c.costImpact ? `<div class="cd-muted">成本影响：${esc(c.costImpact)}</div>` : ''}</div></div>`).join('') + '</div>';
    } else html += '<div class="cd-muted">未披露</div>';

    // 成本风险结论
    const crlv = (sc.costRiskLevel || '').includes('高') ? 'high' : (sc.costRiskLevel || '').includes('低') ? 'low' : 'mid';
    html += `<div class="cd-concl cd-concl-${crlv}"><b>成本风险等级：${val(sc.costRiskLevel)}</b>${sc.costRiskReason ? `<div>${esc(sc.costRiskReason)}</div>` : ''}</div>`;

    // ===== 四、客户与竞争 =====
    html += secTitle('四、客户与竞争格局');
    // 客户
    const custs = A(comp.customers);
    html += blockTitle('主要客户与集中度');
    if (custs.length) {
      html += '<div class="cd-table-wrap"><table class="cd-table"><thead><tr><th>客户</th><th>收入占比</th><th>集中度</th><th>行业分位</th></tr></thead><tbody>'
        + custs.map(c => `<tr><td>${esc(c.name)}</td><td>${esc(c.revenueShare)}</td><td>${esc(c.concentration)}</td><td>${esc(c.industryPercentile)}</td></tr>`).join('')
        + '</tbody></table></div>';
    } else html += '<div class="cd-muted">未披露</div>';

    // 竞争对手
    const comps = A(comp.competitors);
    html += blockTitle('主要竞争对手');
    if (comps.length) {
      html += '<div class="cd-comps">' + comps.map(c => {
        const img = imgOf(c);
        return `<div class="cd-comp">
          <div class="cd-comp-img">${img ? `<img src="${esc(img)}" alt="${esc(c.name)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="cd-ph">🏢</span></div>
          <div class="cd-comp-name">${esc(c.name)}</div>
          ${c.marketShare ? `<div class="cd-comp-line">市场份额：${esc(c.marketShare)}</div>` : ''}
          <div class="cd-comp-tags">
            ${c.productOverlap ? `<span class="cd-tag">产品重叠 ${esc(c.productOverlap)}</span>` : ''}
            ${c.customerOverlap ? `<span class="cd-tag">客户重叠 ${esc(c.customerOverlap)}</span>` : ''}
            ${c.regionOverlap ? `<span class="cd-tag">区域重叠 ${esc(c.regionOverlap)}</span>` : ''}
            ${c.priceStrategy ? `<span class="cd-tag cd-tag-ps">${esc(c.priceStrategy)}</span>` : ''}
          </div>
          ${c.imageNote ? `<div class="cd-imgnote">${esc(c.imageNote)}</div>` : ''}
        </div>`;
      }).join('') + '</div>';
    } else html += '<div class="cd-muted">未披露</div>';

    // 竞争格局图谱
    if (comp.landscapeGraph) html += `<div class="cd-block-title">竞争格局图谱</div><div class="cd-graph">${esc(comp.landscapeGraph)}</div>`;

    // 对手价格变动影响模拟
    const ws = comp.priceWarSimulation || {};
    html += blockTitle('竞争对手价格变动影响模拟');
    html += `<div class="cd-stat-row">
      <div class="cd-stat"><span class="cd-stat-l">产品同质化</span><span class="cd-stat-v">${val(ws.homogeneity)}</span></div>
      <div class="cd-stat"><span class="cd-stat-l">客户转换成本</span><span class="cd-stat-v">${val(ws.switchingCost)}</span></div>
      <div class="cd-stat"><span class="cd-stat-l">品牌溢价</span><span class="cd-stat-v">${val(ws.brandPremium)}</span></div>
      <div class="cd-stat"><span class="cd-stat-l">渠道粘性</span><span class="cd-stat-v">${val(ws.channelStickiness)}</span></div>
    </div>`;
    const scen = A(ws.scenarios);
    if (scen.length) {
      html += '<div class="cd-table-wrap"><table class="cd-table"><thead><tr><th>应对策略</th><th>收入变化</th><th>毛利率变化</th><th>净利润变化</th><th>市场份额变化</th></tr></thead><tbody>'
        + scen.map(s => `<tr><td>${esc(s.strategy)}</td><td>${esc(s.revenue || '未提供')}</td><td>${esc(s.grossMargin || '未提供')}</td><td>${esc(s.netProfit || '未提供')}</td><td>${esc(s.marketShare || '未提供')}</td></tr>`).join('')
        + '</tbody></table></div>';
    }

    // 竞争风险与定价权结论
    const krlv = (comp.competitionRiskLevel || '').includes('高') ? 'high' : (comp.competitionRiskLevel || '').includes('低') ? 'low' : 'mid';
    html += `<div class="cd-concl cd-concl-${krlv}"><b>竞争风险等级：${val(comp.competitionRiskLevel)}</b>${comp.pricingPower ? `<div>定价权判断：${esc(comp.pricingPower)}</div>` : ''}</div>`;
    const rs = A(comp.riskSignals);
    if (rs.length) html += '<div class="cd-block-title">建议关注的风险信号</div><ul class="cd-list cd-list-warn">' + rs.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>';

    // ===== 五、跨模块联动结论 =====
    html += secTitle('五、跨模块联动结论');
    html += `<div class="cd-summary">${val(data.linkage)}</div>`;

    // ===== 六、风险提示 =====
    html += secTitle('六、风险提示');
    const rn = A(data.riskNotes);
    html += rn.length ? '<ul class="cd-list cd-list-warn">' + rn.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : '<div class="cd-muted">未提供</div>';

    // ===== 七、数据来源、日期与缺失说明 =====
    html += secTitle('七、数据来源、日期与缺失说明');
    const ds = A(data.dataSources);
    if (ds.length) {
      html += '<div class="cd-table-wrap"><table class="cd-table"><thead><tr><th>结论/数据项</th><th>来源</th><th>日期</th></tr></thead><tbody>'
        + ds.map(d => `<tr><td>${esc(d.item)}</td><td>${esc(d.source)}</td><td>${esc(d.date)}</td></tr>`).join('')
        + '</tbody></table></div>';
    }
    const mn = A(data.missingNotes);
    if (mn.length) html += '<ul class="cd-list">' + mn.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>';

    // 页脚：模式与来源
    const modeNote = data.mode === 'local'
      ? '本地事实模式（东财 F10 预下载事实 + 不联网模型纯推理，零联网费）'
      : '联网模式（受网站访问限制，部分数据可能为公开信息推断）';
    html += `<div class="cd-foot">分析引擎：证券分析师 CFA 框架（七段统一输出）· ${esc(modeNote)}${data.model ? ` · 模型：${esc(data.model)}` : ''} · 由代码判定确定性阈值（成本敏感型/传导强弱/客户集中度/收入依赖/置顶风险），AI 仅负责叙事。</div>`;

    body.innerHTML = html;
  },



  escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  },

  renderMarkdown(text) {
    const lines = this.escapeHtml(text).split(/\r?\n/);
    let html = '';
    let inUl = false;
    let inOl = false;
    const closeLists = () => {
      if (inUl) { html += '</ul>'; inUl = false; }
      if (inOl) { html += '</ol>'; inOl = false; }
    };
    for (let raw of lines) {
      let line = raw.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      if (/^###\s+/.test(line)) { closeLists(); html += '<h5>' + line.replace(/^###\s+/, '') + '</h5>'; }
      else if (/^##\s+/.test(line)) { closeLists(); html += '<h4>' + line.replace(/^##\s+/, '') + '</h4>'; }
      else if (/^#\s+/.test(line)) { closeLists(); html += '<h3>' + line.replace(/^#\s+/, '') + '</h3>'; }
      else if (/^\s*\d+\.\s+/.test(line)) {
        if (!inOl) { closeLists(); html += '<ol>'; inOl = true; }
        html += '<li>' + line.replace(/^\s*\d+\.\s+/, '') + '</li>';
      } else if (/^\s*[-*]\s+/.test(line)) {
        if (!inUl) { closeLists(); html += '<ul>'; inUl = true; }
        html += '<li>' + line.replace(/^\s*[-*]\s+/, '') + '</li>';
      } else if (line.trim() === '') { closeLists(); }
      else { closeLists(); html += '<p>' + line + '</p>'; }
    }
    closeLists();
    return html;
  },

  // 首页实时大盘概览（大盘指数 / 美国股指 / 热门板块）
  async loadMarketOverview() {
    const container = document.getElementById('marketOverview');
    if (!container) return;
    if (!container.dataset.loaded) {
      container.innerHTML = '<div class="mo-loading">加载行情中…</div>';
    }
    try {
      const resp = await fetch('/api/market-overview');
      const data = await resp.json();
      if (!data || data.success === false) {
        container.innerHTML = '<div class="mo-loading">行情暂时不可用，点击右上角「刷新」重试</div>';
        return;
      }
      this.lastMarketData = data;
      this.renderMarketOverview(data);
      const upd = document.getElementById('marketUpdated');
      if (upd) {
        const d = new Date(data.updatedAt || Date.now());
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        upd.textContent = `更新于 ${hh}:${mm}`;
      }
      container.dataset.loaded = '1';
      // 行情刷新后，自动尝试读取已缓存的大盘 AI 解读（不强制联网）
      this.loadMarketAI(false);
      // 近一周涨跌前五高频板块提醒
      this.loadSectorRankReminder();
      // 行业板块资金流向（主力净流入/流出前五 + 近5日最大）
      this.loadSectorCapitalFlow();
    } catch (e) {
      if (!container.dataset.loaded) {
        container.innerHTML = '<div class="mo-loading">行情加载失败，点击右上角「刷新」重试</div>';
      }
    }
  },

  // 首页·大盘估值趋势（上证50 / 沪深300 / 科创50 近5年PE-TTM）
  async loadIndexPeTrend() {
    const container = document.getElementById('indexPeTrendBody');
    if (!container) return;
    if (!container.dataset.loaded) {
      container.innerHTML = '<div class="mo-loading">加载估值趋势中…</div>';
    }
    try {
      const resp = await fetch('/api/index-pe-trend');
      const data = await resp.json();
      if (!data || data.success === false) {
        container.innerHTML = '<div class="mo-loading">估值趋势暂时不可用，点击右上角「刷新」重试</div>';
        return;
      }
      this.renderIndexPeTrend(data);
      const upd = document.getElementById('indexPeTrendUpdated');
      if (upd && data.updatedAt) {
        const d = new Date(data.updatedAt.replace(' ', 'T') || Date.now());
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        upd.textContent = `更新于 ${hh}:${mm}`;
      }
      container.dataset.loaded = '1';
    } catch (e) {
      console.error('loadIndexPeTrend error:', e);
      if (!container.dataset.loaded) {
        container.innerHTML = '<div class="mo-loading">估值趋势加载失败，点击右上角「刷新」重试</div>';
      }
    }
  },

  renderIndexPeTrend(data) {
    const container = document.getElementById('indexPeTrendBody');
    const note = document.getElementById('indexPeTrendNote');
    if (!container) return;
    const items = Object.entries(data.data || {}).map(([name, item]) => ({
      name,
      latest: item.latest,
      quantile: item.quantile,
      quantileAll: item.quantileAll, // 20261105b：全历史百分位（东方财富估值页同款口径）
      source: item.source,
      peField: item.peField,
      length: (item.series || []).length,
    }));
    const latestHtml = items.map(it => {
      const pe = it.latest && it.latest.pe != null ? it.latest.pe.toFixed(2) : '—';
      // ★ 20261105b（用户指令）：停止「近5年新高」标注，按东方财富估值页样式使用「历史百分位」（全部历史口径）
      const q = it.quantileAll != null
        ? `<span class="ipe-quantile">历史百分位 ${it.quantileAll}%</span>`
        : (it.quantile != null ? `<span class="ipe-quantile">近5年百分位 ${it.quantile}%</span>` : '');
      const colorClass = it.name === '上证50' ? 'ipe-sz50' : (it.name === '沪深300' ? 'ipe-hs300' : (it.name === '中证1000' ? 'ipe-ci1000' : 'ipe-kc50'));
      return `<div class="ipe-stat ${colorClass}">
        <div class="ipe-name">${this.escapeHtml(it.name)}</div>
        <div class="ipe-pe">${pe}<span class="ipe-unit">倍</span></div>
        <div class="ipe-meta">${this.escapeHtml(it.peField)} · ${this.escapeHtml(it.source)}</div>
        ${q}
      </div>`;
    }).join('');
    container.innerHTML = `
      <div class="ipe-stats">${latestHtml}</div>
      <div id="indexPeTrendChart" class="ipe-chart"></div>
    `;
    if (note) {
      // 20261016 审计修复：数据源不可达回退缓存时，诚实标注而非静默展示旧数据
      const staleHtml = data.stale
        ? `<div class="ipe-stale-warn">${this.escapeHtml(data.staleNote || '⚠️ 实时数据源暂不可达，当前展示缓存数据。')}</div>`
        : '';
      note.innerHTML = staleHtml + this.escapeHtml(data.note || '');
    }
    // 渲染图表
    requestAnimationFrame(() => {
      Charts.indexPETrend('indexPeTrendChart', data.data);
    });
  },

  // ---- 20260914i：准确率检查展示（大盘技术分析 / 个股技术面）----
  // 口径：命中＝方向一致，「震荡」以涨跌绝对值 ≤ 容差计；样本不足时诚实显示「样本积累中」，不伪造数字。
  _accChip(label, rate, total, extra) {
    if (rate == null || !total) {
      return `<span class="mt-acc-chip muted"><span class="mac-label">${label}</span><span class="mac-value">样本积累中</span></span>`;
    }
    const cls = rate >= 60 ? 'good' : rate >= 45 ? 'mid' : 'bad';
    return `<span class="mt-acc-chip ${cls}"><span class="mac-label">${label}</span><span class="mac-value">${rate}%</span><span class="mac-sub">${total} 次</span>${extra ? `<span class="mac-sub">${extra}</span>` : ''}</span>`;
  },

  renderMarketTechAccuracy(acc) {
    const el = document.getElementById('marketTechAccuracy');
    if (!el) return;
    if (!acc || !acc.short) { el.innerHTML = ''; return; }
    const s = acc.short, m = acc.mid, f = acc.fusion || {};
    const chips = [
      this._accChip('短期方向', s.accuracy, s.settledCount, s.pendingCount ? `待验证 ${s.pendingCount}` : ''),
      this._accChip('中期方向', m.accuracy, m.settledCount, m.pendingCount ? `待验证 ${m.pendingCount}` : ''),
      this._accChip('融合信号', f.accuracy, f.settledCount),
    ].join('');
    const warn = (s.overdueCount > 0)
      ? `<span class="mt-acc-warn" title="目标日已过但数据未就绪，未能结算，会影响统计真实性">⚠️ ${s.overdueCount} 条过期未结算</span>` : '';
    el.innerHTML = `
      <div class="mt-acc-bar">
        <span class="mt-acc-title">🎯 准确率检查</span>
        ${chips}
        <span class="mt-acc-note">${this.escapeHtml(acc.horizonLabel || '')} · 基准 ${this.escapeHtml(acc.benchmark || '')}</span>
        ${warn}
        <a class="mt-acc-link" href="accuracy.html?tab=market" target="_blank">明细 →</a>
      </div>`;
  },

  renderTechFaceAccuracy(acc) {
    const el = document.getElementById('techFaceAccuracy');
    if (!el) return;
    if (!acc) { el.innerHTML = ''; return; }
    const chips = [
      this._accChip('短期方向', acc.accuracy, acc.settledCount, acc.pendingCount ? `待验证 ${acc.pendingCount}` : ''),
    ].join('');
    const warn = (acc.overdueCount > 0)
      ? `<span class="mt-acc-warn">⚠️ ${acc.overdueCount} 条过期未结算</span>` : '';
    el.innerHTML = `
      <div class="mt-acc-bar">
        <span class="mt-acc-title">🎯 准确率检查</span>
        ${chips}
        <span class="mt-acc-note">${this.escapeHtml(acc.horizonLabel || '')}</span>
        ${warn}
        <a class="mt-acc-link" href="accuracy.html?tab=tech&symbol=${encodeURIComponent(acc.symbol || this.currentSymbol || '')}" target="_blank">明细 →</a>
      </div>`;
  },

  async loadMarketTechnical(force) {
    const container = document.getElementById('marketTechnicalBody');
    if (!container) return;
    if (!container.dataset.loaded) {
      container.innerHTML = '<div class="mo-loading">正在对三大指数进行收盘后技术面推演…</div>';
    }
    try {
      const qs = force ? '?refresh=1' : '';
      const resp = await fetch('/api/market-technical' + qs);
      const data = await resp.json();
      if (!data || data.success === false) {
        container.innerHTML = '<div class="mo-loading">大盘技术分析暂时不可用，点击右上角「刷新」重试</div>';
        return;
      }
      this.renderMarketTechnical(data);
      const upd = document.getElementById('marketTechnicalUpdated');
      if (upd && data.updatedAt) {
        const d = new Date(data.updatedAt);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        upd.textContent = `更新于 ${hh}:${mm}`;
      }
      container.dataset.loaded = '1';
      // 20260914i：拉取准确率统计（独立接口，失败不影响主卡片）
      fetch('/api/market-tech/records').then(r => r.json()).then(a => {
        if (a && a.success) this.renderMarketTechAccuracy(a.accuracy);
      }).catch(() => {});
    } catch (e) {
      console.error('loadMarketTechnical error:', e);
      if (!container.dataset.loaded) {
        container.innerHTML = '<div class="mo-loading">大盘技术分析加载失败，点击右上角「刷新」重试</div>';
      }
    }
  },

  renderMarketTechnical(data) {
    const container = document.getElementById('marketTechnicalBody');
    const note = document.getElementById('marketTechnicalNote');
    if (!container) return;
    const dirClass = (d) => d === '看多' ? 'mt-dir-bull' : (d === '看空' ? 'mt-dir-bear' : 'mt-dir-flat');
    const chgClass = (v) => v > 0 ? 'mt-up' : (v < 0 ? 'mt-down' : '');
    const fmt = (v) => (v == null ? '—' : v);
    const cards = (data.indices || []).map(x => {
      if (x.error) {
        return `<div class="mt-index mt-index-error"><div class="mt-name">${this.escapeHtml(x.name)}</div><div class="mt-err">${this.escapeHtml(x.error)}</div></div>`;
      }
      const s1 = x.step1, s2 = x.step2, s3 = x.step3, s4 = x.step4, s5 = x.step5, s6 = x.step6;
      const ss = x.shortStruct || {};
      const ssDirCls = ss.direction === '看多' ? 'mt-dir-bull' : (ss.direction === '看空' ? 'mt-dir-bear' : 'mt-dir-flat');
      const ssVolCls = ss.volumeEffective ? 'up' : 'down';
      const ssOffCls = ss.offensiveConfirm ? 'up' : 'down';
      return `<div class="mt-index">
        <div class="mt-index-head">
          <span class="mt-name">${this.escapeHtml(x.name)}</span>
          <span class="mt-close">${x.lastClose}</span>
          <span class="mt-chg ${chgClass(x.changePct)}">${x.changePct > 0 ? '+' : ''}${x.changePct}%</span>
          <span class="mt-date">${this.escapeHtml(x.date)}</span>
        </div>
        <div class="mt-steps">
          <div class="mt-step">① 趋势定性：<b class="${dirClass(s1.trendLabel.includes('上涨') ? '看多' : s1.trendLabel.includes('下跌') ? '看空' : '震荡')}">${this.escapeHtml(s1.trendLabel)}</b>（${this.escapeHtml(s1.arrangement)}，ADX ${fmt(s1.adx)} ${this.escapeHtml(s1.adxState)}）</div>
          <div class="mt-step">② 形态识别：${this.escapeHtml(s2.structure)}${s2.pattern && s2.pattern.name ? '｜形态：' + this.escapeHtml(s2.pattern.name) : ''}</div>
          <div class="mt-step">③ 量价验证：${this.escapeHtml(s3.health)}（${this.escapeHtml(s3.volState)}）${s3.divergence ? '｜⚠️缩量新高背离' : ''}</div>
          <div class="mt-step">④ 指标共振：<b>${this.escapeHtml(s4.resonance)}</b>（看多${s4.bull}/看空${s4.bear}｜MACD${s4.detail.MACD}/KDJ${s4.detail.KDJ}/RSI${s4.detail.RSI}/BOLL${s4.detail.BOLL}）</div>
          <div class="mt-step">⑤ 周期共振：<b>${this.escapeHtml(s5.conclusion)}</b>（月${s5.monthDir}/周${s5.weekDir}/日${s5.dayDir}/30分${s5.m30Dir}）</div>
        </div>
        <div class="mt-verdict">
          <div class="mt-block mt-mid">
            <div class="mt-block-title">中期研判（1-6 个月）</div>
            <div class="mt-dir ${dirClass(s6.midTerm.direction)}">方向：${this.escapeHtml(s6.midTerm.direction)}</div>
            <div class="mt-line">${this.escapeHtml(s6.midTerm.logic)}</div>
            <div class="mt-line mt-lv">支撑 ${fmt(s6.midTerm.support)} · 压力 ${fmt(s6.midTerm.pressure)}</div>
          </div>
          <div class="mt-block mt-short">
            <div class="mt-block-title">短期研判（1-4 周）</div>
            <div class="mt-dir ${dirClass(s6.shortTerm.direction)}">方向：${this.escapeHtml(s6.shortTerm.direction)}</div>
            <div class="mt-line">${this.escapeHtml(s6.shortTerm.logic)}</div>
            <div class="mt-line mt-lv">支撑 ${fmt(s6.shortTerm.support)} · 压力 ${fmt(s6.shortTerm.pressure)}</div>
          </div>
          <div class="mt-block mt-strategy">
            <div class="mt-block-title">操作策略建议</div>
            <div class="mt-line">仓位：${this.escapeHtml(s6.strategy.position)}</div>
            <div class="mt-line">策略：${this.escapeHtml(s6.strategy.action)}</div>
            <div class="mt-line mt-watch">观测：${this.escapeHtml(s6.strategy.watch)}</div>
            <div class="mt-line mt-muted">口径说明：以上为本指数单口径分因子建议；综合仓位以本卡「🧩 大盘融合研判 → 仓位区间」为准（20261016 审计标注）。</div>
          </div>
          <div class="mt-risk">⚠️ 风险提示：${this.escapeHtml(s6.risk)}</div>
        </div>
        <div class="mt-short-foot">
          <span class="mt-sf-title">短线结构：</span>
          <span class="mt-dir ${ssDirCls}">${this.escapeHtml(ss.direction || '—')}</span>
          <span class="${ss.aboveMA5 ? 'up' : 'down'}">${ss.aboveMA5 ? '站上5日' : '未站上5日'}</span>
          <span class="${ssVolCls}">${this.escapeHtml(ss.volumeNature || '—')}</span>
          <span class="${ssOffCls}">${ss.offensiveConfirm ? '已重新站上MA5(进攻确认)' : '进攻未确认'}</span>
          <span class="mt-sf-anchor">防守锚(前低) ${ss.shortDefensive != null ? ss.shortDefensive : '—'}</span>
        </div>
      </div>`;
    }).join('');

    // ===== 融合决策块（§7 融合版单一输出，替代原「短线结构研判」独立模块）=====
    const f = data.fused || {};
    let fusedHtml = '';
    if (f && f.fusionSignal) {
      const fusionCls = ({ '强多':'fu-bull-strong','偏多':'fu-bull','震荡':'fu-flat','偏空':'fu-bear','强空':'fu-bear-strong','反弹':'fu-amber','回调风险':'fu-amber' })[f.fusionSignal] || 'fu-flat';
      const stateCls = ({ '止跌转强':'fu-bull','破位风险':'fu-bear','弱势震荡':'fu-flat' })[f.state] || 'fu-flat';
      const confCls = ({ '高':'fu-conf-high','中':'fu-conf-mid','低':'fu-conf-low' })[f.confidence] || 'fu-conf-mid';
      const extBias = (f.external && f.external.bias) ? f.external.bias : '中性';
      const extCls = extBias === '偏鹰' ? 'fu-ext-hawk' : (extBias === '偏鸽' ? 'fu-ext-dove' : 'fu-ext-neutral');
      const a = f.anchors || {};
      // 20261016 审计修复：锚点代表与后端口径一致（优先上证，失败顺延第一个可用指数），标签不再硬编码「上证」
      const repIdx = (data.indices || []).find(x => x.code === 'sh000001' && !x.error)
        || (data.indices || []).find(x => !x.error) || {};
      const repName = repIdx.name || '上证';
      const anchorCell = (label, val, extra) => `<div class="mt-anchor"><span class="mt-anchor-label">${this.escapeHtml(label)}</span><span class="mt-anchor-val">${val == null ? '—' : val}${extra ? '<small>' + this.escapeHtml(extra) + '</small>' : ''}</span></div>`;
      const anchorsHtml = `<div class="mt-anchors">
        ${anchorCell('短期防守锚(前低)', a.shortDefensive, repName)}
        ${anchorCell('结构防守锚', a.structuralDefensive, '摆动低')}
        ${anchorCell('中期支撑', a.midSupport)}
        ${anchorCell('中期压力', a.midPressure)}
        ${anchorCell('进攻确认', a.offensiveConfirm ? '✓ 已站上MA5' : '✗ 未站上')}
      </div>`;
      const vol = f.volume || {};
      const volCls = vol.effective ? 'fu-vol-eff' : 'fu-vol-weak';
      const pos = f.position || {};
      const posRange = pos.finalText || (pos.finalRange ? pos.finalRange.join('–') + ' 成' : '—');
      const listHtml = (arr, cls) => (arr || []).map(s => `<li class="${cls || ''}">${this.escapeHtml(s)}</li>`).join('');
      const extNote = (f.external && f.external.note) || '';
      const extDisc = (f.external && f.external.disclaimer) || '';
      fusedHtml = `<div class="mt-fused">
        <div class="mt-fused-head">
          <span class="mt-block-title">🧩 大盘融合研判（技术 + 短线 + 外部）</span>
          <span class="mt-fusion-badge ${fusionCls}">${this.escapeHtml(f.fusionSignal)}</span>
          <span class="mt-state-badge ${stateCls}">${this.escapeHtml(f.state)}</span>
          <span class="mt-conf-badge ${confCls}">置信度 ${this.escapeHtml(f.confidence || '—')}</span>
          <span class="mt-reli-badge ${f.reliable ? 'ok' : 'warn'}">${f.reliable ? '信号可靠' : '可靠度下降'}</span>
        </div>
        ${anchorsHtml}
        <div class="mt-fused-row">
          <div class="mt-block"><div class="mt-block-title">量能辨析</div>
            <span class="mt-vol-badge ${volCls}">${this.escapeHtml(vol.nature || '—')}</span>
            <div class="mt-line">${this.escapeHtml(vol.detail || '')}</div>
          </div>
          <div class="mt-block"><div class="mt-block-title">外部变量</div>
            <span class="mt-ext-badge ${extCls}">${this.escapeHtml(extBias)}</span>
            <div class="mt-line">${this.escapeHtml(extNote)}</div>
            <div class="mt-line mt-muted">${this.escapeHtml(extDisc)}</div>
          </div>
          <div class="mt-block"><div class="mt-block-title">仓位区间（非确定值）</div>
            <div class="mt-pos-range ${pos.noAdd ? 'no-add' : ''}">${this.escapeHtml(posRange)}</div>
            <div class="mt-line mt-muted">上限 ${pos.cap != null ? pos.cap : '—'} 成${pos.noAdd ? ' · 风控否决禁止加仓' : ''}</div>
            <div class="mt-line mt-muted">中期中枢 ${this.escapeHtml(pos.midCenter || '—')} × 短线系数 ${this.escapeHtml(pos.shortCoef || '—')} × 外部系数 ${this.escapeHtml(pos.extCoef || '—')}</div>
          </div>
        </div>
        <div class="mt-block mt-bias-block"><div class="mt-block-title">操作倾向</div><div class="mt-line">${this.escapeHtml(f.bias || '—')}</div></div>
        <div class="mt-fused-cols">
          <div class="mt-block"><div class="mt-block-title">关键信号</div><ul class="mt-sig-list">${listHtml(f.signals)}</ul></div>
          <div class="mt-block mt-risk-block"><div class="mt-block-title">风险条件（按优先级）</div><ul class="mt-risk-list">${listHtml(f.risk, 'mt-risk-item')}</ul></div>
        </div>
        <div class="mt-block"><div class="mt-block-title">证据链（可解释）</div><ul class="mt-evi-list">${listHtml(f.evidenceChain)}</ul></div>
        <div class="mt-resonance">🔗 共振：${this.escapeHtml((f.resonance && f.resonance.indicator) || '—')}｜周期共振「${this.escapeHtml((f.resonance && f.resonance.cycle) || '—')}」｜跨指数「${this.escapeHtml((f.resonance && f.resonance.cross) || '—')}」</div>
      </div>`;
    }

    container.innerHTML = `<div class="mt-list">${cards}</div>${fusedHtml}`;
    if (note) {
      const fbHtml = data.fallback ? `<div class="mt-fallback-note">⚠️ ${this.escapeHtml(data.fallbackNote || '当前展示的是最近一个有效交易日的缓存数据')}</div>` : '';
      note.innerHTML = `<div class="mt-synthesis">${this.escapeHtml(data.synthesis || '')}</div>
        <div class="mt-src">数据源：腾讯行情 K 线（日/周/月/30分）· 收盘后融合推演 · 分析期 ${this.escapeHtml(data.date || '')} · 外部变量：宏观快讯语义研判（非精确实时报价）</div>${fbHtml}`;
    }
  },

  // 近一周涨跌前五高频板块提醒（红涨绿跌：红=上涨，绿=下跌）
  // 数据缓存到 this.lastSectorReminder，由 renderMarketOverview 同步渲染到
  // 涨幅/跌幅前5 卡片末尾的 .mo-tiles-reminder 槽位；本函数只负责拉取最新数据并就地更新槽位，
  // 不再用 insertAdjacentHTML('beforeend') 追加，避免 60s 定时整块 innerHTML 重渲染时卡片丢失/重复。
  async loadSectorRankReminder() {
    try {
      const resp = await fetch('/api/sector-rank-reminder');
      const data = await resp.json();
      if (!data || data.success === false) return;
      this.lastSectorReminder = data;
      this.updateSectorReminderDom();
    } catch (e) {
      console.error('loadSectorRankReminder error:', e);
    }
  },

  // 从缓存生成单个槽位（up/down）的提醒卡片 HTML
  buildReminderHtml(slot) {
    const d = this.lastSectorReminder;
    if (!d || d.success === false) return '';
    const s = slot === 'up' ? d.featuredUp : d.featuredDown;
    if (!s) return '';
    const dir = slot === 'up' ? 'up' : 'down';
    const label = slot === 'up' ? '7日涨幅最大' : '7日跌幅最大';
    const chg = s.weekChgPct == null ? '—' : (s.weekChgPct >= 0 ? '+' : '') + s.weekChgPct + '%';
    const badge = s.swLevel ? `<span class="mo-sw-level">${this.escapeHtml(s.swLevel)}</span>` : '';
    return `<div class="mo-tile ${dir}">
      <div class="mo-name">${label}</div>
      <div class="mo-price">${this.escapeHtml(s.name)}${badge}</div>
      <div class="mo-chg">${chg}</div>
    </div>`;
  },

  // 仅就地更新两个提醒槽位（replace，不追加），与 renderMarketOverview 的整块刷新解耦
  updateSectorReminderDom() {
    ['up', 'down'].forEach(slot => {
      const el = document.querySelector(`.mo-tiles-reminder[data-slot="${slot}"]`);
      if (el) el.innerHTML = this.buildReminderHtml(slot);
    });
  },

  // 首页·行业板块资金流向（主力净流入/流出前五 + 近5日最大）
  // 数据缓存到 this.lastCapitalFlow，由 renderMarketOverview 同步渲染进 #moCapitalFlow 容器；
  // 本函数只负责拉取最新数据并就地 replace 该容器，不再整块追加，杜绝 60s 定时刷新导致的丢失/重复。
  async loadSectorCapitalFlow() {
    if (this._scfLoading) return;
    this._scfLoading = true;
    try {
      const resp = await fetch('/api/sector-capital-flow');
      const data = await resp.json();
      if (!data) return;
      // 即使 success===false（数据源不可用）也缓存并渲染，展示友好空态而非整块空白
      this.lastCapitalFlow = data;
      this.updateCapitalFlowDom();
    } catch (e) {
      console.error('loadSectorCapitalFlow error:', e);
    } finally {
      this._scfLoading = false;
    }
  },

  // 由缓存生成行业资金流向卡片 HTML（与 renderMarketOverview 共用，避免重复拼接逻辑）
  buildCapitalFlowHtml(data) {
    if (!data) return '';
    // 数据源不可用（东财与同花顺备用源均失败）：渲染友好空态，避免整块空白
    if (data.ok === false) {
      const errMsg = data.error ? this.escapeHtml(data.error) : '未知错误';
      return `<div class="mo-row mo-capital-flow">
        <div class="mo-row-head"><span class="mo-flag">💰</span><span class="mo-row-name">行业板块资金流向</span><span class="mo-src mo-src-warn">数据源暂不可用</span></div>
        <div class="mo-tiles"><span class="mo-empty">⚠️ 资金流向获取失败：${errMsg}。已尝试东方财富与同花顺备用源仍不可用，请稍后刷新重试。</span></div>
      </div>`;
    }
    const fmtPct = (n) => (n === null || n === undefined || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
    const fmtNet = (n) => {
      if (n === null || n === undefined || isNaN(n)) return '—';
      return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '亿';
    };
    const swBadge = (it) => it && it.swLevel ? `<span class="mo-sw-level">${this.escapeHtml(it.swLevel)}</span>` : '';
    const renderTile = (it, dirOverride, netLabel) => {
      if (!it) return '';
      const dir = dirOverride || (it.mainNet > 0 ? 'up' : (it.mainNet < 0 ? 'down' : 'flat'));
      const sub = it.leader ? `领涨：${this.escapeHtml(it.leader)}` : `${netLabel || '主力净流'}：${fmtNet(it.mainNet)}`;
      return `<div class="mo-tile ${dir}">
        <div class="mo-name">${this.escapeHtml(it.name)}${swBadge(it)}</div>
        <div class="mo-price">${this.escapeHtml(sub)}</div>
        <div class="mo-chg">${fmtPct(it.changePct)}</div>
      </div>`;
    };
    const renderFiveDay = (it, label) => {
      if (!it || !it.name) {
        return `<div class="mo-tile flat">
          <div class="mo-name">${this.escapeHtml(label)}</div>
          <div class="mo-price">暂无数据</div>
          <div class="mo-chg">—</div>
        </div>`;
      }
      const dir = it.mainNet > 0 ? 'up' : (it.mainNet < 0 ? 'down' : 'flat');
      return `<div class="mo-tile ${dir}">
        <div class="mo-name">${this.escapeHtml(label)}</div>
        <div class="mo-price">${this.escapeHtml(it.name)}${swBadge(it)}</div>
        <div class="mo-chg">${fmtNet(it.mainNet)}</div>
      </div>`;
    };
    const renderRow = (items, label, fiveDay, cls, srcNote, netLabel) => {
      const body = (items && items.length)
        ? items.map(it => renderTile(it, null, netLabel)).join('')
        : '<span class="mo-empty">— 暂无数据 —</span>';
      const srcWarn = data.fallbackWarning ? `<span class="mo-src mo-src-warn" title="${this.escapeHtml(data.fallbackWarning)}">${this.escapeHtml(data.source)}</span>`
        : `<span class="mo-src">${this.escapeHtml(data.source)}</span>`;
      const noteText = srcNote || data.note;
      const note = noteText ? `<span class="mo-count" title="${this.escapeHtml(noteText)}">口径说明</span>` : '';
      // 20260924：资金流数据日期 + 收盘口径标注做成可见标签（不再只藏在来源 title 悬浮里），
      // 让用户一眼知道是上一交易日收盘数据、盘中不更新，消除「卡死」错觉。
      const dateTag = data.date
        ? `<span class="mo-src mo-src-date" title="资金流数据日期">截至 ${this.escapeHtml(data.date)}${data.fallbackWarning ? ' · 收盘口径' : ''}</span>`
        : '';
      return `<div class="mo-row mo-capital-flow ${cls}">
        <div class="mo-row-head"><span class="mo-flag">💰</span><span class="mo-row-name">${this.escapeHtml(label)}</span>${dateTag}${srcWarn}${note}</div>
        <div class="mo-tiles">${body}${renderFiveDay(fiveDay, cls === 'mo-capital-in' ? '近5日净流入最大' : '近5日净流出最大')}</div>
      </div>`;
    };
    // 20260909o：新增散户（小单）净流入/流出前五两行——与主力卡同模板，数据源同接口小单口径
    const RETAIL_NOTE = '散户净流入 = 小单净流入（单笔＜2万股或＜4万元的散户口径）';
    return renderRow(data.todayInflowTop5, '主力资金净流入前五（含暗盘）', data.fiveDayMaxInflow, 'mo-capital-in') +
      renderRow(data.todayOutflowTop5, '主力资金净流出前五（含暗盘）', data.fiveDayMaxOutflow, 'mo-capital-out') +
      (data.retailInflowTop5 ? renderRow(data.retailInflowTop5, '散户（小单）资金净流入前五', data.retailFiveDayMaxInflow, 'mo-capital-in', RETAIL_NOTE, '散户净流') : '') +
      (data.retailOutflowTop5 ? renderRow(data.retailOutflowTop5, '散户（小单）资金净流出前五', data.retailFiveDayMaxOutflow, 'mo-capital-out', RETAIL_NOTE, '散户净流') : '');
  },

  // 仅就地更新资金流向容器（replace，不追加），消除整块刷新导致的卡片丢失/重复
  updateCapitalFlowDom() {
    const el = document.getElementById('moCapitalFlow');
    if (el && this.lastCapitalFlow) el.innerHTML = this.buildCapitalFlowHtml(this.lastCapitalFlow);
  },

  // 首页大盘/板块 AI 滚动解读
  async loadMarketAI(force) {
    const btn = document.getElementById('marketAIBtn');
    if (btn) btn.disabled = true;
    try {
      let result;
      if (force === 'ensure') {
        // 20261024l：按需确保——同一交易日（含周末沿用最近交易日）已有缓存则直接复用，不调 LLM；
        // 仅当该交易日还没解读过才生成。force:false 由后端「按 asOf 交易日缓存」判定。
        const resp = await fetch('/api/ai/market-overview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: this.lastMarketData || {}, force: false }),
        });
        result = await resp.json();
      } else if (force) {
        const resp = await fetch('/api/ai/market-overview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: this.lastMarketData || {}, force: true }),
        });
        result = await resp.json();
      } else {
        const resp = await fetch('/api/ai/market-overview');
        result = await resp.json();
      }
      if (!result || !result.success) {
        // [20261015c] 失败必须可见（诚实合规）：以前只有 NO_KEY 弹窗，API_ERROR（如模型免费额度
        // 耗尽 403）静默返回 → 用户点按钮毫无反应，误以为功能坏了。现在所有失败都给出明确原因。
        if (force) {
          if (result && result.error === 'NO_KEY') {
            alert(result.message || '请先在「⚙️ AI 设置」中配置 API Key');
          } else if (result && (result.error || result.message)) {
            alert('AI 解读生成失败：' + (result.message || result.error));
          } else {
            alert('AI 解读暂不可用：服务端未返回内容，请稍后重试');
          }
        }
        return;
      }
      this.renderMarketAITexts(result);
    } catch (e) {
      console.error('loadMarketAI error:', e);
      alert('AI 解读请求失败：' + (e && e.message ? e.message : '网络异常，请稍后重试'));
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  renderMarketAITexts(result) {
    const map = { cn: 'cn', gainers: 'gainers', losers: 'losers' };
    this.lastMarketAITexts = this.lastMarketAITexts || {};
    Object.keys(map).forEach(key => {
      const text = result[key];
      if (!text) return;
      this.lastMarketAITexts[map[key]] = text;
      const el = document.querySelector(`.mo-ai-bar[data-ai-key="${map[key]}"] .mo-ai-text`);
      if (!el) return;
      const escaped = this.escapeHtml(text);
      el.textContent = text;
      el.title = text;
    });
  },

  renderMarketOverview(data) {
    // 四个分组各自占一行（国内股指 / 涨幅前5 / 跌幅前5 / 美国股指），组内横向排列
    const groups = [
      { key: 'cn', country: '中国指数', flag: '🇨🇳', cls: 'mo-cn', aiKey: 'cn', source: data.indexSource, isEm: data.indexIsEastmoney },
      { key: 'sectorsUp', country: '行业板块涨幅前5', flag: '📈', cls: 'mo-up', aiKey: 'gainers', source: data.panelSource || data.sectorSource, isEm: data.panelIsEastmoney != null ? data.panelIsEastmoney : data.sectorIsEastmoney, reminderSlot: 'up' },
      { key: 'sectorsDown', country: '行业板块跌幅前5', flag: '📉', cls: 'mo-down', aiKey: 'losers', source: data.panelSource || data.sectorSource, isEm: data.panelIsEastmoney != null ? data.panelIsEastmoney : data.sectorIsEastmoney, reminderSlot: 'down' },
      // 20261021a：美国指数行的来源标签单独取 usSource——该行末尾追加了「美债10年期收益率（日线）」，
      // 数据来自美国财政部而非腾讯行情，混在「腾讯行情」标签下就是虚假标注（诚实合规）。
      { key: 'us', country: '美国指数', flag: '🇺🇸', cls: 'mo-us', aiKey: null, source: data.usSource || data.indexSource, isEm: data.indexIsEastmoney },
    ];
    const fmt = (n) => (n === null || n === undefined || isNaN(n)) ? '--' : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtPct = (n) => (n === null || n === undefined || isNaN(n)) ? '--' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

    const warnHtml = data.sectorWarning
      ? `<div class="mo-warn">⚠️ ${this.escapeHtml(data.sectorWarning)}</div>`
      : '';
    const noteHtml = data.sectorNote
      ? `<div class="mo-note">ℹ️ ${this.escapeHtml(data.sectorNote)}</div>`
      : '';
    // 单个 group 渲染为可复用的函数（items 由调用方构造，便于末尾追加「当日最多涨停/跌停板块」卡）
    const swBadge = (it) => it && it.swLevel ? `<span class="mo-sw-level">${this.escapeHtml(it.swLevel)}</span>` : '';
    const renderTile = (it) => {
      // 20261015l：当日最多涨停/跌停板块卡（追加在两组榜单末尾，涨红跌绿与其他卡一致）
      if (it.kind === 'limitUpTop' || it.kind === 'limitDownTop') {
        const isUp = it.kind === 'limitUpTop';
        const sub = it.leader ? `${isUp ? '封板最早' : '代表'}：${this.escapeHtml(it.leader)}` : '--';
        return `<div class="mo-tile ${isUp ? 'up' : 'down'}">
          <div class="mo-name">${this.escapeHtml(it.name || '')}<span class="mo-limit-tag">${isUp ? '涨停最多' : '跌停最多'}</span></div>
          <div class="mo-price">${sub}</div>
          <div class="mo-chg">${it.count} 家${isUp ? '涨停' : '跌停'}</div>
        </div>`;
      }
      const dir = (!it.unavailable && it.changePct > 0) ? 'up' : ((!it.unavailable && it.changePct < 0) ? 'down' : 'flat');
      // 20261021a：美债 10 年期收益率（日线）——收益率与点位是两种量纲，不能套 fmt()/fmtPct()：
      //   · 主值：5.15%（收益率百分数），不是「点位」
      //   · 变动：+6.0bp（基点，1bp = 0.01 个百分点，债券市场通用表达），不是「+1.18%」
      //   · 红涨绿跌沿用：收益率上行=红、下行=绿
      //   · 右上角「日线 · MM-DD」= 数据频率 + 截至日期，明示这不是实时报价，避免与道指/纳指误读
      if (it.kind === 'yield') {
        const bp = (it.changeBp === null || it.changeBp === undefined || isNaN(it.changeBp)) ? null : Number(it.changeBp);
        const yDir = bp == null ? 'flat' : (bp > 0 ? 'up' : (bp < 0 ? 'down' : 'flat'));
        const priceTxt = (it.price === null || it.price === undefined || isNaN(it.price)) ? '--' : Number(it.price).toFixed(2) + '%';
        const bpTxt = bp == null ? '--' : (bp >= 0 ? '+' : '') + bp.toFixed(1) + 'bp';
        const tip = [
          `截至 ${it.asOf || '--'}（日线，非实时行情）`,
          `来源：${it.sourceLabel || '美国财政部'}`,
          (it.prevClose != null) ? `前一交易日 ${Number(it.prevClose).toFixed(2)}%，变动 ${bpTxt}` : '',
          it.staleWarn ? `⚠ 该数据已 ${it.staleDays} 天未更新（周末/美国假日或源站延迟）` : '',
          it.linkUrl ? `点击打开 ${it.linkLabel || '东方财富行情页'}——该页是盘中实时报价，与本卡日线口径不同，数值可能不一致` : '',
        ].filter(Boolean).join('\n');
        const inner = `<div class="mo-name">${this.escapeHtml(it.name || '美债10年期')}<span class="mo-bond-tag">日线·${this.escapeHtml(it.dateLabel || '--')}</span></div>
          <div class="mo-price">${priceTxt}</div>
          <div class="mo-chg">${bpTxt}${it.staleWarn ? ' ⚠' : ''}</div>`;
        // 20261021b：整卡可点，跳东财「美国10年期国债收益率」行情页（用户 2026-10-21 要求）。
        // 用 <a> 而不是给 div 挂 click——浏览器原生行为（中键新窗口、复制链接、状态栏显示目标）都保留。
        if (it.linkUrl) {
          return `<a class="mo-tile bond mo-tile-link ${yDir}" href="${this.escapeHtml(it.linkUrl)}" target="_blank" rel="noopener noreferrer" title="${this.escapeHtml(tip)}">${inner}<span class="mo-link-mark">↗</span></a>`;
        }
        return `<div class="mo-tile bond ${yDir}" title="${this.escapeHtml(tip)}">${inner}</div>`;
      }
      // 20260924：数据中心报表不提供板块指数点位（price=0）→ 视为缺失回退显示领涨/涨跌家数，
      // 否则会渲染出 "0.00" 误导用户以为数据卡死。
      let priceTxt = (it.price && Number(it.price) !== 0) ? fmt(it.price) : '--';
      let subInfo = priceTxt;
      if (subInfo === '--') {
        if (it.leader) subInfo = `领涨：${it.leader}`;
        else if (it.upCount != null && it.downCount != null) subInfo = `涨${it.upCount} / 跌${it.downCount}`;
      }
      return `<div class="mo-tile ${dir}">
        <div class="mo-name">${it.name || it.code}${swBadge(it)}</div>
        <div class="mo-price">${subInfo}</div>
        <div class="mo-chg">${fmtPct(it.changePct)}</div>
      </div>`;
    };
    const renderGroup = (g, items) => {
      const html = (items || []).map(renderTile).join('');
      const emptyMsg = (g.key === 'sectorsUp' && data.sectorUpCount === 0)
        ? '— 市场普跌，暂无上涨板块 —'
        : (g.key === 'sectorsDown' && data.sectorDownCount === 0)
          ? '— 市场普涨，暂无下跌板块 —'
          : '— 暂无数据 —';
      const body = html || `<span class="mo-empty">${emptyMsg}</span>`;
      const cachedText = (g.aiKey && this.lastMarketAITexts && this.lastMarketAITexts[g.aiKey]) ? this.lastMarketAITexts[g.aiKey] : '';
      const aiHint = cachedText || '点击右上角「✨ AI 解读」获取大盘/板块联网分析';
      const aiBar = g.aiKey ? `<div class="mo-ai-bar" data-ai-key="${g.aiKey}"><span class="mo-ai-text" title="${this.escapeHtml(aiHint)}">${this.escapeHtml(aiHint)}</span></div>` : '';
      const cntTag = (g.key === 'sectorsUp' || g.key === 'sectorsDown') && (data.sectorUpCount != null)
        ? `<span class="mo-count">涨${data.sectorUpCount} · 跌${data.sectorDownCount} · 平${data.sectorFlatCount}</span>`
        : '';
      // 20260924：数据中心（收盘口径）通道下，明确标注「截至 X · 收盘口径」，避免用户误以为盘中实时数据卡死。
      const dateTag = (g.key === 'sectorsUp' || g.key === 'sectorsDown') && data.sectorChannel === 'datacenter' && data.sectorDataDate
        ? `<span class="mo-src mo-src-date">截至 ${this.escapeHtml(data.sectorDataDate)} · 收盘口径</span>`
        : '';
      const srcTag = g.source ? `<span class="mo-src${g.isEm ? '' : ' mo-src-warn'}">${g.source}</span>${cntTag}${dateTag}` : '';
      // 提醒卡片槽位：由 renderMarketOverview 同步从缓存生成，整块刷新时不会丢失
      const reminderSlot = g.reminderSlot ? `<div class="mo-tiles-reminder" data-slot="${g.reminderSlot}">${this.buildReminderHtml(g.reminderSlot)}</div>` : '';
      return `${aiBar}<div class="mo-row ${g.cls}">
        <div class="mo-row-head"><span class="mo-flag">${g.flag}</span><span class="mo-row-name">${g.country}</span>${srcTag}</div>
        <div class="mo-tiles">${body}${reminderSlot}</div>
      </div>`;
    };
    // 中国指数 / 行业板块涨幅前5 / 行业板块跌幅前5 / 美国指数，各自占一行；
    // 近一周高频板块（7日涨幅/跌幅最大）由 buildReminderHtml 同步渲染进 .mo-tiles-reminder 槽位；
    // 当日最多涨停/跌停板块卡（20261015l）追加在涨幅/跌幅两组末尾（数据缺失时不渲染，不伪造）；
    // 行业资金流向由 buildCapitalFlowHtml 同步渲染进 #moCapitalFlow 容器（均来自缓存，整块刷新不再丢失）。
    // 20261015l：两组榜单末尾各追加一卡——涨幅组「当日最多涨停板块」、跌幅组「当日最多跌停板块」
    const upItems = (data.sectorsUp || []).slice();
    const topUp = data.topLimitUpBoard;
    if (topUp && topUp.name && topUp.count > 0) {
      upItems.push({ kind: 'limitUpTop', name: topUp.name, count: topUp.count, leader: topUp.leader || '' });
    }
    const downItems = (data.sectorsDown || []).slice();
    const topDown = data.topLimitDownBoard;
    if (topDown && topDown.name && topDown.count > 0) {
      downItems.push({ kind: 'limitDownTop', name: topDown.name, count: topDown.count, leader: topDown.leader || '' });
    }
    const cnHtml = renderGroup(groups.find(g => g.key === 'cn'), data.cn || []);
    const usHtml = renderGroup(groups.find(g => g.key === 'us'), data.us || []);
    const sectorsUpHtml = renderGroup(groups.find(g => g.key === 'sectorsUp'), upItems);
    const sectorsDownHtml = renderGroup(groups.find(g => g.key === 'sectorsDown'), downItems);
    const capitalFlowHtml = this.lastCapitalFlow ? this.buildCapitalFlowHtml(this.lastCapitalFlow) : '';
    const html = warnHtml + noteHtml + '<div class="mo-stack">' +
      cnHtml +
      sectorsUpHtml +
      sectorsDownHtml +
      `<div id="moCapitalFlow">${capitalFlowHtml}</div>` +
      usHtml +
      '</div>';
    document.getElementById('marketOverview').innerHTML = html;
  },

  // 评分计算追溯面板（issue7）
  toggleScoreTrace(kind) {
    const panel = document.getElementById('scoreTracePanel');
    if (!panel) return;

    // 高亮当前选中的评分卡
    ['techScoreCard', 'fundScoreCard', 'capitalScoreCard'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    });

    if (!panel.classList.contains('hidden') && panel.dataset.kind === kind) {
      panel.classList.add('hidden');
      return;
    }
    const activeCard = kind === 'tech' ? 'techScoreCard' : kind === 'fund' ? 'fundScoreCard' : 'capitalScoreCard';
    const activeEl = document.getElementById(activeCard);
    if (activeEl) activeEl.classList.add('active');

    panel.dataset.kind = kind;
    panel.innerHTML = this.buildScoreTrace(kind);
    panel.classList.remove('hidden');
    // 打开后自动滚动到面板可视区域，避免用户以为没反应
    setTimeout(() => panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 30);
  },

  buildScoreTrace(kind) {
    const t = this.scoreTraceData;
    if (!t) return '';
    if (kind === 'tech') {
      const td = t.technical || {};
      const s = td.signals || {};
      const sigRows = [
        ['趋势', s.trend], ['RSI', s.rsiSignal], ['MACD', s.macdSignal],
        ['KDJ', s.kdjSignal], ['布林带', s.bollPosition], ['成交量', `${s.volumeTrend}(${s.volumeRatio})`],
      ].map(([k, v]) => `<div class="st-row"><span>${k}</span><span>${v || '--'}</span></div>`).join('');
      return `
        <div class="st-head">🔍 技术面评分计算依据</div>
        <div class="st-note">技术面评分由以下 4 类信号综合打分得出（MA 趋势、RSI、MACD、KDJ，每类按其多空方向贡献 ±分数，累加为 <b>trendScore</b>，再映射为等级；布林带与成交量仅作展示、不参与计分）。其中 MACD 与 KDJ 各含两个<b>可叠加</b>子项（MACD：多头/空头 ±1 与金叉/死叉 ±1.5；KDJ：超买超卖 ±0.5 与 K-D 方向 ±0.5），故 trendScore 理论区间为 <b>−6.5 ~ +6.5</b>：</div>
        <div class="st-sub">当前 trendScore = <b>${td.trendScore ?? '--'}</b> → 等级：<b>${td.techScore}</b></div>
        <div class="st-grid">${sigRows}</div>
        <div class="st-rule">等级判定：trendScore ≥3 强烈看多；≥1.5 偏多；≤-3 强烈看空；≤-1.5 偏空；其余为中性。</div>`;
    }
    if (kind === 'fund') {
      const f = t.fundamental || {};
      const scores = f.scores || {};
      const dims = ['valuation', 'profitability', 'growth', 'health'];
      const dimRows = dims.map(k => {
        const d = scores[k];
        if (!d) return '';
        return `<div class="st-row"><span>${d.label}</span>
          <span><b>${d.score}</b> / ${d.max}（权重 ${Math.round(d.max / 100 * 100)}%）</span></div>`;
      }).join('');
      const m = f.metrics || {};
      const metricRows = [
        ['市盈率 PE(TTM)', m.pe], ['市净率 PB(MRQ)', m.pb], ['ROE(TTM)', m.roe],
        ['净利率(TTM)', m.netMargin], ['营收增速', m.revenueGrowth], ['股息率(TTM)', m.dividendYield],
      ].map(([k, v]) => `<div class="st-row"><span>${k}</span><span>${v ?? '--'}</span></div>`).join('');
      return `
        <div class="st-head">🔍 基本面评分计算依据</div>
        <div class="st-note">基本面评分 = 估值 + 盈利能力 + 成长性 + 财务健康 四项加权求和（满分 100），再映射为等级。各维度固定权重各 25 分，不随公司类型浮动。</div>
        <div class="st-sub">总分 = <b>${f.score ?? '--'}</b> → 等级：<b>${f.overall}</b>（${f.rating}）</div>
        <div class="st-grid">${dimRows}</div>
        <div class="st-rule">主要参考指标：</div>
        <div class="st-grid">${metricRows}</div>`;
    }
    // capital
    const c = t.capital;
    if (!c) {
      return `<div class="st-head">🔍 资金热度评分计算依据</div>
        <div class="st-note">资金量能数据尚未加载完成，请切换到「资金量能」Tab 加载数据后查看。</div>`;
    }
    const reasonRows = c.reasons.map(r => `<div class="st-row"><span>•</span><span>${r}</span></div>`).join('');
    const raw = c.raw || {};
    const mf5 = raw.moneyFlow?.['5d'];
    const mf20 = raw.moneyFlow?.['20d'];
    const ind = raw.indicators || {};
    const margin = raw.margin || {};
    const detailRows = [
      ['近5日主力净流', mf5 ? `${mf5.mainNet > 0 ? '+' : ''}${mf5.mainNet.toFixed(2)}亿` : '--'],
      ['近20日主力净流', mf20 ? `${mf20.mainNet > 0 ? '+' : ''}${mf20.mainNet.toFixed(2)}亿` : '--'],
      ['OBV 趋势', ind.obvTrend || '--'],
      ['VR 信号', ind.vrSignal || '--'],
      ['MFI 信号', ind.mfiSignal || '--'],
      ['换手率', ind.turnover ? `${ind.turnover}%${ind.turnoverAvg > 0 ? '（月均' + ind.turnoverAvg + '%）' : ''}` : '--'],
      ['融资余额变化', margin.rzChange !== undefined ? `${margin.rzChange > 0 ? '+' : ''}${(margin.rzChange/1e8).toFixed(2)}亿` : '--'],
    ].map(([k, v]) => `<div class="st-row"><span>${k}</span><span>${v}</span></div>`).join('');
    return `
      <div class="st-head">🔍 资金热度评分计算依据</div>
      <div class="st-note">资金热度以 50 分为中性起点，综合量能（交易量，方向无关）、主力资金流向、量能指标（OBV/VR；MFI 仅作展示、不参与计分）、融资融券余额变化与换手率（相对月均）计算，满分 100。</div>
      <div class="st-sub">得分 = <b>${c.score}</b> → 等级：<b>${c.grade}</b></div>
      <div class="st-grid">${reasonRows}</div>
      <div class="st-rule">主要参考数据：</div>
      <div class="st-grid">${detailRows}</div>`;
  },

  // ---- 左栏自选股列表（名称/代码 + 现价 + 涨跌幅标签 + 三态排序 + 拖拽排序 + 右键菜单） ----
  renderWatchlist() {
    const list = Storage.getWatchlist();
    document.getElementById('watchlistCount').textContent = list.length;
    const container = document.getElementById('watchlist');
    const sortArrow = (key) => {
      if (this.watchlistSortKey !== key) return '';
      return this.watchlistSortDir === 1 ? ' ↑' : ' ↓';
    };
    const header = `
      <div class="wl-head">
        <span data-key="name">名称/代码${sortArrow('name')}</span>
        <span data-key="price" style="text-align:right">现价${sortArrow('price')}</span>
        <span data-key="chg" style="text-align:center">涨跌幅${sortArrow('chg')}</span>
      </div>`;
    const chips = this.buildGroupChips();
    if (list.length === 0) {
      container.innerHTML = header + '<div class="wl-empty">暂无自选股，搜索后点击「☆ 自选」添加</div>';
    } else {
      const display = this.getDisplayWatchlist();
      container.innerHTML = chips + header + this.buildWatchlistRows(display);
    }
    // 列头排序高亮 + 升降箭头
    document.querySelectorAll('.wl-head span[data-key]').forEach(h => {
      h.classList.toggle('active', h.dataset.key === this.watchlistSortKey);
    });
    this.bindWatchlistEvents(container);
    this.bindGroupChips(container);
    this.updateWatchlistSelection();
    // 键盘导航高亮复位到当前选中股
    this.watchlistNavIndex = Math.max(0, this.getDisplayWatchlist().findIndex(s => s.symbol === this.currentSymbol));
    this.updateWatchlistNavHighlight();
  },

  // 分组筛选条（含分组时显示）
  buildGroupChips() {
    const groups = Storage.getGroups();
    if (!groups.length) return '';
    const chips = ['', ...groups].map(g => {
      const label = g === '' ? '全部' : this.escapeHtml(g);
      const active = (g === '' ? this.watchlistGroupFilter === 'all' : this.watchlistGroupFilter === g);
      return `<button class="wl-group-chip${active ? ' on' : ''}" data-group="${g === '' ? 'all' : this.escapeHtml(g)}">${label}</button>`;
    }).join('');
    return `<div class="wl-groups">${chips}</div>`;
  },

  bindGroupChips(container) {
    container.querySelectorAll('.wl-group-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        this.watchlistGroupFilter = chip.dataset.group || 'all';
        this.renderWatchlist();
      });
    });
  },

  // 展示用列表：先按分组过滤，再按列排序（排序键为空时保持原始顺序）
  getDisplayWatchlist() {
    let list = Storage.getWatchlist().slice();
    if (this.watchlistGroupFilter && this.watchlistGroupFilter !== 'all') {
      list = list.filter(s => (s.group || '') === this.watchlistGroupFilter);
    }
    return this.sortWatchlist(list);
  },

  buildWatchlistRows(list) {
    const draggable = this.watchlistSortKey ? '' : 'draggable="true"';
    return list.map(s => {
      const q = this.watchlistQuotes[s.symbol];
      const price = q && q.price != null ? Number(q.price).toFixed(2) : '--';
      const dir = q ? (q.changePct > 0 ? 'up' : (q.changePct < 0 ? 'down' : 'flat')) : 'flat';
      const chg = q && q.changePct != null ? (q.changePct >= 0 ? '+' : '') + Number(q.changePct).toFixed(2) + '%' : '--';
      const groupTag = s.group ? `<span class="wl-tag" title="分组">${this.escapeHtml(s.group)}</span>` : '';
      return `<div class="wl-row" data-symbol="${this.escapeHtml(s.symbol)}" data-name="${this.escapeHtml(s.name)}" ${draggable}>
        <div><div class="wl-nm">${this.escapeHtml(s.name)}${groupTag}</div><div class="wl-cd">${this.escapeHtml(s.symbol)}</div></div>
        <div class="wl-price">${price}</div>
        <div class="wl-chg ${dir}${this.boldClass(q && q.changePct)}">${chg}</div>
        <div class="wl-remove" data-symbol="${this.escapeHtml(s.symbol)}">×</div>
      </div>`;
    }).join('');
  },

  bindWatchlistEvents(container) {
    container.querySelectorAll('.wl-head span[data-key]').forEach(h => {
      h.addEventListener('click', () => this.toggleWatchlistSort(h.dataset.key));
    });
    // 20261022i：行导航收敛为唯一入口 navigateToRow，由 click 和 pointerup 两条通道共同触发。
    // 根因：默认顺序下行带 draggable="true"，指针按下时只要有几像素移动，浏览器就判定为
    // HTML5 拖拽并**不再派发 click** → 用户必须点好几次才切得过去（触控板/手抖鼠标尤甚）。
    // pointerup 一定会触发，因此用它做兜底：位移 ≤ 6px 且间隔 < 900ms 才认为是一次单击。
    const navigateToRow = (row, idx) => {
      this._wlLastNavAt = Date.now();
      this._wlLastNavSymbol = row.dataset.symbol;
      this.watchlistNavIndex = idx;
      this.updateWatchlistNavHighlight();
      this.analyze(row.dataset.symbol, row.dataset.name);
    };
    // pointerup 先于 click 触发；若 pointerup 已为**同一只股票**导航过，紧随其后的 click 直接忽略。
    // 必须带 symbol 维度：否则"快速点 A 再点 B"会被误判成重复点击（20261022i）
    const navDeduped = (symbol) => this._wlLastNavSymbol === symbol && this._wlLastNavAt && Date.now() - this._wlLastNavAt < 600;
    container.querySelectorAll('.wl-row').forEach((row, idx) => {
      row.addEventListener('click', e => {
        if (e.target.classList.contains('wl-remove')) {
          e.stopPropagation();
          this.confirmRemoveWatchlist(row.dataset.symbol);
        } else if (!navDeduped(row.dataset.symbol)) {
          navigateToRow(row, idx);
        }
      });
      row.addEventListener('pointerdown', e => {
        if (e.target.classList.contains('wl-remove')) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;   // 只认左键
        this._wlPress = { symbol: row.dataset.symbol, x: e.clientX, y: e.clientY, t: Date.now() };
      });
      row.addEventListener('pointerup', e => {
        const p = this._wlPress;
        this._wlPress = null;
        if (!p || p.symbol !== row.dataset.symbol) return;
        if (e.target.classList.contains('wl-remove')) return;       // 停在 × 上不导航
        if (Date.now() - p.t > 900) return;                         // 长按不算单击
        // 位移阈值 6px：超过即视为拖拽排序意图，绝不导航
        if (Math.abs(e.clientX - p.x) > 6 || Math.abs(e.clientY - p.y) > 6) return;
        if (navDeduped(row.dataset.symbol)) return;
        navigateToRow(row, idx);
      });
      row.addEventListener('pointercancel', () => { this._wlPress = null; });
      row.addEventListener('contextmenu', e => this.openContextMenu(e, row.dataset.symbol, row.dataset.name));
      // 拖拽排序（仅在默认顺序下启用）
      if (row.getAttribute('draggable') === 'true') {
        row.addEventListener('dragstart', e => this.onWlDragStart(e, row.dataset.symbol));
        row.addEventListener('dragover', e => this.onWlDragOver(e));
        row.addEventListener('dragleave', e => this.onWlDragLeave(e));
        row.addEventListener('drop', e => this.onWlDrop(e, row.dataset.symbol));
        row.addEventListener('dragend', () => {
          this._dragSymbol = null;
          container.querySelectorAll('.wl-row').forEach(r => r.classList.remove('dragging', 'drag-over'));
        });
      }
    });
  },

  toggleWatchlistSort(key) {
    if (this.watchlistSortKey === key) {
      // 升 -> 降 -> 默认（取消排序）
      if (this.watchlistSortDir === 1) this.watchlistSortDir = -1;
      else { this.watchlistSortKey = null; this.watchlistSortDir = 1; }
    } else {
      this.watchlistSortKey = key;
      this.watchlistSortDir = 1;
    }
    this.renderWatchlist();
  },

  sortWatchlist(list) {
    const key = this.watchlistSortKey;
    if (!key) return list;
    const dir = this.watchlistSortDir;
    const val = (s) => {
      if (key === 'name') return s.name;
      const q = this.watchlistQuotes[s.symbol];
      if (!q) return -Infinity;
      if (key === 'price') return q.price ?? -Infinity;
      if (key === 'chg') return q.changePct ?? -Infinity;
      return 0;
    };
    return list.slice().sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string' && typeof vb === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
  },

  updateWatchlistSelection() {
    document.querySelectorAll('.wl-row').forEach(r => {
      r.classList.toggle('selected', r.dataset.symbol === this.currentSymbol);
    });
  },

  updateWatchlistNavHighlight() {
    document.querySelectorAll('.wl-row').forEach((r, i) => {
      r.classList.toggle('nav-active', i === this.watchlistNavIndex);
    });
  },

  // ---- 拖拽排序 ----
  onWlDragStart(e, symbol) {
    this._dragSymbol = symbol;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', symbol); } catch {}
    e.currentTarget.classList.add('dragging');
  },
  onWlDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = e.target.closest('.wl-row');
    if (row) row.classList.add('drag-over');
  },
  onWlDragLeave(e) {
    const row = e.target.closest('.wl-row');
    if (row) row.classList.remove('drag-over');
  },
  onWlDrop(e, targetSymbol) {
    e.preventDefault();
    const src = this._dragSymbol;
    const row = e.target.closest('.wl-row');
    if (row) row.classList.remove('drag-over');
    if (!src || src === targetSymbol) return;
    const list = Storage.getWatchlist().slice();
    const from = list.findIndex(s => s.symbol === src);
    const to = list.findIndex(s => s.symbol === targetSymbol);
    if (from >= 0 && to >= 0) {
      const [item] = list.splice(from, 1);
      list.splice(to, 0, item);
      Storage.setWatchlist(list);
      this.renderWatchlist();
      this.toast('顺序已更新', 'success');
    }
    this._dragSymbol = null;
  },

  // ---- 右键菜单 ----
  openContextMenu(e, symbol, name) {
    e.preventDefault();
    e.stopPropagation();
    const menu = document.getElementById('watchlistContextMenu');
    if (!menu) return;
    const groups = Storage.getGroups();
    const groupItems = ['', ...groups].map(g =>
      `<div class="ctx-item" data-act="group" data-group="${g === '' ? '' : this.escapeHtml(g)}">${g === '' ? '未分组' : this.escapeHtml(g)}</div>`
    ).join('');
    menu.innerHTML = `
      <div class="ctx-item" data-act="view">查看详情</div>
      <div class="ctx-item" data-act="pin">置顶</div>
      <div class="ctx-sep"></div>
      <div class="ctx-label">移动到分组</div>
      ${groupItems}
      <div class="ctx-item" data-act="newgroup">＋ 新建分组…</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item danger" data-act="remove">移除自选</div>`;
    menu.dataset.symbol = symbol;
    menu.dataset.name = name || '';
    menu.classList.remove('hidden');
    // 视口边界校正
    const rect = menu.getBoundingClientRect();
    let x = e.clientX, y = e.clientY;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
  },
  closeContextMenu() {
    const menu = document.getElementById('watchlistContextMenu');
    if (menu) menu.classList.add('hidden');
  },
  handleContextAction(act, group) {
    const menu = document.getElementById('watchlistContextMenu');
    const symbol = menu.dataset.symbol;
    const name = menu.dataset.name;
    this.closeContextMenu();
    if (!symbol) return;
    if (act === 'view') this.analyze(symbol, name);
    else if (act === 'pin') { Storage.pinToTop(symbol); this.renderWatchlist(); this.toast('已置顶', 'success'); }
    else if (act === 'group' || group !== undefined) {
      Storage.moveToGroup(symbol, group === undefined ? '' : group);
      this.renderWatchlist();
      this.toast(group ? `已移入「${group}」` : '已移出分组', 'success');
    }
    else if (act === 'newgroup') this.promptNewGroup(symbol);
    else if (act === 'remove') this.confirmRemoveWatchlist(symbol);
  },
  promptNewGroup(symbol) {
    const name = window.prompt('输入新分组名称（如：核心仓 / 观察池）');
    if (name === null) return;
    const g = String(name).trim();
    if (!g) return;
    Storage.moveToGroup(symbol, g);
    this.watchlistGroupFilter = g;
    this.renderWatchlist();
    this.toast(`已加入分组「${g}」`, 'success');
  },
  confirmRemoveWatchlist(symbol) {
    this.showConfirm('移除自选股', `确定将「${symbol}」从自选股移除吗？`, () => {
      Storage.removeFromWatchlist(symbol);
      delete this.watchlistQuotes[symbol];
      this.renderWatchlist();
      this.updateWatchlistButton();
      this.toast('已从自选股移除', 'success');
    });
  },

  // 单只股票拉取：失败重试（指数退避）+ 错误日志，让用户能在浏览器 console 看到失败原因
  async fetchOneWatchlistQuote(symbol, attempt = 1) {
    const url = `/api/quote/${encodeURIComponent(symbol)}`;
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const text = await resp.text();
      let q;
      try { q = JSON.parse(text); } catch (parseErr) { throw new Error(`JSON.parse 失败: ${parseErr.message}; 前 80 字节: ${text.slice(0, 80)}`); }
      if (!q || q.price == null) throw new Error(`响应缺少 price 字段`);
      return q;
    } catch (e) {
      if (attempt < 3) {
        // 指数退避：第2次 400ms、第3次 800ms
        await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt - 1)));
        return this.fetchOneWatchlistQuote(symbol, attempt + 1);
      }
      console.warn(`[自选股行情] ${symbol} 拉取失败（已重试 ${attempt - 1} 次）: ${e.message}`);
      return null;
    }
  },

  async loadWatchlistQuotes() {
    const list = Storage.getWatchlist();
    if (!list.length) return;
    const results = await Promise.all(list.map(async s => {
      const q = await this.fetchOneWatchlistQuote(s.symbol);
      if (q) this.watchlistQuotes[s.symbol] = q;
      else delete this.watchlistQuotes[s.symbol];
    }));
    this.renderWatchlist();
    // 给前端一个完成信号（供调试 / 第三方调用）
    document.dispatchEvent(new CustomEvent('watchlist-quotes-loaded'));
  },

  // 定时刷新自选股行情（每 60s 一次，不重渲染整个列表，只更新价格/涨跌幅单元）
  startWatchlistQuoteRefresh() {
    if (this._wlQuoteTimer) return;
    this._wlQuoteTimer = setInterval(async () => {
      const list = Storage.getWatchlist();
      if (!list.length) return;
      // 静默刷新（不 console.warn，仅失败时不写入）；单只失败被吞，watchlistQuotes 不变
      await Promise.all(list.map(async s => {
        try {
          const resp = await fetch(`/api/quote/${encodeURIComponent(s.symbol)}`, { cache: 'no-store' });
          if (resp.ok) {
            const q = await resp.json();
            if (q && q.price != null) this.watchlistQuotes[s.symbol] = q;
          }
        } catch {}
      }));
      // 20261022i：这里原来直接调 renderWatchlist() 整体 innerHTML 重建（与上一行注释矛盾）——
      // 每 60 秒把整个列表 DOM 推倒重来，会重置滚动位置与悬浮态，还可能吃掉"按下时有、抬起时没了"
      // 的那一次点击。改为只 patch 价格/涨跌幅单元格；只有在按列排序时（价格变化会改变顺序）才整体重排。
      this.patchWatchlistPrices();
    }, 60000);
  },

  // 只更新已渲染行的价格/涨跌幅，不动 DOM 结构与顺序（20261022i）
  patchWatchlistPrices() {
    if (this.watchlistSortKey) { this.renderWatchlist(); return; }  // 排序态：价格变化会改变行序，必须重排
    const container = document.getElementById('watchlist');
    if (!container) return;
    container.querySelectorAll('.wl-row').forEach(row => {
      const q = this.watchlistQuotes[row.dataset.symbol];
      if (!q) return;
      const priceEl = row.querySelector('.wl-price');
      if (priceEl && q.price != null) priceEl.textContent = Number(q.price).toFixed(2);
      const chgEl = row.querySelector('.wl-chg');
      if (chgEl) {
        const dir = q.changePct > 0 ? 'up' : (q.changePct < 0 ? 'down' : 'flat');
        chgEl.className = `wl-chg ${dir}${this.boldClass(q.changePct)}`;
        chgEl.textContent = q.changePct != null
          ? (q.changePct >= 0 ? '+' : '') + Number(q.changePct).toFixed(2) + '%'
          : '--';
      }
    });
  },

  // ---- 详情页「当前个股」实时刷新（每 60s，与左侧自选股同源 / 同频）----
  // 目的：详情页头部价格、关键指标网格、资金量能·量价卡此前只在打开该股时取一次（快照），
  // 而左侧自选股每 60s 刷新 → 时间越久两边越不一致（同一只股两个价）。此定时器把详情页
  // 拉回实时口径：仅刷新「行情派生」展示；技术面/基本面等属分析快照，不在本定时器内刷新。
  startCurrentQuoteRefresh() {
    if (this._curQuoteTimer) return;
    this._curQuoteTimer = setInterval(() => { this.refreshCurrentQuoteTick(); }, 60000);
  },

  refreshCurrentQuoteTick() {
    if (document.hidden) return;                              // 后台标签页不刷新
    if (!this.currentSymbol || !this.currentData) return;     // 未选股（首页）不刷新
    const dash = document.getElementById('dashboard');
    if (!dash || dash.classList.contains('hidden')) return;   // 详情页不可见（回到首页）时不刷新
    this.refreshCurrentQuote();
  },

  async refreshCurrentQuote() {
    const symbol = this.currentSymbol;
    if (!symbol || !this.currentData || this.currentData.symbol !== symbol) return;   // 仅对当前个股的快照做刷新
    try {
      const resp = await fetch(`/api/quote/${encodeURIComponent(symbol)}`, { cache: 'no-store' });
      if (!resp.ok) return;
      const q = await resp.json();
      if (!q || q.price == null) return;
      if (symbol !== this.currentSymbol || this.currentData.symbol !== symbol) return;   // 期间已切股：丢弃本次结果，避免串股

      // 把最新行情合并进当前分析快照的 quote：覆盖行情字段（价格/涨跌/高低/换手/量额/PE/PB…），
      // 保留分析期其余字段（reportDate/reportPeriod/roeTtm 等），保证格网与头部同步、无新差异。
      const prevQuote = this.currentData.quote || {};
      const merged = Object.assign({}, prevQuote, q);
      if (q.fundamentals) {
        merged.fundamentals = Object.assign({}, prevQuote.fundamentals || {}, q.fundamentals);
      }
      this.currentData = Object.assign({}, this.currentData, { quote: merged });

      this.applyLiveQuote(merged, this.currentData.market);
      try { this.renderKeyMetrics(this.currentData); } catch (e) { console.error('[实时刷新] 关键指标渲染失败:', e); }

      // 资金量能·量价卡（量价信号/今日涨跌/今日量比…）静默刷新（仅在该股资金数据已加载时）
      if (this.capitalDataLoaded && this.capitalLoadedSymbol === symbol) {
        this.refreshCapitalFlowSilent();
      }

      // 20261017h：分时视图跟随 60s 刷新重绘——盘中分时是逐分钟增长的，静态画面会误导。
      // （K 线主图本身仍不刷新，属既有 S11 缺陷：分析快照不重算，仅分时视图走增量重绘。）
      if (this.currentPeriod === 'minute' && symbol === this.currentSymbol) {
        this.minuteData = null;                 // 丢弃缓存，强制取最新分时
        await this.renderMinute({ silent: true });
      }
    } catch (e) {
      // 静默失败：保留上一次数值，不打扰用户
    }
  },

  // 静默刷新资金量能「量价卡」：只更新文本卡片（量价信号 / 今日涨跌 / 今日量比 / 20日… / 量能热度）
  // 与资金热度评分；不重建 ECharts 图表，避免每 60s 一次全量重绘造成闪烁。
  async refreshCapitalFlowSilent() {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    try {
      const name = this.currentData?.name || '';
      const resp = await fetch(`/api/capital-flow/${encodeURIComponent(symbol)}?name=${encodeURIComponent(name)}`, { cache: 'no-store' });
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data || data.error) return;
      if (symbol !== this.currentSymbol) return;
      this.capitalData = data;
      // 20261024i：量价关系已合并进「量能分析」卡（renderVolumeEngine 内一并刷新），不再单独渲染
      try { this.renderCapitalScore(data); } catch (e) { console.error('[实时刷新] 资金评分渲染失败:', e); }
      try { this.renderVolumeEngine(data); } catch (e) { console.error('[实时刷新] 量能引擎渲染失败:', e); }
    } catch (e) { /* 静默：保留上一次数值 */ }
  },

  // 涨跌幅绝对值 ≥10% 时返回加粗类（如涨停/跌停），其余为空
  boldClass(pct) {
    return (pct != null && !isNaN(pct) && Math.abs(pct) >= 10) ? ' chg-strong' : '';
  },

  // ---- 顶栏大盘行情状态栏 ----
  loadTopbarIndices() {
    const container = document.getElementById('marketTopbarIndices');
    if (!container) return;
    fetch('/api/market-overview', { cache: 'no-store' })
      .then(r => r.json())
      .then(data => {
        if (data && data.topbar) this.renderTopbarIndices(data.topbar);
        else container.innerHTML = '<span class="tb-loading">大盘行情暂不可用</span>';
      })
      .catch(() => { container.innerHTML = '<span class="tb-loading">大盘行情暂不可用</span>'; });
  },

  renderTopbarIndices(indices) {
    const container = document.getElementById('marketTopbarIndices');
    if (!container) return;
    if (!indices || !indices.length) { container.innerHTML = '<span class="tb-loading">暂无大盘行情</span>'; return; }
    if (!this._topbarPrev) this._topbarPrev = {};
    container.innerHTML = indices.map(i => {
      if (i.unavailable) {
        this._topbarPrev[i.code] = null;
        return `<span class="tb-index" data-code="${this.escapeHtml(i.code)}" title="数据暂不可用"><span class="tb-name">${this.escapeHtml(i.name)}</span><span class="tb-price">--</span><span class="tb-chg flat">--</span></span>`;
      }
      const pct = (i.changePct ?? 0);
      const price = (i.price ?? 0);
      const dir = pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat');
      const chg = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
      // 仅数字位闪动：与上次相比价格/涨跌幅变化的才加 num-flash，避免整行重绘闪烁
      const prev = this._topbarPrev[i.code];
      const priceFlash = prev && prev.price !== price ? ' num-flash' : '';
      const chgFlash = prev && prev.pct !== pct ? ' num-flash' : '';
      this._topbarPrev[i.code] = { price, pct };
      return `<span class="tb-index" data-code="${this.escapeHtml(i.code)}" title="${this.escapeHtml(i.name)}">
        <span class="tb-name">${this.escapeHtml(i.name)}</span>
        <span class="tb-price${priceFlash}">${price.toFixed(2)}</span>
        <span class="tb-chg ${dir}${this.boldClass(pct)}${chgFlash}">${chg}</span>
      </span>`;
    }).join('');
  },

  fmtMarketCap(v) {
    if (v === null || v === undefined || isNaN(v)) return '--';
    if (v >= 10000) return (v / 10000).toFixed(2) + '万亿';
    return Storage.formatNumber(v) + '亿';
  },

  // ---- 中栏图表：周期初始化（日K/周K/月K/60分钟） ----
  renderDashboardCharts(data) {
    this.currentPeriod = 'daily';
    document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === 'daily'));
    this._syncRangeControls('daily');
  },

  // ---- 中栏图表：周期切换（分时/日K/周K/月K/60分钟） ----
  // 「时间范围」只对日/周/月K 有意义；分时与 60 分钟无此概念 → 隐藏范围按钮
  _syncRangeControls(period) {
    const el = document.getElementById('rangeControls');
    if (el) el.style.display = (period === 'minute' || period === '60m') ? 'none' : '';
  },

  async switchPeriod(period) {
    if (!this.currentSymbol) return;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === period));
    this._syncRangeControls(period);
    if (period === 'minute') {
      this.currentPeriod = period;
      await this.renderMinute();
      return;
    }
    if (period === '60m') {
      this.currentPeriod = period;
      await this.render60m();
      return;
    }
    this.currentPeriod = period;
    this.renderMainChart(period);
  },

  // 分时走势（20261017h）：与量能引擎同源的腾讯分时数据 + 均价线 + 分钟量柱
  // opts.silent = 静默模式（60s 实时刷新用）：失败仅留痕，不弹提示、不切回日K，避免打断阅读
  async renderMinute(opts = {}) {
    const silent = !!(opts && opts.silent);
    const symbol = this.currentSymbol;
    try {
      if (!this.minuteData || this.minuteData.symbol !== symbol) {
        const resp = await fetch(`/api/minute/${encodeURIComponent(symbol)}`, { cache: 'no-store' });
        const data = await resp.json();
        if (data && data.success && Array.isArray(data.minutes) && data.minutes.length) {
          this.minuteData = { symbol, minutes: data.minutes, prevClose: data.prevClose, minuteDate: data.minuteDate || null };
        } else {
          if (silent) { console.warn('[实时刷新] 分时数据暂不可用，保留上次画面'); return; }
          this.toast('分时数据暂不可用，已切回日K', 'info');
          this.fallbackToDaily();
          return;
        }
      }
      Charts.minute('candlestickChart', this.minuteData);
    } catch (e) {
      if (silent) { console.warn('[实时刷新] 分时重绘失败:', e && e.message); return; }
      this.toast('分时数据加载失败，已切回日K', 'error');
      this.fallbackToDaily();
    }
  },

  // 60分钟周期：东财 klt=60，第一根收盘价与实时价同口径（不复权）
  async render60m() {
    const symbol = this.currentSymbol;
    try {
      if (!this.history60m || !this.history60m.length) {
        const resp = await fetch(`/api/history60/${encodeURIComponent(symbol)}`, { cache: 'no-store' });
        const data = await resp.json();
        if (data && data.success && data.history && data.history.length) {
          this.history60m = data.history;
          this.technical60m = data.technical || null;
        } else {
          this.toast('60分钟数据暂不可用，已切回日K', 'info');
          this.fallbackToDaily();
          return;
        }
      }
      Charts.candlestick('candlestickChart', this.history60m, this.technical60m);
    } catch (e) {
      this.toast('60分钟数据加载失败，已切回日K', 'error');
      this.fallbackToDaily();
    }
  },

  renderMainChart(period) {
    const history = this.dailyHistory || [];
    if (!history.length) return;
    if (period === 'daily') {
      Charts.candlestick('candlestickChart', history, this.dailyTechnical);
    } else if (period === 'weekly' || period === 'monthly') {
      const resampled = this.resampleHistory(history, period);
      if (resampled.length) Charts.candlestick('candlestickChart', resampled, { series: this.computeMA(resampled) });
    }
  },

  fallbackToDaily() {
    this.currentPeriod = 'daily';
    document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === 'daily'));
    this._syncRangeControls('daily');
    this.renderMainChart('daily');
  },

  // ---- 周/月K 重采样（日K聚合） ----
  resampleHistory(history, period) {
    const buckets = new Map();
    history.forEach(d => {
      const key = period === 'weekly' ? this.isoWeekKey(d.date) : (d.date ? d.date.slice(0, 7) : 'unknown');
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(d);
    });
    const out = [];
    buckets.forEach((bars) => {
      bars.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      const first = bars[0], last = bars[bars.length - 1];
      out.push({
        date: last.date,
        open: first.open,
        close: last.close,
        high: Math.max(...bars.map(b => b.high)),
        low: Math.min(...bars.map(b => b.low)),
        volume: bars.reduce((s, b) => s + (b.volume || 0), 0),
        amount: bars.reduce((s, b) => s + (b.amount || 0), 0),
        turnover: last.turnover || 0,
      });
    });
    return out;
  },

  isoWeekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    if (isNaN(d)) return dateStr;
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day + 3);
    const week1 = new Date(d.getFullYear(), 0, 4);
    const week = Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
    return d.getFullYear() + '-W' + String(week).padStart(2, '0');
  },

  computeMA(history) {
    const closes = history.map(d => d.close);
    const ma = (n) => closes.map((_, i) => {
      if (i < n - 1) return null;
      let sum = 0;
      for (let j = i - n + 1; j <= i; j++) sum += closes[j];
      return +(sum / n).toFixed(2);
    });
    return { ma5: ma(5), ma10: ma(10), ma20: ma(20), ma60: ma(60) };
  },

  // ---- History ----
  renderHistory() {
    const list = Storage.getHistory();
    const container = document.getElementById('historyList');

    if (list.length === 0) {
      container.innerHTML = '<p style="color:var(--text-on-dark-secondary);font-size:12px;padding:8px 0;">暂无搜索历史</p>';
      return;
    }

    container.innerHTML = list.map(s => `
      <div class="history-item" data-symbol="${s.symbol}" data-name="${s.name}">
        <span class="h-name">${s.name}</span>
        <span class="h-time">${Storage.formatTime(s.time)}</span>
      </div>
    `).join('');

    container.querySelectorAll('.history-item').forEach(el => {
      el.addEventListener('click', () => {
        this.analyze(el.dataset.symbol, el.dataset.name);
      });
    });
  },

  // ---- Export ----
  exportHTML() {
    if (!this.currentData) return;
    Exporter.toHTML(this.currentData);
    this.toast('HTML报告已导出');
  },

  exportJSON() {
    if (!this.currentData) return;
    Exporter.toJSON(this.currentData);
    this.toast('JSON数据已导出');
  },

  // ---- Loading & Toast ----
  // 非阻塞加载指示：顶部进度条 + 加载胶囊文字，绝不使用全屏遮罩拦截交互。
  // 这样在切换个股 / 搜索 / 加载分析时，用户仍可点击自选股、切 tab、滚动页面。
  // 20261022i：此前 text 参数被完全丢弃，只剩一条 3px 进度条；切股冷缓存要 2~4 秒，
  // 期间屏幕仍是上一只股票的内容，用户以为"没点上"而反复点击 → 每次都重新发起请求，
  // 反而把等待时间不断重置。现在把 text 显示为胶囊，点击后立刻有可见反馈。
  showLoading(text = '正在获取数据...') {
    const bar = document.getElementById('topProgressBar');
    if (bar) {
      bar.classList.remove('hidden', 'done');
      // 强制回流，使 width 过渡从 0 重新触发
      void bar.offsetWidth;
      bar.classList.add('active');
    }
    const pill = document.getElementById('loadingPill');
    if (pill) {
      pill.textContent = text || '正在获取数据...';
      pill.classList.remove('hidden');
      // 强制回流，让 .on 的淡入过渡每次都重新播放
      void pill.offsetWidth;
      pill.classList.add('on');
    }
  },

  hideLoading() {
    const bar = document.getElementById('topProgressBar');
    const pill = document.getElementById('loadingPill');
    if (pill) {
      pill.classList.remove('on');
      // 等淡出过渡结束再挂 hidden，避免文字"啪"地消失
      setTimeout(() => { if (!pill.classList.contains('on')) pill.classList.add('hidden'); }, 200);
    }
    if (!bar) return;
    bar.classList.add('done');
    setTimeout(() => {
      bar.classList.remove('active');
      bar.classList.add('hidden');
    }, 320);
  },

  // ---- 二次确认弹窗 ----
  showConfirm(title, message, onConfirm) {
    const dlg = document.getElementById('confirmDialog');
    if (!dlg) { if (typeof onConfirm === 'function') onConfirm(); return; }
    const t = document.getElementById('confirmTitle');
    const m = document.getElementById('confirmMessage');
    if (t) t.textContent = title || '确认操作';
    if (m) m.textContent = message || '';
    this._confirmCb = typeof onConfirm === 'function' ? onConfirm : null;
    dlg.classList.remove('hidden');
  },
  closeConfirm() {
    const dlg = document.getElementById('confirmDialog');
    if (dlg) dlg.classList.add('hidden');
    this._confirmCb = null;
  },
  confirmOk() {
    const cb = this._confirmCb;
    this.closeConfirm();
    if (typeof cb === 'function') cb();
  },

  // ---- 快捷键提示层 ----
  toggleKeyboardHelp(force) {
    const hint = document.getElementById('keyboardHelp');
    if (!hint) return;
    const show = typeof force === 'boolean' ? force : hint.classList.contains('hidden');
    hint.classList.toggle('hidden', !show);
  },

  // ---- 错误占位横幅（断网 / 接口异常，保留已展示数据，提供重试） ----
  showErrorBanner(message, retryFn) {
    const banner = document.getElementById('errorBanner');
    if (!banner) return;
    const msgEl = document.getElementById('errorBannerMsg');
    const btn = document.getElementById('errorBannerRetry');
    if (msgEl) msgEl.textContent = message || '数据加载失败';
    this._errorRetry = retryFn || null;
    if (btn) btn.style.display = retryFn ? '' : 'none';
    banner.classList.remove('hidden');
  },
  hideErrorBanner() {
    const banner = document.getElementById('errorBanner');
    if (banner) banner.classList.add('hidden');
  },
  retryBanner() {
    const fn = this._errorRetry;
    this.hideErrorBanner();
    if (typeof fn === 'function') fn();
  },

  // ---- Toast 通知（success / error / info / loading） ----
  toast(message, type = 'info', duration = 3000) {
    const el = document.getElementById('toast');
    if (!el) return;
    clearTimeout(this.toastTimer);
    el.className = 'toast show ' + type;
    const icons = { success: '✓', error: '✕', info: 'ℹ', loading: '◌' };
    const icon = icons[type] || '';
    el.innerHTML = (icon ? `<span class="toast-icon">${icon}</span>` : '') +
      `<span class="toast-msg">${this.escapeHtml(message)}</span>`;
    if (type === 'loading') return; // loading 持久到显式 hideToast
    this.toastTimer = setTimeout(() => el.classList.remove('show'), duration);
  },
  hideToast() {
    const el = document.getElementById('toast');
    if (el) el.classList.remove('show');
  },
};

// Initialize
document.addEventListener('DOMContentLoaded', () => App.init());

~~~

---

## `public\js\backtestUI.js`  ·  469 行

~~~js
'use strict';
/**
 * public/js/backtestUI.js — 策略回测校验模块前端
 * 依赖：lib/backtestValidator.js（后端纯 JS 引擎）
 * 调用：app.js switchTab('backtest') → BacktestUI.open(symbol, name)
 */
window.BacktestUI = (function () {
  let current = { symbol: '', name: '' };
  let lastRenderedSymbol = ''; // 已渲染结果对应的个股（用于「策略页随个股切换」自动重渲染判定）

  // 高级框「一键模板」：纯前端确定性预设，点击后填入合法 DSL（避免零代码用户手写 DSL 出错）
  const PRESETS = [
    { label: '双均线金叉(5,20)', dsl: 'STRATEGY_TYPE: single\nNAME: 双均线金叉(5,20)\nBUY: CROSS_UP(MA(CLOSE,5), MA(CLOSE,20))\nSELL: CROSS_DOWN(MA(CLOSE,5), MA(CLOSE,20))' },
    { label: 'MACD金叉', dsl: 'STRATEGY_TYPE: single\nNAME: MACD金叉\nBUY: CROSS_UP(MACD_DIF(CLOSE), MACD_DEA(CLOSE))\nSELL: CROSS_DOWN(MACD_DIF(CLOSE), MACD_DEA(CLOSE))' },
    { label: 'RSI超卖反弹(14)', dsl: 'STRATEGY_TYPE: single\nNAME: RSI超卖反弹(14)\nBUY: RSI(CLOSE,14) < 30\nSELL: RSI(CLOSE,14) > 70' },
    { label: '布林带下轨买入(20,2)', dsl: 'STRATEGY_TYPE: single\nNAME: 布林带下轨买入(20,2)\nBUY: CLOSE < BOLL_LOWER(CLOSE,20,2)\nSELL: CLOSE > BOLL_MID(CLOSE,20,2)' },
    { label: '价格z-score回归(20)', dsl: 'STRATEGY_TYPE: single\nNAME: 价格z-score回归(20)\nBUY: ZSCORE(CLOSE,20) < -1.5\nSELL: ZSCORE(CLOSE,20) > 1.5' }
  ];

  function el(id) { return document.getElementById(id); }
  function fmtPct(x) { return (x * 100).toFixed(1) + '%'; }
  function cls(x) { return x > 0 ? 'up' : (x < 0 ? 'down' : ''); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function metricCard(k, v, c) {
    return '<div class="bt-metric"><div class="k">' + k + '</div><div class="v ' + (c || '') + '">' + v + '</div></div>';
  }
  function verdictBadge(v) {
    const label = v === 'PASS' ? '✅ 通过' : (v === 'WARNING' ? '⚠️ 警示' : (v === 'INSUFFICIENT_SAMPLE' ? '📉 样本不足' : '⛔ 否决'));
    return '<span class="bt-verdict ' + v + '">' + label + ' · ' + v + '</span>';
  }
  function num(x, d) { return (x == null || isNaN(x)) ? '-' : (typeof x === 'number' ? x.toFixed(d == null ? 2 : d) : x); }

  // 5 大类中文名（与 lib/strategyGenerator.js CATEGORY_NAMES 对齐）
  const CAT_NAMES = { trend: '趋势跟踪', mean_reversion: '均值回归', momentum: '动量/轮动', value: '价值/基本面', event: '事件驱动', other: '其他' };
  const CAT_ORDER = ['trend', 'mean_reversion', 'momentum', 'value', 'event'];

  // 解析「当前个股」：优先 app.js 传入，其次全局 App 当前状态，再次 URL ?symbol=
  function resolveSymbol() {
    if (!current.symbol) {
      try {
        if (typeof App !== 'undefined' && App.currentSymbol) {
          current.symbol = App.currentSymbol;
          if (!current.name && App.currentData && App.currentData.name) current.name = App.currentData.name;
        }
      } catch (e) { /* ignore */ }
    }
    if (!current.symbol) {
      try {
        const p = new URLSearchParams(location.search).get('symbol');
        if (p) current.symbol = p;
      } catch (e) { /* ignore */ }
    }
    return current.symbol;
  }

  function refreshStockLabel() {
    const lab = el('btCurrentStock');
    if (!lab) return;
    if (current.symbol) {
      lab.textContent = '当前个股：' + current.symbol + (current.name ? '（' + current.name + '）' : '');
      lab.className = 'bt-current ok';
    } else {
      lab.textContent = '当前个股：未选择（请先在左侧搜索并打开一只股票）';
      lab.className = 'bt-current err';
    }
  }

  // 由 app.js 在切换 Tab / 切换个股时调用
  function open(symbol, name) {
    let symbolChanged = false;
    if (symbol && symbol !== current.symbol) { current.symbol = symbol; symbolChanged = true; }
    if (name) current.name = name;
    resolveSymbol();
    refreshStockLabel();
    const status = el('btStatus');
    if (status) { status.textContent = ''; status.className = 'bt-status'; }
    // 修复「策略页不随个股切换」：个股变化（切股 / 切到新个股 Tab）时清掉旧结果并自动重算
    if (symbol && symbol !== lastRenderedSymbol) {
      const r = el('btResult');
      if (r) r.innerHTML = '<div class="bt-section"><div class="bt-advice">已切换至 ' + escapeHtml(symbol) + (current.name ? '（' + escapeHtml(current.name) + '）' : '') + '，正在自动生成策略…</div></div>';
      runAuto();
    }
  }

  async function run() {
    const btn = el('btRun'), status = el('btStatus'), result = el('btResult');
    if (!resolveSymbol()) {
      refreshStockLabel();
      status.textContent = '请先在左侧搜索并打开一只股票';
      status.className = 'bt-status err';
      return;
    }
    const dslText = (el('btDsl').value || '') + '\nRANGE: ' + el('btRange').value;
    btn.disabled = true;
    status.textContent = '校验中…';
    status.className = 'bt-status';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      const resp = await fetch('/api/backtest-validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: current.symbol, name: current.name, dsl: dslText }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || '校验失败');
      render(data);
      status.textContent = '校验完成';
      status.className = 'bt-status ok';
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? '请求超时（>60秒）' : (e && e.message);
      status.textContent = '错误：' + msg;
      status.className = 'bt-status err';
      if (result) result.innerHTML = '<div class="bt-section"><div class="bt-advice">' + escapeHtml(msg) + '</div></div>';
    } finally {
      btn.disabled = false;
    }
  }

  function render(data) {
    const r = el('btResult');
    if (!r) return;
    const bi = data.base_info || {};
    const raw = data.raw_backtest_result || {};
    const full = raw.full || {}; const train = raw.train || {}; const test = raw.test || {};
    const risk = data.risk_check_result || {};
    const adj = data.adjusted_result || {};
    const op = data.operation_suggestion || {};
    const diag = data.diagnostics || {};
    const co = risk.cointegration;

    let html = '';

    // ① 基础信息
    html += '<div class="bt-section"><h3>① 基础信息</h3><div class="bt-grid">'
      + metricCard('标的', bi.symbol || '-')
      + metricCard('策略', bi.strategy_name || bi.strategy_type || '-')
      + metricCard('区间', bi.range || '-')
      + metricCard('数据点', bi.data_points || 0)
      + metricCard('单边成本', (bi.cost_per_side != null ? (bi.cost_per_side * 100).toFixed(2) : '-') + '%')
      + metricCard('数据契约', '前复权 qfq')
      + '</div><div class="bt-note">' + (bi.contract && bi.contract.note ? bi.contract.note : '') + '</div></div>';

    // ①b 若输入是大白话中文 → 展示确定性翻译出的规则（透明、可复核）
    if (bi.derived_from === 'natural_language') {
      html += '<div class="bt-section"><h3>🧠 你的中文描述已翻译为规则</h3>'
        + '<div class="bt-dsl">买：' + escapeHtml(bi.derived_buy || '') + '<br>卖：' + escapeHtml(bi.derived_sell || '') + '</div>'
        + ((bi.derived_notes && bi.derived_notes.length) ? '<div class="bt-note">' + bi.derived_notes.map(escapeHtml).join('<br>') + '</div>' : '')
        + '</div>';
    }

    // ② 原始虚拟回测
    html += '<div class="bt-section"><h3>② 原始虚拟回测（T+1 · 含成本）</h3><div class="bt-grid">'
      + metricCard('全样本胜率', fmtPct(full.winRate || 0), cls((full.winRate || 0) - 0.5))
      + metricCard('全样本交易数', full.totalTrades || 0)
      + metricCard('全样本收益', (full.totalReturn * 100).toFixed(1) + '%', cls(full.totalReturn))
      + metricCard('买入持有', (full.buyHold * 100).toFixed(1) + '%', cls(full.buyHold))
      + metricCard('最大回撤', (full.maxDrawdown * 100).toFixed(1) + '%')
      + metricCard('夏普', num(full.sharpe))
      + '</div><div class="bt-note">训练集胜率 ' + fmtPct(train.winRate || 0) + '（' + (train.totalTrades || 0) + '笔） ｜ 测试集胜率 '
      + fmtPct(test.winRate || 0) + '（' + (test.totalTrades || 0) + '笔）｜ 训练/测试拆分 ' + ((bi.train_ratio * 100).toFixed(0)) + '%</div></div>';

    // ③ 统计检验
    const adfP = risk.adf_price || {}, adfR = risk.adf_return || {}, kp = risk.kpss_price || {};
    html += '<div class="bt-section"><h3>③ 统计检验（风险校验）</h3>'
      + '<table class="bt-table"><thead><tr><th>检验</th><th>统计量</th><th>临界值(p5)</th><th>结论</th></tr></thead><tbody>'
      + '<tr><td>ADF 价格</td><td>' + num(adfP.stat) + '</td><td>' + (adfP.critical ? adfP.critical.p5 : '-') + '</td><td>' + (adfP.stationary ? '平稳' : '非平稳') + '</td></tr>'
      + '<tr><td>ADF 收益率</td><td>' + num(adfR.stat) + '</td><td>' + (adfR.critical ? adfR.critical.p5 : '-') + '</td><td>' + (adfR.stationary ? '平稳' : '非平稳') + '</td></tr>'
      + '<tr><td>KPSS 价格</td><td>' + num(kp.stat) + '</td><td>' + (kp.critical ? kp.critical.p5 : '-') + '</td><td>' + (kp.stationary ? '平稳' : '非平稳') + '</td></tr>'
      + (co ? '<tr><td>协整(EG)</td><td>' + num(co.stat) + '</td><td>' + (co.critical ? co.critical.p5 : '-') + '</td><td>' + (co.cointegrated ? '协整' : '不协整') + '</td></tr>' : '')
      + '</tbody></table>'
      + '<div class="bt-note">ACF(1)=' + (risk.acf ? risk.acf.lag1 : '-') + ' ｜ PACF(lag1-5)=' + (risk.pacf_lag1_5 ? risk.pacf_lag1_5.join(', ') : '-') + ' ｜ ' + (risk.notes || []).join('；') + '</div></div>';

    // ④ 五大胜率修正
    const steps = (adj.corrections || []).map(s =>
      '<tr><td>' + s.name + '</td><td class="factor">×' + (s.factor * 100).toFixed(1) + '%</td><td>' + s.note + '</td></tr>'
    ).join('');
    html += '<div class="bt-section"><h3>④ 五大胜率修正</h3>'
      + '<table class="bt-table"><thead><tr><th>步骤</th><th>系数</th><th>说明</th></tr></thead><tbody>' + steps + '</tbody></table>'
      + '<div class="bt-grid" style="margin-top:12px">'
      + metricCard('修正后胜率', fmtPct(adj.adjusted_win_rate || 0), cls((adj.adjusted_win_rate || 0) - 0.5))
      + metricCard('修正后收益', (adj.adjusted_return * 100).toFixed(1) + '%', cls(adj.adjusted_return))
      + '</div>'
      + renderSurvivorshipEvidence(adj.survivorship_evidence)
      + '</div>';

    // ④b 风控出场 & 分批建仓（仅在策略启用了这些能力时展示）
    html += renderRiskExit(data);

    // ⑤ 操作建议
    html += '<div class="bt-section"><h3>⑤ 操作建议</h3>'
      + verdictBadge(op.verdict)
      + '<div class="bt-advice">' + (op.advice || '') + '</div>'
      + '<div class="bt-diag">信号日（买/卖）：' + (diag.buy_signal_days || 0) + ' / ' + (diag.sell_signal_days || 0) + ' ｜ ' + (diag.note || '') + '</div></div>';

    r.innerHTML = html;
    lastRenderedSymbol = current.symbol;
  }

  // —— 幸存者偏差证据块（真实 F10 上市状态）——
  // 系数来源三档：f10_evidence（有证据）/ caller（调用方指定）/ default（无证据，保底 0.9）
  function renderSurvivorshipEvidence(ev) {
    if (!ev) return '';
    const basisLabel = {
      f10_evidence: '真实 F10 证据',
      caller: '调用方指定',
      default: '默认保底（无证据）',
    }[ev.basis] || ev.basis;
    const tone = ev.basis === 'f10_evidence' ? 'bt-sv-ok' : (ev.basis === 'default' ? 'bt-sv-warn' : '');
    let h = '<div class="bt-evidence ' + tone + '">'
      + '<div class="bt-ev-title">🏛 幸存者偏差依据：<b>' + basisLabel + '</b> （系数 ×' + ev.factor + '）</div>'
      + '<div class="bt-ev-body">' + (ev.note || '') + '</div>';
    if (ev.stHistory && ev.stHistory.length) {
      h += '<div class="bt-ev-body">风险警示历史：' + ev.stHistory.join(' → ') + '</div>';
    }
    if (ev.listingDate) {
      h += '<div class="bt-ev-body">上市日期：' + String(ev.listingDate).slice(0, 10)
        + (ev.listingYears != null ? '（约 ' + ev.listingYears + ' 年）' : '')
        + (ev.isNewListing ? ' ⚠ 上市未满 3 年，回测样本天然偏短' : '') + '</div>';
    }
    if (ev.source) h += '<div class="bt-ev-src">来源：' + ev.source + '</div>';
    h += '</div>';
    return h;
  }

  // —— 风控出场 & 分批建仓展示 ——
  // 只有策略真的启用了（回测结果里带 riskExit / trancheInfo）才渲染，避免默认路径出现空块
  function renderRiskExit(data) {
    const rb = (data.raw_backtest_result && data.raw_backtest_result.full) || {};
    const re = rb.riskExit;
    const ti = rb.trancheInfo;
    if (!re && !ti) return '';
    let h = '<div class="bt-section"><h3>🛡 风控出场与仓位管理</h3>';
    if (re) {
      const rows = [];
      if (re.stopLoss != null) rows.push(['固定止损', (re.stopLoss * 100).toFixed(1) + '%', re.stopLossCount + ' 次触发']);
      if (re.takeProfit != null) rows.push(['固定止盈', (re.takeProfit * 100).toFixed(1) + '%', re.takeProfitCount + ' 次触发']);
      if (re.trailing != null) rows.push(['移动止盈', (re.trailing * 100).toFixed(1) + '%', re.trailingCount + ' 次触发']);
      if (rows.length) {
        h += '<table class="bt-table"><thead><tr><th>规则</th><th>阈值</th><th>触发次数</th></tr></thead><tbody>'
          + rows.map(r => '<tr><td>' + r[0] + '</td><td class="factor">' + r[1] + '</td><td>' + r[2] + '</td></tr>').join('')
          + '</tbody></table>';
      } else {
        h += '<div class="bt-diag">已启用风控出场，但样本期内未触发。</div>';
      }
    }
    if (ti) {
      h += '<div class="bt-diag" style="margin-top:8px">建仓方式：等分 <b>' + ti.tranches + '</b> 批'
        + (ti.trancheGap > 1 ? '（每批间隔 ' + ti.trancheGap + ' 个交易日）' : '（连续信号日依次建仓）') + '</div>';
    }
    h += '</div>';
    return h;
  }

  // —— 自动策略生成流程（无需用户 DSL）——
  async function runAuto() {
    const btn = el('btAuto'), status = el('btStatus'), result = el('btResult');
    if (!resolveSymbol()) {
      refreshStockLabel();
      status.textContent = '请先在左侧搜索并打开一只股票';
      status.className = 'bt-status err';
      return;
    }
    btn.disabled = true;
    status.textContent = '正在分析当前个股并生成策略（取历史数据 → 枚举候选 → 回测 → 风控修正）…';
    status.className = 'bt-status';
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      const resp = await fetch('/api/auto-strategy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: current.symbol, name: current.name, range: el('btRange').value }),
        signal: controller.signal
      });
      clearTimeout(timer);
      const data = await resp.json();
      if (!data.success) throw new Error(data.error || '生成失败');
      renderAuto(data);
      status.textContent = '自动策略生成完成';
      status.className = 'bt-status ok';
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? '请求超时（>120秒）' : '错误：' + (e && e.message);
      status.textContent = msg;
      status.className = 'bt-status err';
      if (result) result.innerHTML = '<div class="bt-section"><div class="bt-advice">' + msg + '</div></div>';
    } finally {
      btn.disabled = false;
    }
  }

  function renderAuto(data) {
    const r = el('btResult');
    if (!r) return;
    const bi = data.base_info || {};
    const mc = data.market_context || {};
    const ps = data.parameter_sensitivity || {};
    const ranked = data.ranked_strategies || [];
    const best = data.best_strategy;
    const adv = data.operation_advice || {};
    let html = '';

    // 头部：市场语境（平稳性闸门依据）
    html += '<div class="bt-section"><h3>🌐 市场语境（数据特征）</h3><div class="bt-grid">'
      + metricCard('价格 ADF', (mc.adf_price ? (mc.adf_price.stationary ? '平稳' : '非平稳') : '-'), mc.adf_price && mc.adf_price.stationary ? '' : 'down')
      + metricCard('收益率 ADF', (mc.adf_return ? (mc.adf_return.stationary ? '平稳' : '非平稳') : '-'), mc.adf_return && mc.adf_return.stationary ? '' : 'down')
      + metricCard('趋势 R²', mc.trend ? mc.trend.r2 : '-', '')
      + metricCard('季节性', mc.seasonality && mc.seasonality.hasSeasonality ? '有' : '无', '')
      + metricCard('候选策略', bi.candidate_count || 0)
      + metricCard('有效/剔除', (bi.valid_count || 0) + ' / ' + (bi.insufficient_count || 0))
      + '</div>'
      + '<div class="bt-note">价格' + (mc.adf_price && mc.adf_price.stationary ? '平稳' : '非平稳') + ' → '
      + (mc.adf_price && !mc.adf_price.stationary ? '均值回归类须落于「平稳收益率」上（RET/ZSCORE 路径），否则按伪回归陷阱 ×0.5 折算。' : '可直接做趋势/回归。')
      + '</div></div>';

    // 参数敏感性（E 项）+ 逐候选可视化（P2-1）
    html += '<div class="bt-section"><h3>🎚️ 参数敏感性汇总</h3><div class="bt-grid">'
      + metricCard('候选数', ps.candidate_count || 0)
      + metricCard('修正胜率 最高', (ps.max != null ? (ps.max * 100).toFixed(1) + '%' : '-'))
      + metricCard('修正胜率 最低', (ps.min != null ? (ps.min * 100).toFixed(1) + '%' : '-'))
      + metricCard('离散度', (ps.spread != null ? (ps.spread * 100).toFixed(1) + 'pp' : '-'), ps.spread > 0.1 ? 'down' : '')
      + '</div>';
    const psList = ps.series || [];
    if (psList.length) {
      const mx = Math.max.apply(null, psList.map(s => s.adjusted_win_rate)) || 1;
      html += '<div class="bt-ps-bars">';
      psList.slice().sort((a, b) => b.adjusted_win_rate - a.adjusted_win_rate).forEach((s, i) => {
        const w = Math.max(2, Math.round(s.adjusted_win_rate / mx * 100));
        html += '<div class="bt-ps-row"><span class="bt-ps-name">' + s.name + '</span>'
          + '<span class="bt-ps-track"><i class="' + (i === 0 ? 'bt-ps-top' : '') + '" style="width:' + w + '%"></i></span>'
          + '<span class="bt-ps-val">' + (s.adjusted_win_rate * 100).toFixed(1) + '%</span></div>';
      });
      html += '</div>';
    }
    html += '<div class="bt-note">' + (ps.note || '') + '</div></div>';

    // P1-3 多重检验校正（BH）
    const mt = data.multiple_testing;
    if (mt) {
      html += '<div class="bt-section"><h3>🔬 多重检验校正</h3><div class="bt-grid">'
        + metricCard('候选家族数', mt.family_size)
        + metricCard('最优原始 p', mt.best_raw_p)
        + metricCard('校正后 p', mt.best_adjusted_p, mt.best_significant ? '' : 'down')
        + metricCard('是否显著', mt.best_significant ? '显著' : '不显著')
        + '</div><div class="bt-note">' + (mt.note || '') + '</div></div>';
    }

    // 最优策略
    if (best) {
      html += '<div class="bt-section"><h3>🏆 最优策略：' + best.name + '</h3>'
        + '<span class="bt-verdict ' + best.verdict + '">' + verdictBadgeText(best.verdict) + '</span>'
        + '<div class="bt-grid" style="margin-top:10px">'
        + metricCard('修正后胜率', (best.adjusted_win_rate * 100).toFixed(1) + '%', cls(best.adjusted_win_rate - 0.5))
        + metricCard('原始胜率', (best.raw.winRate * 100).toFixed(1) + '%', cls(best.raw.winRate - 0.5))
        + metricCard('交易笔数', best.raw.trades)
        + metricCard('样本外一致性', (best.walk_forward ? (best.walk_forward.consistency * 100).toFixed(0) + '%' : '-'), best.walk_forward && best.walk_forward.consistency < 0.8 ? 'down' : '')
        + metricCard('类别', CAT_NAMES[best.category] || best.cls)
        + '</div>'
        + '<div class="bt-dsl">买：' + best.dsl.buy + '<br>卖：' + best.dsl.sell + '</div>'
        + (best.warnings && best.warnings.length ? '<div class="bt-warn">' + best.warnings.map(w => '⚠ ' + w).join('<br>') + '</div>' : '')
        + '</div>';
    }

    // 排名列表（按 5 大类分组）
    html += '<div class="bt-section"><h3>📊 候选策略排名（按 5 大类分组）</h3>';
    const catsAll = Object.keys(data.category_summary || {});
    const orderedCats = CAT_ORDER.filter(c => catsAll.indexOf(c) >= 0).concat(catsAll.filter(c => CAT_ORDER.indexOf(c) < 0));
    const byCat = {};
    ranked.forEach(s => { (byCat[s.category] = byCat[s.category] || []).push(s); });
    orderedCats.forEach(cat => {
      const sum = (data.category_summary || {})[cat] || { valid: 0, insufficient: 0 };
      const list = byCat[cat] || [];
      html += '<div class="bt-cat"><div class="bt-cat-h">'
        + '<span class="bt-cat-name">' + (CAT_NAMES[cat] || cat) + '</span>'
        + '<span class="bt-cat-meta">有效 ' + (sum.valid || 0) + ' · 剔除 ' + (sum.insufficient || 0) + '</span></div>';
      if (list.length) {
        html += '<table class="bt-table"><thead><tr>'
          + '<th>策略</th><th>原始胜率</th><th>修正胜率</th><th>交易</th><th>walk-forward</th><th>结论</th></tr></thead><tbody>';
        list.forEach(s => {
          html += '<tr' + (s.key === (best && best.key) ? ' class="bt-best-row"' : '') + '>'
            + '<td>' + s.name + '</td>'
            + '<td>' + fmtPct(s.raw.winRate) + '</td>'
            + '<td>' + fmtPct(s.adjusted_win_rate) + '</td>'
            + '<td>' + s.raw.trades + '</td>'
            + '<td>' + (s.walk_forward ? (s.walk_forward.consistency * 100).toFixed(0) + '%' : '-') + '</td>'
            + '<td>' + verdictBadgeText(s.verdict) + '</td></tr>';
        });
        html += '</tbody></table>';
      } else {
        html += '<div class="bt-note">该类别下无有效策略</div>';
      }
      html += '</div>';
    });
    html += '</div>';

    // 数据备注（跨模块数据获取情况：价值/事件 数据缺失时说明跳过）
    const dn = data.data_notes || {};
    const dnLabel = { value: '价值/基本面', event: '事件驱动' };
    const dnLines = Object.keys(dn).map(k => (dnLabel[k] || k) + '：' + dn[k]);
    if (dnLines.length) {
      html += '<div class="bt-section"><h3>📎 数据备注</h3>' + dnLines.map(t => '<div class="bt-note">' + t + '</div>').join('') + '</div>';
    }

    // 未触发 / 已剔除策略（含原因，按类别列示）
    const ins = data.insufficient_strategies || [];
    if (ins.length) {
      html += '<div class="bt-section"><h3>🚫 未触发 / 已剔除（' + ins.length + ' 套）</h3>'
        + '<table class="bt-table"><thead><tr><th>策略</th><th>类别</th><th>交易笔数</th><th>原因</th></tr></thead><tbody>';
      ins.forEach(s => {
        html += '<tr><td>' + s.name + '</td><td>' + (CAT_NAMES[s.category] || s.category || '-') + '</td><td>' + (s.trades != null ? s.trades : '-') + '</td><td>' + (s.reason || '-') + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }

    // 操作建议（LLM 叙事 + 确定性兜底）
    html += '<div class="bt-section"><h3>💡 操作建议</h3>'
      + verdictBadge(adv.verdict)
      + '<div class="bt-advice">' + (adv.narrative || '') + '</div>'
      + (adv.deterministic ? '<div class="bt-note">（以上为确定性规则生成的文字；配置 AI 密钥后可获得更口语化的解读）</div>' : '')
      // 20261016b（审计 ST1）：披露派生策略来源，避免「全部由代码确定性计算」被误读为「每套策略都是独立的第三方信号」。
      + '<div class="bt-note">ℹ️ 策略来源披露：「趋势跟踪·短期行情判定（技术核心）」为派生策略，复用工作台自身的行情判定结论（priceAction.shortTerm.direction），把同一套技术内核回算成历史买卖信号，属工作台内部联动，非外部 AI / 第三方信号源；其余策略由本页独立计算，不依赖行情判定输出。</div>'
      + '</div>';

    r.innerHTML = html;
    lastRenderedSymbol = current.symbol;
  }

  function verdictBadgeText(v) {
    return v === 'PASS' ? '✅ 通过' : (v === 'WARNING' ? '⚠️ 警示' : (v === 'INSUFFICIENT_SAMPLE' ? '📉 样本不足' : '⛔ 否决'));
  }

  function init() {
    const btn = el('btRun');
    if (btn && !btn.dataset.btWired) {
      btn.dataset.btWired = '1';
      btn.addEventListener('click', run);
    }
    const auto = el('btAuto');
    if (auto && !auto.dataset.btWired) {
      auto.dataset.btWired = '1';
      auto.addEventListener('click', runAuto);
    }
    // 高级框「一键模板」按钮：点击把合法 DSL 填入文本框
    const pc = el('btPresets');
    if (pc && !pc.dataset.btWired) {
      pc.dataset.btWired = '1';
      PRESETS.forEach(function (p) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'bt-preset';
        b.textContent = p.label;
        b.addEventListener('click', function () {
          const ta = el('btDsl');
          if (ta) { ta.value = p.dsl; ta.focus(); }
        });
        pc.appendChild(b);
      });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { open: open, run: run, render: render };
})();

~~~
