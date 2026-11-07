#!/usr/bin/env node
// ============================================================
// 基金行业配置名单滚动稳定守卫（20261105b）
// 用户报障：名单向下浏览时自动回弹到名单前面。
// 根因=分批更新期间每 3 秒轮询 → render() 无条件 innerHTML 全量重建 →
//   浏览器滚动锚定 anchor 失效 → .main-content 滚动位置回弹。
// 修复=① 数据签名比对（未变跳过重建）② 重建时滚动锚定恢复（.main-content）。
// ============================================================
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const ROOT = path.join(__dirname, '..');
console.log('\n== §1 修复机制源码断言 ==');
const src = fs.readFileSync(path.join(ROOT, 'public/js/homeRank.js'), 'utf8');
ok(src.includes('let lastSig = null'), 'lastSig 状态声明（上轮渲染数据签名）');
ok(src.includes('function dataSig(data)'), 'dataSig 签名函数存在');
ok(/p\.running, p\.phase, p\.done/.test(src), '签名覆盖采集进度字段');
ok(/q\.done, q\.published, q\.inWindow, q\.updatedTo/.test(src), '签名覆盖季度状态字段');
ok(src.includes('data.periodLabel, data.note,'), '签名覆盖期次与备注');
ok(/\(data\.industries \|\| \[\]\)\.map\(i => \[i\.name, i\.marketValueYi/.test(src), '签名覆盖行业排名数据（名次/市值/环比/占比/top重仓）');
ok(src.includes('if (sig === lastSig) return;'), '签名相同 → 跳过 innerHTML 重建（滚动位置原样保留）');

console.log('\n== §2 滚动锚定恢复 ==');
ok(src.includes('const beforeTop = oldAnchor ? oldAnchor.getBoundingClientRect().top : null;'), '重建前记录锚点相对视口位置');
ok(src.includes('const delta = newAnchor.getBoundingClientRect().top - beforeTop;'), '重建后测量新位置差值');
ok(src.includes('main.scrollTop += delta'), '差值校正回滚动容器 scrollTop（内容钉在视口原位）');
ok(src.includes("document.querySelector('.main-content') || document.scrollingElement"), '滚动容器=.main-content（20261104g 口径）+ scrollingElement 兜底');
ok(src.includes("body.querySelector('.fmr-table-wrap') || body.querySelector('.fmr-quarter')"), '锚点优先名单表格容器、退化状态条');

console.log('\n== §3 行为语义 ==');
{
  // updEl 时间戳更新必须在 sig 判断之前（数据未变的轮次头部时间照常走）
  const updIdx = src.indexOf("updEl.textContent = parts.join(' · ')");
  const sigIdx = src.indexOf('if (sig === lastSig) return;');
  ok(updIdx > -1 && sigIdx > -1 && updIdx < sigIdx, '「更新 HH:MM」时间戳在签名判断之前更新（未变轮次也照常走）');
  // innerHTML 重建必须在 sig 判断之后
  const rebuildIdx = src.indexOf('body.innerHTML = html;');
  ok(rebuildIdx > sigIdx, 'innerHTML 重建在签名守卫之后（未变不重建）');
}
ok(src.includes('lastSig = null; // 20261104j：手动刷新强制重建一次'), '手动刷新强制重建一次（用户主动动作视觉反馈）');
ok(src.includes("body.innerHTML = '<div class=\"ai-empty\">正在获取全市场基金行业配置名单…</div>'")
   && src.includes("!body.querySelector('.fmr-table') && !body.querySelector('.fmr-quarter')"), '首次 loading 占位仅在无内容时（不破坏已有表格）');

console.log('\n== §4 模块可加载与导出契约 ==');
{
  try {
    const HomeRank = require(path.join(ROOT, 'public/js/homeRank.js'));
    ok(HomeRank && typeof HomeRank.load === 'function' && typeof HomeRank.refresh === 'function' && typeof HomeRank.bind === 'function', 'IIFE require 不碰 document、导出 load/refresh/bind 契约不变');
  } catch (e) { ok(false, 'homeRank.js require 失败: ' + e.message); }
}
{
  // dataSig 纯函数行为验证：从源码提取函数体在沙箱中执行
  const m = src.match(/function dataSig\(data\) \{[\s\S]*?\n  \}/);
  ok(!!m, 'dataSig 函数体可提取');
  if (m) {
    const dataSig = new Function('return ' + m[0])();
    const base = { coverage: { universe: 10, fundsComparable: 8 }, quarter: { published: true, done: false }, industries: [{ name: '半导体', marketValueYi: 8188 }] };
    const s1 = dataSig(base);
    const s2 = dataSig(JSON.parse(JSON.stringify(base)));
    ok(s1 === s2, '相同数据 → 签名一致');
    const s3 = dataSig(Object.assign({}, base, { industries: [{ name: '半导体', marketValueYi: 8200 }] }));
    ok(s3 !== s1, '排名数据变化 → 签名变化');
    const s4 = dataSig(Object.assign({}, base, { progress: { running: true, phase: 'holdings', done: 500 } }));
    ok(s4 !== s1, '采集进度变化 → 签名变化');
    ok(dataSig({}) === dataSig({}), '空数据安全（字段缺省不抛错）');
  }
}

console.log('\n== §5 版本戳 ==');
{
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  ok(/const APP_VERSION = '20261106p'/.test(server), "server.js APP_VERSION=20261106p");
  ok(server.includes('[20261104j] 基金行业配置名单滚动稳定'), 'server.js 含 [20261104j] 版本注释条目（本功能引入版本，历史条目不随全局版本升级）');
  ok(server.includes('[20261104i] 威高血净（603014）专属估值模型'), '前版 [20261104i] 条目保留');
  const idx = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  ok(idx.includes('homeRank.js?v=20261106p'), 'index.html homeRank.js 版本戳已对齐 20261106p');
}

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
