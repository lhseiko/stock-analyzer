/**
 * Main Application Logic
 */

// 关键指标释义（点击指标标签后的「?」图标展示）
const METRIC_HELP = {
  '市盈率(PE)': { title: '市盈率 PE', body: '市盈率 = 股价 ÷ 每股收益，表示按当前盈利多少年回本。<br>· 越低通常越便宜，但过低可能反映市场对其增长预期差；<br>· 不同行业不可直接比，成长股 PE 天然偏高。' },
  '市净率(PB)': { title: '市净率 PB', body: '市净率 = 股价 ÷ 每股净资产，反映股价相对账面资产的溢价。<br>· PB&lt;1（破净）可能低估，但也可能是资产质量差；<br>· 银行、地产等重资产行业常用 PB 估值。' },
  '市销率(PS)': { title: '市销率 PS', body: '市销率 = 市值 ÷ 营业收入，适合尚未盈利的成长型公司。<br>· 看"收入规模"与估值的匹配度；<br>· PS 低不代表便宜，需结合利润率看。' },
  'PEG': { title: 'PEG', body: 'PEG = 市盈率 PE ÷（盈利增长率×100）。<br>· PEG≈1 表示估值与成长性匹配；<br>· &lt;1 可能被低估，&gt;1 可能偏贵（仅适用于正增长公司）。' },
  'ROE': { title: '净资产收益率 ROE', body: 'ROE = 净利润 ÷ 净资产，衡量用股东投入赚钱的能力。<br>· 长期 ROE&gt;15% 是优质公司的标志；<br>· 但过高的 ROE 也可能来自高杠杆（债务），需结合资债比看。' },
  '毛利率': { title: '毛利率', body: '毛利率 =（营业收入 − 营业成本）÷ 营业收入。<br>· 反映产品竞争力与定价权，越高越能抵御成本上涨；<br>· 茅台式高毛利代表强品牌护城河。' },
  '净利率': { title: '净利率', body: '净利率 = 净利润 ÷ 营业收入，扣除税费、利息、费用后的真实盈利能力。<br>· 比毛利率更综合，受费用率、减值等影响。' },
  '营收增长': { title: '营收增长', body: '同期营业收入同比增速（YoY）。<br>· 反映业务扩张速度，&gt;15% 通常视为高成长；<br>· 负增长一般偏利空（金融/周期类需结合行业阶段看）。' },
  '利润增长': { title: '利润增长', body: '同期净利润同比增速（YoY）。<br>· 比营收增长更关键，需警惕"增收不增利"。' },
  '资产负债率': { title: '资产负债率 · 信号算法详解', body: '<b>一、取数来源（两个口径，已自动识别）</b><br>· <b>A 股</b>：取东方财富 F10 资产负债表「资产负债率 ZCFZL」，单位是 <b>%</b>（如 89.88 表示 89.88%）。本工具已加 <code>debtMetricPct</code> 标记；<br>· <b>港股 / 美股</b>：取「带息债 ÷ 所有者权益」<b>比值</b>（无单位小数，如 0.27）。<br><br><b>二、信号判定步骤（evaluateSignals）</b><br>第 1 步：读取数值 d = 资产负债率（A股用% / 港股美股用比值）；<br>第 2 步：判断是否金融业（银行/保险/证券等）→ 直接判 <b>中性</b>（高负债是经营常态，不红不绿）；<br>第 3 步：非金融业，按口径分档：<br>&nbsp;&nbsp;▸ A股（%）：<b>＞70%</b> → 利空(绿)；<b>＜40%</b> → 利好(红)；40%~70% 合理区间不提示；<br>&nbsp;&nbsp;▸ 港股/美股（比值）：<b>＞2</b> → 利空(绿)；<b>＜0.5</b> → 利好(红)；中间不提示。<br><br><b>三、健康评分里的算法（fundamentalAnalysis）</b><br>同口径分档累加（满分 25 再按权重缩放）：A股 资产负债率 ＜40% 加12、40%~70% 加9、70%~90% 加5、＞90% 不加分；金融业 80%~96% 视为正常加10。<br><br><b>四、颜色与边界</b><br>红=利好、绿=利空，仅适用于<b>非金融</b>公司；金融业一律中性。例：中国平安 89.88%→中性；贵州茅台（A股，约 20%出头）→利好(红)。' },
  '流动比率': { title: '流动比率', body: '流动比率 = 流动资产 ÷ 流动负债，衡量短期偿债能力。<br>· &gt;2 较安全，&lt;1 可能短期资金紧张；<br>· 不同行业合理区间差异大（如零售天然较低）。' },
  '股息率': { title: '股息率', body: '股息率 = 每股分红 ÷ 股价（年化）。<br>· 红利型公司（银行、电力、煤炭等）看重此指标；<br>· 高股息率通常偏利好，但需警惕"分红不可持续"。' },
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
    this.renderHistory();
    // Initialize notes (投资心得 / 大盘记录 / 个股亮点雷点)
    if (typeof Notes !== 'undefined') {
      Notes.init();
    }
    // 深度分析折叠分组（仅执行一次，重组 #deepContent 内的卡片）
    this.initDeepGroups();
    // 首页实时大盘概览
    this.loadMarketOverview();
    // 首页·大盘估值趋势（上证50 / 沪深300 / 科创50 近5年PE-TTM）
    this.loadIndexPeTrend();
    // 首页·大盘技术分析（上证/深证/创业板指 六步技术面推演）
    this.loadMarketTechnical();
    // 顶栏大盘行情状态栏（上证/深证/创业板/科创50/北证50/恒生/纳斯达克/道琼斯）
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
      marketAIBtn.addEventListener('click', () => this.loadMarketAI(true));
    }
    const indexPeTrendRefresh = document.getElementById('indexPeTrendRefresh');
    if (indexPeTrendRefresh) {
      indexPeTrendRefresh.addEventListener('click', () => this.loadIndexPeTrend());
    }
    const marketTechnicalRefresh = document.getElementById('marketTechnicalRefresh');
    if (marketTechnicalRefresh) {
      marketTechnicalRefresh.addEventListener('click', () => this.loadMarketTechnical(true));
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
    const aiHolderBtn = document.getElementById('aiHolderBtn');
    if (aiHolderBtn) aiHolderBtn.addEventListener('click', () => this.loadAIHolders(true, this._aiHolderMode || 'web'));
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

    // Range buttons
    document.querySelectorAll('.range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentRange = btn.dataset.range;
        if (this.currentSymbol) this.analyze(this.currentSymbol, this.currentData?.name);
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
      if (this.currentSymbol) this.analyze(this.currentSymbol, this.currentData?.name);
    });
    const productsAiBtn = document.getElementById('productsAiBtn');
    if (productsAiBtn) productsAiBtn.addEventListener('click', () => this.loadProducts(true));
    const productsRefresh = document.getElementById('productsRefresh');
    if (productsRefresh) productsRefresh.addEventListener('click', () => this.loadProducts(true));
    const companyIntroAiBtn = document.getElementById('companyIntroAiBtn');
    if (companyIntroAiBtn) companyIntroAiBtn.addEventListener('click', () => this.loadCompanyIntro(true));
    const companyIntroRefresh = document.getElementById('companyIntroRefresh');
    if (companyIntroRefresh) companyIntroRefresh.addEventListener('click', () => this.loadCompanyIntro(true));
    const supplyChainAiBtn = document.getElementById('supplyChainAiBtn');
    if (supplyChainAiBtn) supplyChainAiBtn.addEventListener('click', () => this.loadSupplyChain(true));
    const supplyChainRefresh = document.getElementById('supplyChainRefresh');
    if (supplyChainRefresh) supplyChainRefresh.addEventListener('click', () => this.loadSupplyChain(true));
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
    if (homeTpRefresh) homeTpRefresh.addEventListener('click', () => {
      this.loadSentimentTurningPoint(true);
    });

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
      <div class="search-result-item" data-symbol="${r.symbol || r.code}" data-name="${r.name}">
        <div>
          <div class="name">${r.name}</div>
          <div class="code">${r.code || r.symbol}</div>
        </div>
        <span class="market-tag">${r.market || ''}</span>
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
    // 数字键切换周期：1日K 2周K 3月K 4=60分钟
    if (!isTyping && /^[1-4]$/.test(e.key)) {
      const periods = ['daily', 'weekly', 'monthly', '60m'];
      const p = periods[parseInt(e.key, 10) - 1];
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

  async analyze(symbol, name = '') {
    // 请求令牌：每次调用自增；后续若用户切换到别的股票/再触发分析，
    // 旧请求的返回值会被丢弃，避免"慢的旧请求覆盖快的新请求"或闪烁。
    const token = (this._reqToken = (this._reqToken || 0) + 1);
    this.currentSymbol = symbol;
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
    // Update DocStore stock info
    DocStore.setStock(symbol, name);
    DeepCharts.disposeAll();
    this.showLoading('正在获取股票数据...');

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
      } else if (activeTab === 'journal') {
        if (typeof Notes !== 'undefined') Notes.renderStock(this.currentSymbol, this.currentData?.name);
      } else if (activeTab === 'docs') {
        if (typeof DocStore !== 'undefined') DocStore.onTabSwitch();
      }
    } catch (e) {
      if (token !== this._reqToken) return; // 过期请求，不弹错误、不干扰新请求
      this.hideLoading();
      this.showErrorBanner('获取数据失败: ' + e.message, () => this.analyze(symbol, name));
      console.error(e);
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
    this.renderKeyMetrics(data);
    this.renderScores(data);
    this.renderOverview(data);
    this.renderTechnical(data);
    this.renderFundamental(data);
    this.renderSignals(data);

    // 缓存中栏图表所需的日K历史 + 技术指标（周期切换 / 指标 Tab 切换复用）
    this.dailyHistory = data.history || [];
    this.dailyTechnical = data.technical || null;
    // 切换股票后清空 60分钟缓存，避免串股
    this.history60m = [];
    this.technical60m = null;
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
      note.innerHTML = `${data.denominatorNote || ''}${data.note ? '；' + data.note : ''}｜来源：${data.source || '同花顺'}｜口径：板块成交额 ÷ 全市场成交额 ×100%`;
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

  // 首页情绪拐点完整面板（不含个股敏感度）
  renderHomeTpPanel(data, symbol) {
    // 若用户已离开首页，丢弃旧请求
    const empty = document.getElementById('emptyState');
    if (empty && empty.classList.contains('hidden')) return;
    this._renderTpPanelInto({ panelId: 'homeSentimentPanel', bodyId: 'homeSentimentBody', updatedId: 'homeSentimentUpdated' }, data, symbol, { guardSymbol: false, hideSensitivity: true });
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
        const sigCls = sig > 0.03 ? 'tp-sig-bull' : sig < -0.03 ? 'tp-sig-bear' : 'tp-sig-flat';
        const signTxt = (sig >= 0 ? '+' : '') + sig.toFixed(2);
        html += `<div class="tp-comp">`;
        html += `<div class="tp-comp-label">${c.label}<span class="tp-comp-w">占${c.weight != null ? (c.weight * 100).toFixed(0) : '—'}%</span></div>`;
        html += `<div class="tp-comp-sig ${sigCls}">${signTxt}</div>`;
        html += `<div class="tp-comp-value">${c.value || ''}</div>`;
        html += `<div class="tp-comp-detail">${c.detail || ''}</div>`;
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

  // 影响程度评分徽章：红=利好 / 绿=利空 / 灰=中性，±3 为最强（因子旁显式标注）
  _impactBadge(f) {
    const s = (typeof f === 'number') ? f : this._impactOf(f);
    const cls = s > 0 ? 'pos' : s < 0 ? 'neg' : 'neu';
    const label = s > 0 ? '利好' : s < 0 ? '利空' : '中性';
    const sign = s > 0 ? '+' : '';
    return `<span class="sd-impact ${cls}" title="影响程度评分：${label} ${sign}${s}（±3 为最强；红=利好，绿=利空）">${label} ${sign}${s}</span>`;
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
        return `<div class="sd-sub-card">
          <div class="sd-sub-head">
            <span class="sd-dot ${signCls}"></span>
            <span class="sd-sub-name">${this._escapeHtml(sf.name)}</span>
            ${badge}
          </div>
          <div class="sd-sub-value ${signCls}">${this._escapeHtml(String(sf.value || '—'))}</div>
          <div class="sd-sub-detail">${this._escapeHtml(sf.detail || '')}</div>
        </div>`;
      }).join('');
      return `<div class="sd-sub-grid">${cards}</div>`;
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
    const FACTOR_ORDER = { sentiment: 0, capital: 1, futures: 2, market: 3, holdings: 4, sectorLimit: 5, seesaw: 6, technicalShort: 7 };
    const sorted = all.slice().sort((a, b) => {
      const oa = (FACTOR_ORDER[a.key] != null) ? FACTOR_ORDER[a.key] : 999;
      const ob = (FACTOR_ORDER[b.key] != null) ? FACTOR_ORDER[b.key] : 999;
      if (oa !== ob) return oa - ob;
      return Math.abs(b.contribution || 0) - Math.abs(a.contribution || 0);
    });
    const rows = sorted.map((f, i) => {
      // 颜色由影响程度评分统一决定（与徽章同源）；条形方向仍按贡献分符号（左右分侧）
      const signCls = this._impactCls(f);
      const contrib = (f.contribution >= 0 ? '+' : '') + ((f.contribution || 0) * 100).toFixed(2);
      const pct = Math.min(50, Math.abs(f.contribution || 0) / maxAbs * 50); // 双向条：从中线向两侧延伸
      const barStyle = f.contribution >= 0 ? `left:50%;width:${pct}%` : `left:${50 - pct}%;width:${pct}%`;
      const hidden = i >= topN ? ' is-hidden' : '';
      return `<div class="sd-factor-row${hidden}">
        <button class="sd-factor-toggle" type="button" aria-expanded="false">
          <span class="sd-dot ${signCls}"></span>
          <span class="sd-factor-name">${this._factorNameHtml(f)}</span>
          ${this._impactBadge(f)}
          <span class="sd-bar-track"><span class="sd-bar ${signCls}" style="${barStyle}"></span></span>
          <span class="sd-factor-w">权重 ${Math.round((f.effectiveWeight || 0) * 100)}%</span>
          <span class="sd-factor-contrib ${signCls}">${contrib}</span>
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
      <div class="sd-weight-note">权重按当日可用因子自动归一化；对标期货不适用时不参与打分。</div>
      ${hist}
      <div class="sd-actions">
        <button class="ai-trigger-btn" id="samedayRefreshBtn" type="button">🔄 重新判断</button>
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
      const contrib = (f.contribution >= 0 ? '+' : '') + (f.contribution * 100).toFixed(2);
      return `<div class="sd-factor">
        <div class="sd-factor-head">
          <span class="sd-factor-name">${this._factorNameHtml(f)}</span>
          ${this._impactBadge(f)}
          <span class="sd-factor-signal ${signCls}">${arrow}</span>
          <span class="sd-factor-w">权重 ${(f.effectiveWeight * 100).toFixed(0)}%</span>
          <span class="sd-factor-contrib ${signCls}">贡献 ${contrib}</span>
        </div>
        <div class="sd-factor-detail">${this._escapeHtml(f.detail)}</div>
        <div class="sd-factor-val">取值：${this._escapeHtml(String(f.value))}</div>
      </div>`;
    }).join('');
    return `<div class="sd-logic-box">
      <div class="sd-logic-title">长期判断逻辑（${j.horizonLabel || '中长期'}：${j.dir === '涨' ? '看多' : j.dir === '跌' ? '看空' : '中性'}，综合分 ${j.score > 0 ? '+' : ''}${j.score}/100，置信度${j.confidence}）</div>
      ${rows}
      <div class="sd-weight-note">长期判断不核算准确率，每次打开工作台自动联网更新；对标期货不适用时不参与打分。</div>
      <div class="sd-actions">
        <button class="ai-trigger-btn" id="longtermRefreshBtn" type="button">🔄 重新分析</button>
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
        d.textContent = '点个股页「AI 生成亮点/雷点」';
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
      d.textContent = `来源：AI 联网生成${dt ? '（' + dt + '）' : ''}${latestLabel}`;
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
    let html = '';

    if (a.mode === 'priceChange') {
      // 模式一：当日异动归因（涨跌幅 ≥3%）
      const up = a.changePct > 0;
      const sign = up ? '+' : '';
      const cls = up ? 'ht-pc-up' : 'ht-pc-down';
      const src = Array.isArray(a.sources) && a.sources.length ? '参考来源：' + a.sources.map(s => this.escapeHtml(s)).join('、') : '';
      const cachedTag = a.cached ? '<span class="ht-cached">（今日已分析）</span>' : '';
      html += `<div class="ht-price-change ${cls}">`;
      html += `<div class="ht-pc-head">🔥 当日异动归因 <span class="ht-pc-pct">${sign}${a.changePct.toFixed(2)}%</span>${cachedTag}</div>`;
      html += `<div class="ht-pc-analysis">${this.escapeHtml(a.analysis || '')}</div>`;
      if (src) html += `<div class="ht-pc-sources">${src}</div>`;
      html += `</div>`;
    } else if (a.mode === 'trending') {
      // 模式二：网络热议话题（涨跌幅 <3%）
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
        body.innerHTML = '<div class="ai-empty">点击上方「✨ 一键补全」，让 AI 联网搜索 <b>' + this.escapeHtml(symbol) + '</b> 的近期资料（搜索一次后将长期留存，不再重复联网）。</div>';
      }
    } catch {
      body.innerHTML = '<div class="ai-empty">点击上方「✨ 一键补全」，让 AI 联网搜索 <b>' + this.escapeHtml(symbol) + '</b> 的近期资料。</div>';
    }
  },

  renderStockHeader(data) {
    const { quote, name, symbol, market } = data;

    document.getElementById('stockName').textContent = name;
    document.getElementById('stockCode').textContent = symbol;
    document.getElementById('stockMarket').textContent = this.marketLabel(market);

    if (quote) {
      const priceEl = document.getElementById('stockPrice');
      const changeEl = document.getElementById('stockChange');
      const dateEl = document.getElementById('stockDate');

      priceEl.textContent = quote.price ? (market === 'US' ? '$' : '¥') + Storage.formatNumber(quote.price) : '--';

      if (quote.changePct !== undefined) {
        const isUp = quote.change >= 0;
        changeEl.textContent = `${isUp ? '+' : ''}${Storage.formatNumber(quote.change)} (${Storage.formatPercent(quote.changePct)})`;
        changeEl.className = 'stock-change ' + (isUp ? 'up' : 'down') + this.boldClass(quote.changePct);
        priceEl.style.color = isUp ? 'var(--red)' : 'var(--green)';
      }

      // 标注行情日期，方便了解这是哪一天的股价
      if (dateEl) {
        const d = quote.date || '';
        dateEl.textContent = d ? (quote.time ? `${d} ${quote.time}` : d) : '—';
      }

      // 标注财务数据报告期：PE/PB 等所用的每股收益、每股净资产来自该报告期
      const finEl = document.getElementById('stockFinDate');
      if (finEl) {
        const rep = quote.fundamentals?.reportDate;
        const repPeriod = quote.fundamentals?.reportPeriod;
        if (rep) {
          finEl.textContent = repPeriod || rep;
          finEl.title = 'PE/PB 等估值指标所用的每股收益、每股净资产来自该报告期';
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

  renderKeyMetrics(data) {
    const { quote } = data;
    const container = document.getElementById('keyMetrics');
    const metrics = [];
    const f = quote?.fundamentals || {};
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
      if (quote.turnover) metrics.push({ label: '换手率', value: Storage.formatNumber(quote.turnover) + '%', source: priceSrc, sub: quoteSub, title: `换手率 · 来源：${priceSrc} · ${quoteSub}` });
      if (quote.amount) metrics.push({ label: '成交额', value: Storage.formatNumber(quote.amount), source: priceSrc, sub: quoteSub, title: `成交额 · 来源：${priceSrc} · ${quoteSub}` });
      if (quote.totalValue) metrics.push({ label: '总市值', value: Storage.formatNumber(quote.totalValue * (quote.totalValue < 100 ? 10000 : 1)) + (quote.totalValue < 100 ? '亿' : ''), source: priceSrc, sub: quoteSub, title: `总市值 · 来源：${priceSrc} · ${quoteSub}` });

      // Valuation / fundamental metrics (with type, source and report period)
      if (quote.pe) metrics.push({
        label: '市盈率(TTM)',
        value: Storage.formatNumber(quote.pe),
        source: f.peSource || '行情数据',
        sub: finLabel ? `股价 ${priceDate} · 财报 ${finLabel}` : `股价 ${priceDate}`,
        title: finLabel ? `PE(TTM) = 股价(${priceDate}) ÷ 近12个月每股收益(财报 ${finLabel}) · 来源：${f.peSource || '行情数据'}` : '市盈率 PE(TTM)'
      });
      if (quote.pb) metrics.push({
        label: '市净率(PB)',
        value: Storage.formatNumber(quote.pb),
        source: f.pbSource || '行情数据',
        sub: finLabel ? `股价 ${priceDate} · 财报 ${finLabel}` : `股价 ${priceDate}`,
        title: finLabel ? `PB = 股价(${priceDate}) ÷ 每股净资产(财报 ${finLabel}) · 来源：${f.pbSource || '行情数据'}` : '市净率 PB'
      });
      if (f.ps) metrics.push({
        label: '市销率(PS)',
        value: Storage.formatNumber(f.ps),
        source: f.psSource || '本地计算',
        sub: finLabel ? `总市值(行情 ${priceDate}) ÷ 营收(财报 ${finLabel})` : `总市值(行情 ${priceDate}) ÷ 营收`,
        title: finLabel ? `PS = 总市值(行情 ${priceDate}) ÷ 营业收入(财报 ${finLabel}) · 来源：${f.psSource || '本地计算'}` : '市销率 PS'
      });
      if (f.roe) metrics.push({
        label: '净资产收益率(ROE)',
        value: Storage.formatNumber(f.roe) + '%',
        source: f.roeSource || '财报数据',
        sub: finLabel ? `财报 ${finLabel}` : '',
        title: `ROE = 归母净利润 ÷ 净资产(财报 ${finLabel}) · 来源：${f.roeSource || '财报数据'}`
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

    // 公司概况（主要产品 / 客户 / 企业性质）—— 删除密集主营业务，替换为产品/客户简介+图
    this.renderCompanyProfile(data, this.productsData);

    // Candlestick chart
    if (history.length > 0) {
      Charts.candlestick('candlestickChart', history, technical);
    }

    // Radar chart
    if (fundamental?.scores) {
      Charts.radar('radarChart', fundamental);
    }

    // 期货关联走势面板（产品型公司，异步加载，不阻塞概览渲染）
    this.renderFuturesPanel(this.currentSymbol, data.name);

    // 概览内嵌入的三块 AI 分析：产品/客户、公司综合介绍、供应链与成本（仅读缓存，不自动联网）
    if (this.currentSymbol) {
      this.loadProducts(false);
      this.loadCompanyIntro(false);
      this.loadSupplyChain(false);
    }
  },

  // 公司概况卡片渲染（issue6）：突出主要产品、主要客户、企业性质
  renderCompanyProfile(data, products) {
    const el = document.getElementById('companyProfile');
    const badgeEl = document.getElementById('companyTypeBadge');
    if (!el) return;
    const profile = data.companyProfile || {};
    const ct = data.fundamental?.companyTypeName;
    if (badgeEl && ct) {
      badgeEl.textContent = ct;
      badgeEl.className = 'company-type-badge-inline';
    }

    const row = (label, value) => `
      <div class="cp-row">
        <span class="cp-label">${label}</span>
        <span class="cp-value">${value || '<span class="cp-empty">—</span>'}</span>
      </div>`;

    // 注：产品/客户的「图文详情」统一由概览内的「🛍️ 主要产品 & 客户」卡片（renderProducts）展示，
    // 公司概况卡此处不再重复展示「主要产品/主要客户」行——F10 常为空（无内容）且与下方卡片重复。

    el.innerHTML = `
      <div class="cp-grid">
        ${row('公司全称', profile.companyName)}
        ${row('企业性质', profile.ownership)}
        ${row('所属行业', profile.industry)}
        ${row('控股股东', profile.controllingShareholder)}
        ${row('总部地点', profile.province)}
      </div>
      ${profile.intro ? `<div class="cp-intro">${profile.intro}</div>` : ''}
      <div class="cp-source">来源：东方财富F10 · 公司基本资料</div>
    `;
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
    const token = this._reqToken;
    try {
      const resp = await fetch(`/api/price-action/${encodeURIComponent(symbol)}`);
      const data = await resp.json();
      if (token !== this._reqToken || this.currentSymbol !== symbol) return; // 已切到别的股票，丢弃过期结果
      if (!data || data.error || !data.success) {
        this._renderPaError(data?.error || '价格行为推演数据获取失败');
        return;
      }
      this.paData = data;
      this.paLoadedSymbol = symbol;
      this.renderPriceAction(data);
    } catch (e) {
      if (token !== this._reqToken) return;
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

  renderPriceAction(data) {
    const { longTerm, shortTerm, coordination, falsification, meta } = data;
    const metaEl = document.getElementById('paMeta');
    if (metaEl) metaEl.textContent = `K线 ${meta.range} · 日K ${meta.dailyBars} 根 / 月K ${meta.monthlyBars} 根 · ${meta.source}`;

    // 顶部速览条
    const summaryEl = document.getElementById('paSummary');
    if (summaryEl) {
      summaryEl.innerHTML = `
        <div class="pa-sum-chip"><span class="psc-label">长期趋势</span><span class="psc-value ${this._paVerdictClass(longTerm.verdict)}">${longTerm.verdict}</span></div>
        <div class="pa-sum-chip"><span class="psc-label">短期动向</span><span class="psc-value ${this._paVerdictClass(shortTerm.direction)}">${shortTerm.direction}（概率${shortTerm.probability}）</span></div>
        <div class="pa-sum-chip"><span class="psc-label">推演场景</span><span class="psc-value side">${this.escapeHtml(coordination.scenario)}</span></div>
        <div class="pa-sum-chip"><span class="psc-label">主导力量</span><span class="psc-value ${coordination.dominant.includes('长期') ? 'up' : 'down'}">${this.escapeHtml(coordination.dominant)}</span></div>
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
      const zoneRow = (z, cls) => `<div class="pa-zone-row ${cls}"><span class="pz-range">${Storage.formatNumber(z.low)} ~ ${Storage.formatNumber(z.high)}</span><span class="pz-src">${this.escapeHtml(z.source)}</span></div>`;
      stEl.innerHTML = `
        <h4>② 短期动向预判（1-5个交易日） <span class="pa-verdict ${this._paVerdictClass(shortTerm.direction)}">${shortTerm.direction} · 概率${shortTerm.probability}</span></h4>
        <ul class="pa-evidence">${shortTerm.evidence.map(e => `<li>${this.escapeHtml(e)}</li>`).join('')}</ul>
        ${shortTerm.resistances.length ? `<div class="pa-zone-title resistance">上方关键阻力区间</div>${shortTerm.resistances.map(z => zoneRow(z, 'resistance')).join('')}` : ''}
        ${shortTerm.supports.length ? `<div class="pa-zone-title support">下方关键支撑区间</div>${shortTerm.supports.map(z => zoneRow(z, 'support')).join('')}` : ''}
      `;
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
    // 去年同期同比增速：取自东财 ZYZBAjaxNew 多期序列，与后台 evaluateSignals 边际趋势同源
    const zyzb = Array.isArray(qf.zyzbHistory) ? qf.zyzbHistory : [];
    const priorYoy = zyzb.length >= 2 ? zyzb[zyzb.length - 2] : null;
    const priorRevenueYoy = priorYoy && !isNaN(parseFloat(priorYoy.TOTALOPERATEREVETZ)) ? parseFloat(priorYoy.TOTALOPERATEREVETZ) : null;
    const priorProfitYoy = priorYoy && !isNaN(parseFloat(priorYoy.PARENTNETPROFITTZ)) ? parseFloat(priorYoy.PARENTNETPROFITTZ) : null;
    const priorRoe = priorYoy && !isNaN(parseFloat(priorYoy.ROEJQ)) ? parseFloat(priorYoy.ROEJQ) : null;
    // 数据期标注：报表指标引用具体财报期；估值类为 TTM；股息率为历史分红（均非财报期）
    const stmtPeriod = finLabel ? '财报 ' + finLabel : '';
    const valPeriod = 'TTM';
    const divPeriod = '历史分红';
    const ocflowPeriod = ocfLabel ? '财报 ' + ocfLabel : stmtPeriod;
    const rows = [
      ['市盈率(PE)', m.pe?.toFixed(2), `PE(TTM) · 股价 ${priceDate} ÷ 近12个月每股收益${finLabel ? '(财报 ' + finLabel + ')' : ''} · 来源：${qf.peSource || '行情数据'}`, { indKey: 'pe', pctKey: 'pe' }, valPeriod],
      ['市净率(PB)', m.pb?.toFixed(2), `PB · 股价 ${priceDate} ÷ 每股净资产${finLabel ? '(财报 ' + finLabel + ')' : ''} · 来源：${qf.pbSource || '行情数据'}`, { indKey: 'pb', pctKey: 'pb' }, valPeriod],
      ['市销率(PS)', m.ps?.toFixed(2), `PS(TTM) · 总市值 ÷ 近12个月营业收入 · 来源：${qf.psSource || '东方财富估值(PS_TTM)'}`, { indKey: null, pctKey: 'ps' }, valPeriod],
      ['PEG', m.peg?.toFixed(2), 'PEG · 本地计算（PE/PB 为 TTM）', { indKey: null, pctKey: null }, valPeriod],
      ['ROE', m.roe ? m.roe.toFixed(2) + '%' : '--', `ROE · 归母净利润 ÷ 净资产${finLabel ? '(财报 ' + finLabel + ')' : ''} · 来源：${qf.roeSource || '财报数据'}`, { indKey: 'roe', pctKey: 'roe', prior: priorRoe != null ? `去年同期 ${priorRoe.toFixed(2)}%` : null }, stmtPeriod],
      ['毛利率', m.grossMargin ? m.grossMargin.toFixed(2) + '%' : '--', `毛利率 · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: 'grossMargin' }, stmtPeriod],
      ['净利率', m.netMargin ? m.netMargin.toFixed(2) + '%' : '--', `净利率 · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: 'netMargin' }, stmtPeriod],
      ['营收增长', m.revenueGrowth ? m.revenueGrowth.toFixed(2) + '%' : '--', `营收同比增长 · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: 'revenueGrowth', prior: priorRevenueYoy != null ? `去年同期 ${priorRevenueYoy.toFixed(2)}%` : null }, stmtPeriod],
      ['利润增长', m.profitGrowth ? m.profitGrowth.toFixed(2) + '%' : '--', `归母净利润同比增长 · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: 'profitGrowth', prior: priorProfitYoy != null ? `去年同期 ${priorProfitYoy.toFixed(2)}%` : null }, stmtPeriod],
      ['资产负债率', m.debtToEquity != null ? m.debtToEquity.toFixed(2) + (m.debtMetricPct ? '%' : '') : '--', `资产负债率 · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: 'debtToEquity' }, stmtPeriod],
      ['流动比率', m.currentRatio?.toFixed(2), `流动比率 · 来源：${qf.reportSource || '东方财富财报'}${finLabel ? ' · 财报 ' + finLabel : ''}`, { indKey: null, pctKey: 'currentRatio' }, stmtPeriod],
      ['股息率', m.dividendYield ? m.dividendYield.toFixed(2) + '%' : '--', '股息率 · 来源：历史分红数据', { indKey: null, pctKey: null }, divPeriod],
      ['每股经营现金流', m.operatingCashFlowPerShare ? m.operatingCashFlowPerShare.toFixed(2) : '--', `每股经营现金流 = 经营现金流净额 ÷ 总股本${ocfLabel ? ' · 财报 ' + ocfLabel : ''} · 来源：${qf.operatingCashFlowSource || '东方财富财报'}`, { indKey: null, pctKey: null }, ocflowPeriod],
    ];
    // 卡片级数据期说明（报表指标 vs 估值指标，避免把 TTM 误读为财报期）
    const periodNote = `报表指标引用：<b>${finLabel || '—'}</b>${qf.reportDate ? '（' + qf.reportDate + '）' : ''} · 来源 ${qf.reportSource || '东方财富财报'} ｜ 估值指标 TTM（截至 ${priceDate}）· 股息率取自历史分红`;
    // 指标行按信号着色：利好(红)/利空(绿)
    const sigMap = {};
    (data.signals?.signals || []).forEach(s => { sigMap[s.key] = s; });
    const keyOf = (label) => ({ '市盈率(PE)': 'pe', '市净率(PB)': 'pb', '市销率(PS)': 'ps', 'PEG': 'peg', 'ROE': 'roe', '毛利率': 'grossMargin', '净利率': 'netMargin', '营收增长': 'growth', '利润增长': 'profitGrowth', '资产负债率': 'debt', '流动比率': 'currentRatio', '股息率': 'div', '每股经营现金流': 'ocf' }[label]);
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
      return `<div class="metric-row${cls}" title="${r[2] || ''}">
        <span class="mr-label">${r[0]}${help}</span>
        <span class="mr-value">${r[1] || '--'}${tag}${extraHtml}</span>
      </div>`;
    }).join('');
    // 指标释义「?」图标：点击展开浮层
    metricsEl.querySelectorAll('.metric-help').forEach(el => {
      el.addEventListener('click', (e) => { e.stopPropagation(); this.showMetricHelp(el.dataset.help, el); });
    });

    // Analyst rating
    const a = fundamental.analystTarget;
    if (a) {
      const recColor = a.recommendation === 'buy' || a.recommendation === 'strong_buy' ? '#F6465D' :
                       a.recommendation === 'sell' || a.recommendation === 'strong_sell' ? '#0ECB81' : '#94a3b8';
      const recLabel = { strong_buy: '强烈买入', buy: '买入', hold: '持有', sell: '卖出', strong_sell: '强烈卖出' }[a.recommendation] || a.recommendation || '--';
      document.getElementById('analystRating').innerHTML = `
        <div class="rating-circle" style="background:${recColor}">${a.recommendationScore ? a.recommendationScore.toFixed(1) : '--'}</div>
        <div class="rating-label">${recLabel}</div>
        <div class="rating-detail">
          ${a.analystCount ? a.analystCount + '位分析师' : ''}<br>
          目标价: ${a.mean ? '$' + a.mean.toFixed(2) : '--'}<br>
          最高: ${a.high ? '$' + a.high.toFixed(2) : '--'} | 最低: ${a.low ? '$' + a.low.toFixed(2) : '--'}
        </div>
        <div class="rating-source">来源：机构评级汇总（Yahoo/第三方）</div>
      `;
    } else {
      document.getElementById('analystRating').innerHTML = '<p style="color:var(--text-secondary);text-align:center;padding:20px;">暂无分析师评级数据</p>';
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

  // 利好/利空 信号提醒（红=利好，绿=利空）
  renderSignals(data) {
    const el = document.getElementById('signalAlerts');
    if (!el) return;
    const sig = data.signals;
    if (!sig || !Array.isArray(sig.signals) || sig.signals.length === 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    const basis = sig.compareBasis || '行业均值';
    const quote = data.quote || {};
    const f = quote.fundamentals || {};
    const finLabel = f.reportPeriod || f.reportDate || '';
    const priceDate = quote.date || '—';
    const rows = sig.signals.map(s => {
      const cls = s.signal === 'bull' ? 'sig-bull' : s.signal === 'bear' ? 'sig-bear' : 'sig-neutral';
      const tag = s.signal === 'bull' ? '利好' : s.signal === 'bear' ? '利空' : '中性';
      return `<div class="sig-item ${cls}">
        <div class="sig-head"><span class="sig-label">${s.label}</span><span class="sig-value">${s.value}</span><span class="sig-tag">${tag}</span></div>
        <div class="sig-reason">${s.reason}</div>
      </div>`;
    }).join('');
    el.innerHTML = `<h3>📣 信号提醒（利好 / 利空）</h3>
      <div class="sig-note">对比基准：${basis}（🔴 红 = 利好股价，🟢 绿 = 利空股价）</div>
      <div class="sig-list">${rows}</div>
      <div class="sig-meta">数据来源：行情 ${priceDate}${finLabel ? ' · 财报 ' + finLabel : ''} · 本地规则计算</div>`;
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

    // 行业分析（按当前股票追踪）
    if (tabName === 'industry') {
      if (this.currentSymbol && this.industryLoadedSymbol !== this.currentSymbol) {
        this.loadIndustryAnalysis();
      } else if (this.industryData) {
        setTimeout(() => {
          try { IndustryCharts.renderAll(this.industryData, this.industryBoardData, this.industryHistoryData, this.industryStockMarketCapData); }
          catch (e) { console.error('Industry charts render error:', e); }
        }, 100);
        this.loadIndustryBoardIndex(false);
      }
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
  },

  // ---- Deep Analysis ----
  async loadDeepAnalysis(forceRefresh = false) {
    const loadingEl = document.getElementById('deepLoading');
    const contentEl = document.getElementById('deepContent');
    const cacheBar = document.getElementById('deepCacheBar');
    // 首次且骨架完整时，捕获静态章节骨架，供后续恢复（避免任何意外清空/错误占位后白屏）
    if (!this._deepSkeletonHTML && contentEl && document.getElementById('deepResearchReports')) {
      this._deepSkeletonHTML = contentEl.innerHTML;
    }
    loadingEl.classList.remove('hidden');
    contentEl.style.opacity = '0.3';
    if (cacheBar) cacheBar.classList.add('hidden');

    try {
      const name = this.currentData?.name || '';
      // 前端 65s 超时保护（与后端 55s 总超时兜底配合，避免永久转圈）
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 65000);
      let resp;
      try {
        const params = [];
        if (forceRefresh) params.push('refresh=1');
        if (name) params.push('name=' + encodeURIComponent(name));
        const qs = params.length ? '?' + params.join('&') : '';
        resp = await fetch(`/api/deep-analysis/${encodeURIComponent(this.currentSymbol)}${qs}`, { signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      const data = await resp.json();

      if (data.error) {
        contentEl.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);">
          <h3>⚠️ ${data.error}</h3>
          <p>深度分析目前仅支持A股市场，且需要该股票有完整的财务报表数据。</p>
        </div>`;
        return;
      }

      this.deepData = data;
      this.deepDataLoaded = true;
      this.deepLoadedSymbol = this.currentSymbol; // issue2：标记已为当前股票加载

      // 数据不完整兜底：避免整页空白
      if (!data.sections) {
        contentEl.innerHTML = `<div style="text-align:center;padding:60px;color:var(--text-secondary);">
          <h3>⚠️ 深度分析数据不完整</h3>
          <p>本次未能获取到完整的分析数据，请点击「🔄 刷新」重试。</p>
        </div>`;
        return;
      }

      // Show audit warning if non-standard
      if (data.auditWarning) {
        const warnEl = document.getElementById('auditWarning');
        warnEl.textContent = data.auditWarning;
        warnEl.classList.remove('hidden');
      }

      // 若章节骨架被意外清空/覆盖，先恢复静态骨架，避免 renderAll 找不到元素而白屏
      this.ensureDeepSkeleton();

      // 显示缓存状态条（更新时间 + 刷新按钮）
      this.updateDeepCacheBar(data);

      // Render all charts
      setTimeout(() => {
        try { DeepCharts.renderAll(data.sections, this.currentSymbol, this.currentData?.name); } catch (e) { console.error('DeepCharts render error:', e); }
        try { this.syncDeepGroupsVisibility(); } catch (e) {}
      }, 100);

      this.toast(forceRefresh ? '已重新分析完成' : (data.fromCache ? '已加载缓存数据' : '深度分析数据加载完成'));
    } catch (e) {
      const msg = (e && e.name === 'AbortError') ? '请求超时（>45秒），请检查网络或稍后重试' : (e && e.message);
      this.toast('深度分析加载失败: ' + msg, 'error');
      console.error('Deep analysis error:', e);
    } finally {
      // 统一收口：成功/失败/数据不完整各路径 loading 必定移除、内容恢复可见（防转圈残留）
      loadingEl.classList.add('hidden');
      contentEl.style.opacity = '1';
    }
  },

  // 恢复深度分析静态章节骨架（首屏成功渲染前调用）。
  // 章节骨架是 index.html 内的静态 HTML；若被清空或错误占位冲掉，
  // 没有骨架 renderAll 会找不到元素而整页空白。这里用首次捕获的 HTML 重建。
  ensureDeepSkeleton() {
    const content = document.getElementById('deepContent');
    if (!content) return;
    const hasSkeleton = document.getElementById('deepResearchReports') || document.getElementById('deepAnnouncements');
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
    const sourceNote = '数据来源：东方财富财报 / 分红 / 股东数据 · 本地规则计算';
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
    const defaultCollapsed = ['homeSentimentPanel', 'indexPeTrendCard', 'sectorCrowdingCard', 'homeNewsCard', 'homeHotTopicsCard', 'macroCard', 'rankCard'];
    let state;
    try { state = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}'); } catch { state = {}; }
    const firstVisit = !localStorage.getItem(COLLAPSE_KEY);
    document.querySelectorAll('[data-collapsible="true"]').forEach(card => {
      const id = card.id;
      const btn = document.querySelector(`.btn-collapse[data-collapse-target="${id}"]`);
      if (!btn) return;
      if (firstVisit) state[id] = defaultCollapsed.includes(id);
      const collapsed = !!state[id];
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
      { id: 'group-overview', title: '📋 公司概览与结论', open: true,
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
        nodes: [cardOf('deepResearchReports'), cardOf('deepAnnouncements')] },
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
            <p>资金量能分析目前仅支持A股市场。</p>
          </div>`;
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
      }, 100);

      this.toast('资金量能数据加载完成');
    } catch (e) {
      clearTimeout(fetchTimer);
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
      this.loadIndustryBoardIndex(false);
      this.loadIndustryIndexHistory();

      if (loadingEl) loadingEl.classList.add('hidden');
      if (contentEl) contentEl.style.opacity = '1';

      setTimeout(() => {
        try { IndustryCharts.renderAll(data, this.industryBoardData, this.industryHistoryData, this.industryStockMarketCapData); } catch (e) { console.error('Industry charts render error:', e); }
      }, 100);

      this.toast('行业分析数据加载完成');
    } catch (e) {
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
      this._renderIndustryOverview();
      this._updateIndustryOverviewHeader(this.industryBoardData);
      return;
    }

    if (force) {
      // 触发后台联网获取（fire-and-forget，不阻塞界面）；随后由轮询自动显示结果
      this.industryBoardData = { status: 'running' };
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
      if (cached.success) {
        this.industryBoardData = cached;
        this.industryBoardLoadedSymbol = symbol;
        this._renderIndustryOverview();
        this._updateIndustryOverviewHeader(cached);
        return;
      }
      this.industryBoardData = null;
      this._renderIndustryOverview();
    } catch (e) {
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
          this.industryBoardData = { status: 'error', message: '获取超时，请稍后点击右上角重新获取。' };
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

  _renderIndustryOverview() {
    try {
      IndustryCharts.renderIndustryOverview(
        this.industryData && this.industryData.industry,
        this.industryBoardData,
        this.industryHistoryData,
        this.industryData && this.industryData.policy,
        this.industryStockMarketCapData
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
    try {
      const resp = await fetch(`/api/shareholders/${encodeURIComponent(this.currentSymbol)}?name=${encodeURIComponent(this.currentData?.name || '')}`);
      const data = await resp.json();
      this.shareholderData = data;
      this.shareholderLoadedSymbol = this.currentSymbol;
      this.renderShareholders(data);
    } catch (e) {
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
    // 股东户数 AI 解读卡片：本地 F10 有数据→本地模型解读；无数据→联网补充
    this.setupAIHolder(data);
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

    // 股东户数 AI 补充卡片：复位，避免残留上一只股票数据
    const ahBody = document.getElementById('aiHolderBody');
    const ahDate = document.getElementById('aiHolderDate');
    const ahBtn = document.getElementById('aiHolderBtn');
    if (ahBody) ahBody.innerHTML = '<div class="ai-empty">正在检查已存的股东户数资料…</div>';
    if (ahDate) ahDate.textContent = '';
    if (ahBtn) ahBtn.style.display = '';

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
    this.industryHistoryData = null;


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

    // 产品·客户面板：复位，避免残留上一只股票的产品/客户
    const pBody = document.getElementById('productsBody');
    const pDate = document.getElementById('productsDate');
    const pRef = document.getElementById('productsRefresh');
    if (pBody) pBody.innerHTML = '<div class="ai-empty">正在检查产品/客户数据...</div>';
    if (pDate) pDate.textContent = '';
    if (pRef) pRef.style.display = 'none';
    this.productsLoadedSymbol = null;
    this.productsData = null;

    // 公司综合介绍面板：复位
    const ciBody = document.getElementById('companyIntroBody');
    const ciDate = document.getElementById('companyIntroDate');
    const ciRef = document.getElementById('companyIntroRefresh');
    if (ciBody) ciBody.innerHTML = '<div class="ai-empty">正在检查已存的公司介绍资料...</div>';
    if (ciDate) ciDate.textContent = '';
    if (ciRef) ciRef.style.display = 'none';
    this.companyIntroLoadedSymbol = null;
    this.companyIntroData = null;

    // 供应链与成本分析面板：复位
    const scBody = document.getElementById('supplyChainBody');
    const scDate = document.getElementById('supplyChainDate');
    const scRef = document.getElementById('supplyChainRefresh');
    if (scBody) scBody.innerHTML = '<div class="ai-empty">正在检查已存的供应链分析资料...</div>';
    if (scDate) scDate.textContent = '';
    if (scRef) scRef.style.display = 'none';
    this.supplyLoadedSymbol = null;
    this.supplyData = null;
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
  openAISettings() {
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
    btn.textContent = '⏳ 搜索中…';
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
      btn.textContent = '✨ 一键补全';
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
      if (data.success && data.cached && data.content) {
        this.renderValuationAI(data);
      }
    } catch {}
  },

  async runValuationAI(force) {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const body = document.getElementById('valuationAiBody');
    const btn = document.getElementById('valuationAiBtn');
    if (!body || !btn) return;
    // 20260905j：点击即切换到 AI 视图（隐藏规则版估值，同一模块原地展示 AI 结果）
    const deepConc = document.getElementById('deepConclusion');
    if (deepConc) deepConc.style.display = 'none';
    body.style.display = '';
    if (!this.aiConfig || !this.aiConfig.hasKey) {
      this.aiConfig = await this.loadAIConfig();
    }
    if (!this.aiConfig || !this.aiConfig.hasKey) {
      body.innerHTML = '<div class="ai-empty">⚠️ 尚未配置 API Key。请点击左侧栏「⚙️ AI 联网设置」填入通义千问等带联网搜索的 Key。</div>';
      return;
    }
    btn.disabled = true;
    btn.textContent = '⏳ 估值中…';
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
      btn.textContent = '✨ AI 估值';
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
    // 20260905r：AI 估值结论文本的语义着色（仅展示层，跳过 HTML 标签内部）
    // 利好=红，利空=绿，章节标题/命中提示/警告符号=黄
    return html.replace(/(<[^>]+>)|利好|利空|【[^】]+】|命中\d+项|⚠/g, (m, tag) => {
      if (tag) return tag;
      if (m === '利好') return '<span class="ai-text-bullish">利好</span>';
      if (m === '利空') return '<span class="ai-text-bearish">利空</span>';
      return '<span class="ai-text-key">' + m + '</span>';
    });
  },

  renderValuationAI(j) {
    const body = document.getElementById('valuationAiBody');
    const dateEl = document.getElementById('valuationAiDate');
    if (!body) return;
    // 20260905j：AI 内容渲染时切换视图（缓存命中/生成成功均隐藏规则版估值，同模块原地显示 AI 结果）
    const deepConc = document.getElementById('deepConclusion');
    if (deepConc) deepConc.style.display = 'none';
    body.style.display = '';
    const d = new Date(j.date);
    const pad = (n) => String(n).padStart(2, '0');
    if (dateEl) dateEl.textContent = (j.cached ? '缓存于 ' : '更新于 ') +
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    // 20260905k：优先按「图一 vc-card 数据卡 + 图二行式文字说明」展示（与规则版估值结论视觉统一）
    const summary = this._parseValuationSummary(j.content);
    let html = '';
    if (summary && typeof DeepCharts !== 'undefined' && DeepCharts.renderValuationCardHTML) {
      const bodyText = this._stripValuationSummary(j.content);
      // 20260906：当前股价传工作台头部权威实时价（腾讯行情），覆盖 AI 摘要里的二手价（单一权威源）
      html = DeepCharts.renderValuationCardHTML(summary, this.currentData?.quote?.price);
      const conclusionRaw = '<div class="conclusion-text">' + bodyText.split('\n').map(l => `<p>${this.escapeHtml(l)}</p>`).join('') + '</div>';
      html += this._colorizeValuationText(conclusionRaw);
      const srcNote = j.localDataUsed ? '历史财务：本地年报数据库；实时数据：联网搜索' : '数据来源：联网搜索（补抓）';
      html += '<div class="ai-foot-note">' + this.escapeHtml(srcNote) + ' · 模型：' + this.escapeHtml(j.model || '') + '</div>';
    } else {
      // 兜底：摘要缺失/解析失败时按原 markdown 展示
      html = this._colorizeValuationText('<div class="ai-markdown">' + this.renderMarkdown(j.content) + '</div>');
      const modeText = '由 AI 估值大模型（年报数据库 + 上网搜索）生成，仅供参考，请自行核实。模型：' + this.escapeHtml(j.model || '');
      html += '<div class="ai-foot-note">' + modeText + '</div>';
    }
    body.innerHTML = html;
  },

  // ---- 产品·客户（默认用 AI 联网获取；财报未覆盖时自动补全）----
  async loadProducts(force = false) {
    const symbol = this.currentSymbol;
    const body = document.getElementById('productsBody');
    if (!symbol || !body) return;

    // 已为该股票加载过（缓存命中或已分析）则不再重复请求
    if (!force && this.productsLoadedSymbol === symbol && this.productsData) {
      this.renderProducts(this.productsData);
      return;
    }
    if (force) body.innerHTML = '<div class="ai-empty">正在联网分析产品与客户，请稍候…</div>';

    try {
      if (!force) {
        const resp = await fetch(`/api/ai/products/${encodeURIComponent(symbol)}`);
        const cached = await resp.json();
        if (this.currentSymbol !== symbol) return; // 已切换股票
        if (cached.success && (cached.products?.length || cached.customers?.length || cached.summary)) {
          this.productsData = cached;
          this.productsLoadedSymbol = symbol;
          this.renderProducts(cached);
          this.renderCompanyProfile(this.currentData, cached);
          return;
        }
        // 无缓存：不自动联网（避免每次打开个股都消耗额度），提示用户点击获取
        body.innerHTML = '<div class="ai-empty">暂无已存的产品/客户数据，点击右上角「✨ AI 联网获取」即可联网分析（含产品图片与营收占比）。</div>';
        return;
      }
      if (force) {
        body.innerHTML = '<div class="ai-empty">正在联网分析产品与客户（含图片与营收占比），请稍候…</div>';
        const resp = await fetch('/api/ai/products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol, force: true, companyType: this.currentData?.companyType?.type })
        });
        const data = await resp.json();
        if (this.currentSymbol !== symbol) return;
        if (data.success && (data.products?.length || data.customers?.length || data.summary)) {
          this.productsData = data;
          this.productsLoadedSymbol = symbol;
          this.renderProducts(data);
        } else if (!data.success && data.error === 'NO_KEY') {
          body.innerHTML = '<div class="ai-empty">尚未配置 AI API Key，无法联网获取产品/客户。请先在「⚙️ AI 设置」中配置，或点击「✨ AI 联网获取」。</div>';
        } else {
          body.innerHTML = '<div class="ai-empty">联网获取失败：' + this.escapeHtml(data.message || data.error || '未知错误') + '</div>';
        }
      }
    } catch (e) {
      if (force) body.innerHTML = '<div class="ai-empty">获取失败：' + this.escapeHtml(e.message) + '</div>';
    }
  },

  renderProducts(data) {
    const body = document.getElementById('productsBody');
    if (!body) return;
    const dateEl = document.getElementById('productsDate');
    const rf = document.getElementById('productsRefresh');
    if (dateEl && data.date) {
      const d = new Date(data.date);
      const pad = (n) => String(n).padStart(2, '0');
      dateEl.textContent = '更新于 ' + `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    if (rf) rf.style.display = '';
    const products = data.products || [];
    const customers = data.customers || [];
    const imgOf = (p) => (p.imageLocal || (p.imageUrl && /^https?:\/\//.test(p.imageUrl) ? p.imageUrl : ''));
    const importanceClass = (imp) => ({ '核心': 'core', '重要': 'major', '次要': 'minor' }[imp] || 'major');

    const productCards = products.length ? products.map(p => {
      const img = imgOf(p);
      const pct = Number(p.revenueShare) || 0;
      const imp = p.importance || '重要';
      return `<div class="prod-card">
        <div class="prod-img">
          ${img ? `<img src="${this.escapeHtml(img)}" alt="${this.escapeHtml(p.name)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
          <span class="prod-ph">📦</span>
          <span class="prod-imp prod-imp-${importanceClass(imp)}">${this.escapeHtml(imp)}</span>
        </div>
        <div class="prod-name">${this.escapeHtml(p.name)}</div>
        <div class="prod-share">
          <div class="ps-track"><div class="ps-fill" style="width:${Math.min(100, pct)}%"></div></div>
          <span class="ps-num">营收占比 ${pct}%</span>
        </div>
        ${p.desc ? `<div class="prod-desc">${this.escapeHtml(p.desc)}</div>` : ''}
      </div>`;
    }).join('') : '<div class="ai-empty">暂无产品数据</div>';

    const custRows = customers.length ? customers.map(c => `<div class="cust-row">
      <span class="cust-name">${this.escapeHtml(c.name)}</span>
      ${Number(c.revenueShare) ? `<span class="cust-share">营收占比 ${Number(c.revenueShare)}%</span>` : ''}
      ${c.desc ? `<span class="cust-desc">${this.escapeHtml(c.desc)}</span>` : ''}
    </div>`).join('') : '<div class="ai-empty">暂无客户数据</div>';

    const staleNote = data.stale ? `<div class="mx-stale-note">⚠️ 本地事实已过期（最后更新 ${this.escapeHtml((data.fetchedAt || data.factMaxDate || '').toString().slice(0, 10) || '未知')}），点击「✨ AI 联网获取」可重新抓取最新数据</div>` : '';
    body.innerHTML = `
      ${staleNote}
      ${data.summary ? `<div class="prod-summary">${this.escapeHtml(data.summary)}</div>` : ''}
      <h4 class="prod-sub">主要产品（${products.length}）</h4>
      <div class="prod-grid">${productCards}</div>
      <h4 class="prod-sub">主要客户（${customers.length}）</h4>
      <div class="cust-list">${custRows}</div>`;
  },

  // ---- 公司综合介绍（分析①：AI 联网获取，含产品服务图/实控人/近10年事件）----
  async loadCompanyIntro(force = false) {
    const symbol = this.currentSymbol;
    const body = document.getElementById('companyIntroBody');
    if (!symbol || !body) return;
    if (!force && this.companyIntroLoadedSymbol === symbol && this.companyIntroData) {
      this.renderCompanyIntro(this.companyIntroData);
      return;
    }
    if (force) body.innerHTML = '<div class="ai-empty">正在联网分析公司综合介绍，请稍候…</div>';
    try {
      if (!force) {
        const resp = await fetch(`/api/ai/company/${encodeURIComponent(symbol)}`);
        const cached = await resp.json();
        if (this.currentSymbol !== symbol) return;
        if (cached.success) {
          this.companyIntroData = cached;
          this.companyIntroLoadedSymbol = symbol;
          this.renderCompanyIntro(cached);
          return;
        }
        body.innerHTML = '<div class="ai-empty">暂无已存的公司介绍资料，点击右上角「✨ AI 联网获取」即可联网生成（含办公地点、产品图、实控人、近10年事件）。</div>';
        return;
      }
      body.innerHTML = '<div class="ai-empty">正在联网分析公司综合介绍（含图片），请稍候…</div>';
      const resp = await fetch('/api/ai/company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, force: true, companyName: this.currentData?.name, industry: this.currentData?.industry }),
      });
      const data = await resp.json();
      if (this.currentSymbol !== symbol) return;
      if (data.success) {
        this.companyIntroData = data;
        this.companyIntroLoadedSymbol = symbol;
        this.renderCompanyIntro(data);
      } else if (!data.success && data.error === 'NO_KEY') {
        body.innerHTML = '<div class="ai-empty">尚未配置 AI API Key，无法联网获取。请先在「⚙️ AI 设置」中配置。</div>';
      } else {
        body.innerHTML = '<div class="ai-empty">获取失败：' + this.escapeHtml(data.message || data.error || '未知错误') + '</div>';
      }
    } catch (e) {
      if (force) body.innerHTML = '<div class="ai-empty">获取失败：' + this.escapeHtml(e.message) + '</div>';
    }
  },

  renderCompanyIntro(data) {
    const body = document.getElementById('companyIntroBody');
    if (!body) return;
    const dateEl = document.getElementById('companyIntroDate');
    const rf = document.getElementById('companyIntroRefresh');
    if (dateEl && data.date) {
      const d = new Date(data.date);
      const pad = (n) => String(n).padStart(2, '0');
      dateEl.textContent = '更新于 ' + `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    if (rf) rf.style.display = '';
    const c = data;
    const stat = (label, val) => `<div class="ci-stat"><span class="ci-stat-label">${this.escapeHtml(label)}</span><span class="ci-stat-val">${val ? this.escapeHtml(val) : '—'}</span></div>`;
    const psImgs = (c.productsServices || []).map(p => {
      const img = p.imageLocal || (p.imageUrl && /^https?:\/\//.test(p.imageUrl) ? p.imageUrl : '');
      return `<div class="ci-prod">
        <div class="ci-prod-img">${img ? `<img src="${this.escapeHtml(img)}" alt="${this.escapeHtml(p.name)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="ci-prod-ph">🏷️</span></div>
        <div class="ci-prod-name">${this.escapeHtml(p.name)}</div>
        ${p.desc ? `<div class="ci-prod-desc">${this.escapeHtml(p.desc)}</div>` : ''}
      </div>`;
    }).join('');
    const brandChips = (c.brands || []).map(b => `<span class="ci-chip">${this.escapeHtml(b)}</span>`).join('');
    const impactCls = (s) => /利好/.test(s) ? 'bull' : /利空/.test(s) ? 'bear' : 'neutral';
    const events = (c.majorEvents || []).map(e => `<div class="ci-event">
      <span class="ci-event-year">${this.escapeHtml(e.year)}</span>
      <div class="ci-event-body">
        <div class="ci-event-title">${this.escapeHtml(e.title)}</div>
        ${e.desc ? `<div class="ci-event-desc">${this.escapeHtml(e.desc)}</div>` : ''}
        ${e.impact ? `<div class="ci-event-impact ci-${impactCls(e.impact)}">${this.escapeHtml(e.impact)}</div>` : ''}
      </div>
    </div>`).join('');
    body.innerHTML = `
      ${c.officeLocation ? `<div class="ci-office">📍 办公地点：${this.escapeHtml(c.officeLocation)}</div>` : ''}
      ${c.missionCulture ? `<div class="ci-block"><div class="ci-block-title">🎯 经营宗旨 / 企业文化</div><div class="ci-text">${this.escapeHtml(c.missionCulture)}</div></div>` : ''}
      ${brandChips ? `<div class="ci-block"><div class="ci-block-title">🌟 旗下知名品牌</div><div class="ci-chips">${brandChips}</div></div>` : ''}
      <div class="ci-stats">
        ${stat('专利数量', c.patentCount)}
        ${stat('员工人数', c.employeeCount)}
        ${stat('高管平均薪酬', c.execAvgSalary)}
      </div>
      ${c.actualController ? `<div class="ci-block"><div class="ci-block-title">👤 实际控制人</div><div class="ci-text"><b>${this.escapeHtml(c.actualController)}</b>${c.actualControllerIntro ? ` — ${this.escapeHtml(c.actualControllerIntro)}` : ''}</div></div>` : ''}
      ${psImgs ? `<div class="ci-block"><div class="ci-block-title">🛍️ 产品与服务</div><div class="ci-prod-grid">${psImgs}</div></div>` : ''}
      ${events ? `<div class="ci-block"><div class="ci-block-title">📰 近10年重大事件（公司与行业）</div><div class="ci-events">${events}</div></div>` : ''}
      ${c.summary ? `<div class="ci-summary">${this.escapeHtml(c.summary)}</div>` : ''}
    `;
  },

  // ---- 供应链与成本分析（分析②：产业链位置/原材料价格/供应商/成本控制）----
  async loadSupplyChain(force = false) {
    const symbol = this.currentSymbol;
    const body = document.getElementById('supplyChainBody');
    if (!symbol || !body) return;
    if (!force && this.supplyLoadedSymbol === symbol && this.supplyData) {
      this.renderSupplyChain(this.supplyData);
      return;
    }
    if (force) body.innerHTML = '<div class="ai-empty">正在联网分析供应链与成本，请稍候…</div>';
    try {
      if (!force) {
        const resp = await fetch(`/api/ai/supply/${encodeURIComponent(symbol)}`);
        const cached = await resp.json();
        if (this.currentSymbol !== symbol) return;
        if (cached.success) {
          this.supplyData = cached;
          this.supplyLoadedSymbol = symbol;
          this.renderSupplyChain(cached);
          return;
        }
        body.innerHTML = '<div class="ai-empty">暂无已存的供应链分析资料，点击右上角「✨ AI 联网获取」即可联网生成（含产业链位置、原材料价格、供应商、成本控制）。</div>';
        return;
      }
      body.innerHTML = '<div class="ai-empty">正在联网分析供应链与成本（含图片），请稍候…</div>';
      const resp = await fetch('/api/ai/supply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, force: true, companyName: this.currentData?.name, industry: this.currentData?.industry }),
      });
      const data = await resp.json();
      if (this.currentSymbol !== symbol) return;
      if (data.success) {
        this.supplyData = data;
        this.supplyLoadedSymbol = symbol;
        this.renderSupplyChain(data);
      } else if (!data.success && data.error === 'NO_KEY') {
        body.innerHTML = '<div class="ai-empty">尚未配置 AI API Key，无法联网获取。请先在「⚙️ AI 设置」中配置。</div>';
      } else {
        body.innerHTML = '<div class="ai-empty">获取失败：' + this.escapeHtml(data.message || data.error || '未知错误') + '</div>';
      }
    } catch (e) {
      if (force) body.innerHTML = '<div class="ai-empty">获取失败：' + this.escapeHtml(e.message) + '</div>';
    }
  },

  renderSupplyChain(data) {
    const body = document.getElementById('supplyChainBody');
    if (!body) return;
    const dateEl = document.getElementById('supplyChainDate');
    const rf = document.getElementById('supplyChainRefresh');
    if (dateEl && data.date) {
      const d = new Date(data.date);
      const pad = (n) => String(n).padStart(2, '0');
      dateEl.textContent = '更新于 ' + `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    if (rf) rf.style.display = '';
    const posCls = /上游/.test(data.chainPosition) ? 'up' : /下游/.test(data.chainPosition) ? 'down' : /中游/.test(data.chainPosition) ? 'mid' : 'neutral';
    const trendCls = (s) => /(上涨|上升|高位|增加|走高|涨价)/.test(s) ? 'bear' : /(下跌|回落|下行|下降|走低|减少|降价)/.test(s) ? 'bull' : 'neutral';
    const mats = (data.materials || []).map(m => {
      const img = m.imageLocal || (m.imageUrl && /^https?:\/\//.test(m.imageUrl) ? m.imageUrl : '');
      return `<div class="sc-mat">
        <div class="sc-mat-img">${img ? `<img src="${this.escapeHtml(img)}" alt="${this.escapeHtml(m.name)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="sc-mat-ph">📦</span></div>
        <div class="sc-mat-info">
          <div class="sc-mat-name">${this.escapeHtml(m.name)}</div>
          ${m.desc ? `<div class="sc-mat-desc">${this.escapeHtml(m.desc)}</div>` : ''}
          ${m.priceTrend ? `<div class="sc-mat-row"><span class="sc-k">价格趋势</span><span class="sc-v sc-${trendCls(m.priceTrend)}">${this.escapeHtml(m.priceTrend)}</span></div>` : ''}
          ${m.impactOnCost ? `<div class="sc-mat-row"><span class="sc-k">对成本影响</span><span class="sc-v sc-${trendCls(m.impactOnCost)}">${this.escapeHtml(m.impactOnCost)}</span></div>` : ''}
        </div>
      </div>`;
    }).join('');
    const sups = (data.suppliers || []).map(s => {
      const img = s.imageLocal || (s.imageUrl && /^https?:\/\//.test(s.imageUrl) ? s.imageUrl : '');
      return `<div class="sc-sup">
        <div class="sc-sup-img">${img ? `<img src="${this.escapeHtml(img)}" alt="${this.escapeHtml(s.name)}" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<span class="sc-sup-ph">🏭</span></div>
        <div class="sc-sup-info"><div class="sc-sup-name">${this.escapeHtml(s.name)}</div>${s.desc ? `<div class="sc-sup-desc">${this.escapeHtml(s.desc)}</div>` : ''}</div>
      </div>`;
    }).join('');
    const ctrl = (data.costControl || []).map(c => `<li>${this.escapeHtml(c)}</li>`).join('');
    body.innerHTML = `
      ${data.chainPosition ? `<div class="sc-pos">产业链位置：<span class="sc-pos-badge sc-pos-${posCls}">${this.escapeHtml(data.chainPosition)}</span></div>` : ''}
      ${mats ? `<div class="ci-block"><div class="ci-block-title">🔩 主要原材料 / 服务（含价格变动与成本影响）</div><div class="sc-mats">${mats}</div></div>` : ''}
      ${sups ? `<div class="ci-block"><div class="ci-block-title">🏭 主要供应商 / 供应方</div><div class="sc-sups">${sups}</div></div>` : ''}
      ${ctrl ? `<div class="ci-block"><div class="ci-block-title">💡 成本控制方法</div><ul class="sc-ctrl">${ctrl}</ul></div>` : ''}
      ${data.summary ? `<div class="ci-summary">${this.escapeHtml(data.summary)}</div>` : ''}
    `;
  },

  // 股东户数：本地 F10 有数据→AI 本地模型解读（不联网）；无数据→AI 联网补充
  setupAIHolder(data) {
    const body = document.getElementById('aiHolderBody');
    const dateEl = document.getElementById('aiHolderDate');
    const btn = document.getElementById('aiHolderBtn');
    if (!body) return;
    const hasLocal = !!(data && data.holderCountTrend && data.holderCountTrend.length > 0);
    if (hasLocal) {
      this._aiHolderMode = 'local';
      body.innerHTML = '<div class="ai-note">✅ 本地 F10 已含股东户数走势，可点击下方按钮用 AI 本地模型解读趋势（不联网）。</div>';
      if (dateEl) dateEl.textContent = '';
      if (btn) { btn.style.display = ''; btn.textContent = '✨ AI 本地解读'; }
      this.loadAIHolders(false, 'local');
      return;
    }
    this._aiHolderMode = 'web';
    if (btn) { btn.style.display = ''; btn.textContent = '✨ AI 联网补充'; }
    body.innerHTML = '<div class="ai-empty">本地 F10 未提供股东户数，可点击下方按钮让 AI 联网补充（搜索一次后长期留存）。</div>';
    this.loadAIHolders(false, 'web');
  },
  async loadAIHolders(force, mode) {
    const symbol = this.currentSymbol;
    if (!symbol) return;
    const body = document.getElementById('aiHolderBody');
    const dateEl = document.getElementById('aiHolderDate');
    if (!body) return;
    mode = mode || this._aiHolderMode || 'web';
    if (!force) {
      try {
        const resp = await fetch(`/api/ai/holders/${encodeURIComponent(symbol)}`);
        const c = await resp.json();
        if (this.currentSymbol !== symbol) return;
        if (c.success && (c.holderCount || c.trend) && c.mode === mode) { this.renderAIHolder(c); return; }
      } catch {}
    }
    body.innerHTML = mode === 'local'
      ? '<div class="ai-empty">正在用 AI 本地模型解读股东户数…</div>'
      : '<div class="ai-empty">正在联网获取股东户数…</div>';
    try {
      const resp = await fetch('/api/ai/holders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, stockName: this.currentData?.name || '', mode }),
      });
      const d = await resp.json();
      if (this.currentSymbol !== symbol) return;
      if (d.noKey) { body.innerHTML = '<div class="ai-empty">未配置 AI Key，请在「⚙️ AI 设置」中粘贴通义千问 Key 后重试。</div>'; return; }
      if (!d.success && d.error) { body.innerHTML = '<div class="ai-empty">获取失败：' + this.escapeHtml(d.error) + '</div>'; return; }
      this.renderAIHolder(d);
    } catch (e) {
      body.innerHTML = '<div class="ai-empty">获取失败：' + this.escapeHtml(e.message) + '</div>';
    }
  },
  renderAIHolder(d) {
    const body = document.getElementById('aiHolderBody');
    const dateEl = document.getElementById('aiHolderDate');
    if (!body) return;
    const cnt = d.holderCount ? Number(d.holderCount).toLocaleString('zh-CN') + ' 户' : '未知';
    const isLocal = d.mode === 'local';
    const note = isLocal
      ? '✅ 基于本地 F10 股东户数数据，由 AI 本地模型解读（未联网，数据来源：东方财富 F10）。'
      : '⚠️ 该数据为 AI 联网检索的估计值，仅供参考，请以交易所/公司公告为准。';
    body.innerHTML = `<div class="ai-holder-result">
      <div class="aih-count">${cnt} <span class="aih-asof">（截至 ${this.escapeHtml(d.asOf || '—')}）</span></div>
      ${d.trend ? `<div class="aih-trend">${this.escapeHtml(d.trend)}</div>` : ''}
      ${d.source ? `<div class="aih-source">来源：${this.escapeHtml(d.source)}</div>` : ''}
      <div class="aih-note${isLocal ? ' aih-note-local' : ''}">${note}</div>
    </div>`;
    if (dateEl) dateEl.textContent = d.date ? '更新于 ' + d.date : '';
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
      source: item.source,
      peField: item.peField,
      length: (item.series || []).length,
    }));
    const latestHtml = items.map(it => {
      const pe = it.latest && it.latest.pe != null ? it.latest.pe.toFixed(2) : '—';
      const q = it.quantile != null ? `<span class="ipe-quantile">近5年百分位 ${it.quantile}%</span>` : '';
      const colorClass = it.name === '上证50' ? 'ipe-sz50' : (it.name === '沪深300' ? 'ipe-hs300' : 'ipe-kc50');
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
    if (note) note.textContent = data.note || '';
    // 渲染图表
    requestAnimationFrame(() => {
      Charts.indexPETrend('indexPeTrendChart', data.data);
    });
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
          </div>
          <div class="mt-risk">⚠️ 风险提示：${this.escapeHtml(s6.risk)}</div>
        </div>
      </div>`;
    }).join('');
    container.innerHTML = `<div class="mt-list">${cards}</div>`;
    if (note) {
      note.innerHTML = `<div class="mt-synthesis">${this.escapeHtml(data.synthesis || '')}</div>
        <div class="mt-src">数据源：腾讯行情 K 线（日/周/月/30分）· 收盘后推演 · 分析期 ${this.escapeHtml(data.date || '')}</div>`;
    }
  },

  // 近一周涨跌前五高频板块提醒（红涨绿跌：红=上涨，绿=下跌）
  // 将 7日涨幅最大 / 7日跌幅最大 各追加到行业板块涨幅前5 / 跌幅前5 的 .mo-tiles 末尾，
  // 与 Top5 卡片在同一行展示，大小样式与 .mo-tile 完全一致。
  async loadSectorRankReminder() {
    const upTiles = document.querySelector('.mo-up .mo-tiles');
    const downTiles = document.querySelector('.mo-down .mo-tiles');
    if (!upTiles && !downTiles) return;
    try {
      const resp = await fetch('/api/sector-rank-reminder');
      const data = await resp.json();
      const up = data && data.featuredUp;
      const down = data && data.featuredDown;
      if (!data || data.success === false || (!up && !down)) return;

      const renderTile = (s, kind) => {
        if (!s) return '';
        const dir = kind === 'up' ? 'up' : 'down';
        const label = kind === 'up' ? '7日涨幅最大' : '7日跌幅最大';
        const chg = s.weekChgPct == null ? '—' : (s.weekChgPct >= 0 ? '+' : '') + s.weekChgPct + '%';
        return `<div class="mo-tile ${dir}">
          <div class="mo-name">${label}</div>
          <div class="mo-price">${this.escapeHtml(s.name)}</div>
          <div class="mo-chg">${chg}</div>
        </div>`;
      };

      if (up && upTiles) upTiles.insertAdjacentHTML('beforeend', renderTile(up, 'up'));
      if (down && downTiles) downTiles.insertAdjacentHTML('beforeend', renderTile(down, 'down'));
    } catch (e) {
      console.error('loadSectorRankReminder error:', e);
    }
  },

  // 首页·行业板块资金流向（主力净流入/流出前五 + 近5日最大）
  async loadSectorCapitalFlow() {
    const stack = document.querySelector('#marketOverview .mo-stack');
    if (!stack) return;
    // 若已渲染则避免重复（刷新按钮会清空后重跑）
    if (stack.querySelector('.mo-capital-flow')) return;
    if (this._scfLoading) return;
    this._scfLoading = true;
    try {
      const resp = await fetch('/api/sector-capital-flow');
      const data = await resp.json();
      if (!data || data.success === false) return;
      this.renderSectorCapitalFlow(data, stack);
    } catch (e) {
      console.error('loadSectorCapitalFlow error:', e);
    } finally {
      this._scfLoading = false;
    }
  },

  renderSectorCapitalFlow(data, stack) {
    const fmtPct = (n) => (n === null || n === undefined || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
    const fmtNet = (n) => {
      if (n === null || n === undefined || isNaN(n)) return '—';
      return (n >= 0 ? '+' : '') + Number(n).toFixed(2) + '亿';
    };
    const renderTile = (it, dirOverride) => {
      if (!it) return '';
      const dir = dirOverride || (it.mainNet > 0 ? 'up' : (it.mainNet < 0 ? 'down' : 'flat'));
      const sub = it.leader ? `领涨：${this.escapeHtml(it.leader)}` : `主力净流：${fmtNet(it.mainNet)}`;
      return `<div class="mo-tile ${dir}">
        <div class="mo-name">${this.escapeHtml(it.name)}</div>
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
        <div class="mo-price">${this.escapeHtml(it.name)}</div>
        <div class="mo-chg">${fmtNet(it.mainNet)}</div>
      </div>`;
    };
    const renderRow = (items, label, fiveDay, cls) => {
      const body = (items && items.length)
        ? items.map(it => renderTile(it)).join('')
        : '<span class="mo-empty">— 暂无数据 —</span>';
      const srcWarn = data.fallbackWarning ? `<span class="mo-src mo-src-warn" title="${this.escapeHtml(data.fallbackWarning)}">${this.escapeHtml(data.source)}</span>`
        : `<span class="mo-src">${this.escapeHtml(data.source)}</span>`;
      const note = data.note ? `<span class="mo-count" title="${this.escapeHtml(data.note)}">口径说明</span>` : '';
      return `<div class="mo-row mo-capital-flow ${cls}">
        <div class="mo-row-head"><span class="mo-flag">💰</span><span class="mo-row-name">${this.escapeHtml(label)}</span>${srcWarn}${note}</div>
        <div class="mo-tiles">${body}${renderFiveDay(fiveDay, cls === 'mo-capital-in' ? '近5日净流入最大' : '近5日净流出最大')}</div>
      </div>`;
    };
    const html = renderRow(data.todayInflowTop5, '主力资金净流入前五（含暗盘）', data.fiveDayMaxInflow, 'mo-capital-in') +
      renderRow(data.todayOutflowTop5, '主力资金净流出前五（含暗盘）', data.fiveDayMaxOutflow, 'mo-capital-out');
    const anchor = document.getElementById('moCapitalFlowAnchor');
    if (anchor) anchor.insertAdjacentHTML('beforebegin', html);
    else stack.insertAdjacentHTML('beforeend', html);
  },

  // 首页大盘/板块 AI 滚动解读
  async loadMarketAI(force) {
    const btn = document.getElementById('marketAIBtn');
    if (btn) btn.disabled = true;
    try {
      let result;
      if (force) {
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
        if (force && result && result.error === 'NO_KEY') {
          alert(result.message || '请先在「⚙️ AI 设置」中配置 API Key');
        }
        return;
      }
      this.renderMarketAITexts(result);
    } catch (e) {
      console.error('loadMarketAI error:', e);
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
      { key: 'cn', country: '中国指数', flag: '🇨🇳', cls: 'mo-cn', aiKey: 'cn' },
      { key: 'sectorsUp', country: '行业板块涨幅前5', flag: '📈', cls: 'mo-up', aiKey: 'gainers', source: data.sectorSource, isEm: data.sectorIsEastmoney },
      { key: 'sectorsDown', country: '行业板块跌幅前5', flag: '📉', cls: 'mo-down', aiKey: 'losers', source: data.sectorSource, isEm: data.sectorIsEastmoney },
      { key: 'us', country: '美国指数', flag: '🇺🇸', cls: 'mo-us', aiKey: null },
    ];
    const fmt = (n) => (n === null || n === undefined || isNaN(n)) ? '--' : n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtPct = (n) => (n === null || n === undefined || isNaN(n)) ? '--' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

    const warnHtml = data.sectorWarning
      ? `<div class="mo-warn">⚠️ ${this.escapeHtml(data.sectorWarning)}</div>`
      : '';
    const noteHtml = data.sectorNote
      ? `<div class="mo-note">ℹ️ ${this.escapeHtml(data.sectorNote)}</div>`
      : '';
    // 单个 group 渲染为可复用的函数
    const renderGroup = (g) => {
      const items = (data[g.key] || []).map(it => {
        const dir = (!it.unavailable && it.changePct > 0) ? 'up' : ((!it.unavailable && it.changePct < 0) ? 'down' : 'flat');
        let subInfo = fmt(it.price);
        if (subInfo === '--') {
          if (it.leader) subInfo = `领涨：${it.leader}`;
          else if (it.upCount != null && it.downCount != null) subInfo = `涨${it.upCount} / 跌${it.downCount}`;
        }
        return `<div class="mo-tile ${dir}">
          <div class="mo-name">${it.name || it.code}</div>
          <div class="mo-price">${subInfo}</div>
          <div class="mo-chg">${fmtPct(it.changePct)}</div>
        </div>`;
      }).join('');
      const emptyMsg = (g.key === 'sectorsUp' && data.sectorUpCount === 0)
        ? '— 市场普跌，暂无上涨板块 —'
        : (g.key === 'sectorsDown' && data.sectorDownCount === 0)
          ? '— 市场普涨，暂无下跌板块 —'
          : '— 暂无数据 —';
      const body = items || `<span class="mo-empty">${emptyMsg}</span>`;
      const cachedText = (g.aiKey && this.lastMarketAITexts && this.lastMarketAITexts[g.aiKey]) ? this.lastMarketAITexts[g.aiKey] : '';
      const aiHint = cachedText || '点击右上角「✨ AI 解读」获取大盘/板块联网分析';
      const aiBar = g.aiKey ? `<div class="mo-ai-bar" data-ai-key="${g.aiKey}"><span class="mo-ai-text" title="${this.escapeHtml(aiHint)}">${this.escapeHtml(aiHint)}</span></div>` : '';
      const cntTag = (g.key === 'sectorsUp' || g.key === 'sectorsDown') && (data.sectorUpCount != null)
        ? `<span class="mo-count">涨${data.sectorUpCount} · 跌${data.sectorDownCount} · 平${data.sectorFlatCount}</span>`
        : '';
      const srcTag = g.source ? `<span class="mo-src${g.isEm ? '' : ' mo-src-warn'}">${g.source}</span>${cntTag}` : '';
      return `${aiBar}<div class="mo-row ${g.cls}">
        <div class="mo-row-head"><span class="mo-flag">${g.flag}</span><span class="mo-row-name">${g.country}</span>${srcTag}</div>
        <div class="mo-tiles">${body}</div>
      </div>`;
    };
    // 中国指数 / 行业板块涨幅前5 / 行业板块跌幅前5 / 美国指数，各自占一行；
    // 近一周高频板块（7日涨幅/跌幅最大）由 loadSectorRankReminder 在 .mo-tiles 末尾追加。
    const cnHtml = renderGroup(groups.find(g => g.key === 'cn'));
    const usHtml = renderGroup(groups.find(g => g.key === 'us'));
    const sectorsUpHtml = renderGroup(groups.find(g => g.key === 'sectorsUp'));
    const sectorsDownHtml = renderGroup(groups.find(g => g.key === 'sectorsDown'));
    const html = warnHtml + noteHtml + '<div class="mo-stack">' +
      cnHtml +
      sectorsUpHtml +
      sectorsDownHtml +
      '<div id="moCapitalFlowAnchor"></div>' +
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
        <div class="st-note">技术面评分由以下 6 个信号综合打分得出（每个信号按其多空方向贡献 ±分数，累加为 <b>trendScore</b>，再映射为等级）：</div>
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
        ['市盈率 PE', m.pe], ['市净率 PB', m.pb], ['ROE', m.roe],
        ['净利率', m.netMargin], ['营收增速', m.revenueGrowth], ['股息率', m.dividendYield],
      ].map(([k, v]) => `<div class="st-row"><span>${k}</span><span>${v ?? '--'}</span></div>`).join('');
      return `
        <div class="st-head">🔍 基本面评分计算依据</div>
        <div class="st-note">基本面评分 = 估值 + 盈利能力 + 成长性 + 财务健康 四项加权求和（满分 100），再映射为等级。各维度的权重随公司类型（增长/价值/红利/均衡）不同而调整。</div>
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
      <div class="st-note">资金热度以 50 分为中性起点，综合量能（交易量，方向无关）、主力资金流向、量能指标（OBV/VR/MFI）、融资融券余额变化与换手率（相对月均）计算，满分 100。</div>
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
    container.querySelectorAll('.wl-row').forEach((row, idx) => {
      row.addEventListener('click', e => {
        if (e.target.classList.contains('wl-remove')) {
          e.stopPropagation();
          this.confirmRemoveWatchlist(row.dataset.symbol);
        } else {
          this.watchlistNavIndex = idx;
          this.updateWatchlistNavHighlight();
          this.analyze(row.dataset.symbol, row.dataset.name);
        }
      });
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
      this.renderWatchlist();
    }, 60000);
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
  },

  // ---- 中栏图表：周期切换（日K/周K/月K/60分钟） ----
  async switchPeriod(period) {
    if (!this.currentSymbol) return;
    document.querySelectorAll('.period-btn').forEach(b => b.classList.toggle('active', b.dataset.period === period));
    if (period === '60m') {
      this.currentPeriod = period;
      await this.render60m();
      return;
    }
    this.currentPeriod = period;
    this.renderMainChart(period);
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
  // 非阻塞加载指示：仅驱动顶部进度条，绝不使用全屏遮罩拦截交互。
  // 这样在切换个股 / 搜索 / 加载分析时，用户仍可点击自选股、切 tab、滚动页面。
  showLoading(text = '正在获取数据...') {
    const bar = document.getElementById('topProgressBar');
    if (!bar) return;
    bar.classList.remove('hidden', 'done');
    // 强制回流，使 width 过渡从 0 重新触发
    void bar.offsetWidth;
    bar.classList.add('active');
  },

  hideLoading() {
    const bar = document.getElementById('topProgressBar');
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
