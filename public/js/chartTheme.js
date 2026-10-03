/**
 * chartTheme.js —— 工作台图表统一视觉层（Robinhood 式专业金融风格，20261001d）
 * ------------------------------------------------------------------------
 * 设计原则：只改「视觉」，不改任何数据与计算逻辑。
 *   1. 注册升级版 softDark 主题（所有模块 echarts.init(el, 'softDark') 自动继承）：
 *      - 极简坐标轴：隐藏轴线/刻度，仅留柔和横向网格与浅灰刻度文字
 *      - 悬浮卡片 tooltip：深色玻璃卡（圆角 + 投影 + 模糊）
 *      - 图例圆润小色块；dataZoom 柔和蓝手柄（沿用全站规范色 #7fa8c9）
 *   2. SA_CHART.polish(opt)：对 setOption 选项做「外壳级」修补（tooltip 外壳/图例图标），
 *      绝不触碰 series 数据、formatter、trigger 等业务字段。
 *   3. SA_CHART.attach(chart)：包装 setOption，模块在 init 处调用一次即全模块生效。
 *   4. SA_CHART.grad / rgba：渐变面积与透明色助手，供各图表现代化视觉使用。
 *
 * 加载顺序：必须在 echarts 之后、其他图表模块（charts.js 等）之前。
 */
