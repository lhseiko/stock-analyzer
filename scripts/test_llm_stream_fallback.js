/**
 * 模型能力自学习（流式 / 联网参数兼容层）回归测试（20260918b）
 * ------------------------------------------------------------------
 * 用户反馈（2026-09-18 18:16 截图）：海天味业（603288）「最大亮点 / 雷点」无法获取数据，
 *   概览卡一直停在「尚未生成」。
 *
 * 根因（真实端到端实证，非推断）：
 *   `data/ai_config.json` 于 2026-09-18 17:42 被改成 modelWeb=glm-4.5-air，
 *   而 `POST /api/ai/aspects {force:true}` 实测 **5.8 秒**即返回
 *   `{success:false, error:'API_ERROR', message:'大模型请求失败（Request failed with status code 400）'}`。
 *   直连百炼验证两个模型名的差异：
 *     - glm-4.5-air 非流式      → HTTP 400 "This model only support stream mode..."
 *     - glm-4.5-air stream:true → HTTP 200（SSE）
 *     - glm-4.5-air + enable_search → HTTP 200 但 SSE 内是 error（"enable_search is not supported"）
 *   即：该模型既不接受非流式、也不接受 enable_search → 所有调用秒级失败。
 *
 * 修复：lib/ai/llm.js 新增「首见即记忆」的模型能力兼容层
 *   §A 默认路径零回归：非 stream-only 模型请求体仍为 stream:false，行为与历史一致
 *   §B 仅支持流式的模型：非流式 400 → 自动改用流式重发，并记忆（第二次调用只发 1 次请求）
 *   §C 不支持联网参数的模型：流式下 SSE error（HTTP 200）被识别 → 去参数重发并记忆
 *   §D SSE 报错且无内容必须抛错（不能被当成「正常空回复」而静默丢结果）
 *   §E 源码守卫：错误透传 response / 无绕过预算的裸 postLLM / postLLM 仍导出
 *
 * 运行：node scripts/test_llm_stream_fallback.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const llm = require('../lib/ai/llm');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (extra ? '  → ' + extra : '')); }
}
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// ── 本地桩服务：按「模型名 + 请求体」返回刻意的响应，用于驱动兼容层 ──
const seen = []; // 记录收到的请求（model / stream / enable_search）
const STREAM_MSG = 'This model only support stream mode, please enable the stream parameter to access the model. ';
const NOSEARCH_MSG = 'The parameters `enable_search` is not supported';

function sseChunks(parts) {
  return parts.map((p) => 'data: ' + JSON.stringify(p) + '\n\n').join('') + 'data: [DONE]\n\n';
}
const delta = (t) => ({ choices: [{ index: 0, delta: { content: t } }] });

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (e) { /* ignore */ }
    const model = String(body.model || '');
    const stream = body.stream === true;
    const hasSearch = body.enable_search !== undefined || Array.isArray(body.tools);
    seen.push({ model, stream, hasSearch });

    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    const sse = (obj) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream;charset=utf-8' });
      res.end(obj);
    };

    // ① 只支持流式 + 不支持 enable_search（glm-4.5-air 的真实组合，必须先匹配，名字含 streamonly）
    if (/nosearch/.test(model)) {
      if (!stream) return json(400, { error: { message: STREAM_MSG, code: 'invalid_parameter_error' } });
      if (hasSearch) return sse(sseChunks([{ error: { message: NOSEARCH_MSG, code: 'invalid_parameter_error' } }]));
      return sse(sseChunks([delta('降级'), delta('成功')]));
    }
    // ② 只支持流式的模型：非流式一律 400
    if (/streamonly/.test(model)) {
      if (!stream) return json(400, { error: { message: STREAM_MSG, code: 'invalid_parameter_error' } });
      return sse(sseChunks([delta('流式'), delta('已修复')]));
    }
    // ③ 只支持流式，且流式下只返回 error、无任何 content：必须抛错而非返回空串
    if (/sseerror/.test(model)) {
      if (!stream) return json(400, { error: { message: STREAM_MSG, code: 'invalid_parameter_error' } });
      return sse(sseChunks([{ error: { message: 'InternalError.Algo.InvalidParameter: boom', code: 'x' } }]));
    }
    // ④ 普通模型：非流式正常返回（回归基线）
    return json(200, { choices: [{ message: { content: 'HELLO-NORMAL' } }] });
  });
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port + '/chat/completions';
  const body = (model, extra) => Object.assign({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, temperature: 0.3 }, extra || {});

  console.log('===== §A 默认路径零回归：普通模型仍走非流式 =====');
  seen.length = 0;
  const a = await llm.postLLM(url, 'k', body('test-normal-model'), 30000);
  ok('返回内容正确', a === 'HELLO-NORMAL', JSON.stringify(a));
  ok('只发 1 次请求', seen.length === 1, '实际 ' + seen.length);
  ok('请求体 stream=false（未擅自升级为流式）', seen[0] && seen[0].stream === false);

  console.log('\n===== §B 仅支持流式的模型：自动重发 + 记忆 =====');
  seen.length = 0;
  const b1 = await llm.postLLM(url, 'k', body('test-streamonly-A'), 30000);
  ok('自动改用流式后拿到拼接内容', b1 === '流式已修复', JSON.stringify(b1));
  ok('本次共 2 次请求（先非流式 400 → 再流式）', seen.length === 2, '实际 ' + seen.length);
  ok('第 1 次非流式', seen[0] && seen[0].stream === false);
  ok('第 2 次已改为流式', seen[1] && seen[1].stream === true);
  seen.length = 0;
  const b2 = await llm.postLLM(url, 'k', body('test-streamonly-A'), 30000);
  ok('第二次调用直接走流式（记忆生效）', seen.length === 1 && seen[0].stream === true, '请求数 ' + seen.length + ' / stream=' + (seen[0] && seen[0].stream));
  ok('第二次内容同样正确', b2 === '流式已修复', JSON.stringify(b2));

  console.log('\n===== §C 不支持 enable_search：SSE error 识别 + 去参数重发 + 记忆 =====');
  seen.length = 0;
  const c1 = await llm.postLLM(url, 'k', body('test-streamonly-nosearch-X', { enable_search: true }), 30000);
  ok('三次握身后成功拿到内容', c1 === '降级成功', JSON.stringify(c1));
  ok('共 3 次请求（非流式400 → 流式带search报错 → 流式去search）', seen.length === 3, '实际 ' + seen.length);
  ok('第 3 次已去掉 enable_search', seen[2] && seen[2].hasSearch === false);
  seen.length = 0;
  const c2 = await llm.postLLM(url, 'k', body('test-streamonly-nosearch-X', { enable_search: true }), 30000);
  ok('第二次调用一次成功（直接流式 + 无搜索参数）', seen.length === 1 && seen[0].stream === true && seen[0].hasSearch === false,
    '请求数 ' + seen.length + ' / stream=' + (seen[0] && seen[0].stream) + ' / hasSearch=' + (seen[0] && seen[0].hasSearch));
  ok('第二次内容正确', c2 === '降级成功', JSON.stringify(c2));

  console.log('\n===== §D SSE 报错且无内容：必须抛错（不得静默返回空串） =====');
  let dErr = null;
  try { await llm.postLLM(url, 'k', body('test-sseerror-Z'), 30000); } catch (e) { dErr = e; }
  ok('确实抛错', !!dErr);
  ok('错误信息含服务端原因', !!(dErr && /boom/.test(String(dErr.message))), dErr && dErr.message);
  ok('归一化出 status=400（便于上游兜底识别）', !!(dErr && dErr.response && dErr.response.status === 400), dErr && dErr.response && String(dErr.response.status));

  console.log('\n===== §E 源码守卫 =====');
  const src = read('lib/ai/llm.js');
  ok('STREAM_ONLY_MODELS 记忆集合存在', /const STREAM_ONLY_MODELS = new Set\(\)/.test(src));
  ok('NO_SEARCH_PARAM_MODELS 记忆集合存在', /const NO_SEARCH_PARAM_MODELS = new Set\(\)/.test(src));
  ok('SSE 解析函数存在', /function _parseSseContent\(/.test(src));
  ok('SSE error 归一化存在', /function _sseError\(/.test(src));
  ok('错误保留 response/status（修好此前形同虚设的 400 兜底）', /err\.response = \(e && e\.response\) \|\| undefined;/.test(src));
  ok('流式显式 responseType:text（否则 JSON.parse 会炸）', /\.\.\.\(useStream \? \{ responseType: 'text' \} : \{\}\)/.test(src));
  ok('postLLM 仍导出（外部契约未变）', typeof llm.postLLM === 'function');
  const callLLMBody = src.slice(src.indexOf('async function callLLM('), src.indexOf('// 按当前任务类型获取模型'));
  ok('callLLM 内无绕过预算的裸 `return await postLLM(`', (callLLMBody.match(/return await postLLM\(/g) || []).length === 0);
  ok('callBudgeted 仍恰 5 处（预算接线未变）', (callLLMBody.match(/callBudgeted\(/g) || []).length === 5,
    String((callLLMBody.match(/callBudgeted\(/g) || []).length));
  const rb = llm.buildRequestBody('qwen', 'qwen-plus', [], { webSearch: false });
  ok('buildRequestBody 默认仍产出 stream:false（隔离性）', rb.stream === false);

  server.close();
  console.log('\n===================================');
  console.log(' 通过 ' + pass + ' / 失败 ' + fail);
  console.log('===================================');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('测试异常：', e);
  try { server.close(); } catch (err) {}
  process.exit(1);
});
