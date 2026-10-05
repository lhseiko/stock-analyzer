// start.vbs 交付前守卫（20261005d 固化，源自当日三连故障教训）
// 检查五项：① 纯 ASCII（wscript 按 GBK 读，非 ASCII 会破语法）
//          ② Dim 不得使用 VBScript 保留字（如 sub -> 800A03F2 缺少标识符）
//          ③ Option Explicit 下变量必须先 Dim 再赋值（VBScript 逐行执行、无声明提升）
//          ④ If/For/Do 块配平 + 引号成对
//          ⑤ Node 自动定位逻辑复刻（versions/current -> versions/* -> PATH）
// 用法: node scripts/test_start_vbs.js   输出 "N 通过 / M 失败"
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const t = (name, ok, detail) => {
  if (ok) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (detail ? '  -> ' + detail : '')); }
};

const root = path.join(__dirname, '..');
const file = path.join(root, 'start.vbs');
const buf = fs.readFileSync(file);
const raw = buf.toString('utf8');
const lines = raw.split(/\r?\n/);

// ── ① 纯 ASCII ──
let nonAscii = 0;
for (const b of buf) if (b > 0x7f) nonAscii++;
t('纯 ASCII（编码免疫）', nonAscii === 0, nonAscii + ' 个非 ASCII 字节');

// ── 保留字表 ──
const RESERVED = new Set(['sub', 'end', 'if', 'then', 'else', 'elseif', 'dim', 'redim', 'const',
  'set', 'let', 'for', 'each', 'in', 'to', 'step', 'next', 'while', 'wend', 'do', 'loop', 'until',
  'select', 'case', 'class', 'property', 'get', 'me', 'new', 'nothing', 'null', 'empty', 'true',
  'false', 'on', 'error', 'resume', 'exit', 'call', 'rem', 'option', 'explicit', 'and', 'or', 'not',
  'xor', 'mod', 'is', 'byval', 'byref', 'with', 'stop', 'erase', 'randomize', 'function', 'preserve',
  'public', 'private', 'default', 'execute', 'eval']);

function stripComment(l) {
  let inStr = false;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '"') inStr = !inStr;
    else if (c === "'" && !inStr) return l.slice(0, i);
  }
  return l;
}

const declared = new Set();
let optionExplicit = false;
const dimBad = [], assignBad = [], quoteBad = [];
let ifD = 0, forD = 0, doD = 0;

for (let idx = 0; idx < lines.length; idx++) {
  const n = idx + 1;
  const code = stripComment(lines[idx]).trim();
  if (!code) continue;
  if (/^Option\s+Explicit\b/i.test(code)) { optionExplicit = true; continue; }

  if (/^Dim\b/i.test(code)) {
    code.replace(/^Dim\b/i, '').split(',')
      .map(s => s.trim().split(/\s+/)[0].replace(/\(.*$/, '').trim())
      .filter(Boolean).forEach(v => {
        if (RESERVED.has(v.toLowerCase())) dimBad.push({ n, v });
        declared.add(v.toLowerCase());
      });
    continue;
  }

  if (/^If\b.*\bThen\s*$/i.test(code)) ifD++;
  if (/^End\s+If\b/i.test(code)) ifD--;
  if (/^For\b/i.test(code)) forD++;
  if (/^Next\b/i.test(code)) forD--;
  if (/^Do\b/i.test(code)) doD++;
  if (/^Loop\b/i.test(code)) doD--;

  if ((code.match(/"/g) || []).length % 2 !== 0) quoteBad.push({ n });

  code.split(/\s*:\s*/).filter(Boolean).forEach(st => {
    const m = st.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*[^=]/);
    if (m && optionExplicit && !declared.has(m[1].toLowerCase())) {
      assignBad.push({ n, v: m[1] });
    }
  });
}

// ── ②~④ ──
t('Option Explicit 存在', optionExplicit);
t('Dim 未用保留字', dimBad.length === 0, dimBad.map(x => '第' + x.n + '行:' + x.v).join(', '));
t('变量先 Dim 后赋值', assignBad.length === 0, assignBad.map(x => '第' + x.n + '行:' + x.v).join(', '));
t('If/For/Do 块配平', ifD === 0 && forD === 0 && doD === 0, ifD + '/' + forD + '/' + doD);
t('引号成对', quoteBad.length === 0, '第' + quoteBad.map(q => q.n).join(',') + '行');

// ── ⑤ Node 定位复刻（与 start.vbs 同逻辑）──
const verRoot = 'C:\\Users\\16507\\.workbuddy\\binaries\\node\\versions';
let nodeExe = '';
const curFile = path.join(verRoot, 'current');
if (fs.existsSync(curFile)) {
  const v = fs.readFileSync(curFile, 'utf8').replace(/[\r\n]/g, '').trim();
  if (v) { const f = path.join(verRoot, v, 'node.exe'); if (fs.existsSync(f)) nodeExe = f; }
}
if (!nodeExe) {
  try {
    for (const d of fs.readdirSync(verRoot)) {
      const f = path.join(verRoot, d, 'node.exe');
      try { if (fs.statSync(f).isFile()) { nodeExe = f; break; } } catch (e) {}
    }
  } catch (e) {}
}
if (!nodeExe) nodeExe = 'node';
t('Node 自动定位到真实路径', nodeExe !== 'node' && fs.existsSync(nodeExe), nodeExe);

console.log('');
console.log('===== 汇总：' + pass + ' 通过 / ' + fail + ' 失败 =====');
process.exit(fail ? 1 : 0);
