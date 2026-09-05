/**
 * Storage Module - Manages watchlist and search history.
 * 自选股真源已迁移到服务端（/api/watchlist + data/watchlist.json），localStorage 仅作离线兜底。
 */
const Storage = {
  WATCHLIST_KEY: 'stock_analyzer_watchlist',
  HISTORY_KEY: 'stock_analyzer_history',

  // 服务端真源缓存；null = 尚未从服务端加载（回退 localStorage）
  _serverWatchlist: null,

  _wlUrl() { return '/api/watchlist'; },

  // 启动后从服务端拉取自选股真源；失败则保持 null（用 localStorage 兜底）
  async initWatchlist() {
    try {
      const res = await fetch(this._wlUrl(), { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        let list = Array.isArray(data.list) ? data.list : [];
        if (list.length === 0) {
          // 服务端为空：可能是「升级到服务端持久化」后的首次运行。
          // 若本地 localStorage 仍有旧数据，则回填服务端（迁移），避免清空用户已有的自选股。
          try {
            const local = JSON.parse(localStorage.getItem(this.WATCHLIST_KEY) || '[]');
            if (Array.isArray(local) && local.length > 0) {
              await this._pushWatchlist(local); // 写回服务端并设 _serverWatchlist=local
              return local;
            }
          } catch {}
        }
        this._serverWatchlist = list;
        // 同步缓存到 localStorage（离线兜底）
        try { localStorage.setItem(this.WATCHLIST_KEY, JSON.stringify(list)); } catch {}
      }
    } catch (e) {
      // 服务端不可达：_serverWatchlist 保持 null，回退 localStorage
    }
    return this.getWatchlist();
  },

  // 将最新列表写回：始终更新本地缓存（离线兜底），服务端可达则同步写回
  async _pushWatchlist(list) {
    try { localStorage.setItem(this.WATCHLIST_KEY, JSON.stringify(list)); } catch {}
    try {
      await fetch(this._wlUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list }),
      });
      this._serverWatchlist = list;
    } catch (e) {
      // 写回失败不影响本地；下次 initWatchlist 会重新从服务端拉取
    }
  },

  // ---- Watchlist ----
  getWatchlist() {
    if (this._serverWatchlist) return this._serverWatchlist;
    try {
      return JSON.parse(localStorage.getItem(this.WATCHLIST_KEY) || '[]');
    } catch { return []; }
  },

  addToWatchlist(stock) {
    const list = this.getWatchlist().slice();
    if (!list.find(s => s.symbol === stock.symbol)) {
      list.push({ symbol: stock.symbol, name: stock.name, market: stock.market, addedAt: Date.now() });
      this._pushWatchlist(list);
    }
    return list;
  },

  removeFromWatchlist(symbol) {
    const list = this.getWatchlist().filter(s => s.symbol !== symbol);
    this._pushWatchlist(list);
    return list;
  },

  // 持久化任意顺序（拖拽排序）
  setWatchlist(list) {
    this._pushWatchlist(list.slice());
    return list;
  },

  // 置顶：把该股票移到列表最前
  pinToTop(symbol) {
    const list = this.getWatchlist().slice();
    const i = list.findIndex(s => s.symbol === symbol);
    if (i > 0) {
      const [item] = list.splice(i, 1);
      list.unshift(item);
      this._pushWatchlist(list);
    }
    return list;
  },

  // 移动到分组（group 为空字符串表示「未分组」）
  moveToGroup(symbol, group) {
    const list = this.getWatchlist().slice();
    const item = list.find(s => s.symbol === symbol);
    if (item) {
      if (group && group !== '') item.group = group;
      else delete item.group;
      this._pushWatchlist(list);
    }
    return list;
  },

  // 所有已存在的分组名（去重、排除空）
  getGroups() {
    const groups = new Set();
    this.getWatchlist().forEach(s => { if (s.group) groups.add(s.group); });
    return Array.from(groups);
  },

  isInWatchlist(symbol) {
    return this.getWatchlist().some(s => s.symbol === symbol);
  },

  // ---- History ----
  getHistory() {
    try {
      return JSON.parse(localStorage.getItem(this.HISTORY_KEY) || '[]');
    } catch { return []; }
  },

  addToHistory(stock) {
    let list = this.getHistory();
    list = list.filter(s => s.symbol !== stock.symbol);
    list.unshift({ symbol: stock.symbol, name: stock.name, market: stock.market, time: Date.now() });
    list = list.slice(0, 20);
    localStorage.setItem(this.HISTORY_KEY, JSON.stringify(list));
    return list;
  },

  clearHistory() {
    localStorage.removeItem(this.HISTORY_KEY);
  },

  // ---- Format helpers ----
  formatTime(ts) {
    const diff = Date.now() - ts;
    const min = Math.floor(diff / 60000);
    const hour = Math.floor(diff / 3600000);
    const day = Math.floor(diff / 86400000);
    if (min < 1) return '刚刚';
    if (min < 60) return min + '分钟前';
    if (hour < 24) return hour + '小时前';
    if (day < 7) return day + '天前';
    return new Date(ts).toLocaleDateString('zh-CN');
  },

  formatNumber(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(decimals) + '亿';
    if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(decimals) + '万';
    return n.toFixed(decimals);
  },

  formatPercent(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '--';
    return (n > 0 ? '+' : '') + n.toFixed(decimals) + '%';
  }
};
