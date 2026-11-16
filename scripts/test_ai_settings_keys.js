/**
 * AI 设置弹窗「原型结构」确定性守卫（20261114e）
 * ----------------------------------------------------------------
 * 背景：任务卡 #005 方案 A（用户「按推荐执行」）把 19:2x 的
 * 「双 Key 并列常显」改动退回 13cb2cb 的原型：单个「API Key」标题，
 * 火山 Key 框回到 #aiVolcFields 内、仅 searchMode='volc' 时展开。
 * 本守卫把原型结构钉死，防止后续改动又把火山 Key 移出折叠容器，
 * 或复制出第二个同 id 输入框（会让 getElementById 取到隐藏元素、
 * 保存链路读到空值）。
 *
 * 边界：联网搜索方式四选一、三条外部搜索通道、app.js 保存/回填链路
 * 均不在回退范围内，守卫同时确认它们未被破坏。
 *
 * 纯静态检查：不联网、不启服务、不写任何文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const count = (s, sub) => s.split(sub).length - 1;

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; return; }
  fail++;
  console.log('  ✗ ' + name + (extra ? ' ｜ ' + extra : ''));
}
function eq(name, actual, expected) {
  ok(actual === expected, name, '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected));
}

const HTML = read('public/index.html');
const APP = read('public/js/app.js');
const CSS = read('public/css/style.css');
const SERVER = read('server.js');
const ROUTES = read('routes/aiRoutes.js');
const CONFIG = read('lib/ai/config.js');

// ── 1. label：原型名唯一、19:2x 新名已消失 ────────────────────────────
eq('原型 label「API Key」恰好 1 处', count(HTML, '<label class="ai-field-label">API Key</label>'), 1);
eq('19:2x 新名「阿里百炼 API Key」已消失', count(HTML, '<label class="ai-field-label">阿里百炼 API Key</label>'), 0);
eq('19:2x 新名「火山 API Key」已消失', count(HTML, '<label class="ai-field-label">火山 API Key</label>'), 0);
eq('原型 label「🌋 火山方舟 Ark API Key」恰好 1 处', count(HTML, '🌋 火山方舟 Ark API Key</label>'), 1);

// ── 2. id 唯一性：防重复 id 破坏 getElementById ────────────────────────
eq('id="aiApiKey" 全页恰好 1 处', count(HTML, 'id="aiApiKey"'), 1);
eq('id="aiVolcApiKey" 全页恰好 1 处（退回折叠区但未复制）', count(HTML, 'id="aiVolcApiKey"'), 1);
eq('id="aiVolcModel" 全页恰好 1 处', count(HTML, 'id="aiVolcModel"'), 1);
eq('id="aiBaiduApiKey" 仍恰好 1 处（百度框未被动）', count(HTML, 'id="aiBaiduApiKey"'), 1);

// ── 3. 位置：火山 Key 在 #aiVolcFields 之内、随下拉按需展开 ────────────
const iAliKey = HTML.indexOf('id="aiApiKey"');
const iVolcKey = HTML.indexOf('id="aiVolcApiKey"');
const iVolcBox = HTML.indexOf('id="aiVolcFields"');
const iModelBox = HTML.indexOf('id="aiModelWeb"');
ok(iAliKey > 0 && iVolcKey > iAliKey, '火山 Key 仍在 API Key 之后（原型顺序）', `aliKey=${iAliKey} volcKey=${iVolcKey}`);
ok(iAliKey < iModelBox, '「API Key」仍排在「联网模型」之前', `aliKey=${iAliKey} modelWeb=${iModelBox}`);
ok(iVolcKey > iVolcBox, '火山 Key 位于 #aiVolcFields 之内 → 不再常显', `volcKey=${iVolcKey} volcBox=${iVolcBox}`);

// 取 #aiVolcFields 容器内容（内部无嵌套 div，可安全截取到第一个 </div>）
const boxStart = HTML.indexOf('<div id="aiVolcFields"');
const boxEnd = boxStart > -1 ? HTML.indexOf('</div>', boxStart) : -1;
const volcBoxBody = boxStart > -1 && boxEnd > boxStart ? HTML.slice(boxStart, boxEnd) : '';
ok(boxStart > -1 && boxEnd > boxStart, '#aiVolcFields 容器仍存在且可解析', '');
ok(volcBoxBody.includes('class="hidden"'), '#aiVolcFields 仍带 hidden 类（按需展开）', '');
ok(volcBoxBody.includes('aiVolcApiKey'), '#aiVolcFields 内含火山 Key（已退回折叠区）', '');
ok(volcBoxBody.includes('aiVolcModel'), '#aiVolcFields 内仍保留火山豆包模型输入框', '');
ok(volcBoxBody.includes('🌋 火山豆包模型（可留空）'), '#aiVolcFields 内模型 label 未变', '');

// ── 4. placeholder：还原为 13cb2cb 原型文案 ──────────────────────────
ok(/id="aiApiKey"[^>]*placeholder="[^"]*粘贴你的 API Key/.test(HTML), 'API Key placeholder 还原为原型文案', '');
ok(/id="aiVolcApiKey"[^>]*placeholder="[^"]*火山方舟通用 API Key/.test(HTML), '火山 Key placeholder 还原为原型文案', '');
const volcInputTag = (HTML.match(/<input[^>]*id="aiVolcApiKey"[^>]*>/) || [''])[0];
ok(!volcInputTag.includes('粘贴火山方舟 Ark API Key'), '19:2x 新增的 placeholder 措辞已移除', '');
ok(volcInputTag.includes('type="password"'), '火山 Key 仍是密码输入框（不明文回显）', '');
ok(volcInputTag.includes('autocomplete="off"'), '火山 Key 仍关闭自动填充', '');

// ── 5. 保存 / 回填链路零改动（app.js 与后端均未被破坏）─────────────────
eq('app.js 中 getElementById(aiVolcApiKey) 仍为 2 处（回填 + 保存）', count(APP, "getElementById('aiVolcApiKey')"), 2);
eq('app.js 中 getElementById(aiVolcModel) 仍为 2 处', count(APP, "getElementById('aiVolcModel')"), 2);
eq('app.js 中 getElementById(aiVolcFields) 仍为 1 处', count(APP, "getElementById('aiVolcFields')"), 1);
ok(APP.includes("volcBox.classList.toggle('hidden', mode !== 'volc')"), 'syncSearchModeFields 仍按 volc 模式控制模型容器', '');
ok(/body: JSON.stringify\(\{[\s\S]{0,220}volcApiKey/.test(APP), 'POST body 仍携带 volcApiKey 字段', '');
ok(ROUTES.includes('volcApiKey') && ROUTES.includes('volcModel'), 'aiRoutes.js 仍接收 volcApiKey / volcModel', '');
ok(CONFIG.includes('volcApiKey: keep(cfg.volcApiKey, cur.volcApiKey)'), 'config.js 仍按「传空保留原值」落盘火山 Key', '');
ok(CONFIG.includes('hasVolcKey: !!c.volcApiKey'), 'config.js 仍只回显 hasVolcKey 布尔、不回显明文', '');
ok(CONFIG.includes("volcApiKey: c.volcApiKey || ''"), 'config.js 的 loadConfig 仍读取 volcApiKey（重启后保持）', '');

// ── 6. 弹窗高度保护：原型布局下滚动样式仍在 ────────────────────────────
ok(/<div class="ai-modal ai-modal-wide">/.test(HTML), 'AI 设置弹窗仍带 ai-modal-wide 类', '');
ok(/\.ai-modal-wide \.ai-modal-body\s*\{[^}]*max-height:\s*68vh/.test(CSS), '已有 max-height:68vh 滚动上限', '');
ok(/\.ai-modal-wide \.ai-modal-body\s*\{[^}]*overflow-y:\s*auto/.test(CSS), '已有 overflow-y:auto 滚动保护', '');
eq('style.css 未新增 #aiSettingsModal 专用滚动规则（隔离、零改动）', count(CSS, '#aiSettingsModal .ai-modal-body'), 0);

// ── 7. DESIGN.md §9 版本戳一致性（动态读 server.js，不硬编码版本）─────
const verMatch = SERVER.match(/const APP_VERSION = '(\d{8}[a-z])'/);
const ver = verMatch ? verMatch[1] : '';
ok(/^\d{8}[a-z]$/.test(ver), 'server.js 的 APP_VERSION 存在且格式正确', '当前 ' + ver);
const htmlFiles = fs.readdirSync(path.join(ROOT, 'public')).filter((f) => f.endsWith('.html'));
let stampCount = 0;
let staleCount = 0;
for (const f of htmlFiles) {
  const src = read('public/' + f);
  const all = src.match(/\?v=\d{8}[a-z]/g) || [];
  stampCount += all.length;
  staleCount += all.filter((v) => v !== '?v=' + ver).length;
}
eq('8 个 HTML 均带版本戳文件数', htmlFiles.length, 8);
// [任务卡 #015] 删除 emotionSummary.js 脚本引入，全站 ?v= 从 58 → 57 处
eq('全站 ?v= 戳共 57 处', stampCount, 57);
eq('旧版本戳残留 0 处', staleCount, 0);

// ── 8. 隔离边界：联网方式下拉与后端通道未被触碰 ───────────────────────
ok(!HTML.includes('id="aiVolcApiKey2"'), '未出现任何「第二个火山 Key 框」的变体 id', '');
ok(count(HTML, '<input type="password"') >= 3, '三个 Key 密码框（阿里 / 火山 / 百度）齐备', '');

console.log(`===== AI 设置原型结构守卫：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
