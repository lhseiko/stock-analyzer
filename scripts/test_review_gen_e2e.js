/**
 * scripts/test_review_gen_e2e.js — P2-1 批次 2 链路 4：复盘生成（mock LLM）E2E
 * ------------------------------------------------------------------------------
 * @test-scope: local —— 零网络。仅本地文件读取 + require.cache 受控桩，不触 3005、不调真实 LLM。
 *
 * 依据：docs/整改方案-20261110.md 阶段 3 P2-1「复盘生成（mock LLM）」；
 *       SESSION-STATE.md 批次 2 优先级 ④。
 *
 * 边界（如实声明）：本链路覆盖「Context 构建 → LLM 生成 → 降级快照 → 落盘守卫」。
 * 不重复链路 1（个股复盘 run 幂等）与 test_daily_review.js（schema 守卫）已覆盖的路由层；
 * 也不拉起 reviewService.runReview 的完整 gatherSources 取数（需桩替换十余个网络数据层，
 * 与该链路「mock LLM 验证生成层」的目标无关），改以静态断言守住 runReview 的 SCHEMA 复用侧。
 *
 * 受控桩：只替换 lib/ai/config.js 的 loadConfig、lib/ai/llm.js 的 callLLM / pickModelFor；
 *         真实执行 reviewContext.build / reviewLlm.generate / degraded / 真实提示词文件。
 *
 * 运行：node scripts/test_review_gen_e2e.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const configPath = require.resolve(path.join(ROOT, 'lib', 'ai', 'config.js'));
const llmPath = require.resolve(path.join(ROOT, 'lib', 'ai', 'llm.js'));
const realConfig = require(configPath);
const realLlm = require(llmPath);

const controlled = {
  cfg: { apiKey: 'test-key', provider: 'mock', modelLocal: 'mock-model' },
  cfgThrow: false,
  llmMode: 'ok', // ok | empty | throw
  pickModel: 'mock-model',
  calls: [],
  MARKDOWN: '# 盘后复盘\n\n观察池按板块地位给出评级，退潮期不留白。',
};
function mockLoadConfig() {
  if (controlled.cfgThrow) throw new Error('配置文件损坏（测试桩）');
  return controlled.cfg;
}
async function mockCallLLM(provider, apiKey, model, messages, opts) {
  controlled.calls.push({ provider, apiKey, model, messages, opts });
  if (controlled.llmMode === 'throw') {
    const e = new Error('rate limited');
    e.response = { status: 429 };
    throw e;
  }
  if (controlled.llmMode === 'empty') return '';
  return '```markdown\n' + controlled.MARKDOWN + '\n```';
}
// 保留真实模块的其它导出，只覆盖本链路受控的三个入口，避免下游模块拿不到函数
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true,
  exports: Object.assign({}, realConfig, { loadConfig: mockLoadConfig }),
};
require.cache[llmPath] = {
  id: llmPath, filename: llmPath, loaded: true,
  exports: Object.assign({}, realLlm, {
    callLLM: mockCallLLM,
    pickModelFor: () => ({ model: controlled.pickModel }),
  }),
};

const reviewContext = require(path.join(ROOT, 'lib', 'reviewContext.js'));
const reviewLlm = require(path.join(ROOT, 'lib', 'reviewLlm.js'));
const reviewService = require(path.join(ROOT, 'lib', 'reviewService.js'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}
function section(t) { console.log('\n== ' + t + ' =='); }
// generate() 内部会打印进度日志；只在调用期间静音，不影响断言输出
async function silentGenerate(ctx, opts) {
  const realLog = console.log;
  console.log = function () {};
  try { return await reviewLlm.generate(ctx, opts); }
  finally { console.log = realLog; }
}
function reset() {
  controlled.cfg = { apiKey: 'test-key', provider: 'mock', modelLocal: 'mock-model' };
  controlled.cfgThrow = false;
  controlled.llmMode = 'ok';
  controlled.pickModel = 'mock-model';
  controlled.calls = [];
}

function makeArgs() {
  const okSrc = (key, label, category, data, source) => ({
    key, label, category, status: 'ok', source,
    asOf: '2026-11-11 15:00', fetchedAt: '2026-11-11T15:01:00+08:00', data,
  });
  return {
    date: '2026-11-11',
    stage: 'formal',
    sources: [
      okSrc('quote', '大盘指数', '行情',
        { cn: [{ code: 'sh000001', name: '上证指数', changePct: -0.42, price: 3400.1 }] }, '腾讯行情'),
      okSrc('breadth', '涨跌家数', '行情',
        { breadth: { date: '2026-11-11', up: 2100, down: 2800, flat: 100, limitUp: 42, limitDown: 7, activePct: 0.31 } }, '本地聚合'),
      okSrc('mainFund', '主力资金', '资金',
        { mainFund: { mainNetToday: -120.5, date: '2026-11-11', source: '东财' } }, '东财'),
      okSrc('dragonTiger', '龙虎榜', '资金', { ok: true, count: 36, date: '2026-11-11' }, '东财龙虎榜'),
      { key: 'news', label: '资讯', category: '消息', status: 'failed',
        source: null, asOf: null, fetchedAt: null, note: '新闻源不可达', data: null },
    ],
    engine: {
      schemaVersion: 'review-engines-20261111b',
      marketRiskLevel: '退潮',
      trends: { short: { direction: '向下', ok: true } },
      candidates: [
        { name: '逆势活口A', code: '600001', grade: 'B', gradeLabel: 'B级（试错）',
          sectorPosition: '逆势活口', trialGrade: true, category: '试错', quadrant: '情绪',
          confirmCount: 2, vetoCount: 0, sector: '电子' },
        { name: '观察B', code: '600002', grade: 'C', gradeLabel: 'C级（观察）',
          sectorPosition: null, trialGrade: false, category: '观察', quadrant: '退潮',
          confirmCount: 1, vetoCount: 0, sector: '医药' },
      ],
    },
    topics: { schemaVersion: 'topics-20261111b', gradeSummary: { A: 0, B: 1, C: 2, D: 0 },
      dominantVote: 1, dominantQuadrant: '退潮', cards: [] },
    completeness: { score: 0.72 },
    baselines: [], verdictRows: [], stockMarks: null, dailyReviews: [],
    meta: { prevDate: '2026-11-10', histDates: ['2026-11-10'] },
  };
}

(async () => {
  try {
    section('§0 受控接线自检');
    ok(typeof reviewContext.build === 'function' && typeof reviewLlm.generate === 'function',
      '真实 reviewContext.build / reviewLlm.generate 参与执行（非桩）');
    ok(controlled.calls.length === 0 && typeof mockCallLLM === 'function', 'LLM 通道已被受控 Promise 替换');
    ok(reviewContext.SCHEMA_VERSION === 'review-llm-20261111b'
      && reviewContext.CONTEXT_VERSION === 'review-context-20261111b',
      'SCHEMA/CONTEXT 版本与 test_daily_review.js 守卫同源（20261111b）');
    ok(reviewService.SCHEMA_VERSION === reviewContext.SCHEMA_VERSION,
      'reviewService.SCHEMA_VERSION 与 Context 层同源（服务层不另立口径）');

    /* ══════════ §A Context 构建（代码权威 / 五要素 / 白名单） ══════════ */
    section('§A reviewContext.build：干净 JSON Context');
    const ctx = reviewContext.build(makeArgs());
    ok(ctx.schema === reviewContext.CONTEXT_VERSION, 'Context 带 CONTEXT_VERSION 结构标识');
    ok(ctx.meta.reviewDate === '2026-11-11' && ctx.meta.tz === 'Asia/Shanghai', '复盘日与时区由代码写入');
    ok(Array.isArray(ctx.sources) && ctx.sources.length === 5
      && ctx.sources.every(s => ('source' in s) && ('asOf' in s) && ('fetchedAt' in s) && ('status' in s)),
      '五要素（source/asOf/fetchedAt/status）随每个数据源进 Context');
    ok(ctx.missing.length === 1 && ctx.missing[0].key === 'news'
      && /新闻源不可达/.test(String(ctx.missing[0].reason)), '失败源如实列 missing，不冒充成功');
    ok(ctx.computed.engine.candidates[0].gradeLabel === 'B级（试错）'
      && ctx.computed.engine.candidates[0].sectorPosition === '逆势活口'
      && ctx.computed.engine.candidates[0].trialGrade === true,
      '观察池评级三字段进 Context（退潮期不留白的数据保障）');
    ok(ctx.computed.engine.candidates[1].gradeLabel === 'C级（观察）', '确定性不足的标的保留 C 级文案');
    ok(JSON.stringify(ctx.dragonTiger).indexOf('byCode') === -1,
      '龙虎榜块未被全量 byCode 索引污染（白名单裁剪）');
    ok(JSON.stringify(ctx).length <= 12000,
      'Context 未超 12000 字符预算（实际 ' + JSON.stringify(ctx).length + '）');
    ok(ctx.market.breadth.limitUp === 42 && ctx.market.quote.index[0].changePct === -0.42,
      '数值原样来自代码采集结果，Context 不改写');

    /* ══════════ §B mock LLM 正常生成 ══════════ */
    section('§B reviewLlm.generate：mock LLM 正常路径');
    reset();
    const r = await silentGenerate(ctx, { stage: 'formal', force: false });
    ok(r.ok === true && r.degraded === false, '正常路径 ok=true / degraded=false');
    ok(r.markdown === controlled.MARKDOWN,
      '代码只去掉 ```markdown 围栏、不改写模型文本（LLM 仅叙事、代码权威）');
    ok(r.contentChars === controlled.MARKDOWN.length, 'contentChars 由代码按实际文本长度计算');
    ok(/^[0-9a-f]{8}$/.test(String(r.promptSha1 || '')),
      '落盘元信息带提示词 sha1 前 8 位（提示词变更可追溯）');
    ok(r.model === 'mock-model' && r.promptFile === 'daily-review-system.md', '模型与提示词文件名如实标注');
    const c0 = controlled.calls[0];
    ok(c0 && c0.messages.length === 2 && /每日复盘/.test(c0.messages[0].content),
      'system 消息使用真实提示词文件（含「每日复盘」）');
    ok(c0 && c0.messages[1].content.includes(JSON.stringify(ctx)),
      'user 消息把完整 JSON Context 原样注入（唯一事实来源）');
    ok(c0 && c0.opts.webSearch === false, '本地数据推理关闭联网搜索');
    ok(c0 && c0.opts.force === false, 'force=false 透传 callLLM');
    await silentGenerate(ctx, { stage: 'formal', force: true });
    ok(controlled.calls[1] && controlled.calls[1].opts.force === true,
      'force=true 透传（P1-1 裁决①：手动重跑必重新调用）');

    /* ══════════ §C 降级路径（四种，一律出快照不拒绝发布） ══════════ */
    section('§C 降级：配置/模型/调用/空返回四态都出数据快照');
    const snapshotOk = (d, label) => {
      ok(d.ok === false && d.degraded === true, label + '：ok=false / degraded=true');
      ok(d.markdown.includes('# 每日复盘 · 2026-11-11（数据快照）')
        && d.markdown.includes('未做任何文字推演'), label + '：快照照常给出，不拒绝发布');
    };
    reset(); controlled.cfg = {};
    const d1 = await silentGenerate(ctx);
    snapshotOk(d1, '未配置密钥');
    ok(/未配置 AI 模型密钥/.test(String(d1.error)), '未配置密钥：降级原因如实写入 error');

    reset(); controlled.cfgThrow = true;
    const d2 = await silentGenerate(ctx);
    snapshotOk(d2, '配置读取抛错');
    ok(/配置文件损坏/.test(String(d2.error)), '配置读取抛错：原因如实写入 error');

    // 场景校准：generate() 有 `pick.model || cfg.modelLocal` 既有兜底，
    // 只有两者都为空才应降级；单让 pick 为空属于「回退成功」而非缺陷。
    reset(); controlled.pickModel = '';
    const d3b = await silentGenerate(ctx);
    ok(d3b.ok === true && d3b.model === 'mock-model',
      'pickModelFor 返回空时回退 cfg.modelLocal（既有兜底不回归）');

    reset(); controlled.pickModel = ''; controlled.cfg.modelLocal = ''; controlled.cfg.model = '';
    const d3 = await silentGenerate(ctx);
    snapshotOk(d3, '无可用模型');
    ok(/未配置可用模型/.test(String(d3.error)), '无可用模型：降级原因如实写入 error');

    reset(); controlled.llmMode = 'throw';
    const d4 = await silentGenerate(ctx);
    snapshotOk(d4, 'LLM 调用抛错');
    ok(/HTTP 429/.test(String(d4.error)), 'LLM 抛错：HTTP 状态如实写入 error');

    reset(); controlled.llmMode = 'empty';
    const d5 = await silentGenerate(ctx);
    snapshotOk(d5, 'LLM 返回空');
    ok(/模型返回空内容/.test(String(d5.error)), 'LLM 空返回：原因如实写入 error');
    ok(String(d1.markdown).includes('"schema"'), '降级快照内嵌真实 JSON Context（不是模板套话）');

    /* ══════════ §D 提示词与 SCHEMA 复用侧静态守卫 ══════════ */
    section('§D 提示词约束与 SCHEMA 升级铁律复用侧');
    const prompt = fs.readFileSync(path.join(ROOT, 'prompts', 'daily-review-system.md'), 'utf8');
    ok(prompt.includes('gradeLabel'), '提示词要求引用 computed.engine.candidates[].gradeLabel');
    ok(/严禁留空/.test(prompt) && /退潮期/.test(prompt),
      '提示词明确「退潮期也必须给评级、严禁留空」');
    const svc = fs.readFileSync(path.join(ROOT, 'lib', 'reviewService.js'), 'utf8');
    ok(svc.includes('schemaOutdated') && /prevDoc\.schemaVersion\s*!==\s*SCHEMA_VERSION/.test(svc),
      'runReview 保留 SCHEMA 复用侧守卫（旧结构文档不被幂等判定永久锁死）');
    ok(svc.includes('reviewLlm.generate') && svc.includes('reviewContext.build'),
      '生成链路接线完整：build → generate → 落盘');

    /* ══════════ §E 全量 runner 分类自检（防假绿） ══════════ */
    section('§E run_all_tests 分类器：本 E2E 必须进 quick 集');
    {
      const runnerSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'run_all_tests.js'), 'utf8');
      const selfSrc = fs.readFileSync(__filename, 'utf8');
      const m = runnerSrc.match(/function needsNetwork\(src\) \{[\s\S]*?\n\}/);
      let classified = null;
      try {
        const box = {};
        vm.createContext(box);
        vm.runInContext((m ? m[0] : '') + '\nthis.result = needsNetwork(' + JSON.stringify(selfSrc) + ');', box);
        classified = box.result;
      } catch (e) { classified = 'ERR: ' + (e && e.message); }
      ok(classified === false, '分类器判定 net=false（quick 模式真跑，非静默跳过），实际 ' + classified);
    }
  } catch (e) {
    ok(false, '主流程异常：' + (e && e.stack ? e.stack.split('\n')[0] : e));
  } finally {
    console.log('\n===== 链路 4 复盘生成 E2E：' + pass + ' 通过 / ' + fail + ' 失败 =====');
    process.exit(fail ? 1 : 0);
  }
})();
