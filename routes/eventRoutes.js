/**
 * 三联动模块 · 事件驱动 路由（20260907a）
 * ----------------------------------------------------------------------------
 * 链路：新闻发现事件 → 事件匹配自选股 → 自动调整权重 → 影响评分
 * 端点：
 *   GET  /api/events/active           活跃事件列表 + 受影响自选股汇总
 *   GET  /api/events/active/:symbol   影响某股票的事件（短期/长期口径）
 *   POST /api/events/scan             立即扫描新闻并更新事件库（作废变更个股的短期判断缓存）
 *   GET  /api/events/config           当前配置（分级/权重/衰减/阈值）
 *   POST /api/events/config           更新配置（口头指令调分级·衰减·权重区间）
 *   POST /api/events/:id/pause        暂停/恢复某事件权重
 *   POST /api/events/:id/grade        手动改分级
 *   POST /api/events/recompute       扫描 + 重算所有自选股评分（短期+长期）
 */
const express = require('express');
const eventEngine = require('../lib/eventEngine');
const sameDay = require('../lib/sameDayJudgment');
const longTerm = require('../lib/longTermJudgment');

const router = express.Router();

// 活跃事件 + 受影响自选股汇总
router.get('/api/events/active', (req, res) => {
  try {
    const events = eventEngine.getActiveEvents();
    const watchlist = eventEngine.resolveWatchlist();
    const bySymbol = {};
    for (const w of watchlist) bySymbol[w.symbol] = [];
    for (const e of events) {
      for (const s of (e.affectedSymbols || [])) {
        if (!bySymbol[s]) bySymbol[s] = [];
        bySymbol[s].push({ id: e.id, grade: e.grade, sector: e.sector, signal: e.signal, direction: e.direction });
      }
    }
    res.json({ ok: true, count: events.length, events, affectedBySymbol: bySymbol });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 影响某股票的事件（短期/长期有效权重）
router.get('/api/events/active/:symbol', (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').trim();
    if (!symbol) return res.status(400).json({ ok: false, error: 'NO_SYMBOL' });
    const shortEv = eventEngine.getEventsForSymbol(symbol, 'short');
    const longEv = eventEngine.getEventsForSymbol(symbol, 'long');
    res.json({ ok: true, symbol, short: shortEv, long: longEv });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 立即扫描新闻
router.post('/api/events/scan', async (req, res) => {
  try {
    const result = await eventEngine.scanEvents(true);
    // 事件变化的个股：作废其短期判断缓存，下次打开带事件权重重新生成
    for (const s of (result.changedSymbols || [])) {
      try { sameDay.invalidateJudgmentForSymbol(s); } catch (e) {}
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 查看配置
router.get('/api/events/config', (req, res) => {
  try { res.json({ ok: true, config: eventEngine.loadConfig() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// 更新配置（口头指令：调整分级阈值 / 权重 / 衰减）
router.post('/api/events/config', (req, res) => {
  try {
    const cfg = eventEngine.updateConfig(req.body || {});
    res.json({ ok: true, config: cfg });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 暂停/恢复某事件权重
router.post('/api/events/:id/pause', (req, res) => {
  try {
    const id = String(req.params.id || '');
    const { paused } = req.body || {};
    const r = eventEngine.setEventPaused(id, paused);
    if (!r.ok) return res.status(404).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 手动改分级
router.post('/api/events/:id/grade', (req, res) => {
  try {
    const id = String(req.params.id || '');
    const { grade } = req.body || {};
    const r = eventEngine.setEventGrade(id, grade);
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 确认重大事件（v2：重大需人工确认后才生效并压缩其他因子权重）
router.post('/api/events/:id/confirm', (req, res) => {
  try {
    const id = String(req.params.id || '');
    const r = eventEngine.confirmEvent(id);
    if (!r.ok) return res.status(404).json(r);
    // 确认后立即作废受影响个股的短期判断缓存，下次打开带事件权重重新生成
    for (const s of (r.event.affectedSymbols || [])) {
      try { sameDay.invalidateJudgmentForSymbol(s); } catch (e) {}
    }
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 扫描审计日志（各层拦截数 / 模型判定 / 最终采纳），用于核查与调阈值
router.get('/api/events/audit', (req, res) => {
  try { res.json({ ok: true, audit: eventEngine.loadAudit() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// 重算所有自选股评分（短期+长期）
router.post('/api/events/recompute', async (req, res) => {
  try {
    const result = await eventEngine.scanEvents(true);
    const watchlist = eventEngine.resolveWatchlist();
    const shortOut = [], longOut = [];
    for (const w of watchlist) {
      try {
        const sj = await sameDay.buildJudgment(w.symbol, w.name, w.sector);
        shortOut.push({ symbol: w.symbol, name: w.name, dir: sj.dir, score: sj.score, confidence: sj.confidence });
      } catch (e) { shortOut.push({ symbol: w.symbol, name: w.name, error: e.message }); }
      try {
        const lj = await longTerm.buildLongTermJudgment(w.symbol, w.name);
        longOut.push({ symbol: w.symbol, name: w.name, dir: lj.dir, score: lj.score, confidence: lj.confidence });
      } catch (e) { longOut.push({ symbol: w.symbol, name: w.name, error: e.message }); }
    }
    res.json({ ok: true, scanned: result, short: shortOut, long: longOut });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
