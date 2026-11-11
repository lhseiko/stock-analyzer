/**
 * lib/reviewLlm.js — 每日复盘「LLM 生成层」（20261110b）
 * ==================================================================================
 * 用户 2026-11-10 16:03 裁决：引入大模型生成复盘报告。
 *   「将抓取到的 JSON 数据作为 Context，喂给大模型。系统必须加载一份复盘提示词
 *     （System Prompt），让大模型生成排版灵动、说人话、有深度归因的 Markdown 报告。」
 *
 * 链路：reviewContext.build() → 本文件 generate() → Markdown 字符串 → reviewService 落盘。
 * 本文件不产生任何数值、不组装任何报告段落、不做任何文本替换。
 *
 * 【取消硬性质检】LLM 未配置 / 超时 / 报错 / 返回空，一律降级为「原始数据快照」，
 * 由调用方照常落盘发布；绝不因为数据重复、字段为 null 或质检不通过而拒绝生成复盘。
 * 这是与旧 lib/reviewOutput.js qualityOf() 硬门禁的根本区别。
 *
 * 复用项目统一 LLM 通道 lib/ai/llm.js（callLLM）与本机配置 data/ai_config.json，
 * 不新增依赖、不新增密钥、不需要用户手动配置。
 */
'use strict';

const { loadConfig, loadPromptFile } = require('./ai/config');
const { callLLM, pickModelFor } = require('./ai/llm');
const reviewContext = require('./reviewContext');
const crypto = require('crypto');
const path = require('path');

const PROMPT_FILE = 'daily-review-system.md';
const TIMEOUT_MS = 300000;   // 长报告 + 大 Context，5 分钟（实测 11KB 上下文偶发逼近 240s，留余量）

// 20261110g P1-2：System Prompt 文件哈希进元信息（LLM 提示词变更可追溯——落盘记录带上
// 生成时所用的 prompt sha1 前 8 位，事后能判断「同一天两篇复盘差异是模型还是提示词变更」）
function promptSha1Of(content) {
  try { return crypto.createHash('sha1').update(String(content || ''), 'utf8').digest('hex').slice(0, 8); }
  catch (e) { return null; }
}
function resolvePromptSha1() {
  try {
    const p = path.join(__dirname, '..', 'prompts', PROMPT_FILE);
    return promptSha1Of(require('fs').readFileSync(p, 'utf8'));
  } catch (e) { return null; }
}

function isConfigured() {
  try {
    const c = loadConfig();
    return !!(c && c.apiKey);
  } catch (e) { return false; }
}

/** 去掉模型常见的 ```markdown ... ``` 包裹与前后空白，不做任何内容改写。 */
function cleanMarkdown(s) {
  let t = String(s == null ? '' : s).trim();
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i;
  const m = t.match(fence);
  if (m) t = m[1].trim();
  return t;
}

function degraded(context, reason, extra) {
  return {
    ok: false, degraded: true,
    markdown: reviewContext.toDataSnapshotMarkdown(context, reason),
    model: (extra && extra.model) || null,
    promptFile: PROMPT_FILE,
    promptSha1: resolvePromptSha1(),
    error: String(reason || '未知原因').slice(0, 300),
    elapsedMs: (extra && extra.elapsedMs) || 0,
    contentChars: 0,
  };
}

/**
 * 生成复盘 Markdown。
 * @param {object} context reviewContext.build() 产出的干净 JSON
 * @param {object} opts    { stage, date }
 * @returns {Promise<{ok:boolean, degraded:boolean, markdown:string, model:string|null,
 *                    promptFile:string, error:string|null, elapsedMs:number, contentChars:number}>}
 */
async function generate(context, opts) {
  const o = opts || {};
  const started = Date.now();
  let cfg;
  try { cfg = loadConfig(); } catch (e) { return degraded(context, 'AI 配置读取失败：' + e.message); }
  if (!cfg || !cfg.apiKey) return degraded(context, '未配置 AI 模型密钥（本机 AI 设置）');

  let systemPrompt;
  try { systemPrompt = loadPromptFile(PROMPT_FILE); } catch (e) { systemPrompt = ''; }
  if (!systemPrompt || systemPrompt.indexOf('每日复盘') === -1) {
    return degraded(context, '复盘提示词 ' + PROMPT_FILE + ' 未加载成功');
  }

  const pick = pickModelFor(cfg, 'web');
  const model = pick.model || cfg.modelLocal || '';
  if (!model) return degraded(context, '未配置可用模型（本机 AI 设置）', { model: null });

  const date = (context && context.meta && context.meta.reviewDate) || o.date || '';
  const contextChars = JSON.stringify(context).length;
  console.log(`[每日复盘] LLM 生成开始：${date} · Context ${contextChars} 字符 · 模型 ${model}`);
  const userText = [
    '以下是工作台代码采集并计算好的当日原始数据，JSON 是唯一事实来源。',
    '复盘日：' + date + '；版本阶段：' + (o.stage || (context && context.meta && context.meta.stage) || 'formal') + '。',
    '请严格按你的系统提示词，生成这一天的盘后复盘 Markdown 报告。',
    '',
    '```json',
    // 紧凑序列化：漂亮打印会多出约 30% 字符，实测曾把 Context 撑到 88KB 导致模型 240s 超时。
    JSON.stringify(context),
    '```',
  ].join('\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText },
  ];

  try {
    // 纯本地数据推理：关闭联网搜索，避免无关事实混入与额外计费。
    // [P1-1 裁决①] force 透传给 callLLM：force=true 绕过在途合并，force 重跑必重新调用。
    const raw = await callLLM(cfg.provider, cfg.apiKey, model, messages,
      { webSearch: false, timeoutMs: TIMEOUT_MS, force: !!o.force });
    const markdown = cleanMarkdown(raw);
    if (!markdown) {
      return degraded(context, '模型返回空内容', { model, elapsedMs: Date.now() - started });
    }
    return {
      ok: true, degraded: false, markdown,
      model, promptFile: PROMPT_FILE, promptSha1: resolvePromptSha1(), error: null,
      elapsedMs: Date.now() - started, contentChars: markdown.length,
    };
  } catch (e) {
    const status = e && e.response && e.response.status;
    const why = 'LLM 调用失败' + (status ? '（HTTP ' + status + '）' : '') + '：' + String((e && e.message) || e);
    return degraded(context, why, { model, elapsedMs: Date.now() - started });
  }
}

module.exports = {
  generate, isConfigured, cleanMarkdown,
  PROMPT_FILE, TIMEOUT_MS,
};
