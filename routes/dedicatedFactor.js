/**
 * 专属因子 路由（20260911）
 * ----------------------------------------------------------------------------
 * 端点：
 *   GET  /api/dedicated/:symbol           某股当前的激活专属因子（短/长口径）
 *   POST /api/dedicated/trigger           立即触发月度检索（窗口内/手动强制）并落库
 *   GET  /api/dedicated/active            全部激活专属因子
 *   POST /api/dedicated/cleanup           清理已衰减为 0 的实例
 */
const express = require('express');
const dedicatedFactor = require('../lib/dedicatedFactor');
const moduleSync = require('../lib/moduleSync'); // 20261024h：专属因子变化 → 联动应答

const router = express.Router();

// 某股当前激活专属因子（短/长口径）
router.get('/api/dedicated/:symbol', (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').replace(/^(sh|sz|bj)/i, '');
    const short = dedicatedFactor.getDedicatedFactorsForSymbol(symbol, 'short');
    const long = dedicatedFactor.getDedicatedFactorsForSymbol(symbol, 'long');
    res.json({ ok: true, symbol, short, long });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 全部激活
router.get('/api/dedicated/active', (req, res) => {
  try {
    res.json({ ok: true, active: dedicatedFactor.loadActive() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 手动触发（强制可在窗口外调用，便于验证）
router.post('/api/dedicated/trigger', async (req, res) => {
  try {
    const force = !!(req.body && req.body.force);
    const r = await dedicatedFactor.triggerDedicatedFactors({ force });
    // 状态变化（新实例生成 / 旧实例归档）→ 联动应答机制作废变更个股的短期判断缓存
    const trigSyms = r.changedSymbols || [];
    if (trigSyms.length) moduleSync.emitChange('dedicatedFactor', { symbols: trigSyms, reason: '专属因子手动触发' });
    res.json(Object.assign({ ok: true }, r));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 清理过期（衰减为 0 的实例归档 → 作废变更个股缓存，卡片自动隐藏）
router.post('/api/dedicated/cleanup', (req, res) => {
  try {
    const r = dedicatedFactor.cleanupExpired();
    // 衰减归档 → 联动应答机制作废变更个股缓存，卡片自动隐藏
    const clSyms = r.changedSymbols || [];
    if (clSyms.length) moduleSync.emitChange('dedicatedFactor', { symbols: clSyms, reason: '专属因子衰减清理' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
