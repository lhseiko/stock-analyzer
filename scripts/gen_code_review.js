/**
 * 生成「Stock Analyzer 完整代码审查包」
 * 产出 docs/code-review/ 下：
 *   README.md            —— 索引：统计、架构说明、完整文件树（含行数）
 *   code-<子系统>-N.md   —— 各子系统完整源码分卷（按行数切分，避免单文件过大）
 * 用法：node scripts/gen_code_review.js
 */
const fs = require('fs');
const path = require('path');

const BASE = process.cwd();
const OUT_DIR = path.join(BASE, 'docs', 'code-review');
fs.mkdirSync(OUT_DIR, { recursive: true });

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', '.workbuddy', '.venv_akshare']);
const SKIP_FILES = new Set(['package-lock.json']);
const TEXT_EXT = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs', '.json', '.html', '.htm',
  '.css', '.scss', '.md', '.markdown', '.py', '.txt', '.yml', '.yaml',
  '.ejs', '.svg', '.vue', '.sh', '.bat', '.ps1', '.sql', '.csv', '.log',
]);
const CHUNK_LINES = 18000; // 单分卷上限，超过则切分到下一卷

// 子系统分组（按顶层目录），顺序即分卷顺序
const GROUPS = [
  { key: 'entry', label: '入口与服务层（server.js / routes / prompts / 根配置）', match: p => p === 'server.js' || p.startsWith('routes' + path.sep) || p.startsWith('prompts' + path.sep) || ['package.json', 'generate_icon.py', 'DESIGN.md', '需求汇总.md', 'SESSION-STATE.md'].includes(p) },
  { key: 'lib', label: '核心业务逻辑（lib/）', match: p => p.startsWith('lib' + path.sep) },
  { key: 'public', label: '前端（public/）', match: p => p.startsWith('public' + path.sep) },
  { key: 'scripts', label: '脚本与测试（scripts/）', match: p => p.startsWith('scripts' + path.sep) && p !== path.join('scripts', 'gen_code_review.js') },
  { key: 'docs', label: '项目文档（docs/）', match: p => p.startsWith('docs' + path.sep) && !p.startsWith(path.join('docs', 'code-review') + path.sep) },
  { key: 'misc', label: '其余（.learnings / miaoxiang / reports / 根级零散文件）', match: p => true },
];

function groupOf(rel) {
  for (const g of GROUPS) if (g.match(rel)) return g.key;
  return 'misc';
}

// 递归收集文本文件
const collected = [];
function walk(absDir, relPrefix) {
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(absDir, e.name);
    const rel = relPrefix ? path.join(relPrefix, e.name) : e.name;
    if (e.isDirectory()) { walk(abs, rel); continue; }
    if (SKIP_FILES.has(e.name)) continue;
    if (rel.startsWith(path.join('docs', 'code-review') + path.sep)) continue;
    if (rel === path.join('scripts', 'gen_code_review.js')) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!TEXT_EXT.has(ext)) continue;
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.size > 2 * 1024 * 1024) continue; // 跳过异常大文件（防卡死）
    collected.push({ abs, rel, size: stat.size });
  }
}
walk(BASE, '');

// 读取内容 + 行数
let totalLOC = 0;
const files = collected.map(f => {
  let content = '';
  let truncated = false;
  try {
    const buf = fs.readFileSync(f.abs);
    if (buf.includes(0x00)) { content = '（二进制文件，已跳过）'; f.loc = 0; f.skip = true; return f; }
    content = buf.toString('utf8');
  } catch { content = '（读取失败）'; f.loc = 0; f.skip = true; return f; }
  const loc = content.split('\n').length;
  if (content.length > 1_500_000) { content = content.slice(0, 1_500_000) + '\n\n…（内容过长，已截断展示）'; truncated = true; }
  f.content = content;
  f.loc = loc;
  f.truncated = truncated;
  totalLOC += loc;
  return f;
}).filter(f => !f.skip);

files.sort((a, b) => a.rel.localeCompare(b.rel));

// 按组切分分卷
const parts = {}; // key -> [{rel, loc, content, truncated}]
for (const g of GROUPS) parts[g.key] = [];
for (const f of files) {
  const key = groupOf(f.rel);
  parts[key].push(f);
}

