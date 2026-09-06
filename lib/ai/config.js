/**
 * lib/ai/config.js —— aiAugment 领域子模块：常量、配置读写与全部模块级状态的唯一持有者
 * ----------------------------------------------------------------
 * 由 lib/aiAugment.js 拆分而来（202609 拆分重构）：
 *   - 目录层级 +1：DATA_DIR/PROMPTS_DIR 的 path.join 相对层级同步改为 ('..','..')，
 *     最终字符串与拆分前逐字节一致（data/ai_config.json、data/ai_cache 等路径不变）。
 *   - 原模块级可变状态 gSearchMode/gVolcKey/gVolcModel/gBaiduKey 收拢为 runtime 对象
 *     （唯一一份进程内生效状态，引用语义不变）；消费方必须在调用时实时读取
 *     config.runtime.xxx，禁止模块顶层解构值快照。
 *   - _promptCache（提示词文件 mtime 缓存）本文件唯一持有，不导出。
 *
 * 配置字段（data/ai_config.json）：
 *   provider           服务商（qwen/glm/openai）
 *   apiKey             API Key（仅本机）
 *   modelWeb           联网模型（启用 enable_search）— 用于需联网检索的 AI 任务
 *   modelLocal         本地模型（不联网）— 用于分析本地数据库/财报文本/已抓取数据等纯推理任务
 *   useCustomProtocol  必须 true；让 WorkBuddy 直连阿里云百炼 API，使用免费额度，不消耗 WorkBuddy 积分
 *   searchMode         联网搜索方式（默认 builtin，留作回退）：
 *                        'builtin' 模型内置 enable_search — 无免费额度，≈0.003 元/次
 *                        'mcp'     阿里百炼联网搜索 MCP — 前 2000 次调用免费（一次性总额度、不重置），超出 ≈0.029 元/次
 *                        'volc'    火山引擎豆包搜索 — 每月 500 次免费（每月 1 日重置），超出 0.020 元/次
 *                        'baidu'   百度千帆 AI 搜索 MCP — 每日 100 次免费（每日重置，≈3000 次/月），超出 ≈0.008 元/次
 *                      volc/baidu 属「周期性重置」额度，本工作台当前用量（≈400 次/月）下可长期免费，优先使用。
 *   volcApiKey         火山方舟 Ark API Key（searchMode='volc' 时使用；留空则回退 builtin）
 *   volcModel          火山豆包模型名（默认 doubao-seed-1-6-250615）
 *   baiduApiKey        百度千帆 API Key（searchMode='baidu' 时使用；留空则回退 builtin）
 *
 * API Key 仅保存在本机 data/ai_config.json，不会上传。
 */
const fs = require('fs');
const path = require('path');
const { getAliMcpQuotaState } = require('../webSearchMcp'); // 阿里百炼(一次性2000次,本地计数保险)，publicConfig 展示额度

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'ai_config.json');
const CACHE_DIR = path.join(DATA_DIR, 'ai_cache');
const IMG_DIR = path.join(CACHE_DIR, 'img');
// 补全结果磁盘缓存：默认 7 天，省额度；超过后点「一键补全/重新搜索」会重新联网；
// 前端打开个股页时会通过只读接口直接读取已存缓存（不限 TTL），实现「一次搜索、长期留存」。
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// 半静态内容 TTL 30 天（20260903f 降费）：研报/公告/公司介绍/供应链这类总结时效性弱，
// 30 天内直接复用；本地事实模式下另有「事实锚点」保鲜——事实没变就永不重推。
const SEMI_STATIC_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// 估值大模型：系统提示词从项目内 prompts/ 目录读取（改提示词无需动代码）
const PROMPTS_DIR = path.join(__dirname, '..', '..', 'prompts');
const _promptCache = {};
function loadPromptFile(name) {
  const fp = path.join(PROMPTS_DIR, name);
  let entry = _promptCache[name];
  try {
    const st = fs.statSync(fp);
    if (!entry || entry.mtime !== st.mtimeMs) {
      entry = { mtime: st.mtimeMs, content: fs.readFileSync(fp, 'utf8') };
      _promptCache[name] = entry;
    }
  } catch (e) {
    if (!entry) entry = { mtime: 0, content: '你是专注 A 股上市公司的估值分析师，给出内在价值区间、当前贵贱判断与安全边际，并标注数据来源与日期。' };
    _promptCache[name] = entry;
  }
  return entry.content;
}

const PROVIDERS = {
  qwen: {
    label: '通义千问',
    url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    defModel: 'qwen-max',
    search: 'enable_search',
  },
  glm: {
    label: '智谱 GLM',
    url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    defModel: 'glm-4-plus',
    search: 'tool',
  },
  openai: {
    label: 'OpenAI',
    url: 'https://api.openai.com/v1/chat/completions',
    defModel: 'gpt-4o-mini',
    search: 'none',
  },
};

