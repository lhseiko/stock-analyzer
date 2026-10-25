# 股票分析工作台 · 设计规范（DESIGN.md）

> 主题：华尔街交易终端 · 深色专业主题（柔和暗色系，面向干眼症 / 强光敏感用户）。
> 本文件是全站 UI 的唯一权威规范；与代码冲突时以本文件为准并修正代码。
> 建立于 2026-10-16（impeccable 全量审计 + 10 项设计升级，版本 20261015i）。

## 1. 语义色纪律（最高优先级，不可违反）

### 1.1 涨跌语义色：全站唯一
- 红涨 `#F6465D`（`--red`），绿跌 `#0ECB81`（`--green`），震荡灰 `#8B949E`（`--flat`）。
- **严禁**用其他任何颜色表达涨跌（紫/蓝/橙一律不得染指涨跌语义）。

### 1.2 淡底 tint 令牌（红绿成对）
- 标准淡底 alpha = 0.10：`--tint-red: rgba(246,70,93,0.10)` / `--tint-green: rgba(14,203,129,0.10)`。
- 旧别名 `--red-light` / `--red-soft` / `--green-light` / `--green-soft` 全部指向上述令牌，新代码直接用 `--tint-*`。
- 强调态可用 0.12 变体（写字面量 `rgba(...,0.12)`），仅用于 hover/强提醒，不用于常规徽章。
- **红绿规则必须成对修改**：动 `--tint-red` 的地方必须检查 `--tint-green` 孪生项。

### 1.3 金色：交互强调唯一色
- `--accent: #F0B97B`（hover `#F5C894`，淡底 `--accent-light` alpha 0.16）。
- 仅用于：焦点环、选中态、主按钮（实底金 + 深字 `#0B0E11`）、品牌强调。不得用于涨跌。

## 2. 徽章两种模式（二选一，不得混搭）

| 模式 | 用法 | 对比度 |
|---|---|---|
| A. 实底 + 深字 | 实底 `--red`/`--green`/`--accent` + 文字 `#0B0E11` | 5.5:1 ~ 11:1 ✓ |
| B. 淡底 + 彩字 | 底 `--tint-red`/`--tint-green` + 字 `--red`/`--green` | 需容器底色够深（见 §4） |

- **禁止实底红/金上放白字**（红底白字仅 3.5:1，不达标）。
- 模式 B 的容器必须用深表面：`--bg-card` `#161B22`、`--bg-elevated` `#1A212B`、`--bg-input` `#0F131A`、`--bg-sidebar` `#0E1217`、`--bg-primary` `#0B0E11`。
- **禁止红/绿字压 `--bg-hover` `#1D242D`**（零 tint 也只有 4.44:1，不达标）。
- JS 注入到卡片上的淡底徽章用 alpha 0.08（卡片上 0.10 彩字差一丝 AA），如 `deepCharts.js` 评级色。

## 3. 表面层级（ elevation ）

```
--bg-primary  #0B0E11  页面最底层
--bg-sidebar  #0E1217  侧栏
--bg-input    #0F131A  输入框 / 深内嵌面板
--bg-card     #161B22  卡片
--bg-hover    #1D242D  悬停 / 次级面（⚠️ 容不得红字）
--bg-elevated #1A212B  抬升面板（弹层 / 下拉）
```
- 嵌套深度：卡片内**最多再嵌一层**内嵌面板（用 `--bg-input` 或 `--bg-primary`），禁止三层套娃。

## 4. 文字与对比度（WCAG AA 是硬底线）

- 文字三级：`--text-primary #E6EDF3` / `--text-secondary #8B949E` / `--text-light #828B96` / `--text-disabled #484F58`。
- 正文 ≥ 4.5:1；纯图标（非文字）≥ 3:1。
- **`--text-light` 上禁止叠加 opacity 0.7–0.9**（合成后跌破 AA）。
- 瞬时态（hover/active）允许贴近 4.5:1，但不得低于非文字 3:1。

## 5. 排版尺度

| 层级 | 尺寸 | 用途 |
|---|---|---|
| h1 | 21px / 700 | 页面主标题（`.logo` / `.jd-title`） |
| h2 | 16px / 600 | 分区标题（含 emoji 产品身份） |
| h3 | 16px / 600 | 卡片标题 |
| 正文 | 14px | 基础字号 |
| 辅助 | 13px / 12px | 说明、徽章、按钮 |
| 微注 | 11px | 时间戳、标签 |

- 数字一律 `font-variant-numeric: tabular-nums`（已在 body 设置）。
- 相邻层级字号比 ≥ 1.3（21/16），避免 detect 的 flat-type-hierarchy 告警。

## 6. 图标与 emoji 纪律

- **分区标题**（h1/h2/h3）保留 emoji 作为产品身份（⭐🕐🎯📋🧭📡…）。
- **按钮 / Tab / 链接动作**一律纯文字，不放装饰 emoji（刷新、导出、AI 操作等）。
- **纯图标按钮**（✕ ▾ ⌨️ 🗑️ 等）允许图标形式，但必须有 `title` + `aria-label`。
- 正文提示 / 状态行 / 图表 tooltip 中的 emoji（✅⚠️⏳📦…）保留为语义标记。

