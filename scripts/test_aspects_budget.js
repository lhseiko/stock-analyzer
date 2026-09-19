/**
 * 「个股亮点/雷点 长时间无法获取」—— 整链路耗时预算 回归测试（20260917l）
 * ------------------------------------------------------------------
 * 用户反馈（2026-09-17 20:18 截图）：中国平安（601318）的「个股亮点与雷点」
 * 长时间无法获取，卡片停在「AI 正在联网重新分析…」+ 计数 0/0。
 *
 * 根因（服务端日志实证）：lib/ai/llm.js 的 callLLM 内部最多**串行**发起 4 次 postLLM
 *   ① 妙想事实纯推理 → ② 外部搜索通道纯推理 → ③ 外部通道失败后的纯推理 → ④ 内置 enable_search
 * 每次都用同一个 timeoutMs 各自做硬超时；本任务传 240s → 单股最坏 ≈4×240s≈16 分钟无响应。
 * 601318 恰好踩中该路径（日志 `[search:mcp] 调用失败…大模型请求超时（240000ms 无响应）`）。
 *
 * 修复：callLLM 支持可选「整链路总耗时预算」opts.overallBudgetMs（配套纯函数 createBudget）。
 * 本测试钉死以下不变量，防止将来被改回「无限串行等待」：
 *   §1 未传预算 → 与历史版本逐项一致（enabled=false / expired=false / leftMs=Infinity）
 *   §2 传预算 → 单次超时被剩余预算夹紧（min(timeoutMs, 剩余)）
 *   §3 预算不足 5s → expired()=true（不再发起新请求）
 *   §4 端到端：预算耗尽时 callLLM **秒级**抛错、且**不发网络请求**
 *   §5 源码守卫：callLLM 内不存在绕过预算的裸 postLLM 调用
 *   §6 接线守卫：analyzeAspects 传了总预算 + 失败回退 stale
 *   §7 前端守卫：notes.js 有等待计时 + 客户端硬超时 + 超时提示
 *
 * 运行：node scripts/test_aspects_budget.js
 */
