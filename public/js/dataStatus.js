/**
 * dataStatus.js —— 数据诚实原则·前端标准态
 * ================================================================
 * 对应后端 lib/dataHonesty.js 的统一信封（success / stale / failed）。
 * 任何卡片拿到数据结果后，先用本模块判断状态再渲染，
 * 失败时一律显示红色"数据获取失败"（含来源与原因），绝不拿空值/零值/旧值伪装。
 */
(function (global) {
  'use strict';

  function classify(r) {
    if (!r || r.success === false || r.ok === false) return 'failed';
    if (r.stale === true) return 'stale';
    return 'fresh';
  }

  function isFailure(r) { return classify(r) === 'failed'; }
  function isStale(r) { return classify(r) === 'stale'; }
  function isFresh(r) { return classify(r) === 'fresh'; }

  function reasonOf(r) {
    if (!r) return '无数据';
    return r.reason || r.error || '';
  }

  // 生成标准状态徽标 HTML。opts.hideFresh=true 时不显示"正常"态（减少噪音）。
  function badgeHTML(r, opts) {
    opts = opts || {};
    var c = classify(r);
    if (c === 'failed') {
      var reason = reasonOf(r);
      var src = r.source ? ('｜来源：' + r.source) : '';
      var why = reason ? ('：' + reason) : '';
      return '<span class="ds-badge ds-failed">⚠ 数据获取失败' + why + src + '｜请稍后重试</span>';
    }
    if (c === 'stale') {
      var src2 = r.source ? ('｜来源：' + r.source) : '';
      var note = r.staleReason ? ('（' + r.staleReason + '）') : '（非实时）';
      return '<span class="ds-badge ds-stale">⏱ 数据滞后/快照' + note + src2 + '</span>';
    }
    if (opts.hideFresh) return '';
    return '<span class="ds-badge ds-fresh">✓ 数据正常' + (r.source ? ('｜来源：' + r.source) : '') + '</span>';
  }

  // 将状态徽标渲染进给定容器元素（自动维护父元素状态 class）。
  function render(el, r, opts) {
    if (!el) return;
    el.innerHTML = badgeHTML(r, opts);
    el.className = (el.className || '').replace(/\bds-(fresh|stale|failed)\b/g, '').trim() + ' ds-status-' + classify(r);
  }

  global.DataStatus = {
    classify: classify,
    isFailure: isFailure,
    isStale: isStale,
    isFresh: isFresh,
    reasonOf: reasonOf,
    badgeHTML: badgeHTML,
    render: render,
  };
})(window);
