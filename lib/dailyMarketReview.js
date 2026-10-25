/**
 * 每日「实时大盘 AI 复盘」→ 大盘记录 落盘助手（20261024g）
 * ---------------------------------------------------------------------------
 * 用户 2026-10-24 要求：实时大盘每天下午 3 点收盘后自动解读一次，保存到大盘记录。
 * 本模块只负责「纯逻辑」部分（组装笔记对象 + 同日幂等判定），便于单测；
 * 取数（getMarketOverview）、调用大模型（analyzeMarketOverview）、读写 notes.json 由 server.js 编排。
 *
 * 大盘记录 = data/notes.json 中 scope='market' 的条目（与 public/js/notes.js 的 note 结构一致）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 与 server.js 的 NOTES_FILE 同一份（data/notes.json）；大盘记录 = scope='market' 的条目
// 支持环境变量覆盖（仅用于回归测试隔离；生产不设置则用默认路径）
const NOTES_FILE = process.env.SA_NOTES_FILE
  ? path.resolve(process.env.SA_NOTES_FILE)
  : path.join(__dirname, '..', 'data', 'notes.json');

const MARKER_PREFIX = 'AI 大盘复盘 · ';

/** 当日复盘记录标题（含日期，用于同日幂等） */
function marketReviewMarker(today) {
  return MARKER_PREFIX + today;
}

/**
 * 组装一条 scope=market 的「AI 大盘复盘」笔记。
 * @param {string} today YYYY-MM-DD
 * @param {object} data  { cn:[{name,changePct}], sectorsUp, sectorsDown }（与首页 /api/market-overview 同源）
 * @param {object} ai    { cn, gainers, losers, model }
 * @returns {object|null} 三段解读全空时返回 null（调用方跳过，不写空记录）
 */
function buildMarketReviewNote(today, data, ai) {
  const cn = String((ai && ai.cn) || '').trim();
  const gainers = String((ai && ai.gainers) || '').trim();
  const losers = String((ai && ai.losers) || '').trim();
  if (!cn && !gainers && !losers) return null;
  const idxTxt = ((data && data.cn) || [])
    .map(i => `${i.name || i.code} ${i.changePct != null ? (i.changePct >= 0 ? '+' : '') + Number(i.changePct).toFixed(2) + '%' : ''}`.trim())
    .join('，');
  const content = [
    `【大盘】${cn || '—'}`,
    `【领涨板块】${gainers || '—'}`,
    `【领跌板块】${losers || '—'}`,
    idxTxt ? `【指数收盘】${idxTxt}` : '',
    `（AI 自动复盘 · 数据源：东方财富行业板块/腾讯行情 · 模型：${(ai && ai.model) || '—'}）`,
  ].filter(Boolean).join('\n');
  return {
    id: 'ai-market-' + String(today).replace(/-/g, '') + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    date: new Date().toISOString(),
    scope: 'market',
    aspect: null,
    stockCode: '',
    stockName: '',
    title: marketReviewMarker(today),
    content,
    tags: ['AI复盘', '大盘'],
    type: 'ai',
    ai: true,
    verification: { status: 'pending', result: null, probability: null, lastChecked: null, details: null },
  };
}

/** 当日是否已有 AI 大盘复盘记录（幂等；重启 / 多次触发不重复写） */
function alreadyReviewed(notes, today) {
  const m = marketReviewMarker(today);
  return (Array.isArray(notes) ? notes : []).some(
    n => n && n.scope === 'market' && typeof n.title === 'string' && n.title.includes(m)
  );
}

function readNotes() {
  try {
    const a = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}
function writeNotes(arr) {
  try {
    fs.mkdirSync(path.dirname(NOTES_FILE), { recursive: true });
    fs.writeFileSync(NOTES_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (e) { /* 忽略写入失败 */ }
}

/**
 * 把一次 AI 大盘解读写入「大盘记录」（data/notes.json scope=market）。
 * 20261024l：手动「AI 解读」与 15:30 定时复盘共用此入口。
 * 同一交易日（date）已有记录 → **更新**（不重复、不刷屏）；否则新增一条。
 * @param {object} p { date:string(交易日 YYYY-MM-DD), data:object, ai:object }
 * @returns {{saved:boolean, updated?:boolean, reason?:string}}
 */
function saveMarketReviewNote({ date, data, ai }) {
  if (!date) return { saved: false, reason: '缺少日期' };
  const note = buildMarketReviewNote(date, data, ai);
  if (!note) return { saved: false, reason: 'AI 解读内容为空' };
  const notes = readNotes();
  const marker = marketReviewMarker(date);
  const idx = notes.findIndex(n => n && n.scope === 'market' && typeof n.title === 'string' && n.title.includes(marker));
  if (idx >= 0) {
    const old = notes[idx];
    notes[idx] = {
      ...old,
      title: note.title,
      content: note.content,
      tags: note.tags,
      type: 'ai',
      ai: true,
      updatedAt: new Date().toISOString(),
    };
    writeNotes(notes);
    return { saved: true, updated: true };
  }
  notes.unshift(note);
  writeNotes(notes);
  return { saved: true, updated: false };
}

module.exports = { marketReviewMarker, buildMarketReviewNote, alreadyReviewed, saveMarketReviewNote, NOTES_FILE };
