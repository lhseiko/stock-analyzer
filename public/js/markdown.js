/**
 * public/js/markdown.js — 本地随包的轻量 Markdown 渲染器（20261110b）
 * ======================================================================
 * 每日复盘改为大模型直接输出 Markdown 后使用。零外部依赖、零 CDN，
 * 符合工作台「第三方库一律本地随包、禁止境外 CDN」铁律。
 *
 * 支持：# ~ ###### 标题、**加粗**、*斜体*、~~删除线~~、`行内代码`、```代码块```、
 *       GFM 表格（含 :--- 对齐）、有序/无序列表（含一层嵌套）、> 引用、--- 分隔线、
 *       [文字](链接)、段落换行。
 * 安全：全文先 escapeHtml，再生成标签；链接 URL 白名单只允许 http/https/#/相对路径，
 *       不渲染 <img>（阻断 LLM 输出里的外链图片与 javascript: 伪协议）。
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeUrl(u) {
    const s = String(u || '').trim();
    // esc 后 & → &amp;，协议字符串本身不变，直接做白名单校验
    if (/^https?:\/\//i.test(s)) return s;
    if (/^#/.test(s)) return s;
    if (/^\/(?!\/)/.test(s)) return s;
    if (/^[a-zA-Z0-9._\-/]+$/.test(s) && !/:/.test(s)) return s;
    return '';
  }

  /** 行内语法。入参必须是已 esc 过的文本。 */
  function inline(text) {
    let s = String(text || '');
    const codes = [];
    // 行内代码先摘出，避免里面的 * / [ 被后续规则误解析
    s = s.replace(/`([^`]+?)`/g, function (_, c) {
      codes.push('<code>' + c + '</code>');
      return '\u0000C' + (codes.length - 1) + '\u0000';
    });
    // 链接（安全 URL 才生成 a 标签，否则退化为纯文字）
    s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, function (_, label, url) {
      const u = safeUrl(url);
      return u ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + label + '</a>' : label;
    });
    // 图片退化成替代文字，不加载外链
    s = s.replace(/!\[([^\]]*)\]\([^)\s]+\)/g, '$1');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000C(\d+)\u0000/g, function (_, i) { return codes[Number(i)] || ''; });
    return s;
  }

  function cellsOf(line) {
    let t = line.trim();
    if (t.charAt(0) === '|') t = t.slice(1);
    if (t.charAt(t.length - 1) === '|') t = t.slice(0, -1);
    return t.split('|').map(c => c.trim());
  }
  function isTableSep(line) {
    if (!/\|/.test(line) && !/^\s*[-:]+/.test(line)) return false;
    const cs = cellsOf(line);
    return cs.length > 0 && cs.every(c => /^:?-{2,}:?$/.test(c));
  }
  function alignOf(sepLine) {
    return cellsOf(sepLine).map(c => {
      const l = c.charAt(0) === ':', r = c.charAt(c.length - 1) === ':';
      if (l && r) return ' style="text-align:center"';
      if (r) return ' style="text-align:right"';
      if (l) return ' style="text-align:left"';
      return '';
    });
  }

  function render(src) {
    const lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let i = 0;
    let para = [];
    let listType = null;   // 'ul' | 'ol'
    let listDepth = 0;

    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
      para = [];
    }
    function closeList() {
      if (listType) { out.push('</' + listType + '>'); listType = null; listDepth = 0; }
    }
    function openList(type, depth) {
      if (listType !== type || depth !== listDepth) {
        closeList();
        out.push('<' + type + '>');
        listType = type; listDepth = depth;
      }
    }

    while (i < lines.length) {
      const raw = lines[i];
      const line = esc(raw);
      const trimmed = line.trim();

      // 围栏代码块
      const fence = raw.match(/^```\s*([\w+-]*)\s*$/);
      if (fence) {
        flushPara(); closeList();
        const lang = fence[1] || '';
        const buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(esc(lines[i])); i++; }
        i++; // 跳过结束围栏
        out.push('<pre><code' + (lang ? ' class="lang-' + lang.replace(/[^\w+-]/g, '') + '"' : '') + '>' +
          buf.join('\n') + '</code></pre>');
        continue;
      }

      // 空行
      if (!trimmed) { flushPara(); closeList(); i++; continue; }

      // 分隔线
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        flushPara(); closeList(); out.push('<hr>'); i++; continue;
      }

      // 表格：当前行含 | 且下一行是分隔行
      if (/\|/.test(raw) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flushPara(); closeList();
        const head = cellsOf(line);
        const aligns = alignOf(esc(lines[i + 1]));
        let h = '<div class="md-table-wrap"><table><thead><tr>';
        head.forEach((c, k) => { h += '<th' + (aligns[k] || '') + '>' + inline(c) + '</th>'; });
        h += '</tr></thead><tbody>';
        i += 2;
        while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
          const cs = cellsOf(esc(lines[i]));
          h += '<tr>';
          for (let k = 0; k < head.length; k++) {
            h += '<td' + (aligns[k] || '') + '>' + inline(cs[k] == null ? '' : cs[k]) + '</td>';
          }
          h += '</tr>';
          i++;
        }
        h += '</tbody></table></div>';
        out.push(h);
        continue;
      }

      // 标题：LLM 用 ### 作为段落级标题 → 映射为 h3（CSS 已给 h3 金色强调样式）。
      // 用 max(...,2) 避免文章内出现 h1（页面标题已是 h1）；#/## 统一降为 h2 作总纲。
      const head = raw.match(/^(#{1,6})\s+(.+)$/);
      if (head) {
        flushPara(); closeList();
        const lv = Math.min(Math.max(head[1].length, 2), 6);
        out.push('<h' + lv + '>' + inline(esc(head[2].trim())) + '</h' + lv + '>');
        i++; continue;
      }

      // 引用（连续行合并）
      if (/^\s*>/.test(raw)) {
        flushPara(); closeList();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(esc(lines[i].replace(/^\s*>\s?/, '')));
          i++;
        }
        out.push('<blockquote>' + buf.map(inline).join('<br>') + '</blockquote>');
        continue;
      }

      // 列表
      const ul = raw.match(/^(\s*)[-*+]\s+(.+)$/);
      const ol = raw.match(/^(\s*)\d+[.)]\s+(.+)$/);
      if (ul || ol) {
        flushPara();
        const m = ul || ol;
        const type = ul ? 'ul' : 'ol';
        const depth = (m[1] || '').length >= 2 ? 1 : 0;
        openList(type, depth);
        out.push('<li>' + inline(esc(m[2])) + '</li>');
        i++; continue;
      }

      closeList();
      para.push(line);
      i++;
    }
    flushPara(); closeList();
    return out.join('\n');
  }

  global.Markdown = { render: render, escape: esc, inline: inline };
})(typeof window !== 'undefined' ? window : globalThis);
