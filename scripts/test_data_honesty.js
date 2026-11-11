/**
 * 数据诚实原则·守卫测试（20261002b）
 * --------------------------------------------------------------
 * 回归锁定：未成功获取的数据必须明示"获取失败"，绝不拿
 *   ① 其他来源数据冒充；② 陈旧快照当新数据；③ 零值/空值伪装成已算出结果。
 *
 * 两类断言：
 *   一、lib/dataHonesty.js 信封单元：ok/stale/fail/classify/hasSilentPadding 行为正确。
 *   二、静态扫描 lib/ 全量源码，禁止"零值聚合伪装成功"的反模式
 *       （stats: { mean:0, std:0, high:0, low:0 } 这类全零聚合出现在"结果信封"返回里）。
 *       合法的空输入统计助手（deep/shared.js、deep/statements.js 的 _calcStats）
 *       在空输入时返回全零是正常行为，列入豁免名单；但调用方必须据此返回 success:false，
 *       因此扫描只禁止"结果信封级"的伪装，不禁止纯统计助手本身。
 */
const fs = require('fs');
const path = require('path');
const dh = require('../lib/dataHonesty');

const ROOT = path.join(__dirname, '..');
const LIB_DIR = path.join(ROOT, 'lib');
const ZERO_STATS_RE = /mean:\s*0,\s*std:\s*0,\s*high:\s*0,\s*low:\s*0/;
// 豁免：纯统计助手在空输入时返回全零是合法行为（调用方负责返回 success:false）
const EXEMPT = new Set(['lib/deep/shared.js', 'lib/deep/statements.js']);

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
}

// —— 一、信封单元 ——
console.log('===== 一、统一信封单元 =====');
const fresh = dh.ok({ series: [1, 2] }, { source: '东财' });
ok(fresh.success === true && fresh.source === '东财', 'ok() 返回 success:true 且带 source');
ok(dh.classify(fresh) === 'fresh', 'classify(fresh)=fresh');
ok(dh.isFresh(fresh) && !dh.isFailure(fresh), 'isFresh 正确、isFailure 否定');

const st = dh.stale({ series: [1] }, { reason: '数据源暂不可用，显示最近快照' });
ok(st.success === true && st.stale === true && /快照/.test(st.staleReason), 'stale() 显式标注 stale + staleReason');
ok(dh.classify(st) === 'stale', 'classify(stale)=stale');

const er = dh.fail('连接超时', { source: '同花顺', errorType: 'TIMEOUT' });
ok(er.success === false && er.errorType === 'TIMEOUT' && er.reason === '连接超时', 'fail() 诚实声明 success:false + errorType + reason');
ok(dh.classify(er) === 'failed', 'classify(failed)=failed');
ok(dh.isFailure(er) && !dh.isFresh(er), 'isFailure 正确、isFresh 否定');
ok(dh.isFailure(null) === true, 'null 保守判为失败');
ok(dh.isFailure({ success: false }) === true, 'success:false 判为失败');
ok(dh.classify({}) === 'fresh', '缺 success 字段默认 fresh（合同要求调用方显式置 success；自身缓存读取返回 {} 不报错）');

// 反凑数检测：成功信封里塞全零聚合 + note 说明失败 → 视为伪装
const padded = { success: true, stats: { mean: 0, std: 0, high: 0, low: 0 }, note: '暂不可用' };
ok(dh.hasSilentPadding(padded) === true, 'hasSilentPadding 命中"成功+全零聚合+note"伪装');
ok(dh.hasSilentPadding(er) === false, '已诚实声明 success:false 的不算伪装');
ok(dh.hasSilentPadding({ stats: { mean: 0, std: 0, high: 0, low: 0 } }) === false, '纯统计助手空返回（无 success/无 note）不算伪装');

// —— 二、静态扫描 lib/ 禁止零值聚合伪装 ——
console.log('\n===== 二、lib/ 反凑数静态扫描 =====');
function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && ent.name.endsWith('.js')) out.push(p);
  }
}
const files = [];
walk(LIB_DIR, files);
let violations = [];
let exemptHits = 0;
for (const f of files) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const src = fs.readFileSync(f, 'utf8');
  if (ZERO_STATS_RE.test(src)) {
    if (EXEMPT.has(rel)) { exemptHits++; }
    else { violations.push(rel); }
  }
}
ok(exemptHits === EXEMPT.size, `豁免名单中的统计助手仍含全零聚合（${exemptHits}/${EXEMPT.size}，证明扫描非真空洞）`);
if (violations.length) {
  console.log('  —— 命中反模式（结果信封返回全零聚合，违反诚实原则）：');
  violations.forEach(v => console.log('     · ' + v));
} else {
  console.log('  （lib/ 中无"结果信封返回全零聚合"的反模式）');
}
ok(violations.length === 0, 'lib/ 全量源码无零值聚合伪装（股息率链路 yield.js/pipeline.js 已修复）');