(function () {
  'use strict';

  var C = {
    bg: '#0B0E11',
    card: '#161B22',
    text: '#E6EDF3',
    textDim: '#8B949E',
    textDisabled: '#484F58',
    grid: 'rgba(139,148,158,0.10)',
    axisLabel: '#8B949E',
    handle: '#7fa8c9',      // dataZoom 手柄规范色
    accent: '#F0B97B',      // 品牌金
    tooltipBg: 'rgba(22,27,34,0.97)',
    tooltipBorder: 'rgba(255,255,255,0.10)',
    // 既有柔和调色板（保持不变，避免改变未显式指定颜色的序列的观感）
    palette: ['#7fa8c9', '#cf8e8e', '#8fb89a', '#cdab74', '#a99bc4', '#6fb0a4', '#9aa7b0', '#b0a08c'],
  };

  var TT_SHELL_CSS = 'border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,0.55);backdrop-filter:blur(6px);';

  // 每类坐标轴的统一视觉（隐藏轴线/刻度，弱化网格）
  function axisCommon() {
    return {
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: C.axisLabel },
      splitLine: { lineStyle: { color: C.grid } },
      axisPointer: { label: { backgroundColor: '#2A313B', color: C.text, padding: [3, 6] } },
    };
  }

  var THEME = {
    color: C.palette,
    backgroundColor: 'transparent',
    textStyle: { color: '#C9D1D9' },
    title: { textStyle: { color: '#C9D1D9', fontWeight: 600 }, subtextStyle: { color: C.textDim } },
    legend: {
      icon: 'roundRect',
      itemWidth: 12,
      itemHeight: 8,
      itemGap: 16,
      textStyle: { color: C.textDim, fontSize: 11 },
      inactiveColor: C.textDisabled,
    },
    tooltip: {
      backgroundColor: C.tooltipBg,
      borderColor: C.tooltipBorder,
      borderWidth: 1,
      padding: [10, 14],
      textStyle: { color: C.text, fontSize: 12 },
      extraCssText: TT_SHELL_CSS,
      axisPointer: {
        lineStyle: { color: 'rgba(139,148,158,0.45)', type: 'dashed' },
        crossStyle: { color: 'rgba(139,148,158,0.35)' },
        label: { backgroundColor: '#2A313B', color: C.text, padding: [3, 6] },
      },
    },
    categoryAxis: axisCommon(),
    valueAxis: axisCommon(),
    timeAxis: axisCommon(),
    logAxis: axisCommon(),
    dataZoom: {
      backgroundColor: 'transparent',
      borderColor: 'transparent',
      fillerColor: 'rgba(240,185,123,0.10)',
      dataBackground: {
        lineStyle: { color: 'rgba(139,148,158,0.35)' },
        areaStyle: { color: 'rgba(139,148,158,0.08)' },
      },
      selectedDataBackground: {
        lineStyle: { color: 'rgba(240,185,123,0.50)' },
        areaStyle: { color: 'rgba(240,185,123,0.10)' },
      },
      handleStyle: { color: C.handle, borderColor: C.handle },
      moveHandleStyle: { color: 'rgba(127,168,201,0.45)' },
      emphasis: {
        handleStyle: { borderColor: '#9fc3de' },
        moveHandleStyle: { color: 'rgba(127,168,201,0.70)' },
      },
      textStyle: { color: C.textDim },
    },
  };

  // #rrggbb / #rgb → rgba()；已是 rgba()/rgb() 则直接透传
  function rgba(hex, alpha) {
    if (!hex || typeof hex !== 'string') return hex;
    if (hex.indexOf('rgba') === 0) return hex;
    if (hex.indexOf('rgb(') === 0) return hex.replace('rgb(', 'rgba(').replace(')', ',' + alpha + ')');
    var h = hex.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return hex;
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  // 垂直渐变面积（自上而下 topAlpha → bottomAlpha），供 line series 的 areaStyle 使用
  function grad(color, topAlpha, bottomAlpha) {
    topAlpha = topAlpha == null ? 0.24 : topAlpha;
    bottomAlpha = bottomAlpha == null ? 0 : bottomAlpha;
    if (window.echarts && window.echarts.graphic) {
      return new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
        { offset: 0, color: rgba(color, topAlpha) },
        { offset: 1, color: rgba(color, bottomAlpha) },
      ]);
    }
    return { color: rgba(color, topAlpha) };
  }

  // 外壳级修补：统一 tooltip 外壳与图例图标；不动 formatter/trigger/series 等业务字段
  function polish(opt) {
    if (!opt || typeof opt !== 'object') return opt;
    var t = opt.tooltip;
    if (t && typeof t === 'object') {
      t.backgroundColor = C.tooltipBg;
      t.borderColor = C.tooltipBorder;
      t.borderWidth = 1;
      t.textStyle = Object.assign({ color: C.text, fontSize: 12 }, t.textStyle);
      if (!t.padding) t.padding = [10, 14];
      if (!t.extraCssText || t.extraCssText.indexOf('border-radius') < 0) {
        t.extraCssText = TT_SHELL_CSS + (t.extraCssText || '');
      }
    }
    var lg = opt.legend;
    if (lg && typeof lg === 'object' && !lg.icon) lg.icon = 'roundRect';
    return opt;
  }

  // 包装实例：setOption 自动过 polish；模块在 echarts.init 之后调用一次即可全模块生效
  function attach(chart) {
    if (!chart || chart.__saPolished) return chart;
    var raw = chart.setOption.bind(chart);
    chart.setOption = function (opt) {
      try { polish(opt); } catch (_) { /* 视觉修补失败不影响渲染 */ }
      return raw.apply(chart, arguments);
    };
    chart.__saPolished = true;
    return chart;
  }

  // dataZoom 滑杆样式片段（spread 进既有 dataZoom slider 项）
  var zoomStyle = {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    fillerColor: 'rgba(240,185,123,0.10)',
    dataBackground: THEME.dataZoom.dataBackground,
    selectedDataBackground: THEME.dataZoom.selectedDataBackground,
    handleStyle: { color: C.handle, borderColor: C.handle },
    moveHandleStyle: { color: 'rgba(127,168,201,0.45)' },
    textStyle: { color: C.textDim },
  };

  window.SA_CHART = {
    colors: C,
    grad: grad,
    rgba: rgba,
    polish: polish,
    attach: attach,
    zoomStyle: zoomStyle,
    theme: THEME,
  };

  if (window.echarts && window.echarts.registerTheme) {
    window.echarts.registerTheme('softDark', THEME);
  }
})();
