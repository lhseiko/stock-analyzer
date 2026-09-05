/**
 * Notes Module (issue4 重构)
 * 统一的笔记/记录系统，支持三种范围：
 *   - scope = 'global' 投资心得（整体投资经验，与个股无关）
 *   - scope = 'market' 大盘记录（市场整体观察）
 *   - scope = <股票代码>  个股亮点/雷点（与该股票绑定，aspect = highlight | risk）
 * 数据仍存于 localStorage（key 沿用旧的 journal key，旧笔记可继续读取）。
 */

const Notes = {
  STORAGE_KEY: 'stock_analyzer_journal',
  notes: [],

  init() {
    this.load();
    this.renderHome();
  },

  load() {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      this.notes = data ? JSON.parse(data) : [];
    } catch (e) {
      this.notes = [];
    }
    // 归一化：保证每条笔记 id 唯一
    // 修复早期 AI 生成在同毫秒内共享 id 导致「删一个删全部」的问题
    const seen = new Set();
    let changed = false;
    for (const n of this.notes) {
      if (!n.id || seen.has(n.id)) {
        n.id = this._genId();
        changed = true;
      }
      seen.add(n.id);
    }
    // 内容去重（精确 + 中文近义）：同一 (scope, aspect) 下内容相同或高度相似的笔记只保留首条，
    // 清除早期累积的重复亮点/雷点（含 AI 多次生成导致的"措辞不同但意思重复"）。
    const seenSim = [];
    const deduped = [];
    for (const n of this.notes) {
      const scope = this._normScope(this._normalize(n).scope);
      const aspect = n.aspect || '';
      const c = String(n.content || '').trim().toLowerCase();
      let dup = false;
      if (c) {
        for (const s of seenSim) {
          if (s.scope === scope && s.aspect === aspect && this._shouldConsolidate(c, s.c)) { dup = true; break; }
        }
      }
      if (dup) { changed = true; continue; }
      if (c) seenSim.push({ scope, aspect, c });
      deduped.push(n);
    }
    if (deduped.length !== this.notes.length) this.notes = deduped;
    if (changed) this.save();
  },

  // 生成唯一 id：时间戳 + 自增序号 + 随机串，确保同步循环内也不会碰撞
  _genId() {
    if (this._idSeq == null) this._idSeq = 0;
    this._idSeq += 1;
    return 'N' + Date.now().toString(36) + '_' + this._idSeq.toString(36) +
      '_' + Math.random().toString(36).slice(2, 7);
  },
  // 中文近义相似度：字符二元组(bigram)最小包含度，用于捕捉"措辞不同但意思重复"的笔记
  _similarityCN(a, b) {
    a = String(a || '').trim().toLowerCase();
    b = String(b || '').trim().toLowerCase();
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.includes(b) || b.includes(a)) return 0.95;
    const bg = (s) => { const o = []; for (let i = 0; i < s.length - 1; i++) o.push(s.slice(i, i + 2)); return o; };
    const A = bg(a), B = bg(b);
    if (!A.length || !B.length) return 0;
    const sb = new Set(B);
    let inter = 0;
    for (const x of new Set(A)) if (sb.has(x)) inter++;
    return inter / Math.min(A.length, B.length);
  },
  SIM_DUP_THRESHOLD: 0.6,

  // —— 关键词语义整合（用户要求：抓关键词 → 核对同关键词内容 → 高度相似即整合）——
  // 单字停用集：含这些字的中文短语视为"功能词/空词"，不作为主题关键词。
  STOP_KEYWORD_CHARS: new Set(['的','了','是','在','和','与','对','可','能','带','来','影','响','产','生','不','确','定','性','方','面','等','其','这','那','有','为','将','也','都','会','被','使','给','于','以','之','并','或','及','吗','呢','吧','啊','则','若','因','果','由','从','向','到','把','让','令','存','而','但','却','又','再','仍','皆','均','各','该','此','彼','上','下','中','内','外','后','前','时','间','期']),
  // 泛化业务词：过于常见，跨不同主题也会高频共现，不单独作为"同一主题"的判定依据（仅用于交叉核对提示，不用于自动合并）。
  GENERIC_KEYWORDS: new Set([
    '公司','业务','市场','行业','投资','收益','风险','影响','中国','可能','管理','资产','保险','金融',
    '资本','银行','集团','股东','利润','收入','增长','下降','利率','政策','监管','波动','价值','财务',
    '经营','负债','成本','费用','客户','产品','服务','渠道','国内','国际','全球','海外','控股','并购',
    '重组','分红','股息','估值','价格','需求','供给','竞争','份额','技术','创新','研发','人才','员工',
    '品牌','质量','安全','合规','法律','诉讼','处罚','环境','社会','治理','信用','流动性','杠杆','现金流',
    '偿债','融资','负债率','投资收益','公允价值'
  ]),
  // 判断一个 n-gram 是否为有意义的主题关键词（长度 2-4，不含停用字，非泛化词）
  _isKeyword(g) {
    if (!g || g.length < 2 || g.length > 4) return false;
    for (const ch of g) if (this.STOP_KEYWORD_CHARS.has(ch)) return false;
    if (this.GENERIC_KEYWORDS.has(g)) return false;
    return true;
  },
  // 从一段内容中提取 2-4 字主题关键词短语，去重并按长度降序（长关键词优先）
  _extractKeywords(text) {
    const t = String(text || '').replace(/[\s，。、；：？！“”‘’（）()\[\]【】\-\—、,.!?;:""''()\[\]{}《》\/\\|~`+*=<>]/g, '');
    const grams = new Set();
    for (let len = 4; len >= 2; len--) {
      for (let i = 0; i + len <= t.length; i++) {
        const g = t.slice(i, i + len);
        if (this._isKeyword(g)) grams.add(g);
      }
    }
    return Array.from(grams).sort((a, b) => b.length - a.length);
  },
  // 两段内容是否共享同一主题关键词（长度≥3 且非泛化）。返回最长共享关键词，否则 null。
  _shareKeyword(a, b) {
    const ka = this._extractKeywords(a), kb = this._extractKeywords(b);
    for (const x of ka) {
      if (x.length < 3) break;          // 小于 3 字的不作为主题关键词
      if (kb.includes(x)) return x;
    }
    return null;
  },
  // 是否应整合为同一条：原 bigram 相似度达标，或共享≥4字非泛化关键词且整体也有一定相似（防误并）
  _shouldConsolidate(a, b) {
    a = String(a || ''); b = String(b || '');
    if (!a.trim() || !b.trim()) return false;
    if (this._similarityCN(a, b) >= this.SIM_DUP_THRESHOLD) return true;
    const k = this._shareKeyword(a, b);
    return !!k && k.length >= 4 && this._similarityCN(a, b) >= 0.3;
  },

  save() {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.notes));
    } catch (e) {
      console.error('Notes save failed:', e);
    }
  },

  // 兼容旧笔记：旧数据无 scope 字段，按有无 stockCode 推断
  _normalize(n) {
    if (!n.scope) {
      n.scope = n.stockCode ? n.stockCode : 'global';
    }
    return n;
  },

  // 股票代码归一化：去掉 sh/sz/bj 前缀并转小写，使 601318 与 sh601318 视为同一标的，
  // 避免历史上代码前缀不一致导致同一亮点/雷点被存成两条而未被去重合并。
  _normScope(s) {
    if (!s) return 'global';
    return String(s).replace(/^(sh|sz|bj)/i, '').toLowerCase();
  },

  add(note) {
    const newNote = {
      id: this._genId(),
      date: new Date().toISOString(),
      scope: note.scope || 'global',
      aspect: note.aspect || null,        // highlight | risk（仅个股范围使用）
      stockCode: note.stockCode || '',
      stockName: note.stockName || '',
      title: note.title || '',
      content: note.content || '',
      tags: note.tags || [],
      type: note.type || 'experience',
      verification: { status: 'pending', result: null, probability: null, lastChecked: null, details: null },
    };
    this.notes.unshift(newNote);
    this.save();
    return newNote;
  },

  update(id, updates) {
    const idx = this.notes.findIndex(n => n.id === id);
    if (idx >= 0) {
      this.notes[idx] = { ...this.notes[idx], ...updates };
      this.save();
    }
  },

  remove(id) {
    this.notes = this.notes.filter(n => n.id !== id);
    this.save();
  },

  getByScope(scope) {
    return this.notes.filter(n => this._normalize(n).scope === scope);
  },

  async verify(id) {
    const note = this.notes.find(n => n.id === id);
    if (!note) return;
    note.verification.status = 'checking';
    note.verification.lastChecked = new Date().toISOString();
    this.renderHome();
    this.renderStock(window.currentStock?.code, window.currentStock?.name);
    try {
      const resp = await fetch('/api/journal/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: note.title, content: note.content,
          stockCode: note.stockCode, stockName: note.stockName, type: note.type,
        }),
      });
      const result = await resp.json();
      note.verification.status = result.status || 'unverified';
      note.verification.result = result.result || '';
      note.verification.probability = result.probability || 0;
      note.verification.details = result.details || null;
      note.verification.lastChecked = new Date().toISOString();
    } catch (e) {
      note.verification.status = 'error';
      note.verification.result = '验证失败: ' + e.message;
      note.verification.probability = 0;
    }
    this.save();
    this.renderHome();
    this.renderStock(window.currentStock?.code, window.currentStock?.name);
  },

  // ---------- 首页渲染（投资心得 + 大盘记录） ----------
  renderHome() {
    this.renderScope('global');
    this.renderScope('market');
  },

  renderScope(scope) {
    const map = { global: 'homeJournal', market: 'homeMarket' };
    const container = document.getElementById(map[scope]);
    if (!container) return;
    const list = this.getByScope(scope);
    if (list.length === 0) {
      const hint = scope === 'global' ? '还没有投资心得，点击右上角"写心得"记录你的整体投资经验。'
                                        : '还没有大盘记录，点击右上角"记一笔"记录市场整体观察。';
      container.innerHTML = `<div class="notes-empty">${hint}</div>`;
      return;
    }
    container.innerHTML = list.map(n => this.renderNoteCard(n)).join('');
  },

  // ---------- 首页笔记查看弹窗（投资心得 / 大盘记录，入口在按钮行） ----------
  showScopeModal(scope) {
    const meta = {
      global: { title: '🧠 投资心得', addLabel: '✏️ 写心得', hint: '还没有投资心得，点击右下角"写心得"记录你的整体投资经验。' },
      market: { title: '🌐 大盘记录', addLabel: '✏️ 记一笔', hint: '还没有大盘记录，点击右下角"记一笔"记录市场整体观察。' }
    }[scope];
    if (!meta) return;
    // 已打开则先关闭，避免叠加
    const existing = document.querySelector(`.journal-modal-overlay[data-scope="${scope}"]`);
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.className = 'journal-modal-overlay';
    modal.dataset.scope = scope;
    modal.innerHTML = `
      <div class="journal-modal scope-modal">
        <div class="journal-modal-head">
          <h3>${meta.title}</h3>
          <button class="modal-close" onclick="Notes.closeScopeModal('${scope}')">✕</button>
        </div>
        <div class="scope-modal-body" id="scopeModalBody"></div>
        <div class="scope-modal-foot">
          <button class="btn-journal-add" onclick="Notes.showForm('${scope}')">${meta.addLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) this.closeScopeModal(scope); });
    this.renderScopeModalBody(scope, meta);
  },

  renderScopeModalBody(scope, meta) {
    const body = document.getElementById('scopeModalBody');
    if (!body) return;
    const list = this.getByScope(scope);
    if (list.length === 0) {
      body.innerHTML = `<div class="notes-empty">${meta.hint}</div>`;
      return;
    }
    body.innerHTML = list.map(n => this.renderNoteCard(n)).join('');
  },

  refreshScopeModal() {
    const modal = document.querySelector('.journal-modal-overlay[data-scope]');
    if (!modal) return;
    const scope = modal.dataset.scope;
    const meta = {
      global: { title: '🧠 投资心得', addLabel: '✏️ 写心得', hint: '还没有投资心得，点击右下角"写心得"记录你的整体投资经验。' },
      market: { title: '🌐 大盘记录', addLabel: '✏️ 记一笔', hint: '还没有大盘记录，点击右下角"记一笔"记录市场整体观察。' }
    }[scope];
    if (meta) this.renderScopeModalBody(scope, meta);
  },

  closeScopeModal(scope) {
    const modal = document.querySelector(`.journal-modal-overlay[data-scope="${scope}"]`);
    if (modal) modal.remove();
  },

  // ---------- 个股亮点/雷点 渲染（组合在一起，不分开） ----------
  renderStock(symbol, name) {
    const container = document.getElementById('stockNotesContainer');
    if (!container) return;
    if (!symbol) {
      container.innerHTML = `<div class="notes-empty">请先在上方选择一只股票，再记录其亮点与雷点。</div>`;
      return;
    }
    const list = this.notes.filter(n => this._normScope(this._normalize(n).scope) === this._normScope(symbol));
    // 渲染前防御性去重（精确 + 中文近义）：每条亮点/雷点只展示一次，杜绝"措辞不同但意思重复"
    const dedupeByContent = (arr) => {
      const seen = [];
      const out = [];
      for (const n of arr) {
        const c = String(n.content || '').trim().toLowerCase();
        if (!c) { out.push(n); continue; }
        let dup = false;
        for (const s of seen) { if (this._shouldConsolidate(c, s)) { dup = true; break; } }
        if (dup) continue;
        seen.push(c);
        out.push(n);
      }
      return out;
    };
    const highlights = dedupeByContent(list.filter(n => n.aspect === 'highlight'));
    const risks = dedupeByContent(list.filter(n => n.aspect === 'risk'));

    const block = (title, icon, items, aspect) => `
      <div class="sn-block sn-${aspect}">
        <div class="sn-block-head">${icon} ${title} <span class="sn-count">${items.length}</span></div>
        <div class="sn-block-body">
          ${items.length ? items.map(n => this.renderNoteCard(n, true)).join('') :
            `<div class="notes-empty">暂无${title}</div>`}
        </div>
        <button class="btn-journal-add sn-add" onclick="Notes.showForm('${symbol}', '${aspect}')">+ 添加${title}</button>
      </div>`;

    container.innerHTML = `
      <div class="sn-toolbar">
        <div class="sn-title">⭐ ${name || symbol} · 个股亮点与雷点</div>
        <button class="btn-journal-add sn-ai" id="snAiBtn" onclick="Notes.generateAspects('${symbol}', '${(name || symbol).replace(/'/g, "")}')">✨ AI 生成亮点/雷点</button>
        <button class="btn-journal-add" onclick="Notes.dedupeAll()">🧹 清理重复</button>
      </div>
      <div id="snAiStatus" class="sn-ai-status">${this.aiStatusHtml || ''}</div>
      <div class="sn-grid">
        ${block('亮点', '✅', highlights, 'highlight')}
        ${block('雷点', '⚠️', risks, 'risk')}
      </div>`;
  },

  // 手动清理重复：立即去除内容相同或近义的亮点/雷点（不限股票），
  // 写入 localStorage 并重渲染。用于一键消除历史累积的重复条目，无需依赖刷新时机。
  dedupeAll() {
    const seenSim = [];
    const kept = [];
    let removed = 0;
    for (const n of this.notes) {
      const scope = this._normScope(this._normalize(n).scope);
      const aspect = n.aspect || '';
      const c = String(n.content || '').trim().toLowerCase();
      let dup = false;
      if (c) {
        for (const s of seenSim) {
          if (s.scope === scope && s.aspect === aspect && this._shouldConsolidate(c, s.c)) { dup = true; break; }
        }
      }
      if (dup) { removed++; continue; }
      if (c) seenSim.push({ scope, aspect, c });
      kept.push(n);
    }
    if (removed === 0) {
      this.setAiStatus('<span class="sn-status info">ℹ️ 未发现重复条目。</span>', 4000);
      return;
    }
    this.notes = kept;
    this.save();
    if (window.currentStock && window.currentStock.code) {
      this.renderStock(window.currentStock.code, window.currentStock.name);
    }
    this.renderHome();
    this.setAiStatus('<span class="sn-status success">✅ 已清理 ' + removed + ' 条重复亮点/雷点（已自动保存）。</span>', 5000);
  },

  setAiStatus(html, autoClearMs = 0) {
    this.aiStatusHtml = html;
    const el = document.getElementById('snAiStatus');
    if (el) el.innerHTML = html;
    if (this._aiStatusTimer) clearTimeout(this._aiStatusTimer);
    if (autoClearMs > 0) {
      this._aiStatusTimer = setTimeout(() => {
        this.aiStatusHtml = '';
        const e = document.getElementById('snAiStatus');
        if (e) e.innerHTML = '';
      }, autoClearMs);
    }
  },

  // AI 联网分析并自动写入个股亮点/雷点（issue：东方财富类亮点雷点分析自动化）
  // 注意：此 fetch 不绑定标签页生命周期，切换页面后会在后台继续，返回结果通过 snAiStatus 展示。
  // 时效性：每次点击都强制联网重新分析最新公开数据，并先清除本股票已存的 AI 生成亮点/雷点，
  // 避免旧的过期内容堆积；用户手动录入的亮点/雷点不受影响。
  async generateAspects(symbol, name) {
    if (this._aiAspectsPending) return;
    this._aiAspectsPending = true;
    const btn = document.getElementById('snAiBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ AI 分析中...'; }
    this.setAiStatus('<span class="sn-status loading">⏳ AI 正在联网重新分析最新公开数据（年报/公告/新闻），切换页面不会中断...</span>');
    try {
      // 1) 先清除本股票已存的 AI 生成亮点/雷点（时间敏感，刷新旧内容）
      const nsym = this._normScope(symbol);
      const cleared = this.notes.filter(n =>
        this._normScope(this._normalize(n).scope) === nsym &&
        (n.aspect === 'highlight' || n.aspect === 'risk') &&
        n.ai === true
      ).length;
      this.notes = this.notes.filter(n =>
        !(this._normScope(this._normalize(n).scope) === nsym &&
          (n.aspect === 'highlight' || n.aspect === 'risk') &&
          n.ai === true)
      );
      this.save();

      // 2) 强制联网重新分析，不使用任何缓存（force:true 绕过后端 TTL 缓存）
      const resp = await fetch('/api/ai/aspects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, stockName: name, force: true }),
      });
      const data = await resp.json();
      this.renderStock(symbol, name);
      if (!data.success) {
        this.setAiStatus('<span class="sn-status error">❌ AI 生成失败：' + this.escapeHtml(data.message || data.error || '未知错误') + '</span>', 8000);
        return;
      }
      const stockName = name || data.stockName || symbol;
      let added = 0;
      const addList = (items, aspect) => {
        (items || []).forEach((item) => {
          // 20260904a：兼容 {text,outdated} 对象与纯字符串
          const text = (item && typeof item === 'object' && item.text != null) ? String(item.text) : (item == null ? '' : String(item));
          const content = text.trim();
          if (!content) return;
          // 去重：同股票同类型下内容相同或近义（中文二元组相似度）不重复添加
          const dup = this.notes.some(n =>
            this._normScope(this._normalize(n).scope) === this._normScope(symbol) && n.aspect === aspect &&
            this._shouldConsolidate(String(n.content || ''), content));
          if (dup) return;
          this.add({ scope: symbol, aspect, stockCode: symbol, stockName, title: aspect === 'highlight' ? 'AI 亮点' : 'AI 雷点', content, type: 'ai', ai: true });
          added++;
        });
      };
      addList(data.highlights, 'highlight');
      addList(data.risks, 'risk');
      this.renderStock(symbol, stockName);
      if (added === 0) {
        const tail = cleared ? `（已清除 ${cleared} 条旧 AI 记录，但新分析与现有内容重复，故未新增）。` : '。';
        this.setAiStatus('<span class="sn-status info">ℹ️ 联网分析完成，但内容与现有记录重复，未新增' + tail + '</span>', 6000);
      } else {
        const clearedNote = cleared ? `（已先清除 ${cleared} 条旧 AI 记录）` : '';
        this.setAiStatus('<span class="sn-status success">✅ AI 已联网重新分析并写入 ' + added + ' 条亮点/雷点（基于最新公开数据）' + clearedNote + '。可在卡片上点「验证」核验。</span>', 6000);
      }
    } catch (e) {
      this.renderStock(symbol, name);
      this.setAiStatus('<span class="sn-status error">❌ AI 生成失败：' + this.escapeHtml(e.message) + '</span>', 8000);
    } finally {
      this._aiAspectsPending = false;
      const b = document.getElementById('snAiBtn');
      if (b) { b.disabled = false; b.textContent = '✨ AI 生成亮点/雷点'; }
    }
  },

  renderNoteCard(note, compact = false) {
    const date = new Date(note.date).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const badge = note.aspect === 'highlight' ? '<span class="sn-tag hl">亮点</span>'
                : note.aspect === 'risk' ? '<span class="sn-tag rk">雷点</span>' : '';
    const aiTag = note.ai ? '<span class="sn-tag ai">🤖 AI</span>' : '';
    const ver = this.getVerificationBadge(note.verification);
    const scopeLabel = note.scope === 'global' ? '💡 投资心得'
                     : note.scope === 'market' ? '🌐 大盘记录'
                     : (note.stockName ? `${note.stockName}` : '');
    return `
      <div class="note-card" data-id="${note.id}">
        <div class="note-card-head">
          ${badge}
          ${aiTag}
          ${scopeLabel ? `<span class="note-scope">${scopeLabel}</span>` : ''}
          <span class="note-date">${date}</span>
        </div>
        <div class="note-title">${this.escapeHtml(note.title)}</div>
        <div class="note-content">${this.escapeHtml(note.content).replace(/\n/g, '<br>')}</div>
        ${note.verification && note.verification.status !== 'pending' ? `<div class="note-ver">${ver}</div>` : ''}
        <div class="note-actions">
          <button class="btn-verify" onclick="Notes.verify('${note.id}')">🔍 验证</button>
          ${(note.aspect === 'highlight' || note.aspect === 'risk') ? `<button class="btn-set-main ${note.mainFor ? 'is-main' : ''}" onclick="Notes.setAsMain('${note.id}')" title="把此条设为该股的「最大亮点」或「最大雷点」，会替换概览页右上角那张卡片的内容并持久化。${note.mainFor ? '（当前已是主项）' : ''}">⭐ ${note.mainFor ? '已是主项' : '设为主'}</button>` : ''}
          <button class="btn-edit" onclick="Notes.showEditForm('${note.id}')">编辑</button>
          <button class="btn-delete" onclick="Notes.confirmDelete('${note.id}')">删除</button>
        </div>
      </div>`;
  },

  getVerificationBadge(verification) {
    const badges = {
      pending: '<span class="ver-badge pending">⏳ 待验证</span>',
      checking: '<span class="ver-badge checking">⏳ 验证中...</span>',
      verified: '<span class="ver-badge verified">✅ 已验证</span>',
      partially_verified: '<span class="ver-badge partial">⚠️ 部分验证</span>',
      unverified: '<span class="ver-badge unverified">❌ 未验证</span>',
      error: '<span class="ver-badge error">⚠️ 验证失败</span>',
    };
    return badges[verification?.status] || badges.pending;
  },

  // ---------- 表单 ----------
  showForm(scope, aspect = null) {
    const isStock = scope !== 'global' && scope !== 'market';
    const defaults = isStock
      ? { stockCode: scope, stockName: window.currentStock?.name || '' }
      : { stockCode: '', stockName: '' };
    this.showFormInner(null, { scope, aspect, ...defaults });
  },

  showEditForm(id) {
    const note = this.notes.find(n => n.id === id);
    if (note) this.showFormInner(note, { scope: note.scope, aspect: note.aspect });
  },

  showFormInner(existing, ctx) {
    const note = existing || {};
    const isEdit = !!existing;
    const aspectOptions = ctx.scope !== 'global' && ctx.scope !== 'market'
      ? `<div class="form-row">
           <label>类型</label>
           <select id="noteAspect">
             <option value="highlight" ${ctx.aspect === 'highlight' || note.aspect === 'highlight' ? 'selected' : ''}>✅ 亮点</option>
             <option value="risk" ${ctx.aspect === 'risk' || note.aspect === 'risk' ? 'selected' : ''}>⚠️ 雷点</option>
           </select>
         </div>` : '';
    const stockRow = (ctx.scope === 'global' || ctx.scope === 'market') ? '' : `
      <div class="form-row">
        <label>关联股票</label>
        <div class="form-stock-input">
          <input type="text" id="noteStockCode" placeholder="股票代码" value="${note.stockCode || ctx.stockCode || ''}" style="width:30%">
          <input type="text" id="noteStockName" placeholder="股票名称" value="${note.stockName || ctx.stockName || ''}" style="width:65%">
        </div>
      </div>`;

    const modal = document.createElement('div');
    modal.className = 'journal-modal-overlay form-modal';
    modal.innerHTML = `
      <div class="journal-modal">
        <h3>${isEdit ? '编辑记录' : '新建记录'}</h3>
        <div class="journal-form">
          ${aspectOptions}
          ${stockRow}
          <div class="form-row">
            <label>标题</label>
            <input type="text" id="noteTitle" placeholder="简要概述" value="${this.escapeHtml(note.title || '')}">
          </div>
          <div class="form-row">
            <label>内容</label>
            <textarea id="noteContent" rows="8" placeholder="详细记录...">${this.escapeHtml(note.content || '')}</textarea>
          </div>
          <div class="form-row">
            <label>标签 (逗号分隔)</label>
            <input type="text" id="noteTags" placeholder="如: 估值,政策" value="${(note.tags || []).join(', ')}">
          </div>
          <div class="form-actions">
            <button class="btn-cancel" onclick="Notes.closeForm()">取消</button>
            <button class="btn-save" onclick="Notes.saveForm(${isEdit ? `'${note.id}'` : 'null'}, '${ctx.scope}', '${ctx.aspect || ''}')">${isEdit ? '更新' : '保存'}</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => { if (e.target === modal) this.closeForm(); });
  },

  saveForm(id, scope, aspect) {
    const title = document.getElementById('noteTitle').value.trim();
    const content = document.getElementById('noteContent').value.trim();
    const tagsStr = document.getElementById('noteTags').value.trim();
    const tags = tagsStr ? tagsStr.split(/[,，]/).map(t => t.trim()).filter(Boolean) : [];
    const aspectEl = document.getElementById('noteAspect');
    const aspectVal = aspectEl ? aspectEl.value : (aspect || null);
    const codeEl = document.getElementById('noteStockCode');
    const nameEl = document.getElementById('noteStockName');
    const stockCode = codeEl ? codeEl.value.trim() : '';
    const stockName = nameEl ? nameEl.value.trim() : '';

    if (!title) { alert('请输入标题'); return; }

    const payload = {
      scope,
      aspect: (scope !== 'global' && scope !== 'market') ? aspectVal : null,
      stockCode, stockName, title, content, tags,
    };

    if (id) this.update(id, payload);
    else this.add(payload);

    this.closeForm();
    this.renderHome();
    this.refreshScopeModal();
    if (stockCode) this.renderStock(stockCode, stockName);
  },

  closeForm() {
    const modal = document.querySelector('.journal-modal-overlay.form-modal');
    if (modal) modal.remove();
  },

  confirmDelete(id) {
    const note = this.notes.find(n => n.id === id);
    if (note && confirm(`确定删除"${note.title}"？`)) {
      const scope = note.scope;
      this.remove(id);
      this.renderHome();
      this.refreshScopeModal();
      if (scope && scope !== 'global' && scope !== 'market') this.renderStock(scope, note.stockName);
    }
  },

  // 20260904a：把指定 highlight/risk 条目标记为该股的「最大亮点」或「最大雷点」。
  // 同一 scope（同只股票）下只允许一条 highlight 主项 + 一条 risk 主项；新设的会覆盖旧的。
  setAsMain(id) {
    const note = this.notes.find(n => n.id === id);
    if (!note) return;
    if (note.aspect !== 'highlight' && note.aspect !== 'risk') {
      alert('只有「亮点」「雷点」条目可以设为主项');
      return;
    }
    // 同 scope 同 aspect 下，清掉旧的主项标记（避免重复）
    this.notes.forEach(n => {
      if (n.scope === note.scope && n.aspect === note.aspect) n.mainFor = false;
    });
    // 当前项标记为新的主项
    note.mainFor = true;
    this.save();
    // 重渲染当前股票 + 触发概览最大亮点/雷点卡片刷新
    if (note.scope && note.scope !== 'global' && note.scope !== 'market') {
      this.renderStock(note.scope, note.stockName);
      // 触发 App._loadAspectBrief：用股票代码 + 当前名称（App 那边有 currentSymbol/currentData）
      if (window.App && typeof App._loadAspectBrief === 'function') {
        try { App._loadAspectBrief(note.scope, note.stockName); } catch (e) { console.warn('refresh aspect card failed', e); }
      }
      this.setAiStatus('<span class="sn-status success">⭐ 已将此条设为该股的最大' + (note.aspect === 'highlight' ? '亮点' : '雷点') + '，概览卡已同步刷新。</span>', 4000);
    }
  },

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },
};

if (typeof window !== 'undefined') window.Notes = Notes;
if (typeof module !== 'undefined' && module.exports) module.exports = Notes;