function ensureDirs() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true });
  } catch {}
}

// 联网搜索方式白名单（默认 builtin 留作回退）
const SEARCH_MODES = ['builtin', 'mcp', 'volc', 'baidu'];
function normSearchMode(mode) {
  return SEARCH_MODES.includes(mode) ? mode : 'builtin';
}

const EMPTY_CONFIG = {
  provider: 'qwen', apiKey: '', modelWeb: '', modelLocal: '',
  searchMode: 'builtin', volcApiKey: '', volcModel: '', baiduApiKey: '',
  useCustomProtocol: true,
};

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { ...EMPTY_CONFIG };
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      provider: c.provider || 'qwen',
      apiKey: c.apiKey || '',
      // 兼容旧字段：旧版本用 c.model 表示「联网模型」；新版本拆为 modelWeb/modelLocal
      modelWeb: c.modelWeb || c.model || '',
      modelLocal: c.modelLocal || '',
      searchMode: normSearchMode(c.searchMode),
      volcApiKey: c.volcApiKey || '',
      volcModel: c.volcModel || '',
      baiduApiKey: c.baiduApiKey || '',
      // useCustomProtocol 必须 true：让 WorkBuddy 直连阿里云百炼 API，使用免费额度不消耗 WorkBuddy 积分
      useCustomProtocol: true,
    };
  } catch {
    return { ...EMPTY_CONFIG };
  }
}

// 进程内生效的搜索方式与各厂商凭据（避免每次 callLLM 都读盘）。
// 唯一一份可变状态（原 gSearchMode/gVolcKey/gVolcModel/gBaiduKey 四个 let 收拢为一个对象，引用语义不变）。
const runtime = { searchMode: 'builtin', volcKey: '', volcModel: '', baiduKey: '' };
function setSearchMode(mode) {
  runtime.searchMode = normSearchMode(mode);
}
function setSearchCreds(c) {
  runtime.volcKey = (c && c.volcApiKey) || '';
  runtime.volcModel = (c && c.volcModel) || '';
  runtime.baiduKey = (c && c.baiduApiKey) || '';
}

function saveConfig(cfg) {
  ensureDirs();
  const cur = loadConfig();
  // Key 类字段：传空表示「不修改」（前端只回显 hasKey，不回显明文）
  const keep = (v, old) => (v && String(v).trim() ? String(v).trim() : (old || ''));
  const next = {
    provider: cfg.provider || cur.provider || 'qwen',
    apiKey: keep(cfg.apiKey, cur.apiKey),
    modelWeb: keep(cfg.modelWeb, cur.modelWeb),
    modelLocal: keep(cfg.modelLocal, cur.modelLocal),
    searchMode: normSearchMode(cfg.searchMode),
    volcApiKey: keep(cfg.volcApiKey, cur.volcApiKey),
    // 模型名允许显式清空（回落默认值），故这里保留「传了就用、没传沿用」的语义
    volcModel: keep(cfg.volcModel, cur.volcModel),
    baiduApiKey: keep(cfg.baiduApiKey, cur.baiduApiKey),
    // 核心参数 useCustomProtocol 必须固定为 true：让 WorkBuddy 直连阿里云百炼 API，使用免费额度
    useCustomProtocol: true,
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  setSearchMode(next.searchMode); // 立即让在跑的进程生效
  setSearchCreds(next);
  return publicConfig(next);
}

function publicConfig(c) {
  return {
    provider: c.provider || 'qwen',
    hasKey: !!c.apiKey,
    modelWeb: c.modelWeb || '',
    modelLocal: c.modelLocal || '',
    searchMode: normSearchMode(c.searchMode),
    hasVolcKey: !!c.volcApiKey,
    volcModel: c.volcModel || '',
    hasBaiduKey: !!c.baiduApiKey,
    // 20260903r：阿里 MCP 免费额度本地计数（前端设置弹窗展示「已用 X/2000」）
    mcpQuota: getAliMcpQuotaState(),
    useCustomProtocol: true,
  };
}

// 模块加载时从已存配置初始化搜索方式与凭据（服务重启后保持一致）
try {
  const _c = loadConfig();
  setSearchMode(_c.searchMode);
  setSearchCreds(_c);
} catch (_) {}

module.exports = {
  UA,
  DATA_DIR,
  CONFIG_PATH,
  CACHE_DIR,
  IMG_DIR,
  CACHE_TTL_MS,
  SEMI_STATIC_TTL_MS,
  PROMPTS_DIR,
  loadPromptFile,
  PROVIDERS,
  ensureDirs,
  SEARCH_MODES,
  normSearchMode,
  EMPTY_CONFIG,
  loadConfig,
  runtime,
  setSearchMode,
  setSearchCreds,
  saveConfig,
  publicConfig,
};
