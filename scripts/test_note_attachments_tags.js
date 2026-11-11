#!/usr/bin/env node
// [20261104h] 投资心得图片附件 + 标签分类守卫（用户指令：① 写心得可添加图片等附件；② 心得按标签
// 分类展示和管理；③ 心得卡片右上角「💡 投资心得」改为显示对应标签）。
// 服务端：POST /api/notes/attachments（multer 图片 10MB）/ DELETE /api/notes/attachment（路径穿越校验）
//         / 静态服务 /note-attachments；前端 notes.js：add() 白名单 attachments、表单附件区、
//         renderNoteCard 标签徽标 + 附件缩略图、renderScopePage 标签筛选条 + 重命名/删除管理。
// 纯前端渲染逻辑用 node + 最小 DOM 桩断言；源码接线用源码包含断言；版本戳随 h 升级。
'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.error('  ✗ ' + name); }
}

// 最小 DOM 桩：notes.js 的 escapeHtml 依赖 document.createElement（node 下无浏览器），
// 桩仅实现 textContent → innerHTML 的 HTML 实体转义语义，供 renderNoteCard 直接执行。
global.document = {
  createElement() {
    const state = { text: '' };
    const el = {};
    Object.defineProperty(el, 'textContent', { set(v) { state.text = String(v); }, get() { return state.text; } });
    Object.defineProperty(el, 'innerHTML', {
      get() {
        return state.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      },
    });
    return el;
  },
};

console.log('===== §1 前端 renderNoteCard（最小 DOM 桩，node 直接执行） =====');
{
  // notes.js 在 node 下 require（window 未定义分支已兼容），escapeHtml 可独立验证
  const Notes = require(path.join(ROOT, 'public', 'js', 'notes.js'));
  ok(typeof Notes.renderNoteCard === 'function', 'renderNoteCard 可调用');
  const cardGlobal = Notes.renderNoteCard({
    id: 't1', date: '2026-11-04T09:37:54.413Z', scope: 'global',
    title: '测试心得', content: '内容', tags: ['提醒', '仓位'], attachments: [],
    verification: { status: 'pending' },
  });
  ok(!cardGlobal.includes('💡 投资心得'), 'global 卡片右上角不再显示「💡 投资心得」');
  ok(cardGlobal.includes('#提醒') && cardGlobal.includes('#仓位'), '右上角改为标签徽标（#提醒 / #仓位）');
  ok(cardGlobal.includes('note-tag-badge') && cardGlobal.includes('data-tag="提醒"'), '标签徽标带 data-tag（点击筛选接线）');
  const cardNoTag = Notes.renderNoteCard({
    id: 't2', date: '2026-11-04T09:37:54.413Z', scope: 'global',
    title: '无标签', content: '内容', tags: [], verification: { status: 'pending' },
  });
  ok(!cardNoTag.includes('note-tag-badge'), '无标签时如实不显示徽标（不回退旧文案）');
  const cardMarket = Notes.renderNoteCard({
    id: 't3', date: '2026-11-04T09:37:54.413Z', scope: 'market',
    title: '大盘', content: '内容', tags: [], verification: { status: 'pending' },
  });
  ok(cardMarket.includes('🌐 大盘记录'), '大盘记录徽标保持不变（隔离）');
  const cardStock = Notes.renderNoteCard({
    id: 't4', date: '2026-11-04T09:37:54.413Z', scope: '601318', stockName: '中国平安',
    title: '个股', content: '内容', tags: [], verification: { status: 'pending' },
  });
  ok(cardStock.includes('中国平安'), '个股卡片右上角股票名保持不变（隔离）');
  const cardAtt = Notes.renderNoteCard({
    id: 't5', date: '2026-11-04T09:37:54.413Z', scope: 'global',
    title: '带图', content: '内容', tags: [], verification: { status: 'pending' },
    attachments: [{ url: '/note-attachments/20261104/abc.png', name: '截图.png', mime: 'image/png', size: 123 }],
  });
  ok(cardAtt.includes('note-attach-grid') && cardAtt.includes('/note-attachments/20261104/abc.png'), '附件缩略图区渲染（URL 透出）');
  ok(cardAtt.includes('target="_blank"'), '缩略图点击新标签页看原图');
  const cardOld = Notes.renderNoteCard({
    id: 't6', date: '2026-11-04T09:37:54.413Z', scope: 'global',
    title: '旧数据', content: '内容', tags: [], verification: { status: 'pending' },
  });
  ok(!cardOld.includes('note-attach-grid'), '旧数据无 attachments 字段不渲染附件区（兼容兜底）');
}

