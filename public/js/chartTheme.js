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
 * [20261114a] 图例「颜色 + 形状」双编码改造（用户裁决：除主图模块外全站图表）
 *   - 分类配色统一为方案 A（6 色跨色系 + 钢灰），图例与图表数据系列禁用红绿；
 *     文字分析中表示涨跌 / 利好 / 利空的红绿不受影响，按涨跌方向上色的 series 颜色保持不动。
 *   - 图例图标按该组数据在图中的表达方式生成：柱→圆角方块、实线→实线横线、
 *     虚线→虚线横线、点线→点线横线、饼 / 散点→圆点，不再一律方块（WCAG 1.4.1）。
 *   - 主图模块（charts.js：K 线蜡烛 / 分时 / MACD / KDJ / BOLL / 期货对比）整体豁免：
 *     attach(chart, { legendSemantics: false }) 让该实例跳过色板注入与图例语义，
 *     继续继承 THEME.legend.icon='roundRect' 与 THEME.color，视觉零变化。
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
    up: '#F6465D',          // 全站涨色（红涨绿跌语义，图表序列唯一取色点）
    down: '#0ECB81',        // 全站跌色
    tooltipBg: 'rgba(22,27,34,0.97)',
    tooltipBorder: 'rgba(255,255,255,0.10)',
    // 既有柔和调色板（保持不变，避免改变未显式指定颜色的序列的观感）
    // 旧柔和色板：仅保留给主图模块（豁免实例继承 THEME.color 时原样使用，视觉零变化）
    palette: ['#7fa8c9', '#cf8e8e', '#8fb89a', '#cdab74', '#a99bc4', '#6fb0a4', '#9aa7b0', '#b0a08c'],
  };

  // [20261114a] 分类配色方案 A（用户 2026-11-14 裁决）：同一张图前 6 组强制跨色系。
  // 色相依次为 217° / 38° / 271° / 199° / 55° / 250°，避开红（340°–20°）与绿（80°–160°）。
  var PALETTE_A = ['#3B82F6', '#F5A524', '#A855F7', '#38BDF8', '#E8D44D', '#8B7FE8'];
  var NEUTRAL_A = '#8A9BB0';   // 钢灰：基准线 / 均值线

  // [20261114a] 图例形状：ECharts path:// 图标，路径坐标系 24×8（会被缩放到 itemWidth×itemHeight）。
  // 实线 / 虚线 / 点线用「横线」而非方块，使图例形状直接对应图中的线条表达方式。
  var LEGEND_ICONS = {
    bar: 'roundRect',
    line: 'path://M0,3.2 L24,3.2 L24,5.2 L0,5.2 Z',
    dashed: 'path://M0,3.2 L6,3.2 L6,5.2 L0,5.2 Z M9,3.2 L15,3.2 L15,5.2 L9,5.2 Z M18,3.2 L24,3.2 L24,5.2 L18,5.2 Z',
    dotted: 'path://M0,3.2 L2,3.2 L2,5.2 L0,5.2 Z M4.4,3.2 L6.4,3.2 L6.4,5.2 L4.4,5.2 Z M8.8,3.2 L10.8,3.2 L10.8,5.2 L8.8,5.2 Z M13.2,3.2 L15.2,3.2 L15.2,5.2 L13.2,5.2 Z M17.6,3.2 L19.6,3.2 L19.6,5.2 L17.6,5.2 Z M22,3.2 L24,3.2 L24,5.2 L22,5.2 Z',
    point: 'circle',
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
      // [20261114a] 主题级默认方块只服务于「主图模块豁免实例」（charts.js，视觉零变化）。
      // 其余模块由 polish() 对 legend.data 逐项写入语义图标，优先级高于此处。
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

  // [20261114a] 按 series 在图中的表达方式返回图例图标（纯函数，供守卫单测）
  function legendIconFor(s) {
    if (!s || typeof s !== 'object') return LEGEND_ICONS.bar;
    var t = s.type;
    if (t === 'pie' || t === 'scatter' || t === 'effectScatter') return LEGEND_ICONS.point;
    if (t === 'line') {
      var lt = s.lineStyle && s.lineStyle.type;
      if (lt === 'dashed') return LEGEND_ICONS.dashed;
      if (lt === 'dotted') return LEGEND_ICONS.dotted;
      return LEGEND_ICONS.line;   // 面积图同样用横线
    }
    // bar / custom（2.5D 立体柱）/ candlestick / 其余 → 圆角方块
    return LEGEND_ICONS.bar;
  }

  // [20261114b] 方向着色识别：数据项上出现涨红跌绿（含旧版暗红/暗绿）时，该 series 颜色保持不动
  var DIRECTION_COLORS = ['#F6465D', '#0ECB81', '#CF8E8E', '#8FB89A'];
  function isDirectionColor(c) {
    if (typeof c !== 'string') return false;
    var u = c.toUpperCase();
    for (var k = 0; k < DIRECTION_COLORS.length; k++) if (u === DIRECTION_COLORS[k]) return true;
    return u.indexOf('RGBA(207,142,142') === 0 || u.indexOf('RGBA(143,184,154') === 0;
  }
  function hasDirectionColors(s) {
    var d = s && s.data;
    if (!Array.isArray(d)) return false;
    for (var i = 0; i < d.length && i < 40; i++) {
      var it = d[i];
      if (!it || typeof it !== 'object') continue;
      var c = it.color || (it.itemStyle && it.itemStyle.color);
      if (isDirectionColor(c)) return true;
    }
    return false;
  }

  // [20261114b] 按 series 索引给「完全没写颜色」的序列补显式分类色（纯函数，供守卫单测）。
  // 根因：ECharts 对无显式色的 series 依赖主题色板隐式分色；SA3D.bar25D 把柱改写成 custom 且
  // data 项自带颜色时，隐式分色结果不稳定——「机构持仓变化」卡片实测出现柱与折线同为亮蓝、
  // 图例两项颜色无法区分。显式写入后，曲线与图例颜色都由代码锁定，不再受 ECharts 分色策略影响。
  function normalizeSeriesColors(opt) {
    var series = Array.isArray(opt.series) ? opt.series : null;
    if (!series) return opt;
    series.forEach(function (s, i) {
      if (!s || typeof s !== 'object') return;
      // 方向着色（函数色 / 数据项条件色）一律跳过，红涨绿跌语义不变
      if (typeof s.color === 'function' ||
          (s.itemStyle && typeof s.itemStyle.color === 'function') ||
          (s.lineStyle && typeof s.lineStyle.color === 'function') ||
          hasDirectionColors(s)) return;
      var explicit = s.color || (s.itemStyle && s.itemStyle.color) || (s.lineStyle && s.lineStyle.color);
      if (typeof explicit === 'string' && explicit) return;   // 已有显式色，不改
      var c = PALETTE_A[i % PALETTE_A.length];
      s.itemStyle = Object.assign({}, s.itemStyle, { color: c });
      if (s.type === 'line') s.lineStyle = Object.assign({}, s.lineStyle, { color: c });
    });
    return opt;
  }

  // 图例项颜色：优先取同名 series 的显式分类色；无显式色或为方向色时按图例序号取方案 A
  function legendColor(s, i) {
    if (s && typeof s === 'object') {
      var c = s.color || (s.itemStyle && s.itemStyle.color) || (s.lineStyle && s.lineStyle.color);
      if (typeof c === 'string' && c.charAt(0) === '#' && !isDirectionColor(c)) return c;
    }
    return PALETTE_A[i % PALETTE_A.length];
  }

  // [20261114a/b] 给非豁免实例的图例逐项写入语义图标 + 显式颜色；
  // 不改 formatter/trigger/series 数据等业务字段。
  function applyLegendSemantics(opt) {
    if (!opt || typeof opt !== 'object') return opt;
    var series = Array.isArray(opt.series) ? opt.series : (opt.series ? [opt.series] : []);
    var legends = Array.isArray(opt.legend) ? opt.legend : (opt.legend ? [opt.legend] : []);
    var byName = {};
    series.forEach(function (s) { if (s && s.name != null) byName[String(s.name)] = s; });
    legends.forEach(function (lg) {
      if (!lg || typeof lg !== 'object' || lg.show === false) return;
      var data = lg.data;
      if (Array.isArray(data) && data.length) {
        // 逐项按同名 series 推断；找不到同名则按位置回退（饼图扇区名 → 唯一的 pie series → 圆点）
        lg.data = data.map(function (item, i) {
          var name = (item && typeof item === 'object') ? item.name : item;
          var s = byName[String(name)] || series[i];
          var out = (item && typeof item === 'object') ? item : { name: item };
          out.icon = legendIconFor(s);
          if (!out.itemStyle || typeof out.itemStyle !== 'object' || !out.itemStyle.color) {
            out.itemStyle = Object.assign({}, out.itemStyle, { color: legendColor(s, i) });
          }
          return out;
        });
      } else if (series.length >= 2) {
        // 未显式给 legend.data 的混合图：按 series 顺序生成，避免退化成「一律同形」
        lg.data = series.filter(function (s) { return s && s.name != null; })
          .map(function (s, i) {
            return { name: s.name, icon: legendIconFor(s), itemStyle: { color: legendColor(s, i) } };
          });
      } else if (series.length === 1) {
        lg.icon = legendIconFor(series[0]);
      }
    });
    return opt;
  }

  // 外壳级修补：统一 tooltip 外壳 + 非豁免实例的方案 A 色板与图例语义图标
  function polish(opt, opts) {
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
    // 主图豁免实例：跳过色板注入与图例语义，保持 THEME 原样（用户裁决 4）
    if (!(opts && opts.exempt)) {
      opt.color = PALETTE_A.slice();
      normalizeSeriesColors(opt);
      applyLegendSemantics(opt);
    }
    return opt;
  }

  // 包装实例：setOption 自动过 polish；模块在 echarts.init 之后调用一次即可全模块生效
  // opts.legendSemantics === false → 主图豁免（charts.js 唯一使用点）
  function attach(chart, opts) {
    if (!chart) return chart;
    var exempt = !!(opts && opts.legendSemantics === false);
    if (chart.__saPolished) {
      if (exempt) chart.__saLegendExempt = true;
      return chart;
    }
    var raw = chart.setOption.bind(chart);
    chart.__saLegendExempt = exempt;
    chart.setOption = function (opt) {
      try { polish(opt, { exempt: chart.__saLegendExempt }); } catch (_) { /* 视觉修补失败不影响渲染 */ }
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
    paletteA: PALETTE_A,
    neutralA: NEUTRAL_A,
    legendIcons: LEGEND_ICONS,
    legendIconFor: legendIconFor,
    normalizeSeriesColors: normalizeSeriesColors,
    legendColor: legendColor,
    applyLegendSemantics: applyLegendSemantics,
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
