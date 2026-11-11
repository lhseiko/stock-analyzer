/**
 * honestyBadge.js — 代理口径「代理」角标公共渲染器（20261110g，整改方案 P0-3）
 * ============================================================================
 * 数据契约（lib/dataHonesty.js）：
 *   - 完整标注：obj.honesty = { kind:'proxy', proxyKey, proxyName, boundary, note }
 *   - 轻量标注：obj.proxyKeys = ['big-drop-def', ...]（零 require 模块用，前端展开）
 * 裁决③：只做展示角标，不进打分聚合。中性色（禁红涨绿跌语义色），title 展示适用边界。
 *
 * PROXY_LABELS 与 lib/dataHonesty.js PROXY_REGISTRY 六项 key 一一对应——
 * 两侧必须同步维护，test_data_honesty.js 有静态一致性断言。
 */
(function () {
  const PROXY_LABELS = {
    'big-drop-def': { name: '大面股定义', boundary: '昨日涨停股今日跌超 5% 计「大面」，工作台自定义阈值，非交易所定义' },
    'liquidity-line': { name: '流动性 1 亿线', boundary: '个股成交额 < 1.0 亿元计「流动性不足」，工作台自定义阈值' },
    'sector-core-proxy': { name: '板块中军代理', boundary: '以涨停池内流通市值居前个股近似「板块中军」，非真实板块中军（无板块成分股映射）' },
    'zt-pool-market': { name: '涨停池代表全市场', boundary: '以涨停池样本聚合推断全市场情绪/题材结构，未覆盖非涨停股' },
    'single-stock-heat': { name: '单股代理热度', boundary: '以中国平安（601318）股吧情绪样本近似全市场个股情绪' },
    'lhb-keyword': { name: '龙虎榜游资关键词', boundary: '机构/游资动向为「解读」文本关键词计数，非席位穿透核验' },
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * 渲染「代理」角标 HTML。
   * @param {object|Array} input honesty 对象或 proxyKeys 数组
   * @param {object} opts { separator } 多个代理名之间的分隔符
   * @returns {string} HTML（无代理时返回空串）
   */
  function badgeHTML(input, opts) {
    opts = opts || {};
    const sep = opts.separator || '、';
    let names = [], boundaries = [];
    if (Array.isArray(input)) {
      for (const k of input) {
        const p = PROXY_LABELS[k];
        if (p) { names.push(p.name); boundaries.push(p.boundary); }
      }
    } else if (input && input.kind === 'proxy') {
      names.push(input.proxyName || (input.proxyKey && PROXY_LABELS[input.proxyKey] ? PROXY_LABELS[input.proxyKey].name : '代理'));
      boundaries.push(input.boundary || (input.proxyKey && PROXY_LABELS[input.proxyKey] ? PROXY_LABELS[input.proxyKey].boundary : '') || '');
      if (input.note) boundaries.push('备注：' + input.note);
    } else {
      return '';
    }
    if (!names.length) return '';
    const title = boundaries.filter(Boolean).join('；');
    return `<span class="honesty-badge" title="${esc(title)}" data-honesty="proxy">代理 · ${esc(names.join(sep))}</span>`;
  }

  /** 判定：对象是否带代理标注（兼容 honesty 对象与 proxyKeys 数组两种形态） */
  function isProxy(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.honesty && obj.honesty.kind === 'proxy') return true;
    return Array.isArray(obj.proxyKeys) && obj.proxyKeys.length > 0;
  }

  window.honestyBadge = { PROXY_LABELS, badgeHTML, isProxy, esc };
})();
