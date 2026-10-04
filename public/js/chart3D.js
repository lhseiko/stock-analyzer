/**
 * chart3D.js —— 工作台 2.5D / 3D 图表组件库（20261003e）
 * ------------------------------------------------------------------------
 * 设计原则：
 *   1. 只改视觉呈现，绝不改数据源、不改业务计算。
 *   2. 真 3D（bar3D）优先，加载失败/移动端自动降级 2.5D 或原 2D。
 *   3. 降级是静默的：任何环境下图表都可用，只是视觉层次不同。
 *
 * 能力：
 *   SA3D.glb()              是否有 echarts-gl 且非移动端（可强制 true/false）
 *   SA3D.mobile()           是否为移动端（窄屏或触屏）
 *   SA3D.bar3D(opt)         生成 bar3D option（grid3D + 光影 + 生长动画两段式）
 *   SA3D.grow(opt)          对 2D 柱图做「生长动画」包装（先 0 后真实值）
 *   SA3D.donut(opt)         2.5D 圆环 option（厚度投影 + 扇区弹出 + 中心文字）
 *   SA3D.lightBar(opt)      2.5D 柱增强（渐变 + 顶部高光 + 底部投影）
 *
 * 加载顺序：echarts.min.js → echarts-gl.min.js → chart3D.js
 */
