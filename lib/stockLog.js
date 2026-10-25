// lib/stockLog.js — 个股记录（20261025l，用户要求：个股页新增「个股记录」tab）
// 按日期排序的手动记录：用户为每只个股手动添加「值得注意的问题」（减持公告、业绩雷点、
// 监管问询、股东异动等自由文本），落盘 data/stock-log/<6位代码>.json。
// 隔离原则：纯手动记录，不参与任何判断/评分/回测/准确率统计，不触发任何模块联动。
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'data', 'stock-log');
const MAX_TEXT = 2000;
const MAX_PER_STOCK = 500;   // 单股条数上限，防无限膨胀
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fileFor(symbol) {
  const pure = String(symbol || '').replace(/^(sh|sz|bj)/i, '').replace(/\.HK$/i, '').trim();
  return path.join(DIR, `${pure || 'unknown'}.json`);
}
function ensureDir() { if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true }); }

// 列表：按日期倒序，同日按创建时间倒序
function listLog(symbol) {
  const f = fileFor(symbol);
  if (!fs.existsSync(f)) return { ok: true, items: [] };
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    const items = (Array.isArray(arr) ? arr : []).slice()
      .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
    return { ok: true, items };
  } catch (e) {
    // 文件损坏按空处理，不崩溃不伪造
    return { ok: true, items: [], note: `记录文件损坏已按空处理：${e.message}` };
  }
}

function addLog(symbol, body) {
  const b = body || {};
  const d = String(b.date || '').trim();
  const t = String(b.text || '').trim();
  if (!DATE_RE.test(d)) return { ok: false, error: '日期格式应为 YYYY-MM-DD' };
  if (!t) return { ok: false, error: '内容不能为空' };
  if (t.length > MAX_TEXT) return { ok: false, error: `内容超长（最多 ${MAX_TEXT} 字）` };
  ensureDir();
  const f = fileFor(symbol);
  let arr = [];
  try { if (fs.existsSync(f)) arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (e) { arr = []; }
  if (!Array.isArray(arr)) arr = [];
  if (arr.length >= MAX_PER_STOCK) return { ok: false, error: `该个股记录已达上限（${MAX_PER_STOCK} 条），请先清理旧记录` };
  const item = {
    id: 'log_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    date: d,
    text: t,
    createdAt: new Date().toISOString(),
  };
  arr.push(item);
  fs.writeFileSync(f, JSON.stringify(arr, null, 2));
  return { ok: true, item };
}

function removeLog(symbol, id) {
  const f = fileFor(symbol);
  if (!fs.existsSync(f)) return { ok: false, error: '该个股暂无记录' };
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(f, 'utf8')) || []; } catch (e) { return { ok: false, error: '记录文件损坏' }; }
  if (!Array.isArray(arr)) return { ok: false, error: '记录文件损坏' };
  const next = arr.filter(x => x && x.id !== id);
  if (next.length === arr.length) return { ok: false, error: '记录不存在或已删除' };
  fs.writeFileSync(f, JSON.stringify(next, null, 2));
  return { ok: true };
}

module.exports = { listLog, addLog, removeLog };
