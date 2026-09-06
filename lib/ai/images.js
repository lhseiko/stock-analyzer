/**
 * lib/ai/images.js —— aiAugment 领域子模块：图片下载与兜底搜图（拆分重构 202609）
 * ----------------------------------------------------------------
 * downloadImage/searchCommonsImage 供 products.js 使用；attachImage 供 company.js 使用。
 * （products.js 内联了自己的下载逻辑时也不经 attachImage，与拆分前一致。）
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { UA, IMG_DIR } = require('./config');

// 下载产品图片到本地缓存（避免外链失效），失败返回 false
async function downloadImage(url, destPath) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA },
    });
    const buf = Buffer.from(resp.data);
    const ct = (resp.headers && resp.headers['content-type']) || '';
    const isImageCt = /image\//.test(ct);
    const isMagic = buf.length >= 4 && (
      (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) || // JPEG
      (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) || // PNG
      (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) // WEBP (RIFF)
    );
    if (!isImageCt && !isMagic) return false;
    if (buf.length < 500) return false;
    fs.writeFileSync(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

// 无 Key 兜底：按产品名在 Wikimedia Commons 搜索一张真实图片（仅取图片直链）
async function searchCommonsImage(query) {
  // 生成由"完整→去括号→去括号前→逐级缩写"的查询变体，提升命中率
  const base = (query || '').trim();
  const variants = [];
  if (base) variants.push(base);
  const noParen = base.replace(/[（(][^()]*[)）]/g, '').trim();
  if (noParen && noParen !== base) variants.push(noParen);
  const beforeParen = base.split(/[（(]/)[0].trim();
  if (beforeParen && beforeParen !== base && beforeParen.length >= 2) variants.push(beforeParen);
  const cn = base.replace(/[（(][^()]*[)）]/g, '').replace(/[^一-龥]/g, '');
  for (const len of [4, 3, 2]) {
    if (cn.length >= len) {
      const s = cn.slice(0, len);
      if (!variants.includes(s)) variants.push(s);
    }
  }
  // 后缀变体：品牌核心常在词尾（如「飞天茅台」→「茅台」）
  for (const len of [3, 2]) {
    if (cn.length >= len) {
      const s = cn.slice(-len);
      if (!variants.includes(s)) variants.push(s);
    }
  }
  const seen = new Set();
  for (const q of variants) {
    if (!q || seen.has(q)) continue;
    seen.add(q);
    try {
      const url = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=' +
        encodeURIComponent(q) + '&gsrnamespace=6&gsrlimit=6&prop=imageinfo&iiprop=url%7Cmime&iiurlwidth=500&format=json';
      const resp = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': UA } });
      const pages = resp.data && resp.data.query && resp.data.query.pages;
      if (!pages) continue;
      for (const k of Object.keys(pages)) {
        const ii = pages[k].imageinfo && pages[k].imageinfo[0];
        if (ii && ii.thumburl && /image\//.test(ii.mime || '')) return ii.thumburl;
      }
    } catch {}
  }
  return '';
}

// 通用：为某个图片候选(URL + 搜图关键词)解析出本地图片路径（优先 AI 直链，失败则 Commons 兜底）
async function attachImage(symbol, prefix, url, query) {
  const tryUrl = async (u) => {
    if (!u || !/^https?:\/\//.test(u)) return '';
    const lower = u.toLowerCase();
    const ext = lower.endsWith('.png') ? 'png' : lower.endsWith('.webp') ? 'webp' : 'jpg';
    const fname = `${symbol}_${prefix}.${ext}`;
    const fpath = path.join(IMG_DIR, fname);
    const ok = await downloadImage(u, fpath);
    return ok ? `/api/ai/img/${fname}` : '';
  };
  let local = await tryUrl(url);
  if (!local && query) {
    try { const c = await searchCommonsImage(query); if (c) local = await tryUrl(c); } catch {}
  }
  return local;
}

module.exports = { downloadImage, searchCommonsImage, attachImage };
