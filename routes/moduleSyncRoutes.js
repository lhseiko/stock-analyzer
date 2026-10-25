/**
 * routes/moduleSyncRoutes.js —— 模块联动应答机制观测/触发 API（20261024h）
 * ---------------------------------------------------------------------------
 * GET  /api/module-sync/graph    依赖图（源模块 → 联动模块 + 是否有失效句柄）
 * GET  /api/module-sync/signals  最近同步信号（谁变了、通知了谁、实际失效几条）
 * POST /api/module-sync/emit     手动发送一次同步信号（排障/验证用）
 * 挂载：server.js 中 app.use(moduleSyncRoutes)（路由内部保留 /api 前缀）。
 */
'use strict';
const express = require('express');
const router = express.Router();
const ms = require('../lib/moduleSync');

router.get('/api/module-sync/graph', (req, res) => {
  try { res.json({ success: true, ...ms.getGraph(), stats: ms.stats() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/api/module-sync/signals', (req, res) => {
  try { res.json({ success: true, signals: ms.getRecentSignals(req.query.limit), stats: ms.stats() }); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/api/module-sync/emit', (req, res) => {
  try {
    const { source, symbols, reason, force } = req.body || {};
    if (!source || !ms.DEPENDENTS[source]) {
      return res.status(400).json({ success: false, error: '未知源模块: ' + source });
    }
    const syms = Array.isArray(symbols) ? symbols.map(String).filter(Boolean) : [];
    if (!syms.length) {
      return res.status(400).json({ success: false, error: '需要非空 symbols 数组（按标的失效）' });
    }
    const r = ms.emitChange(source, { symbols: syms, reason: reason || '手动触发', force: !!force });
    res.json({ success: true, ...r });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

module.exports = router;