## 7. 动效规范

- 状态过渡（颜色 / 背景 / 边框）：`120ms ease`（新代码标准）。
- 存量兼容：既有 150–200ms 过渡视为合法存量（审计已通过的可扫读区间），仅在顺路改动时收敛，不做批量替换。
- 弹窗进出：250ms；数字刷新闪动 `numFlash` 450ms（`--dur` 可后续令牌化）。
- `prefers-reduced-motion: reduce` 全局降级已落地（style.css 末尾，动画/过渡时长 0.01ms，WCAG 2.3.3 前庭安全）。
- 禁止装饰性循环动效（跑马灯仅限骨架屏加载占位）。

## 8. 焦点可达性

- 全局 `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }`（金色焦点环是键盘用户的唯一导航线索）。

## 9. 版本戳协议（改前端必读）

1. 版本号唯一权威源：`server.js` 的 `APP_VERSION`。
2. 任何前端资源（css/js/html/图标）改动后必须 bump 版本号（格式 `20261015x`），并同步：
   - `server.js` APP_VERSION；
   - `index.html` / `accuracy.html` / `judgments.html` 内全部 `?v=` 戳（favicon、icon.png、css、js 引用）。
3. `index.html` 内 URL 版本补位脚本**禁止硬编码版本号**（防重定向死循环）。
4. 一旦某版本戳被浏览器加载过，后续前端改动必须再次 bump。
5. 后端数据缓存版本（`lib/` cacheVer）与 UI 版本号互不相干，不随 UI bump。

## 10. 已知检测保留项（不是缺陷，勿"修复"）

- side-tab 43 条：红涨绿跌语义条（有意为之）。
- border-accent-on-rounded 1 条：亮点/雷点顶条（语义横幅）。
- dark-glow / marquee / repeating-stripes：20261015i tint 令牌化后，detect 静态扫描无法解析 `var()` 间接引用而不再报出（运行时视觉语义不变，金晕/骨架屏/不可用纹均为有意设计）。
- detect 报文基线：total 44（side-tab 43 + border-accent 1），low-contrast 恒为 0。
- hover 瞬时红 tint（如 doc 删除图标按钮）：非文字元素 3:1 达标，且为瞬时态。

## 11. 图表红绿取色（20261015i 新增）

- 图表序列红涨绿跌唯一取色点：`chartTheme.js` 的 `SA_CHART.colors.up / .down`（#F6465D / #0ECB81）。
- `chart3D.js` lightBar 渐变（0.95/0.45/0.35 alpha）与 `deepCharts.js` 评级徽章文字色一律引用该色板，禁止散落字面量。
- `deepCharts.js` 评级徽章「低估」bg 0.08 是 WCAG 微调值（卡片表面红字 + 0.10 tint 为 4.47:1 略低于 AA），刻意低于标准 0.10，勿"修正"。

## 12. 独立长页统一外壳（20261025f）

四个独立页（notes / accuracy / judgments / logic-model）共用 style.css 文末「独立长页统一外壳」段，页内 `<style>` 仅保留一条 `html, body` 滚动覆盖（html 无法由共享样式按页选择，属已知例外）。

- **页宽阶梯**（内容列宽 = 阶梯值 − 2×24px 页边距，全部居中）：
  - notes `.np-page` 808px（760 阅读列，整页单列含页头）
  - accuracy / judgments `.acc-page` `.jd-page` 1148px（1100 数据列，与首页 `.home-card` 同宽对齐）
  - logic-model `.lm-page` 1328px（1280 宽树列）
- **页头**：统一 `.jd-header` 结构（标题居左 21px/700、动作居右、下边框分隔、18px 顶部呼吸）；logic-model 原独立页头结构废弃，副标题用 `.lm-head-sub` 内联。
- **页头动作次序**：次要按钮在前、主按钮（btn-primary）在后、「返回工作台」居末。
- **sticky 工具条**：`.np-toolbar` / `.acc-toolbar` / `.jd-toolbar` 同一套（top:0、实底 `--bg-primary`、下边框）。
- **页面级芯片**：`.np-tab` / `.acc-tab` / `.jd-tag` 同一套（radius `--radius-sm` 13px，active = `--accent-light` 淡底 + 金字 600，模式 B 徽章）。**芯片三家族分工**：页面级筛选芯片（本条）／图表控件芯片（`.range-btn` `.period-btn` `.dy-toggle-btn`，实底金 + 深字，模式 A）／一级导航 `.tab`（下划线式）——语义不同、各自内部统一，不得跨家族混用样式。
- **大空态**：`.np-list .notes-empty` / `.record-list .jd-empty` / `.acc-body .jd-empty` / `.acc-body .data-empty` 统一虚线框居中大空盒；表格单元格内小空态（`.jd-empty` 裸用、基类 `.data-empty` `.notes-empty`）保持原样。
- **取色纪律**：独立页所有颜色一律 `var()` 令牌；金色淡底唯一令牌 `--accent-light`（0.16），严禁再出现 `rgba(207,174,124,…)` 等杂金与裸 hex 红绿金。
- **动作按钮**：纯文字无 emoji（notes「写心得/记一笔」已去 ✏️；tab 文案去 🧠🌐，emoji 只保留在 h1 标题）。