// —— 三、P0-3 代理口径分级打标（20261110g，整改方案阶段 1）——
console.log('\n===== 三、代理口径打标（observed/proxy/missing）=====');
const EXPECTED_PROXY_KEYS = ['big-drop-def', 'liquidity-line', 'sector-core-proxy', 'zt-pool-market', 'single-stock-heat', 'lhb-keyword'];
for (const k of EXPECTED_PROXY_KEYS) {
  ok(!!dh.PROXY_REGISTRY[k], `PROXY_REGISTRY 六项清单齐全：${k}（${dh.PROXY_REGISTRY[k] ? dh.PROXY_REGISTRY[k].name : '缺失'}）`);
  const p = dh.PROXY_REGISTRY[k];
  if (p) ok(!!p.name && !!p.boundary, `${k} 同时登记代理名与适用边界（proxy 必须带边界）`);
}
ok(Object.keys(dh.PROXY_REGISTRY).length === EXPECTED_PROXY_KEYS.length, 'PROXY_REGISTRY 无多余未登记项');

// proxyTag 契约：返回完整 honesty 对象；未知 key 必须 throw（防口径漂移）
const pt = dh.proxyTag('big-drop-def');
ok(pt.kind === 'proxy' && pt.proxyKey === 'big-drop-def' && pt.proxyName === '大面股定义' && !!pt.boundary, 'proxyTag 返回 {kind,proxyKey,proxyName,boundary} 完整契约');
let threw = false;
try { dh.proxyTag('nonexistent-key'); } catch (e) { threw = true; }
ok(threw, 'proxyTag(未知 key) 必须 throw（防止产出侧写错口径 key）');
ok(dh.observedTag('x').kind === 'observed' && dh.missingTag('y').kind === 'missing', 'observedTag/missingTag 三态齐备');
ok(dh.isProxy({ honesty: pt }) === true && dh.isProxy({}) === false, 'isProxy 判定正确');

// 接线点静态扫描：六项代理各自在产出侧至少一处真实接线（proxyKeys 轻量标记或 honesty 完整对象）
console.log('\n----- 接线点静态扫描 -----');
const WIRING = [
  ['big-drop-def', 'lib/reviewEngines.js'],
  ['liquidity-line', 'lib/reviewEngines.js'],
  ['sector-core-proxy', 'lib/topicEngines.js'],
  ['zt-pool-market', 'lib/topicEngines.js'],
  ['single-stock-heat', 'server.js'],
  ['lhb-keyword', 'lib/reviewContext.js'],
];
for (const [key, file] of WIRING) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  ok(src.includes("'" + key + "'"), `代理口径 ${key} 已在 ${file} 产出侧接线`);
}
// reviewEngines/topicEngines 零 require 铁律：接线必须用轻量 proxyKeys 字面量，不得引入依赖
for (const f of ['lib/reviewEngines.js', 'lib/topicEngines.js', 'lib/reviewContext.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ok(!/require\(['"][^'"]*dataHonesty/.test(src), `${f} 保持零 dataHonesty 依赖（轻量 proxyKeys 契约）`);
}

// 前端 PROXY_LABELS 与后端 PROXY_REGISTRY key 一致（两侧同步维护，防漂移）
console.log('\n----- 前后端注册表一致性 -----');
const feSrc = fs.readFileSync(path.join(ROOT, 'public/js/honestyBadge.js'), 'utf8');
const feKeys = EXPECTED_PROXY_KEYS.filter(k => feSrc.includes("'" + k + "'"));
ok(feKeys.length === EXPECTED_PROXY_KEYS.length, `前端 PROXY_LABELS 覆盖全部 ${EXPECTED_PROXY_KEYS.length} 项代理 key（${feKeys.length}/${EXPECTED_PROXY_KEYS.length}）`);
ok(feSrc.includes("PROXY_LABELS['") === false, '前端标签表 key 与后端命名空间一致（无前缀漂移）');

// 颜色语义守卫：代理角标必须中性色，禁红涨绿跌语义色变量与硬编码红绿
console.log('\n----- 颜色语义守卫 -----');
const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/style.css'), 'utf8');
const badgeM = cssSrc.match(/\.honesty-badge\s*\{[^}]*\}/);
ok(!!badgeM, 'style.css 存在 .honesty-badge 规则');
if (badgeM) {
  const rule = badgeM[0];
  const semantic = ['--red', '--green', '--accent', '--up', '--down', '#F6465D', '#0ECB81'].filter(c => rule.includes(c));
  ok(semantic.length === 0, `.honesty-badge 中性色（无红涨绿跌/强调色语义混用${semantic.length ? '，命中：' + semantic.join(',') : ''}）`);
}
// app.js 渲染接线 + index.html 引入
const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
ok(appSrc.includes('honestyBadge.isProxy'), 'app.js 已接入代理角标渲染');
const idxSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
ok(idxSrc.includes('js/honestyBadge.js'), 'index.html 已引入 honestyBadge.js');

console.log(`\n===== test_data_honesty 结果：通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