const fs = require('fs');
const path = require('path');
const llm = require('../lib/ai/llm');
const { createBudget, callLLM } = llm;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
function read(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8'); }

(async () => {
  console.log('===== §1 未传预算：与历史版本完全一致（其他分析器零影响） =====');
  const b0 = createBudget(undefined, { timeoutMs: 240000 });
  ok('enabled=false', b0.enabled === false);
  ok('expired()=false', b0.expired() === false);
  ok('leftMs()=Infinity', b0.leftMs() === Infinity);
  ok('timeoutFor() 原样返回调用方 timeoutMs（240000）', b0.timeoutFor() === 240000, String(b0.timeoutFor()));
  const b0b = createBudget(undefined, {});
  ok('未传 timeoutMs 时 timeoutFor()=undefined（沿用 postLLM 默认 180s）', b0b.timeoutFor() === undefined);
  ok('预算传 0 等同未传', createBudget(0, { timeoutMs: 1000 }).enabled === false);
  ok('预算传负数等同未传', createBudget(-5, { timeoutMs: 1000 }).enabled === false);

  console.log('\n===== §2 传预算：单次超时被剩余预算夹紧 =====');
  const b1 = createBudget(300000, { timeoutMs: 240000 });
  ok('300s 总预算 / 240s 单次 → 首次仍可跑满 240s', b1.timeoutFor() >= 239000 && b1.timeoutFor() <= 240000, String(b1.timeoutFor()));
  ok('300s 总预算 → 未过期', b1.expired() === false);
  const b2 = createBudget(50000, { timeoutMs: 240000 });
  ok('50s 总预算 / 240s 单次 → 单次被压到 50s 以内', b2.timeoutFor() > 40000 && b2.timeoutFor() <= 50000, String(b2.timeoutFor()));
  const b2b = createBudget(50000, {});
  ok('未传单次超时 → timeoutFor() 用剩余预算', b2b.timeoutFor() > 40000 && b2b.timeoutFor() <= 50000, String(b2b.timeoutFor()));

  console.log('\n===== §3 预算不足 5s → expired()=true（不再发起新请求） =====');
  ok('1ms 预算 → expired()=true', createBudget(1, {}).expired() === true);
  ok('4999ms 预算 → expired()=true', createBudget(4999, {}).expired() === true);
  ok('大预算 → expired()=false', createBudget(300000, {}).expired() === false);
  const bT = createBudget(100000, { timeoutMs: 240000 });
  const left1 = bT.leftMs();
  await new Promise(r => setTimeout(r, 30));
  ok('leftMs() 随时间递减', bT.leftMs() < left1, `${left1} → ${bT.leftMs()}`);
  ok('elapsedMs()>0', bT.elapsedMs() > 0);

  console.log('\n===== §4 端到端：预算耗尽 → callLLM 秒级抛错且不发网络请求 =====');
  // webSearch:false 会跳过「妙想/外部搜索通道」两条支路，直达最终 postLLM；
  // 此时预算已耗尽（1ms < 5000ms 下限）→ 应在 callBudgeted 内立刻抛错，绝不触碰网络。
  const t0 = Date.now();
  let err = null;
  try {
    await callLLM('qwen', 'fake-key-for-test', 'qwen-turbo',
      [{ role: 'user', content: 'hi' }],
      { webSearch: false, overallBudgetMs: 1, timeoutMs: 240000 });
  } catch (e) { err = e; }
  const cost = Date.now() - t0;
  ok('确实抛错', !!err, err ? err.message : '(未抛错)');
  ok('err.budgetExhausted === true', !!err && err.budgetExhausted === true);
  ok('err.timeout === true（归类为超时，便于上游统一处理）', !!err && err.timeout === true);
  ok('错误信息含「总耗时预算已用尽」', !!err && /总耗时预算已用尽/.test(err.message), err && err.message);
  ok('秒级返回（< 3000ms，实测 ' + cost + 'ms）', cost < 3000, cost + 'ms');

  console.log('\n===== §5 源码守卫：callLLM 内无绕过预算的裸 postLLM =====');
  const llmSrc = read('lib/ai/llm.js');
  const fnStart = llmSrc.indexOf('async function callLLM(');
  const fnEnd = llmSrc.indexOf('function pickModelFor(', fnStart);
  const fnBody = llmSrc.slice(fnStart, fnEnd);
  const rawPost = (fnBody.match(/return await postLLM\(/g) || []).length;
  const budgeted = (fnBody.match(/callBudgeted\(/g) || []).length;
  ok('callLLM 内已无裸 `return await postLLM(`（原 5 处）', rawPost === 0, '仍有 ' + rawPost + ' 处');
  ok('callLLM 内 callBudgeted(...) 共 5 处（5 条出口全部受预算约束）', budgeted === 5, '实际 ' + budgeted + ' 处');
  ok('createBudget 已导出（可单测）', typeof llm.createBudget === 'function');
  ok('postLLM 仍导出（外部契约未变）', typeof llm.postLLM === 'function');
  ok('callLLM 仍导出（外部契约未变）', typeof llm.callLLM === 'function');

  console.log('\n===== §6 接线守卫：analyzeAspects 传总预算 + 失败回退 stale =====');
  const augSrc = read('lib/ai/augmentStock.js');
  ok('analyzeAspects 传 overallBudgetMs: 300000', /overallBudgetMs:\s*300000/.test(augSrc));
  ok('保留单次 timeoutMs: 240000', /timeoutMs:\s*240000/.test(augSrc));
  ok('失败时回退历史结果并标记 stale: true', /stale:\s*true/.test(augSrc));
  ok('回退前先确认缓存文件存在', /fs\.existsSync\(cacheFile\)[\s\S]{0,400}stale:\s*true/.test(augSrc));

  console.log('\n===== §7 前端守卫：等待计时 + 客户端硬超时 + 超时提示 =====');
  const notesSrc = read('public/js/notes.js');
  ok('使用 AbortController 主动中断', /AbortController/.test(notesSrc));
  ok('客户端硬超时 330000ms（比后端 300s 预算多 30s 余量）', /CLIENT_TIMEOUT_MS\s*=\s*330000/.test(notesSrc));
  ok('fetch 带上 signal', /signal:\s*ac\s*\?\s*ac\.signal/.test(notesSrc));
  ok('状态栏显示「已等待 N 秒」', /已等待\s*'?\s*\+?\s*sec/.test(notesSrc) || /已等待/.test(notesSrc));
  ok('计时器按股票隔离（_aiTickMap）', /_aiTickMap/.test(notesSrc));
  ok('计时器兜底清理（stopTick 幂等）', /const stopTick\s*=/.test(notesSrc));
  ok('超时给出可执行提示', /AI 分析超时/.test(notesSrc));
  ok('stale 回退有独立提示', /已回退显示上一次成功结果/.test(notesSrc));
  ok('防串股守卫仍在（20260917j 回归不破）', /renderStockIfCurrent/.test(notesSrc) && /isCurrentStock/.test(notesSrc));
  // 口径锁定：只看 generateAspects 的**函数体**，断言它不会重写 this.notes（即不删旧条目），
  // 只做「统计」；不拿注释文案当判据（注释里必然会出现「清除本股票已存」这类说明文字）。
  const gaStart = notesSrc.indexOf('async generateAspects(');
  const gaEnd = notesSrc.indexOf('renderNoteCard(', gaStart);
  const gaBody = notesSrc.slice(gaStart, gaEnd);
  ok('generateAspects 内不重写 this.notes（只累积、不删旧 AI 条目）', !/this\.notes\s*=/.test(gaBody));
  ok('generateAspects 仅统计已有 AI 条数（existingAi）', /existingAi/.test(gaBody));

  console.log('\n===== §8 部署守卫：版本戳与缓存破坏 =====');
  const serverSrc = read('server.js');
  // 版本戳守卫（20260919d 改）：原写法硬编码具体版本号，每次升版本都会失效（需手工同步测试）。
  // 改为校验「前后端版本戳一致」这一不变量 —— 永不随版本号过期。
  const avm = serverSrc.match(/APP_VERSION = '([^']+)'/);
  const APP_V = avm ? avm[1] : '';
  ok('server.js 存在 APP_VERSION 常量', !!APP_V);
  ok('server.js 无 `[truncated]` 残留（此前被截断标记污染）', !serverSrc.includes('[truncated]'));
  const idxSrc = read('public/index.html');
  ok('index.html app.js?v= 与 APP_VERSION 一致（' + APP_V + '）', !!APP_V && idxSrc.includes('js/app.js?v=' + APP_V));
  ok('index.html style.css?v= 与 APP_VERSION 一致（' + APP_V + '）', !!APP_V && idxSrc.includes('css/style.css?v=' + APP_V));
  ok('index.html notes.js 带版本戳', /js\/notes\.js\?v=\d{8}[a-z]/.test(idxSrc));
  ok('/js/notes.js 在缓存破坏名单内', /FRONTEND_BUST_FILES[\s\S]{0,300}\/js\/notes\.js/.test(serverSrc));

  console.log('\n===== §9 macroNews 回归：_localDate 未定义已修 =====');
  const mnSrc = read('lib/macroNews.js');
  // 剥掉注释后再断言 —— 修复说明里会提到旧写法 `_localDate()`，不能把注释当代码判据。
  // 注意：本文件是 CRLF 行尾，JS 正则的 `.` 不匹配 `\r`，故不能用 `//.*$`（会漏掉整段注释）。
  const mnCode = mnSrc.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/[^\n\r]*/, '')).join('\n');
  ok('代码中不再调用未定义的 _localDate()', !/_localDate\s*\(/.test(mnCode));
  ok('localToday() 调用已导入的 localDate()', /function localToday\(\)\s*\{\s*return localDate\(\);\s*\}/.test(mnSrc));

  console.log('\n===== 汇总：' + pass + ' 通过 / ' + fail + ' 失败 =====');
  process.exit(fail ? 1 : 0);
})();
