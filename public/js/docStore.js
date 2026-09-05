/**
 * Document Store UI
 * 资料库管理界面 — 上传、浏览、搜索、删除公司文档
 */
const DocStore = (function () {

  let currentStockCode = null;
  let currentStockName = null;
  let allCompanies = [];
  let stats = {};
  let viewMode = 'current'; // 'current' = 当前股票, 'all' = 全部公司

  const DOC_TYPE_ICONS = {
    annual: '📋', semi: '📅', quarterly: '📅', announcement: '📢', research: '📊', other: '📄',
  };
  const DOC_TYPE_LABELS = {
    annual: '年报', semi: '半年报', quarterly: '季报', announcement: '公告', research: '研报', other: '其他',
  };

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // 从当前股票代码中提取纯 6 位数字代码（兼容 SH600519 / sh600519 / 600519 等格式）
  function currentCode6() {
    const m = String(currentStockCode || '').match(/\d{6}/);
    return m ? m[0] : '';
  }

  function getFileIcon(fileType) {
    const ext = (fileType || '').toLowerCase();
    if (['.pdf'].includes(ext)) return '📕';
    if (['.doc', '.docx'].includes(ext)) return '📘';
    if (['.xls', '.xlsx', '.csv'].includes(ext)) return '📗';
    if (['.ppt', '.pptx'].includes(ext)) return '📙';
    if (['.jpg', '.jpeg', '.png', '.gif', '.bmp'].includes(ext)) return '🖼️';
    if (['.txt', '.md'].includes(ext)) return '📝';
    if (['.html', '.htm'].includes(ext)) return '🌐';
    return '📄';
  }

  // ---- 主渲染 ----
  function render() {
    const container = document.getElementById('docStoreContainer');
    if (!container) return;

    const stockCode = currentStockCode || '';
    const stockName = currentStockName || '';
    const curCode = currentCode6(); // 下载年报默认使用当前股票，无需再手输代码

    container.innerHTML = `
      <div class="docs-header">
        <div class="docs-title">
          <h3>📁 公司资料库</h3>
          <span class="docs-subtitle" id="docsSubtitle">${stockName ? stockName + ' (' + stockCode + ')' : '请先选择股票'}</span>
        </div>
        <div class="docs-stats" id="docsStats"></div>
      </div>

      <div class="docs-toolbar">
        <div class="docs-view-toggle">
          <button class="docs-view-btn ${viewMode === 'current' ? 'active' : ''}" data-view="current">当前股票</button>
          <button class="docs-view-btn ${viewMode === 'all' ? 'active' : ''}" data-view="all">全部公司</button>
        </div>
        <div class="docs-search-box">
          <input type="text" id="docsSearchInput" placeholder="搜索文档标题、公司名、年份..." class="docs-search-input" />
          <button id="docsSearchBtn" class="docs-search-btn">🔍</button>
        </div>
        ${stockCode ? `<button class="docs-upload-btn" id="docsUploadBtn">📤 上传</button><button class="docs-batch-btn" id="docsBatchBtn">📚 批量上传</button>` : ''}
      </div>

      <div id="docsContent" class="docs-content">
        <div class="docs-loading">加载中...</div>
      </div>

      <!-- 批量下载年报 / 半年报（巨潮资讯网） -->
      <div class="docs-report-card" id="reportDownloadCard">
        <div class="drc-header">
          <h4>📥 下载年报 / 半年报 / 季报</h4>
          <span class="drc-hint">默认数据源：巨潮资讯网（已修复） · 进入资料库自动获取 · 自动跳过已下载文件</span>
        </div>
        <div class="drc-row drc-target-row">
          <span class="drc-target ${curCode ? '' : 'drc-target-empty'}">${curCode
            ? `📌 当前股票：<b>${stockName ? stockName + ' ' : ''}${curCode}</b> · 直接点「开始下载」即可，无需输入代码`
            : '⚠️ 尚未选择股票，请先在页面上方搜索并选择一只股票'}</span>
          <button type="button" class="drc-btn-sm drc-more-toggle" id="reportMoreToggle">＋ 追加其他股票</button>
        </div>
        <div class="drc-row drc-extra-row" id="reportExtraRow" style="display:none">
          <input type="text" id="reportCodes" class="drc-input" placeholder="可选：追加其他股票代码，逗号分隔（如 601857,000001）。留空则只下载当前股票" />
        </div>
        <div class="drc-row">
          <label class="drc-label">回溯</label>
          <select id="reportYears" class="drc-select">
            <option value="3">3 年</option>
            <option value="5" selected>5 年</option>
            <option value="8">8 年</option>
            <option value="10">10 年</option>
          </select>
          <label class="drc-label">类型</label>
          <label class="drc-check"><input type="checkbox" id="typeAnnual" checked /> 年报</label>
          <label class="drc-check"><input type="checkbox" id="typeSemi" checked /> 半年报</label>
          <label class="drc-check"><input type="checkbox" id="typeQuarterly" checked /> 季报</label>
          <label class="drc-label">通道</label>
          <select id="reportChannel" class="drc-select">
            <option value="cninfo" selected>巨潮资讯网（推荐·已修复）</option>
            <option value="eastmoney">东方财富（部分网络受限）</option>
            <option value="all">全部通道</option>
          </select>
          <button id="reportDownloadBtn" class="drc-btn">⬇️ 开始下载</button>
          <button id="reportProbeBtn" class="drc-btn drc-btn-ghost">🔍 诊断参数</button>
        </div>
        <div id="reportDownloadResult" class="drc-result"></div>
      </div>

      <!-- 隐藏的上传input -->
      <input type="file" id="docsFileInput" style="display:none" />
      <input type="file" id="docsBatchInput" multiple style="display:none" />
    `;

    // 绑定事件
    container.querySelectorAll('.docs-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        viewMode = btn.dataset.view;
        render();
      });
    });

    const uploadBtn = container.querySelector('#docsUploadBtn');
    if (uploadBtn) uploadBtn.addEventListener('click', showUploadDialog);
    const batchBtn = container.querySelector('#docsBatchBtn');
    if (batchBtn) batchBtn.addEventListener('click', showBatchUploadDialog);

    const searchInput = container.querySelector('#docsSearchInput');
    const searchBtn = container.querySelector('#docsSearchBtn');
    if (searchInput) {
      searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(searchInput.value); });
    }
    if (searchBtn) searchBtn.addEventListener('click', () => doSearch(searchInput.value));

    // 加载数据
    if (viewMode === 'current' && stockCode) {
      loadCompanyDocs(stockCode);
    } else if (viewMode === 'all') {
      loadAllCompanies();
    } else {
      // 当前股票视图下若尚未选择股票，提示选择而非误展示其他公司的资料
      const content = container.querySelector('#docsContent');
      if (content) {
        content.innerHTML = `
          <div class="docs-empty">
            <div class="docs-empty-icon">📂</div>
            <p>请先在上方选择一只股票，再查看其本地资料库</p>
          </div>
        `;
      }
    }

    // 加载统计
    loadStats();

    // 绑定批量下载年报事件
    const dlBtn = container.querySelector('#reportDownloadBtn');
    if (dlBtn) dlBtn.addEventListener('click', () => doReportDownload());
    const probeBtn = container.querySelector('#reportProbeBtn');
    if (probeBtn) probeBtn.addEventListener('click', () => doReportProbe());
    // 「追加其他股票」折叠开关：默认隐藏输入框，保持"默认下载当前个股"的简洁体验
    const moreToggle = container.querySelector('#reportMoreToggle');
    const extraRow = container.querySelector('#reportExtraRow');
    if (moreToggle && extraRow) {
      moreToggle.addEventListener('click', () => {
        const show = extraRow.style.display === 'none';
        extraRow.style.display = show ? '' : 'none';
        moreToggle.textContent = show ? '－ 收起' : '＋ 追加其他股票';
        if (show) { const i = extraRow.querySelector('#reportCodes'); if (i) i.focus(); }
      });
    }
  }

  // ---- 进入资料库自动抓取年报/半年报（默认东方财富）----
  // 防抖 + 每股票每日仅触发一次，避免重复拉取
  let autoFetchTimer = null;
  const autoFetchedToday = {}; // { 'code-YYYY-MM-DD': true }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
  async function autoFetchReports() {
    const code = currentCode6();
    if (!code) return;
    const today = (function () { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; })();
    const key = `${code}-${today}`;
    if (autoFetchedToday[key]) return; // 今天已经自动抓过
    autoFetchedToday[key] = true;

    const resultEl = document.getElementById('reportDownloadResult');
    const btn = document.getElementById('reportDownloadBtn');
    try {
      if (resultEl) resultEl.innerHTML = `<div class="drc-msg info">🔄 已自动从 <b>巨潮资讯网</b> 获取 ${esc(code)} 近年年报/半年报并登记进资料库…</div>`;
      const resp = await fetch('/api/reports/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes: [code], years: 5, types: ['annual', 'semi'], channel: 'cninfo' }),
      });
      const data = await resp.json();
      if (data.ok && data.summary) {
        const s = data.summary;
        const got = s.downloaded || 0;
        const skip = s.skipped || 0;
        const parts = [];
        if (got > 0) parts.push(`新下载 <b>${got}</b> 份`);
        if (skip > 0) parts.push(`已存在 <b>${skip}</b> 份`);
        if (s.errors > 0) parts.push(`失败 <b>${s.errors}</b> 份`);
        const msg = parts.length ? parts.join('，') : '没有新的年报/半年报';
        if (resultEl) resultEl.innerHTML = `<div class="drc-msg ok">✅ 自动获取完成（巨潮资讯网）：${msg}。点击「开始下载」可重新抓取或用其他通道。</div>`;
      } else if (data.error) {
        if (resultEl) resultEl.innerHTML = `<div class="drc-msg warn">⚠️ 自动获取失败：${esc(data.error)}</div>`;
      } else {
        if (resultEl) resultEl.innerHTML = `<div class="drc-msg warn">⚠️ 自动获取未完成（可能网络受限）。可点「开始下载」手动重试或改用「东方财富」通道。</div>`;
      }
    } catch (e) {
      if (resultEl) resultEl.innerHTML = `<div class="drc-msg warn">⚠️ 自动获取异常：${esc(e.message)}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⬇️ 开始下载'; }
    }
  }

  // ---- 批量下载年报 / 半年报 ----
  async function doReportDownload() {
    const codesInput = document.getElementById('reportCodes');
    const yearsEl = document.getElementById('reportYears');
    const annualEl = document.getElementById('typeAnnual');
    const semiEl = document.getElementById('typeSemi');
    const quarterlyEl = document.getElementById('typeQuarterly');
    const channelEl = document.getElementById('reportChannel');
    const resultEl = document.getElementById('reportDownloadResult');
    if (!resultEl) return;

    // 默认下载"当前个股"，输入框仅用于追加其他股票（可留空）
    const cur = currentCode6();
    const extra = ((codesInput && codesInput.value) || '')
      .split(/[,\s]+/).map(c => c.trim()).filter(Boolean);
    const codes = (cur ? [cur] : []).concat(extra.filter(c => c !== cur));
    if (codes.length === 0) {
      resultEl.innerHTML = `<div class="drc-msg warn">请先在页面上方搜索并选择一只股票（或展开「追加其他股票」手动输入代码）。</div>`;
      return;
    }
    const years = parseInt(yearsEl?.value || '5', 10);
    const types = [];
    const typeLabels = [];
    if (annualEl?.checked) { types.push('annual'); typeLabels.push('年报'); }
    if (semiEl?.checked) { types.push('semi'); typeLabels.push('半年报'); }
    // 季报 → 下载一季报(q1) + 三季报(q3)；中报(semi)/年报(annual) 为独立类型
    if (quarterlyEl?.checked) { types.push('q1', 'q3'); typeLabels.push('季报'); }
    if (types.length === 0) {
      resultEl.innerHTML = `<div class="drc-msg warn">请至少选择一种报告类型。</div>`;
      return;
    }
    const channel = channelEl?.value || 'cninfo';
    const channelName = { cninfo: '巨潮资讯网', eastmoney: '东方财富', all: '全部通道(巨潮+东方财富)' }[channel] || '巨潮资讯网';

    const btn = document.getElementById('reportDownloadBtn');
    btn.disabled = true;
    btn.textContent = '⏳ 下载中...';
    resultEl.innerHTML = `<div class="drc-msg info">正在从 <b>${channelName}</b> 下载 ${codes.length} 只股票的${typeLabels.join('/')}报告（回溯 ${years} 年），请稍候...</div>`;

    try {
      const resp = await fetch('/api/reports/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codes, years, types, channel }),
      });
      const data = await resp.json();
      if (data.ok && data.summary) {
        const s = data.summary;
        let banner;
        if (s.downloaded === 0 && s.errors === 0 && s.skipped === 0) {
          // 0 命中：根据"接口实际返回的公告数"给出不同诊断
          const q = s.totalQueried || 0;
          if (q > 0) {
            banner = `<div class="drc-msg warn">⚠️ ${channelName} 接口返回了 <b>${q}</b> 条公告，但未匹配到该股票的年报/半年报。通常是网络代理未按股票代码过滤（如本沙箱/公司代理）。请在<b>本机直接运行服务器</b>后再试，或检查网络能否访问对应数据源。</div>`;
          } else {
            const err = (s.lastError || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
            let hint;
            if (channel === 'eastmoney') {
              hint = `东方财富公告接口未返回该股票公告。该接口在某些网络/代理环境下会被限制（返回全站公告而不过滤股票代码）。请改用「巨潮资讯网」通道。`;
            } else if (channel === 'cninfo') {
              hint = `巨潮资讯网未返回该股票的年报/半年报。若该股票为新上市、退市或近期无披露，属正常情况；否则可能是网络被拦截，请改用「东方财富」通道再试。`;
            } else if (err.includes("参数组合")) {
              hint = `已尝试多种 column/tabName/stockCode 参数组合仍返回 0 条公告。可能该股票代码在巨潮无对应公告，或接口字段已变更。请把下方「错误详情」反馈给开发者，以便调整查询参数。`;
            } else {
              hint = `可能是网络被拦截、代理未配置或接口变更。请确认本机可访问 cninfo.com.cn 后重试，或改用其他通道。`;
            }
            banner = `<div class="drc-msg warn">⚠️ ${channelName} 接口未返回任何公告。${hint}${err ? `<br><span style="font-size:12px;opacity:.85;display:block;margin-top:4px;">错误详情：${err}</span>` : ""}</div>`;
          }
        } else {
          // 东方财富接口在本机受限（返回全站公告但不按股票过滤）时，已自动回退巨潮
          let fbNote = '';
          if (s.fallback) {
            fbNote = `<div class="drc-msg info" style="margin-bottom:6px;">ℹ️ 东方财富公告接口在本机网络受限（返回全站公告但不按股票过滤），已自动改用「巨潮资讯网」完成下载。</div>`;
          }
          banner = fbNote + `<div class="drc-msg success">✅ 下载完成：新下载 <b>${s.downloaded}</b> 份，跳过(已存在) <b>${s.skipped}</b> 份，失败 <b>${s.errors}</b> 份（共 ${s.totalCodes} 只股票）。</div>`;
        }
        let html = banner;
        // 按通道展示明细（channel=all 或单通道时都展示）
        if (s.channels && Object.keys(s.channels).length) {
          const chRows = Object.entries(s.channels).map(([ch, cs]) => {
            const nm = { cninfo: '巨潮资讯网', eastmoney: '东方财富' }[ch] || ch;
            return `<div class="drc-channel-row"><span class="drc-ch-name">${nm}</span><span>下载 ${cs.downloaded} / 跳过 ${cs.skipped} / 失败 ${cs.errors}</span><span class="drc-ch-q">接口返回 ${cs.totalQueried} 条</span></div>`;
          }).join('');
          html += `<div class="drc-channels">${chRows}</div>`;
        }
        if (s.details && s.details.length) {
          const rows = s.details.map(d => {
            const statusMap = { invalid: '⚠️无效代码', none: '未找到报告', };
            const status = statusMap[d.status] || `下载 ${d.downloaded} / 跳过 ${d.skipped} / 失败 ${d.errors}`;
            return `<div class="drc-detail-row"><span class="drc-code">${d.code}</span><span>${d.name || ''}</span><span class="drc-detail-status">${status}</span></div>`;
          }).join('');
          html += `<div class="drc-details">${rows}</div>`;
          html += `<div class="drc-actions"><button class="drc-btn-sm" id="reportViewBtn">📁 在资料库中查看</button></div>`;
        }
        resultEl.innerHTML = html;
        // 刷新统计与"全部公司"视图（下载的文件已注册进资料库）
        loadStats();
        const viewBtn = resultEl.querySelector('#reportViewBtn');
        if (viewBtn) viewBtn.addEventListener('click', () => {
          // 仅查看「当前股票」自己的资料库，避免误展示其他公司的文档
          viewMode = 'current';
          render();
        });
      } else {
        resultEl.innerHTML = `<div class="drc-msg error">❌ 下载失败：${data.error || ('退出码 ' + data.code)}</div>`;
      }
    } catch (e) {
      resultEl.innerHTML = `<div class="drc-msg error">❌ 请求失败：${e.message}</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇️ 开始下载';
    }
  }

  // ---- 诊断参数：探测巨潮接口各参数组合能否返回公告 ----
  async function doReportProbe() {
    const codesInput = document.getElementById('reportCodes');
    const resultEl = document.getElementById('reportDownloadResult');
    if (!resultEl) return;
    // 诊断同样默认针对"当前个股"
    const curP = currentCode6();
    const extraP = ((codesInput && codesInput.value) || '')
      .split(/[,\s]+/).map(c => c.trim()).filter(Boolean);
    const codes = (curP ? [curP] : []).concat(extraP.filter(c => c !== curP));
    if (codes.length === 0) {
      resultEl.innerHTML = `<div class="drc-msg warn">请先在页面上方搜索并选择一只股票后再诊断。</div>`;
      return;
    }
    const btn = document.getElementById('reportProbeBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ 探测中...'; }
    resultEl.innerHTML = `<div class="drc-msg info">正在探测巨潮接口对 <b>${codes.join(', ')}</b> 各参数组合的返回情况，请稍候...</div>`;
    try {
      const resp = await fetch('/api/reports/probe?codes=' + encodeURIComponent(codes.join(',')));
      const data = await resp.json();
      if (!data.ok || !data.combos) {
        resultEl.innerHTML = `<div class="drc-msg error">❌ 诊断失败：${data.error || '未知错误'}</div>`;
        return;
      }
      const combos = data.combos;
      const hit = combos.find(c => (c.totalRecordNum || 0) > 0);
      let html = `<div class="drc-msg ${hit ? 'success' : 'warn'}">`;
      if (hit) {
        html += `✅ 找到可用参数组合：<b>column=${hit.column || '(空)'} tabName=${hit.tabName || '(空)'} stockCode=${hit.stockCode}</b>（totalRecordNum=${hit.totalRecordNum}）。把这条反馈给我即可设为默认，下载可直接成功。`;
      } else {
        html += `⚠️ 全部参数组合均返回 0 条公告（totalRecordNum=0）。说明该股票在巨潮当前接口下查不到年报/半年报，或接口字段已变更。`;
      }
      html += `</div>`;
      // 诊断摘要：根据 totalAnnouncement / hasCookie 判断是"过滤成0"还是"完全无响应"
      const anyTa = combos.some(c => (c.totalAnnouncement || 0) > 0);
      const anyCookie = combos.some(c => c.hasCookie);
      let diag = '';
      if (!hit) {
        if (anyTa) {
          diag = `<div class="drc-msg warn" style="margin-top:6px;">🔎 诊断：部分组合「全站公告数」非 0，说明接口可达且股票代码过滤已生效，但当前参数未匹配到该股票——疑似 stockCode 格式或接口字段已变更。</div>`;
        } else if (!anyCookie) {
          diag = `<div class="drc-msg warn" style="margin-top:6px;">🔎 诊断：未拿到巨潮会话 Cookie（预热失败），接口返回空。请确认本机可直连 cninfo.com.cn。</div>`;
        } else {
          diag = `<div class="drc-msg warn" style="margin-top:6px;">🔎 诊断：接口返回了 JSON 但「全站公告数」也为 0，可能是该代码在巨潮无公告，或接口字段已变更。</div>`;
        }
      }
      html += diag;
      html += `<table class="drc-probe-table"><thead><tr><th>column</th><th>tabName</th><th>stockCode</th><th>totalRecordNum</th><th>全站公告数</th><th>HTTP</th><th>Cookie</th><th>说明</th></tr></thead><tbody>`;
      for (const c of combos) {
        const trn = c.totalRecordNum;
        const ta = c.totalAnnouncement;
        const note = c.ok === false ? (c.error || '请求失败') : (trn > 0 ? (c.sample ? '样本: ' + c.sample : '有数据') : '无数据');
        const cls = trn > 0 ? 'drc-probe-hit' : '';
        html += `<tr class="${cls}"><td>${c.column || '(空)'}</td><td>${c.tabName || '(空)'}</td><td>${c.stockCode}</td><td>${trn === null ? '—' : trn}</td><td>${ta === null || ta === undefined ? '—' : ta}</td><td>${c.status || '—'}</td><td>${c.hasCookie ? '✅' : '❌'}</td><td>${note}</td></tr>`;
      }
      html += `</tbody></table>`;
      resultEl.innerHTML = html;
    } catch (e) {
      resultEl.innerHTML = `<div class="drc-msg error">❌ 请求失败：${e.message}</div>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '🔍 诊断参数'; }
    }
  }

  // ---- 加载统计 ----
  async function loadStats() {
    try {
      const resp = await fetch('/api/docs/stats');
      stats = await resp.json();
      const el = document.getElementById('docsStats');
      if (el) {
        el.innerHTML = `
          <span class="docs-stat-item">📄 ${stats.totalDocuments} 个文档</span>
          <span class="docs-stat-item">🏢 ${stats.totalCompanies} 家公司</span>
          <span class="docs-stat-item">💾 ${stats.totalSizeMB} MB</span>
        `;
      }
    } catch (e) { console.error('Stats error:', e); }
  }

  // ---- 加载公司文档 ----
  async function loadCompanyDocs(stockCode) {
    const content = document.getElementById('docsContent');
    if (!content) return;
    content.innerHTML = '<div class="docs-loading">加载中...</div>';

    try {
      const resp = await fetch(`/api/docs/company/${encodeURIComponent(stockCode)}`);
      const data = await resp.json();

      if (!data.documents || data.documents.length === 0) {
        content.innerHTML = `
          <div class="docs-empty">
            <div class="docs-empty-icon">📂</div>
            <p>暂无文档，点击「上传文档」添加年报、季报、公告等文件</p>
          </div>
        `;
        return;
      }

      // 按类型分组
      const grouped = {};
      for (const doc of data.documents) {
        if (!grouped[doc.type]) grouped[doc.type] = [];
        grouped[doc.type].push(doc);
      }

      let html = '';
      // 类型概览
      if (data.typeBreakdown && data.typeBreakdown.length > 0) {
        html += '<div class="docs-type-bar">';
        for (const t of data.typeBreakdown) {
          html += `<span class="docs-type-chip">${t.icon} ${t.typeName} (${t.count})</span>`;
        }
        html += '</div>';
      }

      // 分组列表
      for (const [type, docs] of Object.entries(grouped)) {
        const icon = DOC_TYPE_ICONS[type] || '📄';
        const label = DOC_TYPE_LABELS[type] || type;
        html += `
          <div class="docs-group">
            <div class="docs-group-header">
              <span class="docs-group-icon">${icon}</span>
              <span class="docs-group-title">${label}</span>
              <span class="docs-group-count">${docs.length} 个文件</span>
            </div>
            <div class="docs-list">
              ${docs.map(d => renderDocCard(d)).join('')}
            </div>
          </div>
        `;
      }

      content.innerHTML = html;
      bindDocActions();
    } catch (e) {
      content.innerHTML = `<div class="docs-error">加载失败: ${e.message}</div>`;
    }
  }

  // ---- 加载全部公司 ----
  async function loadAllCompanies() {
    const content = document.getElementById('docsContent');
    if (!content) return;
    content.innerHTML = '<div class="docs-loading">加载中...</div>';

    try {
      const resp = await fetch('/api/docs/companies');
      const data = await resp.json();
      allCompanies = data.companies || [];

      if (allCompanies.length === 0) {
        content.innerHTML = `
          <div class="docs-empty">
            <div class="docs-empty-icon">📂</div>
            <p>资料库为空，选择一只股票后上传文档即可开始使用</p>
            <p class="docs-empty-hint">支持存储年报、季报、公告、研报等文件，避免反复上网搜索</p>
          </div>
        `;
        return;
      }

      let html = '<div class="docs-company-grid">';
      for (const c of allCompanies) {
        const types = Object.entries(c.types || {}).map(([type, count]) => {
          return `<span class="docs-type-mini">${DOC_TYPE_ICONS[type] || '📄'} ${count}</span>`;
        }).join('');
        html += `
          <div class="docs-company-card" data-stock="${c.stockCode}">
            <div class="docs-company-name">${c.stockName || c.stockCode}</div>
            <div class="docs-company-code">${c.stockCode}</div>
            <div class="docs-company-types">${types}</div>
            <div class="docs-company-meta">
              <span>📄 ${c.docCount} 个文档</span>
              <span>📅 ${formatDate(c.lastUpdated)}</span>
            </div>
          </div>
        `;
      }
      html += '</div>';

      content.innerHTML = html;

      // 点击公司卡片
      content.querySelectorAll('.docs-company-card').forEach(card => {
        card.addEventListener('click', () => {
          const code = card.dataset.stock;
          viewMode = 'current';
          // 触发股票选择
          if (window.app && typeof window.app.searchAndSelect === 'function') {
            window.app.searchAndSelect(code);
          }
          setTimeout(() => render(), 100);
        });
      });
    } catch (e) {
      content.innerHTML = `<div class="docs-error">加载失败: ${e.message}</div>`;
    }
  }

  // ---- 搜索 ----
  async function doSearch(query) {
    const q = (query || '').trim();
    if (!q) {
      if (viewMode === 'current' && currentStockCode) loadCompanyDocs(currentStockCode);
      else loadAllCompanies();
      return;
    }

    const content = document.getElementById('docsContent');
    content.innerHTML = '<div class="docs-loading">搜索中...</div>';

    try {
      const resp = await fetch(`/api/docs/search?q=${encodeURIComponent(q)}`);
      const data = await resp.json();

      if (data.count === 0) {
        content.innerHTML = `<div class="docs-empty"><p>未找到匹配「${q}」的文档</p></div>`;
        return;
      }

      let html = `<div class="docs-search-results"><p>找到 ${data.count} 个结果</p></div>`;
      html += '<div class="docs-list">';
      for (const d of data.results) {
        html += renderDocCard(d, true);
      }
      html += '</div>';
      content.innerHTML = html;
      bindDocActions();
    } catch (e) {
      content.innerHTML = `<div class="docs-error">搜索失败: ${e.message}</div>`;
    }
  }

  // ---- 渲染单个文档卡片 ----
  function renderDocCard(doc, showCompany) {
    const fileIcon = getFileIcon(doc.fileType);
    const typeIcon = DOC_TYPE_ICONS[doc.type] || '📄';
    const typeLabel = DOC_TYPE_LABELS[doc.type] || doc.type;

    let meta = '';
    if (doc.year) meta += `<span>📅 ${doc.year}</span>`;
    if (doc.quarter) meta += `<span>${doc.quarter}</span>`;
    if (doc.fileSize) meta += `<span>💾 ${formatSize(doc.fileSize)}</span>`;
    meta += `<span>⏰ ${formatDate(doc.uploadedAt)}</span>`;

    return `
      <div class="doc-card" data-doc-id="${doc.id}">
        <div class="doc-card-icon">${fileIcon}</div>
        <div class="doc-card-body">
          <div class="doc-card-title">${doc.title || doc.fileName}</div>
          <div class="doc-card-file">${doc.fileName}</div>
          <div class="doc-card-meta">
            <span class="doc-type-badge">${typeIcon} ${typeLabel}</span>
            ${showCompany && doc.stockName ? `<span class="doc-company-badge">🏢 ${doc.stockName}</span>` : ''}
            ${meta}
          </div>
          ${doc.description ? `<div class="doc-card-desc">${doc.description}</div>` : ''}
        </div>
        <div class="doc-card-actions">
          <button class="doc-action-btn doc-download-btn" data-id="${doc.id}" title="下载">⬇️</button>
          <button class="doc-action-btn doc-delete-btn" data-id="${doc.id}" title="删除">🗑️</button>
        </div>
      </div>
    `;
  }

  // ---- 绑定文档操作事件 ----
  function bindDocActions() {
    document.querySelectorAll('.doc-download-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.dataset.id;
        window.open(`/api/docs/download/${id}`, '_blank');
      });
    });

    document.querySelectorAll('.doc-delete-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!confirm('确定删除此文档？文件将从本地永久移除。')) return;

        try {
          const resp = await fetch(`/api/docs/${id}`, { method: 'DELETE' });
          const result = await resp.json();
          if (result.success) {
            // 重新渲染
            if (viewMode === 'current' && currentStockCode) loadCompanyDocs(currentStockCode);
            else loadAllCompanies();
            loadStats();
          } else {
            alert('删除失败: ' + (result.error || '未知错误'));
          }
        } catch (err) {
          alert('删除失败: ' + err.message);
        }
      });
    });
  }

  // ---- 上传对话框 ----
  function showUploadDialog() {
    if (!currentStockCode) {
      alert('请先选择一只股票');
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'docs-upload-overlay';
    overlay.innerHTML = `
      <div class="docs-upload-dialog">
        <div class="docs-upload-header">
          <h4>📤 上传文档 — ${currentStockName || currentStockCode}</h4>
          <button class="docs-upload-close">✕</button>
        </div>
        <div class="docs-upload-body">
          <div class="docs-upload-field">
            <label>文件类型</label>
            <select id="uploadType">
              <option value="annual">📋 年报</option>
              <option value="quarterly">📅 季报</option>
              <option value="announcement">📢 公告</option>
              <option value="research">📊 研报</option>
              <option value="other">📄 其他</option>
            </select>
          </div>
          <div class="docs-upload-field-row">
            <div class="docs-upload-field">
              <label>年份 (可选)</label>
              <input type="text" id="uploadYear" placeholder="如 2024" />
            </div>
            <div class="docs-upload-field">
              <label>季度 (可选)</label>
              <select id="uploadQuarter">
                <option value="">--</option>
                <option value="Q1">一季报</option>
                <option value="Q2">中报</option>
                <option value="Q3">三季报</option>
                <option value="Q4">年报</option>
              </select>
            </div>
          </div>
          <div class="docs-upload-field">
            <label>标题 (可选)</label>
            <input type="text" id="uploadTitle" placeholder="如：2024年年度报告" />
          </div>
          <div class="docs-upload-field">
            <label>备注 (可选)</label>
            <textarea id="uploadDesc" rows="2" placeholder="如：包含NBV假设变更说明"></textarea>
          </div>
          <div class="docs-upload-dropzone" id="uploadDropzone">
            <div class="docs-dropzone-icon">📎</div>
            <p>点击选择文件 或拖拽文件到此</p>
            <p class="docs-dropzone-hint">支持 PDF / Word / Excel / 图片等，最大 100MB</p>
          </div>
          <div id="uploadFileName" class="docs-upload-filename"></div>
        </div>
        <div class="docs-upload-footer">
          <button class="docs-upload-cancel">取消</button>
          <button class="docs-upload-submit" id="uploadSubmitBtn" disabled>上传</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let selectedFile = null;

    // 关闭
    const closeDialog = () => overlay.remove();
    overlay.querySelector('.docs-upload-close').addEventListener('click', closeDialog);
    overlay.querySelector('.docs-upload-cancel').addEventListener('click', closeDialog);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(); });

    // 文件选择
    const dropzone = overlay.querySelector('#uploadDropzone');
    const fileInput = document.getElementById('docsFileInput');

    dropzone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        selectedFile = fileInput.files[0];
        overlay.querySelector('#uploadFileName').innerHTML = `📎 ${selectedFile.name} (${formatSize(selectedFile.size)})`;
        overlay.querySelector('#uploadSubmitBtn').disabled = false;
      }
    });

    // 拖拽
    dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        selectedFile = e.dataTransfer.files[0];
        overlay.querySelector('#uploadFileName').innerHTML = `📎 ${selectedFile.name} (${formatSize(selectedFile.size)})`;
        overlay.querySelector('#uploadSubmitBtn').disabled = false;
      }
    });

    // 上传
    overlay.querySelector('#uploadSubmitBtn').addEventListener('click', async () => {
      if (!selectedFile) return;

      const formData = new FormData();
      formData.append('files', selectedFile);
      const meta = {
        fileName: selectedFile.name,
        stockCode: currentStockCode,
        stockName: currentStockName || '',
        type: overlay.querySelector('#uploadType').value,
        year: overlay.querySelector('#uploadYear').value,
        quarter: overlay.querySelector('#uploadQuarter').value,
        title: overlay.querySelector('#uploadTitle').value,
        description: overlay.querySelector('#uploadDesc').value,
      };
      formData.append('metas', JSON.stringify([meta]));

      const btn = overlay.querySelector('#uploadSubmitBtn');
      btn.textContent = '上传中...';
      btn.disabled = true;

      try {
        const resp = await fetch('/api/docs/upload', { method: 'POST', body: formData });
        const result = await resp.json();
        if (result.success) {
          closeDialog();
          fileInput.value = '';
          // 重新加载
          loadCompanyDocs(currentStockCode);
          loadStats();
        } else {
          alert('上传失败: ' + (result.error || '未知错误'));
          btn.textContent = '上传';
          btn.disabled = false;
        }
      } catch (err) {
        alert('上传失败: ' + err.message);
        btn.textContent = '上传';
        btn.disabled = false;
      }
    });
  }

  // ---- 批量上传对话框（支持文件名自动识别） ----
  function showBatchUploadDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'docs-upload-overlay';
    overlay.innerHTML = `
      <div class="docs-upload-dialog docs-batch-dialog">
        <div class="docs-upload-header">
          <h4>📚 批量上传文档</h4>
          <button class="docs-upload-close">✕</button>
        </div>
        <div class="docs-upload-body">
          <div class="docs-batch-tip">一次选择多个文件。勾选「按文件名自动识别」后，系统会从文件名中提取 <b>公司 / 年份 / 报告类型</b> 并自动归类；未能识别时回退到下方默认公司。</div>
          <label class="docs-batch-toggle"><input type="checkbox" id="batchAuto" checked /> 按文件名自动识别公司 / 年份 / 类型（推荐）</label>
          <div class="docs-batch-default">
            <label>未识别时默认归入：</label>
            <select id="batchDefault">
              <option value="">（不指定，未识别将报错）</option>
              ${currentStockCode ? `<option value="${currentStockCode}" data-name="${currentStockName || ''}">当前股票：${currentStockName || currentStockCode} (${currentStockCode})</option>` : ''}
            </select>
          </div>
          <div class="docs-upload-dropzone" id="batchDropzone">
            <div class="docs-dropzone-icon">📎</div>
            <p>点击选择多个文件 或拖拽文件到此</p>
            <p class="docs-dropzone-hint">支持 PDF / Word / Excel / 图片等，单次最多 100 个文件</p>
          </div>
          <div id="batchRows" class="docs-batch-rows"></div>
        </div>
        <div class="docs-upload-footer">
          <button class="docs-upload-cancel">取消</button>
          <button class="docs-upload-submit" id="batchSubmitBtn" disabled>上传全部 (0)</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    let batchRows = []; // { file, fileName, stockCode, stockName, type, year, quarter, title, matched }

    const closeDialog = () => overlay.remove();
    overlay.querySelector('.docs-upload-close').addEventListener('click', closeDialog);
    overlay.querySelector('.docs-upload-cancel').addEventListener('click', closeDialog);
    overlay.addEventListener('click', e => { if (e.target === overlay) closeDialog(); });

    const dropzone = overlay.querySelector('#batchDropzone');
    const fileInput = document.getElementById('docsBatchInput');
    const rowsEl = overlay.querySelector('#batchRows');
    const autoEl = overlay.querySelector('#batchAuto');
    const defaultEl = overlay.querySelector('#batchDefault');
    const submitBtn = overlay.querySelector('#batchSubmitBtn');

    dropzone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length) handleFiles(fileInput.files);
    });
    dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
    dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
    dropzone.addEventListener('drop', e => {
      e.preventDefault(); dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
    });

    autoEl.addEventListener('change', () => {
      if (autoEl.checked) classifyAll(); else clearAll();
    });

    async function classifyAll() {
      if (batchRows.length === 0) return;
      try {
        const resp = await fetch('/api/docs/classify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filenames: batchRows.map(r => r.fileName) }),
        });
        const data = await resp.json();
        if (data.ok && Array.isArray(data.results)) {
          data.results.forEach((c, i) => {
            if (batchRows[i]) {
              batchRows[i].stockCode = c.stockCode || '';
              batchRows[i].stockName = c.stockName || '';
              batchRows[i].type = c.type || '';
              batchRows[i].year = c.year || '';
              batchRows[i].quarter = c.quarter || '';
              batchRows[i].matched = c.matched || false;
            }
          });
        }
      } catch (e) { console.error('classify error', e); }
      renderRows();
    }

    function clearAll() {
      batchRows.forEach(r => { r.stockCode = ''; r.stockName = ''; r.type = ''; r.year = ''; r.quarter = ''; r.matched = false; });
      renderRows();
    }

    async function handleFiles(fileList) {
      const files = Array.from(fileList);
      batchRows = files.map(f => ({
        file: f, fileName: f.name, stockCode: '', stockName: '',
        type: '', year: '', quarter: '', title: f.name, matched: false,
      }));
      fileInput.value = '';
      if (autoEl.checked) await classifyAll(); else renderRows();
    }

    function renderRows() {
      if (batchRows.length === 0) {
        rowsEl.innerHTML = '';
        submitBtn.disabled = true;
        submitBtn.textContent = '上传全部 (0)';
        return;
      }
      const rowsHtml = batchRows.map((r, i) => {
        const companyBadge = r.stockCode
          ? `<span class="bc-badge ${r.matched ? 'bc-ok' : 'bc-fallback'}">${r.matched ? '✓ 已识别' : '↩ 已指定'}：${r.stockName || r.stockCode} <small>(${r.stockCode})</small></span>`
          : `<span class="bc-badge bc-warn">⚠ 未识别</span>`;
        return `
          <div class="bc-row" data-i="${i}">
            <div class="bc-file" title="${r.fileName}">${r.fileName}</div>
            <div class="bc-company">
              ${companyBadge}
              <button class="bc-pick" data-i="${i}" title="选择/更改公司">🔍</button>
              <div class="bc-pick-box" id="bcPick_${i}" style="display:none">
                <input type="text" class="bc-pick-input" placeholder="输入公司名或代码搜索" />
                <div class="bc-pick-list"></div>
              </div>
            </div>
            <div class="bc-year"><input type="text" class="bc-year-input" value="${r.year}" placeholder="年份" /></div>
            <div class="bc-type">
              <select class="bc-type-sel">
                <option value="annual" ${r.type==='annual'?'selected':''}>年报</option>
                <option value="quarterly" ${r.type==='quarterly'?'selected':''}>季报</option>
                <option value="announcement" ${r.type==='announcement'?'selected':''}>公告</option>
                <option value="research" ${r.type==='research'?'selected':''}>研报</option>
                <option value="other" ${r.type==='other'?'selected':''}>其他</option>
              </select>
            </div>
            <div class="bc-quarter">
              <select class="bc-quarter-sel">
                <option value="" ${!r.quarter?'selected':''}>--</option>
                <option value="Q1" ${r.quarter==='Q1'?'selected':''}>Q1</option>
                <option value="Q2" ${r.quarter==='Q2'?'selected':''}>Q2</option>
                <option value="Q3" ${r.quarter==='Q3'?'selected':''}>Q3</option>
                <option value="Q4" ${r.quarter==='Q4'?'selected':''}>Q4</option>
              </select>
            </div>
          </div>
        `;
      }).join('');
      rowsEl.innerHTML = `
        <div class="bc-head">
          <div class="bc-file">文件</div><div class="bc-company">公司</div>
          <div class="bc-year">年份</div><div class="bc-type">类型</div><div class="bc-quarter">季度</div>
        </div>
        ${rowsHtml}
      `;
      bindRowEvents();
      submitBtn.disabled = false;
      submitBtn.textContent = `上传全部 (${batchRows.length})`;
    }

    function bindRowEvents() {
      rowsEl.querySelectorAll('.bc-row').forEach(rowEl => {
        const i = parseInt(rowEl.dataset.i, 10);
        const yearInput = rowEl.querySelector('.bc-year-input');
        yearInput.addEventListener('input', () => { batchRows[i].year = yearInput.value.trim(); });
        const typeSel = rowEl.querySelector('.bc-type-sel');
        typeSel.addEventListener('change', () => { batchRows[i].type = typeSel.value; });
        const quarterSel = rowEl.querySelector('.bc-quarter-sel');
        quarterSel.addEventListener('change', () => { batchRows[i].quarter = quarterSel.value; });

        const pickBtn = rowEl.querySelector('.bc-pick');
        const pickBox = rowEl.querySelector('.bc-pick-box');
        const pickInput = rowEl.querySelector('.bc-pick-input');
        const pickList = rowEl.querySelector('.bc-pick-list');
        pickBtn.addEventListener('click', () => {
          pickBox.style.display = pickBox.style.display === 'none' ? 'block' : 'none';
          if (pickBox.style.display === 'block') pickInput.focus();
        });
        let t;
        pickInput.addEventListener('input', () => {
          clearTimeout(t);
          const kw = pickInput.value.trim();
          if (kw.length < 1) { pickList.innerHTML = ''; return; }
          t = setTimeout(async () => {
            try {
              const resp = await fetch('/api/search?q=' + encodeURIComponent(kw));
              const results = await resp.json();
              if (!results || results.length === 0) { pickList.innerHTML = '<div class="bc-pick-empty">无匹配</div>'; return; }
              pickList.innerHTML = results.slice(0, 8).map(m => `<div class="bc-pick-item" data-code="${m.symbol || m.code}" data-name="${m.name}">${m.name} <small>(${m.code || m.symbol})</small></div>`).join('');
              pickList.querySelectorAll('.bc-pick-item').forEach(it => {
                it.addEventListener('click', () => {
                  batchRows[i].stockCode = it.dataset.code;
                  batchRows[i].stockName = it.dataset.name;
                  batchRows[i].matched = false;
                  pickBox.style.display = 'none';
                  renderRows();
                });
              });
            } catch (e) {}
          }, 300);
        });
      });
    }

    submitBtn.addEventListener('click', async () => {
      if (batchRows.length === 0) return;
      const defOpt = defaultEl.selectedOptions[0];
      const defaultStockCode = defaultEl.value || '';
      const defaultStockName = defOpt && defOpt.dataset.name ? defOpt.dataset.name : '';

      const metas = batchRows.map(r => ({
        fileName: r.fileName,
        stockCode: r.stockCode || '',
        stockName: r.stockName || '',
        type: r.type || '',
        year: r.year || '',
        quarter: r.quarter || '',
        title: r.fileName,
      }));

      const formData = new FormData();
      batchRows.forEach(r => formData.append('files', r.file));
      formData.append('metas', JSON.stringify(metas));
      if (defaultStockCode) {
        formData.append('defaultStockCode', defaultStockCode);
        formData.append('defaultStockName', defaultStockName);
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '上传中...';
      try {
        const resp = await fetch('/api/docs/upload', { method: 'POST', body: formData });
        const data = await resp.json();
        if (data.success) {
          let msg = `✅ 成功上传 ${data.count} 个文件`;
          if (data.errors && data.errors.length) msg += `，${data.errors.length} 个失败（${data.errors.map(e => e.fileName).join('、')}）`;
          closeDialog();
          if (currentStockCode) loadCompanyDocs(currentStockCode);
          loadStats();
          alert(msg);
        } else {
          alert('上传失败: ' + (data.error || '未知错误'));
          submitBtn.disabled = false;
          submitBtn.textContent = `上传全部 (${batchRows.length})`;
        }
      } catch (err) {
        alert('上传失败: ' + err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = `上传全部 (${batchRows.length})`;
      }
    });
  }

  // ---- 公开接口 ----
  return {
    init() {
      // 由app.js在选股时调用setStock
    },
    setStock(code, name) {
      currentStockCode = code;
      currentStockName = name;
      viewMode = 'current';
      // 若资料库页当前可见，立即重渲染，使「下载年报」卡片同步带入新股票
      const c = document.getElementById('docStoreContainer');
      if (c && c.offsetParent !== null) {
        render();
        // 进入资料库时自动从东方财富抓取该股票近年年报/半年报（防抖 1.2s）
        if (autoFetchTimer) clearTimeout(autoFetchTimer);
        autoFetchTimer = setTimeout(() => autoFetchReports(), 1200);
      }
    },
    render,
    onTabSwitch() {
      render();
      // 切到资料库标签页时也自动抓取当前股票年报（防抖）
      if (autoFetchTimer) clearTimeout(autoFetchTimer);
      autoFetchTimer = setTimeout(() => autoFetchReports(), 1200);
    },
  };
})();
