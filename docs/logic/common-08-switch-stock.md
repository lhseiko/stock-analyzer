# 自选股切股交互（点一次即切 + 切股反馈） · 反向逻辑说明

> 逻辑模型位置：跨页面公共 → 左栏自选股列表 + 全局加载指示
> 实现文件：`public/js/app.js`（`analyze` / `showLoading` / `hideLoading` / `bindWatchlistEvents` / `startWatchlistQuoteRefresh` / `patchWatchlistPrices`）、`public/index.html`（`#loadingPill`）、`public/css/style.css`（`.loading-pill`）
> 口径出处：全部标注 `file:line`；查无出处标「⚠️ 待核实」，禁止臆断
> 引入版本：`20261022i`（用户报障原文：「图片内的个股需要多次点击后才能切换到个股页面，系统反应缓慢，检查。」）

## 一、界面元素 → 产生规则

| 界面元素 | 含义与规则 | 出处 |
|---|---|---|
| 点自选股行 → 立即变选中态 | `analyze()` 设置 `currentSymbol` 后**立刻** `updateWatchlistSelection()`，不再等 fetch 回来 | `app.js:analyze`（`this.currentSymbol = symbol;` 之后第一行） |
| 顶部 3px 进度条 | 既有非阻塞指示（`pointer-events:none`） | `app.js:showLoading` |
| 顶部居中小胶囊「正在加载 贵州茅台…」+ 转圈 | 20261022i 新增。**在此之前 `showLoading(text)` 把 text 参数整个丢弃**，几秒等待期屏幕毫无文字提示 | `index.html:#loadingPill`、`style.css:.loading-pill` |
| 60s 后价格/涨跌幅原地跳动 | 只 patch `.wl-price` / `.wl-chg` 单元格，不动 DOM 结构与顺序（排序态除外） | `app.js:patchWatchlistPrices` |

## 二、根因链（为什么"点好几次才切得过去"）

四个原因叠加，缺一不可解释用户体感：

| # | 成因 | 机制 | 用户感知 |
|---|---|---|---|
| A | **无可见反馈** | `showLoading(text)` 丢弃 text，只驱动 3px 进度条；`renderDashboard` 只在 fetch 回来后执行 → 等待期屏幕**仍是上一只股票的内容** | 「点了没反应」 |
| B | **连点重置读条** | 每次 `analyze()` 都 `_reqToken++` 并重新 `fetch`，旧请求返回值被 `token !== _reqToken` 丢弃 → 连续点击 = 不断把 2~4 秒计时**从头开始** | 「越点越慢，点了好多次才出来」 |
| C | **click 被拖拽吞掉** | 默认顺序下行带 `draggable="true"`；指针按下时只要有几像素移动，浏览器就判为 HTML5 拖拽并**不再派发 `click`** | 「必须点好几次」（触控板/手抖鼠标尤甚） |
| D | **定时刷新重建 DOM** | `startWatchlistQuoteRefresh` 注释写「不重渲染整个列表，只更新价格/涨跌幅单元」，实际调 `renderWatchlist()` → `container.innerHTML = ...` 整体重建 | 每 60 秒滚动位置/悬浮态跳动，偶发吃掉"按下时有、抬起时没了"的那次点击 |

**实测耗时（`/api/analysis/:symbol`，本地 3123 实例）**：已看过 0.79~0.96s；冷缓存个股 **1.85s / 2.02s / 2.48s / 3.99s**。四只样本均 > 1.8s，与"反应缓慢"的体感吻合。服务端耗时受上游数据源（东财/新浪/同花顺）影响，本模块**不缩短服务端耗时**，只消除"等待期无反馈 + 连点重置 + 点击被吞"三项。

## 三、修法与判定规则

### 3.1 同股在飞去重（治 B）

```js
const force = !!(opts && opts.force);
this._inflightTokens = this._inflightTokens || {};
if (!force && this._inflightTokens[symbol] && this._inflightTokens[symbol] === this._reqToken) return;
const token = (this._reqToken = (this._reqToken || 0) + 1);
this._inflightTokens[symbol] = token;
// ...
} finally {
  if (this._inflightTokens[symbol] === token) delete this._inflightTokens[symbol];
}
```

- 判据里必须同时比对 **symbol 与 token**：只比 symbol 会让"被更新请求顶掉的旧请求"永久挡住回头点击；只比 token 无法识别是哪只股票。
- `finally` 清理时只删「自己那一笔」（`=== token`），避免误删更晚发起的请求标记。
- `force:true` 通道：**刷新按钮**、**3月/6月/1年/3年换范围**（语义就是"必须重取"）必须突破去重。遗漏任何一个都会让对应按钮"点了没反应"。
- 递归重连分支在重试前必须 `delete this._inflightTokens[symbol]`，否则重试自己会被自己的去重拦下。

### 3.2 行导航收敛为单一入口（治 C）

```js
const navigateToRow = (row, idx) => { ...analyze(row.dataset.symbol, row.dataset.name); };
const navDeduped = (symbol) => this._wlLastNavSymbol === symbol && Date.now() - this._wlLastNavAt < 600;

row.on('click')       → 若 !navDeduped(symbol) 则 navigateToRow
row.on('pointerdown') → 记录 {symbol, x, y, t}（只认左键 / 非 × 区域）
row.on('pointerup')   → 位移 ≤6px 且间隔 ≤900ms 且 !navDeduped → navigateToRow
row.on('pointercancel') → 清空按压状态
```

