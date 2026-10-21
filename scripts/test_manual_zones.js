/**
 * 手动阻力/支撑区间 · 回归测试（零网络）
 * --------------------------------------------------------------
 * 运行：node scripts/test_manual_zones.js
 * 覆盖：lib/manualZones.js（20261021d，用户「②卡加一条 tab 手动添加阻力/支撑」）
 *   [1] 增删查往返（单点/区间/备注）
 *   [2] 校验：方向非法 / 下沿>上沿 / 价格<=0 / 非数字 → 明确报错，不写脏数据
 *   [3] 去重：同侧同区间 → 拒绝
 *   [4] 容量：每侧上限 MAX_PER_SIDE
 *   [5] 代码归一：sh600909 / 600909.SH / 600909 落到同一个文件
 *   [6] 脏文件净化：手改坏的 JSON / 非法 side / low>high 不进入展示
 *   [7] 接线守卫：路由存在；前端页签/表单/删除存在；**手动区间不过 zoneValidity 过滤、不被侵蚀**
 *   [8] 隔离守卫：手动模块不 require zoneValidity / rangeDetector，不被模型口径污染
 */
const fs = require('fs');
const path = require('path');
const m = require('../lib/manualZones');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.log('  ✗', msg); }
}
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`);

const TMP_SYM = '999999';
const TMP_FILE = path.join(m.DIR, TMP_SYM + '.json');
function cleanup() { try { if (fs.existsSync(TMP_FILE)) fs.unlinkSync(TMP_FILE); } catch (e) {} }

cleanup();
try {
  console.log('\n[1] 增删查往返');
  {
    const a = m.addZone(TMP_SYM, { side: 'resistance', low: 14.63, high: 14.77, note: '前高' });
    ok(a.ok, '添加区间阻力成功');
    eq(a.zone.low, 14.63, '下沿 14.63');
    eq(a.zone.high, 14.77, '上沿 14.77');
    eq(a.zone.note, '前高', '备注保留');

    const b = m.addZone(TMP_SYM, { side: 'support', low: 11.56 });
    ok(b.ok, '单点支撑（只填一个价）成功');
    eq(b.zone.high, 11.56, '单点：上沿=下沿');

    const list = m.listZones(TMP_SYM);
    eq(list.total, 2, '共 2 条');
    eq(list.resistances.length, 1, '阻力 1 条');
    eq(list.supports.length, 1, '支撑 1 条');
    eq(list.symbol, TMP_SYM, '返回归一后的代码');
    ok(list.limits && list.limits.maxPerSide > 0, '返回上限配置（前端据此提示）');

    const d = m.removeZone(TMP_SYM, a.zone.id);
    ok(d.ok, '删除成功');
    eq(m.listZones(TMP_SYM).total, 1, '删除后剩 1 条');
    ok(!m.removeZone(TMP_SYM, a.zone.id).ok, '重复删除 → 报错（未找到）');
  }

  console.log('\n[2] 校验（不写脏数据）');
  {
    eq(m.addZone(TMP_SYM, { side: 'x', low: 1, high: 2 }).error, '方向必须是阻力或支撑', '非法方向');
    eq(m.addZone(TMP_SYM, { side: 'support', low: 5, high: 1 }).error, '下沿不能高于上沿', '下沿>上沿');
    eq(m.addZone(TMP_SYM, { side: 'support', low: 0, high: 1 }).error, '价格必须大于 0', '价格为 0');
    eq(m.addZone(TMP_SYM, { side: 'support', low: 'abc', high: 1 }).error, '请填写有效价格', '非数字');
    eq(m.addZone(TMP_SYM, { side: 'support' }).error, '请填写有效价格', '缺价格');
    eq(m.addZone(TMP_SYM, {}).error, '方向必须是阻力或支撑', '缺方向');
  }

  console.log('\n[3] 去重（同侧同区间）');
  {
    m.addZone(TMP_SYM, { side: 'resistance', low: 20, high: 21 });
    const dup = m.addZone(TMP_SYM, { side: 'resistance', low: 20, high: 21 });
    ok(!dup.ok, '同侧同区间 → 拒绝');
    eq(dup.error, '该区间已存在', '报错文案明确');
    const otherSide = m.addZone(TMP_SYM, { side: 'support', low: 20, high: 21 });
    ok(otherSide.ok, '不同侧同价位 → 允许（阻力与支撑是两回事）');
  }

  console.log('\n[4] 容量上限');
  {
    const before = m.listZones(TMP_SYM).resistances.length;
    let lastErr = null;
    for (let i = 0; i < m.MAX_PER_SIDE + 3; i++) {
      const r = m.addZone(TMP_SYM, { side: 'resistance', low: 100 + i, high: 101 + i });
      if (!r.ok) { lastErr = r.error; break; }
    }
    ok(/每侧最多/.test(lastErr || ''), `到上限后拒绝并提示（上限 ${m.MAX_PER_SIDE}）`);
    ok(m.listZones(TMP_SYM).resistances.length <= m.MAX_PER_SIDE, '阻力条数不超过上限');
    ok(before > 0, '前置：本来就有阻力条目');
  }

  console.log('\n[5] 代码归一（sh600909 / 600909.SH / 600909 同一文件）');
  {
    eq(m.normalizeSymbol('sh600909'), '600909', 'sh 前缀');
    eq(m.normalizeSymbol('600909.SH'), '600909', '后缀');
    eq(m.normalizeSymbol(' sz000858 '), '000858', '带空格的 sz 前缀');
    eq(m.normalizeSymbol('600909'), '600909', '纯数字');
  }

  console.log('\n[6] 脏文件净化');
  {
    fs.mkdirSync(m.DIR, { recursive: true });
    fs.writeFileSync(TMP_FILE, JSON.stringify({
      symbol: TMP_SYM,
      zones: [
        { id: 'a', side: 'resistance', low: 10, high: 12, note: 'ok' },
        { id: 'b', side: 'weird', low: 10, high: 12 },        // 非法 side
        { id: 'c', side: 'support', low: 15, high: 9 },        // low>high
        { id: 'd', side: 'support', low: 0, high: 3 },         // 价格 0
        { id: 'e', side: 'support', low: 8, high: 9 },         // ok
      ],
    }), 'utf8');
    const list = m.listZones(TMP_SYM);
    eq(list.total, 2, '只有 2 条合法条目进入展示');
    eq(list.resistances.map(z => z.id), ['a'], '保留合法阻力');
    eq(list.supports.map(z => z.id), ['e'], '保留合法支撑');

    fs.writeFileSync(TMP_FILE, '{ 这不是 JSON', 'utf8');
    const broken = m.listZones(TMP_SYM);
    eq(broken.total, 0, '坏 JSON → 空列表（不崩、不编造）');
    ok(m.addZone(TMP_SYM, { side: 'support', low: 1, high: 2 }).ok, '坏文件仍可被覆盖写入');
  }

  console.log('\n[7] 接线守卫');
  {
    const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    ok(srv.includes("require('./lib/manualZones')"), 'server 引入 manualZones');
    ok(/app\.get\('\/api\/manual-zones\/:symbol'/.test(srv), 'GET 列表路由');
    ok(/app\.post\('\/api\/manual-zones\/:symbol'/.test(srv), 'POST 新增路由');
    ok(/app\.delete\('\/api\/manual-zones\/:symbol\/:id'/.test(srv), 'DELETE 删除路由');

    const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
    ok(app.includes('data-pa-tab="model"') && app.includes('data-pa-tab="manual"'), '②卡有模型/手动两个页签');
    ok(app.includes('_renderManualZonesPanel'), '手动页签有独立渲染函数');
    ok(app.includes('_wirePriceActionTabs'), '页签与表单有接线函数');
    ok(/data-mz-del=/.test(app), '每条手动区间有删除按钮');
    ok(/paMzLow/.test(app) && /paMzHigh/.test(app), '表单有下沿/上沿两个价位输入');
    ok(/只填一个就代表单点|单点/.test(app), '文案说明「只填一个=单点」');

    // 20261021e：手动区间改为**后端并入**短期清单并走同一条有效性检验，前端不得再自己 concat（否则重复两条）
    const hub = fs.readFileSync(path.join(__dirname, '..', 'lib', 'priceActionHub.js'), 'utf8');
    ok(hub.includes("require('./manualZones')"), 'priceActionHub 引入 manualZones（并入点）');
    ok(/attachManualZones\(data, daily, symbol\)/.test(hub), '快照里把手动区间接进短期清单');
    ok(/assessZone\(daily, \{ low: z\.low, high: z\.high \}, side\)/.test(hub), '手动区间走 assessZone（同一条有效性检验）');
    ok(hub.includes('invalidateSnapshot'), '增删后丢弃快照缓存（否则加完看不到）');
    ok(!/manualRes/.test(app), '前端不再自己 concat 手动区间（避免与后端并入的重复）');
    ok(/pa-mz-badge/.test(app), '手动页签显示检验结果徽标');
    ok(/检验未通过/.test(app), '未通过时写明「检验未通过」而不是悄悄消失');
    ok(/isManual: true/.test(hub), '后端并入时带 isManual 标记');
    ok(/z\.isManual/.test(app), '前端按 isManual 区分手动条目样式/文案');
    ok(app.includes('pz-manual'), '手动条目有「手动」小标');

    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
    ok(css.includes('.pa-tabs') && css.includes('.pa-tab.active'), '页签样式存在');
    ok(css.includes('.pa-zone-row.manual'), '手动条目样式与模型条目区分');
  }

  console.log('\n[8] 隔离守卫（不被模型口径污染）');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'manualZones.js'), 'utf8');
    ok(!/require\(['"]\.\/zoneValidity/.test(src), '不 require zoneValidity（不参与有效性检验）');
    ok(!/require\(['"]\.\/rangeDetector/.test(src), '不 require rangeDetector（不参与箱体判定）');
    ok(!/erode/i.test(src), '不含侵蚀逻辑');
    const pa = fs.readFileSync(path.join(__dirname, '..', 'lib', 'priceAction.js'), 'utf8');
    ok(!/manualZones/.test(pa), 'priceAction 不掺手动区间（模型与用户标注分属两层）');
  }
  console.log('\n[9] 手动区间同样接受两条有效性检验（20261021e）');
  {
    cleanup();   // 前面几节留下了测试条目，这里从空文件开始，断言才唯一
    const hub = require('../lib/priceActionHub');
    // 合成 80 根日K：默认 7.00 平量；第 79 根收 8.70 但量比仅 1.0（无放量突破）
    const N = 80;
    const bars = Array.from({ length: N }, (_, i) => ({
      date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      open: 7, high: 7.05, low: 6.95, close: 7, volume: 10000,
    }));
    bars[N - 1] = { date: bars[N - 1].date, open: 7, high: 8.72, low: 6.98, close: 8.7, volume: 10000 };  // 量比 1.0

    // 三条手动区间：① 被无放量突破（应无效）② 从未触及（应有效）③ 支撑未跌破（应有效）
    m.addZone(TMP_SYM, { side: 'resistance', low: 8.45, high: 8.55, note: '被轻松突破' });
    m.addZone(TMP_SYM, { side: 'resistance', low: 9.40, high: 9.60, note: '未被测试' });
    m.addZone(TMP_SYM, { side: 'support', low: 6.70, high: 6.80, note: '未跌破' });

    const data = { shortTerm: { resistances: [{ low: 1, high: 2, source: '模型', valid: true }], supports: [] } };
    hub.attachManualZones(data, bars, TMP_SYM);
    const manual = data.shortTerm.resistances.filter(z => z.isManual);
    eq(manual.length, 2, '2 条手动阻力被并入（模型条目保持不动）');
    eq(data.shortTerm.supports.filter(z => z.isManual).length, 1, '1 条手动支撑被并入');
    eq(data.shortTerm.resistances[0].source, '模型', '模型条目仍在原处（顺序：模型在前）');

    const broken = manual.find(z => z.low === 8.45);
    const clean = manual.find(z => z.low === 9.40);
    ok(broken && broken.valid === false, '无放量轻松突破的手动阻力 → 判无效（与模型同一条规则）');
    ok(broken && broken.invalidReasons.some(r => /无放量/.test(r)), '无效原因写明「无放量轻松穿越」');
    ok(broken && broken.zoneCheck && broken.zoneCheck.lastBreakVr != null, '带 zoneCheck（与模型同结构，前端可展示明细）');
    ok(clean && clean.valid === true, '从未被测试的手动阻力 → 保持有效');
    ok(manual.every(z => !z.erosion), '手动区间不被侵蚀（用户只要求两条有效性检验）');
    eq(broken.low, 8.45, '侵蚀关闭：下沿未被收紧');
    eq(broken.high, 8.55, '侵蚀关闭：上沿未变');

    eq(data.manualZonesMeta.total, 3, 'meta.total = 3');
    eq(data.manualZonesMeta.valid, 2, 'meta.valid = 2');
    eq(data.manualZonesMeta.invalid, 1, 'meta.invalid = 1');
  }

} finally {
  cleanup();
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