// 写分卷：每组内按累计行数切分为 N 卷
const partFiles = [];
function writePart(groupKey, groupLabel, idx, items) {
  const fname = `code-${groupKey}-${idx}.md`;
  const fpath = path.join(OUT_DIR, fname);
  const head = `# ${groupLabel} · 第 ${idx} 卷\n\n> 共 ${items.length} 个文件，本卷约 ${items.reduce((s, x) => s + x.loc, 0)} 行\n\n`;
  let body = '';
  for (const f of items) {
    const ext = path.extname(f.rel).replace('.', '') || 'text';
    body += `\n---\n\n## \`${f.rel}\`  ·  ${f.loc} 行${f.truncated ? '（已截断）' : ''}\n\n~~~${ext}\n${f.content}\n~~~\n`;
  }
  fs.writeFileSync(fpath, head + body);
  partFiles.push({ fname, label: `${groupLabel} 第${idx}卷`, count: items.length, loc: items.reduce((s, x) => s + x.loc, 0) });
}

for (const g of GROUPS) {
  const items = parts[g.key];
  if (!items.length) continue;
  let cur = [], curLoc = 0, idx = 1;
  for (const f of items) {
    if (curLoc > 0 && curLoc + f.loc > CHUNK_LINES) { writePart(g.key, g.label, idx++, cur); cur = []; curLoc = 0; }
    cur.push(f); curLoc += f.loc;
  }
  if (cur.length) writePart(g.key, g.label, idx, cur);
}

// 构建文件树
function buildTree(items) {
  const root = {};
  for (const f of items) {
    const parts = f.rel.split(path.sep);
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const seg = parts[i];
      const isLeaf = i === parts.length - 1;
      if (!node[seg]) node[seg] = isLeaf ? { __leaf: true, loc: f.loc } : {};
      node = node[seg];
    }
  }
  let out = '';
  function render(node, prefix) {
    const keys = Object.keys(node).filter(k => k !== '__leaf').sort();
    for (const k of keys) {
      const child = node[k];
      if (child.__leaf !== undefined) {
        out += `${prefix}${k}  _(${child.loc} 行)_\n`;
      } else {
        out += `${prefix}📁 ${k}/\n`;
        render(child, prefix + '  ');
      }
    }
  }
  render(root, '');
  return out;
}

const tree = buildTree(files);
const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

const readme = `# Stock Analyzer · 完整代码审查包

> 生成时间：${now}
> 项目根目录：\`${BASE}\`
> 源码统计：共 **${files.length}** 个文本文件，约 **${totalLOC.toLocaleString()}** 行（已排除 node_modules / .venv_akshare / data / .git / .workbuddy / package-lock.json）

## 一、如何阅读这份包
- **本文件（README.md）= 导航总览**：含架构说明与完整文件树（每个文件标注行数，便于定位）。
- **code-\*.md = 各子系统完整源码分卷**：按子系统分组、按行数切卷；每卷内每个文件以 \`## \`路径\`\` 为标题、下接代码块，可直接全文检索。
- 检索建议：在编辑器/预览中按文件名（如 \`lib/reviewContext.js\`）搜索即可跳到对应分卷。

## 二、架构总览（给非技术审阅者）
Stock Analyzer 是一个 **Node.js + Express 本地 Web 工作台**（固定运行 3005 端口），自研量化分析：
- **数据层**：主行情来自腾讯行情接口（GBK 编码），深度分析依赖东财妙想金融数据；外抓补充来自 akshare（Python 虚拟环境 .venv_akshare）。
- **业务逻辑层（lib/）**：各类确定性引擎（量能、题材归因、估值、深度分析、短期判断等），所有数值由代码计算，LLM 仅负责叙事，不推导公式。
- **服务层（server.js + routes/）**：Express 路由、定时调度（盘前/盘后/补录）、REST API。
- **展示层（public/）**：softDark 暗色主题前端，红涨绿跌；图表用本地随包的 ECharts，复盘 Markdown 用本地随包渲染器。
- **复盘生成（prompts/ + lib/reviewContext.js + lib/reviewLlm.js）**：代码取数 → 组装干净 JSON Context → 大模型按 System Prompt 生成 Markdown 落盘。
- **脚本（scripts/）**：单元/契约守卫、数据抓取与联调工具。

## 三、子系统分卷清单
${partFiles.map(p => `- \`${p.fname}\` —— ${p.label}（${p.count} 文件 / ${p.loc.toLocaleString()} 行）`).join('\n')}

## 四、完整文件树（含行数）
\`\`\`
${tree}\`\`\`
`;

fs.writeFileSync(path.join(OUT_DIR, 'README.md'), readme);

console.log('✅ 代码审查包已生成：');
console.log('   目录：', OUT_DIR);
console.log('   文件总数：', files.length, ' 总行数：', totalLOC.toLocaleString());
console.log('   分卷：');
for (const p of partFiles) console.log('     -', p.fname, `(${p.count} 文件 / ${p.loc.toLocaleString()} 行)`);
console.log('   索引： README.md');