- **为什么 `pointerup` 能兜住**：`click` 在拖拽判定成立时会被浏览器取消，但 `pointerup` 一定触发。
- **位移阈值 6px**：超过即视为拖拽排序意图，绝不导航（保住原有拖拽排序功能）。
- **间隔 900ms**：长按不算单击。
- **去重必须带 symbol 维度**：`pointerup` 先于 `click` 触发，若只按时间窗口去重，"快速点 A 再点 B"会把 B 误判成重复点击 → 用户又要点两次。
- **× 删除按钮**：`pointerdown` 在 `wl-remove` 上直接 return，`click` 走删除分支并 `stopPropagation`，不触发导航。

### 3.3 加载胶囊（治 A）

- `#loadingPill` 固定顶部居中，`pointer-events:none` —— **绝不拦截点击**（这是它与 `.loading-overlay` 全屏遮罩的关键区别；后者会把等待期变成"点了也没用"）。
- `showLoading(text)` 写入 `pill.textContent`；`hideLoading()` 先移除 `.on` 淡出，200ms 后再挂 `hidden`（避免文字"啪"地消失）。

### 3.4 定时刷新只 patch 单元格（治 D）

- 默认（未排序）态：遍历 `.wl-row`，按 `data-symbol` 取行情，只改 `.wl-price` 文本与 `.wl-chg` 的 class + 文本。
- **排序态**（`watchlistSortKey` 非空）仍走 `renderWatchlist()`：价格变化会改变行序，不重排就与排序语义不符。
- 时间戳/来源标注等其它字段不在本函数刷新范围（与"数据最新性"规则一致：这些是分析快照，不是实时行情）。

## 四、数据来源与采集链

| 层 | 内容 |
|---|---|
| 数据源 | `/api/analysis/:symbol?range=`（切股）、`/api/quote/:symbol`（60s 行情刷新） |
| 采集/落盘 | 服务端既有链路，本模块不新增取数 |
| 调度 | 切股：用户点击触发；行情：`setInterval 60000` |
| 前端取数 | 两条 API，`cache:'no-store'`（行情刷新） |

## 五、降级 / 容错 / 诚实性设计

| 场景 | 行为 |
|---|---|
| fetch 网络瞬断 | 既有的自动重试 2 次（间隔 2.5s），期间胶囊显示「连接中断，正在自动重连（n/2）…」；重试前清在飞标记 |
| 过期请求返回 | `token !== _reqToken` → 静默丢弃，不弹错误、不干扰新请求 |
| 行情接口失败（60s 刷新） | 单只失败静默跳过，`watchlistQuotes` 保持不变（不显示造假的 0） |
| 无 `#loadingPill`（旧缓存 HTML） | `document.getElementById` 返回 null → 各分支均判空，退化为纯进度条行为 |
| 拖拽排序 | 位移 > 6px 不导航，`dragstart/dragover/drop/dragend` 全链路保留 |

## 六、逻辑漏洞自查清单（审计用）

- [x] `showLoading` 的文字真的落到了 DOM（`test_switch_stock.js` [A]）
- [x] `hideLoading` 先淡出后 hidden（`[A]`）
- [x] 连点两次同股只发 1 个请求（`[B]`）
- [x] 换另一只股票正常发请求（`[B]`）
- [x] `force:true` 能突破去重（`[B]`）
- [x] 请求结束后在飞标记被清理，不会永久锁死（`[B]`）
- [x] click 被吞时 `pointerup` 仍能切换（`[C]` C1）
- [x] `pointerup` 与 `click` 不重复导航（`[C]` C2）
- [x] 纯 `click` 路径（无 pointer 事件）仍可用（`[C]` C3）
- [x] 位移 20px 视为拖拽不导航（`[C]` C4）
- [x] 长按 >900ms 不算单击（`[C]` C5）
- [x] 连续点两只不同股票都生效（`[C]` C6）
- [x] 点 × 只删除不导航（`[C]` C7）
- [x] 右键不导航（`[C]` C8）
- [x] 默认态 `patchWatchlistPrices` 不调用 `renderWatchlist`（`[D]`）
- [x] 价格/涨跌幅单元格就地更新，涨跌色类正确（`[D]`）
- [x] 排序态改走 `renderWatchlist` 保顺序语义（`[D]`）
- [x] 上述接线均有源码级守卫，防回退（`[E]`）
- [ ] ⚠️ 触摸屏（`pointerType:'touch'`）未单独验证：当前逻辑对 touch 同样走 pointerdown/pointerup 与 6px 阈值，理论一致，但真机手感需实测
- [ ] ⚠️ 若将来给 `.wl-row` 内部再加可点击子元素（如分组标签），需同步在 `pointerup` 的 `wl-remove` 判断旁扩展排除清单

## 七、可配置项

| 项 | 当前值 | 位置 |
|---|---|---|
| 位移阈值 | 6px | `app.js:bindWatchlistEvents` |
| 长按阈值 | 900ms | 同上 |
| 导航去重窗口 | 600ms | 同上 |
| 行情刷新周期 | 60s | `app.js:startWatchlistQuoteRefresh` |
| 胶囊淡出 | 200ms（hidden）/ 320ms（进度条） | `app.js:hideLoading` |
| 网络重试 | 2 次，间隔 2.5s | `app.js:analyze` catch |

## 八、守卫

`scripts/test_switch_stock.js` —— **47 项断言**，全离线：真实加载 `public/js/app.js`（stub 掉浏览器依赖）后直接驱动 `App` 的事件处理器，逐条复现 C1~C8 点击序列。