(function () {
  'use strict';

  var glbCache = null;

  function mobile() {
    try {
      return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
    } catch (e) { return false; }
  }

  function glb() {
    if (glbCache !== null) return glbCache;
    var ok = false;
    try {
      ok = typeof echarts !== 'undefined' &&
        !!echarts.gl &&                                     // echarts-gl 挂载的命名空间
        typeof echarts.registerSeries === 'function' &&
        !mobile();
    } catch (e) { ok = false; }
    glbCache = ok;
    return ok;
  }

  /* ---------- bar3D 真 3D 柱（series 可混入 kind:'line' 的 line3D 折线） ---------- */
  // opt = { xData: [...], series: [{ name, data, kind?: 'bar'|'line', color }], yName, unit }
  function bar3D(opt) {
    var grid = opt.grid || { left: 60, right: 20, top: 30, bottom: 10 };
    var view = opt.view || { alpha: 14, beta: -32, distance: 220 };
    var series = (opt.series || []).map(function (s) {
      var data = s.data.map(function (v, i) {
        return [i, 0, v == null ? 0 : v];
      });
      if (s.kind === 'line') {
        return {
          name: s.name,
          type: 'line3D',
          data: data,
          lineStyle: { width: 2, color: s.color },
          itemStyle: { color: s.color },
          symbol: 'none',
        };
      }
      var itemColor = s.color;
      if (typeof itemColor !== 'function' && itemColor && !Array.isArray(itemColor)) {
        itemColor = (function (base) {
          return function () { return base; };
        })(s.color);
      }
      return {
        name: s.name,
        type: 'bar3D',
        data: data,
        shading: 'lambert',
        barSize: s.barSize || [14, 14],
        bevelSize: 0.6,
        bevelSmoothness: 2,
        itemStyle: { color: itemColor || '#7fa8c9', opacity: 0.92 },
        emphasis: { itemStyle: { color: itemColor || '#7fa8c9', opacity: 1 } },
      };
    });

    return {
      title: opt.title,
      tooltip: {
        trigger: 'item',
        formatter: function (p) {
          var s = opt.series[p.seriesIndex || 0];
          var name = s && s.data ? s.data[p.dataIndex] : null;
          var label = (name && name.name) ? name.name : (opt.xData[p.dataIndex] || '');
          var raw = p.value ? p.value[2] : 0;
          var val = (opt.fmt && typeof opt.fmt === 'function') ? opt.fmt(raw) : raw;
          return (s ? s.name + '<br/>' : '') + label + '：<b>' + val + '</b>' + (opt.unit || '');
        },
      },
      legend: opt.legend || { show: false },
      xAxis3D: {
        type: 'category',
        data: opt.xData,
        axisLabel: { color: '#8B949E', fontSize: 10, interval: opt.labelInterval || 0, formatter: function (v) { return String(v).length > 6 ? String(v).slice(0, 5) + '…' : v; } },
        axisLine: { lineStyle: { color: 'rgba(139,148,158,0.25)' } },
      },
      yAxis3D: { type: 'category', show: false },
      zAxis3D: {
        type: 'value',
        name: opt.yName || '',
        nameTextStyle: { color: '#8B949E', fontSize: 10 },
        axisLabel: { color: '#8B949E', fontSize: 10, formatter: function (v) { return opt.zFmt ? opt.zFmt(v) : v; } },
        splitLine: { lineStyle: { color: 'rgba(139,148,158,0.12)' } },
      },
      grid3D: {
        boxWidth: grid.w || 160,
        boxDepth: grid.d || 60,
        boxHeight: grid.h || 120,
        viewControl: {
          alpha: view.alpha, beta: view.beta, distance: view.distance,
          autoRotate: !!view.autoRotate, autoRotateSpeed: 6,
          rotateSensitivity: 2, zoomSensitivity: 1.4,
          minAlpha: 5, maxAlpha: 60, minBeta: -90, maxBeta: 90,
        },
        axisPointer: { lineStyle: { color: 'rgba(139,148,158,0.4)' } },
        light: {
          main: { intensity: 1.15, shadow: true, alpha: 30, beta: 40 },
          ambient: { intensity: 0.45 },
        },
        environment: '#0B0E11',
        postEffect: {
          enable: true,
          SSAO: { enable: true, quality: 'low', radius: 4, intensity: 1.2 },
          bloom: { enable: true, bloomIntensity: 0.12 },
        },
        temporalSuperSampling: { enable: false },
      },
      series: series,
    };
  }

  /* ---------- 生长动画（2D 柱两段式） ---------- */
  function grow(opt, key) {
    var zero = JSON.parse(JSON.stringify(opt));
    (zero.series || []).forEach(function (s) {
      if (s.type === 'bar' || s.type === 'bar3D') {
        if (s.type === 'bar3D') {
          s.data = s.data.map(function (d) { return [d[0], 0, 0]; });
        } else {
          s.data = s.data.map(function () { return 0; });
        }
      }
    });
    (zero.series || []).forEach(function (s) { s.animation = true; });
    opt.animation = true;
    opt.animationDuration = 900;
    opt.animationDurationUpdate = 500;
    opt.animationEasing = 'cubicOut';
    return { zero: zero, real: opt };
  }

  /* ---------- 2.5D 圆环（厚度投影 + 扇区弹出 + 中心文字） ---------- */
  // opt = { centerText, data: [{name,value,itemStyle}], radius:[a,b], palette }
  function donut(opt) {
    var r = opt.radius || ['38%', '62%'];
    var palette = opt.palette || ['#7fa8c9', '#cf8e8e', '#8fb89a', '#cdab74', '#a99bc4', '#6fb0a4', '#9aa7b0', '#b0a08c'];
    var data = (opt.data || []).map(function (d, i) {
      return {
        name: d.name,
        value: d.value,
        itemStyle: d.itemStyle || { color: palette[i % palette.length] },
      };
    });
    var labelFmt = opt.labelFmt || '{b}\n{d}%';

    var series = [
      // 厚度底座：同数据、整体下移 6px、半透明暗色，营造立体厚度
      {
        name: 'base',
        type: 'pie',
        radius: r,
        center: opt.center || ['50%', '52%'],
        silent: true,
        data: data.map(function (d) { return { value: d.value, itemStyle: { color: 'rgba(8,11,14,0.55)' } }; }),
        label: { show: false },
        emphasis: { scale: false },
        itemStyle: { borderWidth: 0 },
        tooltip: { show: false },
        z: 1,
      },
      // 主环：悬浮扇区弹出（emphasis.scale）
      {
        name: 'main',
        type: 'pie',
        radius: r,
        center: opt.center || ['50%', '50%'],
        data: data,
        label: { formatter: labelFmt, color: '#E6EDF3', fontSize: 11 },
        labelLine: { lineStyle: { color: 'rgba(139,148,158,0.5)' }, length: 10, length2: 8 },
        emphasis: { scale: true, scaleSize: 7, label: { fontSize: 12, fontWeight: 700 } },
        itemStyle: {
          borderColor: 'rgba(255,255,255,0.14)',
          borderWidth: 1,
          shadowBlur: 18,
          shadowColor: 'rgba(0,0,0,0.45)',
        },
        z: 2,
      },
    ];

    var graphics = [];
    if (opt.centerText) {
      graphics.push({
        type: 'text',
        left: 'center',
        top: '46%',
        style: {
          text: opt.centerText.title || '',
          fill: '#E6EDF3',
          fontSize: 16,
          fontWeight: 700,
          textAlign: 'center',
        },
        z: 3,
      });
      if (opt.centerText.sub) {
        graphics.push({
          type: 'text',
          left: 'center',
          top: '55%',
          style: {
            text: opt.centerText.sub,
            fill: '#8B949E',
            fontSize: 11,
            textAlign: 'center',
          },
          z: 3,
        });
      }
    }

    return {
      tooltip: {
        trigger: 'item',
        formatter: opt.tooltipFmt || function (p) {
          if (p.seriesName === 'base') return '';
          return p.name + '：<b>' + p.value + '</b>（' + (p.percent != null ? p.percent.toFixed(1) : '--') + '%）';
        },
      },
      legend: opt.legend || { show: false },
      series: series,
      graphic: graphics,
    };
  }

  /* ---------- 2.5D 柱增强（渐变 + 顶部高光 + 底部投影） ---------- */
  function lightBar(color, pos) {
    var up = pos >= 0;
    return {
      color: {
        type: 'linear',
        x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [
          { offset: 0, color: up ? 'rgba(246,70,93,0.95)' : 'rgba(14,203,129,0.95)' },
          { offset: 1, color: up ? 'rgba(246,70,93,0.45)' : 'rgba(14,203,129,0.45)' },
        ],
      },
      borderRadius: [3, 3, 0, 0],
      shadowBlur: 10,
      shadowColor: up ? 'rgba(246,70,93,0.35)' : 'rgba(14,203,129,0.35)',
      shadowOffsetY: 2,
    };
  }

  /* ---------- 2.5D 立体柱（ECharts custom series，等轴测厚度挤压，无需 echarts-gl） ---------- */
  // 与 bar3D 的区别：保留 2D 坐标轴/grid/dataZoom/折线叠加，只把柱体换成「正面渐变+侧面深色+顶面高光+底部投影」的立体柱，
  // 视觉升级不动任何数据与坐标换算（20261003g，参照参考图等轴测立体柱样式）。
  // opt = { xData, series: [{ name, data: [值 或 {value,color}], color }], unit, depth, noTooltip }
  function bar25D(opt) {
    var palette = opt.palette || ['#7fa8c9', '#cf8e8e', '#8fb89a', '#cdab74', '#a99bc4', '#6fb0a4', '#9aa7b0', '#b0a08c'];
    var unit = opt.unit || '';
    var horizontal = !!opt.horizontal;
    var depthFixed = opt.depth != null ? opt.depth : 8;

    // 颜色解析：#hex / rgb() / rgba()（半透明筹码光带需保留 alpha）
    function hexToRgb(c) {
      var s = String(c || '').trim();
      if (!s) return { r: 127, g: 168, b: 201, a: 1 };
      if (s.charAt(0) === '#') {
        var h = s.slice(1);
        if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        if (h.length === 6 && /^[0-9a-fA-F]{6}$/.test(h)) {
          var n = parseInt(h, 16);
          return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
        }
        return { r: 127, g: 168, b: 201, a: 1 };
      }
      var m = s.match(/rgba?\(([^)]+)\)/i);
      if (m) {
        var parts = m[1].split(',').map(function (x) { return parseFloat(x.trim()); });
        if (parts.length >= 3 && !isNaN(parts[0])) {
          return { r: parts[0], g: parts[1], b: parts[2], a: parts.length >= 4 && !isNaN(parts[3]) ? parts[3] : 1 };
        }
      }
      return { r: 127, g: 168, b: 201, a: 1 };
    }
    function mix(col, t, target) {
      var o = target || { r: 255, g: 255, b: 255 };
      function ch(a, b) { return Math.round(a + (b - a) * t); }
      return { r: ch(col.r, o.r), g: ch(col.g, o.g), b: ch(col.b, o.b), a: col.a != null ? col.a : 1 };
    }
    function css(col) {
      var a = col.a != null ? col.a : 1;
      return a >= 1 ? 'rgb(' + col.r + ',' + col.g + ',' + col.b + ')' : 'rgba(' + col.r + ',' + col.g + ',' + col.b + ',' + a + ')';
    }
    function rawOf(p) {
      var v = p && p.value != null ? p.value : null;
      if (v && typeof v === 'object') v = v.value;
      return v;
    }

    var isNum = function (v) { return typeof v === 'number' && isFinite(v); };
    // 分组柱：统计非折线系列数量，多柱并排时按系列索引水平错位（对应 barGap 分组效果）
    var barSeries = 0;
    for (var bi = 0; bi < (opt.series || []).length; bi++) {
      if ((opt.series || [])[bi].type !== 'line') barSeries++;
    }
    var barAt = 0;
    var series = (opt.series || []).map(function (s, si) {
      // 混合图：折线系列原样透传（保留 yAxisIndex/样式/markPoint 等全部配置）
      if (s.type === 'line') return s;
      var myBar = barAt++;
      var baseColor = (typeof s.color === 'function' ? null : s.color) || palette[si % palette.length];
      var data = (s.data || []).map(function (d) {
        return typeof d === 'object' && d !== null
          ? { value: isNum(d.value) ? d.value : null, color: d.color || baseColor }
          : { value: isNum(d) ? d : null, color: baseColor };
      });
      var min = 0;
      for (var i = 0; i < data.length; i++) if (data[i].value != null && data[i].value < min) min = data[i].value;

      function colorOf(idx) {
        var c = data[idx] && data[idx].color;
        return c || baseColor || palette[(idx + si) % palette.length];
      }

      return {
        name: s.name,
        type: 'custom',
        data: data,
        z: 4,
        renderItem: function (params, api) {
          var idx = params.dataIndex;
          var item = data[idx];
          if (!item || item.value == null) return;
          var v = item.value;
          var col = colorOf(idx);
          var colObj = hexToRgb(col);
          var front = {
            type: 'linear',
            x: 0, y: 0, x2: horizontal ? 1 : 0, y2: horizontal ? 0 : 1,
            colorStops: [
              { offset: 0, color: css(mix(colObj, 0.30)) },
              { offset: 0.5, color: css(mix(colObj, 0.10)) },
              { offset: 1, color: css(mix(colObj, -0.18)) },
            ],
          };
          var side = css(mix(colObj, -0.42));
          var sideDk = css(mix(colObj, -0.55));
          var topCol = css(mix(colObj, 0.5));
          var topCol2 = css(mix(colObj, 0.22));
          var gloss = {
            type: 'linear',
            x: 0, y: 0, x2: horizontal ? 0 : 1, y2: horizontal ? 1 : 0,
            colorStops: [
              { offset: 0, color: 'rgba(255,255,255,0.34)' },
              { offset: 1, color: 'rgba(255,255,255,0)' },
            ],
          };
          var items = [];

          if (horizontal) {
            // 横向条形：类目在 Y 轴、值在 X 轴，等轴测向右上挤出
            var x0 = api.coord([min, idx])[0];
            var x1 = api.coord([Math.max(min, v), idx])[0];
            var bw = Math.max(0, x1 - x0);
            var bandH = (api.size ? api.size([0, 1]) : [16])[1];
            var rowH = bandH * (opt.barRatio || 0.8) / Math.max(1, barSeries);
            var yc = api.coord([Math.max(min, v), idx])[1] + (barSeries > 1 ? (myBar - (barSeries - 1) / 2) * rowH * 1.05 : 0);
            var top = yc - rowH / 2, bot = yc + rowH / 2;
            var depth = Math.min(depthFixed, Math.max(3, rowH * 0.5));
            // 底部投影
            items.push({
              type: 'polygon',
              shape: {
                points: [
                  [x0 - 3, bot + 3], [x1 + 3, bot + 3],
                  [x1 + depth + 6, bot + depth * 0.7 + 3],
                  [x0 + depth * 0.9 - 2, bot + depth * 0.7 + 3],
                ],
              },
              style: { fill: 'rgba(0,0,0,0.28)' },
              silent: true,
            });
            // 正面（渐变玻璃）
            items.push({ type: 'rect', shape: { x: x0, y: top, width: bw, height: rowH }, style: { fill: front } });
            // 顶边高光细条
            items.push({ type: 'rect', shape: { x: x0, y: top, width: bw, height: Math.min(3, rowH * 0.16) }, style: { fill: gloss } });
            // 右端面（深色）
            items.push({
              type: 'polygon',
              shape: {
                points: [
                  [x1, top], [x1 + depth, top - depth * 0.55],
                  [x1 + depth, bot - depth * 0.55], [x1, bot],
                ],
              },
              style: { fill: side },
              silent: true,
            });
            // 右端面内侧暗线（强化转折）
            items.push({
              type: 'polygon',
              shape: {
                points: [
                  [x1, top], [x1 + depth, top - depth * 0.55],
                  [x1 + depth, top - depth * 0.55 + Math.min(6, rowH * 0.3)],
                  [x1, top + Math.min(6, rowH * 0.3)],
                ],
              },
              style: { fill: sideDk },
              silent: true,
            });
            // 顶面（挤出高光）
            items.push({
              type: 'polygon',
              shape: {
                points: [
                  [x0, top], [x1, top],
                  [x1 + depth, top - depth * 0.55], [x0 + depth, top - depth * 0.55],
                ],
              },
              style: { fill: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: topCol }, { offset: 1, color: topCol2 }] } },
              silent: true,
            });
            // 顶面前沿高光
            items.push({
              type: 'polygon',
              shape: {
                points: [
                  [x0, top], [x1, top],
                  [x1 + depth * 0.35, top - depth * 0.55 * 0.35],
                  [x0 + depth * 0.35, top - depth * 0.55 * 0.35],
                ],
              },
              style: { fill: 'rgba(255,255,255,0.22)' },
              silent: true,
            });
            // 必须包 group：echarts 5.4.3 custom series 的 renderItem 不支持返回元素数组
            // （createEl 只读 elOption.type，数组会抛 graphic type "undefined" can not be found）
            return { type: 'group', children: items };
          }

          var xC = api.coord([idx, 0]);
          var xP = api.size ? api.size([1, 0]) : null;
          var bandW = xP ? xP[0] : 29;
          var bw = Math.max(6, Math.min(40, bandW * 0.55 / Math.max(1, barSeries)));
          var cx = xC[0] + (barSeries > 1 ? (myBar - (barSeries - 1) / 2) * bw * 1.05 : 0);
          var y0 = api.coord([0, min])[1];
          var y1 = api.coord([0, Math.max(min, v)])[1];
          var ht = Math.max(0, y0 - y1);
          var depth = Math.min(depthFixed, Math.max(3, bw * 0.45));
          // 底部投影（贴地淡影）
          items.push({
            type: 'polygon',
            shape: {
              points: [
                [cx - 3, y0 + 3],
                [cx + bw + 3, y0 + 3],
                [cx + bw + depth + 6, y0 + depth * 0.7 + 3],
                [cx + depth * 0.9 - 2, y0 + depth * 0.7 + 3],
              ],
            },
            style: { fill: 'rgba(0,0,0,0.28)' },
            silent: true,
          });
          // 正面（渐变玻璃）
          items.push({ type: 'rect', shape: { x: cx, y: y1, width: bw, height: ht }, style: { fill: front } });
          // 正面左侧高光条
          items.push({ type: 'rect', shape: { x: cx, y: y1, width: Math.min(5, bw * 0.18), height: ht }, style: { fill: gloss } });
          // 右侧面（深色）
          items.push({
            type: 'polygon',
            shape: {
              points: [
                [cx + bw, y1],
                [cx + bw + depth, y1 - depth * 0.55],
                [cx + bw + depth, y0 - depth * 0.55],
                [cx + bw, y0],
              ],
            },
            style: { fill: side },
            silent: true,
          });
          // 右侧面内侧暗线（强化转折）
          items.push({
            type: 'polygon',
            shape: {
              points: [
                [cx + bw, y1],
                [cx + bw + depth, y1 - depth * 0.55],
                [cx + bw + depth, y1 - depth * 0.55 + Math.min(6, ht * 0.25)],
                [cx + bw, y1 + Math.min(6, ht * 0.25)],
              ],
            },
            style: { fill: sideDk },
            silent: true,
          });
          // 顶面（高光）
          items.push({
            type: 'polygon',
            shape: {
              points: [
                [cx, y1],
                [cx + bw, y1],
                [cx + bw + depth, y1 - depth * 0.55],
                [cx + depth, y1 - depth * 0.55],
              ],
            },
            style: { fill: { type: 'linear', x: 0, y: 0, x2: 1, y2: 0, colorStops: [{ offset: 0, color: topCol }, { offset: 1, color: topCol2 }] } },
            silent: true,
          });
          // 顶面前沿高光细线
          items.push({
            type: 'polygon',
            shape: {
              points: [
                [cx, y1],
                [cx + bw, y1],
                [cx + bw + depth * 0.35, y1 - depth * 0.55 * 0.35],
                [cx + depth * 0.35, y1 - depth * 0.55 * 0.35],
              ],
            },
            style: { fill: 'rgba(255,255,255,0.22)' },
            silent: true,
          });
          return { type: 'group', children: items };
        },
        itemStyle: { color: baseColor },
        emphasis: {
          itemStyle: {
            shadowBlur: 14,
            shadowColor: function (p) {
              try { var c = colorOf(p.dataIndex); return css(mix(hexToRgb(c), -0.25)); } catch (e) { return 'rgba(0,0,0,0.6)'; }
            },
          },
        },
      };
    });

    // 顶部数值标签：自动提取 custom 数据对象的 value（兼容纯数值），折线系列不附加
    if (opt.label) {
      var labCfg = typeof opt.label === 'function' ? { formatter: opt.label } : opt.label;
      for (var li = 0; li < series.length; li++) {
        if (series[li].type === 'custom' && !series[li].label) {
          var sc = Object.assign({ position: horizontal ? 'right' : 'top', color: '#c9d3dd', fontSize: 11 }, labCfg);
          if (typeof sc.formatter === 'function') {
            var uf = sc.formatter;
            sc.formatter = function (p) { return uf({ dataIndex: p.dataIndex, value: rawOf(p), data: p.data }); };
          }
          series[li].label = sc;
        }
      }
    }

    var xAxis = opt.xAxis || (horizontal
      ? { type: 'value', name: opt.yName || '', axisLabel: opt.xLabel || { color: '#8B949E', fontSize: 10 }, splitLine: { lineStyle: { color: 'rgba(255,255,255,0.05)' } } }
      : { type: 'category', data: opt.xData || [], axisLabel: opt.xLabel || { color: '#8B949E', fontSize: 10 } });
    var yAxis = opt.yAxis || (horizontal
      ? { type: 'category', data: opt.xData || [], inverse: !!opt.inverse, axisLabel: opt.yLabel || { color: '#8B949E', fontSize: 10 } }
      : { type: 'value', name: opt.yName || '', axisLabel: opt.yLabel || { color: '#8B949E', fontSize: 10 } });
    var optOut = {
      tooltip: opt.noTooltip ? undefined : {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: opt.tooltipFmt || function (ps) {
          if (!Array.isArray(ps)) ps = ps ? [ps] : [];
          var name = '';
          var lines = [];
          for (var i = 0; i < ps.length; i++) {
            var p = ps[i];
            if (!p) continue;
            if (!name) name = (opt.xData && opt.xData[p.dataIndex]) || p.name || '';
            var raw = rawOf(p);
            var val = isNum(raw) ? (opt.fmt ? opt.fmt(raw) : raw) : '--';
            lines.push((p.marker || '') + (p.seriesName || '') + '：<b>' + val + '</b>' + unit);
          }
          return (name ? name + '<br/>' : '') + lines.join('<br/>');
        },
      },
      legend: opt.legend || { show: series.length > 1 },
      grid: opt.grid || { left: '8%', right: '5%', bottom: '12%', top: '12%' },
      xAxis: xAxis,
      yAxis: yAxis,
      series: series,
    };
    if (opt.axisPointer && optOut.tooltip) optOut.tooltip.axisPointer = opt.axisPointer;
    return optOut;
  }

  window.SA3D = {
    glb: glb,
    mobile: mobile,
    bar3D: bar3D,
    bar25D: bar25D,
    grow: grow,
    donut: donut,
    lightBar: lightBar,
  };
})();
