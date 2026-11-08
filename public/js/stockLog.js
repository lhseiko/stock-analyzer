// stockLog.js — 个股行情判断记录（20261107 升级：原「个股记录」改为行情判断记录）
// 20261108a：新增「涨跌幅判断正确率」——系统按真实日K自动结算，对的显示 ✓、错的显示 ✗，
//            右上角展示当前准确率；两个下拉菜单非必填，未填方向不纳入准确率统计。
// 落盘 data/stock-log/<代码>.json。纯手动记录 + 模块内自统计，不参与任何判断/评分/回测。
// 列表按日期先后（正序）排列；支持关键词检索 + 方向/依据筛选 + 排序切换（先后/倒序）。
(function () {
  'use strict';

  // 与后端 lib/stockLog.js 同源的枚举显示名（A 股：红涨绿跌）
  const DIR_LABEL = { up: '上涨', sideways: '震荡', down: '下跌' };
  const BASIS_LABEL = { technical: '技术面', news: '消息面', other: '其他' };

  // 20261108a：勾 / 叉 / 待验证图标（inline SVG，形状本身即语义，颜色只作辅助）
  const ICON_OK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.4l3.1 3.1 6.5-6.6"/></svg>';
  const ICON_BAD = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2"/></svg>';
  const ICON_PENDING = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.2" cy="8" r="1.05"/><circle cx="8" cy="8" r="1.05"/><circle cx="11.8" cy="8" r="1.05"/></svg>';

  const S = { symbol: null, name: null, loaded: null, items: [], accuracy: null };
  let editingId = null;
  const filters = { q: '', dir: '', basis: '' };
  let sortDir = 'asc'; // asc = 日期先后（正序）；desc = 倒序

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // 本地时区今天（toISOString 是 UTC，晚上 8 点后日期会错一天）
  function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function signedPct(v) {
    if (v == null || !isFinite(Number(v))) return '缺失';
    const n = Number(v);
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  // 方向徽标（A 股：上涨红 / 下跌绿 / 震荡灰；未填方向显示「未填」）
  function dirClass(d) {
    if (d === 'up') return 'sl-dir-up';
    if (d === 'down') return 'sl-dir-down';
    if (d === 'sideways') return 'sl-dir-sideways';
    return 'sl-dir-na';
  }
  function dirBadge(d) {
    return '<span class="sl-dir ' + dirClass(d) + '">' + esc(DIR_LABEL[d] || '未填') + '</span>';
  }
  function basisBadge(b) {
    if (!b) return '<span class="sl-basis sl-basis-na" title="未选择判断依据">未填依据</span>';
    return '<span class="sl-basis sl-basis-' + esc(b) + '">' + esc(BASIS_LABEL[b] || '其他') + '</span>';
  }

  // 20261108a：结算结果徽标。未填涨跌方向 → 不显示图标（不纳入统计）；
  // 待验证 → 灰色省略号；已判定 → ✓ / ✗，title 附实际涨跌幅与验证日便于核对。
  function verdictBadge(it) {
    if (!it || !it.direction) return '';
    const actual = (it.actualChgPct == null) ? '实际涨跌幅缺失'
      : `${it.actualDate || '验证日缺失'} 实际 ${signedPct(it.actualChgPct)}（${DIR_LABEL[it.actualDirection] || '—'}）`;
    if (it.verdict === 'correct') {
      return '<span class="sl-verdict sl-verdict-ok" title="' + esc('判断正确｜' + actual) + '">' + ICON_OK + '<span class="sl-verdict-txt">对</span></span>';
    }
    if (it.verdict === 'wrong') {
      return '<span class="sl-verdict sl-verdict-bad" title="' + esc('判断错误｜' + actual) + '">' + ICON_BAD + '<span class="sl-verdict-txt">错</span></span>';
    }
    return '<span class="sl-verdict sl-verdict-pending" title="' + esc('待验证：验证日行情尚未生成或日K取数失败，不计入准确率') + '">' + ICON_PENDING + '<span class="sl-verdict-txt">待验证</span></span>';
  }

  // 20261108b：单行胶囊标签只放「标签 + 数值 + 最短计数」；
  // 完整明细与口径收进 title，避免把标签撑成大方块、把标题行拉高。
  function renderAccuracy(acc) {
    const box = $('slAccuracy'), rateEl = $('slAccRate'), detailEl = $('slAccDetail');
    if (!box || !rateEl || !detailEl) return;
    const caliber = (acc && acc.caliber) || '按真实日K自动结算';
    if (!acc) {
      rateEl.textContent = '—';
      detailEl.textContent = '尚无记录';
      box.title = '涨跌幅判断准确率：' + caliber + '；未填方向不纳入统计。';
      box.className = 'sl-acc';
      return;
    }
    rateEl.textContent = acc.rateText || '—';
    detailEl.textContent = acc.judged ? `对 ${acc.correct} · 错 ${acc.wrong}` : '暂无判定';
    const tip = [
      caliber + '。',
      '分母只含「有涨跌方向 + 已判定」的记录。',
      `已判定 ${acc.judged} 条（对 ${acc.correct} / 错 ${acc.wrong}）`,
    ];
    if (acc.pending) tip.push(`待验证 ${acc.pending} 条（验证日行情未生成或日K不可得，不计入）`);
    if (acc.noDirection) tip.push(`未填涨跌方向 ${acc.noDirection} 条，不计入`);
    box.title = tip.join('\n');
    box.className = 'sl-acc' + (acc.judged ? ' sl-acc-has' : '');
  }

  // 检索（备注/日期/方向/依据，含「未填」）+ 方向筛选 + 依据筛选 + 排序
  function visibleItems() {
    let arr = S.items.slice();
    const q = (filters.q || '').trim().toLowerCase();
    if (q) {
      arr = arr.filter(it => {
        const hay = [it.note, it.date, DIR_LABEL[it.direction] || '未填', BASIS_LABEL[it.basis] || '未填依据']
          .map(x => String(x || '').toLowerCase()).join(' ');
        return hay.indexOf(q) !== -1;
      });
    }
    if (filters.dir) arr = arr.filter(it => it.direction === filters.dir);
    if (filters.basis) arr = arr.filter(it => it.basis === filters.basis);
    arr.sort((a, b) => {
      const c = (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || '');
      return sortDir === 'asc' ? c : -c;
    });
    return arr;
  }

  function render() {
    const box = $('stockLogContainer');
    renderAccuracy(S.accuracy);
    if (!box) return;
    const items = visibleItems();
    if (!items.length) {
      const hasFilter = filters.q || filters.dir || filters.basis;
      box.innerHTML = '<div class="sl-empty">' +
        (hasFilter ? '没有符合检索/筛选条件的记录' :
          '暂无记录——用上方表单添加该个股的行情判断，按日期先后排列') + '</div>';
      return;
    }
    box.innerHTML = items.map(it => {
      // 编辑态：该条替换为行内编辑表单（日期 + 方向 + 依据 + 备注 + 保存/取消）
      if (editingId === it.id) {
        const dirOpts = '<option value=""' + (!it.direction ? ' selected' : '') + '>未选方向</option>' +
          ['up', 'sideways', 'down'].map(d =>
            '<option value="' + d + '"' + (it.direction === d ? ' selected' : '') + '>' + DIR_LABEL[d] + '</option>').join('');
        const basisOpts = '<option value=""' + (!it.basis ? ' selected' : '') + '>未选依据</option>' +
          ['technical', 'news', 'other'].map(b =>
            '<option value="' + b + '"' + (it.basis === b ? ' selected' : '') + '>' + BASIS_LABEL[b] + '</option>').join('');
        return '<div class="sl-item sl-editing">' +
          '<div class="sl-edit-form">' +
            '<div class="sl-edit-row">' +
              '<input type="date" class="sl-edit-date" value="' + esc(it.date) + '">' +
              '<select class="sl-edit-dir">' + dirOpts + '</select>' +
              '<select class="sl-edit-basis">' + basisOpts + '</select>' +
            '</div>' +
            '<textarea class="sl-edit-note" rows="3">' + esc(it.note) + '</textarea>' +
            '<div class="sl-edit-actions">' +
              '<button class="sl-save" data-id="' + esc(it.id) + '">保存</button>' +
              '<button class="sl-cancel">取消</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }
      return '<div class="sl-item">' +
        '<div class="sl-main">' +
          '<div class="sl-tags">' + dirBadge(it.direction) + verdictBadge(it) + basisBadge(it.basis) +
            '<span class="sl-date">📅 ' + esc(it.date) + '</span></div>' +
          '<div class="sl-note">' + esc(it.note).replace(/\n/g, '<br>') + '</div>' +
        '</div>' +
        '<div class="sl-btns">' +
          '<button class="sl-edit" data-id="' + esc(it.id) + '" title="修改该条记录">修改</button>' +
          '<button class="sl-del" data-id="' + esc(it.id) + '" title="删除该条记录">删除</button>' +
        '</div>' +
      '</div>';
    }).join('');
    // 进入编辑态后聚焦文本框并定位到末尾，方便直接续写
    if (editingId) {
      const ta = box.querySelector('.sl-edit-note');
      if (ta) { ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* ignore */ } }
    }
  }

  async function refresh(force) {
    if (!S.symbol) return;
    // 已加载过且未强制刷新：仅重新渲染（筛选/排序切换无需重拉）
    if (!force && S.loaded === S.symbol) { render(); return; }
    const box = $('stockLogContainer');
    if (!box) return;
    box.innerHTML = '<div class="sl-empty">加载中…</div>';
    try {
      const resp = await fetch('/api/stock-log/' + encodeURIComponent(S.symbol));
      const data = await resp.json();
      S.items = (data && data.items) || [];
      S.accuracy = (data && data.accuracy) || null;
      S.loaded = S.symbol;
      editingId = null;
      render();
    } catch (e) {
      box.innerHTML = '<div class="sl-empty">记录加载失败：' + esc(e && e.message) + '</div>';
    }
  }

  async function add() {
    if (!S.symbol) { alert('请先选择个股'); return; }
    const dateEl = $('slDate');
    const dirEl = $('slDir');
    const basisEl = $('slBasis');
    const noteEl = $('slNote');
    const date = (dateEl && dateEl.value) || todayStr();
    // 20261108a：两个下拉允许空值，空字符串直接透传，后端存 null
    const direction = dirEl ? dirEl.value : '';
    const basis = basisEl ? basisEl.value : '';
    const note = (noteEl && noteEl.value || '').trim();
    if (!note) { alert('请先填写备注内容'); return; }
    const btn = $('slAdd');
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch('/api/stock-log/' + encodeURIComponent(S.symbol), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, direction, basis, note }),
      });
      const data = await resp.json();
      if (!data || !data.success) { alert('添加失败：' + ((data && data.error) || '未知错误')); return; }
      if (noteEl) noteEl.value = '';
      await refresh(true);
    } catch (e) {
      alert('添加失败：' + (e && e.message));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function remove(id) {
    if (!S.symbol || !id) return;
    if (!window.confirm('删除这条记录？删除后不可恢复。')) return;
    try {
      await fetch('/api/stock-log/' + encodeURIComponent(S.symbol) + '/' + encodeURIComponent(id), { method: 'DELETE' });
      await refresh(true);
    } catch (e) {
      alert('删除失败：' + (e && e.message));
    }
  }

  function startEdit(id) { editingId = id; render(); }
  function cancelEdit() { editingId = null; render(); }

  async function saveEdit() {
    if (!S.symbol || !editingId) return;
    const box = $('stockLogContainer');
    const form = box && box.querySelector('.sl-item.sl-editing');
    if (!form) { editingId = null; render(); return; }
    const dateEl = form.querySelector('.sl-edit-date');
    const dirEl = form.querySelector('.sl-edit-dir');
    const basisEl = form.querySelector('.sl-edit-basis');
    const noteEl = form.querySelector('.sl-edit-note');
    const date = (dateEl && dateEl.value) || '';
    const direction = dirEl ? dirEl.value : '';
    const basis = basisEl ? basisEl.value : '';
    const note = ((noteEl && noteEl.value) || '').trim();
    if (!note) { alert('备注不能为空'); return; }
    const btn = form.querySelector('.sl-save');
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch('/api/stock-log/' + encodeURIComponent(S.symbol) + '/' + encodeURIComponent(editingId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, direction, basis, note }),
      });
      const data = await resp.json();
      if (!data || !data.success) {
        alert('保存失败：' + ((data && data.error) || '未知错误'));
        if (btn) btn.disabled = false;
        return;
      }
      editingId = null;
      await refresh(true);
    } catch (e) {
      alert('保存失败：' + (e && e.message));
      if (btn) btn.disabled = false;
    }
  }

  // 检索/筛选：读取工具栏控件并实时过滤重渲染
  function applyFilters() {
    const qEl = $('slSearch');
    const dirEl = $('slFilterDir');
    const basisEl = $('slFilterBasis');
    filters.q = qEl ? qEl.value : '';
    filters.dir = dirEl ? dirEl.value : '';
    filters.basis = basisEl ? basisEl.value : '';
    // 不重拉数据，仅前端过滤（S.loaded 可能已加载）
    if (S.loaded === S.symbol) render();
    else refresh(true);
  }

  function toggleSort() {
    sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    const btn = $('slSortBtn');
    if (btn) btn.textContent = sortDir === 'asc' ? '日期↑（先后）' : '日期↓（倒序）';
    render();
  }

  window.StockLog = {
    // 切股挂钩（app.js analyze / switchTab 调用）：同股已加载则跳过，避免重复拉取
    setStock(symbol, name) {
      if (S.symbol === symbol && S.loaded === symbol) return;
      S.symbol = symbol; S.name = name; S.loaded = null;
      S.items = []; S.accuracy = null;
      editingId = null;
      // 切股时重置检索/筛选/排序
      filters.q = ''; filters.dir = ''; filters.basis = '';
      sortDir = 'asc';
      const qEl = $('slSearch'); if (qEl) qEl.value = '';
      const fDir = $('slFilterDir'); if (fDir) fDir.value = '';
      const fBasis = $('slFilterBasis'); if (fBasis) fBasis.value = '';
      const sortBtn = $('slSortBtn'); if (sortBtn) sortBtn.textContent = '日期↑（先后）';
      renderAccuracy(null);
      refresh();
    },
    init() {
      const dateEl = $('slDate');
      if (dateEl && !dateEl.value) dateEl.value = todayStr();
      const addBtn = $('slAdd');
      if (addBtn) addBtn.addEventListener('click', add);
      const noteEl = $('slNote');
      if (noteEl) noteEl.addEventListener('keydown', (ev) => {
        if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') add();
      });
      // 检索 / 方向筛选 / 依据筛选 / 排序切换
      const searchEl = $('slSearch');
      if (searchEl) searchEl.addEventListener('input', applyFilters);
      const fDir = $('slFilterDir');
      if (fDir) fDir.addEventListener('change', applyFilters);
      const fBasis = $('slFilterBasis');
      if (fBasis) fBasis.addEventListener('change', applyFilters);
      const sortBtn = $('slSortBtn');
      if (sortBtn) {
        sortBtn.textContent = '日期↑（先后）';
        sortBtn.addEventListener('click', toggleSort);
      }
      renderAccuracy(null);
      const box = $('stockLogContainer');
      if (box) {
        box.addEventListener('click', (ev) => {
          const del = ev.target.closest('.sl-del');
          if (del) { remove(del.dataset.id); return; }
          const edit = ev.target.closest('.sl-edit');
          if (edit) { startEdit(edit.dataset.id); return; }
          if (ev.target.closest('.sl-cancel')) { cancelEdit(); return; }
          if (ev.target.closest('.sl-save')) { saveEdit(); return; }
        });
        // 编辑框是动态生成的：快捷键用容器级事件委托（Ctrl+Enter 保存 / Esc 取消）
        box.addEventListener('keydown', (ev) => {
          if (!editingId) return;
          if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); saveEdit(); }
          else if (ev.key === 'Escape' && ev.target && ev.target.classList && ev.target.classList.contains('sl-edit-note')) {
            cancelEdit();
          }
        });
      }
    },
  };
})();