console.log('===== §2 前端数据/表单/筛选源码接线 =====');
{
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'notes.js'), 'utf8');
  ok(src.includes('attachments: Array.isArray(note.attachments) ? note.attachments : []'), 'add() 白名单透传 attachments（旧数据 [] 兜底）');
  ok(src.includes("id=\"noteFiles\"") && src.includes("accept=\"image/jpeg,image/png,image/gif,image/webp\""), '表单附件选择框（仅图片类型，多选）');
  ok(src.includes("fd.append('file', f)") && src.includes("fetch('/api/notes/attachments'"), '选图即传 POST /api/notes/attachments');
  ok(src.includes("fetch('/api/notes/attachment?url=' + encodeURIComponent"), '移除附件/删除笔记调用 DELETE 清理文件（best effort）');
  ok(src.includes('renderGlobalTagFilter') && src.includes("bar.id = 'globalTagBar'"), '投资心得页标签筛选条注入（幂等）');
  ok(src.includes("'__none__'"), '「未分类」筛选分支存在');
  ok(src.includes("data-manage=\"rename\"") && src.includes("data-manage=\"delete\""), '标签管理（重命名/删除）接线');
  ok(src.includes('this._globalTagFilter'), '标签筛选状态驱动列表过滤');
  // 隔离守卫：market 检索面板逻辑未被破坏
  ok(src.includes('renderMarketDbPanel') && src.includes("panel.id = 'mldbPanel'"), '大盘记录检索面板保持不变（隔离）');
}

console.log('===== §3 服务端上传/删除/静态服务接线 =====');
{
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(src.includes("app.post('/api/notes/attachments', noteAttachUpload.single('file')"), '上传路由（multer 单文件字段 file）');
  ok(src.includes("app.delete('/api/notes/attachment'"), '附件删除路由');
  ok(src.includes("app.use('/note-attachments', express.static(path.join(__dirname, 'data', 'note-attachments')"), '附件静态服务（/note-attachments 前缀）');
  ok(src.includes("limits: { fileSize: 10 * 1024 * 1024 }"), '上传上限 10MB');
  ok(src.includes("'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp'"), '图片类型白名单（仅四类）');
  ok(src.includes("url.startsWith('/note-attachments/')") && src.includes("startsWith(path.resolve(NOTE_ATTACH_DIR) + path.sep)"), '删除路由防路径穿越双校验');
  ok(src.includes('fixNoteAttachName'), '中文文件名 latin1 乱码修复');
}

console.log('===== §4 CSS 样式接线 =====');
{
  const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  ok(css.includes('.note-tag-badge'), '标签徽标样式');
  ok(css.includes('.note-attach-grid') && css.includes('.note-attach-item img'), '卡片附件缩略图样式');
  ok(css.includes('.form-attach-grid') && css.includes('.form-attach-remove'), '表单附件区样式（含移除按钮）');
  ok(css.includes('.tag-filter-bar') && css.includes('.tag-chip.active'), '标签筛选条样式（含激活态）');
}

console.log('===== §5 版本戳 =====');
{
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(server.includes("const APP_VERSION = '20261111b'"), 'server.js APP_VERSION=20261111b');
  ok(server.includes('[20261104h] 投资心得图片附件 + 标签分类'), 'server.js 含 20261104h 版本注释条目');
  ok(server.includes('[20261104g] 「回到顶部」点击无反应修复'), '前版 20261104g 条目保留');
  const idx = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  ok(idx.includes('?v=20261111b'), 'index.html 版本戳 ?v=20261111b');
}

console.log(`\n===== 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail > 0 ? 1 : 0);
